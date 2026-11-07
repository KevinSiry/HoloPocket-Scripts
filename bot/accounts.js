// Comptes d'un même propriétaire : ils s'ignorent entre eux (échanges, enchères) sans configuration par compte.
// HP_ACCOUNTS = tous les pseudos ; chaque bot exclut les autres. HP_PRIORITY_TARGET = le compte qui reçoit les dons des autres.
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

function resolveAccounts({ username = '', accounts = [], exclude = [], priorityTarget = '' }) {
  const me = String(username).trim();
  const others = accounts.filter((a) => a && !(me && same(a, me)));
  const merged = [];
  for (const p of [...exclude, ...others]) if (p && !(me && same(p, me)) && !merged.some((m) => same(m, p))) merged.push(p);
  // La cible prioritaire ne se donne rien à elle-même
  const target = priorityTarget && !(me && same(priorityTarget, me)) ? priorityTarget.trim() : '';
  return { exclude: merged, priorityTarget: target, isTarget: !!priorityTarget && !!me && same(priorityTarget, me) };
}

module.exports = { resolveAccounts };
