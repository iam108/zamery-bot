'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const yauzl = require('yauzl');
const { createService, openPage, multiPagePdf, until, hash, LAWYER } = require('./helpers');

async function unzip(buffer) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, result) => error ? reject(error) : resolve(result)));
  return new Promise((resolve, reject) => {
    const files = []; zip.on('error', reject); zip.on('end', () => resolve(files));
    zip.on('entry', entry => zip.openReadStream(entry, async (error, stream) => {
      if (error) return reject(error);
      try { const chunks = []; for await (const chunk of stream) chunks.push(chunk); files.push({ name: entry.fileName, bytes: Buffer.concat(chunks) }); zip.readEntry(); }
      catch (failure) { reject(failure); }
    })); zip.readEntry();
  });
}

test('manual client: mobile creation, exact original and lost ACK recovery need no order, audit or paid EGRN; duplicates require an explicit choice', { timeout: 90000 }, async t => {
  let service, browser, releaseUpload; const visits = [], clientsGroup = '-1007777999944';
  try {
    service = await createService({ master: true, clientsGroup }); browser = await chromium.launch();
    const initialOrders = (await service.pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;
    const initialAudits = (await service.pool.query('SELECT COUNT(*)::int AS n FROM audits')).rows[0].n;
    const visit = await openPage(browser, service, 2001, { pathname: '/handoff?mode=manual', mobile: true }); visits.push(visit);
    let page = visit.page; const profile = { org: 'ООО «Ручной клиент»', address: 'Московская область, Синтетическая улица, 9' };
    await page.locator('#lawyers option[value="' + LAWYER + '"]').waitFor({ state: 'attached' });
    await until(() => page.locator('#manual-files').isEnabled(), 'Manual document storage and empty packet are ready');
    assert.equal(await page.locator('#region').inputValue(), '');
    async function fillProfile() {
      await page.locator('#details').evaluate(element => { element.open = true; });
      await page.locator('#org').fill(profile.org); await page.locator('#org').press('Tab');
      await page.locator('#address').fill(profile.address); await page.locator('#address').press('Tab');
      await page.locator('#region').selectOption('МО');
      await page.locator('#kind').selectOption('Общепит'); await page.locator('#service').selectOption('Получение');
      await page.locator('#lawyers').selectOption(String(LAWYER));
    }
    const pdf = multiPagePdf(), filename = 'Договор ручного клиента.pdf';
    let uploadPosts = 0, committedUpload;
    const uploadAck = new Promise(resolve => { releaseUpload = resolve; });
    await page.route('**/api/handoff/manual-materials?*', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      uploadPosts++; const response = await route.fetch(); assert.equal(response.status(), 200);
      committedUpload = await response.json(); await uploadAck;
      try { await route.fulfill({ response }); } catch (error) { if (!visit.page.isClosed()) throw error; }
    });
    await page.locator('#manual-documents-summary').click();
    const choose = page.waitForEvent('filechooser'); await page.locator('#manual-add-files').click();
    await (await choose).setFiles({ name: filename, mimeType: 'application/pdf', buffer: pdf });
    await until(() => !!committedUpload, 'The first action saves the PDF before the page receives its upload ACK');
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM handoff_manual_materials')).rows[0].n, 1);
    const savedDraftUrl = page.url();
    await page.close(); releaseUpload();
    page = await visit.context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => visit.errors.push(error.message));
    await page.goto(savedDraftUrl, { waitUntil: 'domcontentloaded' });
    await until(() => page.locator('#manual-files').isEnabled(), 'A new page restores the same manual draft and server-confirmed file list');
    await page.locator('#manual-documents-details').evaluate(element => { element.open = true; });
    assert.equal(uploadPosts, 1); assert.equal(await page.locator('#manual-file-list [data-manual-remove]').count(), 1);
    assert.match(await page.locator('#manual-file-list').innerText(), /Договор ручного клиента\.pdf/);
    const stored = (await service.pool.query('SELECT * FROM handoff_manual_materials')).rows;
    assert.equal(stored.length, 1); assert.equal(stored[0].name, filename); assert.equal(stored[0].sha256, hash(pdf));
    assert.ok(Buffer.from(stored[0].content).equals(pdf));
    await fillProfile();

    const submittedBodies = []; let firstResult;
    await page.route('**/api/handoff', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      submittedBodies.push(route.request().postDataJSON());
      const response = await route.fetch(); assert.equal(response.status(), 200);
      const result = await response.json(); assert.equal(result.delivery_complete, true, JSON.stringify(result));
      if (!firstResult) { firstResult = result; return route.abort('failed'); }
      return route.fulfill({ response });
    });
    const start = service.messages.length;
    await page.locator('#go').click(); await page.locator('#review').waitFor({ state: 'visible' });
    assert.match(await page.locator('#review-list').innerText(), /Чек-лист/); assert.match(await page.locator('#review-list').innerText(), /Договор ручного клиента/);
    const artifacts = path.resolve(process.env.E2E_ARTIFACTS_DIR || 'test-results/e2e');
    await fs.mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'manual-mobile-review.png'), fullPage: true });
    await page.locator('#confirm-send').click();
    await until(() => !!firstResult, 'Manual case and private package commit before the HTTP ACK is lost');
    await page.locator('#retry-send').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#manual-create-another').isVisible(), false, 'A possibly delivered client cannot silently become a new draft');
    const afterCommit = service.messages.length;
    await page.reload(); await page.locator('#retry-send').waitFor({ state: 'visible' }); await page.locator('#retry-send').click();
    await page.locator('#manual-create-another').waitFor({ state: 'visible' });
    assert.equal(submittedBodies.length, 2); assert.deepEqual(submittedBodies[1], submittedBodies[0]);
    assert.equal(service.messages.length, afterCommit);
    const body = submittedBodies[0];
    assert.equal(body.manual_client, true); assert.equal(body.order_id, null); assert.equal(body.request_id, null);
    assert.equal(body.report_id, null); assert.equal(body.report_src, null); assert.equal(body.egrn_order, false);
    assert.equal(body.cad_num, ''); assert.deepEqual(body.contacts, []); assert.equal(body.region, 'МО');
    assert.equal(body.manual_files.length, 1); assert.equal(body.manual_files[0].sha256, hash(pdf));
    assert.equal(body.manual_files[0].name, filename); assert.equal(body.submit_id, stored[0].submit_id);
    const cases = (await service.pool.query('SELECT * FROM cases')).rows;
    assert.equal(cases.length, 1); const assigned = cases[0];
    assert.equal(Number(assigned.id), firstResult.id); assert.equal(assigned.order_id, null); assert.equal(assigned.request_id, null);
    assert.equal(assigned.data._handoff.completed, true); assert.equal(assigned.data._handoff.groupNotice.status, 'confirmed');
    assert.equal(assigned.data._handoff.egrn.result, 'skipped-manual'); assert.equal(assigned.org, profile.org);
    const sent = service.messages.slice(start), cards = sent.filter(event => event.method === 'sendMessage' && String(event.args[0]) === String(LAWYER));
    assert.equal(cards.length, 1);
    const cardButtons = cards[0].args[2].reply_markup.inline_keyboard.flat();
    assert.ok(cardButtons.some(button => button.web_app?.url.includes('/checklist?case_id=' + assigned.id)));
    assert.equal(cardButtons.some(button => button.web_app?.url.includes('view=report')), false);
    const archives = sent.filter(event => event.method === 'sendDocument'); assert.equal(archives.length, 1);
    assert.equal(String(archives[0].args[0]), String(LAWYER)); assert.match(archives[0].item.filename, /^Клиент-/);
    const entries = await unzip(archives[0].item.bytes); assert.equal(entries.length, 1);
    assert.match(entries[0].name, /Договор ручного клиента\.pdf$/); assert.equal(hash(entries[0].bytes), hash(pdf)); assert.ok(entries[0].bytes.equals(pdf));
    const notices = sent.filter(event => event.method === 'sendMessage' && String(event.args[0]) === clientsGroup);
    assert.equal(notices.length, 1); assert.match(notices[0].args[1], /Ручной клиент/);
    assert.equal(sent.filter(event => event.method.startsWith('copy')).length, 0);
    for (const event of sent) assert.ok([String(LAWYER), clientsGroup].includes(String(event.args[0])), 'Manual intake never publishes a new workgroup order or report');

    await page.locator('#manual-create-another').click();
    await until(() => page.locator('#manual-files').isEnabled(), 'An explicit next-client action starts a new document draft');
    assert.equal(await page.locator('#org').inputValue(), ''); assert.equal(await page.locator('#manual-file-list [data-manual-remove]').count(), 0);
    await fillProfile(); await page.locator('#go').click(); await page.locator('#manual-matches').waitFor({ state: 'visible' });
    const match = page.locator('#manual-match-list a').filter({ hasText: '№' + assigned.id });
    await match.waitFor({ state: 'visible' }); assert.equal(await page.locator('#review').isVisible(), false);
    assert.equal(await page.locator('#manual-create-new').isChecked(), false);
    assert.equal((await service.pool.query('SELECT id FROM cases')).rows.length, 1);
    await match.click(); await page.waitForURL('**/checklist?case_id=' + assigned.id);
    await page.getByText(profile.org, { exact: true }).first().waitFor({ state: 'visible' });
    await page.goBack(); await page.locator('#lawyers option[value="' + LAWYER + '"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#org').inputValue(), profile.org); assert.equal(await page.locator('#address').inputValue(), profile.address);
    await page.locator('#go').click(); await page.locator('#manual-create-new').waitFor({ state: 'visible' });
    await page.locator('#manual-create-new').check(); await page.locator('#go').click();
    await page.locator('#review').waitFor({ state: 'visible' }); await page.locator('#confirm-send').click();
    await page.locator('#manual-create-another').waitFor({ state: 'visible' });
    assert.equal(submittedBodies.length, 3); assert.notEqual(submittedBodies[2].submit_id, body.submit_id); assert.deepEqual(submittedBodies[2].manual_files, []);
    assert.equal((await service.pool.query('SELECT id FROM cases')).rows.length, 2, 'Only a deliberate duplicate creates the second case');
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n, initialOrders);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM audits')).rows[0].n, initialAudits);
    assert.equal(service.egrnRequests.length, 0);
    assert.equal(service.messages.slice(start).filter(event => event.method === 'sendMessage' && String(event.args[0]) === String(LAWYER)).length, 2);
    assert.equal(service.messages.slice(start).filter(event => event.method === 'sendMessage' && String(event.args[0]) === clientsGroup).length, 2);
    assert.equal(service.messages.slice(start).filter(event => event.method === 'sendDocument').length, 1);
    const desktop = await openPage(browser, service, 2002, { pathname: '/handoff?mode=manual&draft=legacy', mobile: false }); visits.push(desktop);
    await until(() => desktop.page.locator('#manual-files').isEnabled(), 'Desktop manual form is ready');
    assert.equal(await desktop.page.locator('#manual-documents-summary').isVisible(), true);
    await desktop.page.setViewportSize({ width: 1280, height: 1600 });
    await desktop.page.screenshot({ path: path.join(artifacts, 'manual-desktop-form.png'), fullPage: true });

    await t.test('starting a new client from a linked handoff leaves existing drafts intact', async () => {
      const form = desktop.page, legacyUrl = form.url();
      const oldCompany = 'ООО «Старый черновик»', newCompany = 'ООО «Новый независимый черновик»';
      const originalName = 'Документ прежнего клиента.pdf';
      const casesBefore = (await service.pool.query('SELECT COUNT(*)::int AS n FROM cases')).rows[0].n;
      const messagesBefore = service.messages.length;
      const ready = () => until(() => form.locator('#manual-files').isEnabled(), 'Document storage is ready for the current draft');

      await form.locator('#org').fill(oldCompany);
      await form.locator('#manual-documents-summary').click();
      await form.locator('#manual-files').setInputFiles({ name: originalName, mimeType: 'application/pdf', buffer: pdf });
      await form.locator('#manual-file-list').getByText(originalName).waitFor({ state: 'visible' });
      await ready();
      await form.goto(service.origin + '/handoff?order_id=58&' + service.keyQuery(2002));
      await form.getByText('Заявка на замер №58', { exact: true }).waitFor();
      const createClient = form.locator('#create-client-link');
      await createClient.waitFor({state:'visible'});
      const launch = new URL(await createClient.getAttribute('href'), form.url());
      assert.equal(launch.pathname, '/handoff');
      assert.equal(launch.searchParams.get('mode'), 'manual');
      for (const key of ['order_id', 'request_id', 'report_src', 'report_id', 'case_id', 'view', 'draft']) {
        assert.equal(launch.searchParams.has(key), false, key);
      }
      const waitForDraft = () => form.waitForURL(url => url.pathname === '/handoff' && url.searchParams.get('mode') === 'manual' &&
        !url.searchParams.has('new') && /^[0-9a-f-]{36}$/i.test(url.searchParams.get('draft') || ''));
      async function assertBlank() {
        await ready();
        for (const key of ['org', 'address', 'region', 'lawyers', 'comment']) assert.equal(await form.locator('#' + key).inputValue(), '', key);
        assert.equal(await form.locator('#manual-file-list li').count(), 0);
        assert.equal(await form.locator('#packet-section').isVisible(), false);
      }
      await createClient.click();
      await waitForDraft();
      const firstDraft = form.url();
      await assertBlank();
      const resume = form.locator('#resume-manual-draft');
      const legacyResume = new URL(await resume.getAttribute('href'), form.url());
      assert.equal(legacyResume.searchParams.get('draft'), 'legacy');
      assert.equal(legacyResume.searchParams.get('u'), '2002');
      await form.locator('#org').fill(newCompany);
      await form.reload();
      await ready();
      assert.equal(form.url(), firstDraft);
      assert.equal(await form.locator('#org').inputValue(), newCompany, 'Reload reopens the newly scoped draft');

      await form.goto(service.origin + '/handoff?mode=manual&' + service.keyQuery(2002));
      await waitForDraft();
      assert.notEqual(form.url(), firstDraft, 'Explicit launches use separate draft identities');
      await assertBlank();
      await resume.click();
      await form.waitForURL(firstDraft);
      await ready();
      assert.equal(await form.locator('#org').inputValue(), newCompany);
      await form.goto(legacyUrl);
      await ready();
      assert.equal(await form.locator('#org').inputValue(), oldCompany, 'The prior legacy draft remains available');
      assert.equal(await form.locator('#manual-file-list li').count(), 1);
      assert.match(await form.locator('#manual-file-list').textContent(), /Документ прежнего клиента\.pdf/);
      assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM cases')).rows[0].n, casesBefore);
      assert.equal(service.messages.length, messagesBefore);
      assert.equal(service.egrnRequests.length, 0);
    });

    await t.test('manual creation explains invalid INN and resumes review after a failed duplicate check', async () => {
      const mobile = await openPage(browser, service, 2002, { pathname: '/handoff?mode=manual', mobile: true });
      visits.push(mobile);
      const form = mobile.page;
      const queriedInns = [], submissions = [];
      await form.route('**/api/handoff/manual-matches?*', route => {
        queriedInns.push(new URL(route.request().url()).searchParams.get('inn'));
        if (queriedInns.length === 1) return route.fulfill({
          status: 503,
          json: { ok: false, error: 'Не удалось проверить похожих клиентов. Повторите проверку.' },
        });
        return route.continue();
      });
      form.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/handoff') submissions.push(request.postDataJSON());
      });

      const startReview = form.getByRole('button', { name: 'Проверить перед передачей', exact: true });
      await until(() => startReview.isEnabled(), 'Manual form can review the entered data');
      await form.locator('#org').fill('ООО «Проверка ИНН»');
      await form.locator('#address').fill('Московская область, Синтетическая улица, 99');
      await form.locator('#region').selectOption('МО');
      await form.locator('#kind').selectOption('Общепит');
      await form.locator('#service').selectOption('Получение');
      await form.locator('#lawyers').selectOption(String(LAWYER));
      const optional = form.locator('#manual-optional'), inn = form.locator('#inn');
      await optional.locator('summary').click();
      await inn.fill('123456789');
      await optional.locator('summary').click();
      await startReview.click();
      const error = form.locator('#form-error');
      await error.waitFor({ state: 'visible' });
      assert.match(await error.textContent(), /ИНН.*10.*12/);
      assert.equal(await optional.evaluate(section => section.open), true);
      assert.equal(await inn.evaluate(input => input === document.activeElement), true);
      assert.deepEqual(queriedInns, []);
      assert.deepEqual(submissions, []);

      await inn.fill('ИНН: 123\u00a0456 78\u00a090');
      await startReview.click();
      const retry = form.locator('#manual-match-retry');
      await retry.waitFor({ state: 'visible' });
      assert.match(await form.locator('#manual-match-status').textContent(), /Не удалось проверить похожих клиентов/);
      assert.deepEqual(queriedInns, ['1234567890']);
      assert.deepEqual(submissions, []);
      await retry.click();
      const confirm = form.getByRole('button', { name: 'Создать и передать', exact: true });
      await confirm.waitFor({ state: 'visible' });
      assert.deepEqual(queriedInns, ['1234567890', '1234567890']);
      assert.deepEqual(submissions, []);
      await confirm.click();
      await form.locator('#delivery-title').getByText(/Клиент создан/).waitFor({ state: 'visible' });
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].inn, '1234567890');
      assert.equal(submissions[0].manual_client, true);
      assert.equal(submissions[0].egrn_order, false);
      assert.equal(service.egrnRequests.length, 0);
    });
    for (const current of visits) { assert.deepEqual(current.errors, []); assert.deepEqual(current.blocked, []); }
  } finally { releaseUpload?.(); await browser?.close(); await service?.close(); }
});
