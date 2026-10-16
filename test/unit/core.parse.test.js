'use strict';
/**
 * Unit tests for src/Core.js — source sheet parsing: findHeaderRow, rowsToRecords, parseReferentiel.
 * Uses the fake live spreadsheet from test/fixtures/source.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const data = require('../fixtures/data');
const { buildSourceSpreadsheet } = require('../fixtures/source');

const SRC = path.join(__dirname, '..', '..', 'src', 'Core.js');
function loadCore() {
  const code = fs.readFileSync(SRC, 'utf8');
  return vm.runInThisContext('(function () {\n' + code + '\nreturn Core;\n})()', { filename: SRC });
}
const Core = loadCore();
const NBSP = ' ';

// ------------------------------------------------------------------------------------------ findHeaderRow
test('findHeaderRow finds the first row containing an anchor (normKey match)', () => {
  const rows = [
    ['Suivi des postes — Shadow IT Industry', '', ''],
    ['', '', ''],
    ['N° Visite', ' NOM DU' + NBSP + 'POSTE ', 'Équipe'],
    ['V-001', 'LAB-TEX-01', 'Labo Textile'],
  ];
  assert.equal(Core.findHeaderRow(rows, ['Nom du poste']), 2);
  assert.equal(Core.findHeaderRow(rows, ['absent', 'Équipe']), 2); // NFD anchor
  assert.equal(Core.findHeaderRow(rows, 'Nom du poste'), 2); // single anchor string tolerated
  assert.equal(Core.findHeaderRow(rows, ['absent']), -1);
  assert.equal(Core.findHeaderRow(rows, []), -1);
  assert.equal(Core.findHeaderRow(rows, ['']), -1); // blank anchor never matches blank cells
  assert.equal(Core.findHeaderRow(null, ['x']), -1);
  assert.equal(Core.findHeaderRow([], ['x']), -1);
  assert.equal(Core.findHeaderRow([null, ['x']], ['x']), 1);
});

test('findHeaderRow honours maxScan (default 15)', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(['']);
  rows[15] = ['Nom du poste'];
  assert.equal(Core.findHeaderRow(rows, ['Nom du poste']), -1);
  assert.equal(Core.findHeaderRow(rows, ['Nom du poste'], 16), 15);
  rows[14] = ['Nom du poste'];
  assert.equal(Core.findHeaderRow(rows, ['Nom du poste']), 14);
  assert.equal(Core.findHeaderRow(rows, ['Nom du poste'], 3), -1);
});

// ------------------------------------------------------------------------------------------ rowsToRecords
for (const month of Object.keys(data.MONTHS)) {
  test(`rowsToRecords on the fake source "Suivi des postes" (${month})`, () => {
    const tab = buildSourceSpreadsheet(month).sheets['Suivi des postes'];
    const res = Core.rowsToRecords({
      display: tab.display, raw: tab.values, anchors: [Core.KEY_POSTE], keyField: Core.KEY_POSTE,
    });
    // Banner skipped; NBSP / trailing-space headers cleaned to their canonical names.
    assert.deepEqual(res.headers, data.POSTES_HEADERS);
    // Records identical to the canonical data (score kept as display '30,4%', Date cells formatted).
    assert.deepEqual(res.records, data.MONTHS[month].postes);
    // Two fully empty ghost rows dropped silently; the score-only row is counted.
    assert.deepEqual(res.warnings, ['1 ligne(s) sans « Nom du poste » ignorée(s)']);
  });

  test(`rowsToRecords on the fake source "Suivi des applications" (${month})`, () => {
    const tab = buildSourceSpreadsheet(month).sheets['Suivi des applications'];
    const res = Core.rowsToRecords({
      display: tab.display, raw: tab.values, anchors: [Core.KEY_APP], keyField: Core.KEY_APP,
    });
    assert.deepEqual(res.headers, data.APPS_HEADERS);
    assert.deepEqual(res.records, data.MONTHS[month].applications);
    assert.deepEqual(res.warnings, ['1 ligne(s) sans « Nom du logiciel / service » ignorée(s)']);
  });
}

test('rowsToRecords: Date cells use raw values through fmtDate (fallback fmtDDMMYYYY)', () => {
  const display = [['Nom du poste', 'Date visite'], ['P1', '3/12/2026'], ['P2', 'texte libre']];
  const raw = [['Nom du poste', 'Date visite'], ['P1', new Date(2026, 2, 12)], ['P2', 'texte libre']];
  const res = Core.rowsToRecords({ display, raw, anchors: ['Nom du poste'], keyField: 'Nom du poste' });
  assert.deepEqual(res.records, [
    { 'Nom du poste': 'P1', 'Date visite': '12/03/2026' },
    { 'Nom du poste': 'P2', 'Date visite': 'texte libre' },
  ]);
  const custom = Core.rowsToRecords({
    display, raw, anchors: ['Nom du poste'], keyField: 'Nom du poste',
    fmtDate: (d) => 'D' + d.getFullYear(),
  });
  assert.equal(custom.records[0]['Date visite'], 'D2026');
  // A Date created in another realm (e.g. GAS / vm) is still detected.
  const foreign = vm.runInNewContext('new Date(2026, 0, 2)');
  const r2 = Core.rowsToRecords({
    display: [['Nom du poste', 'D'], ['P', 'x']], raw: [['Nom du poste', 'D'], ['P', foreign]],
    keyField: 'Nom du poste',
  });
  assert.equal(r2.records[0].D, '02/01/2026');
  // An invalid Date falls back to the display value.
  const r3 = Core.rowsToRecords({
    display: [['Nom du poste', 'D'], ['P', 'n/a']], raw: [['Nom du poste', 'D'], ['P', new Date('bad')]],
    keyField: 'Nom du poste',
  });
  assert.equal(r3.records[0].D, 'n/a');
});

test('rowsToRecords: raw omitted, blank headers dropped, duplicates suffixed, values trimmed', () => {
  const display = [
    ['Nom du poste', '', 'OS', 'OS', ' OS ', NBSP],
    [' P1 ', 'ignored', ' Windows ', 'x', 'y', 'z'],
    ['P2', '', '', '', '', ''],
  ];
  const res = Core.rowsToRecords({ display, anchors: ['Nom du poste'], keyField: 'Nom du poste' });
  assert.deepEqual(res.headers, ['Nom du poste', 'OS', 'OS (2)', 'OS (3)']);
  assert.deepEqual(res.records, [
    { 'Nom du poste': 'P1', 'OS': 'Windows', 'OS (2)': 'x', 'OS (3)': 'y' },
    { 'Nom du poste': 'P2', 'OS': null, 'OS (2)': null, 'OS (3)': null },
  ]);
  assert.deepEqual(res.warnings, []);
});

test('rowsToRecords: NFD headers are normalised to NFC, key header gets canonical spelling', () => {
  const display = [
    ['nom du  poste', 'Équipe', 'Bâtiment' + NBSP + '/ Labo'],
    ['P1', 'Labo Textile', 'Bâtiment A'],
  ];
  const res = Core.rowsToRecords({ display, anchors: ['Nom du poste'], keyField: 'Nom du poste' });
  assert.deepEqual(res.headers, ['Nom du poste', 'Équipe', 'Bâtiment / Labo']);
  assert.equal(res.records[0]['Équipe'], 'Labo Textile');
  assert.equal(res.records[0]['Bâtiment / Labo'], 'Bâtiment A');
});

test('rowsToRecords: ragged rows, counted key-less rows, numeric cells', () => {
  const display = [
    ['Nom du poste', 'Score conformité', 'Statut'],
    ['P1', '30,4%'],
    ['', '50%', 'x'],
    [null, 0, null],
    [],
    ['', '', ''],
    [0, 12, 'ok'],
  ];
  const res = Core.rowsToRecords({ display, anchors: ['Nom du poste'], keyField: 'Nom du poste' });
  assert.deepEqual(res.records, [
    { 'Nom du poste': 'P1', 'Score conformité': '30,4%', 'Statut': null },
    { 'Nom du poste': '0', 'Score conformité': '12', 'Statut': 'ok' },
  ]);
  assert.deepEqual(res.warnings, ['2 ligne(s) sans « Nom du poste » ignorée(s)']);
});

test('rowsToRecords: without keyField nothing is counted', () => {
  const display = [['A', 'B'], ['', 'x'], ['', '']];
  const res = Core.rowsToRecords({ display, anchors: ['A'] });
  assert.deepEqual(res.records, [{ A: null, B: 'x' }]);
  assert.deepEqual(res.warnings, []);
});

test('rowsToRecords: header row not found / key column missing -> SOURCE_ERROR', () => {
  assert.throws(
    () => Core.rowsToRecords({ display: [['foo'], ['bar']], anchors: ['Nom du poste'], keyField: 'Nom du poste' }),
    (e) => e.code === 'SOURCE_ERROR' && /Nom du poste/.test(e.message));
  assert.throws(() => Core.rowsToRecords({}), (e) => e.code === 'SOURCE_ERROR');
  assert.throws(() => Core.rowsToRecords(null), (e) => e.code === 'SOURCE_ERROR');
  assert.throws(
    () => Core.rowsToRecords({ display: [['Équipe'], ['x']], anchors: ['Équipe'], keyField: 'Nom du poste' }),
    (e) => e.code === 'SOURCE_ERROR');
});

test('rowsToRecords: header row beyond maxScan (15) is not found', () => {
  const display = [];
  for (let i = 0; i < 16; i++) display.push(['banner']);
  display.push(['Nom du poste'], ['P1']);
  assert.throws(() => Core.rowsToRecords({ display, keyField: 'Nom du poste' }), (e) => e.code === 'SOURCE_ERROR');
});

test('rowsToRecords: « _ » headers are ignored with a warning (never a record field, even "__proto__")', () => {
  const display = [
    ['Nom du poste', '_id', ' _updated_at', '__proto__', 'OS'],
    ['P1', 'x', '2030-01-01T00:00:00.000Z', '{"a":1}', 'Linux'],
  ];
  const res = Core.rowsToRecords({ display, keyField: 'Nom du poste' });
  assert.deepEqual(res.headers, ['Nom du poste', 'OS']);
  assert.deepEqual(res.columns, [0, 4]);
  assert.deepEqual(Object.keys(res.records[0]), ['Nom du poste', 'OS']);
  assert.equal(Object.getPrototypeOf(res.records[0]), Object.prototype);
  assert.deepEqual(res.warnings, ['Colonnes « _id », « _updated_at », « __proto__ » ignorées : les noms commençant par ' +
    '« _ » sont réservés à l’application.']);
  const one = Core.rowsToRecords({ display: [['Nom du poste', '_x'], ['P1', 'y']], keyField: 'Nom du poste' });
  assert.deepEqual(one.warnings, ['Colonne « _x » ignorée : les noms commençant par « _ » sont réservés à l’application.']);
  const many = Core.rowsToRecords({ display: [['Nom du poste', '_a', '_b', '_c', '_d', '_e', '_f', '_g'], ['P1']],
    keyField: 'Nom du poste' });
  assert.match(many.warnings[0], /^Colonnes « _a », « _b », « _c », « _d », « _e » et 2 autre\(s\) ignorées/);
});

test('rowsToRecords: duplicate headers are suffixed in linear time, with the same names as before', () => {
  const display = [['Nom du poste', 'OS', 'OS (3)', 'OS', 'OS', 'OS (2)', 'OS'], ['P1', 'a', 'b', 'c', 'd', 'e', 'f']];
  const res = Core.rowsToRecords({ display, keyField: 'Nom du poste' });
  // The literal « OS (3) » is skipped; a literal « OS (2) » after the generated one is suffixed itself.
  assert.deepEqual(res.headers, ['Nom du poste', 'OS', 'OS (3)', 'OS (2)', 'OS (4)', 'OS (2) (2)', 'OS (5)']);
  // 500 identical headers (the width limit): suffixed 2..499 (the key column is the first header).
  const wide = [['Nom du poste'].concat(Array(Core.LIMITS.sourceColumns - 1).fill('x')), ['P1']];
  const t0 = Date.now();
  const big = Core.rowsToRecords({ display: wide, keyField: 'Nom du poste' });
  assert.ok(Date.now() - t0 < 500);
  assert.equal(big.headers[1], 'x');
  assert.equal(big.headers[2], 'x (2)');
  assert.equal(big.headers[499], 'x (499)');
  assert.equal(new Set(big.headers).size, 500);
});

test('rowsToRecords: more than LIMITS.sourceColumns non-blank headers -> SOURCE_ERROR naming the tab', () => {
  const max = Core.LIMITS.sourceColumns;
  const headers = ['Nom du poste'];
  for (let i = 1; i < max; i++) headers.push('C' + i, '', ' '); // blank header cells do not count
  assert.equal(Core.rowsToRecords({ display: [headers, ['P1']], keyField: 'Nom du poste' }).headers.length, max);
  headers.push('_réservée'); // counted: it is a non-blank header cell
  assert.throws(() => Core.rowsToRecords({ display: [headers, ['P1']], keyField: 'Nom du poste', tab: 'Suivi des postes' }),
    (e) => e.code === 'SOURCE_ERROR' && e.message === 'Onglet « Suivi des postes » : ' + (max + 1) + ' colonnes ont un ' +
      'en-tête, au plus ' + max + ' sont acceptées. Supprimez les colonnes inutiles du Google Sheet source.');
  assert.throws(() => Core.rowsToRecords({ display: [headers, ['P1']], keyField: 'Nom du poste' }),
    (e) => e.code === 'SOURCE_ERROR' && /^Ligne d’en-tête : 501 colonnes/.test(e.message));
});

test('rowsToRecords: more than LIMITS.sourceRecords records -> SOURCE_ERROR naming the tab', () => {
  const max = Core.LIMITS.sourceRecords;
  const display = [['Nom du poste']];
  for (let i = 0; i < max; i++) display.push(['P' + i], [''], ['']); // blank rows do not count
  assert.equal(Core.rowsToRecords({ display, keyField: 'Nom du poste' }).records.length, max);
  display.push(['P' + max]);
  assert.throws(() => Core.rowsToRecords({ display, keyField: 'Nom du poste', tab: 'Suivi des applications' }),
    (e) => e.code === 'SOURCE_ERROR' &&
      e.message === 'Onglet « Suivi des applications » : plus de 5000 lignes à importer, au plus 5000 sont acceptées.');
});

test('rowsToRecords: values beyond LIMITS.cellChars and headers beyond LIMITS.headerChars are truncated, with warnings', () => {
  const { cellChars, headerChars } = Core.LIMITS;
  const longHeader = 'H'.repeat(headerChars + 50);
  const longKey = 'K'.repeat(cellChars + 1);
  const display = [['Nom du poste', 'Notes', longHeader], ['P1', 'n'.repeat(cellChars + 1), 'ok'], [longKey, 'n', '']];
  const res = Core.rowsToRecords({ display, keyField: 'Nom du poste' });
  assert.deepEqual(res.headers, ['Nom du poste', 'Notes', 'H'.repeat(headerChars)]);
  assert.equal(res.records[0].Notes, 'n'.repeat(cellChars));
  assert.equal(res.records[1]['Nom du poste'], 'K'.repeat(cellChars));
  assert.deepEqual(res.warnings, [
    'En-tête(s) de colonne tronqué(s) à ' + headerChars + ' caractères : « ' + 'H'.repeat(60) + '… ».',
    '« P1 », colonne « Notes » : valeur tronquée à ' + cellChars + ' caractères.',
    '« ' + 'K'.repeat(60) + '… », colonne « Nom du poste » : valeur tronquée à ' + cellChars + ' caractères.',
  ]);
  // Exactly the limit is kept as is; beyond 5 truncated values, the others are counted.
  const rows = [['Nom du poste', 'A', 'B']];
  for (let i = 0; i < 4; i++) rows.push(['P' + i, 'a'.repeat(cellChars + 1), 'b'.repeat(cellChars + 1)]);
  rows.push(['Q', 'a'.repeat(cellChars), '']);
  const many = Core.rowsToRecords({ display: rows, keyField: 'Nom du poste' });
  assert.equal(many.records[4].A.length, cellChars);
  assert.equal(many.warnings.length, 6);
  assert.equal(many.warnings[5], '3 autre(s) valeur(s) tronquée(s) à ' + cellChars + ' caractères.');
  // Without keyField, the record is named by its sheet row.
  const noKey = Core.rowsToRecords({ display: [['A'], ['x'.repeat(cellChars + 1)]], anchors: ['A'] });
  assert.deepEqual(noKey.warnings, ['« ligne 2 », colonne « A » : valeur tronquée à ' + cellChars + ' caractères.']);
});

// ------------------------------------------------------------------------------------------ parseReferentiel
test('parseReferentiel: limits on categories, values per category and lengths', () => {
  const { refCategories, refValues, cellChars, headerChars } = Core.LIMITS;
  const cats = Array.from({ length: refCategories }, (_, i) => 'C' + i);
  assert.equal(Object.keys(Core.parseReferentiel([cats.concat(['C0']), cats.map(() => 'v')])).length, refCategories);
  assert.throws(() => Core.parseReferentiel([cats.concat(['Une de trop']), ['v']]),
    (e) => e.code === 'SOURCE_ERROR' && e.message === 'Onglet « Référentiel » : plus de ' + refCategories +
      ' catégories, au plus ' + refCategories + ' sont acceptées.');

  const col = [['OS']];
  for (let i = 0; i < refValues; i++) col.push(['v' + i], ['v' + i]); // duplicates do not count
  assert.equal(Core.parseReferentiel(col).OS.length, refValues);
  col.push(['v' + refValues]);
  assert.throws(() => Core.parseReferentiel(col),
    (e) => e.code === 'SOURCE_ERROR' && e.message === 'Onglet « Référentiel » : la catégorie « OS » a plus de ' +
      refValues + ' valeurs, au plus ' + refValues + ' sont acceptées.');

  const wide = [Array.from({ length: Core.LIMITS.sourceColumns + 1 }, () => 'Même catégorie')];
  assert.throws(() => Core.parseReferentiel(wide), (e) => e.code === 'SOURCE_ERROR' && /^Onglet « Référentiel » : 501 colonnes/.test(e.message));

  const long = Core.parseReferentiel([['L'.repeat(headerChars + 1)], ['v'.repeat(cellChars + 9)], ['v'.repeat(cellChars)]]);
  assert.deepEqual(long, { ['L'.repeat(headerChars)]: ['v'.repeat(cellChars)] });
  // "__proto__" is an ordinary category and value.
  const proto = Core.parseReferentiel([['__proto__'], ['__proto__'], ['constructor']]);
  assert.deepEqual(Object.keys(proto), ['__proto__']);
  assert.deepEqual(proto['__proto__'], ['__proto__', 'constructor']);
});

test('parseReferentiel on the fake source tab reproduces the référentiel', () => {
  const tab = buildSourceSpreadsheet('2026-05').sheets['Référentiel'];
  assert.deepEqual(Core.parseReferentiel(tab.display), data.REFERENTIEL);
  assert.deepEqual(Object.keys(Core.parseReferentiel(tab.display)), Object.keys(data.REFERENTIEL));
});

test('parseReferentiel: ragged, leading blank rows, blanks skipped, trimmed, de-duplicated', () => {
  const display = [
    ['', '', ''],
    [' Statut ', '', 'OS' + NBSP],
    ['Conforme', 'orphan', 'Windows'],
    ['', 'orphan', ' Windows '],
    [' En cours'],
    ['Conforme', null, 'Linux'],
    null,
    ['À traiter', undefined, ''],
  ];
  assert.deepEqual(Core.parseReferentiel(display), {
    'Statut': ['Conforme', 'En cours', 'À traiter'],
    'OS': ['Windows', 'Linux'],
  });
});

test('parseReferentiel: duplicate category columns merge; empty input', () => {
  assert.deepEqual(Core.parseReferentiel([['A', 'A'], ['1', '2'], ['2', '3']]), { A: ['1', '2', '3'] });
  assert.deepEqual(Core.parseReferentiel([['A'], []]), { A: [] });
  assert.deepEqual(Core.parseReferentiel([]), {});
  assert.deepEqual(Core.parseReferentiel([['', ''], ['', '']]), {});
  assert.deepEqual(Core.parseReferentiel(null), {});
});
