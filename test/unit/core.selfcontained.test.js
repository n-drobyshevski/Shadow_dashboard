'use strict';
/**
 * Self-containment tests for src/Core.js: CoreFactory_ is serialised with .toString() by
 * coreScript() and evaluated in the browser, and Core.js is concatenated into the Apps Script
 * global scope. These tests prove both usages work without any outside reference.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const data = require('../fixtures/data');
const { buildSourceSpreadsheet } = require('../fixtures/source');

const SRC = path.join(__dirname, '..', '..', 'src', 'Core.js');
const CODE = fs.readFileSync(SRC, 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Loads Core.js the Apps Script way: top-level declarations land on the (global) context. */
function loadGasStyle() {
  const ctx = {};
  vm.runInNewContext(CODE, ctx, { filename: SRC });
  return ctx;
}

test('Core.js defines exactly CoreFactory_ and Core at top level (GAS global scope)', () => {
  const ctx = loadGasStyle();
  assert.deepEqual(Object.keys(ctx).sort(), ['Core', 'CoreFactory_']);
  assert.equal(typeof ctx.CoreFactory_, 'function');
  assert.equal(typeof ctx.Core.parseScore, 'function');
});

test('top-level code uses no const/let/class and only calls CoreFactory_', () => {
  // Strip the factory body; what remains is the top-level code.
  const start = CODE.indexOf('function CoreFactory_()');
  assert.ok(start >= 0);
  const end = CODE.lastIndexOf('\n}\n', CODE.indexOf('var Core = CoreFactory_();'));
  const topLevel = CODE.slice(0, start) + CODE.slice(end + 3);
  const code = topLevel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
  assert.equal(code, 'var Core = CoreFactory_();');
});

test('CoreFactory_.toString() evaluates inside a fresh vm context with no globals', () => {
  const ctx = loadGasStyle();
  const src = '(' + ctx.CoreFactory_.toString() + ')()';
  const sandbox = vm.createContext({}); // no injected globals at all
  const BrowserCore = vm.runInContext(src, sandbox);
  assert.equal(BrowserCore.THRESHOLD, 80);
  assert.equal(BrowserCore.parseScore('30,4%'), 30.4);
  assert.equal(BrowserCore.normKey('Équipe '), 'équipe');
  // A non-trivial pipeline gives the same result as the server-side Core.
  const server = ctx.Core;
  const p = BrowserCore.enrichPostes(data.MONTHS['2026-05'].postes);
  const a = BrowserCore.enrichApplications(data.MONTHS['2026-05'].applications);
  assert.deepEqual(plain(BrowserCore.computeKpis(p, a)),
    plain(server.computeKpis(server.enrichPostes(data.MONTHS['2026-05'].postes),
      server.enrichApplications(data.MONTHS['2026-05'].applications))));
  assert.deepEqual(plain(BrowserCore.diffPostes(data.MONTHS['2026-04'].postes, data.MONTHS['2026-05'].postes)),
    plain(server.diffPostes(data.MONTHS['2026-04'].postes, data.MONTHS['2026-05'].postes)));
  // Source parsing with Dates coming from yet another realm (this Node realm).
  const tab = buildSourceSpreadsheet('2026-04').sheets['Suivi des postes'];
  const res = BrowserCore.rowsToRecords({ display: tab.display, raw: tab.values, keyField: BrowserCore.KEY_POSTE });
  assert.deepEqual(plain(res.records), plain(data.MONTHS['2026-04'].postes));
  // Errors thrown from the sandbox still carry their code.
  assert.throws(() => BrowserCore.rowsToRecords({ display: [['x']], keyField: 'y' }), (e) => e.code === 'SOURCE_ERROR');
});

test('coreScript-style output contains no closing script tag and parses as a classic script', () => {
  const ctx = loadGasStyle();
  const out = 'var Core = (' + ctx.CoreFactory_.toString() + ')();';
  assert.ok(!/<\/script/i.test(out));
  assert.ok(!/<!--/.test(out), 'no HTML comment opener either');
  assert.doesNotThrow(() => new vm.Script(out));
  const sandbox = vm.createContext({});
  vm.runInContext(out, sandbox);
  assert.equal(typeof sandbox.Core.diffApplications, 'function');
});

test('source avoids syntax newer than ES2019 (optional chaining, nullish coalescing, lookbehind)', () => {
  const noComments = CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\?\./.test(noComments.replace(/'[^'\n]*'/g, "''")), 'no optional chaining');
  assert.ok(!/\?\?/.test(noComments), 'no nullish coalescing');
  assert.ok(!/\(\?<[=!]/.test(noComments), 'no regex lookbehind');
  assert.ok(!/\breplaceAll\b/.test(noComments), 'no String#replaceAll (ES2021)');
  assert.ok(!/\b(const|let|class)\s/.test(CODE.slice(0, CODE.indexOf('function CoreFactory_'))));
});

test('Core exposes every contract name and nothing private', () => {
  const ctx = loadGasStyle();
  const expected = ['THRESHOLD', 'KEY_POSTE', 'KEY_APP', 'GENERIC_POSTE_NAME', 'RISK_ORDER', 'RISK_COLORS',
    'COLOR_OK', 'COLOR_KO', 'COLOR_THRESHOLD', 'APP_REQUIRED_FIELDS', 'APP_CUSTOM_FIELDS', 'YES_NO_COLS',
    'POSTE_DIFF_COLS', 'POSTE_TEMPLATE_KEYS', 'COLUMN_REF_ALIASES', 'ACTION_STATUSES', 'ACTION_PRIORITIES',
    'SOURCE_TABS', 'ERROR_CODES', 'FORM_REQUIRED', 'FORM_DATE_HINTS', 'LIMITS',
    'normKey', 'isBlank', 'str', 'parseScore', 'makeError', 'validateMonth', 'currentMonth', 'fmtDDMMYYYY',
    'frToIso', 'isoToFr', 'extractSpreadsheetId', 'escapeFormula', 'findHeaderRow', 'rowsToRecords',
    'parseReferentiel', 'scoreApplication', 'enrichPostes', 'enrichApplications', 'uniqueSorted', 'filterData',
    'computeKpis', 'riskCounts', 'histogramBins', 'buildPosteAppsRelation', 'diffPostes', 'diffApplications',
    'makeGenericPoste', 'mergeCarryOver', 'optionsForColumn', 'snapshotFormColumns', 'checkFormRecord', 'sortMonths', 'previousMonth',
    'PERIOD_PRESETS', 'addMonths', 'monthsInRange', 'presetPeriod', 'scoreEvolution',
    'threshold', 'validateThreshold', 'setThreshold', 'isEmail', 'parseEmailList'];
  assert.deepEqual(Object.keys(ctx.Core).sort(), expected.slice().sort());
});

test('every function is total on null / undefined arguments (except rowsToRecords)', () => {
  const ctx = loadGasStyle();
  const C = ctx.Core;
  for (const name of Object.keys(C)) {
    if (typeof C[name] !== 'function' || name === 'rowsToRecords') continue;
    assert.doesNotThrow(() => C[name](), name + '()');
    assert.doesNotThrow(() => C[name](null, null, null, null), name + '(null...)');
  }
});
