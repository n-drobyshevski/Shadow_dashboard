'use strict';
/**
 * Integration tests: configuration + monthly import (src/Importer.js through the api_* envelope),
 * running every src/*.js in the GAS sandbox over the in-memory fakes.
 *
 * The live source evolves like the real sheet: the sandbox starts with the 2026-04 content, then
 * the same spreadsheet id is swapped to the 2026-05 content before importing the next month.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas, plain } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');
const data = require('../fixtures/data');

const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const SOURCE_URL = 'https://docs.google.com/spreadsheets/d/' + SOURCE_ID + '/edit#gid=0';
const GHOST_WARNINGS = [
  '1 ligne(s) sans « Nom du poste » ignorée(s)',
  '1 ligne(s) sans « Nom du logiciel / service » ignorée(s)',
];

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

/** Calls an api_* function and checks the envelope invariants. */
function call(ctx, name, args) {
  const out = ctx[name](args === undefined ? 'null' : JSON.stringify(args));
  assert.equal(typeof out, 'string', name + ' must return a string');
  const res = JSON.parse(out);
  assert.equal(typeof res.ok, 'boolean', name + ' envelope');
  if (!res.ok) {
    assert.equal(typeof res.error.code, 'string');
    assert.doesNotMatch(res.error.message, /\n\s+at /, 'stack leaked by ' + name);
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

/** Replaces the live source content (same id) with another fixture month / definition. */
function swapSource(env, monthOrDef) {
  env.__addSpreadsheet(typeof monthOrDef === 'string' ? source(monthOrDef) : monthOrDef);
}

/** Sandbox configured on the fixture source (2026-04 content). */
function configured(opts) {
  const sb = loadGas(Object.assign({ sources: [source('2026-04')] }, opts || {}));
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_URL });
  return sb;
}

function byName(list, key, name) {
  return list.find((r) => r[key] === name);
}

/** Galink / IDP edits for a month, as the app user would make them. */
function setCustomFields(ctx, month, values) {
  const apps = ok(ctx, 'api_getMonthData', { month }).applications;
  const changes = Object.entries(values).map(([name, upd]) => ({ id: byName(apps, KEY_APP, name)._id, updates: upd }));
  return ok(ctx, 'api_saveApplications', { month, changes });
}

// ---------------------------------------------------------------------------- configuration

test('bootstrap before configuration: creates the data spreadsheet, configured=false', () => {
  const { ctx, env } = loadGas({ sources: [source('2026-04')] });
  const d = ok(ctx, 'api_bootstrap');
  assert.equal(d.configured, false);
  assert.deepEqual(d.months, []);
  assert.equal(d.latestMonth, '');
  assert.match(d.currentMonth, /^\d{4}-(0[1-9]|1[0-2])$/);
  assert.equal(d.currentMonth, ctx.Config.today().slice(0, 7));
  assert.equal(d.sourceUrl, '');
  assert.equal(d.sourceTitle, '');
  const dataId = ctx.Config.get().dataId;
  assert.ok(dataId, 'data spreadsheet id saved');
  assert.equal(d.dataUrl, 'https://docs.google.com/spreadsheets/d/' + dataId + '/edit');
  const ss = env.SpreadsheetApp.openById(dataId);
  assert.equal(ss.getName(), 'ShadowIT_AppData');
  assert.deepEqual(ss.getSheets().map((s) => s.getName()).sort(),
    ['Actions', 'Applications', 'ImportLog', 'Meta', 'Postes', 'Referentiel', 'Replacements']);
  // The first-run creation is a write: it ran under the lock.
  assert.equal(env.__state.lock.acquired, 1);
  assert.equal(env.__state.lock.released, 1);
  // Idempotent: same spreadsheet on the next call.
  assert.equal(ok(ctx, 'api_bootstrap').dataUrl, d.dataUrl);
  assert.equal(env.__state.calls.create, 1);
});

test('import before configuration -> NOT_CONFIGURED', () => {
  const { ctx } = loadGas({ sources: [source('2026-04')] });
  const e = fail(ctx, 'api_importMonth', { month: '2026-04' }, 'NOT_CONFIGURED');
  assert.match(e.message, /classeur source/);
});

test('setConfig accepts a full URL or a bare id and reports the tabs found', () => {
  const { ctx } = loadGas({ sources: [source('2026-04')] });
  const d = ok(ctx, 'api_setConfig', { source: SOURCE_URL });
  assert.equal(d.sync.enabled, true, 'saving a source creates the hourly trigger');
  delete d.sync;
  assert.deepEqual(d, {
    sourceId: SOURCE_ID,
    sourceTitle: 'ShadowIT_Industry',
    sourceUrl: 'https://docs.google.com/spreadsheets/d/' + SOURCE_ID + '/edit',
    tabsFound: { postes: true, applications: true, referentiel: true },
  });
  assert.equal(ctx.Config.get().sourceId, SOURCE_ID);
  assert.equal(ok(ctx, 'api_setConfig', { source: '  ' + SOURCE_ID + ' ' }).sourceId, SOURCE_ID);

  const b = ok(ctx, 'api_bootstrap');
  assert.equal(b.configured, true);
  assert.equal(b.sourceTitle, 'ShadowIT_Industry');
  assert.equal(b.sourceUrl, d.sourceUrl);
});

test('setConfig errors: VALIDATION for a bad id, SOURCE_ERROR when unopenable or without tabs; nothing saved', () => {
  const noTabs = { id: '1NoTabsSpreadsheetId_0123456789abcdef', name: 'Autre classeur', sheets: { Feuille1: { values: [['x']] } } };
  const { ctx } = loadGas({ sources: [source('2026-04'), noTabs] });
  fail(ctx, 'api_setConfig', { source: 'pas une url' }, 'VALIDATION');
  fail(ctx, 'api_setConfig', { source: 'https://example.com/spreadsheets/d/abc/edit' }, 'VALIDATION');
  fail(ctx, 'api_setConfig', {}, 'VALIDATION');
  fail(ctx, 'api_setConfig', { source: 42 }, 'VALIDATION');
  const e1 = fail(ctx, 'api_setConfig', { source: '1UnknownSpreadsheetId_0123456789abcdef' }, 'SOURCE_ERROR');
  assert.match(e1.message, /Impossible d’ouvrir/);
  const e2 = fail(ctx, 'api_setConfig', { source: noTabs.id }, 'SOURCE_ERROR');
  assert.match(e2.message, /Suivi des postes/);
  assert.equal(ctx.Config.get().sourceId, '', 'nothing saved on failure');

  ok(ctx, 'api_setConfig', { source: SOURCE_ID });
  fail(ctx, 'api_setConfig', { source: noTabs.id }, 'SOURCE_ERROR');
  assert.equal(ctx.Config.get().sourceId, SOURCE_ID, 'previous source kept on failure');
});

test('setConfig: tabs are matched with normKey and a missing Référentiel is reported', () => {
  const def = source('2026-04');
  def.sheets = {
    ' suivi des POSTES ': def.sheets['Suivi des postes'],
    'Suivi des applications': def.sheets['Suivi des applications'],
  };
  const { ctx } = loadGas({ sources: [def] });
  assert.deepEqual(ok(ctx, 'api_setConfig', { source: SOURCE_ID }).tabsFound,
    { postes: true, applications: true, referentiel: false });
});

// ----------------------------------------------------------------------------------- import

test('import 2026-04: counts, ghost-row warnings, log entry, months', () => {
  const { ctx, env } = configured();
  const d = ok(ctx, 'api_importMonth', { month: '2026-04' });
  assert.deepEqual(d, {
    month: '2026-04',
    counts: { postes: 6, applications: 5, referentiel: Object.keys(data.REFERENTIEL).length },
    overwritten: false,
    carriedOver: 0,
    warnings: GHOST_WARNINGS,
    changed: true,
    changes: { created: true, postes: { added: 6, removed: 0, changed: 0, values: 0 },
      applications: { added: 5, removed: 0, changed: 0, values: 0 }, referentiel: true },
  });

  const log = ok(ctx, 'api_getImportLog');
  assert.equal(log.length, 1);
  assert.deepEqual(Object.keys(log[0]), ['month', 'imported_at', 'counts', 'warnings', 'changes'], 'the journal fields only');
  assert.equal(log[0].month, '2026-04');
  assert.match(log[0].imported_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.deepEqual(log[0].counts, d.counts);
  assert.deepEqual(log[0].warnings, GHOST_WARNINGS);
  // The stored entry also keeps the source id and the headers (columns order of api_getMonthData).
  const stored = plain(ctx.Store.getImportLog());
  assert.equal(stored[0].source_id, SOURCE_ID);
  assert.deepEqual(stored[0].postes_headers, data.POSTES_HEADERS);
  assert.deepEqual(stored[0].apps_headers, data.APPS_HEADERS);

  const b = ok(ctx, 'api_bootstrap');
  assert.deepEqual(b.months, ['2026-04']);
  assert.equal(b.latestMonth, '2026-04');

  // Every write of the import ran under the lock and never produced a formula.
  assert.equal(env.__state.lock.acquired, env.__state.lock.released);
  assert.deepEqual(env.__state.formulas, []);
});

test('import reads each source tab with one getDataRange()', () => {
  const { ctx, env } = configured();
  ok(ctx, 'api_bootstrap');
  const before = env.__state.calls.getDataRange || 0;
  const beforeDisp = env.__state.calls.getDisplayValues || 0;
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  // 3 source tabs read once each (display values), the rest are data-spreadsheet reads.
  assert.equal((env.__state.calls.getDisplayValues || 0) - beforeDisp, 3);
  assert.ok((env.__state.calls.getDataRange || 0) - before >= 3);
});

test('import 2026-05 after the source evolved; MONTH_EXISTS then overwrite', () => {
  const { ctx, env } = configured();
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  swapSource(env, '2026-05');
  const d = ok(ctx, 'api_importMonth', { month: '2026-05' });
  assert.equal(d.overwritten, false);
  assert.deepEqual(d.counts, { postes: 7, applications: 5, referentiel: 8 });
  assert.deepEqual(ok(ctx, 'api_bootstrap').months, ['2026-04', '2026-05']);

  const e = fail(ctx, 'api_importMonth', { month: '2026-05' }, 'MONTH_EXISTS');
  assert.match(e.message, /2026-05/);
  fail(ctx, 'api_importMonth', { month: '2026-05', overwrite: 'true' }, 'MONTH_EXISTS'); // strict boolean

  const before = ok(ctx, 'api_getMonthData', { month: '2026-05' });
  const again = ok(ctx, 'api_importMonth', { month: '2026-05', overwrite: true });
  assert.equal(again.overwritten, true);
  assert.deepEqual(again.counts, d.counts);
  const after = ok(ctx, 'api_getMonthData', { month: '2026-05' });
  assert.deepEqual(after.postes.map((r) => r._id), before.postes.map((r) => r._id), 'ids kept on overwrite');
  assert.deepEqual(after.applications.map((r) => r._id), before.applications.map((r) => r._id));

  // The other month is untouched by the overwrite.
  const april = ok(ctx, 'api_getMonthData', { month: '2026-04' });
  assert.deepEqual(april.postes.map((r) => r[KEY_POSTE]), data.MONTHS['2026-04'].postes.map((r) => r[KEY_POSTE]));

  const log = ok(ctx, 'api_getImportLog');
  assert.deepEqual(log.map((l) => l.month), ['2026-05', '2026-05', '2026-04'], 'newest first');
});

test('import validation: bad month, and SOURCE_ERROR when the source loses both entity tabs', () => {
  const { ctx, env } = configured();
  fail(ctx, 'api_importMonth', { month: '2026-13' }, 'VALIDATION');
  fail(ctx, 'api_importMonth', { month: '202604' }, 'VALIDATION');
  fail(ctx, 'api_importMonth', {}, 'VALIDATION');
  const def = source('2026-04');
  delete def.sheets['Suivi des postes'];
  delete def.sheets['Suivi des applications'];
  swapSource(env, def);
  fail(ctx, 'api_importMonth', { month: '2026-04' }, 'SOURCE_ERROR');
  assert.deepEqual(ok(ctx, 'api_bootstrap').months, [], 'nothing written');
  assert.equal(env.__state.lock.held, false, 'lock released after an error');
});

test('import: missing Référentiel / applications tab -> warnings and empty data', () => {
  const { ctx, env } = configured();
  const def = source('2026-04');
  delete def.sheets['Référentiel'];
  delete def.sheets['Suivi des applications'];
  swapSource(env, def);
  const d = ok(ctx, 'api_importMonth', { month: '2026-04' });
  assert.deepEqual(d.counts, { postes: 6, applications: 0, referentiel: 0 });
  assert.ok(d.warnings.some((w) => /Référentiel/.test(w)));
  assert.ok(d.warnings.some((w) => /Suivi des applications/.test(w)));
  const m = ok(ctx, 'api_getMonthData', { month: '2026-04' });
  assert.deepEqual(m.referentiel, {});
  assert.deepEqual(m.applications, []);
  assert.deepEqual(m.columns.applications, ['Galink', 'IDP']);
});

test('import: a source tab without the key header -> SOURCE_ERROR', () => {
  const { ctx, env } = configured();
  const def = source('2026-04');
  const tab = def.sheets['Suivi des postes'];
  tab.display[1] = tab.display[1].map((h) => (h === KEY_POSTE ? 'Poste' : h));
  tab.values[1] = tab.values[1].map((h) => (h === KEY_POSTE ? 'Poste' : h));
  swapSource(env, def);
  const e = fail(ctx, 'api_importMonth', { month: '2026-04' }, 'SOURCE_ERROR');
  assert.match(e.message, /Nom du poste/);
});

test('import: header normalisation, Date cells and display values', () => {
  const { ctx } = configured();
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  const m = ok(ctx, 'api_getMonthData', { month: '2026-04' });
  // 'Équipe ' (trailing space) and 'Bâtiment / Labo' (NBSP) are normalised.
  assert.deepEqual(m.columns.postes, data.POSTES_HEADERS);
  const tex1 = byName(m.postes, KEY_POSTE, 'LAB-TEX-01');
  assert.equal(tex1['Équipe'], 'Labo Textile');
  assert.equal(tex1['Bâtiment / Labo'], 'Bâtiment A');
  assert.equal(tex1['Date visite'], '12/03/2026');
  assert.equal(tex1["Date d'achat"], '15/01/2021');
  assert.equal(tex1['Score conformité'], '100%', 'display value, not the raw fraction');
  const mec = byName(m.postes, KEY_POSTE, 'LAB-MEC-01');
  assert.equal(mec['Score conformité'], '30,4%');
  assert.equal(mec._score, 30.4);
  for (const rec of m.postes.concat(m.applications)) {
    for (const [k, v] of Object.entries(rec)) {
      if (/^(Date|Date visite|Prochaine revue|Date d'achat|Deadline)$/.test(k) && v !== null) {
        assert.match(v, /^\d{2}\/\d{2}\/\d{4}$/, k + ' = ' + v);
      }
    }
  }
});

test('import: Date cells are formatted in the SOURCE spreadsheet time zone', () => {
  const tz = 'Pacific/Kiritimati'; // UTC+14: differs from the host zone for most dates
  const def = source('2026-04');
  def.timeZone = tz;
  const { ctx, env } = loadGas({ sources: [def] });
  ok(ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  const rawDate = def.sheets['Suivi des postes'].values[2][1];
  assert.ok(rawDate instanceof Date);
  const expected = env.Utilities.formatDate(rawDate, tz, 'dd/MM/yyyy');
  const m = ok(ctx, 'api_getMonthData', { month: '2026-04' });
  assert.equal(m.postes[0]['Date visite'], expected);
});

test('import: a source without a time zone (null / \'\') falls back to Europe/Paris instead of failing', () => {
  for (const tz of [null, '']) {
    const def = source('2026-04');
    def.timeZone = tz;
    const { ctx, env } = loadGas({ sources: [def] });
    ok(ctx, 'api_setConfig', { source: SOURCE_ID });
    const res = ok(ctx, 'api_importMonth', { month: '2026-04' });
    assert.ok(res.counts.postes > 0);
    const rawDate = def.sheets['Suivi des postes'].values[2][1];
    const m = ok(ctx, 'api_getMonthData', { month: '2026-04' });
    assert.equal(m.postes[0]['Date visite'], env.Utilities.formatDate(rawDate, 'Europe/Paris', 'dd/MM/yyyy'), String(tz));
  }
});

// ------------------------------------------------------------------------------- carry-over

test('Galink/IDP are carried over from the previous month and preserved on overwrite', () => {
  const { ctx, env } = configured();
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  setCustomFields(ctx, '2026-04', data.CUSTOM_FIELDS['2026-04']);

  swapSource(env, '2026-05');
  const d = ok(ctx, 'api_importMonth', { month: '2026-05' });
  // Minitab (2) + Notepad++ (2) + LabVIEW (Galink only) = 5 values copied.
  assert.equal(d.carriedOver, 5);
  let may = ok(ctx, 'api_getMonthData', { month: '2026-05' }).applications;
  const pick = (name) => { const r = byName(may, KEY_APP, name); return { Galink: r.Galink, IDP: r.IDP }; };
  assert.deepEqual(pick('Minitab'), { Galink: 'Oui', IDP: 'Oui' });
  assert.deepEqual(pick('Notepad++'), { Galink: 'Oui', IDP: 'Non' });
  assert.deepEqual(pick('LabVIEW'), { Galink: 'Non', IDP: null });
  assert.deepEqual(pick('Figma'), { Galink: null, IDP: null }, 'new app: nothing to carry');
  assert.deepEqual(pick('Dropbox perso'), { Galink: null, IDP: null });
  assert.equal(byName(may, KEY_APP, 'Minitab')._score, 100);

  // Edit the 2026-05 values, then re-import 2026-05: the month's own values win over 2026-04.
  setCustomFields(ctx, '2026-05', data.CUSTOM_FIELDS['2026-05']);
  const again = ok(ctx, 'api_importMonth', { month: '2026-05', overwrite: true });
  assert.equal(again.carriedOver, 8);
  may = ok(ctx, 'api_getMonthData', { month: '2026-05' }).applications;
  for (const [name, expected] of Object.entries(data.CUSTOM_FIELDS['2026-05'])) {
    assert.deepEqual(pick(name), expected, name);
  }
  // 2026-04 keeps its own values.
  const apr = ok(ctx, 'api_getMonthData', { month: '2026-04' }).applications;
  assert.equal(byName(apr, KEY_APP, 'Notepad++').IDP, 'Non');
});

test('carry-over matches names with normKey and skips months after the imported one', () => {
  const { ctx, env } = configured();
  swapSource(env, '2026-05');
  ok(ctx, 'api_importMonth', { month: '2026-05' });
  setCustomFields(ctx, '2026-05', { Figma: { Galink: 'Oui', IDP: 'Oui' } });
  // Importing an EARLIER month must not borrow values from a later one.
  swapSource(env, '2026-04');
  assert.equal(ok(ctx, 'api_importMonth', { month: '2026-04' }).carriedOver, 0);

  // Name differing only by case / spaces still matches.
  const def = source('2026-05');
  const tab = def.sheets['Suivi des applications'];
  const col = tab.display[1].indexOf(KEY_APP);
  const row = tab.display.findIndex((r) => r[col] === 'Figma');
  tab.display[row][col] = '  FIGMA ';
  tab.values[row][col] = '  FIGMA ';
  swapSource(env, def);
  ok(ctx, 'api_importMonth', { month: '2026-06' });
  const june = ok(ctx, 'api_getMonthData', { month: '2026-06' }).applications;
  const figma = byName(june, KEY_APP, 'FIGMA');
  assert.deepEqual(plain({ Galink: figma.Galink, IDP: figma.IDP }), { Galink: 'Oui', IDP: 'Oui' });
});

// ------------------------------------------------------------- missing tabs / partial imports

const galinkIdp = (list, name) => {
  const r = byName(list, KEY_APP, name);
  return r ? { Galink: r.Galink, IDP: r.IDP } : undefined;
};

test('overwrite with a missing entity / Référentiel tab keeps the stored snapshot of that month', () => {
  const { ctx, env } = configured();
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  setCustomFields(ctx, '2026-04', data.CUSTOM_FIELDS['2026-04']);
  const before = ok(ctx, 'api_getMonthData', { month: '2026-04' });

  const noApps = source('2026-04');
  delete noApps.sheets['Suivi des applications'];
  swapSource(env, noApps);
  const d = ok(ctx, 'api_importMonth', { month: '2026-04', overwrite: true });
  assert.equal(d.counts.applications, before.applications.length, 'count of the kept snapshot');
  assert.ok(d.warnings.some((w) => /Suivi des applications.*conservées/.test(w)), d.warnings.join(' | '));
  let after = ok(ctx, 'api_getMonthData', { month: '2026-04' });
  assert.deepEqual(after.applications, before.applications, 'applications + Galink/IDP untouched');
  assert.deepEqual(after.columns.applications, before.columns.applications, 'headers kept from the previous import');
  assert.deepEqual(galinkIdp(after.applications, 'Minitab'), { Galink: 'Oui', IDP: 'Oui' });

  const noPostesNoRef = source('2026-04');
  delete noPostesNoRef.sheets['Suivi des postes'];
  delete noPostesNoRef.sheets['Référentiel'];
  swapSource(env, noPostesNoRef);
  const d2 = ok(ctx, 'api_importMonth', { month: '2026-04', overwrite: true });
  assert.equal(d2.counts.postes, before.postes.length);
  assert.equal(d2.counts.referentiel, Object.keys(before.referentiel).length);
  assert.ok(d2.warnings.some((w) => /Suivi des postes.*conservés/.test(w)));
  assert.ok(d2.warnings.some((w) => /Référentiel.*conservé/.test(w)));
  after = ok(ctx, 'api_getMonthData', { month: '2026-04' });
  assert.deepEqual(after.postes, before.postes);
  assert.deepEqual(after.referentiel, before.referentiel);
  assert.deepEqual(after.columns.postes, before.columns.postes);
  assert.deepEqual(galinkIdp(after.applications, 'Notepad++'), { Galink: 'Oui', IDP: 'Non' });
});

test('a month imported without applications does not break the Galink/IDP carry-over chain', () => {
  const { ctx, env } = configured();
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  setCustomFields(ctx, '2026-04', data.CUSTOM_FIELDS['2026-04']);

  const noApps = source('2026-05');
  delete noApps.sheets['Suivi des applications'];
  swapSource(env, noApps);
  const may = ok(ctx, 'api_importMonth', { month: '2026-05' });
  assert.equal(may.counts.applications, 0);
  assert.ok(may.warnings.some((w) => /aucune application importée/.test(w)));

  swapSource(env, '2026-05');
  const june = ok(ctx, 'api_importMonth', { month: '2026-06' });
  assert.equal(june.carriedOver, 5, 'carried from 2026-04, the latest month that has applications');
  const apps = ok(ctx, 'api_getMonthData', { month: '2026-06' }).applications;
  assert.deepEqual(galinkIdp(apps, 'Minitab'), { Galink: 'Oui', IDP: 'Oui' });
  assert.deepEqual(galinkIdp(apps, 'LabVIEW'), { Galink: 'Non', IDP: null });

  // Re-importing the empty month once the tab is back also recovers the values.
  const again = ok(ctx, 'api_importMonth', { month: '2026-05', overwrite: true });
  assert.equal(again.carriedOver, 5);
  assert.deepEqual(galinkIdp(ok(ctx, 'api_getMonthData', { month: '2026-05' }).applications, 'Notepad++'),
    { Galink: 'Oui', IDP: 'Non' });
});

test('import writes Applications first: a failing Applications write leaves no trace of the month', () => {
  const { ctx, env } = configured();
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  setCustomFields(ctx, '2026-04', data.CUSTOM_FIELDS['2026-04']);
  swapSource(env, '2026-05');
  env.__fault({ method: 'setValues', sheet: 'Applications' });
  fail(ctx, 'api_importMonth', { month: '2026-05' }, 'INTERNAL');
  assert.equal(env.__state.lock.held, false);
  assert.deepEqual(ok(ctx, 'api_bootstrap').months, ['2026-04'], 'nothing written for 2026-05');
  // A plain retry (no overwrite needed) carries Galink/IDP from 2026-04.
  assert.equal(ok(ctx, 'api_importMonth', { month: '2026-05' }).carriedOver, 5);
});

test('overwrite after an import that failed half-way still carries Galink/IDP from the previous month', () => {
  const { ctx, env } = configured();
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  setCustomFields(ctx, '2026-04', data.CUSTOM_FIELDS['2026-04']);
  swapSource(env, '2026-05');
  env.__fault({ method: 'setValues', sheet: 'Postes' });
  fail(ctx, 'api_importMonth', { month: '2026-05' }, 'INTERNAL');
  assert.deepEqual(ok(ctx, 'api_bootstrap').months, ['2026-04', '2026-05'], 'Applications were written');
  assert.equal(ok(ctx, 'api_getImportLog').filter((l) => l.month === '2026-05').length, 0, 'no completion marker');

  fail(ctx, 'api_importMonth', { month: '2026-05' }, 'MONTH_EXISTS');
  const d = ok(ctx, 'api_importMonth', { month: '2026-05', overwrite: true });
  assert.equal(d.counts.postes, 7);
  assert.ok(d.carriedOver >= 5);
  assert.ok(d.warnings.some((w) => /incomplet.*2026-04/.test(w)), d.warnings.join(' | '));
  const apps = ok(ctx, 'api_getMonthData', { month: '2026-05' }).applications;
  assert.deepEqual(galinkIdp(apps, 'Minitab'), { Galink: 'Oui', IDP: 'Oui' });
  assert.deepEqual(galinkIdp(apps, 'Notepad++'), { Galink: 'Oui', IDP: 'Non' });
});

test('overwrite of a month left with Postes only (no applications, no log) carries from the previous month', () => {
  const { ctx, env } = configured();
  ok(ctx, 'api_importMonth', { month: '2026-04' });
  setCustomFields(ctx, '2026-04', data.CUSTOM_FIELDS['2026-04']);
  // State left by an interrupted import: Postes rows for 2026-05, nothing else.
  ctx.Store.withLock(() => ctx.Store.replaceEntityMonth('Postes', '2026-05', [{ [KEY_POSTE]: 'LAB-TEX-01' }], KEY_POSTE));
  swapSource(env, '2026-05');
  fail(ctx, 'api_importMonth', { month: '2026-05' }, 'MONTH_EXISTS');
  const d = ok(ctx, 'api_importMonth', { month: '2026-05', overwrite: true });
  assert.equal(d.carriedOver, 5);
  assert.ok(d.warnings.some((w) => /incomplet/.test(w)));
  const apps = ok(ctx, 'api_getMonthData', { month: '2026-05' }).applications;
  assert.deepEqual(galinkIdp(apps, 'Minitab'), { Galink: 'Oui', IDP: 'Oui' });
  assert.deepEqual(galinkIdp(apps, 'LabVIEW'), { Galink: 'Non', IDP: null });

  // A complete month's own values still win on a later overwrite (no fallback to 2026-04).
  setCustomFields(ctx, '2026-05', { Minitab: { Galink: 'Non', IDP: 'Non' } });
  const again = ok(ctx, 'api_importMonth', { month: '2026-05', overwrite: true });
  assert.ok(!again.warnings.some((w) => /incomplet/.test(w)));
  assert.deepEqual(galinkIdp(ok(ctx, 'api_getMonthData', { month: '2026-05' }).applications, 'Minitab'),
    { Galink: 'Non', IDP: 'Non' });
});
