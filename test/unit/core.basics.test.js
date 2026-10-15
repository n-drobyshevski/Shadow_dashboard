'use strict';
/**
 * Unit tests for src/Core.js — constants (§1) and basic value helpers (§2).
 * Core.js is an Apps Script file (not a CommonJS module): it is evaluated with node:vm.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', '..', 'src', 'Core.js');

/** Evaluates Core.js in this realm (so deepStrictEqual sees the same Object/Array prototypes). */
function loadCore() {
  const code = fs.readFileSync(SRC, 'utf8');
  return vm.runInThisContext('(function () {\n' + code + '\nreturn Core;\n})()', { filename: SRC });
}

const Core = loadCore();
const NBSP = ' ';

// ------------------------------------------------------------------------------------------ §1
test('constants match the contract', () => {
  assert.equal(Core.THRESHOLD, 80);
  assert.equal(Core.KEY_POSTE, 'Nom du poste');
  assert.equal(Core.KEY_APP, 'Nom du logiciel / service');
  assert.equal(Core.GENERIC_POSTE_NAME, 'Poste générique Decathlon');
  assert.deepEqual(Core.RISK_ORDER, ['Critique', 'Élevé', 'Moyen', 'Faible']);
  assert.deepEqual(Core.RISK_COLORS,
    { 'Critique': '#e74c3c', 'Élevé': '#e67e22', 'Moyen': '#f39c12', 'Faible': '#2ecc71' });
  assert.equal(Core.COLOR_OK, '#2ecc71');
  assert.equal(Core.COLOR_KO, '#e74c3c');
  assert.equal(Core.COLOR_THRESHOLD, '#2c3e50');
  assert.deepEqual(Core.APP_REQUIRED_FIELDS,
    ['Éditeur', 'Type', 'Équipe', 'Installé sur poste', 'Niveau de risque', 'Données sensibles exposées']);
  assert.deepEqual(Core.APP_CUSTOM_FIELDS, ['Galink', 'IDP']);
  assert.deepEqual(Core.YES_NO_COLS,
    ['Galink', 'IDP', 'Contrat', 'SIP', 'IT Decathlon', 'EDR Decathlon', 'Réseau Decathlon', 'Enrolée']);
  assert.deepEqual(Core.POSTE_DIFF_COLS, ['Score conformité', 'IT Decathlon', 'EDR Decathlon',
    'Chiffrement disque', 'Type de compte', 'Réseau Decathlon', 'Action corrective', 'Statut', 'Niveau de risque']);
  assert.equal(Core.POSTE_TEMPLATE_KEYS.length, 25);
  assert.deepEqual(Core.POSTE_TEMPLATE_KEYS, require('../fixtures/data').POSTES_HEADERS);
  assert.deepEqual(Core.COLUMN_REF_ALIASES, { 'Bâtiment / Labo': 'Bâtiment' });
  assert.deepEqual(Core.ACTION_STATUSES, ['À faire', 'En cours', 'Terminé', 'Abandonné']);
  assert.deepEqual(Core.ACTION_PRIORITIES, ['Haute', 'Moyenne', 'Basse']);
  assert.deepEqual(Core.SOURCE_TABS,
    { postes: 'Suivi des postes', applications: 'Suivi des applications', referentiel: 'Référentiel' });
  assert.deepEqual(Core.ERROR_CODES,
    ['NOT_CONFIGURED', 'MONTH_EXISTS', 'NOT_FOUND', 'BUSY', 'VALIDATION', 'SOURCE_ERROR', 'INTERNAL']);
});

test('constants are frozen (shared state cannot be corrupted)', () => {
  assert.ok(Object.isFrozen(Core.RISK_ORDER));
  assert.ok(Object.isFrozen(Core.RISK_COLORS));
  assert.throws(() => { 'use strict'; Core.RISK_ORDER.push('x'); });
  assert.equal(Core.RISK_ORDER.length, 4);
});

test('constant strings are NFC (accents typed precomposed)', () => {
  const all = JSON.stringify([Core.RISK_ORDER, Core.APP_REQUIRED_FIELDS, Core.YES_NO_COLS,
    Core.POSTE_TEMPLATE_KEYS, Core.ACTION_STATUSES, Core.SOURCE_TABS, Core.GENERIC_POSTE_NAME]);
  assert.equal(all, all.normalize('NFC'));
});

// ------------------------------------------------------------------------------------------ normKey
test('normKey normalises unicode, NBSP, whitespace and case', () => {
  assert.equal(Core.normKey('  Équipe  '), 'équipe');
  assert.equal(Core.normKey('Équipe'), 'équipe'); // NFD -> NFC
  assert.equal(Core.normKey('Équipe'), Core.normKey('Équipe'));
  assert.equal(Core.normKey('Bâtiment' + NBSP + '/ Labo'), 'bâtiment / labo');
  assert.equal(Core.normKey('Nom   du\tposte'), 'nom du poste');
  assert.equal(Core.normKey('Suivi des postes '), 'suivi des postes');
  assert.equal(Core.normKey(null), '');
  assert.equal(Core.normKey(undefined), '');
  assert.equal(Core.normKey(NaN), '');
  assert.equal(Core.normKey(42), '42');
  assert.equal(Core.normKey(''), '');
});

// ------------------------------------------------------------------------------------------ isBlank / str
test('isBlank', () => {
  for (const v of [null, undefined, NaN, '', '   ', NBSP, '\t\n']) assert.equal(Core.isBlank(v), true, String(v));
  for (const v of [0, 'a', ' 0 ', false, 1, {}, []]) assert.equal(Core.isBlank(v), false, String(v));
});

test('str', () => {
  assert.equal(Core.str(null), '');
  assert.equal(Core.str(undefined), '');
  assert.equal(Core.str(NaN), '');
  assert.equal(Core.str('  x  '), 'x');
  assert.equal(Core.str(NBSP + 'x' + NBSP), 'x');
  assert.equal(Core.str(0), '0');
  assert.equal(Core.str(12.5), '12.5');
  assert.equal(Core.str(false), 'false');
});

// ------------------------------------------------------------------------------------------ parseScore
test('parseScore — contract examples', () => {
  assert.equal(Core.parseScore('30,4%'), 30.4);
  assert.equal(Core.parseScore('25%'), 25);
  assert.equal(Core.parseScore('25'), 25);
  assert.equal(Core.parseScore('0,5'), 50);
  assert.equal(Core.parseScore(0.304), 30.4);
  assert.equal(Core.parseScore(85), 85);
  assert.equal(Core.parseScore(1), 100);
  assert.equal(Core.parseScore(0), 0);
  assert.equal(Core.parseScore(''), null);
  assert.equal(Core.parseScore('abc'), null);
});

test('parseScore — edge cases', () => {
  assert.equal(Core.parseScore(null), null);
  assert.equal(Core.parseScore(undefined), null);
  assert.equal(Core.parseScore(NaN), null);
  assert.equal(Core.parseScore(Infinity), null);
  assert.equal(Core.parseScore('   '), null);
  assert.equal(Core.parseScore('%'), null);
  assert.equal(Core.parseScore('30,4' + NBSP + '%'), 30.4);
  assert.equal(Core.parseScore('30,4 %'), 30.4);
  assert.equal(Core.parseScore(' 100 % '), 100);
  assert.equal(Core.parseScore('1%'), 1); // explicit percent: as-is
  assert.equal(Core.parseScore('1'), 100); // fraction rule
  assert.equal(Core.parseScore('0%'), 0);
  assert.equal(Core.parseScore('0.304'), 30.4);
  assert.equal(Core.parseScore('80.0'), 80);
  assert.equal(Core.parseScore(1.5), 1.5);
  assert.equal(Core.parseScore('12abc'), null);
  assert.equal(Core.parseScore('1,2,3'), null);
  assert.equal(Core.parseScore(true), null);
  assert.equal(Core.parseScore({}), null);
  assert.equal(Core.parseScore(new Date()), null);
});

// ------------------------------------------------------------------------------------------ makeError
test('makeError', () => {
  const e = Core.makeError('NOT_FOUND', 'Mois introuvable');
  assert.ok(e instanceof Error);
  assert.equal(e.code, 'NOT_FOUND');
  assert.equal(e.message, 'Mois introuvable');
  assert.equal(Core.makeError('BUSY').message, 'BUSY');
});

// ------------------------------------------------------------------------------------------ dates & months
test('validateMonth', () => {
  for (const m of ['2026-01', '2026-12', '1999-09']) assert.equal(Core.validateMonth(m), true, m);
  for (const m of ['2026-13', '2026-00', '2026-1', '26-01', '2026-01-01', '', null, undefined, 202601, ' 2026-01'])
    assert.equal(Core.validateMonth(m), false, String(m));
});

test('currentMonth / fmtDDMMYYYY use local getters', () => {
  assert.equal(Core.currentMonth(new Date(2026, 0, 31, 23, 59)), '2026-01');
  assert.equal(Core.currentMonth(new Date(2026, 11, 1)), '2026-12');
  assert.match(Core.currentMonth(), /^\d{4}-\d{2}$/);
  assert.equal(Core.currentMonth(new Date('invalid')), '');
  assert.equal(Core.fmtDDMMYYYY(new Date(2025, 2, 5)), '05/03/2025');
  assert.equal(Core.fmtDDMMYYYY(new Date(2025, 11, 31, 23, 59, 59)), '31/12/2025');
  assert.equal(Core.fmtDDMMYYYY(new Date('invalid')), '');
  assert.equal(Core.fmtDDMMYYYY('15/03/2025'), '');
  assert.equal(Core.fmtDDMMYYYY(null), '');
  assert.equal(Core.fmtDDMMYYYY(0), '');
});

test('fmtDDMMYYYY accepts a Date from another realm', () => {
  const foreign = vm.runInNewContext('new Date(2025, 2, 15)');
  assert.equal(Core.fmtDDMMYYYY(foreign), '15/03/2025');
});

test('frToIso / isoToFr', () => {
  assert.equal(Core.frToIso('15/03/2025'), '2025-03-15');
  assert.equal(Core.frToIso(' 15/03/2025 '), '2025-03-15');
  assert.equal(Core.frToIso('5/3/2025'), '2025-03-05');
  assert.equal(Core.frToIso('2025-03-15'), '');
  assert.equal(Core.frToIso('32/01/2025'), '');
  assert.equal(Core.frToIso('15/13/2025'), '');
  assert.equal(Core.frToIso(''), '');
  assert.equal(Core.frToIso(null), '');
  assert.equal(Core.isoToFr('2025-03-15'), '15/03/2025');
  assert.equal(Core.isoToFr('15/03/2025'), '');
  assert.equal(Core.isoToFr('2025-3-15'), '');
  assert.equal(Core.isoToFr('2025-00-10'), '');
  assert.equal(Core.isoToFr(undefined), '');
  // round trip
  assert.equal(Core.isoToFr(Core.frToIso('01/02/2026')), '01/02/2026');
});

test('sortMonths / previousMonth', () => {
  assert.deepEqual(Core.sortMonths(['2026-05', '2026-04', 'bad', '2026-05', null, '2025-12']),
    ['2025-12', '2026-04', '2026-05']);
  assert.deepEqual(Core.sortMonths(null), []);
  assert.deepEqual(Core.sortMonths([]), []);
  const months = ['2026-05', '2026-01', '2026-04'];
  assert.equal(Core.previousMonth(months, '2026-05'), '2026-04');
  assert.equal(Core.previousMonth(months, '2026-04'), '2026-01');
  assert.equal(Core.previousMonth(months, '2026-03'), '2026-01');
  assert.equal(Core.previousMonth(months, '2026-01'), null);
  assert.equal(Core.previousMonth(months, '2027-01'), '2026-05');
  assert.equal(Core.previousMonth([], '2026-05'), null);
  assert.equal(Core.previousMonth(null, '2026-05'), null);
  assert.equal(Core.previousMonth(months, 'bad'), null);
});

// ------------------------------------------------------------------------------------------ ids / escaping
test('extractSpreadsheetId', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_SRC';
  assert.equal(Core.extractSpreadsheetId(id), id);
  assert.equal(Core.extractSpreadsheetId('  ' + id + '  '), id);
  assert.equal(Core.extractSpreadsheetId('https://docs.google.com/spreadsheets/d/' + id + '/edit#gid=0'), id);
  assert.equal(Core.extractSpreadsheetId('https://docs.google.com/spreadsheets/d/' + id), id);
  assert.equal(Core.extractSpreadsheetId('https://docs.google.com/spreadsheets/u/1/d/' + id + '/edit?usp=sharing'), id);
  assert.equal(Core.extractSpreadsheetId('1-abc_DEF-ghi_JKL-mno'), '1-abc_DEF-ghi_JKL-mno');
  assert.equal(Core.extractSpreadsheetId('short'), null);
  assert.equal(Core.extractSpreadsheetId('https://example.com/foo'), null);
  assert.equal(Core.extractSpreadsheetId('https://docs.google.com/spreadsheets/d/abc/edit'), null);
  assert.equal(Core.extractSpreadsheetId('has space in the middle of id'), null);
  assert.equal(Core.extractSpreadsheetId(''), null);
  assert.equal(Core.extractSpreadsheetId(null), null);
});

test('escapeFormula', () => {
  assert.equal(Core.escapeFormula('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(Core.escapeFormula('+33 6'), "'+33 6");
  assert.equal(Core.escapeFormula('-1'), "'-1");
  assert.equal(Core.escapeFormula('@user'), "'@user");
  assert.equal(Core.escapeFormula('2026-05'), '2026-05');
  assert.equal(Core.escapeFormula(' =x'), ' =x');
  assert.equal(Core.escapeFormula(''), '');
  assert.equal(Core.escapeFormula(-1), -1);
  assert.equal(Core.escapeFormula(null), null);
  assert.equal(Core.escapeFormula(undefined), undefined);
});
