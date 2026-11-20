// Auto-booster : réglage « série fixe » (localStorage hp-booster-force).
// Lancer : node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'holopocket-auto-booster.user.js'), 'utf8');

// Deux séries : A (favorite, presque complète) et B (non favorite, tout manque → meilleure chance)
const SETS = [
  { id: 'setA', name: 'Alpha', favorite: true, promo: false },
  { id: 'setB', name: 'Beta Série', favorite: false, promo: false },
];
const BOOSTER = { cost: 1, slots: [{ label: 'carte', pools: [{ rarity: 'C', chance: 1 }] }] };
const detail = (id) => ({ cards: id === 'setA' ? [{ rarity: 'C', copies: 1 }] : [{ rarity: 'C', copies: 0 }] });

async function run(force, o = {}) {
  const sets = o.sets || SETS;
  const opened = [], toasts = [];
  const store = { 'hp-auto-booster-on': '1' };
  if (force !== undefined) store['hp-booster-force'] = force;
  if (o.mode) store["hp-booster-mode"] = o.mode;
  if (o.alert !== undefined) store['hp-card-alert-value'] = String(o.alert);
  const ctx = {
    console, Date, JSON, Math, Set, Map, Promise, Array, Object, String, Number, crypto: { randomUUID: () => 'uuid' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    UI: new Proxy({ esc: (s) => String(s ?? ''), toast: (m) => toasts.push(m) }, { get: (t, p) => (p in t ? t[p] : () => {}) }),
    setInterval: (fn, ms) => { if (ms === 1000) setTimeout(fn, 250); return 0; }, clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 0),
    // Stub du kit (injecté dans le build, absent du source testé) : planificateur inerte, comme setInterval ci-dessus
    __hp: { jitter: (ms) => ms, schedule: () => ({ stop() {} }) },
    fetch: async (url, opts = {}) => {
      const p = url.replace(/^\/api/, '');
      const ok = (d) => ({ ok: true, status: 200, json: async () => d });
      if (opts.method === 'POST' && p === '/packs/open') { opened.push(JSON.parse(opts.body).setId); return ok({ cards: o.cards || [], packs: { stock: 0, max: 5 } }); }
      if (p === '/me') return ok({ me: { packs: o.packs || { stock: 5, max: 5 } } });
      if (p === '/sets') return ok(sets);
      if (p === '/event') return ok(o.event || {});
      if (p === '/tour-quests') return o.quests === 'error' ? { ok: false, status: 404, json: async () => ({}) } : o.quests === 'down' ? { ok: false, status: 502, json: async () => ({}) } : ok({ quests: o.quests || [] });
      let m = p.match(/^\/sets\/([^/]+)\/booster$/);
      if (m) return ok({ ...BOOSTER, cost: (o.costs || {})[m[1]] || 1 });
      m = p.match(/^\/sets\/([^/]+)$/);
      if (m) return ok((o.detail || detail)(m[1]));
      return ok({});
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  await new Promise((r) => setTimeout(r, 400));
  return { opened, toasts, store };
}

test('sans réglage : meilleur favori (comportement inchangé)', async () => {
  const r = await run(undefined);
  assert.deepStrictEqual(r.opened, ['setA']);
});

test('série fixe par identifiant : ouvre cette série même si elle n’est pas favorite', async () => {
  const r = await run('setB');
  assert.deepStrictEqual(r.opened, ['setB']);
});

test('série fixe par nom, sans tenir compte de la casse', async () => {
  const r = await run('beta série');
  assert.deepStrictEqual(r.opened, ['setB']);
});

test('série fixe introuvable : rien n’est ouvert, erreur signalée', async () => {
  const r = await run('inconnue');
  assert.deepStrictEqual(r.opened, []);
  assert(r.toasts.some((m) => /introuvable/i.test(m)), 'erreur non signalée : ' + JSON.stringify(r.toasts));
});

test('optimisation : meilleure chance de nouvelle carte par énergie, toutes séries confondues', async () => {
  // A favorite mais complète ; B et C ont la même chance, C coûte 3 → B
  const sets = [...SETS, { id: 'setC', name: 'Gamma', favorite: true, promo: false }];
  const r = await run(undefined, { mode: 'optimal', sets, costs: { setC: 3 }, detail: (id) => ({ cards: [{ rarity: 'C', copies: id === 'setA' ? 1 : 0 }] }) });
  assert.deepStrictEqual(r.opened, ['setB']);
});

test('optimisation : plus aucune nouvelle carte possible → retour au meilleur favori', async () => {
  const r = await run(undefined, { mode: 'optimal', detail: () => ({ cards: [{ rarity: 'C', copies: 1 }] }) });
  assert.deepStrictEqual(r.opened, ['setA']);
});

test('optimisation : une série fixe garde la priorité', async () => {
  const r = await run('setA', { mode: 'optimal' });
  assert.deepStrictEqual(r.opened, ['setA']);
});

test('journal : carte nouvelle signalée, carte de valeur annoncée à part', async () => {
  const det = () => ({ cards: [{ id: 'c1', rarity: 'C', copies: 0, marketValue: 250 }, { id: 'c2', rarity: 'C', copies: 2, marketValue: 3 }] });
  const cards = [{ id: 'c1', name: 'Dracaufeu', reverse: false }, { id: 'c2', name: 'Rattata', reverse: false }, { id: 'c1', name: 'Dracaufeu', reverse: false }];
  const r = await run('setA', { detail: det, cards });
  const open = r.toasts.find((m) => /Booster ouvert/.test(m)) || '';
  assert.match(open, /1 nouvelle carte/);
  assert.match(open, /Dracaufeu <b>\(nouvelle\)<\/b>, Rattata, Dracaufeu(?! <b>)/, open); // le 2e exemplaire du même booster n'est plus « nouveau »
  const val = r.toasts.filter((m) => /Carte de valeur/.test(m));
  assert.strictEqual(val.length, 2, JSON.stringify(r.toasts));
  assert.match(val[0], /Dracaufeu, 250 pièces \(nouvelle\)/);
});

test('journal : seuil à 0 → aucune alerte de valeur', async () => {
  const det = () => ({ cards: [{ id: 'c1', rarity: 'C', copies: 0, marketValue: 250 }] });
  const r = await run('setA', { detail: det, cards: [{ id: 'c1', name: 'Dracaufeu' }], alert: 0 });
  assert.strictEqual(r.toasts.filter((m) => /Carte de valeur/.test(m)).length, 0);
});

test('une carte possédée seulement en reverse compte comme manquante en version normale', async () => {
  // A : la seule carte n'existe chez moi qu'en reverse → la version normale manque → A passe devant B (complète)
  const det = (id) => ({ cards: [id === 'setA' ? { id: 'x', rarity: 'C', copies: 1, reverseCopies: 1 } : { id: 'y', rarity: 'C', copies: 1, reverseCopies: 0 }] });
  const r = await run(undefined, { mode: 'optimal', detail: det });
  assert.deepStrictEqual(r.opened, ['setA']);
});

// ───────── Mode « quêtes du Tour des Arènes » ─────────
const SETS3 = [...SETS, { id: 'setC', name: 'Gamma', favorite: false, promo: false }];
const gym = (id, aims, extra = {}) => ({ id, label: `Quête ${id}`, region: 'kanto', gym: 1, secret: null, progress: 0, count: 3, aims, ...extra });
const secret = (id, aims, extra = {}) => ({ id, label: `Secret ${id}`, region: 'kanto', gym: null, secret: 's1', progress: 0, count: 2, aims, ...extra });
const aim = (setId, energy) => ({ setId, setName: setId, boosters: energy, energy });

test('quêtes : la quête d’arène l’emporte sur les nouvelles cartes et sur les secrets', async () => {
  const r = await run(undefined, { mode: 'quests', sets: SETS3, quests: [secret('s', [aim('setB', 2)]), gym('g', [aim('setC', 40), aim('setA', 10)])] });
  assert.deepStrictEqual(r.opened, ['setA']);
  const t = r.toasts.find((m) => /Booster ouvert/.test(m)) || '';
  assert.match(t, /quête d’arène « Quête g » \(0\/3\)/, t);
  assert.strictEqual(JSON.parse(r.store['hp-booster-last']).setId, 'setA');
});

test('quêtes : une extension qui sert plusieurs quêtes d’arène passe devant', async () => {
  // C sert deux quêtes à 15 d'énergie (2/15) ; A en finit une à 10 (1/10) → C
  const r = await run(undefined, { mode: 'quests', sets: SETS3, quests: [gym('g1', [aim('setA', 10), aim('setC', 15)]), gym('g2', [aim('setC', 15)])] });
  assert.deepStrictEqual(r.opened, ['setC']);
});

test('quêtes : sans quête d’arène jouable, la quête secrète est visée', async () => {
  const quests = [gym('fini', [aim('setA', 1)], { done: true }), gym('verrou', [aim('setA', 1)], { locked: true }), gym('jeu', []), secret('s', [aim('setC', 5)])];
  const r = await run(undefined, { mode: 'quests', sets: SETS3, quests });
  assert.deepStrictEqual(r.opened, ['setC']);
  assert(r.toasts.some((m) => /quête secrète « Secret s »/.test(m)), JSON.stringify(r.toasts));
});

test('quêtes : aucune quête → nouvelles cartes (optimisation)', async () => {
  const r = await run(undefined, { mode: 'quests', quests: [] });
  assert.deepStrictEqual(r.opened, ['setB']);
});

test('quêtes : Tour indisponible → nouvelles cartes', async () => {
  const r = await run(undefined, { mode: 'quests', quests: 'error' });
  assert.deepStrictEqual(r.opened, ['setB']);
});

test('quêtes : extension inconnue du site ignorée', async () => {
  const r = await run(undefined, { mode: 'quests', quests: [gym('g', [aim('zzz', 1)])] });
  assert.deepStrictEqual(r.opened, ['setB']);
});

test('quêtes : une série fixe garde la priorité', async () => {
  const r = await run('setA', { mode: 'quests', sets: SETS3, quests: [gym('g', [aim('setC', 1)])] });
  assert.deepStrictEqual(r.opened, ['setA']);
});

test('quêtes : booster de quête trop cher pour l’énergie actuelle → on attend, rien d’autre n’est ouvert', async () => {
  const r = await run(undefined, { mode: 'quests', sets: SETS3, costs: { setC: 10 }, packs: { stock: 5, max: 10 }, quests: [gym('g', [aim('setC', 40)])] });
  assert.deepStrictEqual(r.opened, []);
});

test('énergie bonus comptée une seule fois (stock la contient déjà)', async () => {
  // 6 d'énergie dont 4 de bonus : pas de quoi ouvrir un booster à 10 (avant : 6 + 4 = 10 → ouverture refusée par le site)
  const r = await run('setC', { sets: SETS3, costs: { setC: 10 }, packs: { stock: 6, bonus: 4, max: 10 } });
  assert.deepStrictEqual(r.opened, []);
  const ok = await run('setC', { sets: SETS3, costs: { setC: 10 }, packs: { stock: 10, bonus: 4, max: 10 } });
  assert.deepStrictEqual(ok.opened, ['setC']);
});

test('quêtes : site des quêtes en panne → on attend au lieu d’ouvrir des nouvelles cartes', async () => {
  const r = await run(undefined, { mode: 'quests', quests: 'down' });
  assert.deepStrictEqual(r.opened, []);
});

// ───────── Événement avec promo offerte ─────────
const inH = (h) => new Date(Date.now() + h * 3600000).toISOString();
const EVT = (over = {}, progress = {}) => ({ event: { name: 'Fête', endsAt: inH(24), setIds: ['setB'], packPrice: null, promo: { packs: 3, max: 1 }, ...over }, progress: { packs: 0, promos: 0, ...progress } });

test('événement avec promo : ses boosters passent avant la série fixe', async () => {
  const r = await run('setA', { event: EVT() });
  assert.deepStrictEqual(r.opened, ['setB']);
  assert(r.toasts.some((m) => /Événement Fête/.test(m)), JSON.stringify(r.toasts));
});

test('événement : promo déjà gagnée, ou événement terminé → réglage habituel', async () => {
  assert.deepStrictEqual((await run('setA', { event: EVT({}, { packs: 3, promos: 1 }) })).opened, ['setA']);
  assert.deepStrictEqual((await run('setA', { event: EVT({ endsAt: inH(-1) }) })).opened, ['setA']);
});

test('événement infaisable avant la fin : ignoré, et signalé', async () => {
  // 40 boosters à 1 d'énergie, 5 en stock, 1 h restante à +1 toutes les 10 min → 11 d'énergie au mieux
  const r = await run('setA', { event: EVT({ endsAt: inH(1), promo: { packs: 40, max: 1 } }) });
  assert.deepStrictEqual(r.opened, ['setA']);
  assert(r.toasts.some((m) => /ignoré/.test(m)), JSON.stringify(r.toasts));
});

test('événement à plusieurs séries : celle qui a la meilleure chance de nouvelle carte', async () => {
  const sets = [...SETS, { id: 'setC', name: 'Gamma', favorite: false, promo: false }];
  const det = (id) => ({ cards: [{ rarity: 'C', copies: id === 'setC' ? 0 : 1 }] }); // seule C a une carte manquante
  const r = await run(undefined, { sets, detail: det, event: EVT({ setIds: ['setA', 'setC'] }) });
  assert.deepStrictEqual(r.opened, ['setC']);
});

test('événement annoncé : l’énergie est gardée quand la recharge pendant l’événement ne suffira pas', async () => {
  // Événement d'1 h (6 d'énergie rechargée), promo à 10 boosters → il faut partir avec 4 + 2 de marge ; départ dans 10 min, stock 5
  const up = { name: 'Bientôt', startsAt: inH(1 / 6), endsAt: inH(1 + 1 / 6), setIds: ['setB'], packPrice: null, promo: { packs: 10, max: 1 } };
  const sets = SETS.map((x) => ({ ...x, packCost: 1 }));
  const r = await run('setA', { sets, event: { event: null, progress: null, upcoming: up } });
  assert.deepStrictEqual(r.opened, []);
  assert(r.toasts.some((m) => /énergie est gardée/.test(m)), JSON.stringify(r.toasts));
});

test('événement annoncé mais largement faisable sans réserve : ouverture normale', async () => {
  const up = { name: 'Bientôt', startsAt: inH(1), endsAt: inH(25), setIds: ['setB'], packPrice: null, promo: { packs: 10, max: 1 } };
  const sets = SETS.map((x) => ({ ...x, packCost: 1 }));
  const r = await run('setA', { sets, event: { event: null, progress: null, upcoming: up } });
  assert.deepStrictEqual(r.opened, ['setA']);
});

test('événement annoncé qui vient de commencer, pas encore publié par le site : on attend, on n’ouvre rien d’autre', async () => {
  const up = { name: 'Bascule', startsAt: inH(-1 / 60), endsAt: inH(3), setIds: ['setB'], packPrice: null, promo: { packs: 1, max: 1 } };
  const r = await run('setA', { sets: SETS.map((x) => ({ ...x, packCost: 1 })), event: { event: null, progress: null, upcoming: up } });
  assert.deepStrictEqual(r.opened, []);
});
