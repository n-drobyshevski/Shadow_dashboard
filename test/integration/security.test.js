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

test('supply chain: CI tools pinned (actions by SHA, Semgrep and its deps by hash), Dependabot cooldown, README uses npm ci', () => {
  const repo = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const wfDir = path.join(ROOT, '.github', 'workflows');
  for (const f of fs.readdirSync(wfDir)) {
    for (const m of repo('.github/workflows/' + f).matchAll(/uses:\s*(\S+)/g)) {
      assert.match(m[1], /@[0-9a-f]{40}$/, f + ': action not pinned by commit SHA: ' + m[1]);
    }
  }
  const pips = repo('.github/workflows/security.yml').split('\n').filter((l) => /\bpip3? install\b/.test(l) && !/^\s*#/.test(l));
  assert.ok(pips.length > 0);
  for (const l of pips) assert.match(l, /--require-hashes --no-deps --only-binary :all: -r security\/requirements-semgrep\.txt/, 'unhashed pip install: ' + l.trim());

  // One block per package: "name==version \" then its --hash lines.
  const blocks = repo('security/requirements-semgrep.txt').split(/\n(?=[^\s#])/).filter((b) => /^[^\s#]/.test(b));
  assert.ok(blocks.length > 1);
  for (const b of blocks) {
    assert.match(b, /^[A-Za-z0-9._-]+==[^\s;]+/, 'not pinned: ' + b.split('\n')[0]);
    assert.match(b, /--hash=sha256:[0-9a-f]{64}/, 'no hash: ' + b.split('\n')[0]);
  }
  const want = repo('security/requirements-semgrep.in').match(/^semgrep==(\S+)$/m);
  assert.ok(want && blocks.some((b) => b.startsWith('semgrep==' + want[1] + ' ')), 'requirements-semgrep.txt is stale: regenerate it from the .in');

  const dependabot = repo('.github/dependabot.yml');
  const ecosystems = dependabot.match(/package-ecosystem:/g).length;
  assert.equal((dependabot.match(/^\s+default-days: 7$/gm) || []).length, ecosystems, 'every ecosystem has a 7-day cooldown');
  assert.match(dependabot, /exclude-patterns: \['@google\/clasp'\]/, 'clasp updates come in their own PR');

  const readme = repo('README.md');
  assert.doesNotMatch(readme, /\bnpm install\b/, 'the deploy toolchain is installed with npm ci (lockfile-exact)');
  assert.match(readme, /\bnpm ci\b/);
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
