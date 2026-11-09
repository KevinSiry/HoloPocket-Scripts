// Booster à ouvrir : un réglage global du panel que les comptes suivent par défaut, avec un choix propre à un compte possible.
// Les bots connaissent « auto » (meilleur favori), « optimal » (meilleure chance par énergie, toutes séries) ou « série fixe » : le panel traduit le choix de chaque compte et le leur envoie.
const fs = require('fs');

const pick = (r) => (r && r.mode === 'fixed' && typeof r.setId === 'string' && r.setId.trim() ? { mode: 'fixed', setId: r.setId.trim() } : r && r.mode === 'optimal' ? { mode: 'optimal' } : { mode: 'auto' });

function sanitize(raw) {
  const out = { global: pick(raw && raw.global), accounts: {} };
  const acc = raw && raw.accounts;
  if (acc && typeof acc === 'object') for (const [name, v] of Object.entries(acc)) if (v && (v.mode === 'auto' || v.mode === 'fixed' || v.mode === 'optimal')) out.accounts[name] = pick(v);
  return out;
}

// Mémoire du panel (volume) ; sans fichier, tout reste en mémoire (tests)
function createStore(file) {
  let state = sanitize(null);
  if (file) { try { state = sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {} }
  const save = () => {
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    global: () => state.global,
    setGlobal(v) { state = { ...state, global: pick(v) }; save(); },
    // Choix d'un compte : { mode: 'global' } (suit le global) ou auto / fixed
    choice: (name) => state.accounts[name] || { mode: 'global' },
    setChoice(name, v) {
      const accounts = { ...state.accounts };
      if (v && v.mode === 'global') delete accounts[name]; else accounts[name] = pick(v);
      state = { ...state, accounts }; save();
    },
    // Ce que le bot doit appliquer
    desired(name) { return state.accounts[name] || state.global; },
  };
}

const same = (a, b) => a && b && a.mode === b.mode && (a.mode !== 'fixed' || a.setId === b.setId);

// Remet d'aplomb les bots dont le booster diffère du voulu (changement, redémarrage, bot revenu en ligne), sans insister plus d'une fois par minute
function createReconciler({ store, push, now = Date.now, retryMs = 60000 }) {
  const lastTry = new Map();
  const errors = new Map();
  let running = false;
  return {
    errors: () => Object.fromEntries(errors),
    async run(list) {
      if (running) return;
      running = true;
      try {
        for (const b of list) {
          if (!b.online || !b.status || !b.status.booster) { continue; }
          const want = store.desired(b.name);
          const has = { mode: b.status.booster.mode, setId: b.status.booster.setId };
          if (same(want, has)) { errors.delete(b.name); continue; }
          if (lastTry.has(b.name) && now() - lastTry.get(b.name) < retryMs) continue;
          lastTry.set(b.name, now());
          try { await push(b.name, { booster: want }); errors.delete(b.name); lastTry.delete(b.name); } catch (e) { errors.set(b.name, e.message); }
        }
      } finally { running = false; }
    },
    // Après un changement voulu par toi : on réessaie tout de suite
    forget() { lastTry.clear(); },
  };
}

module.exports = { createStore, createReconciler, sanitize, same };
