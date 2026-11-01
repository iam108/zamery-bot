'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLargeDelivery } = require('../src/bot/egrn-large-delivery');

const FILE_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_FILE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PDF = Buffer.from('%PDF-1.7\nEGRN original test bytes\n%%EOF');
const KEY = 'embedded:0:ЕГРН.pdf';
const copy = value => JSON.parse(JSON.stringify(value));

function fixture(overrides = {}) {
  const events = [], sends = [], snapshots = [], records = [];
  const order = {id:7,cad_num:'77:01:0004016:1064',label:'Тестовый объект',chat_id:-1001,status_msg_id:77,ordered_by:3003,deliver:[{chat:2002,reply:88}]};
  const meta = {id:FILE_ID,egrn_order_id:7,source_key:KEY,name:'ЕГРН.pdf',mime:'application/pdf',bytes:PDF.length};
  const state = {saveCount:0,getCount:0,signCount:0,persistCount:0,nextMessage:101,failChats:new Set(),failPersistAt:null};
  const store = {
    async save(input) {state.saveCount++;events.push(['save',input]);return {...meta};},
    async get(id) {state.getCount++;events.push(['get',id]);return {...meta};}
  };
  const makeUrl = async id => {state.signCount++;events.push(['sign',id]);return 'https://files.example.test/egrn/'+id+'?signature=SIGNED-'+state.signCount;};
  const telegram = { async sendMessage(chat,text,options) {
    const call={chat,text,options};sends.push(call);events.push(['send',chat,options.reply_parameters?.message_id]);
    if(state.failChats.has(chat))throw new Error('https://api.telegram.org/botSECRET/sendMessage?token=PRIVATE');
    return {message_id:state.nextMessage++};
  }};
  const persist = async (value,list) => {
    state.persistCount++;events.push(['persist',state.persistCount]);assert.equal(value,order);assert.equal(list,records);
    const snapshot=copy(list);snapshots.push(snapshot);
    assert.doesNotMatch(JSON.stringify(snapshot),/https?:\/\/|SIGNED-|PRIVATE|SECRET|signature=/);
    if(state.failPersistAt===state.persistCount)throw new Error('postgres://user:SECRET@private.example/database');
  };
  const options = {store,makeUrl,telegram,persist,...overrides};
  return {events,sends,snapshots,records,order,meta,state,store,options,service:createLargeDelivery(options),file:{name:'ЕГРН.pdf',buf:PDF}};
}
function safeTemporary(error) {
  assert.equal(error.code,'EGRN_LARGE_DELIVERY_TEMPORARY');assert.equal(error.temporary,true);
  assert.match(error.message,/Повторим отправку автоматически/);
  assert.doesNotMatch(error.message,/https?:|postgres:|SECRET|SIGNED|PRIVATE|token|signature/);
  assert.equal(error.cause,undefined);return true;
}
function lookupOnlyRecord(order = {}) {
  return {key:KEY,kind:'link',original_id:FILE_ID,name:'ЕГРН.pdf',mime:'application/pdf',bytes:100*1024*1024,
    cad_num:'77:01:0004016:1064',label:'Тестовый объект',deliveries:[],chat:-1001,...order};
}

test('original and descriptor are durable before a link is sent; every target receipt is persisted immediately',async()=>{
  const h=fixture(),record=await h.service.deliver(h.order,h.file,KEY,h.records);
  assert.equal(record,h.records[0]);assert.equal(h.records.length,1);assert.equal(h.state.saveCount,1);
  assert.equal(h.events[0][0],'save');assert.equal(h.events[0][1].egrn_order_id,7);assert.equal(h.events[0][1].source_key,KEY);
  assert.equal(h.events[0][1].buffer,PDF,'Do not base64-encode or duplicate the original Buffer');
  assert.deepEqual(h.events.filter(e=>e[0]==='persist'||e[0]==='send').map(e=>e[0]),['persist','send','persist','send','persist','send','persist']);
  assert.deepEqual(h.snapshots.map(s=>s[0].deliveries.length),[0,1,2,3]);
  assert.deepEqual(h.sends.map(s=>[s.chat,s.options.reply_parameters?.message_id]),[[-1001,77],[2002,88],[3003,undefined]]);
  assert.equal(record.chat,-1001);assert.equal(record.id,101);assert.equal(record.original_id,FILE_ID);
  assert.equal(record.kind,'link');assert.equal(record.mime,'application/pdf');assert.equal(record.bytes,PDF.length);
  assert.equal(record.cad_num,h.order.cad_num);assert.equal(record.label,h.order.label);
  for(const send of h.sends){
    assert.equal(send.options.disable_web_page_preview,true);assert.equal(send.options.parse_mode,undefined);
    assert.match(send.text,/77:01:0004016:1064/);assert.match(send.text,/ЕГРН.pdf/);assert.ok(!send.text.includes('https://'));
    assert.equal(send.options.reply_markup.inline_keyboard[1][0].callback_data,'egf:'+FILE_ID);
    assert.equal(send.options.reply_markup.inline_keyboard[1][0].text,'Обновить ссылку');
    if(send.options.reply_parameters)assert.equal(send.options.reply_parameters.allow_sending_without_reply,true);
  }
});

test('main, targets and requester are deduplicated by chat and reply while invalid chats never become zero',async()=>{
  const h=fixture();h.order.deliver=[{chat:'-1001',reply:'77'},{chat:2002,reply:88},{chat:'2002',reply:'88'},{chat:3003},
    null,{}, {chat:null},{chat:undefined},{chat:''},{chat:'invalid'},{chat:0},{chat:false},{chat:Infinity}];
  await h.service.deliver(h.order,h.file,KEY,h.records);
  assert.deepEqual(h.sends.map(s=>s.chat),[-1001,2002,3003]);
  const same=fixture();same.order.chat_id=3003;same.order.deliver=[{chat:'3003',reply:'77'},{chat:3003,reply:99}];
  await same.service.deliver(same.order,same.file,KEY,same.records);
  assert.deepEqual(same.sends.map(s=>s.options.reply_parameters.message_id),[77,99]);
  assert.equal(same.sends.length,2,'The requester must not receive another unthreaded copy in its main chat');
});

test('a Telegram failure does not block the other targets and retry sends only the unconfirmed target with a fresh signature',async()=>{
  const h=fixture();h.state.failChats.add(2002);
  await assert.rejects(h.service.deliver(h.order,h.file,KEY,h.records),safeTemporary);
  const record=h.records[0];assert.deepEqual(h.sends.map(s=>s.chat),[-1001,2002,3003]);
  assert.deepEqual(record.deliveries.map(d=>d.chat),[-1001,3003]);assert.equal(record.id,101);
  const failedUrl=h.sends[1].options.reply_markup.inline_keyboard[0][0].url;
  h.state.failChats.clear();const before=h.sends.length;
  assert.equal(await h.service.retry(h.order,record,h.records),record);
  assert.deepEqual(h.sends.slice(before).map(s=>s.chat),[2002]);assert.equal(h.state.saveCount,1);assert.equal(h.state.getCount,1);
  assert.notEqual(h.sends.at(-1).options.reply_markup.inline_keyboard[0][0].url,failedUrl);
  assert.equal(record.deliveries.length,3);const finished=h.sends.length;
  await h.service.retry(h.order,record,h.records);assert.equal(h.sends.length,finished,'A fully receipted retry is a no-op after checking the stored original');
});

test('when the main message fails, other receipts remain reusable and a later retry supplies the main message id',async()=>{
  const h=fixture();h.state.failChats.add(-1001);
  await assert.rejects(h.service.deliver(h.order,h.file,KEY,h.records),safeTemporary);
  assert.equal(h.records[0].id,undefined);assert.deepEqual(h.records[0].deliveries.map(d=>d.chat),[2002,3003]);
  h.state.failChats.clear();const previous=h.sends.length;await h.service.retry(h.order,h.records[0],h.records);
  assert.deepEqual(h.sends.slice(previous).map(s=>s.chat),[-1001]);assert.equal(h.records[0].id,103);
});

test('an unacknowledged Telegram response is retriable rather than a fabricated delivery receipt',async()=>{
  const h=fixture();const send=h.options.telegram.sendMessage;
  h.options.telegram.sendMessage=async(...args)=>{const response=await send(...args);return args[0]===2002?{}:response;};
  await assert.rejects(h.service.deliver(h.order,h.file,KEY,h.records),safeTemporary);
  assert.deepEqual(h.sends.map(value=>value.chat),[-1001,2002,3003]);
  assert.deepEqual(h.records[0].deliveries.map(value=>value.chat),[-1001,3003]);
  h.options.telegram.sendMessage=send;const before=h.sends.length;await h.service.retry(h.order,h.records[0],h.records);
  assert.deepEqual(h.sends.slice(before).map(value=>value.chat),[2002]);
});

test('repeated delivery of the same durable descriptor does not duplicate messages or records',async()=>{
  const h=fixture();const record=await h.service.deliver(h.order,h.file,KEY,h.records);const previous=h.sends.length;
  assert.equal(await h.service.deliver(h.order,h.file,KEY,h.records),record);
  assert.equal(h.records.length,1);assert.equal(h.sends.length,previous);assert.equal(record.deliveries.length,3);
});

test('a persistence failure before the first notification produces no Telegram sends',async()=>{
  const h=fixture();h.state.failPersistAt=1;
  await assert.rejects(h.service.deliver(h.order,h.file,KEY,h.records),safeTemporary);
  assert.equal(h.state.saveCount,1);assert.equal(h.records.length,1);assert.deepEqual(h.records[0].deliveries,[]);
  assert.equal(h.sends.length,0);assert.equal(h.state.signCount,0);
});

test('a persistence failure after one notification stops the batch immediately and retains its in-memory receipt',async()=>{
  const h=fixture();h.state.failPersistAt=2;
  await assert.rejects(h.service.deliver(h.order,h.file,KEY,h.records),safeTemporary);
  assert.deepEqual(h.sends.map(s=>s.chat),[-1001]);assert.equal(h.records[0].deliveries.length,1);
  assert.equal(h.records[0].deliveries[0].id,101);assert.equal(h.records[0].id,101);
});

test('missing sender/persistence, storage failure, missing signer configuration or unsafe URLs never report success or send a link',async()=>{
  for(const overrides of [
    {telegram:null},{persist:null},{store:{}},
    {store:{save:async()=>{throw new Error('SECRET storage credentials');}}},
    {makeUrl:async()=>{throw new Error('SECRET signing key https://private.example/token');}},
    {makeUrl:async()=> 'javascript:alert(1)'},{makeUrl:async()=> 'http://files.example.test/egrn?signature=SECRET'},
    {makeUrl:async()=> 'https://user:SECRET@files.example.test/egrn'}
  ]){
    const h=fixture(overrides);await assert.rejects(h.service.deliver(h.order,h.file,KEY,h.records),safeTemporary);
    assert.equal(h.sends.length,0);
  }
});

test('an empty or malformed recipient list cannot be marked delivered',async()=>{
  const h=fixture();h.order.chat_id=null;h.order.ordered_by=0;h.order.deliver=[null,{chat:null},{chat:0},{chat:false},{chat:'no'}];
  await assert.rejects(h.service.deliver(h.order,h.file,KEY,h.records),safeTemporary);
  assert.equal(h.sends.length,0);assert.equal(h.records[0].chat,null);assert.deepEqual(h.records[0].deliveries,[]);
});

test('retry validates a metadata-only original before notifying anyone and never fetches its file bytes',async()=>{
  const h=fixture(),record=lookupOnlyRecord();h.records.push(record);
  h.store.get=async id=>{
    h.state.getCount++;assert.equal(id,FILE_ID);const meta={...h.meta,bytes:record.bytes};
    Object.defineProperty(meta,'buffer',{get(){assert.fail('Retry must not read a 100 MB original');}});return meta;
  };
  await h.service.retry(h.order,record,h.records);
  assert.equal(h.state.saveCount,0);assert.equal(h.state.getCount,1);assert.equal(h.sends.length,3);
  assert.equal(h.sends[0].options.reply_markup.inline_keyboard[0][0].text,'Скачать выписку · 100 МБ');
  for(const invalid of [null,{...h.meta,id:OTHER_FILE_ID},{...h.meta,egrn_order_id:8},{...h.meta,bytes:record.bytes+1}]){
    const previous=h.sends.length;h.store.get=async()=>invalid;
    await assert.rejects(h.service.retry(h.order,record,h.records),safeTemporary);assert.equal(h.sends.length,previous);
  }
});

test('manual copying issues a new signed link without changing historical receipts or persistence',async()=>{
  const h=fixture(),record=await h.service.deliver(h.order,h.file,KEY,h.records);
  const original=copy(record),persisted=h.state.persistCount,before=h.sends.length;
  const first=await h.service.copy(record,{chat:4004,reply:9});const firstUrl=h.sends.at(-1).options.reply_markup.inline_keyboard[0][0].url;
  const second=await h.service.copy(record,{chat:4004,reply:9});
  assert.notEqual(first.message_id,second.message_id);assert.equal(h.sends.length,before+2);
  assert.notEqual(h.sends.at(-1).options.reply_markup.inline_keyboard[0][0].url,firstUrl);
  assert.equal(h.sends.at(-1).options.reply_parameters.message_id,9);assert.equal(h.state.persistCount,persisted);
  assert.deepEqual(record,original);assert.equal(h.state.saveCount,1);assert.equal(h.state.getCount,2);
});

test('manual copy rejects a missing original or invalid target without changing its receipt history',async()=>{
  const h=fixture(),record=await h.service.deliver(h.order,h.file,KEY,h.records),before=copy(record),sent=h.sends.length;
  await assert.rejects(h.service.copy(record,{chat:null}),safeTemporary);
  h.store.get=async()=>null;await assert.rejects(h.service.copy(record,{chat:4004}),safeTemporary);
  assert.equal(h.sends.length,sent);assert.deepEqual(record,before);
});
