import {randomUUID} from 'node:crypto';
import {hash} from './state.mjs';
import {isValidInn,localDate,nextMorning,normalizeAddress,normalizeDate,normalizeLicense,normalizeLicenseNumber,normalizeName,parseSheetRows,mapActivityForSheet} from './core.mjs';
import {classifyApiFailure} from './runtime.mjs';
import {renderNotification} from './notifier.mjs';
import {findRegistryRequest,parseRegistryReply} from './registry-request-input.mjs';
import {prepareRegistryGapPlan,applyRegistryGapPlan,verifyRegistryGapPlan} from './registry-gap-google.mjs';

const clone=(value)=>JSON.parse(JSON.stringify(value));
const clean=(value)=>String(value??'').trim();
const positive=(value)=>/^[1-9]\d*$/u.test(String(value??''))&&Number.isSafeInteger(Number(value));
const at=(now)=>new Date(now()).toISOString();
const rowValues=(row)=>Array.from({length:17},(_,i)=>String(row.values?.[i]??''));
const rowFingerprint=(values)=>hash(values.map((value,index)=>index===8||index===9?normalizeDate(value)??value:index===7?normalizeLicenseNumber(value):index===11?normalizeAddress(value):index===10?mapActivityForSheet(value)??value:index===6?clean(value):value));
const identity=(row)=>[clean(row.inn),normalizeAddress(row.address),normalizeLicenseNumber(row.licenseNumber),normalizeDate(row.issueDate),normalizeDate(row.expiryDate)];
const active=(item,today)=>['действующая','действует','active'].includes(item.status)&&item.issueDate&&item.expiryDate&&item.issueDate<=today&&item.expiryDate>=today;
const COL={inn:'G',licenseNumber:'H',issueDate:'I',expiryDate:'J',activity:'K',address:'L',name:'M',phone:'N',telegram:'O',email:'P'};
const INDEX={G:6,H:7,I:8,J:9,K:10,L:11,M:12,N:13,O:14,P:15};
const API_TTL=24*60*60*1000,NEGATIVE_TTL=3*60*60*1000,FETCH_LEASE=120000;
const same=(column,a,b)=>column==='I'||column==='J'?normalizeDate(a)===normalizeDate(b):column==='H'?normalizeLicenseNumber(a)===normalizeLicenseNumber(b):column==='L'?normalizeAddress(a)===normalizeAddress(b):column==='K'?mapActivityForSheet(a)===mapActivityForSheet(b):String(a??'')===String(b??'');
const licenseNumber=(value)=>/^\d{2}[А-ЯA-Z]{2,4}\d{4,10}$/u.test(value??'');
const validEmail=(value)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)&&value.length<=254;
const safeText=(value,limit)=>String(value??'').slice(0,limit);
function init(state){
  state.registry??={};for(const key of ['requests','apiCache','outbox','processed'])state.registry[key]??={};state.registry.inbox??=[];
  state.telegram??={offset:0,inbox:[]};state.telegram.ownerInbox??=[];return state.registry;
}
function gaps(row){
  const values=rowValues(row);return ['G','H','I','J','L','M','N'].filter((column)=>!clean(values[INDEX[column]])||(column==='I'||column==='J')&&!normalizeDate(values[INDEX[column]]));
}
function priority(row){const missing=gaps(row);return (missing.some((column)=>['G','I','J','L'].includes(column))?0:missing.includes('H')?1:2)*1000000-row.rowNumber;}
function enqueue(state,request,reason,text,now,keyboard,candidateVersion,candidateCount){
  const registry=init(state),id=hash([request.id,reason,text,candidateVersion??null]);
  if(registry.outbox[id])return;
  for(const item of Object.values(registry.outbox))if(item.requestId===request.id&&item.status==='pending'&&item.reason!=='write_verified')item.status='superseded';
  registry.outbox[id]={id,requestId:request.id,reason,text,status:'pending',createdAt:now,attempts:0,
    ...(request.sourceMessageId?{replyToMessageId:request.sourceMessageId}:{}),...(keyboard?{keyboard}:{}),...(candidateVersion?{candidateVersion,candidateCount}:{})};
}
function help(request,reason){
  const address=clean(request.expectedRowValues?.[11]);
  const head=`${safeText(request.organization,200)}${address?`\n${safeText(address,1000)}`:''}\nСтрока ${request.rowNumber}. `;
  const reasons={missing_inn:'Ответь ИНН организации. Номер, даты и адрес лицензии проверю по ФСРАР.',invalid_existing_inn:'В таблице некорректный ИНН. Проверь и исправь его в строке.',
    missing_contacts:'Ответь именем и телефоном: «+79991234567 Иван Иванов». Если контактов несколько, пришли каждый на отдельной строке.',missing_license_number:'Номер лицензии пуст. Если он известен, ответь «Номер лицензии: …».',
    no_matching_active_license:'В полученных данных ФСРАР не найдена подходящая действующая лицензия. Уточни ИНН, адрес или номер лицензии.',
    represented_license:'Найденная лицензия уже относится к другой строке. Уточни адрес, номер или даты именно этой подачи; старую лицензию в новую строку я не переношу.',
    api_older_than_existing:'Данные API старше указанных в этой строке. Ничего не заменяю. Уточни номер/адрес или повтори проверку позже.',
    existing_values_conflict:'Новые данные расходятся с заполненными ячейками. Заполненные значения сохранены. Проверь строку и пришли уточнение.',
    row_changed:'Строка изменилась после запроса. Запись остановлена; новые данные требуют повторной проверки.',
    duplicate_row:`Есть одинаковые строки. Чтобы выбрать именно эту, ответь «Строка: ${request.rowNumber}».`,
    registry_gap_cell_protected:'В целевой ячейке формула или примечание. Автоматическая запись остановлена.',
    api_failed:'Не удалось получить проверенные сведения API. Запрос сохранён; проверку можно повторить кнопкой.',
    invalid_input:'Не удалось однозначно разобрать ответ. Пришли ИНН, имя и телефон либо номер объекта из последнего списка.',api_quota_reserve:'Проверка API отложена: достигнут неприкосновенный резерв запросов.',
    api_blocked:'Запросы API остановлены из-за ошибки доступа. Нужна проверка подключения.',
    api_attempts_exhausted:'Автоматические попытки проверки исчерпаны. Если ИНН был указан неверно, пришли правильный.'};
  return head+(reasons[reason]??'Нужны уточняющие данные.');
}
function legacyContactReview(state,event,request){
  return Object.values(state.runtime?.notifications??{}).some((item)=>item.event?.type==='contact_review_required'
    &&item.destinationHash===hash(request.ownerChatId)&&request.notificationJobIds.includes(item.event.jobId)&&['sent','pending'].includes(item.status)
    &&(item.telegramMessageId!=null?Number(item.telegramMessageId)===Number(event.replyTo?.messageId)
      :!event.replyTo?.textTruncated&&renderNotification(item.event)===event.replyTo?.text));
}
function conflictText(request,conflicts){
  return `${help(request,'existing_values_conflict')}\n${conflicts.map(({column,before,after})=>`${column}${request.rowNumber}: ${safeText(before,140)} → ${safeText(after,140)}`).join('\n')}`;
}

/** Persistent, owner-scoped completion of existing rows; never appends a row. */
export class RegistryCompletionWorker{
  constructor({store,google,api,config={},telegram,ownerChatId,botId,now=()=>new Date(),log=()=>{},
    preparePlan=prepareRegistryGapPlan,applyPlan=applyRegistryGapPlan,verifyPlan=verifyRegistryGapPlan}={}){
    if(typeof store?.read!=='function'||typeof store?.update!=='function'||typeof google?.context!=='function'||typeof api?.request!=='function'
      ||typeof telegram?.call!=='function'||!positive(ownerChatId)||!positive(botId))throw new Error('registry_configuration_invalid');
    Object.assign(this,{store,google,api,config,telegram,ownerChatId:String(ownerChatId),botId:String(botId),now,log,preparePlan,applyPlan,verifyPlan});this.busy=false;
  }
  scoped(request){return request?.ownerChatId===this.ownerChatId&&request?.botId===this.botId;}
  authenticated(event){return event&&['message','callback'].includes(event.kind)&&event.chatType==='private'&&String(event.ownerChatId)===this.ownerChatId
    &&String(event.fromId)===this.ownerChatId&&String(event.botId)===this.botId&&positive(event.messageId);}
  logCode(code){try{this.log({at:at(this.now),type:'registry_completion_error',code});}catch{}}
  async prompt(id,reason,text,keyboard,nextCheckAt){
    await this.store.update((state)=>{const request=init(state).requests[id];if(!this.scoped(request))return;
      request.status=nextCheckAt?'api_waiting':'awaiting_owner';request.reason=reason;request.updatedAt=at(this.now);
      if(nextCheckAt)request.nextCheckAt=nextCheckAt;else delete request.nextCheckAt;
      const actions=keyboard??(['api_failed','no_matching_active_license','api_older_than_existing','represented_license'].includes(reason)?[[{text:'Повторить проверку',callback_data:`rg:${id}:retry`}]]:[]);
      const controls=[...actions,[{text:'Пропустить',callback_data:`rg:${id}:skip`}]];
      enqueue(state,request,reason,text??help(request,reason),at(this.now),controls,
        reason==='multiple_objects'?request.candidateVersion:undefined,reason==='multiple_objects'?keyboard?.length:undefined);});
  }
  async retryPrompt(id,reason,cache){
    const state=await this.store.read(),max=Math.min(7,state.config.maxAttempts??7);
    if((cache?.attempts??0)>=max)return this.prompt(id,'api_attempts_exhausted');
    const morning=nextMorning(this.now(),{timeZone:state.config.timeZone,hour:this.config.dailyHour??9});
    const when=cache?.expiresAt&&Date.parse(cache.expiresAt)>Date.parse(morning)?cache.expiresAt:morning;
    return this.prompt(id,reason,undefined,undefined,when);
  }
  async discover(context){
    const rows=parseSheetRows(context.values,{startRow:context.startRow??1}).filter((row)=>row.rowNumber>=2&&clean(row.organization));
    return this.store.update((state)=>{
      const registry=init(state),today=localDate(this.now(),state.config.timeZone);let discovered=0;
      for(const row of [...rows].sort((a,b)=>priority(a)-priority(b))){
        const missing=gaps(row),values=rowValues(row),fingerprint=rowFingerprint(values);
        const existing=Object.values(registry.requests).filter((request)=>this.scoped(request)&&request.rowNumber===row.rowNumber);
        if(!missing.length||row.expiryDate&&row.expiryDate<today&&missing.every((column)=>['H','M','N'].includes(column))){
          for(const request of existing)if(!request.plan&&!['done','skipped','superseded'].includes(request.status)){
            const before=request.expectedRowValues;
            const matches=before.slice(0,6).every((value,index)=>value===values[index])&&['G','H','I','J','L'].every((column)=>{
              const index=INDEX[column];return before[index]===''||same(column,before[index],values[index]);});
            request.status=!missing.length&&matches?'done':'superseded';request.updatedAt=at(this.now);
            if(request.status==='done'){request.completedAt=at(this.now);request.expectedRowValues=values;request.fingerprints=[...new Set([...request.fingerprints,fingerprint])].slice(-20);}
            for(const item of Object.values(registry.outbox))if(item.requestId===request.id&&['pending','sending'].includes(item.status)&&item.reason!=='write_verified')item.status='superseded';
          }
          continue;
        }
        const old=existing.find((request)=>request.fingerprints?.includes(fingerprint));
        if(old)continue;
        const id=hash([this.botId,this.ownerChatId,normalizeName(row.organization),clean(row.inn),fingerprint,row.rowNumber]).slice(0,32);
        if(registry.requests[id])continue;
        // A live pending write retains its original snapshot until readback settles.
        if(existing.some((request)=>request.plan))continue;
        for(const request of existing)if(!['done','skipped','superseded'].includes(request.status)){
          request.status='superseded';for(const item of Object.values(registry.outbox))if(item.requestId===request.id&&item.status==='pending')item.status='superseded';
        }
        const notificationJobIds=Object.values(state.jobs??{}).filter((job)=>job.receipt?.rowNumber===row.rowNumber||job.plan?.rowNumber===row.rowNumber)
          .filter((job)=>job.inn===row.inn&&(!job.address||normalizeAddress(job.address)===normalizeAddress(row.address))
            &&(!job.selectedLicense?.licenseNumber||normalizeLicenseNumber(job.selectedLicense.licenseNumber)===row.licenseNumber))
          .map((job)=>job.id).filter((id)=>/^[a-f0-9]{24}$/u.test(id??''));
        const contactJobs=Object.values(state.contacts?.reviews??{}).filter((review)=>review.rowKey===hash(identity(row))&&/^[a-f0-9]{64}$/u.test(review.id??'')).map((review)=>review.id.slice(0,24));
        notificationJobIds.push(...contactJobs);
        const notified=Object.values(state.runtime?.notifications??{}).some((item)=>item.status==='sent'&&item.destinationHash===hash(this.ownerChatId)&&contactJobs.includes(item.event?.jobId));
        const existingPrompt=notified&&missing.every((column)=>['M','N','H'].includes(column));
        registry.requests[id]={id,ownerChatId:this.ownerChatId,botId:this.botId,rowNumber:row.rowNumber,organization:row.organization,
          originalInn:row.inn,originalRowFingerprint:fingerprint,expectedRowValues:values,fingerprints:[fingerprint],notificationJobIds:[...new Set(notificationJobIds)],
          replyMessageIds:[],status:existingPrompt?'awaiting_owner':'ready',...(existingPrompt?{reason:'missing_contacts'}:{}),
          priority:priority(row),createdAt:at(this.now),updatedAt:at(this.now),provided:{}};discovered++;
      }
      return discovered;
    });
  }
  async ingestOwnerReplies(){
    return this.store.update((state)=>{
      const registry=init(state);let routed=0;const rest=[];
      for(const entry of state.telegram.ownerInbox){
        const requestId=entry.event?.updateId===entry.updateId?this.routeFor(state,entry.event):null;
        if(!requestId){rest.push(entry);continue;}
        const key=`${this.botId}:${this.ownerChatId}:${entry.updateId}`;
        if(!registry.processed[key]&&!registry.inbox.some((item)=>item.key===key))registry.inbox.push({...clone(entry),key,requestId});routed++;
      }
      state.telegram.ownerInbox=rest;return routed;
    });
  }
  routeFor(state,event){
    const requestId=this.authenticated(event)?findRegistryRequest(state,event):null,request=state.registry?.requests?.[requestId];
    if(!requestId||!this.scoped(request))return null;
    if(event.kind==='message'&&!request.replyMessageIds.includes(Number(event.replyTo?.messageId))&&legacyContactReview(state,event,request)){
      const parsed=parseRegistryReply(event);
      if(parsed.status==='input'&&parsed.contact&&Object.keys(parsed).every((key)=>['status','contact','rowNumber'].includes(key)))return null;
    }
    return requestId;
  }
  async consume(entry){
    const result=await this.store.update((state)=>{
      const registry=init(state),request=registry.requests[entry.requestId];
      if(!this.scoped(request)||!this.authenticated(entry.event))return {ignored:true};
      if(request.plan)return {deferred:true};
      registry.inbox=registry.inbox.filter((item)=>item.key!==entry.key);
      if(registry.processed[entry.key])return {ignored:true};registry.processed[entry.key]={at:at(this.now),requestId:request.id};
      if(request.status==='superseded')return {ignored:true};
      const parsed=parseRegistryReply(entry.event);
      if(parsed.status!=='input'){enqueue(state,request,'invalid_input',help(request,'invalid_input'),at(this.now));return {invalid:true};}
      if(parsed.requestId&&parsed.requestId!==request.id)return {ignored:true};
      if(parsed.action==='skip'){request.status='skipped';for(const item of Object.values(registry.outbox))if(item.requestId===request.id&&item.status==='pending')item.status='superseded';return {skipped:true};}
      if(parsed.rowNumber&&parsed.rowNumber!==request.rowNumber){enqueue(state,request,'row_changed',help(request,'row_changed'),at(this.now));return {invalid:true};}
      if(parsed.rowNumber===request.rowNumber)request.explicitRow=parsed.rowNumber;
      if(parsed.objectChoice){
        const delivery=Object.values(registry.outbox).find((item)=>item.requestId===request.id&&item.status==='sent'&&item.telegramMessageId===Number(entry.event.replyTo?.messageId)
          &&item.reason==='multiple_objects'&&item.candidateVersion===request.candidateVersion);
        const chosen=delivery&&parsed.objectChoice<=delivery.candidateCount&&request.candidates?.[parsed.objectChoice-1];if(!chosen){enqueue(state,request,'invalid_input',help(request,'invalid_input'),at(this.now));return {invalid:true};}
        request.selectedCandidateHash=hash(chosen);
      }
      if(parsed.inn){
        const warned=Object.values(registry.outbox).some((item)=>item.requestId===request.id&&item.status==='sent'&&item.reason==='company_name_mismatch'&&item.telegramMessageId===Number(entry.event.replyTo?.messageId));
        if(warned&&request.reason==='company_name_mismatch'&&request.provided.inn===parsed.inn)request.ownerVerifiedInn=parsed.inn;
        if(request.provided.inn!==parsed.inn){delete request.selectedCandidateHash;delete request.ownerVerifiedInn;}
      }
      if(['inn','address','licenseNumber','issueDate','expiryDate'].some((key)=>parsed[key]!=null&&parsed[key]!==request.provided[key])&&!parsed.objectChoice){delete request.candidateVersion;delete request.selectedCandidateHash;}
      for(const key of ['inn','address','licenseNumber','issueDate','expiryDate','contact'])if(parsed[key]!=null)request.provided[key]=clone(parsed[key]);
      if(parsed.action==='retry'){
        const inn=request.provided.inn||request.expectedRowValues[6];const cache=registry.apiCache[inn];
        if(cache&&cache.status!=='fetching')cache.expiresAt=at(this.now);
        delete request.selectedCandidateHash;delete request.candidateVersion;
      }
      request.status='ready';delete request.nextCheckAt;request.updatedAt=at(this.now);request.sourceMessageId=Number(entry.event.messageId);request.sourceUpdateId=entry.updateId;
      return {requestId:request.id,callback:entry.event.kind==='callback'};
    });
    if(entry.event.kind==='callback'&&this.authenticated(entry.event)&&!result.deferred)try{await this.telegram.call('answerCallbackQuery',{callback_query_id:entry.event.callbackQueryId,text:result.invalid?'Список изменился. Используй последний запрос.':'Принято.'});}catch{this.logCode('registry_callback_unavailable');}
    return result;
  }
  async fetchForInn(id,inn,runId){
    const reservation=await this.store.update((state)=>{
      const registry=init(state),request=registry.requests[id];if(!this.scoped(request))return {deferred:'scope'};
      const cache=registry.apiCache[inn],now=+new Date(this.now());
      if(cache?.status==='fetching'){
        if(Date.parse(cache.leaseUntil)>now)return {deferred:'fetching'};
        Object.assign(cache,{status:'negative',reason:'api_response_unknown',expiresAt:new Date(now+NEGATIVE_TTL).toISOString()});return {cache:clone(cache)};
      }
      if(cache&&Date.parse(cache.expiresAt)>now)return {cache:clone(cache)};
      // Existing decision jobs get the daily quota before historical completion.
      if(Object.values(state.jobs??{}).some((job)=>job.status==='fetching'||job.status==='waiting'&&Date.parse(job.nextCheckAt)<=now))return {deferred:'existing_jobs_priority'};
      const used=state.api.attemptedCalls,c=state.config,day=localDate(this.now(),c.timeZone);
      const attempts=cache?.attempts??0,max=Math.min(7,c.maxAttempts??7);
      if(!Number.isSafeInteger(attempts)||attempts<0||!Number.isSafeInteger(max)||max<1||attempts>=max)return {blocked:'api_attempts_exhausted'};
      if(state.api.blocked)return {blocked:'api_blocked'};
      if(![used,c.apiTotalLimit,c.apiReserve,c.dailyLimit,c.runLimit].every((value)=>Number.isSafeInteger(value)&&value>=0))return {blocked:'api_blocked'};
      if(used>=c.apiTotalLimit-c.apiReserve)return {blocked:'api_quota_reserve'};
      state.api.daily??={};state.api.runs??={};
      if(![state.api.daily[day]??0,state.api.runs[runId]??0].every((value)=>Number.isSafeInteger(value)&&value>=0))return {blocked:'api_blocked'};
      if((state.api.daily[day]??0)>=Math.max(0,Math.min(10,c.dailyLimit)-3))return {deferred:'daily',nextCheckAt:nextMorning(this.now(),{timeZone:c.timeZone,hour:this.config.dailyHour??9})};
      if((state.api.runs[runId]??0)>=Math.min(3,c.runLimit))return {deferred:'run'};
      const token=randomUUID(),reservedAt=at(this.now);state.api.attemptedCalls++;
      state.api.daily[day]=(state.api.daily[day]??0)+1;state.api.runs[runId]=(state.api.runs[runId]??0)+1;
      registry.apiCache[inn]={status:'fetching',reservation:token,reservedAt,leaseUntil:new Date(now+FETCH_LEASE).toISOString(),requestId:id,attempts:attempts+1};
      state.journal.push({at:reservedAt,type:'registry_api_reserved',requestId:id,runId,apiAttemptedCalls:state.api.attemptedCalls});return {reservation:token};
    });
    if(!reservation.reservation)return reservation;
    let envelope;try{envelope=await this.api.request('fsrar',{inn});}catch{envelope={transport_error:'network_error'};}
    return this.store.update((state)=>{
      const registry=init(state),cache=registry.apiCache[inn];if(cache?.reservation!==reservation.reservation)return {deferred:'reservation_changed'};
      let error=classifyApiFailure(envelope);
      if(!error&&![undefined,null,false,0,'','false'].includes(envelope.response.nextpage))error='incomplete_api_response';
      if(!error&&(envelope.response.items.length>1000||envelope.response.items.some((item)=>!item||typeof item!=='object'||Array.isArray(item))))error='incomplete_api_response';
      const receivedAt=at(this.now),items=error?[]:envelope.response.items.map(normalizeLicense).map((item)=>Object.fromEntries(
        ['inn','organization','kpp','licenseNumber','issueDate','expiryDate','address','activity','email','status','changeDate'].map((key)=>[key,item[key]])));
      Object.assign(cache,{status:error||!items.length?'negative':'ready',receivedAt,items,reason:error??(!items.length?'no_matching_active_license':null),expiresAt:new Date(+new Date(this.now())+(error||!items.length?NEGATIVE_TTL:API_TTL)).toISOString()});
      if(['access_ip_blocked','authentication_failed','quota_exhausted'].includes(error))state.api.blocked={code:error,at:receivedAt,requestId:id};
      state.journal.push({at:receivedAt,type:'registry_api_received',requestId:id,recordCount:items.length,code:error??null});return {cache:clone(cache),fetched:true};
    });
  }
  async planAndApply(id,updates,source){
    if(!updates.length)return false;const request=(await this.store.read()).registry.requests[id];if(!this.scoped(request)||request.plan)return false;
    let plan;try{plan=await this.preparePlan(this.google,{rowNumber:request.rowNumber,expectedRowValues:request.expectedRowValues,updates,
      authorization:{requestId:id,ownerChatId:this.ownerChatId,source,...(request.sourceMessageId?{sourceMessageId:request.sourceMessageId}:{}),
        ...(request.explicitRow===request.rowNumber?{explicitRow:request.explicitRow}:{})}});}
    catch(error){
      if(error.code==='registry_gap_read_failed'){this.logCode('registry_readback_unavailable');return false;}
      await this.prompt(id,error.code==='registry_gap_cell_protected'?error.code:error.reason==='registry_gap_row_ambiguous'?'duplicate_row':'row_changed');return false;
    }
    const saved=await this.store.update((state)=>{const current=init(state).requests[id];if(!this.scoped(current)||current.plan||rowFingerprint(current.expectedRowValues)!==rowFingerprint(request.expectedRowValues))return false;
      current.plan=clone(plan);current.planSource=source;current.status='planned';current.updatedAt=at(this.now);return true;});
    return saved?this.apply(id):false;
  }
  async acknowledge(id,receipt){
    const context=await this.google.context(),actual=parseSheetRows(context.values,{startRow:context.startRow??1}).find((row)=>row.rowNumber===receipt?.rowNumber);
    const saved=await this.store.update((state)=>{
      const registry=init(state),request=registry.requests[id],plan=request?.plan;if(!this.scoped(request)||!plan)return false;
      if(receipt?.verified!==true||receipt.planHash!==plan.hash||receipt.rowNumber!==request.rowNumber
        ||receipt.spreadsheetId!==plan.spreadsheetId||receipt.sheetName!==plan.sheetName||receipt.sheetId!==plan.sheetId||!Number.isFinite(Date.parse(receipt.verifiedAt))
        ||Object.entries(plan.expectedCells??{}).some(([cell,value])=>receipt.cells?.[cell]!==value))throw new Error('registry_receipt_invalid');
      const allowed=new Set(plan.updates.map((update)=>`${update.column}${request.rowNumber}`));
      if(!Array.isArray(receipt.appliedCells)||receipt.appliedCells.some((cell)=>!allowed.has(cell)))throw new Error('registry_receipt_invalid');
      const expected=[...request.expectedRowValues],changed=new Map();for(const update of plan.updates){expected[INDEX[update.column]]=String(update.after);changed.set(INDEX[update.column],update.column);}
      const live=actual&&rowValues(actual);
      const sameRow=live&&live.every((value,index)=>changed.has(index)?same(changed.get(index),value,expected[index]):value===expected[index]);
      request.receipts??=[];request.receipts.push(clone(receipt));request.receipts=request.receipts.slice(-20);
      request.expectedRowValues=sameRow?live:expected;
      request.fingerprints.push(rowFingerprint(request.expectedRowValues));request.fingerprints=[...new Set(request.fingerprints)].slice(-20);
      delete request.plan;delete request.writeAttempted;delete request.nextCheckAt;request.status=sameRow?'ready':'superseded';request.updatedAt=at(this.now);
      if(sameRow&&[...changed.values()].some((column)=>['G','H','I','J','L'].includes(column))&&!request.provided.contact&&(!clean(live[12])||!clean(live[13])))
        request.nextCheckAt=new Date(+new Date(this.now())+60000).toISOString();
      if(sameRow&&clean(live[12])&&clean(live[13]))for(const review of Object.values(state.contacts?.reviews??{})){
        if(review.rowKey===hash(identity(actual))&&request.notificationJobIds.includes(String(review.id).slice(0,24))){review.status='resolved';review.resolvedAt=at(this.now);}
      }
      for(const item of Object.values(registry.outbox))if(item.requestId===id&&item.status==='pending'&&item.reason!=='write_verified')item.status='superseded';
      state.journal.push({at:at(this.now),type:'registry_completion_write_verified',requestId:id,rowNumber:request.rowNumber,planHash:receipt.planHash,cells:[...allowed]});
      if(request.sourceMessageId&&allowed.size){
        const type=plan.authorization.source==='fsrar'?'Сведения ФСРАР сохранены и проверены':'Данные сохранены и проверены';
        enqueue(state,request,'write_verified',`${safeText(request.organization,200)}\nСтрока ${request.rowNumber}. ${type}: ${[...allowed].join(', ')}.`,at(this.now));
      }
      return true;
    });
    if(saved)try{this.log({at:at(this.now),type:'registry_completion_write_verified',requestId:id,rowNumber:receipt.rowNumber,planHash:receipt.planHash});}catch{}
    return saved;
  }
  async apply(id){
    const request=(await this.store.read()).registry?.requests?.[id];if(!this.scoped(request)||!request.plan)return false;
    try{return await this.acknowledge(id,await this.verifyPlan(this.google,request.plan));}
    catch(error){
      if(error.code!=='registry_gap_readback_pending'){this.logCode('registry_readback_unavailable');return false;}
      if(error.reason){await this.store.update((state)=>{const current=init(state).requests[id];if(this.scoped(current)){delete current.plan;delete current.writeAttempted;}});await this.prompt(id,error.reason==='registry_gap_cell_protected'?error.reason:'row_changed');return false;}
    }
    const allowed=await this.store.update((state)=>{const registry=init(state),current=registry.requests[id];if(!this.scoped(current)||current.plan?.hash!==request.plan.hash)return false;
      if(registry.inbox.some((entry)=>entry.requestId===id)||(state.telegram?.ownerInbox??[]).some((entry)=>entry.event?.updateId===entry.updateId&&this.routeFor(state,entry.event)===id)){
        delete current.plan;delete current.writeAttempted;current.status='awaiting_owner';return false;
      }
      current.writeAttempted=true;return true;});if(!allowed)return false;
    try{return await this.acknowledge(id,await this.applyPlan(this.google,request.plan));}
    catch{this.logCode('registry_write_unconfirmed');return false;}
  }
  async process(id,rows,runId){
    const state=await this.store.read(),request=state.registry.requests[id];if(!this.scoped(request)||!['ready','api_waiting','cache_waiting','planned'].includes(request.status))return {saved:0,fetched:0};
    if(request.nextCheckAt&&Date.parse(request.nextCheckAt)>+new Date(this.now()))return {saved:0,fetched:0};
    if(request.plan)return {saved:Number(await this.apply(id)),fetched:0};
    const values=request.expectedRowValues,row=parseSheetRows([values],{startRow:request.rowNumber})[0];
    const actual=rows.find((item)=>item.rowNumber===request.rowNumber);
    if(!actual||rowFingerprint(rowValues(actual))!==rowFingerprint(values)){await this.prompt(id,'row_changed');return {saved:0,fetched:0};}
    if(request.explicitRow!==request.rowNumber&&rows.some((item)=>item.rowNumber!==request.rowNumber&&rowFingerprint(rowValues(item))===rowFingerprint(values))){
      await this.prompt(id,'duplicate_row');return {saved:0,fetched:0};
    }
    const p=request.provided,inn=p.inn||row.inn;
    if(!isValidInn(inn)){await this.prompt(id,row.inn?'invalid_existing_inn':'missing_inn');return {saved:0,fetched:0};}
    const missing=gaps(row),licenseQuery=!row.inn||missing.some((column)=>['I','J','L'].includes(column));
    const conflicts=[];
    if(row.inn&&row.inn!==inn)conflicts.push({column:'G',before:row.inn,after:inn});
    if(p.address&&row.address&&!same('L',p.address,row.address))conflicts.push({column:'L',before:row.address,after:p.address});
    if(p.licenseNumber&&row.licenseNumber&&!same('H',p.licenseNumber,row.licenseNumber))conflicts.push({column:'H',before:row.licenseNumber,after:p.licenseNumber});
    if(conflicts.length){await this.prompt(id,'existing_values_conflict',conflictText(request,conflicts));return {saved:0,fetched:0};}
    const ownerFields={...(row.inn?p.contact??{}:{})};
    // A manually supplied number can complete a known period without spending API quota.
    if(p.licenseNumber&&!licenseQuery&&row.issueDate&&row.expiryDate&&row.address)ownerFields.licenseNumber=p.licenseNumber;
    const ownerUpdates=[];
    for(const [key,value] of Object.entries(ownerFields))if(COL[key]&&value!=null){const column=COL[key],before=values[INDEX[column]];
      if(before==='')ownerUpdates.push({column,after:String(value)});else if(!same(column,before,value))conflicts.push({column,before,after:value});}
    if(conflicts.length){await this.prompt(id,'existing_values_conflict',conflictText(request,conflicts));return {saved:0,fetched:0};}
    if(ownerUpdates.length){const saved=await this.planAndApply(id,ownerUpdates,'owner');return {saved:Number(saved),fetched:0};}
    const activePrimary=Object.values(state.jobs??{}).find((job)=>job.inn===inn&&['waiting','fetching','fetched','planned'].includes(job.status)
      &&(job.plan?.rowNumber?job.plan.rowNumber===row.rowNumber:!job.address||!row.address||normalizeAddress(job.address)===normalizeAddress(row.address)));
    if(activePrimary&&licenseQuery){
      const when=Math.max(+new Date(this.now())+60000,Date.parse(activePrimary.nextCheckAt)||0);
      await this.store.update((currentState)=>{const current=init(currentState).requests[id];if(this.scoped(current)){current.status='api_waiting';current.reason='existing_jobs_priority';current.nextCheckAt=new Date(when).toISOString();}});
      return {saved:0,fetched:0};
    }
    let cache=state.registry.apiCache[inn],fetched=0;
    if(licenseQuery&&(!cache||Date.parse(cache.expiresAt)<=+new Date(this.now())||cache.status==='fetching')){
      const result=await this.fetchForInn(id,inn,runId);fetched=Number(result.fetched??false);cache=result.cache;
      if(result.blocked){if(result.blocked==='api_attempts_exhausted')await this.prompt(id,result.blocked);else await this.retryPrompt(id,result.blocked);return {saved:0,fetched};}
      if(result.deferred){await this.store.update((state)=>{const current=init(state).requests[id];if(this.scoped(current)){current.status='api_waiting';current.nextCheckAt=result.nextCheckAt??new Date(+new Date(this.now())+60000).toISOString();}});return {saved:0,fetched};}
    }
    if(!activePrimary&&cache&&Date.parse(cache.expiresAt)>+new Date(this.now())&&cache.status==='ready'&&(licenseQuery||missing.includes('H'))){
      const today=localDate(this.now(),this.config.timeZone??'Europe/Moscow');
      let candidates=cache.items.filter((item)=>item.inn===inn&&active(item,today)&&licenseNumber(item.licenseNumber)
        &&normalizeAddress(item.address)&&item.address.length<=1000&&!/[\u0000-\u001f\u007f]/u.test(item.address)&&item.expiryDate>=item.issueDate);
      if(p.inn&&request.ownerVerifiedInn!==inn&&candidates.some((item)=>normalizeName(item.organization)!==normalizeName(request.organization))){
        const names=[...new Set(candidates.map((item)=>item.organization).filter(Boolean))].join('; ');
        await this.prompt(id,'company_name_mismatch',`${safeText(request.organization,200)}\nСтрока ${request.rowNumber}. В ФСРАР по ИНН ${inn} указано: ${safeText(names,1000)||'другое наименование'}. Если это нужная организация, ответь повторно этим ИНН. Пока ничего из API не переношу.`);return {saved:0,fetched};
      }
      if(p.licenseNumber||row.licenseNumber)candidates=candidates.filter((item)=>item.licenseNumber===normalizeLicenseNumber(p.licenseNumber||row.licenseNumber));
      if(p.address||row.address)candidates=candidates.filter((item)=>normalizeAddress(item.address)===normalizeAddress(p.address||row.address));
      if(p.issueDate)candidates=candidates.filter((item)=>item.issueDate===p.issueDate);if(p.expiryDate)candidates=candidates.filter((item)=>item.expiryDate===p.expiryDate);
      const unique=new Map();for(const item of candidates)unique.set(hash([item.inn,item.licenseNumber,item.issueDate,item.expiryDate,normalizeAddress(item.address)]),item);candidates=[...unique.values()];
      let represented=0;
      candidates=candidates.filter((item)=>{const elsewhere=rows.some((other)=>other.rowNumber!==row.rowNumber&&other.inn===inn
        &&(normalizeAddress(other.address)===normalizeAddress(item.address)||!other.address&&other.licenseNumber===item.licenseNumber)
        &&((other.licenseNumber===item.licenseNumber&&(!other.issueDate||!other.expiryDate||other.issueDate>=item.issueDate&&other.expiryDate>=item.expiryDate))
          ||(!other.licenseNumber&&other.issueDate===item.issueDate&&other.expiryDate===item.expiryDate)));
        if(elsewhere)represented++;return !elsewhere;});
      if(request.selectedCandidateHash)candidates=candidates.filter((item)=>hash(item)===request.selectedCandidateHash);
      if(!licenseQuery&&candidates.length!==1)candidates=[];
      if(candidates.length>1){
        await this.store.update((state)=>{const current=init(state).requests[id];if(this.scoped(current)){current.candidates=clone(candidates);current.candidateVersion=hash(candidates);}});
        const descriptions=[];let length=0;for(const [index,item] of candidates.slice(0,20).entries()){
          const line=`${index+1}. ${item.licenseNumber}; ${item.issueDate} — ${item.expiryDate}; ${item.address}`;if(length+line.length>3400)break;
          descriptions.push(line);length+=line.length+1;
        }
        await this.prompt(id,'multiple_objects',`${safeText(request.organization,200)}\nСтрока ${row.rowNumber}. Выбери объект лицензии:\n${descriptions.join('\n')}\nОтветь номером из списка или пришли адрес.${candidates.length>descriptions.length?' Другие объекты в этот список не вошли.':''}`,
          descriptions.map((_,index)=>[{text:`Объект ${index+1}`,callback_data:`rg:${id}:object:${index+1}`} ]));return {saved:0,fetched};
      }
      if(!candidates.length&&licenseQuery){await this.retryPrompt(id,represented?'represented_license':'no_matching_active_license',cache);return {saved:0,fetched};}
      const license=candidates[0];
      if(license){
        if(row.issueDate&&license.issueDate<row.issueDate||row.expiryDate&&license.expiryDate<row.expiryDate){await this.retryPrompt(id,'api_older_than_existing',cache);return {saved:0,fetched};}
        const fields={inn:license.inn,licenseNumber:license.licenseNumber,issueDate:license.issueDate,expiryDate:license.expiryDate,address:license.address,
          ...(mapActivityForSheet(license.activity)?{activity:mapActivityForSheet(license.activity)}:{}),...(validEmail(license.email)?{email:license.email}:{})};
        const updates=[];for(const [key,value] of Object.entries(fields)){const column=COL[key],before=values[INDEX[column]];
          if(before==='')updates.push({column,after:value});else if(!['K','P'].includes(column)&&!same(column,before,value))conflicts.push({column,before,after:value});}
        if(conflicts.length){await this.prompt(id,'existing_values_conflict',conflictText(request,conflicts));return {saved:0,fetched};}
        if(updates.length)return {saved:Number(await this.planAndApply(id,updates,'fsrar')),fetched};
      }
    }else if(licenseQuery){await this.retryPrompt(id,cache?.reason==='no_matching_active_license'?'no_matching_active_license':'api_failed',cache);return {saved:0,fetched};}
    if(missing.includes('M')||missing.includes('N'))await this.prompt(id,'missing_contacts');
    else if(missing.includes('H'))await this.store.update((state)=>{const current=init(state).requests[id];if(this.scoped(current)){current.status='cache_waiting';current.cacheCheckedAt=cache?.receivedAt??null;}});
    else await this.store.update((state)=>{const current=init(state).requests[id];if(this.scoped(current)){current.status='done';current.completedAt=at(this.now);}});
    return {saved:0,fetched};
  }
  async flushOutbox(){
    let sent=0;const snapshot=(await this.store.read()).registry,minute=at(this.now).slice(0,16);
    const remaining=5-(snapshot?.promptWindow?.minute===minute?snapshot.promptWindow.count:0);if(remaining<=0)return sent;
    const items=Object.values(snapshot?.outbox??{}).filter((item)=>this.scoped(snapshot.requests[item.requestId])&&['pending','sending'].includes(item.status)
      &&(item.status!=='sending'||Date.parse(item.leaseUntil)<=+new Date(this.now()))).sort((a,b)=>Number(Boolean(b.replyToMessageId))-Number(Boolean(a.replyToMessageId))).slice(0,remaining);
    for(const item of items){
      const claimed=await this.store.update((state)=>{const registry=init(state),current=registry.outbox[item.id],request=registry.requests[current?.requestId];if(!this.scoped(request)||!current)return false;
        if(!['pending','sending'].includes(current.status)||current.status==='sending'&&Date.parse(current.leaseUntil)>+new Date(this.now()))return false;
        const minute=at(this.now).slice(0,16);if(registry.promptWindow?.minute!==minute)registry.promptWindow={minute,count:0};if(registry.promptWindow.count>=5)return false;
        registry.promptWindow.count++;current.status='sending';current.attempts++;current.leaseUntil=new Date(+new Date(this.now())+30000).toISOString();return true;});
      if(!claimed)continue;
      try{
        const result=await this.telegram.call('sendMessage',{chat_id:this.ownerChatId,text:item.text,link_preview_options:{is_disabled:true},
          ...(item.replyToMessageId?{reply_parameters:{message_id:item.replyToMessageId,allow_sending_without_reply:true}}:{}),...(item.keyboard?{reply_markup:{inline_keyboard:item.keyboard}}:{})});
        if(!positive(result?.message_id)||String(result.chat?.id)!==this.ownerChatId||result.chat.type!=='private'||result.from?.is_bot!==true||String(result.from.id)!==this.botId)throw new Error('registry_delivery_unverified');
        await this.store.update((state)=>{const registry=init(state),current=registry.outbox[item.id],request=registry.requests[item.requestId];if(!this.scoped(request)||current?.requestId!==request.id)return;
          current.status='sent';current.sentAt=at(this.now);current.telegramMessageId=Number(result.message_id);request.replyMessageIds=[...new Set([...request.replyMessageIds,Number(result.message_id)])];});sent++;
      }catch{this.logCode('registry_prompt_delivery_unavailable');break;}
    }
    return sent;
  }
  async tick(){
    if(this.busy)return {skipped:'busy'};this.busy=true;const summary={discovered:0,processed:0,saved:0,fetched:0,sent:0};
    try{
      let context=await this.google.context();summary.discovered=await this.discover(context);
      const initial=(await this.store.read()).registry;
      for(const request of Object.values(initial.requests))if(this.scoped(request)&&request.plan)summary.saved+=Number(await this.apply(request.id));
      for(const entry of initial.inbox.filter((item)=>this.scoped(initial.requests[item.requestId])&&this.authenticated(item.event)).slice(0,100)){
        const result=await this.consume(entry);if(!result.deferred)summary.processed++;
      }
      if(summary.saved)context=await this.google.context();
      let rows=parseSheetRows(context.values,{startRow:context.startRow??1});const registry=(await this.store.read()).registry,now=+new Date(this.now());
      const ids=Object.values(registry.requests).filter((request)=>this.scoped(request)&&!request.plan&&(!request.nextCheckAt||Date.parse(request.nextCheckAt)<=now)&&
        (['ready','api_waiting'].includes(request.status)||request.status==='cache_waiting'&&registry.apiCache[request.expectedRowValues[6]]?.status==='ready'
          &&Date.parse(registry.apiCache[request.expectedRowValues[6]].expiresAt)>now&&registry.apiCache[request.expectedRowValues[6]].receivedAt!==request.cacheCheckedAt))
        .sort((a,b)=>Number(Boolean(b.sourceMessageId))-Number(Boolean(a.sourceMessageId))||a.priority-b.priority).slice(0,100).map((request)=>request.id);
      const runId=`registry:${localDate(this.now(),this.config.timeZone??'Europe/Moscow')}:${randomUUID()}`;
      for(const id of ids)try{const result=await this.process(id,rows,runId);summary.saved+=result.saved;summary.fetched+=result.fetched;
        if(result.saved){context=await this.google.context();rows=parseSheetRows(context.values,{startRow:context.startRow??1});}}
      catch(error){this.logCode(error.code==='state_locked'?'state_locked':'registry_processing_unavailable');}
      summary.sent=await this.flushOutbox();return summary;
    }finally{this.busy=false;}
  }
}
