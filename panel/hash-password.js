// Usage : node hash-password.js  (ou  node hash-password.js "mot de passe")
const { hashPassword } = require('./lib/auth');
const readline = require('readline');
const out = (pw) => { if (pw.length < 10) { console.error('Mot de passe trop court (10 caractères minimum).'); process.exit(1); } console.log(hashPassword(pw)); };
if (process.argv[2]) out(process.argv[2]);
else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  rl.question('Mot de passe du panel : ', (pw) => { rl.close(); out(pw); });
}
