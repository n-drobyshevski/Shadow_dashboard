'use strict';
/**
 * Integration tests for Config + Store + Code running inside the GAS sandbox (all src/*.js loaded
 * alphabetically into a vm context backed by the in-memory fakes).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { loadGas, plain, sheetValues, timingLines, SRC_DIR } = require('../helpers/gasSandbox');
const { createGasEnv } = require('../helpers/gasFakes');
const data = require('../fixtures/data');

const TAB_NAMES = ['Postes', 'Applications', 'Referentiel', 'Actions', 'Replacements', 'ImportLog', 'Meta'];

/** Fresh sandbox with the data spreadsheet already created. */
function boot(opts) {
  const sb = loadGas(opts);
  const ss = sb.ctx.Store.ensure();
  return Object.assign(sb, { Store: sb.ctx.Store, Config: sb.ctx.Config, ss, dataId: ss.getId() });
}

function tabValues(sb, tab) {
  return sheetValues(sb.env, sb.dataId, tab);
}

/** Every setValues issued since `from` targeted cells formatted '@'. */
function assertAllWritesPlainText(env, from) {
  const writes = env.__state.writes.slice(from || 0);
  const bad = writes.filter((w) => !w.plainText);
  assert.deepEqual(bad, [], 'setValues on cells without the plain-text format');
}

function postes(month) { return data.MONTHS[month].postes.map((r) => Object.assign({}, r)); }
function apps(month) { return data.MONTHS[month].applications.map((r) => Object.assign({}, r)); }
const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';

// ------------------------------------------------------------------------------- sandbox / fakes

test('sandbox loads every src/*.js alphabetically and exposes globals', () => {
  const { ctx, files } = loadGas();
  assert.deepEqual(files, files.slice().sort());
  for (const name of ['Core', 'Config', 'Store']) assert.equal(typeof ctx[name], 'object', name);
  for (const fn of ['doGet', 'include', 'coreScript', 'setup', 'CoreFactory_']) assert.equal(typeof ctx[fn], 'function', fn);
});

test('fakes: Sheets typing rules (apostrophe, formulas, auto-conversion unless "@")', () => {
  const env = createGasEnv();
  const ss = env.SpreadsheetApp.create('t');
  const sh = ss.getSheets()[0];
  sh.getRange(1, 1, 1, 6).setValues([['2026-05', '15/03/2025', '0042', "'0042", '=1+1', 'texte']]);
  const row = sh.getRange(1, 1, 1, 6).getValues()[0];
  assert.ok(row[0] instanceof Date);
  assert.ok(row[1] instanceof Date);
  assert.equal(row[2], 42);
  assert.equal(row[3], '0042');
  assert.equal(row[4], '=1+1');
  assert.equal(row[5], 'texte');
  assert.equal(env.__state.formulas.length, 1);
  sh.getRange(2, 1, 1, 3).setNumberFormat('@').setValues([['2026-05', '15/03/2025', '0042']]);
  assert.deepEqual(sh.getRange(2, 1, 1, 3).getValues()[0], ['2026-05', '15/03/2025', '0042']);
  assert.equal(sh.getRange('A2').getNumberFormat(), '@');
  assert.throws(() => sh.getRange(1, 1, 2, 2).setValues([[1, 2]]), /number of rows in the data does not match/);
  assert.throws(() => sh.getRange(1, 1, 1, 2).setValues([[1]]), /number of columns in the data does not match/);
  assert.throws(() => sh.getRange(1001, 1), /outside the dimensions/);
  assert.throws(() => env.SpreadsheetApp.openById('nope'), /not found/);
  // '@' cells store strings verbatim: no formula, and a leading apostrophe is KEPT (real Sheets).
  sh.getRange(3, 1, 1, 4).setNumberFormat('@').setValues([["'-x", '=1+1', "''a", '@b']]);
  assert.deepEqual(sh.getRange(3, 1, 1, 4).getValues()[0], ["'-x", '=1+1', "''a", '@b']);
  assert.equal(env.__state.formulas.length, 1, 'no formula recorded for a plain-text cell');
  // fault injection: the next matching call throws, then the service recovers
  env.__fault({ method: 'openById', id: ss.getId(), times: 2 });
  assert.throws(() => env.SpreadsheetApp.openById(ss.getId()), /Service Spreadsheets failed/);
  assert.throws(() => env.SpreadsheetApp.openById(ss.getId()), /Service Spreadsheets failed/);
  assert.equal(env.SpreadsheetApp.openById(ss.getId()), ss);
  env.__fault({ method: 'setValues', sheet: 'other' });
  sh.getRange(4, 1).setValues([['ok']]);
  assert.equal(env.__state.faults.length, 1, 'fault on another sheet not consumed');
  env.__clearFaults();
  assert.equal(env.Utilities.formatDate(new Date(Date.UTC(2026, 0, 31, 23, 30)), 'Europe/Paris', 'yyyy-MM-dd HH:mm'), '2026-02-01 00:30');
});

// ------------------------------------------------------------------------------------- Config

test('Config: properties and date helpers', () => {
  const { ctx } = loadGas({ props: { SOURCE_SPREADSHEET_ID: 'src-id' } });
  const noAccess = { users: [], groups: [], domainRole: 'none' };
  assert.deepEqual(plain(ctx.Config.get()), { dataId: '', sourceId: 'src-id', sourceTitle: '', threshold: 80,
    schemaVersion: '', access: noAccess });
  ctx.Config.setDataId('data-id');
  ctx.Config.setSourceId('other', 'Classeur source');
  ctx.Config.setThreshold(75);
  assert.deepEqual(plain(ctx.Config.get()), { dataId: 'data-id', sourceId: 'other', sourceTitle: 'Classeur source',
    threshold: 75, schemaVersion: '', access: noAccess });
  // The sync refreshes the stored title of the configured source only, and writes only when it changed.
  assert.equal(ctx.Config.rememberSourceTitle('src-id', 'Ancienne'), false, 'not the configured source');
  assert.equal(ctx.Config.rememberSourceTitle('other', 'Classeur source'), false, 'unchanged');
  assert.equal(ctx.Config.rememberSourceTitle('other', 'Renommé'), true);
  assert.equal(ctx.Config.get().sourceTitle, 'Renommé');
  assert.equal(ctx.Config.spreadsheetUrl('1AbC_dEf-123'), 'https://docs.google.com/spreadsheets/d/1AbC_dEf-123/edit');
  ctx.Config.setAccess({ users: [{ email: 'a@decathlon.com', role: 'lecteur' }], domainRole: 'lecteur' });
  assert.deepEqual(plain(ctx.Config.get().access), { users: [{ email: 'a@decathlon.com', role: 'lecteur',
    added_at: '', added_by: '' }], groups: [], domainRole: 'lecteur' });
  // Corrupted properties never lock anybody out with an error: defaults instead (read by a new
  // execution: Config.get memoizes the properties for the current one).
  ctx.PropertiesService.getScriptProperties().setProperty('ACCESS_JSON_0', '{oops');
  ctx.PropertiesService.getScriptProperties().setProperty('COMPLIANCE_THRESHOLD', '250');
  assert.equal(ctx.Config.get().threshold, 75, 'memoized within the execution');
  ctx.Config.clearMemo_();
  assert.deepEqual(plain(ctx.Config.get().access), noAccess);
  assert.equal(ctx.Config.get().threshold, 80);
  assert.match(ctx.Config.today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(ctx.Config.todayFr(), /^\d{2}\/\d{2}\/\d{4}$/);
  assert.match(ctx.Config.nowStamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(ctx.Config.uuid(), /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(ctx.Config.SCHEMAS), TAB_NAMES);
  assert.deepEqual(plain(Object.values(ctx.Config.TABS)), TAB_NAMES);
});

// ------------------------------------------------------------------------------------- ensure

test('Store.ensure creates the data spreadsheet once, with every tab, header and frozen row', () => {
  const sb = loadGas();
  const ss1 = sb.ctx.Store.ensure();
  const id = ss1.getId();
  assert.equal(sb.env.PropertiesService.getScriptProperties().getProperty('DATA_SPREADSHEET_ID'), id);
  assert.equal(ss1.getName(), 'ShadowIT_AppData');
  assert.deepEqual(ss1.getSheets().map((s) => s.getName()), TAB_NAMES);
  for (const tab of TAB_NAMES) {
    const sh = ss1.getSheetByName(tab);
    assert.deepEqual(sh.getRange(1, 1, 1, sb.ctx.Config.SCHEMAS[tab].length).getValues()[0], plain(sb.ctx.Config.SCHEMAS[tab]), tab);
    assert.equal(sh.getFrozenRows(), 1, tab);
  }
  assert.deepEqual(tabValues(Object.assign(sb, { dataId: id }), 'Meta'), [['key', 'value'], ['schema_version', '2']]);
  assertAllWritesPlainText(sb.env);

  // cached within the execution: no extra Sheets calls
  const calls = sb.env.__state.calls.openById || 0;
  assert.equal(sb.ctx.Store.ensure(), ss1);
  assert.equal(sb.env.__state.calls.openById || 0, calls);

  // a new execution re-opens the same spreadsheet and writes nothing
  const writes = sb.env.__state.writes.length;
  sb.ctx.Store.resetCache_();
  const ss2 = sb.ctx.Store.ensure();
  assert.equal(ss2.getId(), id);
  assert.equal(sb.env.__state.writes.length, writes);
  assert.equal(sb.env.__state.spreadsheets.size, 1);
  assert.deepEqual(ss2.getSheets().map((s) => s.getName()), TAB_NAMES);
  for (const tab of TAB_NAMES) assert.equal(ss2.getSheetByName(tab).getLastRow(), tab === 'Meta' ? 2 : 1, tab);
  assert.equal(sb.ctx.Store.dataUrl(), 'https://docs.google.com/spreadsheets/d/' + id + '/edit');
});

test('Store.ensure repairs a missing tab / header under the lock; the fast path takes no lock', () => {
  const sb = boot();
  const lock = sb.env.__state.lock;
  sb.Store.resetCache_();
  const a0 = lock.acquired;
  sb.Store.ensure();
  assert.equal(lock.acquired, a0, 'healthy spreadsheet: no lock, no write');

  sb.ss.deleteSheet(sb.ss.getSheetByName('Replacements'));
  sb.ss.getSheetByName('Actions').getRange(1, 1, 1, 2).setValues([['x', 'y']]);
  sb.Store.resetCache_();
  sb.Store.ensure();
  assert.equal(lock.acquired, a0 + 1, 'repair ran under the script lock');
  assert.equal(lock.held, false);
  assert.ok(sb.ss.getSheetByName('Replacements'));
  assert.deepEqual(tabValues(sb, 'Actions')[0], plain(sb.Config.SCHEMAS.Actions));
  assert.deepEqual(tabValues(sb, 'Meta'), [['key', 'value'], ['schema_version', '2']]);
});

test('Store.ensure never replaces a configured data spreadsheet that fails to open', () => {
  const stale = loadGas({ props: { DATA_SPREADSHEET_ID: 'deleted-spreadsheet-id' } });
  assert.throws(() => stale.ctx.Store.ensure(),
    (e) => e.code === 'INTERNAL' && /Classeur de données inaccessible/.test(e.message));
  assert.equal(stale.ctx.Config.get().dataId, 'deleted-spreadsheet-id', 'property untouched');
  assert.equal(stale.env.__state.calls.create || 0, 0, 'no new spreadsheet');
  assert.equal(stale.env.__state.calls.openById, 3, 'retried');
  assert.deepEqual(stale.env.__state.sleeps, [500, 1500], 'with backoff');
  assert.ok(stale.env.__state.console.some((c) => c.level === 'error' && /deleted-spreadsheet-id/.test(String(c.args[0]))));
  // Explicit recovery: the admin deletes the property, the next execution creates a new file.
  stale.env.PropertiesService.getScriptProperties().deleteProperty('DATA_SPREADSHEET_ID');
  stale.ctx.Store.resetCache_();
  const ss = stale.ctx.Store.ensure();
  assert.equal(stale.ctx.Config.get().dataId, ss.getId());
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), TAB_NAMES);
});

test('Store.ensure retries a transient openById failure and keeps the same spreadsheet', () => {
  const sb = boot();
  sb.Store.insertRow('Actions', { id: 'keep-me' });
  sb.Store.resetCache_();
  sb.env.__fault({ method: 'openById', id: sb.dataId, times: 2 });
  assert.equal(sb.Store.ensure().getId(), sb.dataId);
  assert.equal(sb.Config.get().dataId, sb.dataId);
  assert.equal(sb.env.__state.calls.create, 1, 'only the initial creation');
  assert.deepEqual(sb.env.__state.sleeps, [500, 1500]);
  assert.equal(sb.Store.listRows('Actions')[0].id, 'keep-me');
});

test('Store.ensure: first-run creation is under the lock and re-reads the id there', () => {
  const sb = loadGas();
  const other = sb.env.SpreadsheetApp.create('ShadowIT_AppData');
  const lockObj = sb.env.LockService.getScriptLock();
  const wait = lockObj.waitLock;
  // Another execution creates the data spreadsheet while this one waits for the lock.
  lockObj.waitLock = function (ms) {
    sb.env.PropertiesService.getScriptProperties().setProperty('DATA_SPREADSHEET_ID', other.getId());
    return wait.call(this, ms);
  };
  try {
    assert.equal(sb.ctx.Store.ensure(), other);
  } finally {
    lockObj.waitLock = wait;
  }
  assert.equal(sb.env.__state.calls.create, 1, 'no second spreadsheet');
  assert.equal(sb.ctx.Config.get().dataId, other.getId());
  for (const tab of TAB_NAMES) assert.ok(other.getSheetByName(tab), 'layout created in the existing file: ' + tab);
  assert.equal(sb.env.__state.lock.held, false);

  const busy = loadGas({ lockTimeout: true });
  assert.throws(() => busy.ctx.Store.ensure(), { code: 'BUSY' });
  assert.equal(busy.env.__state.calls.create || 0, 0, 'nothing created without the lock');
});

// ----------------------------------------------------------------------------- entity months

test('replaceEntityMonth stores a month snapshot and keeps the other months', () => {
  const sb = boot();
  const april = sb.Store.replaceEntityMonth('Postes', '2026-04', postes('2026-04'), KEY_POSTE);
  assert.equal(april.length, 6);
  assert.deepEqual(april.map((r) => r._order), [0, 1, 2, 3, 4, 5]);
  assert.ok(april.every((r) => /^[0-9a-f-]{36}$/.test(r._id)));
  assert.equal(april[1]._key, 'LAB-TEX-02');
  sb.Store.replaceEntityMonth('Postes', '2026-05', postes('2026-05'), KEY_POSTE);

  // re-import April with fewer rows: May must be untouched
  const before = sb.Store.readEntityMonth('Postes', '2026-05');
  sb.Store.replaceEntityMonth('Postes', '2026-04', postes('2026-04').slice(0, 2), KEY_POSTE);
  assert.equal(sb.Store.readEntityMonth('Postes', '2026-04').length, 2);
  assert.deepEqual(plain(sb.Store.readEntityMonth('Postes', '2026-05')), plain(before));
  assert.equal(tabValues(sb, 'Postes').length, 1 + 2 + 7, 'leftover rows cleared');

  // record round trip (source columns, null preserved, _json without meta / enrichment)
  const may = sb.Store.readEntityMonth('Postes', '2026-05');
  const expected = postes('2026-05');
  assert.equal(may.length, expected.length);
  may.forEach((rec, i) => {
    const copy = plain(rec);
    for (const k of ['_id', '_key', '_order', '_updated_at']) delete copy[k];
    assert.deepEqual(copy, expected[i]);
    assert.equal(rec._key, expected[i][KEY_POSTE]);
  });
  const rows = tabValues(sb, 'Postes').slice(1);
  assert.ok(rows.every((r) => !/"_/.test(r[4])), '_json has no _-prefixed field');
  assert.deepEqual(rows.map((r) => r[0]), ['2026-04', '2026-04', '2026-05', '2026-05', '2026-05', '2026-05', '2026-05', '2026-05', '2026-05']);

  // enrichment is stripped, existing _id kept
  const enriched = may.map((r) => Object.assign({}, r, { _score: 50, _conforme: false, _criteria: { a: 1 } }));
  const stored = sb.Store.replaceEntityMonth('Postes', '2026-05', enriched, KEY_POSTE);
  assert.deepEqual(stored.map((r) => r._id), may.map((r) => r._id));
  assert.ok(!('_score' in sb.Store.readEntityMonth('Postes', '2026-05')[0]));

  const all = sb.Store.readEntityAll('Postes');
  assert.deepEqual(Object.keys(all).sort(), ['2026-04', '2026-05']);
  assert.equal(all['2026-05'].length, 7);
  assertAllWritesPlainText(sb.env);
});

test('replaceEntityMonth does one read and one write per tab', () => {
  const sb = boot();
  sb.Store.replaceEntityMonth('Applications', '2026-04', apps('2026-04'), KEY_APP);
  const c0 = Object.assign({}, sb.env.__state.calls);
  const w0 = sb.env.__state.writes.length;
  sb.Store.replaceEntityMonth('Applications', '2026-05', apps('2026-05'), KEY_APP);
  assert.equal(sb.env.__state.calls.getValues - c0.getValues, 1);
  assert.equal(sb.env.__state.writes.length - w0, 1);
  // reading a month = column A (one narrow getValues, shared with listMonths) + one getValues of
  // that month's rows and the row on each side of them (April's last row, the blank row below)
  const c1 = sb.env.__state.calls.getValues;
  const k1 = sb.env.__state.cells.getValues;
  sb.Store.readEntityMonth('Applications', '2026-05');
  assert.equal(sb.env.__state.calls.getValues - c1, 2);
  const rows = data.MONTHS['2026-04'].applications.length + data.MONTHS['2026-05'].applications.length;
  assert.equal(sb.env.__state.cells.getValues - k1, rows + (data.MONTHS['2026-05'].applications.length + 2) * 6);
  sb.Store.clearMemo_();
  sb.Store.listMonths();
  const c2 = sb.env.__state.calls.getValues;
  sb.Store.readEntityMonth('Applications', '2026-05');
  assert.equal(sb.env.__state.calls.getValues - c2, 1, 'column A already read by listMonths');
});

test('updateEntityRows / appendEntityRow / deleteEntityRow / NOT_FOUND', () => {
  const sb = boot();
  sb.Store.replaceEntityMonth('Applications', '2026-04', apps('2026-04'), KEY_APP);
  const stored = sb.Store.replaceEntityMonth('Applications', '2026-05', apps('2026-05'), KEY_APP);
  const minitab = stored[0];

  // update: one write, only the changed row
  const w0 = sb.env.__state.writes.length;
  const updated = sb.Store.updateEntityRows('Applications', '2026-05', [
    { id: minitab._id, updates: { Galink: 'Oui', IDP: '', _score: 99 } },
  ]);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].Galink, 'Oui');
  assert.equal(updated[0].IDP, null, 'blank -> null');
  assert.ok(!('_score' in updated[0]));
  assert.match(updated[0]._updated_at, /^\d{4}-\d{2}-\d{2}T/);
  const writes = sb.env.__state.writes.slice(w0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rows, 1);

  // renaming through the key column keeps _key in sync
  const renamed = sb.Store.updateEntityRows('Applications', '2026-05', [{ id: minitab._id, updates: { [KEY_APP]: 'Minitab 22' } }]);
  assert.equal(renamed[0]._key, 'Minitab 22');

  // unknown id: NOT_FOUND and nothing written
  const w1 = sb.env.__state.writes.length;
  assert.throws(() => sb.Store.updateEntityRows('Applications', '2026-05', [
    { id: stored[1]._id, updates: { Galink: 'Non' } }, { id: 'missing', updates: { Galink: 'Non' } },
  ]), (e) => e.code === 'NOT_FOUND');
  assert.equal(sb.env.__state.writes.length, w1);
  assert.equal(sb.Store.readEntityMonth('Applications', '2026-05')[1].Galink, undefined);
  // id of another month is unknown in this month
  const aprilId = sb.Store.readEntityMonth('Applications', '2026-04')[0]._id;
  assert.throws(() => sb.Store.updateEntityRows('Applications', '2026-05', [{ id: aprilId, updates: {} }]), { code: 'NOT_FOUND' });

  // append: new id, _order = max + 1
  const added = sb.Store.appendEntityRow('Applications', '2026-05', { [KEY_APP]: 'Slack', _id: 'forced', 'Équipe': 'R&D Vélo' }, KEY_APP);
  assert.notEqual(added._id, 'forced');
  assert.equal(added._order, 5);
  assert.equal(added._key, 'Slack');
  let may = sb.Store.readEntityMonth('Applications', '2026-05');
  assert.equal(may.length, 6);
  assert.equal(may[5][KEY_APP], 'Slack');

  // delete
  assert.equal(sb.Store.deleteEntityRow('Applications', '2026-05', may[2]._id), true);
  assert.equal(sb.Store.deleteEntityRow('Applications', '2026-05', 'missing'), false);
  assert.equal(sb.Store.deleteEntityRow('Applications', '2026-04', may[0]._id), false, 'wrong month');
  may = sb.Store.readEntityMonth('Applications', '2026-05');
  assert.equal(may.length, 5);
  assert.ok(!may.some((r) => r[KEY_APP] === 'Dropbox perso'));
  assert.equal(sb.Store.readEntityMonth('Applications', '2026-04').length, 5);
  assertAllWritesPlainText(sb.env);
});

const getValuesCalls = (sb) => sb.env.__state.calls.getValues || 0;
const getValuesCells = (sb) => sb.env.__state.cells.getValues || 0;

test('month span: rows appended out of order stay in their month, other months are not read', () => {
  const sb = boot();
  const aprilApps = apps('2026-04');
  const mayApps = apps('2026-05');
  sb.Store.replaceEntityMonth('Applications', '2026-04', aprilApps, KEY_APP);
  sb.Store.replaceEntityMonth('Applications', '2026-05', mayApps, KEY_APP);
  // An April record appended after May, then a May record after it: May's block holds an April row.
  const lateApril = sb.Store.appendEntityRow('Applications', '2026-04', { [KEY_APP]: 'Tard avril' }, KEY_APP);
  const lateMay = sb.Store.appendEntityRow('Applications', '2026-05', { [KEY_APP]: 'Tard mai' }, KEY_APP);
  const months = () => tabValues(sb, 'Applications').slice(1).map((r) => r[0]);
  assert.deepEqual(months(), [...aprilApps.map(() => '2026-04'), ...mayApps.map(() => '2026-05'), '2026-04', '2026-05']);
  const total = aprilApps.length + mayApps.length + 2;

  // A new call: column A, then May's block only (first May row .. last May row, and one row on each side).
  sb.Store.clearMemo_();
  const c0 = getValuesCells(sb);
  const may = sb.Store.readEntityMonth('Applications', '2026-05');
  assert.deepEqual(plain(may.map((r) => r[KEY_APP])), mayApps.map((r) => r[KEY_APP]).concat(['Tard mai']));
  assert.equal(getValuesCells(sb) - c0, total + (mayApps.length + 2 + 2) * 6, 'column A + the May block, not April');
  const april = sb.Store.readEntityMonth('Applications', '2026-04');
  assert.deepEqual(plain(april.map((r) => r[KEY_APP])), aprilApps.map((r) => r[KEY_APP]).concat(['Tard avril']));
  assert.equal(april[april.length - 1]._order, aprilApps.length);

  // Writes through the block: only the May row changes, the April row inside it is not a May record.
  const w0 = sb.env.__state.writes.length;
  sb.Store.updateEntityRows('Applications', '2026-05', [{ id: lateMay._id, updates: { Galink: 'Oui' } }]);
  assert.deepEqual(sb.env.__state.writes.slice(w0).map((w) => w.a1), ['A' + (total + 1) + ':F' + (total + 1)]);
  assert.throws(() => sb.Store.updateEntityRows('Applications', '2026-05', [{ id: lateApril._id, updates: {} }]), { code: 'NOT_FOUND' });
  assert.equal(sb.Store.deleteEntityRow('Applications', '2026-05', lateApril._id), false);
  assert.equal(sb.Store.readEntityMonth('Applications', '2026-05').pop().Galink, 'Oui');
  assert.equal(sb.Store.deleteEntityRow('Applications', '2026-05', lateMay._id), true);
  assert.deepEqual(months(), [...aprilApps.map(() => '2026-04'), ...mayApps.map(() => '2026-05'), '2026-04']);
  assert.equal(sb.Store.readEntityMonth('Applications', '2026-04').length, aprilApps.length + 1);

  // A re-import of April makes its rows contiguous again.
  sb.Store.replaceEntityMonth('Applications', '2026-04', sb.Store.readEntityMonth('Applications', '2026-04'), KEY_APP);
  assert.deepEqual(months(), [...aprilApps.map(() => '2026-04'), '2026-04', ...mayApps.map(() => '2026-05')]);
  assert.deepEqual(plain(sb.Store.readEntityMonth('Applications', '2026-05').map((r) => r[KEY_APP])), mayApps.map((r) => r[KEY_APP]));

  // Référentiel: same block read.
  sb.Store.replaceReferentiel('2026-04', data.REFERENTIEL);
  sb.Store.replaceReferentiel('2026-05', { OS: ['Windows', 'Linux'] });
  sb.Store.clearMemo_();
  const r0 = getValuesCalls(sb);
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-05')), { OS: ['Windows', 'Linux'] });
  assert.equal(getValuesCalls(sb) - r0, 2, 'column A + the month block');
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-04')), data.REFERENTIEL);
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-03')), {});
  assertAllWritesPlainText(sb.env);
});

test('month span: rows moved by another execution after column A was read -> whole tab read instead', () => {
  const sb = boot();
  sb.Store.replaceEntityMonth('Applications', '2026-04', apps('2026-04'), KEY_APP);
  sb.Store.replaceEntityMonth('Applications', '2026-05', apps('2026-05'), KEY_APP);
  sb.Store.clearMemo_();
  sb.Store.listMonths(); // column A memoized (a read-only call, outside the lock)
  // Another execution re-imports April with two more records: May moves two rows down.
  const other = loadGas({ env: sb.env });
  other.ctx.Store.replaceEntityMonth('Applications', '2026-04',
    apps('2026-04').concat([{ [KEY_APP]: 'Nouveau 1' }, { [KEY_APP]: 'Nouveau 2' }]), KEY_APP);
  const l0 = timingLines(sb.env).length;
  const may = sb.Store.readEntityMonth('Applications', '2026-05');
  assert.deepEqual(plain(may.map((r) => r[KEY_APP])), apps('2026-05').map((r) => r[KEY_APP]));
  assert.deepEqual(timingLines(sb.env).slice(l0).map((l) => [l.stage, l.tab]),
    [['span', 'Applications'], ['sheet', 'Applications']]);
  assert.equal(sb.Store.readEntityMonth('Applications', '2026-04').length, apps('2026-04').length + 2);
});

/** Applications with April and May; column A memoized (a read-only call, outside the lock). */
function spanRace(opts) {
  const sb = boot();
  sb.Store.replaceEntityMonth('Applications', '2026-04', apps('2026-04'), KEY_APP);
  sb.Store.replaceEntityMonth('Applications', '2026-05', apps('2026-05'), KEY_APP);
  const sheet = sb.ss.getSheetByName('Applications');
  if (opts && opts.exact) sheet.deleteRows(sheet.getLastRow() + 1, sheet.getMaxRows() - sheet.getLastRow()); // no blank rows
  sb.Store.clearMemo_();
  sb.Store.listMonths();
  return { sb, sheet, other: loadGas({ env: sb.env }).ctx.Store };
}
const spanLines = (sb, l0) => timingLines(sb.env).slice(l0).filter((l) => l.stage === 'span' || l.stage === 'sheet')
  .map((l) => [l.stage, l.tab]);

test('month span: the last month grown by another execution after column A was read -> whole tab read', () => {
  const { sb, other } = spanRace();
  // The sync rewrites May with one more record, in source order: the last record moves one row down.
  const grown = apps('2026-05');
  grown.splice(1, 0, { [KEY_APP]: 'Nouveau' });
  other.replaceEntityMonth('Applications', '2026-05', grown, KEY_APP);
  const l0 = timingLines(sb.env).length;
  const may = sb.Store.readEntityMonth('Applications', '2026-05');
  assert.deepEqual(plain(may.map((r) => r[KEY_APP])), grown.map((r) => r[KEY_APP]), 'no record left out');
  assert.deepEqual(spanLines(sb, l0), [['span', 'Applications'], ['sheet', 'Applications']]);
});

test('month span: a month moved up past the start of its block -> whole tab read', () => {
  const { sb, other } = spanRace();
  // April loses a record and May gains one: May's rows still fill the old block, its first record is above it.
  other.replaceEntityMonth('Applications', '2026-04', apps('2026-04').slice(1), KEY_APP);
  const grown = apps('2026-05').concat([{ [KEY_APP]: 'Nouveau' }]);
  other.replaceEntityMonth('Applications', '2026-05', grown, KEY_APP);
  const l0 = timingLines(sb.env).length;
  const may = sb.Store.readEntityMonth('Applications', '2026-05');
  assert.deepEqual(plain(may.map((r) => r[KEY_APP])), grown.map((r) => r[KEY_APP]));
  assert.deepEqual(spanLines(sb, l0), [['span', 'Applications'], ['sheet', 'Applications']]);
});

test('month span: a sheet without blank rows that lost one meanwhile -> whole tab read, no range error', () => {
  const { sb, sheet, other } = spanRace({ exact: true });
  assert.equal(sheet.getMaxRows(), sheet.getLastRow());
  // Unchanged: the block ends on the last row of the sheet, nothing to read below it.
  const l0 = timingLines(sb.env).length;
  assert.equal(sb.Store.readEntityMonth('Applications', '2026-05').length, apps('2026-05').length);
  assert.deepEqual(spanLines(sb, l0), [['span', 'Applications']]);
  // Another execution deletes a May record (deleteRow: the sheet loses its last row).
  sb.Store.clearMemo_();
  sb.Store.listMonths();
  const victim = other.readEntityMonth('Applications', '2026-05')[0];
  assert.equal(other.deleteEntityRow('Applications', '2026-05', victim._id), true);
  const l1 = timingLines(sb.env).length;
  const may = sb.Store.readEntityMonth('Applications', '2026-05');
  assert.deepEqual(plain(may.map((r) => r[KEY_APP])), apps('2026-05').slice(1).map((r) => r[KEY_APP]));
  assert.deepEqual(spanLines(sb, l1), [['sheet', 'Applications']]);
});

test('ImportLog: the last row deleted by hand after column A was read -> whole tab read, no range error', () => {
  const sb = boot();
  const entry = (month, k) => ({ month, imported_at: '2026-05-01 0' + k + ':00', source_id: 'SRC',
    counts: { postes: k, applications: 1, referentiel: 1 }, postes_headers: [], apps_headers: [], warnings: [] });
  sb.Store.appendImportLog(entry('2026-05', 1));
  sb.Store.appendImportLog(entry('2026-04', 2));
  sb.Store.appendImportLog(entry('2026-05', 3));
  const sheet = sb.ss.getSheetByName('ImportLog');
  sheet.deleteRows(sheet.getLastRow() + 1, sheet.getMaxRows() - sheet.getLastRow());
  sb.Store.clearMemo_();
  sb.Store.listMonths(); // column A memoized
  sheet.deleteRow(sheet.getLastRow()); // the latest 2026-05 entry
  assert.equal(sb.Store.latestImportInfo('2026-05').counts.postes, 1);
});

test('ImportLog: latestImportInfo parses one row (tail, then column A); recentImportLog reads from the bottom', () => {
  const sb = boot();
  const entry = (month, k) => ({ month, imported_at: '2026-05-01 ' + String(k % 24).padStart(2, '0') + ':00', source_id: 'SRC',
    counts: { postes: k, applications: 1, referentiel: 1 }, postes_headers: ['A'], apps_headers: ['B'], warnings: [] });
  sb.Store.appendImportLog(entry('2026-01', 100));
  sb.Store.appendImportLog(entry('2026-03', 101));
  for (let k = 0; k < 40; k++) sb.Store.appendImportLog(entry(k % 2 ? '2026-04' : '2026-05', k));
  const width = 8;

  // The latest entry of the month is in the tail: one read of the last 30 rows.
  sb.Store.clearMemo_();
  let c0 = getValuesCalls(sb);
  let k0 = getValuesCells(sb);
  assert.equal(sb.Store.latestImportInfo('2026-05').counts.postes, 38);
  assert.deepEqual([getValuesCalls(sb) - c0, getValuesCells(sb) - k0], [1, 30 * width]);

  // Only before the tail: the tail, column A from the bottom, then that one row.
  sb.Store.clearMemo_();
  c0 = getValuesCalls(sb);
  k0 = getValuesCells(sb);
  assert.deepEqual(plain(sb.Store.latestImportInfo('2026-03')), Object.assign(entry('2026-03', 101), { changes: null }));
  assert.deepEqual([getValuesCalls(sb) - c0, getValuesCells(sb) - k0], [3, 30 * width + 42 + width]);

  // Column A already read in the call (listMonths): that row only; an unknown month reads nothing more.
  sb.Store.clearMemo_();
  sb.Store.listMonths();
  c0 = getValuesCalls(sb);
  k0 = getValuesCells(sb);
  assert.equal(sb.Store.latestImportInfo('2026-03').counts.postes, 101);
  assert.equal(sb.Store.latestImportInfo('2026-02'), null);
  assert.deepEqual([getValuesCalls(sb) - c0, getValuesCells(sb) - k0], [1, width]);

  // A row deleted by hand after column A was read: the row no longer matches, the whole tab is read.
  sb.Store.clearMemo_();
  sb.Store.listMonths();
  sb.ss.getSheetByName('ImportLog').deleteRow(2); // the 2026-01 entry
  assert.equal(sb.Store.latestImportInfo('2026-03').counts.postes, 101);

  // recentImportLog: newest first, blank rows skipped (reading further up).
  sb.Store.clearMemo_();
  assert.deepEqual(plain(sb.Store.recentImportLog(3).map((e) => e.counts.postes)), [39, 38, 37]);
  const sh = sb.ss.getSheetByName('ImportLog');
  sh.getRange(sh.getLastRow() - 2, 1, 2, width).clearContent(); // entries 37 and 38
  sb.Store.clearMemo_();
  assert.deepEqual(plain(sb.Store.recentImportLog(4).map((e) => e.counts.postes)), [39, 36, 35, 34]);
  assert.equal(sb.Store.recentImportLog(500).length, 41 - 2);
  assert.deepEqual(plain(sb.Store.recentImportLog(0)), []);

  // Empty log.
  const empty = boot();
  assert.equal(empty.Store.latestImportInfo('2026-05'), null);
  assert.deepEqual(plain(empty.Store.recentImportLog(12)), []);
});

test('read memo: shared within an execution, dropped by every write and when the lock is taken', () => {
  const sb = boot();
  sb.Store.insertRow('Actions', { id: 'a1', action: 'x' });
  sb.Store.clearMemo_();
  let c0 = getValuesCalls(sb);
  sb.Store.listRows('Actions');
  sb.Store.listRows('Actions');
  assert.equal(getValuesCalls(sb) - c0, 1, 'read once per execution');
  // Callers get copies: changing them does not change the memo.
  sb.Store.listRows('Actions')[0].action = 'changed';
  assert.equal(sb.Store.listRows('Actions')[0].action, 'x');

  // Every write primitive drops the memo of its tab.
  sb.Store.insertRow('Actions', { id: 'a2' });
  assert.deepEqual(plain(sb.Store.listRows('Actions').map((a) => a.id)), ['a1', 'a2']);
  sb.Store.updateRow('Actions', 'a1', { action: 'y' });
  assert.equal(sb.Store.listRows('Actions')[0].action, 'y');
  sb.Store.updateRowsWhere('Actions', () => true, () => ({ comment: 'c' }));
  assert.ok(sb.Store.listRows('Actions').every((a) => a.comment === 'c'));
  sb.Store.deleteRow('Actions', 'a2');
  assert.deepEqual(plain(sb.Store.listRows('Actions').map((a) => a.id)), ['a1']);
  sb.Store.writeTab('Actions', [{ id: 'w1' }, { id: 'w2' }]);
  sb.Store.writeTab('Actions', [{ id: 'w1' }]); // shrinks: clearContent
  assert.deepEqual(plain(sb.Store.listRows('Actions').map((a) => a.id)), ['w1']);

  sb.Store.replaceEntityMonth('Postes', '2026-05', postes('2026-05'), KEY_POSTE);
  const first = sb.Store.readEntityMonth('Postes', '2026-05')[0];
  assert.equal(sb.Store.listMonths().indexOf('2026-05') >= 0, true);
  sb.Store.updateEntityRows('Postes', '2026-05', [{ id: first._id, updates: { Statut: 'Revu' } }]);
  assert.equal(sb.Store.readEntityMonth('Postes', '2026-05')[0].Statut, 'Revu');
  const added = sb.Store.appendEntityRow('Postes', '2026-06', { [KEY_POSTE]: 'PC-NEW' }, KEY_POSTE);
  assert.ok(sb.Store.listMonths().includes('2026-06'), 'column A re-read after the append');
  assert.equal(sb.Store.readEntityMonth('Postes', '2026-06')[0]._id, added._id);
  sb.Store.deleteEntityRow('Postes', '2026-06', added._id);
  assert.deepEqual(plain(sb.Store.readEntityMonth('Postes', '2026-06')), []);
  sb.Store.appendImportLog({ month: '2026-07', source_id: 'S' });
  assert.ok(sb.Store.listMonths().includes('2026-07'));
  assert.equal(sb.Store.latestImportInfo('2026-07').source_id, 'S');

  // Another execution writes: this one keeps its memo outside the lock, reads again under it.
  const other = loadGas({ env: sb.env });
  other.ctx.Store.insertRow('Actions', { id: 'o1' });
  assert.equal(sb.Store.listRows('Actions').length, 1, 'memoized outside the lock');
  assert.equal(sb.Store.withLock(() => sb.Store.listRows('Actions').length), 2, 'fresh under the lock');

  // Config: one getProperties per execution, dropped by its setters, by the lock and by fresh.
  const props = sb.env.PropertiesService.getScriptProperties();
  sb.Config.clearMemo_();
  const p0 = sb.env.__state.calls.getProperties || 0;
  sb.Config.get();
  sb.Config.get();
  sb.Config.getPrefs('a@decathlon.com');
  assert.equal((sb.env.__state.calls.getProperties || 0) - p0, 1);
  sb.Config.setThreshold(55);
  assert.equal(sb.Config.get().threshold, 55);
  props.setProperty('COMPLIANCE_THRESHOLD', '60'); // another execution
  assert.equal(sb.Config.get().threshold, 55, 'memoized');
  assert.equal(sb.Config.get({ fresh: true }).threshold, 60);
  props.setProperty('COMPLIANCE_THRESHOLD', '65');
  assert.equal(sb.Store.withLock(() => sb.Config.get().threshold), 65, 'fresh under the lock');

  // Every api_* call starts with empty memos (a new execution in Apps Script).
  other.ctx.Store.insertRow('Actions', { id: 'o2' });
  assert.deepEqual(JSON.parse(sb.ctx.api_getActions('null')).data.actions.map((a) => a.id), ['w1', 'o1', 'o2']);
});

test('Store.ensure: the schema version property replaces the Meta read; any doubt reads Meta', () => {
  const sb = boot();
  const props = sb.env.PropertiesService.getScriptProperties();
  const stored = () => JSON.parse(props.getProperty('DATA_SCHEMA_VERSION'));
  assert.deepEqual(stored(), { dataId: sb.dataId, version: '2' }, 'written with Meta on creation');

  /** ensure() in a new execution: [getDataRange reads, getValues reads, lock acquisitions]. */
  function coldEnsure() {
    sb.Store.resetCache_();
    const c = Object.assign({}, sb.env.__state.calls);
    const l = sb.env.__state.lock.acquired;
    sb.Store.ensure();
    const d = (k) => (sb.env.__state.calls[k] || 0) - (c[k] || 0);
    return [d('getDataRange'), d('getValues'), sb.env.__state.lock.acquired - l];
  }
  assert.deepEqual(coldEnsure(), [0, 0, 0], 'no Meta read, no lock');

  // Missing, unreadable or about another spreadsheet (DATA_SPREADSHEET_ID changed): Meta is read once
  // and the property written again.
  for (const value of [null, '{oops', JSON.stringify({ dataId: 'another-file', version: '2' })]) {
    if (value === null) props.deleteProperty('DATA_SCHEMA_VERSION');
    else props.setProperty('DATA_SCHEMA_VERSION', value);
    assert.deepEqual(coldEnsure(), [1, 1, 0], String(value));
    assert.deepEqual(stored(), { dataId: sb.dataId, version: '2' });
    assert.deepEqual(coldEnsure(), [0, 0, 0]);
  }

  // A schema upgrade (property and Meta at an older version): repaired under the lock, both updated.
  props.setProperty('DATA_SCHEMA_VERSION', JSON.stringify({ dataId: sb.dataId, version: '1' }));
  sb.ss.getSheetByName('Meta').getRange(2, 2).setNumberFormat('@').setValues([['1']]);
  assert.deepEqual(coldEnsure().slice(2), [1]);
  assert.deepEqual(tabValues(sb, 'Meta'), [['key', 'value'], ['schema_version', '2']]);
  assert.deepEqual(stored(), { dataId: sb.dataId, version: '2' });

  // Property current but a tab deleted by hand: the tabs are always checked, so it is repaired.
  sb.ss.deleteSheet(sb.ss.getSheetByName('Replacements'));
  assert.deepEqual(coldEnsure().slice(2), [1]);
  assert.ok(sb.ss.getSheetByName('Replacements'));
});

test('Store grows the sheet beyond its default 1000 rows', () => {
  const sb = boot();
  const many = Array.from({ length: 1205 }, (_, i) => ({ [KEY_POSTE]: 'P-' + String(i).padStart(4, '0') }));
  sb.Store.replaceEntityMonth('Postes', '2026-05', many, KEY_POSTE);
  const back = sb.Store.readEntityMonth('Postes', '2026-05');
  assert.equal(back.length, 1205);
  assert.equal(back[1204][KEY_POSTE], 'P-1204');
});

test('months listing: ImportLog ∪ Postes ∪ Applications, ascending', () => {
  const sb = boot();
  assert.deepEqual(plain(sb.Store.listMonths()), []);
  sb.Store.replaceEntityMonth('Postes', '2026-05', postes('2026-05'), KEY_POSTE);
  sb.Store.replaceEntityMonth('Applications', '2026-03', apps('2026-04'), KEY_APP);
  sb.Store.appendImportLog({ month: '2026-04', source_id: 's', counts: {}, postes_headers: [], apps_headers: [], warnings: [] });
  assert.deepEqual(plain(sb.Store.listMonths()), ['2026-03', '2026-04', '2026-05']);
  assert.equal(sb.Store.hasMonth('2026-05'), true);
  assert.equal(sb.Store.hasMonth('2026-06'), false);
  assert.equal(sb.Store.hasMonth('bad'), false);
  assert.throws(() => sb.Store.replaceEntityMonth('Postes', '2026-13', [], KEY_POSTE), { code: 'VALIDATION' });
});

// ------------------------------------------------------------------------ référentiel / log

test('référentiel round trip per month', () => {
  const sb = boot();
  sb.Store.replaceReferentiel('2026-04', data.REFERENTIEL);
  sb.Store.replaceReferentiel('2026-05', { 'Statut': ['Conforme', 'Non conforme'], 'OS': ['Windows'] });
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-04')), data.REFERENTIEL);
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-05')), { 'Statut': ['Conforme', 'Non conforme'], 'OS': ['Windows'] });
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-06')), {});
  sb.Store.replaceReferentiel('2026-04', {});
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-04')), {});
  assert.equal(Object.keys(sb.Store.readReferentiel('2026-05')).length, 2);
});

test('import log round trip and latestImportInfo', () => {
  const sb = boot();
  const e1 = { month: '2026-04', imported_at: '2026-04-02 09:15', source_id: 'SRC', counts: { postes: 6, applications: 5, referentiel: 8 },
    postes_headers: data.POSTES_HEADERS, apps_headers: data.APPS_HEADERS, warnings: ['2 ligne(s) sans « Nom du poste » ignorée(s)'] };
  const e2 = Object.assign({}, e1, { month: '2026-05', imported_at: '2026-05-03 10:00', warnings: [] });
  const e3 = Object.assign({}, e1, { imported_at: '2026-05-04 11:00', counts: { postes: 7, applications: 5, referentiel: 8 } });
  [e1, e2, e3].forEach((e) => sb.Store.appendImportLog(e));
  const noChanges = (e) => Object.assign({}, e, { changes: null });
  assert.deepEqual(plain(sb.Store.getImportLog()), [e1, e2, e3].map(noChanges));
  assert.deepEqual(plain(sb.Store.latestImportInfo('2026-04')), noChanges(e3));
  // changes round trip (hourly sync)
  const changes = { created: false, postes: { added: 1, removed: 0, changed: 2, values: 3 }, applications: null, referentiel: false };
  sb.Store.appendImportLog(Object.assign({}, e1, { month: '2026-07', changes }));
  assert.deepEqual(plain(sb.Store.latestImportInfo('2026-07').changes), changes);
  assert.equal(sb.Store.latestImportInfo('2026-01'), null);
  // imported_at defaults to now
  sb.Store.appendImportLog({ month: '2026-06', source_id: 'SRC' });
  const last = sb.Store.latestImportInfo('2026-06');
  assert.match(last.imported_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(plain(last.warnings), []);
  assertAllWritesPlainText(sb.env);
});

// ---------------------------------------------------------------------------- Actions / rows

test('Actions CRUD and updateRowsWhere', () => {
  const sb = boot();
  for (const a of data.ACTIONS) sb.Store.insertRow('Actions', a);
  assert.deepEqual(plain(sb.Store.listRows('Actions')), data.ACTIONS);

  const inserted = sb.Store.insertRow('Actions', { target_type: 'poste', target_name: 'X', action: 'Faire', extra: 'ignored' });
  assert.match(inserted.id, /^[0-9a-f-]{36}$/);
  assert.equal(inserted.comment, '');
  assert.ok(!('extra' in inserted));
  assert.equal(sb.Store.listRows('Actions').length, 4);

  const up = sb.Store.updateRow('Actions', 'a-0002', { status: 'Terminé', date_completed: '01/06/2026', id: 'hacked', bogus: 1 });
  assert.equal(up.id, 'a-0002');
  assert.equal(up.status, 'Terminé');
  assert.ok(!('bogus' in up));
  assert.deepEqual(plain(sb.Store.listRows('Actions').find((a) => a.id === 'a-0002')), plain(up));
  assert.throws(() => sb.Store.updateRow('Actions', 'nope', { status: 'x' }), { code: 'NOT_FOUND' });

  // one read + one write (in a new call: listRows above memoized the tab)
  sb.Store.clearMemo_();
  const r0 = sb.env.__state.calls.getValues;
  const w0 = sb.env.__state.writes.length;
  const n = sb.Store.updateRowsWhere('Actions', (a) => a.target_type === 'poste',
    (a) => ({ comment: a.comment + ' [revu]' }));
  assert.equal(n, 3);
  assert.equal(sb.env.__state.calls.getValues - r0, 1);
  assert.equal(sb.env.__state.writes.length - w0, 1);
  const m = sb.Store.updateRowsWhere('Actions', (a) => a.target_name === 'Dropbox perso', (a) => { a.target_name = 'Dropbox'; });
  assert.equal(m, 1);
  assert.equal(sb.Store.updateRowsWhere('Actions', () => false, () => ({})), 0);
  const rows = sb.Store.listRows('Actions');
  assert.equal(rows.find((a) => a.id === 'a-0001').comment, 'Remplacé par LAB-TEX-03 [revu]');
  assert.equal(rows.find((a) => a.id === 'a-0003').target_name, 'Dropbox');
  assert.equal(rows.find((a) => a.id === 'a-0003').comment, '');

  assert.equal(sb.Store.deleteRow('Actions', 'a-0001'), true);
  assert.equal(sb.Store.deleteRow('Actions', 'a-0001'), false);
  assert.deepEqual(plain(sb.Store.listRows('Actions').map((a) => a.id)), ['a-0002', 'a-0003', inserted.id]);

  for (const r of data.REPLACEMENTS) sb.Store.insertRow('Replacements', r);
  assert.deepEqual(plain(sb.Store.listRows('Replacements')), data.REPLACEMENTS);
  // writeTab rewrites everything (and shrinks)
  sb.Store.writeTab('Replacements', []);
  assert.deepEqual(plain(sb.Store.listRows('Replacements')), []);
  assertAllWritesPlainText(sb.env);
});

test('deleting the only data row of a minimal sheet works', () => {
  const sb = boot();
  const sh = sb.ss.getSheetByName('Actions');
  sh.deleteRows(3, sh.getMaxRows() - 2); // leave header + 1 row
  sb.Store.insertRow('Actions', { id: 'only' });
  assert.equal(sb.Store.deleteRow('Actions', 'only'), true);
  assert.deepEqual(plain(sb.Store.listRows('Actions')), []);
});

// ------------------------------------------------------------------- text format / formulas

test('plain-text format: date-like and numeric strings survive', () => {
  const sb = boot();
  const tricky = { id: 'a-x', target_type: 'poste', target_name: '0042', equipe: 'TRUE', action: '30%',
    date_created: '15/03/2025', deadline: '2026-05-31', source_month: '2026-05', comment: '1e3',
    recorded_at: '2026-05-01', updated_at: '-12' };
  sb.Store.insertRow('Actions', tricky);
  const back = sb.Store.listRows('Actions')[0];
  for (const [k, v] of Object.entries(tricky)) assert.equal(back[k], v, k);
  // raw cells are strings, cells are '@'
  const raw = tabValues(sb, 'Actions')[1];
  assert.ok(raw.every((v) => typeof v === 'string'));
  assert.equal(sb.ss.getSheetByName('Actions').getRange(2, 1).getNumberFormat(), '@');

  sb.Store.replaceEntityMonth('Postes', '2026-05', [{ [KEY_POSTE]: '0042', 'Date visite': '15/03/2025' }], KEY_POSTE);
  const rec = sb.Store.readEntityMonth('Postes', '2026-05')[0];
  assert.equal(rec._key, '0042');
  assert.equal(rec['Date visite'], '15/03/2025');
  assert.equal(rec._order, 0);
  const pr = tabValues(sb, 'Postes')[1];
  assert.equal(pr[0], '2026-05');
  assert.equal(pr[2], '0042');
  assert.equal(pr[3], '0');
  assert.deepEqual(plain(sb.Store.listMonths()), ['2026-05']);
  assertAllWritesPlainText(sb.env);
});

test('formula escaping: strings are stored literally, no formula ever written', () => {
  const sb = boot();
  const nasty = ['=HYPERLINK("http://evil","clic")', '+33 6 12 34 56 78', '-cmd', '@SUM(A1)', "'apostrophe", '=1+1'];
  const w0 = sb.env.__state.writes.length;
  sb.Store.insertRow('Actions', { id: 'f1', target_type: 'poste', target_name: nasty[0], equipe: nasty[1],
    action: nasty[2], responsable: nasty[3], comment: nasty[4], priorite: nasty[5] });
  const back = sb.Store.listRows('Actions')[0];
  assert.deepEqual([back.target_name, back.equipe, back.action, back.responsable, back.comment, back.priorite], nasty);

  sb.Store.replaceEntityMonth('Applications', '2026-05', [{ [KEY_APP]: nasty[0], 'Éditeur': nasty[3] }], KEY_APP);
  const rec = sb.Store.readEntityMonth('Applications', '2026-05')[0];
  assert.equal(rec[KEY_APP], nasty[0]);
  assert.equal(rec._key, nasty[0]);
  sb.Store.replaceReferentiel('2026-05', { '=cat': ['=val', '+1'] });
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-05')), { '=cat': ['=val', '+1'] });
  sb.Store.updateRowsWhere('Actions', () => true, () => ({ comment: '=IMPORTXML("x")' }));
  assert.equal(sb.Store.listRows('Actions')[0].comment, '=IMPORTXML("x")');

  assert.deepEqual(sb.env.__state.formulas, []);
  assertAllWritesPlainText(sb.env, w0);
});

test('values starting with - + @ = or an apostrophe round-trip exactly (no apostrophe added)', () => {
  const sb = boot();
  const values = ['- Installer l\'EDR', '-', '+ de 50', '@jdupont', '=1+1', "'a", "''b", "'-x", '+33 6 12'];
  sb.Store.insertRow('Actions', { id: 'r1', target_type: 'application', target_name: '@Work', action: values[0],
    responsable: values[3], comment: values[7] });
  const raw = tabValues(sb, 'Actions')[1];
  assert.equal(raw[2], '@Work', 'stored cell has no apostrophe prefix');
  assert.equal(raw[4], values[0]);
  const back = sb.Store.listRows('Actions')[0];
  assert.deepEqual([back.target_name, back.action, back.responsable, back.comment], ['@Work', values[0], values[3], values[7]]);

  // A rewrite (updateRowsWhere matching on target_name) does not accumulate apostrophes.
  assert.equal(sb.Store.updateRowsWhere('Actions', (a) => a.target_name === '@Work', () => ({ target_name: '-Work' })), 1);
  assert.equal(sb.Store.updateRowsWhere('Actions', (a) => a.target_name === '-Work', () => ({ status: 'x' })), 1);

  sb.Store.replaceReferentiel('2026-05', { Statut: values });
  assert.deepEqual(plain(sb.Store.readReferentiel('2026-05')), { Statut: values });
  sb.Store.replaceEntityMonth('Applications', '2026-05', [{ [KEY_APP]: '@Work' }, { [KEY_APP]: '-' }], KEY_APP);
  assert.deepEqual(plain(sb.Store.readEntityMonth('Applications', '2026-05').map((r) => [r[KEY_APP], r._key])),
    [['@Work', '@Work'], ['-', '-']]);
  assert.deepEqual(sb.env.__state.formulas, []);
});

// ------------------------------------------------------------------------------------- lock

test('withLock returns the result, flushes and releases', () => {
  const sb = boot();
  const lock = sb.env.__state.lock;
  const a0 = lock.acquired; // boot created the data spreadsheet under the lock
  assert.equal(lock.released, a0);
  const f0 = sb.env.__state.flushes;
  assert.equal(sb.Store.withLock(() => 42), 42);
  assert.equal(lock.acquired, a0 + 1);
  assert.equal(lock.released, a0 + 1);
  assert.equal(lock.lastTimeout, 20000);
  assert.equal(sb.env.__state.flushes, f0 + 1);
  // re-entrant: nested call does not release the outer lock
  sb.Store.withLock(() => sb.Store.withLock(() => assert.equal(lock.held, true)));
  assert.equal(lock.acquired, a0 + 2);
  assert.equal(lock.released, a0 + 2);
});

test('withLock releases the lock when fn throws', () => {
  const sb = boot();
  const a0 = sb.env.__state.lock.acquired;
  assert.throws(() => sb.Store.withLock(() => {
    sb.Store.insertRow('Actions', { id: 'w' });
    throw new Error('boom');
  }), /boom/);
  assert.equal(sb.env.__state.lock.acquired, a0 + 1);
  assert.equal(sb.env.__state.lock.released, a0 + 1);
  assert.equal(sb.env.__state.lock.held, false);
  assert.ok(sb.env.__state.flushes >= 1);
  assert.throws(() => sb.Store.withLock(() => sb.Store.updateRow('Actions', 'nope', {})), { code: 'NOT_FOUND' });
  assert.equal(sb.env.__state.lock.held, false);
});

test('withLock maps a lock timeout to BUSY without running fn', () => {
  const sb = boot();
  sb.env.__state.lockTimeout = true;
  const r0 = sb.env.__state.lock.released;
  let ran = false;
  assert.throws(() => sb.Store.withLock(() => { ran = true; }), (e) => e.code === 'BUSY' && /opération est en cours/.test(e.message));
  assert.equal(ran, false);
  assert.equal(sb.env.__state.lock.released, r0);
  sb.env.__state.lockTimeout = false;
  assert.equal(sb.Store.withLock(() => 'ok'), 'ok');
});

// ------------------------------------------------------------------------------------- Code

test('coreScript is script-safe and evaluates to a working Core', () => {
  const { ctx } = loadGas();
  const src = ctx.coreScript();
  assert.ok(!/<\/script/i.test(src));
  assert.ok(src.startsWith('var Core = ('));
  const browser = vm.createContext({});
  vm.runInContext(src, browser);
  assert.equal(browser.Core.normKey('  Équipe '), 'équipe');
  assert.equal(browser.Core.escapeFormula('=x'), "'=x");
});

test('coreScript neutralises a closing script tag inside CoreFactory_', () => {
  const { ctx } = loadGas();
  vm.runInContext("CoreFactory_ = function () { return { tag: '</script>', re: /<\\/SCRIPT>/i.source }; };", ctx);
  const src = ctx.coreScript();
  assert.ok(!/<\/script/i.test(src));
  const browser = vm.createContext({});
  vm.runInContext(src, browser);
  assert.equal(browser.Core.tag, '</script>');
});

test('doGet renders the index template with title and viewport (temp templates)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-src-'));
  for (const f of fs.readdirSync(SRC_DIR).filter((n) => n.endsWith('.js'))) fs.copyFileSync(path.join(SRC_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><?!= include(\'css\') ?></head><body><script><?!= coreScript() ?></script></body></html>');
  fs.writeFileSync(path.join(dir, 'css.html'), '<style>body{margin:0}</style>');
  try {
    const { ctx } = loadGas({ srcDir: dir });
    const out = ctx.doGet({});
    assert.equal(out.getTitle(), 'Shadow IT — Tableau de bord');
    assert.deepEqual(plain(out._metaTags), [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }]);
    const html = out.getContent();
    assert.ok(html.includes('<style>body{margin:0}</style>'));
    assert.ok(html.includes('var Core = ('));
    assert.equal(ctx.include('css'), '<style>body{margin:0}</style>');
    assert.throws(() => ctx.include('missing'), /No HTML file named missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doGet renders the real src/index.html', { skip: !fs.existsSync(path.join(SRC_DIR, 'index.html')) && 'src/index.html not written yet' }, () => {
  const { ctx } = loadGas();
  let out;
  try {
    out = ctx.doGet({});
  } catch (e) {
    if (/No HTML file named/.test(e.message)) return; // partials of other units still missing
    throw e;
  }
  assert.equal(out.getTitle(), 'Shadow IT — Tableau de bord');
  const html = out.getContent();
  assert.ok(!html.includes('<?'), 'all scriptlets evaluated');
  assert.ok(html.includes('var Core = ('));
});

test('doGet sets the embedded ghost favicon; FAVICON_URL overrides it, « - » removes it', () => {
  const { ctx } = loadGas();
  const props = ctx.PropertiesService.getScriptProperties();
  const render = () => { try { return ctx.doGet({}); } catch (e) { if (/No HTML file named/.test(e.message)) return null; throw e; } };
  let out = render();
  if (!out) return;
  assert.equal(out._faviconUrl, ctx.Config.DEFAULT_FAVICON_URL);
  // Embedded, nothing hosted: the exact bytes of assets/favicon.png.
  const png = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'favicon.png')).toString('base64');
  assert.equal(out._faviconUrl, 'data:image/png;base64,' + png);
  props.setProperty('FAVICON_URL', 'https://example.org/brand/ghost.png');
  assert.equal(render()._faviconUrl, 'https://example.org/brand/ghost.png');
  props.setProperty('FAVICON_URL', 'javascript:alert(1)');
  assert.equal(render()._faviconUrl, ctx.Config.DEFAULT_FAVICON_URL, 'non-https values are ignored');
  props.setProperty('FAVICON_URL', '-');
  assert.equal(render()._faviconUrl, null);
});

test('assets/favicon.png is a 64×64 PNG', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'favicon.png'));
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(buf.readUInt32BE(16), 64);
  assert.equal(buf.readUInt32BE(20), 64);
});

test('setup creates the data spreadsheet and logs its URL', () => {
  const { ctx, env } = loadGas();
  const url = ctx.setup();
  assert.match(url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+\/edit$/);
  assert.ok(env.__state.logs.some((l) => l.includes(url)));
  assert.equal(env.__state.scopeChecks, 1); // asks again for any scope left unchecked on the consent screen
});

test('fakes: fixture source spreadsheet keeps raw values, display values and trims the data range', () => {
  const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');
  const env = createGasEnv({ sources: [buildSourceSpreadsheet('2026-05')] });
  const ss = env.SpreadsheetApp.openById(SOURCE_ID);
  assert.equal(ss.getSpreadsheetTimeZone(), 'Europe/Paris');
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), ['Suivi des postes', 'Suivi des applications', 'Référentiel', 'Dashboard']);
  const range = ss.getSheetByName('Suivi des postes').getDataRange();
  // banner + header + 7 postes + blank row + ghost score row (trailing blank row excluded)
  assert.equal(range.getNumRows(), 11);
  const values = range.getValues();
  const display = range.getDisplayValues();
  const scoreCol = data.POSTES_HEADERS.indexOf('Score conformité');
  assert.equal(values[2][scoreCol], 1);
  assert.equal(display[2][scoreCol], '100%');
  assert.ok(values[2][1] instanceof Date);
  assert.equal(display[2][1], '12/03/2026');
  assert.equal(display[10][scoreCol], '0%');
});
