'use strict';
/**
 * E2E tests of the Postes and Applications pages (docs/API.md §6 "Postes" / "Applications").
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/postes_apps.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const data = require('../fixtures/data');
const { openApp, chooseOption, optionLabels, dropdownValue } = require('./harness');

const MONTH = '2026-05';
const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const GENERIC = 'Poste générique Decathlon';

// Mock ids are deterministic: 'p-<month>-<index+1>' / 'a-<month>-<index+1>' (test/fixtures/mockRun.js).
const posteId = (name) => 'p-' + MONTH + '-' + (data.MONTHS[MONTH].postes.findIndex((p) => p[KEY_POSTE] === name) + 1);
const appId = (name) => 'a-' + MONTH + '-' + (data.MONTHS[MONTH].applications.findIndex((a) => a[KEY_APP] === name) + 1);

async function withApp(options, fn) {
  const app = await openApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const rowSel = (table, id) => `#${table}-table tbody tr[data-id="${id}"]`;
const cellSel = (table, id, col) => `${rowSel(table, id)} td[data-col="${col}"]`;

async function rowIds(page, table) {
  return page.$$eval(`#${table}-table tbody tr[data-id]`, (trs) => trs.map((tr) => tr.dataset.id));
}

async function callsNamed(app, name) {
  return (await app.calls()).filter((c) => c.name === name);
}

/**
 * Edits one table cell and leaves it dirty: option columns open a UI.dropdown (size sm) at once, date
 * columns a UI.dateField, the others a text input (Enter commits).
 */
async function editCell(page, table, id, col, value) {
  const cell = cellSel(table, id, col);
  await page.click(cell);
  await page.waitForSelector(`${cell} .cell-editor-host`);
  if (await page.$(`${cell} .dd-trigger`)) {
    await chooseOption(page, `${cell} .dd-trigger`, value);
  } else {
    const editor = `${cell} .cell-editor-host input`;
    await page.fill(editor, value);
    await page.press(editor, 'Enter');
  }
  await page.waitForSelector(`${cell} .cell-editor-host`, { state: 'detached' });
}

async function saveTable(app, table) {
  await app.page.click(`#${table}-table .etable-save`);
  await app.waitIdle();
}

async function openDrawerFor(app, table, id) {
  if (await app.page.$('.drawer')) {
    await app.page.keyboard.press('Escape');
    await app.page.waitForSelector('.drawer', { state: 'detached' });
  }
  await app.page.click(`${rowSel(table, id)} .${table}-key`);
  await app.page.waitForSelector('.drawer.open');
  await app.waitIdle();
}

async function modalButton(page, label) {
  await page.click(`.modal-footer button:has-text("${label}")`);
}

/** Waits until the trimmed text of `selector` equals `text` (UI updates are asynchronous). */
async function waitText(page, selector, text) {
  await page.waitForFunction(([sel, t]) => {
    const n = document.querySelector(sel);
    return !!n && n.textContent.trim() === t;
  }, [selector, text], { timeout: 5000 }).catch(() => {});
  assert.equal((await page.textContent(selector)).trim(), text);
}

async function toasts(page) {
  return page.$$eval('#toast-root .toast-msg', (ns) => ns.map((n) => n.textContent));
}

const todayFr = () => new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric',
  timeZone: 'Europe/Paris' }).format(new Date());

/** No native controls / tooltips left in the page or its overlays (docs/DESIGN.md, js_controls.html). */
async function assertNoNativeControls(page) {
  assert.equal(await page.$$eval('select, input[type=date], input[type=month], input[list], datalist, [title]',
    (ns) => ns.map((n) => n.outerHTML.slice(0, 80))).then((l) => l.length), 0);
}

// ---------------------------------------------------------------------------------------- Postes

describe('postes page', () => {
  test('renders the 2026-05 inventory (column order, computed columns, XSS probe as text)', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main h1')).trim(), 'Postes');
      assert.equal(await page.getAttribute('#postes-caption', 'data-month'), MONTH);
      assert.equal(await page.textContent('#postes-caption'), 'Mai 2026 · Export ' + MONTH);
      // No emoji anywhere in the page chrome (docs/DESIGN.md).
      assert.doesNotMatch(await page.textContent('#main'), /\p{Extended_Pictographic}/u);
      assert.equal((await page.textContent('#postes-add-generic')).trim(), 'Ajouter un poste générique');
      assert.equal((await page.textContent('#postes-export-csv')).trim(), 'Exporter CSV');
      // Header hints are custom tooltips (aria-describedby), never title=.
      assert.match(await page.evaluate(() => {
        const b = document.getElementById('postes-export-csv');
        return document.getElementById(b.getAttribute('aria-describedby').split(' ')[0]).textContent;
      }), /filtres compris/);
      await assertNoNativeControls(page);
      // The conformity filter is a UI.dropdown.
      assert.equal(await page.getAttribute('#postes-conformity', 'aria-haspopup'), 'listbox');
      assert.deepEqual(await optionLabels(page, '#postes-conformity'), ['Toutes', 'Conformes', 'Non conformes']);

      const ids = await rowIds(page, 'postes');
      assert.equal(ids.length, data.MONTHS[MONTH].postes.length);

      const headers = await page.$$eval('#postes-table thead th', (ths) => ths.map((th) => th.textContent.replace(/[▲▼]/g, '').trim()));
      const expected = [KEY_POSTE, 'Score', 'Applis'].concat(data.POSTES_HEADERS.filter((h) => h !== KEY_POSTE));
      assert.deepEqual(headers, expected);

      // Key column is read-only, source columns are editable.
      assert.equal(await page.$eval(cellSel('postes', ids[0], KEY_POSTE), (td) => td.classList.contains('cell-editable')), false);
      assert.equal(await page.$eval(cellSel('postes', ids[0], 'Responsable'), (td) => td.classList.contains('cell-editable')), true);

      // Score badge from « Score conformité », Applis count from the applications' « Installé sur poste ».
      assert.equal((await page.textContent(cellSel('postes', posteId('LAB-MEC-01'), '_score'))).trim(), '40,0\u202f%');
      // The source « Score conformité » is shown with the same fr-FR notation as the computed score.
      assert.equal((await page.textContent(cellSel('postes', posteId('LAB-MEC-01'), 'Score conformité'))).trim(), '40,0\u202f%');
      assert.equal((await page.textContent(cellSel('postes', posteId('LAB-CHA-01'), '_apps'))).trim(), '1');
      assert.equal((await page.textContent(cellSel('postes', posteId('LAB-TEX-03'), '_apps'))).trim(), '0');

      // Header counts: 5 conformes / 2 non conformes.
      const stats = await page.textContent('#postes-stats');
      assert.match(stats, /7 postes/);
      assert.match(stats, /5 conformes/);
      assert.match(stats, /2 non conformes/);
      // Figures of the stat line in mono (.num), one style on every page.
      assert.deepEqual(await page.$$eval('#postes-stats .num', (ns) => ns.map((n) => n.textContent)), ['7', '5', '71,4\u202f%', '2']);

      // XSS probe is rendered as text, never as markup.
      const xssId = posteId(data.XSS_POSTE_NAME);
      assert.equal((await page.textContent(cellSel('postes', xssId, KEY_POSTE))).trim(), data.XSS_POSTE_NAME);
      assert.equal((await page.textContent(cellSel('postes', xssId, 'Commentaires'))).trim(), '<script>window.__xss=2</script>');
      assert.equal(await page.$$eval('#postes-table img', (imgs) => imgs.length), 0);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.deepEqual(app.errors, []);
    });
  });

  test('where an edit goes: the current month is written into the source, a past month is history', async () => {
    await withApp({ page: 'postes', currentMonth: MONTH }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-edit-note');
      assert.equal(await page.getAttribute('#postes-edit-note', 'data-live'), '1');
      assert.equal(await page.textContent('#postes-edit-note'),
        'Les modifications sont écrites dans le Google Sheet source.');
      await editCell(page, 'postes', posteId('LAB-MEC-01'), 'Responsable', 'Zoé Lefèvre');
      await saveTable(app, 'postes');
      assert.ok((await toasts(page)).includes('1 modification enregistrée dans le Google Sheet source.'));

      await page.evaluate(() => window.State.set({ month: '2026-04' }));
      await page.waitForSelector('#postes-edit-note[data-live="0"]');
      assert.equal(await page.textContent('#postes-edit-note'),
        'Mois figé : les modifications ne changent que l’historique de avril 2026, pas le Google Sheet source.');

      // Deleting an application of the current month removes its source row: the dialog says so.
      await app.goto('apps');
      await page.evaluate(() => window.State.set({ month: '2026-05' }));
      await openDrawerFor(app, 'apps', appId('Figma'));
      await page.click('#app-delete');
      await page.waitForSelector('.modal .confirm-message');
      assert.match(await page.textContent('.modal .confirm-message'),
        /^Supprimer l’application «\sFigma\s» \? Sa ligne est supprimée de l’onglet «\sSuivi des applications\s» du Google Sheet source\./);
      await modalButton(page, 'Annuler');
      assert.deepEqual(app.errors, []);
    });
  });

  test('inline edit sends api_savePostes {month, changes:[{id, updates}]} and updates the UI', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      const id = posteId('LAB-MEC-01');
      await editCell(page, 'postes', id, 'Responsable', 'Zoé Lefèvre');
      await editCell(page, 'postes', id, 'Score conformité', '85%');
      // Live score while still dirty.
      await waitText(page, cellSel('postes', id, '_score'), '85,0\u202f%');
      assert.equal((await page.textContent('#postes-table .etable-save')).trim(), 'Enregistrer (2)');
      await saveTable(app, 'postes');

      const saves = await callsNamed(app, 'api_savePostes');
      assert.equal(saves.length, 1);
      assert.deepEqual(saves[0].args, { month: MONTH, changes: [{ id, updates: { Responsable: 'Zoé Lefèvre', 'Score conformité': '85%' } }] });

      assert.equal((await page.textContent(cellSel('postes', id, 'Responsable'))).trim(), 'Zoé Lefèvre');
      assert.equal((await page.textContent(cellSel('postes', id, '_score'))).trim(), '85,0\u202f%');
      assert.ok(await page.isHidden('#postes-table .etable-dirtybar'));
      assert.ok((await toasts(page)).includes('2 modifications enregistrées (historique de mai 2026).'));
      assert.match(await page.textContent('#postes-stats'), /6 conformes/);
      // Cache patched (re-enriched).
      const cached = await page.evaluate((pid) => {
        const r = window.State.getMonthData('2026-05').postes.find((p) => p._id === pid);
        return { resp: r.Responsable, score: r._score, ok: r._conforme };
      }, id);
      assert.deepEqual(cached, { resp: 'Zoé Lefèvre', score: 85, ok: true });

      // Référentiel options for select columns (Type de compte) and Oui/Non for YES_NO columns.
      await page.click(cellSel('postes', id, 'Type de compte'));
      const opts = await optionLabels(page, `${cellSel('postes', id, 'Type de compte')} .dd-trigger`, { values: true });
      assert.deepEqual(opts, ['', ...data.REFERENTIEL['Type de compte']]);
      await page.click(cellSel('postes', id, 'EDR Decathlon'));
      const yn = await optionLabels(page, `${cellSel('postes', id, 'EDR Decathlon')} .dd-trigger`, { values: true });
      assert.deepEqual(yn, ['', 'Oui', 'Non']);
      // Esc cancelled both editors: nothing became dirty.
      assert.ok(await page.isHidden('#postes-table .etable-dirtybar'));

      // Date columns get the date editor: an invalid date is refused, a valid one is kept.
      await page.click(cellSel('postes', id, 'Date visite'));
      const dateInput = `${cellSel('postes', id, 'Date visite')} .cell-editor-host input`;
      await page.fill(dateInput, '31/02/2026');
      await page.press(dateInput, 'Enter');
      assert.equal(await page.getAttribute(dateInput, 'aria-invalid'), 'true');
      await page.fill(dateInput, '21032026');
      await page.press(dateInput, 'Enter');
      await waitText(page, cellSel('postes', id, 'Date visite'), '21/03/2026');
      assert.equal((await page.textContent('#postes-table .etable-save')).trim(), 'Enregistrer (1)');
      assert.deepEqual(app.errors, []);
    });
  });

  test('conformity filter, global équipe filter and CSV export', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      await chooseOption(page, '#postes-conformity', 'Non conformes');
      assert.equal(await dropdownValue(page, '#postes-conformity'), 'ko');
      assert.deepEqual((await rowIds(page, 'postes')).sort(), [posteId('LAB-MEC-01'), posteId(data.XSS_POSTE_NAME)].sort());
      await chooseOption(page, '#postes-conformity', 'Toutes');
      assert.equal((await rowIds(page, 'postes')).length, 7);

      await page.evaluate(() => window.State.set({ filters: { equipes: ['Labo Textile'], batiments: [] } }));
      await page.waitForSelector('#postes-table');
      await app.waitIdle();
      assert.deepEqual(await rowIds(page, 'postes'), [posteId('LAB-TEX-01'), posteId('LAB-TEX-03')]);
      assert.equal(await page.textContent('.filter-note'), 'Filtres actifs — Équipe : Labo Textile');
      // The conformity choice survives the re-mount.
      await chooseOption(page, '#postes-conformity', 'Conformes');
      await page.evaluate(() => window.State.set({ filters: { equipes: ['Labo Textile'], batiments: ['Bâtiment A'] } }));
      await app.waitIdle();
      await page.waitForSelector('#postes-table');
      assert.equal(await dropdownValue(page, '#postes-conformity'), 'ok');
      assert.equal(await page.textContent('.filter-note'), 'Filtres actifs — Équipe : Labo Textile · Bâtiment / Labo : Bâtiment A');
      await chooseOption(page, '#postes-conformity', 'Toutes');
      await page.evaluate(() => window.State.set({ filters: { equipes: ['Labo Textile'], batiments: [] } }));
      await app.waitIdle();
      await page.waitForSelector('#postes-table');

      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#postes-export-csv')]);
      assert.equal(download.suggestedFilename(), 'postes_' + MONTH + '.csv');
      const csv = fs.readFileSync(await download.path(), 'utf8');
      const lines = csv.replace(/^﻿/, '').split('\r\n');
      assert.equal(lines[0].split(';')[0], KEY_POSTE);
      assert.equal(lines.length, 3);
      assert.match(lines[1], /^LAB-TEX-01;/);
      assert.deepEqual(app.errors, []);
    });
  });

  test('« Ajouter un poste générique » creates the generic poste once', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      await page.click('#postes-add-generic');
      await app.waitIdle();
      let calls = await callsNamed(app, 'api_addGenericPoste');
      assert.deepEqual(calls.map((c) => c.args), [{ month: MONTH }]);
      assert.equal((await rowIds(page, 'postes')).length, 8);
      const names = await page.$$eval('#postes-table tbody .postes-key', (bs) => bs.map((b) => b.textContent));
      assert.ok(names.includes(GENERIC));

      await page.click('#postes-add-generic');
      await app.waitIdle();
      calls = await callsNamed(app, 'api_addGenericPoste');
      assert.equal(calls.length, 2);
      assert.equal((await rowIds(page, 'postes')).length, 8, 'no duplicate');
      assert.ok((await toasts(page)).some((t) => t === '«\u202fPoste générique Decathlon\u202f» existe déjà pour mai 2026.'));
      assert.deepEqual(app.errors, []);
    });
  });

  test('« Ajouter un poste générique »: busy button while the call runs; errors in a toast', async () => {
    await withApp({ page: 'postes', delayMs: 400 }, async (app) => {
      const { page } = app;
      await page.click('#postes-add-generic');
      await page.waitForSelector('#postes-add-generic.is-busy[aria-busy="true"] .spinner');
      assert.equal(await page.$eval('#postes-add-generic', (b) => getComputedStyle(b).opacity), '1');
      await app.waitIdle();
      assert.equal(await page.$('#postes-add-generic.is-busy'), null);
      assert.equal((await page.textContent('#postes-add-generic')).trim(), 'Ajouter un poste générique');
      await page.evaluate(() => { window.__mock.failNext.api_addGenericPoste = { code: 'BUSY', message: 'Verrou occupé' }; });
      await page.click('#postes-add-generic');
      await app.waitIdle();
      assert.ok((await toasts(page)).includes('Erreur : Verrou occupé'));
      assert.equal(await page.isEnabled('#postes-add-generic'), true);
    });
  });

  test('drawer shows criteria, installed applications, linked actions and adds an action', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      // LAB-CHA-02 hosts Notepad++ (from « Installé sur poste »).
      await openDrawerFor(app, 'postes', posteId('LAB-CHA-02'));
      assert.equal((await page.textContent('.drawer-title')).trim(), 'LAB-CHA-02');
      assert.deepEqual(await page.$$eval('#poste-drawer-apps li', (lis) => lis.map((li) => li.dataset.app)), ['Notepad++']);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });

      // LAB-MEC-01: criteria + LabVIEW + existing action a-0002, then add one.
      const id = posteId('LAB-MEC-01');
      await page.click(cellSel('postes', id, '_apps'));   // row click (non-editable cell) also opens the drawer
      await page.waitForSelector('.drawer.open');
      await app.waitIdle();
      const crit = await page.$$eval('#poste-drawer-criteria li', (lis) => lis.map((li) => [li.dataset.criterion, li.dataset.state,
        li.querySelector('.mark').textContent, li.querySelector('.mark').classList.contains('mark-ko')]));
      assert.equal(crit.length, 5);
      assert.deepEqual(crit[0], ['IT Decathlon', 'ko', 'Non conforme', true]);
      assert.doesNotMatch(await page.textContent('.drawer'), /\p{Extended_Pictographic}/u);
      assert.deepEqual(await page.$$eval('#poste-drawer-apps li', (lis) => lis.map((li) => li.dataset.app)), ['LabVIEW']);
      assert.deepEqual(await page.$$eval('#drawer-actions li', (lis) => lis.map((li) => li.dataset.actionId)), ['a-0002']);

      // Priority is neutral text (not a status colour); the open action is overdue.
      assert.equal((await page.textContent('#drawer-actions li .mark-priority')).trim(), 'Priorité haute');
      assert.equal(await page.$eval('#drawer-actions li .mark-priority', (n) => getComputedStyle(n).color), 'rgb(22, 24, 27)');
      await assertNoNativeControls(page);

      // « Nouvelle action »: the shared ActionForm of Suivi des actions (same fields, title, submit label and toast),
      // with the target prefilled and locked.
      assert.equal((await page.textContent('#drawer-add-action')).trim(), 'Nouvelle action');
      await page.click('#drawer-add-action');
      await page.waitForSelector('.modal form');
      assert.equal((await page.textContent('.modal .modal-title')).trim(), 'Nouvelle action');
      assert.deepEqual(await page.$$eval('.modal .form-field .field-label', (ls) => ls.map((l) => l.textContent.replace(' *', ''))), [
        'Type de cible', 'Cible (poste ou application)', 'Équipe', 'Responsable', 'Action', 'Priorité', 'Statut', 'Échéance',
        'Mois source', 'Date de création', 'Date de réalisation', 'Commentaire']);
      assert.equal(await dropdownValue(page, '.modal [name="target_type"]'), 'poste');
      assert.equal(await page.isDisabled('.modal [name="target_type"]'), true);
      assert.equal(await page.inputValue('.modal [name="target_name"]'), 'LAB-MEC-01');
      assert.equal(await page.isDisabled('.modal [name="target_name"]'), true);
      assert.equal(await page.inputValue('.modal [name="action"]'), 'Isoler du réseau');   // prefilled
      assert.equal(await page.inputValue('.modal [name="date_created"]'), todayFr());
      assert.equal(await page.inputValue('.modal [name="source_month"]'), MONTH);
      await page.fill('.modal [name="action"]', 'Migrer vers Ubuntu 24.04');
      await chooseOption(page, '.modal [name="priorite"]', 'Haute');

      // Server error: the modal stays open (values kept), the error is shown inside it, no toast.
      await page.evaluate(() => { window.__mock.failNext.api_addAction = { code: 'BUSY', message: 'Verrou occupé' }; });
      await modalButton(page, 'Enregistrer');
      await app.waitIdle();
      await page.waitForSelector('.modal .form-alert .alert-error');
      assert.equal((await page.textContent('.modal .form-alert .alert-error')).trim(), 'Erreur : Verrou occupé');
      assert.equal(await page.inputValue('.modal [name="action"]'), 'Migrer vers Ubuntu 24.04');
      assert.equal(await dropdownValue(page, '.modal [name="priorite"]'), 'Haute');
      assert.equal((await toasts(page)).some((t) => /Verrou/.test(t)), false);

      await modalButton(page, 'Enregistrer');
      await app.waitIdle();
      await page.waitForSelector('.modal', { state: 'detached' });

      const adds = await callsNamed(app, 'api_addAction');
      assert.equal(adds.length, 2);
      assert.deepEqual(adds[1].args, {
        target_type: 'poste', target_name: 'LAB-MEC-01', equipe: 'Labo Mécanique', action: 'Migrer vers Ubuntu 24.04',
        responsable: 'Nathan Petit', deadline: '', priorite: 'Haute', status: 'À faire', comment: '',
        date_created: todayFr(), date_completed: '', source_month: MONTH,
      });
      await page.waitForFunction(() => document.querySelectorAll('#drawer-actions li').length === 2);
      const items = await page.$$eval('#drawer-actions li .action-title', (ns) => ns.map((n) => n.textContent));
      assert.deepEqual(items, ['Isoler du réseau', 'Migrer vers Ubuntu 24.04']);
      assert.ok((await toasts(page)).includes('Action créée — LAB-MEC-01.'));

      // Navigating away closes the drawer.
      await app.goto('dashboard');
      assert.equal(await page.$('.drawer'), null);
      assert.deepEqual(app.errors, []);
    });
  });

  test('empty state when nothing was synchronised: admins can run the first sync', async () => {
    await withApp({ empty: true, page: 'postes' }, async (app) => {
      assert.equal((await app.page.textContent('#postes-empty')).trim(), 'Aucune donnée pour le moment. Synchroniser maintenant');
      await app.goto('apps');
      assert.match(await app.page.textContent('#apps-empty'), /Aucune donnée pour le moment/);
      await app.page.click('#apps-empty button');
      await app.page.waitForSelector('#apps-table tbody tr[data-id]');
      await app.waitIdle();
      assert.deepEqual(app.errors, []);
    });
  });
});

// ---------------------------------------------------------------------------------- Applications

describe('applications page', () => {
  test('renders the 2026-05 applications with score, criteria and Galink/IDP summary', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main h1')).trim(), 'Applications');
      assert.equal(await page.getAttribute('#apps-caption', 'data-month'), MONTH);
      assert.doesNotMatch(await page.textContent('#main'), /\p{Extended_Pictographic}/u);
      assert.equal((await page.textContent('#apps-add')).trim(), 'Nouvelle application');
      assert.equal((await page.textContent('#apps-export-csv')).trim(), 'Exporter CSV');
      const ids = await rowIds(page, 'apps');
      assert.equal(ids.length, data.MONTHS[MONTH].applications.length);

      const headers = await page.$$eval('#apps-table thead th', (ths) => ths.map((th) => th.textContent.replace(/[▲▼]/g, '').trim()));
      const expected = [KEY_APP, 'Score', 'Critères'].concat(data.APPS_HEADERS.filter((h) => h !== KEY_APP), ['Galink', 'IDP']);
      assert.deepEqual(headers, expected);

      const lab = appId('LabVIEW');
      assert.equal((await page.textContent(cellSel('apps', lab, '_score'))).trim(), '40,0\u202f%');
      const crit = await page.$$eval(`${cellSel('apps', lab, '_criteria')} .mark`, (bs) => bs.map((b) => [b.dataset.criterion, b.classList.contains('mark-ok')]));
      assert.deepEqual(crit, [['contrat', true], ['sip', false], ['idp', false], ['galink', false], ['champs', true]]);

      // Galink / IDP: Oui (Minitab, Notepad++, Figma), Non (LabVIEW), vide (Dropbox perso).
      const summary = await page.$$eval('#apps-migration [data-field]', (rows) => rows.map((r) => [r.dataset.field,
        ['oui', 'non', 'vide', 'share'].map((k) => r.querySelector(`[data-count="${k}"]`).textContent)]));
      assert.deepEqual(summary, [
        ['Galink', ['3', '1', '1', '60,0\u202f%']],
        ['IDP', ['3', '1', '1', '60,0\u202f%']],
      ]);
      assert.match(await page.textContent('#apps-stats'), /3 conformes/);
      assert.deepEqual(await page.$$eval('#apps-stats .num', (ns) => ns.map((n) => n.textContent)), ['5', '3', '60,0\u202f%', '2']);
      await assertNoNativeControls(page);

      await chooseOption(page, '#apps-conformity', 'Non conformes');
      assert.deepEqual((await rowIds(page, 'apps')).sort(), [appId('LabVIEW'), appId('Dropbox perso')].sort());
      assert.deepEqual(app.errors, []);
    });
  });

  test('editing Galink recomputes the score (live, then after api_saveApplications)', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      const id = appId('LabVIEW');
      await editCell(page, 'apps', id, 'Galink', 'Oui');
      await waitText(page, cellSel('apps', id, '_score'), '60,0\u202f%');   // live, before saving
      await saveTable(app, 'apps');

      const saves = await callsNamed(app, 'api_saveApplications');
      assert.deepEqual(saves.map((c) => c.args), [{ month: MONTH, changes: [{ id, updates: { Galink: 'Oui' } }] }]);
      assert.equal((await page.textContent(cellSel('apps', id, '_score'))).trim(), '60,0\u202f%');
      assert.equal((await page.textContent(cellSel('apps', id, 'Galink'))).trim(), 'Oui');
      assert.equal(await page.textContent('#apps-migration [data-field="Galink"] [data-count="oui"]'), '4');
      assert.ok((await toasts(page)).includes('1 modification enregistrée (historique de mai 2026).'));
      const cached = await page.evaluate((aid) => window.State.getMonthData('2026-05').applications.find((a) => a._id === aid)._score, id);
      assert.equal(cached, 60);
      assert.deepEqual(app.errors, []);
    });
  });

  test('« Nouvelle application » adds a record; duplicates are refused', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      async function fillForm(name) {
        await page.click('#apps-add');
        await page.waitForSelector('.modal form');
        assert.equal((await page.textContent('.modal .modal-title')).trim(), 'Nouvelle application — mai 2026');
        await page.fill(`.modal [name="${KEY_APP}"]`, name);
        await page.fill('.modal [name="Éditeur"]', 'Salesforce');
        await chooseOption(page, '.modal [name="Type"]', 'SaaS');            // combobox (free text allowed)
        await chooseOption(page, '.modal [name="Équipe"]', 'R&D Vélo');
        await chooseOption(page, '.modal [name="Installé sur poste"]', 'RD-VEL-01');   // multi-token combobox
        await chooseOption(page, '.modal [name="Contrat"]', 'Oui');
        await chooseOption(page, '.modal [name="SIP"]', 'Oui');
        await chooseOption(page, '.modal [name="Données sensibles exposées"]', 'Non');
        await chooseOption(page, '.modal [name="Niveau de risque"]', 'Faible');
        await chooseOption(page, '.modal [name="Galink"]', 'Oui');
        await chooseOption(page, '.modal [name="IDP"]', 'Non');
        await assertNoNativeControls(page);
        await modalButton(page, 'Ajouter');
        await app.waitIdle();
      }
      await fillForm('Slack');
      await page.waitForSelector('.modal', { state: 'detached' });
      const adds = await callsNamed(app, 'api_addApplication');
      assert.equal(adds.length, 1);
      assert.deepEqual(adds[0].args, { month: MONTH, record: {
        [KEY_APP]: 'Slack', 'Éditeur': 'Salesforce', Type: 'SaaS', 'Équipe': 'R&D Vélo', 'Installé sur poste': 'RD-VEL-01',
        Contrat: 'Oui', SIP: 'Oui', 'Données sensibles exposées': 'Non', 'Niveau de risque': 'Faible', Galink: 'Oui', IDP: 'Non',
      } });
      const ids = await rowIds(page, 'apps');
      assert.equal(ids.length, 6);
      const newId = await page.evaluate(() => window.State.getMonthData('2026-05').applications.find((a) => a['Nom du logiciel / service'] === 'Slack')._id);
      assert.equal((await page.textContent(cellSel('apps', newId, '_score'))).trim(), '80,0\u202f%');
      assert.match(await page.textContent('#apps-stats'), /6 applications/);
      assert.ok((await toasts(page)).includes('Application «\u202fSlack\u202f» ajoutée.'));

      // Same name modulo case -> VALIDATION: the modal stays open, the error sits under the name field,
      // every typed value is kept.
      await fillForm('slack');
      await page.waitForSelector('.modal .field-error:not([hidden])');
      const nameField = `.modal [name="${KEY_APP}"]`;
      assert.equal(await page.getAttribute(nameField, 'aria-invalid'), 'true');
      assert.match(await page.textContent('.modal .form-field:has([name="Nom du logiciel / service"]) .field-error'), /existe déjà/);
      assert.equal(await page.inputValue(nameField), 'slack');
      assert.equal(await page.inputValue('.modal [name="Type"]'), 'SaaS');
      assert.equal(await dropdownValue(page, '.modal [name="Galink"]'), 'Oui');
      assert.equal((await toasts(page)).some((t) => /^Erreur/.test(t)), false);
      await modalButton(page, 'Annuler');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.equal((await rowIds(page, 'apps')).length, 6);
      assert.equal((await callsNamed(app, 'api_addApplication')).length, 2);
      assert.deepEqual(app.errors, []);
    });
  });

  test('drawer: criteria, postes, actions; rename cascades to actions', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      await openDrawerFor(app, 'apps', appId('Notepad++'));
      assert.deepEqual(await page.$$eval('#app-drawer-postes li', (lis) => lis.map((li) => li.dataset.poste)), ['LAB-CHA-01', 'LAB-CHA-02']);
      assert.deepEqual(await page.$$eval('#app-drawer-criteria li', (lis) => lis.map((li) => li.dataset.ok)), ['1', '1', '1', '1', '1']);

      const id = appId('Dropbox perso');
      await openDrawerFor(app, 'apps', id);
      assert.deepEqual(await page.$$eval('#drawer-actions li', (lis) => lis.map((li) => li.dataset.actionId)), ['a-0003']);
      assert.match(await page.textContent('#app-drawer-postes'), /Aucun poste renseigné/);
      await page.click('#app-rename');
      await page.waitForSelector('.modal form');
      assert.equal(await page.inputValue('.modal [name="newName"]'), 'Dropbox perso');
      // A name already used is refused by the server: error under the field, modal kept open.
      await page.fill('.modal [name="newName"]', 'Figma');
      await modalButton(page, 'Renommer');
      await app.waitIdle();
      await page.waitForSelector('.modal .field-error:not([hidden])');
      assert.match(await page.textContent('.modal .field-error:not([hidden])'), /existe déjà/);
      assert.equal(await page.getAttribute('.modal [name="newName"]', 'aria-invalid'), 'true');
      await page.fill('.modal [name="newName"]', 'Dropbox (perso)');
      await modalButton(page, 'Renommer');
      await app.waitIdle();
      await page.waitForSelector('.modal', { state: 'detached' });

      const renames = await callsNamed(app, 'api_renameApplication');
      assert.deepEqual(renames.map((c) => c.args), [{ month: MONTH, id, newName: 'Figma' }, { month: MONTH, id, newName: 'Dropbox (perso)' }]);
      assert.equal((await page.textContent(cellSel('apps', id, KEY_APP))).trim(), 'Dropbox (perso)');
      assert.equal((await page.textContent('.drawer-title')).trim(), 'Dropbox (perso)');
      // The action target was renamed server side; the drawer shows it under the new name.
      assert.deepEqual(await page.$$eval('#drawer-actions li', (lis) => lis.map((li) => li.dataset.actionId)), ['a-0003']);
      assert.ok((await toasts(page)).includes('Application renommée en «\u202fDropbox (perso)\u202f» — 1 action mise à jour.'));
      assert.deepEqual(app.errors, []);
    });
  });

  test('delete asks for confirmation', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      const id = appId('Figma');
      await openDrawerFor(app, 'apps', id);
      await page.click('#app-delete');
      await page.waitForSelector('.modal .confirm-message');
      assert.match(await page.textContent('.modal .confirm-message'), /Figma.*de l’historique de mai 2026 \? Le Google Sheet source n’est pas modifié\./);
      // Destructive dialog: the focus starts on « Annuler ».
      await page.waitForFunction(() => document.activeElement && document.activeElement.textContent === 'Annuler');
      await modalButton(page, 'Annuler');
      await app.waitIdle();
      assert.equal((await callsNamed(app, 'api_deleteApplication')).length, 0);
      assert.equal((await rowIds(page, 'apps')).length, 5);

      // Server error: shown inside the dialog, which stays open; nothing removed.
      await page.evaluate(() => { window.__mock.failNext.api_deleteApplication = { code: 'BUSY', message: 'Verrou occupé' }; });
      await page.click('#app-delete');
      await page.waitForSelector('.modal .confirm-message');
      await modalButton(page, 'Supprimer');
      await app.waitIdle();
      await page.waitForSelector('.modal .confirm-error .alert-error');
      assert.equal((await page.textContent('.modal .confirm-error')).trim(), 'Erreur : Verrou occupé');
      assert.equal((await rowIds(page, 'apps')).length, 5);
      assert.ok(await page.$('.drawer.open'));

      await modalButton(page, 'Supprimer');
      await app.waitIdle();
      await page.waitForSelector('.modal', { state: 'detached' });
      const dels = await callsNamed(app, 'api_deleteApplication');
      assert.deepEqual(dels.map((c) => c.args), [{ month: MONTH, id }, { month: MONTH, id }]);
      assert.equal((await rowIds(page, 'apps')).includes(id), false);
      assert.equal((await rowIds(page, 'apps')).length, 4);
      assert.equal(await page.$('.drawer'), null, 'drawer closed');
      assert.ok((await toasts(page)).includes('Application «\u202fFigma\u202f» supprimée.'));
      assert.deepEqual(app.errors, []);
    });
  });
});
