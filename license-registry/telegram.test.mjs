import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClient, TelegramError, convertUpdate } from './telegram.mjs';
import { sourceEventKey } from './core.mjs';

const token = `1234567890:${'a'.repeat(40)}`;
const targetChatId = '-1005164597211';
const chatTitle = 'Лицензии на алкоголь';
const bot = { id: 1234567890, is_bot: true, username: 'LicenseRegistryBot', can_read_all_group_messages: true };
function fakeApi(overrides = {}) {
  const calls = [];
  const defaults = {
    getWebhookInfo: { url: '' },
    getMe: bot,
    getChat: { id: Number(targetChatId), title: chatTitle, type: 'supergroup' },
    getChatMember: { user: bot, status: 'member' },
    getUpdates: [],
  };
  const fetchImpl = async (url, options) => {
    const method = String(url).split('/').at(-1);
    const params = JSON.parse(options.body);
    calls.push({ method, params, options });
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(String(url), `https://api.telegram.org/bot${token}/${method}`);
    const result = Object.hasOwn(overrides, method) ? overrides[method] : defaults[method];
    if (typeof result === 'function') return result(params, options);
    if (result === undefined) throw new Error(`Unexpected mock method ${method}`);
    return Response.json({ ok: true, result });
  };
  return { client: new TelegramClient({ token, fetchImpl }), calls };
}

test('verifies exact target, bot membership and ordinary message access', async () => {
  const { client, calls } = fakeApi();
  const result = await client.verifyTarget({ targetChatId });
  assert.deepEqual(result, {
    id: targetChatId, title: chatTitle, type: 'supergroup', botId: String(bot.id),
    username: bot.username, membership: 'member', canReadGroupMessages: true,
  });
  assert.deepEqual(calls.map((c) => c.method), ['getWebhookInfo', 'getMe', 'getChat', 'getChatMember']);
  assert.deepEqual(calls[3].params, { chat_id: targetChatId, user_id: bot.id });
  assert.ok(!JSON.stringify(client).includes(token));
});

test('administrator membership permits privacy-enabled bot to receive group messages', async () => {
  const { client } = fakeApi({ getMe: { ...bot, can_read_all_group_messages: undefined },
    getChatMember: { user: bot, status: 'administrator' } });
  assert.equal((await client.verifyTarget({ targetChatId })).canReadGroupMessages, true);
});

test('privacy-enabled ordinary member is refused instead of silently missing messages', async () => {
  const { client } = fakeApi({ getMe: { ...bot, can_read_all_group_messages: false } });
  await assert.rejects(client.verifyTarget({ targetChatId }), { code: 'group_messages_not_available' });
});

test('a left bot, another returned chat, wrong title and another membership identity are refused', async () => {
  for (const [override, code] of [
    [{ getChatMember: { user: bot, status: 'left' } }, 'bot_not_a_member'],
    [{ getChat: { id: -1009876543210, title: chatTitle, type: 'supergroup' } }, 'target_chat_mismatch'],
    [{ getChat: { id: Number(targetChatId), title: 'Другая группа', type: 'supergroup' } }, 'target_title_mismatch'],
    [{ getChatMember: { user: { id: 987654321 }, status: 'member' } }, 'membership_identity_mismatch'],
  ]) {
    await assert.rejects(fakeApi(override).client.verifyTarget({ targetChatId }), { code });
  }
});

test('explicit signed group ID is required before any network request', async () => {
  for (const value of [undefined, '5164597211', '@group', '-0', '-10099999999999999999999']) {
    const { client, calls } = fakeApi();
    await assert.rejects(client.verifyTarget({ targetChatId: value }), { code: 'target_chat_id_required' });
    assert.equal(calls.length, 0);
  }
});

test('existing webhook stops both verification and polling without deleting it', async () => {
  for (const action of ['verify', 'updates']) {
    const { client, calls } = fakeApi({ getWebhookInfo: { url: 'https://existing.example/secret-webhook' } });
    await assert.rejects(action === 'verify' ? client.verifyTarget({ targetChatId }) : client.getUpdates(),
      (error) => error.code === 'existing_webhook' && !error.message.includes('secret-webhook'));
    assert.deepEqual(calls.map((c) => c.method), ['getWebhookInfo']);
  }
});

test('polling is bounded and preserves updates without acknowledging an offset on its own', async () => {
  const update = { update_id: 27, message: { message_id: 19 } };
  const { client, calls } = fakeApi({ getUpdates: [update] });
  assert.deepEqual(await client.getUpdates({ offset: 0 }), [update]);
  assert.deepEqual(await client.getUpdates({ offset: 28 }), [update]);
  assert.deepEqual(calls.map((c) => c.method), ['getWebhookInfo', 'getUpdates', 'getUpdates']);
  assert.deepEqual(calls[1].params, { offset: 0, timeout: 30, limit: 100,
    allowed_updates: ['message', 'edited_message', 'my_chat_member'] });
  assert.equal(calls[2].params.offset, 28);
  await assert.rejects(client.getUpdates({ offset: -1 }), { code: 'invalid_offset' });
});

test('polling conflict, rate limit and provider descriptions never leak token or API URL', async () => {
  for (const [status, code] of [[409, 'polling_conflict'], [429, 'rate_limited'], [401, 'authentication_failed']]) {
    const { client } = fakeApi({ getUpdates: () => Response.json({ ok: false, error_code: status,
      description: `Failure https://api.telegram.org/bot${token}/getUpdates ${token}`,
      parameters: { retry_after: 12 } }, { status }) });
    await assert.rejects(client.getUpdates(), (error) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.code, code);
      assert.equal(error.retryAfter, 12);
      assert.ok(!error.message.includes(token));
      assert.ok(!error.message.includes('api.telegram.org'));
      return true;
    });
  }
});

test('network and malformed responses are sanitized and invalid updates are rejected', async () => {
  const client = new TelegramClient({ token, fetchImpl: async (url) => { throw new Error(`Network failure for ${url}`); } });
  await assert.rejects(client.call('getMe'), (error) => error.code === 'network_error'
    && !error.message.includes(token) && !error.message.includes('api.telegram.org'));
  await assert.rejects(fakeApi({ getUpdates: () => new Response('<html>bad upstream</html>', { status: 502 }) }).client.getUpdates(),
    { code: 'invalid_response' });
  await assert.rejects(fakeApi({ getUpdates: [{ update_id: -1 }] }).client.getUpdates(), { code: 'invalid_updates' });
});

test('oversized streamed responses are stopped at the read bound', async () => {
  let cancelled = false;
  const client = new TelegramClient({ token, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8_000_001)); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(client.call('getMe'), { code: 'response_too_large' });
  assert.equal(cancelled, true);
});

test('abort is propagated as a safe cancellation and method injection is rejected', async () => {
  const controller = new AbortController();
  const client = new TelegramClient({ token, fetchImpl: async (_url, { signal }) => {
    if (signal.aborted) throw new Error('Aborted');
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } });
  const request = client.call('getMe', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { code: 'cancelled' });
  await assert.rejects(client.call('../sendMessage'), { code: 'invalid_method' });
});

const updateOf = (overrides = {}) => ({ update_id: 100, message: {
  message_id: 62436, date: 1793174039,
  chat: { id: Number(targetChatId), type: 'supergroup', title: chatTitle },
  from: { id: 88, first_name: 'Валера', last_name: 'Рабочий', username: 'valera', is_bot: false },
  caption: 'хорошот положительное', document: { file_unique_id: 'unique-decision', file_id: 'not-needed' },
  ...overrides,
} });

test('normalizes canonical identity for export dedup and keeps exact original Telegram time', () => {
  const converted = convertUpdate(updateOf(), { targetChatId });
  assert.equal(sourceEventKey(converted), 'telegram:5164597211:62436');
  assert.equal(converted.telegram_chat_id, targetChatId);
  assert.equal(converted.telegram_chat_type, 'supergroup');
  assert.equal(converted.date, new Date(1793174039 * 1000).toISOString());
  assert.equal(converted.originalDate, converted.date);
  assert.equal(converted.author, 'Валера Рабочий');
  assert.equal(converted.authorId, '88');
  assert.equal(converted.text, 'хорошот положительное');
  assert.equal(converted.documentId, 'unique-decision');
  assert.deepEqual(converted.document, { file_unique_id: 'unique-decision' });
  assert.equal(converted.source_url, 'https://t.me/c/5164597211/62436');
  assert.equal(converted.source_kind, 'telegram_bot_api');
});

test('edited message retains original decision-reporting time with separate edit metadata', () => {
  const update = updateOf({ text: 'ООО «Хорошот» решение положительное', edit_date: 1793260439 });
  update.edited_message = update.message;
  delete update.message;
  const converted = convertUpdate(update, { targetChatId });
  assert.equal(converted.edited, true);
  assert.equal(converted.date, new Date(1793174039 * 1000).toISOString());
  assert.equal(converted.editDate, new Date(1793260439 * 1000).toISOString());
  assert.equal(converted.text, 'ООО «Хорошот» решение положительное');
});

test('clearing a photo caption retains the edit identity while an ordinary uncaptioned photo is ignored', () => {
  const options = { targetChatId: '-5164597211', sourceChatId: '5164597211', botId: bot.id };
  const original = updateOf({ message_id: 3, chat: { id: -5164597211, type: 'group' },
    document: undefined, photo: [{ file_id: 'photo', file_unique_id: 'photo-unique', width: 20, height: 20 }],
    caption: 'Эксперт положительно' });
  const converted = convertUpdate(original, options);
  const uncaptioned = { ...original.message, caption: undefined };
  assert.equal(convertUpdate({ update_id: 101, message: uncaptioned }, options), null);
  const cleared = convertUpdate({ update_id: 102,
    edited_message: { ...uncaptioned, edit_date: 1793260439 } }, options);
  assert.equal(cleared.text, '');
  assert.equal(cleared.edited, true);
  assert.equal(cleared.editDate, new Date(1793260439 * 1000).toISOString());
  assert.equal(cleared.date, converted.date);
  assert.equal(sourceEventKey(cleared), sourceEventKey(converted));
});

test('ignores other groups, unsupported updates and service-only messages', () => {
  assert.equal(convertUpdate(updateOf({ chat: { id: -1001111111111, type: 'supergroup' } }), { targetChatId }), null);
  assert.equal(convertUpdate({ update_id: 100, my_chat_member: {} }, { targetChatId }), null);
  assert.equal(convertUpdate(updateOf({ text: undefined, caption: undefined, document: undefined }), { targetChatId }), null);
  assert.equal(convertUpdate(updateOf({ chat: { id: Number(targetChatId), type: 'private' } }), { targetChatId }), null);
});

test('malformed target event cannot acquire invented identity or date', () => {
  assert.throws(() => convertUpdate(updateOf({ date: undefined }), { targetChatId }), { code: 'invalid_update_date' });
  assert.throws(() => convertUpdate(updateOf({ message_id: 0 }), { targetChatId }), { code: 'invalid_message_identity' });
  assert.throws(() => convertUpdate(updateOf(), { targetChatId, sourceChatId: '-1005164597211' }), { code: 'invalid_source_chat_id' });
});

test('anonymous sender is attributed to its Telegram sender_chat and basic groups get no invented t.me/c link', () => {
  const converted = convertUpdate(updateOf({ sender_chat: { id: Number(targetChatId), title: chatTitle } }), { targetChatId });
  assert.equal(converted.author, chatTitle);
  assert.equal(converted.authorId, targetChatId);
  const basic = convertUpdate(updateOf({ chat: { id: -12345, type: 'group' } }), { targetChatId: '-12345', sourceChatId: '12345', botId: bot.id });
  assert.equal(basic.source_url, null);
  assert.equal(basic.chat_id, '12345');
  assert.equal(basic.telegram_chat_type, 'group');
  assert.equal(basic.source_bot_id, String(bot.id));
});

test('basic-group messages require verified bot identity and retain it through edits', () => {
  const options = { targetChatId: '-5164597211', sourceChatId: '5164597211', botId: bot.id };
  const update = updateOf({ message_id: 2, chat: { id: -5164597211, type: 'group' } });
  const original = convertUpdate(update, options);
  assert.equal(sourceEventKey(original), `telegram-bot:${bot.id}:group:5164597211:2`);
  assert.notEqual(sourceEventKey(original), sourceEventKey({ chatId: '5164597211', id: 2 }));
  const edited = { update_id: update.update_id + 1, edited_message: { ...update.message, edit_date: 1793260439 } };
  assert.equal(sourceEventKey(convertUpdate(edited, options)), sourceEventKey(original));
  assert.equal(convertUpdate(edited, options).source_bot_id, String(bot.id));
  assert.notEqual(sourceEventKey(convertUpdate(update, { ...options, botId: 987654321 })), sourceEventKey(original));
  for (const botId of [undefined, '', 0, -1, '123:token', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => convertUpdate(update, { ...options, botId }), { code: 'source_bot_id_required' });
  }
});
