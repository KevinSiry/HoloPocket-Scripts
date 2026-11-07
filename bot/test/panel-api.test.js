const test = require('node:test');
const assert = require('node:assert');
const { createPanelServer } = require('../panel-api');
const { createLogBuffer } = require('../log-buffer');

const TOKEN = 'jeton-de-test-0123456789';
const SETS = [{ id: 'me05', name: 'Nuit Noire' }];

async function start(over = {}) {
  const calls = { applied: [], restarted: 0 };
  const logs = createLogBuffer(50);
  logs.push('info', 'un'); logs.push('error', 'deux');
  const server = createPanelServer({
    token: TOKEN,
    status: async () => ({ name: 'compte1', account: { user: 'kevin' } }),
    logs,
    sets: async () => SETS,
    applyConfig: async (p) => { calls.applied.push(p); return { scriptsReloaded: !!p.scripts }; },
    restart: () => { calls.restarted++; },
    ...over,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, { token = TOKEN, body, raw } = {}) => fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { call, calls, close: () => new Promise((r) => server.close(r)) };
}

test('sans jeton, l’API ne démarre pas', () => {
  assert.throws(() => createPanelServer({}), /PANEL_TOKEN/);
});

test('authentification : 401 sans jeton, avec un mauvais jeton, et même sur une route inconnue', async () => {
  const s = await start();
  try {
    for (const t of [null, 'mauvais', TOKEN + 'x']) {
      assert.strictEqual((await s.call('GET', '/status', { token: t })).status, 401);
    }
    assert.strictEqual((await s.call('GET', '/nimporte', { token: null })).status, 401);
    assert.strictEqual((await s.call('GET', '/nimporte')).status, 404);
  } finally { await s.close(); }
});

test('GET /status et GET /sets', async () => {
  const s = await start();
  try {
    assert.deepStrictEqual(await (await s.call('GET', '/status')).json(), { name: 'compte1', account: { user: 'kevin' } });
    assert.deepStrictEqual(await (await s.call('GET', '/sets')).json(), SETS);
  } finally { await s.close(); }
});

test('GET /logs : lecture incrémentale', async () => {
  const s = await start();
  try {
    const all = await (await s.call('GET', '/logs')).json();
    assert.deepStrictEqual(all.lines.map((l) => [l.level, l.text]), [['info', 'un'], ['error', 'deux']]);
    const none = await (await s.call('GET', `/logs?after=${all.last}`)).json();
    assert.deepStrictEqual(none.lines, []);
  } finally { await s.close(); }
});

test('PUT /config : patch valide appliqué', async () => {
  const s = await start();
  try {
    const r = await s.call('PUT', '/config', { body: { booster: { mode: 'fixed', setId: 'me05' }, scripts: { echanges: false } } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, scriptsReloaded: true });
    assert.deepStrictEqual(s.calls.applied, [{ booster: { mode: 'fixed', setId: 'me05' }, scripts: { echanges: false } }]);
  } finally { await s.close(); }
});

test('PUT /config : demandes refusées, rien n’est appliqué', async () => {
  const s = await start();
  try {
    const bad = [
      { body: { booster: { mode: 'fixed', setId: 'inconnue' } } },
      { body: { scripts: { pirate: true } } },
      { body: { nimporte: 1 } },
      { raw: '{pas du json' },
    ];
    for (const b of bad) assert.strictEqual((await s.call('PUT', '/config', b)).status, 400, JSON.stringify(b));
    assert.deepStrictEqual(s.calls.applied, []);
  } finally { await s.close(); }
});

test('PUT /config : corps trop volumineux → 413', async () => {
  const s = await start();
  try {
    let status;
    try { status = (await s.call('PUT', '/config', { raw: JSON.stringify({ scripts: { echanges: true }, pad: 'x'.repeat(20000) }) })).status; } catch { status = 'coupé'; }
    assert(status === 413 || status === 'coupé', `statut ${status}`);
    assert.deepStrictEqual(s.calls.applied, []);
  } finally { await s.close(); }
});

test('POST /restart : répond 202 puis arrête le bot', async () => {
  const s = await start();
  try {
    const r = await s.call('POST', '/restart');
    assert.strictEqual(r.status, 202);
    assert.strictEqual(s.calls.restarted, 0);
    await new Promise((res) => setTimeout(res, 400));
    assert.strictEqual(s.calls.restarted, 1);
  } finally { await s.close(); }
});

test('erreur interne : 500 avec message, le serveur reste en vie', async () => {
  const s = await start({ status: async () => { throw new Error('page injoignable'); } });
  try {
    const r = await s.call('GET', '/status');
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(await r.json(), { error: 'page injoignable' });
    assert.strictEqual((await s.call('GET', '/sets')).status, 200);
  } finally { await s.close(); }
});
