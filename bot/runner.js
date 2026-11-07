// Fait tourner les scripts HoloPocket en continu dans un Chromium sans écran.
// Deux modes :
// - un compte par conteneur (HP_USERNAME / HP_PASSWORD dans le .env), comme avant ;
// - en flotte (PANEL_URL défini) : tous les comptes du panel dans ce seul conteneur, créés et réglés depuis le panel.
// Mémoire des scripts (localStorage) conservée dans ./profile entre deux redémarrages.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createLogBuffer } = require('./log-buffer');
const { createPanelServer } = require('./panel-api');
const { startAccount, buildConfig, sleep } = require('./account');
const { createFleet } = require('./fleet');
const { registerWithBrowser, DEFAULT_PATHS } = require('./register');

const DIR = __dirname;
const env = process.env;
const ts = () => new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

async function runFleet() {
  if (!env.PANEL_TOKEN) { console.error('PANEL_TOKEN manquant : la flotte ne peut pas parler au panel.'); process.exit(2); }
  const base = env.HP_BASE || 'https://holopocket.fr';
  const paths = env.HP_REGISTER_PATH ? [env.HP_REGISTER_PATH] : DEFAULT_PATHS;
  const fleet = createFleet({
    env, root: DIR, token: env.PANEL_TOKEN, panelUrl: env.PANEL_URL.replace(/\/+$/, ''),
    start: startAccount, makeConfig: buildConfig,
    register: ({ username, password }) => registerWithBrowser({ base, username, password, paths, chromium }),
  });
  const port = +(env.HP_PANEL_PORT || 3100);
  fleet.server().listen(port, '0.0.0.0', () => console.log(ts(), `· Flotte : API à l’écoute sur le port ${port}`));
  await fleet.sync();
  setInterval(() => fleet.sync().catch(() => {}), 15000);
  setInterval(() => fleet.retryDue(), 10000);
  const stop = async () => { console.log(ts(), '· Arrêt demandé'); await fleet.stopAll(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function runSingle() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch {}
  const logs = createLogBuffer(500);
  const logL = (level, ...a) => { console.log(ts(), '·', ...a); logs.push(level, a.map(String).join(' ')); };
  const cfg = buildConfig({ env, file });
  let handle;
  try {
    handle = await startAccount({ cfg, file, env, profileDir: path.join(DIR, 'profile'), logs, logL, onFatal: () => process.exit(1) });
  } catch (e) {
    logL('error', e.fatal ? e.message : `${e.message} Nouvel essai dans ${Math.round((e.retryAfterMs ?? 120000) / 60000)} min.`);
    if (!e.fatal) await sleep(e.retryAfterMs ?? 120000); // évite de se reconnecter en boucle
    process.exit(e.fatal ? 2 : 1);
  }
  // API du panel de gestion (réseau Docker interne uniquement, protégée par PANEL_TOKEN)
  if (env.PANEL_TOKEN) {
    const port = +(env.HP_PANEL_PORT || 3100);
    createPanelServer({
      token: env.PANEL_TOKEN, logs, status: handle.status, sets: handle.sets, applyConfig: handle.applyConfig,
      restart: () => { logL('info', 'Redémarrage demandé depuis le panel'); process.exit(0); },
    }).listen(port, '0.0.0.0', () => logL('info', `API du panel à l’écoute sur le port ${port}`));
  }
  const stop = async () => { logL('info', 'Arrêt demandé'); await handle.stop(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

(env.PANEL_URL ? runFleet() : runSingle()).catch(async (e) => {
  console.log(ts(), '· Arrêt :', e.message, '· nouvel essai dans 2 min');
  await sleep(2 * 60000);
  process.exit(1);
});
