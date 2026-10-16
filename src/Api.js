/**
 * Api — google.script.run entry points (docs/API.md §3).
 *
 * Every public api_* function takes ONE JSON string and returns ONE JSON string:
 *   {ok:true, data} | {ok:false, error:{code, message, field?}}
 * so that no Date (or other non-JSON value) ever crosses google.script.run.
 *
 * Conventions:
 *   - argument validation happens BEFORE taking the lock (cheap, no Sheets call);
 *   - every write runs inside Store.withLock (20 s wait, timeout -> BUSY);
 *   - every Poste / Application record returned is enriched with Core (_score, _conforme, and
 *     _criteria for applications, which also always carry Galink / IDP keys).
 *
 * Load-order safe: only function declarations and an IIFE that defines functions.
 */

// ------------------------------------------------------------------------------------ envelope

/**
 * Wraps an implementation `fn(args, user) -> data` into the JSON envelope. Before anything is read,
 * Access.throttle(name) refuses a call without identity (FORBIDDEN) and an account above its per-minute
 * rate or with too many calls running (BUSY), so neither reaches the Script Properties; the release it
 * returns runs in `finally` (the call no longer counts as running). The caller's role is then
 * checked (Access.requireRole, FORBIDDEN otherwise) and the effective compliance threshold is
 * applied to Core for the duration of the call. Errors whose `.code` is one of Core.ERROR_CODES are
 * reported as-is (their messages are ours, in French), VALIDATION ones with their `.field` when they
 * name a form field; anything else becomes INTERNAL. The stack is
 * logged with console.error and never sent to the client. Every call ends with one timing line
 * (Perf.log): {api, ms, authMs (throttle + Config + role check), ok, code (failures only)}. Every call starts
 * with empty read memos (Store, Config): in Apps Script each call is a new execution anyway, the
 * reset keeps the test sandbox (many calls in one context) honest.
 * @param {function(Object, Object): *} fn
 * @param {string=} name used in logs
 * @param {string=} minRole 'lecteur' (default) | 'admin'
 * @return {function(string): string}
 */
function apiWrap_(fn, name, minRole) {
  return function (argsJson) {
    var t0 = Date.now();
    var authMs = null;
    var ok = false;
    var code = null;
    var release = null;
    try {
      Store.clearMemo_();
      Config.clearMemo_();
      release = Access.throttle(name);
      var cfg = Config.get();
      var user = Access.requireRole(minRole || 'lecteur', cfg.access);
      authMs = Date.now() - t0;
      Core.setThreshold(cfg.threshold);
      var args = parseArgs_(argsJson);
      var data = fn(args, user);
      var reply = JSON.stringify({ ok: true, data: data === undefined ? null : data });
      ok = true;
      return reply;
    } catch (err) {
      var e = err || {};
      var known = Core.ERROR_CODES.indexOf(e.code) >= 0 && e.code !== 'INTERNAL';
      code = known ? e.code : 'INTERNAL';
      var message = known ? String(e.message || code) : internalMessage_(e);
      if (code === 'FORBIDDEN' || e.throttled) console.warn('[' + (name || 'api') + '] ' + code + ': ' + message);
      else console.error('[' + (name || 'api') + '] ' + code + ': ' + (e.stack || e.message || String(err)));
      var error = { code: code, message: message };
      // The form field a VALIDATION error is about (Core.makeError's third argument).
      if (code === 'VALIDATION' && typeof e.field === 'string' && e.field !== '') error.field = e.field;
      return JSON.stringify({ ok: false, error: error });
    } finally {
      if (release) release();
      var line = { api: name || 'api', ms: Date.now() - t0, authMs: authMs, ok: ok };
      if (code) line.code = code;
      Perf.log(line);
    }
  };
}

/** argsJson -> plain object ({} for null / '' / undefined). Anything else -> VALIDATION. */
function parseArgs_(argsJson) {
  if (argsJson === undefined || argsJson === null || argsJson === '') return {};
  if (typeof argsJson !== 'string') {
    throw Core.makeError('VALIDATION', 'Arguments invalides : une chaîne JSON est attendue.');
  }
  var args;
  try {
    args = JSON.parse(argsJson);
  } catch (e) {
    throw Core.makeError('VALIDATION', 'Arguments invalides : JSON mal formé.');
  }
  if (args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw Core.makeError('VALIDATION', 'Arguments invalides : un objet JSON est attendu.');
  }
  return args;
}

/** French message for unexpected errors: first line of the error message only (never the stack). */
function internalMessage_(e) {
  var detail = String((e && e.message) || '').split('\n')[0].slice(0, 200);
  return 'Erreur interne du serveur' + (detail ? ' : ' + detail : '.');
}

// ------------------------------------------------------------------------------ implementation

var ApiImpl_ = (function () {
  var POSTE_SLIM_FIELDS = ['Équipe', 'Bâtiment / Labo', 'EDR Decathlon', 'IT Decathlon', 'Réseau Decathlon',
    'Niveau de risque'];
  var APP_SLIM_FIELDS = ['Équipe', 'SIP', 'Contrat', 'Galink', 'IDP', 'Niveau de risque'];
  var DATE_FR_RE = /^\d{2}\/\d{2}\/\d{4}$/;
  var IMPORT_LOG_LIMIT = 12;     // api_getImportLog default (the « Journal des synchronisations »)
  var IMPORT_LOG_MAX_LIMIT = 500;

  var hasOwn = Object.prototype.hasOwnProperty;

  // ------------------------------------------------------------------------------- validation

  /** VALIDATION error; `field` names the form field it is about (sent to the client as error.field). */
  function invalid_(message, field) {
    return Core.makeError('VALIDATION', message, field);
  }

  function requireMonth_(month, label) {
    if (!Core.validateMonth(month)) {
      throw invalid_('Mois invalide' + (label ? ' (' + label + ')' : '') + ' : « ' + Core.str(month) +
        ' » (format attendu AAAA-MM).');
    }
    return month;
  }

  /** NOT_FOUND unless `month` has been imported. */
  function requireImported_(month) {
    if (!Store.hasMonth(month)) {
      throw Core.makeError('NOT_FOUND', 'Le mois ' + month + ' n’a pas été importé.');
    }
    return month;
  }

  function requireImportedMonth_(month, label) { return requireImported_(requireMonth_(month, label)); }

  /** Refusal message of each Paramètres › « Saisie dans l’application » switch (Config EDITING_JSON). */
  var EDITING_REFUSED = {
    edit: 'La modification des postes et des applications est désactivée dans les Paramètres.',
    create: 'La création de postes et d’applications est désactivée dans les Paramètres.',
    delete: 'La suppression d’applications est désactivée dans les Paramètres.'
  };

  /**
   * FORBIDDEN when the switch `kind` ('edit' | 'create' | 'delete') is off. First line of the postes /
   * applications writes it covers (after the role check, before the lock), every month alike.
   */
  function requireEditing_(kind) {
    if (!Config.get().editing[kind]) throw Core.makeError('FORBIDDEN', EDITING_REFUSED[kind]);
  }

  function requireId_(id) {
    var s = typeof id === 'string' || typeof id === 'number' ? Core.str(id) : '';
    if (!s) throw invalid_('Identifiant manquant.');
    return s;
  }

  function isPlainObject_(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** VALIDATION (with the field) for a text longer than Core.LIMITS.cellChars, else the text. */
  function maxLength_(s, field) {
    if (s.length > Core.LIMITS.cellChars) {
      throw invalid_('Texte trop long pour « ' + field + ' » : ' + Core.LIMITS.cellChars + ' caractères au maximum.', field);
    }
    return s;
  }

  /** A cell value coming from the client -> string | null. Objects / arrays and too long texts are refused. */
  function cellValue_(v, field) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return Core.isBlank(v) ? null : maxLength_(v, field);
    if (typeof v === 'number') return isFinite(v) ? String(v) : null;
    if (typeof v === 'boolean') return String(v);
    throw invalid_('Valeur invalide pour « ' + field + ' ».', field);
  }

  /** Galink / IDP only accept 'Oui', 'Non' or blank. */
  function checkCustomField_(field, value) {
    if (Core.APP_CUSTOM_FIELDS.indexOf(field) >= 0 && value !== null && value !== 'Oui' && value !== 'Non') {
      throw invalid_('« ' + field + ' » doit valoir « Oui », « Non » ou être vide.', field);
    }
  }

  /**
   * Validates entity edits: changes = [{id, updates:{col:value}}]. `_`-prefixed keys and the key
   * column are refused (renaming an application goes through api_renameApplication).
   */
  function normalizeChanges_(changes, keyField) {
    if (!Array.isArray(changes)) throw invalid_('« changes » doit être une liste.');
    return changes.map(function (c) {
      if (!isPlainObject_(c)) throw invalid_('Modification invalide.');
      var id = requireId_(c.id);
      if (!isPlainObject_(c.updates)) throw invalid_('« updates » doit être un objet.');
      return { id: id, updates: normalizeFields_(c.updates, keyField) };
    });
  }

  /** Source-column values from the client: `_` keys refused, the key column too when `lockedKey` is given. */
  function normalizeFields_(fields, lockedKey) {
    var out = {};
    Object.keys(fields).forEach(function (k) {
      if (k.charAt(0) === '_') throw invalid_('Champ non modifiable : « ' + k + ' ».');
      if (lockedKey && Core.normKey(k) === Core.normKey(lockedKey)) {
        throw invalid_('La colonne « ' + lockedKey + ' » ne peut pas être modifiée ici.');
      }
      if (Core.str(k) === '') throw invalid_('Nom de colonne vide.');
      var v = cellValue_(fields[k], k);
      checkCustomField_(k, v);
      out[k] = v;
    });
    return out;
  }

  /** 'DD/MM/YYYY' | '' — also accepts ISO 'YYYY-MM-DD' (converted). */
  function frDate_(v, field) {
    var s = Core.str(v);
    if (s === '') return '';
    if (DATE_FR_RE.test(s) && Core.frToIso(s)) return s;
    var fr = Core.isoToFr(s);
    if (fr) return fr;
    throw invalid_('Date invalide pour « ' + field + ' » : « ' + s + ' » (format attendu JJ/MM/AAAA).');
  }

  function oneOf_(v, allowed, field) {
    var s = Core.str(v);
    if (s !== '' && allowed.indexOf(s) < 0) {
      throw invalid_('Valeur invalide pour « ' + field + ' » : « ' + s + ' » (attendu : ' + allowed.join(', ') + ').');
    }
    return s;
  }

  /** A free-text argument -> trimmed string ('' for null); non-scalars and too long texts are refused. */
  function stringField_(v, field) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return maxLength_(Core.str(v), field);
    throw invalid_('Valeur invalide pour « ' + field + ' ».');
  }

  // -------------------------------------------------------------------------- record helpers

  /** Every application carries Galink / IDP keys (null when absent). */
  function withCustomFields_(rec) {
    var out = {};
    Object.keys(rec).forEach(function (k) { out[k] = rec[k]; });
    Core.APP_CUSTOM_FIELDS.forEach(function (f) {
      if (!hasOwn.call(out, f) || out[f] === undefined) out[f] = null;
    });
    return out;
  }

  function enrichApps_(list) {
    return Core.enrichApplications((list || []).map(withCustomFields_));
  }

  function readPostes_(month) {
    return Core.enrichPostes(Store.readEntityMonth(Config.TABS.postes, month));
  }

  function readApps_(month) {
    return enrichApps_(Store.readEntityMonth(Config.TABS.applications, month));
  }

  /**
   * Column order for a table: source headers first, then any other non-`_` field found in the
   * records (e.g. a generic poste built from the template), then `trailing` fields if missing.
   */
  function columns_(headers, records, trailing) {
    var cols = [];
    var tail = trailing || [];
    (headers || []).forEach(function (h) {
      if (typeof h === 'string' && h !== '' && cols.indexOf(h) < 0) cols.push(h);
    });
    (records || []).forEach(function (r) {
      Object.keys(r).forEach(function (k) {
        if (k.charAt(0) !== '_' && cols.indexOf(k) < 0 && tail.indexOf(k) < 0) cols.push(k);
      });
    });
    tail.forEach(function (f) { if (cols.indexOf(f) < 0) cols.push(f); });
    return cols;
  }

  function pick_(rec, fields) {
    var out = {};
    fields.forEach(function (f) { out[f] = hasOwn.call(rec, f) ? rec[f] : null; });
    out._score = rec._score;
    out._conforme = rec._conforme;
    return out;
  }

  function findById_(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i]._id === id) return list[i];
    return null;
  }

  function notFound_(what) {
    return Core.makeError('NOT_FOUND', what + ' introuvable.');
  }

  /** Action / Replacement rows -> plain objects with every schema field as a string. */
  function normalizeRows_(rows, schema) {
    return (rows || []).map(function (r) {
      var out = {};
      schema.forEach(function (k) { out[k] = r[k] === null || r[k] === undefined ? '' : String(r[k]); });
      return out;
    });
  }

  /**
   * The configured source spreadsheet, checked live (Paramètres only: api_bootstrap never opens it):
   * {id, url, title, tabsFound|null}. The url is built from the id. When the file cannot be opened,
   * tabsFound is null (« Classeur inaccessible ») and the title is the stored one (Config SOURCE_INFO);
   * the failure is logged, never thrown.
   */
  function liveSourceInfo_(cfg, caller) {
    var id = cfg.sourceId;
    var info = { id: id, url: id ? Config.spreadsheetUrl(id) : '', title: id ? cfg.sourceTitle : '', tabsFound: null };
    if (!id) return info;
    try {
      var ss = SpreadsheetApp.openById(id);
      info.title = ss.getName();
      info.tabsFound = Importer.tabsFound_(ss);
    } catch (e) {
      console.warn(caller + ': source ' + id + ' not accessible (' + (e && e.message) + ')');
    }
    return info;
  }

  // -------------------------------------------------------------------------------- bootstrap

  function bootstrap(args, user) {
    var cfg = Config.get();
    var admin = user.role === 'admin';
    // Store.ensure takes the lock itself when it has to write (first-run creation, tab repair) and
    // never replaces a configured data spreadsheet that fails to open (INTERNAL instead).
    Store.ensure();

    var months = Store.listMonths();
    // The spreadsheets are private to the deployer: links are only useful to admins. Neither file is
    // opened for them: URLs are built from the ids, the source title is the stored one (Config.get).
    var showSource = admin && !!cfg.sourceId;
    return {
      configured: !!cfg.sourceId,
      months: months,
      latestMonth: months.length ? months[months.length - 1] : '',
      currentMonth: Config.today().slice(0, 7),
      dataUrl: admin ? Store.dataUrl() : '',
      sourceUrl: showSource ? Config.spreadsheetUrl(cfg.sourceId) : '',
      sourceTitle: showSource ? cfg.sourceTitle : '',
      threshold: cfg.threshold,
      user: { email: user.email, role: user.role, isOwner: user.isOwner },
      prefs: Config.getPrefs(user.email),
      editing: cfg.editing,
      sync: Sync.status()
    };
  }

  /** Interface preferences of the calling account (every role): {sidebar:'open'|'collapsed'}. */
  function savePrefs(args, user) {
    if (!user.email) throw Core.makeError('VALIDATION', 'Identité Google non transmise : préférence non enregistrée.');
    var keys = Object.keys(args || {});
    if (!keys.length) throw Core.makeError('VALIDATION', 'Aucune préférence à enregistrer.');
    var patch = {};
    keys.forEach(function (k) {
      var allowed = Config.PREF_VALUES[k];
      if (!allowed || allowed.indexOf(args[k]) < 0) throw Core.makeError('VALIDATION', 'Préférence invalide : ' + k + '.');
      patch[k] = args[k];
    });
    return { prefs: Config.setPrefs(user.email, patch) };
  }

  function setConfig(args) {
    var input = typeof args.source === 'string' ? args.source : '';
    var id = Core.extractSpreadsheetId(input);
    if (!id) {
      throw invalid_('URL ou identifiant de Google Sheet invalide. Collez l’URL complète du classeur source.');
    }
    var ss = Importer.openById_(id);
    var tabs = Importer.tabsFound_(ss);
    if (!tabs.postes && !tabs.applications) {
      throw Core.makeError('SOURCE_ERROR', 'Le classeur « ' + ss.getName() + ' » ne contient ni l’onglet « ' +
        Core.SOURCE_TABS.postes + ' » ni l’onglet « ' + Core.SOURCE_TABS.applications + ' ».');
    }
    var title = ss.getName();
    Store.withLock(function () { Config.setSourceId(id, title); });
    return { sourceId: id, sourceTitle: title, sourceUrl: Config.spreadsheetUrl(id), tabsFound: tabs, sync: startSync_() };
  }

  /**
   * After a source is saved: makes sure the hourly trigger exists. Never throws (the source is saved
   * either way): without the ScriptApp authorisation the returned status carries `authError`. The
   * client then calls api_syncNow for the first synchronisation.
   */
  function startSync_() {
    try {
      return Sync.enable();
    } catch (e) {
      var st = Sync.status();
      st.authError = e.message;
      return st;
    }
  }

  // ---------------------------------------------------------------------------- sync

  /** Sync status, plus the editing switches: the 10-minute poll also brings other admins' changes. */
  function getSyncStatus() {
    var st = Sync.status();
    st.editing = Config.get().editing;
    return st;
  }

  /** Synchronises the current month now: {status, result}. */
  function syncNow() {
    return Sync.run();
  }

  /** Creates the hourly trigger (if missing), then synchronises: {status, result}. */
  function enableSync() {
    Sync.enable();
    return Sync.run();
  }

  // ---------------------------------------------------------------------------- month data

  function getMonthData(args) {
    var month = requireImportedMonth_(args.month);
    var postes = readPostes_(month);
    var apps = readApps_(month);
    var info = Store.latestImportInfo(month);
    return {
      month: month,
      postes: postes,
      applications: apps,
      referentiel: Store.readReferentiel(month),
      columns: {
        postes: columns_(info && info.postes_headers, postes, []),
        applications: columns_(info && info.apps_headers, apps, Core.APP_CUSTOM_FIELDS)
      },
      importInfo: info ? { imported_at: info.imported_at, warnings: info.warnings || [] } : null
    };
  }

  /** The `limit` latest ImportLog entries, newest first, with the fields the journal shows only. */
  function getImportLog(args) {
    var limit = args.limit === undefined || args.limit === null ? IMPORT_LOG_LIMIT : args.limit;
    if (typeof limit !== 'number' || Math.floor(limit) !== limit || limit < 1 || limit > IMPORT_LOG_MAX_LIMIT) {
      throw invalid_('« limit » doit être un entier entre 1 et ' + IMPORT_LOG_MAX_LIMIT + '.');
    }
    return Store.recentImportLog(limit).map(function (e) {
      return { month: e.month, imported_at: e.imported_at, counts: e.counts, warnings: e.warnings, changes: e.changes };
    });
  }

  // ------------------------------------------------------------------------- entity edits

  /**
   * The current month follows the source (Sync): its edits are written into the source spreadsheet
   * first (Importer write-back), then into the snapshot, so the next hourly sync reads them back. Past
   * months are frozen history: their edits change the snapshot only.
   */
  function isLive_(month) {
    return month === Sync.currentMonth();
  }

  /**
   * How many records of `list` (a stored month) share the key of `rec` (normKey): passed to the
   * write-back (Importer snapshotCount), which refuses a name the snapshot holds more than once.
   */
  function snapshotCount_(list, rec, keyField) {
    var k = Core.normKey(rec[keyField]);
    return list.filter(function (r) { return Core.normKey(r[keyField]) === k; }).length;
  }

  function saveEntities_(tab, entity, keyField, enrich, args) {
    requireEditing_('edit');
    var month = requireMonth_(args.month);
    var changes = normalizeChanges_(args.changes, keyField);
    if (!changes.length) return { updated: [], sourceUpdated: false };
    return Store.withLock(function () {
      requireImported_(month);
      var live = isLive_(month);
      if (live) {
        var stored = Store.readEntityMonth(tab, month);
        Importer.writeEdits(entity, changes.map(function (c) {
          var rec = findById_(stored, c.id);
          if (!rec) throw notFound_(entity === 'postes' ? 'Poste' : 'Application');
          return { name: Core.str(rec[keyField]), fields: c.updates, snapshotCount: snapshotCount_(stored, rec, keyField) };
        }));
      }
      return { updated: enrich(Store.updateEntityRows(tab, month, changes)), sourceUpdated: live };
    });
  }

  function savePostes(args) {
    return saveEntities_(Config.TABS.postes, 'postes', Core.KEY_POSTE, Core.enrichPostes, args);
  }

  function saveApplications(args) {
    return saveEntities_(Config.TABS.applications, 'applications', Core.KEY_APP, enrichApps_, args);
  }

  function addGenericPoste(args) {
    requireEditing_('create');
    var month = requireMonth_(args.month);
    return Store.withLock(function () {
      requireImported_(month);
      var existing = Store.readEntityMonth(Config.TABS.postes, month);
      var names = existing.map(function (r) { return r[Core.KEY_POSTE]; });
      var info = Store.latestImportInfo(month);
      var template = info && info.postes_headers && info.postes_headers.length ? info.postes_headers : [];
      var rec = Core.makeGenericPoste(template, names);
      if (!rec) {
        var target = Core.normKey(Core.GENERIC_POSTE_NAME);
        var found = existing.filter(function (r) { return Core.normKey(r[Core.KEY_POSTE]) === target; })[0];
        return { created: false, record: Core.enrichPostes([found])[0] };
      }
      if (isLive_(month)) {
        // Not a form: the sheet's rules are not enforced, computed columns are left to their formulas.
        var res = Importer.appendRecord('postes', rec, { strict: false });
        assign_(rec, res.computed);
      }
      var stored = Store.appendEntityRow(Config.TABS.postes, month, rec, Core.KEY_POSTE);
      return { created: true, record: Core.enrichPostes([stored])[0] };
    });
  }

  /** Copies the own keys of `from` onto `to`. */
  function assign_(to, from) {
    Object.keys(from || {}).forEach(function (k) { to[k] = from[k]; });
    return to;
  }

  /** What differs between postes and applications for the creation forms (built at call time: Core may load later). */
  function entity_(entity) {
    return entity === 'postes' ?
      { tab: Config.TABS.postes, keyField: Core.KEY_POSTE, trailing: [], enrich: Core.enrichPostes, label: 'Le poste',
        missingName: 'Le nom du poste est obligatoire.' } :
      { tab: Config.TABS.applications, keyField: Core.KEY_APP, trailing: Core.APP_CUSTOM_FIELDS, enrich: enrichApps_,
        label: 'L’application', missingName: 'Le nom de l’application est obligatoire.' };
  }

  /**
   * VALIDATION (field = the key column) when another record of the month already has `name` (compared
   * with normKey).
   */
  function requireFreeName_(entity, list, name, exceptId, month) {
    var e = entity_(entity);
    var target = Core.normKey(name);
    if (list.some(function (r) { return r._id !== exceptId && Core.normKey(r[e.keyField]) === target; })) {
      throw invalid_(e.label + ' « ' + name + ' » existe déjà pour ' + month + '.', e.keyField);
    }
  }

  /** Snapshot headers of an entity for `month` (ImportLog), [] when unknown. */
  function snapshotHeaders_(entity, month) {
    var info = Store.latestImportInfo(month);
    var headers = info && (entity === 'postes' ? info.postes_headers : info.apps_headers);
    return { info: info, headers: Array.isArray(headers) ? headers : [] };
  }

  /**
   * Adds a record from a creation form (api_addPoste / api_addApplication). Checked before the lock:
   * `record` is an object, the key is not blank, `_` keys / non-scalar values / Galink-IDP values are
   * refused. Under the lock: the month is imported and the name is free (VALIDATION, field = the key);
   * current month: Importer.appendRecord(strict) checks the values against the source sheet and writes
   * the row first (its computed columns come back with the values written); past month: the values are
   * checked against the snapshot's columns (Core.snapshotFormColumns: computed columns are ordinary
   * fields, only Oui/Non lists are strict). The new record has every snapshot column (null when not
   * given) and is appended to the snapshot. Returns the enriched record.
   */
  function addEntity_(entity, args) {
    requireEditing_('create');
    var e = entity_(entity);
    var month = requireMonth_(args.month);
    if (!isPlainObject_(args.record)) throw invalid_('« record » doit être un objet.');
    var name = stringField_(args.record[e.keyField], e.keyField);
    if (!name) throw invalid_(e.missingName, e.keyField);
    var fields = normalizeFields_(args.record);
    Object.keys(fields).forEach(function (k) {
      if (k !== e.keyField && Core.normKey(k) === Core.normKey(e.keyField)) delete fields[k];
    });
    fields[e.keyField] = name;

    return Store.withLock(function () {
      requireImported_(month);
      var tab = e.tab;
      requireFreeName_(entity, Store.readEntityMonth(tab, month), name, null, month);
      var snap = snapshotHeaders_(entity, month);
      var headers = snap.headers.length || entity !== 'postes' ? snap.headers : Core.POSTE_TEMPLATE_KEYS;
      var rec = {};
      columns_(headers, [], e.trailing).forEach(function (h) { rec[h] = null; });
      if (isLive_(month)) {
        var res = Importer.appendRecord(entity, fields, { strict: true });
        assign_(rec, res.values);
        assign_(rec, res.computed);
        // App-only fields (Galink / IDP) the source has no column for: snapshot only.
        e.trailing.forEach(function (f) {
          if (!hasOwn.call(res.values, f) && hasOwn.call(fields, f)) rec[f] = fields[f];
        });
      } else {
        var checked = Core.checkFormRecord(Core.snapshotFormColumns(entity, snap.headers, Store.readReferentiel(month)), fields);
        if (!checked.ok) throw invalid_(checked.message, checked.field);
        assign_(rec, checked.record);
      }
      rec[e.keyField] = name;
      var stored = Store.appendEntityRow(tab, month, rec, e.keyField);
      return e.enrich([stored])[0];
    });
  }

  function addPoste(args) {
    return addEntity_('postes', args);
  }

  function addApplication(args) {
    return addEntity_('applications', args);
  }

  // ---------------------------------------------------------------------------- form schema

  /** Galink / IDP form columns an applications schema read from the source lacks (app-only fields). */
  function withAppOnlyColumns_(columns) {
    var names = columns.map(function (c) { return c.name; });
    Core.APP_CUSTOM_FIELDS.forEach(function (f) {
      if (names.indexOf(f) < 0) {
        columns.push({ name: f, kind: 'select', options: ['Oui', 'Non'], strict: true, computed: false, required: false,
          appOnly: true });
      }
    });
    return columns;
  }

  /**
   * Fields of a creation form: {entity, month, live, origin, keyField, readAt, warning?, columns}
   * (docs/API.md §3). Current month: read from the source outside the lock (Importer.readFormSchema,
   * cached 5 min; `fresh` reads again), origin 'source'; when the source is not configured or cannot be
   * read, the columns of the last synchronisation (origin 'fallback', with a warning: never fails, nothing
   * cached). Past month: the snapshot's columns (origin 'snapshot'); the source is never opened.
   */
  function getFormSchema(args) {
    requireEditing_('create');
    var entity = args.entity;
    if (entity !== 'postes' && entity !== 'applications') {
      throw invalid_('« entity » doit valoir « postes » ou « applications ».');
    }
    var month = requireMonth_(args.month);
    var live = isLive_(month);
    var out = { entity: entity, month: month, live: live, origin: 'snapshot', keyField: entity_(entity).keyField,
      readAt: '', columns: [] };
    if (live) {
      try {
        var schema = Importer.readFormSchema(entity, { fresh: args.fresh === true });
        out.origin = 'source';
        out.readAt = schema.readAt;
        out.columns = entity === 'applications' ? withAppOnlyColumns_(schema.columns) : schema.columns;
        return out;
      } catch (e) {
        if (!e || (e.code !== 'NOT_CONFIGURED' && e.code !== 'SOURCE_ERROR')) throw e;
        console.warn('api_getFormSchema: source not readable (' + e.code + '), using the last synchronisation');
        out.origin = 'fallback';
        out.warning = e.code === 'NOT_CONFIGURED' ?
          'Aucun Google Sheet source n’est configuré : les champs viennent de la dernière synchronisation.' :
          'Le Google Sheet source n’a pas pu être lu : les champs et les listes viennent de la dernière ' +
          'synchronisation. Les colonnes calculées et les règles de la source seront vérifiées à l’enregistrement.';
      }
    } else {
      requireImported_(month);
    }
    var snap = snapshotHeaders_(entity, month);
    out.readAt = snap.info ? snap.info.imported_at : '';
    out.columns = Core.snapshotFormColumns(entity, snap.headers, snap.info ? Store.readReferentiel(month) : {});
    return out;
  }

  /**
   * Current month: the source row goes first (Importer.deleteRecord refuses a name several source rows or
   * several records of the month's snapshot share, and a row holding an array formula), then the snapshot row.
   */
  function deleteApplication(args) {
    requireEditing_('delete');
    var month = requireMonth_(args.month);
    var id = requireId_(args.id);
    return Store.withLock(function () {
      if (isLive_(month)) {
        var apps = Store.readEntityMonth(Config.TABS.applications, month);
        var rec = findById_(apps, id);
        if (!rec) throw notFound_('Application');
        Importer.deleteRecord('applications', Core.str(rec[Core.KEY_APP]),
          { snapshotCount: snapshotCount_(apps, rec, Core.KEY_APP) });
      }
      if (!Store.deleteEntityRow(Config.TABS.applications, month, id)) throw notFound_('Application');
      return { deleted: true, id: id };
    });
  }

  /**
   * Renames an application and the target_name of every Action pointing to its old name. Current month:
   * the source key cell first (Importer.writeEdits also refuses a name another source row has, and an old
   * name several source rows or several records of the month's snapshot share).
   */
  function renameApplication(args) {
    requireEditing_('edit');
    var month = requireMonth_(args.month);
    var id = requireId_(args.id);
    var newName = stringField_(args.newName, 'newName');
    if (!newName) throw invalid_('Le nouveau nom est obligatoire.');

    return Store.withLock(function () {
      var apps = Store.readEntityMonth(Config.TABS.applications, month);
      var current = findById_(apps, id);
      if (!current) throw notFound_('Application');
      requireFreeName_('applications', apps, newName, id, month);
      var oldName = Core.str(current[Core.KEY_APP]);
      if (oldName === newName) return { record: enrichApps_([current])[0], actionsUpdated: 0 };

      var upd = {};
      upd[Core.KEY_APP] = newName;
      if (isLive_(month)) {
        Importer.writeEdits('applications', [{ name: oldName, fields: upd,
          snapshotCount: snapshotCount_(apps, current, Core.KEY_APP) }]);
      }
      var updated = Store.updateEntityRows(Config.TABS.applications, month, [{ id: id, updates: upd }])[0];
      var n = Store.updateRowsWhere(Config.TABS.actions,
        function (a) { return a.target_type === 'application' && a.target_name === oldName; },
        function () { return { target_name: newName }; });
      return { record: enrichApps_([updated])[0], actionsUpdated: n };
    });
  }

  // ------------------------------------------------------------------------------- timeline

  function getTimeline() {
    var postesAll = Store.readEntityAll(Config.TABS.postes);
    var appsAll = Store.readEntityAll(Config.TABS.applications);
    return Store.listMonths().map(function (m) {
      return {
        month: m,
        postes: Core.enrichPostes(postesAll[m] || []).map(function (r) { return pick_(r, POSTE_SLIM_FIELDS); }),
        applications: enrichApps_(appsAll[m] || []).map(function (r) { return pick_(r, APP_SLIM_FIELDS); })
      };
    });
  }

  // -------------------------------------------------------------------------------- actions

  /** Client-writable fields: the sheet schema minus the server-managed id / stamps (read at call time:
   *  Config may load after this file). */
  function writableFields_(tab) {
    return Config.SCHEMAS[tab].filter(function (f) { return ['id', 'recorded_at', 'updated_at'].indexOf(f) < 0; });
  }

  /** New Action / Replacement row: validated fields + defaults + stamps, id generated under the lock. */
  function insertRecord_(tab, fields, normalize, args, defaults) {
    var rec = { id: '' };
    fields.forEach(function (f) { rec[f] = normalize(f, args[f]); });
    Object.keys(defaults).forEach(function (f) { if (!rec[f]) rec[f] = defaults[f]; });
    rec.recorded_at = Config.today();
    return Store.withLock(function () {
      rec.id = Config.uuid();
      return normalizeRows_([Store.insertRow(tab, rec)], Config.SCHEMAS[tab])[0];
    });
  }

  function updateRecord_(tab, id, patch) {
    return Store.withLock(function () {
      return normalizeRows_([Store.updateRow(tab, id, patch)], Config.SCHEMAS[tab])[0];
    });
  }

  /** Validates / normalises one Action field value. */
  function actionField_(field, value) {
    switch (field) {
      case 'target_type': {
        var t = stringField_(value, field);
        if (t !== 'poste' && t !== 'application') {
          throw invalid_('Type de cible invalide : « ' + t + ' » (attendu : poste ou application).');
        }
        return t;
      }
      case 'target_name':
      case 'action': {
        var s = stringField_(value, field);
        if (!s) throw invalid_(field === 'action' ? 'L’action est obligatoire.' : 'La cible de l’action est obligatoire.');
        return s;
      }
      case 'date_created':
      case 'date_completed':
      case 'deadline':
        return frDate_(stringField_(value, field), field);
      case 'priorite':
        return oneOf_(stringField_(value, field), Core.ACTION_PRIORITIES, 'priorité');
      case 'status':
        return oneOf_(stringField_(value, field), Core.ACTION_STATUSES, 'statut');
      case 'source_month': {
        var m = stringField_(value, field);
        if (m !== '') requireMonth_(m, 'mois source');
        return m;
      }
      default:
        return stringField_(value, field);
    }
  }

  /** Refuses non-updatable / unknown keys; returns the validated patch. */
  function patch_(updates, allowed, normalize) {
    if (!isPlainObject_(updates)) throw invalid_('« updates » doit être un objet.');
    var out = {};
    Object.keys(updates).forEach(function (k) {
      if (k === 'id' || k === 'recorded_at') throw invalid_('Champ non modifiable : « ' + k + ' ».');
      if (allowed.indexOf(k) < 0) throw invalid_('Champ inconnu : « ' + k + ' ».');
      out[k] = normalize(k, updates[k]);
    });
    return out;
  }

  function getActions() {
    function rows(tab) { return normalizeRows_(Store.listRows(tab), Config.SCHEMAS[tab]); }
    return { actions: rows(Config.TABS.actions), replacements: rows(Config.TABS.replacements) };
  }

  function addAction(args) {
    return insertRecord_(Config.TABS.actions, writableFields_(Config.TABS.actions), actionField_, args,
      { status: 'À faire', date_created: Config.todayFr(), updated_at: '' });
  }

  function updateAction(args) {
    var id = requireId_(args.id);
    // A client-sent updated_at is tolerated (whole objects round-trip) but always replaced by today.
    var patch = patch_(args.updates, writableFields_(Config.TABS.actions).concat(['updated_at']), function (k, v) {
      return k === 'updated_at' ? '' : actionField_(k, v);
    });
    patch.updated_at = Config.today();
    return updateRecord_(Config.TABS.actions, id, patch);
  }

  function deleteRowById_(tab, args, what) {
    var id = requireId_(args.id);
    return Store.withLock(function () {
      if (!Store.deleteRow(tab, id)) throw notFound_(what);
      return { deleted: true, id: id };
    });
  }

  function deleteAction(args) {
    return deleteRowById_(Config.TABS.actions, args, 'Action');
  }

  // --------------------------------------------------------------------------- replacements

  function replacementField_(field, value) {
    if (field === 'old_poste' || field === 'new_poste') {
      var s = stringField_(value, field);
      if (!s) throw invalid_(field === 'old_poste' ? 'L’ancien poste est obligatoire.' : 'Le nouveau poste est obligatoire.');
      return s;
    }
    if (field === 'date_replacement') return frDate_(stringField_(value, field), field);
    return stringField_(value, field);
  }

  function addReplacement(args) {
    return insertRecord_(Config.TABS.replacements, writableFields_(Config.TABS.replacements), replacementField_, args,
      { date_replacement: Config.todayFr() });
  }

  function updateReplacement(args) {
    var id = requireId_(args.id);
    return updateRecord_(Config.TABS.replacements, id, patch_(args.updates, writableFields_(Config.TABS.replacements), replacementField_));
  }

  function deleteReplacement(args) {
    return deleteRowById_(Config.TABS.replacements, args, 'Remplacement');
  }

  // ------------------------------------------------------------------------------- settings

  function accessView_(access, owner) {
    function entries(list) {
      return (list || []).map(function (e) {
        return { email: Access.normEmail(e.email), role: e.role, added_at: e.added_at, added_by: e.added_by };
      }).filter(function (e) { return e.email !== owner; })
        .sort(function (a, b) { return a.email < b.email ? -1 : a.email > b.email ? 1 : 0; });
    }
    return { owner: owner, users: entries(access.users), groups: entries(access.groups),
      domainRole: access.domainRole === 'lecteur' ? 'lecteur' : 'none' };
  }

  /**
   * Every write to the access list: under the lock, change(access) edits the stored list (returning false
   * = nothing to write), check(access) may refuse the result (no self lock-out); returns the AccessView.
   */
  function mutateAccess_(user, change, check) {
    return Store.withLock(function () {
      var access = Config.get({ fresh: true }).access;
      var changed = change(access) !== false;
      if (check) check(access);
      if (changed) Config.setAccess(access);
      return accessView_(access, user.owner);
    });
  }

  /** Adds `email` with `role` to `list`, or changes its role; beforeAdd() may refuse a new entry. */
  function upsertEntry_(list, email, role, user, beforeAdd) {
    var existing = list.filter(function (e) { return Access.normEmail(e.email) === email; })[0];
    if (existing) {
      existing.email = email;
      existing.role = role;
      return;
    }
    if (beforeAdd) beforeAdd();
    list.push({ email: email, role: role, added_at: Config.today(), added_by: user.email });
  }

  /** `list` without `email`; NOT_FOUND (missingText) when it was not there. */
  function withoutEntry_(list, email, missingText) {
    var kept = list.filter(function (e) { return Access.normEmail(e.email) !== email; });
    if (kept.length === list.length) throw Core.makeError('NOT_FOUND', missingText);
    return kept;
  }

  function getSettings(args, user) {
    var cfg = Config.get();
    var source = liveSourceInfo_(cfg, 'api_getSettings');
    return {
      threshold: cfg.threshold,
      defaultThreshold: Core.THRESHOLD,
      source: source,
      dataUrl: cfg.dataId ? Store.dataUrl() : '',
      access: accessView_(cfg.access, user.owner),
      me: user.email,
      editing: cfg.editing,
      sync: Sync.verifiedStatus()
    };
  }

  function setThreshold(args) {
    var n = Core.validateThreshold(args.threshold);
    if (n === null) throw invalid_('Seuil invalide : un nombre entier entre 1 et 100 est attendu.');
    Store.withLock(function () { Config.setThreshold(n); });
    Core.setThreshold(n);
    return { threshold: n };
  }

  /**
   * Turns switches of « Saisie dans l’application » on or off: args = {edit?, create?, delete?}
   * (booleans, at least one). Under the lock the stored switches are read again and the patch merged
   * into them, so the keys not sent are kept. @return {{editing: Object}} the three switches stored
   */
  function setEditing(args) {
    var keys = Object.keys(args || {});
    if (!keys.length) throw invalid_('Aucun réglage à enregistrer.');
    keys.forEach(function (k) {
      if (Config.EDITING_KEYS.indexOf(k) < 0) throw invalid_('Réglage inconnu : « ' + k + ' ».');
      if (typeof args[k] !== 'boolean') throw invalid_('« ' + k + ' » doit valoir true ou false.');
    });
    return Store.withLock(function () {
      // The memo was dropped when the lock was taken: this is the stored value.
      var editing = Config.get().editing;
      keys.forEach(function (k) { editing[k] = args[k]; });
      Config.setEditing(editing);
      return { editing: editing };
    });
  }

  /** Common guards of saveUser / removeUser: owner and own account are not editable. */
  function editableEmail_(value, user) {
    var email = Access.checkEmail(value);
    if (email === user.owner) throw invalid_('Le propriétaire du déploiement est toujours administrateur.');
    if (email === user.email) throw invalid_('Vous ne pouvez pas modifier votre propre accès.');
    return email;
  }

  function saveUser(args, user) {
    var email = editableEmail_(args.email, user);
    var role = Access.checkRole(args.role);
    return mutateAccess_(user, function (access) {
      upsertEntry_(access.users, email, role, user, function () { requireRoom_(access, 1); });
    });
  }

  var MAX_BATCH = 500;

  function requireRoom_(access, extra) {
    if (access.users.length + extra > Config.MAX_USERS) {
      throw invalid_('La liste d’accès est limitée à ' + Config.MAX_USERS + ' comptes. Pour tout le domaine, ' +
        'réglez plutôt « Autres comptes du domaine » sur Lecteur.');
    }
  }

  /**
   * Adds many accounts with one role in one write. Entries that cannot be added are skipped with a
   * reason (the client previews them first); the owner and the caller are never touched.
   * @return {{access: Object, added: string[], updated: string[], skipped: {email: string, reason: string}[]}}
   */
  function addUsers(args, user) {
    var role = Access.checkRole(args.role);
    if (!Array.isArray(args.emails) || !args.emails.length) throw invalid_('Aucune adresse à ajouter.');
    if (args.emails.length > MAX_BATCH) throw invalid_('Au plus ' + MAX_BATCH + ' adresses par ajout.');
    var skipped = [];
    var wanted = [];
    args.emails.forEach(function (v) {
      var email = Access.normEmail(v);
      var reason = !Core.isEmail(email) ? 'adresse invalide' : email === user.owner ? 'propriétaire' :
        email === user.email ? 'votre propre compte' : wanted.indexOf(email) >= 0 ? 'doublon' : '';
      if (reason) skipped.push({ email: typeof v === 'string' ? v : Core.str(v), reason: reason });
      else wanted.push(email);
    });
    var result = { added: [], updated: [], skipped: skipped };
    result.access = mutateAccess_(user, function (access) {
      var byEmail = {};
      access.users.forEach(function (u) { byEmail[Access.normEmail(u.email)] = u; });
      var added = result.added;
      var updated = result.updated;
      wanted.forEach(function (email) {
        var hit = byEmail[email];
        if (!hit) added.push(email);
        else if (hit.role !== role) updated.push(email);
        else skipped.push({ email: email, reason: 'déjà ' + (role === 'admin' ? 'administrateur' : 'lecteur') });
      });
      requireRoom_(access, added.length);
      var today = Config.today();
      updated.forEach(function (email) { byEmail[email].role = role; });
      added.forEach(function (email) {
        access.users.push({ email: email, role: role, added_at: today, added_by: user.email });
      });
      return added.length + updated.length > 0;
    });
    return result;
  }

  /** No self lock-out through groups: the caller must still be admin with the new list. */
  function requireStillAdmin_(user, access) {
    if (Access.roleOf(user.email, user.owner, access) !== 'admin') {
      throw invalid_('Ce changement vous retirerait le rôle administrateur (vous l’avez par ce groupe).');
    }
  }

  /** Adds a Google Group with a role, or changes its role. The group must be readable by the owner. */
  function saveGroup(args, user) {
    var role = Access.checkRole(args.role);
    var email = Access.checkGroup(args.email); // GroupsApp call: outside the lock
    return mutateAccess_(user, function (access) {
      upsertEntry_(access.groups, email, role, user, function () {
        if (access.groups.length >= Config.MAX_GROUPS) throw invalid_('La liste est limitée à ' + Config.MAX_GROUPS + ' groupes.');
      });
    }, function (access) { requireStillAdmin_(user, access); });
  }

  function removeGroup(args, user) {
    var email = Access.checkEmail(args.email);
    return mutateAccess_(user, function (access) {
      access.groups = withoutEntry_(access.groups, email, 'Aucun groupe enregistré : ' + email + '.');
    }, function (access) { requireStillAdmin_(user, access); });
  }

  function removeUser(args, user) {
    var email = editableEmail_(args.email, user);
    return mutateAccess_(user, function (access) {
      access.users = withoutEntry_(access.users, email, 'Aucun accès enregistré pour ' + email + '.');
    });
  }

  function setDomainRole(args, user) {
    var role = Access.checkRole(args.role, Access.DOMAIN_ROLES);
    return mutateAccess_(user, function (access) { access.domainRole = role; });
  }

  // ----------------------------------------------------------------------------------- diff

  function getDiff(args) {
    var oldMonth = requireImportedMonth_(args.oldMonth, 'ancien mois');
    var newMonth = requireImportedMonth_(args.newMonth, 'nouveau mois');
    return {
      oldMonth: oldMonth,
      newMonth: newMonth,
      postes: Core.diffPostes(readPostes_(oldMonth), readPostes_(newMonth)),
      applications: Core.diffApplications(readApps_(oldMonth), readApps_(newMonth))
    };
  }

  return {
    bootstrap: bootstrap,
    savePrefs: savePrefs,
    setConfig: setConfig,
    getMonthData: getMonthData,
    getSyncStatus: getSyncStatus,
    syncNow: syncNow,
    enableSync: enableSync,
    getImportLog: getImportLog,
    savePostes: savePostes,
    addGenericPoste: addGenericPoste,
    addPoste: addPoste,
    getFormSchema: getFormSchema,
    saveApplications: saveApplications,
    addApplication: addApplication,
    deleteApplication: deleteApplication,
    renameApplication: renameApplication,
    getTimeline: getTimeline,
    getActions: getActions,
    addAction: addAction,
    updateAction: updateAction,
    deleteAction: deleteAction,
    addReplacement: addReplacement,
    updateReplacement: updateReplacement,
    deleteReplacement: deleteReplacement,
    getDiff: getDiff,
    getSettings: getSettings,
    setThreshold: setThreshold,
    setEditing: setEditing,
    saveUser: saveUser,
    addUsers: addUsers,
    saveGroup: saveGroup,
    removeGroup: removeGroup,
    removeUser: removeUser,
    setDomainRole: setDomainRole
  };
})();

// ------------------------------------------------------------------------- public entry points
// Function declarations (not vars) so that google.script.run and the editor can see them.

function api_bootstrap(argsJson) { return apiWrap_(ApiImpl_.bootstrap, 'api_bootstrap', 'lecteur')(argsJson); }
function api_savePrefs(argsJson) { return apiWrap_(ApiImpl_.savePrefs, 'api_savePrefs', 'lecteur')(argsJson); }
function api_setConfig(argsJson) { return apiWrap_(ApiImpl_.setConfig, 'api_setConfig', 'admin')(argsJson); }
function api_getMonthData(argsJson) { return apiWrap_(ApiImpl_.getMonthData, 'api_getMonthData', 'lecteur')(argsJson); }
function api_getSyncStatus(argsJson) { return apiWrap_(ApiImpl_.getSyncStatus, 'api_getSyncStatus', 'lecteur')(argsJson); }
function api_syncNow(argsJson) { return apiWrap_(ApiImpl_.syncNow, 'api_syncNow', 'admin')(argsJson); }
function api_enableSync(argsJson) { return apiWrap_(ApiImpl_.enableSync, 'api_enableSync', 'admin')(argsJson); }
function api_getImportLog(argsJson) { return apiWrap_(ApiImpl_.getImportLog, 'api_getImportLog', 'lecteur')(argsJson); }
function api_savePostes(argsJson) { return apiWrap_(ApiImpl_.savePostes, 'api_savePostes', 'admin')(argsJson); }
function api_addGenericPoste(argsJson) { return apiWrap_(ApiImpl_.addGenericPoste, 'api_addGenericPoste', 'admin')(argsJson); }
function api_addPoste(argsJson) { return apiWrap_(ApiImpl_.addPoste, 'api_addPoste', 'admin')(argsJson); }
function api_getFormSchema(argsJson) { return apiWrap_(ApiImpl_.getFormSchema, 'api_getFormSchema', 'admin')(argsJson); }
function api_saveApplications(argsJson) { return apiWrap_(ApiImpl_.saveApplications, 'api_saveApplications', 'admin')(argsJson); }
function api_addApplication(argsJson) { return apiWrap_(ApiImpl_.addApplication, 'api_addApplication', 'admin')(argsJson); }
function api_deleteApplication(argsJson) { return apiWrap_(ApiImpl_.deleteApplication, 'api_deleteApplication', 'admin')(argsJson); }
function api_renameApplication(argsJson) { return apiWrap_(ApiImpl_.renameApplication, 'api_renameApplication', 'admin')(argsJson); }
function api_getTimeline(argsJson) { return apiWrap_(ApiImpl_.getTimeline, 'api_getTimeline', 'lecteur')(argsJson); }
function api_getActions(argsJson) { return apiWrap_(ApiImpl_.getActions, 'api_getActions', 'lecteur')(argsJson); }
function api_addAction(argsJson) { return apiWrap_(ApiImpl_.addAction, 'api_addAction', 'admin')(argsJson); }
function api_updateAction(argsJson) { return apiWrap_(ApiImpl_.updateAction, 'api_updateAction', 'admin')(argsJson); }
function api_deleteAction(argsJson) { return apiWrap_(ApiImpl_.deleteAction, 'api_deleteAction', 'admin')(argsJson); }
function api_addReplacement(argsJson) { return apiWrap_(ApiImpl_.addReplacement, 'api_addReplacement', 'admin')(argsJson); }
function api_updateReplacement(argsJson) { return apiWrap_(ApiImpl_.updateReplacement, 'api_updateReplacement', 'admin')(argsJson); }
function api_deleteReplacement(argsJson) { return apiWrap_(ApiImpl_.deleteReplacement, 'api_deleteReplacement', 'admin')(argsJson); }
function api_getDiff(argsJson) { return apiWrap_(ApiImpl_.getDiff, 'api_getDiff', 'lecteur')(argsJson); }
function api_getSettings(argsJson) { return apiWrap_(ApiImpl_.getSettings, 'api_getSettings', 'admin')(argsJson); }
function api_setThreshold(argsJson) { return apiWrap_(ApiImpl_.setThreshold, 'api_setThreshold', 'admin')(argsJson); }
function api_setEditing(argsJson) { return apiWrap_(ApiImpl_.setEditing, 'api_setEditing', 'admin')(argsJson); }
function api_saveUser(argsJson) { return apiWrap_(ApiImpl_.saveUser, 'api_saveUser', 'admin')(argsJson); }
function api_addUsers(argsJson) { return apiWrap_(ApiImpl_.addUsers, 'api_addUsers', 'admin')(argsJson); }
function api_saveGroup(argsJson) { return apiWrap_(ApiImpl_.saveGroup, 'api_saveGroup', 'admin')(argsJson); }
function api_removeGroup(argsJson) { return apiWrap_(ApiImpl_.removeGroup, 'api_removeGroup', 'admin')(argsJson); }
function api_removeUser(argsJson) { return apiWrap_(ApiImpl_.removeUser, 'api_removeUser', 'admin')(argsJson); }
function api_setDomainRole(argsJson) { return apiWrap_(ApiImpl_.setDomainRole, 'api_setDomainRole', 'admin')(argsJson); }
