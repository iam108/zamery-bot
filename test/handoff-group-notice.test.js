'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const {createHandoffNoticePublisher,initialNotice,SAVE_CHECKPOINT_SQL}=require('../src/web/handoff-group-notice');
const {createHandoffSubmitter}=require('../src/web/handoff-submit');
const {createHandoffNoticeAdmin}=require('../src/bot/handoff-notice-admin');
const pg={skip:!process.env.PGLITE_TEST_MODULE},GROUP='-1007777999911';
async function fixture(run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),locks=new Map(),sends=[];let before=async()=>{},after=async()=>{},send=async()=>({message_id:1700,chat:{id:GROUP}});
  const body={handoff_version:2,submit_id:randomUUID(),order_id:62,report_src:'a',report_id:15,lawyer_tg_id:808};
  const state={version:2,body,fields:{},packet:{report:{id:15,src:'a'},materials:[],egrn_links:[]},recipients:[{chat:'808',role:'lawyer'}],cards:{808:1470},source:{chat_id:'-1001234',message_ids:[10,11]},auditCopies:{808:{offset:2,messageIds:[1471,1472]}},materials:{completed:true,confirmed:{808:[1473]}},egrn:{completed:true,result:'included'},completed:true};
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);
    CREATE TABLE orders(id INT PRIMARY KEY,object_name TEXT,telegram_msg_id BIGINT);
    CREATE TABLE cases(id INT PRIMARY KEY,order_id INT,created_by BIGINT,handoff_submit_id TEXT,handoff_signature TEXT,lawyer_tg_id BIGINT,lawyer_name TEXT,org TEXT,address TEXT,kind TEXT,service TEXT,priority TEXT,data JSONB);
    INSERT INTO staff VALUES(101,'manager',true),(102,'manager',true),(808,'lawyer',true),(999,'lawyer',true);
    INSERT INTO orders VALUES(62,'Синтетический бренд',1000);
    INSERT INTO cases(id,lawyer_tg_id,data) VALUES(40,808,'{}'),(41,808,'{"_stage":"Архив"}'),(42,999,'{}');`);
  const signature=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(key=>[key,body[key]])))).digest('hex');
  await db.query(`INSERT INTO cases VALUES(39,62,101,$1,$2,808,'Синтетический юрист','ООО Тест','Москва, Тестовая, 62','Общепит','Получение','обычный',$3)`,[body.submit_id,signature,JSON.stringify({_stage:'Сбор документов',_handoff:state})]);
  const query=async(sql,args)=>{await before(sql,args);const result=args?await db.query(sql,args):await db.exec(sql);await after(sql,args,result);return result;};
  const pool={query,async connect(){const identity=randomUUID();return{async query(sql,args){if(sql.startsWith('SELECT pg_try_advisory_lock')){const key=args[0],free=!locks.has(key)||locks.get(key)===identity;if(free)locks.set(key,identity);return{rows:[{locked:free}]};}if(sql.startsWith('SELECT pg_advisory_unlock')){if(locks.get(args[0])===identity)locks.delete(args[0]);return{rows:[]};}return query(sql,args);},release(){for(const[key,owner]of locks)if(owner===identity)locks.delete(key);}};}};
  const telegram={async sendMessage(chat,text,options){sends.push({chat,text,options});return send(sends.length);},sendDocument(){assert.fail('No group or private file resend');},callApi(){assert.fail('No copied package');}};
  const options={pool,telegram,clientsChatId:GROUP},publisher=()=>createHandoffNoticePublisher(options);
  const row=async()=>(await db.query('SELECT * FROM cases WHERE id=39')).rows[0];
  const saved=async()=>(await row()).data._handoff;
  const replace=async(next)=>{await db.query('UPDATE cases SET data=$1 WHERE id=39',[JSON.stringify({_stage:'Сбор документов',_handoff:next})]);};
  const apply=async(p,preview,messageId=201,extra={})=>p.apply(39,{actorId:101,messageId,expectedGeneration:preview.generation,expectedRevision:preview.revision,expectedTarget:preview.target,...extra});
  try{await run({db,pool,body,state,options,publisher,row,saved,replace,apply,sends,locks,setSend:fn=>{send=fn;},before:fn=>{before=fn;},after:fn=>{after=fn;}});}finally{await db.close();}
}
test('old completed case preview is SELECT-only and explicit apply publishes only one exact summary',pg,async()=>fixture(async h=>{
  h.before(sql=>assert.match(sql.trim(),/^SELECT/));const p=h.publisher(),preview=await p.preview(39,{actorId:101});h.before(async()=>{});
  assert.equal(preview.status,'missing');assert.equal(preview.generation,0);assert.equal(preview.can_apply,true);assert.equal(h.sends.length,0);assert.equal((await h.saved()).groupNotice,undefined);
  assert.match(preview.text,/^Клиент передан юристу/);assert.match(preview.text,/ООО Тест[\s\S]*Синтетический бренд[\s\S]*Тестовая, 62/);assert.match(preview.text,/Заявка #62 · Клиент #39/);assert.match(preview.text,/В работе у юриста: 2 клиентов$/);assert.doesNotMatch(preview.text,/баланс|оплат|Карина|7999/);
  const result=await h.apply(p,preview);assert.equal(result.state,'confirmed');assert.equal(h.sends.length,1);assert.equal(h.sends[0].text,preview.text);assert.equal(h.sends[0].chat,GROUP);assert.deepEqual(h.sends[0].options.reply_markup.inline_keyboard,[[{text:'Открыть клиента и отчёт',url:'https://t.me/LRSZamer_bot?start=case_39'}]]);
  const saved=await h.saved();assert.equal(saved.completed,true);assert.equal(saved.groupNotice.receipt.message_id,1700);assert.equal(saved.groupNotice.intent,null);
  assert.equal((await h.apply(h.publisher(),preview)).state,'replayed');assert.equal((await h.publisher().preview(39,{actorId:101})).can_apply,false);assert.equal(h.sends.length,1);
}));
test('partial, V1 or unavailable recipient cannot be announced as a completed private handoff',pg,async()=>fixture(async h=>{
  for(const change of [s=>{s.completed=false;},s=>{s.version=1;},s=>{s.manual_review='Unknown private ACK';},s=>{s.materials.completed=false;},s=>{s.egrn.completed=false;},s=>{s.recipients=[{chat:'999'}];}]){const state=structuredClone(h.state);change(state);await h.replace(state);const preview=await h.publisher().preview(39,{actorId:101});assert.equal(preview.can_apply,false);assert.equal((await h.apply(h.publisher(),preview,201)).state,'blocked');}
  assert.equal(h.sends.length,0);
}));
test('waiting EGRN is stated as future delivery and exact workload excludes archive and other lawyers',pg,async()=>fixture(async h=>{
  h.state.egrn.result='waiting';await h.replace(h.state);const preview=await h.publisher().preview(39,{actorId:101});assert.match(preview.text,/ЕГРН: ожидается/);assert.match(preview.text,/Отчёт и собранные материалы — в личке/);assert.doesNotMatch(preview.text,/весь комплект|баланс|оплат/i);
}));
test('known Telegram rejection can retry only the group summary while private completion stays true',pg,async()=>fixture(async h=>{
  h.setSend(n=>{if(n===1)throw Object.assign(new Error('Rejected'),{response:{error_code:400}});return{message_id:1701};});
  let p=h.publisher(),preview=await p.preview(39,{actorId:101});assert.equal((await h.apply(p,preview)).state,'rejected');assert.equal((await h.saved()).completed,true);
  p=h.publisher();preview=await p.preview(39,{actorId:101});assert.equal(preview.requires_confirmation,false);assert.equal((await h.apply(p,preview,202)).state,'confirmed');assert.equal(h.sends.length,2);assert.equal((await h.row()).id,39);
}));
for(const ack of [true,[1700],{message_id:true},{message_id:1700,chat:{id:'-100999'}},{message_id:10}])test('malformed/wrong-chat/reused ACK remains unknown: '+JSON.stringify(ack),pg,async()=>fixture(async h=>{
  h.options.clientsChatId='-1001234';h.setSend(()=>ack);const p=h.publisher(),preview=await p.preview(39,{actorId:101});assert.equal((await h.apply(p,preview)).state,'unknown');assert.equal((await h.saved()).completed,true);assert.ok((await h.saved()).groupNotice.intent);
  const fresh=await h.publisher().preview(39,{actorId:101});assert.equal(fresh.requires_confirmation,true);assert.equal((await h.apply(h.publisher(),fresh,202)).state,'unknown');assert.equal(h.sends.length,1);
}));
test('Telegram502 and a crashed durable intent never auto-send again; deliberate new confirmation can recover',pg,async()=>fixture(async h=>{
  h.setSend(n=>{if(n===1)throw Object.assign(new Error('Accepted but 502'),{response:{error_code:502}});return{message_id:1701};});
  let p=h.publisher(),preview=await p.preview(39,{actorId:101});assert.equal((await h.apply(p,preview)).state,'unknown');
  p=h.publisher();preview=await p.preview(39,{actorId:101});assert.equal((await h.apply(p,preview,201,{confirmMissing:true})).state,'replayed');assert.equal((await h.apply(p,preview,202)).state,'unknown');assert.equal(h.sends.length,1);
  preview=await p.preview(39,{actorId:101});assert.equal((await h.apply(p,preview,203,{confirmMissing:true})).state,'confirmed');assert.equal(h.sends.length,2);
}));
test('ACK followed by persistent database receipt failure leaves durable intent and private success across restart',pg,async()=>fixture(async h=>{
  h.before((sql,args)=>{if(sql===SAVE_CHECKPOINT_SQL&&h.sends.length)throw new Error('Receipt storage unavailable');});
  const p=h.publisher(),preview=await p.preview(39,{actorId:101});assert.equal((await h.apply(p,preview)).state,'unknown');h.before(async()=>{});
  const saved=await h.saved();assert.equal(saved.completed,true);assert.ok(saved.groupNotice.intent);assert.equal(saved.groupNotice.receipt==null,true);
  const submit=createHandoffSubmitter({...h.options,ready:async()=>{}}),result=await submit({body:{resume_case_id:39},user:{id:101},staff:{role:'manager',approved:true}});assert.equal(result.delivery_complete,true);assert.equal(result.manual_review,undefined);assert.match(result.warn,/чат.*не подтверждена/);assert.equal(h.sends.length,1);
}));
for(const kind of ['actor','recipient','role','owner'])test('fresh '+kind+' change after intent blocks group send',pg,async()=>fixture(async h=>{
  let changed=false;h.after(async(sql,args)=>{if(!changed&&sql===SAVE_CHECKPOINT_SQL&&JSON.parse(args[0]).groupNotice?.status==='sending'){changed=true;if(kind==='actor')await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=101');if(kind==='recipient')await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=808');if(kind==='role')await h.db.exec("UPDATE staff SET role='auditor' WHERE tg_id=808");if(kind==='owner')await h.db.exec('UPDATE cases SET lawyer_tg_id=999 WHERE id=39');}});
  const p=h.publisher(),preview=await p.preview(39,{actorId:101});assert.equal((await h.apply(p,preview)).state,'blocked');assert.equal(h.sends.length,0);assert.equal((await h.saved()).completed,true);
}));
test('busy admin cursor survives the live sender checkpoint and cannot authorize a later unknown after restart',pg,async()=>fixture(async h=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});h.setSend(async()=>{entered();await gate;throw Object.assign(new Error('Accepted but 502'),{response:{error_code:502}});});
  const a=h.publisher(),first=await a.preview(39,{actorId:101}),running=h.apply(a,first,200);await started;
  const b=h.publisher(),busyPreview=await b.preview(39,{actorId:102});const busy=await h.apply(b,busyPreview,300,{actorId:102,confirmMissing:true});assert.equal(busy.state,'busy');release();assert.equal((await running).state,'unknown');assert.equal((await h.saved()).groupNotice.cursors['102'],300);
  let next=await a.preview(39,{actorId:101});assert.equal((await h.apply(a,next,201,{confirmMissing:true})).state,'unknown');assert.equal(h.sends.length,2);
  const restart=h.publisher();next=await restart.preview(39,{actorId:102});assert.equal((await h.apply(restart,next,300,{actorId:102,confirmMissing:true})).state,'replayed');assert.equal(h.sends.length,2);
}));
test('completed submit holds lock111 throughout the group send and a concurrent resume keeps private success',pg,async()=>fixture(async h=>{
  h.state.groupNotice=initialNotice(GROUP);await h.replace(h.state);let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});h.setSend(async()=>{entered();await gate;return{message_id:1700};});
  const submit=()=>createHandoffSubmitter({...h.options,ready:async()=>{}})({body:{resume_case_id:39},user:{id:101},staff:{role:'manager',approved:true}});
  const first=submit();await started;assert.equal(h.locks.size,1);const busy=await submit();assert.equal(busy.delivery_complete,true);assert.equal(h.sends.length,1);release();assert.equal((await first).delivery_complete,true);assert.equal(h.locks.size,0);assert.equal((await submit()).delivery_complete,true);assert.equal(h.sends.length,1);
}));
test('old completed without registration is never auto-backfilled, and unset chat preserves completion',pg,async()=>fixture(async h=>{
  const context={body:{resume_case_id:39},user:{id:101},staff:{role:'manager',approved:true}};
  assert.equal((await createHandoffSubmitter({...h.options,ready:async()=>{}})(context)).delivery_complete,true);assert.equal(h.sends.length,0);assert.equal((await h.saved()).groupNotice,undefined);
  h.state.groupNotice=initialNotice(GROUP);await h.replace(h.state);assert.equal((await createHandoffSubmitter({...h.options,clientsChatId:'',ready:async()=>{}})(context)).delivery_complete,true);assert.equal(h.sends.length,0);
}));
test('stale target/content/generation and unseen commands consume cursor without posting',pg,async()=>fixture(async h=>{
  const p=h.publisher(),preview=await p.preview(39,{actorId:101});await h.db.query('UPDATE cases SET address=$1 WHERE id=39',['Changed reviewed address']);assert.equal((await h.apply(p,preview,200)).state,'stale');assert.equal((await h.saved()).groupNotice.cursors['101'],200);
  const next=await p.preview(39,{actorId:101});assert.equal((await h.apply(p,next,200,{confirmMissing:true})).state,'replayed');assert.equal((await p.apply(39,{actorId:101,messageId:201})).state,'stale');assert.equal((await h.saved()).groupNotice.cursors['101'],201);assert.equal(h.sends.length,0);
}));
test('actual private admin controller cannot replay an unseen old apply after restart against a later unknown',pg,async()=>fixture(async h=>{
  const ctx=(actor,messageId,text)=>({from:{id:actor},chat:{id:actor,type:'private'},message:{message_id:messageId,text},reply:async()=>({message_id:messageId+1000})});
  let commands=createHandoffNoticeAdmin({publisher:h.publisher(),adminIds:[101,102]});
  await commands.apply(ctx(102,300,'/handoff_notice_apply 39 confirm_missing'));assert.equal((await h.saved()).groupNotice.cursors['102'],300);assert.equal(h.sends.length,0);
  h.setSend(()=>{throw Object.assign(new Error('Accepted but 502'),{response:{error_code:502}});});
  await commands.preview(ctx(101,100,'/handoff_notice 39'));await commands.apply(ctx(101,101,'/handoff_notice_apply 39'));assert.equal(h.sends.length,1);
  commands=createHandoffNoticeAdmin({publisher:h.publisher(),adminIds:[101,102]});await commands.preview(ctx(102,299,'/handoff_notice 39'));await commands.apply(ctx(102,300,'/handoff_notice_apply 39 confirm_missing'));assert.equal(h.sends.length,1);assert.equal((await h.saved()).groupNotice.status,'unknown');
}));
test('checkpoint saves preserve busy cursors when a local notice is absent, null or a scalar',pg,async()=>fixture(async h=>{
  h.state.groupNotice={cursors:{102:300}};await h.replace(h.state);
  for(const value of [undefined,null,'invalid']){const next={...h.state,groupNotice:value};await h.pool.query(SAVE_CHECKPOINT_SQL,[JSON.stringify(next),39]);const saved=await h.saved();assert.equal(Array.isArray(saved.groupNotice),false);assert.equal(saved.groupNotice.cursors['102'],300);}
}));
