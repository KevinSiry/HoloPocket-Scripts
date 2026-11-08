const test = require('node:test');
const assert = require('node:assert');
const { computeAlerts } = require('../lib/alerts');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const bot = (over = {}, st = {}) => ({
  name: 'c1', online: true, lastSeen: NOW, logs: [],
  status: {
    bot: { sessionOk: true },
    account: { user: 'k', quarantined: false, energy: { stock: 1, max: 10, fullSince: null } },
    trades: { open: 3, max: 20, fullSince: null },
    scripts: [{ name: 'auto-booster', on: true }],
    ...st,
  },
  ...over,
});
const codes = (b) => computeAlerts([b], NOW).map((a) => a.code);

test('bot en bonne santé : aucune alerte', () => assert.deepStrictEqual(codes(bot()), []));
test('hors ligne : seulement après 1 min', () => {
  assert.deepStrictEqual(codes(bot({ online: false, lastSeen: NOW - 40000 })), []);
  assert.deepStrictEqual(codes(bot({ online: false, lastSeen: NOW - 70000 })), ['offline']);
  assert.deepStrictEqual(codes(bot({ online: false, lastSeen: null })), ['offline']);
});
test('session perdue et quarantaine', () => {
  assert.deepStrictEqual(codes(bot({}, { bot: { sessionOk: false }, account: null })), ['session']);
  assert.deepStrictEqual(codes(bot({}, { account: { quarantined: true, energy: { fullSince: null } } })), ['quarantine']);
});
test('échanges 20/20 depuis plus de 2 h', () => {
  assert.deepStrictEqual(codes(bot({}, { trades: { open: 20, max: 20, fullSince: iso(60 * 60000) } })), []);
  assert.deepStrictEqual(codes(bot({}, { trades: { open: 20, max: 20, fullSince: iso(121 * 60000) } })), ['trades-full']);
});
test('énergie pleine > 10 min seulement si l’ouverture auto est active', () => {
  const full = { quarantined: false, energy: { stock: 10, max: 10, fullSince: iso(11 * 60000) } };
  assert.deepStrictEqual(codes(bot({}, { account: full })), ['energy-full']);
  assert.deepStrictEqual(codes(bot({}, { account: full, scripts: [{ name: 'auto-booster', on: false }] })), []);
  assert.deepStrictEqual(codes(bot({}, { account: { ...full, energy: { fullSince: iso(5 * 60000) } } })), []);
});
test('erreur de script dans les 15 dernières minutes', () => {
  assert.deepStrictEqual(codes(bot({ logs: [{ level: 'error', at: iso(5 * 60000), text: 'boom' }] })), ['script-error']);
  assert.deepStrictEqual(codes(bot({ logs: [{ level: 'error', at: iso(20 * 60000), text: 'vieux' }] })), []);
  assert.deepStrictEqual(codes(bot({ logs: [{ level: 'warn', at: iso(1000), text: 'x' }] })), []);
});

const { createAlertTracker, WARN_TTL } = require('../lib/alerts');
test('un avertissement s’efface seul, une erreur reste, la fermeture est oubliée quand le problème cesse', () => {
  const t = createAlertTracker();
  const w = { bot: 'a', level: 'warn', code: 'x', text: 't' }, e = { bot: 'a', level: 'error', code: 'y', text: 't' };
  assert.equal(t.apply([w, e], 0).length, 2);
  const late = WARN_TTL + 1;
  assert.deepEqual(t.apply([w, e], late).map((a) => a.code), ['y']);
  t.dismiss('a|y');
  assert.equal(t.apply([w, e], late + 1).length, 0);
  assert.equal(t.apply([], late + 2).length, 0);
  assert.equal(t.apply([e], late + 3).length, 1);   // revenu après avoir cessé : réaffiché
  assert.equal(t.apply([w], late + 4).length, 1);   // l'horloge de l'avertissement repart
});
