/**
 * Importer — reads the live source spreadsheet ("ShadowIT_Industry"), snapshots one month into the
 * data spreadsheet, and writes the app's edits of the current month back into the source
 * (docs/API.md §4). Sync.js calls importMonth every hour; nobody imports by hand any more.
 *
 * Reading discipline: per source tab ONE getDataRange(), then getValues() (raw, to detect real Date
 * cells) + getDisplayValues() (what the user sees: '30,4%', 'Oui'...). Date cells are formatted
 * 'dd/MM/yyyy' in the SOURCE spreadsheet's time zone (not the script's), so a date typed as
 * 15/03/2026 in Paris never becomes 14/03/2026. importMonth reads the source before taking the script
 * lock; the write-back reads only the rows it touches (see the write-back section).
 *
 * Load-order safe: the IIFE only defines functions; Config / Core / Store / GAS services are used
 * lazily, inside the functions.
 */
var Importer = (function () {

  // ------------------------------------------------------------------------------- source access

  /** Opens a spreadsheet by id, mapping any failure (bad id, no access) to SOURCE_ERROR. */
  function openById_(id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      console.warn('Importer: cannot open source ' + id + ' (' + (e && e.message) + ')');
      throw Core.makeError('SOURCE_ERROR',
        'Impossible d’ouvrir le classeur source. Vérifiez l’URL et vos droits d’accès.');
    }
  }

  /** The configured source spreadsheet ('' -> NOT_CONFIGURED, open failure -> SOURCE_ERROR). */
  function openSource() {
    var id = Config.get().sourceId;
    if (!id) throw notConfigured_();
    return openById_(id);
  }

  function notConfigured_() {
    return Core.makeError('NOT_CONFIGURED',
      'Aucun classeur source n’est configuré. Renseignez l’URL du Google Sheet source.');
  }

  /** Sheet whose name matches `name` with Core.normKey (case / NBSP / extra spaces tolerant), or null. */
  function findTab(ss, name) {
    var target = Core.normKey(name);
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (Core.normKey(sheets[i].getName()) === target) return sheets[i];
    }
    return null;
  }

  /** {postes, applications, referentiel} -> bool, for the configuration screen. */
  function tabsFound_(ss) {
    var out = {};
    Object.keys(Core.SOURCE_TABS).forEach(function (k) { out[k] = !!findTab(ss, Core.SOURCE_TABS[k]); });
    return out;
  }

  /** One getDataRange(), then raw + display values of the same range. */
  function readGrid_(sheet) {
    var range = sheet.getDataRange();
    return { raw: range.getValues(), display: range.getDisplayValues() };
  }

  /** Records of an entity tab, or null when the tab does not exist. Logs {stage:'sourceSheet', tab, rows, ms}. */
  function readEntityTab_(ss, tabName, keyField, fmtDate) {
    var sheet = findTab(ss, tabName);
    if (!sheet) return null;
    var t0 = Date.now();
    var grid = readGrid_(sheet);
    Perf.log({ stage: 'sourceSheet', tab: tabName, rows: grid.raw.length, ms: Date.now() - t0 });
    return Core.rowsToRecords({
      display: grid.display,
      raw: grid.raw,
      anchors: [keyField],
      keyField: keyField,
      fmtDate: fmtDate
    });
  }

  /**
   * Time zone of the source spreadsheet for Date cells. Some files (e.g. converted from Excel) report
   * none: Utilities.formatDate would then throw « Argument incorrect : timeZone », so fall back to the
   * app's zone (Config.TIME_ZONE).
   */
  function sourceTimeZone_(ss) {
    var tz = null;
    try { tz = ss.getSpreadsheetTimeZone(); } catch (e) { tz = null; }
    if (typeof tz === 'string' && tz.trim()) return tz.trim();
    console.warn('Importer: source spreadsheet has no time zone, using ' + Config.TIME_ZONE);
    return Config.TIME_ZONE;
  }

  /**
   * Reads the whole configured source.
   * @return {{sourceId, title, postes:{headers,records,warnings}|null, applications:{...}|null,
   *           referentiel:Object<string,string[]>|null}}
   */
  function readSource() {
    var ss = openSource();
    var tz = sourceTimeZone_(ss);
    var fmtDate = function (d) { return Utilities.formatDate(d, tz, 'dd/MM/yyyy'); };

    var postes = readEntityTab_(ss, Core.SOURCE_TABS.postes, Core.KEY_POSTE, fmtDate);
    var applications = readEntityTab_(ss, Core.SOURCE_TABS.applications, Core.KEY_APP, fmtDate);
    if (!postes && !applications) {
      throw Core.makeError('SOURCE_ERROR', 'Le classeur source ne contient ni l’onglet « ' +
        Core.SOURCE_TABS.postes + ' » ni l’onglet « ' + Core.SOURCE_TABS.applications + ' ».');
    }
    var refSheet = findTab(ss, Core.SOURCE_TABS.referentiel);
    var referentiel = refSheet ? Core.parseReferentiel(refSheet.getDataRange().getDisplayValues()) : null;

    return {
      sourceId: ss.getId(),
      title: ss.getName(),
      postes: postes,
      applications: applications,
      referentiel: referentiel
    };
  }

  // ---------------------------------------------------------------------------------- import

  /**
   * Gives each new record the `_id` of the stored record with the same key (normKey), so that a
   * re-import keeps record identities stable for the client (open drawers, pending edits).
   */
  function keepIds_(records, previous, keyField) {
    var byKey = {};
    (previous || []).forEach(function (p) {
      var k = Core.normKey(p[keyField]);
      if (k !== '' && !Object.prototype.hasOwnProperty.call(byKey, k)) byKey[k] = p._id;
    });
    var used = {};
    return records.map(function (rec) {
      var k = Core.normKey(rec[keyField]);
      var id = Object.prototype.hasOwnProperty.call(byKey, k) ? byKey[k] : '';
      if (!id || used[id]) return rec;
      used[id] = true;
      var out = {};
      Object.keys(rec).forEach(function (f) { out[f] = rec[f]; });
      out._id = id;
      return out;
    });
  }

  /** Référentiel size reported in counts = number of categories. */
  function countCategories_(ref) {
    return Object.keys(ref || {}).length;
  }

  /**
   * Latest month strictly before `month` whose stored applications snapshot actually has records, as
   * {month, records}, or null. Skipping empty snapshots (an import whose applications tab was
   * missing, or that failed half-way) keeps the Galink/IDP carry-over chain intact. Reads column A
   * of Applications (Store.tabMonths: a month listed there has rows) and that one month's rows.
   */
  function latestEarlierWithRecords_(month) {
    var earlier = Store.tabMonths(Config.TABS.applications).filter(function (m) { return m < month; });
    if (!earlier.length) return null;
    var m = earlier[earlier.length - 1];
    return { month: m, records: Store.readEntityMonth(Config.TABS.applications, m) };
  }

  /** Field names of a record without the internal `_` fields. */
  function dataFields_(rec) {
    return Object.keys(rec || {}).filter(function (k) { return k.charAt(0) !== '_'; });
  }

  /**
   * What a re-import would change in a stored month: {added, removed, changed, values} for records
   * matched by key (normKey, first occurrence wins). `changed` counts records, `values` the cells
   * that differ (compared with Core.str). Pure row-order changes are not changes.
   */
  function diffRecords_(fresh, stored, keyField) {
    function index(list) {
      var out = {};
      (list || []).forEach(function (r) {
        var k = Core.normKey(r[keyField]);
        if (k !== '' && !Object.prototype.hasOwnProperty.call(out, k)) out[k] = r;
      });
      return out;
    }
    var a = index(stored);
    var b = index(fresh);
    var res = { added: 0, removed: 0, changed: 0, values: 0 };
    Object.keys(b).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) { res.added++; return; }
      var seen = {};
      var n = 0;
      dataFields_(a[k]).concat(dataFields_(b[k])).forEach(function (f) {
        if (seen[f]) return;
        seen[f] = true;
        if (Core.str(a[k][f]) !== Core.str(b[k][f])) n++;
      });
      if (n) { res.changed++; res.values += n; }
    });
    Object.keys(a).forEach(function (k) { if (!Object.prototype.hasOwnProperty.call(b, k)) res.removed++; });
    return res;
  }

  function isEmptyDiff_(d) {
    return !d || (!d.added && !d.removed && !d.changed);
  }

  /**
   * « Poste générique Decathlon » for the applications that name it in « Installé sur poste » when the
   * source has no such poste (the app used to add it by hand). Returns the records, completed or not.
   */
  function withGenericPoste_(postes, headers, apps) {
    var target = Core.normKey(Core.GENERIC_POSTE_NAME);
    var named = (apps || []).some(function (a) {
      return Core.str(a['Installé sur poste']).split(',').some(function (p) { return Core.normKey(p) === target; });
    });
    if (!named) return postes;
    var rec = Core.makeGenericPoste(headers, postes.map(function (r) { return r[Core.KEY_POSTE]; }));
    return rec ? postes.concat([rec]) : postes;
  }

  /**
   * Snapshots the live source as `month` (Sync.run every hour; docs/API.md §4). The source is read
   * OUTSIDE the script lock (its slowest step, done on every run, even when nothing changed): saves are
   * not kept waiting behind it. The lock is then taken to read the stored month, compare and write;
   * every read happens before the first write.
   *
   * Lost-edit guard: a live-month save writes into the source under the lock, so a source read taken
   * before the lock may predate it, and the comparison would revert that edit. The source write stamp
   * (Config.sourceStamp, moved by Store.withLock after every write-back has been flushed) is noted
   * BEFORE the outside read; when it moved by the time the lock is held (or the configured source
   * changed), the source is read again, under the lock.
   * Out-of-order guard: two runs can overlap (hourly trigger, api_syncNow, api_enableSync) and the lock
   * is not granted in arrival order, so an older outside read could be committed after a newer one and
   * revert it (records removed, snapshot-only Galink/IDP set in between lost). Every run that writes
   * therefore moves the same stamp, under the lock and before its first write: a run whose read
   * predates that commit reads the source again.
   *
   * Safety rules (user-entered data must never be lost silently):
   *   - an entity / référentiel tab missing from the source does NOT replace the stored snapshot of
   *     that month (kept as-is on overwrite, nothing written for a new month) — only a warning;
   *   - Galink/IDP are carried over from the same month's snapshot when overwriting, otherwise from
   *     the latest EARLIER month that has applications. When overwriting a month whose previous
   *     import is incomplete (no ImportLog entry, e.g. it failed half-way) or has no applications,
   *     fields still blank are then filled from that earlier month too;
   *   - write order: Applications, Référentiel, Postes, then the ImportLog entry, which marks the
   *     import as complete.
   * With opts.skipUnchanged, an overwrite that would change nothing (records, headers, référentiel)
   * writes nothing at all, not even the ImportLog entry: `changed` is then false.
   * Logs {stage:'importMonth', ms, readSource, lockWait, rereadSource, dataReads, compare, writes, flush,
   * month, changed, reread} (Perf) when it completes; `rereadSource` is absent when the outside read was
   * used, `writes` when nothing was written. A failure is reported by the caller's line (sync / api,
   * ok:false).
   * @return {{month, counts:{postes, applications, referentiel}, overwritten:boolean, carriedOver:number,
   *           warnings:string[], changed:boolean, changes:{created:boolean, postes, applications, referentiel:boolean}}}
   */
  function importMonth(month, overwrite, opts) {
    var o = opts || {};
    if (!Core.validateMonth(month)) {
      throw Core.makeError('VALIDATION', 'Mois invalide : « ' + month + ' » (format attendu AAAA-MM).');
    }
    if (!Config.get().sourceId) throw notConfigured_(); // fail fast, before waiting for the lock

    var t = Perf.start('importMonth', { month: month });
    var stamp = Config.sourceStamp(); // before the source read (see the lost-edit guard above)
    var outside = readSource();
    t.lap('readSource');
    var reread = false;
    var res = Store.withLock(function () {
      t.lap('lockWait');
      var src = outside;
      if (Config.sourceStamp() !== stamp || Config.get().sourceId !== outside.sourceId) {
        src = readSource();
        reread = true;
        t.lap('rereadSource');
      }
      // The source was opened anyway: keep the title api_bootstrap shows up to date (no write unless it changed).
      Config.rememberSourceTitle(src.sourceId, src.title);
      var months = Store.listMonths();
      var exists = months.indexOf(month) >= 0;
      if (exists && !overwrite) {
        throw Core.makeError('MONTH_EXISTS', 'Le mois ' + month + ' a déjà été importé.');
      }
      var prevInfo = exists ? Store.latestImportInfo(month) : null;
      var warnings = [];
      if (!src.postes) {
        warnings.push('Onglet « ' + Core.SOURCE_TABS.postes + ' » introuvable : ' +
          (exists ? 'postes du mois conservés.' : 'aucun poste importé.'));
      }
      if (!src.applications) {
        warnings.push('Onglet « ' + Core.SOURCE_TABS.applications + ' » introuvable : ' +
          (exists ? 'applications du mois conservées.' : 'aucune application importée.'));
      }
      if (!src.referentiel) {
        warnings.push('Onglet « ' + Core.SOURCE_TABS.referentiel + ' » introuvable : ' +
          (exists ? 'référentiel du mois conservé.' : 'référentiel vide.'));
      }
      warnings = warnings.concat((src.postes && src.postes.warnings) || [],
        (src.applications && src.applications.warnings) || []);

      // ---- applications (+ Galink/IDP carry-over). Reads this month's rows and, only when the
      // carry-over needs it (new month, or a previous import incomplete / without applications), the
      // latest earlier month that has applications: never the whole history.
      var sameApps = exists ? Store.readEntityMonth(Config.TABS.applications, month) : [];
      var needEarlier = !!src.applications && (!exists || !prevInfo || !sameApps.length);
      var earlier = needEarlier ? latestEarlierWithRecords_(month) : null;
      var appRecords = null; // null = keep the stored snapshot
      var carried = 0;
      if (src.applications) {
        var merged = Core.mergeCarryOver(src.applications.records, exists ? sameApps : (earlier ? earlier.records : []),
          Core.KEY_APP, Core.APP_CUSTOM_FIELDS);
        carried = merged.carried;
        if (exists && (!prevInfo || !sameApps.length) && earlier) {
          var fill = Core.mergeCarryOver(merged.records, earlier.records, Core.KEY_APP, Core.APP_CUSTOM_FIELDS);
          carried += fill.carried;
          merged = fill;
          if (!prevInfo) {
            warnings.push('L’import précédent du mois ' + month + ' était incomplet : Galink/IDP repris de ' +
              earlier.month + ' pour les valeurs manquantes.');
          }
        }
        appRecords = exists ? keepIds_(merged.records, sameApps, Core.KEY_APP) : merged.records;
      }

      // ---- postes
      var posteRecords = null; // null = keep the stored snapshot
      var storedPostes = exists ? Store.readEntityMonth(Config.TABS.postes, month) : [];
      if (src.postes) {
        var postes = withGenericPoste_(src.postes.records, src.postes.headers, appRecords || sameApps);
        posteRecords = exists ? keepIds_(postes, storedPostes, Core.KEY_POSTE) : postes;
      }

      // ---- référentiel
      var referentiel = src.referentiel || null; // null = keep the stored one
      var storedRef = exists ? Store.readReferentiel(month) : null;
      var refCount = referentiel ? countCategories_(referentiel) : (exists ? countCategories_(storedRef) : 0);
      t.lap('dataReads');

      // ---- what changes (an hourly sync that changes nothing writes nothing)
      var postesHeaders = src.postes ? src.postes.headers : ((prevInfo && prevInfo.postes_headers) || []);
      var appsHeaders = src.applications ? src.applications.headers : ((prevInfo && prevInfo.apps_headers) || []);
      var changes = {
        created: !exists,
        postes: posteRecords ? diffRecords_(posteRecords, storedPostes, Core.KEY_POSTE) : diffRecords_([], [], Core.KEY_POSTE),
        applications: appRecords ? diffRecords_(appRecords, sameApps, Core.KEY_APP) : diffRecords_([], [], Core.KEY_APP),
        referentiel: !!referentiel && JSON.stringify(referentiel) !== JSON.stringify(storedRef || {})
      };
      var headersChanged = !prevInfo || JSON.stringify(postesHeaders) !== JSON.stringify(prevInfo.postes_headers || []) ||
        JSON.stringify(appsHeaders) !== JSON.stringify(prevInfo.apps_headers || []);
      var changed = changes.created || headersChanged || changes.referentiel ||
        !isEmptyDiff_(changes.postes) || !isEmptyDiff_(changes.applications);
      var counts = {
        postes: posteRecords ? posteRecords.length : storedPostes.length,
        applications: appRecords ? appRecords.length : sameApps.length,
        referentiel: refCount
      };
      var result = { month: month, counts: counts, overwritten: exists, carriedOver: carried, warnings: warnings,
        changed: changed, changes: changes };
      t.lap('compare');
      if (!changed && o.skipUnchanged) return result;

      // ---- writes (Applications first, ImportLog last = completion marker). Moving the stamp first
      // (out-of-order guard) also covers a run that fails half-way through its writes.
      Config.bumpSourceStamp();
      if (appRecords) Store.replaceEntityMonth(Config.TABS.applications, month, appRecords, Core.KEY_APP);
      if (referentiel) Store.replaceReferentiel(month, referentiel);
      if (posteRecords) Store.replaceEntityMonth(Config.TABS.postes, month, posteRecords, Core.KEY_POSTE);

      Store.appendImportLog({
        month: month,
        imported_at: Config.nowStamp(),
        source_id: src.sourceId,
        counts: counts,
        postes_headers: postesHeaders,
        apps_headers: appsHeaders,
        warnings: warnings,
        changes: changes
      });
      t.lap('writes');
      return result;
    });
    t.lap('flush');
    t.end({ changed: res.changed, reread: reread });
    return res;
  }

  // ------------------------------------------------------------------------------- write-back
  //
  // Reading discipline: the header row is located in the first HEADER_SCAN_ROWS rows, the records by
  // ONE read of the key column, then only the rows a write touches are read (formulas of the edited rows;
  // for an append, readSample_ and the row below the last record, then the new row once written): never
  // the whole tab.
  //
  // Writing discipline: one setValue per edited cell. A block setValues would also rewrite the cells
  // between the edited ones (a formula, a data-validated cell, a value someone just typed in the
  // source), and a refused block could not name the refused value. Apps Script batches consecutive
  // writes until the next read or flush anyway.
  //
  // Every write-back runs under Store.withLock (re-entrant: the api_* callers already hold it) and
  // calls Store.noteSourceWrite before its first write, so that the source write stamp moves
  // (importMonth's lost-edit guard).

  var HEADER_SCAN_ROWS = 15; // = Core.findHeaderRow's default scan depth
  var ROW_GAP = 5;           // touched rows at most this far apart are read in one block
  var MAX_ROW_BLOCKS = 3;    // more blocks than this: one block from the first to the last touched row

  /**
   * The source tab of an entity, located for writing: {sheet, tabName, keyField, headers, columns
   * (grid column of each header), headerRow, width, height (data range), rows (grid row of each record,
   * in sheet order), find(name) -> index in rows or -1}. Records are the rows below the header whose
   * key is not blank (as Core.rowsToRecords sees them). SOURCE_ERROR when the tab or its header row is
   * missing. `timer` (Perf.start) gets the sourceOpen and sourceRead laps.
   */
  function sourceTable_(entity, timer) {
    var keyField = entity === 'postes' ? Core.KEY_POSTE : Core.KEY_APP;
    var tabName = Core.SOURCE_TABS[entity];
    var ss = openSource();
    var sheet = findTab(ss, tabName);
    timer.lap('sourceOpen');
    if (!sheet) {
      throw Core.makeError('SOURCE_ERROR', 'Onglet « ' + tabName + ' » introuvable dans le Google Sheet source : ' +
        'modification non enregistrée.');
    }
    var range = sheet.getDataRange();
    var height = range.getNumRows();
    var width = range.getNumColumns();
    var head = sheet.getRange(1, 1, Math.min(HEADER_SCAN_ROWS, height), width).getDisplayValues();
    var parsed = Core.rowsToRecords({ display: head, anchors: [keyField], keyField: keyField });
    var keyCol = parsed.columns[parsed.headers.indexOf(keyField)];
    var first = parsed.headerRow + 1; // grid row (0-based) just below the header
    var keys = height > first ? sheet.getRange(first + 1, keyCol + 1, height - first, 1).getDisplayValues() : [];
    var rows = [];
    var norms = [];
    keys.forEach(function (cell, i) {
      var k = Core.str(cell[0]);
      if (k === '') return;
      rows.push(first + i);
      norms.push(Core.normKey(k));
    });
    timer.lap('sourceRead');
    return {
      sheet: sheet,
      tabName: tabName,
      keyField: keyField,
      headers: parsed.headers,
      columns: parsed.columns,
      headerRow: parsed.headerRow,
      width: width,
      height: height,
      rows: rows,
      find: function (name) {
        return norms.indexOf(Core.normKey(name));
      }
    };
  }

  /**
   * Formulas of the given grid rows (0-based) across the data range: {gridRow: [formula or '' per
   * column]}. One getFormulas per block of nearby rows (ROW_GAP); when that makes more than
   * MAX_ROW_BLOCKS calls, one block from the first to the last row instead.
   */
  function rowFormulas_(t, gridRows) {
    var sorted = gridRows.slice().sort(function (a, b) { return a - b; });
    var blocks = [];
    sorted.forEach(function (r) {
      var b = blocks[blocks.length - 1];
      if (b && r - b.to <= ROW_GAP) b.to = r;
      else blocks.push({ from: r, to: r });
    });
    if (blocks.length > MAX_ROW_BLOCKS) blocks = [{ from: blocks[0].from, to: blocks[blocks.length - 1].to }];
    var out = {};
    blocks.forEach(function (b) {
      var grid = t.sheet.getRange(b.from + 1, 1, b.to - b.from + 1, t.width).getFormulas();
      for (var r = b.from; r <= b.to; r++) out[r] = grid[r - b.from];
    });
    return out;
  }

  /** Cell value as written into the source: '' for blank, formula-looking text kept as text. */
  function sourceValue_(v) {
    return v === null || v === undefined ? '' : Core.escapeFormula(String(v));
  }

  function missingRow_(t, name) {
    return Core.makeError('SOURCE_ERROR', '« ' + name + ' » est introuvable dans l’onglet « ' + t.tabName +
      ' » du Google Sheet source (renommé ou supprimé ?). Synchronisez puis réessayez.');
  }

  /**
   * Writes edits of the current month into the source, before the snapshot is updated:
   * edits = [{name, fields:{header: value}}] (name = the record's key in the snapshot). Fields that
   * have no column in the source (Galink / IDP when the source has none) are skipped: they live in
   * the snapshot only. Every edit is checked first (row found, no formula in the cell: the formulas
   * of the edited rows only are read), then written cell by cell.
   * Like appendRecord / deleteRecord, logs {stage:'writeBack', ms, sourceOpen, sourceRead, cellWrites,
   * op, entity} (Perf) when it completes; a refused write is reported by the caller's api line.
   * @return {number} cells written
   */
  function writeEdits(entity, edits) {
    if (!edits || !edits.length) return 0;
    return Store.withLock(function () {
      var timer = Perf.start('writeBack', { op: 'edit', entity: entity });
      var t = sourceTable_(entity, timer);
      var cells = [];
      edits.forEach(function (e) {
        var i = t.find(e.name);
        if (i < 0) throw missingRow_(t, e.name);
        Object.keys(e.fields).forEach(function (f) {
          var h = t.headers.indexOf(f);
          if (h < 0) return;
          cells.push({ row: t.rows[i] + 1, col: t.columns[h] + 1, field: f, value: sourceValue_(e.fields[f]) });
        });
      });
      if (cells.length) {
        var formulas = rowFormulas_(t, cells.map(function (cell) { return cell.row - 1; }));
        timer.lap('sourceRead');
        cells.forEach(function (cell) {
          if (formulas[cell.row - 1][cell.col - 1]) {
            throw Core.makeError('VALIDATION', 'La colonne « ' + cell.field + ' » est calculée par une formule dans ' +
              'le Google Sheet source : modifiez-la là-bas.', cell.field);
          }
        });
        Store.noteSourceWrite();
        cells.forEach(function (cell) { setCell_(t, cell); });
      }
      timer.lap('cellWrites');
      timer.end();
      return cells.length;
    });
  }

  /** One cell write; a value refused by the cell's data validation becomes VALIDATION (with the field). */
  function setCell_(t, cell) {
    try {
      t.sheet.getRange(cell.row, cell.col).setValue(cell.value);
    } catch (e) {
      var msg = sheetMessage_(e);
      console.warn('Importer: source write refused (' + t.tabName + ' ' + cell.row + ':' + cell.col + '): ' + msg);
      throw Core.makeError('VALIDATION', 'Le Google Sheet source a refusé la valeur « ' + cell.value + ' » (' + msg + ').',
        fieldFromSheetError_(t, msg) || cell.field);
    }
  }

  /** First line of a Sheets error message, at most 160 characters. */
  function sheetMessage_(e) {
    return String((e && e.message) || '').split('\n')[0].slice(0, 160);
  }

  /** 'L' -> 11 (1-based column number of A1 letters). */
  function colNumber_(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
    return n;
  }

  /**
   * The header of the first cell a Sheets refusal names (« … in cell L4 violates the data validation
   * rules … »), or '' when the message names no cell of a known column.
   */
  function fieldFromSheetError_(t, message) {
    var m = /(?:^|[^A-Za-z0-9_!$])\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})(?![A-Za-z0-9_])/.exec(String(message || ''));
    if (!m) return '';
    var j = t.columns.indexOf(colNumber_(m[1]) - 1);
    return j >= 0 ? t.headers[j] : '';
  }

  // ------------------------------------------------------------------------------- creation forms
  //
  // A new record's fields come from the live source tab (docs/API.md §4, readFormSchema): its headers,
  // the data validation of its last record row (dropdown lists, checkboxes, dates), and which columns
  // are computed (a formula in the last record row, or an array formula — ARRAYFORMULA, ={…}, BYROW,
  // MAP — in the header row or the first data row, whose results spill into the rows below).

  var FORM_CACHE_TTL_S = 300;        // readFormSchema cache lifetime
  var FORM_CACHE_MAX_CHARS = 90000;  // larger schemas are not cached (CacheService value limit: 100 KB)
  var LIST_MAX_ROWS = 2000;          // VALUE_IN_RANGE lists: the bounding box read per sheet is capped
  var LIST_MAX_COLS = 30;
  var LIST_MAX_OPTIONS = 500;        // options kept per list
  var LIST_MAX_CHARS = 200;          // longer option values are left out
  var ARRAY_FORMULA_RE = /^=\s*\{|(?:^|[^A-Za-z0-9_.])(?:ARRAYFORMULA|BYROW|MAP)\s*\(/i;

  function isDateValue_(v) {
    return Object.prototype.toString.call(v) === '[object Date]';
  }

  /**
   * What the forms need from the source rows (one block of formulas when the rows are close, see
   * rowFormulas_): {lastIdx (grid row of the last record or -1), sampleRow (that row, else the first data
   * row when the sheet has one, else -1), arrayCols {gridCol: true} (array formula in the header row or
   * the first data row), formulas / rules / raw: the sample row's formulas, data validations and raw
   * values, per grid column ([] when there is no sample row)}.
   */
  function readSample_(t) {
    var maxRows = t.sheet.getMaxRows();
    var lastIdx = t.rows.length ? t.rows[t.rows.length - 1] : -1;
    var firstData = t.headerRow + 1;
    var sampleRow = lastIdx >= 0 ? lastIdx : (firstData < maxRows ? firstData : -1);
    var wanted = [t.headerRow];
    if (firstData < maxRows) wanted.push(firstData);
    if (sampleRow >= 0 && wanted.indexOf(sampleRow) < 0) wanted.push(sampleRow);
    var formulas = rowFormulas_(t, wanted);
    var arrayCols = {};
    [t.headerRow, firstData].forEach(function (r) {
      (formulas[r] || []).forEach(function (f, c) { if (f && ARRAY_FORMULA_RE.test(String(f))) arrayCols[c] = true; });
    });
    var out = { lastIdx: lastIdx, sampleRow: sampleRow, arrayCols: arrayCols, formulas: [], rules: [], raw: [] };
    if (sampleRow >= 0) {
      var range = t.sheet.getRange(sampleRow + 1, 1, 1, t.width);
      out.formulas = formulas[sampleRow] || [];
      out.rules = range.getDataValidations()[0] || [];
      out.raw = range.getValues()[0] || [];
    }
    return out;
  }

  /** Trimmed, non-blank, de-duplicated option values (at most LIST_MAX_OPTIONS of at most LIST_MAX_CHARS). */
  function cleanOptions_(values) {
    var out = [];
    (values || []).forEach(function (v) {
      var s = Core.str(v);
      if (s === '' || s.length > LIST_MAX_CHARS || out.indexOf(s) >= 0 || out.length >= LIST_MAX_OPTIONS) return;
      out.push(s);
    });
    return out;
  }

  /**
   * The values of VALUE_IN_RANGE lists: ONE getDisplayValues per sheet, over the bounding box of that
   * sheet's ranges (capped at LIST_MAX_ROWS x LIST_MAX_COLS from its top-left cell). Returns
   * lookup(range) -> options (row by row, cleanOptions_), or null when the range could not be read.
   */
  function rangeLists_(ranges) {
    var boxes = {};
    ranges.forEach(function (r) {
      var sheet = r.getSheet();
      var id = String(sheet.getSheetId());
      var top = r.getRow();
      var left = r.getColumn();
      var bottom = top + r.getNumRows() - 1;
      var right = left + r.getNumColumns() - 1;
      var b = boxes[id];
      if (!b) { boxes[id] = { sheet: sheet, top: top, left: left, bottom: bottom, right: right }; return; }
      b.top = Math.min(b.top, top);
      b.left = Math.min(b.left, left);
      b.bottom = Math.max(b.bottom, bottom);
      b.right = Math.max(b.right, right);
    });
    Object.keys(boxes).forEach(function (id) {
      var b = boxes[id];
      var rows = Math.min(b.bottom - b.top + 1, LIST_MAX_ROWS, b.sheet.getMaxRows() - b.top + 1);
      var cols = Math.min(b.right - b.left + 1, LIST_MAX_COLS, b.sheet.getMaxColumns() - b.left + 1);
      try {
        b.grid = rows > 0 && cols > 0 ? b.sheet.getRange(b.top, b.left, rows, cols).getDisplayValues() : [];
      } catch (e) {
        console.warn('Importer: list range not readable (' + sheetMessage_(e) + ')');
        b.grid = null;
      }
    });
    return function (r) {
      var b = boxes[String(r.getSheet().getSheetId())];
      if (!b || !b.grid) return null;
      var values = [];
      for (var i = r.getRow() - b.top; i < r.getRow() - b.top + r.getNumRows() && i < b.grid.length; i++) {
        for (var j = r.getColumn() - b.left; j < r.getColumn() - b.left + r.getNumColumns() && j < b.grid[i].length; j++) {
          values.push(b.grid[i][j]);
        }
      }
      return cleanOptions_(values);
    };
  }

  /** Data validation of a column -> kind / options / strict / rule (lists: rangeLists_ lookup or null). */
  function describeRule_(col, rule, lists) {
    var type = String(rule.getCriteriaType());
    var values = rule.getCriteriaValues() || [];
    var strict = !rule.getAllowInvalid();
    col.rule = type;
    if (type === 'VALUE_IN_LIST') {
      col.kind = 'select';
      col.options = cleanOptions_(values[0]);
      col.strict = strict;
    } else if (type === 'VALUE_IN_RANGE') {
      var options = lists && values[0] ? lists(values[0]) : null;
      if (options) {
        col.kind = 'select';
        col.options = options;
        col.strict = strict;
      }
    } else if (type === 'CHECKBOX') {
      col.kind = 'checkbox';
      col.options = values.length ? values.map(function (v) { return String(v); }) : ['TRUE', 'FALSE'];
      col.strict = strict;
    } else if (type.indexOf('DATE_') === 0) {
      col.kind = 'date';
      col.strict = strict;
    }
  }

  /**
   * Form columns of a source tab, in sheet order: {name, kind, options, strict, computed, required,
   * rule?} (docs/API.md §3, api_getFormSchema). Without `lists`, VALUE_IN_RANGE columns are plain text
   * (the sheet itself refuses a value outside the range when the rule rejects).
   */
  function describeColumns_(entity, t, sample, lists) {
    var required = Core.FORM_REQUIRED[entity] || [];
    return t.headers.map(function (name, j) {
      var c = t.columns[j];
      var computed = !!sample.arrayCols[c] || !!sample.formulas[c];
      var col = { name: name, kind: 'text', options: null, strict: false, computed: computed,
        required: !computed && required.indexOf(name) >= 0 };
      var rule = sample.rules[c];
      if (rule) describeRule_(col, rule, lists);
      else if (Core.YES_NO_COLS.indexOf(name) >= 0) {
        col.kind = 'select';
        col.options = ['Oui', 'Non'];
      }
      var hinted = Core.FORM_DATE_HINTS.some(function (h) { return Core.normKey(h) === Core.normKey(name); });
      if (col.kind === 'text' && (hinted || isDateValue_(sample.raw[c]))) col.kind = 'date';
      return col;
    });
  }

  /** Counts of a schema for the formSchema timing line (never names). */
  function schemaCounts_(columns, cache) {
    return {
      columns: columns.length,
      computed: columns.filter(function (c) { return c.computed; }).length,
      selects: columns.filter(function (c) { return c.kind === 'select'; }).length,
      cache: cache
    };
  }

  /**
   * Form schema of an entity read from the live source, OUTSIDE the script lock (nothing is written):
   * {keyField, readAt:'YYYY-MM-DD HH:mm', columns} (describeColumns_). Reads: the tab as for a
   * write-back (sourceTable_), readSample_, then one bounding box per sheet for the VALUE_IN_RANGE lists.
   * Cached in CacheService (Access.cacheGet / cachePut) under 'fs1:<entity>:<sourceId>' for
   * FORM_CACHE_TTL_S seconds (not when the JSON exceeds FORM_CACHE_MAX_CHARS); opts.fresh skips the
   * cached value and stores the new one. NOT_CONFIGURED without a source; any read failure is SOURCE_ERROR.
   * Logs {stage:'formSchema', ms, sourceOpen, sourceRead, validations, lists, entity, columns, computed,
   * selects, cache:'miss'|'bypass'} ({stage, ms, entity, columns, computed, selects, cache:'hit'} from the
   * cache): counts only, never a column name.
   */
  function readFormSchema(entity, opts) {
    var fresh = !!(opts && opts.fresh);
    var id = Config.get().sourceId;
    if (!id) throw notConfigured_();
    var key = 'fs1:' + entity + ':' + id;
    var timer = Perf.start('formSchema', { entity: entity });
    if (!fresh) {
      var cached = null;
      try { cached = JSON.parse(Access.cacheGet(key) || 'null'); } catch (e) { cached = null; }
      if (cached && Array.isArray(cached.columns)) {
        timer.end(schemaCounts_(cached.columns, 'hit'));
        return cached;
      }
    }
    var schema;
    try {
      var t = sourceTable_(entity, timer);
      var sample = readSample_(t);
      timer.lap('validations');
      var ranges = [];
      sample.rules.forEach(function (rule) {
        if (!rule || String(rule.getCriteriaType()) !== 'VALUE_IN_RANGE') return;
        var r = (rule.getCriteriaValues() || [])[0];
        if (r && typeof r.getSheet === 'function') ranges.push(r);
      });
      var lists = ranges.length ? rangeLists_(ranges) : null;
      timer.lap('lists');
      schema = { keyField: t.keyField, readAt: Config.nowStamp(), columns: describeColumns_(entity, t, sample, lists) };
    } catch (e) {
      if (e && e.code) throw e;
      throw Core.makeError('SOURCE_ERROR', 'Lecture du Google Sheet source impossible (' + sheetMessage_(e) + ').');
    }
    var json = JSON.stringify(schema);
    if (json.length <= FORM_CACHE_MAX_CHARS) Access.cachePut(key, json, FORM_CACHE_TTL_S);
    timer.end(schemaCounts_(schema.columns, fresh ? 'bypass' : 'miss'));
    return schema;
  }

  /**
   * A record's values under the source headers (exact name, else normKey match; `_` keys ignored). A key
   * with no source column is skipped when blank, when it is an app-only field (Galink / IDP) or when not
   * `strict`; otherwise VALIDATION naming it.
   */
  function sheetFields_(t, rec, strict) {
    var out = {};
    Object.keys(rec || {}).forEach(function (k) {
      if (k.charAt(0) === '_') return;
      var j = t.headers.indexOf(k);
      for (var i = 0; j < 0 && i < t.headers.length; i++) if (Core.normKey(t.headers[i]) === Core.normKey(k)) j = i;
      if (j < 0) {
        if (!strict || Core.isBlank(rec[k]) || Core.APP_CUSTOM_FIELDS.indexOf(k) >= 0) return;
        throw Core.makeError('VALIDATION', 'La colonne « ' + k + ' » n’existe pas dans le Google Sheet source : ' +
          'rouvrez le formulaire.', k);
      }
      var h = t.headers[j];
      if (!Object.prototype.hasOwnProperty.call(out, h) || !Core.isBlank(rec[k])) out[h] = rec[k];
    });
    return out;
  }

  /** Grid columns [from, to] (inclusive) of the runs of consecutive true cells of `flags`. */
  function runs_(flags) {
    var out = [];
    flags.forEach(function (on, c) {
      if (!on) return;
      var last = out[out.length - 1];
      if (last && last.to === c - 1) last.to = c;
      else out.push({ from: c, to: c });
    });
    return out;
  }

  /** Puts back what a refused append left: the inserted row, else the cells already written. Never throws. */
  function undoAppend_(t, at, inserted, written) {
    try {
      if (inserted) t.sheet.deleteRow(at);
      else written.forEach(function (w) { t.sheet.getRange(at, w.from + 1, 1, w.to - w.from + 1).clearContent(); });
    } catch (e) {
      console.warn('Importer: could not undo a refused append (' + sheetMessage_(e) + ')');
    }
  }

  /** A refused setValues of an append -> VALIDATION naming the field when the message names a cell. */
  function appendRefusal_(t, e, values) {
    var msg = sheetMessage_(e);
    console.warn('Importer: source append refused (' + t.tabName + '): ' + msg);
    var field = fieldFromSheetError_(t, msg);
    if (field) {
      return Core.makeError('VALIDATION', 'Le Google Sheet source a refusé la valeur « ' + Core.str(values[field]) +
        ' » (' + msg + ').', field);
    }
    if (/valid/i.test(msg)) {
      return Core.makeError('VALIDATION', 'Le Google Sheet source a refusé la nouvelle ligne (' + msg + ').');
    }
    return e;
  }

  /** A computed value read back right after the write: '' and « Loading… » (not computed yet) -> null. */
  function computedValue_(v) {
    var s = Core.str(v);
    return s === '' || /^(loading|chargement)/i.test(s) ? null : s;
  }

  /**
   * Appends a record as a new source row, just below the last record (a row is inserted when that row
   * is not empty), under the lock. The record's values go under the source headers (sheetFields_);
   * computed columns are never written: the formulas of the last record's row are copied down (relative
   * references follow, as with a fill) and array-formula columns are left to spill. With opts.strict, the
   * values are first checked against the sheet (Core.checkFormRecord on describeColumns_: unknown column,
   * computed column, required field, date, list of a rejecting rule) and refused as VALIDATION with the
   * field, before anything is written; without it, values of computed columns are dropped. A value the
   * sheet itself refuses (a rejecting VALUE_IN_RANGE rule…) becomes VALIDATION with the field its cell
   * belongs to, and what was written is undone. A duplicate key is VALIDATION (field = the key).
   * Reads: the header block and key column (sourceTable_), readSample_, the row below the last record
   * and, after SpreadsheetApp.flush(), the new row's display values.
   * @return {{values:Object, computed:Object}} the values written (header -> value | null; dates as
   *   'DD/MM/YYYY' when strict) and the computed columns as the sheet shows them now (null when blank or
   *   still loading)
   */
  function appendRecord(entity, rec, opts) {
    var strict = !!(opts && opts.strict);
    return Store.withLock(function () {
      var timer = Perf.start('writeBack', { op: 'append', entity: entity });
      var t = sourceTable_(entity, timer);
      if (t.find(rec[t.keyField]) >= 0) {
        throw Core.makeError('VALIDATION', '« ' + Core.str(rec[t.keyField]) + ' » existe déjà dans l’onglet « ' +
          t.tabName + ' » du Google Sheet source.', t.keyField);
      }
      var sample = readSample_(t);
      var lastIdx = sample.lastIdx;
      var at = (lastIdx >= 0 ? lastIdx : t.headerRow) + 2; // 1-based row just below the last record (or the header)
      var below = at <= t.height ? t.sheet.getRange(at, 1, 1, t.width).getDisplayValues()[0] : null;
      timer.lap('sourceRead');

      var columns = describeColumns_(entity, t, sample, null);
      var input = sheetFields_(t, rec, strict);
      var values = {};
      if (strict) {
        var checked = Core.checkFormRecord(columns, input);
        if (!checked.ok) throw Core.makeError('VALIDATION', checked.message, checked.field);
        values = checked.record;
      } else {
        columns.forEach(function (col) {
          if (!col.computed && Object.prototype.hasOwnProperty.call(input, col.name)) {
            values[col.name] = Core.isBlank(input[col.name]) ? null : input[col.name];
          }
        });
      }

      var width = t.columns.length ? t.columns[t.columns.length - 1] + 1 : 1;
      var row = [];
      var writable = [];
      for (var c = 0; c < width; c++) { row.push(''); writable.push(false); }
      columns.forEach(function (col, j) {
        if (col.computed) return;
        var gc = t.columns[j];
        writable[gc] = true;
        if (values[col.name] !== null && values[col.name] !== undefined) row[gc] = sourceValue_(values[col.name]);
      });

      Store.noteSourceWrite();
      var inserted = false;
      if (below && below.some(function (v) { return String(v) !== ''; })) {
        t.sheet.insertRowsAfter(at - 1, 1);
        inserted = true;
      } else if (at > t.sheet.getMaxRows()) {
        t.sheet.insertRowsAfter(t.sheet.getMaxRows(), at - t.sheet.getMaxRows());
      }
      var written = [];
      try {
        runs_(writable).forEach(function (w) {
          t.sheet.getRange(at, w.from + 1, 1, w.to - w.from + 1).setValues([row.slice(w.from, w.to + 1)]);
          written.push(w);
        });
      } catch (e) {
        undoAppend_(t, at, inserted, written);
        throw appendRefusal_(t, e, values);
      }
      if (lastIdx >= 0) {
        sample.formulas.forEach(function (f, fc) {
          if (f && fc < width && !sample.arrayCols[fc]) t.sheet.getRange(lastIdx + 1, fc + 1).copyTo(t.sheet.getRange(at, fc + 1));
        });
      }
      SpreadsheetApp.flush();
      var shown = t.sheet.getRange(at, 1, 1, width).getDisplayValues()[0];
      var computed = {};
      columns.forEach(function (col, j) {
        if (col.computed) computed[col.name] = computedValue_(shown[t.columns[j]]);
      });
      timer.lap('cellWrites');
      timer.end();
      return { values: values, computed: computed };
    });
  }

  /** Deletes the source row of `name`; false when the source has no such row (nothing to delete). */
  function deleteRecord(entity, name) {
    return Store.withLock(function () {
      var timer = Perf.start('writeBack', { op: 'delete', entity: entity });
      var t = sourceTable_(entity, timer);
      var i = t.find(name);
      if (i >= 0) {
        Store.noteSourceWrite();
        t.sheet.deleteRow(t.rows[i] + 1);
      }
      timer.lap('cellWrites');
      timer.end();
      return i >= 0;
    });
  }

  return {
    openSource: openSource,
    findTab: findTab,
    readSource: readSource,
    importMonth: importMonth,
    writeEdits: writeEdits,
    appendRecord: appendRecord,
    deleteRecord: deleteRecord,
    readFormSchema: readFormSchema,
    openById_: openById_,
    tabsFound_: tabsFound_
  };
})();
