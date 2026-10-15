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
 *   - window.google.script.url      getLocation(cb) stub
 *   - window.__calls                [{name, args}] every call, args already JSON-parsed
 *   - window.__pending              number of calls whose handler has not run yet
 *   - window.__mock                 {db, failNext:{api_name: {code, message} | {transport:true}}}
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
    'INTERNAL'];
  var seq = 0;

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
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

  var db = {
    configured: !!OPTS.configured,
    sourceId: OPTS.configured ? FIX.SOURCE_ID : '',
    sourceTitle: OPTS.configured ? 'ShadowIT_Industry' : '',
    months: {},          // month -> {postes, applications, referentiel, columns}
    importLog: [],       // insertion order
    actions: OPTS.empty ? [] : clone(FIX.ACTIONS),
    replacements: OPTS.empty ? [] : clone(FIX.REPLACEMENTS)
  };
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
    return { updated: enrich(entity, updated) };
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

  // ------------------------------------------------------------------------------ api_*
  var API = {
    api_bootstrap: function () {
      var months = monthList();
      return {
        configured: db.configured,
        months: months,
        latestMonth: months.length ? months[months.length - 1] : '',
        currentMonth: Core().currentMonth(new Date()),
        dataUrl: sheetUrl('1MockDataSpreadsheetId_ShadowIT_AppData'),
        sourceUrl: db.configured ? sheetUrl(db.sourceId) : '',
        sourceTitle: db.configured ? db.sourceTitle : ''
      };
    },

    api_setConfig: function (args) {
      var id = Core().extractSpreadsheetId(obj(args).source);
      if (!id) fail('VALIDATION', 'URL ou identifiant de Google Sheet invalide.');
      // Convention for tests: an id containing "MISSING" cannot be opened.
      if (/MISSING/.test(id)) fail('SOURCE_ERROR', "Impossible d'ouvrir le classeur source.");
      db.configured = true;
      db.sourceId = id;
      db.sourceTitle = 'ShadowIT_Industry';
      return { sourceId: id, sourceTitle: db.sourceTitle, sourceUrl: sheetUrl(id),
        tabsFound: { postes: true, applications: true, referentiel: true } };
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

    api_importMonth: function (args) {
      var a = obj(args);
      if (!db.configured) fail('NOT_CONFIGURED', "La source n'est pas configurée.");
      if (!Core().validateMonth(a.month)) fail('VALIDATION', 'Mois invalide : « ' + s(a.month) + ' » (format AAAA-MM).');
      var exists = !!db.months[a.month];
      if (exists && !a.overwrite) fail('MONTH_EXISTS', 'Le mois ' + a.month + ' existe déjà.');
      // The "live" source sheet always holds the 2026-05 fixture (see test/fixtures/source.js).
      var live = FIX.MONTHS[FIX.LIVE_MONTH];
      var prevMonth = exists ? a.month : Core().previousMonth(monthList(), a.month);
      var prevApps = prevMonth && db.months[prevMonth] ? db.months[prevMonth].applications : [];
      var postes = buildPostes(a.month, live.postes);
      var merged = Core().mergeCarryOver(live.applications, prevApps, KEY_APP, ['Galink', 'IDP']);
      var apps = merged.records.map(function (r, i) {
        r._id = 'a-' + a.month + '-' + uuid('imp');
        r._key = s(r[KEY_APP]);
        r._order = i;
        r._updated_at = '';
        return r;
      });
      postes.forEach(function (r) { r._id = 'p-' + a.month + '-' + uuid('imp'); });
      var warnings = ['Suivi des postes : 1 ligne(s) sans « Nom du poste » ignorée(s)'];
      db.months[a.month] = {
        postes: postes, applications: apps, referentiel: clone(FIX.REFERENTIEL),
        columns: { postes: FIX.POSTES_HEADERS.slice(), applications: APP_COLUMNS.slice() }
      };
      var counts = { postes: postes.length, applications: apps.length,
        referentiel: Object.keys(FIX.REFERENTIEL).length };
      db.importLog.push({ month: a.month, imported_at: nowStamp(), source_id: db.sourceId, counts: counts,
        postes_headers: FIX.POSTES_HEADERS.slice(), apps_headers: FIX.APPS_HEADERS.slice(),
        warnings: warnings.slice() });
      return { month: a.month, counts: counts, overwritten: exists, carriedOver: merged.carried,
        warnings: warnings };
    },

    api_getImportLog: function () { return clone(db.importLog).reverse(); },

    api_savePostes: function (args) { return saveEntity('postes', KEY_POSTE, args); },
    api_saveApplications: function (args) { return saveEntity('applications', KEY_APP, args); },

    api_addGenericPoste: function (args) {
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

    api_addApplication: function (args) {
      var a = obj(args);
      var m = requireMonth(a.month);
      var input = obj(a.record);
      var name = s(input[KEY_APP]);
      if (!name) fail('VALIDATION', "Le nom de l'application est obligatoire.");
      if (m.applications.some(function (r) { return nk(r[KEY_APP]) === nk(name); })) {
        fail('VALIDATION', "L'application « " + name + ' » existe déjà pour ce mois.');
      }
      var rec = {};
      m.columns.applications.forEach(function (c) { rec[c] = blankToNull(input[c]); });
      Object.keys(input).forEach(function (k) { if (k.charAt(0) !== '_') rec[k] = blankToNull(input[k]); });
      rec[KEY_APP] = name;
      rec._id = uuid('a');
      rec._key = name;
      rec._order = maxOrder(m.applications) + 1;
      rec._updated_at = new Date().toISOString();
      m.applications.push(rec);
      return enrich('applications', [rec])[0];
    },

    api_deleteApplication: function (args) {
      var a = obj(args);
      var m = requireMonth(a.month);
      var i = findIndexById(m.applications, a.id);
      if (i < 0) fail('NOT_FOUND', 'Application introuvable.');
      m.applications.splice(i, 1);
      return { deleted: true, id: a.id };
    },

    api_renameApplication: function (args) {
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
    }
  };

  // ------------------------------------------------------------------------------ transport
  window.__calls = [];
  window.__pending = 0;
  window.__history = [];
  window.__mock = { db: db, failNext: {} };

  function dispatch(name, argsJson, onSuccess, onFailure, userObject) {
    var args;
    var parseError = false;
    try { args = JSON.parse(argsJson); } catch (e) { parseError = true; }
    window.__calls.push({ name: name, args: parseError ? argsJson : args });
    window.__pending++;
    setTimeout(function () {
      window.__pending--;
      var forced = window.__mock.failNext[name];
      if (forced) delete window.__mock.failNext[name];
      if (forced && forced.transport) {
        if (onFailure) onFailure(new Error('ScriptError: transport simulé'), userObject);
        return;
      }
      var envelope;
      try {
        if (forced) fail(forced.code || 'INTERNAL', forced.message || 'Erreur simulée');
        if (parseError || typeof argsJson !== 'string') fail('VALIDATION', 'Arguments JSON invalides.');
        envelope = { ok: true, data: API[name](args) };
      } catch (err) {
        var code = ERROR_CODES.indexOf(err.code) >= 0 ? err.code : 'INTERNAL';
        envelope = { ok: false, error: { code: code, message: String(err.message || err) } };
        if (code === 'INTERNAL') console.warn('[mock] ' + name + ' failed', err);
      }
      if (onSuccess) onSuccess(JSON.stringify(envelope), userObject);
    }, OPTS.delayMs || 0);
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
      getLocation: function (cb) { setTimeout(function () { cb({ hash: '', parameter: {}, parameters: {} }); }, 0); }
    },
    host: { close: function () {}, setHeight: function () {}, setWidth: function () {} }
  };
  // Test hook: simulate the browser back button (fires the history change handler).
  window.__mock.popState = function (state) {
    if (changeHandler) changeHandler({ state: state, location: { hash: '', parameter: {}, parameters: {} } });
  };
}

/**
 * @param {{empty?:boolean, configured?:boolean, delayMs?:number}} [options]
 * @returns {string} browser JavaScript (no surrounding <script> tag)
 */
function buildMockScript({ empty = false, configured = true, delayMs = 0 } = {}) {
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
  return '(' + mockMain.toString() + ')(' + json(fixtures) + ', ' + json({ empty, configured, delayMs }) + ');';
}

module.exports = { buildMockScript };
