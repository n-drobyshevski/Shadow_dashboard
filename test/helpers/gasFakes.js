'use strict';
/**
 * In-memory fakes of the Google Apps Script services used by the server code:
 * SpreadsheetApp, PropertiesService, LockService, Utilities, HtmlService, Logger and console.
 *
 * The fakes mimic the Sheets behaviours that matter for correctness:
 *   - range bounds are checked against the sheet's max rows/columns (GAS throws, it does not grow);
 *   - setValues() validates the data dimensions exactly like GAS;
 *   - a cell with the plain-text number format '@' stores a string VERBATIM: nothing is parsed, so
 *     '=1+1' stays text and a leading apostrophe is KEPT as a literal character (real Sheets only
 *     treats "'" as the hidden "force text" prefix in cells that are not formatted as plain text);
 *   - in any other cell, a string starting with "'" is stored WITHOUT the apostrophe (forced text);
 *   - in any other cell, a string starting with "=" is a formula: it is recorded in __state.formulas
 *     (tests assert that nothing ever lands there) and stored as the literal string;
 *   - in any other cell, strings that look like numbers / dates / booleans / percentages are
 *     auto-converted (this is how tests detect missing '@' formatting).
 *
 * Fault injection (real Apps Script calls fail transiently: "Service Spreadsheets failed while
 * accessing document…", timeouts): env.__fault({method, id?, sheet?, times?, message?}) makes the
 * next `times` (default 1, Infinity allowed) matching calls throw. Supported methods: 'openById'
 * (matched on `id`), 'setValues' / 'setValue' (matched on the spreadsheet `id` and the target `sheet`
 * name), 'create'.
 * env.__clearFaults() removes them. Utilities.sleep(ms) is a no-op recorded in __state.sleeps.
 *
 * Usage:
 *   const { createGasEnv } = require('./gasFakes');
 *   const env = createGasEnv({ sources: [buildSourceSpreadsheet('2026-05')] });
 *   env.SpreadsheetApp.openById(SOURCE_ID).getSheetByName('Suivi des postes') ...
 *
 * Instrumentation lives in env.__state:
 *   spreadsheets (Map id -> Spreadsheet), formulas [{spreadsheetId, sheet, a1, formula}],
 *   writes [{sheet, a1, rows, cols, plainText}], calls {methodName: count}, flushes,
 *   cells {getValues|getValue|getDisplayValues|getFormulas: cells read},
 *   reads [{spreadsheetId, sheet, method, a1, cells, lockHeld}] (one entry per range read, in order:
 *   which rows / columns a flow reads, and whether the script lock was held at that moment),
 *   lock {acquired, released, timeouts, held}, logs [], console [], lockTimeout (mutable),
 *   opened [ids passed to openById, in order], propertyWrites [keys written by setProperty / setProperties].
 * state.onWaitLock = fn runs fn ONCE, at the start of the next waitLock / tryLock, before the lock is
 * taken: a test simulates another execution that takes the lock first (e.g. a save landing while an
 * hourly sync reads the source outside the lock).
 * calls also counts the Properties reads / writes (getProperty, getProperties, getKeys, setProperty,
 * setProperties, deleteProperty) and the CacheService ones (cacheGet, cacheGetAll, cachePut, cachePutAll,
 * cacheRemove; entries expire with their TTL on the Date.now() clock, state.cacheFaults makes them throw).
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const DEFAULT_SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const DEFAULT_ROWS = 1000;
const DEFAULT_COLS = 26;

/** Cross-realm Date check (values may come from a vm context). */
function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function copyCell(v) {
  return isDate(v) ? new Date(v.getTime()) : v;
}

/** 1-based column number -> letters ('A', 'Z', 'AA'...). */
function colLetters(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function a1(row, col, numRows, numCols) {
  const start = colLetters(col) + row;
  if (numRows === 1 && numCols === 1) return start;
  return start + ':' + colLetters(col + numCols - 1) + (row + numRows - 1);
}

/** Parses 'A1' / 'B2:D10' -> {row, col, numRows, numCols}. */
function parseA1(ref) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(String(ref).trim());
  if (!m) throw new Error('Range not found');
  const colNum = (letters) => letters.toUpperCase().split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
  const row = Number(m[2]);
  const col = colNum(m[1]);
  if (!m[3]) return { row, col, numRows: 1, numCols: 1 };
  const row2 = Number(m[4]);
  const col2 = colNum(m[3]);
  return { row: Math.min(row, row2), col: Math.min(col, col2), numRows: Math.abs(row2 - row) + 1, numCols: Math.abs(col2 - col) + 1 };
}

/**
 * Utilities.formatDate replacement: supports yyyy, MM, dd, HH, mm, ss and '...' quoted literals,
 * computed in the requested IANA time zone through Intl.
 */
function formatDate(date, tz, pattern) {
  if (!isDate(date) || Number.isNaN(date.getTime())) throw new Error('Invalid argument: date');
  // Like Apps Script: a non-string / empty time zone is refused (« Argument incorrect : timeZone »).
  if (typeof tz !== 'string' || !tz) throw new Error('Invalid argument: timeZone. Should be of type: String');
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const map = { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second };
  return String(pattern).replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g, (tok, lit) => (lit !== undefined ? lit : map[tok]));
}

/**
 * Sheets-like auto conversion of a typed string (only applied when the target cell is NOT '@').
 * Returns the converted value or the original string.
 */
function autoConvert(s) {
  const t = s.trim();
  if (t === '') return s;
  let m;
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);                      // '42', '0042', '-1.5'
  if ((m = /^([-+]?\d+(?:[.,]\d+)?)\s*%$/.exec(t))) return Number(m[1].replace(',', '.')) / 100;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(t)) && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return new Date(Number(m[1]), Number(m[2]) - 1, 1);                     // '2026-05'
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t))) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) {
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));         // '15/03/2025' (fr locale)
  }
  return s;
}

function createGasEnv(options) {
  const opts = options || {};
  const sources = opts.sources || [];
  const timeZone = opts.timeZone || 'Europe/Paris';
  const srcDir = opts.srcDir || DEFAULT_SRC_DIR;
  const echoConsole = !!opts.echoConsole;

  const state = {
    spreadsheets: new Map(),
    formulas: [],
    writes: [],
    calls: {},
    cells: {},
    flushes: 0,
    lock: { acquired: 0, released: 0, timeouts: 0, held: false },
    faults: [],
    sleeps: [],
    lockTimeout: !!opts.lockTimeout,
    onWaitLock: null,
    reads: [],
    opened: [],
    properties: {},
    propertyWrites: [],
    logs: [],
    console: [],
    evalContext: null,   // set by gasSandbox so template scriptlets evaluate in the GAS globals
  };
  const count = (name) => { state.calls[name] = (state.calls[name] || 0) + 1; };
  const countCells = (name, n) => { state.cells[name] = (state.cells[name] || 0) + n; };
  /** Counts one range read (cells + per-range log entry). */
  const recordRead = (range, method) => {
    const cells = range._nr * range._nc;
    countCells(method, cells);
    state.reads.push({ spreadsheetId: range._sheet._ss._id, sheet: range._sheet._name, method,
      a1: range.getA1Notation(), cells, lockHeld: state.lock.held });
  };

  /** Throws when an injected fault matches this call (see "Fault injection" above). */
  function maybeFail(method, info) {
    const i = state.faults.findIndex((f) => f.method === method && f.times > 0 &&
      (f.id === undefined || f.id === info.id) && (f.sheet === undefined || f.sheet === info.sheet));
    if (i < 0) return;
    const f = state.faults[i];
    f.times--;
    if (f.times <= 0) state.faults.splice(i, 1);
    throw new Error(f.message || 'Exception: Service Spreadsheets failed while accessing document with id ' + (info.id || '') + '.');
  }
  function addFault(def) {
    state.faults.push(Object.assign({ times: 1 }, def));
  }

  let nextSheetId = 1;

  // ------------------------------------------------------------------------------------ Sheet
  class Sheet {
    constructor(ss, name, rows, cols) {
      this._ss = ss;
      this._name = name;
      this._id = nextSheetId++;
      this._maxRows = rows || DEFAULT_ROWS;
      this._maxCols = cols || DEFAULT_COLS;
      this._vals = [];   // sparse 2D array, 0-based
      this._fmts = [];   // number formats per cell
      this._disp = [];   // display overrides (fixtures only)
      this._frozenRows = 0;
    }

    // -- internal cell helpers
    _get(grid, r, c) { const row = grid[r]; return row ? row[c] : undefined; }
    _set(grid, r, c, v) { if (!grid[r]) grid[r] = []; grid[r][c] = v; }
    _value(r, c) { const v = this._get(this._vals, r, c); return v === undefined || v === null ? '' : v; }
    _format(r, c) { return this._get(this._fmts, r, c); }

    /** Writes one cell applying the Sheets typing rules described at the top of the file. */
    _write(r, c, v) {
      count('_cellWrite');
      if (this._disp[r]) delete this._disp[r][c];
      if (v === null || v === undefined) { this._set(this._vals, r, c, ''); return; }
      if (typeof v === 'string') {
        if (this._format(r, c) === '@') { this._set(this._vals, r, c, v); return; } // plain text: verbatim
        if (v.charAt(0) === "'") { this._set(this._vals, r, c, v.slice(1)); return; }
        if (v.charAt(0) === '=') {
          state.formulas.push({ spreadsheetId: this._ss._id, sheet: this._name, a1: a1(r + 1, c + 1, 1, 1), formula: v });
          this._set(this._vals, r, c, v);
          return;
        }
        this._set(this._vals, r, c, autoConvert(v));
        return;
      }
      if (isDate(v)) { this._set(this._vals, r, c, new Date(v.getTime())); return; }
      if (typeof v === 'number' || typeof v === 'boolean') { this._set(this._vals, r, c, v); return; }
      this._set(this._vals, r, c, String(v));
    }

    _contentRows() {
      let last = 0;
      for (let r = 0; r < this._vals.length; r++) {
        const row = this._vals[r];
        if (row && row.some((v) => v !== '' && v !== undefined && v !== null)) last = r + 1;
      }
      return last;
    }

    _contentCols() {
      let last = 0;
      for (const row of this._vals) {
        if (!row) continue;
        for (let c = row.length - 1; c >= last; c--) {
          const v = row[c];
          if (v !== '' && v !== undefined && v !== null) { last = c + 1; break; }
        }
      }
      return last;
    }

    // -- public API
    getName() { return this._name; }
    setName(name) {
      const other = this._ss._sheets.find((s) => s !== this && s._name === name);
      if (other) throw new Error('A sheet with the name "' + name + '" already exists. Please enter another name.');
      this._name = String(name);
      return this;
    }
    getSheetId() { return this._id; }
    getParent() { return this._ss; }
    getLastRow() { count('getLastRow'); return this._contentRows(); }
    getLastColumn() { count('getLastColumn'); return this._contentCols(); }
    getMaxRows() { return this._maxRows; }
    getMaxColumns() { return this._maxCols; }
    getFrozenRows() { return this._frozenRows; }
    setFrozenRows(n) { count('setFrozenRows'); this._frozenRows = n; return this; }

    getDataRange() {
      count('getDataRange');
      return this.getRange(1, 1, Math.max(this._contentRows(), 1), Math.max(this._contentCols(), 1));
    }

    getRange(row, col, numRows, numCols) {
      count('getRange');
      if (typeof row === 'string') {
        const p = parseA1(row);
        return this.getRange(p.row, p.col, p.numRows, p.numCols);
      }
      const nr = numRows === undefined ? 1 : numRows;
      const nc = numCols === undefined ? 1 : numCols;
      if (![row, col, nr, nc].every((n) => Number.isInteger(n))) throw new Error('Invalid argument: range coordinates must be integers');
      if (row < 1 || col < 1) throw new Error('The starting row/column of the range is too small.');
      if (nr < 1) throw new Error('The number of rows in the range must be at least 1.');
      if (nc < 1) throw new Error('The number of columns in the range must be at least 1.');
      if (row + nr - 1 > this._maxRows || col + nc - 1 > this._maxCols) {
        throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      }
      return new Range(this, row, col, nr, nc);
    }

    clear() { count('clear'); this._vals = []; this._fmts = []; this._disp = []; return this; }
    clearContents() { count('clearContents'); this._vals = []; this._disp = []; return this; }

    appendRow(values) {
      count('appendRow');
      const r = this._contentRows();
      if (r + 1 > this._maxRows) this._maxRows = r + 1;
      if (values.length > this._maxCols) this._maxCols = values.length;
      values.forEach((v, c) => this._write(r, c, v));
      return this;
    }

    deleteRow(rowPosition) { return this.deleteRows(rowPosition, 1); }
    deleteRows(rowPosition, howMany) {
      count('deleteRows');
      if (rowPosition < 1 || howMany < 1 || rowPosition + howMany - 1 > this._maxRows) {
        throw new Error('Those rows are out of bounds.');
      }
      if (this._maxRows - howMany <= this._frozenRows) throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
      for (const grid of [this._vals, this._fmts, this._disp]) grid.splice(rowPosition - 1, howMany);
      this._maxRows -= howMany;
      return this;
    }

    insertRowsAfter(afterPosition, howMany) {
      count('insertRowsAfter');
      for (const grid of [this._vals, this._fmts, this._disp]) {
        if (grid.length > afterPosition) grid.splice(afterPosition, 0, ...new Array(howMany).fill(undefined));
      }
      this._maxRows += howMany;
      return this;
    }

    insertColumnsAfter(afterPosition, howMany) {
      count('insertColumnsAfter');
      for (const grid of [this._vals, this._fmts, this._disp]) {
        for (const row of grid) if (row && row.length > afterPosition) row.splice(afterPosition, 0, ...new Array(howMany).fill(undefined));
      }
      this._maxCols += howMany;
      return this;
    }
  }

  // ------------------------------------------------------------------------------------ Range
  class Range {
    constructor(sheet, row, col, numRows, numCols) {
      this._sheet = sheet;
      this._row = row;
      this._col = col;
      this._nr = numRows;
      this._nc = numCols;
    }

    _each(fn) {
      const out = [];
      for (let i = 0; i < this._nr; i++) {
        const row = [];
        for (let j = 0; j < this._nc; j++) row.push(fn(this._row - 1 + i, this._col - 1 + j, i, j));
        out.push(row);
      }
      return out;
    }

    _checkDims(values, what) {
      if (!Array.isArray(values)) throw new Error('The parameters (' + typeof values + ') don\'t match the method signature for SpreadsheetApp.Range.' + what + '.');
      if (values.length !== this._nr) {
        throw new Error('The number of rows in the data does not match the number of rows in the range. The data has ' + values.length + ' but the range has ' + this._nr + '.');
      }
      for (const row of values) {
        if (!Array.isArray(row)) throw new Error('The parameters don\'t match the method signature for SpreadsheetApp.Range.' + what + '.');
        if (row.length !== this._nc) {
          throw new Error('The number of columns in the data does not match the number of columns in the range. The data has ' + row.length + ' but the range has ' + this._nc + '.');
        }
      }
    }

    getSheet() { return this._sheet; }
    getRow() { return this._row; }
    getColumn() { return this._col; }
    getLastRow() { return this._row + this._nr - 1; }
    getLastColumn() { return this._col + this._nc - 1; }
    getNumRows() { return this._nr; }
    getNumColumns() { return this._nc; }
    getA1Notation() { return a1(this._row, this._col, this._nr, this._nc); }

    getValues() {
      count('getValues');
      recordRead(this, 'getValues');
      return this._each((r, c) => copyCell(this._sheet._value(r, c)));
    }
    getValue() { count('getValue'); recordRead(this, 'getValue'); return copyCell(this._sheet._value(this._row - 1, this._col - 1)); }

    getDisplayValues() {
      count('getDisplayValues');
      recordRead(this, 'getDisplayValues');
      const tz = this._sheet._ss.getSpreadsheetTimeZone() || 'Europe/Paris';
      return this._each((r, c) => {
        const d = this._sheet._get(this._sheet._disp, r, c);
        if (d !== undefined) return String(d);
        const v = this._sheet._value(r, c);
        if (isDate(v)) return formatDate(v, tz, 'dd/MM/yyyy');
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        return String(v);
      });
    }

    setValues(values) {
      count('setValues');
      this._checkDims(values, 'setValues');
      maybeFail('setValues', { id: this._sheet._ss._id, sheet: this._sheet._name });
      let plainText = true;
      this._each((r, c) => { if (this._sheet._format(r, c) !== '@') plainText = false; });
      state.writes.push({ spreadsheetId: this._sheet._ss._id, sheet: this._sheet._name, a1: this.getA1Notation(), rows: this._nr, cols: this._nc, plainText });
      this._each((r, c, i, j) => this._sheet._write(r, c, values[i][j]));
      return this;
    }

    setValue(value) {
      count('setValue');
      maybeFail('setValue', { id: this._sheet._ss._id, sheet: this._sheet._name });
      const r = this._row - 1;
      const c = this._col - 1;
      state.writes.push({ spreadsheetId: this._sheet._ss._id, sheet: this._sheet._name, a1: a1(this._row, this._col, 1, 1), rows: 1, cols: 1, plainText: this._sheet._format(r, c) === '@' });
      this._sheet._write(r, c, value);
      return this;
    }

    /** Formulas: a value that is a string starting with '=' (fixtures store formulas that way). */
    getFormulas() {
      count('getFormulas');
      recordRead(this, 'getFormulas');
      return this._each((r, c) => { const v = this._sheet._value(r, c); return typeof v === 'string' && v.charAt(0) === '=' ? v : ''; });
    }
    getFormula() { return this.getFormulas()[0][0]; }

    /** Copies values (formulas included, verbatim) to the top-left of `target`. */
    copyTo(target) {
      count('copyTo');
      this._each((r, c, i, j) => target._sheet._set(target._sheet._vals, target._row - 1 + i, target._col - 1 + j, copyCell(this._sheet._value(r, c))));
      state.copies = (state.copies || 0) + 1;
      return this;
    }

    setNumberFormat(fmt) {
      count('setNumberFormat');
      this._each((r, c) => this._sheet._set(this._sheet._fmts, r, c, String(fmt)));
      return this;
    }

    setNumberFormats(formats) {
      count('setNumberFormats');
      this._checkDims(formats, 'setNumberFormats');
      this._each((r, c, i, j) => this._sheet._set(this._sheet._fmts, r, c, String(formats[i][j])));
      return this;
    }

    getNumberFormat() {
      const f = this._sheet._format(this._row - 1, this._col - 1);
      return f === undefined ? 'General' : f;
    }
    getNumberFormats() {
      return this._each((r, c) => { const f = this._sheet._format(r, c); return f === undefined ? 'General' : f; });
    }

    clearContent() {
      count('clearContent');
      this._each((r, c) => {
        if (this._sheet._vals[r]) this._sheet._vals[r][c] = '';
        if (this._sheet._disp[r]) delete this._sheet._disp[r][c];
      });
      return this;
    }

    clear() {
      count('clear');
      this.clearContent();
      this._each((r, c) => { if (this._sheet._fmts[r]) delete this._sheet._fmts[r][c]; });
      return this;
    }
  }

  // ------------------------------------------------------------------------------ Spreadsheet
  class Spreadsheet {
    constructor(id, name, tz) {
      this._id = id;
      this._name = name;
      // A fixture may set timeZone: null (real files converted from Excel can report no time zone).
      this._tz = tz === undefined ? timeZone : tz;
      this._sheets = [];
    }
    getId() { return this._id; }
    getName() { return this._name; }
    rename(name) { this._name = String(name); }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this._id + '/edit'; }
    getSpreadsheetTimeZone() { return this._tz; }
    getSheets() { count('getSheets'); return this._sheets.slice(); }
    getSheetByName(name) { count('getSheetByName'); return this._sheets.find((s) => s._name === name) || null; }
    insertSheet(name) {
      count('insertSheet');
      let sheetName = name;
      if (sheetName === undefined) {
        let i = this._sheets.length + 1;
        while (this._sheets.some((s) => s._name === 'Sheet' + i)) i++;
        sheetName = 'Sheet' + i;
      }
      sheetName = String(sheetName);
      if (this._sheets.some((s) => s._name === sheetName)) {
        throw new Error('A sheet with the name "' + sheetName + '" already exists. Please enter another name.');
      }
      const sh = new Sheet(this, sheetName);
      this._sheets.push(sh);
      return sh;
    }
    deleteSheet(sheet) {
      count('deleteSheet');
      const i = this._sheets.indexOf(sheet);
      if (i < 0) throw new Error('Sheet not found');
      if (this._sheets.length === 1) throw new Error('You can\'t remove all the sheets in a document.');
      this._sheets.splice(i, 1);
    }
  }

  function newId() {
    return '1' + crypto.randomBytes(33).toString('base64url').slice(0, 43);
  }

  /** Loads a fixture definition {id, name, timeZone, sheets:{name:{values, display}}} verbatim. */
  function addSpreadsheet(def) {
    const ss = new Spreadsheet(def.id || newId(), def.name || 'Untitled spreadsheet', def.timeZone);
    for (const [name, tab] of Object.entries(def.sheets || {})) {
      const values = tab.values || [];
      const width = values.reduce((w, r) => Math.max(w, r.length), 0);
      const sh = new Sheet(ss, name, Math.max(values.length, 1), Math.max(width, 1));
      values.forEach((row, r) => row.forEach((v, c) => sh._set(sh._vals, r, c, copyCell(v))));
      (tab.display || []).forEach((row, r) => row.forEach((d, c) => sh._set(sh._disp, r, c, d)));
      if (tab.frozenRows) sh._frozenRows = tab.frozenRows;
      ss._sheets.push(sh);
    }
    state.spreadsheets.set(ss._id, ss);
    return ss;
  }
  sources.forEach(addSpreadsheet);

  // ------------------------------------------------------------------------------- Services
  const SpreadsheetApp = {
    openById(id) {
      count('openById');
      state.opened.push(String(id));
      maybeFail('openById', { id: String(id) });
      const ss = state.spreadsheets.get(String(id));
      if (!ss) throw new Error('Exception: Requested entity was not found.');
      return ss;
    },
    openByUrl(url) {
      const m = /\/spreadsheets\/d\/([A-Za-z0-9-_]+)/.exec(String(url));
      if (!m) throw new Error('Exception: Invalid argument: url');
      return SpreadsheetApp.openById(m[1]);
    },
    create(name, rows, cols) {
      count('create');
      maybeFail('create', {});
      const ss = new Spreadsheet(newId(), String(name), timeZone);
      ss._sheets.push(new Sheet(ss, 'Sheet1', rows || DEFAULT_ROWS, cols || DEFAULT_COLS));
      state.spreadsheets.set(ss._id, ss);
      return ss;
    },
    flush() { count('flush'); state.flushes++; },
    getActiveSpreadsheet() { return null; },
  };

  function makePropertyStore(store) {
    const api = {
      getProperty(key) { count('getProperty'); return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
      setProperty(key, value) { count('setProperty'); state.propertyWrites.push(String(key)); store[key] = String(value); return api; },
      setProperties(props, deleteAllOthers) {
        count('setProperties');
        state.propertyWrites.push(...Object.keys(props || {}));
        if (deleteAllOthers) for (const k of Object.keys(store)) delete store[k];
        for (const [k, v] of Object.entries(props || {})) store[k] = String(v);
        return api;
      },
      deleteProperty(key) { count('deleteProperty'); delete store[key]; return api; },
      deleteAllProperties() { for (const k of Object.keys(store)) delete store[k]; return api; },
      getProperties() { count('getProperties'); return Object.assign({}, store); },
      getKeys() { count('getKeys'); return Object.keys(store); },
    };
    return api;
  }
  const scriptProps = makePropertyStore(state.properties);
  const userProps = makePropertyStore({});
  const PropertiesService = {
    getScriptProperties() { return scriptProps; },
    getUserProperties() { return userProps; },
  };

  /** Runs the one-shot state.onWaitLock hook (another execution taking the lock first). */
  function runWaitLockHook() {
    const hook = state.onWaitLock;
    if (typeof hook !== 'function') return;
    state.onWaitLock = null;
    hook();
  }
  const lock = {
    waitLock(timeoutMs) {
      count('waitLock');
      runWaitLockHook();
      if (state.lockTimeout) {
        state.lock.timeouts++;
        throw new Error('Lock timeout: another process was holding the lock for too long.');
      }
      state.lock.acquired++;
      state.lock.held = true;
      state.lock.lastTimeout = timeoutMs;
    },
    tryLock(timeoutMs) {
      count('tryLock');
      runWaitLockHook();
      if (state.lockTimeout) { state.lock.timeouts++; return false; }
      state.lock.acquired++;
      state.lock.held = true;
      state.lock.lastTimeout = timeoutMs;
      return true;
    },
    releaseLock() {
      count('releaseLock');
      if (state.lock.held) { state.lock.released++; state.lock.held = false; }
    },
    hasLock() { return state.lock.held; },
  };
  const LockService = {
    getScriptLock() { return lock; },
    getUserLock() { return lock; },
    getDocumentLock() { return null; },
  };

  // ------------------------------------------------------------------------------ Session
  // Deployer = effective user; visitor = active user ('' = identity not passed, e.g. another domain).
  state.session = { owner: opts.ownerEmail || 'owner@decathlon.com', active: undefined };
  const Session = {
    getEffectiveUser() { return { getEmail() { return state.session.owner; } }; },
    getActiveUser() {
      return { getEmail() { return state.session.active === undefined ? state.session.owner : state.session.active; } };
    },
  };

  // ------------------------------------------------------------------------------ GroupsApp
  // state.groups: { 'grp@x': { members: ['a@x'], children: ['sub@x'], hidden?: true } }
  // hidden = members not visible to the deployer (hasUser / getGroups throw).
  state.groups = {};
  state.groupCalls = 0;
  function makeGroup(email) {
    const def = state.groups[email];
    return {
      getEmail() { return email; },
      hasUser(user) {
        state.groupCalls++;
        if (def.hidden) throw new Error('Exception: You do not have permission to view the member list for the group: ' + email);
        return def.members.map((m) => m.toLowerCase()).includes(String(user).toLowerCase());
      },
      getGroups() {
        if (def.hidden) throw new Error('Exception: You do not have permission to view the member list.');
        return (def.children || []).filter((c) => state.groups[c]).map(makeGroup);
      },
    };
  }
  const GroupsApp = {
    getGroupByEmail(email) {
      const key = String(email).toLowerCase();
      if (!state.groups[key]) throw new Error('Exception: Invalid argument: ' + email);
      return makeGroup(key);
    },
  };

  // ------------------------------------------------------------------------------ CacheService
  // state.cache: key -> value (string); state.cacheExpiry: key -> expiry (ms, Date.now() clock, so a test
  // that moves Date.now moves the cache clock too). TTL in seconds as in Apps Script: default 600, at
  // most 21600. state.cacheFaults.read / .write = true makes the reads (get, getAll) / writes (put,
  // putAll, remove) throw, like an unavailable CacheService.
  state.cache = new Map();
  state.cacheExpiry = new Map();
  state.cacheFaults = { read: false, write: false };
  function cacheLive(k) {
    if (!state.cache.has(k)) return false;
    if (state.cacheExpiry.get(k) <= Date.now()) { state.cache.delete(k); state.cacheExpiry.delete(k); return false; }
    return true;
  }
  function cacheSet(k, v, ttl) {
    const s = ttl === undefined || ttl === null ? 600 : Number(ttl);
    if (!(s >= 1 && s <= 21600)) throw new Error('Exception: Argument too large / invalid: expirationInSeconds ' + ttl);
    state.cache.set(k, String(v));
    state.cacheExpiry.set(k, Date.now() + s * 1000);
  }
  function cacheFault(kind) {
    if (state.cacheFaults[kind]) throw new Error('Exception: Service CacheService failed (' + kind + ')');
  }
  const scriptCache = {
    get(k) { count('cacheGet'); cacheFault('read'); return cacheLive(k) ? state.cache.get(k) : null; },
    getAll(keys) {
      count('cacheGetAll'); cacheFault('read');
      const out = {};
      for (const k of keys) if (cacheLive(k)) out[k] = state.cache.get(k);
      return out;
    },
    put(k, v, ttl) { count('cachePut'); cacheFault('write'); cacheSet(k, v, ttl); },
    putAll(values, ttl) { count('cachePutAll'); cacheFault('write'); for (const [k, v] of Object.entries(values)) cacheSet(k, v, ttl); },
    remove(k) { count('cacheRemove'); cacheFault('write'); state.cache.delete(k); state.cacheExpiry.delete(k); },
  };
  const CacheService = { getScriptCache() { return scriptCache; } };

  const Utilities = {
    formatDate,
    getUuid() { return crypto.randomUUID(); },
    sleep(ms) { state.sleeps.push(ms); },
  };

  // ------------------------------------------------------------------------------ HtmlService
  function readHtml(name) {
    const file = path.join(srcDir, String(name).replace(/\.html$/, '') + '.html');
    if (!fs.existsSync(file)) throw new Error('Exception: No HTML file named ' + name + ' was found.');
    return fs.readFileSync(file, 'utf8');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function makeHtmlOutput(content) {
    let html = content;
    const out = {
      _title: '',
      _metaTags: [],
      _xFrameOptionsMode: null,
      getContent() { return html; },
      setContent(c) { html = String(c); return out; },
      append(c) { html += String(c); return out; },
      setTitle(t) { out._title = String(t); return out; },
      getTitle() { return out._title; },
      addMetaTag(name, contentValue) { out._metaTags.push({ name, content: contentValue }); return out; },
      getMetaTags() { return out._metaTags.map((m) => ({ getName: () => m.name, getContent: () => m.content })); },
      setXFrameOptionsMode(mode) { out._xFrameOptionsMode = mode; return out; },
      setSandboxMode() { return out; },
      _faviconUrl: null,
      setFaviconUrl(u) { out._faviconUrl = String(u); return out; },
      setWidth() { return out; },
      setHeight() { return out; },
    };
    return out;
  }

  /** Evaluates a scriptlet expression in the GAS globals (+ template variables, like GAS). */
  function evalScriptlet(expr, vars) {
    const ctx = state.evalContext;
    if (ctx) {
      const fn = vm.runInContext('(function (__vars) { with (__vars) { return (' + expr + '\n); } })', ctx);
      return fn(vars);
    }
    // eslint-disable-next-line no-new-func
    return new Function('__vars', 'with (__vars) { return (' + expr + '\n); }')(vars);
  }

  function makeTemplate(source) {
    const tpl = {
      getRawContent() { return source; },
      evaluate() {
        const vars = {};
        for (const k of Object.keys(tpl)) if (typeof tpl[k] !== 'function') vars[k] = tpl[k];
        const html = source.replace(/<\?(!=|=)?([\s\S]*?)\?>/g, (whole, kind, expr) => {
          if (!kind) throw new Error('Unsupported scriptlet (only <?!= ?> and <?= ?> are supported): ' + whole);
          const v = evalScriptlet(expr.trim(), vars);
          const s = v === undefined || v === null ? '' : String(v);
          return kind === '!=' ? s : escapeHtml(s);
        });
        return makeHtmlOutput(html);
      },
    };
    return tpl;
  }

  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    SandboxMode: { IFRAME: 'IFRAME', NATIVE: 'NATIVE', EMULATED: 'EMULATED' },
    createTemplateFromFile(name) { count('createTemplateFromFile'); return makeTemplate(readHtml(name)); },
    createTemplate(html) { return makeTemplate(String(html)); },
    createHtmlOutputFromFile(name) { count('createHtmlOutputFromFile'); return makeHtmlOutput(readHtml(name)); },
    createHtmlOutput(html) { return makeHtmlOutput(html === undefined ? '' : String(html)); },
  };

  // ------------------------------------------------------------------------- Logger / console
  const Logger = {
    log(...args) {
      let msg = args[0];
      if (typeof msg === 'string' && args.length > 1) {
        let i = 1;
        msg = msg.replace(/%s/g, () => String(args[i++]));
      }
      state.logs.push(String(msg));
      return Logger;
    },
    getLog() { return state.logs.join('\n'); },
    clear() { state.logs.length = 0; },
  };

  // ------------------------------------------------------------------------------ ScriptApp
  // state.triggers: [{id, handler, everyHours}]; state.scriptAppDenied = true makes every call throw
  // (the deployer has not accepted the script.scriptapp scope yet).
  state.triggers = [];
  state.scriptAppDenied = !!opts.scriptAppDenied;
  let nextTrigger = 1;
  function scriptAppGuard() {
    if (state.scriptAppDenied) throw new Error('Exception: You do not have permission to call ScriptApp.getProjectTriggers.');
  }
  function makeTrigger(t) {
    return { getHandlerFunction() { return t.handler; }, getUniqueId() { return t.id; }, __def: t };
  }
  state.scopeChecks = 0;
  const ScriptApp = {
    AuthMode: { FULL: 'FULL' },
    // The real one ends the execution and shows the consent screen when a scope is missing.
    requireAllScopes(mode) { state.scopeChecks++; if (mode !== 'FULL') throw new Error('Bad AuthMode'); },
    getProjectTriggers() { scriptAppGuard(); return state.triggers.map(makeTrigger); },
    deleteTrigger(trigger) {
      scriptAppGuard();
      const i = state.triggers.findIndex((t) => t.id === trigger.getUniqueId());
      if (i >= 0) state.triggers.splice(i, 1);
    },
    newTrigger(handler) {
      scriptAppGuard();
      const def = { id: 'trig' + (nextTrigger++), handler: String(handler), everyHours: null };
      const time = {
        everyHours(n) { def.everyHours = n; return time; },
        create() { state.triggers.push(def); return makeTrigger(def); },
      };
      return { timeBased() { return time; } };
    },
  };

  const fakeConsole = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    fakeConsole[level] = (...args) => {
      state.console.push({ level, args });
      if (echoConsole) console[level](...args); // eslint-disable-line no-console
    };
  }

  return {
    SpreadsheetApp, PropertiesService, LockService, Utilities, HtmlService, Logger, Session, GroupsApp, CacheService,
    ScriptApp,
    /** Defines Google Groups: {email: {members:[...], children?:[...], hidden?:bool}} (merged). */
    __setGroups(groups) {
      for (const [k, v] of Object.entries(groups)) state.groups[k.toLowerCase()] = v;
    },
    console: fakeConsole,
    /** Sets the visitor's email (undefined = the deployer, '' = identity not passed). */
    __setActiveUser(email) { state.session.active = email; },
    __state: state,
    __addSpreadsheet: addSpreadsheet,
    __fault: addFault,
    __clearFaults() { state.faults.length = 0; },
  };
}

module.exports = { createGasEnv, formatDate, autoConvert, colLetters, parseA1 };
