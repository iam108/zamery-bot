const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CAD = '77:01:0004016:1064';
function native(key, id = 5) { return { key, chat: -1001001, id, name: 'statement.pdf' }; }
function link(key = 'large') { return { kind: 'link', key, original_id: '11111111-1111-4111-8111-111111111111', name: 'large.pdf', bytes: 100 * 1024 * 1024 }; }
function harness({ files = [native('small')], fail, receipt, sender = true } = {}) {
  const calls = [], queries = [], events = [], errors = [];
  let apiCalls = 0, sequence = 50;
  const order = { id: 1, cad_num: CAD, files_sent: files.length, file_msgs: files, status: 'done' };
  const transport = async (kind, file, target) => {
    const call = { kind, file, target };
    calls.push(call); events.push('send:' + kind);
    const failure = fail?.(call, calls.length);
    if (failure) throw failure;
    return receipt ? receipt(call) : { message_id: ++sequence };
  };
  const telegram = { callApi(method, value) {
    assert.equal(method, 'copyMessage');
    return transport('native', { chat: value.from_chat_id, id: value.message_id }, { chat: value.chat_id, reply: value.reply_parameters?.message_id });
  } };
  const context = {
    module: { exports: {} }, Buffer,
    process: { env: {} }, console: { error(...args) { errors.push(args); } },
    fetch() { apiCalls++; throw new Error('Paid API and external requests are forbidden in this test.'); },
    require(name) {
      if (name === '../db/pool') return { async query(sql, params) {
        queries.push({ sql, params });
        if (sql.startsWith('SELECT * FROM egrn_orders WHERE cad_num=')) return { rows: [order] };
        return { rows: [] };
      } };
      if (name === './formatter') return { esc: String };
      if (name === './egrn-large-delivery') return { createLargeDelivery() { return { copy(record, target) { return transport('link', record, target); } }; } };
      throw new Error('Unexpected require ' + name);
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/bot/egrn.js'), 'utf8') + '\nmodule.exports.qa={copyFiles,setSender(value){tgApi=value}};', context);
  context.module.exports.qa.setSender(sender ? telegram : null);
  return { calls, queries, events, errors, order, qa: context.module.exports.qa,
    attach: opts => context.module.exports.attachOrOrder({ cad: CAD, order: true, targets: [{ chat: 20, reply: 9 }], ...opts }),
    noPaidOrder() { assert.equal(apiCalls, 0); assert.equal(queries.some(q => /INSERT INTO egrn_orders/.test(q.sql)), false); },
  };
}

const copyKey = (chat, file) => JSON.stringify([String(chat), file.key || String(file.chat) + ':' + String(file.id)]);

test('legacy small-file failure remains best effort when strict mode is not requested', async () => {
  const h = harness({ fail: () => new Error('Temporary Telegram failure') });
  const result = await h.attach();
  assert.equal(result.result, 'attached');
  assert.equal(h.calls.length, 1);
  h.noPaidOrder();
});

test('opt-in strict copy failure cannot claim that an existing EGRN was attached', async () => {
  const failure = new Error('Temporary Telegram failure');
  const h = harness({ fail: () => failure });
  await assert.rejects(h.attach({ copyOptions: { strict: true } }), error => error === failure);
  assert.equal(failure.uncertain, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.order.files_sent, 1);
  h.noPaidOrder();
});

test('strict delivery requires an initialized Telegram sender', async () => {
  const h = harness({ sender: false });
  await assert.rejects(h.attach({ copyOptions: { strict: true } }), error => error.code === 'EGRN_COPY_UNAVAILABLE' && error.uncertain === false);
  assert.equal(h.calls.length, 0);
  h.noPaidOrder();
});

for (const receipt of [undefined, true, {}, { message_id: 0 }, { message_id: -1 }, { message_id: 'not-a-number' }]) {
  test('a missing or invalid native receipt is not confirmed: ' + JSON.stringify(receipt), async () => {
    const h = harness({ receipt: () => receipt });
    let persisted = 0;
    await assert.rejects(h.attach({ copyOptions: { strict: true, onCopied() { persisted++; } } }), error => error.code === 'EGRN_COPY_RECEIPT' && error.uncertain === true);
    assert.equal(persisted, 0);
    h.noPaidOrder();
  });
}

test('mixed small PDF and saved-link retries skip every confirmed file/recipient without duplicating other recipients', async () => {
  const files = [native('first', 5), native('second', 6), link()];
  let failed = false;
  const h = harness({ files, fail(call) {
    if (!failed && call.kind === 'native' && call.file.id === 6) { failed = true; return new Error('Transient second file failure'); }
  } });
  const confirmed = {}, receipts = [];
  const options = { strict: true, confirmed, async onCopied(key, message) {
    assert.ok(message.message_id > 0);
    receipts.push(key); h.events.push('persist:' + key); confirmed[key] = true;
  } };
  await assert.rejects(h.attach({ targets: [{ chat: 20, reply: 9 }, { chat: 30, reply: 10 }], copyOptions: options }), /Transient/);
  assert.deepEqual(Object.keys(confirmed), [copyKey(20, files[0])]);
  const result = await h.attach({ targets: [{ chat: 20, reply: 999 }, { chat: 30, reply: 10 }], copyOptions: options });
  assert.equal(result.result, 'attached');
  assert.equal(h.calls.filter(call => call.target.chat === 20 && call.kind === 'native' && call.file.id === 5).length, 1);
  assert.equal(h.calls.length, 7); // Six successful copies plus the one failed request.
  assert.deepEqual(receipts, [20, 30].flatMap(chat => files.map(file => copyKey(chat, file))));
  const total = h.calls.length;
  await h.attach({ targets: [{ chat: '20' }, { chat: '30' }], copyOptions: options });
  assert.equal(h.calls.length, total);
  assert.equal(receipts.length, 6);
  assert.equal(h.events[0], 'send:native');
  assert.equal(h.events[1], 'persist:' + copyKey(20, files[0]));
  h.noPaidOrder();
});

test('old native records without source keys use a stable source-chat/message identity', async () => {
  const file = native(undefined, 123), key = copyKey(20, file), confirmed = { [key]: true };
  const h = harness({ files: [file] });
  assert.equal((await h.attach({ copyOptions: { strict: true, confirmed } })).result, 'attached');
  assert.equal(h.calls.length, 0);
  assert.equal(key, '["20","-1001001:123"]');
  h.noPaidOrder();
});

test('only explicit confirmed:true skips delivery', async () => {
  const file = native('small'), h = harness({ files: [file] });
  await h.attach({ copyOptions: { strict: true, confirmed: { [copyKey(20, file)]: 1 } } });
  assert.equal(h.calls.length, 1);
  h.noPaidOrder();
});

test('a failed acknowledgement checkpoint stops before any next original or successful attached result', async () => {
  const h = harness({ files: [native('first', 5), native('second', 6), link()] });
  await assert.rejects(h.attach({ copyOptions: { strict: true, async onCopied() { throw new Error('Receipt storage unavailable'); } } }), error => error.code === 'EGRN_COPY_CHECKPOINT' && error.uncertain === true);
  assert.equal(h.calls.length, 1);
  h.noPaidOrder();
});

test('saved-link failures still propagate to legacy callers', async () => {
  const h = harness({ files: [link()], fail: () => new Error('Link delivery failure') });
  await assert.rejects(h.attach(), /Link delivery failure/);
  h.noPaidOrder();
});

test('a saved-link delivery may acknowledge success as true for a checkpoint-only transport', async () => {
  const file = link(), h = harness({ files: [file], receipt: () => true }), saved = [];
  assert.equal((await h.attach({ copyOptions: { strict: true, onCopied(key, message) { saved.push({ key, message }); } } })).result, 'attached');
  assert.deepEqual(saved, [{ key: copyKey(20, file), message: true }]);
  h.noPaidOrder();
});

for (const errorCode of [400, 429]) test('explicit Telegram ' + errorCode + ' rejection remains retryable with its response unchanged', async () => {
  const failure = Object.assign(new Error('Telegram rejected the request'), { response: { error_code: errorCode } });
  const h = harness({ fail: () => failure });
  await assert.rejects(h.attach({ copyOptions: { strict: true } }), error => error === failure && error.uncertain === false && error.response.error_code === errorCode);
  h.noPaidOrder();
});

for (const stage of ['validation', 'storage', 'signing']) test('a saved-link failure before Telegram send is safe to retry: ' + stage, async () => {
  const failure = Object.assign(new Error('Large file temporary failure'), { delivery_stage: stage });
  const h = harness({ files: [link()], fail: () => failure });
  await assert.rejects(h.attach({ copyOptions: { strict: true } }), error => error.uncertain === false);
  h.noPaidOrder();
});

test('large-link wrappers retain explicit Telegram rejection classification', async () => {
  const failure = Object.assign(new Error('Large file temporary failure'), { delivery_stage: 'telegram', failure_code: 'TELEGRAM_429' });
  const h = harness({ files: [link()], fail: () => failure });
  await assert.rejects(h.attach({ copyOptions: { strict: true } }), error => error.uncertain === false);
  h.noPaidOrder();
});

test('large-link wrappers with a lost send acknowledgement require manual inspection before resend', async () => {
  const failure = Object.assign(new Error('Large file temporary failure'), { delivery_stage: 'receipt' });
  const h = harness({ files: [link()], fail: () => failure });
  await assert.rejects(h.attach({ copyOptions: { strict: true } }), error => error.uncertain === true);
  h.noPaidOrder();
});

test('a confirmed source is sent once within a strict call even when its saved descriptor is duplicated', async () => {
  const file = native('small'), h = harness({ files: [file, { ...file }] }), saved = [];
  await h.attach({ copyOptions: { strict: true, onCopied(key) { saved.push(key); } } });
  assert.equal(h.calls.length, 1); assert.deepEqual(saved, [copyKey(20, file)]);
  h.noPaidOrder();
});
