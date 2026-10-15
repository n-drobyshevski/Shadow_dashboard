'use strict';
/**
 * Integration tests for access control and settings (src/Access.js, api_getSettings, api_setThreshold,
 * api_saveUser, api_removeUser, api_setDomainRole): identity from Session, role checks on every
 * endpoint, owner / self lock-out guards, and the configurable compliance threshold.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas, plain } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const OWNER = 'owner@decathlon.com';
const READER = 'lea.reader@decathlon.com';
const ADMIN2 = 'sam.admin@decathlon.com';

const LECTEUR_APIS = ['api_bootstrap', 'api_savePrefs', 'api_getMonthData', 'api_getSyncStatus', 'api_getImportLog',
  'api_getTimeline', 'api_getActions', 'api_getDiff'];

function call(ctx, name, args) {
  const out = ctx[name](args === undefined ? 'null' : JSON.stringify(args));
  assert.equal(typeof out, 'string', name);
  return JSON.parse(out);
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

/** Sandbox with 2026-05 imported by the owner. */
function imported() {
  const sb = loadGas({ sources: [buildSourceSpreadsheet('2026-05')] });
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_importMonth', { month: '2026-05' });
  return sb;
}

function apiNames(ctx) {
  return Object.getOwnPropertyNames(ctx).filter((n) => /^api_/.test(n) && typeof ctx[n] === 'function');
}

// ------------------------------------------------------------------------------------ identity

test('the deployer is admin without being listed; bootstrap reports the user and threshold', () => {
  const sb = imported();
  const boot = ok(sb.ctx, 'api_bootstrap');
  assert.deepEqual(boot.user, { email: OWNER, role: 'admin', isOwner: true });
  assert.equal(boot.threshold, 80);
  assert.match(boot.dataUrl, /^https:\/\//);
  assert.match(boot.sourceUrl, /^https:\/\//);
  const settings = ok(sb.ctx, 'api_getSettings');
  assert.deepEqual(settings.access, { owner: OWNER, users: [], groups: [], domainRole: 'none' });
  assert.equal(settings.me, OWNER);
});

test('unknown account and missing identity are FORBIDDEN on every endpoint', () => {
  const sb = imported();
  as(sb, 'stranger@decathlon.com');
  for (const name of apiNames(sb.ctx)) {
    const err = fail(sb.ctx, name, {}, 'FORBIDDEN');
    assert.match(err.message, /stranger@decathlon\.com/);
  }
  as(sb, '');
  for (const name of apiNames(sb.ctx)) {
    const err = fail(sb.ctx, name, {}, 'FORBIDDEN');
    assert.match(err.message, /Identité Google non transmise/);
  }
  // Nothing was created or changed by refused calls.
  as(sb, undefined);
  assert.deepEqual(ok(sb.ctx, 'api_getSettings').access.users, []);
});

test('lecteur: read endpoints work, every write endpoint is FORBIDDEN, links are hidden', () => {
  const sb = imported();
  ok(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  as(sb, READER);
  const boot = ok(sb.ctx, 'api_bootstrap');
  assert.deepEqual(boot.user, { email: READER, role: 'lecteur', isOwner: false });
  assert.equal(boot.dataUrl, '');
  assert.equal(boot.sourceUrl, '');
  assert.equal(boot.sourceTitle, '');
  assert.deepEqual(boot.months, ['2026-05']);
  const md = ok(sb.ctx, 'api_getMonthData', { month: '2026-05' });
  assert.ok(md.postes.length > 0);
  ok(sb.ctx, 'api_getImportLog');
  assert.equal(typeof ok(sb.ctx, 'api_getSyncStatus').enabled, 'boolean');
  ok(sb.ctx, 'api_getTimeline');
  ok(sb.ctx, 'api_getActions');
  ok(sb.ctx, 'api_getDiff', { oldMonth: '2026-05', newMonth: '2026-05' });

  const writes = apiNames(sb.ctx).filter((n) => !LECTEUR_APIS.includes(n));
  assert.equal(writes.length, 24); // 23 admin endpoints + the test-only api_importMonth
  const poste = md.postes[0];
  for (const name of writes) {
    const err = fail(sb.ctx, name, { month: '2026-05', id: poste._id, changes: [], email: ADMIN2, role: 'admin',
      emails: [ADMIN2], threshold: 70, source: SOURCE_ID }, 'FORBIDDEN');
    assert.equal(err.message, 'Action réservée aux administrateurs.');
  }
  as(sb, undefined);
  assert.equal(ok(sb.ctx, 'api_getSettings').threshold, 80, 'refused setThreshold changed nothing');
});

test('emails are matched case-insensitively and trimmed', () => {
  const sb = imported();
  ok(sb.ctx, 'api_saveUser', { email: '  Lea.Reader@Decathlon.com ', role: 'lecteur' });
  as(sb, 'LEA.READER@decathlon.COM');
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
});

test('domain role: unlisted accounts of the domain read when set to lecteur', () => {
  const sb = imported();
  as(sb, 'anyone@decathlon.com');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  as(sb, undefined);
  assert.equal(ok(sb.ctx, 'api_setDomainRole', { role: 'lecteur' }).domainRole, 'lecteur');
  as(sb, 'anyone@decathlon.com');
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  fail(sb.ctx, 'api_importMonth', { month: '2026-06' }, 'FORBIDDEN');
  as(sb, '');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN'); // no identity is never "the domain"
  as(sb, undefined);
  fail(sb.ctx, 'api_setDomainRole', { role: 'admin' }, 'VALIDATION');
  assert.equal(ok(sb.ctx, 'api_setDomainRole', { role: 'none' }).domainRole, 'none');
});

// ------------------------------------------------------------------------------- user list

test('saveUser / removeUser: add, change role, remove, sorted view with audit fields', () => {
  const sb = imported();
  let view = ok(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  view = ok(sb.ctx, 'api_saveUser', { email: ADMIN2, role: 'admin' });
  assert.deepEqual(view.users.map((u) => [u.email, u.role, u.added_by]),
    [[READER, 'lecteur', OWNER], [ADMIN2, 'admin', OWNER]]);
  assert.match(view.users[0].added_at, /^\d{4}-\d{2}-\d{2}$/);

  // A second admin can manage the list and the threshold.
  as(sb, ADMIN2);
  view = ok(sb.ctx, 'api_saveUser', { email: READER, role: 'admin' });
  assert.equal(view.users.find((u) => u.email === READER).role, 'admin');
  assert.equal(view.users.find((u) => u.email === READER).added_by, OWNER, 'added_by kept on role change');
  assert.equal(view.users.length, 2, 'no duplicate');
  view = ok(sb.ctx, 'api_removeUser', { email: READER });
  assert.deepEqual(view.users.map((u) => u.email), [ADMIN2]);
  fail(sb.ctx, 'api_removeUser', { email: READER }, 'NOT_FOUND');

  as(sb, READER);
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.deepEqual(plain(sb.ctx.Config.get().access.users.map((u) => u.email)), [ADMIN2]);
});

test('no lock-out: the owner and the caller\'s own account cannot be edited', () => {
  const sb = imported();
  for (const name of ['api_saveUser', 'api_removeUser']) {
    let err = fail(sb.ctx, name, { email: OWNER, role: 'lecteur' }, 'VALIDATION');
    assert.match(err.message, /propriétaire/);
    err = fail(sb.ctx, name, { email: ' OWNER@decathlon.com', role: 'lecteur' }, 'VALIDATION');
  }
  ok(sb.ctx, 'api_saveUser', { email: ADMIN2, role: 'admin' });
  as(sb, ADMIN2);
  for (const name of ['api_saveUser', 'api_removeUser']) {
    const err = fail(sb.ctx, name, { email: ADMIN2, role: 'lecteur' }, 'VALIDATION');
    assert.match(err.message, /propre accès/);
  }
  as(sb, undefined);
  assert.equal(ok(sb.ctx, 'api_getSettings').access.users[0].role, 'admin');
});

test('saveUser validation: email and role', () => {
  const sb = imported();
  for (const email of ['', 'nobody', 'a@b', 'a b@decathlon.com', '<x@decathlon.com>', 42, null]) {
    fail(sb.ctx, 'api_saveUser', { email, role: 'lecteur' }, 'VALIDATION');
  }
  for (const role of ['', 'owner', 'Admin', 'none', null]) {
    fail(sb.ctx, 'api_saveUser', { email: READER, role }, 'VALIDATION');
  }
  assert.deepEqual(ok(sb.ctx, 'api_getSettings').access.users, []);
});

test('writes to the access list run under the lock (BUSY on timeout)', () => {
  const sb = loadGas({ lockTimeout: true });
  fail(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' }, 'BUSY');
  fail(sb.ctx, 'api_setThreshold', { threshold: 70 }, 'BUSY');
  fail(sb.ctx, 'api_setDomainRole', { role: 'lecteur' }, 'BUSY');
});

// ------------------------------------------------------------------------------- threshold

test('an access change under the lock starts from the stored list, not from the one read before it', () => {
  const sb = imported();
  // Another admin's execution adds an account while this call waits for the lock.
  const lockObj = sb.env.LockService.getScriptLock();
  const wait = lockObj.waitLock;
  lockObj.waitLock = function (ms) {
    lockObj.waitLock = wait;
    const other = loadGas({ env: sb.env });
    other.ctx.Config.setAccess({ users: [{ email: ADMIN2, role: 'admin' }], groups: [], domainRole: 'none' });
    return wait.call(this, ms);
  };
  try {
    ok(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  } finally {
    lockObj.waitLock = wait;
  }
  assert.deepEqual(ok(sb.ctx, 'api_getSettings').access.users.map((u) => [u.email, u.role]),
    [[READER, 'lecteur'], [ADMIN2, 'admin']]);
});

test('threshold: validated, persisted, and applied to every later call', () => {
  const sb = imported();
  for (const threshold of [0, 101, 72.5, 'abc', null]) fail(sb.ctx, 'api_setThreshold', { threshold }, 'VALIDATION');

  const before = ok(sb.ctx, 'api_getMonthData', { month: '2026-05' });
  const scores = before.postes.map((p) => p._score).filter((s) => s !== null).sort((a, b) => a - b);
  // A threshold at the lowest score makes every scored poste conforme.
  const low = Math.max(1, Math.ceil(scores[0]));
  assert.deepEqual(ok(sb.ctx, 'api_setThreshold', { threshold: String(low) }), { threshold: low });
  assert.equal(sb.env.PropertiesService.getScriptProperties().getProperty('COMPLIANCE_THRESHOLD'), String(low));

  const after = ok(sb.ctx, 'api_getMonthData', { month: '2026-05' });
  for (const p of after.postes) assert.equal(p._conforme, p._score !== null && p._score >= low, p._key);
  assert.ok(after.postes.filter((p) => p._conforme).length > before.postes.filter((p) => p._conforme).length);
  assert.equal(ok(sb.ctx, 'api_bootstrap').threshold, low);
  assert.equal(ok(sb.ctx, 'api_getSettings').threshold, low);
  const tl = ok(sb.ctx, 'api_getTimeline');
  for (const p of tl[0].postes) assert.equal(p._conforme, p._score !== null && p._score >= low);

  // A fresh execution (new sandbox over the same properties) starts from the stored value.
  const props = sb.env.PropertiesService.getScriptProperties().getProperties();
  const sb2 = loadGas({ props });
  assert.equal(sb2.ctx.Config.get().threshold, low);
});

test('getSettings: source info, tabs found and data url', () => {
  const sb = imported();
  const s = ok(sb.ctx, 'api_getSettings');
  assert.equal(s.defaultThreshold, 80);
  assert.equal(s.source.id, SOURCE_ID);
  assert.equal(s.source.title, 'ShadowIT_Industry');
  assert.deepEqual(plain(s.source.tabsFound), { postes: true, applications: true, referentiel: true });
  assert.match(s.dataUrl, /^https:\/\//);
  const empty = loadGas();
  const s2 = ok(empty.ctx, 'api_getSettings');
  assert.deepEqual(s2.source, { id: '', url: '', title: '', tabsFound: null });
});

// ------------------------------------------------------------------------------- bulk add

test('addUsers: added, role changes, and every skip reason', () => {
  const sb = imported();
  ok(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  ok(sb.ctx, 'api_saveUser', { email: ADMIN2, role: 'admin' });
  const res = ok(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: ['New.One@decathlon.com', 'new.two@decathlon.com',
    'new.one@decathlon.com', READER, ADMIN2, OWNER, 'pas une adresse', 42] });
  assert.deepEqual(res.added, ['new.one@decathlon.com', 'new.two@decathlon.com']);
  assert.deepEqual(res.updated, [ADMIN2]);
  assert.deepEqual(res.skipped.map((x) => x.reason).sort(), ['adresse invalide', 'adresse invalide', 'doublon',
    'déjà lecteur', 'propriétaire'].sort());
  assert.deepEqual(res.access.users.map((u) => [u.email, u.role]), [
    [READER, 'lecteur'], ['new.one@decathlon.com', 'lecteur'], ['new.two@decathlon.com', 'lecteur'], [ADMIN2, 'lecteur']]);
  assert.equal(res.access.users[1].added_by, OWNER);
  as(sb, 'new.two@decathlon.com');
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
});

test('addUsers: the caller is skipped, never demoted; validation of role and list size', () => {
  const sb = imported();
  ok(sb.ctx, 'api_saveUser', { email: ADMIN2, role: 'admin' });
  as(sb, ADMIN2);
  const res = ok(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: [ADMIN2] });
  assert.deepEqual(res.skipped, [{ email: ADMIN2, reason: 'votre propre compte' }]);
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'admin');
  fail(sb.ctx, 'api_addUsers', { role: 'owner', emails: [READER] }, 'VALIDATION');
  fail(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: [] }, 'VALIDATION');
  fail(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: 'a@decathlon.com' }, 'VALIDATION');
  const tooMany = Array.from({ length: 501 }, (_, i) => 'u' + i + '@decathlon.com');
  fail(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: tooMany }, 'VALIDATION');
});

test('large lists: 1500 accounts are split across properties under 9 KB and read back intact', () => {
  const sb = imported();
  for (let b = 0; b < 3; b++) {
    const emails = Array.from({ length: 500 }, (_, i) => 'prenom.nom.' + (b * 500 + i) + '@decathlon.com');
    assert.equal(ok(sb.ctx, 'api_addUsers', { role: b === 2 ? 'admin' : 'lecteur', emails }).added.length, 500);
  }
  const props = sb.env.PropertiesService.getScriptProperties().getProperties();
  const parts = Object.keys(props).filter((k) => /^ACCESS_JSON_\d+$/.test(k));
  assert.equal(Number(props.ACCESS_JSON_N), parts.length);
  assert.ok(parts.length > 10, String(parts.length));
  for (const k of parts) assert.ok(Buffer.byteLength(k + props[k], 'utf8') <= 9 * 1024, k);
  assert.equal(ok(sb.ctx, 'api_getSettings').access.users.length, 1500);
  as(sb, 'prenom.nom.1499@decathlon.com');
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'admin');

  // Shrinking the list removes the parts left over, and stale parts are never read.
  as(sb, undefined);
  for (let i = 0; i < 1500; i++) {
    if (i % 300) continue;
    ok(sb.ctx, 'api_removeUser', { email: 'prenom.nom.' + i + '@decathlon.com' });
  }
  ok(sb.ctx, 'api_setDomainRole', { role: 'lecteur' });
  const before = parts.length;
  sb.ctx.Config.setAccess({ users: [], domainRole: 'none' });
  const after = sb.env.PropertiesService.getScriptProperties().getProperties();
  assert.equal(after.ACCESS_JSON_N, '1');
  assert.deepEqual(Object.keys(after).filter((k) => /^ACCESS_JSON_\d+$/.test(k)), ['ACCESS_JSON_0'], 'from ' + before);
  ok(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: Array.from({ length: 300 }, (_, i) => 'p' + i + '@decathlon.com') });
  sb.env.PropertiesService.getScriptProperties().setProperty('ACCESS_JSON_N', '1');
  assert.deepEqual(plain(sb.ctx.Config.get().access), { users: [], groups: [], domainRole: 'none' }, 'truncated JSON -> empty');
});

test('the access list is capped at 2000 accounts', () => {
  const sb = imported();
  for (let b = 0; b < 4; b++) {
    ok(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: Array.from({ length: 500 }, (_, i) => 'a' + (b * 500 + i) + '@decathlon.com') });
  }
  const err = fail(sb.ctx, 'api_addUsers', { role: 'lecteur', emails: ['one.more@decathlon.com'] }, 'VALIDATION');
  assert.match(err.message, /limitée à 2000/);
  fail(sb.ctx, 'api_saveUser', { email: 'one.more@decathlon.com', role: 'lecteur' }, 'VALIDATION');
  // Changing a role is still possible at the cap.
  ok(sb.ctx, 'api_saveUser', { email: 'a1@decathlon.com', role: 'admin' });
});

// ---------------------------------------------------------------------------- Google Groups

const LAB = 'labo-industry@decathlon.com';
const SUB = 'labo-textile@decathlon.com';
const ADMINS = 'shadow-admins@decathlon.com';

function groupKey(group, email) { return 'grp:' + group + '|' + email; }

function withGroups() {
  const sb = imported();
  sb.env.__setGroups({
    [LAB]: { members: ['marc@decathlon.com'], children: [SUB] },
    [SUB]: { members: ['Ines@decathlon.com'], children: [LAB] }, // cycle: must terminate
    [ADMINS]: { members: [ADMIN2, 'marc@decathlon.com'] },
    'secret@decathlon.com': { members: ['x@decathlon.com'], hidden: true },
  });
  return sb;
}

test('groups: add with role, members get it (sub-groups included), highest role wins', () => {
  const sb = withGroups();
  let view = ok(sb.ctx, 'api_saveGroup', { email: ' Labo-Industry@decathlon.com ', role: 'lecteur' });
  assert.deepEqual(view.groups.map((g) => [g.email, g.role, g.added_by]), [[LAB, 'lecteur', OWNER]]);
  as(sb, 'marc@decathlon.com');
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  as(sb, 'ines@decathlon.com');
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur', 'member of a sub-group');
  fail(sb.ctx, 'api_importMonth', { month: '2026-06' }, 'FORBIDDEN');
  as(sb, 'nobody@decathlon.com');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');

  as(sb, undefined);
  ok(sb.ctx, 'api_saveGroup', { email: ADMINS, role: 'admin' });
  as(sb, 'marc@decathlon.com');
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'admin', 'admin group beats lecteur group');
  // Explicit lecteur entry never lowers a group admin.
  as(sb, undefined);
  ok(sb.ctx, 'api_saveUser', { email: 'marc@decathlon.com', role: 'lecteur' });
  as(sb, 'marc@decathlon.com');
  assert.equal(ok(sb.ctx, 'api_getSettings').access.groups.length, 2);
});

test('groups: memberships are cached; removing a group applies at once', () => {
  const sb = withGroups();
  ok(sb.ctx, 'api_saveGroup', { email: LAB, role: 'lecteur' });
  as(sb, 'marc@decathlon.com');
  ok(sb.ctx, 'api_bootstrap');
  const calls = sb.env.__state.groupCalls;
  for (let i = 0; i < 5; i++) ok(sb.ctx, 'api_getActions');
  assert.equal(sb.env.__state.groupCalls, calls, 'no GroupsApp call while cached');
  assert.match(sb.env.__state.cache.get(groupKey(LAB, 'marc@decathlon.com')), /^m:\d+$/);
  as(sb, undefined);
  ok(sb.ctx, 'api_removeGroup', { email: LAB });
  as(sb, 'marc@decathlon.com');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
});

test('groups: every group a call may need is read from the cache in ONE getAll', () => {
  const sb = withGroups();
  const extra = ['g1@decathlon.com', 'g2@decathlon.com', 'g3@decathlon.com'];
  sb.env.__setGroups(Object.fromEntries(extra.map((g) => [g, { members: ['someone@decathlon.com'] }])));
  for (const g of extra) ok(sb.ctx, 'api_saveGroup', { email: g, role: 'admin' });
  ok(sb.ctx, 'api_saveGroup', { email: LAB, role: 'lecteur' });
  as(sb, 'ines@decathlon.com'); // lecteur through the sub-group of LAB, in none of the admin groups
  const calls = sb.env.__state.calls;
  const count = (k) => calls[k] || 0;
  const before = { getAll: count('cacheGetAll'), get: count('cacheGet'), groups: sb.env.__state.groupCalls };
  ok(sb.ctx, 'api_getActions');
  assert.equal(count('cacheGetAll') - before.getAll, 1, 'cold: one getAll for the 4 groups');
  assert.ok(sb.env.__state.groupCalls > before.groups, 'cold: checked live');
  const warm = { getAll: count('cacheGetAll'), groups: sb.env.__state.groupCalls };
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  assert.equal(count('cacheGetAll') - warm.getAll, 1, 'warm: one getAll');
  assert.equal(sb.env.__state.groupCalls, warm.groups, 'warm: no GroupsApp call');
  assert.equal(count('cacheGet'), before.get, 'never one get per group');
});

test('groups: a cached membership slides with use but is re-verified after 1 h at most', (t) => {
  const sb = withGroups();
  ok(sb.ctx, 'api_saveGroup', { email: LAB, role: 'lecteur' });
  let now = Date.UTC(2026, 4, 15, 8, 0, 0);
  t.mock.method(Date, 'now', () => now);
  const ctx = sb.ctx;
  const minutes = (m) => { now += m * 60000; };
  as(sb, 'marc@decathlon.com');
  ok(ctx, 'api_bootstrap'); // live check at 08:00
  const live = sb.env.__state.groupCalls;
  // Removed from the group in Google: the cached membership still applies while it is used...
  sb.env.__setGroups({ [LAB]: { members: [], children: [SUB] } });
  for (let i = 0; i < 6; i++) { // 08:09, 08:18 ... 08:54: each hit renews the 10-min lifetime
    minutes(9);
    assert.equal(ok(ctx, 'api_bootstrap').user.role, 'lecteur', 'hit ' + i);
  }
  assert.equal(sb.env.__state.groupCalls, live, 'served by the cache beyond its first 10 minutes');
  minutes(5); // 08:59
  assert.equal(ok(ctx, 'api_bootstrap').user.role, 'lecteur');
  minutes(1); // 09:00: 1 h after the live check -> verified again, access removed
  fail(ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.ok(sb.env.__state.groupCalls > live);
  assert.equal(sb.env.__state.cache.get(groupKey(LAB, 'marc@decathlon.com')), 'n');

  // Without use, a membership expires after 10 minutes (then a live check).
  sb.env.__setGroups({ [LAB]: { members: ['marc@decathlon.com'], children: [SUB] } });
  minutes(11); // past the 10 min of the "not a member" answer
  assert.equal(ok(ctx, 'api_bootstrap').user.role, 'lecteur');
  const afterLive = sb.env.__state.groupCalls;
  minutes(10);
  assert.equal(ok(ctx, 'api_bootstrap').user.role, 'lecteur');
  assert.ok(sb.env.__state.groupCalls > afterLive, 'idle 10 min: checked live again');
});

test('groups: an unreadable group is remembered as a failure for 120 s and still denies', (t) => {
  const sb = withGroups();
  for (const email of ['ghost@decathlon.com', 'secret@decathlon.com']) {
    const err = fail(sb.ctx, 'api_saveGroup', { email, role: 'lecteur' }, 'VALIDATION');
    assert.match(err.message, /Groupe introuvable ou membres non visibles/);
  }
  fail(sb.ctx, 'api_saveGroup', { email: LAB, role: 'none' }, 'VALIDATION');
  fail(sb.ctx, 'api_removeGroup', { email: LAB }, 'NOT_FOUND');
  ok(sb.ctx, 'api_saveGroup', { email: LAB, role: 'lecteur' });
  let now = Date.UTC(2026, 4, 15, 8, 0, 0);
  t.mock.method(Date, 'now', () => now);
  sb.env.__setGroups({ [LAB]: { members: ['marc@decathlon.com'], hidden: true } });
  as(sb, 'marc@decathlon.com');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.equal(sb.env.__state.cache.get(groupKey(LAB, 'marc@decathlon.com')), 'e', 'failure cached');
  const calls = sb.env.__state.groupCalls;
  // Readable again: still denied (never granted) until the failure expires, without retrying GroupsApp.
  sb.env.__setGroups({ [LAB]: { members: ['marc@decathlon.com'], children: [] } });
  now += 119 * 1000;
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.equal(sb.env.__state.groupCalls, calls, 'no GroupsApp call during the 120 s');
  now += 1000;
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur', 'retried after 120 s');
});

test('groups: a failing or foreign cache falls back to the live check and never grants access', () => {
  const sb = withGroups();
  ok(sb.ctx, 'api_saveGroup', { email: LAB, role: 'lecteur' });
  const st = sb.env.__state;
  // Reads fail: every call checks live (members get in, others do not).
  st.cacheFaults.read = true;
  as(sb, 'marc@decathlon.com');
  let calls = st.groupCalls;
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  assert.ok(st.groupCalls > calls, 'checked live');
  as(sb, 'nobody@decathlon.com');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  // Writes fail too: still answered live, nothing thrown.
  st.cacheFaults.write = true;
  as(sb, 'marc@decathlon.com');
  calls = st.groupCalls;
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
  assert.ok(st.groupCalls > calls);
  st.cacheFaults.read = false;
  st.cacheFaults.write = false;
  // Values the code does not recognise (an older format, garbage, a time in the future) and a membership
  // verified 1 h ago or more (whatever its remaining cache lifetime) are a miss.
  const key = groupKey(LAB, 'nobody@decathlon.com');
  for (const v of ['1', 'm:', 'm:abc', 'yes', 'm:' + (Date.now() + 3600e3), 'm:' + (Date.now() - 3600e3)]) {
    st.cache.set(key, v);
    st.cacheExpiry.set(key, Date.now() + 600e3);
    as(sb, 'nobody@decathlon.com');
    calls = st.groupCalls;
    fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
    assert.ok(st.groupCalls > calls, v + ': checked live');
    assert.equal(st.cache.get(key), 'n', v + ': replaced by the live answer');
  }
});

test('groups: an admin cannot remove or demote the group that makes them admin', () => {
  const sb = withGroups();
  ok(sb.ctx, 'api_saveGroup', { email: ADMINS, role: 'admin' });
  as(sb, ADMIN2);
  for (const [name, args] of [['api_removeGroup', { email: ADMINS }], ['api_saveGroup', { email: ADMINS, role: 'lecteur' }]]) {
    const err = fail(sb.ctx, name, args, 'VALIDATION');
    assert.match(err.message, /retirerait le rôle administrateur/);
  }
  // The owner can.
  as(sb, undefined);
  ok(sb.ctx, 'api_saveGroup', { email: ADMINS, role: 'lecteur' });
  as(sb, ADMIN2);
  assert.equal(ok(sb.ctx, 'api_bootstrap').user.role, 'lecteur');
});

// ------------------------------------------------------------------------------------ preferences

test('interface preferences: stored per account, allowed to every role, validated', () => {
  const sb = imported();
  const props = sb.ctx.PropertiesService.getScriptProperties();
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), {});
  assert.deepEqual(plain(ok(sb.ctx, 'api_savePrefs', { sidebar: 'collapsed' })), { prefs: { sidebar: 'collapsed' } });
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), { sidebar: 'collapsed' });
  assert.equal(props.getProperty('PREFS_' + OWNER), '{"sidebar":"collapsed"}');
  fail(sb.ctx, 'api_savePrefs', { sidebar: 'wide' }, 'VALIDATION');
  fail(sb.ctx, 'api_savePrefs', { theme: 'dark' }, 'VALIDATION');
  fail(sb.ctx, 'api_savePrefs', {}, 'VALIDATION');
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), { sidebar: 'collapsed' }, 'refused saves changed nothing');
  // The period shortcut (app bar) is a preference too; prefs are merged, not replaced.
  fail(sb.ctx, 'api_savePrefs', { period: 'last12' }, 'VALIDATION');
  ok(sb.ctx, 'api_savePrefs', { period: 'last6' });
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), { sidebar: 'collapsed', period: 'last6' });
  ok(sb.ctx, 'api_savePrefs', { period: 'month' });

  // A lecteur saves their own, separate preferences.
  ok(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  as(sb, READER);
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), {}, 'not shared between accounts');
  ok(sb.ctx, 'api_savePrefs', { sidebar: 'open' });
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), { sidebar: 'open' });
  as(sb, undefined);
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), { sidebar: 'collapsed', period: 'month' });

  // Unreadable or unknown stored values are ignored.
  props.setProperty('PREFS_' + OWNER, '{oops');
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), {});
  props.setProperty('PREFS_' + OWNER, '{"sidebar":"huge","x":1}');
  assert.deepEqual(plain(ok(sb.ctx, 'api_bootstrap').prefs), {});
});
