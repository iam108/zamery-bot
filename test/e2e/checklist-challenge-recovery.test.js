'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createService, openPage, until, LAWYER } = require('./helpers');

const challenge = '<!doctype html><title>Checking your browser...</title><style>:root { --bg: hsl(250,24%,9%); --fg: hsl(0,0%,100%); }</style><h1>Checking your browser...</h1>';
let browser, service;
before(async () => {
  service = await createService({ master: true }); process.env.WEBAPP_URL = service.origin;
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (service) await service.close(); });

for (const mobile of [false, true]) test('checklist: gateway challenge recovers latest answers in the same ' + (mobile ? 'mobile' : 'desktop') + ' window', { timeout: 90000 }, async () => {
  let visit;
  try {
    const row = (await service.pool.query(`INSERT INTO cases(order_id,lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data)
      VALUES($2,$1,'Synthetic lawyer','Synthetic connection recovery','Москва','МСК','Магазин','Продление','MSK_MAG',2001,'{}') RETURNING id`, [LAWYER, mobile ? 59 : 58])).rows[0];
    const storedNote = async () => (await service.pool.query('SELECT data FROM cases WHERE id=$1', [row.id])).rows[0].data._comment;
    visit = await openPage(browser, service, LAWYER, { pathname: '/checklist?case_id=' + row.id, mobile });
    const page = visit.page, originalUrl = page.url(); let challenged = true, requests = 0;
    await page.route('**/api/checklist/save', route => {
      requests++;
      return challenged ? route.fulfill({ status: 200, contentType: 'text/html', body: challenge }) : route.continue();
    });
    await page.locator('#lawyer-note').fill('Draft before gateway challenge'); await page.locator('#st').click();
    await page.locator('#connectionBtn').waitFor({ state: 'visible' });
    assert.match(await page.locator('#st').innerText(), /На устройстве/);
    assert.doesNotMatch(await page.locator('.dock').innerText(), /Checking|:root|hsl|повтор через/);
    assert.equal(await storedNote(), undefined);

    // The next edit has not been sent when recovery is clicked. It must be in
    // the durable checkpoint before a same-webview navigation is allowed.
    await page.locator('#lawyer-note').fill('Latest draft after challenge');
    assert.equal(await page.evaluate(id => JSON.parse(localStorage.getItem('zamery_cl_' + id)).d._comment, row.id), 'Latest draft after challenge');
    const layout = await page.locator('#connectionBtn').evaluate(button => {
      const box = button.getBoundingClientRect(); return { width: box.width, height: box.height, right: box.right, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth };
    });
    assert.ok(layout.height >= 44); assert.ok(layout.right <= layout.viewport + 1); assert.ok(layout.pageWidth <= layout.viewport + 1);
    assert.equal(requests, 1, 'Challenge pauses background retries, including queued edits');
    challenged = false;
    await Promise.all([page.waitForEvent('load'), page.locator('#connectionBtn').click()]);
    assert.equal(page.url(), originalUrl, 'Recovery retains the case and Telegram authentication URL');
    await until(async () => await storedNote() === 'Latest draft after challenge', 'Recovered latest draft reaches the database');
    await until(async () => await page.locator('#st').innerText() === 'Сохранено', 'Server acknowledges recovered draft');
    assert.equal(await page.locator('#connectionBtn').isVisible(), false);
    assert.equal(await page.evaluate(id => localStorage.getItem('zamery_cl_' + id), row.id), null);

    // A gateway page returned by printlink must not become a printable URL or
    // navigate the user away from the checklist.
    await page.route('**/api/checklist/printlink', route => route.fulfill({ status: 200, contentType: 'text/html', body: challenge }));
    await page.locator('#printBtn').click(); await page.locator('#connectionBtn').waitFor({ state: 'visible' });
    assert.equal(page.url(), originalUrl); assert.doesNotMatch(await page.locator('#st').innerText(), /Checking|:root|hsl/);
    assert.deepEqual(visit.errors, []); assert.deepEqual(visit.blocked, []);
    assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally {
    if (visit) await visit.context.close();
  }
});

test('checklist: storage failure blocks recovery reload and keeps the live answers visible', { timeout: 90000 }, async () => {
  let visit;
  try {
    const row = (await service.pool.query(`INSERT INTO cases(order_id,lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data)
      VALUES(60,$1,'Synthetic lawyer','Synthetic unavailable storage','Москва','МСК','Магазин','Продление','MSK_MAG',2001,'{}') RETURNING id`, [LAWYER])).rows[0];
    visit = await openPage(browser, service, LAWYER, { pathname: '/checklist?case_id=' + row.id });
    const page = visit.page; let reloads = 0;
    page.on('request', request => { if (request.isNavigationRequest()) reloads++; });
    await page.route('**/api/checklist/save', route => route.fulfill({ status: 200, contentType: 'text/html', body: challenge }));
    await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); }; });
    await page.locator('#lawyer-note').fill('Only live draft: do not close'); await page.locator('#st').click();
    await page.locator('#connectionBtn').waitFor({ state: 'visible' });
    assert.match(await page.locator('#st').innerText(), /не закрывайте окно/);
    assert.doesNotMatch(await page.locator('#st').innerText(), /На устройстве/);
    await page.locator('#connectionBtn').click();
    assert.equal(reloads, 0); assert.equal(await page.locator('#lawyer-note').inputValue(), 'Only live draft: do not close');
    assert.equal(await page.evaluate(id => localStorage.getItem('zamery_cl_' + id), row.id), null);
    assert.deepEqual(visit.errors, []); assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally {
    if (visit) await visit.context.close();
  }
});
