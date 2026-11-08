// ==UserScript==
// @name         HoloPocket – Assistant Cartodle
// @namespace    kevin.holopocket
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-cartodle.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-cartodle.user.js
// @description  Aide au Cartodle par déduction : à partir de tes essais et de leurs indices (type, stade, rareté, extension, année), filtre les cartes possibles et propose le meilleur prochain essai. N'utilise que les indices renvoyés, ne lit jamais la carte mystère.
// @match        https://holopocket.fr/jeux/cartodle*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const POLL_MS = 1200;
  const RARE_RANK = 3;           // « une rare ou mieux » = rang ≥ 3
  const DB_TTL = 24 * 3600 * 1000;
  const DB_KEY = 'hp-cartodle-db-v2'; // v2 : ajoute la date de sortie des extensions

  async function api(path) {
    const r = await fetch(`/api${path}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }

  // ───────── Base des cartes candidates (rare+ Pokémon, toutes extensions), en cache ─────────
  async function buildDB(onProgress) {
    try {
      const cached = JSON.parse(localStorage.getItem(DB_KEY) || 'null');
      if (cached && Date.now() - cached.at < DB_TTL) return cached.cards;
    } catch {}
    const sets = await api('/sets');
    const cards = [];
    let done = 0;
    const queue = sets.slice();
    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        try {
          const detail = await api(`/sets/${encodeURIComponent(s.id)}`);
          const year = s.releaseDate ? +String(s.releaseDate).slice(0, 4) : null;
          for (const c of detail.cards || []) {
            if (c.category === 'Pokemon' && c.rank >= RARE_RANK) {
              cards.push({ id: c.id, name: c.name, rank: c.rank, type: c.type, stage: c.stage, setId: s.id, serieId: s.serieId, year, date: s.releaseDate || '' });
            }
          }
        } catch {}
        done++; onProgress && onProgress(done, sets.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    try { localStorage.setItem(DB_KEY, JSON.stringify({ at: Date.now(), cards })); } catch {}
    return cards;
  }

  // Index des extensions : nom, série et date de sortie complète
  let setsIndex = null;
  async function ensureSets() {
    if (!setsIndex) { setsIndex = {}; try { for (const s of await api('/sets')) setsIndex[s.id] = { name: s.name, serieId: s.serieId, date: s.releaseDate || '' }; } catch {} }
    return setsIndex;
  }
  // Attributs de la carte jouée (type, stade, rang, extension, date) via la recherche du jeu
  const guessedCache = {};
  async function guessedAttrs(card) {
    if (guessedCache[card.id]) return guessedCache[card.id];
    await ensureSets();
    let found = null;
    try { const res = await api(`/games/cartodle/search?q=${encodeURIComponent(card.name)}`); found = res.find((x) => x.id === card.id) || null; } catch {}
    const setId = found ? found.setId : card.setId;
    const si = setsIndex[setId] || {};
    const a = { type: found ? found.type : null, stage: found ? found.stage : null, rank: found ? found.rank : card.rank, setId, serieId: si.serieId || null, date: si.date || '', name: found ? found.name : card.name };
    guessedCache[card.id] = a; return a;
  }

  // ───────── Filtrage par les indices ─────────
  // Applique les contraintes d'un essai à un candidat. g = attributs joués, fb = indices renvoyés.
  // Indices : hint 'match' = identique, 'miss' = différent, 'close' = presque (fuzzy → non filtré pour ne pas
  // éliminer la bonne carte). Les flèches (up/down) donnent le sens, y compris sur 'miss'/'close'.
  // L'extension se compare par DATE de sortie complète (pas l'année : deux cartes de la même année sont ordonnées).
  function matches(cand, g, fb) {
    if (fb.pokemon && fb.pokemon.hint === 'match' && cand.name !== g.name) return false;
    if (fb.types && g.type != null) {
      if (fb.types.hint === 'match' && cand.type !== g.type) return false;
      if (fb.types.hint === 'miss' && cand.type === g.type) return false;
    }
    if (fb.stage && g.stage != null) {
      if (fb.stage.hint === 'match' && cand.stage !== g.stage) return false;
      if (fb.stage.hint === 'miss' && cand.stage === g.stage) return false;
    }
    if (fb.rarity && g.rank != null) {
      if (fb.rarity.hint === 'match') { if (cand.rank !== g.rank) return false; }
      else if (fb.rarity.arrow === 'up') { if (!(cand.rank > g.rank)) return false; }
      else if (fb.rarity.arrow === 'down') { if (!(cand.rank < g.rank)) return false; }
    }
    if (fb.set && g.date) {
      if (fb.set.hint === 'match') { if (cand.setId !== g.setId) return false; }
      else if (fb.set.arrow === 'up') { if (cand.date && !(cand.date > g.date)) return false; }
      else if (fb.set.arrow === 'down') { if (cand.date && !(cand.date < g.date)) return false; }
    }
    return true;
  }

  async function filterCandidates(cards, guesses) {
    let C = cards;
    for (const fb of guesses) {
      const g = await guessedAttrs(fb.card);
      C = C.filter((cand) => matches(cand, g, fb));
    }
    return C;
  }

  // Signature de feedback simulée d'un candidat-mystère M face à un essai g (dimensions exploitables)
  function simSig(M, g) {
    const t = M.type === g.type ? 'E' : 'x';
    const s = M.stage === g.stage ? 'E' : 'x';
    const r = M.rank === g.rank ? 'E' : M.rank > g.rank ? '>' : '<';
    const d = M.setId === g.setId ? 'E' : (!M.date || !g.date) ? '?' : M.date > g.date ? '>' : M.date < g.date ? '<' : '=';
    const sp = M.name === g.name ? 'E' : 'x';
    return t + s + r + d + sp;
  }

  // Meilleur prochain essai : minimise le plus gros groupe restant
  function recommend(C) {
    if (C.length <= 2) return C[0] || null;
    const pool = C.length > 160 ? C.filter((_, i) => i % Math.ceil(C.length / 160) === 0) : C;
    const sample = C.length > 700 ? C.filter((_, i) => i % Math.ceil(C.length / 700) === 0) : C;
    let best = null, bestWorst = Infinity;
    for (const g of pool) {
      const buckets = new Map();
      for (const M of sample) { const k = simSig(M, g); buckets.set(k, (buckets.get(k) || 0) + 1); }
      const worst = Math.max(...buckets.values());
      if (worst < bestWorst) { bestWorst = worst; best = g; }
    }
    return best;
  }

  // ───────── Interface ─────────
  // ───────── Délais aléatoires (commun à tous les scripts) ─────────
  // Évite un rythme régulier : au lieu d'un intervalle fixe, chaque attente est tirée au hasard
  // autour d'une valeur de base. jitter(ms, frac) renvoie ms ± frac (par défaut ±35 %).
  // schedule(fn, base, frac) relance fn à base ± frac, replanifié à chaque tour (jamais périodique) ;
  // il attend la fin de fn avant de reprogrammer (pas de chevauchement) et renvoie { stop() }.
  const HP = (window.__hp = window.__hp || {});
  HP.jitter = (ms, frac = 0.35) => Math.max(0, Math.round(Number(ms) * (1 + (Math.random() * 2 - 1) * frac)));
  HP.schedule = function (fn, base, frac = 0.35) {
    const h = { stopped: false, id: null };
    const run = async () => {
      if (h.stopped) return;
      try { await fn(); } catch (_) { /* laissé à la charge de fn */ }
      if (h.stopped) return;
      h.id = setTimeout(run, HP.jitter(base, frac));
    };
    h.stop = () => { h.stopped = true; if (h.id) { clearTimeout(h.id); h.id = null; } };
    h.id = setTimeout(run, HP.jitter(base, frac));
    return h;
  };

  // ───────── Interface HoloPocket+ (kit commun, identique dans tous les scripts) ─────────
  // Un dock en bas à droite (actions + interrupteurs), une colonne de panneaux à droite,
  // et des notifications dans cette colonne. Styles calqués sur ceux du site (variables CSS du site).
  const UI = (function () {
    const V = 1;
    if (window.__hpui && window.__hpui.v >= V) return window.__hpui;

    const ICONS = {
      coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
      target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
      dice: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/>',
      zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
      repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
      swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
      refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
      x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
      up: '<path d="m18 15-6-6-6 6"/>',
      down: '<path d="m6 9 6 6 6-6"/>',
      loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
    };
    const icon = (name) => ICONS[name]
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
      : '';
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const CSS = `
#hp-dock,#hp-panels{font-family:var(--font-sans,"Geist Variable",ui-sans-serif,system-ui,sans-serif);color:var(--color-ink,#f4f4f1);-webkit-font-smoothing:antialiased}
#hp-dock{position:fixed;right:22px;bottom:16px;z-index:2147483000;width:min(320px,calc(100vw - 38px));display:flex;flex-direction:column;align-items:stretch;gap:10px;pointer-events:none}
#hp-dock>*{pointer-events:auto}
#hp-panels{position:fixed;right:16px;top:84px;bottom:16px;z-index:2147482999;width:min(326px,calc(100vw - 32px));display:flex;flex-direction:column;gap:12px;overflow-y:auto;overscroll-behavior:contain;pointer-events:none;padding:0 6px 6px 0;scrollbar-width:none}
#hp-panels::-webkit-scrollbar{display:none}
#hp-panels>*{pointer-events:auto;flex:none}
.hp-btn{display:flex;width:100%;align-items:center;gap:10px;min-height:46px;padding:8px 14px;border-radius:12px;border:2px solid #111;background:var(--color-brand,#ffd60a);color:#111;font:600 14px/1.2 var(--font-sans,system-ui,sans-serif);box-shadow:3px 3px 0 var(--color-shade,#000);cursor:pointer;text-align:left;transition:transform .08s ease,box-shadow .08s ease}
.hp-btn:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--color-shade,#000)}
.hp-btn:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--color-shade,#000)}
.hp-btn[disabled]{opacity:.7;cursor:progress;transform:none;box-shadow:3px 3px 0 var(--color-shade,#000)}
.hp-btn--secondary,.hp-btn--toggle{background:var(--color-panel,#18181b);color:var(--color-ink,#f4f4f1);border-color:var(--color-ink,#f4f4f1)}
.hp-btn__icon{display:grid;place-items:center;flex:none}
.hp-btn__icon svg{width:18px;height:18px}
.hp-btn__text{display:flex;flex-direction:column;min-width:0;flex:1}
.hp-btn__label,.hp-btn__sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-btn__sub{font:500 11.5px/1.35 var(--font-mono,ui-monospace,monospace);opacity:.72}
.hp-dot{width:10px;height:10px;border-radius:50%;flex:none;margin-left:2px;background:var(--color-muted,#9d9da3)}
.hp-btn--toggle.is-on .hp-dot{background:#22c55e;box-shadow:0 0 8px #22c55e}
.hp-panel{background:var(--color-panel,#18181b);color:var(--color-ink,#f4f4f1);border:2px solid var(--color-ink,#f4f4f1);border-radius:16px;box-shadow:4px 4px 0 var(--color-shade,#000);font:14px/1.45 var(--font-sans,system-ui,sans-serif)}
.hp-panel__head{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 14px;border-bottom:2px solid var(--color-line,#313136)}
.hp-panel.is-collapsed .hp-panel__head{border-bottom:0}
.hp-panel.is-collapsed .hp-panel__body{display:none}
.hp-panel__title{flex:1;min-width:0;font:700 16px/1.25 var(--font-display,var(--font-sans,system-ui,sans-serif));letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-panel__actions{display:flex;gap:6px}
.hp-panel__body{padding:12px 14px 14px}
.hp-icon-btn{display:grid;place-items:center;width:30px;height:30px;flex:none;padding:0;border-radius:9px;border:2px solid var(--color-line,#313136);background:var(--color-panel-2,#242428);color:var(--color-ink,#f4f4f1);cursor:pointer}
.hp-icon-btn:hover{border-color:var(--color-ink,#f4f4f1)}
.hp-icon-btn svg{width:16px;height:16px}
.hp-mini{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 12px;border-radius:10px;border:2px solid #111;background:var(--color-brand,#ffd60a);color:#111;font:600 13px/1.2 var(--font-sans,system-ui,sans-serif);box-shadow:2px 2px 0 var(--color-shade,#000);cursor:pointer}
.hp-mini:hover{transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--color-shade,#000)}
.hp-mini--ghost{background:var(--color-panel-2,#242428);color:var(--color-ink,#f4f4f1);border-color:var(--color-line,#313136);box-shadow:none}
.hp-mini--ghost:hover{border-color:var(--color-ink,#f4f4f1);box-shadow:none}
.hp-btn:focus-visible,.hp-icon-btn:focus-visible,.hp-mini:focus-visible{outline:2px solid var(--color-brand,#ffd60a);outline-offset:3px}
.hp-toast{background:var(--color-panel,#18181b);color:var(--color-ink,#f4f4f1);border:2px solid var(--color-ink,#f4f4f1);border-left-width:6px;border-radius:14px;box-shadow:4px 4px 0 var(--color-shade,#000);padding:10px 12px;font:13px/1.45 var(--font-sans,system-ui,sans-serif);cursor:pointer;animation:hp-in .18s ease-out}
.hp-toast--success{border-left-color:#22c55e}
.hp-toast--error{border-left-color:#ef4444}
.hp-toast--info{border-left-color:var(--color-brand,#ffd60a)}
.hp-muted{color:var(--color-muted,#9d9da3)}
.hp-spin{animation:hp-spin 1s linear infinite}
@keyframes hp-spin{to{transform:rotate(360deg)}}
@keyframes hp-in{from{opacity:0;transform:translateY(-4px)}}
@media (max-width:640px){#hp-dock{right:12px;bottom:12px;gap:8px;width:max-content;max-width:calc(100vw - 24px)}.hp-btn{min-height:40px;padding:6px 12px;font-size:13px}.hp-btn__sub{display:none}#hp-panels{right:6px;width:calc(100vw - 12px)}}
@media (prefers-reduced-motion:reduce){.hp-btn,.hp-mini,.hp-toast{transition:none;animation:none}}
`;

    function base() {
      if (!document.getElementById('hp-ui-style')) {
        const s = document.createElement('style');
        s.id = 'hp-ui-style';
        s.textContent = CSS;
        document.head.appendChild(s);
      }
      let dock = document.getElementById('hp-dock');
      if (!dock) { dock = document.createElement('div'); dock.id = 'hp-dock'; document.body.appendChild(dock); }
      let col = document.getElementById('hp-panels');
      if (!col) { col = document.createElement('div'); col.id = 'hp-panels'; document.body.appendChild(col); }
      return { dock, col };
    }

    // La colonne de panneaux se place sous l'en-tête du site (et sous la bannière d'événement) et au-dessus du dock
    function layout() {
      const dock = document.getElementById('hp-dock'), col = document.getElementById('hp-panels');
      if (!dock || !col) return;
      col.style.bottom = (dock.children.length ? dock.offsetHeight + 28 : 16) + 'px';
      let top = 64;
      const hdr = document.querySelector('header');
      if (hdr) top = Math.max(0, hdr.getBoundingClientRect().bottom);
      for (const st of document.querySelectorAll('[role=status]')) {
        if (st.closest('#hp-panels')) continue;
        const r = st.getBoundingClientRect();
        if (r.height && r.top <= top + 8 && r.bottom > top) top = r.bottom;
      }
      col.style.top = Math.round(top + 12) + 'px';
    }

    // Bouton du dock. kind : 'primary' (jaune), 'secondary', 'toggle' (avec voyant). order : position (petit = haut).
    function button(id, o) {
      const { dock } = base();
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('button');
        el.id = id;
        el.type = 'button';
        el.addEventListener('click', () => el._onClick && el._onClick());
        dock.appendChild(el);
      }
      el._onClick = o.onClick;
      const kind = o.kind || 'primary';
      const sig = JSON.stringify([kind, o.label, o.sub, o.icon, !!o.on, !!o.busy, !!o.disabled, o.title]);
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.className = `hp-btn hp-btn--${kind}${o.on ? ' is-on' : ''}`;
        el.disabled = !!o.disabled;
        el.title = o.title || '';
        if (kind === 'toggle') el.setAttribute('aria-pressed', String(!!o.on)); else el.removeAttribute('aria-pressed');
        const ic = o.busy ? `<span class="hp-btn__icon hp-spin">${icon('loader')}</span>` : (o.icon ? `<span class="hp-btn__icon">${icon(o.icon)}</span>` : '');
        el.innerHTML = ic
          + `<span class="hp-btn__text"><span class="hp-btn__label">${esc(o.label)}</span>${o.sub ? `<span class="hp-btn__sub">${esc(o.sub)}</span>` : ''}</span>`
          + (kind === 'toggle' ? '<span class="hp-dot"></span>' : '');
      }
      el.style.order = o.order ?? 50;
      layout();
      return el;
    }
    function removeButton(id) { document.getElementById(id)?.remove(); layout(); }

    // Panneaux : repliables (état mémorisé) ou fermables (closable: true)
    const COLLAPSE_KEY = 'hp-ui-collapsed';
    const collapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { return new Set(); } };
    const saveCollapsed = (s) => { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])); } catch {} };
    function iconBtn(name, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hp-icon-btn';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = icon(name);
      b.onclick = (e) => { e.stopPropagation(); onClick(); };
      return b;
    }
    function panel(id, o = {}) {
      const { col } = base();
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('section');
        el.id = id;
        el.className = 'hp-panel';
        el.setAttribute('aria-label', o.title || '');
        el.innerHTML = '<div class="hp-panel__head"><div class="hp-panel__title"></div><div class="hp-panel__actions"></div></div><div class="hp-panel__body"></div>';
        if (!o.closable && collapsed().has(id)) el.classList.add('is-collapsed');
        col.appendChild(el);
      }
      el.style.order = o.order ?? 50;
      el._actions = o.actions || [];
      el._onClose = o.onClose;
      const sig = JSON.stringify([o.title, el._actions.map((a) => [a.icon, a.title]), !!o.closable]);
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.querySelector('.hp-panel__title').textContent = o.title || '';
        const act = el.querySelector('.hp-panel__actions');
        act.innerHTML = '';
        el._actions.forEach((a, i) => act.appendChild(iconBtn(a.icon, a.title, () => el._actions[i] && el._actions[i].onClick())));
        if (o.closable) {
          act.appendChild(iconBtn('x', 'Fermer', () => { el.remove(); layout(); el._onClose && el._onClose(); }));
        } else {
          const tg = iconBtn(el.classList.contains('is-collapsed') ? 'down' : 'up', 'Replier / déplier', () => {
            const s = collapsed();
            const now = el.classList.toggle('is-collapsed');
            if (now) s.add(id); else s.delete(id);
            saveCollapsed(s);
            tg.innerHTML = icon(now ? 'down' : 'up');
          });
          act.appendChild(tg);
        }
      }
      layout();
      return el.querySelector('.hp-panel__body');
    }
    function removePanel(id) { document.getElementById(id)?.remove(); layout(); }
    const hasPanel = (id) => !!document.getElementById(id);

    // Notification dans la colonne de droite. kind : 'success' | 'error' | 'info'. ms : 0 = jusqu'au clic.
    function toast(html, o = {}) {
      const { col } = base();
      const t = document.createElement('div');
      t.className = `hp-toast hp-toast--${o.kind || 'info'}`;
      t.setAttribute('role', 'status');
      t.style.order = -1;
      t.innerHTML = html;
      t.title = 'Cliquer pour fermer';
      t.onclick = () => { t.remove(); layout(); };
      col.prepend(t);
      [...col.querySelectorAll('.hp-toast')].slice(3).forEach((x) => x.remove());
      const ms = o.ms ?? 8000;
      if (ms) setTimeout(() => { t.remove(); layout(); }, ms);
      layout();
      return t;
    }

    addEventListener('resize', layout);
    addEventListener('scroll', layout, { passive: true });
    setInterval(layout, 600);
    window.__hpui = { v: V, button, removeButton, panel, removePanel, hasPanel, toast, icon, esc };
    return window.__hpui;
  })();


  // Panneau dans la colonne commune du kit (repliable)
  function panel() { return UI.panel('hp-cartodle-panel', { title: 'Assistant Cartodle', order: 30 }); }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const FR = { Grass: 'Plante', Fire: 'Feu', Water: 'Eau', Lightning: 'Électrique', Electric: 'Électrique', Psychic: 'Psy', Fighting: 'Combat', Darkness: 'Obscurité', Metal: 'Métal', Dragon: 'Dragon', Fairy: 'Fée', Colorless: 'Incolore', Normal: 'Normal' };
  const stageFR = { Basic: 'De base', Stage1: 'Niveau 1', Stage2: 'Niveau 2' };

  // ───────── Remplissage + surlignage de la carte conseillée (pas de clic : tu valides) ─────────
  let lastRec = null;
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function findInput() {
    return document.querySelector('input[type=search]') || document.querySelector('input[placeholder*="ropose"]');
  }
  function clearHighlight() {
    document.querySelectorAll('.hp-cd-hl').forEach((e) => { e.classList.remove('hp-cd-hl'); e.style.outline = ''; e.style.outlineOffset = ''; });
  }
  async function fillGuess(rec) {
    if (!rec) return;
    await ensureSets();
    const input = findInput();
    if (!input) return;
    const localId = rec.id.slice(rec.setId.length + 1);
    const setName = (setsIndex[rec.setId] && setsIndex[rec.setId].name) || '';
    // Repérage par n° + extension (identifie la version de façon unique, sans dépendre du nom)
    const tryFind = () => [...document.querySelectorAll('button')].find((b) => {
      const t = b.textContent.replace(/\s+/g, ' ');
      return t.includes('n° ' + localId) && (setName ? t.includes(setName) : true);
    });
    input.focus();
    // Requête nom+année d'abord : elle réduit la liste aux bonnes versions (sinon la carte est noyée/coupée)
    const queries = [`${rec.name} ${rec.year || ''}`.trim(), rec.name, `${rec.name} ${(setName.split(' ')[0] || '')}`.trim()];
    for (const q of queries) {
      setNativeValue(input, q);
      await new Promise((r) => setTimeout(r, 950));
      const btn = tryFind();
      if (btn) {
        clearHighlight();
        btn.classList.add('hp-cd-hl');
        btn.style.outline = '3px solid var(--color-brand,#ffd60a)';
        btn.style.outlineOffset = '2px';
        btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const note = document.getElementById('hp-cd-fillnote');
        if (note) note.textContent = `Carte surlignée en jaune — clique dessus pour valider l'essai.`;
        return;
      }
    }
    const note = document.getElementById('hp-cd-fillnote');
    if (note) note.innerHTML = `Pas trouvée automatiquement : cherche « <b>${esc(rec.name)}</b> », version <b>${esc(setName)}</b> n° ${esc(localId)}.`;
  }

  let db = null, building = false, progress = '';
  async function loop() {
    if (!location.pathname.startsWith('/jeux/cartodle')) { UI.removePanel('hp-cartodle-panel'); return; }
    const p = panel();
    let game;
    try { game = await api('/games/cartodle'); } catch { return; }

    if (!db && !building) { building = true; p.innerHTML = '⏳ Construction de la base des cartes (une fois par jour)…'; try { db = await buildDB((d, t) => { progress = `${d}/${t}`; const el = document.getElementById('hp-cd-prog'); if (el) el.textContent = progress; }); } finally { building = false; } }
    if (building) { p.innerHTML = `⏳ Base des cartes… <span id="hp-cd-prog">${progress}</span>`; return; }
    if (!db) { p.innerHTML = 'Base indisponible — recharge la page.'; return; }

    if (game.status !== 'playing') {
      p.innerHTML = `${game.status === 'won' ? `✅ Trouvée en ${game.guesses.length} essai(s).` : '❌ Partie du jour terminée.'}`;
      return;
    }

    let C;
    try { C = await filterCandidates(db, game.guesses); } catch (e) { p.innerHTML = `Erreur : ${esc(e.message)}`; return; }
    const guessedIds = new Set(game.guesses.map((x) => x.card.id));
    C = C.filter((c) => !guessedIds.has(c.id)); // ne jamais reproposer une carte déjà jouée
    const rec = recommend(C);
    lastRec = rec;
    const left = (game.maxGuesses || 20) - game.guesses.length;

    // Aperçu de quelques candidats
    const preview = C.slice(0, 6).map((c) => `${esc(c.name)} <small style="color:var(--color-muted,#9d9da3)">(${esc(c.setId)}${c.year ? ' ' + c.year : ''})</small>`).join('<br>');

    p.innerHTML = `
      ${C.length === 0
        ? `<div style="color:#f87171">Aucune carte compatible. Un indice a dû être mal interprété (séries/variantes).</div>`
        : rec
          ? `<div style="margin-bottom:4px"><b>Essai conseillé :</b></div>
             <div style="padding:6px 8px;border-radius:8px;background:var(--color-line,#313136);border:1px solid var(--color-line,#313136)">${esc(rec.name)} <small style="color:var(--color-muted,#9d9da3)">${esc(rec.type ? (FR[rec.type] || rec.type) : '')}${rec.stage ? ' · ' + (stageFR[rec.stage] || rec.stage) : ''} · ${esc(rec.setId)}${rec.year ? ' ' + rec.year : ''}</small></div>
             <button id="hp-cd-fill" type="button" class="hp-mini" style="margin-top:10px;width:100%">Remplir et surligner cette carte</button>
             <div id="hp-cd-fillnote" style="color:var(--color-muted,#9d9da3);margin-top:6px;font-size:11px">Clique le bouton : je remplis la recherche et je surligne la bonne version. À toi de cliquer dessus pour valider.</div>`
          : ''}
      <div style="color:var(--color-muted,#9d9da3);margin-top:10px">Cartes encore possibles : <b>${C.length}</b> · essais restants : <b>${left}</b></div>
      ${C.length > 1 && C.length <= 12 ? `<div style="margin-top:8px;color:var(--color-muted,#9d9da3);font-size:12px"><b>Possibles :</b><br>${C.map((c) => `${esc(c.name)} <small style="color:var(--color-muted,#9d9da3)">(${esc(c.setId)})</small>`).join('<br>')}</div>` : C.length ? `<div style="margin-top:8px;color:var(--color-muted,#9d9da3);font-size:12px">${preview}${C.length > 6 ? '<br>…' : ''}</div>` : ''}
      <div style="color:var(--color-muted,#9d9da3);margin-top:10px;font-size:11px">Déduit de tes essais seulement (type, stade, rareté, extension, année). PV et n° Pokédex non filtrés faute de données. Tu choisis et valides.</div>`;
    const fillBtn = document.getElementById('hp-cd-fill');
    if (fillBtn) fillBtn.onclick = () => fillGuess(lastRec);
  }

  setInterval(loop, POLL_MS);
  loop();
})();
