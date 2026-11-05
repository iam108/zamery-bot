'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('../src/web/handoff'), 'utf8');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };

function load(pool) {
  const routes = new Map(), pending = [];
  const context = vm.createContext({ module: { exports: {} }, Buffer, URL, Date,
    console: { error() {}, log() {} }, process: { env: { GROUP_CHAT_ID: '-100100', CLIENTS_CHAT_ID: '-100200' } },
    require(name) {
      if (name === '../db/pool') return pool;
      return require(name.startsWith('.') ? '../src/web/' + name : name);
    },
  });
  vm.runInContext(source + '\nmodule.exports.qa = {ensureTables,ensureReports,parseExport,addToReports,getReport};', context);
  const app = { get(path, ...handlers) { routes.set('GET ' + path, handlers.at(-1)); }, post(path, ...handlers) { routes.set('POST ' + path, handlers.at(-1)); } };
  return { ...context.module.exports.qa, setup() { context.module.exports.setupReportsWeb(app, { array() { return () => {}; } }); }, routes, pending };
}

async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  const pending = [], stagedBatches = []; let failWrite = null, reportAggregations = 0;
  const query = (sql, values) => {
    if (/INSERT INTO report_import_pending/.test(sql)) stagedBatches.push(values[0].length);
    if (/^WITH incoming/.test(sql)) reportAggregations++;
    if (failWrite && failWrite.test(sql)) { failWrite = null; return Promise.reject(new Error('Synthetic write failure')); }
    const result = (!values && sql.split(';').filter(s => s.trim()).length > 1 ? db.exec(sql) : db.query(sql, values)).then(value => {
      if (!Array.isArray(value)) value.rowCount = value.affectedRows;
      return value;
    });
    pending.push(result); return result;
  };
  const pool = { query, async connect() { return { query, release() {} }; } };
  const h = load(pool);
  try {
    await h.ensureTables(); await h.ensureReports(); h.setup();
    await Promise.all(pending); await new Promise(resolve => setImmediate(resolve)); await Promise.all(pending);
    async function importFiles(messages, extraFiles = []) {
      let html;
      const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'zamery-import-db-test-'));
      const supplied = [{ originalname: 'result.json', buffer: Buffer.from(JSON.stringify({ messages })) }, ...extraFiles], files = [];
      for (let index = 0; index < supplied.length; index++) { const file = supplied[index], target = path.join(directory, String(index)); await fsp.writeFile(target, file.buffer); files.push({ originalname: file.originalname, path: target }); }
      const req = Object.assign(new EventEmitter(), { body: { chat: 'zamery' }, files, session: { auth: true }, reportImportWork: { directory, active: new Set(), closing: new Set(), release() {}, abort() {} } });
      await h.routes.get('POST /admin/import')(req, { status() { return this; }, send(value) { html = value; } });
      assert.equal(fs.existsSync(directory), false, 'Every import outcome removes source uploads and prepared runs');
      return html;
    }
    const rows = async () => (await db.query('SELECT * FROM reports ORDER BY first_id')).rows;
    await run({ ...h, db, rows, importFiles, stagedBatches, get reportAggregations() { return reportAggregations; }, failSQL(pattern) { failWrite = pattern; } });
  } finally { await Promise.allSettled(pending); await db.close(); }
}
const msg = (id, text, extra = {}) => ({ id, type: 'message', date: '2026-11-05T10:00:00+03:00', from: 'Synthetic auditor', text, ...extra });

test('a sparse history import preserves unrelated reports and existing case links', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author) VALUES(1,-100100,200,'{200}','Existing report','Earlier author'); INSERT INTO cases(id,request_id) VALUES(7,1); SELECT setval('reports_id_seq',10)");
  const html = await h.importFiles([msg(100, 'Older report'), msg(300, 'Later report', { date: '2026-11-05T11:00:00+03:00' })]);
  assert.match(html, /Готово/);
  assert.equal((await h.rows()).length, 3);
  assert.equal((await h.db.query('SELECT text FROM reports WHERE id=1')).rows[0].text, 'Existing report');
  // Unlinked reports are equally valuable: a partial export must not erase them.
  await h.db.exec('DELETE FROM cases WHERE id=7');
  await h.importFiles([msg(100, 'Older report'), msg(300, 'Later report', { date: '2026-11-05T11:00:00+03:00' })]);
  assert.equal((await h.db.query('SELECT text FROM reports WHERE id=1')).rows[0]?.text, 'Existing report');
}));

test('a partial overlap with a live report imports unseen messages exactly once', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author,author_id) VALUES(1,-100100,100,'{100}','First caption','Synthetic auditor',808)");
  const messages = [msg(100, 'First caption', { from_id: 'user808' }), msg(101, 'Second caption', { from_id: 'user808' })];
  await h.importFiles(messages); await h.importFiles(messages);
  const rows = await h.rows();
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].msg_ids.map(Number), [100, 101]);
  assert.equal(rows[0].text, 'First caption\nSecond caption');
}));

test('overlapping uploaded history files do not duplicate a message or caption', pg, async () => fixture(async h => {
  const messages = [msg(100, 'First caption'), msg(101, 'Second caption')];
  await h.importFiles(messages, [{ originalname: 'messages-again.json', buffer: Buffer.from(JSON.stringify({ messages })) }]);
  const rows = await h.rows();
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].msg_ids.map(Number), [100, 101]);
  assert.equal(rows[0].text, 'First caption\nSecond caption');
}));

test('JSON import distinguishes people with matching display names and separate request cards', pg, async () => fixture(async h => {
  await h.importFiles([msg(100, 'Auditor A', { from_id: 'user808' }), msg(101, 'Auditor B', { from_id: 'user909' }),
    msg(102, '📩 Новая форма заполнена:\nНаименование организации: First', { from_id: 'user909' }),
    msg(103, '📩 Новая форма заполнена:\nНаименование организации: Second', { from_id: 'user909' })]);
  const rows = await h.rows();
  assert.equal(rows.length, 4); assert.equal(rows[0].author_id, 808); assert.equal(rows[1].author_id, 909);
}));

test('a malformed export is rejected before deleting or adding any report', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author) VALUES(1,-100100,200,'{200}','Keep this report','Earlier author')");
  const html = await h.importFiles([msg(100, 'Valid first'), msg(300, 'Invalid later', { date: 'invalid' })]);
  assert.match(html, /Ошибка/); assert.equal((await h.rows()).length, 1);
  assert.equal((await h.rows())[0].text, 'Keep this report');
}));

test('live capture never merges independent request cards or repeats a retried message in another group', pg, async () => fixture(async h => {
  const date = new Date('2026-11-05T10:00:00Z');
  await h.addToReports(-100200, 100, '📩 Новая форма заполнена:\nНаименование организации: First', 'Forms bot', 808, null, date);
  await h.addToReports(-100200, 101, '📩 Новая форма заполнена:\nНаименование организации: Second', 'Forms bot', 808, null, date);
  await h.addToReports(-100200, 102, 'Different sender', 'Someone else', 909, null, date);
  await h.addToReports(-100200, 100, '📩 Новая форма заполнена:\nНаименование организации: First', 'Forms bot', 808, null, date);
  const rows = await h.rows(); assert.equal(rows.length, 3);
  assert.equal(rows.flatMap(row => row.msg_ids.map(Number)).filter(id => id === 100).length, 1);
}));

test('a failed history insert rolls back earlier extensions of an existing report', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO reports(chat_id,first_id,msg_ids,text,author,author_id) VALUES(-100100,100,'{100}','First caption','Synthetic auditor',808)");
  h.failSQL(/^INSERT INTO reports/);
  const html = await h.importFiles([msg(100, 'First caption', { from_id: 'user808' }), msg(101, 'Second caption', { from_id: 'user808' }), msg(300, 'Another report', { from_id: 'user909' })]);
  assert.match(html, /Ошибка/);
  const rows = await h.rows(); assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].msg_ids.map(Number), [100]); assert.equal(rows[0].text, 'First caption');
}));

test('live capture groups consecutive messages using the latest message time and splits after another author', pg, async () => fixture(async h => {
  const time = Date.parse('2026-11-05T10:00:00Z');
  for (let i = 0; i < 3; i++) await h.addToReports(-100100, 100 + i, 'Part ' + i, 'Auditor', 808, null, new Date(time + i * 180000));
  await h.addToReports(-100100, 103, 'Other author', 'Other', 909, null, new Date(time + 370000));
  await h.addToReports(-100100, 104, 'A new report', 'Auditor', 808, null, new Date(time + 380000));
  const rows = await h.rows(); assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].msg_ids.map(Number), [100, 101, 102]); assert.equal(rows[2].text, 'A new report');
}));

test('Telegram export timestamps prefer epoch data and preserve the HTML UTC offset', () => {
  const h = load({});
  const json = h.parseExport(Buffer.from(JSON.stringify({ messages: [msg(1, 'Epoch', { date: 'invalid', date_unixtime: '1793862000', from_id: 'user808', media_group_id: 'album-1' })] })), 'result.json');
  assert.equal(json[0].date.toISOString(), new Date(1793862000000).toISOString()); assert.equal(json[0].authorId, '808'); assert.equal(json[0].mgid, 'album-1');
  const html = h.parseExport(Buffer.from('<div class="message default clearfix" id="message1"><div class="pull_right date details" title="05.11.2026 10:00:00 UTC+05:00"></div><div class="from_name">Auditor</div><div class="text">Caption &amp; detail<br>Line 2</div>'), 'messages.html');
  assert.equal(html[0].date.toISOString(), '2026-11-05T05:00:00.000Z'); assert.equal(html[0].text, 'Caption & detail\nLine 2');
});

test('all fifty disk uploads form one cross-file report and keep captions in global message order',pg,async()=>fixture(async h=>{
  const extras=Array.from({length:49},(_,index)=>({originalname:'messages-'+index+'.json',buffer:Buffer.from(JSON.stringify({messages:[msg(50-index,'Caption '+(50-index))]}))}));
  const html=await h.importFiles([msg(1,'Caption 1')],extras);assert.match(html,/Файлов: 50/);
  const rows=await h.rows();assert.equal(rows.length,1);assert.deepEqual(rows[0].msg_ids.map(Number),Array.from({length:50},(_,index)=>index+1));
  assert.equal(rows[0].text,Array.from({length:50},(_,index)=>'Caption '+(index+1)).join('\n'));
}));

test('an unseen prefix uses the first late overlap, then follows later existing owners without changing case references',pg,async()=>fixture(async h=>{
  await h.db.exec("INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author) VALUES(1,-100100,100,'{100}','Existing A','Auditor'),(2,-100100,120,'{120}','Existing B','Auditor'); INSERT INTO cases(id,request_id) VALUES(7,2); SELECT setval('reports_id_seq',10)");
  await h.importFiles([msg(90,'Unseen prefix'),msg(100,'Existing A'),msg(110,'Unseen A'),msg(120,'Existing B'),msg(130,'Unseen B')]);
  const rows=await h.rows();assert.equal(rows.length,2);assert.deepEqual(rows[0].msg_ids.map(Number),[90,100,110]);assert.equal(rows[0].text,'Existing A\nUnseen prefix\nUnseen A');
  assert.deepEqual(rows[1].msg_ids.map(Number),[120,130]);assert.equal(rows[1].text,'Existing B\nUnseen B');assert.equal(Number((await h.db.query('SELECT request_id FROM cases WHERE id=7')).rows[0].request_id),2);
}));

test('a large continuous group with a late overlap stages bounded batches and updates growing report fields only once',pg,async()=>fixture(async h=>{
  await h.db.exec("INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author) VALUES(1,-100100,3000,'{3000}','Existing anchor','Auditor'); INSERT INTO cases(id,request_id) VALUES(7,1); SELECT setval('reports_id_seq',10)");
  const records=Array.from({length:5000},(_,index)=>msg(index+1,'Caption '+(index+1)+' '+'.'.repeat(400)));
  await h.importFiles(records.slice(0,1000),Array.from({length:4},(_,index)=>({originalname:'messages-'+index+'.json',buffer:Buffer.from(JSON.stringify({messages:records.slice((index+1)*1000,(index+2)*1000)}))})));
  const rows=await h.rows();assert.equal(rows.length,1);assert.equal(rows[0].id,1);assert.equal(rows[0].msg_ids.length,5000);assert.ok(rows[0].text.startsWith('Existing anchor\nCaption 1 '));assert.ok(rows[0].text.endsWith('Caption 5000 '+'.'.repeat(400)));
  assert.ok(h.stagedBatches.length>1);assert.ok(h.stagedBatches.every(size=>size<=500));assert.equal(h.stagedBatches.reduce((sum,size)=>sum+size,0),4999);assert.equal(h.reportAggregations,1);
}));

test('invalid data in the final upload leaves every previously saved report unchanged',pg,async()=>fixture(async h=>{
  await h.db.exec("INSERT INTO reports(id,chat_id,first_id,msg_ids,text,author) VALUES(1,-100100,100,'{100}','Existing anchor','Auditor')");
  const html=await h.importFiles([msg(100,'Existing anchor'),msg(101,'Would extend')],[{originalname:'messages-last.json',buffer:Buffer.from(JSON.stringify({messages:[msg(200,'Invalid',{date:'invalid'})]}))}]);
  assert.match(html,/Ошибка/);const rows=await h.rows();assert.equal(rows.length,1);assert.equal(rows[0].text,'Existing anchor');assert.deepEqual(rows[0].msg_ids.map(Number),[100]);assert.equal(h.stagedBatches.length,0);assert.equal(h.reportAggregations,0);
}));

test('a newly imported album preserves its final message timestamp even when export timestamps go backwards',pg,async()=>fixture(async h=>{
  await h.importFiles([msg(100,'First album part',{media_group_id:'album-1',date:'2026-11-05T10:10:00+03:00'}),msg(101,'Final album part',{media_group_id:'album-1',date:'2026-11-05T10:00:00+03:00'})]);
  const rows=await h.rows();assert.equal(rows.length,1);assert.equal(rows[0].last_message_at.toISOString(),'2026-11-05T07:00:00.000Z');assert.deepEqual(rows[0].msg_ids.map(Number),[100,101]);
}));
