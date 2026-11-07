// Alertes calculées à partir du dernier état connu de chaque bot.
const MIN = 60000;
const OFFLINE_AFTER = 30000;
const TRADES_FULL_AFTER = 120 * MIN;
const ENERGY_FULL_AFTER = 10 * MIN;
const ERROR_WINDOW = 15 * MIN;

function computeAlerts(bots, now = Date.now()) {
  const out = [];
  const add = (bot, level, code, text) => out.push({ bot: bot.name, level, code, text });
  for (const b of bots) {
    if (!b.online) {
      if (b.lastSeen == null || now - b.lastSeen > OFFLINE_AFTER) add(b, 'error', 'offline', b.lastSeen == null ? 'Le bot ne répond pas.' : `Le bot ne répond plus depuis ${Math.round((now - b.lastSeen) / MIN)} min.`);
      continue;
    }
    const s = b.status;
    if (!s) continue;
    if (!s.bot.sessionOk) add(b, 'error', 'session', 'Session HoloPocket perdue : le bot tente de se reconnecter.');
    if (s.account && s.account.quarantined) add(b, 'error', 'quarantine', 'Compte en quarantaine sur HoloPocket.');
    if (s.trades.fullSince && now - Date.parse(s.trades.fullSince) > TRADES_FULL_AFTER) add(b, 'warn', 'trades-full', 'Échanges à 20/20 depuis plus de 2 h : aucun nouvel échange possible.');
    const booster = s.scripts.find((x) => x.name === 'auto-booster');
    if (s.account && s.account.energy.fullSince && booster && booster.on && now - Date.parse(s.account.energy.fullSince) > ENERGY_FULL_AFTER) add(b, 'warn', 'energy-full', 'Énergie pleine depuis plus de 10 min alors que l’ouverture auto est active.');
    const flipOn = s.scripts.find((x) => x.name === 'achat-revente' && x.on);
    if (flipOn && s.flip && s.flip.lastPassAt && now - Date.parse(s.flip.lastPassAt) > 5 * MIN) add(b, 'warn', 'flip-stalled', `Achat-revente actif mais aucun passage depuis ${Math.round((now - Date.parse(s.flip.lastPassAt)) / MIN)} min.`);
    if (flipOn && s.flip && s.flip.error) add(b, 'warn', 'flip-error', `Achat-revente : ${s.flip.error}`);
    const err = (b.logs || []).filter((l) => l.level === 'error' && now - Date.parse(l.at) < ERROR_WINDOW).pop();
    if (err) add(b, 'warn', 'script-error', `Erreur d’un script : ${err.text}`);
  }
  return out;
}

module.exports = { computeAlerts };
