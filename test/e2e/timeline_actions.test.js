'use strict';
/**
 * E2E tests of the "Suivi temporel" and "Suivi des actions" pages (docs/API.md §6). Controls are the custom
 * UI.dropdown / UI.dateField (no native <select>, datalist or date input): see the harness helpers.
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/timeline_actions.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = require('../fixtures/data');
const { openApp, chooseOption, optionLabels, dropdownValue, typeDate } = require('./harness');

// ---------------------------------------------------------------- expected values (Node side)
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'Core.js'), 'utf8'), ctx);
const Core = ctx.Core;

function fixtureMonth(month) {
  const custom = data.CUSTOM_FIELDS[month] || {};
  return {
    postes: Core.enrichPostes(data.MONTHS[month].postes),
    applications: Core.enrichApplications(data.MONTHS[month].applications.map((a) => {
      const c = custom[a['Nom du logiciel / service']] || {};
      return { ...a, Galink: c.Galink === undefined ? null : c.Galink, IDP: c.IDP === undefined ? null : c.IDP };
    })),
  };
}

function kpisFor(month, filters) {
  const f = Core.filterData(fixtureMonth(month), filters || { equipes: [], batiments: [] });
  return JSON.parse(JSON.stringify(Core.computeKpis(f.postes, f.applications)));
}

const fmtNum = (n) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(n);
const fmtPct = (n) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1,
  useGrouping: false }).format(n) + '\u202f%';
const NNBSP = '\u202f';
const close = (a, b) => Math.abs(a - b) < 1e-9;

async function withApp(options, fn) {
  const app = await openApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** Last Plotly call for a chart element id. */
async function lastPlot(app, id) {
  const plots = (await app.plots()).filter((p) => p.id === id);
  return plots[plots.length - 1];
}

async function kpiCell(page, key, month) {
  return page.$eval(`#timeline-kpi-table tr[data-kpi="${key}"] td[data-month="${month}"]`, (td) => ({
    value: td.querySelector('.tl-value').textContent,
    delta: td.querySelector('.tl-delta') ? td.querySelector('.tl-delta').textContent : null,
    tone: td.querySelector('.tl-delta') ? td.querySelector('.tl-delta').className : null,
  }));
}

async function callsNamed(app, name) {
  return (await app.calls()).filter((c) => c.name === name);
}

async function browserToday(page) {
  return page.evaluate(() => window.Core.fmtDDMMYYYY(new Date()));
}

async function tableIds(page, tableId) {
  return page.$$eval(`#${tableId} tbody tr[data-id]`, (trs) => trs.map((t) => t.dataset.id));
}

/** No native form widgets and no title= tooltips inside the page (custom controls only). */
async function assertNoNativeControls(page, scope = '#main') {
  const native = await page.$$eval(`${scope} select, ${scope} input[type=date], ${scope} input[type=month], ` +
    `${scope} input[list], ${scope} datalist, ${scope} [title]`, (ns) => ns.map((n) => n.outerHTML.slice(0, 80)));
  assert.deepEqual(native, [], 'no native select / date / datalist / title= in ' + scope);
}

/** Holds the next calls to `name` until window.__release() is called (to observe busy states). */
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

async function submitModal(app, selector = '.modal .modal-footer .btn-primary') {
  await app.page.click(selector);
  await app.page.waitForSelector('.modal-overlay', { state: 'detached' });
  await app.waitIdle();
}

// ================================================================= Suivi temporel
describe('timeline', () => {
  test('renders 2 months: charts, heatmap and KPI table with deltas', async () => {
    await withApp({ page: 'timeline' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main h1')).trim(), 'Suivi temporel');
      assert.equal((await page.textContent('#timeline-kicker')).trim(), 'Avril 2026 – mai 2026 · 2 exports');
      assert.equal(await page.$('#timeline-info'), null, 'no "< 2 months" info with 2 months');
      assert.equal((await callsNamed(app, 'api_getTimeline')).length, 1);

      const k4 = kpisFor('2026-04');
      const k5 = kpisFor('2026-05');

      // Line chart: taux postes / apps per month (+ threshold drawn as a layout shape).
      const taux = await lastPlot(app, 'chart-timeline-taux');
      assert.ok(taux, 'Plotly call for the rate chart');
      assert.deepEqual(taux.data.map((t) => t.name), ['Postes', 'Applications']);
      assert.deepEqual(taux.data[0].x, ['avril 2026', 'mai 2026']);
      assert.ok(close(taux.data[0].y[0], k4.taux_postes) && close(taux.data[0].y[1], k5.taux_postes));
      assert.ok(close(taux.data[1].y[0], k4.taux_apps) && close(taux.data[1].y[1], k5.taux_apps));
      const tauxLayout = await page.evaluate(() => {
        const el = document.getElementById('chart-timeline-taux');
        return el.layout ? el.layout.shapes.map((s) => s.y0) : null; // real Plotly only
      });
      if (tauxLayout) assert.deepEqual(tauxLayout, [80]);

      // Counts chart: inventoried vs conformant.
      const counts = await lastPlot(app, 'chart-timeline-counts');
      assert.deepEqual(counts.data.map((t) => t.name),
        ['Postes inventoriés', 'Postes conformes', 'Applications inventoriées', 'Applications conformes']);
      assert.deepEqual(counts.data[0].y, [k4.total_postes, k5.total_postes]);
      assert.deepEqual(counts.data[1].y, [k4.postes_conformes, k5.postes_conformes]);
      assert.deepEqual(counts.data[3].y, [k4.apps_conformes, k5.apps_conformes]);
      // Labelled directly ("5 sur 7" above each inventory bar), no legend to decode.
      assert.deepEqual(counts.data[0].text, [k4.postes_conformes + ' sur ' + k4.total_postes,
        k5.postes_conformes + ' sur ' + k5.total_postes]);
      const countsLegend = await page.evaluate(() => {
        const el = document.getElementById('chart-timeline-counts');
        return el._fullLayout ? el._fullLayout.showlegend : null; // real Plotly only
      });
      if (countsLegend !== null) assert.equal(countsLegend, false);

      // Heatmap équipe × month.
      const heat = await lastPlot(app, 'chart-timeline-heatmap');
      assert.equal(heat.data[0].type, 'heatmap');
      assert.deepEqual(heat.data[0].y, ['Labo Chaussure', 'Labo Mécanique', 'Labo Textile', 'R&D Vélo']);
      // Labo Textile: 1/2 conformes in 2026-04, 2/2 in 2026-05.
      assert.deepEqual(heat.data[0].z[2], [50, 100]);
      // R&D Vélo: 1/1 then 1/2 (XSS probe poste is non conformant).
      assert.deepEqual(heat.data[0].z[3], [100, 50]);

      // KPI table: all KPIs, deltas vs the previous month.
      const keys = await page.$$eval('#timeline-kpi-table tbody tr', (trs) => trs.map((t) => t.dataset.kpi));
      assert.deepEqual(keys.slice().sort(), Object.keys(k5).sort());
      assert.deepEqual(await kpiCell(page, 'total_postes', '2026-04'), { value: fmtNum(k4.total_postes), delta: null, tone: null });
      const tp = await kpiCell(page, 'total_postes', '2026-05');
      assert.equal(tp.value, fmtNum(k5.total_postes));
      assert.equal(tp.delta, '+' + (k5.total_postes - k4.total_postes));
      const conf = await kpiCell(page, 'postes_conformes', '2026-05');
      assert.equal(conf.delta, '+' + (k5.postes_conformes - k4.postes_conformes));
      assert.match(conf.tone, /is-ok/);
      const rateCell = await kpiCell(page, 'taux_postes', '2026-05');
      assert.equal(rateCell.value, fmtPct(k5.taux_postes));
      const d = k5.taux_postes - k4.taux_postes;
      assert.equal(rateCell.delta, (d > 0 ? '+' : '−') + new Intl.NumberFormat('fr-FR', {
        minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(d)) + NNBSP + 'pt');
      // Fewer postes without EDR is an improvement (green), more apps without SIP would be red.
      const edr = await kpiCell(page, 'postes_sans_edr', '2026-05');
      assert.equal(edr.value, fmtNum(k5.postes_sans_edr));
      // Ledger chrome: no emoji anywhere on the page, line series use the neutral ledger styles.
      assert.doesNotMatch(await page.textContent('#main'), /\p{Extended_Pictographic}/u);
      assert.deepEqual(taux.data.map((t) => t.line.dash), ['solid', 'dash'], 'postes solid ink, applications dashed');
      // Threshold status in words next to its colour (never colour only), months via Fmt.
      const caption = await page.textContent('#chart-timeline-taux + .chart-caption');
      assert.match(caption, /seuil 80/);
      assert.ok(caption.startsWith('Mai 2026 — '), caption);
      const words = (r) => (r >= 80 ? 'Seuil atteint' : 'Sous le seuil');
      assert.ok(caption.includes('Postes ' + fmtPct(k5.taux_postes) + ' ' + words(k5.taux_postes)), caption);
      assert.ok(caption.includes('Applications ' + fmtPct(k5.taux_apps) + ' ' + words(k5.taux_apps)), caption);
      assert.equal(await page.$$eval('#chart-timeline-taux + .chart-caption .mark', (ms) => ms.length), 2);
      // Delta words are given by a custom tooltip (hover / focus, aria-describedby), not by title=.
      const delta = '#timeline-kpi-table tr[data-kpi="postes_conformes"] td[data-month="2026-05"] .tl-delta';
      assert.ok(await page.getAttribute(delta, 'aria-describedby'), 'delta has a tooltip description');
      await page.hover(delta);
      await page.waitForSelector('.tooltip:visible');
      assert.match(await page.textContent('.tooltip'), /Par rapport à avril 2026 : amélioration/);
      await assertNoNativeControls(page);
      assert.deepEqual(app.errors, []);
    });
  });

  test('global filters change the values', async () => {
    await withApp({ page: 'timeline' }, async (app) => {
      const { page } = app;
      const filters = { equipes: ['Labo Textile'], batiments: [] };
      await page.evaluate((f) => window.State.set({ filters: f }), filters);
      await page.waitForSelector('#timeline-kpi-table');
      await app.waitIdle();
      assert.match(await page.textContent('#main .filter-note'), /Équipe : Labo Textile/);
      const k4 = kpisFor('2026-04', filters);
      const k5 = kpisFor('2026-05', filters);
      assert.equal(k5.total_postes, 2);
      assert.equal((await kpiCell(page, 'total_postes', '2026-05')).value, fmtNum(k5.total_postes));
      assert.equal((await kpiCell(page, 'total_apps', '2026-04')).value, fmtNum(k4.total_apps));
      const taux = await lastPlot(app, 'chart-timeline-taux');
      assert.ok(close(taux.data[0].y[0], k4.taux_postes) && close(taux.data[0].y[1], k5.taux_postes));
      const heat = await lastPlot(app, 'chart-timeline-heatmap');
      assert.deepEqual(heat.data[0].y, ['Labo Textile']);
      // Cached timeline: filtering does not refetch.
      assert.equal((await callsNamed(app, 'api_getTimeline')).length, 1);
      assert.deepEqual(app.errors, []);
    });
  });

  test('a single month shows the info message and still renders it', async () => {
    await withApp({ page: 'timeline' }, async (app) => {
      const { page } = app;
      await page.evaluate(() => {
        delete window.__mock.db.months['2026-04'];
        window.State.invalidate();
        window.App.refresh();
      });
      await page.waitForSelector('#timeline-info');
      await app.waitIdle();
      assert.equal((await page.textContent('#timeline-info')).trim(),
        'Au moins deux exports mensuels sont nécessaires pour visualiser une évolution.');
      assert.equal((await page.textContent('#timeline-kicker')).trim(), 'Mai 2026 · 1 export');
      const months = await page.$$eval('#timeline-kpi-table thead th[data-month]', (ths) => ths.map((t) => t.dataset.month));
      assert.deepEqual(months, ['2026-05']);
      assert.deepEqual(app.errors, []);
    });
  });

  test('Actualiser reloads (busy button), a load error shows an error line with Réessayer', async () => {
    await withApp({ page: 'timeline' }, async (app) => {
      const { page } = app;
      await holdCalls(page, 'api_getTimeline');
      await page.click('#timeline-refresh');
      await page.waitForSelector('#timeline-refresh[aria-busy="true"]');
      assert.ok(await page.$('#timeline-body .skeleton[aria-busy="true"]'), 'skeleton while the reload runs');
      await page.evaluate(() => window.__release());
      await page.waitForSelector('#timeline-refresh:not([aria-busy])');
      await app.waitIdle();
      assert.equal((await callsNamed(app, 'api_getTimeline')).length, 2);
      assert.ok(await page.$('#timeline-kpi-table'));

      await page.evaluate(() => { window.__mock.failNext.api_getTimeline = { code: 'INTERNAL', message: 'Classeur indisponible.' }; });
      await page.click('#timeline-refresh');
      await page.waitForSelector('#timeline-error');
      await app.waitIdle();
      assert.equal((await page.textContent('#timeline-error p')).replace('Réessayer', '').trim(),
        'Impossible de charger l’historique : Classeur indisponible.');
      await page.click('#timeline-error .error-retry');
      await page.waitForSelector('#timeline-kpi-table');
      await app.waitIdle();
      assert.equal((await callsNamed(app, 'api_getTimeline')).length, 4);
    });
  });
});

// ================================================================= Suivi actions
describe('actions — remediation', () => {
  test('lists the 3 fixture actions with status / deadline badges and counts', async () => {
    await withApp({ page: 'actions' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main h1')).trim(), 'Suivi des actions');
      const tabs = await page.$$eval('#actions-tabs .tab', (ts) => ts.map((t) => t.textContent));
      assert.deepEqual(tabs, ['Actions de remédiation', 'Remplacements de postes', 'Détection des changements']);
      assert.doesNotMatch(await page.textContent('#main'), /\p{Extended_Pictographic}/u, 'no emoji in the page');
      assert.equal((await page.textContent('#action-add')).trim(), 'Nouvelle action');
      assert.deepEqual((await tableIds(page, 'actions-table')).sort(), ['a-0001', 'a-0002', 'a-0003']);

      const rows = await page.$$eval('#actions-table tbody tr[data-id]', (trs) => Object.fromEntries(trs.map((tr) => {
        const cell = (c) => tr.querySelector(`td[data-col="${c}"]`);
        return [tr.dataset.id, {
          target: cell('target_name').textContent,
          type: cell('target_type').textContent,
          status: cell('status').querySelector('.mark').className + '|' + cell('status').textContent,
          priority: cell('priorite').querySelector('.mark').className + '|' + cell('priorite').textContent,
          deadlineMark: cell('deadline').querySelector('.mark') ? cell('deadline').querySelector('.mark').className : null,
          deadline: cell('deadline').textContent,
        }];
      })));
      assert.equal(rows['a-0001'].target, 'LAB-TEX-02');
      assert.equal(rows['a-0001'].type, 'Poste');
      assert.equal(rows['a-0003'].type, 'Application');
      assert.equal(rows['a-0001'].status, 'mark mark-ok|Terminé');
      assert.equal(rows['a-0002'].status, 'mark mark-warn|En cours');
      assert.equal(rows['a-0003'].status, 'mark mark-neutral|À faire'); // neutral mark: accent blue is for links
      // Priority is not a status: neutral ink marks, never ok / ko / warn colours.
      assert.equal(rows['a-0002'].priority, 'mark mark-priority priority-haute|Haute');
      assert.equal(rows['a-0003'].priority, 'mark mark-priority priority-moyenne|Moyenne');
      // Closed actions are never overdue; open ones with a past deadline are (fixture deadlines are in 2026).
      assert.equal(rows['a-0001'].deadlineMark, null);
      assert.equal(rows['a-0001'].deadline, '30/06/2026');
      const today = Core.frToIso(await browserToday(page));
      const overdue = (fr) => Core.frToIso(fr) < today;
      assert.equal(rows['a-0002'].deadlineMark !== null && /mark-ko/.test(rows['a-0002'].deadlineMark), overdue('31/05/2026'));
      if (overdue('31/05/2026')) assert.match(rows['a-0002'].deadline, /31\/05\/2026 En retard/, 'overdue said in words');
      assert.equal(rows['a-0003'].deadlineMark !== null && /mark-ko/.test(rows['a-0003'].deadlineMark), overdue('15/04/2026'));

      // Stat line: one figure (mono .num) per status, then the overdue count.
      const counts = await page.$$eval('#action-counts [data-status]', (cs) => Object.fromEntries(cs.map((c) => [
        c.dataset.status, c.querySelector('.num').textContent])));
      const nOverdue = ['31/05/2026', '15/04/2026'].filter(overdue).length;
      assert.deepEqual(counts, { 'À faire': '1', 'En cours': '1', 'Terminé': '1', 'Abandonné': '0', overdue: String(nOverdue) });
      if (nOverdue) assert.match(await page.textContent('#action-counts [data-status="overdue"]'), /en retard sur 2 ouvertes/);

      // Row actions: a single quiet « Supprimer » (row click edits), 32px hit area.
      const rowButtons = await page.$$eval('#actions-table tr[data-id="a-0002"] td[data-col="_actions"] button',
        (bs) => bs.map((b) => ({ text: b.textContent, h: b.getBoundingClientRect().height })));
      assert.deepEqual(rowButtons.map((b) => b.text), ['Supprimer']);
      assert.ok(rowButtons[0].h >= 32, 'row action hit area >= 32px');

      // Toolbar filters (custom dropdowns).
      await chooseOption(page, '#action-filter-status', 'En cours');
      assert.deepEqual(await tableIds(page, 'actions-table'), ['a-0002']);
      await chooseOption(page, '#action-filter-status', 'Tous');
      await chooseOption(page, '#action-filter-type', 'Application');
      assert.deepEqual(await tableIds(page, 'actions-table'), ['a-0003']);
      await chooseOption(page, '#action-filter-type', 'Tous');
      assert.equal(await dropdownValue(page, '#action-filter-type'), '');
      await page.fill('#actions-table .etable-search', 'réseau');
      assert.deepEqual(await tableIds(page, 'actions-table'), ['a-0002']);
      await assertNoNativeControls(page);
      assert.deepEqual(app.errors, []);
    });
  });

  test('the global Équipe filter applies to actions and replacements (with the filter note)', async () => {
    await withApp({ page: 'actions' }, async (app) => {
      const { page } = app;
      assert.equal(await page.$('#action-filter-equipe'), null, 'no duplicate Équipe filter in the toolbar');
      await page.evaluate(() => window.State.set({ filters: { equipes: ['Labo Textile'], batiments: [] } }));
      await page.waitForSelector('#actions-table');
      await app.waitIdle();
      assert.deepEqual(await tableIds(page, 'actions-table'), ['a-0001']);
      assert.match(await page.textContent('#main .filter-note'), /Équipe : Labo Textile/);
      const counts = await page.$$eval('#action-counts [data-status] .num', (ns) => ns.slice(0, 4).map((n) => n.textContent));
      assert.deepEqual(counts, ['0', '0', '1', '0'], 'counts within the global filter');
      await page.click('#actions-tabs .tab[data-tab="replacements"]');
      await page.waitForSelector('#replacements-table');
      await app.waitIdle();
      assert.deepEqual(await tableIds(page, 'replacements-table'), ['r-0001']);
      await page.evaluate(() => window.State.set({ filters: { equipes: ['R&D Vélo'], batiments: [] } }));
      await page.waitForSelector('#actions-tabs[data-active="replacements"] .empty-state');
      await app.waitIdle();
      assert.equal((await page.textContent('#actions-tabs .tabpanel .empty-state')).trim(),
        'Aucun remplacement pour l’équipe sélectionnée.');
      assert.deepEqual(app.errors, []);
    });
  });

  test('add, edit and delete send the right payloads and refresh the list', async () => {
    await withApp({ page: 'actions' }, async (app) => {
      const { page } = app;
      const today = await browserToday(page);

      // --- add: one form (« Nouvelle action »), suggestions from the current month
      await page.click('#action-add');
      await page.waitForSelector('.modal [data-name="target_name"]');
      assert.equal((await page.textContent('.modal .modal-title')).trim(), 'Nouvelle action');
      assert.equal((await page.textContent('.modal .modal-footer .btn-primary')).trim(), 'Enregistrer');
      const suggestions = await optionLabels(page, '.modal [data-name="target_name"]');
      assert.ok(suggestions.includes('LAB-TEX-03') && suggestions.includes('Figma'), 'current month postes + apps suggested');
      // Grouped under « Postes » / « Applications »; only poste identifiers in mono.
      await page.focus('.modal [data-name="target_name"]');
      await page.keyboard.press('ArrowDown');
      await page.waitForSelector('.dd-popover [role=option]');
      assert.deepEqual(await page.$$eval('.dd-popover .dd-group', (ns) => ns.map((n) => n.textContent)), ['Postes', 'Applications']);
      assert.deepEqual(await page.$$eval('.dd-popover [role=option]', (rows) => rows
        .filter((r) => ['LAB-TEX-03', 'Figma'].includes(r.dataset.value))
        .map((r) => [r.dataset.value, getComputedStyle(r.querySelector('.dd-option-label > span') || r.querySelector('.dd-option-label')).fontFamily.includes('Mono')])),
      [['LAB-TEX-03', true], ['Figma', false]]);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dd-popover', { state: 'detached' });
      await assertNoNativeControls(page, '.modal');
      await chooseOption(page, '.modal [data-name="target_name"]', 'LAB-CHA-02');
      await page.fill('.modal textarea[data-name="action"]', 'Mettre à jour le BIOS');
      await page.fill('.modal input[data-name="responsable"]', 'Léa Dubois');
      await chooseOption(page, '.modal [data-name="priorite"]', 'Haute');
      await typeDate(page, '.modal [data-name="deadline"]', '31/12/2026');

      // Invalid date: refused under the field, nothing sent.
      await typeDate(page, '.modal [data-name="date_completed"]', '31/02/2026');
      await page.click('.modal .modal-footer .btn-primary');
      assert.equal(await page.getAttribute('.modal [data-name="date_completed"]', 'aria-invalid'), 'true');
      assert.equal((await callsNamed(app, 'api_addAction')).length, 0);
      await typeDate(page, '.modal [data-name="date_completed"]', '');

      // Server error: the modal stays open with the error inline and the typed values kept.
      await page.evaluate(() => { window.__mock.failNext.api_addAction = { code: 'INTERNAL', message: 'Feuille verrouillée.' }; });
      await page.click('.modal .modal-footer .btn-primary');
      await page.waitForSelector('.modal .form-alert .alert-error');
      await app.waitIdle();
      assert.match(await page.textContent('.modal .form-alert'), /Erreur : Feuille verrouillée\./);
      assert.equal(await page.inputValue('.modal textarea[data-name="action"]'), 'Mettre à jour le BIOS');
      assert.equal(await dropdownValue(page, '.modal [data-name="priorite"]'), 'Haute');
      assert.equal((await tableIds(page, 'actions-table')).length, 3);

      // Busy submit while the call runs, then the modal closes.
      await holdCalls(page, 'api_addAction');
      await page.click('.modal .modal-footer .btn-primary');
      await page.waitForSelector('.modal .modal-footer .btn-primary[aria-busy="true"]');
      assert.ok(await page.$('.modal-overlay'), 'modal kept open while saving');
      await page.evaluate(() => window.__release());
      await page.waitForSelector('.modal-overlay', { state: 'detached' });
      await app.waitIdle();
      assert.equal(await page.textContent('#toast-root .toast:last-child .toast-msg'), 'Action créée — LAB-CHA-02.');
      const adds = await callsNamed(app, 'api_addAction');
      assert.equal(adds.length, 2, 'one failed call + one successful call');
      const expected = {
        target_type: 'poste', target_name: 'LAB-CHA-02', equipe: 'Labo Chaussure', action: 'Mettre à jour le BIOS',
        responsable: 'Léa Dubois', priorite: 'Haute', status: 'À faire', deadline: '31/12/2026', date_created: today,
        date_completed: '', source_month: '2026-05', comment: '',
      };
      assert.deepEqual(adds[0].args, expected);
      assert.deepEqual(adds[1].args, expected);
      assert.equal((await callsNamed(app, 'api_getActions')).length, 2, 'actions reloaded once after the write');
      assert.equal((await tableIds(page, 'actions-table')).length, 4);

      // --- edit (row click), close as 'Terminé'
      await page.click('#actions-table tr[data-id="a-0002"] td[data-col="target_name"]');
      await page.waitForSelector('.modal [data-name="status"]');
      assert.equal((await page.textContent('.modal .modal-title')).trim(), 'Modifier l’action');
      assert.equal(await page.inputValue('.modal textarea[data-name="action"]'), 'Isoler du réseau');
      assert.equal(await page.inputValue('.modal [data-name="deadline"]'), '31/05/2026');
      await chooseOption(page, '.modal [data-name="status"]', 'Terminé');
      await submitModal(app);
      const updates = await callsNamed(app, 'api_updateAction');
      assert.deepEqual(updates.map((c) => c.args), [{ id: 'a-0002', updates: { status: 'Terminé', date_completed: today } }]);
      assert.equal(await page.textContent('#toast-root .toast:last-child .toast-msg'), 'Action mise à jour — LAB-MEC-01.');
      assert.equal(await page.textContent('#actions-table tr[data-id="a-0002"] td[data-col="status"]'), 'Terminé');

      // --- edit without change: nothing sent
      await page.click('#actions-table tr[data-id="a-0001"] td[data-col="target_name"]');
      await page.waitForSelector('.modal [data-name="status"]');
      await submitModal(app);
      assert.equal((await callsNamed(app, 'api_updateAction')).length, 1);
      assert.equal(await page.textContent('#toast-root .toast:last-child .toast-msg'), 'Aucune modification.');

      // --- delete (danger confirm opens on « Annuler »; a server error keeps the dialog open)
      await page.click('#actions-table tr[data-id="a-0003"] .btn-delete');
      await page.waitForSelector('.modal .btn-danger');
      assert.match(await page.textContent('.modal .confirm-message'), /Migrer vers Google Drive/);
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Annuler');
      await page.evaluate(() => { window.__mock.failNext.api_deleteAction = { code: 'INTERNAL', message: 'Suppression refusée.' }; });
      await page.click('.modal .modal-footer .btn-danger');
      await page.waitForSelector('.modal .confirm-error .alert-error');
      assert.match(await page.textContent('.modal .confirm-error'), /Suppression refusée/);
      await submitModal(app, '.modal .modal-footer .btn-danger');
      assert.deepEqual((await callsNamed(app, 'api_deleteAction')).map((c) => c.args), [{ id: 'a-0003' }, { id: 'a-0003' }]);
      assert.equal(await page.textContent('#toast-root .toast:last-child .toast-msg'), 'Action supprimée.');
      assert.ok(!(await tableIds(page, 'actions-table')).includes('a-0003'));

      // --- cancelled delete sends nothing
      await page.click('#actions-table tr[data-id="a-0001"] .btn-delete');
      await page.waitForSelector('.modal .btn-danger');
      await submitModal(app, '.modal .modal-footer .btn-secondary');
      assert.equal((await callsNamed(app, 'api_deleteAction')).length, 2);
      assert.deepEqual(app.errors, []);
    });
  });

  test('ActionForm: a locked target (drawer use) prefills the target and sends the same payload', async () => {
    await withApp({ page: 'actions' }, async (app) => {
      const { page } = app;
      const today = await browserToday(page);
      await page.evaluate(() => {
        window.__saved = null;
        window.ActionForm.open({ target: { type: 'application', name: 'Figma' }, defaults: { action: 'Signer le contrat' },
          onSaved: (rec, info) => { window.__saved = info; } });
      });
      await page.waitForSelector('.modal [data-name="target_name"]');
      assert.equal((await page.textContent('.modal .modal-title')).trim(), 'Nouvelle action');
      assert.equal(await page.isDisabled('.modal [data-name="target_name"]'), true);
      assert.equal(await page.isDisabled('.modal [data-name="target_type"]'), true);
      assert.equal(await page.inputValue('.modal [data-name="target_name"]'), 'Figma');
      assert.equal(await page.inputValue('.modal [data-name="equipe"]'), 'R&D Vélo');
      assert.equal(await page.inputValue('.modal textarea[data-name="action"]'), 'Signer le contrat');
      await submitModal(app);
      assert.deepEqual((await callsNamed(app, 'api_addAction')).map((c) => c.args), [{
        target_type: 'application', target_name: 'Figma', equipe: 'R&D Vélo', action: 'Signer le contrat',
        responsable: '', priorite: 'Moyenne', status: 'À faire', deadline: '', date_created: today, date_completed: '',
        source_month: '2026-05', comment: '',
      }]);
      assert.equal(await page.textContent('#toast-root .toast:last-child .toast-msg'), 'Action créée — Figma.');
      assert.deepEqual(await page.evaluate(() => window.__saved), { created: true });
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('actions — replacements', () => {
  test('lists, adds and deletes replacements', async () => {
    await withApp({ page: 'actions' }, async (app) => {
      const { page } = app;
      const today = await browserToday(page);
      await page.click('#actions-tabs .tab[data-tab="replacements"]');
      await page.waitForSelector('#replacements-table');
      await app.waitIdle();
      assert.deepEqual(await tableIds(page, 'replacements-table'), ['r-0001']);
      assert.equal(await page.textContent('#replacements-table tr[data-id="r-0001"] td[data-col="new_poste"]'), 'LAB-TEX-03');

      await page.click('#replacement-add');
      await page.waitForSelector('.modal [data-name="old_poste"]');
      const options = await optionLabels(page, '.modal [data-name="old_poste"]');
      const expected = [...Core.uniqueSorted(data.MONTHS['2026-05'].postes, 'Nom du poste')]; // copy out of the vm realm
      assert.deepEqual(options, expected, 'suggestions = postes of the current month');
      await chooseOption(page, '.modal [data-name="old_poste"]', 'LAB-MEC-01');
      await chooseOption(page, '.modal [data-name="new_poste"]', 'LAB-MEC-02');
      await page.fill('.modal input[data-name="responsable"]', 'Nathan Petit');
      await page.fill('.modal textarea[data-name="comment"]', 'Fin de support Ubuntu 18.04');
      await submitModal(app);
      assert.deepEqual((await callsNamed(app, 'api_addReplacement')).map((c) => c.args), [{
        old_poste: 'LAB-MEC-01', new_poste: 'LAB-MEC-02', equipe: 'Labo Mécanique', responsable: 'Nathan Petit',
        date_replacement: today, comment: 'Fin de support Ubuntu 18.04',
      }]);
      assert.equal(await page.textContent('#toast-root .toast:last-child .toast-msg'),
        'Remplacement enregistré — LAB-MEC-01 → LAB-MEC-02.');
      assert.equal((await tableIds(page, 'replacements-table')).length, 2);
      // Still on the replacements tab after the refresh.
      assert.equal(await page.getAttribute('#actions-tabs', 'data-active'), 'replacements');

      // Edit the comment only (row click opens the form); a server error keeps the modal open.
      await page.click('#replacements-table tr[data-id="r-0001"] td[data-col="old_poste"]');
      await page.waitForSelector('.modal textarea[data-name="comment"]');
      assert.equal(await page.inputValue('.modal [data-name="date_replacement"]'), '05/04/2026');
      await page.fill('.modal textarea[data-name="comment"]', 'Windows 7 obsolète');
      await page.evaluate(() => { window.__mock.failNext.api_updateReplacement = { code: 'INTERNAL', message: 'Erreur simulée' }; });
      await page.click('.modal .modal-footer .btn-primary');
      await page.waitForSelector('.modal .form-alert .alert-error');
      assert.equal(await page.inputValue('.modal textarea[data-name="comment"]'), 'Windows 7 obsolète');
      await submitModal(app);
      assert.deepEqual((await callsNamed(app, 'api_updateReplacement')).map((c) => c.args), [
        { id: 'r-0001', updates: { comment: 'Windows 7 obsolète' } }, { id: 'r-0001', updates: { comment: 'Windows 7 obsolète' } }]);

      await page.click('#replacements-table tr[data-id="r-0001"] .btn-delete');
      await page.waitForSelector('.modal .btn-danger');
      await submitModal(app, '.modal .modal-footer .btn-danger');
      assert.deepEqual((await callsNamed(app, 'api_deleteReplacement')).map((c) => c.args), [{ id: 'r-0001' }]);
      assert.deepEqual(await tableIds(page, 'replacements-table').then((ids) => ids.includes('r-0001')), false);
      assert.equal((await tableIds(page, 'replacements-table')).length, 1);
      await assertNoNativeControls(page);
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('actions — change detection', () => {
  test('compares 2026-04 -> 2026-05 and records a resolved action as done', async () => {
    await withApp({ page: 'actions' }, async (app) => {
      const { page } = app;
      const today = await browserToday(page);
      await page.click('#actions-tabs .tab[data-tab="diff"]');
      await page.waitForSelector('#diff-postes');
      await app.waitIdle();
      assert.equal(await dropdownValue(page, '#diff-old'), '2026-04');
      assert.equal(await dropdownValue(page, '#diff-new'), '2026-05');
      assert.deepEqual(await optionLabels(page, '#diff-old'), ['Avril 2026', 'Mai 2026']);
      assert.equal((await page.textContent('#diff-summary .diff-months')).trim(), 'Avril 2026 → mai 2026');
      assert.deepEqual((await callsNamed(app, 'api_getDiff')).map((c) => c.args), [{ oldMonth: '2026-04', newMonth: '2026-05' }]);

      const names = (sel) => page.$$eval(sel, (trs) => trs.map((t) => t.dataset.name));
      assert.deepEqual(await names('#diff-postes-removed tbody tr'), ['LAB-TEX-02']);
      const added = await names('#diff-postes-added tbody tr');
      assert.ok(added.includes('LAB-TEX-03'));
      assert.ok(added.includes(data.XSS_POSTE_NAME), 'XSS probe shown as text');
      const changed = await names('#diff-postes-changes tbody tr');
      assert.deepEqual([...new Set(changed)], ['LAB-CHA-01', 'LAB-MEC-01']);
      assert.equal(await page.textContent('#diff-postes-changes tr[data-name="LAB-MEC-01"][data-col="Score conformité"] td:last-child'),
        '30,4' + NNBSP + '% → 40,0' + NNBSP + '% amélioration');
      assert.equal(await page.getAttribute('#diff-postes-changes tr[data-name="LAB-MEC-01"][data-col="Score conformité"]', 'data-dir'),
        'better');
      assert.deepEqual(await names('#diff-postes-resolved tbody tr'), ['LAB-CHA-01']);
      assert.deepEqual(await names('#diff-apps-removed tbody tr'), ['Datacolor Tools']);
      assert.deepEqual(await names('#diff-apps-added tbody tr'), ['Figma']);
      assert.deepEqual(await names('#diff-apps-resolved tbody tr'), ['Dropbox perso']);
      assert.match(await page.textContent('#diff-postes-removed .subsection-title'), /Postes retirés \(1\)/);
      assert.equal((await page.textContent('#diff-postes .section-title')).trim(), 'Postes');

      // Record the resolved poste action as done.
      const btn = '#diff-postes-resolved tr[data-name="LAB-CHA-01"] .btn-mark-done';
      assert.equal((await page.textContent(btn)).trim(), 'Enregistrer comme terminée');
      assert.equal(await page.isDisabled(btn), false);
      await holdCalls(page, 'api_addAction');
      await page.click(btn);
      await page.waitForSelector(btn + '[aria-busy="true"]');
      await page.evaluate(() => window.__release());
      await page.waitForSelector(btn, { state: 'detached' });
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_addAction')).map((c) => c.args), [{
        target_type: 'poste', target_name: 'LAB-CHA-01', equipe: 'Labo Chaussure', action: "Installer l'EDR",
        responsable: 'Léa Dubois', status: 'Terminé', date_completed: today, source_month: '2026-05',
        comment: 'Action résolue détectée entre 2026-04 et 2026-05.',
      }]);
      // Recorded: the button is replaced by a status mark.
      const doneMark = '#diff-postes-resolved tr[data-name="LAB-CHA-01"] .diff-done-mark';
      await page.waitForSelector(doneMark);
      assert.equal((await page.textContent(doneMark)).trim(), 'Déjà enregistrée');
      assert.match(await page.getAttribute(doneMark, 'class'), /mark-ok/);
      assert.equal(await page.$(btn), null);
      assert.equal((await callsNamed(app, 'api_getDiff')).length, 1, 'diff not recomputed after the write');
      assert.equal(await page.getAttribute('#actions-tabs', 'data-active'), 'diff');

      // The application action is still open in the tracker: the button stays available, with a note.
      const appBtn = '#diff-apps-resolved tr[data-name="Dropbox perso"] .btn-mark-done';
      assert.equal(await page.isDisabled(appBtn), false);
      assert.match(await page.textContent('#diff-apps-resolved tr[data-name="Dropbox perso"]'), /À faire/);
      await page.click(appBtn);
      await app.waitIdle();
      const last = (await callsNamed(app, 'api_addAction')).pop().args;
      assert.equal(last.target_type, 'application');
      assert.equal(last.status, 'Terminé');
      await page.waitForSelector('#diff-apps-resolved tr[data-name="Dropbox perso"] .diff-done-mark');

      // Changing a month re-runs the diff.
      await chooseOption(page, '#diff-new', 'Avril 2026');
      assert.match(await page.textContent('#diff-result'), /Choisissez deux mois différents/);
      await chooseOption(page, '#diff-old', 'Mai 2026');
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_getDiff')).pop().args, { oldMonth: '2026-05', newMonth: '2026-04' });

      assert.equal(await page.evaluate(() => window.__xss), undefined, 'XSS probe not executed');
      assert.doesNotMatch(await page.textContent('#main'), /\p{Extended_Pictographic}/u, 'no emoji in the diff tab');
      await assertNoNativeControls(page);
      assert.deepEqual(app.errors, []);
    });
  });

  test('fewer than 2 months: info line and disabled month dropdowns', async () => {
    await withApp({ page: 'actions' }, async (app) => {
      const { page } = app;
      await page.evaluate(() => {
        delete window.__mock.db.months['2026-04'];
        window.State.invalidate();
        return window.State.refreshBootstrap().then(() => window.App.refresh());
      });
      await page.click('#actions-tabs .tab[data-tab="diff"]');
      await page.waitForSelector('#diff-info');
      assert.equal(await page.isDisabled('#diff-old'), true);
      assert.equal(await page.isDisabled('#diff-new'), true);
      assert.equal((await callsNamed(app, 'api_getDiff')).length, 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('390px: resolved actions keep a one-line 32px button, no sideways page scroll', async () => {
    await withApp({ page: 'actions', viewport: { width: 390, height: 844 } }, async (app) => {
      const { page } = app;
      await page.click('#actions-tabs .tab[data-tab="diff"]');
      await page.waitForSelector('#diff-postes');
      await app.waitIdle();
      const box = await page.$eval('#diff-postes-resolved .btn-mark-done', (b) => {
        const r = b.getBoundingClientRect();
        return { h: r.height, w: r.width, scroll: b.scrollWidth <= b.clientWidth + 1 };
      });
      assert.ok(box.h <= 32.5, 'button stays one line (' + box.h + 'px)');
      assert.ok(box.w > 200, 'button spans the row');
      assert.ok(box.scroll, 'label not clipped');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, 'no horizontal page scroll (' + overflow + 'px)');
      assert.deepEqual(app.errors, []);
    });
  });
});
