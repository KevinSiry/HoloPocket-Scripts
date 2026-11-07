# Bot HoloPocket (Docker)

Fait tourner les scripts automatiques 24 h/24 dans un Chromium sans écran, un conteneur par compte.
Chaque bot se connecte avec son identifiant et son mot de passe (`.env.<compte>`) et se reconnecte tout seul si la session expire.
Les scripts sont lus depuis ce dépôt GitHub : une nouvelle version publiée est prise en compte en 15 min.

## Installation

Prérequis : Docker et Docker Compose sur le serveur (`docker compose version` doit répondre).

```bash
git clone https://github.com/KevinSiry/HoloPocket-Scripts.git
cd HoloPocket-Scripts/bot

cp .env.shared.example .env.shared
nano .env.shared         # HP_ACCOUNTS (tous tes pseudos), HP_PRIORITY_TARGET, HP_SCRIPTS… communs à tous les comptes
cp .env.example .env.compte1
cp .env.example .env.compte2
nano .env.compte1        # HP_USERNAME / HP_PASSWORD du compte 1 (rien d'autre à mettre)
nano .env.compte2        # HP_USERNAME / HP_PASSWORD du compte 2
chmod 600 .env.shared .env.compte*

docker compose up -d --build
docker compose logs -f   # chaque compte doit afficher « Connecté en tant que … » puis « Page chargée, scripts injectés »
```

Un seul compte ? Supprime le bloc `compte2` de `docker-compose.yml` (ou lance `docker compose up -d compte1`) ; de même pour `compte3`.

## Au quotidien

```bash
docker compose logs -f --tail 100 compte1   # journal d'un compte (achats, ventes, échanges…)
docker compose logs -f --tail 100           # les deux comptes
docker compose restart compte2              # redémarrer un compte (après avoir modifié son .env)
docker compose stop compte2                 # arrêter un compte
docker compose down                         # tout arrêter
git pull && docker compose up -d --build    # mettre à jour le bot lui-même (les scripts se mettent à jour seuls)
```

## Plusieurs comptes sans les configurer un par un

- `.env.shared` : réglages communs à tous les comptes (liste des comptes, cible prioritaire, scripts, jeton du panel).
- `.env.compteN` : seulement `HP_USERNAME` et `HP_PASSWORD` du compte. Une variable écrite ici passe avant `.env.shared`.
- `HP_ACCOUNTS` : les pseudos de tous tes comptes. Chacun ignore automatiquement les autres (aucun échange, aucune enchère entre eux), sans `HP_EXCLUDE`.
- `HP_PRIORITY_TARGET` : le compte qui reçoit les dons des autres. Il reste exclu des échanges normaux ; il ne se donne rien à lui-même (rien à retirer dans son fichier).
- Ajouter un compte : un bloc dans `docker-compose.yml`, un `.env.compteN`, son pseudo dans `HP_ACCOUNTS`, et son adresse dans `PANEL_BOTS`.

## Réglages (`.env.shared` ou `.env.<compte>`)

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

## Panel de gestion (tous les comptes au même endroit)

Un petit site protégé par mot de passe : vue d'ensemble des comptes (pièces, énergie, échanges n/20, ventes, bot en ligne),
choix du booster à ouvrir (Auto ou une série fixe), scripts activables/coupables par compte, journal et alertes.
Les réglages faits depuis le panel sont conservés (`data/<compte>/panel-config.json`) et passent avant le `.env`.

```bash
cd HoloPocket-Scripts
node panel/hash-password.js                 # donne PANEL_PASSWORD_HASH
openssl rand -hex 32                         # une fois pour PANEL_SECRET, une fois pour PANEL_TOKEN
cp panel/.env.panel.example bot/.env.panel   # puis remplir (sous-domaine, hash, secret, jeton)
chmod 600 bot/.env.panel
echo "PANEL_TOKEN=<le même jeton>" >> bot/.env.compte1   # idem .env.compte2
cd bot && git pull && docker compose --env-file .env.panel up -d --build
```

Prérequis : un enregistrement DNS `A` du sous-domaine (`PANEL_DOMAIN`) vers le VPS, et le réseau Docker `proxy` de Traefik (comme Kroniq).
Chaque bot expose son API (port 3100) uniquement sur le réseau Docker interne, protégée par `PANEL_TOKEN` ; sans `PANEL_TOKEN`, l'API reste éteinte.
Un compte ajouté dans `docker-compose.yml` doit aussi être ajouté à `PANEL_BOTS`. Sans Traefik, ne lance pas le service `panel` (`docker compose up -d compte1 compte2`).

## À savoir

- Les fichiers `.env.*` contiennent des mots de passe : jamais publiés (`.gitignore`), garde-les lisibles par toi seul (`chmod 600`).
- La mémoire des scripts de chaque compte est dans `bot/data/<compte>/` : la supprimer remet ce compte à zéro.
- **Un seul endroit à la fois par compte.** Si les modes auto d'un compte tournent aussi dans ton Chrome, tout est fait en double.
  Quand le bot tourne, désactive les interrupteurs « Auto- » dans ton navigateur (les assistants de jeux peuvent rester).
