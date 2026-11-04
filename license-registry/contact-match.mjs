import {isValidInn,normalizeAddress} from './core.mjs';

const text=(value)=>typeof value==='string'?value.replace(/\s+/gu,' ').trim():'';
const cellText=(value)=>value==null?'':typeof value==='string'?text(value):String(value).trim();
const nameKey=(value)=>text(value).toLocaleLowerCase('ru').replace(/ё/gu,'е');
const positiveId=(value)=>(typeof value==='number'||typeof value==='string'&&/^[1-9]\d*$/u.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const blockedRoles=new Set(['auditor','staff','submitter','manager','lawyer','operator','site_contact','onsite','on_site','onsite_contact',
  'аудитор','сотрудник','отправитель','менеджер','юрист','оператор','контакт на объекте','контакт на месте','контакт для выезда']);
const reservedTelegram=new Set(['share','proxy','socks','joinchat','addstickers','addemoji','addlist','login','contact','confirmphone','setlanguage','boost']);
const review=(reason)=>({action:'review',reason,updates:[],candidate:null,provenance:[]});

export function normalizeContactPhone(value){
  if(typeof value!=='string')return null;
  const raw=value.trim();
  if(!raw||!/^\+?[\d\s().-]+$/u.test(raw))return null;
  const digits=raw.replace(/\D/gu,'');
  if(raw.startsWith('+'))return /^[1-9]\d{7,14}$/u.test(digits)?`+${digits}`:null;
  if(/^8\d{10}$/u.test(digits))return `+7${digits.slice(1)}`;
  if(/^7\d{10}$/u.test(digits))return `+${digits}`;
  if(/^\d{10}$/u.test(digits))return `+7${digits}`;
  return null;
}

export function normalizeContactTelegram(value){
  if(typeof value!=='string')return null;
  let raw=value.trim();
  if(!raw)return null;
  if(/^https:/iu.test(raw)){
    let url;try{url=new URL(raw);}catch{return null;}
    if(url.protocol!=='https:'||url.hostname.toLowerCase()!=='t.me'||url.username||url.password||url.port||url.search||url.hash)return null;
    raw=url.pathname.replace(/^\//u,'').replace(/\/$/u,'');
  }else if(raw.startsWith('@'))raw=raw.slice(1);
  if(!/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(raw)||reservedTelegram.has(raw.toLowerCase()))return null;
  return `https://t.me/${raw.toLowerCase()}`;
}

function contactValue(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return {invalid:true};
  const role=text(raw.role).toLowerCase();
  if(blockedRoles.has(role))return {blocked:true};
  const name=text(raw.name),phoneRaw=raw.phone,telegramRaw=raw.tg??raw.telegram;
  if((raw.name!=null&&typeof raw.name!=='string')||(phoneRaw!=null&&typeof phoneRaw!=='string')
    ||(telegramRaw!=null&&typeof telegramRaw!=='string'))return {invalid:true};
  if(!name&&!text(phoneRaw)&&!text(telegramRaw))return {empty:true};
  if((raw.name!=null&&typeof raw.name!=='string')||(name&&(!/^[\p{L}\p{M} .’'()\-]{2,160}$/u.test(name)||/[\u0000-\u001f\u007f]/u.test(raw.name))))return {invalid:true};
  const phone=text(phoneRaw)?normalizeContactPhone(phoneRaw):null;
  const telegram=text(telegramRaw)?normalizeContactTelegram(telegramRaw):null;
  if((phoneRaw!=null&&phoneRaw!==''&&!phone)||(telegramRaw!=null&&telegramRaw!==''&&!telegram))return {invalid:true};
  return {contact:{name:name||null,phone,telegram,role:role||'unspecified',salesContactConfirmed:false}};
}

function sourceContacts(item){
  let contacts=item.contacts;
  if(typeof contacts==='string'){
    try{contacts=JSON.parse(contacts);}catch{return {invalid:true};}
  }
  if(contacts!=null&&!Array.isArray(contacts))return {invalid:true};
  if(Array.isArray(contacts)&&contacts.length)return {values:contacts,source:'case_contacts'};
  return {values:[{name:item.client,phone:item.phone}],source:'case_legacy'};
}

/** Only explicitly labelled client-form fields can supply an unassigned contact. */
export function parseContactRequest(report){
  if(!report||typeof report.text!=='string')return null;
  const body=report.text;
  if(!/Новая форма заполнена|Наименование организации\s*:/iu.test(body))return null;
  const rejected=(reason)=>({status:'review',reason});
  if(body.length>20_000||!positiveId(report.id))return rejected('contact_request_invalid');
  const fields={name:[],phone:[],org:[],inn:[],address:[],tg:[]};
  const labels=new Map([
    ['имя клиента','name'],['номер','phone'],['телефон','phone'],['номер телефона','phone'],['телефон клиента','phone'],
    ['дополнительный телефон','phone'],['дополнительный номер','phone'],['телефон 2','phone'],['номер 2','phone'],
    ['наименование организации','org'],['инн','inn'],['адрес лицензирования','address'],['адрес','address'],
    ['telegram','tg'],['телеграм','tg'],['тг','tg'],['telegram клиента','tg'],['ник в telegram','tg'],['ссылка на чат в тг','tg']
  ]);
  for(const line of body.split(/\r?\n/u)){
    const match=line.match(/^\s*([^:\n]+?)\s*:\s*(.*?)\s*$/u);if(!match)continue;
    const key=labels.get(text(match[1]).toLowerCase());if(key)fields[key].push(text(match[2]));
  }
  if(['name','phone','org','inn','address'].some((key)=>fields[key].length!==1||!fields[key][0]))return rejected('contact_request_incomplete_or_ambiguous');
  if(fields.tg.length>1)return rejected('contact_request_incomplete_or_ambiguous');
  const inn=fields.inn[0];
  if(!isValidInn(inn))return rejected('contact_request_inn_invalid');
  const allInns=[...new Set((body.match(/(?<!\d)\d{10}(?:\d{2})?(?!\d)/gu)??[]).filter(isValidInn))];
  if(allInns.length!==1||allInns[0]!==inn)return rejected('contact_request_incomplete_or_ambiguous');
  const org=fields.org[0];
  if(org.length>300||org.length<2||(body.match(/(?<!\p{L})(?:ООО|ПАО|ЗАО|АО|ИП)(?!\p{L})/giu)??[]).length>1)return rejected('contact_request_incomplete_or_ambiguous');
  const phone=normalizeContactPhone(fields.phone[0]);
  const additionalPhones=(body.match(/(?<!\d)(?:\+7|8)[ ()-]*\d{3}[ ()-]*\d{3}[ ()-]*\d{2}[ ()-]*\d{2}(?!\d)|(?<!\d)\+[1-9](?:[ ()-]*\d){7,14}(?![ ()-]*\d)/gu)??[])
    .map(normalizeContactPhone).filter(Boolean);
  if(!phone||additionalPhones.some((value)=>value!==phone))return rejected('contact_request_incomplete_or_ambiguous');
  const raw={name:fields.name[0],phone,tg:fields.tg[0]??''};
  const parsed=contactValue(raw);
  if(!parsed.contact)return rejected('contact_request_invalid');
  return {status:'ready',source:{id:null,request_id:positiveId(report.id),inn,org,address:fields.address[0],
    contacts:[{name:parsed.contact.name,phone:parsed.contact.phone,tg:parsed.contact.telegram}],
    contact_source:'incoming_request',created_at:typeof report.created_at==='string'?report.created_at:null}};
}

/** Pure, fill-empty-only contact plan. Source contacts are never called sales contacts. */
export function planContactEnrichment({row,cases}={}){
  if(!row||!Number.isSafeInteger(row.rowNumber)||row.rowNumber<2)return review('contact_row_required');
  const values=Array.isArray(row.values)?row.values:[];
  const inn=text(row.inn??values[6]);
  if(!isValidInn(inn))return review('contact_inn_invalid');
  const addressRaw=row.address??values[11];
  const address=typeof addressRaw==='string'?normalizeAddress(addressRaw):'';
  if(!address)return review('contact_object_address_required');
  const existing={name:cellText(row.name??values[12]),phone:cellText(row.phone??values[13]),telegram:cellText(row.telegram??values[14])};
  if(Object.values(existing).every(Boolean))return {action:'noop',reason:'contact_fields_filled',updates:[],candidate:null,provenance:[]};
  if(!Array.isArray(cases))return review('contact_sources_required');
  const matching=cases.filter((item)=>item&&typeof item.address==='string'&&isValidInn(String(item.inn??''))&&String(item.inn).trim()===inn
    &&normalizeAddress(item.address)===address);
  if(!matching.length)return review('contact_source_not_found');
  const unique=new Map();let invalid=false;let blocked=false;
  for(const item of matching){
    const caseId=positiveId(item.id??item.caseId);
    const requestId=positiveId(item.request_id??item.requestId);
    const incoming=item.contact_source==='incoming_request';
    if((incoming&&!requestId)||(!incoming&&!caseId)){invalid=true;continue;}
    const source=sourceContacts(item);
    if(source.invalid){invalid=true;continue;}
    for(const raw of source.values){
      const parsed=contactValue(raw);
      if(parsed.invalid){invalid=true;continue;}
      if(parsed.blocked){blocked=true;continue;}
      if(parsed.empty)continue;
      const contact=parsed.contact;
      const key=JSON.stringify([nameKey(contact.name),contact.phone,contact.telegram]);
      const provenance={caseId:incoming?null:caseId,requestId,orderId:incoming?null:positiveId(item.order_id??item.orderId),source:incoming?'incoming_request':source.source};
      const existingContact=unique.get(key);
      if(existingContact){
        if(!existingContact.provenance.some((prior)=>JSON.stringify(prior)===JSON.stringify(provenance)))existingContact.provenance.push(provenance);
        if(existingContact.contact.role!==contact.role)existingContact.contact.role='unspecified';
      }else unique.set(key,{contact,provenance:[provenance]});
    }
  }
  if(invalid)return review('contact_source_invalid');
  if(!unique.size)return review(blocked?'contact_role_not_client':'contact_source_empty');
  let candidates=[...unique.values()];
  // Every populated destination field must agree with the SAME source tuple.
  // A known phone alone may select a matching tuple; names are never assembled
  // from one person and a phone or Telegram account from another.
  const existingPhone=existing.phone?normalizeContactPhone(existing.phone):null;
  const existingTelegram=existing.telegram?normalizeContactTelegram(existing.telegram):null;
  if((existing.phone&&!existingPhone)||(existing.telegram&&!existingTelegram))return review('contact_existing_value_unverified');
  candidates=candidates.filter(({contact})=>(!existing.name||Boolean(contact.name)&&nameKey(contact.name)===nameKey(existing.name))
    &&(!existing.phone||contact.phone===existingPhone)&&(!existing.telegram||contact.telegram===existingTelegram));
  if(!candidates.length)return review('contact_existing_conflict');
  if(candidates.length!==1)return review('contact_source_ambiguous');
  const selected=candidates[0];
  const columns={name:'M',phone:'N',telegram:'O'};
  const updates=Object.entries(columns).filter(([field])=>!existing[field]&&selected.contact[field])
    .map(([field,column])=>({row:row.rowNumber,column,before:'',after:selected.contact[field]}));
  return {action:updates.length?'update':'noop',reason:updates.length?null:'contact_nothing_to_fill',updates,
    candidate:structuredClone(selected.contact),provenance:structuredClone(selected.provenance)};
}
