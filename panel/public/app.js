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

// Pastille compacte : intitulé, valeur, jauge fine facultative
function stat(label, value, meterVal, meterMax) {
  const d = el('div', 'stat');
  d.append(el('span', 'k', label), el('span', 'v', value));
  if (meterMax) { const m = el('progress'); m.max = meterMax; m.value = meterVal || 0; d.append(m); }
  return d;
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

function setOptions(sel, sets) {
  for (const x of sets.filter((x) => !x.promo)) { const o = el('option', null, x.name + (x.favorite ? ' ★' : '')); o.value = `set:${x.id}`; sel.append(o); }
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
  const sel = el('select');
  sel.setAttribute('aria-label', `Booster du compte ${bot.name}`);
  const g = el('option', null, `Global : ${describe(globalChoice, sets)}`); g.value = 'global';
  const a = el('option', null, 'Auto (meilleur favori)'); a.value = 'auto';
  sel.append(g, a);
  setOptions(sel, sets);
  sel.value = toValue(bot.booster.choice);
  sel.addEventListener('change', () => { sel.blur(); act(card, () => sendBooster(`/api/bots/${encodeURIComponent(bot.name)}/booster`, sel.value)); });
  box.append(el('div', 'row', null));
  box.lastChild.append(sel);
  if (bot.booster.error) box.append(el('p', 'err', `Non appliqué : ${bot.booster.error}`));
  else if (s.booster.mode === 'auto' && s.booster.favorites.length) box.append(el('p', 'muted', `Favoris : ${s.booster.favorites.map((f) => f.name).join(', ')}`));
  return box;
}

function globalBar(globalChoice, bots) {
  const bar = el('div', 'bar-item');
  const sets = openSets._any || [];
  const lab = el('label', 'inline');
  lab.append(el('span', 'k', 'Booster de tous les comptes'));
  const sel = el('select');
  sel.setAttribute('aria-label', 'Booster global');
  const a = el('option', null, 'Auto (meilleur favori)'); a.value = 'auto';
  sel.append(a);
  setOptions(sel, sets);
  sel.value = toValue(globalChoice);
  const follow = bots.filter((b) => b.booster.choice.mode === 'global').length;
  sel.addEventListener('change', () => { sel.blur(); act(bar, () => sendBooster('/api/booster/global', sel.value)); });
  lab.append(sel);
  bar.append(lab, el('span', 'muted', `${follow} compte${follow > 1 ? 's' : ''} le suivent`));
  return bar;
}

function scriptsBlock(bot, card) {
  const box = el('div', 'block');
  box.append(el('h3', null, 'Scripts'));
  for (const sc of bot.status.scripts) {
    const lab = el('label', 'switch');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = sc.on;
    cb.addEventListener('change', () => { cb.blur(); act(card, () => api('PUT', `/api/bots/${encodeURIComponent(bot.name)}/config`, { scripts: { [sc.name]: cb.checked } }).then(() => toast(cb.checked ? 'Script activé' : 'Script coupé'))); });
    lab.append(cb, el('span', null, SCRIPT_LABELS[sc.name] || sc.name), el('small', 'muted', sc.version ? `v${sc.version}` : ''));
    box.append(lab);
  }
  return box;
}

const acc = (bot) => `/api/accounts/${encodeURIComponent(bot.name)}`;
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
function flipBlock(f) {
  const box = el('div', 'block');
  box.append(el('h3', null, 'Achat-revente'));
  box.append(el('p', 'muted line', `Dernier passage : ${ago(f.lastPassAt)}${f.error ? ` · erreur : ${f.error}` : ''}`));
  box.append(el('p', 'muted line', `Enchères suivies ${f.bids} · à revendre ${f.toResell}${f.waiting ? ` (${f.waiting} en attente d'une place)` : ''} · achats ${f.bought} · ventes ${f.sold} · bénéfice ${f.profit >= 0 ? '+' : ''}${num(f.profit)}`));
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
  const card = el('article', bot.disabled ? 'card off' : 'card');
  const head = el('div', 'head');
  const s = bot.status;
  const pseudo = (s && s.account && s.account.user) || bot.name;
  const title = el('div', 'title');
  title.append(el('h2', null, pseudo), profileLink(pseudo));
  head.append(title);
  head.append(el('span', bot.disabled ? 'pill off' : bot.online ? 'pill ok' : 'pill bad', bot.disabled ? 'Désactivé' : bot.online ? 'En ligne' : 'Hors ligne'));
  card.append(head);
  if (bot.disabled) { card.append(el('p', 'muted', 'Ce compte ne tourne pas.')); if (manage) card.append(fold(bot.name, 'Gérer', manageBlock(bot, card))); return card; }
  if (!s) {
    card.append(el('p', 'muted', bot.error || 'Démarrage en cours…'));
    if (manage) card.append(fold(bot.name, 'Gérer', manageBlock(bot, card)));
    return card;
  }
  if (!bot.online) card.append(el('p', 'muted', bot.error || `Dernier contact : ${ago(bot.lastSeen)}`));
  if (!manage && bot.name !== (s.account && s.account.user)) card.append(el('p', 'muted', `Bot « ${bot.name} »`));
  const grid = el('div', 'grid');
  if (s.account) {
    grid.append(stat('Pièces', num(s.account.balance)));
    grid.append(stat('Énergie', `${num(s.account.energy.stock)}/${num(s.account.energy.max)}`, s.account.energy.stock, s.account.energy.max));
  } else grid.append(stat('Session', 'perdue'));
  grid.append(stat('Échanges', `${num(s.trades.open)}/${s.trades.max}`, s.trades.open, s.trades.max));
  grid.append(stat('Ventes', `${num(s.sales.selling)}/${num(s.sales.max)}`, s.sales.selling, s.sales.max));
  card.append(grid);
  // Un résumé du booster et des scripts reste visible ; le détail se déplie
  const on = s.scripts.filter((x) => x.on).length;
  const choice = bot.booster.choice.mode === 'global' ? 'global' : bot.booster.choice.mode === 'auto' ? 'auto' : 'série fixe';
  card.append(el('p', 'muted line', `Booster ${choice} · ${on}/${s.scripts.length} scripts${bot.booster.error ? ' · booster non appliqué' : ''}`));
  if (bot.online) {
    const r = el('button', 'ghost small', 'Redémarrer');
    r.addEventListener('click', async () => { if (await confirmBox(`Redémarrer ${bot.name} ?`, 'Le navigateur du compte est relancé et les scripts sont retéléchargés.', 'Redémarrer')) act(card, () => api('POST', `/api/bots/${encodeURIComponent(bot.name)}/restart`).then(() => toast('Redémarrage demandé'))); });
    const parts = [boosterBlock(bot, card, globalChoice), scriptsBlock(bot, card)];
    if (s.flip && s.scripts.some((x) => x.name === 'achat-revente' && x.on)) parts.push(flipBlock(s.flip));
    if (manage) parts.push(manageBlock(bot, card));
    parts.push(r);
    card.append(fold(bot.name, 'Réglages', ...parts));
  } else if (manage) card.append(fold(bot.name, 'Gérer', manageBlock(bot, card)));
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
    msg.append(el('b', null, a.bot), ` · ${a.text} `, profileLink(a.bot, 'profile inline-link'));
    row.append(msg, x);
    box.append(row);
  }
  if (alerts.length > 1) {
    const all = el('button', 'ghost small', 'Tout fermer');
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
  box.replaceChildren();
  const chip = (k, v, cls) => { const c = el('div', `chip ${cls || ''}`); c.append(el('span', 'k', k), el('b', null, v)); box.append(c); };
  chip('Comptes en ligne', `${online}/${live.length}`, live.length && online < live.length ? 'warnc' : '');
  chip('Pièces au total', num(coins));
  chip('Échanges ouverts', num(trades));
  const n = d.alerts.length;
  chip('Alertes', String(n), n ? 'warnc' : '');
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
    if (!busy && !typing) {
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
