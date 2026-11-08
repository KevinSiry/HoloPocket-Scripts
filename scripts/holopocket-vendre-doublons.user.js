// ==UserScript==
// @name         HoloPocket – Vendre mes doublons
// @namespace    kevin.holopocket
// @version      4.6
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-vendre-doublons.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-vendre-doublons.user.js
// @description  Marché : met en vente les doublons (prix conseillé, les plus chers d'abord), à la demande ou en mode auto qui remplit les slots dès qu'une place se libère.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    DURATION_MINUTES: 30, // minimum du site : 30
    DRY_RUN: false,       // true = calcule et affiche le plan sans rien mettre en vente
    RELOAD_AFTER: true,   // recharge la page après les ventes pour mettre l'affichage à jour
    DELAY: 400,           // pause entre deux mises en vente (ms)
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Même client que le site : fetch JSON, cookies de session same-origin
  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `${res.status} ${data.error || ''}`.trim());
    return data;
  }

  // Tous les doublons vendables (toutes pages)
  async function fetchDuplicates() {
    const entries = [];
    for (let page = 1; ; page++) {
      const d = await api('GET', `/collection?sellable=1&duplicates=1&sort=market&page=${page}`);
      entries.push(...d.entries);
      if (page * d.pageSize >= d.total || !d.entries.length) break;
    }
    return entries;
  }

  // Exemplaires vendables en gardant toujours au moins 1 exemplaire de chaque version
  function candidates(entries, promised) {
    const list = [];
    for (const e of entries) {
      const versions = [
        { reverse: false, ids: e.availableIds || [], owned: e.owned?.normal ?? 0, value: e.marketValue },
        { reverse: true, ids: e.availableReverseIds || [], owned: e.owned?.reverse ?? 0, value: e.reverseMarketValue },
      ];
      for (const v of versions) {
        // Un seul exemplaire par version : jamais deux ventes simultanées de la même carte.
        // Les exemplaires promis dans un échange en attente ne comptent pas : ils partiront si l'échange est accepté.
        const free = v.ids.filter((id) => !promised.has(id));
        const promisedN = v.ids.length - free.length;
        if (free.length && v.owned - promisedN - 1 >= 1) {
          list.push({ userCardId: free[0], cardId: e.id, name: e.name, reverse: v.reverse, value: v.value ?? e.estimate ?? 0 });
        }
      }
    }
    return list.sort((a, b) => b.value - a.value);
  }

  const priceCache = new Map();
  async function suggestedPrice(cardId, reverse) {
    const key = `${cardId}|${reverse}`;
    if (!priceCache.has(key)) {
      const m = await api('GET', `/cards/${encodeURIComponent(cardId)}/market`);
      const v = m.versions.find((x) => x.reverse === reverse) ?? m.versions[0];
      priceCache.set(key, v?.suggestedStart ?? null);
    }
    return priceCache.get(key);
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


  const esc = UI.esc;
  // Notifications : dans la colonne de droite du kit
  const toast = (html, ms = 12000, kind = 'success') => UI.toast(html, { ms, kind });

  const line = (c) => `${esc(c.name)}${c.reverse ? ' <i>(reverse)</i>' : ''}`;
  let busy = false;

  // Met en vente jusqu'à `max` doublons (les plus chers d'abord, prix conseillé). Sans UI ni reload.
  // Cartes (et versions) déjà en vente : on ne les remet pas en vente une deuxième fois
  // Cartes achetées par le script Achat-revente : il s'occupe lui-même de leur revente
  const flipReserved = () => { try { return new Set(JSON.parse(localStorage.getItem('hp-flip-reserved') || '[]')); } catch { return new Set(); } };
  // Exemplaires promis dans une proposition d'échange en attente (site + envois récents pas encore affichés par le site) :
  // on n'y touche pas, sinon la vente et l'échange partiraient avec le même exemplaire. null = illisible → ne rien vendre.
  async function promisedIds() {
    const ids = new Set();
    try {
      const sent = await api('GET', '/trades/sent');
      for (const t of Array.isArray(sent) ? sent : (sent.entries || [])) {
        if (t.status !== 'pending') continue;
        for (const x of t.offered || []) if (x.userCardId) ids.add(x.userCardId);
      }
    } catch { return null; }
    try { const now = Date.now(); for (const e of JSON.parse(localStorage.getItem('hp-trade-promised') || '[]')) if (now - e.at < 15 * 60000) ids.add(e.id); } catch {}
    return ids;
  }
  async function onSaleKeys() {
    const keys = new Set();
    try {
      const d = await api('GET', '/market/mine/selling');
      for (const a of (Array.isArray(d) ? d : d.auctions || d.entries || [])) {
        if (!a.status || a.status === 'active') keys.add(`${a.card?.id ?? a.cardId}|${!!a.reverse}`);
      }
    } catch {}
    return keys;
  }

  // Marché refusé (compte récent…) : pas d'insistance, pause mémorisée
  const PAUSE_KEY = 'hp-sell-paused-until';
  const pausedUntil = () => { try { return +localStorage.getItem(PAUSE_KEY) || 0; } catch { return 0; } };
  const pauseSales = (min) => { try { localStorage.setItem(PAUSE_KEY, String(Date.now() + min * 60000)); } catch {} };
  const RESTRICTED = /nouveau|r[ée]cent|restreint|interdit|bloqu|pas encore|avant de pouvoir|\b24\s*h|^403\b/i;

  async function listFill(max, onProgress) {
    const done = [], failed = [];
    let streak = 0;
    const onSale = await onSaleKeys();
    const reserved = flipReserved();
    const promised = await promisedIds();
    if (!promised) throw new Error('échanges en attente illisibles : vente reportée');
    const list = candidates(await fetchDuplicates(), promised).filter((c) => !onSale.has(`${c.cardId}|${!!c.reverse}`) && !reserved.has(`${c.cardId}|${!!c.reverse}`));
    for (const c of list) {
      if (done.length >= max) break;
      const k = `${c.cardId}|${!!c.reverse}`;
      if (onSale.has(k)) continue;
      onProgress && onProgress(done.length + 1, max);
      try {
        const price = await suggestedPrice(c.cardId, c.reverse);
        if (!price) { failed.push({ ...c, reason: 'pas de prix conseillé' }); continue; }
        if (!CONFIG.DRY_RUN) {
          await api('POST', '/market', { userCardId: c.userCardId, startPrice: price, durationMinutes: CONFIG.DURATION_MINUTES });
          await sleep(CONFIG.DELAY);
        }
        onSale.add(k);
        done.push({ ...c, price });
        streak = 0;
      } catch (e) {
        failed.push({ ...c, reason: e.message });
        if (/limite|max|10/i.test(e.message)) break; // plus de place
        // Marché refusé : 1 h de pause ; deux refus d'affilée pour une autre raison : 15 min
        streak++;
        if (RESTRICTED.test(e.message)) { pauseSales(60); try { localStorage.setItem('hp-market-blocked-until', String(Date.now() + 60 * 60000)); } catch {} break; }
        if (streak >= 2) { pauseSales(15); break; }
      }
    }
    return { done, failed };
  }

  let lastCounts = null;
  async function freeSlots() {
    const counts = await api('GET', '/market/counts');
    lastCounts = counts;
    return { free: Math.max(0, (counts.maxSelling ?? 10) - (counts.selling ?? 0)), counts };
  }

  // Mise en vente manuelle (bouton du Marché)
  let progress = '';
  async function run() {
    if (busy) return; busy = true; progress = 'Analyse…'; paint();
    let soldAny = false;
    try {
      const { free, counts } = await freeSlots();
      if (!free && !CONFIG.DRY_RUN) { toast(`Aucune place libre (Mes ventes ${counts.selling}/${counts.maxSelling}).`, 6000, 'info'); return; }
      const { done, failed } = await listFill(CONFIG.DRY_RUN ? Math.max(free, 10) : free, (i, n) => { progress = `${i}/${n}`; paint(); });
      soldAny = done.length > 0 && !CONFIG.DRY_RUN;
      toast(
        `<b>${CONFIG.DRY_RUN ? 'Test à blanc (rien vendu)' : `${done.length} doublon(s) en vente · ${CONFIG.DURATION_MINUTES} min`}</b>` +
        `<br>${done.map((c) => `• ${line(c)} — ${c.price}`).join('<br>')}` +
        (failed.length ? `<br><br><b>Ignorés :</b><br>${failed.map((c) => `✗ ${line(c)} : ${esc(c.reason)}`).join('<br>')}` : ''),
        CONFIG.DRY_RUN ? 0 : 12000, done.length ? 'success' : 'info'
      );
    } catch (e) {
      toast(`Erreur : ${esc(e.message)}`, 8000, 'error');
    } finally {
      busy = false; progress = ''; paint();
      if (soldAny && CONFIG.RELOAD_AFTER) setTimeout(() => location.reload(), 4000);
    }
  }

  // ───────── Mode auto : remplit les slots dès qu'une place se libère ─────────
  const AUTO_KEY = 'hp-sell-auto-on';
  const AUTO_POLL_MS = 30000;
  let autoOn = false;
  try { autoOn = localStorage.getItem(AUTO_KEY) === '1'; } catch {}

  async function autoTick() {
    if (!autoOn || busy) return; // tourne sur toutes les pages du site
    if (Date.now() < pausedUntil()) return; // marché refusé récemment : aucun appel
    busy = true;
    try {
      const { free: slots } = await freeSlots();
      // Achat-revente attend des places pour revendre ses cartes : on les lui laisse (valable 5 min après son dernier passage)
      let need = 0;
      try { const w = JSON.parse(localStorage.getItem('hp-flip-wait') || 'null'); if (w && Date.now() - w.at < 5 * 60000) need = w.n || 0; } catch {}
      const free = Math.max(0, slots - need);
      if (free > 0) {
        const { done } = await listFill(free);
        if (done.length) toast(`<b>Auto-vente</b> : ${done.length} doublon(s) mis en vente<br>${done.map((c) => `• ${line(c)} — ${c.price}`).join('<br>')}`, 8000);
        await freeSlots();
      }
    } catch (e) { /* on réessaiera au prochain tour */ } finally { busy = false; paint(); }
  }
  setInterval(autoTick, AUTO_POLL_MS);

  // ───────── Boutons du dock ─────────
  function paint() {
    if (location.pathname.startsWith('/marche')) {
      UI.button('hp-sell-dups', {
        label: busy && progress ? 'Mise en vente…' : 'Vendre mes doublons',
        sub: busy && progress ? progress : `Prix conseillé · ${CONFIG.DURATION_MINUTES} min · plus chers d’abord`,
        icon: 'coins', kind: 'primary', order: 10, busy: busy && !!progress, disabled: busy, onClick: run,
      });
    } else UI.removeButton('hp-sell-dups');
    const slots = lastCounts ? `Ventes ${lastCounts.selling}/${lastCounts.maxSelling}` : '';
    UI.button('hp-sell-auto', {
      label: 'Auto-vente',
      sub: autoOn ? (slots ? `${slots} · remplit les places libres` : 'Remplit les places libres') : 'Désactivée',
      icon: 'repeat', kind: 'toggle', on: autoOn, order: 91,
      title: 'Remet automatiquement des doublons en vente dès qu’une place se libère',
      onClick: () => {
        autoOn = !autoOn;
        try { localStorage.setItem(AUTO_KEY, autoOn ? '1' : '0'); } catch {}
        paint();
        if (autoOn) autoTick();
      },
    });
  }

  paint();
  if (autoOn) freeSlots().then(paint).catch(() => {});
  setInterval(paint, 1000); // navigation interne du site
})();
