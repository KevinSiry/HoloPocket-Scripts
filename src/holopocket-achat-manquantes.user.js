// ==UserScript==
// @name         HoloPocket – Achat des cartes manquantes bradées
// @namespace    kevin.holopocket
// @version      1.4
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
    const team = await teamMembers();
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
      if (a.status !== 'active' || a.isMine || a.isLeading || a.seller === me.username || isExcluded(a.seller) || isExcluded(a.highestBidder) || inTeam(team, a.seller) || inTeam(team, a.highestBidder)) return false; // un coéquipier est déjà en tête : on ne surenchérit pas
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

/*__HPUI_KIT__*/

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
