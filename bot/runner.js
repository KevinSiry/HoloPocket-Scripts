// Fait tourner les scripts HoloPocket en continu dans un Chromium sans écran.
// - Session : l'en-tête Cookie de ton navigateur (config.json, jamais publié).
// - Scripts : téléchargés depuis GitHub au démarrage, puis surveillés (nouvelle version → rechargement).
// - Mémoire des scripts (localStorage) conservée dans ./profile entre deux redémarrages.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const BASE = cfg.base || 'https://holopocket.fr';
const RAW = cfg.raw || 'https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/';
const log = (...a) => console.log(new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), '·', ...a);

async function fetchScripts() {
  const out = [];
  for (const name of cfg.scripts) {
    const r = await fetch(RAW + name + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(`${name} : HTTP ${r.status}`);
    const code = await r.text();
    const version = (code.match(/\/\/ @version\s+(\S+)/) || [])[1] || '?';
    out.push({ name, version, code });
  }
  return out;
}
const sig = (list) => list.map((s) => `${s.name}@${s.version}`).join(',');

function parseCookie(header) {
  const host = new URL(BASE).hostname;
  return header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: host, path: '/', secure: BASE.startsWith('https'), httpOnly: true, sameSite: 'Lax' };
  });
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(DIR, 'profile'), {
    headless: true, viewport: { width: 1400, height: 900 }, locale: 'fr-FR', timezoneId: 'Europe/Paris',
  });
  if (cfg.cookie && !/COLLE ICI/.test(cfg.cookie)) await ctx.addCookies(parseCookie(cfg.cookie));
  // Active les interrupteurs voulus avant que les scripts ne démarrent
  await ctx.addInitScript((t) => { try { for (const [k, v] of Object.entries(t)) localStorage.setItem(k, v); } catch {} }, cfg.toggles || {});

  let scripts = await fetchScripts();
  log('Scripts :', sig(scripts));
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => log('Erreur page :', e.message));
  page.on('crash', () => { log('Page plantée, redémarrage'); process.exit(1); });

  async function load() {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    for (const s of scripts) await page.addScriptTag({ content: s.code });
    log('Page chargée, scripts injectés');
  }
  async function account() {
    return page.evaluate(async () => {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (!r.ok) return { ok: false, status: r.status };
      const d = await r.json();
      return { ok: true, user: d.me && d.me.username, balance: d.me && d.me.balance };
    }).catch((e) => ({ ok: false, status: e.message }));
  }

  await load();
  const a = await account();
  if (!a.ok) { log(`Session refusée (${a.status}) : recopie l'en-tête Cookie dans config.json puis redémarre.`); process.exit(2); }
  log(`Connecté en tant que ${a.user} · ${a.balance} pièces`);

  // Résumé des messages des scripts (toasts) dans le journal
  setInterval(async () => {
    const t = await page.evaluate(() => [...document.querySelectorAll('.hp-toast')].map((x) => x.textContent.trim()).filter((x) => !window.__seen?.has(x) && (window.__seen = window.__seen || new Set()).add(x))).catch(() => []);
    for (const x of t) log('›', x.replace(/\s+/g, ' ').slice(0, 300));
  }, 5000);

  // Session toujours valide ?
  setInterval(async () => {
    const r = await account();
    if (!r.ok) { log(`Session expirée (${r.status}) : recopie l'en-tête Cookie dans config.json.`); process.exit(2); }
    log(`OK · ${r.balance} pièces`);
  }, 30 * 60000);

  // Nouvelles versions sur GitHub → rechargement
  setInterval(async () => {
    try {
      const fresh = await fetchScripts();
      if (sig(fresh) !== sig(scripts)) { scripts = fresh; log('Mise à jour :', sig(scripts)); await load(); }
    } catch (e) { log('Vérification des mises à jour impossible :', e.message); }
  }, (cfg.checkUpdatesMin || 15) * 60000);

  // Rechargement périodique (mémoire du navigateur)
  setInterval(() => load().catch((e) => { log('Rechargement impossible :', e.message); process.exit(1); }), (cfg.reloadEveryH || 6) * 3600000);
})().catch((e) => { log('Arrêt :', e.message); process.exit(1); });
