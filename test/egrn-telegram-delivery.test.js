'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createEgrnTelegramDelivery}=require('../src/bot/egrn-telegram-delivery');
const {createLargeDelivery}=require('../src/bot/egrn-large-delivery');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:15000};
async function fixture(run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();let fail,after;
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,approved BOOLEAN,role TEXT);INSERT INTO staff VALUES(111,true,'manager'),(222,true,'lawyer'),(333,false,'auditor');
    CREATE TABLE cases(id INT PRIMARY KEY,lawyer_tg_id BIGINT);INSERT INTO cases VALUES(9,222);
    CREATE TABLE egrn_orders(id INT PRIMARY KEY,id_statement BIGINT,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ,files_sent INT DEFAULT 0,failures INT DEFAULT 0,retry_at TIMESTAMPTZ,error TEXT,file_msgs JSONB DEFAULT '[]',deliver JSONB DEFAULT '[]',processing_token UUID DEFAULT gen_random_uuid(),processing_until TIMESTAMPTZ DEFAULT NOW()+INTERVAL '2 minutes',delivery_state JSONB NOT NULL DEFAULT '{}');
    INSERT INTO egrn_orders(id,id_statement,status) VALUES(1,7001,'done');`);
  let queue=Promise.resolve();
  const query=async(sql,args)=>{if(fail?.(sql,args))throw Object.assign(new Error('Synthetic SQL write failure'),{code:'QA_SQL'});const result=args?await db.query(sql,args):(await db.exec(sql)).at(-1);await after?.(sql,db);return result;};
  const pool={async connect(){const before=queue;let done;queue=new Promise(r=>done=r);await before;return{query,release:done};},async query(sql,args){const c=await pool.connect();try{return await c.query(sql,args);}finally{c.release();}}};
  const env={EGRN_CHAT_ID:'-100123',GROUP_CHAT_ID:'-100456',ADMIN_TG_IDS:'111'};
  const make=()=>createEgrnTelegramDelivery({pool,env});
  const row=async()=> (await pool.query('SELECT * FROM egrn_orders WHERE id=1')).rows[0];
  const acquire=async()=> (await pool.query("UPDATE egrn_orders SET processing_token=gen_random_uuid(),processing_until=NOW()+INTERVAL '2 minutes' WHERE id=1 RETURNING *")).rows[0];
  const release=()=>pool.query('UPDATE egrn_orders SET processing_token=NULL,processing_until=NULL WHERE id=1');
  try{await run({pool,make,row,acquire,release,setFailure(fn){fail=fn;},setAfterQuery(fn){after=fn;}});}finally{await db.close();}
}
const op=(kind='native-primary',chat=-100123)=>({kind,key:'sha256:original',target:{chat}});
const receipt=(chat=-100123,id=55)=>({key:'sha256:original',chat,id});

test('native primary ACK loss survives restart and only a new explicit admin retry event can authorize another delivery',pg,()=>fixture(async h=>{
  const protocol=h.make(),order=await h.row();let sent=0;
  await assert.rejects(protocol.send(order,op(),async()=>{sent++;throw new Error('Network ACK lost after physical delivery');}),e=>e.uncertain===true);
  assert.ok((await h.row()).delivery_state.inflight);
  assert.throws(()=>h.make().assertAvailable(order),e=>e.uncertain===true);
  await h.release();
  assert.equal((await h.make().retry(7001,222,1)).state,'admin_required');
  assert.equal((await h.make().retry(7001,111,10)).state,'ready');
  const second=await h.acquire();await assert.rejects(h.make().send(second,op(),async()=>{sent++;throw {response:{error_code:500}};}),e=>e.uncertain===true);await h.release();
  const pending=(await h.row()).delivery_state.inflight.attempt;
  assert.equal((await h.make().retry(7001,111,10)).state,'replayed');assert.equal((await h.row()).delivery_state.inflight.attempt,pending);
  assert.equal((await h.make().retry(7001,111,11)).state,'ready');assert.equal(sent,2);
}));

for(const ack of [undefined,true,{message_id:true},{message_id:'1e3'},{message_id:0},{message_id:Number.MAX_SAFE_INTEGER+1}])test('malformed ACK retains durable intent: '+JSON.stringify(ack),pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();await assert.rejects(p.send(o,op(),async()=>ack),e=>e.uncertain===true);
  assert.ok((await h.row()).delivery_state.inflight);assert.throws(()=>h.make().assertAvailable(o),e=>e.code==='EGRN_DELIVERY_UNCONFIRMED');
}));

test('success atomically checkpoints only the matching receipt; either checkpoint write failure preserves the unknown marker',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();await p.send(o,op(),async()=>({message_id:55}));
  await assert.rejects(p.persist(o,[receipt(-100123,56)]),e=>e.uncertain===true);assert.ok((await h.row()).delivery_state.inflight);
  h.setFailure(sql=>sql.startsWith('UPDATE egrn_orders SET file_msgs='));await assert.rejects(p.persist(o,[receipt()]),e=>e.code==='EGRN_DELIVERY_CHECKPOINT');assert.deepEqual((await h.row()).file_msgs,[]);
  h.setFailure(null);await p.persist(o,[receipt()]);assert.equal((await h.row()).delivery_state.inflight,undefined);assert.equal((await h.row()).file_msgs[0].id,55);
}));

test('intent write failure and revoked recipient after SQL wait perform no Telegram operation',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();let sends=0;
  h.setFailure(sql=>sql.includes('jsonb_set(COALESCE(delivery_state'));await assert.rejects(p.send(o,op(),async()=>{sends++;}),/SQL write/);assert.equal(sends,0);assert.deepEqual((await h.row()).delivery_state,{});
  h.setFailure(null);await h.pool.query('UPDATE staff SET approved=false WHERE tg_id=222');await assert.rejects(p.send(o,op('native-copy',222),async()=>{sends++;}),e=>e.code==='EGRN_RECIPIENT_UNAVAILABLE');assert.equal(sends,0);assert.deepEqual((await h.row()).delivery_state,{});
}));

for(const change of ['approval','assignment','role'])test('dispatch preparation rechecks '+change+' after its readonly snapshot await and clears its own unsent intent',pg,()=>fixture(async h=>{
  const protocol=h.make(),order=await h.row();let sends=0;
  await assert.rejects(protocol.send(order,{...op('native-copy',222),target:{chat:222,case_id:9}},async recheck=>{
    // The mutation occurs after the original preflight, as if another request
    // changed access while this callback awaited its accounting snapshot.
    if(change==='approval')await h.pool.query('UPDATE staff SET approved=false WHERE tg_id=222');
    if(change==='assignment')await h.pool.query('UPDATE cases SET lawyer_tg_id=111 WHERE id=9');
    if(change==='role')await h.pool.query("UPDATE staff SET role='auditor' WHERE tg_id=222");
    await recheck();sends++;return{message_id:55};
  }),e=>e.code==='EGRN_RECIPIENT_UNAVAILABLE'&&e.uncertain===false&&e.delivery_stage==='validation');
  assert.equal(sends,0);assert.equal((await h.row()).delivery_state.inflight,undefined);
}));

test('dispatch preparation cannot clear another owners intent after losing its lease while reading accounting',pg,()=>fixture(async h=>{
  const protocol=h.make(),order=await h.row();let sends=0;
  await assert.rejects(protocol.send(order,op(),async recheck=>{
    await h.pool.query('UPDATE egrn_orders SET processing_token=gen_random_uuid() WHERE id=1');
    await recheck();sends++;return{message_id:55};
  }),e=>e.uncertain===true);
  assert.equal(sends,0);assert.ok((await h.row()).delivery_state.inflight);
}));

for(const code of [400,403,413,429])test('definite Telegram '+code+' rejection safely clears only its own intent',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();await assert.rejects(p.send(o,op(),async()=>{throw {response:{error_code:code}};}),e=>e.uncertain===false);
  assert.equal((await h.row()).delivery_state.inflight,undefined);await p.send(o,op(),async()=>({message_id:55}));await p.persist(o,[receipt()]);
}));

test('a lost rejection checkpoint stays unknown, and a busy retry event cannot later reset a different attempt',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();h.setFailure(sql=>sql.includes("delivery_state=delivery_state-'inflight'"));
  await assert.rejects(p.send(o,op(),async()=>{throw {response:{error_code:400}};}),e=>e.uncertain===true);h.setFailure(null);
  const first=(await h.row()).delivery_state.inflight.attempt;assert.equal((await p.retry(7001,111,5)).state,'busy');assert.equal((await h.row()).delivery_state.inflight.attempt,first);
  await h.release();assert.equal((await p.retry(7001,111,6)).state,'ready');const second=await h.acquire();await assert.rejects(p.send(second,op(),async()=>{throw new Error('New ACK lost');}),e=>e.uncertain===true);await h.release();
  const latest=(await h.row()).delivery_state.inflight.attempt;assert.notEqual(latest,first);assert.equal((await h.make().retry(7001,111,5)).state,'replayed');assert.equal((await h.row()).delivery_state.inflight.attempt,latest);
}));

test('consume-only busy command preserves an inactive unknown generation and consumes only the issuing actor cursor',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();await assert.rejects(p.send(o,op(),async()=>{throw new Error('ACK lost');}));await h.release();
  await h.pool.query("UPDATE egrn_orders SET files_sent=-1,failures=5,error='review needed' WHERE id=1");const before=await h.row();
  assert.equal((await p.retry(7001,111,10,{consumeOnly:true})).state,'busy');const busy=await h.row();
  assert.equal(busy.delivery_state.inflight.attempt,before.delivery_state.inflight.attempt);assert.equal(busy.files_sent,-1);assert.equal(busy.failures,5);assert.equal(busy.error,'review needed');assert.deepEqual(busy.delivery_state.retry_cursors,{'111':10});
  assert.equal((await p.retry(7001,111,10)).state,'replayed');assert.ok((await h.row()).delivery_state.inflight);
  assert.equal((await p.retry(7001,111,11)).state,'ready');assert.equal((await h.row()).delivery_state.inflight,undefined);
}));

test('live authorization allows configured groups/admins but blocks revoked private targets and reassigned cases',pg,()=>fixture(async h=>{
  const p=h.make();await p.authorize({}, {chat:-100456});await p.authorize({}, {chat:111});await p.authorize({}, {chat:222,case_id:9});
  for(const target of [{chat:333},{chat:-100999},{chat:222,case_id:999}])await assert.rejects(p.authorize({},target),e=>e.code==='EGRN_RECIPIENT_UNAVAILABLE');
  await h.pool.query('UPDATE cases SET lawyer_tg_id=111 WHERE id=9');await assert.rejects(p.authorize({deliver:[{chat:222,case_id:9}]},{chat:222}),e=>e.code==='EGRN_RECIPIENT_UNAVAILABLE');
  await h.pool.query("UPDATE cases SET lawyer_tg_id=222 WHERE id=9;UPDATE staff SET role='auditor' WHERE tg_id=222");await assert.rejects(p.authorize({}, {chat:222,case_id:9}),e=>e.code==='EGRN_RECIPIENT_UNAVAILABLE');await p.authorize({}, {chat:222});
}));

test('an ACK for another chat or another original in that chat cannot confirm a new original',pg,()=>fixture(async h=>{
  let event=100;
  for(const previous of [{key:'different-original',chat:-100123,id:55},{key:'different-original',chat:111,id:22,deliveries:[{chat:-100123,id:55}]}]){
    const p=h.make(),o=await h.acquire();o.file_msgs=[previous];await h.pool.query('UPDATE egrn_orders SET file_msgs=$1 WHERE id=1',[JSON.stringify(o.file_msgs)]);
    await assert.rejects(p.send(o,op(),async()=>({message_id:55})),e=>e.uncertain===true);await h.release();assert.equal((await p.retry(7001,111,++event)).state,'ready');
  }
  const p=h.make(),o=await h.acquire();await assert.rejects(p.send(o,op(),async()=>({message_id:99,chat:{id:222}})),e=>e.uncertain===true);assert.ok((await h.row()).delivery_state.inflight);
}));

test('approval changed between the recipient read and final ownership SQL prevents dispatch',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();let reads=0,sends=0;
  h.setAfterQuery(async(sql,db)=>{if(sql==='SELECT approved FROM staff WHERE tg_id=$1'&&++reads===2)await db.query('UPDATE staff SET approved=false WHERE tg_id=222');});
  await assert.rejects(p.send(o,op('native-copy',222),async()=>{sends++;return {message_id:55};}));assert.equal(sends,0);
}));

test('case authorization is rechecked after intent SQL, and known validation rejection safely clears the marker',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();let sends=0;
  h.setAfterQuery(async(sql,db)=>{if(sql.includes('jsonb_set(COALESCE(delivery_state'))await db.query('UPDATE cases SET lawyer_tg_id=111 WHERE id=9');});
  await assert.rejects(p.send(o,{...op('native-copy',222),target:{chat:222,case_id:9}},async()=>{sends++;return {message_id:55};}),e=>e.code==='EGRN_RECIPIENT_UNAVAILABLE'&&e.uncertain===false);
  assert.equal(sends,0);assert.equal((await h.row()).delivery_state.inflight,undefined);
  h.setAfterQuery(null);
  await assert.rejects(p.send(o,op('native-copy',222),async()=>{throw Object.assign(new Error('Assignment changed at handoff boundary'),{delivery_stage:'validation',uncertain:false,code:'HANDOFF_RECIPIENT_UNAVAILABLE'});}),e=>e.uncertain===false);
  assert.equal((await h.row()).delivery_state.inflight,undefined);
}));

test('lease ownership lost during recipient SQL cannot dispatch an original from the obsolete worker',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();let sends=0;
  h.setAfterQuery(async(sql,db)=>{if(sql.includes('jsonb_set(COALESCE(delivery_state'))await db.query("UPDATE egrn_orders SET processing_token=gen_random_uuid(),processing_until=NOW()+INTERVAL '2 minutes' WHERE id=1");});
  await assert.rejects(p.send(o,op('native-copy',222),async()=>{sends++;return {message_id:55};}));
  assert.equal(sends,0);assert.ok((await h.row()).delivery_state.inflight);
}));

test('large link ACK loss is durable before send, halts later recipients and survives actual module restart without reading original bytes',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();Object.assign(o,{chat_id:-100123,ordered_by:111,deliver:[{chat:222}],cad_num:'77:01:0000001:1'});
  const id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64),meta={id,name:'full.pdf',mime:'application/pdf',bytes:350*1024*1024,sha256:hash,egrn_order_id:1};let sends=0,opens=0;
  const make=()=>createLargeDelivery({telegram:{async sendMessage(){sends++;assert.ok((await h.row()).delivery_state.inflight);throw new Error('ACK lost');}},store:{saveStream:async()=>meta,get:async()=>meta},makeUrl:()=> 'https://fixture.invalid/full.pdf',persist:(order,records)=>p.persist(order,records),sendOriginal:(record,target,run)=>p.send(o,{kind:'large-link',key:record.key,target},run)});
  const records=[];await assert.rejects(make().deliver(o,{name:'full.pdf',bytes:meta.bytes,sha256:hash,open(){opens++;throw new Error('Unneeded content read');}},'sha256:original',records),e=>e.uncertain===true&&/Проверьте сообщения/.test(e.message)&&!e.message.includes('автоматически'));
  assert.equal(sends,1);assert.equal(opens,0);assert.equal((await h.row()).file_msgs.length,1);
  const fresh=await h.row();assert.throws(()=>h.make().assertAvailable(fresh),e=>e.uncertain===true);assert.equal(sends,1);
}));

test('large link rejects revoked targets while preserving confirmed allowed recipients and truthful pending delivery',pg,()=>fixture(async h=>{
  const p=h.make(),o=await h.row();Object.assign(o,{chat_id:-100123,ordered_by:111,deliver:[{chat:333}]});
  const id='11111111-1111-4111-8111-111111111111',meta={id,name:'full.pdf',mime:'application/pdf',bytes:100},records=[],sent=[];
  const service=createLargeDelivery({telegram:{async sendMessage(chat){sent.push(chat);return {message_id:sent.length+10};}},store:{save:async()=>meta,get:async()=>meta},makeUrl:()=> 'https://fixture.invalid/full.pdf',persist:(order,records)=>p.persist(order,records),sendOriginal:(record,target,run)=>p.send(o,{kind:'large-link',key:record.key,target},run)});
  await assert.rejects(service.deliver(o,{name:'full.pdf',buf:Buffer.alloc(100)},'sha256:original',records),e=>e.failure_code==='EGRN_RECIPIENT_UNAVAILABLE'&&e.uncertain===false);
  assert.deepEqual(sent,[-100123,111]);assert.deepEqual((await h.row()).file_msgs[0].deliveries.map(r=>r.chat),[-100123,111]);assert.equal((await h.row()).delivery_state.inflight,undefined);
}));
