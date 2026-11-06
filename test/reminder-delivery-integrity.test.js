'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(require.resolve('../src/web/handoff'), 'utf8');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };
const fixedNow = Date.parse('2026-11-05T10:30:00Z');
const isRecipientLookup = sql => sql.startsWith('SELECT to_jsonb(c) AS access_case');
let currentNow = fixedNow;
class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [currentNow])); } static now() { return currentNow; } }
async function fixture(run) {
  currentNow = fixedNow;
  const reminderModule = require('../src/web/reminder-delivery');
  let reminderDelivery = { ...reminderModule, ...reminderModule.createReminderDelivery() };
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite(), locks = new Map(), deliveries = [];
  let scheduledTick, mutation = () => {}, failure = null, sequence = 1, rejectWrite = null, beforeQuery = null;
  const query = async (sql, values) => {
    if (beforeQuery) await beforeQuery(sql,values);
    if (rejectWrite && rejectWrite(sql,values)) throw new Error('Synthetic lost receipt storage');
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
    setTimeout(fn) { scheduledTick = fn; }, setInterval() {}, require(name) {
      if (name === '../db/pool') return pool;
      if (name === './reminder-delivery') return reminderDelivery;
      if (name === '../bot/instance') return { telegram };
      if (name === './handoff-packet') return { setupHandoffPacket() {} };
      return require(name.startsWith('.') ? '../src/web/' + name : name);
    },
  });
  vm.runInContext(source + '\nmodule.exports.qa={ensureTables,ensureDeadlines,startDecisionReminders,sendCaseReminders};', context);
  const api = context.module.exports.qa;
  try {
    await api.ensureTables(); await api.ensureDeadlines(); api.startDecisionReminders({ telegram });
    await db.exec("ALTER TABLE staff ADD COLUMN approved BOOLEAN; INSERT INTO staff(tg_id,name,role,approved) VALUES(808,'Synthetic lawyer','lawyer',true),(909,'Replacement lawyer','lawyer',true),(101,'Synthetic manager','manager',true),(102,'Other manager','manager',true); INSERT INTO cases(id,org,lawyer_tg_id,lawyer_name,created_by,data,submitted_on,decision_due) VALUES(17,'Synthetic client',808,'Synthetic lawyer',101,'{\"_stage\":\"Подано\"}','2026-10-15','2026-11-05')");
    const routes = new Map();
    context.module.exports.setupHandoff({ get(path,...handlers) { routes.set('GET '+path,handlers.at(-1)); }, post(path,...handlers) { routes.set('POST '+path,handlers.at(-1)); } });
    const getReminders = async (actor = 808) => {
      let result;
      await routes.get('GET /api/checklist/reminders')({ query: { case_id: 17 }, tgUser: { id: actor }, staff: { role: actor === 808 ? 'lawyer' : 'manager', approved: true } }, { json(value) { result = value; }, status() { return this; } });
      return result;
    };
    const complete = async(channel,actor=808) => {
      if(channel==='callback'){
        const actions=[],answers=[];context.module.exports.setupReportsBot({command(){},on(){},action(pattern,handler){actions.push({pattern,handler});}});
        const handler=actions.find(item=>String(item.pattern).includes('rmd:')).handler;
        await handler({from:{id:actor,first_name:'Synthetic staff'},match:['rmd:1','1'],answerCbQuery:async text=>answers.push(text),editMessageReplyMarkup:async()=>{}});
        return {ok:answers.includes('Отмечено'),answers};
      }
      let body,status=200;await routes.get('POST /api/checklist/reminders/done')({body:{id:1},tgUser:{id:actor},staff:{role:'lawyer',approved:true}},
        {json(value){body=value;},status(value){status=value;return this;}});return{...body,status};
    };
    await run({ db, deliveries, getReminders, complete, tick: () => scheduledTick(), reminders: () => api.sendCaseReminders({ telegram }), fail(chat) { failure = chat == null ? null : String(chat); }, mutate(fn) { mutation = fn; }, advance(ms) { currentNow += ms; }, rejectWrites(fn) { rejectWrite = fn; }, beforeQuery(fn) { beforeQuery = fn; }, restart() { reminderDelivery = { ...reminderModule, ...reminderModule.createReminderDelivery() }; }, row: async () => (await db.query('SELECT * FROM cases WHERE id=17')).rows[0] });
  } finally { await db.close(); }
}

test('failed decision DM retries the same day without repeating the confirmed group notice', pg, async () => fixture(async h => {
  h.fail(808); await h.tick(); assert.equal((await h.row()).reminded_on, null);
  h.fail(null); h.advance(10*60*1000); await h.tick(); assert.ok((await h.row()).reminded_on);
  assert.equal(h.deliveries.filter(event => event.chat === '808').length, 2);
  assert.equal(h.deliveries.filter(event => event.chat === '-100200').length, 1);
}));

test('failed initial decision group notice retries without repeating the confirmed lawyer DM', pg, async () => fixture(async h => {
  h.fail(-100200); await h.tick(); assert.equal((await h.row()).reminded_on, null);
  h.fail(null); h.advance(10*60*1000); await h.tick(); assert.ok((await h.row()).reminded_on);
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

test('completing a case reminder while its final staff lookup waits prevents the first Telegram send',pg,async()=>fixture(async h=>{
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  let lookups=0;h.beforeQuery(async sql=>{if(isRecipientLookup(sql)&&++lookups===2)await h.db.exec('UPDATE case_reminders SET done=true WHERE id=1');});
  await h.reminders();assert.deepEqual(h.deliveries,[]);const row=(await h.db.query('SELECT * FROM case_reminders WHERE id=1')).rows[0];assert.equal(row.done,true);assert.equal(row.sent_at,null);
}));

for(const channel of ['callback','http'])for(const change of ['approval','assignment','role'])test(channel+' reminder completion checks current '+change+' in the mutation snapshot',pg,async()=>fixture(async h=>{
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  let changed=false;h.beforeQuery(async sql=>{if(!changed&&/^UPDATE case_reminders.*SET done/.test(sql)){changed=true;await h.db.exec(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=808':change==='assignment'?'UPDATE cases SET lawyer_tg_id=909 WHERE id=17':"UPDATE staff SET role='auditor' WHERE tg_id=808");}});
  const result=await h.complete(channel);assert.equal(changed,true);assert.equal(result.ok,false);assert.equal((await h.db.query('SELECT done FROM case_reminders WHERE id=1')).rows[0].done,false);
  if(channel==='http')assert.equal(result.status,403);
}));
for(const channel of ['callback','http'])test(channel+' reminder completion preserves assigned-lawyer, manager and approved-admin access',pg,async()=>fixture(async h=>{
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  for(const actor of [808,101]){assert.equal((await h.complete(channel,actor)).ok,true);await h.db.exec('UPDATE case_reminders SET done=false WHERE id=1');}
  assert.equal((await h.complete(channel,909)).ok,false);
  const previous=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='808';
  try{await h.db.exec("UPDATE staff SET role='auditor' WHERE tg_id=808");assert.equal((await h.complete(channel,808)).ok,true);await h.db.exec('UPDATE case_reminders SET done=false WHERE id=1; UPDATE staff SET approved=false WHERE tg_id=808');assert.equal((await h.complete(channel,808)).ok,false);}
  finally{if(previous===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=previous;}
}));

test('a received case-reminder ACK with failed DB receipts is persisted on the next tick without a second Telegram send', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.rejectWrites((sql,params) => sql.startsWith('UPDATE case_reminders SET delivery=') && !!JSON.parse(params[0])['808']);
  await h.reminders();
  let row = (await h.db.query('SELECT * FROM case_reminders WHERE id=1')).rows[0];
  assert.equal(row.sent_at,null); assert.equal(row.delivery['808'],undefined); assert.equal(row.delivery._attempts['808'].state,'sending');
  assert.deepEqual(h.deliveries.map(event => event.chat),['808']);
  assert.equal((await h.getReminders()).items[0].sent,false);
  h.rejectWrites(null); await h.reminders();
  row = (await h.db.query('SELECT * FROM case_reminders WHERE id=1')).rows[0];
  assert.ok(row.sent_at); assert.ok(row.delivery['808']); assert.ok(row.delivery['101']);
  assert.deepEqual(h.deliveries.map(event => event.chat),['808','101']);
}));

test('a crash-lost case ACK becomes visible unknown after the lease and retries only that recipient after backoff', pg, async () => fixture(async h => {
  const { LEASE_MS, RETRY_MS } = require('../src/web/reminder-delivery');
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.rejectWrites((sql,params) => sql.startsWith('UPDATE case_reminders SET delivery=') && !!JSON.parse(params[0])['808']);
  await h.reminders(); h.restart(); h.rejectWrites(null); h.advance(LEASE_MS+1);
  await h.reminders();
  let item = (await h.getReminders()).items[0];
  assert.equal(item.sent,false); assert.equal(item.deliveryStatus.state,'unknown'); assert.equal(item.deliveryStatus.confirmed,1); assert.equal(item.deliveryStatus.total,2); assert.ok(item.deliveryStatus.nextAt); assert.equal(item.deliveryStatus.duplicatePossible,true);
  assert.deepEqual(h.deliveries.map(event => event.chat),['808','101']);
  await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808','101']);
  h.advance(RETRY_MS); await h.reminders();
  item = (await h.getReminders()).items[0]; assert.equal(item.sent,true); assert.equal(item.deliveryStatus.state,'confirmed');
  assert.deepEqual(h.deliveries.map(event => event.chat),['808','101','808']);
}));

test('decision ACK recovery retries storage instead of sending a duplicate DM and exposes pending delivery through the checklist API', pg, async () => fixture(async h => {
  h.rejectWrites((sql,params) => sql.startsWith('UPDATE cases SET decision_reminder_delivery=') && !!JSON.parse(params[0]).dm);
  await h.tick(); assert.equal((await h.row()).reminded_on,null);
  const status = (await h.getReminders()).decisionDeliveryStatus;
  assert.equal(status.state,'sending'); assert.equal(status.confirmed,0);
  assert.deepEqual(h.deliveries.map(event => event.chat),['808']);
  h.rejectWrites(null); await h.tick();
  assert.ok((await h.row()).reminded_on); assert.deepEqual(h.deliveries.map(event => event.chat),['808','-100200']);
  assert.equal((await h.getReminders()).decisionDeliveryStatus.state,'confirmed');
}));

test('failed and partially confirmed case deliveries have a visible next retry and cannot spam confirmed recipients or retry early', pg, async () => fixture(async h => {
  const { RETRY_MS } = require('../src/web/reminder-delivery');
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.fail(808); await h.reminders();
  const item = (await h.getReminders()).items[0];
  assert.equal(item.sent,false); assert.equal(item.deliveryStatus.state,'partial'); assert.equal(item.deliveryStatus.confirmed,1); assert.ok(item.deliveryStatus.nextAt);
  h.fail(null); await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808','101']);
  h.advance(RETRY_MS); await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808','101','808']);
}));

test('case reminder concurrency keeps one intent/send per recipient while another tick is waiting', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  let started, release, held = false;
  const sending = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  h.mutate(async event => { if (event.chat === '808' && !held) { held = true; started(); await gate; } });
  const first = h.reminders(); await sending;
  const before = (await h.db.query('SELECT delivery FROM case_reminders WHERE id=1')).rows[0].delivery;
  assert.equal(before._attempts['808'].state,'sending'); assert.ok(before._attempts['808'].lease_until);
  await h.reminders(); release(); await first;
  assert.deepEqual(h.deliveries.map(event => event.chat),['808','101']);
}));

test('web reminder labels disclose unknown/partial delivery and never promise 9:00 for an overdue pending task', () => {
  const start = source.indexOf('  function reminderStatusLabel('), end = source.indexOf('  function loadReminders()',start);
  const context = vm.createContext({ Date, mskToday: () => '2026-11-05' });
  vm.runInContext(source.slice(start,end),context);
  const unknown = context.reminderStatusLabel({ state: 'unknown', nextAt: '2026-11-05T10:40:00Z' });
  assert.match(unknown,/Доставка не подтверждена; повтор в 13:40 МСК/); assert.match(unknown,/Возможно повторное сообщение/); assert.doesNotMatch(unknown,/придёт в 9/);
  assert.match(context.reminderStatusLabel({ state: 'partial', confirmed: 1, total: 2 }),/Доставлено 1 из 2/);
  assert.equal(context.reminderStatusLabel({ state: 'pending' }),'ожидает отправки');
  assert.equal(context.reminderStatusLabel(null,false,'2026-11-04'),'ожидает отправки');
  assert.equal(context.reminderStatusLabel({ state: 'confirmed' }),'доставка подтверждена');
  assert.match(context.reminderStatusLabel({ state: 'no_recipient' }),/Нет доступного получателя.*проверим снова/);
  assert.match(context.reminderStatusLabel({ state: 'recipient_check_failed' }),/Не удалось проверить доступ получателя; повторим проверку/);
});

test('a restarted decision sender exposes its unknown DM and retries it after backoff without repeating the group receipt', pg, async () => fixture(async h => {
  const { LEASE_MS, RETRY_MS } = require('../src/web/reminder-delivery');
  h.rejectWrites((sql,params) => sql.startsWith('UPDATE cases SET decision_reminder_delivery=') && !!JSON.parse(params[0]).dm);
  await h.tick(); h.restart(); h.rejectWrites(null); h.advance(LEASE_MS+1); await h.tick();
  let status = (await h.getReminders()).decisionDeliveryStatus;
  assert.equal(status.state,'unknown'); assert.equal(status.confirmed,1); assert.equal(status.duplicatePossible,true); assert.equal((await h.row()).reminded_on,null);
  assert.deepEqual(h.deliveries.map(event => event.chat),['808','-100200']);
  h.advance(RETRY_MS); await h.tick();
  status = (await h.getReminders()).decisionDeliveryStatus;
  assert.equal(status.state,'confirmed'); assert.ok((await h.row()).reminded_on);
  assert.deepEqual(h.deliveries.map(event => event.chat),['808','-100200','808']);
}));

test('Telegram is never called if its reminder intent cannot be persisted and the overdue task remains visibly pending', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.rejectWrites(sql => sql.startsWith('UPDATE case_reminders SET delivery='));
  await h.reminders(); assert.equal(h.deliveries.length,0);
  const item = (await h.getReminders()).items[0];
  assert.equal(item.sent,false); assert.equal(item.deliveryStatus.state,'pending'); assert.equal(item.deliveryStatus.confirmed,0);
  assert.equal((await h.db.query('SELECT done FROM case_reminders WHERE id=1')).rows[0].done,false);
}));

test('an ambiguous Telegram network failure stays unknown until an addressed retry confirms it', pg, async () => fixture(async h => {
  const { RETRY_MS } = require('../src/web/reminder-delivery');
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.mutate(event => { if (event.chat === '808') throw new Error('Synthetic unknown network outcome'); });
  await h.reminders();
  let item = (await h.getReminders()).items[0]; assert.equal(item.sent,false); assert.equal(item.deliveryStatus.state,'unknown'); assert.equal(item.deliveryStatus.duplicatePossible,true);
  h.mutate(() => {}); await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808','101']);
  h.advance(RETRY_MS); await h.reminders(); item = (await h.getReminders()).items[0];
  assert.equal(item.sent,true); assert.deepEqual(h.deliveries.map(event => event.chat),['808','101','808']);
}));

test('the helper retries a cached ACK before trusting the same mutated delivery object after receipt writes fail', async () => {
  const helper = require('../src/web/reminder-delivery').createReminderDelivery();
  const delivery = {}; let sends = 0, writes = 0, rejectReceipt = true;
  const options = { key: 'unit-same-object', slot: '808', window: '2026-11-05', delivery, now: fixedNow,
    acknowledged: () => !!delivery['808'], acknowledge: id => { delivery['808'] = id; },
    async persist() { writes++; if (rejectReceipt && delivery['808']) throw new Error('Synthetic failed receipt commit'); return true; },
    async send() { sends++; return { message_id: 42 }; },
  };
  assert.equal(await helper.deliverRecipient(options),'unknown'); assert.equal(sends,1); assert.equal(writes,4);
  assert.equal(await helper.deliverRecipient(options),'unknown'); assert.equal(sends,1); assert.equal(writes,7);
  rejectReceipt = false; assert.equal(await helper.deliverRecipient(options),'confirmed'); assert.equal(sends,1); assert.equal(writes,8);
});

test('an inactive receipt write is not reported as confirmed or a network uncertainty and its cached ACK is not resent', async () => {
  const helper = require('../src/web/reminder-delivery').createReminderDelivery();
  const delivery = {}; let sends = 0, active = false;
  const options = { key: 'unit-inactive', slot: '808', window: '2026-11-05', delivery, now: fixedNow,
    acknowledged: () => !!delivery['808'], acknowledge: id => { delivery['808'] = id; },
    async persist() { return !delivery['808'] || active; }, async send() { sends++; return { message_id: 43 }; },
  };
  assert.equal(await helper.deliverRecipient(options),'inactive'); assert.equal(sends,1);
  assert.equal(await helper.deliverRecipient(options),'inactive'); assert.equal(sends,1);
  active = true; assert.equal(await helper.deliverRecipient(options),'confirmed'); assert.equal(sends,1);
});

test('a late-night case retry is scheduled for 9 Moscow time and the API never promises a retry during the paused hours', pg, async () => fixture(async h => {
  const fridayLate = Date.parse('2026-11-06T20:55:00Z'), saturdayNine = Date.parse('2026-11-07T06:00:00Z');
  h.advance(fridayLate-fixedNow);
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.fail(808); await h.reminders();
  assert.equal((await h.getReminders()).items[0].deliveryStatus.nextAt,new Date(saturdayNine).toISOString());
  h.fail(null); h.advance(saturdayNine-fridayLate-60000); await h.reminders(); assert.equal(h.deliveries.length,2);
  h.advance(60000); await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808','101','808']);
}));

test('a decision retry due on a weekend advertises the next working day and keeps the confirmed group receipt unique', pg, async () => fixture(async h => {
  const fridayLate = Date.parse('2026-11-06T20:55:00Z'), saturdayNine = Date.parse('2026-11-07T06:00:00Z'), mondayNine = Date.parse('2026-11-09T06:00:00Z');
  h.advance(fridayLate-fixedNow); h.fail(-100200); await h.tick();
  assert.equal((await h.getReminders()).decisionDeliveryStatus.nextAt,new Date(mondayNine).toISOString());
  h.fail(null); h.advance(saturdayNine-fridayLate); await h.tick(); assert.equal(h.deliveries.length,2);
  h.advance(mondayNine-saturdayNine); await h.tick();
  assert.equal(h.deliveries.filter(event => event.chat === '-100200').length,2);
  assert.equal((await h.getReminders()).decisionDeliveryStatus.state,'confirmed');
}));

test('an excluded former creator does not receive client information or block the active assigned lawyer receipt', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101); UPDATE staff SET approved=false WHERE tg_id=101");
  await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808']);
  const row = (await h.db.query('SELECT * FROM case_reminders WHERE id=1')).rows[0];
  assert.ok(row.sent_at); assert.deepEqual(row.delivery._access.allowed,['808']); assert.deepEqual(row.delivery._access.excluded,['101']);
  const item = (await h.getReminders(102)).items[0]; assert.equal(item.sent,true); assert.equal(item.deliveryStatus.total,1);
  await h.db.exec('UPDATE staff SET approved=true WHERE tg_id=101');
  const restored = (await h.getReminders(102)).items[0]; assert.equal(restored.deliveryStatus.confirmed,1); assert.equal(restored.deliveryStatus.total,1);
}));

test('no currently approved eligible recipient stays visibly unconfirmed and reactivation resumes lawful delivery', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101); UPDATE staff SET approved=false WHERE tg_id IN(808,101)");
  await h.reminders(); assert.equal(h.deliveries.length,0);
  let item = (await h.getReminders(102)).items[0]; assert.equal(item.sent,false); assert.equal(item.deliveryStatus.state,'no_recipient'); assert.ok(item.deliveryStatus.nextAt);
  assert.equal((await h.db.query('SELECT sent_at FROM case_reminders WHERE id=1')).rows[0].sent_at,null);
  await h.db.exec('UPDATE staff SET approved=true WHERE tg_id=808'); await h.reminders();
  assert.deepEqual(h.deliveries.map(event => event.chat),['808']); item = (await h.getReminders(102)).items[0]; assert.equal(item.sent,true);
}));

test('a changed role cannot retain former lawyer access, while an approved configured admin follows the shared case-access rule', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101); UPDATE staff SET role='auditor' WHERE tg_id IN(808,101)");
  await h.reminders(); assert.equal(h.deliveries.length,0); assert.equal((await h.getReminders(102)).items[0].deliveryStatus.state,'no_recipient');
  const previous = process.env.ADMIN_TG_IDS; process.env.ADMIN_TG_IDS='101';
  try { await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['101']); }
  finally { if (previous === undefined) delete process.env.ADMIN_TG_IDS; else process.env.ADMIN_TG_IDS=previous; }
}));

test('revoking the remaining recipient during the first send prevents the next client-information message', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.mutate(async event => { if (event.chat === '808') await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=101'); });
  await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808']);
  assert.ok((await h.db.query('SELECT sent_at FROM case_reminders WHERE id=1')).rows[0].sent_at);
}));

test('revocation after the durable intent is checked again before Telegram rather than using the earlier staff snapshot', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  let revoked = false;
  h.beforeQuery(async (sql,params) => {
    if (!revoked && sql.startsWith('UPDATE case_reminders SET delivery=') && JSON.parse(params[0])._attempts?.['808']?.state === 'sending') {
      revoked=true; await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=808');
    }
  });
  await h.reminders(); assert.equal(revoked,true); assert.deepEqual(h.deliveries.map(event => event.chat),['101']);
}));

test('a case owner change during delivery leaves the new owner pending and the next tick addresses only that current owner', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.mutate(async event => { if (event.chat === '808') await h.db.exec("UPDATE cases SET lawyer_tg_id=909,lawyer_name='Replacement lawyer' WHERE id=17"); });
  await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808','101']);
  assert.equal((await h.db.query('SELECT sent_at FROM case_reminders WHERE id=1')).rows[0].sent_at,null);
  let item = (await h.getReminders(102)).items[0]; assert.equal(item.sent,false); assert.equal(item.deliveryStatus.state,'partial');
  await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['808','101','909']);
  item = (await h.getReminders(102)).items[0]; assert.equal(item.sent,true);
}));

test('a revoked decision DM remains unconfirmed while the manager group receives a warning, and reactivation sends only the missing DM', pg, async () => fixture(async h => {
  await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=808'); await h.tick();
  assert.deepEqual(h.deliveries.map(event => event.chat),['-100200']); assert.match(h.deliveries[0].text,/Личный получатель недоступен/);
  assert.equal((await h.row()).reminded_on,null); assert.equal((await h.getReminders(102)).decisionDeliveryStatus.state,'no_recipient');
  await h.db.exec('UPDATE staff SET approved=true WHERE tg_id=808'); await h.tick();
  assert.deepEqual(h.deliveries.map(event => event.chat),['-100200','808']); assert.ok((await h.row()).reminded_on);
}));

test('staff lookup failures fail closed, keep sent_at empty and show an access-check problem instead of confirmed delivery', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  h.rejectWrites(isRecipientLookup);
  await h.reminders(); assert.equal(h.deliveries.length,0);
  let item = (await h.getReminders(102)).items[0]; assert.equal(item.sent,false); assert.equal(item.deliveryStatus.state,'recipient_check_failed');
  assert.equal((await h.db.query('SELECT sent_at FROM case_reminders WHERE id=1')).rows[0].sent_at,null);
  h.rejectWrites(null); await h.reminders(); item = (await h.getReminders(102)).items[0]; assert.equal(item.sent,true);
}));

test('a decision owner change while its first DM is in flight prevents stale follow-ups and addresses the replacement on the next tick', pg, async () => fixture(async h => {
  h.mutate(async event => { if (event.chat === '808') await h.db.exec("UPDATE cases SET lawyer_tg_id=909,lawyer_name='Replacement lawyer' WHERE id=17"); });
  await h.tick(); assert.deepEqual(h.deliveries.map(event => event.chat),['808']); assert.equal((await h.row()).reminded_on,null);
  await h.tick(); assert.deepEqual(h.deliveries.map(event => event.chat),['808','909','-100200']); assert.ok((await h.row()).reminded_on);
}));

test('a decision staff lookup error sends only the configured manager-group warning and never confirms a private DM', pg, async () => fixture(async h => {
  h.rejectWrites(isRecipientLookup); await h.tick();
  assert.deepEqual(h.deliveries.map(event => event.chat),['-100200']); assert.match(h.deliveries[0].text,/Личный получатель недоступен/); assert.equal((await h.row()).reminded_on,null);
  assert.equal((await h.getReminders(102)).decisionDeliveryStatus.state,'recipient_check_failed');
  h.rejectWrites(null); await h.tick(); assert.deepEqual(h.deliveries.map(event => event.chat),['-100200','808']); assert.ok((await h.row()).reminded_on);
}));

test('the final recipient gate observes an owner change that happened after case read but before staff lookup, and never sends the former owner', pg, async () => fixture(async h => {
  await h.db.exec("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by) VALUES(1,17,'2026-11-05','Synthetic reminder',101)");
  let checks=0,changed=false;
  h.beforeQuery(async sql => {
    if (isRecipientLookup(sql) && ++checks===2) { changed=true; await h.db.exec("UPDATE cases SET lawyer_tg_id=909,lawyer_name='Replacement lawyer' WHERE id=17"); }
  });
  await h.reminders(); assert.equal(changed,true); assert.ok(!h.deliveries.some(event => event.chat==='808'));
  assert.equal((await h.db.query('SELECT sent_at FROM case_reminders WHERE id=1')).rows[0].sent_at,null);
  await h.reminders(); assert.deepEqual(h.deliveries.map(event => event.chat),['101','909']);
  assert.ok((await h.db.query('SELECT sent_at FROM case_reminders WHERE id=1')).rows[0].sent_at);
  const stored=(await h.db.query('SELECT delivery FROM case_reminders WHERE id=1')).rows[0].delivery;
  assert.equal(stored._access.client,undefined); assert.equal(stored._access.access_case,undefined);
}));

test('the decision final gate rejects a newly reassigned owner snapshot before either stale private or group delivery', pg, async () => fixture(async h => {
  let checks=0,changed=false;
  h.beforeQuery(async sql => {
    if (isRecipientLookup(sql) && ++checks===2) { changed=true; await h.db.exec("UPDATE cases SET lawyer_tg_id=909,lawyer_name='Replacement lawyer' WHERE id=17"); }
  });
  await h.tick(); assert.equal(changed,true); assert.equal(h.deliveries.length,0); assert.equal((await h.row()).reminded_on,null);
  await h.tick(); assert.deepEqual(h.deliveries.map(event => event.chat),['909','-100200']); assert.ok((await h.row()).reminded_on);
}));
