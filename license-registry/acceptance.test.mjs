import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runReadOnlyAcceptance} from './acceptance.mjs';
import {createStore,addJob} from './state.mjs';
import {GoogleSheetsClient,REGISTRY_HEADERS} from './google.mjs';

const id='883a7b749a7d113302b3d194';const now=()=>new Date('2026-11-02T18:00:00.000Z');
const config={spreadsheetId:'acceptance-registry',sheetName:'Реестр лицензий',timeZone:'Europe/Moscow'};
const license={inn:'9705148570',kpp:'770501001',licenseNumber:'77РПО0021680',issueDate:'2026-10-28',expiryDate:'2027-10-27',
  activity:'Розничная продажа, общепит',address:'Москва, Средний Овчинниковский переулок, дом 3',status:'действующая',
  changeDate:'2026-10-28',email:'PRIVATE_EMAIL@example.test'};
const clone=(value)=>structuredClone(value);
async function harness(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'license-acceptance-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createStore(path.join(directory,'state.json'));
  await store.update((state)=>{
    Object.assign(state.config,config);state.api.attemptedCalls=2;state.api.providerBaselineConsumed=2;
    addJob(state,{id,sourceEventKey:'telegram:5164597211:62436',status:'done',inn:license.inn,organization:'PRIVATE_COMPANY',
      sourceText:'PRIVATE_SOURCE_TEXT',operation:'issuance',reportedAt:'2026-10-28T07:53:59.000Z',reportedDate:'2026-10-28',
      attempts:0,selectedLicense:clone(license),receipt:{verified:true,planHash:'original-private-receipt',cells:{H2:license.licenseNumber}}},{now:now()});
  });
  const row=Array(17).fill('');Object.assign(row,{4:'PRIVATE_COMPANY',6:license.inn,7:license.licenseNumber,
    8:license.issueDate,9:license.expiryDate,10:'Общепит ',11:license.address,15:license.email});
  const values=[[...REGISTRY_HEADERS],row];const calls=[];
  const metadata={spreadsheetId:config.spreadsheetId,sheets:[{properties:{sheetId:0,title:config.sheetName,
    gridProperties:{rowCount:10,columnCount:17}}}]};
  // Exercise the real Google adapter's noop validation, row readback and receipt.
  // Only its remote transport is replaced; every mutation request is forbidden.
  const google=new GoogleSheetsClient({...config,sheetId:0,now});
  google.request=async(suffix='',options={})=>{
    calls.push({suffix,options});assert.equal(options.body,undefined,'Acceptance must never issue a Google mutation');
    assert.notEqual(suffix,':batchUpdate');
    if(suffix.startsWith('/values/'))return {values:clone(values)};
    if(options.query?.ranges){
      return {...clone(metadata),sheets:[{...clone(metadata.sheets[0]),data:[{startRow:1,startColumn:0,
        rowData:[{values:row.map((value)=>({formattedValue:value,userEnteredValue:{stringValue:value}}))}]}]}]};
    }
    return clone(metadata);
  };
  const api={calls:[],async request(method,job){
    const state=await store.read();assert.equal(state.runtime.acceptance.status,'reserved');
    assert.equal(state.api.attemptedCalls,3);assert.equal(state.jobs[id].status,'done');
    this.calls.push({method,job:clone(job)});return {http_status:200,response:{items:[clone(license)]},attempted:true};
  }};
  const logs=[];const run=(extra={})=>runReadOnlyAcceptance({sourceJobId:id,store,google,api,now,log:(entry)=>logs.push(entry),...extra});
  return {store,google,api,logs,calls,values,row,run};
}

test('one live diagnostic reservation verifies actual Google noop readback and ephemeral ack without changing the completed job',async(t)=>{
  const h=await harness(t);const before=await h.store.read();
  const result=await h.run();const after=await h.store.read();
  assert.equal(result.status,'verified');assert.equal(result.row,2);assert.equal(result.receipt.verified,true);assert.equal(result.ack.verified,true);
  assert.match(result.ack.planHash,/^[a-f0-9]{64}$/u);
  assert.deepEqual(result.receipt.cells,{G2:license.inn,H2:license.licenseNumber,I2:license.issueDate,J2:license.expiryDate});
  assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.sources,before.sources);
  assert.deepEqual(after.journal.slice(0,before.journal.length),before.journal);
  assert.equal(after.api.attemptedCalls,3);assert.equal(after.api.daily['2026-11-02'],1);assert.equal(after.api.runs[`acceptance:${id}`],1);
  assert.equal(h.api.calls.length,1);assert.equal(h.api.calls[0].method,'fsrar');assert.equal(h.api.calls[0].job.inn,license.inn);
  assert.ok(h.calls.some((call)=>call.options.query?.ranges));
  const event=h.logs.find((entry)=>entry.type==='acceptance_verified');assert.equal(event.receiptVerified,true);assert.equal(event.ackVerified,true);
  for(const privateValue of['PRIVATE_COMPANY','PRIVATE_SOURCE_TEXT','PRIVATE_EMAIL','Средний','9705148570','original-private-receipt']){
    assert.ok(!JSON.stringify(h.logs).includes(privateValue));
  }
});

test('the durable guard prevents a second diagnostic across restarts, concurrent invocations and a changed source flag',async(t)=>{
  const h=await harness(t);
  await Promise.all([h.run(),h.run()]);assert.equal(h.api.calls.length,1);
  const before=await h.store.read();assert.equal((await h.run()).status,'verified');
  const other=await h.run({sourceJobId:'a'.repeat(24)});assert.equal(other.status,'not_repeated');
  assert.deepEqual(await h.store.read(),before);assert.equal(h.api.calls.length,1);
  assert.ok(h.logs.some((entry)=>entry.type==='acceptance_already_verified'));
});

test('an uncertain reservation left by a stopped process never retries the API',async(t)=>{
  const h=await harness(t);
  await h.store.update((state)=>{state.runtime={acceptance:{status:'reserved',sourceJobId:id,apiCallReserved:true}};});
  assert.equal((await h.run()).status,'reserved');assert.equal((await h.run()).status,'reserved');
  assert.equal(h.api.calls.length,0);assert.equal(h.calls.length,0);
  assert.ok(h.logs.every((entry)=>entry.code==='acceptance_reserved_result_unknown'));
});

test('quota reserve, daily budget, blocked API and incomplete source stop before any diagnostic request',async(t)=>{
  for(const [mutation,code]of[
    [(state)=>{state.api.attemptedCalls=80;},'acceptance_quota_reserve'],
    [(state)=>{state.api.daily['2026-11-02']=10;},'acceptance_daily_limit'],
    [(state)=>{state.api.blocked={code:'access_ip_blocked'};},'acceptance_api_blocked'],
    [(state)=>{state.jobs[id].status='waiting';},'acceptance_completed_source_required'],
  ]){
    const h=await harness(t);await h.store.update(mutation);const before=await h.store.read();
    const result=await h.run();assert.equal(result.code,code);await h.run();
    const after=await h.store.read();assert.equal(h.api.calls.length,0);assert.equal(h.calls.length,0);
    assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.sources,before.sources);assert.deepEqual(after.api,before.api);
  }
});

test('an update or append requirement is rejected without ever invoking Google applyPlan',async(t)=>{
  for(const mutation of[(h)=>{h.row[7]='';},(h)=>{h.values.splice(1);}]){
    const h=await harness(t);mutation(h);let applied=0;h.google.applyPlan=async()=>{applied++;throw new Error('Must not apply');};
    assert.equal((await h.run()).code,'acceptance_would_write');assert.equal(applied,0);
    await h.run();assert.equal(h.api.calls.length,1);assert.equal((await h.store.read()).api.attemptedCalls,3);
  }
});

test('stale API results retain normal freshness rules and failed diagnostic calls are never repeated',async(t)=>{
  const h=await harness(t);
  h.api.request=async function(){this.calls.push({});return {http_status:200,response:{items:[{...license,issueDate:'2026-10-20',changeDate:'2026-10-20'}]}};};
  assert.equal((await h.run()).code,'acceptance_current_license_required');assert.equal(h.calls.length,0);
  await h.run();assert.equal(h.api.calls.length,1);
  const failed=await harness(t);failed.api.request=async function(){this.calls.push({});throw new Error('PRIVATE_KEY_OR_PROXY_URL');};
  assert.equal((await failed.run()).code,'acceptance_api_failed');await failed.run();assert.equal(failed.api.calls.length,1);
  assert.ok(!JSON.stringify(failed.logs).includes('PRIVATE_KEY_OR_PROXY_URL'));
});

test('ephemeral acknowledge rejects an invalid real readback receipt and never replaces the original receipt',async(t)=>{
  const h=await harness(t);const before=await h.store.read();const apply=h.google.applyPlan.bind(h.google);
  h.google.applyPlan=async(...args)=>({...await apply(...args),verified:false});
  assert.equal((await h.run()).code,'acceptance_ack_failed');await h.run();
  const after=await h.store.read();assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.sources,before.sources);
  assert.equal(after.runtime.acceptance.status,'failed');assert.equal(after.runtime.acceptance.receipt,undefined);
  assert.equal(h.api.calls.length,1);assert.ok(!h.logs.some((entry)=>entry.type==='acceptance_verified'));
});

test('a Google row changed after planning cannot turn the signed noop into a write',async(t)=>{
  const h=await harness(t);const apply=h.google.applyPlan.bind(h.google);
  h.google.applyPlan=async(...args)=>{h.row[7]='';return apply(...args);};
  assert.equal((await h.run()).code,'acceptance_readback_failed');
  await h.run();assert.equal(h.api.calls.length,1);
  assert.ok(h.calls.every((call)=>call.options.body===undefined));
});
