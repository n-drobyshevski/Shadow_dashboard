'use strict';
/**
 * E2E smoke tests of the client shell (App router, sidebar, configuration screen, filters).
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { openApp } = require('./harness');

const PAGES = [
  { id: 'dashboard', title: 'Tableau de bord' },
  { id: 'postes', title: 'Postes' },
  { id: 'apps', title: 'Applications' },
  { id: 'timeline', title: 'Suivi temporel' },
  { id: 'actions', title: 'Suivi actions' },
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
      assert.equal(await page.textContent('#sidebar .brand'), '👻Shadow IT');
      assert.equal(await page.getAttribute('#sidebar .nav-link[data-page="dashboard"]', 'aria-current'), 'page');

      // Période: ascending months, latest selected by default.
      assert.deepEqual(await page.$$eval('#month-select option', (os) => os.map((o) => o.value)), ['2026-04', '2026-05']);
      assert.equal(await page.inputValue('#month-select'), '2026-05');

      // Footer links open in a new tab without opener.
      for (const id of ['#link-data', '#link-source']) {
        assert.equal(await page.getAttribute(id, 'target'), '_blank');
        assert.match(await page.getAttribute(id, 'rel'), /noopener/);
        assert.match(await page.getAttribute(id, 'href'), /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
      }
      assert.equal((await page.textContent('#link-data')).trim(), '📊 Données (Google Sheet)');
      assert.ok(await page.isVisible('#btn-source'));

      const calls = await app.calls();
      assert.equal(calls[0].name, 'api_bootstrap');
      assert.deepEqual(app.errors, []);
    });
  });

  test('navigates to all 5 pages without errors and pushes history', async () => {
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
      assert.deepEqual(history.map((h) => h.state.page), ['postes', 'apps', 'timeline', 'actions', 'dashboard']);

      // Browser back/forward: the history change handler navigates without pushing again.
      await page.evaluate(() => window.__mock.popState({ page: 'apps' }));
      await page.waitForSelector('#main .page[data-page="apps"]');
      assert.equal((await page.evaluate(() => window.__history)).length, 5);
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
      const equipes = await page.$$eval('#filter-equipe input[type=checkbox]', (cs) => cs.map((c) => c.value));
      assert.deepEqual(equipes, ['Labo Chaussure', 'Labo Mécanique', 'Labo Textile', 'R&D Vélo']);
      const batiments = await page.$$eval('#filter-batiment input[type=checkbox]', (cs) => cs.map((c) => c.value));
      assert.deepEqual(batiments, ['Bâtiment A', 'Bâtiment B', 'Bâtiment C']);

      await page.click('#filter-equipe .ms-toggle');
      assert.equal(await page.getAttribute('#filter-equipe .ms-toggle', 'aria-expanded'), 'true');
      await page.check('#filter-equipe input[value="Labo Textile"]');
      await app.waitIdle();
      await page.click('#filter-batiment .ms-toggle');
      await page.check('#filter-batiment input[value="Bâtiment A"]');
      await app.waitIdle();
      const expected = { equipes: ['Labo Textile'], batiments: ['Bâtiment A'] };
      assert.deepEqual(await page.evaluate(() => window.State.get().filters), expected);

      for (const id of ['postes', 'timeline', 'dashboard']) {
        await app.goto(id);
        assert.deepEqual(await page.evaluate(() => window.State.get().filters), expected, `filters kept on ${id}`);
        assert.equal((await page.textContent('#filter-equipe .ms-summary')).trim(), 'Labo Textile');
        assert.equal(await page.isChecked('#filter-equipe input[value="Labo Textile"]'), true);
        assert.equal(await page.isChecked('#filter-batiment input[value="Bâtiment A"]'), true);
      }

      // Month change keeps the filters too.
      await page.selectOption('#month-select', '2026-04');
      await page.waitForFunction(() => (document.getElementById('dashboard-caption') || {}).textContent === 'Export : 2026-04');
      await app.waitIdle();
      assert.deepEqual(await page.evaluate(() => window.State.get().filters), expected);

      await page.click('#filters-reset');
      await app.waitIdle();
      assert.deepEqual(await page.evaluate(() => window.State.get().filters), { equipes: [], batiments: [] });
      assert.equal((await page.textContent('#filter-equipe .ms-summary')).trim(), 'Toutes');
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
            { key: 'note', label: 'Note', editable: true }],
          rows,
          pageSize: 25,
          onSave: (changes) => { window.__saved.push(changes); return Promise.resolve(); },
        });
        host.appendChild(window.__table.node);
      });
      const t = '#ui-test';
      assert.equal(await page.$$eval(`${t} tbody tr`, (r) => r.length), 25);
      assert.match(await page.textContent(`${t} .etable-pager`), /Page 1 \/ 3/);
      await page.click(`${t} tbody tr[data-id="r0"] td[data-col="edr"]`);
      await page.selectOption(`${t} tbody tr[data-id="r0"] td[data-col="edr"] select`, 'Oui');
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
      await page.selectOption(`${t} tbody tr[data-id="r2"] td[data-col="edr"] select`, '');
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
      assert.equal(await page.inputValue('.modal input[type=date]'), '2026-03-15');
      await page.click('.modal .btn-primary');
      assert.equal((await page.textContent('.modal .field-error:not([hidden])')).trim(), 'Ce champ est obligatoire.');
      await page.fill('.modal input[name=action]', '  Installer EDR ');
      await page.fill('.modal input[type=date]', '2026-04-30');
      await page.selectOption('.modal select[name=status]', 'Terminé');
      await page.fill('.modal input[name=poste]', 'Nouveau poste');
      await page.click('.modal .btn-primary');
      assert.deepEqual(await formPromise, { action: 'Installer EDR', deadline: '30/04/2026', status: 'Terminé', poste: 'Nouveau poste' });

      // ---- confirm
      const conf = page.evaluate(() => UI.confirm('Sûr ?', { danger: true }));
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
      assert.deepEqual(await page.evaluate(() => [UI.fmtPct(30.4), UI.fmtPct(null), UI.fmtPct(80, 0)]), ['30,4 %', '—', '80 %']);
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
