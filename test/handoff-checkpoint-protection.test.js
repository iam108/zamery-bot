'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID}=require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../src/web/handoff.js'), 'utf8');
const pg = { skip: !process.env.PGLITE_TEST_MODULE };

// Run the actual registered route and actual SQL against PostgreSQL semantics.
// Only Telegram, staff auth, timers and unrelated packet routes are synthetic.
async function fixture(run,options={}) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  const routes = new Map(), queries = [], initialization = [], telegram = [];
  let beforeWrite = null, beforeAccess=null,beforeReminderWrite=null,writes = 0,loseCommit=false;
  const pool = { async query(sql, params) {
    queries.push(sql);
    if(beforeAccess&&sql.startsWith('SELECT to_jsonb(c) AS access_case'))await beforeAccess(db);
    if(beforeReminderWrite&&(sql.includes('FOR SHARE OF c,actor')||sql.includes('INSERT INTO case_reminders')&&!sql.includes('request_signature')))await beforeReminderWrite(db);
    if (sql.includes('UPDATE cases SET data=')) {
      writes++;
      if (beforeWrite) await beforeWrite({ sql, params, number: writes, db });
    }
    const operation = !params && sql.split(';').filter(value => value.trim()).length > 1 ? db.exec(sql) : db.query(sql, params);
    initialization.push(operation);
    const result=await operation;if(loseCommit&&sql==='COMMIT'){loseCommit=false;throw new Error('Synthetic lost COMMIT acknowledgement');}return result;
  },async connect(){return{query:pool.query,release(){}};} };
  const environment={};const context = {
    module: { exports: {} }, URL,
    console: { log() {}, error() {} }, process: { env: environment }, setTimeout() {}, setInterval() {},
    require(name) {
      if (name === '../db/pool') return pool;
      if (name === '../checklists') return { LISTS: {}, STAGES: ['Сбор документов', 'Подано', 'Выездная проверка', 'Архив'], pickChecklist: () => 'QA', flagLabels: () => options.flagLabels||{} };
      if (name === '../bot/instance') return { telegram: { async sendMessage(...args) { telegram.push(args); if(options.sendMessage)return options.sendMessage(...args);return { message_id: telegram.length }; } } };
      if (name === './handoff-packet') return { setupHandoffPacket: () => ({}) };
      if (name === './handoff-manual' || name === './handoff-manual-materials') return require('../src/web/' + name);
      if (name === './auth') return require('../src/web/auth');
      if (name === './reminder-recipients') return require('../src/web/reminder-recipients');
      if (name === './http-errors') return require('../src/web/http-errors');
      if (name === 'node:crypto') return require(name);
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.createContext(context); vm.runInContext(source, context);
  const app = { get(url, ...handlers) { routes.set('GET ' + url, handlers.at(-1)); }, post(url, ...handlers) { routes.set('POST ' + url, handlers.at(-1)); }, delete(url,...handlers) {routes.set('DELETE '+url,handlers.at(-1));} };
  try {
    context.module.exports.setupHandoff(app);
    await Promise.all(initialization);
    await db.exec("ALTER TABLE staff ADD COLUMN approved BOOLEAN;INSERT INTO staff(tg_id,name,role,approved) VALUES(808,'Тестовый юрист','lawyer',true),(909,'Другой юрист','lawyer',true),(101,'Менеджер','manager',true),(102,'Новый менеджер','manager',true),(999,'Администратор','auditor',true)");
    const route = routes.get('POST /api/checklist/save'); assert.equal(typeof route, 'function');
    async function rawSave(data, extra = {}, actor={id:808,role:'lawyer'}) {
      let result, status = 200;
      const row = (await db.query('SELECT checklist_revision FROM cases WHERE id=17')).rows[0];
      await route({ body: { case_id: 17, data, done: 1, total: 4, expectedRevision: Number(row?.checklist_revision || 0), ...extra }, tgUser: { id: actor.id }, staff: { name: 'Тестовый сотрудник', role: actor.role, approved: true }, get: () => 'application/json' }, {
        status(value) { status = value; return this; }, json(value) { result = value; },
      });
      return { status, result };
    }
    await run({ db, queries, telegram,environment,
      async seed(data) {
        await db.query(`INSERT INTO cases(id,org,lawyer_name,lawyer_tg_id,created_by,region,checklist_key,data)
          VALUES(17,'ООО Проверка','Тестовый юрист',808,101,'МСК','QA',$1)`, [data]);
      },
      rawSave,
      async prefill(query,actor=808){let result,status=200;await routes.get('GET /api/handoff/prefill')({query,tgUser:{id:actor},staff:{name:'Сотрудник',role:actor===101?'manager':'lawyer',approved:true}},{json(value){result=value;},status(value){status=value;return this;}});return{status,result};},
      async requestDocuments(){let result,status=200;await routes.get('POST /api/checklist/request')({body:{case_id:17,missing:['Synthetic required document']},tgUser:{id:808},staff:{name:'Тестовый юрист',role:'lawyer',approved:true}},{json(value){result=value;},status(value){status=value;return this;}});return{status,result};},
      async createReminder(actor={id:808,role:'lawyer'},extra={}){let result,status=200;await routes.get('POST /api/checklist/reminders')({body:{case_id:17,date:'2026-11-12',text:'Synthetic reminder',request_id:randomUUID(),...extra},tgUser:{id:actor.id},staff:{name:'Тестовый сотрудник',role:actor.role,approved:true}},{json(value){result=value;},status(value){status=value;return this;}});return{status,result};},
      async save(data, extra = {}) {
        const { result, status } = await rawSave(data, extra);
        assert.equal(status, 200); assert.equal(result?.ok, true, result?.error); return result;
      },
      row: async () => (await db.query('SELECT * FROM cases WHERE id=17')).rows[0],
      interleave(fn) { beforeWrite = fn; },
      interleaveAccess(fn){beforeAccess=fn;},
      interleaveReminder(fn){beforeReminderWrite=fn;},
      async migrateReminders(){vm.runInContext('deadlinesReady=null',context);await vm.runInContext('ensureDeadlines()',context);},
      loseCommit(){loseCommit=true;},
    });
  } finally { await db.close(); }
}
const checkpoint = generation => ({ version: 2, generation, completed: generation > 1, cards: { '808': 900 + generation }, materials: { confirmed: { '808': [1000 + generation] } }, egrn: { copies: { confirmed: true } } });
const asDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

for(const change of ['approval','role','assignment'])test('reminder creation uses current '+change+' at its final insert',pg,()=>fixture(async h=>{
  await h.seed({answer:'Original',_handoff:checkpoint(2)});
  h.interleaveReminder(db=>db.exec(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=808':change==='role'?"UPDATE staff SET role='auditor' WHERE tg_id=808":'UPDATE cases SET lawyer_tg_id=909 WHERE id=17'));
  const response=await h.createReminder();assert.equal(response.status,403);assert.equal(response.result.code,'CASE_FORBIDDEN');
  assert.equal((await h.db.query('SELECT * FROM case_reminders')).rows.length,0);assert.deepEqual((await h.row()).data._handoff,checkpoint(2));assert.equal(h.telegram.length,0);
}));

test('reminder creation retains current assigned lawyer, manager and approved configured administrator access',pg,()=>fixture(async h=>{
  await h.seed({answer:'Original'});const before=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='999';
  try{for(const actor of [{id:808,role:'lawyer'},{id:101,role:'manager'},{id:999,role:'auditor'}]){const response=await h.createReminder(actor);assert.equal(response.status,200);assert.equal(response.result.ok,true);assert.ok(Number(response.result.id)>0);}
    assert.equal((await h.db.query('SELECT * FROM case_reminders')).rows.length,3);assert.equal(h.telegram.length,0);
  }finally{if(before===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=before;}
}));

test('reminder creation retries an accepted request exactly once and rejects changed intent for the same case and author',pg,()=>fixture(async h=>{
  await h.seed({answer:'Original'});const request_id=randomUUID();
  const first=await h.createReminder(undefined,{request_id}),replay=await h.createReminder(undefined,{request_id});
  assert.equal(first.result.ok,true);assert.equal(replay.result.ok,true);assert.equal(replay.result.id,first.result.id);assert.equal((await h.db.query('SELECT * FROM case_reminders')).rows.length,1);
  const changed=await h.createReminder(undefined,{request_id,text:'Changed retry'});assert.equal(changed.status,409);assert.equal(changed.result.code,'REMINDER_REQUEST_CHANGED');
  assert.equal((await h.db.query('SELECT text FROM case_reminders')).rows[0].text,'Synthetic reminder');
  const deliberateNew=await h.createReminder();assert.notEqual(deliberateNew.result.id,first.result.id);assert.equal((await h.db.query('SELECT * FROM case_reminders')).rows.length,2);
}));

test('reminder request IDs are scoped to case and author and current access is required even for a replay',pg,()=>fixture(async h=>{
  await h.seed({});await h.db.exec("INSERT INTO cases(id,org,lawyer_tg_id) VALUES(18,'Other synthetic case',808)");const request_id=randomUUID();
  const first=await h.createReminder(undefined,{request_id}),otherCase=await h.createReminder(undefined,{case_id:18,request_id}),otherActor=await h.createReminder({id:101,role:'manager'},{request_id});
  assert.equal(new Set([first.result.id,otherCase.result.id,otherActor.result.id]).size,3);
  await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=808');const revoked=await h.createReminder(undefined,{request_id});assert.equal(revoked.status,403);assert.equal(revoked.result.id,undefined);
}));

test('an old reminder form without a valid request ID is refused visibly before creating a row',pg,()=>fixture(async h=>{
  await h.seed({});for(const request_id of [undefined,'',true,'not-a-uuid']){const response=await h.createReminder(undefined,{request_id});assert.equal(response.status,409);assert.equal(response.result.code,'REMINDER_REQUEST_REQUIRED');assert.match(response.result.error,/обновите|откройте/i);}
  assert.equal((await h.db.query('SELECT * FROM case_reminders')).rows.length,0);
}));

test('a lost reminder COMMIT acknowledgement replays its durable request without changing delivery or completed state',pg,()=>fixture(async h=>{
  await h.seed({});const request_id=randomUUID();h.loseCommit();const uncertain=await h.createReminder(undefined,{request_id});assert.equal(uncertain.status,500);
  const row=(await h.db.query('SELECT * FROM case_reminders')).rows[0];assert.ok(row.id);await h.db.query("UPDATE case_reminders SET done=true,sent_at=NOW(),delivery=$1 WHERE id=$2",[{808:901,_attempts:{808:{state:'confirmed',message_id:901}}},row.id]);
  const before=(await h.db.query('SELECT * FROM case_reminders')).rows[0],replay=await h.createReminder(undefined,{request_id});assert.equal(replay.result.ok,true);assert.equal(replay.result.replayed,true);assert.equal(replay.result.id,row.id);assert.equal(replay.result.done,true);
  assert.deepEqual((await h.db.query('SELECT * FROM case_reminders')).rows,[before]);
}));

test('adding durable reminder requests preserves old schedules, completion and delivery receipts without assigning invented IDs',pg,()=>fixture(async h=>{
  await h.seed({});await h.migrateReminders();await h.db.exec('ALTER TABLE case_reminders DROP COLUMN request_id;ALTER TABLE case_reminders DROP COLUMN request_signature');
  await h.db.query("INSERT INTO case_reminders(id,case_id,remind_on,text,created_by,created_name,done,sent_at,delivery) VALUES(99,17,'2026-11-12','Legacy unchanged',808,'Original author',true,NOW(),$1)",[{808:903}]);
  const old=(await h.db.query('SELECT * FROM case_reminders WHERE id=99')).rows[0];await h.migrateReminders();const migrated=(await h.db.query('SELECT * FROM case_reminders WHERE id=99')).rows[0];
  assert.deepEqual(migrated,{...old,request_id:null,request_signature:null});assert.equal((await h.createReminder()).result.ok,true);assert.equal((await h.db.query('SELECT * FROM case_reminders')).rows.length,2);
}));

test('concurrent identical checklist transitions notify each destination once while accepting exact save replay',pg,async()=>fixture(async h=>{
  h.environment.CLIENTS_CHAT_ID='-100222';await h.seed({_stage:'Сбор документов',_handoff:checkpoint(2)});
  let arrivals=0,release;const gate=new Promise(resolve=>{release=resolve;});h.interleave(async()=>{if(++arrivals===2)release();else await gate;});
  const body={_stage:'Подано',_submittedOn:'2026-11-05',fl_egrn:{s:'yes',c:'Synthetic finding'}};
  const results=await Promise.all([h.rawSave(body,{expectedRevision:0}),h.rawSave(body,{expectedRevision:0})]);
  assert.ok(results.every(item=>item.status===200&&item.result.ok));assert.equal((await h.row()).checklist_revision,1);
  const flags=h.telegram.filter(args=>args[1].includes('Красный флаг'));assert.deepEqual(flags.map(args=>String(args[0])).sort(),['-100222','101']);
  assert.equal(h.telegram.filter(args=>args[1].includes('Заявление подано')).length,1);assert.deepEqual((await h.row()).data._handoff,checkpoint(2));
}, {flagLabels:{fl_egrn:'Synthetic restriction'}}));

test('concurrent identical completion saves emit one completion notice and genuine later completion emits another',pg,async()=>fixture(async h=>{
  h.environment.CLIENTS_CHAT_ID='-100222';await h.seed({answer:'Pending'});let arrivals=0,release;const gate=new Promise(resolve=>{release=resolve;});
  h.interleave(async()=>{if(++arrivals===2)release();else await gate;});
  const first=await Promise.all([h.rawSave({answer:'Completed'},{expectedRevision:0,done:1,total:1}),h.rawSave({answer:'Completed'},{expectedRevision:0,done:1,total:1})]);
  assert.ok(first.every(item=>item.result.ok));assert.equal(h.telegram.filter(args=>args[1].includes('Чек-лист выполнен')).length,1);assert.ok((await h.row()).completed_at);
  h.interleave(null);await h.save({answer:'Reopened'},{done:0,total:1});assert.equal((await h.row()).completed_at,null);
  await h.save({answer:'Completed again'},{done:1,total:1});assert.equal(h.telegram.filter(args=>args[1].includes('Чек-лист выполнен')).length,2);
}));

test('a lost completion-message ACK after commit does not duplicate the notice when the client retries its exact old revision',pg,async()=>fixture(async h=>{
  h.environment.CLIENTS_CHAT_ID='-100222';await h.seed({answer:'Pending'});
  const body={answer:'Completed'},extra={expectedRevision:0,done:1,total:1},first=await h.rawSave(body,extra);
  assert.equal(first.result.ok,false);assert.equal((await h.row()).checklist_revision,1);assert.ok((await h.row()).completed_at);
  const retry=await h.rawSave(body,extra);assert.equal(retry.result.ok,true);assert.equal(retry.result.revision,1);assert.equal(h.telegram.length,1);
}, {sendMessage:async()=>{throw new Error('Synthetic accepted completion notice with lost ACK');}}));

for(const change of ['approval','role','assignment'])test('checklist saving rejects a current '+change+' change in its atomic write and preserves answers and checkpoint',pg,async()=>fixture(async h=>{
  await h.seed({answer:'Original',_comment:'Private original note',_handoff:checkpoint(2)});let changed=false;
  h.interleave(async({db})=>{if(!changed){changed=true;await db.exec(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=808':change==='role'?"UPDATE staff SET role='auditor' WHERE tg_id=808":'UPDATE cases SET lawyer_tg_id=909 WHERE id=17');}});
  const result=await h.rawSave({answer:'Must not save',_comment:'Must not replace'},{expectedNote:'Private original note'});
  assert.equal(result.status,403);assert.equal(result.result.code,'CASE_FORBIDDEN');assert.equal(result.result.note,undefined);const row=await h.row();assert.equal(row.data.answer,'Original');assert.equal(row.data._comment,'Private original note');assert.deepEqual(row.data._handoff,checkpoint(2));assert.equal(row.checklist_revision,0);assert.equal(h.telegram.length,0);
}));

test('checklist writes retain approved manager and configured administrator access, while a revoked administrator is denied',pg,async()=>fixture(async h=>{
  const before=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='999';try{
    await h.seed({answer:'Original',_handoff:checkpoint(2)});
    let result=await h.rawSave({answer:'Manager update'},{},{id:101,role:'manager'});assert.equal(result.status,200);assert.equal(result.result.ok,true);
    result=await h.rawSave({answer:'Admin update'},{},{id:999,role:'auditor'});assert.equal(result.status,200);assert.equal(result.result.ok,true);
    h.interleave(async({db})=>{await db.exec('UPDATE staff SET approved=false WHERE tg_id=999');});
    result=await h.rawSave({answer:'Revoked admin update'},{},{id:999,role:'auditor'});assert.equal(result.status,403);assert.equal((await h.row()).data.answer,'Admin update');assert.deepEqual((await h.row()).data._handoff,checkpoint(2));
  }finally{if(before===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=before;}
}));

for(const branch of ['documents','redflag'])for(const change of ['normal','disabled','foreign','changed-creator','revoked-during-lookup','missing-creator','lookup-error'])test('checklist '+branch+' private notice checks its current creator: '+change,pg,async()=>fixture(async h=>{
  h.environment.CLIENTS_CHAT_ID='-100222';await h.seed({answer:'Original',_handoff:checkpoint(2)});
  if(change==='disabled')await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=101');
  if(change==='foreign')await h.db.exec("UPDATE staff SET role='lawyer' WHERE tg_id=101");
  if(change==='missing-creator')await h.db.exec('UPDATE cases SET created_by=NULL WHERE id=17');
  let changed=false;h.interleaveAccess(async db=>{if(change==='lookup-error')throw new Error('Synthetic staff lookup failure');if(!changed&&['changed-creator','revoked-during-lookup'].includes(change)){changed=true;await db.exec(change==='changed-creator'?'UPDATE cases SET created_by=102 WHERE id=17':'UPDATE staff SET approved=false WHERE tg_id=101');}});
  const response=branch==='documents'?await h.requestDocuments():await h.rawSave({answer:'New answer',fl_egrn:{s:'yes',c:'Synthetic finding'}});
  assert.equal(response.status,200);assert.equal(response.result.ok,true);const targets=h.telegram.map(args=>String(args[0]));
  assert.deepEqual(targets,change==='normal'?['-100222','101']:change==='changed-creator'?['-100222','102']:['-100222']);
  if(branch==='redflag')assert.equal((await h.row()).data.fl_egrn.s,'yes');assert.deepEqual((await h.row()).data._handoff,checkpoint(2));
}, {flagLabels:{fl_egrn:'Synthetic restriction'}}));

test('no-order handoff prefill uses the assigned current case profile and frozen report without inventing a source order',pg,async()=>fixture(async h=>{
  await h.seed({_handoff:{version:2,body:{order_id:null,report_src:'r',report_id:15},fields:{cad_num:'77:01:0000001:2'}}});
  await h.db.query('UPDATE cases SET address=$1,kind=$2,service=$3,contacts=$4,audit_text=$5 WHERE id=17',['Saved case address','Общепит','Продление',JSON.stringify([{name:'Client',phone:'+79990000000'}]),'Frozen saved report text']);
  const opened=await h.prefill({case_id:'17'});assert.equal(opened.status,200);assert.equal(opened.result.ok,true);assert.equal(opened.result.order.id,null);assert.equal(opened.result.order.org,'ООО Проверка');assert.equal(opened.result.order.address,'Saved case address');assert.equal(opened.result.order.cad_num,'77:01:0000001:2');assert.equal(opened.result.report.id,15);assert.equal(opened.result.report.src,'r');assert.deepEqual(opened.result.lawyers.map(value=>Number(value.tg_id)),[808]);
  assert.equal((await h.prefill({case_id:'17',order_id:'60'})).status,403);assert.equal((await h.prefill({case_id:'999'})).status,403);
  await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=808');assert.equal((await h.prefill({case_id:'17'})).status,403);
  await h.db.exec('UPDATE staff SET approved=true WHERE tg_id=808;UPDATE cases SET lawyer_tg_id=909 WHERE id=17');assert.equal((await h.prefill({case_id:'17'})).status,403);
  assert.equal((await h.prefill({case_id:'17'},101)).status,200);
}));

test('a stale checklist form without internal state preserves a newer backend checkpoint atomically', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _handoff: checkpoint(1), older: { s: 'no' } });
  h.interleave(async ({ db }) => { await db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=17", [checkpoint(2)]); });
  await h.save({ _stage: 'Сбор документов', document: { s: 'yes', c: 'Проверено юристом' } }, { done: 4, total: 4 });
  const row = await h.row();
  assert.deepEqual(row.data._handoff, checkpoint(2)); assert.deepEqual(row.data.document, { s: 'yes', c: 'Проверено юристом' });
  assert.equal(row.data.older, undefined); assert.equal(row.done, 4); assert.equal(row.total, 4); assert.ok(row.completed_at);
}));

test('client-provided _handoff cannot replace or add fields to an existing backend checkpoint', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _handoff: checkpoint(2) });
  await h.save({ _stage: 'Сбор документов', document: { s: 'no' }, _handoff: { version: 2, completed: false, injected: true, cards: {} } });
  const row = await h.row();
  assert.deepEqual(row.data._handoff, checkpoint(2)); assert.equal(row.data.document.s, 'no'); assert.equal(row.completed_at, null);
}));

test('a normal legacy checklist cannot introduce an invented handoff checkpoint', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', prior: 'legacy' });
  await h.save({ _stage: 'Сбор документов', document: { s: 'yes' }, _handoff: checkpoint(99) });
  const row = await h.row();
  assert.equal(Object.hasOwn(row.data, '_handoff'), false); assert.equal(row.data.document.s, 'yes');
}));

test('first transition to submitted preserves the latest checkpoint across both SQL writes and sets decision dates', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _handoff: checkpoint(1) });
  h.interleave(async ({ number, db }) => { await db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=17", [checkpoint(number + 1)]); });
  const result = await h.save({ _stage: 'Подано', _submittedOn: '2026-11-02', document: { s: 'yes' }, _handoff: { malicious: true } });
  const row = await h.row();
  assert.equal(h.queries.filter(sql => sql.includes('UPDATE cases SET data=')).length, 1);
  assert.deepEqual(row.data._handoff, checkpoint(2)); assert.equal(row.data._stage, 'Подано');
  assert.equal(asDate(row.submitted_on), '2026-11-02'); assert.equal(asDate(row.decision_due), '2026-11-24');
  assert.equal(row.data._submittedOn, '2026-11-02'); assert.equal(row.data._decisionDue, '2026-11-24');
  assert.equal(result.submittedOn, '2026-11-02'); assert.equal(result.decisionDue, '2026-11-24');
}));

test('editing an already submitted date preserves the latest checkpoint across the recalculation branch', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Подано', _submittedOn: '2026-11-02', _decisionDue: '2026-11-24', _handoff: checkpoint(1) });
  await h.db.query("UPDATE cases SET submitted_on='2026-11-02',decision_due='2026-11-24',reminded_on='2026-11-01' WHERE id=17");
  h.interleave(async ({ number, db }) => { await db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=17", [checkpoint(number + 5)]); });
  const result = await h.save({ _stage: 'Подано', _submittedOn: '2026-11-03', _handoff: null });
  const row = await h.row();
  assert.equal(h.queries.filter(sql => sql.includes('UPDATE cases SET data=')).length, 1);
  assert.deepEqual(row.data._handoff, checkpoint(6));
  assert.equal(asDate(row.submitted_on), '2026-11-03'); assert.equal(asDate(row.decision_due), '2026-11-25');
  assert.equal(row.data._decisionDue, '2026-11-25'); assert.equal(row.reminded_on, null); assert.equal(result.decisionDue, '2026-11-25');
}));

for (const data of [[], [{ _handoff: { injected: true } }], '', '{"_handoff":{"injected":true}}', 0, 42, false, true]) {
  test('malformed checklist data is rejected before any checkpoint mutation: ' + JSON.stringify(data), pg, async () => fixture(async h => {
    const original = { _stage: 'Сбор документов', _handoff: checkpoint(2), document: { s: 'yes' } };
    await h.seed(original);
    const { status, result } = await h.rawSave(data);
    assert.equal(status, 400); assert.equal(result.ok, false);
    assert.deepEqual((await h.row()).data, original);
    assert.equal(h.queries.some(sql => /^UPDATE cases SET data=/.test(sql)), false);
  }));
}

test('null retains the legacy empty-answer save while preserving the internal handoff checkpoint', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _handoff: checkpoint(2), oldAnswer: { s: 'yes' } });
  await h.save(null);
  const row = await h.row();
  assert.deepEqual(row.data, { _handoff: checkpoint(2) }); assert.equal(row.done, 1); assert.equal(row.total, 4);
}));

test('unrelated Telegram checklist updates preserve a Mac note written during the save', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _comment: 'Исходная заметка', _handoff: checkpoint(2) });
  h.interleave(async ({ number, db }) => {
    if (number === 1) {
      await db.query("UPDATE cases SET data=data || jsonb_build_object('_comment','Заметка с Мака','_workspaceNote',true) WHERE id=17");
    }
  });
  const result = await h.save({
    _stage: 'Подано', _submittedOn: '2026-11-02', _comment: 'Исходная заметка', document: { s: 'yes' },
  }, { expectedNote: 'Исходная заметка' });
  const row = await h.row();
  assert.equal(row.data._comment, 'Заметка с Мака');
  assert.equal(result.note, 'Заметка с Мака');
  assert.equal(row.data._decisionDue, '2026-11-24');
  assert.deepEqual(row.data._handoff, checkpoint(2));
  assert.deepEqual(row.data.document, { s: 'yes' });
}));

test('competing Telegram note edits return the saved note and leave the draft unresolved', pg, async () => fixture(async h => {
  await h.seed({ _stage: 'Сбор документов', _comment: 'Уже изменено на Маке', _workspaceNote: true });
  const pending = { _stage: 'Сбор документов', _comment: 'Правка в Telegram' };
  for (const version of [{}, { expectedNote: 'Устаревший текст' }]) {
    const result = await h.rawSave(pending, version);
    assert.equal(result.status, 409);
    assert.equal(result.result.code, 'note_conflict');
    assert.equal(result.result.note, 'Уже изменено на Маке');
    assert.equal((await h.row()).data._comment, 'Уже изменено на Маке');
  }
  const saved = await h.save({ ...pending, _workspaceNote: false }, { expectedNote: 'Уже изменено на Маке' });
  assert.equal(saved.note, 'Правка в Telegram');
  assert.deepEqual((await h.row()).data, { ...pending, _workspaceNote: true });
}));

test('typing a note while an unrelated Telegram save is in flight keeps the draft and reports a Mac edit', async () => {
  const start = source.indexOf('function checklistClient()');
  const end = source.indexOf('\n  render();\n  loadReminders();', start);
  assert.ok(start >= 0 && end > start);
  // Run the actual inline save code. Stop before rendering the full checklist.
  const elements = new Map(), storage = new Map();
  const requests = [];
  let respond;
  const client = vm.runInNewContext('(' + source.slice(start, end) + `
    return {
      flush,
      changeAnswer() { D.answer = { s: 'yes' }; changed(); },
      typeNote(value) { D._comment = value; changed(); },
      state() { return { draft: D._comment, base: noteBase, conflict: noteConflict }; },
    };
  })()`, {
    window: {
      addEventListener() {},
      __CFG: { data: { _comment: 'А' }, list: { sections: [], passport: [] }, caseInfo: { id: 17 } },
    },
    document: {
      documentElement: { dataset: {} }, addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {} });
        return elements.get(id);
      },
    },
    location: { search: '' },
    localStorage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    setTimeout() {}, clearTimeout() {}, clearInterval() {},
    fetch(url, options) {
      requests.push(JSON.parse(options.body));
      return new Promise(resolve => { respond = resolve; });
    },
  });
  client.changeAnswer();
  const saving = client.flush();
  assert.equal(requests[0].expectedNote, 'А');
  client.typeNote('В');
  respond({ status: 200, headers: { get() {} }, text: async () => JSON.stringify({ ok: true, note: 'Б' }) });
  await saving;
  assert.deepEqual({ ...client.state() }, { draft: 'В', base: 'А', conflict: 'Б' });
  assert.equal(JSON.parse(storage.get('zamery_cl_17')).d._comment, 'В');
  assert.match(elements.get('st').textContent, /Заметка изменилась/);
  await client.flush();
  assert.equal(requests.length, 1);
});


test('a stale checklist response freezes autosave and explicit recovery keeps a local copy before refreshing', async () => {
  const start = source.indexOf('function checklistClient()');
  const end = source.indexOf('\n  render();\n  loadReminders();', start);
  const elements = new Map(), storage = new Map(), requests = [];
  let refreshed = 0, downloads = 0;
  const location = { search: '', reload() { refreshed++; } };
  const client = vm.runInNewContext('(' + source.slice(start, end) + `
    return { flush, edit() { D.answer = {s:'ok'}; changed(); } };
  })()`, {
    window: { addEventListener() {}, location, __CFG: { data: {}, list: { sections: [], passport: [] }, caseInfo: { id: 17, revision: 3 } } },
    document: {
      documentElement: { dataset: {} }, addEventListener() {},
      createElement() { return { click() { downloads++; } }; },
      getElementById(id) { if (!elements.has(id)) elements.set(id, { style: {} }); return elements.get(id); },
    },
    location, Blob, URL: { createObjectURL() { return 'blob:qa'; }, revokeObjectURL() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout() {}, clearTimeout() {}, clearInterval() {},
    async fetch(url, options) {
      requests.push(JSON.parse(options.body));
      return { status: 409, headers: { get() {} }, text: async () => JSON.stringify({ ok:false, code:'checklist_conflict', revision:4, error:'Changed in another tab' }) };
    },
  });
  client.edit(); await client.flush(); await client.flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].expectedRevision, 3);
  assert.match(elements.get('st').textContent, /актуальные ответы/);
  elements.get('st').onclick();
  assert.equal(downloads, 1); assert.equal(refreshed, 1);
  assert.equal(storage.has('zamery_cl_17'), false);
  assert.equal(JSON.parse(storage.get('zamery_cl_17:recovery')).data.answer.s, 'ok');
});

function autosaveClient({ data = {}, revision = 0, storage = new Map() } = {}) {
  const start = source.indexOf('function checklistClient()');
  const end = source.indexOf('\n  render();\n  loadReminders();', start);
  const elements = new Map(), events = new Map(), requests = [], timers = new Map(), alerts = [];
  let serial = 0;
  const location = { search: '', href: '' };
  const client = vm.runInNewContext('(' + source.slice(start, end) + `
    return { flush, edit(value) { D.answer = value; changed(); }, note(value) { D._comment = value; changed(); }, data() { return D; } };
  })()`, {
    window: { addEventListener: (name, fn) => events.set(name, fn), location,
      __CFG: { data: structuredClone(data), list: { sections: [], passport: [] }, caseInfo: { id: 17, revision } } },
    document: { documentElement: { dataset: {} }, addEventListener() {},
      getElementById(id) { if (!elements.has(id)) elements.set(id, { style: {} }); return elements.get(id); } },
    location, AbortController, alert: message => alerts.push(message),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {}, clearInterval() {},
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, body: JSON.parse(options.body), signal: options.signal, resolve, reject })); },
  });
  return { client, requests, storage, elements, events, location, alerts,
    respond(index, body = { ok: true, note: '', revision: index + 1 }, status = 200) {
      requests[index].resolve({ status, headers: { get() {} }, text: async () => JSON.stringify(body), json: async () => body });
    },
    async tick(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } await new Promise(setImmediate); },
  };
}

test('a newer edit before the previous ACK keeps its backup and saves after the ACK without waiting for the old debounce', async () => {
  const h = autosaveClient(); h.client.edit('A'); const first = h.client.flush();
  h.client.edit('B'); h.respond(0); await first;
  assert.equal(JSON.parse(h.storage.get('zamery_cl_17')).d.answer, 'B');
  assert.notEqual(h.elements.get('st').textContent, 'Сохранено');
  await h.tick(400); assert.equal(h.requests.length, 2); assert.equal(h.requests[1].body.data.answer, 'B');
  assert.equal(h.requests[1].body.expectedRevision, 1);
  h.respond(1); await new Promise(setImmediate);
  assert.equal(h.elements.get('st').textContent, 'Сохранено'); assert.equal(h.storage.has('zamery_cl_17'), false);
});

test('pagehide during the second save and immediate reopen recover B from its current acknowledged revision', async () => {
  const h = autosaveClient(); h.client.edit('A'); const first = h.client.flush();
  h.client.edit('B'); h.respond(0); await first;
  h.events.get('pagehide')(); assert.equal(h.requests[1].body.data.answer, 'B');
  const reopened = autosaveClient({ data: { answer: 'A' }, revision: 1, storage: h.storage });
  assert.equal(reopened.client.data().answer, 'B'); const save = reopened.client.flush();
  assert.equal(reopened.requests[0].body.data.answer, 'B'); assert.equal(reopened.requests[0].body.expectedRevision, 1);
  reopened.respond(0, { ok: true, note: '', revision: 2 }); await save;
  assert.equal(h.storage.has('zamery_cl_17'), false);
});

for (const failure of ['network', 'forbidden', 'conflict']) test('printing after a '+failure+' save cannot discard the newer draft or open stale server answers', async () => {
  const h = autosaveClient(); h.client.edit('A'); const printing = h.elements.get('printBtn').onclick();
  h.client.edit('B');
  if (failure === 'network') h.requests[0].reject(new Error('Offline'));
  else h.respond(0, { ok: false, code: failure === 'conflict' ? 'checklist_conflict' : 'forbidden', error: 'Synthetic save refusal', revision: 4 }, failure === 'conflict' ? 409 : 403);
  await printing; await new Promise(setImmediate);
  assert.equal(h.requests.length, 1); assert.equal(h.location.href, '');
  assert.equal(JSON.parse(h.storage.get('zamery_cl_17')).d.answer, 'B');
  assert.notEqual(h.elements.get('st').textContent, 'Сохранено'); assert.equal(h.alerts.length, 1);
});

test('printing waits for edits during the save and the print-link request, sharing an existing save', async () => {
  const h = autosaveClient(); h.client.edit('A'); const initial = h.client.flush();
  const printing = h.elements.get('printBtn').onclick(); h.client.edit('B');
  assert.equal(h.requests.length, 1); assert.equal(h.location.href, '');
  h.respond(0); await initial; await new Promise(setImmediate);
  assert.equal(h.requests[1].url, '/api/checklist/save'); assert.equal(h.requests[1].body.data.answer, 'B');
  h.respond(1); await new Promise(setImmediate);
  assert.equal(h.requests[2].url, '/api/checklist/printlink');
  h.client.edit('C'); h.respond(2, { ok: true, url: 'https://bot.example/checklist?case_id=17&print=1' });
  await new Promise(setImmediate);
  assert.equal(h.requests[3].url, '/api/checklist/save'); assert.equal(h.requests[3].body.data.answer, 'C');
  assert.equal(h.location.href, ''); h.respond(3, { ok: true, note: '', revision: 3 }); await printing;
  assert.equal(h.location.href, 'https://bot.example/checklist?case_id=17&print=1');
  assert.equal(h.storage.has('zamery_cl_17'), false);
});

for (const stage of ['fetch', 'body']) test('a stalled save '+stage+' releases printing and retains the draft for an online retry', async () => {
  const h = autosaveClient(); h.client.edit('A'); const printing = h.elements.get('printBtn').onclick(); h.client.edit('B');
  let lateBody;
  if (stage === 'body') h.requests[0].resolve({ status: 200, headers: { get() {} }, text: () => new Promise(resolve => { lateBody = resolve; }) });
  await new Promise(setImmediate); await h.tick(30000);
  assert.equal(h.elements.get('printBtn').disabled, false); await printing;
  assert.equal(h.location.href, ''); assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(JSON.parse(h.storage.get('zamery_cl_17')).d.answer, 'B');
  assert.match(h.elements.get('st').textContent, /Не сохранено/);
  if (lateBody) lateBody(JSON.stringify({ ok: true, note: '', revision: 99 })); else h.respond(0, { ok: true, note: '', revision: 99 });
  await new Promise(setImmediate); assert.notEqual(h.elements.get('st').textContent, 'Сохранено');
  h.events.get('online')(); assert.equal(h.requests[1].body.expectedRevision, 0); assert.equal(h.requests[1].body.data.answer, 'B');
  h.respond(1, { ok: true, note: '', revision: 1 }); await new Promise(setImmediate);
  assert.equal(h.elements.get('st').textContent, 'Сохранено'); assert.equal(h.storage.has('zamery_cl_17'), false);
});

for (const stage of ['fetch', 'body']) test('a stalled print-link '+stage+' times out without navigation or losing a newer edit', async () => {
  const h = autosaveClient(); const printing = h.elements.get('printBtn').onclick(); await new Promise(setImmediate);
  assert.equal(h.requests[0].url, '/api/checklist/printlink'); h.client.edit('B');
  if (stage === 'body') h.requests[0].resolve({ json: () => new Promise(() => {}) });
  await new Promise(setImmediate); await h.tick(30000);
  assert.equal(h.elements.get('printBtn').disabled, false); await printing;
  assert.equal(h.location.href, ''); assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(JSON.parse(h.storage.get('zamery_cl_17')).d.answer, 'B'); assert.equal(h.alerts.length, 1);
});

test('reopening after a note commit with lost ACK adopts the acknowledged current server baseline', pg, async () => fixture(async db => {
  await db.seed({ _comment: 'B already committed' });
  const storage = new Map([['zamery_cl_17', JSON.stringify({ t: Date.now(), d: { _comment: 'B already committed' }, noteBase: 'A previous baseline', revision: 0 })]]);
  const h = autosaveClient({ data: { _comment: 'B already committed' }, storage });
  await h.client.flush(); h.client.note('C next edit'); const pending = h.client.flush();
  const request = h.requests[0].body;
  const result = await db.rawSave(request.data, { expectedNote: request.expectedNote, expectedRevision: request.expectedRevision });
  h.respond(0, result.result, result.status); await pending;
  assert.equal(result.status, 200); assert.equal((await db.row()).data._comment, 'C next edit');
}));

test('a reopened already-committed checklist snapshot adopts the current revision without a false conflict', async () => {
  const data = { answer: 'B already committed', detail: { a: 'one', z: { a: 1, b: 2 } } };
  const reordered = { detail: { z: { b: 2, a: 1 }, a: 'one' }, answer: 'B already committed' };
  const storage = new Map([['zamery_cl_17', JSON.stringify({ t: Date.now(), d: reordered, noteBase: '', revision: 0 })]]);
  const h = autosaveClient({ data, revision: 1, storage });
  assert.equal(await h.client.flush(), true); assert.equal(h.requests.length, 0);
  h.client.edit('C next edit'); const pending = h.client.flush();
  assert.equal(h.requests[0].body.expectedRevision, 1); h.respond(0, { ok: true, note: '', revision: 2 }); await pending;
  assert.equal(h.storage.has('zamery_cl_17'), false);
});

test('matching notes never acknowledge different checklist answers or missing server-protected fields', async () => {
  for (const data of [{ _comment: 'Same note', answer: 'New server answer' }, { _comment: 'Same note', answer: 'Old local answer', _workspaceNote: true }]) {
    const local = { _comment: 'Same note', answer: 'Old local answer' };
    const storage = new Map([['zamery_cl_17', JSON.stringify({ t: Date.now(), d: local, noteBase: 'Same note', revision: 0 })]]);
    const h = autosaveClient({ data, revision: 1, storage });
    assert.equal(await h.client.flush(), false); assert.equal(h.requests.length, 0);
    assert.equal(JSON.parse(storage.get('zamery_cl_17')).d.answer, 'Old local answer');
    assert.match(h.elements.get('st').textContent, /другом окне/);
  }
});
