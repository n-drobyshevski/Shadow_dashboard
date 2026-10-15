'use strict';
/**
 * Security pins (docs/SECURITY.md): static checks that run with `npm test`, without Semgrep. They fail
 * when a change widens the attack surface on purpose or by accident; widening it then means updating
 * this file and docs/SECURITY.md in the same change.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SRC_DIR } = require('../helpers/gasSandbox');
const { extract } = require('../../security/extract-client-js');

const ROOT = path.resolve(__dirname, '..', '..');
const PLOTLY_CACHE = path.join(ROOT, '.artifacts', 'plotly.min.js');

const read = (f) => fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
const files = (ext) => fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(ext)).sort();

/** Code without comments, so prose about a sink does not count as the sink. */
function code(js) {
  return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

const clientJs = () => files('.html').map((f) => ({ f, js: code(extract(read(f))) }));
const serverJs = () => files('.js').map((f) => ({ f, js: code(read(f)) }));

test('client: no HTML parsing sinks or code built from strings (every node goes through UI.el / textContent)', () => {
  const SINKS = /\.(innerHTML|outerHTML)\s*=[^=]|insertAdjacentHTML\s*\(|document\.write(ln)?\s*\(|createContextualFragment\s*\(|parseFromString\s*\(|\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*['"`]/;
  for (const { f, js } of clientJs()) {
    const hit = js.split('\n').findIndex((l) => SINKS.test(l));
    assert.equal(hit, -1, f + ':' + (hit + 1) + ' uses an HTML / code sink');
  }
});

test('client: window.open always passes noopener; every target=_blank link goes through UI.extLink', () => {
  for (const { f, js } of clientJs()) {
    for (const m of js.matchAll(/window\.open\s*\(([^)]*)\)/g)) assert.match(m[1], /noopener/, f + ': ' + m[0]);
    const blank = js.split('\n').filter((l) => /_blank/.test(l));
    for (const l of blank) assert.match(l, /noopener/, f + ': target _blank without rel noopener: ' + l.trim());
  }
});

test('index.html: unescaped scriptlets (<?!= ?>) only print the known template helpers', () => {
  const html = read('index.html');
  const scriptlets = [...html.matchAll(/<\?([\s\S]*?)\?>/g)].map((m) => m[1].trim());
  const ALLOWED = /^!= (include\('[a-z_]+'\)|coreScript\(\)|inlineBoot_\(\)|inlinePage_\(page\))$/;
  assert.ok(scriptlets.length > 0);
  for (const s of scriptlets) assert.match(s, ALLOWED, 'unexpected scriptlet <?' + s + '?>');
  for (const f of files('.html').filter((n) => n !== 'index.html')) {
    assert.doesNotMatch(read(f), /<\?/, f + ' is included raw: scriptlets would not run (and must not be added)');
  }
});

test('third-party scripts: only the pinned Plotly build, with the same Subresource Integrity hash everywhere', () => {
  const urls = new Set();
  for (const f of files('.html')) {
    for (const m of read(f).matchAll(/https:\/\/[^\s'"<>)]+\.js\b/g)) urls.add(m[0]);
  }
  assert.deepEqual([...urls], ['https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.35.3/plotly.min.js']);

  const index = read('index.html');
  const preload = /<link rel="preload" href="[^"]*plotly[^"]*" as="script" integrity="(sha512-[^"]+)" crossorigin="anonymous">/.exec(index);
  assert.ok(preload, 'the Plotly preload carries integrity + crossorigin (else the browser downloads it twice)');
  const charts = read('js_charts.html');
  const sri = /var PLOTLY_SRI = '(sha512-[^']+)'/.exec(charts);
  assert.ok(sri, 'js_charts.html defines PLOTLY_SRI');
  assert.equal(sri[1], preload[1]);
  assert.match(charts, /script\.integrity = PLOTLY_SRI;/);
  assert.match(charts, /script\.crossOrigin = 'anonymous';/);
  assert.doesNotMatch(index, /<script[^>]+src=/, 'no blocking third-party <script src> in index.html');

  if (fs.existsSync(PLOTLY_CACHE)) {
    const digest = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(PLOTLY_CACHE)).digest('base64');
    assert.equal(digest, sri[1], '.artifacts/plotly.min.js (the real build) matches PLOTLY_SRI');
  }
});

test('server: no outbound requests, no OAuth token handling, no frame embedding by other sites', () => {
  for (const { f, js } of serverJs()) {
    assert.doesNotMatch(js, /UrlFetchApp|getOAuthToken|DriveApp|MailApp|GmailApp/, f + ': new outbound surface');
    assert.doesNotMatch(js, /XFrameOptionsMode\.ALLOWALL/, f);
    assert.doesNotMatch(js, /\beval\s*\(|new\s+Function\s*\(/, f);
  }
});

test('server: public entry points other than api_* refuse browser calls (setup) or ignore them (syncHourly)', () => {
  const src = code(read('Code.js'));
  assert.match(src, /function setup\(\) \{\s*var active = Access\.activeEmail\(\);\s*if \(!active \|\| active !== Access\.ownerEmail\(\)\)/);
  assert.match(src, /function syncHourly\(e\) \{[\s\S]*?if \(!Sync\.isTriggerEvent\(e\)\) return;/);
});

test('manifest: access and scopes are the reviewed ones', () => {
  const manifest = JSON.parse(read('appsscript.json'));
  assert.deepEqual(manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'DOMAIN' },
    'ANYONE / ANYONE_ANONYMOUS would expose the app (running as the deployer) outside the domain');
  assert.deepEqual(manifest.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/groups',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
  ], 'a new scope needs a review (docs/SECURITY.md)');
});
