const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const LIMIT = 50 * 1024 * 1024;

function harness({ docs = [], urls = [], downloadedSize = 10, sendError, orderFields = {}, statusRequest } = {}) {
  const queries = [];
  const sent = [];
  const notices = [];
  const logs = [];
  const order = { id: 1, id_statement: 42, cad_num: '77:17:0120316:1', status: 'done',
    status_text: 'готова', polls: 1, chat_id: 10, ordered_by: 10, deliver: [], files_sent: 0, ...orderFields };
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('UPDATE egrn_orders SET files_sent=$1')) {
      Object.assign(order, { files_sent: params[0], file_msgs: JSON.parse(params[1]), error: params[2] });
      if (sql.includes('failures=$4')) Object.assign(order, { failures: params[3], retry_at: params[4] });
    }
    if (sql.startsWith('SELECT * FROM egrn_orders WHERE cad_num=')) return { rows: [order] };
    return { rows: sql.startsWith('SELECT * FROM egrn_orders') && order.files_sent === 0 &&
      (!order.retry_at || order.retry_at <= Date.now()) ? [order] : [] };
  } };
  let poll;
  const context = {
    module: { exports: {} },
    require: (name) => {
      if (name === '../db/pool') return pool;
      if (name === './formatter') return { esc: String };
      throw new Error('Unexpected require: ' + name);
    },
    process: { env: { EGRN_TOKEN: 'test', EGRN_DECLARANT_ID: '1' } },
    console: { error(...args) { logs.push(args); } },
    setTimeout: (fn) => { poll = fn; }, setInterval() {},
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../src/bot/egrn.js'), 'utf8');
  vm.runInContext(source + '\nmodule.exports.testHooks = { checkDocumentSize, documentTooLarge, configure: function(docs, urls, size) {' +
    ' apiStatus = async function() { return {}; };' +
    ' readStatus = function() { return { done: true, failed: false, text: "готова" }; };' +
    ' extractDocs = function() { return docs; }; findFileUrls = function() { return urls; };' +
    ' download = async function() { return { buf: { length: size }, name: "download.pdf" }; };' +
    ' }, setStatusRequest: function(fn) { apiStatus = fn; } };', context);
  const hooks = context.module.exports.testHooks;
  hooks.configure(docs, urls, downloadedSize);
  if (statusRequest) hooks.setStatusRequest(statusRequest);
  const bot = { on() {}, hears() {}, action() {}, command() {}, telegram: {
    sendDocument: async (chat, file) => {
      sent.push(file);
      const error = typeof sendError === 'function' ? sendError(file) : sendError;
      if (error) throw error;
      return { message_id: sent.length };
    },
    sendMessage: async (chat, text) => { notices.push({ chat, text }); },
    editMessageText: async (...args) => { notices.push({ edit: args }); },
    callApi: async () => {},
  } };
  context.module.exports.setupEgrn(bot);
  return { hooks, sent, queries, order, notices, logs, poll: () => poll(), attachOrOrder: context.module.exports.attachOrOrder,
    deliveries: () => queries.filter(q => q.sql.startsWith('UPDATE egrn_orders SET files_sent=$1')) };
}

function doc(size, name = 'statement.pdf') {
  return { buf: { length: size }, name, kind: 'pdf' };
}

test('size boundary: allowed at limit, rejected above limit', () => {
  const { hooks } = harness();
  assert.doesNotThrow(() => hooks.checkDocumentSize({ length: LIMIT }));
  assert.throws(() => hooks.checkDocumentSize({ length: LIMIT + 1 }),
    err => err.code === 'EGRN_DOCUMENT_TOO_LARGE');
});

test('recognizes Telegraf and plain HTTP 413 without matching unrelated numbers', () => {
  const { hooks } = harness();
  assert.equal(hooks.documentTooLarge({ response: { error_code: 413 } }), true);
  assert.equal(hooks.documentTooLarge(new Error('413: Request Entity Too Large')), true);
  assert.equal(hooks.documentTooLarge({ code: 413 }), true);
  assert.equal(hooks.documentTooLarge(new Error('download 500 for order 413')), false);
});

test('oversized embedded document is not uploaded and stops polling', async () => {
  const h = harness({ docs: [doc(LIMIT + 1)] });
  await h.poll();
  assert.equal(h.sent.length, 0);
  assert.equal(h.deliveries()[0].params[0], -1);
  assert.match(h.deliveries()[0].params[2], /52428801/);
});

test('oversized downloaded document is not uploaded and stops polling', async () => {
  const h = harness({ urls: ['https://example.test/file.pdf'], downloadedSize: LIMIT + 1 });
  await h.poll();
  assert.equal(h.sent.length, 0);
  assert.equal(h.deliveries()[0].params[0], -1);
});

test('Telegram 413 stops polling even when local size check passed', async () => {
  const h = harness({ docs: [doc(10)], sendError: new Error('413: Request Entity Too Large') });
  await h.poll();
  assert.equal(h.sent.length, 1);
  assert.equal(h.deliveries()[0].params[0], -1);
  assert.match(h.deliveries()[0].params[2], /413/);
});

test('downloaded document also handles structured Telegram 413', async () => {
  const h = harness({ urls: ['https://example.test/file.pdf'],
    sendError: { message: 'Request Entity Too Large', response: { error_code: 413 } } });
  await h.poll();
  assert.equal(h.deliveries()[0].params[0], -1);
});

test('temporary upload failure remains eligible for retry', async () => {
  const h = harness({ docs: [doc(10)], sendError: new Error('502: Bad Gateway') });
  await h.poll();
  const params = h.deliveries()[0].params;
  assert.equal(params[0], 0);
  assert.equal(params[3], 1);
  assert.ok(params[4] > Date.now());
  assert.equal(h.notices.length, 0);
});

test('ordinary delivery succeeds and clears stale errors', async () => {
  const h = harness({ docs: [doc(10)] });
  await h.poll();
  assert.equal(h.deliveries()[0].params[0], 1);
  assert.equal(h.deliveries()[0].params[2], null);
});

test('partial delivery preserves sent message IDs while stopping oversized retries', async () => {
  const h = harness({ docs: [doc(LIMIT + 1), doc(10)] });
  await h.poll();
  const params = h.deliveries()[0].params;
  assert.equal(params[0], -1);
  assert.deepEqual(JSON.parse(params[1]), [{ chat: 10, id: 1, key: 'embedded:1:statement.pdf' }]);
  assert.equal(h.sent.length, 1);
});

test('oversized file updates the card, notifies requester and does not notify again', async () => {
  const h = harness({ docs: [doc(LIMIT + 1)], orderFields: { status_msg_id: 99, ordered_by: 20 } });
  await h.poll();
  assert.equal(h.notices.length, 2);
  assert.match(h.notices[0].edit[3], /Выписка готова/);
  assert.equal(h.notices[1].chat, 20);
  assert.match(h.notices[1].text, /https:\/\/armrus.org/);
  assert.match(h.notices[1].text, /№42/);
  await h.poll();
  assert.equal(h.notices.length, 2);
});

test('file logs contain order, statement, filename and bytes', async () => {
  const h = harness({ docs: [doc(LIMIT + 1, 'large.pdf')] });
  await h.poll();
  const log = JSON.parse(h.logs.find(entry => entry[0] === 'egrn file:')[1]);
  assert.equal(log.order_id, 1);
  assert.equal(log.id_statement, 42);
  assert.equal(log.filename, 'large.pdf');
  assert.equal(log.bytes, LIMIT + 1);
});

test('fifth consecutive failure stops delivery and notifies once', async () => {
  const h = harness({ docs: [doc(10)], sendError: new Error('502: Bad Gateway') });
  const delays = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = Date.now();
    await h.poll();
    if (attempt < 5) delays.push(h.order.retry_at - before);
    h.order.retry_at = null; // Simulate the next eligible poll.
  }
  assert.equal(h.order.files_sent, -1);
  assert.equal(h.order.failures, 5);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].text, /нескольких попыток/);
  for (let i = 0; i < delays.length; i++) {
    assert.ok(Math.abs(delays[i] - 180000 * Math.pow(2, i)) < 1000);
  }
  await h.poll();
  assert.equal(h.sent.length, 5);
});

test('retry deadline prevents premature resend', async () => {
  const h = harness({ docs: [doc(10)], sendError: new Error('502: Bad Gateway') });
  await h.poll();
  await h.poll();
  assert.equal(h.sent.length, 1);
  assert.ok(h.queries.some(q => q.sql.includes('retry_at <= NOW()')));
});

test('partial transient failure retries only the unsent document', async () => {
  let fail = true;
  const h = harness({ docs: [doc(10, 'first.pdf'), doc(10, 'second.pdf')],
    sendError: file => fail && file.filename === 'second.pdf' ? new Error('502: Bad Gateway') : null });
  await h.poll();
  assert.equal(h.order.files_sent, 0);
  assert.equal(h.order.file_msgs.length, 1);
  fail = false;
  h.order.retry_at = null;
  await h.poll();
  assert.deepEqual(h.sent.map(f => f.filename), ['first.pdf', 'second.pdf', 'second.pdf']);
  assert.equal(h.order.files_sent, 2);
  assert.equal(h.order.error, null);
});

test('status request failures are bounded and report checking failure accurately', async () => {
  const h = harness({ orderFields: { failures: 4, status: 'ordered' },
    statusRequest: async () => { throw new Error('terminated'); } });
  await h.poll();
  assert.equal(h.order.files_sent, -1);
  assert.equal(h.order.failures, 5);
  assert.match(h.notices[0].text, /Не удалось проверить готовность/);
});

test('overlapping polls share one in-flight request and release the guard afterward', async () => {
  let release;
  let calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ docs: [doc(10)], statusRequest: async () => { calls++; await blocked; return {}; } });
  const first = h.poll();
  await new Promise(resolve => setImmediate(resolve));
  await h.poll();
  assert.equal(calls, 1);
  release();
  await first;
  h.order.files_sent = 0;
  await h.poll();
  assert.equal(calls, 2);
});

test('guard is released after status request failure', async () => {
  let calls = 0;
  const h = harness({ statusRequest: async () => { calls++; throw new Error('terminated'); } });
  await h.poll();
  h.order.retry_at = null;
  await h.poll();
  assert.equal(calls, 2);
});

test('stopped delivery does not create a second paid order from a form', async () => {
  const h = harness({ orderFields: { files_sent: -1 } });
  const result = await h.attachOrOrder({ cad: '77:17:0120316:1', order: true });
  assert.equal(result.result, 'unavailable');
  assert.equal(result.id, 42);
  assert.equal(h.queries.some(q => q.sql.includes('INSERT INTO egrn_orders')), false);
});

test('ready status without files uses the same bounded retry policy', async () => {
  const h = harness({ orderFields: { failures: 4 } });
  await h.poll();
  assert.equal(h.order.files_sent, -1);
  assert.match(h.order.error, /файлы не найдены/);
  assert.equal(h.notices.length, 1);
});
