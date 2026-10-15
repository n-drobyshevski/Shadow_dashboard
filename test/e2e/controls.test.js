'use strict';
/**
 * E2E tests of the form controls (src/js_controls.html + the UI APIs rewired on them in src/js_ui.html):
 * UI.dropdown (single, keyboard, type-ahead, multiple, combobox, tokens), UI.dateField, UI.monthField,
 * UI.tooltip, UI.searchField (editableTable search), UI.formModal (busy, error kept, Enter, first
 * invalid), UI.confirm (initial focus), UI.busy, the table cell editors and UI.tabs.
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/controls.test.js
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, chooseOption, chooseOptions, optionLabels, dropdownValue, typeDate } = require('./harness');

const STATUSES = ['À faire', 'En cours', 'Terminé', 'Abandonné'];
const POSTES = ['LAB-TEX-01', 'LAB-MEC-02', 'RD-VELO-03'];

let app;
let page;

/** Replaces #main with a host holding the controls under test; change events land in window.__ev. */
async function mountHost() {
  await page.evaluate(({ STATUSES, POSTES }) => {
    UI.popover.closeAll();
    const main = document.getElementById('main');
    UI.clear(main);
    window.__ev = [];
    const log = (name) => (v) => window.__ev.push([name, v]);
    const host = UI.el('div', { id: 'host', class: 'page' },
      UI.select({ id: 'dd-status', label: 'Statut', options: STATUSES, value: 'En cours', onChange: log('status') }),
      UI.dropdown({ id: 'dd-prio', ariaLabel: 'Priorité', options: ['Haute', 'Moyenne', 'Basse'], value: '', placeholder: 'Choisir…',
        allowEmpty: true, onChange: log('prio') }),
      UI.select({ id: 'dd-off', label: 'Désactivé', options: ['A'], value: 'A', disabled: true }),
      UI.multiSelect({ id: 'dd-multi', label: 'Équipe', options: ['Labo Chaussure', 'Labo Mécanique', 'Labo Textile', 'R&D Vélo'],
        value: [], onChange: log('multi') }),
      UI.dropdown({ id: 'dd-long', label: 'Long', options: Array.from({ length: 30 }, (_, i) => 'Option ' + String(i + 1).padStart(2, '0')),
        value: 'Option 01', onChange: log('long') }),
      UI.dropdown({ id: 'dd-combo', label: 'Cible', combobox: true, mono: true, options: POSTES, value: '', onChange: log('combo') }),
      UI.dropdown({ id: 'dd-tokens', label: 'Installé sur poste', tokens: true, mono: true, options: POSTES, value: '',
        onChange: log('tokens') }),
      UI.dateField({ id: 'df', value: '15/03/2026', onChange: log('date'), ariaLabel: 'Échéance' }),
      UI.dateField({ id: 'df-min', value: '', min: '01/01/2026', ariaLabel: 'Depuis' }),
      UI.monthField({ id: 'mf', value: '2026-05', options: ['2026-04', '2026-05'], onChange: log('month'), ariaLabel: 'Mois' }),
      UI.el('button', { type: 'button', id: 'tip-btn', class: 'btn btn-secondary', tooltip: 'Exporte les lignes affichées.' }, 'Exporter CSV'),
      UI.checkbox({ id: 'cb', label: 'Inclure les génériques', onChange: log('cb') }),
      UI.el('button', { type: 'button', id: 'after', class: 'btn' }, 'Après'));
    main.appendChild(host);
  }, { STATUSES, POSTES });
}

const ev = () => page.evaluate(() => window.__ev);
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  return a ? (a.id || a.getAttribute('role') || a.tagName) : null;
});
const activeOption = (listId) => page.evaluate((id) => {
  const lb = document.getElementById(id);
  const owner = document.activeElement;
  const ad = owner && owner.getAttribute('aria-activedescendant');
  const row = ad ? document.getElementById(ad) : lb && lb.querySelector('.is-active');
  return row ? row.querySelector('.dd-option-label').textContent : null;
}, listId);

describe('controls', () => {
  before(async () => { app = await openApp({}); page = app.page; });
  after(async () => { if (app) await app.close(); });

  test('dropdown: mouse, ARIA, value, disabled state', async () => {
    await mountHost();
    assert.equal(await page.$('#host select:not(.dd-compat)'), null, 'no native select');
    const t = '#dd-status';
    assert.equal(await page.getAttribute(t, 'aria-haspopup'), 'listbox');
    assert.equal(await page.getAttribute(t, 'aria-expanded'), 'false');
    assert.equal((await page.textContent(`${t} .dd-value`)).trim(), 'En cours');
    await page.click(t);
    const listId = await page.getAttribute(t, 'aria-controls');
    assert.equal(await page.getAttribute(t, 'aria-expanded'), 'true');
    // Portalled to <body>, above the page, at least as wide as the trigger.
    const geo = await page.evaluate((id) => {
      const lb = document.getElementById(id);
      const pop = lb.closest('.popover');
      const tr = document.getElementById('dd-status').getBoundingClientRect();
      return { parent: pop.parentNode === document.body, w: pop.getBoundingClientRect().width, tw: tr.width,
        top: pop.getBoundingClientRect().top, tb: tr.bottom, z: getComputedStyle(pop).zIndex };
    }, listId);
    assert.ok(geo.parent && geo.w >= geo.tw - 1 && geo.top >= geo.tb, JSON.stringify(geo));
    assert.equal(await page.getAttribute(`#${listId}`, 'role'), 'listbox');
    assert.deepEqual(await page.$$eval(`#${listId} [role=option]`, (rs) => rs.map((r) => r.getAttribute('aria-selected'))),
      ['false', 'true', 'false', 'false']);
    await page.click(`#${listId} [role=option]:nth-child(3)`);
    await page.waitForSelector(`#${listId}`, { state: 'detached' });
    assert.equal(await dropdownValue(page, t), 'Terminé');
    assert.deepEqual(await ev(), [['status', 'Terminé']]);
    assert.equal(await active(), 'dd-status', 'focus back on the trigger');
    // Outside click closes without a change.
    await page.click(t);
    await page.mouse.click(900, 700);
    await page.waitForSelector(`#${listId}`, { state: 'detached' });
    assert.equal((await ev()).length, 1);
    // setValue / setOptions do not emit.
    await page.evaluate(() => { const r = document.getElementById('dd-status').closest('.dd'); r.setValue('À faire'); });
    assert.equal((await page.textContent(`${t} .dd-value`)).trim(), 'À faire');
    assert.equal((await ev()).length, 1);
    // Disabled: keeps its caret, does not open.
    assert.equal(await page.isDisabled('#dd-off'), true);
    assert.ok(await page.isVisible('#dd-off .dd-caret'));
    await page.click('#dd-off', { force: true });
    assert.equal(await page.getAttribute('#dd-off', 'aria-expanded'), 'false');
    // Placeholder + allowEmpty.
    assert.equal((await page.textContent('#dd-prio .dd-value')).trim(), 'Choisir…');
    assert.deepEqual(await optionLabels(page, '#dd-prio'), ['—', 'Haute', 'Moyenne', 'Basse']);
    assert.deepEqual(app.errors, []);
  });

  test('dropdown: keyboard (ArrowDown opens, arrows, Home/End, type-ahead, Enter, Esc, Tab)', async () => {
    await mountHost();
    const t = '#dd-status';
    await page.focus(t);
    await page.keyboard.press('ArrowDown');
    const listId = await page.getAttribute(t, 'aria-controls');
    await page.waitForSelector(`#${listId}`);
    assert.equal(await activeOption(listId), 'En cours', 'starts on the selected option');
    assert.equal(await page.evaluate((id) => document.activeElement.id, listId), listId);
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeOption(listId), 'Terminé');
    await page.keyboard.press('End');
    assert.equal(await activeOption(listId), 'Abandonné');
    await page.keyboard.press('Home');
    assert.equal(await activeOption(listId), 'À faire');
    // Type-ahead (accent-insensitive).
    await page.keyboard.type('t');
    assert.equal(await activeOption(listId), 'Terminé');
    await page.keyboard.press('Enter');
    await page.waitForSelector(`#${listId}`, { state: 'detached' });
    assert.equal(await dropdownValue(page, t), 'Terminé');
    assert.equal(await active(), 'dd-status');
    // Esc closes without change and restores the focus.
    await page.keyboard.press('Enter');
    await page.waitForSelector(`#${listId}`);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    await page.waitForSelector(`#${listId}`, { state: 'detached' });
    assert.equal(await dropdownValue(page, t), 'Terminé');
    assert.equal(await active(), 'dd-status');
    // Type-ahead on the closed trigger opens on the match; Space selects.
    await page.keyboard.press('a');
    await page.waitForSelector(`#${listId}`);
    assert.equal(await activeOption(listId), 'Abandonné');
    await page.keyboard.press(' ');
    assert.equal(await dropdownValue(page, t), 'Abandonné');
    // Tab closes and moves on.
    await page.keyboard.press('ArrowDown');
    await page.waitForSelector(`#${listId}`);
    await page.keyboard.press('Tab');
    await page.waitForSelector(`#${listId}`, { state: 'detached' });
    assert.notEqual(await active(), 'dd-status');
    assert.deepEqual((await ev()).map((e) => e[1]), ['Terminé', 'Abandonné']);
    // Long lists get a filter box; PageDown moves 10 rows.
    await page.click('#dd-long');
    const longId = await page.getAttribute('#dd-long', 'aria-controls');
    assert.ok(await page.isVisible('.dd-popover .dd-search'));
    await page.keyboard.press('PageDown');
    assert.equal(await activeOption(longId), 'Option 11');
    await page.keyboard.type('25');
    assert.deepEqual(await page.$$eval(`#${longId} .dd-option-label`, (rs) => rs.map((r) => r.textContent)), ['Option 25']);
    await page.keyboard.press('Enter');
    assert.equal(await dropdownValue(page, '#dd-long'), 'Option 25');
    assert.deepEqual(app.errors, []);
  });

  test('dropdown multiple: checkboxes, summary, clear, keyboard toggle', async () => {
    await mountHost();
    const t = '#dd-multi';
    assert.equal((await page.textContent(`${t} .dd-value`)).trim(), 'Toutes');
    await chooseOptions(page, t, ['Labo Textile', 'R&D Vélo']);
    assert.deepEqual(await dropdownValue(page, t), ['Labo Textile', 'R&D Vélo']);
    assert.equal((await page.textContent(`${t} .dd-value`)).trim(), 'Labo Textile + 1');
    await page.click(t);
    const listId = await page.getAttribute(t, 'aria-controls');
    assert.equal(await page.getAttribute(`#${listId}`, 'aria-multiselectable'), 'true');
    assert.equal(await page.$$eval(`#${listId} [role=option] .cb-box`, (n) => n.length), 4);
    // Space toggles the active row and keeps the list open.
    await page.keyboard.press('Home');
    await page.keyboard.press(' ');
    assert.ok(await page.isVisible(`#${listId}`));
    assert.deepEqual(await dropdownValue(page, t), ['Labo Chaussure', 'Labo Textile', 'R&D Vélo']);
    // Tab reaches « Effacer la sélection ».
    await page.keyboard.press('Tab');
    assert.equal((await page.evaluate(() => document.activeElement.textContent)).trim(), 'Effacer la sélection');
    await page.keyboard.press('Enter');
    assert.deepEqual(await dropdownValue(page, t), []);
    await page.keyboard.press('Escape');
    assert.equal((await page.textContent(`${t} .dd-value`)).trim(), 'Toutes');
    const changes = (await ev()).filter((e) => e[0] === 'multi').map((e) => e[1]);
    assert.deepEqual(changes[changes.length - 1], []);
    assert.deepEqual(app.errors, []);
  });

  test('combobox: free text, suggestions, « Utiliser « … » », tokens', async () => {
    await mountHost();
    const c = '#dd-combo';
    assert.equal(await page.getAttribute(c, 'role'), 'combobox');
    await page.click(c);
    await page.keyboard.type('mec');
    const listId = await page.getAttribute(c, 'aria-controls');
    await page.waitForSelector(`#${listId}`);
    assert.deepEqual(await page.$$eval(`#${listId} .dd-option-label`, (rs) => rs.map((r) => r.textContent)),
      ['LAB-MEC-02', 'Utiliser « mec »']);
    // Enter with no active row commits the typed text.
    await page.keyboard.press('Enter');
    assert.equal(await page.inputValue(c), 'mec');
    assert.deepEqual(await ev(), [['combo', 'mec']]);
    // ArrowDown + Enter picks a suggestion.
    await page.fill(c, '');
    await page.keyboard.press('ArrowDown');
    await page.waitForSelector(`#${listId}`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.inputValue(c), 'LAB-MEC-02');
    // Free text via the helper (custom row).
    await chooseOption(page, c, 'NOUVEAU-01');
    assert.equal(await page.inputValue(c), 'NOUVEAU-01');
    assert.equal((await ev()).slice(-1)[0][1], 'NOUVEAU-01');

    // Tokens: suggestions complete the token being typed; values are normalised on Tab.
    const k = '#dd-tokens';
    await page.click(k);
    await page.keyboard.type('tex');
    const tokId = await page.getAttribute(k, 'aria-controls');
    await page.waitForSelector(`#${tokId}`);
    await page.click(`#${tokId} [role=option]:first-child`);
    assert.equal(await page.inputValue(k), 'LAB-TEX-01, ');
    // The used token is no longer suggested.
    assert.deepEqual(await page.$$eval(`#${tokId} .dd-option-label`, (rs) => rs.map((r) => r.textContent)), ['LAB-MEC-02', 'RD-VELO-03']);
    await page.keyboard.type('rd');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.type('poste-x');
    await page.keyboard.press('Tab');
    assert.equal(await page.inputValue(k), 'LAB-TEX-01, RD-VELO-03, poste-x');
    assert.deepEqual((await ev()).filter((e) => e[0] === 'tokens'), [['tokens', 'LAB-TEX-01, RD-VELO-03, poste-x']]);
    assert.deepEqual(app.errors, []);
  });

  test('dateField: mask, validation, calendar (keyboard + mouse); monthField', async () => {
    await mountHost();
    const d = '#df';
    assert.equal(await page.inputValue(d), '15/03/2026');
    assert.equal(await page.getAttribute(d, 'placeholder'), 'JJ/MM/AAAA');
    await page.fill(d, '');
    await page.type(d, '12042026');
    assert.equal(await page.inputValue(d), '12/04/2026');
    await page.fill(d, '');
    await page.type(d, '1/5/2026');
    assert.equal(await page.inputValue(d), '01/05/2026');
    await page.evaluate(() => document.getElementById('df').blur());
    assert.deepEqual((await ev()).filter((e) => e[0] === 'date'), [['date', '01/05/2026']]);
    // Invalid date (31 February) -> aria-invalid, value refused.
    await typeDate(page, d, '31/02/2026');
    assert.equal(await page.getAttribute(d, 'aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => document.getElementById('df').closest('.dd-field').getValue()), '');
    assert.match(await page.evaluate(() => document.getElementById('df').closest('.dd-field').validate()), /Date invalide/);
    // min
    await typeDate(page, '#df-min', '31/12/2025');
    assert.match(await page.evaluate(() => document.getElementById('df-min').closest('.dd-field').validate()), /antérieure au 01\/01\/2026/);
    // Calendar: ArrowDown opens on the field date (or today); ArrowRight + Enter picks the next day.
    await typeDate(page, d, '30/04/2026');
    await page.focus(d);
    await page.keyboard.press('ArrowDown');
    await page.waitForSelector('.cal-popover .cal');
    assert.equal(await page.textContent('.cal-popover .cal-title'), 'Avril 2026');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.iso), '2026-04-30');
    assert.deepEqual(await page.$$eval('.cal-popover thead th', (ths) => ths.map((t) => t.getAttribute('aria-label'))),
      ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.textContent('.cal-popover .cal-title'), 'Mai 2026');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cal-popover', { state: 'detached' });
    assert.equal(await page.inputValue(d), '01/05/2026');
    assert.equal(await active(), 'df');
    // Mouse: caret button, PageUp to the previous month, click on the 15th.
    await page.click('#df + .dd-caret-btn');
    await page.waitForSelector('.cal-popover .cal');
    await page.click('.cal-popover .cal-nav[aria-label="Mois précédent"]');
    await page.click('.cal-popover button[data-iso="2026-04-15"]');
    assert.equal(await page.inputValue(d), '15/04/2026');
    assert.equal(await page.getAttribute(d, 'aria-invalid'), 'false');
    // Esc closes the calendar only.
    await page.click('#df + .dd-caret-btn');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.cal-popover', { state: 'detached' });
    assert.equal(await page.inputValue(d), '15/04/2026');

    // monthField
    const m = '#mf';
    await page.fill(m, '');
    await page.type(m, '202606');
    assert.equal(await page.inputValue(m), '2026-06');
    await page.evaluate(() => document.getElementById('mf').blur());
    assert.deepEqual((await ev()).filter((e) => e[0] === 'month'), [['month', '2026-06']]);
    await page.click('#mf + .dd-caret-btn');
    await page.waitForSelector('.cal-popover .mcal');
    assert.equal(await page.getAttribute('.cal-popover button[data-month="2026-05"]', 'aria-label'), 'mai 2026, importé');
    await page.click('.cal-popover button[data-month="2026-04"]');
    assert.equal(await page.inputValue(m), '2026-04');
    await typeDate(page, m, '2026-13');
    assert.equal(await page.getAttribute(m, 'aria-invalid'), 'true');
    assert.deepEqual(app.errors, []);
  });

  test('tooltip: keyboard focus, aria-describedby, Esc; checkbox', async () => {
    await mountHost();
    assert.equal(await page.getAttribute('#tip-btn', 'title'), null);
    const described = await page.evaluate(() => {
      const ids = document.getElementById('tip-btn').getAttribute('aria-describedby').split(' ');
      return ids.map((id) => document.getElementById(id).textContent).join(' ');
    });
    assert.equal(described, 'Exporte les lignes affichées.');
    await page.focus('#mf');
    await page.keyboard.press('Tab');   // caret button is not a tab stop: next is the tooltip button
    assert.equal(await active(), 'tip-btn');
    await page.waitForSelector('.tooltip');
    assert.equal(await page.textContent('.tooltip'), 'Exporte les lignes affichées.');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.tooltip', { state: 'detached' });
    // Hover shows it after a delay.
    await page.hover('#tip-btn');
    await page.waitForSelector('.tooltip', { timeout: 2000 });
    await page.mouse.move(5, 5);
    // Checkbox: real input, drawn box, change event.
    await page.click('#host .cb .cb-label');
    assert.equal(await page.isChecked('#cb'), true);
    assert.deepEqual((await ev()).filter((e) => e[0] === 'cb'), [['cb', true]]);
    assert.deepEqual(app.errors, []);
  });

  test('editableTable: search clear button and Esc; date cell editor; dropdown cell editor cancel', async () => {
    await page.evaluate(() => {
      UI.popover.closeAll();
      const main = document.getElementById('main');
      UI.clear(main);
      window.__saved = [];
      const rows = [{ _id: 'a', name: 'LAB-TEX-01', date: '12/03/2026', edr: 'Oui' }, { _id: 'b', name: 'LAB-MEC-02', date: '', edr: 'Non' }];
      window.__t = UI.editableTable({ columns: [{ key: 'name', label: 'Nom', mono: true },
        { key: 'date', label: 'Date visite', editable: true }, { key: 'edr', label: 'EDR', editable: true, options: ['Oui', 'Non'] }],
      rows, onSave: (c) => { window.__saved.push(c); return new Promise((r) => setTimeout(r, 300)); } });
      main.appendChild(UI.el('div', { id: 'tbl' }, window.__t.node));
    });
    // Search: no native cancel button, custom clear button, Esc clears.
    const s = '#tbl .etable-search';
    assert.equal(await page.getAttribute(s, 'type'), 'search');
    assert.equal(await page.isVisible('#tbl .search-clear'), false);
    await page.fill(s, 'mec');
    assert.equal(await page.$$eval('#tbl tbody tr', (r) => r.length), 1);
    assert.equal(await page.getAttribute('#tbl .search-clear', 'aria-label'), 'Effacer la recherche');
    await page.click('#tbl .search-clear');
    assert.equal(await page.inputValue(s), '');
    assert.equal(await page.$$eval('#tbl tbody tr', (r) => r.length), 2);
    assert.equal(await active(), 'INPUT');
    await page.fill(s, 'tex');
    await page.keyboard.press('Escape');
    assert.equal(await page.inputValue(s), '');

    // Date column -> dateField editor; invalid dates are refused; the column keeps its width.
    const cell = '#tbl tr[data-id="a"] td[data-col="date"]';
    const w0 = await page.$eval(cell, (td) => td.getBoundingClientRect().width);
    await page.click(cell);
    assert.ok(await page.isVisible(`${cell} .datefield input`));
    assert.equal(await page.$eval(cell, (td) => td.getBoundingClientRect().width), w0);
    await page.fill(`${cell} input`, '32/03/2026');
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute(`${cell} input`, 'aria-invalid'), 'true');
    await page.fill(`${cell} input`, '');
    await page.type(`${cell} input`, '20032026');
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent(cell), '20/03/2026');
    assert.deepEqual(await page.evaluate(() => window.__t.getDirty()), [{ id: 'a', updates: { date: '20/03/2026' } }]);
    // Dropdown editor: Esc cancels.
    const edr = '#tbl tr[data-id="b"] td[data-col="edr"]';
    await page.click(edr);
    assert.equal(await page.getAttribute(`${edr} .dd-trigger`, 'aria-expanded'), 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    assert.equal(await page.textContent(edr), 'Non');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.col), 'edr');
    // Save: busy button (spinner, aria-busy) then the dirty bar disappears.
    await page.click('#tbl .etable-save');
    assert.equal(await page.getAttribute('#tbl .etable-save', 'aria-busy'), 'true');
    assert.ok(await page.isVisible('#tbl .etable-save .btn-spinner'));
    await page.waitForSelector('#tbl .etable-dirtybar', { state: 'hidden' });
    assert.equal(await page.getAttribute('#tbl .etable-save', 'aria-busy'), null);
    assert.deepEqual(app.errors, []);
  });

  test('formModal: Enter submits, async onSubmit busy, error kept inline, err.field, dropdown Esc inside modal', async () => {
    const result = page.evaluate(() => {
      window.__attempts = 0;
      return UI.formModal({ title: 'Nouvelle action', submitLabel: 'Créer l’action',
        fields: [
          { name: 'action', label: 'Action', required: true },
          { name: 'status', label: 'Statut', type: 'select', options: ['À faire', 'Terminé'], required: true },
          { name: 'target', label: 'Cible', type: 'select', allowCustom: true, options: ['LAB-TEX-01'] },
          { name: 'deadline', label: 'Échéance', type: 'date' },
          { name: 'month', label: 'Mois source', type: 'month', value: '2026-05' },
        ],
        onSubmit: (values) => new Promise((resolve, reject) => {
          window.__attempts++;
          setTimeout(() => {
            if (window.__attempts === 1) reject(new Error('Le service ne répond pas.'));
            else if (window.__attempts === 2) reject(Object.assign(new Error('Cible inconnue.'), { field: 'target' }));
            else resolve(values);
          }, 250);
        }) });
    });
    await page.waitForSelector('.modal form');
    // Initial focus on the first field; Enter in it validates (required fields).
    await page.waitForFunction(() => document.activeElement && document.activeElement.name === 'action');
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('.modal input[name=action]', 'aria-invalid'), 'true');
    assert.equal(await page.getAttribute('.modal [name=status]', 'aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'action');
    const errId = (await page.getAttribute('.modal [name=status]', 'aria-describedby')).split(' ').pop();
    assert.equal((await page.textContent(`#${errId}`)).trim(), 'Ce champ est obligatoire.');
    await page.fill('.modal input[name=action]', 'Installer EDR');
    // A dropdown opened inside the modal: Esc closes the list only.
    await page.click('.modal [name=status]');
    const listId = await page.getAttribute('.modal [name=status]', 'aria-controls');
    const z = await page.evaluate((id) => [getComputedStyle(document.getElementById(id).closest('.popover')).zIndex,
      getComputedStyle(document.querySelector('.modal-overlay')).zIndex], listId);
    assert.ok(Number(z[0]) > Number(z[1]), 'popover above the modal ' + z);
    await page.keyboard.press('Escape');
    await page.waitForSelector(`#${listId}`, { state: 'detached' });
    assert.ok(await page.isVisible('.modal'));
    await chooseOption(page, '.modal [name=status]', 'Terminé');
    await typeDate(page, '.modal input[name=deadline]', '30/04/2026');
    await page.focus('.modal input[name=action]');
    await page.keyboard.press('Enter');
    // Busy: the submit button keeps its colours, shows a spinner, aria-busy; Annuler / × disabled.
    await page.waitForSelector('.modal .btn-primary[aria-busy="true"] .btn-spinner');
    assert.equal(await page.$eval('.modal .btn-primary', (b) => getComputedStyle(b).opacity), '1');
    assert.equal(await page.isDisabled('.modal .btn-secondary'), true);
    await page.keyboard.press('Escape');
    assert.ok(await page.isVisible('.modal'), 'Escape ignored while saving');
    // First error: shown at the top of the form, values kept.
    await page.waitForSelector('.modal .form-alert .alert-error');
    assert.equal((await page.textContent('.modal .form-alert')).trim(), 'Erreur : Le service ne répond pas.');
    assert.equal(await page.inputValue('.modal input[name=action]'), 'Installer EDR');
    assert.equal(await dropdownValue(page, '.modal [name=status]'), 'Terminé');
    // Second error: mapped to the field.
    await page.click('.modal .btn-primary');
    await page.waitForFunction(() => document.querySelector('.modal input[name=target]').getAttribute('aria-invalid') === 'true');
    assert.equal(await page.evaluate(() => document.activeElement.name), 'target');
    // Third attempt succeeds: the modal closes and resolves with the values.
    await chooseOption(page, '.modal input[name=target]', 'LAB-TEX-01');
    await page.click('.modal .btn-primary');
    assert.deepEqual(await result, { action: 'Installer EDR', status: 'Terminé', target: 'LAB-TEX-01', deadline: '30/04/2026', month: '2026-05' });
    await page.waitForSelector('.modal', { state: 'detached' });
    assert.deepEqual(app.errors, []);
  });

  test('confirm: danger opens on « Annuler »; onConfirm busy + inline error; tabs keyboard', async () => {
    const r1 = page.evaluate(() => UI.confirm('Supprimer l’application ?', { danger: true, okLabel: 'Supprimer' }));
    await page.waitForSelector('.modal .btn-danger');
    await page.waitForFunction(() => document.activeElement && document.activeElement.textContent === 'Annuler');
    await page.keyboard.press('Enter');
    assert.equal(await r1, false, 'a stray Enter cancels');

    const r2 = page.evaluate(() => {
      window.__n = 0;
      return UI.confirm('Ré-importer ?', { okLabel: 'Ré-importer', onConfirm: () => new Promise((res, rej) => setTimeout(() => (++window.__n === 1 ? rej(new Error('Verrou occupé.')) : res()), 200)) });
    });
    await page.waitForSelector('.modal .btn-primary');
    await page.click('.modal .btn-primary');
    assert.equal(await page.getAttribute('.modal .btn-primary', 'aria-busy'), 'true');
    await page.waitForSelector('.modal .confirm-error .alert-error');
    assert.equal((await page.textContent('.modal .confirm-error')).trim(), 'Erreur : Verrou occupé.');
    await page.click('.modal .btn-primary');
    assert.equal(await r2, true);

    await page.evaluate(() => {
      const main = document.getElementById('main');
      UI.clear(main);
      main.appendChild(UI.tabs([{ id: 'a', label: 'Un', render: (r) => r.appendChild(UI.el('p', null, 'A')) },
        { id: 'b', label: 'Deux', render: (r) => r.appendChild(UI.el('p', null, 'B')) },
        { id: 'c', label: 'Trois', render: (r) => r.appendChild(UI.el('p', null, 'C')) }]));
    });
    assert.equal(await page.getAttribute('.tabpanel', 'tabindex'), null, 'panel is not a tab stop');
    await page.focus('.tab[data-tab="a"]');
    await page.keyboard.press('End');
    assert.equal(await page.textContent('.tabpanel'), 'C');
    await page.keyboard.press('Home');
    assert.equal(await page.textContent('.tabpanel'), 'A');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getAttribute('.tab[data-tab="c"]', 'aria-selected'), 'true');
    // Formatting + busy helper.
    assert.deepEqual(await page.evaluate(() => [UI.fmtPct(71.42857), UI.fmtPct(0, 0), UI.NNBSP]), ['71,4 %', '0 %', ' ']);
    assert.deepEqual(app.errors, []);
  });

  test('states: empty / loading / error', async () => {
    const out = await page.evaluate(() => {
      let retried = 0;
      const e = UI.empty('Aucune action.', { small: true });
      const l = UI.loading();
      const x = UI.errorState(new Error(''), { retry: () => { retried++; } });
      document.body.appendChild(x);
      x.querySelector('button').click();
      x.remove();
      return [e.className, e.textContent, l.getAttribute('role'), l.textContent, x.getAttribute('role'), x.textContent, retried,
        UI.errorText(null), UI.empty('a', UI.el('a', { href: '#' }, 'lien')).textContent];
    });
    assert.deepEqual(out, ['empty-state is-small', 'Aucune action.', 'status', 'Chargement…', 'alert',
      'Erreur : Erreur inconnue.Réessayer', 1, 'Erreur inconnue.', 'a lien']);
  });
});
