// Appels du panel vers la flotte (conteneur des comptes), sur le réseau Docker interne.
function createFleetClient({ url, token, fetchFn = fetch }) {
  const base = String(url).replace(/\/+$/, '');
  const call = async (path, body, timeoutMs) => {
    const r = await fetchFn(base + path, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  return {
    base,
    // Inscription sur HoloPocket (jusqu'à 90 s : un navigateur s'ouvre)
    register: (username, password) => call('/register', { username, password }, 90000),
    // Demande à la flotte de relire la liste des comptes tout de suite (sinon elle le fait toutes les 15 s)
    sync: () => call('/sync', {}, 5000).catch(() => null),
  };
}

module.exports = { createFleetClient };
