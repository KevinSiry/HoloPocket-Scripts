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
  $('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 8000 : 4000);
}

// Séries proposées dans la liste du booster (hors promos), favoris marqués ★
const setChoices = (sets) => sets.filter((x) => !x.promo).map((x) => ({ value: `set:${x.id}`, label: x.name + (x.favorite ? ' ★' : ''), search: `${x.name} ${x.id}` }));
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
  const showCur = () => { const c = all.find((x) => x.value === value); cur.textContent = c ? c.label : value; };
  const setActive = (i) => {
    active = i;
    [...list.children].forEach((li, k) => { li.classList.toggle('active', k === i); li.setAttribute('aria-selected', String(k === i)); });
    const li = list.children[i];
    if (li) { q.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); } else q.removeAttribute('aria-activedescendant');
  };
  const render = (onCurrent) => {
    const t = fold_(q.value.trim());
    shown = t ? all.filter((c) => fold_(c.search || c.label).includes(t)) : all;
    list.replaceChildren(...shown.map((c, k) => {
      const li = el('li', c.value === value ? 'cur' : null, c.label);
      li.id = `${id}-o${k}`; li.setAttribute('role', 'option');
      li.addEventListener('mousedown', (e) => e.preventDefault()); // garde le focus dans la recherche
      li.addEventListener('click', () => pick(c));
      li.addEventListener('mousemove', () => { if (active !== k) setActive(k); });
      return li;
    }));
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
const describe = (c, sets) => (c.mode === 'fixed' ? (sets.find((x) => x.id === c.setId) || { name: c.setId }).name : 'Auto (meilleur favori)');
// valeur du <select> <-> choix
const toValue = (c) => (c.mode === 'global' ? 'global' : c.mode === 'auto' ? 'auto' : `set:${c.setId}`);
const fromValue = (v) => (v === 'global' ? { mode: 'global' } : v === 'auto' ? { mode: 'auto' } : { mode: 'fixed', setId: v.slice(4) });
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
    pinned: [{ value: 'global', label: `Global : ${describe(globalChoice, sets)}` }, { value: 'auto', label: 'Auto (meilleur favori)' }],
    choices: setChoices(sets),
    onChange: (v) => act(card, () => sendBooster(`/api/bots/${encodeURIComponent(bot.name)}/booster`, v)),
  });
  box.append(el('div', 'row', null));
  box.lastChild.append(sel);
  if (bot.booster.error) box.append(el('p', 'err', `Non appliqué : ${bot.booster.error}`));
  else if (s.booster.mode === 'auto' && s.booster.favorites.length) box.append(el('p', 'muted', `Favoris : ${s.booster.favorites.map((f) => f.name).join(', ')}`));
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
    pinned: [{ value: 'auto', label: 'Auto (meilleur favori)' }],
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
  const choice = bot.booster.choice.mode === 'global' ? 'booster global' : bot.booster.choice.mode === 'auto' ? 'booster auto' : 'booster fixe';
  card.append(fold(bot.name, bot.booster.error ? 'Réglages (booster non appliqué)' : `Réglages, ${choice}`, ...parts));
  return card;
}

function renderAlerts(alerts) {
  const box = $('alerts');
  box.replaceChildren();
  for (const a of alerts) {
    const row = el('div', `alert ${a.level}`);
    const x = el('button', 'alert-x', '×');
    x.type = 'button'; x.title = 'Fermer cette alerte'; x.setAttribute('aria-label', 'Fermer cette alerte');
    x.addEventListener('click', () => { row.remove(); api('POST', '/api/alerts/dismiss', { key: a.key }).catch(() => {}); });
    const msg = el('span', null);
    msg.append(el('b', null, a.bot), ` ${a.text} `, profileLink(a.bot, 'profile inline-link'));
    row.append(msg, x);
    box.append(row);
  }
  if (alerts.length > 1) {
    const all = el('button', 'ghost small dismiss-all', 'Tout fermer');
    all.type = 'button';
    all.addEventListener('click', () => { box.replaceChildren(); api('POST', '/api/alerts/dismiss', { all: true, keys: alerts.map((a) => a.key) }).catch(() => {}); });
    box.append(all);
  }
}

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
  cell(n > 1 ? 'alertes' : 'alerte', String(n), n > 0);
}

function renderLogs(lines) {
  const ol = $('logList');
  ol.replaceChildren();
  for (const l of lines.slice().reverse()) {
    const li = el('li', l.level);
    const lvl = l.level === 'error' ? 'Erreur' : l.level === 'warn' ? 'Alerte' : '';
    li.append(el('time', 'muted', new Date(l.at).toLocaleTimeString('fr-FR')), el('b', null, l.bot), ...(lvl ? [el('span', 'lvl', lvl)] : []), el('span', null, l.text));
    ol.append(li);
  }
  if (!lines.length) ol.append(el('li', 'muted', 'Aucune ligne.'));
}

async function refresh(force) {
  if (busy && !force) return;
  try {
    const d = await api('GET', '/api/overview');
    manage = !!d.manage;
    renderAlerts(d.alerts);
    renderSummary(d);
    // Liste des séries (la même pour tous les comptes) : lue une fois sur le premier bot en ligne
    if (!openSets._any || !openSets._any.length) { const on = d.bots.find((b) => b.online); if (on) { try { openSets._any = await api('GET', `/api/bots/${encodeURIComponent(on.name)}/sets`); } catch {} } }
    const cards = d.bots.map((b) => accountCard(b, d.booster.global));
    const resolved = await Promise.all(cards);
    // Pas de reconstruction pendant qu'un menu ou un champ est utilisé (sinon la liste se referme)
    const typing = document.activeElement && ($('accounts').contains(document.activeElement) || $('toolbar').contains(document.activeElement)) && (document.activeElement.tagName === 'SELECT' || (document.activeElement.tagName === 'INPUT' && /^(text|password)$/.test(document.activeElement.type)));
    // …ni pendant qu'une liste de booster est ouverte
    if (!busy && !typing && !document.querySelector('.combo.open')) {
      $('toolbar').replaceChildren(globalBar(d.booster.global, d.bots), ...(manage ? [addBar()] : []));
      $('accounts').replaceChildren(...(resolved.length ? resolved : [el('p', 'empty', manage ? 'Aucun compte pour le moment. Crée-en un ou ajoute un compte existant avec les boutons ci-dessus.' : 'Aucun bot détecté.')]));
    }
    const sel = $('logBot');
    if (sel.options.length === 1) for (const b of d.bots) { const o = el('option', null, b.name); o.value = b.name; sel.append(o); }
    $('stamp').textContent = `Mis à jour à ${new Date(d.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    if (!$('logs').hidden) await refreshLogs();
  } catch (e) { $('stamp').textContent = `Erreur : ${e.message}`; }
}
async function refreshLogs() {
  const q = new URLSearchParams();
  if ($('logBot').value) q.set('bot', $('logBot').value);
  const d = await api('GET', `/api/logs?${q}`);
  renderLogs($('logWarn').checked ? d.lines.filter((l) => l.level !== 'info') : d.lines);
}

for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => {
  for (const x of document.querySelectorAll('.tab')) { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); }
  $('accounts').hidden = b.dataset.tab !== 'accounts';
  $('toolbar').hidden = b.dataset.tab !== 'accounts';
  $('summary').hidden = b.dataset.tab !== 'accounts';
  $('logs').hidden = b.dataset.tab !== 'logs';
  refresh(true);
});
$('logBot').addEventListener('change', refreshLogs);
$('logWarn').addEventListener('change', refreshLogs);
$('logout').addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); location.href = '/login'; });
refresh(true);
setInterval(refresh, 5000);
