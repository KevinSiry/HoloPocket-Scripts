// ==UserScript==
// @name         HoloPocket – Achat des cartes manquantes bradées
// @namespace    kevin.holopocket
// @version      1.3
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-achat-manquantes.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-achat-manquantes.user.js
// @description  Mode auto : enchérit (mise minimale) sur les ventes qui se terminent dans moins de 5 min quand la carte te manque et qu'elle part à 70 % du prix moyen ou moins. N'achète rien pour revendre.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    MAX_ENDS_IN_MIN: 5,      // seulement les ventes qui se terminent dans moins de 5 min
    MAX_PRICE_RATIO: 0.70,   // mise maximale : 70 % du prix moyen de la carte
    MIN_SALES: 3,            // la carte doit s'être vendue au moins 3 fois sur 7 jours (prix moyen fiable)
    RESERVE: 0,              // pièces jamais engagées (0 = tout le solde peut servir)
    MAX_ENGAGED: Infinity,   // pas de plafond : seul le solde limite
    MAX_BIDS_PER_PASS: 10,
    INCLUDE_REVERSE: true,   // viser aussi les versions reverse manquantes
    POLL_S: 15,
    PRICE_CACHE_MIN: 10,
    OWNED_CACHE_S: 60,
    MAX_PAGES: 15,
    DELAY: 250,
    DRY_RUN: false,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const excludedPlayers = () => { try { return new Set(JSON.parse(localStorage.getItem('hp-excluded-players') || '[]').map((x) => String(x).toLowerCase())); } catch { return new Set(); } };
  const isExcluded = (u) => !!u && excludedPlayers().has(String(u).toLowerCase());
  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `${res.status} ${data.error || ''}`.trim());
    return data;
  }
  const arr = (d) => (Array.isArray(d) ? d : d.auctions || d.entries || []);
  const keyOf = (cardId, reverse) => `${cardId}|${!!reverse}`;

  // ───────── État persistant ─────────
  const STATE_KEY = 'hp-miss-state';
  const AUTO_KEY = 'hp-miss-auto-on';
  const LOCK_KEY = 'hp-miss-lock';
  const ESCROW_KEY = 'hp-flip-escrow'; // même site, même règle : partagé avec Achat-revente
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch {}
    s = s || {};
    s.tracked = s.tracked || {};
    s.stats = s.stats || { won: 0, spent: 0, saved: 0, lost: 0 };
    s.log = s.log || [];
    return s;
  }
  let S = load();
  function save() {
    try { S.log = S.log.slice(-60); localStorage.setItem(STATE_KEY, JSON.stringify(S)); } catch {}
  }
  const note = (text) => { S.log.push({ at: Date.now(), text }); };

  // ───────── Prix moyen d'une carte ─────────
  const priceCache = new Map();
  async function marketInfo(cardId, reverse) {
    const k = keyOf(cardId, reverse);
    const c = priceCache.get(k);
    if (c && Date.now() - c.at < CONFIG.PRICE_CACHE_MIN * 60000) return c.v;
    let v = null;
    try {
      const m = await api('GET', `/cards/${encodeURIComponent(cardId)}/market`);
      const x = (m.versions || []).find((y) => !!y.reverse === !!reverse);
      if (x && x.stats) {
        const st = x.stats, sample = st.sample || {};
        const refs = [st.value, sample.average].filter((n) => typeof n === 'number' && n > 0);
        v = { ref: refs.length ? Math.min(...refs) : null, count: sample.count || 0 }; // la plus prudente des deux
      }
    } catch {}
    priceCache.set(k, { at: Date.now(), v });
    return v;
  }
  const maxBidFor = (ref) => Math.floor(ref * CONFIG.MAX_PRICE_RATIO);

  // Exemplaires possédés de cette version (les copies du site comptent aussi les reverses)
  const ownedCache = new Map();
  async function ownedCopies(cardId, reverse) {
    const k = keyOf(cardId, reverse);
    const c = ownedCache.get(k);
    if (c && Date.now() - c.at < CONFIG.OWNED_CACHE_S * 1000) return c.n;
    const m = (await api('GET', `/cards/${encodeURIComponent(cardId)}`)).mine || {};
    const n = reverse ? (m.reverseCopies || 0) : (m.copies || 0) - (m.reverseCopies || 0);
    ownedCache.set(k, { at: Date.now(), n });
    return n;
  }

  // ───────── 1) Bilan : enchères terminées ─────────
  let me = null;
  async function settle() {
    const now = Date.now();
    for (const [id, t] of Object.entries(S.tracked)) {
      if (now < Date.parse(t.endsAt) + 8000) continue;
      let a;
      try { a = (await api('GET', `/market/${id}`)).auction; } catch { continue; }
      if (!a) { delete S.tracked[id]; continue; }
      if (a.status === 'active') { t.endsAt = a.endsAt; continue; }
      delete S.tracked[id];
      ownedCache.delete(keyOf(t.cardId, t.reverse));
      if (a.status === 'sold' && a.highestBidder === me.username) {
        S.stats.won++; S.stats.spent += a.currentPrice; S.stats.saved += Math.max(0, (t.ref || 0) - a.currentPrice);
        note(`Gagnée : ${t.name} pour ${a.currentPrice} (prix moyen ${t.ref})`);
        UI.toast(`<b>Cartes manquantes</b> : ${esc(t.name)} gagnée pour ${a.currentPrice} (prix moyen ${t.ref}) — nouvelle carte`, { kind: 'success', ms: 10000 });
      } else { S.stats.lost++; note(`Perdue : ${t.name}`); }
      await sleep(CONFIG.DELAY);
    }
  }

  // ───────── 2) Achat ─────────
  async function buy() {
    const now = Date.now();
    const deadline = now + CONFIG.MAX_ENDS_IN_MIN * 60000;
    const auctions = [];
    for (let page = 1; page <= CONFIG.MAX_PAGES; page++) {
      const d = await api('GET', `/market?sort=ending&page=${page}`);
      const list = d.auctions || [];
      auctions.push(...list);
      if (!list.length || Date.parse(list[list.length - 1].endsAt) > deadline || page * (d.pageSize || 24) >= d.total) break;
      await sleep(CONFIG.DELAY / 2);
    }
    const myBids = arr(await api('GET', '/market/mine/bidding').catch(() => [])).filter((a) => !a.status || a.status === 'active');
    const leading = myBids.filter((a) => a.isLeading);
    const engaged = leading.reduce((s, a) => s + (a.currentPrice || 0), 0);
    const leadKeys = new Set(leading.map((a) => keyOf(a.card?.id ?? a.cardId, a.reverse)));
    // Une carte déjà visée par une enchère que je suis (même si on m'a surenchéri, ou si le site n'affiche pas encore ma mise) :
    // aucune autre vente de cette carte, seule cette enchère-là peut être relancée.
    const aimedAt = new Map(Object.entries(S.tracked).map(([id, t]) => [keyOf(t.cardId, t.reverse), String(id)]));
    for (const a of myBids) aimedAt.set(keyOf(a.card?.id ?? a.cardId, a.reverse), String(a.id));
    const escrow = (() => { try { return localStorage.getItem(ESCROW_KEY) === '1'; } catch { return false; } })();
    const freeBal = (me.balance || 0) - (escrow ? 0 : engaged);
    let budget = Math.min(CONFIG.MAX_ENGAGED - engaged, freeBal - CONFIG.RESERVE);
    status.engaged = engaged; status.bids = leading.length;
    if (budget <= 0) return;

    // Tri sans requête : fin proche, pas à moi, pas à un joueur exclu, mise minimale déjà sous 50 % de la valeur affichée
    const pre = auctions.filter((a) => {
      const end = Date.parse(a.endsAt);
      if (a.status !== 'active' || a.isMine || a.isLeading || a.seller === me.username || isExcluded(a.seller) || isExcluded(a.highestBidder)) return false; // un coéquipier est déjà en tête : on ne surenchérit pas
      if (end <= now + 10000 || end > deadline) return false;
      if (a.reverse && !CONFIG.INCLUDE_REVERSE) return false;
      if (leadKeys.has(keyOf(a.card.id, a.reverse))) return false;
      const aim = aimedAt.get(keyOf(a.card.id, a.reverse));
      if (aim && aim !== String(a.id)) return false; // déjà une enchère sur cette carte ailleurs
      const shown = a.reverse ? a.card.reverseMarketValue : a.card.marketValue;
      return shown > 0 && a.minBid <= maxBidFor(shown);
    });
    // Prix moyen vérifié sur l'historique, puis « la carte me manque ? » (en dernier : une requête par candidate)
    const picks = [];
    for (const a of pre) {
      const info = await marketInfo(a.card.id, a.reverse);
      if (!info || !info.ref || info.count < CONFIG.MIN_SALES) continue;
      const max = maxBidFor(info.ref);
      if (a.minBid > max || a.minBid > budget) continue;
      try { if ((await ownedCopies(a.card.id, a.reverse)) > 0) continue; } catch { continue; }
      picks.push({ a, ref: info.ref, max, saving: info.ref - a.minBid });
    }
    picks.sort((x, y) => y.saving - x.saving || x.a.minBid - y.a.minBid);
    const seen = new Set([...leadKeys, ...[...aimedAt.keys()].filter((k) => !picks.some((p) => keyOf(p.a.card.id, p.a.reverse) === k && String(p.a.id) === aimedAt.get(k)))]);
    let placed = 0;
    for (const p of picks) {
      if (placed >= CONFIG.MAX_BIDS_PER_PASS) break;
      const k = keyOf(p.a.card.id, p.a.reverse);
      if (seen.has(k) || p.a.minBid > budget) continue;
      seen.add(k);
      const name = `${p.a.card.name}${p.a.reverse ? ' (reverse)' : ''}`;
      if (CONFIG.DRY_RUN) { note(`[test] enchère ${p.a.minBid} sur ${name} (prix moyen ${p.ref})`); continue; }
      const before = me.balance;
      try {
        await api('POST', `/market/${p.a.id}/bid`, { amount: p.a.minBid });
        placed++; budget -= p.a.minBid;
        S.tracked[p.a.id] = { cardId: p.a.card.id, reverse: !!p.a.reverse, name, ref: p.ref, max: p.max, endsAt: p.a.endsAt, bid: p.a.minBid };
        note(`Enchère ${p.a.minBid} sur ${name} (prix moyen ${p.ref})`);
        save();
        try {
          if (localStorage.getItem(ESCROW_KEY) == null) {
            me = (await api('GET', '/me')).me;
            localStorage.setItem(ESCROW_KEY, before - me.balance >= p.a.minBid - 1 ? '1' : '0');
          }
        } catch {}
      } catch (e) { note(`Enchère refusée sur ${name} : ${e.message}`); }
      await sleep(CONFIG.DELAY);
    }
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
  let autoOn = false;
  try { autoOn = localStorage.getItem(AUTO_KEY) === '1'; } catch {}
  let busy = false;
  const status = { engaged: 0, bids: 0 };

  const takeLock = () => {
    try {
      const l = +localStorage.getItem(LOCK_KEY) || 0;
      if (Date.now() - l < 60000) return false;
      localStorage.setItem(LOCK_KEY, String(Date.now()));
      return true;
    } catch { return true; }
  };
  const releaseLock = () => { try { localStorage.removeItem(LOCK_KEY); } catch {} };

  async function tick() {
    if (!autoOn || busy || !takeLock()) return;
    busy = true;
    try {
      S = load();
      me = (await api('GET', '/me')).me;
      await settle(); save();
      await buy(); save();
    } catch (e) {
      note(`Erreur : ${e.message}`); save();
    } finally {
      busy = false; releaseLock(); paint();
      if (UI.hasPanel(PANEL)) renderPanel();
    }
  }

  // ───────── Panneau de suivi (page Marché) ─────────
  const PANEL = 'hp-miss-panel';
  function renderPanel() {
    const body = UI.panel(PANEL, { title: 'Cartes manquantes bradées', order: 24, closable: true, onClose: paint });
    const st = S.stats;
    const tracked = Object.values(S.tracked);
    const row = (a, b) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:2px 0"><span class="hp-muted">${a}</span><b>${b}</b></div>`;
    body.innerHTML = `
      ${row('Cartes gagnées', `${st.won} · ${st.spent} pièces`)}
      ${row('Économisé vs prix moyen', st.saved)}
      ${row('Enchères perdues', st.lost)}
      ${row('Enchères en tête', `${status.bids} · ${status.engaged} pièces engagées`)}
      <div style="margin-top:10px;font-weight:700;font-size:13px">Enchères suivies (${tracked.length})</div>
      ${tracked.map((t) => `<div style="font-size:12.5px;padding:2px 0">${esc(t.name)} — mise ${t.bid} · prix moyen ${t.ref}</div>`).join('') || '<div class="hp-muted" style="font-size:12.5px">Aucune</div>'}
      <div style="margin-top:10px;font-weight:700;font-size:13px">Journal</div>
      <div style="max-height:180px;overflow:auto;font-size:12px" class="hp-muted">${S.log.slice().reverse().slice(0, 25).map((l) => `<div>${new Date(l.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${esc(l.text)}</div>`).join('') || 'Rien pour l’instant'}</div>
      <div class="hp-muted" style="font-size:11.5px;margin-top:10px">Cartes que tu n'as pas · ventes finissant dans ${CONFIG.MAX_ENDS_IN_MIN} min max · mise ≤ ${Math.round(CONFIG.MAX_PRICE_RATIO * 100)} % du prix moyen · tout le solde disponible peut être engagé${CONFIG.DRY_RUN ? ' · <b>TEST À BLANC</b>' : ''}</div>`;
  }

  function paint() {
    const sub = !autoOn ? 'Désactivé' : `${status.bids} en tête · ${status.engaged} engagées · ${S.stats.won} gagnée${S.stats.won > 1 ? 's' : ''}`;
    UI.button('hp-miss-auto', {
      label: 'Cartes manquantes', sub, icon: 'coins', kind: 'toggle', on: autoOn, order: 95, busy: busy && autoOn,
      title: 'Enchérit sur les cartes qui te manquent quand elles partent à 70 % du prix moyen ou moins',
      onClick: () => {
        autoOn = !autoOn;
        try { localStorage.setItem(AUTO_KEY, autoOn ? '1' : '0'); } catch {}
        paint();
        if (autoOn) tick();
      },
    });
    if (!location.pathname.startsWith('/marche')) { UI.removeButton('hp-miss-open'); UI.removePanel(PANEL); return; }
    const open = UI.hasPanel(PANEL);
    UI.button('hp-miss-open', {
      label: 'Suivi cartes manquantes', sub: `${Object.keys(S.tracked).length} suivie${Object.keys(S.tracked).length > 1 ? 's' : ''} · ${open ? 'masquer' : 'afficher'}`, icon: 'coins', kind: 'secondary', order: 16,
      onClick: () => { if (UI.hasPanel(PANEL)) { UI.removePanel(PANEL); paint(); } else renderPanel(); },
    });
  }

  paint();
  setInterval(paint, 2000);
  setInterval(tick, CONFIG.POLL_S * 1000);
  if (autoOn) setTimeout(tick, 3000);
  addEventListener('beforeunload', () => { if (busy) releaseLock(); });
})();
