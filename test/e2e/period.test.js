'use strict';
/**
 * E2E tests of the period (app bar « Période »: one month or a range of months, docs/API.md §5).
 * A period shows the state of its LAST month compared with its first one; fixtures: 2026-04, 2026-05.
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/period.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = require('../fixtures/data');
const { openApp, choosePeriod, periodValue } = require('./harness');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'Core.js'), 'utf8'), ctx);
const Core = ctx.Core;
const KEY_POSTE = 'Nom du poste';

async function withApp(options, fn) {
  const app = await openApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

function kpis(month) {
  const p = Core.enrichPostes(data.MONTHS[month].postes);
  const custom = data.CUSTOM_FIELDS[month] || {};
  const a = Core.enrichApplications(data.MONTHS[month].applications.map((r) => {
    const c = custom[r['Nom du logiciel / service']] || {};
    return { ...r, Galink: c.Galink === undefined ? null : c.Galink, IDP: c.IDP === undefined ? null : c.IDP };
  }));
  return Core.computeKpis(p, a);
}

const pts = (d) => (Math.abs(d) < 0.05 ? '= 0,0' : (d > 0 ? '▲ +' : '▼ −') + Math.abs(d).toFixed(1).replace('.', ',')) + ' pts depuis avril';

describe('period', () => {
  test('panel: pick avril then mai, apply; the dashboard shows the end state and the change since the start', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#period-button')).trim(), 'Mai 2026');
      await page.click('#period-button');
      await page.waitForSelector('#period-panel');
      assert.equal(await page.getAttribute('#period-button', 'aria-expanded'), 'true');
      assert.equal(await page.getAttribute('#period-preset-month', 'aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'period-preset-month');
      // Only the synchronised months can be picked.
      const enabled = await page.$$eval('.period-month:not(:disabled)', (bs) => bs.map((b) => b.dataset.month));
      assert.deepEqual(enabled, ['2026-04', '2026-05']);
      await page.click('#period-month-2026-04');
      assert.match(await page.textContent('.period-hint'), /Choisissez la fin/);
      await page.click('#period-month-2026-05');
      assert.equal(await page.textContent('#period-summary'), 'Avril → mai 2026 · 2 mois');
      // The range equals several shortcuts here (3 / 6 derniers mois, année, tout): the first one is marked.
      assert.deepEqual(await page.$$eval('.period-preset[aria-pressed="true"]', (bs) => bs.map((b) => b.dataset.preset)), ['last3']);
      await page.click('#period-apply');
      await page.waitForSelector('#period-popover', { state: 'detached' });
      await page.waitForFunction(() => document.getElementById('dashboard-caption').dataset.from === '2026-04');
      await app.waitIdle();

      assert.equal((await page.textContent('#period-button')).trim(), 'Avr. – mai 2026');
      assert.deepEqual(await periodValue(page), { from: '2026-04', to: '2026-05' });
      assert.equal(await page.textContent('#dashboard-caption'), 'Avril → mai 2026 · état fin mai');
      assert.equal(await page.isDisabled('#month-prev'), true);
      assert.equal(await page.isDisabled('#month-next'), true);

      const k0 = kpis('2026-04');
      const k1 = kpis('2026-05');
      const deltas = await page.$$eval('[data-kpi]', (cs) => Object.fromEntries(cs.map((c) =>
        [c.dataset.kpi, (c.querySelector('.metric-delta') || {}).textContent || null])));
      const count = (d) => (d > 0 ? '+' + d : d < 0 ? '−' + -d : 'inchangé') + ' depuis avril';
      assert.deepEqual(deltas, {
        total_postes: count(k1.total_postes - k0.total_postes),
        postes_conformes: pts(k1.taux_postes - k0.taux_postes),
        total_apps: count(k1.total_apps - k0.total_apps),
        apps_conformes: pts(k1.taux_apps - k0.taux_apps),
      });
      assert.equal(await page.$$eval('[data-kpi] svg.sparkline', (n) => n.length), 4);
      // Gauges stay the end month's.
      assert.match(await page.textContent('#main .threshold-caption'), /5 conformes sur 7/);
      assert.deepEqual(app.errors, []);
    });
  });

  test('a shortcut applies at once and is remembered for the account', async () => {
    await withApp({}, async (app) => {
      const { page } = app;
      await page.click('#period-button');
      await page.click('#period-preset-all');
      await page.waitForSelector('#period-popover', { state: 'detached' });
      await app.waitIdle();
      assert.deepEqual(await periodValue(page), { from: '2026-04', to: '2026-05' });
      const saves = (await app.calls()).filter((c) => c.name === 'api_savePrefs').map((c) => c.args);
      assert.deepEqual(saves, [{ period: 'all' }]);
      // A single month is one click + « Appliquer »; « ‹ » then moves it.
      await choosePeriod(page, '2026-05');
      await app.waitIdle();
      assert.deepEqual(await periodValue(page), { from: '2026-05', to: '2026-05' });
      await page.click('#month-prev');
      await page.waitForFunction(() => window.State.get().month === '2026-04');
      assert.equal((await page.textContent('#period-button')).trim(), 'Avril 2026');
      assert.deepEqual(app.errors, []);
    });
    await withApp({ prefs: { period: 'all' } }, async (app) => {
      assert.equal((await app.page.textContent('#period-button')).trim(), 'Avr. – mai 2026');
      assert.equal(await app.page.getAttribute('#dashboard-caption', 'data-from'), '2026-04');
      assert.deepEqual(app.errors, []);
    });
  });

  test('postes over a period: « Évolution » column, counts, removed postes, « Seulement ce qui a changé »', async () => {
    await withApp({ page: 'postes', prefs: { period: 'all' } }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#postes-table tbody tr[data-id]');
      assert.equal(await page.textContent('#postes-caption'), 'Avril → mai 2026 · inventaire fin mai');
      const e = Core.scoreEvolution(Core.enrichPostes(data.MONTHS['2026-04'].postes), Core.enrichPostes(data.MONTHS['2026-05'].postes), KEY_POSTE);
      assert.equal((await page.textContent('#postes-evo-stats')).replace(/\s+/g, ' '),
        `+${e.added} nouveaux · ${e.removed.length} retiré · ${e.changed} ${e.changed > 1 ? 'scores modifiés' : 'score modifié'} depuis avril`);
      assert.equal(await page.textContent('#postes-removed'), '1 poste retiré depuis avril 2026 : LAB-TEX-02');
      const headers = await page.$$eval('#postes-table thead th', (ths) => ths.map((t) => t.textContent.trim()));
      assert.ok(headers.includes('Évolution depuis avril'), headers.join(' | '));
      const evo = await page.$$eval('#postes-table tbody tr[data-id]', (trs) => Object.fromEntries(trs.map((tr) => [
        tr.querySelector('td').textContent.trim(), tr.querySelector('td[data-col="_evo"]').textContent.replace(/\s+/g, ' ').trim()])));
      assert.equal(evo['LAB-TEX-03'], 'Nouveau');
      assert.equal(evo['LAB-MEC-01'], '30,4 % → 40,0 %');
      assert.equal(evo['LAB-TEX-01'], '—');

      const all = await page.$$eval('#postes-table tbody tr[data-id]', (t) => t.length);
      await page.click('label.cb:has(#postes-changed-only)');
      const changed = await page.$$eval('#postes-table tbody tr[data-id]', (t) => t.length);
      assert.equal(changed, e.added + e.changed);
      assert.ok(changed < all);
      assert.deepEqual(app.errors, []);
    });
  });

  test('timeline: limited to the period; actions: only the ones dated inside it', async () => {
    await withApp({ page: 'timeline', currentMonth: '2026-06' }, async (app) => {
      const { page } = app;
      await page.evaluate(() => window.App.syncNow());   // creates 2026-06 (3 months)
      await app.waitIdle();
      await choosePeriod(page, '2026-05', '2026-06');
      await page.waitForFunction(() => (document.getElementById('timeline-kicker') || {}).textContent.includes('sur 3'));
      await app.waitIdle();
      assert.equal(await page.textContent('#timeline-kicker'), 'Mai 2026 – juin 2026 · 2 exports sur 3');
      assert.deepEqual(await page.$$eval('#timeline-kpi-table thead th[data-month]', (ths) => ths.map((t) => t.dataset.month)),
        ['2026-05', '2026-06']);

      await choosePeriod(page, '2026-04', '2026-05');
      await app.goto('actions');
      await page.waitForSelector('#actions-period-note');
      assert.equal(await page.textContent('#actions-period-note'), 'Période Avril → mai 2026 — actions créées ou terminées dans la période.');
      const ids = await page.$$eval('#actions-table tbody tr[data-id]', (trs) => trs.map((t) => t.dataset.id));
      assert.deepEqual(ids, ['a-0001']); // completed 05/04/2026; the two others were created in March
      assert.deepEqual(app.errors, []);
    });
  });
});
