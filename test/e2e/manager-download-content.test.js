'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createService, openPage, multiPagePdf, hash } = require('./helpers');

test('manager refuses a protection page as an original and retries the exact PDF', { timeout: 60000 }, async () => {
  let service, browser;
  try {
    service = await createService({ master: true }); browser = await chromium.launch();
    const materials = require('../../src/web/order-materials'), pdf = multiPagePdf();
    const [file] = materials.prepareMaterials([{ originalname: 'План-проверка.pdf', mimetype: 'application/pdf', buffer: pdf }], ['plan']);
    await materials.saveOrderMaterials(58, [file]);
    const visit = await openPage(browser, service, 2001, { pathname: '/form?order_id=58', mobile: false }), page = visit.page;
    const button = page.locator('#existing-files button'); await button.waitFor({ state: 'visible' });
    const pattern = '**/api/audit/orders/58/materials/' + file.id + '*';
    let downloads = 0; page.on('download', () => downloads++);
    for (const [contentType, body] of [['text/html; charset=utf-8', '<html><body>Checking your browser</body></html>'], ['application/json', '{"error":"Synthetic proxy response"}']]) {
      const handler = route => route.fulfill({ status: 200, contentType, body });
      await page.route(pattern, handler); await page.evaluate(() => { window.__e2eAlerts = []; });
      await button.click();
      await page.waitForFunction(() => window.__e2eAlerts.some(text => text.includes('вместо документа')));
      assert.equal(downloads, 0); assert.equal(await button.isDisabled(), false);
      await page.unroute(pattern, handler);
    }
    const pending = page.waitForEvent('download'); await button.click(); const download = await pending;
    assert.equal(download.suggestedFilename(), file.name);
    const stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
    const received = Buffer.concat(chunks); assert.ok(received.equals(pdf)); assert.equal(hash(received), file.sha256);
    assert.equal(downloads, 1); assert.deepEqual(visit.errors, []); assert.deepEqual(visit.blocked, []);
    assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally { await browser?.close(); await service?.close(); }
});
