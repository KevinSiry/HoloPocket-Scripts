# Bot HoloPocket (Docker)

Fait tourner les scripts automatiques 24 h/24 dans un Chromium sans écran, un conteneur par compte.
Chaque bot se connecte avec son identifiant et son mot de passe (`.env.<compte>`) et se reconnecte tout seul si la session expire.
Les scripts sont lus depuis ce dépôt GitHub : une nouvelle version publiée est prise en compte en 15 min.

## Installation

Prérequis : Docker et Docker Compose sur le serveur (`docker compose version` doit répondre).

```bash
git clone https://github.com/KevinSiry/HoloPocket-Scripts.git
cd HoloPocket-Scripts/bot

cp .env.example .env.compte1
cp .env.example .env.compte2
nano .env.compte1        # HP_USERNAME / HP_PASSWORD du compte 1, HP_EXCLUDE = pseudo du compte 2
nano .env.compte2        # HP_USERNAME / HP_PASSWORD du compte 2, HP_EXCLUDE = pseudo du compte 1
chmod 600 .env.compte*

docker compose up -d --build
docker compose logs -f   # chaque compte doit afficher « Connecté en tant que … » puis « Page chargée, scripts injectés »
```

Un seul compte ? Supprime le bloc `compte2` de `docker-compose.yml` (ou lance `docker compose up -d compte1`).

## Au quotidien

```bash
docker compose logs -f --tail 100 compte1   # journal d'un compte (achats, ventes, échanges…)
docker compose logs -f --tail 100           # les deux comptes
docker compose restart compte2              # redémarrer un compte (après avoir modifié son .env)
docker compose stop compte2                 # arrêter un compte
docker compose down                         # tout arrêter
git pull && docker compose up -d --build    # mettre à jour le bot lui-même (les scripts se mettent à jour seuls)
```

## Réglages (`.env.<compte>`)

| Variable | Rôle |
|---|---|
| `HP_USERNAME`, `HP_PASSWORD` | identifiants HoloPocket |
| `HP_EXCLUDE` | pseudos à ne jamais solliciter : aucun échange, aucune enchère sur leurs ventes. Mets-y tes autres comptes pour qu'ils restent indépendants |
| `HP_SCRIPTS` | scripts à faire tourner : `vendre-doublons, auto-booster, recyclage, echanges, achat-revente` |
| `HP_CHECK_UPDATES_MIN` | délai de vérification des nouvelles versions (15 par défaut) |
| `HP_RELOAD_EVERY_H` | rechargement complet de la page (6 par défaut) |
| `HP_COOKIE` | variante sans mot de passe (compte Discord) : en-tête Cookie copié depuis le navigateur ; à recopier quand il expire |

Le mode auto de chaque script listé est activé automatiquement.

## À savoir

- Les fichiers `.env.*` contiennent des mots de passe : jamais publiés (`.gitignore`), garde-les lisibles par toi seul (`chmod 600`).
- La mémoire des scripts de chaque compte est dans `bot/data/<compte>/` : la supprimer remet ce compte à zéro.
- **Un seul endroit à la fois par compte.** Si les modes auto d'un compte tournent aussi dans ton Chrome, tout est fait en double.
  Quand le bot tourne, désactive les interrupteurs « Auto- » dans ton navigateur (les assistants de jeux peuvent rester).
