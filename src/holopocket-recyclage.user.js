// ==UserScript==
// @name         HoloPocket – Recyclage intelligent des doublons
// @namespace    kevin.holopocket
// @version      1.2
// @description  Recycle uniquement les doublons qui ne valent pas une mise aux enchères (vente nette après taxe pas assez supérieure à la valeur de recyclage). Garde toujours tes exemplaires et ignore les cartes verrouillées, favorites, recherchées, en vente, en échange, ou liées à un objectif ou une médaille.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    MIN_GAIN: 2,                    // la vente doit rapporter au moins 2 pièces de plus que le recyclage pour mériter une enchère
    TAX: 0.05,                      // taxe du marché prélevée sur le prix final
    TIERS: ['C', 'PC', 'R', 'SR'],  // paliers concernés (UR et L exclus par prudence)
    RECYCLE_UNKNOWN: false,         // carte sans prix de marché ni estimation : on la garde
    AUTO_INTERVAL_MIN: 30,          // fréquence du recyclage automatique
    MAX_PER_RUN: 300,               // cartes recyclées au plus par passage
    BATCH: 40,                      // cartes par requête de recyclage
    DELAY: 120,                     // pause entre deux lectures de carte (ms)
    DRY_RUN: false,                 // true = calcule sans rien recycler
  };
  const FALLBACK_VALUE = { C: 1, PC: 1, R: 3, SR: 10, UR: 30, L: 120 };
  const TIER_NAME = { C: 'Communes', PC: 'Peu communes', R: 'Rares', SR: 'Super rares', UR: 'Ultra rares', L: 'Légendaires' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Cartes achetées par le script Achat-revente : il s'occupe lui-même de leur revente
  const flipReserved = () => { try { return new Set(JSON.parse(localStorage.getItem('hp-flip-reserved') || '[]')); } catch { return new Set(); } };
  let reserved = null;
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

  // Valeur de recyclage par palier (lue sur le site) et nombre d'exemplaires à garder (réglage du site)
  async function siteSettings() {
    let keep = { normal: 1, reverse: 1 };
    const values = { ...FALLBACK_VALUE };
    try { keep = (await api('GET', '/me')).me.recycleKeep || keep; } catch {}
    try {
      const d = await api('GET', `/collection/duplicates?normal=${keep.normal ?? 1}&reverse=${keep.reverse ?? 1}`);
      for (const t of d.tiers || []) if (t.value != null) values[t.tier] = t.value;
    } catch {}
    return { keep, values };
  }

  // Vaut-il le coup de mettre cette carte aux enchères ?
  function worthSelling(market, recycleValue) {
    if (market == null) return !CONFIG.RECYCLE_UNKNOWN;
    return Math.floor(market * (1 - CONFIG.TAX)) >= recycleValue + CONFIG.MIN_GAIN;
  }

  // Exemplaires promis dans des propositions d'échange en attente : on n'y touche pas
  async function promisedIds() {
    const ids = new Set();
    try {
      const sent = await api('GET', '/trades/sent');
      for (const t of Array.isArray(sent) ? sent : []) {
        if (t.status !== 'pending') continue;
        for (const x of t.offered || []) if (x.userCardId) ids.add(x.userCardId);
      }
    } catch {}
    try { const now = Date.now(); for (const e of JSON.parse(localStorage.getItem('hp-trade-promised') || '[]')) if (now - e.at < 15 * 60000) ids.add(e.id); } catch {}
    return ids;
  }

  async function plan(onProgress) {
    const { keep, values } = await siteSettings();
    const promised = await promisedIds();

    // 1) Tous tes doublons
    const entries = [];
    for (let page = 1; ; page++) {
      onProgress && onProgress(`Lecture de tes doublons… page ${page}`);
      const d = await api('GET', `/collection?duplicates=1&sort=market&page=${page}`);
      entries.push(...(d.entries || []));
      if (page * d.pageSize >= d.total || !(d.entries || []).length) break;
    }

    // 2) Premier tri sur les prix : seules les versions « pas rentables à vendre » sont gardées
    const pre = [];
    for (const e of entries) {
      if (!CONFIG.TIERS.includes(e.tier)) continue;
      if (e.favorite || (e.goalsAtStake || []).length || (e.medalsAtStake || []).length) continue;
      const rv = values[e.tier] ?? FALLBACK_VALUE[e.tier] ?? 0;
      const normal = !worthSelling(e.marketValue ?? e.estimate, rv);
      const reverse = e.hasReverse && !worthSelling(e.reverseMarketValue ?? e.reverseEstimate, rv);
      if (normal || reverse) pre.push({ e, rv, normal, reverse });
    }

    // 3) Vérification carte par carte (verrous, exemplaires réellement libres)
    const items = [];
    let n = 0;
    for (const x of pre) {
      if (items.length >= CONFIG.MAX_PER_RUN) break;
      reserved = flipReserved();
      onProgress && onProgress(`Vérification des cartes… ${++n}/${pre.length}`);
      let c;
      try { c = await api('GET', `/cards/${encodeURIComponent(x.e.id)}`); } catch { continue; }
      const m = c.mine;
      if (!m || m.favorite || m.inTrade || (m.goalsAtStake || []).length || (m.medalsAtStake || []).length) continue;
      const revIds = new Set(m.availableReverseIds || []);
      const versions = [];
      if (x.normal) versions.push({
        reverse: false, ids: (m.availableIds || []).filter((id) => !revIds.has(id)),
        owned: (m.copies || 0) - (m.reverseCopies || 0), listed: m.listed || 0,
        locked: m.locked && m.locked.normal, wanted: m.wanted, keep: Math.max(1, keep.normal ?? 1),
        market: c.marketValue ?? c.estimate,
      });
      if (x.reverse) versions.push({
        reverse: true, ids: m.availableReverseIds || [],
        owned: m.reverseCopies || 0, listed: m.listedReverse || 0,
        locked: m.locked && m.locked.reverse, wanted: m.wantedReverse, keep: Math.max(1, keep.reverse ?? 1),
        market: c.reverseMarketValue ?? c.reverseEstimate,
      });
      for (const v of versions) {
        if (v.locked || v.wanted || reserved.has(`${x.e.id}|${v.reverse}`)) continue;
        if (worthSelling(v.market, x.rv)) continue; // re-vérifié avec les prix à jour
        const free = v.ids.filter((id) => !promised.has(id));
        const leaving = v.listed + (v.ids.length - free.length); // en vente ou promis dans un échange : ne restera pas
        const count = Math.min(free.length, Math.max(0, v.owned - leaving - v.keep), CONFIG.MAX_PER_RUN - items.length);
        for (let i = 0; i < count; i++) items.push({ id: free[i], name: x.e.name, tier: x.e.tier, reverse: v.reverse, rv: x.rv, market: v.market });
      }
      await sleep(CONFIG.DELAY);
    }
    return { items, coins: items.reduce((s, i) => s + i.rv, 0) };
  }

  // Recyclage par lots ; si le site refuse un lot, on repasse carte par carte
  async function execute(items, onProgress) {
    let coins = 0, done = 0;
    const failed = [];
    for (let i = 0; i < items.length; i += CONFIG.BATCH) {
      const batch = items.slice(i, i + CONFIG.BATCH);
      onProgress && onProgress(`Recyclage… ${Math.min(i + batch.length, items.length)}/${items.length}`);
      if (CONFIG.DRY_RUN) { done += batch.length; coins += batch.reduce((s, x) => s + x.rv, 0); continue; }
      try {
        const r = await api('POST', '/collection/recycle', { userCardIds: batch.map((x) => x.id) });
        coins += r.coins ?? batch.reduce((s, x) => s + x.rv, 0);
        done += r.recycled ?? batch.length;
      } catch {
        for (const x of batch) {
          try { const r = await api('POST', '/collection/recycle', { userCardIds: [x.id] }); coins += r.coins ?? x.rv; done++; }
          catch (e) { failed.push({ ...x, reason: e.message }); }
          await sleep(80);
        }
      }
      await sleep(250);
    }
    return { done, coins, failed };
  }

/*__HPUI_KIT__*/

  // ───────── Interface ─────────
  const esc = UI.esc;
  const PANEL = 'hp-recycle-panel';
  const AUTO_KEY = 'hp-recycle-auto-on';
  const LAST_KEY = 'hp-recycle-last';
  let autoOn = false;
  try { autoOn = localStorage.getItem(AUTO_KEY) === '1'; } catch {}
  let busy = false, status = '', preview = null;
  const readLast = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; } };
  const writeLast = (v) => { try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch {} };

  function summaryHtml(p) {
    const byTier = {};
    for (const it of p.items) { const t = (byTier[it.tier] ||= { n: 0, coins: 0 }); t.n++; t.coins += it.rv; }
    const tiers = Object.entries(byTier).map(([t, v]) => `<div style="display:flex;justify-content:space-between"><span>${TIER_NAME[t] || t}</span><span style="font-family:var(--font-mono,monospace)">${v.n} · +${v.coins}</span></div>`).join('');
    const lines = p.items.slice(0, 40).map((it) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}${it.reverse ? ' <i>(rev.)</i>' : ''}</span><span class="hp-muted" style="white-space:nowrap">marché ${it.market ?? '?'} → +${it.rv}</span></div>`).join('');
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <b>${p.items.length} carte(s) à recycler</b>
        <b style="font:700 16px var(--font-mono,ui-monospace,monospace);color:#ffd400">+${p.coins}</b>
      </div>
      ${tiers ? `<div style="padding:8px 10px;border-radius:10px;background:#222;margin-bottom:8px;font-size:13px">${tiers}</div>` : ''}
      ${lines ? `<div style="max-height:220px;overflow:auto;padding-right:4px">${lines}${p.items.length > 40 ? `<div class="hp-muted" style="font-size:12px;margin-top:4px">… et ${p.items.length - 40} autre(s)</div>` : ''}</div>` : ''}`;
  }

  function render() {
    if (!UI.hasPanel(PANEL)) { paint(); return; } // panneau ouvert à la main uniquement (jamais par l'auto-recyclage)
    const body = UI.panel(PANEL, {
      title: 'Recyclage intelligent', order: 22, closable: true, onClose: paint,
      actions: [{ icon: 'refresh', title: 'Recalculer', onClick: analyse }],
    });
    body.innerHTML = `
      <div class="hp-muted" style="font-size:12.5px;margin-bottom:10px">Recycle seulement les doublons dont la vente (prix habituel − ${Math.round(CONFIG.TAX * 100)} % de taxe) ne rapporterait pas au moins ${CONFIG.MIN_GAIN} pièces de plus que le recyclage. Tu gardes toujours tes exemplaires ; cartes verrouillées, favorites, recherchées, en vente, en échange ou liées à un objectif ignorées.</div>
      ${busy ? `<div class="hp-muted">${esc(status)}</div>`
        : preview ? (preview.items.length ? summaryHtml(preview) + `<button type="button" class="hp-mini" data-act="go" style="width:100%;margin-top:10px">Recycler ces ${preview.items.length} carte(s) · +${preview.coins}</button>` : '<div>Aucun doublon à recycler : tout ce qui reste vaut une mise aux enchères.</div>')
        : ''}`;
    const go = body.querySelector('[data-act=go]');
    if (go) go.onclick = () => run(preview.items);
    paint();
  }

  async function analyse() {
    if (busy) return;
    busy = true; status = 'Analyse…'; render();
    try { preview = await plan((s) => { status = s; render(); }); }
    catch (e) { preview = null; UI.toast(`Recyclage : ${esc(e.message)}`, { kind: 'error' }); }
    finally { busy = false; render(); }
  }

  async function run(items, auto) {
    if (busy || !items || !items.length) return;
    busy = true; status = 'Recyclage…'; render();
    try {
      const r = await execute(items, (s) => { status = s; render(); });
      writeLast({ at: Date.now(), done: r.done, coins: r.coins });
      if (r.done || r.failed.length) {
        UI.toast(`<b>${auto ? 'Auto-recyclage' : 'Recyclage'}${CONFIG.DRY_RUN ? ' (test à blanc)' : ''}</b> : ${r.done} carte(s) · +${r.coins} pièces${r.failed.length ? `<br><span style="color:#f88">${r.failed.length} échec(s)</span>` : ''}`, { kind: r.failed.length && !r.done ? 'error' : 'success', ms: 10000 });
      }
    } catch (e) {
      UI.toast(`Recyclage : ${esc(e.message)}`, { kind: 'error' });
    } finally {
      busy = false; preview = null;
      if (UI.hasPanel(PANEL)) analyse(); else paint();
    }
  }

  // Passage automatique (toutes les pages), au plus une fois par intervalle, même en changeant de page
  async function autoTick() {
    if (!autoOn || busy) return;
    const last = readLast();
    if (last && Date.now() - last.at < CONFIG.AUTO_INTERVAL_MIN * 60000) { paint(); return; }
    busy = true; status = 'Analyse…'; paint();
    let p = null;
    try { p = await plan(); } catch {}
    busy = false;
    if (p && p.items.length) await run(p.items, true);
    else { writeLast({ at: Date.now(), done: 0, coins: 0 }); paint(); }
  }

  function mins(ms) { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }

  function paint() {
    const last = readLast();
    let sub = 'Désactivé';
    if (autoOn) {
      if (busy) sub = status || 'En cours…';
      else if (last) sub = `${last.done ? `Dernier : ${last.done} · +${last.coins}` : 'Rien à recycler'} · prochain dans ${mins(last.at + CONFIG.AUTO_INTERVAL_MIN * 60000 - Date.now())}`;
      else sub = 'Premier passage imminent';
    }
    UI.button('hp-recycle-auto', {
      label: 'Auto-recyclage', sub, icon: 'refresh', kind: 'toggle', on: autoOn, order: 92, busy: busy && autoOn,
      title: 'Recycle automatiquement les doublons qui ne valent pas une mise aux enchères',
      onClick: () => {
        autoOn = !autoOn;
        try { localStorage.setItem(AUTO_KEY, autoOn ? '1' : '0'); } catch {}
        paint();
        if (autoOn) autoTick();
      },
    });
    if (location.pathname.startsWith('/collection')) {
      const open = UI.hasPanel(PANEL);
      UI.button('hp-recycle-open', {
        label: 'Recyclage intelligent', sub: open ? 'Masquer l’aperçu' : 'Aperçu des doublons sans intérêt à vendre',
        icon: 'coins', kind: 'secondary', order: 14, busy: busy && !autoOn,
        onClick: () => { if (UI.hasPanel(PANEL)) { UI.removePanel(PANEL); preview = null; paint(); } else { preview = null; UI.panel(PANEL, { title: 'Recyclage intelligent', order: 22, closable: true, onClose: paint }); analyse(); } },
      });
    } else {
      UI.removeButton('hp-recycle-open');
      if (!busy) UI.removePanel(PANEL);
    }
  }

  paint();
  setInterval(paint, 1000);
  setInterval(autoTick, 60000);
  if (autoOn) setTimeout(autoTick, 3000);
})();
