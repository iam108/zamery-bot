'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadReportAggregate, loadReportDescendants } = require('../src/web/legacy-report');
const { createPacketService, setupHandoffPacket } = require('../src/web/handoff-packet');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
const CLIENTS = '-100200', AUDITS = '-100100';
const source = fs.readFileSync(require.resolve('../src/web/handoff'), 'utf8');
const plain = item => JSON.parse(JSON.stringify(item));

async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite(), queries = [];
  const pool = { query(sql, values) {
    queries.push({ sql, values });
    return !values && sql.split(';').filter(part => part.trim()).length > 1 ? db.exec(sql) : db.query(sql, values);
  }, async connect() { return { query: pool.query, release() {} }; } };
  const context = vm.createContext({ module: { exports: {} }, URL, Buffer, Date,
    console: { error() {}, log() {} }, process: { env: { CLIENTS_CHAT_ID: CLIENTS, GROUP_CHAT_ID: AUDITS } },
    require(name) { if (name === '../db/pool') return pool; return require(name.startsWith('.') ? '../src/web/' + name : name); },
  });
  vm.runInContext(source + '\nmodule.exports.qa={ensureTables,ensureReports,ensureRequests,getReport,searchReports};', context);
  const api = context.module.exports.qa;
  try {
    await api.ensureTables(); await api.ensureReports(); await api.ensureRequests();
    await db.exec(`CREATE TABLE orders(id INT PRIMARY KEY,address TEXT,object_name TEXT,telegram_msg_id BIGINT,owner_name TEXT);
      INSERT INTO orders(id,address,object_name,telegram_msg_id) VALUES(60,'Москва, Synthetic, 5','ООО Synthetic',50),(61,'Москва, Other object','ООО Other',51);
      INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author,reply_to) VALUES
      (100,-100200,1000,'{1000,1001}','Заявка #60','manager',NULL),
      (110,-100200,1100,'{1100,1101}','Direct auditor report','auditor',1001),
      (120,-100200,1200,'{1200,1201}','','auditor',1101),
      (130,-100200,1300,'{1300}','Corrected door dimensions','auditor',1201),
      (140,-100200,1400,'{1400}','Unrelated same-chat report','other',9999),
      (150,-100200,1500,'{1500,1600}','Reachable branch','auditor',1100),
      (160,-100200,1600,'{1600,1700}','Self-loop from old duplicate ID','auditor',1600),
      (170,-100200,1700,'{1800}','Branch descendant','auditor',1700),
      (180,-100200,1800,'{1100}','Cycle back to ancestor','auditor',1800),
      (200,-100100,2200,'{2200}','','auditor',2101),
      (210,-100100,2300,'{2300}','GROUP correction','auditor',2200),
      (400,-100100,4000,'{4000}','Bound to another order','auditor',51),
      (401,-100200,4010,'{4010}','Unrelated clients-chat reply','client',51),
      (500,-100200,5000,'{5000}','Unlinked legacy report','auditor',NULL),
      (510,-100200,5100,'{5100}','Unlinked descendant','auditor',5000),
      (999,-100999,1100,'{9990}','Foreign-chat coincidental message IDs','other',1101);
      INSERT INTO audits(id,order_id,chat_id,msg_ids,text,report_data) VALUES
      (15,60,-100100,'{2100,2101}','Saved cross-chat audit','{"inspection":{"service":"Продление"}}'),
      (16,61,-100100,'{2500}','Other order audit','{"inspection":{"service":"Получение"}}');
      INSERT INTO cases(id,order_id,lawyer_tg_id,created_by,data) VALUES(60,60,808,101,'{"_handoff":{"body":{"report_src":"r","report_id":500}}}');`);
    const options = { pool, workingChatId: AUDITS, evidenceStore: {}, listMaterials: async () => [], listEgrnLinks: async () => [], lookupEgrn: async () => ({ status: 'missing' }) };
    const service = createPacketService(options), routes = new Map();
    setupHandoffPacket({ get(path, handler) { routes.set(path, handler); } }, { pool, service });
    async function packetRoute(query) {
      let result, status = 200;
      await routes.get('/api/handoff/packet')({ query, tgUser: { id: 808 }, staff: { role: 'lawyer', approved: true } }, {
        set() { return this; }, status(value) { status = value; return this; }, json(value) { result = value; },
      });
      return { status, result };
    }
    let onMessage;
    context.module.exports.setupReportsBot({ action() {}, on(event, handler) { if (event === 'message') onMessage = handler; } });
    await run({ db, pool, api, service, packetRoute, queries,
      async capture(message) { await onMessage({ chat: { id: Number(CLIENTS) }, from: { id: 808, first_name: 'Synthetic auditor' }, message }, () => Promise.resolve()); } });
  } finally { await db.close(); }
}

test('one recursive aggregate keeps nested photo/audio message IDs and linked audit replies in their actual chats', pg, async () => fixture(async h => {
  const aggregate = await loadReportAggregate(h.pool,100), report = await h.api.getReport('r',100);
  const packet = await h.service.packet({ order_id: 60, report_src: 'r', report_id: 100 });
  assert.equal(report.text,aggregate.text); assert.equal(packet.report.text,aggregate.text);
  assert.match(aggregate.text,/Corrected door dimensions/); assert.match(aggregate.text,/GROUP correction/);
  assert.equal(aggregate.linked,10); assert.equal(report.linked,10); assert.equal(packet.report.linked,10);
  assert.deepEqual(plain(report.sources),[
    { chat_id: -100200, msg_ids: [1000,1001,1100,1101,1200,1201,1300,1500,1600,1700,1800] },
    { chat_id: -100100, msg_ids: [2100,2101,2200,2300] },
  ]);
  assert.doesNotMatch(report.text,/Foreign-chat|Unrelated same-chat|Other order audit/);
  assert.equal(report.metadata.service,'Продление'); assert.equal(packet.report.order_id,60);
  const again = await h.api.getReport('r',100); assert.deepEqual(plain(again.sources),plain(report.sources)); assert.equal(again.text,report.text);
}));

test('recursive descendants terminate cycles, deduplicate reports reached through multiple seeds and never cross a chat edge', pg, async () => fixture(async h => {
  const root = (await h.db.query('SELECT * FROM reports WHERE id=100')).rows[0];
  const audits = (await h.db.query('SELECT * FROM audits WHERE id=15')).rows;
  const replies = await loadReportDescendants(h.pool,root,audits.concat(audits));
  assert.deepEqual(replies.map(row => row.id),[110,120,130,150,160,170,180,200,210]);
  assert.equal(new Set(replies.map(row => row.id)).size,replies.length);
  assert.ok(replies.every(row => [CLIENTS,AUDITS].includes(String(row.chat_id))));
}));

test('a requested order cannot seed audits for an unlinked legacy root and its exact saved handoff remains the access authority', pg, async () => fixture(async h => {
  const packet = await h.service.packet({ order_id: 60, report_src: 'r', report_id: 500 });
  assert.equal(packet.order.id,60); assert.equal(packet.report.order_id,null);
  assert.equal(packet.report.text,'Unlinked legacy report\n\nUnlinked descendant'); assert.equal(packet.report.linked,1);
  const report = await h.api.getReport('r',500);
  assert.deepEqual(plain(report.sources),[{ chat_id: -100200, msg_ids: [5000,5100] }]);
  assert.doesNotMatch(report.text,/Saved cross-chat audit|GROUP correction/);
  assert.equal((await h.packetRoute({ order_id: 60, report_src: 'r', report_id: 500 })).status,200);
  await h.db.exec("UPDATE cases SET data='{\"_handoff\":{\"body\":{\"report_src\":\"r\",\"report_id\":510}}}' WHERE id=60");
  assert.equal((await h.packetRoute({ order_id: 60, report_src: 'r', report_id: 500 })).status,403);
}));

test('server-side legacy order binding rejects a conflicting requested order before case authorization', pg, async () => fixture(async h => {
  const bound = await loadReportAggregate(h.pool,400,{workingChatId:AUDITS}); assert.equal(bound.order_id,61);
  const before = h.queries.length;
  const result = await h.packetRoute({ order_id: 60, report_src: 'r', report_id: 400 });
  assert.equal(result.status,409); assert.equal(result.result.code,'REPORT_ORDER_MISMATCH');
  assert.ok(h.queries.slice(before).some(call => call.sql.startsWith('SELECT id FROM orders WHERE telegram_msg_id=')));
  assert.ok(!h.queries.slice(before).some(call => call.sql.startsWith('SELECT * FROM cases WHERE order_id=')));
  assert.equal((await h.packetRoute({ report_src: 'r', report_id: 400 })).status,403);
}));

test('a coincidental reply message ID in the clients chat cannot bind a legacy report to an order card in the working chat',pg,async()=>fixture(async h=>{
  const before=h.queries.length,aggregate=await loadReportAggregate(h.pool,401,{workingChatId:AUDITS});assert.equal(aggregate.order_id,null);assert.equal(aggregate.text,'Unrelated clients-chat reply');
  assert.ok(!h.queries.slice(before).some(call=>call.sql.startsWith('SELECT id FROM orders WHERE telegram_msg_id=')));
  const report=await h.api.getReport('r',401);assert.equal(report.order_id,null);assert.equal(report.linked,0);
  const packet=await h.service.packet({order_id:60,report_src:'r',report_id:401});assert.equal(packet.report.order_id,null);assert.equal(packet.report.text,'Unrelated clients-chat reply');assert.equal((await h.packetRoute({order_id:60,report_src:'r',report_id:401})).status,403);
}));

test('reply-based legacy binding requires a configured working chat rather than guessing across all chats',pg,async()=>fixture(async h=>{
  assert.equal((await loadReportAggregate(h.pool,400,{workingChatId:''})).order_id,null);
  assert.equal((await loadReportAggregate(h.pool,400,{workingChatId:AUDITS})).order_id,61);
  assert.equal((await loadReportAggregate(h.pool,100,{workingChatId:''})).order_id,60,'An explicit persisted card number retains its existing server relation');
}));

test('legacy report search does not borrow another chat order address or inferred order ID from a coincidental reply number',pg,async()=>fixture(async h=>{
  const results=await h.api.searchReports('Other object');assert.ok(results.some(item=>item.src==='r'&&item.id===400));assert.ok(!results.some(item=>item.src==='r'&&item.id===401));
  const ownText=await h.api.searchReports('Unrelated clients-chat reply');assert.equal(ownText.find(item=>item.src==='r'&&item.id===401).order_id,null);
}));

test('live Telegram capture retains captionless audio, voice, video notes and animation replies for the recursive packet', pg, async () => fixture(async h => {
  for (const [index,media] of ['audio','voice','video_note','animation'].entries()) {
    await h.capture({ message_id: 3000+index, date: 1793862000+index, [media]: { file_id: 'synthetic-'+media }, reply_to_message: { message_id: index ? 3000+index-1 : 1101 } });
  }
  const report = await h.api.getReport('r',100);
  assert.ok([3000,3001,3002,3003].every(id => report.sources[0].msg_ids.includes(id)));
  assert.equal(report.linked,14);
}));
