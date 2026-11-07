const crypto = require('crypto');
// Comparaison en temps constant, quelle que soit la longueur des deux textes
function sameToken(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
module.exports = { sameToken };
