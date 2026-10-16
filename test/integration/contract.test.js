'use strict';
/**
 * Contract tests: the public server surface matches docs/API.md §3 exactly, in the GAS sandbox,
 * in the browser mock (test/fixtures/mockRun.js) and in the source files themselves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadGas, SRC_DIR } = require('../helpers/gasSandbox');
const { createGasEnv } = require('../helpers/gasFakes');

const ROOT = path.resolve(__dirname, '..', '..');
const API_MD = path.join(ROOT, 'docs', 'API.md');
const MOCK_RUN = path.join(ROOT, 'test', 'fixtures', 'mockRun.js');

/** Globals injected by the sandbox (not defined by src/*.js). */
const INJECTED = ['SpreadsheetApp', 'PropertiesService', 'LockService', 'Utilities', 'HtmlService', 'Logger', 'Session', 'GroupsApp', 'CacheService', 'ScriptApp', 'console', 'Date',
  'api_importMonth' /* test-only stand-in, see gasSandbox.js */];
/** Public non-api functions allowed by docs/API.md §0, plus the Core factory (shared with the client). */
const ALLOWED_PUBLIC = ['doGet', 'include', 'coreScript', 'setup', 'syncHourly', 'CoreFactory_'];
/** Module objects of docs/API.md §0 "Files and ownership". */
const MODULES = ['Core', 'Config', 'Access', 'Store', 'Importer', 'Sync', 'Perf'];

/** The api_* names of the "complete list" paragraph of docs/API.md §3. */
function contractApiNames() {
  const md = fs.readFileSync(API_MD, 'utf8');
  const start = md.indexOf('The **complete list**');
  assert.ok(start >= 0, 'complete list paragraph not found in docs/API.md');
  const end = md.indexOf('\n\n', start);
  const paragraph = md.slice(start, end < 0 ? undefined : end);
  return [...new Set(paragraph.match(/api_\w+/g) || [])].sort();
}

/** Own globals defined by src/*.js in a loaded sandbox, split into functions and other values. */
function sandboxGlobals() {
  const { ctx } = loadGas();
  const names = Object.getOwnPropertyNames(ctx).filter((n) => !INJECTED.includes(n));
  return {
    ctx,
    functions: names.filter((n) => typeof ctx[n] === 'function').sort(),
    values: names.filter((n) => typeof ctx[n] !== 'function').sort(),
  };
}

function srcFiles() {
  return fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
}

/** Source without comments (rough, good enough for identifier scans). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ----------------------------------------------------------------------------------------------

test('docs/API.md lists 38 distinct api_* functions', () => {
  const names = contractApiNames();
  assert.equal(names.length, 38, names.join(', '));
});

test('sandbox api_* globals == docs/API.md complete list', () => {
  const { functions } = sandboxGlobals();
  const api = functions.filter((n) => /^api_/.test(n));
  assert.deepEqual(api, contractApiNames());
});

test('no other public top-level function besides doGet/include/coreScript/setup/syncHourly/api_*/CoreFactory_', () => {
  const { functions, values } = sandboxGlobals();
  const unexpected = functions.filter((n) => !/^api_/.test(n) && !/_$/.test(n) && !ALLOWED_PUBLIC.includes(n));
  assert.deepEqual(unexpected, [], 'public functions not in the contract');
  for (const fn of ALLOWED_PUBLIC) assert.ok(functions.includes(fn), fn + ' missing');
  // Non-function globals: the modules of the contract, or private (trailing underscore).
  const unexpectedValues = values.filter((n) => !/_$/.test(n) && !MODULES.includes(n));
  assert.deepEqual(unexpectedValues, [], 'unexpected public globals');
  for (const m of MODULES) assert.ok(values.includes(m), m + ' missing');
});

test('every api_* takes one JSON string and always returns a JSON envelope string', () => {
  const { ctx } = sandboxGlobals();
  for (const name of contractApiNames()) {
    assert.equal(ctx[name].length, 1, name + ' arity');
    for (const arg of ['{', '[]', JSON.stringify({ month: 'nope', id: 1, updates: 5, changes: 3, record: 2 })]) {
      const out = ctx[name](arg);
      assert.equal(typeof out, 'string', name);
      const res = JSON.parse(out);
      assert.equal(typeof res.ok, 'boolean', name);
      if (!res.ok) assert.ok(['VALIDATION', 'NOT_CONFIGURED', 'NOT_FOUND', 'SOURCE_ERROR'].includes(res.error.code), name + ' ' + res.error.code);
    }
  }
});

test('test/fixtures/mockRun.js implements exactly the contract api_* functions', (t) => {
  if (!fs.existsSync(MOCK_RUN)) {
    t.skip('test/fixtures/mockRun.js does not exist yet');
    return;
  }
  // Prefer the generated browser script; fall back to the file text if the module cannot be loaded
  // (the mock's own tests report that failure — here only the implemented names matter).
  let script = null;
  try {
    const mod = require(MOCK_RUN);
    if (typeof mod.buildMockScript === 'function') script = mod.buildMockScript();
    else if (typeof mod.buildMockScript === 'string') script = mod.buildMockScript;
  } catch (e) {
    t.diagnostic('mockRun.js could not be loaded (' + e.message + '); scanning its source text instead');
  }
  if (typeof script !== 'string') script = fs.readFileSync(MOCK_RUN, 'utf8');
  // Implemented handlers are keys such as `api_getDiff: function` (or shorthand `api_getDiff(`).
  const implemented = [...new Set([...script.matchAll(/\b(api_\w+)\s*(?::\s*function\b|\()/g)].map((m) => m[1]))].sort();
  assert.deepEqual(implemented, contractApiNames());
});

test('src/*.js: no top-level const/let/class, and each file loads on its own (no top-level cross-file calls)', () => {
  for (const f of srcFiles()) {
    const src = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    assert.doesNotMatch(src, /^(const|let|class)\s/m, f + ' has a top-level const/let/class');
    const env = createGasEnv();
    const ctx = vm.createContext({
      SpreadsheetApp: env.SpreadsheetApp, PropertiesService: env.PropertiesService, LockService: env.LockService,
      Utilities: env.Utilities, HtmlService: env.HtmlService, Logger: env.Logger, Session: env.Session,
      GroupsApp: env.GroupsApp, CacheService: env.CacheService, ScriptApp: env.ScriptApp,
      console: env.console, Date,
    });
    assert.doesNotThrow(() => vm.runInContext(src, ctx, { filename: f }), f + ' must load alone');
  }
});

test('src/*.js only use the allowed Apps Script services (Session / GroupsApp / CacheService only in Access.js, ScriptApp only in Sync.js)', () => {
  const forbidden = /\b(DriveApp|UrlFetchApp|MailApp|GmailApp|DocumentApp|AdminDirectory)\s*\./;
  for (const f of srcFiles()) {
    const code = stripComments(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    assert.doesNotMatch(code, forbidden, f);
    if (f !== 'Access.js') assert.doesNotMatch(code, /\b(Session|GroupsApp|CacheService)\s*\./, f + ' must go through Access');
    if (f !== 'Sync.js') assert.doesNotMatch(code, /\bScriptApp\s*\./, f + ' must go through Sync');
  }
});

test('apiWrap_ calls Access.throttle before it reads the Script Properties (Config.get) or checks the role', () => {
  const { ctx } = loadGas();
  const src = stripComments(ctx.apiWrap_.toString());
  const at = src.indexOf('Access.throttle(name)');
  assert.ok(at > 0, 'Access.throttle(name) missing from apiWrap_');
  assert.ok(at < src.indexOf('Config.get('), 'throttle after Config.get');
  assert.ok(at < src.indexOf('Access.requireRole('), 'throttle after the role check');
  assert.equal(typeof ctx.Access.throttle, 'function');
});

test('appsscript.json: domain web app run as the deployer, with exactly the four scopes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'DOMAIN' });
  assert.deepEqual(manifest.oauthScopes.slice().sort(), ['https://www.googleapis.com/auth/groups',
    'https://www.googleapis.com/auth/script.scriptapp', 'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email']);
});
