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
  const ctx = {
    console, Date, JSON, Math, Set, Map, Promise, Array, Object, String, Number, crypto: { randomUUID: () => 'uuid' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    UI: new Proxy({ esc: (s) => String(s ?? ''), toast: (m) => toasts.push(m) }, { get: (t, p) => (p in t ? t[p] : () => {}) }),
    setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 0),
    // Stub du kit (injecté dans le build, absent du source testé) : planificateur inerte, comme setInterval ci-dessus
    __hp: { jitter: (ms) => ms, schedule: () => ({ stop() {} }) },
    fetch: async (url, opts = {}) => {
      const p = url.replace(/^\/api/, '');
      const ok = (d) => ({ ok: true, status: 200, json: async () => d });
      if (opts.method === 'POST' && p === '/packs/open') { opened.push(JSON.parse(opts.body).setId); return ok({ cards: [], packs: { stock: 0, max: 5 } }); }
      if (p === '/me') return ok({ me: { packs: { stock: 5, max: 5 } } });
      if (p === '/sets') return ok(sets);
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
  return { opened, toasts };
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
