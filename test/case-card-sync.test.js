'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCaseCardSync,UI_VERSION,MAX_CASES}=require('../src/bot/case-card-sync');
const {cardOptions}=require('../src/web/handoff-submit');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:20000};
const initial=()=>({version:2,completed:true,body:{order_id:62,report_id:15,report_src:'a'},packet:{report:{id:15,src:'a',video_url:'https://disk.yandex.ru/i/video'},archive_url:'https://disk.yandex.ru/d/archive'},recipients:[{chat:'808',role:'lawyer'}],cards:{808:6000}});
const failure=(code,description)=>Object.assign(new Error(description),{response:{error_code:code,description}});
async function fixture(run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),calls=[],pauses=[];let beforeQuery=async()=>{},edit=async()=>{};
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);
    CREATE TABLE cases(id INT PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,checklist_key TEXT,data JSONB);
    INSERT INTO staff VALUES(808,'lawyer',true),(909,'lawyer',true),(101,'manager',true);`);
  const put=async(state=initial(),id=39,change={})=>db.query('INSERT INTO cases VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET order_id=$2,lawyer_tg_id=$3,checklist_key=$4,data=$5',[id,Object.hasOwn(change,'order_id')?change.order_id:62,change.lawyer_tg_id??808,change.checklist_key??'MSK_OBSH',JSON.stringify({_stage:'Сбор документов',_comment:'Keep note',_handoff:state})]);
  await put();
  const pool={async query(sql,params){await beforeQuery(sql,params);return db.query(sql,params);}};
  const telegram=new Proxy({async editMessageReplyMarkup(...args){calls.push(args);const result=await edit(...args);return result===undefined?{message_id:args[1],chat:{id:Number(args[0]),type:'private'}}:result;}},{get(obj,key){if(key in obj)return obj[key];assert.fail('Sync may only edit an existing keyboard: '+String(key));}});
  const options={pool,telegram,cardOptions,webappUrl:'https://bot.example',pause:async ms=>{pauses.push(ms);}};
  try{await run({db,calls,pauses,pool,options,put,create:(extra={})=>createCaseCardSync({...options,...extra}),read:async(id=39)=>(await db.query('SELECT * FROM cases WHERE id=$1',[id])).rows[0],before(fn){beforeQuery=fn;},onEdit(fn){edit=fn;}});}finally{await db.close();}
}

test('repairs the existing private card in place with adjacent buttons and preserves video, archive and checklist data',pg,()=>fixture(async h=>{
  const result=await h.create()();assert.deepEqual(result,{examined:1,updated:1,unchanged:0,skipped:0,failed:0});
  assert.equal(h.calls.length,1);const [chat,messageId,inlineId,markup]=h.calls[0];assert.equal(chat,'808');assert.equal(messageId,6000);assert.equal(inlineId,undefined);
  assert.deepEqual(markup.inline_keyboard[0].map(b=>b.text),['📋 Чек-лист клиента','Перейти к отчёту']);
  assert.ok(markup.inline_keyboard.flat().some(b=>b.url==='https://disk.yandex.ru/i/video'));
  assert.ok(markup.inline_keyboard.flat().some(b=>b.url==='https://disk.yandex.ru/d/archive'));
  const link=new URL(markup.inline_keyboard[0][1].web_app.url);assert.equal(link.searchParams.get('report_id'),'15');assert.equal(link.searchParams.get('report_src'),'a');assert.equal(link.searchParams.get('order_id'),'62');assert.equal(link.searchParams.has('u'),false);assert.equal(link.searchParams.has('k'),false);
  const row=await h.read();assert.equal(row.data._handoff.card_ui_version,UI_VERSION);assert.equal(row.data._comment,'Keep note');assert.equal(row.data._stage,'Сбор документов');assert.deepEqual(row.data._handoff.cards,{808:6000});
  assert.equal((await h.create()()).examined,0);assert.equal(h.calls.length,1);
}));

test('no-order and imported reports use their exact saved selection instead of a fabricated latest audit',pg,()=>fixture(async h=>{
  const state=initial();state.body={order_id:null,report_id:25,report_src:'r'};state.packet.report={id:25,src:'r'};await h.put(state,39,{order_id:null});
  assert.equal((await h.create()()).updated,1);const url=new URL(h.calls[0][3].inline_keyboard[0][1].web_app.url);assert.equal(url.searchParams.get('case_id'),'39');assert.equal(url.searchParams.get('report_src'),'r');assert.equal(url.searchParams.get('report_id'),'25');assert.equal(url.searchParams.has('order_id'),false);
}));

test('partial, unknown, manual, mismatched and missing-receipt handoffs do not trigger a Telegram edit',pg,()=>fixture(async h=>{
  const variants=[{}, {...initial(),version:1},{...initial(),completed:false},{...initial(),inflight:{type:'card'}},{...initial(),manual_review:'Unknown delivery'},
    {...initial(),cards:{}},{...initial(),cards:{808:0}},{...initial(),cards:{808:'6&bad'}},{...initial(),recipients:[{chat:'909',role:'lawyer'}]},
    {...initial(),recipients:[{chat:'808',role:'lawyer'},{chat:'101',role:'manager'}]},
    {...initial(),body:{order_id:63,report_id:15,report_src:'a'}},
    {...initial(),body:{order_id:62,report_id:15,report_src:'r'}},
    {...initial(),body:{order_id:62,report_id:2147483648,report_src:'a'},packet:{report:{id:2147483648,src:'a'}}},
    {...initial(),body:{manual_client:true,order_id:null,report_id:null,report_src:null},packet:{report:null}}];
  for(const state of variants){await h.put(state);await h.create()();assert.equal(h.calls.length,0);assert.equal((await h.read()).data._handoff.card_ui_version,undefined);}
}));

test('assignment, approval and role are rechecked after the candidate scan before editing',pg,()=>fixture(async h=>{
  for(const change of ["UPDATE cases SET lawyer_tg_id=909 WHERE id=39","UPDATE staff SET approved=false WHERE tg_id=808","UPDATE staff SET role='auditor' WHERE tg_id=808"]){
    await h.put();await h.db.exec("UPDATE staff SET approved=true,role='lawyer' WHERE tg_id=808");
    let once=false;h.before(async sql=>{if(!once&&sql.startsWith('SELECT c.id,c.order_id')){once=true;await h.db.exec(change);}});
    const result=await h.create()();assert.equal(result.skipped,1);assert.equal(result.updated,0);assert.equal(h.calls.length,0);
  }
}));

test('a changed report receipt during editing is not marked synced, while unrelated new notes survive',pg,()=>fixture(async h=>{
  h.onEdit(async()=>{await h.db.query("UPDATE cases SET data=jsonb_set(jsonb_set(data,'{_comment}','\"Typed meanwhile\"'),'{_handoff,cards,808}', '7000') WHERE id=39");});
  const result=await h.create()();assert.equal(result.skipped,1);const row=await h.read();assert.equal(row.data._handoff.card_ui_version,undefined);assert.equal(row.data._handoff.cards['808'],7000);assert.equal(row.data._comment,'Typed meanwhile');
  h.onEdit(async()=>{await h.db.query("UPDATE cases SET data=jsonb_set(data,'{_comment}','\"New note\"') WHERE id=39");});
  assert.equal((await h.create()()).updated,1);assert.equal((await h.read()).data._comment,'New note');assert.equal(h.calls[1][1],7000);
}));

test('revocation during an acknowledged edit does not mark the revoked current state as synced',pg,()=>fixture(async h=>{
  h.onEdit(async()=>{await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');});
  assert.equal((await h.create()()).skipped,1);assert.equal((await h.read()).data._handoff.card_ui_version,undefined);
}));

test('lost Telegram acknowledgment retries the same edit and not-modified confirms it without another message',pg,()=>fixture(async h=>{
  h.onEdit(async()=>{throw new Error('ACK lost after keyboard edited');});assert.equal((await h.create()()).failed,1);assert.equal((await h.read()).data._handoff.card_ui_version,undefined);
  h.onEdit(async()=>{throw failure(400,'Bad Request: message is not modified');});assert.equal((await h.create()()).unchanged,1);assert.equal((await h.read()).data._handoff.card_ui_version,UI_VERSION);
  assert.deepEqual(h.calls[0],h.calls[1]);
}));

test('deleted and forbidden cards are skipped, while rate limits and unknown failures remain retryable',pg,()=>fixture(async h=>{
  for(const [code,description,stat] of [[400,'Bad Request: message to edit not found','skipped'],[400,"Bad Request: message can't be edited",'skipped'],[403,'Forbidden: bot was blocked','skipped'],[429,'Too Many Requests','failed'],[500,'Synthetic server error','failed']]){
    h.onEdit(async()=>{throw failure(code,description);});assert.equal((await h.create()())[stat],1);assert.equal((await h.read()).data._handoff.card_ui_version,undefined);
  }
}));

test('failure recording a confirmed edit is recoverable through a not-modified retry',pg,()=>fixture(async h=>{
  h.before(async sql=>{if(sql.startsWith('UPDATE cases c SET data=jsonb_set'))throw new Error('Synthetic DB unavailable');});
  assert.equal((await h.create()()).failed,1);assert.equal((await h.read()).data._handoff.card_ui_version,undefined);
  h.before(async()=>{});h.onEdit(async()=>{throw failure(400,'message is not modified');});assert.equal((await h.create()()).unchanged,1);
}));

test('an empty, inline-only or wrong-card Telegram response never marks a private card as updated',pg,()=>fixture(async h=>{
  for(const receipt of [null,false,true,{}, {message_id:6001,chat:{id:808}}, {message_id:6000,chat:{id:909}}, {message_id:6000}]){
    h.onEdit(async()=>receipt);const result=await h.create()();assert.equal(result.failed,1);assert.equal(result.updated,0);assert.equal((await h.read()).data._handoff.card_ui_version,undefined);
  }
}));

test('bounded batches can continue next invocation and simultaneous invocations share one run',pg,()=>fixture(async h=>{
  await h.put(initial(),40);await h.put(initial(),41);let release,entered;const wait=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
  h.onEdit(async()=>{entered();await wait;});const sync=h.create({limit:2}),first=sync();await ready;const second=sync();assert.equal(first,second);release();
  assert.equal((await first).updated,2);assert.equal(h.calls.length,2);assert.deepEqual(h.pauses,[150]);assert.equal((await sync()).updated,1);assert.equal(h.calls.length,3);
  const batch=(await h.db.query("SELECT COUNT(*)::int AS count FROM cases WHERE data#>'{_handoff,card_ui_version}'=$1::jsonb",[JSON.stringify(UI_VERSION)])).rows[0];assert.equal(batch.count,3);assert.equal(MAX_CASES,50);
}));

test('access is checked again after the pacing delay before the next edit',pg,()=>fixture(async h=>{
  await h.put(initial(),40);
  const result=await h.create({pause:async()=>{await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');}})();
  assert.equal(result.updated,1);assert.equal(result.skipped,1);assert.equal(h.calls.length,1);assert.equal((await h.read(40)).data._handoff.card_ui_version,undefined);
}));

test('an unresponsive Telegram edit reaches a deadline without marking success or blocking the next card',pg,()=>fixture(async h=>{
  await h.put(initial(),40);let first=true;h.onEdit(async()=>{if(first){first=false;await new Promise(()=>{});}});
  const result=await h.create({editTimeoutMs:20})();assert.equal(result.failed,1);assert.equal(result.updated,1);assert.equal(h.calls.length,2);assert.equal((await h.read()).data._handoff.card_ui_version,undefined);assert.equal((await h.read(40)).data._handoff.card_ui_version,UI_VERSION);
}));
