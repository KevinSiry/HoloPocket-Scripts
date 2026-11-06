// ==UserScript==
// @name         HoloPocket – Enchérir sur mes cartes manquantes
// @namespace    kevin.holopocket
// @version      2.0
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
          return a.status === 'active' && !a.isMine && !a.isLeading && end > now + 15000 && end <= deadline;
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

/*__HPUI_KIT__*/

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
