import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LicenseWorker, initializeState, classifyApiFailure, prepareSecrets, FsrarClient } from './runtime.mjs';
import { convertUpdate } from './telegram.mjs';
import { initialState, addJob, createStore, hash } from './state.mjs';
import { REGISTRY_HEADERS } from './google.mjs';

const NOW='2026-11-01T07:00:00.000Z';
const CONFIG={spreadsheetId:'fixture-registry',sheetName:'Реестр лицензий',timeZone:'Europe/Moscow'};
const TARGET='-1005164597211';
const INN='9705148570';
const LICENSE={inn:INN,kpp:'770501001',licenseNumber:'77РПО0021680',issueDate:'2026-10-31',
  expiryDate:'2027-10-30',activity:'Розничная продажа, общепит',address:'Москва, пер. Средний Овчинниковский, д. 3',
  status:'действующая',changeDate:'2026-10-31',email:'fixture@example.test'};
const envelope=(items=[LICENSE])=>({http_status:200,response:{items}});
const clone=(v)=>structuredClone(v);
function error(code){return Object.assign(new Error(code),{code});}
function update(id=10,messageId=42,extras={}){
  return {update_id:id,message:{message_id:messageId,date:Date.parse('2026-10-31T10:00:00+03:00')/1000,
    chat:{id:Number(TARGET),type:'supergroup'},from:{id:88,first_name:'Менеджер'},
    text:`ООО «ХОРОШОТ» положительно. Решение о выдаче лицензии. ИНН ${INN}`,...extras}};
}
const convert=(u)=>convertUpdate(u,{targetChatId:TARGET});
function editedUpdate(id,messageId,text){
  const result=update(id,messageId,{text,edit_date:Date.parse(NOW)/1000});
  result.edited_message=result.message;delete result.message;return result;
}
function existingRow(){
  const row=Array(17).fill('');
  Object.assign(row,{0:'internal-link',1:'Партнёр',2:'15000',3:'Документы',4:'ООО «ХОРОШОТ»',
    5:'Бренд',6:INN,8:LICENSE.issueDate,9:LICENSE.expiryDate,10:'Общепит ',11:LICENSE.address,
    12:'Контакт',13:'+70000000000',14:'Клиентский чат',16:'Ручной комментарий'});
  return row;
}

// This fake is an independent remote sheet boundary: state operations never
// mutate it, and a receipt is produced from the actual remote cell values only.
class Sheet {
  constructor(values){this.values=clone(values);this.applyCalls=[];this.writes=0;this.contextCalls=0;}
  async context(){this.contextCalls++;return {values:clone(this.values),startRow:1};}
  async applyPlan(plan,job){
    this.applyCalls.push(clone(plan));
    const {hash:signature,createdAt,...unsigned}=plan;
    assert.equal(hash(unsigned),signature);
    if(this.failBefore){const code=this.failBefore;this.failBefore=null;throw error(code);}
    const index=plan.rowNumber-1;
    const row=this.values[index]??Array(17).fill('');
    const allMatch=Object.entries(plan.expectedCells).every(([cell,value])=>String(row[cell.charCodeAt(0)-65]??'')===String(value));
    if(!allMatch){
      if(row[6]&&row[6]!==job.inn)throw error('sheet_plan_stale');
      for(const u of plan.updates){
        const before=String(row[u.columnIndex]??'');
        if(before!==String(u.before)&&before!==String(u.after))throw error('sheet_plan_stale');
      }
      for(const u of plan.updates)row[u.columnIndex]=u.after;
      this.values[index]=row;this.writes++;
    }
    if(this.failAfter){const code=this.failAfter;this.failAfter=null;throw error(code);}
    const cells=Object.fromEntries(Object.keys(plan.expectedCells).map((cell)=>[cell,row[cell.charCodeAt(0)-65]??'']));
    return {verified:true,planHash:plan.hash,spreadsheetId:CONFIG.spreadsheetId,sheetName:CONFIG.sheetName,
      verifiedAt:this.now().toISOString(),cells};
  }
}
async function harness(t,{append=false,request}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'license-runtime-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const clock={value:NOW};const now=()=>new Date(clock.value);
  const file=path.join(dir,'private','state.json');
  const store=await initializeState(file,CONFIG,{},now);
  const google=new Sheet(append?[[...REGISTRY_HEADERS]]:[[...REGISTRY_HEADERS],existingRow()]);google.now=now;
  const api={calls:[],validations:0,async validate(){this.validations++;},async request(method,job){
    this.calls.push({method,job:clone(job)});return request?request(method,job,this.calls.length):envelope();}};
  const reports=[];
  const makeWorker=(extra={})=>new LicenseWorker({store,google,api,config:CONFIG,now,report:(event)=>reports.push(event),...extra});
  return {dir,file,store,google,api,reports,clock,now,makeWorker,worker:makeWorker()};
}

test('durable Bot API inbox survives restart and completes fetch → plan → actual cell readback → ack',async(t)=>{
  const h=await harness(t);
  const saved=await h.worker.persistUpdates([update()],convert);
  assert.deepEqual(saved,{count:1,offset:11});
  assert.equal(h.api.calls.length,0);assert.equal(h.google.writes,0);
  const onDisk=await createStore(h.file).read();
  assert.equal(onDisk.telegram.inbox[0].message.id,42);assert.equal(onDisk.telegram.offset,11);
  const original=clone(h.google.values[1]);
  await h.makeWorker().tick();
  const state=await h.store.read();const jobs=Object.values(state.jobs);
  assert.equal(jobs.length,1);assert.equal(jobs[0].status,'done');
  assert.equal(jobs[0].sourceEventKey,'telegram:5164597211:42');
  assert.equal(state.telegram.inbox.length,0);assert.equal(state.api.attemptedCalls,1);
  assert.equal(h.api.calls.length,1);assert.equal(h.api.calls[0].job.inn,INN);
  assert.equal(h.google.values[1][7],LICENSE.licenseNumber);assert.equal(h.google.values[1][15],LICENSE.email);
  for(const i of [0,1,2,3,5,12,13,14,16])assert.equal(h.google.values[1][i],original[i]);
  assert.equal(jobs[0].receipt.verified,true);
  for(const [cell,value] of Object.entries(jobs[0].plan.expectedCells))assert.equal(jobs[0].receipt.cells[cell],value);
  assert.equal(state.journal.filter((entry)=>entry.type==='write_verified').length,1);
  assert.equal(h.reports.filter((event)=>event.type==='write_verified').length,1);
});

test('out-of-order updates persist every target message, ignore other chats, and advance offset atomically',async(t)=>{
  const h=await harness(t);
  const batch=[update(12,44),update(10,42),update(11,43,{chat:{id:-1009999999,type:'supergroup'}})];
  assert.deepEqual(await h.worker.persistUpdates(batch,convert),{count:2,offset:13});
  const state=await h.store.read();
  assert.deepEqual(state.telegram.inbox.map((item)=>item.message.id),[42,44]);
  assert.equal((await h.worker.persistUpdates(batch,convert)).count,0);
  assert.equal((await h.store.read()).telegram.inbox.length,2);
  assert.deepEqual(batch.map((item)=>item.update_id),[12,10,11]);
});

test('failed conversion or invalid batch never acknowledges or partly saves Telegram updates',async(t)=>{
  const h=await harness(t);const before=await h.store.read();
  await assert.rejects(h.worker.persistUpdates([update(10,42),update(11,43)],(u)=>{
    if(u.update_id===11)throw error('invalid_update_date');return convert(u);
  }),{code:'invalid_update_date'});
  assert.deepEqual(await h.store.read(),before);
  await assert.rejects(h.worker.persistUpdates([update(),{update_id:-1}],convert),/invalid_telegram_updates/u);
  assert.deepEqual(await h.store.read(),before);
});

test('source and document replay after completion do not fetch or append again',async(t)=>{
  const h=await harness(t,{append:true});
  const document={file_unique_id:'one-decision',file_id:'not-used'};
  await h.worker.persistUpdates([update(10,42,{document})],convert);await h.worker.tick();
  assert.equal(h.google.values.length,2);assert.equal(h.google.writes,1);
  const restarted=h.makeWorker();
  await restarted.persistUpdates([update(11,42,{document}),update(12,43,{document})],convert);await restarted.tick();
  const state=await h.store.read();
  assert.equal(Object.keys(state.jobs).length,1);assert.equal(h.api.calls.length,1);assert.equal(h.google.writes,1);
  assert.equal(state.journal.filter((entry)=>entry.type==='write_verified').length,1);
  assert.equal(Object.values(state.jobs)[0].sourceReviewRequired,undefined);
});

test('a corrected INN edit stops an existing waiting job without replacing its original identity',async(t)=>{
  const h=await harness(t);
  await h.worker.persistUpdates([update()],convert);await h.worker.ingestInbox(await h.google.context());
  const original=Object.values((await h.store.read()).jobs)[0];
  const corrected='ООО «Другая организация» положительно. Решение о выдаче лицензии. ИНН 7707083893';
  await h.worker.persistUpdates([editedUpdate(11,42,corrected)],convert);await h.worker.tick();
  let state=await h.store.read();let job=state.jobs[original.id];
  assert.equal(job.status,'review');assert.equal(job.reason,'source_message_edited');
  assert.equal(job.inn,INN);assert.equal(job.organization,original.organization);assert.equal(job.sourceText,original.sourceText);
  assert.equal(job.sourceReviewRequired,true);assert.equal(job.sourceReviewReason,'source_message_edited');
  assert.equal(job.latestSourceEdit.proposedInn,'7707083893');assert.equal(job.latestSourceEdit.text,corrected);
  assert.equal(h.api.calls.length,0);assert.equal(h.google.writes,0);
  // A replay of the old positive text must not auto-resolve this review.
  await h.worker.persistUpdates([update(12,42)],convert);await h.worker.tick();
  state=await h.store.read();job=state.jobs[original.id];assert.equal(job.status,'review');
  assert.equal(state.journal.filter((entry)=>entry.type==='source_message_edited').length,1);
  assert.equal(h.api.calls.length,0);
});

test('a negative edit quarantines a planned write while preserving its plan and API evidence',async(t)=>{
  const h=await harness(t);h.google.failBefore='google_network_error';
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  const original=Object.values((await h.store.read()).jobs)[0];assert.equal(original.status,'planned');
  await h.worker.persistUpdates([editedUpdate(11,42,'Решение отрицательное, получен отказ')],convert);
  await h.worker.tick();const job=(await h.store.read()).jobs[original.id];
  assert.equal(job.status,'review');assert.equal(job.reason,'source_message_edited');
  assert.deepEqual(job.plan,original.plan);assert.deepEqual(job.apiItems,original.apiItems);
  assert.deepEqual(job.selectedLicense,original.selectedLicense);assert.equal(job.sourceText,original.sourceText);
  assert.equal(h.api.calls.length,1);assert.equal(h.google.writes,0);assert.equal(h.google.applyCalls.length,1);
});

test('an edit arriving during the API request is consumed before any Google write',async(t)=>{
  let h;
  h=await harness(t,{request:async()=>{
    await h.worker.persistUpdates([editedUpdate(11,42,'Положительное сообщение ошибочное, лицензия не получена')],convert);
    return envelope();
  }});
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  const state=await h.store.read();const job=Object.values(state.jobs)[0];
  assert.equal(job.status,'review');assert.equal(job.reason,'source_message_edited');
  assert.equal(job.apiItems.length,1);assert.equal(job.attempts,1);
  assert.equal(h.google.writes,0);assert.equal(h.google.applyCalls.length,0);
});

test('editing a completed source flags owner review without undoing the receipt or repeating API/Google writes',async(t)=>{
  const h=await harness(t);
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  const original=Object.values((await h.store.read()).jobs)[0];assert.equal(original.status,'done');
  await h.worker.persistUpdates([editedUpdate(11,42,'Сообщение ошибочное, лицензия не получена')],convert);
  await h.worker.tick();let job=(await h.store.read()).jobs[original.id];
  assert.equal(job.status,'done');assert.equal(job.sourceReviewRequired,true);
  assert.equal(job.sourceReviewReason,'source_message_edited');assert.deepEqual(job.receipt,original.receipt);
  assert.deepEqual(job.plan,original.plan);assert.equal(h.api.calls.length,1);assert.equal(h.google.writes,1);
  await h.worker.persistUpdates([editedUpdate(12,42,'Сообщение ошибочное, лицензия не получена')],convert);
  await h.worker.tick();const state=await h.store.read();job=state.jobs[original.id];
  assert.equal(job.status,'done');assert.equal(state.journal.filter((entry)=>entry.type==='source_message_edited').length,1);
  assert.equal(h.api.calls.length,1);assert.equal(h.google.writes,1);
});

test('an unchanged edit with whitespace formatting preserves ordinary source deduplication',async(t)=>{
  const h=await harness(t);
  await h.worker.persistUpdates([update()],convert);await h.worker.ingestInbox(await h.google.context());
  const text=update().message.text.replaceAll(' ','  ');
  await h.worker.persistUpdates([editedUpdate(11,42,text)],convert);await h.worker.tick();
  const job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'done');assert.equal(job.sourceReviewRequired,undefined);assert.equal(h.api.calls.length,1);
});

test('an unresolved positive message is retained for review and never requests a guessed INN',async(t)=>{
  const h=await harness(t);
  await h.worker.persistUpdates([update(10,42,{text:'Неизвестная компания положительно'})],convert);
  await h.worker.tick();
  const job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'review');assert.equal(job.reason,'organization_not_identified');
  assert.equal(h.api.calls.length,0);assert.equal(h.google.writes,0);
});

test('a stale API record stays waiting until the next morning and never reaches Google writes',async(t)=>{
  const h=await harness(t,{request:()=>envelope([{...LICENSE,issueDate:'2026-04-17',changeDate:'2026-04-17'}])});
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  const job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'waiting');assert.equal(job.reason,'registry_has_not_reflected_event');
  assert.equal(job.nextCheckAt,'2026-11-02T06:00:00.000Z');
  assert.equal(h.api.calls.length,1);assert.equal(h.google.applyCalls.length,0);
  await h.worker.tick();assert.equal(h.api.calls.length,1);
});

test('each tick has its own stable three-call budget while following ticks continue pending jobs quietly',async(t)=>{
  const h=await harness(t);
  await h.worker.persistUpdates(Array.from({length:7},(_,n)=>update(10+n,42+n)),convert);
  await h.worker.tick();
  let state=await h.store.read();
  assert.equal(h.api.calls.length,3);assert.equal(h.api.validations,3);
  assert.equal(Object.values(state.jobs).filter((job)=>job.status==='done').length,3);
  assert.equal(Object.values(state.jobs).filter((job)=>job.status==='waiting'&&job.attempts===0).length,4);
  assert.deepEqual(Object.values(state.api.runs),[3]);
  await h.makeWorker().tick();state=await h.store.read();
  assert.equal(h.api.calls.length,6);assert.deepEqual(Object.values(state.api.runs),[3,3]);
  await h.makeWorker().tick();state=await h.store.read();
  assert.equal(h.api.calls.length,7);assert.deepEqual(Object.values(state.api.runs),[3,3,1]);
  assert.equal(Object.values(state.jobs).filter((job)=>job.status==='done').length,7);
  assert.equal(h.reports.filter((event)=>event.type==='processing_error').length,0);
});

test('ten daily calls defer untouched waiting events exactly once until the next Moscow morning',async(t)=>{
  const h=await harness(t);
  await h.worker.persistUpdates(Array.from({length:12},(_,n)=>update(10+n,42+n)),convert);
  for(const total of [3,6,9,10]){await h.worker.tick();assert.equal(h.api.calls.length,total);}
  let state=await h.store.read();
  const waiting=Object.values(state.jobs).filter((job)=>job.status==='waiting');
  assert.equal(state.api.daily['2026-11-01'],10);assert.equal(waiting.length,2);
  assert.ok(waiting.every((job)=>job.attempts===0&&job.reason==='api_daily_limit_reached'&&job.nextCheckAt==='2026-11-02T06:00:00.000Z'));
  assert.equal(state.journal.filter((entry)=>entry.type==='api_budget_deferred').length,2);
  await h.makeWorker().tick();state=await h.store.read();
  assert.equal(h.api.calls.length,10);assert.equal(h.api.validations,10);
  assert.equal(state.journal.filter((entry)=>entry.type==='api_budget_deferred').length,2);
  assert.equal(h.reports.filter((event)=>event.type==='processing_error').length,0);
  h.clock.value='2026-11-02T06:00:00.000Z';await h.makeWorker().tick();state=await h.store.read();
  assert.equal(h.api.calls.length,12);assert.equal(state.api.daily['2026-11-02'],2);
  assert.equal(Object.values(state.jobs).filter((job)=>job.status==='done').length,12);
});

test('the total quota reserve stops before another call and routes remaining events to review without counting attempts',async(t)=>{
  const h=await harness(t);
  await h.store.update((state)=>{state.api.attemptedCalls=79;});
  await h.worker.persistUpdates(Array.from({length:5},(_,n)=>update(10+n,42+n)),convert);
  await h.worker.tick();let state=await h.store.read();
  assert.equal(h.api.calls.length,1);assert.equal(h.api.validations,1);assert.equal(state.api.attemptedCalls,80);
  const review=Object.values(state.jobs).filter((job)=>job.status==='review');
  assert.equal(review.length,4);assert.ok(review.every((job)=>job.reason==='insufficient_api_quota'&&job.attempts===0));
  assert.equal(Object.values(state.jobs).filter((job)=>job.status==='done').length,1);
  const failures=state.journal.filter((entry)=>entry.type==='processing_failed').length;
  await h.makeWorker().tick();state=await h.store.read();
  assert.equal(h.api.calls.length,1);assert.equal(state.journal.filter((entry)=>entry.type==='processing_failed').length,failures);
  assert.equal(h.reports.filter((event)=>event.type==='processing_error').length,0);
});

test('a planned Google write completes while API calls are blocked and newer events wait without error spam',async(t)=>{
  const h=await harness(t);h.google.failBefore='google_network_error';
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  const original=Object.values((await h.store.read()).jobs)[0];assert.equal(original.status,'planned');
  await h.worker.persistUpdates([update(11,43),update(12,44)],convert);
  await h.store.update((state)=>{state.api.blocked={code:'access_ip_blocked',at:NOW};});
  const errors=h.reports.filter((event)=>event.type==='processing_error').length;
  await h.makeWorker().tick();const state=await h.store.read();
  assert.equal(state.jobs[original.id].status,'done');assert.equal(h.api.calls.length,1);
  assert.equal(Object.values(state.jobs).filter((job)=>job.status==='waiting'&&job.attempts===0).length,2);
  assert.equal(h.reports.filter((event)=>event.type==='processing_error').length,errors);
});

test('an event already at maximum attempts needs review without validating or reserving another request',async(t)=>{
  const h=await harness(t);
  await h.worker.persistUpdates([update()],convert);await h.worker.ingestInbox(await h.google.context());
  await h.store.update((state)=>{Object.values(state.jobs)[0].attempts=7;state.api.attemptedCalls=7;});
  await h.worker.tick();const state=await h.store.read();const job=Object.values(state.jobs)[0];
  assert.equal(job.status,'review');assert.equal(job.reason,'maximum_attempts_reached');assert.equal(job.attempts,7);
  assert.equal(state.api.attemptedCalls,7);assert.equal(h.api.calls.length,0);assert.equal(h.api.validations,0);
  assert.equal(h.reports.filter((event)=>event.type==='processing_error').length,0);
});

test('an IP failure blocks the API globally without losing the second queued event',async(t)=>{
  const h=await harness(t,{request:()=>({http_status:403,error:'Доступ с данного IP запрещен'})});
  await h.worker.persistUpdates([update(10,42),update(11,43)],convert);await h.worker.tick();
  const state=await h.store.read();
  assert.equal(state.api.blocked.code,'access_ip_blocked');assert.equal(h.api.calls.length,1);
  assert.deepEqual(Object.values(state.jobs).map((job)=>job.status).sort(),['blocked','waiting']);
  assert.equal(h.google.applyCalls.length,0);
  await h.worker.tick();assert.equal(h.api.calls.length,1);
});

test('a committed append with lost readback retries the exact saved plan and acknowledges without another append',async(t)=>{
  const h=await harness(t,{append:true});h.google.failAfter='google_network_error';
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  let job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'planned');const originalHash=job.plan.hash;
  assert.equal(h.google.writes,1);assert.equal(h.google.values.length,2);
  assert.equal(h.reports.filter((event)=>event.type==='write_verified').length,0);
  await h.makeWorker().tick();job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'done');assert.equal(job.receipt.planHash,originalHash);
  assert.deepEqual(h.google.applyCalls.map((plan)=>plan.hash),[originalHash,originalHash]);
  assert.equal(h.google.writes,1);assert.equal(h.google.values.length,2);assert.equal(h.api.calls.length,1);
});

test('a failed Google call preserves its pending plan and a fresh worker retries without another API request',async(t)=>{
  const h=await harness(t);h.google.failBefore='google_access_denied';
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  let job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'planned');assert.equal(job.lastWriteError,'google_access_denied');
  const originalHash=job.plan.hash;assert.equal(h.google.writes,0);
  await h.makeWorker().tick();job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'done');assert.equal(job.plan.hash,originalHash);assert.equal(h.api.calls.length,1);
});

test('a definite stale row is replanned once from live Google and keeps another company untouched',async(t)=>{
  const h=await harness(t);h.google.failBefore='google_network_error';
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  const prior=Object.values((await h.store.read()).jobs)[0];assert.equal(prior.plan.rowNumber,2);
  const unrelated=existingRow();unrelated[4]='Другая организация';unrelated[6]='7707083893';
  h.google.values.splice(1,0,unrelated);
  await h.makeWorker().tick();const job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'done');assert.equal(job.plan.rowNumber,3);
  assert.deepEqual(h.google.values[1],unrelated);assert.equal(h.google.values[2][7],LICENSE.licenseNumber);
  assert.equal(h.api.calls.length,1);
});

test('a crash after reserving the API call is recovered after its lease without refunding the attempt',async(t)=>{
  const h=await harness(t,{request:(_method,_job,n)=>{if(n===1)throw error('worker_interrupted');return envelope();}});
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  let job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'fetching');assert.equal(job.attempts,1);
  h.clock.value='2026-11-01T07:01:59.999Z';await h.makeWorker().tick();assert.equal(h.api.calls.length,1);
  h.clock.value='2026-11-01T07:02:00.000Z';await h.makeWorker().tick();
  const state=await h.store.read();job=Object.values(state.jobs)[0];
  assert.equal(job.status,'done');assert.equal(job.attempts,2);assert.equal(state.api.attemptedCalls,2);
  assert.equal(state.journal.filter((entry)=>entry.type==='api_fetch_recovered').length,1);
});

test('invalid Google receipt never completes a job or creates a success report',async(t)=>{
  const h=await harness(t);const original=h.google.applyPlan.bind(h.google);
  h.google.applyPlan=async(...args)=>({...await original(...args),verified:false});
  await h.worker.persistUpdates([update()],convert);await h.worker.tick();
  const job=Object.values((await h.store.read()).jobs)[0];
  assert.equal(job.status,'planned');assert.equal(job.receipt,undefined);
  assert.equal(h.reports.some((event)=>event.type==='write_verified'),false);
});

test('overlapping ticks are refused and dry run persists events without API or sheet writes',async(t)=>{
  const h=await harness(t);
  let resume;let entered;
  const waiting=new Promise((resolve)=>{entered=resolve;});
  const original=h.google.context.bind(h.google);
  h.google.context=async()=>{entered();await new Promise((resolve)=>{resume=resolve;});return original();};
  const first=h.worker.tick();await waiting;
  assert.deepEqual(await h.worker.tick(),{busy:true});resume();await first;
  h.google.context=original;
  const dry=h.makeWorker({dryRun:true});await dry.persistUpdates([update()],convert);await dry.tick();
  assert.equal(Object.values((await h.store.read()).jobs)[0].status,'waiting');
  assert.equal(h.api.calls.length,0);assert.equal(h.google.writes,0);
});

test('state bootstrap imports once, preserves consumption and never replaces a live queue on restart',async(t)=>{
  const h=await harness(t);const file=path.join(h.dir,'migration','state.json');
  const imported=initialState(CONFIG);imported.api.attemptedCalls=2;
  addJob(imported,{id:'known',sourceEventKey:'telegram:5164597211:old',status:'done'}, {now:NOW});
  let store=await initializeState(file,CONFIG,{INITIAL_STATE_JSON:JSON.stringify(imported)},h.now);
  assert.equal((await store.read()).api.attemptedCalls,2);
  await store.update((s)=>{s.telegram.offset=123;});
  store=await initializeState(file,CONFIG,{INITIAL_STATE_JSON:JSON.stringify(initialState(CONFIG))},h.now);
  assert.equal((await store.read()).telegram.offset,123);assert.equal((await store.read()).jobs.known.status,'done');
  const before=await fs.readFile(file,'utf8');
  await assert.rejects(initializeState(file,{...CONFIG,spreadsheetId:'another-sheet'}, {},h.now),/state_destination_mismatch/u);
  assert.equal(await fs.readFile(file,'utf8'),before);
  await assert.rejects(initializeState(path.join(h.dir,'bad.json'),CONFIG,{INITIAL_STATE_JSON:'private-invalid-input'},h.now),
    (err)=>err.message==='initial_state_invalid'&&!err.message.includes('private-invalid-input'));
});

test('required migration refuses an empty new volume but accepts a snapshot and never overwrites an existing ledger',async(t)=>{
  const h=await harness(t);const file=path.join(h.dir,'must-migrate','state.json');
  await assert.rejects(initializeState(file,CONFIG,{REQUIRE_INITIAL_STATE:'true'},h.now),/initial_state_required/u);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
  const snapshot=initialState(CONFIG);snapshot.api.attemptedCalls=2;
  addJob(snapshot,{id:'historical',sourceEventKey:'telegram:5164597211:known',status:'done'},{now:NOW});
  let store=await initializeState(file,CONFIG,{REQUIRE_INITIAL_STATE:'true',INITIAL_STATE_JSON:JSON.stringify(snapshot)},h.now);
  assert.equal((await store.read()).jobs.historical.status,'done');assert.equal((await store.read()).api.attemptedCalls,2);
  await store.update((state)=>{state.telegram.offset=234;});
  store=await initializeState(file,CONFIG,{REQUIRE_INITIAL_STATE:'true'},h.now);
  assert.equal((await store.read()).telegram.offset,234);assert.equal((await store.read()).api.attemptedCalls,2);
});

test('secret preparation and API transport keep the key in a restricted file and out of command arguments',async(t)=>{
  const h=await harness(t);const secret='a'.repeat(40);
  const {keyFile}=await prepareSecrets({FSRAR_API_KEY:secret},path.join(h.dir,'secrets-test'));
  assert.equal((await fs.stat(keyFile)).mode&0o777,0o600);
  const calls=[];const client=new FsrarClient({keyFile,execute:async(...args)=>{calls.push(args);return {stdout:JSON.stringify(envelope())};}});
  await client.validate();assert.equal(calls.length,0);
  await client.request('fsrar',{inn:INN});assert.equal(calls.length,1);
  assert.equal(JSON.stringify(calls).includes(secret),false);assert.ok(calls[0][1].includes(keyFile));
  await fs.chmod(keyFile,0o644);await assert.rejects(client.validate(),/fsrar_key_permissions/u);
  assert.equal(classifyApiFailure(null),'invalid_api_response');
  assert.equal(classifyApiFailure({http_status:200,response:{error:'Неверный ключ'}}),'authentication_failed');
  assert.equal(classifyApiFailure({http_status:200,response:{error:'Лимит запросов'}}),'quota_exhausted');
});
