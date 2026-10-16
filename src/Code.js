/**
 * Code — web app entry point and HtmlService template helpers (docs/API.md §4).
 */

/**
 * Web app entry: renders the index template. The page also carries the bootstrap envelope
 * (inlineBoot_) and the requested page (`?page=`, inlinePage_), so the client boots without waiting
 * for a google.script.run round trip or for google.script.url.getLocation.
 * Like every api_* call, a page load first goes through Access.throttle('doGet'), before the template is
 * rendered or any Script Property read (FAVICON_URL): without an identity (FORBIDDEN) or past the
 * account's limits (BUSY), a short static page with the message is returned instead.
 */
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

/**
 * Minimal static page for a refused page load: the message as text (printed by an escaping <?= ?>
 * scriptlet), nothing else read or rendered.
 */
function refusedPage_(message) {
  var template = HtmlService.createTemplate(
    '<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;margin:2rem"><?= message ?></p>');
  template.message = String(message);
  return template.evaluate().setTitle('Shadow IT — Tableau de bord');
}

function renderIndex_(e) {
  var template = HtmlService.createTemplateFromFile('index');
  // Template variable read by the <?!= inlinePage_(page) ?> scriptlet.
  template.page = (e && e.parameter && e.parameter.page) || '';
  var out = template
    .evaluate()
    .setTitle('Shadow IT — Tableau de bord')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  // The tab icon belongs to Google's outer page: only the server can set it. Never block the app on it.
  var icon = Config.faviconUrl();
  if (icon) {
    try { out.setFaviconUrl(icon); } catch (err) {
      console.warn('Favicon ignored (' + icon.slice(0, 60) + '): ' + err.message +
        ' — set the FAVICON_URL Script Property to a hosted https .png');
    }
  }
  return out;
}

/** Template helper: raw content of another HTML file (css / js_* partials). */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Template helper: the shared pure logic (Core) as browser JavaScript, to be inlined in a
 * <script> element. Any closing script tag sequence is neutralised ('<\/script' is the same string
 * / regex / comment for the JS parser but cannot terminate the HTML element).
 */
function coreScript() {
  var src = 'var Core = (' + CoreFactory_.toString() + ')();';
  return src.replace(/<\/script/gi, '<\\/script');
}

/**
 * Template helper: the visitor's api_bootstrap envelope as JSON for the
 * <script type="application/json" id="boot-data"> element of index.html. It goes through the wrapped
 * api_bootstrap, so the role check applies exactly as for google.script.run. '' when the call fails or
 * is refused (FORBIDDEN...): the client then calls api_bootstrap itself and shows the denied screen or
 * the splash error as before. Never throws (the page must render anyway). Logs
 * {stage:'inlineBoot', ms, ok, bytes}.
 */
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

/**
 * Template helper: the request's `?page=` as JSON for <script type="application/json" id="boot-page">:
 * '"postes"' for a known page id (the NAV of js_main.html), 'null' otherwise. Whether the visitor may
 * open it (Paramètres is admin only) is decided by the client, as for a page read from
 * google.script.url.getLocation.
 */
function inlinePage_(page) {
  var pages = ['dashboard', 'postes', 'apps', 'timeline', 'actions', 'settings'];
  var p = page === null || page === undefined ? '' : String(page);
  return JSON.stringify(pages.indexOf(p) >= 0 ? p : null);
}

/**
 * JSON text made safe inside an HTML <script> element: < > & ' ` U+2028 U+2029 become \uXXXX escapes
 * and / becomes \/ (so neither '</script' nor '<!--' can appear). Outside strings, JSON text never
 * contains these characters, and inside strings the escapes are valid: JSON.parse returns the same value.
 */
function inlineJson_(json) {
  return String(json).replace(/[<>&'`\u2028\u2029\/]/g, function (ch) {
    return ch === '/' ? '\\/' : '\\u' + ('000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
}

/**
 * Run once from the Apps Script editor: authorizes the script, creates the data spreadsheet and the
 * hourly synchronisation trigger. Asks first for any scope still missing (Sync.requireScopes).
 */
function setup() {
  // Public (the editor only runs public functions), so google.script.run can reach it too: the web
  // app runs as the deployer, and only the deployer may run this. A visitor's active user differs.
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

/**
 * Time-driven trigger handler (every hour, created by Sync.enable): synchronises the current month
 * with the source spreadsheet. Public because a trigger cannot call a private (`_`) function, so
 * google.script.run can call it too: without the event of one of this project's hourly triggers
 * (Sync.isTriggerEvent) it does nothing. Starts with
 * empty read memos, like apiWrap_ (a new execution in Apps Script; matters in the test sandbox).
 */
function syncHourly(e) {
  Store.clearMemo_();
  Config.clearMemo_();
  // Public for the trigger, hence reachable from google.script.run: anything but this project's
  // hourly trigger is ignored (admins have api_syncNow).
  if (!Sync.isTriggerEvent(e)) return;
  Sync.runFromTrigger();
}
