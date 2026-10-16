'use strict';
/**
 * Integration tests for the access log: one AccessLog row per person per 30 min, written by api_bootstrap
 * (refusals included), never failing the boot, capped in size, and read back by the admin-only
 * api_getAccessLog.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const OWNER = 'owner@decathlon.com';
const READER = 'lea.reader@decathlon.com';
const STRANGER = 'stranger@decathlon.com';

function call(ctx, name, args) {
  return JSON.parse(ctx[name](args === undefined ? 'null' : JSON.stringify(args)));
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
function as(sb, email) { sb.env.__setActiveUser(email); }

/** 2026-05 imported by the owner, READER a lecteur, the clock frozen and the visit entries cleared. */
function setup(t) {
  const sb = loadGas({ sources: [buildSourceSpreadsheet('2026-05')] });
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_importMonth', { month: '2026-05' });
  ok(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  const clock = { now: Date.UTC(2026, 4, 12, 8, 0) };
  t.mock.method(Date, 'now', () => clock.now);
  sb.clock = clock;
  for (const k of [...sb.env.__state.cache.keys()]) if (k.startsWith('al:')) sb.env.__state.cache.delete(k);
  sb.rows = () => {
    const sheet = sb.env.SpreadsheetApp.openById(sb.ctx.Config.get().dataId).getSheetByName('AccessLog');
    return sheet.getDataRange().getValues().slice(1).filter((r) => r.some((c) => c !== ''));
  };
  return sb;
}

test('a bootstrap logs one visit; reloads within 30 min do not, a later one does', (t) => {
  const sb = setup(t);
  as(sb, READER);
  ok(sb.ctx, 'api_bootstrap');
  ok(sb.ctx, 'api_bootstrap');
  sb.clock.now += 29 * 60 * 1000;
  ok(sb.ctx, 'api_bootstrap');
  assert.equal(sb.rows().length, 1);
  assert.deepEqual(sb.rows()[0].slice(1), [READER, 'lecteur', '']);
  assert.match(String(sb.rows()[0][0]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  sb.clock.now += 2 * 60 * 1000;
  ok(sb.ctx, 'api_bootstrap');
  assert.equal(sb.rows().length, 2);
  // Other calls are not visits.
  ok(sb.ctx, 'api_getActions');
  assert.equal(sb.rows().length, 2);
});

test('a refused account is logged as refused; no identity is not logged', (t) => {
  const sb = setup(t);
  as(sb, STRANGER);
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  fail(sb.ctx, 'api_getActions', null, 'FORBIDDEN');
  as(sb, '');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.deepEqual(sb.rows().map((r) => r.slice(1, 3)), [[STRANGER, 'refused']]);
});

test('api_getAccessLog: newest first, admin only, limit validated', (t) => {
  const sb = setup(t);
  as(sb, READER);
  ok(sb.ctx, 'api_bootstrap');
  as(sb, STRANGER);
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  as(sb, undefined);
  ok(sb.ctx, 'api_bootstrap');
  const log = ok(sb.ctx, 'api_getAccessLog');
  assert.deepEqual(log.map((e) => [e.email, e.result]), [[OWNER, 'admin'], [STRANGER, 'refused'], [READER, 'lecteur']]);
  assert.deepEqual(ok(sb.ctx, 'api_getAccessLog', { limit: 1 }).map((e) => e.email), [OWNER]);
  fail(sb.ctx, 'api_getAccessLog', { limit: 0 }, 'VALIDATION');
  fail(sb.ctx, 'api_getAccessLog', { limit: 501 }, 'VALIDATION');
  as(sb, READER);
  fail(sb.ctx, 'api_getAccessLog', null, 'FORBIDDEN');
});

test('a busy lock or a failing sheet drops the visit, never the boot', (t) => {
  const sb = setup(t);
  as(sb, READER);
  sb.env.__state.onWaitLock = () => { sb.env.__state.lockTimeout = true; };
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  sb.env.__state.lockTimeout = false;
  assert.equal(sb.rows().length, 0);
  sb.clock.now += 31 * 60 * 1000;
  const orig = sb.ctx.Store.appendAccessLog;
  sb.ctx.Store.appendAccessLog = () => { throw new Error('Service Spreadsheets failed'); };
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  sb.ctx.Store.appendAccessLog = orig;
  assert.equal(sb.env.__state.lock.held, false);
});

test('the tab is trimmed back to ACCESS_LOG_MAX rows once it is ACCESS_LOG_SLACK over', (t) => {
  const sb = setup(t);
  const { ACCESS_LOG_MAX: max, ACCESS_LOG_SLACK: slack } = sb.ctx.Store;
  for (let i = 0; i < max + slack; i++) sb.ctx.Store.appendAccessLog({ email: 'u' + i + '@decathlon.com', result: 'lecteur' });
  assert.equal(sb.rows().length, max + slack);
  sb.ctx.Store.appendAccessLog({ email: 'last@decathlon.com', result: 'admin' });
  const rows = sb.rows();
  assert.equal(rows.length, max);
  assert.equal(rows[rows.length - 1][1], 'last@decathlon.com');
  assert.equal(rows[0][1], 'u' + (slack + 1) + '@decathlon.com', 'the oldest rows went');
});

test('a refused visitor never makes an unconfigured app create its data spreadsheet', () => {
  const sb = loadGas({ sources: [buildSourceSpreadsheet('2026-05')] });
  as(sb, STRANGER);
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.equal(sb.ctx.Config.get().dataId, '');
});

test('api_notePages: merges into the caller\'s latest visit, once per page; refused rows are skipped', (t) => {
  const sb = setup(t);
  as(sb, READER);
  ok(sb.ctx, 'api_bootstrap');
  as(sb, STRANGER);
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  as(sb, READER);
  assert.equal(ok(sb.ctx, 'api_notePages', { pages: ['dashboard', 'postes'] }), null);
  ok(sb.ctx, 'api_notePages', { pages: ['postes', 'actions'] });
  assert.deepEqual(sb.rows().map((r) => r.slice(1)), [[READER, 'lecteur', 'dashboard,postes,actions'], [STRANGER, 'refused', '']]);
  as(sb, undefined);
  const log = ok(sb.ctx, 'api_getAccessLog');
  assert.deepEqual(log.map((e) => e.pages), [[], ['dashboard', 'postes', 'actions']]);
});

test('api_notePages: validated; no visit row or a busy lock is not an error', (t) => {
  const sb = setup(t);
  as(sb, READER);
  for (const bad of [null, {}, { pages: [] }, { pages: 'postes' }, { pages: ['nope'] }, { pages: ['__proto__'] },
    { pages: ['dashboard', 'postes', 'apps', 'timeline', 'actions', 'settings', 'dashboard'] }]) {
    fail(sb.ctx, 'api_notePages', bad, 'VALIDATION');
  }
  assert.equal(ok(sb.ctx, 'api_notePages', { pages: ['postes'] }), null, 'no row yet');
  assert.equal(sb.rows().length, 0);
  ok(sb.ctx, 'api_bootstrap');
  sb.env.__state.onWaitLock = () => { sb.env.__state.lockTimeout = true; };
  assert.equal(ok(sb.ctx, 'api_notePages', { pages: ['postes'] }), null, 'busy lock');
  sb.env.__state.lockTimeout = false;
  assert.equal(sb.rows()[0][3], '');
  assert.equal(sb.env.__state.lock.held, false);
});
