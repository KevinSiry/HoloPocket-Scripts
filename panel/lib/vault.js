// Chiffrement des mots de passe des comptes (AES-256-GCM). La clé vient de PANEL_SECRET : le changer rend les mots de passe illisibles.
const crypto = require('crypto');

function createVault(secret) {
  const key = Buffer.from(crypto.hkdfSync('sha256', String(secret), 'hp-panel-vault', 'accounts-v1', 32));
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
    },
    decrypt(blob) {
      const [v, iv, tag, ct] = String(blob).split(':');
      if (v !== 'v1') throw new Error('format inconnu');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}

module.exports = { createVault };
