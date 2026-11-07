// API HTTP interne du bot, lue et pilotée par le panel (jamais publiée sur l'hôte).
// Authentification : en-tête « Authorization: Bearer <PANEL_TOKEN> ».
const http = require('http');
const crypto = require('crypto');
const { validatePatch } = require('./panel-config');

const MAX_BODY = 8 * 1024;

// Comparaison en temps constant, quelle que soit la longueur des deux textes
function sameToken(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('corps trop volumineux'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * deps : {
 *   token,                 secret partagé avec le panel (obligatoire)
 *   status(): Promise<object>,         état du compte et du bot
 *   logs: { since(after, limit) },     tampon du journal
 *   sets(): Promise<Array>,            séries du site
 *   applyConfig(patch): Promise<object>,   applique un patch déjà validé
 *   restart(): void,                   arrête le bot (Docker le relance)
 * }
 */
function createPanelServer(deps) {
  if (!deps.token) throw new Error('PANEL_TOKEN manquant : API du panel désactivée');
  const send = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
    res.end(data);
  };

  return http.createServer(async (req, res) => {
    try {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m || !sameToken(m[1], deps.token)) return send(res, 401, { error: 'non autorisé' });

      const url = new URL(req.url, 'http://bot');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /status') return send(res, 200, await deps.status());

      if (route === 'GET /logs') {
        const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
        return send(res, 200, deps.logs.since(after, limit));
      }

      if (route === 'GET /sets') return send(res, 200, await deps.sets());

      if (route === 'PUT /config') {
        let patch;
        try { patch = JSON.parse(await readBody(req)); } catch (e) {
          if (e.status) throw e;
          return send(res, 400, { error: 'JSON invalide' });
        }
        // Les séries du site ne sont lues que si le patch change le booster
        const sets = patch && patch.booster && patch.booster.mode === 'fixed' ? await deps.sets() : [];
        const v = validatePatch(patch, sets);
        if (!v.ok) return send(res, 400, { error: v.error });
        return send(res, 200, { ok: true, ...(await deps.applyConfig(patch)) });
      }

      if (route === 'POST /restart') {
        send(res, 202, { ok: true });
        res.on('finish', () => setTimeout(() => deps.restart(), 200));
        return undefined;
      }

      return send(res, 404, { error: 'introuvable' });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || 'erreur' });
    }
  });
}

module.exports = { createPanelServer, sameToken };
