const { test }=require('node:test');
const assert=require('node:assert/strict');
const { randomUUID,createHash }=require('node:crypto');
const { createHandoffSubmitter }=require('../src/web/handoff-submit');
const { createHandoffMaterialsDelivery }=require('../src/web/handoff-materials');
const pg={skip:!process.env.PGLITE_TEST_MODULE},CLIENTS='-1002222222222',LAWYER=808,SOURCE='-1001111111111';
const sha=b=>createHash('sha256').update(b).digest('hex');
const tgFailure=message=>Object.assign(new Error(message),{response:{error_code:400,description:'Synthetic explicit Telegram rejection'}});
async function fixture(run,config={}){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),events=[],locks=new Map();let sequence=6000,packetCalls=0,reportCalls=0,egCalls=[],mutate=()=>{},fail=null;
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);
    CREATE TABLE orders(id INT PRIMARY KEY,object_name TEXT,telegram_msg_id BIGINT);
    CREATE TABLE reports(id INT PRIMARY KEY,chat_id BIGINT,msg_ids BIGINT[],first_id BIGINT);
    CREATE TABLE cases(id SERIAL PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,checklist_key TEXT,org TEXT,inn TEXT,client TEXT,phone TEXT,address TEXT,region TEXT,kind TEXT,service TEXT,priority TEXT,comment TEXT,audit_text TEXT,total INT,created_by BIGINT,contacts JSONB,request_id INT,data JSONB DEFAULT '{}');
    INSERT INTO orders VALUES(60,'Синтетический бренд',NULL);
    INSERT INTO staff VALUES(808,'Юрист проверки','lawyer',true),(101,'Менеджер','manager',true);`);
  const pool={query:(query,params)=>params?db.query(query,params):db.exec(query),async connect(){const identity=randomUUID();return {async query(query,params){
    if(query.startsWith('SELECT pg_try_advisory_lock')){const key=params[0],available=!locks.has(key)||locks.get(key)===identity;if(available)locks.set(key,identity);return {rows:[{locked:available}]};}
    if(query.startsWith('SELECT pg_advisory_unlock')){if(locks.get(params[0])===identity)locks.delete(params[0]);return {rows:[{pg_advisory_unlock:true}]};}
    return db.query(query,params);
  },release(){for(const [key,owner]of locks)if(owner===identity)locks.delete(key);}};}};
  const files=[{id:randomUUID(),name:'Документ уже в отчёте.pdf',mime:'application/pdf',role:'document',buffer:Buffer.from('%PDF-1.7 audit original')},
    {id:randomUUID(),name:'Свежая выписка ЕГРН.pdf',mime:'application/pdf',role:config.withEgrn===false?'document':'egrn',buffer:Buffer.from('%PDF-1.7 fresh manager original')}].map(file=>({...file,bytes:file.buffer.length,sha256:sha(file.buffer)}));
  const materials=files.map(({buffer,...file})=>({...file,url:'/api/audit/orders/60/materials/'+file.id}));
  const packet={ok:true,signature:'a'.repeat(64),order:{id:60,org:'ООО «ЧООКДИ»',address:'Москва, Лесная, 5',cad_num:'77:01:0004016:1064'},
    report:{id:15,src:'a',text:'ПОЛНЫЙ ТЕКСТ АУДИТОРА\nКонтакт передала Ирина\n'+'Ответы и наблюдения.\n'.repeat(300),actor:'Саша Я.',status:'actions',video_url:'https://disk.yandex.ru/i/video',media:[]},materials,archive_url:'https://disk.yandex.ru/d/actual-object-archive'};
  const body={handoff_version:2,submit_id:randomUUID(),packet_signature:packet.signature,order_id:60,report_src:'a',report_id:15,lawyer_tg_id:LAWYER,
    org:'ООО «ЧООКДИ»',inn:'7701234567',address:'Москва, Лесная, 5',region:'МСК',kind:'Общепит',service:'Продление',priority:'срочно',cad_num:'77:01:0004016:1064',contacts:[{name:'Карина',phone:'+79991234567',comment:'Позвонить перед выездом'}],comment:'Сначала согласовать время',egrn_order:false};
  const pick={chat_id:SOURCE,msg_ids:Array.from({length:105},(_,i)=>100+i),text:packet.report.text,report_data:{evidence:[{sha256:files[0].sha256}]}};
  async function action(event){events.push(event);if(fail)await fail(event);await mutate(event);}
  const telegram={async sendMessage(chat,text,opts){const event={type:String(chat)===String(LAWYER)?'card':'notice',chat:String(chat),text,opts,noticeTarget:options.clientsChatId};await action(event);event.id=sequence++;return {message_id:event.id};},
    async callApi(method,payload){assert.equal(method,'copyMessages');const event={type:'copy',chat:String(payload.chat_id),payload};await action(event);const ids=payload.message_ids.map(()=>({message_id:sequence++}));return config.shortCopy&&event.chat===String(LAWYER)?ids.slice(1):ids;},
    async sendDocument(chat,file,opts){const event={type:'zip',chat:String(chat),name:file.filename,opts};await action(event);const chunks=[];for await(const chunk of file.source)chunks.push(Buffer.from(chunk));event.buffer=Buffer.concat(chunks);event.id=sequence++;return {message_id:event.id};}};
  const options={pool,ready:async()=>{},packetService:{async packet(query){packetCalls++;assert.deepEqual(query,{order_id:60,report_src:'a',report_id:15,request_id:body.request_id||null});return JSON.parse(JSON.stringify({...packet,request:config.requestMismatch?{id:999}:body.request_id?{id:body.request_id}:null}));}},telegram,
    async loadReport(src,id){reportCalls++;assert.equal(src,'a');assert.equal(id,15);return structuredClone(pick);},materialDelivery:createHandoffMaterialsDelivery({telegram,loadMaterials:async()=>files}),
    async attachEgrn(opts){egCalls.push(opts);return config.egrn?config.egrn(opts,egCalls.length):{result:'none'};},pickChecklist:()=> 'MSK_OBSH',webappUrl:'https://bot.example',clientsChatId:CLIENTS};
  const context={body,user:{id:101},staff:{name:'Менеджер',role:'manager',approved:true}};
  try{await run({db,pool,events,packet,body,files,pick,context,options,submit:createHandoffSubmitter(options),restart:()=>createHandoffSubmitter(options),packetCalls:()=>packetCalls,reportCalls:()=>reportCalls,egCalls,
    setFail(fn){fail=fn;},setMutation(fn){mutate=fn;},async cases(){return(await db.query('SELECT * FROM cases ORDER BY id')).rows;}});
    assert.ok(events.every(event=>event.chat===String(LAWYER)||event.type==='notice'&&event.chat===String(event.noticeTarget)),'Only the short summary may go to the configured clients chat; package copies remain private');
  }finally{await db.close();}
}
test('V2 delivers the complete packet only to the assigned lawyer even when a shared chat is configured, and preserves completed idempotency',pg,async()=>fixture(async h=>{
  const result=await h.submit(h.context);assert.equal(result.delivery_complete,true);assert.equal(result.ok,true);
  const cases=await h.cases();assert.equal(cases.length,1);const c=cases[0],state=c.data._handoff;
  assert.equal(c.client,'Карина');assert.equal(c.priority,'🔥 горящий');assert.equal(c.audit_text,h.packet.report.text);assert.equal(c.address,'Москва, Лесная, 5');
  assert.deepEqual(h.events.slice(0,2).map(event=>event.type),['card','copy']);
  assert.ok(h.events.every(event=>event.chat===String(LAWYER)||event.type==='notice'));
  assert.deepEqual(state.recipients,[{chat:String(LAWYER),role:'lawyer'}]);
  const cards=h.events.filter(event=>event.type==='card');assert.equal(cards.length,1);
  const notices=h.events.filter(event=>event.type==='notice');assert.equal(notices.length,1);assert.equal(notices[0].chat,CLIENTS);assert.match(notices[0].text,/^Клиент передан юристу/);assert.match(notices[0].text,/В работе у юриста: 1 клиентов/);assert.doesNotMatch(notices[0].text,/Карина|7999|ПОЛНЫЙ ТЕКСТ|баланс/i);assert.ok(notices[0].opts.reply_markup.inline_keyboard.flat().every(button=>!button.web_app&&button.url==='https://t.me/LRSZamer_bot?start=case_'+c.id));
  assert.equal(state.groupNotice.status,'confirmed');assert.equal(state.groupNotice.receipt.message_id,notices[0].id);
  for(const card of cards){assert.ok(card.text.length<2000);assert.doesNotMatch(card.text,/ПОЛНЫЙ ТЕКСТ АУДИТОРА|Контакт передала Ирина|Ответы и наблюдения/);assert.match(card.text,/Карина|Лесная/);}
  const lawyerButtons=cards[0].opts.reply_markup.inline_keyboard.flat();assert.ok(lawyerButtons.some(button=>button.web_app?.url.includes('/checklist?case_id='+c.id)));assert.ok(lawyerButtons.some(button=>button.web_app?.url.includes('view=report')));assert.ok(lawyerButtons.some(button=>button.url===h.packet.report.video_url));
  assert.deepEqual(cards[0].opts.reply_markup.inline_keyboard[0].map(button=>button.text),['📋 Чек-лист клиента','Перейти к отчёту']);
  const reportLink=new URL(cards[0].opts.reply_markup.inline_keyboard[0][1].web_app.url);
  assert.equal(reportLink.searchParams.get('report_id'),'15');assert.equal(reportLink.searchParams.get('report_src'),'a');
  assert.equal(reportLink.searchParams.get('order_id'),'60');assert.equal(reportLink.searchParams.has('k'),false);assert.equal(reportLink.searchParams.has('u'),false);
  for(const target of [String(LAWYER)]){
    const copies=h.events.filter(event=>event.type==='copy'&&event.chat===target);assert.deepEqual(copies.map(event=>event.payload.message_ids.length),[100,5]);assert.ok(copies.flatMap(event=>event.payload.message_ids).includes(204));
    const zip=h.events.filter(event=>event.type==='zip'&&event.chat===target);assert.equal(zip.length,1);assert.ok(zip[0].buffer.includes(h.files[1].buffer));assert.ok(!zip[0].buffer.includes(h.files[0].buffer));assert.equal(zip[0].opts.reply_to_message_id,state.cards[target]);
    assert.equal(state.auditCopies[target].offset,105);assert.equal(state.auditCopies[target].messageIds.length,105);assert.equal(state.materials.confirmed[target].length,1);
  }
  assert.equal(h.egCalls.length,0);assert.equal(h.packetCalls(),1);assert.equal(h.reportCalls(),1);
  const before=h.events.length;h.packet.signature='b'.repeat(64);
  const replay=await h.restart()(h.context);assert.deepEqual(replay,result);assert.equal(h.events.length,before);assert.equal(h.packetCalls(),1);assert.equal((await h.cases()).length,1);
}));

test('handoff recipient revocation after a partial attempt stops delivery and reactivation resumes the same case',pg,async()=>fixture(async h=>{
  let first=true;h.setFail(event=>{if(first&&event.type==='card'){first=false;throw tgFailure('Synthetic temporary card rejection');}});
  const initial=await h.submit(h.context);assert.equal(initial.delivery_complete,false);assert.equal(h.events.filter(event=>event.type==='notice').length,0);await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');
  const count=h.events.length,blocked=await h.restart()(h.context);assert.equal(blocked.delivery_complete,false);assert.equal(blocked.retry,true);assert.equal(blocked.manual_review,undefined);assert.equal(h.events.length,count);assert.match(blocked.warn,/получател|юрист|доступ/i);
  await h.db.query('UPDATE staff SET approved=true WHERE tg_id=808');const resumed=await h.restart()(h.context);assert.equal(resumed.delivery_complete,true);assert.equal(resumed.id,initial.id);assert.equal((await h.cases()).length,1);
}));

test('handoff recipient gate runs after its durable send intent so a revoked lawyer receives no Telegram call',pg,async()=>fixture(async h=>{
  const query=h.db.query.bind(h.db);let revoked=false;
  h.db.query=async(sql,params)=>{const result=await query(sql,params);if(!revoked&&sql.startsWith('UPDATE cases SET data=jsonb_set')&&JSON.parse(params[0]).inflight?.type==='card'){revoked=true;await query('UPDATE staff SET approved=false WHERE tg_id=808');}return result;};
  const result=await h.submit(h.context);assert.equal(result.delivery_complete,false);assert.equal(result.retry,true);assert.equal(h.events.length,0);
  const state=(await h.cases())[0].data._handoff;assert.equal(state.inflight,null);assert.equal(state.manual_review,undefined);
  await query('UPDATE staff SET approved=true WHERE tg_id=808');assert.equal((await h.restart()(h.context)).delivery_complete,true);
}));

test('handoff recipient revocation during an acknowledged audit batch preserves its receipt and stops the next batch',pg,async()=>fixture(async h=>{
  let revoked=false;h.setMutation(async event=>{if(event.type==='copy'&&!revoked){revoked=true;await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');}});
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal(h.events.filter(event=>event.type==='copy').length,1);assert.equal(h.events.filter(event=>event.type==='zip').length,0);
  assert.equal((await h.cases())[0].data._handoff.auditCopies[String(LAWYER)].offset,100);
  await h.db.query('UPDATE staff SET approved=true WHERE tg_id=808');const count=h.events.length;assert.equal((await h.restart()(h.context)).delivery_complete,true);
  assert.deepEqual(h.events.slice(count).filter(event=>event.type==='copy').map(event=>event.payload.message_ids),[[200,201,202,203,204]]);assert.equal(h.events.filter(event=>event.type==='card').length,1);
}));

test('handoff recipient lookup failure stays retryable and a changed staff role cannot receive the saved package',pg,async()=>fixture(async h=>{
  const query=h.db.query.bind(h.db);let unavailable=true;
  h.db.query=async(sql,params)=>{if(unavailable&&sql.startsWith('SELECT c.lawyer_tg_id'))throw new Error('Synthetic staff lookup failure');return query(sql,params);};
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal(h.events.length,0);
  unavailable=false;await query("UPDATE staff SET role='auditor' WHERE tg_id=808");assert.equal((await h.restart()(h.context)).delivery_complete,false);assert.equal(h.events.length,0);
  await query("UPDATE staff SET role='lawyer' WHERE tg_id=808");assert.equal((await h.restart()(h.context)).delivery_complete,true);assert.equal((await h.cases()).length,1);
}));

test('handoff recipient gate observes reassignment after the earlier case read and does not send its former owner',pg,async()=>fixture(async h=>{
  const query=h.db.query.bind(h.db);let reassigned=false;
  h.db.query=async(sql,params)=>{if(!reassigned&&sql.startsWith('SELECT c.lawyer_tg_id')){reassigned=true;await query("INSERT INTO staff VALUES(909,'Другой юрист','lawyer',true)");await query("UPDATE cases SET lawyer_tg_id=909,lawyer_name='Другой юрист' WHERE id=1");}return query(sql,params);};
  const result=await h.submit(h.context);assert.equal(result.delivery_complete,false);assert.equal(result.retry,true);assert.equal(h.events.length,0);
}));

test('handoff recipient revocation between ZIP parts preserves confirmed originals and retries only the missing part',pg,async()=>fixture(async h=>{
  const third={id:randomUUID(),name:'Third.pdf',mime:'application/pdf',role:'document',buffer:Buffer.alloc(300,65)};third.bytes=third.buffer.length;third.sha256=sha(third.buffer);h.files.push(third);const {buffer,...metadata}=third;h.packet.materials.push(metadata);
  h.options.materialDelivery=createHandoffMaterialsDelivery({telegram:h.options.telegram,loadMaterials:async()=>h.files,maxPartBytes:512});
  let revoked=false;h.setMutation(async event=>{if(event.type==='zip'&&!revoked){revoked=true;await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');}});
  const first=await h.restart()(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal(first.manual_review,undefined);assert.equal(h.events.filter(event=>event.type==='zip').length,1);
  assert.equal((await h.cases())[0].data._handoff.materials.confirmed[String(LAWYER)].length,1);
  await h.db.query('UPDATE staff SET approved=true WHERE tg_id=808');const count=h.events.length;assert.equal((await h.restart()(h.context)).delivery_complete,true);assert.deepEqual(h.events.slice(count).map(event=>event.type),['zip','notice']);
}));
test('failed lawyer card resumes frozen case, never reuses changed packet or creates a second client, and keeps checklist data',pg,async()=>fixture(async h=>{
  let failed=false;h.setFail(event=>{if(event.type==='card'&&event.chat===String(LAWYER)&&!failed){failed=true;throw tgFailure('temporary Telegram failure');}});
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal((await h.cases()).length,1);
  await h.db.query("UPDATE cases SET data=data || '{\"lawyer-check\":{\"s\":\"yes\"}}'::jsonb WHERE id=$1",[first.id]);
  h.packet.order.address='Changed after initial handoff';h.packet.signature='c'.repeat(64);h.pick.msg_ids=[999];
  const retry=await h.restart()(h.context);assert.equal(retry.id,first.id);assert.equal(retry.delivery_complete,true);assert.equal(h.packetCalls(),1);assert.equal(h.reportCalls(),1);
  const cards=h.events.filter(event=>event.type==='card'&&event.id);assert.equal(cards.filter(event=>event.chat===CLIENTS).length,0);assert.equal(cards.filter(event=>event.chat===String(LAWYER)).length,1);
  const current=(await h.cases())[0];assert.deepEqual(current.data['lawyer-check'],{s:'yes'});assert.equal(current.address,'Москва, Лесная, 5');assert.equal(current.data._handoff.source.message_ids.length,105);
}));
test('partial manager ZIP failure resumes only the lawyer delivery using durable receipts',pg,async()=>fixture(async h=>{
  let failed=false;h.setFail(event=>{if(event.type==='zip'&&event.chat===String(LAWYER)&&!failed){failed=true;throw tgFailure('document Telegram failure');}});
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);
  const partial=(await h.cases())[0].data._handoff;assert.equal(partial.materials.confirmed[CLIENTS],undefined);assert.equal(partial.materials.confirmed[String(LAWYER)],undefined);
  const result=await h.restart()(h.context);assert.equal(result.delivery_complete,true);assert.equal((await h.cases()).length,1);
  assert.equal(h.events.filter(event=>event.type==='card').length,1);assert.equal(h.events.filter(event=>event.type==='copy').length,2);
  assert.equal(h.events.filter(event=>event.type==='zip'&&event.chat===CLIENTS&&event.id).length,0);assert.equal(h.events.filter(event=>event.type==='zip'&&event.chat===String(LAWYER)&&event.id).length,1);
}));
test('retry of a pre-update checkpoint drops shared-chat recipients and keeps the lawyer receipts and frozen packet',pg,async()=>fixture(async h=>{
  let failed=false;h.setFail(event=>{if(event.type==='zip'&&!failed){failed=true;throw tgFailure('Temporary private document rejection');}});
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);
  const c=(await h.cases())[0],state=c.data._handoff;
  state.recipients=[{chat:CLIENTS,role:'clients'},{chat:SOURCE,role:'clients'},{chat:String(LAWYER),role:'lawyer'}];
  state.cards[CLIENTS]=400;state.auditCopies[CLIENTS]={offset:105,messageIds:[401]};state.materials.confirmed[CLIENTS]=[402];
  const packetHash=state.materials.packetHash;
  await h.db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=$2",[JSON.stringify(state),c.id]);
  h.options.clientsChatId=SOURCE;h.packet.signature='b'.repeat(64);h.pick.msg_ids=[999];
  const before=h.events.length,result=await h.restart()(h.context);
  assert.equal(result.delivery_complete,true);assert.equal(result.id,first.id);assert.equal((await h.cases()).length,1);
  const newEvents=h.events.slice(before);assert.deepEqual(newEvents.map(event=>[event.type,event.chat]),[['zip',String(LAWYER)]]);
  const saved=(await h.cases())[0].data._handoff;
  assert.deepEqual(saved.recipients,[{chat:String(LAWYER),role:'lawyer'}]);assert.equal(saved.materials.packetHash,packetHash);
  assert.equal(saved.cards[String(LAWYER)],state.cards[String(LAWYER)]);assert.equal(saved.auditCopies[String(LAWYER)].offset,105);
  assert.equal(h.packetCalls(),1);assert.equal(h.reportCalls(),1);assert.equal(h.egCalls.length,0);
}));
test('an older checkpoint with a failed first private card cannot restore copies to the original measurements chat',pg,async()=>fixture(async h=>{
  let failed=false;h.setFail(event=>{if(event.type==='card'&&!failed){failed=true;throw tgFailure('Private card was rejected');}});
  const first=await h.submit(h.context),c=(await h.cases())[0],state=c.data._handoff;
  state.recipients=[{chat:SOURCE,role:'lawyer'},{chat:CLIENTS,role:'clients'}];
  await h.db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=$2",[JSON.stringify(state),c.id]);
  const result=await h.restart()(h.context);assert.equal(result.delivery_complete,true);assert.equal(result.id,first.id);
  assert.ok(h.events.every(event=>event.chat===String(LAWYER)||event.type==='notice'&&event.chat===CLIENTS));assert.equal(h.events.filter(event=>event.type==='copy').length,2);
  assert.equal(h.egCalls.length,1);assert.equal(h.egCalls[0].order,false);assert.deepEqual(h.egCalls[0].targets,[{chat:LAWYER,reply:(await h.cases())[0].data._handoff.cards[String(LAWYER)],case_id:Number((await h.cases())[0].id)}]);
},{withEgrn:false}));
test('a historical group-only remainder does not repeat completed private files or EGRN when retried',pg,async()=>fixture(async h=>{
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,true);assert.equal(h.egCalls.length,1);
  const c=(await h.cases())[0],state=c.data._handoff;
  state.recipients=[{chat:CLIENTS,role:'clients'},{chat:String(LAWYER),role:'lawyer'}];
  state.completed=false;state.materials.completed=false;state.egrn.order_started=true;
  await h.db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=$2",[JSON.stringify(state),c.id]);
  const before=h.events.length,result=await h.restart()(h.context);
  assert.equal(result.delivery_complete,true);assert.equal(result.id,first.id);assert.equal(h.events.length,before);assert.equal(h.egCalls.length,1);
  const saved=(await h.cases())[0].data._handoff;assert.equal(saved.egrn.order_started,true);assert.equal(saved.materials.completed,true);assert.equal(saved.completed,true);
  state.completed=true;await h.db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=$2",[JSON.stringify(state),c.id]);
  await h.restart()(h.context);assert.equal(h.events.length,before);assert.equal(h.egCalls.length,1);
},{withEgrn:false,egrn:async()=>({result:'attached'})}));
test('changed payload cannot resume an existing case and stale packet is rejected explicitly before case creation',pg,async()=>fixture(async h=>{
  const stale={...h.body,packet_signature:'0'.repeat(64)};
  await assert.rejects(h.submit({...h.context,body:stale}),error=>error.code==='HANDOFF_PACKET_CHANGED'&&error.case_created===false&&error.status===409);assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);
  h.setFail(event=>{if(event.type==='card')throw tgFailure('temporary');});const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);
  await assert.rejects(h.restart()({...h.context,body:{...h.body,comment:'Changed after submit'}}),error=>error.code==='HANDOFF_BODY_CHANGED'&&error.case_created===true&&error.case_id===first.id);
  assert.equal((await h.cases()).length,1);assert.equal(h.events.length,1);
}));
test('short copyMessages acknowledgment is saved for manual review and never blindly resent or marked complete',pg,async()=>fixture(async h=>{
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,false);assert.equal(first.manual_review,true);
  const c=(await h.cases())[0];assert.equal(c.data._handoff.auditCopies[String(LAWYER)].partial.messageIds.length,99);assert.equal(c.data._handoff.auditCopies[String(LAWYER)].offset,0);
  const count=h.events.length;const again=await h.restart()(h.context);assert.equal(again.delivery_complete,false);assert.equal(again.manual_review,true);assert.equal(h.events.length,count);assert.equal(h.events.filter(event=>event.type==='zip').length,0);
},{shortCopy:true}));
test('without explicit EGRN order consent lookup uses order:false and absence is honestly reported without blocking a delivered packet',pg,async()=>fixture(async h=>{
  const result=await h.submit(h.context);assert.equal(result.delivery_complete,true);assert.match(result.warn,/не включена/);assert.equal(h.egCalls.length,1);assert.equal(h.egCalls[0].order,false);
  assert.equal(h.egCalls[0].cad,h.body.cad_num);assert.equal(h.egCalls[0].targets.length,1);assert.equal(h.egCalls[0].targets[0].chat,LAWYER);assert.ok(h.egCalls[0].targets[0].reply>0);
},{withEgrn:false}));
test('unknown paid-order outcome is checkpointed before request; retry only checks existing order and does not charge again',pg,async()=>fixture(async h=>{
  h.body.egrn_order=true;
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);
  assert.equal((await h.cases())[0].data._handoff.egrn.order_started,true);
  const result=await h.restart()(h.context);assert.equal(result.delivery_complete,true);assert.deepEqual(h.egCalls.map(call=>call.order),[true,false]);assert.equal((await h.cases()).length,1);
  assert.equal(h.events.filter(event=>event.type==='card').length,1);assert.equal(h.events.filter(event=>event.type==='zip').length,1);
},{withEgrn:false,egrn:async(opts,count)=>{if(count===1)throw new Error('Unknown API outcome');return {result:'waiting'};}}));
test('an unconfirmed paid order becomes manual review rather than repeat payment or false completion',pg,async()=>fixture(async h=>{
  h.body.egrn_order=true;await h.submit(h.context);
  const result=await h.restart()(h.context);assert.equal(result.delivery_complete,false);assert.equal(result.retry,false);assert.equal(result.manual_review,true);assert.deepEqual(h.egCalls.map(call=>call.order),[true,false]);
},{withEgrn:false,egrn:async(opts,count)=>{if(count===1)throw new Error('Unknown outcome');return {result:'none'};}}));
test('concurrent retry uses one durable case and one advisory delivery lock',pg,async()=>fixture(async h=>{
  let start,release;const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{release=resolve;});let held=false;
  h.setMutation(async event=>{if(event.type==='card'&&!held){held=true;start();await gate;}});
  const running=h.submit(h.context);await started;
  const other=await h.restart()(h.context);assert.equal(other.delivery_complete,false);assert.equal(other.retry,true);assert.equal((await h.cases()).length,1);
  release();const completed=await running;assert.equal(completed.delivery_complete,true);assert.equal(completed.id,other.id);assert.equal(h.events.filter(event=>event.type==='card').length,1);
}));
test('unknown Telegram network outcome stops automatic retry, whereas a still-running sender only reports busy',pg,async()=>fixture(async h=>{
  h.setFail(event=>{if(event.type==='card')throw new Error('Unknown network result');});
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,false);assert.equal(first.manual_review,true);
  const before=h.events.length,result=await h.restart()(h.context);assert.equal(result.manual_review,true);assert.equal(result.retry,false);assert.equal(h.events.length,before);
}));
for(const type of ['card','copy','zip'])test('Telegram502 after accepting handoff '+type+' keeps the attempt unknown across restart instead of silently repeating it',pg,async()=>fixture(async h=>{
  h.setFail(event=>{if(event.type===type)throw Object.assign(new Error('Synthetic accepted send with upstream502'),{response:{error_code:502}});});
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,false);assert.equal(first.manual_review,true);
  const before=h.events.length;h.setFail(null);const retry=await h.restart()(h.context);assert.equal(retry.delivery_complete,false);assert.equal(retry.retry,false);assert.equal(retry.manual_review,true);assert.equal(h.events.length,before);
}));
for(const receipt of [{message_id:true},{message_id:6000,chat:{id:909}}])test('handoff card rejects a malformed or wrong-chat ACK without claiming a complete private packet: '+JSON.stringify(receipt),pg,async()=>fixture(async h=>{
  h.options.telegram.sendMessage=async()=>receipt;
  const first=await h.restart()(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.manual_review,true);assert.equal(first.retry,false);
  assert.equal((await h.cases())[0].data._handoff.cards[String(LAWYER)],undefined);
}));
for(const duplicate of ['within-batch','card'])test('handoff audit-copy receipt cannot reuse message IDs '+duplicate,pg,async()=>fixture(async h=>{
  const copy=h.options.telegram.callApi;h.options.telegram.callApi=async(...args)=>{const result=await copy(...args);if(duplicate==='within-batch')result[1]=result[0];else result[0]={message_id:6000};return result;};
  const first=await h.restart()(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.manual_review,true);assert.equal(first.retry,false);
  const before=h.events.length;await h.restart()(h.context);assert.equal(h.events.length,before);
}));
for(const receipt of [{message_id:true},{message_id:6000},{message_id:9000,chat:{id:909}}])test('handoff ZIP rejects malformed, reused card or wrong-chat acknowledgement: '+JSON.stringify(receipt),pg,async()=>fixture(async h=>{
  const send=h.options.telegram.sendDocument;h.options.telegram.sendDocument=async(...args)=>{await send(...args);return receipt;};
  const first=await h.restart()(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.manual_review,true);assert.equal(first.retry,false);
  assert.equal((await h.cases())[0].data._handoff.materials.confirmed[String(LAWYER)],undefined);
}));
test('a received Telegram ack with failed PostgreSQL receipt stays durably inflight and cannot duplicate on retry',pg,async()=>fixture(async h=>{
  const connect=h.pool.connect;let failed=false;
  h.pool.connect=async()=>{const client=await connect(),query=client.query;client.query=async(sql,params)=>{
    if(!failed&&sql.startsWith('UPDATE cases SET data=jsonb_set')&&JSON.parse(params[0]).cards[String(LAWYER)]){failed=true;throw new Error('Synthetic lost checkpoint commit');}
    return query(sql,params);
  };return client;};
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,false);assert.equal(first.manual_review,true);
  assert.equal((await h.cases())[0].data._handoff.inflight.type,'card');assert.equal(h.events.filter(event=>event.type==='card'&&event.id).length,1);
  const result=await h.restart()(h.context);assert.equal(result.manual_review,true);assert.equal(h.events.filter(event=>event.type==='card'&&event.id).length,1);
}));
test('busy delivery before a visible case does not falsely assert case_created:false',pg,async()=>fixture(async h=>{
  const locker=await h.pool.connect();await locker.query('SELECT pg_try_advisory_lock(111,hashtext($1)) AS locked',['101:'+h.body.submit_id]);
  try{await assert.rejects(h.submit(h.context),error=>error.code==='HANDOFF_BUSY'&&error.case_created===undefined);}finally{locker.release();}
  assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);
}));
test('strict cached-EGRN receipts persist per original so retry never duplicates a previously delivered small PDF',pg,async()=>{
  const delivered=[];
  await fixture(async h=>{
    const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);
    assert.equal((await h.cases())[0].data._handoff.egrn.copies.first,true);
    const retry=await h.restart()(h.context);assert.equal(retry.delivery_complete,true);assert.deepEqual(delivered,['first','second']);assert.equal(h.egCalls.length,2);
  },{withEgrn:false,egrn:async(opts,count)=>{
    assert.equal(opts.copyOptions.strict,true);
    for(const key of ['first','second']){
      if(opts.copyOptions.confirmed[key]===true)continue;
      if(count===1&&key==='second')throw Object.assign(tgFailure('Second cached PDF rejected'),{uncertain:false});
      delivered.push(key);await opts.copyOptions.onCopied(key,{message_id:900+delivered.length});
    }
    return {result:'attached'};
  }});
});
test('request-origin V2 physically delivers original request files to lawyer once, deduplicates saved audit IDs and does not copy request back to its source chat',pg,async()=>fixture(async h=>{
  h.body.request_id=9;
  await h.db.query('INSERT INTO reports VALUES(9,$1,$2,80)',[SOURCE,[80,81,101]]);
  const result=await h.submit(h.context);assert.equal(result.delivery_complete,true);
  const requestCopies=h.events.filter(event=>event.type==='copy'&&event.payload.message_ids.includes(80));
  assert.equal(requestCopies.length,1);assert.equal(requestCopies[0].chat,String(LAWYER));assert.deepEqual(requestCopies[0].payload.message_ids,[80,81]);
  const c=(await h.cases())[0];assert.equal(c.request_id,9);assert.deepEqual(c.data._handoff.request.message_ids,[80,81,101]);assert.deepEqual(c.data._handoff.request.copy_ids,[80,81]);assert.equal(c.data._handoff.requestCopies[String(LAWYER)].messageIds.length,2);
  const before=h.events.length;await h.restart()(h.context);assert.equal(h.events.length,before);assert.equal((await h.cases()).length,1);
}));
test('request-origin original-file retry uses frozen row IDs and resumes without a second case or repeated saved audit',pg,async()=>fixture(async h=>{
  h.body.request_id=9;await h.db.query('INSERT INTO reports VALUES(9,$1,$2,80)',[CLIENTS,[80,81]]);
  let failed=false;h.setFail(event=>{if(event.type==='copy'&&event.payload.message_ids.includes(80)&&!failed){failed=true;throw tgFailure('Explicit rejection of request file copy');}});
  const first=await h.submit(h.context);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);
  const auditCopies=h.events.filter(event=>event.type==='copy'&&!event.payload.message_ids.includes(80)).length;assert.equal(auditCopies,2);
  await h.db.query('UPDATE reports SET msg_ids=$1 WHERE id=9',[[999]]);
  const retry=await h.restart()(h.context);assert.equal(retry.delivery_complete,true);assert.equal(retry.id,first.id);assert.equal((await h.cases()).length,1);
  const requests=h.events.filter(event=>event.type==='copy'&&event.payload.message_ids.includes(80));assert.equal(requests.length,2);assert.ok(requests.every(event=>event.chat===String(LAWYER)&&event.payload.message_ids.join(',')==='80,81'));
  assert.equal(h.events.filter(event=>event.type==='copy'&&!event.payload.message_ids.includes(80)).length,auditCopies);assert.equal(h.events.filter(event=>event.type==='card').length,1);
  assert.equal(h.events.filter(event=>event.type==='zip').length,1);assert.equal(h.packetCalls(),1);assert.equal(h.reportCalls(),1);
}));
test('a reopened form with a new submit UUID cannot create a second ordinary case for the same audit order',pg,async()=>fixture(async h=>{
  const first=await h.submit(h.context),before=h.events.length;
  await assert.rejects(h.restart()({...h.context,body:{...h.body,submit_id:randomUUID()}}),error=>error.code==='HANDOFF_ALREADY_ASSIGNED'&&error.case_created===true&&error.case_id===first.id&&error.retry===false);
  assert.equal((await h.cases()).length,1);assert.equal(h.events.length,before);assert.equal(h.packetCalls(),1);
  const same=await h.restart()(h.context);assert.equal(same.id,first.id);assert.equal(same.delivery_complete,true);
}));
test('parallel forms from different staff for the same order respect the business lock and cannot create case two',pg,async()=>fixture(async h=>{
  await h.db.query("INSERT INTO staff VALUES(202,'Другой менеджер','manager',true)");
  let start,release;const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{release=resolve;});let held=false;
  h.setMutation(async event=>{if(event.type==='card'&&!held){held=true;start();await gate;}});
  const running=h.submit(h.context);await started;
  try{await assert.rejects(h.restart()({...h.context,user:{id:202},body:{...h.body,submit_id:randomUUID()}}),error=>error.code==='HANDOFF_ALREADY_ASSIGNED'&&error.case_created===true&&error.case_id>0&&error.retry===false);}
  finally{release();}
  assert.equal((await running).delivery_complete,true);assert.equal((await h.cases()).length,1);assert.equal(h.events.filter(event=>event.type==='card').length,1);
}));
test('a legacy case without a handoff checkpoint still blocks a second ordinary handoff of the same order',pg,async()=>fixture(async h=>{
  await h.db.query("INSERT INTO cases(order_id,lawyer_tg_id,lawyer_name,data) VALUES(60,808,'Юрист старой заявки','{}')");
  await assert.rejects(h.submit(h.context),error=>error.code==='HANDOFF_ALREADY_ASSIGNED'&&error.case_created===true&&/Юрист старой заявки/.test(error.message));
  assert.equal((await h.cases()).length,1);assert.equal(h.events.length,0);assert.equal(h.packetCalls(),0);
}));


test('an approved auditor cannot start or resume delivery even with a valid saved packet', pg, async () => fixture(async h => {
  await assert.rejects(h.submit({ ...h.context, staff: { name: 'Auditor', role: 'auditor', approved: true } }), error => error.status === 403);
  assert.equal((await h.cases()).length, 0); assert.equal(h.events.length, 0);
}));
test('a reviewed packet bound to a different request rejects source substitution before creating or delivering a case', pg, async () => fixture(async h => {
  h.body.request_id = 9;
  await assert.rejects(h.submit(h.context), error => error.code === 'HANDOFF_REQUEST_MISMATCH');
  assert.equal((await h.cases()).length, 0); assert.equal(h.events.length, 0);
}, { requestMismatch: true }));
test('a fresh manager form resumes the frozen case body after a temporary Telegram rejection', pg, async () => fixture(async h => {
  let rejected = false;
  h.setFail(event => { if (event.type === 'card' && !rejected) { rejected = true; throw tgFailure('Temporary rejection'); } });
  const first = await h.submit(h.context); assert.equal(first.delivery_complete, false);
  const second = await h.restart()({ ...h.context, body: { resume_case_id: first.id } });
  assert.equal(second.delivery_complete, true); assert.equal(second.id, first.id);
  assert.equal((await h.cases()).length, 1);
  assert.equal(h.events.filter(event => event.type === 'card' && event.id).length, 1);
  const copies = h.events.filter(event => event.type === 'copy');
  assert.ok(copies.every(event => event.chat === String(LAWYER)));
}));
