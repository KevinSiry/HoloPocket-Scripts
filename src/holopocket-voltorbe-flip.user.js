// ==UserScript==
// @name         HoloPocket – Assistant Voltorbe Flip
// @namespace    kevin.holopocket
// @version      3.0
// @description  Aide au Voltorbe Flip par déduction exacte : énumère toutes les grilles compatibles avec les indices visibles et les cases déjà retournées, marque les cases certaines (sûres / Voltorbe / à retourner) et le risque des autres. Ne lit aucune case cachée, ne clique pas à ta place.
// @match        https://holopocket.fr/jeux/voltorbe-flip*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const POLL_MS = 1000;
  const NODE_CAP = 150000; // au-delà, repli sur l'approximation par ligne (borne le temps de calcul)

  // ───────── Lecture de l'état : indices (API, public) + cases révélées (DOM, ce que tu vois) ─────────
  async function clues() {
    const g = await (await fetch('/api/games/voltorb', { credentials: 'same-origin' })).json();
    const grid = g.grid;
    if (!grid || !grid.rows || !grid.cols) return null;
    return {
      rows: grid.rows.map((x) => ({ p: x.points, v: x.voltorbs })),
      cols: grid.cols.map((x) => ({ p: x.points, v: x.voltorbs })),
      over: g.over, cleared: g.cleared, level: g.level, lives: g.lives,
    };
  }

  // Cases révélées lues sur les libellés "Ligne R, colonne C : VALEUR" (0 = Voltorbe)
  function readReveals() {
    const rev = Array.from({ length: 5 }, () => Array(5).fill(null));
    const btns = {};
    for (const b of document.querySelectorAll('button[aria-label]')) {
      const m = b.getAttribute('aria-label').match(/Ligne (\d+), colonne (\d+)\s*(?::\s*(.+))?$/i);
      if (!m) continue;
      const r = +m[1] - 1, c = +m[2] - 1;
      btns[`${r},${c}`] = b;
      const val = (m[3] || '').trim();
      if (!val) continue;
      if (/voltorbe/i.test(val)) rev[r][c] = 0;
      else if (/^[123]$/.test(val)) rev[r][c] = +val;
    }
    return { rev, btns };
  }

  // ───────── Moteur : énumération des grilles compatibles ─────────
  // Lignes possibles pour une clue (p points, v voltorbes), compatibles avec les cases révélées.
  function genRows(p, v, revealed) {
    const res = [];
    (function rec(i, cells, zeros, sum) {
      if (i === 5) { if (zeros === v && sum === p) res.push(cells.slice()); return; }
      const opts = revealed[i] != null ? [revealed[i]] : [0, 1, 2, 3];
      for (const x of opts) {
        const nz = zeros + (x === 0 ? 1 : 0), ns = sum + (x === 0 ? 0 : x);
        if (nz > v || ns > p) continue;
        cells.push(x); rec(i + 1, cells, nz, ns); cells.pop();
      }
    })(0, [], 0, 0);
    return res;
  }

  // Marginales exactes par énumération, avec bornes de faisabilité et limite de nœuds.
  // Renvoie null si le calcul dépasse la limite (→ repli approché).
  function exactMarginals(rows, cols, rev) {
    const rowOpts = rows.map((c, r) => genRows(c.p, c.v, rev[r]));
    if (rowOpts.some((o) => o.length === 0)) return { total: 0 }; // incohérent (mauvaise lecture)
    const colZeros = Array(5).fill(0), colSum = Array(5).fill(0);
    const cntV = Array.from({ length: 5 }, () => Array(5).fill(0));
    const cntGE2 = Array.from({ length: 5 }, () => Array(5).fill(0));
    const cur = Array.from({ length: 5 }, () => Array(5).fill(0));
    let total = 0, nodes = 0, capped = false;
    (function dfs(r) {
      if (capped) return;
      if (++nodes > NODE_CAP) { capped = true; return; }
      if (r === 5) {
        for (let c = 0; c < 5; c++) if (colZeros[c] !== cols[c].v || colSum[c] !== cols[c].p) return;
        total++;
        for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
          if (cur[a][b] === 0) cntV[a][b]++; else if (cur[a][b] >= 2) cntGE2[a][b]++;
        }
        return;
      }
      const left = 5 - r - 1; // lignes restantes après celle-ci
      for (const row of rowOpts[r]) {
        let ok = true;
        for (let c = 0; c < 5; c++) {
          const z = colZeros[c] + (row[c] === 0 ? 1 : 0), s = colSum[c] + (row[c] === 0 ? 0 : row[c]);
          // bornes : les voltorbes et points restants doivent pouvoir atteindre la cible
          if (z > cols[c].v || s > cols[c].p || z + left < cols[c].v || s + left * 3 < cols[c].p) { ok = false; break; }
        }
        if (!ok) continue;
        for (let c = 0; c < 5; c++) { if (row[c] === 0) colZeros[c]++; else colSum[c] += row[c]; cur[r][c] = row[c]; }
        dfs(r + 1);
        for (let c = 0; c < 5; c++) { if (row[c] === 0) colZeros[c]--; else colSum[c] -= row[c]; }
      }
    })(0);
    if (capped) return null;
    return { total, cntV, cntGE2 };
  }

  // Repli approximatif par ligne (si trop de solutions) — risque uniquement, pas de certitude croisée
  function approxMarginals(rows, cols, rev) {
    const comp = (() => { const m = new Map(); return function c(s, k) { if (k === 0) return s === 0 ? 1 : 0; if (s < k || s > 3 * k) return 0; const key = s * 100 + k; if (m.has(key)) return m.get(key); let t = 0; for (let d = 1; d <= 3; d++) t += c(s - d, k - 1); m.set(key, t); return t; }; })();
    const line = (clue, cells) => { let p = clue.p, v = clue.v, n = 0; for (const [r, c] of cells) { if (rev[r][c] != null) { if (rev[r][c] > 0) p -= rev[r][c]; } else n++; } const k = n - v; return { n, v, p, k }; };
    const rowCells = (r) => Array.from({ length: 5 }, (_, c) => [r, c]);
    const colCells = (c) => Array.from({ length: 5 }, (_, r) => [r, c]);
    const pv = (L) => L.n === 0 ? 0 : L.v / L.n;
    const p2 = (L) => { if (L.n === 0 || L.k <= 0) return 0; const tot = comp(L.p, L.k); if (!tot) return 0; return (L.k / L.n) * ((comp(L.p - 2, L.k - 1) + comp(L.p - 3, L.k - 1)) / tot); };
    const cV = (a, b) => a === 0 || b === 0 ? 0 : a === 1 || b === 1 ? 1 : (a * b) / (a * b + (1 - a) * (1 - b));
    const cntV = Array.from({ length: 5 }, () => Array(5).fill(0)), cntGE2 = Array.from({ length: 5 }, () => Array(5).fill(0));
    const total = 1;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      if (rev[r][c] != null) { cntV[r][c] = rev[r][c] === 0 ? 1 : 0; cntGE2[r][c] = rev[r][c] >= 2 ? 1 : 0; continue; }
      const Lr = line(rows[r], rowCells(r)), Lc = line(cols[c], colCells(c));
      cntV[r][c] = cV(pv(Lr), pv(Lc));
      const safe = 1 - cntV[r][c];
      cntGE2[r][c] = safe * (1 - cV(1 - p2(Lr), 1 - p2(Lc)));
    }
    return { total, cntV, cntGE2, approx: true };
  }

  function analyse(state, rev) {
    let m = exactMarginals(state.rows, state.cols, rev);
    if (m === null) m = approxMarginals(state.rows, state.cols, rev);
    const approx = !!m.approx;
    const T = m.total || 1;
    const cells = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
      if (rev[r][c] != null) { cells.push({ r, c, revealed: true, value: rev[r][c] }); continue; }
      const pV = approx ? m.cntV[r][c] : m.cntV[r][c] / T;
      const pGE2 = approx ? m.cntGE2[r][c] : m.cntGE2[r][c] / T;
      cells.push({ r, c, pV, pGE2 });
    }
    return { cells, approx, total: m.total, inconsistent: m.total === 0 };
  }

  // ───────── Overlay ─────────
  const pct = (x) => `${Math.round(x * 100)}%`;
  function colorFor(pV) { if (pV === 0) return '#1f9d55'; if (pV >= 0.5) return '#c0392b'; if (pV >= 0.25) return '#e67e22'; return '#b7950b'; }

  let layer = null;
  function ensureLayer() {
    if (layer && document.body.contains(layer)) return layer;
    layer = document.createElement('div');
    layer.id = 'hp-vf-layer';
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: 99998, pointerEvents: 'none' });
    document.body.appendChild(layer);
    return layer;
  }
/*__HPUI_KIT__*/

  // Panneau dans la colonne commune du kit (repliable)
  function panel() { return UI.panel('hp-vf-panel', { title: 'Assistant Voltorbe Flip', order: 30 }); }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function badge(lay, b, { border, glow, text, bg }) {
    const rect = b.getBoundingClientRect();
    if (rect.width === 0) return;
    const d = document.createElement('div');
    Object.assign(d.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, boxSizing: 'border-box', border: `3px solid ${border}`, borderRadius: '10px', display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', pointerEvents: 'none', boxShadow: glow ? `0 0 0 3px ${glow}, 0 0 12px ${glow}` : 'none' });
    const tag = document.createElement('span');
    tag.textContent = text;
    Object.assign(tag.style, { margin: '3px', padding: '1px 5px', borderRadius: '7px', background: bg, color: '#fff', font: '700 11px system-ui, sans-serif' });
    d.appendChild(tag); lay.appendChild(d);
  }

  let lastSig = null, lastAnalysis = null;
  function render(state) {
    const { rev, btns } = readReveals();
    const sig = JSON.stringify([state.rows, state.cols, state.over, rev]);
    if (sig !== lastSig) { lastAnalysis = analyse(state, rev); lastSig = sig; } // recalcul seulement si une case a changé
    const { cells, approx, total, inconsistent } = lastAnalysis;
    const lay = ensureLayer(); lay.innerHTML = '';
    const unknown = cells.filter((c) => !c.revealed);

    const mustFlip = unknown.filter((c) => c.pGE2 >= 0.999); // sûr et vaut 2 ou 3 → à retourner pour gagner
    const certainSafe = unknown.filter((c) => c.pV === 0 && c.pGE2 < 0.999); // sûr (souvent un 1)
    const certainVolt = unknown.filter((c) => c.pV >= 0.999);
    const risky = unknown.filter((c) => c.pV > 0 && c.pV < 0.999);

    // Combien de 2/3 restent à trouver
    let valuablesLeft = 0;
    for (let r = 0; r < 5; r++) { let p = state.rows[r].p, unk = 0; for (let c = 0; c < 5; c++) { if (rev[r][c] != null) { if (rev[r][c] > 0) p -= rev[r][c]; } else unk++; } valuablesLeft += Math.max(0, p - (unk - state.rows[r].v)); }

    for (const c of mustFlip) if (btns[`${c.r},${c.c}`]) badge(lay, btns[`${c.r},${c.c}`], { border: '#ffd400', glow: '#ffd400', text: 'RETOURNE', bg: '#b8860b' });
    for (const c of certainSafe) if (btns[`${c.r},${c.c}`]) badge(lay, btns[`${c.r},${c.c}`], { border: '#1f9d55', text: '✓', bg: '#1f9d55' });
    for (const c of certainVolt) if (btns[`${c.r},${c.c}`]) badge(lay, btns[`${c.r},${c.c}`], { border: '#c0392b', text: '✗', bg: '#c0392b' });
    for (const c of risky) if (btns[`${c.r},${c.c}`]) badge(lay, btns[`${c.r},${c.c}`], { border: colorFor(c.pV), text: pct(c.pV), bg: colorFor(c.pV) });

    // Meilleur conseil
    let advice;
    if (inconsistent) advice = `<span style="color:#f88">Indices incohérents avec le plateau : recharge la page.</span>`;
    else if (state.over) advice = `Niveau terminé.`;
    else if (mustFlip.length) advice = `<b style="color:#ffd400">Retourne les cases « RETOURNE »</b> : sûres et valant 2 ou 3.`;
    else if (certainSafe.length) advice = `Retourne une case <b style="color:#1f9d55">✓</b> (sûre) pour révéler de l'info et débloquer des certitudes.`;
    else if (risky.length) { const best = risky.slice().sort((a, b) => a.pV - b.pV || b.pGE2 - a.pGE2)[0]; advice = `Aucune case sûre : le moins risqué est ligne ${best.r + 1}, colonne ${best.c + 1} (${pct(best.pV)} Voltorbe).`; }
    else advice = `Toutes les cases utiles sont retournées — niveau gagné, tu peux t'arrêter.`;

    const p = panel();
    p.innerHTML = `
      <div style="color:#aaa;margin-bottom:8px"><span style="color:#ffd400">RETOURNE</span> = sûr et vaut 2/3 · <span style="color:#1f9d55">✓</span> sûr · <span style="color:#c0392b">✗</span> Voltorbe · % = risque</div>
      <div style="margin-bottom:6px">2 ou 3 restants : <b>${Math.max(0, Math.round(valuablesLeft))}</b></div>
      <div>${advice}</div>
      ${approx ? `<div style="color:#e67e22;margin-top:6px;font-size:11px">Trop de possibilités : risques approximatifs (pas de certitude croisée).</div>` : ''}
      <div style="color:#777;margin-top:8px;font-size:11px">Déduit des indices visibles et de tes cases retournées. Tu joues, je ne clique pas.</div>`;
  }

  // ───────── Boucle ─────────
  let busy = false;
  async function loop() {
    if (!location.pathname.startsWith('/jeux/voltorbe-flip')) { document.getElementById('hp-vf-layer')?.remove(); UI.removePanel('hp-vf-panel'); layer = null; return; }
    if (busy) return; busy = true;
    try { const state = await clues(); if (state) render(state); } catch (e) { /* on réessaiera */ } finally { busy = false; }
  }
  setInterval(loop, POLL_MS);
  addEventListener('scroll', () => loop(), { passive: true });
  addEventListener('resize', () => loop());
  loop();
})();
