'use strict';
/**
 * Integration tests: the one-line JSON timing logs of src/Perf.js (docs/API.md §4, « Perf »), as
 * emitted by apiWrap_, Store, Importer (import + write-back) and Sync. The fake console captures them
 * (gasSandbox.timingLines), so they never reach the test output.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas, timingLines } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const READER = 'lea.reader@decathlon.com';

function call(ctx, name, args) {
  return JSON.parse(ctx[name](args === undefined ? 'null' : JSON.stringify(args)));
}
function ok(ctx, name, args) {
  const res = call(ctx, name, args);
  assert.equal(res.ok, true, name + ' failed: ' + JSON.stringify(res.error));
  return res.data;
}

/** Sandbox on the 2026-05 source, today = 15/05/2026, source saved and first sync done. */
function synced() {
  const sb = loadGas({ sources: [buildSourceSpreadsheet('2026-05')] });
  sb.ctx.Config.today = () => '2026-05-15';
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_syncNow');
  return sb;
}

/** A new execution over the same spreadsheets / properties (fresh module caches), today pinned. */
function nextExecution(env) {
  const sb = loadGas({ env });
  sb.ctx.Config.today = () => '2026-05-15';
  return sb;
}

/** Timing lines logged while fn runs. */
function linesDuring(env, fn) {
  const before = timingLines(env).length;
  fn();
  return timingLines(env).slice(before);
}

function isMs(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

test('apiWrap_: one {api, ms, authMs, ok} line per call, in every outcome', () => {
  const { env } = synced();
  const { ctx } = nextExecution(env);

  let lines = linesDuring(env, () => ok(ctx, 'api_bootstrap'));
  const apiLines = lines.filter((l) => 'api' in l);
  assert.equal(apiLines.length, 1);
  assert.deepEqual(Object.keys(apiLines[0]), ['api', 'ms', 'authMs', 'ok']);
  assert.equal(apiLines[0].api, 'api_bootstrap');
  assert.equal(apiLines[0].ok, true);
  assert.ok(isMs(apiLines[0].ms) && isMs(apiLines[0].authMs) && apiLines[0].authMs <= apiLines[0].ms);
  // The api line is the last one of the call (logged in finally, after the stage lines).
  assert.equal(lines[lines.length - 1], apiLines[0]);

  lines = linesDuring(env, () => assert.equal(call(ctx, 'api_getMonthData', '{').ok, false));
  assert.deepEqual(lines.filter((l) => 'api' in l).map((l) => [l.api, l.ok, l.code]), [['api_getMonthData', false, 'VALIDATION']]);

  ctx.Store.listMonths = function () { throw new TypeError('boom'); };
  lines = linesDuring(env, () => assert.equal(call(ctx, 'api_bootstrap').error.code, 'INTERNAL'));
  assert.deepEqual(lines.map((l) => [l.api, l.ok, l.code]), [['api_bootstrap', false, 'INTERNAL']]);

  // Refused caller: the role check failed, so there is no authMs.
  env.__setActiveUser('intrus@ailleurs.com');
  lines = linesDuring(env, () => assert.equal(call(ctx, 'api_getTimeline').error.code, 'FORBIDDEN'));
  assert.deepEqual(lines, [{ api: 'api_getTimeline', ms: lines[0].ms, authMs: null, ok: false, code: 'FORBIDDEN' }]);
});

test('Store: ensure, listMonths and sheet lines of a cold execution', () => {
  const { env } = synced();
  const { ctx } = nextExecution(env);
  const lines = linesDuring(env, () => ok(ctx, 'api_getMonthData', { month: '2026-05' }));

  const ensure = lines.filter((l) => l.stage === 'ensure');
  assert.equal(ensure.length, 1, 'ensure is logged once per execution');
  assert.deepEqual(Object.keys(ensure[0]), ['stage', 'ms', 'open', 'ensureTabs', 'created']);
  assert.equal(ensure[0].created, false);
  assert.ok(['ms', 'open', 'ensureTabs'].every((k) => isMs(ensure[0][k])));

  const months = lines.filter((l) => l.stage === 'listMonths');
  assert.equal(months.length, 1);
  assert.deepEqual(Object.keys(months[0]), ['stage', 'ms', 'ImportLog', 'Postes', 'Applications', 'rows', 'months']);
  assert.equal(months[0].months, 1);

  // One month is read without the other months: no full tab read, one span per tab (the ImportLog
  // span is the one row of the month's latest entry, found through column A read by listMonths).
  assert.deepEqual(lines.filter((l) => l.stage === 'sheet'), []);
  const spans = lines.filter((l) => l.stage === 'span');
  assert.deepEqual(spans.map((l) => l.tab), ['Postes', 'Applications', 'ImportLog', 'Referentiel']);
  for (const l of spans) {
    assert.deepEqual(Object.keys(l), ['stage', 'tab', 'rows', 'ms']);
    assert.ok(isMs(l.rows) && isMs(l.ms));
  }
  assert.equal(spans.find((l) => l.tab === 'Postes').rows, buildSourceSpreadsheet('2026-05').sheets['Suivi des postes']
    .values.filter((r, i) => i >= 2 && r[6]).length);
  assert.equal(spans.find((l) => l.tab === 'ImportLog').rows, 1);

  // A full tab read logs a sheet line.
  const timeline = linesDuring(env, () => ok(ctx, 'api_getTimeline'));
  const sheets = timeline.filter((l) => l.stage === 'sheet');
  assert.deepEqual(sheets.map((l) => l.tab), ['Postes', 'Applications']);
  for (const l of sheets) assert.deepEqual(Object.keys(l), ['stage', 'tab', 'rows', 'ms']);

  // A second call in the same execution does not open the spreadsheet again.
  const again = linesDuring(env, () => ok(ctx, 'api_getMonthData', { month: '2026-05' }));
  assert.equal(again.filter((l) => l.stage === 'ensure').length, 0);
});

test('Importer + Sync: import laps, a no-change run writes nothing, a failed run is ok:false', () => {
  const sb = loadGas({ sources: [buildSourceSpreadsheet('2026-05')] });
  sb.ctx.Config.today = () => '2026-05-15';
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });

  let lines = linesDuring(sb.env, () => ok(sb.ctx, 'api_syncNow'));
  let imp = lines.filter((l) => l.stage === 'importMonth');
  assert.equal(imp.length, 1);
  assert.deepEqual(Object.keys(imp[0]),
    ['stage', 'ms', 'lockWait', 'dataReads', 'readSource', 'compare', 'writes', 'flush', 'month', 'changed']);
  assert.equal(imp[0].month, '2026-05');
  assert.equal(imp[0].changed, true);
  assert.deepEqual(lines.filter((l) => l.stage === 'sourceSheet').map((l) => [l.tab, l.rows > 0]),
    [['Suivi des postes', true], ['Suivi des applications', true]]);
  let sync = lines.filter((l) => l.stage === 'sync');
  assert.deepEqual(Object.keys(sync[0]), ['stage', 'ms', 'import', 'state', 'month', 'changed', 'ok']);
  assert.deepEqual([sync[0].changed, sync[0].ok], [true, true]);
  // Order: the stages end before the api line of the call.
  assert.deepEqual(lines.slice(-3).map((l) => l.stage || l.api), ['importMonth', 'sync', 'api_syncNow']);

  // The hourly trigger path, nothing changed: no `writes` lap.
  const next = nextExecution(sb.env);
  lines = linesDuring(sb.env, () => next.ctx.syncHourly());
  imp = lines.filter((l) => l.stage === 'importMonth');
  assert.equal(imp[0].changed, false);
  assert.equal('writes' in imp[0], false);
  sync = lines.filter((l) => l.stage === 'sync');
  assert.deepEqual([sync[0].changed, sync[0].ok], [false, true]);
  assert.equal(lines.filter((l) => 'api' in l).length, 0, 'a trigger run is not an api call');

  // BUSY: the import does not complete, the sync and the api call are logged as failed.
  sb.env.__state.lockTimeout = true;
  lines = linesDuring(sb.env, () => assert.equal(call(sb.ctx, 'api_syncNow').error.code, 'BUSY'));
  assert.deepEqual(lines.map((l) => [l.stage || l.api, l.ok, l.code]), [['sync', false, 'BUSY'], ['api_syncNow', false, 'BUSY']]);
});

test('write-back: sourceOpen / sourceRead / cellWrites laps for edit, append and delete', () => {
  const { env } = synced();
  const { ctx } = nextExecution(env);
  const month = ok(ctx, 'api_getMonthData', { month: '2026-05' });
  const poste = month.postes[0];

  let lines = linesDuring(env, () => ok(ctx, 'api_savePostes',
    { month: '2026-05', changes: [{ id: poste._id, updates: { Commentaires: 'Vu' } }] }));
  const wb = lines.filter((l) => l.stage === 'writeBack');
  assert.equal(wb.length, 1);
  assert.deepEqual(Object.keys(wb[0]), ['stage', 'ms', 'sourceOpen', 'sourceRead', 'cellWrites', 'op', 'entity']);
  assert.deepEqual([wb[0].op, wb[0].entity], ['edit', 'postes']);
  assert.ok(['ms', 'sourceOpen', 'sourceRead', 'cellWrites'].every((k) => isMs(wb[0][k])));

  lines = linesDuring(env, () => ok(ctx, 'api_addApplication', { month: '2026-05', record: { 'Nom du logiciel / service': 'Outil X' } }));
  assert.deepEqual(lines.filter((l) => l.stage === 'writeBack').map((l) => [l.op, l.entity]), [['append', 'applications']]);
  const added = ok(ctx, 'api_getMonthData', { month: '2026-05' }).applications.find((a) => a['Nom du logiciel / service'] === 'Outil X');
  lines = linesDuring(env, () => ok(ctx, 'api_deleteApplication', { month: '2026-05', id: added._id }));
  assert.deepEqual(lines.filter((l) => l.stage === 'writeBack').map((l) => [l.op, l.entity]), [['delete', 'applications']]);

  // A row missing from the source: no writeBack line, the api line carries the failure.
  env.SpreadsheetApp.openById(SOURCE_ID).getSheetByName('Suivi des postes').deleteRow(3);
  lines = linesDuring(env, () => assert.equal(call(ctx, 'api_savePostes',
    { month: '2026-05', changes: [{ id: poste._id, updates: { Commentaires: 'Revu' } }] }).error.code, 'SOURCE_ERROR'));
  assert.equal(lines.filter((l) => l.stage === 'writeBack').length, 0);
  assert.deepEqual(lines.filter((l) => 'api' in l).map((l) => [l.ok, l.code]), [[false, 'SOURCE_ERROR']]);
});

test('timing lines never carry an e-mail address, an id or record contents', () => {
  const { env } = synced();
  const { ctx } = nextExecution(env);
  ok(ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  const month = ok(ctx, 'api_getMonthData', { month: '2026-05' });
  ok(ctx, 'api_savePostes', { month: '2026-05', changes: [{ id: month.postes[0]._id, updates: { Commentaires: 'Secret 42' } }] });
  env.__setActiveUser(READER);
  const reader = nextExecution(env);
  ok(reader.ctx, 'api_bootstrap');
  ok(reader.ctx, 'api_getTimeline');
  ok(reader.ctx, 'api_getImportLog');

  const all = timingLines(env);
  assert.ok(all.length > 20);
  const text = JSON.stringify(all);
  assert.doesNotMatch(text, /@/);
  assert.doesNotMatch(text, /Secret 42/);
  assert.ok(!text.includes(month.postes[0]._id));
  assert.ok(!text.includes(month.postes[0]['Nom du poste']));
  assert.ok(!text.includes(SOURCE_ID));
  // Every line is a flat object of numbers, booleans, null and short names.
  for (const l of all) {
    assert.ok('api' in l || 'stage' in l, JSON.stringify(l));
    for (const v of Object.values(l)) assert.ok(v === null || ['number', 'boolean', 'string'].includes(typeof v), JSON.stringify(l));
  }
});
