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
 * Control helpers (custom dropdowns, no native <select>):
 *   chooseOption(page, triggerSelector, labelOrValue)    single dropdown / combobox
 *   chooseOptions(page, triggerSelector, [labels])        multiple selection (exact set)
 *   optionLabels(page, triggerSelector, {values?})        option labels (or values)
 *   dropdownValue(page, triggerSelector)                  current value (trigger.value)
 *   typeDate(page, inputSelector, 'DD/MM/YYYY')           UI.dateField input + blur
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
 *          delayMs?:number, email?:string, readySelector?:string, failNext?:object,
 *          beforeGoto?:(page)=>Promise, idle?:boolean, prefs?:object}} [options]
 *   email: visitor seen by the mock (default the owner, admin; LECTEUR / ADMIN2 below; any other
 *   address has no access; '' = identity not passed). readySelector overrides what openApp waits for
 *   (e.g. '.page-denied'). failNext: forced failures armed before boot ({api_bootstrap: {transport:true}}).
 *   currentMonth / sync: see buildMockScript (the month the sync follows, sync status overrides).
 *   beforeGoto(page): runs before the page loads (e.g. page.clock.install()). idle:false skips the final
 *   waitIdle (needed with a fake clock).
 */
async function openApp({ empty = false, configured = true, page: pageId = 'dashboard',
  viewport = { width: 1400, height: 900 }, delayMs = 0, email, readySelector, failNext, beforeGoto, currentMonth, sync,
  idle = true, prefs } = {}) {
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

  const html = renderIndex({ inject: '<script>' + buildMockScript({ empty, configured, delayMs, email, failNext, prefs, currentMonth, sync }) + '</script>' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-e2e-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  if (beforeGoto) await beforeGoto(page);
  await page.goto('file://' + file);

  if (readySelector) {
    await page.waitForSelector(readySelector, { timeout: 15000 });
  } else if (configured) {
    await page.waitForSelector('#main .page[data-page="dashboard"]', { timeout: 15000 });
  } else {
    await page.waitForSelector('#config-source', { timeout: 15000 });
  }
  if (idle) await waitIdle(page);

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
  if (configured && !readySelector && pageId && pageId !== 'dashboard') await app.goto(pageId);
  return app;
}

// ---------------------------------------------------------------------------------------------- controls
// The app has no native <select>: dropdowns are UI.dropdown (js_controls.html). The trigger is a
// <button id=…> (or an <input role=combobox> for comboboxes); the listbox is portalled to <body> while
// open, with id = aria-controls of the trigger. page.selectOption / page.check do not apply any more.

/** Waits for the listbox of `trigger` (a Locator) and returns its id. Opens it when it is closed. */
async function openListbox(page, triggerSelector) {
  const trigger = page.locator(triggerSelector).first();
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    if ((await trigger.evaluate((n) => n.tagName)) === 'INPUT') {
      await trigger.focus();
      await trigger.press('ArrowDown');
    } else {
      await trigger.click();
    }
  }
  const listId = await trigger.getAttribute('aria-controls');
  await page.waitForSelector(`[id="${listId}"][role=listbox]`, { state: 'visible' });
  return listId;
}

/** Index of the option whose label (or, failing that, value) is exactly `text`; -1 when absent. */
function findOptionIndex(page, listId, text) {
  return page.evaluate(({ listId, text }) => {
    const rows = Array.from(document.getElementById(listId).querySelectorAll('[role=option]'));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    let i = rows.findIndex((r) => norm((r.querySelector('.dd-option-label') || r).textContent) === norm(text));
    if (i < 0) i = rows.findIndex((r) => r.dataset.value === text);
    return i;
  }, { listId, text });
}

/**
 * Picks one option of a dropdown: opens it (click on the trigger) when closed, then clicks the option
 * whose label — or value — is exactly `optionLabel`. On a combobox input the text is typed instead and
 * the matching suggestion (or the « Utiliser « … » » row) is clicked.
 *   await chooseOption(page, '#filter-equipe', 'Labo Textile');
 */
async function chooseOption(page, triggerSelector, optionLabel) {
  const trigger = page.locator(triggerSelector).first();
  if ((await trigger.evaluate((n) => n.tagName)) === 'INPUT') {
    await trigger.fill(String(optionLabel));
    const listId = await trigger.getAttribute('aria-controls');
    await page.waitForSelector(`[id="${listId}"][role=listbox]`, { state: 'visible' });
    const i = await findOptionIndex(page, listId, optionLabel);
    const custom = page.locator(`[id="${listId}"] [role=option].dd-option-custom`);
    if (i >= 0) await page.locator(`[id="${listId}"] [role=option]`).nth(i).click();
    else if (await custom.count()) await custom.click();
    else throw new Error(`chooseOption: no option « ${optionLabel} » in ${triggerSelector}`);
    return;
  }
  const listId = await openListbox(page, triggerSelector);
  const i = await findOptionIndex(page, listId, optionLabel);
  if (i < 0) {
    const labels = await page.$$eval(`[id="${listId}"] [role=option]`, (rs) => rs.map((r) => r.textContent.trim()));
    throw new Error(`chooseOption: no option « ${optionLabel} » in ${triggerSelector} (${labels.join(' | ')})`);
  }
  await page.locator(`[id="${listId}"] [role=option]`).nth(i).click();
  await page.waitForSelector(`[id="${listId}"]`, { state: 'detached' });
}

/**
 * Multiple-selection dropdown: makes the selection exactly `labels` (labels or values), toggling
 * options with clicks, then closes the list with Escape.
 *   await chooseOptions(page, '#filter-equipe .dd-trigger', ['Labo Textile']);
 */
async function chooseOptions(page, triggerSelector, labels) {
  const listId = await openListbox(page, triggerSelector);
  const want = new Set(labels.map(String));
  const rows = page.locator(`[id="${listId}"] [role=option]`);
  const n = await rows.count();
  for (const text of want) {
    if ((await findOptionIndex(page, listId, text)) < 0) throw new Error(`chooseOptions: no option « ${text} »`);
  }
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const label = ((await row.locator('.dd-option-label').textContent()) || '').trim();
    const value = await row.getAttribute('data-value');
    const selected = (await row.getAttribute('aria-selected')) === 'true';
    const wanted = want.has(label) || want.has(value);
    if (selected !== wanted) await row.click();
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector(`[id="${listId}"]`, { state: 'detached' });
}

/** Labels (or values with {values:true}) of the options of a dropdown; the list is closed again. */
async function optionLabels(page, triggerSelector, { values = false } = {}) {
  const listId = await openListbox(page, triggerSelector);
  const out = await page.$$eval(`[id="${listId}"] [role=option]`, (rs, values) => rs.map((r) => (values ?
    r.dataset.value : (r.querySelector('.dd-option-label') || r).textContent.trim())), values);
  await page.keyboard.press('Escape');
  await page.waitForSelector(`[id="${listId}"]`, { state: 'detached' });
  return out;
}

/** Current value of a dropdown trigger (string, or array for multiple selection). */
function dropdownValue(page, triggerSelector) {
  return page.$eval(triggerSelector, (n) => n.value);
}

/** Types a date into a UI.dateField input ('DD/MM/YYYY') and leaves the field (commit + validation). */
async function typeDate(page, selector, value) {
  const input = page.locator(selector).first();
  await input.fill(String(value));
  await input.evaluate((n) => n.blur());
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

/** Mock accounts (test/fixtures/mockRun.js). */
const ACCOUNTS = { OWNER: 'owner@decathlon.com', LECTEUR: 'lea.reader@decathlon.com', ADMIN2: 'sam.admin@decathlon.com',
  GROUP_MEMBER: 'marc.labo@decathlon.com' /* lecteur through labo-industry@decathlon.com */ };

/**
 * Selects a period with the app bar panel: opens it, clicks `from` then `to` on the month grid (moving the
 * year with ‹ › when needed) and applies. choosePeriod(page, '2026-04') = that month alone.
 */
async function choosePeriod(page, from, to) {
  if (!(await page.$('#period-panel'))) await page.click('#period-button');
  await page.waitForSelector('#period-panel');
  for (const m of to && to !== from ? [from, to] : [from, from]) {
    for (let i = 0; i < 20; i++) {
      const year = Number((await page.textContent('#period-year')).trim());
      const want = Number(m.slice(0, 4));
      if (year === want) break;
      await page.click(year < want ? '#period-year-next' : '#period-year-prev');
    }
    await page.click(`#period-month-${m}`);
  }
  await page.click('#period-apply');
  await page.waitForSelector('#period-popover', { state: 'detached' });
}

/** {from, to} shown by the period button. */
async function periodValue(page) {
  return page.$eval('#period-button', (b) => ({ from: b.dataset.from, to: b.dataset.to }));
}

module.exports = { ACCOUNTS, openApp, screenshot, waitIdle, chooseOption, chooseOptions, optionLabels, dropdownValue, typeDate,
  openListbox, choosePeriod, periodValue };

if (require.main === module) {
  // node test/e2e/harness.js <pageId> <out.png>
  const [pageId = 'dashboard', out = 'screenshot.png'] = process.argv.slice(2);
  screenshot(pageId, out).then((p) => console.log('Screenshot written to ' + p), (e) => {
    console.error(e);
    process.exit(1);
  });
}
