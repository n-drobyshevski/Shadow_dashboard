/**
 * Importer — reads the live source spreadsheet ("ShadowIT_Industry") and snapshots one month into
 * the data spreadsheet (docs/API.md §4).
 *
 * Reading discipline: per source tab ONE getDataRange(), then getValues() (raw, to detect real Date
 * cells) + getDisplayValues() (what the user sees: '30,4%', 'Oui'...). Date cells are formatted
 * 'dd/MM/yyyy' in the SOURCE spreadsheet's time zone (not the script's), so a date typed as
 * 15/03/2026 in Paris never becomes 14/03/2026.
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

  /** Records of an entity tab, or null when the tab does not exist. */
  function readEntityTab_(ss, tabName, keyField, fmtDate) {
    var sheet = findTab(ss, tabName);
    if (!sheet) return null;
    var grid = readGrid_(sheet);
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
   * Latest month strictly before `month` whose stored snapshot actually has records, as
   * {month, records}, or null. Skipping empty snapshots (an import whose applications tab was
   * missing, or that failed half-way) keeps the Galink/IDP carry-over chain intact.
   */
  function latestEarlierWithRecords_(byMonth, month) {
    var earlier = Core.sortMonths(Object.keys(byMonth).filter(function (m) {
      return Core.validateMonth(m) && m < month && (byMonth[m] || []).length > 0;
    }));
    if (!earlier.length) return null;
    var m = earlier[earlier.length - 1];
    return { month: m, records: byMonth[m] };
  }

  /**
   * Snapshots the live source as `month` (see api_importMonth in docs/API.md §3). Runs under the
   * script lock; every read happens before the first write.
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
   * @return {{month, counts:{postes, applications, referentiel}, overwritten:boolean, carriedOver:number,
   *           warnings:string[]}}
   */
  function importMonth(month, overwrite) {
    if (!Core.validateMonth(month)) {
      throw Core.makeError('VALIDATION', 'Mois invalide : « ' + month + ' » (format attendu AAAA-MM).');
    }
    if (!Config.get().sourceId) throw notConfigured_(); // fail fast, before waiting for the lock

    return Store.withLock(function () {
      var months = Store.listMonths();
      var exists = months.indexOf(month) >= 0;
      if (exists && !overwrite) {
        throw Core.makeError('MONTH_EXISTS', 'Le mois ' + month + ' a déjà été importé.');
      }

      var src = readSource();
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

      // ---- applications (+ Galink/IDP carry-over)
      var appsByMonth = Store.readEntityAll(Config.TABS.applications);
      var sameApps = exists ? (appsByMonth[month] || []) : [];
      var earlier = latestEarlierWithRecords_(appsByMonth, month);
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
        posteRecords = exists ? keepIds_(src.postes.records, storedPostes, Core.KEY_POSTE) : src.postes.records;
      }

      // ---- référentiel
      var referentiel = src.referentiel || null; // null = keep the stored one
      var refCount = referentiel ? countCategories_(referentiel)
        : (exists ? countCategories_(Store.readReferentiel(month)) : 0);

      // ---- writes (Applications first, ImportLog last = completion marker)
      if (appRecords) Store.replaceEntityMonth(Config.TABS.applications, month, appRecords, Core.KEY_APP);
      if (referentiel) Store.replaceReferentiel(month, referentiel);
      if (posteRecords) Store.replaceEntityMonth(Config.TABS.postes, month, posteRecords, Core.KEY_POSTE);

      var counts = {
        postes: posteRecords ? posteRecords.length : storedPostes.length,
        applications: appRecords ? appRecords.length : sameApps.length,
        referentiel: refCount
      };
      Store.appendImportLog({
        month: month,
        imported_at: Config.nowStamp(),
        source_id: src.sourceId,
        counts: counts,
        postes_headers: src.postes ? src.postes.headers : ((prevInfo && prevInfo.postes_headers) || []),
        apps_headers: src.applications ? src.applications.headers : ((prevInfo && prevInfo.apps_headers) || []),
        warnings: warnings
      });

      return {
        month: month,
        counts: counts,
        overwritten: exists,
        carriedOver: carried,
        warnings: warnings
      };
    });
  }

  return {
    openSource: openSource,
    findTab: findTab,
    readSource: readSource,
    importMonth: importMonth,
    openById_: openById_,
    tabsFound_: tabsFound_
  };
})();
