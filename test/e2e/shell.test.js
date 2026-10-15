'use strict';
/**
 * E2E smoke tests of the client shell (App router, sidebar, configuration screen, filters).
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { openApp, chooseOption, chooseOptions, optionLabels, dropdownValue, typeDate } = require('./harness');

const PAGES = [
  { id: 'dashboard', title: 'Tableau de bord' },
  { id: 'postes', title: 'Postes' },
  { id: 'apps', title: 'Applications' },
  { id: 'timeline', title: 'Suivi temporel' },
  { id: 'actions', title: 'Suivi des actions' },
  { id: 'settings', title: 'Paramètres' }, // admin only (the default mock visitor is the owner)
];

async function withApp(options, fn) {
  const app = await openApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

describe('shell', () => {
  test('boots on the dashboard with the full sidebar', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      const nav = await page.$$eval('#sidebar .nav-link', (ns) => ns.map((n) => ({ page: n.dataset.page, text: n.textContent.trim() })));
      assert.deepEqual(nav.map((n) => n.page), PAGES.map((p) => p.id));
      PAGES.forEach((p, i) => assert.ok(nav[i].text.includes(p.title), nav[i].text));
      assert.equal(await page.textContent('#sidebar .brand .brand-name'), 'Shadow IT');
      assert.equal(await page.textContent('#sidebar .brand .brand-sub'), 'Industry · conformité');
      // Text-only navigation: no emoji anywhere in the shell chrome.
      const chrome = await page.textContent('#sidebar') + await page.textContent('.topbar');
      assert.doesNotMatch(chrome, /\p{Extended_Pictographic}/u);
      // Counts next to Postes / Applications (2026-05 fixture: 7 postes, 5 applications).
      assert.equal(await page.textContent('#sidebar .nav-count[data-count="postes"]'), '7');
      assert.equal(await page.textContent('#sidebar .nav-count[data-count="apps"]'), '5');
      assert.equal(await page.getAttribute('#sidebar .nav-link[data-page="dashboard"]', 'aria-current'), 'page');

      // Période: ascending months, latest selected by default (custom dropdown, no native <select>).
      assert.equal(await page.$('#sidebar select'), null);
      assert.equal(await page.getAttribute('#month-select', 'aria-haspopup'), 'listbox');
      assert.deepEqual(await optionLabels(page, '#month-select', { values: true }), ['2026-04', '2026-05']);
      assert.equal(await dropdownValue(page, '#month-select'), '2026-05');

      // Footer links open in a new tab without opener.
      for (const id of ['#link-data', '#link-source']) {
        assert.equal(await page.getAttribute(id, 'target'), '_blank');
        assert.match(await page.getAttribute(id, 'rel'), /noopener/);
        assert.match(await page.getAttribute(id, 'href'), /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
      }
      assert.equal((await page.textContent('#link-data')).trim(), 'Données (Google Sheet)');
      assert.equal((await page.textContent('#link-source')).trim(), 'Source');
      // The source is changed in Paramètres; the footer ends with the signed-in account and its role.
      assert.equal(await page.$('#btn-source'), null);
      assert.equal((await page.textContent('#side-user .side-user-email')).trim(), 'owner@decathlon.com');
      assert.equal((await page.textContent('#side-user .side-user-role')).trim(), 'Administrateur');

      const calls = await app.calls();
      assert.equal(calls[0].name, 'api_bootstrap');
      assert.deepEqual(app.errors, []);
    });
  });

  test('navigates to all 6 pages without errors and pushes history', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      for (const p of [...PAGES.slice(1), PAGES[0]]) {
        await page.click(`#sidebar .nav-link[data-page="${p.id}"]`);
        await page.waitForSelector(`#main .page[data-page="${p.id}"]`);
        await app.waitIdle();
        assert.equal(await page.getAttribute(`#sidebar .nav-link[data-page="${p.id}"]`, 'aria-current'), 'page');
        assert.equal(await page.$$eval('#main > .page', (ns) => ns.length), 1, 'exactly one mounted page');
        const text = await page.textContent('#main');
        assert.ok(text.trim().length > 0, `page ${p.id} rendered something`);
        assert.deepEqual(app.errors, [], `no errors on ${p.id}`);
      }
      const history = await page.evaluate(() => window.__history);
      assert.deepEqual(history.map((h) => h.state.page), ['postes', 'apps', 'timeline', 'actions', 'settings', 'dashboard']);

      // Browser back/forward: the history change handler navigates without pushing again.
      await page.evaluate(() => window.__mock.popState({ page: 'apps' }));
      await page.waitForSelector('#main .page[data-page="apps"]');
      assert.equal((await page.evaluate(() => window.__history)).length, 6);
      assert.equal(await page.evaluate(() => window.State.get().page), 'apps');
      assert.deepEqual(app.errors, []);
    });
  });

  test('shows the configuration screen when the source is not configured', async () => {
    await withApp({ configured: false }, async (app) => {
      const { page } = app;
      assert.ok(await page.isVisible('#config-source'));
      assert.ok(!(await page.isVisible('#sidebar')), 'sidebar hidden while unconfigured');
      assert.equal(await page.$('#main .page[data-page="dashboard"]'), null);
      assert.equal((await page.textContent('label[for="config-source"]')).trim(), 'URL ou ID du Google Sheet source');
      assert.equal((await page.textContent('#main h1')).trim(), 'Source de données');
      assert.equal(await page.$('#main .card'), null, 'configuration screen is a plain page, not a card');

      // Empty -> inline error, no call.
      await page.click('#config-submit');
      assert.equal((await page.textContent('#config-error')).trim(), 'Ce champ est obligatoire.');

      // Invalid id -> VALIDATION from the server, inline error.
      await page.fill('#config-source', 'pas-une-url');
      await page.click('#config-submit');
      await page.waitForSelector('#config-error:not([hidden])');
      await app.waitIdle();
      assert.match(await page.textContent('#config-error'), /invalide/);

      const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_SRC/edit#gid=0';
      await page.fill('#config-source', url);
      await page.click('#config-submit');
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      await app.waitIdle();
      assert.ok(await page.isVisible('#sidebar .nav-link'));
      const setConfig = (await app.calls()).filter((c) => c.name === 'api_setConfig');
      assert.equal(setConfig.length, 2);
      assert.deepEqual(setConfig[1].args, { source: url });
      assert.equal(await page.evaluate(() => window.State.get().configured), true);
      assert.deepEqual(app.errors, []);
    });
  });

  test('Équipe / Bâtiment filters persist across pages', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      const eq = '#filter-equipe .dd-trigger';
      const bat = '#filter-batiment .dd-trigger';
      assert.deepEqual(await optionLabels(page, eq), ['Labo Chaussure', 'Labo Mécanique', 'Labo Textile', 'R&D Vélo']);
      assert.deepEqual(await optionLabels(page, bat), ['Bâtiment A', 'Bâtiment B', 'Bâtiment C']);

      // The list opens as a popover (portalled to <body>): the sidebar does not grow.
      const sidebarH = await page.$eval('#sidebar .sidebar-inner', (n) => n.scrollHeight);
      await page.click(eq);
      assert.equal(await page.getAttribute(eq, 'aria-expanded'), 'true');
      assert.equal(await page.$eval('#sidebar .sidebar-inner', (n) => n.scrollHeight), sidebarH);
      assert.equal(await page.getAttribute(`#${await page.getAttribute(eq, 'aria-controls')}`, 'aria-multiselectable'), 'true');
      await chooseOptions(page, eq, ['Labo Textile']);
      await app.waitIdle();
      await chooseOptions(page, bat, ['Bâtiment A']);
      await app.waitIdle();
      const expected = { equipes: ['Labo Textile'], batiments: ['Bâtiment A'] };
      assert.deepEqual(await page.evaluate(() => window.State.get().filters), expected);

      for (const id of ['postes', 'timeline', 'dashboard']) {
        await app.goto(id);
        assert.deepEqual(await page.evaluate(() => window.State.get().filters), expected, `filters kept on ${id}`);
        assert.equal((await page.textContent('#filter-equipe .dd-value')).trim(), 'Labo Textile');
        assert.deepEqual(await dropdownValue(page, eq), ['Labo Textile']);
        if (id !== 'actions') assert.deepEqual(await dropdownValue(page, bat), ['Bâtiment A']);
      }

      // Month change keeps the filters too.
      await chooseOption(page, '#month-select', '2026-04');
      await page.waitForFunction(() => ((document.getElementById('dashboard-caption') || {}).dataset || {}).month === '2026-04');
      await app.waitIdle();
      assert.deepEqual(await page.evaluate(() => window.State.get().filters), expected);

      await page.click('#filters-reset');
      await app.waitIdle();
      assert.deepEqual(await page.evaluate(() => window.State.get().filters), { equipes: [], batiments: [] });
      assert.equal((await page.textContent('#filter-equipe .dd-value')).trim(), 'Toutes');
      assert.deepEqual(app.errors, []);
    });
  });

  test('collapses the sidebar into a top bar below 900px', async () => {
    await withApp({ viewport: { width: 700, height: 900 } }, async (app) => {
      const { page } = app;
      assert.ok(await page.isVisible('#nav-toggle'));
      assert.ok(!(await page.isVisible('#sidebar')));
      await page.click('#nav-toggle');
      assert.equal(await page.getAttribute('#nav-toggle', 'aria-expanded'), 'true');
      assert.ok(await page.isVisible('#sidebar .nav-link[data-page="postes"]'));
      await page.click('#sidebar .nav-link[data-page="postes"]');
      await page.waitForSelector('#main .page[data-page="postes"]');
      assert.ok(!(await page.isVisible('#sidebar')), 'menu closes after navigation');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'no horizontal page scroll (' + overflow + 'px)');
      assert.deepEqual(app.errors, []);
    });
  });
  test('UI components: editableTable, formModal, confirm, drawer, tabs, CSV', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      // ---- editableTable: inline select + input edits, dirty tracking, save, cancel, sort, search, paging
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'ui-test';
        document.getElementById('main').appendChild(host);
        const rows = Array.from({ length: 60 }, (_, i) => ({ _id: 'r' + i, name: 'Poste ' + String(i).padStart(2, '0'),
          edr: i % 2 ? 'Oui' : 'Non', note: null }));
        window.__saved = [];
        window.__table = UI.editableTable({
          columns: [{ key: 'name', label: 'Nom' }, { key: 'edr', label: 'EDR', editable: true, options: ['Oui', 'Non'] },
            { key: 'note', label: 'Note', editable: true },
            { key: '_calc', label: 'Calcul', render: (r) => (r.edr === 'Oui' ? 'EDR présent' : 'EDR absent') }],
          rows,
          pageSize: 25,
          onSave: (changes) => { window.__saved.push(changes); return Promise.resolve(); },
        });
        host.appendChild(window.__table.node);
      });
      const t = '#ui-test';
      assert.equal(await page.$$eval(`${t} tbody tr`, (r) => r.length), 25);
      assert.match(await page.textContent(`${t} .etable-pager`), /Page 1 \/ 3/);
      const edrCell = `${t} tbody tr[data-id="r0"] td[data-col="edr"]`;
      const widthBefore = await page.$eval(edrCell, (td) => td.getBoundingClientRect().width);
      await page.click(edrCell);
      // The editor is laid over the cell: the column keeps its width; the list opens at once.
      assert.equal(await page.$eval(edrCell, (td) => td.getBoundingClientRect().width), widthBefore);
      assert.equal(await page.getAttribute(`${edrCell} .dd-trigger`, 'aria-expanded'), 'true');
      assert.equal(await page.textContent(`${t} tbody tr[data-id="r0"] td[data-col="_calc"]`), 'EDR absent');
      await chooseOption(page, `${edrCell} .dd-trigger`, 'Oui');
      // The whole row is re-rendered after an inline edit: computed columns follow immediately.
      assert.equal(await page.textContent(`${t} tbody tr[data-id="r0"] td[data-col="_calc"]`), 'EDR présent');
      await page.click(`${t} tbody tr[data-id="r1"] td[data-col="note"]`);
      await page.fill(`${t} tbody tr[data-id="r1"] td[data-col="note"] input`, 'À vérifier');
      await page.keyboard.press('Enter');
      assert.equal(await page.textContent(`${t} .etable-save`), 'Enregistrer (2)');
      assert.equal(await page.$$eval(`${t} .cell-dirty`, (n) => n.length), 2);
      assert.deepEqual(await page.evaluate(() => window.__table.getDirty()), [
        { id: 'r0', updates: { edr: 'Oui' } }, { id: 'r1', updates: { note: 'À vérifier' } }]);
      await page.click(`${t} .etable-save`);
      await page.waitForFunction(() => window.__saved.length === 1);
      await page.waitForSelector(`${t} .etable-dirtybar`, { state: 'hidden' });
      assert.equal(await page.textContent(`${t} tbody tr[data-id="r1"] td[data-col="note"]`), 'À vérifier');
      // cancel reverts
      await page.click(`${t} tbody tr[data-id="r2"] td[data-col="edr"]`);
      await chooseOption(page, `${t} tbody tr[data-id="r2"] td[data-col="edr"] .dd-trigger`, '—');
      await page.click(`${t} .etable-cancel`);
      assert.equal(await page.textContent(`${t} tbody tr[data-id="r2"] td[data-col="edr"]`), 'Non');
      // search + sort
      await page.fill(`${t} .etable-search`, 'poste 5');
      assert.equal(await page.$$eval(`${t} tbody tr`, (r) => r.length), 10);
      await page.fill(`${t} .etable-search`, '');
      await page.click(`${t} th:first-child .th-sort`);
      await page.click(`${t} th:first-child .th-sort`);
      assert.equal(await page.textContent(`${t} tbody tr:first-child td[data-col="name"]`), 'Poste 59');

      // ---- formModal: required + date round-trip in DD/MM/YYYY + select allowCustom
      const formPromise = page.evaluate(() => UI.formModal({ title: 'Test', fields: [
        { name: 'action', label: 'Action', required: true },
        { name: 'deadline', label: 'Deadline', type: 'date', value: '15/03/2026' },
        { name: 'status', label: 'Statut', type: 'select', options: ['À faire', 'Terminé'], value: 'À faire' },
        { name: 'poste', label: 'Poste', type: 'select', allowCustom: true, options: ['LAB-TEX-01'] },
      ] }));
      await page.waitForSelector('.modal form');
      assert.equal(await page.$('.modal select, .modal input[type=date], .modal datalist'), null);
      assert.equal(await page.inputValue('.modal input[name=deadline]'), '15/03/2026');
      await page.click('.modal .btn-primary');
      assert.equal((await page.textContent('.modal .field-error:not([hidden])')).trim(), 'Ce champ est obligatoire.');
      assert.equal(await page.evaluate(() => document.activeElement.name), 'action', 'first invalid field focused');
      await page.fill('.modal input[name=action]', '  Installer EDR ');
      await typeDate(page, '.modal input[name=deadline]', '30/04/2026');
      await chooseOption(page, '.modal [name=status]', 'Terminé');
      await chooseOption(page, '.modal input[name=poste]', 'Nouveau poste');
      await page.click('.modal .btn-primary');
      assert.deepEqual(await formPromise, { action: 'Installer EDR', deadline: '30/04/2026', status: 'Terminé', poste: 'Nouveau poste' });

      // ---- confirm (danger: the focus starts on « Annuler »)
      const conf = page.evaluate(() => UI.confirm('Sûr ?', { danger: true }));
      await page.waitForSelector('.modal .btn-danger');
      await page.waitForFunction(() => document.activeElement && document.activeElement.textContent === 'Annuler');
      await page.click('.modal .btn-danger');
      assert.equal(await conf, true);
      const conf2 = page.evaluate(() => UI.confirm('Sûr ?'));
      await page.click('.modal .btn-secondary');
      assert.equal(await conf2, false);

      // ---- drawer + tabs
      await page.evaluate(() => {
        window.__tabsRendered = [];
        const tabs = UI.tabs([
          { id: 'a', label: 'Onglet A', render: (root) => { window.__tabsRendered.push('a'); root.appendChild(UI.el('p', null, 'Contenu A')); } },
          { id: 'b', label: 'Onglet B', render: (root) => { window.__tabsRendered.push('b'); root.appendChild(UI.el('p', null, 'Contenu B')); } },
        ], 'b');
        UI.drawer({ title: '<b>Titre</b>', body: tabs });
      });
      await page.waitForSelector('.drawer.open');
      assert.equal(await page.textContent('.drawer-title'), '<b>Titre</b>');
      assert.equal(await page.textContent('.drawer .tabpanel'), 'Contenu B');
      await page.click('.drawer [role=tab][data-tab="a"]');
      assert.equal(await page.textContent('.drawer .tabpanel'), 'Contenu A');
      assert.equal(await page.getAttribute('.drawer [role=tab][data-tab="a"]', 'aria-selected'), 'true');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.drawer', { state: 'detached' });

      // ---- formatting + CSV export
      assert.deepEqual(await page.evaluate(() => [UI.fmtPct(30.4), UI.fmtPct(null), UI.fmtPct(80, 0)]),
        ['30,4\u202f%', '—', '80\u202f%']);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.evaluate(() => UI.downloadCsv('export.csv', ['a', 'b'], [{ a: '=1+1', b: 'x;y' }, { a: null, b: 'é"t' }])),
      ]);
      const csv = fs.readFileSync(await download.path(), 'utf8');
      assert.equal(csv, '﻿a;b\r\n\'=1+1;"x;y"\r\n;"é""t"');
      assert.deepEqual(app.errors, []);
    });
  });
});
