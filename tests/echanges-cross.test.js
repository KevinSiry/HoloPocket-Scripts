// Échanges : paires de complément « valeur équivalente » quand il y a peu de paires de même rareté.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'holopocket-echanges.user.js'), 'utf8');
const cfgSrc = code.slice(code.indexOf('const CONFIG = {'), code.indexOf('};', code.indexOf('const CONFIG = {')) + 2);
const fnSrc = code.slice(code.indexOf('function buildPairs('), code.indexOf('// Pièces demandées'));
const buildPairs = new Function(`${cfgSrc}
  const val = (c) => (c.reverse ? c.reverseMarketValue : c.marketValue) ?? 0;
  const key = (c) => c.id + '|' + !!c.reverse;
  const isBlocked = () => false;
  ${fnSrc}
  return buildPairs;`)();
const card = (id, rank, v, o = {}) => ({ id, rank, rarity: 'r' + rank, marketValue: v, reverse: false, copies: 2, userCardIds: [id + '-1', id + '-2'], ...o });
const run = (ask, give) => buildPairs({ partner: 'bob', ask, give, wish: null }, new Set(), new Map());

test('aucune paire de même rareté : paire de valeur équivalente, rareté voisine', () => {
  const p = run([card('a1', 3, 20)], [card('g1', 2, 21), card('g2', 2, 60)]);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].give.id, 'g1');
  assert.strictEqual(p[0].cross, true);
  assert.strictEqual(p[0].coin, false);
});

test('valeur trop éloignée ou rareté trop éloignée : pas de paire de complément', () => {
  assert.strictEqual(run([card('a1', 3, 20)], [card('g1', 2, 40)]).length, 0);
  assert.strictEqual(run([card('a1', 5, 20)], [card('g1', 1, 20)]).length, 0);
});

test('assez de paires de même rareté : pas de complément', () => {
  const p = run([card('a1', 3, 20), card('a2', 3, 10), card('a3', 4, 30)], [card('g1', 3, 20), card('g2', 3, 10), card('g3', 2, 30)]);
  assert.deepStrictEqual(p.map((x) => x.ask.id).sort(), ['a1', 'a2']);
  assert.ok(p.every((x) => !x.cross));
});

test('une seule paire de même rareté : elle reste, le complément s’ajoute', () => {
  const p = run([card('a1', 3, 20), card('a3', 4, 30)], [card('g1', 3, 20), card('g3', 2, 31)]);
  assert.deepStrictEqual(p.map((x) => [x.ask.id, x.give.id, x.cross]), [['a1', 'g1', false], ['a3', 'g3', true]]);
});
