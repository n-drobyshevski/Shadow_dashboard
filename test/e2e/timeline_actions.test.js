'use strict';
/**
 * E2E tests of the "Suivi temporel" and "Suivi actions" pages (docs/API.md §6).
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/timeline_actions.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = require('../fixtures/data');
const { openApp } = require('./harness');

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
  useGrouping: false }).format(n) + ' %';
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
      assert.match(conf.tone, /badge-ok/);
      const rateCell = await kpiCell(page, 'taux_postes', '2026-05');
      assert.equal(rateCell.value, fmtPct(k5.taux_postes));
      const d = k5.taux_postes - k4.taux_postes;
      assert.equal(rateCell.delta, (d > 0 ? '+' : '−') + new Intl.NumberFormat('fr-FR', {
        minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(d)) + ' pt');
      // Fewer postes without EDR is an improvement (green), more apps without SIP would be red.
      const edr = await kpiCell(page, 'postes_sans_edr', '2026-05');
      assert.equal(edr.value, fmtNum(k5.postes_sans_edr));
      // Ledger chrome: no emoji anywhere on the page, line series use the neutral ledger styles.
      assert.doesNotMatch(await page.textContent('#main'), /\p{Extended_Pictographic}/u);
      assert.deepEqual(taux.data.map((t) => t.line.dash), ['solid', 'dash'], 'postes solid ink, applications dashed');
      assert.match(await page.textContent('#chart-timeline-taux + .chart-caption'), /seuil 80/);
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
          status: cell('status').querySelector('.badge').className + '|' + cell('status').textContent,
          deadlineBadge: cell('deadline').querySelector('.badge') ? cell('deadline').querySelector('.badge').className : null,
          deadline: cell('deadline').textContent,
        }];
      })));
      assert.equal(rows['a-0001'].target, 'LAB-TEX-02');
      assert.equal(rows['a-0001'].type, 'Poste');
      assert.equal(rows['a-0003'].type, 'Application');
      assert.equal(rows['a-0001'].status, 'badge badge-ok|Terminé');
      assert.equal(rows['a-0002'].status, 'badge badge-warn|En cours');
      assert.equal(rows['a-0003'].status, 'badge badge-neutral|À faire'); // neutral mark: accent blue is for links
      // Closed actions are never overdue; open ones with a past deadline are (fixture deadlines are in 2026).
      assert.equal(rows['a-0001'].deadlineBadge, null);
      assert.equal(rows['a-0001'].deadline, '30/06/2026');
      const today = Core.frToIso(await browserToday(page));
      const overdue = (fr) => Core.frToIso(fr) < today;
      assert.equal(rows['a-0002'].deadlineBadge !== null && /badge-ko/.test(rows['a-0002'].deadlineBadge), overdue('31/05/2026'));
      if (overdue('31/05/2026')) assert.match(rows['a-0002'].deadline, /31\/05\/2026 en retard/, 'overdue said in words');
      assert.equal(rows['a-0003'].deadlineBadge !== null && /badge-ko/.test(rows['a-0003'].deadlineBadge), overdue('15/04/2026'));

      const counts = await page.$$eval('#action-counts [data-status]', (cs) => Object.fromEntries(cs.map((c) => [
        c.dataset.status, c.querySelector('.act-count-value').textContent])));
      assert.deepEqual(counts, { 'À faire': '1', 'En cours': '1', 'Terminé': '1', 'Abandonné': '0',
        overdue: String(['31/05/2026', '15/04/2026'].filter(overdue).length) });

      // Filters.
      await page.selectOption('#action-filter-status', 'En cours');
      assert.deepEqual(await tableIds(page, 'actions-table'), ['a-0002']);
      await page.selectOption('#action-filter-status', '');
      await page.selectOption('#action-filter-type', 'application');
      assert.deepEqual(await tableIds(page, 'actions-table'), ['a-0003']);
      await page.selectOption('#action-filter-type', '');
      await page.selectOption('#action-filter-equipe', 'Labo Textile');
      assert.deepEqual(await tableIds(page, 'actions-table'), ['a-0001']);
      await page.selectOption('#action-filter-equipe', '');
      await page.fill('#actions-table .etable-search', 'réseau');
      assert.deepEqual(await tableIds(page, 'actions-table'), ['a-0002']);
      assert.deepEqual(app.errors, []);
    });
  });

  test('add, edit and delete send the right payloads and refresh the list', async () => {
    await withApp({ page: 'actions' }, async (app) => {
      const { page } = app;
      const today = await browserToday(page);

      // --- add
      await page.click('#action-add');
      await page.waitForSelector('.modal input[name="target_name"]');
      const datalist = await page.$$eval('.modal datalist option', (os) => os.map((o) => o.value));
      assert.ok(datalist.includes('LAB-TEX-03') && datalist.includes('Figma'), 'current month postes + apps suggested');
      await page.fill('.modal input[name="target_name"]', 'LAB-CHA-02');
      await page.fill('.modal textarea[name="action"]', 'Mettre à jour le BIOS');
      await page.fill('.modal input[name="responsable"]', 'Léa Dubois');
      await page.selectOption('.modal select[name="priorite"]', 'Haute');
      await page.fill('.modal input[name="deadline"]', '2026-12-31');
      await submitModal(app);
      assert.equal(await page.textContent('#toast-root .toast:last-child .toast-msg'), 'Action créée.');
      const adds = await callsNamed(app, 'api_addAction');
      assert.equal(adds.length, 1);
      assert.deepEqual(adds[0].args, {
        target_type: 'poste', target_name: 'LAB-CHA-02', equipe: 'Labo Chaussure', action: 'Mettre à jour le BIOS',
        responsable: 'Léa Dubois', priorite: 'Haute', status: 'À faire', deadline: '31/12/2026', date_created: today,
        date_completed: '', source_month: '2026-05', comment: '',
      });
      assert.equal((await callsNamed(app, 'api_getActions')).length, 2, 'actions reloaded after the write');
      assert.equal((await tableIds(page, 'actions-table')).length, 4);

      // --- edit (row click), close as 'Terminé'
      await page.click('#actions-table tr[data-id="a-0002"] td[data-col="target_name"]');
      await page.waitForSelector('.modal select[name="status"]');
      assert.equal(await page.inputValue('.modal textarea[name="action"]'), 'Isoler du réseau');
      assert.equal(await page.inputValue('.modal input[name="deadline"]'), '2026-05-31');
      await page.selectOption('.modal select[name="status"]', 'Terminé');
      await submitModal(app);
      const updates = await callsNamed(app, 'api_updateAction');
      assert.deepEqual(updates.map((c) => c.args), [{ id: 'a-0002', updates: { status: 'Terminé', date_completed: today } }]);
      assert.equal(await page.textContent('#actions-table tr[data-id="a-0002"] td[data-col="status"]'), 'Terminé');

      // --- delete (confirm)
      await page.click('#actions-table tr[data-id="a-0003"] .btn-delete');
      await page.waitForSelector('.modal .btn-danger');
      assert.match(await page.textContent('.modal .confirm-message'), /Migrer vers Google Drive/);
      await submitModal(app, '.modal .modal-footer .btn-danger');
      assert.deepEqual((await callsNamed(app, 'api_deleteAction')).map((c) => c.args), [{ id: 'a-0003' }]);
      assert.ok(!(await tableIds(page, 'actions-table')).includes('a-0003'));

      // --- cancelled delete sends nothing
      await page.click('#actions-table tr[data-id="a-0001"] .btn-delete');
      await page.waitForSelector('.modal .btn-danger');
      await submitModal(app, '.modal .modal-footer .btn-secondary');
      assert.equal((await callsNamed(app, 'api_deleteAction')).length, 1);
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
      await page.waitForSelector('.modal input[name="old_poste"]');
      const options = await page.$eval('.modal input[name="old_poste"]', (input) =>
        Array.from(input.list.options).map((o) => o.value));
      const expected = [...Core.uniqueSorted(data.MONTHS['2026-05'].postes, 'Nom du poste')]; // copy out of the vm realm
      assert.deepEqual(options, expected, 'datalist = postes of the current month');
      await page.fill('.modal input[name="old_poste"]', 'LAB-MEC-01');
      await page.fill('.modal input[name="new_poste"]', 'LAB-MEC-02');
      await page.fill('.modal input[name="responsable"]', 'Nathan Petit');
      await page.fill('.modal textarea[name="comment"]', 'Fin de support Ubuntu 18.04');
      await submitModal(app);
      assert.deepEqual((await callsNamed(app, 'api_addReplacement')).map((c) => c.args), [{
        old_poste: 'LAB-MEC-01', new_poste: 'LAB-MEC-02', equipe: 'Labo Mécanique', responsable: 'Nathan Petit',
        date_replacement: today, comment: 'Fin de support Ubuntu 18.04',
      }]);
      assert.equal((await tableIds(page, 'replacements-table')).length, 2);
      // Still on the replacements tab after the refresh.
      assert.equal(await page.getAttribute('#actions-tabs', 'data-active'), 'replacements');

      // Edit the comment only.
      await page.click('#replacements-table tr[data-id="r-0001"] .btn-edit');
      await page.waitForSelector('.modal textarea[name="comment"]');
      await page.fill('.modal textarea[name="comment"]', 'Windows 7 obsolète');
      await submitModal(app);
      assert.deepEqual((await callsNamed(app, 'api_updateReplacement')).map((c) => c.args),
        [{ id: 'r-0001', updates: { comment: 'Windows 7 obsolète' } }]);

      await page.click('#replacements-table tr[data-id="r-0001"] .btn-delete');
      await page.waitForSelector('.modal .btn-danger');
      await submitModal(app, '.modal .modal-footer .btn-danger');
      assert.deepEqual((await callsNamed(app, 'api_deleteReplacement')).map((c) => c.args), [{ id: 'r-0001' }]);
      assert.deepEqual(await tableIds(page, 'replacements-table').then((ids) => ids.includes('r-0001')), false);
      assert.equal((await tableIds(page, 'replacements-table')).length, 1);
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
      assert.equal(await page.inputValue('#diff-old'), '2026-04');
      assert.equal(await page.inputValue('#diff-new'), '2026-05');
      assert.deepEqual((await callsNamed(app, 'api_getDiff')).map((c) => c.args), [{ oldMonth: '2026-04', newMonth: '2026-05' }]);

      const names = (sel) => page.$$eval(sel, (trs) => trs.map((t) => t.dataset.name));
      assert.deepEqual(await names('#diff-postes-removed tbody tr'), ['LAB-TEX-02']);
      const added = await names('#diff-postes-added tbody tr');
      assert.ok(added.includes('LAB-TEX-03'));
      assert.ok(added.includes(data.XSS_POSTE_NAME), 'XSS probe shown as text');
      const changed = await names('#diff-postes-changes tbody tr');
      assert.deepEqual([...new Set(changed)], ['LAB-CHA-01', 'LAB-MEC-01']);
      assert.equal(await page.textContent('#diff-postes-changes tr[data-name="LAB-MEC-01"][data-col="Score conformité"] td:last-child'),
        '30,4% → 40%');
      assert.deepEqual(await names('#diff-postes-resolved tbody tr'), ['LAB-CHA-01']);
      assert.deepEqual(await names('#diff-apps-removed tbody tr'), ['Datacolor Tools']);
      assert.deepEqual(await names('#diff-apps-added tbody tr'), ['Figma']);
      assert.deepEqual(await names('#diff-apps-resolved tbody tr'), ['Dropbox perso']);
      assert.match(await page.textContent('#diff-postes-removed .section-title'), /Postes retirés \(1\)/);

      // Record the resolved poste action as done.
      const btn = '#diff-postes-resolved tr[data-name="LAB-CHA-01"] .btn-mark-done';
      assert.equal((await page.textContent(btn)).trim(), 'Enregistrer comme terminée');
      assert.equal(await page.isDisabled(btn), false);
      await page.click(btn);
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_addAction')).map((c) => c.args), [{
        target_type: 'poste', target_name: 'LAB-CHA-01', equipe: 'Labo Chaussure', action: "Installer l'EDR",
        responsable: 'Léa Dubois', status: 'Terminé', date_completed: today, source_month: '2026-05',
        comment: 'Action résolue détectée entre 2026-04 et 2026-05.',
      }]);
      await page.waitForSelector(btn + '[disabled]');
      assert.equal((await page.textContent(btn)).trim(), 'Déjà enregistrée');
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
      await page.waitForSelector(appBtn + '[disabled]');

      // Changing a month re-runs the diff.
      await page.selectOption('#diff-new', '2026-04');
      assert.match(await page.textContent('#diff-result'), /Choisissez deux mois différents/);
      await page.selectOption('#diff-old', '2026-05');
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_getDiff')).pop().args, { oldMonth: '2026-05', newMonth: '2026-04' });

      assert.equal(await page.evaluate(() => window.__xss), undefined, 'XSS probe not executed');
      assert.doesNotMatch(await page.textContent('#main'), /\p{Extended_Pictographic}/u, 'no emoji in the diff tab');
      assert.deepEqual(app.errors, []);
    });
  });
});
