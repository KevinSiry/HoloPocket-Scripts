// ==UserScript==
// @name         HoloPocket – Assistant Coffre
// @namespace    kevin.holopocket
// @version      2.0
// @description  Aide au Coffre (Mastermind) : à partir de tes essais et du retour « bien placées / mal placées », déduit le meilleur prochain essai. N'utilise que ce que le jeu te montre, ne lit jamais le code caché, ne joue pas à ta place.
// @match        https://holopocket.fr/jeux/coffre*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const POLL_MS = 1200;
  const ICON = { plante: '🌿', feu: '🔥', eau: '💧', electrique: '⚡', psy: '🔮', combat: '🥊' };
  const label = (e) => `${ICON[e] || ''} ${e}`;

  // Retour Mastermind : bien placées (exact) et présentes ailleurs (misplaced)
  function feedback(guess, code) {
    let exact = 0;
    const gRest = {}, cRest = {};
    for (let i = 0; i < guess.length; i++) {
      if (guess[i] === code[i]) exact++;
      else { gRest[guess[i]] = (gRest[guess[i]] || 0) + 1; cRest[code[i]] = (cRest[code[i]] || 0) + 1; }
    }
    let misplaced = 0;
    for (const s in gRest) misplaced += Math.min(gRest[s], cRest[s] || 0);
    return exact * 100 + misplaced;
  }

  function allCodes(energies, slots) {
    let codes = [[]];
    for (let i = 0; i < slots; i++) {
      const next = [];
      for (const c of codes) for (const e of energies) next.push([...c, e]);
      codes = next;
    }
    return codes;
  }

  // Essais du joueur → tableau {guess:[...], exact, misplaced}
  function readGuesses(g) {
    return (g.guesses || []).map((s) => ({
      guess: s.guess || s.code || s.values || s.energies || [],
      exact: s.exact ?? s.correct ?? s.placed ?? 0,
      misplaced: s.misplaced ?? s.present ?? s.wrongPlace ?? 0,
    })).filter((s) => s.guess.length);
  }

  // Candidats encore compatibles avec tous les retours
  function consistent(code, guesses) {
    for (const h of guesses) {
      if (feedback(h.guess, code) !== h.exact * 100 + h.misplaced) return false;
    }
    return true;
  }

  // Meilleur prochain essai : minimise le pire des cas (minimax de Knuth),
  // en préférant un essai encore candidat (pour pouvoir gagner directement).
  function recommend(energies, slots, guesses) {
    if (!guesses.length) {
      // Ouverture classique : deux paires (ex. plante plante feu feu)
      return { guess: [energies[0], energies[0], energies[1], energies[1]], remaining: Math.pow(energies.length, slots) };
    }
    const all = allCodes(energies, slots);
    const cands = all.filter((c) => consistent(c, guesses));
    if (cands.length <= 1) return { guess: cands[0] || null, remaining: cands.length, solved: cands.length === 1 };

    // Pool d'essais : les candidats (borné pour rester rapide)
    const pool = cands.length > 350 ? cands.filter((_, i) => i % Math.ceil(cands.length / 350) === 0) : cands;
    let best = null, bestScore = Infinity, bestIsCand = false;
    for (const guess of pool) {
      const buckets = new Map();
      for (const code of cands) {
        const f = feedback(guess, code);
        buckets.set(f, (buckets.get(f) || 0) + 1);
      }
      const worst = Math.max(...buckets.values());
      const isCand = true; // pool ⊆ cands
      if (worst < bestScore || (worst === bestScore && isCand && !bestIsCand)) {
        best = guess; bestScore = worst; bestIsCand = isCand;
      }
    }
    return { guess: best, remaining: cands.length, worstCase: bestScore };
  }

  // ───────── Interface ─────────
/*__HPUI_KIT__*/

  // Panneau dans la colonne commune du kit (repliable)
  function panel() { return UI.panel('hp-vault-panel', { title: 'Assistant Coffre', order: 30 }); }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  async function loop() {
    if (!location.pathname.startsWith('/jeux/coffre')) { UI.removePanel('hp-vault-panel'); return; }
    let g;
    try { g = await (await fetch('/api/games/vault', { credentials: 'same-origin' })).json(); }
    catch { return; }
    if (!g || !g.energies) return;

    const p = panel();
    if (g.over) {
      p.innerHTML = `${g.won ? '✅ Résolu, récompense gagnée.' : '❌ Partie du jour terminée.'}<div style="color:#777;margin-top:8px;font-size:11px">Reviens demain.</div>`;
      return;
    }
    const guesses = readGuesses(g);
    const triesLeft = (g.maxTries || 8) - guesses.length;
    let rec;
    try { rec = recommend(g.energies, g.slots || 4, guesses); }
    catch (e) { p.innerHTML = `Erreur de calcul : ${esc(e.message)}`; return; }

    const chips = (arr) => arr.map((e) => `<span style="display:inline-block;margin:2px;padding:3px 7px;border-radius:8px;background:#333;border:1px solid #555">${esc(label(e))}</span>`).join('');
    p.innerHTML = `
      ${rec.solved || rec.remaining === 1
        ? `<div style="color:#1f9d55;margin-bottom:6px"><b>Le code est :</b></div><div>${chips(rec.guess)}</div>`
        : rec.guess
          ? `<div style="margin-bottom:6px"><b>Essai conseillé :</b></div><div>${chips(rec.guess)}</div>`
          : `<div style="color:#f88">Aucun code compatible — un retour a dû être mal saisi.</div>`}
      <div style="color:#aaa;margin-top:10px">
        Codes encore possibles : <b>${rec.remaining}</b><br>
        Essais restants : <b>${triesLeft}</b>${rec.worstCase ? ` · au pire ${rec.worstCase} après celui-ci` : ''}
      </div>
      <div style="color:#777;margin-top:10px;font-size:11px">Déduit de tes essais seulement. À toi de saisir le code et de valider.</div>`;
  }

  setInterval(loop, POLL_MS);
  loop();
})();
