'use strict';
/**
 * E2E tests of Paramètres (source, threshold, access list) and of the access-dependent shell:
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

async function lastToast(page) {
  await page.waitForSelector('.toast');
  return page.$$eval('.toast .toast-msg', (ts) => ts[ts.length - 1].textContent.trim());
}

describe('settings (admin)', () => {
  test('renders the three sections with the current values', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
      assert.equal((await page.textContent('#main .page-title')).trim(), 'Paramètres');
      const titles = await page.$$eval('#settings-body .section-title', (ns) => ns.map((n) => n.textContent.trim()));
      assert.deepEqual(titles, ['Source de données', 'Seuil de conformité', 'Accès']);
      assert.equal((await page.textContent('#settings-source-link')).trim(), 'ShadowIT_Industry');
      assert.match(await page.textContent('#settings-source-info'), /Suivi des postes/);
      assert.equal(await page.inputValue('#settings-threshold'), '80');
      assert.ok(await page.isHidden('#settings-threshold-reset'));
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

  test('source: invalid value shown on the field, valid one saved', async () => {
    await withApp({ page: 'settings' }, async (app) => {
      const { page } = app;
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
      assert.deepEqual(app.errors, []);
    });
  });

  test('before any source: the configuration screen links to Paramètres, which works without data', async () => {
    await withApp({ configured: false, empty: true }, async (app) => {
      const { page } = app;
      await page.click('#config-open-settings');
      await page.waitForSelector('#main .page[data-page="settings"] #access-table');
      await app.waitIdle();
      assert.match(await page.textContent('#settings-source-info'), /Non configuré/);
      await page.fill('#access-email', 'first.reader@decathlon.com');
      await page.click('#access-add');
      assert.match(await lastToast(page), /Accès ajouté/);
      // Saving the first source keeps the admin on Paramètres with the full shell.
      await page.fill('#settings-source', '1FirstSourceFirstSourceFirstSource00');
      await page.click('#settings-source-submit');
      await page.waitForFunction(() => !document.body.classList.contains('unconfigured'));
      await page.waitForSelector('#main .page[data-page="settings"] #settings-source-link');
      assert.equal(await page.evaluate(() => State.get().configured), true);
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
      assert.match(await page.textContent('#main'), /Un administrateur doit d’abord/);
      assert.equal((await callsNamed(app, 'api_setConfig')).length, 0);
      assert.deepEqual(app.errors, []);
    });
  });
});
