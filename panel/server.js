// Panel de gestion des comptes HoloPocket : un seul mot de passe, une API interne par bot.
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./lib/auth');
const { parseBots, createBots } = require('./lib/bots');
const { computeAlerts } = require('./lib/alerts');
const { createStore, createReconciler } = require('./lib/booster');

const SESSION_MS = 12 * 3600000;
const PUBLIC = path.join(__dirname, 'public');
const STATIC = { '/style.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/login.js': 'text/javascript; charset=utf-8', '/login': 'text/html; charset=utf-8' };
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
};

function createApp(opts) {
  const { passwordHash, secret, bots, trustProxy = false, secureCookie = true, now = Date.now } = opts;
  const store = opts.store || createStore(null);
  const rec = opts.reconciler || createReconciler({ store, push: (n, p) => bots.config(n, p) });
  const throttle = opts.throttle || auth.createThrottle({ now });
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(data), ...extra });
    res.end(data);
  };
  const ipOf = (req) => {
    if (trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); if (x) return x; }
    return req.socket.remoteAddress || '?';
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 8192) { reject(Object.assign(new Error('corps trop volumineux'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const loggedIn = (req) => auth.verifySession(secret, auth.parseCookies(req.headers.cookie).hp_panel, now());
  const cookie = (v, maxAge) => `hp_panel=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://panel');
      const p = url.pathname;
      if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');

      if (req.method === 'GET' && STATIC[p]) {
        const f = p === '/login' ? 'login.html' : p.slice(1);
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, f), 'utf8'), STATIC[p]);
      }
      if (req.method === 'GET' && p === '/') {
        if (!loggedIn(req)) return send(res, 302, '', 'text/plain', { Location: '/login' });
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      }

      // Toute modification exige l'en-tête X-Panel (un formulaire venu d'un autre site ne peut pas l'ajouter)
      if (req.method !== 'GET' && req.headers['x-panel'] !== '1') return send(res, 403, { error: 'requête refusée' });

      if (req.method === 'POST' && p === '/api/login') {
        const ip = ipOf(req);
        const wait = throttle.retryAfterMs(ip);
        if (wait > 0) return send(res, 429, { error: 'Trop d’essais. Réessaie plus tard.' }, undefined, { 'Retry-After': String(Math.ceil(wait / 1000)) });
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; }
        if (!auth.verifyPassword(body.password, passwordHash)) { throttle.fail(ip); return send(res, 401, { error: 'Mot de passe incorrect.' }); }
        throttle.reset(ip);
        return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie(auth.createSession(secret, SESSION_MS, now()), SESSION_MS / 1000) });
      }
      if (req.method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('', 0) });

      if (!p.startsWith('/api/')) return send(res, 404, { error: 'introuvable' });
      if (!loggedIn(req)) return send(res, 401, { error: 'non connecté' });

      if (req.method === 'GET' && p === '/api/overview') {
        const list = await bots.refreshAll();
        await rec.run(list);
        const errs = rec.errors();
        return send(res, 200, {
          at: new Date(now()).toISOString(),
          booster: { global: store.global() },
          bots: list.map((b) => ({ name: b.name, online: b.online, lastSeen: b.lastSeen ? new Date(b.lastSeen).toISOString() : null, status: b.status, booster: { choice: store.choice(b.name), error: errs[b.name] || null } })),
          alerts: computeAlerts(list, now()),
        });
      }
      if (req.method === 'GET' && p === '/api/logs') {
        const name = url.searchParams.get('bot');
        const all = bots.names().flatMap((n) => (name && name !== n ? [] : (bots.get(n).logs || []).map((l) => ({ ...l, bot: n }))));
        all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
        const level = url.searchParams.get('level');
        return send(res, 200, { lines: all.filter((l) => !level || l.level === level).slice(-300) });
      }
      // Booster : réglage global et choix par compte (c'est le panel qui l'envoie aux bots)
      const okChoice = (v, allowGlobal) => v && typeof v === 'object' && (v.mode === 'auto' || (allowGlobal && v.mode === 'global') || (v.mode === 'fixed' && typeof v.setId === 'string' && v.setId.trim()));
      if (req.method === 'PUT' && (p === '/api/booster/global' || /^\/api\/bots\/[^/]+\/booster$/.test(p))) {
        let v; try { v = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; return send(res, 400, { error: 'JSON invalide' }); }
        const isGlobal = p === '/api/booster/global';
        const name = isGlobal ? null : decodeURIComponent(p.split('/')[3]);
        if (!isGlobal && !bots.has(name)) return send(res, 404, { error: 'compte inconnu' });
        if (!okChoice(v, !isGlobal)) return send(res, 400, { error: 'réglage de booster invalide' });
        if (isGlobal) store.setGlobal(v); else store.setChoice(name, v);
        rec.forget();
        await rec.run(await bots.refreshAll());
        const errs = rec.errors();
        const failed = isGlobal ? Object.keys(errs) : (errs[name] ? [name] : []);
        return send(res, 200, { ok: true, failed: failed.map((n) => ({ name: n, error: errs[n] })) });
      }
      const m = /^\/api\/bots\/([^/]+)\/(sets|config|restart)$/.exec(p);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (!bots.has(name)) return send(res, 404, { error: 'compte inconnu' });
        try {
          if (req.method === 'GET' && m[2] === 'sets') return send(res, 200, await bots.sets(name));
          if (req.method === 'PUT' && m[2] === 'config') {
            let patch; try { patch = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; return send(res, 400, { error: 'JSON invalide' }); }
            if (patch && patch.booster) return send(res, 400, { error: 'le booster se règle via le réglage global ou le choix du compte' });
            return send(res, 200, await bots.config(name, patch));
          }
          if (req.method === 'POST' && m[2] === 'restart') return send(res, 200, await bots.restart(name));
        } catch (e) {
          // Erreur du bot (réglage refusé…) renvoyée telle quelle ; bot injoignable → 502
          return send(res, e.status || 502, { error: e.status ? e.message : 'Le bot ne répond pas.' });
        }
      }
      return send(res, 404, { error: 'introuvable' });
    } catch (e) {
      return send(res, e.status || 500, { error: e.status ? e.message : 'erreur interne' });
    }
  });
  return server;
}

function main() {
  const env = process.env;
  const need = ['PANEL_PASSWORD_HASH', 'PANEL_SECRET', 'PANEL_TOKEN', 'PANEL_BOTS'].filter((k) => !env[k]);
  if (need.length) { console.error(`Variables manquantes : ${need.join(', ')} (voir .env.panel.example)`); process.exit(2); }
  if (env.PANEL_SECRET.length < 32) { console.error('PANEL_SECRET trop court (32 caractères minimum).'); process.exit(2); }
  const list = parseBots(env.PANEL_BOTS);
  if (!list.length) { console.error('PANEL_BOTS invalide : attendu compte1=http://compte1:3100,compte2=http://compte2:3100'); process.exit(2); }
  const bots = createBots({ bots: list, token: env.PANEL_TOKEN });
  const store = createStore(path.join(env.PANEL_DATA_DIR || '/data', 'panel-state.json'));
  const reconciler = createReconciler({ store, push: (n, p) => bots.config(n, p) });
  const app = createApp({ store, reconciler,
    passwordHash: env.PANEL_PASSWORD_HASH, secret: env.PANEL_SECRET, bots,
    trustProxy: env.PANEL_TRUST_PROXY === '1', secureCookie: env.PANEL_INSECURE_COOKIE !== '1',
  });
  // Les journaux et alertes se construisent même quand personne ne regarde le panel
  setInterval(() => bots.refreshAll().then((l) => reconciler.run(l)).catch(() => {}), 10000);
  const port = +(env.PANEL_PORT || 8080);
  app.listen(port, '0.0.0.0', () => console.log(`Panel à l’écoute sur le port ${port} · ${list.length} compte(s)`));
}

if (require.main === module) main();
module.exports = { createApp };
