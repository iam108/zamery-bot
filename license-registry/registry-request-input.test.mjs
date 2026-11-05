import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from './state.mjs';
import {renderNotification} from './notifier.mjs';
import {parseRegistryReply,findRegistryRequest} from './registry-request-input.mjs';

const INN='9721255266',OTHER_INN='7707083893',OWNER='123456',BOT='999888';
const REQUEST='a'.repeat(32),OTHER_REQUEST='b'.repeat(32),JOB='c'.repeat(24);
const message=(text='',extra={})=>({kind:'message',ownerChatId:OWNER,fromId:OWNER,chatType:'private',botId:BOT,
  messageId:800,text,replyTo:{messageId:500,fromBotId:BOT,text:'known notification'},...extra});
const request=(extra={})=>({id:REQUEST,ownerChatId:OWNER,botId:BOT,replyMessageIds:[500],notificationJobIds:[],...extra});
const state=(entry=request())=>({registry:{requests:{[REQUEST]:entry},outbox:{}},runtime:{notifications:{}}});
function freeze(value){
  if(value&&typeof value==='object'){for(const nested of Object.values(value))freeze(nested);Object.freeze(value);}return value;
}

test('raw and labelled INNs retain exact digits and require valid 10/12-digit checksums',()=>{
  for(const text of [INN,`ИНН: ${INN}`,`  инн : ${INN}  `])assert.deepEqual(parseRegistryReply(message(text)),{status:'input',inn:INN});
  assert.deepEqual(parseRegistryReply(message('500100732259')),{status:'input',inn:'500100732259'});
  for(const text of ['9721255267','0000000000','500100732258','1234567890123','ИНН: 123',
    `ИНН: ${INN}, ${OTHER_INN}`,`${INN}\n${OTHER_INN}`,`${INN}\nИНН: ${INN}`])assert.deepEqual(parseRegistryReply(message(text)),{status:'invalid'});
});

test('bare numbered choices and labelled choices are bounded and never turn an INN into an index',()=>{
  for(const [text,objectChoice] of [['1',1],['2',2],['20',20],['1000',1000],['Объект: 2',2]])
    assert.deepEqual(parseRegistryReply(message(text)),{status:'input',objectChoice});
  for(const text of ['0','-1','1001','Объект: 0','Объект: 1001','Объект: 01','2\nОбъект: 3'])
    assert.deepEqual(parseRegistryReply(message(text)),{status:'invalid'});
  const inn=parseRegistryReply(message(INN));assert.equal(inn.inn,INN);assert.equal(inn.objectChoice,undefined);
});

test('global identity fields are extracted exactly before contact parsing',()=>{
  const input=`ИНН: ${INN}\nАдрес: Москва, ул. Тестовая, д. 1\nНомер лицензии: № 77 рпо 0021046\nСтрока: 653\nИмя: Анна\nТелефон: +79990000001`;
  assert.deepEqual(parseRegistryReply(message(input)),{status:'input',inn:INN,address:'Москва, ул. Тестовая, д. 1',
    licenseNumber:'77РПО0021046',rowNumber:653,contact:{name:'Анна',phone:'+79990000001'}});
  assert.deepEqual(parseRegistryReply(message('Объект: Москва, Тестовая улица, 1')),{status:'input',address:'Москва, Тестовая улица, 1'});
  assert.deepEqual(parseRegistryReply(message('Лицензия: 77РПО0021046')),{status:'input',licenseNumber:'77РПО0021046'});
  assert.deepEqual(parseRegistryReply(message('Строка: 2')),{status:'input',rowNumber:2});
});

test('date hints normalize valid dates but reject impossible dates, unknown suffixes, duplicate labels and inverted periods',()=>{
  assert.deepEqual(parseRegistryReply(message('Дата выдачи: 17.04.2026\nДата окончания: 16 апреля 2029')),
    {status:'input',issueDate:'2026-04-17',expiryDate:'2029-04-16'});
  assert.deepEqual(parseRegistryReply(message('Дата окончания: 2029-04-16')),{status:'input',expiryDate:'2029-04-16'});
  for(const text of ['Дата выдачи: 31.02.2026','Дата выдачи: 2026-04-17Tunknown',
    'Дата выдачи: 2029-04-17\nДата окончания: 2026-04-16','Дата окончания: 2029-04-16\nДата окончания: 2029-04-16'])
    assert.deepEqual(parseRegistryReply(message(text)),{status:'invalid'});
});

test('multiple contacts reuse the strict paired parser after removing global metadata',()=>{
  const parsed=parseRegistryReply(message(`ИНН: ${INN}\nОбъект: 2\n+79990000001 Сергей\n+79990000002 Алёна\nTelegram: @client_fixture`));
  assert.deepEqual(parsed,{status:'input',inn:INN,objectChoice:2,contact:{name:'Сергей\nАлёна',phone:'+79990000001\n+79990000002',
    persons:[{name:'Сергей',phone:'+79990000001'},{name:'Алёна',phone:'+79990000002'}],telegram:'https://t.me/client_fixture'}});
  const labelled=parseRegistryReply(message(`ИНН: ${INN}\nИмя: Сергей\nТелефон: +79990000001\nИмя: Алёна\nТелефон: +79990000002`));
  assert.equal(labelled.status,'input');assert.equal(labelled.contact.persons.length,2);
});

test('native contacts work with an INN while unknown text and partial contacts reject the complete reply',()=>{
  const nativeContact={firstName:'Анна',lastName:'Иванова',phoneNumber:'+79990000001',userId:'777'};
  assert.deepEqual(parseRegistryReply(message(`ИНН: ${INN}`,{nativeContact})),{status:'input',inn:INN,contact:{name:'Анна Иванова',phone:'+79990000001'}});
  for(const text of [`ИНН: ${INN}\nСпасибо`, `ИНН: ${INN}\nИмя: Анна`,`ИНН: ${INN}\nКонтакт без номера`,
    `ИНН: ${INN}\nКомментарий: все верно`,`ИНН организации: ${INN}`])assert.deepEqual(parseRegistryReply(message(text)),{status:'invalid'});
  assert.deepEqual(parseRegistryReply(message(`ИНН: ${INN}\nСпасибо`,{nativeContact})),{status:'invalid'});
});

test('empty, truncated, control-containing and duplicate identity fields fail without partial extraction',()=>{
  for(const text of ['',`ИНН: ${INN}\u0000`,'Адрес:','Адрес: 2','Лицензия: P001-1234','Строка: 1','Строка: 100001',
    'Адрес: Москва\nОбъект: Москва','Лицензия: 77РПО0021046\nНомер лицензии: 77РПО0021046'])
    assert.deepEqual(parseRegistryReply(message(text)),{status:'invalid'});
  assert.deepEqual(parseRegistryReply(message(INN,{textTruncated:true})),{status:'invalid'});
  assert.deepEqual(parseRegistryReply(message('x'.repeat(4097))),{status:'invalid'});
});

test('reserved callbacks have an exact request and 1-based object index or retry/skip action',()=>{
  assert.deepEqual(parseRegistryReply({kind:'callback',data:`rg:${REQUEST}:object:2`}),{status:'input',requestId:REQUEST,objectChoice:2});
  for(const action of ['retry','skip'])assert.deepEqual(parseRegistryReply({kind:'callback',data:`rg:${REQUEST}:${action}`}),{status:'input',requestId:REQUEST,action});
  for(const data of [`cr:${REQUEST}:replace`,`rg:${REQUEST}:object:0`,`rg:${REQUEST}:object:1001`,`rg:${REQUEST}:object:01`,
    `rg:${REQUEST}:object:2:retry`,`rg:${REQUEST}:replace`,`rg:${'A'.repeat(32)}:retry`])assert.deepEqual(parseRegistryReply({kind:'callback',data}),{status:'invalid'});
});

test('standalone retry and skip words work without accepting a mixed instruction', () => {
  for (const text of ['Повторить', 'повторить проверку', '  ПОВТОРИТЬ  ']) {
    assert.deepEqual(parseRegistryReply(message(text)), {status:'input',action:'retry'});
  }
  assert.deepEqual(parseRegistryReply(message('Пропустить')), {status:'input',action:'skip'});
  for (const text of ['Повторить!', 'Можно повторить?', `Повторить\nИНН: ${INN}`, 'Пропустить\nИмя: Анна']) {
    assert.deepEqual(parseRegistryReply(message(text)), {status:'invalid'});
  }
  const nativeContact = {firstName:'Анна',phoneNumber:'+79990000001'};
  assert.deepEqual(parseRegistryReply(message('Повторить', {nativeContact})), {status:'invalid'});
});

test('request delivery IDs and sent outbox aliases bind the exact request without mutating state',()=>{
  const original=state();const frozen=freeze(structuredClone(original));
  assert.equal(findRegistryRequest(frozen,freeze(message())),REQUEST);
  assert.deepEqual(frozen,original);
  const byOutbox=state(request({replyMessageIds:[]}));byOutbox.registry.outbox.message={requestId:REQUEST,status:'sent',telegramMessageId:500};
  assert.equal(findRegistryRequest(byOutbox,message()),REQUEST);
  byOutbox.registry.outbox.message.status='pending';assert.equal(findRegistryRequest(byOutbox,message()),null);
  const plural=state(request({replyMessageIds:[],telegramMessageIds:['500']}));assert.equal(findRegistryRequest(plural,message()),REQUEST);
});

test('owner, bot and private-chat scope are required for all saved aliases',()=>{
  for(const extra of [{ownerChatId:'777',fromId:'777'},{fromId:'777'},{botId:'777'},{chatType:'group'},
    {replyTo:{messageId:500,fromBotId:'777',text:'known notification'}}])assert.equal(findRegistryRequest(state(),message('',extra)),null);
  for(const change of [{ownerChatId:'777'},{botId:'777'},{botId:undefined}])assert.equal(findRegistryRequest(state(request(change)),message()),null);
  const wrongOutbox=state(request({replyMessageIds:[]}));wrongOutbox.registry.outbox.entry={requestId:REQUEST,status:'sent',telegramMessageId:500,ownerChatId:'777'};
  assert.equal(findRegistryRequest(wrongOutbox,message()),null);
});

test('conflicting delivery aliases and callbacks attached to another request fail closed',()=>{
  const ambiguous=state();ambiguous.registry.requests[OTHER_REQUEST]=request({id:OTHER_REQUEST});
  assert.equal(findRegistryRequest(ambiguous,message()),null);
  const callback={...message(),kind:'callback',messageId:500,data:`rg:${REQUEST}:object:2`};
  assert.equal(findRegistryRequest(state(),callback),REQUEST);
  assert.equal(findRegistryRequest(state(),{...callback,data:`rg:${OTHER_REQUEST}:retry`}),null);
  assert.equal(findRegistryRequest(state(),{...callback,data:`cr:${REQUEST}:replace`}),null);
  assert.equal(findRegistryRequest(state(),{...callback,messageId:501}),null);
});

test('legacy notification aliases work across company notification types with exact saved IDs or exact rendered text',()=>{
  for(const type of ['contact_review_required','review_required','processing_error','write_verified','contact_write_verified']){
    const event={type,jobId:JOB,organization:'ООО Тест',code:'invalid_license_fields',action:'update',columns:type==='contact_write_verified'?['M','N']:['I','J']};
    const s=state(request({replyMessageIds:[],notificationJobIds:[JOB]}));
    s.runtime.notifications.legacy={status:'sent',destinationHash:hash(OWNER),event};
    const reply=message('',{replyTo:{messageId:700,fromBotId:BOT,text:renderNotification(event)}});
    assert.equal(findRegistryRequest(s,reply),REQUEST);
    s.runtime.notifications.legacy.telegramMessageId=700;
    assert.equal(findRegistryRequest(s,{...reply,replyTo:{...reply.replyTo,text:'edited bot text'}}),REQUEST);
    assert.equal(findRegistryRequest(s,{...reply,replyTo:{...reply.replyTo,messageId:701}}),null);
  }
});

test('legacy matching requires an explicit unique job alias, exact text and correct destination hash',()=>{
  const event={type:'review_required',jobId:JOB,organization:'ООО Тест',code:'invalid_license_fields'};
  const s=state(request({replyMessageIds:[],notificationJobIds:[JOB]}));
  s.runtime.notifications.legacy={status:'pending',destinationHash:hash(OWNER),event};
  const reply=message('',{replyTo:{messageId:700,fromBotId:BOT,text:renderNotification(event)}});
  assert.equal(findRegistryRequest(s,reply),REQUEST);
  assert.equal(findRegistryRequest(s,{...reply,replyTo:{...reply.replyTo,text:`${reply.replyTo.text} `}}),null);
  assert.equal(findRegistryRequest(s,{...reply,replyTo:{...reply.replyTo,textTruncated:true}}),null);
  s.registry.requests[REQUEST].notificationJobIds=[];assert.equal(findRegistryRequest(s,reply),null);
  s.registry.requests[REQUEST].notificationJobIds=[JOB];s.runtime.notifications.legacy.destinationHash=hash('777');
  assert.equal(findRegistryRequest(s,reply),null);
  s.runtime.notifications.legacy.destinationHash=hash(OWNER);
  s.registry.requests[OTHER_REQUEST]=request({id:OTHER_REQUEST,replyMessageIds:[],notificationJobIds:[JOB]});
  assert.equal(findRegistryRequest(s,reply),null);
});
