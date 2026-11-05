'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(require.resolve('../src/web/handoff'), 'utf8');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
const fixedNow = Date.parse('2026-11-05T10:30:00Z');
class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedNow])); } static now() { return fixedNow; } }
async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite(), locks = new Map(), deliveries = [];
  let scheduledTick, mutation = () => {}, failure = null, sequence = 1;
  const query = async (sql, values) => {
    const result = !values && sql.split(';').filter(s => s.trim()).length > 1 ? await db.exec(sql) : await db.query(sql, values);
    if (!Array.isArray(result)) result.rowCount = result.affectedRows;
    for (const row of result.rows || []) for (const key of Object.keys(row)) if (row[key] instanceof Date) row[key] = new TestDate(row[key].getTime());
    return result;
  };
  const pool = { query, async connect() { const owner = randomUUID(); return {
    async query(sql, values) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) { const key = sql + ':' + values[0], locked = !locks.has(key); if (locked) locks.set(key, owner); return { rows: [{ locked }] }; }
      if (sql.startsWith('SELECT pg_advisory_unlock')) { for (const [key,value] of locks) if (value === owner) locks.delete(key); return { rows: [{}] }; }
      return query(sql, values);
    }, release() { for (const [key,value] of locks) if (value === owner) locks.delete(key); },
  }; } };
  const telegram = { async sendMessage(chat, text) {
    const event = { chat: String(chat), text }; deliveries.push(event); await mutation(event);
    if (failure === String(chat)) throw Object.assign(new Error('Synthetic explicit rejection'), { response: { error_code: 400 } });
    event.id = sequence++; return { message_id: event.id };
  } };
  const context = vm.createContext({ module: { exports: {} }, Date: TestDate, console: { error() {}, log() {} }, process: { env: { CLIENTS_CHAT_ID: '-100200', WEBAPP_URL: 'https://example.invalid' } },
    setTimeout(fn) { scheduledTick = fn; }, setInterval() {}, require(name) { if (name === '../db/pool') return pool; return require(name.startsWith('.') ? '../src/web/' + name : name); },
  });
  vm.runInContext(source + '\nmodule.exports.qa={ensureTables,ensureDeadlines,startDecisionReminders,sendCaseReminders};', context);
  const api = context.module.exports.qa;
  try {
    await api.ensureTables(); await api.ensureDeadlines(); api.startDecisionReminders({ telegram });
    await db.exec("INSERT INTO cases(id,org,lawyer_tg_id,lawyer_name,created_by,data,submitted_on,decision_due) VALUES(17,'Synthetic client',808,'Synthetic lawyer',101,'{\"_stage\":\"Подано\"}','2026-10-15','2026-11-05')");
    await run({ db, deliveries, tick: () => scheduledTick(), reminders: () => api.sendCaseReminders({ telegram }), fail(chat) { failure = chat == null ? null : String(chat); }, mutate(fn) { mutation = fn; }, row: async () => (await db.query('SELECT * FROM cases WHERE id=17')).rows[0] });
  } finally { await db.close(); }
}

test('failed decision DM retries the same day without repeating the confirmed group notice', pg, async () => fixture(async h => {
  h.fail(808); await h.tick(); assert.equal((await h.row()).reminded_on, null);
  h.fail(null); await h.tick(); assert.ok((await h.row()).reminded_on);
  assert.equal(h.deliveries.filter(event => event.chat === '808').length, 2);
  assert.equal(h.deliveries.filter(event => event.chat === '-100200').length, 1);
}));

test('failed initial decision group notice retries without repeating the confirmed lawyer DM', pg, async () => fixture(async h => {
  h.fail(-100200); await h.tick(); assert.equal((await h.row()).reminded_on, null);
  h.fail(null); await h.tick(); assert.ok((await h.row()).reminded_on);
  assert.equal(h.deliveries.filter(event => event.chat === '808').length, 1);
  assert.equal(h.deliveries.filter(event => event.chat === '-100200').length, 2);
}));

test('decision completion during a delivery prevents the next stale notification and deadline checkpoint', pg, async () => fixture(async h => {
  h.mutate(async event => { if (event.chat === '808') await h.db.exec("UPDATE cases SET data='{\"_stage\":\"Решение получено\"}' WHERE id=17"); });
  await h.tick(); assert.deepEqual(h.deliveries.map(event => event.chat), ['808']); assert.equal((await h.row()).reminded_on, null);
}));

test('overlapping decision ticks cannot send the same daily reminder twice', pg, async () => fixture(async h => {
  let started, release, held = false;
  const sending = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  h.mutate(async event => { if (event.chat === '808' && !held) { held = true; started(); await gate; } });
  const first = h.tick(); await sending; await h.tick(); release(); await first;
  assert.equal(h.deliveries.filter(event => event.chat === '808').length, 1);
  assert.equal(h.deliveries.filter(event => event.chat === '-100200').length, 1);
}));

test('marking a case reminder done during its first delivery prevents sending its remaining recipient', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.mutate(async event => { if (event.chat === '808') await h.db.exec('UPDATE case_reminders SET done=true WHERE id=1'); });
  await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat), ['808']);
}));
