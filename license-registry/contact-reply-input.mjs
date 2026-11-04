import {createHash} from 'node:crypto';
import {normalizeContactPhone,normalizeContactTelegram} from './contact-match.mjs';
import {renderNotification} from './notifier.mjs';

const MAX_TEXT=4096;
const positive=(value)=>(typeof value==='number'||typeof value==='string'&&/^[1-9]\d*$/u.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const clean=(value)=>typeof value==='string'?value.replace(/\s+/gu,' ').trim():'';
const invalid=()=>({status:'invalid'});
function timestamp(value){
  if(!Number.isSafeInteger(value)||value<1||!Number.isFinite(+new Date(value*1000)))throw Object.assign(new Error('owner_update_invalid'),{code:'owner_update_invalid'});
  return new Date(value*1000).toISOString();
}
function frame(message){
  if(!message||!positive(message.message_id))return null;
  const raw=typeof message.text==='string'?message.text:typeof message.caption==='string'?message.caption:'';
  return {messageId:Number(message.message_id),fromBotId:message.from?.is_bot===true&&positive(message.from.id)?String(message.from.id):null,
    text:raw.slice(0,MAX_TEXT),...(raw.length>MAX_TEXT?{textTruncated:true}:{})};
}

/** Only the verified owner's private messages/callbacks become manual commands. */
export function convertOwnerUpdate(update,{ownerChatId,botId}={}){
  if(!positive(ownerChatId)||!positive(botId))throw Object.assign(new Error('owner_input_configuration_invalid'),{code:'owner_input_configuration_invalid'});
  const owner=String(ownerChatId),bot=String(botId);
  const message=update?.message??update?.edited_message;
  const edited=Boolean(update?.edited_message&&!update?.message);
  const callback=update?.callback_query;
  if(!message&&!callback)return null;
  if(message){
    if(message.chat?.type!=='private'||String(message.chat.id)!==owner||String(message.from?.id)!==owner||message.from?.is_bot===true)return null;
  }else{
    const target=callback.message;
    if(String(callback.from?.id)!==owner||callback.from?.is_bot===true||target?.chat?.type!=='private'
      ||String(target.chat.id)!==owner||target.from?.is_bot!==true||String(target.from.id)!==bot)return null;
    if(typeof callback.data!=='string'||!/^cr:[A-Za-z0-9:_-]+$/u.test(callback.data)||Buffer.byteLength(callback.data,'utf8')>128
      ||typeof callback.id!=='string'||!callback.id||callback.id.length>256||/[\u0000-\u001f\u007f]/u.test(callback.id))return null;
  }
  if(!Number.isSafeInteger(update.update_id)||update.update_id<0)throw Object.assign(new Error('owner_update_invalid'),{code:'owner_update_invalid'});
  const current=message??callback.message;
  if(!positive(current.message_id))throw Object.assign(new Error('owner_update_invalid'),{code:'owner_update_invalid'});
  const raw=message?(typeof message.text==='string'?message.text:typeof message.caption==='string'?message.caption:''):'';
  const result={kind:message?'message':'callback',updateId:update.update_id,ownerChatId:owner,fromId:owner,chatType:'private',botId:bot,
    messageId:Number(current.message_id),date:timestamp(current.date),text:raw.slice(0,MAX_TEXT),...(raw.length>MAX_TEXT?{textTruncated:true}:{})};
  if(edited){
    const editDate=timestamp(current.edit_date);
    if(current.edit_date<current.date)throw Object.assign(new Error('owner_update_invalid'),{code:'owner_update_invalid'});
    result.editDate=editDate;
  }
  const reply=frame(message?message.reply_to_message:callback.message);if(reply)result.replyTo=reply;
  if(message?.contact){
    const contact=message.contact;
    result.nativeContact={firstName:typeof contact.first_name==='string'?contact.first_name.slice(0,160):'',
      lastName:typeof contact.last_name==='string'?contact.last_name.slice(0,160):'',
      phoneNumber:typeof contact.phone_number==='string'?contact.phone_number.slice(0,100):'',userId:positive(contact.user_id)?String(contact.user_id):null,
      ...((contact.first_name?.length??0)>160||(contact.last_name?.length??0)>160||(contact.phone_number?.length??0)>100?{truncated:true}:{})};
  }
  if(callback){result.callbackQueryId=callback.id;result.data=callback.data;}
  return result;
}

function reviewFromNotification(state,item){
  const prefix=item.event?.jobId;
  if(typeof prefix!=='string'||!/^[a-f0-9]{24}$/u.test(prefix))return null;
  const matches=Object.entries(state.contacts?.reviews??{}).filter(([id,review])=>/^[a-f0-9]{64}$/u.test(id)
    &&id.startsWith(prefix)&&(review.id==null||review.id===id));
  return matches.length===1?matches[0][0]:null;
}

/** New delivery IDs take precedence. Old messages require exact, unique rendering. */
export function findContactReview(state,event){
  if(!state||!event||!['message','callback'].includes(event.kind)||event.chatType!=='private'||!positive(event.ownerChatId)
    ||event.fromId!==event.ownerChatId||!positive(event.botId)||event.replyTo?.fromBotId!==event.botId||!positive(event.replyTo.messageId))return null;
  const destinationHash=createHash('sha256').update(JSON.stringify(String(event.ownerChatId))).digest('hex');
  const notifications=Object.values(state.runtime?.notifications??{}).filter((item)=>item.event?.type==='contact_review_required'
    &&item.destinationHash===destinationHash&&['sent','pending'].includes(item.status));
  const delivered=notifications.filter((item)=>item.telegramMessageId===event.replyTo.messageId);
  if(delivered.length){
    const ids=delivered.map((item)=>reviewFromNotification(state,item));
    return ids.every(Boolean)&&new Set(ids).size===1?ids[0]:null;
  }
  if(event.replyTo.textTruncated||typeof event.replyTo.text!=='string'||!event.replyTo.text)return null;
  const exact=notifications.filter((item)=>renderNotification(item.event)===event.replyTo.text);
  if(!exact.some((item)=>item.telegramMessageId==null))return null;
  const ids=exact.map((item)=>reviewFromNotification(state,item));
  return ids.length&&ids.every(Boolean)&&new Set(ids).size===1?ids[0]:null;
}

/** Read-only startup coverage; never enqueues an owner action or exposes contact data. */
export function contactReplyCoverage(state,{ownerChatId,botId}){
  const owner=String(ownerChatId),bot=String(botId);
  const destinationHash=createHash('sha256').update(JSON.stringify(owner)).digest('hex');
  const entries=Object.values(state.runtime?.notifications??{}).filter((item)=>item.event?.type==='contact_review_required'
    &&item.destinationHash===destinationHash&&['sent','pending'].includes(item.status));
  const notified=new Set(),supported=new Set();let legacy=0;
  for(const item of entries){
    const id=reviewFromNotification(state,item);
    if(!id||state.contacts?.reviews?.[id]?.status==='resolved')continue;
    notified.add(id);
    const result=findContactReview(state,{kind:'message',chatType:'private',ownerChatId:owner,fromId:owner,botId:bot,
      replyTo:{messageId:item.telegramMessageId??1,fromBotId:bot,text:renderNotification(item.event)}});
    if(result===id){supported.add(id);if(item.telegramMessageId==null)legacy++;}
  }
  return {notifiedReviews:notified.size,replyableReviews:supported.size,legacyLinks:legacy};
}

/** Explicit complete name/phone pairs, never sender profile data or unmatched text. */
export function parseOwnerContactReply(event){
  if(!event||event.kind!=='message'||event.textTruncated)return invalid();
  const fields={telegram:[],row:[]};
  const labels=new Map([['имя','name'],['контакт','name'],['телефон','phone'],['номер','phone'],['telegram','telegram'],['тг','telegram'],['строка','row']]);
  const persons=[];let mode=null;let pending={};
  const pair=(nameValue,phoneValue)=>{
    const name=clean(nameValue),phone=normalizeContactPhone(phoneValue);
    return name&&name.length<=160&&/^\p{L}[\p{L}\p{M} .’'()\-]*$/u.test(name)&&phone?{name,phone}:null;
  };
  for(const rawLine of String(event.text??'').split(/\r?\n/u)){
    const line=clean(rawLine);if(!line)continue;
    const labelled=line.match(/^([^:\n]+?)\s*:\s*(.*?)\s*$/u);
    const key=labelled&&labels.get(clean(labelled[1]).toLowerCase());
    if(key==='telegram'||key==='row'){
      fields[key].push(clean(labelled[2]));if(fields[key].length>1)return invalid();continue;
    }
    if(key==='name'||key==='phone'){
      if(mode==='plain')return invalid();mode='labelled';
      if(pending[key]!=null)return invalid();pending[key]=clean(labelled[2]);
      if(pending.name!=null&&pending.phone!=null){
        const parsed=pair(pending.name,pending.phone);if(!parsed)return invalid();persons.push(parsed);pending={};
      }
      continue;
    }
    if(mode==='labelled')return invalid();
    const plain=line.match(/^(\+?\d[\d ().-]{6,30}\d)\s+(.+)$/u);
    if(!plain)return invalid();
    const parsed=pair(plain[2],plain[1]);if(!parsed)return invalid();persons.push(parsed);mode='plain';
  }
  if(event.nativeContact){
    if(event.nativeContact.truncated||mode==='plain'||persons.length>1)return invalid();
    const native=pair([event.nativeContact.firstName,event.nativeContact.lastName].filter(Boolean).join(' '),event.nativeContact.phoneNumber);
    if(!native)return invalid();
    const provided=persons[0]??pending;
    if(provided.name&&provided.name.toLowerCase()!==native.name.toLowerCase())return invalid();
    if(provided.phone&&normalizeContactPhone(provided.phone)!==native.phone)return invalid();
    persons.splice(0,persons.length,native);pending={};
  }
  if(Object.keys(pending).length||!persons.length)return invalid();
  const unique=[];const names=new Map(),phones=new Map();
  for(const person of persons){
    const key=person.name.toLowerCase().replace(/ё/gu,'е');
    if(names.has(key)&&names.get(key)!==person.phone||phones.has(person.phone)&&phones.get(person.phone)!==key)return invalid();
    if(names.get(key)===person.phone)continue;
    names.set(key,person.phone);phones.set(person.phone,key);unique.push(person);
  }
  if(!unique.length||unique.length>5)return invalid();
  const telegram=fields.telegram[0]?normalizeContactTelegram(fields.telegram[0]):null;
  if(fields.telegram.length&&!telegram)return invalid();
  let rowNumber;
  if(fields.row.length){
    if(!/^[1-9]\d{0,5}$/u.test(fields.row[0])||Number(fields.row[0])<2||Number(fields.row[0])>100000)return invalid();
    rowNumber=Number(fields.row[0]);
  }
  const contact={name:unique.map(person=>person.name).join('\n'),phone:unique.map(person=>person.phone).join('\n'),
    ...(unique.length>1?{persons:unique}:{}),...(telegram?{telegram}:{})};
  return {status:'contact',contact,...(rowNumber?{rowNumber}:{})};
}
