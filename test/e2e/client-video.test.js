'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const yauzl = require('yauzl');
const { createService, openPage, until, hash, LAWYER } = require('./helpers');

async function unzip(buffer) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, result) => error ? reject(error) : resolve(result)));
  return new Promise((resolve, reject) => {
    const files = []; zip.on('error', reject); zip.on('end', () => resolve(files));
    zip.on('entry', entry => zip.openReadStream(entry, async (error, stream) => {
      if (error) return reject(error);
      try { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); files.push({ name: entry.fileName, bytes: Buffer.concat(chunks) }); zip.readEntry(); }
      catch (failure) { reject(failure); }
    })); zip.readEntry();
  });
}
async function downloaded(page, button) {
  const next = page.waitForEvent('download'); await button.click(); const item = await next;
  assert.equal(await item.failure(), null);
  return { name: item.suggestedFilename(), bytes: await fs.readFile(await item.path()) };
}

test('an 11 MiB MP4 uploads from the mobile manual-client form and a later video supplement reaches the lawyer once with unchanged bytes', { timeout: 90000 }, async () => {
  let service, browser; const visits = [];
  try {
    service = await createService({ master: true }); browser = await chromium.launch();
    const initial = await openPage(browser, service, 2001, { pathname: '/handoff?mode=manual', mobile: true }); visits.push(initial);
    const page = initial.page;
    await until(() => page.locator('#manual-files').isEnabled(), 'The manual-client document store is ready');
    assert.ok((await page.locator('#manual-files').getAttribute('accept')).split(',').includes('.mp4'), 'The native manual-client picker allows an MP4 video');
    assert.match(await page.locator('#manual-file-limit').textContent(), /видео/i);
    await page.locator('#details').evaluate(element => { element.open = true; });
    await page.locator('#org').fill('ООО «Тест Видео»'); await page.locator('#address').fill('Московская область, Синтетическая улица, 50');
    await page.locator('#region').selectOption('МО'); await page.locator('#kind').selectOption('Общепит'); await page.locator('#service').selectOption('Получение');
    await page.locator('#lawyers').selectOption(String(LAWYER));
    await page.locator('#manual-documents-details').evaluate(element => { element.open = true; });
    const card = Buffer.alloc(11 * 1024 * 1024, 0x35);
    Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,2,0,0x69,0x73,0x6f,0x6d,0x6d,0x70,0x34,0x32]).copy(card);
    const cardName = 'WhatsApp Video — осмотр помещения.mp4';
    const upload = page.waitForResponse(response => new URL(response.url()).pathname === '/api/handoff/manual-materials' && response.request().method() === 'POST');
    const chooser = page.waitForEvent('filechooser'); await page.locator('#manual-add-files').click();
    await (await chooser).setFiles({ name: cardName, mimeType: 'application/octet-stream', buffer: card });
    const uploaded = await upload; assert.equal(uploaded.status(), 200, await uploaded.text());
    await page.locator('#manual-file-list').getByText(cardName, { exact: true }).waitFor();
    await until(() => page.locator('#go').isEnabled(), 'The accepted 11 MiB MP4 is ready for handoff');
    const original = (await service.pool.query('SELECT * FROM handoff_manual_materials WHERE name=$1', [cardName])).rows[0];
    assert.equal(original.mime, 'video/mp4'); assert.equal(Number(original.bytes), 11 * 1024 * 1024); assert.equal(original.sha256, hash(card)); assert.deepEqual(Buffer.from(original.content), card);
    const initialMessage = service.messages.length;
    await page.locator('#go').click(); await page.locator('#review').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#review-list').textContent()).includes(cardName));
    const submitted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/handoff' && response.request().method() === 'POST');
    await page.locator('#confirm-send').click(); const result = await (await submitted).json();
    assert.equal(result.delivery_complete, true, JSON.stringify(result));
    const caseId = Number(result.id); assert.ok(caseId > 0);
    const firstArchives = service.messages.slice(initialMessage).filter(event => event.method === 'sendDocument');
    assert.equal(firstArchives.length, 1); assert.equal(String(firstArchives[0].args[0]), String(LAWYER));
    const firstContents = await unzip(firstArchives[0].item.bytes);
    assert.equal(firstContents.filter(entry => entry.name.endsWith(cardName) && entry.bytes.equals(card)).length, 1);

    const manager = await openPage(browser, service, 2002, { pathname: '/handoff?case_id=' + caseId + '&view=documents', mobile: true }); visits.push(manager);
    const view = manager.page; await until(() => view.locator('#extra-document-add').isEnabled(), 'The existing client supports a supplemental document');
    assert.ok((await view.locator('#extra-document-input').getAttribute('accept')).split(',').includes('.mp4'), 'The supplemental picker also allows video');
    const supplementName = 'Дополнительный осмотр.WEBM', supplement = Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]), Buffer.alloc(4096, 0x22)]);
    const extraUpload = view.waitForResponse(response => new URL(response.url()).pathname === '/api/handoff/manual-materials' && response.request().method() === 'POST');
    await view.locator('#extra-document-input').setInputFiles({ name: supplementName, mimeType: 'video/webm', buffer: supplement });
    const extraResponse = await extraUpload; assert.equal(extraResponse.status(), 200, await extraResponse.text());
    await view.locator('#extra-document-list strong').getByText(supplementName, { exact: true }).waitFor();
    await until(() => view.locator('#extra-document-send').isEnabled(), 'The supplemental video has saved its original');
    const beforeExtra = service.messages.length;
    const delivered = view.waitForResponse(response => new URL(response.url()).pathname === '/api/handoff/cases/' + caseId + '/documents' && response.request().method() === 'POST');
    await view.locator('#extra-document-send').click(); const deliveryResponse = await delivered, extraBody = deliveryResponse.request().postDataJSON(); const extraResult = await deliveryResponse.json();
    assert.equal(extraResult.delivery_complete, true, JSON.stringify(extraResult));
    await view.locator('#extra-document-history').getByRole('button', { name: /Дополнительный осмотр\.WEBM/ }).waitFor();
    const extras = service.messages.slice(beforeExtra).filter(event => event.method === 'sendDocument');
    assert.equal(extras.length, 1); assert.equal(String(extras[0].args[0]), String(LAWYER));
    assert.equal((await unzip(extras[0].item.bytes)).filter(entry => entry.name.endsWith(supplementName) && entry.bytes.equals(supplement)).length, 1);
    const countAfterExtra = service.messages.length;
    const replay = await view.evaluate(async input => {
      const response = await fetch(input.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.body) });
      return { status: response.status, body: await response.json() };
    }, { url: '/api/handoff/cases/' + caseId + '/documents', body: extraBody });
    assert.equal(replay.status, 200); assert.equal(replay.body.delivery_complete, true);
    assert.equal(service.messages.length, countAfterExtra, 'Replaying an acknowledged supplemental video sends no duplicate messages');

    const lawyer = await openPage(browser, service, LAWYER, { pathname: '/handoff?case_id=' + caseId + '&view=documents', mobile: true }); visits.push(lawyer);
    await lawyer.page.locator('#extra-document-history').getByRole('button', { name: /Дополнительный осмотр\.WEBM/ }).waitFor();
    const individual = await downloaded(lawyer.page, lawyer.page.locator('#extra-document-history').getByRole('button', { name: /Дополнительный осмотр\.WEBM/ }));
    assert.equal(individual.name, supplementName); assert.deepEqual(individual.bytes, supplement);
    const packageFile = await downloaded(lawyer.page, lawyer.page.locator('#download-package'));
    const packageContents = await unzip(packageFile.bytes);
    for (const [name, bytes] of [[cardName, card], [supplementName, supplement]]) {
      assert.equal(packageContents.filter(entry => entry.name.endsWith(name) && entry.bytes.equals(bytes)).length, 1, 'The lawyer package contains each unchanged video original once');
    }
    const request = await openPage(browser, service, 2001, { pathname: '/form', mobile: false }); visits.push(request);
    assert.ok((await request.page.locator('#attachments').getAttribute('accept')).split(',').includes('.mp4'), 'The manager request picker supports the same video document format');
    assert.deepEqual(service.egrnRequests, []);
    for (const visit of visits) { assert.deepEqual(visit.errors, []); assert.deepEqual(visit.blocked, []); }
  } finally {
    for (const visit of visits) await visit.context.close();
    await browser?.close(); await service?.close();
  }
});
