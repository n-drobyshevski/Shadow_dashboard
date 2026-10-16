'use strict';
/**
 * E2E tests of Paramètres (source, threshold, editing switches, access list) and of the access-dependent shell:
 * admin-only navigation, signed-in account in the sidebar, « Accès refusé » and the lecteur screens.
 * Run: NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test test/e2e/
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNTS, openApp, chooseOption, dropdownValue } = require('./harness');

async function withApp(options, fn) {
  const app = await openApp(options);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

async function callsNamed(app, name) {
  return (await app.calls()).filter((c) => c.name === name);
}

async function accessEmails(page) {
  return page.$$eval('#access-table tbody tr', (rows) => rows.map((r) => r.dataset.email));
}

/** Selects a tab of Paramètres (general | saisie | acces) and waits for its panel. */
async function tab(page, id) {
  await page.click('#settings-tab-' + id);
  await page.waitForSelector('#settings-panel-' + id, { state: 'visible' });
}

async function lastToast(page) {
  await page.waitForSelector('.toast');
  return page.$$eval('.toast .toast-msg', (ts) => ts[ts.length - 1].textContent.trim());
}

describe('settings (admin)', () => {
  test('three tabs of cards with the current values', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main .page-title')).trim(), 'Paramètres');
      const tabs = await page.$$eval('#settings-body [role="tab"]', (ns) => ns.map((n) =>
        [n.textContent.trim(), n.getAttribute('aria-selected'), n.getAttribute('aria-controls')]));
      assert.deepEqual(tabs, [['Général', 'true', 'settings-panel-general'], ['Saisie', 'false', 'settings-panel-saisie'],
        ['Accès', 'false', 'settings-panel-acces']]);
      const titles = (id) => page.$$eval('#settings-panel-' + id + ' .card-title', (ns) => ns.map((n) => n.textContent.trim()));
      assert.deepEqual(await titles('general'), ['Source de données', 'Synchronisation', 'Seuil de conformité']);
      assert.deepEqual(await titles('saisie'), ['Saisie dans l’application']);
      assert.deepEqual(await titles('acces'), ['Comptes', 'Groupes Google']);
      assert.equal(await page.isVisible('#settings-panel-saisie'), false);
      assert.equal(await page.isVisible('#settings-panel-acces'), false);
      assert.equal((await page.textContent('#settings-source-link')).trim(), 'ShadowIT_Industry');
      assert.match(await page.textContent('#settings-source-info'), /Suivi des postes/);
      assert.equal(await page.inputValue('#settings-threshold'), '80');
      assert.ok(await page.isHidden('#settings-threshold-reset'));
      await tab(page, 'acces');
      assert.equal(await page.isVisible('#settings-panel-general'), false);
      assert.equal(await dropdownValue(page, '#settings-domain-role'), 'none');
      assert.deepEqual(await accessEmails(page),
        [ACCOUNTS.OWNER, ACCOUNTS.LECTEUR, ACCOUNTS.ADMIN2]);
      // The owner row and the signed-in row are plain text, never editable.
      const owner = page.locator(`#access-table tr[data-email="${ACCOUNTS.OWNER}"]`);
      assert.match(await owner.textContent(), /Administrateur\s*propriétaire/);
      assert.equal(await owner.locator('button').count(), 0);
      assert.equal(await page.locator(`#access-table tr[data-email="${ACCOUNTS.LECTEUR}"] button:has-text("Retirer")`).count(), 1);
      assert.doesNotMatch(await page.textContent('#main'), /\p{Extended_Pictographic}/u);
      assert.deepEqual(app.errors, []);
    });
  });

  test('synchronisation: status, journal (newest first, warnings on demand), « Synchroniser maintenant »', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      // The journal is read from the server only when it is opened.
      await page.waitForSelector('#settings-sync-log-toggle');
      assert.equal(await page.getAttribute('#settings-sync-log-toggle', 'aria-expanded'), 'false');
      assert.equal(await page.isVisible('#import-log'), false);
      assert.equal((await callsNamed(app, 'api_getImportLog')).length, 0);
      await page.click('#settings-sync-log-toggle');
      await page.waitForSelector('#settings-sync #import-log tbody tr[data-month]');
      assert.equal(await page.getAttribute('#settings-sync-log-toggle', 'aria-expanded'), 'true');
      assert.match(await page.textContent('#settings-sync-auto'), /Active · toutes les heures/);
      assert.equal(await page.textContent('#settings-sync-change'),
        '04/05 10:30 · +1 poste · −1 poste · 2 postes modifiés (3 valeurs) · +1 application · −1 application');
      // Journal: newest first, months as « mai 2026 », time as DD/MM/YYYY HH:MM; older manual imports say so.
      assert.deepEqual(await page.$$eval('#import-log tbody tr[data-month]', (ns) => ns.map((n) => n.dataset.month)),
        ['2026-05', '2026-04']);
      assert.deepEqual(await page.$$eval('#import-log tbody tr[data-month] td:nth-child(2)', (ns) => ns.map((n) => n.textContent)),
        ['mai 2026', 'avril 2026']);
      assert.match(await page.textContent('#import-log tbody tr[data-month] td:first-child'), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
      assert.equal(await page.textContent('#import-log tbody tr[data-month] td:nth-child(3)'), 'import manuel');
      // Warnings are revealed by the count button (no native tooltip).
      const toggle = '#import-log tr[data-month="2026-05"] .import-warn-toggle';
      assert.equal((await page.textContent(toggle)).trim(), '1');
      const target = await page.getAttribute(toggle, 'aria-controls');
      assert.equal(await page.isVisible('#' + target), false);
      await page.click(toggle);
      assert.equal(await page.getAttribute(toggle, 'aria-expanded'), 'true');
      assert.match(await page.textContent('#' + target), /ignorée/);

      // The current month is created by the sync: a new journal row, the status follows (app bar too).
      await page.click('#settings-sync-now');
      await page.waitForFunction(() => document.querySelectorAll('#import-log tbody tr[data-month]').length === 3);
      await app.waitIdle();
      assert.equal(await page.textContent('#import-log tbody tr[data-month] td:nth-child(3)'), 'mois créé');
      assert.match(await page.textContent('#settings-sync-change'), /^\d{2}:\d{2} · mois créé$/);
      assert.deepEqual(app.errors, []);
    });
  });

  test('synchronisation inactive: « Activer la synchronisation horaire »', async () => {
    await withApp({ page: 'settings', sync: { enabled: false } }, async (app) => {
      const { page } = app;
      await page.waitForSelector('#settings-sync-enable');
      assert.match(await page.textContent('#settings-sync-auto'), /Inactive/);
      assert.equal((await page.textContent('#sync-chip')).trim().length > 0, true);
      await page.click('#settings-sync-enable');
      await page.waitForSelector('#settings-sync-now');
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_enableSync')).length, 1);
      assert.match(await page.textContent('#settings-sync-auto'), /Active · toutes les heures/);
      assert.deepEqual(app.errors, []);
    });
  });

  test('threshold: validation, save, and every page re-scores', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      await page.fill('#settings-threshold', '150');
      await page.click('#settings-threshold-submit');
      assert.match(await page.textContent('#settings-threshold-err'), /entre 1 et 100/);
      assert.equal(await page.getAttribute('#settings-threshold', 'aria-invalid'), 'true');
      assert.equal((await callsNamed(app, 'api_setThreshold')).length, 0, 'invalid value never sent');

      await page.fill('#settings-threshold', '30');
      await page.click('#settings-threshold-submit');
      assert.match(await lastToast(page), /^Seuil enregistré — 30\u202f%\.$/);
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_setThreshold')).map((c) => c.args), [{ threshold: 30 }]);
      assert.equal(await page.evaluate(() => [Core.threshold(), State.get().threshold].join()), '30,30');
      assert.ok(await page.isVisible('#settings-threshold-reset'));

      // Cached month data was dropped and reloaded after the save; every caption shows the new threshold.
      await app.goto('dashboard');
      const names = (await app.calls()).map((c) => c.name);
      assert.ok(names.lastIndexOf('api_getMonthData') > names.indexOf('api_setThreshold'), 'month data reloaded');
      assert.match(await page.textContent('#main'), /seuil 30\s%/);
      assert.doesNotMatch(await page.textContent('#main'), /seuil 80\s%/);

      await app.goto('settings');
      await page.click('#settings-threshold-reset');
      assert.match(await lastToast(page), /^Seuil enregistré — 80\u202f%\.$/);
      assert.equal(await page.evaluate(() => Core.threshold()), 80);
      assert.deepEqual(app.errors, []);
    });
  });

  test('access: add, change role, remove, domain role, server validation shown on the field', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      await tab(page, 'acces');
      await page.fill('#access-email', 'pas-une-adresse');
      await page.click('#access-add');
      await page.waitForSelector('#access-email[aria-invalid="true"]');
      assert.match(await page.textContent('#access-email-err'), /Adresse e-mail invalide/);

      await page.fill('#access-email', ACCOUNTS.OWNER);
      await page.click('#access-add');
      await page.waitForFunction(() => /propriétaire/.test(document.getElementById('access-email-err').textContent));

      await page.fill('#access-email', '  Nina.New@Decathlon.com ');
      await chooseOption(page, '#access-role', 'Administrateur');
      await page.click('#access-add');
      assert.equal(await lastToast(page), 'Accès ajouté — nina.new@decathlon.com (Administrateur).');
      await app.waitIdle();
      assert.deepEqual(await accessEmails(page),
        [ACCOUNTS.OWNER, ACCOUNTS.LECTEUR, 'nina.new@decathlon.com', ACCOUNTS.ADMIN2]);

      await chooseOption(page, `#access-table tr[data-email="${ACCOUNTS.ADMIN2}"] .dd-trigger`, 'Lecteur');
      assert.equal(await lastToast(page), `Rôle modifié — ${ACCOUNTS.ADMIN2} : Lecteur.`);
      await app.waitIdle();
      const save = (await callsNamed(app, 'api_saveUser')).pop();
      assert.deepEqual(save.args, { email: ACCOUNTS.ADMIN2, role: 'lecteur' });

      await page.click(`#access-table tr[data-email="${ACCOUNTS.LECTEUR}"] button:has-text("Retirer")`);
      await page.waitForSelector('.modal');
      assert.match(await page.textContent('.modal'), new RegExp(ACCOUNTS.LECTEUR.replace(/\./g, '\\.')));
      await page.click('.modal button:has-text("Retirer")');
      await page.waitForSelector('.modal', { state: 'detached' });
      await app.waitIdle();
      assert.ok(!(await accessEmails(page)).includes(ACCOUNTS.LECTEUR));

      await chooseOption(page, '#settings-domain-role', 'Lecteur');
      assert.match(await lastToast(page), /Tout compte du domaine/);
      assert.deepEqual((await callsNamed(app, 'api_setDomainRole')).map((c) => c.args), [{ role: 'lecteur' }]);
      assert.deepEqual(app.errors, []);
    });
  });

  test('bulk add: paste any list, live preview, one call, then search the list', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      await tab(page, 'acces');
      assert.equal((await page.textContent('#access-count')).trim(), '3 comptes');
      await page.click('#access-bulk-open');
      await page.waitForSelector('.modal #bulk-emails');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'bulk-emails');
      const primary = page.locator('.modal .btn-primary');
      assert.equal(await primary.isDisabled(), true, 'nothing to add yet');

      await page.fill('#bulk-emails', [
        'Nina Petit <Nina.Petit@decathlon.com>, "Tom" <tom.roux@decathlon.com>; jade.morel@decathlon.com',
        ACCOUNTS.LECTEUR, ACCOUNTS.ADMIN2, ACCOUNTS.OWNER, 'lucas.blanc@decathlon', 'jade.morel@decathlon.com'].join('\n'));
      const preview = (await page.textContent('#bulk-preview')).replace(/\s+/g, ' ').trim();
      assert.equal(preview, '3 nouveaux comptes · 1 rôle modifié · 1 déjà lecteur · 1 ignoré (propriétaire) · ' +
        '1 adresse invalide : lucas.blanc@decathlon');
      assert.equal((await primary.textContent()).trim(), 'Enregistrer 4 comptes');

      // Same paste as admins: the preview follows the role.
      await chooseOption(page, '#bulk-role', 'Administrateur');
      assert.match(await page.textContent('#bulk-preview'), /^3 nouveaux comptes · 1 rôle modifié · 1 déjà administrateur/);
      await chooseOption(page, '#bulk-role', 'Lecteur');

      await primary.click();
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.equal(await lastToast(page), '3 comptes ajoutés · 1 rôle modifié — Lecteur.');
      await app.waitIdle();
      const call = (await callsNamed(app, 'api_addUsers')).pop();
      assert.deepEqual(call.args, { role: 'lecteur', emails: ['nina.petit@decathlon.com', 'tom.roux@decathlon.com',
        'jade.morel@decathlon.com', ACCOUNTS.ADMIN2] });
      assert.equal((await page.textContent('#access-count')).trim(), '6 comptes');
      assert.equal(await page.evaluate((e) => window.__mock.db.access.users.find((u) => u.email === e).role, ACCOUNTS.ADMIN2), 'lecteur');

      // Search hides non-matching rows and keeps the focus; Escape clears it.
      await page.fill('#access-search', 'nina');
      assert.deepEqual(await page.$$eval('#access-table tbody tr:not([hidden])', (rs) => rs.map((r) => r.dataset.email)),
        ['nina.petit@decathlon.com']);
      assert.equal((await page.textContent('#access-count')).trim(), '1 sur 6 comptes');
      await page.fill('#access-search', 'zzz');
      assert.ok(await page.isVisible('#access-nomatch'));
      await page.press('#access-search', 'Escape');
      assert.equal(await page.$$eval('#access-table tbody tr:not([hidden])', (rs) => rs.length), 6);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'access-search');
      assert.deepEqual(app.errors, []);
    });
  });

  test('bulk add: nothing actionable keeps the dialog open; server errors show on the field', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      await tab(page, 'acces');
      await page.click('#access-bulk-open');
      await page.fill('#bulk-emails', 'Léa Martin, Sam\n' + ACCOUNTS.LECTEUR);
      assert.equal((await page.textContent('#bulk-preview')).trim(), '1 déjà lecteur');
      assert.equal(await page.locator('.modal .btn-primary').isDisabled(), true);
      await page.fill('#bulk-emails', 'new.person@decathlon.com');
      await page.evaluate(() => { window.__mock.failNext.api_addUsers = { code: 'BUSY', message: 'Une autre opération est en cours.' }; });
      await page.click('.modal .btn-primary');
      await page.waitForSelector('#bulk-emails[aria-invalid="true"]');
      assert.match(await page.textContent('.modal'), /Une autre opération est en cours/);
      assert.ok(await page.isVisible('.modal'));
      await page.click('.modal .btn-primary');
      await page.waitForSelector('.modal', { state: 'detached' });
      assert.match(await lastToast(page), /^1 compte ajouté — Lecteur\.$/);
      assert.deepEqual(app.errors, []);
    });
  });

  test('Google Groups: add (checked by the server), change role, remove, no self lock-out', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      await tab(page, 'acces');
      const groupRows = () => page.$$eval('#groups-table tbody tr', (rs) => rs.map((r) => r.dataset.group));
      assert.deepEqual(await groupRows(), ['labo-industry@decathlon.com']);

      await page.fill('#group-email', 'inconnu@decathlon.com');
      await page.click('#group-add');
      await page.waitForSelector('#group-email[aria-invalid="true"]');
      assert.match(await page.textContent('#group-email-err'), /Groupe introuvable ou membres non visibles/);

      await page.fill('#group-email', 'Shadow-Admins@decathlon.com');
      await chooseOption(page, '#group-role', 'Administrateur');
      await page.click('#group-add');
      assert.equal(await lastToast(page), 'Groupe ajouté — shadow-admins@decathlon.com (Administrateur).');
      await app.waitIdle();
      assert.deepEqual(await groupRows(), ['labo-industry@decathlon.com', 'shadow-admins@decathlon.com']);

      await chooseOption(page, '#groups-table tr[data-group="labo-industry@decathlon.com"] .dd-trigger', 'Administrateur');
      assert.equal(await lastToast(page), 'Rôle modifié — labo-industry@decathlon.com : Administrateur.');
      await app.waitIdle();

      await page.click('#groups-table tr[data-group="labo-industry@decathlon.com"] button:has-text("Retirer")');
      await page.click('.modal button:has-text("Retirer")');
      await page.waitForSelector('.modal', { state: 'detached' });
      await app.waitIdle();
      assert.deepEqual(await groupRows(), ['shadow-admins@decathlon.com']);
      assert.deepEqual(app.errors, []);
    });

    // A second admin who is admin only through the group cannot remove it.
    await withApp({ page: 'settings', email: 'chloe.admin@decathlon.com', readySelector: '#main .page' }, async (app) => {
      const { page } = app;
      await page.evaluate(() => window.__mock.db.access.groups.push({ email: 'shadow-admins@decathlon.com',
        role: 'admin', added_at: '2026-10-01', added_by: 'owner@decathlon.com' }));
      await page.click('.page-denied button:has-text("Réessayer")');
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      await app.goto('settings');
      await tab(page, 'acces');
      await page.click('#groups-table tr[data-group="shadow-admins@decathlon.com"] button:has-text("Retirer")');
      await page.click('.modal button:has-text("Retirer")');
      await page.waitForFunction(() => /retirerait le rôle administrateur/.test(document.querySelector('.modal') ?
        document.querySelector('.modal').textContent : ''));
      assert.equal(await page.evaluate(() => window.__mock.db.access.groups.length), 2);
      assert.deepEqual(app.errors, []);
    });
  });

  test('source: behind « Changer de source »; invalid value shown on the field, valid one saved', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      assert.equal(await page.isVisible('#settings-source-form'), false);
      assert.equal(await page.getAttribute('#settings-source-toggle', 'aria-expanded'), 'false');
      await page.click('#settings-source-toggle');
      assert.equal(await page.getAttribute('#settings-source-toggle', 'aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-source');
      await page.click('#settings-source-submit');
      assert.match(await page.textContent('#settings-source-err'), /Collez l’URL/);
      await page.fill('#settings-source', 'https://docs.google.com/spreadsheets/d/1MISSINGMISSINGMISSINGMISSING00/edit');
      await page.click('#settings-source-submit');
      await page.waitForFunction(() => !document.getElementById('settings-source-err').hidden &&
        /Impossible/.test(document.getElementById('settings-source-err').textContent));
      const id = '1NewSourceIdNewSourceIdNewSourceId0123';
      await page.fill('#settings-source', 'https://docs.google.com/spreadsheets/d/' + id + '/edit');
      await page.click('#settings-source-submit');
      await page.waitForFunction((x) => document.querySelector('#settings-source-info') &&
        document.querySelector('#settings-source-info').textContent.includes(x), id);
      assert.equal((await callsNamed(app, 'api_setConfig')).pop().args.source.includes(id), true);
      assert.equal(await page.isVisible('#settings-source-form'), false, 'closed again once saved');
      assert.deepEqual(app.errors, []);
    });
  });

  test('before any source: the configuration screen links to Paramètres, which works without data', async () => {
    await withApp({ configured: false, empty: true }, async (app) => {
      const { page } = app;
      await page.click('#config-open-settings');
      await page.waitForSelector('#main .page[data-page="settings"] #access-table', { state: 'attached' });
      await app.waitIdle();
      assert.match(await page.textContent('#settings-source-info'), /Non configuré/);
      // No source yet: the form shows at once, no « Changer de source ».
      assert.ok(await page.isVisible('#settings-source'));
      assert.equal(await page.$('#settings-source-toggle'), null);
      await tab(page, 'acces');
      await page.fill('#access-email', 'first.reader@decathlon.com');
      await page.click('#access-add');
      assert.match(await lastToast(page), /Accès ajouté/);
      // Saving the first source keeps the admin on Paramètres with the full shell.
      await tab(page, 'general');
      await page.fill('#settings-source', '1FirstSourceFirstSourceFirstSource00');
      await page.click('#settings-source-submit');
      await page.waitForFunction(() => !document.body.classList.contains('unconfigured'));
      await page.waitForSelector('#main .page[data-page="settings"] #settings-source-link');
      assert.equal(await page.evaluate(() => State.get().configured), true);
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('settings: tabs', () => {
  test('keyboard: arrows, Home and End move and select; Tab enters the selected tab only', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      const selected = () => page.$eval('#settings-body [aria-selected="true"]', (n) => n.id);
      const tabindex = () => page.$$eval('#settings-body [role="tab"]', (ns) => ns.map((n) => n.tabIndex));
      assert.deepEqual(await tabindex(), [0, -1, -1]);
      await page.focus('#settings-tab-general');
      await page.keyboard.press('ArrowRight');
      assert.equal(await selected(), 'settings-tab-saisie');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-tab-saisie');
      assert.ok(await page.isVisible('#settings-editing'));
      assert.deepEqual(await tabindex(), [-1, 0, -1]);
      await page.keyboard.press('End');
      assert.equal(await selected(), 'settings-tab-acces');
      await page.keyboard.press('ArrowRight');
      assert.equal(await selected(), 'settings-tab-general', 'wraps around');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await selected(), 'settings-tab-acces');
      await page.keyboard.press('Home');
      assert.equal(await selected(), 'settings-tab-general');
      assert.equal(await page.getAttribute('#settings-panel-general', 'aria-labelledby'), 'settings-tab-general');
      assert.deepEqual(app.errors, []);
    });
  });

  test('the selected tab is kept when coming back; « Journal » of the sync panel opens it on Général', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      await tab(page, 'acces');
      await app.goto('dashboard');
      await app.goto('settings');
      assert.equal(await page.getAttribute('#settings-tab-acces', 'aria-selected'), 'true');

      await page.click('#sync-chip');
      await page.click('#sync-journal');
      await page.waitForSelector('#settings-sync #import-log tbody tr[data-month]');
      assert.equal(await page.getAttribute('#settings-tab-general', 'aria-selected'), 'true');
      assert.equal(await page.getAttribute('#settings-sync-log-toggle', 'aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-sync-log-toggle');
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('settings: « Saisie dans l’application »', () => {
  const SWITCHES = ['#settings-editing-edit', '#settings-editing-create', '#settings-editing-delete'];

  async function switchState(page) {
    return page.$$eval('#settings-editing [role="switch"]', (ns) => ns.map((n) =>
      [n.id, n.getAttribute('aria-checked'), n.querySelector('.toggle-state').textContent]));
  }

  test('three switches with their labels, descriptions and states (from api_getSettings)', async () => {
    await withApp({ page: 'settings', editing: { create: false } }, async (app) => {
      const { page } = app;
      await tab(page, 'saisie');
      // One line; the rest behind « En savoir plus » (closed).
      assert.equal(await page.textContent('#settings-editing-help'), 'Pour tous les administrateurs, sur tous les mois.');
      const more = '#settings-editing details.more';
      assert.equal(await page.$eval(more, (d) => d.open), false);
      assert.equal(await page.isVisible(more + ' .more-body'), false);
      await page.click(more + ' > summary');
      assert.match(await page.textContent(more + ' .more-body'), /Le suivi des actions et les remplacements restent modifiables\./);
      assert.equal(await page.$eval(more, (d) => d.open), true);
      assert.deepEqual(await switchState(page), [
        ['settings-editing-edit', 'true', 'Activé'],
        ['settings-editing-create', 'false', 'Désactivé'],
        ['settings-editing-delete', 'true', 'Activé'],
      ]);
      // Named by the visible label, described by the description; the track is decoration.
      const a11y = await page.$$eval('#settings-editing [role="switch"]', (ns) => ns.map((n) => {
        const label = document.getElementById(n.getAttribute('aria-labelledby'));
        const desc = document.getElementById(n.getAttribute('aria-describedby'));
        return [n.tagName, n.type, label.textContent, desc.textContent, n.querySelector('.toggle-track').getAttribute('aria-hidden')];
      }));
      assert.deepEqual(a11y, [
        ['BUTTON', 'button', 'Modifier les entrées', 'Cellules des tableaux et «\u202fRenommer\u202f» une application.', 'true'],
        ['BUTTON', 'button', 'Créer des entrées', 'Nouveaux postes, postes génériques et nouvelles applications.', 'true'],
        ['BUTTON', 'button', 'Supprimer des entrées', '«\u202fSupprimer\u202f» une application (les postes ne se ' +
          'suppriment pas ici).', 'true'],
      ]);
      // Alone in its tab, between « Général » and « Accès ».
      assert.deepEqual(await page.$$eval('#settings-panel-saisie > .section', (ns) => ns.map((n) => n.id)), ['settings-editing']);
      assert.deepEqual(await page.$$eval('#settings-body select, #settings-body input[type=date], #settings-body input[type=month], ' +
        '#settings-body input[list], #settings-body datalist, #settings-body [title], #settings-body input[type=checkbox]',
        (ns) => ns.map((n) => n.outerHTML.slice(0, 80))), [], 'no native controls');
      assert.deepEqual(app.errors, []);
    });
  });

  test('a click saves at once: one api_setEditing call, aria-checked, toast, State and the other pages follow', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      await tab(page, 'saisie');
      await page.click('#settings-editing-create');
      assert.equal(await page.getAttribute('#settings-editing-create', 'aria-checked'), 'false');
      assert.equal(await lastToast(page), 'Création d’entrées désactivée.');
      await app.waitIdle();
      assert.deepEqual((await callsNamed(app, 'api_setEditing')).map((c) => c.args), [{ create: false }]);
      assert.deepEqual(await page.evaluate(() => State.get().editing), { edit: true, create: false, delete: true });
      assert.deepEqual(await page.evaluate(() => window.__mock.db.editing), { edit: true, create: false, delete: true });
      // Clicking the label switches it too; the toast names the switch.
      await page.click('#settings-editing-delete-label');
      await page.waitForFunction(() => document.getElementById('settings-editing-delete').getAttribute('aria-checked') === 'false');
      await app.waitIdle();
      assert.equal(await lastToast(page), 'Suppression d’entrées désactivée.');
      await page.click('#settings-editing-create');
      await app.waitIdle();
      assert.equal(await lastToast(page), 'Création d’entrées activée.');
      assert.deepEqual((await callsNamed(app, 'api_setEditing')).map((c) => c.args), [{ create: false }, { delete: false }, { create: true }]);

      // Create is back on: Postes shows its create buttons.
      await page.click('#sidebar .nav-link[data-page="postes"]');
      await page.waitForSelector('#postes-table');
      assert.equal(await page.locator('#postes-add').count(), 1);
      assert.deepEqual(app.errors, []);
    });
  });

  test('keyboard: Space and Enter switch it; a failure puts the switch back and shows the error', async () => {
    await withApp({ page: 'settings', delays: { api_setEditing: 300 } }, async (app) => {
      const { page } = app;
      await tab(page, 'saisie');
      await page.focus('#settings-editing-edit');
      await page.keyboard.press('Space');
      // Busy while saving: the new state shows at once, presses are ignored, the focus stays.
      assert.equal(await page.getAttribute('#settings-editing-edit', 'aria-checked'), 'false');
      assert.equal(await page.getAttribute('#settings-editing-edit', 'aria-busy'), 'true');
      await page.keyboard.press('Space');
      await app.waitIdle();
      assert.equal(await page.getAttribute('#settings-editing-edit', 'aria-busy'), null);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-editing-edit');
      assert.deepEqual((await callsNamed(app, 'api_setEditing')).map((c) => c.args), [{ edit: false }], 'the second press was ignored');
      assert.equal(await lastToast(page), 'Modification des entrées désactivée.');
      await page.keyboard.press('Enter');
      await app.waitIdle();
      assert.equal(await page.getAttribute('#settings-editing-edit', 'aria-checked'), 'true');

      await page.evaluate(() => { window.__mock.failNext.api_setEditing = { code: 'BUSY', message: 'Serveur occupé, réessayez.' }; });
      await page.keyboard.press('Space');
      assert.equal(await page.getAttribute('#settings-editing-edit', 'aria-checked'), 'false');
      await app.waitIdle();
      await page.waitForFunction(() => document.getElementById('settings-editing-edit').getAttribute('aria-checked') === 'true');
      assert.equal(await page.textContent('#settings-editing-edit .toggle-state'), 'Activé');
      assert.match(await lastToast(page), /^Erreur : Serveur occupé, réessayez\.$/);
      assert.deepEqual(await page.evaluate(() => State.get().editing), { edit: true, create: true, delete: true });
      assert.deepEqual(app.errors, []);
    });
  });

  test('follows switches changed elsewhere (sync status poll) without re-mounting', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      await tab(page, 'saisie');
      await page.evaluate(() => { document.getElementById('settings-body').__marker = 1; });
      await page.evaluate(() => { window.__mock.db.editing.delete = false; });
      await page.click('#sync-chip');   // the panel refreshes the status (api_getSyncStatus)
      await app.waitIdle();
      assert.equal(await page.getAttribute('#settings-editing-delete', 'aria-checked'), 'false');
      assert.equal(await page.evaluate(() => document.getElementById('settings-body').__marker), 1, 'not re-mounted');
      assert.deepEqual(app.errors, []);
    });
  });

  test('390px: rows fit without sideways scroll, the switch stays on the right of its label', async () => {
    await withApp({ page: 'settings', viewport: { width: 390, height: 844 } }, async (app) => {
      const { page } = app;
      await tab(page, 'saisie');
      await page.locator('#settings-editing').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
      const boxes = await page.$$eval(SWITCHES.join(', '), (ns) => ns.map((n) => {
        const b = n.getBoundingClientRect();
        const l = document.getElementById(n.id + '-label').getBoundingClientRect();
        return { right: b.right, left: b.left, height: b.height, labelRight: l.right };
      }));
      for (const b of boxes) {
        assert.ok(b.right <= 390 - 8, 'inside the viewport: ' + JSON.stringify(b));
        assert.ok(b.left >= b.labelRight, 'beside its label: ' + JSON.stringify(b));
        assert.ok(b.height >= 40, 'touch target: ' + JSON.stringify(b));
      }
      assert.deepEqual(app.errors, []);
    });
  });
});

describe('access (shell)', () => {
  test('lecteur: no Paramètres, no spreadsheet links, role in the sidebar, settings URL falls back', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR }, async (app) => {
      const { page } = app;
      const nav = await page.$$eval('#sidebar .nav-link', (ns) => ns.map((n) => n.dataset.page));
      assert.deepEqual(nav, ['dashboard', 'postes', 'apps', 'timeline', 'actions']);
      assert.equal(await page.$('#link-data'), null);
      assert.equal(await page.$('#link-source'), null);
      assert.equal((await page.textContent('#side-user .side-user-email')).trim(), ACCOUNTS.LECTEUR);
      assert.equal((await page.textContent('#side-user .side-user-role')).trim(), 'Lecteur · lecture seule');
      await page.evaluate(() => App.go('settings'));
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      assert.equal((await callsNamed(app, 'api_getSettings')).length, 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('admin: the role in the sidebar switches to the lecteur view and back', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      const nav = () => page.$$eval('#sidebar .nav-link', (ns) => ns.map((n) => n.dataset.page));
      assert.equal(await page.getAttribute('#side-user-role', 'aria-pressed'), 'false');
      assert.equal((await page.textContent('#side-user-role')).trim(), 'Administrateur');
      assert.equal(await page.$('#reader-view-exit'), null);

      // On: what a lecteur sees (Paramètres gone, so the page falls back to the dashboard; no sheet links).
      await page.click('#side-user-role');
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      assert.equal(await page.getAttribute('#side-user-role', 'aria-pressed'), 'true');
      assert.match((await page.textContent('#side-user-role')).trim(), /^Vue lecteur · lecture seule$/);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'side-user-role');
      assert.deepEqual(await nav(), ['dashboard', 'postes', 'apps', 'timeline', 'actions']);
      assert.equal(await page.$('#link-data'), null);
      assert.equal(await page.$('#link-source'), null);
      assert.ok(await page.isVisible('#reader-view-exit'));
      await page.evaluate(() => App.go('settings'));
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      await page.evaluate(() => App.go('postes'));
      await page.waitForSelector('#main .page[data-page="postes"]');
      assert.equal(await page.$('#postes-add'), null, 'no write control in the lecteur view');
      await page.evaluate(() => App.go('actions'));
      await page.waitForSelector('#main .page[data-page="actions"]');
      assert.equal(await page.$('#action-add'), null);

      // Off again, from the sidebar: the admin controls are back on the same page.
      await page.click('#side-user-role');
      await page.waitForSelector('#action-add');
      assert.equal(await page.getAttribute('#side-user-role', 'aria-pressed'), 'false');
      assert.equal(await page.$('#reader-view-exit'), null);
      assert.deepEqual(await nav(), ['dashboard', 'postes', 'apps', 'timeline', 'actions', 'settings']);
      assert.ok(await page.$('#link-data'));

      // The app bar button leaves the preview too (it shows even when the sidebar is a rail).
      await page.click('#side-user-role');
      await page.waitForSelector('#reader-view-exit');
      await page.click('#reader-view-exit');
      await page.waitForSelector('#action-add');
      assert.equal(await page.getAttribute('#side-user-role', 'aria-pressed'), 'false');
      // Display only: nothing was asked of the server.
      assert.equal((await app.calls()).filter((c) => /Role|Prefs|Config/.test(c.name)).length, 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('lecteur: the role is plain text, not a switch', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR }, async (app) => {
      const { page } = app;
      assert.equal(await page.$('#side-user-role'), null);
      assert.equal(await page.$('#side-user button'), null);
      assert.equal(await page.evaluate(() => { State.setReaderView(true); return State.get().readerView; }), false);
      assert.deepEqual(app.errors, []);
    });
  });

  test('unknown account: « Accès refusé » naming the account, nothing else loaded', async () => {
    await withApp({ email: 'stranger@decathlon.com', readySelector: '.page-denied' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main .page-title')).trim(), 'Accès refusé');
      assert.match(await page.textContent('#denied-message'), /stranger@decathlon\.com/);
      assert.equal(await page.$('#sidebar .nav-link'), null);
      assert.deepEqual((await app.calls()).map((c) => c.name), ['api_bootstrap']);
      // Granted meanwhile: « Réessayer » boots the app.
      await page.evaluate(() => { window.__mock.db.access.domainRole = 'lecteur'; });
      await page.click('.page-denied button:has-text("Réessayer")');
      await page.waitForSelector('#main .page[data-page="dashboard"]');
      assert.equal((await page.textContent('#side-user .side-user-role')).trim(), 'Lecteur · lecture seule');
      assert.deepEqual(app.errors, []);
    });
  });

  test('member of an allowed Google Group gets its role (lecteur)', async () => {
    await withApp({ email: ACCOUNTS.GROUP_MEMBER }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#side-user .side-user-role')).trim(), 'Lecteur · lecture seule');
      assert.equal(await page.$('#sidebar .nav-link[data-page="settings"]'), null);
      assert.deepEqual(app.errors, []);
    });
  });

  test('identity not passed: explains the Workspace domain requirement', async () => {
    await withApp({ email: '', readySelector: '.page-denied' }, async (app) => {
      assert.match(await app.page.textContent('#denied-message'), /même domaine Google Workspace/);
      assert.deepEqual(app.errors, []);
    });
  });

  test('lecteur before any source: waiting screen without the configuration form', async () => {
    await withApp({ email: ACCOUNTS.LECTEUR, configured: false, empty: true,
      readySelector: '.page[data-page="unconfigured"]' }, async (app) => {
      const { page } = app;
      assert.equal(await page.$('#config-source'), null);
      assert.match(await page.textContent('#main'), /Son propriétaire \(le compte qui l’a déployée\) doit d’abord/);
      assert.equal(await page.$('#waiting-open-settings'), null, 'no Paramètres for a lecteur');
      assert.equal((await callsNamed(app, 'api_setConfig')).length, 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('another admin before any source: waiting screen with Paramètres, no source form (owner only)', async () => {
    await withApp({ email: ACCOUNTS.ADMIN2, configured: false, empty: true,
      readySelector: '.page[data-page="unconfigured"]' }, async (app) => {
      const { page } = app;
      assert.equal(await page.$('#config-source'), null);
      assert.match(await page.textContent('#main'), /Son propriétaire/);
      await page.click('#waiting-open-settings');
      await page.waitForSelector('#settings-source-owner-only');
      assert.equal(await page.$('#settings-source'), null);
      assert.equal((await callsNamed(app, 'api_setConfig')).length, 0);
      assert.deepEqual(app.errors, []);
    });
  });

  test('source: only the owner gets the form; another admin sees why', async () => {
    await withApp({ email: ACCOUNTS.ADMIN2, page: 'settings' }, async (app) => {
      const { page } = app;
      assert.equal(await page.$('#settings-source'), null);
      assert.match(await page.textContent('#settings-source-owner-only'), /Seul le propriétaire de l’application/);
      assert.ok(await page.$('#settings-source-info'), 'the current source is still shown');
      // The server (mock) refuses it too.
      const res = await page.evaluate(() => new Promise((resolve) => google.script.run
        .withSuccessHandler(resolve).api_setConfig(JSON.stringify({ source: '1NewSourceIdNewSourceIdNewSourceId0123' }))));
      assert.equal(JSON.parse(res).error.code, 'FORBIDDEN');
      assert.deepEqual(app.errors, []);
    });
  });
});
