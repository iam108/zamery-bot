import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore,hash} from './state.mjs';
import {REGISTRY_HEADERS} from './google.mjs';
import {normalizeAddress} from './core.mjs';
import {convertOwnerUpdate} from './contact-reply-input.mjs';
import {renderNotification} from './notifier.mjs';
import {ContactReplyWorker} from './contact-reply-worker.mjs';

const OWNER='123456',BOT='999888';const INN='9721255266';
const ADDRESS='Москва, пер. Большой Толмачёвский, д. 5, стр. 4';
const IDENTITY=[INN,normalizeAddress(ADDRESS),'77РПО0021046','2026-04-17','2029-04-16'];
const ROW_KEY=hash(IDENTITY),REVIEW=hash([ROW_KEY,'contact_source_ambiguous']);
const CONTACT='Имя: Анна Иванова\nТелефон: +79990000001';
const valuesRow=()=>{
  const row=Array(17).fill('');Object.assign(row,{0:'PRIVATE_LINK',4:'ООО Свертэ',6:INN,7:IDENTITY[2],8:IDENTITY[3],9:IDENTITY[4],
    10:'Общепит ',11:ADDRESS,15:'keep@example.test',16:'LEGAL NOTE'});return row;
};
async function fixture(t,{duplicates=false,existing=false}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'contact-reply-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createStore(path.join(directory,'state.json'));const values=[[...REGISTRY_HEADERS],valuesRow()];
  if(existing)Object.assign(values[1],{12:'Иван Иванов',13:'+79991234567',14:'https://t.me/existing_client'});
  if(duplicates)values.push(structuredClone(values[1]));
  let now=Date.parse('2026-11-05T09:00:00Z'),counter=10,messageCounter=1000;
  const notification={type:'contact_review_required',jobId:REVIEW.slice(0,24),organization:'ООО Свертэ',code:'contact_source_ambiguous'};
  await store.update((state)=>{
    state.contacts={records:{},reviews:{[REVIEW]:{id:REVIEW,rowKey:ROW_KEY,status:'review',inn:INN,organization:'ООО Свертэ',code:'contact_source_ambiguous'}}};
    state.runtime={notifications:{legacy:{event:notification,status:'sent',destinationHash:hash(OWNER)}}};
    state.telegram={offset:0,inbox:[],ownerInbox:[]};
  });
  const sent=[],callbacks=[],batches=[],logs=[],controls={};
  const google={spreadsheetId:'manual-fixture',sheetName:'Реестр лицензий',sheetId:0,now:()=>new Date(now),
    async context(){if(controls.contextFail)throw new Error('PRIVATE Google failure');return {values:structuredClone(values),startRow:1};},
    async readRow(number){
      if(controls.readFail)throw new Error('PRIVATE read failure');
      return (values[number-1]??[]).map((value)=>value===''?{}:{formattedValue:String(value),userEnteredValue:{stringValue:String(value)}});
    },
    async request(suffix,{body}){
      assert.equal(suffix,':batchUpdate');
      const state=await store.read();
      assert.ok(Object.values(state.contactReplies.sessions).some((session)=>session.status==='planned'&&session.plan?.hash&&session.writeAttempted));
      if(controls.beforeBatch)await controls.beforeBatch(body);
      batches.push(structuredClone(body));
      for(const item of body.requests){
        const change=item.updateCells;assert.ok([12,13,14].includes(change.start.columnIndex));
        assert.equal(change.fields,'userEnteredValue');
        values[change.start.rowIndex][change.start.columnIndex]=change.rows[0].values[0].userEnteredValue.stringValue;
      }
      if(controls.afterBatch)await controls.afterBatch();return {};
    }};
  const telegram={async call(method,params){
    if(method==='answerCallbackQuery'){callbacks.push(structuredClone(params));return true;}
    assert.equal(method,'sendMessage');assert.equal(params.chat_id,OWNER);
    if(controls.sendFail)throw new Error('PRIVATE Telegram token URL');
    const result={message_id:messageCounter++,chat:{id:Number(OWNER),type:'private'},from:{id:Number(BOT),is_bot:true}};
    sent.push({...structuredClone(params),result});return result;
  }};
  const config={store,google,telegram,ownerChatId:OWNER,botId:BOT,now:()=>new Date(now),log:(entry)=>logs.push(entry)};
  const add=async(raw)=>{
    const event=convertOwnerUpdate(raw,{ownerChatId:OWNER,botId:BOT});assert.ok(event);
    await store.update((state)=>state.telegram.ownerInbox.push({updateId:raw.update_id,event,receivedAt:new Date(now).toISOString()}));return event;
  };
  const reply=async(text=CONTACT,{messageId=300+counter,replyTo=500,replyText=renderNotification(notification),contact}={})=>{
    const id=counter++;return add({update_id:id,message:{message_id:messageId,date:Math.floor(now/1000),chat:{id:Number(OWNER),type:'private'},
      from:{id:Number(OWNER),is_bot:false},text,...(contact?{contact}:{}),reply_to_message:{message_id:replyTo,text:replyText,from:{id:Number(BOT),is_bot:true}}}});
  };
  const callback=async(data,message=sent.at(-1))=>add({update_id:counter++,callback_query:{id:`callback-${counter}`,data,from:{id:Number(OWNER),is_bot:false},
    message:{message_id:message.result.message_id,date:Math.floor(now/1000),text:message.text,chat:{id:Number(OWNER),type:'private'},from:{id:Number(BOT),is_bot:true}}}});
  return {store,values,google,telegram,controls,sent,callbacks,batches,logs,config,reply,callback,
    worker:()=>new ContactReplyWorker(config),advance:(ms)=>{now+=ms;}};
}
const sessions=async(h)=>Object.values((await h.store.read()).contactReplies.sessions);

test('reply to a legacy review fills blank contact cells through a durable plan and verified receipt, then deduplicates after restart',async(t)=>{
  const h=await fixture(t);const event=await h.reply(`${CONTACT}\nTelegram: @anna_client`);
  const before=h.values[1].slice();assert.equal((await h.worker().tick()).saved,1);
  assert.deepEqual(h.values[1].slice(12,15),['Анна Иванова','+79990000001','https://t.me/anna_client']);
  for(let index=0;index<17;index++)if(![12,13,14].includes(index))assert.equal(h.values[1][index],before[index]);
  const state=await h.store.read(),session=Object.values(state.contactReplies.sessions)[0];
  assert.equal(session.status,'done');assert.equal(session.receipt.planHash,session.plan.hash);
  assert.equal(state.contacts.reviews[REVIEW].status,'resolved');assert.equal(state.api.attemptedCalls,0);assert.equal(Object.keys(state.jobs).length,0);
  assert.equal(state.telegram.ownerInbox.length,0);assert.equal(h.batches.length,1);
  assert.equal(state.contactReplies.messageIndex[String(h.sent[0].result.message_id)],session.id);
  assert.equal(h.sent[0].reply_parameters.message_id,event.messageId);
  await h.store.update((current)=>current.telegram.ownerInbox.push({updateId:event.updateId,event}));
  await h.worker().tick();assert.equal(h.batches.length,1);assert.equal(h.sent.length,1);
  assert.doesNotMatch(JSON.stringify(h.logs),/Анна|79990000001|PRIVATE/u);
});

test('nonempty contacts require explicit replacement, preserve omitted Telegram, and cannot be confirmed twice',async(t)=>{
  const h=await fixture(t,{existing:true});await h.reply();await h.worker().tick();
  const [session]=await sessions(h);assert.equal(session.status,'awaiting_replace');assert.equal(h.batches.length,0);
  const preview=h.sent.at(-1);assert.match(preview.text,/https:\/\/t.me\/existing_client \(сохраняется\)/u);
  assert.deepEqual(preview.reply_markup.inline_keyboard[0].map((button)=>button.text),['Заменить','Отмена']);
  await h.callback(`cr:${session.id}:replace`,preview);assert.equal((await h.worker().tick()).saved,1);
  assert.deepEqual(h.values[1].slice(12,15),['Анна Иванова','+79990000001','https://t.me/existing_client']);
  assert.equal(h.batches[0].requests.length,2);
  await h.callback(`cr:${session.id}:replace`,preview);await h.worker().tick();assert.equal(h.batches.length,1);
});

test('cancel leaves the review open and never writes or accepts a later replacement click',async(t)=>{
  const h=await fixture(t,{existing:true});await h.reply();await h.worker().tick();
  const [session]=await sessions(h),preview=h.sent.at(-1);
  await h.callback(`cr:${session.id}:cancel`,preview);await h.worker().tick();
  assert.equal((await sessions(h))[0].status,'cancelled');assert.equal((await h.store.read()).contacts.reviews[REVIEW].status,'review');
  await h.callback(`cr:${session.id}:replace`,preview);await h.worker().tick();assert.equal(h.batches.length,0);
});

test('duplicate identical rows require a bound explicit row choice and only that row receives the contact',async(t)=>{
  const h=await fixture(t,{duplicates:true});await h.reply();await h.worker().tick();
  const [session]=await sessions(h);assert.equal(session.status,'selecting_row');assert.equal(h.batches.length,0);
  const choice=h.sent.at(-1);assert.deepEqual(choice.reply_markup.inline_keyboard.flat().map((button)=>button.text),['Строка 2','Строка 3']);
  await h.callback(`cr:${session.id}:row:3`,choice);assert.equal((await h.worker().tick()).saved,1);
  assert.deepEqual(h.values[1].slice(12,15),['','','']);assert.equal(h.values[2][12],'Анна Иванова');
  assert.equal((await sessions(h))[0].plan.authorization.explicitRow,3);
});

test('a labelled explicit row in the first reply is accepted only within the exact review identity',async(t)=>{
  const h=await fixture(t,{duplicates:true});await h.reply(`${CONTACT}\nСтрока: 3`);
  assert.equal((await h.worker().tick()).saved,1);assert.equal(h.values[1][12],'');assert.equal(h.values[2][12],'Анна Иванова');
  const foreign=await fixture(t);foreign.values.push(valuesRow());foreign.values[2][11]='Другой объект';
  await foreign.reply(`${CONTACT}\nСтрока: 3`);await foreign.worker().tick();assert.equal(foreign.batches.length,0);
});

test('native contacts and replies to the bot follow-up use the same verified review binding',async(t)=>{
  const h=await fixture(t);await h.reply('Анна +79990000001');await h.worker().tick();
  assert.equal(h.batches.length,0);const help=h.sent.at(-1);assert.match(help.text,/Имя:/u);
  await h.reply('',{replyTo:help.result.message_id,replyText:help.text,contact:{first_name:'Анна',last_name:'Иванова',phone_number:'+79990000001'}});
  assert.equal((await h.worker().tick()).saved,1);assert.equal(h.values[1][12],'Анна Иванова');
});

test('a changed proposal supersedes its old confirmation without letting an old button authorize the new contact',async(t)=>{
  const h=await fixture(t,{existing:true});await h.reply();await h.worker().tick();
  const old=(await sessions(h))[0],oldPreview=h.sent.at(-1);
  await h.reply('Имя: Мария Петрова\nТелефон: +79990000002');await h.worker().tick();
  const current=(await sessions(h)).find((session)=>session.id!==old.id),newPreview=h.sent.at(-1);
  await h.callback(`cr:${old.id}:replace`,oldPreview);await h.worker().tick();assert.equal(h.batches.length,0);
  await h.callback(`cr:${current.id}:replace`,newPreview);await h.worker().tick();assert.equal(h.values[1][12],'Мария Петрова');
});

test('an unknown committed Google write is recovered read-only after restart without a duplicate batch',async(t)=>{
  const h=await fixture(t);let failed=false;
  h.controls.afterBatch=async()=>{if(!failed){failed=true;throw new Error('PRIVATE unknown commit');}};
  await h.reply();assert.equal((await h.worker().tick()).saved,0);assert.equal(h.batches.length,1);
  assert.equal((await sessions(h))[0].status,'planned');assert.equal(h.sent.length,0);
  assert.equal((await h.worker().tick()).saved,1);assert.equal(h.batches.length,1);assert.equal((await sessions(h))[0].status,'done');
});

test('manual changes after preview invalidate the old authorization instead of overwriting the changed fields',async(t)=>{
  for(const index of [0,13]){
    const h=await fixture(t,{existing:true});await h.reply();await h.worker().tick();
    const [session]=await sessions(h),preview=h.sent.at(-1);h.values[1][index]=index===13?'+79991111111':'CHANGED_PRIVATE_LINK';
    await h.callback(`cr:${session.id}:replace`,preview);await h.worker().tick();
    assert.equal(h.batches.length,0);assert.equal((await sessions(h))[0].status,'stale');
    assert.equal((await h.store.read()).contacts.reviews[REVIEW].status,'review');
  }
});

test('forged owner events or callback frames cannot reach Google or a different chat',async(t)=>{
  const h=await fixture(t,{existing:true});await h.reply();await h.worker().tick();
  const [session]=await sessions(h),preview=h.sent.at(-1);
  await h.callback(`cr:${session.id}:replace`,preview);
  await h.store.update((state)=>{state.telegram.ownerInbox[0].event.fromId='777';});
  await h.worker().tick();assert.equal(h.batches.length,0);
  await h.callback(`cr:${session.id}:replace`,preview);
  await h.store.update((state)=>{state.telegram.ownerInbox[0].event.replyTo.messageId=987654;});
  await h.worker().tick();assert.equal(h.batches.length,0);
  assert.equal(h.sent.every((message)=>message.chat_id===OWNER),true);
});

test('durable outbox retries after a failed send while completed Google work stays complete',async(t)=>{
  const h=await fixture(t);h.controls.sendFail=true;await h.reply();await h.worker().tick();
  assert.equal(h.batches.length,1);assert.equal((await sessions(h))[0].status,'done');assert.equal(h.sent.length,0);
  h.controls.sendFail=false;h.advance(30_001);await h.worker().tick();assert.equal(h.sent.length,1);assert.equal(h.batches.length,1);
  const state=await h.store.read();assert.equal(Object.values(state.contactReplies.outbox)[0].status,'sent');
  assert.doesNotMatch(JSON.stringify(h.logs),/token|PRIVATE|79990000001|Анна/u);
});

test('a superseded proposal never sends its stale pending preview after transport recovery',async(t)=>{
  const h=await fixture(t,{existing:true});h.controls.sendFail=true;
  await h.reply();await h.worker().tick();
  await h.reply('Имя: Мария Петрова\nТелефон: +79990000002');await h.worker().tick();
  h.controls.sendFail=false;h.advance(30_001);await h.worker().tick();
  assert.equal(h.sent.length,1);assert.match(h.sent[0].text,/Мария Петрова/u);assert.doesNotMatch(h.sent[0].text,/Анна/u);
  assert.equal(h.batches.length,0);
});

test('a moved or different license never receives a contact based merely on the organization name',async(t)=>{
  const h=await fixture(t);h.values[1][11]='Москва, другой адрес';await h.reply();await h.worker().tick();
  assert.equal(h.batches.length,0);assert.equal((await sessions(h))[0].status,'stale');assert.equal(h.values[1][12],'');
});

test('changed owner or bot cannot process saved intents or send a previous scope pending contact preview',async(t)=>{
  for(const change of [{ownerChatId:'777666'},{botId:'111222'}]){
    const h=await fixture(t,{existing:true});h.controls.sendFail=true;
    await h.reply();await h.worker().tick();h.controls.sendFail=false;h.advance(30_001);
    let reads=0,sends=0;const context=h.google.context,call=h.telegram.call;
    h.google.context=async()=>{reads++;return context();};
    h.telegram.call=async(...args)=>{sends++;return call(...args);};
    const rotated=new ContactReplyWorker({...h.config,...change});await rotated.tick();
    assert.equal(reads,0);assert.equal(sends,0);assert.equal(h.batches.length,0);
    assert.equal((await sessions(h))[0].status,'awaiting_replace');
    const outbox=Object.values((await h.store.read()).contactReplies.outbox)[0];assert.equal(outbox.status,'sending');
  }
});

test('scope rotation also blocks planned Google replay and colliding bot message IDs; missing bot binding fails closed',async(t)=>{
  for(const change of [{ownerChatId:'777666'},{botId:'111222'},{}]){
    const h=await fixture(t);h.controls.beforeBatch=async()=>{throw new Error('not sent');};
    await h.reply();await h.worker().tick();h.controls.beforeBatch=null;
    if(!Object.keys(change).length)await h.store.update((state)=>{delete Object.values(state.contactReplies.sessions)[0].botId;});
    let reads=0;const context=h.google.context;h.google.context=async()=>{reads++;return context();};
    await new ContactReplyWorker({...h.config,...change}).tick();
    assert.equal(reads,0);assert.equal(h.batches.length,0);assert.equal(h.sent.length,0);
  }
  const h=await fixture(t,{existing:true});await h.reply();await h.worker().tick();
  const preview=h.sent[0],before=(await sessions(h)).length,newBot='111222';
  await h.store.update((state)=>state.telegram.ownerInbox.push({updateId:900,event:{kind:'message',updateId:900,
    ownerChatId:OWNER,fromId:OWNER,chatType:'private',botId:newBot,messageId:901,date:'2026-11-05T09:01:00Z',text:CONTACT,
    replyTo:{messageId:preview.result.message_id,fromBotId:newBot,text:preview.text}}}));
  await new ContactReplyWorker({...h.config,botId:newBot}).tick();
  assert.equal((await sessions(h)).length,before);assert.equal(h.batches.length,0);assert.equal(h.sent.length,1);
});

test('reused update IDs from a different bot cannot overwrite an old session or revive its pending private outbox',async(t)=>{
  const h=await fixture(t,{existing:true});h.controls.sendFail=true;await h.reply();await h.worker().tick();
  const old=(await sessions(h))[0],newBot='111222',newReview=hash([ROW_KEY,'another_review']);
  const notification={type:'contact_review_required',jobId:newReview.slice(0,24),organization:'ООО Новый обзор',code:'contact_source_ambiguous'};
  await h.store.update((state)=>{
    state.contacts.reviews[newReview]={id:newReview,rowKey:ROW_KEY,status:'review',inn:INN,organization:'ООО Новый обзор'};
    state.runtime.notifications.new={event:notification,status:'sent',destinationHash:hash(OWNER)};
    state.telegram.ownerInbox.push({updateId:old.sourceUpdateId,event:{kind:'message',updateId:old.sourceUpdateId,
      ownerChatId:OWNER,fromId:OWNER,chatType:'private',botId:newBot,messageId:902,date:'2026-11-05T09:01:00Z',
      text:'Имя: Мария Петрова\nТелефон: +79990000002',replyTo:{messageId:88888,fromBotId:newBot,text:renderNotification(notification)}}});
  });
  const sent=[];const telegram={async call(method,params){
    assert.equal(method,'sendMessage');sent.push(params);
    return {message_id:9999,chat:{id:Number(OWNER),type:'private'},from:{id:Number(newBot),is_bot:true}};
  }};
  h.advance(30_001);await new ContactReplyWorker({...h.config,botId:newBot,telegram}).tick();
  const saved=await sessions(h);assert.equal(saved.length,2);assert.equal(saved.find((session)=>session.id===old.id).botId,BOT);
  assert.equal(saved.find((session)=>session.botId===newBot).reviewId,newReview);
  assert.equal(sent.length,1);assert.match(sent[0].text,/Мария Петрова/u);assert.doesNotMatch(sent[0].text,/Анна/u);
  assert.equal(h.batches.length,0);
});
