import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extractEvent, parseSheetRows, prepareJob, sourceEventKey, selectLicense,
  planSheetUpsert, planRetry, nextMorning, localDate } from './core.mjs';
import { createStore, addJob, requireJob, dueJobs, reserveFetch, recordResponse,
  recordFailure, savePlan, acknowledge, recoverExpiredFetches, stateSummary } from './state.mjs';

const executeFile = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const clone = (v) => JSON.parse(JSON.stringify(v));
const instant = (now) => new Date(now()).toISOString();

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
  constructor({keyFile, execute = executeFile}) { this.keyFile = keyFile; this.execute = execute; }
  async validate() {
    const mode = (await fs.stat(this.keyFile)).mode & 0o777;
    if (mode & 0o077) throw new Error('fsrar_key_permissions');
    const key = (await fs.readFile(this.keyFile, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{40}$/u.test(key)) throw new Error('fsrar_key_invalid');
  }
  async request(method, job = {}) {
    const args = [path.join(directory, 'network-helper.py'), '--key-file', this.keyFile, '--method', method];
    if (method === 'fsrar') { args.push('--inn', job.inn); if (job.kpp) args.push('--kpp', job.kpp); }
    try {
      const {stdout} = await this.execute('python3', args, {timeout:23000,maxBuffer:3000000});
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
  async persistUpdates(updates, convert) {
    if (!Array.isArray(updates) || updates.some((u)=>!u||!Number.isSafeInteger(u.update_id)||u.update_id<0)) throw new Error('invalid_telegram_updates');
    const ordered=[...updates].sort((a,b)=>a.update_id-b.update_id);
    return this.store.update((state)=>{
      state.telegram ??= {offset:0,inbox:[]};
      let count=0;
      for (const update of ordered) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < state.telegram.offset) continue;
        const message=convert(update);
        if (message && !state.telegram.inbox.some((x)=>x.updateId===update.update_id)) {
          state.telegram.inbox.push({updateId:update.update_id,message,receivedAt:instant(this.now)});count++;
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
  async fetch(id) {
    await this.api.validate();
    const runId=`${localDate(this.now(),this.config.timeZone)}:daily`;
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
    if (job.apiIncomplete) return this.store.update((s)=>recordFailure(s,id,{code:'incomplete_api_pagination',terminal:true,now:this.now()}));
    const selected=selectLicense(job,job.apiItems);
    if (selected.status==='waiting') return this.retry(id,selected.reason);
    if (selected.status!=='ready') return this.store.update((s)=>recordFailure(s,id,{code:selected.reason,terminal:true,now:this.now()}));
    const rows=parseSheetRows(context.values,{startRow:context.startRow??1});
    const plan=planSheetUpsert(selected.license,rows,job);
    if (plan.action==='waiting') return this.retry(id,plan.reason);
    if (plan.action==='review') return this.store.update((s)=>recordFailure(s,id,{code:plan.reason,terminal:true,now:this.now()}));
    if (plan.action==='append') {
      let last=(context.startRow??1)-1;
      context.values.forEach((row,index)=>{if(row.some((v)=>v!=null&&String(v)!==''))last=(context.startRow??1)+index;});
      plan.rowNumber=Math.max(2,last+1);
      plan.updates=plan.updates.map((u)=>({...u,row:plan.rowNumber}));
    }
    return this.store.update((s)=>{
      const current=requireJob(s,id);current.selectedLicense=selected.license;
      savePlan(s,id,plan,{expectedCells:expectedCells(plan,selected.license),now:this.now()});
      return clone(current);
    });
  }
  async processJob(id) {
    let job=requireJob(await this.store.read(),id);
    if (job.status==='waiting') {
      if (this.dryRun) return;
      job=await this.fetch(id);
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
    const result=await this.store.update((s)=>acknowledge(s,id,receipt,{now:this.now()}));
    if(!result.alreadyDone) await this.report({type:'write_verified',jobId:id,organization:job.organization,
      action:job.plan.action,cells:Object.keys(receipt.cells)});
  }
  async tick() {
    if(this.busy)return {busy:true};this.busy=true;
    try {
      await this.store.update((s)=>recoverExpiredFetches(s,{now:this.now()}));
      const context=await this.google.context();
      await this.ingestInbox(context);
      const jobs=dueJobs(await this.store.read(),this.now());
      for(const job of jobs) {
        try { await this.processJob(job.id); }
        catch(error) { await this.report({type:'processing_error',jobId:job.id,code:error.code||error.message||'processing_failed'}); }
      }
      return stateSummary(await this.store.read());
    } finally {this.busy=false;}
  }
}

export async function initializeState(file, config, env, now=()=>new Date()) {
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
