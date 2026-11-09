'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {createManualMaterialsStore,setupHandoffManualMaterials}=require('../src/web/handoff-manual-materials');
const {createHandoffMaterialsDelivery}=require('../src/web/handoff-materials');
const pg={skip:!process.env.PGLITE_TEST_MODULE};
async function fixture(run) {
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();let busy=false;
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);
    INSERT INTO staff VALUES(101,'manager',true),(102,'manager',true),(808,'lawyer',true);
    CREATE TABLE cases(id SERIAL PRIMARY KEY,created_by BIGINT,handoff_submit_id TEXT,data JSONB DEFAULT '{}');`);
  const query=(sql,args)=>sql.startsWith('SELECT pg_try_advisory_xact_lock')?Promise.resolve({rows:[{locked:!busy}]}):args?db.query(sql,args):db.exec(sql).then(r=>r.at(-1));
  const pool={query,async connect(){return{query,release(){}};}},store=createManualMaterialsStore(pool),sid=randomUUID();
  const file={originalname:'Договор.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-1.7\nSynthetic manager original\n%%EOF')};
  const makeCase=async files=>(await db.query('INSERT INTO cases(created_by,handoff_submit_id,data) VALUES(101,$1,$2) RETURNING id',[sid,JSON.stringify({_handoff:{body:{manual_client:true,submit_id:sid,manual_files:files}}})])).rows[0].id;
  try{await run({db,pool,store,sid,file,makeCase,busy(value){busy=value;}});}finally{await db.close();}
}
test('manual originals persist across store restart, keep exact bytes and are isolated by manager and draft',pg,()=>fixture(async h=>{
  const files=await h.store.put(101,h.sid,h.file);assert.equal(files.length,1);assert.equal('buffer' in files[0],false);
  const restored=createManualMaterialsStore(h.pool);assert.deepEqual(await restored.list(101,h.sid),files);assert.deepEqual(await restored.list(102,h.sid),[]);assert.deepEqual(await restored.list(101,randomUUID()),[]);
  const original=(await restored.list(101,h.sid,true))[0];assert.ok(original.buffer.equals(h.file.buffer));
  assert.equal(original.sha256,createHash('sha256').update(h.file.buffer).digest('hex'));
  assert.deepEqual(await restored.put(101,h.sid,h.file),files,'Retry after a lost upload response must not duplicate a file');
}));
test('the first manual upload works on a fresh cases schema before any handoff submit adds its columns',pg,()=>fixture(async h=>{
  await h.db.exec('ALTER TABLE cases DROP COLUMN handoff_submit_id');
  const files=await h.store.put(101,h.sid,h.file);assert.equal(files.length,1);
  const caseId=await h.makeCase(files);assert.ok((await h.store.loadCase(caseId))[0].buffer.equals(h.file.buffer));
}));
test('manual freeze refuses missing, replaced and corrupted originals before a case can be created',pg,()=>fixture(async h=>{
  const files=await h.store.put(101,h.sid,h.file);
  await assert.rejects(h.store.freeze(h.pool,101,h.sid,[]),e=>e.code==='HANDOFF_MATERIAL_CHANGED');
  await assert.rejects(h.store.freeze(h.pool,101,h.sid,[{...files[0],name:'Other.pdf'}]),e=>e.code==='HANDOFF_MATERIAL_CHANGED');
  assert.deepEqual(await h.store.freeze(h.pool,101,h.sid,files),files);
  await h.db.query('UPDATE handoff_manual_materials SET content=$1',[Buffer.alloc(h.file.buffer.length,0)]);
  await assert.rejects(h.store.freeze(h.pool,101,h.sid,files),e=>e.code==='HANDOFF_MATERIAL_INTEGRITY');
  assert.equal((await h.db.query('SELECT id FROM cases')).rows.length,0);
}));
test('manual files can be removed before handoff but cannot be changed after its durable case exists',pg,()=>fixture(async h=>{
  let files=await h.store.put(101,h.sid,h.file);assert.deepEqual(await h.store.remove(101,h.sid,files[0].id),[]);
  files=await h.store.put(101,h.sid,h.file);const caseId=await h.makeCase(files);
  await assert.rejects(h.store.remove(101,h.sid,files[0].id),e=>e.code==='HANDOFF_MATERIAL_FROZEN');
  await assert.rejects(h.store.put(101,h.sid,{...h.file,originalname:'Другой.pdf'}),e=>e.code==='HANDOFF_MATERIAL_FROZEN');
  assert.ok((await h.store.loadCase(caseId))[0].buffer.equals(h.file.buffer));
}));
test('an accepted uppercase draft UUID loads the exact case originals and retains canonical mutation locking',pg,()=>fixture(async h=>{
  const upper=h.sid.toUpperCase(),files=await h.store.put(101,upper,h.file);
  const c=(await h.db.query('INSERT INTO cases(created_by,handoff_submit_id,data) VALUES(101,$1,$2) RETURNING id',[h.sid,JSON.stringify({_handoff:{body:{manual_client:true,submit_id:upper,manual_files:files}}})])).rows[0];
  assert.ok((await h.store.loadCase(c.id))[0].buffer.equals(h.file.buffer));
  await assert.rejects(h.store.remove(101,upper,files[0].id),e=>e.code==='HANDOFF_MATERIAL_FROZEN');
  await h.db.query('UPDATE cases SET data=$1 WHERE id=$2',[JSON.stringify({_handoff:{body:{manual_client:true,submit_id:randomUUID(),manual_files:files}}}),c.id]);
  await assert.rejects(h.store.loadCase(c.id),e=>e.status===404);
}));
test('manual upload and delete stop when the send lock is held or manager approval is revoked',pg,()=>fixture(async h=>{
  const files=await h.store.put(101,h.sid,h.file);h.busy(true);
  await assert.rejects(h.store.remove(101,h.sid,files[0].id),e=>e.code==='HANDOFF_BUSY');
  h.busy(false);await h.db.query('UPDATE staff SET approved=false WHERE tg_id=101');
  await assert.rejects(h.store.remove(101,h.sid,files[0].id),e=>e.status===403);
  await assert.rejects(h.store.put(101,h.sid,h.file),e=>e.status===403);
  assert.equal((await h.store.list(101,h.sid)).length,1);
}));
test('manual file limits reject empty or oversized originals and the twenty-first file',pg,()=>fixture(async h=>{
  await assert.rejects(h.store.put(101,h.sid,{...h.file,buffer:Buffer.alloc(0)}));
  await assert.rejects(h.store.put(101,h.sid,{...h.file,buffer:Buffer.alloc(12*1024*1024+1)}));
  for(let i=0;i<20;i++)await h.store.put(101,h.sid,{...h.file,originalname:i+'.pdf'});
  await assert.rejects(h.store.put(101,h.sid,{...h.file,originalname:'21.pdf'}),e=>e.status===413);
  assert.equal((await h.store.list(101,h.sid)).length,20);
}));
test('manual client ZIP uses client labels and retains receipt checkpoints across repeat delivery',pg,()=>fixture(async h=>{
  const files=await h.store.put(101,h.sid,h.file),caseId=await h.makeCase(files),sent=[];
  const delivery=createHandoffMaterialsDelivery({label:'Клиент',loadMaterials:id=>h.store.loadCase(id),telegram:{async sendDocument(chat,document,options){const chunks=[];for await(const part of document.source)chunks.push(part);sent.push({chat,document,options,buffer:Buffer.concat(chunks)});return{message_id:900,chat:{id:chat}};}}});
  const first=await delivery(caseId,[{chat:808}],[],{expectedFiles:files});assert.equal(first.ok,true);assert.equal(sent.length,1);assert.match(sent[0].document.filename,/^Клиент-/);assert.match(sent[0].options.caption,/Документы клиента/);assert.ok(sent[0].buffer.includes(h.file.buffer));
  const again=await delivery(caseId,[{chat:808}],[],{expectedFiles:files,packetHash:first.packetHash,confirmed:{808:[900]}});assert.equal(again.ok,true);assert.equal(sent.length,1);
}));
test('manual material HTTP handlers accept multipart and reject foreign roles and frozen mutations',pg,()=>fixture(async h=>{
  const express=require('express'),app=express();let role=101;
  app.use((req,res,next)=>{req.tgUser={id:role};next();});setupHandoffManualMaterials(app,{pool:h.pool,store:h.store});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const url='http://127.0.0.1:'+server.address().port+'/api/handoff/manual-materials?submit_id='+h.sid;
  try{
    const data=new FormData();data.append('file',new Blob([h.file.buffer],{type:'application/pdf'}),h.file.originalname);
    let response=await fetch(url,{method:'POST',body:data});const uploaded=await response.json();assert.equal(response.status,200,JSON.stringify(uploaded));assert.equal(uploaded.files.length,1);assert.equal(uploaded.files[0].name,h.file.originalname);
    const retry=new FormData();retry.append('file',new Blob([h.file.buffer],{type:'application/pdf'}),h.file.originalname);
    const retried=await(await fetch(url,{method:'POST',body:retry})).json();assert.deepEqual(retried.files,uploaded.files,'An exact multipart retry after a lost upload response must reuse the saved original');
    role=102;assert.deepEqual((await(await fetch(url)).json()).files,[]);
    role=808;assert.equal((await fetch(url)).status,403);
    role=101;await h.makeCase(uploaded.files);response=await fetch(url.replace('?','/'+uploaded.files[0].id+'?'),{method:'DELETE'});assert.equal(response.status,409);
  }finally{await new Promise(resolve=>server.close(resolve));}
}));
test('actual multipart rejects extra fields, a second file and an oversized file with truthful limit messages',pg,()=>fixture(async h=>{
  const express=require('express'),app=express();app.use((req,res,next)=>{req.tgUser={id:101};next();});setupHandoffManualMaterials(app,{pool:h.pool,store:h.store});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const url='http://127.0.0.1:'+server.address().port+'/api/handoff/manual-materials?submit_id='+h.sid;
  try{
    for(const type of ['field','file','size']){
      const data=new FormData();data.append('file',new Blob([type==='size'?Buffer.alloc(12*1024*1024+1):h.file.buffer],{type:'application/pdf'}),'Document.pdf');
      if(type==='field')data.append('extra','Unexpected');if(type==='file')data.append('file',new Blob([h.file.buffer],{type:'application/pdf'}),'Other.pdf');
      const response=await fetch(url,{method:'POST',body:data}),body=await response.json();assert.equal(response.status,413,JSON.stringify(body));
      if(type==='size'){assert.equal(body.code,'LIMIT_FILE_SIZE');assert.match(body.error,/12 МБ/);}else{assert.match(body.code,/^LIMIT_/);assert.match(body.error,/один документ/);assert.doesNotMatch(body.error,/12 МБ/);}
      assert.deepEqual(await h.store.list(101,h.sid),[]);
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
}));
