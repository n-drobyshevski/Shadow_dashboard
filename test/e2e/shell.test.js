'use strict';
/**
 * E2E smoke tests of the client shell (App router, sidebar + collapsed rail, app bar with Période and
 * filters, configuration screen).
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { openApp, chooseOption, chooseOptions, optionLabels, dropdownValue, typeDate, choosePeriod, periodValue } = require('./harness');

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
      // The ghost logo (inline SVG, decorative: the wordmark names the app) leads the wordmark.
      assert.equal(await page.getAttribute('#sidebar .brand svg.brand-logo', 'aria-hidden'), 'true');
      assert.equal(await page.$$eval('#sidebar .brand svg.brand-logo circle', (ns) => ns.length), 2);
      // Text-only navigation: no emoji anywhere in the shell chrome.
      const chrome = await page.textContent('#sidebar') + await page.textContent('.topbar');
      assert.doesNotMatch(chrome, /\p{Extended_Pictographic}/u);
      // Counts next to Postes / Applications (2026-05 fixture: 7 postes, 5 applications).
      assert.equal(await page.textContent('#sidebar .nav-count[data-count="postes"]'), '7');
      assert.equal(await page.textContent('#sidebar .nav-count[data-count="apps"]'), '5');
      assert.equal(await page.getAttribute('#sidebar .nav-link[data-page="dashboard"]', 'aria-current'), 'page');

      // Période: the latest month by default (a button with its panel, no native <select>).
      assert.equal(await page.$('#sidebar select'), null);
      assert.equal(await page.getAttribute('#period-button', 'aria-haspopup'), 'dialog');
      assert.equal((await page.textContent('#period-button')).trim(), 'Mai 2026');
      assert.deepEqual(await periodValue(page), { from: '2026-05', to: '2026-05' });

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
      await choosePeriod(page, '2026-04');
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

  test('app bar: Période stepper and filters above every page', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      // Période / Filtres live in the sticky app bar, no longer in the sidebar.
      for (const id of ['#period-button', '#filter-equipe', '#filter-batiment']) {
        assert.equal(await page.$(`#appbar ${id}`) !== null, true, `${id} in the app bar`);
        assert.equal(await page.$(`#sidebar ${id}`), null, `${id} not in the sidebar`);
      }
      assert.equal((await page.textContent('#appbar-period-label')).trim(), 'Période');
      assert.equal(await page.isVisible('#filters-toggle'), false, 'no « Filtres » button on wide screens');

      // ‹ / › step through the imported months (2026-04, 2026-05; latest selected).
      assert.equal(await page.isDisabled('#month-next'), true);
      assert.equal(await page.isDisabled('#month-prev'), false);
      await page.click('#month-prev');
      await page.waitForFunction(() => ((document.getElementById('dashboard-caption') || {}).dataset || {}).month === '2026-04');
      await app.waitIdle();
      assert.deepEqual(await periodValue(page), { from: '2026-04', to: '2026-04' });
      assert.equal(await page.isDisabled('#month-prev'), true);
      assert.equal(await page.isDisabled('#month-next'), false);
      await page.click('#month-next');
      await page.waitForFunction(() => window.State.get().month === '2026-05');
      await app.waitIdle();

      // « 2 postes sur 7 » only while a filter is active.
      assert.equal(await page.isVisible('#appbar-count'), false);
      await chooseOptions(page, '#filter-equipe .dd-trigger', ['Labo Textile']);
      await app.waitIdle();
      assert.match((await page.textContent('#appbar-count')).trim(), /^\d+ postes? sur 7$/);

      // The bar stays on screen while the page scrolls.
      await page.evaluate(() => window.scrollTo(0, 600));
      const top = await page.$eval('#appbar', (n) => n.getBoundingClientRect().top);
      assert.equal(Math.round(top), 0);

      // Suivi des actions: Bâtiment does not apply, said in words (and in the accessible description).
      await app.goto('actions');
      assert.equal(await page.isDisabled('#filter-batiment .dd-trigger'), true);
      assert.equal((await page.textContent('#filter-batiment .dd-value')).trim(), 'Non applicable');
      assert.match(await page.textContent('#filter-batiment-na'), /les actions n’ont pas de bâtiment/);
      await app.goto('postes');
      assert.equal(await page.isDisabled('#filter-batiment .dd-trigger'), false);
      assert.deepEqual(app.errors, []);
    });
  });

  test('sidebar collapses to an icon rail and remembers it', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      // One line icon per page, hidden from assistive technology (the label names the link).
      const icons = await page.$$eval('#sidebar .nav-link', (ns) => ns.map((n) => {
        const svg = n.querySelector('svg.icon');
        return svg ? svg.getAttribute('aria-hidden') : null;
      }));
      assert.deepEqual(icons, PAGES.map(() => 'true'));
      assert.equal(await page.getAttribute('#nav-collapse', 'aria-expanded'), 'true');
      assert.equal((await page.textContent('#nav-collapse')).trim(), 'Réduire le menu');
      const wide = await page.$eval('#sidebar', (n) => n.getBoundingClientRect().width);
      assert.equal(Math.round(wide), 232);

      await page.click('#nav-collapse');
      await page.waitForFunction(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().width) === 56);
      // Saved for the account too (the Apps Script frame may lose localStorage).
      await app.waitIdle();
      const saves = (await app.calls()).filter((c) => c.name === 'api_savePrefs');
      assert.deepEqual(saves.map((c) => c.args), [{ sidebar: 'collapsed' }]);
      // The rail keeps only the ghost, centred.
      assert.equal(await page.isVisible('#sidebar .brand-name'), false);
      assert.ok(await page.isVisible('#sidebar .brand-logo'));
      assert.equal(await page.evaluate(() => document.body.classList.contains('nav-collapsed')), true);
      assert.equal(await page.getAttribute('#nav-collapse', 'aria-expanded'), 'false');
      const labelW = await page.$eval('#sidebar .nav-label', (n) => n.getBoundingClientRect().width);
      assert.ok(labelW <= 1, 'labels visually hidden in the rail (' + labelW + 'px)');
      assert.equal(await page.isVisible('#side-user'), false);
      // Labels stay in the accessibility tree; the name shows as a tooltip beside the icon.
      assert.match(await page.textContent('#sidebar .nav-link[data-page="postes"]'), /Postes/);
      await page.hover('#sidebar .nav-link[data-page="postes"]');
      await page.waitForSelector('.tooltip');
      assert.equal((await page.textContent('.tooltip')).trim(), 'Postes');
      assert.equal(await page.getAttribute('.tooltip', 'data-placement'), 'right');
      // Navigation still works from the rail.
      await page.click('#sidebar .nav-link[data-page="apps"]');
      await page.waitForSelector('#main .page[data-page="apps"]');

      // Remembered per browser.
      await page.reload();
      await page.waitForSelector('#sidebar .nav-link');
      assert.equal(await page.evaluate(() => document.body.classList.contains('nav-collapsed')), true);
      await page.click('#nav-collapse');
      assert.equal(await page.evaluate(() => document.body.classList.contains('nav-collapsed')), false);
      assert.equal(await page.evaluate(() => localStorage.getItem('shadowit.sidebar')), 'open');
      assert.equal(await page.$('#sidebar .nav-link .tooltip'), null);
      assert.deepEqual(app.errors, []);
    });
  });

  test('sidebar state comes back from the account when the browser refuses localStorage', async () => {
    const blockStorage = (page) => page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true,
        get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); } });
    });
    await withApp({ prefs: { sidebar: 'collapsed' }, beforeGoto: blockStorage }, async (app) => {
      const { page } = app;
      assert.equal(await page.evaluate(() => document.body.classList.contains('nav-collapsed')), true);
      assert.equal(await page.getAttribute('#nav-collapse', 'aria-expanded'), 'false');
      await page.click('#nav-collapse');
      await app.waitIdle();
      assert.equal(await page.evaluate(() => document.body.classList.contains('nav-collapsed')), false);
      assert.deepEqual((await app.calls()).filter((c) => c.name === 'api_savePrefs').map((c) => c.args), [{ sidebar: 'open' }]);
      assert.deepEqual(await page.evaluate(() => window.__mock.db.prefs['owner@decathlon.com']), { sidebar: 'open' });
      assert.deepEqual(app.errors, []);
    });
  });

  test('a choice kept only in this browser is uploaded to the account once', async () => {
    await withApp({ beforeGoto: (page) => page.addInitScript(() => localStorage.setItem('shadowit.sidebar', 'collapsed')) }, async (app) => {
      const { page } = app;
      assert.equal(await page.evaluate(() => document.body.classList.contains('nav-collapsed')), true);
      assert.deepEqual((await app.calls()).filter((c) => c.name === 'api_savePrefs').map((c) => c.args), [{ sidebar: 'collapsed' }]);
      assert.deepEqual(app.errors, []);
    });
  });

  test('collapses the sidebar into a top bar below 900px', async () => {
    await withApp({ viewport: { width: 700, height: 900 } }, async (app) => {
      const { page } = app;
      assert.ok(await page.isVisible('#nav-toggle'));
      assert.ok(await page.isVisible('.topbar-brand .brand-logo'), 'ghost in the top bar');
      assert.ok(!(await page.isVisible('#sidebar')));
      await page.click('#nav-toggle');
      assert.equal(await page.getAttribute('#nav-toggle', 'aria-expanded'), 'true');
      assert.ok(await page.isVisible('#sidebar .nav-link[data-page="postes"]'));
      await page.click('#sidebar .nav-link[data-page="postes"]');
      await page.waitForSelector('#main .page[data-page="postes"]');
      assert.ok(!(await page.isVisible('#sidebar')), 'menu closes after navigation');
      // Période stays visible; the filters fold behind « Filtres » (with the number of active values).
      assert.ok(await page.isVisible('#period-button'));
      assert.equal(await page.isVisible('#filter-equipe'), false);
      await page.click('#filters-toggle');
      assert.equal(await page.getAttribute('#filters-toggle', 'aria-expanded'), 'true');
      assert.ok(await page.isVisible('#filter-equipe'));
      await chooseOptions(page, '#filter-equipe .dd-trigger', ['Labo Textile']);
      await app.waitIdle();
      assert.equal((await page.textContent('#filters-toggle-count')).trim(), '1');
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

/** Holds every call to `name` until window.__release() (then restores api.call). */
async function holdCalls(page, name) {
  await page.evaluate((n) => {
    const orig = window.api.call;
    window.__held = [];
    window.__release = () => { window.__held.splice(0).forEach((f) => f()); window.api.call = orig; };
    window.api.call = function (callName, args) {
      if (callName !== n) return orig.apply(this, arguments);
      return new Promise((resolve, reject) => { window.__held.push(() => orig(callName, args).then(resolve, reject)); });
    };
  }, name);
}

describe('loading states', () => {
  test('startup splash: team logo and boot steps, gone once the dashboard is ready', async () => {
    await withApp({ delayMs: 300, readySelector: '#splash', idle: false }, async (app) => {
      const { page } = app;
      assert.ok(await page.isVisible('#splash .team-logo'));
      assert.equal(await page.getAttribute('#splash .team-logo', 'aria-label'), 'Value Chain Information Security');
      assert.equal(await page.getAttribute('#splash .splash-track', 'role'), 'progressbar');
      assert.equal((await page.textContent('#splash-status')).trim(), 'Vérification de l’accès…');
      assert.equal(await page.isVisible('#splash-note'), false);
      // The month is fetched behind the splash, so the dashboard mounts with its data.
      await page.waitForFunction(() => /^Chargement de mai 2026…$/.test(document.getElementById('splash-status').textContent));
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      await page.waitForSelector('#splash', { state: 'hidden' });
      await app.waitIdle();
      assert.equal(await page.$('#dashboard-body .skeleton'), null);
      const names = (await app.calls()).map((c) => c.name);
      assert.deepEqual(names.slice(0, 2), ['api_bootstrap', 'api_getMonthData']);
      assert.deepEqual(app.errors, []);
    });
  });

  test('slow start: a note explains the wait after 8 s', async () => {
    await withApp({ delayMs: 20000, readySelector: '#splash', idle: false,
      beforeGoto: (page) => page.clock.install() }, async (app) => {
      const { page } = app;
      assert.equal(await page.isVisible('#splash-note'), false);
      await page.clock.runFor(8100);
      assert.ok(await page.isVisible('#splash-note'));
      assert.match(await page.textContent('#splash-note'), /jusqu’à 30 secondes/);
      await page.clock.runFor(45000);
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      await page.clock.runFor(500);
      await page.waitForSelector('#splash', { state: 'hidden' });
      assert.deepEqual(app.errors, []);
    });
  });

  test('boot failure: the error and « Réessayer » replace the bar, retry boots the app', async () => {
    await withApp({ failNext: { api_bootstrap: { transport: true } }, readySelector: '#splash-error:not([hidden])' }, async (app) => {
      const { page } = app;
      assert.match(await page.textContent('#splash-error-text'), /^Impossible de charger l’application : /);
      assert.equal(await page.isVisible('#splash .splash-track'), false);
      assert.ok(await page.isVisible('#splash .team-logo'), 'the logo stays');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'splash-retry');
      await page.click('#splash-retry');
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      await page.waitForSelector('#splash', { state: 'hidden' });
      assert.deepEqual(app.errors.filter((e) => !/transport simulé/.test(e)), []);
    });
  });

  test('month change: the page stays dimmed with a progress line until the new month is in', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      assert.equal(await page.isVisible('#appbar-progress'), false);
      await holdCalls(page, 'api_getMonthData');
      await page.click('#month-prev');
      await page.waitForSelector('#main .page.is-stale[data-page="dashboard"]');
      assert.equal(await page.getAttribute('#main', 'aria-busy'), 'true');
      assert.ok(await page.isVisible('#appbar-progress'));
      assert.match(await page.textContent('#main .page'), /Mai 2026/i, 'previous month still readable');
      assert.ok(await page.$('#appbar-filters.is-stale #filter-equipe'), 'filters kept, dimmed');
      await page.evaluate(() => window.__release());
      await page.waitForFunction(() => ((document.getElementById('dashboard-caption') || {}).dataset || {}).month === '2026-04');
      await app.waitIdle();
      assert.equal(await page.$('#main .page.is-stale'), null);
      assert.equal(await page.$('#appbar-filters.is-stale'), null);
      assert.equal(await page.getAttribute('#main', 'aria-busy'), null);
      assert.equal(await page.isVisible('#appbar-progress'), false);
      // Back to a cached month: no dimming, the page mounts at once.
      await page.click('#month-next');
      await page.waitForFunction(() => ((document.getElementById('dashboard-caption') || {}).dataset || {}).month === '2026-05');
      assert.equal(await page.$('#main .page.is-stale'), null);
      assert.deepEqual(app.errors, []);
    });
  });

  test('page skeleton while a page body loads', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      await holdCalls(page, 'api_getMonthData');
      await page.evaluate(() => { window.State.invalidate(); window.App.refresh(); });
      await page.waitForSelector('#postes-body .skeleton[aria-busy="true"][role="status"]');
      assert.equal((await page.textContent('#postes-body .skeleton .sr-only')).trim(), 'Chargement des postes…');
      assert.equal(await page.$$eval('#postes-body .skeleton-table tbody tr', (ns) => ns.length), 6);
      assert.ok(await page.isVisible('#appbar-progress'));
      await page.evaluate(() => window.__release());
      await page.waitForSelector('#postes-body[aria-busy="false"]');
      await app.waitIdle();
      assert.equal(await page.$('#postes-body .skeleton'), null);
      assert.equal(await page.isVisible('#appbar-progress'), false);
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('filter changes re-render in place', () => {
  for (const id of ['postes', 'apps', 'dashboard', 'timeline']) {
    test(`${id}: the header stays, only the data block re-renders`, async () => {
      await withApp({ page: id }, async (app) => {
        const { page } = app;
        await page.evaluate(() => { window.__header = document.querySelector('#main .page-header'); });
        const calls = (await app.calls()).length;
        await chooseOptions(page, '#filter-equipe .dd-trigger', ['Labo Textile']);
        await app.waitIdle();
        assert.equal(await page.evaluate(() => document.querySelector('#main .page-header') === window.__header), true,
          'same header node: the page was not re-mounted');
        assert.ok(await page.$('#main .filter-note'), 'filter note shown');
        assert.equal((await app.calls()).length, calls, 'no server call for a filter change');
        assert.deepEqual(app.errors, []);
      });
    });
  }

  test('postes: an open drawer stays open while the filters change', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      await page.click('#postes-table tbody tr:first-child .postes-key');
      await page.waitForSelector('#poste-drawer');
      await page.evaluate(() => window.State.set({ filters: { equipes: ['Labo Textile'], batiments: [] } }));
      await app.waitIdle();
      assert.ok(await page.isVisible('#poste-drawer'));
      assert.deepEqual(app.errors, []);
    });
  });
});
