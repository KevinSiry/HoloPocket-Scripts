const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createFleet, safeDir } = require('../fleet');

const TOKEN = 't'.repeat(20);

function setup(over = {}) {
  let accounts = over.accounts || [{ username: 'Alice', password: 'pa', enabled: true }, { username: 'Bob', password: 'pb', enabled: true }];
  let clock = 1_000_000;
  const started = [], stopped = [], refreshed = [], regs = [];
  const handles = {};
  const start = async (o) => {
    if (over.failFor && over.failFor.has(o.name) && !over.failFor.fixed) throw Object.assign(new Error('identifiants refusés'), { retryAfterMs: 60000 });
    started.push(o.name);
    const h = {
      status: async () => ({ name: o.name }), sets: async () => [{ id: 's' }], applyConfig: async (p) => ({ ok: true, p }),
      refreshAccounts: async (l) => { refreshed.push([o.name, l]); }, stop: async () => { stopped.push(o.name); },
      onFatal: o.onFatal, profileDir: o.profileDir, cfg: o.cfg,
    };
    handles[o.name] = h; return h;
  };
  const fleet = createFleet({
    env: {}, root: '/app', token: TOKEN, panelUrl: 'http://panel:8081',
    start, makeConfig: (a) => ({ ...a }), register: async (b) => { regs.push(b); return { ok: true, path: '/api/auth/register' }; },
    now: () => clock,
    fetchFn: async () => { if (over.panelDown) throw new Error('ECONNREFUSED'); return { ok: true, json: async () => ({ accounts }) }; },
  });
  return { fleet, started, stopped, refreshed, regs, handles, set: (a) => { accounts = a; }, tick: (ms) => { clock += ms; }, over };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

async function call(fleet, method, path, body, token = TOKEN) {
  const srv = fleet.server();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ port: srv.address().port, method, path, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  } finally { srv.close(); }
}

test('dossiers de profil : sûrs et en minuscules', () => assert.strictEqual(safeDir('Al/ice..X'), 'al_ice__x'));

test('synchronisation : démarre les comptes du panel, un profil chacun, exclusions = les autres comptes', async () => {
  const s = setup();
  assert.strictEqual(await s.fleet.sync(), true);
  await settle();
  assert.deepStrictEqual(s.started.sort(), ['Alice', 'Bob']);
  assert.strictEqual(s.handles.Alice.profileDir, '/app/profile/alice');
  assert.deepStrictEqual(s.handles.Alice.cfg.allAccounts, ['Alice', 'Bob']);
  assert.deepStrictEqual(s.refreshed, [], 'au démarrage, la liste est déjà dans la configuration');
  s.set([...(await (async () => [{ username: 'Alice', password: 'pa', enabled: true }, { username: 'Bob', password: 'pb', enabled: true }])()), { username: 'Cleo', password: 'pc', enabled: true }]);
  await s.fleet.sync(); await settle();
  assert.deepStrictEqual(s.refreshed.map((r) => r[0]).sort(), ['Alice', 'Bob'], 'les comptes en marche réécrivent leurs exclusions');
  assert.deepStrictEqual(s.refreshed[0][1], ['Alice', 'Bob', 'Cleo']);
});
test('compte ajouté puis retiré ou désactivé : lancé puis arrêté', async () => {
  const s = setup();
  await s.fleet.sync(); await settle();
  s.set([{ username: 'Alice', password: 'pa', enabled: true }, { username: 'Bob', password: 'pb', enabled: false }, { username: 'Cleo', password: 'pc', enabled: true }]);
  await s.fleet.sync(); await settle();
  assert.deepStrictEqual(s.stopped, ['Bob']);
  assert.ok(s.started.includes('Cleo'));
  assert.deepStrictEqual([...s.fleet.entries().keys()].sort(), ['alice', 'cleo']);
});
test('mot de passe changé : le compte est relancé', async () => {
  const s = setup();
  await s.fleet.sync(); await settle();
  s.set([{ username: 'Alice', password: 'nouveau', enabled: true }, { username: 'Bob', password: 'pb', enabled: true }]);
  await s.fleet.sync(); await settle();
  assert.strictEqual(s.started.filter((n) => n === 'Alice').length, 2);
});
test('panel injoignable : les comptes déjà lancés continuent', async () => {
  const s = setup();
  await s.fleet.sync(); await settle();
  s.over.panelDown = true;
  assert.strictEqual(await s.fleet.sync(), false);
  assert.deepStrictEqual(s.stopped, []);
});
test('un compte qui échoue n’empêche pas les autres, et est relancé seulement après son délai', async () => {
  const s = setup({ failFor: new Set(['Bob']) });
  await s.fleet.sync(); await settle();
  assert.deepStrictEqual(s.started, ['Alice']);
  const bob = s.fleet.entries().get('bob');
  assert.strictEqual(bob.state, 'error');
  assert.match(bob.error, /identifiants refusés/);
  s.fleet.retryDue(); await settle();
  assert.strictEqual(s.started.length, 1, 'trop tôt');
  s.tick(61000); s.over.failFor.fixed = true;
  s.fleet.retryDue(); await settle();
  assert.deepStrictEqual(s.started, ['Alice', 'Bob']);
  assert.strictEqual(bob.state, 'running');
});
test('compte tombé en cours de route (onFatal) : arrêté proprement, relancé plus tard', async () => {
  const s = setup();
  await s.fleet.sync(); await settle();
  s.handles.Alice.onFatal('page plantée'); await settle();
  assert.deepStrictEqual(s.stopped, ['Alice']);
  assert.strictEqual(s.fleet.entries().get('alice').state, 'error');
  s.tick(31000); s.fleet.retryDue(); await settle();
  assert.strictEqual(s.fleet.entries().get('alice').state, 'running');
});
test('API : jeton obligatoire, liste, état d’un compte, 503 quand arrêté, journal toujours lisible', async () => {
  const s = setup({ failFor: new Set(['Bob']) });
  await s.fleet.sync(); await settle();
  assert.strictEqual((await call(s.fleet, 'GET', '/accounts', null, null)).status, 401);
  assert.strictEqual((await call(s.fleet, 'GET', '/accounts', null, 'faux')).status, 401);
  const l = await call(s.fleet, 'GET', '/accounts');
  assert.deepStrictEqual(l.body.map((x) => [x.name, x.state]), [['Alice', 'running'], ['Bob', 'error']]);
  assert.deepStrictEqual((await call(s.fleet, 'GET', '/accounts/Alice/status')).body, { name: 'Alice' });
  assert.strictEqual((await call(s.fleet, 'GET', '/accounts/alice/sets')).status, 200, 'insensible à la casse');
  const down = await call(s.fleet, 'GET', '/accounts/Bob/status');
  assert.strictEqual(down.status, 503);
  assert.match(down.body.error, /identifiants refusés/);
  const logs = await call(s.fleet, 'GET', '/accounts/Bob/logs');
  assert.strictEqual(logs.status, 200);
  assert.match(logs.body.lines.at(-1).text, /Compte arrêté/);
  assert.strictEqual((await call(s.fleet, 'GET', '/accounts/Zed/status')).status, 404);
});
test('API : configuration validée puis transmise au compte ; redémarrage d’un seul compte', async () => {
  const s = setup();
  await s.fleet.sync(); await settle();
  const ok = await call(s.fleet, 'PUT', '/accounts/Alice/config', { scripts: { echanges: false } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.body.p, { scripts: { echanges: false } });
  const bad = await call(s.fleet, 'PUT', '/accounts/Alice/config', { booster: { mode: 'fixed', setId: 'inconnue' } });
  assert.strictEqual(bad.status, 400);
  const r = await call(s.fleet, 'POST', '/accounts/Alice/restart');
  assert.strictEqual(r.status, 202);
  await new Promise((res) => setTimeout(res, 300));
  assert.strictEqual(s.started.filter((n) => n === 'Alice').length, 2);
  assert.strictEqual(s.started.filter((n) => n === 'Bob').length, 1);
});
test('API : inscription transmise, une à la fois', async () => {
  const s = setup();
  const bad = await call(s.fleet, 'POST', '/register', { username: 1 });
  assert.strictEqual(bad.status, 400);
  const ok = await call(s.fleet, 'POST', '/register', { username: 'zorbi42', password: 'pw' });
  assert.deepStrictEqual(ok.body, { ok: true, path: '/api/auth/register' });
  assert.deepStrictEqual(s.regs, [{ username: 'zorbi42', password: 'pw' }]);
});
