// ==UserScript==
// @name         HoloPocket – Ouverture auto dès que l'énergie suffit
// @namespace    kevin.holopocket
// @version      3.1
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-auto-booster.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-auto-booster.user.js
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
