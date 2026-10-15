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

const LECTEUR_APIS = ['api_bootstrap', 'api_getMonthData', 'api_getImportLog', 'api_getTimeline', 'api_getActions',
  'api_getDiff'];

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
  ok(sb.ctx, 'api_getTimeline');
  ok(sb.ctx, 'api_getActions');
  ok(sb.ctx, 'api_getDiff', { oldMonth: '2026-05', newMonth: '2026-05' });

  const writes = apiNames(sb.ctx).filter((n) => !LECTEUR_APIS.includes(n));
  assert.equal(writes.length, 22);
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
  assert.equal(sb.env.__state.cache.get('grp:' + LAB + '|marc@decathlon.com'), '1');
  as(sb, undefined);
  ok(sb.ctx, 'api_removeGroup', { email: LAB });
  as(sb, 'marc@decathlon.com');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
});

test('groups: unknown or hidden groups are refused; a group that becomes unreadable denies quietly', () => {
  const sb = withGroups();
  for (const email of ['ghost@decathlon.com', 'secret@decathlon.com']) {
    const err = fail(sb.ctx, 'api_saveGroup', { email, role: 'lecteur' }, 'VALIDATION');
    assert.match(err.message, /Groupe introuvable ou membres non visibles/);
  }
  fail(sb.ctx, 'api_saveGroup', { email: LAB, role: 'none' }, 'VALIDATION');
  fail(sb.ctx, 'api_removeGroup', { email: LAB }, 'NOT_FOUND');
  ok(sb.ctx, 'api_saveGroup', { email: LAB, role: 'lecteur' });
  sb.env.__setGroups({ [LAB]: { members: ['marc@decathlon.com'], hidden: true } });
  as(sb, 'marc@decathlon.com');
  fail(sb.ctx, 'api_bootstrap', null, 'FORBIDDEN');
  assert.equal(sb.env.__state.cache.has('grp:' + LAB + '|marc@decathlon.com'), false, 'errors are not cached');
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
