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

async function run(force) {
  const opened = [], toasts = [];
  const store = { 'hp-auto-booster-on': '1' };
  if (force !== undefined) store['hp-booster-force'] = force;
  const ctx = {
    console, Date, JSON, Math, Set, Map, Promise, Array, Object, String, Number, crypto: { randomUUID: () => 'uuid' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    UI: new Proxy({ esc: (s) => String(s ?? ''), toast: (m) => toasts.push(m) }, { get: (t, p) => (p in t ? t[p] : () => {}) }),
    setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 0),
    fetch: async (url, opts = {}) => {
      const p = url.replace(/^\/api/, '');
      const ok = (d) => ({ ok: true, status: 200, json: async () => d });
      if (opts.method === 'POST' && p === '/packs/open') { opened.push(JSON.parse(opts.body).setId); return ok({ cards: [], packs: { stock: 0, max: 5 } }); }
      if (p === '/me') return ok({ me: { packs: { stock: 5, max: 5 } } });
      if (p === '/sets') return ok(SETS);
      let m = p.match(/^\/sets\/([^/]+)\/booster$/);
      if (m) return ok(BOOSTER);
      m = p.match(/^\/sets\/([^/]+)$/);
      if (m) return ok(detail(m[1]));
      return ok({});
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  await new Promise((r) => setTimeout(r, 100));
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
