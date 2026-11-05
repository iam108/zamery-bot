import {createHash} from 'node:crypto';
import {isValidInn,normalizeDate,normalizeLicenseNumber} from './core.mjs';
import {parseOwnerContactReply} from './contact-reply-input.mjs';
import {renderNotification} from './notifier.mjs';

const invalid=()=>({status:'invalid'});
const clean=(value)=>typeof value==='string'?value.replace(/\s+/gu,' ').trim():'';
const positive=(value)=>(typeof value==='number'||typeof value==='string')&&/^[1-9]\d*$/u.test(String(value))&&Number.isSafeInteger(Number(value));
const requestId=(value)=>typeof value==='string'&&/^[a-f0-9]{32}$/u.test(value);
const jobId=(value)=>typeof value==='string'&&/^[a-f0-9]{24}$/u.test(value);
const dateHint=(value)=>{
  if(!/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}|\d{1,2}\s+[а-яё]+\.?\s+\d{4}(?:\s*г\.?)?)$/iu.test(value))return null;
  return normalizeDate(value);
};

/** Syntax only. Date fields are owner hints for matching official records. */
export function parseRegistryReply(event){
  if(!event||!['message','callback'].includes(event.kind))return invalid();
  if(event.kind==='callback'){
    const match=typeof event.data==='string'&&event.data.match(/^rg:([a-f0-9]{32}):(object:([1-9]\d{0,3})|retry|skip)$/u);
    if(!match)return invalid();
    if(match[3])return Number(match[3])<=1000?{status:'input',requestId:match[1],objectChoice:Number(match[3])}:invalid();
    return {status:'input',requestId:match[1],action:match[2]};
  }
  const text=event.text??'';
  if(event.textTruncated||typeof text!=='string'||text.length>4096||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))return invalid();
  const command = text.trim().toLowerCase();
  if (!event.nativeContact) {
    if (command === 'повторить' || command === 'повторить проверку') return {status:'input',action:'retry'};
    if (command === 'пропустить') return {status:'input',action:'skip'};
  }
  const result={status:'input'},contactLines=[];
  const labels=new Map([['инн','inn'],['адрес','address'],['объект','object'],['лицензия','licenseNumber'],
    ['номер лицензии','licenseNumber'],['строка','rowNumber'],['дата выдачи','issueDate'],['дата окончания','expiryDate']]);
  const set=(key,value)=>{
    if(Object.hasOwn(result,key))return false;
    result[key]=value;return true;
  };
  for(const rawLine of text.split(/\r?\n/u)){
    const line=clean(rawLine);if(!line)continue;
    const labelled=line.match(/^([^:\n]+?)\s*:\s*(.*?)\s*$/u);
    let field=labelled&&labels.get(clean(labelled[1]).toLowerCase());
    let value=labelled?clean(labelled[2]):line;
    if(!labelled&&/^\d{10}(?:\d{2})?$/u.test(line))field='inn';
    else if(!labelled&&/^\d{1,4}$/u.test(line))field='object';
    if(!field){contactLines.push(rawLine);continue;}
    if(!value)return invalid();
    if(field==='inn'){
      if(!/^\d{10}(?:\d{2})?$/u.test(value)||!isValidInn(value)||!set('inn',value))return invalid();
    }else if(field==='licenseNumber'){
      value=normalizeLicenseNumber(value.replace(/^№\s*/u,''));
      if(!/^\d{2}[А-ЯA-Z]{2,4}\d{4,10}$/u.test(value)||!set(field,value))return invalid();
    }else if(field==='object'&&/^\d+$/u.test(value)){
      if(!/^[1-9]\d{0,3}$/u.test(value)||Number(value)>1000||!set('objectChoice',Number(value)))return invalid();
    }else if(field==='object'||field==='address'){
      if(value.length>1000||!/[\p{L}]/u.test(value)||!set('address',value))return invalid();
    }else if(field==='rowNumber'){
      if(!/^[1-9]\d{0,5}$/u.test(value)||Number(value)<2||Number(value)>100000||!set(field,Number(value)))return invalid();
    }else{
      const date=dateHint(value);if(!date||!set(field,date))return invalid();
    }
  }
  if(result.issueDate&&result.expiryDate&&result.expiryDate<result.issueDate)return invalid();
  if(contactLines.some((line)=>clean(line))||event.nativeContact){
    const parsed=parseOwnerContactReply({...event,text:contactLines.join('\n')});
    if(parsed.status!=='contact')return invalid();
    result.contact=parsed.contact;
  }
  return Object.keys(result).length>1?result:invalid();
}

function ownerFrame(event){
  return event&&['message','callback'].includes(event.kind)&&event.chatType==='private'&&positive(event.ownerChatId)
    &&String(event.fromId)===String(event.ownerChatId)&&positive(event.botId)
    &&String(event.replyTo?.fromBotId)===String(event.botId)&&positive(event.replyTo?.messageId)
    &&(event.kind!=='callback'||Number(event.messageId)===Number(event.replyTo.messageId));
}
function scoped(request,event){
  return request&&positive(request.ownerChatId)&&positive(request.botId)
    &&String(request.ownerChatId)===String(event.ownerChatId)&&String(request.botId)===String(event.botId);
}
const aliases=(request)=>[...(Array.isArray(request.replyMessageIds)?request.replyMessageIds:[]),
  ...(Array.isArray(request.telegramMessageIds)?request.telegramMessageIds:[])];
const one=(values)=>{const unique=[...new Set(values)];return unique.length===1?unique[0]:null;};

/** Bind exact saved delivery aliases. Names and organization text never identify a request. */
export function findRegistryRequest(state,event){
  if(!state||!ownerFrame(event))return null;
  let callbackId;
  if(event.kind==='callback'){
    callbackId=typeof event.data==='string'&&event.data.match(/^rg:([a-f0-9]{32}):/u)?.[1];
    if(!callbackId)return null;
  }
  const requests=Object.entries(state.registry?.requests??{}).filter(([id,request])=>requestId(id)
    &&scoped(request,event)&&(request.id==null||request.id===id));
  const scopedIds=new Set(requests.map(([id])=>id));
  const replyId=Number(event.replyTo.messageId);
  const delivered=[];
  for(const [id,request] of requests){
    if(aliases(request).some((value)=>positive(value)&&Number(value)===replyId))delivered.push(id);
  }
  for(const item of Object.values(state.registry?.outbox??{})){
    if(scopedIds.has(item?.requestId)&&item.status==='sent'
      &&positive(item.telegramMessageId)&&Number(item.telegramMessageId)===replyId
      &&(item.ownerChatId==null||String(item.ownerChatId)===String(event.ownerChatId))
      &&(item.botId==null||String(item.botId)===String(event.botId)))delivered.push(item.requestId);
  }
  const finish=(ids)=>{const id=one(ids);return id&&(!callbackId||id===callbackId)?id:null;};
  if(delivered.length)return finish(delivered);
  const destinationHash=createHash('sha256').update(JSON.stringify(String(event.ownerChatId))).digest('hex');
  const notifications=Object.values(state.runtime?.notifications??{}).filter((item)=>item?.destinationHash===destinationHash
    &&['sent','pending'].includes(item.status)&&jobId(item.event?.jobId)
    &&(item.botId==null||String(item.botId)===String(event.botId)));
  const bound=(items)=>{
    const jobs=new Set(items.map((item)=>item.event.jobId));
    return requests.filter(([,request])=>Array.isArray(request.notificationJobIds)
      &&request.notificationJobIds.some((job)=>jobs.has(job))).map(([id])=>id);
  };
  const knownIds=notifications.filter((item)=>positive(item.telegramMessageId)&&Number(item.telegramMessageId)===replyId);
  if(knownIds.length)return finish(bound(knownIds));
  if(event.replyTo.textTruncated||typeof event.replyTo.text!=='string'||!event.replyTo.text)return null;
  const exact=notifications.filter((item)=>{
    let rendered;try{rendered=renderNotification(item.event);}catch{return false;}
    return typeof rendered==='string'&&rendered===event.replyTo.text;
  });
  if(!exact.some((item)=>item.telegramMessageId==null))return null;
  return finish(bound(exact));
}
