'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {createHandoffCompanyService,setupHandoffCompanyAdmin,TTL}=require('../src/bot/handoff-company-admin');
const pg={skip:!process.env.PGLITE_TEST_MODULE};
const hash=body=>createHash('sha256').update(JSON.stringify(body,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)).digest('hex');
async function fixture(run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),edits=[],locks=new Set();let rejectEdit=null,mutate=null;
  const pool={query:(q,p)=>db.query(q,p),async connect(){return{async query(q,p){if(q.includes('pg_try_advisory_lock')){const locked=!locks.has(p[0]);if(locked)locks.add(p[0]);return{rows:[{locked}]};}if(q.includes('pg_advisory_unlock')){locks.delete(p[0]);return{rows:[{}]};}return db.query(q,p);},release(){}};}};
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(101,'manager',true),(808,'lawyer',true),(809,'lawyer',true);
    CREATE TABLE cases(id INT PRIMARY KEY,org TEXT,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,created_by BIGINT,handoff_submit_id TEXT,handoff_signature TEXT,contacts JSONB,data JSONB,address TEXT,kind TEXT,service TEXT,region TEXT,priority TEXT,checklist_key TEXT);`);
  const body={org:'Кафе Тестовое',order_id:61,lawyer_tg_id:808,submit_id:randomUUID(),report_id:15,report_src:'a'};
  const state={version:2,body,fields:{org:body.org,cad_num:'77:01:0000000:1'},packet:{order:{org:body.org},report:{id:15,src:'a',text:'Исторический отчёт Кафе Тестовое'},materials:[]},completed:true,cards:{808:700},groupNotice:{target:'-100123',status:'confirmed',receipt:{chat_id:'-100123',message_id:701},text:'Клиент передан юристу\nОрганизация: Кафе Тестовое\nОбъект: Кафе Тестовое\nКлиент #44'},recipients:[{chat:'808',role:'lawyer'}]};
  await db.query("INSERT INTO cases VALUES(44,$1,61,808,'Тестовый юрист',101,$2,$3,'[]',$4,'Москва, Тестовая, 5','Общепит','Получение','МСК','обычный','MSK_OBSH')",[body.org,body.submit_id,hash(body),JSON.stringify({_handoff:state,_stage:'Сбор документов',note:'Не менять'})]);
  const telegram={sendMessage(){assert.fail('No new messages');},sendDocument(){assert.fail('No documents');},async editMessageText(chat,id,unused,text,extra){edits.push({chat,id,text,extra});if(rejectEdit)await rejectEdit({chat,id,text});if(mutate)await mutate({chat,id,text});return{message_id:id,chat:{id:chat}};}};
  const options={pool,telegram,adminIds:['101'],clientsChatId:'-100123',webappUrl:'https://bot.test'};
  const service=createHandoffCompanyService(options),row=async()=>(await db.query('SELECT * FROM cases WHERE id=44')).rows[0];
  try{await run({db,pool,service,options,edits,locks,row,state,setReject(fn){rejectEdit=fn;},setMutation(fn){mutate=fn;}});}finally{await db.close();}
}
test('company correction dry run is read-only; apply edits two acknowledged cards and preserves all source evidence',pg,()=>fixture(async h=>{
  const before=await h.row(),view=await h.service.preview(44,'ООО Тестовый лимон',101);assert.equal(view.old_org,before.org);assert.equal(view.new_org,'ООО Тестовый лимон');assert.equal(view.lawyer_id,'808');assert.equal(view.private_message_id,700);assert.equal(view.group_message_id,701);assert.deepEqual(await h.row(),before);assert.deepEqual(h.edits,[]);
  assert.deepEqual(await h.service.apply(view,101),{complete:true});const after=await h.row(),s=after.data._handoff;
  assert.equal(after.org,view.new_org);assert.equal(s.body.org,view.new_org);assert.equal(s.fields.org,view.new_org);assert.equal(after.handoff_signature,hash(s.body));assert.equal(after.data.note,before.data.note);assert.equal(after.data._stage,before.data._stage);assert.deepEqual(s.packet,before.data._handoff.packet);assert.deepEqual(s.cards,before.data._handoff.cards);assert.deepEqual(s.groupNotice.receipt,before.data._handoff.groupNotice.receipt);
  assert.deepEqual(h.edits.map(e=>[e.chat,e.id]),[['808',700],['-100123',701]]);assert.match(h.edits[0].text,/ООО Тестовый лимон/);assert.match(h.edits[1].text,/Организация: ООО Тестовый лимон\nОбъект: Кафе Тестовое/);assert.equal(s.companyCorrection.completed,true);assert.equal(h.locks.size,0);
  assert.deepEqual(await h.service.apply(await h.service.preview(44,view.new_org,101),101),{complete:true,unchanged:true});assert.equal(h.edits.length,2);
}));
for(const change of ['org','lawyer','approval','checkpoint'])test('company correction rejects stale '+change+' after preview without editing messages',pg,()=>fixture(async h=>{
  const view=await h.service.preview(44,'ООО Тестовый лимон',101);
  if(change==='org')await h.db.query("UPDATE cases SET org='Уже исправлено' WHERE id=44");
  if(change==='lawyer')await h.db.query('UPDATE cases SET lawyer_tg_id=809 WHERE id=44');
  if(change==='approval')await h.db.query('UPDATE staff SET approved=false WHERE tg_id=101');
  if(change==='checkpoint')await h.db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff,fields,cad_num}','\"другое\"') WHERE id=44");
  await assert.rejects(h.service.apply(view,101),{code:'HANDOFF_COMPANY_BLOCKED'});assert.deepEqual(h.edits,[]);assert.equal(h.locks.size,0);
}));
test('partial Telegram edit resumes the same group message without a new private card or document delivery',pg,()=>fixture(async h=>{
  h.setReject(e=>{if(e.chat==='-100123')throw new Error('Connection lost');});const view=await h.service.preview(44,'ООО Тестовый лимон',101),first=await h.service.apply(view,101);assert.equal(first.complete,false);let c=await h.row();assert.equal(c.org,'ООО Тестовый лимон');assert.equal(c.data._handoff.companyCorrection.private_updated,true);assert.equal(c.data._handoff.companyCorrection.group_updated,false);
  h.setReject(e=>{if(e.chat==='-100123')throw Object.assign(new Error('Already edited'),{response:{error_code:400,description:'Bad Request: message is not modified'}});});const restarted=createHandoffCompanyService(h.options);assert.deepEqual(await restarted.apply(await restarted.preview(44,'ООО Тестовый лимон',101),101),{complete:true});assert.deepEqual(h.edits.map(e=>e.id),[700,701,701]);assert.equal((await h.row()).data._handoff.companyCorrection.completed,true);
}));
test('current recipient access is rechecked between private and group edits',pg,()=>fixture(async h=>{
  const view=await h.service.preview(44,'ООО Тестовый лимон',101);h.setMutation(async e=>{if(e.chat==='808')await h.db.query('UPDATE staff SET approved=false WHERE tg_id=808');});assert.equal((await h.service.apply(view,101)).complete,false);assert.equal(h.edits.length,1);assert.equal((await h.row()).data._handoff.companyCorrection.completed,false);
}));
test('company correction refuses missing, uncertain or changed group receipts and unknown administrators',pg,()=>fixture(async h=>{
  await assert.rejects(h.service.preview(44,'ООО Новое',808),{code:'HANDOFF_COMPANY_BLOCKED'});
  for(const value of [{...h.state.groupNotice,status:'unknown'},{...h.state.groupNotice,receipt:null},{...h.state.groupNotice,target:'-100999'},{...h.state.groupNotice,text:'Непонятное сообщение'}]){
    await h.db.query("UPDATE cases SET data=jsonb_set(data,'{_handoff,groupNotice}',$1::jsonb) WHERE id=44",[JSON.stringify(value)]);await assert.rejects(h.service.preview(44,'ООО Новое',101),{code:'HANDOFF_COMPANY_BLOCKED'});
  }assert.deepEqual(h.edits,[]);
}));
test('admin company command needs a private, acknowledged, fresh preview and a later apply message',async()=>{
  let time=1000,denyReply=false;const calls=[],replies=[],commands=[];
  const view={case_id:44,old_org:'Бренд',new_org:'ООО Новое',lawyer_id:'808',lawyer_name:'Тестовый юрист',private_message_id:700,group_message_id:701,revision:'a'.repeat(64)};
  const opts={adminIds:[101,102],now:()=>time,service:{async preview(id,org,actor){calls.push(['preview',id,org,actor]);return view;},async apply(saved,actor){calls.push(['apply',saved,actor]);return{complete:true};}}};
  const control=setupHandoffCompanyAdmin({command(name){commands.push(name);}},opts);
  const ctx=(text,id=1,actor=101,type='private')=>({from:{id:actor},chat:{id:actor,type},message:{text,message_id:id},async reply(text){if(denyReply)throw new Error('reply lost');replies.push(text);}});
  await control.preview(ctx('/handoff_company 44 ООО Новое',1,999));await control.preview(ctx('/handoff_company 44 ООО Новое',1,101,'group'));assert.equal(calls.length,0);
  await control.apply(ctx('/handoff_company_apply 44',2));assert.equal(calls.length,0);
  await control.preview(ctx('/handoff_company 44 ООО Новое',3));assert.match(replies.at(-1),/Было: Бренд/);await control.apply(ctx('/handoff_company_apply 44',4,102));await control.apply(ctx('/handoff_company_apply 45',4));await control.apply(ctx('/handoff_company_apply 44',3));assert.equal(calls.length,1);
  await control.apply(ctx('/handoff_company_apply 44',4));assert.deepEqual(calls.at(-1),['apply',view,101]);await control.apply(ctx('/handoff_company_apply 44',5));assert.equal(calls.length,2);
  await control.preview(ctx('/handoff_company 44 ООО Новое',6));time+=TTL;await control.apply(ctx('/handoff_company_apply 44',7));assert.equal(calls.filter(c=>c[0]==='apply').length,1);
  assert.deepEqual(commands,['handoff_company','handoff_company_apply']);
});

test('company correction takes the handoff lock and refuses a different target name than previewed',pg,()=>fixture(async h=>{
  const view=await h.service.preview(44,'ООО Новое',101),before=await h.row(),key=before.created_by+':'+before.handoff_submit_id;
  await assert.rejects(h.service.apply({...view,new_org:'ООО Подмена'},101),{code:'HANDOFF_COMPANY_BLOCKED'});assert.deepEqual(await h.row(),before);
  h.locks.add(key);await assert.rejects(h.service.apply(view,101),{code:'HANDOFF_COMPANY_BLOCKED'});assert.deepEqual(await h.row(),before);assert.deepEqual(h.edits,[]);h.locks.clear();
}));
test('lost storage acknowledgement after an edit can only repeat editing the same private message',pg,()=>fixture(async h=>{
  const rawQuery=h.db.query.bind(h.db);let failed=false;
  h.db.query=async(q,p)=>{if(!failed&&q.startsWith('UPDATE cases SET data=')&&String(p?.[0]).includes('"private_updated":true')){failed=true;throw new Error('Synthetic save unavailable');}return rawQuery(q,p);};
  const first=await h.service.apply(await h.service.preview(44,'ООО Новое',101),101);assert.equal(first.complete,false);assert.deepEqual(h.edits.map(e=>e.id),[700]);assert.equal((await h.row()).data._handoff.companyCorrection.private_updated,false);
  const retry=await h.service.apply(await h.service.preview(44,'ООО Новое',101),101);assert.equal(retry.complete,true);assert.deepEqual(h.edits.map(e=>e.id),[700,700,701]);assert.equal(h.locks.size,0);
}));
test('invalid Telegram edit acknowledgement never marks the card updated or proceeds to the group',pg,()=>fixture(async h=>{
  const edit=h.options.telegram.editMessageText;h.options.telegram.editMessageText=async(...args)=>{await edit(...args);return{message_id:999,chat:{id:args[0]}};};
  assert.equal((await h.service.apply(await h.service.preview(44,'ООО Новое',101),101)).complete,false);assert.deepEqual(h.edits.map(e=>e.id),[700]);assert.equal((await h.row()).data._handoff.companyCorrection.private_updated,false);
}));
test('a failed preview reply cannot authorize an unseen correction',async()=>{
  let fail=true,applies=0;const commands=setupHandoffCompanyAdmin({command(){}},{adminIds:[101],service:{async preview(){return{case_id:44,old_org:'old',new_org:'new'};},async apply(){applies++;return{complete:true};}}});
  const ctx=text=>({from:{id:101},chat:{id:101,type:'private'},message:{text,message_id:text.startsWith('/handoff_company_apply')?2:1},async reply(){if(fail)throw new Error('Synthetic reply failure');}});
  await assert.rejects(commands.preview(ctx('/handoff_company 44 new')),/reply failure/);fail=false;await commands.apply(ctx('/handoff_company_apply 44'));assert.equal(applies,0);
});
