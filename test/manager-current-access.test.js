'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const materialsModule=require('../src/web/order-materials');
const {createManagerHandlers}=require('../src/web/manager-orders');
const {createOrderDeliveryLock}=require('../src/db/order-delivery-lock');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:15000},GROUP='-100321';
const gate=()=>{let open;return{promise:new Promise(resolve=>{open=resolve;}),open:()=>open()};};
const initial=()=>({address:'Москва, Исходная улица, 1',owner_name:'Синтетический клиент',object_type:'Общепит алкоголь',object_name:'Синтетическое кафе',service:'Получение',contacts:'Синтетический контакт',submit_id:'seed-order'});
const file=()=>({originalname:'Synthetic-original.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-1.7 synthetic original retained exactly')});
function response(){return{statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;},set(){return this;}};}
async function fixture(run){
 const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),events=[],provider=[];let tail=Promise.resolve(),before,after,transport=async()=>{},serial=1000;
 const pool={async connect(){const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;return{async query(sql,args){await before?.(sql,args);const result=args?await db.query(sql,args):(await db.exec(sql)).at(-1);await after?.(sql,args,result);return result;},release};},async query(sql,args){const client=await pool.connect();try{return await client.query(sql,args);}finally{client.release();}}};
 try{
  await db.exec(`CREATE TABLE orders(id SERIAL PRIMARY KEY,created_at TIMESTAMPTZ DEFAULT NOW(),address TEXT,owner_name TEXT,object_type TEXT,object_name TEXT,has_video BOOLEAN,zones_info TEXT,deadline DATE,contacts TEXT,submitted_by BIGINT,submitted_name TEXT,status TEXT DEFAULT 'new',telegram_msg_id BIGINT);
   CREATE TABLE logs(order_id INT,action TEXT,actor TEXT,details TEXT);
   CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(108,'Синтетический автор','manager',true),(109,'Синтетический менеджер','manager',true);`);
  const store=materialsModule.createMaterialsStore(pool),materials={...materialsModule,ensureOrderMaterials:store.ensure,saveOrderMaterials:store.save,saveOrderMaterialsInTransaction:store.saveInTransaction,listOrderMaterials:store.list,markOrderMaterialDelivered:store.delivered};
  function queries(){const context=vm.createContext({module:{exports:{}},require(name){if(name==='./pool')return pool;if(name==='../web/order-materials')return materials;throw new Error('Unexpected query dependency '+name);}});vm.runInContext(fs.readFileSync(require.resolve('../src/db/queries'),'utf8'),context);return context.module.exports;}
  const q=queries(),seed=await q.createOrderWithMaterials({...materials.normalizeManagerOrder(initial(),[]),submitted_by:108},[]);await pool.query('UPDATE orders SET telegram_msg_id=900,submitted_name=$1 WHERE id=$2',['Синтетический автор',seed.id]);const order=await q.getOrderById(seed.id),lock=createOrderDeliveryLock(pool);
  const telegram={async editMessageText(chat,id,unused,text){const event={kind:'edit',chat,text};events.push(event);await transport(event);return{message_id:Number(id),chat:{id:Number(chat)}};},async sendMessage(chat,text){const event={kind:text.startsWith('CARD ')?'card':'notice',chat,text};events.push(event);await transport(event);return{message_id:serial++,chat:{id:Number(chat)}};},async sendDocument(chat,original){const event={kind:'document',chat,name:original.filename,buffer:Buffer.from(original.source)};events.push(event);await transport(event);return{message_id:serial++,chat:{id:Number(chat)}};}};
  const handlers=()=>createManagerHandlers({pool,materials,queries:queries(),groupId:GROUP,withOrderDeliveryLock:lock,loadOrderReportLink:async()=>null,format:row=>'CARD '+row.address,getTelegram:()=>telegram,attachOrOrder:async input=>{assert.equal(input.order,false,'No paid provider request');provider.push(input);return{result:'waiting',cad:input.cad};}});
  const request=(actor=109,sid='edit-access',changes={})=>({params:{id:String(order.id)},tgUser:{id:actor},staff:{name:'Старое имя',role:'manager',approved:true},files:[],body:{...initial(),...order,submit_id:sid,...changes}});
  const create=(actor=108,sid='create-access')=>({params:{},tgUser:{id:actor},staff:{name:'Старое имя',role:'auditor',approved:true},files:[],body:{...initial(),submit_id:sid}});
  const counts=async()=>{const result={};for(const table of ['orders','order_materials','logs','order_packet_submissions'])result[table]=Number((await db.query('SELECT COUNT(*) AS n FROM '+table)).rows[0].n);return result;};
  await run({db,pool,materials,store,q,queries,order,events,provider,handlers,request,create,lock,counts,before(fn){before=fn;},after(fn){after=fn;},transport(fn){transport=fn;}});
  assert.ok(events.every(event=>String(event.chat)===GROUP),'Only the synthetic working chat is used');
 }finally{await db.close();}
}

for(const change of ['revoke','role'])test('a queued foreign-author edit rechecks current '+change+' after order lock119 before any mutation or Telegram',pg,async()=>fixture(async h=>{
 const entered=gate(),release=gate(),holding=h.lock(h.order.id,async()=>{entered.open();await release.promise;});await entered.promise;
 const req=h.request(109,'queued-'+change,{address:'Москва, Запрещённый адрес, 2'}),res=response(),counts=await h.counts(),pending=h.handlers().save(req,res);await new Promise(resolve=>setImmediate(resolve));
 try{await h.db.query(change==='revoke'?'UPDATE staff SET approved=false WHERE tg_id=109':"UPDATE staff SET role='lawyer' WHERE tg_id=109");}finally{release.open();}
 await holding;await pending;assert.equal(res.statusCode,403);assert.equal(res.body.code,'ORDER_PACKET_FORBIDDEN');assert.equal((await h.q.getOrderById(h.order.id)).address,h.order.address);assert.deepEqual(await h.counts(),counts);assert.equal(h.events.length,0);
}));

test('an approved auditor may edit their own order without granting them another author\'s manager rights',pg,async()=>fixture(async h=>{
 await h.db.query("UPDATE staff SET role='auditor' WHERE tg_id=108");const req=h.request(108,'author-auditor',{address:'Москва, Авторский адрес, 3'});req.staff.role='auditor';const res=response();await h.handlers().save(req,res);assert.equal(res.statusCode,200);assert.equal(res.body.ok,true);assert.equal((await h.q.getOrderById(h.order.id)).address,req.body.address);assert.equal(h.events.filter(event=>event.kind==='edit').length,1);
}));

test('a current approved manager may edit another author even when the request carried a stale nonmanager role',pg,async()=>fixture(async h=>{
 const req=h.request(109,'fresh-manager',{address:'Москва, Актуальный менеджер, 4'});req.staff.role='auditor';const res=response();await h.handlers().save(req,res);assert.equal(res.statusCode,200);assert.equal(res.body.ok,true);assert.equal((await h.q.getOrderById(h.order.id)).address,req.body.address);
}));

test('new orders remain available to any approved employee including an auditor',pg,async()=>fixture(async h=>{
 await h.db.query("UPDATE staff SET role='auditor' WHERE tg_id=108");const req=h.create(),res=response();await h.handlers().save(req,res);assert.equal(res.statusCode,200);assert.equal(res.body.ok,true);assert.notEqual(res.body.id,h.order.id);assert.equal(h.events.filter(event=>event.kind==='card').length,1);assert.equal(Number((await h.q.getOrderById(res.body.id)).submitted_by),108);
}));

for(const change of ['revoke','role'])test('the final packet UPDATE enforces '+change+' after originals were staged and rolls back the whole edit',pg,async()=>fixture(async h=>{
 const original=file(),prepared=h.materials.prepareMaterials([original],['plan']),data=h.materials.normalizeManagerOrder({...initial(),address:'Москва, Не должен сохраниться, 5'},prepared),counts=await h.counts();let staged=false;
 h.before(async sql=>{if(!staged&&/^UPDATE orders SET address=/.test(sql)){staged=Number((await h.db.query('SELECT COUNT(*) AS n FROM order_materials')).rows[0].n)===1;await h.db.query(change==='revoke'?'UPDATE staff SET approved=false WHERE tg_id=109':"UPDATE staff SET role='lawyer' WHERE tg_id=109");}});
 await assert.rejects(h.q.updateOrderPacketWithMaterials(h.order.id,data,prepared,{actorId:109,actorName:'Менеджер',requiredStaffId:109,submitId:'final-'+change,signature:'b'.repeat(64),expectedRevision:h.order.packet_revision}),error=>error.status===403&&error.code==='ORDER_PACKET_FORBIDDEN');
 assert.equal(staged,true);assert.equal((await h.q.getOrderById(h.order.id)).address,h.order.address);assert.deepEqual(await h.counts(),counts);assert.equal(h.events.length,0);
}));

test('a guarded final order INSERT cannot create an order after approval is lost',pg,async()=>fixture(async h=>{
 const counts=await h.counts();let denied=false;h.before(async sql=>{if(!denied&&/^\s*INSERT INTO orders\b/.test(sql)){denied=true;await h.db.query('UPDATE staff SET approved=false WHERE tg_id=108');}});
 await assert.rejects(h.q.createOrderWithMaterials({...h.materials.normalizeManagerOrder(initial(),[]),submitted_by:108},[],{requiredStaffId:108}),error=>error.status===403&&error.code==='ORDER_PACKET_FORBIDDEN');assert.equal(denied,true);assert.deepEqual(await h.counts(),counts);assert.equal(h.events.length,0);
}));

test('database callers without the optional current-staff contract retain their existing creation behavior',pg,async()=>fixture(async h=>{
 await h.db.query('DELETE FROM staff');const saved=await h.q.createOrderWithMaterials({...h.materials.normalizeManagerOrder({...initial(),submit_id:'internal-creation'},[]),submitted_by:777},[]);assert.ok(saved.id>h.order.id);assert.equal(Number(saved.submitted_by),777);assert.equal(h.events.length,0);
}));

for(const phase of ['card','material','notice'])for(const change of ['revoke','role'])test('known '+change+' after durable '+phase+' intent blocks its physical POST and exact retry recovers after reactivation',pg,async()=>fixture(async h=>{
 if(phase==='card')await h.db.query('UPDATE orders SET telegram_msg_id=NULL WHERE id=$1',[h.order.id]);
 const req=h.request(109,'intent-'+phase+'-'+change,{address:'Москва, Сохранённый адрес, 6',...(phase==='notice'?{cad_num:'77:01:0000001:1'}:{})});if(phase==='material')req.files=[file()];
 let changed=false;h.after(async(sql,args)=>{
  if(changed||!/^UPDATE orders SET telegram_delivery/.test(sql))return;
  let isIntent=false;if(phase==='notice')isIntent=sql.includes('egrn_notices')&&JSON.parse(args?.[2]||'null')?.state==='sending';
  else{const delivery=JSON.parse(args?.[0]||'null');isIntent=phase==='card'?delivery?.card?.state==='sending':Object.values(delivery?.materials||{}).some(slot=>slot.state==='sending');}
  if(isIntent){changed=true;await h.db.query(change==='revoke'?'UPDATE staff SET approved=false WHERE tg_id=109':"UPDATE staff SET role='lawyer' WHERE tg_id=109");}
 });
 const res=response();await h.handlers().save(req,res);assert.equal(changed,true);assert.equal(res.body.ok,true,'A committed packet remains saved');assert.equal(res.body.id,h.order.id);assert.ok(res.body.warning);assert.equal((await h.q.getOrderById(h.order.id)).address,req.body.address);
 const eventKind=phase==='material'?'document':phase;assert.equal(h.events.filter(event=>event.kind===eventKind).length,0,'No native POST after known denial');
 const row=await h.q.getOrderById(h.order.id),state=row.telegram_delivery;if(phase==='card')assert.equal(state.card.state,'failed');else if(phase==='material'){assert.equal(Object.values(state.materials)[0].state,'failed');const saved=(await h.store.list(h.order.id,true))[0];assert.ok(saved.buffer.equals(req.files[0].buffer));assert.equal(saved.telegram_msg_id,null);}else assert.equal(Object.values(state.egrn_notices)[0].state,'rejected');
 await h.db.query("UPDATE staff SET approved=true,role='manager' WHERE tg_id=109");const count=await h.counts(),retry=response();await h.handlers().save(req,retry);assert.equal(retry.body.ok,true);assert.equal(retry.body.id,h.order.id);assert.equal(h.events.filter(event=>event.kind===eventKind).length,1);assert.equal((await h.counts()).orders,count.orders);assert.equal((await h.counts()).order_materials,count.order_materials);
 const settled=h.events.filter(event=>event.kind===eventKind).length,again=response();await h.handlers().save(req,again);assert.equal(again.body.ok,true);assert.equal(h.events.filter(event=>event.kind===eventKind).length,settled,'Confirmed native message is not duplicated on a later exact replay');
}));

test('an actual unknown card transport outcome still stops automatic resend rather than becoming a known access refusal',pg,async()=>fixture(async h=>{
 await h.db.query('UPDATE orders SET telegram_msg_id=NULL WHERE id=$1',[h.order.id]);h.transport(event=>{if(event.kind==='card')throw new Error('Synthetic accepted card with lost ACK');});const req=h.request(109,'network-unknown'),res=response();await h.handlers().save(req,res);assert.equal(res.body.ok,true);assert.ok(res.body.warning);assert.equal((await h.q.getOrderById(h.order.id)).telegram_delivery.card.state,'unknown');assert.equal(h.events.filter(event=>event.kind==='card').length,1);
 h.transport(async()=>{});const replay=response();await h.handlers().save(req,replay);assert.equal(replay.body.ok,true);assert.ok(replay.body.warning);assert.equal(h.events.filter(event=>event.kind==='card').length,1);assert.equal((await h.counts()).orders,1);
}));

test('a failed current-access lookup before writing returns a sanitized retryable error and changes no packet or originals',pg,async()=>fixture(async h=>{
 const counts=await h.counts(),privateDiagnostic='Synthetic SQL staff_private relation and internal details',req=h.request(109,'lookup-before',{address:'Москва, Не сохранённый адрес, 7'});req.files=[file()];
 h.before(sql=>{if(sql.includes('AS access_order_id'))throw new Error(privateDiagnostic);});const res=response();await h.handlers().save(req,res);
 assert.equal(res.statusCode,503);assert.equal(res.body.ok,false);assert.equal(res.body.code,'ORDER_PACKET_ACCESS_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(res.body),/staff_private|internal details|Synthetic SQL/);assert.match(res.body.error,/проверить.*доступ|проверку/i);
 assert.deepEqual(await h.counts(),counts);assert.equal((await h.q.getOrderById(h.order.id)).address,h.order.address);assert.equal(h.events.length,0);
}));

test('a failed current-access lookup after a durable card intent keeps the committed packet and permits an exact safe retry',pg,async()=>fixture(async h=>{
 await h.db.query('UPDATE orders SET telegram_msg_id=NULL WHERE id=$1',[h.order.id]);let intent=false;const privateDiagnostic='Synthetic SQL staff_private relation and internal details';
 h.after((sql,args)=>{if(/^UPDATE orders SET telegram_delivery/.test(sql)&&JSON.parse(args?.[0]||'null')?.card?.state==='sending')intent=true;});
 h.before(sql=>{if(intent&&sql.includes('AS access_order_id'))throw new Error(privateDiagnostic);});
 const req=h.request(109,'lookup-after',{address:'Москва, Сохранённый после intent адрес, 8'}),res=response();await h.handlers().save(req,res);
 assert.equal(intent,true);assert.equal(res.statusCode,200);assert.equal(res.body.ok,true);assert.equal(res.body.id,h.order.id);assert.ok(res.body.warning);assert.doesNotMatch(JSON.stringify(res.body),/staff_private|internal details|Synthetic SQL/);
 const row=await h.q.getOrderById(h.order.id);assert.equal(row.address,req.body.address);assert.equal(row.telegram_delivery.card.state,'failed');assert.equal(h.events.length,0);
 h.before(null);h.after(null);const retry=response();await h.handlers().save(req,retry);assert.equal(retry.body.ok,true);assert.equal(retry.body.id,h.order.id);assert.equal(h.events.filter(event=>event.kind==='card').length,1);assert.equal((await h.q.getOrderById(h.order.id)).telegram_delivery.card.state,'confirmed');assert.equal((await h.counts()).orders,1);
}));
