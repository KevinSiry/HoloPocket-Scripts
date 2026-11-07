// Comptes HoloPocket gérés par le panel : pseudo, mot de passe chiffré, actif ou non. Source de vérité de la flotte.
const fs = require('fs');

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const USERNAME = /^[A-Za-z0-9_.-]{3,32}$/;

function createAccountStore({ file, vault }) {
  let rows = [];
  if (file) { try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(raw.accounts)) rows = raw.accounts.filter((r) => r && typeof r.username === 'string' && typeof r.passwordEnc === 'string'); } catch {} }
  const save = () => {
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ accounts: rows }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const find = (name) => rows.find((r) => same(r.username, name));
  const pub = (r) => ({ username: r.username, enabled: r.enabled !== false, source: r.source || 'manual', createdAt: r.createdAt });
  return {
    list: () => rows.map(pub),
    has: (name) => !!find(name),
    usernames: () => rows.map((r) => r.username),
    add({ username, password, source = 'manual' }) {
      if (!USERNAME.test(String(username))) throw Object.assign(new Error('Pseudo invalide (3 à 32 caractères : lettres, chiffres, _ . -).'), { status: 400 });
      if (typeof password !== 'string' || !password || password.length > 128) throw Object.assign(new Error('Mot de passe invalide.'), { status: 400 });
      if (find(username)) throw Object.assign(new Error('Ce compte existe déjà dans le panel.'), { status: 409 });
      rows = [...rows, { username, passwordEnc: vault.encrypt(password), enabled: true, source, createdAt: new Date().toISOString() }];
      save();
    },
    setEnabled(name, enabled) {
      const r = find(name);
      if (!r) throw Object.assign(new Error('compte inconnu'), { status: 404 });
      r.enabled = !!enabled; save();
    },
    remove(name) {
      if (!find(name)) throw Object.assign(new Error('compte inconnu'), { status: 404 });
      rows = rows.filter((r) => !same(r.username, name)); save();
    },
    reveal(name) {
      const r = find(name);
      if (!r) throw Object.assign(new Error('compte inconnu'), { status: 404 });
      return vault.decrypt(r.passwordEnc);
    },
    // Pour la flotte (réseau interne seulement)
    fleetList() {
      const out = [];
      for (const r of rows) {
        try { out.push({ username: r.username, password: vault.decrypt(r.passwordEnc), enabled: r.enabled !== false }); } catch { /* mot de passe illisible (PANEL_SECRET changé) : compte ignoré */ }
      }
      return out;
    },
  };
}

module.exports = { createAccountStore, USERNAME };
