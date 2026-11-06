// ==UserScript==
// @name         HoloPocket – Ouverture auto quand l'énergie est pleine
// @namespace    kevin.holopocket
// @version      2.1
// @description  Surveille l'énergie en arrière-plan. Dès qu'elle atteint le plafond, ouvre 1 booster de la série favorite qui a le plus de chance de donner une nouvelle carte.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    COUNT_REVERSE: true,     // une reverse manquante compte comme une nouvelle carte
    KEEP_BONUS: true,        // ne pas puiser dans l'énergie bonus, seulement le stock qui se régénère
    POLL_MS: 30000,          // fréquence de vérification de l'énergie (ms)
    MAX_OPENS: Infinity,     // plafond d'ouvertures auto par session (Infinity = sans limite)
    AUTO_START: false,       // démarrer la surveillance dès le chargement de la page
  };

  const LS_KEY = 'hp-auto-booster-on';
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if (!c.copies) r.miss++;
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

  async function pickBestSet() {
    const all = await api('GET', '/sets');
    let sets = all.filter((s) => !s.promo && s.favorite);
    // Aucun favori : booster par défaut (localStorage 'hp-booster-default' = id ou nom de la série)
    if (!sets.length) {
      let def = '';
      try { def = (localStorage.getItem('hp-booster-default') || '').trim().toLowerCase(); } catch {}
      if (!def) return null;
      const norm = (x) => String(x || '').trim().toLowerCase();
      sets = all.filter((s) => norm(s.id) === def || norm(s.name) === def);
      if (!sets.length) sets = all.filter((s) => norm(s.name).includes(def)).slice(0, 1);
      if (!sets.length) throw new Error(`Booster par défaut « ${def} » introuvable`);
    }
    const rows = await Promise.all(sets.map(async (s) => {
      const id = encodeURIComponent(s.id);
      const [booster, detail] = await Promise.all([api('GET', `/sets/${id}/booster`), api('GET', `/sets/${id}`)]);
      return { id: s.id, name: s.name, cost: booster.cost ?? s.packCost ?? 1, chance: chanceNewCard(booster, detail.cards || []) };
    }));
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
  const state = { on: false, busy: false, opens: 0, lastCards: [], lastSet: null, nextCheck: 0, error: null };

  async function tick() {
    if (!state.on || state.busy) return;
    state.busy = true;
    try {
      const me = (await api('GET', '/me')).me;
      const packs = me.packs || {};
      render(packs);
      if (me.quarantined) { stop(`Compte en quarantaine — surveillance stoppée.`); return; }

      // Énergie au plafond → on ouvre pour ne rien gaspiller
      while (state.on && packs.stock >= packs.max && state.opens < CONFIG.MAX_OPENS) {
        const best = await pickBestSet();
        if (!best) { stop('Aucune série en favori (et aucun booster par défaut).'); return; }
        if (best.cost > packs.stock) break;
        const res = await openOne(best);
        state.opens++;
        state.lastSet = best;
        state.lastCards = res.cards || [];
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
    clearInterval(timer);
    timer = setInterval(tick, CONFIG.POLL_MS);
    render(null);
  }
  function stop(msg) {
    state.on = false;
    try { localStorage.setItem(LS_KEY, '0'); } catch {}
    clearInterval(timer);
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
    let energy = p.stock != null ? `Énergie ${p.stock}/${p.max}` : '';
    if (p.stock != null && p.stock < p.max && p.nextAt) {
      const next = Math.max(0, Math.round((new Date(p.nextAt) - Date.now()) / 1000));
      energy += ` · +1 dans ${mmss(next)}`;
    }
    UI.button('hp-auto-btn', {
      label: 'Auto-ouverture',
      sub: state.on ? (energy || 'Surveillance de l’énergie') : `Désactivée${p.stock != null ? ` · énergie ${p.stock}/${p.max}` : ''}`,
      icon: 'zap', kind: 'toggle', on: state.on, order: 90, busy: state.busy && state.on && p.stock >= p.max,
      title: 'Ouvre un booster dès que l’énergie est pleine (série favorite la plus utile)',
      onClick: () => (state.on ? stop() : start()),
    });
    // Nouvelle ouverture → notification avec les cartes obtenues
    if (state.opens > lastToastOpens && state.lastSet) {
      lastToastOpens = state.opens;
      const cards = state.lastCards.map((c) => `${esc(c.name)}${c.reverse ? ' (rev.)' : ''}${c.isNew || c.new ? ' ✨' : ''}`).join(', ');
      UI.toast(`<b>Booster ouvert</b> · ${esc(state.lastSet.name)}${cards ? `<br><span class="hp-muted">${cards}</span>` : ''}`, { kind: 'success', ms: 12000 });
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
  setInterval(() => { if (!state.on) refreshEnergy(); }, 60000);
  // Reprise de l'état entre les pages
  let saved = '0'; try { saved = localStorage.getItem(LS_KEY) || '0'; } catch {}
  if (saved === '1' || CONFIG.AUTO_START) start();
})();
