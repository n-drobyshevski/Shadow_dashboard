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
 */
const data = require('./data');

const SOURCE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_SRC';

function parseFr(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || ''));
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
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

/**
 * @param {string} month one of the keys of data.MONTHS (default '2026-05')
 * @returns {{id:string,name:string,timeZone:string,sheets:Object<string,{values:any[][],display:string[][]}>}}
 */
function buildSourceSpreadsheet(month) {
  const m = data.MONTHS[month || '2026-05'];
  if (!m) throw new Error('Unknown fixture month ' + month);
  return {
    id: SOURCE_ID,
    name: 'ShadowIT_Industry',
    timeZone: 'Europe/Paris',
    sheets: {
      'Suivi des postes': buildTab('Suivi des postes — Shadow IT Industry', data.POSTES_HEADERS, m.postes),
      'Suivi des applications': buildTab('Suivi des applications — Shadow IT Industry', data.APPS_HEADERS, m.applications),
      'Référentiel': buildReferentiel(data.REFERENTIEL),
      'Dashboard': buildDashboardTab(),
    },
  };
}

module.exports = { buildSourceSpreadsheet, SOURCE_ID };
