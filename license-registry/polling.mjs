import {randomUUID,createHash} from 'node:crypto';
import {safeErrorCode} from './health.mjs';

const accepted=(result)=>['sent','pending','duplicate','log_only'].includes(result?.delivery);
const transient=new Set(['network_error','timeout','api_error','rate_limited']);
const stamp=(now)=>new Date(now()).toISOString();
const clone=(value)=>structuredClone(value);

/** Persistent incidents; isolated network retries stay quiet, real alerts get recovery. */
export function createPollingMonitor({store,report,now=()=>new Date(),log=()=>{},alertAfterMs=120_000}={}){
  let loaded=false;let active=null;
  async function load(){
    if(loaded)return;
    const state=await store.read();
    const saved=state.runtime?.telegramPolling;
    active=saved?.active??null;
    if(!saved?.legacyExamined){
      const legacy=Object.entries(state.runtime?.notifications??{}).filter(([,item])=>
        item.event?.type==='telegram_error'&&!item.event.incidentId&&['sent','pending'].includes(item.status))
        .sort(([,a],[,b])=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if(!active&&legacy)active={id:createHash('sha256').update(legacy[0]).digest('hex').slice(0,32),
        firstFailureAt:legacy[1].createdAt,lastFailureAt:legacy[1].createdAt,failures:1,
        code:legacy[1].event.code,phase:'legacy',alerted:true};
      await store.update((current)=>{
        current.runtime??={};current.runtime.telegramPolling??={};
        current.runtime.telegramPolling.legacyExamined=true;
        if(active)current.runtime.telegramPolling.active=clone(active);
      });
    }
    loaded=true;
  }
  async function failure({code,phase}){
    await load();
    const at=stamp(now);const first=!active;
    active??={id:randomUUID(),firstFailureAt:at,failures:0,alerted:false};
    Object.assign(active,{lastFailureAt:at,code,phase,failures:active.failures+1});
    await store.update((state)=>{state.runtime??={};state.runtime.telegramPolling??={};state.runtime.telegramPolling.active=clone(active);});
    if(first)log({at,type:'telegram_poll_failure',incidentId:active.id,code,phase});
    const elapsed=+new Date(at)-Date.parse(active.firstFailureAt);
    if(!active.alerted&&(!transient.has(code)||phase!=='receive'||elapsed>=alertAfterMs)){
      const result=await report({type:'telegram_error',code,incidentId:active.id});
      if(accepted(result)){
        active.alerted=true;
        await store.update((state)=>{state.runtime.telegramPolling.active=clone(active);});
      }
    }
  }
  async function success(){
    await load();if(!active)return;
    // report() can persist an alert and then fail while delivering it. Detect
    // that durable record before deciding whether a recovery is necessary.
    const state=await store.read();
    const wasAlerted=active.alerted||Object.values(state.runtime?.notifications??{}).some((item)=>
      item.event?.type==='telegram_error'&&item.event.incidentId===active.id);
    if(wasAlerted){
      const result=await report({type:'telegram_recovered',incidentId:active.id});
      if(!accepted(result))return;
    }
    const at=stamp(now);const incidentId=active.id;
    await store.update((current)=>{
      current.runtime??={};current.runtime.telegramPolling??={};
      Object.assign(current.runtime.telegramPolling,{active:null,lastRecoveredAt:at,lastIncidentId:incidentId});
    });
    active=null;
    log({at,type:'telegram_poll_recovered',incidentId,ownerNotified:wasAlerted});
  }
  return {failure,success};
}

/** Only transport/persistence failures affect polling health, never alert delivery. */
export async function pollOnce({store,telegram,persist,monitor,health,signal,secrets=[],log=()=>{}}){
  let phase='state_read';let error;
  try{
    const state=await store.read();phase='receive';
    const updates=await telegram.getUpdates({offset:state.telegram?.offset??0,signal});
    phase='persist';await persist(updates);
  }catch(caught){error=caught;}
  if(signal?.aborted)return {stopped:true};
  if(error){
    const fallback=phase==='receive'?'telegram_poll_failed':phase==='persist'?'telegram_persist_failed':'state_read_failed';
    const code=safeErrorCode(error,fallback,secrets);
    health.failure('telegram',code);
    try{await monitor.failure({code,phase});}
    catch{log({type:'notification_error',code:'polling_incident_save_failed',phase});}
    return {ok:false,code,phase,retryMs:Math.min(60_000,Math.max(5000,(error.retryAfter||5)*1000))};
  }
  health.success('telegram');
  try{await monitor.success();}catch{log({type:'notification_error',code:'polling_recovery_save_failed'});}
  return {ok:true};
}

/** Notification persistence/delivery errors must never stop business processing. */
export function safeNotification(operation,{log=()=>{}}={}){
  return async(...args)=>{
    try{return await operation(...args);}
    catch{log({at:new Date().toISOString(),type:'notification_error',code:'notification_persistence_failed'});return {delivery:'failed'};}
  };
}
