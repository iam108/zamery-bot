import {createHash,randomUUID} from 'node:crypto';
import {isValidInn,localDate,parseSheetRows,selectLicense,planSheetUpsert} from './core.mjs';
import {initialState,addJob,savePlan,acknowledge} from './state.mjs';
import {classifyApiFailure} from './runtime.mjs';

const clone=(value)=>JSON.parse(JSON.stringify(value));
const digest=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeJobId=(value)=>typeof value==='string'&&/^[a-f0-9]{24}$/u.test(value);
const safeLicense=(value)=>typeof value==='string'&&/^\d{2}[А-ЯA-Z]{2,4}\d{4,10}$/u.test(value)?value:null;
class AcceptanceError extends Error{constructor(code){super(code);this.code=code;}}
const fail=(code)=>{throw new AcceptanceError(code);};
const defaultLog=(entry)=>console.log(JSON.stringify(entry));

/** An explicit, once-only diagnostic: one counted API call, Google reads only. */
export async function runReadOnlyAcceptance({sourceJobId,store,google,api,now=()=>new Date(),log=defaultLog}){
  if(!sourceJobId)return {status:'disabled'};
  if(!safeJobId(sourceJobId)){
    const rejected={status:'rejected',code:'acceptance_source_invalid'};
    log({at:now().toISOString(),type:'acceptance_failed',...rejected});return rejected;
  }
  let reservation;
  try{
    reservation=await store.update((state)=>{
      state.runtime??={};
      if(state.runtime.acceptance)return {reserved:false,record:clone(state.runtime.acceptance)};
      const at=now().toISOString();
      const reject=(code)=>{
        const record={status:'rejected',code,sourceJobId,at};state.runtime.acceptance=record;
        state.journal.push({at,type:'acceptance_rejected',sourceJobId,code});return {reserved:false,record:clone(record)};
      };
      const source=state.jobs[sourceJobId];
      if(!source||source.status!=='done'||source.receipt?.verified!==true||!isValidInn(source.inn)
        ||state.sources[source.sourceEventKey]!==sourceJobId)return reject('acceptance_completed_source_required');
      if(state.api.blocked)return reject('acceptance_api_blocked');
      const config=state.config;const used=state.api.attemptedCalls;
      if(![used,config.apiTotalLimit,config.apiReserve,config.dailyLimit,config.runLimit].every((value)=>Number.isSafeInteger(value)&&value>=0)
        ||config.dailyLimit<1||config.runLimit<1)return reject('acceptance_quota_invalid');
      if(used>=config.apiTotalLimit-config.apiReserve)return reject('acceptance_quota_reserve');
      const day=localDate(now(),config.timeZone);const runId=`acceptance:${sourceJobId}`;
      state.api.daily??={};state.api.runs??={};
      if(![state.api.daily[day]??0,state.api.runs[runId]??0].every((value)=>Number.isSafeInteger(value)&&value>=0))return reject('acceptance_quota_invalid');
      if((state.api.daily[day]??0)>=config.dailyLimit)return reject('acceptance_daily_limit');
      if((state.api.runs[runId]??0)>=config.runLimit)return reject('acceptance_run_limit');
      // Durable guard and expenditure commit together, before any live request.
      state.api.attemptedCalls++;state.api.daily[day]=(state.api.daily[day]??0)+1;
      state.api.runs[runId]=(state.api.runs[runId]??0)+1;
      const record={status:'reserved',sourceJobId,reservation:randomUUID(),reservedAt:at,runId,
        apiCallReserved:true,apiAttemptedCalls:state.api.attemptedCalls};
      state.runtime.acceptance=record;
      state.journal.push({at,type:'acceptance_api_reserved',sourceJobId,runId,apiAttemptedCalls:state.api.attemptedCalls});
      return {reserved:true,record:clone(record),source:clone(source),sourceHash:digest(source),config:clone(config)};
    });
  }catch{
    log({at:now().toISOString(),type:'acceptance_failed',sourceJobId,code:'acceptance_reservation_failed'});
    return {status:'failed',code:'acceptance_reservation_failed'};
  }
  if(!reservation.reserved){
    const record=reservation.record;
    const sameSource=record.sourceJobId===sourceJobId;
    log({at:now().toISOString(),type:record.status==='verified'&&sameSource?'acceptance_already_verified':'acceptance_not_repeated',
      sourceJobId:safeJobId(record.sourceJobId)?record.sourceJobId:null,status:record.status,
      code:!sameSource?'acceptance_guard_for_other_source':record.status==='reserved'?'acceptance_reserved_result_unknown':record.code??null});
    if(!sameSource)return {status:'not_repeated',code:'acceptance_guard_for_other_source'};
    return record;
  }
  let stage='api';let apiFailure=null;
  try{
    const source=reservation.source;
    const response=await api.request('fsrar',source);
    apiFailure=classifyApiFailure(response);
    if(apiFailure)fail('acceptance_api_failed');
    if(![undefined,null,false,0,'','false'].includes(response.response.nextpage))fail('acceptance_incomplete_api');
    stage='selection';
    const selection=selectLicense(source,response.response.items);
    if(selection.status!=='ready')fail('acceptance_current_license_required');
    stage='plan';
    const context=await google.context();
    const plan=planSheetUpsert(selection.license,parseSheetRows(context.values,{startRow:context.startRow??1}),source);
    if(plan.action!=='noop'||!Array.isArray(plan.updates)||plan.updates.length)fail('acceptance_would_write');
    // The existing DONE job and its receipt remain untouched. The real adapter
    // receives a signed noop plan; its own live preconditions prohibit writes.
    const temporary=initialState(reservation.config);
    const job={...clone(source),status:'fetched',selectedLicense:selection.license};
    delete job.plan;delete job.receipt;
    addJob(temporary,job,{now:now()});
    const row=plan.rowNumber;
    const expectedCells={[`G${row}`]:selection.license.inn,[`H${row}`]:selection.license.licenseNumber,
      [`I${row}`]:selection.license.issueDate,[`J${row}`]:selection.license.expiryDate};
    const signed=savePlan(temporary,sourceJobId,plan,{expectedCells,now:now()});
    stage='readback';
    const receipt=await google.applyPlan(signed,temporary.jobs[sourceJobId]);
    stage='ack';
    const ack=acknowledge(temporary,sourceJobId,receipt,{now:now()});
    if(ack.alreadyDone||ack.job.status!=='done')fail('acceptance_ack_failed');
    const verifiedAt=now().toISOString();
    stage='persist';
    const verified=await store.update((state)=>{
      const current=state.runtime?.acceptance;
      if(current?.reservation!==reservation.record.reservation||current.status!=='reserved')fail('acceptance_guard_changed');
      if(digest(state.jobs[sourceJobId])!==reservation.sourceHash)fail('acceptance_source_changed');
      Object.assign(current,{status:'verified',verifiedAt,row,licenseNumber:selection.license.licenseNumber,
        issueDate:selection.license.issueDate,expiryDate:selection.license.expiryDate,
        receipt:clone(ack.job.receipt),ack:{verified:true,planHash:signed.hash,acknowledgedAt:verifiedAt}});
      state.journal.push({at:verifiedAt,type:'acceptance_verified',sourceJobId,row,planHash:signed.hash});
      return clone(current);
    });
    log({at:verifiedAt,type:'acceptance_verified',sourceJobId,row,licenseNumber:safeLicense(verified.licenseNumber),
      issueDate:verified.issueDate,expiryDate:verified.expiryDate,receiptVerified:verified.receipt.verified,ackVerified:verified.ack.verified,
      planHash:verified.ack.planHash});
    return verified;
  }catch(error){
    const code=error instanceof AcceptanceError?error.code:`acceptance_${stage}_failed`;
    const at=now().toISOString();
    try{
      await store.update((state)=>{
        const current=state.runtime?.acceptance;
        if(current?.reservation!==reservation.record.reservation||current.status!=='reserved')return;
        Object.assign(current,{status:'failed',code,failedAt:at});
        if(['access_ip_blocked','authentication_failed','quota_exhausted'].includes(apiFailure)){
          state.api.blocked={code:apiFailure,at,jobId:sourceJobId,diagnostic:'acceptance'};
        }
        state.journal.push({at,type:'acceptance_failed',sourceJobId,code});
      });
    }catch{}
    log({at,type:'acceptance_failed',sourceJobId,code});
    return {status:'failed',sourceJobId,code};
  }
}
