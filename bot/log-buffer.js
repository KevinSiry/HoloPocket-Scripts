// Tampon circulaire des dernières lignes du journal du bot (lues par le panel via GET /logs).
function createLogBuffer(max = 500) {
  const lines = [];
  let nextId = 1;
  return {
    push(level, text) {
      const line = { id: nextId++, at: new Date().toISOString(), level, text: String(text).slice(0, 500) };
      lines.push(line);
      if (lines.length > max) lines.shift();
      return line;
    },
    // Lignes plus récentes que `after`, au plus `limit` (les plus récentes) ; `last` = dernier identifiant attribué
    since(after = 0, limit = 200) {
      const out = lines.filter((l) => l.id > after);
      return { lines: out.slice(-limit), last: nextId - 1 };
    },
  };
}

module.exports = { createLogBuffer };
