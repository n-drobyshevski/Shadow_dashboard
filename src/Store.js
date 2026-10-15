/**
 * Store — repository over the app's own data spreadsheet (docs/API.md §4).
 * This is the ONLY module that writes to the data spreadsheet.
 *
 * Layout: one tab per entry of Config.SCHEMAS, row 1 = header (frozen), data from row 2, every
 * cell stored as plain text.
 *
 * Write discipline (Sheets would otherwise silently retype user data):
 *   - the exact target range gets the '@' (plain text) number format right before each setValues,
 *     so '2026-05', '15/03/2025' or '0042' are never turned into dates / numbers and
 *     '=HYPERLINK(...)' is stored as text, not evaluated;
 *   - strings are written VERBATIM (no Core.escapeFormula "'" prefix): in a plain-text cell Sheets
 *     keeps a leading apostrophe as a literal character, so a prefix would corrupt '- x', '+33…',
 *     '@user' on read. The '@' format is the one and only formula guard.
 *
 * Data spreadsheet safety: a configured DATA_SPREADSHEET_ID is never replaced automatically. An
 * open failure (often transient in Apps Script) is retried, then reported as INTERNAL; a new
 * spreadsheet is only created when no id is configured, under the script lock.
 *
 * Performance discipline (each Sheets call is a round trip):
 *   - a tab is read with ONE getDataRange().getValues();
 *   - a mutation is committed with at most ONE setValues(): commit_() diffs the new rows against
 *     the rows just read and only rewrites the smallest contiguous block that changed (plus one
 *     clearContent() when the tab shrank). No per-row API calls in loops.
 *
 * Load-order safe: the IIFE only defines functions; Config / Core / GAS services are used lazily.
 */
var Store = (function () {
  var LOCK_TIMEOUT_MS = 20000;
  var OPEN_RETRY_DELAYS_MS = [500, 1500]; // openById of the data spreadsheet: 3 attempts in total
  var PLAIN_TEXT_FORMAT = '@';
  var META_SCHEMA_VERSION_KEY = 'schema_version';

  // Per-execution caches (GAS re-evaluates the script for every execution).
  var ss_ = null;      // data Spreadsheet
  var sheets_ = {};    // tab name -> Sheet
  var lockDepth_ = 0;  // > 0 while this execution holds the script lock (re-entrant withLock)

  // ------------------------------------------------------------------------------- helpers

  function schema_(tab) {
    var schema = Config.SCHEMAS[tab];
    if (!schema) throw Core.makeError('INTERNAL', 'Onglet inconnu : ' + tab);
    return schema;
  }

  /** Key column of an entity tab (used to keep `_key` in sync when a record is edited). */
  function entityKeyField_(tab) {
    if (tab === Config.TABS.postes) return Core.KEY_POSTE;
    if (tab === Config.TABS.applications) return Core.KEY_APP;
    return null;
  }

  function checkMonth_(month) {
    if (!Core.validateMonth(month)) {
      throw Core.makeError('VALIDATION', 'Mois invalide : « ' + month + ' » (format attendu AAAA-MM).');
    }
  }

  function notFound_(id) {
    return Core.makeError('NOT_FOUND', 'Élément introuvable (id : ' + id + ').');
  }

  /** Cross-realm safe Date test. */
  function isDate_(v) {
    return Object.prototype.toString.call(v) === '[object Date]';
  }

  /** Any cell / field value -> the string stored in (or read from) the sheet. */
  function toText_(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (isDate_(v)) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, Config.TIME_ZONE, 'yyyy-MM-dd');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function rowsEqual_(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function isEmptyRow_(row) {
    for (var i = 0; i < row.length; i++) if (row[i] !== '') return false;
    return true;
  }

  function hasOwn_(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function rowToObject_(schema, row) {
    var obj = {};
    for (var j = 0; j < schema.length; j++) obj[schema[j]] = row[j];
    return obj;
  }

  function objectToRow_(schema, obj) {
    return schema.map(function (k) { return toText_(obj[k]); });
  }

  // ----------------------------------------------------------------------- sheet primitives

  /** Grows the sheet so that (rows x cols) fits: GAS throws on out-of-bounds ranges. */
  function ensureSize_(sheet, rows, cols) {
    var maxRows = sheet.getMaxRows();
    if (maxRows < rows) sheet.insertRowsAfter(maxRows, rows - maxRows);
    var maxCols = sheet.getMaxColumns();
    if (maxCols < cols) sheet.insertColumnsAfter(maxCols, cols - maxCols);
  }

  /**
   * Writes a block of string rows at startRow (1-based): '@' format on the exact range, then ONE
   * setValues of the strings VERBATIM. This is the only write path. The plain-text format is the
   * formula guard ('=…' is stored as text, not evaluated); no "'" prefix is added, because Sheets
   * keeps a leading apostrophe literally in plain-text cells and it would become part of the value.
   */
  function writeBlock_(sheet, startRow, rows) {
    if (!rows.length) return;
    var width = rows[0].length;
    ensureSize_(sheet, startRow + rows.length - 1, width);
    var range = sheet.getRange(startRow, 1, rows.length, width);
    range.setNumberFormat(PLAIN_TEXT_FORMAT);
    range.setValues(rows);
  }

  /**
   * Reads a whole tab with ONE getValues().
   * @return {{sheet, schema, raw: string[][], items: {index:number, obj:Object}[]}}
   *   raw   = every data row (row 2..last), schema width, as strings (blank rows included, so that
   *           raw[i] is sheet row i + 2);
   *   items = the non-blank rows as {header: string} objects.
   */
  function readSheet_(sheet, schema) {
    var values = sheet.getDataRange().getValues();
    var raw = [];
    var items = [];
    for (var i = 1; i < values.length; i++) {
      var src = values[i];
      var row = [];
      for (var j = 0; j < schema.length; j++) row.push(j < src.length ? toText_(src[j]) : '');
      raw.push(row);
      if (!isEmptyRow_(row)) items.push({ index: raw.length - 1, obj: rowToObject_(schema, row) });
    }
    return { sheet: sheet, schema: schema, raw: raw, items: items };
  }

  function readTable_(tab) {
    return readSheet_(sheet_(tab), schema_(tab));
  }

  /**
   * Persists `newRows` (complete list of data rows) for a table read by readSheet_, writing only the
   * smallest contiguous block that differs from what was read (ONE setValues) and clearing the
   * leftover rows when the table shrank (ONE clearContent).
   * @return {number} number of rows written
   */
  function commit_(table, newRows) {
    var old = table.raw;
    var start = 0;
    while (start < old.length && start < newRows.length && rowsEqual_(old[start], newRows[start])) start++;
    var end = newRows.length;
    if (old.length === newRows.length) {
      while (end > start && rowsEqual_(old[end - 1], newRows[end - 1])) end--;
    }
    if (end > start) writeBlock_(table.sheet, 2 + start, newRows.slice(start, end));
    if (old.length > newRows.length) {
      table.sheet.getRange(2 + newRows.length, 1, old.length - newRows.length, table.schema.length).clearContent();
    }
    table.raw = newRows;
    return end - start;
  }

  /** Appends rows after the last used row without reading the tab. */
  function appendRows_(tab, rows) {
    var sheet = sheet_(tab);
    writeBlock_(sheet, Math.max(sheet.getLastRow(), 1) + 1, rows);
  }

  /** Deletes one sheet row (1-based) — Sheets refuses to delete the last non-frozen row. */
  function deleteSheetRow_(sheet, rowNumber) {
    var maxRows = sheet.getMaxRows();
    if (maxRows <= 2) sheet.insertRowsAfter(maxRows, 1);
    sheet.deleteRow(rowNumber);
  }

  /** Replaces the rows whose first column (`_month`) equals `month`, keeping months sorted. */
  function replaceMonthRows_(table, month, freshRows) {
    var before = [];
    var after = [];
    table.items.forEach(function (it) {
      var row = table.raw[it.index];
      if (row[0] === month) return;
      (row[0] < month ? before : after).push(row);
    });
    commit_(table, before.concat(freshRows, after));
  }

  // ------------------------------------------------------------------------- spreadsheet

  function metaValue_(metaSheet, key) {
    var values = metaSheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (toText_(values[i][0]) === key) return toText_(values[i][1]);
    }
    return null;
  }

  function setMetaValue_(metaSheet, key, value) {
    var table = readSheet_(metaSheet, Config.SCHEMAS[Config.TABS.meta]);
    var rows = table.raw.slice();
    var found = false;
    table.items.forEach(function (it) {
      if (it.obj.key === key) { rows[it.index] = [key, String(value)]; found = true; }
    });
    if (!found) rows.push([key, String(value)]);
    commit_(table, rows);
  }

  function ensureHeader_(sheet, header) {
    ensureSize_(sheet, 1, header.length);
    var current = sheet.getRange(1, 1, 1, header.length).getValues()[0].map(toText_);
    if (!rowsEqual_(current, header)) writeBlock_(sheet, 1, [header.slice()]);
    if (sheet.getFrozenRows() !== 1) sheet.setFrozenRows(1);
  }

  /**
   * Makes sure every tab exists with its header. Fast path (one read of Meta, no write, no lock)
   * when all tabs exist and Meta already carries the current schema version; otherwise the repair
   * (tab creation, header and Meta writes) runs under the script lock and re-reads the tabs there.
   * @return {Object<string, Sheet>}
   */
  function ensureTabs_(ss, created) {
    var names = Object.keys(Config.SCHEMAS);
    if (!created) {
      var byName = {};
      ss.getSheets().forEach(function (sh) { byName[sh.getName()] = sh; });
      var allPresent = names.every(function (n) { return !!byName[n]; });
      if (allPresent && metaValue_(byName[Config.TABS.meta], META_SCHEMA_VERSION_KEY) === Config.SCHEMA_VERSION) {
        var fast = {};
        names.forEach(function (n) { fast[n] = byName[n]; });
        return fast;
      }
    }
    return withLock(function () { return repairTabs_(ss, created); });
  }

  /** Slow path of ensureTabs_ (caller holds the lock). */
  function repairTabs_(ss, created) {
    var names = Object.keys(Config.SCHEMAS);
    var existing = ss.getSheets();
    var byName = {};
    existing.forEach(function (sh) { byName[sh.getName()] = sh; });

    // A freshly created spreadsheet comes with one default sheet: reuse it for the first tab.
    var spare = created && existing.length && names.indexOf(existing[0].getName()) < 0 ? existing[0] : null;
    var out = {};
    names.forEach(function (name) {
      var sh = byName[name];
      if (!sh) {
        if (spare) { sh = spare.setName(name); spare = null; }
        else sh = ss.insertSheet(name);
      }
      ensureHeader_(sh, Config.SCHEMAS[name]);
      out[name] = sh;
    });
    setMetaValue_(out[Config.TABS.meta], META_SCHEMA_VERSION_KEY, Config.SCHEMA_VERSION);
    return out;
  }

  /**
   * Opens the CONFIGURED data spreadsheet, retrying transient failures with a short backoff. Never
   * replaces the id: after the last attempt it throws INTERNAL (the property is left untouched, so
   * the next execution tries the same spreadsheet again). Recovering from a spreadsheet that is
   * really gone is an explicit admin step: delete the DATA_SPREADSHEET_ID script property.
   */
  function openData_(id) {
    var lastError = null;
    for (var attempt = 0; attempt <= OPEN_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) Utilities.sleep(OPEN_RETRY_DELAYS_MS[attempt - 1]);
      try {
        return SpreadsheetApp.openById(id);
      } catch (e) {
        lastError = e;
      }
    }
    console.error('Store.ensure: cannot open data spreadsheet ' + id + ' after ' +
      (OPEN_RETRY_DELAYS_MS.length + 1) + ' attempts (' + (lastError && lastError.message) + '). ' +
      'The script property ' + Config.PROP_DATA_ID + ' is left unchanged; check access to the file, or ' +
      'delete the property to create a new data spreadsheet.');
    throw Core.makeError('INTERNAL', 'Classeur de données inaccessible, réessayez dans quelques instants. ' +
      'Si le problème persiste, vérifiez l’accès au classeur de données.');
  }

  /**
   * Opens the data spreadsheet (creating it only when no id is configured) and makes sure the
   * layout is in place. Idempotent and cached for the current execution. The creation runs under
   * the script lock and re-reads the property there, so concurrent first loads create ONE file.
   */
  function ensure() {
    if (ss_) return ss_;
    var cfg = Config.get();
    var ss = null;
    var created = false;
    if (cfg.dataId) {
      ss = openData_(cfg.dataId);
      sheets_ = ensureTabs_(ss, false);
    } else {
      withLock(function () {
        var id = Config.get().dataId; // another execution may have created it while we waited
        if (id) {
          ss = openData_(id);
        } else {
          ss = SpreadsheetApp.create(Config.DATA_SPREADSHEET_NAME);
          Config.setDataId(ss.getId());
          created = true;
        }
        sheets_ = ensureTabs_(ss, created);
      });
    }
    ss_ = ss;
    return ss;
  }

  function sheet_(tab) {
    ensure();
    var sh = sheets_[tab];
    if (!sh) throw Core.makeError('INTERNAL', 'Onglet inconnu : ' + tab);
    return sh;
  }

  /** Drops the per-execution cache (tests simulate a new execution with it). */
  function resetCache_() {
    ss_ = null;
    sheets_ = {};
  }

  function dataUrl() {
    return ensure().getUrl();
  }

  // ------------------------------------------------------------------------------- lock

  /**
   * Runs fn under the script lock (20 s wait, timeout -> BUSY). Flushes pending writes and releases
   * the lock in `finally`. Re-entrant: a nested call runs inside the outer lock.
   */
  function withLock(fn) {
    if (lockDepth_ > 0) return fn();
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_TIMEOUT_MS);
    } catch (e) {
      throw Core.makeError('BUSY', 'Une autre opération est en cours. Réessayez dans quelques instants.');
    }
    lockDepth_++;
    try {
      return fn();
    } finally {
      lockDepth_--;
      try {
        SpreadsheetApp.flush();
      } finally {
        lock.releaseLock();
      }
    }
  }

  // --------------------------------------------------------------------------- generic tabs

  /** @return {Object[]} one {header: string} object per non-blank data row ('' for empty cells). */
  function readTab(tab) {
    return readTable_(tab).items.map(function (it) { return it.obj; });
  }

  /** Rewrites all data rows of `tab` (schema column order). */
  function writeTab(tab, objects) {
    var table = readTable_(tab);
    commit_(table, (objects || []).map(function (o) { return objectToRow_(table.schema, o || {}); }));
  }

  // ------------------------------------------------------------------------------- months

  /** First-column values of a tab (data rows only), with getLastRow + one narrow getValues. */
  function readFirstColumn_(tab) {
    var sheet = sheet_(tab);
    var last = sheet.getLastRow();
    if (last < 2) return [];
    return sheet.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return toText_(r[0]); });
  }

  /** Months present in ImportLog ∪ Postes ∪ Applications, ascending and unique. */
  function listMonths() {
    var seen = {};
    [Config.TABS.importLog, Config.TABS.postes, Config.TABS.applications].forEach(function (tab) {
      readFirstColumn_(tab).forEach(function (m) { seen[m] = true; });
    });
    return Core.sortMonths(Object.keys(seen));
  }

  function hasMonth(month) {
    return Core.validateMonth(month) && listMonths().indexOf(month) >= 0;
  }

  // ----------------------------------------------------------------------- entity snapshots
  // Entity rows: ['_month','_id','_key','_order','_json','_updated_at'] (indices 0..5).

  function parseJsonObject_(s, where) {
    if (!s) return {};
    try {
      var v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      console.warn('Store: invalid JSON in ' + where + ' (' + (e && e.message) + ')');
      return {};
    }
  }

  /** Record without `_`-prefixed fields (ids, order, enrichment), undefined -> null. */
  function stripMeta_(rec) {
    var out = {};
    Object.keys(rec || {}).forEach(function (k) {
      if (k.charAt(0) !== '_') out[k] = rec[k] === undefined ? null : rec[k];
    });
    return out;
  }

  function entityRow_(month, rec, keyField, order, id, updatedAt) {
    var data = stripMeta_(rec);
    return [month, id, keyField ? Core.str(data[keyField]) : '', String(order), JSON.stringify(data), updatedAt || ''];
  }

  function entityRecord_(row) {
    var rec = parseJsonObject_(row[4], 'record ' + row[1]);
    var order = parseInt(row[3], 10);
    rec._id = row[1];
    rec._key = row[2];
    rec._order = isNaN(order) ? 0 : order;
    rec._updated_at = row[5] || '';
    return rec;
  }

  function sortByOrder_(records) {
    return records
      .map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) { return (a.r._order - b.r._order) || (a.i - b.i); })
      .map(function (x) { return x.r; });
  }

  /** @return {Object[]} records of `month`, sorted by _order. */
  function readEntityMonth(tab, month) {
    var table = readTable_(tab);
    var out = [];
    table.items.forEach(function (it) {
      var row = table.raw[it.index];
      if (row[0] === month) out.push(entityRecord_(row));
    });
    return sortByOrder_(out);
  }

  /** @return {Object<string, Object[]>} month -> records sorted by _order. */
  function readEntityAll(tab) {
    var table = readTable_(tab);
    var byMonth = {};
    table.items.forEach(function (it) {
      var row = table.raw[it.index];
      if (!row[0]) return;
      (byMonth[row[0]] = byMonth[row[0]] || []).push(entityRecord_(row));
    });
    Object.keys(byMonth).forEach(function (m) { byMonth[m] = sortByOrder_(byMonth[m]); });
    return byMonth;
  }

  /**
   * Replaces the snapshot of one month (other months untouched). Keeps an existing `_id` /
   * `_updated_at`, otherwise assigns a new uuid; `_order` = index, `_key` = str(rec[keyField]).
   * @return {Object[]} the stored records
   */
  function replaceEntityMonth(tab, month, records, keyField) {
    checkMonth_(month);
    var kf = keyField || entityKeyField_(tab);
    var table = readTable_(tab);
    var usedIds = {};
    var fresh = (records || []).map(function (rec, i) {
      var id = Core.str(rec && rec._id);
      if (!id || hasOwn_(usedIds, id)) id = Config.uuid();
      usedIds[id] = true;
      return entityRow_(month, rec, kf, i, id, rec && rec._updated_at);
    });
    replaceMonthRows_(table, month, fresh);
    return fresh.map(entityRecord_);
  }

  /**
   * Applies field updates to records of `month`. All ids are checked before anything is written
   * (unknown id -> NOT_FOUND, nothing written). `_`-prefixed keys are ignored, blank values are
   * stored as null, `_key` follows the key column and `_updated_at` is set to now (ISO).
   * @param {{id:string, updates:Object}[]} changes
   * @return {Object[]} updated records (one per distinct id, in order of first appearance)
   */
  function updateEntityRows(tab, month, changes) {
    var list = changes || [];
    var table = readTable_(tab);
    var indexById = Object.create(null);
    table.items.forEach(function (it) {
      var row = table.raw[it.index];
      if (row[0] === month) indexById[row[1]] = it.index;
    });
    list.forEach(function (c) {
      var id = Core.str(c && c.id);
      if (!id || !(id in indexById)) throw notFound_(id);
    });

    var kf = entityKeyField_(tab);
    var now = new Date().toISOString();
    var rows = table.raw.slice();
    var touched = [];
    list.forEach(function (c) {
      var i = indexById[Core.str(c.id)];
      var row = rows[i].slice();
      var rec = parseJsonObject_(row[4], 'record ' + row[1]);
      var updates = c.updates || {};
      Object.keys(updates).forEach(function (k) {
        if (k.charAt(0) === '_') return;
        rec[k] = Core.isBlank(updates[k]) ? null : updates[k];
      });
      row[4] = JSON.stringify(rec);
      if (kf) row[2] = Core.str(rec[kf]);
      row[5] = now;
      rows[i] = row;
      if (touched.indexOf(i) < 0) touched.push(i);
    });
    if (touched.length) commit_(table, rows);
    return touched.map(function (i) { return entityRecord_(rows[i]); });
  }

  /** Appends a record to `month` with a new _id and _order = max + 1. */
  function appendEntityRow(tab, month, record, keyField) {
    checkMonth_(month);
    var kf = keyField || entityKeyField_(tab);
    var table = readTable_(tab);
    var maxOrder = -1;
    table.items.forEach(function (it) {
      var row = table.raw[it.index];
      if (row[0] !== month) return;
      var o = parseInt(row[3], 10);
      if (!isNaN(o) && o > maxOrder) maxOrder = o;
    });
    var row = entityRow_(month, record, kf, maxOrder + 1, Config.uuid(), new Date().toISOString());
    commit_(table, table.raw.concat([row]));
    return entityRecord_(row);
  }

  /** First item of `table` whose raw row and object pass `test(row, obj)`, or null. */
  function findItem_(table, test) {
    for (var k = 0; k < table.items.length; k++) {
      var it = table.items[k];
      if (test(table.raw[it.index], it.obj)) return it;
    }
    return null;
  }

  /** Deletes the sheet row of a found item; false when there is none. */
  function deleteItem_(table, it) {
    if (!it) return false;
    deleteSheetRow_(table.sheet, it.index + 2);
    return true;
  }

  /** @return {boolean} false when the id does not exist in `month`. */
  function deleteEntityRow(tab, month, id) {
    var key = Core.str(id);
    var table = readTable_(tab);
    return deleteItem_(table, key === '' ? null : findItem_(table, function (row) { return row[0] === month && row[1] === key; }));
  }

  // ---------------------------------------------------------------------------- référentiel
  // Rows: ['_month','category','position','value'].

  /** @return {Object<string, string[]>} categories in stored order, values ordered by position. */
  function readReferentiel(month) {
    var table = readTable_(Config.TABS.referentiel);
    var cats = [];
    var byCat = {};
    table.items.forEach(function (it) {
      var row = table.raw[it.index];
      if (row[0] !== month || row[1] === '') return;
      if (!hasOwn_(byCat, row[1])) { byCat[row[1]] = []; cats.push(row[1]); }
      var pos = parseInt(row[2], 10);
      byCat[row[1]].push({ pos: isNaN(pos) ? 0 : pos, i: it.index, value: row[3] });
    });
    var out = {};
    cats.forEach(function (c) {
      out[c] = byCat[c]
        .sort(function (a, b) { return (a.pos - b.pos) || (a.i - b.i); })
        .map(function (e) { return e.value; });
    });
    return out;
  }

  function replaceReferentiel(month, refObj) {
    checkMonth_(month);
    var table = readTable_(Config.TABS.referentiel);
    var fresh = [];
    Object.keys(refObj || {}).forEach(function (cat) {
      var values = Array.isArray(refObj[cat]) ? refObj[cat] : [];
      values.forEach(function (v, i) { fresh.push([month, cat, String(i), toText_(v)]); });
    });
    replaceMonthRows_(table, month, fresh);
  }

  // ------------------------------------------------------------------------------ import log

  function parseJsonValue_(s, fallback) {
    if (!s) return fallback;
    try {
      var v = JSON.parse(s);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  /** @return {Object[]} ImportLog entries in insertion order, json columns parsed. */
  function getImportLog() {
    return readTab(Config.TABS.importLog).map(function (o) {
      return {
        month: o.month,
        imported_at: o.imported_at,
        source_id: o.source_id,
        counts: parseJsonValue_(o.counts_json, {}),
        postes_headers: parseJsonValue_(o.postes_headers_json, []),
        apps_headers: parseJsonValue_(o.apps_headers_json, []),
        warnings: parseJsonValue_(o.warnings_json, [])
      };
    });
  }

  /** @param {{month, imported_at?, source_id, counts, postes_headers, apps_headers, warnings}} entry */
  function appendImportLog(entry) {
    var e = entry || {};
    appendRows_(Config.TABS.importLog, [[
      toText_(e.month),
      toText_(e.imported_at || Config.nowStamp()),
      toText_(e.source_id),
      JSON.stringify(e.counts || {}),
      JSON.stringify(e.postes_headers || []),
      JSON.stringify(e.apps_headers || []),
      JSON.stringify(e.warnings || [])
    ]]);
  }

  /** @return {Object|null} the last ImportLog entry for `month`. */
  function latestImportInfo(month) {
    var log = getImportLog();
    for (var i = log.length - 1; i >= 0; i--) if (log[i].month === month) return log[i];
    return null;
  }

  // ------------------------------------------------------------------- id-keyed rows (Actions…)

  function listRows(tab) {
    return readTab(tab);
  }

  /** Appends `obj` (normalised to the schema, all strings; id generated when blank). */
  function insertRow(tab, obj) {
    var schema = schema_(tab);
    var row = rowToObject_(schema, objectToRow_(schema, obj || {}));
    if (hasOwn_(row, 'id') && !row.id) row.id = Config.uuid();
    appendRows_(tab, [objectToRow_(schema, row)]);
    return row;
  }

  /** Merges schema fields of `patch` (except id) into a copy of `obj`. */
  function mergeRow_(schema, obj, patch) {
    var next = rowToObject_(schema, objectToRow_(schema, obj));
    Object.keys(patch || {}).forEach(function (k) {
      if (k !== 'id' && schema.indexOf(k) >= 0) next[k] = toText_(patch[k]);
    });
    return next;
  }

  /** @return {Object} the updated row; NOT_FOUND when id is unknown. */
  function updateRow(tab, id, updates) {
    var key = Core.str(id);
    var table = readTable_(tab);
    var it = key === '' ? null : findItem_(table, function (row, obj) { return obj.id === key; });
    if (!it) throw notFound_(key);
    var next = mergeRow_(table.schema, it.obj, updates);
    var rows = table.raw.slice();
    rows[it.index] = objectToRow_(table.schema, next);
    commit_(table, rows);
    return next;
  }

  /** @return {boolean} false when id is unknown. */
  function deleteRow(tab, id) {
    var key = Core.str(id);
    var table = readTable_(tab);
    return deleteItem_(table, key === '' ? null : findItem_(table, function (row, obj) { return obj.id === key; }));
  }

  /**
   * Bulk update with one read and (at most) one write. For every row where predicate(copy) is
   * truthy, updater(copy) either returns a patch object or mutates the copy in place.
   * @return {number} number of rows matched
   */
  function updateRowsWhere(tab, predicate, updater) {
    var table = readTable_(tab);
    var rows = table.raw.slice();
    var n = 0;
    table.items.forEach(function (it) {
      if (!predicate(rowToObject_(table.schema, table.raw[it.index]))) return;
      var copy = rowToObject_(table.schema, table.raw[it.index]);
      var res = updater(copy);
      var patch = res && typeof res === 'object' ? res : copy;
      rows[it.index] = objectToRow_(table.schema, mergeRow_(table.schema, it.obj, patch));
      n++;
    });
    if (n) commit_(table, rows);
    return n;
  }

  return {
    ensure: ensure,
    dataUrl: dataUrl,
    withLock: withLock,
    readTab: readTab,
    writeTab: writeTab,
    listMonths: listMonths,
    hasMonth: hasMonth,
    readEntityMonth: readEntityMonth,
    readEntityAll: readEntityAll,
    replaceEntityMonth: replaceEntityMonth,
    updateEntityRows: updateEntityRows,
    appendEntityRow: appendEntityRow,
    deleteEntityRow: deleteEntityRow,
    readReferentiel: readReferentiel,
    replaceReferentiel: replaceReferentiel,
    getImportLog: getImportLog,
    appendImportLog: appendImportLog,
    latestImportInfo: latestImportInfo,
    listRows: listRows,
    insertRow: insertRow,
    updateRow: updateRow,
    deleteRow: deleteRow,
    updateRowsWhere: updateRowsWhere,
    resetCache_: resetCache_
  };
})();
