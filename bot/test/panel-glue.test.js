const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pc = require('../panel-config');
const { createGlue } = require('../panel-glue');
const { createLogBuffer } = require('../log-buffer');

const SETS = [
  { id: 'me05', name: 'Nuit Noire', favorite: true, promo: false, packCost: 1 },
  { id: 'sv1', name: 'Autre', favorite: false, promo: false, packCost: 2 },
  { id: 'promo', name: 'Promo', favorite: true, promo: true },
];

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-glue-'));
  const file = path.join(dir, 'panel-config.json');
  const rec = { initScripts: [], liveSets: [], loads: 0, fetches: [] };
  let clock = 1_000_000;
  const world = {
    site: {
      me: { me: { username: 'kevin', balance: 500, packs: { stock: 3, max: 10 }, quarantined: false } },
      sent: [{ status: 'pending', from: 'kevin' }, { status: 'accepted', from: 'kevin' }, { status: 'pending', from: 'autre' }],
      counts: { selling: 2, maxSelling: 10 },
      sets: SETS,
    },
    ...over.world,
  };
  const cfg = {
    scripts: ['holopocket-auto-booster.user.js', 'holopocket-echanges.user.js'],
    toggles: {}, exclude: [], defaultBooster: '', priorityTarget: '',
  };
  const baseScripts = [...cfg.scripts];
  const state = { panelCfg: pc.readConfig(file) };
  let loaded = cfg.scripts.map((n) => ({ name: n, version: '1.0', code: '' }));
  const buildToggles = () => ({
    ...Object.fromEntries(cfg.scripts.map((n) => [`on:${pc.toName(n)}`, '1'])),
    'hp-booster-force': state.panelCfg.booster.mode === 'fixed' ? state.panelCfg.booster.setId : '',
  });
  cfg.toggles = buildToggles();
  const logs = createLogBuffer(50);
  const glue = createGlue({
    page: {
      evaluate: async (fn, arg) => {
        if (arg !== undefined) { rec.liveSets.push(arg); return undefined; }
        if (world.pageDown) throw new Error('page fermée');
        return fn.name === 'readSets' ? world.site.sets : world.site;
      },
    },
    ctx: { addInitScript: async (fn, arg) => { rec.initScripts.push(arg); } },
    cfg, state, file, baseScripts, buildToggles, setLS: function setLS() {},
    getScripts: () => loaded, setScripts: (l) => { loaded = l; },
    fetchScripts: async (names) => {
      rec.fetches.push(names);
      if (over.fetchFails) throw new Error('GitHub injoignable');
      return names.map((n) => ({ name: n, version: '2.0', code: '' }));
    },
    load: async () => { rec.loads++; },
    logs, log: (...a) => logs.push('info', a.join(' ')),
    name: 'compte1', startedAt: 900_000, now: () => clock,
  });
  return { glue, cfg, state, rec, file, tick: (ms) => { clock += ms; }, world, get loaded() { return loaded; } };
}

test('état : compte, échanges (seulement les miens en attente), ventes, scripts, favoris sans promo', async () => {
  const s = setup();
  const st = await s.glue.status();
  assert.strictEqual(st.account.user, 'kevin');
  assert.strictEqual(st.account.balance, 500);
  assert.deepStrictEqual(st.account.energy, { stock: 3, max: 10, fullSince: null });
  assert.deepStrictEqual(st.trades, { open: 1, max: 20, fullSince: null });
  assert.deepStrictEqual(st.sales, { selling: 2, max: 10 });
  assert.strictEqual(st.bot.sessionOk, true);
  assert.deepStrictEqual(st.booster, { mode: 'auto', setId: null, favorites: [{ id: 'me05', name: 'Nuit Noire' }] });
  assert.deepStrictEqual(st.scripts.map((x) => [x.name, x.on]),
    [['auto-booster', true], ['echanges', true], ['vendre-doublons', false], ['recyclage', false], ['achat-revente', false]]);
});

test('état : « depuis quand » pour l’énergie pleine et les échanges à 20/20', async () => {
  const s = setup();
  s.world.site.me.me.packs = { stock: 10, max: 10 };
  s.world.site.sent = Array.from({ length: 20 }, () => ({ status: 'pending', from: 'kevin' }));
  const a = await s.glue.status();
  assert.ok(a.account.energy.fullSince && a.trades.fullSince);
  s.tick(60_000);
  const b = await s.glue.status();
  assert.strictEqual(b.account.energy.fullSince, a.account.energy.fullSince, 'le début ne bouge pas tant que ça dure');
  s.world.site.me.me.packs = { stock: 2, max: 10 };
  s.tick(10_000);
  assert.strictEqual((await s.glue.status()).account.energy.fullSince, null);
});

test('état : mis en cache 5 s', async () => {
  const s = setup();
  const a = await s.glue.status();
  s.world.site.me.me.balance = 999;
  assert.strictEqual((await s.glue.status()).account.balance, a.account.balance);
  s.tick(6000);
  assert.strictEqual((await s.glue.status()).account.balance, 999);
});

test('état : session perdue → compte null, bot toujours décrit', async () => {
  const s = setup({ world: { site: { me: null, sent: null, counts: null, sets: null } } });
  const st = await s.glue.status();
  assert.strictEqual(st.account, null);
  assert.strictEqual(st.bot.sessionOk, false);
  assert.strictEqual(st.trades.open, null);
});

test('état : page fermée → pas d’erreur, session perdue', async () => {
  const s = setup({ world: { pageDown: true } });
  assert.strictEqual((await s.glue.status()).bot.sessionOk, false);
});

test('séries : liste simplifiée', async () => {
  const s = setup();
  const l = await s.glue.sets();
  assert.deepStrictEqual(l[1], { id: 'sv1', name: 'Autre', favorite: false, promo: false, packCost: 2 });
});

test('booster fixe : appliqué tout de suite, sans recharger la page, et conservé sur disque', async () => {
  const s = setup();
  const r = await s.glue.applyConfig({ booster: { mode: 'fixed', setId: 'sv1' } });
  assert.deepStrictEqual(r, { scriptsReloaded: false });
  assert.strictEqual(s.rec.loads, 0);
  assert.strictEqual(s.rec.liveSets.at(-1)['hp-booster-force'], 'sv1');
  assert.strictEqual(s.rec.initScripts.at(-1)['hp-booster-force'], 'sv1', 'doit survivre à un rechargement');
  assert.deepStrictEqual(pc.readConfig(s.file).booster, { mode: 'fixed', setId: 'sv1' });
  assert.strictEqual((await s.glue.status()).booster.mode, 'fixed');
  await s.glue.applyConfig({ booster: { mode: 'auto' } });
  assert.strictEqual(s.rec.liveSets.at(-1)['hp-booster-force'], '');
});

test('scripts : couper un script le décharge et recharge la page', async () => {
  const s = setup();
  const r = await s.glue.applyConfig({ scripts: { echanges: false } });
  assert.deepStrictEqual(r, { scriptsReloaded: true });
  assert.deepStrictEqual(s.rec.fetches.at(-1), ['holopocket-auto-booster.user.js']);
  assert.strictEqual(s.rec.loads, 1);
  assert.deepStrictEqual(s.cfg.scripts, ['holopocket-auto-booster.user.js']);
  assert.strictEqual((await s.glue.status()).scripts.find((x) => x.name === 'echanges').on, false);
  assert.deepStrictEqual(pc.readConfig(s.file).scripts, { echanges: false });
});

test('scripts : en activer un nouveau active aussi son interrupteur auto', async () => {
  const s = setup();
  await s.glue.applyConfig({ scripts: { 'achat-revente': true } });
  assert.strictEqual(s.rec.liveSets.at(-1)['on:achat-revente'], '1');
  assert.strictEqual(s.rec.loads, 1);
});

test('scripts : rien à changer → pas de rechargement', async () => {
  const s = setup();
  const r = await s.glue.applyConfig({ scripts: { echanges: true } });
  assert.deepStrictEqual(r, { scriptsReloaded: false });
  assert.strictEqual(s.rec.loads, 0);
});

test('scripts : téléchargement impossible → rien n’est modifié ni écrit', async () => {
  const s = setup({ fetchFails: true });
  await assert.rejects(() => s.glue.applyConfig({ scripts: { echanges: false } }), /GitHub injoignable/);
  assert.deepStrictEqual(s.cfg.scripts, ['holopocket-auto-booster.user.js', 'holopocket-echanges.user.js']);
  assert.strictEqual(fs.existsSync(s.file), false);
  assert.strictEqual(s.rec.loads, 0);
});

test('modifications en série : deux demandes simultanées ne se chevauchent pas', async () => {
  const s = setup();
  await Promise.all([
    s.glue.applyConfig({ scripts: { echanges: false } }),
    s.glue.applyConfig({ scripts: { recyclage: true } }),
    s.glue.applyConfig({ booster: { mode: 'fixed', setId: 'me05' } }),
  ]);
  assert.deepStrictEqual(pc.readConfig(s.file), { booster: { mode: 'fixed', setId: 'me05' }, scripts: { echanges: false, recyclage: true } });
  assert.deepStrictEqual(s.cfg.scripts, ['holopocket-auto-booster.user.js', 'holopocket-recyclage.user.js']);
});
