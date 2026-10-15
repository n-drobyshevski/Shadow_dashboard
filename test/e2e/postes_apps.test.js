'use strict';
/**
 * E2E tests of the Postes and Applications pages (docs/API.md §6 "Postes" / "Applications").
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/postes_apps.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const data = require('../fixtures/data');
const { openApp } = require('./harness');

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

/** Edits one table cell (select or text input) and leaves it dirty. */
async function editCell(page, table, id, col, value) {
  await page.click(cellSel(table, id, col));
  const editor = `${cellSel(table, id, col)} .cell-editor`;
  await page.waitForSelector(editor);
  const tag = await page.$eval(editor, (n) => n.tagName);
  if (tag === 'SELECT') {
    await page.selectOption(editor, value);
  } else {
    await page.fill(editor, value);
    await page.press(editor, 'Enter');
  }
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

// ---------------------------------------------------------------------------------------- Postes

describe('postes page', () => {
  test('renders the 2026-05 inventory (column order, computed columns, XSS probe as text)', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main h1')).trim(), '💻 Postes');
      assert.equal(await page.textContent('#postes-caption'), 'Export : ' + MONTH);

      const ids = await rowIds(page, 'postes');
      assert.equal(ids.length, data.MONTHS[MONTH].postes.length);

      const headers = await page.$$eval('#postes-table thead th', (ths) => ths.map((th) => th.textContent.replace(/[▲▼]/g, '').trim()));
      const expected = [KEY_POSTE, 'Score', 'Applis'].concat(data.POSTES_HEADERS.filter((h) => h !== KEY_POSTE));
      assert.deepEqual(headers, expected);

      // Key column is read-only, source columns are editable.
      assert.equal(await page.$eval(cellSel('postes', ids[0], KEY_POSTE), (td) => td.classList.contains('cell-editable')), false);
      assert.equal(await page.$eval(cellSel('postes', ids[0], 'Responsable'), (td) => td.classList.contains('cell-editable')), true);

      // Score badge from « Score conformité », Applis count from the applications' « Installé sur poste ».
      assert.equal((await page.textContent(cellSel('postes', posteId('LAB-MEC-01'), '_score'))).trim(), '40,0 %');
      assert.equal((await page.textContent(cellSel('postes', posteId('LAB-CHA-01'), '_apps'))).trim(), '1');
      assert.equal((await page.textContent(cellSel('postes', posteId('LAB-TEX-03'), '_apps'))).trim(), '0');

      // Header counts: 5 conformes / 2 non conformes.
      const stats = await page.textContent('#postes-stats');
      assert.match(stats, /7 postes/);
      assert.match(stats, /5 conformes/);
      assert.match(stats, /2 non conformes/);

      // XSS probe is rendered as text, never as markup.
      const xssId = posteId(data.XSS_POSTE_NAME);
      assert.equal((await page.textContent(cellSel('postes', xssId, KEY_POSTE))).trim(), data.XSS_POSTE_NAME);
      assert.equal((await page.textContent(cellSel('postes', xssId, 'Commentaires'))).trim(), '<script>window.__xss=2</script>');
      assert.equal(await page.$$eval('#postes-table img', (imgs) => imgs.length), 0);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
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
      await waitText(page, cellSel('postes', id, '_score'), '85,0 %');
      assert.equal((await page.textContent('#postes-table .etable-save')).trim(), 'Enregistrer (2)');
      await saveTable(app, 'postes');

      const saves = await callsNamed(app, 'api_savePostes');
      assert.equal(saves.length, 1);
      assert.deepEqual(saves[0].args, { month: MONTH, changes: [{ id, updates: { Responsable: 'Zoé Lefèvre', 'Score conformité': '85%' } }] });

      assert.equal((await page.textContent(cellSel('postes', id, 'Responsable'))).trim(), 'Zoé Lefèvre');
      assert.equal((await page.textContent(cellSel('postes', id, '_score'))).trim(), '85,0 %');
      assert.ok(await page.isHidden('#postes-table .etable-dirtybar'));
      assert.match(await page.textContent('#postes-stats'), /6 conformes/);
      // Cache patched (re-enriched).
      const cached = await page.evaluate((pid) => {
        const r = window.State.getMonthData('2026-05').postes.find((p) => p._id === pid);
        return { resp: r.Responsable, score: r._score, ok: r._conforme };
      }, id);
      assert.deepEqual(cached, { resp: 'Zoé Lefèvre', score: 85, ok: true });

      // Référentiel options for select columns (Type de compte) and Oui/Non for YES_NO columns.
      await page.click(cellSel('postes', id, 'Type de compte'));
      const opts = await page.$$eval(`${cellSel('postes', id, 'Type de compte')} select option`, (os) => os.map((o) => o.value));
      assert.deepEqual(opts, ['', ...data.REFERENTIEL['Type de compte']]);
      await page.keyboard.press('Escape');
      await page.click(cellSel('postes', id, 'EDR Decathlon'));
      const yn = await page.$$eval(`${cellSel('postes', id, 'EDR Decathlon')} select option`, (os) => os.map((o) => o.value));
      assert.deepEqual(yn, ['', 'Oui', 'Non']);
      await page.keyboard.press('Escape');
      assert.deepEqual(app.errors, []);
    });
  });

  test('conformity filter, global équipe filter and CSV export', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      await page.selectOption('#postes-conformity', 'ko');
      assert.deepEqual((await rowIds(page, 'postes')).sort(), [posteId('LAB-MEC-01'), posteId(data.XSS_POSTE_NAME)].sort());
      await page.selectOption('#postes-conformity', 'all');
      assert.equal((await rowIds(page, 'postes')).length, 7);

      await page.evaluate(() => window.State.set({ filters: { equipes: ['Labo Textile'], batiments: [] } }));
      await page.waitForSelector('#postes-table');
      await app.waitIdle();
      assert.deepEqual(await rowIds(page, 'postes'), [posteId('LAB-TEX-01'), posteId('LAB-TEX-03')]);
      assert.match(await page.textContent('.filter-note'), /Labo Textile/);

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

  test('➕ Poste générique creates the generic poste once', async () => {
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
      assert.ok((await toasts(page)).some((t) => /existe déjà/.test(t)));
      assert.deepEqual(app.errors, []);
    });
  });

  test('drawer shows criteria, installed applications, linked actions and adds an action', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      // LAB-CHA-02 hosts Notepad++ (from « Installé sur poste »).
      await openDrawerFor(app, 'postes', posteId('LAB-CHA-02'));
      assert.equal((await page.textContent('.drawer-title')).trim(), '💻 LAB-CHA-02');
      assert.deepEqual(await page.$$eval('#poste-drawer-apps li', (lis) => lis.map((li) => li.dataset.app)), ['Notepad++']);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });

      // LAB-MEC-01: criteria + LabVIEW + existing action a-0002, then add one.
      const id = posteId('LAB-MEC-01');
      await page.click(cellSel('postes', id, '_apps'));   // row click (non-editable cell) also opens the drawer
      await page.waitForSelector('.drawer.open');
      await app.waitIdle();
      const crit = await page.$$eval('#poste-drawer-criteria li', (lis) => lis.map((li) => li.textContent));
      assert.equal(crit.length, 5);
      assert.ok(crit[0].includes('❌') && crit[0].includes('IT Decathlon'));
      assert.deepEqual(await page.$$eval('#poste-drawer-apps li', (lis) => lis.map((li) => li.dataset.app)), ['LabVIEW']);
      assert.deepEqual(await page.$$eval('#drawer-actions li', (lis) => lis.map((li) => li.dataset.actionId)), ['a-0002']);

      await page.click('#drawer-add-action');
      await page.waitForSelector('.modal form');
      assert.equal(await page.inputValue('.modal [name="action"]'), 'Isoler du réseau');   // prefilled
      await page.fill('.modal [name="action"]', 'Migrer vers Ubuntu 24.04');
      await page.selectOption('.modal [name="priorite"]', 'Haute');
      await modalButton(page, 'Ajouter');
      await app.waitIdle();

      const adds = await callsNamed(app, 'api_addAction');
      assert.equal(adds.length, 1);
      assert.deepEqual(adds[0].args, {
        target_type: 'poste', target_name: 'LAB-MEC-01', equipe: 'Labo Mécanique', action: 'Migrer vers Ubuntu 24.04',
        responsable: 'Nathan Petit', deadline: '', priorite: 'Haute', status: 'À faire', comment: '',
        source_month: MONTH,
      });
      const items = await page.$$eval('#drawer-actions li strong', (ns) => ns.map((n) => n.textContent));
      assert.deepEqual(items, ['Isoler du réseau', 'Migrer vers Ubuntu 24.04']);

      // Navigating away closes the drawer.
      await app.goto('dashboard');
      assert.equal(await page.$('.drawer'), null);
      assert.deepEqual(app.errors, []);
    });
  });

  test('empty state when nothing was imported', async () => {
    await withApp({ empty: true, page: 'postes' }, async (app) => {
      assert.match(await app.page.textContent('#postes-empty'), /Aucune donnée importée/);
      await app.goto('apps');
      assert.match(await app.page.textContent('#apps-empty'), /Aucune donnée importée/);
      assert.deepEqual(app.errors, []);
    });
  });
});

// ---------------------------------------------------------------------------------- Applications

describe('applications page', () => {
  test('renders the 2026-05 applications with score, criteria and Galink/IDP summary', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main h1')).trim(), '📦 Applications');
      const ids = await rowIds(page, 'apps');
      assert.equal(ids.length, data.MONTHS[MONTH].applications.length);

      const headers = await page.$$eval('#apps-table thead th', (ths) => ths.map((th) => th.textContent.replace(/[▲▼]/g, '').trim()));
      const expected = [KEY_APP, 'Score', 'Critères'].concat(data.APPS_HEADERS.filter((h) => h !== KEY_APP), ['Galink', 'IDP']);
      assert.deepEqual(headers, expected);

      const lab = appId('LabVIEW');
      assert.equal((await page.textContent(cellSel('apps', lab, '_score'))).trim(), '40,0 %');
      const crit = await page.$$eval(`${cellSel('apps', lab, '_criteria')} .badge`, (bs) => bs.map((b) => [b.dataset.criterion, b.classList.contains('badge-ok')]));
      assert.deepEqual(crit, [['contrat', true], ['sip', false], ['idp', false], ['galink', false], ['champs', true]]);

      // Galink / IDP: Oui (Minitab, Notepad++, Figma), Non (LabVIEW), vide (Dropbox perso).
      const summary = await page.$$eval('#apps-migration [data-field]', (cards) => cards.map((c) => [c.dataset.field,
        ['oui', 'non', 'vide'].map((k) => c.querySelector(`[data-count="${k}"]`).textContent)]));
      assert.deepEqual(summary, [
        ['Galink', ['Oui : 3', 'Non : 1', 'Non renseigné : 1']],
        ['IDP', ['Oui : 3', 'Non : 1', 'Non renseigné : 1']],
      ]);
      assert.match(await page.textContent('#apps-stats'), /3 conformes/);

      await page.selectOption('#apps-conformity', 'ko');
      assert.deepEqual((await rowIds(page, 'apps')).sort(), [appId('LabVIEW'), appId('Dropbox perso')].sort());
      assert.deepEqual(app.errors, []);
    });
  });

  test('editing Galink recomputes the score (live, then after api_saveApplications)', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      const id = appId('LabVIEW');
      await editCell(page, 'apps', id, 'Galink', 'Oui');
      await waitText(page, cellSel('apps', id, '_score'), '60,0 %');   // live, before saving
      await saveTable(app, 'apps');

      const saves = await callsNamed(app, 'api_saveApplications');
      assert.deepEqual(saves.map((c) => c.args), [{ month: MONTH, changes: [{ id, updates: { Galink: 'Oui' } }] }]);
      assert.equal((await page.textContent(cellSel('apps', id, '_score'))).trim(), '60,0 %');
      assert.equal((await page.textContent(cellSel('apps', id, 'Galink'))).trim(), 'Oui');
      assert.equal(await page.textContent('#apps-migration [data-field="Galink"] [data-count="oui"]'), 'Oui : 4');
      const cached = await page.evaluate((aid) => window.State.getMonthData('2026-05').applications.find((a) => a._id === aid)._score, id);
      assert.equal(cached, 60);
      assert.deepEqual(app.errors, []);
    });
  });

  test('➕ Application adds a record; duplicates are refused', async () => {
    await withApp({ page: 'apps' }, async (app) => {
      const { page } = app;
      async function fillForm(name) {
        await page.click('#apps-add');
        await page.waitForSelector('.modal form');
        await page.fill(`.modal [name="${KEY_APP}"]`, name);
        await page.fill('.modal [name="Éditeur"]', 'Salesforce');
        await page.fill('.modal [name="Type"]', 'SaaS');
        await page.fill('.modal [name="Équipe"]', 'R&D Vélo');
        await page.fill('.modal [name="Installé sur poste"]', 'RD-VEL-01');
        await page.selectOption('.modal [name="Contrat"]', 'Oui');
        await page.selectOption('.modal [name="SIP"]', 'Oui');
        await page.selectOption('.modal [name="Données sensibles exposées"]', 'Non');
        await page.selectOption('.modal [name="Niveau de risque"]', 'Faible');
        await page.selectOption('.modal [name="Galink"]', 'Oui');
        await page.selectOption('.modal [name="IDP"]', 'Non');
        await modalButton(page, 'Ajouter');
        await app.waitIdle();
      }
      await fillForm('Slack');
      const adds = await callsNamed(app, 'api_addApplication');
      assert.equal(adds.length, 1);
      assert.deepEqual(adds[0].args, { month: MONTH, record: {
        [KEY_APP]: 'Slack', 'Éditeur': 'Salesforce', Type: 'SaaS', 'Équipe': 'R&D Vélo', 'Installé sur poste': 'RD-VEL-01',
        Contrat: 'Oui', SIP: 'Oui', 'Données sensibles exposées': 'Non', 'Niveau de risque': 'Faible', Galink: 'Oui', IDP: 'Non',
      } });
      const ids = await rowIds(page, 'apps');
      assert.equal(ids.length, 6);
      const newId = await page.evaluate(() => window.State.getMonthData('2026-05').applications.find((a) => a['Nom du logiciel / service'] === 'Slack')._id);
      assert.equal((await page.textContent(cellSel('apps', newId, '_score'))).trim(), '80,0 %');
      assert.match(await page.textContent('#apps-stats'), /6 applications/);

      await fillForm('slack');   // same name modulo case -> VALIDATION
      assert.equal((await rowIds(page, 'apps')).length, 6);
      assert.ok((await toasts(page)).some((t) => /Ajout impossible/.test(t)));
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
      await page.fill('.modal [name="newName"]', 'Dropbox (perso)');
      await modalButton(page, 'Renommer');
      await app.waitIdle();

      const renames = await callsNamed(app, 'api_renameApplication');
      assert.deepEqual(renames.map((c) => c.args), [{ month: MONTH, id, newName: 'Dropbox (perso)' }]);
      assert.equal((await page.textContent(cellSel('apps', id, KEY_APP))).trim(), 'Dropbox (perso)');
      assert.equal((await page.textContent('.drawer-title')).trim(), '📦 Dropbox (perso)');
      // The action target was renamed server side; the drawer shows it under the new name.
      assert.deepEqual(await page.$$eval('#drawer-actions li', (lis) => lis.map((li) => li.dataset.actionId)), ['a-0003']);
      assert.ok((await toasts(page)).some((t) => /1 action mise à jour/.test(t)));
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
      assert.match(await page.textContent('.modal .confirm-message'), /Figma/);
      await modalButton(page, 'Annuler');
      await app.waitIdle();
      assert.equal((await callsNamed(app, 'api_deleteApplication')).length, 0);
      assert.equal((await rowIds(page, 'apps')).length, 5);

      await page.click('#app-delete');
      await page.waitForSelector('.modal .confirm-message');
      await modalButton(page, 'Supprimer');
      await app.waitIdle();
      const dels = await callsNamed(app, 'api_deleteApplication');
      assert.deepEqual(dels.map((c) => c.args), [{ month: MONTH, id }]);
      assert.equal((await rowIds(page, 'apps')).includes(id), false);
      assert.equal((await rowIds(page, 'apps')).length, 4);
      assert.equal(await page.$('.drawer'), null, 'drawer closed');
      assert.deepEqual(app.errors, []);
    });
  });
});
