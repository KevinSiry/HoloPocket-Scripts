// Flotte : tous les comptes du panel dans un seul conteneur, un Chromium par compte.
// La liste des comptes (et leurs identifiants) vient du panel ; un compte qui échoue est relancé seul, avec attente croissante.
const http = require('http');
const path = require('path');
const { createLogBuffer } = require('./log-buffer');
const { createPanelHandler, sameToken, readBody } = require('./panel-api');

const MIN_WAIT = 30000;
const MAX_WAIT = 30 * 60000;
const safeDir = (u) => String(u).toLowerCase().replace(/[^a-z0-9_-]/g, '_');

function createFleet(o) {
  const { env, root, token, panelUrl, start, makeConfig, register, fetchFn = fetch, now = Date.now } = o;
  const entries = new Map(); // pseudo (minuscules) -> état
  const key = (u) => String(u).toLowerCase();
  let startChain = Promise.resolve(); // les Chromium démarrent un par un (pic de mémoire)
  let usernames = [];
  const ts = () => new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  async function launch(e) {
    e.state = 'starting'; e.error = null;
    const logL = (level, ...a) => { console.log(ts(), '·', `[${e.username}]`, ...a); e.logs.push(level, a.map(String).join(' ')); };
    const run = startChain.then(async () => {
      if (e.removed) return;
      try {
        const cfg = makeConfig({ env, username: e.username, password: e.password, allAccounts: usernames });
        const handle = await start({
          cfg, env, profileDir: path.join(root, 'profile', safeDir(e.username)), logs: e.logs, logL, name: e.username,
          onFatal: (reason) => { fail(e, reason); },
        });
        if (e.removed) { await handle.stop(); return; }
        e.handle = handle; e.state = 'running'; e.wait = MIN_WAIT; e.failedBefore = false; e.nextTryAt = 0;
        e.api = createPanelHandler({ token, logs: e.logs, status: handle.status, sets: handle.sets, chances: handle.chances, applyConfig: handle.applyConfig, restart: () => restart(e.username) });
      } catch (err) { fail(e, err.message, err.retryAfterMs); }
    });
    startChain = run.catch(() => {});
    return run;
  }
  async function fail(e, reason, retryAfterMs) {
    const h = e.handle; e.handle = null; e.api = null;
    if (h) await h.stop().catch(() => {});
    e.state = 'error'; e.error = reason;
    e.wait = Math.min(MAX_WAIT, Math.max(retryAfterMs || 0, (e.wait || MIN_WAIT) * (e.failedBefore ? 2 : 1)));
    e.failedBefore = true;
    e.nextTryAt = now() + e.wait;
    e.logs.push('error', `Compte arrêté : ${reason}. Nouvel essai dans ${Math.round(e.wait / 60000 * 10) / 10} min.`);
    console.log(ts(), '·', `[${e.username}]`, 'Arrêté :', reason);
  }
  async function stopEntry(e) {
    e.removed = true;
    const h = e.handle; e.handle = null; e.api = null;
    if (h) await h.stop().catch(() => {});
  }
  async function restart(username) {
    const e = entries.get(key(username));
    if (!e) return;
    const h = e.handle; e.handle = null; e.api = null;
    if (h) await h.stop().catch(() => {});
    e.wait = MIN_WAIT; e.failedBefore = false;
    return launch(e);
  }

  // Aligne les comptes lancés sur la liste du panel
  async function sync() {
    let list;
    try {
      const r = await fetchFn(`${panelUrl}/internal/fleet`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      list = (await r.json()).accounts;
    } catch (err) { console.log(ts(), '· Panel injoignable, comptes inchangés :', err.message); return false; }
    const want = new Map(list.filter((a) => a.enabled !== false).map((a) => [key(a.username), a]));
    for (const [k, e] of entries) if (!want.has(k)) { await stopEntry(e); entries.delete(k); console.log(ts(), '· Compte retiré :', e.username); }
    for (const [k, a] of want) {
      const e = entries.get(k);
      if (!e) {
        const ne = { username: a.username, password: a.password, logs: createLogBuffer(500), state: 'starting', wait: MIN_WAIT, nextTryAt: 0 };
        entries.set(k, ne);
        console.log(ts(), '· Compte ajouté :', a.username);
        launch(ne);
      } else if (e.password !== a.password) { e.password = a.password; restart(a.username); }
    }
    usernames = [...want.values()].map((a) => a.username);
    for (const e of entries.values()) if (e.handle) e.handle.refreshAccounts(usernames).catch((err) => console.log(ts(), `· [${e.username}]`, 'Exclusions non mises à jour :', err.message));
    return true;
  }
  // Relance les comptes en attente quand leur délai est passé
  function retryDue() { for (const e of entries.values()) if (e.state === 'error' && now() >= e.nextTryAt) launch(e); }

  let regChain = Promise.resolve();
  const registerSerial = (body) => { const r = regChain.then(() => register(body)); regChain = r.catch(() => {}); return r; };

  const json = (res, status, body) => { const d = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(d), 'Cache-Control': 'no-store' }); res.end(d); };
  async function handler(req, res) {
    try {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m || !sameToken(m[1], token)) return json(res, 401, { error: 'non autorisé' });
      const url = new URL(req.url, 'http://fleet');
      if (req.method === 'GET' && url.pathname === '/accounts') return json(res, 200, [...entries.values()].map((e) => ({ name: e.username, state: e.state, error: e.error || null })));
      if (req.method === 'POST' && url.pathname === '/sync') return json(res, 200, { ok: await sync() });
      if (req.method === 'POST' && url.pathname === '/register') {
        let body; try { body = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; return json(res, 400, { error: 'JSON invalide' }); }
        if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') return json(res, 400, { error: 'username et password attendus' });
        return json(res, 200, await registerSerial({ username: body.username, password: body.password }));
      }
      const a = /^\/accounts\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (a) {
        const e = entries.get(key(decodeURIComponent(a[1])));
        if (!e) return json(res, 404, { error: 'compte inconnu' });
        // Le journal reste lisible même si le compte est arrêté : c'est là qu'on voit pourquoi
        if (req.method === 'GET' && a[2] === '/logs') {
          const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
          const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
          return json(res, 200, e.logs.since(after, limit));
        }
        if (!e.api) return json(res, 503, { error: e.error || 'démarrage en cours', state: e.state });
        req.url = a[2] + url.search;
        return e.api(req, res);
      }
      return json(res, 404, { error: 'introuvable' });
    } catch (e) { return json(res, e.status || 500, { error: e.message || 'erreur' }); }
  }

  return {
    handler, sync, retryDue, restart,
    entries: () => entries,
    server: () => http.createServer(handler),
    async stopAll() { for (const e of entries.values()) await stopEntry(e); },
  };
}

module.exports = { createFleet, safeDir };
