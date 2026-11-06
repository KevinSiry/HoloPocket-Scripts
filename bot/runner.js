// Fait tourner les scripts HoloPocket en continu dans un Chromium sans écran.
// - Connexion : HP_USERNAME / HP_PASSWORD (fichier .env), reconnexion automatique si la session expire.
//   (Variante : HP_COOKIE = en-tête Cookie copié depuis ton navigateur, pour un compte sans mot de passe.)
// - Scripts : téléchargés depuis GitHub au démarrage, puis surveillés (nouvelle version → rechargement).
// - Mémoire des scripts (localStorage) conservée dans ./profile entre deux redémarrages.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = __dirname;
const env = process.env;
let file = {};
try { file = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch {}

const DEFAULT_SCRIPTS = [
  'holopocket-auto-booster.user.js',
  'holopocket-echanges.user.js',
];
const TOGGLE_OF = {
  'holopocket-vendre-doublons.user.js': 'hp-sell-auto-on',
  'holopocket-auto-booster.user.js': 'hp-auto-booster-on',
  'holopocket-recyclage.user.js': 'hp-recycle-auto-on',
  'holopocket-echanges.user.js': 'hp-trade-auto-on',
  'holopocket-achat-revente.user.js': 'hp-flip-auto-on',
};
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

const cfg = {
  base: env.HP_BASE || file.base || 'https://holopocket.fr',
  raw: env.HP_RAW || file.raw || 'https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/',
  username: env.HP_USERNAME || file.username || '',
  password: env.HP_PASSWORD || file.password || '',
  cookie: env.HP_COOKIE || file.cookie || '',
  scripts: list(env.HP_SCRIPTS).length ? list(env.HP_SCRIPTS).map((n) => (n.endsWith('.user.js') ? n : `holopocket-${n}.user.js`)) : file.scripts || DEFAULT_SCRIPTS,
  checkUpdatesMin: +(env.HP_CHECK_UPDATES_MIN || file.checkUpdatesMin || 15),
  reloadEveryH: +(env.HP_RELOAD_EVERY_H || file.reloadEveryH || 6),
  exclude: list(env.HP_EXCLUDE).length ? list(env.HP_EXCLUDE) : file.exclude || [],
  defaultBooster: env.HP_DEFAULT_BOOSTER || file.defaultBooster || '',
  priorityTarget: (env.HP_PRIORITY_TARGET || file.priorityTarget || '').trim(),
};
// Interrupteurs des modes auto : activés pour chaque script chargé
cfg.toggles = file.toggles || Object.fromEntries(cfg.scripts.filter((n) => TOGGLE_OF[n]).map((n) => [TOGGLE_OF[n], '1']));
// Joueurs exclus : aucun échange, aucun achat (ex. ton autre compte)
cfg.toggles['hp-excluded-players'] = JSON.stringify(cfg.exclude);
// Booster ouvert quand le compte n'a aucune série en favori
cfg.toggles['hp-booster-default'] = cfg.defaultBooster;
// Joueur prioritaire : le script d'échanges lui donne tes doublons qu'il n'a pas, avant toute autre recherche
cfg.toggles['hp-priority-target'] = cfg.priorityTarget;

const log = (...a) => console.log(new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), '·', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchScripts() {
  const out = [];
  for (const name of cfg.scripts) {
    const r = await fetch(cfg.raw + name + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(`${name} : HTTP ${r.status}`);
    const code = await r.text();
    const version = (code.match(/\/\/ @version\s+(\S+)/) || [])[1] || '?';
    out.push({ name, version, code });
  }
  return out;
}
const sig = (l) => l.map((s) => `${s.name.replace(/^holopocket-|\.user\.js$/g, '')}@${s.version}`).join(', ');

function parseCookie(header) {
  const host = new URL(cfg.base).hostname;
  return header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: host, path: '/', secure: cfg.base.startsWith('https'), httpOnly: true, sameSite: 'Lax' };
  });
}

(async () => {
  if (!cfg.cookie && !(cfg.username && cfg.password)) {
    log('Renseigne HP_USERNAME et HP_PASSWORD dans le fichier .env (ou HP_COOKIE).');
    process.exit(2);
  }
  const ctx = await chromium.launchPersistentContext(path.join(DIR, 'profile'), {
    headless: true, viewport: { width: 1400, height: 900 }, locale: 'fr-FR', timezoneId: 'Europe/Paris',
    bypassCSP: true, // le site interdit les scripts ajoutés à la page (CSP) : Tampermonkey contourne cette règle, on fait pareil
    args: ['--disable-dev-shm-usage'],
  });
  if (cfg.cookie) await ctx.addCookies(parseCookie(cfg.cookie));
  // Active les interrupteurs voulus avant que les scripts ne démarrent
  await ctx.addInitScript((t) => { try { for (const [k, v] of Object.entries(t)) localStorage.setItem(k, v); } catch {} }, cfg.toggles);

  let scripts = await fetchScripts();
  log('Scripts :', sig(scripts));
  if (cfg.exclude.length) log('Joueurs exclus :', cfg.exclude.join(', '));
  if (cfg.defaultBooster) log('Booster par défaut (sans favori) :', cfg.defaultBooster);
  if (cfg.priorityTarget) log('Échange prioritaire vers :', cfg.priorityTarget);
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => log('Erreur page :', e.message));
  page.on('crash', () => { log('Page plantée, redémarrage'); process.exit(1); });

  const account = () => page.evaluate(async () => {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json().catch(() => ({}));
    return d.me ? { ok: true, user: d.me.username, balance: d.me.balance } : { ok: false, status: 'non connecté' };
  }).catch((e) => ({ ok: false, status: e.message }));

  // Connexion avec identifiant / mot de passe (même requête que le formulaire du site)
  async function login() {
    if (!(cfg.username && cfg.password)) return { ok: false, status: 'pas d’identifiants (HP_COOKIE expiré ?)' };
    return page.evaluate(async ({ username, password }) => {
      const r = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json().catch(() => ({}));
      return r.ok ? { ok: true } : { ok: false, status: d.message || d.error || r.status };
    }, { username: cfg.username, password: cfg.password }).catch((e) => ({ ok: false, status: e.message }));
  }

  // S'assure d'être connecté ; se reconnecte si besoin (plusieurs essais espacés)
  async function ensureSession() {
    let a = await account();
    if (a.ok) return a;
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`Session absente ou expirée (${a.status}) : connexion… (essai ${attempt}/3)`);
      const l = await login();
      if (l.ok) { a = await account(); if (a.ok) { log(`Connecté en tant que ${a.user}`); return a; } }
      else log('Connexion refusée :', l.status);
      await sleep(attempt * 60000);
    }
    return a;
  }

  async function load() {
    await page.goto(cfg.base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    for (const s of scripts) await page.addScriptTag({ content: s.code });
    log('Page chargée, scripts injectés');
  }

  await page.goto(cfg.base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const a = await ensureSession();
  if (!a.ok) { log('Impossible de se connecter : vérifie HP_USERNAME / HP_PASSWORD dans .env. Nouvel essai dans 30 min.'); await sleep(30 * 60000); process.exit(1); }
  log(`Compte ${a.user} · ${a.balance} pièces`);
  await load(); // les scripts démarrent une fois la session valide

  // Messages des scripts (toasts) recopiés dans le journal
  setInterval(async () => {
    const t = await page.evaluate(() => {
      window.__seen = window.__seen || new Set();
      return [...document.querySelectorAll('.hp-toast')].map((x) => x.textContent.trim()).filter((x) => x && !window.__seen.has(x) && window.__seen.add(x));
    }).catch(() => []);
    for (const x of t) log('›', x.replace(/\s+/g, ' ').slice(0, 300));
  }, 5000);

  // Session toujours valide ? Sinon reconnexion puis rechargement des scripts
  setInterval(async () => {
    const r = await account();
    if (r.ok) { log(`OK · ${r.balance} pièces`); return; }
    const s = await ensureSession();
    if (!s.ok) { log('Reconnexion impossible, redémarrage du bot'); process.exit(1); }
    await load();
  }, 10 * 60000);

  // Nouvelles versions sur GitHub → rechargement
  setInterval(async () => {
    try {
      const fresh = await fetchScripts();
      if (sig(fresh) !== sig(scripts)) { scripts = fresh; log('Mise à jour :', sig(scripts)); await load(); }
    } catch (e) { log('Vérification des mises à jour impossible :', e.message); }
  }, cfg.checkUpdatesMin * 60000);

  // Rechargement périodique (mémoire du navigateur)
  setInterval(() => load().catch((e) => { log('Rechargement impossible :', e.message); process.exit(1); }), cfg.reloadEveryH * 3600000);

  const stop = async () => { log('Arrêt demandé'); await ctx.close().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch(async (e) => {
  log('Arrêt :', e.message, '· nouvel essai dans 2 min');
  await sleep(2 * 60000); // évite de se reconnecter en boucle toutes les 5 s
  process.exit(1);
});
