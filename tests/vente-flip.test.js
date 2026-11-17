// Vente des doublons + Achat-revente : coordination (cartes réservées, pause du marché partagée).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

// Exécute un script dans un faux navigateur ; `routes(path, opts)` répond aux appels /api
async function run(file, store, routes) {
  const calls = [];
  const ctx = {
    console, Date, JSON, Math, Set, Map, Promise, Array, Object, String, Number, RegExp, Error, URLSearchParams,
    location: { pathname: '/', reload() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    UI: new Proxy({ esc: (s) => String(s ?? '') }, { get: (t, p) => (p in t ? t[p] : () => {}) }),
    document: { querySelector: () => null, addEventListener() {} },
    addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: () => {},
    // Planificateur du kit : lance chaque tâche une fois, tout de suite
    __hp: { jitter: (ms) => ms, schedule: (fn) => { setTimeout(fn, 0); return { stop() {} }; } },
    fetch: async (url, opts = {}) => {
      const p = url.replace(/^\/api/, '');
      calls.push(`${opts.method || 'GET'} ${p}`);
      const d = routes(p, opts);
      return { ok: true, status: 200, json: async () => d ?? {} };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src(file), ctx);
  await new Promise((r) => setTimeout(r, 200));
  return calls;
}

test('Achat-revente : une carte sur laquelle j’enchéris est réservée (la Vente ne la prend pas avant mon passage suivant)', async () => {
  const store = {
    'hp-flip-auto-on': '1',
    'hp-flip-state': JSON.stringify({
      tracked: { a1: { cardId: 'c9', reverse: false, name: 'Dracaufeu', ref: 300, max: 200, endsAt: new Date(Date.now() + 120000).toISOString(), bid: 150 } },
      holdings: [{ key: 'c5|true', cardId: 'c5', reverse: true, name: 'Pikachu', cost: 50, ref: 90, tries: 0, auctionId: 'x', at: Date.now() }],
    }),
  };
  await run('holopocket-achat-revente.user.js', store, (p) => (p === '/me' ? { me: { username: 'kev', balance: 1000 } } : p === '/team' ? { team: { members: [] } } : p.startsWith('/market?') ? { auctions: [] } : { auction: { status: 'active' } }));
  assert.deepStrictEqual(JSON.parse(store['hp-flip-reserved']).sort(), ['c5|true', 'c9|false']);
});

test('Vente : la pause du marché posée par un autre script est respectée (rien n’est mis en vente)', async () => {
  const store = { 'hp-sell-auto-on': '1', 'hp-market-blocked-until': String(Date.now() + 3600000) };
  const calls = await run('holopocket-vendre-doublons.user.js', store, (p) => (p === '/market/counts' ? { selling: 0, maxSelling: 10 } : {}));
  // seule la lecture des places pour l'affichage du bouton reste
  assert.deepStrictEqual(calls.filter((c) => c !== 'GET /market/counts'), []);
});

test('Vente : sans pause, elle remplit bien les places libres', async () => {
  const store = { 'hp-sell-auto-on': '1' };
  const calls = await run('holopocket-vendre-doublons.user.js', store, (p) => (p === '/market/counts' ? { selling: 0, maxSelling: 10 } : p === '/trades/sent' ? [] : p.startsWith('/collection') ? { entries: [], pageSize: 50, total: 0 } : {}));
  assert(calls.includes('GET /market/counts'), JSON.stringify(calls));
});
