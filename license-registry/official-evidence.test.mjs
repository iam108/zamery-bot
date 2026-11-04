import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore,addJob} from './state.mjs';
import {GoogleSheetsClient,REGISTRY_HEADERS} from './google.mjs';
import {LicenseWorker,privateStateProof} from './runtime.mjs';
import {OFFICIAL_EVIDENCE_SOURCE,officialRecordHash,importOfficialLicenseEvidence} from './official-evidence.mjs';

const id='a49bb4299b74e7119cbbabed';
const sourceEventKey='telegram:5164597211:62869';
const now=()=>new Date('2026-11-04T12:01:00.000Z');
const config={spreadsheetId:'official-evidence-fixture',sheetName:'Реестр лицензий',timeZone:'Europe/Moscow'};
const record={inn:'9721255266',kpp:'770645001',organization:'ООО «СВЕРТЭ»',licenseNumber:'77РПО0021046',
  issueDate:'2026-04-17',expiryDate:'2029-04-16',changeDate:'2026-10-29',changeReason:'решение о переоформлении лицензии',
  status:'действующая',activity:'Розничная продажа, общепит',address:'Москва, переулок Толмачёвский, д. 5, стр. 4, этажи 1/-1',email:'verified@example.test'};
function payload(overrides={}){
  const value={version:1,source:OFFICIAL_EVIDENCE_SOURCE,jobId:id,sourceEventKey,
    sourceUrl:'https://fsrar.gov.ru/licens/reestr?inn=9721255266&number=&kpp=',verifiedAt:'2026-11-04T12:00:00.000Z',
    evidenceSha256:'a'.repeat(64),recordHash:officialRecordHash(record),record:structuredClone(record),...overrides};
  return value;
}
async function harness(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'official-license-evidence-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');const store=createStore(file);
  const old={...record,changeDate:'2026-04-17',changeReason:'решение о выдаче лицензии',address:'Старый адрес API'};
  await store.update((state)=>{
    Object.assign(state.config,config);state.api.attemptedCalls=7;state.api.daily['2026-11-04']=2;
    addJob(state,{id,sourceEventKey,inn:record.inn,organization:record.organization,operation:'unknown',sourceText:'Свертэ положительно',
      reportedAt:'2026-10-30T07:51:13.000Z',reportedDate:'2026-10-30',status:'waiting',reason:'registry_has_not_reflected_event',
      nextCheckAt:'2026-11-05T06:00:00.000Z',attempts:3,apiItems:[old],apiReceivedAt:'2026-11-04T06:00:00.000Z',apiEvidence:'live_api'}, {now:now()});
  });
  const row=Array(17).fill('');Object.assign(row,{0:'PRIVATE_COMMERCIAL_LINK',4:record.organization,6:record.inn,
    8:record.issueDate,9:record.expiryDate,10:'Общепит ',11:record.address,12:'PRIVATE_CONTACT',16:'PRIVATE_COMMENT'});
  const values=Array.from({length:653},()=>[]);values[0]=[...REGISTRY_HEADERS];values[652]=row;
  const properties={sheetId:0,title:config.sheetName,gridProperties:{rowCount:1000,columnCount:17}};
  const metadata={spreadsheetId:config.spreadsheetId,sheets:[{properties}]};const batches=[];
  const google=new GoogleSheetsClient({...config,sheetId:0,now});
  google.request=async(suffix='',options={})=>{
    if(suffix===':batchUpdate'){
      batches.push(structuredClone(options.body));
      for(const request of options.body.requests){
        assert.ok(request.updateCells);const change=request.updateCells;
        assert.equal(change.start.rowIndex,652);assert.ok([7,15].includes(change.start.columnIndex));
        row[change.start.columnIndex]=change.rows[0].values[0].userEnteredValue.stringValue;
      }
      return {};
    }
    if(suffix.startsWith('/values/'))return {values:structuredClone(values)};
    if(options.query?.ranges)return {...structuredClone(metadata),sheets:[{properties,data:[{startRow:652,startColumn:0,
      rowData:[{values:row.map((value)=>value===''?{}:{formattedValue:value,userEnteredValue:{stringValue:value}})}]}]}]};
    return structuredClone(metadata);
  };
  const api={calls:0,async validate(){throw new Error('Operator evidence must not use API');},async request(){this.calls++;throw new Error('Operator evidence must not use API');}};
  const reports=[];
  const worker=(freshStore=store)=>new LicenseWorker({store:freshStore,google,api,config,now,report:(event)=>reports.push(event)});
  const ingest=(value=payload())=>importOfficialLicenseEvidence({store,payload:value,now});
  return {store,file,google,api,row,values,batches,reports,worker,ingest};
}

test('official record fills only H/P through real adapter readback/ack while retaining stale API history and quota',async(t)=>{
  const h=await harness(t);const before=await h.store.read();const originalRow=structuredClone(h.row);
  const imported=await h.ingest();assert.equal(imported.status,'imported');
  let state=await h.store.read();assert.equal(state.jobs[id].status,'fetched');assert.deepEqual(state.api,before.api);
  await h.worker().tick();state=await h.store.read();const job=state.jobs[id];
  assert.equal(job.status,'done',job.lastWriteError);assert.equal(job.receipt.verified,true);assert.equal(job.receipt.sourceEvidence.source,OFFICIAL_EVIDENCE_SOURCE);
  assert.equal(job.receipt.sourceEvidence.evidenceId,imported.evidenceId);assert.equal(job.plan.sourceEvidence.recordHash,officialRecordHash(record));
  assert.deepEqual(job.apiItems,before.jobs[id].apiItems);assert.equal(job.apiReceivedAt,before.jobs[id].apiReceivedAt);
  assert.equal(job.apiEvidence,'live_api');assert.equal(job.attempts,3);assert.deepEqual(state.api,before.api);assert.deepEqual(state.sources,before.sources);
  assert.equal(h.api.calls,0);assert.equal(h.batches.length,1);assert.equal(h.row[7],record.licenseNumber);assert.equal(h.row[15],record.email);
  for(let index=0;index<17;index++)if(![7,15].includes(index))assert.equal(h.row[index],originalRow[index]);
  assert.deepEqual(h.reports.find((event)=>event.type==='write_verified').cells,['H653','P653']);
  const proof=privateStateProof(state).jobStates[0];assert.equal(proof.apiDates[0].changeDate,'2026-04-17');
  assert.equal(proof.officialEvidence.changeDate,'2026-10-29');assert.equal(proof.officialEvidence.source,OFFICIAL_EVIDENCE_SOURCE);
  assert.equal(proof.officialEvidence.evidenceHash,'a'.repeat(64));
  for(const sensitive of[record.organization,record.email,record.address,'PRIVATE_CONTACT'])assert.ok(!JSON.stringify(proof).includes(sensitive));
  assert.equal((await h.ingest()).status,'duplicate');
  await h.worker(createStore(h.file)).tick();assert.equal(h.batches.length,1);assert.equal(h.api.calls,0);
  assert.equal((await h.store.read()).jobs[id].status,'done');
});

test('lost readback resumes the same official plan after restart and does not repeat the Google mutation or API call',async(t)=>{
  const h=await harness(t);await h.ingest();const apply=h.google.applyPlan.bind(h.google);let first=true;
  h.google.applyPlan=async(...args)=>{const receipt=await apply(...args);if(first){first=false;throw new Error('lost_readback');}return receipt;};
  await h.worker().tick();assert.equal((await h.store.read()).jobs[id].status,'planned');assert.equal(h.batches.length,1);
  assert.equal((await h.ingest()).status,'duplicate');
  await h.worker(createStore(h.file)).tick();assert.equal((await h.store.read()).jobs[id].status,'done');
  assert.equal(h.batches.length,1);assert.equal(h.api.calls,0);
});

test('unknown sources, unknown fields, invalid hashes and stale official records fail closed without changing state',async(t)=>{
  const h=await harness(t);const before=await h.store.read();
  const stale={...record,changeDate:'2026-04-17'};
  for(const value of[payload({source:'api_fns'}),payload({sourceUrl:'https://evil.example/licens/reestr'}),
    payload({extra:'unexpected'}),payload({recordHash:'b'.repeat(64)}),payload({sourceEventKey:'telegram:wrong:1'}),
    payload({record:stale,recordHash:officialRecordHash(stale)}),payload({evidenceSha256:'invalid'})]){
    await assert.rejects(h.ingest(value));assert.deepEqual(await h.store.read(),before);
  }
  assert.equal(h.api.calls,0);assert.equal(h.batches.length,0);
});

test('an unimported done/planned/fetching or source-reviewed job cannot be reset by operator evidence',async(t)=>{
  for(const status of['done','planned','fetching','review']){
    const h=await harness(t);await h.store.update((state)=>{state.jobs[id].status=status;});const before=await h.store.read();
    await assert.rejects(h.ingest(),{code:'official_evidence_job_not_eligible'});assert.deepEqual(await h.store.read(),before);
  }
  const h=await harness(t);await h.store.update((state)=>{state.jobs[id].sourceReviewRequired=true;});
  await assert.rejects(h.ingest(),{code:'official_evidence_job_not_eligible'});
});

test('address/date/company conflicts outside H/P go to review without a write or an API retry',async(t)=>{
  const h=await harness(t);h.row[4]='Другое написание компании';await h.ingest();
  await h.worker().tick();let state=await h.store.read();
  assert.equal(state.jobs[id].status,'review');assert.equal(state.jobs[id].reason,'official_evidence_write_scope');
  await h.worker(createStore(h.file)).tick();state=await h.store.read();
  assert.equal(state.jobs[id].status,'review');assert.equal(h.batches.length,0);assert.equal(h.api.calls,0);
});

test('a changed imported record is quarantined instead of silently falling back to stale API data',async(t)=>{
  const h=await harness(t);await h.ingest();
  await h.store.update((state)=>{state.jobs[id].officialLicenseEvidence.record.changeDate='2026-11-01';});
  await h.worker().tick();const state=await h.store.read();
  assert.equal(state.jobs[id].status,'review');assert.equal(state.jobs[id].reason,'official_evidence_invalid');
  assert.equal(h.api.calls,0);assert.equal(h.batches.length,0);
});
