const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const pg = { skip:!process.env.PGLITE_TEST_MODULE, concurrency:false };
let service, objects, nativeGet;
before(async () => {
  if (pg.skip) return;
  service = await require('./e2e/helpers').createService({ master:true });
  objects = require('../src/bot/egrn-object-store').createEgrnObjectStore(); nativeGet = objects.get;
});
after(async () => { if (objects) objects.get = nativeGet; await service?.close(); });
async function original(mime='application/pdf') {
  const draft=randomUUID(),id=randomUUID(),key='audit-originals/'+draft+'/'+randomUUID();
  const bytes=Buffer.from(mime==='application/pdf'?'%PDF-1.7\nSynthetic owned report original\n%%EOF':'Synthetic byte-exact '+mime+' original');
  await service.pool.query('INSERT INTO audit_drafts(id,author_tg_id,order_id,data,submitted_at) VALUES($1,1001,58,$2,NOW())',[draft,'{}']);
  await service.pool.query('INSERT INTO audit_evidence(draft_id,id,name,mime,role,subject_id,bytes,sha256,content,storage,object_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)',[draft,id,'Исходник.'+({'image/jpeg':'jpg','image/png':'png'}[mime]||'pdf'),mime,'plan-source','source',bytes.length,createHash('sha256').update(bytes).digest('hex'),'s3',key]);
  service.objects.set(key,bytes);return {draft,id,bytes,mime};
}
async function request(file,actor=1001) {
  const auth=new URLSearchParams(service.keyQuery(actor));
  const response=await fetch(service.origin+'/api/audit/drafts/'+file.draft+'/evidence/'+file.id,{headers:{'X-Tg-U':auth.get('u'),'X-Tg-K':auth.get('k')}});
  return {status:response.status,headers:response.headers,body:Buffer.from(await response.arrayBuffer())};
}

test('all approved roles retain byte-exact owned JPG, PNG and PDF originals after the final approval check',pg,async()=>{
  for (const [role,mime] of [['auditor','image/jpeg'],['lawyer','image/png'],['manager','application/pdf']]) {
    await service.pool.query('UPDATE staff SET approved=true,role=$1 WHERE tg_id=1001',[role]);
    const file=await original(mime),result=await request(file);
    assert.equal(result.status,200);assert.ok(result.body.equals(file.bytes));assert.equal(result.headers.get('Content-Type'),mime);
    assert.match(result.headers.get('Content-Disposition'),/^attachment;/);assert.equal(result.headers.get('Cache-Control'),'no-store');
  }
  await service.pool.query("UPDATE staff SET role='auditor' WHERE tg_id=1001");
});

test('approval revoked while an audit original is being read returns no original bytes and a later lawful retry stays exact',pg,async()=>{
  const file=await original();let entered,release;
  const reading=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  objects.get=async function(...args){entered();await hold;return nativeGet.apply(this,args);};
  try {
    const pending=request(file);await reading;await service.pool.query('UPDATE staff SET approved=false WHERE tg_id=1001');release();
    const result=await pending;assert.equal(result.status,403);assert.equal(JSON.parse(result.body).code,'AUDIT_FORBIDDEN');assert.equal(result.body.equals(file.bytes),false);assert.equal(result.headers.get('Content-Disposition'),null);
  } finally { release?.();objects.get=nativeGet;await service.pool.query('UPDATE staff SET approved=true WHERE tg_id=1001'); }
  assert.ok((await request(file)).body.equals(file.bytes));assert.equal(service.messages.length,0);assert.equal(service.egrnRequests.length,0);
});

test('a final audit approval lookup failure is sanitized and cannot return the already-read original',pg,async()=>{
  const file=await original(),query=service.pool.query;let fail=false;
  objects.get=async function(...args){const result=await nativeGet.apply(this,args);fail=true;return result;};
  service.pool.query=async function(sql,...args){if(fail&&sql.startsWith('SELECT tg_id FROM staff WHERE tg_id=$1 AND approved IS TRUE'))throw new Error('Synthetic private SQL detail must stay hidden');return query.call(this,sql,...args);};
  try {
    const result=await request(file);assert.equal(result.status,503);assert.equal(JSON.parse(result.body).code,'AUDIT_ACCESS_UNAVAILABLE');assert.doesNotMatch(result.body.toString(),/private SQL|Synthetic owned|%PDF/);assert.equal(result.headers.get('Content-Disposition'),null);
  } finally { service.pool.query=query;objects.get=nativeGet; }
  assert.ok((await request(file)).body.equals(file.bytes));
});

test('an unreadable audit object returns a safe error rather than private bytes or an empty successful file',pg,async()=>{
  const file=await original();objects.get=async()=>{throw new Error('Synthetic private storage failure');};
  try {
    const result=await request(file);assert.equal(result.status,503);assert.equal(JSON.parse(result.body).code,'AUDIT_EVIDENCE_READ');assert.doesNotMatch(result.body.toString(),/private storage|Synthetic owned|%PDF/);assert.equal(result.headers.get('Content-Disposition'),null);
  } finally { objects.get=nativeGet; }
});

test('the added final approval gate does not broaden draft ownership for another approved actor',pg,async()=>{
  const file=await original();let opened=0;objects.get=async function(...args){opened++;return nativeGet.apply(this,args);};
  try { const result=await request(file,2001);assert.equal(result.status,404);assert.equal(JSON.parse(result.body).code,'NOT_FOUND');assert.equal(opened,0); }
  finally { objects.get=nativeGet; }
});
