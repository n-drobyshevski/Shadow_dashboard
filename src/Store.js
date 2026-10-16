/**
 * Store: repository over the app's data spreadsheet, and the only module that writes to it.
 * One tab per Config.SCHEMAS entry, header in row 1, every cell stored as plain text.
 */
var Store = (function () {
  var LOCK_TIMEOUT_MS = 20000;
  var OPEN_RETRY_DELAYS_MS = [500, 1500];
  var PLAIN_TEXT_FORMAT = '@';
  var META_SCHEMA_VERSION_KEY = 'schema_version';
  var IMPORT_LOG_TAIL = 30;
  var ACCESS_LOG_MAX = 1000;      // rows kept in AccessLog
  var ACCESS_LOG_SLACK = 100;     // trimmed in one deleteRows once the tab is this much over
  var VISIT_LOCK_MS = 500;
  var PAGES_LOOKBACK = 50;        // rows searched for the caller's visit when it notes a page

  // Per-execution caches.
  var ss_ = null;
  var sheets_ = {};
  var lockDepth_ = 0;
  var sourceWritten_ = false;
  // tab: {table, col, spans}. A tab's entry is dropped by every write to it, and the whole memo when
  // withLock acquires the lock so a read-modify-write never starts from stale rows. Memoized tables
  // and spans are shared, so callers copy before changing them.
  var memo_ = {};

  function schema_(tab) {
    var schema = Config.SCHEMAS[tab];
    if (!schema) throw Core.makeError('INTERNAL', 'Onglet inconnu : ' + tab);
    return schema;
  }

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

  function isDate_(v) {
    return Object.prototype.toString.call(v) === '[object Date]';
  }

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

  function textRow_(src, width) {
    var row = [];
    for (var j = 0; j < width; j++) row.push(j < src.length ? toText_(src[j]) : '');
    return row;
  }

  function memoOf_(tab) {
    return memo_[tab] || (memo_[tab] = { table: null, col: null, spans: Object.create(null) });
  }

  // Drops the whole memo when the sheet is not a mapped tab yet.
  function forgetSheet_(sheet) {
    var tabs = Object.keys(sheets_);
    for (var i = 0; i < tabs.length; i++) {
      if (sheets_[tabs[i]] === sheet) { delete memo_[tabs[i]]; return; }
    }
    memo_ = {};
  }

  function clearMemo_() {
    memo_ = {};
  }

  // GAS throws on out-of-bounds ranges.
  function ensureSize_(sheet, rows, cols) {
    var maxRows = sheet.getMaxRows();
    if (maxRows < rows) sheet.insertRowsAfter(maxRows, rows - maxRows);
    var maxCols = sheet.getMaxColumns();
    if (maxCols < cols) sheet.insertColumnsAfter(maxCols, cols - maxCols);
  }

  // The only write path. The '@' format stops Sheets from retyping '2026-05' or '0042' and from
  // evaluating '=...'. Do not add a "'" prefix: in a plain-text cell it is kept as part of the value.
  function writeBlock_(sheet, startRow, rows) {
    if (!rows.length) return;
    forgetSheet_(sheet);
    var width = rows[0].length;
    ensureSize_(sheet, startRow + rows.length - 1, width);
    var range = sheet.getRange(startRow, 1, rows.length, width);
    range.setNumberFormat(PLAIN_TEXT_FORMAT);
    range.setValues(rows);
  }

  // raw keeps blank rows so that raw[i] is sheet row i + 2.
  function readSheet_(sheet, schema) {
    var values = sheet.getDataRange().getValues();
    var raw = [];
    var items = [];
    for (var i = 1; i < values.length; i++) {
      var row = textRow_(values[i], schema.length);
      raw.push(row);
      if (!isEmptyRow_(row)) items.push({ index: raw.length - 1, obj: rowToObject_(schema, row) });
    }
    return { sheet: sheet, schema: schema, base: 0, raw: raw, items: items };
  }

  // Memoized and shared: do not change the result.
  function readTable_(tab) {
    var sheet = sheet_(tab);
    var m = memoOf_(tab);
    if (m.table) return m.table;
    var t0 = Date.now();
    var table = readSheet_(sheet, schema_(tab));
    Perf.log({ stage: 'sheet', tab: tab, rows: table.raw.length, ms: Date.now() - t0 });
    m.table = table;
    return table;
  }

  // `first` is a 0-based data row index (data row 0 is sheet row 2). Not memoized.
  function readRows_(tab, first, count) {
    var sheet = sheet_(tab);
    var width = schema_(tab).length;
    var t0 = Date.now();
    var rows = sheet.getRange(first + 2, 1, count, width).getValues().map(function (src) { return textRow_(src, width); });
    Perf.log({ stage: 'span', tab: tab, rows: count, ms: Date.now() - t0 });
    return rows;
  }

  // Rewrites only the smallest contiguous block that changed and deletes leftover rows when the
  // table shrank. A month span can only be rewritten in place. Returns the number of rows written.
  function commit_(table, newRows) {
    var old = table.raw;
    if (table.partial && newRows.length !== old.length) {
      throw Core.makeError('INTERNAL', 'Store: a month span is only rewritten in place.');
    }
    var start = 0;
    while (start < old.length && start < newRows.length && rowsEqual_(old[start], newRows[start])) start++;
    var end = newRows.length;
    if (old.length === newRows.length) {
      while (end > start && rowsEqual_(old[end - 1], newRows[end - 1])) end--;
    }
    if (end > start) writeBlock_(table.sheet, 2 + table.base + start, newRows.slice(start, end));
    if (old.length > newRows.length) {
      forgetSheet_(table.sheet);
      var first = 2 + newRows.length;
      var count = old.length - newRows.length;
      // Sheets refuses to delete the last non-frozen row, so that one is cleared instead.
      var del = Math.min(count, table.sheet.getMaxRows() - 2);
      if (del > 0) table.sheet.deleteRows(first, del);
      if (count > del) table.sheet.getRange(first, 1, count - del, table.schema.length).clearContent();
    }
    table.raw = newRows;
    return end - start;
  }

  function appendRows_(tab, rows) {
    var sheet = sheet_(tab);
    writeBlock_(sheet, Math.max(sheet.getLastRow(), 1) + 1, rows);
  }

  // Sheets refuses to delete the last non-frozen row.
  function deleteSheetRow_(sheet, rowNumber) {
    forgetSheet_(sheet);
    var maxRows = sheet.getMaxRows();
    if (maxRows <= 2) sheet.insertRowsAfter(maxRows, 1);
    sheet.deleteRow(rowNumber);
  }

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

  // Spreadsheet and tabs

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

  // The Script Property answers without reading Meta, and a version found in Meta is copied to it.
  function schemaCurrent_(metaSheet, id, cfg) {
    if (cfg.schemaVersion === Config.SCHEMA_VERSION) return true;
    if (metaValue_(metaSheet, META_SCHEMA_VERSION_KEY) !== Config.SCHEMA_VERSION) return false;
    Config.setSchemaVersion(id, Config.SCHEMA_VERSION);
    return true;
  }

  // Takes no lock and writes nothing unless a tab is missing or the schema is outdated.
  function ensureTabs_(ss, id, cfg, created) {
    var names = Object.keys(Config.SCHEMAS);
    if (!created) {
      var byName = {};
      ss.getSheets().forEach(function (sh) { byName[sh.getName()] = sh; });
      var allPresent = names.every(function (n) { return !!byName[n]; });
      if (allPresent && schemaCurrent_(byName[Config.TABS.meta], id, cfg)) {
        var fast = {};
        names.forEach(function (n) { fast[n] = byName[n]; });
        return fast;
      }
    }
    return withLock(function () { return repairTabs_(ss, id, created); });
  }

  // A new sheet has 26 columns, and rows inserted later would be that wide. Hand-typed columns stay.
  function trimColumns_(sheet, width) {
    var max = sheet.getMaxColumns();
    if (max > width && sheet.getLastColumn() <= width) sheet.deleteColumns(width + 1, max - width);
  }

  // Caller holds the lock.
  function repairTabs_(ss, id, created) {
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
      trimColumns_(sh, Config.SCHEMAS[name].length);
      ensureHeader_(sh, Config.SCHEMAS[name]);
      out[name] = sh;
    });
    setMetaValue_(out[Config.TABS.meta], META_SCHEMA_VERSION_KEY, Config.SCHEMA_VERSION);
    Config.setSchemaVersion(id, Config.SCHEMA_VERSION);
    return out;
  }

  // openById fails transiently, so retry. Never replace a configured id automatically: an admin
  // deletes the DATA_SPREADSHEET_ID property to start over.
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

  // Creation runs under the lock and re-reads the property there, so concurrent first loads create
  // a single file.
  function ensure() {
    if (ss_) return ss_;
    var t = Perf.start('ensure');
    var cfg = Config.get();
    var ss = null;
    var created = false;
    if (cfg.dataId) {
      ss = openData_(cfg.dataId);
      t.lap('open');
      setSheets_(ensureTabs_(ss, cfg.dataId, cfg, false));
      t.lap('ensureTabs');
    } else {
      withLock(function () {
        var fresh = Config.get({ fresh: true });
        var id = fresh.dataId;
        if (id) {
          ss = openData_(id);
        } else {
          ss = SpreadsheetApp.create(Config.DATA_SPREADSHEET_NAME);
          id = ss.getId();
          Config.setDataId(id);
          created = true;
        }
        t.lap('open');
        setSheets_(ensureTabs_(ss, id, fresh, created));
        t.lap('ensureTabs');
      });
    }
    t.end({ created: created });
    ss_ = ss;
    return ss;
  }

  function setSheets_(map) {
    sheets_ = map;
    memo_ = {};
  }

  function sheet_(tab) {
    ensure();
    var sh = sheets_[tab];
    if (!sh) throw Core.makeError('INTERNAL', 'Onglet inconnu : ' + tab);
    return sh;
  }

  function resetCache_() {
    ss_ = null;
    sheets_ = {};
    memo_ = {};
    Config.clearMemo_();
  }

  function dataUrl() {
    return Config.spreadsheetUrl(Config.get().dataId || ensure().getId());
  }

  // Re-entrant. Memos are dropped on acquire since another execution may have written while we
  // waited. The source stamp is bumped after the flush and before release, so whoever sees the new
  // stamp also sees the flushed source (Importer.importMonth relies on it).
  function withLock(fn) {
    if (lockDepth_ > 0) return fn();
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_TIMEOUT_MS);
    } catch (e) {
      throw Core.makeError('BUSY', 'Une autre opération est en cours. Réessayez dans quelques instants.');
    }
    memo_ = {};
    Config.clearMemo_();
    sourceWritten_ = false;
    lockDepth_++;
    try {
      return fn();
    } finally {
      lockDepth_--;
      try {
        SpreadsheetApp.flush();
      } finally {
        try {
          // Even when fn or the flush failed: a write may have reached the source before the error.
          if (sourceWritten_) Config.bumpSourceStamp();
        } finally {
          sourceWritten_ = false;
          lock.releaseLock();
        }
      }
    }
  }

  // Call before writing to the source spreadsheet, under withLock.
  function noteSourceWrite() {
    if (lockDepth_ <= 0) throw Core.makeError('INTERNAL', 'Écriture dans le classeur source hors du verrou.');
    sourceWritten_ = true;
  }

  // Generic tabs

  function readTab(tab) {
    var table = readTable_(tab);
    return table.items.map(function (it) { return rowToObject_(table.schema, table.raw[it.index]); });
  }

  function writeTab(tab, objects) {
    var table = readTable_(tab);
    commit_(table, (objects || []).map(function (o) { return objectToRow_(table.schema, o || {}); }));
  }

  // Months

  // col[i] is data row i. Memoized and shared.
  function firstColumn_(tab) {
    var sheet = sheet_(tab);
    var m = memoOf_(tab);
    if (m.col) return m.col;
    if (m.table) {
      m.col = m.table.raw.map(function (r) { return r[0]; });
    } else {
      var last = sheet.getLastRow();
      try {
        m.col = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return toText_(r[0]); });
      } catch (e) {
        // Another execution deleted rows after getLastRow, so the range ran past the end.
        m.col = readTable_(tab).raw.map(function (r) { return r[0]; });
      }
    }
    return m.col;
  }

  function listMonths() {
    var t = Perf.start('listMonths');
    var seen = {};
    var rows = 0;
    [Config.TABS.importLog, Config.TABS.postes, Config.TABS.applications].forEach(function (tab) {
      var col = firstColumn_(tab);
      rows += col.length;
      col.forEach(function (m) { seen[m] = true; });
      t.lap(tab);
    });
    var months = Core.sortMonths(Object.keys(seen));
    t.end({ rows: rows, months: months.length });
    return months;
  }

  function hasMonth(month) {
    return Core.validateMonth(month) && listMonths().indexOf(month) >= 0;
  }

  function tabMonths(tab) {
    var seen = {};
    firstColumn_(tab).forEach(function (m) { seen[m] = true; });
    return Core.sortMonths(Object.keys(seen));
  }

  function spanOfTable_(table, month) {
    var items = [];
    table.items.forEach(function (it) {
      if (table.raw[it.index][0] === month) items.push({ index: it.index, row: table.raw[it.index] });
    });
    return { sheet: table.sheet, schema: table.schema, base: 0, raw: table.raw, items: items };
  }

  // Reads one month's block (located through column A) plus one row on each side, without the other
  // months. Reads happen outside the lock, so if rows moved since column A was read (block mismatch,
  // the month found just outside it, or the sheet shrank or grew) the whole tab is read instead.
  // raw[i] is data row base + i. Memoized and shared.
  function monthSpan_(tab, month) {
    var sheet = sheet_(tab);
    var m = memoOf_(tab);
    if (m.spans[month]) return m.spans[month];
    if (m.table) return (m.spans[month] = spanOfTable_(m.table, month));
    var col = firstColumn_(tab);
    var first = col.indexOf(month);
    var span = { sheet: sheet, schema: schema_(tab), base: 0, raw: [], items: [], partial: true };
    function wholeTab() {
      delete memo_[tab];
      var table = readTable_(tab);
      return (memoOf_(tab).spans[month] = spanOfTable_(table, month));
    }
    if (first >= 0 && month !== '') {
      var last = col.lastIndexOf(month);
      var lo = first > 0 ? first - 1 : first;
      // Past the end of column A, only the sheet size tells whether a row exists now.
      var hi = last + 1 < col.length ? last + 1 : Math.min(last + 1, sheet.getMaxRows() - 2);
      if (hi < last) return wholeTab();
      var rows;
      try {
        rows = readRows_(tab, lo, hi - lo + 1);
      } catch (e) {
        return wholeTab();
      }
      // With no row below the block to check, rows inserted during the read would go unnoticed.
      if (hi === last && sheet.getMaxRows() - 2 > last) return wholeTab();
      if ((lo < first && rows[0][0] === month) || (hi > last && rows[rows.length - 1][0] === month)) return wholeTab();
      span.base = first;
      span.raw = rows.slice(first - lo, first - lo + last - first + 1);
      for (var i = 0; i < span.raw.length; i++) {
        var isMonth = span.raw[i][0] === month;
        if (isMonth !== (col[first + i] === month)) return wholeTab();
        if (isMonth) span.items.push({ index: first + i, row: span.raw[i] });
      }
    }
    m.spans[month] = span;
    return span;
  }

  // Entity rows: _month, _id, _key, _order, _json, _updated_at.

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

  function readEntityMonth(tab, month) {
    return sortByOrder_(monthSpan_(tab, month).items.map(function (it) { return entityRecord_(it.row); }));
  }

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

  // Only uuid-shaped ids are kept, never "__proto__" or a value copied from the source.
  var ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

  function replaceEntityMonth(tab, month, records, keyField) {
    checkMonth_(month);
    var kf = keyField || entityKeyField_(tab);
    var table = readTable_(tab);
    var usedIds = Object.create(null);
    var fresh = (records || []).map(function (rec, i) {
      var id = Core.str(rec && rec._id);
      if (!ID_RE.test(id) || usedIds[id] === true) id = Config.uuid();
      usedIds[id] = true;
      var stamp = Core.str(rec && rec._updated_at);
      return entityRow_(month, rec, kf, i, id, STAMP_RE.test(stamp) ? stamp : '');
    });
    replaceMonthRows_(table, month, fresh);
    return fresh.map(entityRecord_);
  }

  // Every id is checked first: an unknown one throws NOT_FOUND before anything is written.
  function updateEntityRows(tab, month, changes) {
    var list = changes || [];
    var span = monthSpan_(tab, month);
    var indexById = Object.create(null);
    span.items.forEach(function (it) { indexById[it.row[1]] = it.index - span.base; });
    list.forEach(function (c) {
      var id = Core.str(c && c.id);
      if (!id || !(id in indexById)) throw notFound_(id);
    });

    var kf = entityKeyField_(tab);
    var now = new Date().toISOString();
    var rows = span.raw.slice();
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
    if (touched.length) commit_(span, rows);
    return touched.map(function (i) { return entityRecord_(rows[i]); });
  }

  // Appends after the last used row, so the month's rows may stop being contiguous.
  function appendEntityRow(tab, month, record, keyField) {
    checkMonth_(month);
    var kf = keyField || entityKeyField_(tab);
    var maxOrder = -1;
    monthSpan_(tab, month).items.forEach(function (it) {
      var o = parseInt(it.row[3], 10);
      if (!isNaN(o) && o > maxOrder) maxOrder = o;
    });
    var row = entityRow_(month, record, kf, maxOrder + 1, Config.uuid(), new Date().toISOString());
    appendRows_(tab, [row]);
    return entityRecord_(row);
  }

  function findItem_(table, test) {
    for (var k = 0; k < table.items.length; k++) {
      var it = table.items[k];
      if (test(table.raw[it.index], it.obj)) return it;
    }
    return null;
  }

  function deleteEntityRow(tab, month, id) {
    var key = Core.str(id);
    if (key === '') return false;
    var span = monthSpan_(tab, month);
    for (var k = 0; k < span.items.length; k++) {
      if (span.items[k].row[1] !== key) continue;
      deleteSheetRow_(span.sheet, span.items[k].index + 2);
      return true;
    }
    return false;
  }

  // Référentiel rows: _month, category, position, value.

  function readReferentiel(month) {
    var cats = [];
    var byCat = {};
    monthSpan_(Config.TABS.referentiel, month).items.forEach(function (it) {
      var row = it.row;
      if (row[1] === '') return;
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

  // Import log

  function parseJsonValue_(s, fallback) {
    if (!s) return fallback;
    try {
      var v = JSON.parse(s);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function importLogEntry_(row) {
    return {
      month: row[0],
      imported_at: row[1],
      source_id: row[2],
      counts: parseJsonValue_(row[3], {}),
      postes_headers: parseJsonValue_(row[4], []),
      apps_headers: parseJsonValue_(row[5], []),
      warnings: parseJsonValue_(row[6], []),
      changes: parseJsonValue_(row[7], null)
    };
  }

  function lastEntryIn_(rows, month) {
    for (var i = rows.length - 1; i >= 0; i--) if (rows[i][0] === month) return importLogEntry_(rows[i]);
    return null;
  }

  function getImportLog() {
    var table = readTable_(Config.TABS.importLog);
    return table.items.map(function (it) { return importLogEntry_(table.raw[it.index]); });
  }

  // Newest first, read from the bottom in doubling blocks while blank rows leave too few entries.
  function recentRows_(tab, limit, entryOf) {
    var n = Math.max(0, Math.floor(Number(limit) || 0));
    var end = sheet_(tab).getLastRow() - 1;
    var chunk = n;
    var out = [];
    while (out.length < n && end > 0) {
      var k = Math.min(chunk, end);
      var rows;
      try {
        rows = readRows_(tab, end - k, k);
      } catch (e) {
        // The sheet lost rows: start over on the whole tab as a last pass.
        rows = readTable_(tab).raw;
        out = [];
        end = 0;
      }
      for (var i = rows.length - 1; i >= 0 && out.length < n; i--) {
        if (!isEmptyRow_(rows[i])) out.push(entryOf(rows[i]));
      }
      end -= k;
      chunk *= 2;
    }
    return out;
  }

  function recentImportLog(limit) {
    return recentRows_(Config.TABS.importLog, limit, importLogEntry_);
  }

  // Best effort: a boot never waits behind a sync, so the visit is dropped when the lock is busy.
  // Returns true when the row was written.
  function appendAccessLog(entry) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(VISIT_LOCK_MS)) return false;
    try {
      var tab = Config.TABS.accessLog;
      appendRows_(tab, [[toText_(entry.at || Config.nowStamp()), toText_(entry.email), toText_(entry.result), '']]);
      var sheet = sheet_(tab);
      var rows = sheet.getLastRow() - 1;
      if (rows > ACCESS_LOG_MAX + ACCESS_LOG_SLACK) {
        forgetSheet_(sheet);
        sheet.deleteRows(2, rows - ACCESS_LOG_MAX);
      }
      SpreadsheetApp.flush();
      return true;
    } finally {
      lock.releaseLock();
    }
  }

  function pageList_(cell) {
    return cell ? String(cell).split(',').filter(Boolean) : [];
  }

  function recentAccessLog(limit) {
    return recentRows_(Config.TABS.accessLog, limit, function (row) {
      return { at: row[0], email: row[1], result: row[2], pages: pageList_(row[3]) };
    });
  }

  // Adds page ids to the caller's latest visit row, best effort like appendAccessLog. Returns true when
  // that row was found (whether or not it changed).
  function noteAccessPages(email, pages) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(VISIT_LOCK_MS)) return false;
    try {
      var tab = Config.TABS.accessLog;
      var sheet = sheet_(tab);
      var end = sheet.getLastRow() - 1;
      if (end <= 0) return false;
      var k = Math.min(PAGES_LOOKBACK, end);
      var rows = readRows_(tab, end - k, k);
      for (var i = rows.length - 1; i >= 0; i--) {
        if (rows[i][1] !== email || rows[i][2] === 'refused') continue;
        var seen = pageList_(rows[i][3]);
        var merged = seen.concat(pages.filter(function (p) { return seen.indexOf(p) < 0; }));
        if (merged.length > seen.length) {
          var cell = rows[i].slice();
          cell[3] = merged.join(',');
          writeBlock_(sheet, end - k + i + 2, [cell]);
          SpreadsheetApp.flush();
        }
        return true;
      }
      return false;
    } finally {
      lock.releaseLock();
    }
  }

  function appendImportLog(entry) {
    var e = entry || {};
    appendRows_(Config.TABS.importLog, [[
      toText_(e.month),
      toText_(e.imported_at || Config.nowStamp()),
      toText_(e.source_id),
      JSON.stringify(e.counts || {}),
      JSON.stringify(e.postes_headers || []),
      JSON.stringify(e.apps_headers || []),
      JSON.stringify(e.warnings || []),
      e.changes ? JSON.stringify(e.changes) : ''
    ]]);
  }

  // Tries the last IMPORT_LOG_TAIL rows, then column A from the bottom and that one row, then the
  // whole tab if rows were deleted in between.
  function latestImportInfo(month) {
    var tab = Config.TABS.importLog;
    var sheet = sheet_(tab);
    var m = memoOf_(tab);
    if (m.table) return lastEntryIn_(m.table.raw, month);
    if (!m.col) {
      var count = sheet.getLastRow() - 1;
      var k = Math.min(IMPORT_LOG_TAIL, count);
      if (k <= 0) return null;
      var tail = null;
      try {
        tail = readRows_(tab, count - k, k);
      } catch (e) {
        tail = null;
      }
      var hit = tail && lastEntryIn_(tail, month);
      if (tail && (hit || k === count)) return hit;
    }
    var j = firstColumn_(tab).lastIndexOf(month);
    if (j < 0 || month === '') return null;
    var row = null;
    try {
      row = readRows_(tab, j, 1)[0];
    } catch (e) {
      row = null;
    }
    if (row && row[0] === month) return importLogEntry_(row);
    delete memo_[tab];
    return lastEntryIn_(readTable_(tab).raw, month);
  }

  // Id-keyed rows (Actions)

  function listRows(tab) {
    return readTab(tab);
  }

  function insertRow(tab, obj) {
    var schema = schema_(tab);
    var row = rowToObject_(schema, objectToRow_(schema, obj || {}));
    if (hasOwn_(row, 'id') && !row.id) row.id = Config.uuid();
    appendRows_(tab, [objectToRow_(schema, row)]);
    return row;
  }

  function mergeRow_(schema, obj, patch) {
    var next = rowToObject_(schema, objectToRow_(schema, obj));
    Object.keys(patch || {}).forEach(function (k) {
      if (k !== 'id' && schema.indexOf(k) >= 0) next[k] = toText_(patch[k]);
    });
    return next;
  }

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

  function deleteRow(tab, id) {
    var key = Core.str(id);
    var table = readTable_(tab);
    var it = key === '' ? null : findItem_(table, function (row, obj) { return obj.id === key; });
    if (!it) return false;
    deleteSheetRow_(table.sheet, it.index + 2);
    return true;
  }

  // updater(copy) returns a patch or mutates the copy. Returns the number of rows matched.
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
    noteSourceWrite: noteSourceWrite,
    readTab: readTab,
    writeTab: writeTab,
    listMonths: listMonths,
    hasMonth: hasMonth,
    tabMonths: tabMonths,
    readEntityMonth: readEntityMonth,
    readEntityAll: readEntityAll,
    replaceEntityMonth: replaceEntityMonth,
    updateEntityRows: updateEntityRows,
    appendEntityRow: appendEntityRow,
    deleteEntityRow: deleteEntityRow,
    readReferentiel: readReferentiel,
    replaceReferentiel: replaceReferentiel,
    getImportLog: getImportLog,
    recentImportLog: recentImportLog,
    appendImportLog: appendImportLog,
    appendAccessLog: appendAccessLog,
    recentAccessLog: recentAccessLog,
    noteAccessPages: noteAccessPages,
    ACCESS_LOG_MAX: ACCESS_LOG_MAX,
    ACCESS_LOG_SLACK: ACCESS_LOG_SLACK,
    latestImportInfo: latestImportInfo,
    listRows: listRows,
    insertRow: insertRow,
    updateRow: updateRow,
    deleteRow: deleteRow,
    updateRowsWhere: updateRowsWhere,
    resetCache_: resetCache_,
    clearMemo_: clearMemo_
  };
})();
