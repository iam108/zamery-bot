'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {createHandoffSubmitter}=require('../src/web/handoff-submit');
const {createPacketService}=require('../src/web/handoff-packet');
const {createManualMatches,setupHandoffManual}=require('../src/web/handoff-manual');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:15000};
const LAWYER='808',CLIENTS='-1004000000003';
async function fixture(run) {
 const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),events=[],locks=new Map();let next=2000,transport=async()=>{},before=async()=>{},leased=0,manualReady=false;
 const previousAdmin=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='103';
 try {
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,name TEXT,role TEXT,approved BOOLEAN);
   INSERT INTO staff VALUES(101,'Manager','manager',true),(102,'Another manager','manager',true),(103,'Admin','auditor',true),(808,'Lawyer','lawyer',true);
   CREATE TABLE cases(id SERIAL PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,checklist_key TEXT,org TEXT,inn TEXT,client TEXT,phone TEXT,address TEXT,region TEXT,kind TEXT,service TEXT,priority TEXT,comment TEXT,audit_text TEXT,total INT,created_by BIGINT,contacts JSONB,request_id INT,data JSONB DEFAULT '{}',created_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE orders(id INT PRIMARY KEY,object_name TEXT,telegram_msg_id BIGINT);
   CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,text TEXT,report_data JSONB,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE reports(id INT PRIMARY KEY,text TEXT,author TEXT,chat_id BIGINT,msg_ids BIGINT[],reply_to BIGINT,first_id BIGINT,created_at TIMESTAMPTZ DEFAULT NOW());`);
  const query=async(sql,args)=>{await before(sql,args);return args?db.query(sql,args):(await db.exec(sql)).at(-1);};
  const pool={query,async connect(){assert.equal(manualReady,true,'Manual schema setup precedes the delivery lease');const owner=randomUUID();leased++;return{async query(sql,args){
   if(sql.startsWith('SELECT pg_try_advisory_lock')){const key=sql.match(/\((\d+),/)[1]+':'+args[0],available=!locks.has(key)||locks.get(key)===owner;if(available)locks.set(key,owner);return{rows:[{locked:available}]};}
   if(sql.startsWith('SELECT pg_advisory_unlock')){const key=sql.match(/\((\d+),/)[1]+':'+args[0],owned=locks.get(key)===owner;if(owned)locks.delete(key);return{rows:[{unlocked:owned}]};}
   return query(sql,args);
  },release(){leased--;for(const[key,value]of locks)if(value===owner)locks.delete(key);}};}};
  const files=[],store={async ensure(){manualReady=true;},async freeze(_client,_owner,_sid,expected){assert.equal(leased,1);const meta=files.map(({buffer,...file})=>file);assert.deepEqual(expected,meta);return meta;},async loadCase(){return files;}};
  const telegram={async sendMessage(chat,text,opts){const item={type:String(chat)===LAWYER?'card':'notice',chat:String(chat),text,opts};events.push(item);await transport(item);item.id=next++;return{message_id:item.id,chat:{id:chat}};},async sendDocument(chat,file,opts){const chunks=[];for await(const chunk of file.source)chunks.push(chunk);const item={type:'zip',chat:String(chat),name:file.filename,buffer:Buffer.concat(chunks),opts};events.push(item);await transport(item);item.id=next++;return{message_id:item.id,chat:{id:chat}};},async callApi(){assert.fail('Manual clients have no report/request copies');}};
  const packets=createPacketService({pool,listMaterials:async()=>assert.fail('No order materials'),listEgrnLinks:async()=>assert.fail('No EGRN links')});
  const options={pool,ready:async()=>{},telegram,packetService:packets,manualMaterialsStore:store,webappUrl:'https://bot.example',clientsChatId:CLIENTS,
   attachEgrn:async()=>assert.fail('Manual must not query, copy or order EGRN'),loadReport:async()=>assert.fail('Manual must not load an audit')};
  const body=async(extra={})=>({handoff_version:2,manual_client:true,submit_id:randomUUID(),order_id:null,request_id:null,report_id:null,report_src:null,egrn_order:false,
   lawyer_tg_id:808,org:'ООО Синтетический клиент',address:'Московская область, Тестовая улица, 12',region:'МО',kind:'Общепит',service:'Продление',priority:'обычный',contacts:[],cad_num:'50:01:0000001:12',manual_files:files.map(({buffer,...file})=>file),packet_signature:(await packets.packet({})).signature,...extra});
  const invoke=(payload,actor=101,role='manager')=>createHandoffSubmitter(options)({body:payload,user:{id:actor},staff:{name:'Manager',role,approved:true}});
  await run({db,pool,events,files,store,options,body,invoke,transport(fn){transport=fn;},before(fn){before=fn;},cases:async()=>(await db.query('SELECT * FROM cases ORDER BY id')).rows});
  assert.equal(locks.size,0);assert.equal(leased,0);
 } finally {if(previousAdmin===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=previousAdmin;await db.close();}
}

test('manual MO client retains its cadastral number but performs no EGRN, audit, order or report operation',pg,async()=>fixture(async h=>{
 const body=await h.body(),first=await h.invoke(body);assert.equal(first.delivery_complete,true);const rows=await h.cases();assert.equal(rows.length,1);const c=rows[0];
 assert.equal(c.order_id,null);assert.equal(c.request_id,null);assert.equal(c.checklist_key,'MO_OBSH');assert.equal(c.data._handoff.fields.cad_num,body.cad_num);assert.equal(c.data._handoff.egrn.result,'skipped-manual');assert.equal(c.data._handoff.egrn.order_started,false);assert.equal(c.data._handoff.egrn.completed,true);
 assert.deepEqual(h.events.map(e=>[e.type,e.chat]),[['card',LAWYER],['notice',CLIENTS]]);assert.ok(!h.events[0].opts.reply_markup.inline_keyboard.flat().some(button=>button.web_app?.url.includes('view=report')));assert.doesNotMatch(h.events[0].text,/Полный отчёт и оригиналы/);
 assert.deepEqual(h.events[0].opts.reply_markup.inline_keyboard[1].map(button=>button.text),['Документы клиента']);assert.equal(new URL(h.events[0].opts.reply_markup.inline_keyboard[1][0].web_app.url).search,'?case_id='+c.id+'&view=documents');
 assert.doesNotMatch(h.events[1].text,/отчёт/i,'A manual client has no audit report to promise');assert.equal(h.events[1].opts.reply_markup.inline_keyboard[0][0].text,'Открыть клиента');
 await h.invoke(body);await h.invoke({resume_case_id:c.id});assert.equal(h.events.length,2);assert.equal((await h.cases()).length,1);
}));

for(const change of [{order_id:62},{request_id:9},{report_id:15,report_src:'a'},{report_src:'a'},{egrn_order:true},{manual_client:'true'},{manual_client:false,manual_files:[{}]}])test('manual contract rejects bound sources, EGRN opt-in or a forged marker '+JSON.stringify(change),pg,async()=>fixture(async h=>{
 await assert.rejects(h.invoke(await h.body(change)),error=>error.status===400&&error.code==='HANDOFF_MANUAL_INVALID');assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);
}));

test('two new manual submissions remain distinct clients while exact concurrent/restarted retries retain one original client',pg,async()=>fixture(async h=>{
 let enter,release;const entered=new Promise(resolve=>enter=resolve),hold=new Promise(resolve=>release=resolve);let first=true;
 h.transport(async event=>{if(event.type==='card'&&first){first=false;enter();await hold;}});const body=await h.body(),pending=h.invoke(body);await entered;const other=await h.invoke(body);assert.equal(other.delivery_complete,false);assert.equal((await h.cases()).length,1);release();const completed=await pending;assert.equal(completed.delivery_complete,true);
 await h.invoke(body);assert.equal(h.events.filter(e=>e.type==='card').length,1);const newClient=await h.invoke(await h.body());assert.equal(newClient.delivery_complete,true);assert.notEqual(newClient.id,completed.id);assert.equal((await h.cases()).length,2,'Duplicate search warns, never merges separate new submissions');
}));

for(const unknown of [false,true])test('manual private card '+(unknown?'unknown ACK stays frozen':'known rejection resumes same case'),pg,async()=>fixture(async h=>{
 let once=true;h.transport(event=>{if(once&&event.type==='card'){once=false;throw Object.assign(new Error('Synthetic transport fault'),unknown?{}:{response:{error_code:400}});}});
 const body=await h.body(),first=await h.invoke(body);assert.equal(first.delivery_complete,false);assert.equal((await h.cases()).length,1);assert.equal(h.events.filter(e=>e.type==='notice').length,0);
 const retried=await h.invoke({resume_case_id:first.id});assert.equal(retried.id,first.id);assert.equal(retried.delivery_complete,!unknown);assert.equal(h.events.filter(e=>e.type==='card').length,unknown?1:2);assert.equal(h.events.filter(e=>e.type==='notice').length,unknown?0:1);
}));

test('a mismatched or unreadable saved manual original fails before any case or physical message',pg,async()=>fixture(async h=>{
 h.store.freeze=async()=>{throw Object.assign(new Error('Synthetic storage integrity failure'),{status:409,code:'HANDOFF_MATERIAL_CHANGED'});};
 await assert.rejects(h.invoke(await h.body()),error=>error.status===409&&error.code==='HANDOFF_MATERIAL_CHANGED'&&error.case_created===false);assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);
}));

test('a rejected manual group summary preserves private completion and truthfully retries only its notice',pg,async()=>fixture(async h=>{
 let once=true;h.transport(event=>{if(once&&event.type==='notice'){once=false;throw{response:{error_code:400}};}});const body=await h.body(),first=await h.invoke(body);
 assert.equal(first.delivery_complete,true);assert.match(first.warn,/Карточка клиента доставлена/);assert.doesNotMatch(first.warn,/Отчёт/);assert.equal(first.group_notice.status,'rejected');
 const retry=await h.invoke(body);assert.equal(retry.id,first.id);assert.equal(retry.delivery_complete,true);assert.equal(retry.group_notice.status,'confirmed');assert.equal(h.events.filter(event=>event.type==='card').length,1);assert.equal(h.events.filter(event=>event.type==='notice').length,2);
}));

const original=(name,bytes)=>{const buffer=Buffer.from(bytes);return{id:randomUUID(),name,mime:name.endsWith('.pdf')?'application/pdf':'image/png',role:'document',bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),buffer};};
async function savedOriginals(h,body) {
 const store=require('../src/web/handoff-manual-materials').createManualMaterialsStore(h.pool);await h.store.ensure();await store.ensure();h.options.manualMaterialsStore=store;
 for(const file of h.files)await h.db.query('INSERT INTO handoff_manual_materials(owner_tg_id,submit_id,id,name,mime,role,bytes,sha256,content) VALUES(101,$1,$2,$3,$4,$5,$6,$7,$8)',[body.submit_id,file.id,file.name,file.mime,file.role,file.bytes,file.sha256,file.buffer]);
 return store;
}
async function unzip(buffer) {
 const yauzl=require('yauzl'),zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,result)=>error?reject(error):resolve(result)));
 return new Promise((resolve,reject)=>{const files=[];zip.on('error',reject);zip.on('end',()=>resolve(files));zip.on('entry',entry=>zip.openReadStream(entry,async(error,stream)=>{if(error)return reject(error);try{const chunks=[];for await(const chunk of stream)chunks.push(chunk);files.push({name:entry.fileName,buffer:Buffer.concat(chunks)});zip.readEntry();}catch(failure){reject(failure);}}));zip.readEntry();});
}
for(const upper of [false,true])test('saved manual originals stay exact in one private client ZIP, uppercase submit UUID='+upper,pg,async()=>fixture(async h=>{
 h.files.push(original('План.pdf','%PDF-exact-original'),original('Фото.png','exact-PNG-original'));const body=await h.body();if(upper)body.submit_id=body.submit_id.toUpperCase();await savedOriginals(h,body);
 const result=await h.invoke(body);assert.equal(result.delivery_complete,true);const cases=await h.cases();assert.equal(cases.length,1);assert.equal(cases[0].order_id,null);assert.equal(cases[0].data._handoff.materials.completed,true);assert.equal(cases[0].data._handoff.packet.manual_materials.length,2);
 const zips=h.events.filter(event=>event.type==='zip');assert.equal(zips.length,1);assert.equal(zips[0].name,'Клиент-'+result.id+'-документы.zip');assert.equal(zips[0].chat,LAWYER);
 const files=await unzip(zips[0].buffer);for(const file of h.files)assert.equal(files.filter(saved=>saved.buffer.equals(file.buffer)).length,1);assert.ok(h.events.find(event=>event.type==='card').text.includes('Документы клиента: 2.'));
 const count=h.events.length;await h.invoke({resume_case_id:result.id});assert.equal(h.events.length,count);
}));

test('stored manual byte corruption before case creation is a typed integrity failure with zero private or group messages',pg,async()=>fixture(async h=>{
 h.files.push(original('План.pdf','%PDF-exact-original'));const body=await h.body();await savedOriginals(h,body);await h.db.query('UPDATE handoff_manual_materials SET content=$1',[Buffer.from('corrupted')]);
 await assert.rejects(h.invoke(body),error=>error.status===503&&error.code==='HANDOFF_MATERIAL_INTEGRITY'&&error.case_created===false);assert.equal((await h.cases()).length,0);assert.equal(h.events.length,0);
}));

test('manual storage read failure after its confirmed card keeps the same case and retries only the missing original ZIP',pg,async()=>fixture(async h=>{
 h.files.push(original('План.pdf','%PDF-exact-original'));const body=await h.body();await savedOriginals(h,body);let once=true;
 h.transport(async event=>{if(once&&event.type==='card'){once=false;await h.db.query('UPDATE handoff_manual_materials SET content=$1',[Buffer.from('corrupted')]);}});
 const first=await h.invoke(body);assert.equal(first.delivery_complete,false);assert.equal(first.retry,true);assert.equal(h.events.filter(event=>event.type==='card').length,1);assert.equal(h.events.filter(event=>event.type==='zip'||event.type==='notice').length,0);
 await h.db.query('UPDATE handoff_manual_materials SET content=$1',[h.files[0].buffer]);const resumed=await h.invoke({resume_case_id:first.id});assert.equal(resumed.id,first.id);assert.equal(resumed.delivery_complete,true);assert.equal((await h.cases()).length,1);assert.equal(h.events.filter(event=>event.type==='card').length,1);assert.equal(h.events.filter(event=>event.type==='zip').length,1);assert.equal(h.events.filter(event=>event.type==='notice').length,1);
}));

for(const unknown of [false,true])test('manual ZIP '+(unknown?'unknown ACK prevents repeated originals':'known rejection resumes without a second private card'),pg,async()=>fixture(async h=>{
 h.files.push(original('План.pdf','%PDF-exact-original'));const body=await h.body();await savedOriginals(h,body);let once=true;h.transport(event=>{if(once&&event.type==='zip'){once=false;throw Object.assign(new Error('Synthetic ZIP fault'),unknown?{}:{response:{error_code:400}});}});
 const first=await h.invoke(body);assert.equal(first.delivery_complete,false);assert.equal(first.retry,!unknown);assert.equal(h.events.filter(event=>event.type==='notice').length,0);
 const resumed=await h.invoke({resume_case_id:first.id});assert.equal(resumed.id,first.id);assert.equal(resumed.delivery_complete,!unknown);assert.equal((await h.cases()).length,1);assert.equal(h.events.filter(event=>event.type==='card').length,1);assert.equal(h.events.filter(event=>event.type==='zip').length,unknown?1:2);assert.equal(h.events.filter(event=>event.type==='notice').length,unknown?0:1);
}));

async function add(h,fields={}) {return(await h.db.query(`INSERT INTO cases(org,address,inn,lawyer_name,data) VALUES($1,$2,$3,$4,$5) RETURNING id`,[fields.org||'ООО Ёлка',fields.address||'МО, Тестовая 12',fields.inn??'1234567890',fields.lawyer_name||'Юрист',JSON.stringify({_stage:fields.stage||'',secret:'Never return',_handoff:{private:'Never return'}})])).rows[0].id;}
test('similar-client lookup requires the same normalized address and matches INN or organization, including archived clients',pg,async()=>fixture(async h=>{
 const byInn=await add(h,{org:'Другое название',stage:'Архив'}),byOrg=await add(h,{inn:'0987654321'});await add(h,{address:'МО, Другой адрес'});await add(h,{org:'Чужая организация',inn:'1111111111'});
 const result=await createManualMatches({pool:h.pool})({org:'  ООО  елка ',address:' мо,   тестовая 12 ',inn:'1234567890'},101);
 assert.deepEqual(result.matches.map(row=>row.case_id),[byOrg,byInn]);assert.deepEqual(result.matches.map(row=>row.match_by),['org_address','inn_address']);assert.equal(result.matches[1].stage,'Архив');assert.equal(result.has_more,false);
 for(const found of result.matches){assert.deepEqual(Object.keys(found).sort(),['address','case_id','checklist_url','lawyer_name','match_by','org','stage']);assert.equal(found.checklist_url,'/checklist?case_id='+found.case_id);}
}));

test('similar-client lookup is bounded and reports an authorized empty result honestly',pg,async()=>fixture(async h=>{
 const match=createManualMatches({pool:h.pool});assert.deepEqual(await match({org:'Нет клиента',address:'Другой адрес'},101),{matches:[],has_more:false});for(let i=0;i<12;i++)await add(h);
 const result=await match({inn:'1234567890',address:'МО, Тестовая 12'},101);assert.equal(result.matches.length,10);assert.equal(result.has_more,true);
}));

for(const actor of [808,999])test('similar clients remain private to a current manager/configured administrator, denied actor '+actor,pg,async()=>fixture(async h=>{
 await add(h);await assert.rejects(createManualMatches({pool:h.pool})({org:'ООО Ёлка',address:'МО, Тестовая 12'},actor),error=>error.status===403);
}));

test('a configured approved admin can search but access revoked during the final SELECT is never reported as no matches',pg,async()=>fixture(async h=>{
 await add(h);assert.equal((await createManualMatches({pool:h.pool})({org:'ООО Ёлка',address:'МО, Тестовая 12'},103)).matches.length,1);
 h.before(async sql=>{if(sql.includes('SELECT found.*'))await h.db.query('UPDATE staff SET approved=false WHERE tg_id=101');});await assert.rejects(createManualMatches({pool:h.pool})({org:'ООО Ёлка',address:'МО, Тестовая 12'},101),error=>error.status===403);
}));

test('manual-matches route rejects invalid inputs and sanitizes a storage error without exposing private text',pg,async()=>fixture(async h=>{
 const routes=new Map();setupHandoffManual({get(path,handler){routes.set(path,handler);}},{pool:h.pool});const route=routes.get('/api/handoff/manual-matches');
 const invoke=async query=>{const result={status:200};await route({query,staff:{role:'manager',approved:true},tgUser:{id:101}},{status(code){result.status=code;return this;},json(body){result.body=body;return this;}});return result;};
 for(const query of [{org:'X'},{address:'X',inn:'bad'},{address:['X'],org:'X'},{address:'X',org:'X'.repeat(501)}])assert.equal((await invoke(query)).status,400);
 h.before(()=>{throw new Error('PRIVATE DATABASE DETAILS');});const failed=await invoke({address:'X',org:'X'});assert.equal(failed.status,503);assert.equal(failed.body.code,'HANDOFF_MATCHES_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(failed),/PRIVATE/);
}));
