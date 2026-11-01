'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceRetry } = require('../src/bot/egrn-source-retry');

function harness() {
  const state = { now: 1000000, waits: [], timers: [], cleared: [] };
  const runtime = {
    now: () => state.now,
    wait: async (ms, context) => { assert.equal(context.signal.aborted, false); state.waits.push(ms); state.now += ms; },
    setTimer(callback, ms) { const timer = { callback, ms }; state.timers.push(timer); return timer; },
    clearTimer(timer) { state.cleared.push(timer); }
  };
  return { state, runtime, run: createSourceRetry(runtime) };
}
function networkError(code = 'EGRN_SOURCE_RESPONSE') {
  return Object.assign(new Error('https://provider.example?token=SECRET /private/tmp/PRIVATE response payload'),
    { code, source_code: 'UND_ERR_SOCKET', source_name: 'TypeError', source_bytes: 393 * 1024 * 1024,
      response: { password: 'SECRET' }, localPath: '/private/tmp/PRIVATE' });
}
function safe(error) {
  assert.match(error.message, /Не удалось получить оригинал выписки/);
  assert.equal(error.cause, undefined); assert.equal(error.response, undefined); assert.equal(error.localPath, undefined);
  assert.doesNotMatch(JSON.stringify(error), /https?:|SECRET|PRIVATE|token=|password|localPath|\/private\/|payload/);
  return true;
}

test('three read attempts reuse their callback only for recoverable failures and return the ready bundle unchanged', async () => {
  const h = harness(), retries = [], contexts = [], ready = { item: { status: 'ready' }, cleanup() { assert.fail('Successful result remains owned by the caller'); } };
  const result = await h.run(async (index, context) => {
    contexts.push(context); assert.equal(index, contexts.length);
    if (index < 3) throw networkError();
    return ready;
  }, { onRetry: info => retries.push(info) });
  assert.equal(result, ready); assert.deepEqual(h.state.waits, [1000, 1000]); assert.equal(retries.length, 2);
  assert.deepEqual(retries.map(info => [info.attempt, info.nextAttempt]), [[1, 2], [2, 3]]);
  for (const info of retries) {
    assert.equal(info.code, 'EGRN_SOURCE_RESPONSE'); assert.equal(info.source_code, 'UND_ERR_SOCKET');
    assert.equal(info.source_name, 'TypeError'); assert.equal(info.source_bytes, 393 * 1024 * 1024);
    assert.doesNotMatch(JSON.stringify(info), /https?:|SECRET|PRIVATE|payload|localPath/);
  }
  assert.equal(contexts[0].signal, contexts[2].signal); assert.equal(contexts[0].remainingMs, 20 * 60 * 1000);
  assert.equal(contexts[2].remainingMs, 20 * 60 * 1000 - 2000); assert.equal(contexts[2].signal.aborted, false);
  assert.deepEqual(h.state.cleared, h.state.timers);
});

test('known fetch and undici transport failures retry without exposing their raw error object', async () => {
  const errors = [
    new TypeError('fetch failed'), new TypeError('terminated'),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('SECRET'), { code: 'UND_ERR_SOCKET' }) }),
    ...['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH']
      .map(code => Object.assign(new Error('SECRET'), { code }))
  ];
  for (const error of errors) {
    const h = harness(); let calls = 0;
    assert.equal(await h.run(async () => { if (++calls === 1) throw error; return 'ready'; }, { delay: 0 }), 'ready');
    assert.equal(calls, 2); assert.deepEqual(h.state.waits, [0]);
  }
});

test('permanent file, metadata, request and explicit cancellation errors never retry', async () => {
  const errors = [
    ...['EGRN_SOURCE_METADATA', 'EGRN_SOURCE_REQUEST', 'EGRN_SOURCE_BASE64', 'EGRN_FILE_TYPE', 'EGRN_FILE_TOO_LARGE',
      'EGRN_SOURCE_SPACE', 'EGRN_SOURCE_WRITE', 'EGRN_SOURCE_ABORTED'].map(code => Object.assign(new Error('SECRET'), { code })),
    Object.assign(new Error('SECRET'), { name: 'AbortError', cause: { code: 'UND_ERR_SOCKET' } }),
    Object.assign(new Error('SECRET'), { code: 'EGRN_SOURCE_RESPONSE', source_code: 'EGRN_SOURCE_BASE64' }),
    new TypeError('Cannot read properties of undefined'), Object.assign(new TypeError('fetch failed'), { code: 'ERR_INVALID_URL' }),
    Object.assign(new Error('SECRET'), { code: 'UND_ERR_INVALID_ARG' })
  ];
  for (const error of errors) {
    const h = harness(); let calls = 0, logged = 0;
    await assert.rejects(h.run(async () => { calls++; throw error; }, { onRetry() { logged++; } }), result => {
      safe(result); assert.equal(result.attempts, 1); assert.equal(result.temporary, false); return true;
    });
    assert.equal(calls, 1); assert.equal(logged, 0); assert.deepEqual(h.state.waits, []);
  }
});

test('exhausted attempts retain only safe source diagnostics and stop after the configured read count', async () => {
  for (const maxAttempts of [1, 2, 3]) {
    const h = harness(); let calls = 0;
    await assert.rejects(h.run(async () => { calls++; throw networkError(); }, { maxAttempts }), error => {
      safe(error); assert.equal(error.code, 'EGRN_SOURCE_RESPONSE'); assert.equal(error.source_code, 'UND_ERR_SOCKET');
      assert.equal(error.source_name, 'TypeError'); assert.equal(error.source_bytes, 393 * 1024 * 1024);
      assert.equal(error.attempts, maxAttempts); assert.equal(error.temporary, true); return true;
    });
    assert.equal(calls, maxAttempts); assert.equal(h.state.waits.length, maxAttempts - 1);
  }
});

test('one total deadline bounds delays and does not start another long read after the budget expires', async () => {
  const h = harness(); let calls = 0;
  await assert.rejects(h.run(async () => { calls++; h.state.now += 30; throw networkError(); },
    { deadline: h.state.now + 50, delay: 1000 }), error => {
    safe(error); assert.equal(error.code, 'EGRN_SOURCE_DEADLINE'); assert.equal(error.source_code, 'UND_ERR_SOCKET');
    assert.equal(error.attempts, 1); assert.equal(error.temporary, true); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(h.state.waits, [20]); assert.equal(h.state.timers[0].ms, 50);
  assert.deepEqual(h.state.cleared, h.state.timers);
});

test('the global timer aborts an in-flight read and cleans a late bundle without another attempt', async () => {
  const h = harness(); let finish, started, signal, calls = 0, cleanups = 0;
  const begun = new Promise(resolve => { started = resolve; });
  const pending = h.run(async (index, context) => {
    calls++; signal = context.signal; started(); return new Promise(resolve => { finish = resolve; });
  });
  await begun; h.state.now += 20 * 60 * 1000; h.state.timers[0].callback();
  await assert.rejects(pending, error => { safe(error); assert.equal(error.code, 'EGRN_SOURCE_DEADLINE'); assert.equal(error.attempts, 1); return true; });
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.deepEqual(h.state.waits, []);
  finish({ async cleanup() { cleanups++; } }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(cleanups, 1); assert.deepEqual(h.state.cleared, h.state.timers);
});

test('late success at the clock deadline is cleaned instead of handed to the caller', async () => {
  const h = harness(); let cleanups = 0;
  await assert.rejects(h.run(async () => {
    h.state.now += 20 * 60 * 1000; return { cleanup() { cleanups++; } };
  }), error => { safe(error); assert.equal(error.code, 'EGRN_SOURCE_DEADLINE'); return true; });
  assert.equal(cleanups, 1);
});

test('a caller deadline cannot extend the shared budget beyond twenty minutes and an expired deadline does no work', async () => {
  const h = harness();
  await h.run(async (index, context) => { assert.equal(context.remainingMs, 20 * 60 * 1000); return 'ready'; },
    { deadline: h.state.now + 60 * 60 * 1000 });
  assert.equal(h.state.timers[0].ms, 20 * 60 * 1000);
  const expired = harness(); let calls = 0;
  await assert.rejects(expired.run(async () => { calls++; }, { deadline: expired.state.now }), error => {
    safe(error); assert.equal(error.code, 'EGRN_SOURCE_DEADLINE'); assert.equal(error.attempts, 0); return true;
  });
  assert.equal(calls, 0); assert.equal(expired.state.timers.length, 0);
});

test('retry logging cannot break delivery and unsafe diagnostics are omitted', async () => {
  for (const asyncLogger of [false, true]) {
    const h = harness(); let calls = 0, info;
    const log = value => { info = value; if (asyncLogger) return Promise.reject(new Error('SECRET')); throw new Error('SECRET'); };
    assert.equal(await h.run(async () => {
      if (++calls === 1) throw Object.assign(new Error('SECRET https://private.example'),
        { code: 'EGRN_SOURCE_RESPONSE', source_code: '?token=PRIVATE', source_name: '/private/tmp/SECRET', source_bytes: Number.MAX_SAFE_INTEGER + 1 });
      return 'ready';
    }, { onRetry: log }), 'ready');
    assert.equal(info.source_code, 'EGRN_SOURCE_RESPONSE'); assert.equal(info.source_name, 'Error'); assert.equal(info.source_bytes, undefined);
    assert.doesNotMatch(JSON.stringify(info), /https?:|SECRET|PRIVATE|token=|\/private\//);
  }
});

test('a failed injected wait is sanitized and does not execute another read', async () => {
  const h = harness(); h.runtime.wait = async () => { throw Object.assign(new Error('SECRET /private/tmp/PRIVATE'), { code: 'ECONNRESET' }); };
  const run = createSourceRetry(h.runtime); let calls = 0;
  await assert.rejects(run(async () => { calls++; throw networkError(); }), error => { safe(error); assert.equal(error.code, 'ECONNRESET'); return true; });
  assert.equal(calls, 1); assert.deepEqual(h.state.cleared, h.state.timers);
});

test('invalid retry settings cannot create an unbounded number of reads or waits', async () => {
  for (const options of [{ maxAttempts: 0 }, { maxAttempts: 4 }, { maxAttempts: 1.5 }, { delay: -1 }, { delay: 60001 }, { deadline: NaN }]) {
    const h = harness(); let calls = 0;
    await assert.rejects(h.run(async () => { calls++; }, options), TypeError);
    assert.equal(calls, 0); assert.equal(h.state.timers.length, 0);
  }
});
