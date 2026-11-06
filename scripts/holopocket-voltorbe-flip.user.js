// ==UserScript==
// @name         HoloPocket – Assistant Voltorbe Flip
// @namespace    kevin.holopocket
// @version      3.0
// @updateURL    https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-voltorbe-flip.user.js
// @downloadURL  https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-voltorbe-flip.user.js
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
  function colorFor(pV) { if (pV === 0) return '#22c55e'; if (pV >= 0.5) return '#ef4444'; if (pV >= 0.25) return '#fb923c'; return '#ca8a04'; }

  let layer = null;
  function ensureLayer() {
    if (layer && document.body.contains(layer)) return layer;
    layer = document.createElement('div');
    layer.id = 'hp-vf-layer';
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: 99998, pointerEvents: 'none' });
    document.body.appendChild(layer);
    return layer;
  }
  // ───────── Interface HoloPocket+ (kit commun, identique dans tous les scripts) ─────────
  // Un dock en bas à droite (actions + interrupteurs), une colonne de panneaux à droite,
  // et des notifications dans cette colonne. Styles calqués sur ceux du site (variables CSS du site).
  const UI = (function () {
    const V = 1;
    if (window.__hpui && window.__hpui.v >= V) return window.__hpui;

    const ICONS = {
      coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
      target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
      dice: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/>',
      zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
      repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
      swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
      refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
      x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
      up: '<path d="m18 15-6-6-6 6"/>',
      down: '<path d="m6 9 6 6 6-6"/>',
      loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
    };
    const icon = (name) => ICONS[name]
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
      : '';
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const CSS = `
#hp-dock,#hp-panels{font-family:var(--font-sans,"Geist Variable",ui-sans-serif,system-ui,sans-serif);color:var(--color-ink,#f4f4f1);-webkit-font-smoothing:antialiased}
#hp-dock{position:fixed;right:22px;bottom:16px;z-index:2147483000;width:min(320px,calc(100vw - 38px));display:flex;flex-direction:column;align-items:stretch;gap:10px;pointer-events:none}
#hp-dock>*{pointer-events:auto}
#hp-panels{position:fixed;right:16px;top:84px;bottom:16px;z-index:2147482999;width:min(326px,calc(100vw - 32px));display:flex;flex-direction:column;gap:12px;overflow-y:auto;overscroll-behavior:contain;pointer-events:none;padding:0 6px 6px 0;scrollbar-width:none}
#hp-panels::-webkit-scrollbar{display:none}
#hp-panels>*{pointer-events:auto;flex:none}
.hp-btn{display:flex;width:100%;align-items:center;gap:10px;min-height:46px;padding:8px 14px;border-radius:12px;border:2px solid #111;background:var(--color-brand,#ffd60a);color:#111;font:600 14px/1.2 var(--font-sans,system-ui,sans-serif);box-shadow:3px 3px 0 var(--color-shade,#000);cursor:pointer;text-align:left;transition:transform .08s ease,box-shadow .08s ease}
.hp-btn:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--color-shade,#000)}
.hp-btn:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--color-shade,#000)}
.hp-btn[disabled]{opacity:.7;cursor:progress;transform:none;box-shadow:3px 3px 0 var(--color-shade,#000)}
.hp-btn--secondary,.hp-btn--toggle{background:var(--color-panel,#18181b);color:var(--color-ink,#f4f4f1);border-color:var(--color-ink,#f4f4f1)}
.hp-btn__icon{display:grid;place-items:center;flex:none}
.hp-btn__icon svg{width:18px;height:18px}
.hp-btn__text{display:flex;flex-direction:column;min-width:0;flex:1}
.hp-btn__label,.hp-btn__sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-btn__sub{font:500 11.5px/1.35 var(--font-mono,ui-monospace,monospace);opacity:.72}
.hp-dot{width:10px;height:10px;border-radius:50%;flex:none;margin-left:2px;background:var(--color-muted,#9d9da3)}
.hp-btn--toggle.is-on .hp-dot{background:#22c55e;box-shadow:0 0 8px #22c55e}
.hp-panel{background:var(--color-panel,#18181b);color:var(--color-ink,#f4f4f1);border:2px solid var(--color-ink,#f4f4f1);border-radius:16px;box-shadow:4px 4px 0 var(--color-shade,#000);font:14px/1.45 var(--font-sans,system-ui,sans-serif)}
.hp-panel__head{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 14px;border-bottom:2px solid var(--color-line,#313136)}
.hp-panel.is-collapsed .hp-panel__head{border-bottom:0}
.hp-panel.is-collapsed .hp-panel__body{display:none}
.hp-panel__title{flex:1;min-width:0;font:700 16px/1.25 var(--font-display,var(--font-sans,system-ui,sans-serif));letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-panel__actions{display:flex;gap:6px}
.hp-panel__body{padding:12px 14px 14px}
.hp-icon-btn{display:grid;place-items:center;width:30px;height:30px;flex:none;padding:0;border-radius:9px;border:2px solid var(--color-line,#313136);background:var(--color-panel-2,#242428);color:var(--color-ink,#f4f4f1);cursor:pointer}
.hp-icon-btn:hover{border-color:var(--color-ink,#f4f4f1)}
.hp-icon-btn svg{width:16px;height:16px}
.hp-mini{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 12px;border-radius:10px;border:2px solid #111;background:var(--color-brand,#ffd60a);color:#111;font:600 13px/1.2 var(--font-sans,system-ui,sans-serif);box-shadow:2px 2px 0 var(--color-shade,#000);cursor:pointer}
.hp-mini:hover{transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--color-shade,#000)}
.hp-mini--ghost{background:var(--color-panel-2,#242428);color:var(--color-ink,#f4f4f1);border-color:var(--color-line,#313136);box-shadow:none}
.hp-mini--ghost:hover{border-color:var(--color-ink,#f4f4f1);box-shadow:none}
.hp-btn:focus-visible,.hp-icon-btn:focus-visible,.hp-mini:focus-visible{outline:2px solid var(--color-brand,#ffd60a);outline-offset:3px}
.hp-toast{background:var(--color-panel,#18181b);color:var(--color-ink,#f4f4f1);border:2px solid var(--color-ink,#f4f4f1);border-left-width:6px;border-radius:14px;box-shadow:4px 4px 0 var(--color-shade,#000);padding:10px 12px;font:13px/1.45 var(--font-sans,system-ui,sans-serif);cursor:pointer;animation:hp-in .18s ease-out}
.hp-toast--success{border-left-color:#22c55e}
.hp-toast--error{border-left-color:#ef4444}
.hp-toast--info{border-left-color:var(--color-brand,#ffd60a)}
.hp-muted{color:var(--color-muted,#9d9da3)}
.hp-spin{animation:hp-spin 1s linear infinite}
@keyframes hp-spin{to{transform:rotate(360deg)}}
@keyframes hp-in{from{opacity:0;transform:translateY(-4px)}}
@media (max-width:640px){#hp-dock{right:12px;bottom:12px;gap:8px;width:max-content;max-width:calc(100vw - 24px)}.hp-btn{min-height:40px;padding:6px 12px;font-size:13px}.hp-btn__sub{display:none}#hp-panels{right:6px;width:calc(100vw - 12px)}}
@media (prefers-reduced-motion:reduce){.hp-btn,.hp-mini,.hp-toast{transition:none;animation:none}}
`;

    function base() {
      if (!document.getElementById('hp-ui-style')) {
        const s = document.createElement('style');
        s.id = 'hp-ui-style';
        s.textContent = CSS;
        document.head.appendChild(s);
      }
      let dock = document.getElementById('hp-dock');
      if (!dock) { dock = document.createElement('div'); dock.id = 'hp-dock'; document.body.appendChild(dock); }
      let col = document.getElementById('hp-panels');
      if (!col) { col = document.createElement('div'); col.id = 'hp-panels'; document.body.appendChild(col); }
      return { dock, col };
    }

    // La colonne de panneaux se place sous l'en-tête du site (et sous la bannière d'événement) et au-dessus du dock
    function layout() {
      const dock = document.getElementById('hp-dock'), col = document.getElementById('hp-panels');
      if (!dock || !col) return;
      col.style.bottom = (dock.children.length ? dock.offsetHeight + 28 : 16) + 'px';
      let top = 64;
      const hdr = document.querySelector('header');
      if (hdr) top = Math.max(0, hdr.getBoundingClientRect().bottom);
      for (const st of document.querySelectorAll('[role=status]')) {
        if (st.closest('#hp-panels')) continue;
        const r = st.getBoundingClientRect();
        if (r.height && r.top <= top + 8 && r.bottom > top) top = r.bottom;
      }
      col.style.top = Math.round(top + 12) + 'px';
    }

    // Bouton du dock. kind : 'primary' (jaune), 'secondary', 'toggle' (avec voyant). order : position (petit = haut).
    function button(id, o) {
      const { dock } = base();
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('button');
        el.id = id;
        el.type = 'button';
        el.addEventListener('click', () => el._onClick && el._onClick());
        dock.appendChild(el);
      }
      el._onClick = o.onClick;
      const kind = o.kind || 'primary';
      const sig = JSON.stringify([kind, o.label, o.sub, o.icon, !!o.on, !!o.busy, !!o.disabled, o.title]);
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.className = `hp-btn hp-btn--${kind}${o.on ? ' is-on' : ''}`;
        el.disabled = !!o.disabled;
        el.title = o.title || '';
        if (kind === 'toggle') el.setAttribute('aria-pressed', String(!!o.on)); else el.removeAttribute('aria-pressed');
        const ic = o.busy ? `<span class="hp-btn__icon hp-spin">${icon('loader')}</span>` : (o.icon ? `<span class="hp-btn__icon">${icon(o.icon)}</span>` : '');
        el.innerHTML = ic
          + `<span class="hp-btn__text"><span class="hp-btn__label">${esc(o.label)}</span>${o.sub ? `<span class="hp-btn__sub">${esc(o.sub)}</span>` : ''}</span>`
          + (kind === 'toggle' ? '<span class="hp-dot"></span>' : '');
      }
      el.style.order = o.order ?? 50;
      layout();
      return el;
    }
    function removeButton(id) { document.getElementById(id)?.remove(); layout(); }

    // Panneaux : repliables (état mémorisé) ou fermables (closable: true)
    const COLLAPSE_KEY = 'hp-ui-collapsed';
    const collapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { return new Set(); } };
    const saveCollapsed = (s) => { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])); } catch {} };
    function iconBtn(name, title, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hp-icon-btn';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = icon(name);
      b.onclick = (e) => { e.stopPropagation(); onClick(); };
      return b;
    }
    function panel(id, o = {}) {
      const { col } = base();
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('section');
        el.id = id;
        el.className = 'hp-panel';
        el.setAttribute('aria-label', o.title || '');
        el.innerHTML = '<div class="hp-panel__head"><div class="hp-panel__title"></div><div class="hp-panel__actions"></div></div><div class="hp-panel__body"></div>';
        if (!o.closable && collapsed().has(id)) el.classList.add('is-collapsed');
        col.appendChild(el);
      }
      el.style.order = o.order ?? 50;
      el._actions = o.actions || [];
      el._onClose = o.onClose;
      const sig = JSON.stringify([o.title, el._actions.map((a) => [a.icon, a.title]), !!o.closable]);
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        el.querySelector('.hp-panel__title').textContent = o.title || '';
        const act = el.querySelector('.hp-panel__actions');
        act.innerHTML = '';
        el._actions.forEach((a, i) => act.appendChild(iconBtn(a.icon, a.title, () => el._actions[i] && el._actions[i].onClick())));
        if (o.closable) {
          act.appendChild(iconBtn('x', 'Fermer', () => { el.remove(); layout(); el._onClose && el._onClose(); }));
        } else {
          const tg = iconBtn(el.classList.contains('is-collapsed') ? 'down' : 'up', 'Replier / déplier', () => {
            const s = collapsed();
            const now = el.classList.toggle('is-collapsed');
            if (now) s.add(id); else s.delete(id);
            saveCollapsed(s);
            tg.innerHTML = icon(now ? 'down' : 'up');
          });
          act.appendChild(tg);
        }
      }
      layout();
      return el.querySelector('.hp-panel__body');
    }
    function removePanel(id) { document.getElementById(id)?.remove(); layout(); }
    const hasPanel = (id) => !!document.getElementById(id);

    // Notification dans la colonne de droite. kind : 'success' | 'error' | 'info'. ms : 0 = jusqu'au clic.
    function toast(html, o = {}) {
      const { col } = base();
      const t = document.createElement('div');
      t.className = `hp-toast hp-toast--${o.kind || 'info'}`;
      t.setAttribute('role', 'status');
      t.style.order = -1;
      t.innerHTML = html;
      t.title = 'Cliquer pour fermer';
      t.onclick = () => { t.remove(); layout(); };
      col.prepend(t);
      [...col.querySelectorAll('.hp-toast')].slice(3).forEach((x) => x.remove());
      const ms = o.ms ?? 8000;
      if (ms) setTimeout(() => { t.remove(); layout(); }, ms);
      layout();
      return t;
    }

    addEventListener('resize', layout);
    addEventListener('scroll', layout, { passive: true });
    setInterval(layout, 600);
    window.__hpui = { v: V, button, removeButton, panel, removePanel, hasPanel, toast, icon, esc };
    return window.__hpui;
  })();


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
    Object.assign(tag.style, { margin: '3px', padding: '1px 5px', borderRadius: '7px', background: bg, color: '#fff', font: '700 11px var(--font-sans, system-ui, sans-serif)' });
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

    for (const c of mustFlip) if (btns[`${c.r},${c.c}`]) badge(lay, btns[`${c.r},${c.c}`], { border: 'var(--color-brand,#ffd60a)', glow: 'var(--color-brand,#ffd60a)', text: 'RETOURNE', bg: '#ca8a04' });
    for (const c of certainSafe) if (btns[`${c.r},${c.c}`]) badge(lay, btns[`${c.r},${c.c}`], { border: '#22c55e', text: '✓', bg: '#22c55e' });
    for (const c of certainVolt) if (btns[`${c.r},${c.c}`]) badge(lay, btns[`${c.r},${c.c}`], { border: '#ef4444', text: '✗', bg: '#ef4444' });
    for (const c of risky) if (btns[`${c.r},${c.c}`]) badge(lay, btns[`${c.r},${c.c}`], { border: colorFor(c.pV), text: pct(c.pV), bg: colorFor(c.pV) });

    // Meilleur conseil
    let advice;
    if (inconsistent) advice = `<span style="color:#f87171">Indices incohérents avec le plateau : recharge la page.</span>`;
    else if (state.over) advice = `Niveau terminé.`;
    else if (mustFlip.length) advice = `<b style="color:var(--color-brand,#ffd60a)">Retourne les cases « RETOURNE »</b> : sûres et valant 2 ou 3.`;
    else if (certainSafe.length) advice = `Retourne une case <b style="color:#22c55e">✓</b> (sûre) pour révéler de l'info et débloquer des certitudes.`;
    else if (risky.length) { const best = risky.slice().sort((a, b) => a.pV - b.pV || b.pGE2 - a.pGE2)[0]; advice = `Aucune case sûre : le moins risqué est ligne ${best.r + 1}, colonne ${best.c + 1} (${pct(best.pV)} Voltorbe).`; }
    else advice = `Toutes les cases utiles sont retournées — niveau gagné, tu peux t'arrêter.`;

    const p = panel();
    p.innerHTML = `
      <div style="color:var(--color-muted,#9d9da3);margin-bottom:8px"><span style="color:var(--color-brand,#ffd60a)">RETOURNE</span> = sûr et vaut 2/3 · <span style="color:#22c55e">✓</span> sûr · <span style="color:#ef4444">✗</span> Voltorbe · % = risque</div>
      <div style="margin-bottom:6px">2 ou 3 restants : <b>${Math.max(0, Math.round(valuablesLeft))}</b></div>
      <div>${advice}</div>
      ${approx ? `<div style="color:#fb923c;margin-top:6px;font-size:11px">Trop de possibilités : risques approximatifs (pas de certitude croisée).</div>` : ''}
      <div style="color:var(--color-muted,#9d9da3);margin-top:8px;font-size:11px">Déduit des indices visibles et de tes cases retournées. Tu joues, je ne clique pas.</div>`;
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
