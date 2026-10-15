'use strict';
/**
 * Canonical sample data shared by unit, integration and e2e tests.
 * Two monthly snapshots (2026-04, 2026-05) with realistic French values, a référentiel,
 * remediation actions and workstation replacements.
 *
 * Records use source column names exactly (see docs/API.md §1). Values are display strings or null.
 */

const POSTES_HEADERS = [
  'N° Visite', 'Date visite', 'Prochaine revue', 'Équipe', 'Bâtiment / Labo', 'Responsable',
  'Nom du poste', "Date d'achat", 'Criticité équipement', 'IT Decathlon', 'OS', 'Version OS',
  'EDR Decathlon', 'Chiffrement disque', 'Type de compte', 'Réseau Decathlon', 'Score conformité',
  'Niveau de risque', 'Action corrective', 'Responsable action', 'Deadline', 'Statut',
  'Application', 'Commentaires', 'Enrolée',
];

const APPS_HEADERS = [
  'Date', 'Nom du logiciel / service', 'Éditeur', 'Type', 'Équipe', 'Installé sur poste',
  'Contrat', 'SIP', 'Données sensibles exposées', 'Niveau de risque', 'Score conformité',
  'Action corrective', 'Responsable action', 'Statut', 'Commentaires',
];

function poste(o) {
  const r = {};
  for (const h of POSTES_HEADERS) r[h] = Object.prototype.hasOwnProperty.call(o, h) ? o[h] : null;
  return r;
}
function app(o) {
  const r = {};
  for (const h of APPS_HEADERS) r[h] = Object.prototype.hasOwnProperty.call(o, h) ? o[h] : null;
  return r;
}

// ---------------------------------------------------------------- 2026-04
const POSTES_2026_04 = [
  poste({ 'N° Visite': 'V-001', 'Date visite': '12/03/2026', 'Prochaine revue': '12/09/2026', 'Équipe': 'Labo Textile',
    'Bâtiment / Labo': 'Bâtiment A', 'Responsable': 'Camille Martin', 'Nom du poste': 'LAB-TEX-01',
    "Date d'achat": '15/01/2021', 'Criticité équipement': 'Haute', 'IT Decathlon': 'Oui', 'OS': 'Windows',
    'Version OS': '10 22H2', 'EDR Decathlon': 'Oui', 'Chiffrement disque': 'Oui', 'Type de compte': 'Nominatif',
    'Réseau Decathlon': 'Oui', 'Score conformité': '100%', 'Niveau de risque': 'Faible', 'Statut': 'Conforme',
    'Application': 'Minitab', 'Enrolée': 'Oui' }),
  poste({ 'N° Visite': 'V-002', 'Date visite': '12/03/2026', 'Équipe': 'Labo Textile', 'Bâtiment / Labo': 'Bâtiment A',
    'Responsable': 'Camille Martin', 'Nom du poste': 'LAB-TEX-02', 'IT Decathlon': 'Non', 'OS': 'Windows',
    'Version OS': '7', 'EDR Decathlon': 'Non', 'Chiffrement disque': 'Non', 'Type de compte': 'Générique',
    'Réseau Decathlon': 'Non', 'Score conformité': '20%', 'Niveau de risque': 'Critique',
    'Action corrective': 'Remplacer le poste (Windows 7)', 'Responsable action': 'Hugo Bernard',
    'Deadline': '30/06/2026', 'Statut': 'Non conforme', 'Application': 'Datacolor Tools' }),
  poste({ 'N° Visite': 'V-003', 'Date visite': '14/03/2026', 'Équipe': 'Labo Chaussure', 'Bâtiment / Labo': 'Bâtiment B',
    'Responsable': 'Léa Dubois', 'Nom du poste': 'LAB-CHA-01', 'IT Decathlon': 'Oui', 'OS': 'Windows',
    'Version OS': '11 23H2', 'EDR Decathlon': 'Non', 'Chiffrement disque': 'Oui', 'Type de compte': 'Nominatif',
    'Réseau Decathlon': 'Oui', 'Score conformité': '60%', 'Niveau de risque': 'Moyen',
    'Action corrective': "Installer l'EDR", 'Responsable action': 'Léa Dubois', 'Deadline': '15/05/2026',
    'Statut': 'En cours' }),
  poste({ 'N° Visite': 'V-004', 'Date visite': '14/03/2026', 'Équipe': 'Labo Chaussure', 'Bâtiment / Labo': 'Bâtiment B',
    'Responsable': 'Léa Dubois', 'Nom du poste': 'LAB-CHA-02', 'IT Decathlon': 'Oui', 'OS': 'Windows',
    'Version OS': '11 23H2', 'EDR Decathlon': 'Oui', 'Chiffrement disque': 'Oui', 'Type de compte': 'Nominatif',
    'Réseau Decathlon': 'Oui', 'Score conformité': '80%', 'Niveau de risque': 'Faible', 'Statut': 'Conforme' }),
  poste({ 'N° Visite': 'V-005', 'Date visite': '20/03/2026', 'Équipe': 'Labo Mécanique', 'Bâtiment / Labo': 'Bâtiment C',
    'Responsable': 'Nathan Petit', 'Nom du poste': 'LAB-MEC-01', 'IT Decathlon': 'Non', 'OS': 'Linux',
    'Version OS': 'Ubuntu 18.04', 'EDR Decathlon': 'Non', 'Chiffrement disque': 'Non', 'Type de compte': 'Local admin',
    'Réseau Decathlon': 'Oui', 'Score conformité': '30,4%', 'Niveau de risque': 'Élevé',
    'Action corrective': 'Isoler du réseau', 'Responsable action': 'Nathan Petit', 'Statut': 'Non conforme',
    'Application': 'LabVIEW' }),
  poste({ 'N° Visite': 'V-006', 'Date visite': '20/03/2026', 'Équipe': 'R&D Vélo', 'Bâtiment / Labo': 'Bâtiment C',
    'Responsable': 'Inès Moreau', 'Nom du poste': 'RD-VEL-01', 'IT Decathlon': 'Oui', 'OS': 'macOS',
    'Version OS': '14', 'EDR Decathlon': 'Oui', 'Chiffrement disque': 'Oui', 'Type de compte': 'Nominatif',
    'Réseau Decathlon': 'Oui', 'Score conformité': '90%', 'Niveau de risque': 'Faible', 'Statut': 'Conforme' }),
];

const APPS_2026_04 = [
  app({ 'Date': '12/03/2026', 'Nom du logiciel / service': 'Minitab', 'Éditeur': 'Minitab LLC', 'Type': 'Logiciel',
    'Équipe': 'Labo Textile', 'Installé sur poste': 'LAB-TEX-01', 'Contrat': 'Oui', 'SIP': 'Oui',
    'Données sensibles exposées': 'Non', 'Niveau de risque': 'Faible', 'Statut': 'Conforme' }),
  app({ 'Date': '12/03/2026', 'Nom du logiciel / service': 'Datacolor Tools', 'Éditeur': 'Datacolor', 'Type': 'Logiciel',
    'Équipe': 'Labo Textile', 'Installé sur poste': 'LAB-TEX-02', 'Contrat': 'Non', 'SIP': 'Non',
    'Données sensibles exposées': 'Non', 'Niveau de risque': 'Moyen', 'Action corrective': 'Négocier un contrat',
    'Responsable action': 'Camille Martin', 'Statut': 'En cours' }),
  app({ 'Date': '20/03/2026', 'Nom du logiciel / service': 'LabVIEW', 'Éditeur': 'NI', 'Type': 'Logiciel',
    'Équipe': 'Labo Mécanique', 'Installé sur poste': 'LAB-MEC-01', 'Contrat': 'Oui', 'SIP': 'Non',
    'Données sensibles exposées': 'Oui', 'Niveau de risque': 'Élevé', 'Statut': 'Non conforme' }),
  app({ 'Date': '20/03/2026', 'Nom du logiciel / service': 'Dropbox perso', 'Éditeur': 'Dropbox', 'Type': 'SaaS',
    'Équipe': 'R&D Vélo', 'Contrat': 'Non', 'SIP': 'Non', 'Données sensibles exposées': 'Oui',
    'Niveau de risque': 'Critique', 'Action corrective': 'Migrer vers Google Drive', 'Responsable action': 'Inès Moreau',
    'Statut': 'À traiter' }),
  app({ 'Date': '14/03/2026', 'Nom du logiciel / service': 'Notepad++', 'Éditeur': 'Don Ho', 'Type': 'Logiciel',
    'Équipe': 'Labo Chaussure', 'Installé sur poste': 'LAB-CHA-01, LAB-CHA-02', 'Contrat': 'Oui', 'SIP': 'Oui',
    'Données sensibles exposées': 'Non', 'Niveau de risque': 'Faible', 'Statut': 'Conforme' }),
];

// ---------------------------------------------------------------- 2026-05
// Changes vs 2026-04:
//  - LAB-TEX-02 removed (replaced by LAB-TEX-03)          -> removed / added
//  - LAB-CHA-01 EDR installed: Action corrective cleared   -> change + resolved action
//  - LAB-MEC-01 score 30,4% -> 40%                         -> change
//  - generic XSS probe poste added                         -> added (e2e XSS test)
//  - Dropbox perso action cleared                          -> resolved app action
//  - Datacolor Tools removed, Figma added                  -> removed / added apps
const POSTES_2026_05 = [
  POSTES_2026_04[0],
  poste({ ...POSTES_2026_04[2], 'Date visite': '10/04/2026', 'EDR Decathlon': 'Oui', 'Score conformité': '80%',
    'Niveau de risque': 'Faible', 'Action corrective': null, 'Responsable action': null, 'Deadline': null,
    'Statut': 'Conforme' }),
  POSTES_2026_04[3],
  poste({ ...POSTES_2026_04[4], 'Score conformité': '40%' }),
  POSTES_2026_04[5],
  poste({ 'N° Visite': 'V-007', 'Date visite': '10/04/2026', 'Équipe': 'Labo Textile', 'Bâtiment / Labo': 'Bâtiment A',
    'Responsable': 'Camille Martin', 'Nom du poste': 'LAB-TEX-03', "Date d'achat": '01/04/2026',
    'Criticité équipement': 'Moyenne', 'IT Decathlon': 'Oui', 'OS': 'Windows', 'Version OS': '11 24H2',
    'EDR Decathlon': 'Oui', 'Chiffrement disque': 'Oui', 'Type de compte': 'Nominatif', 'Réseau Decathlon': 'Oui',
    'Score conformité': '100%', 'Niveau de risque': 'Faible', 'Statut': 'Conforme', 'Enrolée': 'Oui' }),
  poste({ 'N° Visite': 'V-008', 'Date visite': '11/04/2026', 'Équipe': 'R&D Vélo', 'Bâtiment / Labo': 'Bâtiment C',
    'Responsable': 'Inès Moreau', 'Nom du poste': '<img src=x onerror="window.__xss=1">',
    'IT Decathlon': 'Non', 'OS': 'Windows', 'Version OS': '10', 'EDR Decathlon': 'Non', 'Chiffrement disque': 'Oui',
    'Type de compte': 'Nominatif', 'Réseau Decathlon': 'Non', 'Score conformité': '50%', 'Niveau de risque': 'Moyen',
    'Commentaires': '<script>window.__xss=2</script>' }),
];

const APPS_2026_05 = [
  APPS_2026_04[0],
  APPS_2026_04[2],
  app({ ...APPS_2026_04[3], 'Action corrective': null, 'Responsable action': null, 'Statut': 'En cours' }),
  APPS_2026_04[4],
  app({ 'Date': '10/04/2026', 'Nom du logiciel / service': 'Figma', 'Éditeur': 'Figma Inc.', 'Type': 'SaaS',
    'Équipe': 'R&D Vélo', 'Installé sur poste': 'RD-VEL-01', 'Contrat': 'Oui', 'SIP': 'Oui',
    'Données sensibles exposées': 'Non', 'Niveau de risque': 'Faible', 'Statut': 'Conforme' }),
];

// App-only custom fields as they would be stored in the data spreadsheet (edited in the app).
const CUSTOM_FIELDS = {
  '2026-04': { 'Minitab': { Galink: 'Oui', IDP: 'Oui' }, 'Notepad++': { Galink: 'Oui', IDP: 'Non' },
    'LabVIEW': { Galink: 'Non', IDP: null } },
  '2026-05': { 'Minitab': { Galink: 'Oui', IDP: 'Oui' }, 'Notepad++': { Galink: 'Oui', IDP: 'Oui' },
    'LabVIEW': { Galink: 'Non', IDP: 'Non' }, 'Figma': { Galink: 'Oui', IDP: 'Oui' } },
};

// Référentiel as {category: [values]} (the source tab is transposed: one column per category).
const REFERENTIEL = {
  'Statut': ['Conforme', 'Non conforme', 'En cours', 'À traiter'],
  'Niveau de risque': ['Critique', 'Élevé', 'Moyen', 'Faible'],
  'Type de compte': ['Nominatif', 'Générique', 'Local admin'],
  'OS': ['Windows', 'macOS', 'Linux'],
  'Bâtiment': ['Bâtiment A', 'Bâtiment B', 'Bâtiment C'],
  'Équipe': ['Labo Textile', 'Labo Chaussure', 'Labo Mécanique', 'R&D Vélo'],
  'Criticité équipement': ['Haute', 'Moyenne', 'Basse'],
  'Type': ['Logiciel', 'SaaS', 'Script'],
};

const ACTIONS = [
  { id: 'a-0001', target_type: 'poste', target_name: 'LAB-TEX-02', equipe: 'Labo Textile',
    action: 'Remplacer le poste (Windows 7)', responsable: 'Hugo Bernard', date_created: '12/03/2026',
    date_completed: '05/04/2026', deadline: '30/06/2026', priorite: 'Haute', status: 'Terminé',
    source_month: '2026-04', comment: 'Remplacé par LAB-TEX-03', recorded_at: '2026-03-12', updated_at: '2026-04-05' },
  { id: 'a-0002', target_type: 'poste', target_name: 'LAB-MEC-01', equipe: 'Labo Mécanique',
    action: 'Isoler du réseau', responsable: 'Nathan Petit', date_created: '20/03/2026', date_completed: '',
    deadline: '31/05/2026', priorite: 'Haute', status: 'En cours', source_month: '2026-04', comment: '',
    recorded_at: '2026-03-20', updated_at: '' },
  { id: 'a-0003', target_type: 'application', target_name: 'Dropbox perso', equipe: 'R&D Vélo',
    action: 'Migrer vers Google Drive', responsable: 'Inès Moreau', date_created: '20/03/2026', date_completed: '',
    deadline: '15/04/2026', priorite: 'Moyenne', status: 'À faire', source_month: '2026-04', comment: '',
    recorded_at: '2026-03-20', updated_at: '' },
];

const REPLACEMENTS = [
  { id: 'r-0001', old_poste: 'LAB-TEX-02', new_poste: 'LAB-TEX-03', equipe: 'Labo Textile',
    responsable: 'Hugo Bernard', date_replacement: '05/04/2026', comment: 'Fin de support Windows 7',
    recorded_at: '2026-04-05' },
];

const MONTHS = {
  '2026-04': { postes: POSTES_2026_04, applications: APPS_2026_04 },
  '2026-05': { postes: POSTES_2026_05, applications: APPS_2026_05 },
};

module.exports = {
  POSTES_HEADERS, APPS_HEADERS, MONTHS, CUSTOM_FIELDS, REFERENTIEL, ACTIONS, REPLACEMENTS,
  XSS_POSTE_NAME: POSTES_2026_05[6]['Nom du poste'],
};
