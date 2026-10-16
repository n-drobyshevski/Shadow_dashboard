# Security: threat model, assessment and checks

Last assessment: 2026-10-15. It covered:

- **SAST:** Semgrep (registry and project rules), plus a manual review of the server and of the client.
- **Secrets:** gitleaks over the full git history.
- **SCA:** osv-scanner and `npm audit`.

This page records what was checked, what was fixed, and what is still open. Update it whenever a change touches the attack surface. `test/integration/security.test.js` fails until it is updated.

## 1. Threat model

**Deployment.** The app is an Apps Script web app with `executeAs: USER_DEPLOYING` and `access: DOMAIN`:

- Every account of the Workspace domain can load the page.
- Every server call runs with the deployer's Google rights.

**Roles.** `apiWrap_` checks the role of every `api_*` call (Access.js):

| Role | What it can do |
|---|---|
| no role | nothing; the page shows the access-denied screen |
| `lecteur` | read only, plus its own display preferences |
| `admin` | every write: entities, actions, settings, access, sync |
| owner (the deployer) | everything an admin can; cannot be removed or demoted |

| Attacker | Can do | Main risks |
|---|---|---|
| Domain user, no role | Load the page and call any public server function from DevTools with arbitrary arguments | Bypassing role checks through non-`api_*` entry points; denial of service on quotas and the lock |
| Lecteur | Every read API | Reading admin-only data (URLs, access list, other users' emails); writes |
| Editor of the source Google Sheet (often many people) | Put any text in cells that the app imports and displays | XSS; markup in charts; formula injection in CSV exports and write-backs |
| Admin who is not the owner | Every admin API | Confused deputy: using the deployer's access to Drive files the admin cannot open |
| Third parties: CDN, npm | The Plotly file, and the clasp toolchain used to deploy | A malicious script in the page; a compromised deploy tool |

**Trust boundaries:**

- the `google.script.run` arguments (JSON strings);
- cell contents of the source and data spreadsheets;
- the `?page=` parameter;
- Script Properties written by admins;
- the Plotly CDN file.

## 2. Results

### Fixed in this change

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | `setup()` and `syncHourly()` are public (Apps Script needs that for the editor and the trigger), so **any domain user**, even with no role, could call them through `google.script.run`. They ran as the deployer without a role check. `setup()` returned the data-spreadsheet URL (only admins see it otherwise) and re-created the trigger; `syncHourly()` forced syncs, holding the lock and using up quota. | `setup()` throws unless the active user is the deployer. `syncHourly(e)` does nothing unless `e.triggerUid` is the id of one of the project's hourly triggers; that id never leaves the server. Tests: `sync.test.js`, `security.test.js`. |
| 2 | Low | Team names from the sheet went into Plotly heatmap labels unescaped. Plotly renders `<a href>`, `<span style>` and similar tags in labels, which allows a phishing link disguised as a team name (not script: Plotly 2.35 only allows http, https and mailto links). | `clean()` on heatmap labels and line-chart series names, like the annotations already had. |
| 3 | Low | The CSV export and source write-back escaped values starting with `= + - @`, but not a leading tab or carriage return (OWASP CSV injection list). | `Core.escapeFormula` now covers `\t` and `\r`. Test: `core.basics.test.js`. |
| 4 | Low (hardening) | The `UI.el` URL filter was a `javascript:`/`data:`/`vbscript:` denylist. It missed `java\tscript:` and leading control characters, and let `on*` text attributes and `srcdoc` through. Nothing reached it with sheet data. | Replaced with a scheme allowlist (http, https, mailto, blob, relative), applied after removing control characters. `on*` text attributes and `srcdoc` are now dropped. Test: `controls.test.js`. |
| 5 | Low (supply chain) | Plotly was loaded from cdnjs without Subresource Integrity. | `integrity` (sha512, the hash cdnjs publishes, checked against the real file) plus `crossorigin` on both the preload and the script. A modified file is refused and the charts show « Graphique indisponible ». Tests: `boot.test.js` (a tampered file and the real one), `security.test.js`. |
| 6 | Info (SCA) | There was no lockfile, so installs of the deploy toolchain were not reproducible. | `package-lock.json` committed; Dependabot set up for npm and GitHub Actions. |
| 7 | Low | A source column named `_id`, `_updated_at` or `__proto__` became a field of every imported record, and `Store.replaceEntityMonth` kept any `_id` and `_updated_at` it was given. A source editor could choose record ids (duplicates, `__proto__`) and edit stamps. | `Core.rowsToRecords` ignores headers starting with `_`, with a warning. The Importer drops `_` fields from source records and takes ids only from the stored records. `Store.replaceEntityMonth` keeps only uuid-shaped ids and ISO stamps; anything else gets a new uuid or `''`. Tests: `core.parse.test.js`, `import.test.js`, `store.test.js`. |
| 8 | Low (DoS) | Duplicate source headers were renamed with `indexOf` inside a loop (cubic), and the parsed width had no limit. A header row of a few thousand identical cells stalled every hourly sync. | Linear renaming, with the same names (`x (2)`, `x (3)`…). More than 500 non-blank header cells is `SOURCE_ERROR` naming the tab. Test: `core.parse.test.js`. |
| 9 | Medium (availability) | A record is stored as one JSON cell, and Sheets refuses cells over 50,000 characters. One long source cell made every sync fail half-way: Applications and Référentiel were written, Postes was not. Admin free text had no length limit either. | Imported values are truncated at 5,000 characters and headers at 200, with a warning naming the record and the column. Before the first write, each record's JSON and each entity's headers JSON must stay under 45,000 characters, else `SOURCE_ERROR` naming the record, and nothing is written. `api_*` calls refuse text over 5,000 characters (`VALIDATION` with the field). Tests: `import.test.js`, `api.test.js`, `core.parse.test.js`. |
| 10 | Low (DoS) | The Référentiel and the entity tabs had no size limit, and the Référentiel is stored as one row per value. New data tabs kept the 26 columns of a new sheet, so every row inserted later was 26 columns wide. A shrinking table only cleared its leftover rows. | At most 100 categories, 500 values per category and 5,000 records per entity tab; above that, `SOURCE_ERROR` naming the tab, before the lock. New tabs are trimmed to their schema width (and existing ones by a repair, when nothing is written past it). A shrinking table deletes its leftover rows. Tests: `core.parse.test.js`, `import.test.js`, `store.test.js`. |

### Open: needs a decision

| # | Severity | Finding | Options |
|---|---|---|---|
| A | Low/Medium | **Confused deputy through `api_setConfig`.** An admin who is not the owner can set the source to any spreadsheet id; the app opens it with the deployer's rights. **Impact:** (a) the reply, including the error message, gives the title of any file the deployer can open; (b) if that file has a `Postes` or `Applications` tab with the expected key column, it is imported (lecteurs then see it) and can be written back. | Allow changing the source only for the owner; or keep an allowlist of source ids in a Script Property; at least, drop the title from the error. |
| B | Low/Info | **Google error text reaches lecteurs.** INTERNAL error messages and the sync `lastError` pass the first line of Google's error to every role. Some of these name a spreadsheet id, which lecteurs otherwise never see. An id alone grants no access. | For non-admins, return a generic message and keep the details in `console.error`. |
| C | Low | **Each account's preferences take a Script Property.** Every account that saves preferences gets its own `PREFS_<email>` Script Property (about 80 B). Script Properties total about 500 KB, so with `domainRole = lecteur` on a domain of roughly 6,000 or more active users the store fills up, and settings and sync state can no longer be written. One user alone cannot cause this. | Move preferences to a tab of the data spreadsheet, or to the user cache. |

### Checked and found safe

- **Roles on every endpoint:** every write requires admin. A lecteur reaches only reads, plus `savePrefs`, which is keyed by the session email. An empty email (another domain, consumer account) is refused. Emails are trimmed and lower-cased on both sides of the comparison.
- **Owner:** taken from `getEffectiveUser`. The owner cannot be stored, removed or demoted.
- **Group cache:** keys are `grp:<group>|<email>`, in a script cache only this script can write. Read errors deny access. Revocation can lag up to 1 h; this is documented.
- **Input handling:**
  - prototype pollution: keys starting with `_` are refused and patch keys are allowlisted;
  - types are checked for month, ids, limits, flags, roles and emails;
  - `parseArgs_` refuses anything that is not a JSON string;
  - the regexes are linear, and the email check runs after a length check;
  - sizes are bounded (`Core.LIMITS`): source columns, records, Référentiel categories and values, cell and header lengths, and admin free text.
- **XSS:**
  - no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval` anywhere in the client (pinned by a test);
  - `UI.el` throws on `innerHTML`;
  - attribute keys are static.
- **Page template:**
  - `<?!= ?>` only prints the known helpers (pinned);
  - `inlineJson_` escapes `< > & ' \`` U+2028 U+2029 and `/`;
  - `?page=` is checked against an allowlist;
  - `coreScript` neutralises `</script`.
- **Formulas in the data spreadsheet:** cells are formatted as plain text (`@`) before `setValues`. Source write-back goes through `escapeFormula`. Formula cells are never overwritten.
- **Outbound requests:** no UrlFetch, Drive or Mail calls, so no SSRF (pinned). `FAVICON_URL` can only be set in the editor and must start with `https://`.
- **Frames and links:**
  - HtmlService keeps its default X-Frame-Options, which forbids framing by other sites (`ALLOWALL` is pinned out);
  - external links use `rel="noopener noreferrer"`;
  - there is no `window.open` and no `postMessage` listener.
- **Browser storage:** localStorage holds only the sidebar-collapsed flag.
- **Logs:** perf lines carry no emails or ids.
- **Secrets:** gitleaks finds nothing in the full history. `.clasprc*.json` is ignored by git.
- **Plotly 2.35.3:** no OSV advisory. The old prototype-pollution CVE (CVE-2023-46308) was fixed in 2.25.2.

## 3. Continuous checks

| Where | What | Blocks on |
|---|---|---|
| `npm test` (`test/integration/security.test.js`) | no HTML or code sinks in the client; `noopener`; scriptlet allowlist; the only third-party script is Plotly, with the same SRI everywhere (and the hash matches the real file when `.artifacts/plotly.min.js` is present); no outbound or frame APIs on the server; the `setup`/`syncHourly` guards; manifest access and scopes | any change of those |
| CI `Security` → Semgrep | registry rulesets `p/javascript`, `p/security-audit`, `p/secrets`, `p/xss` and `p/nodejsscan`, plus `security/semgrep.yml`, over `src/*.js` and the `<script>` blocks of `src/*.html` (via `security/extract-client-js.js`) | any finding |
| CI `Security` → gitleaks | full git history | any secret |
| CI `Security` → osv-scanner | `package-lock.json`, plus an OSV query for Plotly 2.35.3 | any advisory not listed in `osv-scanner.toml` |
| CI `CodeQL` | `security-extended` JavaScript queries; results under Security → Code scanning | alerts in the PR check |
| Dependabot | npm and GitHub Actions, weekly | — |

Tool versions in CI are pinned: actions by commit SHA, and the gitleaks and osv-scanner binaries by version and SHA-256. Run the same scans locally with `npm run security`; the tools must be installed (see the README).

### Triaged exceptions

**Semgrep rules excluded by id**, in `.github/workflows/security.yml` and `security/scan.sh`:

- `njsscan…node_timing_attack`: it flags comparisons of in-page render tokens (`ctx.token === token`) and popover identities. These are not secrets.
- `njsscan…generic_error_disclosure`: `console.error(e)` of a client exception, shown only in the visitor's own console.
- `njsscan…regex_dos`: the flagged patterns (`ARRAY_FORMULA_RE`, the tag-name test) have no nested quantifiers. They run on formulas and on DOM tag names.

**osv-scanner** (`osv-scanner.toml`):

- `GHSA-vfj7-8cjw-p6xm`, braces 3.0.3, reached through `@google/clasp` and micromatch.
- Dev only: clasp expands only our own `.claspignore`, on the deployer's machine, and nothing of it is deployed.
- No fixed release exists yet. The exception expires on 2027-04-15.

## 4. Not verifiable from code (manual checklist)

- [ ] The deployment is **Execute as: Me** and **Who has access: anyone in the domain**, never *Anyone*.
- [ ] Only the owner has edit access to the Apps Script project. Project editors can read `console` logs and change the code that runs as the deployer.
- [ ] The data spreadsheet is shared with nobody, or read-only. The app reads it with the deployer's rights; edit access to it bypasses every role check.
- [ ] In the Apps Script editor, calling `setup` from another account's web-app session is refused, while running it in the editor still works for the deployer.
