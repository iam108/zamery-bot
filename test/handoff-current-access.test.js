'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {createHandoffSubmitter}=require('../src/web/handoff-submit');
const {createPacketService}=require('../src/web/handoff-packet');
const {createHandoffMaterialsDelivery}=require('../src/web/handoff-materials');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:15000},LAWYER='808',SOURCE='-1001111111111',CLIENTS='-1002222222222';
const gate=()=>{let open;return{promise:new Promise(resolve=>{open=resolve;}),open:()=>open()};};
const rejected=()=>Object.assign(new Error('Synthetic explicit Telegram rejection'),{response:{error_code:400,description:'Synthetic explicit Telegram rejection'}});
async function fixture(run,config={}){
 const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),events=[],locks=new Map(),provider=[];let before,after,packetHook=async()=>{},transport=async()=>{},sequence=6000;
 const oldAdmin=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS=config.admin?'103':'';
 try{
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);
   INSERT INTO staff VALUES(101,'Менеджер A','manager',true),(102,'Менеджер B','manager',true),(103,'Администратор','auditor',true),(808,'Юрист A','lawyer',true),(909,'Юрист B','lawyer',true);
   CREATE TABLE orders(id INT PRIMARY KEY,address TEXT,owner_name TEXT,object_name TEXT,object_type TEXT,contacts TEXT,zones_info TEXT,cad_num TEXT,service TEXT,archive_url TEXT,telegram_msg_id BIGINT);
   CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,text TEXT,report_data JSONB,draft_id UUID,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE reports(id INT PRIMARY KEY,text TEXT,author TEXT,chat_id BIGINT,msg_ids BIGINT[],first_id BIGINT,reply_to BIGINT);
   CREATE TABLE cases(id SERIAL PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,checklist_key TEXT,org TEXT,inn TEXT,client TEXT,phone TEXT,address TEXT,region TEXT,kind TEXT,service TEXT,priority TEXT,comment TEXT,audit_text TEXT,total INT,created_by BIGINT,contacts JSONB,request_id INT,data JSONB DEFAULT '{}',created_at TIMESTAMPTZ DEFAULT NOW());`);
  await db.query('INSERT INTO orders VALUES(60,$1,$2,$3,$4,$5,$6,$7,$8,NULL,900)',['Москва, Синтетическая улица, 1','ООО Синтетический клиент','Синтетическое кафе','Общепит алкоголь','Синтетический контакт','',config.cad?'77:01:0000001:1':'','Получение']);
  await db.query('INSERT INTO audits(id,order_id,text,report_data,chat_id,msg_ids) VALUES(15,60,$1,$2,$3,$4)',['Полный сохранённый синтетический отчёт\nПоследняя строка',JSON.stringify({ui_version:5,workflow:{conclusion_status:'actions'}}),SOURCE,Array.from({length:105},(_,i)=>100+i)]);
  const execute=async(sql,args)=>{await before?.(sql,args);const result=args?await db.query(sql,args):(await db.exec(sql)).at(-1);await after?.(sql,args,result);return result;};
  const pool={query:execute,async connect(){const owner=randomUUID();return{async query(sql,args){
   if(sql.startsWith('SELECT pg_try_advisory_lock')){const key=sql.match(/\((\d+),/)[1]+':'+args[0],locked=!locks.has(key)||locks.get(key)===owner;if(locked)locks.set(key,owner);return{rows:[{locked}]};}
   if(sql.startsWith('SELECT pg_advisory_unlock')){const key=sql.match(/\((\d+),/)[1]+':'+args[0],owned=locks.get(key)===owner;if(owned)locks.delete(key);return{rows:[{pg_advisory_unlock:owned}]};}
   return execute(sql,args);
  },release(error){if(error)for(const[key,value]of locks)if(value===owner)locks.delete(key);}};}};
  const buffer=Buffer.from('%PDF-1.7 synthetic exact manager original'),files=[{id:randomUUID(),name:'Synthetic-original.pdf',mime:'application/pdf',role:config.cad?'document':'egrn',buffer,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')}];
  const service=createPacketService({pool,workingChatId:SOURCE,listMaterials:async()=>files.map(({buffer,...file})=>file),listEgrnLinks:async()=>[]});
  const telegram={async sendMessage(chat,text,opts){const event={kind:String(chat)===LAWYER?'card':'notice',chat:String(chat),text,opts};events.push(event);await transport(event);event.id=sequence++;return{message_id:event.id,chat:{id:chat}};},
   async callApi(method,payload){assert.equal(method,'copyMessages');const event={kind:'copy',chat:String(payload.chat_id),payload};events.push(event);await transport(event);event.ids=payload.message_ids.map(()=>sequence++);return event.ids.map(message_id=>({message_id}));},
   async sendDocument(chat,file,opts){const event={kind:'zip',chat:String(chat),name:file.filename,opts};events.push(event);const chunks=[];for await(const chunk of file.source)chunks.push(Buffer.from(chunk));event.buffer=Buffer.concat(chunks);await transport(event);event.id=sequence++;return{message_id:event.id,chat:{id:chat}};}};
  const options={pool,ready:async()=>{},packetService:{async packet(query){const packet=await service.packet(query);await packetHook(packet);return packet;}},telegram,webappUrl:'https://bot.example',clientsChatId:CLIENTS,workingChatId:SOURCE,loadReport:async(src,id)=>{assert.equal(src,'a');return(await pool.query('SELECT * FROM audits WHERE id=$1',[id])).rows[0];},
   materialDelivery:createHandoffMaterialsDelivery({telegram,loadMaterials:async()=>files}),async attachEgrn(input){assert.equal(input.order,config.egrnOrder===true,'Only the explicitly configured synthetic provider intent is allowed');provider.push(input);return{result:config.egrnOrder?'ordered':'none'};}};
  const body={handoff_version:2,submit_id:randomUUID(),order_id:60,report_src:'a',report_id:15,lawyer_tg_id:808,org:'ООО Синтетический клиент',address:'Москва, Синтетическая улица, 1',region:'МСК',kind:'Общепит',service:'Получение',priority:'обычный',contacts:[{name:'Синтетический контакт'}],cad_num:config.cad?'77:01:0000001:1':'',egrn_order:config.egrnOrder===true};
  body.packet_signature=(await service.packet({order_id:60,report_src:'a',report_id:15})).signature;
  const invoke=(payload=body,actor=101,staffRole='manager')=>createHandoffSubmitter(options)({body:payload,user:{id:actor},staff:{role:staffRole,name:'Менеджер из запроса',approved:true}});
  await run({db,pool,options,body,files,events,provider,invoke,cases:async()=>(await db.query('SELECT * FROM cases ORDER BY id')).rows,before(fn){before=fn;},after(fn){after=fn;},packet(fn){packetHook=fn;},transport(fn){transport=fn;}});
  assert.equal(locks.size,0,'Both delivery and assignment locks are explicitly released');assert.ok(events.every(event=>event.chat===LAWYER||event.kind==='notice'&&event.chat===CLIENTS),'Private originals never fall back to a shared chat');
 }finally{if(oldAdmin===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=oldAdmin;await db.close();}
}
const revoke=async(h,change,actor=101)=>h.db.query(change==='revoke'?'UPDATE staff SET approved=false WHERE tg_id=$1':"UPDATE staff SET role='auditor' WHERE tg_id=$1",[actor]);
const restore=async(h,actor=101)=>h.db.query("UPDATE staff SET approved=true,role='manager' WHERE tg_id=$1",[actor]);

for(const change of ['revoke','role'])test('handoff checks the current actor after a suspended reviewed packet: '+change,pg,async()=>fixture(async h=>{
 const entered=gate(),release=gate();h.packet(async()=>{entered.open();await release.promise;});const pending=h.invoke();await entered.promise;await revoke(h,change);release.open();
 await assert.rejects(pending,error=>error.status===403&&error.code==='HANDOFF_FORBIDDEN'&&error.case_created===false);assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);assert.equal(h.provider.length,0);
}));

for(const change of ['revoke','role'])test('the final case INSERT atomically refuses an actor '+change+' even after packet/source checks',pg,async()=>fixture(async h=>{
 let changed=false;h.before(async sql=>{if(!changed&&/^\s*INSERT INTO cases\b/.test(sql)){changed=true;await revoke(h,change);}});
 await assert.rejects(h.invoke(),error=>error.status===403&&error.code==='HANDOFF_FORBIDDEN'&&error.case_created===false);assert.equal(changed,true);assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);
}));

for(const phase of ['card','copy','zip'])for(const change of ['revoke','role'])test('actor '+change+' after durable '+phase+' preparation causes zero physical sends for that phase and one safe resumed package',pg,async()=>fixture(async h=>{
 let changed=false;h.after(async(sql,args)=>{
  if(changed||!sql.startsWith('UPDATE cases SET data=jsonb_set'))return;const state=JSON.parse(args[0]);
  if(phase==='card'&&state.inflight?.type==='card'||phase==='copy'&&state.inflight?.type==='audit'||phase==='zip'&&state.materials?.inflight){changed=true;await revoke(h,change);}
 });
 const first=await h.invoke();assert.equal(changed,true);assert.equal(first.delivery_complete,false);assert.equal(first.case_created,true);assert.equal(first.retry,true);assert.equal(first.manual_review,undefined);assert.equal(h.events.filter(event=>event.kind===phase).length,0);assert.equal((await h.cases()).length,1);
 const state=(await h.cases())[0].data._handoff;assert.ok(!state.inflight);assert.ok(!state.manual_review);if(phase==='zip')assert.equal(state.materials.inflight,false);
 await restore(h);const resumed=await h.invoke({resume_case_id:first.id});assert.equal(resumed.id,first.id);assert.equal(resumed.delivery_complete,true);assert.equal((await h.cases()).length,1);
 assert.equal(h.events.filter(event=>event.kind==='card'&&event.id).length,1);assert.deepEqual(h.events.filter(event=>event.kind==='copy'&&event.ids).map(event=>event.payload.message_ids.length),[100,5]);assert.equal(h.events.filter(event=>event.kind==='zip'&&event.id).length,1);assert.equal(h.events.filter(event=>event.kind==='notice').length,1);
 const count=h.events.length;await h.invoke({resume_case_id:first.id});assert.equal(h.events.length,count);
}));

for(const phase of ['card','copy'])test('actor revocation after an acknowledged '+phase+' keeps that receipt and stops only the next physical send',pg,async()=>fixture(async h=>{
 let changed=false;h.transport(async event=>{if(!changed&&event.kind===phase){changed=true;await revoke(h,'revoke');}});
 const first=await h.invoke();assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal(first.manual_review,undefined);const state=(await h.cases())[0].data._handoff;
 if(phase==='card'){assert.ok(state.cards[LAWYER]>0);assert.equal(h.events.filter(event=>event.kind==='copy').length,0);}else{assert.equal(state.auditCopies[LAWYER].offset,100);assert.equal(state.auditCopies[LAWYER].messageIds.length,100);assert.equal(h.events.filter(event=>event.kind==='copy').length,1);}
 await restore(h);const result=await h.invoke({resume_case_id:first.id});assert.equal(result.delivery_complete,true);assert.equal(h.events.filter(event=>event.kind==='card'&&event.id).length,1);assert.equal(h.events.filter(event=>event.kind==='copy').length,2);assert.equal(h.events.filter(event=>event.kind==='zip'&&event.id).length,1);
}));

test('a confirmed ZIP receipt survives actor revocation while the following EGRN check waits for current authorization',pg,async()=>fixture(async h=>{
 let changed=false;h.transport(async event=>{if(!changed&&event.kind==='zip'){changed=true;await revoke(h,'revoke');}});
 const first=await h.invoke();assert.equal(first.delivery_complete,false);assert.equal(first.manual_review,undefined);assert.equal(first.retry,true);assert.equal(h.provider.length,0);const row=(await h.cases())[0];assert.equal(row.data._handoff.materials.confirmed[LAWYER].length,1);assert.equal(row.data._handoff.materials.inflight,false);
 await restore(h);assert.equal((await h.invoke({resume_case_id:first.id})).delivery_complete,true);assert.equal(h.events.filter(event=>event.kind==='zip').length,1);assert.equal(h.provider.length,1);assert.equal((await h.cases()).length,1);
},{cad:true}));

test('another current manager resumes the original frozen case even after its creator loses approval',pg,async()=>fixture(async h=>{
 let failed=false;h.transport(event=>{if(!failed&&event.kind==='card'){failed=true;throw rejected();}});const first=await h.invoke();assert.equal(first.delivery_complete,false);await revoke(h,'revoke',101);
 const result=await h.invoke({resume_case_id:first.id},102);assert.equal(result.delivery_complete,true);const row=(await h.cases())[0];assert.equal(Number(row.created_by),101);assert.equal(row.id,first.id);assert.equal(h.events.filter(event=>event.kind==='card'&&event.id).length,1);assert.equal((await h.cases()).length,1);
}));

test('a configured approved administrator may hand off a case without receiving a manager role',pg,async()=>fixture(async h=>{
 const result=await h.invoke(h.body,103,'auditor');assert.equal(result.delivery_complete,true);assert.equal(Number((await h.cases())[0].created_by),103);assert.equal((await h.db.query('SELECT role FROM staff WHERE tg_id=103')).rows[0].role,'auditor');
},{admin:true}));

test('configured administrator membership does not waive current staff approval at creation',pg,async()=>fixture(async h=>{
 h.packet(()=>h.db.query('UPDATE staff SET approved=false WHERE tg_id=103'));await assert.rejects(h.invoke(h.body,103,'auditor'),error=>error.status===403&&error.code==='HANDOFF_FORBIDDEN'&&error.case_created===false);assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);
},{admin:true}));

for(const change of ['approval','role'])test('current recipient '+change+' still blocks a manager resume until the same assigned lawyer is active again',pg,async()=>fixture(async h=>{
 let failed=false;h.transport(event=>{if(!failed&&event.kind==='card'){failed=true;throw rejected();}});const first=await h.invoke();await h.db.query(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=808':"UPDATE staff SET role='auditor' WHERE tg_id=808");const count=h.events.length;
 const blocked=await h.invoke({resume_case_id:first.id});assert.equal(blocked.delivery_complete,false);assert.equal(h.events.length,count);await h.db.query("UPDATE staff SET approved=true,role='lawyer' WHERE tg_id=808");assert.equal((await h.invoke({resume_case_id:first.id})).delivery_complete,true);assert.equal((await h.cases()).length,1);
}));

test('a reassigned case at the durable card intent cannot send the frozen package to its former or newly selected owner',pg,async()=>fixture(async h=>{
 let changed=false;h.after(async(sql,args)=>{if(!changed&&sql.startsWith('UPDATE cases SET data=jsonb_set')&&JSON.parse(args[0]).inflight?.type==='card'){changed=true;await h.db.query("UPDATE cases SET lawyer_tg_id=909,lawyer_name='Юрист B' WHERE id=1");}});
 const result=await h.invoke();assert.equal(result.delivery_complete,false);assert.equal(result.retry,true);assert.equal(h.events.length,0);assert.equal((await h.cases()).length,1);
}));

test('a physical network-unknown card ACK stays manual after module restart instead of being reclassified as a safe access retry',pg,async()=>fixture(async h=>{
 h.transport(event=>{if(event.kind==='card')throw new Error('Synthetic accepted private card with lost ACK');});const first=await h.invoke();assert.equal(first.delivery_complete,false);assert.equal(first.manual_review,true);assert.equal(first.retry,false);const count=h.events.length;
 h.transport(async()=>{});await revoke(h,'revoke');const retry=await h.invoke({resume_case_id:first.id});assert.equal(retry.manual_review,true);assert.equal(retry.retry,false);assert.equal(h.events.length,count);assert.ok((await h.cases())[0].data._handoff.inflight);assert.equal((await h.cases()).length,1);
 await restore(h);const active=await h.invoke({resume_case_id:first.id});assert.equal(active.manual_review,true);assert.equal(active.retry,false);assert.equal(h.events.length,count);
}));

test('a physical ZIP ACK with failed receipt storage remains manual despite actor revocation and later restoration',pg,async()=>fixture(async h=>{
 let received=false,failed=false;h.transport(async event=>{if(event.kind==='zip'){received=true;await revoke(h,'revoke');}});
 h.before((sql,args)=>{if(received&&!failed&&sql.startsWith('UPDATE cases SET data=jsonb_set')&&JSON.parse(args[0]).materials?.confirmed?.[LAWYER]?.length){failed=true;throw new Error('Synthetic ZIP receipt did not commit');}});
 const first=await h.invoke();assert.equal(received,true);assert.equal(failed,true);assert.equal(first.delivery_complete,false);assert.equal(first.manual_review,true);assert.equal(first.retry,false);assert.equal(h.events.filter(event=>event.kind==='zip').length,1);assert.equal(h.events.filter(event=>event.kind==='notice').length,0);
 const count=h.events.length;await restore(h);const result=await h.invoke({resume_case_id:first.id});assert.equal(result.manual_review,true);assert.equal(result.retry,false);assert.equal(h.events.length,count);assert.equal((await h.cases()).length,1);
}));

test('actor loss after the EGRN order intent resets only the known unsent flag and explicit recovery invokes the synthetic provider once',pg,async()=>fixture(async h=>{
 let changed=false;h.after(async(sql,args)=>{if(!changed&&sql.startsWith('UPDATE cases SET data=jsonb_set')&&JSON.parse(args[0]).egrn?.order_started){changed=true;await revoke(h,'revoke');}});
 const first=await h.invoke();assert.equal(changed,true);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal(first.manual_review,undefined);assert.equal(h.provider.length,0);const row=(await h.cases())[0];assert.equal(row.data._handoff.egrn.order_started,false);assert.equal(row.data._handoff.materials.inflight,false);
 await restore(h);const result=await h.invoke({resume_case_id:first.id});assert.equal(result.delivery_complete,true);assert.equal(result.id,first.id);assert.equal(h.provider.length,1);assert.equal(h.provider[0].order,true);assert.equal(h.events.filter(event=>event.kind==='zip').length,1);assert.equal((await h.cases()).length,1);
},{cad:true,egrnOrder:true}));

test('an uncertain EGRN result remains durably manual when the actor loses access before its outcome checkpoint',pg,async()=>fixture(async h=>{
 let calls=0;h.options.attachEgrn=async input=>{calls++;assert.equal(input.order,false,'Only a synthetic existing-original check');await revoke(h,'revoke');throw Object.assign(new Error('Synthetic EGRN outcome without ACK'),{uncertain:true});};
 const first=await h.invoke();assert.equal(calls,1);assert.equal(first.delivery_complete,false);assert.equal(first.manual_review,true);assert.equal(first.retry,false);
 const row=(await h.cases())[0];assert.equal(typeof row.data._handoff.manual_review,'string');assert.ok(row.data._handoff.manual_review.length>0);assert.equal(row.data._handoff.completed,false);assert.equal(h.events.filter(event=>event.kind==='notice').length,0);
 const count=h.events.length;await restore(h);const result=await h.invoke({resume_case_id:first.id});assert.equal(result.manual_review,true);assert.equal(result.retry,false);assert.equal(result.delivery_complete,false);assert.equal(calls,1);assert.equal(h.events.length,count);assert.equal((await h.cases()).length,1);
},{cad:true}));

test('a confirmed EGRN order outcome is retained after actor loss while global completion waits for an authorized resume',pg,async()=>fixture(async h=>{
 let calls=0;h.options.attachEgrn=async input=>{calls++;assert.equal(input.order,true,'Only the explicitly requested synthetic order intent');await revoke(h,'revoke');return{result:'ordered'};};
 const first=await h.invoke();assert.equal(first.delivery_complete,false);assert.equal(first.case_created,true);assert.equal(first.retry,true);assert.equal(first.manual_review,undefined);assert.equal(calls,1);
 const row=(await h.cases())[0],state=row.data._handoff;assert.equal(state.egrn.result,'ordered');assert.equal(state.egrn.completed,true);assert.equal(state.egrn.order_started,true);assert.match(state.egrn.note,/заказана/i);assert.equal(state.completed,false);assert.ok(!state.manual_review);
 const count=h.events.length;await restore(h);const result=await h.invoke({resume_case_id:first.id});assert.equal(result.delivery_complete,true);assert.equal(result.id,first.id);assert.equal(calls,1);assert.equal((await h.cases()).length,1);
 assert.ok(h.events.slice(count).every(event=>event.kind==='notice'&&event.chat===CLIENTS),'Known private package and provider outcome are not repeated');assert.equal(h.events.filter(event=>event.kind==='notice').length,1);
},{cad:true,egrnOrder:true}));
