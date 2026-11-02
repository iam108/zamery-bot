import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './state.mjs';
import { createNotifier } from './notifier.mjs';

const owner = '123456789';
const jobA = 'a'.repeat(24);
const jobB = 'b'.repeat(24);
const write = { type: 'write_verified', jobId: jobA, organization: 'ООО «Хорошот»',
  action: 'update', cells: ['H868', 'P868', 'G868', 'I868', 'J868'] };

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'license-notifier-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createStore(path.join(dir, 'state.json'));
  const calls = [];
  const logs = [];
  let time = new Date('2026-11-02T06:00:00Z');
  const telegram = { async call(method, params) {
    calls.push({ method, params });
    if (options.call) return options.call(method, params, calls);
    if (method === 'getChat') return { id: Number(owner), type: 'private' };
    if (method === 'sendMessage') return { message_id: calls.length, chat: { id: Number(owner), type: 'private' } };
    throw new Error('Unexpected mock method');
  } };
  const config = { telegram, store, ownerChatId: owner, now: () => new Date(time), log: (item) => logs.push(item) };
  return { store, calls, logs, telegram, config, report: createNotifier(config),
    advance(ms) { time = new Date(+time + ms); } };
}
async function records(store) { return Object.values((await store.read()).runtime?.notifications ?? {}); }

test('without owner it honestly logs only safe identifiers and makes no Telegram calls', async (t) => {
  const f = await fixture(t);
  const report = createNotifier({ ...f.config, ownerChatId: undefined });
  assert.equal((await report.verifyOwner()).delivery, 'log_only');
  assert.equal((await report({ ...write, sourceText: 'private source', email: 'person@example.com' })).delivery, 'log_only');
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].delivery, 'log_only');
  assert.equal(f.logs[0].jobId, jobA);
  assert.ok(!JSON.stringify(f.logs).includes('Хорошот'));
  assert.ok(!JSON.stringify(f.logs).includes('person@example.com'));
  assert.ok(!JSON.stringify(f.logs).includes('private source'));
  assert.equal((await records(f.store))[0].status, 'logged');
});

test('group, zero, username and unsafe owner IDs are rejected before any request', async (t) => {
  const f = await fixture(t);
  for (const ownerChatId of ['-1005164597211', '0', '@owner', '999999999999999999999']) {
    assert.throws(() => createNotifier({ ...f.config, ownerChatId }), { code: 'notification_owner_invalid' });
  }
  assert.equal(f.calls.length, 0);
});

test('owner must be verified as the exact private chat', async (t) => {
  for (const chat of [{ id: Number(owner), type: 'supergroup' }, { id: 999, type: 'private' }]) {
    const f = await fixture(t, { call: async () => chat });
    await assert.rejects(f.report.verifyOwner(), { code: 'notification_owner_not_private' });
    assert.deepEqual(f.calls.map((c) => c.method), ['getChat']);
  }
});

test('verified write sends Russian confirmation only to owner with field names and no values or contacts', async (t) => {
  const f = await fixture(t);
  const result = await f.report({ ...write, email: 'person@example.com', providerResponse: { key: 'secret' } });
  assert.equal(result.delivery, 'sent');
  assert.deepEqual(f.calls.map((c) => c.method), ['getChat', 'sendMessage']);
  const params = f.calls[1].params;
  assert.equal(params.chat_id, owner);
  assert.match(params.text, /ООО «Хорошот»/u);
  assert.match(params.text, /номер лицензии/u);
  assert.match(params.text, /дата окончания/u);
  assert.match(params.text, /обратным чтением Google/u);
  assert.ok(!params.text.includes('person@example.com'));
  assert.ok(!params.text.includes('secret'));
  assert.equal(params.parse_mode, undefined);
  assert.equal((await records(f.store))[0].status, 'sent');
});

test('noop and unrelated periodic statuses never notify', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.report({ ...write, action: 'noop' })).delivery, 'ignored');
  assert.equal((await f.report({ type: 'daily_no_changes' })).delivery, 'ignored');
  assert.equal(f.calls.length, 0);
  assert.equal((await records(f.store)).length, 0);
  assert.equal((await f.report({ type: 'runtime_initialized', raw: 'not logged' })).delivery, 'log_only');
  assert.equal(f.calls.length, 0);
});

test('durable deduplication survives new notifier instance and does not hourly-repeat unchanged errors', async (t) => {
  const f = await fixture(t);
  const event = { type: 'api_blocked', code: 'access_ip_blocked' };
  assert.equal((await f.report(event)).delivery, 'sent');
  f.advance(3_600_000);
  const restarted = createNotifier(f.config);
  assert.equal((await restarted(event)).delivery, 'duplicate');
  assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 1);
  assert.match(f.calls.find((c) => c.method === 'sendMessage').params.text, /IP сервера/u);
});

test('new jobs with the same review reason remain separate actionable notifications', async (t) => {
  const f = await fixture(t);
  await f.report({ type: 'review_required', code: 'organization_not_identified', jobId: jobA });
  await f.report({ type: 'review_required', code: 'organization_not_identified', jobId: jobB });
  assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 2);
  assert.equal((await records(f.store)).length, 2);
});

test('failed send stays pending and is retried after restart even when completed job is never reported again', async (t) => {
  let failed = false;
  const f = await fixture(t, { call: async (method) => {
    if (method === 'getChat') return { id: Number(owner), type: 'private' };
    if (!failed) { failed = true; throw Object.assign(new Error('provider raw URL and token'), { code: 'network_error' }); }
    return { message_id: 77, chat: { id: Number(owner), type: 'private' } };
  } });
  assert.equal((await f.report(write)).delivery, 'pending');
  let item = (await records(f.store))[0];
  assert.equal(item.status, 'pending');
  assert.equal(item.sentAt, undefined);
  assert.equal(item.lastError, 'notification_delivery_failed');
  assert.equal((await f.report.flush()).pending, 1);
  assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 1);
  f.advance(60_000);
  const restarted = createNotifier(f.config);
  assert.equal((await restarted.flush()).sent, 1);
  item = (await records(f.store))[0];
  assert.equal(item.status, 'sent');
  assert.equal(item.attempts, 2);
  assert.ok(item.sentAt);
  assert.ok(!JSON.stringify(f.logs).includes('provider raw'));
});

test('Telegram retry_after is honored without marking notification delivered', async (t) => {
  const f = await fixture(t, { call: async (method) => {
    if (method === 'getChat') return { id: Number(owner), type: 'private' };
    throw Object.assign(new Error('rate limited'), { code: 'rate_limited', retryAfter: 120 });
  } });
  await f.report(write);
  assert.equal((await records(f.store))[0].nextAttemptAt, '2026-11-02T06:02:00.000Z');
  f.advance(60_000);
  await f.report.flush();
  assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 1);
});

test('owner verification failure never sends to a group and retains pending delivery', async (t) => {
  const f = await fixture(t, { call: async () => ({ id: Number(owner), type: 'supergroup' }) });
  assert.equal((await f.report(write)).delivery, 'pending');
  assert.deepEqual(f.calls.map((c) => c.method), ['getChat']);
  assert.equal((await records(f.store))[0].lastError, 'notification_owner_not_private');
});

test('successful API envelope with wrong destination cannot be recorded as sent', async (t) => {
  const f = await fixture(t, { call: async (method) => method === 'getChat'
    ? { id: Number(owner), type: 'private' }
    : { message_id: 10, chat: { id: -10012345, type: 'supergroup' } } });
  assert.equal((await f.report(write)).delivery, 'pending');
  assert.equal((await records(f.store))[0].status, 'pending');
});

test('concurrent duplicate reports perform at most one send in this single worker', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.report(write), f.report(write), f.report(write)]);
  assert.equal(f.calls.filter((c) => c.method === 'sendMessage').length, 1);
  assert.equal((await records(f.store)).length, 1);
});

test('raw provider codes, credentials in organization and arbitrary fields never leave through logs or messages', async (t) => {
  const f = await fixture(t);
  const secret = 'k'.repeat(40);
  await f.report({ type: 'processing_error', code: secret, jobId: secret,
    organization: `ООО ${secret}`, providerResponse: `https://provider/?key=${secret}`, contact: 'person@example.com' });
  const serialized = JSON.stringify(f.logs) + f.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text).join('');
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('person@example.com'));
  assert.ok(!serialized.includes('provider'));
  assert.ok(serialized.includes('unknown_error'));
});
