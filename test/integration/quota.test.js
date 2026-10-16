'use strict';
/**
 * Quota and abuse limits (src/Access.js, apiWrap_): the per-account throttle that runs before the Script
 * Properties are read (counter per minute, weights of the full-history reads, BUSY message, fail open on a
 * cache failure, no identity refused first), the stale-on-error answer of Google Groups memberships (a
 * GroupsApp failure such as the daily quota does not lock out confirmed members) and the one-entry
 * "no role" answer of refused accounts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const OWNER = 'owner@decathlon.com';
const READER = 'lea.reader@decathlon.com';
const OTHER = 'paul.reader@decathlon.com';
const LAB = 'labo-industry@decathlon.com';
const ADMINS = 'shadow-admins@decathlon.com';
const MARC = 'marc@decathlon.com';
const QUOTA = 'Service invoked too many times for one day: groups.';
const T0 = Date.UTC(2026, 4, 15, 8, 0, 0); // the start of a minute

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

/** 2026-05 imported by the owner, READER and OTHER lecteurs; the clock is then frozen at T0 (moved by the test). */
function setup(t) {
  const sb = loadGas({ sources: [buildSourceSpreadsheet('2026-05')] });
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_importMonth', { month: '2026-05' });
  ok(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: [READER, OTHER] });
  const clock = { now: T0 };
  t.mock.method(Date, 'now', () => clock.now);
  sb.clock = clock;
  return sb;
}

const propertyReads = (sb) => ['getProperty', 'getProperties', 'getKeys'].reduce((n, k) => n + (sb.env.__state.calls[k] || 0), 0);
const counter = (sb, email) => sb.env.__state.cache.get('rl:' + Math.floor(Date.now() / 60000) + '|' + email);

// ---------------------------------------------------------------------------------------- throttle

test('throttle: 120 calls per account and minute, then BUSY before any Properties read; next minute it resets', (t) => {
  const sb = setup(t);
  as(sb, READER);
  for (let i = 0; i < 120; i++) ok(sb.ctx, 'api_getActions');
  assert.equal(counter(sb, READER), '120');
  const reads = propertyReads(sb);
  const puts = sb.env.__state.calls.cachePut || 0;
  const err = fail(sb.ctx, 'api_getActions', null, 'BUSY');
  assert.equal(err.message, 'Trop de requêtes. Réessayez dans une minute.');
  fail(sb.ctx, 'api_bootstrap', null, 'BUSY');
  assert.equal(propertyReads(sb), reads, 'a refused call reads no Script Property');
  assert.equal(sb.env.__state.calls.cachePut || 0, puts, 'a refused call writes nothing');
  assert.equal(counter(sb, READER), '120');
  // Logged as a warning, without a stack; the timing line carries the code.
  const warn = sb.env.__state.console.filter((c) => c.level === 'warn' && /\[api_getActions\] BUSY/.test(c.args[0]));
  assert.equal(warn.length, 1);
  assert.ok(!sb.env.__state.console.some((c) => c.level === 'error' && /BUSY/.test(c.args[0])));

  // Per account: another lecteur and the deployer are not concerned.
  as(sb, OTHER);
  ok(sb.ctx, 'api_getActions');
  assert.equal(counter(sb, OTHER), '1');
  as(sb, undefined);
  for (let i = 0; i < 130; i++) ok(sb.ctx, 'api_getActions');
  assert.equal(counter(sb, OWNER), undefined, 'the deployer is not counted');

  // The next minute starts a new counter.
  as(sb, READER);
  sb.clock.now += 59 * 1000;
  fail(sb.ctx, 'api_getActions', null, 'BUSY');
  sb.clock.now += 1000;
  ok(sb.ctx, 'api_getActions');
  assert.equal(counter(sb, READER), '1');
});

test('throttle: the full-history reads (timeline, diff, import log) count 5 each', (t) => {
  const sb = setup(t);
  as(sb, READER);
  ok(sb.ctx, 'api_getTimeline');
  assert.equal(counter(sb, READER), '5');
  ok(sb.ctx, 'api_getDiff', { oldMonth: '2026-05', newMonth: '2026-05' });
  assert.equal(counter(sb, READER), '10');
  ok(sb.ctx, 'api_getImportLog');
  assert.equal(counter(sb, READER), '15');
  for (let i = 0; i < 101; i++) ok(sb.ctx, 'api_getSyncStatus');
  assert.equal(counter(sb, READER), '116');
  // 116 + 5 > 120: a heavy read is refused while a light call still fits.
  fail(sb.ctx, 'api_getTimeline', null, 'BUSY');
  fail(sb.ctx, 'api_getDiff', { oldMonth: '2026-05', newMonth: '2026-05' }, 'BUSY');
  for (let i = 0; i < 4; i++) ok(sb.ctx, 'api_getActions');
  assert.equal(counter(sb, READER), '120');
  fail(sb.ctx, 'api_getActions', null, 'BUSY');
  // 24 heavy reads use a whole minute.
  sb.clock.now += 60 * 1000;
  for (let i = 0; i < 24; i++) ok(sb.ctx, 'api_getImportLog');
  fail(sb.ctx, 'api_getActions', null, 'BUSY');
});

test('throttle: a failing cache never blocks a call (fail open)', (t) => {
  const sb = setup(t);
  const st = sb.env.__state;
  as(sb, READER);
  st.cacheFaults.read = true;
  for (let i = 0; i < 130; i++) ok(sb.ctx, 'api_getActions');
  assert.ok(st.console.some((c) => c.level === 'warn' && /throttle cache not readable/.test(c.args[0])));
  st.cacheFaults.read = false;
  st.cacheFaults.write = true; // the counter cannot be stored: every call goes through
  for (let i = 0; i < 130; i++) ok(sb.ctx, 'api_getActions');
  st.cacheFaults.write = false;
  ok(sb.ctx, 'api_getActions');
  assert.equal(counter(sb, READER), '1');
});

test('throttle: no identity is FORBIDDEN before any Properties or cache call; a refused account is throttled too', (t) => {
  const sb = setup(t);
  const st = sb.env.__state;
  as(sb, '');
  const reads = propertyReads(sb);
  const cache = (st.calls.cacheGet || 0) + (st.calls.cacheGetAll || 0) + (st.calls.cachePut || 0);
  const err = fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.match(err.message, /Identité Google non transmise/);
  assert.equal(propertyReads(sb), reads);
  assert.equal((st.calls.cacheGet || 0) + (st.calls.cacheGetAll || 0) + (st.calls.cachePut || 0), cache);

  // An account of the domain without a role: refused by the role check, and limited like everyone.
  as(sb, 'stranger@decathlon.com');
  for (let i = 0; i < 120; i++) assert.match(fail(sb.ctx, 'api_getActions', null, 'FORBIDDEN').message, /Accès refusé/);
  const before = propertyReads(sb);
  fail(sb.ctx, 'api_getActions', null, 'BUSY');
  assert.equal(propertyReads(sb), before, 'past the limit, no Properties read');
});

const running = (sb, email) => JSON.parse(sb.env.__state.cache.get('if:' + email) || '[]');

test('throttle: at most THROTTLE_IN_FLIGHT calls of an account running at once; the end of a call frees its place', (t) => {
  const sb = setup(t);
  const st = sb.env.__state;
  const max = sb.ctx.Access.THROTTLE_IN_FLIGHT;
  as(sb, READER);
  ok(sb.ctx, 'api_getActions');
  assert.deepEqual(running(sb, READER), [], 'released at the end of the call');
  // Seen from inside a call: it counts as running, under the user lock (not the script lock).
  let inside = null;
  const orig = sb.ctx.Store.listRows;
  sb.ctx.Store.listRows = function () { inside = inside || running(sb, READER); return orig.apply(this, arguments); };
  ok(sb.ctx, 'api_getActions');
  sb.ctx.Store.listRows = orig;
  assert.deepEqual(inside, [Date.now()]);
  assert.ok(st.userLock.acquired >= 4, 'entry and release of both calls under the user lock');
  assert.equal(st.userLock.held, false);

  // Other calls of the account still running (parallel google.script.run calls): the next one is refused.
  st.cache.set('if:' + READER, JSON.stringify(Array(max).fill(Date.now() - 1000)));
  const puts = (st.calls.cachePut || 0) + (st.calls.cachePutAll || 0);
  const reads = propertyReads(sb);
  const err = fail(sb.ctx, 'api_getTimeline', null, 'BUSY');
  assert.equal(err.message, 'Trop de requêtes en cours. Réessayez dans quelques instants.');
  assert.equal(propertyReads(sb), reads, 'no Script Property read');
  assert.equal((st.calls.cachePut || 0) + (st.calls.cachePutAll || 0), puts, 'a refused call writes nothing');
  assert.equal(running(sb, READER).length, max, 'and frees nothing');
  // Another account is not concerned.
  as(sb, OTHER);
  ok(sb.ctx, 'api_getActions');
  // One of them ends: a place is free again.
  as(sb, READER);
  st.cache.set('if:' + READER, JSON.stringify(Array(max - 1).fill(Date.now() - 1000)));
  ok(sb.ctx, 'api_getActions');
  assert.equal(running(sb, READER).length, max - 1, 'its own entry removed at its end');
  // An entry left by an execution killed before its end (older than 6 min) no longer counts.
  st.cache.set('if:' + READER, JSON.stringify(Array(max).fill(Date.now() - 361 * 1000)));
  ok(sb.ctx, 'api_getActions');
  assert.deepEqual(running(sb, READER), []);
  // A failing call frees its place too.
  fail(sb.ctx, 'api_getMonthData', { month: 'nope' }, 'VALIDATION');
  assert.deepEqual(running(sb, READER), []);
});

test('throttle: concurrent calls of one account each count (the counters are read and written under the user lock)', (t) => {
  const sb = setup(t);
  const st = sb.env.__state;
  as(sb, READER);
  // The lock cannot be had: the call is counted without it (best effort), with a warning.
  st.userLockTimeout = true;
  ok(sb.ctx, 'api_getActions');
  assert.equal(counter(sb, READER), '1');
  assert.ok(st.console.some((c) => c.level === 'warn' && /throttle lock not obtained/.test(c.args[0])));
  st.userLockTimeout = false;
  // The script lock (Store's writes) is never taken by the throttle.
  const scriptLocks = st.lock.acquired;
  ok(sb.ctx, 'api_getActions');
  assert.equal(st.lock.acquired, scriptLocks);
});

test('doGet: throttled like the api_* calls; refused, a static page with the message and no Script Property read', (t) => {
  const sb = setup(t);
  const st = sb.env.__state;
  as(sb, READER);
  for (let i = 0; i < 120; i++) ok(sb.ctx, 'api_getActions');
  const reads = propertyReads(sb);
  const page = sb.ctx.doGet({}).getContent();
  assert.match(page, /Trop de requêtes\. Réessayez dans une minute\./);
  assert.doesNotMatch(page, /boot-data/);
  assert.equal(propertyReads(sb), reads, 'no FAVICON_URL read, no bootstrap');
  // Without an identity: the identity message, nothing read.
  as(sb, '');
  const cache = (st.calls.cacheGet || 0) + (st.calls.cacheGetAll || 0);
  assert.match(sb.ctx.doGet({}).getContent(), /Identité Google non transmise/);
  assert.equal(propertyReads(sb), reads);
  assert.equal((st.calls.cacheGet || 0) + (st.calls.cacheGetAll || 0), cache);
  // The message is printed escaped (an escaping template scriptlet, never concatenated markup).
  assert.equal(sb.ctx.refusedPage_('<b>x</b> & "y"').getContent().includes('<b>'), false);
  // Within the limits, the page load counts one call and frees its place at the end.
  sb.clock.now += 60 * 1000;
  as(sb, READER);
  try { sb.ctx.doGet({}); } catch (e) { if (!/No HTML file named/.test(e.message)) throw e; }
  assert.ok(Number(counter(sb, READER)) >= 1);
  assert.deepEqual(running(sb, READER), []);
});

// ------------------------------------------------------------------------------ groups: quota

const grp = (group, email) => 'grp:' + group + '|' + email;
const grpok = (group, email) => 'grpok:' + group + '|' + email;

function withGroup(t) {
  const sb = setup(t);
  sb.env.__setGroups({ [LAB]: { members: [MARC] }, [ADMINS]: { members: [] } });
  as(sb, undefined);
  ok(sb.ctx, 'api_saveGroup', { email: LAB, role: 'lecteur' });
  return sb;
}

test('groups: a confirmed member keeps access while GroupsApp fails (daily quota), 6 h after the confirmation at most', (t) => {
  const sb = withGroup(t);
  const st = sb.env.__state;
  as(sb, MARC);
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur'); // live check at T0
  assert.equal(st.cache.get(grpok(LAB, MARC)), String(T0));
  // The quota is used up: from now on every GroupsApp call fails.
  sb.env.__fault({ method: 'getGroupByEmail', id: LAB, times: Infinity, message: QUOTA });
  sb.clock.now += 61 * 60 * 1000; // past the 1 h re-verification
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur', 'answered from the confirmed membership');
  assert.equal(st.cache.get(grp(LAB, MARC)), 'e');
  assert.ok(st.console.some((c) => c.level === 'warn' && c.args[0].includes(QUOTA) &&
    c.args[0].includes('answered from the last confirmed membership')));
  // Within the 120 s of the remembered error: no GroupsApp call, still answered.
  const calls = st.groupCalls;
  const faults = st.faults[0].times;
  sb.clock.now += 60 * 1000;
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  assert.equal(st.groupCalls, calls);
  assert.equal(st.faults[0].times, faults, 'the group was not read again');
  // Never confirmed: denied, as before.
  as(sb, 'ines@decathlon.com');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  // 6 h after the confirmation the stale answer ends.
  as(sb, MARC);
  sb.clock.now = T0 + 6 * 3600 * 1000 - 1000;
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  sb.clock.now = T0 + 6 * 3600 * 1000;
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  // GroupsApp readable again: a live check confirms anew.
  sb.env.__clearFaults();
  sb.clock.now += 121 * 1000;
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  assert.equal(st.cache.get(grpok(LAB, MARC)), String(sb.clock.now));
});

test('groups: a live "not a member" drops the confirmation, so a removed member gets no stale access', (t) => {
  const sb = withGroup(t);
  const st = sb.env.__state;
  as(sb, MARC);
  ok(sb.ctx, 'api_bootstrap');
  assert.ok(st.cache.get(grpok(LAB, MARC)));
  sb.env.__setGroups({ [LAB]: { members: [] } }); // removed in Google
  sb.clock.now += 61 * 60 * 1000;
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.equal(st.cache.has(grpok(LAB, MARC)), false, 'confirmation removed');
  // GroupsApp then fails: nothing to answer from, denied.
  sb.env.__fault({ method: 'getGroupByEmail', id: LAB, times: Infinity, message: QUOTA });
  sb.clock.now += 11 * 60 * 1000;
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.equal(st.cache.get(grp(LAB, MARC)), 'e');
});

test('groups: a refused account costs one cache read per call (one "no role" entry), keyed by the list of groups', (t) => {
  const sb = withGroup(t);
  const st = sb.env.__state;
  as(sb, undefined);
  ok(sb.ctx, 'api_saveGroup', { email: ADMINS, role: 'admin' });
  const NOBODY = 'nobody@decathlon.com';
  as(sb, NOBODY);
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  const nr = [...st.cache.keys()].filter((k) => k.startsWith('nr:') && k.endsWith('|' + NOBODY));
  assert.equal(nr.length, 1);
  assert.equal(st.cache.get(nr[0]), '1');
  // Even with the group entries gone (evicted), no group is walked again: one getAll, no GroupsApp call.
  st.cache.delete(grp(LAB, NOBODY));
  st.cache.delete(grp(ADMINS, NOBODY));
  const before = { getAll: st.calls.cacheGetAll, get: st.calls.cacheGet, groups: st.groupCalls };
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.equal(st.calls.cacheGetAll - before.getAll, 2, 'the throttle counters and the "no role" entry');
  assert.equal(st.calls.cacheGet - before.get, 2, 'the throttle release and the access log visit check');
  assert.equal(st.groupCalls, before.groups);

  // An explicit entry or the domain role applies at once (checked before the entry).
  as(sb, undefined);
  ok(sb.ctx, 'api_saveUser', { email: NOBODY, role: 'lecteur' });
  as(sb, NOBODY);
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  as(sb, undefined);
  ok(sb.ctx, 'api_removeUser', { email: NOBODY });

  // Added to a group in Google: the entry keeps refusing for its 10 minutes at most...
  sb.env.__setGroups({ [LAB]: { members: [MARC, NOBODY] } });
  as(sb, NOBODY);
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  sb.clock.now += 600 * 1000;
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  // ...and any change to the list of groups is a new entry: a group added to the list is checked at once.
  const OUT = 'out@decathlon.com';
  const NEW_GROUP = 'nouveaux@decathlon.com';
  as(sb, OUT);
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  sb.env.__setGroups({ [NEW_GROUP]: { members: [OUT] } });
  as(sb, undefined);
  ok(sb.ctx, 'api_saveGroup', { email: NEW_GROUP, role: 'lecteur' });
  as(sb, OUT);
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
});

test('groups: a refusal caused by an unreadable group is not remembered as "no role"', (t) => {
  const sb = withGroup(t);
  const st = sb.env.__state;
  sb.env.__fault({ method: 'getGroupByEmail', id: LAB, times: 1, message: QUOTA });
  as(sb, MARC); // a member, never confirmed: denied during the error...
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.deepEqual([...st.cache.keys()].filter((k) => k.startsWith('nr:')), []);
  // ...and let in once the group is readable again (after the 120 s of the remembered error).
  sb.clock.now += 120 * 1000;
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
});

test('cache keys stay within the CacheService limit for very long addresses', (t) => {
  const sb = setup(t);
  const long = 'x'.repeat(240) + '@decathlon.com';
  as(sb, undefined);
  ok(sb.ctx, 'api_saveUser', { email: long, role: 'lecteur' });
  as(sb, long);
  ok(sb.ctx, 'api_getActions');
  const keys = [...sb.env.__state.cache.keys()].filter((k) => k.startsWith('rl:'));
  assert.equal(keys.length, 1);
  assert.ok(keys[0].length <= 250, String(keys[0].length));
});
