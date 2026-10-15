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
  assert.deepEqual(settings.access, { owner: OWNER, users: [], domainRole: 'none' });
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
  assert.equal(writes.length, 19);
  const poste = md.postes[0];
  for (const name of writes) {
    const err = fail(sb.ctx, name, { month: '2026-05', id: poste._id, changes: [], email: ADMIN2, role: 'admin',
      threshold: 70, source: SOURCE_ID }, 'FORBIDDEN');
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
  const stored = JSON.parse(sb.env.PropertiesService.getScriptProperties().getProperty('ACCESS_JSON'));
  assert.deepEqual(stored.users.map((u) => u.email), [ADMIN2]);
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
