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
  const known = new Map(bots.map((b) => [b.name, { name: b.name, online: false, lastSeen: null, status: null, logs: [], lastLog: 0 }]));
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
  const find = (name) => bots.find((b) => b.name === name);

  async function refresh(b) {
    const k = known.get(b.name);
    try {
      k.status = await call(b, 'GET', '/status');
      k.online = true;
      k.lastSeen = now();
      const l = await call(b, 'GET', `/logs?after=${k.lastLog}&limit=200`).catch(() => null);
      if (l) {
        // Le bot a redémarré : ses identifiants repartent de 1
        if (l.last < k.lastLog) { k.logs = []; k.lastLog = 0; return refresh(b); }
        k.logs = k.logs.concat(l.lines).slice(-500);
        k.lastLog = l.last;
      }
    } catch { k.online = false; }
  }
  return {
    names: () => bots.map((b) => b.name),
    has: (name) => !!find(name),
    async refreshAll() { await Promise.all(bots.map(refresh)); return [...known.values()]; },
    get: (name) => known.get(name),
    sets: (name) => call(find(name), 'GET', '/sets'),
    config: (name, patch) => call(find(name), 'PUT', '/config', patch),
    restart: (name) => call(find(name), 'POST', '/restart'),
  };
}

module.exports = { parseBots, createBots };
