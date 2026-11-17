const f = document.getElementById('f');
const err = document.getElementById('err');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const btn = f.querySelector('button');
  btn.disabled = true; // pas de double envoi (chaque échec compte dans la limite d'essais)
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel': '1' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
    if (r.ok) { location.href = '/'; return; }
    const d = await r.json().catch(() => ({}));
    err.textContent = d.error || 'Connexion impossible.';
  } catch { err.textContent = 'Panel injoignable.'; }
  btn.disabled = false;
  err.hidden = false;
});
