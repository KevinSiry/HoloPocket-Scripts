// ==UserScript==
// @name         HoloPocket – Ouverture auto dès que l'énergie suffit
// @namespace    kevin.holopocket
// @version      2.9
// @description  Surveille l'énergie en arrière-plan. Dès qu'elle suffit (énergie bonus comprise), ouvre 1 booster de la série favorite qui a le plus de chance de donner une nouvelle carte (ou d'une série fixe, ou de la série la plus rentable en nouvelles cartes par point d'énergie, selon le réglage du panel).
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
    if (!res.ok) throw new Error(data.message || `${res.status} ${data.error || ''}`.trim());
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
  const optimalMode = () => readLS('hp-booster-mode') === 'optimal' && !readLS('hp-booster-force');

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
    return { ...useful[0], optimal: true };
  }

  async function pickBestSet() {
    const all = await api('GET', '/sets');
    if (optimalMode()) { const best = await pickOptimal(all); if (best) return best; }
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
    return rows[0];
  }

  // ───────── Ouverture ─────────
  async function openOne(set) {
    const res = await api('POST', '/packs/open', {
      setId: set.id, count: 1, cost: set.cost, keepBonus: CONFIG.KEEP_BONUS, requestId: uuid(),
    });
    return res; // { cards, packs, setsChanged, ... }
  }

  // ───────── État & boucle ─────────
  // Énergie bonus : le champ exact dépend du site, on prend le premier nombre dont le nom contient « bonus »
  function bonusOf(p) {
    for (const [k, v] of Object.entries(p || {})) if (/bonus/i.test(k) && !/max|next|at$|until|expires/i.test(k) && typeof v === 'number' && v > 0) return v;
    return 0;
  }
  const usable = (p) => (p.stock || 0) + (CONFIG.KEEP_BONUS ? 0 : bonusOf(p));
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
        state.lastCost = best.cost;
        if (best.cost > usable(packs)) break;
        let res;
        try { res = await openOne(best); }
        catch (e) { if (best.optimal) skipUntil.set(best.id, Date.now() + 3600000); throw e; } // série refusée : une autre sera choisie au prochain passage
        chanceCache.delete(best.id); // la collection de cette série vient de changer
        state.opens++;
        state.lastSet = best;
        state.lastCards = describeCards(res.cards || [], best.owned);
        state.error = null;
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
    let energy = p.stock != null ? `Énergie ${p.stock}/${p.max}${bonus ? ` + ${bonus} bonus` : ''}` : '';
    if (p.stock != null && p.stock < p.max && p.nextAt) {
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
      UI.toast(`<b>Booster ouvert</b> · ${esc(state.lastSet.name)} · ${fresh ? `${fresh} nouvelle${fresh > 1 ? 's' : ''} carte${fresh > 1 ? 's' : ''}` : 'aucune nouvelle carte'}${cards ? `<br><span class="hp-muted">${cards}</span>` : ''}`, { kind: 'success', ms: 12000 });
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
