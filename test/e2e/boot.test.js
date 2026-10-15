'use strict';
/**
 * E2E tests of the cold open: the bootstrap and the ?page= doGet renders into the page (read once, RPC
 * fallback), the landing data requested in parallel behind the splash, and Plotly loading without
 * blocking (Charts.ready).
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ACCOUNTS, openApp } = require('./harness');
const { bootstrapEnvelope } = require('../fixtures/mockRun');

const CHARTS = ['chart-gauge-postes', 'chart-gauge-apps', 'chart-risk-postes', 'chart-risk-apps', 'chart-hist-postes',
  'chart-hist-apps'];

async function withApp(options, fn) {
  const app = await openApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const names = async (app) => (await app.calls()).map((c) => c.name);
const monthCalls = async (app) => (await app.calls()).filter((c) => c.name === 'api_getMonthData').map((c) => c.args.month);
/** Chrome reports a failed resource load as a console error: expected when the test makes Plotly fail. */
const unexpected = (errors) => errors.filter((e) => !/Failed to load resource/.test(e));

describe('inline bootstrap', () => {
  test('boots from the bootstrap in the page: no api_bootstrap call, the dashboard renders', async () => {
    await withApp({ boot: true }, async (app) => {
      const { page } = app;
      assert.match(fs.readFileSync(app.file, 'utf8'), /<script type="application\/json" id="boot-data">\{"ok":true,/);
      assert.equal(await page.$('#boot-data'), null, 'read once, then removed');
      assert.equal(await page.$('#boot-page'), null);
      assert.ok(!(await names(app)).includes('api_bootstrap'), (await names(app)).join(','));
      assert.deepEqual(await monthCalls(app), ['2026-05']);
      assert.equal(await page.evaluate(() => window.__locationCalls || 0), 0, 'the page came inline too');
      assert.equal((await page.textContent('#side-user .side-user-email')).trim(), ACCOUNTS.OWNER);
      assert.equal(await page.$$eval('[data-kpi]', (n) => n.length), 4);
      assert.deepEqual(app.errors, []);

      // Every later bootstrap asks the server (the inline snapshot answers the first one only).
      await page.evaluate(() => window.State.refreshBootstrap({ useInline: true }));
      await app.waitIdle();
      assert.equal((await names(app)).filter((n) => n === 'api_bootstrap').length, 1);
      assert.deepEqual(app.errors, []);
    });
  });

  test('a lecteur boots from the inline bootstrap with the lecteur view', async () => {
    await withApp({ boot: true, email: ACCOUNTS.LECTEUR }, async (app) => {
      const { page } = app;
      assert.ok(!(await names(app)).includes('api_bootstrap'));
      assert.match((await page.textContent('#side-user .side-user-role')).trim(), /^Lecteur\b/);
      assert.equal(await page.$('#sidebar .nav-link[data-page="settings"]'), null);
      assert.equal(await page.$('#link-source'), null);
      assert.deepEqual(app.errors, []);
    });
  });

  test('nothing inline (\'\'): the client calls api_bootstrap, as before', async () => {
    await withApp({ boot: '' }, async (app) => {
      assert.match(fs.readFileSync(app.file, 'utf8'), /<script type="application\/json" id="boot-data"><\/script>/);
      assert.deepEqual((await names(app)).slice(0, 2), ['api_bootstrap', 'api_getMonthData']);
      assert.deepEqual(app.errors, []);
    });
  });

  test('a refused visitor gets nothing inline, then « Accès refusé » through api_bootstrap', async () => {
    await withApp({ boot: true, email: 'stranger@decathlon.com', readySelector: '.page-denied' }, async (app) => {
      const { page } = app;
      assert.match(fs.readFileSync(app.file, 'utf8'), /<script type="application\/json" id="boot-data"><\/script>/);
      assert.match(await page.textContent('#denied-message'), /stranger@decathlon\.com/);
      assert.deepEqual(await names(app), ['api_bootstrap']);
      assert.deepEqual(app.errors, []);
    });
  });

  test('escaped data comes back intact (</script>, <!--, quotes, backtick, U+2028)', async () => {
    const env = JSON.parse(bootstrapEnvelope({}));
    const title = 'Suivi </script><!-- `x` \'q\' "d" & <b>\u2028fin';
    env.data.sourceTitle = title;
    await withApp({ boot: JSON.stringify(env) }, async (app) => {
      assert.equal(await app.page.evaluate(() => window.State.get().sourceTitle), title);
      assert.ok(!(await names(app)).includes('api_bootstrap'));
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('inline page', () => {
  test('?page= rendered by doGet opens that page without google.script.url.getLocation', async () => {
    await withApp({ boot: true, inlinePage: 'postes', readySelector: '#main .page[data-page="postes"]' }, async (app) => {
      assert.equal(await app.page.evaluate(() => window.State.get().page), 'postes');
      assert.equal(await app.page.evaluate(() => window.__locationCalls || 0), 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('an unknown ?page= (null inline) lands on the dashboard, still without getLocation', async () => {
    await withApp({ boot: true, inlinePage: 'nope' }, async (app) => {
      assert.equal(await app.page.evaluate(() => window.State.get().page), 'dashboard');
      assert.equal(await app.page.evaluate(() => window.__locationCalls || 0), 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('admin-only page asked by a lecteur: the dashboard is shown', async () => {
    await withApp({ boot: true, inlinePage: 'settings', email: ACCOUNTS.LECTEUR }, async (app) => {
      assert.ok(await app.page.$('#main .page[data-page="dashboard"]'));
      assert.deepEqual(app.errors, []);
    });
  });

  test('nothing inline: the page comes from google.script.url.getLocation (fallback)', async () => {
    await withApp({ readySelector: '#main .page[data-page="apps"]',
      beforeGoto: (page) => page.addInitScript(() => { window.__mockLocation = { page: 'apps' }; }) }, async (app) => {
      assert.equal(await app.page.evaluate(() => window.__locationCalls), 1);
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('landing data in parallel', () => {
  for (const boot of [true, undefined]) {
    const how = boot ? 'inline bootstrap' : 'api_bootstrap';
    test(`saved period (${how}): the first month, the latest one and the history are all requested behind the splash`, async () => {
      await withApp({ boot, prefs: { period: 'all' }, delayMs: 800, readySelector: '#splash', idle: false }, async (app) => {
        const { page } = app;
        await page.waitForFunction(() => window.__calls.some((c) => c.name === 'api_getTimeline'), null, { timeout: 5000 });
        // Still behind the splash: nothing has been answered past the bootstrap.
        assert.equal(await page.$eval('#splash', (n) => !n.hidden && !n.classList.contains('is-done')), true);
        const expected = ['api_getMonthData', 'api_getMonthData', 'api_getTimeline'];
        assert.deepEqual(await names(app), boot ? expected : ['api_bootstrap'].concat(expected));
        assert.deepEqual(await monthCalls(app), ['2026-05', '2026-04'], 'latest month first');

        await page.waitForSelector('#main .page[data-page="dashboard"]');
        await app.waitIdle();
        assert.equal(await page.getAttribute('#dashboard-caption', 'data-from'), '2026-04');
        // The page picked up the requests in flight: each one was made once.
        assert.deepEqual(await monthCalls(app), ['2026-05', '2026-04']);
        assert.equal((await names(app)).filter((n) => n === 'api_getTimeline').length, 1);
        assert.equal(await page.$('#dashboard-body .skeleton'), null);
        assert.deepEqual(app.errors, []);
      });
    });
  }

  test('saved period on the timeline page: the history is requested with the month, not the first month', async () => {
    await withApp({ boot: true, inlinePage: 'timeline', prefs: { period: 'all' }, readySelector: '#main .page[data-page="timeline"]' }, async (app) => {
      assert.deepEqual(await monthCalls(app), ['2026-05']);
      assert.equal((await names(app)).filter((n) => n === 'api_getTimeline').length, 1);
      assert.deepEqual(app.errors, []);
    });
  });

  test('one month selected: no extra request at boot', async () => {
    await withApp({ boot: true }, async (app) => {
      assert.deepEqual(await names(app), ['api_getMonthData']);
      assert.deepEqual(app.errors, []);
    });
  });

  test('a failed history prefetch does not stop the dashboard (the sparklines are optional)', async () => {
    await withApp({ boot: true, prefs: { period: 'all' }, failNext: { api_getTimeline: { code: 'INTERNAL', message: 'x' } } }, async (app) => {
      assert.ok(await app.page.$('#dashboard-body [data-kpi]'));
      assert.equal(await app.page.$('#dashboard-body .alert-error'), null);
      assert.deepEqual(app.errors, []);
    });
  });

  test('a failed first-month prefetch is shown by the page (no second request), « Réessayer » loads it', async () => {
    await withApp({ boot: true, prefs: { period: 'all' }, readySelector: '#dashboard-body .alert-error',
      failNext: { 'api_getMonthData:2026-04': { code: 'INTERNAL', message: 'Classeur indisponible.' } } }, async (app) => {
      const { page } = app;
      assert.match(await page.textContent('#dashboard-body .alert-error'), /Classeur indisponible/);
      assert.deepEqual(await monthCalls(app), ['2026-05', '2026-04'], 'the page reused the prefetch failure');
      await page.click('#dashboard-body .error-retry');
      await page.waitForSelector('#dashboard-body [data-kpi]');
      await app.waitIdle();
      assert.deepEqual((await monthCalls(app)).filter((m) => m === '2026-04').length, 2);
      assert.deepEqual(unexpected(app.errors), []);
    });
  });
});

describe('Plotly without blocking', () => {
  test('Plotly late: the splash and the KPIs come first, the charts once it has loaded', async () => {
    await withApp({ boot: true, plotly: { delayMs: 2500 }, idle: false }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#splash', { state: 'hidden' });
      assert.equal(await page.evaluate(() => typeof window.Plotly), 'undefined', 'Plotly still on its way');
      assert.equal(await page.$$eval('[data-kpi]', (n) => n.length), 4);
      assert.equal(await page.$$eval('#main .chart-box', (n) => n.length), CHARTS.length);
      assert.doesNotMatch(await page.textContent('#main'), /Graphique indisponible/);

      await app.waitIdle();   // waits for Charts.ready()
      const drawn = (await app.plots()).map((p) => p.id);
      for (const id of CHARTS) assert.ok(drawn.includes(id), id + ' drawn');
      assert.doesNotMatch(await page.textContent('#main'), /Graphique indisponible/);
      // The script the app adds itself goes through the same CDN URL (intercepted here).
      assert.ok(app.plotlyRequests().length >= 1);
      assert.ok(app.plotlyRequests().every((u) => u === 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.35.3/plotly.min.js'));
      assert.equal(await page.$$eval('script[src*="plotly"]', (n) => n.length), 1);
      assert.deepEqual(app.errors, []);
    });
  });

  test('Plotly late and the page left meanwhile: nothing is drawn into the old page', async () => {
    await withApp({ boot: true, plotly: { delayMs: 2000 }, idle: false }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#main .chart-box');
      await page.evaluate(() => window.App.go('postes'));
      await page.waitForSelector('#main .page[data-page="postes"]');
      await app.waitIdle();
      assert.deepEqual((await app.plots()).map((p) => p.id), []);
      await app.goto('dashboard');
      const drawn = (await app.plots()).map((p) => p.id);
      for (const id of CHARTS) assert.ok(drawn.includes(id), id + ' drawn on the new dashboard');
      assert.deepEqual(app.errors, []);
    });
  });

  test('Plotly failing: « Graphique indisponible » in every chart, the rest of the page works, no retry', async () => {
    await withApp({ boot: true, plotly: { fail: true } }, async (app) => {
      const { page } = app;
      assert.equal(await page.$$eval('[data-kpi]', (n) => n.length), 4);
      assert.deepEqual(await page.$$eval('#main .chart-box', (bs) => bs.map((b) => b.textContent.trim())),
        CHARTS.map(() => 'Graphique indisponible'));
      const requests = app.plotlyRequests().length;
      await app.goto('timeline');
      assert.ok(await page.$$eval('#main .chart-box', (bs) => bs.length > 0 &&
        bs.every((b) => b.textContent.trim() === 'Graphique indisponible')));
      assert.equal(app.plotlyRequests().length, requests, 'the failure is remembered');
      assert.deepEqual(unexpected(app.errors), []);
    });
  });
});
