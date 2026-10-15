'use strict';
/**
 * Playwright harness for the e2e smoke tests.
 *
 *   const { openApp } = require('./harness');
 *   const app = await openApp({ page: 'postes' });
 *   ... app.page (Playwright Page), app.errors (console errors + page errors), await app.calls() ...
 *   await app.close();
 *
 * The app is rendered with test/helpers/render.js, google.script.run is mocked with
 * test/fixtures/mockRun.js, and the page is loaded from a file:// URL in a temp dir. The Plotly CDN
 * request is answered with the cached real build (.artifacts/plotly.min.js) when present, else with a
 * stub. In both cases Plotly.newPlot/react calls are recorded on window.__plots = [{fn, id, data}].
 * Google Fonts requests are answered from .artifacts/fonts/ (fonts.css for fonts.googleapis.com/css2,
 * fonts.gstatic.com files by their path with '/' replaced by '_'), so screenshots use the real IBM Plex
 * faces; when the cache is missing they are aborted and the system fallbacks are used.
 *
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { renderIndex } = require('../helpers/render');
const { buildMockScript } = require('../fixtures/mockRun');

const ROOT = path.resolve(__dirname, '..', '..');
const PLOTLY_CACHE = path.join(ROOT, '.artifacts', 'plotly.min.js');
const PLOTLY_URL_GLOB = 'https://cdnjs.cloudflare.com/**/plotly*.js';
const FONTS_DIR = path.join(ROOT, '.artifacts', 'fonts');
const FALLBACK_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** Appended to the real Plotly build: records calls without changing behaviour. */
const RECORDER = `
;(function () {
  window.__plots = window.__plots || [];
  if (!window.Plotly) return;
  ['newPlot', 'react'].forEach(function (fn) {
    var orig = window.Plotly[fn];
    window.Plotly[fn] = function (el, data) {
      window.__plots.push({ fn: fn, id: el && el.id, data: JSON.parse(JSON.stringify(data || [], function (k, v) {
        return typeof v === 'function' ? undefined : v; })) });
      return orig.apply(this, arguments);
    };
  });
})();`;

/** Used when the real build is not cached: records calls, draws a placeholder. */
const STUB = `
window.__plots = [];
window.Plotly = {
  __stub: true,
  newPlot: function (el, data) { return window.Plotly.react(el, data); },
  react: function (el, data) {
    window.__plots.push({ fn: 'react', id: el && el.id, data: JSON.parse(JSON.stringify(data || [])) });
    el.classList.add('js-plotly-plot');
    el.setAttribute('data-stub-plot', String((data || []).length));
    return Promise.resolve(el);
  },
  purge: function (el) { if (el) el.classList.remove('js-plotly-plot'); }
};`;

/** Serves a cached Google Fonts response, or null when it is not cached. */
function fontResponse(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'fonts.googleapis.com' && u.pathname.startsWith('/css')) {
      const file = path.join(FONTS_DIR, 'fonts.css');
      if (!fs.existsSync(file)) return null;
      return { status: 200, contentType: 'text/css; charset=utf-8', body: fs.readFileSync(file),
        headers: { 'Access-Control-Allow-Origin': '*' } };
    }
    if (u.hostname === 'fonts.gstatic.com') {
      const file = path.join(FONTS_DIR, u.pathname.replace(/^\//, '').replace(/\//g, '_'));
      if (!file.startsWith(FONTS_DIR + path.sep) || !fs.existsSync(file)) return null;
      return { status: 200, contentType: 'font/woff2', body: fs.readFileSync(file),
        headers: { 'Access-Control-Allow-Origin': '*' } };
    }
  } catch (e) { /* fall through */ }
  return null;
}

let plotlyBody = null;
function plotlyScript() {
  if (plotlyBody === null) {
    plotlyBody = fs.existsSync(PLOTLY_CACHE) ? fs.readFileSync(PLOTLY_CACHE, 'utf8') + RECORDER : STUB;
  }
  return plotlyBody;
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (err) {
    if (!fs.existsSync(FALLBACK_CHROME)) throw err;
    return chromium.launch({ executablePath: FALLBACK_CHROME });
  }
}

/** Waits until every mocked server call has been answered and the DOM had a chance to settle. */
async function waitIdle(page, timeout = 10000) {
  await page.waitForFunction(() => window.__pending === 0, null, { timeout });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
  await page.waitForFunction(() => window.__pending === 0, null, { timeout });
}

/**
 * @param {{empty?:boolean, configured?:boolean, page?:string, viewport?:{width:number,height:number},
 *          delayMs?:number}} [options]
 */
async function openApp({ empty = false, configured = true, page: pageId = 'dashboard',
  viewport = { width: 1400, height: 900 }, delayMs = 0 } = {}) {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
  page.on('pageerror', (err) => errors.push('pageerror: ' + (err && err.stack ? err.stack : String(err))));

  await page.route(PLOTLY_URL_GLOB, (route) => route.fulfill({
    status: 200, contentType: 'application/javascript; charset=utf-8', body: plotlyScript(),
  }));
  // Fonts come from the local cache; any other network request would hang or fail in the sandbox:
  // block it explicitly.
  await page.route(/^https?:\/\//, (route) => {
    const url = route.request().url();
    if (/cdnjs\.cloudflare\.com\/.*plotly/.test(url)) return route.fallback();
    const font = fontResponse(url);
    if (font) return route.fulfill(font);
    return route.abort();
  });

  const html = renderIndex({ inject: '<script>' + buildMockScript({ empty, configured, delayMs }) + '</script>' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-e2e-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  await page.goto('file://' + file);

  if (configured) {
    await page.waitForSelector('#main .page[data-page="dashboard"]', { timeout: 15000 });
  } else {
    await page.waitForSelector('#config-source', { timeout: 15000 });
  }
  await waitIdle(page);

  const app = {
    browser,
    context,
    page,
    errors,
    file,
    calls: () => page.evaluate(() => window.__calls),
    plots: () => page.evaluate(() => window.__plots || []),
    waitIdle: () => waitIdle(page),
    async goto(id) {
      await page.evaluate((p) => window.App.go(p), id);
      await page.waitForSelector(`#main .page[data-page="${id}"]`, { timeout: 10000 });
      await waitIdle(page);
    },
    async close() {
      await browser.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  if (configured && pageId && pageId !== 'dashboard') await app.goto(pageId);
  return app;
}

/** Opens the app on `pageId`, waits for charts to settle and writes a full-page PNG to `outPath`. */
async function screenshot(pageId, outPath, options = {}) {
  const app = await openApp({ ...options, page: pageId });
  try {
    await app.page.waitForTimeout(400);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    await app.page.screenshot({ path: outPath, fullPage: true });
    return outPath;
  } finally {
    await app.close();
  }
}

module.exports = { openApp, screenshot, waitIdle };

if (require.main === module) {
  // node test/e2e/harness.js <pageId> <out.png>
  const [pageId = 'dashboard', out = 'screenshot.png'] = process.argv.slice(2);
  screenshot(pageId, out).then((p) => console.log('Screenshot written to ' + p), (e) => {
    console.error(e);
    process.exit(1);
  });
}
