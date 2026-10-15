'use strict';
/**
 * Performance guard: Sheets / Properties / Cache call counts of the main flows on a LARGE data
 * spreadsheet (24 months x 300 postes + 150 applications, ~2000 ImportLog rows, a référentiel per
 * month), built programmatically. Each flow runs in a fresh execution (gasSandbox loadGas({env})), so
 * the per-execution caches start cold as in Apps Script.
 *
 * The fakes have no latency: what matters in Apps Script is the number of round trips and the
 * number of cells moved, so this test pins them. BASELINE holds today's numbers as upper bounds:
 * an optimisation lowers them (update BASELINE in the same change), a regression fails here.
 *
 * PERF_OUT=/path/file.json node --test test/integration/perf.test.js also writes the measured
 * numbers (and the fixture size) to that file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { loadGas, timingLines } = require('../helpers/gasSandbox');
const data = require('../fixtures/data');

const TODAY = '2026-05-15';
const LIVE_MONTH = '2026-05';
const MONTH_COUNT = 24;
const POSTES_PER_MONTH = 300;
const APPS_PER_MONTH = 150;
const IMPORT_LOG_ROWS = 2000;
const SOURCE_ID = '1PerfSourceSpreadsheetId0000000000000000000';
const DATA_ID = '1PerfDataSpreadsheetId00000000000000000000000';
const READER = 'lea.reader@decathlon.com';
const ADMIN_GROUP = 'secu-admins@decathlon.com';
const GROUP_ADMIN = 'chef@decathlon.com';

/**
 * Upper bounds = the numbers measured when they were last lowered (only ever lower them). History:
 * the first baseline read every month's rows to return one (getMonthData: 8 getValues, 96229 cells),
 * ImportLog in full (getImportLog: 16020 cells) and Meta on every call; month spans, the ImportLog
 * tail, the per-execution read memo and the schema-version property brought them to the numbers below.
 * The live-month save then read the whole source tab twice (display values + formulas: 15100 source
 * cells); it now reads the header block, the key column and the edited row's formulas (700 cells),
 * which costs one more, narrow, getDisplayValues (1 -> 2). The hourly sync
 * read the source while holding the script lock; it now reads it before (sourceReadsLocked: 0). The admin
 * bootstrap opened the source for its title and URL (openById 2); it now uses the title stored in the Script
 * Properties and builds the URLs from the ids (1). Cache reads count get and getAll calls: the group
 * memberships a call may need are read in one getAll. doGet renders the admin bootstrap into the page: it
 * costs exactly bootstrapAdmin plus the FAVICON_URL property read, so it gets the slim bootstrap too.
 * A month span also reads the row on each side of the month's block (same getValues), so that a month
 * that grew or moved past the block while it was read outside the lock is detected: cellsRead of the
 * flows that read spans went up by those rows (getMonthData +16, savePostesLive +6, syncNoChange +16).
 * These are the only bounds ever raised, both for correctness.
 * The creation forms added getDataValidations (0 for every earlier flow) and three flows: the form schema
 * read cold (the source only: header block, key column, two formula blocks, the last row's rules and raw
 * values, one box of Référentiel lists; cached), warm (the cache alone: no spreadsheet opened) and a
 * live poste added from the form (the append reads + the new row read back after the write).
 */
const BASELINE = {
  bootstrapAdmin: { openById: 1, getValues: 3, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 12801,
    getDataRange: 0, propertiesReads: 2, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 0, sourceReadsLocked: 0 },
  // An explicit lecteur: the admin groups are checked (they could raise the role), cold here.
  bootstrapLecteur: { openById: 1, getValues: 3, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 12801,
    getDataRange: 0, propertiesReads: 2, cacheReads: 1, cacheWrites: 1, groupCalls: 1, sourceCellsRead: 0, sourceReadsLocked: 0 },
  bootstrapGroupCold: { openById: 1, getValues: 3, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 12801,
    getDataRange: 0, propertiesReads: 2, cacheReads: 1, cacheWrites: 1, groupCalls: 1, sourceCellsRead: 0, sourceReadsLocked: 0 },
  // Warm: one getAll, no GroupsApp call, one put (the sliding renewal).
  bootstrapGroupWarm: { openById: 1, getValues: 3, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 12801,
    getDataRange: 0, propertiesReads: 2, cacheReads: 1, cacheWrites: 1, groupCalls: 0, sourceCellsRead: 0, sourceReadsLocked: 0 },
  // doGet with the bootstrap inline: the admin bootstrap + the FAVICON_URL property, nothing else.
  doGetAdmin: { openById: 1, getValues: 3, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 12801,
    getDataRange: 0, propertiesReads: 3, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 0, sourceReadsLocked: 0 },
  // Paramètres opens the source (the live check), not the data spreadsheet (its URL is built from the id).
  getSettings: { openById: 1, getValues: 0, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 0,
    getDataRange: 0, propertiesReads: 2, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 0, sourceReadsLocked: 0 },
  getMonthData: { openById: 1, getValues: 8, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 16281,
    getDataRange: 0, propertiesReads: 1, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 0, sourceReadsLocked: 0 },
  getTimeline: { openById: 1, getValues: 3, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 66813,
    getDataRange: 2, propertiesReads: 1, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 0, sourceReadsLocked: 0 },
  getImportLog: { openById: 1, getValues: 1, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 96,
    getDataRange: 0, propertiesReads: 1, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 0, sourceReadsLocked: 0 },
  // The write-back reads the source under the lock by design (it writes there next).
  savePostesLive: { openById: 2, getValues: 4, getDisplayValues: 2, getFormulas: 1, getDataValidations: 0, cellsRead: 15307,
    getDataRange: 1, propertiesReads: 2, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 700, sourceReadsLocked: 3 },
  formSchemaCold: { openById: 1, getValues: 1, getDisplayValues: 3, getFormulas: 2, getDataValidations: 1, cellsRead: 812,
    getDataRange: 1, propertiesReads: 1, cacheReads: 1, cacheWrites: 1, groupCalls: 0, sourceCellsRead: 812, sourceReadsLocked: 0 },
  formSchemaWarm: { openById: 0, getValues: 0, getDisplayValues: 0, getFormulas: 0, getDataValidations: 0, cellsRead: 0,
    getDataRange: 0, propertiesReads: 1, cacheReads: 1, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 0, sourceReadsLocked: 0 },
  // Under the lock by design, like savePostesLive (the sheet's rules are checked where the row is written).
  addPosteLive: { openById: 2, getValues: 6, getDisplayValues: 3, getFormulas: 2, getDataValidations: 1, cellsRead: 15440,
    getDataRange: 1, propertiesReads: 2, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 825, sourceReadsLocked: 7 },
  syncNoChange: { openById: 2, getValues: 10, getDisplayValues: 3, getFormulas: 0, getDataValidations: 0, cellsRead: 35981,
    getDataRange: 3, propertiesReads: 4, cacheReads: 0, cacheWrites: 0, groupCalls: 0, sourceCellsRead: 19700, sourceReadsLocked: 0 },
};

// ------------------------------------------------------------------------------------- fixture

function months() {
  const out = [];
  let y = Number(LIVE_MONTH.slice(0, 4));
  let m = Number(LIVE_MONTH.slice(5, 7));
  for (let i = 0; i < MONTH_COUNT; i++) {
    out.unshift(y + '-' + String(m).padStart(2, '0'));
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

const TEAMS = ['Labo Textile', 'Labo Chaussure', 'Labo Mécanique', 'R&D Vélo'];
const RISKS = ['Critique', 'Élevé', 'Moyen', 'Faible'];
const pad = (n, w) => String(n).padStart(w, '0');
const yesNo = (n) => (n % 3 ? 'Oui' : 'Non');

/** Poste i of month index mi (a few values drift from month to month). */
function poste(i, mi) {
  const r = {};
  for (const h of data.POSTES_HEADERS) r[h] = '';
  Object.assign(r, {
    'N° Visite': 'V-' + pad(i, 4), 'Date visite': pad(1 + (i % 28), 2) + '/03/2026', 'Prochaine revue': '01/09/2026',
    'Équipe': TEAMS[i % 4], 'Bâtiment / Labo': 'Bâtiment ' + 'ABC'[i % 3], 'Responsable': 'Responsable ' + (i % 40),
    'Nom du poste': 'PC-' + pad(i, 4), "Date d'achat": '15/01/2021', 'Criticité équipement': ['Haute', 'Moyenne', 'Basse'][i % 3],
    'IT Decathlon': yesNo(i), 'OS': ['Windows', 'macOS', 'Linux'][i % 3], 'Version OS': '11 23H2',
    'EDR Decathlon': yesNo(i + mi), 'Chiffrement disque': yesNo(i + 1), 'Type de compte': 'Nominatif',
    'Réseau Decathlon': yesNo(i + 2), 'Score conformité': ((i * 7 + mi) % 100) + '%', 'Niveau de risque': RISKS[(i + mi) % 4],
    'Statut': i % 5 ? 'Conforme' : 'Non conforme', 'Commentaires': i % 9 ? '' : 'Poste partagé', 'Enrolée': yesNo(i),
  });
  return r;
}

function app(i, mi) {
  const r = {};
  for (const h of data.APPS_HEADERS) r[h] = '';
  Object.assign(r, {
    'Date': '12/03/2026', 'Nom du logiciel / service': 'Logiciel ' + pad(i, 3), 'Éditeur': 'Éditeur ' + (i % 30),
    'Type': ['Logiciel', 'SaaS', 'Script'][i % 3], 'Équipe': TEAMS[i % 4], 'Installé sur poste': 'PC-' + pad(i * 2, 4),
    'Contrat': yesNo(i), 'SIP': yesNo(i + 1), 'Données sensibles exposées': yesNo(i + 2),
    'Niveau de risque': RISKS[(i + mi) % 4], 'Score conformité': ((i * 3 + mi) % 100) + '%', 'Statut': 'Conforme',
  });
  return r;
}

/** Source tab: banner row, header row, records (display strings only). */
function sourceTab(banner, headers, records) {
  const rows = [[banner].concat(headers.slice(1).map(() => '')), headers.slice()];
  for (const rec of records) rows.push(headers.map((h) => rec[h]));
  return { values: rows, display: rows.map((r) => r.slice()) };
}

function sourceReferentiel() {
  const cats = Object.keys(data.REFERENTIEL);
  const height = Math.max(...cats.map((c) => data.REFERENTIEL[c].length));
  const rows = [cats.slice()];
  for (let i = 0; i < height; i++) rows.push(cats.map((c) => data.REFERENTIEL[c][i] || ''));
  return { values: rows, display: rows.map((r) => r.slice()) };
}

/** Column letter of a header (A..Y: the fixture has fewer than 27 columns). */
function letter(headers, name) {
  return String.fromCharCode(65 + headers.indexOf(name));
}

/**
 * The postes tab as a real source has it: a formula in « Score conformité » on every record row (the
 * display keeps the value) and data validation on whole columns (Oui/Non lists, OS and Équipe from the
 * Référentiel), so that the form flows read real rules. Nothing else reads them.
 */
function withFormRules(tab) {
  const H = data.POSTES_HEADERS;
  const score = H.indexOf('Score conformité');
  for (let r = 2; r < tab.values.length; r++) tab.values[r][score] = '=COUNTIF(J' + (r + 1) + ':P' + (r + 1) + ',"Oui")/5';
  const cats = Object.keys(data.REFERENTIEL);
  const height = Math.max(...cats.map((c) => data.REFERENTIEL[c].length));
  const ref = (cat) => {
    const c = String.fromCharCode(65 + cats.indexOf(cat));
    return "'Référentiel'!" + c + '2:' + c + (height + 1);
  };
  const rule = (name, def) => Object.assign({ a1: letter(H, name) + '3:' + letter(H, name) + tab.values.length }, def);
  const yesNo = { type: 'VALUE_IN_LIST', values: ['Oui', 'Non'] };
  tab.validations = [rule('IT Decathlon', yesNo), rule('EDR Decathlon', yesNo), rule('Réseau Decathlon', yesNo),
    rule('OS', { type: 'VALUE_IN_RANGE', range: ref('OS') }),
    rule('Équipe', { type: 'VALUE_IN_RANGE', range: ref('Équipe'), allowInvalid: true })];
  return tab;
}

function buildSource() {
  const mi = MONTH_COUNT - 1;
  const postes = Array.from({ length: POSTES_PER_MONTH }, (_, i) => poste(i, mi));
  const apps = Array.from({ length: APPS_PER_MONTH }, (_, i) => app(i, mi));
  return {
    id: SOURCE_ID, name: 'ShadowIT_Industry', timeZone: 'Europe/Paris',
    sheets: {
      'Suivi des postes': withFormRules(sourceTab('Suivi des postes', data.POSTES_HEADERS, postes)),
      'Suivi des applications': sourceTab('Suivi des applications', data.APPS_HEADERS, apps),
      'Référentiel': sourceReferentiel(),
    },
  };
}

/** Data spreadsheet with every month but the live one (the first sync imports it). */
function buildData(schemas, schemaVersion) {
  const ms = months().slice(0, -1);
  const postes = [schemas.Postes.slice()];
  const apps = [schemas.Applications.slice()];
  const ref = [schemas.Referentiel.slice()];
  const log = [schemas.ImportLog.slice()];
  ms.forEach((m, mi) => {
    for (let i = 0; i < POSTES_PER_MONTH; i++) {
      const rec = poste(i, mi);
      postes.push([m, 'p-' + m + '-' + i, rec['Nom du poste'], String(i), JSON.stringify(rec), '']);
    }
    for (let i = 0; i < APPS_PER_MONTH; i++) {
      const rec = Object.assign(app(i, mi), { Galink: yesNo(i), IDP: yesNo(i + 1) });
      apps.push([m, 'a-' + m + '-' + i, rec['Nom du logiciel / service'], String(i), JSON.stringify(rec), '']);
    }
    for (const [cat, values] of Object.entries(data.REFERENTIEL)) values.forEach((v, i) => ref.push([m, cat, String(i), v]));
  });
  for (let k = 0; k < IMPORT_LOG_ROWS; k++) {
    const m = ms[Math.floor(k * ms.length / IMPORT_LOG_ROWS)];
    log.push([m, m + '-01 ' + pad(k % 24, 2) + ':00', SOURCE_ID,
      JSON.stringify({ postes: POSTES_PER_MONTH, applications: APPS_PER_MONTH, referentiel: 8 }),
      JSON.stringify(data.POSTES_HEADERS), JSON.stringify(data.APPS_HEADERS), '[]',
      JSON.stringify({ created: false, postes: { added: 0, removed: 0, changed: 1, values: 1 },
        applications: { added: 0, removed: 0, changed: 0, values: 0 }, referentiel: false })]);
  }
  const actions = [schemas.Actions.slice()];
  for (let i = 0; i < 60; i++) {
    actions.push(['act-' + i, 'poste', 'PC-' + pad(i, 4), TEAMS[i % 4], 'Mettre à jour', 'Responsable ' + i, '01/03/2026', '',
      '30/06/2026', 'Haute', 'En cours', ms[i % ms.length], '', '2026-03-01', '']);
  }
  const repl = [schemas.Replacements.slice()];
  for (let i = 0; i < 20; i++) repl.push(['rep-' + i, 'PC-' + pad(i, 4), 'PC-N' + i, TEAMS[i % 4], 'R', '01/04/2026', '', '2026-04-01']);
  return {
    id: DATA_ID, name: 'Shadow IT — données', timeZone: 'Europe/Paris',
    sheets: {
      Postes: { values: postes }, Applications: { values: apps }, Referentiel: { values: ref },
      Actions: { values: actions }, Replacements: { values: repl }, ImportLog: { values: log },
      Meta: { values: [['key', 'value'], ['schema_version', schemaVersion]] },
    },
  };
}

// ------------------------------------------------------------------------------------- measure

function call(ctx, name, args) {
  const res = JSON.parse(ctx[name](args === undefined ? 'null' : JSON.stringify(args)));
  assert.equal(res.ok, true, name + ' failed: ' + JSON.stringify(res.error));
  return res.data;
}

/** A new execution over the shared env, as `email` (undefined = the deployer, an admin). */
function execution(env, email) {
  env.__setActiveUser(email);
  const sb = loadGas({ env });
  sb.ctx.Config.today = () => TODAY;
  return sb.ctx;
}

const n = (o, k) => o[k] || 0;

/**
 * Runs fn and returns the counts it caused: Sheets round trips (getValues includes getValue; data
 * validation reads: getDataValidations), cells read by every read method together, Properties reads
 * (script + user: getProperty, getProperties, getKeys), CacheService reads (get / getAll) and writes (put / putAll),
 * GroupsApp calls (hasUser), cells read from the SOURCE spreadsheet and source reads made while the
 * script lock was held (gasFakes state.reads).
 */
function measure(env, fn) {
  const st = env.__state;
  const c0 = Object.assign({}, st.calls);
  const k0 = Object.assign({}, st.cells);
  const r0 = st.reads.length;
  const g0 = st.groupCalls;
  const lines0 = timingLines(env).length;
  const value = fn();
  const sourceReads = st.reads.slice(r0).filter((r) => r.spreadsheetId === SOURCE_ID);
  const d = (k) => n(st.calls, k) - n(c0, k);
  const cells = (k) => n(st.cells, k) - n(k0, k);
  return {
    value,
    lines: timingLines(env).slice(lines0),
    counts: {
      openById: d('openById'),
      getValues: d('getValues') + d('getValue'),
      getDisplayValues: d('getDisplayValues'),
      getFormulas: d('getFormulas'),
      getDataValidations: d('getDataValidations'),
      cellsRead: cells('getValues') + cells('getValue') + cells('getDisplayValues') + cells('getFormulas') +
        cells('getDataValidations'),
      getDataRange: d('getDataRange'),
      propertiesReads: d('getProperty') + d('getProperties') + d('getKeys'),
      cacheReads: d('cacheGet') + d('cacheGetAll'),
      cacheWrites: d('cachePut') + d('cachePutAll'),
      groupCalls: st.groupCalls - g0,
      sourceCellsRead: sourceReads.reduce((sum, r) => sum + r.cells, 0),
      sourceReadsLocked: sourceReads.filter((r) => r.lockHeld).length,
    },
  };
}

function setup() {
  const probe = loadGas().ctx.Config;
  const schemas = JSON.parse(JSON.stringify(probe.SCHEMAS));
  const sb = loadGas({
    sources: [buildSource(), buildData(schemas, probe.SCHEMA_VERSION)],
    props: { DATA_SPREADSHEET_ID: DATA_ID, SOURCE_SPREADSHEET_ID: SOURCE_ID },
  });
  const env = sb.env;
  env.__setGroups({ [ADMIN_GROUP]: { members: [GROUP_ADMIN] } });
  let ctx = execution(env);
  call(ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  call(ctx, 'api_saveGroup', { email: ADMIN_GROUP, role: 'admin' });
  ctx = execution(env);
  const first = call(ctx, 'api_syncNow');
  assert.equal(first.result.changed, true, 'the first sync creates the live month');
  return env;
}

test('call counts of the main flows on a large data spreadsheet stay within the baseline', () => {
  const env = setup();
  const results = {};
  let ctx;

  ctx = execution(env);
  let m = measure(env, () => call(ctx, 'api_bootstrap'));
  assert.equal(m.value.months.length, MONTH_COUNT);
  assert.equal(m.value.user.role, 'admin');
  results.bootstrapAdmin = m;

  ctx = execution(env, READER);
  m = measure(env, () => call(ctx, 'api_bootstrap'));
  assert.equal(m.value.user.role, 'lecteur');
  results.bootstrapLecteur = m;

  // An admin through a Google Group: cold (GroupsApp), then warm (one cache read, renewed).
  ctx = execution(env, GROUP_ADMIN);
  m = measure(env, () => call(ctx, 'api_bootstrap'));
  assert.equal(m.value.user.role, 'admin');
  results.bootstrapGroupCold = m;
  ctx = execution(env, GROUP_ADMIN);
  m = measure(env, () => call(ctx, 'api_bootstrap'));
  results.bootstrapGroupWarm = m;

  ctx = execution(env);
  m = measure(env, () => call(ctx, 'api_getSettings'));
  assert.deepEqual(Object.values(m.value.source.tabsFound), [true, true, true]);
  results.getSettings = m;

  // The cold open: doGet renders the page with the bootstrap inline (no other data read).
  ctx = execution(env);
  m = measure(env, () => ctx.doGet({ parameter: { page: 'dashboard' } }).getContent());
  const inline = /<script type="application\/json" id="boot-data">([^<]*)<\/script>/.exec(m.value);
  assert.equal(JSON.parse(inline[1]).data.months.length, MONTH_COUNT);
  results.doGetAdmin = m;

  ctx = execution(env);
  m = measure(env, () => call(ctx, 'api_getMonthData', { month: LIVE_MONTH }));
  assert.equal(m.value.postes.length, POSTES_PER_MONTH);
  assert.equal(m.value.applications.length, APPS_PER_MONTH);
  const target = m.value.postes[10];
  results.getMonthData = m;

  ctx = execution(env);
  m = measure(env, () => call(ctx, 'api_getTimeline'));
  assert.equal(m.value.length, MONTH_COUNT);
  results.getTimeline = m;

  ctx = execution(env);
  m = measure(env, () => call(ctx, 'api_getImportLog'));
  assert.equal(m.value.length, 12, 'the default limit');
  assert.equal(m.value[0].month, LIVE_MONTH, 'newest first: the first sync');
  results.getImportLog = m;

  // The hourly trigger run when the source has not changed since the last sync.
  ctx = execution(env);
  m = measure(env, () => ctx.syncHourly());
  assert.deepEqual(m.lines.filter((l) => l.stage === 'sync').map((l) => [l.ok, l.changed]), [[true, false]]);
  results.syncNoChange = m;
  // Neither the month view nor the no-change sync reads a whole data tab (only the month's rows).
  for (const flow of ['getMonthData', 'syncNoChange']) {
    assert.deepEqual(results[flow].lines.filter((l) => l.stage === 'sheet').map((l) => l.tab), [], flow);
  }

  ctx = execution(env);
  m = measure(env, () => call(ctx, 'api_savePostes',
    { month: LIVE_MONTH, changes: [{ id: target._id, updates: { Commentaires: 'Revu le ' + TODAY } }] }));
  assert.equal(m.value.sourceUpdated, true);
  results.savePostesLive = m;

  // The creation form: the schema read from the source (cold), then from the cache (no spreadsheet
  // opened at all), then a new poste of the live month (strict checks, formula copied down, read back).
  ctx = execution(env);
  m = measure(env, () => call(ctx, 'api_getFormSchema', { entity: 'postes', month: LIVE_MONTH }));
  assert.equal(m.value.origin, 'source');
  assert.deepEqual(m.value.columns.filter((c) => c.computed).map((c) => c.name), ['Score conformité']);
  assert.deepEqual(m.value.columns.find((c) => c.name === 'OS').options, ['Windows', 'macOS', 'Linux']);
  results.formSchemaCold = m;
  ctx = execution(env);
  m = measure(env, () => call(ctx, 'api_getFormSchema', { entity: 'postes', month: LIVE_MONTH }));
  assert.equal(m.lines.find((l) => l.stage === 'formSchema').cache, 'hit');
  results.formSchemaWarm = m;
  ctx = execution(env);
  m = measure(env, () => call(ctx, 'api_addPoste', { month: LIVE_MONTH, record: { 'Nom du poste': 'PC-NEW-0001',
    'Équipe': TEAMS[0], 'IT Decathlon': 'Oui', OS: 'Linux', 'Version OS': 'Ubuntu 24.04' } }));
  assert.equal(m.value['Nom du poste'], 'PC-NEW-0001');
  results.addPosteLive = m;

  const measured = {};
  for (const [k, r] of Object.entries(results)) measured[k] = r.counts;
  if (process.env.PERF_OUT) {
    fs.writeFileSync(process.env.PERF_OUT, JSON.stringify({
      fixture: { months: MONTH_COUNT, postesPerMonth: POSTES_PER_MONTH, appsPerMonth: APPS_PER_MONTH,
        importLogRows: IMPORT_LOG_ROWS + 1, referentielRows: MONTH_COUNT * Object.values(data.REFERENTIEL).flat().length },
      note: 'Counts from the in-memory GAS fakes: round trips and cells read per flow, in a fresh execution. ' +
        'Timing lines (ms) are not meaningful here: read them from the Apps Script Executions log.',
      flows: measured,
      timingStages: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.lines.map((l) => l.stage || l.api)])),
    }, null, 2) + '\n');
  }

  const over = [];
  for (const [flow, bounds] of Object.entries(BASELINE)) {
    assert.ok(measured[flow], 'flow not measured: ' + flow);
    assert.deepEqual(Object.keys(measured[flow]).sort(), Object.keys(bounds).sort(), flow + ': metric set');
    for (const [metric, max] of Object.entries(bounds)) {
      if (measured[flow][metric] > max) over.push(flow + '.' + metric + ' = ' + measured[flow][metric] + ' > ' + max);
    }
  }
  assert.deepEqual(over, [], 'call counts above the baseline:\n' + over.join('\n') + '\nmeasured: ' + JSON.stringify(measured));
});
