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
 * Performance discipline (each Sheets call is a round trip, each cell read costs too):
 *   - a whole tab is read with ONE getDataRange().getValues();
 *   - one month of an entity / Référentiel tab is read without the other months: column A (one
 *     narrow read, usually already done by listMonths) locates the month's rows, ONE getValues reads
 *     that block (monthSpan_). ImportLog is read from the bottom (latestImportInfo, recentImportLog);
 *   - a mutation is committed with at most ONE setValues(): commit_() diffs the new rows against
 *     the rows just read and only rewrites the smallest contiguous block that changed (plus one
 *     clearContent() when the tab shrank). No per-row API calls in loops;
 *   - reads are memoized for the current execution (memo_), see below.
 *
 * Load-order safe: the IIFE only defines functions; Config / Core / GAS services are used lazily.
 */
var Store = (function () {
  var LOCK_TIMEOUT_MS = 20000;
  var OPEN_RETRY_DELAYS_MS = [500, 1500]; // openById of the data spreadsheet: 3 attempts in total
  var PLAIN_TEXT_FORMAT = '@';
  var META_SCHEMA_VERSION_KEY = 'schema_version';

  var IMPORT_LOG_TAIL = 30; // rows read from the bottom of ImportLog before scanning its column A

  // Per-execution caches (GAS re-evaluates the script for every execution).
  var ss_ = null;      // data Spreadsheet
  var sheets_ = {};    // tab name -> Sheet
  var lockDepth_ = 0;  // > 0 while this execution holds the script lock (re-entrant withLock)
  var sourceWritten_ = false; // the current withLock wrote into the source spreadsheet (noteSourceWrite)
  /**
   * Read memo, tab -> {table: readTable_ result | null, col: column A | null, spans: {month: span}}.
   * A tab's entry is dropped by every write primitive on that tab (writeBlock_, the clearContent of
   * commit_, deleteSheetRow_), and the whole memo when withLock acquires the lock (a read-modify-write
   * under the lock never starts from rows read before it), when ensure() maps the tabs, by
   * resetCache_ and by clearMemo_ (start of every api_* call and of the hourly trigger run). Memoized
   * tables and spans are shared: callers copy rows / objects before changing them.
   */
  var memo_ = {};

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

  /** A row of cell values -> `width` strings (missing cells -> ''). */
  function textRow_(src, width) {
    var row = [];
    for (var j = 0; j < width; j++) row.push(j < src.length ? toText_(src[j]) : '');
    return row;
  }

  // ----------------------------------------------------------------------------- read memo

  function memoOf_(tab) {
    return memo_[tab] || (memo_[tab] = { table: null, col: null, spans: Object.create(null) });
  }

  /** Drops the memo of the tab held in `sheet` (all of it when the sheet is not a mapped tab yet). */
  function forgetSheet_(sheet) {
    var tabs = Object.keys(sheets_);
    for (var i = 0; i < tabs.length; i++) {
      if (sheets_[tabs[i]] === sheet) { delete memo_[tabs[i]]; return; }
    }
    memo_ = {};
  }

  /** Forgets every memoized read of this execution (api_* calls and the trigger run start with it). */
  function clearMemo_() {
    memo_ = {};
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
    forgetSheet_(sheet);
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
      var row = textRow_(values[i], schema.length);
      raw.push(row);
      if (!isEmptyRow_(row)) items.push({ index: raw.length - 1, obj: rowToObject_(schema, row) });
    }
    return { sheet: sheet, schema: schema, base: 0, raw: raw, items: items };
  }

  /**
   * readSheet_ of a data tab, memoized for the execution (memo_), with one {stage:'sheet', tab, rows,
   * ms} timing line (Perf) per actual read. The result is shared: do not change it.
   */
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

  /**
   * Data rows first .. first + count - 1 of a tab (0-based: data row 0 = sheet row 2) as strings,
   * with ONE getValues. Logs {stage:'span', tab, rows, ms} (Perf). Not memoized (callers are).
   */
  function readRows_(tab, first, count) {
    var sheet = sheet_(tab);
    var width = schema_(tab).length;
    var t0 = Date.now();
    var rows = sheet.getRange(first + 2, 1, count, width).getValues().map(function (src) { return textRow_(src, width); });
    Perf.log({ stage: 'span', tab: tab, rows: count, ms: Date.now() - t0 });
    return rows;
  }

  /**
   * Persists `newRows` for a table read by readSheet_ (complete list of data rows) or for a month span
   * (monthSpan_: the rows of its block, same length only), writing only the smallest contiguous block
   * that differs from what was read (ONE setValues) and clearing the leftover rows when the table
   * shrank (ONE clearContent).
   * @return {number} number of rows written
   */
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
    forgetSheet_(sheet);
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
   * True when the data spreadsheet `id` carries the current schema version. The DATA_SCHEMA_VERSION
   * Script Property (Config.get reads it with the other properties, keyed by the spreadsheet id)
   * answers without reading Meta; otherwise Meta is read once, and a current version found there is
   * copied into the property for the next executions.
   */
  function schemaCurrent_(metaSheet, id, cfg) {
    if (cfg.schemaVersion === Config.SCHEMA_VERSION) return true;
    if (metaValue_(metaSheet, META_SCHEMA_VERSION_KEY) !== Config.SCHEMA_VERSION) return false;
    Config.setSchemaVersion(id, Config.SCHEMA_VERSION);
    return true;
  }

  /**
   * Makes sure every tab exists with its header. Fast path (getSheets, no Meta read when the schema
   * version property is current, no write, no lock) when all tabs exist and the schema version is
   * current; otherwise the repair (tab creation, header and Meta writes) runs under the script lock
   * and re-reads the tabs there.
   * @param {Spreadsheet} ss the data spreadsheet, whose id is `id`
   * @param {Object} cfg Config.get() of this execution (schemaVersion)
   * @return {Object<string, Sheet>}
   */
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

  /** Slow path of ensureTabs_ (caller holds the lock); records the schema version in Meta and in the property. */
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
      ensureHeader_(sh, Config.SCHEMAS[name]);
      out[name] = sh;
    });
    setMetaValue_(out[Config.TABS.meta], META_SCHEMA_VERSION_KEY, Config.SCHEMA_VERSION);
    Config.setSchemaVersion(id, Config.SCHEMA_VERSION);
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
   * The first successful call of an execution logs {stage:'ensure', ms, open, ensureTabs, created}
   * (Perf; a failure is reported by openData_ and the caller's {api, ok:false} line).
   */
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
        var fresh = Config.get({ fresh: true }); // another execution may have created it while we waited
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

  /** Maps the tabs of the (re)opened data spreadsheet; reads memoized before refer to other sheets. */
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

  /** Drops the per-execution caches, Config's included (tests simulate a new execution with it). */
  function resetCache_() {
    ss_ = null;
    sheets_ = {};
    memo_ = {};
    Config.clearMemo_();
  }

  /**
   * URL of the data spreadsheet, built from the configured id without opening the file; only when no id
   * is configured yet does it go through ensure() (which creates the spreadsheet).
   */
  function dataUrl() {
    return Config.spreadsheetUrl(Config.get().dataId || ensure().getId());
  }

  // ------------------------------------------------------------------------------- lock

  /**
   * Runs fn under the script lock (20 s wait, timeout -> BUSY). Flushes pending writes and releases
   * the lock in `finally`. Re-entrant: a nested call runs inside the outer lock. Acquiring the lock
   * drops the read memos (Store and Config): another execution may have written while this one
   * waited, and every read-modify-write under the lock must start from the stored values.
   * When fn wrote into the source spreadsheet (noteSourceWrite), the source write stamp moves forward
   * after the flush and before the lock is released (Config.bumpSourceStamp): whoever sees the new stamp
   * also sees the flushed source, which is what Importer.importMonth relies on.
   */
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

  /**
   * Records that this execution is about to write into the SOURCE spreadsheet (Importer write-back):
   * the outermost withLock then moves the source write stamp. Only under withLock (INTERNAL otherwise).
   */
  function noteSourceWrite() {
    if (lockDepth_ <= 0) throw Core.makeError('INTERNAL', 'Écriture dans le classeur source hors du verrou.');
    sourceWritten_ = true;
  }

  // --------------------------------------------------------------------------- generic tabs

  /** @return {Object[]} one {header: string} object per non-blank data row ('' for empty cells); new objects. */
  function readTab(tab) {
    var table = readTable_(tab);
    return table.items.map(function (it) { return rowToObject_(table.schema, table.raw[it.index]); });
  }

  /** Rewrites all data rows of `tab` (schema column order). */
  function writeTab(tab, objects) {
    var table = readTable_(tab);
    commit_(table, (objects || []).map(function (o) { return objectToRow_(table.schema, o || {}); }));
  }

  // ------------------------------------------------------------------------------- months

  /**
   * First-column values of a tab (data rows only: col[i] is data row i), with getLastRow + one narrow
   * getValues, or taken from the memoized table. Memoized; shared (do not change it).
   */
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
        // Another execution deleted a row between getLastRow and the read, in a sheet without blank
        // rows: the range ran past its end. ONE getValues of the whole tab instead (memoized).
        m.col = readTable_(tab).raw.map(function (r) { return r[0]; });
      }
    }
    return m.col;
  }

  /**
   * Months present in ImportLog ∪ Postes ∪ Applications, ascending and unique. Logs
   * {stage:'listMonths', ms, <tab>: ms, ..., rows, months} (Perf; `ms` includes a first ensure()).
   */
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

  /** Months that have at least one row in `tab` (column A), ascending, valid months only. */
  function tabMonths(tab) {
    var seen = {};
    firstColumn_(tab).forEach(function (m) { seen[m] = true; });
    return Core.sortMonths(Object.keys(seen));
  }

  /** The span of `table` (a full read) for `month`: the whole table, items = the month's rows. */
  function spanOfTable_(table, month) {
    var items = [];
    table.items.forEach(function (it) {
      if (table.raw[it.index][0] === month) items.push({ index: it.index, row: table.raw[it.index] });
    });
    return { sheet: table.sheet, schema: table.schema, base: 0, raw: table.raw, items: items };
  }

  /**
   * The rows of `month` in a tab whose column A is the month (entities, Référentiel), read without
   * the other months: column A (firstColumn_, usually already read by listMonths in the same call)
   * gives the first and the last row of the month, and ONE getValues reads that block plus one row on
   * each side of it (when the sheet has that row). Rows of other months inside the block (a record
   * appended by appendEntityRow after a later month) are skipped by the row[0] === month filter.
   * Reads happen outside the lock, so another execution may have moved rows since column A was read:
   * when the block no longer matches column A, when a row on either side of it is now `month` (the
   * month grew, or moved, past the block: its records are no longer all inside it), when the sheet
   * lost rows (the block would run past its end), or, for a block ending on the last row of the sheet
   * (no row below it to check), when the sheet gained rows while the block was read, the whole tab is
   * read instead. Memoized; shared.
   * @return {{sheet, schema, base:number, raw:string[][], items:{index:number, row:string[]}[], partial?:true}}
   *   raw = the rows of the block (raw[i] is data row base + i, i.e. sheet row base + i + 2);
   *   items = the rows of `month`, index = data row index (as in readSheet_).
   */
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
      // Below the last row column A had, the sheet itself tells whether a row exists now (data row
      // index = sheet row - 2); fewer rows than the block means rows were deleted meanwhile.
      var hi = last + 1 < col.length ? last + 1 : Math.min(last + 1, sheet.getMaxRows() - 2);
      if (hi < last) return wholeTab();
      var rows;
      try {
        rows = readRows_(tab, lo, hi - lo + 1);
      } catch (e) {
        return wholeTab(); // the sheet shrank between getMaxRows and the read: same as above
      }
      // No row below the block was read (it ends on the last row of the sheet): a write that grew the
      // sheet between getMaxRows and the read (ensureSize_ inserts rows) may have pushed the month's
      // last records below it, which the checks below cannot see. One more getMaxRows tells.
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

  /** @return {Object[]} records of `month` (new objects), sorted by _order. Reads that month only (monthSpan_). */
  function readEntityMonth(tab, month) {
    return sortByOrder_(monthSpan_(tab, month).items.map(function (it) { return entityRecord_(it.row); }));
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
    var span = monthSpan_(tab, month);
    var indexById = Object.create(null); // id -> position in span.raw
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

  /**
   * Appends a record to `month` with a new _id and _order = max + 1, after the last used row (the
   * month's rows are then no longer contiguous: monthSpan_ and the next replaceEntityMonth handle it).
   */
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
    if (key === '') return false;
    var span = monthSpan_(tab, month);
    for (var k = 0; k < span.items.length; k++) {
      if (span.items[k].row[1] !== key) continue;
      deleteSheetRow_(span.sheet, span.items[k].index + 2);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------- référentiel
  // Rows: ['_month','category','position','value'].

  /**
   * @return {Object<string, string[]>} categories in stored order, values ordered by position. Reads
   *   that month only (monthSpan_).
   */
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

  /** ImportLog row (schema order, strings) -> entry, json columns parsed. */
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

  /** Entry of the last row of `rows` whose month is `month`, or null. */
  function lastEntryIn_(rows, month) {
    for (var i = rows.length - 1; i >= 0; i--) if (rows[i][0] === month) return importLogEntry_(rows[i]);
    return null;
  }

  /** @return {Object[]} every ImportLog entry in insertion order, json columns parsed (whole tab). */
  function getImportLog() {
    var table = readTable_(Config.TABS.importLog);
    return table.items.map(function (it) { return importLogEntry_(table.raw[it.index]); });
  }

  /**
   * The `limit` latest ImportLog entries, newest first, read from the bottom of the tab: the last
   * `limit` rows, then blocks twice as large while blank rows left fewer entries than wanted. A block
   * that runs past the end of the sheet (rows deleted by hand since getLastRow) falls back to the whole tab.
   */
  function recentImportLog(limit) {
    var tab = Config.TABS.importLog;
    var n = Math.max(0, Math.floor(Number(limit) || 0));
    var end = sheet_(tab).getLastRow() - 1; // data rows above `end` are still unread
    var chunk = n;
    var out = [];
    while (out.length < n && end > 0) {
      var k = Math.min(chunk, end);
      var rows;
      try {
        rows = readRows_(tab, end - k, k);
      } catch (e) {
        rows = readTable_(tab).raw; // the sheet lost rows: start over on the whole tab (last pass)
        out = [];
        end = 0;
      }
      for (var i = rows.length - 1; i >= 0 && out.length < n; i--) {
        if (!isEmptyRow_(rows[i])) out.push(importLogEntry_(rows[i]));
      }
      end -= k;
      chunk *= 2;
    }
    return out;
  }

  /** @param {{month, imported_at?, source_id, counts, postes_headers, apps_headers, warnings, changes?}} entry */
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

  /**
   * @return {Object|null} the last ImportLog entry for `month`, parsing that row only. Without a
   *   memoized column A: the last IMPORT_LOG_TAIL rows first (the latest entry of the current month is
   *   normally there). Otherwise, or when the tail does not have it: column A (memoized, usually read
   *   by listMonths in the same call) scanned from the bottom, then that one row. A row that no longer
   *   matches column A, or is no longer in the sheet (rows deleted by hand in between), falls back to
   *   reading the whole tab.
   */
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
        tail = null; // rows deleted between getLastRow and the read: column A below (same fallback)
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
      row = null; // past the end of a sheet that lost rows meanwhile: read in full below
    }
    if (row && row[0] === month) return importLogEntry_(row);
    delete memo_[tab];
    return lastEntryIn_(readTable_(tab).raw, month);
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
