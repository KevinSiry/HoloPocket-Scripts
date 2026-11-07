const test = require('node:test');
const assert = require('node:assert');
const { parseBots, createBots } = require('../lib/bots');

test('PANEL_BOTS : lecture et lignes invalides ignorées', () => {
  assert.deepStrictEqual(parseBots('a=http://a:3100, b=http://b:3100/ ,mauvais,=http://x,c=ftp://x'), [{ name: 'a', url: 'http://a:3100' }, { name: 'b', url: 'http://b:3100' }]);
  assert.deepStrictEqual(parseBots(''), []);
});

function fake(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const h = handlers(url, init);
    if (h instanceof Error) throw h;
    return { ok: h.status ? h.status < 400 : true, status: h.status || 200, json: async () => h.body };
  };
  return { fetchFn, calls };
}

test('rafraîchissement : état, journal incrémental, jeton envoyé', async () => {
  let last = 0;
  const f = fake((url) => (url.endsWith('/status') ? { body: { name: 'a' } } : { body: { lines: [{ id: ++last, level: 'info', at: 'x', text: 't' }], last } }));
  const b = createBots({ bots: [{ name: 'a', url: 'http://a' }], token: 'TOK', fetchFn: f.fetchFn, now: () => 42 });
  const [k] = await b.refreshAll();
  assert.strictEqual(k.online, true);
  assert.strictEqual(k.lastSeen, 42);
  assert.strictEqual(k.logs.length, 1);
  assert.strictEqual(f.calls[0].init.headers.Authorization, 'Bearer TOK');
  await b.refreshAll();
  assert.ok(f.calls.some((c) => c.url.includes('after=1')));
  assert.strictEqual(b.get('a').logs.length, 2);
});
test('bot injoignable : hors ligne mais dernier état conservé', async () => {
  let down = false;
  const f = fake((url) => (down ? new Error('timeout') : url.endsWith('/status') ? { body: { v: 1 } } : { body: { lines: [], last: 0 } }));
  const b = createBots({ bots: [{ name: 'a', url: 'http://a' }], token: 't', fetchFn: f.fetchFn, now: () => 7 });
  await b.refreshAll();
  down = true;
  const [k] = await b.refreshAll();
  assert.strictEqual(k.online, false);
  assert.deepStrictEqual(k.status, { v: 1 });
  assert.strictEqual(k.lastSeen, 7);
});
test('bot redémarré : journal repris depuis le début', async () => {
  let phase = 0;
  const f = fake((url) => {
    if (url.endsWith('/status')) return { body: {} };
    phase++;
    if (phase === 1) return { body: { lines: [{ id: 5, level: 'info', at: 'x', text: 'a' }], last: 5 } };
    if (phase === 2) return { body: { lines: [], last: 1 } }; // identifiants repartis de 1
    return { body: { lines: [{ id: 1, level: 'info', at: 'x', text: 'neuf' }], last: 1 } };
  });
  const b = createBots({ bots: [{ name: 'a', url: 'http://a' }], token: 't', fetchFn: f.fetchFn });
  await b.refreshAll(); await b.refreshAll();
  assert.deepStrictEqual(b.get('a').logs.map((l) => l.text), ['neuf']);
});
test('config : erreur du bot transmise avec son code', async () => {
  const f = fake(() => ({ status: 400, body: { error: 'série inconnue' } }));
  const b = createBots({ bots: [{ name: 'a', url: 'http://a' }], token: 't', fetchFn: f.fetchFn });
  await assert.rejects(() => b.config('a', {}), (e) => e.status === 400 && /série inconnue/.test(e.message));
});
