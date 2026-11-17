// ==UserScript==
// @name         HoloPocket – Ouverture auto dès que l'énergie suffit
// @namespace    kevin.holopocket
// @version      3.1
// @description  Surveille l'énergie en arrière-plan. Dès qu'elle suffit (énergie bonus comprise), ouvre 1 booster de la série favorite qui a le plus de chance de donner une nouvelle carte (ou d'une série fixe, ou de la série la plus rentable en nouvelles cartes par point d'énergie, ou de la série qui fait avancer les quêtes du Tour des Arènes, selon le réglage du panel).
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    COUNT_REVERSE: true,     // une reverse manquante compte comme une nouvelle carte
    KEEP_BONUS: false,       // false = l'énergie bonus sert aussi (true = seulement le stock qui se régénère)
    POLL_MS: 60000,          // fréquence de vérification de l'énergie (ms)
    MAX_OPENS: Infinity,     // plafond d'ouvertures auto par session (Infinity = sans limite)
    AUTO_START: false,       // démarrer la surveillance dès le chargement de la page
  };

  const LS_KEY = 'hp-auto-booster-on';
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, window.__hp.jitter(ms, 0.3)));

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `${res.status} ${data.error || ''}`.trim()), { status: res.status });
    return data;
  }

  // ───────── Choix de la série : favorite avec la plus forte chance de nouvelle carte ─────────
  function chanceNewCard(booster, cards) {
    const byR = {};
    for (const c of cards) {
      const r = (byR[c.rarity] ??= { n: 0, miss: 0, rev: 0, revMiss: 0 });
      r.n++;
      if ((c.copies || 0) - (c.reverseCopies || 0) <= 0) r.miss++; // « copies » compte aussi les reverses : la version normale manque si on n'a que des reverses
      if (c.hasReverse) { r.rev++; if (!c.reverseCopies) r.revMiss++; }
    }
    let none = 1;
    for (const slot of booster.slots) {
      const reverseSlot = /reverse/i.test(slot.label);
      let p = 0;
      for (const pool of slot.pools) {
        const r = byR[pool.rarity];
        if (!r) continue;
        const asReverse = reverseSlot && r.rev > 0;
        if (asReverse) { if (CONFIG.COUNT_REVERSE) p += pool.chance * (r.revMiss / r.rev); }
        else p += pool.chance * (r.miss / r.n);
      }
      none *= 1 - p;
    }
    return 1 - none;
  }

  const norm = (x) => String(x || '').trim().toLowerCase();
  // Série désignée par son identifiant ou son nom (nom exact, sinon nom qui contient le texte)
  function matchSets(all, wanted) {
    const w = norm(wanted);
    let found = all.filter((s) => norm(s.id) === w || norm(s.name) === w);
    if (!found.length) found = all.filter((s) => norm(s.name).includes(w)).slice(0, 1);
    return found;
  }
  const readLS = (k) => { try { return (localStorage.getItem(k) || '').trim(); } catch { return ''; } };

  // Chance de nouvelle carte d'une série. ttl > 0 : valeur gardée ce temps-là (mode « optimisation », qui regarde toutes les séries)
  const chanceCache = new Map(); // id → { at, row }
  const skipUntil = new Map();   // série refusée par le site en mode optimisation → ignorée 1 h
  const questFails = new Map();  // refus de suite d'une série visée pour une quête
  async function rowOf(s, ttl = 0) {
    const c = chanceCache.get(s.id);
    if (c && Date.now() - c.at < ttl) return c.row;
    const id = encodeURIComponent(s.id);
    const [booster, detail] = await Promise.all([api('GET', `/sets/${id}/booster`), api('GET', `/sets/${id}`)]);
    // État de la collection avant ouverture : sert à dire quelles cartes obtenues sont nouvelles, et leur valeur
    const owned = new Map((detail.cards || []).filter((c) => c && c.id != null).map((c) => [String(c.id), { copies: Math.max(0, (c.copies || 0) - (c.reverseCopies || 0)), rev: c.reverseCopies || 0, value: c.marketValue ?? c.estimate ?? null, revValue: c.reverseMarketValue ?? c.reverseEstimate ?? null }]));
    const row = { id: s.id, name: s.name, cost: booster.cost ?? s.packCost ?? 1, chance: chanceNewCard(booster, detail.cards || []), owned };
    chanceCache.set(s.id, { at: Date.now(), row });
    return row;
  }
  const boosterMode = () => (readLS('hp-booster-force') ? 'fixed' : readLS('hp-booster-mode'));

  // Mode « optimisation des nouvelles cartes » : parmi TOUTES les séries, la meilleure chance de nouvelle carte par point d'énergie
  async function pickOptimal(all) {
    const rows = [];
    for (const s of all.filter((x) => !x.promo && !(skipUntil.get(x.id) > Date.now()))) {
      try { rows.push(await rowOf(s, 30 * 60000)); } catch {} // série illisible : ignorée ce tour-ci
      await sleep(120);
    }
    const useful = rows.filter((r) => r.chance > 0 && r.cost > 0);
    if (!useful.length) return null; // plus aucune nouvelle carte possible : on retombe sur les favoris
    useful.sort((a, b) => b.chance / b.cost - a.chance / a.cost || a.cost - b.cost || b.chance - a.chance);
    return { ...useful[0], optimal: true, reason: 'optimisation des nouvelles cartes' };
  }

  // ───────── Mode « quêtes du Tour des Arènes » ─────────
  // GET /api/tour-quests : quêtes en cours ; chacune donne les extensions qui la font avancer (aims), avec l'énergie estimée pour la finir.
  // Priorité aux quêtes d'arène (dresseurs, champion), puis aux quêtes des secrets ; sans quête jouable en booster, on vise les nouvelles cartes.
  const questLeft = (q) => Math.max(1, Number(q.count) || 1) - (Number(q.progress) || 0);
  const isGymQuest = (q) => q.gym != null && !q.secret;
  // Chaque extension reçoit la somme, sur les quêtes qu'elle sert, de « 1 / énergie pour finir » : le nombre de quêtes bouclées par point d'énergie.
  // À égalité, la quête la plus proche de la fin l'emporte.
  function rankQuestSets(quests, sets) {
    const byId = new Map(sets.map((s) => [String(s.id), s]));
    const score = new Map(); // setId → { set, score, best: { quest, energy } }
    for (const q of quests) {
      for (const a of q.aims) {
        const set = byId.get(String(a.setId));
        if (!set || skipUntil.get(set.id) > Date.now()) continue;
        const energy = Math.max(1, Number(a.energy) || (Number(a.boosters) || 1) * (set.packCost || 1));
        const cur = score.get(set.id) || { set, score: 0, best: null };
        cur.score += 1 / energy;
        if (!cur.best || energy < cur.best.energy) cur.best = { quest: q, energy };
        score.set(set.id, cur);
      }
    }
    return [...score.values()].sort((a, b) => b.score - a.score || a.best.energy - b.best.energy);
  }
  // Renvoie la série à ouvrir, { wait } quand une quête existe mais ne peut pas être servie tout de suite,
  // ou null quand il n'y a vraiment aucune quête jouable en booster (alors seulement : nouvelles cartes)
  async function pickQuests(all) {
    let data;
    try { data = await api('GET', '/tour-quests'); }
    catch (e) {
      if (e.status && e.status < 500) return null; // Tour pas commencé (refus du site) : aucune quête
      return { wait: true, reason: 'quêtes illisibles pour le moment' }; // site ou réseau en panne : on n'ouvre rien d'autre, on réessaie
    }
    const live = (Array.isArray(data && data.quests) ? data.quests : [])
      .filter((q) => q && !q.done && !q.locked && questLeft(q) > 0 && Array.isArray(q.aims) && q.aims.length);
    for (const [kind, quests] of [['arène', live.filter(isGymQuest)], ['secret', live.filter((q) => q.secret)]]) {
      const ranked = rankQuestSets(quests, all); // séries écartées (refusées 3 fois) exclues
      for (const c of ranked) {
        try {
          const row = await rowOf(c.set);
          const q = c.best.quest;
          return { ...row, quest: true, reason: `quête ${kind === 'arène' ? 'd’arène' : 'secrète'} « ${q.label} » (${Math.min(q.progress || 0, q.count || 1)}/${Math.max(1, q.count || 1)})` };
        } catch { /* série illisible ce tour-ci : la suivante */ }
      }
      if (ranked.length) return { wait: true, reason: `quête ${kind === 'arène' ? 'd’arène' : 'secrète'} en attente` };
    }
    return null;
  }

  async function pickBestSet() {
    const all = await api('GET', '/sets');
    const mode = boosterMode();
    if (mode === 'quests') {
      const q = await pickQuests(all);
      if (q) return q; // une série de quête, ou l'attente : jamais de nouvelles cartes tant qu'une quête existe
      const best = await pickOptimal(all); // aucune quête jouable en booster : nouvelles cartes
      if (best) return { ...best, reason: 'aucune quête en cours : nouvelles cartes' };
    }
    if (mode === 'optimal') { const best = await pickOptimal(all); if (best) return best; }
    // Série fixe (réglée depuis le panel : localStorage 'hp-booster-force' = id ou nom) : toujours cette série
    const force = readLS('hp-booster-force');
    let sets;
    if (force) {
      sets = matchSets(all, force);
      if (!sets.length) throw new Error(`Série fixe « ${force} » introuvable`);
    } else {
      sets = all.filter((s) => !s.promo && s.favorite);
      // Aucun favori : booster par défaut (localStorage 'hp-booster-default' = id ou nom de la série)
      if (!sets.length) {
        const def = readLS('hp-booster-default');
        if (!def) return null;
        sets = matchSets(all, def);
        if (!sets.length) throw new Error(`Booster par défaut « ${def} » introuvable`);
      }
    }
    const rows = await Promise.all(sets.map((s) => rowOf(s)));
    rows.sort((a, b) => b.chance - a.chance);
    return { ...rows[0], reason: force ? 'série fixe' : sets.some((s) => s.favorite) ? 'meilleur favori' : 'booster par défaut' };
  }

  // ───────── Ouverture ─────────
  async function openOne(set) {
    const res = await api('POST', '/packs/open', {
      setId: set.id, count: 1, cost: set.cost, keepBonus: CONFIG.KEEP_BONUS, requestId: uuid(),
    });
    return res; // { cards, packs, setsChanged, ... }
  }

  // ───────── État & boucle ─────────
  // Énergie bonus : champ packs.bonus du site (à défaut, le premier nombre dont le nom contient « bonus »)
  function bonusOf(p) {
    if (p && typeof p.bonus === 'number') return Math.max(0, p.bonus);
    for (const [k, v] of Object.entries(p || {})) if (/bonus/i.test(k) && !/max|next|at$|until|expires/i.test(k) && typeof v === 'number' && v > 0) return v;
    return 0;
  }
  // packs.stock compte DÉJÀ l'énergie bonus (le site l'affiche comme stock - bonus pour la partie qui se recharge) : ne pas l'ajouter une 2e fois
  const usable = (p) => Math.max(0, (p.stock || 0) - (CONFIG.KEEP_BONUS ? bonusOf(p) : 0));
  const state = { on: false, busy: false, opens: 0, lastCards: [], lastSet: null, nextCheck: 0, error: null };

  // Complète chaque carte obtenue : nouvelle pour la collection ? quelle valeur ?
  // Le site peut le dire lui-même (isNew / new) ; sinon on compare à la collection lue juste avant l'ouverture.
  function describeCards(cards, owned) {
    const got = new Map(); // exemplaires de la même carte tirés dans CE booster
    return cards.map((c) => {
      const id = String(c.cardId ?? (c.card && c.card.id) ?? c.id ?? '');
      const rev = !!c.reverse;
      const before = owned && owned.get(id);
      const k = `${id}|${rev}`;
      const seen = got.get(k) || 0; got.set(k, seen + 1);
      const flag = typeof c.isNew === 'boolean' ? c.isNew : typeof c.new === 'boolean' ? c.new : null;
      const isNew = flag != null ? flag : before ? (rev ? before.rev : before.copies) + seen === 0 : false;
      const own = rev ? (c.reverseMarketValue ?? c.reverseEstimate) : (c.marketValue ?? c.estimate);
      const value = Number(own ?? (c.card && (rev ? c.card.reverseMarketValue : c.card.marketValue)) ?? (before && (rev ? before.revValue : before.value)) ?? 0) || 0;
      return { name: c.name ?? (c.card && c.card.name) ?? id, reverse: rev, isNew, value };
    });
  }
  // Seuil d'alerte « carte de valeur » (localStorage 'hp-card-alert-value', 100 par défaut, 0 = aucune alerte)
  const alertValue = () => { const v = readLS('hp-card-alert-value'); return v === '' ? 100 : Math.max(0, Number(v) || 0); };

  async function tick() {
    if (!state.on || state.busy) return;
    state.busy = true;
    try {
      const me = (await api('GET', '/me')).me;
      const packs = me.packs || {};
      render(packs);
      if (me.quarantined) { stop(`Compte en quarantaine — surveillance stoppée.`); return; }

      // Dès que l'énergie (bonus comprise) couvre le coût d'un booster, on ouvre
      // Le coût retenu vaut pour le choix du moment : il est oublié si la série imposée change, ou après 10 min
      const choice = `${readLS('hp-booster-force')}|${readLS('hp-booster-default')}|${readLS('hp-booster-mode')}`;
      if (choice !== state.costFor || Date.now() - (state.costAt || 0) > 600000) { state.lastCost = 0; state.costFor = choice; state.costAt = Date.now(); }
      while (state.on && packs.stock != null && usable(packs) >= (state.lastCost || 1) && state.opens < CONFIG.MAX_OPENS) {
        const best = await pickBestSet();
        if (!best) { stop('Aucune série en favori (et aucun booster par défaut).'); return; }
        if (best.wait) break; // quête en cours mais pas jouable maintenant : on attend le prochain passage
        state.lastCost = best.cost;
        if (best.cost > usable(packs)) break; // pas assez d'énergie pour CE booster : on attend la recharge, sans ouvrir autre chose
        let res;
        try { res = await openOne(best); }
        catch (e) {
          // Série refusée : écartée 1 h. Pour une quête, seulement après 3 refus de suite (un refus passager ne doit pas faire changer de cible)
          if (best.optimal) skipUntil.set(best.id, Date.now() + 3600000);
          if (best.quest) { const n = (questFails.get(best.id) || 0) + 1; questFails.set(best.id, n); if (n >= 3) { questFails.delete(best.id); skipUntil.set(best.id, Date.now() + 3600000); } }
          throw e;
        }
        questFails.delete(best.id);
        chanceCache.delete(best.id); // la collection de cette série vient de changer
        state.opens++;
        state.lastSet = best;
        state.lastCards = describeCards(res.cards || [], best.owned);
        state.error = null;
        // Dernière ouverture, lue par le bot pour le panel
        try { localStorage.setItem('hp-booster-last', JSON.stringify({ at: Date.now(), set: best.name, setId: best.id, reason: best.reason || '' })); } catch {}
        Object.assign(packs, res.packs || {}); // stock mis à jour par la réponse
        render(packs);
        await sleep(600); // petite pause entre deux ouvertures
      }
      if (state.opens >= CONFIG.MAX_OPENS) stop(`Plafond de ${CONFIG.MAX_OPENS} ouvertures atteint.`);
    } catch (e) {
      state.error = e.message;
      render(null);
    } finally {
      state.busy = false;
    }
  }

  let timer = null;
  function start() {
    state.on = true;
    try { localStorage.setItem(LS_KEY, '1'); } catch {}
    tick();
    if (timer) timer.stop();
    timer = window.__hp.schedule(tick, CONFIG.POLL_MS);
    render(null);
  }
  function stop(msg) {
    state.on = false;
    try { localStorage.setItem(LS_KEY, '0'); } catch {}
    if (timer) timer.stop();
    if (msg) state.error = msg;
    render(null);
  }

/*__HPUI_KIT__*/

  // ───────── Interface : interrupteur dans le dock, notifications pour les ouvertures ─────────
  const esc = UI.esc;
  let lastToastOpens = 0, lastError = null;

  function mmss(sec) { const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }

  function render(packs) {
    if (packs) state.packs = { ...(state.packs || {}), ...packs };
    const p = state.packs || {};
    const bonus = bonusOf(p);
    const regen = p.stock != null ? Math.max(0, p.stock - bonus) : null; // partie qui se recharge (stock compte aussi le bonus)
    let energy = p.stock != null ? `Énergie ${regen}/${p.max}${bonus ? ` + ${bonus} bonus` : ''}` : '';
    if (p.stock != null && regen < p.max && p.nextAt) {
      const next = Math.max(0, Math.round((new Date(p.nextAt) - Date.now()) / 1000));
      energy += ` · +1 dans ${mmss(next)}`;
    }
    UI.button('hp-auto-btn', {
      label: 'Auto-ouverture',
      sub: state.on ? (energy || 'Surveillance de l’énergie') : `Désactivée${p.stock != null ? ` · énergie ${p.stock}/${p.max}` : ''}`,
      icon: 'zap', kind: 'toggle', on: state.on, order: 90, busy: state.busy && state.on,
      title: 'Ouvre un booster dès que l’énergie (bonus comprise) suffit, série favorite la plus utile',
      onClick: () => (state.on ? stop() : start()),
    });
    // Nouvelle ouverture → notification avec les cartes obtenues
    if (state.opens > lastToastOpens && state.lastSet) {
      lastToastOpens = state.opens;
      const fresh = state.lastCards.filter((c) => c.isNew).length;
      const cards = state.lastCards.map((c) => `${esc(c.name)}${c.reverse ? ' (rev.)' : ''}${c.isNew ? ' <b>(nouvelle)</b>' : ''}`).join(', ');
      const why = state.lastSet.quest ? ` · pour la ${esc(state.lastSet.reason)}` : '';
      UI.toast(`<b>Booster ouvert</b> · ${esc(state.lastSet.name)} · ${fresh ? `${fresh} nouvelle${fresh > 1 ? 's' : ''} carte${fresh > 1 ? 's' : ''}` : 'aucune nouvelle carte'}${why}${cards ? `<br><span class="hp-muted">${cards}</span>` : ''}`, { kind: 'success', ms: 12000 });
      // Carte de valeur : un message à part, repris comme alerte par le panel
      const min = alertValue();
      if (min > 0) for (const c of state.lastCards.filter((x) => x.value >= min)) {
        UI.toast(`<b>Carte de valeur</b> : ${esc(c.name)}${c.reverse ? ' (rev.)' : ''}, ${c.value} pièces${c.isNew ? ' (nouvelle)' : ''} · ${esc(state.lastSet.name)} · ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, { kind: 'success', ms: 20000 });
      }
    }
    if (state.error && state.error !== lastError) {
      lastError = state.error;
      UI.toast(`<b>Auto-ouverture</b> : ${esc(state.error)}`, { kind: 'error', ms: 10000 });
    }
    if (!state.error) lastError = null;
  }

  // Énergie connue même quand l'auto-ouverture est coupée
  async function refreshEnergy() {
    try { const me = (await api('GET', '/me')).me; render(me.packs || {}); } catch {}
  }

  render(null);
  refreshEnergy();
  setInterval(() => render(null), 1000);              // compte à rebours + navigation interne
  setInterval(() => { if (!state.on) refreshEnergy(); }, 180000);
  // Reprise de l'état entre les pages
  let saved = '0'; try { saved = localStorage.getItem(LS_KEY) || '0'; } catch {}
  if (saved === '1' || CONFIG.AUTO_START) start();
})();
