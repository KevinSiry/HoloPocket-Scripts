// ==UserScript==
// @name         HoloPocket – Stratège du Maître
// @namespace    kevin.holopocket
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-maitre.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-maitre.user.js
// @description  Maître de la Ligue : calcule la vraie chance de chaque annonce (d'après le contenu du booster) et choisit celle qui maximise la chance de dépasser le score du Maître avec les boosters qui restent. Mode conseil (entoure l'annonce) ou mode auto. Se met à jour sans recharger la page.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ═════════════════════════ Moteur (pur, testé dans tests/maitre.test.js) ═════════════════════════
  //
  //  • Chance d'une annonce : on tire 200 000 boosters fictifs avec les emplacements du booster
  //    (GET /sets/:id/booster) et les cartes de la série (GET /sets/:id), carte au hasard dans sa rareté.
  //  • Annonce que les données du site ne permettent pas de vérifier (PV…) : chance déduite des points
  //    (le site paie à peu près « constante / chance »), signalée comme estimée.
  //  • Décision : programmation dynamique sur (boosters restants, points manquants). Les offres futures
  //    sont inconnues : on prend la moyenne des offres déjà vues (à défaut, l'offre du moment).
  //  • Objectif : chance de dépasser le Maître (+ léger bonus étoiles) ; en rejeu : étoiles espérées.
  const Engine = (function () {
    const TYPES = { plante: 'Grass', feu: 'Fire', eau: 'Water', electrique: 'Lightning', psy: 'Psychic', combat: 'Fighting',
      obscurite: 'Darkness', metal: 'Metal', dragon: 'Dragon', incolore: 'Colorless', fee: 'Fairy' };
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
    const isPk = (c) => c.category === 'Pokemon';

    // Texte d'annonce → { test(cartes) } ou null si on ne sait pas la vérifier.
    function parseCall(text, rarities) {
      const t = norm(text);
      let n = 1, rest = t, none = false;
      let m = t.match(/^(\d+)\s+(.*)$/);
      if (m) { n = +m[1]; rest = m[2]; }
      else if ((m = t.match(/^(?:au moins )?une?\s+(.*)$/))) { rest = m[1]; }
      else if ((m = t.match(/^aucune?\s+(.*)$/))) { none = true; rest = m[1]; }
      const exact = /exactement/.test(t);
      rest = rest.replace(/^(?:exactement|au moins)\s+/, '');
      const wrap = (count) => ({ test: (cs) => { const k = count(cs); return none ? k === 0 : exact ? k === n : k >= n; } });
      const cnt = (f) => wrap((cs) => cs.filter(f).length);

      if (/\bpv\b|points? de vie/.test(rest)) return null; // PV absents des données du site
      if (/^types? de pokemon differents?$/.test(rest) || /^types? differents?/.test(rest)) {
        return wrap((cs) => new Set(cs.filter(isPk).map((c) => c.type)).size);
      }
      if ((m = rest.match(/^exemplaires? de [«"] ?(.+?) ?[»"]$/)) || (m = rest.match(/^[«"] ?(.+?) ?[»"]$/))) {
        const name = m[1]; return cnt((c) => norm(c.name) === name);
      }
      if (/^cartes? (?:de )?dresseurs?$/.test(rest) || /^dresseurs?$/.test(rest)) return cnt((c) => c.category === 'Trainer');
      if (/^cartes? energies?$/.test(rest)) return cnt((c) => c.category === 'Energy');
      if ((m = rest.match(/^pokemon(?: de type)? ([a-z]+)$/)) && TYPES[m[1]]) { const ty = TYPES[m[1]]; return cnt((c) => isPk(c) && c.type === ty); }
      if (/^pokemon de base$/.test(rest)) return cnt((c) => isPk(c) && c.stage === 'Basic');
      if ((m = rest.match(/^pokemon (?:de )?niveau ([12])$/))) { const st = 'Stage' + m[1]; return cnt((c) => isPk(c) && c.stage === st); }
      if (/^pokemon evolues?$/.test(rest)) return cnt((c) => isPk(c) && c.stage && c.stage !== 'Basic');
      if ((m = rest.match(/^(?:cartes?|pokemon)[ -](ex|gx|v|vmax|vstar)$/))) {
        const re = new RegExp('[ -]' + m[1] + '$', 'i'); return cnt((c) => re.test(String(c.name || '').trim()));
      }
      if (/^pokemon$/.test(rest)) return cnt(isPk);
      // rareté : « une carte Rare Holo », « 2 cartes 2 Étoiles », avec « ou mieux » éventuel
      if ((m = rest.match(/^cartes? (.+?)( ou (?:mieux|plus))?$/))) {
        const r = (rarities || []).find((x) => norm(x.rarity) === m[1]);
        if (r) return m[2] ? cnt((c) => (c.rank || 0) >= r.rank) : cnt((c) => norm(c.rarity) === m[1]);
      }
      return null;
    }

    function rng(seed) { // mulberry32
      let a = seed >>> 0;
      return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }

    // Chance de chaque prédicat (null → null). cards : cartes de la série ; slots : emplacements du booster.
    function simulate(cards, slots, preds, runs = 200000, seed = 12345) {
      const by = {};
      for (const c of cards) (by[c.rarity] = by[c.rarity] || []).push(c);
      const sl = (slots || []).map((s) => {
        const pools = (s.pools || []).filter((p) => by[p.rarity] && by[p.rarity].length && p.chance > 0);
        const tot = pools.reduce((a, p) => a + p.chance, 0);
        let acc = 0;
        return pools.map((p) => ({ list: by[p.rarity], cum: (acc += p.chance / tot) }));
      }).filter((p) => p.length);
      if (!sl.length) return preds.map(() => null);
      const rnd = rng(seed), hits = preds.map(() => 0), pack = new Array(sl.length);
      for (let i = 0; i < runs; i++) {
        for (let s = 0; s < sl.length; s++) {
          const u = rnd(), pools = sl[s];
          let k = 0; while (k < pools.length - 1 && u > pools[k].cum) k++;
          const l = pools[k].list; pack[s] = l[Math.floor(rnd() * l.length)];
        }
        for (let j = 0; j < preds.length; j++) if (preds[j] && preds[j].test(pack)) hits[j]++;
      }
      return preds.map((p, j) => (p ? hits[j] / runs : null));
    }

    // Chance déduite des points quand on ne sait pas vérifier l'annonce (relevé : 2 pts ↔ 78 %, 33 pts ↔ 3,9 %)
    const K = { facile: 1.55, risque: 1.45, folie: 1.3 };
    const implied = (call) => Math.min(0.95, (K[call.tier] || 1.4) / Math.max(1, call.points));

    function stars(left, th) { return 1 + (left >= th[0] ? 1 : 0) + (left >= th[1] ? 1 : 0); }
    function utility(left, th, objective) { const s = stars(left, th); return objective === 'stars' ? s : 1 + 0.01 * (s - 1); }

    // offer : [{ index, p, points }] ; future : liste d'offres du même format (modèle des tours suivants)
    function solve({ left, need, offer, future, thresholds, objective }) {
      const fut = future && future.length ? future : [offer];
      const memo = new Map();
      const pick = (o, k, n) => o.map((c) => ({ index: c.index, value: c.p * V(k - 1, n - c.points) + (1 - c.p) * V(k - 1, n) }));
      function V(k, n) {
        if (n <= 0) return utility(k, thresholds, objective);
        if (k <= 0) return 0;
        const key = k * 1000 + n;
        if (memo.has(key)) return memo.get(key);
        let v = 0;
        for (const o of fut) v += Math.max(...pick(o, k, n).map((x) => x.value));
        v /= fut.length;
        memo.set(key, v);
        return v;
      }
      const choices = pick(offer, left, need).sort((a, b) => (Math.abs(b.value - a.value) > 1e-9 ? b.value - a.value : 0) || (offer.find((c) => c.index === b.index).p - offer.find((c) => c.index === a.index).p));
      return { value: choices.length ? choices[0].value : 0, choices };
    }

    return { parseCall, simulate, implied, solve, stars, norm };
  })();

  if (typeof window === 'undefined' || window.__HP_TEST__) {
    if (typeof window !== 'undefined') window.__hpMaitreEngine = Engine;
    return;
  }

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


  // ═════════════════════════ Interface et jeu ═════════════════════════
  const AUTO_KEY = 'hp-maitre-auto';
  const OFFERS_KEY = 'hp-maitre-offers';
  const PANEL = 'hp-maitre-panel';
  const BTN_AUTO = 'hp-maitre-auto-btn';
  const BTN_STEP = 'hp-maitre-step-btn';

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const pct = (x) => (x * 100).toLocaleString('fr-FR', { maximumFractionDigits: x < 0.1 ? 2 : 1 }) + ' %';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rawFetch = window.fetch.bind(window);
  async function api(path) {
    const res = await rawFetch(`/api${path}`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `${res.status} ${data.error || ''}`.trim());
    return data;
  }
  const region = () => (location.pathname.match(/^\/tour\/([^/]+)\/maitre\/?$/) || [])[1];

  // Contenu d'une série (cartes + emplacements du booster), gardé en mémoire
  const setCache = new Map();
  function setData(id) {
    if (!setCache.has(id)) {
      const e = encodeURIComponent(id);
      setCache.set(id, Promise.all([api(`/sets/${e}`), api(`/sets/${e}/booster`)])
        .then(([s, b]) => ({ cards: s.cards || [], slots: b.slots || [], rarities: b.rarities || [] }))
        .catch((err) => { setCache.delete(id); throw err; }));
    }
    return setCache.get(id);
  }

  // Chances d'une offre, gardées en mémoire (une offre = série + textes)
  const offerCache = new Map();
  async function offerProbs(offer) {
    const key = offer.setId + '|' + offer.calls.map((c) => c.text + ':' + c.points).join('|');
    if (offerCache.has(key)) return offerCache.get(key);
    let sim = offer.calls.map(() => null);
    try {
      const d = await setData(offer.setId);
      sim = Engine.simulate(d.cards, d.slots, offer.calls.map((c) => Engine.parseCall(c.text, d.rarities)));
    } catch (_) { /* série illisible : tout passe en estimation */ }
    const calls = offer.calls.map((c, i) => ({ index: c.index, text: c.text, tier: c.tier, points: c.points,
      p: sim[i] == null ? Engine.implied(c) : sim[i], guessed: sim[i] == null }));
    offerCache.set(key, calls);
    // mémorise l'offre pour modéliser les tours suivants (60 dernières, sans doublon)
    const seen = lsGet(OFFERS_KEY, []).filter((o) => o.k !== key);
    seen.push({ k: key, c: calls.map((c) => ({ index: c.index, p: +c.p.toFixed(4), points: c.points })) });
    lsSet(OFFERS_KEY, seen.slice(-60));
    return calls;
  }

  async function plan(view) {
    const run = view.run;
    const calls = await offerProbs(run.offer);
    const res = Engine.solve({
      left: run.boosters, need: run.target + 1 - run.score, offer: calls,
      future: lsGet(OFFERS_KEY, []).map((o) => o.c), thresholds: view.thresholds || [3, 5],
      objective: run.replay ? 'stars' : 'win',
    });
    return { calls, res, objective: run.replay ? 'stars' : 'win' };
  }

  function highlight(p) {
    document.querySelectorAll('.hp-maitre-pick').forEach((el) => { el.classList.remove('hp-maitre-pick'); el.style.outline = ''; el.style.outlineOffset = ''; });
    if (!p || !p.res.choices.length) return;
    const el = document.querySelector(`.bl-choice[data-call="${p.res.choices[0].index}"]`);
    if (el) { el.classList.add('hp-maitre-pick'); el.style.outline = '3px solid #22c55e'; el.style.outlineOffset = '3px'; }
  }

  function render(view, p) {
    const run = view && view.run;
    const body = UI.panel(PANEL, { title: 'Stratège du Maître', order: 5 });
    if (!p) {
      const msg = !run ? "Aucun essai en cours : lance l'essai du jour sur le site."
        : run.status === 'won' ? `Maître battu : ${run.score} points !`
        : run.status === 'lost' ? `Essai perdu (${run.score} points pour ${run.target + 1} à faire). Reviens demain.`
        : 'Essai terminé.';
      body.innerHTML = `<div class="hp-muted">${UI.esc(msg)}</div>`;
      highlight(null);
      return;
    }
    const fmtV = (v) => p.objective === 'stars' ? v.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' ★' : pct(Math.min(1, v));
    const best = p.res.choices[0];
    const rows = p.res.choices.map((ch, i) => {
      const c = p.calls.find((x) => x.index === ch.index);
      return `<div style="${i === 0 ? 'font-weight:700' : 'opacity:.8'};margin-top:6px">
        <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${i === 0 ? '<span style="color:#4ade80">▶</span> ' : ''}${UI.esc(c.text)} <span class="hp-muted">+${c.points}</span></div>
        <div style="display:flex;justify-content:space-between;font:12px var(--font-mono,monospace)">
          <span>réussite ${c.guessed ? '≈ ' : ''}${pct(c.p)}${c.guessed ? ' (estimée)' : ''} · ${(c.p * c.points).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} pt/booster</span><span>${fmtV(ch.value)}</span></div></div>`;
    }).join('');
    const need = run.target + 1 - run.score;
    body.innerHTML = `
      <div class="hp-muted" style="font-size:12px">Encore ${need} point${need > 1 ? 's' : ''} en ${run.boosters} booster${run.boosters > 1 ? 's' : ''} · ${UI.esc(run.offer.setName)}</div>
      <div style="margin:6px 0 2px">${p.objective === 'stars' ? 'Étoiles espérées' : 'Chance de battre le Maître'} : <b>${fmtV(best.value)}</b></div>
      ${rows}
      ${p.calls.some((c) => c.guessed) ? '<div class="hp-muted" style="font-size:12px;margin-top:8px">« estimée » : annonce que les données du site ne permettent pas de vérifier (PV…), chance déduite de ses points.</div>' : ''}`;
    highlight(p);
  }

  let busy = false, lastView = null, lastPlan = null, lastViewAt = 0, seq = 0;
  const viewWaiters = [];
  async function applyView(view) {
    if (!view || !region()) return;
    const my = ++seq;
    const run = view.run;
    let p = null;
    if (run && run.status === 'playing' && run.offer && run.offer.calls && run.offer.calls.length) {
      try { p = await plan(view); } catch (e) { UI.toast('Maître : ' + UI.esc(e.message), { kind: 'error' }); }
    }
    if (my !== seq) return; // une vue plus récente est arrivée entre-temps
    lastView = view; lastPlan = p; lastViewAt = Date.now();
    render(view, p);
    if (!p && lsGet(AUTO_KEY, false)) setAuto(false);
    drawButtons();
    viewWaiters.splice(0).forEach((w) => w(view));
  }
  const nextView = (ms) => new Promise((res) => {
    const t = setTimeout(() => { const i = viewWaiters.indexOf(done); if (i >= 0) viewWaiters.splice(i, 1); res(null); }, ms);
    const done = (v) => { clearTimeout(t); res(v); };
    viewWaiters.push(done);
  });

  // ───── Écoute des réponses du site : chaque annonce (la tienne ou celle du script) met à jour les chances ─────
  const MAITRE_RE = /\/api\/tour\/[^/?#]+\/maitre(?:\/(?:announce|abandon|start))?$/;
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (!PAGE.__hpMaitreHook) {
    PAGE.__hpMaitreHook = true;
    const orig = PAGE.fetch;
    PAGE.fetch = async function (input) {
      const res = await orig.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (res.ok && MAITRE_RE.test(new URL(url, location.href).pathname)) {
          res.clone().json().then((d) => { if (d && 'run' in d) applyView(d); }).catch(() => {});
        }
      } catch (_) {}
      return res;
    };
  }

  async function refresh() {
    const r = region();
    if (!r) return null;
    await applyView(await api(`/tour/${encodeURIComponent(r)}/maitre`));
    return lastPlan;
  }

  // Filet de sécurité : l'affichage du Maître change → relecture (au plus toutes les 1,5 s)
  let domTimer = null, domGetAt = 0;
  function onDomChange() {
    if (!region() || busy) return;
    clearTimeout(domTimer);
    domTimer = setTimeout(async () => {
      if (Date.now() - lastViewAt < 1200 || Date.now() - domGetAt < 1500) return;
      domGetAt = Date.now();
      try { await refresh(); } catch (_) {}
    }, 700);
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (el && !el.closest('#hp-panels,#hp-dock') && el.closest('[class*="bl-"],[class*="lg-"]')) { onDomChange(); return; }
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });

  // ───── Jouer : clique l'annonce sur le site, puis « Booster suivant » ─────
  const ready = (b) => b && !b.disabled && b.getAttribute('aria-busy') !== 'true';
  const nextBtn = () => [...document.querySelectorAll('button')].find((b) => /^Booster suivant$/.test(b.textContent.trim()));
  async function waitFor(fn, ms) {
    const t0 = Date.now();
    for (;;) { const x = fn(); if (x) return x; if (Date.now() - t0 > ms) return null; await sleep(150); }
  }
  async function play() {
    if (busy) return;
    busy = true; drawButtons();
    try {
      const nb = nextBtn();
      if (ready(nb)) { nb.click(); await sleep(500); } // tour précédent encore affiché
      const p = Date.now() - lastViewAt < 4000 ? lastPlan : await refresh();
      if (!p || !p.res.choices.length) return;
      const idx = p.res.choices[0].index;
      const btn = await waitFor(() => { const b = document.querySelector(`.bl-choice[data-call="${idx}"]`); return ready(b) ? b : null; }, 6000);
      if (!btn) throw new Error("annonce introuvable sur la page (recharge la page si l'essai est bien en cours)");
      const wait = nextView(20000);
      btn.click();
      if (!(await wait)) await refresh();
      // le site dévoile les cartes une à une, puis propose « Booster suivant »
      const nx = await waitFor(() => { const b = nextBtn(); return ready(b) ? b : null; }, 15000);
      if (nx && lsGet(AUTO_KEY, false)) nx.click();
    } catch (e) {
      UI.toast('Maître : ' + UI.esc(e.message), { kind: 'error', ms: 0 });
      setAuto(false);
    } finally {
      busy = false; drawButtons();
      if (lsGet(AUTO_KEY, false)) schedulePlay();
    }
  }

  function setAuto(on) { lsSet(AUTO_KEY, !!on); drawButtons(); if (on) schedulePlay(); }
  let timer = null;
  function schedulePlay() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (lsGet(AUTO_KEY, false) && region()) play(); }, window.__hp.jitter(2600, 0.35));
  }

  function drawButtons() {
    if (!region()) { UI.removeButton(BTN_AUTO); UI.removeButton(BTN_STEP); return; }
    const auto = lsGet(AUTO_KEY, false);
    const best = lastPlan && lastPlan.res.choices[0];
    const c = best && lastPlan.calls.find((x) => x.index === best.index);
    UI.button(BTN_STEP, {
      kind: 'primary', icon: 'zap', order: 10, busy, disabled: busy || !c,
      label: 'Annoncer le meilleur choix', sub: c ? `${c.text} (+${c.points})` : '—',
      onClick: () => play(),
    });
    UI.button(BTN_AUTO, {
      kind: 'toggle', icon: 'repeat', order: 11, on: auto,
      label: 'Maître en auto', sub: auto ? 'annonce booster après booster' : 'arrêté',
      onClick: () => setAuto(!lsGet(AUTO_KEY, false)),
    });
  }

  // ───── Navigation SPA : s'active uniquement sur /tour/:region/maitre ─────
  let lastPath = null;
  async function onRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (!region()) { UI.removePanel(PANEL); drawButtons(); highlight(null); return; }
    try { await refresh(); } catch (e) { UI.toast('Maître : ' + UI.esc(e.message), { kind: 'error' }); }
    if (lsGet(AUTO_KEY, false)) schedulePlay();
  }
  setInterval(onRoute, 800);
  setInterval(() => { if (region() && lastPlan) highlight(lastPlan); }, 1500);
  onRoute();
})();
