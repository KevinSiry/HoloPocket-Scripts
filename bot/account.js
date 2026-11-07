// Un compte HoloPocket : son Chromium (profil persistant), ses scripts, sa connexion, son journal.
// Utilisé par runner.js, seul (un compte par conteneur) ou en flotte (tous les comptes du panel dans un conteneur).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const pc = require('./panel-config');
const { resolveAccounts } = require('./accounts');
const { createGlue } = require('./panel-glue');

const DEFAULT_SCRIPTS = ['holopocket-auto-booster.user.js', 'holopocket-echanges.user.js'];
const TOGGLE_OF = {
  'holopocket-vendre-doublons.user.js': 'hp-sell-auto-on',
  'holopocket-auto-booster.user.js': 'hp-auto-booster-on',
  'holopocket-recyclage.user.js': 'hp-recycle-auto-on',
  'holopocket-echanges.user.js': 'hp-trade-auto-on',
  'holopocket-achat-revente.user.js': 'hp-flip-auto-on',
};
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = /impossible|refusée|plantée|Arrêt|Erreur page|expirée|absente/i;

// Réglages d'un compte : .env (+ config.json) pour les réglages communs, identité propre au compte
function buildConfig({ env, file = {}, username, password, cookie, allAccounts }) {
  const cfg = {
    base: env.HP_BASE || file.base || 'https://holopocket.fr',
    raw: env.HP_RAW || file.raw || 'https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/',
    username: username ?? (env.HP_USERNAME || file.username || ''),
    password: password ?? (env.HP_PASSWORD || file.password || ''),
    cookie: cookie ?? (env.HP_COOKIE || file.cookie || ''),
    scripts: list(env.HP_SCRIPTS).length ? list(env.HP_SCRIPTS).map((n) => (n.endsWith('.user.js') ? n : `holopocket-${n}.user.js`)) : file.scripts || DEFAULT_SCRIPTS,
    checkUpdatesMin: +(env.HP_CHECK_UPDATES_MIN || file.checkUpdatesMin || 15),
    reloadEveryH: +(env.HP_RELOAD_EVERY_H || file.reloadEveryH || 6),
    exclude: list(env.HP_EXCLUDE).length ? list(env.HP_EXCLUDE) : file.exclude || [],
    defaultBooster: env.HP_DEFAULT_BOOSTER || file.defaultBooster || '',
    priorityTarget: (env.HP_PRIORITY_TARGET || file.priorityTarget || '').trim(),
    baseExclude: null,
  };
  cfg.baseExclude = [...cfg.exclude];
  cfg.rawPriority = cfg.priorityTarget;
  applyAccounts(cfg, [...list(env.HP_ACCOUNTS), ...(allAccounts || [])]);
  return cfg;
}
// Comptes du même propriétaire : ils s'ignorent entre eux ; la cible prioritaire reçoit les dons des autres
function applyAccounts(cfg, accounts) {
  const r = resolveAccounts({ username: cfg.username, accounts, exclude: cfg.baseExclude, priorityTarget: cfg.rawPriority });
  cfg.exclude = r.exclude;
  cfg.priorityTarget = r.priorityTarget;
  cfg.isPriorityTarget = r.isTarget;
}

/**
 * opts : {
 *   cfg, file,            réglages (buildConfig) et config.json
 *   env,                  variables d'environnement (HP_BOT_NAME)
 *   profileDir,           dossier du profil Chromium (+ panel-config.json)
 *   logs, logL,           tampon du journal et fonction de journal (logL(level, ...))
 *   onFatal(reason),      appelé quand le compte ne peut plus tourner (le superviseur le relance)
 * }
 * Retourne { name, status, sets, applyConfig, refreshAccounts, stop, logs, cfg }.
 */
async function startAccount(opts) {
  const { cfg, file = {}, env = process.env, profileDir, logs, logL, onFatal } = opts;
  const log = (...a) => logL(BAD.test(a.join(' ')) ? 'warn' : 'info', ...a);
  const startedAt = Date.now();
  const timers = [];
  let stopped = false;
  const every = (fn, ms) => timers.push(setInterval(() => { if (!stopped) Promise.resolve(fn()).catch((e) => log('Erreur interne :', e.message)); }, ms));

  if (!cfg.cookie && !(cfg.username && cfg.password)) {
    throw Object.assign(new Error('Renseigne HP_USERNAME et HP_PASSWORD (ou HP_COOKIE).'), { retryAfterMs: 0, fatal: true });
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const PANEL_FILE = path.join(profileDir, 'panel-config.json');
  const baseScripts = [...cfg.scripts];
  const state = { panelCfg: pc.readConfig(PANEL_FILE) };
  cfg.scripts = pc.applyScripts(baseScripts, state.panelCfg.scripts);

  function buildToggles() {
    const t = file.toggles ? { ...file.toggles } : Object.fromEntries(cfg.scripts.filter((n) => TOGGLE_OF[n]).map((n) => [TOGGLE_OF[n], '1']));
    for (const n of cfg.scripts) if (TOGGLE_OF[n]) t[TOGGLE_OF[n]] = '1';
    t['hp-excluded-players'] = JSON.stringify(cfg.exclude);
    t['hp-booster-default'] = cfg.defaultBooster;
    t['hp-priority-target'] = cfg.priorityTarget;
    t['hp-booster-force'] = state.panelCfg.booster.mode === 'fixed' ? state.panelCfg.booster.setId : '';
    return t;
  }
  cfg.toggles = buildToggles();

  async function fetchScripts(names = cfg.scripts) {
    const out = [];
    for (const name of names) {
      const r = await fetch(cfg.raw + name + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(`${name} : HTTP ${r.status}`);
      const code = await r.text();
      out.push({ name, version: (code.match(/\/\/ @version\s+(\S+)/) || [])[1] || '?', code });
    }
    return out;
  }
  const sig = (l) => l.map((s) => `${s.name.replace(/^holopocket-|\.user\.js$/g, '')}@${s.version}`).join(', ');
  const parseCookie = (header) => {
    const host = new URL(cfg.base).hostname;
    return header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return { name: p.slice(0, i), value: p.slice(i + 1), domain: host, path: '/', secure: cfg.base.startsWith('https'), httpOnly: true, sameSite: 'Lax' };
    });
  };

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: true, viewport: { width: 1400, height: 900 }, locale: 'fr-FR', timezoneId: 'Europe/Paris',
    bypassCSP: true, // le site interdit les scripts ajoutés à la page (CSP) : Tampermonkey contourne cette règle, on fait pareil
    args: ['--disable-dev-shm-usage'],
  });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearInterval(t);
    await ctx.close().catch(() => {});
  };
  try {
    if (cfg.cookie) await ctx.addCookies(parseCookie(cfg.cookie));
    const setLS = (t) => { try { for (const [k, v] of Object.entries(t)) localStorage.setItem(k, v); } catch {} };
    await ctx.addInitScript(setLS, cfg.toggles);

    let scripts = await fetchScripts();
    log('Scripts :', sig(scripts));
    if (cfg.exclude.length) log('Joueurs exclus :', cfg.exclude.join(', '));
    if (cfg.defaultBooster) log('Booster par défaut (sans favori) :', cfg.defaultBooster);
    if (cfg.priorityTarget) log('Échange prioritaire vers :', cfg.priorityTarget);
    if (cfg.isPriorityTarget) log('Ce compte est la cible prioritaire des autres comptes');
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('pageerror', (e) => log('Erreur page :', e.message));
    page.on('crash', () => { log('Page plantée, redémarrage'); if (!stopped) onFatal('page plantée'); });

    const account = () => page.evaluate(async () => {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (!r.ok) return { ok: false, status: r.status };
      const d = await r.json().catch(() => ({}));
      return d.me ? { ok: true, user: d.me.username, balance: d.me.balance } : { ok: false, status: 'non connecté' };
    }).catch((e) => ({ ok: false, status: e.message }));

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
    async function ensureSession() {
      let a = await account();
      if (a.ok) return a;
      for (let attempt = 1; attempt <= 3 && !stopped; attempt++) {
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
    if (!a.ok) throw Object.assign(new Error('Impossible de se connecter : identifiants refusés ou compte inexistant.'), { retryAfterMs: 30 * 60000 });
    log(`Compte ${a.user} · ${a.balance} pièces`);
    await load(); // les scripts démarrent une fois la session valide

    const glue = createGlue({
      page, ctx, cfg, state, file: PANEL_FILE, baseScripts, buildToggles, setLS,
      getScripts: () => scripts, setScripts: (l) => { scripts = l; },
      fetchScripts, load, logs, log, name: opts.name || env.HP_BOT_NAME || a.user, startedAt,
    });

    // Messages des scripts (toasts) recopiés dans le journal
    every(async () => {
      const t = await page.evaluate(() => {
        window.__seen = window.__seen || new Set();
        return [...document.querySelectorAll('.hp-toast')]
          .map((x) => ({ text: x.textContent.trim(), error: x.classList.contains('hp-toast--error') }))
          .filter((x) => x.text && !window.__seen.has(x.text) && window.__seen.add(x.text));
      }).catch(() => []);
      for (const x of t) logL(x.error ? 'error' : 'info', '›', x.text.replace(/\s+/g, ' ').slice(0, 300));
    }, 5000);

    // Session toujours valide ? Sinon reconnexion puis rechargement des scripts
    every(async () => {
      const r = await account();
      if (r.ok) { log(`OK · ${r.balance} pièces`); return; }
      const s = await ensureSession();
      if (!s.ok) { log('Reconnexion impossible, redémarrage du bot'); onFatal('reconnexion impossible'); return; }
      await load();
    }, 10 * 60000);

    // Nouvelles versions sur GitHub → rechargement
    every(async () => {
      try {
        const fresh = await fetchScripts();
        if (sig(fresh) !== sig(scripts)) { scripts = fresh; log('Mise à jour :', sig(scripts)); await load(); }
      } catch (e) { log('Vérification des mises à jour impossible :', e.message); }
    }, cfg.checkUpdatesMin * 60000);

    // Rechargement périodique (mémoire du navigateur)
    every(() => load().catch((e) => { log('Rechargement impossible :', e.message); onFatal('rechargement impossible'); }), cfg.reloadEveryH * 3600000);

    return {
      name: a.user, cfg, logs,
      status: glue.status, sets: glue.sets, applyConfig: glue.applyConfig,
      // La liste des comptes a changé : réécrit les exclusions et recharge la page seulement si elles ont bougé
      async refreshAccounts(accounts) {
        const before = JSON.stringify(cfg.exclude) + cfg.priorityTarget;
        applyAccounts(cfg, accounts);
        if (JSON.stringify(cfg.exclude) + cfg.priorityTarget === before) return false;
        log('Comptes mis à jour, joueurs exclus :', cfg.exclude.join(', ') || 'aucun');
        await glue.refreshToggles({ reload: true });
        return true;
      },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

module.exports = { startAccount, buildConfig, applyAccounts, TOGGLE_OF, list, sleep };
