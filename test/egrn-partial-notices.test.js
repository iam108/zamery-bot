'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

const filename = path.join(__dirname, '../src/bot/egrn.js');
const localRequire = createRequire(filename);
const pg = { skip: !process.env.PGLITE_TEST_MODULE, timeout: 15000 };
const GROUP = '-100123', OWNER = '111', LAWYER = '222';
const CAD = '77:17:0120316:999';
const pdf = Buffer.from('%PDF-1.7\n' + 'synthetic '.repeat(35) + '\n%%EOF');

async function fixture({ requester = OWNER, target = LAWYER, approved = false, notificationFailure } = {}) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite(), calls = { documents: [], copies: [], notices: [], edits: [], status: [], logs: [], paid: 0 };
  let tail = Promise.resolve(), scheduled, failure;
  const pool = {
    async connect() {
      const before = tail; let release;
      tail = new Promise(resolve => { release = resolve; }); await before;
      return { async query(sql, values) { if (failure?.(sql, values)) throw Object.assign(new Error('Synthetic SQL failure'), { code: 'QA_SQL' }); return values ? db.query(sql, values) : db.exec(sql).then(rows => rows.at(-1)); }, release };
    },
    async query(sql, values) { const c = await pool.connect(); try { return await c.query(sql, values); } finally { c.release(); } },
  };
  const commands = [];
  const telegram = {
    async sendDocument(chat, file) { calls.documents.push({ chat: String(chat), bytes: file.source }); return { message_id: 200 + calls.documents.length, document: { file_id: 'synthetic-only', mime_type: 'application/pdf' } }; },
    async callApi(method, value) { assert.equal(method, 'copyMessage'); calls.copies.push(value); return { message_id: 300 + calls.copies.length }; },
    async sendMessage(chat, text) { const call = { chat: String(chat), text }; calls.notices.push(call); await notificationFailure?.(call); call.delivered = true; return { message_id: 400 + calls.notices.length }; },
    async editMessageText(chat, id, inline, text) { calls.edits.push({ chat: String(chat), id, text }); return { message_id: Number(id) }; },
  };
  const bot = { on() {}, hears() {}, action() {}, command(name, handler) { commands.push({ name, handler }); }, telegram };
  const env = { EGRN_TOKEN: 'synthetic', EGRN_DECLARANT_ID: '1', EGRN_CHAT_ID: GROUP, ADMIN_TG_IDS: OWNER };
  function start() {
    const sandbox = {
      module: { exports: {} }, Buffer, URL, AbortSignal, Date, process: { env }, console: { log() {}, error(...args) { calls.logs.push(args); } },
      setTimeout(fn) { scheduled = fn; }, setInterval() {},
      require(name) {
        if (name === '../db/pool') return pool;
        if (name === './order-evidence') return { async registerOriginal() {}, async registerCached() {} };
        return localRequire(name);
      },
      fetch() { calls.paid++; assert.fail('A delivery retry must never create a paid request'); },
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.qa={ensureTables,setStatus(fn){apiStatus=fn;}};', sandbox, { filename });
    const api = sandbox.module.exports;
    api.setupEgrn(bot);
    api.qa.setStatus(async id => {
      calls.status.push(String(id));
      return { id_req: id, status: [{ type: 'processed', statusDescription: 'Выполнено', file: pdf.toString('base64') }] };
    });
    return api;
  }
  const api = start(); await api.qa.ensureTables();
  await pool.query('CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,approved BOOLEAN,role TEXT); CREATE TABLE cases(id INT PRIMARY KEY,lawyer_tg_id BIGINT)');
  await pool.query("INSERT INTO staff VALUES(111,true,'manager'),(222,$1,'lawyer')", [approved]);
  await pool.query('INSERT INTO cases VALUES(9,222)');
  const order = (await pool.query("INSERT INTO egrn_orders(cad_num,type_doc,id_statement,status,status_text,chat_id,ordered_by,deliver) VALUES($1,'kvarmrusxmlpdf',7001,'ordered','В работе',$2,$3,$4) RETURNING *",
    [CAD, GROUP, requester, JSON.stringify(target ? [{ chat: target, case_id: 9 }] : [])])).rows[0];
  return {
    pool, calls, order,
    row: async () => (await pool.query('SELECT * FROM egrn_orders WHERE id=$1', [order.id])).rows[0],
    poll: () => scheduled(),
    async retry() { const replies = []; const handler = commands.findLast(c => c.name === 'egrn_retry')?.handler; assert.ok(handler); await handler({ from: { id: Number(OWNER) }, chat: { id: Number(OWNER), type: 'private' }, message: { message_id: 901, text: '/egrn_retry 7001' }, async reply(text) { replies.push(text); } }); return replies; },
    restart: start,
    setFailure(fn) { failure = fn; },
    async due() { await pool.query('UPDATE egrn_orders SET retry_at=NULL WHERE id=$1', [order.id]); },
    close: () => db.close(),
  };
}

test('a confirmed group PDF and a blocked case lawyer yield one truthful notice through five retries and a restart, then only the missing private copy is resumed', pg, async () => {
  const h = await fixture();
  try {
    await h.poll(); const first = await h.row();
    assert.equal(first.files_sent, 0, 'Partial delivery must remain pending');
    assert.equal(first.file_msgs.length, 1); assert.equal(String(first.file_msgs[0].chat), GROUP);
    assert.deepEqual(h.calls.documents[0].bytes, pdf);
    assert.equal(h.calls.copies.some(c => String(c.chat_id) === LAWYER), false);
    assert.equal(h.calls.notices.length, 1, JSON.stringify({error:first.error,logs:h.calls.logs}));
    for (let retry = 0; retry < 4; retry++) {
      if (retry === 1) h.restart();
      await h.due(); await h.poll();
    }
    assert.equal(h.calls.notices.length, 1, 'An unchanged blocked recipient must not generate another notification at the retry limit or after restart');
    assert.match(h.calls.notices[0].text, /доставлен|получен/i);
    assert.match(h.calls.notices[0].text, /личн|юрист|получател/i);
    assert.equal(h.calls.documents.length, 1); assert.equal(h.calls.status.length, 1, 'Durable originals avoid another supplier read');
    assert.ok((await h.row()).files_sent <= 0);
    await h.pool.query('UPDATE staff SET approved=true WHERE tg_id=$1', [LAWYER]);
    const replies = await h.retry();
    assert.ok((await h.row()).files_sent > 0); assert.match(replies.at(-1), /доставлена/i);
    assert.equal(h.calls.documents.length, 1, 'Do not re-upload the confirmed group original');
    assert.equal(h.calls.copies.filter(c => String(c.chat_id) === LAWYER).length, 1);
    assert.equal(h.calls.copies.filter(c => String(c.chat_id) === OWNER).length, 1);
    assert.equal(h.calls.status.length, 1); assert.equal(h.calls.paid, 0);
    assert.equal((await h.row()).delivery_state.inflight, undefined);
  } finally { await h.close(); }
});

test('a group requester without a staff approval preserves the group file and explicitly reports that only the private copy remains blocked', pg, async () => {
  const h = await fixture({ requester: '444', target: null });
  try {
    await h.poll(); const first = await h.row();
    assert.equal(first.files_sent, 0); assert.equal(first.file_msgs.length, 1);
    assert.equal(String(first.file_msgs[0].chat), GROUP);
    assert.equal(h.calls.documents.length, 1);
    assert.equal(h.calls.copies.some(c => String(c.chat_id) === '444'), false);
    assert.equal(h.calls.notices.length, 1, JSON.stringify({error:first.error,logs:h.calls.logs})); assert.equal(h.calls.notices[0].chat, OWNER);
    assert.match(h.calls.notices[0].text, /доставлен|получен/i);
    assert.match(h.calls.notices[0].text, /личн/i);
    for (let retry = 0; retry < 4; retry++) { await h.due(); await h.poll(); }
    assert.equal(h.calls.notices.length, 1);
    await h.pool.query("INSERT INTO staff VALUES(444,true,'manager')"); await h.retry();
    assert.ok((await h.row()).files_sent > 0);
    assert.equal(h.calls.documents.length, 1);
    assert.equal(h.calls.copies.filter(c => String(c.chat_id) === '444').length, 1);
    assert.equal(h.calls.paid, 0); assert.equal(h.calls.status.length, 1);
  } finally { await h.close(); }
});

test('a failed durable notification reservation sends nothing and the next poll can issue the warning', pg, async () => {
  const h = await fixture();
  try {
    h.setFailure(sql => sql.includes("'{stopped_notice}'") && sql.includes('RETURNING delivery_state'));
    await h.poll();
    assert.equal(h.calls.documents.length, 1); assert.equal(h.calls.notices.length, 0);
    assert.equal((await h.row()).delivery_state.stopped_notice, undefined);
    h.setFailure(null); await h.due(); await h.poll();
    assert.equal(h.calls.notices.length, 1); assert.equal(h.calls.notices[0].delivered, true);
    assert.ok((await h.row()).delivery_state.stopped_notice);
    assert.equal(h.calls.documents.length, 1); assert.equal(h.calls.paid, 0);
  } finally { await h.close(); }
});

test('a lost notification acknowledgement is not retried into duplicate private or group warnings after restart', pg, async () => {
  const h = await fixture({ notificationFailure() { throw new Error('Synthetic ACK lost'); } });
  try {
    await h.poll(); assert.equal(h.calls.notices.length, 1);
    assert.equal(h.calls.notices[0].chat, OWNER);
    assert.ok((await h.row()).delivery_state.stopped_notice);
    h.restart();
    for (let retry = 0; retry < 4; retry++) { await h.due(); await h.poll(); }
    assert.equal(h.calls.notices.length, 1, 'Do not emit another warning when the previous physical result is unknown');
    assert.equal(h.calls.documents.length, 1); assert.equal(h.calls.paid, 0);
  } finally { await h.close(); }
});

test('definite notification rejection by every eligible target releases the reservation so later access can deliver the warning', pg, async () => {
  let rejected = true;
  const h = await fixture({ notificationFailure() { if (rejected) throw { response: { error_code: 403, description: 'Forbidden' } }; } });
  try {
    await h.poll();
    assert.equal(h.calls.notices.filter(c => c.delivered).length, 0);
    assert.equal((await h.row()).delivery_state.stopped_notice, undefined, 'A definitely rejected notification is not marked delivered or left reserved forever');
    assert.equal(h.calls.logs.some(log => /could not determine|bind message|parameter/.test(log.join(' '))), false);
    rejected = false; await h.due(); await h.poll();
    assert.equal(h.calls.notices.filter(c => c.delivered).length, 1);
    assert.equal((await h.row()).delivery_state.stopped_notice.state, 'sent');
    assert.equal(h.calls.documents.length, 1); assert.equal(h.calls.paid, 0);
  } finally { await h.close(); }
});

test('notification checkpoints preserve an unresolved original attempt and consumed retry cursors', pg, async () => {
  const h = await fixture();
  try {
    const inflight = { attempt: '11111111-1111-4111-8111-111111111111', target: { chat: GROUP }, key: 'original-only', kind: 'native-primary' };
    const retry_cursors = { [OWNER]: 812 };
    await h.pool.query('UPDATE egrn_orders SET delivery_state=$1 WHERE id=$2', [JSON.stringify({ inflight, retry_cursors }), h.order.id]);
    await h.poll(); const row = await h.row();
    assert.equal(h.calls.documents.length, 0); assert.equal(h.calls.status.length, 0);
    assert.deepEqual(row.delivery_state.inflight, inflight);
    assert.deepEqual(row.delivery_state.retry_cursors, retry_cursors);
    assert.ok(row.delivery_state.stopped_notice);
    assert.equal(h.calls.notices.length, 1); assert.equal(h.calls.paid, 0);
  } finally { await h.close(); }
});
