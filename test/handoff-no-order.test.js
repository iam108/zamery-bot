'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const {createHandoffSubmitter}=require('../src/web/handoff-submit');
const {createPacketService}=require('../src/web/handoff-packet');
const pg={skip:!process.env.PGLITE_TEST_MODULE},LAWYER='808',AUDIT_CHAT='-1004000000001',REQUEST_CHAT='-1004000000002',CLIENTS='-1004000000003';
const gate=()=>{let open;return{promise:new Promise(resolve=>{open=resolve;}),open:()=>open()};};
async function fixture(run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),events=[],queries=[],locks=new Map(),pending=[];let sequence=2000,transport=async()=>{},materials=0,egrn=0;
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);
    INSERT INTO staff VALUES(808,'Synthetic lawyer','lawyer',true),(101,'Synthetic manager','manager',true),(102,'Other manager','manager',true);
    CREATE TABLE orders(id INT PRIMARY KEY,address TEXT,owner_name TEXT,object_name TEXT,object_type TEXT,contacts TEXT,zones_info TEXT,cad_num TEXT,service TEXT,archive_url TEXT,telegram_msg_id BIGINT);
    INSERT INTO orders VALUES(62,'Synthetic source address','Synthetic legal owner','Synthetic brand','Общепит алкоголь','','','','Получение',NULL,900);
    CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,text TEXT,report_data JSONB,draft_id UUID,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE reports(id INT PRIMARY KEY,text TEXT,author TEXT,chat_id BIGINT,msg_ids BIGINT[],reply_to BIGINT,first_id BIGINT,created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE cases(id SERIAL PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,checklist_key TEXT,org TEXT,inn TEXT,client TEXT,phone TEXT,address TEXT,region TEXT,kind TEXT,service TEXT,priority TEXT,comment TEXT,audit_text TEXT,total INT,created_by BIGINT,contacts JSONB,request_id INT,data JSONB DEFAULT '{}',created_at TIMESTAMPTZ DEFAULT NOW());`);
  await db.query('INSERT INTO audits(id,order_id,text,report_data,chat_id,msg_ids) VALUES(15,NULL,$1,$2,$3,$4),(16,62,$5,$2,$3,$6)',
    ['Synthetic complete unlinked audit\nSecond recorded line',JSON.stringify({actor:'Synthetic auditor',workflow:{conclusion_status:'actions'}}),AUDIT_CHAT,[500,501],'Order-bound audit',[600,601]]);
  await db.query('INSERT INTO reports(id,text,author,chat_id,msg_ids,first_id) VALUES(9,$1,$2,$3,$4,800)',
    ['Новая форма заполнена\nНаименование организации: Synthetic request','Synthetic manager',REQUEST_CHAT,[800,801]]);
  await db.query('INSERT INTO reports(id,text,author,chat_id,msg_ids,first_id,reply_to) VALUES(20,$1,$2,$3,$4,1100,NULL),(21,$5,$2,$3,$6,1101,1100)',
    ['Synthetic legacy report','Synthetic auditor',AUDIT_CHAT,[1100],'Nested saved reply',[1101]]);
  const query=(sql,args)=>{queries.push(sql);const job=!args&&sql.split(';').filter(s=>s.trim()).length>1?db.exec(sql).then(results=>results.at(-1)||{rows:[]}):db.query(sql,args);pending.push(job);return job;};
  const pool={query,async connect(){const owner=randomUUID();return{async query(sql,args){
    if(sql.startsWith('SELECT pg_try_advisory_lock')){const namespace=Number(sql.match(/\((\d+),/)[1]),key=namespace+':'+args[0],available=!locks.has(key)||locks.get(key)===owner;if(available)locks.set(key,owner);return{rows:[{locked:available}]};}
    if(sql.startsWith('SELECT pg_advisory_unlock')){const namespace=Number(sql.match(/\((\d+),/)[1]),key=namespace+':'+args[0],owned=locks.get(key)===owner;if(owned)locks.delete(key);return{rows:[{pg_advisory_unlock:owned}]};}
    return query(sql,args);
  },release(error){if(error)for(const[key,value]of locks)if(value===owner)locks.delete(key);}};}};
  const service=createPacketService({pool,listMaterials:async()=>[],listEgrnLinks:async()=>[],workingChatId:AUDIT_CHAT});
  const telegram={async sendMessage(chat,text,options){const event={type:String(chat)===LAWYER?'card':'notice',chat:String(chat),text,options};events.push(event);await transport(event);event.message_id=sequence++;return{message_id:event.message_id,chat:{id:chat}};},
    async callApi(method,payload){assert.equal(method,'copyMessages');const event={type:'copy',chat:String(payload.chat_id),payload};events.push(event);await transport(event);event.receipts=payload.message_ids.map(()=>({message_id:sequence++}));return event.receipts;},
    async sendDocument(){assert.fail('No order means no fabricated material ZIP');}};
  const options={pool,ready:async()=>{},packetService:service,telegram,webappUrl:'https://bot.example',clientsChatId:'',
    loadReport:async(src,id)=>src==='a'?(await pool.query('SELECT * FROM audits WHERE id=$1',[id])).rows[0]:require('../src/web/legacy-report').loadReportAggregate(pool,id,{workingChatId:AUDIT_CHAT}),
    async materialDelivery(){materials++;assert.fail('No order-bound documents exist');},async attachEgrn(){egrn++;assert.fail('No cadastral number or paid order was requested');}};
  const makeBody=async(change={})=>{const body={handoff_version:2,submit_id:randomUUID(),order_id:null,request_id:9,report_src:'a',report_id:15,lawyer_tg_id:808,
    org:'Synthetic legacy client',address:'Москва, Тестовая, 9',region:'МСК',kind:'Общепит',service:'Получение',priority:'обычный',contacts:[{name:'Synthetic contact'}],comment:'Synthetic manager instructions',audit_text:'Untrusted caller text must not replace the saved report',egrn_order:false,...change};
    body.packet_signature=(await service.packet({order_id:body.order_id,report_src:body.report_src,report_id:body.report_id,request_id:body.request_id})).signature;return body;};
  const context=body=>({body,user:{id:101},staff:{name:'Synthetic manager',role:'manager',approved:true}}),create=()=>createHandoffSubmitter(options);
  try{await run({db,pool,service,options,telegram,events,queries,locks,makeBody,context,create,transport(fn){transport=fn;},cases:async()=>(await db.query('SELECT * FROM cases ORDER BY id')).rows,calls:()=>({materials,egrn}),pending});assert.equal(locks.size,0,'Normal release must explicitly unlock both SID and assignment locks');}
  finally{await Promise.allSettled(pending);await db.close();}
}

test('an unlinked report and its request use the actual no-order packet and one durable private handoff across restart',pg,async()=>fixture(async h=>{
  const body=await h.makeBody(),first=await h.create()(h.context(body));assert.equal(first.delivery_complete,true);const rows=await h.cases();assert.equal(rows.length,1);const c=rows[0];assert.equal(c.order_id,null);assert.equal(c.request_id,9);assert.equal(c.audit_text,'Synthetic complete unlinked audit\nSecond recorded line');assert.equal(c.data._handoff.body.packet_signature,body.packet_signature);
  assert.equal(h.events.filter(e=>e.type==='card').length,1);assert.deepEqual(h.events.filter(e=>e.type==='copy').map(e=>[e.payload.from_chat_id,e.payload.message_ids]),[[AUDIT_CHAT,[500,501]],[REQUEST_CHAT,[800,801]]]);assert.ok(h.events.every(e=>e.chat===LAWYER));assert.deepEqual(h.calls(),{materials:0,egrn:0});
  const reportLink=new URL(h.events.find(e=>e.type==='card').options.reply_markup.inline_keyboard.flat().find(button=>button.web_app?.url.includes('view=report')).web_app.url);assert.equal(reportLink.searchParams.get('case_id'),String(c.id));assert.equal(reportLink.searchParams.has('order_id'),false);
  const before=h.events.length;const replay=await h.create()(h.context(body));assert.equal(replay.id,first.id);assert.equal(replay.delivery_complete,true);assert.equal(h.events.length,before);assert.equal((await h.cases()).length,1);
}));
test('an unlinked legacy Telegram report retains its nested reply source and request originals without a fabricated order',pg,async()=>fixture(async h=>{
  const body=await h.makeBody({report_src:'r',report_id:20}),result=await h.create()(h.context(body));assert.equal(result.delivery_complete,true);const row=(await h.cases())[0];assert.equal(row.order_id,null);assert.match(row.audit_text,/Synthetic legacy report[\s\S]*Nested saved reply/);assert.deepEqual(h.events.filter(e=>e.type==='copy').map(e=>[e.payload.from_chat_id,e.payload.message_ids]),[[AUDIT_CHAT,[1100,1101]],[REQUEST_CHAT,[800,801]]]);
  const before=h.events.length;await h.create()(h.context({resume_case_id:row.id}));assert.equal(h.events.length,before);assert.equal((await h.cases()).length,1);assert.deepEqual(h.calls(),{materials:0,egrn:0});
}));
test('an explicitly rejected no-order audit copy resumes only missing copies with the original client and card',pg,async()=>fixture(async h=>{
  let rejected=false;h.transport(event=>{if(event.type==='copy'&&!rejected){rejected=true;throw{response:{error_code:400,description:'Synthetic explicit rejection'}};}});
  const body=await h.makeBody(),first=await h.create()(h.context(body));assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal(h.events.filter(e=>e.type==='card').length,1);
  h.transport(async()=>{});const resumed=await h.create()(h.context({resume_case_id:first.id}));assert.equal(resumed.delivery_complete,true);assert.equal(resumed.id,first.id);assert.equal((await h.cases()).length,1);assert.equal(h.events.filter(e=>e.type==='card').length,1);assert.deepEqual(h.events.filter(e=>e.type==='copy'&&e.receipts).map(e=>e.payload.message_ids),[[500,501],[800,801]]);assert.deepEqual(h.calls(),{materials:0,egrn:0});
}));
test('an unknown no-order card ACK stops automatic delivery after module restart',pg,async()=>fixture(async h=>{
  h.transport(event=>{if(event.type==='card')throw new Error('Telegram accepted but ACK lost');});const body=await h.makeBody(),first=await h.create()(h.context(body));assert.equal(first.delivery_complete,false);assert.equal(first.manual_review,true);assert.equal(first.retry,false);
  const count=h.events.length;h.transport(async()=>{});const replay=await h.create()(h.context({resume_case_id:first.id}));assert.equal(replay.manual_review,true);assert.equal(h.events.length,count);assert.equal((await h.cases()).length,1);assert.ok((await h.cases())[0].data._handoff.inflight);
}));
test('concurrent copies of one no-order submit ID cannot create a second client or send the card twice',pg,async()=>fixture(async h=>{
  const entered=gate(),release=gate();h.transport(async event=>{if(event.type==='card'){entered.open();await release.promise;}});const body=await h.makeBody(),first=h.create()(h.context(body));await entered.promise;
  try{const other=await h.create()(h.context(body));assert.equal(other.delivery_complete,false);assert.equal(h.events.filter(e=>e.type==='card').length,1);assert.equal((await h.cases()).length,1);}finally{release.open();}
  const complete=await first;assert.equal(complete.delivery_complete,true);assert.equal((await h.create()(h.context(body))).id,complete.id);assert.equal(h.events.filter(e=>e.type==='card').length,1);
}));
test('different actors and submit IDs share the request lock before creation and see its existing assignment afterwards',pg,async()=>fixture(async h=>{
  const entered=gate(),release=gate(),actual=h.service;let firstPacket=true;h.options.packetService={async packet(query){if(firstPacket){firstPacket=false;entered.open();await release.promise;}return actual.packet(query);}};
  const body=await h.makeBody(),otherBody={...body,submit_id:randomUUID()},first=h.create()(h.context(body));await entered.promise;
  const other={body:otherBody,user:{id:102},staff:{name:'Other manager',role:'manager',approved:true}};
  try{assert.ok(h.locks.has('112:-9'));await assert.rejects(h.create()(other),error=>error.code==='HANDOFF_BUSY');assert.equal((await h.cases()).length,0);}finally{release.open();}
  const complete=await first;await assert.rejects(h.create()(other),error=>error.code==='HANDOFF_ALREADY_ASSIGNED'&&error.case_id===complete.id);assert.equal((await h.cases()).length,1);assert.equal(h.events.filter(e=>e.type==='card').length,1);
}));
test('a manual no-order handoff without report or contacts does not fabricate an audit or a report button',pg,async()=>fixture(async h=>{
  const body=await h.makeBody({request_id:null,report_src:null,report_id:null,contacts:[],audit_text:'Manual source note'}),result=await h.create()(h.context(body));assert.equal(result.delivery_complete,true);assert.equal((await h.cases())[0].order_id,null);assert.equal((await h.cases())[0].audit_text,'Manual source note');assert.equal(h.events.filter(e=>e.type==='copy').length,0);
  const card=h.events.find(e=>e.type==='card');assert.match(card.text,/Manual source note/);assert.doesNotMatch(card.text,/Полный отчёт и оригиналы/);assert.ok(card.options.reply_markup.inline_keyboard.flat().some(button=>button.web_app?.url.includes('/checklist?case_id=')));assert.equal(card.options.reply_markup.inline_keyboard.flat().some(button=>button.web_app?.url.includes('view=report')),false);assert.deepEqual(h.calls(),{materials:0,egrn:0});
}));
test('a selected order-bound report cannot be downgraded into a no-order handoff even with its valid packet signature',pg,async()=>fixture(async h=>{
  const body=await h.makeBody({report_id:16});await assert.rejects(h.create()(h.context(body)),error=>error.code==='HANDOFF_REPORT_UNAVAILABLE');assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);
}));
test('the no-order selected packet signature and frozen submit body cannot be substituted',pg,async()=>fixture(async h=>{
  const body=await h.makeBody();await assert.rejects(h.create()(h.context({...body,packet_signature:'0'.repeat(64)})),error=>error.code==='HANDOFF_PACKET_CHANGED');assert.equal((await h.cases()).length,0);
  const result=await h.create()(h.context(body)),before=h.events.length;await assert.rejects(h.create()(h.context({...body,report_id:null,report_src:null})),error=>error.code==='HANDOFF_BODY_CHANGED');assert.equal((await h.cases()).length,1);assert.equal(h.events.length,before);assert.equal(result.delivery_complete,true);
}));
test('a completed no-order request may publish exactly one summary but never copies its package to the clients chat',pg,async()=>fixture(async h=>{
  h.options.clientsChatId=CLIENTS;const body=await h.makeBody(),result=await h.create()(h.context(body));assert.equal(result.delivery_complete,true);const notices=h.events.filter(e=>e.type==='notice');assert.equal(notices.length,1);assert.equal(notices[0].chat,CLIENTS);assert.doesNotMatch(notices[0].text,/#null|#undefined/);assert.ok(h.events.filter(e=>e.type==='copy').every(e=>e.chat===LAWYER));assert.equal((await h.cases())[0].data._handoff.groupNotice.status,'confirmed');const before=h.events.length;await h.create()(h.context(body));assert.equal(h.events.length,before);
}));
test('an old unversioned no-order HTTP submission is rejected without creating a client or dispatching Telegram',pg,async()=>fixture(async h=>{
  const filename=require.resolve('../src/web/handoff'),local=createRequire(filename),routes=new Map(),context=vm.createContext({module:{exports:{}},Date,Buffer,URL,URLSearchParams,console:{error(){},log(){}},process:{env:{WEBAPP_URL:'https://bot.example'}},setTimeout(){},setInterval(){},require(name){if(name==='../db/pool')return h.pool;if(name==='../bot/instance')return{telegram:h.telegram};if(name==='./handoff-packet')return{setupHandoffPacket:()=>h.service};return local(name);}});
  vm.runInContext(fs.readFileSync(filename,'utf8'),context);context.module.exports.setupHandoff({get(){},post(path,...handlers){routes.set(path,handlers.at(-1));}});for(let i=0;i<3;i++){await Promise.allSettled(h.pending);await new Promise(resolve=>setImmediate(resolve));}
  const body=await h.makeBody({request_id:null,report_src:null,report_id:null});delete body.handoff_version;delete body.submit_id;delete body.packet_signature;let status=200,result;const before=h.queries.length;
  await routes.get('/api/handoff')({...h.context(body),tgUser:{id:101}},{status(code){status=code;return this;},json(value){result=value;return this;}});
  assert.equal(status,409);assert.equal(result.code,'HANDOFF_FORM_OUTDATED');assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);assert.equal(h.queries.slice(before).some(sql=>/^INSERT INTO cases\b|^UPDATE cases\b/.test(sql)),false);assert.deepEqual(h.calls(),{materials:0,egrn:0});
}));
