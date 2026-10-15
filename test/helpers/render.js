'use strict';
/**
 * Renders the Apps Script HTML template (src/index.html) to a static HTML string, the way
 * doGet -> HtmlService.createTemplateFromFile('index').evaluate() would on the server.
 *
 * Only printing function scriptlets are supported (docs/API.md §5): `<?!= fn() ?>`, `<?!= fn('arg') ?>`
 * and `<?!= fn(templateVar) ?>`, with
 *   - include('x')        -> contents of src/x.html (not re-evaluated, exactly like GAS)
 *   - coreScript()        -> 'var Core = (' + CoreFactory_.toString() + ')();' with CoreFactory_ from src/Core.js
 *   - inlineBoot_()       -> the REAL Code.js inlineBoot_ over the `boot` option (the JSON envelope
 *                            api_bootstrap would return): escaped JSON when ok, '' otherwise; '' when `boot`
 *                            is not given (the client then takes the google.script.run path)
 *   - inlinePage_(page)   -> the REAL Code.js inlinePage_ over the `page` option (doGet's
 *                            e.parameter.page); '' when `page` is not given (the client then asks
 *                            google.script.url.getLocation)
 *
 * Usage:
 *   const { renderIndex } = require('./render');
 *   const html = renderIndex({ inject: '<script>...mock...</script>', boot: '{"ok":true,"data":{...}}', page: 'postes' });
 *
 * CLI (standalone preview, google.script.run mocked over test/fixtures/data.js):
 *   node test/helpers/render.js [out.html]
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');

/** Mirrors Code.js coreScript(): serialises CoreFactory_ from src/Core.js. */
function coreScript() {
  const file = path.join(SRC_DIR, 'Core.js');
  const code = fs.readFileSync(file, 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx, { filename: file });
  if (typeof ctx.CoreFactory_ !== 'function') throw new Error('src/Core.js does not define CoreFactory_');
  const out = 'var Core = (' + ctx.CoreFactory_.toString() + ')();';
  if (/<\/script/i.test(out)) throw new Error('coreScript() output must not contain a closing script tag');
  return out;
}

/** Mirrors Code.js include(name). */
function include(name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid include name: ' + name);
  return fs.readFileSync(path.join(SRC_DIR, name + '.html'), 'utf8');
}

/**
 * src/Code.js (+ Perf.js, which it logs with) in a vm, with api_bootstrap answering `boot`: the template
 * helpers then run exactly as in doGet. Code.js only touches other files inside functions.
 */
function serverHelpers(boot) {
  const quiet = () => {};
  const ctx = vm.createContext({ console: { log: quiet, info: quiet, warn: quiet, error: quiet } });
  for (const f of ['Perf.js', 'Code.js']) {
    const file = path.join(SRC_DIR, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  ctx.api_bootstrap = () => boot;
  return ctx;
}

const SCRIPTLET_RE = /<\?!=\s*([A-Za-z_$][\w$]*)\(\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))?\s*\)\s*;?\s*\?>/g;

/**
 * @param {{inject?:string, boot?:string, page?:string}} [options] `inject` is inserted right after
 *        <head> so that mocks (google.script.run) are defined before any application script runs.
 *        `boot`: what api_bootstrap returns to doGet (a JSON envelope string); `page`: doGet's
 *        e.parameter.page. Leave them out to render the page without inline data.
 * @returns {string} the rendered HTML document
 */
function renderIndex({ inject = '', boot, page } = {}) {
  const template = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const server = serverHelpers(boot);
  const vars = { page };
  // Single pass with a replacer function: included content is never re-scanned and `$` in the
  // content is not interpreted as a replacement pattern.
  let html = template.replace(SCRIPTLET_RE, (m, fn, a1, a2, ident) => {
    if (ident !== undefined && !Object.prototype.hasOwnProperty.call(vars, ident)) {
      throw new Error('Unknown template variable in: ' + m);
    }
    const arg = ident !== undefined ? vars[ident] : a1 !== undefined ? a1 : a2;
    if (fn === 'include') return include(arg);
    if (fn === 'coreScript') return coreScript();
    if (fn === 'inlineBoot_') return boot === undefined ? '' : server.inlineBoot_();
    if (fn === 'inlinePage_') return page === undefined ? '' : server.inlinePage_(arg);
    throw new Error('Unsupported scriptlet: ' + m);
  });
  // Any scriptlet left in the template itself means it uses a form this renderer does not support.
  const leftover = /<\?(?:!=|=|\s)[\s\S]{0,60}/.exec(template.replace(SCRIPTLET_RE, ''));
  if (leftover) throw new Error('Unrendered scriptlet near: ' + leftover[0]);
  if (inject) {
    const idx = html.search(/<head[^>]*>/i);
    if (idx < 0) throw new Error('index.html has no <head>');
    const end = html.indexOf('>', idx) + 1;
    html = html.slice(0, end) + '\n' + inject + '\n' + html.slice(end);
  }
  return html;
}

module.exports = { renderIndex, coreScript, include, serverHelpers, SRC_DIR };

if (require.main === module) {
  const { buildMockScript } = require('../fixtures/mockRun');
  const out = path.resolve(process.argv[2] || 'preview.html');
  const html = renderIndex({ inject: '<script>' + buildMockScript({ delayMs: 150 }) + '</script>' });
  fs.writeFileSync(out, html);
  console.log('Preview written to ' + out);
}
