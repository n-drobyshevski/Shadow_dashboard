'use strict';
/**
 * Loads the Apps Script server code into a Node `vm` context backed by the in-memory GAS fakes.
 *
 * Every src/*.js file is evaluated with vm.runInContext in ALPHABETICAL order, which is not the
 * natural dependency order (Api.js, Code.js, Config.js, Core.js, Importer.js, Store.js): a file that
 * calls into another file at top level would fail here, proving load-order independence.
 *
 * Top-level `var` and `function` declarations become properties of the context:
 *   const { ctx, env } = loadGas({ sources: [buildSourceSpreadsheet('2026-05')] });
 *   ctx.Store.ensure(); ctx.api_bootstrap('null'); ctx.Core.normKey('x');
 *
 * The context shares the host `Date` constructor so that `x instanceof Date` behaves as in GAS (one
 * realm) for Date cells produced by the fakes. Plain objects/arrays created inside the context still
 * have the context's prototypes: compare them through `plain()` (JSON round trip) when using
 * assert.deepStrictEqual.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createGasEnv } = require('./gasFakes');

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');

/**
 * @param {{sources?:object[], props?:Object<string,string>, lockTimeout?:boolean, timeZone?:string,
 *          srcDir?:string, echoConsole?:boolean}} [options]
 * @returns {{ctx: object, env: object, files: string[]}}
 */
function loadGas(options) {
  const opts = options || {};
  const srcDir = opts.srcDir || SRC_DIR;
  const env = createGasEnv({
    sources: opts.sources || [],
    timeZone: opts.timeZone,
    lockTimeout: opts.lockTimeout,
    srcDir,
    echoConsole: opts.echoConsole,
  });
  if (opts.props) env.PropertiesService.getScriptProperties().setProperties(opts.props);

  const ctx = vm.createContext({
    SpreadsheetApp: env.SpreadsheetApp,
    PropertiesService: env.PropertiesService,
    LockService: env.LockService,
    Utilities: env.Utilities,
    HtmlService: env.HtmlService,
    Logger: env.Logger,
    Session: env.Session,
    console: env.console,
    Date,
  });
  env.__state.evalContext = ctx;

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    const file = path.join(srcDir, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return { ctx, env, files };
}

/** Deep-copies a value through JSON so it can be compared with host-realm literals. */
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Returns the raw cell values of a tab of a fake spreadsheet (host-realm copy). */
function sheetValues(env, spreadsheetId, tabName) {
  const ss = env.SpreadsheetApp.openById(spreadsheetId);
  const sh = ss.getSheetByName(tabName);
  if (!sh) return null;
  return sh.getDataRange().getValues();
}

module.exports = { loadGas, plain, sheetValues, SRC_DIR };
