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
   * @return {{dataId: string, sourceId: string, threshold: number, access: {users: Object[], domainRole: string}}}
   *   ids are '' when unset; threshold is Core.THRESHOLD when unset or invalid.
   */
  function get() {
    var p = props_().getProperties() || {};
    var threshold = Core.validateThreshold(p[PROP_THRESHOLD] || '');
    return {
      dataId: p[PROP_DATA_ID] || '',
      sourceId: p[PROP_SOURCE_ID] || '',
      threshold: threshold === null ? Core.THRESHOLD : threshold,
      access: parseAccess_(p[PROP_ACCESS])
    };
  }

  /**
   * Access list as stored in ACCESS_JSON: {users:[{email, role, added_at, added_by}], domainRole}.
   * Anything unreadable becomes the empty list (only the deployer gets in), never an error.
   */
  function parseAccess_(json) {
    var raw = null;
    try { raw = json ? JSON.parse(json) : null; } catch (e) { raw = null; }
    var users = raw && Array.isArray(raw.users) ? raw.users : [];
    return {
      users: users.filter(function (u) { return u && typeof u.email === 'string' && u.email; }).map(function (u) {
        return { email: String(u.email), role: String(u.role || ''), added_at: String(u.added_at || ''),
          added_by: String(u.added_by || '') };
      }),
      domainRole: raw && typeof raw.domainRole === 'string' ? raw.domainRole : 'none'
    };
  }

  function setThreshold(n) {
    props_().setProperty(PROP_THRESHOLD, String(n));
  }

  /** @param {{users: Object[], domainRole: string}} access */
  function setAccess(access) {
    props_().setProperty(PROP_ACCESS, JSON.stringify({ users: access.users || [], domainRole: access.domainRole || 'none' }));
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

  return {
    PROP_DATA_ID: PROP_DATA_ID,
    PROP_SOURCE_ID: PROP_SOURCE_ID,
    PROP_THRESHOLD: PROP_THRESHOLD,
    PROP_ACCESS: PROP_ACCESS,
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
    today: today,
    todayFr: todayFr,
    nowStamp: nowStamp,
    uuid: uuid
  };
})();
