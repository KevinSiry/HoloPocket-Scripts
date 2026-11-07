// Interface du panel : tout le texte des données passe par textContent (jamais d'HTML construit à partir du bot).
const SCRIPT_LABELS = {
  'auto-booster': 'Ouverture auto des boosters',
  echanges: 'Échanges auto',
  'vendre-doublons': 'Vente des doublons',
  recyclage: 'Recyclage',
  'achat-revente': 'Achat-revente',
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

let busy = 0; // pause du rafraîchissement pendant une action
let openSets = {};

function stat(label, value, meterVal, meterMax) {
  const d = el('div', 'stat');
  d.append(el('span', 'k', label), el('span', 'v', value));
  if (meterMax) { const m = el('progress'); m.max = meterMax; m.value = meterVal || 0; d.append(m); }
  return d;
}

async function act(card, fn) {
  busy++; card.classList.add('pending');
  try { await fn(); } catch (e) { toast(e.message, true); } finally { busy--; card.classList.remove('pending'); await refresh(true); }
}
function toast(text, bad) {
  const t = el('div', bad ? 'toast bad' : 'toast', text);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

function setOptions(sel, sets) {
  for (const x of sets.filter((x) => !x.promo)) { const o = el('option', null, x.name + (x.favorite ? ' ★' : '')); o.value = x.id; sel.append(o); }
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
  sel.addEventListener('change', () => act(card, () => sendBooster(`/api/bots/${encodeURIComponent(bot.name)}/booster`, sel.value)));
  box.append(el('div', 'row', null));
  box.lastChild.append(sel);
  if (bot.booster.error) box.append(el('p', 'err', `Non appliqué : ${bot.booster.error}`));
  else if (s.booster.mode === 'auto' && s.booster.favorites.length) box.append(el('p', 'muted', `Favoris : ${s.booster.favorites.map((f) => f.name).join(', ')}`));
  return box;
}

function globalCard(globalChoice, bots) {
  const card = el('article', 'card global');
  const sets = openSets._any || [];
  card.append(el('h2', null, 'Booster à ouvrir · tous les comptes'));
  const sel = el('select');
  sel.setAttribute('aria-label', 'Booster global');
  const a = el('option', null, 'Auto (meilleur favori)'); a.value = 'auto';
  sel.append(a);
  setOptions(sel, sets);
  sel.value = toValue(globalChoice);
  const follow = bots.filter((b) => b.booster.choice.mode === 'global').map((b) => b.name);
  sel.addEventListener('change', () => act(card, () => sendBooster('/api/booster/global', sel.value)));
  card.append(sel, el('p', 'muted', follow.length ? `Suivent ce réglage : ${follow.join(', ')}` : 'Aucun compte ne suit ce réglage.'));
  return card;
}

function scriptsBlock(bot, card) {
  const box = el('div', 'block');
  box.append(el('h3', null, 'Scripts'));
  for (const sc of bot.status.scripts) {
    const lab = el('label', 'switch');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = sc.on;
    cb.addEventListener('change', () => act(card, () => api('PUT', `/api/bots/${encodeURIComponent(bot.name)}/config`, { scripts: { [sc.name]: cb.checked } }).then(() => toast(cb.checked ? 'Script activé' : 'Script coupé'))));
    lab.append(cb, el('span', null, SCRIPT_LABELS[sc.name] || sc.name), el('small', 'muted', sc.version ? `v${sc.version}` : ''));
    box.append(lab);
  }
  return box;
}

async function accountCard(bot, globalChoice) {
  const card = el('article', 'card');
  const head = el('div', 'head');
  const s = bot.status;
  head.append(el('h2', null, (s && s.account && s.account.user) || bot.name));
  head.append(el('span', bot.online ? 'pill ok' : 'pill bad', bot.online ? 'En ligne' : 'Hors ligne'));
  card.append(head);
  if (!s) { card.append(el('p', 'muted', 'Aucune donnée pour le moment.')); return card; }
  if (!bot.online) card.append(el('p', 'muted', `Dernier contact : ${ago(bot.lastSeen)}`));
  if (bot.name !== (s.account && s.account.user)) card.append(el('p', 'muted', `Bot « ${bot.name} »`));
  const grid = el('div', 'grid');
  if (s.account) {
    grid.append(stat('Pièces', num(s.account.balance)));
    grid.append(stat('Énergie', `${num(s.account.energy.stock)} / ${num(s.account.energy.max)}`, s.account.energy.stock, s.account.energy.max));
  } else grid.append(stat('Session', 'perdue'));
  grid.append(stat('Échanges', `${num(s.trades.open)} / ${s.trades.max}`, s.trades.open, s.trades.max));
  grid.append(stat('En vente', `${num(s.sales.selling)} / ${num(s.sales.max)}`, s.sales.selling, s.sales.max));
  card.append(grid);
  if (bot.online) {
    card.append(boosterBlock(bot, card, globalChoice), scriptsBlock(bot, card));
    const r = el('button', 'ghost', 'Redémarrer le bot');
    r.addEventListener('click', () => { if (confirm(`Redémarrer le bot ${bot.name} ?`)) act(card, () => api('POST', `/api/bots/${encodeURIComponent(bot.name)}/restart`).then(() => toast('Redémarrage demandé'))); });
    card.append(r);
  }
  return card;
}

function renderAlerts(alerts) {
  const box = $('alerts');
  box.replaceChildren();
  for (const a of alerts) box.append(el('div', `alert ${a.level}`, `${a.bot} · ${a.text}`));
}

function renderLogs(lines) {
  const ol = $('logList');
  ol.replaceChildren();
  for (const l of lines.slice().reverse()) {
    const li = el('li', l.level);
    li.append(el('time', 'muted', new Date(l.at).toLocaleTimeString('fr-FR')), el('b', null, l.bot), el('span', null, l.text));
    ol.append(li);
  }
  if (!lines.length) ol.append(el('li', 'muted', 'Aucune ligne.'));
}

async function refresh(force) {
  if (busy && !force) return;
  try {
    const d = await api('GET', '/api/overview');
    renderAlerts(d.alerts);
    // Liste des séries (la même pour tous les comptes) : lue une fois sur le premier bot en ligne
    if (!openSets._any || !openSets._any.length) { const on = d.bots.find((b) => b.online); if (on) { try { openSets._any = await api('GET', `/api/bots/${encodeURIComponent(on.name)}/sets`); } catch {} } }
    const cards = d.bots.map((b) => accountCard(b, d.booster.global));
    const resolved = await Promise.all(cards);
    if (!busy) $('accounts').replaceChildren(globalCard(d.booster.global, d.bots), ...resolved);
    const sel = $('logBot');
    if (sel.options.length === 1) for (const b of d.bots) { const o = el('option', null, b.name); o.value = b.name; sel.append(o); }
    $('stamp').textContent = `Mis à jour ${new Date(d.at).toLocaleTimeString('fr-FR')}`;
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
  for (const x of document.querySelectorAll('.tab')) x.classList.toggle('on', x === b);
  $('accounts').hidden = b.dataset.tab !== 'accounts';
  $('logs').hidden = b.dataset.tab !== 'logs';
  refresh(true);
});
$('logBot').addEventListener('change', refreshLogs);
$('logWarn').addEventListener('change', refreshLogs);
$('logout').addEventListener('click', async () => { await api('POST', '/api/logout').catch(() => {}); location.href = '/login'; });
refresh(true);
setInterval(refresh, 5000);
