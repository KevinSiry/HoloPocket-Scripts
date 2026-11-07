# Panel de gestion des comptes HoloPocket : design

Statut : à relire par Kevin · Date : 2026-11-07

## Objectif

Une page web unique, publique et protégée, qui regroupe tous les comptes HoloPocket gérés par les bots Docker :
voir leur état d'un coup d'œil et les piloter (booster ouvert, scripts actifs, redémarrage) sans éditer les `.env` ni se connecter au VPS.

Décisions prises avec Kevin :

| Sujet | Décision |
|---|---|
| Contenu V1 | Vue d'ensemble des comptes, gestion du booster, scripts on/off par compte, journal et alertes |
| Accès | URL publique sur un sous-domaine de `chabow.fr`, derrière le Traefik existant du VPS (modèle `deploy/docker-compose.yml` de Kroniq) |
| Connexion | Mot de passe unique |
| Liaison panel / bots | API HTTP dans chaque bot, sur un réseau Docker interne, protégée par un jeton partagé |
| Emplacement du code | Ce dépôt : `panel/` à côté de `bot/` |

## Architecture

```
Navigateur ──HTTPS──> Traefik ──> panel (Node, port 8080)
                                    │  réseau Docker interne « internal »
                                    ├──> compte1:3100  (API du bot, jeton)
                                    └──> compte2:3100
```

- **Bot** : un nouveau module `bot/panel-api.js` démarre un serveur HTTP sur `HP_PANEL_PORT` (3100) si `PANEL_TOKEN` est défini, sinon l'API reste éteinte. Le port n'est jamais publié sur l'hôte.
- **Panel** : nouveau service `panel/` (Node, sans dépendance externe, sans étape de build). Il ne stocke rien d'important : il interroge les bots à la demande. Seul le panel rejoint le réseau Traefik `proxy`.
- Les mots de passe HoloPocket (`.env.compteX`) ne quittent jamais les bots.
- Le panel ne sait pas qu'un bot existe tant qu'il n'est pas dans `PANEL_BOTS`.

## API du bot (`bot/panel-api.js`)

Authentification : en-tête `Authorization: Bearer <PANEL_TOKEN>`, comparaison en temps constant, réponse 401 sinon. JSON uniquement, corps limité à 8 Ko.

`GET /status` (mis en cache 5 s) :

```json
{
  "name": "compte1", "at": "2026-11-07T12:00:00Z",
  "bot": { "startedAt": "…", "sessionOk": true, "lastCheckAt": "…" },
  "account": { "user": "pseudo", "balance": 1234, "energy": { "stock": 7, "max": 10, "fullSince": null }, "quarantined": false },
  "trades": { "open": 12, "max": 20, "fullSince": null },
  "sales": { "selling": 3, "max": 10 },
  "scripts": [ { "name": "auto-booster", "version": "2.2", "on": true } ],
  "booster": { "mode": "auto", "setId": null, "favorites": [ { "id": "me05", "name": "Nuit Noire" } ] }
}
```

Les chiffres viennent de l'API du site (`/me`, `/trades/sent`, `/market/counts`, `/sets`), lue depuis la page du bot. `fullSince` est mesuré depuis la première consultation où la condition est vraie (pas d'historique avant).

`GET /logs?after=<id>&limit=200` : lignes `{ id, at, level: "info"|"warn"|"error", text }` d'un tampon circulaire de 500 lignes. Le `level` vient de la fonction `log` du runner (reconnexions et arrêts en `warn`/`error`) et de la classe `hp-toast--error` pour les messages des scripts.

`GET /sets` : `[{ id, name, favorite, promo, packCost }]` (cache 60 s), pour la liste du booster.

`PUT /config` : corps partiel, validé côté bot.

```json
{ "booster": { "mode": "fixed", "setId": "me05" }, "scripts": { "echanges": false, "achat-revente": true } }
```

- `booster.mode` : `auto` ou `fixed` ; `setId` doit exister dans `/sets`.
- `scripts` : seuls les noms connus (`auto-booster, echanges, vendre-doublons, recyclage, achat-revente`) sont acceptés. `true` charge le script et active son mode auto ; `false` ne le charge pas.
- Les réglages sont écrits de façon atomique (fichier temporaire puis renommage) dans `profile/panel-config.json`, donc conservés au redémarrage.
- Changement de booster : appliqué tout de suite (pas de rechargement). Changement de scripts : rechargement de la page du bot, environ 5 s. Un seul rechargement à la fois par bot (les commandes sont mises en file).

`POST /restart` : répond 202 puis le bot s'arrête ; `restart: unless-stopped` de Docker le relance.

Ordre de priorité des réglages : `panel-config.json` > `.env` > valeurs par défaut.

## Évolution de l'auto-booster (2.2)

Nouveau réglage `localStorage['hp-booster-force']` (id de la série), lu à chaque choix de série :

- vide : comportement actuel, inchangé (meilleur favori, ou `hp-booster-default` sans favori) ;
- renseigné : ouvre toujours cette série, favorite ou non, tant que l'énergie couvre son coût ; erreur claire si la série est introuvable.

## Panel (`panel/`)

Variables (fichier `.env.panel`, `chmod 600`) :

| Variable | Rôle |
|---|---|
| `PANEL_DOMAIN` | sous-domaine public, ex. `holo.chabow.fr` (DNS A vers le VPS) |
| `PANEL_PASSWORD_HASH` | hachage scrypt du mot de passe, produit par `node panel/hash-password.js` |
| `PANEL_SECRET` | secret de signature des sessions (32 octets au moins) |
| `PANEL_TOKEN` | jeton partagé avec les bots |
| `PANEL_BOTS` | `compte1=http://compte1:3100,compte2=http://compte2:3100` |

Le panel refuse de démarrer, avec un message clair, s'il manque `PANEL_PASSWORD_HASH`, `PANEL_SECRET`, `PANEL_TOKEN` ou `PANEL_BOTS`.

Routes : `GET /` et `GET /login` (pages), `POST /api/login`, `POST /api/logout`, `GET /api/accounts` (état de tous les bots en parallèle, délai de 3 s par bot), `GET /api/logs?after=…` (journaux fusionnés), `GET /api/sets/:bot`, `PUT /api/accounts/:bot/config`, `POST /api/accounts/:bot/restart`.

### Sécurité

- Mot de passe unique vérifié contre le hachage scrypt, jamais stocké en clair.
- Session : cookie signé (HMAC) valable 12 h, `HttpOnly`, `Secure`, `SameSite=Strict`.
- Blocage de 15 min après 5 échecs de connexion depuis une même adresse (l'adresse vient de `X-Forwarded-For`, seulement derrière Traefik), avec un petit délai à chaque échec. La limite de débit de Traefik s'ajoute.
- Toute requête qui modifie quelque chose exige l'en-tête `X-Panel: 1` en plus du cookie.
- En-têtes de sécurité (HSTS, `nosniff`, interdiction d'encadrer la page, politique de contenu `default-src 'self'`) posés par le panel et par Traefik.
- Les contrôles d'accès sont faits côté serveur ; masquer un bouton n'est jamais une protection.

### Interface

Une page, d'abord pensée pour le téléphone (une colonne, gros boutons, thème sombre), sans dépendance :

- bandeau d'alertes en haut ;
- une carte par compte : voyant en ligne/hors ligne, pseudo, pièces, barre d'énergie, échanges n/20, ventes, menu « Auto / série fixe », une case par script, bouton Redémarrer ;
- onglet Journal : lignes de tous les comptes, filtrables par compte et par niveau.

Rafraîchissement toutes les 5 s tant que la page est ouverte.

### Alertes (affichées dans le panel, pas de notification externe en V1)

| Alerte | Condition |
|---|---|
| Bot hors ligne | pas de réponse depuis plus de 30 s |
| Session | `sessionOk` faux ou reconnexion en cours |
| Quarantaine | `account.quarantined` vrai |
| Échanges bloqués | `trades.open` = `trades.max` depuis plus de 2 h |
| Énergie pleine | énergie au maximum depuis plus de 10 min alors que l'auto-booster est actif |
| Erreur de script | ligne de niveau `error` dans les 15 dernières minutes |

Un bot injoignable reste affiché, grisé, avec ses dernières données connues (gardées en mémoire par le panel) et l'heure de son dernier signe de vie.

## Déploiement

- `bot/docker-compose.yml` : réseau `internal` (accès Internet conservé) pour les bots et le panel ; le panel rejoint aussi le réseau externe `proxy` avec les labels Traefik de Kroniq (redirection HTTPS, `certresolver letsencrypt`, en-têtes de sécurité, limite de débit). Variables `PANEL_TOKEN` (et `HP_BOT_NAME` facultatif) ajoutées dans chaque `.env.compteX`.
- `panel/Dockerfile` (Node alpine) ; `panel/.env.panel.example`.
- Ajouter un compte reste manuel en V1 : un bloc dans le compose et une entrée dans `PANEL_BOTS`.
- Mise à jour : `git pull && docker compose up -d --build`.

## Tests (`node:test`, sans dépendance)

- API du bot avec une fausse page : authentification, validation de `PUT /config`, priorité des réglages, écriture atomique, file des commandes.
- Panel : connexion et blocage après 5 échecs, drapeaux du cookie, refus sans `X-Panel`, bot injoignable, calcul des alertes.
- Auto-booster : le mode « série fixe » (via le harnais déjà utilisé pour les échanges).
- Pas de test possible sur le vrai site HoloPocket : la lecture de `/market/counts`, `/trades/sent` et `/me` suit ce que lisent déjà les scripts existants.

## Hors périmètre (V1)

Notifications externes (Discord), ajout de compte depuis le panel, gestion de la cible prioritaire et des exclusions, modification des favoris du site, plusieurs utilisateurs, historique et graphiques, journaux bruts de Docker.

## Critères de réussite

1. Une seule page, protégée par mot de passe, affiche tous les comptes avec leur état à jour.
2. Changer le booster d'un compte s'applique à la prochaine ouverture, sans redémarrage.
3. Couper ou activer un script prend effet en moins de 15 s.
4. Un bot arrêté apparaît hors ligne en moins de 30 s, sans casser la page.
5. Sans le bon mot de passe, ni les données ni les commandes ne sont accessibles.
