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

const { loadGas, plain, timingLines } = require('../helpers/gasSandbox');
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
  const e = fail(sb.ctx, 'api_enableSync', null, 'NOT_CONFIGURED');
  assert.match(e.message, /autorisation/i);
  assert.match(e.message, /setup/);
  assert.doesNotMatch(e.message, /Erreur interne/);
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

// ------------------------------------------------------------- source read outside the lock

const STAMP = 'SOURCE_WRITE_STAMP';

/** A new Apps Script execution over the same spreadsheets / properties, today = 15/05/2026. */
function execution(env) {
  const sb = loadGas({ env });
  sb.ctx.Config.today = () => '2026-05-15';
  return sb.ctx;
}

function stamp(env) {
  return env.PropertiesService.getScriptProperties().getProperty(STAMP);
}

/** Range reads of the source spreadsheet made while fn runs (gasFakes state.reads). */
function sourceReadsDuring(env, fn) {
  const r0 = env.__state.reads.length;
  fn();
  return env.__state.reads.slice(r0).filter((r) => r.spreadsheetId === SOURCE_ID);
}

function importLine(env) {
  return timingLines(env).filter((l) => l.stage === 'importMonth').pop();
}

test('the sync reads the source before taking the lock; the lock only covers compare and write', () => {
  const sb = synced();
  const ctx = execution(sb.env);
  let readsAtLock = null;
  const r0 = sb.env.__state.reads.length;
  sb.env.__state.onWaitLock = () => {
    readsAtLock = sb.env.__state.reads.slice(r0).filter((r) => r.spreadsheetId === SOURCE_ID).length;
  };
  const reads = sourceReadsDuring(sb.env, () => ok(ctx, 'api_syncNow'));
  assert.ok(reads.length >= 3, 'postes + applications + référentiel read');
  assert.deepEqual(reads.filter((r) => r.lockHeld), [], 'no source read under the lock');
  assert.equal(readsAtLock, reads.length, 'every source read happened before waitLock');
  assert.equal(importLine(sb.env).reread, false);

  // A change in the source is still picked up by a sync that reads outside the lock.
  const grid = sourceGrid(sb.env, POSTES_TAB);
  const statut = grid[1].findIndex((h) => h.trim() === 'Statut');
  sourceSheet(sb.env, POSTES_TAB).getRange(grid.findIndex((r) => r.includes('LAB-TEX-01')) + 1, statut + 1).setValue('À revoir');
  const res = ok(execution(sb.env), 'api_syncNow');
  assert.deepEqual(plain(res.result.changes.postes), { added: 0, removed: 0, changed: 1, values: 1 });
  assert.equal(byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'LAB-TEX-01').Statut, 'À revoir');
});

/**
 * Sync whose source read happens before a live-month save of another execution: the save takes the
 * lock first (state.onWaitLock), writes Statut = 'En cours' into the source and the snapshot.
 * `forgetStamp` puts the stamp back as it was after the save, i.e. a write-back that did not move it.
 */
function syncRacingASave(forgetStamp) {
  const sb = synced();
  const mec = byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'LAB-MEC-01');
  assert.notEqual(mec.Statut, 'En cours');
  const ctx = execution(sb.env);
  let sourceReadFirst = false;
  sb.env.__state.onWaitLock = () => {
    sourceReadFirst = sb.env.__state.reads.some((r) => r.spreadsheetId === SOURCE_ID && !r.lockHeld);
    const before = stamp(sb.env);
    const saved = ok(execution(sb.env), 'api_savePostes', { month: '2026-05', changes: [
      { id: mec._id, updates: { Statut: 'En cours' } }] });
    assert.equal(saved.sourceUpdated, true);
    assert.notEqual(stamp(sb.env), before, 'the write-back moved the stamp');
    if (forgetStamp) {
      const props = sb.env.PropertiesService.getScriptProperties();
      if (before === null) props.deleteProperty(STAMP); else props.setProperty(STAMP, before);
    }
  };
  const res = ok(ctx, 'api_syncNow');
  assert.equal(sourceReadFirst, true, 'the save landed after the sync read the source');
  return { sb, res, statut: byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'LAB-MEC-01').Statut };
}

test('a live-month save landing between the sync\'s source read and its lock is not reverted', () => {
  const { sb, res, statut } = syncRacingASave(false);
  assert.equal(statut, 'En cours', 'the edit survives the sync');
  assert.equal(byName(sourceRecords(sb.ctx, 'postes'), KEY_POSTE, 'LAB-MEC-01').Statut, 'En cours');
  assert.deepEqual(plain(res.result.changes.postes), { added: 0, removed: 0, changed: 0, values: 0 });
  assert.equal(res.result.changed, false);
  const line = importLine(sb.env);
  assert.equal(line.reread, true, 'the source was read again under the lock');
  assert.ok('rereadSource' in line);
});

test('control: without the stamp moving, the same race reverts the edit (the guard is what prevents it)', () => {
  const { sb, res, statut } = syncRacingASave(true);
  assert.notEqual(statut, 'En cours', 'the stale source read wins');
  assert.deepEqual(plain(res.result.changes.postes), { added: 0, removed: 0, changed: 1, values: 1 });
  assert.equal(importLine(sb.env).reread, false);
});

test('a source configured anew while the sync read the old one: read again under the lock', () => {
  const sb = synced();
  const otherDef = source('2026-05');
  otherDef.id = '1OtherSourceSpreadsheetId000000000000000000';
  const tab = otherDef.sheets[POSTES_TAB];
  const statut = tab.values[1].findIndex((h) => String(h).trim() === 'Statut');
  const row = tab.values.findIndex((r) => r.includes('LAB-TEX-01'));
  tab.values[row][statut] = 'Autre source';
  tab.display[row][statut] = 'Autre source';
  sb.env.__addSpreadsheet(otherDef);
  const ctx = execution(sb.env);
  sb.env.__state.onWaitLock = () => { ok(execution(sb.env), 'api_setConfig', { source: otherDef.id }); };
  const res = ok(ctx, 'api_syncNow');
  assert.equal(importLine(sb.env).reread, true);
  assert.deepEqual(plain(res.result.changes.postes), { added: 0, removed: 0, changed: 1, values: 1 });
  assert.equal(byName(monthData(sb.ctx, '2026-05').postes, KEY_POSTE, 'LAB-TEX-01').Statut, 'Autre source');
});

// ------------------------------------------------------------------------------ source title

test('bootstrap never opens the source: its title is stored by setConfig and refreshed by the sync', () => {
  const sb = live();
  const st = sb.env.__state;
  const url = 'https://docs.google.com/spreadsheets/d/' + SOURCE_ID + '/edit';
  assert.equal(sb.setConfig.sourceTitle, 'ShadowIT_Industry');
  assert.equal(sb.setConfig.sourceUrl, url);
  assert.equal(execution(sb.env).Config.get().sourceTitle, 'ShadowIT_Industry', 'stored with the id');

  let opened = st.opened.length;
  let boot = ok(execution(sb.env), 'api_bootstrap');
  assert.deepEqual([boot.sourceTitle, boot.sourceUrl], ['ShadowIT_Industry', url]);
  assert.equal(boot.dataUrl, 'https://docs.google.com/spreadsheets/d/' + sb.ctx.Config.get().dataId + '/edit');
  assert.deepEqual(st.opened.slice(opened).filter((id) => id === SOURCE_ID), [], 'source not opened');

  // Renamed in Drive: bootstrap keeps the stored title until the sync, which opens the source anyway.
  st.spreadsheets.get(SOURCE_ID).rename('Shadow IT — Industrie');
  assert.equal(ok(execution(sb.env), 'api_bootstrap').sourceTitle, 'ShadowIT_Industry');
  let writes = st.propertyWrites.length;
  ok(execution(sb.env), 'api_syncNow');
  assert.ok(st.propertyWrites.slice(writes).includes('SOURCE_INFO'), 'title refreshed by the sync');
  opened = st.opened.length;
  boot = ok(execution(sb.env), 'api_bootstrap');
  assert.equal(boot.sourceTitle, 'Shadow IT — Industrie');
  assert.deepEqual(st.opened.slice(opened).filter((id) => id === SOURCE_ID), []);
  // An unchanged title is not written again (the hourly run that changes nothing writes nothing).
  writes = st.propertyWrites.length;
  ok(execution(sb.env), 'api_syncNow');
  assert.equal(st.propertyWrites.slice(writes).includes('SOURCE_INFO'), false);
});

test('source title: a deployment that predates it, or a title stored for another source, shows none until the sync', () => {
  const sb = loadGas({ sources: [source('2026-05')], props: { SOURCE_SPREADSHEET_ID: SOURCE_ID,
    SOURCE_INFO: JSON.stringify({ id: '1AnotherSourceSpreadsheetId0000000000000', title: 'Ancienne source' }) } });
  sb.ctx.Config.today = () => '2026-05-15';
  let boot = ok(execution(sb.env), 'api_bootstrap');
  assert.equal(boot.sourceTitle, '', 'a title about another id is ignored');
  assert.equal(boot.sourceUrl, 'https://docs.google.com/spreadsheets/d/' + SOURCE_ID + '/edit');
  sb.env.PropertiesService.getScriptProperties().deleteProperty('SOURCE_INFO');
  assert.equal(ok(execution(sb.env), 'api_bootstrap').sourceTitle, '', 'no title stored yet');
  ok(execution(sb.env), 'api_syncNow');
  boot = ok(execution(sb.env), 'api_bootstrap');
  assert.equal(boot.sourceTitle, 'ShadowIT_Industry');
});

test('Paramètres checks the source live; when it is not accessible the stored title stays', () => {
  const sb = synced();
  const st = sb.env.__state;
  let opened = st.opened.length;
  let s = ok(execution(sb.env), 'api_getSettings');
  assert.deepEqual(st.opened.slice(opened), [SOURCE_ID], 'live check of the source only (no data spreadsheet open)');
  assert.deepEqual(plain(s.source.tabsFound), { postes: true, applications: true, referentiel: true });
  assert.equal(s.dataUrl, 'https://docs.google.com/spreadsheets/d/' + sb.ctx.Config.get().dataId + '/edit');
  sb.env.__fault({ method: 'openById', id: SOURCE_ID, times: Infinity });
  s = ok(execution(sb.env), 'api_getSettings');
  assert.deepEqual(plain(s.source), { id: SOURCE_ID, url: 'https://docs.google.com/spreadsheets/d/' + SOURCE_ID + '/edit',
    title: 'ShadowIT_Industry', tabsFound: null });
  // Bootstrap does not notice (it does not open the source): the sync status reports the failure.
  opened = st.opened.length;
  assert.equal(ok(execution(sb.env), 'api_bootstrap').sourceTitle, 'ShadowIT_Industry');
  assert.deepEqual(st.opened.slice(opened).filter((id) => id === SOURCE_ID), []);
});

test('the source write stamp moves after the flush, under the lock, only when the source may have changed', () => {
  const sb = synced();
  const env = sb.env;
  const props = env.PropertiesService.getScriptProperties();
  const bumps = [];
  const setProperty = props.setProperty;
  props.setProperty = function (k, v) {
    if (k === STAMP) bumps.push({ v, lockHeld: env.__state.lock.held, flushes: env.__state.flushes });
    return setProperty.call(this, k, v);
  };
  const md = monthData(sb.ctx, '2026-05');
  const id = (name) => byName(md.postes, KEY_POSTE, name)._id;

  // A live edit: one bump, under the lock, after a flush that followed the source write.
  const flushes = env.__state.flushes;
  ok(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: id('LAB-MEC-01'), updates: { Statut: 'En cours' } }] });
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].lockHeld, true);
  assert.ok(bumps[0].flushes > flushes, 'flushed before the stamp moved');
  const first = Number(bumps[0].v);

  // No source write: Galink / IDP only, a refused formula cell, a sync, a past-month edit.
  const apps = monthData(sb.ctx, '2026-05').applications;
  ok(sb.ctx, 'api_saveApplications', { month: '2026-05', changes: [
    { id: byName(apps, KEY_APP, 'Figma')._id, updates: { Galink: 'Oui' } }] });
  const grid = sourceGrid(env, POSTES_TAB);
  const score = grid[1].indexOf('Score conformité');
  sourceSheet(env, POSTES_TAB).getRange(grid.findIndex((r) => r.includes('LAB-TEX-01')) + 1, score + 1).setValue('=AVERAGE(J3:N3)');
  fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: id('LAB-TEX-01'), updates: { 'Score conformité': '90%' } }] }, 'VALIDATION');
  ok(sb.ctx, 'api_syncNow');
  assert.equal(bumps.length, 1);

  // Add, rename, delete, generic poste: one bump each, always moving forward.
  const added = ok(sb.ctx, 'api_addApplication', { month: '2026-05', record: { [KEY_APP]: 'Canva' } });
  ok(sb.ctx, 'api_renameApplication', { month: '2026-05', id: added._id, newName: 'Canva Pro' });
  ok(sb.ctx, 'api_deleteApplication', { month: '2026-05', id: added._id });
  ok(sb.ctx, 'api_addGenericPoste', { month: '2026-05' });
  assert.equal(bumps.length, 5);
  assert.ok(bumps.every((b) => b.lockHeld));
  const values = bumps.map((b) => Number(b.v));
  assert.ok(values.every((v, i) => i === 0 || v > values[i - 1]), 'strictly increasing: ' + values);
  assert.ok(values[0] === first);

  // A value refused by data validation: the stamp moves anyway (an earlier cell may have been written).
  sb.env.__fault({ method: 'setValue', id: SOURCE_ID, sheet: POSTES_TAB, message: 'Exception: The data you entered violates the data validation rules set on this cell.' });
  fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: id('LAB-CHA-01'), updates: { Statut: 'n/a' } }] }, 'VALIDATION');
  assert.equal(bumps.length, 6);

  // The same clock reading twice still moves the stamp.
  const now = Date.now;
  try {
    Date.now = () => 1;
    ok(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: id('LAB-MEC-01'), updates: { Statut: 'Fait' } }] });
    ok(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: id('LAB-MEC-01'), updates: { Statut: 'En cours' } }] });
  } finally {
    Date.now = now;
  }
  assert.equal(Number(bumps[7].v), Number(bumps[6].v) + 1);
  props.setProperty = setProperty;

  // Writing into the source outside the lock is a bug, refused.
  assert.throws(() => sb.ctx.Store.noteSourceWrite(), (e) => e.code === 'INTERNAL');
});

// --------------------------------------------------------------------- write-back reads

/** Synced sandbox whose postes source tab has `extra` more records (POSTE-001...) below the fixture's. */
function syncedWithManyPostes(extra) {
  const def = source('2026-05');
  const tab = def.sheets[POSTES_TAB];
  const key = tab.values[1].indexOf(KEY_POSTE);
  const lastRecord = tab.values.reduce((last, r, i) => (i > 1 && r[key] ? i : last), 0);
  const fresh = [];
  for (let i = 1; i <= extra; i++) {
    const v = tab.values[lastRecord].slice();
    const d = tab.display[lastRecord].slice();
    v[key] = d[key] = 'POSTE-' + String(i).padStart(3, '0');
    fresh.push([v, d]);
  }
  tab.values.splice(lastRecord + 1, 0, ...fresh.map((x) => x[0]));
  tab.display.splice(lastRecord + 1, 0, ...fresh.map((x) => x[1]));
  const sb = loadGas({ sources: [def] });
  sb.ctx.Config.today = () => '2026-05-15';
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_syncNow');
  return sb;
}

/** 1-based sheet row of a poste in the source. */
function sourceRow(env, name) {
  return sourceGrid(env, POSTES_TAB).findIndex((r) => r.includes(name)) + 1;
}

test('a live save reads the header block, the key column and the edited rows only, all under the lock', () => {
  const sb = syncedWithManyPostes(40);
  const env = sb.env;
  const grid = sourceGrid(env, POSTES_TAB);
  const width = grid[1].length;
  const postes = monthData(sb.ctx, '2026-05').postes;
  const edit = (names, updates) => sourceReadsDuring(env, () => ok(sb.ctx, 'api_savePostes', { month: '2026-05',
    changes: names.map((n) => ({ id: byName(postes, KEY_POSTE, n)._id, updates: updates || { Commentaires: 'Vu' } })) }));
  const formulaRows = (reads) => reads.filter((r) => r.method === 'getFormulas').map((r) => r.a1);
  const lastCol = String.fromCharCode(64 + width);

  let reads = edit(['POSTE-020']);
  assert.ok(reads.every((r) => r.lockHeld));
  assert.deepEqual(reads.map((r) => r.method), ['getDisplayValues', 'getDisplayValues', 'getFormulas']);
  assert.equal(reads[0].a1, 'A1:' + lastCol + '15', 'the header block');
  assert.match(reads[1].a1, /^([A-Z])3:\1\d+$/, 'one column: the key, from the first row below the header');
  const row = sourceRow(env, 'POSTE-020');
  assert.deepEqual(formulaRows(reads), ['A' + row + ':' + lastCol + row]);
  const height = sourceSheet(env, POSTES_TAB).getDataRange().getNumRows();
  assert.deepEqual(reads.map((r) => r.cells), [15 * width, height - 2, width], 'not the whole tab twice (' + 2 * height * width + ' cells)');
  assert.equal(byName(sourceRecords(sb.ctx, 'postes'), KEY_POSTE, 'POSTE-020').Commentaires, 'Vu');

  // Nearby rows: one block; scattered rows: one call each up to 3, then one block from first to last.
  const r10 = sourceRow(env, 'POSTE-010');
  assert.deepEqual(formulaRows(edit(['POSTE-012', 'POSTE-010', 'POSTE-014'])),
    ['A' + r10 + ':' + lastCol + (r10 + 4)]);
  assert.deepEqual(formulaRows(edit(['POSTE-001', 'POSTE-020', 'POSTE-039'])).length, 3);
  const r1 = sourceRow(env, 'POSTE-001');
  assert.deepEqual(formulaRows(edit(['POSTE-001', 'POSTE-010', 'POSTE-020', 'POSTE-030', 'POSTE-040'])),
    ['A' + r1 + ':' + lastCol + sourceRow(env, 'POSTE-040')]);

  // Galink-like fields without a source column: nothing to check, no formula read, no write.
  const writes = env.__state.writes.filter((w) => w.spreadsheetId === SOURCE_ID).length;
  reads = sourceReadsDuring(env, () => ok(sb.ctx, 'api_savePostes', { month: '2026-05',
    changes: [{ id: byName(postes, KEY_POSTE, 'POSTE-005')._id, updates: { 'Colonne inconnue': 'x' } }] }));
  assert.deepEqual(formulaRows(reads), []);
  assert.equal(env.__state.writes.filter((w) => w.spreadsheetId === SOURCE_ID).length, writes);
});

test('scattered edits: a formula in any edited row refuses the whole save, before any write', () => {
  const sb = syncedWithManyPostes(40);
  const env = sb.env;
  const grid = sourceGrid(env, POSTES_TAB);
  const score = grid[1].indexOf('Score conformité');
  const r30 = sourceRow(env, 'POSTE-030');
  sourceSheet(env, POSTES_TAB).getRange(r30, score + 1).setValue('=AVERAGE(J5:N5)');
  const postes = monthData(sb.ctx, '2026-05').postes;
  const writes = env.__state.writes.filter((w) => w.spreadsheetId === SOURCE_ID).length;
  const e = fail(sb.ctx, 'api_savePostes', { month: '2026-05', changes: [
    { id: byName(postes, KEY_POSTE, 'POSTE-001')._id, updates: { 'Score conformité': '10%' } },
    { id: byName(postes, KEY_POSTE, 'POSTE-015')._id, updates: { 'Score conformité': '20%' } },
    { id: byName(postes, KEY_POSTE, 'POSTE-025')._id, updates: { 'Score conformité': '30%' } },
    { id: byName(postes, KEY_POSTE, 'POSTE-030')._id, updates: { 'Score conformité': '40%' } }] }, 'VALIDATION');
  assert.match(e.message, /« Score conformité » est calculée par une formule/);
  assert.equal(env.__state.writes.filter((w) => w.spreadsheetId === SOURCE_ID).length, writes, 'nothing written');
  assert.equal(sourceSheet(env, POSTES_TAB).getRange(r30, score + 1).getFormula(), '=AVERAGE(J5:N5)');
});

test('append below a non-empty row: a row is inserted, the formulas of the last record are filled down', () => {
  const sb = synced();
  const env = sb.env;
  const grid = sourceGrid(env, POSTES_TAB);
  const key = grid[1].indexOf(KEY_POSTE);
  const score = grid[1].indexOf('Score conformité');
  const lastRow = grid.reduce((last, r, i) => (r[key] ? i : last), 0) + 1; // 1-based
  const sheet = sourceSheet(env, POSTES_TAB);
  sheet.getRange(lastRow, score + 1).setValue('=AVERAGE(J' + lastRow + ':N' + lastRow + ')');
  sheet.getRange(lastRow + 1, 1).setValue('Total'); // a non-record row right below the last record
  const reads = sourceReadsDuring(env, () => assert.equal(ok(sb.ctx, 'api_addGenericPoste', { month: '2026-05' }).created, true));
  const after = sheet.getDataRange().getValues();
  assert.equal(after[lastRow][key], 'Poste générique Decathlon', 'inserted just below the last record');
  assert.equal(after[lastRow + 1][0], 'Total', 'the non-empty row moved down, untouched');
  assert.equal(after[lastRow][score], '=AVERAGE(J' + lastRow + ':N' + lastRow + ')', 'formula copied down');
  // Header block, key column, the row below the last record, the last record's formulas.
  assert.deepEqual(reads.map((r) => r.method), ['getDisplayValues', 'getDisplayValues', 'getDisplayValues', 'getFormulas']);
  assert.ok(reads.slice(2).every((r) => r.cells === grid[1].length), 'one row each');
});
