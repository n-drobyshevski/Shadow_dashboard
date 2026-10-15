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
const { openApp, chooseOption, chooseOptions, optionLabels, dropdownValue, choosePeriod, periodValue } = require('./harness');

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
const fmtPct = (n) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(n) + '\u202f%';

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

/** 'YYYY-MM-DD HH:mm' stamp of today in the browser's zone (the chip shows only HH:mm for today). */
function todayStamp(hhmm) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hhmm;
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

      const titles = await page.$$eval('#main .chart-section > .section-title', (ns) => ns.map((n) => n.textContent));
      assert.deepEqual(titles, ['Conformité des postes', 'Conformité des applications', 'Risques — Postes',
        'Risques — Applications', 'Distribution des scores — Postes', 'Distribution des scores — Applications']);
      // No import section any more: the data comes from the hourly sync (status in the app bar).
      assert.equal(await page.$('#import-panel'), null);
      assert.equal(await page.$('#import-month'), null);
      assert.equal(await page.$$eval('#main input[type=month], #main input[type=date], #main select', (n) => n.length), 0);
      // Gauge captions spell the status out (never colour only).
      assert.deepEqual(await page.$$eval('#main .chart-section .threshold-caption', (ns) => ns.map((n) => n.textContent)), [
        'Sous le seuil · 5 conformes sur 7 · seuil 80\u202f%', 'Sous le seuil · 3 conformes sur 5 · seuil 80\u202f%']);
      // No native title tooltips in the page.
      assert.equal(await page.$$eval('#main [title]', (n) => n.length), 0);
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
      await chooseOptions(page, '#filter-equipe .dd-trigger', ['Labo Textile']);
      await page.waitForSelector('#main .filter-note');
      await app.waitIdle();
      const filtered = kpisFor('2026-05', { equipes: ['Labo Textile'], batiments: [] });
      assert.notEqual(filtered.total_postes, kpisFor('2026-05').total_postes);
      assertCards(await readCards(page), filtered);
      assert.match(await page.textContent('#main .filter-note'), /Équipe : Labo Textile/);

      await chooseOptions(page, '#filter-equipe .dd-trigger', ['Labo Textile', 'R&D Vélo']);
      await app.waitIdle();
      await page.waitForFunction(() => /R&D Vélo/.test(document.querySelector('#main .filter-note').textContent));
      assertCards(await readCards(page), kpisFor('2026-05', { equipes: ['Labo Textile', 'R&D Vélo'], batiments: [] }));

      // Bâtiment filter applies to postes only.
      await chooseOptions(page, '#filter-batiment .dd-trigger', ['Bâtiment A']);
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
      await choosePeriod(app.page, '2026-04');
      await app.page.waitForFunction(() => document.getElementById('dashboard-caption').dataset.month === '2026-04');
      assert.equal(await app.page.textContent('#dashboard-caption'), 'Avril 2026 · Export 2026-04');
      await app.waitIdle();
      assertCards(await readCards(app.page), kpisFor('2026-04'));
      assert.deepEqual(app.errors, []);
    });
  });

  test('app bar: time of the last sync; the panel tells what changed; « Synchroniser maintenant »', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      const chip = '#sync-chip';
      assert.equal(await page.getAttribute(chip, 'data-tone'), 'ok');
      assert.match((await page.textContent(chip)).trim(), /^\d{2}:\d{2}$/);
      assert.match(await page.getAttribute(chip, 'aria-label'), /^Synchronisation : Synchronisé à \d{2}:\d{2}\. Afficher le détail\.$/);
      assert.equal(await page.getAttribute(chip, 'aria-expanded'), 'false');
      await page.click(chip);
      await page.waitForSelector('#sync-popover #sync-panel');
      assert.equal(await page.getAttribute(chip, 'aria-expanded'), 'true');
      assert.match(await page.textContent('#sync-panel-status'), /^Synchronisé à \d{2}:\d{2}$/);
      assert.equal(await page.textContent('#sync-panel-change'),
        'Dernière modification 04/05 10:30 · +1 poste · −1 poste · 2 postes modifiés (3 valeurs) · +1 application · −1 application');
      assert.match(await page.textContent('#sync-panel'), /\(le mois en cours\) est relu depuis le Google Sheet source ShadowIT_Industry/);
      // Tab moves between the panel's controls (the panel stays open); Escape closes it, focus back on the chip.
      await page.focus('#sync-now');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sync-journal');
      assert.ok(await page.isVisible('#sync-popover'));
      await page.keyboard.press('Escape');
      await page.waitForSelector('#sync-popover', { state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sync-chip');

      // The current month is not in the data yet: the sync creates it (the live source = the 2026-05 fixture).
      const current = await page.evaluate(() => window.State.get().currentMonth);
      await page.click(chip);
      await page.click('#sync-now');
      await page.waitForSelector('.toast-success');
      await app.waitIdle();
      assert.equal(await page.textContent('.toast-success .toast-msg'), 'Synchronisé — mois créé.');
      assert.deepEqual(await page.evaluate(() => window.State.get().months), ['2026-04', '2026-05', current]);
      assert.deepEqual(await periodValue(page), { from: '2026-05', to: '2026-05' }, 'the month being read stays selected');
      const calls = (await app.calls()).map((c) => c.name);
      assert.ok(calls.lastIndexOf('api_bootstrap') > calls.lastIndexOf('api_syncNow'), 'bootstrap reloaded after a change');
      assert.ok(calls.lastIndexOf('api_getMonthData') > calls.lastIndexOf('api_syncNow'), 'page re-mounted with fresh data');

      // Nothing new on a second run.
      await page.click('.toast-success .toast-close').catch(() => {});
      if (!(await page.isVisible('#sync-popover'))) await page.click(chip);
      await page.click('#sync-now');
      await page.waitForFunction(() => [...document.querySelectorAll('.toast-success .toast-msg')]
        .some((n) => n.textContent === 'Synchronisé — aucune modification.'));
      assert.deepEqual(app.errors, []);
    });
  });

  test('sync button: busy while the sync runs, then back to the time', async () => {
    await withApp({ delayMs: 400 }, async (app) => {
      const { page } = app;
      await page.click('#sync-chip');
      await page.click('#sync-now');
      await page.waitForSelector('#sync-chip[data-tone="busy"] .spinner');
      assert.equal((await page.textContent('#sync-chip')).trim(), 'Synchronisation…');
      await page.waitForSelector('#sync-now.is-busy[aria-busy="true"]');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'sync-now', 'focus kept across re-renders');
      // The new month was created with the source's warnings: the mark turns amber, the text is the time again.
      await page.waitForSelector('#sync-chip[data-tone="warn"]', { timeout: 10000 });
      assert.match((await page.textContent('#sync-chip')).trim(), /^\d{2}:\d{2}$/);
      // A new month re-renders the app bar (the panel closes with its button); reopened, it lists the warnings.
      await app.waitIdle();
      if (!(await page.$('#sync-panel'))) await page.click('#sync-chip');
      assert.match(await page.textContent('#sync-panel .alert-warning'), /ignorée/);
      await app.waitIdle();
      assert.deepEqual(app.errors, []);
    });
  });

  test('a failed sync shows in the app bar until the next success', async () => {
    const sync = { lastOkAt: todayStamp('10:02'), lastRunAt: todayStamp('11:02'),
      lastError: { at: todayStamp('11:02'), code: 'SOURCE_ERROR', message: 'Impossible d’ouvrir le classeur source.' } };
    await withApp({ sync }, async (app) => {
      const { page } = app;
      assert.equal(await page.getAttribute('#sync-chip', 'data-tone'), 'ko');
      assert.equal((await page.textContent('#sync-chip')).trim(), 'Échec 11:02');
      await page.click('#sync-chip');
      await page.waitForSelector('#sync-panel-error');
      assert.equal(await page.textContent('#sync-panel-status'), 'Échec de la synchronisation à 11:02');
      assert.equal(await page.textContent('#sync-panel-error'),
        'Impossible d’ouvrir le classeur source. Les données affichées datent de la synchronisation à 10:02.');

      await page.evaluate(() => { window.__mock.failNext.api_syncNow = { code: 'SOURCE_ERROR', message: 'Onglet introuvable' }; });
      await page.click('#sync-now');
      await page.waitForSelector('.toast-error');
      assert.match(await page.textContent('.toast-error .toast-msg'), /Synchronisation impossible\. Onglet introuvable/);
      await app.waitIdle();
      await page.click('#sync-now');
      await page.waitForSelector('#sync-chip[data-tone="warn"]');
      assert.equal(await page.$('#sync-panel-error'), null);
      assert.deepEqual(app.errors.filter((e) => !/Onglet introuvable/.test(e)), []);
    });
  });

  test('newer data on the server: « Nouvelles données », then « Actualiser » reloads', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      await page.evaluate(() => { window.__mock.db.sync.lastChangeAt = '2026-05-05 08:00'; });
      await page.click('#sync-chip');   // opening the panel refreshes the status
      await page.waitForSelector('#sync-chip[data-tone="new"]');
      assert.equal((await page.textContent('#sync-chip')).trim(), 'Nouvelles données');
      await page.waitForSelector('#sync-reload');
      const before = (await app.calls()).length;
      await page.click('#sync-reload');
      await page.waitForSelector('#sync-chip[data-tone="ok"]');
      await app.waitIdle();
      const after = (await app.calls()).slice(before).map((c) => c.name);
      assert.ok(after.includes('api_bootstrap') && after.includes('api_getMonthData'), after.join(','));
      assert.equal(await page.$('#sync-popover'), null);
      assert.deepEqual(app.errors, []);
    });
  });

  test('empty state: admins run the first sync from the dashboard', async () => {
    await withApp({ empty: true }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#dashboard-empty')).trim(),
        'Aucune donnée pour le moment. La synchronisation crée le mois en cours à partir du Google Sheet source.');
      assert.equal(await page.$('#dashboard-body'), null);
      assert.equal(await page.$$eval('[data-kpi]', (n) => n.length), 0);
      assert.equal(await page.isDisabled('#period-button'), true);
      assert.equal((await page.textContent('#sync-chip')).trim(), 'En attente');

      await page.click('#dashboard-sync');
      await page.waitForSelector('[data-kpi="total_postes"]');
      await app.waitIdle();
      // First snapshot: no previous month to carry Galink/IDP over from, so they are empty.
      const k = kpisFor('2026-05', null, { custom: false });
      assert.equal(k.apps_sans_galink, 0);
      assertCards(await readCards(page), k);
      assert.equal((await periodValue(page)).to, await page.evaluate(() => window.State.get().currentMonth));
      assert.equal(await page.getAttribute('#sync-chip', 'data-tone'), 'warn'); // ghost-row warning of the source
      assert.deepEqual(app.errors, []);
    });
  });

  test('month data error: alert-error line with « Réessayer »', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      await page.evaluate(() => {
        window.__mock.failNext.api_getMonthData = { code: 'INTERNAL', message: 'Feuille illisible' };
        window.State.invalidate();
      });
      await choosePeriod(page, '2026-04');
      await page.waitForSelector('#dashboard-body .alert-error');
      assert.equal((await page.textContent('#dashboard-body .alert-error p')).replace('Réessayer', '').trim(),
        'Impossible de charger avril 2026 : Feuille illisible');
      // The month swap's failure is shown as is: the page does not request the month a second time.
      const tries = (await app.calls()).filter((c) => c.name === 'api_getMonthData' && c.args.month === '2026-04');
      assert.equal(tries.length, 1);
      await page.click('#dashboard-body .error-retry');
      await page.waitForSelector('[data-kpi="total_postes"]');
      await app.waitIdle();
      assertCards(await readCards(page), kpisFor('2026-04'));
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
