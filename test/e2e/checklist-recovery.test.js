'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createService, openPage, until, LAWYER } = require('./helpers');

test('checklist: a newer note survives an older ACK, failed database write and close/reopen; printing waits for the latest edit', { timeout: 90000 }, async () => {
  let browser, service, visit;
  const releases = [];
  const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); releases.push(release); return { promise, release }; };
  try {
    service = await createService({ master: true }); process.env.WEBAPP_URL = service.origin; browser = await chromium.launch();
    let unavailableNote = 'B typed during A', rejectedWrites = 0;
    const query = service.pool.query;
    service.pool.query = async function (sql, args) {
      // The production mutation starts with a locking CTE. Reject the actual
      // write, including close-time retries, rather than depending on whether
      // a page-level network interceptor survives closing the tab.
      if (/\bUPDATE\s+cases\s+SET\s+data\s*=/i.test(String(sql)) && args?.[0]?._comment === unavailableNote) {
        rejectedWrites++; throw new Error('Synthetic connection failure before committing B');
      }
      return query.call(this, sql, args);
    };
    const row = (await service.pool.query(`INSERT INTO cases(order_id,lawyer_tg_id,lawyer_name,org,address,region,kind,service,checklist_key,created_by,data)
      VALUES(58,$1,'Synthetic lawyer','Synthetic checklist recovery','Москва','МСК','Магазин','Продление','MSK_MAG',2001,'{}') RETURNING id`, [LAWYER])).rows[0];
    const storedNote = async () => (await service.pool.query('SELECT data FROM cases WHERE id=$1', [row.id])).rows[0].data._comment;
    visit = await openPage(browser, service, LAWYER, { pathname: '/checklist?case_id=' + row.id, mobile: false });
    await visit.context.addInitScript(() => { window.print = () => {}; });
    const page = visit.page, first = gate(); let saves = 0;
    await page.locator('#lawyer-note').waitFor();
    await page.route('**/api/checklist/save', async route => {
      const number = ++saves;
      if (number === 1) await first.promise;
      try { await route.continue(); } catch (_) { /* Closing the old tab cancels its pending save. */ }
    });
    await page.locator('#lawyer-note').fill('A acknowledged note'); await page.locator('#st').click();
    await until(() => saves === 1, 'First checklist save held before the server');
    await page.locator('#lawyer-note').fill('B typed during A'); first.release();
    await until(() => page.evaluate(id => {
      const draft = JSON.parse(localStorage.getItem('zamery_cl_' + id) || 'null');
      return draft?.noteBase === 'A acknowledged note' && draft.d._comment === 'B typed during A';
    }, row.id), 'The newer note backup retains the acknowledged baseline');
    assert.notEqual(await page.locator('#st').innerText(), 'Сохранено');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await until(() => saves >= 2 && rejectedWrites > 0, 'Pagehide reaches the injected database failure before committing B'); await page.close();
    assert.equal(await storedNote(), 'A acknowledged note', 'The failed database write did not deliver B before reopening');

    const reopened = await visit.context.newPage(); const errors = [];
    reopened.on('pageerror', error => errors.push(error.message));
    await reopened.goto(service.origin + '/checklist?case_id=' + row.id + '&' + service.keyQuery(LAWYER));
    await until(async () => await reopened.locator('#lawyer-note').inputValue() === 'B typed during A', 'Reopened form restores B');
    unavailableNote = null;
    await until(async () => await storedNote() === 'B typed during A', 'Recovered B reaches PostgreSQL');
    await until(async () => await reopened.locator('#st').innerText() === 'Сохранено', 'Recovered B is acknowledged');

    // The next save reaches PostgreSQL, but its HTTP ACK never reaches this tab.
    const lostAck = gate();
    await reopened.route('**/api/checklist/save', async route => {
      const response = await route.fetch(); await lostAck.promise;
      try { await route.fulfill({ response }); } catch (_) { /* The original tab is closed. */ }
    });
    await reopened.locator('#lawyer-note').fill('C committed with lost ACK'); await reopened.locator('#st').click();
    await until(async () => await storedNote() === 'C committed with lost ACK', 'C committed before its ACK');
    assert.equal(await reopened.evaluate(id => JSON.parse(localStorage.getItem('zamery_cl_' + id)).noteBase, row.id), 'B typed during A');
    await reopened.close(); lostAck.release();
    const current = await visit.context.newPage(); current.on('pageerror', error => errors.push(error.message));
    await current.goto(service.origin + '/checklist?case_id=' + row.id + '&' + service.keyQuery(LAWYER));
    await current.locator('#lawyer-note').waitFor();
    assert.equal(await current.locator('#lawyer-note').inputValue(), 'C committed with lost ACK');
    assert.equal(await current.evaluate(id => localStorage.getItem('zamery_cl_' + id), row.id), null);

    const printA = gate(), printB = gate(); let printSaves = 0, printLinks = 0;
    await current.route('**/api/checklist/save', async route => {
      printSaves++; await (printSaves === 1 ? printA.promise : printB.promise); await route.continue();
    });
    current.on('request', request => { if (request.url().endsWith('/api/checklist/printlink')) printLinks++; });
    await current.locator('#lawyer-note').fill('D before printing'); await current.locator('#printBtn').click();
    await until(() => printSaves === 1, 'Printing waits for its current save');
    await current.locator('#lawyer-note').fill('E latest printed note'); assert.equal(printLinks, 0);
    printA.release(); await until(() => printSaves === 2, 'Printing also waits for the edit made during its first save');
    assert.equal(printLinks, 0); printB.release();
    await current.waitForURL(url => url.pathname === '/checklist' && url.searchParams.get('print') === '1');
    assert.equal(await storedNote(), 'E latest printed note'); assert.equal(printLinks, 1);
    await current.getByText('E latest printed note', { exact: true }).waitFor();
    assert.deepEqual(visit.errors, []); assert.deepEqual(errors, []); assert.deepEqual(visit.blocked, []);
    assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally {
    releases.forEach(release => release());
    if (visit) await visit.context.close(); if (browser) await browser.close(); if (service) await service.close();
  }
});
