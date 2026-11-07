const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, createReconciler } = require('../lib/booster');

test('par défaut : global = auto, tous les comptes suivent le global', () => {
  const s = createStore(null);
  assert.deepStrictEqual(s.global(), { mode: 'auto' });
  assert.deepStrictEqual(s.choice('c1'), { mode: 'global' });
  s.setGlobal({ mode: 'fixed', setId: 'me05' });
  assert.deepStrictEqual(s.desired('c1'), { mode: 'fixed', setId: 'me05' });
});
test('choix propre à un compte, puis retour au global', () => {
  const s = createStore(null);
  s.setGlobal({ mode: 'fixed', setId: 'me05' });
  s.setChoice('c2', { mode: 'fixed', setId: 'sv1' });
  assert.deepStrictEqual(s.desired('c2'), { mode: 'fixed', setId: 'sv1' });
  assert.deepStrictEqual(s.desired('c1'), { mode: 'fixed', setId: 'me05' });
  s.setChoice('c2', { mode: 'auto' });
  assert.deepStrictEqual(s.desired('c2'), { mode: 'auto' });
  s.setChoice('c2', { mode: 'global' });
  assert.deepStrictEqual(s.choice('c2'), { mode: 'global' });
});
test('persistance : écriture atomique, relecture, fichier corrompu → défauts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-panel-'));
  const f = path.join(dir, 'panel-state.json');
  const a = createStore(f);
  a.setGlobal({ mode: 'fixed', setId: 'me05' }); a.setChoice('c2', { mode: 'auto' });
  assert.deepStrictEqual(fs.readdirSync(dir), ['panel-state.json']);
  const b = createStore(f);
  assert.deepStrictEqual(b.global(), { mode: 'fixed', setId: 'me05' });
  assert.deepStrictEqual(b.choice('c2'), { mode: 'auto' });
  fs.writeFileSync(f, '{pas du json');
  assert.deepStrictEqual(createStore(f).global(), { mode: 'auto' });
  fs.writeFileSync(f, JSON.stringify({ global: { mode: 'fixed', setId: '' }, accounts: { x: { mode: 'bidon' } } }));
  const c = createStore(f);
  assert.deepStrictEqual(c.global(), { mode: 'auto' });
  assert.deepStrictEqual(c.choice('x'), { mode: 'global' });
});

const bot = (name, mode, setId, online = true) => ({ name, online, status: { booster: { mode, setId: setId || null } } });

test('rapprochement : pousse seulement aux bots qui diffèrent', async () => {
  const s = createStore(null);
  s.setGlobal({ mode: 'fixed', setId: 'me05' });
  const calls = [];
  const r = createReconciler({ store: s, push: async (n, p) => { calls.push([n, p]); } });
  await r.run([bot('c1', 'auto'), bot('c2', 'fixed', 'me05'), bot('c3', 'fixed', 'sv1'), bot('c4', 'auto', null, false)]);
  assert.deepStrictEqual(calls, [['c1', { booster: { mode: 'fixed', setId: 'me05' } }], ['c3', { booster: { mode: 'fixed', setId: 'me05' } }]]);
});
test('un compte avec son propre choix n’est pas touché par le global', async () => {
  const s = createStore(null);
  s.setGlobal({ mode: 'fixed', setId: 'me05' });
  s.setChoice('c1', { mode: 'auto' });
  const calls = [];
  const r = createReconciler({ store: s, push: async (n, p) => { calls.push(n); } });
  await r.run([bot('c1', 'auto'), bot('c2', 'auto')]);
  assert.deepStrictEqual(calls, ['c2']);
});
test('échec : erreur gardée, pas de nouvel essai avant 1 min, succès efface l’erreur', async () => {
  let t = 0, fail = true, n = 0;
  const s = createStore(null);
  s.setGlobal({ mode: 'fixed', setId: 'zzz' });
  const r = createReconciler({ store: s, now: () => t, push: async () => { n++; if (fail) throw new Error('série inconnue'); } });
  await r.run([bot('c1', 'auto')]);
  assert.deepStrictEqual(r.errors(), { c1: 'série inconnue' });
  t = 30000; await r.run([bot('c1', 'auto')]);
  assert.strictEqual(n, 1);
  t = 61000; fail = false; await r.run([bot('c1', 'auto')]);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(r.errors(), {});
});
test('bot redémarré avec un autre réglage : remis au global au passage suivant', async () => {
  const s = createStore(null);
  const calls = [];
  const r = createReconciler({ store: s, push: async (n) => { calls.push(n); } });
  await r.run([bot('c1', 'auto')]);
  assert.deepStrictEqual(calls, []);
  s.setGlobal({ mode: 'fixed', setId: 'me05' });
  await r.run([bot('c1', 'auto')]);
  assert.deepStrictEqual(calls, ['c1']);
});
