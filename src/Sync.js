/**
 * Sync: keeps the current month in step with the source spreadsheet, run hourly by syncHourly().
 * The trigger belongs to the deploying account and needs the script.scriptapp scope.
 */
var Sync = (function () {
  var HANDLER = 'syncHourly';
  var PROP_STATE = 'SYNC_STATE';

  function props_() {
    return PropertiesService.getScriptProperties();
  }

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

  function status() {
    var s = readState_();
    s.month = currentMonth();
    return s;
  }

  function hourlyTriggers_() {
    return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === HANDLER; });
  }

  // The trigger may have been deleted in the editor. Never throws: without ScriptApp authorisation,
  // `enabled` stays as stored and `authError` says why.
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

  // The web app runs with the deployer's existing grant, so only running setup from the editor can
  // add a missing scope.
  function authMessage_(e) {
    console.warn('Sync: ScriptApp unavailable (' + (e && e.message) + ')');
    return 'Autorisation Google manquante pour la synchronisation automatique. Le compte qui a déployé ' +
      'l’application doit ouvrir le projet dans l’éditeur Apps Script, exécuter la fonction « setup » et ' +
      'accepter l’autorisation demandée (déclencheurs).';
  }

  // The editor's granular consent screen does not ask again for a declined scope; this forces it.
  function requireScopes() {
    if (typeof ScriptApp.requireAllScopes === 'function') ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  }

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

  function changeSummary_(res, at) {
    var c = res.changes || {};
    return { month: res.month, at: at, created: !!c.created, postes: c.postes || null,
      applications: c.applications || null, referentiel: !!c.referentiel };
  }

  // Returns {status, result}. Errors are recorded and rethrown so Google e-mails the owner on a failed
  // hourly run. BUSY is not recorded since the next run retries.
  function run() {
    if (!Config.get().sourceId) {
      throw Core.makeError('NOT_CONFIGURED', 'Aucun classeur source n’est configuré. Renseignez-le dans « Paramètres ».');
    }
    var month = currentMonth();
    var at = Config.nowStamp();
    var t = Perf.start('sync', { month: month });
    var res;
    try {
      res = Importer.importMonth(month, true, { skipUnchanged: true });
    } catch (e) {
      if (e && e.code !== 'BUSY') {
        writeState_({ lastRunAt: at, lastError: { at: at, code: String(e.code || 'INTERNAL'),
          message: String(e.message || e).split('\n')[0].slice(0, 300) } });
      }
      t.end({ ok: false, code: String((e && e.code) || 'INTERNAL') });
      throw e;
    }
    t.lap('import');
    var patch = { lastRunAt: at, lastOkAt: at, lastError: null, warnings: res.warnings || [] };
    if (res.changed) {
      patch.lastChangeAt = at;
      patch.lastChange = changeSummary_(res, at);
    }
    writeState_(patch);
    var out = { status: status(), result: res };
    t.lap('state');
    t.end({ changed: res.changed, ok: true });
    return out;
  }

  // syncHourly is public, so any visitor can call it; only a real trigger run carries the uid of an
  // existing trigger, and trigger ids never leave the server.
  function isTriggerEvent(e) {
    var uid = e && typeof e === 'object' && typeof e.triggerUid === 'string' ? e.triggerUid : '';
    if (!uid) return false;
    try {
      return hourlyTriggers_().some(function (t) { return String(t.getUniqueId()) === uid; });
    } catch (err) {
      return false;
    }
  }

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
    runFromTrigger: runFromTrigger,
    isTriggerEvent: isTriggerEvent
  };
})();
