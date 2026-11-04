import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {convertOwnerUpdate,findContactReview,parseOwnerContactReply,contactReplyCoverage} from './contact-reply-input.mjs';
import {createNotifier,renderNotification} from './notifier.mjs';
const owner='123456789',bot='9127813428';
const options={ownerChatId:owner,botId:bot};
const message=(changes={})=>({update_id:50,message:{message_id:101,date:1793876400,from:{id:Number(owner),is_bot:false},
  chat:{id:Number(owner),type:'private'},text:'Имя: Иван Иванов\nТелефон: 8 (999) 123-45-67\nТГ: @ivan_user',
  reply_to_message:{message_id:99,from:{id:Number(bot),is_bot:true},text:'old review'},...changes}});
const callback=(changes={})=>({update_id:51,callback_query:{id:'opaque_123',from:{id:Number(owner),is_bot:false},data:'cr:confirm:abc123',
  message:{message_id:102,date:1793876400,from:{id:Number(bot),is_bot:true},chat:{id:Number(owner),type:'private'},text:'preview'},...changes}});
function reviewState({delivered=true,duplicate=false}={}){
  const id='a'.repeat(64);const event={type:'contact_review_required',jobId:id.slice(0,24),code:'contact_source_ambiguous',organization:'ООО Тест'};
  const state={contacts:{reviews:{[id]:{id,status:'review'}}},runtime:{notifications:{one:{status:'sent',
    destinationHash:createHash('sha256').update(JSON.stringify(owner)).digest('hex'),event,...delivered?{telegramMessageId:99}:{}}}}};
  if(duplicate){const second='a'.repeat(24)+'b'.repeat(40);state.contacts.reviews[second]={id:second,status:'review'};}
  return {state,id,event};
}

test('only the configured human owner in the exact private chat becomes a message event',()=>{
  const event=convertOwnerUpdate(message(),options);assert.equal(event.kind,'message');assert.equal(event.ownerChatId,owner);
  assert.equal(event.fromId,owner);assert.equal(event.botId,bot);assert.equal(event.replyTo.messageId,99);assert.equal(event.replyTo.fromBotId,bot);
  for(const changes of[{from:{id:777}},{chat:{id:777,type:'private'}},{chat:{id:Number(owner),type:'group'}},{from:{id:Number(owner),is_bot:true}}]){
    assert.equal(convertOwnerUpdate(message(changes),options),null);
  }
  const edited=message();edited.edited_message=edited.message;delete edited.message;assert.equal(convertOwnerUpdate(edited,options),null);
  assert.throws(()=>convertOwnerUpdate(message(),{ownerChatId:owner}),{code:'owner_input_configuration_invalid'});
});

test('only owner callbacks on this bot private message with reserved bounded data are accepted',()=>{
  const event=convertOwnerUpdate(callback(),options);assert.equal(event.kind,'callback');assert.equal(event.data,'cr:confirm:abc123');
  assert.equal(event.callbackQueryId,'opaque_123');assert.equal(event.replyTo.messageId,102);
  for(const changes of[{from:{id:777}},{data:'other:123'},{data:'cr:'},{data:'cr:'+ 'a'.repeat(129)},
    {data:'cr:bad\nvalue'},{message:{...callback().callback_query.message,from:{id:777,is_bot:true}}},
    {message:{...callback().callback_query.message,chat:{id:Number(owner),type:'group'}}},
    {message:undefined,inline_message_id:'inline'}])assert.equal(convertOwnerUpdate(callback(changes),options),null);
});

test('native contact is explicit data and never falls back to sender profile phone/name',()=>{
  const event=convertOwnerUpdate(message({text:'',from:{id:Number(owner),first_name:'Manager',phone_number:'79990000000'},
    contact:{first_name:'Анна',last_name:'Иванова',phone_number:'+79991234567',user_id:444}}),options);
  assert.deepEqual(parseOwnerContactReply(event),{status:'contact',contact:{name:'Анна Иванова',phone:'+79991234567'}});
  assert.equal(parseOwnerContactReply(convertOwnerUpdate(message({text:'',from:{id:Number(owner),first_name:'Manager',phone_number:'79990000000'}}),options)).status,'invalid');
  assert.equal(parseOwnerContactReply({...event,text:'Телефон: +79990000000'}).status,'invalid');
});

test('owner labels support optional Telegram and row while invalid/ambiguous fields are rejected',()=>{
  const event=convertOwnerUpdate(message(),options);
  assert.deepEqual(parseOwnerContactReply({...event,text:event.text+'\nСтрока: 504'}),{status:'contact',
    contact:{name:'Иван Иванов',phone:'+79991234567',telegram:'https://t.me/ivan_user'},rowNumber:504});
  assert.equal(parseOwnerContactReply({...event,text:'Контакт: Анна\nНомер: +90 555 555 55 55'}).contact.phone,'+905555555555');
  for(const text of ['Имя: Иван','Телефон: +79991234567','Имя: Иван\nТелефон: 123',
    event.text+'\nИмя: Анна',event.text+'\nНомер: +78880000000',event.text+'\nСтрока: 1',
    event.text.replace('@ivan_user','https://evil.test/ivan'),event.text.replace('Иван Иванов','=IMPORTDATA("x")')]){
    assert.equal(parseOwnerContactReply({...event,text}).status,'invalid');
  }
});

test('oversized text/native contacts are marked truncated and cannot become partial commands',()=>{
  const event=convertOwnerUpdate(message({text:'a'.repeat(5000)}),options);assert.equal(event.text.length,4096);assert.equal(event.textTruncated,true);
  assert.equal(parseOwnerContactReply(event).status,'invalid');
  const native=convertOwnerUpdate(message({text:'',contact:{first_name:'a'.repeat(200),phone_number:'+79991234567'}}),options);
  assert.equal(parseOwnerContactReply(native).status,'invalid');
  assert.throws(()=>convertOwnerUpdate(message({date:Number.MAX_SAFE_INTEGER}),options),{code:'owner_update_invalid'});
});

test('delivery ID identifies a review independent of text but requires exact bot and destination',()=>{
  const {state,id}=reviewState();const event=convertOwnerUpdate(message(),options);
  assert.equal(findContactReview(state,event),id);
  assert.equal(findContactReview(state,{...event,replyTo:{...event.replyTo,fromBotId:'777'}}),null);
  assert.equal(findContactReview(state,{...event,fromId:'777'}),null);
  assert.equal(findContactReview(state,{...event,ownerChatId:'777',fromId:'777'}),null);
  state.runtime.notifications.one.telegramMessageId=100;
  assert.equal(findContactReview(state,event),null);
});

test('six legacy reviews can be found only through exact unique rendered bot text',()=>{
  const {state,id,event:notification}=reviewState({delivered:false});
  const event=convertOwnerUpdate(message({reply_to_message:{message_id:99,from:{id:Number(bot),is_bot:true},text:renderNotification(notification)}}),options);
  assert.equal(findContactReview(state,event),id);
  assert.equal(findContactReview(state,{...event,replyTo:{...event.replyTo,text:'ООО Тест'}}),null);
  assert.equal(findContactReview(state,{...event,replyTo:{...event.replyTo,text:renderNotification(notification)+' '}}),null);
  assert.equal(findContactReview(state,{...event,replyTo:{...event.replyTo,textTruncated:true}}),null);
  const second='b'.repeat(64);state.contacts.reviews[second]={id:second};
  state.runtime.notifications.two={...state.runtime.notifications.one,event:{...notification,jobId:second.slice(0,24)}};
  assert.equal(findContactReview(state,event),null);
});

test('ambiguous job ID prefixes are never guessed even with matching delivery ID',()=>{
  const {state}=reviewState({duplicate:true});assert.equal(findContactReview(state,convertOwnerUpdate(message(),options)),null);
});

test('real notifier receipts and legacy records both bind to the owner reply without mirrored hashing assumptions',async()=>{
  const id='c'.repeat(64);let state={contacts:{reviews:{[id]:{id,status:'review'}}},runtime:{}};
  const store={read:async()=>structuredClone(state),update:async(fn)=>fn(state)};
  let sent;
  const telegram={call:async(method,params)=>{
    if(method==='getChat')return {id:Number(owner),type:'private'};
    assert.equal(method,'sendMessage');sent=params;
    return {message_id:99,chat:{id:Number(owner),type:'private'}};
  }};
  const report=createNotifier({store,telegram,ownerChatId:owner,log:()=>{}});
  await report({type:'contact_review_required',jobId:id.slice(0,24),code:'contact_source_ambiguous',organization:'ООО Тест'});
  const event=convertOwnerUpdate(message({reply_to_message:{message_id:99,from:{id:Number(bot),is_bot:true},text:sent.text}}),options);
  assert.equal(findContactReview(state,event),id);
  assert.deepEqual(contactReplyCoverage(state,options),{notifiedReviews:1,replyableReviews:1,legacyLinks:0});
  for(const item of Object.values(state.runtime.notifications))delete item.telegramMessageId;
  assert.equal(findContactReview(state,event),id);
  assert.deepEqual(contactReplyCoverage(state,options),{notifiedReviews:1,replyableReviews:1,legacyLinks:1});
});
