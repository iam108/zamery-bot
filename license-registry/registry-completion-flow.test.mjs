import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore,hash} from './state.mjs';
import {REGISTRY_HEADERS} from './google.mjs';
import {normalizeAddress} from './core.mjs';
import {LicenseWorker} from './runtime.mjs';
import {convertUpdate} from './telegram.mjs';
import {convertOwnerUpdate} from './contact-reply-input.mjs';
import {createNotifier} from './notifier.mjs';
import {RegistryCompletionWorker} from './registry-completion.mjs';

const OWNER='123456789';
const BOT='987654321';
const TARGET='-10076543210';
const INN='9705148570';
const ORG='ООО «Хорошот»';
const LICENSE='77РПО0021680';
const SECOND_LICENSE='77РПО0021681';
const ADDRESS='Россия, Москва, ул. Пушкина, д. 1, этаж 1, помещение II';
const SECOND_ADDRESS='Россия, Москва, ул. Ленина, д. 200, строение 3, этаж 2, помещение XV';
const ISSUE='2026-10-28';
const EXPIRY='2027-10-27';
const NOW='2026-11-05T07:00:00.000Z';
const DAY=86_400_000;

function fixtureRow(values={}){
  return Object.assign(Array(17).fill(''),{
    0:'CRM fixture',2:'Сумма сохранена',3:'Папка документов',4:ORG,5:'Фирменное название',16:'Ручной комментарий',...values,
  });
}

function fixtureLicense(values={}){
  return {inn:INN,organization:ORG,licenseNumber:LICENSE,issueDate:ISSUE,expiryDate:EXPIRY,status:'действующая',
    address:ADDRESS,activity:'Розничная продажа алкогольной продукции при оказании услуг общественного питания',...values};
}

function cellData(value){
  if(value==='')return {};
  return {formattedValue:String(value),userEnteredValue:{stringValue:String(value)},effectiveValue:{stringValue:String(value)}};
}

async function harness(t,{values=fixtureRow(),licenses=[fixtureLicense()]}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'registry-completion-flow-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'state.json');
  const newStore=()=>createStore(file);
  const store=newStore();
  await store.update(()=>{});
  const cells=[REGISTRY_HEADERS.map(cellData),values.map(cellData)];
  const batches=[];
  const apiCalls=[];
  const messages=[];
  const logs=[];
  const controls={};
  let updateId=100;
  const google={
    spreadsheetId:'integration-registry-fixture',sheetName:'Реестр лицензий',sheetId:0,now:()=>new Date(NOW),
    async context(){return {values:cells.map(row=>row.map(cell=>cell.formattedValue??'')),startRow:1};},
    async readRow(row){return structuredClone(cells[row-1]);},
    async request(suffix,{body}){
      assert.equal(suffix,':batchUpdate');
      const state=await newStore().read();
      assert.equal(Object.values(state.registry.requests).filter(request=>request.plan?.hash&&request.writeAttempted).length,1);
      batches.push(structuredClone(body));
      for(const operation of body.requests){
        assert.deepEqual(Object.keys(operation),['updateCells']);
        const {start,rows,fields}=operation.updateCells;
        assert.equal(start.sheetId,0);
        assert.equal(start.rowIndex,1);
        assert.ok(start.columnIndex>=6&&start.columnIndex<=15);
        const destination=cells[start.rowIndex][start.columnIndex];
        const source=rows[0].values[0];
        destination.userEnteredValue=structuredClone(source.userEnteredValue);
        destination.effectiveValue=structuredClone(source.userEnteredValue);
        if(source.userEnteredValue.numberValue!=null){
          const iso=new Date((source.userEnteredValue.numberValue-25569)*DAY).toISOString().slice(0,10);
          destination.formattedValue=iso.split('-').reverse().join('.');
        }else{
          destination.formattedValue=source.userEnteredValue.stringValue;
        }
        if(fields.includes('userEnteredFormat.numberFormat')){
          const numberFormat=structuredClone(source.userEnteredFormat.numberFormat);
          destination.userEnteredFormat={...destination.userEnteredFormat,numberFormat};
          destination.effectiveFormat={...destination.effectiveFormat,numberFormat};
        }
      }
      if(controls.loseResponse)throw new Error('Fixture committed before the response was lost');
      return {};
    },
  };
  const telegram={async call(method,params){
    assert.equal(params.chat_id,OWNER);
    const chat={id:Number(OWNER),type:'private'};
    if(method==='getChat')return chat;
    assert.equal(method,'sendMessage');
    const message={message_id:1000+messages.length,date:Date.parse(NOW)/1000,chat,
      from:{id:Number(BOT),is_bot:true},text:params.text};
    messages.push({message,params:structuredClone(params)});
    return message;
  }};
  const api={async request(method,query){
    assert.equal(method,'fsrar');
    assert.equal(query.inn,INN);
    const state=await newStore().read();
    assert.equal(state.registry.apiCache[query.inn].status,'fetching');
    assert.equal(state.api.attemptedCalls,apiCalls.length+1);
    apiCalls.push(query.inn);
    return {http_status:200,response:{items:structuredClone(licenses)}};
  }};
  function worker(){
    return new RegistryCompletionWorker({store:newStore(),google,api,telegram,ownerChatId:OWNER,botId:BOT,
      now:()=>new Date(NOW),log:(entry)=>logs.push(entry)});
  }
  function update(text,replyTo,{sender=OWNER,chat=OWNER,replyBot=BOT}={}){
    updateId++;
    return {update_id:updateId,message:{message_id:2000+updateId,date:Date.parse(NOW)/1000,text,
      chat:{id:Number(chat),type:'private'},from:{id:Number(sender),is_bot:false},
      reply_to_message:{...replyTo,from:{id:Number(replyBot),is_bot:true}}}};
  }
  async function persist(...updates){
    const ingester=new LicenseWorker({store:newStore(),google,api,config:{},now:()=>new Date(NOW)});
    return ingester.persistUpdates(updates,(item)=>convertUpdate(item,{targetChatId:TARGET,botId:BOT}),
      (item)=>convertOwnerUpdate(item,{ownerChatId:OWNER,botId:BOT}));
  }
  return {store,newStore,cells,batches,apiCalls,messages,google,telegram,logs,controls,worker,update,persist};
}

function values(row){return row.map(cell=>cell.formattedValue??'');}
function singleRequest(state){
  const requests=Object.values(state.registry.requests);
  assert.equal(requests.length,1);
  return requests[0];
}

test('private INN prompt accepts an actual Telegram reply and confirms native license dates in the existing row',async(t)=>{
  const h=await harness(t);
  const initial=values(h.cells[1]);
  let worker=h.worker();
  await worker.tick();
  assert.equal(h.messages.length,1);
  const prompt=h.messages[0].message;
  assert.equal(prompt.chat.type,'private');
  assert.match(prompt.text,/Ответь ИНН/u);
  assert.deepEqual(h.apiCalls,[]);
  assert.deepEqual(singleRequest(await h.store.read()).replyMessageIds,[prompt.message_id]);
  const ownerReply=h.update(INN,prompt);
  const persisted=await h.persist(ownerReply);
  assert.equal(persisted.offset,ownerReply.update_id+1);
  assert.deepEqual((await h.store.read()).telegram.inbox,[]);
  assert.equal(await worker.ingestOwnerReplies(),1);
  assert.equal((await worker.tick()).saved,1);
  assert.deepEqual(values(h.cells[1]).slice(6,12),[INN,LICENSE,'28.10.2026','27.10.2027','Общепит ',ADDRESS]);
  for(const index of [8,9]){
    assert.equal(typeof h.cells[1][index].userEnteredValue.numberValue,'number');
    assert.equal(h.cells[1][index].userEnteredFormat.numberFormat.type,'DATE');
  }
  for(const index of [0,1,2,3,4,5,16])assert.equal(values(h.cells[1])[index],initial[index]);
  assert.equal(h.cells.length,2);
  let state=await h.newStore().read();
  const receipt=singleRequest(state).receipts[0];
  assert.equal(receipt.verified,true);
  assert.equal(receipt.cells.I2,ISSUE);
  assert.equal(receipt.cells.J2,EXPIRY);
  assert.equal(state.journal.filter(entry=>entry.type==='registry_completion_write_verified').length,1);
  assert.equal(state.api.attemptedCalls,1);
  assert.deepEqual(state.jobs,{});
  worker=h.worker();
  await h.persist(ownerReply);
  assert.equal(await worker.ingestOwnerReplies(),0);
  assert.equal((await worker.tick()).saved,0);
  state=await h.newStore().read();
  assert.equal(singleRequest(state).receipts.length,1);
  assert.equal(h.batches.length,1);
  assert.deepEqual(h.apiCalls,[INN]);
});

test('the delivered full address list binds a bare choice to the right object and owner',async(t)=>{
  const h=await harness(t,{values:fixtureRow({6:INN}),licenses:[fixtureLicense(),fixtureLicense({licenseNumber:SECOND_LICENSE,address:SECOND_ADDRESS})]});
  const worker=h.worker();
  await worker.tick();
  assert.equal(h.messages.length,1);
  const prompt=h.messages[0].message;
  assert.ok(prompt.text.includes(`1. ${LICENSE}; ${ISSUE} — ${EXPIRY}; ${ADDRESS}`));
  assert.ok(prompt.text.includes(`2. ${SECOND_LICENSE}; ${ISSUE} — ${EXPIRY}; ${SECOND_ADDRESS}`));
  await h.persist(h.update('2',prompt,{sender:'444444'}),h.update('2',prompt,{replyBot:'555555'}));
  assert.equal(await worker.ingestOwnerReplies(),0);
  assert.equal((await worker.tick()).saved,0);
  assert.equal(h.batches.length,0);
  await h.persist(h.update('2',prompt));
  assert.equal(await worker.ingestOwnerReplies(),1);
  assert.equal((await worker.tick()).saved,1);
  assert.equal(h.cells[1][7].formattedValue,SECOND_LICENSE);
  assert.equal(h.cells[1][11].formattedValue,SECOND_ADDRESS);
  assert.equal(h.batches.length,1);
  assert.deepEqual(h.apiCalls,[INN]);
});

test('a committed batch with a lost response resumes from disk and uses only readback',async(t)=>{
  const h=await harness(t,{values:fixtureRow({6:INN})});
  h.controls.loseResponse=true;
  assert.equal((await h.worker().tick()).saved,0);
  const pending=singleRequest(await h.newStore().read());
  assert.ok(pending.plan.hash);
  assert.equal(pending.writeAttempted,true);
  assert.equal(h.batches.length,1);
  h.controls.loseResponse=false;
  assert.equal((await h.worker().tick()).saved,1);
  const recovered=singleRequest(await h.newStore().read());
  assert.equal(recovered.receipts[0].planHash,pending.plan.hash);
  assert.equal(recovered.receipts[0].action,'noop');
  assert.equal(recovered.receipts[0].verified,true);
  assert.equal(h.batches.length,1);
  assert.deepEqual(h.apiCalls,[INN]);
});

test('an INN reply to a real legacy contact notification routes while a contact-only reply stays with contact handling',async(t)=>{
  const h=await harness(t,{values:fixtureRow({6:INN,8:ISSUE,9:EXPIRY,11:ADDRESS})});
  const rowKey=hash([INN,normalizeAddress(ADDRESS),'',ISSUE,EXPIRY]);
  const reviewId=hash([rowKey,'contact_source_ambiguous']);
  await h.store.update((state)=>{state.contacts={reviews:{[reviewId]:{id:reviewId,rowKey,status:'review'}}};});
  const notify=createNotifier({store:h.newStore(),telegram:h.telegram,ownerChatId:OWNER,now:()=>new Date(NOW),log:()=>{}});
  assert.equal((await notify({type:'contact_review_required',jobId:reviewId.slice(0,24),organization:ORG,code:'contact_source_ambiguous'})).delivery,'sent');
  const prompt=h.messages[0].message;
  // Historical notifications kept the rendered text and destination hash but lacked a message ID.
  await h.store.update((state)=>{delete Object.values(state.runtime.notifications)[0].telegramMessageId;});
  const worker=h.worker();
  await worker.tick();
  const contactOnly=h.update('+79991112233 Сергей',prompt);
  const inn=h.update(INN,prompt);
  await h.persist(contactOnly,inn);
  assert.equal(await worker.ingestOwnerReplies(),1);
  let state=await h.newStore().read();
  assert.deepEqual(state.telegram.ownerInbox.map(entry=>entry.updateId),[contactOnly.update_id]);
  assert.deepEqual(state.registry.inbox.map(entry=>entry.updateId),[inn.update_id]);
  await worker.tick();
  state=await h.newStore().read();
  assert.equal(singleRequest(state).provided.inn,INN);
  assert.deepEqual(h.apiCalls,[]);
  assert.equal(h.batches.length,0);
});
