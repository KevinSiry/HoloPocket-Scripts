// ==UserScript==
// @name         HoloPocket – Vendre mes doublons
// @namespace    kevin.holopocket
// @version      4.3
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

/*__HPUI_KIT__*/

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

  async function listFill(max, onProgress) {
    const done = [], failed = [];
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
      } catch (e) {
        failed.push({ ...c, reason: e.message });
        if (/limite|max|10/i.test(e.message)) break; // plus de place
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
    busy = true;
    try {
      const { free } = await freeSlots();
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
