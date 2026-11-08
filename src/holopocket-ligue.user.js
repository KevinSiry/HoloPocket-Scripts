// ==UserScript==
// @name         HoloPocket – Stratège du Conseil 4
// @namespace    kevin.holopocket
// @version      1.2
// @description  Conseil 4 (Ligue) : calcule à chaque coup le booster à ouvrir (ou le Super Bonbon à poser) qui maximise la chance de finir 2 quêtes sur 3 chez chaque membre et de battre les quatre avec l'énergie de Ligue. Mode conseil (surligne le booster) ou mode auto (joue l'essai coup par coup).
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ═════════════════════════ Moteur (pur, testé dans tests/ligue.test.js) ═════════════════════════
  //
  // Modèle
  //  • Un booster donne, pour chaque quête qu'il sert, un nombre de cartes utiles ~ Poisson(perPack)
  //    (perPack = moyenne fournie par le site). Quêtes supposées indépendantes entre elles.
  //  • Quête « Dans un même booster » : réussie d'un coup avec la probabilité 1/oneIn (sinon perPack),
  //    pas de Super Bonbon possible.
  //  • Membre en face : programmation dynamique exacte sur (reste à tirer par quête, énergie, bonbon).
  //  • Membres suivants (cachés) : coût d'un membre ~ loi Gamma (moyenne apprise jour après jour par
  //    membre, CV 0,45). Le Super Bonbon gardé vaut « candyValue » d'énergie sur la suite.
  //  • Objectif : probabilité de battre le Conseil 4 (+ un léger bonus étoiles) ; en rejeu (déjà battu),
  //    espérance d'étoiles.
  const Engine = (function () {
    const CV = 0.45;
    const MAXS = 480; // support des lois de coût futur (au-delà : défaite certaine)

    function poissonTrunc(lam, need) {
      const p = [];
      let pk = Math.exp(-lam), cum = 0;
      for (let h = 0; h < need; h++) { p.push(pk); cum += pk; pk *= lam / (h + 1); }
      p.push(Math.max(0, 1 - cum));
      return p;
    }

    function lgamma(x) {
      const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
      if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
      x -= 1;
      let a = c[0];
      const t = x + g + 0.5;
      for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
      return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
    }

    // Loi discrète du coût d'un membre : Gamma(moyenne, CV) sur 0..MAXS (masse au-delà = perdue)
    function costPmf(mean, cv = CV) {
      const k = 1 / (cv * cv), th = Math.max(1e-6, mean) / k, lg = lgamma(k);
      const pmf = new Float64Array(MAXS + 1);
      let tot = 0;
      for (let x = 0; x <= MAXS; x++) {
        const v = Math.max(0.5, x); // centre de la classe [x-0.5, x+0.5]
        pmf[x] = Math.exp((k - 1) * Math.log(v) - v / th - lg - k * Math.log(th));
        tot += pmf[x];
      }
      // normalise sur une grille assez large pour contenir quasi toute la masse
      const norm = tot > 0 ? 1 / tot : 0;
      for (let x = 0; x <= MAXS; x++) pmf[x] *= norm;
      return pmf;
    }

    function convolve(a, b) {
      const out = new Float64Array(MAXS + 1);
      for (let i = 0; i <= MAXS; i++) {
        if (!a[i]) continue;
        for (let j = 0; i + j <= MAXS; j++) out[i + j] += a[i] * b[j];
      }
      return out;
    }

    // Utilité finale selon l'énergie restante r
    function utility(r, thresholds, objective) {
      if (r < 0) return 0;
      const stars = 1 + (r >= thresholds[0] ? 1 : 0) + (r >= thresholds[1] ? 1 : 0);
      return objective === 'stars' ? stars : 1 + 0.01 * (stars - 1);
    }

    // Table future[c][e] : valeur d'atteindre la fin du membre courant avec e d'énergie et c bonbon
    function futureTable({ maxEnergy, futureMeans, candyValue, thresholds, objective }) {
      let sum = new Float64Array(MAXS + 1); sum[0] = 1;
      for (const m of futureMeans) sum = convolve(sum, costPmf(m));
      const tab = [new Float64Array(maxEnergy + 1), new Float64Array(maxEnergy + 1)];
      for (let c = 0; c < 2; c++) {
        const bonus = c && futureMeans.length ? candyValue : 0;
        for (let e = 0; e <= maxEnergy; e++) {
          let v = 0;
          for (let x = 0; x <= MAXS; x++) {
            if (!sum[x]) continue;
            const spent = Math.max(0, x - bonus);
            if (spent > e) break;
            v += sum[x] * utility(e - spent, thresholds, objective);
          }
          tab[c][e] = v;
        }
      }
      return tab;
    }

    // quests : [{ need, same, candyOk }] (need = cartes encore à tirer, 0 = finie)
    // packs  : [{ id, cost, odds: [{ quest, lam, p }] }]
    function solveStage({ quests, packs, energy, candy, needDone, future }) {
      const memo = new Map();
      const outcomesCache = new Map();

      function outcomes(pack, needs) {
        const key = pack.id + '|' + needs.join(',');
        let res = outcomesCache.get(key);
        if (res) return res;
        let dist = [{ p: 1, needs: needs.slice() }];
        for (const o of pack.odds) {
          const j = o.quest, n = needs[j];
          if (!(n > 0)) continue;
          const next = [];
          if (quests[j].same) {
            const p = Math.min(1, Math.max(0, o.p));
            for (const d of dist) {
              if (p < 1) next.push({ p: d.p * (1 - p), needs: d.needs });
              if (p > 0) { const nn = d.needs.slice(); nn[j] = 0; next.push({ p: d.p * p, needs: nn }); }
            }
          } else {
            const pk = poissonTrunc(o.lam, n);
            for (const d of dist) {
              for (let h = 0; h <= n; h++) {
                if (!pk[h]) continue;
                const nn = h ? d.needs.slice() : d.needs;
                if (h) nn[j] = n - h;
                next.push({ p: d.p * pk[h], needs: nn });
              }
            }
          }
          dist = next;
        }
        res = dist;
        outcomesCache.set(key, res);
        return res;
      }

      const useful = (pack, needs) => pack.odds.some((o) => needs[o.quest] > 0 && (o.lam > 0 || o.p > 0));

      function V(needs, e, c) {
        if (needs.filter((n) => n === 0).length >= needDone) return future[c][e];
        const key = needs.join(',') + '|' + e + '|' + c;
        const hit = memo.get(key);
        if (hit !== undefined) return hit;
        let best = 0;
        if (c) {
          for (let j = 0; j < needs.length; j++) {
            if (needs[j] === 1 && quests[j].candyOk) {
              const nn = needs.slice(); nn[j] = 0;
              best = Math.max(best, V(nn, e, 0));
            }
          }
        }
        for (const pk of packs) {
          if (pk.cost > e || !useful(pk, needs)) continue;
          let v = 0;
          for (const o of outcomes(pk, needs)) v += o.p * V(o.needs, e - pk.cost, c);
          if (v > best) best = v;
        }
        memo.set(key, best);
        return best;
      }

      // Coups possibles depuis un état, triés du meilleur au pire
      function actionsAt(needs, e, c) {
        const actions = [];
        if (needs.filter((n) => n === 0).length >= needDone) return [{ type: 'next', value: future[c][e] }];
        if (c) {
          needs.forEach((n, j) => {
            if (n === 1 && quests[j].candyOk) {
              const nn = needs.slice(); nn[j] = 0;
              actions.push({ type: 'candy', quest: j, value: V(nn, e, 0) });
            }
          });
        }
        for (const pk of packs) {
          if (pk.cost > e || !useful(pk, needs)) continue;
          let v = 0;
          for (const o of outcomes(pk, needs)) v += o.p * V(o.needs, e - pk.cost, c);
          actions.push({ type: 'open', setId: pk.id, cost: pk.cost, value: v });
        }
        // à valeur égale (à 1e-9 près) : bonbon gardé, puis booster le moins cher
        actions.sort((a, b) => (Math.abs(b.value - a.value) > 1e-9 ? b.value - a.value : 0)
          || ((a.type === 'candy') - (b.type === 'candy')) || ((a.cost || 0) - (b.cost || 0)));
        return actions;
      }

      const actions = actionsAt(quests.map((q) => Math.max(0, q.need)), energy, candy ? 1 : 0);
      return { value: actions.length ? actions[0].value : 0, actions, actionsAt };
    }

    const isSame = (label) => /m[êe]me booster/i.test(label || '');

    // Convertit la vue du site (GET /api/tour/:region/ligue) en problème, et décide.
    // opts : { needDone, futureMeans, candyValue }
    function decide(view, opts) {
      const run = view.run;
      const stage = run.stages[run.current];
      const quests = stage.quests.map((q) => ({
        need: Math.max(0, q.count - q.progress),
        same: isSame(q.label),
        candyOk: !isSame(q.label),
      }));
      const packs = (run.shop || []).filter((s) => !s.off).map((s) => ({
        id: s.id, name: s.name, cost: s.cost,
        odds: (s.odds || []).map((o) => ({
          quest: o.quest,
          lam: Math.max(0, Number(o.perPack) || 0),
          p: o.oneIn ? 1 / o.oneIn : Math.min(1, Math.max(0, Number(o.perPack) || 0)),
        })),
      }));
      const objective = run.replay ? 'stars' : 'win';
      const future = futureTable({
        maxEnergy: Math.max(run.energy, view.energy || 0),
        futureMeans: opts.futureMeans,
        candyValue: opts.candyValue,
        thresholds: view.thresholds || [30, 50],
        objective,
      });
      const res = solveStage({ quests, packs, energy: run.energy, candy: !!run.candy, needDone: opts.needDone, future });
      res.objective = objective;
      res.packs = packs;
      return res;
    }

    // Coût « annoncé » d'un membre : somme des needDone quêtes les moins chères (champ cost du site)
    function stageCost(stage, needDone) {
      const c = stage.quests.map((q) => Number(q.cost) || 0).sort((a, b) => a - b);
      return c.slice(0, needDone).reduce((s, x) => s + x, 0);
    }

    return { poissonTrunc, costPmf, futureTable, solveStage, decide, stageCost, utility };
  })();

  if (typeof window === 'undefined' || window.__HP_TEST__) {
    if (typeof window !== 'undefined') window.__hpLigueEngine = Engine;
    return;
  }

  /*__HPUI_KIT__*/

  // ═════════════════════════ Interface et jeu ═════════════════════════
  const AUTO_KEY = 'hp-ligue-auto';
  const STATS_KEY = 'hp-ligue-stats';
  const CANDY_KEY = 'hp-ligue-candy-value';
  const DEFAULT_MEAN = 46;
  const PANEL = 'hp-ligue-panel';
  const BTN_AUTO = 'hp-ligue-auto-btn';
  const BTN_STEP = 'hp-ligue-step-btn';

  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const pct = (x) => (x * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const rawFetch = window.fetch.bind(window);
  async function api(method, path, body) {
    const res = await rawFetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `${res.status} ${data.error || ''}`.trim());
    return data;
  }

  const region = () => (location.pathname.match(/^\/tour\/([^/]+)\/ligue\/?$/) || [])[1];

  function needDone() {
    const b = document.querySelector('.lg-goal b');
    const m = b && b.textContent.match(/Finis\s+(\d+)/);
    return m ? +m[1] : 2;
  }

  // ───── Apprentissage : énergie réellement dépensée chez chaque membre (relevée à chaque essai) ─────
  // hp-ligue-track = { day, idx, member, start } : membre en cours et énergie au moment où on l'a atteint.
  // Quand l'essai passe au membre suivant, la différence d'énergie est enregistrée pour ce membre.
  const TRACK_KEY = 'hp-ligue-track';
  const ANNOUNCED_FACTOR = 1.15; // simulation : coût réel moyen ≈ 1,15 × coût annoncé des 2 quêtes les moins chères
  function track(run) {
    const day = new Date().toISOString().slice(0, 10);
    const t = lsGet(TRACK_KEY, null);
    const won = run.status === 'won';
    if (!won && t && t.day === day && t.idx === run.current) return;
    if (t && t.day === day && (won ? t.idx === run.stages.length - 1 : run.current === t.idx + 1) && t.start >= run.energy) {
      const st = lsGet(STATS_KEY, {});
      st[t.member] = [...(st[t.member] || []), { d: day, c: t.start - run.energy }].slice(-30);
      lsSet(STATS_KEY, st);
    }
    if (won || run.status !== 'playing') { lsSet(TRACK_KEY, null); return; }
    const stage = run.stages[run.current];
    // début de membre seulement si rien n'est encore tiré chez lui (sinon le relevé serait faussé)
    const fresh = !stage.quests.some((q) => q.progress > 0);
    lsSet(TRACK_KEY, fresh ? { day, idx: run.current, member: stage.member, start: run.energy } : null);
  }
  function meanFor(member, fallback) {
    const st = lsGet(STATS_KEY, {});
    const own = st[member] || [];
    if (own.length >= 2) return own.reduce((s, x) => s + x.c, 0) / own.length;
    const all = Object.values(st).flat();
    if (all.length >= 3) return all.reduce((s, x) => s + x.c, 0) / all.length;
    return fallback;
  }

  function plan(view) {
    const run = view.run, nd = needDone();
    const stage = run.stages[run.current];
    const fallback = Math.round((Engine.stageCost(stage, nd) || DEFAULT_MEAN / ANNOUNCED_FACTOR) * ANNOUNCED_FACTOR);
    const futureMembers = run.stages.slice(run.current + 1).map((s) => s.member);
    const futureMeans = futureMembers.map((m) => meanFor(m, fallback));
    const candyValue = Number(lsGet(CANDY_KEY, null)) || Math.round(0.2 * (futureMeans.reduce((s, x) => s + x, 0) / Math.max(1, futureMeans.length) || DEFAULT_MEAN));
    const res = Engine.decide(view, { needDone: nd, futureMeans, candyValue });
    return { res, nd, futureMembers, futureMeans, candyValue, stage };
  }

  function describe(a, view) {
    const run = view.run, stage = run.stages[run.current];
    if (!a) return 'Aucun coup possible';
    if (a.type === 'next') {
      const nxt = run.stages[run.current + 1];
      return nxt ? `Affronter ${nxt.member}` : 'Valider la victoire';
    }
    if (a.type === 'candy') return `Super Bonbon sur « ${stage.quests[a.quest].label} »`;
    const s = run.shop.find((x) => x.id === a.setId);
    return `Ouvrir « ${s ? s.name : a.setId} » (${a.cost} ⚡)`;
  }

  function highlight(a) {
    document.querySelectorAll('.hp-ligue-pick').forEach((el) => { el.classList.remove('hp-ligue-pick'); el.style.outline = ''; el.style.outlineOffset = ''; });
    let el = null;
    if (a && a.type === 'open') el = document.querySelector(`.lg-set[data-set="${CSS.escape(a.setId)}"]`);
    if (a && a.type === 'candy') el = document.querySelector(`.lg-quest[data-q="${a.quest}"]`);
    if (el) { el.classList.add('hp-ligue-pick'); el.style.outline = '3px solid #22c55e'; el.style.outlineOffset = '3px'; }
  }

  function render(view, p) {
    const run = view.run;
    const body = UI.panel(PANEL, { title: 'Stratège du Conseil 4', order: 5 });
    if (!p) {
      const msg = !run ? "Aucun essai en cours : lance l'essai du jour sur le site."
        : run.status === 'won' ? 'Conseil 4 battu ! Il te restait ' + run.energy + " d'énergie."
        : run.status === 'lost' ? "Essai perdu : plus assez d'énergie. Reviens demain."
        : 'Essai terminé.';
      body.innerHTML = `<div class="hp-muted">${UI.esc(msg)}</div>`;
      return;
    }
    const { res, futureMembers, futureMeans, candyValue, stage } = p;
    const best = res.actions[0];
    const label = res.objective === 'stars' ? 'Étoiles espérées' : 'Chance de battre le Conseil 4';
    const fmtV = (v) => res.objective === 'stars' ? v.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' ★' : pct(Math.min(1, v));
    const rows = res.actions.slice(0, 6).map((a, i) => `<div style="display:flex;justify-content:space-between;gap:8px;${i === 0 ? 'font-weight:700' : 'opacity:.8'}"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${UI.esc(describe(a, view))}</span><span style="font-family:var(--font-mono,monospace)">${fmtV(a.value)}</span></div>`).join('');
    const fut = futureMembers.map((m, i) => `${UI.esc(m)} ≈ ${Math.round(futureMeans[i])}`).join(' · ');
    body.innerHTML = `
      <div class="hp-muted" style="font-size:12px">${UI.esc(stage.member)} · ${run.energy} ⚡ · Super Bonbon ${run.candy ? 'en poche' : 'utilisé'}</div>
      <div style="margin:6px 0 2px;font-weight:700;color:#4ade80">${UI.esc(describe(best, view))}</div>
      <div style="margin-bottom:8px">${label} : <b>${fmtV(res.value)}</b></div>
      <div style="display:flex;flex-direction:column;gap:3px;font-size:13px">${rows}</div>
      ${futureMembers.length ? `<div class="hp-muted" style="font-size:12px;margin-top:8px">Coût supposé des suivants : ${fut} · bonbon gardé ≈ ${candyValue} ⚡</div>` : ''}`;
    highlight(best);
  }

  let busy = false, lastView = null, lastPlan = null, lastViewAt = 0;
  const viewWaiters = [];

  // Recalcule le plan à partir d'une vue de la Ligue (venant de notre GET ou d'une réponse du site)
  function applyView(view) {
    if (!view || !region()) return;
    lastView = view;
    lastViewAt = Date.now();
    const run = view.run;
    if (run && run.stages && run.stages[run.current]) { try { track(run); } catch (_) {} }
    lastPlan = run && run.status === 'playing' && run.stages[run.current] && !run.stages[run.current].hidden ? plan(view) : null;
    render(view, lastPlan);
    if (!lastPlan && lsGet(AUTO_KEY, false)) setAuto(false);
    drawButtons();
    viewWaiters.splice(0).forEach((w) => w(view));
  }
  const nextView = (ms) => new Promise((res) => {
    const t = setTimeout(() => { const i = viewWaiters.indexOf(done); if (i >= 0) viewWaiters.splice(i, 1); res(null); }, ms);
    const done = (v) => { clearTimeout(t); res(v); };
    viewWaiters.push(done);
  });

  // ───── Écoute des réponses du site : chaque coup joué (par toi ou par le script) met à jour les chances ─────
  // Les actions de la Ligue (ouvrir, bonbon, suivant…) renvoient toute la vue : on la lit au passage.
  const LIGUE_RE = /\/api\/tour\/[^/?#]+\/ligue(?:\/(?:open|candy|next|abandon|start))?(?:[?#]|$)/;
  // Selon le navigateur, Tampermonkey peut isoler le script : on accroche le fetch de la page elle-même.
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (!PAGE.__hpLigueHook) {
    PAGE.__hpLigueHook = true;
    const orig = PAGE.fetch;
    PAGE.fetch = async function (input, init) {
      const res = await orig.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (res.ok && LIGUE_RE.test(new URL(url, location.href).pathname)) {
          res.clone().json().then((d) => { if (d && 'run' in d) applyView(d); }).catch(() => {});
        }
      } catch (_) {}
      return res;
    };
  }

  // ───── Filet de sécurité : si l'affichage de la Ligue change (barres, énergie, membre),
  // on relit l'état (au plus une fois par seconde et demie), même si l'écoute ci-dessus n'a rien vu.
  let domTimer = null, domGetAt = 0;
  function onDomChange() {
    if (!region() || busy) return;
    clearTimeout(domTimer);
    domTimer = setTimeout(async () => {
      if (Date.now() - lastViewAt < 1200 || Date.now() - domGetAt < 1500) return;
      domGetAt = Date.now();
      try { await refresh(); } catch (_) {}
    }, 700);
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (el && !el.closest('#hp-panels,#hp-dock') && el.closest('.lg-main,.lg-top,[class*="lg-"]')) { onDomChange(); return; }
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onDomChange(); });

  async function refresh() {
    const r = region();
    if (!r) return null;
    applyView(await api('GET', `/tour/${encodeURIComponent(r)}/ligue`));
    return lastPlan;
  }

  // ───── Jouer un coup en cliquant les boutons du site (l'affichage du site reste à jour, sans recharger) ─────
  const findBtn = (root, re) => root && [...root.querySelectorAll('button')].find((b) => re.test(b.textContent.replace(/\s+/g, ' ').trim()));
  const ready = (b) => b && !b.disabled && b.getAttribute('aria-busy') !== 'true';
  async function waitFor(fn, ms) {
    const t0 = Date.now();
    for (;;) { const x = fn(); if (x) return x; if (Date.now() - t0 > ms) return null; await sleep(150); }
  }
  function buttonFor(a) {
    if (a.type === 'open') return findBtn(document.querySelector(`.lg-set[data-set="${CSS.escape(a.setId)}"]`), /^Ouvrir\b/);
    if (a.type === 'candy') return document.querySelector(`.lg-quest[data-q="${a.quest}"] .lg-candy-btn`);
    if (a.type === 'next') return findBtn(document, /^Affronter\b/);
    return null;
  }
  async function act(a) {
    const btn = await waitFor(() => { const b = buttonFor(a); return ready(b) ? b : null; }, 6000);
    if (btn) {
      const wait = nextView(12000);
      btn.click();
      if (a.type === 'candy') {
        // fenêtre de confirmation du site : « L'utiliser »
        const ok = await waitFor(() => { const b = findBtn(document, /L.utiliser$/); return ready(b) ? b : null; }, 4000);
        if (!ok) throw new Error('confirmation du Super Bonbon introuvable');
        ok.click();
      }
      if (await wait) return;
      await refresh(); // le site n'a rien renvoyé d'exploitable : relecture directe
      return;
    }
    // Bouton introuvable (page pas encore dessinée…) : appel direct, puis relecture
    const r = encodeURIComponent(region());
    if (a.type === 'next') await api('POST', `/tour/${r}/ligue/next`);
    else if (a.type === 'candy') await api('POST', `/tour/${r}/ligue/candy`, { quest: a.quest });
    else await api('POST', `/tour/${r}/ligue/open`, { setId: a.setId, count: 1 });
    await refresh();
    UI.toast("Coup joué hors des boutons du site : son affichage peut avoir un coup de retard (l'aperçu ci-contre est à jour).", { kind: 'info' });
  }

  async function play() {
    if (busy) return;
    busy = true; drawButtons();
    try {
      const p = Date.now() - lastViewAt < 4000 ? lastPlan : await refresh();
      if (!p) return;
      const a = p.res.actions[0];
      if (!a) { UI.toast("Plus aucun coup utile : l'essai est perdu.", { kind: 'error' }); setAuto(false); return; }
      await act(a);
    } catch (e) {
      UI.toast('Ligue : ' + UI.esc(e.message), { kind: 'error', ms: 0 });
      setAuto(false);
    } finally {
      busy = false; drawButtons();
      if (lsGet(AUTO_KEY, false)) schedulePlay();
    }
  }

  function setAuto(on) { lsSet(AUTO_KEY, !!on); drawButtons(); if (on) schedulePlay(); }
  let timer = null;
  function schedulePlay() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (lsGet(AUTO_KEY, false) && region()) play(); }, window.__hp.jitter(2600, 0.35));
  }

  function drawButtons() {
    if (!region()) { UI.removeButton(BTN_AUTO); UI.removeButton(BTN_STEP); return; }
    const auto = lsGet(AUTO_KEY, false);
    const can = !!(lastPlan && lastPlan.res.actions.length);
    UI.button(BTN_STEP, {
      kind: 'primary', icon: 'zap', order: 10, busy, disabled: busy || !can,
      label: 'Jouer le meilleur coup',
      sub: can ? describe(lastPlan.res.actions[0], lastView) : '—',
      onClick: () => play(),
    });
    UI.button(BTN_AUTO, {
      kind: 'toggle', icon: 'repeat', order: 11, on: auto,
      label: 'Conseil 4 en auto',
      sub: auto ? 'joue coup par coup' : 'arrêté',
      onClick: () => setAuto(!lsGet(AUTO_KEY, false)),
    });
  }

  // ───── Navigation SPA : s'active uniquement sur /tour/:region/ligue ─────
  let lastPath = null;
  async function onRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (!region()) { UI.removePanel(PANEL); drawButtons(); highlight(null); return; }
    try { await refresh(); } catch (e) { UI.toast('Ligue : ' + UI.esc(e.message), { kind: 'error' }); }
    if (lsGet(AUTO_KEY, false)) schedulePlay();
  }
  setInterval(onRoute, 800);
  // ré-applique le surlignage quand le site redessine la boutique
  setInterval(() => { if (region() && lastPlan) highlight(lastPlan.res.actions[0]); }, 1500);
  onRoute();
})();
