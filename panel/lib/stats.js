// Suivi de la collection de chaque compte, jour par jour : nombre de cartes différentes possédées (lu par le bot sur le site).
// « Nouvelles cartes du jour » = cartes possédées maintenant − cartes possédées à la fin du dernier jour connu.
// Toutes les sources comptent (boosters, échanges, achats), et une carte perdue est décomptée : c'est un gain net.
const fs = require('fs');

const KEEP_DAYS = 400;
// Jour civil à Paris (AAAA-MM-JJ), quel que soit le fuseau du serveur
const fmt = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (ms) => fmt.format(new Date(ms));

function createStats(file, { now = Date.now } = {}) {
  let data = { bots: {} };
  if (file) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && d.bots && typeof d.bots === 'object') data = d; } catch {} }
  let dirty = false, lastSave = 0;
  const save = (force) => {
    if (!file || !dirty || (!force && now() - lastSave < 60000)) return; // au plus une écriture par minute
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    dirty = false; lastSave = now();
  };
  const daysOf = (name) => (data.bots[name] ? data.bots[name].days : {});
  // Gain d'un jour : dernière valeur du jour − dernière valeur du jour connu précédent (ou la première du jour s'il n'y en a pas)
  const gain = (name, day) => {
    const days = daysOf(name), d = days[day];
    if (!d) return null;
    const prev = Object.keys(days).filter((k) => k < day).sort().pop();
    return d.last - (prev ? days[prev].last : d.first);
  };
  return {
    dayOf,
    // owned : cartes différentes possédées ; total : cartes existantes
    record(name, owned, total) {
      if (typeof owned !== 'number' || !Number.isFinite(owned) || owned < 0) return;
      const bot = (data.bots[name] ||= { days: {} });
      const day = dayOf(now());
      const d = bot.days[day];
      if (!d) {
        bot.days[day] = { first: owned, last: owned, total: total ?? null };
        const keys = Object.keys(bot.days).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete bot.days[k];
        dirty = true;
      } else if (d.last !== owned || (total != null && d.total !== total)) { d.last = owned; if (total != null) d.total = total; dirty = true; }
      save(false);
    },
    today(name) { return gain(name, dayOf(now())); },
    // Série des n derniers jours (du plus ancien au plus récent) : { days: [jour], bots: { nom: [{ gain, owned, total }] } }
    history(n = 30, names = Object.keys(data.bots)) {
      const days = [];
      for (let i = n - 1; i >= 0; i--) days.push(dayOf(now() - i * 86400000));
      const uniq = [...new Set(days)]; // changement d'heure : un jour ne doit pas apparaître deux fois
      const bots = {};
      for (const name of names) {
        const all = daysOf(name);
        bots[name] = uniq.map((day) => (all[day] ? { gain: gain(name, day), owned: all[day].last, total: all[day].total ?? null } : null));
      }
      return { days: uniq, bots };
    },
    forget(name) { if (data.bots[name]) { delete data.bots[name]; dirty = true; save(true); } },
    flush: () => save(true),
  };
}

module.exports = { createStats, dayOf };
