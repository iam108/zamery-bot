'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createManualMaterialsStore}=require('../src/web/handoff-manual-materials');
const {createCaseDocumentsService,setupHandoffCaseDocuments}=require('../src/web/handoff-case-documents');
const {createHandoffMaterialsDelivery}=require('../src/web/handoff-materials');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:20000};
async function fixture(run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),sent=[];let blocked=false,before=async()=>{},onSend=async()=>{};
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);
    INSERT INTO staff VALUES(101,'manager',true),(102,'manager',true),(808,'lawyer',true),(909,'lawyer',true),(707,'auditor',true);
    CREATE TABLE cases(id INT PRIMARY KEY,org TEXT,created_by BIGINT,lawyer_tg_id BIGINT,handoff_submit_id TEXT,data JSONB);
    INSERT INTO cases VALUES(39,'ООО «Настоящее»',101,808,NULL,'{"_handoff":{"cards":{"808":6000,"-100900":100}}}'),(40,'Other',101,909,NULL,'{}');`);
  const query=async(sql,params)=>{await before(sql,params);if(sql.startsWith('SELECT pg_try_advisory'))return {rows:[{locked:!blocked}]};if(sql.startsWith('SELECT pg_advisory_unlock'))return {rows:[]};return params?db.query(sql,params):db.exec(sql).then(result=>result.at(-1));};
  const pool={query,async connect(){return {query,release(){}};}},store=createManualMaterialsStore(pool);
  const telegram={async sendDocument(chat,document,extra){const chunks=[];for await(const part of document.source)chunks.push(part);const packet={chat,filename:document.filename,extra,buffer:Buffer.concat(chunks)};sent.push(packet);const result=await onSend(packet,sent.length);return result===undefined?{message_id:9000+sent.length,chat:{id:Number(chat)}}:result;}};
  const make=(name='Договор.pdf',n=150)=>({originalname:name,mimetype:'application/pdf',buffer:Buffer.from('%PDF-1.7\n'+name+'\n'+'x'.repeat(n)+'\n%%EOF')});
  const upload=async(sid=randomUUID(),files=[make()])=>{let metadata;for(const file of files)metadata=await store.put(101,sid,file);return {sid,files:metadata,originals:files};};
  const create=extra=>createCaseDocumentsService({pool,store,telegram,...extra});
  try{await run({db,pool,store,telegram,sent,make,upload,create,service:create(),before(fn){before=fn;},onSend(fn){onSend=fn;},blocked(value){blocked=value;}});}finally{await db.close();}
}
const input=d=>({caseId:39,actorId:101,submitId:d.sid,files:d.files});

test('supplemental originals attach to an existing report case, deliver privately and remain downloadable after restart',pg,()=>fixture(async h=>{
  const d=await h.upload(),result=await h.service.send(input(d));assert.equal(result.delivery_complete,true);assert.equal(result.batch.status,'delivered');assert.equal(result.batch.retry,false);assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].chat,'808');assert.equal(h.sent[0].extra.reply_to_message_id,6000);assert.match(h.sent[0].extra.caption,/ООО «Настоящее»/);assert.ok(h.sent[0].buffer.includes(d.originals[0].buffer));
  const service=h.create(),listed=await service.list(39,808);assert.equal(listed.batches.length,1);assert.equal(listed.files.length,1);assert.equal(listed.org,'ООО «Настоящее»');assert.equal('buffer' in listed.files[0],false);assert.match(listed.files[0].url,/^\/api\/handoff\/cases\/39\/documents\//);
  const restored=await service.file(39,d.sid,d.files[0].id,808);assert.ok(restored.buffer.equals(d.originals[0].buffer));
  assert.equal((await h.db.query('SELECT count(*)::int n FROM cases')).rows[0].n,2,'Supplemental delivery never creates another client');
  await assert.rejects(h.store.remove(101,d.sid,d.files[0].id),e=>e.code==='HANDOFF_MATERIAL_FROZEN');
}));

test('lost HTTP response and repeated POST or retry reuse the completed batch without another Telegram send',pg,()=>fixture(async h=>{
  const d=await h.upload();await h.service.send(input(d));assert.equal((await h.create().send(input(d))).delivery_complete,true);
  assert.equal((await h.service.send({caseId:39,actorId:102,submitId:d.sid,retry:true})).delivery_complete,true);assert.equal(h.sent.length,1);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM case_document_batches')).rows[0].n,1);
}));

test('a second attachment batch delivers only new staged documents and preserves the original handoff checkpoint',pg,()=>fixture(async h=>{
  const old=(await h.db.query('SELECT data FROM cases WHERE id=39')).rows[0].data,first=await h.upload(),second=await h.upload(randomUUID(),[h.make('Допсоглашение.pdf')]);
  await h.service.send(input(first));await h.service.send(input(second));assert.equal(h.sent.length,2);assert.ok(h.sent[1].buffer.includes(second.originals[0].buffer));assert.ok(!h.sent[1].buffer.includes(first.originals[0].buffer));
  assert.deepEqual((await h.db.query('SELECT data FROM cases WHERE id=39')).rows[0].data,old);assert.equal((await h.service.list(39,808)).batches.length,2);
}));

test('batch IDs and frozen manifests cannot be reused for another case, owner or changed file selection',pg,()=>fixture(async h=>{
  const d=await h.upload();await h.service.send(input(d));
  for(const change of [{caseId:40},{actorId:102},{files:[{...d.files[0],name:'Wrong.pdf'}]}])await assert.rejects(h.service.send({...input(d),...change}),e=>e.code==='CASE_DOCUMENT_CHANGED');
  await assert.rejects(h.service.send({...input(d),files:[]}),e=>e.code==='CASE_DOCUMENT_INVALID');
  const foreign=await h.upload();await assert.rejects(h.service.send({...input(foreign),actorId:102}),e=>e.code==='HANDOFF_MATERIAL_CHANGED');assert.equal(h.sent.length,1);
}));

test('an existing manual handoff upload cannot be attached twice through the supplemental endpoint',pg,()=>fixture(async h=>{
  const d=await h.upload();await h.db.query('UPDATE cases SET handoff_submit_id=$1 WHERE id=39',[d.sid]);
  await assert.rejects(h.service.send(input(d)),e=>e.code==='CASE_DOCUMENT_CHANGED');assert.equal(h.sent.length,0);
}));

test('an uncertain batch still rejects mismatched case, manager and manifest instead of exposing its review state',pg,()=>fixture(async h=>{
  const d=await h.upload();h.onSend(async()=>{throw new Error('unknown send result');});await h.service.send(input(d));
  for(const change of [{caseId:40},{actorId:102},{files:[{...d.files[0],name:'Wrong.pdf'}]}])await assert.rejects(h.service.send({...input(d),...change}),e=>e.code==='CASE_DOCUMENT_CHANGED');
  assert.equal(h.sent.length,1);
}));

test('a failed final completion marker remains pending and retries bookkeeping without resending confirmed files',pg,()=>fixture(async h=>{
  const d=await h.upload();let failing=true;
  h.before(async(sql,args)=>{if(failing&&sql.startsWith('UPDATE case_document_batches SET delivery')&&JSON.parse(args[1]).completed)throw new Error('completion not saved');});
  const first=await h.service.send(input(d));assert.equal(first.delivery_complete,false);assert.equal(first.batch.status,'pending');assert.equal(first.batch.retry,true);assert.equal(h.sent.length,1);
  failing=false;assert.equal((await h.service.send({caseId:39,actorId:101,submitId:d.sid,retry:true})).delivery_complete,true);assert.equal(h.sent.length,1);
}));

test('a definite Telegram rejection keeps files and permits a safe delivery-only retry',pg,()=>fixture(async h=>{
  const d=await h.upload();h.onSend(async()=>{throw Object.assign(new Error('blocked'),{response:{error_code:403,description:'Forbidden'}});});
  const first=await h.service.send(input(d));assert.equal(first.delivery_complete,false);assert.equal(first.batch.status,'pending');assert.equal(first.batch.retry,true);
  await assert.rejects(h.store.put(101,d.sid,h.make('Changed.pdf')),e=>e.code==='HANDOFF_MATERIAL_FROZEN');
  h.onSend(async()=>{});assert.equal((await h.service.send({caseId:39,actorId:101,submitId:d.sid,retry:true})).delivery_complete,true);assert.equal(h.sent.length,2);
}));

test('unknown Telegram delivery and invalid receipts stop automatic retries to avoid duplicate originals',pg,()=>fixture(async h=>{
  for(const response of [null,{message_id:0,chat:{id:808}},{message_id:42,chat:{id:909}},'timeout']){
    const d=await h.upload();h.onSend(async()=>{if(response==='timeout')throw new Error('connection lost after send');return response;});
    const first=await h.service.send(input(d));assert.equal(first.delivery_complete,false);assert.equal(first.batch.status,'review');assert.equal(first.batch.retry,false);const count=h.sent.length;
    const second=await h.create().send({caseId:39,actorId:101,submitId:d.sid,retry:true});assert.equal(second.batch.status,'review');assert.equal(h.sent.length,count);
  }
}));

test('a lost receipt database write leaves a durable pre-send intent and cannot produce a blind resend',pg,()=>fixture(async h=>{
  const d=await h.upload();let failReceipt=true;
  h.before(async(sql,args)=>{if(failReceipt&&sql.startsWith('UPDATE case_document_batches SET delivery')&&JSON.parse(args[1]).confirmed?.[808]?.length){throw new Error('database receipt unavailable');}});
  const first=await h.service.send(input(d));assert.equal(first.batch.status,'review');assert.equal(first.batch.retry,false);assert.equal(h.sent.length,1);
  failReceipt=false;const next=await h.create().send({caseId:39,actorId:101,submitId:d.sid,retry:true});assert.equal(next.batch.status,'review');assert.equal(h.sent.length,1);
}));

test('partial ZIP delivery resumes from persisted part receipts without repeating the first part',pg,()=>fixture(async h=>{
  const d=await h.upload(randomUUID(),[h.make('One.pdf'),h.make('Two.pdf')]);let rejectSecond=true;
  h.onSend(async(_packet,n)=>{if(n===2&&rejectSecond)throw Object.assign(new Error('rate'),{response:{error_code:429}});});
  const delivery=createHandoffMaterialsDelivery({label:'Клиент',telegram:h.telegram,loadMaterials:()=>h.store.list(101,d.sid,true),maxPartBytes:350});
  const service=h.create({delivery});const first=await service.send(input(d));assert.equal(first.batch.status,'pending');assert.equal(h.sent.length,2);
  rejectSecond=false;const second=await service.send({caseId:39,actorId:101,submitId:d.sid,retry:true});assert.equal(second.delivery_complete,true);assert.equal(h.sent.length,3);assert.ok(h.sent[2].buffer.equals(h.sent[1].buffer));assert.ok(!h.sent[2].buffer.equals(h.sent[0].buffer));
}));

test('current manager access and lawyer assignment are checked again between document parts',pg,()=>fixture(async h=>{
  const d=await h.upload(randomUUID(),[h.make('One.pdf'),h.make('Two.pdf')]);
  h.onSend(async(_packet,n)=>{if(n===1)await h.db.query('UPDATE cases SET lawyer_tg_id=909 WHERE id=39');});
  const delivery=createHandoffMaterialsDelivery({label:'Клиент',telegram:h.telegram,loadMaterials:()=>h.store.list(101,d.sid,true),maxPartBytes:350});
  const service=h.create({delivery}),result=await service.send(input(d));assert.equal(result.delivery_complete,false);assert.equal(result.batch.retry,false);assert.equal(h.sent.length,1);
  await assert.rejects(service.send({caseId:39,actorId:101,submitId:d.sid,retry:true}),e=>e.code==='MATERIAL_RECIPIENT_UNAVAILABLE');assert.equal(h.sent.length,1);
  await assert.rejects(service.list(39,808),e=>e.status===403);assert.equal((await service.list(39,909)).files.length,2);
}));

test('revoked manager and unavailable lawyers cannot send even after an upload succeeds',pg,()=>fixture(async h=>{
  const d=await h.upload();await h.db.query('UPDATE staff SET approved=false WHERE tg_id=101');await assert.rejects(h.service.send(input(d)),e=>e.status===403);
  await h.db.query('UPDATE staff SET approved=true WHERE tg_id=101');await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');await assert.rejects(h.service.send(input(d)),e=>e.code==='CASE_DOCUMENT_RECIPIENT');assert.equal(h.sent.length,0);
}));

test('access revocation after preparation stops before the network send and retains the batch',pg,()=>fixture(async h=>{
  const d=await h.upload();let changed=false;
  h.before(async(sql,args)=>{if(!changed&&sql.startsWith('UPDATE case_document_batches SET delivery')&&JSON.parse(args[1]).packetHash){changed=true;await h.db.query('UPDATE staff SET approved=false WHERE tg_id=101');}});
  const first=await h.service.send(input(d));assert.equal(first.delivery_complete,false);assert.equal(h.sent.length,0);
  await h.db.query('UPDATE staff SET approved=true WHERE tg_id=101');assert.equal((await h.service.send({caseId:39,actorId:101,submitId:d.sid,retry:true})).delivery_complete,true);assert.equal(h.sent.length,1);
}));

test('download authorization rejects foreign lawyers, auditors, cross-case IDs and revoked access',pg,()=>fixture(async h=>{
  const d=await h.upload();await h.service.send(input(d));
  for(const actor of [909,707,999]){await assert.rejects(h.service.list(39,actor),e=>e.status===403);await assert.rejects(h.service.file(39,d.sid,d.files[0].id,actor),e=>e.status===403);}
  await assert.rejects(h.service.send({...input(d),actorId:808}),e=>e.status===403);
  await assert.rejects(h.service.file(40,d.sid,d.files[0].id,909),e=>e.status===404);
  await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');await assert.rejects(h.service.file(39,d.sid,d.files[0].id,808),e=>e.status===403);
}));

test('downloads verify original bytes and recheck access after reading them',pg,()=>fixture(async h=>{
  const d=await h.upload();await h.service.send(input(d));const store={...h.store,async read(...args){const file=await h.store.read(...args);await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');return file;}};
  await assert.rejects(h.create({store}).file(39,d.sid,d.files[0].id,808),e=>e.status===403);
  await h.db.query('UPDATE staff SET approved=true WHERE tg_id=808');await h.db.query('UPDATE handoff_manual_materials SET content=$1 WHERE submit_id=$2',[Buffer.alloc(d.originals[0].buffer.length),d.sid]);
  await assert.rejects(h.service.file(39,d.sid,d.files[0].id,808),e=>e.code==='HANDOFF_MATERIAL_INTEGRITY');
}));

test('concurrent delivery lock prevents duplicate sends and malformed requests are rejected',pg,()=>fixture(async h=>{
  const d=await h.upload();h.blocked(true);await assert.rejects(h.service.send(input(d)),e=>e.code==='CASE_DOCUMENT_BUSY');h.blocked(false);
  for(const change of [{caseId:0},{caseId:'39abc'},{submitId:'wrong'},{files:Array(21).fill(d.files[0])}])await assert.rejects(h.service.send({...input(d),...change}),e=>e.status===400);
  assert.equal(h.sent.length,0);
}));

test('HTTP routes deliver, list and download scoped originals with private caching and truthful errors',pg,()=>fixture(async h=>{
  const express=require('express'),app=express();let actor=101;app.use(express.json());app.use((req,res,next)=>{req.tgUser={id:actor};next();});setupHandoffCaseDocuments(app,{service:h.service});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base='http://127.0.0.1:'+server.address().port;
  try{
    const d=await h.upload(),url=base+'/api/handoff/cases/39/documents';const posted=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submit_id:d.sid,files:d.files})});assert.equal(posted.status,200);assert.equal((await posted.json()).delivery_complete,true);
    actor=808;const response=await fetch(url),list=await response.json();assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(list.batches.length,1);
    const download=await fetch(base+list.files[0].url);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.ok(Buffer.from(await download.arrayBuffer()).equals(d.originals[0].buffer));
    actor=909;assert.equal((await fetch(base+list.files[0].url)).status,403);actor=808;assert.equal((await fetch(url+'/'+d.sid+'/retry',{method:'POST'})).status,403);
    actor=101;assert.equal((await fetch(url+'/'+d.sid+'/retry',{method:'POST'})).status,200);assert.equal(h.sent.length,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
}));
