'use strict';
/**
 * Integration tests: the editing switches of Paramètres › « Saisie dans l’application » (docs/API.md §3
 * Editing, api_setEditing; §4 Config EDITING_JSON) in the GAS sandbox. Every switch, in the current month
 * (written into the source) and in a past month (snapshot only): the gated endpoints are refused before
 * anything is opened or written, the other switches' endpoints still work, and the rest of the app
 * (actions, remplacements, threshold, sync) never depends on them.
 *
 * "Today" is pinned with ctx.Config.today = 15/05/2026, so 2026-05 is the current (live) month and
 * 2026-04 a past one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadGas, plain, sheetValues } = require('../helpers/gasSandbox');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const READER = 'lea.reader@decathlon.com';
const TODAY = '2026-05-15';
const LIVE = '2026-05';
const PAST = '2026-04';
const ALL_ON = { edit: true, create: true, delete: true };

const REFUSED = {
  edit: 'La modification des postes et des applications est désactivée dans les Paramètres.',
  create: 'La création de postes et d’applications est désactivée dans les Paramètres.',
  delete: 'La suppression d’applications est désactivée dans les Paramètres.',
};

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

/** Sandbox: source saved, the current month synchronised, the past month imported; today pinned. */
function setup(props) {
  const sb = loadGas({ sources: [buildSourceSpreadsheet(LIVE)], props });
  sb.ctx.Config.today = () => TODAY;
  ok(sb.ctx, 'api_setConfig', { source: SOURCE_ID });
  ok(sb.ctx, 'api_syncNow');
  ok(sb.ctx, 'api_importMonth', { month: PAST });
  return sb;
}

/** A new Apps Script execution over the same spreadsheets / properties. */
function execution(env, email) {
  env.__setActiveUser(email);
  const sb = loadGas({ env });
  sb.ctx.Config.today = () => TODAY;
  return sb;
}

/** Every tab of the data spreadsheet and of the source, as stored: to prove a refusal wrote nothing. */
function everything(sb) {
  const dataId = sb.ctx.Config.get().dataId;
  const out = {};
  for (const tab of ['Postes', 'Applications', 'Actions', 'Replacements', 'ImportLog']) out['data/' + tab] = sheetValues(sb.env, dataId, tab);
  for (const tab of ['Suivi des postes', 'Suivi des applications']) out['source/' + tab] = sheetValues(sb.env, SOURCE_ID, tab);
  return JSON.stringify(out);
}

/** The endpoints each switch gates, with valid arguments for `month` (d = its api_getMonthData). */
const GATED = {
  edit: [
    ['api_savePostes', (m, d) => ({ month: m, changes: [{ id: d.postes[0]._id, updates: { Responsable: 'Nouveau responsable' } }] })],
    ['api_saveApplications', (m, d) => ({ month: m, changes: [{ id: d.applications[0]._id, updates: { Galink: 'Oui' } }] })],
    ['api_renameApplication', (m, d) => ({ month: m, id: d.applications[0]._id, newName: 'Renommée ' + m })],
  ],
  create: [
    ['api_addPoste', (m) => ({ month: m, record: { [KEY_POSTE]: 'NEW-' + m, 'Équipe': 'Labo Textile' } })],
    ['api_addApplication', (m) => ({ month: m, record: { [KEY_APP]: 'Nouvelle ' + m } })],
    ['api_addGenericPoste', (m) => ({ month: m })],
    ['api_getFormSchema', (m) => ({ entity: 'postes', month: m })],
  ],
  delete: [
    ['api_deleteApplication', (m, d) => ({ month: m, id: d.applications[1]._id })],
  ],
};

// ------------------------------------------------------------------------------------ defaults

test('defaults: every switch on, also when EDITING_JSON is missing or unreadable; only an explicit false turns one off', () => {
  for (const raw of [undefined, '', '{oops', 'null', '[]', '"x"', '{"edit":"false","create":0,"delete":null}']) {
    const { ctx } = loadGas({ props: raw === undefined ? undefined : { EDITING_JSON: raw } });
    assert.deepEqual(plain(ctx.Config.get().editing), ALL_ON, 'EDITING_JSON = ' + raw);
  }
  const { ctx } = loadGas({ props: { EDITING_JSON: '{"edit":false}' } });
  assert.deepEqual(plain(ctx.Config.get().editing), { edit: false, create: true, delete: true });
});

test('editing is part of api_bootstrap, api_getSettings and api_getSyncStatus (lecteurs read it too)', () => {
  const sb = setup({ EDITING_JSON: '{"create":false}' });
  const want = { edit: true, create: false, delete: true };
  assert.deepEqual(ok(sb.ctx, 'api_bootstrap').editing, want);
  assert.deepEqual(ok(sb.ctx, 'api_getSettings').editing, want);
  const st = ok(sb.ctx, 'api_getSyncStatus');
  assert.deepEqual(st.editing, want);
  assert.equal(typeof st.enabled, 'boolean', 'still the sync status');
  ok(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  const reader = execution(sb.env, READER);
  assert.deepEqual(ok(reader.ctx, 'api_bootstrap').editing, want);
  assert.deepEqual(ok(reader.ctx, 'api_getSyncStatus').editing, want);
});

// ----------------------------------------------------------------------------- api_setEditing

test('setEditing: validation before the lock, nothing written', () => {
  const sb = loadGas({ lockTimeout: true });
  const writes = sb.env.__state.propertyWrites.length;
  const cases = [
    [undefined, 'Aucun réglage à enregistrer.'],
    [{}, 'Aucun réglage à enregistrer.'],
    [{ modifier: false }, 'Réglage inconnu : « modifier ».'],
    [{ edit: true, update: false }, 'Réglage inconnu : « update ».'],
    [{ edit: 'false' }, '« edit » doit valoir true ou false.'],
    [{ create: 0 }, '« create » doit valoir true ou false.'],
    [{ delete: null }, '« delete » doit valoir true ou false.'],
  ];
  for (const [args, message] of cases) {
    assert.equal(fail(sb.ctx, 'api_setEditing', args, 'VALIDATION').message, message, JSON.stringify(args));
  }
  assert.equal(sb.env.__state.propertyWrites.length, writes, 'nothing written');
  // Valid arguments reach the lock: BUSY when another execution holds it.
  fail(sb.ctx, 'api_setEditing', { edit: false }, 'BUSY');
  assert.equal(sb.env.__state.propertyWrites.length, writes);
  assert.deepEqual(plain(sb.ctx.Config.get().editing), ALL_ON);
});

test('setEditing: a partial patch keeps the other switches, one property write each', () => {
  const sb = setup();
  const props = sb.env.PropertiesService.getScriptProperties();
  let writes = sb.env.__state.propertyWrites.length;
  function set(patch, want) {
    const { ctx, env } = execution(sb.env);
    assert.deepEqual(ok(ctx, 'api_setEditing', patch), { editing: want });
    assert.deepEqual(env.__state.propertyWrites.slice(writes), ['EDITING_JSON'], 'one write: ' + JSON.stringify(patch));
    writes = env.__state.propertyWrites.length;
    assert.deepEqual(JSON.parse(props.getProperty('EDITING_JSON')), want);
    assert.deepEqual(ok(execution(sb.env).ctx, 'api_bootstrap').editing, want);
  }
  set({ create: false }, { edit: true, create: false, delete: true });
  set({ delete: false }, { edit: true, create: false, delete: false });
  set({ edit: false, create: true }, { edit: false, create: true, delete: false });
  set({ edit: false }, { edit: false, create: true, delete: false });
  set({ edit: true, create: true, delete: true }, ALL_ON);
});

test('setEditing: merges into the stored switches read under the lock (another admin changed one meanwhile)', () => {
  const sb = setup();
  const { ctx, env } = execution(sb.env);
  assert.deepEqual(ok(ctx, 'api_getSettings').editing, ALL_ON); // this execution's memo: all on
  // Another execution turns deletion off right before this one takes the lock.
  env.__state.onWaitLock = () => env.PropertiesService.getScriptProperties()
    .setProperty('EDITING_JSON', JSON.stringify({ edit: true, create: true, delete: false }));
  assert.deepEqual(ok(ctx, 'api_setEditing', { create: false }).editing, { edit: true, create: false, delete: false });
});

test('setEditing is admin only', () => {
  const sb = setup();
  ok(sb.ctx, 'api_saveUser', { email: READER, role: 'lecteur' });
  const reader = execution(sb.env, READER);
  const err = fail(reader.ctx, 'api_setEditing', { edit: false }, 'FORBIDDEN');
  assert.equal(err.message, 'Action réservée aux administrateurs.');
  assert.deepEqual(ok(execution(sb.env).ctx, 'api_getSettings').editing, ALL_ON);
});

// --------------------------------------------------------------------------------- the gates

for (const kind of Object.keys(GATED)) {
  for (const month of [LIVE, PAST]) {
    const when = month === LIVE ? 'current month' : 'past month';
    test(`${kind} off (${when}): its endpoints are refused before anything is opened; the other switches still work`, () => {
      const sb = setup();
      ok(sb.ctx, 'api_setEditing', { [kind]: false });
      const data = ok(execution(sb.env).ctx, 'api_getMonthData', { month });
      const before = everything(sb);

      const { ctx, env } = execution(sb.env);
      const opened = env.__state.opened.length;
      for (const [name, args] of GATED[kind]) {
        const err = fail(ctx, name, args(month, data), 'FORBIDDEN');
        assert.equal(err.message, REFUSED[kind], name);
      }
      assert.deepEqual(env.__state.opened.slice(opened), [], 'no spreadsheet opened (source nor data)');
      assert.equal(everything(sb), before, 'nothing written');

      // The endpoints of the two other switches are unaffected.
      for (const other of Object.keys(GATED).filter((k) => k !== kind)) {
        for (const [name, args] of GATED[other]) ok(execution(sb.env).ctx, name, args(month, data));
      }
      // Turning the switch back on opens its endpoints again.
      ok(execution(sb.env).ctx, 'api_setEditing', { [kind]: true });
      const [name, args] = GATED[kind][0];
      const fresh = ok(execution(sb.env).ctx, 'api_getMonthData', { month });
      ok(execution(sb.env).ctx, name, args(month, kind === 'delete' ? fresh : data));
    });
  }
}

test('all switches off: actions, remplacements, threshold, the sync and the switches themselves still work', () => {
  const sb = setup();
  ok(sb.ctx, 'api_setEditing', { edit: false, create: false, delete: false });
  const { ctx } = execution(sb.env);
  assert.deepEqual(ok(ctx, 'api_bootstrap').editing, { edit: false, create: false, delete: false });
  ok(ctx, 'api_getMonthData', { month: LIVE });

  const action = ok(ctx, 'api_addAction', { target_type: 'poste', target_name: 'LAB-TEX-01', equipe: 'Labo Textile',
    action: 'Installer l’EDR' });
  assert.equal(ok(ctx, 'api_updateAction', { id: action.id, updates: { status: 'Terminé' } }).status, 'Terminé');
  ok(ctx, 'api_deleteAction', { id: action.id });
  const rep = ok(ctx, 'api_addReplacement', { old_poste: 'LAB-TEX-01', new_poste: 'LAB-TEX-09' });
  assert.equal(ok(ctx, 'api_updateReplacement', { id: rep.id, updates: { comment: 'ok' } }).comment, 'ok');
  ok(ctx, 'api_deleteReplacement', { id: rep.id });

  assert.equal(ok(ctx, 'api_setThreshold', { threshold: 70 }).threshold, 70);
  ok(ctx, 'api_syncNow');
  assert.deepEqual(ok(ctx, 'api_setEditing', { edit: true }).editing, { edit: true, create: false, delete: false });
  assert.deepEqual(ok(execution(sb.env).ctx, 'api_getSyncStatus').editing, { edit: true, create: false, delete: false });
});
