// Core: pure domain logic shared by the Apps Script server and the browser.
// coreScript() sends CoreFactory_.toString() to the browser, so it must stay self-contained (no outside
// references), use ES2019 syntax only, and never contain a closing script tag.
// Functions never throw on null, undefined or blank input unless stated.
function CoreFactory_() {
  'use strict';

  var THRESHOLD = 80;
  // Set from the Script Properties on every api_* call on the server, from api_bootstrap in the client.
  var threshold_ = THRESHOLD;
  var KEY_POSTE = 'Nom du poste';
  var KEY_APP = 'Nom du logiciel / service';
  var GENERIC_POSTE_NAME = 'Poste générique Decathlon';
  var GENERIC_POSTE_COMMENT =
    'Poste générique regroupant les applications non liées à un poste suivi individuellement.';
  var RISK_ORDER = ['Critique', 'Élevé', 'Moyen', 'Faible'];
  var RISK_COLORS = { 'Critique': '#e74c3c', 'Élevé': '#e67e22', 'Moyen': '#f39c12', 'Faible': '#2ecc71' };
  var COLOR_OK = '#2ecc71';
  var COLOR_KO = '#e74c3c';
  var COLOR_THRESHOLD = '#2c3e50';
  var APP_REQUIRED_FIELDS = ['Éditeur', 'Type', 'Équipe', 'Installé sur poste', 'Niveau de risque',
    'Données sensibles exposées'];
  var APP_CUSTOM_FIELDS = ['Galink', 'IDP'];
  var YES_NO_COLS = ['Galink', 'IDP', 'Contrat', 'SIP', 'IT Decathlon', 'EDR Decathlon', 'Réseau Decathlon',
    'Enrolée'];
  var POSTE_DIFF_COLS = ['Score conformité', 'IT Decathlon', 'EDR Decathlon', 'Chiffrement disque',
    'Type de compte', 'Réseau Decathlon', 'Action corrective', 'Statut', 'Niveau de risque'];
  var POSTE_TEMPLATE_KEYS = ['N° Visite', 'Date visite', 'Prochaine revue', 'Équipe', 'Bâtiment / Labo',
    'Responsable', 'Nom du poste', "Date d'achat", 'Criticité équipement', 'IT Decathlon', 'OS', 'Version OS',
    'EDR Decathlon', 'Chiffrement disque', 'Type de compte', 'Réseau Decathlon', 'Score conformité',
    'Niveau de risque', 'Action corrective', 'Responsable action', 'Deadline', 'Statut',
    'Application', 'Commentaires', 'Enrolée'];
  var COLUMN_REF_ALIASES = { 'Bâtiment / Labo': 'Bâtiment' };
  var ACTION_STATUSES = ['À faire', 'En cours', 'Terminé', 'Abandonné'];
  var ACTION_PRIORITIES = ['Haute', 'Moyenne', 'Basse'];
  var SOURCE_TABS = { postes: 'Suivi des postes', applications: 'Suivi des applications',
    referentiel: 'Référentiel' };
  var ERROR_CODES = ['NOT_CONFIGURED', 'MONTH_EXISTS', 'NOT_FOUND', 'BUSY', 'VALIDATION', 'SOURCE_ERROR', 'FORBIDDEN',
    'INTERNAL'];
  var FORM_REQUIRED = { postes: [KEY_POSTE, 'Équipe'], applications: [KEY_APP] };
  var FORM_DATE_HINTS = ['Date visite', 'Prochaine revue', "Date d'achat", 'Deadline', 'Date'];
  // A Sheets cell holds at most 50,000 characters, and each stored record is a single JSON cell.
  var LIMITS = {
    cellChars: 5000,         // imported values are truncated, admin text is refused
    headerChars: 200,
    sourceColumns: 500,
    sourceRecords: 5000,
    sourceRecordsWarn: 4000,
    refCategories: 100,
    refValues: 500,          // extra values are dropped with a warning
    recordJsonChars: 45000
  };

  var F_EQUIPE = 'Équipe';
  var F_BATIMENT = 'Bâtiment / Labo';
  var F_SCORE = 'Score conformité';
  var F_RISK = 'Niveau de risque';
  var F_ACTION = 'Action corrective';
  var F_ACTION_OWNER = 'Responsable action';
  var F_INSTALLED_ON = 'Installé sur poste';

  // NBSP and narrow NBSP, both found in Google Sheets values.
  var NBSP_RE = /[  ]/g;

  var hasOwn = Object.prototype.hasOwnProperty;

  function freeze_(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.keys(v).forEach(function (k) { freeze_(v[k]); });
      Object.freeze(v);
    }
    return v;
  }

  // defineProperty so that keys such as "__proto__" from sheet headers stay plain data.
  function setOwn_(obj, key, value) {
    Object.defineProperty(obj, key, { value: value, writable: true, enumerable: true, configurable: true });
    return obj;
  }

  function getOwn_(obj, key) {
    return obj && hasOwn.call(obj, key) ? obj[key] : undefined;
  }

  function copy_(rec) {
    var out = {};
    if (rec && typeof rec === 'object') {
      Object.keys(rec).forEach(function (k) { setOwn_(out, k, rec[k]); });
    }
    return out;
  }

  // instanceof Date fails across realms (vm contexts, iframes).
  function isDate_(v) {
    return Object.prototype.toString.call(v) === '[object Date]';
  }

  function isValidDate_(v) {
    return isDate_(v) && !isNaN(v.getTime());
  }

  function nfc_(s) {
    return typeof s.normalize === 'function' ? s.normalize('NFC') : s;
  }

  function pad2_(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function toArray_(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) return [];
    return [v];
  }

  // Codepoint order, deterministic everywhere and the same as Python's sorted().
  function cmp_(a, b) {
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  // Removes floating-point noise such as 30.400000000000002.
  function round10_(n) {
    return Math.round(n * 1e10) / 1e10;
  }

  function cleanLabel_(v) {
    return nfc_(str(v)).replace(NBSP_RE, ' ').trim();
  }

  function normKey(s) {
    var v = (s === null || s === undefined || (typeof s === 'number' && isNaN(s))) ? '' : String(s);
    return nfc_(v).replace(NBSP_RE, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function isBlank(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'number') return isNaN(v);
    if (typeof v === 'string') return v.trim() === '';
    return false;
  }

  function str(v) {
    return isBlank(v) ? '' : String(v).trim();
  }

  var NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

  /** Score as 0–100, or null. Values in [0, 1] without a '%' are fractions: '0,5' gives 50, '1%' gives 1. */
  function parseScore(v) {
    if (isBlank(v)) return null;
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      return round10_(v >= 0 && v <= 1 ? v * 100 : v);
    }
    if (typeof v !== 'string') return null;
    var hasPct = v.indexOf('%') >= 0;
    var cleaned = v.replace(/%/g, '').replace(NBSP_RE, '').replace(/\s+/g, '').replace(',', '.');
    if (!NUMBER_RE.test(cleaned)) return null;
    var n = Number(cleaned);
    if (!isFinite(n)) return null;
    if (!hasPct && n >= 0 && n <= 1) n = n * 100;
    return round10_(n);
  }

  /** `code` is one of ERROR_CODES; `field` names the form field a VALIDATION error is about. */
  function makeError(code, message, field) {
    var err = new Error(message === null || message === undefined ? String(code) : String(message));
    err.code = code;
    if (typeof field === 'string' && field !== '') err.field = field;
    return err;
  }

  function validateMonth(m) {
    return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  }

  function currentMonth(date) {
    var d = (date === null || date === undefined) ? new Date() : date;
    if (!isValidDate_(d)) return '';
    return d.getFullYear() + '-' + pad2_(d.getMonth() + 1);
  }

  function fmtDDMMYYYY(date) {
    if (!isValidDate_(date)) return '';
    return pad2_(date.getDate()) + '/' + pad2_(date.getMonth() + 1) + '/' + date.getFullYear();
  }

  function frToIso(s) {
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str(s));
    if (!m) return '';
    var d = Number(m[1]);
    var mo = Number(m[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
    return m[3] + '-' + pad2_(mo) + '-' + pad2_(d);
  }

  function isoToFr(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return '';
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
    return m[3] + '/' + m[2] + '/' + m[1];
  }

  function extractSpreadsheetId(urlOrId) {
    var s = str(urlOrId);
    if (!s) return null;
    // Multi-account URLs look like /spreadsheets/u/1/d/<ID>/edit.
    var m = /\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(s);
    if (m) return m[1].length >= 20 ? m[1] : null;
    return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
  }

  // Prevents formula injection in sheets and CSV exports (OWASP CSV injection list).
  function escapeFormula(v) {
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return "'" + v;
    return v;
  }

  // Source sheet parsing

  function findHeaderRow(rows, anchors, maxScan) {
    if (!Array.isArray(rows)) return -1;
    var limit = (typeof maxScan === 'number' && maxScan > 0) ? maxScan : 15;
    var keys = toArray_(anchors).map(normKey).filter(function (k) { return k !== ''; });
    if (!keys.length) return -1;
    var n = Math.min(rows.length, limit);
    for (var i = 0; i < n; i++) {
      var row = rows[i];
      if (!Array.isArray(row)) continue;
      for (var j = 0; j < row.length; j++) {
        if (keys.indexOf(normKey(row[j])) >= 0) return i;
      }
    }
    return -1;
  }

  // Warnings are stored in one ImportLog cell, so they name few items and shorten each.
  var WARN_DETAILS = 5;
  var WARN_NAME_CHARS = 60;

  function quote_(s) {
    var v = String(s);
    return '« ' + (v.length > WARN_NAME_CHARS ? v.slice(0, WARN_NAME_CHARS) + '…' : v) + ' »';
  }

  function quoteList_(names) {
    var shown = names.slice(0, WARN_DETAILS).map(quote_).join(', ');
    return names.length > WARN_DETAILS ? shown + ' et ' + (names.length - WARN_DETAILS) + ' autre(s)' : shown;
  }

  function checkWidth_(row, where) {
    var n = 0;
    for (var c = 0; c < row.length; c++) if (cleanLabel_(row[c])) n++;
    if (n > LIMITS.sourceColumns) {
      throw makeError('SOURCE_ERROR', where + ' : ' + n + ' colonnes ont un en-tête, au plus ' + LIMITS.sourceColumns +
        ' sont acceptées. Supprimez les colonnes inutiles du Google Sheet source.');
    }
  }

  // In a comma-separated list column the cut falls after the last whole item, so no half poste name is kept.
  function cutValue_(value, isList) {
    var max = LIMITS.cellChars;
    var cut = value.slice(0, max);
    if (!isList) return cut;
    var at = value.charAt(max) === ',' ? max : cut.lastIndexOf(',');
    return at > 0 ? cut.slice(0, at).replace(/\s+$/, '') : cut;
  }

  /**
   * opts = {display, raw?, anchors?, keyField?, fmtDate?, tab?}. Throws SOURCE_ERROR past the LIMITS.
   * Headers starting with '_' are reserved for the app and ignored; truncations add warnings.
   */
  function rowsToRecords(opts) {
    var o = opts || {};
    var display = Array.isArray(o.display) ? o.display : (Array.isArray(o.raw) ? o.raw : []);
    var raw = Array.isArray(o.raw) ? o.raw : null;
    var keyField = str(o.keyField);
    var anchors = toArray_(o.anchors).length ? toArray_(o.anchors) : (keyField ? [keyField] : []);
    var fmtDate = typeof o.fmtDate === 'function' ? o.fmtDate : fmtDDMMYYYY;
    var where = str(o.tab) ? 'Onglet « ' + str(o.tab) + ' »' : 'Ligne d’en-tête';

    var headerIdx = findHeaderRow(display, anchors);
    if (headerIdx < 0) {
      throw makeError('SOURCE_ERROR', 'Ligne d’en-tête introuvable (colonne attendue : « ' +
        toArray_(anchors).map(str).join(' », « ') + ' »).');
    }

    // cols[i] is the grid column of headers[i], since blank and reserved headers are dropped.
    var headerRow = display[headerIdx] || [];
    checkWidth_(headerRow, where);
    var keyNorm = normKey(keyField);
    var headers = [];
    var cols = [];
    var keyHeader = null;
    var taken = Object.create(null);
    var nextSuffix = Object.create(null); // avoids rescanning " (2)", " (3)"… for each duplicate
    var reserved = [];
    var longHeaders = [];
    for (var c = 0; c < headerRow.length; c++) {
      var h = cleanLabel_(headerRow[c]);
      if (!h) continue;
      if (h.charAt(0) === '_') {
        reserved.push(h);
        continue;
      }
      if (h.length > LIMITS.headerChars) {
        h = h.slice(0, LIMITS.headerChars);
        longHeaders.push(h);
      }
      // The key column takes the keyField spelling so that record[keyField] always works.
      if (keyField && keyHeader === null && normKey(h) === keyNorm) {
        h = keyField;
        keyHeader = h;
      }
      if (taken[h] === true) {
        var k = nextSuffix[h] || 2;
        while (taken[h + ' (' + k + ')'] === true) k++;
        nextSuffix[h] = k + 1;
        h = h + ' (' + k + ')';
      }
      taken[h] = true;
      headers.push(h);
      cols.push(c);
    }
    if (keyField && keyHeader === null) {
      throw makeError('SOURCE_ERROR', 'Colonne « ' + keyField + ' » introuvable.');
    }

    var records = [];
    var rows = [];
    var missingKey = 0;
    var cut = [];
    var installedNorm = normKey(F_INSTALLED_ON);
    var isList = headers.map(function (name) { return normKey(name) === installedNorm; });
    for (var r = headerIdx + 1; r < display.length; r++) {
      var dRow = Array.isArray(display[r]) ? display[r] : [];
      var rRow = raw && Array.isArray(raw[r]) ? raw[r] : [];
      var rec = {};
      var allNull = true;
      var cutCols = [];
      for (var i = 0; i < headers.length; i++) {
        var ci = cols[i];
        var rawCell = rRow[ci];
        var value = isValidDate_(rawCell) ? str(fmtDate(rawCell)) : str(dRow[ci]);
        if (value === '') {
          value = null;
        } else {
          allNull = false;
          if (value.length > LIMITS.cellChars) {
            value = cutValue_(value, isList[i]);
            cutCols.push(headers[i]);
          }
        }
        setOwn_(rec, headers[i], value);
      }
      if (allNull) continue;
      if (keyField && rec[keyHeader] === null) {
        missingKey++;
        continue;
      }
      if (records.length >= LIMITS.sourceRecords) {
        throw makeError('SOURCE_ERROR', where + ' : plus de ' + LIMITS.sourceRecords + ' lignes à importer, au plus ' +
          LIMITS.sourceRecords + ' sont acceptées.');
      }
      for (var j = 0; j < cutCols.length; j++) {
        cut.push({ name: keyField ? rec[keyHeader] : 'ligne ' + (r + 1), column: cutCols[j] });
      }
      records.push(rec);
      rows.push(r);
    }

    var warnings = [];
    if (records.length >= LIMITS.sourceRecordsWarn) {
      warnings.push(where + ' : ' + records.length + ' lignes importées, la limite est de ' + LIMITS.sourceRecords +
        ' : au-delà, la synchronisation sera refusée.');
    }
    if (missingKey > 0) {
      warnings.push(missingKey + ' ligne(s) sans « ' + keyField + ' » ignorée(s)');
    }
    if (reserved.length) {
      warnings.push((reserved.length > 1 ? 'Colonnes ' : 'Colonne ') + quoteList_(reserved) +
        (reserved.length > 1 ? ' ignorées' : ' ignorée') +
        ' : les noms commençant par « _ » sont réservés à l’application.');
    }
    if (longHeaders.length) {
      warnings.push('En-tête(s) de colonne tronqué(s) à ' + LIMITS.headerChars + ' caractères : ' +
        quoteList_(longHeaders) + '.');
    }
    cut.slice(0, WARN_DETAILS).forEach(function (t) {
      warnings.push(quote_(t.name) + ', colonne ' + quote_(t.column) + ' : valeur tronquée à ' + LIMITS.cellChars +
        ' caractères.');
    });
    if (cut.length > WARN_DETAILS) {
      warnings.push((cut.length - WARN_DETAILS) + ' autre(s) valeur(s) tronquée(s) à ' + LIMITS.cellChars + ' caractères.');
    }
    // rows and columns are 0-based grid indexes of records and headers, used by the write-back.
    return { headers: headers, records: records, warnings: warnings, headerRow: headerIdx, rows: rows, columns: cols };
  }

  /**
   * The Référentiel tab is transposed: the first non-empty row holds category names, each column its values.
   * Pushes onto the optional `warnings` array when values are dropped; throws SOURCE_ERROR past the LIMITS.
   */
  function parseReferentiel(display, warnings) {
    var out = {};
    if (!Array.isArray(display)) return out;
    var h = -1;
    for (var i = 0; i < display.length; i++) {
      var row = display[i];
      if (Array.isArray(row) && row.some(function (v) { return !isBlank(v); })) { h = i; break; }
    }
    if (h < 0) return out;
    var header = display[h];
    var where = 'Onglet « ' + SOURCE_TABS.referentiel + ' »';
    checkWidth_(header, where);
    var seen = {};
    var full = Object.create(null);
    var cats = 0;
    for (var c = 0; c < header.length; c++) {
      var cat = cleanLabel_(header[c]);
      if (!cat) continue;
      if (cat.length > LIMITS.headerChars) cat = cat.slice(0, LIMITS.headerChars);
      var values = getOwn_(out, cat);
      if (!values) {
        if (++cats > LIMITS.refCategories) {
          throw makeError('SOURCE_ERROR', where + ' : plus de ' + LIMITS.refCategories + ' catégories, au plus ' +
            LIMITS.refCategories + ' sont acceptées.');
        }
        values = [];
        setOwn_(out, cat, values);
        setOwn_(seen, cat, Object.create(null));
      }
      var known = getOwn_(seen, cat);
      for (var r = h + 1; r < display.length; r++) {
        var v = str(Array.isArray(display[r]) ? display[r][c] : '');
        if (v === '') continue;
        if (v.length > LIMITS.cellChars) v = v.slice(0, LIMITS.cellChars);
        if (known[v] === true) continue;
        if (values.length >= LIMITS.refValues) {
          if (full[cat] !== true) {
            full[cat] = true;
            if (Array.isArray(warnings)) {
              warnings.push(where + ' : la catégorie ' + quote_(cat) + ' a plus de ' + LIMITS.refValues +
                ' valeurs, seules les ' + LIMITS.refValues + ' premières sont gardées.');
            }
          }
          continue;
        }
        known[v] = true;
        values.push(v);
      }
    }
    return out;
  }

  // Scoring and KPIs

  function scoreApplication(rec) {
    var r = rec || {};
    var criteria = {
      contrat: str(r['Contrat']) === 'Oui',
      sip: str(r['SIP']) === 'Oui',
      idp: str(r['IDP']) === 'Oui',
      galink: str(r['Galink']) === 'Oui',
      champs: APP_REQUIRED_FIELDS.every(function (f) { return !isBlank(r[f]); })
    };
    var score = 0;
    Object.keys(criteria).forEach(function (k) { if (criteria[k]) score += 20; });
    return { score: score, criteria: criteria };
  }

  function enrichPostes(list) {
    return toArray_(list).map(function (rec) {
      var out = copy_(rec);
      var score = parseScore(out[F_SCORE]);
      out._score = score;
      out._conforme = score !== null && score >= threshold_;
      return out;
    });
  }

  function enrichApplications(list) {
    return toArray_(list).map(function (rec) {
      var out = copy_(rec);
      var s = scoreApplication(out);
      out._score = s.score;
      out._conforme = s.score >= threshold_;
      out._criteria = s.criteria;
      return out;
    });
  }

  function uniqueSorted(list, field) {
    var seen = {};
    var out = [];
    toArray_(list).forEach(function (rec) {
      var v = str(rec ? rec[field] : null);
      if (v !== '' && !hasOwn.call(seen, v)) { setOwn_(seen, v, true); out.push(v); }
    });
    return out.sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  }

  // The Bâtiment filter applies to postes only.
  function filterData(data, filters) {
    var d = data || {};
    var f = filters || {};
    var equipes = toArray_(f.equipes).map(str);
    var batiments = toArray_(f.batiments).map(str);
    function keep(rec, useBatiment) {
      if (!rec) return false;
      if (equipes.length && equipes.indexOf(str(rec[F_EQUIPE])) < 0) return false;
      if (useBatiment && batiments.length && batiments.indexOf(str(rec[F_BATIMENT])) < 0) return false;
      return true;
    }
    return {
      postes: toArray_(d.postes).filter(function (r) { return keep(r, true); }),
      applications: toArray_(d.applications).filter(function (r) { return keep(r, false); })
    };
  }

  function countNon_(list, field) {
    return list.filter(function (r) { return r && str(r[field]) === 'Non'; }).length;
  }

  /** Expects enriched records (`_conforme`). */
  function computeKpis(postes, apps) {
    var p = toArray_(postes);
    var a = toArray_(apps);
    var pOk = p.filter(function (r) { return r && r._conforme === true; }).length;
    var aOk = a.filter(function (r) { return r && r._conforme === true; }).length;
    return {
      total_postes: p.length,
      postes_conformes: pOk,
      postes_non_conformes: p.length - pOk,
      taux_postes: p.length ? (pOk / p.length) * 100 : 0,
      total_apps: a.length,
      apps_conformes: aOk,
      apps_non_conformes: a.length - aOk,
      taux_apps: a.length ? (aOk / a.length) * 100 : 0,
      postes_sans_edr: countNon_(p, 'EDR Decathlon'),
      postes_non_it: countNon_(p, 'IT Decathlon'),
      postes_hors_reseau: countNon_(p, 'Réseau Decathlon'),
      apps_sans_sip: countNon_(a, 'SIP'),
      apps_sans_contrat: countNon_(a, 'Contrat'),
      apps_sans_galink: countNon_(a, 'Galink'),
      apps_sans_idp: countNon_(a, 'IDP')
    };
  }

  function riskCounts(list) {
    var out = {};
    RISK_ORDER.forEach(function (k) { out[k] = 0; });
    toArray_(list).forEach(function (rec) {
      var v = str(rec ? rec[F_RISK] : null);
      if (hasOwn.call(out, v)) out[v]++;
    });
    return out;
  }

  // Fixed range 0–100 with 100 in the last bin. Non-numbers and values outside it are ignored.
  function histogramBins(scores, nbins) {
    var n = (typeof nbins === 'number' && isFinite(nbins) && nbins >= 1) ? Math.floor(nbins) : 10;
    var bins = [];
    for (var i = 0; i < n; i++) {
      bins.push({ x0: round10_((i * 100) / n), x1: round10_(((i + 1) * 100) / n), count: 0 });
    }
    toArray_(scores).forEach(function (s) {
      if (typeof s !== 'number' || !isFinite(s) || s < 0 || s > 100) return;
      var idx = Math.min(n - 1, Math.floor((s * n) / 100));
      bins[idx].count++;
    });
    return bins;
  }

  function buildPosteAppsRelation(apps) {
    var relations = [];
    var byPoste = {};
    var byApp = {};
    toArray_(apps).forEach(function (rec) {
      if (!rec) return;
      var application = str(rec[KEY_APP]);
      if (!application) return;
      var equipe = str(rec[F_EQUIPE]);
      var score = (typeof rec._score === 'number' && !isNaN(rec._score)) ? rec._score : scoreApplication(rec).score;
      var postes = str(rec[F_INSTALLED_ON]).split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s, i, arr) { return s !== '' && arr.indexOf(s) === i; });
      postes.forEach(function (poste) {
        relations.push({ poste: poste, application: application, equipe: equipe, score: score });
        var pl = getOwn_(byPoste, poste);
        if (!pl) { pl = []; setOwn_(byPoste, poste, pl); }
        pl.push({ application: application, equipe: equipe, score: score });
        var al = getOwn_(byApp, application);
        if (!al) { al = []; setOwn_(byApp, application, al); }
        if (al.indexOf(poste) < 0) al.push(poste);
      });
    });
    return { relations: relations, byPoste: byPoste, byApp: byApp };
  }

  // Month-to-month changes

  function indexBy_(list, keyField) {
    var map = {};
    var keys = [];
    toArray_(list).forEach(function (rec) {
      var k = str(rec ? rec[keyField] : null);
      if (k === '' || hasOwn.call(map, k)) return;
      setOwn_(map, k, rec);
      keys.push(k);
    });
    return { map: map, keys: keys };
  }

  function diffBase_(oldList, newList, keyField) {
    var o = indexBy_(oldList, keyField);
    var n = indexBy_(newList, keyField);
    var removedKeys = o.keys.filter(function (k) { return !hasOwn.call(n.map, k); }).sort(cmp_);
    var addedKeys = n.keys.filter(function (k) { return !hasOwn.call(o.map, k); }).sort(cmp_);
    var common = o.keys.filter(function (k) { return hasOwn.call(n.map, k); }).sort(cmp_);
    var resolved = [];
    common.forEach(function (k) {
      var oldRec = o.map[k];
      var newRec = n.map[k];
      if (!isBlank(oldRec[F_ACTION]) && isBlank(newRec[F_ACTION])) {
        resolved.push({
          name: k,
          equipe: str(oldRec[F_EQUIPE]),
          action: str(oldRec[F_ACTION]),
          responsable: str(oldRec[F_ACTION_OWNER])
        });
      }
    });
    return {
      removed: removedKeys.map(function (k) { return o.map[k]; }),
      added: addedKeys.map(function (k) { return n.map[k]; }),
      common: common,
      oldMap: o.map,
      newMap: n.map,
      resolved_actions: resolved
    };
  }

  function diffPostes(oldList, newList) {
    var b = diffBase_(oldList, newList, KEY_POSTE);
    var changes = [];
    b.common.forEach(function (k) {
      var oldRec = b.oldMap[k];
      var newRec = b.newMap[k];
      var diffs = {};
      var any = false;
      POSTE_DIFF_COLS.forEach(function (col) {
        var ov = str(oldRec[col]);
        var nv = str(newRec[col]);
        if (ov !== nv) { diffs[col] = { old: ov, 'new': nv }; any = true; }
      });
      if (any) {
        changes.push({ name: k, equipe: str(newRec[F_EQUIPE]) || str(oldRec[F_EQUIPE]), diffs: diffs });
      }
    });
    return { removed: b.removed, added: b.added, changes: changes, resolved_actions: b.resolved_actions };
  }

  function diffApplications(oldList, newList) {
    var b = diffBase_(oldList, newList, KEY_APP);
    return { removed: b.removed, added: b.added, resolved_actions: b.resolved_actions };
  }

  // Records and forms

  function makeGenericPoste(templateKeys, existingNames) {
    var target = normKey(GENERIC_POSTE_NAME);
    var exists = toArray_(existingNames).some(function (n) { return normKey(n) === target; });
    if (exists) return null;
    var keys = toArray_(templateKeys).map(str).filter(function (k) { return k !== ''; });
    if (!keys.length) keys = POSTE_TEMPLATE_KEYS;
    var rec = {};
    keys.forEach(function (k) { setOwn_(rec, k, null); });
    rec[KEY_POSTE] = GENERIC_POSTE_NAME;
    rec['Commentaires'] = GENERIC_POSTE_COMMENT;
    return rec;
  }

  /** Carries app-only fields (Galink, IDP) over from the previous snapshot. Missing fields are set to null. */
  function mergeCarryOver(newRecs, prevRecs, keyField, fields) {
    var prev = {};
    toArray_(prevRecs).forEach(function (rec) {
      var k = normKey(rec ? rec[keyField] : null);
      if (k !== '' && !hasOwn.call(prev, k)) setOwn_(prev, k, rec);
    });
    var fieldList = toArray_(fields);
    var carried = 0;
    var records = toArray_(newRecs).map(function (rec) {
      var out = copy_(rec);
      var k = normKey(out[keyField]);
      var p = k !== '' && hasOwn.call(prev, k) ? prev[k] : null;
      fieldList.forEach(function (f) {
        if (!isBlank(getOwn_(out, f))) return;
        var pv = p ? getOwn_(p, f) : undefined;
        if (!isBlank(pv)) {
          setOwn_(out, f, pv);
          carried++;
        } else {
          setOwn_(out, f, null);
        }
      });
      return out;
    });
    return { records: records, carried: carried };
  }

  /** Référentiel values, else Oui/Non, else null for free text. */
  function optionsForColumn(col, referentiel) {
    var c = str(col);
    var target = normKey(hasOwn.call(COLUMN_REF_ALIASES, c) ? COLUMN_REF_ALIASES[c] : c);
    if (target !== '' && referentiel && typeof referentiel === 'object') {
      var cats = Object.keys(referentiel);
      for (var i = 0; i < cats.length; i++) {
        if (normKey(cats[i]) === target) return toArray_(referentiel[cats[i]]).slice();
      }
    }
    if (YES_NO_COLS.indexOf(c) >= 0) return ['Oui', 'Non'];
    return null;
  }

  var MAX_LISTED_OPTIONS_ = 8;

  function formColumn_(name, kind, options, strict, required) {
    return { name: name, kind: kind, options: options, strict: strict, computed: false, required: required };
  }

  // Galink and IDP live in the snapshot only, not in the source sheet.
  function appOnlyColumn_(name) {
    var col = formColumn_(name, 'select', ['Oui', 'Non'], true, false);
    col.appOnly = true;
    return col;
  }

  function isDateHint_(name) {
    var k = normKey(name);
    return FORM_DATE_HINTS.some(function (h) { return normKey(h) === k; });
  }

  // Used when the source sheet is not at hand (past months, unreadable source), so nothing is computed.
  function snapshotFormColumns(entity, headers, referentiel) {
    var ent = entity === 'applications' ? 'applications' : 'postes';
    var required = FORM_REQUIRED[ent];
    var names = [];
    toArray_(headers).forEach(function (h) {
      var n = cleanLabel_(h);
      if (n !== '' && names.indexOf(n) < 0) names.push(n);
    });
    required.slice().reverse().forEach(function (r) {
      if (!names.some(function (n) { return normKey(n) === normKey(r); })) names.unshift(r);
    });
    var cols = names.map(function (n) {
      var options = optionsForColumn(n, referentiel);
      var kind = isDateHint_(n) ? 'date' : (options ? 'select' : 'text');
      var strict = kind === 'select' && YES_NO_COLS.indexOf(n) >= 0;
      var req = required.some(function (r) { return normKey(r) === normKey(n); });
      return formColumn_(n, kind, kind === 'select' ? options : null, strict, req);
    });
    if (ent === 'applications') {
      APP_CUSTOM_FIELDS.forEach(function (f) {
        if (names.indexOf(f) < 0) cols.push(appOnlyColumn_(f));
      });
    }
    return cols;
  }

  // Accepts ISO or DD/MM/YYYY and rejects days that do not exist, such as 31/02.
  function formDate_(s) {
    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    var fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    var y, m, d;
    if (iso) { y = Number(iso[1]); m = Number(iso[2]); d = Number(iso[3]); }
    else if (fr) { y = Number(fr[3]); m = Number(fr[2]); d = Number(fr[1]); }
    else return '';
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
    return pad2_(d) + '/' + pad2_(m) + '/' + y;
  }

  function quoteFr_(v) {
    return '« ' + v + ' »';
  }

  function refused_(field, message) {
    return { ok: false, field: field, message: message };
  }

  /** Returns {ok: true, record} with normalised values, or {ok: false, field, message} for the first problem. */
  function checkFormRecord(columns, record) {
    var cols = toArray_(columns).filter(function (c) { return c && typeof c === 'object' && str(c.name) !== ''; });
    var rec = record && typeof record === 'object' ? record : {};
    var values = {};
    var keys = Object.keys(rec);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var col = null;
      for (var j = 0; j < cols.length && !col; j++) if (cols[j].name === k) col = cols[j];
      for (j = 0; j < cols.length && !col; j++) if (normKey(cols[j].name) === normKey(k)) col = cols[j];
      if (!col) {
        return refused_(k, 'La colonne ' + quoteFr_(k) + ' n’existe pas dans le Google Sheet source : rouvrez le formulaire.');
      }
      var v = rec[k];
      if (v !== null && v !== undefined && typeof v === 'object') return refused_(col.name, 'Valeur invalide.');
      if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
      var s = str(v);
      if (s !== '' || !hasOwn.call(values, col.name)) setOwn_(values, col.name, s === '' ? null : s);
    }
    var out = {};
    for (var c = 0; c < cols.length; c++) {
      var column = cols[c];
      var name = column.name;
      var given = hasOwn.call(values, name);
      var val = given ? values[name] : null;
      if (column.computed && val !== null) {
        return refused_(name, quoteFr_(name) + ' est calculée par une formule dans le Google Sheet source.');
      }
      if (val === null) {
        if (column.required && !column.computed) return refused_(name, 'Ce champ est obligatoire.');
        if (given) setOwn_(out, name, null);
        continue;
      }
      if (column.kind === 'date') {
        var d = formDate_(val);
        if (!d) return refused_(name, 'Date invalide : ' + quoteFr_(val) + ' (format attendu JJ/MM/AAAA).');
        val = d;
      }
      var options = Array.isArray(column.options) ? column.options.map(str) : null;
      if (column.strict && options && (column.kind === 'select' || column.kind === 'checkbox')) {
        var parts = options.indexOf(val) >= 0 ? [val] : val.split(',').map(str);
        var ok = parts.every(function (p) { return p !== '' && options.indexOf(p) >= 0; });
        if (!ok) {
          return refused_(name, 'Valeur hors liste : ' + quoteFr_(val) + (options.length && options.length <= MAX_LISTED_OPTIONS_ ?
            ' (attendu : ' + options.join(', ') + ').' : ' : choisissez une valeur de la liste.'));
        }
      }
      setOwn_(out, name, val);
    }
    return { ok: true, record: out };
  }

  function sortMonths(months) {
    var out = [];
    toArray_(months).forEach(function (m) {
      if (validateMonth(m) && out.indexOf(m) < 0) out.push(m);
    });
    return out.sort(cmp_);
  }

  var EMAIL_RE_ = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

  function isEmail(v) {
    return typeof v === 'string' && v.length <= 254 && EMAIL_RE_.test(v);
  }

  /**
   * Accepts addresses pasted as a column, a separated list or mail headers (« Léa Martin <lea@x.com> »).
   * Returns {emails, invalid}. Words without '@' are ignored.
   */
  function parseEmailList(text) {
    var out = { emails: [], invalid: [] };
    if (typeof text !== 'string') return out;
    var seen = {};
    text.split(/[\s,;]+/).forEach(function (raw) {
      var t = raw.replace(/^mailto:/i, '').replace(/^[<("'\[]+|[>)"'\].]+$/g, '').replace(/^mailto:/i, '');
      if (t.indexOf('@') < 0) return;
      var e = t.toLowerCase();
      if (!isEmail(e)) {
        if (out.invalid.indexOf(raw) < 0) out.invalid.push(raw);
        return;
      }
      if (seen[e]) return;
      seen[e] = true;
      out.emails.push(e);
    });
    return out;
  }

  function threshold() { return threshold_; }

  /** Integer 1–100, or null. Accepts numeric strings. */
  function validateThreshold(v) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
    return isFinite(n) && Math.floor(n) === n && n >= 1 && n <= 100 ? n : null;
  }

  /** Invalid values reset it to THRESHOLD. */
  function setThreshold(v) {
    var n = validateThreshold(v);
    threshold_ = n === null ? THRESHOLD : n;
    return threshold_;
  }

  function previousMonth(months, month) {
    if (!validateMonth(month)) return null;
    var before = sortMonths(months).filter(function (m) { return m < month; });
    return before.length ? before[before.length - 1] : null;
  }

  // Periods

  var PERIOD_PRESETS = ['month', 'last3', 'last6', 'year', 'all'];

  function addMonths(month, n) {
    if (!validateMonth(month)) return '';
    var y = Number(month.slice(0, 4));
    var m = Number(month.slice(5, 7)) - 1 + (Math.round(Number(n)) || 0);
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return y + '-' + (m < 9 ? '0' : '') + (m + 1);
  }

  function monthsInRange(months, from, to) {
    var a = validateMonth(from) ? from : '';
    var b = validateMonth(to) ? to : '';
    if (!a && !b) return [];
    if (!a) a = b;
    if (!b) b = a;
    if (a > b) { var t = a; a = b; b = t; }
    return sortMonths(months).filter(function (m) { return m >= a && m <= b; });
  }

  /** {from, to} ending at the latest month, with from snapped to the first available month in range. */
  function presetPeriod(months, preset) {
    var list = sortMonths(months);
    if (!list.length || PERIOD_PRESETS.indexOf(preset) < 0) return null;
    var to = list[list.length - 1];
    var start = preset === 'month' ? to :
      preset === 'last3' ? addMonths(to, -2) :
      preset === 'last6' ? addMonths(to, -5) :
      preset === 'year' ? to.slice(0, 4) + '-01' : list[0];
    var inside = list.filter(function (m) { return m >= start; });
    return { from: inside[0], to: to };
  }

  /**
   * Returns {byKey: {key: {status: 'new'|'up'|'down'|'same', from, to}}, added, changed, removed}.
   * Expects enriched records. A score difference under 0.05 counts as no change.
   */
  function scoreEvolution(oldList, newList, keyField) {
    var key = str(keyField);
    var old = {};
    toArray_(oldList).forEach(function (r) {
      var k = normKey(r ? r[key] : null);
      if (k !== '' && !hasOwn.call(old, k)) setOwn_(old, k, r);
    });
    var byKey = {};
    var seen = {};
    var added = 0;
    var changed = 0;
    toArray_(newList).forEach(function (r) {
      var k = normKey(r ? r[key] : null);
      if (k === '' || hasOwn.call(byKey, k)) return;
      var to = r && typeof r._score === 'number' ? r._score : null;
      if (!hasOwn.call(old, k)) {
        added++;
        setOwn_(byKey, k, { status: 'new', from: null, to: to });
        return;
      }
      setOwn_(seen, k, true);
      var o = old[k];
      var from = o && typeof o._score === 'number' ? o._score : null;
      var status = from !== null && to !== null && Math.abs(to - from) >= 0.05 ? (to > from ? 'up' : 'down') : 'same';
      if (status !== 'same') changed++;
      setOwn_(byKey, k, { status: status, from: from, to: to });
    });
    var removed = Object.keys(old).filter(function (k) { return !hasOwn.call(seen, k); }).map(function (k) { return old[k]; });
    return { byKey: byKey, added: added, changed: changed, removed: removed };
  }

  return {
    THRESHOLD: THRESHOLD,
    KEY_POSTE: KEY_POSTE,
    KEY_APP: KEY_APP,
    GENERIC_POSTE_NAME: GENERIC_POSTE_NAME,
    RISK_ORDER: freeze_(RISK_ORDER),
    RISK_COLORS: freeze_(RISK_COLORS),
    COLOR_OK: COLOR_OK,
    COLOR_KO: COLOR_KO,
    COLOR_THRESHOLD: COLOR_THRESHOLD,
    APP_REQUIRED_FIELDS: freeze_(APP_REQUIRED_FIELDS),
    APP_CUSTOM_FIELDS: freeze_(APP_CUSTOM_FIELDS),
    YES_NO_COLS: freeze_(YES_NO_COLS),
    POSTE_DIFF_COLS: freeze_(POSTE_DIFF_COLS),
    POSTE_TEMPLATE_KEYS: freeze_(POSTE_TEMPLATE_KEYS),
    COLUMN_REF_ALIASES: freeze_(COLUMN_REF_ALIASES),
    ACTION_STATUSES: freeze_(ACTION_STATUSES),
    ACTION_PRIORITIES: freeze_(ACTION_PRIORITIES),
    SOURCE_TABS: freeze_(SOURCE_TABS),
    ERROR_CODES: freeze_(ERROR_CODES),
    FORM_REQUIRED: freeze_(FORM_REQUIRED),
    FORM_DATE_HINTS: freeze_(FORM_DATE_HINTS),
    LIMITS: freeze_(LIMITS),
    normKey: normKey,
    isBlank: isBlank,
    str: str,
    parseScore: parseScore,
    makeError: makeError,
    validateMonth: validateMonth,
    currentMonth: currentMonth,
    fmtDDMMYYYY: fmtDDMMYYYY,
    frToIso: frToIso,
    isoToFr: isoToFr,
    extractSpreadsheetId: extractSpreadsheetId,
    escapeFormula: escapeFormula,
    findHeaderRow: findHeaderRow,
    rowsToRecords: rowsToRecords,
    parseReferentiel: parseReferentiel,
    scoreApplication: scoreApplication,
    enrichPostes: enrichPostes,
    enrichApplications: enrichApplications,
    uniqueSorted: uniqueSorted,
    filterData: filterData,
    computeKpis: computeKpis,
    riskCounts: riskCounts,
    histogramBins: histogramBins,
    buildPosteAppsRelation: buildPosteAppsRelation,
    diffPostes: diffPostes,
    diffApplications: diffApplications,
    makeGenericPoste: makeGenericPoste,
    mergeCarryOver: mergeCarryOver,
    optionsForColumn: optionsForColumn,
    snapshotFormColumns: snapshotFormColumns,
    checkFormRecord: checkFormRecord,
    sortMonths: sortMonths,
    previousMonth: previousMonth,
    PERIOD_PRESETS: freeze_(PERIOD_PRESETS),
    addMonths: addMonths,
    monthsInRange: monthsInRange,
    presetPeriod: presetPeriod,
    scoreEvolution: scoreEvolution,
    threshold: threshold,
    validateThreshold: validateThreshold,
    isEmail: isEmail,
    parseEmailList: parseEmailList,
    setThreshold: setThreshold
  };
}

var Core = CoreFactory_();
