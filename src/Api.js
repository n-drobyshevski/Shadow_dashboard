// Api: google.script.run entry points.
// Each api_* function takes one JSON string and returns one JSON string, {ok: true, data} or
// {ok: false, error: {code, message, field?}}, so no Date ever crosses google.script.run.
// Arguments are validated before taking the lock, and every write runs inside Store.withLock.

/**
 * Throttles first, so a call refused for identity or rate never reads the Script Properties, then checks
 * the role. Errors with a known code keep their French message; anything else becomes INTERNAL and its
 * stack is only logged.
 */
function apiWrap_(fn, name, minRole) {
  return function (argsJson) {
    var t0 = Date.now();
    var authMs = null;
    var ok = false;
    var code = null;
    var release = null;
    var user = null;
    try {
      // GAS already gives each call a new execution, but the test sandbox reuses one context.
      Store.clearMemo_();
      Config.clearMemo_();
      release = Access.throttle(name);
      var cfg = Config.get();
      // 'none': any identified account of the domain, with or without a role (« Demander l’accès »).
      user = minRole === 'none' ? Access.currentUser(cfg.access) : Access.requireRole(minRole || 'lecteur', cfg.access);
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
      // Google's error text can name a spreadsheet id, so only admins see it.
      var message = known ? String(e.message || code) : internalMessage_(e, !!user && user.role === 'admin');
      if (code === 'FORBIDDEN' && name === 'api_bootstrap' && !e.throttled) logVisit_(Access.activeEmail(), 'refused');
      if (code === 'FORBIDDEN' || e.throttled) console.warn('[' + (name || 'api') + '] ' + code + ': ' + message);
      else console.error('[' + (name || 'api') + '] ' + code + ': ' + (e.stack || e.message || String(err)));
      var error = { code: code, message: message };
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

// One row per person per 30 min in AccessLog. Never fails the call that triggered it.
function logVisit_(email, result) {
  if (!email) return;
  try {
    // A refused visitor must not make the app create its data spreadsheet.
    if (result === 'refused' && !Config.get().dataId) return;
    if (Access.noteVisit_(email)) Store.appendAccessLog({ email: email, result: result });
  } catch (e) {
    console.warn('[access log] not written: ' + (e && e.code ? e.code : 'error'));
  }
}

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

function internalMessage_(e, admin) {
  if (!admin) return INTERNAL_GENERIC_;
  var detail = String((e && e.message) || '').split('\n')[0].slice(0, 200);
  return 'Erreur interne du serveur' + (detail ? ' : ' + detail : '.');
}

var INTERNAL_GENERIC_ = 'Erreur interne du serveur. Réessayez ; si le problème persiste, prévenez un administrateur.';

var ApiImpl_ = (function () {
  var POSTE_SLIM_FIELDS = ['Équipe', 'Bâtiment / Labo', 'EDR Decathlon', 'IT Decathlon', 'Réseau Decathlon',
    'Niveau de risque'];
  var APP_SLIM_FIELDS = ['Équipe', 'SIP', 'Contrat', 'Galink', 'IDP', 'Niveau de risque'];
  var DATE_FR_RE = /^\d{2}\/\d{2}\/\d{4}$/;
  var IMPORT_LOG_LIMIT = 12;
  var IMPORT_LOG_MAX_LIMIT = 500;
  var ACCESS_LOG_LIMIT = 500;
  var PAGE_IDS = ['dashboard', 'postes', 'apps', 'timeline', 'actions', 'settings'];
  var SYNC_ERROR_GENERIC = 'La synchronisation a échoué. Un administrateur en voit le détail dans Paramètres.';

  var hasOwn = Object.prototype.hasOwnProperty;

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

  function requireImported_(month) {
    if (!Store.hasMonth(month)) {
      throw Core.makeError('NOT_FOUND', 'Le mois ' + month + ' n’a pas été importé.');
    }
    return month;
  }

  function requireImportedMonth_(month, label) { return requireImported_(requireMonth_(month, label)); }

  var EDITING_REFUSED = {
    edit: 'La modification des postes et des applications est désactivée dans les Paramètres.',
    create: 'La création de postes et d’applications est désactivée dans les Paramètres.',
    delete: 'La suppression d’applications est désactivée dans les Paramètres.'
  };

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

  function maxLength_(s, field) {
    if (s.length > Core.LIMITS.cellChars) {
      throw invalid_('Texte trop long pour « ' + field + ' » : ' + Core.LIMITS.cellChars + ' caractères au maximum.', field);
    }
    return s;
  }

  function cellValue_(v, field) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return Core.isBlank(v) ? null : maxLength_(v, field);
    if (typeof v === 'number') return isFinite(v) ? String(v) : null;
    if (typeof v === 'boolean') return String(v);
    throw invalid_('Valeur invalide pour « ' + field + ' ».', field);
  }

  function checkCustomField_(field, value) {
    if (Core.APP_CUSTOM_FIELDS.indexOf(field) >= 0 && value !== null && value !== 'Oui' && value !== 'Non') {
      throw invalid_('« ' + field + ' » doit valoir « Oui », « Non » ou être vide.', field);
    }
  }

  // The key column is locked here because renaming goes through api_renameApplication.
  function normalizeChanges_(changes, keyField) {
    if (!Array.isArray(changes)) throw invalid_('« changes » doit être une liste.');
    return changes.map(function (c) {
      if (!isPlainObject_(c)) throw invalid_('Modification invalide.');
      var id = requireId_(c.id);
      if (!isPlainObject_(c.updates)) throw invalid_('« updates » doit être un objet.');
      return { id: id, updates: normalizeFields_(c.updates, keyField) };
    });
  }

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

  /** Returns 'DD/MM/YYYY' or ''. ISO input is converted. */
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
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return maxLength_(Core.str(v), field);
    throw invalid_('Valeur invalide pour « ' + field + ' ».');
  }

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

  // Records can hold fields missing from the headers, such as a generic poste built from the template.
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

  function normalizeRows_(rows, schema) {
    return (rows || []).map(function (r) {
      var out = {};
      schema.forEach(function (k) { out[k] = r[k] === null || r[k] === undefined ? '' : String(r[k]); });
      return out;
    });
  }

  /** Opens the source live. Never throws: tabsFound stays null and the stored title is kept when it fails. */
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

  function bootstrap(args, user) {
    var cfg = Config.get();
    var admin = user.role === 'admin';
    Store.ensure();
    logVisit_(user.email, user.role);

    var months = Store.listMonths();
    // The spreadsheets are private to the deployer, so links only help admins. Neither file is opened here.
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
      sync: syncFor_(Sync.status(), user),
      accessRequests: admin ? cfg.requests.length : 0
    };
  }

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

  // Owner only: the app opens the source with the deployer's rights, so another admin could otherwise
  // point it at any spreadsheet the deployer can open, and write back to it.
  function setConfig(args, user) {
    if (!user || !user.isOwner) {
      throw Core.makeError('FORBIDDEN', 'Seul le propriétaire de l’application (le compte qui l’a déployée) ' +
        'peut choisir le classeur source.');
    }
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

  // Never throws, since the source is already saved. A missing ScriptApp authorisation comes back as authError.
  function startSync_() {
    try {
      return Sync.enable();
    } catch (e) {
      var st = Sync.status();
      st.authError = e.message;
      return st;
    }
  }

  // Carries the editing switches so the 10-minute poll also picks up other admins' changes.
  function getSyncStatus(args, user) {
    var st = syncFor_(Sync.status(), user);
    st.editing = Config.get().editing;
    return st;
  }

  // Non-admins do not see the error message, which may be Google's text naming a spreadsheet.
  function syncFor_(st, user) {
    if (st && st.lastError && !(user && user.role === 'admin')) {
      st.lastError = { at: st.lastError.at, code: st.lastError.code, message: SYNC_ERROR_GENERIC };
    }
    return st;
  }

  function syncNow() {
    return Sync.run();
  }

  function enableSync() {
    Sync.enable();
    return Sync.run();
  }

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

  function getAccessLog(args) {
    var limit = args.limit === undefined || args.limit === null ? ACCESS_LOG_LIMIT : args.limit;
    if (typeof limit !== 'number' || Math.floor(limit) !== limit || limit < 1 || limit > IMPORT_LOG_MAX_LIMIT) {
      throw invalid_('« limit » doit être un entier entre 1 et ' + IMPORT_LOG_MAX_LIMIT + '.');
    }
    return Store.recentAccessLog(limit);
  }

  // Pages the caller opened during this visit, sent once each by the client. Never fails on the write.
  function notePages(args, user) {
    var pages = args.pages;
    if (!Array.isArray(pages) || !pages.length || pages.length > PAGE_IDS.length ||
      pages.some(function (p) { return PAGE_IDS.indexOf(p) < 0; })) {
      throw invalid_('« pages » doit être une liste de pages de l’application.');
    }
    try {
      Store.noteAccessPages(user.email, pages);
    } catch (e) {
      console.warn('[access log] pages not written: ' + (e && e.code ? e.code : 'error'));
    }
    return null;
  }

  function getImportLog(args) {
    var limit = args.limit === undefined || args.limit === null ? IMPORT_LOG_LIMIT : args.limit;
    if (typeof limit !== 'number' || Math.floor(limit) !== limit || limit < 1 || limit > IMPORT_LOG_MAX_LIMIT) {
      throw invalid_('« limit » doit être un entier entre 1 et ' + IMPORT_LOG_MAX_LIMIT + '.');
    }
    return Store.recentImportLog(limit).map(function (e) {
      return { month: e.month, imported_at: e.imported_at, counts: e.counts, warnings: e.warnings, changes: e.changes };
    });
  }

  // Edits to the live month go to the source first, then the snapshot, so the next sync reads them back.
  // Past months are frozen history and only their snapshot changes.
  function isLive_(month) {
    return month === Sync.currentMonth();
  }

  // The write-back refuses a name the snapshot holds more than once.
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
        // Not a form, so the sheet's rules are not enforced.
        var res = Importer.appendRecord('postes', rec, { strict: false });
        assign_(rec, res.computed);
      }
      var stored = Store.appendEntityRow(Config.TABS.postes, month, rec, Core.KEY_POSTE);
      return { created: true, record: Core.enrichPostes([stored])[0] };
    });
  }

  function assign_(to, from) {
    Object.keys(from || {}).forEach(function (k) { to[k] = from[k]; });
    return to;
  }

  // Built at call time because Core and Config may load after this file.
  function entity_(entity) {
    return entity === 'postes' ?
      { tab: Config.TABS.postes, keyField: Core.KEY_POSTE, trailing: [], enrich: Core.enrichPostes, label: 'Le poste',
        missingName: 'Le nom du poste est obligatoire.' } :
      { tab: Config.TABS.applications, keyField: Core.KEY_APP, trailing: Core.APP_CUSTOM_FIELDS, enrich: enrichApps_,
        label: 'L’application', missingName: 'Le nom de l’application est obligatoire.' };
  }

  function requireFreeName_(entity, list, name, exceptId, month) {
    var e = entity_(entity);
    var target = Core.normKey(name);
    if (list.some(function (r) { return r._id !== exceptId && Core.normKey(r[e.keyField]) === target; })) {
      throw invalid_(e.label + ' « ' + name + ' » existe déjà pour ' + month + '.', e.keyField);
    }
  }

  function snapshotHeaders_(entity, month) {
    var info = Store.latestImportInfo(month);
    var headers = info && (entity === 'postes' ? info.postes_headers : info.apps_headers);
    return { info: info, headers: Array.isArray(headers) ? headers : [] };
  }

  /**
   * Live month: Importer.appendRecord checks the values against the source sheet and writes the row first.
   * Past month: the values are checked against the snapshot's columns only.
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
        // Galink and IDP have no source column and live in the snapshot only.
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
   * Live month: read from the source outside the lock, falling back to the last sync's columns with a
   * warning when it cannot be read. Past months never open the source.
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

  // Live month: the source row is deleted first, then the snapshot row.
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

  // Also renames the target of every Action pointing to the old name. Live month: the source cell goes first.
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

  // Read at call time because Config may load after this file.
  function writableFields_(tab) {
    return Config.SCHEMAS[tab].filter(function (f) { return ['id', 'recorded_at', 'updated_at'].indexOf(f) < 0; });
  }

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
    // A client-sent updated_at is tolerated because whole objects round-trip, but it is always replaced.
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

  function accessView_(access, owner, requests) {
    function entries(list) {
      return (list || []).map(function (e) {
        return { email: Access.normEmail(e.email), role: e.role, added_at: e.added_at, added_by: e.added_by };
      }).filter(function (e) { return e.email !== owner; })
        .sort(function (a, b) { return a.email < b.email ? -1 : a.email > b.email ? 1 : 0; });
    }
    return { owner: owner, users: entries(access.users), groups: entries(access.groups),
      domainRole: access.domainRole === 'lecteur' ? 'lecteur' : 'none', requests: (requests || []).slice().reverse() };
  }

  // Requests answered by the new list: an explicit entry for that account, or the whole domain let in.
  function openRequests_(requests, access) {
    if (access.domainRole === 'lecteur') return [];
    var listed = {};
    access.users.forEach(function (u) { listed[Access.normEmail(u.email)] = true; });
    return requests.filter(function (r) { return !listed[r.email]; });
  }

  /** change(access) returns false when there is nothing to write; check(access) may throw to refuse. */
  function mutateAccess_(user, change, check) {
    return Store.withLock(function () {
      var cfg = Config.get({ fresh: true });
      var access = cfg.access;
      var changed = change(access) !== false;
      if (check) check(access);
      if (changed) Config.setAccess(access);
      var requests = openRequests_(cfg.requests, access);
      if (requests.length !== cfg.requests.length) requests = Config.setAccessRequests(requests);
      return accessView_(access, user.owner, requests);
    });
  }

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
      access: accessView_(cfg.access, user.owner, cfg.requests),
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

  function setEditing(args) {
    var keys = Object.keys(args || {});
    if (!keys.length) throw invalid_('Aucun réglage à enregistrer.');
    keys.forEach(function (k) {
      if (Config.EDITING_KEYS.indexOf(k) < 0) throw invalid_('Réglage inconnu : « ' + k + ' ».');
      if (typeof args[k] !== 'boolean') throw invalid_('« ' + k + ' » doit valoir true ou false.');
    });
    return Store.withLock(function () {
      // Taking the lock dropped the memo, so this is the stored value.
      var editing = Config.get().editing;
      keys.forEach(function (k) { editing[k] = args[k]; });
      Config.setEditing(editing);
      return { editing: editing };
    });
  }

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

  /** Returns {access, added, updated, skipped: [{email, reason}]}. Never touches the owner or the caller. */
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

  // Prevents an admin from locking themselves out through a group change.
  function requireStillAdmin_(user, access) {
    if (Access.roleOf(user.email, user.owner, access) !== 'admin') {
      throw invalid_('Ce changement vous retirerait le rôle administrateur (vous l’avez par ce groupe).');
    }
  }

  function saveGroup(args, user) {
    var role = Access.checkRole(args.role);
    var email = Access.checkGroup(args.email); // GroupsApp call, kept outside the lock
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

  // Open to any identified account of the domain, with or without a role. One pending request per account;
  // asking again only updates the message.
  function requestAccess(args, user) {
    if (user.role) return { status: 'granted' };
    var message = args.message === undefined || args.message === null ? '' : args.message;
    if (typeof message !== 'string') throw invalid_('Message invalide.');
    message = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (message.length > Config.MAX_REQUEST_MESSAGE) {
      throw Core.makeError('VALIDATION', 'Message trop long : ' + Config.MAX_REQUEST_MESSAGE + ' caractères au plus.', 'message');
    }
    return Store.withLock(function () {
      var requests = Config.get({ fresh: true }).requests;
      var mine = requests.filter(function (r) { return r.email === user.email; })[0];
      var already = !!mine;
      if (mine) mine.message = message || mine.message;
      else requests.push(mine = { email: user.email, requested_at: Config.nowStamp(), message: message });
      Config.setAccessRequests(requests);
      return { status: 'pending', requested_at: mine.requested_at, already: already };
    });
  }

  function dismissAccessRequest(args) {
    var email = Access.checkEmail(args.email);
    return Store.withLock(function () {
      var requests = Config.get({ fresh: true }).requests;
      var left = requests.filter(function (r) { return r.email !== email; });
      if (left.length === requests.length) throw Core.makeError('NOT_FOUND', 'Aucune demande d’accès de ' + email + '.');
      return { requests: Config.setAccessRequests(left).slice().reverse() };
    });
  }

  function setDomainRole(args, user) {
    var role = Access.checkRole(args.role, Access.DOMAIN_ROLES);
    return mutateAccess_(user, function (access) { access.domainRole = role; });
  }

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
    getAccessLog: getAccessLog,
    notePages: notePages,
    requestAccess: requestAccess,
    dismissAccessRequest: dismissAccessRequest,
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

// Function declarations, not vars, so that google.script.run and the editor can see them.

function api_bootstrap(argsJson) { return apiWrap_(ApiImpl_.bootstrap, 'api_bootstrap', 'lecteur')(argsJson); }
function api_savePrefs(argsJson) { return apiWrap_(ApiImpl_.savePrefs, 'api_savePrefs', 'lecteur')(argsJson); }
function api_setConfig(argsJson) { return apiWrap_(ApiImpl_.setConfig, 'api_setConfig', 'admin')(argsJson); }
function api_getMonthData(argsJson) { return apiWrap_(ApiImpl_.getMonthData, 'api_getMonthData', 'lecteur')(argsJson); }
function api_getSyncStatus(argsJson) { return apiWrap_(ApiImpl_.getSyncStatus, 'api_getSyncStatus', 'lecteur')(argsJson); }
function api_syncNow(argsJson) { return apiWrap_(ApiImpl_.syncNow, 'api_syncNow', 'admin')(argsJson); }
function api_enableSync(argsJson) { return apiWrap_(ApiImpl_.enableSync, 'api_enableSync', 'admin')(argsJson); }
function api_getImportLog(argsJson) { return apiWrap_(ApiImpl_.getImportLog, 'api_getImportLog', 'lecteur')(argsJson); }
function api_getAccessLog(argsJson) { return apiWrap_(ApiImpl_.getAccessLog, 'api_getAccessLog', 'admin')(argsJson); }
function api_notePages(argsJson) { return apiWrap_(ApiImpl_.notePages, 'api_notePages', 'lecteur')(argsJson); }
function api_requestAccess(argsJson) { return apiWrap_(ApiImpl_.requestAccess, 'api_requestAccess', 'none')(argsJson); }
function api_dismissAccessRequest(argsJson) { return apiWrap_(ApiImpl_.dismissAccessRequest, 'api_dismissAccessRequest', 'admin')(argsJson); }
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
