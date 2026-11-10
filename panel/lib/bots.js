// Liste des bots et appels à leur API interne ; garde le dernier état connu quand un bot ne répond plus.
function parseBots(str) {
  const out = [];
  for (const part of String(str || '').split(',')) {
    const i = part.indexOf('=');
    const name = part.slice(0, i).trim();
    const url = part.slice(i + 1).trim().replace(/\/+$/, '');
    if (i > 0 && name && /^https?:\/\//.test(url)) out.push({ name, url });
  }
  return out;
}

function createBots({ bots, token, fetchFn = fetch, timeoutMs = 3000, now = Date.now }) {
  // `bots` : liste fixe, ou fonction qui renvoie la liste à jour (comptes ajoutés depuis le panel)
  const getList = typeof bots === 'function' ? bots : () => bots;
  const known = new Map();
  const entry = (b) => {
    if (!known.has(b.name)) known.set(b.name, { name: b.name, online: false, lastSeen: null, status: null, error: null, logs: [], lastLog: 0 });
    return known.get(b.name);
  };
  const call = async (b, method, path, body) => {
    const r = await fetchFn(b.url + path, {
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return data;
  };
  const find = (name) => getList().find((b) => b.name === name);

  async function refresh(b) {
    const k = entry(b);
    try {
      k.status = await call(b, 'GET', '/status');
      k.online = true; k.error = null;
      k.lastSeen = now();
    } catch (e) { k.online = false; k.error = e.status === 503 ? e.message : null; }
    // Le journal se lit même quand le compte est arrêté : c'est lui qui dit pourquoi
    const l = await call(b, 'GET', `/logs?after=${k.lastLog}&limit=200`).catch(() => null);
    if (l) {
      // Le bot a redémarré : ses identifiants repartent de 1
      if (l.last < k.lastLog) { k.logs = []; k.lastLog = 0; return refresh(b); }
      k.logs = k.logs.concat(l.lines).slice(-500);
      k.lastLog = l.last;
    }
  }
  return {
    names: () => getList().map((b) => b.name),
    has: (name) => !!find(name),
    async refreshAll() {
      const list = getList();
      for (const n of [...known.keys()]) if (!list.some((b) => b.name === n)) known.delete(n);
      await Promise.all(list.map(refresh));
      return list.map((b) => known.get(b.name));
    },
    get: (name) => known.get(name),
    sets: (name) => call(find(name), 'GET', '/sets'),
    chances: (name, fresh) => call(find(name), 'GET', `/chances${fresh ? '?fresh=1' : ''}`),
    config: (name, patch) => call(find(name), 'PUT', '/config', patch),
    restart: (name) => call(find(name), 'POST', '/restart'),
  };
}

module.exports = { parseBots, createBots };
