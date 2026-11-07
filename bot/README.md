# Bot HoloPocket (Docker)

Fait tourner les scripts automatiques 24 h/24 dans un Chromium sans écran, un conteneur par compte.
Chaque bot se connecte avec son identifiant et son mot de passe (`.env.<compte>`) et se reconnecte tout seul si la session expire.
Les scripts sont lus depuis ce dépôt GitHub : une nouvelle version publiée est prise en compte en 15 min.

## Installation

Prérequis : Docker et Docker Compose sur le serveur (`docker compose version` doit répondre), et le réseau Docker `proxy` de Traefik.

```bash
git clone https://github.com/KevinSiry/HoloPocket-Scripts.git
cd HoloPocket-Scripts

# secrets (sans Node sur le VPS, le hash se fait avec Docker)
docker run --rm -it -v "$PWD/panel":/app -w /app node:22-alpine node hash-password.js   # -> PANEL_PASSWORD_HASH
openssl rand -hex 32    # une fois pour PANEL_SECRET, une fois pour PANEL_TOKEN

cd bot
cp ../panel/.env.panel.example .env.panel     # sous-domaine, hash, secret, jeton
cp .env.shared.example .env.shared            # jeton (le même), cible prioritaire, scripts
chmod 600 .env.panel .env.shared

docker compose --env-file .env.panel up -d --build
docker compose logs -f fleet panel
```

Les comptes se créent ensuite **dans le panel** (`https://ton-sous-domaine`) : « Créer un compte automatiquement » (pseudo et mot de passe aléatoires)
ou « Ajouter un compte existant ». Un conteneur (`fleet`) fait tourner tous les comptes, un Chromium par compte (prévois environ 0,5 Go de mémoire chacun).

## Au quotidien

```bash
docker compose logs -f --tail 100 fleet    # journal de tous les comptes (préfixés par pseudo) ; le panel a aussi un onglet Journal
# redémarrer ou désactiver UN compte : depuis le panel (le conteneur fleet continue pour les autres)
docker compose restart fleet               # redémarrer tous les comptes (après avoir modifié .env.shared)
docker compose down                         # tout arrêter
git pull && docker compose up -d --build    # mettre à jour le bot lui-même (les scripts se mettent à jour seuls)
```

## Panel de gestion

Un site protégé par mot de passe : vue d'ensemble des comptes (pièces, énergie, échanges n/20, ventes, en ligne ou non), **booster à ouvrir** (un réglage global que les comptes suivent par défaut, modifiable par compte), scripts activables par compte, journal et alertes.
Les réglages sont conservés dans le volume de chaque compte (`panel-config.json`) et passent avant `.env.shared`.

## Comptes : gérés par le panel

- **Créer** : le panel choisit un pseudo et un mot de passe aléatoires (sans lien d'un compte à l'autre), inscrit le compte sur HoloPocket depuis le conteneur `fleet`, puis le démarre. Une création à la fois, 30 s d'écart minimum.
- **Ajouter un compte existant** : pseudo et mot de passe saisis dans le panel.
- **Stockage** : les mots de passe sont chiffrés (AES-256-GCM) dans le volume du panel, avec une clé dérivée de `PANEL_SECRET` : ne change pas `PANEL_SECRET` après coup. « Voir le mot de passe » les affiche à la demande.
- **Désactiver / Supprimer** : un compte désactivé s'arrête mais reste enregistré ; le supprimer efface son mot de passe (le compte existe toujours sur HoloPocket).
- **Ils s'ignorent entre eux** : aucun échange ni enchère entre les comptes du panel. `HP_PRIORITY_TARGET` (dans `.env.shared`) reçoit les dons des autres et ne se donne rien à lui-même.
- **Un compte qui plante** (identifiants refusés, page plantée) est relancé seul avec une attente croissante (30 s jusqu'à 30 min) sans toucher aux autres. Son journal reste lisible dans le panel.
- Mode « un compte par conteneur » : sans `PANEL_URL`, `runner.js` fait tourner un seul compte d'après `HP_USERNAME` / `HP_PASSWORD` du `.env`, comme avant.

## Réglages (`.env.shared`)

| Variable | Rôle |
|---|---|
| `HP_USERNAME`, `HP_PASSWORD` | identifiants HoloPocket |
| `HP_ACCOUNTS` | pseudos de tous tes comptes : chacun ignore les autres automatiquement |
| `HP_EXCLUDE` | pseudos à ne jamais solliciter en plus : aucun échange, aucune enchère sur leurs ventes. Mets-y tes autres comptes pour qu'ils restent indépendants |
| `HP_PRIORITY_TARGET` | pseudo d'un joueur à servir en priorité : à chaque passage (toutes les minutes), avant la recherche normale, le script `echanges` lui propose en don toutes tes cartes qu'il n'a pas, même en un seul exemplaire (jamais une carte en vente, hors classeur et cartes réservées à la revente ; 10 cartes max par échange, les plus chères d'abord, rien demandé en retour). Pour tous les autres échanges, le dernier exemplaire d'une carte n'est jamais donné. Un seul échange ouvert à la fois avec lui, sans pause après acceptation ou refus. Si tu l'as mis dans `HP_EXCLUDE`, la priorité l'emporte |
| `HP_SCRIPTS` | scripts à faire tourner (par défaut `auto-booster,echanges`) ; disponibles : `auto-booster, echanges, vendre-doublons, recyclage, achat-revente` |
| `HP_DEFAULT_BOOSTER` | série ouverte par l'auto-booster si le compte n'a aucun favori (nom ou identifiant, ex. `Nuit Noire` ou `me05`) |
| `HP_CHECK_UPDATES_MIN` | délai de vérification des nouvelles versions (15 par défaut) |
| `HP_RELOAD_EVERY_H` | rechargement complet de la page (6 par défaut) |
| `PANEL_TOKEN` | jeton partagé avec le panel (active l'API du bot) ; `HP_BOT_NAME` (nom affiché, par défaut le pseudo) et `HP_PANEL_PORT` (3100) sont optionnels |
| `HP_COOKIE` | variante sans mot de passe (compte Discord) : en-tête Cookie copié depuis le navigateur ; à recopier quand il expire |

Le mode auto de chaque script listé est activé automatiquement.

## À savoir

- Les fichiers `.env.*` contiennent des mots de passe : jamais publiés (`.gitignore`), garde-les lisibles par toi seul (`chmod 600`).
- La mémoire des scripts de chaque compte est dans `bot/data/fleet/<pseudo>/` : la supprimer remet ce compte à zéro.
- **Un seul endroit à la fois par compte.** Si les modes auto d'un compte tournent aussi dans ton Chrome, tout est fait en double.
  Quand le bot tourne, désactive les interrupteurs « Auto- » dans ton navigateur (les assistants de jeux peuvent rester).
