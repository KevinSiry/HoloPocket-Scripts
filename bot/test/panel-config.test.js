const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pc = require('../panel-config');
const { createLogBuffer } = require('../log-buffer');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-')), 'panel-config.json');
const SETS = [{ id: 'me05', name: 'Nuit Noire' }, { id: 'sv1', name: 'Autre' }];

test('lecture : fichier absent ou corrompu → réglages par défaut', () => {
  const f = tmpFile();
  assert.deepStrictEqual(pc.readConfig(f), { booster: { mode: 'auto' }, scripts: {} });
  fs.writeFileSync(f, '{pas du json');
  assert.deepStrictEqual(pc.readConfig(f), { booster: { mode: 'auto' }, scripts: {} });
});

test('écriture atomique : aller-retour, aucun fichier temporaire laissé', () => {
  const f = tmpFile();
  pc.writeConfig(f, { booster: { mode: 'fixed', setId: 'me05' }, scripts: { echanges: false } });
  assert.deepStrictEqual(pc.readConfig(f), { booster: { mode: 'fixed', setId: 'me05' }, scripts: { echanges: false } });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['panel-config.json']);
});

test('sanitize : ignore tout ce qui est inattendu', () => {
  const c = pc.sanitize({ booster: { mode: 'fixed' }, scripts: { echanges: 'oui', pirate: true, recyclage: true }, extra: 1 });
  assert.deepStrictEqual(c, { booster: { mode: 'auto' }, scripts: { recyclage: true } });
});

test('fusion : le booster est remplacé, les scripts sont fusionnés', () => {
  const cur = { booster: { mode: 'fixed', setId: 'a' }, scripts: { echanges: false } };
  const next = pc.mergeConfig(cur, { booster: { mode: 'auto' }, scripts: { recyclage: true } });
  assert.deepStrictEqual(next, { booster: { mode: 'auto' }, scripts: { echanges: false, recyclage: true } });
});

test('scripts : le panel ajoute (true) ou retire (false) par rapport à la liste du .env', () => {
  const base = ['holopocket-auto-booster.user.js', 'holopocket-echanges.user.js'];
  assert.deepStrictEqual(pc.applyScripts(base, { echanges: false, 'achat-revente': true }),
    ['holopocket-auto-booster.user.js', 'holopocket-achat-revente.user.js']);
  assert.deepStrictEqual(pc.applyScripts(base, {}), base);
  assert.deepStrictEqual(pc.applyScripts(base, { 'auto-booster': true }), base); // déjà chargé : pas de doublon
});

test('validation : demandes correctes', () => {
  assert.strictEqual(pc.validatePatch({ booster: { mode: 'auto' } }, SETS).ok, true);
  assert.strictEqual(pc.validatePatch({ booster: { mode: 'fixed', setId: 'ME05' } }, SETS).ok, true);
  assert.strictEqual(pc.validatePatch({ scripts: { echanges: false, recyclage: true } }, SETS).ok, true);
});

test('validation : demandes refusées', () => {
  const bad = [
    null, [], {}, { inconnu: 1 }, { booster: null }, { booster: { mode: 'x' } }, { booster: { mode: 'fixed' } },
    { booster: { mode: 'fixed', setId: 'nope' } }, { scripts: [] }, { scripts: {} }, { scripts: { pirate: true } }, { scripts: { echanges: 'oui' } },
  ];
  for (const p of bad) assert.strictEqual(pc.validatePatch(p, SETS).ok, false, JSON.stringify(p));
});

test('journal : tampon circulaire et lecture incrémentale', () => {
  const b = createLogBuffer(3);
  for (let i = 1; i <= 5; i++) b.push('info', `ligne ${i}`);
  const all = b.since(0, 10);
  assert.deepStrictEqual(all.lines.map((l) => l.text), ['ligne 3', 'ligne 4', 'ligne 5']);
  assert.strictEqual(all.last, 5);
  assert.deepStrictEqual(b.since(4, 10).lines.map((l) => l.text), ['ligne 5']);
  assert.deepStrictEqual(b.since(5, 10).lines, []);
  assert.deepStrictEqual(b.since(0, 2).lines.map((l) => l.text), ['ligne 4', 'ligne 5']);
});
