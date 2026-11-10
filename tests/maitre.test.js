// Stratège du Maître : lecture des annonces, chances simulées, décision.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'holopocket-maitre.user.js'), 'utf8');
const ctx = { window: { __HP_TEST__: true }, Math, Map, Set, Number, Array, Object, JSON, String, RegExp };
vm.runInNewContext(code, ctx);
const E = ctx.window.__hpMaitreEngine;

const pk = (name, type, rarity, stage = 'Basic') => ({ name, category: 'Pokemon', type, rarity, stage, rank: 1 });
const tr = (name, rarity) => ({ name, category: 'Trainer', type: null, rarity, stage: null, rank: 2 });
const pack = [pk('Bulbizarre', 'Grass', 'C'), pk('Salamèche', 'Fire', 'C'), pk('Tortank ex', 'Water', 'R', 'Stage2'), tr('Total Soin', 'U')];
const RAR = [{ rarity: 'C', rank: 1 }, { rarity: 'Rare Holo', rank: 3 }];
const ok = (text, cards = pack) => { const p = E.parseCall(text, RAR); assert.ok(p, 'non lue : ' + text); return p.test(cards); };

test('lecture des annonces', () => {
  assert.strictEqual(ok('3 types de Pokémon différents'), true);
  assert.strictEqual(ok('4 types de Pokémon différents'), false);
  assert.strictEqual(ok('2 cartes Dresseur'), false);
  assert.strictEqual(ok('Une carte Dresseur'), true);
  assert.strictEqual(ok('Un Pokémon Eau'), true);
  assert.strictEqual(ok('3 Pokémon Psy'), false);
  assert.strictEqual(ok('Une carte ex'), true);
  assert.strictEqual(ok('2 Pokémon de base'), true);
  assert.strictEqual(ok('Un exemplaire de « Total Soin »'), true);
  assert.strictEqual(ok('Aucune carte Dresseur'), false);
  assert.strictEqual(ok('Une carte Rare Holo', [{ ...pack[0], rarity: 'Rare Holo' }]), true);
  assert.strictEqual(E.parseCall('Un Pokémon de plus de 150 PV', RAR), null);
  assert.strictEqual(E.parseCall('Une prophétie obscure', RAR), null);
});

test('simulation : chances exactes retrouvées', () => {
  const cards = [pk('A', 'Grass', 'C'), pk('B', 'Fire', 'C'), tr('T', 'C'), tr('T2', 'C')];
  const slots = [{ pools: [{ rarity: 'C', chance: 1 }] }, { pools: [{ rarity: 'C', chance: 1 }] }];
  const [p2, p1, unk] = E.simulate(cards, slots, [E.parseCall('2 cartes Dresseur'), E.parseCall('Une carte Dresseur'), null]);
  assert.ok(Math.abs(p2 - 0.25) < 0.01, String(p2));
  assert.ok(Math.abs(p1 - 0.75) < 0.01, String(p1));
  assert.strictEqual(unk, null);
});

const TH = [3, 5];
test('décision : en avance on assure, en retard on tente la folie', () => {
  const offer = [{ index: 0, p: 0.78, points: 2 }, { index: 1, p: 0.48, points: 3 }, { index: 2, p: 0.04, points: 33 }];
  const safe = E.solve({ left: 5, need: 2, offer, future: [offer], thresholds: TH, objective: 'win' });
  assert.strictEqual(safe.choices[0].index, 0);
  const late = E.solve({ left: 1, need: 20, offer, future: [offer], thresholds: TH, objective: 'win' });
  assert.strictEqual(late.choices[0].index, 2);
  assert.ok(Math.abs(late.value - 0.04) < 1e-9);
});

test('décision : valeur = formule à la main sur un cas à deux boosters', () => {
  const offer = [{ index: 0, p: 0.5, points: 1 }];
  const r = E.solve({ left: 2, need: 2, offer, future: [offer], thresholds: TH, objective: 'win' });
  assert.ok(Math.abs(r.value - 0.25) < 1e-9); // deux réussites de suite, 0 booster restant → 1 étoile
});

test('quasi-égalité : on prend la plus sûre ; repère « toujours le plus sûr »', () => {
  const offer = [{ index: 0, p: 0.783, points: 2 }, { index: 1, p: 0.483, points: 3 }, { index: 2, p: 0.0387, points: 33 }];
  const r = E.solve({ left: 10, need: 21, offer, future: [offer], thresholds: TH, objective: 'win' });
  assert.strictEqual(r.choices[0].index, 1); // 33,0 % contre 33,0 % pour la folie
  assert.strictEqual(r.safe, 0); // 10 × 2 points = 20 : la sécurité seule ne peut pas atteindre 21
});
