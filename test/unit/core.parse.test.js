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

// ------------------------------------------------------------------------------------------ parseReferentiel
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
