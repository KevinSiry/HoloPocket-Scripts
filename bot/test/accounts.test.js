const test = require('node:test');
const assert = require('node:assert');
const { resolveAccounts } = require('../accounts');

const ALL = ['Alice', 'Bob', 'Cible'];

test('chaque compte exclut les autres comptes, jamais lui-même', () => {
  assert.deepStrictEqual(resolveAccounts({ username: 'alice', accounts: ALL, priorityTarget: 'Cible' }).exclude, ['Bob', 'Cible']);
  assert.deepStrictEqual(resolveAccounts({ username: 'Bob', accounts: ALL, priorityTarget: 'Cible' }).exclude, ['Alice', 'Cible']);
});
test('la cible prioritaire reste dans les exclusions des autres (échanges normaux) et n’a pas de cible', () => {
  const t = resolveAccounts({ username: 'Cible', accounts: ALL, priorityTarget: 'cible' });
  assert.deepStrictEqual(t.exclude, ['Alice', 'Bob']);
  assert.strictEqual(t.priorityTarget, '');
  assert.strictEqual(t.isTarget, true);
  const a = resolveAccounts({ username: 'Alice', accounts: ALL, priorityTarget: 'Cible' });
  assert.strictEqual(a.priorityTarget, 'Cible');
  assert.strictEqual(a.isTarget, false);
});
test('HP_EXCLUDE s’ajoute, sans doublon', () => {
  assert.deepStrictEqual(resolveAccounts({ username: 'Alice', accounts: ALL, exclude: ['bob', 'Zed'] }).exclude, ['bob', 'Zed', 'Cible']);
});
test('sans HP_ACCOUNTS : comportement d’avant', () => {
  assert.deepStrictEqual(resolveAccounts({ username: 'Alice', exclude: ['Bob'], priorityTarget: 'X' }), { exclude: ['Bob'], priorityTarget: 'X', isTarget: false });
});
test('compte par cookie (pseudo inconnu) : exclut toute la liste', () => {
  assert.deepStrictEqual(resolveAccounts({ username: '', accounts: ALL }).exclude, ALL);
});
