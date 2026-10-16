'use strict';
/**
 * Integration tests: integrity of the write-back into the source (docs/API.md §4 Importer.writeEdits /
 * deleteRecord, §3 api_savePostes / api_saveApplications / api_renameApplication / api_deleteApplication)
 * when the source is not as tidy as the snapshot suggests:
 *   - a key several source rows share (« Minitab » / « MINITAB »): edits, renames and deletes of either
 *     record are refused before anything is written (the first row would be hit, whichever record was
 *     meant); the sync warns about the duplicates and sees a change made to the second row;
 *   - a new name another source row already has (not yet synchronised) is refused;
 *   - array-formula columns (ARRAYFORMULA in the first data row or in the header row): their spilled cells
 *     hold no formula of their own but are refused like formula cells; the row holding the formula cannot
 *     be deleted from the app.
 *
 * "Today" is pinned with ctx.Config.today = 15/05/2026, so 2026-05 is the current (live) month.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas, plain, sheetValues } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const POSTES_TAB = 'Suivi des postes';
const APPS_TAB = 'Suivi des applications';
const LIVE = '2026-05';
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

/** Fixture source with Date cells at noon UTC (same calendar day in Paris whatever the host TZ). */
function source(opts) {
  const def = buildSourceSpreadsheet(LIVE, opts);
  for (const tab of Object.values(def.sheets)) {
    tab.values = tab.values.map((row) => row.map((v) => (v instanceof Date
      ? new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 12)) : v)));
  }
  return def;
}

/** 0-based grid row of the last row whose key cell is not blank. */
function lastRecordRow(tab, key) {
  const k = tab.display[1].map((h) => h.trim()).indexOf(key);
  return tab.display.reduce((last, r, i) => (i > 1 && r[k] ? i : last), 0);
}

/**
 * Adds a copy of the application `name` below the last application, renamed `as` (same normKey or not)
 * with `changes` applied (display = raw values).
 */
function addAppRow(def, name, as, changes) {
  const tab = def.sheets[APPS_TAB];
  const headers = tab.display[1].map((h) => h.trim());
  const k = headers.indexOf(KEY_APP);
  const from = tab.display.findIndex((r) => r[k] === name);
  const v = tab.values[from].slice();
  const d = tab.display[from].slice();
  v[k] = d[k] = as;
  for (const [h, value] of Object.entries(changes || {})) v[headers.indexOf(h)] = d[headers.indexOf(h)] = value;
  const at = lastRecordRow(tab, KEY_APP) + 1;
  tab.values.splice(at, 0, v);
  tab.display.splice(at, 0, d);
}

/** Sandbox on `def`, today pinned, source saved, first sync done. */
function synced(def) {
  const sb = loadGas({ sources: [def] });
  sb.ctx.Config.today = () => TODAY;
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  sb.firstSync = ok(sb.ctx, 'api_syncNow');
  return sb;
}

/** A source whose applications tab has « MINITAB » below the other applications (a second « Minitab »). */
function withDuplicate() {
  const def = source();
  addAppRow(def, 'Minitab', 'MINITAB', { 'Éditeur': 'Minitab Europe' });
  return synced(def);
}

function sourceSheet(env, tab) {
  return env.SpreadsheetApp.openById(SOURCE_ID).getSheetByName(tab);
}

function sourceGrid(env, tab) {
  return sourceSheet(env, tab).getDataRange().getDisplayValues();
}

/** Every cell of both source tabs (formulas included) and of the data tabs: to prove nothing was written. */
function everything(sb) {
  const dataId = sb.ctx.Config.get().dataId;
  const out = {};
  for (const tab of [POSTES_TAB, APPS_TAB]) {
    const sh = sourceSheet(sb.env, tab);
    out['source/' + tab] = { rows: sh.getMaxRows(), values: sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).getValues() };
  }
  for (const tab of ['Postes', 'Applications', 'Actions']) out['data/' + tab] = sheetValues(sb.env, dataId, tab);
  return JSON.stringify(out);
}

function monthApps(ctx) {
  return ok(ctx, 'api_getMonthData', { month: LIVE }).applications;
}

function byName(list, key, name) {
  return list.find((r) => r[key] === name);
}

// ------------------------------------------------------------------------------- duplicate keys

test('duplicate names in the source: the sync keeps both records and warns about them', () => {
  const sb = withDuplicate();
  const apps = monthApps(sb.ctx);
  assert.deepEqual(apps.filter((a) => a[KEY_APP].toLowerCase() === 'minitab').map((a) => [a[KEY_APP], a['Éditeur']]),
    [['Minitab', 'Minitab LLC'], ['MINITAB', 'Minitab Europe']]);
  const warning = 'Noms en double dans l’onglet « Suivi des applications » : « Minitab » (2 lignes). Ces lignes ne peuvent ' +
    'être ni modifiées ni supprimées depuis l’application tant que les doublons ne sont pas corrigés dans le Google Sheet source.';
  assert.ok(sb.firstSync.result.warnings.includes(warning), JSON.stringify(sb.firstSync.result.warnings));
  assert.ok(ok(sb.ctx, 'api_getMonthData', { month: LIVE }).importInfo.warnings.includes(warning));
  // No duplicates, no warning.
  const clean = synced(source());
  assert.equal(clean.firstSync.result.warnings.filter((w) => /double/.test(w)).length, 0);
});

test('duplicate names in the source: edits, renames and deletes of either record are refused, nothing written', () => {
  const sb = withDuplicate();
  const apps = monthApps(sb.ctx);
  const before = everything(sb);
  for (const name of ['Minitab', 'MINITAB']) {
    const rec = byName(apps, KEY_APP, name);
    let e = fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: rec._id, updates: { Commentaires: 'Vu' } }] },
      'SOURCE_ERROR', undefined);
    assert.equal(e.message, '« ' + name + ' » apparaît 2 fois dans l’onglet « Suivi des applications » du Google Sheet source : ' +
      'corrigez d’abord les doublons dans le Google Sheet, puis synchronisez.');
    e = fail(sb.ctx, 'api_renameApplication', { month: LIVE, id: rec._id, newName: name + ' 2' }, 'SOURCE_ERROR', undefined);
    assert.match(e.message, /apparaît 2 fois/);
    e = fail(sb.ctx, 'api_deleteApplication', { month: LIVE, id: rec._id }, 'SOURCE_ERROR', undefined);
    assert.match(e.message, /apparaît 2 fois/);
  }
  // An edit batch that also touches a record with a unique name: refused as a whole, before any write.
  fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [
    { id: byName(apps, KEY_APP, 'Figma')._id, updates: { Commentaires: 'Vu' } },
    { id: byName(apps, KEY_APP, 'MINITAB')._id, updates: { Commentaires: 'Vu' } }] }, 'SOURCE_ERROR', undefined);
  assert.equal(everything(sb), before, 'the source and the snapshot are untouched');

  // The other records are written back as usual; a past month (snapshot only) is not concerned.
  ok(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: byName(apps, KEY_APP, 'Figma')._id, updates: { Commentaires: 'Vu' } }] });
  const k = sourceGrid(sb.env, APPS_TAB)[1].indexOf(KEY_APP);
  assert.deepEqual(sourceGrid(sb.env, APPS_TAB).filter((r) => /^minitab$/i.test(r[k])).map((r) => r[k]), ['Minitab', 'MINITAB']);
});

test('duplicate names: once fixed in the source and synchronised, the record is editable again', () => {
  const sb = withDuplicate();
  const grid = sourceGrid(sb.env, APPS_TAB);
  const k = grid[1].indexOf(KEY_APP);
  sourceSheet(sb.env, APPS_TAB).getRange(grid.findIndex((r) => r[k] === 'MINITAB') + 1, k + 1).setValue('Minitab Europe');
  const res = ok(sb.ctx, 'api_syncNow');
  assert.equal(res.result.warnings.filter((w) => /double/.test(w)).length, 0);
  const rec = byName(monthApps(sb.ctx), KEY_APP, 'Minitab');
  ok(sb.ctx, 'api_deleteApplication', { month: LIVE, id: rec._id });
  assert.deepEqual(sourceGrid(sb.env, APPS_TAB).filter((r) => /^minitab/i.test(r[k])).map((r) => r[k]), ['Minitab Europe']);
});

test('the sync sees a change to the second record of a duplicate name; reordering them is no change', () => {
  const sb = withDuplicate();
  const grid = sourceGrid(sb.env, APPS_TAB);
  const k = grid[1].indexOf(KEY_APP);
  const editor = grid[1].indexOf('Éditeur');
  const second = grid.findIndex((r) => r[k] === 'MINITAB') + 1;
  sourceSheet(sb.env, APPS_TAB).getRange(second, editor + 1).setValue('Minitab GmbH');
  let res = ok(sb.ctx, 'api_syncNow');
  assert.equal(res.result.changed, true);
  assert.deepEqual(plain(res.result.changes.applications), { added: 0, removed: 0, changed: 1, values: 1 });
  assert.equal(byName(monthApps(sb.ctx), KEY_APP, 'MINITAB')['Éditeur'], 'Minitab GmbH');

  // A third « minitab » row is one record added; the two rows swapped back and forth are no change.
  const sheet = sourceSheet(sb.env, APPS_TAB);
  const width = grid[1].length;
  const first = grid.findIndex((r) => r[k] === 'Minitab') + 1;
  const rowA = sheet.getRange(first, 1, 1, width).getValues();
  const rowB = sheet.getRange(second, 1, 1, width).getValues();
  sheet.getRange(first, 1, 1, width).setValues(rowB);
  sheet.getRange(second, 1, 1, width).setValues(rowA);
  res = ok(sb.ctx, 'api_syncNow');
  assert.deepEqual(plain(res.result.changes.applications), { added: 0, removed: 0, changed: 0, values: 0 });
  sheet.getRange(second + 1, 1, 1, width).setValues(rowA.map((r) => r.map((v, c) => (c === k ? 'minitab' : v))));
  res = ok(sb.ctx, 'api_syncNow');
  assert.deepEqual(plain(res.result.changes.applications), { added: 1, removed: 0, changed: 0, values: 0 });
  assert.match(res.result.warnings.join(' '), /« MINITAB » \(3 lignes\)/);
});

test('rename: a name another source row has (not synchronised yet) is refused; a case change of the same row is not', () => {
  const sb = synced(source());
  // « Canva » typed into the source after the last sync: the snapshot does not know it.
  const grid = sourceGrid(sb.env, APPS_TAB);
  const k = grid[1].indexOf(KEY_APP);
  const at = grid.reduce((last, r, i) => (i > 1 && r[k] ? i : last), 0) + 2;
  sourceSheet(sb.env, APPS_TAB).getRange(at, k + 1).setValue('Canva');
  const figma = byName(monthApps(sb.ctx), KEY_APP, 'Figma');
  const before = everything(sb);
  const e = fail(sb.ctx, 'api_renameApplication', { month: LIVE, id: figma._id, newName: 'canva ' }, 'VALIDATION', KEY_APP);
  assert.equal(e.message, '« canva » existe déjà dans l’onglet « Suivi des applications » du Google Sheet source.');
  assert.equal(everything(sb), before, 'nothing written');
  // Already in the snapshot: refused there first, as before.
  fail(sb.ctx, 'api_renameApplication', { month: LIVE, id: figma._id, newName: 'LABVIEW' }, 'VALIDATION', KEY_APP);

  const ren = ok(sb.ctx, 'api_renameApplication', { month: LIVE, id: figma._id, newName: 'FIGMA' });
  assert.equal(ren.record[KEY_APP], 'FIGMA');
  assert.ok(sourceGrid(sb.env, APPS_TAB).some((r) => r[k] === 'FIGMA'));
});

// ------------------------------------------------------------------------------- array formulas

/**
 * Form source (formulas, the array columns « Ancienneté » of the postes — formula in the first data row —
 * and « Doublon » of the applications — formula in the header cell), plus an applications column « Rang »
 * whose ARRAYFORMULA sits in the first data row (Minitab's).
 */
function withArrayFormulas() {
  const def = source({ form: true });
  const tab = def.sheets[APPS_TAB];
  const rang = tab.values[1].length;
  const last = lastRecordRow(tab, KEY_APP);
  tab.values.forEach((row, r) => {
    row[rang] = r === 1 ? 'Rang' : '';
    tab.display[r][rang] = r === 1 ? 'Rang' : (r > 1 && r <= last ? String(r - 1) : '');
  });
  tab.values[2][rang] = '=ARRAYFORMULA(IF(B3:B="","",ROW(B3:B)-2))';
  return synced(def);
}

test('array-formula columns: an inline edit of a spilled cell is refused like a formula cell, nothing written', () => {
  const sb = withArrayFormulas();
  const md = ok(sb.ctx, 'api_getMonthData', { month: LIVE });
  const cha = byName(md.postes, KEY_POSTE, 'LAB-CHA-01');
  const before = everything(sb);
  // « Ancienneté »: ARRAYFORMULA in the first data row, LAB-CHA-01's cell is a spilled value (no formula).
  const sheet = sourceSheet(sb.env, POSTES_TAB);
  const grid = sourceGrid(sb.env, POSTES_TAB);
  const age = grid[1].indexOf('Ancienneté');
  const chaRow = grid.findIndex((r) => r.includes('LAB-CHA-01')) + 1;
  assert.equal(sheet.getRange(chaRow, age + 1).getFormula(), '', 'a spilled cell holds no formula');
  let e = fail(sb.ctx, 'api_savePostes', { month: LIVE, changes: [{ id: cha._id, updates: { Responsable: 'Zoé', 'Ancienneté': '3' } }] },
    'VALIDATION', 'Ancienneté');
  assert.equal(e.message, 'La colonne « Ancienneté » est calculée par une formule dans le Google Sheet source : modifiez-la là-bas.');
  // « Doublon »: ={"Doublon"; ARRAYFORMULA(…)} in the header cell. « Rang »: ARRAYFORMULA in Minitab's row.
  const figma = byName(md.applications, KEY_APP, 'Figma');
  e = fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: figma._id, updates: { Doublon: 'FAUX' } }] }, 'VALIDATION', 'Doublon');
  assert.match(e.message, /calculée par une formule/);
  fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: figma._id, updates: { Rang: '1' } }] }, 'VALIDATION', 'Rang');
  assert.equal(everything(sb), before, 'the source and the snapshot are untouched');

  // The other columns of the same rows are written as before.
  ok(sb.ctx, 'api_savePostes', { month: LIVE, changes: [{ id: cha._id, updates: { Responsable: 'Zoé' } }] });
  assert.equal(sourceGrid(sb.env, POSTES_TAB)[chaRow - 1][grid[1].indexOf('Responsable')], 'Zoé');
  ok(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: byName(md.applications, KEY_APP, 'Minitab')._id,
    updates: { Commentaires: 'Vu' } }] });
  assert.equal(sheet.getRange(2 + 1, age + 1).getFormula().slice(0, 13), '=ARRAYFORMULA', 'the anchor is intact');
});

test('the source row holding an array formula cannot be deleted from the app; the other rows can', () => {
  const sb = withArrayFormulas();
  const apps = monthApps(sb.ctx);
  const before = everything(sb);
  const e = fail(sb.ctx, 'api_deleteApplication', { month: LIVE, id: byName(apps, KEY_APP, 'Minitab')._id }, 'VALIDATION', undefined);
  assert.equal(e.message, 'La ligne de « Minitab » contient la formule qui calcule la colonne « Rang » de tout l’onglet ' +
    '« Suivi des applications » : déplacez la formule puis supprimez la ligne dans le Google Sheet source.');
  assert.equal(everything(sb), before, 'the source and the snapshot are untouched');
  assert.ok(byName(monthApps(sb.ctx), KEY_APP, 'Minitab'));

  ok(sb.ctx, 'api_deleteApplication', { month: LIVE, id: byName(apps, KEY_APP, 'LabVIEW')._id });
  const grid = sourceGrid(sb.env, APPS_TAB);
  const k = grid[1].indexOf(KEY_APP);
  assert.equal(grid.some((r) => r[k] === 'LabVIEW'), false);
  assert.equal(sourceSheet(sb.env, APPS_TAB).getRange(3, grid[1].indexOf('Rang') + 1).getFormula().slice(0, 13), '=ARRAYFORMULA');
});
