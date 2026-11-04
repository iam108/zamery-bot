import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from './state.mjs';
import {REGISTRY_HEADERS} from './google.mjs';
import {ContactWorker} from './contact-worker.mjs';

const INN='9705148570';const ADDRESS='Москва, ул. Пушкина, д. 1, этаж 1';
function row(inn=INN,address=ADDRESS,extra={}){
  const values=Array(17).fill('');Object.assign(values,{4:'ООО Тест',6:inn,7:'77РПО0021680',8:'2026-10-28',9:'2027-10-27',11:address,...extra});return values;
}
function source(id=1,inn=INN,address=ADDRESS,extra={}){return {id,inn,address,request_id:id+10,
  contacts:[{name:'Иван Иванов',phone:'89991234567',tg:'@ivan_user'}],...extra};}
async function fixture(t,{rows=[row()],cases=[source()],reviews=[],maxWrites=20,maxReviewNotifications=5}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'contact-worker-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(path.join(dir,'state.json'));await store.update(()=>{});
  let now=Date.parse('2026-11-05T09:00:00Z');const values=[[...REGISTRY_HEADERS],...rows];
  const calls={lookups:[],verify:0,close:0,sourceFactory:0,batches:[]};const controls={};const events=[];const logs=[];
  const google={spreadsheetId:'contacts-fixture',sheetName:'Реестр лицензий',sheetId:0,now:()=>new Date(now),
    async context(){if(controls.contextError)throw new Error('private read error');return {values:structuredClone(values),startRow:1};},
    async readRow(number){if(controls.readError)throw new Error('private row error');return (values[number-1]??[]).map(value=>value===''?{}:{formattedValue:String(value),userEnteredValue:{stringValue:String(value)}});},
    async request(suffix,{body}){
      assert.equal(suffix,':batchUpdate');
      const saved=await store.read();assert.ok(Object.values(saved.contacts.records).some(record=>record.status==='planned'));
      if(controls.beforeBatch)await controls.beforeBatch(body);
      calls.batches.push(structuredClone(body));
      for(const item of body.requests){const update=item.updateCells;values[update.start.rowIndex][update.start.columnIndex]=update.rows[0].values[0].userEnteredValue.stringValue;}
      if(controls.afterBatch)await controls.afterBatch();return {};
    }};
  const sourceData={cases,reviews};
  const sourceFactory=async()=>{calls.sourceFactory++;return {async verify(){calls.verify++;if(controls.sourceError)throw new Error('private connection string');},
    async lookup(inns){calls.lookups.push([...inns]);if(controls.lookupError)throw new Error('private SQL error');return {
      cases:sourceData.cases.filter(item=>inns.includes(item.inn)),reviews:sourceData.reviews.filter(item=>inns.includes(item.inn))};},
    async close(){calls.close++;}};};
  const config={store,google,sourceFactory,now:()=>new Date(now),report:async(event)=>{events.push(event);return {delivery:'sent'};},log:(event)=>logs.push(event),maxWrites,maxReviewNotifications};
  return {store,google,values,calls,controls,sourceData,events,logs,advance:(ms)=>{now+=ms;},worker:()=>new ContactWorker(config),config};
}

test('first pass durably plans before Google, reads back, journals and confirms only contact cells',async(t)=>{
  const h=await fixture(t);const result=await h.worker().tick();
  assert.equal(result.updated,1);assert.equal(result.apiCalls,0);assert.equal(h.calls.batches.length,1);
  assert.deepEqual(h.values[1].slice(12,15),['Иван Иванов','+79991234567','https://t.me/ivan_user']);
  const state=await h.store.read();assert.equal(Object.keys(state.jobs).length,0);assert.equal(state.api.attemptedCalls,0);
  const record=Object.values(state.contacts.records)[0];assert.equal(record.status,'done');assert.equal(record.receipt.verified,true);
  assert.equal(record.plan.hash,record.receipt.planHash);assert.ok(record.provenance.length);assert.equal(record.notificationPending,false);
  assert.ok(state.journal.some(item=>item.type==='contact_write_verified'));
  assert.deepEqual(h.events[0].cells,['M2','N2','O2']);assert.equal(h.events[0].type,'contact_write_verified');assert.equal(h.events[0].action,'update');
  assert.ok(!JSON.stringify(h.logs).includes('Иван'));assert.ok(!JSON.stringify(h.logs).includes('79991234567'));
  assert.equal(h.calls.close,1);
  h.advance(900001);await h.worker().tick();assert.equal(h.calls.batches.length,1);
});

test('unknown company and expired/future periods stay quiet with no new rows or jobs',async(t)=>{
  const h=await fixture(t,{rows:[row(),row(INN,'Другой адрес',{8:'2025-01-01',9:'2025-12-31'}),row(INN,'Будущий адрес',{8:'2027-01-01',9:'2028-01-01'})],cases:[]});
  const result=await h.worker().tick();assert.equal(result.scanned,1);assert.equal(result.nosource,1);
  assert.equal(h.events.length,0);assert.equal(h.calls.batches.length,0);assert.equal(h.values.length,4);
  assert.equal(Object.keys((await h.store.read()).contacts.records).length,0);
});

test('duplicate active periods review only when a contact source exists, even if another active row is fully filled',async(t)=>{
  const h=await fixture(t,{rows:[row(),row(INN,ADDRESS,{7:'',9:'2029-10-27',12:'Ручное имя',13:'+79990000001',14:'https://t.me/manual_contact'})]});
  const result=await h.worker().tick();assert.equal(result.reviews,1);assert.equal(h.calls.batches.length,0);
  assert.equal(h.events[0].type,'contact_review_required');assert.equal(h.events[0].code,'contact_row_ambiguous');
  h.advance(900001);await h.worker().tick();assert.equal(h.events.length,1);
  const unknown=await fixture(t,{rows:[row(),row()],cases:[]});await unknown.worker().tick();assert.equal(unknown.events.length,0);
});

test('different same-object contacts and explicit source reviews never choose a latest person',async(t)=>{
  const h=await fixture(t,{cases:[source(),source(2,INN,ADDRESS,{contacts:[{name:'Анна',phone:'89990000001'}]})]});
  assert.equal((await h.worker().tick()).reviews,1);assert.equal(h.calls.batches.length,0);assert.equal(h.events[0].code,'contact_source_ambiguous');
  const unparsed=await fixture(t,{cases:[],reviews:[{inn:INN,reason:'ambiguous_form'}]});
  assert.equal((await unparsed.worker().tick()).reviews,1);assert.equal(unparsed.calls.batches.length,0);
});

test('blank license number is supported and no license metadata is changed',async(t)=>{
  const h=await fixture(t,{rows:[row(INN,ADDRESS,{7:''})]});const before=h.values[1].slice(0,12);
  assert.equal((await h.worker().tick()).updated,1);assert.deepEqual(h.values[1].slice(0,12),before);
});

test('uncertain committed write is verified after restart without reloading source or repeating Google write',async(t)=>{
  const h=await fixture(t);h.controls.afterBatch=async()=>{throw new Error('lost response');};
  assert.equal((await h.worker().tick()).pending,1);assert.equal(Object.values((await h.store.read()).contacts.records)[0].status,'planned');
  h.advance(60001);h.controls.sourceError=true;
  const before=h.calls.lookups.length;const result=await h.worker().tick();
  assert.equal(result.updated,1);assert.equal(result.pending,0);assert.equal(h.calls.batches.length,1);assert.equal(h.calls.lookups.length,before);
});

test('uncommitted write revalidates source, and a changed source is review rather than an old contact write',async(t)=>{
  const h=await fixture(t);h.controls.beforeBatch=async()=>{throw new Error('not sent');};
  assert.equal((await h.worker().tick()).pending,1);assert.equal(h.calls.batches.length,0);
  h.controls.beforeBatch=null;h.sourceData.cases=[source(2,INN,ADDRESS,{contacts:[{name:'Анна',phone:'89990000001'}]})];h.advance(60001);
  const result=await h.worker().tick();assert.equal(result.reviews,1);assert.equal(h.calls.batches.length,0);
  const record=Object.values((await h.store.read()).contacts.records)[0];assert.equal(record.status,'review');assert.equal(record.reason,'contact_source_changed');
  h.advance(900001);await h.worker().tick();assert.equal(h.calls.batches.length,0);
});

test('unchanged source retries an uncommitted plan while an existing manual conflict is preserved',async(t)=>{
  const h=await fixture(t);h.controls.beforeBatch=async()=>{throw new Error('not sent');};await h.worker().tick();
  h.controls.beforeBatch=null;h.advance(60001);assert.equal((await h.worker().tick()).updated,1);assert.equal(h.calls.batches.length,1);
  const conflict=await fixture(t);conflict.controls.beforeBatch=async()=>{throw new Error('not sent');};await conflict.worker().tick();
  conflict.controls.beforeBatch=null;conflict.values[1][13]='+78880000000';conflict.advance(60001);
  assert.equal((await conflict.worker().tick()).reviews,1);assert.equal(conflict.calls.batches.length,0);assert.equal(conflict.values[1][13],'+78880000000');
});

test('source failure stores a five-minute retry and exposes only a fixed code',async(t)=>{
  const h=await fixture(t);h.controls.sourceError=true;
  await assert.rejects(h.worker().tick(),{code:'contact_source_unavailable'});
  const state=await h.store.read();assert.equal(state.contacts.retryAt,'2026-11-05T09:05:00.000Z');assert.equal(h.calls.close,1);
  assert.ok(!JSON.stringify(h.logs).includes('private'));assert.equal((await h.worker().tick()).skipped,'not_due');
  assert.equal(h.calls.sourceFactory,1);
});

test('write limit retains remaining rows for the next minute',async(t)=>{
  const h=await fixture(t,{rows:[row(),row(INN,'Второй адрес')],cases:[source(),source(2,INN,'Второй адрес')],maxWrites:1});
  const first=await h.worker().tick();assert.equal(first.updated,1);assert.equal(first.nextSyncAt,'2026-11-05T09:01:00.000Z');
  h.advance(60001);assert.equal((await h.worker().tick()).updated,1);assert.equal(h.calls.batches.length,2);
});

test('review notifications are bounded and deferred reviews remain durable',async(t)=>{
  const h=await fixture(t,{rows:[row(INN,'Первый адрес'),row(INN,'Второй адрес')],cases:[],reviews:[{inn:INN,reason:'ambiguous'}],maxReviewNotifications:1});
  const first=await h.worker().tick();assert.equal(first.reviews,2);assert.equal(h.events.length,1);assert.equal(first.nextSyncAt,'2026-11-05T09:01:00.000Z');
  h.advance(60001);await h.worker().tick();assert.equal(h.events.length,2);
});

test('notification failure does not lose a completed acknowledgement',async(t)=>{
  const h=await fixture(t);let notified=false;
  const worker=new ContactWorker({...h.config,report:async()=>{if(!notified)throw new Error('notification storage');return {delivery:'sent'};}});
  assert.equal((await worker.tick()).updated,1);assert.equal(Object.values((await h.store.read()).contacts.records)[0].notificationPending,true);
  h.advance(60001);notified=true;await worker.tick();assert.equal(h.calls.batches.length,1);
  assert.equal(Object.values((await h.store.read()).contacts.records)[0].notificationPending,false);
});

test('source reads are batched at at most one hundred unique INNs',async(t)=>{
  const inn=(seed)=>{const first=String(770000000+seed);const digits=[...first].map(Number);const check=[2,4,10,3,5,9,4,6,8].reduce((sum,w,i)=>sum+w*digits[i],0)%11%10;return first+check;};
  const rows=Array.from({length:121},(_,i)=>row(inn(i),`Адрес ${i}`));const h=await fixture(t,{rows,cases:[]});
  const result=await h.worker().tick();assert.equal(result.nosource,121);assert.deepEqual(h.calls.lookups.map(batch=>batch.length),[100,21]);
  assert.equal(h.events.length,0);assert.equal(h.calls.close,1);
});

test('invalid receipts cannot acknowledge a planned write or modify license state',async(t)=>{
  const h=await fixture(t);h.controls.beforeBatch=async()=>{throw new Error('not sent');};const worker=h.worker();await worker.tick();
  const before=await h.store.read();const record=Object.values(before.contacts.records)[0];
  const receipt={verified:true,planHash:record.plan.hash,spreadsheetId:record.plan.spreadsheetId,sheetName:record.plan.sheetName,
    sheetId:record.plan.sheetId,rowNumber:record.plan.rowNumber,verifiedAt:'2026-11-05T09:00:00Z',appliedCells:[],cells:{...record.plan.expectedCells}};
  for(const changed of[{...receipt,verified:false},{...receipt,planHash:'wrong'},
    {...receipt,cells:{...receipt.cells,N2:'wrong'}},{...receipt,appliedCells:['H2']}]){
    await assert.rejects(worker.acknowledge(record,changed),{code:'contact_receipt_invalid'});
  }
  const after=await h.store.read();assert.equal(Object.values(after.contacts.records)[0].status,'planned');
  assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.api,before.api);assert.deepEqual(after.journal,before.journal);
});

test('explicit contact rerun is once-only and preserves licensing and existing contact records',async()=>{
  const {triggerContactSync}=await import('./contact-worker.mjs');
  const state={jobs:{keep:{status:'done'}},api:{attemptedCalls:11},contacts:{nextSyncAt:'2099-01-01T00:00:00Z',retryAt:'2099-01-01T00:00:00Z',records:{keep:{status:'done'}}}};
  const store={update:async(fn)=>fn(state)};
  assert.equal(await triggerContactSync(store,'test-run'),true);assert.equal(state.contacts.nextSyncAt,null);
  state.contacts.nextSyncAt='2099-01-01T00:00:00Z';assert.equal(await triggerContactSync(store,'test-run'),false);
  assert.equal(state.contacts.nextSyncAt,'2099-01-01T00:00:00Z');assert.equal(state.jobs.keep.status,'done');
  assert.equal(state.api.attemptedCalls,11);assert.equal(state.contacts.records.keep.status,'done');
});
