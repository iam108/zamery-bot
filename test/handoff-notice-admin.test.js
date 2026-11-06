'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHandoffNoticeAdmin,setupHandoffNoticeAdmin,PREVIEW_TTL,MAX_PREVIEWS}=require('../src/bot/handoff-notice-admin');
function fixture(){
  let time=1000,admins=[108],snapshot={},result={state:'confirmed',warning:'Уведомление опубликовано.'},previewWait,applyWait,failReply=false,previewError,applyError;
  const previews=[],applies=[],replies=[];
  const publisher={async preview(id,context){previews.push({id,context});if(previewError)throw previewError;if(previewWait)await previewWait;return {case_id:id,generation:0,revision:'a'.repeat(64),target:'-100123',text:'Клиент #'+id+' передан юристу.\nИП Тест · Чанг\nАдрес: Москва, тестовый адрес\nhttps://t.me/LRSZamer_bot?start=case_'+id,status:'missing',can_apply:true,requires_confirmation:false,...snapshot};},
    async apply(id,context){applies.push({id,context});if(applyWait)await applyWait;if(applyError)throw applyError;return context.expectedGeneration==null?{state:'stale',warning:'Нужен новый просмотр.'}:result;}};
  const options={publisher,adminIds:()=>admins,now:()=>time},create=()=>createHandoffNoticeAdmin(options);
  const ctx=(text='/handoff_notice 39',message_id=100,actor=108,changes={})=>({from:{id:actor},chat:{id:actor,type:'private'},message:{text,message_id},async reply(text,extra){if(failReply)throw new Error('Private preview ACK lost');replies.push({text,extra});},...changes});
  return{publisher,options,create,ctx,previews,applies,replies,get authorized(){return applies.filter(call=>call.context.expectedGeneration!=null);},set snapshot(v){snapshot=v;},set result(v){result=v;},set admins(v){admins=v;},set time(v){time=v;},set previewWait(v){previewWait=v;},set applyWait(v){applyWait=v;},set failReply(v){failReply=v;},set previewError(v){previewError=v;},set applyError(v){applyError=v;}};
}
test('setup lazily registers only the two text commands without source work or callbacks',()=>{
  const registered=[];setupHandoffNoticeAdmin({command(name,handler){registered.push([name,typeof handler]);},action(){assert.fail('No callback controls');}},{publisher:{preview(){assert.fail('No startup preview');},apply(){assert.fail('No startup publication');}}});
  assert.deepEqual(registered,[['handoff_notice','function'],['handoff_notice_apply','function']]);
});
test('only configured private administrators may preview or apply, with no ordinary manager fallback',async()=>{
  const h=fixture(),commands=h.create();for(const c of [h.ctx(undefined,100,109,{staff:{role:'manager',approved:true}}),h.ctx(undefined,100,108,{chat:{id:-1001,type:'supergroup'}}),h.ctx(undefined,100,108,{chat:{id:-1001,type:'group'}})]){await commands.preview(c);await commands.apply({...c,message:{text:'/handoff_notice_apply 39',message_id:101}});}
  h.admins=[];await commands.preview(h.ctx());assert.deepEqual(h.previews,[]);assert.deepEqual(h.applies,[]);assert.deepEqual(h.replies,[]);
});
test('preview displays the exact plaintext group text and apply forwards only its frozen identity and the requesting actor',async()=>{
  const h=fixture(),commands=h.create();await commands.preview(h.ctx('/handoff_notice@LRSZamer_bot 39'));
  assert.equal(h.replies.length,2);assert.match(h.replies[0].text,/Чат: -100123/);assert.match(h.replies[0].text,/Статус: missing/);assert.match(h.replies[0].text,/\/handoff_notice_apply 39/);assert.doesNotMatch(h.replies[0].text,/a{64}|generation|revision/);
  assert.equal(h.replies[1].text,(await h.publisher.preview(39,{})).text);assert.equal(h.replies[1].extra.parse_mode,undefined);
  await commands.apply(h.ctx('/handoff_notice_apply 39',101));assert.deepEqual(h.applies,[{id:39,context:{actorId:108,messageId:101,expectedGeneration:0,expectedRevision:'a'.repeat(64),expectedTarget:'-100123',confirmMissing:false}}]);
  await commands.apply(h.ctx('/handoff_notice_apply 39',102));assert.equal(h.authorized.length,1);assert.match(h.replies.at(-1).text,/Нет актуального/);
});
test('unknown delivery requires literal duplicate-risk confirmation after a check-chat preview',async()=>{
  const h=fixture(),commands=h.create();h.snapshot={generation:2,status:'unknown',requires_confirmation:true,warning:'Ответ Telegram не подтверждён.'};await commands.preview(h.ctx());assert.match(h.replies[0].text,/проверьте чат/);assert.match(h.replies[0].text,/дубликат/);assert.match(h.replies[0].text,/confirm_missing/);
  for(const text of ['/handoff_notice_apply 39','/handoff_notice_apply 39 CONFIRM_MISSING','/handoff_notice_apply 39 yes'])await commands.apply(h.ctx(text,101));assert.equal(h.authorized.length,0);
  await commands.apply(h.ctx('/handoff_notice_apply 39 confirm_missing',102));assert.equal(h.authorized[0].context.confirmMissing,true);assert.equal(h.authorized[0].context.expectedGeneration,2);
});
test('expired, restarted, cross-user, cross-case or unseen previews cannot authorize a publication',async()=>{
  const h=fixture(),commands=h.create();h.admins=[108,109];await commands.apply(h.ctx('/handoff_notice_apply 39',101));await commands.preview(h.ctx());
  for(const c of [h.ctx('/handoff_notice_apply 40',101),h.ctx('/handoff_notice_apply 39',100),h.ctx('/handoff_notice_apply 39',101,109),h.ctx('/handoff_notice_apply 39',101,108,{chat:{id:999,type:'private'}})])await commands.apply(c);
  await h.create().apply(h.ctx('/handoff_notice_apply 39',101));h.time=1000+PREVIEW_TTL;await commands.apply(h.ctx('/handoff_notice_apply 39',102));assert.equal(h.authorized.length,0);
});
test('failed private preview acknowledgement leaves no unseen authorization',async()=>{
  const h=fixture(),commands=h.create();h.failReply=true;await assert.rejects(commands.preview(h.ctx()),/ACK lost/);h.failReply=false;await commands.apply(h.ctx('/handoff_notice_apply 39',101));assert.equal(h.authorized.length,0);
});
test('valid apply messages rejected for absent views or missing confirmation still consume a publisher cursor without reviewed identity',async()=>{
  const h=fixture(),commands=h.create();await commands.apply(h.ctx('/handoff_notice_apply 39 confirm_missing',101));assert.deepEqual(h.applies,[{id:39,context:{actorId:108,messageId:101}}]);assert.equal(h.authorized.length,0);
  h.snapshot={status:'unknown',requires_confirmation:true};await commands.preview(h.ctx('/handoff_notice 39',102));await commands.apply(h.ctx('/handoff_notice_apply 39',103));assert.deepEqual(h.applies.at(-1),{id:39,context:{actorId:108,messageId:103}});assert.equal(h.authorized.length,0);
  await commands.apply(h.ctx('/handoff_notice_apply 39 confirm_missing',104));assert.equal(h.authorized.length,1);
});
test('a newer slow-safe preview supersedes an older case, and old preview updates cannot replace it',async()=>{
  const h=fixture(),commands=h.create();let release;h.previewWait=new Promise(r=>release=r);const old=commands.preview(h.ctx());await new Promise(setImmediate);h.previewWait=null;
  await commands.preview(h.ctx('/handoff_notice 40',102));release();await old;assert.equal(h.replies.length,2);assert.match(h.replies[0].text,/#40/);
  await commands.preview(h.ctx('/handoff_notice 39',100));await commands.apply(h.ctx('/handoff_notice_apply 40',103));assert.equal(h.authorized[0].id,40);
});
test('all nonbusy apply states invalidate the preview before a new attempt or a lost private result ACK',async()=>{
  for(const state of ['confirmed','unknown','rejected','blocked','stale','replayed']){const h=fixture(),commands=h.create();await commands.preview(h.ctx());h.result={state,warning:'Состояние '+state};await commands.apply(h.ctx('/handoff_notice_apply 39',101));await commands.apply(h.ctx('/handoff_notice_apply 39',102));assert.equal(h.authorized.length,1,state);}
  const h=fixture(),commands=h.create();await commands.preview(h.ctx());h.failReply=true;await assert.rejects(commands.apply(h.ctx('/handoff_notice_apply 39',101)),/ACK lost/);h.failReply=false;await commands.apply(h.ctx('/handoff_notice_apply 39',102));assert.equal(h.authorized.length,1);
});
test('publisher busy retains only the old reviewed generation and a stale result requires a fresh view',async()=>{
  const h=fixture(),commands=h.create();await commands.preview(h.ctx());h.result={state:'busy',warning:'Передача уже выполняется.'};await commands.apply(h.ctx('/handoff_notice_apply 39',101));h.result={state:'stale',warning:'Передача изменилась.'};await commands.apply(h.ctx('/handoff_notice_apply 39',102));assert.equal(h.authorized.length,2);assert.equal(h.authorized[1].context.expectedGeneration,0);await commands.apply(h.ctx('/handoff_notice_apply 39',103));assert.equal(h.authorized.length,2);
});
test('valid concurrent apply commands reach the publisher with the same frozen generation, including its busy cursor receipt',async()=>{
  const h=fixture(),commands=h.create();await commands.preview(h.ctx());let release;const gate=new Promise(r=>release=r);let count=0;
  h.publisher.apply=async(id,context)=>{h.applies.push({id,context});if(++count===1){await gate;return{state:'unknown',warning:'Ответ не подтверждён.'};}return{state:'busy',warning:'Публикация выполняется.'};};
  const first=commands.apply(h.ctx('/handoff_notice_apply 39',101));await new Promise(setImmediate);await commands.apply(h.ctx('/handoff_notice_apply 39',102));assert.equal(h.authorized.length,2);assert.equal(h.authorized[1].context.messageId,102);assert.equal(h.authorized[1].context.expectedGeneration,0);
  const before=h.previews.length;await commands.preview(h.ctx('/handoff_notice 39',103));assert.equal(h.previews.length,before);release();await first;await commands.apply(h.ctx('/handoff_notice_apply 39',102));assert.equal(h.authorized.length,2);
});
test('confirmed or blocked preview states do not expose an apply path',async()=>{
  for(const status of ['confirmed','blocked']){const h=fixture(),commands=h.create();h.snapshot={status,can_apply:false};await commands.preview(h.ctx());assert.doesNotMatch(h.replies[0].text,/\/handoff_notice_apply/);await commands.apply(h.ctx('/handoff_notice_apply 39',101));assert.equal(h.authorized.length,0);}
});
test('malformed IDs and response identities never authorize a different target or case',async()=>{
  const h=fixture(),commands=h.create();for(const value of ['0','-1','1.5','2147483648','39;DELETE'])await commands.preview(h.ctx('/handoff_notice '+value));assert.equal(h.previews.length,0);
  for(const change of [{case_id:40},{generation:-1},{revision:'unsafe'},{target:'108'},{target:'https://evil.invalid'},{status:'confirmed',can_apply:true},{status:'unknown',requires_confirmation:false},{text:'x'.repeat(3001)}]){h.snapshot=change;await commands.preview(h.ctx('/handoff_notice 39',101));await commands.apply(h.ctx('/handoff_notice_apply 39',102));}assert.equal(h.authorized.length,0);
});
test('unknown publisher errors are redacted and never claim that an ambiguous apply did not send',async()=>{
  const h=fixture(),commands=h.create();h.previewError=Object.assign(new Error('TOKEN=PRIVATE CLIENT SECRET'),{code:'HANDOFF_NOTICE_UNAVAILABLE'});await commands.preview(h.ctx());assert.doesNotMatch(h.replies.at(-1).text,/PRIVATE|TOKEN/);h.previewError=null;await commands.preview(h.ctx('/handoff_notice 39',102));h.applyError=new Error('PRIVATE provider URL');await commands.apply(h.ctx('/handoff_notice_apply 39',103));assert.match(h.replies.at(-1).text,/Проверьте чат/);assert.doesNotMatch(h.replies.at(-1).text,/PRIVATE|URL|Ничего не отправлялось/);
});
test('preview admission is bounded and expired entries release room',async()=>{
  const h=fixture(),commands=h.create();h.admins=Array.from({length:MAX_PREVIEWS+1},(_,i)=>i+1);for(const actor of h.options.adminIds().slice(0,MAX_PREVIEWS))await commands.preview(h.ctx('/handoff_notice 39',100,actor));await commands.preview(h.ctx('/handoff_notice 39',100,MAX_PREVIEWS+1));assert.equal(h.previews.length,MAX_PREVIEWS);assert.match(h.replies.at(-1).text,/слишком много/);
  h.time=1000+PREVIEW_TTL;await commands.preview(h.ctx('/handoff_notice 39',101,MAX_PREVIEWS+1));assert.equal(h.previews.length,MAX_PREVIEWS+1);
});
