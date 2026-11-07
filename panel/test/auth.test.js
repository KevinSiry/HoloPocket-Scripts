const test = require('node:test');
const assert = require('node:assert');
const a = require('../lib/auth');

test('mot de passe : bon / mauvais / empreinte invalide, sans « $ » dans l’empreinte', () => {
  const h = a.hashPassword('correct horse battery');
  assert.ok(!h.includes('$'));
  assert.strictEqual(a.verifyPassword('correct horse battery', h), true);
  assert.strictEqual(a.verifyPassword('autre chose', h), false);
  assert.strictEqual(a.verifyPassword('x', 'n’importe quoi'), false);
  assert.notStrictEqual(a.hashPassword('correct horse battery'), h, 'sel différent à chaque fois');
});
test('session : valide, expirée, falsifiée', () => {
  const s = 'k'.repeat(40);
  const t = a.createSession(s, 1000, 5000);
  assert.strictEqual(a.verifySession(s, t, 5500), true);
  assert.strictEqual(a.verifySession(s, t, 6001), false);
  assert.strictEqual(a.verifySession('autre'.repeat(8), t, 5500), false);
  assert.strictEqual(a.verifySession(s, t.replace(/^\d+/, '999999999999'), 5500), false);
  assert.strictEqual(a.verifySession(s, '', 5500), false);
  assert.strictEqual(a.verifySession(s, undefined, 5500), false);
});
test('limite d’essais : 5 échecs bloquent, la fenêtre expire, le succès remet à zéro', () => {
  let t = 0;
  const th = a.createThrottle({ now: () => t });
  for (let i = 0; i < 4; i++) th.fail('1.1.1.1');
  assert.strictEqual(th.retryAfterMs('1.1.1.1'), 0);
  th.fail('1.1.1.1');
  assert.ok(th.retryAfterMs('1.1.1.1') > 0);
  assert.strictEqual(th.retryAfterMs('2.2.2.2'), 0, 'autre adresse non touchée');
  t = 15 * 60000 + 1;
  assert.strictEqual(th.retryAfterMs('1.1.1.1'), 0);
  th.fail('3.3.3.3'); th.reset('3.3.3.3');
  assert.strictEqual(th.retryAfterMs('3.3.3.3'), 0);
});
test('cookies lus', () => assert.deepStrictEqual(a.parseCookies('a=1; hp_panel=x%2By'), { a: '1', hp_panel: 'x+y' }));
