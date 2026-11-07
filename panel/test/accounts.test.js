const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVault } = require('../lib/vault');
const { createAccountStore } = require('../lib/accounts');
const { randomUsername, randomPassword } = require('../lib/names');

const SECRET = 'z'.repeat(40);

test('coffre : aller-retour, chiffré différemment à chaque fois, illisible avec une autre clé ou modifié', () => {
  const v = createVault(SECRET);
  const a = v.encrypt('Sup3r mot de passe');
  assert.ok(!a.includes('Sup3r'));
  assert.notStrictEqual(v.encrypt('Sup3r mot de passe'), a);
  assert.strictEqual(v.decrypt(a), 'Sup3r mot de passe');
  assert.throws(() => createVault('y'.repeat(40)).decrypt(a));
  const parts = a.split(':'); parts[3] = Buffer.from('autre').toString('base64');
  assert.throws(() => v.decrypt(parts.join(':')));
});

function store(file) { return createAccountStore({ file, vault: createVault(SECRET) }); }

test('comptes : ajout, doublon (insensible à la casse), pseudo invalide, aucun mot de passe en clair dans la liste ni le fichier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-acc-'));
  const f = path.join(dir, 'accounts.json');
  const s = store(f);
  s.add({ username: 'Alice', password: 'motdepasse1' });
  assert.throws(() => s.add({ username: 'alice', password: 'x' }), (e) => e.status === 409);
  assert.throws(() => s.add({ username: 'a b', password: 'x' }), (e) => e.status === 400);
  assert.throws(() => s.add({ username: 'Valide', password: '' }), (e) => e.status === 400);
  assert.deepStrictEqual(Object.keys(s.list()[0]).sort(), ['createdAt', 'enabled', 'source', 'username']);
  assert.ok(!fs.readFileSync(f, 'utf8').includes('motdepasse1'));
  assert.strictEqual(s.reveal('ALICE'), 'motdepasse1');
  assert.strictEqual((fs.statSync(f).mode & 0o777), 0o600);
});
test('comptes : désactiver, supprimer, relecture du fichier, liste pour la flotte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-acc-'));
  const f = path.join(dir, 'accounts.json');
  const s = store(f);
  s.add({ username: 'Alice', password: 'pa1' }); s.add({ username: 'Bobby', password: 'pb2', source: 'created' });
  s.setEnabled('Bobby', false);
  const again = store(f);
  assert.deepStrictEqual(again.fleetList(), [{ username: 'Alice', password: 'pa1', enabled: true }, { username: 'Bobby', password: 'pb2', enabled: false }]);
  again.remove('alice');
  assert.deepStrictEqual(again.usernames(), ['Bobby']);
  assert.throws(() => again.remove('inconnu'), (e) => e.status === 404);
  assert.deepStrictEqual(fs.readdirSync(dir), ['accounts.json'], 'aucun fichier temporaire');
});
test('comptes : clé changée → comptes illisibles ignorés par la flotte, sans planter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-acc-'));
  const f = path.join(dir, 'accounts.json');
  store(f).add({ username: 'Alice', password: 'pa1' });
  const other = createAccountStore({ file: f, vault: createVault('q'.repeat(40)) });
  assert.deepStrictEqual(other.fleetList(), []);
  assert.strictEqual(other.list().length, 1);
});

test('pseudos aléatoires : formes variées, longueur 6-14, caractères autorisés, aucune racine commune', () => {
  const seen = [];
  for (let i = 0; i < 300; i++) {
    const u = randomUsername(seen);
    assert.match(u, /^[A-Za-z0-9_]{6,14}$/, u);
    assert.ok(!seen.some((e) => e.slice(0, 3).toLowerCase() === u.slice(0, 3).toLowerCase()), `${u} ressemble à un pseudo existant`);
    seen.push(u);
    if (seen.length > 25) seen.shift();
  }
  const sample = new Set(Array.from({ length: 40 }, () => randomUsername()));
  assert.ok(sample.size > 35, 'pseudos tous différents');
  assert.ok([...sample].some((u) => /\d/.test(u)) && [...sample].some((u) => !/\d/.test(u)), 'avec et sans chiffres');
});
test('mots de passe aléatoires : 20 caractères, majuscule, minuscule et chiffre, différents', () => {
  const set = new Set();
  for (let i = 0; i < 100; i++) {
    const p = randomPassword();
    assert.match(p, /^[A-Za-z0-9]{20}$/);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/);
    set.add(p);
  }
  assert.strictEqual(set.size, 100);
});
