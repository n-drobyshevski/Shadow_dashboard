// Config: Script Properties access and data-spreadsheet constants.
// The IIFE only defines values; GAS services are touched inside the functions, so load order does not matter.
var Config = (function () {
  var PROP_DATA_ID = 'DATA_SPREADSHEET_ID';
  var PROP_SOURCE_ID = 'SOURCE_SPREADSHEET_ID';
  var PROP_THRESHOLD = 'COMPLIANCE_THRESHOLD';
  var PROP_ACCESS = 'ACCESS_JSON';
  var PROP_FAVICON = 'FAVICON_URL';
  // JSON {dataId, version}, a copy of the Meta tab's version so Store.ensure can skip reading Meta.
  // Keyed by spreadsheet id so a new DATA_SPREADSHEET_ID does not inherit the old file's version.
  var PROP_SCHEMA = 'DATA_SCHEMA_VERSION';
  // JSON {id, title}, so api_bootstrap can show the source title without opening the file.
  // Refreshed by every import, so it is at most one hourly sync old.
  var PROP_SOURCE_INFO = 'SOURCE_INFO';
  // Bumped under the lock by every write-back to the source and every snapshot import. The sync reads
  // the source outside the lock and re-reads it under the lock if the stamp moved, so it never reverts
  // a write that landed in between.
  var PROP_SOURCE_STAMP = 'SOURCE_WRITE_STAMP';
  // PREFS_<email> = JSON of PREF_VALUES keys plus `at` (ms of last save). Stored server-side because
  // localStorage is refused in the Apps Script frame when third-party storage is blocked. Capped at
  // MAX_PREFS accounts so the ~500 KB Script Properties store cannot fill up.
  var PROP_PREFS_PREFIX = 'PREFS_';
  var MAX_PREFS = 300;
  // JSON {edit, create, delete} for Paramètres › « Saisie dans l’application ». Only an explicit true
  // turns a switch on; missing or unreadable means all off.
  var PROP_EDITING = 'EDITING_JSON';
  var EDITING_KEYS = ['edit', 'create', 'delete'];
  var PREF_VALUES = { sidebar: ['open', 'collapsed'], period: ['month', 'last3', 'last6', 'year', 'all'] };
  // assets/favicon.png inlined so nothing has to be hosted. Regenerate with base64 -w0 assets/favicon.png
  // (a test checks they match). FAVICON_URL overrides it with an https URL, or '-' removes it.
  var DEFAULT_FAVICON_URL = 'data:image/png;base64,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';
  // A Script Property value holds at most 9 KB, so the access list is split into ACCESS_JSON_0..N-1
  // (3000 chars stay under 9 KB even in multi-byte UTF-8), with the count in ACCESS_JSON_N.
  var ACCESS_CHUNK = 3000;
  var MAX_USERS = 2000;
  // Script Properties hold about 500 KB in all, shared with settings, sync state and preferences.
  var MAX_ACCESS_CHARS = 300000;
  var MAX_GROUPS = 50;
  var DATA_SPREADSHEET_NAME = 'ShadowIT_AppData';

  // Mirrors timeZone in appsscript.json; Session.getScriptTimeZone() is outside the allowed services.
  var TIME_ZONE = 'Europe/Paris';

  var TABS = {
    postes: 'Postes',
    applications: 'Applications',
    referentiel: 'Referentiel',
    actions: 'Actions',
    replacements: 'Replacements',
    importLog: 'ImportLog',
    accessLog: 'AccessLog',
    meta: 'Meta'
  };

  var SCHEMAS = {
    Postes: ['_month', '_id', '_key', '_order', '_json', '_updated_at'],
    Applications: ['_month', '_id', '_key', '_order', '_json', '_updated_at'],
    Referentiel: ['_month', 'category', 'position', 'value'],
    Actions: ['id', 'target_type', 'target_name', 'equipe', 'action', 'responsable', 'date_created',
      'date_completed', 'deadline', 'priorite', 'status', 'source_month', 'comment', 'recorded_at', 'updated_at'],
    Replacements: ['id', 'old_poste', 'new_poste', 'equipe', 'responsable', 'date_replacement', 'comment',
      'recorded_at'],
    ImportLog: ['month', 'imported_at', 'source_id', 'counts_json', 'postes_headers_json', 'apps_headers_json',
      'warnings_json', 'changes_json'],
    AccessLog: ['at', 'email', 'result', 'pages'],
    Meta: ['key', 'value']
  };

  var SCHEMA_VERSION = '2'; // 2: ImportLog.changes_json (hourly sync)

  // Per-execution memo of getProperties(). Cleared by every setter, at the start of each api_* call
  // and when Store.withLock takes the lock, so read-modify-write under the lock sees stored values.
  var memo_ = null;

  function props_() {
    return PropertiesService.getScriptProperties();
  }

  function all_(fresh) {
    if (!memo_ || fresh) memo_ = props_().getProperties() || {};
    return memo_;
  }

  function clearMemo_() {
    memo_ = null;
  }

  /** Returns a new object each call; ids and titles are '' when unset. opts.fresh bypasses the memo. */
  function get(opts) {
    var p = all_(!!(opts && opts.fresh));
    var threshold = Core.validateThreshold(p[PROP_THRESHOLD] || '');
    var dataId = p[PROP_DATA_ID] || '';
    var sourceId = p[PROP_SOURCE_ID] || '';
    return {
      dataId: dataId,
      sourceId: sourceId,
      sourceTitle: sourceTitleFor_(p, sourceId),
      threshold: threshold === null ? Core.THRESHOLD : threshold,
      schemaVersion: schemaVersionFor_(p, dataId),
      access: parseAccess_(readAccessJson_(p)),
      editing: editingOf_(p[PROP_EDITING])
    };
  }

  function editingOf_(raw) {
    var v = null;
    try { v = raw ? JSON.parse(raw) : null; } catch (e) { v = null; }
    var out = {};
    EDITING_KEYS.forEach(function (k) {
      out[k] = !!(v && typeof v === 'object' && v[k] === true);
    });
    return out;
  }

  function schemaVersionFor_(p, dataId) {
    if (!dataId || !p[PROP_SCHEMA]) return '';
    var v = null;
    try { v = JSON.parse(p[PROP_SCHEMA]); } catch (e) { v = null; }
    return v && v.dataId === dataId && typeof v.version === 'string' ? v.version : '';
  }

  function sourceTitleFor_(p, sourceId) {
    if (!sourceId || !p[PROP_SOURCE_INFO]) return '';
    var v = null;
    try { v = JSON.parse(p[PROP_SOURCE_INFO]); } catch (e) { v = null; }
    return v && v.id === sourceId && typeof v.title === 'string' ? v.title : '';
  }

  function sourceInfoJson_(id, title) {
    return JSON.stringify({ id: String(id || ''), title: String(title || '') });
  }

  /** Call under Store.withLock. Returns whether it wrote. */
  function rememberSourceTitle(id, title) {
    var p = all_(false);
    var t = String(title || '');
    if (!id || p[PROP_SOURCE_ID] !== id || (p[PROP_SOURCE_INFO] && sourceTitleFor_(p, id) === t)) return false;
    clearMemo_();
    props_().setProperty(PROP_SOURCE_INFO, sourceInfoJson_(id, t));
    return true;
  }

  function setSchemaVersion(dataId, version) {
    clearMemo_();
    props_().setProperty(PROP_SCHEMA, JSON.stringify({ dataId: String(dataId || ''), version: String(version) }));
  }

  // Outside the lock the memo may be stale, which only causes an extra source read, never a missed one.
  function sourceStamp() {
    return String(all_(false)[PROP_SOURCE_STAMP] || '');
  }

  // Call under the lock only. max(now, previous + 1) never repeats a value, even after the property is deleted.
  function bumpSourceStamp() {
    var next = Math.max(Date.now(), (Number(all_(false)[PROP_SOURCE_STAMP]) || 0) + 1);
    clearMemo_();
    props_().setProperty(PROP_SOURCE_STAMP, String(next));
    return String(next);
  }

  function readAccessJson_(p) {
    var n = Number(p[PROP_ACCESS + '_N']);
    if (!(n >= 1 && n <= 1000 && Math.floor(n) === n)) return '';
    var json = '';
    for (var i = 0; i < n; i++) {
      var part = p[PROP_ACCESS + '_' + i];
      if (typeof part !== 'string') return '';
      json += part;
    }
    return json;
  }

  // Anything unreadable becomes the empty list (only the deployer gets in), never an error.
  function parseAccess_(json) {
    var raw = null;
    try { raw = json ? JSON.parse(json) : null; } catch (e) { raw = null; }
    function entries(list) {
      return (Array.isArray(list) ? list : []).filter(function (u) { return u && typeof u.email === 'string' && u.email; })
        .map(function (u) {
          return { email: String(u.email), role: String(u.role || ''), added_at: String(u.added_at || ''),
            added_by: String(u.added_by || '') };
        });
    }
    return {
      users: entries(raw && raw.users),
      groups: entries(raw && raw.groups),
      domainRole: raw && typeof raw.domainRole === 'string' ? raw.domainRole : 'none'
    };
  }

  function setThreshold(n) {
    clearMemo_();
    props_().setProperty(PROP_THRESHOLD, String(n));
  }

  /** Call inside Store.withLock with the patch already merged into Config.get().editing. */
  function setEditing(editing) {
    var out = {};
    EDITING_KEYS.forEach(function (k) { out[k] = editing[k] === true; });
    clearMemo_();
    props_().setProperty(PROP_EDITING, JSON.stringify(out));
  }

  /** Call inside Store.withLock. Throws VALIDATION, before writing, above MAX_ACCESS_CHARS. */
  function setAccess(access) {
    var json = JSON.stringify({ users: access.users || [], groups: access.groups || [],
      domainRole: access.domainRole || 'none' });
    if (json.length > MAX_ACCESS_CHARS) {
      throw Core.makeError('VALIDATION', 'La liste d’accès deviendrait trop volumineuse pour être enregistrée (' +
        json.length + ' caractères, ' + MAX_ACCESS_CHARS + ' au plus). Retirez des comptes, ou donnez l’accès ' +
        'par un groupe Google ou par « Autres comptes du domaine ».');
    }
    clearMemo_();
    var store = props_();
    var parts = {};
    var n = 0;
    for (var i = 0; i < json.length; i += ACCESS_CHUNK) parts[PROP_ACCESS + '_' + (n++)] = json.slice(i, i + ACCESS_CHUNK);
    parts[PROP_ACCESS + '_N'] = String(n);
    // Parts and count go in one call so a reader never mixes two versions; leftover parts are then deleted.
    store.setProperties(parts);
    var existing = store.getProperties() || {};
    for (var k = n; Object.prototype.hasOwnProperty.call(existing, PROP_ACCESS + '_' + k); k++) store.deleteProperty(PROP_ACCESS + '_' + k);
  }

  function setDataId(id) {
    clearMemo_();
    props_().setProperty(PROP_DATA_ID, String(id || ''));
  }

  /** Call inside Store.withLock. */
  function setSourceId(id, title) {
    var parts = {};
    parts[PROP_SOURCE_ID] = String(id || '');
    parts[PROP_SOURCE_INFO] = sourceInfoJson_(id, title);
    clearMemo_();
    props_().setProperties(parts);
  }

  // Built from the id so links need no openById().getUrl().
  function spreadsheetUrl(id) {
    return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(String(id || '')) + '/edit';
  }

  function fmt_(pattern) {
    return Utilities.formatDate(new Date(), TIME_ZONE, pattern);
  }

  function today() { return fmt_('yyyy-MM-dd'); }

  function todayFr() { return fmt_('dd/MM/yyyy'); }

  function nowStamp() { return fmt_('yyyy-MM-dd HH:mm'); }

  function uuid() { return Utilities.getUuid(); }

  function prefsKey_(email) { return PROP_PREFS_PREFIX + String(email || '').trim().toLowerCase(); }

  function cleanPrefs_(o) {
    var out = {};
    if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
    Object.keys(PREF_VALUES).forEach(function (k) {
      if (PREF_VALUES[k].indexOf(o[k]) >= 0) out[k] = o[k];
    });
    return out;
  }

  function getPrefs(email) {
    if (!String(email || '').trim()) return {};
    var raw = all_(false)[prefsKey_(email)];
    if (!raw) return {};
    try { return cleanPrefs_(JSON.parse(raw)); } catch (e) { return {}; }
  }

  /** `patch` must already be validated. Returns the stored object. */
  function setPrefs(email, patch) {
    var all = all_(true); // fresh read for read-modify-write
    var key = prefsKey_(email);
    var next = cleanPrefs_(Object.assign(getPrefs(email), patch || {}));
    if (!Object.prototype.hasOwnProperty.call(all, key)) evictPrefs_(all, MAX_PREFS - 1);
    clearMemo_();
    props_().setProperty(key, JSON.stringify(Object.assign({}, next, { at: Date.now() })));
    return next;
  }

  // Drops the least recently saved PREFS_ entries until at most `keep` remain.
  function evictPrefs_(all, keep) {
    var keys = Object.keys(all).filter(function (k) { return k.indexOf(PROP_PREFS_PREFIX) === 0; });
    if (keys.length <= keep) return;
    var at = function (k) {
      try { return Number(JSON.parse(all[k]).at) || 0; } catch (e) { return 0; }
    };
    keys.map(function (k) { return { k: k, at: at(k) }; })
      .sort(function (a, b) { return a.at - b.at; })
      .slice(0, keys.length - keep)
      .forEach(function (o) { props_().deleteProperty(o.k); });
  }

  function faviconUrl() {
    var v = '';
    try { v = String(props_().getProperty(PROP_FAVICON) || '').trim(); } catch (e) { v = ''; }
    if (v === '-') return '';
    return /^https:\/\/\S+$/.test(v) ? v : DEFAULT_FAVICON_URL;
  }

  return {
    PROP_DATA_ID: PROP_DATA_ID,
    PROP_SOURCE_ID: PROP_SOURCE_ID,
    PROP_THRESHOLD: PROP_THRESHOLD,
    PROP_ACCESS: PROP_ACCESS,
    PROP_FAVICON: PROP_FAVICON,
    PROP_SCHEMA: PROP_SCHEMA,
    PROP_SOURCE_INFO: PROP_SOURCE_INFO,
    PROP_SOURCE_STAMP: PROP_SOURCE_STAMP,
    PROP_PREFS_PREFIX: PROP_PREFS_PREFIX,
    MAX_PREFS: MAX_PREFS,
    PROP_EDITING: PROP_EDITING,
    EDITING_KEYS: EDITING_KEYS,
    PREF_VALUES: PREF_VALUES,
    DEFAULT_FAVICON_URL: DEFAULT_FAVICON_URL,
    MAX_USERS: MAX_USERS,
    MAX_ACCESS_CHARS: MAX_ACCESS_CHARS,
    MAX_GROUPS: MAX_GROUPS,
    DATA_SPREADSHEET_NAME: DATA_SPREADSHEET_NAME,
    TIME_ZONE: TIME_ZONE,
    TABS: TABS,
    SCHEMAS: SCHEMAS,
    SCHEMA_VERSION: SCHEMA_VERSION,
    get: get,
    setDataId: setDataId,
    setSourceId: setSourceId,
    rememberSourceTitle: rememberSourceTitle,
    setThreshold: setThreshold,
    setEditing: setEditing,
    setAccess: setAccess,
    setSchemaVersion: setSchemaVersion,
    sourceStamp: sourceStamp,
    bumpSourceStamp: bumpSourceStamp,
    clearMemo_: clearMemo_,
    faviconUrl: faviconUrl,
    spreadsheetUrl: spreadsheetUrl,
    getPrefs: getPrefs,
    setPrefs: setPrefs,
    today: today,
    todayFr: todayFr,
    nowStamp: nowStamp,
    uuid: uuid
  };
})();
