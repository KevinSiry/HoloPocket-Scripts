// ==UserScript==
// @name         HoloPocket – Chances de nouvelles cartes par booster
// @namespace    kevin.holopocket
// @version      2.0
// @description  Sur la page Boosters : classe les séries en favori selon la chance d'obtenir au moins une carte pas encore obtenue.
// @match        https://holopocket.fr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ───────── Réglages ─────────
  const CONFIG = {
    ONLY_FAVORITES: true,   // false = toutes les séries
    COUNT_REVERSE: true,    // une reverse manquante compte comme une nouvelle carte
    AUTO_OPEN: true,        // ouvre le classement automatiquement sur la page Boosters
  };

  async function api(path) {
    const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `${res.status}`);
    return data;
  }

  /*
   * Modèle : chaque emplacement du booster tire une rareté selon ses chances,
   * puis une carte au hasard parmi celles de cette rareté dans la série.
   * Dans un emplacement « Reverse », une rareté qui existe en reverse donne la version reverse ;
   * les autres (Illustration Rare, etc.) donnent la version normale.
   * Emplacements supposés indépendants.
   */
  function analyse(booster, cards) {
    const byRarity = {};
    for (const c of cards) {
      const r = (byRarity[c.rarity] ??= { n: 0, miss: 0, rev: 0, revMiss: 0 });
      r.n++;
      if (!c.copies) r.miss++;
      if (c.hasReverse) { r.rev++; if (!c.reverseCopies) r.revMiss++; }
    }
    let noneAll = 1, noneNormal = 1, expected = 0;
    for (const slot of booster.slots) {
      const reverseSlot = /reverse/i.test(slot.label);
      let p = 0, pNormal = 0;
      for (const pool of slot.pools) {
        const r = byRarity[pool.rarity];
        if (!r) continue;
        const asReverse = reverseSlot && r.rev > 0;
        if (asReverse) {
          if (CONFIG.COUNT_REVERSE) p += pool.chance * (r.revMiss / r.rev);
        } else {
          const f = pool.chance * (r.miss / r.n);
          p += f;
          pNormal += f;
        }
      }
      noneAll *= 1 - p;
      noneNormal *= 1 - pNormal;
      expected += p;
    }
    const missing = cards.filter((c) => !c.copies).length;
    const missingRev = cards.filter((c) => c.hasReverse && !c.reverseCopies).length;
    return {
      chance: 1 - noneAll,
      chanceNormal: 1 - noneNormal,
      expected,
      missing,
      missingRev,
      total: cards.length,
    };
  }

  async function compute() {
    const sets = (await api('/sets')).filter((s) => !s.promo && (!CONFIG.ONLY_FAVORITES || s.favorite));
    const rows = await Promise.all(
      sets.map(async (s) => {
        try {
          const id = encodeURIComponent(s.id);
          const [booster, detail] = await Promise.all([api(`/sets/${id}/booster`), api(`/sets/${id}`)]);
          return { set: s, cost: booster.cost ?? s.packCost ?? 1, ...analyse(booster, detail.cards || []) };
        } catch (e) {
          return { set: s, error: e.message };
        }
      })
    );
    return rows.sort((a, b) => (b.chance ?? -1) / (b.cost || 1) - (a.chance ?? -1) / (a.cost || 1));
  }

/*__HPUI_KIT__*/

  // ───────── Affichage ─────────
  const pct = (x) => `${(x * 100).toFixed(x >= 0.995 ? 0 : 1)} %`;
  const esc = UI.esc;
  const PANEL = 'hp-odds-panel';
  let dismissed = false; // fermé à la main : on ne le rouvre pas tout seul

  function panel() {
    return UI.panel(PANEL, {
      title: 'Chance de nouvelle carte', order: 20, closable: true,
      actions: [{ icon: 'refresh', title: 'Recalculer', onClick: () => run(true) }],
      onClose: () => { dismissed = true; paint(); },
    });
  }

  function render(rows) {
    const p = panel();
    const best = rows.find((r) => !r.error);
    let current = null;
    try { current = localStorage.getItem('pull-set'); } catch {}
    p.innerHTML = `
      <div class="hp-muted" style="font-size:12.5px;margin-bottom:6px">
        Probabilité d'avoir au moins une carte pas encore obtenue dans un booster${CONFIG.COUNT_REVERSE ? ' (reverses incluses)' : ''}. Clique une série pour la sélectionner.
      </div>
      ${rows.map((r) => r.error ? `
        <div style="padding:8px 0;border-top:1px solid #333">${esc(r.set.name)} : <span style="color:#f88">${esc(r.error)}</span></div>` : `
        <div class="hp-odds-row" role="button" tabindex="0" data-setid="${esc(r.set.id)}" title="Sélectionner ce booster"
             style="margin:0 -8px;padding:9px 8px;border-top:1px solid #333;border-radius:10px;cursor:pointer${r.set.id === current ? ';background:#222' : ''}">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
            <b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r === best ? '★ ' : ''}${esc(r.set.name)}${r.set.id === current ? ' <span class="hp-muted" style="font-weight:500;font-size:11.5px">· sélectionné</span>' : ''}</b>
            <b style="font:700 16px var(--font-mono,ui-monospace,monospace);color:${r === best ? '#ffd400' : '#f2f2f2'}">${pct(r.chance)}</b>
          </div>
          <div style="height:6px;background:#333;border-radius:4px;margin:6px 0 5px">
            <div style="height:6px;width:${(r.chance * 100).toFixed(1)}%;background:${r === best ? '#ffd400' : '#7ee0a1'};border-radius:4px"></div>
          </div>
          <div style="color:#aaa;font-size:12px">
            Normales seules ${pct(r.chanceNormal)} · ≈ ${r.expected.toFixed(2)} nouvelle(s)/booster<br>
            Manquantes : ${r.missing}/${r.total}${CONFIG.COUNT_REVERSE ? ` · reverses ${r.missingRev}` : ''} · coût ${r.cost}
          </div>
        </div>`).join('')}
      <div style="color:#777;font-size:11px;margin-top:8px">Taux du site par emplacement, carte tirée au hasard dans sa rareté.</div>`;
    p.querySelectorAll('.hp-odds-row').forEach((row) => {
      row.onclick = () => selectBooster(row.getAttribute('data-setid'));
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } };
      row.onmouseenter = () => { if (!row.style.background) row.dataset.hover = '1', row.style.background = 'var(--color-panel-2,#242428)'; };
      row.onmouseleave = () => { if (row.dataset.hover) { delete row.dataset.hover; row.style.background = ''; } };
    });
  }

  // La série du booster affiché est stockée dans localStorage['pull-set']. On l'écrit et on recharge :
  // la page revient directement sur ce booster, sans ouvrir la modale.
  function selectBooster(setId) {
    if (!setId) return;
    let current = null;
    try { current = localStorage.getItem('pull-set'); } catch {}
    if (current === setId) return; // déjà sélectionné
    try { localStorage.setItem('pull-set', setId); } catch {}
    location.reload();
  }

  let cache = null, cacheAt = 0, busy = false;
  async function run(force = false) {
    if (busy) return;
    busy = true; dismissed = false; paint();
    const p = panel();
    if (!cache) p.innerHTML = '<span class="hp-muted">Calcul des chances…</span>';
    try {
      if (force || !cache || Date.now() - cacheAt > 60000) {
        cache = await compute();
        cacheAt = Date.now();
      }
      if (!cache.length) p.innerHTML = '<span class="hp-muted">Aucune série en favori.</span>';
      else render(cache);
    } catch (e) {
      p.innerHTML = `<span style="color:#f88">${esc(e.message)}</span>`;
    } finally {
      busy = false; paint();
    }
  }

  // ───────── Bouton du dock (page Boosters uniquement) ─────────
  let lastPath = null;
  function paint() {
    const onBoosters = location.pathname === '/';
    if (!onBoosters) {
      UI.removeButton('hp-odds-btn');
      UI.removePanel(PANEL);
      lastPath = location.pathname;
      return;
    }
    const open = UI.hasPanel(PANEL);
    UI.button('hp-odds-btn', {
      label: 'Chances par booster', sub: open ? 'Masquer le classement' : 'Afficher le classement',
      icon: 'dice', kind: 'secondary', order: 12, busy,
      onClick: () => { if (UI.hasPanel(PANEL)) { UI.removePanel(PANEL); dismissed = true; paint(); } else run(true); },
    });
    if (lastPath !== '/' && CONFIG.AUTO_OPEN && !dismissed) run();
    lastPath = '/';
  }

  paint();
  setInterval(paint, 1000);
})();
