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
   * Per-account interface preferences, one Script Property per account: PREFS_<email> = JSON. The page
   * also keeps them in localStorage, but that storage is refused in the Apps Script frame when the
   * browser blocks third-party storage. PREF_VALUES = the only keys and values accepted.
   */
  var PROP_PREFS_PREFIX = 'PREFS_';
  var PREF_VALUES = { sidebar: ['open', 'collapsed'], period: ['month', 'last3', 'last6', 'year', 'all'] };
  /**
   * Browser-tab icon (the ghost): assets/favicon.png (64×64) embedded as a data: URI, so nothing has to be
   * hosted (the repository may be private). The FAVICON_URL Script Property overrides it with a hosted
   * https image (URL ending with .png / .ico) — in case a deployment refuses the data: URI — and '-'
   * removes it. Regenerate with: base64 -w0 assets/favicon.png (a unit test checks they match).
   */
  var DEFAULT_FAVICON_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAJAUlEQVR4nOybe1BU1x3Hv/fuooIgIyy7sKiIjxRTozaipjOdGhpFFN+a+IxR0Wi1naROWq1p02lr1NiONjONk5iYOoliakzTaATxUW1m1GiSqRof04jvZdkHQmSBVVj29He2zbTKOfcBi9qBz1+75/c7v3vO7/7OOff+7jlW3CeSkpzdlQ7hVP6b1aueykr3ddwHFLQyNpstTbF0mApFyaOuZipQHFScJFGvJB0PY7hILdvHQvUfVFRUlKMVaRUHJCen9bPEKDMYMJY6/B20AAb2BTVyTziEwooK9z8RZaLqAB7W1g7Ky4yxWYqiqIgiZDNMrX23sR6/jOZwiYoDEhLSkzvFsZeo04vpbwe0LreB8GvBWnV1IFB2Ay2kxQ5Isqd/16qy3WQqGfcUdiMcYnk0RXyOFtCiMLU5nDMtCvvk3neeoySrVvVISkrqVLSAZkeAze58RVWVn5mpk5qaiqysbyGxSxckJibSZJmE+voGBAIB3Lx5Ezerq3Hu3Hn4fD4zZml+wBq/t2wlmoF5BzidcSlhZSdVHG1E3W63Y2z+GEycMB7Dhg01UgXHjn2Kv+7ahT0fF8FfUWGoDk2Su/1edRrgCsIEph2Q4nDupslurJ5eRo8eWLbseTw5dQosFguaQygUwo73d2L9hj/g+nWXfgXGdvm87gkwgSkHpDjSVykKXtTUsdmwfPlP8fTsWYgm727dhtVr1qKyskpHk/3G53H/CgYx7AC7PW0yVPUDLZ3evXth544/0yhJQ2tw3eXClKnTcPXqVU091tj4pN/v2QkDGHIAPc0O5jMu/ewo0xk8+FG8V7gVXWiCa02qqqowbfosnDp9WkvtdjgU/p6RJdLQMqha1B3Q6HxOzuMo+nhXq3ee07VrV+z66C8YPvz7WmodFYtaCAPoOsCe6lxCcdJLJu/bpw82v7UJ95JOnTrhT5vfxEN9+0p1aK7qa3OkLYQOekOgo93hvEbW7CJhUlJXHNy/r9XGvB5lZW7kPDEy8gwhhDEvrQoZiDw+i9GMAJr1X5B13mq1YjuN+fvVeU56uhNb39kSaYsQRXFQBD+nZUNnCLAfySSLFz2LQQMH4n4zdOgQFMyfJ5UzpjyvVV86BP79koOjIllcbCy++PxEZAg8CNy4UYlHs4fi1q1bQjmtCENkK4I0AlSVTZLJFiwoeGA6z+HvFPPnPSOV04og7YuqIZgmky0okIfc/WLuXLkDoDBzDujqcPSnWj1Esn5ZWXA4HHjQ4O8effr0FsooLdfPZkt/SCQTOsAKyzBIyM0diQeV3JEjpDJVxWPCclEhPUR0g+wiOg6g11Js3VaIEbl56N03C1kP98eY/PEoKt4Lo3BdXofX5Ta4LW6T29Yid6S8bUwJp4vKhasAPfxsIi8In6Jc1y4jJiZGJMK58+ex4ucv4vjxE0L56LxReGXtaukQ8nq9WL5iJYr3lgjlPJ+wds3LeLhfP6G8pqYm4jARlF3e6Pe4l95dLowApijCCODLn6zznBPHP5N2nrO3ZB9KL16Uyi9euiTtPIfb5teQER8fL22fwsRRrZpRTrZpp/6KS0o05TyEi4vlOh9++BH00LtGUpL4mwtTTDiAPJBmxvg3nD1zFnpcKC2Vys4YqK93jeRkyU1icIqKxUOAoZOonFJh0KJLov7rcKLGK3P37t2gh941YmKsMlFnUWFUv94MHDBAX2fggGbJzFzDDFF1wArKBfKJUkaP7t0xT+OJjcv4A40MnkpfscJUJl6XqDogIyMDa2iZEsFn59dffw1xcXHS+ly2ceMfpUONL6FaDmoOVkSZ6dOewvhxY7GnqBiHDh1GLEVEzuPDMWbMaHoa0/d3NuUW3a6rKOL1D/8dwWAwknLLp/pazmsuQldT7j9AdyH+7vJBgwaipHgPHmRy88bg1KmmCVNaggN+r7vJDBr1CPh/o90BaOO0OwBtnHYHoI3T7gC0cdodgDZOuwPQxml3ANo4MgeERYVffXUh8r7tcrkin6R5EjOzZ0/MmDEdkydNREs4cvQoNr+9JbJT1OMph9Uag3SnE0OGZGPpksXIzMw0ZEeVb1IXflaSJURuUkLE1I4nng7b/OYbeOSR/maqRXaCzi9YiBMnPtPUm0lO3rD+99Ajb/RY/OPkySbllBCppoRI4t3lMneZzhXyvXvjJkzE3r0lhut8+eUZPDFilG7nOYXb38OovHzdrbNhFpaJhDc7qknRYPAWnplXgP0HDurqlpZexPiJkyPfA41y8tQpTJw0BbW1tYgWUXXANzy76Ie4cEH+Bai6uhozZj2Nuro6mIU7jtvX+1JsFJkDwmgBvGOz58xFVdXXQvlC6sC1a9fQXA4c/BvW/U48H5idBJsdAWRNc/v2lStXMGv2nCYbl36y7AUcpnS3jnW/jgLWb3gV2wq331HG9xJfunwZZhDuY49PSFhGc0ZncdvY2ZASzrnhKV/ZOT6BGqrkQ0J5eXlkRu7VKxO3yRG/XbU6MplpQZH9qt+CcbEN9RuhWr6tQOkj0y3Ztx8JCQnI6JmBo0ePYcnSH9MS6hHq0reWmtqawLom5SLllFRnMV04T9A6X6gB2f97aouWzAJaMt9CNGB4w+ctW/zfgm6xdgc7TK00dtJC0zY74PO6m2whEQ6BRqb8uml9Vg0WGnn3kTVaWzfTXRN/DzPTPqDozs5zXMFgHcsn+6VoIWElvEpULnRApbfsU1pQc6nTnv+07gxrZD/w+XzCPep+b9kvSFc7trVgOK2y0FMiUSDgrkC4fjQ5SO+khNw8Y89VeDzCiSeaByc70NA5QkMn21Qtxrx1aBxQ4/VqnpRKcqQ/RhPWJzSWY2AGhk0UWYtk4mg+B9SjsSGH7pShkxocfiw21KBk63Wew6OykWE4DYcyGIDuemM4jJeaDqs7ad5pJgm0/tfX1QTej42LL6fgyqa7lQBx4+jjK9b5Pe4ZwWCg2qB5BGsDLqslcYslhjko0gbJ9Mj+SaaEZ1Z4y9/Rs9mqp8ft9vQ5dJeH8n2HTFFiFAYX/T+LcMPbfr+/Bi3AZrM5oXYsUFTWm0KJ72n6mim4StNdMY33Q0bt/AsAAP//OpYlWwAAAAZJREFUAwAb3zTSZFiJ8gAAAABJRU5ErkJggg==';
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
      'warnings_json', 'changes_json'],
    Meta: ['key', 'value']
  };

  var SCHEMA_VERSION = '2'; // 2: ImportLog.changes_json (hourly sync)

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

  function prefsKey_(email) { return PROP_PREFS_PREFIX + String(email || '').trim().toLowerCase(); }

  /** Keeps the known keys with an allowed value. */
  function cleanPrefs_(o) {
    var out = {};
    if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
    Object.keys(PREF_VALUES).forEach(function (k) {
      if (PREF_VALUES[k].indexOf(o[k]) >= 0) out[k] = o[k];
    });
    return out;
  }

  /** @return {Object} the account's preferences ({} when none or unreadable). */
  function getPrefs(email) {
    if (!String(email || '').trim()) return {};
    var raw = props_().getProperty(prefsKey_(email));
    if (!raw) return {};
    try { return cleanPrefs_(JSON.parse(raw)); } catch (e) { return {}; }
  }

  /** Merges `patch` (already validated) into the account's preferences; returns the stored object. */
  function setPrefs(email, patch) {
    var next = cleanPrefs_(Object.assign(getPrefs(email), patch || {}));
    props_().setProperty(prefsKey_(email), JSON.stringify(next));
    return next;
  }

  /** @return {string} favicon URL for doGet: FAVICON_URL (https), '' for '-', else the embedded ghost. */
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
    PROP_PREFS_PREFIX: PROP_PREFS_PREFIX,
    PREF_VALUES: PREF_VALUES,
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
    getPrefs: getPrefs,
    setPrefs: setPrefs,
    today: today,
    todayFr: todayFr,
    nowStamp: nowStamp,
    uuid: uuid
  };
})();
