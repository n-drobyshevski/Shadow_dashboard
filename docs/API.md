# Shadow IT Dashboard (GAS) — Contract

This document is the **single source of truth** shared by the server (`src/*.js`) and the client
(`src/*.html`). Every name, argument and return shape below is binding. UI text is **French**; code,
identifiers and comments are **English**.

---------------------------------------------------------------------------------------------------
## 0. Ground rules

### Server (`src/*.js`, Apps Script V8)
- Apps Script concatenates all `.js` files into **one global scope**; load order is not guaranteed.
  Therefore:
  - every module is either a `function` declaration or `var X = (function () { ... })();`
  - **no top-level `const`/`let`/`class`**, and **no top-level code that touches another file**
    (IIFE bodies may only *define* functions; cross-file calls happen inside functions).
- Names ending in `_` are private (hidden from `google.script.run`). Only `api_*`, `doGet`,
  `include`, `coreScript`, `setup` are public functions.
- No `Date` object ever crosses `google.script.run`: every `api_*` takes **one JSON string** and
  returns **one JSON string** (see §3).
- OAuth scope: only `https://www.googleapis.com/auth/spreadsheets`. Do not use `Session`, `DriveApp`,
  `UrlFetchApp`, `MailApp`, etc.

### Files and ownership
| File | Module | Purpose |
|---|---|---|
| `src/Core.js` | `function CoreFactory_()` + `var Core = CoreFactory_();` | Pure logic, shared with client. **No GAS globals, no closures over outer scope.** |
| `src/Config.js` | `var Config` | Script Properties + constants (tab names, schemas). |
| `src/Store.js` | `var Store` | Data spreadsheet repository. Only module that writes to the data spreadsheet. |
| `src/Importer.js` | `var Importer` | Reads the live source spreadsheet and snapshots a month. |
| `src/Api.js` | global `api_*` functions + `apiWrap_` | `google.script.run` entry points. |
| `src/Code.js` | `doGet`, `include`, `coreScript`, `setup` | Web app entry + template helpers. |
| `src/index.html` | template | Shell; includes css + scripts. |
| `src/css.html` | `<style>` | All styles. |
| `src/js_api.html` | `window.api` | Promise wrapper around `google.script.run`. |
| `src/js_state.html` | `window.State` | Global state store. |
| `src/js_ui.html` | `window.UI` | DOM builder + components. |
| `src/js_charts.html` | `window.Charts` | Plotly wrappers. |
| `src/js_page_*.html` | `window.Pages.<id>` | One page each. |
| `src/js_main.html` | `window.App` | Router, sidebar, boot. **Included last.** |

---------------------------------------------------------------------------------------------------
## 1. Domain constants (exposed by `Core`)

```
Core.THRESHOLD           = 80
Core.KEY_POSTE           = 'Nom du poste'
Core.KEY_APP             = 'Nom du logiciel / service'
Core.GENERIC_POSTE_NAME  = 'Poste générique Decathlon'
Core.RISK_ORDER          = ['Critique', 'Élevé', 'Moyen', 'Faible']
Core.RISK_COLORS         = { 'Critique':'#e74c3c', 'Élevé':'#e67e22', 'Moyen':'#f39c12', 'Faible':'#2ecc71' }
Core.COLOR_OK            = '#2ecc71'
Core.COLOR_KO            = '#e74c3c'
Core.COLOR_THRESHOLD     = '#2c3e50'
Core.APP_REQUIRED_FIELDS = ['Éditeur','Type','Équipe','Installé sur poste','Niveau de risque','Données sensibles exposées']
Core.APP_CUSTOM_FIELDS   = ['Galink','IDP']           // app-only, not in the source sheet
Core.YES_NO_COLS         = ['Galink','IDP','Contrat','SIP','IT Decathlon','EDR Decathlon','Réseau Decathlon','Enrolée']
Core.POSTE_DIFF_COLS     = ['Score conformité','IT Decathlon','EDR Decathlon','Chiffrement disque','Type de compte',
                            'Réseau Decathlon','Action corrective','Statut','Niveau de risque']
Core.POSTE_TEMPLATE_KEYS = ['N° Visite','Date visite','Prochaine revue','Équipe','Bâtiment / Labo','Responsable',
                            'Nom du poste',"Date d'achat",'Criticité équipement','IT Decathlon','OS','Version OS',
                            'EDR Decathlon','Chiffrement disque','Type de compte','Réseau Decathlon','Score conformité',
                            'Niveau de risque','Action corrective','Responsable action','Deadline','Statut',
                            'Application','Commentaires','Enrolée']
Core.COLUMN_REF_ALIASES  = { 'Bâtiment / Labo': 'Bâtiment' }   // column -> Référentiel category
Core.ACTION_STATUSES     = ['À faire','En cours','Terminé','Abandonné']
Core.ACTION_PRIORITIES   = ['Haute','Moyenne','Basse']
Core.SOURCE_TABS         = { postes:'Suivi des postes', applications:'Suivi des applications', referentiel:'Référentiel' }
Core.ERROR_CODES         = ['NOT_CONFIGURED','MONTH_EXISTS','NOT_FOUND','BUSY','VALIDATION','SOURCE_ERROR','INTERNAL']
```

## 2. Core functions (pure; identical on server and client)

All functions are **total**: they never throw on null/undefined/blank input unless stated.

| Function | Signature / behaviour |
|---|---|
| `normKey(s)` | `String(s ?? '')` → NFC, NBSP(` `)→space, trim, collapse internal whitespace, lowercase. Used for header/tab/category matching. |
| `isBlank(v)` | `true` for `null`, `undefined`, `NaN`, or a string that is empty after trim. |
| `str(v)` | `isBlank(v) ? '' : String(v).trim()` |
| `parseScore(v)` | `"30,4%"`→30.4, `"25%"`→25, `"25"`→25, `"0,5"`→50, number `0.304`→30.4, number `85`→85, number in `[0,1]` → ×100 (so `1`→100), blank/unparseable → `null`. Strings: strip `%`, spaces/NBSP, comma→dot; if the original string contained `%` use as-is, else apply the same `[0,1]→×100` rule. |
| `makeError(code, message)` | returns an `Error` with `.code = code`. |
| `validateMonth(m)` | `/^\d{4}-(0[1-9]|1[0-2])$/` test → boolean. |
| `currentMonth(date)` | `'YYYY-MM'` from a Date (local getters). |
| `fmtDDMMYYYY(date)` | `'DD/MM/YYYY'` from a Date (local getters); `''` for invalid. |
| `frToIso(s)` | `'15/03/2025'`→`'2025-03-15'`; non-matching → `''`. |
| `isoToFr(s)` | `'2025-03-15'`→`'15/03/2025'`; non-matching → `''`. |
| `extractSpreadsheetId(urlOrId)` | Accepts a full Sheets URL (`/spreadsheets/d/<ID>/...`) or a bare ID (`[A-Za-z0-9-_]{20,}`) → ID string, else `null`. |
| `escapeFormula(v)` | If `v` is a string beginning with `=`, `+`, `-` or `@` → `"'" + v`; otherwise `v` unchanged. |
| `findHeaderRow(rows, anchors, maxScan=15)` | `rows` = 2D array. Returns the index of the first row (within `maxScan`) where some cell's `normKey` equals the `normKey` of any anchor; `-1` if none. |
| `rowsToRecords(opts)` | `opts = {display, raw, anchors, keyField, fmtDate}`. `display`/`raw` are same-shape 2D arrays (`raw` may be omitted). Finds header row via `findHeaderRow(display, anchors)`; if `-1` throws `makeError('SOURCE_ERROR', ...)`. Headers = `str(cell)` (NBSP→space, trimmed); columns with blank headers are dropped; duplicate headers get suffix `" (2)"`, `" (3)"`. For each data row: value = if `raw` cell is a `Date` → `fmtDate(rawCell)` (fallback `Core.fmtDDMMYYYY`), else `str(displayCell)`, with `''` stored as `null`. Rows where **all** values are null are dropped silently. Rows whose `keyField` is blank are dropped and counted. Returns `{headers:[...], records:[{header:value|null}], warnings:[string]}`; warning text (French) e.g. `"3 ligne(s) sans « Nom du poste » ignorée(s)"`. |
| `parseReferentiel(display)` | Transposed sheet: first non-empty row = category names; each column below = values (ragged, blanks skipped, trimmed, de-duplicated preserving order). Returns `{category:[values]}` (category key = trimmed header). |
| `scoreApplication(rec)` | `{score, criteria:{contrat, sip, idp, galink, champs}}` — each criterion boolean, 20 pts each: `str(Contrat)==='Oui'`, `str(SIP)==='Oui'`, `str(IDP)==='Oui'`, `str(Galink)==='Oui'`, all of `APP_REQUIRED_FIELDS` non-blank. |
| `enrichPostes(list)` | returns **new** objects: `{...rec, _score: parseScore(rec['Score conformité']), _conforme: _score !== null && _score >= 80}` |
| `enrichApplications(list)` | returns **new** objects: `{...rec, _score, _conforme: _score >= 80, _criteria}` from `scoreApplication`. |
| `uniqueSorted(list, field)` | distinct non-blank `str(rec[field])` values, sorted with `localeCompare('fr')`. |
| `filterData(data, filters)` | `data={postes, applications}`, `filters={equipes:[], batiments:[]}`. Équipe filter applies to **both** (`str(rec['Équipe'])` in list); Bâtiment filter (`'Bâtiment / Labo'`) applies to **postes only**. Empty array = no filter. Returns `{postes, applications}` (new arrays). |
| `computeKpis(postes, apps)` | Uses `_conforme`. Returns exactly: `total_postes, postes_conformes, postes_non_conformes, taux_postes, total_apps, apps_conformes, apps_non_conformes, taux_apps, postes_sans_edr, postes_non_it, postes_hors_reseau, apps_sans_sip, apps_sans_contrat, apps_sans_galink, apps_sans_idp`. `taux_*` are 0–100 floats (0 when total 0). `*_sans_*`/`*_non_*`/`hors_*` count `str(field)==='Non'` on `EDR Decathlon`, `IT Decathlon`, `Réseau Decathlon`, `SIP`, `Contrat`, `Galink`, `IDP`. |
| `riskCounts(list)` | `{Critique:n, Élevé:n, Moyen:n, Faible:n}` counting `str(rec['Niveau de risque'])` (other values ignored), keys in `RISK_ORDER` order. |
| `histogramBins(scores, nbins=10)` | Fixed range 0–100, equal-width bins; score 100 falls in the last bin; nulls ignored. Returns `[{x0, x1, count}]`. |
| `buildPosteAppsRelation(apps)` | Splits `'Installé sur poste'` on commas (trim, skip blanks). Returns `{relations:[{poste, application, equipe, score}], byPoste:{poste:[{application, equipe, score}]}, byApp:{application:[poste]}}`. `score` = `rec._score` if present else `scoreApplication(rec).score`. |
| `diffPostes(oldList, newList)` | Same semantics as the Python original, keyed by `Nom du poste` (first occurrence wins). Returns `{removed:[rec], added:[rec], changes:[{name, equipe, diffs:{col:{old, new}}}], resolved_actions:[{name, equipe, action, responsable}]}`. `changes` compares `POSTE_DIFF_COLS` with `str()`; `resolved_actions` = `Action corrective` non-blank in old and blank in new (equipe/responsable from old row's `Équipe`/`Responsable action`). Sorted by name. |
| `diffApplications(oldList, newList)` | Keyed by `Nom du logiciel / service`. Returns `{removed, added, resolved_actions}` (same rules). |
| `makeGenericPoste(templateKeys, existingNames)` | Record with every key in `templateKeys` (or `POSTE_TEMPLATE_KEYS` if empty) = `null`, `Nom du poste` = `GENERIC_POSTE_NAME`, `Commentaires` = `'Poste générique regroupant les applications non liées à un poste suivi individuellement.'`. Returns `null` if `GENERIC_POSTE_NAME` already in `existingNames`. |
| `mergeCarryOver(newRecs, prevRecs, keyField, fields)` | For each new record whose `fields[i]` is blank/absent, copy the value from the `prevRecs` record with the same `normKey(keyField)` if non-blank. Ensures every new record **has** each field (null if nothing). Returns `{records:[new objects], carried:n}` (`n` = number of field values copied). |
| `optionsForColumn(col, referentiel)` | Référentiel category whose `normKey` equals `normKey(COLUMN_REF_ALIASES[col] || col)` → its values; else `['Oui','Non']` if `col` in `YES_NO_COLS`; else `null` (free text). |
| `sortMonths(months)` | ascending, unique, only valid months. |
| `previousMonth(months, month)` | the latest month in `months` strictly before `month`, or `null`. |

---------------------------------------------------------------------------------------------------
## 3. Server API (`google.script.run`)

### Envelope
Every public `api_*` function: `api_xxx(argsJson: string) → string`.
- `argsJson` is a JSON string (`'null'` or `'{}'` when no args). Parse failure → `VALIDATION`.
- Return value is `JSON.stringify({ok:true, data})` or `JSON.stringify({ok:false, error:{code, message}})`.
- All wrapped by `apiWrap_(fn)` which catches errors: `err.code` in `Core.ERROR_CODES` → that code, else
  `INTERNAL`; message in French when produced by us; `console.error` the stack.
- Writes are performed inside `Store.withLock(fn)`; lock timeout (20 s) → `BUSY`.

### Record shapes
- **Poste / Application record** (as returned by the API): every source column (string or `null`) plus
  `_id` (uuid string), `_key` (string, value of the key column), `_order` (int, row order within the
  month), `_updated_at` (ISO string or `''`), and **enrichment**: `_score` (number|null),
  `_conforme` (bool); applications additionally `_criteria` (`{contrat,sip,idp,galink,champs}`) and
  always have `Galink` and `IDP` keys (`'Oui'|'Non'|null`). Records are returned sorted by `_order`.
- **Action**: `{id, target_type:'poste'|'application', target_name, equipe, action, responsable,
  date_created:'DD/MM/YYYY', date_completed:'DD/MM/YYYY'|'', deadline:'DD/MM/YYYY'|'', priorite,
  status, source_month:'YYYY-MM'|'', comment, recorded_at:'YYYY-MM-DD', updated_at:'YYYY-MM-DD'|''}`
  (all strings).
- **Replacement**: `{id, old_poste, new_poste, equipe, responsable, date_replacement:'DD/MM/YYYY',
  comment, recorded_at:'YYYY-MM-DD'}` (all strings).
- **ImportLog entry**: `{month, imported_at:'YYYY-MM-DD HH:mm', source_id, counts:{postes, applications,
  referentiel}, postes_headers:[...], apps_headers:[...], warnings:[...]}`.

### Functions

| Function | Args | Returns `data` | Errors |
|---|---|---|---|
| `api_bootstrap` | – | `{configured:bool, months:['YYYY-MM' asc], latestMonth:'YYYY-MM'|'', currentMonth:'YYYY-MM', dataUrl, sourceUrl:''|url, sourceTitle:''}` | – (creates the data spreadsheet if needed) |
| `api_setConfig` | `{source:'url or id'}` | `{sourceId, sourceTitle, sourceUrl, tabsFound:{postes:bool, applications:bool, referentiel:bool}}` | `VALIDATION` (bad id), `SOURCE_ERROR` (cannot open / no postes+apps tab). Saved only on success. |
| `api_getMonthData` | `{month}` | `{month, postes:[rec], applications:[rec], referentiel:{cat:[v]}, columns:{postes:[h], applications:[h]}, importInfo:{imported_at, warnings:[]}\|null}` | `VALIDATION`, `NOT_FOUND` (month not imported). `columns.applications` always ends with `Galink`, `IDP` if missing from the source headers. |
| `api_importMonth` | `{month, overwrite:bool}` | `{month, counts:{postes, applications, referentiel}, overwritten:bool, carriedOver:n, warnings:[...]}` | `NOT_CONFIGURED`, `VALIDATION`, `MONTH_EXISTS` (month already imported and `overwrite` false), `SOURCE_ERROR` |
| `api_getImportLog` | – | `[ImportLog entry]` newest first | – |
| `api_savePostes` | `{month, changes:[{id, updates:{col:value}}]}` | `{updated:[rec]}` | `VALIDATION` (keys starting with `_` or the key column are rejected), `NOT_FOUND` |
| `api_addGenericPoste` | `{month}` | `{created:bool, record:rec}` (existing record if already present) | `NOT_FOUND` |
| `api_saveApplications` | `{month, changes:[{id, updates}]}` | `{updated:[rec]}` | as `api_savePostes` |
| `api_addApplication` | `{month, record:{...}}` | `rec` | `VALIDATION` (blank name, or name already exists in month — compared with `normKey`) |
| `api_deleteApplication` | `{month, id}` | `{deleted:true, id}` | `NOT_FOUND` |
| `api_renameApplication` | `{month, id, newName}` | `{record:rec, actionsUpdated:n}` — also renames `target_name` of every Action with `target_type==='application'` and `target_name===oldName` | `VALIDATION` (blank / duplicate), `NOT_FOUND` |
| `api_getTimeline` | – | `[{month, postes:[slim], applications:[slim]}]` asc by month. Slim poste = `{'Équipe','Bâtiment / Labo','EDR Decathlon','IT Decathlon','Réseau Decathlon','Niveau de risque',_score,_conforme}`; slim app = `{'Équipe','SIP','Contrat','Galink','IDP','Niveau de risque',_score,_conforme}` (so `Core.filterData` / `computeKpis` / `riskCounts` work on them). | – |
| `api_getActions` | – | `{actions:[Action], replacements:[Replacement]}` | – |
| `api_addAction` | `{target_type, target_name, equipe, action, responsable?, date_created?, date_completed?, deadline?, priorite?, status?, source_month?, comment?}` | `Action` (`id` generated, `status` default `'À faire'`, `date_created` default today DD/MM/YYYY, `recorded_at` today ISO) | `VALIDATION` (`target_type` not poste/application, blank `target_name` or `action`) |
| `api_updateAction` | `{id, updates}` | `Action` (`updated_at` = today) | `NOT_FOUND`, `VALIDATION` (`id`/`recorded_at` not updatable) |
| `api_deleteAction` | `{id}` | `{deleted:true, id}` | `NOT_FOUND` |
| `api_addReplacement` | `{old_poste, new_poste, equipe?, responsable?, date_replacement?, comment?}` | `Replacement` | `VALIDATION` (blank old/new) |
| `api_updateReplacement` | `{id, updates}` | `Replacement` | `NOT_FOUND` |
| `api_deleteReplacement` | `{id}` | `{deleted:true, id}` | `NOT_FOUND` |
| `api_getDiff` | `{oldMonth, newMonth}` | `{oldMonth, newMonth, postes:Core.diffPostes(...), applications:Core.diffApplications(...)}` (records enriched) | `VALIDATION`, `NOT_FOUND` |

The **complete list** of public API functions (used by the contract test) is exactly:
`api_bootstrap, api_setConfig, api_getMonthData, api_importMonth, api_getImportLog, api_savePostes,
api_addGenericPoste, api_saveApplications, api_addApplication, api_deleteApplication,
api_renameApplication, api_getTimeline, api_getActions, api_addAction, api_updateAction,
api_deleteAction, api_addReplacement, api_updateReplacement, api_deleteReplacement, api_getDiff`

---------------------------------------------------------------------------------------------------
## 4. Server internals

### Config (`src/Config.js`)
```
Config.PROP_DATA_ID   = 'DATA_SPREADSHEET_ID'
Config.PROP_SOURCE_ID = 'SOURCE_SPREADSHEET_ID'
Config.DATA_SPREADSHEET_NAME = 'ShadowIT_AppData'
Config.TABS = { postes:'Postes', applications:'Applications', referentiel:'Referentiel',
                actions:'Actions', replacements:'Replacements', importLog:'ImportLog', meta:'Meta' }
Config.SCHEMAS = {
  Postes:       ['_month','_id','_key','_order','_json','_updated_at'],
  Applications: ['_month','_id','_key','_order','_json','_updated_at'],
  Referentiel:  ['_month','category','position','value'],
  Actions:      ['id','target_type','target_name','equipe','action','responsable','date_created','date_completed',
                 'deadline','priorite','status','source_month','comment','recorded_at','updated_at'],
  Replacements: ['id','old_poste','new_poste','equipe','responsable','date_replacement','comment','recorded_at'],
  ImportLog:    ['month','imported_at','source_id','counts_json','postes_headers_json','apps_headers_json','warnings_json'],
  Meta:         ['key','value']
}
Config.SCHEMA_VERSION = '1'
Config.get()                 -> {dataId:''|id, sourceId:''|id}
Config.setDataId(id), Config.setSourceId(id)
Config.today()               -> 'YYYY-MM-DD'        (Utilities.formatDate, script time zone)
Config.todayFr()             -> 'DD/MM/YYYY'
Config.nowStamp()            -> 'YYYY-MM-DD HH:mm'
Config.uuid()                -> Utilities.getUuid()
```

### Store (`src/Store.js`) — the only writer to the data spreadsheet
Data spreadsheet layout: one tab per entry of `Config.SCHEMAS`, row 1 = header (frozen), data from row 2.
Every column is formatted as plain text (`'@'`) **on the exact range right before each write** (so
`'2026-05'` or `'15/03/2025'` are never auto-converted to dates) and every string value written passes
through `Core.escapeFormula`. (Sheets strips the leading `'` on read — the fake does the same.)
Reads use one `getDataRange().getValues()` per tab; whole-tab rewrites use `clearContents()` of the
data area + one `setValues()`.

```
Store.ensure()                          -> Spreadsheet  (open by Config dataId; if missing/unopenable
                                           create 'ShadowIT_AppData', save id; ensure every tab+header
                                           exists; write Meta schema_version). Idempotent. Cached per execution.
Store.dataUrl()                         -> string
Store.withLock(fn)                      -> fn() result; LockService.getScriptLock().waitLock(20000)
                                           (timeout -> makeError('BUSY')); SpreadsheetApp.flush() and
                                           releaseLock() in finally.
Store.readTab(tab)                      -> [object] (header->value, values as strings; '' for empty)
Store.writeTab(tab, objects)            -> void (rewrite all data rows in schema column order)
Store.listMonths()                      -> ['YYYY-MM'] asc unique (from ImportLog ∪ Postes ∪ Applications)
Store.hasMonth(month)                   -> bool
Store.readEntityMonth(tab, month)       -> [record] parsed from _json + {_id,_key,_order,_updated_at}, sorted by _order
Store.readEntityAll(tab)                -> {month:[record]} for all months
Store.replaceEntityMonth(tab, month, records, keyField)
                                        -> [record] stored (keeps other months' rows; assigns _id via
                                           Config.uuid() if missing, _order = index, _key = str(rec[keyField]))
Store.updateEntityRows(tab, month, changes)   changes=[{id, updates}] -> [record] updated;
                                           unknown id -> NOT_FOUND (nothing written). Sets _updated_at.
Store.appendEntityRow(tab, month, record, keyField) -> record (new _id, _order = max+1)
Store.deleteEntityRow(tab, month, id)   -> bool
Store.readReferentiel(month)            -> {cat:[values]} (ordered by position)
Store.replaceReferentiel(month, refObj) -> void
Store.getImportLog()                    -> [ImportLog entry] in insertion order (parsed json columns)
Store.appendImportLog(entry)            -> void
Store.latestImportInfo(month)           -> last ImportLog entry for month or null
Store.listRows(tab)                     -> [object] (Actions / Replacements)
Store.insertRow(tab, obj)               -> obj
Store.updateRow(tab, id, updates)       -> updated obj | NOT_FOUND
Store.deleteRow(tab, id)                -> bool
Store.updateRowsWhere(tab, predicate, updater) -> n  (one read + one write)
```
`_json` holds the record **without** the `_`-prefixed fields and without enrichment.

### Importer (`src/Importer.js`)
```
Importer.openSource()       -> Spreadsheet (Config sourceId; '' -> NOT_CONFIGURED; open failure -> SOURCE_ERROR)
Importer.findTab(ss, name)  -> Sheet|null  (match by Core.normKey on sheet names)
Importer.readSource()       -> {sourceId, title, postes:{headers,records,warnings}|null,
                                applications:{...}|null, referentiel:{cat:[v]}|null}
                               Per tab: one getDataRange() then getValues() + getDisplayValues();
                               Date cells formatted 'dd/MM/yyyy' in ss.getSpreadsheetTimeZone().
                               Missing postes AND applications tab -> SOURCE_ERROR.
Importer.importMonth(month, overwrite) -> api_importMonth data (see §3). Inside Store.withLock.
                               Carry-over of Galink/IDP via Core.mergeCarryOver from (a) the existing
                               snapshot of the same month when overwriting, else (b) Core.previousMonth.
```

### Code (`src/Code.js`)
```
doGet(e)        -> HtmlService.createTemplateFromFile('index').evaluate()
                   .setTitle('Shadow IT — Tableau de bord')
                   .addMetaTag('viewport','width=device-width, initial-scale=1')
include(name)   -> HtmlService.createHtmlOutputFromFile(name).getContent()
coreScript()    -> 'var Core = (' + CoreFactory_.toString() + ')();'   (output must not contain '</script')
setup()         -> Store.ensure(); logs data spreadsheet URL. Run once from the editor to authorize.
```

---------------------------------------------------------------------------------------------------
## 5. Client

### Template (`src/index.html`)
Only the scriptlet form `<?!= fn('arg') ?>` is used (so the Node renderer stays trivial). Order:
```html
<!DOCTYPE html><html lang="fr"><head><base target="_top"><meta charset="utf-8">
<?!= include('css') ?>
<script src="https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.35.3/plotly.min.js"></script>
</head><body>
<div id="app"> … sidebar (#sidebar) + main (#main) … </div>
<div id="toast-root"></div><div id="modal-root"></div>
<script><?!= coreScript() ?></script>
<?!= include('js_api') ?>  <?!= include('js_state') ?>  <?!= include('js_ui') ?>  <?!= include('js_charts') ?>
<?!= include('js_page_dashboard') ?> <?!= include('js_page_postes') ?> <?!= include('js_page_apps') ?>
<?!= include('js_page_timeline') ?> <?!= include('js_page_actions') ?>
<?!= include('js_main') ?>
</body></html>
```
Each `js_*.html` file is a single `<script>…</script>` block wrapping an IIFE that assigns to `window.*`.
**Never** put untrusted data in `innerHTML`; use `UI.el` (textContent) everywhere.

### `window.api` (`js_api.html`)
```
api.call(name, args?) -> Promise<data>
   google.script.run.withSuccessHandler(s => parse envelope).withFailureHandler(e => reject)[name](JSON.stringify(args ?? null))
   ok:false  -> reject(err) where err = new Error(message), err.code = code
   transport failure -> err.code = 'TRANSPORT'
```

### `window.State` (`js_state.html`)
```
State.get()                      -> state object (do not mutate directly)
State.set(patch)                 -> shallow merge + notify subscribers (fn(state, changedKeys[]))
State.subscribe(fn)              -> unsubscribe()
state = { page:'dashboard', configured:false, months:[], month:'', currentMonth:'', dataUrl:'', sourceUrl:'',
          sourceTitle:'', filters:{equipes:[], batiments:[]}, loading:false }
State.loadMonth(month, {force}?) -> Promise<monthData>  (api_getMonthData; cached per month)
State.getMonthData(month)        -> cached monthData | null
State.patchRecords(month, entity:'postes'|'applications', records[]) -> replace by _id in cache (re-enrich with Core)
State.removeRecord(month, entity, id)
State.addRecord(month, entity, record)
State.invalidate(month?)         -> drop one/all cached months (also the timeline/actions caches)
State.filtered(monthData)        -> Core.filterData({postes, applications}, state.filters)
State.loadTimeline({force}?)     -> Promise<timeline> (cached)
State.loadActions({force}?)      -> Promise<{actions, replacements}> (cached)
State.refreshBootstrap()         -> Promise (api_bootstrap -> sets configured/months/... ; keeps month if still valid else latest)
```

### `window.UI` (`js_ui.html`)
```
UI.el(tag, attrs?, ...children) -> Element
    attrs: class, id, style (object or string), dataset (object), on<Event> (function), any other
    attribute via setAttribute; `text` sets textContent. children: Node | string | number | null |
    false | arrays (flattened); strings become text nodes.
UI.clear(node)
UI.fmtPct(n, digits=1)    -> '30,4 %' (fr-FR); '—' for null
UI.fmtNum(n)              -> fr-FR integer
UI.badge(text, tone)      -> span.badge.badge-<tone>   tone: 'ok'|'ko'|'warn'|'info'|'neutral'
UI.scoreBadge(score)      -> badge with fmtPct, tone ok if >= 80 else ko, neutral if null
UI.riskBadge(level)       -> badge colored with Core.RISK_COLORS
UI.card({title, value, sub?, tone?})       -> metric card
UI.section(title, ...children)             -> section with h2
UI.empty(text)                             -> empty-state block
UI.toast(message, type='info'|'success'|'error')
UI.modal({title, body:Node, actions:[{label, primary?, danger?, onClick:(close)=>any}], wide?}) -> {close}
UI.confirm(message, {title?, okLabel?, danger?}) -> Promise<bool>
UI.formModal({title, fields:[{name, label, type:'text'|'textarea'|'select'|'date'|'month', options?, value?,
              required?, placeholder?, allowCustom?}], submitLabel?}) -> Promise<values|null>
    type 'date' shows <input type=date> but the value in/out is 'DD/MM/YYYY' (Core.frToIso/isoToFr).
    'select' with allowCustom renders <input list> + <datalist>.
UI.drawer({title, body:Node}) -> {close}       (right-side panel)
UI.tabs(items:[{id, label, render:(root)=>void}], activeId?) -> Element
UI.multiSelect({label, options:[string], value:[string], onChange:(values)=>void}) -> Element
UI.select({label?, options:[string|{value,label}], value, onChange}) -> Element
UI.editableTable({columns, rows, rowKey='_id', search=true, pageSize=50, onSave?, onRowClick?, emptyText?,
                  toolbar?:[Node]}) -> {node, setRows(rows), getDirty()}
    columns: [{key, label?, editable?:bool, options?:[string]|null, width?, render?:(row)=>Node|string,
               sortValue?:(row)=>any}]
    Click on an editable cell -> inline <select> (options + current value + '' ) or <input>; edits are
    kept as dirty until "Enregistrer (n)" -> onSave(changes:[{id, updates}]) (Promise); "Annuler" reverts.
    Sorting by header click, text search across visible columns, pagination.
UI.spinner()              -> Element
UI.downloadCsv(filename, columns:[string], rows:[object])   (client-side CSV export, ';' separator, BOM)
```

### `window.Charts` (`js_charts.html`)
All draw into a container element, use `{responsive:true, displayModeBar:false}`, French labels, and
fall back to `UI.empty('Graphique indisponible')` when `window.Plotly` is missing.
```
Charts.gauge(el, value, {height=250})                 -> indicator gauge, bar Core.COLOR_OK if value>=80 else
                                                         COLOR_KO, threshold line at 80 (COLOR_THRESHOLD)
Charts.riskBars(el, counts /* Core.riskCounts */)     -> bar per RISK_ORDER, colors RISK_COLORS, no legend
Charts.histogram(el, scores:[number])                 -> 10 bins on 0–100, vline at 80 dashed, annotation 'Seuil 80%'
Charts.line(el, {x:[labels], series:[{name, y:[number|null], color?}], threshold?:80, yTitle?, yRange?})
Charts.bars(el, {x:[labels], y:[numbers], colors?, yTitle?, horizontal?})
Charts.heatmap(el, {x:[labels], y:[labels], z:[[number|null]], zmin=0, zmax=100, title?})
Charts.purge(el)
```

### Pages
`window.Pages = window.Pages || {}`; each page file registers
`Pages.<id> = { id, title, icon, mount(root), unmount?() }` with ids and titles:

| id | icon | title |
|---|---|---|
| `dashboard` | 👻 | Tableau de bord |
| `postes` | 💻 | Postes |
| `apps` | 📦 | Applications |
| `timeline` | 📈 | Suivi temporel |
| `actions` | 📋 | Suivi actions |

`mount(root)` receives the cleared `#main` element. Pages read `State.get()` (month, filters), call
`State.loadMonth(...)`/`api.call(...)`, and render with `UI`/`Charts`. `App` re-mounts the current page
(after calling `unmount`) whenever `month`, `filters` or `page` change, and after `App.refresh()`.

### `window.App` (`js_main.html`)
```
App.go(pageId)        -> navigate (also google.script.history.push({page}) when available)
App.refresh()         -> re-mount current page
App.boot()            -> called on DOMContentLoaded: State.refreshBootstrap(); if !configured show the
                         configuration screen (paste source sheet URL -> api_setConfig); render sidebar.
```
Sidebar: app title `👻 Shadow IT`, nav links (5 pages), `Période` month select (asc list, default latest),
`Filtres` with `Équipe` and `Bâtiment / Labo` multiselects (options from current month postes via
`Core.uniqueSorted`), footer links "Données (Google Sheet)" → `dataUrl`, "Source" → `sourceUrl`
(target `_blank`), and a "⚙️ Source" button to change the source (configuration modal).

---------------------------------------------------------------------------------------------------
## 6. Page specifications

### Tableau de bord (`dashboard`) — 1:1 port of `Tableau_de_bord.py`
- No months → warning `Aucune donnée importée.` + import panel only.
- Title `👻 Tableau de bord — Shadow IT`, caption `Export : <month>`.
- 4 metric cards: `Postes inventoriés`, `Postes conformes` (sub = taux %), `Applications inventoriées`,
  `Applications conformes` (sub = taux %). KPIs computed with `Core.computeKpis` on filtered data.
- Gauges `Conformité des postes` / `Conformité des applications`.
- Risk bars `Risques — Postes` / `Risques — Applications`.
- `Détail conformité`: Postes (Sans EDR, Non IT Decathlon, Hors réseau Decathlon), Applications (Sans SIP,
  Sans contrat, Sans Galink, Sans IDP).
- Histograms `Distribution des scores — Postes` / `— Applications`.
- `📥 Importer depuis Google Sheets`: month input (default `currentMonth`), button `📥 Importer`; on
  `MONTH_EXISTS` → `UI.confirm('Le mois X existe déjà. Ré-importer écrase les postes, applications et le référentiel de ce mois (Galink/IDP sont conservés). Continuer ?', {danger:true})` → retry with
  `overwrite:true`. Success toast `✅ Import réussi : N postes, M applications`, then
  `State.invalidate()` + `State.refreshBootstrap()` + select imported month. Show warnings. Below: last 5
  import log entries.

### Postes (`postes`)
- Header with counts; toolbar: search, `Conformité` select (Toutes / Conformes / Non conformes),
  `➕ Poste générique` (api_addGenericPoste), `⬇️ CSV` export.
- `UI.editableTable` over filtered postes; columns = `columns.postes` order (key column first, not
  editable) + computed `Score` (`UI.scoreBadge`) + `Applis` count; options via `Core.optionsForColumn`.
  onSave → `api_savePostes` → `State.patchRecords`.
- Row click → drawer: score, conformity criteria (IT, EDR, Chiffrement, Type de compte, Réseau), installed
  applications (from `Core.buildPosteAppsRelation(apps).byPoste` + the poste's own `Application` column),
  linked actions (State.loadActions filtered by target poste) with `➕ Action` button (formModal →
  api_addAction with target_type 'poste', source_month = month).

### Applications (`apps`)
- Same layout; computed `Score` + criteria badges; `Galink`/`IDP` editable Oui/Non; toolbar `➕ Application`
  (formModal: name, Éditeur, Type, Équipe, Installé sur poste, Contrat, SIP, Données sensibles exposées,
  Niveau de risque, Galink, IDP → api_addApplication).
- Small summary row: counts Galink Oui/Non/vide and IDP Oui/Non/vide (migration readiness).
- Drawer: 5-criteria checklist (✅/❌), postes it is installed on, linked actions + `➕ Action`, buttons
  `✏️ Renommer` (formModal → api_renameApplication) and `🗑️ Supprimer` (confirm → api_deleteApplication).

### Suivi temporel (`timeline`)
- `State.loadTimeline()`; apply `Core.filterData` with current filters per month; `Core.computeKpis` per month.
- Line chart `Taux de conformité (%)` with series Postes / Applications and threshold 80.
- Bar/line chart of counts (inventoriés vs conformes) per month.
- Heatmap `Conformité des postes par équipe` (équipes × months, % conformes).
- KPI table per month (all KPIs) with delta vs previous month.
- Fewer than 2 months → info `Au moins deux exports mensuels sont nécessaires pour visualiser une évolution.` (still show the single month).

### Suivi actions (`actions`) — `UI.tabs`
1. `Actions de remédiation`: filters (statut, type, équipe, search), counts per status, table (target, type,
   équipe, action, responsable, priorité, deadline (overdue → ko badge), statut badge, dates).
   `➕ Nouvelle action` / row click → formModal edit → api_updateAction; delete with confirm.
   Quick status change select in-row is optional.
2. `Remplacements de postes`: table + `➕ Remplacement` (formModal: old poste (datalist from postes of the
   current month), new poste, équipe, responsable, date, comment) + edit/delete.
3. `Détection des changements`: two month selects (default previous → current; disabled with info when < 2
   months) → api_getDiff → sections: Postes retirés, Postes ajoutés, Modifications (table: poste, équipe,
   champ, ancien → nouveau), Actions résolues (button `✔️ Enregistrer comme terminée` → api_addAction with
   status 'Terminé', date_completed today, source_month newMonth, disabled once an identical action
   exists); same for Applications (retirées / ajoutées / actions résolues).

---------------------------------------------------------------------------------------------------
## 7. Tests

- `test/fixtures/data.js` — canonical sample data (two months, référentiel, actions, replacements).
- `test/fixtures/source.js` — `buildSourceSheets(month)` → fake live spreadsheet definition (banner row,
  header row, Date cells, `0.304` raw vs `'30,4%'` display, empty/ghost rows) built from `data.js`.
- `test/helpers/gasFakes.js` — in-memory `SpreadsheetApp`, `PropertiesService`, `LockService`,
  `Utilities`, `HtmlService`, `Logger`.
- `test/helpers/gasSandbox.js` — `loadGas({sources})` → `vm` context with fakes + every `src/*.js`
  loaded in alphabetical order (proves load-order independence).
- `test/helpers/render.js` — renders `src/index.html` (scriptlets `include`/`coreScript`) to static
  HTML; optional injection of `test/fixtures/mockRun.js` + data for the browser.
- `test/fixtures/mockRun.js` — browser `google.script.run` mock implementing every `api_*` from §3
  over in-memory data from `data.js` (records enriched with `Core`), recording calls in
  `window.__calls`.
- `npm test` → `test/unit/**` + `test/integration/**`; `npm run test:e2e` → Playwright smoke tests.
