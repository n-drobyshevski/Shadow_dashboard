'use strict';
/**
 * Integration tests: what doGet renders into the page besides the shell (src/Code.js inlineBoot_ /
 * inlinePage_ / inlineJson_, docs/API.md §4 Code and §5 Template), the test renderer that mirrors it
 * (test/helpers/render.js), and the non-blocking <head> (Plotly preloaded only, loaded by Charts.ready).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadGas, plain, timingLines, SRC_DIR } = require('../helpers/gasSandbox');
const { renderIndex } = require('../helpers/render');
const { bootstrapEnvelope } = require('../fixtures/mockRun');
const { buildSourceSpreadsheet, SOURCE_ID } = require('../fixtures/source');

const OWNER = 'owner@decathlon.com';
const READER = 'lea.reader@decathlon.com';

/** Content of <script type="application/json" id="<id>"> in rendered HTML (null when absent). */
function inlineNode(html, id) {
  const m = new RegExp('<script type="application/json" id="' + id + '">([\\s\\S]*?)</script>').exec(html);
  return m ? m[1] : null;
}

/** Sandbox with 2026-05 synchronised by the owner. */
function imported() {
  const sb = loadGas({ sources: [buildSourceSpreadsheet('2026-05')] });
  const ok = (name, args) => {
    const res = JSON.parse(sb.ctx[name](JSON.stringify(args === undefined ? null : args)));
    assert.equal(res.ok, true, name + ': ' + JSON.stringify(res.error));
    return res.data;
  };
  ok('api_setConfig', { source: SOURCE_ID });
  ok('api_importMonth', { month: '2026-05' });
  ok('api_saveUser', { email: READER, role: 'lecteur' });
  return sb;
}

// ------------------------------------------------------------------------------------- escaping

const NASTY = [
  '</script><script>alert(1)</script>',
  '<!-- <script>',
  '</SCRIPT >',
  'https://example.org//path/',
  'l’équipe "Labo" \'quote\' `tick` ${x}',
  'a\u2028b\u2029c',
  'R&D <b>gras</b> > fin',
  'back\\slash \\/ \\u003c',
  '\u00a0\u202f€ 😀',
];

test('inlineJson_: every risky character becomes an escape, JSON.parse gives the same value back', () => {
  const { ctx } = loadGas();
  const value = { strings: NASTY, nested: { [NASTY[0]]: NASTY[4], list: [1, 2.5, null, true, ''] } };
  const json = JSON.stringify(value);
  const out = ctx.inlineJson_(json);
  assert.deepEqual(JSON.parse(out), value);
  for (const ch of ['<', '>', '&', '\'', '`', '\u2028', '\u2029']) assert.ok(!out.includes(ch), 'no raw ' + JSON.stringify(ch));
  assert.ok(!/(^|[^\\])\//.test(out.replace(/\\\\/g, '')), 'every / is escaped');
  assert.doesNotMatch(out, /<\/script|<!--/i);
  for (const s of NASTY) assert.equal(JSON.parse(ctx.inlineJson_(JSON.stringify(s))), s, s);
  assert.equal(ctx.inlineJson_('{"a":"</x>"}'), '{"a":"\\u003c\\/x\\u003e"}');
  assert.equal(ctx.inlineJson_('"\u2028"'), '"\\u2028"');
});

// ------------------------------------------------------------------------------------ inlineBoot_

test('inlineBoot_: the visitor\'s api_bootstrap envelope, escaped, with an inlineBoot timing line', () => {
  const { ctx, env } = imported();
  const direct = JSON.parse(ctx.api_bootstrap('null'));
  const before = timingLines(env).length;
  const out = ctx.inlineBoot_();
  const envelope = JSON.parse(out);
  assert.equal(envelope.ok, true);
  assert.deepEqual(plain(envelope.data.user), { email: OWNER, role: 'admin', isOwner: true });
  assert.deepEqual(envelope.data.months, direct.data.months);
  assert.doesNotMatch(out, /[<>]/);
  const lines = timingLines(env).slice(before);
  // The wrapped api_bootstrap logs its own api line (role check included), then the stage line closes.
  const stage = lines[lines.length - 1];
  assert.deepEqual(Object.keys(stage), ['stage', 'ms', 'ok', 'bytes']);
  assert.equal(stage.stage, 'inlineBoot');
  assert.equal(stage.ok, true);
  assert.equal(stage.bytes, out.length);
  assert.ok(Number.isInteger(stage.ms) && stage.ms >= 0);
  assert.deepEqual(plain(lines[lines.length - 2]), { api: 'api_bootstrap', ms: lines[lines.length - 2].ms,
    authMs: lines[lines.length - 2].authMs, ok: true });
});

test('inlineBoot_: a lecteur gets the lecteur bootstrap (links hidden) — the role check applies', () => {
  const sb = imported();
  sb.env.__setActiveUser(READER);
  const envelope = JSON.parse(sb.ctx.inlineBoot_());
  assert.equal(envelope.ok, true);
  assert.deepEqual(plain(envelope.data.user), { email: READER, role: 'lecteur', isOwner: false });
  assert.equal(envelope.data.dataUrl, '');
  assert.equal(envelope.data.sourceUrl, '');
});

test('inlineBoot_: \'\' for a refused visitor or a missing identity (the client then shows « Accès refusé »)', () => {
  const sb = imported();
  for (const email of ['intrus@ailleurs.com', '']) {
    sb.env.__setActiveUser(email);
    const before = timingLines(sb.env).length;
    assert.equal(JSON.parse(sb.ctx.api_bootstrap('null')).error.code, 'FORBIDDEN');
    assert.equal(sb.ctx.inlineBoot_(), '');
    const lines = timingLines(sb.env).slice(before);
    assert.deepEqual(plain(lines.filter((l) => l.stage === 'inlineBoot').map((l) => [l.ok, l.bytes])), [[false, 0]]);
  }
});

test('inlineBoot_: \'\' when the bootstrap fails or throws, never an exception', () => {
  const sb = imported();
  sb.ctx.Store.listMonths = function () { throw new TypeError('boom'); };
  assert.equal(JSON.parse(sb.ctx.api_bootstrap('null')).error.code, 'INTERNAL');
  assert.equal(sb.ctx.inlineBoot_(), '');
  sb.ctx.api_bootstrap = function () { throw new Error('unexpected'); };
  assert.equal(sb.ctx.inlineBoot_(), '');
  sb.ctx.api_bootstrap = function () { return 'not json'; };
  assert.equal(sb.ctx.inlineBoot_(), '');
});

test('inlineBoot_: data with </script>, <!--, quotes, backticks and U+2028 stays inside its element', () => {
  const sb = imported();
  const data = { sourceTitle: NASTY.join(' | '), months: ['2026-05'] };
  sb.ctx.api_bootstrap = () => JSON.stringify({ ok: true, data });
  const out = sb.ctx.inlineBoot_();
  const html = '<script type="application/json" id="boot-data">' + out + '</script>';
  assert.equal(inlineNode(html, 'boot-data'), out, 'the element ends where it should');
  assert.deepEqual(JSON.parse(out), { ok: true, data });
});

// ------------------------------------------------------------------------------------ inlinePage_

test('inlinePage_: a known page id as JSON, null otherwise', () => {
  const { ctx } = loadGas();
  for (const p of ['dashboard', 'postes', 'apps', 'timeline', 'actions', 'settings']) assert.equal(ctx.inlinePage_(p), JSON.stringify(p));
  for (const p of ['', null, undefined, 'Postes', 'nope', '__proto__', 'constructor', '<script>', ' postes']) {
    assert.equal(ctx.inlinePage_(p), 'null', String(p));
  }
});

test('inlinePage_ knows exactly the pages of the client NAV (js_main.html)', () => {
  const { ctx } = loadGas();
  const main = fs.readFileSync(path.join(SRC_DIR, 'js_main.html'), 'utf8');
  const nav = /var NAV = \[([\s\S]*?)\];/.exec(main)[1];
  const ids = [...nav.matchAll(/\{\s*id:\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 6);
  for (const id of ids) assert.equal(ctx.inlinePage_(id), JSON.stringify(id), id);
  const src = fs.readFileSync(path.join(SRC_DIR, 'Code.js'), 'utf8');
  const listed = JSON.parse(/var pages = (\[[^\]]*\]);/.exec(src)[1].replace(/'/g, '"'));
  assert.deepEqual(listed.slice().sort(), ids.slice().sort());
});

// ------------------------------------------------------------------------------------------ doGet

test('doGet renders the bootstrap envelope and the ?page= into the page', () => {
  const sb = imported();
  let html = sb.ctx.doGet({ parameter: { page: 'postes' } }).getContent();
  assert.equal(inlineNode(html, 'boot-page'), '"postes"');
  const envelope = JSON.parse(inlineNode(html, 'boot-data'));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.user.email, OWNER);
  // The JSON elements come before the application scripts that read them.
  assert.ok(html.indexOf('id="boot-data"') < html.indexOf('window.State'));

  html = sb.ctx.doGet({ parameter: { page: 'nope' } }).getContent();
  assert.equal(inlineNode(html, 'boot-page'), 'null');
  html = sb.ctx.doGet({}).getContent();
  assert.equal(inlineNode(html, 'boot-page'), 'null');
  html = sb.ctx.doGet(undefined).getContent();
  assert.equal(inlineNode(html, 'boot-page'), 'null');

  sb.env.__setActiveUser('intrus@ailleurs.com');
  html = sb.ctx.doGet({ parameter: { page: 'postes' } }).getContent();
  assert.equal(inlineNode(html, 'boot-data'), '', 'nothing inline for a refused visitor');
  assert.equal(inlineNode(html, 'boot-page'), '"postes"');
});

// ---------------------------------------------------------------------------------- test renderer

test('render.js: no inline data by default; boot / page go through the real Code.js helpers', () => {
  let html = renderIndex();
  assert.equal(inlineNode(html, 'boot-data'), '');
  assert.equal(inlineNode(html, 'boot-page'), '');

  const env = bootstrapEnvelope({});
  html = renderIndex({ boot: env, page: 'apps' });
  assert.deepEqual(JSON.parse(inlineNode(html, 'boot-data')), JSON.parse(env));
  assert.equal(inlineNode(html, 'boot-page'), '"apps"');
  assert.equal(inlineNode(renderIndex({ page: '' }), 'boot-page'), 'null');
  assert.equal(inlineNode(renderIndex({ boot: '' }), 'boot-data'), '');

  // A refused visitor: the mock answers FORBIDDEN, so nothing is inlined (as doGet does).
  const refused = bootstrapEnvelope({ email: 'stranger@decathlon.com' });
  assert.equal(JSON.parse(refused).error.code, 'FORBIDDEN');
  assert.equal(inlineNode(renderIndex({ boot: refused }), 'boot-data'), '');
});

// --------------------------------------------------------------------------------- non-blocking head

test('index.html <head> blocks nothing: Plotly only preloaded (same URL as Charts.ready), fonts applied on load', () => {
  const index = fs.readFileSync(path.join(SRC_DIR, 'index.html'), 'utf8');
  const head = /<head>([\s\S]*?)<\/head>/.exec(index)[1];
  assert.doesNotMatch(head, /<script\b/i, 'no script in <head>');
  const preload = /<link rel="preload" href="([^"]+)" as="script"[^>]*>/.exec(head);
  assert.ok(preload, 'Plotly preload');
  const charts = fs.readFileSync(path.join(SRC_DIR, 'js_charts.html'), 'utf8');
  assert.equal(/var PLOTLY_URL = '([^']+)';/.exec(charts)[1], preload[1]);
  assert.equal(preload[1], 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.35.3/plotly.min.js');
  const sheets = [...head.matchAll(/<link rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
  const outside = head.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
  for (const link of outside.match(/<link rel="stylesheet"[^>]*>/g) || []) {
    assert.match(link, /media="print" onload="this\.media='all'"/, link);
  }
  assert.ok(sheets.length >= 2, 'non-blocking stylesheet + <noscript> fallback');
  assert.match(head, /<noscript><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+"><\/noscript>/);
});
