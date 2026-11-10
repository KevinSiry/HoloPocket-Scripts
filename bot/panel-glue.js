// Liaison entre l'API du panel et le navigateur du bot (page Playwright, scripts injectés, réglages persistants).
// Tout ce qui touche à Playwright ou au réseau est injecté : ce module se teste avec une fausse page.
const pc = require('./panel-config');

const TRADES_MAX = 20; // limite du site : échanges envoyés en attente
// Résumé du suivi du script Achat-revente (son état est dans le navigateur du compte)
function flipSummary(f, beat) {
  if (!f && !beat) return null;
  f = f || {};
  const hold = Array.isArray(f.holdings) ? f.holdings : [];
  const st = f.stats || {};
  return {
    lastPassAt: beat && beat.at ? new Date(beat.at).toISOString() : null,
    error: (beat && beat.err) || null,
    bids: f.tracked ? Object.keys(f.tracked).length : 0,
    toResell: hold.length,
    waiting: hold.filter((h) => !h.auctionId).length,
    bought: st.bought || 0, sold: st.sold || 0, profit: (st.revenue || 0) - (st.soldCost || 0),
    log: (Array.isArray(f.log) ? f.log : []).slice(-6).map((l) => ({ at: l.at ? new Date(l.at).toISOString() : null, text: String(l.text || '').slice(0, 200) })),
  };
}
const arr = (x) => (Array.isArray(x) ? x : (x && (x.entries || x.cards)) || []);

// Exécuté DANS la page : lit les données du compte via l'API du site
function readSiteState() {
  const j = async (p) => {
    try { const r = await fetch('/api' + p, { credentials: 'same-origin' }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  const ls = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  // La liste des séries bouge très rarement : relue au plus toutes les 10 min
  const cached = window.__hpSets && Date.now() - window.__hpSets.at < 600000;
  return Promise.all([j('/me'), j('/trades/sent'), j('/market/counts'), cached ? window.__hpSets.v : j('/sets')])
    .then(([me, sent, counts, sets]) => { if (!cached && sets) window.__hpSets = { at: Date.now(), v: sets }; return ({ me, sent, counts, sets, flip: ls('hp-flip-state'), beat: ls('hp-flip-beat') }); });
}
// Exécuté DANS la page : chance d'obtenir au moins une nouvelle carte en ouvrant un booster de chaque série (hors promos).
// Même calcul que le script d'ouverture auto (une reverse manquante compte comme une nouvelle carte). Séries lues une par une.
async function readChances() {
  const j = async (p) => { const r = await fetch('/api' + p, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`${p} : HTTP ${r.status}`); return r.json(); };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const chance = (booster, cards) => {
    const byR = {};
    for (const c of cards) {
      const r = (byR[c.rarity] ??= { n: 0, miss: 0, rev: 0, revMiss: 0 });
      r.n++;
      if ((c.copies || 0) - (c.reverseCopies || 0) <= 0) r.miss++; // « copies » compte aussi les reverses
      if (c.hasReverse) { r.rev++; if (!c.reverseCopies) r.revMiss++; }
    }
    let none = 1;
    for (const slot of booster.slots || []) {
      const reverseSlot = /reverse/i.test(slot.label || '');
      let p = 0;
      for (const pool of slot.pools || []) {
        const r = byR[pool.rarity];
        if (!r) continue;
        if (reverseSlot && r.rev > 0) p += pool.chance * (r.revMiss / r.rev);
        else p += pool.chance * (r.miss / r.n);
      }
      none *= 1 - Math.min(1, p);
    }
    return 1 - none;
  };
  const all = await j('/sets');
  const rows = [];
  for (const s of (Array.isArray(all) ? all : []).filter((x) => !x.promo)) {
    try {
      const id = encodeURIComponent(s.id);
      const [booster, detail] = await Promise.all([j(`/sets/${id}/booster`), j(`/sets/${id}`)]);
      const cards = detail.cards || [];
      rows.push({ id: s.id, name: s.name, favorite: !!s.favorite, cost: booster.cost ?? s.packCost ?? 1, chance: chance(booster, cards), missing: cards.filter((c) => (c.copies || 0) - (c.reverseCopies || 0) <= 0).length, total: cards.length });
    } catch (e) { rows.push({ id: s.id, name: s.name, favorite: !!s.favorite, error: String(e.message || e) }); }
    await pause(150);
  }
  return rows;
}
function readSets() {
  return fetch('/api/sets', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : []));
}

/**
 * deps : {
 *   page, ctx,                    Playwright
 *   cfg,                          configuration du runner (cfg.scripts, cfg.toggles… sont modifiés ici)
 *   state: { panelCfg },          réglages du panel (objet partagé avec le runner)
 *   file,                         chemin de panel-config.json
 *   baseScripts,                  fichiers de scripts d'après le .env (avant les réglages du panel)
 *   buildToggles(): object,       interrupteurs localStorage d'après cfg + state.panelCfg
 *   setLS(t),                     fonction exécutée dans la page : écrit les interrupteurs
 *   getScripts(), setScripts(l),  scripts chargés ({ name, version, code })
 *   fetchScripts(names),          télécharge ces scripts
 *   load(),                       recharge la page et injecte les scripts
 *   logs, log,                    journal
 *   name, startedAt,              identité du bot
 * }
 */
function createGlue(deps) {
  const { page, ctx, cfg, state, file, baseScripts, buildToggles, setLS, getScripts, setScripts, fetchScripts, load, logs, log } = deps;
  const now = deps.now || (() => Date.now());

  const watch = { energyFullSince: null, tradesFullSince: null, lastOkAt: null };
  let statusCache = { at: 0, v: null };
  let setsCache = { at: 0, v: null };

  async function status() {
    if (statusCache.v && now() - statusCache.at < 15000) return statusCache.v;
    const d = await page.evaluate(readSiteState).catch(() => null);
    const me = d && d.me && d.me.me;
    const t = now();
    const packs = (me && me.packs) || {};
    const energyFull = !!me && packs.stock != null && packs.max != null && packs.stock >= packs.max;
    watch.energyFullSince = energyFull ? (watch.energyFullSince || t) : null;
    const open = me ? arr(d.sent).filter((x) => x.status === 'pending' && (!x.from || x.from === me.username)).length : null;
    const tradesFull = open != null && open >= TRADES_MAX;
    watch.tradesFullSince = tradesFull ? (watch.tradesFullSince || t) : null;
    if (me) watch.lastOkAt = t;
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    const loaded = getScripts();
    const v = {
      name: deps.name,
      at: iso(t),
      bot: { startedAt: iso(deps.startedAt), sessionOk: !!me, lastCheckAt: iso(watch.lastOkAt) },
      account: me ? {
        user: me.username, balance: me.balance ?? null,
        energy: { stock: packs.stock ?? null, max: packs.max ?? null, fullSince: iso(watch.energyFullSince) },
        quarantined: !!me.quarantined,
      } : null,
      trades: { open, max: TRADES_MAX, fullSince: iso(watch.tradesFullSince) },
      sales: { selling: d && d.counts ? d.counts.selling ?? null : null, max: d && d.counts ? d.counts.maxSelling ?? null : null },
      scripts: pc.KNOWN_SCRIPTS.map((n) => {
        const s = loaded.find((x) => pc.toName(x.name) === n);
        return { name: n, version: s ? s.version : null, on: !!s };
      }),
      flip: flipSummary(d && d.flip, d && d.beat),
      booster: {
        mode: state.panelCfg.booster.mode,
        setId: state.panelCfg.booster.setId || null,
        favorites: arr(d && d.sets).filter((s) => s.favorite && !s.promo).map((s) => ({ id: s.id, name: s.name })),
      },
    };
    statusCache = { at: t, v };
    return v;
  }

  // Chances par booster : calcul long (2 lectures par série), donc lancé en arrière-plan et gardé 30 min.
  // La réponse est immédiate : { computing, at, rows } ; le panel redemande tant que computing est vrai.
  let ch = { at: 0, rows: null, busy: false, error: null, failedAt: 0 };
  function chances(fresh) {
    const stale = !ch.rows || now() - ch.at > 30 * 60000;
    if (!ch.busy && (fresh || (stale && now() - ch.failedAt > 60000))) {
      ch.busy = true;
      page.evaluate(readChances)
        .then((rows) => { ch = { at: now(), rows, busy: false, error: null, failedAt: 0 }; })
        .catch((e) => { ch = { ...ch, busy: false, error: String(e.message || e).split('\n')[0].slice(0, 200), failedAt: now() }; });
    }
    return { computing: ch.busy, at: ch.at ? new Date(ch.at).toISOString() : null, rows: ch.rows || [], error: ch.error };
  }

  async function sets() {
    if (setsCache.v && now() - setsCache.at < 60000) return setsCache.v;
    const all = arr(await page.evaluate(readSets));
    const v = all.map((s) => ({ id: s.id, name: s.name, favorite: !!s.favorite, promo: !!s.promo, packCost: s.packCost ?? null }));
    setsCache = { at: now(), v };
    return v;
  }

  // Interrupteurs : sur la page ouverte tout de suite, et pour les rechargements suivants (le dernier script ajouté l'emporte)
  async function pushToggles() {
    const snap = { ...cfg.toggles };
    await ctx.addInitScript(setLS, snap);
    await page.evaluate(setLS, snap).catch(() => {});
  }

  // Les modifications se font l'une après l'autre
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  function applyConfig(patch) {
    return serial(async () => {
      const merged = pc.mergeConfig(state.panelCfg, patch);
      const nextScripts = pc.applyScripts(baseScripts, merged.scripts);
      const changed = nextScripts.join(',') !== cfg.scripts.join(',');
      // Téléchargement d'abord : s'il échoue, rien n'a changé
      const fresh = changed ? await fetchScripts(nextScripts) : null;
      pc.writeConfig(file, merged);
      state.panelCfg = merged;
      cfg.scripts = nextScripts;
      cfg.toggles = buildToggles();
      if (fresh) setScripts(fresh);
      await pushToggles();
      if (changed) await load();
      statusCache = { at: 0, v: null };
      if (patch.booster) log('Panel · booster :', merged.booster.mode === 'fixed' ? `série fixe ${merged.booster.setId}` : merged.booster.mode === 'optimal' ? 'optimisation des nouvelles cartes' : 'auto (meilleur favori)');
      if (patch.scripts) log('Panel · scripts :', cfg.scripts.map(pc.toName).join(', ') || 'aucun');
      return { scriptsReloaded: changed };
    });
  }

  // Les exclusions ont changé (compte ajouté ou retiré) : on réécrit les interrupteurs et on recharge pour qu'ils soient pris en compte
  function refreshToggles({ reload = false } = {}) {
    return serial(async () => {
      cfg.toggles = buildToggles();
      await pushToggles();
      if (reload) await load();
    });
  }

  return { status, sets, chances, applyConfig, refreshToggles, logs: deps.logs };
}

module.exports = { createGlue, TRADES_MAX };
