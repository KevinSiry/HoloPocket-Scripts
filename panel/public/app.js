// Interface du panel : tout le texte des données passe par textContent (jamais d'HTML construit à partir du bot).
const SCRIPT_LABELS = {
  'auto-booster': 'Ouverture auto des boosters',
  echanges: 'Échanges auto',
  'vendre-doublons': 'Vente des doublons',
  recyclage: 'Recyclage',
  'achat-revente': 'Achat-revente',
  'achat-manquantes': 'Achat des cartes manquantes',
};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'X-Panel': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && !url.startsWith('/api/login')) { location.href = '/login'; throw new Error('non connecté'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const ago = (iso) => {
  if (!iso) return 'jamais';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  return `il y a ${Math.round(s / 3600)} h`;
};
const num = (n) => (n == null ? '–' : Number(n).toLocaleString('fr-FR'));

const PROFILE = (name) => `https://holopocket.fr/joueur/${encodeURIComponent(name)}`;
function profileLink(name, cls = 'profile') {
  const a = el('a', cls, 'Profil ↗');
  a.href = PROFILE(name); a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.title = `Ouvrir le profil de ${name} sur HoloPocket`;
  a.setAttribute('aria-label', `Profil HoloPocket de ${name} (nouvel onglet)`);
  return a;
}

// Boîte de dialogue maison (à la place de confirm/prompt du navigateur)
function dialog({ title, text, secret, confirm: yes, danger }) {
  return new Promise((resolve) => {
    const d = $('dlg'), acts = $('dlgActions'), sec = $('dlgSecret');
    $('dlgTitle').textContent = title; $('dlgText').textContent = text || '';
    sec.hidden = !secret; sec.textContent = secret || '';
    acts.replaceChildren();
    const mk = (label, cls, val) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', () => { d.close(); resolve(val); }); acts.append(b); return b; };
    if (secret) {
      const c = el('button', 'primary', 'Copier'); c.type = 'button';
      c.addEventListener('click', async () => { try { await navigator.clipboard.writeText(secret); c.textContent = 'Copié'; } catch { c.textContent = 'Copie impossible'; } });
      acts.append(c);
      mk('Fermer', 'ghost', true);
    } else {
      mk('Annuler', 'ghost', false);
      mk(yes || 'Confirmer', danger ? 'danger' : 'primary', true);
    }
    d.addEventListener('close', () => { sec.textContent = ''; resolve(false); }, { once: true });
    d.showModal();
    acts.querySelector('button').focus();
  });
}
const confirmBox = (title, text, yes, danger) => dialog({ title, text, confirm: yes, danger });

let manage = false; // le panel gère les comptes (mode flotte)
let busy = 0; // pause du rafraîchissement pendant une action
let openSets = {};

// Ligne de jauge : intitulé, barre, valeur. La barre change de ton quand elle est pleine.
function meter(label, val, max) {
  const row = el('div', 'meter');
  const pct = max ? Math.max(0, Math.min(1, (val || 0) / max)) : 0;
  const bar = el('span', 'track');
  bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', label);
  bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(max || 0)); bar.setAttribute('aria-valuenow', String(val || 0));
  const fill = el('i'); fill.style.setProperty('--p', String(pct));
  bar.append(fill);
  if (pct >= 1) row.classList.add('full');
  row.append(el('span', 'k', label), bar, el('span', 'v', `${num(val)}/${num(max)}`));
  return row;
}
const openCards = new Set(); // réglages dépliés (gardés d'un rafraîchissement à l'autre)
function fold(name, title, ...children) {
  const det = el('details', 'more');
  det.open = openCards.has(name);
  det.addEventListener('toggle', () => { if (det.open) openCards.add(name); else openCards.delete(name); });
  det.append(el('summary', null, title), ...children);
  return det;
}

async function act(card, fn) {
  busy++; card.classList.add('pending');
  try { await fn(); } catch (e) { toast(e.message, true); } finally { busy--; card.classList.remove('pending'); await refresh(true); }
}
function toast(text, bad) {
  const t = el('div', bad ? 'toast bad' : 'toast', text);
  const box = $('toasts');
  while (box.children.length >= 4) box.firstElementChild.remove(); // pas de pile de notifications qui mange l'écran
  box.append(t);
  setTimeout(() => t.remove(), bad ? 8000 : 4000);
}

// Séries proposées dans la liste du booster (hors promos), favoris marqués ★
// Favoris d'abord, chacun dans son groupe ; le coût en énergie est affiché quand le site le donne
const setChoices = (sets) => sets.filter((x) => !x.promo)
  .map((x) => ({ value: `set:${x.id}`, label: x.name, star: !!x.favorite, group: x.favorite ? 'Séries favorites' : 'Autres séries', search: `${x.name} ${x.id}`,
    hint: typeof x.packCost === 'number' ? `${x.packCost} énergie${x.packCost > 1 ? 's' : ''} par booster` : '' }))
  .sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || a.label.localeCompare(b.label, 'fr'));
// Modes automatiques, toujours en tête de liste
const MODE_OPTIMAL = { value: 'optimal', label: 'Optimisation des nouvelles cartes', group: 'Choix automatique', search: 'optimisation nouvelles cartes optimal energie', hint: 'Toutes les séries : la meilleure chance de nouvelle carte par point d’énergie' };
const MODE_QUESTS = { value: 'quests', label: 'Quêtes du Tour des Arènes', group: 'Choix automatique', search: 'quetes quete tour arenes arene secrets badges champion', hint: 'L’extension qui fait le plus avancer tes quêtes d’arène, puis celles des secrets, sinon les nouvelles cartes' };
const MODE_AUTO = { value: 'auto', label: 'Meilleur favori', group: 'Choix automatique', search: 'auto meilleur favori', hint: 'Parmi tes séries favorites : la meilleure chance de nouvelle carte' };
// Recherche sans tenir compte des accents ni de la casse
const fold_ = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Liste déroulante avec barre de recherche (un <select> natif ne peut pas en contenir).
// pinned : choix toujours en tête (Global, Auto) ; choices : séries filtrées par la recherche.
// Clavier : ↑ ↓ pour se déplacer, Entrée pour choisir, Échap pour fermer.
let comboSeq = 0;
function searchSelect({ label, value, pinned = [], choices, onChange }) {
  const id = `cb${++comboSeq}`;
  const all = [...pinned, ...choices];
  const root = el('div', 'combo');
  const btn = el('button', 'combo-btn'); btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', label);
  const cur = el('span', 'combo-cur');
  btn.append(cur, el('span', 'combo-caret', '▾'));
  const pop = el('div', 'combo-pop'); pop.hidden = true;
  const q = el('input'); q.type = 'text'; q.placeholder = 'Rechercher une série…'; q.autocomplete = 'off'; q.spellcheck = false;
  q.setAttribute('role', 'combobox'); q.setAttribute('aria-expanded', 'true'); q.setAttribute('aria-autocomplete', 'list');
  q.setAttribute('aria-controls', `${id}-list`); q.setAttribute('aria-label', `${label} : rechercher une série`);
  const list = el('ul', 'combo-list'); list.id = `${id}-list`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label);
  const empty = el('p', 'muted combo-empty', 'Aucune série trouvée'); empty.hidden = true;
  empty.setAttribute('role', 'status');
  pop.append(q, list, empty);
  root.append(btn, pop);

  let shown = [], active = -1;
  let opts = []; // éléments sélectionnables (les titres de groupe n'en font pas partie)
  const showCur = () => { const c = all.find((x) => x.value === value); cur.textContent = c ? `${c.label}${c.star ? ' ★' : ''}` : value; };
  const setActive = (i) => {
    active = i;
    opts.forEach((li, k) => { li.classList.toggle('active', k === i); li.setAttribute('aria-selected', String(k === i)); });
    const li = opts[i];
    if (li) { q.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); } else q.removeAttribute('aria-activedescendant');
  };
  const render = (onCurrent) => {
    const t = fold_(q.value.trim());
    shown = t ? all.filter((c) => fold_(c.search || c.label).includes(t)) : all;
    const nodes = [];
    opts = [];
    let group = null;
    shown.forEach((c, k) => {
      if (c.group && c.group !== group) { // titre de groupe : repère visuel, jamais sélectionnable
        group = c.group;
        const n = shown.filter((x) => x.group === group).length;
        const h = el('li', 'combo-group', n > 1 && group !== 'Choix automatique' ? `${group} (${n})` : group);
        h.setAttribute('role', 'presentation');
        nodes.push(h);
      }
      const li = el('li', c.value === value ? 'opt cur' : 'opt');
      li.id = `${id}-o${k}`; li.setAttribute('role', 'option');
      const main = el('span', 'opt-main');
      main.append(el('span', 'opt-label', c.label));
      if (c.star) { const st = el('span', 'opt-star', '★'); st.setAttribute('aria-label', 'favorite'); main.append(st); }
      if (c.value === value) { const ok = el('span', 'opt-check', '✓'); ok.setAttribute('aria-label', 'choix actuel'); main.append(ok); }
      li.append(main);
      if (c.hint) li.append(el('span', 'opt-hint', c.hint));
      li.addEventListener('mousedown', (e) => e.preventDefault()); // garde le focus dans la recherche
      li.addEventListener('click', () => pick(c));
      li.addEventListener('mousemove', () => { if (active !== k) setActive(k); });
      nodes.push(li); opts.push(li);
    });
    list.replaceChildren(...nodes);
    empty.textContent = `Aucune série ne correspond à « ${q.value.trim()} »`;
    empty.hidden = shown.length > 0;
    const i = onCurrent ? shown.findIndex((c) => c.value === value) : 0;
    setActive(shown.length ? Math.max(0, i) : -1);
  };
  // Position fixe sous le bouton (les cartes coupent ce qui dépasse), au-dessus s'il manque de place
  const place = () => {
    const vv = window.visualViewport;
    const r = btn.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = vv ? vv.height + vv.offsetTop : window.innerHeight;
    const w = Math.min(Math.max(r.width, 288), vw - 16);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
    const below = vh - r.bottom, h = pop.offsetHeight;
    if (below < h + 12 && r.top > below) { pop.style.top = ''; pop.style.bottom = `${vh - r.top + 6}px`; }
    else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 6}px`; }
  };
  const onOutside = (e) => { if (!root.contains(e.target)) close(false); };
  // Défilement de la page (ex. clavier mobile qui s'ouvre et fait remonter le champ) : la liste suit le bouton au lieu de se fermer
  const onScroll = (e) => { if (!pop.contains(e.target)) place(); };
  const open = () => {
    if (!pop.hidden) return;
    pop.hidden = false; root.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    q.value = ''; render(true); place(); q.focus();
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    if (window.visualViewport) { visualViewport.addEventListener('resize', place); visualViewport.addEventListener('scroll', place); }
  };
  const close = (refocus) => {
    if (pop.hidden) return;
    pop.hidden = true; root.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', place);
    if (window.visualViewport) { visualViewport.removeEventListener('resize', place); visualViewport.removeEventListener('scroll', place); }
    if (refocus) btn.focus();
  };
  const pick = (c) => { close(true); if (c.value !== value) { value = c.value; showCur(); onChange(c.value); } };

  btn.addEventListener('click', () => (pop.hidden ? open() : close(true)));
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
  q.addEventListener('input', () => render(false));
  q.addEventListener('keydown', (e) => {
    const n = shown.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setActive((active + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive((active - 1 + n) % n); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  });
  showCur();
  return root;
}
const MODES = { auto: MODE_AUTO, optimal: MODE_OPTIMAL, quests: MODE_QUESTS };
const AUTO_PINNED = [MODE_QUESTS, MODE_OPTIMAL, MODE_AUTO];
const describe = (c, sets) => (c.mode === 'fixed' ? (sets.find((x) => x.id === c.setId) || { name: c.setId }).name : (MODES[c.mode] || MODE_AUTO).label);
// valeur de la liste <-> choix
const toValue = (c) => (c.mode === 'global' || MODES[c.mode] ? c.mode : `set:${c.setId}`);
const fromValue = (v) => (v === 'global' || MODES[v] ? { mode: v } : { mode: 'fixed', setId: v.slice(4) });
const sendBooster = (url, v) => api('PUT', url, fromValue(v)).then((r) => {
  if (r.failed && r.failed.length) toast(`Refusé par : ${r.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`, true);
  else toast('Booster enregistré');
});

function boosterBlock(bot, card, globalChoice) {
  const s = bot.status;
  const sets = openSets._any || [];
  const box = el('div', 'block');
  box.append(el('h3', null, 'Booster à ouvrir'));
  const sel = searchSelect({
    label: `Booster du compte ${bot.name}`,
    value: toValue(bot.booster.choice),
    pinned: [{ value: 'global', label: 'Suivre le réglage global', group: 'Choix automatique', search: 'global suivre', hint: `Actuellement : ${describe(globalChoice, sets)}` }, ...AUTO_PINNED],
    choices: setChoices(sets),
    onChange: (v) => act(card, () => sendBooster(`/api/bots/${encodeURIComponent(bot.name)}/booster`, v)),
  });
  box.append(el('div', 'row', null));
  box.lastChild.append(sel);
  if (bot.booster.error) box.append(el('p', 'err', `Non appliqué : ${bot.booster.error}`));
  else if (s.booster.mode === 'auto' && s.booster.favorites.length) box.append(el('p', 'muted', `Favoris : ${s.booster.favorites.map((f) => f.name).join(', ')}`));
  else if (s.booster.mode === 'optimal') box.append(el('p', 'muted', 'Toutes les séries sont comparées : chance de nouvelle carte divisée par le coût en énergie.'));
  else if (s.booster.mode === 'quests') box.append(el('p', 'muted', 'Quêtes d’arène d’abord, puis quêtes des secrets ; sans quête jouable en booster, la meilleure chance de nouvelle carte.'));
  const last = s.booster.last;
  if (last && last.set) box.append(el('p', 'muted', `Dernier booster : ${last.set}${last.reason ? `, ${last.reason}` : ''} (${ago(last.at)})`));
  return box;
}

function globalBar(globalChoice, bots) {
  const bar = el('div', 'bar-item');
  const sets = openSets._any || [];
  const lab = el('div', 'inline');
  lab.append(el('span', 'k', 'Booster de tous les comptes'));
  const sel = searchSelect({
    label: 'Booster global',
    value: toValue(globalChoice),
    pinned: AUTO_PINNED,
    choices: setChoices(sets),
    onChange: (v) => act(bar, () => sendBooster('/api/booster/global', v)),
  });
  const follow = bots.filter((b) => b.booster.choice.mode === 'global').length;
  lab.append(sel);
  bar.append(lab, el('span', 'muted', follow ? `${follow} compte${follow > 1 ? 's' : ''} sur ${bots.length} le suiv${follow > 1 ? 'ent' : 'it'}` : 'Aucun compte ne le suit'));
  return bar;
}

const SHORT = { 'auto-booster': 'Boosters', echanges: 'Échanges', 'vendre-doublons': 'Vente', recyclage: 'Recyclage', 'achat-revente': 'Achat-revente', 'achat-manquantes': 'Manquantes' };
function scriptChips(bot, card) {
  const box = el('div', 'chips');
  box.setAttribute('role', 'group'); box.setAttribute('aria-label', `Scripts de ${bot.name}`);
  for (const sc of bot.status.scripts) {
    const b = el('button', sc.on ? 'tog on' : 'tog', SHORT[sc.name] || sc.name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(sc.on));
    b.title = `${SCRIPT_LABELS[sc.name] || sc.name}${sc.version ? `, version ${sc.version}` : ''}. ${sc.on ? 'Cliquer pour couper' : 'Cliquer pour activer'}.`;
    b.addEventListener('click', () => act(card, () => api('PUT', `/api/bots/${encodeURIComponent(bot.name)}/config`, { scripts: { [sc.name]: !sc.on } })
      .then(() => toast(`${SCRIPT_LABELS[sc.name] || sc.name} ${sc.on ? 'coupé' : 'activé'} sur ${bot.name}`))));
    box.append(b);
  }
  return box;
}

const acc = (bot) => `/api/accounts/${encodeURIComponent(bot.name)}`;
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
function flipBlock(f) {
  const box = el('div', 'block');
  box.append(el('h3', null, 'Achat-revente'));
  box.append(el('p', 'muted line', `Dernier passage ${ago(f.lastPassAt)}.${f.error ? ` Erreur : ${f.error}` : ''}`));
  const g = el('div', 'kv');
  for (const [k, v] of [['Enchères suivies', f.bids], ['À revendre', f.waiting ? `${f.toResell} (${f.waiting} sans place)` : f.toResell], ['Achats', f.bought], ['Ventes', f.sold], ['Bénéfice', `${f.profit >= 0 ? '+' : ''}${num(f.profit)}`]]) { const d = el('div'); d.append(el('span', 'k', k), el('b', null, String(v))); g.append(d); }
  box.append(g);
  const ol = el('ol', 'flog');
  for (const l of f.log.slice().reverse()) { const li = el('li'); li.append(el('time', 'muted', hhmm(l.at)), el('span', null, l.text)); ol.append(li); }
  if (!f.log.length) ol.append(el('li', 'muted', 'Aucune enchère pour le moment.'));
  box.append(ol);
  return box;
}

function manageBlock(bot, card) {
  const row = el('div', 'actions');
  const btn = (label, fn, cls = 'ghost') => { const b = el('button', cls, label); b.addEventListener('click', fn); row.append(b); };
  btn('Voir le mot de passe', () => act(card, async () => { const r = await api('POST', `${acc(bot)}/reveal`); await dialog({ title: `Mot de passe de ${bot.name}`, text: 'À copier maintenant : il disparaît à la fermeture.', secret: r.password }); }));
  btn(bot.disabled ? 'Activer' : 'Désactiver', () => act(card, () => api('PUT', acc(bot), { enabled: !!bot.disabled }).then(() => toast(bot.disabled ? 'Compte activé' : 'Compte désactivé'))));
  btn('Supprimer', async () => { if (await confirmBox(`Supprimer ${bot.name} ?`, 'Son mot de passe sera perdu pour le panel. Le compte reste sur HoloPocket.', 'Supprimer', true)) act(card, () => api('DELETE', acc(bot)).then(() => toast('Compte supprimé'))); }, 'ghost danger-text');
  return row;
}

function addBar() {
  const bar = el('div', 'bar-item');
  const create = el('button', 'primary', 'Créer un compte');
  create.title = 'Pseudo et mot de passe aléatoires, enregistrés chiffrés dans le panel';
  create.addEventListener('click', () => act(bar, async () => {
    toast('Création en cours, quelques secondes…');
    const r = await api('POST', '/api/accounts/create');
    toast(`Compte créé : ${r.username}`);
  }));
  const det = el('details', 'inline-form');
  det.append(el('summary', null, 'Ajouter un compte existant'));
  const f = el('form', 'form');
  const u = el('input'); u.placeholder = 'Pseudo'; u.required = true; u.autocomplete = 'off'; u.setAttribute('aria-label', 'Pseudo');
  const p = el('input'); p.type = 'password'; p.placeholder = 'Mot de passe'; p.required = true; p.autocomplete = 'new-password'; p.setAttribute('aria-label', 'Mot de passe');
  const ok = el('button', null, 'Ajouter'); ok.type = 'submit';
  f.append(u, p, ok);
  f.addEventListener('submit', (e) => { e.preventDefault(); act(bar, async () => { await api('POST', '/api/accounts', { username: u.value.trim(), password: p.value }); u.value = ''; p.value = ''; toast('Compte ajouté'); }); });
  det.append(f);
  bar.append(create, det);
  return bar;
}

async function accountCard(bot, globalChoice) {
  const s = bot.status;
  const state = bot.disabled ? 'off' : bot.online ? 'live' : 'down';
  const card = el('article', `card ${state}`);
  const pseudo = (s && s.account && s.account.user) || bot.name;
  const head = el('header', 'head');
  const title = el('div', 'title');
  title.append(el('h2', null, pseudo), profileLink(pseudo));
  const label = { off: 'Désactivé', live: 'En ligne', down: 'Hors ligne' }[state];
  head.append(title, el('span', `status ${state}`, label));
  card.append(head);
  const manageFold = () => fold(bot.name, 'Gérer le compte', manageBlock(bot, card));

  if (bot.disabled) { card.append(el('p', 'note', 'Ce compte ne tourne pas. Active-le dans Gérer le compte.')); if (manage) card.append(manageFold()); return card; }
  if (!s) { card.append(el('p', 'note', bot.error || 'Démarrage en cours…')); if (manage) card.append(manageFold()); return card; }
  if (!bot.online) card.append(el('p', 'note bad', bot.error || `Plus de nouvelles depuis ${ago(bot.lastSeen).replace('il y a ', '')}.`));
  if (!manage && bot.name !== (s.account && s.account.user)) card.append(el('p', 'note', `Bot ${bot.name}`));

  const coins = el('p', 'coins');
  if (s.account) { coins.append(el('b', null, num(s.account.balance)), el('span', null, ' pièces')); }
  else coins.append(el('span', 'bad', 'Session perdue, reconnexion en cours'));
  card.append(coins);
  if (s.collection) {
    const col = el('p', 'collection');
    col.append(el('span', null, `Collection ${num(s.collection.owned)} sur ${num(s.collection.total)}`));
    if (typeof bot.newToday === 'number') col.append(el('b', bot.newToday > 0 ? 'up' : null, `${signed(bot.newToday)} aujourd’hui`));
    card.append(col);
  }
  const meters = el('div', 'meters');
  if (s.account) meters.append(meter('Énergie', s.account.energy.stock, s.account.energy.max));
  meters.append(meter('Échanges', s.trades.open, s.trades.max), meter('Ventes', s.sales.selling, s.sales.max));
  card.append(meters);

  if (!bot.online) { if (manage) card.append(manageFold()); return card; }
  card.append(scriptChips(bot, card));
  const r = el('button', 'ghost small', 'Redémarrer');
  r.addEventListener('click', async () => { if (await confirmBox(`Redémarrer ${bot.name} ?`, 'Le navigateur du compte est relancé et les scripts sont retéléchargés.', 'Redémarrer')) act(card, () => api('POST', `/api/bots/${encodeURIComponent(bot.name)}/restart`).then(() => toast(`${bot.name} redémarre`))); });
  const parts = [boosterBlock(bot, card, globalChoice)];
  if (s.flip && s.scripts.some((x) => x.name === 'achat-revente' && x.on)) parts.push(flipBlock(s.flip));
  const acts = manage ? manageBlock(bot, card) : el('div', 'actions');
  acts.prepend(r);
  parts.push(acts);
  const choice = { global: 'booster global', auto: 'meilleur favori', optimal: 'booster optimisé', quests: 'quêtes d’arène' }[bot.booster.choice.mode] || 'booster fixe';
  card.append(fold(bot.name, bot.booster.error ? 'Réglages (booster non appliqué)' : `Réglages, ${choice}`, ...parts));
  return card;
}

let alertSig = null, alertsOpen = false;
function renderAlerts(alerts) {
  const box = $('alerts');
  const sig = alerts.map((a) => `${a.key}|${a.text}`).join('\n') + alertsOpen;
  if (sig === alertSig) return; // rien de neuf : on ne redessine pas
  alertSig = sig;
  box.replaceChildren();
  const MAX = 3;
  const shown = alertsOpen ? alerts : alerts.slice(0, MAX);
  for (const a of shown) {
    const row = el('div', `alert ${a.level}`);
    const x = el('button', 'alert-x', '×');
    x.type = 'button'; x.title = 'Fermer cette alerte'; x.setAttribute('aria-label', 'Fermer cette alerte');
    x.addEventListener('click', () => { row.remove(); alertSig = null; api('POST', '/api/alerts/dismiss', { key: a.key }).catch(() => {}); });
    const msg = el('span', null);
    msg.append(el('b', null, a.bot), ` ${a.text} `, profileLink(a.bot, 'profile inline-link'));
    row.append(msg, x);
    box.append(row);
  }
  if (alerts.length > 1) {
    const foot = el('div', 'alert-foot');
    if (alerts.length > MAX) {
      const more = el('button', 'ghost small', alertsOpen ? 'Réduire' : `Afficher les ${alerts.length - MAX} autres alertes`);
      more.type = 'button'; more.setAttribute('aria-expanded', String(alertsOpen));
      more.addEventListener('click', () => { alertsOpen = !alertsOpen; renderAlerts(alerts); });
      foot.append(more);
    }
    const all = el('button', 'ghost small dismiss-all', 'Tout fermer');
    all.type = 'button';
    all.addEventListener('click', () => { box.replaceChildren(); alertSig = null; api('POST', '/api/alerts/dismiss', { all: true, keys: alerts.map((a) => a.key) }).catch(() => {}); });
    foot.append(all);
    box.append(foot);
  }
}
const signed = (n) => `${n > 0 ? '+' : ''}${num(n)}`;
function renderSummary(d) {
  const box = $('summary');
  const live = d.bots.filter((b) => !b.disabled);
  const online = live.filter((b) => b.online).length;
  const coins = d.bots.reduce((t, b) => t + ((b.status && b.status.account && b.status.account.balance) || 0), 0);
  const trades = d.bots.reduce((t, b) => t + ((b.status && b.status.trades && b.status.trades.open) || 0), 0);
  const n = d.alerts.length;
  box.replaceChildren();
  const cell = (k, v, warn) => { const c = el('div', warn ? 'cell warn' : 'cell'); c.append(el('b', null, v), el('span', null, k)); box.append(c); };
  cell(live.length > 1 ? 'comptes en ligne' : 'compte en ligne', `${online}/${live.length}`, live.length && online < live.length);
  cell('pièces sur la flotte', num(coins));
  cell(trades > 1 ? 'échanges ouverts' : 'échange ouvert', num(trades));
  const fresh = d.bots.map((b) => b.newToday).filter((x) => typeof x === 'number');
  cell('nouvelles cartes aujourd’hui', fresh.length ? signed(fresh.reduce((t, x) => t + x, 0)) : '–');
  cell(n > 1 ? 'alertes' : 'alerte', String(n), n > 0);
}

// Une ligne du journal → { tag, summary, details } : « Booster ouvert · Série · 2 nouvelles cartes » puis le détail sur les lignes suivantes
function parseLog(text) {
  let [first, ...rest] = String(text).replace(/^›\s*/, '').split('\n');
  if (!rest.length) { // anciennes lignes, enregistrées sans retour à la ligne : on retrouve la coupure
    const m = first.match(/^(Booster ouvert .*?nouvelles? cartes?)(\S.*)$/) || first.match(/^([^•]+?)\s*(•.*)$/);
    if (m) { first = m[1]; rest = m[2].split(/\s*•\s*/).filter(Boolean); }
  }
  const m = first.match(/^([^:·]{2,28}?)\s*[:·]\s+(.+)$/);
  return { tag: m ? m[1].trim() : '', summary: m ? m[2].trim() : first.trim(), details: rest.map((x) => x.trim()).filter(Boolean) };
}
function logBody(l) {
  const { tag, summary, details } = parseLog(l.text);
  const body = el('div', 'log-body');
  const head = el('p', 'log-head');
  if (tag) head.append(el('span', 'log-tag', tag));
  const lvl = l.level === 'error' ? 'Erreur' : l.level === 'warn' ? 'Alerte' : '';
  if (lvl) head.append(el('span', 'lvl', lvl));
  head.append(el('span', 'log-sum', summary));
  body.append(head);
  if (!details.length) return body;
  if (tag === 'Booster ouvert') { // cartes obtenues : une pastille par carte, les nouvelles en tête et en doré
    const cards = details.join(', ').split(/,\s+/).map((c) => c.trim()).filter(Boolean).map((c) => ({ fresh: /\(nouvelle\)/.test(c), rev: /\(rev\.\)/.test(c), name: c.replace(/\s*\((nouvelle|rev\.)\)/g, '') }));
    const ul = el('ul', 'log-cards');
    for (const c of cards.sort((a, b) => (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0))) {
      const li = el('li', c.fresh ? 'fresh' : null, c.name);
      if (c.rev) li.append(el('span', 'rev', 'reverse'));
      if (c.fresh) li.append(el('span', 'new', 'nouvelle'));
      ul.append(li);
    }
    body.append(ul);
  } else {
    const ul = el('ul', 'log-lines');
    for (const d of details) ul.append(el('li', null, d.replace(/^[•✗]\s*/, '')));
    body.append(ul);
  }
  return body;
}
// Types de lignes du journal, d'après l'étiquette en début de message
const LOG_TYPES = [
  ['boosters', 'Boosters', /^(Booster ouvert|Carte de valeur|Auto-ouverture|Événement)/i],
  ['trades', 'Échanges', /^(Auto-échanges|Échanges?\b|Échange prioritaire|Offres en pièces|Refus impossible)/i],
  ['market', 'Marché', /^(Auto-vente|Achat-revente|Cartes manquantes|Recyclage|Vente|Enchère|Marché)/i],
  ['system', 'Système', null], // tout le reste : démarrage, session, réglages du panel, mises à jour
];
const logType = (l) => { const t = String(l.text).replace(/^›\s*/, ''); const hit = LOG_TYPES.find(([, , re]) => re && re.test(t)); return hit ? hit[0] : 'system'; };
let logTypes = new Set(LOG_TYPES.map((t) => t[0]));
try { const saved = JSON.parse(localStorage.getItem('hp-panel-log-types') || 'null'); if (Array.isArray(saved) && saved.length) logTypes = new Set(saved.filter((k) => LOG_TYPES.some((t) => t[0] === k))); } catch {}
function renderLogTypes(lines) {
  const box = $('logTypes');
  const counts = Object.fromEntries(LOG_TYPES.map((t) => [t[0], 0]));
  for (const l of lines) counts[logType(l)]++;
  const all = logTypes.size === LOG_TYPES.length;
  const mk = (label, on, onClick, n) => {
    const b = el('button', on ? 'tog on' : 'tog', label); b.type = 'button'; b.setAttribute('aria-pressed', String(on));
    if (n != null) b.append(el('span', 'tog-n', num(n)));
    b.addEventListener('click', onClick); return b;
  };
  const set = (next) => { logTypes = next; try { localStorage.setItem('hp-panel-log-types', JSON.stringify([...next])); } catch {} refreshLogs(true); };
  box.replaceChildren(
    mk('Tout', all, () => set(new Set(LOG_TYPES.map((t) => t[0]))), lines.length),
    // Un clic sur un type quand tout est affiché : ce type seul. Ensuite, chaque clic l'ajoute ou le retire.
    ...LOG_TYPES.map(([k, label]) => mk(label, !all && logTypes.has(k), () => {
      if (all) return set(new Set([k]));
      const next = new Set(logTypes); if (next.has(k)) next.delete(k); else next.add(k);
      set(next.size ? next : new Set(LOG_TYPES.map((t) => t[0])));
    }, counts[k])),
  );
}
let logSig = '';
function renderLogs(lines) {
  const ol = $('logList');
  // Rien de neuf : on ne redessine pas (garde la sélection de texte et le défilement)
  const sig = `${[...logTypes].join(',')}|${lines.length}|${lines.length ? `${lines[lines.length - 1].bot}#${lines[lines.length - 1].id}` : ''}`;
  if (sig === logSig) return;
  logSig = sig;
  ol.replaceChildren();
  for (const l of lines.slice().reverse()) {
    const li = el('li', /\(nouvelle\)/.test(l.text) ? `${l.level} fresh` : l.level); // booster avec une nouvelle carte : repère doré
    const t = el('time', 'muted', new Date(l.at).toLocaleTimeString('fr-FR'));
    t.dateTime = l.at; t.title = new Date(l.at).toLocaleString('fr-FR');
    li.append(t, el('b', null, l.bot), logBody(l));
    ol.append(li);
  }
  if (!lines.length) ol.append(el('li', 'muted', 'Aucune ligne pour ces filtres.'));
}

// ───────── Onglet Chances : probabilité de nouvelle carte par booster, pour un compte ─────────
const pct = (x) => (x >= 0.9995 ? '100 %' : x > 0 && x < 0.001 ? '< 0,1 %' : `${(x * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
let chTimer = null;
function renderChances(d) {
  const box = $('chList');
  const sort = $('chSort').value;
  const rows = d.rows.filter((r) => !r.error).map((r) => ({ ...r, ratio: r.cost > 0 ? r.chance / r.cost : 0 }));
  const failed = d.rows.filter((r) => r.error);
  rows.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'fr') : sort === 'chance' ? (a, b) => b.chance - a.chance || a.cost - b.cost : (a, b) => b.ratio - a.ratio || b.chance - a.chance);
  const best = rows.reduce((m, r) => (r.ratio > (m ? m.ratio : 0) ? r : m), null);
  $('chStamp').textContent = d.computing ? (rows.length ? 'Recalcul en cours…' : 'Calcul en cours, quelques secondes…') : d.error && !rows.length ? `Calcul impossible : ${d.error}` : d.at ? `Calculé ${ago(d.at)}` : '';
  box.replaceChildren();
  if (!rows.length) { if (!d.computing) box.append(el('p', 'empty', d.error ? 'Le calcul a échoué. Réessaie avec Recalculer.' : 'Aucune série à afficher.')); return; }
  const table = el('table', 'ch-table');
  const head = el('tr');
  for (const [t, cls] of [['Série', ''], ['Chance de nouvelle carte', 'wide'], ['Coût', 'num'], ['Par énergie', 'num'], ['Cartes manquantes', 'num']]) { const th = el('th', cls, t); th.scope = 'col'; head.append(th); }
  const thead = el('thead'); thead.append(head);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr', r.chance <= 0 ? 'done' : r === best ? 'best' : null);
    const name = el('th', 'ch-name'); name.scope = 'row';
    name.append(el('span', null, r.name));
    if (r.favorite) { const st = el('span', 'opt-star', '★'); st.title = 'Série favorite'; st.setAttribute('aria-label', 'favorite'); name.append(st); }
    if (r === best) name.append(el('span', 'ch-best', 'Le plus rentable'));
    const cell = el('td', 'wide');
    const bar = el('span', 'track'); const fill = el('i'); fill.style.setProperty('--p', String(Math.max(0, Math.min(1, r.chance)))); bar.append(fill);
    const wrap = el('div', 'ch-bar'); wrap.append(el('b', null, r.chance <= 0 ? 'Série complète' : pct(r.chance)), bar); cell.append(wrap);
    tr.append(name, cell, el('td', 'num', `${num(r.cost)} énergie${r.cost > 1 ? 's' : ''}`), el('td', 'num', r.chance <= 0 ? '–' : pct(r.ratio)), el('td', 'num', `${num(r.missing)} sur ${num(r.total)}`));
    ['Coût', 'Par énergie', 'Manquantes'].forEach((t, i) => { tr.querySelectorAll('td.num')[i].dataset.label = t; }); // libellés repris en affichage téléphone
    tbody.append(tr);
  }
  table.append(thead, tbody);
  box.append(table);
  if (failed.length) box.append(el('p', 'muted', `Séries illisibles : ${failed.map((r) => r.name).join(', ')}.`));
}
async function refreshChances(fresh) {
  clearTimeout(chTimer);
  const name = $('chBot').value;
  if (!name || $('chances').hidden) return;
  try {
    const d = await api('GET', `/api/bots/${encodeURIComponent(name)}/chances${fresh ? '?fresh=1' : ''}`);
    if ($('chBot').value !== name) return; // compte changé entre-temps
    renderChances(d);
    if (d.computing) chTimer = setTimeout(() => refreshChances(false), 3000);
  } catch (e) { $('chStamp').textContent = `Erreur : ${e.message}`; $('chList').replaceChildren(); }
}

// ───────── Onglet Évolution : nouvelles cartes par jour ─────────
const SVG = (tag, attrs = {}, text) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
const dayLabel = (iso, long) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', long ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'numeric' });
// Graduation « ronde » juste au-dessus du maximum
const niceMax = (v) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
function evolutionSeries(d, name) {
  const names = name ? [name] : Object.keys(d.bots);
  return d.days.map((day, i) => {
    const pts = names.map((n) => (d.bots[n] || [])[i]).filter(Boolean);
    return pts.length ? { day, gain: pts.reduce((t, p) => t + (p.gain || 0), 0), owned: pts.reduce((t, p) => t + p.owned, 0), total: pts.reduce((t, p) => t + (p.total || 0), 0) } : { day, gain: null };
  });
}
function renderEvolution(d) {
  const name = $('evBot').value;
  const rows = evolutionSeries(d, name);
  const known = rows.filter((r) => r.gain != null);
  const who = name || (Object.keys(d.bots).length > 1 ? 'tous les comptes' : Object.keys(d.bots)[0] || '');
  // Chiffres clés
  const stats = $('evStats'); stats.replaceChildren();
  const cell = (k, v) => { const c = el('div', 'cell'); c.append(el('b', null, v), el('span', null, k)); stats.append(c); };
  const today = rows[rows.length - 1], week = rows.slice(-7).filter((r) => r.gain != null);
  cell('nouvelles cartes aujourd’hui', today && today.gain != null ? signed(today.gain) : '–');
  cell('sur les 7 derniers jours', week.length ? signed(week.reduce((t, r) => t + r.gain, 0)) : '–');
  const last = known[known.length - 1];
  cell(last && last.total ? `cartes possédées sur ${num(last.total)}` : 'cartes possédées', last ? num(last.owned) : '–');
  $('evTitle').textContent = `Nouvelles cartes par jour, ${who}`;
  const box = $('evChart'); box.replaceChildren();
  if (!known.length) { box.append(el('p', 'empty', 'Pas encore de relevé. Le suivi démarre dès qu’un compte est en ligne : le premier jour sert de point de départ, l’évolution apparaît à partir du lendemain.')); $('evTable').replaceChildren(); return; }
  // Graphique en barres : une barre par jour, valeurs négatives sous la ligne de base
  const W = 760, H = 260, L = 40, R = 8, T = 12, B = 28;
  const hi = niceMax(Math.max(1, ...known.map((r) => r.gain))), lo = Math.min(0, ...known.map((r) => r.gain));
  const loN = lo < 0 ? -niceMax(-lo) : 0;
  const y = (v) => T + (H - T - B) * (1 - (v - loN) / (hi - loN));
  const step = (W - L - R) / rows.length, bw = Math.max(2, Math.min(28, step - 2));
  const svg = SVG('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Nouvelles cartes par jour pour ${who}, sur ${rows.length} jours. Les chiffres sont dans le tableau sous le graphique.` });
  for (const v of [...new Set([loN, 0, hi / 2, hi])]) {
    svg.append(SVG('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
    svg.append(SVG('text', { x: L - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, num(v)));
  }
  const every = Math.ceil(rows.length / 10);
  const tip = el('div', 'chart-tip'); tip.hidden = true;
  const show = (r, cx) => {
    tip.replaceChildren(el('b', null, r.gain == null ? 'Pas de relevé' : `${signed(r.gain)} nouvelle${Math.abs(r.gain) > 1 ? 's' : ''} carte${Math.abs(r.gain) > 1 ? 's' : ''}`), el('span', null, dayLabel(r.day, true)), ...(r.gain != null ? [el('span', null, `${num(r.owned)} possédées`)] : []));
    tip.hidden = false;
    tip.style.left = `${Math.max(12, Math.min(88, (cx / W) * 100))}%`;
  };
  rows.forEach((r, i) => {
    const cx = L + step * i + step / 2;
    if (i % every === 0 || i === rows.length - 1) svg.append(SVG('text', { x: cx, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, dayLabel(r.day)));
    if (r.gain) {
      const y0 = y(0), y1 = y(r.gain), top = Math.min(y0, y1), h = Math.max(2, Math.abs(y1 - y0)), rad = Math.min(4, bw / 2, h);
      const x = cx - bw / 2;
      // Extrémité arrondie côté valeur, pied droit sur la ligne de base
      const dPath = r.gain > 0
        ? `M${x},${y0}V${top + rad}Q${x},${top} ${x + rad},${top}H${x + bw - rad}Q${x + bw},${top} ${x + bw},${top + rad}V${y0}Z`
        : `M${x},${y0}V${top + h - rad}Q${x},${top + h} ${x + rad},${top + h}H${x + bw - rad}Q${x + bw},${top + h} ${x + bw},${top + h - rad}V${y0}Z`;
      svg.append(SVG('path', { d: dPath, class: r.gain > 0 ? 'bar' : 'bar neg' }));
    }
    // Zone de survol sur toute la hauteur du jour (plus large que la barre), atteignable au clavier
    const hit = SVG('rect', { x: L + step * i, y: T, width: step, height: H - T - B, class: 'hit', tabindex: '0', 'aria-label': `${dayLabel(r.day, true)} : ${r.gain == null ? 'pas de relevé' : `${signed(r.gain)} nouvelles cartes, ${num(r.owned)} possédées`}` });
    hit.addEventListener('mouseenter', () => show(r, cx)); hit.addEventListener('focus', () => show(r, cx));
    hit.addEventListener('mouseleave', () => { tip.hidden = true; }); hit.addEventListener('blur', () => { tip.hidden = true; });
    svg.append(hit);
  });
  const inner = el('div', 'chart-in'); inner.append(svg, tip); // largeur minimale : sur téléphone le graphique défile au lieu de rétrécir
  box.append(inner);
  requestAnimationFrame(() => { box.scrollLeft = box.scrollWidth; }); // les jours récents d'abord
  // Tableau des mêmes chiffres
  const table = el('table', 'ch-table');
  const head = el('tr'); for (const [t, cls] of [['Jour', ''], ['Nouvelles cartes', 'num'], ['Cartes possédées', 'num']]) { const th = el('th', cls, t); th.scope = 'col'; head.append(th); }
  const thead = el('thead'); thead.append(head);
  const tbody = el('tbody');
  for (const r of known.slice().reverse()) { const tr = el('tr'); const th = el('th', 'ch-name', dayLabel(r.day, true)); th.scope = 'row'; tr.append(th, el('td', 'num', signed(r.gain)), el('td', 'num', num(r.owned))); tr.querySelectorAll('td.num')[0].dataset.label = 'Nouvelles'; tr.querySelectorAll('td.num')[1].dataset.label = 'Possédées'; tbody.append(tr); }
  table.append(thead, tbody);
  $('evTable').replaceChildren(table);
}
async function refreshEvolution() {
  if ($('evolution').hidden) return;
  try { renderEvolution(await api('GET', `/api/stats?days=${encodeURIComponent($('evRange').value)}`)); }
  catch (e) { $('evChart').replaceChildren(el('p', 'empty', `Relevé illisible : ${e.message}`)); }
}

let accountsSig = '', accountsAt = 0;
async function refresh(force) {
  if (busy && !force) return;
  try {
    const d = await api('GET', '/api/overview');
    manage = !!d.manage;
    renderAlerts(d.alerts);
    renderSummary(d);
    // Liste des séries (la même pour tous les comptes) : lue une fois sur le premier bot en ligne
    // (relue toutes les 10 min : les favoris changent)
    if (!openSets._any || !openSets._any.length || Date.now() - (openSets.at || 0) > 600000) { const on = d.bots.find((b) => b.online); if (on) { try { openSets._any = await api('GET', `/api/bots/${encodeURIComponent(on.name)}/sets`); openSets.at = Date.now(); } catch {} } }
    const cards = d.bots.map((b) => accountCard(b, d.booster.global));
    const resolved = await Promise.all(cards);
    // Pas de reconstruction pendant qu'un menu ou un champ est utilisé (sinon la liste se referme)
    const typing = document.activeElement && ($('accounts').contains(document.activeElement) || $('toolbar').contains(document.activeElement)) && (document.activeElement.tagName === 'SELECT' || (document.activeElement.tagName === 'INPUT' && /^(text|password)$/.test(document.activeElement.type)));
    // …ni pendant qu'une liste de booster est ouverte
    // Rien n'a changé depuis le dernier affichage : on ne reconstruit pas les cartes (au plus une fois par minute pour les durées affichées)
    const sig = JSON.stringify([d.bots.map((b) => ({ ...b, status: b.status && { ...b.status, at: 0 } })), d.booster, manage, openSets.at]);
    const same = !force && sig === accountsSig && Date.now() - accountsAt < 60000;
    if (!busy && !typing && !same && !document.querySelector('.combo.open')) {
      accountsSig = sig; accountsAt = Date.now();
      $('toolbar').replaceChildren(globalBar(d.booster.global, d.bots), ...(manage ? [addBar()] : []));
      $('accounts').replaceChildren(...(resolved.length ? resolved : [el('p', 'empty', manage ? 'Aucun compte pour le moment. Crée-en un ou ajoute un compte existant avec les boutons ci-dessus.' : 'Aucun bot détecté.')]));
    }
    // Comptes en ligne proposés dans l'onglet Chances (sélection gardée)
    const chSel = $('chBot'), online = d.bots.filter((b) => b.online).map((b) => b.name);
    if ([...chSel.options].map((o) => o.value).join('|') !== online.join('|')) {
      const keep = chSel.value;
      chSel.replaceChildren(...online.map((n) => { const o = el('option', null, n); o.value = n; return o; }));
      if (online.includes(keep)) chSel.value = keep; else if (!$('chances').hidden) refreshChances(false);
    }
    // Comptes proposés dans l'onglet Évolution
    const evSel = $('evBot'), evNames = d.bots.map((b) => b.name);
    if ([...evSel.options].slice(1).map((o) => o.value).join('|') !== evNames.join('|')) {
      const keep = evSel.value;
      evSel.replaceChildren(evSel.options[0], ...evNames.map((n) => { const o = el('option', null, n); o.value = n; return o; }));
      evSel.value = evNames.includes(keep) ? keep : '';
    }
    // Comptes proposés dans le journal : suivent les ajouts et suppressions
    const sel = $('logBot'), names = d.bots.map((b) => b.name);
    if ([...sel.options].slice(1).map((o) => o.value).join('|') !== names.join('|')) {
      const keep = sel.value;
      sel.replaceChildren(sel.options[0], ...names.map((n) => { const o = el('option', null, n); o.value = n; return o; }));
      sel.value = names.includes(keep) ? keep : '';
    }
    $('stamp').textContent = `Mis à jour à ${new Date(d.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    if (!$('logs').hidden) await refreshLogs();
  } catch (e) { $('stamp').textContent = `Erreur : ${e.message}`; }
}
async function refreshLogs(reset) {
  if (reset === true || (reset && reset.type)) logSig = ''; // filtre changé : on redessine
  const q = new URLSearchParams();
  if ($('logBot').value) q.set('bot', $('logBot').value);
  const d = await api('GET', `/api/logs?${q}`);
  const base = $('logWarn').checked ? d.lines.filter((l) => l.level !== 'info') : d.lines;
  renderLogTypes(base);
  const shown = base.filter((l) => logTypes.has(logType(l)));
  $('logCount').textContent = shown.length === base.length ? `${num(shown.length)} ligne${shown.length > 1 ? 's' : ''}` : `${num(shown.length)} sur ${num(base.length)} lignes`;
  renderLogs(shown);
}

const TABS = [...document.querySelectorAll('.tab')];
const HASH = { accounts: '', logs: '#journal', chances: '#chances', evolution: '#evolution' };
function showTab(b, focus) {
  for (const x of TABS) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); x.tabIndex = x === b ? 0 : -1; }
  if (focus) b.focus();
  history.replaceState(null, '', HASH[b.dataset.tab] || location.pathname);
  $('accounts').hidden = b.dataset.tab !== 'accounts';
  $('toolbar').hidden = b.dataset.tab !== 'accounts';
  $('summary').hidden = b.dataset.tab !== 'accounts';
  $('logs').hidden = b.dataset.tab !== 'logs';
  $('chances').hidden = b.dataset.tab !== 'chances';
  $('evolution').hidden = b.dataset.tab !== 'evolution';
  if (b.dataset.tab === 'chances') refreshChances(false);
  if (b.dataset.tab === 'evolution') refreshEvolution();
  if (b.dataset.tab === 'logs') logSig = '';
  refresh(true);
}
for (const b of TABS) {
  b.addEventListener('click', () => showTab(b));
  // Onglets au clavier : ← → Début Fin
  b.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(b);
    const j = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (j >= 0) { e.preventDefault(); showTab(TABS[j], true); }
  });
}
$('logBot').addEventListener('change', () => refreshLogs(true));
$('chBot').addEventListener('change', () => { $('chList').replaceChildren(); refreshChances(false); });
$('chSort').addEventListener('change', () => refreshChances(false));
$('chRefresh').addEventListener('click', () => refreshChances(true));
$('logWarn').addEventListener('change', () => refreshLogs(true));
$('evBot').addEventListener('change', () => refreshEvolution());
$('evRange').addEventListener('change', () => refreshEvolution());
$('logout').addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); location.href = '/login'; });
// Onglet ouvert au chargement : celui de l'adresse (#journal, #chances)
const startTab = TABS.find((b) => HASH[b.dataset.tab] && HASH[b.dataset.tab] === location.hash);
if (startTab) showTab(startTab); else { TABS.forEach((x, i) => { x.tabIndex = i ? -1 : 0; }); refresh(true); }
// Pas d'appels quand la page est en arrière-plan ; mise à jour immédiate au retour
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
setInterval(() => { if (!document.hidden && !$('evolution').hidden) refreshEvolution(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
