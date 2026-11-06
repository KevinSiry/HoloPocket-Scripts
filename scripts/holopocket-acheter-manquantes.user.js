// ==UserScript==
// @name         HoloPocket – Enchérir sur mes cartes manquantes
// @namespace    kevin.holopocket
// @version      2.1
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-acheter-manquantes.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-acheter-manquantes.user.js
// @description  Bouton sur le Marché : enchérit (mise minimale) sur les cartes manquantes des séries en favori, seulement si l'enchère ne dépasse pas le prix habituel.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    BUDGET: 500,            // total maximum engagé par clic
    MAX_ENDS_IN_MINUTES: 30,// seulement les ventes qui se terminent dans ce délai
    INCLUDE_REVERSE: true,  // viser aussi les versions reverse manquantes
    USE_ESTIMATE: true,     // sans prix habituel, se baser sur l'estimation du site
    MAX_PAGES: 40,          // sécurité sur la pagination du marché
    CONFIRM: false,         // true = demande confirmation avec le plan avant d'enchérir
    DRY_RUN: false,         // true = affiche le plan sans enchérir
    DELAY: 400,             // pause entre deux enchères (ms)
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Joueurs à ne jamais solliciter (ex. ton autre compte) : localStorage 'hp-excluded-players' = ["pseudo", …]
  const excludedPlayers = () => { try { return new Set(JSON.parse(localStorage.getItem('hp-excluded-players') || '[]').map((x) => String(x).toLowerCase())); } catch { return new Set(); } };
  const isExcluded = (u) => !!u && excludedPlayers().has(String(u).toLowerCase());
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

  // Prix de référence = prix habituel (moyenne des ventes), sinon estimation
  function refPrice(a) {
    const c = a.card;
    const avg = a.reverse ? c.reverseMarketValue : c.marketValue;
    if (avg != null) return { value: avg, kind: 'moyenne' };
    const est = a.reverse ? c.reverseEstimate : c.estimate;
    if (CONFIG.USE_ESTIMATE && est != null) return { value: est, kind: 'estimation' };
    return null;
  }

  async function fetchMarket(setIds) {
    const all = [];
    for (let page = 1; page <= CONFIG.MAX_PAGES; page++) {
      const q = new URLSearchParams({ setId: setIds.join(','), hideOwned: '1', sort: 'price_asc', page: String(page) });
      const d = await api('GET', `/market?${q}`);
      all.push(...d.auctions);
      if (page * d.pageSize >= d.total || !d.auctions.length) break;
    }
    return all;
  }

  // Prix actuel d'une vente (enchère la plus haute, sinon mise de départ)
  const currentOf = (a) => a.currentPrice ?? a.startPrice ?? Infinity;
  const keyOf = (a) => `${a.card?.id ?? a.cardId}|${!!a.reverse}`;

  // Mes enchères en cours (onglet « Mes enchères »), en tête ou dépassées
  async function fetchMyBids() {
    const d = await api('GET', '/market/mine/bidding');
    const list = Array.isArray(d) ? d : d.auctions || d.entries || [];
    return list.filter((a) => !a.status || a.status === 'active');
  }

  /*
   * Par carte (id + version), au plus une nouvelle enchère par clic :
   *  - je mène déjà sur une vente de cette carte → seulement une autre vente conforme
   *    strictement moins chère que le prix actuel de celle que je mène ;
   *  - j'ai été dépassé (et ne mène nulle part) → je peux relancer sur cette vente,
   *    ou miser sur une autre vente de la carte si elle est moins chère ;
   *  - jamais misé → la vente conforme la moins chère.
   * « Conforme » = enchère minimale ≤ prix habituel (ou estimation), fin dans le délai.
   */
  function plan(auctions, budget, myBids) {
    const now = Date.now();
    const deadline = now + CONFIG.MAX_ENDS_IN_MINUTES * 60000;
    const myById = new Map(myBids.map((a) => [a.id, a]));
    // Ventes du marché + mes enchères (une vente où j'ai été dépassé peut manquer du listing)
    const byId = new Map(auctions.map((a) => [a.id, a]));
    for (const a of myBids) if (!byId.has(a.id) && a.card) byId.set(a.id, a);
    const groups = new Map();
    for (const a of byId.values()) {
      const key = keyOf(a);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(myById.get(a.id) ?? a); // les données de « Mes enchères » sont les plus précises
    }

    const picks = [];
    const skipped = { leading: 0, tooExpensive: 0, noRef: 0 };
    for (const list of groups.values()) {
      const isMineBid = (a) => myById.has(a.id) || a.watch?.bid;
      const leading = list.filter((a) => a.isLeading);
      const cap = leading.length ? Math.min(...leading.map(currentOf)) : Infinity;

      const ok = list
        .filter((a) => {
          const end = new Date(a.endsAt).getTime();
          return a.status === 'active' && !a.isMine && !a.isLeading && !isExcluded(a.seller) && end > now + 15000 && end <= deadline;
        })
        .filter((a) => CONFIG.INCLUDE_REVERSE || !a.reverse)
        .map((a) => ({ a, ref: refPrice(a) }));
      if (!ok.length) { if (leading.length) skipped.leading++; continue; }
      if (ok.every((x) => !x.ref)) { skipped.noRef++; continue; }
      let good = ok.filter((x) => x.ref && x.a.minBid <= x.ref.value)
        .sort((x, y) => x.a.minBid - y.a.minBid || new Date(x.a.endsAt) - new Date(y.a.endsAt));
      if (leading.length) {
        good = good.filter((x) => x.a.minBid < cap);
        if (!good.length) { skipped.leading++; continue; }
        good[0].cheaperThan = cap;
      }
      if (!good.length) { skipped.tooExpensive++; continue; }
      if (isMineBid(good[0].a)) good[0].rebid = true;
      picks.push(good[0]);
    }
    // Les ventes qui se terminent le plus tôt d'abord (budget rempli dans cet ordre)
    picks.sort((x, y) => new Date(x.a.endsAt) - new Date(y.a.endsAt) || x.a.minBid - y.a.minBid);
    const chosen = [];
    let total = 0;
    for (const p of picks) {
      if (total + p.a.minBid > budget) continue;
      chosen.push(p);
      total += p.a.minBid;
    }
    return { chosen, total, candidates: picks.length, skipped };
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
  const toast = (html, ms = 15000, kind = 'success') => UI.toast(html, { ms, kind });
  const label = (a) => `${esc(a.card.name)}${a.reverse ? ' <i>(reverse)</i>' : ''} <small>(${esc(a.card.setName)})</small>`;

  let busy = false, progress = '';
  async function run() {
    if (busy) return;
    busy = true; progress = 'Analyse…'; paint();
    try {
      const sets = await api('GET', '/sets');
      const fav = sets.filter((s) => s.favorite).map((s) => s.id);
      if (!fav.length) { toast('Aucune série en favori.', 6000, 'info'); return; }

      const { me } = await api('GET', '/me');
      const budget = Math.min(CONFIG.BUDGET, me.balance ?? 0);
      const [auctions, myBids] = await Promise.all([fetchMarket(fav), fetchMyBids()]);
      const { chosen, total, candidates, skipped } = plan(auctions, budget, myBids);

      if (!chosen.length) {
        toast(`Rien à enchérir.<br><small>${auctions.length} ventes examinées · ${skipped.tooExpensive} carte(s) au-dessus de la moyenne · ${skipped.leading} déjà misée(s)</small>`, 8000, 'info');
        return;
      }

      const mins = (a) => Math.max(0, Math.round((new Date(a.endsAt) - Date.now()) / 60000));
      const planText = chosen.map(({ a, ref, cheaperThan, rebid }) => `${rebid ? '↻ relance · ' : ''}${a.card.name}${a.reverse ? ' (reverse)' : ''} : ${a.minBid} (${ref.kind} ${ref.value}) · fin ${mins(a)} min${cheaperThan != null ? ` · moins cher que ta vente en cours (${cheaperThan})` : ''}`).join('\n');
      if (CONFIG.DRY_RUN) {
        toast(`<b>Test à blanc : ${chosen.length} enchère(s), ${total} pièces</b><br>` +
          chosen.map(({ a, ref }) => `• ${label(a)} — ${a.minBid} <small>(${ref.kind} ${ref.value})</small>`).join('<br>') +
          `<br><br><small>${candidates} carte(s) éligibles · ${skipped.tooExpensive} au-dessus de la moyenne · ${skipped.leading} déjà misée(s)</small>`, 0, 'info');
        return;
      }
      if (CONFIG.CONFIRM && !confirm(`Enchérir sur ${chosen.length} carte(s) manquante(s) pour ${total} pièces ?\n\n${planText}`)) return;

      const ok = [];
      const ko = [];
      for (const [i, p] of chosen.entries()) {
        progress = `${i + 1}/${chosen.length}`; paint();
        try {
          await api('POST', `/market/${p.a.id}/bid`, { amount: p.a.minBid });
          ok.push(p);
        } catch (e) {
          ko.push({ ...p, reason: e.message });
        }
        await sleep(CONFIG.DELAY);
      }
      const spent = ok.reduce((s, p) => s + p.a.minBid, 0);
      toast(`<b>${ok.length} enchère(s) placée(s) · ${spent} pièces</b><br>` +
        ok.map(({ a }) => `• ${label(a)} — ${a.minBid}`).join('<br>') +
        (ko.length ? `<br><br><b>Échecs :</b><br>${ko.map((p) => `✗ ${label(p.a)} : ${esc(p.reason)}`).join('<br>')}` : ''), 15000, ok.length ? 'success' : 'error');
    } catch (e) {
      toast(`Erreur : ${esc(e.message)}`, 8000, 'error');
    } finally {
      busy = false; progress = ''; paint();
    }
  }

  // ───────── Bouton du dock (Marché) ─────────
  function paint() {
    if (!location.pathname.startsWith('/marche')) { UI.removeButton('hp-buy-missing'); return; }
    UI.button('hp-buy-missing', {
      label: busy ? 'Enchères en cours…' : 'Enchérir sur mes manquantes',
      sub: busy ? progress : `Fin ≤ ${CONFIG.MAX_ENDS_IN_MINUTES} min · budget ${CONFIG.BUDGET}`,
      icon: 'target', kind: 'primary', order: 11, busy, disabled: busy, onClick: run,
    });
  }
  paint();
  setInterval(paint, 1000);
})();
