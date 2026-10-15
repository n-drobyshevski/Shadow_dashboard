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

      // ---- writes (Applications first, ImportLog last = completion marker)
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
  // ONE read of the key column, then only the rows a write touches are read (formulas of the edited rows,
  // the row below the last record for an append): never the whole tab.
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
              'le Google Sheet source : modifiez-la là-bas.');
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

  /** One cell write; a value refused by the cell's data validation becomes VALIDATION. */
  function setCell_(t, cell) {
    try {
      t.sheet.getRange(cell.row, cell.col).setValue(cell.value);
    } catch (e) {
      console.warn('Importer: source write refused (' + t.tabName + ' ' + cell.row + ':' + cell.col + '): ' + (e && e.message));
      throw Core.makeError('VALIDATION', 'Le Google Sheet source a refusé la valeur « ' + cell.value + ' » (' +
        String((e && e.message) || '').split('\n')[0].slice(0, 160) + ').');
    }
  }

  /**
   * Appends a record as a new source row, just below the last record (a row is inserted when that row
   * is not empty). Headers the record lacks stay blank, except the columns computed by a formula in
   * the last record's row: the formula is copied down (relative references follow, as with a fill).
   * Reads the row below the last record and the last record's formulas only.
   */
  function appendRecord(entity, rec) {
    Store.withLock(function () {
      var timer = Perf.start('writeBack', { op: 'append', entity: entity });
      var t = sourceTable_(entity, timer);
      if (t.find(rec[t.keyField]) >= 0) {
        throw Core.makeError('VALIDATION', '« ' + rec[t.keyField] + ' » existe déjà dans l’onglet « ' + t.tabName +
          ' » du Google Sheet source.');
      }
      var cols = t.columns;
      var width = cols.length ? cols[cols.length - 1] + 1 : 1;
      var row = [];
      for (var c = 0; c < width; c++) row.push('');
      t.headers.forEach(function (h, j) {
        if (Object.prototype.hasOwnProperty.call(rec, h) && !Core.isBlank(rec[h])) row[cols[j]] = sourceValue_(rec[h]);
      });
      var lastIdx = t.rows.length ? t.rows[t.rows.length - 1] : -1;
      var last = lastIdx >= 0 ? lastIdx : t.headerRow;
      var at = last + 2; // 1-based row just below the last record (or the header row)
      var below = at <= t.height ? t.sheet.getRange(at, 1, 1, t.width).getDisplayValues()[0] : null;
      var lastFormulas = lastIdx >= 0 ? rowFormulas_(t, [lastIdx])[lastIdx] : [];
      timer.lap('sourceRead');
      Store.noteSourceWrite();
      if (below && below.some(function (v) { return String(v) !== ''; })) t.sheet.insertRowsAfter(at - 1, 1);
      else if (at > t.sheet.getMaxRows()) t.sheet.insertRowsAfter(t.sheet.getMaxRows(), at - t.sheet.getMaxRows());
      t.sheet.getRange(at, 1, 1, width).setValues([row]);
      lastFormulas.forEach(function (f, fc) {
        if (f && fc < width && row[fc] === '') t.sheet.getRange(lastIdx + 1, fc + 1).copyTo(t.sheet.getRange(at, fc + 1));
      });
      timer.lap('cellWrites');
      timer.end();
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
    openById_: openById_,
    tabsFound_: tabsFound_
  };
})();
