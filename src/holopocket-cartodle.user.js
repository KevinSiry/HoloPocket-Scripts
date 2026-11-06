// ==UserScript==
// @name         HoloPocket – Assistant Cartodle
// @namespace    kevin.holopocket
// @version      2.0
// @description  Aide au Cartodle par déduction : à partir de tes essais et de leurs indices (type, stade, rareté, extension, année), filtre les cartes possibles et propose le meilleur prochain essai. N'utilise que les indices renvoyés, ne lit jamais la carte mystère.
// @match        https://holopocket.fr/jeux/cartodle*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const POLL_MS = 1200;
  const RARE_RANK = 3;           // « une rare ou mieux » = rang ≥ 3
  const DB_TTL = 24 * 3600 * 1000;
  const DB_KEY = 'hp-cartodle-db-v2'; // v2 : ajoute la date de sortie des extensions

  async function api(path) {
    const r = await fetch(`/api${path}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }

  // ───────── Base des cartes candidates (rare+ Pokémon, toutes extensions), en cache ─────────
  async function buildDB(onProgress) {
    try {
      const cached = JSON.parse(localStorage.getItem(DB_KEY) || 'null');
      if (cached && Date.now() - cached.at < DB_TTL) return cached.cards;
    } catch {}
    const sets = await api('/sets');
    const cards = [];
    let done = 0;
    const queue = sets.slice();
    async function worker() {
      while (queue.length) {
        const s = queue.shift();
        try {
          const detail = await api(`/sets/${encodeURIComponent(s.id)}`);
          const year = s.releaseDate ? +String(s.releaseDate).slice(0, 4) : null;
          for (const c of detail.cards || []) {
            if (c.category === 'Pokemon' && c.rank >= RARE_RANK) {
              cards.push({ id: c.id, name: c.name, rank: c.rank, type: c.type, stage: c.stage, setId: s.id, serieId: s.serieId, year, date: s.releaseDate || '' });
            }
          }
        } catch {}
        done++; onProgress && onProgress(done, sets.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    try { localStorage.setItem(DB_KEY, JSON.stringify({ at: Date.now(), cards })); } catch {}
    return cards;
  }

  // Index des extensions : nom, série et date de sortie complète
  let setsIndex = null;
  async function ensureSets() {
    if (!setsIndex) { setsIndex = {}; try { for (const s of await api('/sets')) setsIndex[s.id] = { name: s.name, serieId: s.serieId, date: s.releaseDate || '' }; } catch {} }
    return setsIndex;
  }
  // Attributs de la carte jouée (type, stade, rang, extension, date) via la recherche du jeu
  const guessedCache = {};
  async function guessedAttrs(card) {
    if (guessedCache[card.id]) return guessedCache[card.id];
    await ensureSets();
    let found = null;
    try { const res = await api(`/games/cartodle/search?q=${encodeURIComponent(card.name)}`); found = res.find((x) => x.id === card.id) || null; } catch {}
    const setId = found ? found.setId : card.setId;
    const si = setsIndex[setId] || {};
    const a = { type: found ? found.type : null, stage: found ? found.stage : null, rank: found ? found.rank : card.rank, setId, serieId: si.serieId || null, date: si.date || '', name: found ? found.name : card.name };
    guessedCache[card.id] = a; return a;
  }

  // ───────── Filtrage par les indices ─────────
  // Applique les contraintes d'un essai à un candidat. g = attributs joués, fb = indices renvoyés.
  // Indices : hint 'match' = identique, 'miss' = différent, 'close' = presque (fuzzy → non filtré pour ne pas
  // éliminer la bonne carte). Les flèches (up/down) donnent le sens, y compris sur 'miss'/'close'.
  // L'extension se compare par DATE de sortie complète (pas l'année : deux cartes de la même année sont ordonnées).
  function matches(cand, g, fb) {
    if (fb.pokemon && fb.pokemon.hint === 'match' && cand.name !== g.name) return false;
    if (fb.types && g.type != null) {
      if (fb.types.hint === 'match' && cand.type !== g.type) return false;
      if (fb.types.hint === 'miss' && cand.type === g.type) return false;
    }
    if (fb.stage && g.stage != null) {
      if (fb.stage.hint === 'match' && cand.stage !== g.stage) return false;
      if (fb.stage.hint === 'miss' && cand.stage === g.stage) return false;
    }
    if (fb.rarity && g.rank != null) {
      if (fb.rarity.hint === 'match') { if (cand.rank !== g.rank) return false; }
      else if (fb.rarity.arrow === 'up') { if (!(cand.rank > g.rank)) return false; }
      else if (fb.rarity.arrow === 'down') { if (!(cand.rank < g.rank)) return false; }
    }
    if (fb.set && g.date) {
      if (fb.set.hint === 'match') { if (cand.setId !== g.setId) return false; }
      else if (fb.set.arrow === 'up') { if (cand.date && !(cand.date > g.date)) return false; }
      else if (fb.set.arrow === 'down') { if (cand.date && !(cand.date < g.date)) return false; }
    }
    return true;
  }

  async function filterCandidates(cards, guesses) {
    let C = cards;
    for (const fb of guesses) {
      const g = await guessedAttrs(fb.card);
      C = C.filter((cand) => matches(cand, g, fb));
    }
    return C;
  }

  // Signature de feedback simulée d'un candidat-mystère M face à un essai g (dimensions exploitables)
  function simSig(M, g) {
    const t = M.type === g.type ? 'E' : 'x';
    const s = M.stage === g.stage ? 'E' : 'x';
    const r = M.rank === g.rank ? 'E' : M.rank > g.rank ? '>' : '<';
    const d = M.setId === g.setId ? 'E' : (!M.date || !g.date) ? '?' : M.date > g.date ? '>' : M.date < g.date ? '<' : '=';
    const sp = M.name === g.name ? 'E' : 'x';
    return t + s + r + d + sp;
  }

  // Meilleur prochain essai : minimise le plus gros groupe restant
  function recommend(C) {
    if (C.length <= 2) return C[0] || null;
    const pool = C.length > 160 ? C.filter((_, i) => i % Math.ceil(C.length / 160) === 0) : C;
    const sample = C.length > 700 ? C.filter((_, i) => i % Math.ceil(C.length / 700) === 0) : C;
    let best = null, bestWorst = Infinity;
    for (const g of pool) {
      const buckets = new Map();
      for (const M of sample) { const k = simSig(M, g); buckets.set(k, (buckets.get(k) || 0) + 1); }
      const worst = Math.max(...buckets.values());
      if (worst < bestWorst) { bestWorst = worst; best = g; }
    }
    return best;
  }

  // ───────── Interface ─────────
/*__HPUI_KIT__*/

  // Panneau dans la colonne commune du kit (repliable)
  function panel() { return UI.panel('hp-cartodle-panel', { title: 'Assistant Cartodle', order: 30 }); }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const FR = { Grass: 'Plante', Fire: 'Feu', Water: 'Eau', Lightning: 'Électrique', Electric: 'Électrique', Psychic: 'Psy', Fighting: 'Combat', Darkness: 'Obscurité', Metal: 'Métal', Dragon: 'Dragon', Fairy: 'Fée', Colorless: 'Incolore', Normal: 'Normal' };
  const stageFR = { Basic: 'De base', Stage1: 'Niveau 1', Stage2: 'Niveau 2' };

  // ───────── Remplissage + surlignage de la carte conseillée (pas de clic : tu valides) ─────────
  let lastRec = null;
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function findInput() {
    return document.querySelector('input[type=search]') || document.querySelector('input[placeholder*="ropose"]');
  }
  function clearHighlight() {
    document.querySelectorAll('.hp-cd-hl').forEach((e) => { e.classList.remove('hp-cd-hl'); e.style.outline = ''; e.style.outlineOffset = ''; });
  }
  async function fillGuess(rec) {
    if (!rec) return;
    await ensureSets();
    const input = findInput();
    if (!input) return;
    const localId = rec.id.slice(rec.setId.length + 1);
    const setName = (setsIndex[rec.setId] && setsIndex[rec.setId].name) || '';
    // Repérage par n° + extension (identifie la version de façon unique, sans dépendre du nom)
    const tryFind = () => [...document.querySelectorAll('button')].find((b) => {
      const t = b.textContent.replace(/\s+/g, ' ');
      return t.includes('n° ' + localId) && (setName ? t.includes(setName) : true);
    });
    input.focus();
    // Requête nom+année d'abord : elle réduit la liste aux bonnes versions (sinon la carte est noyée/coupée)
    const queries = [`${rec.name} ${rec.year || ''}`.trim(), rec.name, `${rec.name} ${(setName.split(' ')[0] || '')}`.trim()];
    for (const q of queries) {
      setNativeValue(input, q);
      await new Promise((r) => setTimeout(r, 950));
      const btn = tryFind();
      if (btn) {
        clearHighlight();
        btn.classList.add('hp-cd-hl');
        btn.style.outline = '3px solid #ffd400';
        btn.style.outlineOffset = '2px';
        btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const note = document.getElementById('hp-cd-fillnote');
        if (note) note.textContent = `Carte surlignée en jaune — clique dessus pour valider l'essai.`;
        return;
      }
    }
    const note = document.getElementById('hp-cd-fillnote');
    if (note) note.innerHTML = `Pas trouvée automatiquement : cherche « <b>${esc(rec.name)}</b> », version <b>${esc(setName)}</b> n° ${esc(localId)}.`;
  }

  let db = null, building = false, progress = '';
  async function loop() {
    if (!location.pathname.startsWith('/jeux/cartodle')) { UI.removePanel('hp-cartodle-panel'); return; }
    const p = panel();
    let game;
    try { game = await api('/games/cartodle'); } catch { return; }

    if (!db && !building) { building = true; p.innerHTML = '⏳ Construction de la base des cartes (une fois par jour)…'; try { db = await buildDB((d, t) => { progress = `${d}/${t}`; const el = document.getElementById('hp-cd-prog'); if (el) el.textContent = progress; }); } finally { building = false; } }
    if (building) { p.innerHTML = `⏳ Base des cartes… <span id="hp-cd-prog">${progress}</span>`; return; }
    if (!db) { p.innerHTML = 'Base indisponible — recharge la page.'; return; }

    if (game.status !== 'playing') {
      p.innerHTML = `${game.status === 'won' ? `✅ Trouvée en ${game.guesses.length} essai(s).` : '❌ Partie du jour terminée.'}`;
      return;
    }

    let C;
    try { C = await filterCandidates(db, game.guesses); } catch (e) { p.innerHTML = `Erreur : ${esc(e.message)}`; return; }
    const guessedIds = new Set(game.guesses.map((x) => x.card.id));
    C = C.filter((c) => !guessedIds.has(c.id)); // ne jamais reproposer une carte déjà jouée
    const rec = recommend(C);
    lastRec = rec;
    const left = (game.maxGuesses || 20) - game.guesses.length;

    // Aperçu de quelques candidats
    const preview = C.slice(0, 6).map((c) => `${esc(c.name)} <small style="color:#888">(${esc(c.setId)}${c.year ? ' ' + c.year : ''})</small>`).join('<br>');

    p.innerHTML = `
      ${C.length === 0
        ? `<div style="color:#f88">Aucune carte compatible. Un indice a dû être mal interprété (séries/variantes).</div>`
        : rec
          ? `<div style="margin-bottom:4px"><b>Essai conseillé :</b></div>
             <div style="padding:6px 8px;border-radius:8px;background:#333;border:1px solid #555">${esc(rec.name)} <small style="color:#9ad">${esc(rec.type ? (FR[rec.type] || rec.type) : '')}${rec.stage ? ' · ' + (stageFR[rec.stage] || rec.stage) : ''} · ${esc(rec.setId)}${rec.year ? ' ' + rec.year : ''}</small></div>
             <button id="hp-cd-fill" type="button" class="hp-mini" style="margin-top:10px;width:100%">Remplir et surligner cette carte</button>
             <div id="hp-cd-fillnote" style="color:#aaa;margin-top:6px;font-size:11px">Clique le bouton : je remplis la recherche et je surligne la bonne version. À toi de cliquer dessus pour valider.</div>`
          : ''}
      <div style="color:#aaa;margin-top:10px">Cartes encore possibles : <b>${C.length}</b> · essais restants : <b>${left}</b></div>
      ${C.length > 1 && C.length <= 12 ? `<div style="margin-top:8px;color:#ccc;font-size:12px"><b>Possibles :</b><br>${C.map((c) => `${esc(c.name)} <small style="color:#888">(${esc(c.setId)})</small>`).join('<br>')}</div>` : C.length ? `<div style="margin-top:8px;color:#888;font-size:12px">${preview}${C.length > 6 ? '<br>…' : ''}</div>` : ''}
      <div style="color:#777;margin-top:10px;font-size:11px">Déduit de tes essais seulement (type, stade, rareté, extension, année). PV et n° Pokédex non filtrés faute de données. Tu choisis et valides.</div>`;
    const fillBtn = document.getElementById('hp-cd-fill');
    if (fillBtn) fillBtn.onclick = () => fillGuess(lastRec);
  }

  setInterval(loop, POLL_MS);
  loop();
})();
