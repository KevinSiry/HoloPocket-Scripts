const test = require('node:test');
const assert = require('node:assert');
const { createStats } = require('../lib/stats');

const D = (s) => Date.parse(s);
test('nouvelles cartes du jour : gain net depuis la fin du dernier jour connu', () => {
  let t = D('2026-11-19T10:00:00Z');
  const s = createStats(null, { now: () => t });
  assert.strictEqual(s.today('a'), null);
  s.record('a', 100, 500);
  assert.strictEqual(s.today('a'), 0);
  s.record('a', 104, 500);
  assert.strictEqual(s.today('a'), 4);
  t = D('2026-11-20T08:00:00Z');
  s.record('a', 109, 500); // 5 cartes gagnées pendant la nuit : comptées sur le nouveau jour
  s.record('a', 112, 500);
  assert.strictEqual(s.today('a'), 8);
  const h = s.history(3, ['a', 'b']);
  assert.deepStrictEqual(h.days, ['2026-11-18', '2026-11-19', '2026-11-20']);
  assert.deepStrictEqual(h.bots.a.map((x) => x && x.gain), [null, 4, 8]);
  assert.deepStrictEqual(h.bots.b, [null, null, null]);
});

test('le jour change à minuit heure de Paris, pas en UTC', () => {
  let t = D('2026-11-19T22:30:00Z'); // 23 h 30 à Paris
  const s = createStats(null, { now: () => t });
  s.record('a', 10, 50);
  t = D('2026-11-19T23:30:00Z'); // 0 h 30 le 20 à Paris
  s.record('a', 13, 50);
  assert.strictEqual(s.today('a'), 3);
  assert.deepStrictEqual(s.history(2, ['a']).days, ['2026-11-19', '2026-11-20']);
});

test('changement de source du chiffre : l’historique est recalé, pas de faux gain', () => {
  let t = D('2026-11-19T10:00:00Z');
  const s = createStats(null, { now: () => t });
  s.record('a', 100, 500, 'sets'); s.record('a', 104, 500, 'sets');
  t = D('2026-11-20T10:00:00Z');
  s.record('a', 106, 500, 'sets');           // +2 aujourd'hui
  s.record('a', 255, null, 'profile');       // même instant, autre source (+149 d'écart)
  assert.strictEqual(s.today('a'), 2);
  s.record('a', 258, null, 'profile');
  assert.strictEqual(s.today('a'), 5);
  assert.deepStrictEqual(s.history(2, ['a']).bots.a.map((x) => x.gain), [4, 5]);
});
