'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createHandoffSubmitter } = require('../src/web/handoff-submit');
const { createHandoffMaterialsDelivery } = require('../src/web/handoff-materials');
const { createPacketService } = require('../src/web/handoff-packet');
const { createOrderEgrnLinks } = require('../src/web/order-egrn-links');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
const LAWYER = '808', SOURCE = '-1001111111111', CLIENTS = '-1002222222222';
const explicit = (description = 'Synthetic explicit Telegram rejection', code = 400) => Object.assign(new Error(description), { response: { error_code: code, description } });

async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  const events = [], locks = new Map(), storedId = randomUUID();
  let sequence = 900, signed = 0, packetCalls = 0, paidCalls = 0, beforeSend, beforeWrite, beforeResolve;
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);
    INSERT INTO staff VALUES(808,'Юрист проверки','lawyer',true);
    CREATE TABLE orders(id INT PRIMARY KEY,address TEXT,object_name TEXT,object_type TEXT,cad_num TEXT,service TEXT,telegram_msg_id BIGINT);
    INSERT INTO orders VALUES(60,'Москва, Лесная, 5','ООО Проверка','Общепит','77:01:0004016:1064','Продление',50);
    CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,text TEXT,report_data JSONB,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE cases(id SERIAL PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,checklist_key TEXT,org TEXT,inn TEXT,client TEXT,phone TEXT,address TEXT,region TEXT,kind TEXT,service TEXT,priority TEXT,comment TEXT,audit_text TEXT,total INT,created_by BIGINT,contacts JSONB,request_id INT,data JSONB DEFAULT '{}');
    CREATE TABLE egrn_orders(id INT PRIMARY KEY,file_msgs JSONB);
    CREATE TABLE egrn_files(id UUID PRIMARY KEY,name TEXT,mime TEXT,bytes BIGINT,sha256 TEXT);`);
  await db.query('INSERT INTO audits(id,order_id,text,report_data,chat_id,msg_ids) VALUES(15,60,$1,$2,$3,$4)', ['Полный отчёт аудитора', { workflow: { conclusion_status: 'actions' } }, SOURCE, [101,102]]);
  const query = async (sql, params) => {
    if (sql.startsWith('UPDATE cases SET data=') && beforeWrite) await beforeWrite(JSON.parse(params[0]));
    return params ? db.query(sql, params) : db.exec(sql).then(result => result.at(-1));
  };
  const pool = { query, async connect() {
    const owner = randomUUID();
    return { async query(sql, params) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) { const key = params[0], available = !locks.has(key) || locks.get(key) === owner; if (available) locks.set(key, owner); return { rows: [{ locked: available }] }; }
      if (sql.startsWith('SELECT pg_advisory_unlock')) { if (locks.get(params[0]) === owner) locks.delete(params[0]); return { rows: [] }; }
      return query(sql, params);
    }, release() { for (const [key, value] of locks) if (value === owner) locks.delete(key); } };
  } };
  const stored = { id: storedId, egrn_order_id: 9, name: 'Большая выписка.pdf', mime: 'application/pdf', bytes: 350 * 1024 * 1024, sha256: 'f'.repeat(64) };
  const native = { chat: SOURCE, id: 77, name: 'Оригинал Telegram.pdf', mime: 'application/pdf', bytes: 35 * 1024 * 1024, file_id: 'PRIVATE_NATIVE_FILE', key: 'exact-native-original' };
  const records = [{ kind: 'link', original_id: storedId, key: 'exact-stored-original', chat: SOURCE, id: 78 }, native];
  await db.query('INSERT INTO egrn_orders VALUES(9,$1)', [JSON.stringify(records)]);
  await db.query('INSERT INTO egrn_files VALUES($1,$2,$3,$4,$5)', [storedId, stored.name, stored.mime, stored.bytes, stored.sha256]);
  const links = createOrderEgrnLinks({ pool, files: { async ensure() {}, async get(id) { return id === storedId ? stored : null; }, chunks() { assert.fail('A large original must not be read or copied into a ZIP'); } }, makeUrl(id) { return 'https://bot.example/egrn-files/' + id + '/download?fresh=' + (++signed); } });
  await links.register({ id: 9, deliver: [{ order_id: 60, chat: Number(CLIENTS) }] }, records);
  const material = { id: randomUUID(), name: 'Заявка.pdf', mime: 'application/pdf', role: 'document', buffer: Buffer.from('%PDF-1.7 complete manager original') };
  material.bytes = material.buffer.length; material.sha256 = createHash('sha256').update(material.buffer).digest('hex');
  const { buffer, ...metadata } = material;
  const service = createPacketService({ pool, listMaterials: async () => [metadata], listEgrnLinks: order => links.list(order), lookupEgrn: async () => ({ status: 'missing' }) });
  const packet = await service.packet({ order_id: 60, report_src: 'a', report_id: 15 });
  const nativeId = packet.egrn_links.find(file => file.source === 'telegram').id;
  async function action(event) { events.push(event); if (beforeSend) await beforeSend(event); event.receipt = sequence++; return { message_id: event.receipt }; }
  const telegram = {
    sendMessage(chat, text, opts) { return action({ type: opts.reply_to_message_id ? 'link' : 'card', chat: String(chat), text, opts }); },
    async callApi(method, payload) { if (method === 'copyMessages') { const result = await action({ type: 'audit', chat: String(payload.chat_id), payload }); return payload.message_ids.map((_, i) => ({ message_id: result.message_id + i })); } assert.equal(method, 'copyMessage'); return action({ type: 'native', chat: String(payload.chat_id), payload }); },
    async sendDocument(chat, file, opts) { if (typeof file === 'string') return action({ type: 'native-fallback', chat: String(chat), file, opts }); const chunks = []; for await (const chunk of file.source) chunks.push(Buffer.from(chunk)); return action({ type: 'zip', chat: String(chat), bytes: Buffer.concat(chunks), opts }); },
  };
  const options = { pool, ready: async () => {}, packetService: { async packet() { packetCalls++; return structuredClone(packet); } }, telegram, webappUrl: 'https://bot.example', pickChecklist: () => 'QA', clientsChatId: CLIENTS,
    loadReport: async () => (await db.query('SELECT * FROM audits WHERE id=15')).rows[0],
    materialDelivery: createHandoffMaterialsDelivery({ telegram, loadMaterials: async () => [material] }),
    async resolveEgrnLinkForDelivery(order, id, expected) { if (beforeResolve) await beforeResolve({ order, id, expected }); return links.delivery(order, id, expected); },
    async attachEgrn() { paidCalls++; return { result: 'none' }; },
  };
  const body = { handoff_version: 2, submit_id: randomUUID(), packet_signature: packet.signature, order_id: 60, report_src: 'a', report_id: 15, lawyer_tg_id: Number(LAWYER), org: 'ООО Проверка', address: 'Москва, Лесная, 5', region: 'МСК', kind: 'Общепит', service: 'Продление', priority: 'обычный', cad_num: '77:01:0004016:1064', contacts: [{ name: 'Клиент' }], egrn_order: true };
  const context = { body, user: { id: 101 }, staff: { name: 'Менеджер', role: 'manager', approved: true } };
  const row = async () => (await db.query('SELECT * FROM cases ORDER BY id')).rows;
  try { await run({ db, packet, native, stored, storedId, nativeId, records, events, options, context, service, links, row, submit: () => createHandoffSubmitter(options)(context), signed: () => signed, packetCalls: () => packetCalls, paidCalls: () => paidCalls,
    failSend(fn) { beforeSend = fn; }, failWrite(fn) { beforeWrite = fn; }, onResolve(fn) { beforeResolve = fn; },
    async saveState(state) { const c = (await row())[0]; await db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=$2", [JSON.stringify(state), c.id]); },
  }); assert.ok(events.every(event => event.chat === LAWYER), 'The full handoff must use only the assigned lawyer private chat'); }
  finally { await db.close(); }
}

test('reviewed >200MB stored and medium Telegram originals join the complete private handoff without lookup or paid orders', pg, () => fixture(async h => {
  const result = await h.submit(); assert.equal(result.delivery_complete, true); assert.match(result.warn, /доставлены юристу/);
  assert.equal(h.paidCalls(), 0); assert.deepEqual(h.events.map(event => event.type), ['card','audit','zip','link','native']);
  assert.equal(h.events.find(event => event.type === 'zip').bytes.includes(Buffer.from('complete manager original')), true);
  const link = h.events.find(event => event.type === 'link'); assert.match(link.text, /Большая выписка/);
  assert.match(link.opts.reply_markup.inline_keyboard[0][0].url, /fresh=1$/);
  assert.equal(link.opts.reply_markup.inline_keyboard[1][0].callback_data, 'egf:' + h.storedId);
  assert.equal(h.signed(), 1); assert.equal(String(h.events.find(event => event.type === 'native').payload.from_chat_id), SOURCE);
  assert.equal(h.events.find(event => event.type === 'native').payload.message_id, 77);
  const state = (await h.row())[0].data._handoff;
  assert.ok(state.linkedEgrn.confirmed[LAWYER][h.storedId].message_id > 0); assert.ok(state.linkedEgrn.confirmed[LAWYER][h.nativeId].message_id > 0);
  assert.doesNotMatch(JSON.stringify(state), /fresh=|PRIVATE_NATIVE_FILE/);
  const count = h.events.length; await h.submit(); assert.equal(h.events.length, count); assert.equal(h.packetCalls(), 1); assert.equal((await h.row()).length, 1);
}));

test('explicit failure in the middle resumes only missing linked originals, with no new client or manager ZIP', pg, () => fixture(async h => {
  let failed = false; h.failSend(event => { if (event.type === 'native' && !failed) { failed = true; throw explicit(); } });
  const first = await h.submit(); assert.equal(first.delivery_complete, false); assert.equal(first.retry, true);
  const checkpoint = (await h.row())[0].data._handoff; assert.ok(checkpoint.linkedEgrn.confirmed[LAWYER][h.storedId]); assert.equal(checkpoint.linkedEgrn.confirmed[LAWYER][h.nativeId], undefined);
  const count = h.events.length; const result = await h.submit(); assert.equal(result.delivery_complete, true); assert.equal(result.id, first.id);
  assert.deepEqual(h.events.slice(count).map(event => event.type), ['native']); assert.equal(h.signed(), 1); assert.equal(h.paidCalls(), 0); assert.equal((await h.row()).length, 1);
}));

test('a rejected stored-link message is retried with a fresh URL rather than the reviewed or previously signed URL', pg, () => fixture(async h => {
  let failed = false; h.failSend(event => { if (event.type === 'link' && !failed) { failed = true; throw explicit(); } });
  h.packet.egrn_links[0].url = 'https://expired.invalid/old-signature';
  assert.equal((await h.submit()).delivery_complete, false); assert.equal((await h.submit()).delivery_complete, true);
  const links = h.events.filter(event => event.type === 'link'); assert.equal(links.length, 2);
  assert.match(links[0].opts.reply_markup.inline_keyboard[0][0].url, /fresh=1$/); assert.match(links[1].opts.reply_markup.inline_keyboard[0][0].url, /fresh=2$/);
  assert.equal(h.paidCalls(), 0);
}));

test('deleted Telegram source uses its exact server-held native file ID, while unrelated rejection never falls back', pg, () => fixture(async h => {
  h.failSend(event => { if (event.type === 'native') throw explicit('Bad Request: message to copy not found'); });
  assert.equal((await h.submit()).delivery_complete, true);
  const fallback = h.events.find(event => event.type === 'native-fallback'); assert.equal(fallback.file, h.native.file_id); assert.equal(fallback.opts.caption, h.native.name);
  const state = (await h.row())[0].data._handoff; delete state.linkedEgrn.confirmed[LAWYER][h.nativeId]; state.completed = false; state.linkedEgrn.completed = false; await h.saveState(state);
  h.failSend(event => { if (event.type === 'native') throw explicit('Bad Request: chat not found'); });
  const count = h.events.length, result = await h.submit(); assert.equal(result.delivery_complete, false); assert.equal(result.retry, true);
  assert.deepEqual(h.events.slice(count).map(event => event.type), ['native']);
}));

test('a lost receipt or unknown Telegram result blocks blind resend and never reports the package complete', pg, () => fixture(async h => {
  h.failWrite(state => { if (state.linkedEgrn.confirmed[LAWYER]?.[h.storedId]) throw new Error('Synthetic database receipt failure'); });
  const first = await h.submit(); assert.equal(first.delivery_complete, false); assert.equal(first.manual_review, true); assert.equal(first.retry, false);
  h.failWrite(null); const count = h.events.length;
  const result = await h.submit(); assert.equal(result.delivery_complete, false); assert.equal(result.manual_review, true); assert.equal(h.events.length, count);
  assert.equal((await h.row())[0].data._handoff.inflight.original_id, h.storedId); assert.equal(h.paidCalls(), 0);
}));

test('a changed reviewed original is a visible partial delivery and cannot trigger cached lookup or a new order', pg, () => fixture(async h => {
  h.onResolve(() => { h.stored.bytes++; });
  const result = await h.submit(); assert.equal(result.delivery_complete, false); assert.equal(result.retry, true); assert.match(result.warn, /ещё не доставлена/);
  assert.equal(h.events.filter(event => ['link','native'].includes(event.type)).length, 0); assert.equal(h.paidCalls(), 0);
}));

test('old completed checkpoints with omitted reviewed links are repairable without restarting confirmed audit, card or ZIP', pg, () => fixture(async h => {
  await h.submit(); const c = (await h.row())[0], old = c.data._handoff;
  delete old.linkedEgrn; old.egrn = { completed: true, result: 'none', note: 'Готовая выписка не найдена.' }; old.completed = true; await h.saveState(old);
  const before = await h.service.packet({ order_id: 60, report_src: 'a', report_id: 15 }); assert.equal(before.assignment.delivery_complete, false);
  const count = h.events.length; const result = await createHandoffSubmitter(h.options)({ ...h.context, body: { resume_case_id: c.id } });
  assert.equal(result.delivery_complete, true); assert.equal(result.id, c.id); assert.deepEqual(h.events.slice(count).map(event => event.type), ['link','native']);
  assert.equal((await h.row()).length, 1); assert.equal(h.paidCalls(), 0);
  const after = await h.service.packet({ order_id: 60, report_src: 'a', report_id: 15 }); assert.equal(after.assignment.delivery_complete, true);
  const countAfter = h.events.length; await h.submit(); assert.equal(h.events.length, countAfter);
}));

test('old exact per-recipient original receipts migrate without duplicate delivery; shared-chat receipts cannot stand in for private receipts', pg, () => fixture(async h => {
  await h.submit(); const old = (await h.row())[0].data._handoff; delete old.linkedEgrn;
  old.egrn = { completed: true, result: 'attached', copies: { [JSON.stringify([LAWYER,'exact-stored-original'])]: true, [JSON.stringify([CLIENTS,'exact-native-original'])]: true } };
  await h.saveState(old); const count = h.events.length;
  assert.equal((await h.submit()).delivery_complete, true); assert.deepEqual(h.events.slice(count).map(event => event.type), ['native']);
  const state = (await h.row())[0].data._handoff; assert.equal(state.linkedEgrn.confirmed[LAWYER][h.storedId].legacy_receipt, JSON.stringify([LAWYER,'exact-stored-original']));
  assert.equal(h.paidCalls(), 0);
}));

test('an unknown linked-message ACK remains visible and cannot be automatically sent again', pg, () => fixture(async h => {
  h.failSend(event => { if (event.type === 'link') throw new Error('Synthetic lost Telegram ACK'); });
  const first = await h.submit(); assert.equal(first.delivery_complete, false); assert.equal(first.manual_review, true); assert.equal(first.retry, false);
  const count = h.events.length; h.failSend(null); const retry = await h.submit();
  assert.equal(retry.delivery_complete, false); assert.equal(retry.manual_review, true); assert.equal(h.events.length, count); assert.equal(h.paidCalls(), 0);
}));

test('native source absence without a matching original file ID stays partial instead of inventing a private download link', pg, () => fixture(async h => {
  await h.db.query('UPDATE egrn_orders SET file_msgs=$1 WHERE id=9', [JSON.stringify([h.records[0]])]);
  h.failSend(event => { if (event.type === 'native') throw explicit('Bad Request: message to copy not found'); });
  const result = await h.submit(); assert.equal(result.delivery_complete, false); assert.equal(result.retry, true);
  assert.equal(h.events.filter(event => event.type === 'native-fallback').length, 0); assert.equal(h.paidCalls(), 0);
}));

test('concurrent recovery of linked originals keeps one recipient copy under the existing handoff lock', pg, () => fixture(async h => {
  let start, release; const started = new Promise(resolve => { start = resolve; }), wait = new Promise(resolve => { release = resolve; });
  h.failSend(async event => { if (event.type === 'link') { start(); await wait; } });
  const first = h.submit(); await started; const concurrent = await h.submit();
  assert.equal(concurrent.delivery_complete, false); assert.equal(concurrent.retry, true);
  release(); assert.equal((await first).delivery_complete, true);
  assert.equal(h.events.filter(event => event.type === 'link').length, 1); assert.equal(h.events.filter(event => event.type === 'native').length, 1); assert.equal((await h.row()).length, 1);
}));
