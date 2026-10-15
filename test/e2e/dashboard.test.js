'use strict';
/**
 * E2E tests of the Dashboard page (docs/API.md §6 "Tableau de bord").
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/
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

function fixtureMonth(month, { custom: withCustom = true } = {}) {
  const custom = withCustom ? data.CUSTOM_FIELDS[month] || {} : {};
  const postes = Core.enrichPostes(data.MONTHS[month].postes);
  const applications = Core.enrichApplications(data.MONTHS[month].applications.map((a) => {
    const c = custom[a['Nom du logiciel / service']] || {};
    return { ...a, Galink: c.Galink === undefined ? null : c.Galink, IDP: c.IDP === undefined ? null : c.IDP };
  }));
  return { postes, applications };
}

function kpisFor(month, filters, opts) {
  const f = Core.filterData(fixtureMonth(month, opts), filters || { equipes: [], batiments: [] });
  return JSON.parse(JSON.stringify(Core.computeKpis(f.postes, f.applications)));
}

// Same formatting as UI.fmtNum / UI.fmtPct.
const fmtNum = (n) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(n);
const fmtPct = (n) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(n) + ' %';

async function readCards(page) {
  return page.$$eval('[data-kpi]', (cards) => Object.fromEntries(cards.map((c) => [c.dataset.kpi, {
    title: c.querySelector('.metric-title').textContent,
    value: c.querySelector('.metric-value').textContent,
    sub: c.querySelector('.metric-sub') ? c.querySelector('.metric-sub').textContent : null,
  }])));
}

function assertCards(cards, k) {
  assert.deepEqual(cards, {
    total_postes: { title: 'Postes inventoriés', value: fmtNum(k.total_postes), sub: null },
    postes_conformes: { title: 'Postes conformes', value: fmtNum(k.postes_conformes), sub: fmtPct(k.taux_postes) },
    total_apps: { title: 'Applications inventoriées', value: fmtNum(k.total_apps), sub: null },
    apps_conformes: { title: 'Applications conformes', value: fmtNum(k.apps_conformes), sub: fmtPct(k.taux_apps) },
  });
}

async function withApp(options, fn) {
  const app = await openApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function startImport(app, month) {
  await app.page.fill('#import-month', month);
  await app.page.click('#import-button');
}

describe('dashboard', () => {
  test('renders title, caption and KPI cards matching Core.computeKpis (2026-05)', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main h1')).trim(), 'Tableau de bord');
      assert.equal(await page.getAttribute('#dashboard-caption', 'data-month'), '2026-05');
      assert.equal(await page.textContent('#dashboard-caption'), 'Mai 2026 · Export 2026-05');
      const k = kpisFor('2026-05');
      assert.equal(k.total_postes, 7);
      assertCards(await readCards(page), k);

      // Détail conformité: counts per criterion.
      const details = await page.$$eval('[data-detail]', (ds) => Object.fromEntries(ds.map((d) => [
        d.dataset.detail, d.querySelector('.detail-label').textContent + '=' + d.querySelector('.detail-count').textContent])));
      assert.deepEqual(details, {
        postes_sans_edr: 'Sans EDR=' + k.postes_sans_edr,
        postes_non_it: 'Non IT Decathlon=' + k.postes_non_it,
        postes_hors_reseau: 'Hors réseau Decathlon=' + k.postes_hors_reseau,
        apps_sans_sip: 'Sans SIP=' + k.apps_sans_sip,
        apps_sans_contrat: 'Sans contrat=' + k.apps_sans_contrat,
        apps_sans_galink: 'Sans Galink=' + k.apps_sans_galink,
        apps_sans_idp: 'Sans IDP=' + k.apps_sans_idp,
      });

      const titles = await page.$$eval('#main .chart-card .card-title', (ns) => ns.map((n) => n.textContent));
      assert.deepEqual(titles, ['Conformité des postes', 'Conformité des applications', 'Risques — Postes',
        'Risques — Applications', 'Distribution des scores — Postes', 'Distribution des scores — Applications']);
      assert.equal((await page.textContent('#import-panel h2')).trim(), 'Importer depuis Google Sheets');
      assert.equal(await page.inputValue('#import-month'), await page.evaluate(() => window.State.get().currentMonth));
      // Import log: newest first.
      assert.deepEqual(await page.$$eval('#import-log tbody tr td:first-child', (ns) => ns.map((n) => n.textContent)),
        ['2026-05', '2026-04']);
      assert.deepEqual(app.errors, []);
    });
  });

  test('draws gauges, risk bars and histograms with Plotly', async () => {
    await withApp({}, async (app) => {
      const plots = await app.plots();
      const byId = Object.fromEntries(plots.map((p) => [p.id, p]));
      for (const id of ['chart-gauge-postes', 'chart-gauge-apps', 'chart-risk-postes', 'chart-risk-apps',
        'chart-hist-postes', 'chart-hist-apps']) {
        assert.ok(byId[id], 'Plotly call for ' + id);
      }
      const k = kpisFor('2026-05');
      // Colours come from the design tokens (docs/DESIGN.md), exposed by Charts.tokens().
      const tokens = await app.page.evaluate(() => window.Charts.tokens());
      assert.equal(tokens.ok, '#1f7a4d');
      assert.equal(tokens.ko, '#b42318');
      const gauge = byId['chart-gauge-postes'].data[0];
      assert.equal(gauge.type, 'indicator');
      assert.ok(Math.abs(gauge.value - k.taux_postes) < 1e-9);
      assert.equal(gauge.gauge.threshold.value, 80);
      assert.equal(gauge.gauge.bar.color, k.taux_postes >= 80 ? tokens.ok : tokens.ko);
      const gaugeApps = byId['chart-gauge-apps'].data[0];
      assert.equal(gaugeApps.gauge.bar.color, k.taux_apps >= 80 ? tokens.ok : tokens.ko);

      // Risk distribution: horizontal bars, one row per level in RISK_ORDER.
      const risk = byId['chart-risk-postes'].data[0];
      assert.equal(risk.orientation, 'h');
      assert.deepEqual(risk.y, ['Critique', 'Élevé', 'Moyen', 'Faible']);
      const f = fixtureMonth('2026-05');
      const counts = Core.riskCounts(f.postes);
      assert.deepEqual(risk.x, risk.y.map((r) => counts[r]));
      assert.deepEqual(risk.marker.color, risk.y.map((r) => tokens.risk[r]));

      const hist = byId['chart-hist-postes'].data[0];
      assert.equal(hist.y.length, 10);
      // Bins at/above the threshold in --ok, below in --ko (70 % opacity).
      hist.x.forEach((x, i) => assert.equal(hist.marker.color[i], x >= 80 ? tokens.ok : 'rgba(180,35,24,0.7)'));
      assert.equal(hist.y.reduce((a, b) => a + b, 0), f.postes.filter((p) => p._score !== null).length);
      const nPlotlyNodes = await app.page.$$eval('#main .js-plotly-plot', (ns) => ns.length);
      assert.equal(nPlotlyNodes, 6);
      assert.deepEqual(app.errors, []);
    });
  });

  test('Équipe filter changes the KPIs', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      await page.click('#filter-equipe .ms-toggle');
      await page.check('#filter-equipe input[value="Labo Textile"]');
      await page.waitForSelector('#main .filter-note');
      await app.waitIdle();
      const filtered = kpisFor('2026-05', { equipes: ['Labo Textile'], batiments: [] });
      assert.notEqual(filtered.total_postes, kpisFor('2026-05').total_postes);
      assertCards(await readCards(page), filtered);
      assert.match(await page.textContent('#main .filter-note'), /Équipe : Labo Textile/);

      await page.check('#filter-equipe input[value="R&D Vélo"]');
      await app.waitIdle();
      await page.waitForFunction(() => /R&D Vélo/.test(document.querySelector('#main .filter-note').textContent));
      assertCards(await readCards(page), kpisFor('2026-05', { equipes: ['Labo Textile', 'R&D Vélo'], batiments: [] }));

      // Bâtiment filter applies to postes only.
      await page.click('#filter-batiment .ms-toggle');
      await page.check('#filter-batiment input[value="Bâtiment A"]');
      await app.waitIdle();
      await page.waitForFunction(() => /Bâtiment A/.test(document.querySelector('#main .filter-note').textContent));
      assertCards(await readCards(page),
        kpisFor('2026-05', { equipes: ['Labo Textile', 'R&D Vélo'], batiments: ['Bâtiment A'] }));
      // The month data was fetched once and re-used for every filter change.
      assert.equal((await app.calls()).filter((c) => c.name === 'api_getMonthData').length, 1);
      assert.deepEqual(app.errors, []);
    });
  });

  test('month select switches the snapshot', async () => {
    await withApp({}, async (app) => {
      await app.page.selectOption('#month-select', '2026-04');
      await app.page.waitForFunction(() => document.getElementById('dashboard-caption').dataset.month === '2026-04');
      assert.equal(await app.page.textContent('#dashboard-caption'), 'Avril 2026 · Export 2026-04');
      await app.waitIdle();
      assertCards(await readCards(app.page), kpisFor('2026-04'));
      assert.deepEqual(app.errors, []);
    });
  });

  test('import of an existing month asks for confirmation, then overwrites', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      await startImport(app, '2026-05');
      await page.waitForSelector('.modal[role="dialog"]');
      const msg = await page.textContent('.modal .confirm-message');
      assert.equal(msg, 'Le mois 2026-05 existe déjà. Ré-importer écrase les postes, applications et le référentiel ' +
        'de ce mois (Galink/IDP sont conservés). Continuer ?');
      await page.click('.modal .btn-danger');
      await page.waitForSelector('.toast-success');
      await app.waitIdle();
      await page.waitForSelector('#import-result');
      assert.equal(await page.textContent('.toast-success .toast-msg'), 'Import terminé — 7 postes, 5 applications.');

      const imports = (await app.calls()).filter((c) => c.name === 'api_importMonth');
      assert.deepEqual(imports.map((c) => c.args), [
        { month: '2026-05', overwrite: false },
        { month: '2026-05', overwrite: true },
      ]);
      // Re-mounted with fresh data (cache invalidated) and the warnings of the import are shown.
      const calls = (await app.calls()).map((c) => c.name);
      assert.ok(calls.lastIndexOf('api_getMonthData') > calls.lastIndexOf('api_importMonth'));
      assert.ok(calls.lastIndexOf('api_bootstrap') > calls.lastIndexOf('api_importMonth'));
      assert.match(await page.textContent('#import-result'), /ignorée/);
      assert.equal(await page.getAttribute('#dashboard-caption', 'data-month'), '2026-05');
      assert.deepEqual(app.errors, []);
    });
  });

  test('cancelling the confirmation does not overwrite', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      await startImport(app, '2026-04');
      await page.waitForSelector('.modal[role="dialog"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.modal[role="dialog"]', { state: 'detached' });
      await app.waitIdle();
      const imports = (await app.calls()).filter((c) => c.name === 'api_importMonth');
      assert.deepEqual(imports.map((c) => c.args), [{ month: '2026-04', overwrite: false }]);
      assert.equal(await page.isEnabled('#import-button'), true);
      assert.deepEqual(app.errors, []);
    });
  });

  test('importing a new month selects it; server errors are shown', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      await page.evaluate(() => { window.__mock.failNext.api_importMonth = { code: 'SOURCE_ERROR', message: 'Onglet introuvable' }; });
      await startImport(app, '2026-06');
      await page.waitForSelector('#import-status .alert-error');
      assert.match(await page.textContent('#import-status'), /Onglet introuvable/);

      await startImport(app, '2026-06');
      await page.waitForFunction(() => ((document.getElementById('dashboard-caption') || {}).dataset || {}).month === '2026-06');
      await app.waitIdle();
      assert.equal(await page.inputValue('#month-select'), '2026-06');
      assert.deepEqual(await page.$$eval('#month-select option', (os) => os.map((o) => o.value)), ['2026-04', '2026-05', '2026-06']);
      assertCards(await readCards(page), kpisFor('2026-05')); // the live source holds the 2026-05 fixture
      assert.equal(await page.$$eval('#import-log tbody tr', (rs) => rs.length), 3);

      // Client-side validation of the month.
      await page.evaluate(() => { const i = document.getElementById('import-month'); i.type = 'text'; i.value = '2026-13'; });
      await page.click('#import-button');
      assert.match(await page.textContent('#import-status'), /Mois invalide/);
      assert.deepEqual(app.errors.filter((e) => !/Onglet introuvable/.test(e)), []);
    });
  });

  test('empty state: warning + import panel only, then import', async () => {
    await withApp({ empty: true }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#dashboard-empty')).trim(), 'Aucune donnée importée.');
      assert.equal(await page.$('#dashboard-body'), null);
      assert.equal(await page.$$eval('[data-kpi]', (n) => n.length), 0);
      assert.ok(await page.isVisible('#import-panel'));
      assert.match(await page.textContent('#import-log'), /Aucun import/);
      assert.equal(await page.isDisabled('#month-select'), true);

      await startImport(app, '2026-05');
      await page.waitForSelector('[data-kpi="total_postes"]');
      await app.waitIdle();
      // First snapshot: no previous month to carry Galink/IDP over from, so they are empty.
      const k = kpisFor('2026-05', null, { custom: false });
      assert.equal(k.apps_sans_galink, 0);
      assertCards(await readCards(page), k);
      assert.equal(await page.inputValue('#month-select'), '2026-05');
      assert.deepEqual(app.errors, []);
    });
  });

  test('XSS probe in fixture data is rendered as text', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      // Open every detail list (the probe poste is "Sans EDR", "Non IT" and "Hors réseau").
      await page.$$eval('#main details', (ds) => ds.forEach((d) => { d.open = true; }));
      const listed = await page.$$eval('[data-detail="postes_sans_edr"] li', (ls) => ls.map((l) => l.textContent));
      assert.ok(listed.includes(data.XSS_POSTE_NAME), 'probe name shown literally');
      assert.equal(await page.$$eval('#main img', (n) => n.length), 0);
      for (const id of ['postes', 'apps', 'timeline', 'actions', 'dashboard']) await app.goto(id);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.deepEqual(app.errors, []);
    });
  });
});
