'use strict';

const BUDGET_MS = 20 * 60 * 1000;
const IDENTIFIER = /^[a-zA-Z0-9_]{1,80}$/;
const MESSAGE = 'Не удалось получить оригинал выписки. Повторим попытку.';
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_DESTROYED']);
const FETCH_MESSAGES = new Set(['fetch failed', 'terminated', 'Network request failed', 'Load failed', 'Failed to fetch']);
const SAFE_ERRORS = new WeakSet();

function field(value, key) {
  try { return value && value[key]; } catch (_) { return undefined; }
}
function identifier(value) { return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined; }
function diagnostics(error) {
  const cause = field(error, 'cause'), result = { code: identifier(field(error, 'code')) || 'EGRN_SOURCE_RESPONSE' };
  const code = identifier(field(error, 'source_code')) || identifier(field(cause, 'code')) || identifier(field(error, 'code'));
  const name = identifier(field(error, 'source_name')) || identifier(field(cause, 'name')) || identifier(field(error, 'name'));
  const bytes = field(error, 'source_bytes') ?? field(error, 'bytes');
  if (code) result.source_code = code;
  if (name) result.source_name = name;
  if (typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0) result.source_bytes = bytes;
  return result;
}
function recoverable(error) {
  const cause = field(error, 'cause');
  const codes = [field(error, 'code'), field(error, 'source_code'), field(cause, 'code')];
  const names = [field(error, 'name'), field(error, 'source_name'), field(cause, 'name')];
  if (names.includes('AbortError') || codes.some(code => typeof code === 'string' && /^EGRN_/.test(code) && code !== 'EGRN_SOURCE_RESPONSE')) return false;
  if (codes.includes('EGRN_SOURCE_RESPONSE') || codes.some(code => NETWORK_CODES.has(code))) return true;
  return field(error, 'name') === 'TypeError' && !codes.some(code => code != null) && FETCH_MESSAGES.has(field(error, 'message'));
}
function safeError(cause, attempts, deadline = false) {
  const error = Object.assign(new Error(MESSAGE), diagnostics(cause), { attempts, temporary: deadline || recoverable(cause) });
  if (deadline) error.code = 'EGRN_SOURCE_DEADLINE';
  SAFE_ERRORS.add(error);
  return error;
}
function wait(ms, { signal }) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  });
}
async function cleanup(value) {
  try { if (typeof value?.cleanup === 'function') await value.cleanup(); } catch (_) {}
}

function createSourceRetry(runtime = {}) {
  const now = runtime.now || Date.now, sleep = runtime.wait || wait;
  const setTimer = runtime.setTimer || setTimeout, clearTimer = runtime.clearTimer || clearTimeout;
  // The caller supplies only GET/read of an existing order. Creating a paid
  // order or performing any other write must stay outside this retry boundary.
  return async function readWithRetry(attempt, options = {}) {
    if (typeof attempt !== 'function') throw new TypeError('A read-only source attempt is required.');
    const maxAttempts = options.maxAttempts ?? 3, delay = options.delay ?? 1000, started = now();
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
        !Number.isSafeInteger(delay) || delay < 0 || delay > 60000 || !Number.isSafeInteger(started) ||
        options.deadline != null && !Number.isSafeInteger(options.deadline)) throw new TypeError('Invalid source retry options.');
    const deadline = Math.min(options.deadline ?? started + BUDGET_MS, started + BUDGET_MS);
    let attempts = 0, lastFailure, expired = false, timer;
    const controller = new AbortController();
    let rejectDeadline;
    const expiration = new Promise((_, reject) => { rejectDeadline = reject; });
    expiration.catch(() => {});
    function expire() {
      if (expired) return;
      expired = true;
      const error = safeError(lastFailure, attempts, true);
      controller.abort(error); rejectDeadline(error);
    }
    function remaining() { return Math.max(0, deadline - now()); }
    try {
      if (!remaining()) { expire(); throw safeError(lastFailure, attempts, true); }
      timer = setTimer(expire, remaining());
      while (attempts < maxAttempts) {
        if (!remaining() || expired) { expire(); throw safeError(lastFailure, attempts, true); }
        attempts++;
        try {
          let disposed = false;
          const dispose = value => { if (!disposed) { disposed = true; return cleanup(value); } };
          const pending = Promise.resolve().then(() => attempt(attempts, { signal: controller.signal, remainingMs: remaining(), deadline }));
          // A callback ignoring AbortSignal may finish late. Its private files
          // still need cleanup; failed parses clean themselves in the reader.
          pending.then(value => { if (expired) void dispose(value); }, () => {});
          const value = await Promise.race([pending, expiration]);
          if (!remaining() || expired) { await dispose(value); expire(); throw safeError(lastFailure, attempts, true); }
          return value;
        } catch (error) {
          if (expired || !remaining()) { expire(); throw safeError(lastFailure || error, attempts, true); }
          lastFailure = error;
          if (!recoverable(error) || attempts >= maxAttempts) throw safeError(error, attempts);
          const info = { ...diagnostics(error), attempt: attempts, nextAttempt: attempts + 1, maxAttempts, remainingMs: remaining() };
          try { if (typeof options.onRetry === 'function') Promise.resolve(options.onRetry(info)).catch(() => {}); } catch (_) {}
          await Promise.race([sleep(Math.min(delay, remaining()), { signal: controller.signal }), expiration]);
        }
      }
      throw safeError(lastFailure, attempts);
    } catch (error) {
      if (SAFE_ERRORS.has(error)) throw error;
      throw safeError(error, attempts, expired || field(error, 'code') === 'EGRN_SOURCE_DEADLINE');
    } finally { if (timer !== undefined) clearTimer(timer); }
  };
}

module.exports = { createSourceRetry, readWithRetry: createSourceRetry() };
