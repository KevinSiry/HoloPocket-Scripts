// Pseudos et mots de passe aléatoires : plausibles, sans lien entre eux (aucune racine commune d'un compte à l'autre).
const crypto = require('crypto');

const rnd = (n) => crypto.randomInt(n);
const pick = (a) => a[rnd(a.length)];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const C = 'bcdfgjklmnprstvz'.split('');
const V = 'aeiouy'.split('');
const WORDS = ['loup', 'brume', 'nova', 'pixel', 'cobalt', 'ember', 'lynx', 'orage', 'sable', 'zenith', 'tigre', 'quartz', 'vortex', 'pomme', 'cactus', 'renard', 'galet', 'mistral', 'turbo', 'fennec', 'indigo', 'plume', 'rocket', 'sirop', 'tonic', 'velours', 'waffle', 'yeti', 'bison', 'corsaire', 'dune', 'etoile', 'furie', 'gecko', 'harpon', 'iris', 'jade', 'koala', 'lotus', 'moka', 'nimbus', 'opale', 'panda', 'radar', 'safran', 'taupe', 'ultra', 'volt', 'xenon', 'zephyr'];

function syllables() {
  const n = 2 + rnd(2);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(C) + pick(V) + (rnd(4) === 0 ? pick(C) : '');
  return s;
}
const digits = () => String(rnd(3) === 0 ? 1970 + rnd(45) : rnd(100));

const STYLES = [
  () => cap(syllables()),
  () => syllables() + digits(),
  () => pick(WORDS) + cap(pick(WORDS)),
  () => cap(pick(WORDS)) + digits(),
  () => syllables() + '_' + pick(WORDS),
  () => pick(WORDS) + pick(V) + pick(C) + digits(),
];

// existing : pseudos déjà connus ; deux pseudos ne partagent jamais leurs 3 premières lettres
function randomUsername(existing = []) {
  for (let i = 0; i < 50; i++) {
    const u = pick(STYLES)();
    if (u.length < 6 || u.length > 14) continue;
    const head = u.slice(0, 3).toLowerCase();
    if (existing.some((e) => String(e).slice(0, 3).toLowerCase() === head)) continue;
    return u;
  }
  return cap(syllables()) + rnd(1000);
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz', UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ', NUM = '23456789';
function randomPassword(len = 20) {
  const all = LOWER + UPPER + NUM;
  const chars = [pick(LOWER.split('')), pick(UPPER.split('')), pick(NUM.split(''))];
  while (chars.length < len) chars.push(pick(all.split('')));
  for (let i = chars.length - 1; i > 0; i--) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

module.exports = { randomUsername, randomPassword };
