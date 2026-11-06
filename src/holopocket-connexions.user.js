// ==UserScript==
// @name         HoloPocket – Assistant Connexions
// @namespace    kevin.holopocket
// @version      2.0
// @description  Aide aux Connexions : déduit les groupes possibles à partir des attributs publics des Pokémon (type, génération, 1re lettre, longueur du nom) et des critères du jeu. Ne lit jamais la solution cachée, ne joue pas à ta place.
// @match        https://holopocket.fr/jeux/connexions*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const POLL_MS = 1500;
  const genOf = (d) => d <= 151 ? 1 : d <= 251 ? 2 : d <= 386 ? 3 : d <= 493 ? 4 : d <= 649 ? 5 : d <= 721 ? 6 : d <= 809 ? 7 : d <= 905 ? 8 : 9;
  const clean = (n) => n.replace(/[-\s.]/g, '');

  const typeCache = {};
  async function typeOf(dex) {
    if (typeCache[dex] !== undefined) return typeCache[dex];
    let t = null;
    try { t = (await (await fetch(`/api/pokemon/${dex}`, { credentials: 'same-origin' })).json()).pokemon.type; } catch {}
    typeCache[dex] = t; return t;
  }

  async function buildInfo(tiles) {
    const info = [];
    for (const t of tiles) {
      const nm = clean(t.name);
      info.push({ name: t.name, dex: t.dex, type: await typeOf(t.dex), gen: genOf(t.dex), L1: nm[0] ? nm[0].toUpperCase() : '?', len: nm.length });
    }
    return info;
  }

  // ───────── Groupes candidats (valeur partagée par exactement 4) ─────────
  function candidateGroups(info) {
    const kinds = [
      { label: (v) => `type ${v}`, key: (x) => x.type },
      { label: (v) => `génération ${v}`, key: (x) => 'G' + x.gen },
      { label: (v) => `commencent par « ${v} »`, key: (x) => 'L' + x.L1 },
      { label: () => `noms courts (≤5 lettres)`, key: (x) => x.len <= 5 ? 'court' : null },
      { label: () => `noms longs (≥10 lettres)`, key: (x) => x.len >= 10 ? 'long' : null },
    ];
    const groups = [];
    for (const k of kinds) {
      const buckets = {};
      for (const x of info) { const v = k.key(x); if (v == null) continue; (buckets[v] = buckets[v] || []).push(x); }
      for (const [v, arr] of Object.entries(buckets)) {
        if (arr.length === 4) groups.push({ members: arr.map((x) => x.name), reason: k.label(v.replace(/^[GL]/, '')), kind: k.label });
      }
    }
    // dédoublonnage (mêmes 4 membres)
    const seen = new Set(), uniq = [];
    for (const g of groups) { const key = g.members.slice().sort().join('|'); if (!seen.has(key)) { seen.add(key); uniq.push(g); } }
    return uniq;
  }

  // Partition des 16 en 4 groupes de 4 : on couvre d'abord avec les groupes candidats (type/gén/lettre/longueur),
  // puis les tuiles « orphelines » (critère non calculé : famille d'évolution, place dans la famille…) forment le reste.
  function findPartition(info, candidates) {
    const names = info.map((x) => x.name);
    const inCand = new Set();
    for (const g of candidates) for (const m of g.members) inCand.add(m);
    const orphans = names.filter((n) => !inCand.has(n));
    if (orphans.length % 4 !== 0) return null; // pas de partition propre déductible
    const nonOrph = names.filter((n) => inCand.has(n));
    const result = [];
    function rec(remaining) {
      if (remaining.length === 0) return true;
      const first = remaining[0];
      for (const g of candidates) {
        if (!g.members.includes(first)) continue;
        if (!g.members.every((m) => remaining.includes(m))) continue;
        result.push({ ...g, confident: true });
        if (rec(remaining.filter((m) => !g.members.includes(m)))) return true;
        result.pop();
      }
      return false;
    }
    if (!rec(nonOrph)) return null;
    for (let i = 0; i < orphans.length; i += 4) {
      result.push({ members: orphans.slice(i, i + 4), reason: orphans.length > 4 ? 'restants (plusieurs familles ? à départager)' : 'les 4 restants (famille d\'évolution ?)', confident: false });
    }
    return result.slice();
  }

  // ───────── Interface ─────────
/*__HPUI_KIT__*/

  // Panneau dans la colonne commune du kit (repliable)
  function panel() { return UI.panel('hp-cx-panel', { title: 'Assistant Connexions', order: 30 }); }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const chips = (names) => names.map((n) => `<span style="display:inline-block;margin:2px;padding:2px 6px;border-radius:7px;background:#333;border:1px solid #555">${esc(n)}</span>`).join('');

  let sig = '', info = null, loading = false;
  async function loop() {
    if (!location.pathname.startsWith('/jeux/connexions')) { UI.removePanel('hp-cx-panel'); return; }
    let game;
    try { game = await (await fetch('/api/games/connect', { credentials: 'same-origin' })).json(); } catch { return; }
    if (!game.tiles) return;
    const p = panel();

    // tiles non encore résolues
    const solved = new Set();
    for (const grp of game.groups || []) for (const t of (grp.tiles || grp.dex || grp.members || [])) solved.add(typeof t === 'object' ? t.dex : t);
    const remainingTiles = game.tiles.filter((t) => !solved.has(t.dex) && !solved.has(t.name));

    const newSig = remainingTiles.map((t) => t.dex).join(',');
    if (newSig !== sig && !loading) { loading = true; p.innerHTML = '⏳ Analyse des Pokémon…'; try { info = await buildInfo(remainingTiles); sig = newSig; } finally { loading = false; } }
    if (!info) return;

    if (game.over) { p.innerHTML = `<div style="font-weight:700">🧩 Connexions</div>${game.won ? '✅ Résolu.' : `❌ Terminé (${game.mistakes}/${game.maxMistakes} erreurs).`}`; return; }

    const cands = candidateGroups(info);
    const partition = findPartition(info, cands);

    let body;
    if (partition) {
      const ordered = partition.slice().sort((a, b) => (b.confident ? 1 : 0) - (a.confident ? 1 : 0));
      body = `<div style="margin-bottom:6px">Partition proposée (commence par la plus sûre) :</div>` +
        ordered.map((g, i) => `<div style="margin:6px 0;padding:6px 8px;border-radius:8px;background:#222;border:1px solid ${g.confident ? '#1f9d55' : '#e67e22'}">
          <div style="font-weight:600;color:${g.confident ? '#7ee0a1' : '#f0b060'}">${i + 1}. ${esc(g.reason)}</div>${chips(g.members)}</div>`).join('');
    } else {
      body = `<div style="color:#aaa;margin-bottom:6px">Pas de partition complète déduite (des groupes utilisent sûrement la famille d'évolution). Groupes sûrs repérés :</div>` +
        (cands.length ? cands.map((g) => `<div style="margin:6px 0;padding:6px 8px;border-radius:8px;background:#222;border:1px solid #1f9d55"><div style="color:#7ee0a1;font-weight:600">${esc(g.reason)}</div>${chips(g.members)}</div>`).join('') : '<div style="color:#f88">Aucun groupe de 4 évident par type/génération/lettre/longueur.</div>');
    }

    p.innerHTML = `
      <div style="color:#aaa;margin-bottom:8px">Erreurs : ${game.mistakes}/${game.maxMistakes} · groupes restants : ${remainingTiles.length / 4}</div>
      ${body}
      <div style="color:#777;margin-top:10px;font-size:11px">Déduit du type, de la génération, de la 1re lettre et de la longueur du nom. Famille d'évolution non déduite. Tu sélectionnes et valides toi-même.</div>`;
  }

  setInterval(loop, POLL_MS);
  loop();
})();
