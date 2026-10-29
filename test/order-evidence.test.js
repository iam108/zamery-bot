const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createOrderEvidence, telegramOriginal, MAX_BYTES } = require('../src/bot/order-evidence');
const { prepareMaterials } = require('../src/web/order-materials');

const pdf = Buffer.from('%PDF-1.7\noriginal EGRN bytes\n%%EOF');
function memoryMaterials() {
  const stored = new Map(), calls = [];
  return { stored, calls, prepareMaterials, async saveOrderMaterials(id, files) {
    calls.push(id); for (const file of files) stored.set(id + ':' + file.id, file);
  } };
}

test('raw original is stored only for explicit distinct requests, with stable IDs and bytes', async () => {
  const materials = memoryMaterials(), service = createOrderEvidence({ materials, log() {} });
  const targets = [{ chat: 2 }, { order_id: 7 }, { order_id: '7' }, { order_id: 8 }, { order_id: -1 }];
  await service.registerOriginal(targets, { name: 'ЕГРН.pdf', buffer: pdf });
  await service.registerOriginal(targets, { name: 'ЕГРН.pdf', buffer: pdf });
  assert.equal(materials.stored.size, 2);
  assert.deepEqual(materials.calls, [7, 8, 7, 8]);
  for (const file of materials.stored.values()) { assert.equal(file.role, 'egrn'); assert.equal(file.mime, 'application/pdf'); assert.deepEqual(file.buffer, pdf); }
});

test('registration errors are isolated and logs never contain underlying URLs or secrets', async () => {
  const logs = [], materials = memoryMaterials();
  materials.saveOrderMaterials = async () => { throw new Error('https://api.telegram.org/file/botSECRET/file.pdf'); };
  const result = await createOrderEvidence({ materials, log: value => logs.push(value) }).registerOriginal([{ order_id: 7 }], { name: 'ЕГРН.pdf', buf: pdf });
  assert.match(result.packet_warning, /оригинал/);
  assert.ok(logs.length);
  assert.ok(!logs.join('').includes('SECRET'));
});

test('unrelated targets cause no material or Telegram access', async () => {
  const service = createOrderEvidence({ materials: new Proxy({}, { get() { throw new Error('unexpected material access'); } }), fetch() { throw new Error('unexpected fetch'); } });
  assert.deepEqual(await service.registerOriginal([{ chat: 7 }], {}), {});
  assert.deepEqual(await service.registerCached([{ chat: 7 }], [{ file_id: 'private' }], {}), {});
});

test('cached originals use official Telegram link and preserve PDF bytes', async () => {
  const materials = memoryMaterials(), calls = [];
  const service = createOrderEvidence({ materials, log() {}, fetch: async (url, options) => { calls.push({ url, options }); return new Response(pdf); } });
  const result = await service.registerCached([{ order_id: 7 }], [{ file_id: 'doc-id', name: 'ЕГРН.pdf', bytes: pdf.length }], { getFileLink: async id => { assert.equal(id, 'doc-id'); return new URL('https://api.telegram.org/file/botTEST/document.pdf'); } });
  assert.deepEqual(result, {});
  assert.deepEqual([...materials.stored.values()][0].buffer, pdf);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('legacy cached messages without file_id return warning without recovering history or fetching', async () => {
  let fetched = false;
  const result = await createOrderEvidence({ log() {}, fetch() { fetched = true; } }).registerCached([{ order_id: 7 }], [{ chat: 1, id: 2 }], { getFileLink() { throw new Error('unexpected'); } });
  assert.ok(result.packet_warning);
  assert.equal(fetched, false);
});

test('cached download refuses non-Telegram URLs and foreign redirects before request', async () => {
  let requests = 0;
  await assert.rejects(() => telegramOriginal('https://example.test/file/botTOKEN/a.pdf', async () => { requests++; }));
  assert.equal(requests, 0);
  await assert.rejects(() => telegramOriginal('https://api.telegram.org/file/botTOKEN/a.pdf', async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://example.test/a.pdf' } }); }));
  assert.equal(requests, 1);
});

test('cached download enforces header and streamed byte limits', async () => {
  await assert.rejects(() => telegramOriginal('https://api.telegram.org/file/botT/a.pdf', async () => new Response('small', { headers: { 'Content-Length': String(MAX_BYTES + 1) } })), /large/);
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  await assert.rejects(() => telegramOriginal('https://api.telegram.org/file/botT/a.pdf', async () => new Response(body)), /large/);
});

function egrnHarness({ registerError = false, cached = false } = {}) {
  const registrations = [], sent = [], logs = [];
  const order = { id: 1, id_statement: 9, cad_num: '77:17:0120316:1', status: 'done', status_text: 'готова', polls: 1, chat_id: 10, ordered_by: 10,
    deliver: [{ chat: 20, order_id: 7 }], files_sent: cached ? 1 : 0, file_msgs: cached ? [{ chat: 10, id: 3, file_id: 'old-id', name: 'ЕГРН.pdf' }] : [] };
  let poll;
  const context = { module: { exports: {} }, process: { env: { EGRN_TOKEN: 'test', EGRN_DECLARANT_ID: '1' } }, console: { error: (...items) => logs.push(items) }, setTimeout: fn => { poll = fn; }, setInterval() {},
    require: name => {
      if (name === './formatter') return { esc: String };
      if (name === '../db/pool') return { query: async (sql, params) => {
        if (sql.startsWith('UPDATE egrn_orders SET files_sent=$1')) Object.assign(order, { files_sent: params[0], file_msgs: JSON.parse(params[1]) });
        return { rows: sql.startsWith('SELECT * FROM egrn_orders') ? [order] : [] };
      } };
      if (name === './order-evidence') return {
        registerOriginal: async (targets, file) => { registrations.push({ targets, file }); if (registerError) throw new Error('SECRET'); return {}; },
        registerCached: async (targets, files) => { registrations.push({ targets, files }); return { packet_warning: 'original missing' }; },
      };
      throw new Error('Unexpected require ' + name);
    } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../src/bot/egrn.js'), 'utf8');
  vm.runInContext(source + '\nmodule.exports.testConfigure = function(docs) { apiStatus = async function() { return {}; }; readStatus = function() { return {done:true,failed:false,text:"готова"}; }; extractDocs = function() { return docs; }; };', context);
  context.module.exports.testConfigure([{ name: 'ЕГРН.pdf', buf: pdf, kind: 'pdf' }]);
  context.module.exports.setupEgrn({ on() {}, hears() {}, action() {}, command() {}, telegram: {
    sendDocument: async (chat, file) => { sent.push(file); return { message_id: 3, document: { file_id: 'new-file-id', mime_type: 'application/pdf' } }; },
    callApi: async () => {}, sendMessage: async () => {}, editMessageText: async () => {},
  } });
  return { order, registrations, sent, logs, poll: () => poll(), attach: context.module.exports.attachOrOrder };
}

test('EGRN ready poll registers available original and retains reusable Telegram metadata', async () => {
  const h = egrnHarness(); await h.poll();
  assert.equal(h.registrations.length, 1);
  assert.deepEqual(h.registrations[0].file.buf, pdf);
  assert.equal(h.registrations[0].targets[0].order_id, 7);
  assert.equal(h.sent.length, 1);
  assert.equal(h.order.file_msgs[0].file_id, 'new-file-id');
  assert.equal(h.order.file_msgs[0].name, 'ЕГРН.pdf');
  assert.equal(h.order.file_msgs[0].bytes, pdf.length);
});

test('EGRN packet failure leaves Telegram success and bounded retry state unchanged', async () => {
  const h = egrnHarness({ registerError: true }); await h.poll();
  assert.equal(h.sent.length, 1);
  assert.equal(h.order.files_sent, 1);
  assert.ok(!JSON.stringify(h.logs).includes('SECRET'));
});

test('cached attachment returns packet warning and never falls through to paid ordering', async () => {
  const h = egrnHarness({ cached: true });
  const result = await h.attach({ cad: h.order.cad_num, order: true, targets: [{ chat: 20, order_id: 7 }] });
  assert.equal(result.result, 'attached');
  assert.equal(result.packet_warning, 'original missing');
  assert.equal(h.registrations.length, 1);
  assert.equal(h.sent.length, 0);
});
