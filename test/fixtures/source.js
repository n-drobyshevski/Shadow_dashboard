'use strict';
/**
 * Builds a fake "live" ShadowIT_Industry spreadsheet definition from data.js, shaped the way the
 * real Google Sheet looks when read with getValues() / getDisplayValues():
 *   - row 0 is a banner (title), row 1 holds the headers (Python original used skiprows=1)
 *   - some headers carry trailing spaces / NBSP
 *   - 'Date visite' / 'Date' cells are real Date objects in raw values
 *   - 'Score conformité' raw is a fraction (0.304) while display is '30,4%'
 *   - trailing ghost rows: fully empty rows + a formula-leftover row with only a score ('0%')
 *   - the Référentiel tab is transposed (one column per category, ragged)
 *
 * Usage (integration tests):
 *   const { buildSourceSpreadsheet } = require('../fixtures/source');
 *   const def = buildSourceSpreadsheet('2026-05');
 *   // def = { id, name, timeZone, sheets: { [sheetName]: { values: any[][], display: string[][] } } }
 *
 * buildSourceSpreadsheet(month, {form: true}) adds what the creation forms read from a real source
 * (opt-in: the other tests keep the plain sheet):
 *   - postes: formulas in « Score conformité », « Niveau de risque » and « Statut » on every record row
 *     (display values unchanged), and an ARRAYFORMULA column « Ancienneté » (formula in the first data
 *     row, spilled values below);
 *   - applications: an array column « Doublon » whose header cell is a ={"Doublon"; ARRAYFORMULA(…)}
 *     formula;
 *   - data validation from the first data row to the last row of the tab: Oui/Non lists (rejecting) on
 *     IT Decathlon, EDR Decathlon, Chiffrement disque, Réseau Decathlon; a Criticité équipement list
 *     (rejecting); OS from the Référentiel (range, rejecting); Équipe from the Référentiel (range,
 *     allowInvalid); Date d'achat must be a date (rejecting); applications: Contrat / SIP Oui/Non lists
 *     (rejecting), Type from the Référentiel (range, allowInvalid).
 */
const data = require('./data');
const { colLetters } = require('../helpers/gasFakes');

const SOURCE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_SRC';

function parseFr(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || ''));
  // Noon UTC is the same calendar day in Europe/Paris whatever the host time zone.
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12)) : null;
}

function scoreRaw(display) {
  if (display == null || display === '') return '';
  const n = Number(String(display).replace('%', '').replace(',', '.'));
  return Number.isFinite(n) ? n / 100 : display;
}

const DATE_COLS = new Set(['Date visite', 'Prochaine revue', "Date d'achat", 'Deadline', 'Date']);

/** Display header variants, to exercise header normalisation. */
function displayHeader(h) {
  if (h === 'Équipe') return 'Équipe ';               // trailing space
  if (h === 'Bâtiment / Labo') return 'Bâtiment / Labo'; // NBSP
  return h;
}

function buildTab(banner, headers, records) {
  const width = headers.length;
  const pad = (row) => { while (row.length < width) row.push(''); return row; };
  const values = [pad([banner]), headers.map(displayHeader)];
  const display = [pad([banner]), headers.map(displayHeader)];
  for (const rec of records) {
    const vRow = [];
    const dRow = [];
    for (const h of headers) {
      const v = rec[h];
      const disp = v == null ? '' : String(v);
      dRow.push(disp);
      if (DATE_COLS.has(h) && parseFr(disp)) vRow.push(parseFr(disp));
      else if (h === 'Score conformité') vRow.push(scoreRaw(disp));
      else vRow.push(disp);
    }
    values.push(vRow);
    display.push(dRow);
  }
  // ghost rows
  values.push(pad([]));
  display.push(pad([]));
  const ghostV = pad([]);
  const ghostD = pad([]);
  const si = headers.indexOf('Score conformité');
  if (si >= 0) { ghostV[si] = 0; ghostD[si] = '0%'; }
  values.push(ghostV);
  display.push(ghostD);
  values.push(pad([]));
  display.push(pad([]));
  return { values, display };
}

function buildReferentiel(ref) {
  const cats = Object.keys(ref);
  const height = Math.max(...cats.map((c) => ref[c].length));
  const rows = [cats.slice()];
  for (let i = 0; i < height; i++) rows.push(cats.map((c) => (ref[c][i] != null ? ref[c][i] : '')));
  return { values: rows.map((r) => r.slice()), display: rows.map((r) => r.map(String)) };
}

function buildDashboardTab() {
  const rows = [['KPI', 'Valeur'], ['Total postes', '7'], ['Taux conformité', '42,9%']];
  return { values: rows, display: rows };
}

const HEADER_ROW = 1; // 0-based grid row of the headers (row 0 is the banner)

/** 'L' for the column of `name` in a tab built by buildTab. */
function letter(headers, name) {
  return colLetters(headers.indexOf(name) + 1);
}

/** Référentiel range of a category: "'Référentiel'!D2:D5". */
function refRange(category) {
  const cats = Object.keys(data.REFERENTIEL);
  const height = Math.max(...cats.map((c) => data.REFERENTIEL[c].length));
  const col = colLetters(cats.indexOf(category) + 1);
  return "'Référentiel'!" + col + '2:' + col + (height + 1);
}

/** Rule on the whole column `name`, from the first data row to the last row of the tab. */
function columnRule(tab, headers, name, rule) {
  const col = letter(headers, name);
  return Object.assign({ a1: col + (HEADER_ROW + 2) + ':' + col + tab.values.length }, rule);
}

/** Form additions to the postes tab (see the file comment). */
function formPostes(tab, records) {
  const H = data.POSTES_HEADERS;
  const L = (name) => letter(H, name);
  const first = HEADER_ROW + 1;
  for (let i = 0; i < records.length; i++) {
    const r = first + i;
    const R = r + 1;
    const score = L('Score conformité') + R;
    tab.values[r][H.indexOf('Score conformité')] = '=IFERROR(COUNTIF(' + L('IT Decathlon') + R + ':' +
      L('Réseau Decathlon') + R + ',"Oui")/5,0)';
    tab.values[r][H.indexOf('Niveau de risque')] = '=IF(' + score + '="","",IF(' + score + '>=0.8,"Faible","Élevé"))';
    tab.values[r][H.indexOf('Statut')] = '=IF(' + score + '>=0.8,"Conforme","Non conforme")';
  }
  // ARRAYFORMULA column after the last header: formula in the first data row, spilled values below.
  const age = H.length;
  const buy = L("Date d'achat");
  tab.values[HEADER_ROW][age] = 'Ancienneté';
  tab.display[HEADER_ROW][age] = 'Ancienneté';
  for (let r = HEADER_ROW + 1; r < tab.values.length; r++) {
    const isRecord = r - first < records.length;
    tab.values[r][age] = '';
    tab.display[r][age] = isRecord && records[r - first]["Date d'achat"] ? '5' : '';
  }
  tab.values[first][age] = '=ARRAYFORMULA(IF(' + buy + (first + 1) + ':' + buy + '="","",YEAR(TODAY())-YEAR(' + buy + (first + 1) +
    ':' + buy + ')))';
  tab.values[0][age] = '';
  tab.display[0][age] = '';
  const yesNo = { type: 'VALUE_IN_LIST', values: ['Oui', 'Non'] };
  tab.validations = [
    columnRule(tab, H, 'IT Decathlon', yesNo),
    columnRule(tab, H, 'EDR Decathlon', yesNo),
    columnRule(tab, H, 'Chiffrement disque', yesNo),
    columnRule(tab, H, 'Réseau Decathlon', yesNo),
    columnRule(tab, H, 'Criticité équipement', { type: 'VALUE_IN_LIST', values: ['Haute', 'Moyenne', 'Basse'] }),
    columnRule(tab, H, 'OS', { type: 'VALUE_IN_RANGE', range: refRange('OS') }),
    columnRule(tab, H, 'Équipe', { type: 'VALUE_IN_RANGE', range: refRange('Équipe'), allowInvalid: true }),
    columnRule(tab, H, "Date d'achat", { type: 'DATE_IS_VALID_DATE' }),
  ];
}

/** Form additions to the applications tab (see the file comment). */
function formApplications(tab) {
  const H = data.APPS_HEADERS;
  const dup = H.length;
  const key = letter(H, 'Nom du logiciel / service');
  for (let r = 0; r < tab.values.length; r++) {
    tab.values[r][dup] = '';
    tab.display[r][dup] = '';
  }
  tab.values[HEADER_ROW][dup] = '={"Doublon";ARRAYFORMULA(IF(' + key + '3:' + key + '="","",COUNTIF(' + key + '3:' + key + ',' +
    key + '3:' + key + ')>1))}';
  tab.display[HEADER_ROW][dup] = 'Doublon';
  const yesNo = { type: 'VALUE_IN_LIST', values: ['Oui', 'Non'] };
  tab.validations = [
    columnRule(tab, H, 'Contrat', yesNo),
    columnRule(tab, H, 'SIP', yesNo),
    columnRule(tab, H, 'Type', { type: 'VALUE_IN_RANGE', range: refRange('Type'), allowInvalid: true }),
  ];
}

/**
 * @param {string} month one of the keys of data.MONTHS (default '2026-05')
 * @param {{form?:boolean}} [opts] form: formulas, array columns and data validation (see above)
 * @returns {{id:string,name:string,timeZone:string,sheets:Object<string,{values:any[][],display:string[][]}>}}
 */
function buildSourceSpreadsheet(month, opts) {
  const m = data.MONTHS[month || '2026-05'];
  if (!m) throw new Error('Unknown fixture month ' + month);
  const postes = buildTab('Suivi des postes — Shadow IT Industry', data.POSTES_HEADERS, m.postes);
  const apps = buildTab('Suivi des applications — Shadow IT Industry', data.APPS_HEADERS, m.applications);
  if (opts && opts.form) {
    formPostes(postes, m.postes);
    formApplications(apps);
  }
  return {
    id: SOURCE_ID,
    name: 'ShadowIT_Industry',
    timeZone: 'Europe/Paris',
    sheets: {
      'Suivi des postes': postes,
      'Suivi des applications': apps,
      'Référentiel': buildReferentiel(data.REFERENTIEL),
      'Dashboard': buildDashboardTab(),
    },
  };
}

module.exports = { buildSourceSpreadsheet, SOURCE_ID };
