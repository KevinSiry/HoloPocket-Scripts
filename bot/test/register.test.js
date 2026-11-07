const test = require('node:test');
const assert = require('node:assert');
const { tryRegister } = require('../register');

const call = (answers) => { const seen = []; const f = async (p, body) => { seen.push([p, body]); return answers[p] || { status: 404, body: {} }; }; f.seen = seen; return f; };
const U = { username: 'zorbi42', password: 'x' };

test('inscription réussie sur la première adresse', async () => {
  const c = call({ '/api/auth/register': { status: 201, body: { ok: true } } });
  assert.deepStrictEqual(await tryRegister(c, U), { ok: true, path: '/api/auth/register' });
  assert.deepStrictEqual(c.seen[0][1], U);
});
test('adresse introuvable → essaie la suivante', async () => {
  const c = call({ '/api/auth/signup': { status: 200, body: {} } });
  assert.deepStrictEqual(await tryRegister(c, U), { ok: true, path: '/api/auth/signup' });
  assert.strictEqual(c.seen.length, 2);
});
test('pseudo déjà pris (409 ou message) → taken', async () => {
  assert.strictEqual((await tryRegister(call({ '/api/auth/register': { status: 409, body: {} } }), U)).taken, true);
  const r = await tryRegister(call({ '/api/auth/register': { status: 400, body: { message: 'Ce pseudo est déjà utilisé' } } }), U);
  assert.strictEqual(r.taken, true);
  assert.strictEqual(r.error, 'Ce pseudo est déjà utilisé');
});
test('refus pour une autre raison : message transmis, pas taken, on n’essaie pas l’autre adresse', async () => {
  const c = call({ '/api/auth/register': { status: 422, body: { error: 'email requis' } } });
  const r = await tryRegister(c, U);
  assert.deepStrictEqual(r, { ok: false, taken: false, status: 422, error: 'email requis' });
  assert.strictEqual(c.seen.length, 1);
});
test('aucune adresse trouvée : message explicite', async () => {
  const r = await tryRegister(call({}), U, ['/a', '/b']);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /introuvable.*\/a, \/b.*HP_REGISTER_PATH/);
});
