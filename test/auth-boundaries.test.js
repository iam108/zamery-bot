const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { adminPasswordMatches } = require('../src/web/index');

function authHarness() {
  const env = { BOT_TOKEN: 'synthetic-test-token', ADMIN_TG_IDS: '99' };
  const routes = new Map();
  const context = vm.createContext({ module: { exports: {} }, Buffer, URLSearchParams, Date, process: { env }, console,
    require(name) { return name === '../db/pool' ? { query: async () => ({ rows: [] }) } : require(name); } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/web/auth'), 'utf8'), context);
  const auth = context.module.exports;
  auth.setupAuth({ get(path, handler) { routes.set(path, handler); }, use() {} });
  return { auth, env, routes };
}

function telegramSignature(env, fields) {
  const params = new URLSearchParams(fields);
  const text = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(text).digest('hex'));
  return params.toString();
}

test('signed print links accept ordinary valid signatures and reject malformed encodings without throwing', () => {
  const { auth } = authHarness();
  const link = new URLSearchParams(auth.signCase(17, 24));
  assert.equal(auth.checkCaseSig(17, link.get('exp'), link.get('sig')), true);
  for (const sig of ['я'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), ['a'.repeat(32)], {}, null]) {
    assert.doesNotThrow(() => assert.equal(auth.checkCaseSig(17, link.get('exp'), sig), false));
  }
  for (const exp of ['NaN', '1e12', '0', '123x', ['2147483647'], '999999999999999999999']) {
    assert.equal(auth.checkCaseSig(17, exp, link.get('sig')), false);
  }
  assert.equal(auth.checkCaseSig(18, link.get('exp'), link.get('sig')), false);
  assert.equal(auth.checkCaseSig(17, '1', link.get('sig')), false);
});

test('Telegram initialization requires a signed valid user ID and a bounded authentication date', () => {
  const { auth, env } = authHarness();
  const now = Math.floor(Date.now() / 1000);
  for (const [date, user, expected] of [[now, { id: 42 }, true], [now + 86400, { id: 42 }, false],
    [now - 8 * 86400, { id: 42 }, false], ['oops', { id: 42 }, false], [now, { id: '42' }, false], [now, { id: -1 }, false]]) {
    const signed = telegramSignature(env, { auth_date: String(date), user: JSON.stringify(user) });
    assert.equal(Boolean(auth.checkInitData(signed)), expected);
  }
});

test('case access requires approval and assigned-lawyer or manager authority', () => {
  const { auth } = authHarness();
  const row = { lawyer_tg_id: '42' };
  assert.equal(auth.canAccessCase({ approved: true, role: 'lawyer' }, 42, row), true);
  assert.equal(auth.canAccessCase({ approved: true, role: 'lawyer' }, 43, row), false);
  assert.equal(auth.canAccessCase({ approved: true, role: 'auditor' }, 42, row), false);
  assert.equal(auth.canAccessCase({ approved: true, role: 'manager' }, 43, row), true);
  assert.equal(auth.canManageCases({ approved: false, role: 'manager' }, 99), false);
  assert.equal(auth.canManageCases({ approved: true, role: 'lawyer' }, 99), true);
});

test('browser authentication headers stay on the exact application origin', async () => {
  const { routes } = authHarness();
  let client;
  routes.get('/auth.js')({}, { type() { return this; }, set() { return this; }, send(value) { client = value; } });
  const calls = [];
  const context = vm.createContext({ URL, URLSearchParams, Headers, Request,
    location: { href: 'https://bot.example/audit?u=42&k=synthetic', origin: 'https://bot.example', search: '?u=42&k=synthetic' },
    sessionStorage: { getItem() {}, setItem() {} },
    window: { Telegram: { WebApp: { initData: 'synthetic-init-data' } }, fetch: async (url, options) => calls.push({ url, options }) } });
  vm.runInContext(client, context);
  for (const url of ['/api/audit', 'https://bot.example/api/audit', '//other.example/api', 'https://bot.example.evil.invalid/collect']) {
    await context.window.fetch(url);
  }
  for (let i = 0; i < calls.length; i++) {
    assert.equal(calls[i].options.headers?.get('X-Tg-Init'), i < 2 ? 'synthetic-init-data' : undefined);
    assert.equal(calls[i].options.headers?.get('X-Tg-K'), i < 2 ? 'synthetic' : undefined);
  }
  await context.window.fetch(new URL('https://other.example/collect'));
  assert.equal(calls.at(-1).options.headers?.get('X-Tg-K'), undefined);
  const request = new Request('https://bot.example/api/audit', { headers: { 'X-Custom': 'preserved' } });
  await context.window.fetch(request);
  assert.equal(calls.at(-1).url, request);
  assert.equal(calls.at(-1).options.headers.get('X-Custom'), 'preserved');
});

test('an absent, blank or non-string administrator password cannot establish a session', () => {
  const previous = process.env.ADMIN_PASSWORD;
  try {
    delete process.env.ADMIN_PASSWORD;
    assert.equal(adminPasswordMatches(undefined), false);
    assert.equal(adminPasswordMatches(''), false);
    process.env.ADMIN_PASSWORD = 'correct-synthetic-password';
    assert.equal(adminPasswordMatches('correct-synthetic-password'), true);
    for (const supplied of [undefined, null, {}, [], ['correct-synthetic-password'], 'incorrect', 'я'.repeat(100)]) {
      assert.equal(adminPasswordMatches(supplied), false);
    }
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous;
  }
});
