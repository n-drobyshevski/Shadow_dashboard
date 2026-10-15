'use strict';
/**
 * Integration tests for src/Api.js: envelope, month data shapes, edits, actions / replacements,
 * timeline, diff and locking — all src/*.js running in the GAS sandbox over the in-memory fakes.
 *
 * Fixture flow: the live source starts with the 2026-04 content; after importing it, the same
 * source id is swapped to the 2026-05 content and 2026-05 is imported.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');
const data = require('../fixtures/data');

const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const ERROR_CODES = ['NOT_CONFIGURED', 'MONTH_EXISTS', 'NOT_FOUND', 'BUSY', 'VALIDATION', 'SOURCE_ERROR', 'INTERNAL'];
const ACTION_KEYS = ['id', 'target_type', 'target_name', 'equipe', 'action', 'responsable', 'date_created',
  'date_completed', 'deadline', 'priorite', 'status', 'source_month', 'comment', 'recorded_at', 'updated_at'];
const REPLACEMENT_KEYS = ['id', 'old_poste', 'new_poste', 'equipe', 'responsable', 'date_replacement', 'comment',
  'recorded_at'];
const ISO_DATETIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ------------------------------------------------------------------------------------ helpers

/**
 * The fixture builds Date cells at host-local midnight; Sheets returns them at midnight of the
 * spreadsheet's zone (Europe/Paris). Re-anchor them at noon UTC (same calendar day in Paris) so the
 * expected 'DD/MM/YYYY' strings hold whatever the host TZ is.
 */
function source(month) {
  const def = buildSourceSpreadsheet(month);
  for (const tab of Object.values(def.sheets)) {
    tab.values = tab.values.map((row) => row.map((v) => (v instanceof Date
      ? new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 12)) : v)));
  }
  return def;
}

/**
 * Walks a parsed response: ISO date-times (what a Date becomes through JSON.stringify) are only
 * allowed in `_updated_at`; everything must be JSON-native.
 */
function assertJsonNative(value, path) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (!/_updated_at$/.test(path)) assert.doesNotMatch(value, ISO_DATETIME_RE, 'Date-like string at ' + path);
    return;
  }
  assert.equal(typeof value, 'object', 'unexpected type at ' + path);
  for (const [k, v] of Object.entries(value)) assertJsonNative(v, path + '.' + k);
}

/** Calls an api_* function and checks the envelope invariants. */
function call(ctx, name, args) {
  const out = ctx[name](args === undefined ? 'null' : JSON.stringify(args));
  assert.equal(typeof out, 'string', name + ' must return a string');
  const res = JSON.parse(out);
  assert.equal(typeof res.ok, 'boolean', name + ' envelope');
  if (res.ok) {
    assert.deepEqual(Object.keys(res).sort(), ['data', 'ok']);
    assertJsonNative(res.data, name);
  } else {
    assert.deepEqual(Object.keys(res).sort(), ['error', 'ok']);
    assert.deepEqual(Object.keys(res.error).sort(), ['code', 'message']);
    assert.ok(ERROR_CODES.includes(res.error.code), res.error.code);
    assert.equal(typeof res.error.message, 'string');
    assert.doesNotMatch(res.error.message, /\n|\s+at\s+\S+\s+\(|\.js:\d+/, 'stack leaked by ' + name);
  }
  return res;
}

function ok(ctx, name, args) {
  const res = call(ctx, name, args);
  assert.equal(res.ok, true, name + ' failed: ' + JSON.stringify(res.error));
  return res.data;
}

function fail(ctx, name, args, code) {
  const res = call(ctx, name, args);
  assert.equal(res.ok, false, name + ' should fail with ' + code);
  assert.equal(res.error.code, code, name + ': ' + res.error.message);
  return res.error;
}

/** Sandbox with 2026-04 and 2026-05 imported (source evolving between the two imports). */
function imported() {
  const sb = loadGas({ sources: [source('2026-04')] });
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_importMonth', { month: '2026-04' });
  sb.env.__addSpreadsheet(source('2026-05'));
  ok(sb.ctx, 'api_importMonth', { month: '2026-05' });
  return sb;
}

function byName(list, key, name) {
  return list.find((r) => r[key] === name);
}

function monthData(ctx, month) {
  return ok(ctx, 'api_getMonthData', { month });
}

// ------------------------------------------------------------------------------------ envelope

test('envelope: argument parsing errors are VALIDATION', () => {
  const { ctx } = loadGas();
  for (const bad of ['{', 'undefined', '[1,2]', '"texte"', '42']) {
    const res = JSON.parse(ctx.api_getMonthData(bad));
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'VALIDATION', bad);
  }
  assert.equal(JSON.parse(ctx.api_getMonthData({ month: '2026-04' })).error.code, 'VALIDATION', 'non-string args');
  // No args at all / 'null' / '{}' are accepted for argument-less functions.
  assert.equal(JSON.parse(ctx.api_bootstrap()).ok, true);
  assert.equal(JSON.parse(ctx.api_bootstrap('null')).ok, true);
  assert.equal(JSON.parse(ctx.api_bootstrap('{}')).ok, true);
});

test('envelope: unexpected errors -> INTERNAL, logged with the stack but never leaked', () => {
  const { ctx, env } = imported();
  ctx.Store.listMonths = function () { throw new TypeError('boom happened\n    at secret (/x/Store.js:1:1)'); };
  const e = fail(ctx, 'api_bootstrap', undefined, 'INTERNAL');
  assert.equal(e.message, 'Erreur interne du serveur : boom happened');
  const logged = env.__state.console.filter((c) => c.level === 'error');
  assert.ok(logged.length >= 1);
  assert.match(String(logged[logged.length - 1].args.join(' ')), /api_bootstrap/);
  // An error with an unknown code is also INTERNAL.
  ctx.Store.listMonths = function () { const err = new Error('x'); err.code = 'WHATEVER'; throw err; };
  fail(ctx, 'api_bootstrap', undefined, 'INTERNAL');
});

test('data spreadsheet that fails to open -> INTERNAL on every endpoint, never repointed to a new file', () => {
  const { ctx, env } = imported();
  const dataId = ctx.Config.get().dataId;
  const creates = env.__state.calls.create;
  ok(ctx, 'api_addAction', { target_type: 'poste', target_name: 'LAB-TEX-01', equipe: 'Labo Textile', action: '- Installer l\'EDR' });
  // New execution, Sheets keeps failing to open the data spreadsheet.
  ctx.Store.resetCache_();
  env.__fault({ method: 'openById', id: dataId, times: Infinity });
  for (const name of ['api_getActions', 'api_bootstrap', 'api_getTimeline']) {
    const e = fail(ctx, name, undefined, 'INTERNAL');
    assert.match(e.message, /Classeur de données inaccessible/);
  }
  fail(ctx, 'api_getMonthData', { month: '2026-04' }, 'INTERNAL');
  assert.equal(ctx.Config.get().dataId, dataId, 'DATA_SPREADSHEET_ID unchanged');
  assert.equal(env.__state.calls.create, creates, 'no new spreadsheet');
  // Once Sheets recovers, everything is still there.
  env.__clearFaults();
  assert.deepEqual(ok(ctx, 'api_bootstrap').months, ['2026-04', '2026-05']);
  assert.equal(ok(ctx, 'api_getActions').actions.find((a) => a.target_name === 'LAB-TEX-01' && /EDR/.test(a.action)).action,
    '- Installer l\'EDR', 'stored without an apostrophe prefix');
});

test('NOT_CONFIGURED before setConfig; BUSY when the lock times out', () => {
  const sb = imported();
  const { ctx, env } = sb;
  const md = monthData(ctx, '2026-04');
  const id = md.postes[0]._id;
  env.__state.lockTimeout = true;
  const writes = [
    ['api_savePostes', { month: '2026-04', changes: [{ id, updates: { Commentaires: 'x' } }] }],
    ['api_saveApplications', { month: '2026-04', changes: [{ id: md.applications[0]._id, updates: { Galink: 'Oui' } }] }],
    ['api_importMonth', { month: '2026-04', overwrite: true }],
    ['api_addGenericPoste', { month: '2026-04' }],
    ['api_addApplication', { month: '2026-04', record: { [KEY_APP]: 'Nouvelle' } }],
    ['api_deleteApplication', { month: '2026-04', id: md.applications[0]._id }],
    ['api_renameApplication', { month: '2026-04', id: md.applications[0]._id, newName: 'Autre' }],
    ['api_addAction', { target_type: 'poste', target_name: 'LAB-TEX-01', equipe: '', action: 'x' }],
    ['api_updateAction', { id: 'a', updates: { comment: 'x' } }],
    ['api_deleteAction', { id: 'a' }],
    ['api_addReplacement', { old_poste: 'A', new_poste: 'B' }],
    ['api_updateReplacement', { id: 'r', updates: { comment: 'x' } }],
    ['api_deleteReplacement', { id: 'r' }],
    ['api_setConfig', { source: SOURCE_ID }],
  ];
  for (const [name, args] of writes) {
    const e = fail(ctx, name, args, 'BUSY');
    assert.match(e.message, /Réessayez/);
  }
  assert.equal(env.__state.lock.timeouts, writes.length);
  // Reads do not need the lock.
  assert.equal(monthData(ctx, '2026-04').postes[0].Commentaires, null);
  ok(ctx, 'api_getTimeline');
  ok(ctx, 'api_getActions');
  ok(ctx, 'api_bootstrap');
  env.__state.lockTimeout = false;
  ok(ctx, 'api_savePostes', writes[0][1]);
  assert.equal(env.__state.lock.acquired, env.__state.lock.released);
});

// ----------------------------------------------------------------------------------- month data

test('getMonthData: shapes, column order, enrichment, sorting', () => {
  const { ctx } = imported();
  const d = monthData(ctx, '2026-04');
  assert.deepEqual(Object.keys(d).sort(), ['applications', 'columns', 'importInfo', 'month', 'postes', 'referentiel']);
  assert.equal(d.month, '2026-04');
  assert.deepEqual(d.columns.postes, data.POSTES_HEADERS);
  assert.deepEqual(d.columns.applications, data.APPS_HEADERS.concat(['Galink', 'IDP']));
  assert.deepEqual(d.referentiel, data.REFERENTIEL);
  assert.deepEqual(d.importInfo.warnings.length, 2);
  assert.match(d.importInfo.imported_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  assert.deepEqual(d.postes.map((r) => r[KEY_POSTE]), data.MONTHS['2026-04'].postes.map((r) => r[KEY_POSTE]));
  assert.deepEqual(d.postes.map((r) => r._order), [0, 1, 2, 3, 4, 5]);
  for (const r of d.postes) {
    assert.match(r._id, /^[0-9a-f-]{36}$/);
    assert.equal(r._key, r[KEY_POSTE]);
    assert.equal(r._updated_at, '');
    for (const h of data.POSTES_HEADERS) assert.ok(Object.prototype.hasOwnProperty.call(r, h), h);
  }
  // Values are the fixture display strings (null for blank).
  const fixtureMec = data.MONTHS['2026-04'].postes[4];
  const mec = byName(d.postes, KEY_POSTE, 'LAB-MEC-01');
  for (const h of data.POSTES_HEADERS) assert.equal(mec[h], fixtureMec[h], h);
  assert.equal(mec._score, 30.4);
  assert.equal(mec._conforme, false);
  assert.equal(byName(d.postes, KEY_POSTE, 'LAB-CHA-02')._conforme, true); // 80% = threshold
  assert.equal(byName(d.postes, KEY_POSTE, 'LAB-TEX-02')._score, 20);

  for (const a of d.applications) {
    assert.ok('Galink' in a && 'IDP' in a);
    assert.deepEqual(Object.keys(a._criteria).sort(), ['champs', 'contrat', 'galink', 'idp', 'sip']);
  }
  const minitab = byName(d.applications, KEY_APP, 'Minitab');
  assert.equal(minitab._score, 60);
  assert.deepEqual(minitab._criteria, { contrat: true, sip: true, idp: false, galink: false, champs: true });
  const dropbox = byName(d.applications, KEY_APP, 'Dropbox perso');
  assert.equal(dropbox._criteria.champs, false, "no 'Installé sur poste'");
  assert.equal(dropbox._score, 0);
});

test('getMonthData: VALIDATION and NOT_FOUND', () => {
  const { ctx } = imported();
  fail(ctx, 'api_getMonthData', { month: '2026-4' }, 'VALIDATION');
  fail(ctx, 'api_getMonthData', {}, 'VALIDATION');
  const e = fail(ctx, 'api_getMonthData', { month: '2025-01' }, 'NOT_FOUND');
  assert.match(e.message, /2025-01/);
});

// ------------------------------------------------------------------------------------- edits

test('savePostes: updates, re-enrichment, persistence; rejects _fields and the key column', () => {
  const { ctx, env } = imported();
  const d = monthData(ctx, '2026-05');
  const mec = byName(d.postes, KEY_POSTE, 'LAB-MEC-01');
  const res = ok(ctx, 'api_savePostes', { month: '2026-05', changes: [
    { id: mec._id, updates: { 'Score conformité': '85%', Statut: 'Conforme', Commentaires: '=HYPERLINK("x")', Deadline: '' } },
  ] });
  assert.equal(res.updated.length, 1);
  const u = res.updated[0];
  assert.equal(u._id, mec._id);
  assert.equal(u._score, 85);
  assert.equal(u._conforme, true);
  assert.equal(u.Statut, 'Conforme');
  assert.equal(u.Deadline, null);
  assert.equal(u.Commentaires, '=HYPERLINK("x")');
  assert.ok(u._updated_at);
  assert.deepEqual(env.__state.formulas, [], 'formula stored as text');

  const again = byName(monthData(ctx, '2026-05').postes, KEY_POSTE, 'LAB-MEC-01');
  assert.equal(again['Score conformité'], '85%');
  assert.equal(again.Commentaires, '=HYPERLINK("x")');
  assert.equal(byName(monthData(ctx, '2026-04').postes, KEY_POSTE, 'LAB-MEC-01')['Score conformité'], '30,4%');

  for (const updates of [{ _score: 100 }, { [KEY_POSTE]: 'X' }, { 'nom du poste ': 'X' }, { Statut: { a: 1 } }]) {
    fail(ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: mec._id, updates }] }, 'VALIDATION');
  }
  fail(ctx, 'api_savePostes', { month: '2026-05', changes: 'x' }, 'VALIDATION');
  fail(ctx, 'api_savePostes', { month: '2026-05', changes: [{ updates: {} }] }, 'VALIDATION');
  fail(ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: 'nope', updates: { Statut: 'x' } }] }, 'NOT_FOUND');
  // NOT_FOUND on an unknown id writes nothing, even for the valid change of the batch.
  fail(ctx, 'api_savePostes', { month: '2026-05', changes: [
    { id: mec._id, updates: { Statut: 'Non conforme' } }, { id: 'nope', updates: {} }] }, 'NOT_FOUND');
  assert.equal(byName(monthData(ctx, '2026-05').postes, KEY_POSTE, 'LAB-MEC-01').Statut, 'Conforme');
  fail(ctx, 'api_savePostes', { month: '2025-01', changes: [{ id: mec._id, updates: { Statut: 'x' } }] }, 'NOT_FOUND');
  assert.deepEqual(ok(ctx, 'api_savePostes', { month: '2026-05', changes: [] }), { updated: [], sourceUpdated: false });
});

test('saveApplications: Galink/IDP edits re-score; validation', () => {
  const { ctx } = imported();
  const apps = monthData(ctx, '2026-04').applications;
  const minitab = byName(apps, KEY_APP, 'Minitab');
  const res = ok(ctx, 'api_saveApplications', { month: '2026-04', changes: [
    { id: minitab._id, updates: { Galink: 'Oui', IDP: 'Oui' } }] });
  assert.equal(res.updated[0]._score, 100);
  assert.equal(res.updated[0]._conforme, true);
  assert.deepEqual(res.updated[0]._criteria, { contrat: true, sip: true, idp: true, galink: true, champs: true });
  fail(ctx, 'api_saveApplications', { month: '2026-04', changes: [{ id: minitab._id, updates: { Galink: 'Peut-être' } }] }, 'VALIDATION');
  fail(ctx, 'api_saveApplications', { month: '2026-04', changes: [{ id: minitab._id, updates: { [KEY_APP]: 'X' } }] }, 'VALIDATION');
  fail(ctx, 'api_saveApplications', { month: '2026-04', changes: [{ id: minitab._id, updates: { _criteria: {} } }] }, 'VALIDATION');
  // Clearing a value is allowed.
  assert.equal(ok(ctx, 'api_saveApplications', { month: '2026-04', changes: [
    { id: minitab._id, updates: { IDP: null } }] }).updated[0].IDP, null);
});

test('addGenericPoste is idempotent', () => {
  const { ctx } = imported();
  const first = ok(ctx, 'api_addGenericPoste', { month: '2026-05' });
  assert.equal(first.created, true);
  assert.equal(first.record[KEY_POSTE], 'Poste générique Decathlon');
  assert.equal(first.record.Commentaires, 'Poste générique regroupant les applications non liées à un poste suivi individuellement.');
  assert.equal(first.record._order, 7);
  assert.equal(first.record._score, null);
  assert.equal(first.record._conforme, false);
  for (const h of data.POSTES_HEADERS) assert.ok(Object.prototype.hasOwnProperty.call(first.record, h), h);
  const second = ok(ctx, 'api_addGenericPoste', { month: '2026-05' });
  assert.equal(second.created, false);
  assert.equal(second.record._id, first.record._id);
  const postes = monthData(ctx, '2026-05').postes;
  assert.equal(postes.filter((p) => p[KEY_POSTE] === 'Poste générique Decathlon').length, 1);
  assert.equal(postes[postes.length - 1][KEY_POSTE], 'Poste générique Decathlon');
  fail(ctx, 'api_addGenericPoste', { month: '2025-01' }, 'NOT_FOUND');
  fail(ctx, 'api_addGenericPoste', { month: 'x' }, 'VALIDATION');
});

test('addApplication: created with every column, duplicates rejected', () => {
  const { ctx } = imported();
  const rec = ok(ctx, 'api_addApplication', { month: '2026-05', record: {
    [KEY_APP]: '  Slack  ', 'Éditeur': 'Salesforce', Type: 'SaaS', 'Équipe': 'R&D Vélo', 'Installé sur poste': 'RD-VEL-01',
    Contrat: 'Oui', SIP: 'Oui', 'Données sensibles exposées': 'Non', 'Niveau de risque': 'Faible', Galink: 'Oui', IDP: 'Non' } });
  assert.equal(rec[KEY_APP], 'Slack');
  assert.equal(rec._key, 'Slack');
  assert.equal(rec._score, 80);
  assert.equal(rec._conforme, true);
  assert.equal(rec.Statut, null);
  for (const h of data.APPS_HEADERS.concat(['Galink', 'IDP'])) assert.ok(Object.prototype.hasOwnProperty.call(rec, h), h);
  const apps = monthData(ctx, '2026-05').applications;
  assert.equal(apps[apps.length - 1]._id, rec._id);

  for (const name of ['slack', ' SLACK ', 'Minitab']) {
    const e = fail(ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: name } }, 'VALIDATION');
    assert.match(e.message, /existe déjà/);
  }
  fail(ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: '   ' } }, 'VALIDATION');
  fail(ctx, 'api_addApplication', { month: '2026-05', record: {} }, 'VALIDATION');
  fail(ctx, 'api_addApplication', { month: '2026-05' }, 'VALIDATION');
  fail(ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'Z', _id: 'x' } }, 'VALIDATION');
  fail(ctx, 'api_addApplication', { month: '2025-01', record: { [KEY_APP]: 'Z' } }, 'NOT_FOUND');
  // Same name in another month is fine.
  ok(ctx, 'api_addApplication', { month: '2026-04', record: { [KEY_APP]: 'Slack' } });
});

test('renameApplication cascades to actions; deleteApplication', () => {
  const { ctx } = imported();
  const dropbox = byName(monthData(ctx, '2026-05').applications, KEY_APP, 'Dropbox perso');
  const a1 = ok(ctx, 'api_addAction', { target_type: 'application', target_name: 'Dropbox perso', equipe: 'R&D Vélo', action: 'Migrer' });
  const a2 = ok(ctx, 'api_addAction', { target_type: 'application', target_name: 'Dropbox perso', equipe: 'R&D Vélo', action: 'Former' });
  const a3 = ok(ctx, 'api_addAction', { target_type: 'poste', target_name: 'Dropbox perso', equipe: '', action: 'Homonyme poste' });
  const a4 = ok(ctx, 'api_addAction', { target_type: 'application', target_name: 'Minitab', equipe: '', action: 'Autre' });

  fail(ctx, 'api_renameApplication', { month: '2026-05', id: dropbox._id, newName: ' ' }, 'VALIDATION');
  fail(ctx, 'api_renameApplication', { month: '2026-05', id: dropbox._id, newName: 'minitab' }, 'VALIDATION');
  fail(ctx, 'api_renameApplication', { month: '2026-05', id: 'nope', newName: 'X' }, 'NOT_FOUND');

  const res = ok(ctx, 'api_renameApplication', { month: '2026-05', id: dropbox._id, newName: 'Google Drive' });
  assert.equal(res.actionsUpdated, 2);
  assert.equal(res.record._id, dropbox._id);
  assert.equal(res.record[KEY_APP], 'Google Drive');
  assert.equal(res.record._key, 'Google Drive');
  assert.ok('_criteria' in res.record);

  const actions = ok(ctx, 'api_getActions').actions;
  const get = (id) => actions.find((a) => a.id === id);
  assert.equal(get(a1.id).target_name, 'Google Drive');
  assert.equal(get(a2.id).target_name, 'Google Drive');
  assert.equal(get(a3.id).target_name, 'Dropbox perso', 'poste actions untouched');
  assert.equal(get(a4.id).target_name, 'Minitab');
  // Other months keep the old name.
  assert.ok(byName(monthData(ctx, '2026-04').applications, KEY_APP, 'Dropbox perso'));
  // Renaming to its own name (case change allowed).
  assert.equal(ok(ctx, 'api_renameApplication', { month: '2026-05', id: dropbox._id, newName: 'GOOGLE DRIVE' }).actionsUpdated, 2);

  assert.deepEqual(ok(ctx, 'api_deleteApplication', { month: '2026-05', id: dropbox._id }), { deleted: true, id: dropbox._id });
  assert.equal(monthData(ctx, '2026-05').applications.length, 4);
  fail(ctx, 'api_deleteApplication', { month: '2026-05', id: dropbox._id }, 'NOT_FOUND');
  fail(ctx, 'api_deleteApplication', { month: '2026-05' }, 'VALIDATION');
});

// ------------------------------------------------------------------------- actions / replacements

test('actions CRUD with defaults and validation', () => {
  const { ctx } = imported();
  const today = ctx.Config.today();
  const todayFr = ctx.Config.todayFr();
  assert.deepEqual(ok(ctx, 'api_getActions'), { actions: [], replacements: [] });

  const a = ok(ctx, 'api_addAction', { target_type: 'poste', target_name: 'LAB-MEC-01', equipe: 'Labo Mécanique',
    action: 'Isoler du réseau', deadline: '31/05/2026', priorite: 'Haute', source_month: '2026-05', id: 'ignored' });
  assert.deepEqual(Object.keys(a), ACTION_KEYS);
  for (const v of Object.values(a)) assert.equal(typeof v, 'string');
  assert.notEqual(a.id, 'ignored');
  assert.ok(a.id);
  assert.equal(a.status, 'À faire');
  assert.equal(a.date_created, todayFr);
  assert.equal(a.recorded_at, today);
  assert.equal(a.updated_at, '');
  assert.equal(a.date_completed, '');
  assert.equal(a.deadline, '31/05/2026');

  const iso = ok(ctx, 'api_addAction', { target_type: 'application', target_name: 'Dropbox perso', equipe: '',
    action: '=cmd', date_created: '2026-04-01', status: 'Terminé', date_completed: '05/04/2026' });
  assert.equal(iso.date_created, '01/04/2026', 'ISO date accepted and converted');
  assert.equal(iso.action, '=cmd');
  assert.equal(iso.status, 'Terminé');

  const invalid = [
    { target_type: 'serveur', target_name: 'X', action: 'Y' },
    { target_type: 'poste', target_name: ' ', action: 'Y' },
    { target_type: 'poste', target_name: 'X', action: '' },
    { target_type: 'poste', target_name: 'X', action: 'Y', status: 'Fini' },
    { target_type: 'poste', target_name: 'X', action: 'Y', priorite: 'Urgente' },
    { target_type: 'poste', target_name: 'X', action: 'Y', deadline: '31-05-2026' },
    { target_type: 'poste', target_name: 'X', action: 'Y', source_month: '2026-5' },
    { target_type: 'poste', target_name: { x: 1 }, action: 'Y' },
  ];
  for (const args of invalid) fail(ctx, 'api_addAction', args, 'VALIDATION');

  const u = ok(ctx, 'api_updateAction', { id: a.id, updates: { status: 'Terminé', date_completed: '01/06/2026', comment: 'OK' } });
  assert.equal(u.status, 'Terminé');
  assert.equal(u.comment, 'OK');
  assert.equal(u.updated_at, today);
  assert.equal(u.recorded_at, today);
  assert.equal(u.target_name, 'LAB-MEC-01');
  fail(ctx, 'api_updateAction', { id: a.id, updates: { id: 'x' } }, 'VALIDATION');
  fail(ctx, 'api_updateAction', { id: a.id, updates: { recorded_at: '2020-01-01' } }, 'VALIDATION');
  fail(ctx, 'api_updateAction', { id: a.id, updates: { inconnu: 'x' } }, 'VALIDATION');
  fail(ctx, 'api_updateAction', { id: a.id, updates: { action: '' } }, 'VALIDATION');
  fail(ctx, 'api_updateAction', { id: a.id, updates: { status: 'Fini' } }, 'VALIDATION');
  fail(ctx, 'api_updateAction', { id: a.id }, 'VALIDATION');
  fail(ctx, 'api_updateAction', { id: 'nope', updates: { comment: 'x' } }, 'NOT_FOUND');

  const list = ok(ctx, 'api_getActions').actions;
  assert.equal(list.length, 2);
  assert.deepEqual(list.find((x) => x.id === a.id), u);
  assert.equal(list.find((x) => x.id === iso.id).action, '=cmd');

  assert.deepEqual(ok(ctx, 'api_deleteAction', { id: a.id }), { deleted: true, id: a.id });
  fail(ctx, 'api_deleteAction', { id: a.id }, 'NOT_FOUND');
  fail(ctx, 'api_deleteAction', {}, 'VALIDATION');
  assert.equal(ok(ctx, 'api_getActions').actions.length, 1);
});

test('replacements CRUD', () => {
  const { ctx } = imported();
  const r = ok(ctx, 'api_addReplacement', { old_poste: 'LAB-TEX-02', new_poste: 'LAB-TEX-03', equipe: 'Labo Textile',
    responsable: 'Hugo Bernard', comment: 'Fin de support Windows 7' });
  assert.deepEqual(Object.keys(r), REPLACEMENT_KEYS);
  assert.equal(r.date_replacement, ctx.Config.todayFr());
  assert.equal(r.recorded_at, ctx.Config.today());
  fail(ctx, 'api_addReplacement', { old_poste: '', new_poste: 'B' }, 'VALIDATION');
  fail(ctx, 'api_addReplacement', { old_poste: 'A' }, 'VALIDATION');
  fail(ctx, 'api_addReplacement', { old_poste: 'A', new_poste: 'B', date_replacement: 'hier' }, 'VALIDATION');

  const u = ok(ctx, 'api_updateReplacement', { id: r.id, updates: { date_replacement: '05/04/2026', comment: 'ok' } });
  assert.equal(u.date_replacement, '05/04/2026');
  assert.equal(u.comment, 'ok');
  assert.equal(u.old_poste, 'LAB-TEX-02');
  fail(ctx, 'api_updateReplacement', { id: 'nope', updates: { comment: 'x' } }, 'NOT_FOUND');
  fail(ctx, 'api_updateReplacement', { id: r.id, updates: { id: 'x' } }, 'VALIDATION');
  fail(ctx, 'api_updateReplacement', { id: r.id, updates: { new_poste: '' } }, 'VALIDATION');
  assert.deepEqual(ok(ctx, 'api_getActions').replacements, [u]);
  assert.deepEqual(ok(ctx, 'api_deleteReplacement', { id: r.id }), { deleted: true, id: r.id });
  fail(ctx, 'api_deleteReplacement', { id: r.id }, 'NOT_FOUND');
  assert.deepEqual(ok(ctx, 'api_getActions').replacements, []);
});

// ------------------------------------------------------------------------------ timeline / diff

test('getTimeline: slim records per month, usable by Core', () => {
  const { ctx } = imported();
  const tl = ok(ctx, 'api_getTimeline');
  assert.deepEqual(tl.map((t) => t.month), ['2026-04', '2026-05']);
  const posteKeys = ['Équipe', 'Bâtiment / Labo', 'EDR Decathlon', 'IT Decathlon', 'Réseau Decathlon', 'Niveau de risque',
    '_score', '_conforme'];
  const appKeys = ['Équipe', 'SIP', 'Contrat', 'Galink', 'IDP', 'Niveau de risque', '_score', '_conforme'];
  for (const t of tl) {
    for (const p of t.postes) assert.deepEqual(Object.keys(p), posteKeys);
    for (const a of t.applications) assert.deepEqual(Object.keys(a), appKeys);
  }
  assert.equal(tl[0].postes.length, 6);
  assert.equal(tl[1].postes.length, 7);
  assert.equal(tl[0].postes[4]._score, 30.4);
  assert.equal(tl[1].postes[3]._score, 40);

  // The slim records are enough for the client-side KPIs: same results as on full records.
  const full = monthData(ctx, '2026-04');
  const kSlim = ctx.Core.computeKpis(tl[0].postes, tl[0].applications);
  const kFull = ctx.Core.computeKpis(full.postes, full.applications);
  assert.deepEqual(JSON.parse(JSON.stringify(kSlim)), JSON.parse(JSON.stringify(kFull)));
  const f = ctx.Core.filterData({ postes: tl[0].postes, applications: tl[0].applications },
    { equipes: ['Labo Textile'], batiments: [] });
  assert.equal(f.postes.length, 2);
  assert.equal(f.applications.length, 2);
});

test('getDiff 2026-04 -> 2026-05', () => {
  const { ctx } = imported();
  const d = ok(ctx, 'api_getDiff', { oldMonth: '2026-04', newMonth: '2026-05' });
  assert.equal(d.oldMonth, '2026-04');
  assert.equal(d.newMonth, '2026-05');
  const names = (list, key) => list.map((r) => r[key]);
  assert.deepEqual(names(d.postes.removed, KEY_POSTE), ['LAB-TEX-02']);
  assert.deepEqual(names(d.postes.added, KEY_POSTE), [data.XSS_POSTE_NAME, 'LAB-TEX-03']);
  assert.deepEqual(d.postes.changes, [
    { name: 'LAB-CHA-01', equipe: 'Labo Chaussure', diffs: {
      'Score conformité': { old: '60%', new: '80%' },
      'EDR Decathlon': { old: 'Non', new: 'Oui' },
      'Action corrective': { old: "Installer l'EDR", new: '' },
      Statut: { old: 'En cours', new: 'Conforme' },
      'Niveau de risque': { old: 'Moyen', new: 'Faible' },
    } },
    { name: 'LAB-MEC-01', equipe: 'Labo Mécanique', diffs: { 'Score conformité': { old: '30,4%', new: '40%' } } },
  ]);
  assert.deepEqual(d.postes.resolved_actions, [
    { name: 'LAB-CHA-01', equipe: 'Labo Chaussure', action: "Installer l'EDR", responsable: 'Léa Dubois' }]);
  // Records in the diff are enriched.
  assert.equal(d.postes.removed[0]._score, 20);
  assert.equal(d.postes.removed[0]._conforme, false);
  assert.equal(d.postes.added[1]._score, 100);

  assert.deepEqual(names(d.applications.removed, KEY_APP), ['Datacolor Tools']);
  assert.deepEqual(names(d.applications.added, KEY_APP), ['Figma']);
  assert.deepEqual(d.applications.resolved_actions, [
    { name: 'Dropbox perso', equipe: 'R&D Vélo', action: 'Migrer vers Google Drive', responsable: 'Inès Moreau' }]);
  assert.ok('_criteria' in d.applications.added[0]);
  assert.ok('Galink' in d.applications.added[0]);
  assert.equal(d.applications.changes, undefined);

  // Reverse direction.
  const r = ok(ctx, 'api_getDiff', { oldMonth: '2026-05', newMonth: '2026-04' });
  assert.deepEqual(names(r.postes.removed, KEY_POSTE), [data.XSS_POSTE_NAME, 'LAB-TEX-03']);

  fail(ctx, 'api_getDiff', { oldMonth: '2026-04' }, 'VALIDATION');
  fail(ctx, 'api_getDiff', { oldMonth: '2026-04', newMonth: '2026-13' }, 'VALIDATION');
  fail(ctx, 'api_getDiff', { oldMonth: '2026-04', newMonth: '2026-06' }, 'NOT_FOUND');
});

test('getImportLog is newest first; bootstrap after imports', () => {
  const { ctx } = imported();
  assert.deepEqual(ok(ctx, 'api_getImportLog').map((l) => l.month), ['2026-05', '2026-04']);
  const b = ok(ctx, 'api_bootstrap');
  assert.deepEqual(b.months, ['2026-04', '2026-05']);
  assert.equal(b.latestMonth, '2026-05');
  assert.equal(b.configured, true);
});

test('a new execution (cold caches) reads the same data', () => {
  const { ctx } = imported();
  const before = monthData(ctx, '2026-05');
  ctx.Store.resetCache_();
  assert.deepEqual(monthData(ctx, '2026-05'), before);
});
