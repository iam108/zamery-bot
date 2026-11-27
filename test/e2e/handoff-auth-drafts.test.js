'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { chromium } = require('playwright');
const { createService, until } = require('./helpers');

function launchFragment(id) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: 'Synthetic + manager / & = Ж' })
  });
  const text = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('synthetic-e2e-token').digest();
  params.set('hash', createHmac('sha256', secret).update(text).digest('hex'));
  return '#form?tgWebAppData=' + encodeURIComponent(params.toString()) + '&tgWebAppPlatform=macos';
}

test('handoff drafts remain scoped to the current Telegram launch when a stale keyboard identity and failed SDK share the same browser storage', { timeout: 60000 }, async () => {
  let service, browser, context;
  const errors = [], blocked = [];
  try {
    service = await createService({ master: true });
    browser = await chromium.launch(); context = await browser.newContext({ viewport: { width: 430, height: 850 } });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('https://telegram.org/js/') || url === service.origin + '/auth.js') return route.abort('failed');
      if (url.startsWith(service.origin + '/') || /^(?:blob:|data:)/.test(url)) return route.continue();
      blocked.push(url); return route.abort('blockedbyclient');
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    const ready = async () => {
      await page.locator('#lawyers option[value="3001"]').waitFor({ state: 'attached' });
      await until(() => page.locator('#manual-files').isEnabled(), 'The authenticated manual-client draft is loaded');
    };
    const edit = async (org, comment) => {
      await page.locator('#details').evaluate(element => { element.open = true; });
      await page.locator('#manual-optional').evaluate(element => { element.open = true; });
      await page.locator('#org').fill(org); await page.locator('#comment').fill(comment);
    };
    const cached = key => page.evaluate(value => JSON.parse(localStorage.getItem(value) || 'null'), key);
    const a = { org: 'Synthetic manager A private draft', comment: 'Private comment belonging only to manager A' };
    await page.goto(service.origin + '/handoff?mode=manual&' + service.keyQuery(2001), { waitUntil: 'domcontentloaded' }); await ready();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('tg_u')), '2001');
    await edit(a.org, a.comment);
    const draftA = new URL(page.url()).searchParams.get('draft'), keyA = 'handoff-v2:2001:manual:' + draftA;
    await until(async () => (await cached(keyA))?.comment === a.comment, 'Manager A draft is persisted in its own namespace');
    assert.equal((await cached(keyA)).profile.org, a.org);

    // Telegram's valid signed launch has priority over the old session u/k.
    // The opaque launch is still authenticated by the real server middleware.
    const fragmentB = launchFragment(2002), launchB = service.origin + '/handoff?mode=manual' + fragmentB;
    await page.goto(launchB, { waitUntil: 'domcontentloaded' }); await ready();
    const draftB = new URL(page.url()).searchParams.get('draft'), keyB = 'handoff-v2:2002:manual:' + draftB;
    assert.notEqual(draftB, draftA);
    assert.equal(await page.locator('#org').inputValue(), ''); assert.equal(await page.locator('#comment').inputValue(), '');
    assert.equal(await page.locator('#resume-manual-draft').isVisible(), false, 'Manager B must not be offered manager A draft');
    assert.equal((await cached(keyB)).profile.org, '', 'The authenticated manager B owns this draft namespace');
    assert.equal(await cached('handoff-v2:2001:manual:' + draftB), null, 'A stale keyboard identity cannot own the new launch draft');
    assert.equal((await cached(keyA)).comment, a.comment);

    const b = { org: 'Synthetic manager B separate draft', comment: 'Private comment belonging only to manager B' };
    await edit(b.org, b.comment);
    await until(async () => (await cached(keyB))?.comment === b.comment, 'Manager B draft persists independently');
    assert.equal((await cached(keyB)).profile.org, b.org);
    await page.goto(launchB, { waitUntil: 'domcontentloaded' }); await ready();
    assert.equal(await page.locator('#org').inputValue(), '', 'Opening another new client still starts with blank fields');
    const resume = page.locator('#resume-manual-draft'); await resume.waitFor({ state: 'visible' });
    assert.equal(new URL(await resume.getAttribute('href'), service.origin).searchParams.get('draft'), draftB);
    await resume.click(); await ready();
    await until(() => page.locator('#org').inputValue().then(value => value === b.org), 'The same signed manager can resume its own draft');
    assert.equal(await page.locator('#comment').inputValue(), b.comment);
    assert.equal((await cached(keyA)).profile.org, a.org);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    assert.equal(keys.some(key => key.startsWith('handoff-v2:staff:')), false, 'Authenticated launches must not share the fallback namespace');
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
    assert.equal((await service.pool.query('SELECT COUNT(*)::int AS n FROM cases')).rows[0].n, 0, 'The test saves drafts without creating or handing off clients');
  } finally {
    await context?.close(); await browser?.close(); await service?.close();
  }
});
