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
  const edited=message();edited.edited_message={...edited.message,edit_date:edited.message.date+60};delete edited.message;assert.equal(convertOwnerUpdate(edited,options).kind,'message');
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

test('two plain phone-first contacts keep their exact pairing and order in newline cells',()=>{
  const event=convertOwnerUpdate(message({text:'+7 (999) 111-22-33 Сергей\n\n+7 999 444 55 66 Алёна'}),options);
  assert.deepEqual(parseOwnerContactReply(event),{status:'contact',contact:{name:'Сергей\nАлёна',phone:'+79991112233\n+79994445566',
    persons:[{name:'Сергей',phone:'+79991112233'},{name:'Алёна',phone:'+79994445566'}]}});
  const reversed=convertOwnerUpdate(message({text:'+7 999 444 55 66 Алёна\n+7 (999) 111-22-33 Сергей'}),options);
  assert.equal(parseOwnerContactReply(reversed).contact.name,'Алёна\nСергей');
  assert.equal(parseOwnerContactReply(reversed).contact.phone,'+79994445566\n+79991112233');
});

test('complete repeated labelled name-phone blocks support both field orders and optional row/Telegram',()=>{
  const text='Имя: Сергей\nТелефон: +79991112233\n\nНомер: +79994445566\nКонтакт: Алёна\nТГ: @client_contact\nСтрока: 504';
  const result=parseOwnerContactReply(convertOwnerUpdate(message({text}),options));
  assert.deepEqual(result,{status:'contact',contact:{name:'Сергей\nАлёна',phone:'+79991112233\n+79994445566',
    persons:[{name:'Сергей',phone:'+79991112233'},{name:'Алёна',phone:'+79994445566'}],telegram:'https://t.me/client_contact'},rowNumber:504});
  const single=parseOwnerContactReply(convertOwnerUpdate(message({text:'+7\u00a0999\u00a0111-22-33 Сергей'}),options));
  assert.deepEqual(single,{status:'contact',contact:{name:'Сергей',phone:'+79991112233'}});
});

test('multiple contact input never partially accepts unmatched or conflicting names/phones',()=>{
  for(const text of[
    '+79991112233 Сергей\nАлёна',
    '+79991112233\nСергей',
    '+79991112233 Сергей\nТелефон: +79994445566\nИмя: Алёна',
    'Имя: Сергей\nИмя: Алёна\nТелефон: +79991112233\nТелефон: +79994445566',
    'Имя: Сергей\nТелефон: +79991112233\nИмя: Алёна',
    '+79991112233 Сергей\n+79991112233 Алёна',
    '+79991112233 Сергей\n+79994445566 Сергей',
    '+79991112233 Сергей\n+79994445566 Алёна\nнеполный третий контакт',
  ])assert.deepEqual(parseOwnerContactReply(convertOwnerUpdate(message({text}),options)),{status:'invalid'});
});

test('exact contact pairs deduplicate while five distinct pairs are accepted and six rejected',()=>{
  const repeated='+79991112233 Сергей\n+7 (999) 111-22-33 Сергей';
  assert.deepEqual(parseOwnerContactReply(convertOwnerUpdate(message({text:repeated}),options)),{status:'contact',contact:{name:'Сергей',phone:'+79991112233'}});
  const names=['Анна','Борис','Вера','Григорий','Дарья','Елена'];
  const lines=names.map((name,index)=>`+7999000000${index} ${name}`);
  const five=parseOwnerContactReply(convertOwnerUpdate(message({text:lines.slice(0,5).join('\n')}),options));
  assert.equal(five.status,'contact');assert.equal(five.contact.persons.length,5);
  assert.equal(parseOwnerContactReply(convertOwnerUpdate(message({text:lines.join('\n')}),options)).status,'invalid');
});

test('native single contact remains compatible and cannot be silently merged with another text contact',()=>{
  const native={first_name:'Анна',last_name:'Иванова',phone_number:'+79991112233'};
  const same=convertOwnerUpdate(message({text:'Имя: Анна Иванова\nТелефон: +79991112233\nСтрока: 504',contact:native}),options);
  assert.deepEqual(parseOwnerContactReply(same),{status:'contact',contact:{name:'Анна Иванова',phone:'+79991112233'},rowNumber:504});
  const mixed=convertOwnerUpdate(message({text:'+79994445566 Сергей',contact:native}),options);
  assert.equal(parseOwnerContactReply(mixed).status,'invalid');
});

test('owner private edits preserve original reply identity and record only verified Telegram edit time',()=>{
  const original=message();const raw=original.message;
  const edited={update_id:77,edited_message:{...raw,edit_date:raw.date+120,text:'Имя: Сергей\nТелефон: +79991112233\nИмя: Алёна\nТелефон: +79994445566'}};
  const event=convertOwnerUpdate(edited,options);
  assert.equal(event.updateId,77);assert.equal(event.messageId,raw.message_id);assert.equal(event.date,new Date(raw.date*1000).toISOString());
  assert.equal(event.editDate,new Date((raw.date+120)*1000).toISOString());
  assert.deepEqual(event.replyTo,convertOwnerUpdate(original,options).replyTo);assert.equal(parseOwnerContactReply(event).contact.persons.length,2);
  assert.equal(convertOwnerUpdate(original,options).editDate,undefined);
  for(const edit_date of [undefined,raw.date-1,NaN,Infinity,Number.MAX_SAFE_INTEGER]){
    assert.throws(()=>convertOwnerUpdate({update_id:77,edited_message:{...raw,edit_date}},options),{code:'owner_update_invalid'});
  }
  for(const change of [{from:{id:777}},{chat:{id:Number(owner),type:'group'}},{chat:{id:777,type:'private'}}]){
    assert.equal(convertOwnerUpdate({update_id:77,edited_message:{...edited.edited_message,...change}},options),null);
  }
  const foreignReply=convertOwnerUpdate({update_id:77,edited_message:{...edited.edited_message,
    reply_to_message:{...raw.reply_to_message,from:{id:777,is_bot:true}}}},options);
  assert.equal(findContactReview(reviewState().state,foreignReply),null);
});
