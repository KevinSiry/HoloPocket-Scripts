# Bot HoloPocket (VPS)

Fait tourner les scripts automatiques 24 h/24 dans un Chromium sans écran, avec **ton** compte.
Les scripts sont lus depuis ce dépôt GitHub : une nouvelle version publiée est prise en compte en 15 min.

## Installation (Ubuntu / Debian)

```bash
# 1. Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. Utilisateur dédié + code
sudo useradd -m -s /bin/bash holopocket
sudo git clone https://github.com/KevinSiry/HoloPocket-Scripts /opt/holopocket
sudo chown -R holopocket:holopocket /opt/holopocket
cd /opt/holopocket/bot
sudo -u holopocket npm install
sudo npx playwright install-deps chromium
sudo -u holopocket npx playwright install chromium

# 3. Configuration
sudo -u holopocket cp config.example.json config.json
sudo -u holopocket nano config.json      # colle ton en-tête Cookie (voir plus bas)
sudo chmod 600 config.json

# 4. Test à la main (Ctrl+C pour arrêter)
sudo -u holopocket node runner.js

# 5. Service permanent (redémarre tout seul, y compris après un reboot)
sudo cp holopocket-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now holopocket-bot
```

## Récupérer l'en-tête Cookie

1. Sur ton PC, ouvre holopocket.fr (connecté), puis **F12** → onglet **Réseau** (Network).
2. Recharge la page, clique sur une requête `me` (ou n'importe quelle requête `/api/…`).
3. Dans **En-têtes de requête**, copie toute la valeur de `cookie:`.
4. Colle-la dans `config.json`, champ `cookie`.

Ce cookie donne accès à ton compte : `config.json` n'est jamais publié (`.gitignore`) et reste lisible par le seul utilisateur `holopocket`.

## Au quotidien

```bash
journalctl -u holopocket-bot -f              # journal en direct (achats, ventes, échanges…)
sudo systemctl restart holopocket-bot        # redémarrer
sudo systemctl stop holopocket-bot           # arrêter
cd /opt/holopocket && sudo -u holopocket git pull   # mettre à jour ce dossier bot/ (les scripts, eux, se mettent à jour seuls)
```

Si le journal affiche **« Session expirée »**, le bot s'arrête : recopie un nouvel en-tête Cookie dans `config.json`, puis `sudo systemctl restart holopocket-bot`.

## Important : un seul endroit à la fois

La mémoire des scripts (verrous, enchères suivies, joueurs déjà sollicités) est propre à chaque navigateur.
Si les modes auto tournent **à la fois** sur le VPS et sur ton PC, ils agissent en double (deux enchères, deux propositions…).
Quand le bot tourne, **désactive les interrupteurs Auto-** dans ton Chrome (les assistants de jeux peuvent rester).
