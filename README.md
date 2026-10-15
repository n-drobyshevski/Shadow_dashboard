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
"Suivi des postes"        ◀─toutes──▶ Importer ─▶ Store ──▶ ShadowIT_AppData   index.html + js_*.html
"Suivi des applications"   les heures   ▲ Sync (déclencheur)  ▲                (HtmlService, page unique)
"Référentiel"            (mois en cours) Api (api_*) ◀─┴── google.script.run ◀── window.api
```

**Serveur — `src/*.js`** (Apps Script V8, un seul espace global) :

| Fichier | Rôle |
|---|---|
| `Code.js` | `doGet` (page web), `include`, `coreScript`, `setup()`, `syncHourly()` (déclencheur horaire) |
| `Api.js` | Les fonctions `api_*` appelées par le client (JSON en entrée et en sortie) |
| `Importer.js` | Lit le classeur source, crée l'instantané d'un mois, y écrit les modifications du mois en cours |
| `Sync.js` | Synchronisation horaire du mois en cours (déclencheur, état) |
| `Store.js` | Seul module qui écrit dans le classeur de données (verrou, écriture en texte brut) |
| `Config.js` | Propriétés du script, noms d'onglets, schémas |
| `Core.js` | Logique pure partagée serveur/client (scores, KPI, filtres, diff) |
| `Perf.js` | Lignes de mesure JSON (durées par appel et par étape) dans le journal des exécutions |

**Client — `src/*.html`** : `index.html` (gabarit), `css*.html` (styles), `js_api.html` (promesses
autour de `google.script.run`), `js_state.html` (état), `js_ui.html` et `js_controls.html`
(composants), `js_charts.html` (Plotly), `js_page_*.html` (une page chacun), `js_main.html` (routeur,
barre latérale, démarrage).

**Modèle de données.** Toutes les heures, l'application relit le classeur source et met à jour le
**mois en cours** (`AAAA-MM`, heure de Paris) dans le classeur de données `ShadowIT_AppData`, créé
automatiquement dans votre Drive. Le 1er du mois, la première synchronisation crée le nouveau mois ; le
précédent reste figé tel qu'à sa dernière synchronisation. Il n'y a plus d'import manuel.

**Période.** La barre du haut permet de choisir un mois ou une période (raccourcis « 3 derniers mois »,
« 6 derniers mois », « Année », « Tout l'historique », ou plage libre). Sur une période, chaque page montre
l'état du dernier mois et ce qui a changé depuis le premier : écarts et mini-courbes au Tableau de bord,
colonne « Évolution » dans Postes et Applications, Suivi temporel limité à la période, actions datées de la
période. Le raccourci choisi est mémorisé par compte.

Les modifications du mois en cours faites dans l'application (cellules des Postes et Applications,
poste générique, ajout / renommage / suppression d'une application) sont **écrites dans le classeur
source**, puis dans l'instantané : la synchronisation suivante les relit. Galink et IDP, absents de la
source, restent dans l'application. Une cellule calculée par une formule dans la source n'est pas
modifiable depuis l'application. Les modifications d'un mois passé ne changent que son historique.

| Onglet | Contenu |
|---|---|
| `Postes`, `Applications` | Une ligne par enregistrement et par mois (`_month`, `_id`, `_json`…) |
| `Referentiel` | Listes de valeurs du mois |
| `Actions`, `Replacements` | Suivi des actions de remédiation et des remplacements de postes |
| `ImportLog` | Journal des synchronisations qui ont changé quelque chose (marque la fin d'une écriture réussie) |
| `Meta` | Version du schéma |

Les identifiants des deux classeurs sont stockés dans les propriétés du script
(`DATA_SPREADSHEET_ID`, `SOURCE_SPREADSHEET_ID`), le titre du classeur source dans `SOURCE_INFO`
(affiché sans ouvrir la source, mis à jour à chaque synchronisation), l'état de la synchronisation dans
`SYNC_STATE`, et
`SOURCE_WRITE_STAMP` avance à chaque écriture de l'application dans la source (la synchronisation s'en
sert pour ne jamais annuler une modification enregistrée pendant qu'elle lisait la source).

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
   des membres de Google Groups pour le contrôle d'accès ; les déclencheurs, pour la synchronisation
   horaire ; écran « Google n'a pas validé cette application » → Paramètres avancés →
   Accéder au projet). **Cocher toutes les autorisations** (« Tout sélectionner ») : l'écran
   permet d'en décocher, et une autorisation refusée n'est plus redemandée d'elle-même — `setup`
   la redemande au lancement suivant. Le journal d'exécution
   affiche l'URL du classeur `ShadowIT_AppData` qui vient d'être créé ; le déclencheur horaire
   `syncHourly` est créé (visible dans Déclencheurs).
7. **Déployer l'application web** : dans l'éditeur, Déployer → Nouveau déploiement → type
   « Application Web » → Exécuter en tant que : **Moi**, Qui a accès : **Tous les utilisateurs de
   <votre domaine>** (déjà imposé par `appsscript.json`) → Déployer. Noter l'**URL** et l'**ID de déploiement**
   (`AKfy…`).
   Variante en ligne de commande : `npm run deploy` (sans `DEPLOYMENT_ID`) crée le déploiement et
   affiche `Deployed <ID> @<version>`.
8. **Ouvrir l'URL**, coller l'URL du Google Sheet source sur l'écran « Source de données »
   (onglets attendus : `Suivi des postes`, `Suivi des applications`, et `Référentiel` si
   disponible). L'application synchronise aussitôt le mois en cours, puis toutes les heures. L'état
   est visible en bas du menu de gauche ; le journal et « Synchroniser maintenant » sont dans
   Paramètres → Synchronisation.

**Mise à jour d'une installation existante** (version avec import manuel) : après `npm run deploy`,
le compte qui déploie exécute `setup` dans l'éditeur Apps Script et accepte la nouvelle autorisation
(déclencheurs) — ouvrir l'application web ne la demande pas, elle s'exécute avec l'autorisation déjà
accordée. `setup` crée aussi le déclencheur horaire ; sinon, Paramètres → Synchronisation → « Activer la
synchronisation horaire ». Les mois déjà importés sont conservés.
9. **Donner les accès** : Paramètres → Accès → « Ajouter un compte » (rôle Lecteur ou
   Administrateur), puis partager l'URL de l'application. Tant que personne n'est ajouté, seul le
   déployeur peut l'ouvrir.

## Accès

- L'application s'exécute **avec le compte du déployeur** : les classeurs source et de données
  restent privés, inutile de les partager. Les visiteurs n'y accèdent qu'à travers l'application.
- Deux rôles, gérés dans **Paramètres → Accès** :
  - **Administrateur** : tout, y compris la synchronisation, les modifications (écrites dans la
    source pour le mois en cours), la source, le seuil de
    conformité et la liste des accès ;
  - **Lecteur** : consultation seulement (tableaux, graphiques, historique, comparaison, export CSV).
    Le serveur refuse toute écriture d'un lecteur, même appelée hors de l'interface.
- **Saisie dans l'application** (Paramètres) : trois interrupteurs, pour tous les administrateurs et tous
  les mois (en cours comme passés), sur les postes et les applications : « Modifier les entrées » (cellules
  des tableaux, Galink et IDP compris, et « Renommer » une application), « Créer des entrées » (« Nouveau
  poste », « Poste générique », « Nouvelle application »), « Supprimer des entrées » (« Supprimer » une
  application ; les postes ne se suppriment pas depuis l'application). Tous activés par défaut. Un
  interrupteur désactivé masque ses boutons pour tous les administrateurs, et le serveur refuse aussi
  l'appel. Le suivi des actions, les remplacements, la synchronisation et les autres paramètres ne sont
  pas concernés. Les autres administrateurs voient le changement à leur prochaine écriture (refusée, la
  page se met à jour) ou dans les 10 minutes.
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
  propriétaire, qui doit pouvoir **voir les membres** du groupe (sinon l'ajout est refusé), puis mise en
  cache : un compte membre le reste 10 minutes après sa dernière utilisation de l'application, mais
  l'appartenance est revérifiée au moins **toutes les heures** ; un compte retiré d'un groupe dans Google
  perd donc ce rôle sous 1 heure au plus (sous 10 minutes s'il n'utilise pas l'application), un compte
  ajouté l'obtient sous 10 minutes. Un groupe devenu illisible (supprimé, membres masqués) ne donne
  aucun rôle et n'est réessayé qu'après 2 minutes. Le retrait d'un groupe de la liste s'applique
  immédiatement. Pour retirer un accès sur-le-champ, retirer le compte (ou le groupe) de la liste. Un administrateur ne peut pas retirer ni rétrograder le groupe qui
  lui donne ce rôle.
- « Autres comptes du domaine » : *Aucun accès* (par défaut, seuls les comptes listés entrent) ou
  *Lecteur* (tout le domaine peut consulter).
- Un compte non autorisé voit « Accès refusé » avec son adresse, à transmettre à un administrateur.
- La liste est stockée dans les propriétés du script (`ACCESS_JSON_N` et `ACCESS_JSON_0`, `_1`… : une
  propriété est limitée à 9 Ko), le seuil dans `COMPLIANCE_THRESHOLD` et les interrupteurs de saisie dans
  `EDITING_JSON` (`{"edit":true,"create":false,"delete":true}`) : Éditeur Apps Script → Paramètres du
  projet → Propriétés du script. Supprimer `ACCESS_JSON_N` remet l'accès au seul propriétaire ; supprimer
  `EDITING_JSON` (ou une valeur illisible) réactive les trois interrupteurs.
- **Icône d'onglet** (le fantôme) : `assets/favicon.png`, intégrée au code (URI `data:`), rien à
  héberger, le dépôt peut rester privé. Si l'onglet garde l'icône par défaut après le déploiement (Apps
  Script refuse alors l'URI `data:`, le journal d'exécution le dit), héberger le PNG (Google Sites, page
  publique, bucket…) et mettre son adresse dans la propriété du script `FAVICON_URL` (URL https se
  terminant par `.png` ou `.ico`) ; `-` pour n'en mettre aucune.
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
  (seul le mois en cours revient, à la synchronisation suivante ; l'historique, les actions et les
  remplacements sont perdus).
- Pour changer de classeur source : Paramètres → Source de données → « Changer de source ».
- Si la synchronisation échoue (source supprimée, droits retirés, onglet renommé), le bouton d'état
  en bas du menu de gauche passe en rouge avec le message, et Google envoie un e-mail d'échec au propriétaire
  du script. Les données affichées restent celles de la dernière synchronisation réussie.

## Mesurer les temps de réponse

Chaque appel serveur écrit une ligne JSON dans le journal des exécutions (Apps Script → Exécutions,
ou Cloud Logging) : `{"api":"api_getMonthData","ms":812,"authMs":95,"ok":true}`, précédée des étapes
(`{"stage":"ensure",…}` ouverture du classeur, `{"stage":"sheet","tab":"Postes","rows":7200,"ms":240}`
lecture d'un onglet entier, `{"stage":"span","tab":"Postes","rows":300,"ms":30}` lecture des seules lignes
d'un mois (ou du bas du journal), `listMonths`, `importMonth`, `writeBack`, `sync`). Ces lignes ne contiennent que
des durées, des nombres et des noms d'onglets ou de mois : jamais d'adresse e-mail ni de donnée. Le
détail des formats est dans `docs/API.md` §4 (Perf).

Côté navigateur, la console (niveau « Verbose » / « Commentaires », dans le cadre `userHtmlFrame`)
affiche `[rpc] api_getMonthData 1350ms` pour chaque appel et `[boot] ready …` à la fin du démarrage ;
l'écart avec le `ms` du serveur est le coût de `google.script.run` lui-même.

Ouverture à froid : `doGet` met déjà dans la page le démarrage du visiteur (`api_bootstrap`, contrôle
d'accès compris, ligne `{"stage":"inlineBoot","ok":true,"bytes":…}`) et la page demandée (`?page=`).
Le navigateur n'appelle donc pas `api_bootstrap` à l'ouverture : il demande aussitôt le mois affiché,
et en même temps, si une période est mémorisée, son premier mois et l'historique. Plotly (4,5 Mo) et
les polices se chargent sans bloquer : l'écran de démarrage et les chiffres s'affichent d'abord, les
graphiques dès que Plotly est là (« Graphique indisponible » s'il n'est pas là au bout de 30 secondes ;
s'il arrive plus tard, les graphiques de la page affichée apparaissent alors, sans action de l'utilisateur).

Pour décider d'une optimisation : relever une ouverture à froid admin, une ouverture lecteur, un
changement de mois, le Suivi temporel, une modification du mois en cours et une synchronisation
horaire, puis comparer ouverture du classeur, lectures d'onglets et aller-retour. Les nombres d'appels
Sheets de ces parcours sur un gros classeur sont fixés par `test/integration/perf.test.js`.

## À vérifier une fois sur de vrais Sheets

Les tests utilisent un faux SpreadsheetApp ; ce point dépend du comportement réel de Google Sheets.

- [ ] Les valeurs commençant par `=`, `+`, `-`, `@` ou `'` font l'aller-retour **sans
      modification** : créer une action dont le commentaire vaut successivement `=1+1`,
      `+33 6 00 00 00 00`, `- à faire`, `@jdupont`, `'apostrophe` ; recharger l'application ; la
      valeur affichée est identique, et dans `ShadowIT_AppData` → onglet `Actions`, la cellule
      contient le texte littéral (formule non évaluée, aucune apostrophe ajoutée). Même contrôle sur
      une valeur `-` du référentiel après une synchronisation.
- [ ] Écriture dans la source : modifier une cellule d'un poste du mois en cours, vérifier qu'elle
      change dans le classeur source ; une colonne calculée par formule est refusée avec un message ;
      une liste déroulante (validation des données) refuse une valeur hors liste, avec le message
      « Le Google Sheet source a refusé la valeur … » (le refus doit arriver à l'écriture de la cellule).
- [ ] Écriture dans la source, lectures ciblées : dans le tableau, modifier ensemble des postes éloignés
      les uns des autres (début, milieu et fin de l'onglet) : toutes les valeurs arrivent dans la source,
      aucune autre cellule ne change (formules, listes déroulantes, cellules voisines). La ligne
      `writeBack` d'Exécutions a un `sourceRead` nettement plus court qu'avant sur un gros onglet.
      Ajouter une application alors que la ligne sous la dernière application n'est pas vide (ligne de
      total) : une ligne est insérée au-dessus, les formules de la dernière ligne sont recopiées.
- [ ] Synchronisation hors verrou : sur un gros classeur source, lancer « Synchroniser maintenant » et,
      depuis une autre session, enregistrer aussitôt une modification du mois en cours : elle n'attend
      plus la lecture de la source. Une fois la synchronisation terminée, recharger : la modification
      est toujours là, dans l'application et dans la source (jamais annulée). Dans Exécutions, la ligne
      `importMonth` montre `readSource` avant `lockWait`, et `reread: true` (avec `rereadSource`) quand
      une écriture dans la source (ou une autre synchronisation) est arrivée pendant la lecture. Propriétés du script contient
      `SOURCE_WRITE_STAMP` après une modification du mois en cours (ce garde-fou suppose qu'après
      `SpreadsheetApp.flush()` une autre exécution qui ouvre la source voit l'écriture).
- [ ] Synchronisations qui se chevauchent : lancer « Synchroniser maintenant » depuis deux sessions
      presque en même temps (ou juste avant l'heure du déclencheur) en changeant une valeur directement
      dans la source entre les deux clics : à la fin, l'application montre la valeur la plus récente et
      le journal n'a pas de changement qui l'annule. La ligne `importMonth` de la synchronisation qui a
      pris le verrou en second montre `reread: true` ; `SOURCE_WRITE_STAMP` change après chaque
      synchronisation qui a écrit (ce garde-fou suppose que `LockService` et les Propriétés du script
      se comportent comme les faux : un verrou acquis voit la propriété écrite par le détenteur précédent).
- [ ] Lectures d'un mois pendant une écriture : sur un classeur de données dont l'onglet Applications a
      plus de 1000 lignes (aucune ligne vide en bas), supprimer une application du mois en cours dans
      une session pendant qu'une autre ouvre ce mois ou change de mois en boucle : jamais d'erreur
      « coordinates of the range are outside the dimensions of the sheet » (Exécutions), et après
      « Actualiser » les nombres sont justes (un mois relu pendant une synchronisation qui l'agrandit
      ne perd pas sa dernière application). Même essai avec le mois en cours tout en bas de l'onglet
      et une synchronisation qui lui ajoute une application pendant qu'une autre session change de
      mois en boucle : jamais une application en moins à l'écran ; la ligne `sheet` d'Applications
      (Exécutions) apparaît seulement quand la lecture a croisé l'écriture.
- [ ] Formulaires de création, lecture des règles : dans Exécutions, l'appel `api_getFormSchema` du mois
      en cours montre une ligne `formSchema` (`cache: "miss"`, puis `"hit"` au second appel dans les
      5 minutes, sans ouverture de classeur) avec des nombres seulement, aucun nom de colonne. Les listes
      déroulantes de la source sont proposées : `String(dv.getCriteriaType())` vaut bien `VALUE_IN_LIST` /
      `VALUE_IN_RANGE` (une liste « plage » du Référentiel donne ses valeurs, une plage ouverte comme
      `B2:B` aussi), une règle « Afficher un avertissement » n'est pas bloquante et « Refuser la saisie »
      l'est ; les colonnes à formule (Score conformité, Niveau de risque, Statut) et une colonne
      `ARRAYFORMULA` ne sont pas des champs. Ajouter une colonne dans la source puis « Relire les
      colonnes » : elle apparaît dans le formulaire.
- [ ] Formulaires de création, écriture de la ligne : créer un poste du mois en cours. La ligne arrive
      sous le dernier poste ; elle reprend les règles de validation de la ligne du dessus ; les formules
      recopiées décalent bien leurs références relatives (le score de la nouvelle ligne porte sur la
      nouvelle ligne) ; une colonne `ARRAYFORMULA` n'est jamais écrite (pas de `#REF!`). Avec une valeur
      refusée par une règle « plage » (une valeur hors du Référentiel), `setValues` échoue avec un message
      qui nomme la cellule : l'erreur s'affiche sous le bon champ et la source ne garde aucune ligne vide.
- [ ] Formulaires de création, valeurs calculées : juste après la création, le score, le niveau de
      risque et le statut du nouveau poste s'affichent dans le tableau (relus après `flush()`) ; une
      formule lente qui affiche encore « Loading… » laisse la valeur vide jusqu'à la synchronisation
      suivante, qui ne signale ensuite aucun changement.
- [ ] Formulaires de création, limites connues : une liste à choix multiples (puces) accepte des valeurs
      séparées par des virgules, ce qui n'est qu'une hypothèse (aucune API ne dit si une liste autorise
      plusieurs valeurs) ; les dates sont écrites en texte `JJ/MM/AAAA`, donc pour une source en
      paramètres régionaux français (comme les modifications de cellules) ; les modifications de
      cellules dans le tableau ont le même angle mort sur les colonnes `ARRAYFORMULA` (noté pour plus
      tard, non corrigé ici).
- [ ] Le déclencheur `syncHourly` apparaît dans l'éditeur (Déclencheurs) et s'exécute toutes les
      heures (Exécutions) ; une synchronisation sans changement n'ajoute rien au journal.
- [ ] Mesures : dans Exécutions, un appel (par exemple l'ouverture de l'application) montre ses lignes
      JSON (`ensure`, `listMonths`, `sheet`…, puis `{"api":…,"ms":…}`) en une ligne chacune, sans
      adresse e-mail ; une synchronisation horaire montre `importMonth` et `sync`. La durée totale de
      l'exécution reste du même ordre que le `ms` de la ligne `api` (le coût des lignes est négligeable).
- [ ] Console du navigateur (niveau « Verbose », cadre `userHtmlFrame`) : une ligne `[rpc] <nom> <ms>ms`
      par appel et `[boot] ready …` au démarrage, aucune erreur.
- [ ] Lecture d'un seul mois : changer de mois ; dans Exécutions, l'appel `api_getMonthData` montre des
      lignes `span` (Postes, Applications, ImportLog avec `rows` = 1, Referentiel) et aucune ligne
      `sheet` ; une synchronisation horaire sans changement non plus. Ajouter une application à un mois
      passé (elle est écrite en fin d'onglet, après les mois suivants), recharger : elle apparaît dans
      ce mois et dans aucun autre, et le mois suivant reste complet.
- [ ] Version du schéma : après la première ouverture, Propriétés du script contient
      `DATA_SCHEMA_VERSION` (`{"dataId":…,"version":"2"}`, l'id du classeur de données) ; la ligne
      `ensure` d'un appel suivant est plus courte (plus de lecture de `Meta`). Supprimer la propriété :
      l'appel suivant relit `Meta` une fois et la recrée. Si une ancienne version du classeur de données
      est restaurée (historique des versions), supprimer aussi cette propriété pour que la mise à niveau
      du schéma soit refaite.
- [ ] Paramètres → Journal des synchronisations : les 12 dernières synchronisations, la plus récente en
      haut, avec leurs alertes ; l'appel `api_getImportLog` ne lit que le bas de l'onglet `ImportLog`
      (ligne `span`, `rows` = 12).
- [ ] Titre de la source sans ouverture : dans Exécutions, l'appel `api_bootstrap` d'un admin (dans
      l'exécution `doGet` à l'ouverture, seul après « Actualiser ») ne montre plus qu'une ouverture (le
      classeur de données ; ligne `ensure`) ; les liens « Données » et
      « Source » de la barre latérale ouvrent les bons classeurs (URL construites à partir des ids).
      Renommer le classeur source dans Drive : le nouveau nom apparaît après la synchronisation horaire
      suivante (ou « Synchroniser maintenant ») ; Propriétés du script contient `SOURCE_INFO`
      (`{"id":…,"title":…}`). Retirer au propriétaire l'accès à la source : Paramètres affiche
      « Classeur inaccessible. » (vérification en direct), l'ouverture de l'application reste rapide.
- [ ] Cache des groupes : un membre d'un groupe autorisé entre ; le retirer du groupe dans Google
      Admin : il perd l'accès au plus tard 1 heure après la dernière vérification, même en utilisant
      l'application sans arrêt (10 minutes s'il ne l'utilise pas). L'ajouter à un groupe : accès sous
      10 minutes. Un groupe aux membres masqués pour le propriétaire refuse l'accès sans erreur, et un
      seul avertissement « not readable » apparaît dans Exécutions par compte toutes les 2 minutes.
      Vérifier que `CacheService.getScriptCache().getAll` est disponible (ce que les faux services ne
      peuvent prouver).
- [ ] Interrupteurs de saisie, deux administrateurs : A ouvre Postes, B désactive « Créer des entrées »
      dans Paramètres. A clique « Nouveau poste » (ou enregistre le formulaire déjà ouvert) : le message
      « La création de postes et d’applications est désactivée dans les Paramètres. » s'affiche et les
      boutons de création disparaissent sans recharger la page ; sans action de A, ils disparaissent au
      plus tard 10 minutes après (ou en rouvrant le panneau de synchronisation). Même chose pour
      « Modifier les entrées » avec une cellule modifiée non enregistrée (message, puis cellules en
      lecture seule et la notification « Modification des entrées désactivée : les modifications non
      enregistrées sont abandonnées. »). Propriétés du script : `EDITING_JSON` change à chaque bascule ;
      Exécutions montre une seule ligne `api_setEditing` par clic.
- [ ] Deux sessions admin : ajouter un compte différent dans Paramètres → Accès depuis chacune, à
      quelques instants d'intervalle (la seconde attend le verrou) ; après rechargement, la liste
      contient les deux comptes.
- [ ] Démarrage intégré à la page : à l'ouverture, Exécutions montre pour `doGet` les lignes
      `api_bootstrap` puis `{"stage":"inlineBoot","ok":true,…}`, et la console n'a **pas** de ligne
      `[rpc] api_bootstrap` (la première est `api_getMonthData`). Comparer la durée de l'exécution
      `doGet` et le temps d'apparition de l'écran de démarrage avant / après cette version.
- [ ] Un compte sans accès : `inlineBoot` avec `"ok":false`, puis l'écran « Accès refusé » (le
      navigateur a appelé `api_bootstrap` lui-même) ; un lecteur voit sa vue lecteur sans appel
      `api_bootstrap`.
- [ ] `…/exec?page=postes` ouvre directement Postes (et `?page=settings` pour un lecteur, le tableau de
      bord) ; « Actualiser » après une nouvelle synchronisation recharge bien les données (appel
      `api_bootstrap` dans la console).
- [ ] Le bac à sable HtmlService garde les `<script type="application/json">` et l'attribut
      `onload` de la feuille de polices : les polices IBM Plex s'appliquent (onglet Réseau : la feuille
      Google Fonts ne bloque plus le rendu) et Plotly n'est téléchargé qu'une fois (préchargement puis
      script, même URL).
- [ ] Plotly bloqué (DevTools → Réseau → bloquer `cdnjs.cloudflare.com`) : l'application démarre, les
      chiffres s'affichent et chaque graphique indique « Graphique indisponible ».
- [ ] Plotly très lent (DevTools → Réseau → limitation personnalisée, par exemple 100 kbit/s, pour que
      `plotly.min.js` mette plus de 30 secondes) : « Graphique indisponible » s'affiche au bout de
      30 secondes, puis les graphiques du tableau de bord apparaissent d'eux-mêmes à la fin du
      téléchargement, sans clic ; Plotly n'est demandé qu'une fois.

## Tests

```sh
npm test            # unitaires + intégration (Node, faux services Apps Script)
npm run test:e2e    # Playwright (Chromium) sur le client rendu avec un google.script.run simulé
npm run test:all    # les deux
```

`PERF_OUT=/chemin/mesure.json node --test test/integration/perf.test.js` enregistre en plus les
nombres d'appels mesurés (ouvertures, lectures, cellules lues, propriétés et cache) par parcours.

`test:e2e` attend Playwright installé globalement (`npm i -g playwright`) et ses navigateurs dans
`$PLAYWRIGHT_BROWSERS_PATH` (par défaut `/opt/pw-browsers`). Facultatif : `.artifacts/plotly.min.js`
et `.artifacts/fonts/` (non versionnés) permettent des captures avec le vrai Plotly et les vraies
polices ; sans eux, le harnais utilise des substituts.

### Sécurité (SAST / SCA)

`npm run security` lance localement les mêmes analyses que la CI (`.github/workflows/security.yml`) :
Semgrep (règles du registre + `security/semgrep.yml`), gitleaks (historique complet) et osv-scanner
(`package-lock.json`). Il faut `semgrep` (`pip install semgrep`), `gitleaks` et `osv-scanner` dans le
`PATH` ; un outil absent est signalé et ignoré. Les règles propres au projet tournent aussi dans
`npm test` (`test/integration/security.test.js`). Modèle de menace, résultats et exceptions :
[docs/SECURITY.md](docs/SECURITY.md).

## Correspondance avec l'application Streamlit

| Page Streamlit | Page web (`id`) | Fichier client |
|---|---|---|
| Tableau de bord (`Tableau_de_bord.py`) | `dashboard` | `src/js_page_dashboard.html` |
| Postes | `postes` | `src/js_page_postes.html` |
| Applications | `apps` | `src/js_page_apps.html` |
| Suivi temporel | `timeline` | `src/js_page_timeline.html` |
| Suivi actions | `actions` | `src/js_page_actions.html` |
| Lecture du Google Sheet, stockage | — | `src/Importer.js`, `src/Sync.js`, `src/Store.js` (serveur) |
| Calculs (scores, KPI, diff) | — | `src/Core.js` (partagé serveur/client) |

## Limites

- **6 minutes par exécution** Apps Script : une synchronisation lit et écrit un mois entier en un seul
  appel ; un classeur source très volumineux peut dépasser cette limite.
- **Durée des déclencheurs** : 90 min/jour (compte Gmail) ou 6 h/jour (Workspace) pour toutes les
  exécutions déclenchées ; une synchronisation horaire sans changement ne fait que lire la source, et
  elle la lit avant de prendre le verrou : les enregistrements ne l'attendent pas.
- **Comptes du domaine uniquement** : l'adresse des visiteurs d'un autre domaine n'est pas transmise
  par Google, ils ne peuvent donc pas être autorisés. Les écritures passent par un verrou (attente 20 s, sinon « Une autre opération est en cours. Réessayez dans quelques instants. »).
- Les modifications de code ne sont visibles sur l'URL publiée qu'après `npm run deploy`.
- Le navigateur doit pouvoir charger Plotly (cdnjs.cloudflare.com) et Google Fonts ; sans eux,
  l'application fonctionne avec « Graphique indisponible » à la place des graphiques et les polices
  système.
- Chaque mois ajoute une ligne par poste et par application au classeur de données (le mois en cours
  est réécrit, pas dupliqué) ; Google Sheets plafonne à 10 millions de cellules par classeur.

---

## English summary

Shadow IT Dashboard is a Google Apps Script web app (single HtmlService page) ported from a Streamlit
app. Server code lives in `src/*.js` (`Api`, `Importer`, `Sync`, `Store`, `Config`, `Core`, `Perf`, `Code`); client
code in `src/*.html`. A live source spreadsheet (`Suivi des postes`, `Suivi des applications`,
`Référentiel`) is synchronised every hour (time-driven trigger `syncHourly`) into the current month of the
app's own `ShadowIT_AppData` spreadsheet (tabs `Postes`, `Applications`, `Referentiel`, `Actions`,
`Replacements`, `ImportLog`, `Meta`); past months stay frozen. Edits of the current month made in the app
are written into the source first, so the next sync reads them back (Galink / IDP stay app-only).

First deployment: `npm install`; enable the Apps Script API at
<https://script.google.com/home/usersettings>; `npm run login`; create a project (in the browser, or
with `clasp create-script --type webapp` run in an empty directory, since it refuses an existing
`.clasp.json` and pulls default files into `rootDir`) and put its `scriptId` in `.clasp.json`;
`npm run push`; run `setup()` once in the editor to authorise; Deploy → New deployment → Web app
(execute as me, anyone in the domain); open the URL, paste the source sheet URL (the first sync runs at
once); then
grant access in Paramètres → Accès.

Access control: the app runs as the deployer with `access: DOMAIN` (deploy from a Google Workspace
account of the users' domain). Each caller is identified by `Session.getActiveUser()` and checked on
every server call: **admin** (everything, incl. Paramètres) or **lecteur** (read only); the deployer is
always admin and nobody can edit their own access. Paramètres › « Saisie dans l’application » has three
switches for every admin and every month (edit / create / delete postes and applications; the
`EDITING_JSON` script property, all on by default): a switch that is off hides its controls and the server
refuses the call (actions, remplacements and the sync are not concerned). Unlisted domain accounts get no access by default,
or lecteur if « Autres comptes du domaine » is set so. « Ajouter plusieurs comptes… » takes a pasted
list in any common shape (Sheets column, comma/semicolon separated, `Name <address>`), previews it and
saves it in one call (500 per batch, 2000 accounts max). Google Groups can be granted a role too:
members (sub-groups included, 3 levels) get it, the highest role wins, memberships are checked with
GroupsApp as the deployer (who must see the members) and cached: a membership slides 10 minutes past
its last use but is re-verified at least every hour (a removal from a group in Google applies within
1 h), a non-membership is cached 10 minutes, an unreadable group 2 minutes (it grants nothing), all of
a call's group entries are read in one `CacheService.getAll`, and a cache failure only means a live
check. After pulling this
version, run `setup()` again to grant the new groups scope. The list lives in the `ACCESS_JSON_N` /
`ACCESS_JSON_0..` script properties (split because one property holds 9 KB), the compliance threshold (default 80 %) in `COMPLIANCE_THRESHOLD`. For a personal Gmail
deployer, set `"access": "MYSELF"` in `src/appsscript.json`.

Updates: `DEPLOYMENT_ID=AKfy... npm run deploy` pushes and redeploys the same deployment, so the URL
stays stable (without `DEPLOYMENT_ID` a new deployment and URL are created). If the data
spreadsheet is really gone, delete the `DATA_SPREADSHEET_ID` script property. Verify once on real
Sheets that values starting with `= + - @ '` round-trip unchanged. Timing: every server call logs
one-line JSON timings (`{api, ms, authMs, ok}` plus per-stage lines, see `docs/API.md` §4 Perf) to the
Executions log, and the browser console logs `[rpc] <name> <ms>ms` at the Verbose level. Cold open:
doGet renders the visitor's bootstrap envelope (role check included; nothing when refused) and the
`?page=` into the page, so the client issues the month (and, with a saved period, its first month and the
history) at once; Plotly and the fonts load without blocking;
`test/integration/perf.test.js` pins the Sheets call counts of the main flows on a large data
spreadsheet. Server reads are scoped: one month's rows are located through column A and read as one
block (never every month), ImportLog is read from the bottom, reads are memoized per execution (dropped
on every write and when the script lock is taken), and the schema version is kept in the
`DATA_SCHEMA_VERSION` script property so that each call skips the `Meta` read. The admin bootstrap
does not open the source: spreadsheet URLs are built from the ids and the source title is kept in the
`SOURCE_INFO` script property (saved with the source, refreshed by every sync); Paramètres is where the
source is checked live. The sync reads the
source before taking the script lock (a `SOURCE_WRITE_STAMP` script property, moved by every
write-back, makes it read again under the lock when a save landed meanwhile), and a write-back reads
the header block, the key column and the edited rows only. Tests: `npm test`, `npm run test:e2e`. Limits: 6-minute execution time, users of the deployer's Workspace domain only.
