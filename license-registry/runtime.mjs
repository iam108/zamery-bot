import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extractEvent, parseSheetRows, prepareJob, sourceEventKey, selectLicense,
  planSheetUpsert, planRetry, nextMorning, localDate, normalizeName, normalizeAddress, normalizeLicense } from './core.mjs';
import { createStore, addJob, requireJob, dueJobs, reserveFetch, recordResponse,
  recordFailure, savePlan, acknowledge, recoverExpiredFetches, stateSummary } from './state.mjs';
import {validatePinnedProxy} from './proxy-transport.mjs';
import {getOfficialLicenseEvidence,OFFICIAL_EVIDENCE_SOURCE} from './official-evidence.mjs';

const executeFile = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const clone = (v) => JSON.parse(JSON.stringify(v));
const instant = (now) => new Date(now()).toISOString();
const sourceTextKey=(value)=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const PROOF_STATUSES=['waiting','fetching','fetched','planned','review','done','blocked'];
const PROOF_REASONS=new Set(['api_older_than_verified_sheet_record','api_operation_does_not_match_renewal',
  'api_issueDate_older_than_existing','api_expiryDate_older_than_existing','api_daily_limit_reached',
  'api_run_limit_reached','conflicting_api_records','duplicate_event','duplicate_or_ambiguous_sheet_records',
  'event_date_required','event_inn_mismatch','event_inn_required','incomplete_existing_sheet_record',
  'incomplete_api_pagination','insufficient_api_quota','invalid_api_record','invalid_api_response',
  'invalid_explicit_inn','invalid_license_fields','invalid_or_incomplete_api_response','license_number_belongs_to_other_inn',
  'maximum_attempts_reached','missing_message_identity','missing_or_invalid_message_date','multiple_licenses_or_objects',
  'multiple_organizations_in_one_message','no_matching_active_license','object_address_conflict','organization_name_required',
  'organization_not_identified','organization_name_is_ambiguous','positive_result_is_a_question','registry_has_not_reflected_event',
  'registry_has_not_reflected_reissue','renewal_has_not_extended_expiry','retry_next_morning','row_number_required',
  'unsupported_activity_for_sheet','source_message_edited','access_ip_blocked','authentication_failed','quota_exhausted',
  'network_error','fsrar_transport_error','request_failed','api_fetch_interrupted','official_evidence_invalid','official_evidence_write_scope']);
const PROOF_LICENSE_STATUSES=new Set(['действующая','действует','active','истекла','истёк срок действия',
  'прекращена','прекращено','аннулирована','приостановлена','inactive','expired','revoked','suspended','terminated']);
function proofTimestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    ||!Number.isFinite(Date.parse(value)))return null;
  return new Date(value).toISOString();
}
function proofApiDates(item){
  let license;try{license=normalizeLicense(item);}catch{return {licenseNumber:null,issueDate:null,expiryDate:null,changeDate:null,status:null};}
  return {licenseNumber:/^\d{2}[А-ЯA-Z]{2,4}\d{4,10}$/u.test(license.licenseNumber)?license.licenseNumber:null,
    issueDate:license.issueDate,expiryDate:license.expiryDate,changeDate:license.changeDate,
    status:PROOF_LICENSE_STATUSES.has(license.status)?license.status:null};
}
function proofOfficialEvidence(evidence){
  if(!evidence)return null;
  const safeHash=(value)=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)?value:null;
  return {source:evidence.source===OFFICIAL_EVIDENCE_SOURCE?evidence.source:'unknown',verifiedAt:proofTimestamp(evidence.verifiedAt),
    evidenceHash:safeHash(evidence.evidenceSha256),recordHash:safeHash(evidence.recordHash),...proofApiDates(evidence.record)};
}
export function privateStateProof(state){
  // Periodic lastIngestAt/startup timestamps are telemetry, not queue content.
  const sections={jobs:state.jobs,sources:state.sources,api:state.api,
    telegram:{offset:state.telegram?.offset??0,inbox:state.telegram?.inbox??[],
      ...(state.telegram?.ownerInbox?.length?{ownerInbox:state.telegram.ownerInbox}:{})},cursors:state.cursors??{},journal:state.journal??[]};
  if(state.contactReplies)sections.contactReplies=state.contactReplies;
  if(state.registry)sections.registry=Object.fromEntries(['requests','apiCache','inbox','outbox','processed'].map((key)=>[key,state.registry[key]??(key==='inbox'?[]:{})]));
  if(state.contacts)sections.contacts={
    records:Object.fromEntries(Object.entries(state.contacts.records??{}).map(([key,{notificationPending:_notificationPending,...record}])=>[key,record])),
    reviews:Object.fromEntries(Object.entries(state.contacts.reviews??{}).map(([key,{notifiedAt:_notifiedAt,...review}])=>[key,review]))};
  const digest=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const safeCount=(value)=>Number.isSafeInteger(value)&&value>=0?value:null;
  const jobs=Object.values(state.jobs);
  const counts=Object.fromEntries(PROOF_STATUSES.map((status)=>[status,jobs.filter((job)=>job.status===status).length]));
  const jobStates=jobs.slice(-50).map((job)=>({id:typeof job.id==='string'&&/^[a-f0-9]{24}$/u.test(job.id)?job.id:null,
    status:PROOF_STATUSES.includes(job.status)?job.status:'unknown',
    reason:job.reason==null?null:PROOF_REASONS.has(job.reason)?job.reason:'unknown',attempts:safeCount(job.attempts??0),
    nextCheckAt:proofTimestamp(job.nextCheckAt),apiRecordCount:Array.isArray(job.apiItems)?job.apiItems.length:0,
    apiReceivedAt:proofTimestamp(job.apiReceivedAt),apiDates:Array.isArray(job.apiItems)?job.apiItems.slice(0,3).map(proofApiDates):[],
    officialEvidence:proofOfficialEvidence(job.officialLicenseEvidence)}));
  return {sha256:digest(sections),sectionHashes:Object.fromEntries(Object.entries(sections).map(([name,value])=>[name,digest(value)])),
    jobs:Object.keys(state.jobs).length,sources:Object.keys(state.sources).length,counts,
    apiAttemptedCalls:safeCount(state.api.attemptedCalls),telegramOffset:safeCount(state.telegram?.offset??0),pendingInbox:state.telegram?.inbox?.length??0,
    jobStates,jobStatesTruncated:Math.max(0,jobs.length-jobStates.length),journalEntries:state.journal?.length??0,
    ...(state.contactReplies?{ownerReplyState:{pendingInbox:state.telegram?.ownerInbox?.length??0,
      sessions:Object.keys(state.contactReplies.sessions??{}).length,
      done:Object.values(state.contactReplies.sessions??{}).filter((item)=>item.status==='done').length,
      pendingMessages:Object.values(state.contactReplies.outbox??{}).filter((item)=>item.status!=='sent').length}}:{}),
    ...(state.registry?{registryState:{requests:Object.keys(state.registry.requests??{}).length,
      ...Object.fromEntries(['ready','api_waiting','cache_waiting','awaiting_owner','planned','done','skipped','superseded'].map((status)=>[status,Object.values(state.registry.requests??{}).filter((item)=>item.status===status).length])),
      pendingInbox:state.registry.inbox?.length??0,pendingMessages:Object.values(state.registry.outbox??{}).filter((item)=>['pending','sending'].includes(item.status)).length,
      apiCacheEntries:Object.keys(state.registry.apiCache??{}).length}}:{}),
    ...(state.contacts?{contactState:{records:Object.keys(state.contacts.records??{}).length,
      done:Object.values(state.contacts.records??{}).filter((item)=>item.status==='done').length,
      planned:Object.values(state.contacts.records??{}).filter((item)=>item.status==='planned').length,
      reviews:Object.values(state.contacts.reviews??{}).filter((item)=>item.status!=='resolved').length}}:{})};
}
function editedSourceChanged(existing,message,extraction){
  if(!existing||!message.editDate)return false;
  if(sourceTextKey(existing.sourceText)!==sourceTextKey(message.text??message.caption))return true;
  const event=extraction.event;
  if(!event)return false;
  return ['inn','organization','operation','kpp','licenseNumber','address','decisionDate'].some((field)=>{
    const normalize=field==='organization'?normalizeName:field==='address'?normalizeAddress:(value)=>String(value??'');
    return normalize(existing[field])!==normalize(event[field]);
  });
}

export function classifyApiFailure(envelope) {
  if (!envelope || typeof envelope !== 'object') return 'invalid_api_response';
  const value = envelope.response;
  const detail = String(envelope.error ?? envelope.transport_error ?? value?.error ?? value?.Ошибка ?? value?.non_json_response ?? '');
  if (/ip.{0,40}(?:запрещ|недопуст)|доступ с данного ip/iu.test(detail) || envelope.http_status === 403) return 'access_ip_blocked';
  if (/неверн\p{L}*\s+ключ|недействительн\p{L}*\s+ключ|invalid.?key/iu.test(detail) || envelope.http_status === 401) return 'authentication_failed';
  if (/лимит|квот|quota|limit exceeded/iu.test(detail)) return 'quota_exhausted';
  if (envelope.http_status !== 200 || !Array.isArray(value?.items)) return envelope.transport_error ? 'network_error' : 'invalid_api_response';
  return null;
}

export class FsrarClient {
  #proxyUrl;
  #proxyServerName;
  constructor({keyFile, proxyUrl, proxyServerName, execute = executeFile}) {
    this.keyFile = keyFile;
    this.execute = execute;
    if (proxyUrl != null && proxyUrl !== '') {
      try {
        const url = validatePinnedProxy(proxyUrl,proxyServerName);
        this.#proxyUrl = url.toString();
        this.#proxyServerName = proxyServerName;
      } catch { throw new Error('fsrar_proxy_invalid'); }
    }
  }
  async validate() {
    const mode = (await fs.stat(this.keyFile)).mode & 0o777;
    if (mode & 0o077) throw new Error('fsrar_key_permissions');
    const key = (await fs.readFile(this.keyFile, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{40}$/u.test(key)) throw new Error('fsrar_key_invalid');
  }
  async request(method, job = {}) {
    const helper = this.#proxyUrl ? 'api-network-helper.mjs' : 'network-helper.py';
    const args = [path.join(directory, helper), '--key-file', this.keyFile, '--method', method];
    if (method === 'fsrar') { args.push('--inn', job.inn); if (job.kpp) args.push('--kpp', job.kpp); }
    try {
      const options = {timeout:23000,maxBuffer:3000000};
      if (this.#proxyUrl) {
        // Only this API helper gets the pinned route. Google/Telegram and the parent retain their own network paths.
        const env = {...process.env, FSRAR_PROXY_URL:this.#proxyUrl};
        if(this.#proxyServerName)env.FSRAR_PROXY_SERVER_NAME=this.#proxyServerName;
        else delete env.FSRAR_PROXY_SERVER_NAME;
        // The Node helper connects to the numeric proxy explicitly. No inherited
        // proxy/no-proxy setting can redirect or bypass that single route.
        for (const key of ['HTTPS_PROXY','HTTP_PROXY','https_proxy','http_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy']) delete env[key];
        options.env = env;
      }
      const {stdout} = await this.execute(this.#proxyUrl?process.execPath:'python3', args, options);
      return JSON.parse(stdout);
    } catch { return {attempted:true,transport_error:'fsrar_transport_error'}; }
  }
}

export async function prepareSecrets(env, dataDir) {
  await fs.mkdir(dataDir, {recursive:true,mode:0o700});
  const keyFile = env.FSRAR_KEY_FILE || path.join(dataDir, 'secrets', 'api-fns-key');
  if (env.FSRAR_API_KEY) {
    if (!/^[A-Za-z0-9_-]{40}$/u.test(env.FSRAR_API_KEY.trim())) throw new Error('fsrar_key_invalid');
    await fs.mkdir(path.dirname(keyFile),{recursive:true,mode:0o700});
    await fs.writeFile(keyFile, env.FSRAR_API_KEY.trim(), {mode:0o600});
    await fs.chmod(keyFile,0o600);
  }
  return {keyFile};
}

function expectedCells(plan, license) {
  const row = plan.rowNumber;
  const result = Object.fromEntries(plan.updates.map((u)=>[`${u.column}${u.row}`,u.after]));
  Object.assign(result,{[`G${row}`]:license.inn,[`H${row}`]:license.licenseNumber,
    [`I${row}`]:license.issueDate,[`J${row}`]:license.expiryDate});
  return result;
}

export class LicenseWorker {
  constructor({store, google, api, config, now = ()=>new Date(), dryRun=false, report=()=>{}}) {
    Object.assign(this,{store,google,api,config,now,dryRun,report});
    this.busy=false;
  }
  async persistUpdates(updates, convert, convertOwner) {
    if (!Array.isArray(updates) || updates.some((u)=>!u||!Number.isSafeInteger(u.update_id)||u.update_id<0)) throw new Error('invalid_telegram_updates');
    const ordered=[...updates].sort((a,b)=>a.update_id-b.update_id);
    return this.store.update((state)=>{
      state.telegram ??= {offset:0,inbox:[]};
      let count=0;
      for (const update of ordered) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < state.telegram.offset) continue;
        const message=convert(update);
        const ownerEvent=typeof convertOwner==='function'?convertOwner(update):null;
        if (message && !ownerEvent && !state.telegram.inbox.some((x)=>x.updateId===update.update_id)) {
          state.telegram.inbox.push({updateId:update.update_id,message,receivedAt:instant(this.now)});count++;
        }
        if(ownerEvent){
          state.telegram.ownerInbox??=[];
          if(!state.telegram.ownerInbox.some((item)=>item.updateId===update.update_id)){
            state.telegram.ownerInbox.push({updateId:update.update_id,event:ownerEvent,receivedAt:instant(this.now)});
          }
        }
        // Telegram is acknowledged only by the NEXT request, after this durable save.
        state.telegram.offset=Math.max(state.telegram.offset,update.update_id+1);
      }
      return {count,offset:state.telegram.offset};
    });
  }
  async ingestInbox(context) {
    const rows=parseSheetRows(context.values,{startRow:context.startRow??1});
    return this.store.update((state)=>{
      state.telegram ??= {offset:0,inbox:[]};
      const results=[];
      for (const item of state.telegram.inbox) {
        const message=item.message;
        const source=sourceEventKey(message);
        const extraction=extractEvent(message,rows,{timeZone:state.config.timeZone});
        const existing=state.sources[source] && state.jobs[state.sources[source]];
        // Edits are checked even when the new text is negative/ignored. The
        // original identity and any uncertain write/API evidence remain intact.
        if(editedSourceChanged(existing,message,extraction)){
          const text=String(message.text??message.caption??'').slice(0,20000);
          const edit={editDate:message.editDate,text,extractionStatus:extraction.status,
            proposedInn:extraction.event?.inn??null,proposedOrganization:extraction.event?.organization??null};
          const fingerprint=createHash('sha256').update(JSON.stringify(edit)).digest('hex');
          const alreadyJournaled=existing.sourceEditFingerprint===fingerprint;
          const previousStatus=existing.status;
          if(existing.status!=='done'){existing.status='review';existing.reason='source_message_edited';existing.nextCheckAt=null;}
          Object.assign(existing,{sourceReviewRequired:true,sourceReviewReason:'source_message_edited',
            latestSourceEdit:edit,sourceEditFingerprint:fingerprint,updatedAt:instant(this.now)});
          if(!alreadyJournaled){
            state.journal.push({at:instant(this.now),type:'source_message_edited',jobId:existing.id,
              sourceEventKey:source,editDate:message.editDate,previousStatus,status:existing.status,
              proposedInn:edit.proposedInn});
          }
          results.push({status:'source_review_required',id:existing.id});continue;
        }
        if(existing?.sourceReviewRequired){results.push({status:'source_review_required',id:existing.id});continue;}
        if (extraction.status==='ignore') { results.push({status:'ignored',source});continue; }
        const event=extraction.event??{id:source,sourceEventKey:source,reportedAt:message.date,
          organization:null,inn:null,operation:'unknown',nextCheckAt:null};
        if (existing?.status==='review' && extraction.status==='event' && !existing.apiItems) {
          Object.assign(existing,event,{id:existing.id,status:'waiting',reason:null,updatedAt:instant(this.now)});
          state.journal.push({at:instant(this.now),type:'context_resolved',jobId:existing.id,sourceEventKey:source});
          results.push({status:'resolved',id:existing.id});continue;
        }
        const prepared=extraction.status==='event' ? prepareJob(event,[],{timeZone:state.config.timeZone})
          : {job:{...event,id:createHash('sha256').update(source).digest('hex').slice(0,24),status:'review',reason:extraction.reason,attempts:0}};
        const job={...prepared.job,sourceText:String(message.text??message.caption??'').slice(0,20000)};
        const result=addJob(state,job,{now:this.now()});
        results.push({status:result.created ? result.job.status : 'duplicate',id:result.job.id});
      }
      state.telegram.inbox=[];
      state.telegram.lastIngestAt=instant(this.now);
      return results;
    });
  }
  async retry(id,reason) {
    return this.store.update((state)=>{
      const job=requireJob(state,id);
      const retry=planRetry({...job,status:'waiting'},{now:this.now(),timeZone:state.config.timeZone,
        quotaRemaining:state.config.apiTotalLimit-state.api.attemptedCalls,quotaReserve:state.config.apiReserve});
      return recordFailure(state,id,{code:retry.status==='waiting'?reason:retry.reason,now:this.now(),
        nextCheckAt:retry.nextCheckAt,terminal:retry.status!=='waiting'});
    });
  }
  async checkFetchBudget(id,runId) {
    return this.store.update((state)=>{
      const job=requireJob(state,id);
      if(job.status!=='waiting'||Date.parse(job.nextCheckAt)>+this.now())return 'not_due';
      if((job.attempts??0)>=(state.config.maxAttempts??7)){
        recordFailure(state,id,{code:'maximum_attempts_reached',terminal:true,now:this.now()});
        return 'maximum_attempts_reached';
      }
      if(state.api.blocked)return 'api_blocked';
      if(state.api.attemptedCalls>=state.config.apiTotalLimit-state.config.apiReserve){
        recordFailure(state,id,{code:'insufficient_api_quota',terminal:true,now:this.now()});
        return 'insufficient_api_quota';
      }
      const day=localDate(this.now(),state.config.timeZone);
      if((state.api.daily[day]??0)>=state.config.dailyLimit){
        const nextCheckAt=nextMorning(this.now(),{timeZone:state.config.timeZone,hour:this.config.dailyHour??9});
        if(job.nextCheckAt!==nextCheckAt||job.reason!=='api_daily_limit_reached'){
          Object.assign(job,{nextCheckAt,reason:'api_daily_limit_reached',updatedAt:instant(this.now)});
          state.journal.push({at:instant(this.now),type:'api_budget_deferred',jobId:id,sourceEventKey:job.sourceEventKey,
            reason:'api_daily_limit_reached',nextCheckAt});
        }
        return 'api_daily_limit_reached';
      }
      if((state.api.runs[runId]??0)>=state.config.runLimit)return 'api_run_limit_reached';
      return null;
    });
  }
  async fetch(id,{runId=`${localDate(this.now(),this.config.timeZone)}:${randomUUID()}`}={}) {
    await this.api.validate();
    const reserved=await this.store.update((s)=>reserveFetch(s,id,{now:this.now(),runId}));
    const envelope=await this.api.request('fsrar',reserved.job);
    return this.store.update((state)=>{
      const error=classifyApiFailure(envelope);
      if (!error) return recordResponse(state,id,envelope,{now:this.now(),reservation:reserved.reservation});
      const job=requireJob(state,id);
      const retry=planRetry({...job,status:'waiting'},{now:this.now(),timeZone:state.config.timeZone});
      return recordFailure(state,id,{code:error,message:error,now:this.now(),reservation:reserved.reservation,
        nextCheckAt:retry.nextCheckAt,terminal:retry.status==='review'});
    });
  }
  async plan(id,context) {
    const snapshot=await this.store.read();
    const job=requireJob(snapshot,id);
    let official;
    try{official=getOfficialLicenseEvidence(job);}catch{return this.store.update((s)=>recordFailure(s,id,{code:'official_evidence_invalid',terminal:true,now:this.now()}));}
    if (!official&&job.apiIncomplete) return this.store.update((s)=>recordFailure(s,id,{code:'incomplete_api_pagination',terminal:true,now:this.now()}));
    const selected=selectLicense(job,official?[official.record]:job.apiItems);
    if (selected.status==='waiting') return official
      ?this.store.update((s)=>recordFailure(s,id,{code:selected.reason,terminal:true,now:this.now()}))
      :this.retry(id,selected.reason);
    if (selected.status!=='ready') return this.store.update((s)=>recordFailure(s,id,{code:selected.reason,terminal:true,now:this.now()}));
    const rows=parseSheetRows(context.values,{startRow:context.startRow??1});
    const plan=planSheetUpsert(selected.license,rows,job);
    if (plan.action==='waiting') return official
      ?this.store.update((s)=>recordFailure(s,id,{code:plan.reason,terminal:true,now:this.now()}))
      :this.retry(id,plan.reason);
    if (plan.action==='review') return this.store.update((s)=>recordFailure(s,id,{code:plan.reason,terminal:true,now:this.now()}));
    if(official&&(plan.action==='append'||plan.updates.some((update)=>!['H','P'].includes(update.column)))){
      return this.store.update((s)=>recordFailure(s,id,{code:'official_evidence_write_scope',terminal:true,now:this.now()}));
    }
    if(official)plan.sourceEvidence={source:official.source,evidenceId:official.id,evidenceSha256:official.evidenceSha256,recordHash:official.recordHash};
    if (plan.action==='append') {
      let last=(context.startRow??1)-1;
      context.values.forEach((row,index)=>{if(row.some((v)=>v!=null&&String(v)!==''))last=(context.startRow??1)+index;});
      plan.rowNumber=Math.max(2,last+1);
      plan.updates=plan.updates.map((u)=>({...u,row:plan.rowNumber}));
    }
    return this.store.update((s)=>{
      const current=requireJob(s,id);current.selectedLicense=selected.license;
      if(official)current.selectedEvidence=clone(plan.sourceEvidence);
      savePlan(s,id,plan,{expectedCells:expectedCells(plan,selected.license),now:this.now()});
      return clone(current);
    });
  }
  async processJob(id,{runId=`${localDate(this.now(),this.config.timeZone)}:${randomUUID()}`}={}) {
    let job=requireJob(await this.store.read(),id);
    if (job.status==='waiting') {
      if (this.dryRun) return;
      const deferred=await this.checkFetchBudget(id,runId);
      if(deferred)return {deferred};
      job=await this.fetch(id,{runId});
    }
    // Polling can persist a correction while the API request is in flight.
    // Consume a pending edit for this source before proceeding to Google.
    const pending=await this.store.read();
    if(pending.telegram?.inbox?.some(({message})=>message.editDate&&sourceEventKey(message)===job.sourceEventKey)){
      await this.ingestInbox(await this.google.context());
      job=requireJob(await this.store.read(),id);
    }
    if (!['fetched','planned'].includes(job.status)) return;
    // An uncertain Google write must retain its original expected cells/hash:
    // applyPlan first tries verified readback of that exact write. It also checks
    // live identity/preconditions before performing any new mutation.
    if(job.status==='fetched')job=await this.plan(id,await this.google.context());
    if (job.status!=='planned'||this.dryRun) return;
    let receipt;let replanned=false;
    while(true){
      try { receipt=await this.google.applyPlan(job.plan,job);break; }
      catch(error) {
        // Only a definite precondition conflict permits a new plan. A transport
        // error or missing readback may mean the first batch already committed.
        if(error.code==='sheet_plan_stale'&&!replanned){
          replanned=true;job=await this.plan(id,await this.google.context());
          if(job.status!=='planned')return;
          continue;
        }
        await this.store.update((state)=>{
          const current=requireJob(state,id);current.lastWriteError=error.code||'google_write_failed';
          current.lastWriteAttemptAt=instant(this.now);
        });
        throw error;
      }
    }
    if(job.selectedEvidence?.source===OFFICIAL_EVIDENCE_SOURCE)receipt={...receipt,sourceEvidence:clone(job.selectedEvidence)};
    const result=await this.store.update((s)=>acknowledge(s,id,receipt,{now:this.now()}));
    if(!result.alreadyDone) await this.report({type:'write_verified',jobId:id,organization:job.organization,
      action:job.plan.action,cells:job.plan.updates.map((update)=>`${update.column}${update.row}`)});
  }
  async tick() {
    if(this.busy)return {busy:true};this.busy=true;
    try {
      await this.store.update((s)=>recoverExpiredFetches(s,{now:this.now()}));
      const context=await this.google.context();
      await this.ingestInbox(context);
      const jobs=dueJobs(await this.store.read(),this.now());
      const runId=`${localDate(this.now(),this.config.timeZone)}:${randomUUID()}`;
      let fetchLimited=false;
      for(const job of jobs) {
        if(fetchLimited&&job.status==='waiting')continue;
        try {
          const outcome=await this.processJob(job.id,{runId});
          if(['api_run_limit_reached','api_blocked'].includes(outcome?.deferred))fetchLimited=true;
        }
        catch(error) { await this.report({type:'processing_error',jobId:job.id,code:error.code||error.message||'processing_failed'}); }
      }
      return stateSummary(await this.store.read());
    } finally {this.busy=false;}
  }
}

export async function initializeState(file, config, env, now=()=>new Date()) {
  if(env.REQUIRE_INITIAL_STATE==='true'&&!env.INITIAL_STATE_JSON){
    try{await fs.access(file);}catch(error){if(error.code==='ENOENT')throw new Error('initial_state_required');throw error;}
  }
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  // One-time migration via a secret variable; never bake client data into the image.
  if (env.INITIAL_STATE_JSON) {
    let parsed;try{parsed=JSON.parse(env.INITIAL_STATE_JSON);}catch{throw new Error('initial_state_invalid');}
    if(parsed.version!==1||!parsed.jobs||!parsed.sources||!parsed.api||!Array.isArray(parsed.journal))throw new Error('initial_state_invalid');
    try {await fs.writeFile(file,JSON.stringify(parsed),{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  const store=createStore(file,{singleReplica:true});
  await store.update((state)=>{
    if(Object.keys(state.jobs).length && (state.config.spreadsheetId!==config.spreadsheetId||state.config.sheetName!==config.sheetName))throw new Error('state_destination_mismatch');
    Object.assign(state.config,{spreadsheetId:config.spreadsheetId,sheetName:config.sheetName,timeZone:config.timeZone});
    state.telegram??={offset:0,inbox:[]};
    state.runtime??={};state.runtime.startedAt=instant(now);
  });
  return store;
}
