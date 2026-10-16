'use strict';
/**
 * E2E tests of the editing switches of Paramètres › « Saisie dans l’application » on the Postes and
 * Applications pages (docs/API.md §5 State.can, §6 Postes / Applications): the controls each switch hides,
 * the admins' edit note, what stays (actions, Paramètres), and writes refused behind an open page (switch
 * turned off in the mock while the page shows its controls).
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/editing.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../fixtures/data');
const { openApp, chooseOption } = require('./harness');

const MONTH = '2026-05';
const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const PANEL = '.drawer.form-panel';

const posteId = (name) => 'p-' + MONTH + '-' + (data.MONTHS[MONTH].postes.findIndex((p) => p[KEY_POSTE] === name) + 1);
const appId = (name) => 'a-' + MONTH + '-' + (data.MONTHS[MONTH].applications.findIndex((a) => a[KEY_APP] === name) + 1);
const rowSel = (table, id) => `#${table}-table tbody tr[data-id="${id}"]`;
const cellSel = (table, id, col) => `${rowSel(table, id)} td[data-col="${col}"]`;

async function withApp(options, fn) {
  const app = await openApp(Object.assign({ currentMonth: MONTH }, options));
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function callsNamed(app, name) {
  return (await app.calls()).filter((c) => c.name === name);
}

async function toasts(page) {
  return page.$$eval('#toast-root .toast-msg', (ns) => ns.map((n) => n.textContent));
}

async function headerButtons(page) {
  return page.$$eval('#main .page-header button', (bs) => bs.map((b) => b.id));
}

async function editableCells(page, table) {
  return page.$$eval(`#${table}-table td.cell-editable`, (ns) => ns.length);
}

async function openDrawerFor(app, table, id) {
  await app.page.click(`${rowSel(table, id)} .${table}-key`);
  await app.page.waitForSelector('.drawer.open');
  await app.waitIdle();
}

async function drawerButtons(page) {
  return page.$$eval('.drawer .drawer-buttons button', (bs) => bs.map((b) => b.id));
}

/** Marks the mounted page: a re-mount replaces the element, so the marker is gone. */
async function markPage(page) {
  await page.evaluate(() => { document.querySelector('#main .page').__marker = 1; });
}
async function sameMount(page) {
  return page.evaluate(() => document.querySelector('#main .page').__marker === 1);
}

describe('editing switches: controls', () => {
  test('modification off: read-only cells on both pages, the lock note, « Renommer » gone, « Supprimer » kept', async () => {
    await withApp({ page: 'postes', editing: { edit: false } }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table');
      assert.equal(await editableCells(page, 'postes'), 0);
      assert.equal(await page.$eval('#postes-table', (t) => t.closest('.etable').classList.contains('is-readonly')), true);
      assert.equal(await page.$('#postes-table .etable-dirtybar'), null);
      assert.deepEqual(await headerButtons(page), ['postes-export-csv', 'postes-add-generic', 'postes-add']);
      assert.equal(await page.getAttribute('#postes-edit-note', 'data-locked'), '1');
      assert.equal(await page.textContent('#postes-edit-note'), 'Les modifications sont écrites dans le Google Sheet ' +
        'source. La modification des entrées est désactivée dans les Paramètres.');
      // A click on a cell opens the drawer (as for lecteurs), never an editor.
      await page.click(cellSel('postes', posteId('LAB-MEC-01'), 'Responsable'));
      await page.waitForSelector('.drawer.open');
      assert.equal(await page.$('.cell-editor-host'), null);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });

      await app.goto('apps');
      await page.waitForSelector('#apps-table');
      assert.equal(await editableCells(page, 'apps'), 0, 'Galink / IDP included');
      assert.equal(await page.textContent('#apps-edit-note'), 'Les modifications sont écrites dans le Google Sheet ' +
        'source (Galink et IDP restent dans l’application). La modification des entrées est désactivée dans les Paramètres.');
      await openDrawerFor(app, 'apps', appId('Figma'));
      assert.deepEqual(await drawerButtons(page), ['app-delete']);
      assert.equal(await page.locator('#drawer-add-action').count(), 1, '« Nouvelle action » stays');
      assert.equal((await callsNamed(app, 'api_savePostes')).length + (await callsNamed(app, 'api_saveApplications')).length, 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('creation off: no create buttons and no schema prefetch; cells stay editable', async () => {
    await withApp({ page: 'postes', editing: { create: false } }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table');
      assert.deepEqual(await headerButtons(page), ['postes-export-csv']);
      assert.ok(await editableCells(page, 'postes') > 0);
      assert.equal(await page.textContent('#postes-edit-note'), 'Les modifications sont écrites dans le Google Sheet ' +
        'source. La création des entrées est désactivée dans les Paramètres.');
      await page.hover('#postes-export-csv');
      await page.focus('#postes-export-csv');
      await app.goto('apps');
      await page.waitForSelector('#apps-table');
      assert.deepEqual(await headerButtons(page), ['apps-export-csv']);
      await page.hover('#apps-export-csv');
      await app.waitIdle();
      assert.equal((await callsNamed(app, 'api_getFormSchema')).length, 0, 'never prefetched');
      assert.deepEqual(app.errors, []);
    });
  });

  test('deletion off: « Supprimer » gone from the application drawer; Postes has nothing locked', async () => {
    await withApp({ page: 'apps', editing: { delete: false } }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#apps-table');
      assert.deepEqual(await headerButtons(page), ['apps-export-csv', 'apps-add']);
      assert.equal(await page.getAttribute('#apps-edit-note', 'data-locked'), '1');
      assert.match(await page.textContent('#apps-edit-note'), /La suppression des entrées est désactivée dans les Paramètres\.$/);
      await openDrawerFor(app, 'apps', appId('Figma'));
      assert.deepEqual(await drawerButtons(page), ['app-rename']);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });
      await app.goto('postes');
      await page.waitForSelector('#postes-edit-note');
      assert.equal(await page.getAttribute('#postes-edit-note', 'data-locked'), '0');
      assert.equal(await page.textContent('#postes-edit-note'), 'Les modifications sont écrites dans le Google Sheet source.');
      assert.deepEqual(app.errors, []);
    });
  });

  test('everything off: only the lock sentence; Actions, « Nouvelle action » and Paramètres still work', async () => {
    await withApp({ page: 'postes', editing: { edit: false, create: false, delete: false } }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table');
      assert.deepEqual(await headerButtons(page), ['postes-export-csv']);
      assert.equal(await page.textContent('#postes-edit-note'),
        'La modification et la création des entrées sont désactivées dans les Paramètres.');
      await app.goto('apps');
      assert.equal(await page.textContent('#apps-edit-note'),
        'La modification, la création et la suppression des entrées sont désactivées dans les Paramètres.');
      await openDrawerFor(app, 'apps', appId('Figma'));
      assert.equal(await page.$('.drawer .drawer-buttons'), null);
      assert.equal(await page.locator('#drawer-add-action').count(), 1);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });

      await app.goto('actions');
      await page.click('#action-add');
      await page.waitForSelector('.modal [data-name="target_name"]');
      await chooseOption(page, '.modal [data-name="target_name"]', 'LAB-CHA-02');
      await page.fill('.modal [data-name="action"]', 'Installer l’EDR');
      await page.click('.modal .modal-footer .btn-primary');
      await page.waitForSelector('.modal', { state: 'detached' });
      await app.waitIdle();
      assert.equal((await callsNamed(app, 'api_addAction')).length, 1);

      await app.goto('settings');
      assert.equal(await page.isVisible('#settings-threshold-submit'), true);
      await page.click('#settings-tab-saisie');
      await page.waitForSelector('#settings-editing-edit');
      assert.deepEqual(await page.$$eval('#settings-editing [role="switch"]', (ns) => ns.map((n) => n.getAttribute('aria-checked'))),
        ['false', 'false', 'false']);
      assert.equal((await toasts(page)).some((t) => /Erreur/.test(t)), false);
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('editing switches: turned off behind an open page', () => {
  test('a cell save is refused: the message, the bootstrap reloads, editors go without a re-mount', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table');
      await markPage(page);
      const cell = cellSel('postes', posteId('LAB-MEC-01'), 'Responsable');
      await page.click(cell);
      await page.fill(`${cell} .cell-editor-host input`, 'Zoé Lefèvre');
      await page.press(`${cell} .cell-editor-host input`, 'Enter');
      await page.waitForSelector('#postes-table .etable-dirtybar:not([hidden])');
      const boots = (await callsNamed(app, 'api_bootstrap')).length;

      await page.evaluate(() => { window.__mock.db.editing.edit = false; });
      await page.click('#postes-table .etable-save');
      await app.waitIdle();
      await page.waitForSelector('#postes-edit-note[data-locked="1"]');
      const msgs = await toasts(page);
      assert.ok(msgs.includes('Erreur : La modification des postes et des applications est désactivée dans les Paramètres.'), msgs.join(' | '));
      assert.ok(msgs.includes('Modification des entrées désactivée : les modifications non enregistrées sont abandonnées.'), msgs.join(' | '));
      assert.equal((await callsNamed(app, 'api_bootstrap')).length, boots + 1, 'the bootstrap was reloaded');
      assert.deepEqual(await page.evaluate(() => State.get().editing), { edit: false, create: true, delete: true });
      assert.equal(await editableCells(page, 'postes'), 0);
      assert.equal(await page.$('#postes-table .etable-dirtybar'), null);
      assert.equal(await sameMount(page), true, 'not re-mounted');
      assert.deepEqual(await headerButtons(page), ['postes-export-csv', 'postes-add-generic', 'postes-add']);
      assert.deepEqual(app.errors, []);
    });
  });

  test('the creation panel is refused: it keeps the values and shows the message; the create buttons go', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table');
      await markPage(page);
      await page.click('#postes-add');
      await page.waitForSelector(`${PANEL} .form-sections`);
      await app.waitIdle();
      await page.fill(`${PANEL} [data-name="${KEY_POSTE}"]`, 'LAB-NEW-09');
      await chooseOption(page, `${PANEL} [data-name="Équipe"]`, 'Labo Textile');

      await page.evaluate(() => { window.__mock.db.editing.create = false; });
      await page.click(`${PANEL} .drawer-footer button:has-text("Créer le poste")`);
      await app.waitIdle();
      await page.waitForSelector(`${PANEL} .form-alert .alert-error`);
      assert.equal((await page.textContent(`${PANEL} .form-alert .alert-error`)).trim(),
        'Erreur : La création de postes et d’applications est désactivée dans les Paramètres.');
      assert.equal(await page.inputValue(`${PANEL} [data-name="${KEY_POSTE}"]`), 'LAB-NEW-09', 'values kept');
      await page.waitForFunction(() => !document.getElementById('postes-add'));
      assert.deepEqual(await headerButtons(page), ['postes-export-csv']);
      assert.equal(await page.isVisible(PANEL), true, 'the panel stays open');
      assert.equal(await sameMount(page), true, 'not re-mounted');
      assert.equal(await page.textContent('#postes-edit-note'), 'Les modifications sont écrites dans le Google Sheet ' +
        'source. La création des entrées est désactivée dans les Paramètres.');
      assert.deepEqual(app.errors, []);
    });
  });

  test('« Poste générique » and « Supprimer » refused: the message, then the controls go', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#apps-table');
      await openDrawerFor(app, 'apps', appId('Figma'));
      await page.evaluate(() => { window.__mock.db.editing.delete = false; });
      await page.click('#app-delete');
      await page.click('.modal .modal-footer button:has-text("Supprimer")');
      await page.waitForSelector('.modal .confirm-error .alert-error');
      assert.match(await page.textContent('.modal .confirm-error'), /La suppression d’applications est désactivée dans les Paramètres\./);
      await app.waitIdle();
      assert.deepEqual(await page.evaluate(() => State.get().editing), { edit: true, create: true, delete: false });
      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal', { state: 'detached' });
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });
      await openDrawerFor(app, 'apps', appId('Figma'));
      assert.deepEqual(await drawerButtons(page), ['app-rename'], 'the next opening follows the switch');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });

      await app.goto('postes');
      await markPage(page);
      await page.evaluate(() => { window.__mock.db.editing.create = false; });
      await page.click('#postes-add-generic');
      await app.waitIdle();
      await page.waitForFunction(() => !document.getElementById('postes-add-generic'));
      assert.ok((await toasts(page)).includes('Erreur : La création de postes et d’applications est désactivée dans les Paramètres.'));
      assert.equal(await sameMount(page), true, 'not re-mounted');
      assert.deepEqual(app.errors, []);
    });
  });

  test('another admin turns a switch back on: the sync status poll brings it, controls come back in place', async () => {
    await withApp({ page: 'postes', editing: { create: false } }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table');
      assert.deepEqual(await headerButtons(page), ['postes-export-csv']);
      await markPage(page);
      await page.evaluate(() => { window.__mock.db.editing.create = true; });
      await page.click('#sync-chip');   // opening the panel refreshes the status (api_getSyncStatus), like the poll
      await app.waitIdle();
      await page.waitForSelector('#postes-add');
      assert.deepEqual(await headerButtons(page), ['postes-export-csv', 'postes-add-generic', 'postes-add']);
      assert.equal(await page.isEnabled('#postes-add'), true);
      assert.equal(await page.getAttribute('#postes-edit-note', 'data-locked'), '0');
      assert.equal(await sameMount(page), true, 'not re-mounted');
      assert.deepEqual(app.errors, []);
    });
  });
});
