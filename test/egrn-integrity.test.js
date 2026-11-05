const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

const CAD = '77:17:0120316:999';
const filename = path.join(__dirname, '../src/bot/egrn.js');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);
const pg = { skip: !process.env.PGLITE_TEST_MODULE, timeout: 15000 };
function gate() {
  let resolve;
  return { promise: new Promise(yes => { resolve = yes; }), open: () => resolve() };
}
async function fixture(options = {}) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite(), calls = { paid: 0, status: [], documents: [], copies: [], messages: [] };
  let tail = Promise.resolve(), poll;
  const pool = {
    async connect() {
      const before = tail, next = gate(); tail = next.promise; await before;
      return { async query(sql, params) {
        await options.beforeQuery?.(sql, params);
        if (params) return db.query(sql, params);
        const values = await db.exec(sql); return values.at(-1) || { rows: [] };
      }, release() { next.open(); } };
    },
    async query(sql, params) { const client = await pool.connect(); try { return await client.query(sql, params); } finally { client.release(); } },
  };
  const actions = [], commands = [];
  const sandbox = {
    module: { exports: {} }, Buffer, AbortSignal, URL, Date,
    process: { env: { EGRN_TOKEN: 'synthetic', EGRN_DECLARANT_ID: '1', EGRN_CHAT_ID: '-100123', ADMIN_TG_IDS: '111' } },
    console: { log() {}, error() {} }, setTimeout(fn) { poll = fn; }, setInterval() {},
    require(name) {
      if (name === '../db/pool') return pool;
      if (name === './order-evidence') return { async registerOriginal() { return {}; }, async registerCached() { return {}; } };
      return localRequire(name);
    },
    async fetch(url, request = {}) {
      assert.equal(request.method, 'POST'); calls.paid++;
      await options.orderApi?.(calls.paid);
      return new Response(JSON.stringify({ id_statement: 9000 + calls.paid }));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nmodule.exports.qa={ensureTables,reserveOrder,setStatus(fn){apiStatus=fn;}};', sandbox, { filename });
  const api = sandbox.module.exports;
  const telegram = {
    async sendMessage(chat, text) { calls.messages.push({ chat, text }); return { message_id: 100 + calls.messages.length }; },
    async editMessageText() {},
    async sendDocument(chat, file, extra) { calls.documents.push({ chat, file, extra }); await options.sendDocument?.(extra); return { message_id: 200 + calls.documents.length, document: { file_id: 'test-only-original', mime_type: 'application/pdf' } }; },
    async callApi(method, value) { calls.copies.push(value); await options.copy?.(value); return { message_id: 300 + calls.copies.length }; },
  };
  const bot = { on() {}, hears() {}, action(pattern, handler) { actions.push({ pattern, handler }); }, command(name, handler) { commands.push({ name, handler }); }, telegram };
  api.setupEgrn(bot);
  await api.qa.ensureTables();
  api.qa.setStatus(async id => {
    calls.status.push(Number(id));
    const done = options.ready ? options.ready(Number(id)) : true;
    return { id_req: id, status: [{ type: done ? 'processed' : 'waiting', statusDescription: done ? 'Выполнено' : 'В работе', ...(done ? { file: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 32), Buffer.from('\n%%EOF')]).toString('base64') } : {}) }] };
  });
  const add = async ({ id = 7001, cad = CAD, status = 'ordered', filesSent = 0, files = [], targets = [], card = null } = {}) => (await pool.query(
    'INSERT INTO egrn_orders(cad_num,type_doc,id_statement,status,status_text,chat_id,ordered_by,status_msg_id,deliver,file_msgs,files_sent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [cad, 'kvarmrusxmlpdf', id, status, 'В работе', -100123, 111, card, JSON.stringify(targets), JSON.stringify(files), filesSent])).rows[0];
  return { db, pool, calls, api, actions, commands, telegram, add, poll: () => poll(), anotherPoller() { api.setupEgrn(bot); const run = poll; return run; },
    row: async id => (await pool.query('SELECT * FROM egrn_orders WHERE id=$1', [id])).rows[0],
    attach: (chat = 111, extra = {}) => api.attachOrOrder({ cad: CAD, order: true, orderedBy: chat, targets: [{ chat }], ...extra }),
    close: () => db.close() };
}

test('concurrent requests reserve one paid order and keep both recipients', pg, async () => {
  const started = gate(), release = gate();
  const h = await fixture({ orderApi: async () => { started.open(); await release.promise; } });
  try {
    const first = h.attach(111); await started.promise;
    const second = await h.attach(222); assert.equal(second.result, 'waiting');
    release.open(); assert.equal((await first).result, 'ordered');
    assert.equal(h.calls.paid, 1);
    const rows = (await h.pool.query('SELECT * FROM egrn_orders')).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'ordered');
    assert.deepEqual(rows[0].deliver.map(t => Number(t.chat)).sort(), [111, 222]);
  } finally { release.open(); await h.close(); }
});

test('atomic recipient registration does not lose a concurrent requester', pg, async () => {
  const h = await fixture();
  try {
    const original = await h.add(); await Promise.all([h.attach(222), h.attach(333)]);
    assert.deepEqual((await h.row(original.id)).deliver.map(t => Number(t.chat)).sort(), [222, 333]);
    assert.equal(h.calls.paid, 0);
  } finally { await h.close(); }
});

test('unconfirmed provider result remains a durable reservation and never silently orders again', pg, async () => {
  const h = await fixture({ orderApi() { throw new Error('Synthetic response lost after sending'); } });
  try {
    await assert.rejects(h.attach(), error => error.code === 'EGRN_ORDER_UNCONFIRMED');
    assert.equal((await h.pool.query('SELECT status FROM egrn_orders')).rows[0].status, 'order_unknown');
    const retry = await h.attach(); assert.equal(retry.result, 'uncertain');
    assert.match(retry.packet_warning, /личный кабинет/);
    const forced = await h.attach(111, { force: true, requestKey: 'telegram:1' });
    assert.equal(forced.result, 'uncertain'); assert.equal(h.calls.paid, 1);
  } finally { await h.close(); }
});

test('a reservation surviving process death before the POST is not converted into another paid request', pg, async () => {
  const h = await fixture();
  try {
    const reserved = await h.api.qa.reserveOrder(CAD, { orderedBy: 111, targets: [{ chat: 111 }] });
    assert.equal(reserved.created, true); assert.equal(h.calls.paid, 0);
    await h.pool.query("UPDATE egrn_orders SET created_at=NOW()-INTERVAL '3 minutes' WHERE id=$1", [reserved.order.id]);
    const retry = await h.attach(222);
    assert.equal(retry.result, 'uncertain'); assert.equal(h.calls.paid, 0);
  } finally { await h.close(); }
});

test('successful provider order followed by a failed checkpoint keeps its known statement number for reconciliation', pg, async () => {
  let failed = false;
  const h = await fixture({ beforeQuery(sql) { if (!failed && sql.startsWith('UPDATE egrn_orders SET id_statement=')) { failed = true; throw new Error('Synthetic database acknowledgement lost'); } } });
  try {
    await assert.rejects(h.attach(), error => error.code === 'EGRN_ORDER_CHECKPOINT');
    const order = (await h.pool.query('SELECT * FROM egrn_orders')).rows[0];
    assert.equal(order.status, 'order_unknown'); assert.equal(Number(order.id_statement), 9001);
    assert.equal((await h.attach()).result, 'uncertain'); assert.equal(h.calls.paid, 1);
  } finally { await h.close(); }
});

test('failed recipient delivery resumes from native receipts without refetching or reuploading the original', pg, async () => {
  let failed = true;
  const h = await fixture({ copy(value) { if (failed && Number(value.chat_id) === 222) throw { response: { error_code: 403 }, message: 'Synthetic Telegram rejection' }; } });
  try {
    const original = await h.add({ targets: [{ chat: 222 }] }); await h.poll();
    assert.equal((await h.row(original.id)).files_sent, 0);
    failed = false; await h.pool.query('UPDATE egrn_orders SET retry_at=NULL WHERE id=$1', [original.id]); await h.poll();
    assert.ok((await h.row(original.id)).files_sent > 0);
    assert.equal(h.calls.documents.length, 1); assert.deepEqual(h.calls.status, [7001]);
    assert.equal(h.calls.copies.filter(c => Number(c.chat_id) === 111).length, 1);
    assert.equal(h.calls.copies.filter(c => Number(c.chat_id) === 222).length, 2);
  } finally { await h.close(); }
});

test('waiting orders rotate out of a full polling batch so a newer ready order is checked', pg, async () => {
  const h = await fixture({ ready: id => id === 7021 });
  try {
    for (let i = 1; i <= 21; i++) await h.add({ id: 7000 + i, cad: '77:17:0120316:' + i });
    await h.poll(); await h.poll();
    assert.ok(h.calls.status.includes(7021)); assert.equal(h.calls.documents.length, 1);
  } finally { await h.close(); }
});

test('a deleted status card does not prevent delivery of the ready original', pg, async () => {
  const h = await fixture({ sendDocument(extra) { assert.equal(extra.reply_to_message_id, undefined); assert.equal(extra.reply_parameters.allow_sending_without_reply, true); } });
  try {
    const original = await h.add({ card: 999 }); await h.poll();
    assert.ok((await h.row(original.id)).files_sent > 0); assert.equal(h.calls.documents.length, 1);
  } finally { await h.close(); }
});

test('a ready native document is reused by the Telegram order action instead of offering only another paid order', pg, async () => {
  const h = await fixture();
  try {
    await h.add({ status: 'done', filesSent: 1, files: [{ key: 'pdf', chat: -100123, id: 7, name: 'statement.pdf' }] });
    const pending = (await h.pool.query('INSERT INTO egrn_pending(cad_num,chat_id) VALUES($1,$2) RETURNING id', [CAD, 111])).rows[0];
    const replies = [], action = h.actions.find(a => a.pattern.test('eg:' + pending.id + ':kv'));
    await action.handler({ match: ['eg:' + pending.id + ':kv', String(pending.id), 'kv'], from: { id: 111 }, callbackQuery: { message: { chat: { id: 111 } } }, async answerCbQuery() {}, async reply(text) { replies.push(text); }, telegram: h.telegram });
    assert.equal(h.calls.copies.length, 1); assert.equal(h.calls.paid, 0);
    assert.ok(replies.some(text => /Готовая выписка отправлена/.test(text)));
  } finally { await h.close(); }
});

test('overlapping poller instances claim each order once without holding a pooled connection', pg, async () => {
  const entered = gate(), release = gate();
  const h = await fixture({ async sendDocument() { entered.open(); await release.promise; } });
  try {
    const original = await h.add();
    const first = h.poll(); await entered.promise;
    const secondPoller = h.anotherPoller(); await secondPoller();
    assert.equal(h.calls.documents.length, 1); assert.deepEqual(h.calls.status, [7001]);
    release.open(); await first;
    const saved = await h.row(original.id); assert.ok(saved.files_sent > 0); assert.equal(saved.processing_token, null);
  } finally { release.open(); await h.close(); }
});

test('an expired delivery lease can be resumed after a process stopped', pg, async () => {
  const h = await fixture();
  try {
    const original = await h.add();
    await h.pool.query("UPDATE egrn_orders SET processing_token=gen_random_uuid(),processing_until=NOW()+INTERVAL '1 minute' WHERE id=$1", [original.id]);
    await h.poll(); assert.equal(h.calls.documents.length, 0);
    await h.pool.query("UPDATE egrn_orders SET processing_until=NOW()-INTERVAL '1 minute' WHERE id=$1", [original.id]);
    await h.poll(); assert.equal(h.calls.documents.length, 1); assert.ok((await h.row(original.id)).files_sent > 0);
  } finally { await h.close(); }
});

test('a recipient joining during delivery is retained pending and receives the cached original next round', pg, async () => {
  const entered = gate(), release = gate(); let block = true;
  const h = await fixture({ async copy(value) { if (block && Number(value.chat_id) === 111) { entered.open(); await release.promise; } } });
  try {
    const original = await h.add(); const delivery = h.poll(); await entered.promise;
    assert.equal((await h.attach(222)).result, 'waiting');
    block = false; release.open(); await delivery;
    assert.equal((await h.row(original.id)).files_sent, 0, 'new recipient must not be acknowledged by an older generation');
    await h.poll(); assert.ok((await h.row(original.id)).files_sent > 0);
    assert.equal(h.calls.documents.length, 1); assert.deepEqual(h.calls.status, [7001]);
    assert.equal(h.calls.copies.filter(c => Number(c.chat_id) === 222).length, 1);
    assert.equal(h.calls.copies.filter(c => Number(c.chat_id) === 111).length, 1);
  } finally { release.open(); await h.close(); }
});

test('an administrator can bind a verified existing provider order without creating a paid order', pg, async () => {
  const h = await fixture();
  try {
    const original = await h.add({ status: 'order_unknown' });
    const handler = h.commands.find(command => command.name === 'egrn_reconcile').handler;
    const replies = [];
    await handler({ chat: { type: 'private' }, from: { id: 222 }, message: { text: '/egrn_reconcile ' + original.id + ' 7001' }, async reply(value) { replies.push(value); } });
    assert.equal((await h.row(original.id)).status, 'order_unknown');
    await handler({ chat: { type: 'private' }, from: { id: 111 }, message: { text: '/egrn_reconcile ' + original.id + ' 7001' }, async reply(value) { replies.push(value); } });
    assert.equal((await h.row(original.id)).status, 'ordered'); assert.equal(h.calls.paid, 0);
    assert.ok(replies.some(value => /Существующий заказ привязан/.test(value)));
  } finally { await h.close(); }
});
