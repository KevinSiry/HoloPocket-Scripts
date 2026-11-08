// ==UserScript==
// @name         HoloPocket – Achat-revente intelligent
// @namespace    kevin.holopocket
// @version      1.10
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-achat-revente.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-achat-revente.user.js
// @description  Mode auto : enchérit sur les ventes qui se terminent dans moins de 5 min quand la carte part bien en dessous de sa valeur réelle, garde les cartes qui manquaient à ta collection et remet les autres en vente avec une marge.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    // Achat
    MAX_ENDS_IN_MIN: 5,      // seulement les ventes qui se terminent dans moins de 5 min
    MIN_MARGIN: 0.30,        // marge nette minimale visée : revente (après taxe) ≥ prix d'achat + 30 %
    MIN_PROFIT: 15,          // et au moins 15 pièces de bénéfice net par carte
    MIN_SALES: 5,            // la carte doit s'être vendue au moins 5 fois sur 7 jours (prix fiable, revente facile)
    RESERVE: 100,            // pièces jamais engagées
    MAX_ENGAGED: 1500,       // total maximum engagé en même temps dans des enchères
    MAX_BIDS_PER_PASS: 10,   // nouvelles enchères au plus par passage
    // Revente
    RESALE_MARGIN: 0.10,     // prix de départ minimal = achat + 10 % net, après taxe
    SALE_MINUTES: 30,        // durée de la remise en vente (minimum du site)
    MAX_TRIES: 3,            // après 3 ventes sans acheteur, départ au prix de revient
    TAX: 0.05,               // taxe du site sur le prix final
    // Divers
    POLL_S: 15,              // un passage toutes les 15 s quand le mode auto est actif
    PRICE_CACHE_MIN: 10,     // les prix d'une carte sont relus au plus toutes les 10 min
    MAX_PAGES: 15,
    DELAY: 250,
    DRY_RUN: false,          // true = affiche ce qui serait fait, sans enchérir ni vendre
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Joueurs à ne jamais solliciter (ex. ton autre compte) : localStorage 'hp-excluded-players' = ["pseudo", …]
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
  // Équipe du site (GET /team) : on ne vend pas, n'achète pas et ne surenchérit pas avec ses membres. Relue toutes les 10 min.
  let teamCache = { at: 0, set: new Set() };
  async function teamMembers() {
    if (Date.now() - teamCache.at < 600000) return teamCache.set;
    try {
      const t = await api('GET', '/team');
      teamCache = { at: Date.now(), set: new Set(((t.team && t.team.members) || []).map((m) => String(m.username).toLowerCase())) };
    } catch { teamCache.at = Date.now() - 540000; } // illisible : on garde la liste connue, nouvel essai dans 1 min
    return teamCache.set;
  }
  const inTeam = (set, u) => !!u && set.has(String(u).toLowerCase());
  // Marché refusé (compte récent : restrictions des premières 24 h, etc.) : pause partagée entre les scripts de vente et d'achat
  const BLOCK_KEY = 'hp-market-blocked-until';
  const RESTRICTED = /nouveau|r[ée]cent|restreint|interdit|bloqu|pas encore|avant de pouvoir|\b24\s*h|^403\b/i;
  const blockedUntil = () => { try { return +localStorage.getItem(BLOCK_KEY) || 0; } catch { return 0; } };
  const blockMarket = (min) => { try { localStorage.setItem(BLOCK_KEY, String(Math.max(blockedUntil(), Date.now() + min * 60000))); } catch {} };
  let refusals = 0; // refus d'affilée pour une autre raison
  const arr = (d) => (Array.isArray(d) ? d : d.auctions || d.entries || []);
  const keyOf = (cardId, reverse) => `${cardId}|${!!reverse}`;
  const net = (p) => Math.floor(p * (1 - CONFIG.TAX));

  // ───────── État persistant ─────────
  const STATE_KEY = 'hp-flip-state';
  const RESERVED_KEY = 'hp-flip-reserved'; // lu par les scripts Vente, Recyclage et Échanges
  const AUTO_KEY = 'hp-flip-auto-on';
  const LOCK_KEY = 'hp-flip-lock';
  const ESCROW_KEY = 'hp-flip-escrow';
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch {}
    s = s || {};
    s.tracked = s.tracked || {};   // id de vente → enchère suivie
    s.holdings = s.holdings || []; // cartes achetées à revendre
    s.stats = s.stats || { bought: 0, spent: 0, kept: 0, keptValue: 0, sold: 0, revenue: 0, soldCost: 0 };
    s.log = s.log || [];
    return s;
  }
  let S = load();
  function save() {
    try {
      S.log = S.log.slice(-60);
      localStorage.setItem(STATE_KEY, JSON.stringify(S));
      localStorage.setItem(RESERVED_KEY, JSON.stringify(S.holdings.map((h) => h.key)));
      // Places de marché dont j'ai besoin pour revendre : le script Vente les laisse libres
      localStorage.setItem('hp-flip-wait', JSON.stringify({ n: S.holdings.filter((h) => !h.auctionId).length, at: Date.now() }));
    } catch {}
  }
  const note = (text) => { S.log.push({ at: Date.now(), text }); };

  // ───────── Prix de référence d'une carte ─────────
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
        v = {
          ref: refs.length ? Math.min(...refs) : null, // la plus prudente des deux
          count: sample.count || 0,
          onSale: typeof x.onSale === 'number' ? x.onSale : Array.isArray(x.onSale) ? x.onSale.length : (x.onSale && x.onSale.count) || 0, // offres en vente en ce moment
          suggested: x.suggestedStart || null,
        };
      }
    } catch {}
    priceCache.set(k, { at: Date.now(), v });
    return v;
  }
  // Enchère maximale pour garder la marge voulue à la revente
  function maxBidFor(ref) {
    const n = net(ref);
    return Math.min(Math.floor(n / (1 + CONFIG.MIN_MARGIN)), n - CONFIG.MIN_PROFIT);
  }

  // Exemplaires d'une version (sur le site, copies et availableIds comptent aussi les reverses)
  function version(m, reverse) {
    const rev = new Set(m.availableReverseIds || []);
    return reverse
      ? { copies: m.reverseCopies || 0, listed: m.listedReverse || 0, ids: m.availableReverseIds || [] }
      : { copies: (m.copies || 0) - (m.reverseCopies || 0), listed: m.listed || 0, ids: (m.availableIds || []).filter((id) => !rev.has(id)) };
  }

  // ───────── 1) Bilan : enchères terminées et reventes ─────────
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
      if (a.status !== 'sold' || a.highestBidder !== me.username) continue;
      const price = a.currentPrice;
      S.stats.bought++; S.stats.spent += price;
      // Nouvelle carte pour la collection → on la garde. Sinon → revente avec marge.
      let copies = 0;
      try {
        const m = (await api('GET', `/cards/${encodeURIComponent(t.cardId)}`)).mine || {};
        copies = version(m, t.reverse).copies;
      } catch {}
      if (copies <= 1) {
        S.stats.kept++; S.stats.keptValue += t.ref || 0;
        note(`Gagnée et gardée (nouvelle carte) : ${t.name} pour ${price}`);
        UI.toast(`<b>Achat-revente</b> : ${esc(t.name)}${t.reverse ? ' (reverse)' : ''} achetée ${price} — nouvelle carte, ajoutée à ta collection`, { kind: 'success', ms: 10000 });
      } else {
        S.holdings.push({ key: keyOf(t.cardId, t.reverse), cardId: t.cardId, reverse: !!t.reverse, name: t.name, cost: price, ref: t.ref, tries: 0, auctionId: null, at: now });
        note(`Gagnée pour revente : ${t.name} pour ${price} (valeur ${t.ref})`);
        UI.toast(`<b>Achat-revente</b> : ${esc(t.name)}${t.reverse ? ' (reverse)' : ''} achetée ${price} (valeur ${t.ref}) — remise en vente`, { kind: 'success', ms: 10000 });
      }
      await sleep(CONFIG.DELAY);
    }
    // Reventes en cours
    for (const h of S.holdings.slice()) {
      if (!h.auctionId) continue;
      let a;
      try { a = (await api('GET', `/market/${h.auctionId}`)).auction; } catch { continue; }
      if (!a || a.status === 'active') continue;
      if (a.status === 'sold') {
        const got = net(a.currentPrice);
        S.stats.sold++; S.stats.revenue += got; S.stats.soldCost += h.cost;
        S.holdings.splice(S.holdings.indexOf(h), 1);
        note(`Revendue : ${h.name} ${a.currentPrice} (achat ${h.cost}, ${got - h.cost >= 0 ? '+' : ''}${got - h.cost})`);
        UI.toast(`<b>Achat-revente</b> : ${esc(h.name)} revendue ${a.currentPrice} · bénéfice ${got - h.cost >= 0 ? '+' : ''}${got - h.cost}`, { kind: 'success', ms: 10000 });
      } else {
        h.auctionId = null; h.tries++; // pas d'acheteur ou annulée : on la remet en vente
      }
      await sleep(CONFIG.DELAY);
    }
  }

  // ───────── 2) Remise en vente des cartes achetées ─────────
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
  async function relist() {
    const todo = S.holdings.filter((h) => !h.auctionId);
    if (!todo.length) return;
    const promised = await promisedIds();
    if (!promised) return; // échanges en attente illisibles : on ne vend rien ce tour-ci
    let counts;
    try { counts = await api('GET', '/market/counts'); } catch { return; }
    let free = (counts.maxSelling ?? 0) - (counts.selling ?? 0);
    for (const h of todo) {
      if (free <= 0) break;
      let m;
      try { m = (await api('GET', `/cards/${encodeURIComponent(h.cardId)}`)).mine || {}; } catch { continue; }
      const { copies, listed, ids: allIds } = version(m, h.reverse);
      const ids = allIds.filter((id) => !promised.has(id)); // pas les exemplaires promis dans un échange en attente
      const promisedN = allIds.length - ids.length;
      if (copies - listed - promisedN <= 1) {
        if (copies - listed > 1) continue; // un exemplaire est promis dans un échange : on attend sa réponse
        // La carte n'est plus en double (échangée, recyclée…) → on la garde
        S.holdings.splice(S.holdings.indexOf(h), 1); note(`${h.name} : plus de doublon, gardée`); continue;
      }
      if (!ids.length) continue; // pas encore disponible : au prochain passage
      const info = await marketInfo(h.cardId, h.reverse);
      const floorMargin = Math.ceil((h.cost * (1 + CONFIG.RESALE_MARGIN)) / (1 - CONFIG.TAX));
      const breakEven = Math.ceil(h.cost / (1 - CONFIG.TAX)) + 1;
      const suggested = (info && info.suggested) || 0;
      // Départ cohérent avec le marché (prix conseillé), jamais sous la marge minimale
      const price = h.tries >= CONFIG.MAX_TRIES ? Math.max(breakEven, Math.floor(suggested * 0.9)) : Math.max(floorMargin, suggested);
      if (CONFIG.DRY_RUN) { note(`[test] remise en vente de ${h.name} à ${price}`); continue; }
      try {
        const d = await api('POST', '/market', { userCardId: ids[0], startPrice: price, durationMinutes: CONFIG.SALE_MINUTES });
        let id = (d.auction && d.auction.id) ?? d.id ?? null;
        if (id == null) {
          const mine = arr(await api('GET', '/market/mine/selling')).filter((a) => a.status === 'active' && keyOf(a.card?.id ?? a.cardId, a.reverse) === h.key);
          mine.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
          id = mine[0] ? mine[0].id : null;
        }
        h.auctionId = id; h.price = price; free--;
        save();
        note(`Remise en vente : ${h.name} à ${price} (achat ${h.cost})`);
      } catch (e) {
        note(`Vente impossible pour ${h.name} : ${e.message}`);
        if (RESTRICTED.test(e.message)) { blockMarket(60); note('Marché restreint : pause de 1 h'); break; }
      }
      await sleep(CONFIG.DELAY);
    }
  }

  // ───────── 3) Achat : ventes qui se terminent dans moins de 5 min ─────────
  async function buy() {
    const team = await teamMembers();
    const now = Date.now();
    const deadline = now + CONFIG.MAX_ENDS_IN_MIN * 60000;
    // Ventes qui se terminent bientôt (tri par fin la plus proche)
    const auctions = [];
    for (let page = 1; page <= CONFIG.MAX_PAGES; page++) {
      const d = await api('GET', `/market?sort=ending&page=${page}`);
      const list = d.auctions || [];
      auctions.push(...list);
      if (!list.length || Date.parse(list[list.length - 1].endsAt) > deadline || page * (d.pageSize || 24) >= d.total) break;
      await sleep(CONFIG.DELAY / 2);
    }
    // Mes enchères en cours : argent engagé, cartes déjà visées
    const myBids = arr(await api('GET', '/market/mine/bidding').catch(() => [])).filter((a) => !a.status || a.status === 'active');
    const leading = myBids.filter((a) => a.isLeading);
    const engaged = leading.reduce((s, a) => s + (a.currentPrice || 0), 0);
    const leadKeys = new Set(leading.map((a) => keyOf(a.card?.id ?? a.cardId, a.reverse)));
    const escrow = (() => { try { return localStorage.getItem(ESCROW_KEY) === '1'; } catch { return false; } })();
    const freeBal = (me.balance || 0) - (escrow ? 0 : engaged);
    let budget = Math.min(CONFIG.MAX_ENGAGED - engaged, freeBal - CONFIG.RESERVE);
    status.engaged = engaged; status.bids = leading.length;
    if (budget <= 0) return;

    // Premier tri sans requête : valeur affichée sur la vente
    const pre = auctions.filter((a) => {
      const end = Date.parse(a.endsAt);
      if (a.status !== 'active' || a.isMine || a.isLeading || a.seller === me.username || isExcluded(a.seller) || isExcluded(a.highestBidder) || inTeam(team, a.seller) || inTeam(team, a.highestBidder)) return false; // jamais d'achat à un joueur exclu, ni de surenchère sur un coéquipier en tête
      if (end <= now + 10000 || end > deadline) return false;
      if (leadKeys.has(keyOf(a.card.id, a.reverse))) return false; // une seule enchère gagnante par carte
      const shown = a.reverse ? a.card.reverseMarketValue : a.card.marketValue;
      return shown > 0 && a.minBid <= maxBidFor(shown);
    });
    // Vérification avec l'historique des ventes de la carte
    const picks = [];
    for (const a of pre) {
      const info = await marketInfo(a.card.id, a.reverse);
      if (!info || !info.ref || info.count < CONFIG.MIN_SALES) continue;
      if (info.onSale > info.count) continue; // trop d'offres pour la demande : revente difficile
      const max = maxBidFor(info.ref);
      if (a.minBid > max) continue;
      picks.push({ a, ref: info.ref, max, profit: net(info.ref) - a.minBid });
    }
    // Meilleur bénéfice d'abord
    picks.sort((x, y) => y.profit - x.profit || x.a.minBid - y.a.minBid);
    const seen = new Set(leadKeys);
    let placed = 0;
    for (const p of picks) {
      if (placed >= CONFIG.MAX_BIDS_PER_PASS) break;
      const k = keyOf(p.a.card.id, p.a.reverse);
      if (seen.has(k) || p.a.minBid > budget) continue;
      seen.add(k);
      const name = `${p.a.card.name}${p.a.reverse ? ' (reverse)' : ''}`;
      if (CONFIG.DRY_RUN) { note(`[test] enchère ${p.a.minBid} sur ${name} (valeur ${p.ref}, max ${p.max})`); continue; }
      const before = me.balance;
      try {
        await api('POST', `/market/${p.a.id}/bid`, { amount: p.a.minBid });
        placed++; budget -= p.a.minBid;
        S.tracked[p.a.id] = { cardId: p.a.card.id, reverse: !!p.a.reverse, name, ref: p.ref, max: p.max, endsAt: p.a.endsAt, bid: p.a.minBid };
        note(`Enchère ${p.a.minBid} sur ${name} (valeur ${p.ref})`);
        save(); // enregistré tout de suite : rien n'est perdu si la page est rechargée
        // Le site bloque-t-il les pièces pendant l'enchère ? (détecté une fois pour toutes)
        try {
          if (localStorage.getItem(ESCROW_KEY) == null) {
            me = (await api('GET', '/me')).me;
            localStorage.setItem(ESCROW_KEY, before - me.balance >= p.a.minBid - 1 ? '1' : '0');
          }
        } catch {}
        refusals = 0;
      } catch (e) {
        note(`Enchère refusée sur ${name} : ${e.message}`);
        if (RESTRICTED.test(e.message)) { blockMarket(60); note('Marché restreint : pause de 1 h'); break; }
        if (++refusals >= 3) { blockMarket(15); refusals = 0; note('Enchères refusées à la suite : pause de 15 min'); break; }
      }
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
    let beatErr = null;
    try {
      S = load(); // un autre onglet a pu modifier l'état
      me = (await api('GET', '/me')).me;
      await settle(); save();
      if (Date.now() >= blockedUntil()) { await relist(); save(); await buy(); save(); }
    } catch (e) {
      beatErr = e.message; note(`Erreur : ${e.message}`); save();
    } finally {
      // Signe de vie lu par le panel : dernier passage terminé et son erreur éventuelle
      try { localStorage.setItem('hp-flip-beat', JSON.stringify({ at: Date.now(), err: beatErr })); } catch {}
      busy = false; releaseLock(); paint();
      if (UI.hasPanel(PANEL)) renderPanel();
    }
  }

  const profit = () => S.stats.revenue - S.stats.soldCost;
  const sign = (n) => `${n >= 0 ? '+' : ''}${n}`;

  // ───────── Panneau de suivi (page Marché) ─────────
  const PANEL = 'hp-flip-panel';
  function renderPanel() {
    const body = UI.panel(PANEL, { title: 'Achat-revente', order: 23, closable: true, onClose: paint });
    const st = S.stats;
    const tracked = Object.values(S.tracked);
    const row = (a, b) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:2px 0"><span class="hp-muted">${a}</span><b>${b}</b></div>`;
    body.innerHTML = `
      ${row('Bénéfice réalisé', sign(profit()))}
      ${row('Cartes achetées', `${st.bought} · ${st.spent} pièces`)}
      ${row('Gardées (nouvelles cartes)', `${st.kept} · valeur ≈ ${st.keptValue}`)}
      ${row('Revendues', `${st.sold} · ${st.revenue} pièces nettes`)}
      ${row('Enchères en tête', `${status.bids} · ${status.engaged} pièces engagées`)}
      <div style="margin-top:10px;font-weight:700;font-size:13px">À revendre (${S.holdings.length})</div>
      ${S.holdings.map((h) => `<div style="font-size:12.5px;padding:2px 0">${esc(h.name)}${h.reverse ? ' <i>(reverse)</i>' : ''} — achat ${h.cost} · valeur ${h.ref}${h.auctionId ? ` · en vente ${h.price}` : ' · en attente d’une place'}</div>`).join('') || '<div class="hp-muted" style="font-size:12.5px">Aucune</div>'}
      <div style="margin-top:10px;font-weight:700;font-size:13px">Enchères suivies (${tracked.length})</div>
      ${tracked.map((t) => `<div style="font-size:12.5px;padding:2px 0">${esc(t.name)} — mise ${t.bid} · max ${t.max} · valeur ${t.ref}</div>`).join('') || '<div class="hp-muted" style="font-size:12.5px">Aucune</div>'}
      <div style="margin-top:10px;font-weight:700;font-size:13px">Journal</div>
      <div style="max-height:180px;overflow:auto;font-size:12px" class="hp-muted">${S.log.slice().reverse().slice(0, 25).map((l) => `<div>${new Date(l.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${esc(l.text)}</div>`).join('') || 'Rien pour l’instant'}</div>
      <div class="hp-muted" style="font-size:11.5px;margin-top:10px">Ventes finissant dans ${CONFIG.MAX_ENDS_IN_MIN} min max · marge nette ≥ ${Math.round(CONFIG.MIN_MARGIN * 100)} % et ≥ ${CONFIG.MIN_PROFIT} pièces · réserve ${CONFIG.RESERVE} · ${CONFIG.MAX_ENGAGED} engagées max${CONFIG.DRY_RUN ? ' · <b>TEST À BLANC</b>' : ''}</div>`;
  }

  function paint() {
    const sub = !autoOn ? 'Désactivé' : `${status.bids} en tête · ${status.engaged} engagées · ${sign(profit())}`;
    UI.button('hp-flip-auto', {
      label: 'Achat-revente', sub, icon: 'coins', kind: 'toggle', on: autoOn, order: 94, busy: busy && autoOn,
      title: 'Enchérit sur les cartes bradées (fin < 5 min) et les revend avec une marge',
      onClick: () => {
        autoOn = !autoOn;
        try { localStorage.setItem(AUTO_KEY, autoOn ? '1' : '0'); } catch {}
        paint();
        if (autoOn) tick();
      },
    });
    if (!location.pathname.startsWith('/marche')) { UI.removeButton('hp-flip-open'); UI.removePanel(PANEL); return; }
    const open = UI.hasPanel(PANEL);
    UI.button('hp-flip-open', {
      label: 'Suivi achat-revente', sub: `${S.holdings.length} à revendre · ${open ? 'masquer' : 'afficher'}`, icon: 'coins', kind: 'secondary', order: 15,
      onClick: () => { if (UI.hasPanel(PANEL)) { UI.removePanel(PANEL); paint(); } else renderPanel(); },
    });
  }

  paint();
  setInterval(paint, 2000);
  setInterval(tick, CONFIG.POLL_S * 1000);
  if (autoOn) setTimeout(tick, 3000);
  addEventListener('beforeunload', () => { if (busy) releaseLock(); });
})();
