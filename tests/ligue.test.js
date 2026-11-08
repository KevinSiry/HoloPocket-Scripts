// Stratège du Conseil 4 : moteur de décision (programmation dynamique).
// Lancer : node --test tests/ligue.test.js   (simulation longue : HP_SIM=1)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'holopocket-ligue.user.js'), 'utf8');
const ctx = { window: { __HP_TEST__: true }, Math, Map, Set, Float64Array, Number, Array, Object, JSON };
vm.runInNewContext(code, ctx);
const E = ctx.window.__hpLigueEngine;

// Vue réelle relevée le 9 nov. 2026 (Olga, début d'essai)
const olga = () => ({
  energy: 160, thresholds: [30, 50],
  run: {
    status: 'playing', replay: false, energy: 160, current: 0, candy: true,
    stages: [
      { member: 'Olga', hidden: false, quests: [
        { index: 0, label: 'Ouvre des boosters « EX Tempête de sable » et tires-y 3 Pokémon Eau', count: 3, progress: 0, cost: 17 },
        { index: 1, label: 'Tire 3 cartes ex dans « Domination Céleste »', count: 3, progress: 0, cost: 23 },
        { index: 2, label: 'Tire 2 exemplaires de « Total Soin » dans « Clash des Rebelles »', count: 2, progress: 0, cost: 32 },
      ] },
      { member: 'Aldo', hidden: true, quests: [] },
      { member: 'Agatha', hidden: true, quests: [] },
      { member: 'Peter', hidden: true, quests: [] },
    ],
    shop: [
      { id: 'ex2', name: 'EX Tempête de sable', cost: 10, off: null, odds: [{ quest: 0, perPack: 1.726707425907426, oneIn: null }] },
      { id: 'swsh2', name: 'Clash des Rebelles', cost: 1, off: null, odds: [{ quest: 2, perPack: 0.06328366782006921, oneIn: 16 }] },
      { id: 'B4', name: 'Domination Céleste', cost: 1, off: null, odds: [{ quest: 1, perPack: 0.1324644341818182, oneIn: 8 }] },
    ],
  },
});
const OPTS = { needDone: 2, futureMeans: [46, 46, 46], candyValue: 9 };

test('loi de Poisson tronquée : somme 1', () => {
  for (const [lam, n] of [[0.1, 3], [1.7, 3], [4, 1]]) {
    const p = E.poissonTrunc(lam, n);
    assert.strictEqual(p.length, n + 1);
    assert.ok(Math.abs(p.reduce((s, x) => s + x, 0) - 1) < 1e-12);
  }
});

test('loi de coût Gamma : moyenne respectée', () => {
  const pmf = E.costPmf(40);
  let m = 0, t = 0;
  pmf.forEach((p, x) => { m += p * x; t += p; });
  assert.ok(Math.abs(t - 1) < 1e-9);
  assert.ok(Math.abs(m - 40) < 1.5, 'moyenne ' + m);
});

test('Olga : ouvre un booster utile, chance cohérente', () => {
  const r = E.decide(olga(), OPTS);
  assert.strictEqual(r.actions[0].type, 'open');
  assert.ok(r.value > 0.05 && r.value < 0.95, 'valeur ' + r.value);
  // Clash des Rebelles (quête la plus chère) ne doit pas être le premier choix
  assert.notStrictEqual(r.actions[0].setId, 'swsh2');
});

test('Super Bonbon : posé quand il finit le membre sur la dernière carte la plus chère', () => {
  const v = olga();
  const q = v.run.stages[0].quests;
  q[1].progress = 3; // ex finie
  q[2].progress = 1; // il manque un Total Soin (≈ 16 boosters)
  const r = E.decide(v, OPTS);
  assert.strictEqual(r.actions[0].type, 'candy');
  assert.strictEqual(r.actions[0].quest, 2);
});

test('Super Bonbon : gardé quand la dernière carte ne coûte presque rien', () => {
  const v = olga();
  v.run.shop[2].odds[0].perPack = 3; v.run.shop[2].odds[0].oneIn = null; // un ex par booster en moyenne ×3
  const q = v.run.stages[0].quests;
  q[0].progress = 3; q[1].progress = 2;
  const r = E.decide(v, OPTS);
  assert.strictEqual(r.actions[0].type, 'open');
  assert.strictEqual(r.actions[0].setId, 'B4');
});

test('deux quêtes finies : passer au membre suivant', () => {
  const v = olga();
  const q = v.run.stages[0].quests;
  q[0].progress = 3; q[1].progress = 3;
  const r = E.decide(v, OPTS);
  assert.strictEqual(r.actions[0].type, 'next');
});

test('quête « même booster » : pas de bonbon', () => {
  const v = olga();
  const q = v.run.stages[0].quests;
  q[2].label = 'Tire 2 Pokémon Feu dans un même booster';
  q[2].progress = 1; q[1].progress = 3;
  const r = E.decide(v, OPTS);
  assert.ok(!r.actions.some((a) => a.type === 'candy' && a.quest === 2));
});

// Simulation : la DP contre l'heuristique « À viser » du site (2 quêtes les moins chères, booster le plus rentable)
function simulate(policy, runs, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pois = (lam) => { let k = 0, p = Math.exp(-lam), c = p; const u = rnd(); while (u > c && k < 50) { k++; p *= lam / k; c += p; } return k; };
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const v = olga();
    let ok = true;
    for (let st = 0; st < 4 && ok; st++) {
      v.run.current = st;
      v.run.stages[st] = JSON.parse(JSON.stringify(olga().run.stages[0]));
      for (;;) {
        const qs = v.run.stages[st].quests;
        if (qs.filter((q) => q.progress >= q.count).length >= 2) break;
        const a = policy(v);
        if (!a) { ok = false; break; }
        if (a.type === 'candy') { qs[a.quest].progress = qs[a.quest].count; v.run.candy = false; continue; }
        const sh = v.run.shop.find((x) => x.id === a.setId);
        v.run.energy -= sh.cost;
        for (const o of sh.odds) qs[o.quest].progress += pois(o.perPack);
      }
    }
    if (ok) wins++;
  }
  return wins / runs;
}
// La DP garde sa mémo pour tout le membre en cours (même état ⇒ même décision qu'un appel neuf)
let dpCache = null;
const dpPolicy = (v) => {
  const run = v.run, qs = run.stages[run.current].quests;
  if (!dpCache || dpCache.stage !== run.current || dpCache.view !== v) {
    const futureMeans = run.stages.slice(run.current + 1).map(() => 46);
    dpCache = { stage: run.current, view: v, res: E.decide(v, { needDone: 2, futureMeans, candyValue: 9 }) };
  }
  const acts = dpCache.res.actionsAt(qs.map((q) => Math.max(0, q.count - q.progress)), run.energy, run.candy ? 1 : 0);
  return acts[0] && acts[0].type !== 'next' ? acts[0] : null;
};
const aimPolicy = (v) => {
  const qs = v.run.stages[v.run.current].quests;
  const left = qs.map((q, i) => ({ i, rest: Math.max(0, q.count - q.progress) * q.cost / q.count, done: q.progress >= q.count }))
    .filter((x) => !x.done).sort((a, b) => a.rest - b.rest);
  const need = 2 - qs.filter((q) => q.progress >= q.count).length;
  const aim = left.slice(0, need).map((x) => x.i);
  if (v.run.candy) { const one = aim.find((i) => qs[i].count - qs[i].progress === 1 && left.length === need); if (one !== undefined && need === 1) return { type: 'candy', quest: one }; }
  const packs = v.run.shop.filter((s) => s.cost <= v.run.energy && s.odds.some((o) => aim.includes(o.quest)));
  if (!packs.length) return null;
  packs.sort((a, b) => b.odds.reduce((t, o) => t + (aim.includes(o.quest) ? o.perPack : 0), 0) / b.cost - a.odds.reduce((t, o) => t + (aim.includes(o.quest) ? o.perPack : 0), 0) / a.cost);
  return { type: 'open', setId: packs[0].id };
};

test('simulation : la DP fait au moins aussi bien que « À viser »', { skip: !process.env.HP_SIM }, () => {
  const N = Number(process.env.HP_SIM) > 1 ? Number(process.env.HP_SIM) : 400;
  const dp = simulate(dpPolicy, N, 7), aim = simulate(aimPolicy, N, 7);
  console.log(`victoires sur ${N} essais (4 × Olga) : DP ${(dp * 100).toFixed(1)} % · À viser ${(aim * 100).toFixed(1)} %`);
  assert.ok(dp >= aim - 0.03);
});
