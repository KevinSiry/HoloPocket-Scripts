// ==UserScript==
// @name         HoloPocket – Recyclage intelligent des doublons
// @namespace    kevin.holopocket
// @version      1.2
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-recyclage.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-recyclage.user.js
// @description  Recycle uniquement les doublons qui ne valent pas une mise aux enchères (vente nette après taxe pas assez supérieure à la valeur de recyclage). Garde toujours tes exemplaires et ignore les cartes verrouillées, favorites, recherchées, en vente, en échange, ou liées à un objectif ou une médaille.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    MIN_GAIN: 2,                    // la vente doit rapporter au moins 2 pièces de plus que le recyclage pour mériter une enchère
    TAX: 0.05,                      // taxe du marché prélevée sur le prix final
    TIERS: ['C', 'PC', 'R', 'SR'],  // paliers concernés (UR et L exclus par prudence)
    RECYCLE_UNKNOWN: false,         // carte sans prix de marché ni estimation : on la garde
    AUTO_INTERVAL_MIN: 30,          // fréquence du recyclage automatique
    MAX_PER_RUN: 300,               // cartes recyclées au plus par passage
    BATCH: 40,                      // cartes par requête de recyclage
    DELAY: 120,                     // pause entre deux lectures de carte (ms)
    DRY_RUN: false,                 // true = calcule sans rien recycler
  };
  const FALLBACK_VALUE = { C: 1, PC: 1, R: 3, SR: 10, UR: 30, L: 120 };
  const TIER_NAME = { C: 'Communes', PC: 'Peu communes', R: 'Rares', SR: 'Super rares', UR: 'Ultra rares', L: 'Légendaires' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Cartes achetées par le script Achat-revente : il s'occupe lui-même de leur revente
  const flipReserved = () => { try { return new Set(JSON.parse(localStorage.getItem('hp-flip-reserved') || '[]')); } catch { return new Set(); } };
  let reserved = null;
  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `${res.status}`);
    return data;
  }

  // Valeur de recyclage par palier (lue sur le site) et nombre d'exemplaires à garder (réglage du site)
  async function siteSettings() {
    let keep = { normal: 1, reverse: 1 };
    const values = { ...FALLBACK_VALUE };
    try { keep = (await api('GET', '/me')).me.recycleKeep || keep; } catch {}
    try {
      const d = await api('GET', `/collection/duplicates?normal=${keep.normal ?? 1}&reverse=${keep.reverse ?? 1}`);
      for (const t of d.tiers || []) if (t.value != null) values[t.tier] = t.value;
    } catch {}
    return { keep, values };
  }

  // Vaut-il le coup de mettre cette carte aux enchères ?
  function worthSelling(market, recycleValue) {
    if (market == null) return !CONFIG.RECYCLE_UNKNOWN;
    return Math.floor(market * (1 - CONFIG.TAX)) >= recycleValue + CONFIG.MIN_GAIN;
  }

  // Exemplaires promis dans des propositions d'échange en attente : on n'y touche pas
  async function promisedIds() {
    const ids = new Set();
    try {
      const sent = await api('GET', '/trades/sent');
      for (const t of Array.isArray(sent) ? sent : []) {
        if (t.status !== 'pending') continue;
        for (const x of t.offered || []) if (x.userCardId) ids.add(x.userCardId);
      }
    } catch {}
    try { const now = Date.now(); for (const e of JSON.parse(localStorage.getItem('hp-trade-promised') || '[]')) if (now - e.at < 15 * 60000) ids.add(e.id); } catch {}
    return ids;
  }

  async function plan(onProgress) {
    const { keep, values } = await siteSettings();
    const promised = await promisedIds();

    // 1) Tous tes doublons
    const entries = [];
    for (let page = 1; ; page++) {
      onProgress && onProgress(`Lecture de tes doublons… page ${page}`);
      const d = await api('GET', `/collection?duplicates=1&sort=market&page=${page}`);
      entries.push(...(d.entries || []));
      if (page * d.pageSize >= d.total || !(d.entries || []).length) break;
    }

    // 2) Premier tri sur les prix : seules les versions « pas rentables à vendre » sont gardées
    const pre = [];
    for (const e of entries) {
      if (!CONFIG.TIERS.includes(e.tier)) continue;
      if (e.favorite || (e.goalsAtStake || []).length || (e.medalsAtStake || []).length) continue;
      const rv = values[e.tier] ?? FALLBACK_VALUE[e.tier] ?? 0;
      const normal = !worthSelling(e.marketValue ?? e.estimate, rv);
      const reverse = e.hasReverse && !worthSelling(e.reverseMarketValue ?? e.reverseEstimate, rv);
      if (normal || reverse) pre.push({ e, rv, normal, reverse });
    }

    // 3) Vérification carte par carte (verrous, exemplaires réellement libres)
    const items = [];
    let n = 0;
    for (const x of pre) {
      if (items.length >= CONFIG.MAX_PER_RUN) break;
      reserved = flipReserved();
      onProgress && onProgress(`Vérification des cartes… ${++n}/${pre.length}`);
      let c;
      try { c = await api('GET', `/cards/${encodeURIComponent(x.e.id)}`); } catch { continue; }
      const m = c.mine;
      if (!m || m.favorite || m.inTrade || (m.goalsAtStake || []).length || (m.medalsAtStake || []).length) continue;
      const revIds = new Set(m.availableReverseIds || []);
      const versions = [];
      if (x.normal) versions.push({
        reverse: false, ids: (m.availableIds || []).filter((id) => !revIds.has(id)),
        owned: (m.copies || 0) - (m.reverseCopies || 0), listed: m.listed || 0,
        locked: m.locked && m.locked.normal, wanted: m.wanted, keep: Math.max(1, keep.normal ?? 1),
        market: c.marketValue ?? c.estimate,
      });
      if (x.reverse) versions.push({
        reverse: true, ids: m.availableReverseIds || [],
        owned: m.reverseCopies || 0, listed: m.listedReverse || 0,
        locked: m.locked && m.locked.reverse, wanted: m.wantedReverse, keep: Math.max(1, keep.reverse ?? 1),
        market: c.reverseMarketValue ?? c.reverseEstimate,
      });
      for (const v of versions) {
        if (v.locked || v.wanted || reserved.has(`${x.e.id}|${v.reverse}`)) continue;
        if (worthSelling(v.market, x.rv)) continue; // re-vérifié avec les prix à jour
        const free = v.ids.filter((id) => !promised.has(id));
        const leaving = v.listed + (v.ids.length - free.length); // en vente ou promis dans un échange : ne restera pas
        const count = Math.min(free.length, Math.max(0, v.owned - leaving - v.keep), CONFIG.MAX_PER_RUN - items.length);
        for (let i = 0; i < count; i++) items.push({ id: free[i], name: x.e.name, tier: x.e.tier, reverse: v.reverse, rv: x.rv, market: v.market });
      }
      await sleep(CONFIG.DELAY);
    }
    return { items, coins: items.reduce((s, i) => s + i.rv, 0) };
  }

  // Recyclage par lots ; si le site refuse un lot, on repasse carte par carte
  async function execute(items, onProgress) {
    let coins = 0, done = 0;
    const failed = [];
    for (let i = 0; i < items.length; i += CONFIG.BATCH) {
      const batch = items.slice(i, i + CONFIG.BATCH);
      onProgress && onProgress(`Recyclage… ${Math.min(i + batch.length, items.length)}/${items.length}`);
      if (CONFIG.DRY_RUN) { done += batch.length; coins += batch.reduce((s, x) => s + x.rv, 0); continue; }
      try {
        const r = await api('POST', '/collection/recycle', { userCardIds: batch.map((x) => x.id) });
        coins += r.coins ?? batch.reduce((s, x) => s + x.rv, 0);
        done += r.recycled ?? batch.length;
      } catch {
        for (const x of batch) {
          try { const r = await api('POST', '/collection/recycle', { userCardIds: [x.id] }); coins += r.coins ?? x.rv; done++; }
          catch (e) { failed.push({ ...x, reason: e.message }); }
          await sleep(80);
        }
      }
      await sleep(250);
    }
    return { done, coins, failed };
  }

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


  // ───────── Interface ─────────
  const esc = UI.esc;
  const PANEL = 'hp-recycle-panel';
  const AUTO_KEY = 'hp-recycle-auto-on';
  const LAST_KEY = 'hp-recycle-last';
  let autoOn = false;
  try { autoOn = localStorage.getItem(AUTO_KEY) === '1'; } catch {}
  let busy = false, status = '', preview = null;
  const readLast = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; } };
  const writeLast = (v) => { try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch {} };

  function summaryHtml(p) {
    const byTier = {};
    for (const it of p.items) { const t = (byTier[it.tier] ||= { n: 0, coins: 0 }); t.n++; t.coins += it.rv; }
    const tiers = Object.entries(byTier).map(([t, v]) => `<div style="display:flex;justify-content:space-between"><span>${TIER_NAME[t] || t}</span><span style="font-family:var(--font-mono,monospace)">${v.n} · +${v.coins}</span></div>`).join('');
    const lines = p.items.slice(0, 40).map((it) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}${it.reverse ? ' <i>(rev.)</i>' : ''}</span><span class="hp-muted" style="white-space:nowrap">marché ${it.market ?? '?'} → +${it.rv}</span></div>`).join('');
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <b>${p.items.length} carte(s) à recycler</b>
        <b style="font:700 16px var(--font-mono,ui-monospace,monospace);color:var(--color-brand,#ffd60a)">+${p.coins}</b>
      </div>
      ${tiers ? `<div style="padding:8px 10px;border-radius:10px;background:var(--color-panel-2,#242428);margin-bottom:8px;font-size:13px">${tiers}</div>` : ''}
      ${lines ? `<div style="max-height:220px;overflow:auto;padding-right:4px">${lines}${p.items.length > 40 ? `<div class="hp-muted" style="font-size:12px;margin-top:4px">… et ${p.items.length - 40} autre(s)</div>` : ''}</div>` : ''}`;
  }

  function render() {
    if (!UI.hasPanel(PANEL)) { paint(); return; } // panneau ouvert à la main uniquement (jamais par l'auto-recyclage)
    const body = UI.panel(PANEL, {
      title: 'Recyclage intelligent', order: 22, closable: true, onClose: paint,
      actions: [{ icon: 'refresh', title: 'Recalculer', onClick: analyse }],
    });
    body.innerHTML = `
      <div class="hp-muted" style="font-size:12.5px;margin-bottom:10px">Recycle seulement les doublons dont la vente (prix habituel − ${Math.round(CONFIG.TAX * 100)} % de taxe) ne rapporterait pas au moins ${CONFIG.MIN_GAIN} pièces de plus que le recyclage. Tu gardes toujours tes exemplaires ; cartes verrouillées, favorites, recherchées, en vente, en échange ou liées à un objectif ignorées.</div>
      ${busy ? `<div class="hp-muted">${esc(status)}</div>`
        : preview ? (preview.items.length ? summaryHtml(preview) + `<button type="button" class="hp-mini" data-act="go" style="width:100%;margin-top:10px">Recycler ces ${preview.items.length} carte(s) · +${preview.coins}</button>` : '<div>Aucun doublon à recycler : tout ce qui reste vaut une mise aux enchères.</div>')
        : ''}`;
    const go = body.querySelector('[data-act=go]');
    if (go) go.onclick = () => run(preview.items);
    paint();
  }

  async function analyse() {
    if (busy) return;
    busy = true; status = 'Analyse…'; render();
    try { preview = await plan((s) => { status = s; render(); }); }
    catch (e) { preview = null; UI.toast(`Recyclage : ${esc(e.message)}`, { kind: 'error' }); }
    finally { busy = false; render(); }
  }

  async function run(items, auto) {
    if (busy || !items || !items.length) return;
    busy = true; status = 'Recyclage…'; render();
    try {
      const r = await execute(items, (s) => { status = s; render(); });
      writeLast({ at: Date.now(), done: r.done, coins: r.coins });
      if (r.done || r.failed.length) {
        UI.toast(`<b>${auto ? 'Auto-recyclage' : 'Recyclage'}${CONFIG.DRY_RUN ? ' (test à blanc)' : ''}</b> : ${r.done} carte(s) · +${r.coins} pièces${r.failed.length ? `<br><span style="color:#f87171">${r.failed.length} échec(s)</span>` : ''}`, { kind: r.failed.length && !r.done ? 'error' : 'success', ms: 10000 });
      }
    } catch (e) {
      UI.toast(`Recyclage : ${esc(e.message)}`, { kind: 'error' });
    } finally {
      busy = false; preview = null;
      if (UI.hasPanel(PANEL)) analyse(); else paint();
    }
  }

  // Passage automatique (toutes les pages), au plus une fois par intervalle, même en changeant de page
  async function autoTick() {
    if (!autoOn || busy) return;
    const last = readLast();
    if (last && Date.now() - last.at < CONFIG.AUTO_INTERVAL_MIN * 60000) { paint(); return; }
    busy = true; status = 'Analyse…'; paint();
    let p = null;
    try { p = await plan(); } catch {}
    busy = false;
    if (p && p.items.length) await run(p.items, true);
    else { writeLast({ at: Date.now(), done: 0, coins: 0 }); paint(); }
  }

  function mins(ms) { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }

  function paint() {
    const last = readLast();
    let sub = 'Désactivé';
    if (autoOn) {
      if (busy) sub = status || 'En cours…';
      else if (last) sub = `${last.done ? `Dernier : ${last.done} · +${last.coins}` : 'Rien à recycler'} · prochain dans ${mins(last.at + CONFIG.AUTO_INTERVAL_MIN * 60000 - Date.now())}`;
      else sub = 'Premier passage imminent';
    }
    UI.button('hp-recycle-auto', {
      label: 'Auto-recyclage', sub, icon: 'refresh', kind: 'toggle', on: autoOn, order: 92, busy: busy && autoOn,
      title: 'Recycle automatiquement les doublons qui ne valent pas une mise aux enchères',
      onClick: () => {
        autoOn = !autoOn;
        try { localStorage.setItem(AUTO_KEY, autoOn ? '1' : '0'); } catch {}
        paint();
        if (autoOn) autoTick();
      },
    });
    if (location.pathname.startsWith('/collection')) {
      const open = UI.hasPanel(PANEL);
      UI.button('hp-recycle-open', {
        label: 'Recyclage intelligent', sub: open ? 'Masquer l’aperçu' : 'Aperçu des doublons sans intérêt à vendre',
        icon: 'coins', kind: 'secondary', order: 14, busy: busy && !autoOn,
        onClick: () => { if (UI.hasPanel(PANEL)) { UI.removePanel(PANEL); preview = null; paint(); } else { preview = null; UI.panel(PANEL, { title: 'Recyclage intelligent', order: 22, closable: true, onClose: paint }); analyse(); } },
      });
    } else {
      UI.removeButton('hp-recycle-open');
      if (!busy) UI.removePanel(PANEL);
    }
  }

  paint();
  setInterval(paint, 1000);
  setInterval(autoTick, 60000);
  if (autoOn) setTimeout(autoTick, 3000);
})();
