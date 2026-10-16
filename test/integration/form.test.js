'use strict';
/**
 * Integration tests: the creation forms' server half (docs/API.md §3 api_getFormSchema / api_addPoste,
 * §4 Importer.readFormSchema / appendRecord) in the GAS sandbox, over the « form » source fixture
 * (test/fixtures/source.js {form:true}: formulas, array formulas and data validation).
 *
 * "Today" is pinned with ctx.Config.today = 15/05/2026, so 2026-05 is the current (live) month.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas, plain, timingLines } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const POSTES_TAB = 'Suivi des postes';
const APPS_TAB = 'Suivi des applications';
const READER = 'lea.reader@decathlon.com';
const TODAY = '2026-05-15';

function call(ctx, name, args) {
  const res = JSON.parse(ctx[name](args === undefined ? 'null' : JSON.stringify(args)));
  if (!res.ok) {
    assert.doesNotMatch(res.error.message, /\n\s+at /, 'stack leaked by ' + name);
    if ('field' in res.error) assert.equal(res.error.code, 'VALIDATION', 'field only on VALIDATION errors');
  }
  return res;
}
function ok(ctx, name, args) {
  const res = call(ctx, name, args);
  assert.equal(res.ok, true, name + ' failed: ' + JSON.stringify(res.error));
  return res.data;
}
function fail(ctx, name, args, code, field) {
  const res = call(ctx, name, args);
  assert.equal(res.ok, false, name + ' should fail with ' + code);
  assert.equal(res.error.code, code, name + ': ' + res.error.message);
  assert.equal(res.error.field, field, name + ': field of « ' + res.error.message + ' »');
  return res.error;
}

/** Form fixture with Date cells at noon UTC (same calendar day in Paris whatever the host TZ). */
function source() {
  const def = buildSourceSpreadsheet('2026-05', { form: true });
  for (const tab of Object.values(def.sheets)) {
    tab.values = tab.values.map((row) => row.map((v) => (v instanceof Date
      ? new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 12)) : v)));
  }
  return def;
}

function colNumber(letters) {
  return letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

/**
 * What the source formulas show, computed from the formula cell's own row (the fake copies formulas
 * verbatim, Sheets would shift their relative references): the score formula counts « Oui » in its
 * columns (/5, as a percentage), risk and status follow the score cell. Anything else: the default.
 */
function formulaDisplay(cell) {
  const score = (formula) => {
    const m = /COUNTIF\(([A-Z]+)\d+:([A-Z]+)\d+,"Oui"\)\/5/.exec(formula);
    if (!m) return null;
    let n = 0;
    for (let c = colNumber(m[1]); c <= colNumber(m[2]); c++) if (cell.value(cell.row, c) === 'Oui') n++;
    return n * 20;
  };
  const direct = score(cell.formula);
  if (direct !== null) return direct + '%';
  const ref = /^=IF\(([A-Z]+)\d+/.exec(cell.formula);
  if (!ref) return undefined;
  const pct = score(String(cell.value(cell.row, colNumber(ref[1]))));
  if (pct === null) return undefined;
  if (/Faible/.test(cell.formula)) return pct >= 80 ? 'Faible' : 'Élevé';
  return pct >= 80 ? 'Conforme' : 'Non conforme';
}

/** Sandbox on the form source, today pinned, source saved, first sync done; formulas display values. */
function synced() {
  const sb = loadGas({ sources: [source()] });
  sb.ctx.Config.today = () => TODAY;
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_syncNow');
  sb.env.__setFormulaDisplay(formulaDisplay);
  return sb;
}

/** A new Apps Script execution over the same spreadsheets / properties / cache. */
function execution(env, email) {
  env.__setActiveUser(email);
  const sb = loadGas({ env });
  sb.ctx.Config.today = () => TODAY;
  return sb;
}

function sheet(env, tab) {
  return env.SpreadsheetApp.openById(SOURCE_ID).getSheetByName(tab);
}

/** Every cell of a source tab (values, formulas included) and its size: to prove nothing was written. */
function snapshotOf(env, tab) {
  const sh = sheet(env, tab);
  return JSON.stringify({ rows: sh.getMaxRows(), values: sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).getValues() });
}

function headersOf(env, tab) {
  return sheet(env, tab).getRange(2, 1, 1, sheet(env, tab).getMaxColumns()).getDisplayValues()[0]
    .map((h) => h.replace(/\u00a0/g, ' ').trim());
}

/** 0-based grid row of the last row whose key cell is not blank. */
function lastKeyRow(env, tab, key) {
  const grid = sheet(env, tab).getDataRange().getDisplayValues();
  const k = grid[1].map((h) => h.trim()).indexOf(key);
  return grid.reduce((last, r, i) => (i > 1 && r[k] ? i : last), 0);
}

function monthData(ctx, month) {
  return ok(ctx, 'api_getMonthData', { month });
}

function byName(list, key, name) {
  return list.find((r) => r[key] === name);
}

function col(schema, name) {
  return schema.columns.find((c) => c.name === name);
}

const NEW_POSTE = { [KEY_POSTE]: 'LAB-NEW-01', 'Équipe': 'Labo Textile', 'IT Decathlon': 'Oui', 'EDR Decathlon': 'Oui',
  'Chiffrement disque': 'Oui', 'OS': 'Windows', 'Criticité équipement': 'Haute' };

// ------------------------------------------------------------------------------------- schema

test('getFormSchema (current month): the source columns in order, kinds, lists, strictness, computed, required', () => {
  const sb = synced();
  const s = ok(sb.ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' });
  assert.deepEqual([s.entity, s.month, s.live, s.origin, s.keyField], ['postes', '2026-05', true, 'source', KEY_POSTE]);
  assert.match(s.readAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal('warning' in s, false);
  assert.deepEqual(s.columns.map((c) => c.name), headersOf(sb.env, POSTES_TAB).filter((h) => h), 'sheet order');
  for (const c of s.columns) {
    const keys = Object.keys(c).sort();
    assert.deepEqual(keys.filter((k) => k !== 'rule' && k !== 'arrayFormula'), ['computed', 'kind', 'name', 'options', 'required', 'strict'], c.name);
    if ('arrayFormula' in c) assert.equal(c.arrayFormula, true, c.name);
    assert.ok(['text', 'select', 'date', 'checkbox'].includes(c.kind), c.name);
  }
  // Lists: VALUE_IN_LIST values, VALUE_IN_RANGE values from the Référentiel; strict = !allowInvalid.
  assert.deepEqual(plain(col(s, 'IT Decathlon')), { name: 'IT Decathlon', kind: 'select', options: ['Oui', 'Non'], strict: true,
    computed: false, required: false, rule: 'VALUE_IN_LIST' });
  assert.deepEqual(plain(col(s, 'Criticité équipement').options), ['Haute', 'Moyenne', 'Basse']);
  assert.deepEqual([col(s, 'OS').kind, plain(col(s, 'OS').options), col(s, 'OS').strict, col(s, 'OS').rule],
    ['select', ['Windows', 'macOS', 'Linux'], true, 'VALUE_IN_RANGE']);
  assert.deepEqual([col(s, 'Équipe').kind, col(s, 'Équipe').options.length, col(s, 'Équipe').strict, col(s, 'Équipe').required],
    ['select', 4, false, true], 'range rule with allowInvalid: suggestions only');
  // Dates: a DATE rule, or a known date column name.
  assert.deepEqual([col(s, "Date d'achat").kind, col(s, "Date d'achat").strict, col(s, "Date d'achat").rule], ['date', true, 'DATE_IS_VALID_DATE']);
  assert.deepEqual([col(s, 'Date visite').kind, col(s, 'Deadline').kind], ['date', 'date']);
  // Oui/Non columns without a rule: suggested, not enforced.
  assert.deepEqual([col(s, 'Enrolée').kind, col(s, 'Enrolée').strict, 'rule' in col(s, 'Enrolée')], ['select', false, false]);
  assert.deepEqual([col(s, 'Commentaires').kind, col(s, 'Commentaires').options], ['text', null]);
  // Computed: formulas of the last record row, and the ARRAYFORMULA column of the first data row.
  assert.deepEqual(s.columns.filter((c) => c.computed).map((c) => c.name),
    ['Score conformité', 'Niveau de risque', 'Statut', 'Ancienneté']);
  // Only the array formula fills its column in every row (the table locks just that one).
  assert.deepEqual(s.columns.filter((c) => c.arrayFormula).map((c) => c.name), ['Ancienneté']);
  assert.deepEqual(s.columns.filter((c) => c.required).map((c) => c.name), ['Équipe', KEY_POSTE]);
  assert.ok(s.columns.every((c) => !c.appOnly));

  // Applications: an array column declared in the header row, Galink / IDP app-only at the end.
  const a = ok(sb.ctx, 'api_getFormSchema', { entity: 'applications', month: '2026-05' });
  assert.equal(a.keyField, KEY_APP);
  assert.deepEqual(a.columns.filter((c) => c.computed).map((c) => c.name), ['Doublon']);
  assert.equal(col(a, 'Doublon').arrayFormula, true);
  assert.deepEqual(a.columns.filter((c) => c.required).map((c) => c.name), [KEY_APP]);
  assert.deepEqual(plain(a.columns.slice(-2)), ['Galink', 'IDP'].map((name) => ({ name, kind: 'select', options: ['Oui', 'Non'],
    strict: true, computed: false, required: false, appOnly: true })));
  assert.deepEqual([col(a, 'Contrat').strict, col(a, 'Type').strict, plain(col(a, 'Type').options)],
    [true, false, ['Logiciel', 'SaaS', 'Script']]);
  assert.equal(col(a, 'Date').kind, 'date');
});

test('getFormSchema reads the source outside the lock: sample rows and one bounding box per list sheet, never a whole tab', () => {
  const sb = synced();
  const { ctx, env } = execution(sb.env);
  const st = env.__state;
  const r0 = st.reads.length;
  const locks = st.lock.acquired;
  ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' });
  const reads = st.reads.slice(r0).filter((r) => r.spreadsheetId === SOURCE_ID);
  assert.equal(st.lock.acquired, locks, 'no lock taken');
  assert.ok(reads.every((r) => !r.lockHeld));
  const width = headersOf(env, POSTES_TAB).length;
  const last = lastKeyRow(env, POSTES_TAB, KEY_POSTE) + 1;
  const height = sheet(env, POSTES_TAB).getDataRange().getNumRows();
  const L = String.fromCharCode(64 + width);
  assert.deepEqual(reads.map((r) => [r.sheet, r.method, r.a1]), [
    [POSTES_TAB, 'getDisplayValues', 'A1:' + L + height],               // header block (the tab is < 15 rows)
    [POSTES_TAB, 'getDisplayValues', 'G3:G' + height],                   // key column
    [POSTES_TAB, 'getFormulas', 'A2:' + L + '3'],                        // header + first data row
    [POSTES_TAB, 'getFormulas', 'A' + last + ':' + L + last],            // last record row
    [POSTES_TAB, 'getDataValidations', 'A' + last + ':' + L + last],
    [POSTES_TAB, 'getValues', 'A' + last + ':' + L + last],
    ['Référentiel', 'getDisplayValues', 'D2:F5'],                         // OS (D) + Équipe (F): one box
  ]);
});

test('getFormSchema: cached 5 minutes per entity and source (a hit opens nothing), `fresh` re-reads the source', () => {
  const sb = synced();
  const env = sb.env;
  let { ctx } = execution(env);
  const first = ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' });
  assert.ok(env.__state.cache.has('fs1:postes:' + SOURCE_ID));

  // A new column in the source: the cached schema does not know it yet; `fresh` reads it.
  const sh = sheet(env, POSTES_TAB);
  const newCol = headersOf(env, POSTES_TAB).length + 1;
  sh.insertColumnsAfter(newCol - 1, 1);
  sh.getRange(2, newCol).setValue('Numéro de série');
  ({ ctx } = execution(env));
  const opened = env.__state.opened.length;
  const hit = ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' });
  assert.equal(env.__state.opened.length, opened, 'a cache hit opens no spreadsheet at all');
  assert.deepEqual(plain(hit), plain(first));
  assert.equal(col(hit, 'Numéro de série'), undefined);
  const fresh = ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05', fresh: true });
  assert.deepEqual(plain(col(fresh, 'Numéro de série')), { name: 'Numéro de série', kind: 'text', options: null, strict: false,
    computed: false, required: false });
  assert.equal(fresh.columns[fresh.columns.length - 1].name, 'Numéro de série');
  // The fresh read replaced the cached value.
  ({ ctx } = execution(env));
  assert.ok(col(ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' }), 'Numéro de série'));
  // Applications have their own entry.
  ok(ctx, 'api_getFormSchema', { entity: 'applications', month: '2026-05' });
  assert.ok(env.__state.cache.has('fs1:applications:' + SOURCE_ID));

  // The cache expires after 300 s.
  const now = Date.now;
  try {
    Date.now = () => now() + 301 * 1000;
    ({ ctx } = execution(env));
    const before = env.__state.opened.length;
    ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' });
    assert.equal(env.__state.opened.length, before + 1);
  } finally {
    Date.now = now;
  }
});

test('getFormSchema falls back to the last synchronisation when the source cannot be read (nothing cached)', () => {
  const sb = synced();
  const env = sb.env;
  const headers = headersOf(env, POSTES_TAB).filter((h) => h);
  env.__fault({ method: 'openById', id: SOURCE_ID, times: Infinity });
  const { ctx } = execution(env);
  const puts = env.__state.calls.cachePut || 0;
  const s = ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05', fresh: true });
  assert.deepEqual([s.live, s.origin], [true, 'fallback']);
  assert.match(s.warning, /n’a pas pu être lu/);
  assert.match(s.readAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'the time of the last synchronisation');
  assert.deepEqual(s.columns.map((c) => c.name), headers);
  assert.ok(s.columns.every((c) => !c.computed), 'no formula is known');
  assert.deepEqual([col(s, 'OS').kind, col(s, 'OS').strict, col(s, 'IT Decathlon').strict], ['select', false, true]);
  assert.equal(env.__state.calls.cachePut || 0, puts, 'a fallback is never cached');
  const a = ok(ctx, 'api_getFormSchema', { entity: 'applications', month: '2026-05' });
  assert.equal(a.origin, 'fallback');
  assert.deepEqual(a.columns.filter((c) => c.appOnly).map((c) => c.name), ['Galink', 'IDP']);
  env.__clearFaults();

  // No source configured at all (and nothing synchronised yet): the required fields only.
  const bare = loadGas();
  bare.ctx.Config.today = () => TODAY;
  const none = ok(bare.ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' });
  assert.equal(none.origin, 'fallback');
  assert.match(none.warning, /Aucun Google Sheet source/);
  assert.deepEqual(none.columns.map((c) => [c.name, c.required]), [[KEY_POSTE, true], ['Équipe', true]]);
});

test('getFormSchema (past month): the snapshot columns, never the source; validation and access', () => {
  const sb = synced();
  ok(sb.ctx, 'api_importMonth', { month: '2026-04' });
  const { ctx, env } = execution(sb.env);
  const opened = env.__state.opened.filter((id) => id === SOURCE_ID).length;
  const s = ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-04' });
  assert.equal(env.__state.opened.filter((id) => id === SOURCE_ID).length, opened, 'the source is never opened');
  assert.deepEqual([s.live, s.origin, 'warning' in s], [false, 'snapshot', false]);
  assert.ok(s.columns.every((c) => !c.computed), 'computed columns are ordinary fields of a frozen month');
  assert.deepEqual([col(s, 'Score conformité').kind, col(s, 'OS').strict, col(s, 'Criticité équipement').strict,
    col(s, 'IT Decathlon').strict], ['text', false, false, true], 'only Oui/Non lists are strict');
  assert.deepEqual(plain(col(s, 'Équipe').options), ['Labo Textile', 'Labo Chaussure', 'Labo Mécanique', 'R&D Vélo']);

  fail(ctx, 'api_getFormSchema', { entity: 'actions', month: '2026-04' }, 'VALIDATION');
  fail(ctx, 'api_getFormSchema', { month: '2026-04' }, 'VALIDATION');
  fail(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-4' }, 'VALIDATION');
  fail(ctx, 'api_getFormSchema', { entity: 'postes', month: '2025-01' }, 'NOT_FOUND');

  ok(ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  const reader = execution(env, READER);
  fail(reader.ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' }, 'FORBIDDEN');
  fail(reader.ctx, 'api_addPoste', { month: '2026-05', record: NEW_POSTE }, 'FORBIDDEN');
});

// ------------------------------------------------------------------------------------- addPoste

test('addPoste (current month): a source row below the last poste, formulas copied down, computed values returned', () => {
  const sb = synced();
  const env = sb.env;
  const sh = sheet(env, POSTES_TAB);
  const last = lastKeyRow(env, POSTES_TAB, KEY_POSTE);
  const headers = headersOf(env, POSTES_TAB);
  const props = env.PropertiesService.getScriptProperties();
  const stamp = props.getProperty('SOURCE_WRITE_STAMP');
  const formulasBefore = env.__state.formulas.length;

  const rec = ok(sb.ctx, 'api_addPoste', { month: '2026-05', record: Object.assign({}, NEW_POSTE,
    { 'Date visite': '2026-05-14', 'Commentaires': '  Poste neuf  ', 'Réseau Decathlon': 'Oui', 'Enrolée': 'Oui' }) });
  assert.equal(rec[KEY_POSTE], 'LAB-NEW-01');
  assert.equal(rec._key, 'LAB-NEW-01');
  assert.equal(rec['Date visite'], '14/05/2026', 'ISO date stored as DD/MM/YYYY');
  assert.equal(rec.Commentaires, 'Poste neuf');
  // Computed by the sheet, read back after the write: IT, EDR, Chiffrement, Réseau = 4 « Oui » of 5.
  assert.deepEqual([rec['Score conformité'], rec['Niveau de risque'], rec.Statut, rec._score, rec._conforme],
    ['80%', 'Faible', 'Conforme', 80, true]);
  assert.equal(rec['Ancienneté'], null, 'array column: whatever the spill shows (blank here)');
  for (const h of headers.filter((x) => x)) assert.ok(Object.prototype.hasOwnProperty.call(rec, h), h);

  const row = last + 1;
  const values = sh.getRange(row + 1, 1, 1, headers.length).getValues()[0];
  assert.equal(values[headers.indexOf(KEY_POSTE)], 'LAB-NEW-01', 'just below the last poste');
  for (const c of ['Score conformité', 'Niveau de risque', 'Statut']) {
    const above = sh.getRange(row, headers.indexOf(c) + 1).getFormula();
    assert.match(values[headers.indexOf(c)], /^=/, c + ' holds a formula');
    assert.equal(values[headers.indexOf(c)], above, c + ': the last row formula, copied down');
  }
  assert.equal(values[headers.indexOf('Ancienneté')], '', 'the spilled array column is never written');
  assert.equal(env.__state.formulas.length, formulasBefore, 'no formula written as a value');
  assert.notEqual(props.getProperty('SOURCE_WRITE_STAMP'), stamp, 'the write stamp moved');

  const md = monthData(sb.ctx, '2026-05');
  assert.equal(md.postes[md.postes.length - 1]._id, rec._id);
  // The next synchronisation reads the same row back: nothing changes.
  const sync = ok(sb.ctx, 'api_syncNow');
  assert.equal(sync.result.changed, false, JSON.stringify(sync.result.changes));
});

test('addPoste: a computed value « Loading… » comes back empty', () => {
  const sb = synced();
  sb.env.__setFormulaDisplay(() => 'Loading...');
  const rec = ok(sb.ctx, 'api_addPoste', { month: '2026-05', record: NEW_POSTE });
  assert.deepEqual([rec['Score conformité'], rec.Statut, rec._score], [null, null, null]);
});

test('addPoste refusals name the field and leave the source and the snapshot untouched', () => {
  const sb = synced();
  const env = sb.env;
  const cases = [
    [{ [KEY_POSTE]: '   ', 'Équipe': 'Labo Textile' }, KEY_POSTE, /nom du poste est obligatoire/],
    [{ [KEY_POSTE]: ' lab-tex-01 ', 'Équipe': 'Labo Textile' }, KEY_POSTE, /Le poste « lab-tex-01 » existe déjà pour 2026-05/],
    [{ [KEY_POSTE]: 'LAB-NEW-02' }, 'Équipe', /^Ce champ est obligatoire\.$/],
    [{ [KEY_POSTE]: 'LAB-NEW-02', 'Équipe': '  ' }, 'Équipe', /^Ce champ est obligatoire\.$/],
    [{ [KEY_POSTE]: 'LAB-NEW-02', 'Équipe': 'Labo Textile', 'Score conformité': '100%' }, 'Score conformité',
      /^« Score conformité » est calculée par une formule dans le Google Sheet source\.$/],
    [{ [KEY_POSTE]: 'LAB-NEW-02', 'Équipe': 'Labo Textile', 'Ancienneté': '3' }, 'Ancienneté', /calculée par une formule/],
    [{ [KEY_POSTE]: 'LAB-NEW-02', 'Équipe': 'Labo Textile', 'IT Decathlon': 'Peut-être' }, 'IT Decathlon',
      /^Valeur hors liste : « Peut-être » \(attendu : Oui, Non\)\.$/],
    [{ [KEY_POSTE]: 'LAB-NEW-02', 'Équipe': 'Labo Textile', "Date d'achat": '31/02/2024' }, "Date d'achat",
      /^Date invalide : « 31\/02\/2024 » \(format attendu JJ\/MM\/AAAA\)\.$/],
    [{ [KEY_POSTE]: 'LAB-NEW-02', 'Équipe': 'Labo Textile', 'Colonne inconnue': 'x' }, 'Colonne inconnue',
      /^La colonne « Colonne inconnue » n’existe pas dans le Google Sheet source : rouvrez le formulaire\.$/],
    [{ [KEY_POSTE]: 'LAB-NEW-02', 'Équipe': 'Labo Textile', Commentaires: { x: 1 } }, 'Commentaires', /Valeur invalide/],
    // The sheet's own refusal (a rejecting range rule the server does not read under the lock).
    [{ [KEY_POSTE]: 'LAB-NEW-02', 'Équipe': 'Labo Textile', OS: 'BeOS' }, 'OS',
      /^Le Google Sheet source a refusé la valeur « BeOS » \(Exception: The data you entered in cell K\d+ violates/],
  ];
  const before = snapshotOf(env, POSTES_TAB);
  const count = monthData(sb.ctx, '2026-05').postes.length;
  for (const [record, field, message] of cases) {
    const e = fail(sb.ctx, 'api_addPoste', { month: '2026-05', record }, 'VALIDATION', field);
    assert.match(e.message, message);
    assert.equal(snapshotOf(env, POSTES_TAB), before, 'source untouched: ' + e.message);
  }
  assert.equal(monthData(sb.ctx, '2026-05').postes.length, count, 'snapshot untouched');

  // A poste added in the source since the last sync.
  const sh = sheet(env, POSTES_TAB);
  const free = lastKeyRow(env, POSTES_TAB, KEY_POSTE) + 2;
  sh.getRange(free, headersOf(env, POSTES_TAB).indexOf(KEY_POSTE) + 1).setValue('LAB-SRC-01');
  const after = snapshotOf(env, POSTES_TAB);
  const e = fail(sb.ctx, 'api_addPoste', { month: '2026-05', record: { [KEY_POSTE]: 'lab-src-01', 'Équipe': 'Labo Textile' } },
    'VALIDATION', KEY_POSTE);
  assert.match(e.message, /existe déjà dans l’onglet « Suivi des postes » du Google Sheet source/);
  assert.equal(snapshotOf(env, POSTES_TAB), after);

  // Below a non-empty row (a row is inserted), the sheet refuses: the inserted row is removed again.
  const calls = env.__state.calls;
  const inserts = calls.insertRowsAfter || 0;
  const deletes = calls.deleteRows || 0;
  const e2 = fail(sb.ctx, 'api_addPoste', { month: '2026-05', record: { [KEY_POSTE]: 'LAB-NEW-03', 'Équipe': 'Labo Textile',
    OS: 'BeOS' } }, 'VALIDATION', 'OS');
  assert.match(e2.message, /refusé la valeur « BeOS »/);
  assert.deepEqual([calls.insertRowsAfter - inserts, calls.deleteRows - deletes], [1, 1]);
  assert.equal(snapshotOf(env, POSTES_TAB), after);
});

test('addPoste: a Sheets failure naming a cell maps to its column; any other failure is INTERNAL; nothing is left behind', () => {
  const sb = synced();
  const env = sb.env;
  const before = snapshotOf(env, POSTES_TAB);
  const crit = String.fromCharCode(65 + headersOf(env, POSTES_TAB).indexOf('Criticité équipement'));
  env.__fault({ method: 'setValues', id: SOURCE_ID, sheet: POSTES_TAB,
    message: 'Exception: Les données que vous avez saisies dans la cellule ' + crit + '11 ne respectent pas les règles.' });
  const e = fail(sb.ctx, 'api_addPoste', { month: '2026-05', record: NEW_POSTE }, 'VALIDATION', 'Criticité équipement');
  assert.match(e.message, /refusé la valeur « Haute »/);
  assert.equal(snapshotOf(env, POSTES_TAB), before);

  // The second segment fails (after the key segment was written): undone.
  let n = 0;
  const setValues = Object.getPrototypeOf(sheet(env, POSTES_TAB).getRange(1, 1)).setValues;
  Object.getPrototypeOf(sheet(env, POSTES_TAB).getRange(1, 1)).setValues = function (v) {
    if (this.getSheet().getName() === POSTES_TAB && ++n === 2) throw new Error('Exception: Service Spreadsheets failed while accessing document.');
    return setValues.call(this, v);
  };
  try {
    fail(sb.ctx, 'api_addPoste', { month: '2026-05', record: NEW_POSTE }, 'INTERNAL', undefined);
  } finally {
    Object.getPrototypeOf(sheet(env, POSTES_TAB).getRange(1, 1)).setValues = setValues;
  }
  assert.equal(n, 2, 'the row is written in segments around the computed columns');
  assert.equal(snapshotOf(env, POSTES_TAB), before);
  assert.equal(byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, NEW_POSTE[KEY_POSTE]), undefined);
});

test('addPoste (past month): the snapshot only; computed columns editable, only Oui/Non lists enforced', () => {
  const sb = synced();
  ok(sb.ctx, 'api_importMonth', { month: '2026-04' });
  const { ctx, env } = execution(sb.env);
  const before = snapshotOf(env, POSTES_TAB);
  const opened = env.__state.opened.filter((id) => id === SOURCE_ID).length;
  const rec = ok(ctx, 'api_addPoste', { month: '2026-04', record: { [KEY_POSTE]: 'LAB-OLD-01', 'Équipe': 'Équipe hors liste',
    'Score conformité': '75%', 'Criticité équipement': 'Critique', OS: 'BeOS', 'Deadline': '1/6/2026' } });
  assert.deepEqual([rec['Score conformité'], rec._score, rec['Criticité équipement'], rec.OS, rec.Deadline],
    ['75%', 75, 'Critique', 'BeOS', '01/06/2026']);
  assert.equal(env.__state.opened.filter((id) => id === SOURCE_ID).length, opened, 'the source is never opened');
  assert.equal(snapshotOf(env, POSTES_TAB), before);
  assert.ok(byName(monthData(ctx, '2026-04').postes, KEY_POSTE, 'LAB-OLD-01'));
  assert.equal(byName(monthData(ctx, '2026-05').postes, KEY_POSTE, 'LAB-OLD-01'), undefined);

  fail(ctx, 'api_addPoste', { month: '2026-04', record: { [KEY_POSTE]: 'LAB-OLD-02', 'Équipe': 'X', 'IT Decathlon': 'Bof' } },
    'VALIDATION', 'IT Decathlon');
  fail(ctx, 'api_addPoste', { month: '2026-04', record: { [KEY_POSTE]: 'LAB-OLD-02' } }, 'VALIDATION', 'Équipe');
  fail(ctx, 'api_addPoste', { month: '2026-04', record: { [KEY_POSTE]: 'LAB-OLD-02', 'Équipe': 'X', Inconnue: 'v' } },
    'VALIDATION', 'Inconnue');
  fail(ctx, 'api_addPoste', { month: '2026-04', record: { [KEY_POSTE]: 'lab-old-01', 'Équipe': 'X' } }, 'VALIDATION', KEY_POSTE);
  fail(ctx, 'api_addPoste', { month: '2025-01', record: { [KEY_POSTE]: 'X', 'Équipe': 'X' } }, 'NOT_FOUND', undefined);
  fail(ctx, 'api_addPoste', { month: '2026-04', record: [] }, 'VALIDATION', undefined);
  fail(ctx, 'api_addPoste', { month: '2026-04', record: { [KEY_POSTE]: 'Y', _id: 'x' } }, 'VALIDATION', undefined);
});

// ------------------------------------------------------------------------------ rerouted endpoints

test('addApplication goes through the same checks: field errors, Galink / IDP kept in the snapshot only', () => {
  const sb = synced();
  const env = sb.env;
  const before = snapshotOf(env, APPS_TAB);
  fail(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'minitab' } }, 'VALIDATION', KEY_APP);
  fail(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'Canva', Contrat: 'Peut-être' } }, 'VALIDATION', 'Contrat');
  fail(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'Canva', Galink: 'Bof' } }, 'VALIDATION', 'Galink');
  fail(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'Canva', Doublon: 'oui' } }, 'VALIDATION', 'Doublon');
  fail(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: '' } }, 'VALIDATION', KEY_APP);
  assert.equal(snapshotOf(env, APPS_TAB), before);

  const rec = ok(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'Canva', Type: 'Outil maison', Contrat: 'Oui',
    SIP: 'Non', Galink: 'Oui', IDP: 'Non', Date: '2026-05-02' } });
  assert.deepEqual([rec.Type, rec.Galink, rec.IDP, rec.Date, rec.Doublon], ['Outil maison', 'Oui', 'Non', '02/05/2026', null],
    'a list with allowInvalid accepts other values');
  const headers = headersOf(env, APPS_TAB);
  const row = sheet(env, APPS_TAB).getRange(lastKeyRow(env, APPS_TAB, KEY_APP) + 1, 1, 1, headers.length).getDisplayValues()[0];
  assert.deepEqual([row[headers.indexOf(KEY_APP)], row[headers.indexOf('Contrat')], row[headers.indexOf('SIP')]], ['Canva', 'Oui', 'Non']);
  assert.ok(!headers.includes('Galink') && !headers.includes('IDP'), 'the source has no Galink / IDP column: nothing written for them');
  const stored = byName(monthData(sb.ctx, '2026-05').applications, KEY_APP, 'Canva');
  assert.deepEqual([stored.Galink, stored.IDP], ['Oui', 'Non']);
});

test('addGenericPoste is not a form: no rule enforced, formulas copied down, computed values kept', () => {
  const sb = synced();
  const env = sb.env;
  const headers = headersOf(env, POSTES_TAB);
  const res = ok(sb.ctx, 'api_addGenericPoste', { month: '2026-05' });
  assert.equal(res.created, true);
  assert.equal(res.record['Équipe'], null, 'no required field');
  assert.deepEqual([res.record['Score conformité'], res.record.Statut], ['0%', 'Non conforme']);
  const sh = sheet(env, POSTES_TAB);
  const row = lastKeyRow(env, POSTES_TAB, KEY_POSTE) + 1;
  const score = headers.indexOf('Score conformité') + 1;
  assert.equal(sh.getRange(row, 1 + headers.indexOf(KEY_POSTE)).getValue(), 'Poste générique Decathlon');
  assert.equal(sh.getRange(row, score).getFormula(), sh.getRange(row - 1, score).getFormula(), 'formula copied down');
  assert.equal(ok(sb.ctx, 'api_syncNow').result.changed, false);
});

test('edits of the current month: refusals name the field (formula, data validation)', () => {
  const sb = synced();
  const md = monthData(sb.ctx, '2026-05');
  const tex = byName(md.postes, KEY_POSTE, 'LAB-TEX-01');
  fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: tex._id, updates: { Statut: 'Fait' } }] }, 'VALIDATION', 'Statut');
  const e = fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: tex._id, updates: { 'EDR Decathlon': 'Bof' } }] },
    'VALIDATION', 'EDR Decathlon');
  assert.match(e.message, /refusé la valeur « Bof »/);
  fail(sb.ctx, 'api_saveApplications', { month: '2026-05', changes: [{ id: md.applications[0]._id, updates: { IDP: 'Bof' } }] },
    'VALIDATION', 'IDP');
  // Errors other than VALIDATION never carry a field.
  fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: 'nope', updates: { Statut: 'x' } }] }, 'NOT_FOUND', undefined);
});

test('formSchema timing lines carry counts only', () => {
  const sb = synced();
  const { ctx, env } = execution(sb.env);
  const n0 = timingLines(env).length;
  ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' });
  ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05' });
  ok(ctx, 'api_getFormSchema', { entity: 'postes', month: '2026-05', fresh: true });
  const lines = timingLines(env).slice(n0).filter((l) => l.stage === 'formSchema');
  assert.deepEqual(lines.map((l) => l.cache), ['miss', 'hit', 'bypass']);
  assert.deepEqual(lines.map((l) => [l.columns, l.computed, l.selects]), [[26, 4, 8], [26, 4, 8], [26, 4, 8]]);
});
