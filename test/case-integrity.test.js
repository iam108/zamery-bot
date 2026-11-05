const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(require.resolve('../src/web/handoff'), 'utf8');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
const fixedNow = Date.parse('2026-11-05T10:30:00Z');
let currentNow = fixedNow;
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [currentNow])); }
  static now() { return currentNow; }
}
async function fixture(run) {
  currentNow = fixedNow;
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite(), pending = [], routes = new Map(), deliveries = [], locks = new Map();
  let failChat = null, sequence = 1;
  function query(sql, values) {
    const job = values || sql.split(';').filter(value => value.trim()).length < 2 ? db.query(sql, values) : db.exec(sql);
    pending.push(job); return job;
  }
  const pool = { query, async connect() {
    const owner = randomUUID();
    return { async query(sql, values) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) {
        const key = sql.split('(')[1].split(',')[0] + ':' + values[0], locked = !locks.has(key);
        if (locked) locks.set(key, owner);
        return { rows: [{ locked }] };
      }
      if (sql.startsWith('SELECT pg_advisory_unlock')) {
        const key = sql.split('(')[1].split(',')[0] + ':' + values[0];
        if (locks.get(key) === owner) locks.delete(key);
        return { rows: [{}] };
      }
      return query(sql, values);
    }, release() { for (const [key, value] of locks) if (value === owner) locks.delete(key); } };
  } };
  const telegram = { async sendMessage(chat, text) {
    deliveries.push({ chat: String(chat), text });
    if (String(chat) === String(failChat)) throw new Error('Synthetic transport rejection');
    return { message_id: sequence++ };
  } };
  const context = vm.createContext({
    module: { exports: {} }, console: { log() {}, error() {} }, Date: TestDate, URL, URLSearchParams, Buffer,
    process: { env: { CLIENTS_CHAT_ID: '-100321', WEBAPP_URL: 'https://example.invalid', REQUEST_TOKEN: 'synthetic-intake-key' } },
    setTimeout() {}, setInterval() {},
    require(name) {
      if (name === '../db/pool') return pool;
      if (name === '../bot/instance') return { telegram };
      if (name === './handoff-packet') return { setupHandoffPacket() { return {}; } };
      return require(name.startsWith('.') ? '../src/web/' + name : name);
    },
  });
  vm.runInContext(source + '\nmodule.exports.testReminders=sendCaseReminders;module.exports.testReport=addToReports;', context);
  const app = { get(path, ...handlers) { routes.set('GET ' + path, handlers.at(-1)); }, post(path, ...handlers) { routes.set('POST ' + path, handlers.at(-1)); } };
  context.module.exports.setupHandoff(app); context.module.exports.setupRequestsWeb(app);
  await Promise.all(pending); await new Promise(resolve => setImmediate(resolve)); await Promise.all(pending);
  await db.exec("ALTER TABLE staff ADD COLUMN approved BOOLEAN;INSERT INTO staff(tg_id,name,role,approved) VALUES(101,'Manager','manager',true),(808,'Lawyer','lawyer',true),(909,'Auditor','auditor',true);");
  const checklist = Object.keys(require('../src/checklists').LISTS)[0];
  await db.query("INSERT INTO cases(id,org,region,lawyer_tg_id,created_by,checklist_key,data) VALUES(17,'Synthetic client','МСК',808,101,$1,'{}')", [checklist]);
  async function call(path, body, actor = 808, method = 'POST', query = {}) {
    const staff = { name: 'Synthetic', approved: true, role: actor === 101 ? 'manager' : actor === 808 ? 'lawyer' : 'auditor' };
    let status = 200, result;
    const req = { body, query, staff, tgUser: { id: actor }, get: () => '' };
    return new Promise((resolve, reject) => {
      const res = { status(value) { status = value; return this; }, json(value) { result = value; resolve({ status, result }); return this; }, send(value) { result = value; resolve({ status, result }); return this; } };
      Promise.resolve(routes.get(method + ' ' + path)(req, res, reject)).catch(reject);
    });
  }
  try { await run({ db, call, deliveries, reminder: context.module.exports.testReminders, report: context.module.exports.testReport, telegram, fail(chat) { failChat = chat; }, advance(ms) { currentNow += ms; } }); }
  finally { await Promise.allSettled(pending); await db.close(); }
}

test('case access rejects another auditor before viewing, saving, completing reminders or signing print links', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text) VALUES(1,17,'2026-11-05','Synthetic reminder')");
  for (const [path, body, method, query] of [
    ['/checklist/view', {}, 'POST', { case_id: 17 }],
    ['/api/checklist/save', { case_id: 17, expectedRevision: 0, data: { _stage: 'Архив' } }],
    ['/api/checklist/printlink', { case_id: 17 }],
    ['/api/checklist/reminders/done', { id: 1 }],
  ]) {
    const result = await h.call(path, body, 909, method, query);
    assert.equal(result.status, 403, path);
  }
  assert.equal((await h.db.query('SELECT data FROM cases WHERE id=17')).rows[0].data._stage, undefined);
  assert.equal((await h.db.query('SELECT done FROM case_reminders WHERE id=1')).rows[0].done, false);
}));

test('checklist saves reject stale fields while accepting a lost-ack retry and keeping independent Mac notes', pg, async () => fixture(async h => {
  const first = { _stage: 'Сбор документов', first: { s: 'ok' }, _comment: '' };
  const saved = await h.call('/api/checklist/save', { case_id: 17, data: first, expectedRevision: 0, expectedNote: '', done: 1, total: 2 });
  assert.equal(saved.status, 200); assert.equal(saved.result.revision, 1);
  const repeated = await h.call('/api/checklist/save', { case_id: 17, data: first, expectedRevision: 0, expectedNote: '', done: 1, total: 2 });
  assert.equal(repeated.result.ok, true); assert.equal(repeated.result.revision, 1);
  const stale = await h.call('/api/checklist/save', { case_id: 17, data: { _stage: 'Сбор документов', second: { s: 'ok' } }, expectedRevision: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.result.code, 'checklist_conflict');
  await h.db.exec("UPDATE cases SET data=data||'{\"_comment\":\"Mac note\",\"_workspaceNote\":true}' WHERE id=17");
  const fresh = await h.call('/api/checklist/save', { case_id: 17, data: { ...first, second: { s: 'ok' } }, expectedRevision: 1, expectedNote: '', done: 2, total: 2 });
  assert.equal(fresh.result.ok, true);
  const row = (await h.db.query('SELECT data FROM cases WHERE id=17')).rows[0];
  assert.ok(row.data.first); assert.ok(row.data.second); assert.equal(row.data._comment, 'Mac note');
}));

test('invalid dates cannot partially save stage, and valid inspection date edits update SQL deadline atomically', pg, async () => fixture(async h => {
  const bad = await h.call('/api/checklist/save', { case_id: 17, expectedRevision: 0, data: { _stage: 'Подано', _submittedOn: '2026-13-01' } });
  assert.equal(bad.status, 400);
  assert.deepEqual((await h.db.query('SELECT data FROM cases WHERE id=17')).rows[0].data, {});
  const good = await h.call('/api/checklist/save', { case_id: 17, expectedRevision: 0, data: { _stage: 'Подано', _submittedOn: '2026-11-02' } });
  assert.equal(good.result.ok, true);
  const next = await h.call('/api/checklist/save', { case_id: 17, expectedRevision: good.result.revision, data: { _stage: 'Выездная проверка', _submittedOn: '2026-11-05' } });
  assert.equal(next.result.ok, true);
  const row = (await h.db.query('SELECT data,submitted_on::text AS filed,decision_due::text AS due FROM cases WHERE id=17')).rows[0];
  assert.equal(row.filed, '2026-11-05'); assert.equal(row.due, next.result.decisionDue); assert.equal(row.data._decisionDue, row.due);
}));

test('reminder retries target only unacknowledged recipients and never mark all-failed delivery as sent', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.fail(101); await h.reminder({ telegram: h.telegram });
  let row = (await h.db.query('SELECT * FROM case_reminders WHERE id=1')).rows[0];
  assert.equal(row.sent_at, null); assert.ok(row.delivery['808']); assert.equal(row.delivery['101'], undefined);
  h.fail(null); h.advance(10*60*1000); await h.reminder({ telegram: h.telegram });
  row = (await h.db.query('SELECT * FROM case_reminders WHERE id=1')).rows[0];
  assert.ok(row.sent_at);
  assert.equal(h.deliveries.filter(d => d.chat === '808').length, 1);
  assert.equal(h.deliveries.filter(d => d.chat === '101').length, 2);
}));

test('intake delivery retry resumes the same saved request and an explicit submission key rejects changed content', pg, async () => fixture(async h => {
  const body = { token: 'synthetic-intake-key', submission_id: 'qa-row-4', fields: [{ q: 'Организация', a: 'Synthetic object' }] };
  h.fail(-100321);
  assert.equal((await h.call('/api/requests/incoming', body, 0)).status, 503);
  h.fail(null);
  const sent = await h.call('/api/requests/incoming', body, 0);
  assert.equal(sent.result.ok, true);
  const repeated = await h.call('/api/requests/incoming', body, 0);
  assert.equal(repeated.result.id, sent.result.id);
  assert.equal(Number((await h.db.query('SELECT count(*) FROM reports')).rows[0].count), 1);
  const changed = await h.call('/api/requests/incoming', { ...body, fields: [{ q: 'Организация', a: 'Different object' }] }, 0);
  assert.equal(changed.status, 409);
}));

test('live report grouping distinguishes different Telegram authors with the same display name', pg, async () => fixture(async h => {
  await h.report(-100321, 901, 'Client A', 'Shared display name', 808, null, new Date(fixedNow));
  await h.report(-100321, 902, 'Client B', 'Shared display name', 909, null, new Date(fixedNow + 20_000));
  const rows = (await h.db.query('SELECT text FROM reports ORDER BY first_id')).rows;
  assert.equal(rows.length, 2); assert.equal(rows[0].text, 'Client A'); assert.equal(rows[1].text, 'Client B');
}));
