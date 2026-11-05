'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createPacketService } = require('../src/web/handoff-packet');
const { createHandoffSubmitter } = require('../src/web/handoff-submit');
const { createHandoffMaterialsDelivery } = require('../src/web/handoff-materials');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
const CLIENTS = '-100200', AUDITS = '-100100', LAWYER = '808';
const source = fs.readFileSync(require.resolve('../src/web/handoff'), 'utf8');
const explicitFailure = () => Object.assign(new Error('Synthetic explicit Telegram rejection'), { response: { error_code: 400 } });

async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  const events = [], locks = new Map(); let sequence = 1000, intercept = () => {}, loads = 0;
  const query = (sql, values) => !values && sql.split(';').filter(s => s.trim()).length > 1 ? db.exec(sql) : db.query(sql, values);
  const pool = { query, async connect() {
    const owner = randomUUID();
    return { async query(sql, values) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) { const key = sql + ':' + values[0], locked = !locks.has(key); if (locked) locks.set(key, owner); return { rows: [{ locked }] }; }
      if (sql.startsWith('SELECT pg_advisory_unlock')) { for (const [key, value] of locks) if (value === owner) locks.delete(key); return { rows: [{}] }; }
      return query(sql, values);
    }, release() { for (const [key, value] of locks) if (value === owner) locks.delete(key); } };
  } };
  const context = vm.createContext({ module: { exports: {} }, URL, Date, Buffer,
    require(name) { if (name === '../db/pool') return pool; return require(name.startsWith('.') ? '../src/web/' + name : name); },
  });
  vm.runInContext(source + '\nmodule.exports.qa={ensureReports,ensureTables,ensureRequests,getReport};', context);
  const api = context.module.exports.qa;
  try {
    await api.ensureTables(); await api.ensureReports(); await api.ensureRequests();
    await db.exec(`ALTER TABLE staff ADD COLUMN approved BOOLEAN DEFAULT true;
      CREATE TABLE orders(id INT PRIMARY KEY,address TEXT,object_name TEXT,owner_name TEXT,contacts TEXT,object_type TEXT,region TEXT,service TEXT,cad_num TEXT,archive_url TEXT,telegram_msg_id BIGINT);
      INSERT INTO orders(id,address,object_name,object_type,region,service) VALUES(60,'Москва, Synthetic, 5','ООО Synthetic','Общепит','МСК','Продление');
      INSERT INTO staff(tg_id,name,role) VALUES(808,'Synthetic lawyer','lawyer');
      INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author) VALUES(9,-100200,80,'{80,81}','Заявка #60','Synthetic manager');
      INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author,reply_to) VALUES(10,-100200,82,'{82}','Reply with a source attachment','Synthetic auditor',80);`);
    const auditIds = Array.from({ length: 105 }, (_, i) => 80 + i);
    await db.query('INSERT INTO audits(id,order_id,chat_id,msg_ids,text,report_data) VALUES(15,60,$1,$2,$3,$4)', [AUDITS, auditIds, 'Full saved audit', { inspection: { service: 'Продление' } }]);
    await db.query('INSERT INTO audits(id,order_id,chat_id,msg_ids,text,report_data) VALUES(16,60,$1,$2,$3,$4)', [CLIENTS, [81,83], 'Additional source report', { inspection: { service: 'Продление' } }]);
    const telegram = {
      async sendMessage(chat, text) { const event = { type: 'card', chat: String(chat), text }; events.push(event); await intercept(event); event.id = sequence++; return { message_id: event.id }; },
      async callApi(method, payload) { assert.equal(method, 'copyMessages'); const event = { type: 'copy', chat: String(payload.chat_id), source: String(payload.from_chat_id), ids: payload.message_ids }; events.push(event); const override = await intercept(event); if (override) return override; event.receipts = payload.message_ids.map(() => ({ message_id: sequence++ })); return event.receipts; },
      async sendDocument() { throw new Error('No manager originals in this synthetic packet'); },
    };
    const packetService = createPacketService({ pool, listMaterials: async () => [], egrnLinks: async () => [], lookupEgrn: async () => ({ status: 'missing' }) });
    const packet = await packetService.packet({ order_id: 60, report_src: 'r', report_id: 9, request_id: 9 });
    const body = { handoff_version: 2, submit_id: randomUUID(), packet_signature: packet.signature, order_id: 60, report_src: 'r', report_id: 9, request_id: 9,
      lawyer_tg_id: 808, org: 'ООО Synthetic', address: 'Москва, Synthetic, 5', region: 'МСК', kind: 'Общепит', service: 'Продление', priority: 'обычный', contacts: [{ name: 'Synthetic client', phone: '+79990000000' }] };
    const options = { pool, packetService, telegram, async loadReport(src, id) { loads++; return api.getReport(src, id); },
      materialDelivery: createHandoffMaterialsDelivery({ telegram, loadMaterials: async () => [] }), pickChecklist: () => 'MSK_OBSH', webappUrl: 'https://example.invalid' };
    const input = { body, user: { id: 101 }, staff: { name: 'Synthetic manager', role: 'manager', approved: true } };
    const cases = async () => (await db.query('SELECT * FROM cases ORDER BY id')).rows;
    await run({ db, api, events, auditIds, cases, input, submit: () => createHandoffSubmitter(options)(input),
      intercept(fn) { intercept = fn; }, loads: () => loads });
    assert.ok(events.every(event => event.chat === LAWYER), 'Only the assigned lawyer receives the packet');
  } finally { await db.close(); }
}

test('request-card handoff forwards all linked audits from their own chats and deduplicates only within the same chat', pg, async () => fixture(async h => {
  const report = await h.api.getReport('r', 9);
  assert.deepEqual(JSON.parse(JSON.stringify(report.sources)), [{ chat_id: -100200, msg_ids: [80,81,82,83] }, { chat_id: -100100, msg_ids: h.auditIds }]);
  const result = await h.submit(); assert.equal(result.delivery_complete, true);
  const copies = h.events.filter(event => event.type === 'copy');
  assert.deepEqual(copies.map(event => [event.source,event.ids.length]), [[CLIENTS,4],[AUDITS,100],[AUDITS,5]]);
  assert.deepEqual(copies.filter(event => event.source === CLIENTS).flatMap(event => event.ids), [80,81,82,83]);
  assert.deepEqual(copies.filter(event => event.source === AUDITS).flatMap(event => event.ids), h.auditIds);
  const cases = await h.cases(); assert.equal(cases.length, 1);
  assert.deepEqual(cases[0].data._handoff.request.copy_ids, []);
  const before = h.events.length; await h.submit(); assert.equal(h.events.length, before); assert.equal(h.loads(), 1);
}));

test('a middle cross-chat delivery failure resumes only the unconfirmed batch from frozen sources', pg, async () => fixture(async h => {
  let rejected = false;
  h.intercept(event => { if (event.source === AUDITS && event.ids.length === 5 && !rejected) { rejected = true; throw explicitFailure(); } });
  const first = await h.submit(); assert.equal(first.delivery_complete, false); assert.equal(first.retry, true);
  const partial = (await h.cases())[0].data._handoff;
  assert.equal(partial.auditCopies[LAWYER].offset, 4); assert.equal(partial.auditCopies[LAWYER].sources[AUDITS].offset, 100);
  await h.db.query('UPDATE audits SET msg_ids=$1 WHERE id=15', [[999]]);
  const before = h.events.length, done = await h.submit(); assert.equal(done.delivery_complete, true); assert.equal(done.id, first.id);
  assert.deepEqual(h.events.slice(before).map(event => [event.source,event.ids]), [[AUDITS,h.auditIds.slice(100)]]);
  assert.equal((await h.cases()).length, 1); assert.equal(h.loads(), 1); assert.equal(h.events.filter(event => event.type === 'card').length, 1);
}));

test('a short receipt for the second chat stops automatic retries while preserving the first chat cursor', pg, async () => fixture(async h => {
  h.intercept(event => event.source === AUDITS ? event.ids.slice(1).map((_, i) => ({ message_id: 3000 + i })) : undefined);
  const first = await h.submit(); assert.equal(first.delivery_complete, false); assert.equal(first.manual_review, true); assert.equal(first.retry, false);
  const saved = (await h.cases())[0].data._handoff;
  assert.equal(saved.auditCopies[LAWYER].offset, 4); assert.equal(saved.auditCopies[LAWYER].sources[AUDITS].offset, 0);
  const before = h.events.length; await h.submit(); assert.equal(h.events.length, before); assert.equal((await h.cases()).length, 1);
}));

test('a stored V2 single-chat cursor without a sources list resumes without repeating its completed prefix', pg, async () => fixture(async h => {
  h.intercept(event => { if (event.type === 'copy' && event.source === CLIENTS) throw explicitFailure(); });
  const first = await h.submit(), row = (await h.cases())[0], state = row.data._handoff;
  delete state.source.sources; state.source.message_ids = [80,81,82,83];
  state.auditCopies[LAWYER] = { offset: 2, messageIds: [2000,2001] };
  await h.db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=$2", [JSON.stringify(state),row.id]);
  h.intercept(() => {}); const before = h.events.length;
  const done = await h.submit(); assert.equal(done.delivery_complete, true); assert.equal(done.id, first.id);
  assert.deepEqual(h.events.slice(before).map(event => [event.source,event.ids]), [[CLIENTS,[82,83]]]);
  assert.equal((await h.cases()).length, 1);
}));
