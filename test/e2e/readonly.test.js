'use strict';
/**
 * E2E tests of the read-only mode (role lecteur, docs/API.md §3 "Roles", docs/DESIGN.md "Signed-in account"):
 * every data page hides its write controls (hidden, not disabled) and never calls an admin-only endpoint,
 * while everything that only reads (filters, tabs, drawers, CSV export, charts, diff, sync status) stays.
 * A light check confirms that admins still get the controls.
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/readonly.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../fixtures/data');
const { ACCOUNTS, openApp, chooseOption } = require('./harness');

const MONTH = '2026-05';
const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const posteId = (name) => 'p-' + MONTH + '-' + (data.MONTHS[MONTH].postes.findIndex((p) => p[KEY_POSTE] === name) + 1);
const appId = (name) => 'a-' + MONTH + '-' + (data.MONTHS[MONTH].applications.findIndex((a) => a[KEY_APP] === name) + 1);

/** Every endpoint a lecteur must never call (the server answers FORBIDDEN). */
const ADMIN_APIS = ['api_setConfig', 'api_syncNow', 'api_enableSync', 'api_savePostes', 'api_addGenericPoste', 'api_addPoste',
  'api_getFormSchema', 'api_saveApplications',
  'api_addApplication', 'api_deleteApplication', 'api_renameApplication', 'api_addAction', 'api_updateAction',
  'api_deleteAction', 'api_addReplacement', 'api_updateReplacement', 'api_deleteReplacement',
  'api_getSettings', 'api_setThreshold', 'api_setEditing', 'api_saveUser', 'api_removeUser', 'api_setDomainRole', 'api_saveGroup',
  'api_removeGroup'];

/** Write controls of the data pages (ids, classes of row actions / inline editing, dirty bar). */
const WRITE_SELECTORS = ['#dashboard-sync', '#sync-now', '#sync-enable', '.edit-note', '#postes-add-generic', '#postes-add',
  '.form-panel', '#apps-add', '#app-rename', '#app-delete', '#drawer-add-action', '#action-add', '#replacement-add', '.btn-delete',
  '.btn-mark-done', '.cell-editable', '.th-editable', '.cell-editor-host', '.etable-dirtybar', '.etable-save',
  '.etable-cancel', '.modal'];

/** Button labels of write actions (docs/DESIGN.md "Copy"). */
const WRITE_LABELS = /^(Synchroniser maintenant|Activer la synchronisation horaire|Nouveau poste|Poste générique|Créer le poste|Nouvelle application|Ajouter l’application|Abandonner|Renommer|Supprimer|Nouvelle action|Nouveau remplacement|Enregistrer.*|Annuler)$/;

const LECTEUR_EMPTY = 'Aucune donnée pour le moment. Les données arrivent à la prochaine synchronisation horaire.';

async function withApp(options, fn) {
  const app = await openApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** No write control in the page, its drawers and its dialogs (the shell is out of scope here). */
async function assertNoWriteControls(page, where) {
  for (const sel of WRITE_SELECTORS) {
    assert.equal(await page.$$eval(`#main ${sel}, #modal-root ${sel}, .drawer ${sel}, body > ${sel}`, (ns) => ns.length), 0,
      `${where}: no ${sel}`);
  }
  // Column headers are sort buttons, not actions (the replacements table has a « Nouveau poste » column).
  const labels = await page.$$eval('#main button, #modal-root button, .drawer button',
    (bs) => bs.filter((b) => !b.closest('thead')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(labels.filter((l) => WRITE_LABELS.test(l)), [], `${where}: no write button`);
}

async function assertNoAdminCalls(app, where) {
  const names = (await app.calls()).map((c) => c.name);
  assert.deepEqual(names.filter((n) => ADMIN_APIS.includes(n)), [], `${where}: no admin-only call`);
  // The mock enforces the role: a FORBIDDEN answer would show up as an error toast.
  assert.equal(await app.page.$$eval('.toast', (ts) => ts.filter((t) => /Erreur/.test(t.textContent)).length), 0,
    `${where}: no error toast`);
}

async function closeDrawer(app) {
  await app.page.keyboard.press('Escape');
  await app.page.waitForSelector('.drawer', { state: 'detached' });
}

// ------------------------------------------------------------------------------------------- lecteur

describe('read-only mode (lecteur)', () => {
  test('dashboard: the sync status without its actions, the charts stay', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR }, async (app) => {
      const { page } = app;
      assert.equal(await page.evaluate(() => State.canEdit()), false);
      await page.waitForSelector('#dashboard-body .kpi-strip');
      await assertNoWriteControls(page, 'dashboard');
      // Sync status in the app bar (api_getSyncStatus is allowed): no button, no link to the private source.
      await page.click('#sync-chip');
      await page.waitForSelector('#sync-panel');
      assert.equal(await page.$$eval('#sync-panel button, #sync-panel a', (ns) => ns.length), 0);
      assert.match(await page.textContent('#sync-panel'), /Dernière modification/);
      await page.keyboard.press('Escape');
      // Charts are drawn; the conformity details still expand.
      assert.ok((await app.plots()).some((p) => p.id === 'chart-gauge-postes'));
      await page.click('#detail-postes details:not(.is-zero) summary');
      await assertNoAdminCalls(app, 'dashboard');
      assert.deepEqual(app.errors, []);
    });
  });

  test('postes: CSV only in the header, plain cells, drawer without « Nouvelle action »', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR, page: 'postes' }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table tbody tr[data-id]');
      const headerButtons = await page.$$eval('#main .page-header button', (bs) => bs.map((b) => b.id));
      assert.deepEqual(headerButtons, ['postes-export-csv']);
      assert.equal(await page.isDisabled('#postes-export-csv'), false);
      await assertNoWriteControls(page, 'postes');

      // A click on a source cell opens no editor: the row opens the drawer instead.
      const id = posteId('LAB-MEC-01');
      await page.click(`#postes-table tr[data-id="${id}"] td[data-col="Responsable"]`);
      await page.waitForSelector('.drawer.open #poste-drawer');
      await app.waitIdle();
      await page.waitForSelector('#drawer-actions');
      assert.equal(await page.$('#drawer-actions .loading-state'), null);
      await assertNoWriteControls(page, 'postes drawer');
      await closeDrawer(app);

      // Filters and CSV export still work.
      await chooseOption(page, '#postes-conformity', 'Non conformes');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#postes-export-csv')]);
      assert.equal(download.suggestedFilename(), 'postes_' + MONTH + '.csv');
      await app.waitIdle();
      await assertNoWriteControls(page, 'postes after filter');
      await assertNoAdminCalls(app, 'postes');
      // No creation form: its fields are never asked for (api_getFormSchema is admin only).
      assert.equal((await app.calls()).filter((c) => c.name === 'api_getFormSchema').length, 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('applications: no « Nouvelle application », Galink / IDP read only, drawer without rename / delete', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR, page: 'apps' }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#apps-table tbody tr[data-id]');
      const headerButtons = await page.$$eval('#main .page-header button', (bs) => bs.map((b) => b.id));
      assert.deepEqual(headerButtons, ['apps-export-csv']);
      assert.ok(await page.$('#apps-migration .migration-table'), 'migration ledger');
      await assertNoWriteControls(page, 'apps');

      const id = appId('Dropbox perso');
      await page.click(`#apps-table tr[data-id="${id}"] td[data-col="Galink"]`);
      await page.waitForSelector('.drawer.open #app-drawer');
      await app.waitIdle();
      assert.ok(await page.$('#app-drawer-criteria li[data-criterion="galink"]'));
      await assertNoWriteControls(page, 'apps drawer');
      await closeDrawer(app);

      await page.click(`#apps-table tr[data-id="${id}"] .apps-key`);
      await page.waitForSelector('.drawer.open #app-drawer');
      await app.waitIdle();
      await assertNoWriteControls(page, 'apps drawer (key)');
      await closeDrawer(app);
      await assertNoAdminCalls(app, 'apps');
      assert.deepEqual(app.errors, []);
    });
  });

  test('actions: no create / delete / record, details drawer, replacements and diff readable', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR, page: 'actions' }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#actions-table tbody tr[data-id]');
      assert.equal(await page.$$eval('#main .page-header button', (bs) => bs.length), 0, 'no header action');
      assert.equal(await page.$('#actions-table th:last-child:empty'), null, 'no empty row-action column');
      await assertNoWriteControls(page, 'remediation');

      // Row click: a read-only details drawer, never the edit form.
      await page.click('#actions-table tr[data-id="a-0002"] td[data-col="action"]');
      await page.waitForSelector('.drawer.open #action-drawer');
      assert.equal(await page.getAttribute('#action-drawer', 'data-id'), 'a-0002');
      const fixture = data.ACTIONS.find((a) => a.id === 'a-0002');
      assert.equal((await page.textContent('#action-drawer .action-title')).trim(), fixture.action);
      await assertNoWriteControls(page, 'action drawer');
      await closeDrawer(app);

      // Status filter still applies.
      await chooseOption(page, '#action-filter-status', 'En cours');
      assert.deepEqual(await page.$$eval('#actions-table tbody tr[data-id]', (trs) => trs.map((t) => t.dataset.id)), ['a-0002']);

      // Replacements: table only, rows not clickable.
      await page.click('#actions-tabs .tab[data-tab="replacements"]');
      await page.waitForSelector('#replacements-table tbody tr[data-id]');
      await assertNoWriteControls(page, 'replacements');
      assert.equal(await page.$$eval('#replacements-table tr.row-clickable', (trs) => trs.length), 0);
      await page.click('#replacements-table tbody tr[data-id] td[data-col="comment"]');
      await app.waitIdle();
      assert.equal(await page.$('.drawer, .modal'), null);

      // Change detection: allowed (api_getDiff); resolved actions without « Enregistrer comme terminée ».
      await page.click('#actions-tabs .tab[data-tab="diff"]');
      await page.waitForSelector('#diff-postes');
      await app.waitIdle();
      assert.ok((await app.calls()).some((c) => c.name === 'api_getDiff'));
      assert.deepEqual(await page.$$eval('#diff-postes-resolved tbody tr', (trs) => trs.map((t) => t.dataset.name)), ['LAB-CHA-01']);
      assert.notEqual((await page.textContent('#diff-postes-resolved tbody tr td:last-child')).trim(), '');
      await chooseOption(page, '#diff-old', 'Mai 2026');
      await chooseOption(page, '#diff-old', 'Avril 2026');
      await page.waitForSelector('#diff-postes');
      await app.waitIdle();
      await assertNoWriteControls(page, 'diff');
      await assertNoAdminCalls(app, 'actions');
      assert.deepEqual(app.errors, []);
    });
  });

  test('timeline: charts and « Actualiser » (a read), nothing else', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR, page: 'timeline' }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#timeline-kpi-table');
      assert.ok((await app.plots()).some((p) => p.id === 'chart-timeline-taux'));
      await assertNoWriteControls(page, 'timeline');
      const before = (await app.calls()).filter((c) => c.name === 'api_getTimeline').length;
      await page.click('#timeline-refresh');
      await app.waitIdle();
      assert.equal((await app.calls()).filter((c) => c.name === 'api_getTimeline').length, before + 1);
      await assertNoAdminCalls(app, 'timeline');
      assert.deepEqual(app.errors, []);
    });
  });

  test('no month imported: empty states name an administrator, without any action', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR, empty: true }, async (app) => {
      const { page } = app;
      const cases = [['dashboard', '#dashboard-empty'], ['postes', '#postes-empty'], ['apps', '#apps-empty'],
        ['timeline', '#timeline-empty']];
      for (const [pageId, sel] of cases) {
        if (pageId !== 'dashboard') await app.goto(pageId);
        await page.waitForSelector(sel);
        assert.equal((await page.textContent(sel)).replace(/\s+/g, ' ').trim(), LECTEUR_EMPTY, pageId);
        assert.equal(await page.$$eval(`${sel} button, ${sel} a`, (ns) => ns.length), 0, `${pageId}: no action in the empty state`);
        // « Actualiser » (timeline) only reloads: the one header button a lecteur keeps.
        assert.deepEqual(await page.$$eval('#main .page-header button', (bs) => bs.map((b) => b.id)),
          pageId === 'timeline' ? ['timeline-refresh'] : [], `${pageId}: no header action`);
        await assertNoWriteControls(page, pageId + ' (empty)');
      }
      await assertNoAdminCalls(app, 'empty');
      assert.deepEqual(app.errors, []);
    });
  });
});

// --------------------------------------------------------------------------------------------- admin

describe('admin still edits (light check)', () => {
  test('write controls are present for the owner', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      assert.equal(await page.evaluate(() => State.canEdit()), true);
      await page.click('#sync-chip');
      await page.waitForSelector('#sync-panel #sync-now');
      await page.keyboard.press('Escape');

      await app.goto('postes');
      await page.waitForSelector('#postes-table .cell-editable');
      assert.ok(await page.$('#postes-add-generic'));
      assert.ok(await page.$('#postes-add'));
      assert.ok(await page.$('#postes-table .etable-dirtybar'));
      await page.click(`#postes-table tr[data-id="${posteId('LAB-MEC-01')}"] .postes-key`);
      await page.waitForSelector('.drawer.open #drawer-add-action');
      await closeDrawer(app);

      await app.goto('apps');
      await page.waitForSelector('#apps-table td.cell-editable[data-col="Galink"]');
      assert.ok(await page.$('#apps-add'));
      await page.click(`#apps-table tr[data-id="${appId('Dropbox perso')}"] .apps-key`);
      await page.waitForSelector('.drawer.open #app-rename');
      assert.ok(await page.$('.drawer #app-delete'));
      await closeDrawer(app);

      await app.goto('actions');
      await page.waitForSelector('#actions-table .btn-delete');
      assert.ok(await page.$('#action-add'));
      await page.click('#actions-tabs .tab[data-tab="diff"]');
      await page.waitForSelector('#diff-postes-resolved .btn-mark-done');
      assert.deepEqual(app.errors, []);
    });
  });
});
