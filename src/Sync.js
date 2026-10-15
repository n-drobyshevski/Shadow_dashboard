/**
 * Sync — keeps the current month in step with the source spreadsheet (docs/API.md §4).
 *
 * A time-driven trigger calls syncHourly() (Code.js) every hour: the current month (Europe/Paris) is
 * re-imported with Importer.importMonth(month, true, {skipUnchanged:true}). On the 1st, the first run
 * creates the new month; the previous one keeps its last synchronised state (frozen). A run that
 * changes nothing writes nothing. The outcome of the last runs is kept in the SYNC_STATE Script
 * Property (status shown in the app bar) and every run that changed something has an ImportLog entry
 * (the « Journal des synchronisations » in Paramètres).
 *
 * The trigger belongs to the deploying account (the web app executes as it), so it can be created
 * from any admin's session. ScriptApp needs the script.scriptapp scope (appsscript.json).
 *
 * Load-order safe: the IIFE only defines values and functions.
 */
var Sync = (function () {
  var HANDLER = 'syncHourly';
  var PROP_STATE = 'SYNC_STATE';

  function props_() {
    return PropertiesService.getScriptProperties();
  }

  /** {enabled, lastRunAt, lastOkAt, lastChangeAt, lastChange, lastError, warnings} ('' / null when unknown). */
  function readState_() {
    var raw = null;
    try { raw = JSON.parse(props_().getProperty(PROP_STATE) || 'null'); } catch (e) { raw = null; }
    var s = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: s.enabled === true,
      lastRunAt: String(s.lastRunAt || ''),
      lastOkAt: String(s.lastOkAt || ''),
      lastChangeAt: String(s.lastChangeAt || ''),
      lastChange: s.lastChange && typeof s.lastChange === 'object' ? s.lastChange : null,
      lastError: s.lastError && typeof s.lastError === 'object' ? s.lastError : null,
      warnings: Array.isArray(s.warnings) ? s.warnings.map(String) : []
    };
  }

  function writeState_(patch) {
    var s = readState_();
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    props_().setProperty(PROP_STATE, JSON.stringify(s));
    return s;
  }

  function currentMonth() {
    return Config.today().slice(0, 7);
  }

  /** Status for the client: the stored state + the current month. */
  function status() {
    var s = readState_();
    s.month = currentMonth();
    return s;
  }

  function hourlyTriggers_() {
    return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === HANDLER; });
  }

  /**
   * Status with `enabled` checked against the real triggers (Paramètres): someone may have deleted the
   * trigger in the Apps Script editor. Never throws: without the ScriptApp authorisation, `enabled`
   * stays as stored and `authError` says why.
   */
  function verifiedStatus() {
    var s = status();
    try {
      var on = hourlyTriggers_().length > 0;
      if (on !== s.enabled) writeState_({ enabled: on });
      s.enabled = on;
    } catch (e) {
      s.authError = authMessage_(e);
    }
    return s;
  }

  /**
   * An « execute as me » web app runs with the deployer's existing grant: opening it never asks for a
   * new scope, only a run from the editor (setup) does.
   */
  function authMessage_(e) {
    console.warn('Sync: ScriptApp unavailable (' + (e && e.message) + ')');
    return 'Autorisation Google manquante pour la synchronisation automatique. Le compte qui a déployé ' +
      'l’application doit ouvrir le projet dans l’éditeur Apps Script, exécuter la fonction « setup » et ' +
      'accepter l’autorisation demandée (déclencheurs).';
  }

  /**
   * The editor's consent screen is granular (each scope can be left unchecked) and does not ask again
   * for a scope already declined: requireAllScopes ends the run and shows the consent screen for every
   * scope of the manifest still missing. Only meaningful from the editor (setup).
   */
  function requireScopes() {
    if (typeof ScriptApp.requireAllScopes === 'function') ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  }

  /** Creates the hourly trigger (once; duplicates are removed). */
  function enable() {
    var existing;
    try {
      existing = hourlyTriggers_();
      if (!existing.length) ScriptApp.newTrigger(HANDLER).timeBased().everyHours(1).create();
      existing.slice(1).forEach(function (t) { ScriptApp.deleteTrigger(t); });
    } catch (e) {
      throw Core.makeError('NOT_CONFIGURED', authMessage_(e));
    }
    writeState_({ enabled: true });
    return status();
  }

  /** Summary kept for the status line: {month, at, created, postes, applications, referentiel}. */
  function changeSummary_(res, at) {
    var c = res.changes || {};
    return { month: res.month, at: at, created: !!c.created, postes: c.postes || null,
      applications: c.applications || null, referentiel: !!c.referentiel };
  }

  /**
   * Synchronises the current month. Errors are recorded in the state (lastError) and rethrown, so a
   * failed hourly run also triggers Google's failure e-mail to the owner. BUSY (a user operation held
   * the lock for 20 s) is not recorded: the next run retries.
   * @return {{status: Object, result: Object}}
   */
  function run() {
    if (!Config.get().sourceId) {
      throw Core.makeError('NOT_CONFIGURED', 'Aucun classeur source n’est configuré. Renseignez-le dans « Paramètres ».');
    }
    var month = currentMonth();
    var at = Config.nowStamp();
    var res;
    try {
      res = Importer.importMonth(month, true, { skipUnchanged: true });
    } catch (e) {
      if (e && e.code !== 'BUSY') {
        writeState_({ lastRunAt: at, lastError: { at: at, code: String(e.code || 'INTERNAL'),
          message: String((e && e.message) || e).split('\n')[0].slice(0, 300) } });
      }
      throw e;
    }
    var patch = { lastRunAt: at, lastOkAt: at, lastError: null, warnings: res.warnings || [] };
    if (res.changed) {
      patch.lastChangeAt = at;
      patch.lastChange = changeSummary_(res, at);
    }
    writeState_(patch);
    return { status: status(), result: res };
  }

  /** The hourly run: nothing to do without a source; errors are logged and rethrown (owner e-mail). */
  function runFromTrigger() {
    if (!Config.get().sourceId) return null;
    try {
      return run();
    } catch (e) {
      console.error('Sync: hourly run failed: ' + ((e && e.stack) || e));
      if (e && e.code === 'BUSY') return null;
      throw e;
    }
  }

  return {
    HANDLER: HANDLER,
    currentMonth: currentMonth,
    status: status,
    verifiedStatus: verifiedStatus,
    requireScopes: requireScopes,
    enable: enable,
    run: run,
    runFromTrigger: runFromTrigger
  };
})();
