// ==UserScript==
// @name         HoloPocket – Échanges équitables
// @namespace    kevin.holopocket
// @version      3.21
// @description  Échanges équitables : doublons contre doublons de même rareté et même version, raretés hautes d'abord (complétés par des paires de valeur équivalente quand il y en a peu), avec complément en pièces demandé à l'autre joueur si ta carte vaut plus (jamais l'inverse). Joueur prioritaire optionnel (don de toutes tes cartes qu'il n'a pas, et des pièces du compte une fois par heure, même en un seul exemplaire, sauf cartes en vente). Pour tous les autres échanges : jamais le dernier exemplaire d'une carte, jamais une carte en vente. Mode automatique possible.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    TOL_PCT: 0.2,        // écart de valeur toléré par paire (20 %)…
    TOL_PCT_HIGH: 0.25,  // …25 % pour les cartes de plus de TOL_HIGH_FROM pièces
    TOL_HIGH_FROM: 50,
    ASK_COINS: true,     // même rareté mais ta carte vaut plus : il complète en pièces (jamais l'inverse)
    COIN_MAX_PCT: 1.0,   // ta carte peut valoir au plus 2× la sienne (+100 %) dans une paire compensée en pièces
    TOL_ABS: 2,          // …ou 2 pièces, le plus large des deux (utile pour les petites cartes)
    SAME_RARITY: true,   // exige le même niveau de rareté des deux côtés de chaque paire
    SAME_VERSION: true,  // et la même version : reverse contre reverse, normale contre normale
    CROSS_VALUE: true,       // peu de paires de même rareté avec un joueur : on complète par des paires de valeur équivalente, rareté ou version différente
    CROSS_WHEN_BELOW: 2,     // …seulement s'il y a moins de 2 paires de même rareté avec ce joueur
    CROSS_MAX_RANK_GAP: 2,   // …et au plus 2 niveaux de rareté d'écart entre les deux cartes
    // Anti-spam, par joueur ciblé
    PLAYER_COOLDOWN_H: 24,   // une seule proposition par joueur toutes les 24 h
    DECLINED_COOLDOWN_H: 72, // 3 jours si le joueur a refusé ta dernière proposition
    SILENT_COOLDOWN_H: 72,   // 3 jours si le joueur a laissé expirer ta proposition sans répondre (probablement inactif)
    SILENT_LONG_COOLDOWN_H: 168, // 7 jours à partir de la 2e proposition laissée sans réponse
    ACCEPTED_COOLDOWN_H: 1,  // seulement 1 h si le joueur a accepté ta dernière proposition
    CANCEL_AFTER_H: 5,       // une proposition sans réponse depuis 5 h est annulée automatiquement
    MIN_GAP_S: 0,            // délai minimum entre deux envois, en secondes (0 = aucun)
    MAX_PAIRS: 5,        // paires par proposition (10 cartes max au total, limite du site)
    MIN_PAIRS: 1,        // nombre minimum de paires pour proposer un échange (ex. 2 pour éviter les échanges à 1 carte)
    MAX_PARTNERS: 60,    // joueurs scannés par recherche
    MAX_WISH_CARDS: 80,   // au plus, de tes doublons consultés dans « Qui la recherche ? » (les plus chers d'abord)
    MAX_WISH_PARTNERS: 40, // joueurs qui recherchent tes doublons, scannés en premier
    MAX_HOLDER_CARDS: 80, // au plus, cartes manquantes consultées dans « Qui l'a en double ? » (s'arrête dès qu'il y a assez de nouveaux joueurs)
    SCAN_COOLDOWN_H: 24,  // un joueur scanné sans résultat n'est pas rescanné avant 24 h
    MAX_PROPOSALS: 8,    // propositions préparées par recherche
    FAVORITES_ONLY: false,   // false : toutes les séries (les favoris restent prioritaires) · true : séries en favori uniquement
    PRIORITY_MAX_CARDS: 10, // échange prioritaire : cartes données par envoi (10 = limite du site)
    PRIORITY_MAX_CHECK: 40, // …et fiches de cartes vérifiées au plus par passage
    PRIORITY_MATCH: true,   // …la cible rend des doublons de valeur équivalente (échange réciproque au lieu d'un don)
    PRIORITY_MATCH_TOL: 0.10, // …écart de valeur toléré entre les deux côtés (10 %, au moins TOL_ABS pièces)
    PRIORITY_COINS: false,  // …joint aussi les pièces du compte à l'échange : coupé, un transfert à sens unique de pièces est un signal fort pour le site
    PRIORITY_COINS_EVERY_MIN: 60, // …au plus une fois par heure
    PRIORITY_COINS_KEEP: 0, // …pièces laissées sur ce compte
    PRIORITY_COINS_MIN: 20, // …rien envoyé en dessous de ce solde (inutile de gaspiller un échange)
    PRIORITY_IDLE_MIN: 5,   // …rien à donner (ou cible fermée) : on ne rescanne pas avant 5 min, pour ménager l'API
    BLOCK_PAUSE_MIN: 60,    // le site refuse les échanges (compte récent…) : tout est suspendu 1 h
    FAIL_PAUSE_MIN: 30,     // 3 envois refusés d'affilée, quelle qu'en soit la raison : pause de 30 min
    MAX_OPEN_TRADES: 20, // limite du site : échanges en cours (propositions envoyées en attente)
    // Mode automatique
    AUTO_INTERVAL_MIN: 1,    // un passage toutes les minutes au plus (seulement s'il reste des places)
    AUTO_MAX_ROUNDS: 6,      // recherches successives au plus par passage, pour remplir toutes les places
    AUTO_SEND_DELAY_S: 3,    // petite pause entre deux envois automatiques
    DELAY: 200,          // pause entre deux joueurs scannés (ms)
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, window.__hp.jitter(ms, 0.3)));
  // Pauses mémorisées dans localStorage : elles survivent au rechargement de la page
  const lsNum = (k) => { try { return +localStorage.getItem(k) || 0; } catch { return 0; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };
  const BLOCKED_KEY = 'hp-trade-blocked-until', PRIORITY_NEXT_KEY = 'hp-priority-next', PRIORITY_COINS_KEY = 'hp-priority-coins-next';
  const isBlocked_ = () => Date.now() < lsNum(BLOCKED_KEY);
  // Refus du site qui ressemblent à une restriction du compte (compte récent, échanges interdits…)
  const BLOCK_RE = /nouveau|r[ée]cent|restreint|interdit|bloqu|pas encore|avant de pouvoir|\b24\s*h|^403\b/i;
  let failStreak = 0, blockToastAt = 0;
  // Un envoi vient d'échouer : suspend tous les échanges si le site refuse le compte, sans insister
  function noteSendFailure(e) {
    failStreak++;
    const restricted = BLOCK_RE.test(e.message);
    if (!restricted && failStreak < 3) return false;
    const min = restricted ? CONFIG.BLOCK_PAUSE_MIN : CONFIG.FAIL_PAUSE_MIN;
    lsSet(BLOCKED_KEY, Date.now() + min * 60000);
    failStreak = 0;
    if (Date.now() - blockToastAt > 30 * 60000) {
      blockToastAt = Date.now();
      UI.toast(`<b>Échanges suspendus ${min >= 60 ? '1 h' : `${min} min`}</b> : le site les refuse (${esc(e.message)}). Compte récent ?`, { kind: 'error', ms: 15000 });
    }
    return true;
  }
  // Cartes achetées par le script Achat-revente : il s'occupe lui-même de leur revente
  const flipReserved = () => { try { return new Set(JSON.parse(localStorage.getItem('hp-flip-reserved') || '[]')); } catch { return new Set(); } };
  // Joueurs à ne jamais solliciter (ex. ton autre compte) : localStorage 'hp-excluded-players' = ["pseudo", …]
  const excludedPlayers = () => { try { return new Set(JSON.parse(localStorage.getItem('hp-excluded-players') || '[]').map((x) => String(x).toLowerCase())); } catch { return new Set(); } };
  const isExcluded = (u) => !!u && excludedPlayers().has(String(u).toLowerCase());
  // Joueur prioritaire : localStorage 'hp-priority-target' = "pseudo" (HP_PRIORITY_TARGET du bot)
  const priorityTarget = () => { try { return (localStorage.getItem('hp-priority-target') || '').trim(); } catch { return ''; } };
  const isPriority = (u) => { const t = priorityTarget(); return !!t && !!u && String(u).toLowerCase() === t.toLowerCase(); };
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
  const list = (d) => (Array.isArray(d) ? d : d.entries || d.cards || []);
  const val = (c) => (c.reverse ? c.reverseMarketValue : c.marketValue) ?? (c.reverse ? c.reverseEstimate : c.estimate) ?? 0;
  const key = (c) => `${c.id}|${!!c.reverse}`;
  const inBinder = (c) => {
    const k = c.keptIn;
    if (!k) return false;
    if (Array.isArray(k)) return k.length > 0;
    return Object.values(k).some((v) => Array.isArray(v) ? v.length : v);
  };

  // ───────── Exemplaires réellement libres ─────────
  // Exemplaires promis dans un échange tout juste envoyé (le site met un moment à l'afficher) : partagé avec les scripts de vente
  const PROMISED_KEY = 'hp-trade-promised', PROMISED_TTL = 15 * 60000;
  const localPromised = () => { try { const now = Date.now(); return JSON.parse(localStorage.getItem(PROMISED_KEY) || '[]').filter((e) => now - e.at < PROMISED_TTL).map((e) => e.id); } catch { return []; } };
  const savePromised = (ids) => { try { const now = Date.now(); const keep = JSON.parse(localStorage.getItem(PROMISED_KEY) || '[]').filter((e) => now - e.at < PROMISED_TTL); localStorage.setItem(PROMISED_KEY, JSON.stringify([...keep, ...ids.map((id) => ({ id, at: now }))])); } catch {} };
  // Une carte retirée d'une proposition (dernier exemplaire, en vente…) n'est plus proposée pendant 30 min
  const BLOCK_MS = 30 * 60000;
  const blockedGive = new Map();
  const isBlocked = (k) => { const t = blockedGive.get(k); if (!t) return false; if (Date.now() - t > BLOCK_MS) { blockedGive.delete(k); return false; } return true; };
  // Lit la fiche de la carte (comme Recyclage et Achat-revente) : exemplaires possédés, en vente, déjà promis dans un échange.
  // spare = exemplaires qu'on peut donner en gardant `keep` exemplaire(s) (1 = toujours le dernier, 0 = échange prioritaire) ; ids = exemplaires non mis en vente
  async function freeInfo(c, log, keep = 1) {
    const m = (await api('GET', `/cards/${encodeURIComponent(c.id)}`)).mine || {};
    const rev = !!c.reverse;
    const revIds = new Set(m.availableReverseIds || []);
    const ids = rev ? (m.availableReverseIds || []) : (m.availableIds || []).filter((id) => !revIds.has(id));
    const owned = rev ? (m.reverseCopies || 0) : (m.copies || 0) - (m.reverseCopies || 0);
    const listed = rev ? (m.listedReverse || 0) : (m.listed || 0);
    const locked = !!(m.locked && (rev ? m.locked.reverse : m.locked.normal));
    const pset = (log && log.promisedIds) || new Set();
    const free = ids.filter((id) => !pset.has(id));      // ni en vente, ni promis dans un échange en attente
    const promised = ids.length - free.length;
    const spare = locked ? 0 : Math.max(0, Math.min(owned - listed - promised - keep, free.length));
    return { spare, ids: free, promised };
  }

  // ───────── Anti-spam ─────────
  // Journal local des envois (complète l'historique du site, qui peut avoir un léger retard)
  const LOG_KEY = 'hp-trade-sends';
  const readLocal = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } };
  const writeLocal = (arr) => { try { localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-200))); } catch {} };
  const H = 3600 * 1000;

  // Joueurs qui laissent expirer nos propositions (probablement inactifs) : { pseudo: { n, at } }.
  // La pause s'allonge à chaque proposition annulée sans réponse ; une réponse (acceptée ou refusée) la remet à zéro.
  const SILENT_KEY = 'hp-trade-silent';
  const readSilent = () => { try { return JSON.parse(localStorage.getItem(SILENT_KEY) || '{}'); } catch { return {}; } };
  const writeSilent = (m) => { try { localStorage.setItem(SILENT_KEY, JSON.stringify(m)); } catch {} };
  function markSilent(player) {
    const m = readSilent(); const prev = m[player] || { n: 0 };
    m[player] = { n: prev.n + 1, at: Date.now() };
    const keys = Object.keys(m); if (keys.length > 500) for (const k of keys.sort((a, b) => m[a].at - m[b].at).slice(0, keys.length - 500)) delete m[k];
    writeSilent(m);
  }

  // Propositions en attente + historique → cartes engagées, joueurs déjà sollicités, rythme d'envoi
  async function tradeLog(me) {
    const asked = new Set(), offered = new Map();
    const pendingTo = new Set();
    const promisedIds = new Set(); // exemplaires (userCardId) promis dans un échange en attente
    let openSent = 0;
    const lastByPlayer = new Map(); // joueur → { at, declined, accepted }
    const sendTimes = [];
    let sent = [], hist = [], received = [];
    try { sent = list(await api('GET', '/trades/sent')); } catch {}
    try { hist = list(await api('GET', '/trades/history')); } catch {}
    try { received = list(await api('GET', '/trades/received')); } catch {}
    // Échange ouvert dans l'autre sens (il t'a fait une proposition en attente) → ne pas le solliciter
    for (const t of received) if (t.status === 'pending' && t.from) pendingTo.add(t.from);
    const note = (to, at, declined, accepted = false) => {
      const prev = lastByPlayer.get(to);
      if (!prev || at > prev.at) lastByPlayer.set(to, { at, declined, accepted });
      else if (at === prev.at) { if (declined) prev.declined = true; if (accepted) prev.accepted = true; }
    };
    for (const t of sent) {
      if (t.from && t.from !== me) continue;
      const at = Date.parse(t.createdAt) || Date.now();
      if (t.status === 'pending') { pendingTo.add(t.to); openSent++; for (const x of t.offered || []) if (x.userCardId) promisedIds.add(x.userCardId); }
      note(t.to, at, false);
      sendTimes.push(at);
      for (const x of t.requested || []) { const c = x.card || x; if (c && c.id) asked.add(`${c.id}|${!!(x.reverse ?? c.reverse)}`); }
      for (const x of t.offered || []) { const c = x.card || x; if (c && c.id) { const k = `${c.id}|${!!(x.reverse ?? c.reverse)}`; offered.set(k, (offered.get(k) || 0) + 1); } }
    }
    for (const t of hist) {
      if (t.from !== me) continue;
      const created = Date.parse(t.createdAt) || Date.parse(t.resolvedAt) || 0;
      const accepted = t.status === 'accepted';
      // échange accepté : la pause de 1 h part de l'acceptation
      const at = accepted ? (Date.parse(t.resolvedAt || t.updatedAt) || created) : created;
      note(t.to, at, t.status === 'declined', accepted);
      sendTimes.push(created);
      // Il a répondu (accepté ou refusé) après sa dernière proposition ignorée : plus considéré comme inactif
      if (t.status === 'accepted' || t.status === 'declined') {
        const sm = readSilent();
        if (sm[t.to] && (Date.parse(t.resolvedAt || t.updatedAt) || 0) > sm[t.to].at) { delete sm[t.to]; writeSilent(sm); }
      }
    }
    // Journal local : seulement pour les envois que le site n'affiche pas encore
    const serverAt = new Map();
    for (const t of [...sent, ...hist]) {
      if (t.from && t.from !== me) continue;
      const at = Date.parse(t.createdAt) || 0;
      serverAt.set(t.to, Math.max(serverAt.get(t.to) || 0, at));
    }
    for (const e of readLocal()) {
      if ((serverAt.get(e.to) || 0) >= e.at - 120000) continue;
      note(e.to, e.at, false); sendTimes.push(e.at);
    }
    openTrades = openSent;
    for (const id of localPromised()) promisedIds.add(id);
    return { asked, offered, pendingTo, openSent, lastByPlayer, promisedIds, sendTimes: [...new Set(sendTimes)].sort((a, b) => a - b) };
  }

  // Annule les propositions envoyées restées sans réponse depuis plus de CANCEL_AFTER_H, ainsi que celles qui ne tiennent plus
  // (mon dernier exemplaire proposé, ou une carte demandée que je possède déjà). Les échanges vers le joueur prioritaire sont exclus.
  const CANCEL_KEY = 'hp-trade-cancel-last';
  async function cancelStale(force) {
    try {
      const last = +localStorage.getItem(CANCEL_KEY) || 0;
      if (!force && Date.now() - last < 4 * 60000) return 0; // un contrôle toutes les 5 min, tous onglets confondus
      localStorage.setItem(CANCEL_KEY, String(Date.now()));
    } catch {}
    let sent = [];
    try { sent = list(await api('GET', '/trades/sent')); } catch { return 0; }
    if (!myName) { try { myName = (await api('GET', '/me')).me.username; } catch {} }
    const old = sent.filter(t => t.status === 'pending' && t.id != null && (!t.from || !myName || t.from === myName)
      && Date.now() - (Date.parse(t.createdAt) || Date.now()) > CONFIG.CANCEL_AFTER_H * H);
    let n = 0;
    // Propositions encore en attente dont la situation a changé : mon dernier exemplaire est proposé, ou une carte demandée est déjà à moi
    const live = sent.filter((t) => t.status === 'pending' && t.id != null && (!t.from || !myName || t.from === myName) && !old.includes(t) && !isPriority(t.to));
    const copiesOf = new Map(); // fiche de carte lue une seule fois par contrôle
    // { n: exemplaires possédés, listed: dont en vente } pour cette version de la carte ; null si la fiche est illisible
    const owned = async (c, reverse) => {
      if (!copiesOf.has(c.id)) { try { copiesOf.set(c.id, (await api('GET', `/cards/${encodeURIComponent(c.id)}`)).mine || {}); } catch { copiesOf.set(c.id, null); } await sleep(CONFIG.DELAY / 2); }
      const m = copiesOf.get(c.id);
      if (!m) return null; // illisible : on ne touche à rien
      return reverse ? { n: m.reverseCopies || 0, listed: m.listedReverse || 0 } : { n: (m.copies || 0) - (m.reverseCopies || 0), listed: m.listed || 0 };
    };
    const kOf = (x) => { const c = x.card || x; return c && c.id ? { c, rev: !!(x.reverse ?? c.reverse), k: `${c.id}|${!!(x.reverse ?? c.reverse)}` } : null; };
    // Exemplaires déjà engagés ailleurs : les dons au joueur prioritaire d'abord (jamais annulés ici), puis chaque proposition gardée.
    // Un exemplaire en vente est compté comme parti : « en vente + promis » ne doit jamais vider la carte.
    const committed = new Map();
    const commit = (t) => { for (const x of t.offered || []) { const o = kOf(x); if (o) committed.set(o.k, (committed.get(o.k) || 0) + 1); } };
    for (const t of sent) if (t.status === 'pending' && isPriority(t.to) && (!t.from || !myName || t.from === myName)) commit(t);
    const wanted = new Set(); // carte demandée dans une proposition gardée : une seule demande par carte
    const invalid = [];
    for (const t of live.slice().sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))) { // les plus anciennes gardent la priorité
      let why = null;
      const mine = new Map(); // exemplaires de chaque carte donnés par CETTE proposition
      for (const x of t.offered || []) { // mon côté : il doit me rester au moins un exemplaire après tous mes engagements
        const o = kOf(x); if (!o) continue;
        const info = await owned(o.c, o.rev);
        if (!info) continue;
        const here = (mine.get(o.k) || 0) + 1; mine.set(o.k, here);
        if (info.n - info.listed - (committed.get(o.k) || 0) - here < 1) {
          why = info.n <= 1 ? `dernier exemplaire de ${o.c.name || o.c.id}` : `${o.c.name || o.c.id} : les autres exemplaires sont en vente ou déjà promis`;
          break;
        }
      }
      if (!why) for (const x of t.requested || []) { // leur côté : une carte demandée que j'ai déjà, ou déjà demandée ailleurs
        const o = kOf(x); if (!o) continue;
        const info = await owned(o.c, o.rev);
        if (info && info.n >= 1) { why = `${o.c.name || o.c.id} déjà possédée`; break; }
        if (wanted.has(o.k)) { why = `${o.c.name || o.c.id} déjà demandée dans une autre proposition`; break; }
      }
      if (why) invalid.push({ t, why });
      else { commit(t); for (const x of t.requested || []) { const o = kOf(x); if (o) wanted.add(o.k); } }
    }
    for (const { t, why } of invalid) {
      try {
        await api('POST', `/trades/${t.id}/cancel`); n++;
        UI.toast(`<b>Échanges</b> : proposition à ${esc(t.to)} annulée (${esc(why)})`, { kind: 'info', ms: 10000 });
      } catch {}
      await sleep(CONFIG.DELAY);
    }
    const nInvalid = n;
    for (const t of old) {
      try {
        await api('POST', `/trades/${t.id}/cancel`); n++;
        markSilent(t.to); // sans réponse : pause plus longue pour ce joueur
        // garde la trace : le joueur reste en pause comme s'il n'avait pas répondu
        writeLocal([...readLocal(), { to: t.to, at: Date.parse(t.createdAt) || Date.now() }]);
      } catch {}
      await sleep(CONFIG.DELAY);
    }
    if (n) {
      if (openTrades != null) openTrades = Math.max(0, openTrades - n);
      if (n > nInvalid) UI.toast(`<b>Échanges</b> : ${n - nInvalid} proposition(s) sans réponse depuis plus de ${CONFIG.CANCEL_AFTER_H} h annulée(s)`, { kind: 'info', ms: 10000 });
    }
    return n;
  }

  // Joueurs déjà scannés sans résultat (mémoire locale) : on ne les rescanne pas avant SCAN_COOLDOWN_H
  const SCAN_KEY = 'hp-trade-scanned-v2';
  function readScanned() {
    let m = {};
    try { m = JSON.parse(localStorage.getItem(SCAN_KEY) || '{}'); } catch {}
    const now = Date.now();
    for (const u of Object.keys(m)) if (now - m[u] >= CONFIG.SCAN_COOLDOWN_H * H) delete m[u];
    return m;
  }
  const writeScanned = (m) => { try { localStorage.setItem(SCAN_KEY, JSON.stringify(m)); } catch {} };
  const resetScanned = () => { try { localStorage.removeItem(SCAN_KEY); } catch {} };

  // Le joueur est-il en pause ? Renvoie la raison, ou null
  function playerBlocked(p, log) {
    if (log.pendingTo.has(p)) return 'un échange est déjà ouvert avec ce joueur';
    const last = log.lastByPlayer.get(p);
    if (!last) return null;
    const quiet = readSilent()[p];
    if (quiet && !last.accepted && !last.declined) { // dernière proposition restée sans réponse : on laisse ce joueur tranquille plus longtemps
      const qcd = (quiet.n >= 2 ? CONFIG.SILENT_LONG_COOLDOWN_H : CONFIG.SILENT_COOLDOWN_H) * H;
      if (Date.now() - quiet.at < qcd) return `ne répond pas à nos propositions (${quiet.n} sans réponse)`;
    }
    const cd = (last.declined ? CONFIG.DECLINED_COOLDOWN_H : last.accepted ? CONFIG.ACCEPTED_COOLDOWN_H : CONFIG.PLAYER_COOLDOWN_H) * H;
    if (Date.now() - last.at < cd) return last.declined ? 'a refusé récemment' : 'déjà sollicité récemment';
    return null;
  }

  // Peut-on envoyer maintenant ? Renvoie { ok, wait (ms), reason }
  // Seule contrainte globale : un petit délai entre deux envois. Les limites sont par joueur (voir playerBlocked).
  function sendGate(log) {
    const now = Date.now();
    const last = log.sendTimes.length ? log.sendTimes[log.sendTimes.length - 1] : 0;
    const gap = CONFIG.MIN_GAP_S * 1000 - (now - last);
    if (gap > 0) return { ok: false, wait: gap, reason: 'pause entre deux envois' };
    return { ok: true, wait: 0 };
  }

  async function search(onProgress, opts = {}) {
    const me = (await api('GET', '/me')).me.username;
    const allSets = await api('GET', '/sets');
    const fav = new Set(allSets.filter((s) => s.favorite).map((s) => s.id));
    // Séries prises en compte : toutes, favoris en tête (ou seulement les favoris si FAVORITES_ONLY)
    const setPool = new Set(allSets.filter((s) => !CONFIG.FAVORITES_ONLY || s.favorite)
      .sort((a, b) => (fav.has(b.id) ? 1 : 0) - (fav.has(a.id) ? 1 : 0)).map((s) => s.id));
    if (!setPool.size) throw new Error('Aucune série en favori.');

    // 1) Tes cartes manquantes dans les séries en favori (normales et reverses), raretés alternées, hautes d'abord
    onProgress && onProgress(0, 0, 'Recherche de tes cartes manquantes…');
    const missing = [];
    let si = 0;
    for (const setId of setPool) {
      onProgress && onProgress(++si, setPool.size, 'Recherche de tes cartes manquantes…');
      try {
        const s = await api('GET', `/sets/${encodeURIComponent(setId)}`);
        for (const c of s.cards || []) {
          const f = fav.has(setId);
          if (!c.copies) missing.push({ id: c.id, rank: c.rank, reverse: false, fav: f });
          if (c.hasReverse && !c.reverseCopies) missing.push({ id: c.id, rank: c.rank, reverse: true, fav: f });
        }
      } catch {}
    }
    // Raretés alternées (la plus haute d'abord), favoris en tête dans chaque rareté
    {
      const byRank = new Map();
      for (const m of missing.sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0))) {
        if (!byRank.has(m.rank)) byRank.set(m.rank, []);
        byRank.get(m.rank).push(m);
      }
      const groups = [...byRank.keys()].sort((a, b) => b - a).map((r) => byRank.get(r));
      missing.length = 0;
      for (let k = 0; groups.some((g) => k < g.length); k++) for (const g of groups) if (k < g.length) missing.push(g[k]);
    }

    // 2) « Qui l'a en double ? » pour ces cartes → joueurs qui ont forcément quelque chose pour toi
    const log = await tradeLog(me);
    const scannedMem = readScanned();
    // Joueur utilisable : pas en pause (échange ouvert, sollicité, refus) et pas scanné récemment sans résultat
    const fresh = (u) => u && u !== me && !playerBlocked(u, log) && !scannedMem[u];
    const holderRank = new Map(); // joueur → plus petite rareté qu'il peut t'apporter
    const holderOnline = new Map();
    let n = 0;
    const holderCards = missing.slice(0, CONFIG.MAX_HOLDER_CARDS);
    for (const m of holderCards) {
      // assez de nouveaux joueurs trouvés : inutile de consulter plus de cartes
      if ([...holderRank.keys()].filter(fresh).length >= CONFIG.MAX_PARTNERS) break;
      onProgress && onProgress(++n, holderCards.length, 'Recherche de nouveaux joueurs…');
      try {
        const d = await api('GET', `/cards/${encodeURIComponent(m.id)}/holders${m.reverse ? '?reverse=1' : ''}`);
        for (const h of d.holders || []) {
          if (!h.username || h.username === me || !(h.spare > 0)) continue;
          if (!holderRank.has(h.username) || m.rank < holderRank.get(h.username)) holderRank.set(h.username, m.rank);
          holderOnline.set(h.username, !!h.online);
        }
      } catch {}
      await sleep(CONFIG.DELAY / 2);
    }
    const holders = [...holderRank.keys()].sort((a, b) =>
      holderRank.get(a) - holderRank.get(b) || (holderOnline.get(b) ? 1 : 0) - (holderOnline.get(a) ? 1 : 0));

    // 2 bis) Sens inverse : « Qui la recherche ? » pour tes doublons échangeables, les plus chers d'abord
    //        → joueurs qui ont déclaré vouloir une de tes cartes : les plus susceptibles d'accepter
    const flipResAll = flipReserved();
    const myDups = list(await api('GET', `/users/${encodeURIComponent(me)}/cards?duplicates=1`).catch(() => []))
      .filter((c) => !inBinder(c) && !flipResAll.has(key(c)) && (c.userCardIds || []).length)
      .sort((a, b) => val(b) - val(a));
    const wishBy = new Map(); // joueur → clés de tes doublons qu'il recherche
    const wishScore = new Map(); // joueur → valeur de la carte la plus chère qu'il recherche
    let w = 0;
    const wishCards = myDups.slice(0, CONFIG.MAX_WISH_CARDS);
    for (const c of wishCards) {
      if ([...wishBy.keys()].filter(fresh).length >= CONFIG.MAX_WISH_PARTNERS) break;
      onProgress && onProgress(++w, wishCards.length, 'Joueurs qui recherchent tes doublons…');
      try {
        const d = await api('GET', `/cards/${encodeURIComponent(c.id)}/wishers${c.reverse ? '?reverse=1' : ''}`);
        if (d.offerable === false) continue;
        for (const x of d.wishers || []) {
          const u = x.username;
          if (!u || u === me) continue;
          if (!wishBy.has(u)) wishBy.set(u, new Set());
          wishBy.get(u).add(key(c));
          wishScore.set(u, Math.max(wishScore.get(u) || 0, val(c)));
        }
      } catch {}
      await sleep(CONFIG.DELAY / 2);
    }
    const wishers = [...wishBy.keys()].filter(fresh)
      .sort((a, b) => wishBy.get(b).size - wishBy.get(a).size || wishScore.get(b) - wishScore.get(a))
      .slice(0, CONFIG.MAX_WISH_PARTNERS);

    // 3) + équipe et Bourse
    const team = await api('GET', '/team').catch(() => ({}));
    const board = await api('GET', '/trade-board?scope=all').catch(() => ({ requests: [] }));
    let paused = 0, alreadyScanned = 0;
    const partners = [...new Set([
      ...wishers,
      ...holders,
      ...((team.team && team.team.members) || []).map((m) => m.username),
      ...(board.requests || []).map((r) => r.player && r.player.username),
    ])].filter((u) => {
      if (!u || u === me || isExcluded(u)) return false; // jamais d'échange avec un joueur exclu
      if (isPriority(u)) return false; // la cible prioritaire a son propre envoi (priorityStep)
      if (playerBlocked(u, log)) { paused++; return false; } // déjà sollicité / en attente / a refusé
      if (scannedMem[u]) { alreadyScanned++; return false; } // déjà scanné récemment sans résultat
      return true;
    }).slice(0, wishers.length + CONFIG.MAX_PARTNERS);
    search.paused = paused;
    search.wishers = wishers.length;
    search.alreadyScanned = alreadyScanned;

    const room = Math.max(0, CONFIG.MAX_OPEN_TRADES - log.openSent);
    search.room = room;

    const target = Math.min(opts.target ?? CONFIG.MAX_PROPOSALS, room);
    if (!target) return [];

    // Paires possibles avec un joueur, compte tenu des cartes déjà réservées ailleurs
    function buildPairs(c, wantedTaken, giveUsed) {
      const pairs = [];
      const usedHere = new Set();
      const askedHere = new Set(); // dans un même échange : chaque carte demandée une seule fois
      const spareOf = (g) => Math.min((g.copies ?? 2) - 1, g.userCardIds.length);
      const tolOf = (v) => Math.max(v * (v > CONFIG.TOL_HIGH_FROM ? CONFIG.TOL_PCT_HIGH : CONFIG.TOL_PCT), CONFIG.TOL_ABS);
      // Note d'une paire (plus bas = mieux) ; null si la paire n'est pas acceptable
      //  - même rareté et même version, toujours
      //  - valeurs proches → paire équitable
      //  - ta carte vaut plus (jusqu'à 2×) → paire « compensée » : il ajoute des pièces. Jamais l'inverse.
      //  - cross = true (paires de complément) : rareté ou version libres, mais valeurs proches obligatoires, sans pièces
      const score = (g, a, cross = false) => {
        const vg = val(g), va = val(a), tol = tolOf(Math.max(vg, va));
        if (cross) {
          const gap = Math.abs((g.rank || 0) - (a.rank || 0));
          if (!(vg > 0 && va > 0) || gap > CONFIG.CROSS_MAX_RANK_GAP || Math.abs(vg - va) > tol) return null;
          // valeur la plus proche d'abord, puis le plus petit écart de rareté, puis la même version
          return { d: Math.abs(vg - va) + gap * 0.5 + (!!g.reverse === !!a.reverse ? 0 : 0.25) - (c.wish && c.wish.has(key(g)) ? 0.25 : 0), coin: false, cross: true };
        }
        if (CONFIG.SAME_RARITY && g.rank !== a.rank) return null;
        if (CONFIG.SAME_VERSION && !!g.reverse !== !!a.reverse) return null;
        let coin = false;
        if (Math.abs(vg - va) > tol) {
          if (!CONFIG.ASK_COINS || vg < va || vg > va * (1 + CONFIG.COIN_MAX_PCT)) return null;
          coin = true;
        }
        const d = Math.abs(vg - va) + (g.rarity === a.rarity ? 0 : 0.5) - (c.wish && c.wish.has(key(g)) ? 0.25 : 0);
        return { d: d + (coin ? 1e6 : 0), coin }; // une paire équitable passe toujours avant une paire compensée
      };
      const add = (a, g, sc) => {
        const k = key(g);
        usedHere.add(k); askedHere.add(key(a));
        pairs.push({ ask: a, askId: a.userCardIds[0], give: g, giveId: g.userCardIds[giveUsed.get(k) || 0], wished: !!(c.wish && c.wish.has(k)), coin: sc.coin, cross: !!sc.cross });
      };
      const giveFree = (g) => !usedHere.has(key(g)) && !isBlocked(key(g)) && (giveUsed.get(key(g)) || 0) < spareOf(g);
      const askFree = (a) => !askedHere.has(key(a)) && !wantedTaken.has(key(a));
      // a) Les doublons qu'il a mis dans sa liste de souhaits passent en premier
      if (c.wish && c.wish.size) {
        for (const g of c.give) {
          if (pairs.length >= CONFIG.MAX_PAIRS) break;
          if (!c.wish.has(key(g)) || !giveFree(g)) continue;
          let best = null;
          for (const a of c.ask) {
            if (!askFree(a)) continue;
            const sc = score(g, a);
            if (sc && (!best || sc.d < best.sc.d)) best = { a, sc };
          }
          if (best) add(best.a, g, best.sc);
        }
      }
      // b) Puis ses doublons qui te manquent, des plus hautes raretés aux plus basses
      for (const a of c.ask) {
        if (pairs.length >= CONFIG.MAX_PAIRS) break;
        if (!askFree(a)) continue;
        let best = null;
        for (const g of c.give) {
          if (!giveFree(g)) continue;
          const sc = score(g, a);
          if (sc && (!best || sc.d < best.sc.d)) best = { g, sc };
        }
        if (best) add(a, best.g, best.sc);
      }
      // c) Peu de paires de même rareté (collection presque complète) : on complète par des paires de valeur équivalente
      if (CONFIG.CROSS_VALUE && pairs.length < CONFIG.CROSS_WHEN_BELOW) {
        for (const a of c.ask) {
          if (pairs.length >= CONFIG.MAX_PAIRS) break;
          if (!askFree(a)) continue;
          let best = null;
          for (const g of c.give) {
            if (!giveFree(g)) continue;
            const sc = score(g, a, true);
            if (sc && (!best || sc.d < best.sc.d)) best = { g, sc };
          }
          if (best) add(a, best.g, best.sc);
        }
      }
      return pairs;
    }
    // Pièces demandées : écart de valeur en ta faveur à combler, s'il dépasse la tolérance. Jamais négatif.
    function coinsFor(pairs) {
      if (!CONFIG.ASK_COINS) return 0;
      const give = pairs.reduce((s, x) => s + val(x.give), 0);
      const ask = pairs.reduce((s, x) => s + val(x.ask), 0);
      const gap = Math.round(give - ask);
      return gap > Math.max(CONFIG.TOL_ABS, give * CONFIG.TOL_PCT / 2) ? gap : 0;
    }

    // 1) Scan : on récupère, pour chaque joueur, ses doublons qui te manquent et tes doublons qu'il n'a pas
    const scanned = [];
    let full = 0, i = 0;
    const empty = new Set(), noUse = new Map();
    for (const p of partners) {
      // assez de joueurs capables de remplir un échange complet : inutile de scanner plus loin
      if (full >= target * 2) break;
      onProgress && onProgress(++i, partners.length, 'Scan des joueurs…');
      try {
        const acc = await api('GET', `/users/${encodeURIComponent(p)}/trade-access`);
        if (acc.access !== 'open') { scannedMem[p] = Date.now(); continue; }
        const flipRes = flipReserved();
        const ask = list(await api('GET', `/users/${encodeURIComponent(p)}/cards?duplicates=1&notOwnedBy=${encodeURIComponent(me)}`))
          .filter((c) => setPool.has(c.setId) && (c.userCardIds || []).length)
          // raretés les plus hautes d'abord, puis séries en favori, puis valeur
          .sort((a, b) => b.rank - a.rank || (fav.has(b.setId) ? 1 : 0) - (fav.has(a.setId) ? 1 : 0) || val(b) - val(a));
        if (!ask.length) { scannedMem[p] = Date.now(); continue; }
        const give = list(await api('GET', `/users/${encodeURIComponent(me)}/cards?duplicates=1&notOwnedBy=${encodeURIComponent(p)}`))
          .filter((c) => !inBinder(c) && !flipRes.has(`${c.id}|${!!c.reverse}`) && (c.userCardIds || []).length);
        // tes doublons qu'il recherche en tête de liste
        if (wishBy.has(p)) give.sort((x, y) => (wishBy.get(p).has(key(y)) ? 1 : 0) - (wishBy.get(p).has(key(x)) ? 1 : 0));
        const c = { partner: p, ask, give, wish: wishBy.get(p) || null };
        const pot = buildPairs(c, new Set(log.asked), new Map(log.offered));
        if (!pot.length) { scannedMem[p] = Date.now(); continue; }
        // « complet » seulement avec au moins une carte au-dessus de Rare : sinon on continue à chercher
        if (pot.length >= CONFIG.MAX_PAIRS && pot.some((x) => x.ask.rank >= 4)) full++;
        scanned.push(c);
      } catch { /* joueur ignoré */ }
      await sleep(CONFIG.DELAY);
    }

    writeScanned(scannedMem);
    search.newlyScanned = i;

    // 2) Sélection : on garde en priorité les échanges qui contiennent le plus de cartes
    //    (les places d'échange sont limitées), puis les raretés les plus basses
    const wantedTaken = new Set(log.asked);      // une carte voulue n'est demandée qu'une fois
    const giveUsed = new Map(log.offered);       // nombre d'exemplaires d'un doublon déjà engagés
    const proposals = [];
    let pool = scanned.slice();
    while (proposals.length < target && pool.length) {
      let best = null;
      for (const c of pool) {
        const pairs = buildPairs(c, wantedTaken, giveUsed);
        if (pairs.length < CONFIG.MIN_PAIRS) continue;
        // le plus de cartes, puis le plus de valeur échangée, puis les cartes qu'il recherche
        const value = pairs.reduce((s, x) => s + val(x.ask) + val(x.give), 0);
        const wished = pairs.filter((x) => x.wished).length;
        if (!best || pairs.length > best.pairs.length
          || (pairs.length === best.pairs.length && (value > best.value || (value === best.value && wished > best.wished)))) best = { c, pairs, value, wished };
      }
      if (!best) break;
      pool = pool.filter((c) => c !== best.c);
      for (const pr of best.pairs) {
        wantedTaken.add(key(pr.ask));
        giveUsed.set(key(pr.give), (giveUsed.get(key(pr.give)) || 0) + 1);
      }
      proposals.push({
        partner: best.c.partner, pairs: best.pairs, status: 'ready',
        askTotal: best.pairs.reduce((s, x) => s + val(x.ask), 0),
        giveTotal: best.pairs.reduce((s, x) => s + val(x.give), 0),
        coins: coinsFor(best.pairs),
      });
    }
    return proposals;
  }

  let myName = null;
  let openTrades = null; // échanges envoyés en attente (mis à jour à chaque lecture de l'historique)
  async function refreshOpen() {
    try { if (!myName) myName = (await api('GET', '/me')).me.username; await tradeLog(myName); } catch {}
    if (UI.hasPanel(PANEL)) render(); else paint();
  }
  async function send(prop) {
    if (!myName) myName = (await api('GET', '/me')).me.username;
    // Vérification juste avant l'envoi : rythme global et joueur pas déjà sollicité
    const log = await tradeLog(myName);
    if (log.openSent >= CONFIG.MAX_OPEN_TRADES) throw new Error(`limite de ${CONFIG.MAX_OPEN_TRADES} échanges en cours atteinte — attends qu'un échange se termine`);
    const blocked = playerBlocked(prop.partner, log);
    if (blocked) throw new Error(`${prop.partner} : ${blocked}`);
    const gate = sendGate(log);
    if (!gate.ok) throw new Error(`${gate.reason} — réessaie dans ${fmtWait(gate.wait)}`);
    // Dernière vérification sur la fiche de chaque carte donnée : jamais le dernier exemplaire, jamais une carte en vente
    for (const x of prop.pairs) {
      const info = await freeInfo(x.give, log);
      if (info.spare < 1) {
        blockedGive.set(key(x.give), Date.now());
        throw new Error(`${x.give.name} : dernier exemplaire ou déjà en vente, échange non envoyé`);
      }
      if (!info.ids.includes(x.giveId)) x.giveId = info.ids[0];
      await sleep(CONFIG.DELAY / 2);
    }
    await api('POST', '/trades', {
      toUsername: prop.partner,
      offeredUserCardIds: prop.pairs.map((x) => x.giveId),
      requestedUserCardIds: prop.pairs.map((x) => x.askId),
      offeredCoins: 0, // jamais de pièces de ton côté
      requestedCoins: Math.max(0, Math.round(prop.coins || 0)),
    });
    savePromised(prop.pairs.map((x) => x.giveId)); // les scripts de vente n'y touchent plus
    writeLocal([...readLocal(), { to: prop.partner, at: Date.now() }]);
  }
  // ───────── Échange prioritaire : don à sens unique vers HP_PRIORITY_TARGET ─────────
  // Envoie les cartes que la cible n'a pas (les plus chères d'abord), sans rien demander en retour.
  // Seul cas où le dernier exemplaire peut partir. Jamais une carte en vente ni déjà promise, hors classeur et hors cartes réservées à la revente.
  // Passe avant la recherche normale ; aucune pause après acceptation ou refus, mais un seul échange ouvert à la fois.
  let lastPriorityErr = '', priorityWarned = false, priorityErrs = 0;
  async function priorityStep(log) {
    const target = priorityTarget();
    if (!target || !myName || target.toLowerCase() === myName.toLowerCase()) return false;
    if (isExcluded(target) && !priorityWarned) {
      priorityWarned = true;
      UI.toast(`<b>Échange prioritaire</b> : ${esc(target)} est aussi dans les joueurs exclus, la priorité l'emporte`, { kind: 'info', ms: 10000 });
    }
    if (log.pendingTo.has(target)) return false;                // un échange est déjà en attente avec lui
    if (log.openSent >= CONFIG.MAX_OPEN_TRADES) return false;   // aucune place libre
    if (!sendGate(log).ok) return false;
    if (Date.now() < lsNum(PRIORITY_NEXT_KEY)) return false;   // rien à donner la dernière fois, ou erreur : on attend
    const later = (min) => lsSet(PRIORITY_NEXT_KEY, Date.now() + min * 60000);
    try {
      const acc = await api('GET', `/users/${encodeURIComponent(target)}/trade-access`);
      if (acc.access !== 'open') { later(CONFIG.PRIORITY_IDLE_MIN); return false; }
      const flipRes = flipReserved();
      const give = list(await api('GET', `/users/${encodeURIComponent(myName)}/cards?notOwnedBy=${encodeURIComponent(target)}`)) // toutes tes cartes, pas seulement les doublons
        .filter((c) => !inBinder(c) && !flipRes.has(key(c)) && (c.userCardIds || []).length)
        .sort((a, b) => val(b) - val(a));
      let ids = [];
      const offered = []; // { id, v } : exemplaire proposé et sa valeur
      let checked = 0;
      for (const g of give) {
        if (offered.length >= CONFIG.PRIORITY_MAX_CARDS || checked >= CONFIG.PRIORITY_MAX_CHECK) break;
        if (isBlocked(key(g))) continue;
        checked++;
        const info = await freeInfo(g, log, 0); // fiche de la carte : en vente ou déjà promise → ignorée (le dernier exemplaire peut partir)
        if (info.spare >= 1) offered.push({ id: info.ids[0], v: val(g) });
        await sleep(CONFIG.DELAY / 2);
      }
      // Échange réciproque : la cible rend ses doublons (n'importe lesquels) pour une valeur équivalente
      let requested = [];
      if (CONFIG.PRIORITY_MATCH && offered.length) {
        const tol = (v) => Math.max(v * CONFIG.PRIORITY_MATCH_TOL, CONFIG.TOL_ABS);
        // Ses doublons, lus comme dans l'échange classique (le site ne renvoie pas toujours « copies » pour un autre joueur)
        const theirs = list(await api('GET', `/users/${encodeURIComponent(target)}/cards?duplicates=1`))
          .filter((c) => !inBinder(c) && (c.copies ?? 2) >= 2 && (c.userCardIds || []).length && val(c) > 0)
          .sort((a, b) => val(b) - val(a));
        const total = offered.reduce((t, x) => t + x.v, 0);
        let got = 0;
        for (const c of theirs) { // du plus cher au moins cher : le plus gros qui ne dépasse pas encore l'écart toléré
          if (requested.length >= CONFIG.PRIORITY_MAX_CARDS) break;
          if (got + val(c) <= total + tol(total)) { requested.push(c.userCardIds[0]); got += val(c); if (got >= total - tol(total)) break; }
        }
        // Moins de valeur reçue que proposée : on retire des cartes proposées (les moins chères d'abord) jusqu'à l'équilibre
        offered.sort((a, b) => b.v - a.v);
        let sum = 0; const kept = [];
        for (const x of offered) if (sum + x.v <= got + tol(got)) { kept.push(x); sum += x.v; }
        offered.length = 0; offered.push(...kept);
        if (!requested.length || !offered.length) { later(CONFIG.PRIORITY_IDLE_MIN); return false; }
      }
      ids = offered.map((x) => x.id);
      // Pièces du compte, au plus une fois par heure, jointes à un échange qui contient au moins une carte
      let coins = 0;
      if (CONFIG.PRIORITY_COINS && Date.now() >= lsNum(PRIORITY_COINS_KEY)) {
        try { coins = Math.max(0, Math.floor(((await api('GET', '/me')).me || {}).balance || 0) - CONFIG.PRIORITY_COINS_KEEP); } catch {}
        if (coins < CONFIG.PRIORITY_COINS_MIN) coins = 0;
      }
      if (!ids.length) { later(CONFIG.PRIORITY_IDLE_MIN); return false; } // le site exige au moins une carte : pas d'échange de pièces seules
      const send = (c) => api('POST', '/trades', {
        toUsername: target,
        offeredUserCardIds: ids,
        requestedUserCardIds: requested,
        offeredCoins: c,
        requestedCoins: 0,
      });
      try { await send(coins); }
      catch (e) {
        // Le site refuse les pièces de ce côté : on renvoie les cartes seules et on réessaie les pièces dans 6 h
        if (!coins || !/pi[eè]ce|coin|solde|balance|insuffisan/i.test(e.message)) throw e;
        coins = 0; lsSet(PRIORITY_COINS_KEY, Date.now() + 6 * 3600000);
        await send(0);
      }
      if (coins) lsSet(PRIORITY_COINS_KEY, Date.now() + CONFIG.PRIORITY_COINS_EVERY_MIN * 60000);
      savePromised(ids); // les scripts de vente n'y touchent plus
      writeLocal([...readLocal(), { to: target, at: Date.now() }]);
      if (openTrades != null) openTrades++;
      lastPriorityErr = ''; priorityErrs = 0; failStreak = 0; lsSet(PRIORITY_NEXT_KEY, 0);
      UI.toast(`<b>Échange prioritaire</b> : ${[`${ids.length} carte(s)${requested.length ? ` contre ${requested.length}` : ''}`, coins ? `${coins} pièces` : ''].filter(Boolean).join(' + ')} proposée(s) à ${esc(target)}`, { kind: 'success', ms: 12000 });
      return true;
    } catch (e) {
      priorityErrs++;
      // Compte refusé par le site : tout est suspendu ; sinon attente croissante (2, 4, 8… 60 min)
      if (!noteSendFailure(e)) later(Math.min(60, 2 ** priorityErrs));
      if (e.message !== lastPriorityErr) { // une seule alerte par message, pas une par minute
        lastPriorityErr = e.message;
        UI.toast(`Échange prioritaire (${esc(target)}) : ${esc(e.message)}`, { kind: 'error', ms: 12000 });
      }
      return false;
    }
  }
  const fmtWait = (ms) => {
    const s = Math.ceil(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.ceil(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };

/*__HPUI_KIT__*/

  // ───────── Interface : bouton du dock + panneau dans la colonne commune ─────────
  const esc = UI.esc;
  const cardLabel = (c) => `${esc(c.name)}${c.reverse ? ' <i>(rev.)</i>' : ''} <small style="color:#888">${esc(c.rarity || '')} · ${val(c)}</small>`;
  const PANEL = 'hp-tr-panel';
  let proposals = [], busy = false, lastMsg = '';

  function panel() {
    return UI.panel(PANEL, { title: 'Échanges équitables', order: 20, closable: true, onClose: paint });
  }
  const btn = (label, act, i, ghost) => `<button type="button" class="hp-mini${ghost ? ' hp-mini--ghost' : ''}" data-act="${act}" data-i="${i ?? ''}" style="margin-right:6px">${label}</button>`;

  function render(msg) {
    if (msg !== undefined) lastMsg = msg;
    const p = panel();
    const items = proposals.map((pr, i) => `
      <div style="margin:10px 0 0;padding:10px;border-radius:12px;background:#222;border:2px solid ${pr.status === 'sent' ? '#1f9d55' : pr.status === 'error' ? '#c0392b' : '#444'}">
        <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px"><b>${esc(pr.partner)} <span style="font-weight:500;color:#aaa;font-size:12px">· ${pr.pairs.length} carte${pr.pairs.length > 1 ? 's' : ''} de chaque côté</span></b>
          <span style="color:#aaa;font-size:12px;white-space:nowrap">reçois ${pr.askTotal}${pr.coins ? ` + ${pr.coins} pièces` : ''} · donnes ${pr.giveTotal}</span></div>
        ${pr.pairs.map((x) => `<div style="margin:3px 0;font-size:13px"><span style="color:#7ee0a1">Tu reçois</span> ${cardLabel(x.ask)}<br><span style="color:#ffd400">Tu donnes</span> ${cardLabel(x.give)}${x.wished ? ' <small style="color:#7ee0a1">· il la recherche</small>' : ''}${x.cross ? ' <small style="color:#aaa">· valeur équivalente, rareté différente</small>' : ''}</div>`).join('<hr style="border:0;border-top:1px solid #333;margin:6px 0">')}
        <div style="margin-top:9px">
          ${pr.status === 'ready' ? btn('Envoyer', 'send', i) + btn('Ignorer', 'skip', i, true) : ''}
          ${pr.status === 'sent' ? '<span style="color:#7ee0a1">Proposition envoyée</span>' : ''}
          ${pr.status === 'skipped' ? '<span style="color:#888">Ignorée</span>' : ''}
          ${pr.status === 'error' ? `<span style="color:#f88">${esc(pr.error)}</span>` : ''}
        </div>
      </div>`).join('');
    const max = CONFIG.MAX_OPEN_TRADES;
    const n = openTrades;
    const ratio = n == null ? 0 : Math.min(1, n / max);
    const barColor = n == null ? '#444' : n >= max ? '#c0392b' : n >= max - 2 ? '#e67e22' : '#7ee0a1';
    const counter = `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <span style="font-weight:600">Échanges en cours</span>
          <span style="font:700 15px var(--font-mono,ui-monospace,monospace);color:${n != null && n >= max ? '#f88' : '#f2f2f2'}">${n == null ? '…' : n} / ${max}</span>
        </div>
        <div style="height:6px;background:#333;border-radius:4px"><div style="height:6px;width:${(ratio * 100).toFixed(0)}%;background:${barColor};border-radius:4px"></div></div>
        ${n != null && n >= max ? '<div style="color:#f88;font-size:12px;margin-top:5px">Limite atteinte : plus d’envoi possible tant qu’un échange n’est pas terminé.</div>' : ''}
      </div>`;
    p.innerHTML = `${counter}
      <div class="hp-muted" style="font-size:12.5px;margin-bottom:10px">Ses doublons qui te manquent contre tes doublons de même rareté, même version (normale/reverse) et valeur proche (±${Math.round(CONFIG.TOL_PCT * 100)} %, ±${Math.round(CONFIG.TOL_PCT_HIGH * 100)} % au-delà de ${CONFIG.TOL_HIGH_FROM} pièces). Si ta carte vaut plus, il complète en pièces. Raretés hautes d'abord. Quand il y a moins de ${CONFIG.CROSS_WHEN_BELOW} paires de même rareté avec un joueur, des paires de valeur équivalente (rareté ou version différente, ${CONFIG.CROSS_MAX_RANK_GAP} niveaux d'écart au plus) complètent.</div>
      <button type="button" class="hp-mini" data-act="search" style="width:100%"${busy ? ' disabled' : ''}>${busy ? 'Recherche en cours…' : 'Chercher des échanges'}</button>
      ${!busy && Object.keys(readScanned()).length ? `<button type="button" class="hp-mini hp-mini--ghost" data-act="resetScan" style="width:100%;margin-top:6px">Rescanner aussi les ${Object.keys(readScanned()).length} joueur(s) déjà vus</button>` : ''}
      ${lastMsg ? `<div style="margin-top:8px;font-size:12.5px;color:#ccc">${lastMsg}</div>` : ''}
      ${items}`;
    p.querySelectorAll('button[data-act]').forEach((b) => { b.onclick = () => onAction(b.dataset.act, +b.dataset.i); });
    paint();
  }

  async function onAction(act, i) {
    if (act === 'resetScan') { resetScanned(); render('Mémoire des joueurs scannés effacée : la prochaine recherche les reprendra tous.'); return; }
    if (act === 'search') {
      if (busy) return;
      busy = true; proposals = []; render('Recherche des joueurs qui ont tes cartes manquantes en double…');
      try {
        proposals = await search((n, t, label) => render(t ? `${label} ${n}/${t}` : label));
        busy = false;
        const roomTxt = search.room != null && search.room < CONFIG.MAX_PROPOSALS ? ` Places libres : ${search.room} sur ${CONFIG.MAX_OPEN_TRADES}.` : '';
        const pausedTxt = search.paused ? ` ${search.paused} joueur(s) mis de côté (échange ouvert, déjà sollicité ou refus récent).` : '';
        const scanTxt = search.alreadyScanned ? ` ${search.alreadyScanned} joueur(s) déjà scanné(s) sans résultat dans les ${CONFIG.SCAN_COOLDOWN_H} h, ignoré(s).` : '';
        render((proposals.length ? `${proposals.length} proposition(s) prête(s). Une proposition par joueur toutes les ${CONFIG.PLAYER_COOLDOWN_H} h (${CONFIG.ACCEPTED_COOLDOWN_H} h s'il a accepté la dernière)${CONFIG.MIN_GAP_S ? `, ${CONFIG.MIN_GAP_S} s entre deux envois` : ''}.` : (search.room === 0 ? `Limite de ${CONFIG.MAX_OPEN_TRADES} échanges en cours atteinte.` : 'Aucun échange équitable trouvé pour l\'instant.')) + roomTxt + pausedTxt + scanTxt);
      } catch (e) { busy = false; render(`<span style="color:#f88">${esc(e.message)}</span>`); }
      return;
    }
    const pr = proposals[i];
    if (!pr) return;
    if (act === 'skip') { pr.status = 'skipped'; render(); return; }
    if (act === 'send') {
      try {
        await send(pr);
        pr.status = 'sent';
        if (openTrades != null) openTrades++;
        render(`Envoyée à ${esc(pr.partner)}.${CONFIG.MIN_GAP_S ? ` Prochain envoi possible dans ${CONFIG.MIN_GAP_S} s.` : ''}`);
      } catch (e) {
        // Rythme non respecté : la proposition reste prête, on affiche simplement l'attente
        if (/réessaie dans/.test(e.message)) render(esc(e.message));
        else { pr.status = 'error'; pr.error = e.message; render(); }
      }
    }
  }

  // ───────── Mode automatique : chercher et envoyer tant qu'il reste des places ─────────
  const AUTO_KEY = 'hp-trade-auto-on';
  const AUTO_LAST_KEY = 'hp-trade-auto-last';
  const LOCK_KEY = 'hp-trade-auto-lock';
  let autoOn = false;
  try { autoOn = localStorage.getItem(AUTO_KEY) === '1'; } catch {}
  let autoStatus = '';
  const readAutoLast = () => { try { return JSON.parse(localStorage.getItem(AUTO_LAST_KEY) || 'null'); } catch { return null; } };
  const writeAutoLast = (v) => { try { localStorage.setItem(AUTO_LAST_KEY, JSON.stringify(v)); } catch {} };
  // Verrou entre onglets : un seul onglet HoloPocket envoie à la fois
  const takeLock = () => {
    try {
      const l = +localStorage.getItem(LOCK_KEY) || 0;
      if (Date.now() - l < 15 * 60000) return false;
      localStorage.setItem(LOCK_KEY, String(Date.now()));
      return true;
    } catch { return true; }
  };
  const releaseLock = () => { try { localStorage.removeItem(LOCK_KEY); } catch {} };
  const minsLeft = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

  async function autoCycle(force) {
    if (!autoOn || busy) return;
    if (isBlocked_()) return; // le site refuse les échanges pour l'instant : aucun appel
    const last = readAutoLast();
    if (!force && last && Date.now() - last.at < CONFIG.AUTO_INTERVAL_MIN * 60000) return;
    if (!takeLock()) return;
    busy = true;
    let sent = 0, exhausted = false, full = false;
    try {
      if (!myName) myName = (await api('GET', '/me')).me.username;
      await cancelStale(true); // libère d'abord les places bloquées par des propositions trop anciennes
      for (let round = 0; round < CONFIG.AUTO_MAX_ROUNDS && autoOn; round++) {
        let log = await tradeLog(myName);
        // Échange prioritaire d'abord (une fois par passage) : il prend une place avant la recherche normale
        if (round === 0 && await priorityStep(log)) log = await tradeLog(myName);
        const room = CONFIG.MAX_OPEN_TRADES - log.openSent;
        if (room <= 0) { full = true; break; }
        autoStatus = `Recherche (tour ${round + 1}) · ${room} place(s) libre(s)`; paint();
        const props = await search((n, t, label) => { autoStatus = t ? `${label} ${n}/${t}` : label; paint(); }, { target: room });
        for (const pr of props) {
          if (!autoOn) break;
          try {
            await send(pr);
            sent++; failStreak = 0;
            if (openTrades != null) openTrades++;
            autoStatus = `Envoi des propositions… ${sent}`; paint();
          } catch (e) {
            if (/limite de/.test(e.message)) { full = true; break; }
            if (noteSendFailure(e)) { full = true; break; } // le site refuse le compte : on s'arrête là
          }
          await sleep(CONFIG.AUTO_SEND_DELAY_S * 1000);
        }
        if (full) break;
        // plus aucun nouveau joueur à scanner : inutile d'insister avant le prochain passage
        if (!props.length && !search.newlyScanned) { exhausted = true; break; }
      }
    } catch (e) {
      UI.toast(`Auto-échanges : ${esc(e.message)}`, { kind: 'error' });
    } finally {
      busy = false; autoStatus = '';
      releaseLock();
      writeAutoLast({ at: Date.now(), sent, exhausted, full });
      if (sent) UI.toast(`<b>Auto-échanges</b> : ${sent} proposition(s) envoyée(s) · ${openTrades ?? '?'}/${CONFIG.MAX_OPEN_TRADES} en cours`, { kind: 'success', ms: 12000 });
      await refreshOpen();
    }
  }

  function paint() {
    // Interrupteur Auto-échanges : visible sur toutes les pages
    const last = readAutoLast();
    let sub = 'Désactivés';
    if (autoOn) {
      if (busy && autoStatus) sub = autoStatus;
      else if (isBlocked_()) sub = `Suspendus par le site · reprise dans ${minsLeft(lsNum(BLOCKED_KEY) - Date.now())}`;
      else {
        const cnt = openTrades != null ? `${openTrades}/${CONFIG.MAX_OPEN_TRADES} en cours` : 'Échanges';
        const next = last ? `prochain dans ${minsLeft(last.at + CONFIG.AUTO_INTERVAL_MIN * 60000 - Date.now())}` : 'démarrage…';
        sub = `${cnt} · ${openTrades != null && openTrades >= CONFIG.MAX_OPEN_TRADES ? 'en attente de places' : next}`;
      }
    }
    UI.button('hp-tr-auto', {
      label: 'Auto-échanges', sub, icon: 'swap', kind: 'toggle', on: autoOn, order: 93, busy: busy && autoOn && !!autoStatus,
      title: 'Cherche et envoie automatiquement des échanges équitables tant qu’il reste des places',
      onClick: () => {
        autoOn = !autoOn;
        try { localStorage.setItem(AUTO_KEY, autoOn ? '1' : '0'); } catch {}
        if (!autoOn) releaseLock();
        paint();
        if (autoOn) autoCycle(true);
      },
    });

    // Bouton manuel + panneau, uniquement sur la page Échanges
    if (!location.pathname.startsWith('/echanges')) { UI.removeButton('hp-tr-open'); UI.removePanel(PANEL); return; }
    const open = UI.hasPanel(PANEL);
    UI.button('hp-tr-open', {
      label: 'Échanges équitables',
      sub: busy ? 'Recherche en cours…' : `${openTrades == null ? '' : `${openTrades}/${CONFIG.MAX_OPEN_TRADES} en cours · `}${open ? 'masquer' : 'afficher'}`,
      icon: 'swap', kind: 'secondary', order: 13, busy,
      onClick: () => { if (UI.hasPanel(PANEL)) { UI.removePanel(PANEL); paint(); } else { render(); refreshOpen(); } },
    });
  }
  paint();
  setInterval(paint, 1000);
  if (location.pathname.startsWith('/echanges') || autoOn) refreshOpen();
  // Compteur des échanges en cours : relu toutes les 30 s (une seule requête légère)
  async function countOpen() {
    try {
      const sent = list(await api('GET', '/trades/sent'));
      openTrades = sent.filter((t) => t.status === 'pending' && (!t.from || !myName || t.from === myName)).length;
    } catch { return; }
    paint();
    // Des places se sont libérées après un passage qui avait tout rempli : on relance tout de suite
    const last = readAutoLast();
    if (autoOn && !busy && openTrades < CONFIG.MAX_OPEN_TRADES && last && last.full) autoCycle(true);
  }
  setInterval(() => { if (location.pathname.startsWith('/echanges') || autoOn) countOpen(); }, 120000);
  if (autoOn) setTimeout(() => autoCycle(), window.__hp.jitter(5000, 0.5));
  window.__hp.schedule(() => autoCycle(), 120000);
  setTimeout(() => cancelStale(), 8000);
  setInterval(() => { if (!busy) cancelStale(); }, 5 * 60000);
  addEventListener('beforeunload', () => { if (busy && autoOn) releaseLock(); });
})();
