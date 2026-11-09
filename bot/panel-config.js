// Réglages posés depuis le panel, conservés dans le volume du bot (profile/panel-config.json).
// Priorité : panel-config.json > .env > valeurs par défaut.
const fs = require('fs');

const KNOWN_SCRIPTS = ['auto-booster', 'echanges', 'vendre-doublons', 'recyclage', 'achat-revente', 'achat-manquantes'];
const toFile = (name) => `holopocket-${name}.user.js`;
const toName = (file) => file.replace(/^holopocket-|\.user\.js$/g, '');

const defaults = () => ({ booster: { mode: 'auto' }, scripts: {} });

// Ne garde que ce qui est valide : jamais de contenu inattendu dans les réglages
function sanitize(raw) {
  const out = defaults();
  const b = raw && raw.booster;
  if (b && b.mode === 'fixed' && typeof b.setId === 'string' && b.setId.trim()) out.booster = { mode: 'fixed', setId: b.setId.trim() };
  else if (b && b.mode === 'optimal') out.booster = { mode: 'optimal' };
  const sc = raw && raw.scripts;
  if (sc && typeof sc === 'object') for (const n of KNOWN_SCRIPTS) if (typeof sc[n] === 'boolean') out.scripts[n] = sc[n];
  return out;
}

function readConfig(file) {
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return defaults(); }
}

// Écriture atomique : fichier temporaire puis renommage, pour qu'une coupure ne corrompe jamais le fichier
function writeConfig(file, conf) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitize(conf), null, 2));
  fs.renameSync(tmp, file);
}

function mergeConfig(current, patch) {
  const next = sanitize(current);
  if (patch.booster) next.booster = sanitize({ booster: patch.booster }).booster;
  if (patch.scripts) next.scripts = { ...next.scripts, ...sanitize({ scripts: patch.scripts }).scripts };
  return next;
}

// Liste des fichiers de scripts à charger : la liste de base (.env), puis les réglages du panel (true = chargé, false = retiré)
function applyScripts(baseFiles, scriptsMap) {
  const files = [...baseFiles];
  for (const [name, on] of Object.entries(scriptsMap || {})) {
    const f = toFile(name);
    const at = files.indexOf(f);
    if (on && at === -1) files.push(f);
    if (!on && at !== -1) files.splice(at, 1);
  }
  return files;
}

// Valide une demande de modification. `sets` = séries du site (pour contrôler la série fixe).
// Renvoie { ok: true } ou { ok: false, error }.
function validatePatch(patch, sets) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'corps JSON attendu' };
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, error: 'aucun réglage' };
  for (const k of keys) if (k !== 'booster' && k !== 'scripts') return { ok: false, error: `réglage inconnu : ${k}` };
  if ('booster' in patch) {
    const b = patch.booster;
    if (!b || typeof b !== 'object') return { ok: false, error: 'booster : objet attendu' };
    if (b.mode !== 'auto' && b.mode !== 'fixed' && b.mode !== 'optimal') return { ok: false, error: 'booster.mode : auto, optimal ou fixed' };
    if (b.mode === 'fixed') {
      if (typeof b.setId !== 'string' || !b.setId.trim()) return { ok: false, error: 'booster.setId requis en mode fixed' };
      const id = b.setId.trim().toLowerCase();
      if (!(sets || []).some((s) => String(s.id).toLowerCase() === id)) return { ok: false, error: `série inconnue : ${b.setId}` };
    }
  }
  if ('scripts' in patch) {
    const sc = patch.scripts;
    if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return { ok: false, error: 'scripts : objet attendu' };
    const names = Object.keys(sc);
    if (!names.length) return { ok: false, error: 'scripts : aucun script' };
    for (const n of names) {
      if (!KNOWN_SCRIPTS.includes(n)) return { ok: false, error: `script inconnu : ${n}` };
      if (typeof sc[n] !== 'boolean') return { ok: false, error: `scripts.${n} : true ou false` };
    }
  }
  return { ok: true };
}

module.exports = { KNOWN_SCRIPTS, toFile, toName, readConfig, writeConfig, mergeConfig, applyScripts, validatePatch, sanitize };
