/**
 * Config — Script Properties access and data-spreadsheet constants (docs/API.md §4).
 *
 * Load-order safe: the IIFE only defines values and functions; GAS services are touched lazily,
 * inside the functions.
 */
var Config = (function () {
  var PROP_DATA_ID = 'DATA_SPREADSHEET_ID';
  var PROP_SOURCE_ID = 'SOURCE_SPREADSHEET_ID';
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

  /** @return {{dataId: string, sourceId: string}} ('' when unset) */
  function get() {
    var p = props_().getProperties() || {};
    return { dataId: p[PROP_DATA_ID] || '', sourceId: p[PROP_SOURCE_ID] || '' };
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
    DATA_SPREADSHEET_NAME: DATA_SPREADSHEET_NAME,
    TIME_ZONE: TIME_ZONE,
    TABS: TABS,
    SCHEMAS: SCHEMAS,
    SCHEMA_VERSION: SCHEMA_VERSION,
    get: get,
    setDataId: setDataId,
    setSourceId: setSourceId,
    today: today,
    todayFr: todayFr,
    nowStamp: nowStamp,
    uuid: uuid
  };
})();
