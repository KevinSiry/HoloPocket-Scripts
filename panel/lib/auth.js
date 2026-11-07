// Mot de passe unique : empreinte scrypt, sessions signées (HMAC), limite d'essais par adresse IP.
const crypto = require('crypto');

const N = 16384;
function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const h = crypto.scryptSync(String(pw), salt, 32, { N });
  return `scrypt:${N}:${salt.toString("base64")}:${h.toString("base64")}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, n, salt, hash] = String(stored).split(":");
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +n });
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch { return false; }
}

const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('base64url');
function createSession(secret, ttlMs, now = Date.now()) {
  const body = `${now + ttlMs}.${crypto.randomBytes(8).toString('base64url')}`;
  return `${body}.${sign(secret, body)}`;
}
function verifySession(secret, token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const body = `${parts[0]}.${parts[1]}`;
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(sign(secret, body));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && +parts[0] > now;
}

// 5 échecs en 15 min → blocage de cette adresse jusqu'à la fin de la fenêtre
function createThrottle({ max = 5, windowMs = 15 * 60000, now = Date.now } = {}) {
  const fails = new Map();
  const recent = (ip) => { const t = now(); const l = (fails.get(ip) || []).filter((x) => t - x < windowMs); fails.set(ip, l); return l; };
  return {
    retryAfterMs(ip) { const l = recent(ip); return l.length >= max ? windowMs - (now() - l[0]) : 0; },
    fail(ip) { recent(ip).push(now()); },
    reset(ip) { fails.delete(ip); },
  };
}

function parseCookies(header) {
  const out = {};
  for (const p of String(header || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, createSession, verifySession, createThrottle, parseCookies };
