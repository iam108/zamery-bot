'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createService, until, LAWYER } = require('./helpers');

let browser, service;
before(async () => { service = await createService({ master: true }); process.env.WEBAPP_URL = service.origin; browser = await chromium.launch(); });
after(async () => { await browser?.close(); await service?.close(); });

const challenge = '<!doctype html><title>Checking your browser</title><script>window.__bootChallengeExecuted=true;</script><h1>Checking your browser</h1><p>PRIVATE_GATEWAY_DIAGNOSTIC</p>';
async function fixture(run, { deadline = false } = {}) {
  const original = { _stage: 'Сбор документов', _comment: 'Preserved before initial loading failure', basis: 'Аренда', _handoff: { version: 2, fields: { comment: 'Private backend checkpoint' } } };
  const row = (await service.pool.query(`INSERT INTO cases(lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data)
    VALUES($1,'Synthetic lawyer','Synthetic boot recovery','Synthetic address','МСК','Магазин','Продление','MSK_MAG',2001,$2) RETURNING id`, [LAWYER, original])).rows[0];
  const context = await browser.newContext({ viewport: { width: 430, height: 850 } }), errors = [], blocked = [];
  try {
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('https://telegram.org/js/')) return route.abort('failed');
      if (url.startsWith(service.origin + '/')) return route.continue();
      blocked.push(url); return route.abort('blockedbyclient');
    });
    // Exercise the real deadline without making the regression wait 20 seconds.
    if (deadline) await context.addInitScript(() => { const timeout = window.setTimeout; let shortened = false; window.setTimeout = (fn, ms, ...args) => { const delay = ms === 20000 && !shortened ? (shortened = true, 80) : ms; return timeout(fn, delay, ...args); }; });
    const page = await context.newPage(); page.setDefaultTimeout(3000); page.on('pageerror', error => errors.push(error.message));
    const url = service.origin + '/checklist?case_id=' + row.id + '&' + service.keyQuery(LAWYER);
    await run({ page, context, url, id: row.id, original });
    const saved = (await service.pool.query('SELECT data FROM cases WHERE id=$1', [row.id])).rows[0];
    assert.deepEqual(saved.data, original); assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally { await context.close(); }
}

for (const status of [200, 502]) test('initial checklist rejects HTTP ' + status + ' challenge and retries in the same authenticated window', { timeout: 30000 }, () => fixture(async ({ page, url, original }) => {
  let attempts = 0;
  await page.route('**/checklist/view?*', route => ++attempts === 1
    ? route.fulfill({ status, contentType: 'text/html', body: challenge }) : route.continue());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#checklist-boot-retry').waitFor();
  assert.equal(await page.evaluate(() => window.__bootChallengeExecuted === true), false, 'A gateway response must never execute inside the client form');
  assert.doesNotMatch(await page.locator('body').innerText(), /Checking your browser|PRIVATE_GATEWAY_DIAGNOSTIC/);
  assert.equal(page.url(), url); await page.locator('#checklist-boot-retry').click();
  await page.locator('#lawyer-note').waitFor(); assert.equal(await page.locator('#lawyer-note').inputValue(), original._comment);
  assert.equal(attempts, 2); assert.equal(page.url(), url);
}));

test('initial checklist bounds a stalled request and ignores its late response after an explicit retry', { timeout: 30000 }, () => fixture(async ({ page, context, url, original }) => {
  let release, attempts = 0; const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.route('**/checklist/view?*', async route => {
      if (++attempts !== 1) return route.continue();
      await gate; try { await route.fulfill({ status: 200, contentType: 'text/html', body: challenge }); } catch (_) { /* The timed-out request was aborted. */ }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#checklist-boot-retry').waitFor();
    assert.match(await page.locator('#checklist-boot-status').innerText(), /время|долго|ответил/i);
    await page.locator('#checklist-boot-retry').click(); await page.locator('#lawyer-note').waitFor();
    release(); await until(() => attempts === 2, 'One explicit retry reaches the server');
    assert.equal(await page.locator('#lawyer-note').inputValue(), original._comment);
    assert.equal(await page.evaluate(() => window.__bootChallengeExecuted === true), false); assert.equal(page.url(), url);
  } finally { release(); }
}, { deadline: true }));

test('initial checklist keeps an actual access refusal visible and never exposes its protected data', { timeout: 30000 }, () => fixture(async ({ page, url }) => {
  await page.route('**/checklist/view?*', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Этот клиент недоступен вашему аккаунту.' }) }));
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.locator('#checklist-boot-retry').waitFor();
  assert.match(await page.locator('#checklist-boot-status').innerText(), /недоступен/); assert.equal(await page.locator('#lawyer-note').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /Synthetic boot recovery|Preserved before|Private backend/);
}));
