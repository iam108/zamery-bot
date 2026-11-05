'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
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
  const pending = []; let failWrite = null;
  const query = (sql, values) => {
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
      const files = [{ originalname: 'result.json', buffer: Buffer.from(JSON.stringify({ messages })) }, ...extraFiles];
      await h.routes.get('POST /admin/import')({ body: { chat: 'zamery' }, files, session: { auth: true } }, { send(value) { html = value; } });
      return html;
    }
    const rows = async () => (await db.query('SELECT * FROM reports ORDER BY first_id')).rows;
    await run({ ...h, db, rows, importFiles, failSQL(pattern) { failWrite = pattern; } });
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
