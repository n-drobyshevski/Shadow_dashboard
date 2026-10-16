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
 *
 * A new Apps Script execution (fresh module state, same spreadsheets / properties / cache) is
 * simulated by loading again over the same env: loadGas({ env }).
 *
 * The fake console records every call in env.__state.console without printing it (unless
 * echoConsole), so the Perf timing lines never flood the test output: timingLines(env) returns them
 * parsed, in order.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createGasEnv } = require('./gasFakes');

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');

/** The editing switches of Paramètres all on: a deployment whose admin turned them on (they are off by default). */
const EDITING_ON = JSON.stringify({ edit: true, create: true, delete: true });

/**
 * @param {{sources?:object[], props?:Object<string,string>, lockTimeout?:boolean, timeZone?:string,
 *          srcDir?:string, echoConsole?:boolean, env?:object, editingUnset?:boolean}} [options] env: reuse an
 *          existing env (a new execution); the env-building options are then ignored. A new env starts with
 *          EDITING_JSON all on (props may override it); editingUnset: true leaves it unset (Config's default: off).
 * @returns {{ctx: object, env: object, files: string[]}}
 */
function loadGas(options) {
  const opts = options || {};
  const srcDir = opts.srcDir || SRC_DIR;
  const env = opts.env || createGasEnv({
    sources: opts.sources || [],
    timeZone: opts.timeZone,
    lockTimeout: opts.lockTimeout,
    srcDir,
    echoConsole: opts.echoConsole,
    scriptAppDenied: opts.scriptAppDenied,
  });
  if (!opts.env) {
    const props = Object.assign(opts.editingUnset ? {} : { EDITING_JSON: EDITING_ON }, opts.props || {});
    if (Object.keys(props).length) env.PropertiesService.getScriptProperties().setProperties(props);
  }

  const ctx = vm.createContext({
    SpreadsheetApp: env.SpreadsheetApp,
    PropertiesService: env.PropertiesService,
    LockService: env.LockService,
    Utilities: env.Utilities,
    HtmlService: env.HtmlService,
    Logger: env.Logger,
    Session: env.Session,
    GroupsApp: env.GroupsApp,
    CacheService: env.CacheService,
    ScriptApp: env.ScriptApp,
    console: env.console,
    Date,
  });
  env.__state.evalContext = ctx;

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    const file = path.join(srcDir, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  // Test-only stand-in for the manual import endpoint the app no longer has (the hourly sync imports
  // the current month): Importer.importMonth for any month, under the same admin envelope, so that
  // tests can build several months of history.
  ctx.api_importMonth = ctx.apiWrap_(function (args) {
    return ctx.Importer.importMonth(args.month, args.overwrite === true);
  }, 'api_importMonth (test)', 'admin');
  return { ctx, env, files };
}

/** Deep-copies a value through JSON so it can be compared with host-realm literals. */
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * The Perf timing lines logged so far (console.log calls whose single argument is a JSON object),
 * parsed: [{api, ms, authMs, ok, code?} | {stage, ms, ...}].
 */
function timingLines(env) {
  const out = [];
  for (const c of env.__state.console) {
    if (c.level !== 'log' || c.args.length !== 1 || typeof c.args[0] !== 'string' || c.args[0].charAt(0) !== '{') continue;
    try { out.push(JSON.parse(c.args[0])); } catch (e) { /* not a timing line */ }
  }
  return out;
}

/** Returns the raw cell values of a tab of a fake spreadsheet (host-realm copy). */
function sheetValues(env, spreadsheetId, tabName) {
  const ss = env.SpreadsheetApp.openById(spreadsheetId);
  const sh = ss.getSheetByName(tabName);
  if (!sh) return null;
  return sh.getDataRange().getValues();
}

/**
 * The event object of the project's hourly trigger, as Apps Script passes it to syncHourly(e): adds a
 * syncHourly trigger to the fake ScriptApp when none exists (syncHourly ignores any other caller).
 */
function hourlyEvent(env) {
  const st = env.__state;
  let t = st.triggers.find((x) => x.handler === 'syncHourly');
  if (!t) {
    t = { id: 'trig-hourly', handler: 'syncHourly', everyHours: 1 };
    st.triggers.push(t);
  }
  return { triggerUid: t.id, authMode: 'FULL' };
}

module.exports = { loadGas, plain, sheetValues, timingLines, hourlyEvent, SRC_DIR };
