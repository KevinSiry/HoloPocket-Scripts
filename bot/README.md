# Bot HoloPocket (Docker)

Fait tourner les scripts automatiques 24 h/24 dans un Chromium sans écran, avec **ton** compte.
Il se connecte avec ton identifiant et ton mot de passe (`.env`) et se reconnecte tout seul si la session expire.
Les scripts sont lus depuis ce dépôt GitHub : une nouvelle version publiée est prise en compte en 15 min.

## Installation

Prérequis : Docker et Docker Compose sur le serveur (`docker compose version` doit répondre).

```bash
git clone https://github.com/KevinSiry/HoloPocket-Scripts.git
cd HoloPocket-Scripts/bot
cp .env.example .env
nano .env            # HP_USERNAME et HP_PASSWORD
chmod 600 .env
docker compose up -d --build
docker compose logs -f   # doit afficher « Connecté en tant que … » puis « Page chargée, scripts injectés »
```

## Au quotidien

```bash
docker compose logs -f --tail 100      # journal en direct (achats, ventes, échanges…)
docker compose restart                 # redémarrer (après avoir modifié .env)
docker compose down                    # arrêter
git pull && docker compose up -d --build   # mettre à jour le bot lui-même (rarement utile :
                                           # les scripts se mettent à jour seuls depuis GitHub)
```

## Réglages (`.env`)

| Variable | Rôle |
|---|---|
| `HP_USERNAME`, `HP_PASSWORD` | identifiants HoloPocket |
| `HP_SCRIPTS` | scripts à faire tourner : `vendre-doublons, auto-booster, recyclage, echanges, achat-revente` |
| `HP_CHECK_UPDATES_MIN` | délai de vérification des nouvelles versions (15 par défaut) |
| `HP_RELOAD_EVERY_H` | rechargement complet de la page (6 par défaut) |
| `HP_COOKIE` | variante sans mot de passe (compte Discord) : en-tête Cookie copié depuis le navigateur ; il faudra le recopier quand il expire |

Le mode auto de chaque script listé est activé automatiquement.

## À savoir

- `.env` contient ton mot de passe : il n'est jamais publié (`.gitignore`). Garde-le lisible par toi seul (`chmod 600`).
- La mémoire des scripts (enchères suivies, joueurs sollicités, bénéfice…) est dans `bot/data/` : la supprimer remet tout à zéro.
- **Un seul endroit à la fois.** Si les modes auto tournent aussi dans ton Chrome, tout est fait en double.
  Quand le bot tourne, désactive les interrupteurs « Auto- » dans ton navigateur (les assistants de jeux peuvent rester).
