'use strict';
/**
 * Unit tests for src/Core.js — scoring, enrichment, filters, KPIs, charts helpers, relations,
 * month-to-month diffs and record helpers. Uses test/fixtures/data.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const data = require('../fixtures/data');

const SRC = path.join(__dirname, '..', '..', 'src', 'Core.js');
function loadCore() {
  const code = fs.readFileSync(SRC, 'utf8');
  return vm.runInThisContext('(function () {\n' + code + '\nreturn Core;\n})()', { filename: SRC });
}
const Core = loadCore();

/** Applications of a month with the app-only Galink/IDP fields merged in (as stored by the app). */
function appsWithCustom(month) {
  const custom = data.CUSTOM_FIELDS[month] || {};
  return data.MONTHS[month].applications.map((a) => {
    const c = custom[a[Core.KEY_APP]] || {};
    return { ...a, Galink: c.Galink == null ? null : c.Galink, IDP: c.IDP == null ? null : c.IDP };
  });
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

// ------------------------------------------------------------------------------------------ scoring
test('scoreApplication — full criteria matrix (2^5 combinations)', () => {
  const full = {
    'Éditeur': 'X', 'Type': 'SaaS', 'Équipe': 'E', 'Installé sur poste': 'P1',
    'Niveau de risque': 'Faible', 'Données sensibles exposées': 'Non',
  };
  for (let mask = 0; mask < 32; mask++) {
    const rec = {
      ...(mask & 16 ? full : { ...full, 'Éditeur': '  ' }),
      Contrat: mask & 1 ? 'Oui' : 'Non',
      SIP: mask & 2 ? ' Oui ' : null,
      IDP: mask & 4 ? 'Oui' : '',
      Galink: mask & 8 ? 'Oui' : 'oui', // case-sensitive like the Python original
    };
    const res = Core.scoreApplication(rec);
    const expected = {
      contrat: !!(mask & 1), sip: !!(mask & 2), idp: !!(mask & 4), galink: !!(mask & 8), champs: !!(mask & 16),
    };
    assert.deepEqual(res.criteria, expected, `mask ${mask}`);
    const bits = [1, 2, 4, 8, 16].filter((b) => mask & b).length;
    assert.equal(res.score, bits * 20, `mask ${mask}`);
  }
});

test('scoreApplication — each required field matters; total on null', () => {
  const base = {
    'Éditeur': 'X', 'Type': 'SaaS', 'Équipe': 'E', 'Installé sur poste': 'P1',
    'Niveau de risque': 'Faible', 'Données sensibles exposées': 'Non',
  };
  assert.equal(Core.scoreApplication(base).criteria.champs, true);
  for (const f of Core.APP_REQUIRED_FIELDS) {
    const r = { ...base };
    delete r[f];
    assert.equal(Core.scoreApplication(r).criteria.champs, false, f);
    assert.equal(Core.scoreApplication({ ...base, [f]: NaN }).criteria.champs, false, f);
  }
  assert.deepEqual(Core.scoreApplication(null),
    { score: 0, criteria: { contrat: false, sip: false, idp: false, galink: false, champs: false } });
  assert.deepEqual(Core.scoreApplication(undefined).score, 0);
});

test('scoreApplication on fixture applications', () => {
  const scores = (month) => Object.fromEntries(appsWithCustom(month).map((a) => [a[Core.KEY_APP], Core.scoreApplication(a).score]));
  assert.deepEqual(scores('2026-04'),
    { 'Minitab': 100, 'Datacolor Tools': 20, 'LabVIEW': 40, 'Dropbox perso': 0, 'Notepad++': 80 });
  assert.deepEqual(scores('2026-05'),
    { 'Minitab': 100, 'LabVIEW': 40, 'Dropbox perso': 0, 'Notepad++': 100, 'Figma': 100 });
  // Without Galink/IDP (raw source data) nothing reaches 80.
  assert.deepEqual(data.MONTHS['2026-04'].applications.map((a) => Core.scoreApplication(a).score), [60, 20, 40, 0, 60]);
});

// ------------------------------------------------------------------------------------------ enrichment
test('enrichPostes returns new objects with _score and _conforme', () => {
  const src = data.MONTHS['2026-04'].postes;
  const before = JSON.stringify(src);
  const out = Core.enrichPostes(src);
  assert.equal(JSON.stringify(src), before, 'input not mutated');
  assert.notEqual(out[0], src[0]);
  assert.deepEqual(out.map((p) => p._score), [100, 20, 60, 80, 30.4, 90]);
  assert.deepEqual(out.map((p) => p._conforme), [true, false, false, true, false, true]);
  assert.equal(out[0]['Nom du poste'], 'LAB-TEX-01');
  const edge = Core.enrichPostes([{ 'Score conformité': null }, { 'Score conformité': 'abc' },
    { 'Score conformité': 0.8 }, { 'Score conformité': '79,99%' }, {}]);
  assert.deepEqual(edge.map((p) => [p._score, p._conforme]),
    [[null, false], [null, false], [80, true], [79.99, false], [null, false]]);
  assert.deepEqual(Core.enrichPostes(null), []);
});

test('enrichApplications returns new objects with _score, _conforme, _criteria', () => {
  const src = appsWithCustom('2026-04');
  const out = Core.enrichApplications(src);
  assert.notEqual(out[0], src[0]);
  assert.equal(src[0]._score, undefined);
  assert.deepEqual(out.map((a) => a._score), [100, 20, 40, 0, 80]);
  assert.deepEqual(out.map((a) => a._conforme), [true, false, false, false, true]);
  assert.deepEqual(out[4]._criteria, { contrat: true, sip: true, idp: false, galink: true, champs: true });
  assert.deepEqual(Core.enrichApplications(undefined), []);
});

// ------------------------------------------------------------------------------------------ filters
test('uniqueSorted uses French collation and skips blanks', () => {
  const list = [{ e: 'Équipe B' }, { e: 'zèbre' }, { e: 'Alpha' }, { e: ' Alpha ' }, { e: null }, { e: '' },
    { e: 'equipe a' }, {}, null];
  assert.deepEqual(Core.uniqueSorted(list, 'e'), ['Alpha', 'equipe a', 'Équipe B', 'zèbre']);
  assert.deepEqual(Core.uniqueSorted(data.MONTHS['2026-04'].postes, 'Équipe'),
    ['Labo Chaussure', 'Labo Mécanique', 'Labo Textile', 'R&D Vélo']);
  assert.deepEqual(Core.uniqueSorted(null, 'e'), []);
});

test('filterData: Équipe filters both entities, Bâtiment filters postes only', () => {
  const d = { postes: data.MONTHS['2026-04'].postes, applications: data.MONTHS['2026-04'].applications };
  const none = Core.filterData(d, { equipes: [], batiments: [] });
  assert.equal(none.postes.length, 6);
  assert.equal(none.applications.length, 5);
  assert.notEqual(none.postes, d.postes, 'new arrays');

  const eq = Core.filterData(d, { equipes: ['Labo Textile'], batiments: [] });
  assert.deepEqual(eq.postes.map((p) => p['Nom du poste']), ['LAB-TEX-01', 'LAB-TEX-02']);
  assert.deepEqual(eq.applications.map((a) => a[Core.KEY_APP]), ['Minitab', 'Datacolor Tools']);

  const bat = Core.filterData(d, { equipes: [], batiments: ['Bâtiment C'] });
  assert.deepEqual(bat.postes.map((p) => p['Nom du poste']), ['LAB-MEC-01', 'RD-VEL-01']);
  assert.equal(bat.applications.length, 5, 'Bâtiment does not filter applications');

  const both = Core.filterData(d, { equipes: ['R&D Vélo', 'Labo Textile'], batiments: ['Bâtiment C'] });
  assert.deepEqual(both.postes.map((p) => p['Nom du poste']), ['RD-VEL-01']);
  assert.deepEqual(both.applications.map((a) => a[Core.KEY_APP]), ['Minitab', 'Datacolor Tools', 'Dropbox perso']);

  assert.deepEqual(Core.filterData(null, null), { postes: [], applications: [] });
  assert.equal(Core.filterData(d, {}).postes.length, 6);
});

// ------------------------------------------------------------------------------------------ KPIs
test('computeKpis on fixture month 2026-04', () => {
  const k = Core.computeKpis(Core.enrichPostes(data.MONTHS['2026-04'].postes),
    Core.enrichApplications(appsWithCustom('2026-04')));
  assert.deepEqual(Object.keys(k), ['total_postes', 'postes_conformes', 'postes_non_conformes', 'taux_postes',
    'total_apps', 'apps_conformes', 'apps_non_conformes', 'taux_apps', 'postes_sans_edr', 'postes_non_it',
    'postes_hors_reseau', 'apps_sans_sip', 'apps_sans_contrat', 'apps_sans_galink', 'apps_sans_idp']);
  assert.deepEqual(k, {
    total_postes: 6, postes_conformes: 3, postes_non_conformes: 3, taux_postes: 50,
    total_apps: 5, apps_conformes: 2, apps_non_conformes: 3, taux_apps: 40,
    postes_sans_edr: 3, postes_non_it: 2, postes_hors_reseau: 1,
    apps_sans_sip: 3, apps_sans_contrat: 2, apps_sans_galink: 1, apps_sans_idp: 1,
  });
});

test('computeKpis on fixture month 2026-05', () => {
  const k = Core.computeKpis(Core.enrichPostes(data.MONTHS['2026-05'].postes),
    Core.enrichApplications(appsWithCustom('2026-05')));
  close(k.taux_postes, (5 / 7) * 100);
  assert.deepEqual({ ...k, taux_postes: 0 }, {
    total_postes: 7, postes_conformes: 5, postes_non_conformes: 2, taux_postes: 0,
    total_apps: 5, apps_conformes: 3, apps_non_conformes: 2, taux_apps: 60,
    postes_sans_edr: 2, postes_non_it: 2, postes_hors_reseau: 1,
    apps_sans_sip: 2, apps_sans_contrat: 1, apps_sans_galink: 1, apps_sans_idp: 1,
  });
});

test('computeKpis: empty input -> zero rates; only exact "Non" counts', () => {
  const k = Core.computeKpis([], null);
  assert.equal(k.taux_postes, 0);
  assert.equal(k.taux_apps, 0);
  assert.equal(k.total_postes, 0);
  assert.equal(Object.keys(k).length, 15);
  const k2 = Core.computeKpis([{ 'EDR Decathlon': ' Non ', _conforme: true }, { 'EDR Decathlon': 'non' }, {}], []);
  assert.equal(k2.postes_sans_edr, 1);
  assert.equal(k2.postes_conformes, 1);
  close(k2.taux_postes, 100 / 3);
});

test('riskCounts counts the four known levels in RISK_ORDER order', () => {
  const c = Core.riskCounts(data.MONTHS['2026-04'].postes);
  assert.deepEqual(Object.keys(c), Core.RISK_ORDER);
  assert.deepEqual(c, { 'Critique': 1, 'Élevé': 1, 'Moyen': 1, 'Faible': 3 });
  assert.deepEqual(Core.riskCounts([{ 'Niveau de risque': 'Inconnu' }, { 'Niveau de risque': ' Moyen ' }, {}, null]),
    { 'Critique': 0, 'Élevé': 0, 'Moyen': 1, 'Faible': 0 });
  assert.deepEqual(Core.riskCounts(undefined), { 'Critique': 0, 'Élevé': 0, 'Moyen': 0, 'Faible': 0 });
});

// ------------------------------------------------------------------------------------------ histogram
test('histogramBins: 10 fixed bins on 0–100, edge 100 in last bin, nulls ignored', () => {
  const bins = Core.histogramBins([0, 9.99, 10, 30.4, 79.9, 80, 99.9, 100, null, undefined, NaN]);
  assert.equal(bins.length, 10);
  assert.deepEqual(bins.map((b) => [b.x0, b.x1]),
    [[0, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 100]]);
  assert.deepEqual(bins.map((b) => b.count), [2, 1, 0, 1, 0, 0, 0, 1, 1, 2]);
});

test('histogramBins: custom nbins, out-of-range ignored, empty input', () => {
  const b5 = Core.histogramBins([100, 100, 20, 19.999], 5);
  assert.deepEqual(b5.map((b) => b.count), [1, 1, 0, 0, 2]);
  assert.deepEqual(b5.map((b) => b.x1), [20, 40, 60, 80, 100]);
  const b3 = Core.histogramBins([100 / 3, 66.7], 3);
  assert.equal(b3[2].x1, 100);
  assert.deepEqual(b3.map((b) => b.count), [0, 1, 1]);
  assert.deepEqual(Core.histogramBins([-1, 101, '50']).map((b) => b.count), new Array(10).fill(0));
  assert.equal(Core.histogramBins(null).length, 10);
  assert.equal(Core.histogramBins([], 0).length, 10, 'invalid nbins -> default 10');
  const total = Core.histogramBins(Core.enrichPostes(data.MONTHS['2026-05'].postes).map((p) => p._score))
    .reduce((s, b) => s + b.count, 0);
  assert.equal(total, 7);
});

// ------------------------------------------------------------------------------------------ relations
test('buildPosteAppsRelation splits "Installé sur poste" on commas', () => {
  const apps = Core.enrichApplications(appsWithCustom('2026-04'));
  const rel = Core.buildPosteAppsRelation(apps);
  assert.deepEqual(rel.relations, [
    { poste: 'LAB-TEX-01', application: 'Minitab', equipe: 'Labo Textile', score: 100 },
    { poste: 'LAB-TEX-02', application: 'Datacolor Tools', equipe: 'Labo Textile', score: 20 },
    { poste: 'LAB-MEC-01', application: 'LabVIEW', equipe: 'Labo Mécanique', score: 40 },
    { poste: 'LAB-CHA-01', application: 'Notepad++', equipe: 'Labo Chaussure', score: 80 },
    { poste: 'LAB-CHA-02', application: 'Notepad++', equipe: 'Labo Chaussure', score: 80 },
  ]);
  assert.deepEqual(rel.byPoste['LAB-CHA-01'], [{ application: 'Notepad++', equipe: 'Labo Chaussure', score: 80 }]);
  assert.deepEqual(rel.byApp['Notepad++'], ['LAB-CHA-01', 'LAB-CHA-02']);
  assert.equal(rel.byApp['Dropbox perso'], undefined, 'no poste -> absent');
  assert.deepEqual(Object.keys(rel.byPoste).sort(), ['LAB-CHA-01', 'LAB-CHA-02', 'LAB-MEC-01', 'LAB-TEX-01', 'LAB-TEX-02']);
});

test('buildPosteAppsRelation: score fallback, blanks, duplicates, odd keys', () => {
  const rel = Core.buildPosteAppsRelation([
    { [Core.KEY_APP]: 'A', 'Installé sur poste': ' P1 ,, P2 , P1 ,', 'Équipe': 'E', Contrat: 'Oui' },
    { [Core.KEY_APP]: 'B', 'Installé sur poste': 'P1', _score: 60 },
    { [Core.KEY_APP]: '', 'Installé sur poste': 'P9' },
    { [Core.KEY_APP]: 'C', 'Installé sur poste': '__proto__' },
    null,
  ]);
  assert.deepEqual(rel.byApp.A, ['P1', 'P2']);
  assert.deepEqual(rel.byPoste.P1, [
    { application: 'A', equipe: 'E', score: 20 }, { application: 'B', equipe: '', score: 60 }]);
  assert.equal(rel.byPoste.P9, undefined);
  assert.ok(Object.prototype.hasOwnProperty.call(rel.byPoste, '__proto__'));
  assert.equal(Object.getPrototypeOf(rel.byPoste), Object.prototype);
  assert.equal(rel.relations.length, 4);
  assert.deepEqual(Core.buildPosteAppsRelation(null), { relations: [], byPoste: {}, byApp: {} });
});

// ------------------------------------------------------------------------------------------ diffs
test('diffPostes between 2026-04 and 2026-05', () => {
  const d = Core.diffPostes(data.MONTHS['2026-04'].postes, data.MONTHS['2026-05'].postes);
  assert.deepEqual(d.removed.map((r) => r['Nom du poste']), ['LAB-TEX-02']);
  assert.equal(d.removed[0], data.MONTHS['2026-04'].postes[1], 'removed carries the old record');
  assert.deepEqual(d.added.map((r) => r['Nom du poste']), [data.XSS_POSTE_NAME, 'LAB-TEX-03'].sort());
  assert.deepEqual(d.changes, [
    { name: 'LAB-CHA-01', equipe: 'Labo Chaussure', diffs: {
      'Score conformité': { old: '60%', new: '80%' },
      'EDR Decathlon': { old: 'Non', new: 'Oui' },
      'Action corrective': { old: "Installer l'EDR", new: '' },
      'Statut': { old: 'En cours', new: 'Conforme' },
      'Niveau de risque': { old: 'Moyen', new: 'Faible' },
    } },
    { name: 'LAB-MEC-01', equipe: 'Labo Mécanique', diffs: { 'Score conformité': { old: '30,4%', new: '40%' } } },
  ]);
  assert.deepEqual(d.resolved_actions, [
    { name: 'LAB-CHA-01', equipe: 'Labo Chaussure', action: "Installer l'EDR", responsable: 'Léa Dubois' },
  ]);
});

test('diffPostes: first occurrence wins, blank names ignored, str() comparison, sorting', () => {
  const P = (name, extra) => ({ 'Nom du poste': name, 'Équipe': 'E', ...extra });
  const oldL = [P('B', { 'Statut': 'x' }), P('A', { 'Statut': ' y ', 'Action corrective': 'Do', 'Responsable action': 'R' }),
    P('A', { 'Statut': 'ignored' }), P('', {}), P(null, {})];
  const newL = [P('C', {}), P('A', { 'Statut': 'y', 'Action corrective': '  ', 'Équipe': 'E2' }), P('B', { 'Statut': 'x' })];
  const d = Core.diffPostes(oldL, newL);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added.map((r) => r['Nom du poste']), ['C']);
  assert.deepEqual(d.changes, [{ name: 'A', equipe: 'E2', diffs: { 'Action corrective': { old: 'Do', new: '' } } }]);
  assert.deepEqual(d.resolved_actions, [{ name: 'A', equipe: 'E', action: 'Do', responsable: 'R' }]);
  // removed/added/changes sorted by name
  const s = Core.diffPostes([P('Z'), P('M'), P('K', { OS: 1 })], [P('Y'), P('X'), P('K')]);
  assert.deepEqual(s.removed.map((r) => r['Nom du poste']), ['M', 'Z']);
  assert.deepEqual(s.added.map((r) => r['Nom du poste']), ['X', 'Y']);
  assert.deepEqual(s.changes, [], 'columns outside POSTE_DIFF_COLS are ignored');
  assert.deepEqual(Core.diffPostes(null, undefined), { removed: [], added: [], changes: [], resolved_actions: [] });
});

test('diffApplications between 2026-04 and 2026-05', () => {
  const d = Core.diffApplications(data.MONTHS['2026-04'].applications, data.MONTHS['2026-05'].applications);
  assert.deepEqual(Object.keys(d), ['removed', 'added', 'resolved_actions']);
  assert.deepEqual(d.removed.map((r) => r[Core.KEY_APP]), ['Datacolor Tools']);
  assert.deepEqual(d.added.map((r) => r[Core.KEY_APP]), ['Figma']);
  assert.deepEqual(d.resolved_actions, [
    { name: 'Dropbox perso', equipe: 'R&D Vélo', action: 'Migrer vers Google Drive', responsable: 'Inès Moreau' },
  ]);
  assert.deepEqual(Core.diffApplications([], []), { removed: [], added: [], resolved_actions: [] });
});

// ------------------------------------------------------------------------------------------ record helpers
test('makeGenericPoste', () => {
  const rec = Core.makeGenericPoste([], ['LAB-TEX-01']);
  assert.deepEqual(Object.keys(rec), Core.POSTE_TEMPLATE_KEYS);
  assert.equal(rec['Nom du poste'], 'Poste générique Decathlon');
  assert.equal(rec['Commentaires'],
    'Poste générique regroupant les applications non liées à un poste suivi individuellement.');
  const others = Object.keys(rec).filter((k) => k !== 'Nom du poste' && k !== 'Commentaires');
  assert.ok(others.every((k) => rec[k] === null));

  const custom = Core.makeGenericPoste(['Nom du poste', 'OS', 'Extra'], []);
  assert.deepEqual(custom, { 'Nom du poste': 'Poste générique Decathlon', 'OS': null, 'Extra': null,
    'Commentaires': 'Poste générique regroupant les applications non liées à un poste suivi individuellement.' });
  assert.deepEqual(Object.keys(Core.makeGenericPoste(null, null)), Core.POSTE_TEMPLATE_KEYS);

  assert.equal(Core.makeGenericPoste([], ['Poste générique Decathlon']), null);
  assert.equal(Core.makeGenericPoste([], [' poste générique decathlon ']), null, 'normKey match');
  // template constant untouched
  assert.equal(Core.POSTE_TEMPLATE_KEYS.length, 25);
});

test('mergeCarryOver copies blank fields from the previous snapshot', () => {
  const prev = appsWithCustom('2026-04');
  const fresh = data.MONTHS['2026-05'].applications; // raw source: no Galink/IDP keys
  const res = Core.mergeCarryOver(fresh, prev, Core.KEY_APP, ['Galink', 'IDP']);
  const byName = Object.fromEntries(res.records.map((r) => [r[Core.KEY_APP], [r.Galink, r.IDP]]));
  assert.deepEqual(byName, {
    'Minitab': ['Oui', 'Oui'], 'LabVIEW': ['Non', null], 'Dropbox perso': [null, null],
    'Notepad++': ['Oui', 'Non'], 'Figma': [null, null],
  });
  assert.equal(res.carried, 5);
  assert.ok(res.records.every((r) => 'Galink' in r && 'IDP' in r));
  assert.equal(fresh[0].Galink, undefined, 'input not mutated');
  assert.notEqual(res.records[0], fresh[0]);
});

test('mergeCarryOver: existing values kept, normKey matching, blanks -> null', () => {
  const prev = [{ name: 'App  One', G: 'Oui', I: 'Non' }, { name: 'app one', G: 'Non' }, { name: '', G: 'Oui' }];
  const res = Core.mergeCarryOver([
    { name: 'APP ONE', G: 'Non', I: '  ' },
    { name: '', G: '', I: undefined },
    { name: 'other' },
  ], prev, 'name', ['G', 'I']);
  assert.deepEqual(res.records, [
    { name: 'APP ONE', G: 'Non', I: 'Non' },
    { name: '', G: null, I: null },
    { name: 'other', G: null, I: null },
  ]);
  assert.equal(res.carried, 1);
  assert.deepEqual(Core.mergeCarryOver(null, null, 'name', ['G']), { records: [], carried: 0 });
  assert.deepEqual(Core.mergeCarryOver([{ name: 'x' }], null, 'name', null), { records: [{ name: 'x' }], carried: 0 });
});

test('optionsForColumn: référentiel, alias, Oui/Non, free text', () => {
  const ref = data.REFERENTIEL;
  assert.deepEqual(Core.optionsForColumn('Statut', ref), ['Conforme', 'Non conforme', 'En cours', 'À traiter']);
  assert.deepEqual(Core.optionsForColumn('Bâtiment / Labo', ref), ['Bâtiment A', 'Bâtiment B', 'Bâtiment C']);
  assert.deepEqual(Core.optionsForColumn('Niveau de risque', { ' niveau DE risque ': ['X'] }), ['X']);
  assert.deepEqual(Core.optionsForColumn('Équipe', { 'Équipe': ['A'] }), ['A'], 'NFD category');
  assert.deepEqual(Core.optionsForColumn('Galink', ref), ['Oui', 'Non']);
  assert.deepEqual(Core.optionsForColumn('EDR Decathlon', null), ['Oui', 'Non']);
  assert.deepEqual(Core.optionsForColumn('SIP', { SIP: ['Oui', 'Non', 'En cours'] }), ['Oui', 'Non', 'En cours'],
    'référentiel wins over Oui/Non');
  assert.equal(Core.optionsForColumn('Commentaires', ref), null);
  assert.equal(Core.optionsForColumn('', ref), null);
  assert.equal(Core.optionsForColumn(null, null), null);
  const opts = Core.optionsForColumn('OS', ref);
  opts.push('mutated');
  assert.deepEqual(ref.OS, ['Windows', 'macOS', 'Linux'], 'returns a copy');
});
