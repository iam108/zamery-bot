'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createHandoffSubmitter}=require('../src/web/handoff-submit');
const {createPacketService}=require('../src/web/handoff-packet');
const {createHandoffMaterialsDelivery}=require('../src/web/handoff-materials');
const {loadReportAggregate}=require('../src/web/legacy-report');
const pg={skip:!process.env.PGLITE_TEST_MODULE};
const SOURCE='-1001111111111',CLIENTS='-1002222222222',LAWYER=808;
const VIDEO='https://disk.yandex.ru/d/trusted-auditor-video';

async function fixture(options,run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),calls=[],writes=[],locks=new Map();let sequence=6000;
  const reportData=options.reportData===undefined?{ui_version:5,workflow:{video_url:VIDEO},inspection:{service:'Продление'}}:options.reportData;
  const ids=options.messageIds||[1000,1001,1002,1005],linked=options.linked===true;
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);
    INSERT INTO staff VALUES(808,'Юрист проверки','lawyer',true),(101,'Менеджер','manager',true);
    CREATE TABLE orders(id INT PRIMARY KEY,address TEXT,owner_name TEXT,object_name TEXT,object_type TEXT,contacts TEXT,zones_info TEXT,cad_num TEXT,service TEXT,archive_url TEXT,telegram_msg_id BIGINT);
    INSERT INTO orders VALUES(58,'Москва, тестовый объект','ООО Пример','Кафе Пример','Общепит алкоголь','','','','Продление',NULL,900);
    CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,text TEXT,report_data JSONB,draft_id UUID,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE reports(id INT PRIMARY KEY,text TEXT,author TEXT,chat_id BIGINT,msg_ids BIGINT[],reply_to BIGINT,first_id BIGINT,created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE cases(id SERIAL PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,checklist_key TEXT,org TEXT,inn TEXT,client TEXT,phone TEXT,address TEXT,region TEXT,kind TEXT,service TEXT,priority TEXT,comment TEXT,audit_text TEXT,total INT,created_by BIGINT,contacts JSONB,request_id INT,data JSONB DEFAULT '{}',created_at TIMESTAMPTZ DEFAULT NOW());`);
  await db.query('INSERT INTO audits(id,order_id,text,report_data,chat_id,msg_ids) VALUES(7,$1,$2,$3,$4,$5)',[linked?58:null,'Сводка аудитора\nПоследняя сохранённая строка.',JSON.stringify(reportData),SOURCE,ids]);
  await db.query('INSERT INTO reports(id,text,author,chat_id,msg_ids,first_id) VALUES(9,$1,$2,$3,$4,80)', ['Новая форма заполнена\nНаименование организации: ООО Пример','Менеджер',options.requestChat||SOURCE,[80]]);
  await db.query('INSERT INTO reports(id,text,author,chat_id,msg_ids,first_id,reply_to) VALUES(20,$1,$2,$3,$4,$5,NULL)',[linked?'Заявка #58':'Сводка старого аудитора','Аудитор',SOURCE,linked?[900]:ids.slice(0,1),linked?900:ids[0]]);
  if(!linked&&ids.length>1)await db.query('INSERT INTO reports(id,text,author,chat_id,msg_ids,first_id,reply_to) VALUES(21,$1,$2,$3,$4,$5,$6)',['Продолжение отчёта и оригинальный ZIP','Аудитор',SOURCE,ids.slice(1),ids[1],ids[0]]);
  const query=(sql,args)=>{if(sql.startsWith('INSERT INTO cases'))writes.push({sql,params:args});return args?db.query(sql,args):db.exec(sql);};
  const pool={query,async connect(){const owner=randomUUID();return{async query(sql,args){
    if(sql.startsWith('SELECT pg_try_advisory_lock')){const key=sql.match(/\((\d+),/)[1]+':'+args[0],available=!locks.has(key)||locks.get(key)===owner;if(available)locks.set(key,owner);return{rows:[{locked:available}]};}
    if(sql.startsWith('SELECT pg_advisory_unlock')){const key=sql.match(/\((\d+),/)[1]+':'+args[0],owned=locks.get(key)===owner;if(owned)locks.delete(key);return{rows:[{pg_advisory_unlock:owned}]};}
    return query(sql,args);
  },release(error){if(error)for(const[key,value]of locks)if(value===owner)locks.delete(key);}};}};
  const telegram={
    async callApi(method,payload){assert.equal(method,'copyMessages');calls.push({method,payload});const copied=payload.message_ids.map(()=>({message_id:sequence++}));return options.dropReceipt&&String(payload.chat_id)===String(options.dropReceipt)?copied.slice(1):copied;},
    async sendMessage(chat,text,opts){const messageId=sequence++;calls.push({method:'sendMessage',chat,text,opts,messageId});if(options.failDm&&String(chat)===String(LAWYER))throw Object.assign(new Error('Synthetic blocked private chat'),{response:{error_code:403,description:'Forbidden: bot was blocked by the user'}});return{message_id:messageId,chat:{id:chat}};},
    async sendDocument(){assert.fail('These fixtures contain no separate manager material ZIP');},
    async editMessageReplyMarkup(chat,messageId,inlineId,markup){calls.push({method:'editMessageReplyMarkup',chat,messageId,markup});return true;},
  };
  const packetService=createPacketService({pool,workingChatId:SOURCE,listMaterials:async()=>[],listEgrnLinks:async()=>[]});
  const getReport=(src,id)=>src==='a'?pool.query('SELECT * FROM audits WHERE id=$1',[id]).then(result=>result.rows[0]):loadReportAggregate(pool,id,{workingChatId:SOURCE});
  const settings={pool,ready:async()=>{},packetService,telegram,loadReport:getReport,clientsChatId:CLIENTS,workingChatId:SOURCE,webappUrl:'https://audit.example',
    materialDelivery:createHandoffMaterialsDelivery({telegram,loadMaterials:async()=>[]}),
    async attachEgrn(input){calls.push({method:'attachOrOrder',input});return{result:'attached'};}};
  const body={handoff_version:2,submit_id:randomUUID(),order_id:linked?58:null,report_src:options.noAudit?null:options.src||'a',report_id:options.noAudit?null:options.src==='r'?20:7,lawyer_tg_id:LAWYER,
    org:'ООО Пример',address:'Москва, тестовый объект',region:'МСК',kind:'Общепит',service:'Продление',priority:'обычный',contacts:[{name:'Контакт клиента',phone:'+79990000000'}],egrn_order:false,
    video_url:'https://untrusted.example/manager-body-must-not-win'};
  const invoke=payload=>createHandoffSubmitter(settings)({body:payload,user:{id:101},staff:{name:'Менеджер',role:'manager',approved:true}});
  try{await run({calls,writes,db,ids,getReport,cases:async()=>(await db.query('SELECT * FROM cases ORDER BY id')).rows,
    async send(changes={}){const payload={...body,...changes};payload.packet_signature=(await packetService.packet({order_id:payload.order_id,report_src:payload.report_src,report_id:payload.report_id,request_id:payload.request_id})).signature;const result=await invoke(payload);assert.equal(result.ok,true);return result;},
    resume:id=>invoke({resume_case_id:id})});assert.equal(locks.size,0,'Session locks are explicitly released');}
  finally{await db.close();}
}
function recipient(h,chat){return h.calls.find(call=>call.method==='sendMessage'&&String(call.chat)===String(chat));}
function buttons(message){return message?.opts?.reply_markup?.inline_keyboard.flat()||[];}
function assertDocumentsAction(message,caseId){
  const rows=message.opts.reply_markup.inline_keyboard;
  assert.deepEqual(rows[1],[{text:'Документы клиента',web_app:{url:'https://audit.example/handoff?case_id='+caseId+'&view=documents'}}]);
  assert.equal(rows[0].some(button=>button.text==='Документы клиента'),false,'Documents use their own row, preserving checklist/report navigation');
}
function assertReworkAction(message,caseId){
  assert.deepEqual(message.opts.reply_markup.inline_keyboard.at(-1),[{text:'Вернуть на доработку',web_app:{url:'https://audit.example/checklist?case_id='+caseId+'&rework=1'}}]);
}
function assertPrivatePackage(h){
  assert.ok(h.calls.filter(call=>call.method==='copyMessages').every(call=>String(call.payload.chat_id)===String(LAWYER)));
  assert.equal(recipient(h,SOURCE),undefined,'The measurements chat never receives a second handoff card');
  const notice=recipient(h,CLIENTS);assert.ok(notice);assert.match(notice.text,/^Клиент передан юристу/);assert.doesNotMatch(notice.text,/Сводка аудитора|Последняя сохранённая строка|79990000000|untrusted\.example/);
  assert.ok(buttons(notice).every(button=>!button.web_app&&/^https:\/\/t\.me\/LRSZamer_bot\?start=case_\d+$/.test(button.url)));
  assert.ok(h.calls.filter(call=>call.method==='sendMessage').every(call=>[String(LAWYER),CLIENTS].includes(String(call.chat))));
}

for(const kind of ['a','r'])test('no-order V2 saved '+kind+' report privately copies every original ZIP ID and keeps its exact report action',pg,async()=>fixture({src:kind},async h=>{
  const lookedUp=await h.getReport(kind,kind==='a'?7:20);assert.equal(lookedUp.order_id,null);if(kind==='r')assert.equal(lookedUp.report_data,undefined,'No metadata is invented for an unlinked Telegram report');
  const result=await h.send();assert.equal(result.delivery_complete,true);assert.equal(h.writes.length,1);const c=(await h.cases())[0];assert.equal(c.order_id,null);
  const copied=h.calls.filter(call=>call.method==='copyMessages');assert.equal(copied.length,1);assert.equal(copied[0].payload.from_chat_id,SOURCE);assert.deepEqual(copied[0].payload.message_ids,[1000,1001,1002,1005]);
  assert.ok(copied[0].payload.message_ids.includes(1005),'The original ZIP is physically copied, not only linked to its private source');
  const keys=buttons(recipient(h,LAWYER));assert.ok(keys.some(key=>key.web_app?.url==='https://audit.example/checklist?case_id='+c.id));
  const report=keys.find(key=>key.web_app?.url.includes('view=report'));assert.ok(report);const url=new URL(report.web_app.url);assert.equal(url.searchParams.get('case_id'),String(c.id));assert.equal(url.searchParams.get('report_src'),kind);assert.equal(url.searchParams.get('report_id'),String(kind==='a'?7:20));
  assert.equal(keys.some(key=>key.url===VIDEO),kind==='a');assert.ok(!keys.some(key=>String(key.url||'').includes('untrusted.example')));assert.ok(!keys.some(key=>/^https:\/\/t\.me\/c\//.test(key.url||'')),'Actions do not require private source-chat membership');
  assertPrivatePackage(h);
}));

test('a server-linked legacy Telegram card inherits the exact saved audit video through the same V2 submitter',pg,async()=>fixture({src:'r',linked:true,reportData:JSON.stringify({ui_version:5,workflow:{video_url:VIDEO},inspection:{service:'Продление'}})},async h=>{
  const lookedUp=await h.getReport('r',20);assert.equal(lookedUp.order_id,58);assert.equal(typeof lookedUp.report_data,'string');const result=await h.send();assert.equal(result.delivery_complete,true);
  const copied=h.calls.filter(call=>call.method==='copyMessages').flatMap(call=>call.payload.message_ids);assert.deepEqual(copied,[900,1000,1001,1002,1005]);assert.ok(buttons(recipient(h,LAWYER)).some(button=>button.url===VIDEO));assertPrivatePackage(h);
}));

for(const[name,reportData]of[
  ['explicitly cleared optional video',{ui_version:5,workflow:{video_url:''},video_url:VIDEO}],
  ['missing optional video',{ui_version:5,workflow:{}}],
  ['non-HTTPS saved link',JSON.stringify({ui_version:5,workflow:{video_url:'http://disk.yandex.ru/d/not-https'}})],
  ['malformed saved JSON','{not-json'],
])test(name+' cannot add empty or untrusted V2 recipient action buttons',pg,async()=>fixture({reportData},async h=>{
  const result=await h.send();assert.equal(result.delivery_complete,true);const message=recipient(h,LAWYER),lawyerKeys=buttons(message);assert.equal(lawyerKeys.filter(key=>key.url).length,0);assert.equal(lawyerKeys.length,4,'Checklist, exact frozen report, client documents and return remain available');assert.ok(lawyerKeys.every(key=>key.web_app));assertDocumentsAction(message,result.id);assertReworkAction(message,result.id);assertPrivatePackage(h);
}));

test('a safe HTTPS video saved by an older audit remains trusted, while a manager body URL never replaces it',pg,async()=>fixture({reportData:{ui_version:4,workflow:{video_url:VIDEO}}},async h=>{
  const result=await h.send();assert.equal(result.delivery_complete,true);const links=buttons(recipient(h,LAWYER)).filter(button=>button.url);assert.deepEqual(links,[{text:'▶ Видео осмотра',url:VIDEO}]);assertPrivatePackage(h);
}));

test('a manager body video URL cannot create a video or report action when no saved audit was selected',pg,async()=>fixture({noAudit:true},async h=>{
  const result=await h.send({audit_text:'Manual manager context'});assert.equal(result.delivery_complete,true);assert.equal(h.calls.filter(call=>call.method==='copyMessages').length,0);
  const message=recipient(h,LAWYER),keys=buttons(message);assert.equal(keys.length,3,'A valid V2 licence case retains its checklist, document access and return');assertDocumentsAction(message,result.id);assertReworkAction(message,result.id);assert.ok(keys[0].web_app?.url.includes('/checklist?case_id='));assert.equal(keys.some(button=>button.url||button.web_app?.url.includes('view=report')),false);assertPrivatePackage(h);
}));

test('a no-order legacy report over 100 messages copies its final ZIP in the second private batch',pg,async()=>fixture({src:'r',messageIds:Array.from({length:105},(_,i)=>1000+i)},async h=>{
  const result=await h.send();assert.equal(result.delivery_complete,true);const batches=h.calls.filter(call=>call.method==='copyMessages');assert.deepEqual(batches.map(call=>call.payload.message_ids.length),[100,5]);
  const received=batches.flatMap(call=>call.payload.message_ids);assert.deepEqual(received,h.ids);assert.equal(received.at(-1),1104,'The final original ZIP is not silently lost');assertPrivatePackage(h);
}));

test('a missing Telegram copy ACK keeps the existing V2 case visibly incomplete and stops automatic replay',pg,async()=>fixture({dropReceipt:LAWYER},async h=>{
  const result=await h.send();assert.equal(result.delivery_complete,false);assert.equal(result.manual_review,true);assert.equal(result.retry,false);assert.match(result.warn,/Telegram|подтверд|провер/i);assert.equal(h.writes.length,1);assert.equal((await h.cases()).length,1);
  assert.equal(recipient(h,CLIENTS),undefined,'No public success notice before complete private delivery');const before=h.calls.length;const resumed=await h.resume(result.id);assert.equal(resumed.manual_review,true);assert.equal(resumed.delivery_complete,false);assert.equal(h.calls.length,before);assert.equal((await h.cases()).length,1);
}));

test('a request originating in CLIENTS and the auditor ZIP and EGRN are private, followed only by a short CLIENTS summary',pg,async()=>fixture({requestChat:CLIENTS},async h=>{
  const result=await h.send({request_id:9,cad_num:'77:01:0004016:1064'});assert.equal(result.delivery_complete,true);assertPrivatePackage(h);
  assert.deepEqual(h.calls.filter(call=>call.method==='sendMessage').map(call=>String(call.chat)),[String(LAWYER),CLIENTS]);const copies=h.calls.filter(call=>call.method==='copyMessages');
  assert.ok(copies.some(call=>String(call.payload.from_chat_id)===CLIENTS&&call.payload.message_ids.includes(80)),'Original request messages are delivered privately');assert.ok(copies.some(call=>String(call.payload.from_chat_id)===SOURCE&&call.payload.message_ids.includes(1005)),'Auditor ZIP is delivered privately');
  const egrn=h.calls.find(call=>call.method==='attachOrOrder');assert.ok(egrn);assert.deepEqual(egrn.input.targets.map(target=>String(target.chat)),[String(LAWYER)]);assert.equal(egrn.input.targets[0].reply,recipient(h,LAWYER).messageId);assert.equal(egrn.input.targets[0].case_id,result.id);assert.equal(egrn.input.order,false,'This test only attaches a pre-existing original and never orders');
  assert.equal(h.calls.filter(call=>call.method==='editMessageReplyMarkup').length,0,'No second public handoff action is published into the measurements/request thread');
}));

test('an explicitly rejected lawyer DM never falls back to either group or claims completed public delivery',pg,async()=>fixture({failDm:true},async h=>{
  const result=await h.send();assert.equal(result.delivery_complete,false);assert.equal(result.retry,true);assert.equal(result.manual_review,undefined);assert.match(result.warn,/создан|не завершена/i);
  assert.ok(h.calls.filter(call=>call.method==='sendMessage').every(call=>String(call.chat)===String(LAWYER)));assert.equal(h.calls.filter(call=>call.method==='copyMessages').length,0);assert.equal(recipient(h,CLIENTS),undefined);assert.equal(recipient(h,SOURCE),undefined);assert.equal(h.writes.length,1);assert.equal((await h.cases())[0].data._handoff.completed,false);
}));
