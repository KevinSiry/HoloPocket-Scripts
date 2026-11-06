// ==UserScript==
// @name         HoloPocket – Assistant Les Voisins
// @namespace    kevin.holopocket
// @description  Aide aux Voisins : calcule une disposition 3×3 où chaque carte partage un type, sa génération ou sa lignée avec ses voisines, à partir des attributs publics des cartes. Ne joue pas à ta place.
// @version      2.0
// @match        https://holopocket.fr/jeux/voisins*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const POLL_MS = 1500;
  const TRIES_CAP = 2000000;

  // Deux voisins compatibles : un type en commun, même génération, ou même lignée
  const share = (a, b) => a.types.some((t) => b.types.includes(t)) || a.gen === b.gen || a.family === b.family;
  function whyShare(a, b) {
    const t = a.types.find((x) => b.types.includes(x));
    if (t) return t;
    if (a.gen === b.gen) return 'Gén. ' + a.gen;
    if (a.family === b.family) return 'lignée';
    return '';
  }

  // Résout la grille size×size : place les cartes cellule par cellule, en vérifiant voisin gauche et haut
  function solve(cards, size) {
    const n = size * size;
    const grid = new Array(n).fill(-1);
    const used = new Array(cards.length).fill(false);
    let tries = 0, capped = false;
    const ok = (cell, ci) => {
      const col = cell % size, row = (cell / size) | 0;
      if (col > 0 && grid[cell - 1] !== -1 && !share(cards[grid[cell - 1]], cards[ci])) return false;
      if (row > 0 && grid[cell - size] !== -1 && !share(cards[grid[cell - size]], cards[ci])) return false;
      return true;
    };
    let sol = null;
    (function dfs(cell) {
      if (capped) return false;
      if (cell === n) { sol = grid.slice(); return true; }
      for (let ci = 0; ci < cards.length; ci++) {
        if (used[ci]) continue;
        if (++tries > TRIES_CAP) { capped = true; return false; }
        if (!ok(cell, ci)) continue;
        grid[cell] = ci; used[ci] = true;
        if (dfs(cell + 1)) return true;
        grid[cell] = -1; used[ci] = false;
      }
      return false;
    })(0);
    return sol ? sol.map((ci) => cards[ci]) : null;
  }

  // ───────── Interface ─────────
/*__HPUI_KIT__*/

  // Panneau dans la colonne commune du kit (repliable)
  function panel() { return UI.panel('hp-vz-panel', { title: 'Les Voisins — solution', order: 30 }); }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  let sig = '', solution = null, size = 3;
  async function loop() {
    if (!location.pathname.startsWith('/jeux/voisins')) { UI.removePanel('hp-vz-panel'); return; }
    let game;
    try { game = await (await fetch('/api/games/neighbors', { credentials: 'same-origin' })).json(); } catch { return; }
    if (!game.cards) return;
    const p = panel();
    size = game.size || 3;

    const newSig = game.cards.map((c) => c.dex).join(',');
    if (newSig !== sig) { solution = solve(game.cards, size); sig = newSig; }

    if (game.over) { p.innerHTML = `<div style="font-weight:700">🧩 Les Voisins</div>✅ Page rangée.`; return; }
    if (!solution) { p.innerHTML = `<div style="font-weight:700">🧩 Les Voisins</div><div style="color:#f88">Aucune disposition trouvée.</div>`; return; }

    // Grille : les cases sont numérotées 1..9 (de gauche à droite, de haut en bas)
    let cells = '';
    for (let r = 0; r < size; r++) {
      cells += '<tr>';
      for (let c = 0; c < size; c++) {
        const i = r * size + c;
        cells += `<td style="border:1px solid #444;padding:5px;text-align:center;vertical-align:top;width:${100 / size}%">
          <div style="font-size:9px;color:#888">case ${i + 1}</div>
          <div style="font-weight:600">${esc(solution[i].name)}</div>
          <div style="font-size:10px;color:#9ad">${esc(solution[i].types.join('/'))} · G${solution[i].gen}</div>
        </td>`;
      }
      cells += '</tr>';
    }

    p.innerHTML = `
      <div style="color:#aaa;margin-bottom:8px">Place chaque carte dans la case indiquée (1 en haut à gauche → 9 en bas à droite).</div>
      <table style="width:100%;border-collapse:collapse;table-layout:fixed">${cells}</table>
      <div style="color:#777;margin-top:10px;font-size:11px">Calculé à partir des types, générations et lignées des cartes. Tu places et valides toi-même.</div>`;
  }

  setInterval(loop, POLL_MS);
  loop();
})();
