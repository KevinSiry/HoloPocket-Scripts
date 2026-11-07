const f = document.getElementById('f');
const err = document.getElementById('err');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel': '1' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
    if (r.ok) { location.href = '/'; return; }
    const d = await r.json().catch(() => ({}));
    err.textContent = d.error || 'Connexion impossible.';
  } catch { err.textContent = 'Panel injoignable.'; }
  err.hidden = false;
});
