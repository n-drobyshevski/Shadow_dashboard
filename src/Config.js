/**
 * Config — Script Properties access and data-spreadsheet constants (docs/API.md §4).
 *
 * Load-order safe: the IIFE only defines values and functions; GAS services are touched lazily,
 * inside the functions.
 */
var Config = (function () {
  var PROP_DATA_ID = 'DATA_SPREADSHEET_ID';
  var PROP_SOURCE_ID = 'SOURCE_SPREADSHEET_ID';
  var PROP_THRESHOLD = 'COMPLIANCE_THRESHOLD';
  var PROP_ACCESS = 'ACCESS_JSON';
  var PROP_FAVICON = 'FAVICON_URL';
  /**
   * Browser-tab icon (the ghost). Apps Script only takes a hosted image whose URL ends with its extension:
   * assets/favicon.png of the public GitHub repo. The FAVICON_URL Script Property overrides it ('-' = none).
   */
  var DEFAULT_FAVICON_URL = 'https://raw.githubusercontent.com/n-drobyshevski/Shadow_dashboard/main/assets/favicon.png';
  // A Script Property value holds at most 9 KB: the access list is stored as JSON split into
  // ACCESS_JSON_0, ACCESS_JSON_1… (3000 characters each, < 9 KB even in multi-byte UTF-8), with the
  // number of parts in ACCESS_JSON_N, written in the same setProperties call: a reader never mixes
  // parts of two versions, and parts left over from a longer list are ignored, then deleted.
  var ACCESS_CHUNK = 3000;
  var MAX_USERS = 2000;
  var MAX_GROUPS = 50;
  var DATA_SPREADSHEET_NAME = 'ShadowIT_AppData';

  /**
   * Time zone used for "today" stamps. Mirrors `timeZone` in appsscript.json; it is a constant
   * because Session.getScriptTimeZone() is out of the allowed API surface (docs/API.md §0).
   */
  var TIME_ZONE = 'Europe/Paris';

  var TABS = {
    postes: 'Postes',
    applications: 'Applications',
    referentiel: 'Referentiel',
    actions: 'Actions',
    replacements: 'Replacements',
    importLog: 'ImportLog',
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
      'warnings_json'],
    Meta: ['key', 'value']
  };

  var SCHEMA_VERSION = '1';

  function props_() {
    return PropertiesService.getScriptProperties();
  }

  /**
   * @return {{dataId: string, sourceId: string, threshold: number, access: {users: Object[], groups: Object[], domainRole: string}}}
   *   ids are '' when unset; threshold is Core.THRESHOLD when unset or invalid.
   */
  function get() {
    var p = props_().getProperties() || {};
    var threshold = Core.validateThreshold(p[PROP_THRESHOLD] || '');
    return {
      dataId: p[PROP_DATA_ID] || '',
      sourceId: p[PROP_SOURCE_ID] || '',
      threshold: threshold === null ? Core.THRESHOLD : threshold,
      access: parseAccess_(readAccessJson_(p))
    };
  }

  /** Concatenates ACCESS_JSON_0..N-1 ('' when unset or a part is missing). */
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

  /**
   * Access list as stored in ACCESS_JSON_*: {users:[{email, role, added_at, added_by}], groups:[same], domainRole}.
   * Anything unreadable becomes the empty list (only the deployer gets in), never an error.
   */
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
    props_().setProperty(PROP_THRESHOLD, String(n));
  }

  /**
   * Writes the access list in one setProperties call, then drops the parts left over from a longer
   * previous list. Call inside Store.withLock.
   * @param {{users: Object[], domainRole: string}} access
   */
  function setAccess(access) {
    var json = JSON.stringify({ users: access.users || [], groups: access.groups || [],
      domainRole: access.domainRole || 'none' });
    var store = props_();
    var parts = {};
    var n = 0;
    for (var i = 0; i < json.length; i += ACCESS_CHUNK) parts[PROP_ACCESS + '_' + (n++)] = json.slice(i, i + ACCESS_CHUNK);
    parts[PROP_ACCESS + '_N'] = String(n);
    store.setProperties(parts);
    var existing = store.getProperties() || {};
    for (var k = n; Object.prototype.hasOwnProperty.call(existing, PROP_ACCESS + '_' + k); k++) store.deleteProperty(PROP_ACCESS + '_' + k);
  }

  function setDataId(id) {
    props_().setProperty(PROP_DATA_ID, String(id || ''));
  }

  function setSourceId(id) {
    props_().setProperty(PROP_SOURCE_ID, String(id || ''));
  }

  function fmt_(pattern) {
    return Utilities.formatDate(new Date(), TIME_ZONE, pattern);
  }

  /** 'YYYY-MM-DD' */
  function today() { return fmt_('yyyy-MM-dd'); }

  /** 'DD/MM/YYYY' */
  function todayFr() { return fmt_('dd/MM/yyyy'); }

  /** 'YYYY-MM-DD HH:mm' */
  function nowStamp() { return fmt_('yyyy-MM-dd HH:mm'); }

  function uuid() { return Utilities.getUuid(); }

  /** @return {string} favicon URL for doGet ('' = do not set one). */
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
    DEFAULT_FAVICON_URL: DEFAULT_FAVICON_URL,
    MAX_USERS: MAX_USERS,
    MAX_GROUPS: MAX_GROUPS,
    DATA_SPREADSHEET_NAME: DATA_SPREADSHEET_NAME,
    TIME_ZONE: TIME_ZONE,
    TABS: TABS,
    SCHEMAS: SCHEMAS,
    SCHEMA_VERSION: SCHEMA_VERSION,
    get: get,
    setDataId: setDataId,
    setSourceId: setSourceId,
    setThreshold: setThreshold,
    setAccess: setAccess,
    faviconUrl: faviconUrl,
    today: today,
    todayFr: todayFr,
    nowStamp: nowStamp,
    uuid: uuid
  };
})();
