const test = require('node:test');
const assert = require('node:assert');
const auth = require('../lib/auth');
const { createApp } = require('../server');

const PW = 'un mot de passe correct';
const HASH = auth.hashPassword(PW);
const SECRET = 's'.repeat(40);

function fakeBots(over = {}) {
  const calls = [];
  const state = { name: 'c1', online: true, lastSeen: Date.now(), status: { bot: { sessionOk: true }, account: { user: 'kev', quarantined: false, energy: { fullSince: null } }, trades: { fullSince: null }, scripts: [] }, logs: [{ id: 1, level: 'info', at: new Date().toISOString(), text: 'salut' }] };
  return {
    calls,
    names: () => ['c1'], has: (n) => n === 'c1', get: () => state,
    refreshAll: async () => [state],
    sets: async () => [{ id: 'x' }],
    config: async (n, p) => { calls.push(['config', n, p]); if (over.configError) throw Object.assign(new Error('série inconnue'), { status: 400 }); return { ok: true }; },
    restart: async (n) => { calls.push(['restart', n]); return { ok: true }; },
    ...over.fns,
  };
}

async function boot(opts = {}) {
  const bots = fakeBots(opts);
  const app = createApp({ passwordHash: HASH, secret: SECRET, bots, secureCookie: true, trustProxy: opts.trustProxy, ...opts.app });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const req = (method, path, { body, headers = {}, cookie } = {}) => fetch(base + path, {
    method, redirect: 'manual', body: body ? JSON.stringify(body) : undefined,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  const login = async (pw = PW, headers = {}) => req('POST', '/api/login', { body: { password: pw }, headers: { 'X-Panel': '1', ...headers } });
  const session = async () => (await login()).headers.get('set-cookie').split(';')[0];
  return { bots, req, login, session, close: () => app.close() };
}

test('page d’accueil : redirigée vers /login sans session, servie avec', async () => {
  const s = await boot();
  assert.strictEqual((await s.req('GET', '/')).status, 302);
  assert.strictEqual((await s.req('GET', '/', { cookie: await s.session() })).status, 200);
  assert.strictEqual((await s.req('GET', '/login')).status, 200);
  assert.strictEqual((await s.req('GET', '/healthz')).status, 200);
  s.close();
});
test('API : 401 sans session', async () => {
  const s = await boot();
  for (const p of ['/api/overview', '/api/logs', '/api/bots/c1/sets']) assert.strictEqual((await s.req('GET', p)).status, 401, p);
  s.close();
});
test('connexion : cookie HttpOnly, Secure, SameSite=Strict, 12 h', async () => {
  const s = await boot();
  const r = await s.login();
  assert.strictEqual(r.status, 200);
  const c = r.headers.get('set-cookie');
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Strict/); assert.match(c, /Max-Age=43200/);
  s.close();
});
test('connexion : mauvais mot de passe → 401 ; après 5 échecs → 429 même avec le bon', async () => {
  const s = await boot();
  for (let i = 0; i < 5; i++) assert.strictEqual((await s.login('faux')).status, 401);
  const r = await s.login();
  assert.strictEqual(r.status, 429);
  assert.ok(+r.headers.get('retry-after') > 0);
  s.close();
});
test('connexion : l’adresse vient de X-Forwarded-For seulement derrière Traefik', async () => {
  const direct = await boot();
  for (let i = 0; i < 5; i++) await direct.login('faux', { 'X-Forwarded-For': `9.9.9.${i}` });
  assert.strictEqual((await direct.login()).status, 429, 'en direct, l’en-tête est ignoré');
  direct.close();
  const proxied = await boot({ trustProxy: true });
  for (let i = 0; i < 5; i++) await proxied.login('faux', { 'X-Forwarded-For': '9.9.9.9' });
  assert.strictEqual((await proxied.login(PW, { 'X-Forwarded-For': '8.8.8.8' })).status, 200, 'autre adresse non bloquée');
  proxied.close();
});
test('modifications : refusées sans X-Panel, même connecté', async () => {
  const s = await boot();
  const cookie = await s.session();
  assert.strictEqual((await s.req('PUT', '/api/bots/c1/config', { body: { booster: { mode: 'auto' } }, cookie })).status, 403);
  assert.strictEqual((await s.req('POST', '/api/bots/c1/restart', { cookie })).status, 403);
  assert.strictEqual((await s.req('POST', '/api/login', { body: { password: PW } })).status, 403);
  assert.deepStrictEqual(s.bots.calls, []);
  s.close();
});
test('modifications : transmises au bot, erreur du bot renvoyée, compte inconnu → 404', async () => {
  const s = await boot();
  const cookie = await s.session();
  const h = { 'X-Panel': '1' };
  const ok = await s.req('PUT', '/api/bots/c1/config', { body: { scripts: { echanges: false } }, headers: h, cookie });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(s.bots.calls[0], ['config', 'c1', { scripts: { echanges: false } }]);
  assert.strictEqual((await s.req('POST', '/api/bots/c1/restart', { headers: h, cookie })).status, 200);
  assert.strictEqual((await s.req('PUT', '/api/bots/zzz/config', { body: {}, headers: h, cookie })).status, 404);
  s.close();
  const e = await boot({ configError: true });
  const r = await e.req('PUT', '/api/bots/c1/config', { body: {}, headers: h, cookie: await e.session() });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /série inconnue/);
  e.close();
});
test('bot injoignable pendant une modification → 502 sans détail technique', async () => {
  const s = await boot({ fns: { config: async () => { throw new Error('connect ECONNREFUSED 172.18.0.5:3100'); } } });
  const r = await s.req('PUT', '/api/bots/c1/config', { body: {}, headers: { 'X-Panel': '1' }, cookie: await s.session() });
  assert.strictEqual(r.status, 502);
  assert.ok(!/ECONNREFUSED|172/.test(JSON.stringify(await r.json())));
  s.close();
});
test('vue d’ensemble et journal', async () => {
  const s = await boot();
  const cookie = await s.session();
  const o = await (await s.req('GET', '/api/overview', { cookie })).json();
  assert.strictEqual(o.bots[0].name, 'c1');
  assert.deepStrictEqual(o.alerts, []);
  const l = await (await s.req('GET', '/api/logs?bot=c1', { cookie })).json();
  assert.strictEqual(l.lines[0].text, 'salut');
  assert.strictEqual(l.lines[0].bot, 'c1');
  s.close();
});
test('booster global : enregistré, appliqué aux comptes qui le suivent, entrée refusée si invalide', async () => {
  const pushed = [];
  const st = { name: 'c1', online: true, lastSeen: Date.now(), status: { booster: { mode: 'auto', setId: null }, bot: { sessionOk: true }, account: { quarantined: false, energy: { fullSince: null } }, trades: { fullSince: null }, scripts: [] }, logs: [] };
  const s = await boot({ fns: { get: () => st, refreshAll: async () => [st], config: async (n, p) => { pushed.push([n, p]); st.status.booster = { mode: p.booster.mode, setId: p.booster.setId || null }; return { ok: true }; } } });
  const cookie = await s.session();
  const h = { 'X-Panel': '1' };
  const bad = await s.req('PUT', '/api/booster/global', { body: { mode: 'fixed' }, headers: h, cookie });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await s.req('PUT', '/api/booster/global', { body: { mode: 'global' }, headers: h, cookie })).status, 400, '« global » n’a pas de sens pour le global');
  const ok = await s.req('PUT', '/api/booster/global', { body: { mode: 'fixed', setId: 'me05' }, headers: h, cookie });
  assert.deepStrictEqual(await ok.json(), { ok: true, failed: [] });
  assert.deepStrictEqual(pushed, [['c1', { booster: { mode: 'fixed', setId: 'me05' } }]]);
  const o = await (await s.req('GET', '/api/overview', { cookie })).json();
  assert.deepStrictEqual(o.booster.global, { mode: 'fixed', setId: 'me05' });
  assert.deepStrictEqual(o.bots[0].booster.choice, { mode: 'global' });
  // le compte prend son propre choix
  await s.req('PUT', '/api/bots/c1/booster', { body: { mode: 'auto' }, headers: h, cookie });
  assert.deepStrictEqual(pushed.at(-1), ['c1', { booster: { mode: 'auto' } }]);
  assert.strictEqual((await s.req('PUT', '/api/bots/zzz/booster', { body: { mode: 'auto' }, headers: h, cookie })).status, 404);
  // la route générale ne règle plus le booster
  assert.strictEqual((await s.req('PUT', '/api/bots/c1/config', { body: { booster: { mode: 'auto' } }, headers: h, cookie })).status, 400);
  s.close();
});
test('booster : exige l’en-tête X-Panel et une session', async () => {
  const s = await boot();
  assert.strictEqual((await s.req('PUT', '/api/booster/global', { body: { mode: 'auto' }, cookie: await s.session() })).status, 403);
  assert.strictEqual((await s.req('PUT', '/api/booster/global', { body: { mode: 'auto' }, headers: { 'X-Panel': '1' } })).status, 401);
  s.close();
});
test('déconnexion : cookie effacé ; en-têtes de sécurité présents', async () => {
  const s = await boot();
  const r = await s.req('POST', '/api/logout', { headers: { 'X-Panel': '1' } });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  const g = await s.req('GET', '/login');
  assert.match(g.headers.get('content-security-policy'), /default-src 'self'/);
  assert.strictEqual(g.headers.get('x-frame-options'), 'DENY');
  assert.match(g.headers.get('x-robots-tag'), /noindex/);
  s.close();
});
