const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const LIMIT = 50 * 1024 * 1024;

function harness({ docs = [], urls = [], downloadedSize = 10, sendError } = {}) {
  const queries = [];
  const sent = [];
  const order = { id: 1, id_statement: 42, cad_num: '77:17:0120316:1', status: 'done',
    status_text: 'готова', polls: 1, chat_id: 10, ordered_by: 10, deliver: [] };
  const pool = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.startsWith('SELECT * FROM egrn_orders') ? [order] : [] };
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
    console: { error() {} },
    setTimeout: (fn) => { poll = fn; }, setInterval() {},
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../src/bot/egrn.js'), 'utf8');
  vm.runInContext(source + '\nmodule.exports.testHooks = { checkDocumentSize, documentTooLarge, configure: function(docs, urls, size) {' +
    ' apiStatus = async function() { return {}; };' +
    ' readStatus = function() { return { done: true, failed: false, text: "готова" }; };' +
    ' extractDocs = function() { return docs; }; findFileUrls = function() { return urls; };' +
    ' download = async function() { return { buf: { length: size }, name: "download.pdf" }; };' +
    ' } };', context);
  const hooks = context.module.exports.testHooks;
  hooks.configure(docs, urls, downloadedSize);
  const bot = { on() {}, hears() {}, action() {}, command() {}, telegram: {
    sendDocument: async (chat, file) => {
      sent.push(file);
      if (sendError) throw sendError;
      return { message_id: sent.length };
    },
  } };
  context.module.exports.setupEgrn(bot);
  return { hooks, sent, queries, poll: () => poll(),
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
  assert.equal(h.deliveries().length, 0);
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
  assert.deepEqual(JSON.parse(params[1]), [{ chat: 10, id: 1 }]);
  assert.equal(h.sent.length, 1);
});
