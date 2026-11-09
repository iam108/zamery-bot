'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { createService } = require('./helpers');

let service, browser;
before(async () => { service = await createService({ master: true }); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await service?.close(); });

function signedInit({ date = Math.floor(Date.now() / 1000), name = 'Synthetic + lawyer / & = Ж' } = {}) {
  const data = new URLSearchParams({ auth_date: String(date), user: JSON.stringify({ id: 3001, first_name: name }) });
  const check = [...data].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update('synthetic-e2e-token').digest();
  data.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex')); return data.toString();
}
async function entry({ raw = '', signedKey = false, blockAuth = false, unsafeOnly = false, hashPath = '' } = {}, run) {
  const context = await browser.newContext(), errors = [], blocked = [];
  try {
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('https://telegram.org/js/')) {
        if (!unsafeOnly) return route.abort();
        return route.fulfill({ contentType: 'application/javascript', body: 'window.Telegram={WebApp:{initData:"",initDataUnsafe:{user:{id:3001}},ready(){},expand(){},showAlert(){}}};' });
      }
      if (blockAuth && url === service.origin + '/auth.js') return route.abort();
      if (url.startsWith(service.origin + '/')) return route.continue();
      blocked.push(url); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.goto(service.origin + '/form' + (signedKey ? '?' + service.keyQuery(3001) : '') +
      (raw ? '#' + hashPath + 'tgWebAppData=' + encodeURIComponent(raw) + '&tgWebAppPlatform=macos' : ''), { waitUntil: 'domcontentloaded' });
    const access = await page.evaluate(async () => { const response = await fetch('/api/order/access'); return { status: response.status, data: await response.json() }; });
    await run({ page, access });
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    assert.equal(service.messages.length, 0); assert.equal(service.egrnRequests.length, 0);
  } finally { await context.close(); }
}

for (const hashPath of ['', 'form?']) test('the static manager menu keeps signed launch authentication when the Telegram SDK is unavailable; hash prefix=' + hashPath, { timeout: 30000 }, async () => {
  const raw = signedInit();
  await entry({ raw, hashPath }, async ({ page, access }) => {
    assert.equal(access.status, 200, JSON.stringify(access.data)); assert.equal(access.data.ok, true);
    assert.equal(await page.evaluate(() => !!window.fetch.__tg), true);
  });
});

test('the signed keyboard still authenticates if both external SDK and /auth.js fail to load', { timeout: 30000 }, async () => {
  await entry({ signedKey: true, blockAuth: true }, async ({ page, access }) => {
    assert.equal(access.status, 200, JSON.stringify(access.data)); assert.equal(access.data.ok, true);
    assert.equal(await page.evaluate(() => !!window.fetch.__tg), true, 'The shared authentication bridge must also be in the form HTML');
  });
});

test('a tampered or expired launch hash remains unauthorized when the SDK is unavailable', { timeout: 30000 }, async () => {
  const raw = signedInit(), tampered = new URLSearchParams(raw); tampered.set('user', JSON.stringify({ id: 2001 }));
  for (const value of [tampered.toString(), signedInit({ date: Math.floor(Date.now() / 1000) - 8 * 86400 })]) {
    await entry({ raw: value }, async ({ access }) => { assert.equal(access.status, 401); assert.equal(access.data.ok, false); });
  }
});

test('initDataUnsafe identity alone never authenticates a fresh static-menu entry', { timeout: 30000 }, async () => {
  await entry({ unsafeOnly: true }, async ({ access }) => { assert.equal(access.status, 401); assert.equal(access.data.ok, false); });
});
