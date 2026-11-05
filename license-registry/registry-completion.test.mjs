import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore,hash} from './state.mjs';
import {REGISTRY_HEADERS} from './google.mjs';
import {normalizeAddress} from './core.mjs';
import {renderNotification} from './notifier.mjs';
import {convertOwnerUpdate} from './contact-reply-input.mjs';
import {verifyRegistryGapPlan} from './registry-gap-google.mjs';
import {RegistryCompletionWorker} from './registry-completion.mjs';

const OWNER='123456',BOT='987654',INN='9705148570',ORG='ООО «ХОРОШОТ»',NUMBER='77РПО0021680';
const ADDRESS='Москва, ул. Пушкина, д. 1',ADDRESS2='Москва, ул. Ленина, д. 200, помещение 15, этаж 2';
const ISSUE='2026-10-28',EXPIRY='2027-10-27',TODAY='2026-11-05T06:30:00Z';
const clone=(value)=>structuredClone(value);
const row=(fields={})=>Object.assign(Array(17).fill(''),{0:'PRIVATE_LINK',4:ORG,16:'Manual comment'},fields);
const record=(fields={})=>({inn:INN,organization:ORG,licenseNumber:NUMBER,issueDate:ISSUE,expiryDate:EXPIRY,
  status:'действующая',address:ADDRESS,activity:'Розничная продажа алкогольной продукции при оказании услуг общественного питания',email:'client@example.test',...fields});
const response=(items)=>({http_status:200,response:{items}});
const cell=(value)=>value===''?{}:{formattedValue:String(value),effectiveValue:{stringValue:String(value)},userEnteredValue:{stringValue:String(value)}};
const formatDate=(serial)=>new Date((serial-25569)*86400000).toISOString().slice(0,10).split('-').reverse().join('.');

async function fixture(t,{rows=[row()],items=[record()],config={},used=0}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'registry-completion-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createStore(path.join(directory,'state.json')),controls={},batches=[],sent=[],calls=[],logs=[];
  const cells=[[...REGISTRY_HEADERS],...rows].map((values)=>values.map(cell));
  let now=Date.parse(TODAY),messageCounter=1000,updateCounter=0;
  await store.update((state)=>{Object.assign(state.config,config);state.api.attemptedCalls=used;state.telegram={offset:0,inbox:[],ownerInbox:[]};});
  const google={spreadsheetId:'registry-fixture',sheetName:'Реестр лицензий',sheetId:0,now:()=>new Date(now),
    async context(){return {values:cells.map((values)=>values.map((value)=>value.formattedValue??'')),startRow:1};},
    async readRow(number){return clone(cells[number-1]);},
    async request(suffix,{body}){
      assert.equal(suffix,':batchUpdate');const state=await store.read();
      assert.ok(Object.values(state.registry.requests).some((request)=>request.plan?.hash&&request.writeAttempted));
      await controls.beforeBatch?.();batches.push(clone(body));
      for(const {updateCells:update} of body.requests){
        assert.ok(update.start.columnIndex>=6&&update.start.columnIndex<=15);
        const existing=cells[update.start.rowIndex][update.start.columnIndex],next=update.rows[0].values[0];
        existing.userEnteredValue=clone(next.userEnteredValue);existing.effectiveValue=clone(next.userEnteredValue);
        existing.formattedValue=next.userEnteredValue.numberValue!=null?formatDate(next.userEnteredValue.numberValue):next.userEnteredValue.stringValue;
        if(next.userEnteredFormat){existing.userEnteredFormat=clone(next.userEnteredFormat);existing.effectiveFormat=clone(next.userEnteredFormat);}
      }
      await controls.afterBatch?.();return {};
    }};
  const api={async request(method,{inn}){
    assert.equal(method,'fsrar');const state=await store.read();assert.equal(state.registry.apiCache[inn].status,'fetching');
    assert.equal(state.api.attemptedCalls,used+calls.length+1);calls.push(inn);
    return controls.api?controls.api(inn):response(typeof items==='function'?items(inn):items);
  }};
  const telegram={async call(method,params){
    if(method==='answerCallbackQuery')return true;
    assert.equal(method,'sendMessage');assert.equal(params.chat_id,OWNER);assert.ok(params.text.length<=4096);
    const result={message_id:messageCounter++,chat:{id:Number(OWNER),type:'private'},from:{id:Number(BOT),is_bot:true}};
    sent.push({...clone(params),result});return result;
  }};
  const options={store,google,api,telegram,ownerChatId:OWNER,botId:BOT,now:()=>new Date(now),log:(item)=>logs.push(item)};
  const add=async(event)=>{await store.update((state)=>state.telegram.ownerInbox.push({event,updateId:event.updateId,receivedAt:new Date(now).toISOString()}));return event;};
  const reply=async(text,message=sent.at(-1))=>{
    const raw={update_id:++updateCounter,message:{message_id:2000+updateCounter,date:Math.floor(now/1000),chat:{id:Number(OWNER),type:'private'},
      from:{id:Number(OWNER)},text,reply_to_message:{message_id:message.result.message_id,text:message.text,from:{id:Number(BOT),is_bot:true}}}};
    return add(convertOwnerUpdate(raw,{ownerChatId:OWNER,botId:BOT}));
  };
  const callback=async(data,message=sent.at(-1))=>{
    const raw={update_id:++updateCounter,callback_query:{id:`callback-${updateCounter}`,data,from:{id:Number(OWNER)},message:{...message.result,
      date:Math.floor(now/1000),text:message.text}}};return add(convertOwnerUpdate(raw,{ownerChatId:OWNER,botId:BOT}));
  };
  const worker=(extra={})=>new RegistryCompletionWorker({...options,...extra});
  const requests=async()=>Object.values((await store.read()).registry?.requests??{});
  const tick=async(extra)=>{const w=worker(extra);await w.ingestOwnerReplies();return w.tick();};
  return {store,google,api,controls,cells,batches,sent,calls,logs,add,reply,callback,worker,tick,requests,advance:(ms)=>{now+=ms;}};
}

test('owner INN → FSRAR → guarded native dates → restart → private contact reply and durable ack',async(t)=>{
  const h=await fixture(t);const original=h.cells[1].slice();let summary=await h.tick();
  assert.equal(summary.discovered,1);assert.equal(summary.sent,1);assert.equal(h.calls.length,0);
  assert.match(h.sent[0].text,/Ответь ИНН/);assert.doesNotMatch(h.sent[0].text,/Телефон:/);
  const event=await h.reply(INN,h.sent[0]);summary=await h.tick();assert.deepEqual([summary.fetched,summary.saved],[1,1]);
  assert.deepEqual(h.cells[1].slice(6,12).map((c)=>c.formattedValue),[INN,NUMBER,'28.10.2026','27.10.2027','Общепит ',ADDRESS]);
  assert.equal(h.cells[1][15].formattedValue,'client@example.test');assert.equal(h.cells[1][16].formattedValue,original[16].formattedValue);
  assert.equal(h.cells.length,2);assert.equal(h.batches.length,1);assert.equal((await h.requests()).length,1);
  await h.add(event);assert.equal((await h.tick()).saved,0);assert.equal(h.calls.length,1);
  h.advance(60000);summary=await h.tick();assert.equal(summary.discovered,0);assert.match(h.sent.at(-1).text,/имя|именем/iu);
  await h.reply('+79991112233 Сергей\n+79994445566 Алёна\nTelegram: @client_fixture');summary=await h.tick();assert.equal(summary.saved,1);
  assert.deepEqual(h.cells[1].slice(12,15).map((c)=>c.formattedValue),['Сергей\nАлёна','+79991112233\n+79994445566','https://t.me/client_fixture']);
  await h.tick();const requests=await h.requests(),state=await h.store.read();assert.equal(requests.length,1);assert.equal(requests[0].status,'done');
  assert.equal(requests[0].receipts.length,2);assert.ok(requests[0].receipts.every((receipt)=>receipt.verified));
  assert.equal(state.journal.filter((entry)=>entry.type==='registry_completion_write_verified').length,2);assert.equal(state.api.attemptedCalls,1);
});

test('uses one cached API query across objects and never copies a license represented in another row',async(t)=>{
  const second='77РПО0021681';const h=await fixture(t,{rows:[row({6:INN,7:NUMBER,8:ISSUE,9:EXPIRY,11:ADDRESS,12:'Имя',13:'+79991112233'}),
    row({6:INN,11:ADDRESS2}),row({6:INN,11:ADDRESS})],items:[record(),record({licenseNumber:second,address:ADDRESS2})]});
  const result=await h.tick();assert.equal(result.fetched,1);assert.equal(result.saved,1);assert.equal(h.batches.length,1);
  assert.equal(h.cells[2][7].formattedValue,second);assert.equal(h.cells[3][7].formattedValue,undefined);
  const blocked=(await h.requests()).find((request)=>request.rowNumber===4);assert.equal(blocked.reason,'represented_license');assert.equal(blocked.status,'api_waiting');
});

test('full numbered objects use their exact delivered candidate version; stale numbers never select a new object',async(t)=>{
  const second='77РПО0021681';const h=await fixture(t,{rows:[row({6:INN})],items:[record(),record({licenseNumber:second,address:ADDRESS2})]});
  await h.tick();const old=h.sent[0],request=(await h.requests())[0];assert.match(old.text,new RegExp(ADDRESS2.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),'u'));
  assert.equal(old.reply_markup.inline_keyboard[1][0].callback_data,`rg:${request.id}:object:2`);
  await h.store.update((state)=>{const current=state.registry.requests[request.id];current.candidates.reverse();current.candidateVersion=hash(current.candidates);});
  await h.reply('2',old);await h.tick();assert.equal(h.batches.length,0);assert.equal((await h.requests())[0].selectedCandidateHash,undefined);
  await h.store.update((state)=>{const current=state.registry.requests[request.id];current.candidates.reverse();current.candidateVersion=hash(current.candidates);});
  await h.callback(`rg:${request.id}:object:2`,old);assert.equal((await h.tick()).saved,1);
  assert.equal(h.cells[1][7].formattedValue,second);assert.equal(h.cells[1][11].formattedValue,ADDRESS2);assert.equal(h.calls.length,1);
});

test('manual INN name mismatch cannot write G until owner confirms on the exact warning',async(t)=>{
  const h=await fixture(t,{items:[record({organization:'ООО Другая компания'})]});await h.tick();const initial=h.sent[0];
  await h.reply(INN,initial);await h.tick();const warning=h.sent.at(-1);assert.match(warning.text,/Другая компания/u);
  assert.equal(h.cells[1][6].formattedValue,undefined);assert.equal(h.batches.length,0);
  await h.reply(INN,initial);await h.tick();assert.equal(h.batches.length,0);
  await h.reply(INN,warning);assert.equal((await h.tick()).saved,1);assert.equal(h.cells[1][6].formattedValue,INN);assert.equal(h.calls.length,1);
});

test('spends at most three per tick and seven per day, preserving the primary worker headroom and reserve',async(t)=>{
  const inns=Array.from({length:8},(_,i)=>{const base=`97051485${i}`;return base+[...base].reduce((sum,d,index)=>sum+Number(d)*[2,4,10,3,5,9,4,6,8][index],0)%11%10;});
  const h=await fixture(t,{rows:inns.map((inn,index)=>row({4:`ООО Компания ${index}`,6:inn})),items:[]});
  assert.equal((await h.tick()).fetched,3);h.advance(60000);assert.equal((await h.tick()).fetched,3);
  h.advance(60000);assert.equal((await h.tick()).fetched,1);h.advance(60000);assert.equal((await h.tick()).fetched,0);
  let state=await h.store.read();assert.equal(state.api.daily['2026-11-05'],7);assert.ok(h.sent.length<=20);
  const quota=await fixture(t,{rows:[row({6:INN})],used:80});assert.equal((await quota.tick()).fetched,0);
  assert.equal((await quota.requests())[0].reason,'api_quota_reserve');state=await quota.store.read();assert.equal(state.api.attemptedCalls,80);
});

test('primary decisions get priority; negative evidence retries next morning and stops at configured attempts',async(t)=>{
  const h=await fixture(t,{rows:[row({6:INN})],items:[],config:{maxAttempts:2}});
  await h.store.update((state)=>{state.jobs.primary={status:'waiting',nextCheckAt:TODAY};});assert.equal((await h.tick()).fetched,0);
  await h.store.update((state)=>{delete state.jobs.primary;});h.advance(60000);assert.equal((await h.tick()).fetched,1);
  assert.equal((await h.requests())[0].nextCheckAt,'2026-11-06T06:00:00.000Z');await h.tick();assert.equal(h.calls.length,1);
  h.advance(24*3600000);assert.equal((await h.tick()).fetched,1);assert.equal((await h.requests())[0].reason,'api_attempts_exhausted');
  h.advance(24*3600000);assert.equal((await h.tick()).fetched,0);assert.equal(h.batches.length,0);
});

test('unknown committed Google result survives restart and is acknowledged from readback without a second batch or query',async(t)=>{
  const h=await fixture(t,{rows:[row({6:INN})]});h.controls.afterBatch=()=>{throw new Error('PRIVATE uncertain response');};
  assert.equal((await h.tick()).saved,0);assert.equal(h.batches.length,1);assert.ok((await h.requests())[0].plan.hash);
  h.controls.afterBatch=null;const result=await h.tick();assert.equal(result.saved,1);assert.equal(result.discovered,0);
  assert.equal(h.batches.length,1);assert.equal(h.calls.length,1);assert.equal((await h.requests())[0].receipts[0].action,'noop');
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE'));
});

test('legacy contact-only stays in existing worker; exact license aliases accept mixed owner input; unrelated data stays put',async(t)=>{
  const h=await fixture(t,{rows:[row({6:INN,7:NUMBER,8:ISSUE,9:EXPIRY,11:ADDRESS})]});
  const rowKey=hash([INN,normalizeAddress(ADDRESS),NUMBER,ISSUE,EXPIRY]),review=hash([rowKey,'contact_source_ambiguous']),jobId='a'.repeat(24);
  const contactNotice={type:'contact_review_required',jobId:review.slice(0,24),organization:ORG,code:'contact_source_ambiguous'};
  const licenseNotice={type:'review_required',jobId,organization:ORG,code:'no_matching_active_license'};
  await h.store.update((state)=>{state.contacts={reviews:{[review]:{id:review,rowKey,status:'review'}}};
    state.jobs[jobId]={id:jobId,status:'review',inn:INN,address:ADDRESS,plan:{rowNumber:2}};
    state.runtime={notifications:{contact:{status:'sent',destinationHash:hash(OWNER),event:contactNotice},license:{status:'sent',destinationHash:hash(OWNER),event:licenseNotice,telegramMessageId:812}}};});
  assert.equal((await h.tick()).sent,0);const request=(await h.requests())[0];assert.ok(request.notificationJobIds.includes(review.slice(0,24)));
  const contact=await h.reply('+79991112233 Сергей',{result:{message_id:811},text:renderNotification(contactNotice)});
  const license=await h.reply(`${INN}\n+79991112233 Сергей`,{result:{message_id:812},text:renderNotification(licenseNotice)});
  const unrelated=await h.reply(INN,{result:{message_id:999},text:'unrelated'});
  assert.equal(h.worker().routeFor(await h.store.read(),contact),null);assert.equal(h.worker().routeFor(await h.store.read(),license),request.id);
  assert.equal(await h.worker().ingestOwnerReplies(),1);const state=await h.store.read();
  assert.deepEqual(state.telegram.ownerInbox.map((entry)=>entry.updateId),[contact.updateId,unrelated.updateId]);
  assert.equal((await h.worker().tick()).saved,1);assert.equal(h.cells[1][12].formattedValue,'Сергей');assert.equal(h.calls.length,0);
});

test('a newly persisted owner reply blocks a pending old plan even before the owner router runs',async(t)=>{
  const h=await fixture(t);await h.tick();const prompt=h.sent[0];await h.reply(INN,prompt);
  let injected=false;const options={verifyPlan:async(...args)=>{if(!injected){injected=true;await h.reply('7736274613',prompt);}return verifyRegistryGapPlan(...args);}};
  assert.equal((await h.tick(options)).saved,0);assert.equal(h.batches.length,0);assert.equal(h.cells[1][6].formattedValue,undefined);
  assert.equal((await h.store.read()).telegram.ownerInbox.length,1);assert.equal((await h.requests())[0].plan,undefined);
});

test('identical rows require an explicit row, and prompts are capped across same-minute restarts',async(t)=>{
  const h=await fixture(t,{rows:[row({6:INN}),row({6:INN}),...Array.from({length:6},(_,i)=>row({4:`ООО Проверка ${i}`}))]});
  assert.equal((await h.tick()).sent,5);assert.equal((await h.tick()).sent,0);assert.equal(h.calls.length,0);
  h.advance(60000);assert.equal((await h.tick()).sent,3);const explicit=h.sent.find((message)=>message.text.includes('Строка 2. Есть одинаковые строки'));
  await h.reply('Строка: 2',explicit);assert.equal((await h.tick()).saved,1);assert.equal(h.cells[1][7].formattedValue,NUMBER);assert.equal(h.cells[2][7].formattedValue,undefined);
});

test('a concurrent contact completion during the grace period closes the request without a stale prompt',async(t)=>{
  const h=await fixture(t,{rows:[row({6:INN})]});assert.equal((await h.tick()).saved,1);
  assert.equal(h.sent.length,0);h.cells[1][12]=cell('Сергей');h.cells[1][13]=cell('+79991112233');h.advance(60000);
  assert.equal((await h.tick()).sent,0);assert.equal((await h.requests())[0].status,'done');assert.equal(h.batches.length,1);
});

test('a future pending decision for the same object prevents background backfill using an older cached license',async(t)=>{
  const h=await fixture(t,{rows:[row({6:INN,11:ADDRESS})]});
  await h.store.update((state)=>{state.jobs.primary={status:'waiting',inn:INN,address:ADDRESS,nextCheckAt:'2026-11-06T06:00:00.000Z'};
    state.registry={apiCache:{[INN]:{status:'ready',items:[record()],expiresAt:'2026-11-06T06:30:00.000Z'}}};});
  const result=await h.tick();assert.equal(result.saved,0);assert.equal(result.fetched,0);assert.equal(h.batches.length,0);
  assert.equal((await h.requests())[0].reason,'existing_jobs_priority');
});

test('a receipt for a different spreadsheet cannot acknowledge or clear the guarded plan',async(t)=>{
  const h=await fixture(t,{rows:[row({6:INN})]});
  const result=await h.tick({verifyPlan:async(_google,plan)=>({verified:true,planHash:plan.hash,rowNumber:plan.rowNumber,
    spreadsheetId:'different-spreadsheet',sheetName:plan.sheetName,sheetId:plan.sheetId,verifiedAt:TODAY,cells:plan.expectedCells,appliedCells:[]})});
  assert.equal(result.saved,0);assert.equal(h.batches.length,0);assert.ok((await h.requests())[0].plan.hash);
  assert.equal((await h.store.read()).journal.filter((entry)=>entry.type==='registry_completion_write_verified').length,0);
});
