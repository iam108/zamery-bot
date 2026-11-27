'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createService, openPage, until } = require('./helpers');
let service, browser;
before(async () => {
  service = await createService({ master: true });
  await service.pool.query("UPDATE orders SET object_type='Другое',service='',has_video=false WHERE id IN(58,59,60,61)");
  browser = await chromium.launch();
});

for (const committed of [false, true]) test('a wrong draft-save acknowledgement ' + (committed ? 'after commit' : 'before commit') + ' preserves a newer comment through closing and reopening', { timeout: 60000 }, async () => {
  const order = committed ? 61 : 60, visit = await openPage(browser, service, 1001, { pathname: '/audit?order_id=' + order, mobile: true });
  const page = visit.page, errors = [];
  let release, arrived, reopened;
  const gate = new Promise(resolve => { release = resolve; }), captured = new Promise(resolve => { arrived = resolve; });
  try {
    await page.getByRole('heading', { name: 'Общий осмотр', exact: true }).waitFor();
    await page.locator('#steps [data-step="2"]').click();
    const note = page.locator('[data-bind="conclusion"]');
    await note.fill('Synthetic acknowledged baseline.'); await page.locator('#save-now').click();
    await until(async () => (await service.draft(order))?.data.conclusion === 'Synthetic acknowledged baseline.', 'The baseline is saved before injecting a bad reply');
    const draft = await service.draft(order), finalText = 'A newer comment typed while the earlier save was awaiting its acknowledgement.';
    let writes = 0;
    await page.route('**/api/audit/drafts/*', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      const body = JSON.parse(route.request().postData());
      let reply = { ok: true, draft: { id: draft.id, order_id: order, revision: body.revision + 1, data: body.data, evidence: [] } };
      if (++writes === 1) {
        if (committed) { const response = await route.fetch(); assert.equal(response.status(), 200); reply = await response.json(); }
        arrived(); await gate;
      }
      reply.draft.id = 'another-draft';
      try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) }); } catch (_) { /* Closing may cancel the old page's unconfirmed retry. */ }
    });
    await note.fill('The first attempted new comment.'); await page.locator('#save-now').click(); await captured;
    await note.fill(finalText); release();
    await until(async () => /не подтвердил сохранение этой версии/.test(await page.locator('#save-state').innerText()), 'The malformed response must not show a saved status');
    const backup = await page.evaluate(orderId => JSON.parse(localStorage.getItem('audit-wizard-v3:1001:' + orderId)), String(order));
    assert.equal(backup.dirty, true); assert.equal(backup.data.conclusion, finalText); assert.equal(backup.draft_id, draft.id);
    assert.equal(backup.attempt.draft_id, draft.id);
    await page.close();
    reopened = await visit.context.newPage(); reopened.setDefaultTimeout(10000); reopened.on('pageerror', error => errors.push(error.message));
    await reopened.goto(service.origin + '/audit?order_id=' + order + '&' + service.keyQuery(1001), { waitUntil: 'domcontentloaded' });
    await reopened.locator('[data-bind="conclusion"]').waitFor();
    assert.equal(await reopened.locator('[data-bind="conclusion"]').inputValue(), finalText);
    await until(async () => (await service.draft(order))?.data.conclusion === finalText, 'The restored latest comment reaches the real temporary database');
    const restored = await service.draft(order); assert.equal(restored.id, draft.id);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM audit_drafts WHERE order_id=$1', [order])).rows[0].n, 1);
    assert.deepEqual(visit.errors, []); assert.deepEqual(errors, []); assert.deepEqual(visit.blocked, []);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM audits WHERE order_id=$1', [order])).rows[0].n, 0);
    assert.equal(service.egrnRequests.length, 0);
  } finally { release(); await visit.context.close(); }
});
after(async () => { await browser?.close(); await service?.close(); });

for (const committed of [false, true]) test('an incorrect audit acknowledgement ' + (committed ? 'after committing' : 'without sending') + ' keeps recovery and never claims delivery of another draft', { timeout: 60000 }, async () => {
  const order = committed ? 59 : 58, start = service.messages.length;
  const visit = await openPage(browser, service, 1001, { pathname: '/audit?order_id=' + order, mobile: true });
  const page = visit.page;
  try {
    await page.getByRole('heading', { name: 'Общий осмотр', exact: true }).waitFor();
    await page.locator('#steps [data-step="2"]').click();
    await page.locator('[data-bind="conclusion"]').fill('Synthetic audit facts must survive an incorrect server acknowledgement.');
    await page.locator('#save-now').click();
    await until(async () => !!(await service.draft(order))?.data.conclusion, 'The synthetic draft is saved before submitting');
    const draft = await service.draft(order);
    let intercepted = 0;
    await page.route('**/api/audit', async route => {
      intercepted++;
      assert.equal(JSON.parse(route.request().postData()).draft_id, draft.id);
      if (committed) {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        const result = await response.json(); assert.equal(result.ok, true); assert.equal(result.draft_id, draft.id);
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft_id: 'another-draft' }) });
    });
    await page.locator('#submit-audit').click();
    await until(async () => /не подтвердил отправку этого отчёта/.test(await page.locator('#submit-status').innerText()), 'An incorrect acknowledgement is shown as unconfirmed');
    assert.equal(intercepted, 1);
    assert.equal(await page.getByRole('heading', { name: 'Отчёт отправлен', exact: true }).count(), 0);
    assert.equal(await page.evaluate(orderId => !!localStorage.getItem('audit-wizard-v3:1001:' + orderId), String(order)), true, 'Keep local recovery until the correct draft is acknowledged');
    const stored = (await service.pool.query('SELECT * FROM audit_drafts WHERE id=$1', [draft.id])).rows[0];
    assert.equal(!!stored.submitted_at, committed);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM audits WHERE order_id=$1', [order])).rows[0].n, committed ? 1 : 0);
    if (!committed) assert.equal(service.messages.length, start, 'A fabricated HTTP reply must not create a report');
    const existingSends = service.messages.length;
    await page.unroute('**/api/audit');
    await page.locator('#submit-audit').click();
    await page.getByRole('heading', { name: 'Отчёт отправлен', exact: true }).waitFor();
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM audits WHERE order_id=$1', [order])).rows[0].n, 1);
    if (committed) assert.equal(service.messages.length, existingSends, 'Checking the already submitted draft does not repeat its Telegram delivery');
    assert.equal(await page.evaluate(orderId => localStorage.getItem('audit-wizard-v3:1001:' + orderId), String(order)), null);
    assert.deepEqual(visit.errors, []); assert.deepEqual(visit.blocked, []); assert.equal(service.egrnRequests.length, 0);
  } finally { await visit.context.close(); }
});
