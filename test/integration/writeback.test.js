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

// ------------------------------------------------------------------------------- review follow-ups

/** Sets `header` of the application `name` in a source definition (display = raw value). */
function setAppCell(def, name, header, value) {
  const tab = def.sheets[APPS_TAB];
  const headers = tab.display[1].map((h) => h.trim());
  const k = headers.indexOf(KEY_APP);
  const r = tab.display.findIndex((row) => row[k] === name);
  tab.values[r][headers.indexOf(header)] = tab.display[r][headers.indexOf(header)] = value;
}

/** Adds a column `header` to the applications tab of a source definition (values by record name, else ''). */
function addAppColumn(def, header, byRecord) {
  const tab = def.sheets[APPS_TAB];
  const k = tab.display[1].map((h) => h.trim()).indexOf(KEY_APP);
  const last = lastRecordRow(tab, KEY_APP);
  for (const grid of [tab.values, tab.display]) {
    grid.forEach((row, r) => {
      const name = tab.display[r][k];
      row.push(r === 1 ? header : (r > 1 && r <= last && byRecord && name in byRecord ? byRecord[name] : ''));
    });
  }
}

test('Galink / IDP (no source column) of a name the source holds twice are saved: the source row is not looked up', () => {
  const sb = withDuplicate();
  const apps = monthApps(sb.ctx);
  const source = JSON.stringify([sourceGrid(sb.env, APPS_TAB), sourceGrid(sb.env, POSTES_TAB)]);
  const minitab = byName(apps, KEY_APP, 'MINITAB');
  const saved = ok(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: minitab._id, updates: { Galink: 'Non', IDP: 'Oui' } }] });
  assert.equal(saved.sourceUpdated, true);
  assert.deepEqual([saved.updated[0].Galink, saved.updated[0].IDP], ['Non', 'Oui']);
  // A batch with another record's source edit goes through as a whole.
  ok(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [
    { id: byName(apps, KEY_APP, 'Minitab')._id, updates: { Galink: 'Non' } },
    { id: byName(apps, KEY_APP, 'Figma')._id, updates: { Commentaires: 'Vu' } }] });
  const k = sourceGrid(sb.env, APPS_TAB)[1].indexOf(KEY_APP);
  assert.equal(byName(monthApps(sb.ctx), KEY_APP, 'Minitab').Galink, 'Non');
  assert.equal(sourceGrid(sb.env, APPS_TAB).find((r) => r[k] === 'Figma')[sourceGrid(sb.env, APPS_TAB)[1].indexOf('Commentaires')], 'Vu');
  const after = JSON.parse(source);
  after[0].find((r) => r[k] === 'Figma')[after[0][1].indexOf('Commentaires')] = 'Vu';
  assert.equal(JSON.stringify([sourceGrid(sb.env, APPS_TAB), sourceGrid(sb.env, POSTES_TAB)]), JSON.stringify(after),
    'only Figma\'s cell was written');
  // A source field of a duplicated name is still refused.
  fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: minitab._id, updates: { Galink: 'Oui', Commentaires: 'x' } }] },
    'SOURCE_ERROR', undefined);
});

test('duplicates left in the snapshot only (one row removed from the source, not synchronised yet): every write-back is refused', () => {
  const sb = withDuplicate();
  const apps = monthApps(sb.ctx);
  const grid = sourceGrid(sb.env, APPS_TAB);
  const k = grid[1].indexOf(KEY_APP);
  // The owner fixes the duplicate in the Google Sheet, as the warning asks: « MINITAB » is gone from the source.
  sourceSheet(sb.env, APPS_TAB).deleteRow(grid.findIndex((r) => r[k] === 'MINITAB') + 1);
  const before = everything(sb);
  const msg = (name) => '« ' + name + ' » apparaît 2 fois dans les données synchronisées (onglet « Suivi des applications ») : ' +
    'corrigez les doublons dans le Google Sheet source, synchronisez, puis réessayez.';
  for (const name of ['MINITAB', 'Minitab']) {
    const rec = byName(apps, KEY_APP, name);
    // Each of these would otherwise hit the remaining « Minitab » row, whichever record was meant.
    let e = fail(sb.ctx, 'api_deleteApplication', { month: LIVE, id: rec._id }, 'SOURCE_ERROR', undefined);
    assert.equal(e.message, msg(name));
    e = fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: rec._id, updates: { Commentaires: 'Vu' } }] },
      'SOURCE_ERROR', undefined);
    assert.equal(e.message, msg(name));
    e = fail(sb.ctx, 'api_renameApplication', { month: LIVE, id: rec._id, newName: 'Minitab 22' }, 'SOURCE_ERROR', undefined);
    assert.equal(e.message, msg(name));
  }
  fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [
    { id: byName(apps, KEY_APP, 'Minitab')._id, updates: { Commentaires: 'A' } },
    { id: byName(apps, KEY_APP, 'MINITAB')._id, updates: { Commentaires: 'B' } }] }, 'SOURCE_ERROR', undefined);
  assert.equal(everything(sb), before, 'the source and the snapshot are untouched');
  assert.deepEqual(sourceGrid(sb.env, APPS_TAB).filter((r) => /^minitab$/i.test(r[k])).map((r) => r[k]), ['Minitab']);

  // Once synchronised, the remaining record is written back as usual.
  ok(sb.ctx, 'api_syncNow');
  const rec = byName(monthApps(sb.ctx), KEY_APP, 'Minitab');
  ok(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: rec._id, updates: { Commentaires: 'Vu' } }] });
  assert.equal(sourceGrid(sb.env, APPS_TAB).find((r) => r[k] === 'Minitab')[grid[1].indexOf('Commentaires')], 'Vu');
});

test('a source cell longer than Core.LIMITS.cellChars (truncated in the snapshot) is never overwritten from the app', () => {
  const def = source();
  const sbProbe = loadGas();
  const max = sbProbe.ctx.Core.LIMITS.cellChars;
  const long = 'Commentaire. '.repeat(Math.ceil((max + 3000) / 13));
  setAppCell(def, 'Figma', 'Commentaires', long);
  const sb = synced(def);
  const figma = byName(monthApps(sb.ctx), KEY_APP, 'Figma');
  assert.equal(figma.Commentaires.length, max, 'truncated in the snapshot');
  const before = everything(sb);
  // The admin edits the start the app shows: refused, the source keeps its full text.
  const e = fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: figma._id,
    updates: { Commentaires: figma.Commentaires.slice(0, 100) } }] }, 'VALIDATION', 'Commentaires');
  assert.equal(e.message, '« Figma », colonne « Commentaires » : la cellule du Google Sheet source a plus de ' + max +
    ' caractères et l’application n’en a que le début : modifiez-la dans le Google Sheet source.');
  assert.equal(everything(sb), before, 'the source and the snapshot are untouched');
  const grid = sourceGrid(sb.env, APPS_TAB);
  const k = grid[1].indexOf(KEY_APP);
  assert.equal(grid.find((r) => r[k] === 'Figma')[grid[1].indexOf('Commentaires')], long);
  // Another column of the same row is written as usual.
  ok(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: figma._id, updates: { 'Éditeur': 'Figma Inc.' } }] });
  assert.equal(sourceGrid(sb.env, APPS_TAB).find((r) => r[k] === 'Figma')[grid[1].indexOf('Éditeur')], 'Figma Inc.');
});

test('spilling formulas (FILTER, SORT, open-ended ranges) in the first data row are array-formula columns too', () => {
  const def = source({ form: true });
  const tab = def.sheets[APPS_TAB];
  const k = tab.display[1].map((h) => h.trim()).indexOf(KEY_APP);
  const first = tab.display[2][k];
  addAppColumn(def, 'Filtre', {});
  addAppColumn(def, 'Tri', {});
  addAppColumn(def, 'Lambda', {});
  const w = tab.values[1].length;
  tab.values[2][w - 3] = '=FILTER(Data!C2:C, Data!A2:A<>"")';
  tab.values[2][w - 2] = '=SORT(B3:B)';
  tab.values[2][w - 1] = '=LAMBDA(x, x * 2)($B$3:$B)';
  const sb = synced(def);
  const apps = monthApps(sb.ctx);
  const other = apps.find((a) => a[KEY_APP] !== first);
  const before = everything(sb);
  for (const col of ['Filtre', 'Tri', 'Lambda']) {
    const e = fail(sb.ctx, 'api_saveApplications', { month: LIVE, changes: [{ id: other._id, updates: { [col]: 'x' } }] },
      'VALIDATION', col);
    assert.match(e.message, /calculée par une formule/);
  }
  assert.equal(everything(sb), before);
  const schema = ok(sb.ctx, 'api_getFormSchema', { entity: 'applications', month: LIVE });
  assert.deepEqual(schema.columns.filter((c) => c.arrayFormula).map((c) => c.name), ['Doublon', 'Filtre', 'Tri', 'Lambda']);
  // The row holding them cannot be deleted either.
  fail(sb.ctx, 'api_deleteApplication', { month: LIVE, id: byName(apps, KEY_APP, first)._id }, 'VALIDATION', undefined);
});

test('duplicate-names warning: names are cut at 60 characters, so the ImportLog warnings cell stays small', () => {
  const def = source();
  const names = [];
  for (let i = 0; i < 10; i++) {
    const name = String(i) + 'N'.repeat(4999);
    names.push(name);
    addAppRow(def, 'Figma', name);
    addAppRow(def, 'Figma', name.toLowerCase());
  }
  const sb = synced(def);
  const warning = sb.firstSync.result.warnings.find((w) => /^Noms en double/.test(w));
  assert.ok(warning.includes('« 0' + 'N'.repeat(59) + '… » (2 lignes)'), warning.slice(0, 300));
  assert.ok(!warning.includes('N'.repeat(61)));
  const json = JSON.stringify(sb.firstSync.result.warnings);
  assert.ok(json.length < 2000, String(json.length));
  assert.equal(JSON.stringify(ok(sb.ctx, 'api_getMonthData', { month: LIVE }).importInfo.warnings), json);
});

test('the write-back header-width limit names the tab', () => {
  const sb = synced(source());
  const sheet = sourceSheet(sb.env, POSTES_TAB);
  const width = sheet.getDataRange().getNumColumns();
  sheet.insertColumnsAfter(sheet.getMaxColumns(), width + 501 - sheet.getMaxColumns());
  sheet.getRange(2, width + 1, 1, 501).setValues([Array.from({ length: 501 }, (_, i) => 'Extra ' + i)]);
  const id = ok(sb.ctx, 'api_getMonthData', { month: LIVE }).postes[0]._id;
  const e = fail(sb.ctx, 'api_savePostes', { month: LIVE, changes: [{ id, updates: { Commentaires: 'Vu' } }] }, 'SOURCE_ERROR', undefined);
  assert.match(e.message, /^Onglet « Suivi des postes » : \d+ colonnes ont un en-tête, au plus 500 sont acceptées\./);
});

test('sync: a record named « __proto__ » and a column named « constructor » are compared like the others', () => {
  const def = source();
  addAppColumn(def, 'constructor', { Figma: 'v1' });
  addAppRow(def, 'Figma', '__proto__', { constructor: 'p1' });
  const sb = synced(def);
  assert.equal(byName(monthApps(sb.ctx), KEY_APP, '__proto__').constructor, 'p1');
  const grid = sourceGrid(sb.env, APPS_TAB);
  const k = grid[1].indexOf(KEY_APP);
  const c = grid[1].indexOf('constructor');
  const sheet = sourceSheet(sb.env, APPS_TAB);
  const rowOf = (name) => sourceGrid(sb.env, APPS_TAB).findIndex((r) => r[k] === name) + 1;
  // A change in the « constructor » column only.
  sheet.getRange(rowOf('Figma'), c + 1).setValue('v2');
  let res = ok(sb.ctx, 'api_syncNow');
  assert.equal(res.result.changed, true);
  assert.deepEqual(plain(res.result.changes.applications), { added: 0, removed: 0, changed: 1, values: 1 });
  // A change of the « __proto__ » record.
  sheet.getRange(rowOf('__proto__'), grid[1].indexOf('Éditeur') + 1).setValue('Proto Inc.');
  res = ok(sb.ctx, 'api_syncNow');
  assert.deepEqual(plain(res.result.changes.applications), { added: 0, removed: 0, changed: 1, values: 1 });
  assert.equal(byName(monthApps(sb.ctx), KEY_APP, '__proto__')['Éditeur'], 'Proto Inc.');
  // A second « __proto__ » row: one record added, and the duplicates warning names it.
  sheet.getRange(rowOf('__proto__') + 1, 1, 1, grid[1].length).setValues(sheet.getRange(rowOf('__proto__'), 1, 1, grid[1].length).getValues());
  res = ok(sb.ctx, 'api_syncNow');
  assert.deepEqual(plain(res.result.changes.applications), { added: 1, removed: 0, changed: 0, values: 0 });
  assert.match(res.result.warnings.join(' '), /« __proto__ » \(2 lignes\)/);
  // Both removed.
  sheet.deleteRow(rowOf('__proto__'));
  sheet.deleteRow(rowOf('__proto__'));
  res = ok(sb.ctx, 'api_syncNow');
  assert.deepEqual(plain(res.result.changes.applications), { added: 0, removed: 2, changed: 0, values: 0 });
});
