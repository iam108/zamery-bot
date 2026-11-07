'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash,randomUUID}=require('node:crypto');
const yauzl=require('yauzl');
const {compactVisit}=require('./helpers/audit-v5');
const {normalizeWorkflow}=require('../src/bot/audit-workflow');
const {buildAuditSummary,buildAuditBrief}=require('../src/bot/audit-summary');
const GROUP='-1001234567890',ROOT=path.join(__dirname,'../src/bot');
const clone=value=>JSON.parse(JSON.stringify(value));
function report(){
 const data=compactVisit();data.submit_id='brief:'+randomUUID();data.draft_id=randomUUID();
 data.conclusion='Начало полного комментария. '+('Зафиксированное наблюдение без сокращения. '.repeat(130))+'Последняя строка полного комментария.';
 data.workflow.video_url='https://disk.yandex.ru/d/synthetic-video';data.inspection.video_status='Сделано';
 data.documents=data.evidence.map((file,index)=>({...file,source:Buffer.from('Synthetic exact original '+index+' '+file.id)}));data.photos=[];return data;
}
function signature(input){const data=normalizeWorkflow(input),digest={...data,documents:data.documents.map(({source,data:binary,...meta})=>({...meta,contentHash:createHash('sha256').update(source||Buffer.from(binary,'base64')).digest('hex')}))};return createHash('sha256').update(JSON.stringify(digest,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item)).digest('hex');}
function harness(options={}){
 const holder=options.holder||{value:{}},events=[],delivered=[],saves=options.saves||[];let next=Math.max(1000,...(holder.value.textIds||[]),...(holder.value.photoIds||[]),...(holder.value.documentIds||[]))+1;
 const ctx={from:{id:90001,username:'qa_brief'},telegram:{},auditDelivery:{load:async()=>clone(holder.value),save:async value=>{await options.beforeCheckpoint?.(value);holder.value=clone(value);events.push({method:'checkpoint',value:clone(value)});await options.afterCheckpoint?.(value);}},reply:async()=>{events.push({method:'reply'});}};
 for(const method of ['sendMessage','sendPhoto','sendDocument','sendMediaGroup','editMessageReplyMarkup'])ctx.telegram[method]=async(...args)=>{
  events.push({method,args});await options.beforePost?.(method,args);
  if(method==='editMessageReplyMarkup')return true;
  const payloads=method==='sendMediaGroup'?args[1]:[args[1]],items=payloads.map(payload=>{const kind=method==='sendMessage'?'text':method==='sendPhoto'?'photo':method==='sendDocument'?'document':payload.type,file=method==='sendMediaGroup'?payload.media:payload;return{kind,payload,message_id:next++,chat:{id:Number(GROUP)},filename:file?.filename,buffer:kind==='text'?null:Buffer.from(file.source)};});
  delivered.push(...items);const result=method==='sendMediaGroup'?items:items[0];await options.afterPost?.(method,args,result);return result;
 };
 const context={module:{exports:{}},Buffer,URL,process:{env:{GROUP_CHAT_ID:GROUP,WEBAPP_URL:'https://synthetic.example'}},console:{log(){},error(){}},setTimeout:()=>({unref(){}}),require(name){
  if(name==='../db/queries')return{getOrderById:async()=>({telegram_msg_id:options.orderCard===undefined?77:options.orderCard})};
  if(name==='../web/handoff')return{saveAudit:async(...args)=>{saves.push(args);events.push({method:'saveAudit',args});}};
  if(name==='../web/order-report-link')return{...require('../src/web/order-report-link'),syncOrderReportLink:async()=>({state:'linked'})};
  if(name.startsWith('./'))return require(path.join(ROOT,name));
  if(name==='crypto')return require('node:crypto');throw new Error('Unexpected dependency '+name);
 }};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(ROOT,'audit-handler.js'),'utf8'),context);
 return{holder,ctx,events,delivered,saves,send:data=>context.module.exports.handleAuditReport(ctx,data)};
}
const isPhase=(phase,method,args)=>phase==='photos'?(method==='sendPhoto'||method==='sendMediaGroup'&&args[1][0].type==='photo'):phase==='summary'?method==='sendMessage':method==='sendDocument'||method==='sendMediaGroup'&&args[1][0].type==='document';
const keyboard=h=>h.events.findLast(event=>event.method==='editMessageReplyMarkup')?.args[3]?.inline_keyboard.flat()||[];
async function unzip(bytes){const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(bytes,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value)));return new Promise((resolve,reject)=>{const files=[];zip.on('error',reject);zip.on('end',()=>resolve(files));zip.on('entry',entry=>{zip.openReadStream(entry,async(error,stream)=>{if(error)return reject(error);try{const chunks=[];for await(const chunk of stream)chunks.push(chunk);files.push({name:entry.fileName,buffer:Buffer.concat(chunks)});zip.readEntry();}catch(failure){reject(failure);}});});zip.readEntry();});}

test('fresh v3 sends the scheme/plans/photos before a short brief and preserves the full TXT, ZIP and logical summary link',async()=>{
 const data=report(),before=data.conclusion,h=harness();await h.send(data);
 assert.equal(h.events[0].method,'checkpoint');assert.equal(h.events[0].value.deliveryVersion,3);
 assert.deepEqual(h.delivered.map(item=>item.kind),['photo','photo','photo','text','document','document']);
 const photoCall=h.events.find(event=>event.method==='sendMediaGroup');assert.match(photoCall.args[1][0].caption,/Схема территории/);assert.match(photoCall.args[1][1].caption,/План/);assert.equal(photoCall.args[2].reply_to_message_id,77);
 const summary=h.delivered.find(item=>item.kind==='text');assert.equal(summary.payload,buildAuditBrief(normalizeWorkflow(data),'@qa_brief').html);assert.ok(summary.payload.length<3500);assert.ok(!summary.payload.includes('Последняя строка полного комментария.'));
 const documents=h.delivered.filter(item=>item.kind==='document'),full=buildAuditSummary(normalizeWorkflow(data),'@qa_brief').plain;
 assert.equal(documents[0].filename,'Отчёт-58-полный.txt');assert.equal(documents[0].buffer.toString('utf8'),full);assert.ok(full.includes(before));
 const zip=await unzip(documents[1].buffer);for(const original of data.documents)assert.equal(zip.filter(entry=>entry.buffer.equals(original.source)).length,1,original.name);
 assert.ok(zip.find(entry=>entry.name.endsWith('Содержание отчёта.txt')).buffer.toString('utf8').includes(before));
 assert.equal(h.saves.length,1);assert.equal(h.saves[0][1],full);assert.equal(data.conclusion,before);assert.equal(h.saves[0][3][0],summary.message_id);assert.ok(h.delivered[0].message_id<summary.message_id);
 assert.deepEqual(Array.from(h.saves[0][3]),[summary.message_id,...h.delivered.filter(item=>item.kind==='photo').map(item=>item.message_id),...documents.map(item=>item.message_id)]);
 const buttons=keyboard(h);assert.ok(buttons.some(button=>button.text==='📄 Полный отчёт'&&button.url.endsWith('/'+documents[0].message_id)));assert.ok(buttons.some(button=>button.text==='📎 Оригиналы'&&button.url.endsWith('/'+documents[1].message_id)));assert.ok(buttons.some(button=>button.url===data.workflow.video_url));assert.ok(buttons.some(button=>button.callback_data==='handoff:58'));
});

test('Other without any originals still receives the mandatory complete TXT and never a broken originals button',async()=>{
 const data=report();data.object_category='other';data.request_packet.object_category='other';data.request_packet.service='';data.inspection.service='';data.order_id=null;data.documents=[];data.evidence=[];data.entrances=[];data.zones=[];data.conclusion='Записанный общий осмотр без приложенных файлов.';
 const h=harness();await h.send(data);assert.deepEqual(h.delivered.map(item=>item.kind),['text','document']);assert.equal(h.delivered[1].filename,'Отчёт-аудит-полный.txt');assert.ok(h.delivered[1].buffer.toString('utf8').includes(data.conclusion));assert.ok(keyboard(h).some(button=>button.text==='📄 Полный отчёт'));assert.ok(!keyboard(h).some(button=>button.text==='📎 Оригиналы'));
});

for(const orderCard of [null,0,-1,'invalid',true])test('v3 has no invalid photo reply and its brief falls back to the first confirmed photo: '+orderCard,async()=>{
 const h=harness({orderCard}),data=report();await h.send(data);const photos=h.events.find(event=>event.method==='sendMediaGroup');assert.equal(photos.args[2].reply_to_message_id,undefined);const text=h.events.find(event=>event.method==='sendMessage');assert.equal(text.args[2].reply_to_message_id,h.delivered[0].message_id);
});

for(const phase of ['photos','summary','documents'])test('v3 explicit '+phase+' rejection resumes after restart with no duplicate confirmed parts',async()=>{
 const data=report(),holder={value:{}},saves=[];let refused=false;
 const first=harness({holder,saves,beforePost(method,args){if(!refused&&isPhase(phase,method,args)){refused=true;throw{response:{error_code:400,description:'Synthetic explicit rejection'}};}}});await assert.rejects(first.send(data));assert.equal(holder.value.inflight,undefined);
 const second=harness({holder,saves});await second.send(data);const all=first.delivered.concat(second.delivered);assert.equal(all.filter(item=>item.kind==='text').length,1);assert.equal(all.filter(item=>item.kind==='photo').length,3);assert.equal(all.filter(item=>item.kind==='document').length,2);assert.equal(saves.length,1);assert.equal(holder.value.deliveryVersion,3);assert.equal(holder.value.saved,true);
});

for(const phase of ['photos','summary','documents'])test('v3 unknown '+phase+' ACK cannot repeat in the same process or after restart',async()=>{
 const data=report(),holder={value:{}};let accepted=0;
 const first=harness({holder,afterPost(method,args){if(isPhase(phase,method,args)){accepted++;throw new Error('Synthetic lost ACK after physical send');}}});await assert.rejects(first.send(data),error=>error.code==='AUDIT_DELIVERY_UNKNOWN');const cursor=holder.value.inflight.id;
 await assert.rejects(first.send(data),error=>error.code==='AUDIT_DELIVERY_UNKNOWN');const second=harness({holder});await assert.rejects(second.send(data),error=>error.code==='AUDIT_DELIVERY_UNKNOWN');assert.equal(accepted,1);assert.equal(second.delivered.length,0);assert.equal(holder.value.inflight.id,cursor);
});

for(const field of ['photoIds','textIds','documentIds'])test('v3 lost '+field+' receipt checkpoint retains its durable intent and blocks resend',async()=>{
 const data=report(),holder={value:{}};let failed=false;
 const first=harness({holder,beforeCheckpoint(value){if(value[field].length&&!failed){failed=true;throw new Error('Synthetic receipt did not commit');}}});await assert.rejects(first.send(data),error=>error.code==='AUDIT_DELIVERY_UNKNOWN');const delivered=first.delivered.length;
 const second=harness({holder});await assert.rejects(second.send(data),error=>error.code==='AUDIT_DELIVERY_UNKNOWN');assert.ok(delivered>0);assert.equal(second.delivered.length,0);assert.ok(holder.value.inflight);
});

test('a v3 receipt COMMIT whose ACK is lost is reread before sending only its remaining documents',async()=>{
 const data=report(),holder={value:{}};let failed=false;const h=harness({holder,afterCheckpoint(value){if(value.textIds.length&&!failed){failed=true;throw new Error('Lost committed receipt ACK');}}});await assert.rejects(h.send(data));assert.equal(holder.value.textIds.length,1);assert.equal(holder.value.inflight,undefined);await h.send(data);assert.equal(h.delivered.filter(item=>item.kind==='text').length,1);assert.equal(h.delivered.filter(item=>item.kind==='photo').length,3);assert.equal(h.delivered.filter(item=>item.kind==='document').length,2);
});

test('photo 400 fallback completes before the v3 brief and retains the original panorama bytes',async()=>{
 const data=report(),panorama=data.documents.find(file=>file.role==='entrance');const error={response:{error_code:400,description:'PHOTO_INVALID_DIMENSIONS'}};
 const h=harness({beforePost(method,args){if(method==='sendMediaGroup'&&args[1][0].type==='photo')throw error;if(method==='sendPhoto'&&args[1].source.equals(panorama.source))throw error;}});await h.send(data);
 const fallback=h.delivered.find(item=>item.filename===panorama.name);assert.ok(fallback.buffer.equals(panorama.source));assert.ok(h.delivered.indexOf(fallback)<h.delivered.findIndex(item=>item.kind==='text'));assert.equal(h.holder.value.photoIds.length,3);assert.equal(h.holder.value.documentIds.length,2);
});

for(const version of [undefined,1,2])test('a stored '+version+' checkpoint never upgrades its former text/media format to v3',async()=>{
 const data=report(),holder={value:{signature:signature(data),...(version===undefined?{}:{deliveryVersion:version}),textIds:[],photoIds:[],documentIds:[],saved:false,handoffSent:false,replied:false}},h=harness({holder});await h.send(data);
 assert.equal(h.delivered[0].kind,'text');assert.ok(!h.delivered.some(item=>item.filename?.endsWith('-полный.txt')));assert.equal(holder.value.deliveryVersion,version);assert.equal(h.delivered.filter(item=>item.kind==='document').length,version===2?1:data.documents.length);if(version===2)assert.ok(h.delivered.filter(item=>item.kind==='text').map(item=>item.payload).join('').includes('Последняя строка полного комментария.'));
});

test('v3 cannot publish any Telegram request until its format checkpoint is durable',async()=>{
 const h=harness({beforeCheckpoint(){throw new Error('Version checkpoint unavailable');}});await assert.rejects(h.send(report()),/Version checkpoint unavailable/);assert.equal(h.delivered.length,0);assert.equal(h.events.some(event=>event.method.startsWith('send')),false);
});

for(const version of [undefined,1,2])test('exact stored '+version+' delivery resumes baseline-accepted unknown floors without upgrading its format',async()=>{
 const data=report();data.inspection.floor_plan=data.inspection.floor_actual='Не проверено';
 const holder={value:{signature:signature(data),...(version===undefined?{}:{deliveryVersion:version}),textIds:[970],photoIds:[],documentIds:[],saved:false,handoffSent:false,replied:false}},h=harness({holder});
 await h.send(data);assert.equal(h.saves.length,1);assert.equal(h.saves[0][3][0],970);assert.equal(holder.value.deliveryVersion,version);assert.ok(!h.delivered.some(item=>item.filename?.endsWith('-полный.txt')));assert.equal(h.delivered.filter(item=>item.kind==='document').length,version===2?1:data.documents.length);
});

for(const mode of ['fresh','request-flag','v3','missing-signature','changed-signature','forged-signature'])test('unknown floor compatibility cannot be enabled by '+mode,async()=>{
 const original=report(),data=report();data.submit_id=original.submit_id;data.inspection.floor_plan=data.inspection.floor_actual='Не проверено';
 let holder={value:{}};
 if(mode==='request-flag')data.legacyDelivery=true;
 if(mode==='missing-signature')holder.value={deliveryVersion:2,textIds:[970],photoIds:[],documentIds:[]};
 if(['v3','changed-signature','forged-signature'].includes(mode))holder.value={signature:mode==='v3'?signature(data):mode==='changed-signature'?signature(original):'f'.repeat(64),deliveryVersion:mode==='v3'?3:2,textIds:[],photoIds:[],documentIds:[],saved:false,handoffSent:false,replied:false};
 const h=harness({holder});await assert.rejects(h.send(data));assert.equal(h.delivered.length,0);assert.equal(h.saves.length,0);
});

test('a matched insertion-ordered legacy digest retains its old floor contract and checkpoints the canonical digest',async()=>{
 const data=report();data.inspection.floor_plan=data.inspection.floor_actual='Не проверено';const normalized=normalizeWorkflow(data),digest={...normalized,documents:normalized.documents.map(({source,data:binary,...meta})=>({...meta,contentHash:createHash('sha256').update(source||Buffer.from(binary,'base64')).digest('hex')}))};
 const holder={value:{signature:createHash('sha256').update(JSON.stringify(digest)).digest('hex'),deliveryVersion:2,textIds:[970],photoIds:[],documentIds:[],saved:false,handoffSent:false,replied:false}},h=harness({holder});await h.send(data);assert.equal(holder.value.signature,signature(data));assert.equal(h.saves.length,1);
});

for(const problem of ['rooms','entrance-photo'])test('an exact legacy checkpoint never bypasses the existing '+problem+' validation',async()=>{
 const data=report();data.inspection.floor_plan=data.inspection.floor_actual='Не проверено';if(problem==='rooms')data.inspection.rooms_complete='Нет';else data.evidence=data.evidence.filter(file=>file.role!=='entrance');
 const holder={value:{signature:signature(data),deliveryVersion:2,textIds:[970],photoIds:[],documentIds:[],saved:false,handoffSent:false,replied:false}},h=harness({holder});await assert.rejects(h.send(data));assert.equal(h.delivered.length,0);assert.equal(h.saves.length,0);
});
