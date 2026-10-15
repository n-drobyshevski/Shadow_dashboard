'use strict';
/**
 * Integration tests: hourly synchronisation of the current month (src/Sync.js) and write-back of the
 * current month's edits into the source spreadsheet (Importer.writeEdits / appendRecord / deleteRecord),
 * through the api_* envelope in the GAS sandbox.
 *
 * "Today" is pinned with ctx.Config.today so that the current month is a fixture month.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas, plain } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const POSTES_TAB = 'Suivi des postes';
const APPS_TAB = 'Suivi des applications';

function call(ctx, name, args) {
  const res = JSON.parse(ctx[name](args === undefined ? 'null' : JSON.stringify(args)));
  if (!res.ok) assert.doesNotMatch(res.error.message, /\n\s+at /, 'stack leaked by ' + name);
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

/** Fixture source with Date cells at noon UTC (same calendar day in Paris whatever the host TZ). */
function source(month) {
  const def = buildSourceSpreadsheet(month);
  for (const tab of Object.values(def.sheets)) {
    tab.values = tab.values.map((row) => row.map((v) => (v instanceof Date
      ? new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 12)) : v)));
  }
  return def;
}

/** Sandbox on the 2026-05 source, today = 15/05/2026, source saved (trigger created). */
function live(opts) {
  const sb = loadGas(Object.assign({ sources: [source('2026-05')] }, opts || {}));
  sb.ctx.Config.today = () => '2026-05-15';
  sb.setConfig = ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  return sb;
}

/** Live sandbox whose current month has had its first sync. */
function synced(opts) {
  const sb = live(opts);
  ok(sb.ctx, 'api_syncNow');
  return sb;
}

function sourceSheet(env, tab) {
  return env.SpreadsheetApp.openById(SOURCE_ID).getSheetByName(tab);
}

/** Display grid of a source tab (host copy). */
function sourceGrid(env, tab) {
  return sourceSheet(env, tab).getDataRange().getDisplayValues();
}

/** Source records as the importer reads them. */
function sourceRecords(ctx, entity) {
  return plain(ctx.Importer.readSource()[entity].records);
}

function byName(list, key, name) {
  return list.find((r) => r[key] === name);
}

function monthData(ctx, month) {
  return ok(ctx, 'api_getMonthData', { month });
}

function dataWrites(env, ctx) {
  const dataId = ctx.Config.get().dataId;
  return env.__state.writes.filter((w) => w.spreadsheetId === dataId).length;
}

// ---------------------------------------------------------------------------------- trigger

test('saving a source creates one hourly trigger; enableSync never duplicates it', () => {
  const sb = live();
  assert.equal(sb.setConfig.sync.enabled, true);
  assert.deepEqual(plain(sb.env.__state.triggers.map((t) => [t.handler, t.everyHours])), [['syncHourly', 1]]);
  ok(sb.ctx, 'api_enableSync');
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  assert.equal(sb.env.__state.triggers.length, 1);
  assert.equal(ok(sb.ctx, 'api_bootstrap').sync.enabled, true);

  // Deleted from the Apps Script editor: Paramètres sees it and the stored flag follows.
  sb.env.__state.triggers.length = 0;
  assert.equal(ok(sb.ctx, 'api_getSettings').sync.enabled, false);
  assert.equal(ok(sb.ctx, 'api_getSyncStatus').enabled, false);
});

test('without the ScriptApp authorisation: the source is still saved, the status says why', () => {
  const sb = loadGas({ sources: [source('2026-05')], scriptAppDenied: true });
  const d = ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  assert.equal(sb.ctx.Config.get().sourceId, SOURCE_ID);
  assert.equal(d.sync.enabled, false);
  assert.match(d.sync.authError, /autorisation/i);
  assert.match(ok(sb.ctx, 'api_getSettings').sync.authError, /autorisation/i);
  const e = fail(sb.ctx, 'api_enableSync', null, 'INTERNAL');
  assert.match(e.message, /autorisation/i);
});

// ------------------------------------------------------------------------------------- runs

test('first sync creates the current month; an unchanged source writes nothing', () => {
  const sb = live();
  const first = ok(sb.ctx, 'api_syncNow');
  assert.equal(first.result.month, '2026-05');
  assert.equal(first.result.changed, true);
  assert.equal(first.result.changes.created, true);
  assert.equal(first.status.lastChange.created, true);
  assert.equal(first.status.lastChangeAt, first.status.lastOkAt);
  assert.equal(first.status.lastError, null);
  assert.deepEqual(ok(sb.ctx, 'api_bootstrap').months, ['2026-05']);
  assert.equal(ok(sb.ctx, 'api_getImportLog').length, 1);

  const before = dataWrites(sb.env, sb.ctx);
  const again = ok(sb.ctx, 'api_syncNow');
  assert.equal(again.result.changed, false);
  assert.equal(dataWrites(sb.env, sb.ctx), before, 'no write to the data spreadsheet');
  assert.equal(ok(sb.ctx, 'api_getImportLog').length, 1, 'no log entry for a sync without change');
  assert.equal(again.status.lastChangeAt, first.status.lastChangeAt);
});

test('a change in the source is picked up, counted, logged; Galink/IDP survive', () => {
  const sb = synced();
  const apps = monthData(sb.ctx, '2026-05').applications;
  ok(sb.ctx, 'api_saveApplications', { month: '2026-05', changes: [
    { id: byName(apps, KEY_APP, 'Minitab')._id, updates: { Galink: 'Oui', IDP: 'Non' } }] });

  // Someone edits the source sheet directly: one poste status, one new application row.
  const grid = sourceGrid(sb.env, POSTES_TAB);
  const statut = grid[1].findIndex((h) => h.trim() === 'Statut');
  const row = grid.findIndex((r) => r.includes('LAB-TEX-01'));
  sourceSheet(sb.env, POSTES_TAB).getRange(row + 1, statut + 1).setValue('À revoir');

  const res = ok(sb.ctx, 'api_syncNow');
  assert.equal(res.result.changed, true);
  assert.deepEqual(plain(res.result.changes.postes), { added: 0, removed: 0, changed: 1, values: 1 });
  assert.deepEqual(plain(res.result.changes.applications), { added: 0, removed: 0, changed: 0, values: 0 });
  assert.deepEqual(plain(res.status.lastChange.postes), { added: 0, removed: 0, changed: 1, values: 1 });
  const md = monthData(sb.ctx, '2026-05');
  assert.equal(byName(md.postes, KEY_POSTE, 'LAB-TEX-01').Statut, 'À revoir');
  const minitab = byName(md.applications, KEY_APP, 'Minitab');
  assert.equal(minitab.Galink, 'Oui');
  assert.equal(minitab.IDP, 'Non');
  const log = ok(sb.ctx, 'api_getImportLog');
  assert.equal(log.length, 2);
  assert.deepEqual(plain(log[0].changes.postes), { added: 0, removed: 0, changed: 1, values: 1 });
});

test('a new month: the first run of the month creates it, the previous one stays frozen', () => {
  const sb = synced();
  sb.ctx.Config.today = () => '2026-06-01';
  const res = ok(sb.ctx, 'api_syncNow');
  assert.equal(res.result.month, '2026-06');
  assert.equal(res.result.changes.created, true);
  assert.deepEqual(ok(sb.ctx, 'api_bootstrap').months, ['2026-05', '2026-06']);

  // An edit of May (past month) changes the snapshot only, never the source.
  const writes = sb.env.__state.writes.filter((w) => w.spreadsheetId === SOURCE_ID).length;
  const may = monthData(sb.ctx, '2026-05');
  const r = ok(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [
    { id: byName(may.postes, KEY_POSTE, 'LAB-TEX-01')._id, updates: { Statut: 'Historique corrigé' } }] });
  assert.equal(r.sourceUpdated, false);
  assert.equal(sb.env.__state.writes.filter((w) => w.spreadsheetId === SOURCE_ID).length, writes);
  ok(sb.ctx, 'api_syncNow');
  assert.equal(byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'LAB-TEX-01').Statut, 'Historique corrigé');
});

test('errors are recorded in the status until the next successful run; BUSY is not', () => {
  const sb = synced();
  sb.env.__fault({ method: 'openById', id: SOURCE_ID });
  fail(sb.ctx, 'api_syncNow', null, 'SOURCE_ERROR');
  let st = ok(sb.ctx, 'api_getSyncStatus');
  assert.equal(st.lastError.code, 'SOURCE_ERROR');
  assert.match(st.lastError.message, /classeur source/);
  assert.ok(st.lastOkAt, 'last success kept');

  ok(sb.ctx, 'api_syncNow');
  assert.equal(ok(sb.ctx, 'api_getSyncStatus').lastError, null);

  sb.env.__state.lockTimeout = true;
  fail(sb.ctx, 'api_syncNow', null, 'BUSY');
  sb.env.__state.lockTimeout = false;
  st = ok(sb.ctx, 'api_getSyncStatus');
  assert.equal(st.lastError, null);
});

test('syncHourly (the trigger handler): nothing without a source, a sync with one', () => {
  const sb = loadGas({ sources: [source('2026-05')] });
  sb.ctx.Config.today = () => '2026-05-15';
  assert.doesNotThrow(() => sb.ctx.syncHourly({ triggerUid: 't1' }));
  assert.equal(sb.ctx.Store.listMonths().length, 0);
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  sb.ctx.syncHourly({ triggerUid: 't1' });
  assert.deepEqual(plain(sb.ctx.Store.listMonths()), ['2026-05']);
  // A failing hourly run throws (Google e-mails the owner) after recording the error.
  sb.env.__fault({ method: 'openById', id: SOURCE_ID });
  assert.throws(() => sb.ctx.syncHourly({ triggerUid: 't1' }));
  assert.equal(ok(sb.ctx, 'api_getSyncStatus').lastError.code, 'SOURCE_ERROR');
});

test('the sync adds « Poste générique Decathlon » when an application names it', () => {
  const def = source('2026-05');
  const tab = def.sheets[APPS_TAB];
  const col = tab.values[1].indexOf('Installé sur poste');
  const row = tab.values.findIndex((r) => r.includes('Dropbox perso'));
  tab.values[row][col] = 'Poste générique Decathlon';
  tab.display[row][col] = 'Poste générique Decathlon';
  const sb = loadGas({ sources: [def] });
  sb.ctx.Config.today = () => '2026-05-15';
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_syncNow');
  const generic = byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'Poste générique Decathlon');
  assert.ok(generic);
  assert.match(generic.Commentaires, /applications non liées/);
  assert.equal(ok(sb.ctx, 'api_syncNow').result.changed, false, 'stable across runs');
});

// ------------------------------------------------------------------------------- write-back

test('editing the current month writes into the source first; the next sync keeps the edit', () => {
  const sb = synced();
  const md = monthData(sb.ctx, '2026-05');
  const mec = byName(md.postes, KEY_POSTE, 'LAB-MEC-01');
  const res = ok(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [
    { id: mec._id, updates: { Statut: 'En cours', Commentaires: '=IMPORTRANGE("x")', 'Responsable action': '' } }] });
  assert.equal(res.sourceUpdated, true);
  const src = byName(sourceRecords(sb.ctx, 'postes'), KEY_POSTE, 'LAB-MEC-01');
  assert.equal(src.Statut, 'En cours');
  assert.equal(src.Commentaires, '=IMPORTRANGE("x")', 'formula-looking text stays text');
  assert.equal(src['Responsable action'], null);
  assert.deepEqual(plain(sb.env.__state.formulas.filter((f) => f.spreadsheetId === SOURCE_ID)), [], 'no formula written');

  const again = ok(sb.ctx, 'api_syncNow');
  assert.deepEqual(plain(again.result.changes.postes), { added: 0, removed: 0, changed: 0, values: 0 });
  assert.equal(byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'LAB-MEC-01').Statut, 'En cours');
});

test('Galink / IDP (no source column) stay app-only; other fields of the same edit reach the source', () => {
  const sb = synced();
  const apps = monthData(sb.ctx, '2026-05').applications;
  const before = sourceGrid(sb.env, APPS_TAB)[1].length;
  ok(sb.ctx, 'api_saveApplications', { month: '2026-05', changes: [
    { id: byName(apps, KEY_APP, 'Figma')._id, updates: { Galink: 'Oui', Contrat: 'Oui' } }] });
  assert.equal(sourceGrid(sb.env, APPS_TAB)[1].length, before, 'no column added to the source');
  assert.equal(byName(sourceRecords(sb.ctx, 'applications'), KEY_APP, 'Figma').Contrat, 'Oui');
  ok(sb.ctx, 'api_syncNow');
  const figma = byName(monthData(sb.ctx, '2026-05').applications, KEY_APP, 'Figma');
  assert.equal(figma.Galink, 'Oui');
  assert.equal(figma.Contrat, 'Oui');
});

test('a formula cell, a missing row or a refused value: nothing is written anywhere', () => {
  const sb = synced();
  const md = monthData(sb.ctx, '2026-05');
  const tex = byName(md.postes, KEY_POSTE, 'LAB-TEX-01');
  const grid = sourceGrid(sb.env, POSTES_TAB);
  const score = grid[1].indexOf('Score conformité');
  const statut = grid[1].findIndex((h) => h.trim() === 'Statut');
  const row = grid.findIndex((r) => r.includes('LAB-TEX-01'));
  sourceSheet(sb.env, POSTES_TAB).getRange(row + 1, score + 1).setValue('=AVERAGE(J3:N3)');

  const e = fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [
    { id: tex._id, updates: { Statut: 'Changé', 'Score conformité': '90%' } }] }, 'VALIDATION');
  assert.match(e.message, /formule/);
  assert.notEqual(sourceGrid(sb.env, POSTES_TAB)[row][statut], 'Changé', 'checked before any write');
  assert.equal(byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'LAB-TEX-01').Statut, tex.Statut);

  // The row was renamed in the source since the last sync.
  sourceSheet(sb.env, POSTES_TAB).getRange(row + 1, grid[1].indexOf(KEY_POSTE) + 1).setValue('LAB-TEX-01-NEW');
  const e2 = fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [
    { id: tex._id, updates: { Statut: 'Changé' } }] }, 'SOURCE_ERROR');
  assert.match(e2.message, /introuvable/);

  // Data validation in the source refuses the value.
  const cha = byName(md.postes, KEY_POSTE, 'LAB-CHA-01');
  sb.env.__fault({ method: 'setValue', id: SOURCE_ID, sheet: POSTES_TAB, message: 'Exception: The data you entered in cell L4 violates the data validation rules set on this cell.' });
  const e3 = fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: cha._id, updates: { Statut: 'n/a' } }] }, 'VALIDATION');
  assert.match(e3.message, /refusé/);
  assert.equal(byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'LAB-CHA-01').Statut, cha.Statut);
});

test('add / rename / delete an application of the current month change the source rows', () => {
  const sb = synced();
  ok(sb.ctx, 'api_addAction', { target_type: 'application', target_name: 'Figma', action: 'Vérifier la licence' });
  const added = ok(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'Canva', Équipe: 'R&D Vélo', Contrat: 'Non' } });
  let src = sourceRecords(sb.ctx, 'applications');
  assert.equal(byName(src, KEY_APP, 'Canva').Contrat, 'Non');
  assert.equal(src[src.length - 1][KEY_APP], 'Canva', 'appended after the last application');
  fail(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'canva ' } }, 'VALIDATION');

  const figma = byName(monthData(sb.ctx, '2026-05').applications, KEY_APP, 'Figma');
  const ren = ok(sb.ctx, 'api_renameApplication', { month: '2026-05', id: figma._id, newName: 'Figma Pro' });
  assert.equal(ren.actionsUpdated, 1);
  src = sourceRecords(sb.ctx, 'applications');
  assert.ok(byName(src, KEY_APP, 'Figma Pro'));
  assert.equal(byName(src, KEY_APP, 'Figma'), undefined);

  ok(sb.ctx, 'api_deleteApplication', { month: '2026-05', id: added._id });
  assert.equal(byName(sourceRecords(sb.ctx, 'applications'), KEY_APP, 'Canva'), undefined);

  const res = ok(sb.ctx, 'api_syncNow');
  assert.deepEqual(plain(res.result.changes.applications), { added: 0, removed: 0, changed: 0, values: 0 },
    'the source and the snapshot agree');
});

test('a generic poste added in the app becomes a source row; formulas of the last row are filled down', () => {
  const sb = synced();
  const grid = sourceGrid(sb.env, POSTES_TAB);
  const score = grid[1].indexOf('Score conformité');
  const lastRow = grid.reduce((last, r, i) => (r[grid[1].indexOf(KEY_POSTE)] ? i : last), 0);
  sourceSheet(sb.env, POSTES_TAB).getRange(lastRow + 1, score + 1).setValue('=AVERAGE(J8:N8)');
  const res = ok(sb.ctx, 'api_addGenericPoste', { month: '2026-05' });
  assert.equal(res.created, true);
  const after = sourceSheet(sb.env, POSTES_TAB).getDataRange().getValues();
  const genRow = after.findIndex((r) => r.includes('Poste générique Decathlon'));
  assert.equal(genRow, lastRow + 1, 'just below the last poste');
  assert.equal(after[genRow][score], '=AVERAGE(J8:N8)', 'formula copied down');
  assert.equal(ok(sb.ctx, 'api_addGenericPoste', { month: '2026-05' }).created, false);
});
