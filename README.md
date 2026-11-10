# HoloPocket Scripts

Scripts Tampermonkey pour [holopocket.fr](https://holopocket.fr).

## Installation

Avec Tampermonkey installé dans le navigateur, clique sur **Installer** : Tampermonkey ouvre sa page d'installation, puis clique sur **Installer** (ou **Réinstaller / Mettre à jour**).

Chaque script contient `@updateURL` : Tampermonkey récupère tout seul les nouvelles versions publiées ici.

| Script | Version | Lien |
|---|---|---|
| Achat-revente intelligent | 1.12 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-achat-revente.user.js) |
| Achat des cartes manquantes bradées (auto, 70 % du prix moyen) | 1.8 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-achat-manquantes.user.js) |
| Enchérir sur mes cartes manquantes | 2.2 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-acheter-manquantes.user.js) |
| Ouverture auto dès que l’énergie suffit | 2.9 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-auto-booster.user.js) |
| Assistant Cartodle | 2.0 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-cartodle.user.js) |
| Chances de nouvelles cartes par booster | 2.0 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-chances-boosters.user.js) |
| Assistant Coffre | 2.0 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-coffre.user.js) |
| Assistant Connexions | 2.0 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-connexions.user.js) |
| Échanges équitables | 3.20 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-echanges.user.js) |
| Stratège du Conseil 4 (Ligue : meilleur booster / Super Bonbon, mode auto) | 1.2 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-ligue.user.js) |
| Stratège du Maître (Ligue : meilleure annonce à chaque booster, mode auto) | 1.1 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-maitre.user.js) |
| Recyclage intelligent des doublons | 1.3 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-recyclage.user.js) |
| Vendre mes doublons | 4.8 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-vendre-doublons.user.js) |
| Assistant Les Voisins | 2.0 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-voisins.user.js) |
| Assistant Voltorbe Flip | 3.0 | [Installer](https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/holopocket-voltorbe-flip.user.js) |

## Organisation

- `scripts/` : scripts prêts à installer (générés, ne pas modifier à la main)
- `src/` : sources ; `kit.js` est l'interface commune injectée dans chaque script
- `bot/` : faire tourner les scripts 24 h/24 sur un serveur (voir `bot/README.md`)
- `python3 src/build.py` : régénère `scripts/` et vérifie la syntaxe (`node --check`)
