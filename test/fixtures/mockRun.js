'use strict';
/**
 * Browser mock of `google.script.run` implementing every api_* of docs/API.md §3 over in-memory
 * data built from test/fixtures/data.js.
 *
 *   const { buildMockScript } = require('./mockRun');
 *   const js = buildMockScript({ empty: false, configured: true, delayMs: 0 });
 *   // inject '<script>' + js + '</script>' before the application scripts (see test/helpers/render.js)
 *
 * The returned string is plain browser JavaScript. It defines:
 *   - window.google.script.run      chainable withSuccessHandler / withFailureHandler / withUserObject,
 *                                   one method per api_*; argument = JSON string, success value = JSON
 *                                   envelope string {ok, data|error}, exactly like the real server.
 *   - window.google.script.history  push / replace / setChangeHandler stub (recorded on window.__history)
 *   - window.google.script.url      getLocation(cb) stub: parameters from window.__mockLocation ({} by
 *                                   default), calls counted in window.__locationCalls
 *   - window.__calls                [{name, args}] every call, args already JSON-parsed
 *   - window.__pending              number of calls whose handler has not run yet
 *   - window.__mock                 {db, failNext:{api_name: {code, message, field?} | {transport:true}},
 *                                   formSchema, delays}; a failNext key 'api_name:YYYY-MM' fails only the
 *                                   next call for that month (args.month). formSchema / delays: see
 *                                   buildMockScript (tests may change them at run time). db.editing
 *                                   {edit, create, delete}: the editing switches (Paramètres), changeable
 *                                   at run time (e.g. turned off behind an open page)
 *
 * Records are enriched at call time with window.Core (served by coreScript()), so the mock always
 * agrees with the real Core implementation. Nothing here references Node globals at runtime.
 */
const data = require('./data');
const { SOURCE_ID } = require('./source');

/**
 * Browser-side implementation. Serialised with Function.prototype.toString(), so it must be
 * self-contained (only its two parameters and browser globals).
 */
function mockMain(FIX, OPTS) {
  var Core = function () { return window.Core; }; // resolved lazily: Core is defined after this script
  var KEY_POSTE = 'Nom du poste';
  var KEY_APP = 'Nom du logiciel / service';
  var ERROR_CODES = ['NOT_CONFIGURED', 'MONTH_EXISTS', 'NOT_FOUND', 'BUSY', 'VALIDATION', 'SOURCE_ERROR',
    'FORBIDDEN', 'INTERNAL'];
  var LECTEUR_APIS = ['api_bootstrap', 'api_savePrefs', 'api_getMonthData', 'api_getSyncStatus', 'api_getImportLog',
    'api_getTimeline', 'api_getActions', 'api_getDiff', 'api_notePages'];
  var PREF_VALUES = { sidebar: ['open', 'collapsed'] };
  var EDITING_KEYS = ['edit', 'create', 'delete'];
  // Same refusals as Api.js requireEditing_.
  var EDITING_REFUSED = {
    edit: 'La modification des postes et des applications est désactivée dans les Paramètres.',
    create: 'La création de postes et d’applications est désactivée dans les Paramètres.',
    delete: 'La suppression d’applications est désactivée dans les Paramètres.'
  };
  var OWNER = 'owner@decathlon.com';
  var seq = 0;

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function fail(code, message, field) {
    var e = new Error(message);
    e.code = code;
    if (typeof field === 'string' && field) e.field = field;
    throw e;
  }
  function uuid(prefix) { seq++; return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + seq; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayFr() { var d = new Date(); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function nowStamp() { var d = new Date(); return todayIso() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function s(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function nk(v) { return s(v).normalize('NFC').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').toLowerCase(); }
  function blankToNull(v) { return v === undefined || v === null || s(v) === '' ? null : v; }

  var APP_COLUMNS = FIX.APPS_HEADERS.concat(['Galink', 'IDP'].filter(function (c) {
    return FIX.APPS_HEADERS.indexOf(c) < 0;
  }));

  // ------------------------------------------------------------------------------ in-memory db
  function buildPostes(month, list) {
    return list.map(function (r, i) {
      var rec = clone(r);
      rec._id = 'p-' + month + '-' + (i + 1);
      rec._key = s(r[KEY_POSTE]);
      rec._order = i;
      rec._updated_at = '';
      return rec;
    });
  }
  function buildApps(month, list) {
    var custom = FIX.CUSTOM_FIELDS[month] || {};
    return list.map(function (r, i) {
      var rec = clone(r);
      var c = custom[r[KEY_APP]] || {};
      rec.Galink = c.Galink === undefined ? null : c.Galink;
      rec.IDP = c.IDP === undefined ? null : c.IDP;
      rec._id = 'a-' + month + '-' + (i + 1);
      rec._key = s(r[KEY_APP]);
      rec._order = i;
      rec._updated_at = '';
      return rec;
    });
  }

  /** The month the hourly sync follows: OPTS.currentMonth or the real one. */
  function currentMonth() { return OPTS.currentMonth || Core().currentMonth(new Date()); }

  // Visits over the last ten days, relative to now so that « Aujourd’hui » and the 30-day figures hold.
  // Today's visits sit at fixed fractions of the time elapsed since midnight: always today, in the past.
  function sampleAccessLog() {
    function two(n) { return (n < 10 ? '0' : '') + n; }
    function stamp(d) {
      return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
    }
    var now = new Date();
    var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    function today(f) { return stamp(new Date(midnight.getTime() + Math.floor((now - midnight) * f / 60000) * 60000)); }
    function ago(days, h, m) { return stamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, h, m)); }
    var READER = 'lea.reader@decathlon.com';
    var rows = [
      [ago(9, 9, 10), READER, 'lecteur', ['dashboard', 'postes']],
      [ago(5, 10, 0), 'inconnu@decathlon.com', 'refused', []],
      [ago(3, 14, 22), 'marc.labo@decathlon.com', 'lecteur', ['dashboard', 'apps', 'timeline']],
      [ago(1, 8, 30), READER, 'lecteur', ['dashboard', 'postes']],
      [ago(1, 9, 0), OWNER, 'admin', ['dashboard', 'settings']],
      [ago(1, 15, 2), READER, 'lecteur', ['actions']],
      [today(0.2), OWNER, 'admin', ['dashboard']],
      [today(0.3), READER, 'lecteur', ['dashboard']],
      [today(0.5), 'inconnu@decathlon.com', 'refused', []],
      [today(0.6), READER, 'lecteur', ['postes']],
      [today(0.9), READER, 'lecteur', ['postes', 'actions']]
    ];
    return rows.map(function (r) { return { at: r[0], email: r[1], result: r[2], pages: r[3] }; });
  }

  var db = {
    configured: !!OPTS.configured,
    sourceId: OPTS.configured ? FIX.SOURCE_ID : '',
    sourceTitle: OPTS.configured ? 'ShadowIT_Industry' : '',
    months: {},          // month -> {postes, applications, referentiel, columns}
    importLog: [],       // insertion order
    accessLog: OPTS.empty ? [] : sampleAccessLog(),   // insertion order
    actions: OPTS.empty ? [] : clone(FIX.ACTIONS),
    replacements: OPTS.empty ? [] : clone(FIX.REPLACEMENTS),
    threshold: 80,
    // Editing switches (Config EDITING_JSON): off by default like the server; OPTS.editing (an object) turns
    // them on, except the keys it sets to false.
    editing: { edit: false, create: false, delete: false },
    // Visitor: OPTS.email ('' = identity not passed); default = the owner (deployer).
    email: OPTS.email === undefined ? OWNER : OPTS.email,
    prefs: {},           // email -> {sidebar}
    access: {
      users: [
        { email: 'lea.reader@decathlon.com', role: 'lecteur', added_at: '2026-04-02', added_by: OWNER },
        { email: 'sam.admin@decathlon.com', role: 'admin', added_at: '2026-04-02', added_by: OWNER }
      ],
      groups: [
        { email: 'labo-industry@decathlon.com', role: 'lecteur', added_at: '2026-04-02', added_by: OWNER }
      ],
      domainRole: 'none'
    },
    // Google Groups known to the mock (members visible to the owner); 'hidden@…' is not readable.
    groupMembers: {
      'labo-industry@decathlon.com': ['marc.labo@decathlon.com'],
      'shadow-admins@decathlon.com': ['sam.admin@decathlon.com', 'chloe.admin@decathlon.com'],
      'labo-textile@decathlon.com': ['ines.textile@decathlon.com']
    }
  };
  // Hourly synchronisation status (Sync.js): ran a few minutes ago; OPTS.sync overrides fields.
  db.sync = {
    enabled: !!OPTS.configured,
    lastRunAt: OPTS.configured && !OPTS.empty ? nowStamp() : '',
    lastOkAt: OPTS.configured && !OPTS.empty ? nowStamp() : '',
    lastChangeAt: OPTS.configured && !OPTS.empty ? '2026-05-04 10:30' : '',
    lastChange: OPTS.configured && !OPTS.empty ? { month: '2026-05', at: '2026-05-04 10:30', created: false,
      postes: { added: 1, removed: 1, changed: 2, values: 3 }, applications: { added: 1, removed: 1, changed: 0, values: 0 },
      referentiel: false } : null,
    lastError: null,
    warnings: []
  };
  if (OPTS.sync) Object.keys(OPTS.sync).forEach(function (k) { db.sync[k] = OPTS.sync[k]; });
  if (OPTS.editing) EDITING_KEYS.forEach(function (k) { db.editing[k] = OPTS.editing[k] !== false; });
  function syncStatus() { var st = clone(db.sync); st.month = currentMonth(); return st; }
  function editingView() {
    var out = {};
    EDITING_KEYS.forEach(function (k) { out[k] = db.editing[k] === true; });
    return out;
  }
  function requireEditing(kind) {
    if (db.editing[kind] !== true) fail('FORBIDDEN', EDITING_REFUSED[kind]);
  }

  if (!OPTS.empty) {
    var stamps = { '2026-04': '2026-04-02 09:15', '2026-05': '2026-05-04 10:30' };
    Object.keys(FIX.MONTHS).sort().forEach(function (m) {
      db.months[m] = {
        postes: buildPostes(m, FIX.MONTHS[m].postes),
        applications: buildApps(m, FIX.MONTHS[m].applications),
        referentiel: clone(FIX.REFERENTIEL),
        columns: { postes: FIX.POSTES_HEADERS.slice(), applications: APP_COLUMNS.slice() }
      };
      db.importLog.push({
        month: m, imported_at: stamps[m] || nowStamp(), source_id: FIX.SOURCE_ID,
        counts: { postes: FIX.MONTHS[m].postes.length, applications: FIX.MONTHS[m].applications.length,
          referentiel: Object.keys(FIX.REFERENTIEL).length },
        postes_headers: FIX.POSTES_HEADERS.slice(), apps_headers: FIX.APPS_HEADERS.slice(),
        warnings: ['Suivi des postes : 1 ligne(s) sans « Nom du poste » ignorée(s)']
      });
    });
  }

  function sheetUrl(id) { return 'https://docs.google.com/spreadsheets/d/' + id + '/edit'; }
  function monthList() { return Object.keys(db.months).sort(); }
  function requireMonth(month) {
    if (!Core().validateMonth(month)) fail('VALIDATION', 'Mois invalide : « ' + s(month) + ' » (format AAAA-MM).');
    var m = db.months[month];
    if (!m) fail('NOT_FOUND', 'Le mois ' + month + " n'a pas été importé.");
    return m;
  }
  function enrich(entity, list) {
    return entity === 'postes' ? Core().enrichPostes(clone(list)) : Core().enrichApplications(clone(list));
  }
  function latestInfo(month) {
    for (var i = db.importLog.length - 1; i >= 0; i--) {
      if (db.importLog[i].month === month) {
        return { imported_at: db.importLog[i].imported_at, warnings: clone(db.importLog[i].warnings) };
      }
    }
    return null;
  }
  function obj(args) { return args && typeof args === 'object' && !Array.isArray(args) ? args : {}; }
  function findIndexById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i]._id === id || list[i].id === id) return i;
    return -1;
  }
  function maxOrder(list) {
    return list.reduce(function (mx, r) { return Math.max(mx, r._order); }, -1);
  }

  function saveEntity(entity, keyField, args) {
    var a = obj(args);
    var m = requireMonth(a.month);
    if (!Array.isArray(a.changes)) fail('VALIDATION', 'Paramètre « changes » invalide.');
    var list = m[entity];
    // Validate everything first: nothing is written on error.
    a.changes.forEach(function (ch) {
      if (!ch || typeof ch.updates !== 'object' || ch.updates === null) fail('VALIDATION', 'Modification invalide.');
      Object.keys(ch.updates).forEach(function (k) {
        if (k.charAt(0) === '_') fail('VALIDATION', 'Champ non modifiable : ' + k);
        if (k === keyField) fail('VALIDATION', 'Le champ « ' + keyField + ' » ne peut pas être modifié ici.');
      });
      if (findIndexById(list, ch.id) < 0) fail('NOT_FOUND', 'Enregistrement introuvable : ' + s(ch.id));
    });
    var now = new Date().toISOString();
    var updated = a.changes.map(function (ch) {
      var rec = list[findIndexById(list, ch.id)];
      Object.keys(ch.updates).forEach(function (k) { rec[k] = blankToNull(ch.updates[k]); });
      rec._updated_at = now;
      return rec;
    });
    return { updated: enrich(entity, updated), sourceUpdated: a.month === currentMonth() };
  }

  function slim(rec, fields) {
    var out = {};
    fields.forEach(function (f) { out[f] = rec[f] === undefined ? null : rec[f]; });
    out._score = rec._score;
    out._conforme = rec._conforme;
    return out;
  }

  var ACTION_FIELDS = ['id', 'target_type', 'target_name', 'equipe', 'action', 'responsable', 'date_created',
    'date_completed', 'deadline', 'priorite', 'status', 'source_month', 'comment', 'recorded_at', 'updated_at'];
  var REPLACEMENT_FIELDS = ['id', 'old_poste', 'new_poste', 'equipe', 'responsable', 'date_replacement',
    'comment', 'recorded_at'];

  function updateRowById(list, a, protectedFields, fields) {
    var i = findIndexById(list, a.id);
    if (i < 0) fail('NOT_FOUND', 'Élément introuvable : ' + s(a.id));
    var updates = obj(a.updates);
    Object.keys(updates).forEach(function (k) {
      if (protectedFields.indexOf(k) >= 0) fail('VALIDATION', 'Champ non modifiable : ' + k);
    });
    Object.keys(updates).forEach(function (k) { if (fields.indexOf(k) >= 0) list[i][k] = s(updates[k]); });
    return list[i];
  }
  function deleteById(list, id) {
    var i = findIndexById(list, id);
    if (i < 0) fail('NOT_FOUND', 'Élément introuvable : ' + s(id));
    list.splice(i, 1);
    return { deleted: true, id: id };
  }

  /**
   * Sync.run: the current month is (re)read from the "live" source, which always holds the 2026-05
   * fixture (test/fixtures/source.js). A month that exists already is unchanged (nothing written, no log).
   */
  function runSync() {
    if (!db.configured) fail('NOT_CONFIGURED', 'Aucun classeur source n’est configuré. Renseignez-le dans « Paramètres ».');
    var month = currentMonth();
    var at = nowStamp();
    db.sync.lastRunAt = at;
    if (db.months[month]) {
      db.sync.lastOkAt = at;
      db.sync.lastError = null;
      return { status: syncStatus(), result: { month: month, counts: { postes: db.months[month].postes.length,
        applications: db.months[month].applications.length, referentiel: Object.keys(FIX.REFERENTIEL).length },
        overwritten: true, carriedOver: 0, warnings: [], changed: false,
        changes: { created: false, postes: { added: 0, removed: 0, changed: 0, values: 0 },
          applications: { added: 0, removed: 0, changed: 0, values: 0 }, referentiel: false } } };
    }
    var live = FIX.MONTHS[FIX.LIVE_MONTH];
    var prevMonth = Core().previousMonth(monthList(), month);
    var prevApps = prevMonth && db.months[prevMonth] ? db.months[prevMonth].applications : [];
    var postes = buildPostes(month, live.postes);
    var merged = Core().mergeCarryOver(live.applications, prevApps, KEY_APP, ['Galink', 'IDP']);
    var apps = merged.records.map(function (r, i) {
      r._id = 'a-' + month + '-' + uuid('imp');
      r._key = s(r[KEY_APP]);
      r._order = i;
      r._updated_at = '';
      return r;
    });
    postes.forEach(function (r) { r._id = 'p-' + month + '-' + uuid('imp'); });
    var warnings = ['Suivi des postes : 1 ligne(s) sans « Nom du poste » ignorée(s)'];
    db.months[month] = {
      postes: postes, applications: apps, referentiel: clone(FIX.REFERENTIEL),
      columns: { postes: FIX.POSTES_HEADERS.slice(), applications: APP_COLUMNS.slice() }
    };
    var counts = { postes: postes.length, applications: apps.length, referentiel: Object.keys(FIX.REFERENTIEL).length };
    var changes = { created: true, postes: { added: postes.length, removed: 0, changed: 0, values: 0 },
      applications: { added: apps.length, removed: 0, changed: 0, values: 0 }, referentiel: true };
    db.importLog.push({ month: month, imported_at: at, source_id: db.sourceId, counts: counts,
      postes_headers: FIX.POSTES_HEADERS.slice(), apps_headers: FIX.APPS_HEADERS.slice(),
      warnings: warnings.slice(), changes: changes });
    db.sync.lastOkAt = at;
    db.sync.lastError = null;
    db.sync.lastChangeAt = at;
    db.sync.lastChange = { month: month, at: at, created: true, postes: changes.postes,
      applications: changes.applications, referentiel: true };
    db.sync.warnings = warnings.slice();
    return { status: syncStatus(), result: { month: month, counts: counts, overwritten: false,
      carriedOver: merged.carried, warnings: warnings, changed: true, changes: changes } };
  }

  // ------------------------------------------------------------------------------ creation forms
  // Form columns as the server builds them (Core.snapshotFormColumns over the month's source headers).
  // In the current month the "live source" also has: formulas in Score conformité / Niveau de risque /
  // Statut (computed; the first two filled by an array formula, `arrayFormula`, Statut by the last row's
  // own formula), rejecting lists on the Oui/Non columns, Chiffrement disque, Données sensibles
  // exposées and Criticité équipement, plus window.__mock.formSchema.columns[entity] (extra source
  // columns). window.__mock.formSchema.fallback = true answers as when the source cannot be read.
  var POSTE_COMPUTED = ['Score conformité', 'Niveau de risque', 'Statut'];
  var POSTE_ARRAY_FORMULA = ['Score conformité', 'Niveau de risque'];
  var LIVE_LISTS = { 'Chiffrement disque': ['Oui', 'Non'], 'Données sensibles exposées': ['Oui', 'Non'] };
  var LIVE_STRICT = ['Criticité équipement'];
  var FALLBACK_WARNING = 'Le Google Sheet source n’a pas pu être lu : les champs et les listes viennent de la ' +
    'dernière synchronisation. Les colonnes calculées et les règles de la source seront vérifiées à l’enregistrement.';

  function formOpts() { return window.__mock.formSchema || {}; }
  function keyOf(entity) { return entity === 'postes' ? KEY_POSTE : KEY_APP; }
  function latestLog(month) {
    for (var i = db.importLog.length - 1; i >= 0; i--) if (db.importLog[i].month === month) return db.importLog[i];
    return null;
  }
  function sourceHeaders(entity, month) {
    var log = latestLog(month);
    var h = log ? (entity === 'postes' ? log.postes_headers : log.apps_headers) : null;
    return h && h.length ? h.slice() : (entity === 'postes' ? FIX.POSTES_HEADERS : FIX.APPS_HEADERS).slice();
  }
  function formColumns(entity, month, live) {
    var m = db.months[month];
    var cols = Core().snapshotFormColumns(entity, sourceHeaders(entity, month), m ? m.referentiel : FIX.REFERENTIEL);
    var fo = formOpts();
    if (!live || fo.fallback) return cols;
    cols.forEach(function (c) {
      if (entity === 'postes' && POSTE_COMPUTED.indexOf(c.name) >= 0) {
        c.computed = true;
        if (POSTE_ARRAY_FORMULA.indexOf(c.name) >= 0) c.arrayFormula = true;
        c.required = false;
        c.kind = 'text';
        c.options = null;
        c.strict = false;
      } else if (LIVE_LISTS[c.name]) {
        c.kind = 'select';
        c.options = LIVE_LISTS[c.name].slice();
        c.strict = true;
        c.rule = 'VALUE_IN_LIST';
      } else if (c.kind === 'select' && !c.appOnly && (c.strict || LIVE_STRICT.indexOf(c.name) >= 0)) {
        c.strict = true;
        c.rule = 'VALUE_IN_LIST';
      }
    });
    var extra = (fo.columns && fo.columns[entity]) || [];
    var at = cols.filter(function (c) { return !c.appOnly; }).length;
    extra.forEach(function (x, i) {
      var c = { name: x.name, kind: x.kind || 'text', options: x.options || null, strict: !!x.strict, computed: !!x.computed,
        required: !!x.required };
      if (x.arrayFormula) c.arrayFormula = true;
      if (x.rule) c.rule = x.rule;
      cols.splice(at + i, 0, c);
    });
    return cols;
  }
  function formSchema(args) {
    var a = obj(args);
    if (a.entity !== 'postes' && a.entity !== 'applications') {
      fail('VALIDATION', '« entity » doit valoir « postes » ou « applications ».');
    }
    if (!Core().validateMonth(a.month)) fail('VALIDATION', 'Mois invalide : « ' + s(a.month) + ' » (format AAAA-MM).');
    var live = a.month === currentMonth();
    if (!live) requireMonth(a.month);
    var fallback = live && !!formOpts().fallback;
    var log = latestLog(a.month);
    var out = { entity: a.entity, month: a.month, live: live, origin: live ? (fallback ? 'fallback' : 'source') : 'snapshot',
      keyField: keyOf(a.entity), readAt: live && !fallback ? nowStamp() : (log ? log.imported_at : ''),
      columns: formColumns(a.entity, a.month, live) };
    if (fallback) out.warning = FALLBACK_WARNING;
    return out;
  }
  /** Computed columns of a new live poste, as the source formulas would show them. */
  function computePoste(rec) {
    var n = ['IT Decathlon', 'EDR Decathlon', 'Chiffrement disque', 'Réseau Decathlon', 'Enrolée']
      .filter(function (c) { return s(rec[c]) === 'Oui'; }).length;
    var pct = n * 20;
    rec['Score conformité'] = pct + '%';
    rec['Niveau de risque'] = pct >= 80 ? 'Faible' : pct >= 60 ? 'Moyen' : pct >= 40 ? 'Élevé' : 'Critique';
    rec['Statut'] = pct >= 80 ? 'Conforme' : 'Non conforme';
  }
  /** api_addPoste / api_addApplication: same checks as the server (Core.checkFormRecord, field errors). */
  function addEntity(entity, args) {
    var a = obj(args);
    var keyField = keyOf(entity);
    var m = requireMonth(a.month);
    var input = a.record;
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('VALIDATION', '« record » doit être un objet.');
    var name = s(input[keyField]);
    if (!name) {
      fail('VALIDATION', entity === 'postes' ? 'Le nom du poste est obligatoire.' : "Le nom de l'application est obligatoire.",
        keyField);
    }
    Object.keys(input).forEach(function (k) {
      if (k.charAt(0) === '_') fail('VALIDATION', 'Champ non modifiable : « ' + k + ' ».');
    });
    if (m[entity].some(function (r) { return nk(r[keyField]) === nk(name); })) {
      fail('VALIDATION', (entity === 'postes' ? 'Le poste « ' : "L'application « ") + name + ' » existe déjà pour ce mois.',
        keyField);
    }
    var live = a.month === currentMonth();
    var given = clone(input);
    given[keyField] = name;
    var checked = Core().checkFormRecord(formColumns(entity, a.month, live), given);
    if (!checked.ok) fail('VALIDATION', checked.message, checked.field);
    var rec = {};
    m.columns[entity].forEach(function (c) { rec[c] = null; });
    Object.keys(checked.record).forEach(function (k) { rec[k] = checked.record[k]; });
    rec[keyField] = name;
    if (live && entity === 'postes' && !formOpts().fallback) computePoste(rec);
    rec._id = uuid(entity === 'postes' ? 'p' : 'a');
    rec._key = name;
    rec._order = maxOrder(m[entity]) + 1;
    rec._updated_at = new Date().toISOString();
    m[entity].push(rec);
    return enrich(entity, [rec])[0];
  }

  // ------------------------------------------------------------------------------ api_*
  var API = {
    api_bootstrap: function () {
      var months = monthList();
      var user = checkAccess('api_bootstrap');
      var admin = user.role === 'admin';
      return {
        configured: db.configured,
        months: months,
        latestMonth: months.length ? months[months.length - 1] : '',
        currentMonth: currentMonth(),
        dataUrl: admin ? sheetUrl('1MockDataSpreadsheetId_ShadowIT_AppData') : '',
        sourceUrl: db.configured && admin ? sheetUrl(db.sourceId) : '',
        sourceTitle: db.configured && admin ? db.sourceTitle : '',
        threshold: db.threshold,
        user: user,
        prefs: clone(db.prefs[user.email] || {}),
        editing: editingView(),
        sync: syncStatus()
      };
    },

    api_savePrefs: function (args) {
      var user = checkAccess('api_savePrefs');
      var a = obj(args);
      var keys = Object.keys(a);
      if (!keys.length) fail('VALIDATION', 'Aucune préférence à enregistrer.');
      var next = clone(db.prefs[user.email] || {});
      keys.forEach(function (k) {
        if (!PREF_VALUES[k] || PREF_VALUES[k].indexOf(a[k]) < 0) fail('VALIDATION', 'Préférence invalide : ' + k + '.');
        next[k] = a[k];
      });
      db.prefs[user.email] = next;
      return { prefs: clone(next) };
    },

    api_setConfig: function (args) {
      if (normEmail(db.email) !== OWNER) {
        fail('FORBIDDEN', 'Seul le propriétaire de l’application (le compte qui l’a déployée) peut choisir le classeur source.');
      }
      var id = Core().extractSpreadsheetId(obj(args).source);
      if (!id) fail('VALIDATION', 'URL ou identifiant de Google Sheet invalide.');
      // Convention for tests: an id containing "MISSING" cannot be opened.
      if (/MISSING/.test(id)) fail('SOURCE_ERROR', "Impossible d'ouvrir le classeur source.");
      db.configured = true;
      db.sourceId = id;
      db.sourceTitle = 'ShadowIT_Industry';
      db.sync.enabled = true;
      return { sourceId: id, sourceTitle: db.sourceTitle, sourceUrl: sheetUrl(id),
        tabsFound: { postes: true, applications: true, referentiel: true }, sync: syncStatus() };
    },

    api_getMonthData: function (args) {
      var month = obj(args).month;
      var m = requireMonth(month);
      return {
        month: month,
        postes: enrich('postes', m.postes),
        applications: enrich('applications', m.applications),
        referentiel: clone(m.referentiel),
        columns: clone(m.columns),
        importInfo: latestInfo(month)
      };
    },

    api_getSyncStatus: function () { var st = syncStatus(); st.editing = editingView(); return st; },

    api_syncNow: function () { return runSync(); },

    api_enableSync: function () {
      db.sync.enabled = true;
      return runSync();
    },

    api_getImportLog: function (args) {
      var limit = obj(args).limit === undefined || obj(args).limit === null ? 12 : obj(args).limit;
      if (typeof limit !== 'number' || Math.floor(limit) !== limit || limit < 1 || limit > 500) {
        fail('VALIDATION', '« limit » doit être un entier entre 1 et 500.');
      }
      return clone(db.importLog).reverse().slice(0, limit).map(function (e) {
        return { month: e.month, imported_at: e.imported_at, counts: e.counts, warnings: e.warnings, changes: e.changes || null };
      });
    },

    api_getAccessLog: function (args) {
      var limit = obj(args).limit === undefined || obj(args).limit === null ? 50 : obj(args).limit;
      if (typeof limit !== 'number' || Math.floor(limit) !== limit || limit < 1 || limit > 500) {
        fail('VALIDATION', '« limit » doit être un entier entre 1 et 500.');
      }
      return clone(db.accessLog).reverse().slice(0, limit);
    },

    api_notePages: function (args) {
      var pages = obj(args).pages;
      var ids = ['dashboard', 'postes', 'apps', 'timeline', 'actions', 'settings'];
      if (!Array.isArray(pages) || !pages.length || pages.length > ids.length ||
        pages.some(function (p) { return ids.indexOf(p) < 0; })) {
        fail('VALIDATION', '« pages » doit être une liste de pages de l’application.');
      }
      for (var i = db.accessLog.length - 1; i >= 0; i--) {
        var row = db.accessLog[i];
        if (row.email !== normEmail(db.email) || row.result === 'refused') continue;
        pages.forEach(function (p) { if (row.pages.indexOf(p) < 0) row.pages.push(p); });
        break;
      }
      return null;
    },

    api_savePostes: function (args) { requireEditing('edit'); return saveEntity('postes', KEY_POSTE, args); },
    api_saveApplications: function (args) { requireEditing('edit'); return saveEntity('applications', KEY_APP, args); },

    api_addGenericPoste: function (args) {
      requireEditing('create');
      var month = obj(args).month;
      var m = requireMonth(month);
      var names = m.postes.map(function (r) { return r[KEY_POSTE]; });
      var rec = Core().makeGenericPoste(m.columns.postes, names);
      if (!rec) {
        var existing = m.postes.filter(function (r) { return nk(r[KEY_POSTE]) === nk(Core().GENERIC_POSTE_NAME); })[0];
        return { created: false, record: enrich('postes', [existing])[0] };
      }
      rec._id = uuid('p');
      rec._key = s(rec[KEY_POSTE]);
      rec._order = maxOrder(m.postes) + 1;
      rec._updated_at = new Date().toISOString();
      m.postes.push(rec);
      return { created: true, record: enrich('postes', [rec])[0] };
    },

    api_addPoste: function (args) { requireEditing('create'); return addEntity('postes', args); },

    api_getFormSchema: function (args) { requireEditing('create'); return formSchema(args); },

    api_addApplication: function (args) { requireEditing('create'); return addEntity('applications', args); },

    api_deleteApplication: function (args) {
      requireEditing('delete');
      var a = obj(args);
      var m = requireMonth(a.month);
      var i = findIndexById(m.applications, a.id);
      if (i < 0) fail('NOT_FOUND', 'Application introuvable.');
      m.applications.splice(i, 1);
      return { deleted: true, id: a.id };
    },

    api_renameApplication: function (args) {
      requireEditing('edit');
      var a = obj(args);
      var m = requireMonth(a.month);
      var newName = s(a.newName);
      if (!newName) fail('VALIDATION', 'Le nouveau nom est obligatoire.');
      var i = findIndexById(m.applications, a.id);
      if (i < 0) fail('NOT_FOUND', 'Application introuvable.');
      var rec = m.applications[i];
      if (m.applications.some(function (r, j) { return j !== i && nk(r[KEY_APP]) === nk(newName); })) {
        fail('VALIDATION', "L'application « " + newName + ' » existe déjà pour ce mois.');
      }
      var oldName = s(rec[KEY_APP]);
      rec[KEY_APP] = newName;
      rec._key = newName;
      rec._updated_at = new Date().toISOString();
      var n = 0;
      db.actions.forEach(function (act) {
        if (act.target_type === 'application' && act.target_name === oldName) {
          act.target_name = newName;
          act.updated_at = todayIso();
          n++;
        }
      });
      return { record: enrich('applications', [rec])[0], actionsUpdated: n };
    },

    api_getTimeline: function () {
      var pf = ['Équipe', 'Bâtiment / Labo', 'EDR Decathlon', 'IT Decathlon', 'Réseau Decathlon', 'Niveau de risque'];
      var af = ['Équipe', 'SIP', 'Contrat', 'Galink', 'IDP', 'Niveau de risque'];
      return monthList().map(function (month) {
        var m = db.months[month];
        return {
          month: month,
          postes: enrich('postes', m.postes).map(function (r) { return slim(r, pf); }),
          applications: enrich('applications', m.applications).map(function (r) { return slim(r, af); })
        };
      });
    },

    api_getActions: function () { return { actions: clone(db.actions), replacements: clone(db.replacements) }; },

    api_addAction: function (args) {
      var a = obj(args);
      if (a.target_type !== 'poste' && a.target_type !== 'application') {
        fail('VALIDATION', 'Type de cible invalide (poste ou application).');
      }
      if (!s(a.target_name)) fail('VALIDATION', 'La cible de l’action est obligatoire.');
      if (!s(a.action)) fail('VALIDATION', 'La description de l’action est obligatoire.');
      var act = {};
      ACTION_FIELDS.forEach(function (f) { act[f] = s(a[f]); });
      act.id = uuid('act');
      act.status = act.status || 'À faire';
      act.date_created = act.date_created || todayFr();
      act.recorded_at = todayIso();
      act.updated_at = '';
      db.actions.push(act);
      return clone(act);
    },

    api_updateAction: function (args) {
      var act = updateRowById(db.actions, obj(args), ['id', 'recorded_at'], ACTION_FIELDS);
      act.updated_at = todayIso();
      return clone(act);
    },

    api_deleteAction: function (args) { return deleteById(db.actions, obj(args).id); },

    api_addReplacement: function (args) {
      var a = obj(args);
      if (!s(a.old_poste) || !s(a.new_poste)) fail('VALIDATION', "L'ancien et le nouveau poste sont obligatoires.");
      var rep = {};
      REPLACEMENT_FIELDS.forEach(function (f) { rep[f] = s(a[f]); });
      rep.id = uuid('rep');
      rep.date_replacement = rep.date_replacement || todayFr();
      rep.recorded_at = todayIso();
      db.replacements.push(rep);
      return clone(rep);
    },

    api_updateReplacement: function (args) {
      return clone(updateRowById(db.replacements, obj(args), ['id', 'recorded_at'], REPLACEMENT_FIELDS));
    },

    api_deleteReplacement: function (args) { return deleteById(db.replacements, obj(args).id); },

    api_getDiff: function (args) {
      var a = obj(args);
      var o = requireMonth(a.oldMonth);
      var n = requireMonth(a.newMonth);
      return {
        oldMonth: a.oldMonth,
        newMonth: a.newMonth,
        postes: Core().diffPostes(enrich('postes', o.postes), enrich('postes', n.postes)),
        applications: Core().diffApplications(enrich('applications', o.applications),
          enrich('applications', n.applications))
      };
    },

    api_getSettings: function () {
      return {
        threshold: db.threshold,
        defaultThreshold: 80,
        source: db.configured ? { id: db.sourceId, url: sheetUrl(db.sourceId), title: db.sourceTitle,
          tabsFound: { postes: true, applications: true, referentiel: true } } :
          { id: '', url: '', title: '', tabsFound: null },
        dataUrl: sheetUrl('1MockDataSpreadsheetId_ShadowIT_AppData'),
        access: accessView(),
        me: db.email,
        editing: editingView(),
        sync: syncStatus()
      };
    },

    api_setEditing: function (args) {
      var a = obj(args);
      var keys = Object.keys(a);
      if (!keys.length) fail('VALIDATION', 'Aucun réglage à enregistrer.');
      keys.forEach(function (k) {
        if (EDITING_KEYS.indexOf(k) < 0) fail('VALIDATION', 'Réglage inconnu : « ' + k + ' ».');
        if (typeof a[k] !== 'boolean') fail('VALIDATION', '« ' + k + ' » doit valoir true ou false.');
      });
      keys.forEach(function (k) { db.editing[k] = a[k]; });
      return { editing: editingView() };
    },

    api_setThreshold: function (args) {
      var n = Core().validateThreshold(obj(args).threshold);
      if (n === null) fail('VALIDATION', 'Seuil invalide : un nombre entier entre 1 et 100 est attendu.');
      db.threshold = n;
      Core().setThreshold(n);
      return { threshold: n };
    },

    api_saveUser: function (args) {
      var a = obj(args);
      var email = editableEmail(a.email);
      if (['admin', 'lecteur'].indexOf(a.role) < 0) fail('VALIDATION', 'Rôle invalide : « ' + s(a.role) + ' ».');
      var hit = db.access.users.filter(function (u) { return u.email === email; })[0];
      if (hit) hit.role = a.role;
      else db.access.users.push({ email: email, role: a.role, added_at: todayIso(), added_by: db.email });
      return accessView();
    },

    api_addUsers: function (args) {
      var a = obj(args);
      if (['admin', 'lecteur'].indexOf(a.role) < 0) fail('VALIDATION', 'Rôle invalide : « ' + s(a.role) + ' ».');
      if (!Array.isArray(a.emails) || !a.emails.length) fail('VALIDATION', 'Aucune adresse à ajouter.');
      if (a.emails.length > 500) fail('VALIDATION', 'Au plus 500 adresses par ajout.');
      var me = normEmail(db.email);
      var res = { added: [], updated: [], skipped: [] };
      var seen = {};
      a.emails.forEach(function (v) {
        var email = normEmail(v);
        var reason = !Core().isEmail(email) ? 'adresse invalide' : email === OWNER ? 'propriétaire' :
          email === me ? 'votre propre compte' : seen[email] ? 'doublon' : '';
        if (reason) { res.skipped.push({ email: s(v), reason: reason }); return; }
        seen[email] = true;
        var hit = db.access.users.filter(function (u) { return u.email === email; })[0];
        if (!hit) {
          db.access.users.push({ email: email, role: a.role, added_at: todayIso(), added_by: me });
          res.added.push(email);
        } else if (hit.role !== a.role) {
          hit.role = a.role;
          res.updated.push(email);
        } else {
          res.skipped.push({ email: email, reason: 'déjà ' + (a.role === 'admin' ? 'administrateur' : 'lecteur') });
        }
      });
      res.access = accessView();
      return res;
    },

    api_saveGroup: function (args) {
      var a = obj(args);
      if (['admin', 'lecteur'].indexOf(a.role) < 0) fail('VALIDATION', 'Rôle invalide : « ' + s(a.role) + ' ».');
      var email = normEmail(a.email);
      if (!Core().isEmail(email)) fail('VALIDATION', 'Adresse e-mail invalide : « ' + s(a.email) + ' ».');
      if (!db.groupMembers[email]) {
        fail('VALIDATION', 'Groupe introuvable ou membres non visibles pour le propriétaire du déploiement : ' + email + '.');
      }
      var before = clone(db.access.groups);
      var hit = db.access.groups.filter(function (g) { return g.email === email; })[0];
      if (hit) hit.role = a.role;
      else db.access.groups.push({ email: email, role: a.role, added_at: todayIso(), added_by: normEmail(db.email) });
      if (roleOf(normEmail(db.email)) !== 'admin') {
        db.access.groups = before;
        fail('VALIDATION', 'Ce changement vous retirerait le rôle administrateur (vous l’avez par ce groupe).');
      }
      return accessView();
    },

    api_removeGroup: function (args) {
      var email = normEmail(obj(args).email);
      var before = db.access.groups;
      var kept = before.filter(function (g) { return g.email !== email; });
      if (kept.length === before.length) fail('NOT_FOUND', 'Aucun groupe enregistré : ' + email + '.');
      db.access.groups = kept;
      if (roleOf(normEmail(db.email)) !== 'admin') {
        db.access.groups = before;
        fail('VALIDATION', 'Ce changement vous retirerait le rôle administrateur (vous l’avez par ce groupe).');
      }
      return accessView();
    },

    api_removeUser: function (args) {
      var email = editableEmail(obj(args).email);
      var kept = db.access.users.filter(function (u) { return u.email !== email; });
      if (kept.length === db.access.users.length) fail('NOT_FOUND', 'Aucun accès enregistré pour ' + email + '.');
      db.access.users = kept;
      return accessView();
    },

    api_setDomainRole: function (args) {
      var role = obj(args).role;
      if (['none', 'lecteur'].indexOf(role) < 0) fail('VALIDATION', 'Rôle invalide : « ' + s(role) + ' ».');
      db.access.domainRole = role;
      return accessView();
    }
  };

  // ------------------------------------------------------------------------------ access
  function normEmail(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
  function roleOf(email) {
    if (!email) return '';
    if (email === OWNER) return 'admin';
    var hit = db.access.users.filter(function (u) { return u.email === email; })[0];
    var role = hit ? hit.role : '';
    if (role !== 'admin' && db.access.domainRole === 'lecteur') role = 'lecteur';
    db.access.groups.forEach(function (g) {
      var members = db.groupMembers[g.email] || [];
      if (members.indexOf(email) >= 0 && (g.role === 'admin' || !role)) role = g.role === 'admin' ? 'admin' : role || 'lecteur';
    });
    return role;
  }
  function accessView() {
    var users = clone(db.access.users);
    users.sort(function (a, b) { return a.email < b.email ? -1 : a.email > b.email ? 1 : 0; });
    var groups = clone(db.access.groups);
    groups.sort(function (a, b) { return a.email < b.email ? -1 : a.email > b.email ? 1 : 0; });
    return { owner: OWNER, users: users, groups: groups, domainRole: db.access.domainRole };
  }
  function editableEmail(v) {
    var email = normEmail(v);
    if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(email)) {
      fail('VALIDATION', 'Adresse e-mail invalide : « ' + s(v) + ' ».');
    }
    if (email === OWNER) fail('VALIDATION', 'Le propriétaire du déploiement est toujours administrateur.');
    if (email === normEmail(db.email)) fail('VALIDATION', 'Vous ne pouvez pas modifier votre propre accès.');
    return email;
  }
  /** Same checks as Access.requireRole on the server. */
  function checkAccess(name) {
    var email = normEmail(db.email);
    if (!email) {
      fail('FORBIDDEN', 'Identité Google non transmise. Ouvrez l’application avec un compte du même domaine ' +
        'Google Workspace que son propriétaire.');
    }
    var role = roleOf(email);
    if (!role) fail('FORBIDDEN', 'Accès refusé pour ' + email + '. Demandez l’accès à un administrateur.');
    if (role !== 'admin' && LECTEUR_APIS.indexOf(name) < 0) fail('FORBIDDEN', 'Action réservée aux administrateurs.');
    Core().setThreshold(db.threshold);
    return { email: email, role: role, isOwner: email === OWNER };
  }

  // ------------------------------------------------------------------------------ transport
  window.__calls = [];
  window.__pending = 0;
  window.__history = [];
  if (OPTS.prefs) db.prefs[normEmail(db.email)] = clone(OPTS.prefs);
  window.__mock = { db: db, failNext: OPTS.failNext || {}, formSchema: OPTS.formSchema || {}, delays: OPTS.delays || {} };

  function dispatch(name, argsJson, onSuccess, onFailure, userObject) {
    var args;
    var parseError = false;
    try { args = JSON.parse(argsJson); } catch (e) { parseError = true; }
    window.__calls.push({ name: name, args: parseError ? argsJson : args });
    window.__pending++;
    setTimeout(function () {
      window.__pending--;
      // failNext['api_x:2026-04'] only fails the call for that month; failNext['api_x'] the next call.
      var failKey = args && typeof args === 'object' && window.__mock.failNext[name + ':' + args.month] ?
        name + ':' + args.month : name;
      var forced = window.__mock.failNext[failKey];
      if (forced) delete window.__mock.failNext[failKey];
      if (forced && forced.transport) {
        if (onFailure) onFailure(new Error('ScriptError: transport simulé'), userObject);
        return;
      }
      var envelope;
      try {
        if (forced) fail(forced.code || 'INTERNAL', forced.message || 'Erreur simulée', forced.field);
        checkAccess(name);
        if (parseError || typeof argsJson !== 'string') fail('VALIDATION', 'Arguments JSON invalides.');
        envelope = { ok: true, data: API[name](args) };
      } catch (err) {
        var code = ERROR_CODES.indexOf(err.code) >= 0 ? err.code : 'INTERNAL';
        envelope = { ok: false, error: { code: code, message: String(err.message || err) } };
        if (code === 'VALIDATION' && typeof err.field === 'string' && err.field) envelope.error.field = err.field;
        if (code === 'INTERNAL') console.warn('[mock] ' + name + ' failed', err);
      }
      if (onSuccess) onSuccess(JSON.stringify(envelope), userObject);
    }, (OPTS.delayMs || 0) + (window.__mock.delays[name] || 0) +
      (name === 'api_getFormSchema' ? (window.__mock.formSchema.delayMs || 0) : 0));
  }

  function makeRunner(onSuccess, onFailure, userObject) {
    var runner = {
      withSuccessHandler: function (fn) { return makeRunner(fn, onFailure, userObject); },
      withFailureHandler: function (fn) { return makeRunner(onSuccess, fn, userObject); },
      withUserObject: function (o) { return makeRunner(onSuccess, onFailure, o); }
    };
    Object.keys(API).forEach(function (name) {
      runner[name] = function (argsJson) { dispatch(name, argsJson, onSuccess, onFailure, userObject); };
    });
    return runner;
  }

  var changeHandler = null;
  window.google = window.google || {};
  window.google.script = {
    run: makeRunner(null, null, undefined),
    history: {
      push: function (state, params, hash) { window.__history.push({ op: 'push', state: state, params: params, hash: hash }); },
      replace: function (state, params, hash) { window.__history.push({ op: 'replace', state: state, params: params, hash: hash }); },
      setChangeHandler: function (fn) { changeHandler = fn; }
    },
    url: {
      // URL parameters of the outer page: window.__mockLocation (e.g. {page:'apps'}, set by an init script).
      getLocation: function (cb) {
        var p = window.__mockLocation || {};
        var all = {};
        Object.keys(p).forEach(function (k) { all[k] = [p[k]]; });
        window.__locationCalls = (window.__locationCalls || 0) + 1;
        setTimeout(function () { cb({ hash: '', parameter: p, parameters: all }); }, 0);
      }
    },
    host: { close: function () {}, setHeight: function () {}, setWidth: function () {} }
  };
  // Test hook: simulate the browser back button (fires the history change handler).
  window.__mock.popState = function (state) {
    if (changeHandler) changeHandler({ state: state, location: { hash: '', parameter: {}, parameters: {} } });
  };
}

/**
 * @param {{empty?:boolean, configured?:boolean, delayMs?:number, email?:string, failNext?:object,
 *          prefs?:object, currentMonth?:string, sync?:object, formSchema?:object, delays?:object,
 *          editing?:object}} [options]
 *   formSchema: api_getFormSchema of the current month (window.__mock.formSchema): {columns:{postes:[col],
 *   applications:[col]} (extra source columns, {name, kind?, options?, strict?, computed?, arrayFormula?, required?,
 *   rule?}),
 *   fallback:true (origin 'fallback' + warning, no computed column), delayMs (extra answer delay)}.
 *   delays: extra answer delay per api name ({api_addPoste: 400}). failNext entries may carry a `field`.
 *   prefs: the visitor's stored
 *   preferences ({sidebar:'collapsed'}). currentMonth: the month the sync follows (default: today's).
 *   sync: fields of the synchronisation status to override ({lastError:{at, code, message}}, …).
 *   editing: the editing switches of Paramètres: null / absent = unset (all off, the server's default); an object
 *   turns them on except the keys it sets to false ({edit:false} = create and delete only).
 *   email: the visitor (default the owner, admin). 'lea.reader@decathlon.com' is a lecteur,
 *   'sam.admin@decathlon.com' a second admin, any other address has no access, '' = identity not passed.
 * @returns {string} browser JavaScript (no surrounding <script> tag)
 */
function buildMockScript({ empty = false, configured = true, delayMs = 0, email, failNext, prefs, currentMonth, sync,
  formSchema, delays, editing } = {}) {
  const fixtures = {
    POSTES_HEADERS: data.POSTES_HEADERS,
    APPS_HEADERS: data.APPS_HEADERS,
    MONTHS: data.MONTHS,
    CUSTOM_FIELDS: data.CUSTOM_FIELDS,
    REFERENTIEL: data.REFERENTIEL,
    ACTIONS: data.ACTIONS,
    REPLACEMENTS: data.REPLACEMENTS,
    SOURCE_ID,
    LIVE_MONTH: '2026-05',
  };
  // Escape '<' so that fixture strings such as '</script>' cannot terminate the inline script.
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return '(' + mockMain.toString() + ')(' + json(fixtures) + ', ' + json({ empty, configured, delayMs, email, failNext: failNext || {}, prefs: prefs || null,
    currentMonth: currentMonth || null, sync: sync || null, formSchema: formSchema || null, delays: delays || null,
    editing: editing || null }) + ');';
}

/**
 * The JSON envelope string api_bootstrap returns for these mock options, computed in Node by running the
 * same mock script over the real Core in a vm: what doGet would inline into the page for that visitor
 * (see test/helpers/render.js, option `boot`). The browser mock starts from the same fixtures, so the
 * inline data and the later google.script.run answers agree.
 * @param {object} [options] same as buildMockScript
 * @returns {string} '{"ok":true,"data":{...}}' or '{"ok":false,"error":{...}}'
 */
function bootstrapEnvelope(options = {}) {
  const vm = require('node:vm');
  const { coreScript } = require('../helpers/render');
  const quiet = () => {};
  const ctx = vm.createContext({ console: { log: quiet, info: quiet, debug: quiet, warn: quiet, error: quiet } });
  ctx.window = ctx;
  ctx.setTimeout = (fn) => { fn(); return 0; };   // answers synchronously
  vm.runInContext(coreScript(), ctx);
  vm.runInContext(buildMockScript({ ...options, delayMs: 0 }), ctx);
  let out = null;
  ctx.google.script.run
    .withSuccessHandler((s) => { out = s; })
    .withFailureHandler((err) => { out = JSON.stringify({ ok: false, error: { code: 'TRANSPORT', message: String(err && err.message) } }); })
    .api_bootstrap('null');
  if (typeof out !== 'string') throw new Error('bootstrapEnvelope: the mock did not answer');
  return out;
}

module.exports = { buildMockScript, bootstrapEnvelope };
