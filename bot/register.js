// Création d'un compte HoloPocket : même requête que le formulaire d'inscription du site, envoyée depuis une page du site.
const TAKEN = /déjà|deja|existe|exist|pris|taken|already|utilis/i;
const DEFAULT_PATHS = ['/api/auth/register', '/api/auth/signup'];

const messageOf = (b) => (b && (b.message || b.error)) || (b && typeof b === 'object' && Object.keys(b).length ? JSON.stringify(b).slice(0, 200) : '');

// call(path, body) → { status, body } ; essaie chaque adresse tant que le site répond « introuvable »
async function tryRegister(call, { username, password }, paths = DEFAULT_PATHS) {
  let last = null;
  for (const p of paths) {
    const r = await call(p, { username, password });
    last = r;
    if (r.status >= 200 && r.status < 300) return { ok: true, path: p };
    if (r.status === 404 || r.status === 405) continue;
    const msg = messageOf(r.body);
    return { ok: false, taken: r.status === 409 || TAKEN.test(msg), status: r.status, error: msg || `HTTP ${r.status}` };
  }
  return { ok: false, taken: false, status: last && last.status, error: `adresse d’inscription introuvable (essayé : ${paths.join(', ')}) ; définis HP_REGISTER_PATH` };
}

// Ouvre une page du site (navigateur jetable, sans profil) et y envoie la demande d'inscription
async function registerWithBrowser({ base, username, password, paths, chromium }) {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris', bypassCSP: true });
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    const call = (p, body) => page.evaluate(async ({ p, body }) => {
      const r = await fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, { p, body });
    return await tryRegister(call, { username, password }, paths);
  } finally { await browser.close().catch(() => {}); }
}

module.exports = { tryRegister, registerWithBrowser, DEFAULT_PATHS };
