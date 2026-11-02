const API_ORIGIN = 'https://api.telegram.org';
const ALLOWED_UPDATES = Object.freeze(['message', 'edited_message', 'my_chat_member']);
const MAX_RESPONSE_BYTES = 8_000_000;

function chatId(value) {
  const id = String(value ?? '');
  if (!/^-[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new TelegramError('target_chat_id_required', 'An explicit signed Telegram group ID is required');
  }
  return id;
}
function clean(value) { return String(value ?? '').replace(/\s+/gu, ' ').trim(); }
function safeDescription(value, token) {
  return String(value ?? '').split(token).join('[REDACTED]')
    .replace(/https?:\/\/[^\s"<>]*api\.telegram\.org[^\s"<>]*/giu, '[Telegram API]')
    .replace(/\b\d+:[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 300);
}
async function boundedBody(response) {
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new TelegramError('response_too_large', 'Telegram API response exceeds the read limit');
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new TelegramError('response_too_large', 'Telegram API response exceeds the read limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length).toString('utf8');
}

export class TelegramError extends Error {
  constructor(code, message, { httpStatus = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfter = retryAfter;
  }
}

export class TelegramClient {
  #token;
  #fetch;
  #timeoutMs;
  #pollingChecked = false;

  constructor({ token, fetchImpl = fetch, timeoutMs = 40_000 } = {}) {
    if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) {
      throw new TelegramError('bot_token_required', 'A valid Telegram bot token is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async call(method, params = {}, { signal, timeoutMs = this.#timeoutMs } = {}) {
    if (typeof method !== 'string' || !/^[a-z][A-Za-z0-9]*$/u.test(method)) {
      throw new TelegramError('invalid_method', 'Invalid Telegram API method');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    let response;
    let payload;
    try {
      response = await this.#fetch(`${API_ORIGIN}/bot${this.#token}/${method}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await boundedBody(response);
      try { payload = JSON.parse(body); }
      catch { throw new TelegramError('invalid_response', 'Telegram API returned an invalid response', { httpStatus: response.status }); }
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      if (controller.signal.aborted) {
        throw new TelegramError(signal?.aborted ? 'cancelled' : 'timeout',
          signal?.aborted ? 'Telegram request was cancelled' : 'Telegram request timed out');
      }
      // Fetch errors can include the token-bearing request URL; never expose them.
      throw new TelegramError('network_error', 'Telegram API connection failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (!response.ok || payload?.ok !== true || !Object.hasOwn(payload, 'result')) {
      const status = Number.isInteger(payload?.error_code) ? payload.error_code : response.status;
      const code = status === 401 ? 'authentication_failed' : status === 403 ? 'access_denied'
        : status === 409 ? 'polling_conflict' : status === 429 ? 'rate_limited' : 'api_error';
      const detail = safeDescription(payload?.description, this.#token);
      throw new TelegramError(code, detail ? `Telegram API rejected ${method}: ${detail}` : `Telegram API rejected ${method}`, {
        httpStatus: status,
        retryAfter: Number.isFinite(payload?.parameters?.retry_after) ? payload.parameters.retry_after : null,
      });
    }
    return payload.result;
  }

  async #checkPolling({ signal } = {}) {
    if (this.#pollingChecked) return;
    const webhook = await this.call('getWebhookInfo', {}, { signal });
    if (!webhook || typeof webhook.url !== 'string') {
      throw new TelegramError('invalid_webhook_response', 'Telegram webhook state could not be verified');
    }
    if (webhook.url) {
      throw new TelegramError('existing_webhook', 'This bot already has a webhook; polling was not started');
    }
    this.#pollingChecked = true;
  }

  async verifyTarget({ targetChatId, chatTitle = 'Лицензии на алкоголь' } = {}) {
    const target = chatId(targetChatId);
    await this.#checkPolling();
    const bot = await this.call('getMe');
    if (!bot?.is_bot || !Number.isSafeInteger(bot.id) || bot.id < 1) {
      throw new TelegramError('invalid_bot_identity', 'Telegram bot identity could not be verified');
    }
    const chat = await this.call('getChat', { chat_id: target });
    if (String(chat?.id) !== target || !['group', 'supergroup'].includes(chat?.type)) {
      throw new TelegramError('target_chat_mismatch', 'Telegram returned a different chat or a non-group chat');
    }
    if (chat.title !== chatTitle) {
      throw new TelegramError('target_title_mismatch', 'The configured Telegram group title does not match');
    }
    const membership = await this.call('getChatMember', { chat_id: target, user_id: bot.id });
    if (String(membership?.user?.id) !== String(bot.id)) {
      throw new TelegramError('membership_identity_mismatch', 'Telegram bot membership could not be verified');
    }
    const member = ['creator', 'administrator', 'member'].includes(membership.status)
      || (membership.status === 'restricted' && membership.is_member === true);
    if (!member) throw new TelegramError('bot_not_a_member', 'The bot is not a member of the target Telegram group');
    const administrator = ['creator', 'administrator'].includes(membership.status);
    if (!administrator && bot.can_read_all_group_messages !== true) {
      throw new TelegramError('group_messages_not_available', 'The bot cannot receive ordinary group messages; check its group privacy setting or administrator membership');
    }
    return {
      id: target, title: chat.title, type: chat.type, botId: String(bot.id),
      username: typeof bot.username === 'string' ? bot.username : null,
      membership: membership.status, canReadGroupMessages: true,
    };
  }

  async getUpdates({ offset, signal } = {}) {
    if (offset != null && (!Number.isSafeInteger(offset) || offset < 0)) {
      throw new TelegramError('invalid_offset', 'Telegram offset must be a non-negative safe integer');
    }
    await this.#checkPolling({ signal });
    const params = { timeout: 30, limit: 100, allowed_updates: [...ALLOWED_UPDATES] };
    if (offset != null) params.offset = offset;
    const updates = await this.call('getUpdates', params, { signal });
    if (!Array.isArray(updates) || updates.some((u) => !u || !Number.isSafeInteger(u.update_id) || u.update_id < 0)) {
      throw new TelegramError('invalid_updates', 'Telegram returned an invalid updates batch');
    }
    return updates;
  }
}

function unixDate(value, field) {
  if (!Number.isSafeInteger(value) || value < 1 || !Number.isFinite(+new Date(value * 1000))) {
    throw new TelegramError('invalid_update_date', `Target Telegram message has an invalid ${field}`);
  }
  return new Date(value * 1000).toISOString();
}

export function convertUpdate(update, { targetChatId, sourceChatId = '5164597211', botId } = {}) {
  const target = chatId(targetChatId);
  const message = update?.message ?? update?.edited_message;
  if (!message || String(message.chat?.id) !== target) return null;
  if (!['group', 'supergroup'].includes(message.chat.type)) return null;
  const source = String(sourceChatId);
  if (!/^[1-9]\d*$/u.test(source)) throw new TelegramError('invalid_source_chat_id', 'A canonical export source group ID is required');
  if (!Number.isSafeInteger(message.message_id) || message.message_id < 1
    || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    throw new TelegramError('invalid_message_identity', 'Target Telegram message has an invalid identity');
  }
  const text = typeof message.text === 'string' ? message.text
    : typeof message.caption === 'string' ? message.caption : '';
  // A cleared photo/video caption is still a source correction. Persist the
  // edit so the worker can stop an existing job before any Google write.
  if (!text && !message.document && !update.edited_message) return null;
  const bot = botId == null ? null : String(botId);
  if ((message.chat.type === 'group' || bot != null)
      && (!/^[1-9]\d*$/u.test(bot ?? '') || !Number.isSafeInteger(Number(bot)))) {
    throw new TelegramError('source_bot_id_required', 'A verified receiving bot ID is required for basic-group messages');
  }
  const originalDate = unixDate(message.date, 'original date');
  const editDate = message.edit_date == null ? null : unixDate(message.edit_date, 'edit date');
  const sender = message.sender_chat ?? message.from;
  const author = message.sender_chat ? clean(message.sender_chat.title) || null
    : clean([message.from?.first_name, message.from?.last_name].filter(Boolean).join(' '))
      || (message.from?.username ? `@${message.from.username}` : null);
  const sourceUrl = message.chat.type === 'supergroup' && /^-100[1-9]\d*$/u.test(target)
    ? `https://t.me/c/${target.slice(4)}/${message.message_id}` : null;
  const documentId = typeof message.document?.file_unique_id === 'string' ? message.document.file_unique_id : null;
  return {
    id: message.message_id, message_id: message.message_id,
    chat_id: source, chatId: source, telegram_chat_id: target, telegram_chat_type: message.chat.type,
    ...(bot == null ? {} : { source_bot_id: bot }),
    update_id: update.update_id, source_update_id: update.update_id,
    date: originalDate, originalDate, editDate, edited: Boolean(update.edited_message), text,
    author, authorId: sender?.id == null ? null : String(sender.id),
    authorUsername: typeof message.from?.username === 'string' ? message.from.username : null,
    authorIsBot: message.from?.is_bot === true,
    documentId,
    ...(documentId ? { document: { file_unique_id: documentId } } : {}),
    source_kind: 'telegram_bot_api', source_message_id: message.message_id,
    source_url: sourceUrl, sourceUrl, url: sourceUrl,
  };
}
