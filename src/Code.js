// Code: web app entry point and HtmlService template helpers.

// Throttled like every api_* call, before the template or any Script Property is read.
function doGet(e) {
  var release;
  try {
    release = Access.throttle('doGet');
  } catch (err) {
    if (!err || (err.code !== 'BUSY' && err.code !== 'FORBIDDEN')) throw err;
    console.warn('[doGet] ' + err.code + ': ' + err.message);
    return refusedPage_(err.message);
  }
  try {
    return renderIndex_(e);
  } finally {
    release();
  }
}

function refusedPage_(message) {
  var template = HtmlService.createTemplate(
    '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:2rem"><?= message ?></p>');
  template.message = String(message);
  return template.evaluate().setTitle('Shadow IT — Tableau de bord');
}

function renderIndex_(e) {
  var template = HtmlService.createTemplateFromFile('index');
  template.page = (e && e.parameter && e.parameter.page) || '';
  var out = template
    .evaluate()
    .setTitle('Shadow IT — Tableau de bord')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  // Only the server can set the tab icon, and a bad URL must not block the app.
  var icon = Config.faviconUrl();
  if (icon) {
    try { out.setFaviconUrl(icon); } catch (err) {
      console.warn('Favicon ignored (' + icon.slice(0, 60) + '): ' + err.message +
        ' — set the FAVICON_URL Script Property to a hosted https .png');
    }
  }
  return out;
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function coreScript() {
  var src = 'var Core = (' + CoreFactory_.toString() + ')();';
  // '<\/script' means the same to the JS parser but cannot close the HTML element.
  return src.replace(/<\/script/gi, '<\\/script');
}

// Inlines the bootstrap envelope so the client skips a round trip. It goes through the wrapped
// api_bootstrap so the role check still applies; returns '' on any failure and the client falls back.
function inlineBoot_() {
  var timer = Perf.start('inlineBoot');
  var out = '';
  try {
    var json = api_bootstrap('null');
    var envelope = JSON.parse(json);
    if (envelope && envelope.ok === true) out = inlineJson_(json);
  } catch (err) {
    out = '';
  }
  timer.end({ ok: out !== '', bytes: out.length });
  return out;
}

// Known page ids match the NAV of js_main.html; the client decides whether the visitor may open it.
function inlinePage_(page) {
  var pages = ['dashboard', 'postes', 'apps', 'timeline', 'actions', 'settings'];
  var p = page === null || page === undefined ? '' : String(page);
  return JSON.stringify(pages.indexOf(p) >= 0 ? p : null);
}

// Escapes JSON for an inline <script> so neither '</script' nor '<!--' can appear; JSON.parse
// still returns the same value.
function inlineJson_(json) {
  return String(json).replace(/[<>&'`\u2028\u2029\/]/g, function (ch) {
    return ch === '/' ? '\\/' : '\\u' + ('000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
}

// Run once from the Apps Script editor: creates the data spreadsheet and the hourly trigger.
function setup() {
  // Public so the editor can run it, which also exposes it to google.script.run: deployer only.
  var active = Access.activeEmail();
  if (!active || active !== Access.ownerEmail()) {
    throw new Error('setup : réservé au compte qui a déployé l’application (éditeur Apps Script).');
  }
  Sync.requireScopes();
  var ss = Store.ensure();
  Logger.log('Classeur de données : %s', ss.getUrl());
  Sync.enable();
  Logger.log('Synchronisation horaire active.');
  return ss.getUrl();
}

// Hourly trigger handler. Triggers cannot call private functions, so this is public and anything
// but this project's own trigger event is ignored.
function syncHourly(e) {
  // A new execution starts with empty memos; this matters in the test sandbox.
  Store.clearMemo_();
  Config.clearMemo_();
  if (!Sync.isTriggerEvent(e)) return;
  Sync.runFromTrigger();
}
