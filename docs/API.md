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
  `include`, `coreScript`, `setup` and `syncHourly` (the time-driven trigger handler: a trigger cannot
  call a private function) are public functions.
- No `Date` object ever crosses `google.script.run`: every `api_*` takes **one JSON string** and
  returns **one JSON string** (see §3).
- OAuth scopes: only `https://www.googleapis.com/auth/spreadsheets`,
  `https://www.googleapis.com/auth/userinfo.email` (for `Session.getActiveUser()` /
  `getEffectiveUser()`), `https://www.googleapis.com/auth/groups` (`GroupsApp` membership checks) and
  `https://www.googleapis.com/auth/script.scriptapp` (the hourly sync trigger).
  `Session`, `GroupsApp` and `CacheService` are used **only** in `src/Access.js`, `ScriptApp` **only** in
  `src/Sync.js`. Do not use `DriveApp`, `UrlFetchApp`, `MailApp`, etc.
- Web app: `executeAs: USER_DEPLOYING`, `access: DOMAIN`. Identity and roles are checked in-app (§4 Access).

### Files and ownership
| File | Module | Purpose |
|---|---|---|
| `src/Core.js` | `function CoreFactory_()` + `var Core = CoreFactory_();` | Pure logic, shared with client. **No GAS globals, no closures over outer scope.** |
| `src/Config.js` | `var Config` | Script Properties + constants (tab names, schemas). |
| `src/Access.js` | `var Access` | Caller identity (Session) and roles. Only module that reads `Session`. |
| `src/Store.js` | `var Store` | Data spreadsheet repository. Only module that writes to the data spreadsheet. |
| `src/Importer.js` | `var Importer` | Reads the live source spreadsheet, snapshots a month, writes the current month's edits back into the source. |
| `src/Sync.js` | `var Sync` | Hourly synchronisation of the current month (trigger, status). Only module that uses `ScriptApp`. |
| `src/Perf.js` | `var Perf` | One-line JSON timing logs (`console.log`), see §4 Perf. |
| `src/Api.js` | global `api_*` functions + `apiWrap_` | `google.script.run` entry points. |
| `src/Code.js` | `doGet`, `include`, `coreScript`, `setup` (+ private `inlineBoot_`, `inlinePage_`, `inlineJson_`) | Web app entry + template helpers. |
| `src/index.html` | template | Shell; includes css + scripts. |
| `src/css.html` | `<style>` | All styles. |
| `src/js_api.html` | `window.api` | Promise wrapper around `google.script.run`. |
| `src/js_state.html` | `window.State` | Global state store. |
| `src/js_ui.html` | `window.UI` | DOM builder + components. |
| `src/js_charts.html` | `window.Charts` | Plotly wrappers. |
| `src/js_page_*.html` | `window.Pages.<id>` | One page each (incl. `settings`, admin only). |
| `src/js_main.html` | `window.App` | Router, sidebar, app bar (période + filtres), boot. **Included last.** |

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
Core.ERROR_CODES         = ['NOT_CONFIGURED','MONTH_EXISTS','NOT_FOUND','BUSY','VALIDATION','SOURCE_ERROR','FORBIDDEN','INTERNAL']
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
| `PERIOD_PRESETS` | `['month','last3','last6','year','all']` — period shortcuts of the app bar. |
| `addMonths(month, n)` | `'YYYY-MM'` moved by `n` months (negative = earlier); `''` for an invalid month. |
| `monthsInRange(months, from, to)` | months of `months` within `[from, to]` (inclusive, sorted; reversed range swapped; one end = one month). |
| `presetPeriod(months, preset)` | `{from, to}` ending at the latest month: `month` (alone), `last3` / `last6` (calendar months, first available inside), `year` (its calendar year), `all`. `null` without months / unknown preset. |
| `scoreEvolution(oldList, newList, keyField)` | per record (key `normKey`) between two snapshots: `{byKey:{key:{status:'new'\|'up'\|'down'\|'same', from, to}}, added, changed, removed:[old records]}` on `_score` (a change < 0.05 point is none). |
| `threshold()` | effective compliance threshold used by `enrichPostes` / `enrichApplications` (default `THRESHOLD`). |
| `isEmail(v)` | plausible address (string, ≤ 254 chars, one `@`, a dot in the domain, no spaces / `<>(),;:"`). |
| `parseEmailList(text)` | pasted text → `{emails:[unique, lower-cased, in order], invalid:[tokens with '@' that are not addresses]}`; accepts lines, `,` `;` tab / space separators, `Name <a@b.c>`, quotes, `mailto:`; words without `@` are ignored. |
| `validateThreshold(v)` | integer 1–100 (number or digit string) → that number, else `null`. |
| `setThreshold(v)` | sets the effective threshold (invalid → `THRESHOLD`); returns it. Server: every api call, from Script Properties. Client: from `api_bootstrap`. |

---------------------------------------------------------------------------------------------------
## 3. Server API (`google.script.run`)

### Envelope
Every public `api_*` function: `api_xxx(argsJson: string) → string`.
- `argsJson` is a JSON string (`'null'` or `'{}'` when no args). Parse failure → `VALIDATION`.
- Return value is `JSON.stringify({ok:true, data})` or `JSON.stringify({ok:false, error:{code, message}})`.
- All wrapped by `apiWrap_(fn, name, minRole)` which first checks the caller's role
  (`Access.requireRole(minRole)`: `FORBIDDEN` when the identity is not passed, the account has no access,
  or a lecteur calls an admin endpoint) and applies the effective threshold (`Core.setThreshold`), then
  catches errors: `err.code` in `Core.ERROR_CODES` → that code, else `INTERNAL`; message in French when
  produced by us; `console.error` the stack. Every call ends with one timing line
  `{api, ms, authMs, ok, code?}` (§4 Perf). Every call starts with empty per-execution read memos
  (`Store.clearMemo_()`, `Config.clearMemo_()`, §4): one call = one execution in Apps Script, and the
  reset keeps the test sandbox, which runs many calls in one context, honest.
- Roles: **lecteur** endpoints = `api_bootstrap`, `api_savePrefs`, `api_getMonthData`, `api_getSyncStatus`,
  `api_getImportLog`, `api_getTimeline`, `api_getActions`, `api_getDiff`. Every other endpoint is **admin** only.
- **Current month = live.** The month of today (Europe/Paris) follows the source spreadsheet: the hourly sync
  re-imports it, and every edit of that month (`api_savePostes`, `api_saveApplications`, `api_addGenericPoste`,
  `api_addApplication`, `api_deleteApplication`, `api_renameApplication`) is written into the source FIRST
  (`Importer.writeEdits` / `appendRecord` / `deleteRecord`), then into the snapshot, under the same lock. Past
  months are frozen history: their edits change the snapshot only. Fields without a source column (Galink /
  IDP) stay app-only.
- Writes are performed inside `Store.withLock(fn)`; lock timeout (20 s) → `BUSY`. The sync is the one
  writer that does its slowest read outside the lock: it reads the source first, then takes the lock to
  compare and write (`Importer.importMonth`, §4), so saves do not wait behind a sync that changes nothing.

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
  referentiel}, postes_headers:[...], apps_headers:[...], warnings:[...], changes:Changes|null}` — one entry per
  synchronisation that changed something (`changes` is `null` for the manual imports of earlier versions).
- **Changes**: `{created:bool, postes:Diff, applications:Diff, referentiel:bool}`, `Diff = {added, removed,
  changed, values}` (records matched by key with `normKey`; `changed` counts records, `values` the cells that
  differ; a pure row-order change is not a change).
- **SyncStatus**: `{enabled:bool, month:'YYYY-MM' (current month), lastRunAt, lastOkAt, lastChangeAt
  ('YYYY-MM-DD HH:mm' | ''), lastChange:{month, at, created, postes:Diff, applications:Diff, referentiel}|null,
  lastError:{at, code, message}|null, warnings:[string], authError?:string}` (`SYNC_STATE` Script Property;
  `authError` only from `api_getSettings` / `api_setConfig` when the deployer has not granted the ScriptApp scope).

### Functions

| Function | Args | Returns `data` | Errors |
|---|---|---|---|
| `api_bootstrap` | – | `{configured:bool, months:['YYYY-MM' asc], latestMonth:'YYYY-MM'|'', currentMonth:'YYYY-MM', dataUrl, sourceUrl:''|url, sourceTitle:'', threshold:int, user:{email, role:'admin'|'lecteur', isOwner:bool}, prefs:{sidebar?, period?}, sync:SyncStatus}` (`dataUrl` / `sourceUrl` / `sourceTitle` are `''` for lecteurs: the spreadsheets are private to the deployer). Never opens the source: the URLs are built from the ids and `sourceTitle` is the stored one (`SOURCE_INFO`, refreshed by every sync; `''` until the first sync on a deployment that predates it), so it can be one sync old and says nothing about access — Paramètres checks the source live. | – (creates the data spreadsheet if none is configured). Like every endpoint: `INTERNAL` ('Classeur de données inaccessible…') when the configured data spreadsheet cannot be opened. |
| `api_savePrefs` | `{sidebar:'open'\|'collapsed', period:'month'\|'last3'\|'last6'\|'year'\|'all'}` (any subset of the known keys) | `{prefs}` = the caller's stored preferences. Every role (lecteurs included): interface state only, per account (`PREFS_<email>` Script Property). | `VALIDATION` (unknown key or value, nothing to save, no identity) |
| `api_setConfig` | `{source:'url or id'}` | `{sourceId, sourceTitle, sourceUrl, tabsFound:{postes:bool, applications:bool, referentiel:bool}, sync:SyncStatus}` — also creates the hourly trigger (`sync.authError` when ScriptApp is not authorised; the source is saved anyway). The client then calls `api_syncNow`. | `VALIDATION` (bad id), `SOURCE_ERROR` (cannot open / no postes+apps tab). Saved only on success. |
| `api_getMonthData` | `{month}` | `{month, postes:[rec], applications:[rec], referentiel:{cat:[v]}, columns:{postes:[h], applications:[h]}, importInfo:{imported_at, warnings:[]}\|null}` | `VALIDATION`, `NOT_FOUND` (month not imported). `columns.applications` always ends with `Galink`, `IDP` if missing from the source headers. |
| `api_getSyncStatus` | – | `SyncStatus` | – |
| `api_syncNow` | – | `{status:SyncStatus, result:SyncResult}` — synchronises the current month now. `SyncResult = {month, counts:{postes, applications, referentiel}, overwritten:bool, carriedOver:n, warnings:[...], changed:bool, changes:Changes}`; nothing is written when `changed` is false. | `NOT_CONFIGURED`, `SOURCE_ERROR`, `BUSY` (recorded in `lastError`, except `BUSY`) |
| `api_enableSync` | – | as `api_syncNow`, after creating the hourly trigger if it is missing | `NOT_CONFIGURED` (ScriptApp not authorised: the deployer must run `setup` in the editor), then as `api_syncNow` |
| `api_getImportLog` | `{limit?}` (integer 1–500, default 12) | `[{month, imported_at, counts, warnings, changes}]`: the `limit` latest ImportLog entries, newest first, with the fields the « Journal des synchronisations » shows only (no `source_id`, no headers). Read from the bottom of the tab (`Store.recentImportLog`). | `VALIDATION` (bad `limit`) |
| `api_savePostes` | `{month, changes:[{id, updates:{col:value}}]}` | `{updated:[rec], sourceUpdated:bool}` (`true` = current month, written into the source) | `VALIDATION` (keys starting with `_` or the key column are rejected; a source cell computed by a formula; a value refused by the source cell's data validation), `NOT_FOUND`, `SOURCE_ERROR` (row not found in the source: renamed or deleted since the last sync) |
| `api_addGenericPoste` | `{month}` | `{created:bool, record:rec}` (existing record if already present; current month: also appended to the source) | `NOT_FOUND` |
| `api_saveApplications` | `{month, changes:[{id, updates}]}` | `{updated:[rec], sourceUpdated:bool}` | as `api_savePostes` |
| `api_addApplication` | `{month, record:{...}}` | `rec` (current month: also appended to the source tab, below its last application) | `VALIDATION` (blank name, or name already exists in month or in the source — compared with `normKey`) |
| `api_deleteApplication` | `{month, id}` | `{deleted:true, id}` (current month: its source row is deleted too, when there is one) | `NOT_FOUND` |
| `api_renameApplication` | `{month, id, newName}` | `{record:rec, actionsUpdated:n}` — also renames `target_name` of every Action with `target_type==='application'` and `target_name===oldName`; current month: the source key cell too | `VALIDATION` (blank / duplicate), `NOT_FOUND`, `SOURCE_ERROR` |
| `api_getTimeline` | – | `[{month, postes:[slim], applications:[slim]}]` asc by month. Slim poste = `{'Équipe','Bâtiment / Labo','EDR Decathlon','IT Decathlon','Réseau Decathlon','Niveau de risque',_score,_conforme}`; slim app = `{'Équipe','SIP','Contrat','Galink','IDP','Niveau de risque',_score,_conforme}` (so `Core.filterData` / `computeKpis` / `riskCounts` work on them). | – |
| `api_getActions` | – | `{actions:[Action], replacements:[Replacement]}` | – |
| `api_addAction` | `{target_type, target_name, equipe, action, responsable?, date_created?, date_completed?, deadline?, priorite?, status?, source_month?, comment?}` | `Action` (`id` generated, `status` default `'À faire'`, `date_created` default today DD/MM/YYYY, `recorded_at` today ISO) | `VALIDATION` (`target_type` not poste/application, blank `target_name` or `action`) |
| `api_updateAction` | `{id, updates}` | `Action` (`updated_at` = today) | `NOT_FOUND`, `VALIDATION` (`id`/`recorded_at` not updatable) |
| `api_deleteAction` | `{id}` | `{deleted:true, id}` | `NOT_FOUND` |
| `api_addReplacement` | `{old_poste, new_poste, equipe?, responsable?, date_replacement?, comment?}` | `Replacement` | `VALIDATION` (blank old/new) |
| `api_updateReplacement` | `{id, updates}` | `Replacement` | `NOT_FOUND` |
| `api_deleteReplacement` | `{id}` | `{deleted:true, id}` | `NOT_FOUND` |
| `api_getDiff` | `{oldMonth, newMonth}` | `{oldMonth, newMonth, postes:Core.diffPostes(...), applications:Core.diffApplications(...)}` (records enriched) | `VALIDATION`, `NOT_FOUND` |
| `api_getSettings` | – | `{threshold, defaultThreshold:80, source:{id, url, title, tabsFound\|null}, dataUrl, access:AccessView, me:email, sync:SyncStatus}` (`sync.enabled` checked against the real triggers). The live check of the app: opens the source (`tabsFound:null` = not accessible, `title` then the stored one); `url` / `dataUrl` are built from the ids, the data spreadsheet is not opened. | – |
| `api_setThreshold` | `{threshold}` | `{threshold}` | `VALIDATION` (not an integer 1–100) |
| `api_saveUser` | `{email, role:'admin'\|'lecteur'}` | `AccessView` (adds or changes the role) | `VALIDATION` (bad email / role, the owner, or the caller's own account) |
| `api_addUsers` | `{emails:[string] (1–500), role}` | `{access:AccessView, added:[email], updated:[email] (role changed), skipped:[{email, reason}]}` — one write; invalid addresses, duplicates, the owner, the caller and accounts that already have that role are skipped with a reason | `VALIDATION` (role, empty / too long list, more than 2000 accounts) |
| `api_removeUser` | `{email}` | `AccessView` | `VALIDATION` (as above), `NOT_FOUND` |
| `api_saveGroup` | `{email, role}` | `AccessView` (adds a Google Group or changes its role) | `VALIDATION` (bad role; group unknown or its members not visible to the owner; more than 50 groups; the change would remove the caller's admin role) |
| `api_removeGroup` | `{email}` | `AccessView` | `NOT_FOUND`, `VALIDATION` (the caller would lose admin) |
| `api_setDomainRole` | `{role:'none'\|'lecteur'}` | `AccessView` | `VALIDATION` |

`AccessView` = `{owner:email, users:[{email, role, added_at:'YYYY-MM-DD', added_by:email}] sorted by email
(owner excluded), groups:[same shape] sorted by email, domainRole:'none'|'lecteur'}`. Emails are trimmed and lower-cased.

The **complete list** of public API functions (used by the contract test) is exactly:
`api_bootstrap, api_savePrefs, api_setConfig, api_getMonthData, api_getSyncStatus, api_syncNow, api_enableSync,
api_getImportLog, api_savePostes,
api_addGenericPoste, api_saveApplications, api_addApplication, api_deleteApplication,
api_renameApplication, api_getTimeline, api_getActions, api_addAction, api_updateAction,
api_deleteAction, api_addReplacement, api_updateReplacement, api_deleteReplacement, api_getDiff,
api_getSettings, api_setThreshold, api_saveUser, api_addUsers, api_removeUser, api_setDomainRole,
api_saveGroup, api_removeGroup`

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
  ImportLog:    ['month','imported_at','source_id','counts_json','postes_headers_json','apps_headers_json','warnings_json',
                 'changes_json'],
  Meta:         ['key','value']
}
Config.SCHEMA_VERSION = '2'   (2: ImportLog.changes_json)
Config.PROP_SCHEMA    = 'DATA_SCHEMA_VERSION'  (JSON {dataId, version}: the schema version found in that data
                        spreadsheet's Meta tab, so Store.ensure's fast path needs no Meta read; keyed by the id,
                        so a new DATA_SPREADSHEET_ID never inherits it. Deleting it only costs one Meta read.)
Config.PROP_THRESHOLD = 'COMPLIANCE_THRESHOLD'      (integer 1–100 as a string)
Config.PROP_ACCESS    = 'ACCESS_JSON'  ({users:[{email, role, added_at, added_by}], domainRole} as JSON split in
                        3000-char parts ACCESS_JSON_0.. with the count in ACCESS_JSON_N; Config.MAX_USERS = 2000)
Config.get({fresh?})         -> {dataId:''|id, sourceId:''|id, sourceTitle:''|title stored for sourceId
                                 (PROP_SOURCE_INFO), threshold:int (Core.THRESHOLD when unset),
                                 schemaVersion:''|version recorded for dataId (PROP_SCHEMA),
                                 access:{users:[...], domainRole:'none'|'lecteur'}} (unreadable JSON -> empty list)
                                A new object on every call, built from ONE getProperties per execution (memo);
                                `fresh` reads the properties again. The memo is dropped by every setter below,
                                by Config.clearMemo_() (start of each api_* call and of syncHourly,
                                Store.resetCache_) and when Store.withLock acquires the lock, so every
                                read-modify-write under the lock (access list, first-run creation) starts
                                from the stored values.
Config.setDataId(id), Config.setSourceId(id, title), Config.setThreshold(n), Config.setAccess(access)
                                (setSourceId writes the id and PROP_SOURCE_INFO in one setProperties call)
Config.PROP_SOURCE_INFO = 'SOURCE_INFO'  (JSON {id, title}: the source title api_bootstrap shows without
                        opening the file. Written by api_setConfig, refreshed by every import under the lock;
                        keyed by the source id, so another source never inherits it. Deleting it only hides
                        the title until the next sync.)
Config.rememberSourceTitle(id, title) -> bool  (Importer.importMonth, under the lock, with the title it read:
                                writes only when `id` is the configured source and the title changed)
Config.spreadsheetUrl(id)    -> 'https://docs.google.com/spreadsheets/d/<id>/edit' (links without opening files)
Config.PROP_SOURCE_STAMP = 'SOURCE_WRITE_STAMP'  (source write stamp: a number moved forward by every
                        execution that wrote into the source spreadsheet, and by every import that writes
                        a snapshot; see Store.withLock and Importer.importMonth. Deleting it is harmless:
                        at worst one extra source read.)
Config.sourceStamp()         -> '' | stamp, from the memo (under the lock: the stored value, since withLock
                                drops the memo; outside it: possibly older, which only causes an extra read)
Config.bumpSourceStamp()     -> new stamp = max(Date.now(), previous + 1), never a value seen before. Called
                                under the lock only: by Store.withLock (after a write-back) and by
                                Importer.importMonth (before writing a snapshot).
Config.setSchemaVersion(dataId, version)   (Store.ensure, once Meta is known to carry `version`)
Config.PROP_PREFS_PREFIX = 'PREFS_'  (+ lower-cased email: JSON of that account's interface preferences)
Config.PREF_VALUES    = {sidebar:['open','collapsed']}
Config.getPrefs(email) -> {} | {sidebar}  (from the same memo)
Config.setPrefs(email, patch) -> merged with the stored value (fresh read), stored, returned
Config.PROP_FAVICON   = 'FAVICON_URL'  (optional https URL of the tab icon; '-' = none)
Config.faviconUrl()          -> FAVICON_URL when it is an https URL, '' for '-', else DEFAULT_FAVICON_URL
                                (assets/favicon.png embedded as a data:image/png;base64 URI).
                                doGet calls HtmlOutput.setFaviconUrl with it (errors logged, never thrown).
Config.today()               -> 'YYYY-MM-DD'        (Utilities.formatDate, script time zone)
Config.todayFr()             -> 'DD/MM/YYYY'
Config.nowStamp()            -> 'YYYY-MM-DD HH:mm'
Config.uuid()                -> Utilities.getUuid()
```

### Access (`src/Access.js`)
```
Access.ROLES = ['admin','lecteur'];  Access.DOMAIN_ROLES = ['none','lecteur']
Access.ownerEmail()          -> Session.getEffectiveUser() email (the deployer), lower-cased
Access.activeEmail()         -> Session.getActiveUser() email ('' when Google does not pass it: other domain)
Access.roleOf(email, owner, access) -> 'admin' for the owner, else the highest of: listed role, roles of the
                               Google Groups the account belongs to, 'lecteur' if domainRole is lecteur; '' = none
Access.isGroupMember(group, email) -> GroupsApp hasUser, sub-groups up to 3 levels (cycle-safe, ≤ 30 calls),
                               cached in CacheService under 'grp:<group>|<email>':
                                 'm:<ms of the live check>' member: GROUP_CACHE_S = 600 s, renewed on every hit
                                   (sliding) but checked live again GROUP_MAX_AGE_S = 3600 s after the live check
                                   at the latest (a removal from the group applies within 1 h);
                                 'n' not a member: 600 s, fixed (an addition applies within 10 min);
                                 'e' group not readable (gone, members hidden, quota): GROUP_ERROR_CACHE_S = 120 s,
                                   fixed; denies (false) like the live error it stands for.
                               Any other value is a miss. roleOf reads the entries of every group the call may
                               need in ONE CacheService getAll; a cache failure (read or write) only means a live
                               GroupsApp check, never an access granted.
Access.checkGroup(v)         -> normalised group email, or VALIDATION if unknown / members hidden from the owner
Access.currentUser(access?)  -> {email, role, isOwner, owner}
Access.requireRole(minRole, access?) -> currentUser or FORBIDDEN
Access.checkEmail(v) / Access.checkRole(v, allowed?) -> normalised value or VALIDATION
```
The owner is always admin and never stored; nobody can edit their own access (no self lock-out).

### Store (`src/Store.js`) — the only writer to the data spreadsheet
Data spreadsheet layout: one tab per entry of `Config.SCHEMAS`, row 1 = header (frozen), data from row 2.
Every column is formatted as plain text (`'@'`) **on the exact range right before each write** (so
`'2026-05'` or `'15/03/2025'` are never auto-converted to dates, and `'=…'` is stored as text, never
evaluated). Strings are written **verbatim**: `Core.escapeFormula` is NOT applied by the Store, because
in a plain-text cell Sheets keeps a leading `'` as a literal character (it is only the hidden
"force text" prefix in non-plain-text cells), so a prefix would turn `'- x'`, `'+33…'`, `'@user'` or a
Référentiel `'-'` into `"'- x"`… on read. The `'@'` format is the one and only formula guard; the fake
mimics this (plain-text cells store strings verbatim, other cells strip one leading `'`).
Reads: a whole tab with one `getDataRange().getValues()`; one month of `Postes` / `Applications` /
`Referentiel` with column A (one narrow read, shared with `listMonths`) + one `getValues()` of the rows
from the month's first to its last row, plus the row on each side of them when the sheet has it (rows of
other months inside that block — a record appended after a later month — are filtered out by
`row[0] === month`). These reads run outside the lock: when the block no longer matches column A, when a
row on either side of it is now that month (the month grew or moved past the block), or when the sheet
no longer has the block's last row (rows deleted meanwhile; `getMaxRows()` is asked only when the block
ends on the last row column A had), the whole tab is read instead; `ImportLog` from the bottom. Writes: the smallest contiguous changed block with one `setValues()` (+ one `clearContent()` when
a tab shrinks).

**Read memo (per execution).** Whole-tab reads, column A and month blocks are memoized per tab for the
current execution and shared with the callers, who copy before changing anything (`readTab` returns new
objects, records are parsed anew). A tab's memo is dropped by every write primitive on it (block write,
`clearContent`, row deletion), and the whole memo when `withLock` acquires the lock (another execution
may have written while this one waited), when `ensure()` maps the tabs, by `resetCache_()` and by
`clearMemo_()` (start of every `api_*` call and of `syncHourly`).

```
Store.ensure()                          -> Spreadsheet. Idempotent. Cached per execution.
                                           - no dataId configured: under Store.withLock, re-read the id (another
                                             execution may have created it) and otherwise create 'ShadowIT_AppData'
                                             and save its id;
                                           - dataId configured: openById, retried with Utilities.sleep backoff
                                             (500 ms, 1500 ms; 3 attempts). Still failing -> makeError('INTERNAL',
                                             'Classeur de données inaccessible…'); the property is NEVER replaced
                                             automatically (openById failures are often transient). Recovery for a
                                             really deleted file is explicit: delete the DATA_SPREADSHEET_ID
                                             script property, the next execution creates a new spreadsheet;
                                           - then ensure every tab+header exists and Meta schema_version is
                                             written. Fast path (all tabs + current schema version) takes no
                                             lock and writes nothing: getSheets() only when Config.get()
                                             .schemaVersion (PROP_SCHEMA, keyed by the data spreadsheet id) is
                                             current, else one Meta read (a current Meta version is then
                                             copied into the property). Any repair runs under Store.withLock
                                             and writes Meta and the property.
Store.dataUrl()                         -> Config.spreadsheetUrl(dataId): built from the configured id, the file
                                           is not opened (ensure() only when no id is configured yet)
Store.withLock(fn)                      -> fn() result; LockService.getScriptLock().waitLock(20000)
                                           (timeout -> makeError('BUSY')); drops the Store and Config read
                                           memos once acquired; SpreadsheetApp.flush(), then, when fn wrote
                                           into the source (noteSourceWrite) — even if fn or the flush
                                           failed — Config.bumpSourceStamp(), then releaseLock(), in
                                           finally. Re-entrant (only the outermost call flushes / bumps).
Store.noteSourceWrite()                 -> marks the current withLock as having written into the source
                                           (Importer write-back, before its first write); INTERNAL outside
                                           withLock
Store.clearMemo_()                      -> forgets the read memo (apiWrap_ / syncHourly start with it)
Store.resetCache_()                     -> clearMemo_ + drops the opened spreadsheet and Config's memo (a new
                                           execution, for tests)
Store.readTab(tab)                      -> [object] (header->value, values as strings; '' for empty)
Store.writeTab(tab, objects)            -> void (rewrite all data rows in schema column order)
Store.listMonths()                      -> ['YYYY-MM'] asc unique (from column A of ImportLog ∪ Postes ∪ Applications)
Store.hasMonth(month)                   -> bool
Store.tabMonths(tab)                    -> ['YYYY-MM'] asc: the months that have rows in `tab` (column A only)
Store.readEntityMonth(tab, month)       -> [record] parsed from _json + {_id,_key,_order,_updated_at}, sorted by
                                           _order; reads that month's block only
Store.readEntityAll(tab)                -> {month:[record]} for all months (whole tab: api_getTimeline)
Store.replaceEntityMonth(tab, month, records, keyField)
                                        -> [record] stored (keeps other months' rows; assigns _id via
                                           Config.uuid() if missing, _order = index, _key = str(rec[keyField]))
Store.updateEntityRows(tab, month, changes)   changes=[{id, updates}] -> [record] updated;
                                           unknown id -> NOT_FOUND (nothing written). Sets _updated_at.
                                           Reads and rewrites within the month's block only.
Store.appendEntityRow(tab, month, record, keyField) -> record (new _id, _order = max+1), appended after the
                                           last used row (reads the month's block only)
Store.deleteEntityRow(tab, month, id)   -> bool
Store.readReferentiel(month)            -> {cat:[values]} (ordered by position); reads that month's block only
Store.replaceReferentiel(month, refObj) -> void
Store.getImportLog()                    -> [ImportLog entry] in insertion order (parsed json columns; whole tab)
Store.recentImportLog(limit)            -> the `limit` latest entries, newest first: the last `limit` rows, then
                                           blocks twice as large while blank rows left fewer entries
Store.appendImportLog(entry)            -> void
Store.latestImportInfo(month)           -> last ImportLog entry for month or null, parsing that row only: the
                                           last 30 rows first unless column A is already memoized, then column
                                           A from the bottom and that one row (a row that no longer matches
                                           column A, or is past the end of the sheet -> whole tab). ImportLog
                                           is append-only and never pruned:
                                           the latest row of every month is what listMonths and the
                                           incomplete-import repair rely on.
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
Importer.importMonth(month, overwrite, {skipUnchanged?}) -> SyncResult (see §3). Notes
                               Config.sourceStamp(), reads the source (readSource) OUTSIDE the lock,
                               then takes Store.withLock (BUSY after 20 s, as before) to read the stored
                               month, compare and write; every read happens before the first write.
                               Lost-edit guard: under the lock, when the stamp moved (a write-back was
                               flushed since the outside read began) or the configured source changed,
                               the source is read again under the lock, so a live-month save that landed
                               in between is never reverted. Out-of-order guard: an import that writes
                               moves the same stamp (Config.bumpSourceStamp, under the lock, before its
                               first write), so of two overlapping runs (hourly trigger, api_syncNow,
                               api_enableSync) the one whose outside read is older reads the source again
                               instead of reverting the newer import. MONTH_EXISTS when the month
                               exists and !overwrite. With skipUnchanged, an overwrite that changes nothing
                               (records, headers, référentiel) writes nothing, not even the ImportLog.
                               « Poste générique Decathlon » is added to the postes when an application
                               names it in « Installé sur poste » and the source has no such poste.
                               Missing entity / Référentiel tab (the other entity tab present): the
                               stored snapshot of that month is KEPT (overwrite) or nothing is written
                               (new month) — never replaced by an empty one; a warning says so
                               ('… introuvable : applications du mois conservées.' / '… aucune
                               application importée.'), counts report the stored rows, and the
                               ImportLog keeps the previous headers for that entity.
                               Carry-over of Galink/IDP via Core.mergeCarryOver from (a) the existing
                               snapshot of the same month when overwriting, else (b) the latest
                               EARLIER month that has applications (empty snapshots are skipped).
                               Only those months are read (Store.readEntityMonth; (b) located with
                               Store.tabMonths and read only when needed), never the whole history.
                               When overwriting a month whose previous import is incomplete (no
                               ImportLog entry) or has no applications, a second mergeCarryOver pass
                               fills the fields still blank from (b) (warning 'L’import précédent du
                               mois X était incomplet : Galink/IDP repris de Y…' when incomplete).
                               Write order: Applications, Référentiel, Postes, then the ImportLog
                               entry (= completion marker).
Importer.writeEdits(entity, [{name, fields}]) -> cells written. entity 'postes'|'applications'; locates
                               each row by key (normKey) in the source tab, checks every cell first (row
                               found -> else SOURCE_ERROR; no formula -> else VALIDATION), then setValue per
                               cell (Core.escapeFormula: text stays text). Fields without a source column
                               are skipped (snapshot only). A value refused by data validation -> VALIDATION.
                               Writes stay one setValue per edited cell: a block setValues would rewrite
                               the cells between edited ones (formulas, validated cells, concurrent hand
                               edits) and lose the refused value in the message.
Importer.appendRecord(entity, rec) -> void. New source row just below the last record (inserted when that
                               row is not empty); formulas of the last record's row are copied down into
                               the columns the record leaves blank. Duplicate key -> VALIDATION.
Importer.deleteRecord(entity, name) -> bool (false when the source has no such row).
                               Reads of the three write-backs: getDataRange() for the size, the first 15
                               rows (header row, Core.findHeaderRow's scan depth) and the key column below
                               the header (getDisplayValues), then only what the write touches:
                               writeEdits the formulas of the edited rows (rows at most 5 apart in one
                               block; more than 3 blocks -> one block from the first to the last edited
                               row), appendRecord the row below the last record and that record's
                               formulas. Never the whole tab. All three run under Store.withLock
                               (re-entrant) and call Store.noteSourceWrite() before their first write.
```

### Sync (`src/Sync.js`)
```
Sync.currentMonth()   -> Config.today().slice(0, 7)
Sync.status()         -> SyncStatus (SYNC_STATE Script Property + month)
Sync.verifiedStatus() -> status with `enabled` checked against ScriptApp.getProjectTriggers(); never throws
                         (authError when ScriptApp is not authorised)
Sync.enable()         -> creates the 'syncHourly' trigger (timeBased().everyHours(1)) once; removes duplicates
Sync.run()            -> {status, result}: Importer.importMonth(currentMonth, true, {skipUnchanged:true});
                         records lastRunAt / lastOkAt / lastChangeAt + lastChange / lastError (not for BUSY)
Sync.runFromTrigger() -> run() when a source is configured; rethrows failures (Google e-mails the owner)
syncHourly()          -> (Code.js) the trigger handler: Sync.runFromTrigger()
```

### Perf (`src/Perf.js`)
Timing lines for the Apps Script Executions log / Cloud Logging: one `console.log(JSON.stringify(obj))`
each, carrying durations (ms, integers), counts, tab / API / stage names and month keys only (never an
e-mail address, an id or record contents). Stage lines are emitted when the stage completes; a failure
shows in the `{api, ok:false, code}` line (or the `sync` line for the hourly trigger).
```
Perf.log(obj)                    -> emits one line; never throws
Perf.start(stage, fields?)       -> timer {lap(name), end(extra?)}: lap adds the time since the previous
                                    lap to `name` (accumulates); end emits {stage, ms, <laps>, <fields>, <extra>} once
```
| Line | Emitted by |
|---|---|
| `{api, ms, authMs, ok, code?}` | `apiWrap_`, every `api_*` call (`authMs` = `Config.get` + role check, `null` when refused) |
| `{stage:'ensure', ms, open, ensureTabs, created}` | `Store.ensure`, first successful call of an execution |
| `{stage:'sheet', tab, rows, ms}` | every full read of a data tab (`Store` `readTable_`; memoized reads log nothing) |
| `{stage:'span', tab, rows, ms}` | every partial read of a data tab: one month's block (`Postes`, `Applications`, `Referentiel`), `ImportLog` rows read from the bottom or the one row of `latestImportInfo` |
| `{stage:'listMonths', ms, ImportLog, Postes, Applications, rows, months}` | `Store.listMonths` (one lap per tab) |
| `{stage:'sourceSheet', tab, rows, ms}` | `Importer.readSource`, per entity tab |
| `{stage:'importMonth', ms, readSource, lockWait, rereadSource?, dataReads, compare, writes?, flush, month, changed, reread}` | `Importer.importMonth` when it completes (`readSource` = the read outside the lock; `rereadSource` and `reread: true` when the source was read again under the lock; `writes` absent when nothing was written) |
| `{stage:'writeBack', ms, sourceOpen, sourceRead, cellWrites, op, entity}` | `Importer.writeEdits` (`op:'edit'`), `appendRecord` (`'append'`), `deleteRecord` (`'delete'`), when they complete |
| `{stage:'sync', ms, import, state, month, changed, ok:true}` / `{stage:'sync', ms, month, ok:false, code}` | `Sync.run` (hourly trigger and `api_syncNow` / `api_enableSync`) |
| `{stage:'inlineBoot', ms, ok, bytes}` | `inlineBoot_` (doGet: the bootstrap rendered into the page, after its own `{api:'api_bootstrap', …}` line; `ok:false, bytes:0` when nothing was inlined) |

Client side, `api.call` logs `[rpc] <name> <ms>ms` (plus the error code on failure) and `App.boot` logs
`[boot] ready <ms>ms (boot <ms>ms, first paint <ms>ms)` with `console.debug` (shown at the browser
console's « Verbose » level); the difference between `[rpc]` and the server's `{api, ms}` is the
`google.script.run` overhead and queueing.

### Code (`src/Code.js`)
```
doGet(e)        -> HtmlService.createTemplateFromFile('index') with template.page = e.parameter.page || '',
                   .evaluate().setTitle('Shadow IT — Tableau de bord')
                   .addMetaTag('viewport','width=device-width, initial-scale=1')
include(name)   -> HtmlService.createHtmlOutputFromFile(name).getContent()
coreScript()    -> 'var Core = (' + CoreFactory_.toString() + ')();'   (output must not contain '</script')
inlineBoot_()   -> (template, #boot-data) inlineJson_(api_bootstrap('null')) when that envelope is ok, else ''
                   (refused visitor, failure, exception: never throws). Goes through the WRAPPED api_bootstrap,
                   so the role check and its {api} timing line apply; then logs {stage:'inlineBoot', ms, ok, bytes}.
inlinePage_(p)  -> (template, #boot-page) JSON.stringify(p) for a NAV page id (dashboard, postes, apps, timeline,
                   actions, settings), else 'null'. Admin-only pages are filtered by the client.
inlineJson_(s)  -> JSON text safe inside <script>: < > & ' ` U+2028 U+2029 -> \uXXXX, / -> \/ (same value
                   for JSON.parse; neither '</script' nor '<!--' can appear)
setup()         -> Store.ensure(); Sync.enable(); logs data spreadsheet URL. Run once from the editor to authorize.
syncHourly()    -> Store.clearMemo_(); Config.clearMemo_(); Sync.runFromTrigger() (time-driven trigger, every hour)
```

---------------------------------------------------------------------------------------------------
## 5. Client

### Template (`src/index.html`)
Only printing function scriptlets are used, `<?!= fn() ?>`, `<?!= fn('arg') ?>` or `<?!= fn(templateVar) ?>`
(so the Node renderer stays trivial). Nothing in `<head>` blocks the scripts: the Google Fonts stylesheet
is `media="print" onload="this.media='all'"` (+ a `<noscript>` copy) and Plotly is only
`<link rel="preload" as="script">`ed — `Charts.ready()` runs it. Order:
```html
<!DOCTYPE html><html lang="fr"><head><base target="_top"><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?…" media="print" onload="this.media='all'"> + <noscript>
<link rel="preload" href="https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.35.3/plotly.min.js" as="script">
<?!= include('css') ?>
</head><body>
<div id="splash"> … </div>
<div id="app"> … sidebar (#sidebar) + .workspace (app bar #appbar + main #main) … </div>
<div id="toast-root"></div><div id="modal-root"></div>
<script type="application/json" id="boot-data"><?!= inlineBoot_() ?></script>      bootstrap envelope or ''
<script type="application/json" id="boot-page"><?!= inlinePage_(page) ?></script>  "postes" | null
<script><?!= coreScript() ?></script>
<?!= include('js_api') ?>  <?!= include('js_state') ?>  <?!= include('js_ui') ?>  <?!= include('js_charts') ?>
<?!= include('js_page_dashboard') ?> <?!= include('js_page_inventory') ?> <?!= include('js_page_postes') ?> <?!= include('js_page_apps') ?>
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
   every call   -> console.debug('[rpc] <name> <ms>ms[ <code>]') when it settles
```

### `window.State` (`js_state.html`)
```
State.get()                      -> state object (do not mutate directly)
State.set(patch)                 -> shallow merge + notify subscribers (fn(state, changedKeys[]))
State.subscribe(fn)              -> unsubscribe()
state = { page:'dashboard', configured:false, months:[], month:'', currentMonth:'', dataUrl:'', sourceUrl:'',
          sourceTitle:'', filters:{equipes:[], batiments:[]}, loading:false, threshold:80,
          user:{email:'', role:'', isOwner:false}, prefs:{}, sync:SyncStatus|null,
          from:'' (start of the period, '' = one month; `month` is its END), preset:'' (shortcut in use) }
State.period()                   -> {from, to, months:[synchronised months inside], single:bool} (to = state.month)
State.setPeriod(from, to, preset?) -> selects a period (reversed swapped; from === to = one month)
Fmt.monthShort('2026-04')        -> 'avr.'
Fmt.periodTitle(a, b)            -> 'Avril → octobre 2026' / 'Décembre 2025 → octobre 2026' ('Mai 2026' when a === b)
Fmt.periodShort(a, b)            -> 'Avr. – oct. 2026' / 'Déc. 2025 – oct. 2026' ('Mai 2026' when a === b)
UI.sparkline(values)             -> inline SVG line of a month series (aria-hidden), null under two points
Fmt.stamp('2026-05-04 10:30')    -> '10:30' today, '04/05 10:30' this year, else '04/05/2026 10:30'
Fmt.syncChange(changes)          -> '+2 postes · 1 application modifiée' / 'mois créé' / '' (Changes, §3)
State.canEdit()                  -> true for admins (pages hide every write control otherwise)
State.loadMonth(month, {force}?) -> Promise<monthData>  (api_getMonthData; cached per month)
State.getMonthData(month)        -> cached monthData | null
State.patchRecords(month, entity:'postes'|'applications', records[]) -> replace by _id in cache (re-enrich with Core)
State.removeRecord(month, entity, id)
State.addRecord(month, entity, record)
State.invalidate(month?)         -> drop one/all cached months (also the timeline/actions caches)
State.filtered(monthData)        -> Core.filterData({postes, applications}, state.filters)
State.loadMonth(month)           -> cached / shared pending request; a failure is handed once more to the next
                                    caller within 2 s (the page mounted after a month swap shows it, no 2nd call);
                                    any State.invalidate() clears every kept failure (« Réessayer » asks again).
State.loadTimeline({force}?)     -> Promise<timeline> (cached)
State.loadActions({force}?)      -> Promise<{actions, replacements}> (cached)
State.refreshBootstrap({useInline}?) -> Promise<state> (api_bootstrap -> sets configured/months/... ; keeps month if
                                    still valid else latest). The FIRST call of the page consumes #boot-data; with
                                    useInline (App.boot only) it answers from it when it holds an ok envelope, with
                                    no server call. Every other call asks the server (reload, retry, new source…).
State.takeInline(id)             -> JSON.parse of <script type="application/json" id=…> rendered by doGet, removing
                                    the element (read once); undefined when missing, empty or unreadable.
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
UI.asyncBlock(box, {load, render, placeholder?, error?, small?, errorId?, live?}) -> Promise (see js_ui.html)
UI.monthError(month)      -> {prefix:'Impossible de charger mai 2026', retry} for asyncBlock
UI.monthHeader({title, month, kickerId, actions?}) -> page header with the « Mai 2026 · Export 2026-05 » kicker
UI.noData(id)             -> empty state when no month is synchronised yet (admins: « Synchroniser maintenant »)
UI.filterNote(scope) / UI.plural(n, one, many) / UI.errorToast(err, context?)
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
All draw into a container element, use `{responsive:true, displayModeBar:false}` and French labels. Plotly
is not in `<head>`: a draw asked before it is loaded waits for `Charts.ready()` (only into an element still in
the page) and falls back to `UI.empty('Graphique indisponible')` when it could not be loaded. A build that
still arrives after the 30 s timeout redraws the charts that fell back and are still in the page.
```
Charts.ready()                                        -> Promise<Plotly>: adds the async plotly.min.js 2.35.3 script
                                                         once (memoized); a load error or no load within 30 s
                                                         rejects for the charts waiting then, and the script is
                                                         never requested again. If that script still runs after
                                                         the timeout, every later call resolves (later draws are
                                                         real charts) and the draws that fell back are run again
                                                         into the elements still in the page. Started by App.boot.
Charts.gauge(el, value, {height=250})                 -> indicator gauge, bar Core.COLOR_OK if value>=80 else
                                                         COLOR_KO, threshold line at 80 (COLOR_THRESHOLD)
Charts.riskBars(el, counts /* Core.riskCounts */)     -> bar per RISK_ORDER, colors RISK_COLORS, no legend
Charts.histogram(el, scores:[number])                 -> 10 bins on 0–100, vline at 80 dashed, annotation 'Seuil 80%'
Charts.line(el, {x:[labels], series:[{name, y:[number|null], color?}], threshold?:80, yTitle?, yRange?})
Charts.heatmap(el, {x:[labels], y:[labels], z:[[number|null]], zmin=0, zmax=100, title?})
Charts.purge(el)
Charts.board({sectionClass?}) -> {section(title, id, drawFn, caption?), draw(), purge()}  (charts of a page body;
                                 draw() runs the queue at once when Plotly is there, else after Charts.ready(),
                                 skipping boxes no longer in the page or purged; « Graphique indisponible » on failure,
                                 then the queue again if Plotly still arrives late)
```

### Pages
`window.Pages = window.Pages || {}`; each page file registers
`Pages.<id> = { id, title, mount(root), unmount?(), update?(changed) }` with ids and titles:

| id | icon | title |
|---|---|---|
| `dashboard` | 👻 | Tableau de bord |
| `postes` | 💻 | Postes |
| `apps` | 📦 | Applications |
| `timeline` | 📈 | Suivi temporel |
| `actions` | 📋 | Suivi actions |
| `settings` | – | Paramètres (admin only; also reachable before a source is configured) |

`mount(root)` receives the cleared `#main` element. Pages read `State.get()` (month, filters), load with
`UI.asyncBlock(box, {load, render, …})` (placeholder, error + « Réessayer », stale results dropped: no
hand-written tokens), and render with `UI`/`Charts`. `App` re-mounts the current page (after calling
`unmount`) when `page` changes and after `App.refresh()`; a month change keeps the page dimmed until the
month is cached, then re-mounts it. A filter change calls `update(['filters'])` first: a page that returns
true re-rendered its data in place from the cache (dashboard, postes, apps, timeline: header, scroll and
an open drawer stay, no server call); otherwise it is re-mounted.

Postes and Applications are built by `InventoryPage.create(spec)` (`js_page_inventory.html`, with
`EntityDrawer`): header + CSV / create buttons, filter note, stat line, optional sections, the « Inventaire »
editable table (key column → drawer, computed columns, « Conformité » filter, inline saves). Each page file
only declares its spec (columns, nouns, CSV, create button, drawer).

### `window.App` (`js_main.html`)
```
App.go(pageId)        -> navigate (also google.script.history.push({page}) when available)
App.refresh()         -> re-mount current page
App.boot()            -> runs as soon as js_main.html is parsed (the scripts close <body>), behind the #splash
                         (static in index.html: team logo, indeterminate bar, step line). First Charts.ready()
                         (Plotly downloads meanwhile); « Vérification de l’accès… »
                         State.refreshBootstrap({useInline:true}) with the initial page (#boot-page, else
                         google.script.url.getLocation, 1.5 s timeout); « Chargement de mai 2026… »
                         State.loadMonth(month) (warms the cache) and, not awaited, what the first page will ask:
                         the period's first month (dashboard / postes / apps, saved period) and the timeline
                         (dashboard with a period, timeline page) — the page joins these pending requests.
                         The splash waits on the month only; then renders and fades out. After 8 s a note explains the Apps Script cold start; a failure
                         shows the error + « Réessayer » on the splash; FORBIDDEN → « Accès refusé ».
                         If !configured: configuration screen (paste source sheet URL -> App.applySource:
                         api_setConfig, then a first App.syncNow()).
                         Performance marks 'shadow:boot' (start) and 'shadow:ready' (rendered), then
                         console.debug('[boot] ready …') (§4 Perf).
App.syncNow(button?, {enable?}) -> Promise<{status, result}|null>: api_syncNow (api_enableSync with enable);
                         toast « Synchronisé — <changes> » / « Synchronisé — aucune modification. »; after a
                         change: State.invalidate() + State.refreshBootstrap() + re-mount. Errors: toast, then
                         api_getSyncStatus.
Loading:               page bodies show UI.skeleton(...) (aria-busy) while their data loads; any
                         [aria-busy] in #main draws the app bar progress line. Month change on the same page:
                         the page and the filters stay, dimmed (.is-stale), until the new month is cached,
                         then the page re-mounts.
```
Sidebar: ghost logo (inline SVG, `svg.brand-logo`) + app title `Shadow IT`, nav links (one line icon + label each), footer links "Données (Google
Sheet)" → `dataUrl`, "Source" → `sourceUrl` (target `_blank`, admins only), then the signed-in account
(`#side-user`: email + role) and `#nav-collapse` (« Réduire le menu »: 56px icon rail, wide screens
only). The state is kept in `localStorage['shadowit.sidebar']` (applied before the server answers) and
per account through `api_savePrefs` / `bootstrap.prefs.sidebar`, which wins at boot: the Apps Script
frame loses localStorage when the browser blocks third-party storage. A browser-only value is uploaded
once. The source is changed in Paramètres
(`App.applySource`). « Paramètres » is in the nav for admins only.
App bar (`#appbar`, sticky): `Période` = `#month-prev` ‹ `#period-button` › `#month-next`. The button
(« Mai 2026 », « Avr. – oct. 2026 »; `data-from` / `data-to`) opens `#period-popover` > `#period-panel`:
shortcuts `#period-preset-<key>` (`Core.PERIOD_PRESETS`: Mois en cours, 3 / 6 derniers mois, Année <a>, Tout
l’historique — apply at once and are remembered per account: `api_savePrefs {period}`, re-applied at boot
from `bootstrap.prefs.period`), a 12-month grid `#period-month-YYYY-MM` (only synchronised months enabled;
first click = start, second = end; `#period-year-prev` / `#period-year-next`), `#period-summary` and
`#period-apply` « Appliquer » / `#period-cancel`. ‹ › move the whole period by one synchronised month.
A period shows the state of its LAST month (`state.month`) compared with its first one (§6); `Équipe` (`#filter-equipe`) and `Bâtiment / Labo` (`#filter-batiment`) multiselects
(options from current month postes via `Core.uniqueSorted`), `#filters-reset`, `#appbar-count`
(« 2 postes sur 7 » while a filter is active), then `#sync-chip` (last item): the synchronisation status
(`data-tone` ok | warn | ko | new | off | busy; text « 14:02 », « Échec 11:02 », « Nouvelles données »,
« Synchronisation… »). Its panel (`UI.popover`, `#sync-popover` > `#sync-panel`): status sentence, the error,
what the last change was (`Fmt.syncChange`), the source warnings, and — admins only — `#sync-now`
« Synchroniser maintenant » (`#sync-enable` when the trigger is off) and `#sync-journal` (→ Paramètres);
`#sync-reload` « Actualiser » when newer data exists. The status (`State.get().sync`) is polled with
`api_getSyncStatus` every 10 min, when the tab comes back and when the panel opens: a `lastChangeAt` newer
than the data on screen sets « Nouvelles données ». Below 900px the filters fold behind `#filters-toggle`.
Boot: `FORBIDDEN` from `api_bootstrap` → « Accès refusé » screen (`.page-denied`, server message,
« Réessayer »); a lecteur on an unconfigured app gets a waiting screen (`data-page="unconfigured"`)
instead of the configuration form.

---------------------------------------------------------------------------------------------------
## 6. Page specifications

### Tableau de bord (`dashboard`) — 1:1 port of `Tableau_de_bord.py`
- Period (`State.period()`, not single): kicker « Avril → octobre 2026 · état fin octobre » (`data-from`);
  every figure / chart is the last month's; each headline KPI adds `.metric-delta` (« +12 depuis avril »,
  « ▲ +6,0 pts depuis avril », ok / ko) and a `UI.sparkline` over the period's months (slim history of
  `State.loadTimeline`, same filters).
- No months → `#dashboard-empty` « Aucune donnée pour le moment. … » (+ `#dashboard-sync` « Synchroniser
  maintenant » for admins). There is no import section: the data comes from the hourly sync.
- Title `👻 Tableau de bord — Shadow IT`, caption `Export : <month>`.
- 4 metric cards: `Postes inventoriés`, `Postes conformes` (sub = taux %), `Applications inventoriées`,
  `Applications conformes` (sub = taux %). KPIs computed with `Core.computeKpis` on filtered data.
- Gauges `Conformité des postes` / `Conformité des applications`.
- Risk bars `Risques — Postes` / `Risques — Applications`.
- `Détail conformité`: Postes (Sans EDR, Non IT Decathlon, Hors réseau Decathlon), Applications (Sans SIP,
  Sans contrat, Sans Galink, Sans IDP).
- Histograms `Distribution des scores — Postes` / `— Applications`.

### Postes (`postes`)
- Header with counts; toolbar: search, `Conformité` select (Toutes / Conformes / Non conformes),
  `➕ Poste générique` (api_addGenericPoste), `⬇️ CSV` export.
- `UI.editableTable` over filtered postes; columns = `columns.postes` order (key column first, not
  editable) + computed `Score` (`UI.scoreBadge`) + `Applis` count; options via `Core.optionsForColumn`.
  Period: the last month's inventory, kicker « … · inventaire fin octobre », computed column `_evo`
  « Évolution depuis avril » (`Core.scoreEvolution` of the first month → this one, same filters: « Nouveau »,
  « 40,0 % → 80,0 % » ok / ko, « — »), `#postes-evo-stats` « +14 nouveaux · 2 retirés · 9 scores modifiés
  depuis avril », `#postes-removed` (removed names under the table), `#postes-changed-only` « Seulement ce
  qui a changé » (same for `apps`).
  onSave → `api_savePostes` → `State.patchRecords`; toast « N modifications enregistrées dans le Google Sheet
  source. » (current month) or « … (historique de mai 2026). ». Admins see `#postes-edit-note` (`data-live`
  1|0) saying where an edit goes.
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
- Period (not single): only its months (kicker « Mai 2026 – juin 2026 · 2 exports sur 3 », `data-from`); a
  single month shows the whole history.

### Suivi actions (`actions`) — `UI.tabs`
Period (not single): `#actions-period-note` / `#replacements-period-note`; the ledgers keep the actions
created or completed inside the period and the replacements dated inside it; « Détection des changements »
compares the first and last months by default.
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
- `test/fixtures/source.js` — `buildSourceSpreadsheet(month)` → fake live spreadsheet definition (banner row,
  header row, Date cells, `0.304` raw vs `'30,4%'` display, empty/ghost rows) built from `data.js`.
- `test/helpers/gasFakes.js` — in-memory `SpreadsheetApp`, `PropertiesService`, `LockService`,
  `Utilities`, `HtmlService`, `Logger`, `GroupsApp`, `CacheService` (get / getAll / put / putAll with TTLs on the
  `Date.now()` clock; `env.__state.cacheFaults.read / .write` make them throw); counters in `env.__state.calls`
  (Sheets, Properties and Cache calls), `env.__state.opened` (ids passed to `openById`),
  `env.__state.propertyWrites` (keys written)
  and `env.__state.cells` (cells read per read method); `env.__state.reads` logs every range read
  (spreadsheet, sheet, method, A1, cells, whether the script lock was held); `env.__state.onWaitLock = fn`
  runs fn once before the next lock acquisition (another execution taking the lock first).
- `test/helpers/gasSandbox.js` — `loadGas({sources})` → `vm` context with fakes + every `src/*.js`
  loaded in alphabetical order (proves load-order independence); `loadGas({env})` = a new execution over
  the same spreadsheets; `timingLines(env)` = the Perf lines captured by the fake console.
- `test/integration/perf.test.js` — call counts (openById, reads, cells read, Properties reads, Cache reads and
  writes, GroupsApp calls, source cells read, source reads made under the lock)
  of the main flows on a large generated data spreadsheet, bounded by today's numbers (`BASELINE`);
  `PERF_OUT=<file>` writes the measurement as JSON.
- `test/helpers/render.js` — renders `src/index.html` (scriptlets `include`/`coreScript`, and
  `inlineBoot_`/`inlinePage_` run from the real `Code.js` over the `boot` envelope / `page` options, '' when
  left out) to static HTML; optional injection of `test/fixtures/mockRun.js` + data for the browser.
  `bootstrapEnvelope(options)` (mockRun.js) computes in Node the envelope the mock's api_bootstrap returns;
  the e2e harness takes `boot` / `inlinePage` (inline data) and `plotly: {delayMs}|{fail:true}`.
- `test/fixtures/mockRun.js` — browser `google.script.run` mock implementing every `api_*` from §3
  over in-memory data from `data.js` (records enriched with `Core`), recording calls in
  `window.__calls`.
- `npm test` → `test/unit/**` + `test/integration/**`; `npm run test:e2e` → Playwright smoke tests.
