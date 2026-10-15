/**
 * Code — web app entry point and HtmlService template helpers (docs/API.md §4).
 */

/** Web app entry: renders the index template. */
function doGet(e) {
  var out = HtmlService.createTemplateFromFile('index')
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
 * Run once from the Apps Script editor: authorizes the script, creates the data spreadsheet and the
 * hourly synchronisation trigger. Asks first for any scope still missing (Sync.requireScopes).
 */
function setup() {
  Sync.requireScopes();
  var ss = Store.ensure();
  Logger.log('Classeur de données : %s', ss.getUrl());
  Sync.enable();
  Logger.log('Synchronisation horaire active.');
  return ss.getUrl();
}

/**
 * Time-driven trigger handler (every hour, created by Sync.enable): synchronises the current month
 * with the source spreadsheet. Public because a trigger cannot call a private (`_`) function; a call
 * from google.script.run would only run the same idempotent sync and returns nothing.
 */
function syncHourly() {
  Sync.runFromTrigger();
}
