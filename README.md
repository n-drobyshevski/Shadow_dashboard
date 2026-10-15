# Shadow IT Dashboard (Google Apps Script)

Tableau de bord de suivi du Shadow IT (postes et applications non maîtrisés), sous forme d'application
web Google Apps Script. C'est le portage de l'application Streamlit d'origine : mêmes pages, mêmes
calculs (scores, conformité, risques), mais hébergé dans Google, sans serveur à maintenir, avec les
données dans un Google Sheet.

- Contrat technique (API serveur, modules client, pages) : [`docs/API.md`](docs/API.md)
- Direction visuelle (« registre d'audit ») : [`docs/DESIGN.md`](docs/DESIGN.md)

## Architecture

```
Classeur source (live)                Apps Script (src/*.js)              Navigateur (src/*.html)
"Suivi des postes"        ──import──▶ Importer ─▶ Store ──▶ ShadowIT_AppData   index.html + js_*.html
"Suivi des applications"   (1 mois)                  ▲                         (HtmlService, page unique)
"Référentiel"                          Api (api_*) ◀─┴── google.script.run ◀── window.api
```

**Serveur — `src/*.js`** (Apps Script V8, un seul espace global) :

| Fichier | Rôle |
|---|---|
| `Code.js` | `doGet` (page web), `include`, `coreScript`, `setup()` |
| `Api.js` | Les fonctions `api_*` appelées par le client (JSON en entrée et en sortie) |
| `Importer.js` | Lit le classeur source et crée l'instantané d'un mois |
| `Store.js` | Seul module qui écrit dans le classeur de données (verrou, écriture en texte brut) |
| `Config.js` | Propriétés du script, noms d'onglets, schémas |
| `Core.js` | Logique pure partagée serveur/client (scores, KPI, filtres, diff) |

**Client — `src/*.html`** : `index.html` (gabarit), `css*.html` (styles), `js_api.html` (promesses
autour de `google.script.run`), `js_state.html` (état), `js_ui.html` et `js_controls.html`
(composants), `js_charts.html` (Plotly), `js_page_*.html` (une page chacun), `js_main.html` (routeur,
barre latérale, démarrage).

**Modèle de données.** Le classeur source est lu tel quel, il n'est jamais modifié. Chaque import
fige un mois (`AAAA-MM`) dans le classeur de données `ShadowIT_AppData`, créé automatiquement dans
votre Drive :

| Onglet | Contenu |
|---|---|
| `Postes`, `Applications` | Une ligne par enregistrement et par mois (`_month`, `_id`, `_json`…) |
| `Referentiel` | Listes de valeurs du mois |
| `Actions`, `Replacements` | Suivi des actions de remédiation et des remplacements de postes |
| `ImportLog` | Journal des imports (marque la fin d'un import réussi) |
| `Meta` | Version du schéma |

Les identifiants des deux classeurs sont stockés dans les propriétés du script
(`DATA_SPREADSHEET_ID`, `SOURCE_SPREADSHEET_ID`).

## Premier déploiement

Prérequis : Node.js 20 ou plus, un **compte Google Workspace du domaine des utilisateurs**
(par exemple `@decathlon.com`). L'application est déployée pour le domaine et identifie chaque
visiteur par son adresse : Google ne transmet cette adresse que pour les comptes du même domaine
Workspace que le déployeur. Avec un compte Gmail personnel, seul le déployeur peut l'utiliser (voir
« Accès » ci-dessous).

1. **Installer les outils**
   ```sh
   npm install
   ```
2. **Activer l'API Apps Script** pour votre compte :
   <https://script.google.com/home/usersettings> → « API Google Apps Script » → Activé.
3. **Se connecter avec clasp** (ouvre le navigateur ; sur une machine distante :
   `npx clasp login --no-localhost`) :
   ```sh
   npm run login
   ```
4. **Créer le projet Apps Script** et renseigner son ID dans `.clasp.json` (remplacer
   `REPLACE_WITH_YOUR_SCRIPT_ID`, garder `"rootDir": "src"`). Deux façons :
   - *Dans le navigateur* : <https://script.google.com> → Nouveau projet → le renommer
     « Shadow IT Dashboard » → Paramètres du projet → copier l'« ID du script ».
   - *En ligne de commande* : `clasp create-script` refuse de s'exécuter si `.clasp.json` existe
     déjà et télécharge un `Code.js` / `appsscript.json` par défaut dans `rootDir`, ce qui écraserait
     `src/`. Le lancer donc dans un dossier vide, puis recopier le `scriptId` :
     ```sh
     REPO="$PWD"; cd "$(mktemp -d)"
     "$REPO/node_modules/.bin/clasp" create-script --type webapp --title "Shadow IT Dashboard"
     grep scriptId .clasp.json      # valeur à copier dans $REPO/.clasp.json
     cd "$REPO"
     ```
5. **Envoyer le code** (seul le dossier `src/` est envoyé ; vérifier avec `npm run status`) :
   ```sh
   npm run push
   ```
   `clasp push -f` remplace tout le contenu du projet distant, manifeste `appsscript.json` compris.
6. **Autoriser le script** : `npx clasp open-script` → dans l'éditeur, choisir la fonction `setup`
   → Exécuter → accepter l'autorisation (Google Sheets ; l'adresse e-mail du compte et la lecture
   des membres de Google Groups pour le contrôle d'accès ; écran « Google n'a pas validé cette application » → Paramètres avancés →
   Accéder au projet). Le journal d'exécution
   affiche l'URL du classeur `ShadowIT_AppData` qui vient d'être créé.
7. **Déployer l'application web** : dans l'éditeur, Déployer → Nouveau déploiement → type
   « Application Web » → Exécuter en tant que : **Moi**, Qui a accès : **Tous les utilisateurs de
   <votre domaine>** (déjà imposé par `appsscript.json`) → Déployer. Noter l'**URL** et l'**ID de déploiement**
   (`AKfy…`).
   Variante en ligne de commande : `npm run deploy` (sans `DEPLOYMENT_ID`) crée le déploiement et
   affiche `Deployed <ID> @<version>`.
8. **Ouvrir l'URL**, coller l'URL du Google Sheet source sur l'écran « Source de données »
   (onglets attendus : `Suivi des postes`, `Suivi des applications`, et `Référentiel` si
   disponible), puis sur le Tableau de bord, section « Importer depuis Google Sheets », choisir le
   mois et cliquer sur « Importer ».
9. **Donner les accès** : Paramètres → Accès → « Ajouter un compte » (rôle Lecteur ou
   Administrateur), puis partager l'URL de l'application. Tant que personne n'est ajouté, seul le
   déployeur peut l'ouvrir.

## Accès

- L'application s'exécute **avec le compte du déployeur** : les classeurs source et de données
  restent privés, inutile de les partager. Les visiteurs n'y accèdent qu'à travers l'application.
- Deux rôles, gérés dans **Paramètres → Accès** :
  - **Administrateur** : tout, y compris les imports, les modifications, la source, le seuil de
    conformité et la liste des accès ;
  - **Lecteur** : consultation seulement (tableaux, graphiques, historique, comparaison, export CSV).
    Le serveur refuse toute écriture d'un lecteur, même appelée hors de l'interface.
- Le **propriétaire du déploiement est toujours administrateur** et n'apparaît pas comme modifiable ;
  personne ne peut modifier son propre accès, ce qui évite de se bloquer.
- **Ajout en masse** : « Ajouter plusieurs comptes… » accepte une liste collée telle quelle (colonne
  d'un Google Sheet, adresses séparées par virgules ou points-virgules, champ « À » d'un e-mail
  `Nom <adresse>`), affiche ce qui sera ajouté, modifié, ignoré ou invalide, puis enregistre tout en une
  fois (500 adresses par ajout, 2000 comptes au total ; au-delà, ouvrir plutôt au domaine en lecture).
  Une recherche filtre la liste.
- **Groupes Google** : ajouter l'adresse d'un groupe (ex. `labo-industry@decathlon.com`) avec un rôle ;
  tous ses membres le reçoivent, sous-groupes compris (3 niveaux). Si un compte a plusieurs rôles
  (liste, groupes, domaine), le plus élevé l'emporte. L'appartenance est vérifiée avec le compte du
  propriétaire, qui doit pouvoir **voir les membres** du groupe (sinon l'ajout est refusé), et mise en
  cache 10 minutes : un changement de membres dans Google s'applique sous 10 minutes, le retrait d'un
  groupe de la liste immédiatement. Un administrateur ne peut pas retirer ni rétrograder le groupe qui
  lui donne ce rôle.
- « Autres comptes du domaine » : *Aucun accès* (par défaut, seuls les comptes listés entrent) ou
  *Lecteur* (tout le domaine peut consulter).
- Un compte non autorisé voit « Accès refusé » avec son adresse, à transmettre à un administrateur.
- La liste est stockée dans les propriétés du script (`ACCESS_JSON_N` et `ACCESS_JSON_0`, `_1`… : une
  propriété est limitée à 9 Ko) et le seuil dans `COMPLIANCE_THRESHOLD` : Éditeur Apps Script →
  Paramètres du projet → Propriétés du script. Supprimer `ACCESS_JSON_N` remet l'accès au seul
  propriétaire.
- **Tester avec un compte Gmail personnel** : le type d'accès « domaine » n'existe pas pour ces
  comptes. Dans `src/appsscript.json`, mettre provisoirement `"access": "MYSELF"` avant de déployer.

## Mettre à jour

Si une nouvelle version demande une autorisation supplémentaire (c'est le cas de l'ajout des Groupes
Google), exécuter de nouveau `setup` dans l'éditeur et accepter, sinon l'application renvoie une
erreur d'autorisation.

Pour publier une nouvelle version **sur la même URL**, réutiliser l'ID de déploiement de l'étape 7 :

```sh
export DEPLOYMENT_ID=AKfy...        # une fois par session (npm run deployments pour le retrouver)
npm run deploy                      # clasp push -f, puis nouvelle version sur ce déploiement
npm run open                        # ouvre l'application web
```

Sans `DEPLOYMENT_ID`, `npm run deploy` crée un **nouveau** déploiement, donc une nouvelle URL.
Pour tester sans publier : `npm run push`, puis Déployer → Tester les déploiements (URL `/dev`, qui
sert toujours le dernier code envoyé).

Les scripts npm utilisent la syntaxe `sh` (`${VAR:+…}`). Sous Windows, les lancer depuis Git Bash ou
WSL.

## Récupération des données

- Le classeur de données n'est **jamais remplacé automatiquement** : s'il est inaccessible,
  l'application affiche « Classeur de données inaccessible… » et réessaie à l'appel suivant.
- S'il a réellement été supprimé : restaurer le fichier depuis la corbeille Drive si possible ;
  sinon, dans l'éditeur, Paramètres du projet → Propriétés du script → supprimer
  `DATA_SPREADSHEET_ID`. Le prochain chargement crée un nouveau classeur `ShadowIT_AppData` vide
  (les mois sont à ré-importer ; les actions et remplacements sont perdus).
- Pour changer de classeur source : bouton « Changer de source » dans la barre latérale.

## À vérifier une fois sur de vrais Sheets

Les tests utilisent un faux SpreadsheetApp ; ce point dépend du comportement réel de Google Sheets.

- [ ] Les valeurs commençant par `=`, `+`, `-`, `@` ou `'` font l'aller-retour **sans
      modification** : créer une action dont le commentaire vaut successivement `=1+1`,
      `+33 6 00 00 00 00`, `- à faire`, `@jdupont`, `'apostrophe` ; recharger l'application ; la
      valeur affichée est identique, et dans `ShadowIT_AppData` → onglet `Actions`, la cellule
      contient le texte littéral (formule non évaluée, aucune apostrophe ajoutée). Même contrôle sur
      une valeur `-` du référentiel après un import.

## Tests

```sh
npm test            # unitaires + intégration (Node, faux services Apps Script)
npm run test:e2e    # Playwright (Chromium) sur le client rendu avec un google.script.run simulé
npm run test:all    # les deux
```

`test:e2e` attend Playwright installé globalement (`npm i -g playwright`) et ses navigateurs dans
`$PLAYWRIGHT_BROWSERS_PATH` (par défaut `/opt/pw-browsers`). Facultatif : `.artifacts/plotly.min.js`
et `.artifacts/fonts/` (non versionnés) permettent des captures avec le vrai Plotly et les vraies
polices ; sans eux, le harnais utilise des substituts.

## Correspondance avec l'application Streamlit

| Page Streamlit | Page web (`id`) | Fichier client |
|---|---|---|
| Tableau de bord (`Tableau_de_bord.py`) | `dashboard` | `src/js_page_dashboard.html` |
| Postes | `postes` | `src/js_page_postes.html` |
| Applications | `apps` | `src/js_page_apps.html` |
| Suivi temporel | `timeline` | `src/js_page_timeline.html` |
| Suivi actions | `actions` | `src/js_page_actions.html` |
| Lecture du Google Sheet, stockage | — | `src/Importer.js`, `src/Store.js` (serveur) |
| Calculs (scores, KPI, diff) | — | `src/Core.js` (partagé serveur/client) |

## Limites

- **6 minutes par exécution** Apps Script : un import lit et écrit un mois entier en un seul appel ;
  un classeur source très volumineux peut dépasser cette limite.
- **Comptes du domaine uniquement** : l'adresse des visiteurs d'un autre domaine n'est pas transmise
  par Google, ils ne peuvent donc pas être autorisés. Les écritures passent par un verrou (attente 20 s, sinon « Une autre opération est en cours. Réessayez dans quelques instants. »).
- Les modifications de code ne sont visibles sur l'URL publiée qu'après `npm run deploy`.
- Le navigateur doit pouvoir charger Plotly (cdnjs.cloudflare.com) et Google Fonts.
- Chaque import ajoute une ligne par poste et par application au classeur de données ; Google Sheets
  plafonne à 10 millions de cellules par classeur.

---

## English summary

Shadow IT Dashboard is a Google Apps Script web app (single HtmlService page) ported from a Streamlit
app. Server code lives in `src/*.js` (`Api`, `Importer`, `Store`, `Config`, `Core`, `Code`); client
code in `src/*.html`. A live source spreadsheet (`Suivi des postes`, `Suivi des applications`,
`Référentiel`) is snapshotted month by month into the app's own `ShadowIT_AppData` spreadsheet
(tabs `Postes`, `Applications`, `Referentiel`, `Actions`, `Replacements`, `ImportLog`, `Meta`).

First deployment: `npm install`; enable the Apps Script API at
<https://script.google.com/home/usersettings>; `npm run login`; create a project (in the browser, or
with `clasp create-script --type webapp` run in an empty directory, since it refuses an existing
`.clasp.json` and pulls default files into `rootDir`) and put its `scriptId` in `.clasp.json`;
`npm run push`; run `setup()` once in the editor to authorise; Deploy → New deployment → Web app
(execute as me, anyone in the domain); open the URL, paste the source sheet URL, import a month; then
grant access in Paramètres → Accès.

Access control: the app runs as the deployer with `access: DOMAIN` (deploy from a Google Workspace
account of the users' domain). Each caller is identified by `Session.getActiveUser()` and checked on
every server call: **admin** (everything, incl. Paramètres) or **lecteur** (read only); the deployer is
always admin and nobody can edit their own access. Unlisted domain accounts get no access by default,
or lecteur if « Autres comptes du domaine » is set so. « Ajouter plusieurs comptes… » takes a pasted
list in any common shape (Sheets column, comma/semicolon separated, `Name <address>`), previews it and
saves it in one call (500 per batch, 2000 accounts max). Google Groups can be granted a role too:
members (sub-groups included, 3 levels) get it, the highest role wins, memberships are checked with
GroupsApp as the deployer (who must see the members) and cached 10 minutes. After pulling this
version, run `setup()` again to grant the new groups scope. The list lives in the `ACCESS_JSON_N` /
`ACCESS_JSON_0..` script properties (split because one property holds 9 KB), the compliance threshold (default 80 %) in `COMPLIANCE_THRESHOLD`. For a personal Gmail
deployer, set `"access": "MYSELF"` in `src/appsscript.json`.

Updates: `DEPLOYMENT_ID=AKfy... npm run deploy` pushes and redeploys the same deployment, so the URL
stays stable (without `DEPLOYMENT_ID` a new deployment and URL are created). If the data
spreadsheet is really gone, delete the `DATA_SPREADSHEET_ID` script property. Verify once on real
Sheets that values starting with `= + - @ '` round-trip unchanged. Tests: `npm test`,
`npm run test:e2e`. Limits: 6-minute execution time, users of the deployer's Workspace domain only.
