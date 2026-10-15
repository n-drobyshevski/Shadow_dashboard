/**
 * Api — google.script.run entry points (docs/API.md §3).
 *
 * Every public api_* function takes ONE JSON string and returns ONE JSON string:
 *   {ok:true, data} | {ok:false, error:{code, message}}
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
 * Wraps an implementation `fn(args, user) -> data` into the JSON envelope. The caller's role is
 * checked first (Access.requireRole, FORBIDDEN otherwise) and the effective compliance threshold is
 * applied to Core for the duration of the call. Errors whose `.code` is one of Core.ERROR_CODES are
 * reported as-is (their messages are ours, in French); anything else becomes INTERNAL. The stack is
 * logged with console.error and never sent to the client.
 * @param {function(Object, Object): *} fn
 * @param {string=} name used in logs
 * @param {string=} minRole 'lecteur' (default) | 'admin'
 * @return {function(string): string}
 */
function apiWrap_(fn, name, minRole) {
  return function (argsJson) {
    try {
      var cfg = Config.get();
      var user = Access.requireRole(minRole || 'lecteur', cfg.access);
      Core.setThreshold(cfg.threshold);
      var args = parseArgs_(argsJson);
      var data = fn(args, user);
      return JSON.stringify({ ok: true, data: data === undefined ? null : data });
    } catch (err) {
      var e = err || {};
      var known = Core.ERROR_CODES.indexOf(e.code) >= 0 && e.code !== 'INTERNAL';
      var code = known ? e.code : 'INTERNAL';
      var message = known ? String(e.message || code) : internalMessage_(e);
      if (code === 'FORBIDDEN') console.warn('[' + (name || 'api') + '] ' + code + ': ' + message);
      else console.error('[' + (name || 'api') + '] ' + code + ': ' + (e.stack || e.message || String(err)));
      return JSON.stringify({ ok: false, error: { code: code, message: message } });
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

  var hasOwn = Object.prototype.hasOwnProperty;

  // ------------------------------------------------------------------------------- validation

  function invalid_(message) {
    return Core.makeError('VALIDATION', message);
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
  }

  function requireId_(id) {
    var s = typeof id === 'string' || typeof id === 'number' ? Core.str(id) : '';
    if (!s) throw invalid_('Identifiant manquant.');
    return s;
  }

  function isPlainObject_(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** A cell value coming from the client -> string | null. Objects / arrays are refused. */
  function cellValue_(v, field) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return Core.isBlank(v) ? null : v;
    if (typeof v === 'number') return isFinite(v) ? String(v) : null;
    if (typeof v === 'boolean') return String(v);
    throw invalid_('Valeur invalide pour « ' + field + ' ».');
  }

  /** Galink / IDP only accept 'Oui', 'Non' or blank. */
  function checkCustomField_(field, value) {
    if (Core.APP_CUSTOM_FIELDS.indexOf(field) >= 0 && value !== null && value !== 'Oui' && value !== 'Non') {
      throw invalid_('« ' + field + ' » doit valoir « Oui », « Non » ou être vide.');
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
      var updates = {};
      Object.keys(c.updates).forEach(function (k) {
        if (k.charAt(0) === '_') throw invalid_('Champ non modifiable : « ' + k + ' ».');
        if (Core.normKey(k) === Core.normKey(keyField)) {
          throw invalid_('La colonne « ' + keyField + ' » ne peut pas être modifiée ici.');
        }
        if (Core.str(k) === '') throw invalid_('Nom de colonne vide.');
        var v = cellValue_(c.updates[k], k);
        checkCustomField_(k, v);
        updates[k] = v;
      });
      return { id: id, updates: updates };
    });
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

  function stringField_(v, field) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return Core.str(v);
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

  function enrichPostes_(list) {
    return Core.enrichPostes(list);
  }

  function enrichApps_(list) {
    return Core.enrichApplications((list || []).map(withCustomFields_));
  }

  function readPostes_(month) {
    return enrichPostes_(Store.readEntityMonth(Config.TABS.postes, month));
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

  function sourceUrl_(id) {
    return 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
  }

  // -------------------------------------------------------------------------------- bootstrap

  function bootstrap(args, user) {
    var cfg = Config.get();
    var admin = user.role === 'admin';
    // Store.ensure takes the lock itself when it has to write (first-run creation, tab repair) and
    // never replaces a configured data spreadsheet that fails to open (INTERNAL instead).
    Store.ensure();

    var months = Store.listMonths();
    var sourceUrl = '';
    var sourceTitle = '';
    // The spreadsheets are private to the deployer: links are only useful to admins.
    if (cfg.sourceId && admin) {
      sourceUrl = sourceUrl_(cfg.sourceId);
      try {
        var src = SpreadsheetApp.openById(cfg.sourceId);
        sourceUrl = src.getUrl();
        sourceTitle = src.getName();
      } catch (e) {
        console.warn('api_bootstrap: source ' + cfg.sourceId + ' not accessible (' + (e && e.message) + ')');
      }
    }
    return {
      configured: !!cfg.sourceId,
      months: months,
      latestMonth: months.length ? months[months.length - 1] : '',
      currentMonth: Config.today().slice(0, 7),
      dataUrl: admin ? Store.dataUrl() : '',
      sourceUrl: sourceUrl,
      sourceTitle: sourceTitle,
      threshold: cfg.threshold,
      user: { email: user.email, role: user.role, isOwner: user.isOwner }
    };
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
    Store.withLock(function () { Config.setSourceId(id); });
    return { sourceId: id, sourceTitle: ss.getName(), sourceUrl: ss.getUrl(), tabsFound: tabs };
  }

  // ---------------------------------------------------------------------------- month data

  function getMonthData(args) {
    var month = requireMonth_(args.month);
    requireImported_(month);
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

  function importMonth(args) {
    var month = requireMonth_(args.month);
    return Importer.importMonth(month, args.overwrite === true);
  }

  function getImportLog() {
    return Store.getImportLog().reverse();
  }

  // ------------------------------------------------------------------------- entity edits

  function saveEntities_(tab, keyField, enrich, args) {
    var month = requireMonth_(args.month);
    var changes = normalizeChanges_(args.changes, keyField);
    if (!changes.length) return { updated: [] };
    return Store.withLock(function () {
      requireImported_(month);
      return { updated: enrich(Store.updateEntityRows(tab, month, changes)) };
    });
  }

  function savePostes(args) {
    return saveEntities_(Config.TABS.postes, Core.KEY_POSTE, enrichPostes_, args);
  }

  function saveApplications(args) {
    return saveEntities_(Config.TABS.applications, Core.KEY_APP, enrichApps_, args);
  }

  function addGenericPoste(args) {
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
        return { created: false, record: enrichPostes_([found])[0] };
      }
      var stored = Store.appendEntityRow(Config.TABS.postes, month, rec, Core.KEY_POSTE);
      return { created: true, record: enrichPostes_([stored])[0] };
    });
  }

  function appNameTaken_(apps, name, exceptId) {
    var target = Core.normKey(name);
    return apps.some(function (a) { return a._id !== exceptId && Core.normKey(a[Core.KEY_APP]) === target; });
  }

  function addApplication(args) {
    var month = requireMonth_(args.month);
    if (!isPlainObject_(args.record)) throw invalid_('« record » doit être un objet.');
    var name = stringField_(args.record[Core.KEY_APP], Core.KEY_APP);
    if (!name) throw invalid_('Le nom de l’application est obligatoire.');
    var fields = {};
    Object.keys(args.record).forEach(function (k) {
      if (k.charAt(0) === '_') throw invalid_('Champ non modifiable : « ' + k + ' ».');
      if (Core.str(k) === '') throw invalid_('Nom de colonne vide.');
      var v = cellValue_(args.record[k], k);
      checkCustomField_(k, v);
      fields[k] = v;
    });

    return Store.withLock(function () {
      requireImported_(month);
      var apps = Store.readEntityMonth(Config.TABS.applications, month);
      if (appNameTaken_(apps, name, null)) {
        throw invalid_('L’application « ' + name + ' » existe déjà pour ' + month + '.');
      }
      // Same columns as the imported rows (null when not provided), then the provided values.
      var info = Store.latestImportInfo(month);
      var rec = {};
      columns_(info && info.apps_headers, [], Core.APP_CUSTOM_FIELDS).forEach(function (h) { rec[h] = null; });
      Object.keys(fields).forEach(function (k) { rec[k] = fields[k]; });
      rec[Core.KEY_APP] = name;
      var stored = Store.appendEntityRow(Config.TABS.applications, month, rec, Core.KEY_APP);
      return enrichApps_([stored])[0];
    });
  }

  function deleteApplication(args) {
    var month = requireMonth_(args.month);
    var id = requireId_(args.id);
    return Store.withLock(function () {
      if (!Store.deleteEntityRow(Config.TABS.applications, month, id)) throw notFound_('Application');
      return { deleted: true, id: id };
    });
  }

  /** Renames an application and the target_name of every Action pointing to its old name. */
  function renameApplication(args) {
    var month = requireMonth_(args.month);
    var id = requireId_(args.id);
    var newName = stringField_(args.newName, 'newName');
    if (!newName) throw invalid_('Le nouveau nom est obligatoire.');

    return Store.withLock(function () {
      var apps = Store.readEntityMonth(Config.TABS.applications, month);
      var current = findById_(apps, id);
      if (!current) throw notFound_('Application');
      if (appNameTaken_(apps, newName, id)) {
        throw invalid_('L’application « ' + newName + ' » existe déjà pour ' + month + '.');
      }
      var oldName = Core.str(current[Core.KEY_APP]);
      if (oldName === newName) return { record: enrichApps_([current])[0], actionsUpdated: 0 };

      var upd = {};
      upd[Core.KEY_APP] = newName;
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
        postes: enrichPostes_(postesAll[m] || []).map(function (r) { return pick_(r, POSTE_SLIM_FIELDS); }),
        applications: enrichApps_(appsAll[m] || []).map(function (r) { return pick_(r, APP_SLIM_FIELDS); })
      };
    });
  }

  // -------------------------------------------------------------------------------- actions

  var ACTION_FIELDS = ['target_type', 'target_name', 'equipe', 'action', 'responsable', 'date_created',
    'date_completed', 'deadline', 'priorite', 'status', 'source_month', 'comment'];
  var REPLACEMENT_FIELDS = ['old_poste', 'new_poste', 'equipe', 'responsable', 'date_replacement', 'comment'];

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
    return {
      actions: normalizeRows_(Store.listRows(Config.TABS.actions), Config.SCHEMAS[Config.TABS.actions]),
      replacements: normalizeRows_(Store.listRows(Config.TABS.replacements),
        Config.SCHEMAS[Config.TABS.replacements])
    };
  }

  function addAction(args) {
    var rec = { id: '' };
    ACTION_FIELDS.forEach(function (f) { rec[f] = actionField_(f, args[f]); });
    if (!rec.status) rec.status = 'À faire';
    if (!rec.date_created) rec.date_created = Config.todayFr();
    rec.recorded_at = Config.today();
    rec.updated_at = '';
    return Store.withLock(function () {
      rec.id = Config.uuid();
      var stored = Store.insertRow(Config.TABS.actions, rec);
      return normalizeRows_([stored], Config.SCHEMAS[Config.TABS.actions])[0];
    });
  }

  function updateAction(args) {
    var id = requireId_(args.id);
    // A client-sent updated_at is tolerated (whole objects round-trip) but always replaced by today.
    var patch = patch_(args.updates, ACTION_FIELDS.concat(['updated_at']), function (k, v) {
      return k === 'updated_at' ? '' : actionField_(k, v);
    });
    patch.updated_at = Config.today();
    return Store.withLock(function () {
      var row = Store.updateRow(Config.TABS.actions, id, patch);
      return normalizeRows_([row], Config.SCHEMAS[Config.TABS.actions])[0];
    });
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
    var rec = { id: '' };
    REPLACEMENT_FIELDS.forEach(function (f) { rec[f] = replacementField_(f, args[f]); });
    if (!rec.date_replacement) rec.date_replacement = Config.todayFr();
    rec.recorded_at = Config.today();
    return Store.withLock(function () {
      rec.id = Config.uuid();
      var stored = Store.insertRow(Config.TABS.replacements, rec);
      return normalizeRows_([stored], Config.SCHEMAS[Config.TABS.replacements])[0];
    });
  }

  function updateReplacement(args) {
    var id = requireId_(args.id);
    var patch = patch_(args.updates, REPLACEMENT_FIELDS, replacementField_);
    return Store.withLock(function () {
      var row = Store.updateRow(Config.TABS.replacements, id, patch);
      return normalizeRows_([row], Config.SCHEMAS[Config.TABS.replacements])[0];
    });
  }

  function deleteReplacement(args) {
    return deleteRowById_(Config.TABS.replacements, args, 'Remplacement');
  }

  // ------------------------------------------------------------------------------- settings

  function accessView_(access, owner) {
    var users = (access.users || []).filter(function (u) { return Access.normEmail(u.email) !== owner; })
      .map(function (u) {
        return { email: Access.normEmail(u.email), role: u.role, added_at: u.added_at, added_by: u.added_by };
      });
    function byEmail(a, b) { return a.email < b.email ? -1 : a.email > b.email ? 1 : 0; }
    users.sort(byEmail);
    var groups = (access.groups || []).map(function (g) {
      return { email: Access.normEmail(g.email), role: g.role, added_at: g.added_at, added_by: g.added_by };
    }).sort(byEmail);
    return { owner: owner, users: users, groups: groups,
      domainRole: access.domainRole === 'lecteur' ? 'lecteur' : 'none' };
  }

  function getSettings(args, user) {
    var cfg = Config.get();
    var source = { id: cfg.sourceId, url: cfg.sourceId ? sourceUrl_(cfg.sourceId) : '', title: '', tabsFound: null };
    if (cfg.sourceId) {
      try {
        var ss = SpreadsheetApp.openById(cfg.sourceId);
        source.url = ss.getUrl();
        source.title = ss.getName();
        source.tabsFound = Importer.tabsFound_(ss);
      } catch (e) {
        console.warn('api_getSettings: source ' + cfg.sourceId + ' not accessible (' + (e && e.message) + ')');
      }
    }
    return {
      threshold: cfg.threshold,
      defaultThreshold: Core.THRESHOLD,
      source: source,
      dataUrl: cfg.dataId ? Store.dataUrl() : '',
      access: accessView_(cfg.access, user.owner),
      me: user.email
    };
  }

  function setThreshold(args) {
    var n = Core.validateThreshold(args.threshold);
    if (n === null) throw invalid_('Seuil invalide : un nombre entier entre 1 et 100 est attendu.');
    Store.withLock(function () { Config.setThreshold(n); });
    Core.setThreshold(n);
    return { threshold: n };
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
    return Store.withLock(function () {
      var access = Config.get().access;
      var existing = access.users.filter(function (u) { return Access.normEmail(u.email) === email; })[0];
      if (existing) {
        existing.email = email;
        existing.role = role;
      } else {
        requireRoom_(access, 1);
        access.users.push({ email: email, role: role, added_at: Config.today(), added_by: user.email });
      }
      Config.setAccess(access);
      return accessView_(access, user.owner);
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
    return Store.withLock(function () {
      var access = Config.get().access;
      var byEmail = {};
      access.users.forEach(function (u) { byEmail[Access.normEmail(u.email)] = u; });
      var added = [];
      var updated = [];
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
      if (added.length || updated.length) Config.setAccess(access);
      return { access: accessView_(access, user.owner), added: added, updated: updated, skipped: skipped };
    });
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
    return Store.withLock(function () {
      var access = Config.get().access;
      var existing = access.groups.filter(function (g) { return Access.normEmail(g.email) === email; })[0];
      if (existing) {
        existing.email = email;
        existing.role = role;
      } else {
        if (access.groups.length >= Config.MAX_GROUPS) {
          throw invalid_('La liste est limitée à ' + Config.MAX_GROUPS + ' groupes.');
        }
        access.groups.push({ email: email, role: role, added_at: Config.today(), added_by: user.email });
      }
      requireStillAdmin_(user, access);
      Config.setAccess(access);
      return accessView_(access, user.owner);
    });
  }

  function removeGroup(args, user) {
    var email = Access.checkEmail(args.email);
    return Store.withLock(function () {
      var access = Config.get().access;
      var kept = access.groups.filter(function (g) { return Access.normEmail(g.email) !== email; });
      if (kept.length === access.groups.length) {
        throw Core.makeError('NOT_FOUND', 'Aucun groupe enregistré : ' + email + '.');
      }
      access.groups = kept;
      requireStillAdmin_(user, access);
      Config.setAccess(access);
      return accessView_(access, user.owner);
    });
  }

  function removeUser(args, user) {
    var email = editableEmail_(args.email, user);
    return Store.withLock(function () {
      var access = Config.get().access;
      var kept = access.users.filter(function (u) { return Access.normEmail(u.email) !== email; });
      if (kept.length === access.users.length) {
        throw Core.makeError('NOT_FOUND', 'Aucun accès enregistré pour ' + email + '.');
      }
      access.users = kept;
      Config.setAccess(access);
      return accessView_(access, user.owner);
    });
  }

  function setDomainRole(args, user) {
    var role = Access.checkRole(args.role, Access.DOMAIN_ROLES);
    return Store.withLock(function () {
      var access = Config.get().access;
      access.domainRole = role;
      Config.setAccess(access);
      return accessView_(access, user.owner);
    });
  }

  // ----------------------------------------------------------------------------------- diff

  function getDiff(args) {
    var oldMonth = requireMonth_(args.oldMonth, 'ancien mois');
    var newMonth = requireMonth_(args.newMonth, 'nouveau mois');
    requireImported_(oldMonth);
    requireImported_(newMonth);
    return {
      oldMonth: oldMonth,
      newMonth: newMonth,
      postes: Core.diffPostes(readPostes_(oldMonth), readPostes_(newMonth)),
      applications: Core.diffApplications(readApps_(oldMonth), readApps_(newMonth))
    };
  }

  return {
    bootstrap: bootstrap,
    setConfig: setConfig,
    getMonthData: getMonthData,
    importMonth: importMonth,
    getImportLog: getImportLog,
    savePostes: savePostes,
    addGenericPoste: addGenericPoste,
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
function api_setConfig(argsJson) { return apiWrap_(ApiImpl_.setConfig, 'api_setConfig', 'admin')(argsJson); }
function api_getMonthData(argsJson) { return apiWrap_(ApiImpl_.getMonthData, 'api_getMonthData', 'lecteur')(argsJson); }
function api_importMonth(argsJson) { return apiWrap_(ApiImpl_.importMonth, 'api_importMonth', 'admin')(argsJson); }
function api_getImportLog(argsJson) { return apiWrap_(ApiImpl_.getImportLog, 'api_getImportLog', 'lecteur')(argsJson); }
function api_savePostes(argsJson) { return apiWrap_(ApiImpl_.savePostes, 'api_savePostes', 'admin')(argsJson); }
function api_addGenericPoste(argsJson) { return apiWrap_(ApiImpl_.addGenericPoste, 'api_addGenericPoste', 'admin')(argsJson); }
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
function api_saveUser(argsJson) { return apiWrap_(ApiImpl_.saveUser, 'api_saveUser', 'admin')(argsJson); }
function api_addUsers(argsJson) { return apiWrap_(ApiImpl_.addUsers, 'api_addUsers', 'admin')(argsJson); }
function api_saveGroup(argsJson) { return apiWrap_(ApiImpl_.saveGroup, 'api_saveGroup', 'admin')(argsJson); }
function api_removeGroup(argsJson) { return apiWrap_(ApiImpl_.removeGroup, 'api_removeGroup', 'admin')(argsJson); }
function api_removeUser(argsJson) { return apiWrap_(ApiImpl_.removeUser, 'api_removeUser', 'admin')(argsJson); }
function api_setDomainRole(argsJson) { return apiWrap_(ApiImpl_.setDomainRole, 'api_setDomainRole', 'admin')(argsJson); }
