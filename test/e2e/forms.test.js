'use strict';
/**
 * E2E tests of the creation forms (« Nouveau poste », « Nouvelle application »): UI.formPanel in a side panel,
 * fields read from api_getFormSchema (docs/API.md §5 "EntityForm", docs/DESIGN.md "Form panel").
 * The mock (test/fixtures/mockRun.js) answers the schema from the month's headers; in the current month its
 * "live source" computes Score conformité / Niveau de risque / Statut and rejects values outside some lists.
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/forms.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../fixtures/data');
const { openApp, chooseOption, chooseOptions, dropdownValue, typeDate } = require('./harness');

const MONTH = '2026-05';
const KEY_POSTE = 'Nom du poste';
const KEY_APP = 'Nom du logiciel / service';
const PANEL = '.drawer.form-panel';
// 2026-05 followed by the sync (current month): the form writes into the source.
const LIVE = { page: 'postes', currentMonth: MONTH };

async function withApp(options, fn) {
  const app = await openApp(options);
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

async function rowIds(page, table) {
  return page.$$eval(`#${table}-table tbody tr[data-id]`, (trs) => trs.map((tr) => tr.dataset.id));
}

/** Opens the form of the page (« Nouveau poste » / « Nouvelle application ») and waits for its fields. */
async function openForm(app, button = '#postes-add') {
  await app.page.click(button);
  await app.page.waitForSelector(`${PANEL} .form-sections`);
  await app.waitIdle();
}

const field = (name) => `${PANEL} [data-name="${name}"]`;

/** [{id, title, open}] of the sections of the open form. */
function sections(page) {
  return page.$$eval(`${PANEL} details.form-section`, (ds) => ds.map((d) => ({ id: d.dataset.group,
    title: d.querySelector('summary').textContent.trim(), open: d.open })));
}

function fieldsOf(page, group) {
  return page.$$eval(`${PANEL} details[data-group="${group}"] .form-field`, (fs) => fs.map((f) => f.dataset.field));
}

async function footerButton(page, label) {
  await page.click(`${PANEL} .drawer-footer button:has-text("${label}")`);
}

/** No native controls / tooltips left in the page or its overlays (docs/DESIGN.md, js_controls.html). */
async function assertNoNativeControls(page) {
  assert.deepEqual(await page.$$eval('select, input[type=date], input[type=month], input[list], datalist, [title]',
    (ns) => ns.map((n) => n.outerHTML.slice(0, 80))), []);
}

function activeName(page) {
  return page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-name'));
}

async function waitPanelGone(page) {
  await page.waitForSelector('.drawer', { state: 'detached' });
}

// --------------------------------------------------------------------------------------------- opening

describe('« Nouveau poste »: the panel', () => {
  test('header buttons, title, sections, required marks, computed note, footer note, focus', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      assert.deepEqual(await page.$$eval('#main .page-header-actions button', (bs) => bs.map((b) => b.textContent.trim())),
        ['Exporter CSV', 'Poste générique', 'Nouveau poste']);
      await openForm(app);
      // A side panel: the table stays in the page behind it.
      assert.ok(await page.isVisible('#postes-table'));
      assert.equal((await page.textContent(`${PANEL} .drawer-title`)).trim(), 'Nouveau poste — mai 2026');
      assert.deepEqual((await callsNamed(app, 'api_getFormSchema')).map((c) => c.args), [{ entity: 'postes', month: MONTH }]);

      assert.deepEqual(await sections(page), [
        { id: 'identification', title: 'Identification', open: true },
        { id: 'equipement', title: 'Équipement', open: true },
        { id: 'conformite', title: 'Conformité', open: true },
        { id: 'visite', title: 'Visite', open: false },
        { id: 'suivi', title: 'Suivi', open: false },
      ]);
      assert.deepEqual(await fieldsOf(page, 'identification'), [KEY_POSTE, 'Équipe', 'Bâtiment / Labo', 'Responsable']);
      assert.deepEqual(await fieldsOf(page, 'conformite'),
        ['IT Decathlon', 'EDR Decathlon', 'Chiffrement disque', 'Réseau Decathlon', 'Type de compte', 'Enrolée']);
      // Computed columns are no fields: one note at the end of « Conformité ».
      assert.deepEqual(await fieldsOf(page, 'suivi'), ['Action corrective', 'Responsable action', 'Deadline', 'Application', 'Commentaires']);
      assert.deepEqual(await page.$$eval(`${PANEL} .form-section-note`, (ns) => ns.map((n) => [n.closest('details').dataset.group, n.textContent])),
        [['conformite', 'Score conformité, Niveau de risque, Statut : calculés par le Google Sheet.']]);
      // Every source column is a field or named by the note; nothing goes to « Autres colonnes ».
      assert.equal(await page.$(`${PANEL} details[data-group="autres"]`), null);
      assert.equal(await page.$$eval(`${PANEL} .form-field`, (fs) => fs.length), data.POSTES_HEADERS.length - 3);

      assert.deepEqual(await page.$$eval(`${PANEL} .form-field:has(.required)`, (fs) => fs.map((f) => f.dataset.field)), [KEY_POSTE, 'Équipe']);
      // Strict lists are dropdowns, open lists comboboxes, dates date fields, comments a textarea.
      assert.equal(await page.getAttribute(field('Criticité équipement'), 'aria-haspopup'), 'listbox');
      assert.equal(await page.getAttribute(field('Équipe'), 'role'), 'combobox');
      assert.ok(await page.$(`${PANEL} .datefield [data-name="Date d'achat"]`));
      assert.equal(await page.$eval(field('Commentaires'), (n) => n.tagName), 'TEXTAREA');
      assert.ok(await page.$(`${field(KEY_POSTE)}.mono`));

      assert.equal((await page.textContent(`${PANEL} .drawer-footer-note`)).trim(), 'Écrit dans le Google Sheet source.');
      assert.deepEqual(await page.$$eval(`${PANEL} .drawer-footer button`, (bs) => bs.map((b) => b.textContent.trim())),
        ['Annuler', 'Créer le poste']);
      assert.match(await page.textContent(`${PANEL} .form-panel-meta`), /^Colonnes lues dans le Google Sheet source à \d\d:\d\d\.Relire les colonnes$/);
      await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-name') === 'Nom du poste');
      await assertNoNativeControls(page);
      // A collapsed section opens on a click on its label.
      await page.click(`${PANEL} details[data-group="visite"] > summary`);
      assert.equal(await page.$eval(`${PANEL} details[data-group="visite"]`, (d) => d.open), true);
      assert.deepEqual(app.errors, []);
    });
  });

  test('the schema is prefetched on hover and kept; « Relire les colonnes » reads the source again, values kept', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      await page.hover('#postes-add');
      await app.waitIdle();
      assert.equal((await callsNamed(app, 'api_getFormSchema')).length, 1);
      await openForm(app);
      await page.keyboard.press('Escape');      // no changes: closes at once
      await waitPanelGone(page);
      await openForm(app);
      assert.equal((await callsNamed(app, 'api_getFormSchema')).length, 1, 'kept on the client');

      await page.fill(field(KEY_POSTE), 'LAB-NEW-09');
      await page.click(`${PANEL} .form-panel-reload`);
      await page.waitForSelector(`${PANEL} .form-sections`);
      await app.waitIdle();
      const calls = await callsNamed(app, 'api_getFormSchema');
      assert.deepEqual(calls.map((c) => c.args), [{ entity: 'postes', month: MONTH }, { entity: 'postes', month: MONTH, fresh: true }]);
      assert.equal(await page.inputValue(field(KEY_POSTE)), 'LAB-NEW-09');
      assert.deepEqual(app.errors, []);
    });
  });

  test('current month: once the schema is read, its array-formula columns are read-only in the table (also after a re-mount)', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table');
      const editableHeads = () => page.$$eval('#postes-table thead th.th-editable', (ths) => ths.map((th) => th.textContent.trim()));
      const editableCells = (col) => page.$$eval(`#postes-table td.cell-editable[data-col="${col}"]`, (tds) => tds.length);
      // Score / Niveau de risque: filled by an array formula (every row computed). Statut: the last row's own
      // formula only (other rows may hold values): it stays editable, the server checks each cell.
      const COMPUTED = ['Score conformité', 'Niveau de risque'];
      const id = await page.evaluate(() => window.State.getMonthData('2026-05').postes.find((p) => p['Nom du poste'] === 'LAB-MEC-01')._id);
      const cell = (col) => `#postes-table tbody tr[data-id="${id}"] td[data-col="${col}"]`;
      // Not read yet: every source column is editable.
      for (const c of COMPUTED.concat('Responsable', 'Statut')) assert.ok((await editableHeads()).includes(c), c);
      // A computed cell edited (dirty), then another cell being edited when the schema arrives (hover prefetch).
      await page.click(cell('Score conformité'));
      await page.fill(`${cell('Score conformité')} .cell-editor-host input`, '85%');
      await page.press(`${cell('Score conformité')} .cell-editor-host input`, 'Enter');
      await page.click(cell('Responsable'));
      await page.fill(`${cell('Responsable')} .cell-editor-host input`, 'Zoé Lefèvre');
      await page.hover('#postes-add');
      await app.waitIdle();
      assert.equal((await callsNamed(app, 'api_getFormSchema')).length, 1);
      assert.deepEqual((await editableHeads()).filter((h) => COMPUTED.includes(h)), [], 'locked');
      assert.ok((await editableHeads()).includes('Responsable'));
      assert.ok((await editableHeads()).includes('Statut'), 'a per-row formula does not lock the column');
      // The dropped unsaved value is announced.
      const toast = (await page.textContent('.toast-msg')).replace(/[\u00a0\u202f]/g, ' ');
      assert.equal(toast, 'Modifications non enregistrées annulées dans la colonne « Score conformité » : elle est ' +
        'calculée par une formule dans le Google Sheet source.');
      assert.ok(await page.$(`${cell('Responsable')} .cell-editor-host input`), 'the open editor stays');
      await page.press(`${cell('Responsable')} .cell-editor-host input`, 'Enter');
      await page.waitForSelector(`${cell('Responsable')} .cell-editor-host`, { state: 'detached' });
      for (const c of COMPUTED) assert.equal(await editableCells(c), 0, c);
      assert.ok(await editableCells('Responsable') > 0);
      assert.ok(await editableCells('Statut') > 0);
      // The unsaved value of the locked column is dropped; the other one is saved.
      assert.equal((await page.textContent('#postes-table .etable-save')).trim(), 'Enregistrer (1)');
      await page.click('#postes-table .etable-save');
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_savePostes')).map((c) => c.args.changes),
        [[{ id, updates: { Responsable: 'Zoé Lefèvre' } }]]);
      // Re-mounted: read-only at once, from the schema State keeps (no new request).
      await app.goto('apps');
      await page.waitForSelector('#apps-table');
      await app.goto('postes');
      await page.waitForSelector('#postes-table');
      for (const c of COMPUTED) assert.equal(await editableCells(c), 0, c);
      assert.equal((await callsNamed(app, 'api_getFormSchema')).length, 1);
      assert.deepEqual(app.errors, []);
    });
  });

  test('Équipe defaults to the single active filter; a schema failure shows « Réessayer »', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      await chooseOptions(page, '#filter-equipe .dd-trigger', ['Labo Textile']);
      await app.waitIdle();
      await page.evaluate(() => { window.__mock.failNext.api_getFormSchema = { code: 'SOURCE_ERROR', message: 'Source injoignable' }; });
      await page.click('#postes-add');
      await page.waitForSelector(`${PANEL} .error-state`);
      assert.equal((await page.textContent(`${PANEL} .error-state p`)).trim(), 'Formulaire indisponible : Source injoignableRéessayer');
      assert.equal(await page.isDisabled(`${PANEL} .form-panel-submit`), true);
      await page.click(`${PANEL} .error-retry`);
      await page.waitForSelector(`${PANEL} .form-sections`);
      await app.waitIdle();
      assert.equal(await page.inputValue(field('Équipe')), 'Labo Textile');
      // A prefilled default is no change: Escape closes without asking.
      await page.keyboard.press('Escape');
      await waitPanelGone(page);
      assert.equal(await page.$('.modal'), null);
      assert.deepEqual(app.errors, []);
    });
  });
});

// --------------------------------------------------------------------------------------------- saving

describe('« Nouveau poste »: saving', () => {
  test('fill and submit: api_addPoste with the filled fields, row added with its computed values, toast, focus back', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      const before = (await rowIds(page, 'postes')).length;
      await openForm(app);
      await page.fill(field(KEY_POSTE), 'LAB-NEW-01');
      await chooseOption(page, field('Équipe'), 'Labo Textile');
      await chooseOption(page, field('Bâtiment / Labo'), 'Bâtiment A');
      await typeDate(page, field("Date d'achat"), '15/01/2024');
      await chooseOption(page, field('Criticité équipement'), 'Haute');
      for (const c of ['IT Decathlon', 'EDR Decathlon', 'Chiffrement disque', 'Réseau Decathlon']) await chooseOption(page, field(c), 'Oui');
      await footerButton(page, 'Créer le poste');
      await waitPanelGone(page);
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_addPoste')).map((c) => c.args), [{ month: MONTH, record: {
        [KEY_POSTE]: 'LAB-NEW-01', 'Équipe': 'Labo Textile', 'Bâtiment / Labo': 'Bâtiment A', "Date d'achat": '15/01/2024',
        'Criticité équipement': 'Haute', 'IT Decathlon': 'Oui', 'EDR Decathlon': 'Oui', 'Chiffrement disque': 'Oui',
        'Réseau Decathlon': 'Oui',
      } }]);
      const ids = await rowIds(page, 'postes');
      assert.equal(ids.length, before + 1);
      const id = await page.evaluate(() => window.State.getMonthData('2026-05').postes.find((p) => p['Nom du poste'] === 'LAB-NEW-01')._id);
      const row = `#postes-table tbody tr[data-id="${id}"]`;
      // The source's formulas came back with the record.
      assert.equal((await page.textContent(`${row} td[data-col="_score"]`)).trim(), '80,0\u202f%');
      assert.equal((await page.textContent(`${row} td[data-col="Statut"]`)).trim(), 'Conforme');
      assert.match(await page.textContent('#postes-stats'), new RegExp('^' + (before + 1) + ' postes'));
      assert.ok((await toasts(page)).includes('Poste «\u202fLAB-NEW-01\u202f» créé dans le Google Sheet source.'));
      assert.equal(await page.evaluate(() => document.activeElement.id), 'postes-add');
      assert.ok(await page.$eval(row, (tr) => { const r = tr.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }));
      assert.deepEqual(app.errors, []);
    });
  });

  test('a record hidden by the filters says so in the toast', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      await chooseOption(page, '#postes-conformity', 'Non conformes');
      await openForm(app);
      await page.fill(field(KEY_POSTE), 'LAB-NEW-02');
      await chooseOption(page, field('Équipe'), 'Labo Textile');
      for (const c of ['IT Decathlon', 'EDR Decathlon', 'Chiffrement disque', 'Réseau Decathlon']) await chooseOption(page, field(c), 'Oui');
      await page.press(field(KEY_POSTE), 'Enter');   // Enter in a single-line field submits
      await waitPanelGone(page);
      await app.waitIdle();
      assert.ok((await toasts(page)).includes('Poste «\u202fLAB-NEW-02\u202f» créé dans le Google Sheet source (masqué par les filtres actifs).'));
      assert.deepEqual(app.errors, []);
    });
  });

  test('duplicate name: inline error under the field, values kept, no error toast', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      await openForm(app);
      await page.fill(field(KEY_POSTE), 'lab-tex-01');
      await chooseOption(page, field('Équipe'), 'Labo Textile');
      await chooseOption(page, field('IT Decathlon'), 'Oui');
      await footerButton(page, 'Créer le poste');
      await app.waitIdle();
      await page.waitForSelector(`${PANEL} .form-field[data-field="${KEY_POSTE}"] .field-error:not([hidden])`);
      assert.match(await page.textContent(`${PANEL} .form-field[data-field="${KEY_POSTE}"] .field-error`), /existe déjà/);
      assert.equal(await page.getAttribute(field(KEY_POSTE), 'aria-invalid'), 'true');
      assert.equal(await activeName(page), KEY_POSTE);
      assert.equal(await page.inputValue(field(KEY_POSTE)), 'lab-tex-01');
      assert.equal(await page.inputValue(field('Équipe')), 'Labo Textile');
      assert.equal(await dropdownValue(page, field('IT Decathlon')), 'Oui');
      assert.equal((await toasts(page)).some((t) => /^Erreur/.test(t)), false);
      assert.equal(await page.isEnabled(`${PANEL} .form-panel-submit`), true);
      assert.deepEqual(app.errors, []);
    });
  });

  test('a server error on a field of a collapsed section opens it and focuses the field', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      await openForm(app);
      assert.equal(await page.$eval(`${PANEL} details[data-group="visite"]`, (d) => d.open), false);
      await page.fill(field(KEY_POSTE), 'LAB-NEW-03');
      await chooseOption(page, field('Équipe'), 'Labo Textile');
      await page.evaluate(() => {
        window.__mock.failNext.api_addPoste = { code: 'VALIDATION', message: 'Valeur refusée par le Google Sheet source.', field: 'Date visite' };
      });
      await footerButton(page, 'Créer le poste');
      await app.waitIdle();
      await page.waitForSelector(`${PANEL} .form-field[data-field="Date visite"] .field-error:not([hidden])`);
      assert.equal(await page.$eval(`${PANEL} details[data-group="visite"]`, (d) => d.open), true);
      assert.equal(await activeName(page), 'Date visite');
      assert.equal((await page.textContent(`${PANEL} .form-field[data-field="Date visite"] .field-error`)).trim(),
        'Valeur refusée par le Google Sheet source.');
      // An error without a field: an alert at the top of the form, the panel stays open.
      await page.evaluate(() => { window.__mock.failNext.api_addPoste = { code: 'BUSY', message: 'Verrou occupé' }; });
      await footerButton(page, 'Créer le poste');
      await app.waitIdle();
      await page.waitForSelector(`${PANEL} .form-alert .alert-error`);
      assert.equal((await page.textContent(`${PANEL} .form-alert .alert-error`)).trim(), 'Erreur : Verrou occupé');
      assert.equal((await toasts(page)).some((t) => /Verrou/.test(t)), false);
      assert.deepEqual(app.errors, []);
    });
  });
});

// --------------------------------------------------------------------------------------------- closing

describe('« Nouveau poste »: closing', () => {
  test('typed values: Escape, ×, backdrop and « Annuler » ask first; « Continuer la saisie » keeps them', async () => {
    await withApp(LIVE, async (app) => {
      const { page } = app;
      await openForm(app);
      await page.fill(field(KEY_POSTE), 'LAB-NEW-04');
      const ways = [
        ['Escape', () => page.keyboard.press('Escape')],
        ['×', () => page.click(`${PANEL} .drawer-header .icon-btn`)],
        ['backdrop', () => page.mouse.click(120, 450)],
        ['Annuler', () => footerButton(page, 'Annuler')],
      ];
      for (const [how, act] of ways) {
        await act();
        await page.waitForSelector('.modal .confirm-message');
        assert.equal((await page.textContent('.modal .modal-title')).trim(), 'Abandonner la saisie ?', how);
        assert.equal((await page.textContent('.modal .confirm-message')).trim(), 'Les valeurs saisies seront perdues.', how);
        assert.deepEqual(await page.$$eval('.modal-footer button', (bs) => bs.map((b) => b.textContent.trim())),
          ['Continuer la saisie', 'Abandonner'], how);
        // The safe button has the focus; one dialog only.
        await page.waitForFunction(() => document.activeElement && document.activeElement.textContent.trim() === 'Continuer la saisie');
        assert.equal(await page.$$eval('.modal', (ms) => ms.length), 1, how);
        await page.click('.modal-footer button:has-text("Continuer la saisie")');
        await page.waitForSelector('.modal', { state: 'detached' });
        assert.ok(await page.$(PANEL), how);
        assert.equal(await page.inputValue(field(KEY_POSTE)), 'LAB-NEW-04', how);
      }
      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal .confirm-message');
      await page.click('.modal-footer button:has-text("Abandonner")');
      await waitPanelGone(page);
      assert.equal(await page.$('.modal'), null);
      assert.equal((await callsNamed(app, 'api_addPoste')).length, 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'postes-add');

      // No changes: every way closes at once.
      for (const act of [() => page.keyboard.press('Escape'), () => page.click(`${PANEL} .drawer-header .icon-btn`),
        () => page.mouse.click(120, 450), () => footerButton(page, 'Annuler')]) {
        await openForm(app);
        await act();
        await waitPanelGone(page);
        assert.equal(await page.$('.modal'), null);
      }
      assert.deepEqual(app.errors, []);
    });
  });

  test('while saving the panel cannot be closed', async () => {
    await withApp({ ...LIVE, delays: { api_addPoste: 600 } }, async (app) => {
      const { page } = app;
      await openForm(app);
      await page.fill(field(KEY_POSTE), 'LAB-NEW-05');
      await chooseOption(page, field('Équipe'), 'Labo Textile');
      await footerButton(page, 'Créer le poste');
      await page.waitForSelector(`${PANEL} .form-panel-submit.is-busy`);
      await page.keyboard.press('Escape');
      await page.mouse.click(120, 450);
      assert.ok(await page.$(PANEL));
      assert.equal(await page.$('.modal'), null);
      assert.equal(await page.isDisabled(`${PANEL} .drawer-header .icon-btn`), true);
      assert.equal(await page.isDisabled(`${PANEL} .form-panel-cancel`), true);
      await app.waitIdle();
      await waitPanelGone(page);
      assert.equal((await callsNamed(app, 'api_addPoste')).length, 1);
      assert.deepEqual(app.errors, []);
    });
  });
});

// --------------------------------------------------------------------------------------------- schema variants

describe('« Nouveau poste »: schema variants', () => {
  test('a new source column appears in « Autres colonnes » and in the table once saved', async () => {
    await withApp({ ...LIVE, formSchema: { columns: { postes: [{ name: 'Numéro de série' }] } } }, async (app) => {
      const { page } = app;
      await openForm(app);
      const secs = await sections(page);
      assert.deepEqual(secs[secs.length - 1], { id: 'autres', title: 'Autres colonnes', open: true });
      assert.deepEqual(await fieldsOf(page, 'autres'), ['Numéro de série']);
      await page.fill(field(KEY_POSTE), 'LAB-NEW-06');
      await chooseOption(page, field('Équipe'), 'Labo Textile');
      await page.fill(field('Numéro de série'), 'SN-0042');
      await footerButton(page, 'Créer le poste');
      await waitPanelGone(page);
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_addPoste'))[0].args.record,
        { [KEY_POSTE]: 'LAB-NEW-06', 'Équipe': 'Labo Textile', 'Numéro de série': 'SN-0042' });
      const id = await page.evaluate(() => window.State.getMonthData('2026-05').postes.find((p) => p['Nom du poste'] === 'LAB-NEW-06')._id);
      assert.equal((await page.textContent(`#postes-table tbody tr[data-id="${id}"] td[data-col="Numéro de série"]`)).trim(), 'SN-0042');
      assert.deepEqual(app.errors, []);
    });
  });

  test('columns named after form members or __proto__: the panel renders and submits (no DOM clobbering)', async () => {
    // A control named 'addEventListener' would shadow form.addEventListener (named properties of
    // HTMLFormElement) and the panel would never render: column names are no name / id attributes.
    const NAMES = ['addEventListener', 'querySelectorAll', 'submit', 'elements', '__proto__'];
    await withApp({ ...LIVE, formSchema: { columns: { postes: NAMES.map((name) => ({ name })) } } }, async (app) => {
      const { page } = app;
      await openForm(app);
      assert.deepEqual(await fieldsOf(page, 'autres'), NAMES);
      assert.equal(await page.$$eval(`${PANEL} form [name], ${PANEL} form [id]`, (ns, names) => ns.filter((n) =>
        names.indexOf(n.getAttribute('name')) >= 0 || names.indexOf(n.id) >= 0).length, NAMES), 0);
      assert.equal(await page.$eval(`${PANEL} form`, (f) => typeof f.addEventListener === 'function' &&
        typeof f.querySelectorAll === 'function' && typeof f.submit === 'function'), true);
      await page.fill(field(KEY_POSTE), 'LAB-NEW-07');
      await chooseOption(page, field('Équipe'), 'Labo Textile');
      for (const [i, name] of NAMES.entries()) await page.fill(field(name), 'v' + i);
      await footerButton(page, 'Créer le poste');
      // '__proto__' is a key of the record like the others (the values map has no prototype): the server
      // refuses it as any '_' column, and the panel stays open with the message.
      await page.waitForSelector(`${PANEL} .form-alert:not([hidden])`);
      assert.match(await page.textContent(`${PANEL} .form-alert`), /Champ non modifiable\s:\s«\s__proto__\s»/);
      await page.fill(field('__proto__'), '');
      await footerButton(page, 'Créer le poste');
      await waitPanelGone(page);
      await app.waitIdle();
      // As sent (JSON parsed in Node: '__proto__' is an own key there too).
      const sent = JSON.parse(await page.evaluate(() =>
        JSON.stringify(window.__calls.filter((c) => c.name === 'api_addPoste').map((c) => c.args.record))));
      const record = { [KEY_POSTE]: 'LAB-NEW-07', 'Équipe': 'Labo Textile', addEventListener: 'v0', querySelectorAll: 'v1',
        submit: 'v2', elements: 'v3' };
      assert.deepEqual(sent, [JSON.parse(JSON.stringify(record).replace(/\}$/, ',"__proto__":"v4"}')), record]);
      assert.ok((await toasts(page)).includes('Poste « LAB-NEW-07 » créé dans le Google Sheet source.'));
      assert.equal(await page.evaluate(() => Object.getPrototypeOf({}) === Object.prototype && ({}).submit === undefined), true);
      assert.deepEqual(app.errors, []);
    });
  });

  test('source unreachable: the fallback alert, nothing computed', async () => {
    await withApp({ ...LIVE, formSchema: { fallback: true } }, async (app) => {
      const { page } = app;
      await openForm(app);
      assert.match(await page.textContent(`${PANEL} .form-panel-alert`), /n’a pas pu être lu/);
      assert.equal(await page.$(`${PANEL} .form-section-note`), null);
      assert.ok((await fieldsOf(page, 'suivi')).includes('Score conformité'));
      assert.match(await page.textContent(`${PANEL} .form-panel-meta`), /^Colonnes de la dernière synchronisation/);
      assert.deepEqual(app.errors, []);
    });
  });

  test('past month: frozen-month note, computed columns are plain fields, written to the history', async () => {
    await withApp({ page: 'postes' }, async (app) => {
      const { page } = app;
      await openForm(app);
      assert.equal((await page.textContent(`${PANEL} .drawer-footer-note`)).trim(),
        'Mois figé : ajouté à l’historique de mai 2026 seulement, le Google Sheet source n’est pas modifié.');
      assert.equal(await page.$(`${PANEL} .form-section-note`), null);
      assert.deepEqual(await fieldsOf(page, 'suivi'), ['Action corrective', 'Responsable action', 'Deadline', 'Statut',
        'Niveau de risque', 'Score conformité', 'Application', 'Commentaires']);
      await page.fill(field(KEY_POSTE), 'LAB-OLD-01');
      await chooseOption(page, field('Équipe'), 'Labo Mécanique');
      await page.click(`${PANEL} details[data-group="suivi"] > summary`);
      await page.fill(field('Score conformité'), '60%');
      await chooseOption(page, field('Statut'), 'Non conforme');
      await footerButton(page, 'Créer le poste');
      await waitPanelGone(page);
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_addPoste'))[0].args,
        { month: MONTH, record: { [KEY_POSTE]: 'LAB-OLD-01', 'Équipe': 'Labo Mécanique', 'Statut': 'Non conforme', 'Score conformité': '60%' } });
      assert.ok((await toasts(page)).includes('Poste «\u202fLAB-OLD-01\u202f» ajouté à l’historique de mai 2026.'));
      assert.deepEqual(app.errors, []);
    });
  });
});

// --------------------------------------------------------------------------------------------- applications

describe('« Nouvelle application »', () => {
  test('the same panel: sections, footer note, tokens for the postes', async () => {
    await withApp({ page: 'apps', currentMonth: MONTH }, async (app) => {
      const { page } = app;
      await openForm(app, '#apps-add');
      assert.equal((await page.textContent(`${PANEL} .drawer-title`)).trim(), 'Nouvelle application — mai 2026');
      assert.deepEqual(await sections(page), [
        { id: 'identification', title: 'Identification', open: true },
        { id: 'usage', title: 'Usage', open: true },
        { id: 'conformite', title: 'Conformité', open: true },
        { id: 'suivi', title: 'Suivi', open: false },
      ]);
      assert.deepEqual(await fieldsOf(page, 'identification'), [KEY_APP, 'Éditeur', 'Type', 'Équipe', 'Date']);
      assert.deepEqual(await fieldsOf(page, 'conformite'), ['Contrat', 'SIP', 'Galink', 'IDP', 'Niveau de risque']);
      assert.equal((await page.textContent(`${PANEL} .drawer-footer-note`)).trim(),
        'Écrit dans le Google Sheet source (Galink et IDP restent dans l’application).');
      assert.equal(await page.getAttribute(field('Installé sur poste'), 'role'), 'combobox');
      assert.ok(await page.$(`${field('Installé sur poste')}.mono`));
      assert.equal((await page.textContent(`${PANEL} .drawer-footer .btn-primary`)).trim(), 'Ajouter l’application');
      await assertNoNativeControls(page);
      // Only the filled fields are sent.
      await page.fill(field(KEY_APP), 'Teams');
      await chooseOption(page, field('Données sensibles exposées'), 'Oui');
      await footerButton(page, 'Ajouter l’application');
      await waitPanelGone(page);
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_getFormSchema')).map((c) => c.args), [{ entity: 'applications', month: MONTH }]);
      assert.deepEqual((await callsNamed(app, 'api_addApplication'))[0].args,
        { month: MONTH, record: { [KEY_APP]: 'Teams', 'Données sensibles exposées': 'Oui' } });
      assert.ok((await toasts(page)).includes('Application «\u202fTeams\u202f» ajoutée.'));
      assert.deepEqual(app.errors, []);
    });
  });
});

// --------------------------------------------------------------------------------------------- layout

describe('form panel at 390px', () => {
  test('no sideways scroll in the page or the panel; the footer buttons are on screen', async () => {
    await withApp({ ...LIVE, viewport: { width: 390, height: 844 } }, async (app) => {
      const { page } = app;
      const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      assert.ok(await noScroll(), 'page');
      await openForm(app);
      // The panel slides in from the right edge (.18s): measure once it is in place.
      await page.waitForFunction((sel) => document.querySelector(sel).getBoundingClientRect().left === 0, PANEL);
      assert.ok(await noScroll(), 'page with the panel');
      assert.ok(await page.$eval(PANEL, (p) => {
        const r = p.getBoundingClientRect();
        const body = p.querySelector('.drawer-body');
        return r.left >= 0 && r.right <= window.innerWidth && body.scrollWidth <= body.clientWidth;
      }), 'panel');
      const boxes = await page.$$eval(`${PANEL} .drawer-footer-note, ${PANEL} .drawer-footer button`, (ns) => ns.map((n) => {
        const r = n.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }));
      for (const b of boxes) assert.ok(b.left >= 0 && b.right <= 390 && b.bottom <= 844, JSON.stringify(b));
      // The note on its own line, the buttons under it on the right.
      assert.ok(boxes[1].top >= boxes[0].bottom);
      assert.ok(boxes[2].right > 390 - 24);
      assert.deepEqual(app.errors, []);
    });
  });
});
