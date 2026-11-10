import {randomUUID,createHash} from 'node:crypto';
import {safeErrorCode} from './health.mjs';

const accepted=(result)=>['sent','pending','duplicate','log_only'].includes(result?.delivery);
const transient=new Set(['google_network_error','google_rate_limited']);
const stamp=(now)=>new Date(now()).toISOString();
const clone=(value)=>structuredClone(value);
const durableAlert=(state,id)=>Object.values(state.runtime?.notifications??{}).some((item)=>
  item.event?.type==='contact_source_error'&&item.event.incidentId===id
  &&['sent','pending','logged'].includes(item.status));

/** Contact incidents are independent of license jobs, source credentials and Google plans. */
export function createContactsMonitor({store,report,now=()=>new Date(),log=()=>{},alertAfterMs=120_000,secrets=[]}={}){
  if(typeof store?.read!=='function'||typeof store?.update!=='function'||typeof report!=='function'
    ||!Number.isFinite(alertAfterMs)||alertAfterMs<0)throw new TypeError('Invalid contacts monitor');
  let loaded=false;let active=null;let restored=false;let queue=Promise.resolve();
  // The scheduled loop and registry-completion trigger share this monitor.
  const serial=(operation)=>{const next=queue.then(operation);queue=next.catch(()=>{});return next;};
  async function load(){
    if(loaded)return;
    const state=await store.read();const saved=state.runtime?.contactSync;
    let observed=saved?.active??null;
    if(!saved?.legacyExamined){
      const legacy=Object.entries(state.runtime?.notifications??{}).filter(([,item])=>
        item.event?.type==='contact_source_error'&&!item.event.incidentId&&['sent','pending'].includes(item.status))
        .sort(([,a],[,b])=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if(!observed&&legacy){
        const at=Number.isFinite(Date.parse(legacy[1].createdAt))?legacy[1].createdAt:stamp(now);
        observed={id:createHash('sha256').update(`contacts:${legacy[0]}`).digest('hex').slice(0,32),
          firstFailureAt:at,lastFailureAt:at,failures:1,code:safeErrorCode(legacy[1].event.code,'contacts_source_failed',secrets),
          alerted:true,legacy:true};
      }
      await store.update((current)=>{
        current.runtime??={};current.runtime.contactSync??={};
        current.runtime.contactSync.legacyExamined=true;
        if(observed)current.runtime.contactSync.active=clone(observed);
      });
    }
    active=observed;loaded=true;
  }
  async function maybeAlert(){
    if(!active||active.alerted)return;
    if(durableAlert(await store.read(),active.id)){
      active={...active,alerted:true};
      await store.update((state)=>{state.runtime.contactSync.active=clone(active);});return;
    }
    if(transient.has(active.code)&&+new Date(now())-Date.parse(active.firstFailureAt)<alertAfterMs)return;
    const result=await report({type:'contact_source_error',code:active.code,incidentId:active.id});
    if(accepted(result)){
      const updated={...active,alerted:true};
      await store.update((state)=>{state.runtime.contactSync.active=clone(updated);});active=updated;
    }
  }
  function confirmedSuccess(state){
    const value=state.contacts?.lastSuccessAt;
    return active&&!state.contacts?.lastError&&typeof value==='string'&&Number.isFinite(Date.parse(value))
      &&Date.parse(value)<=+new Date(now())&&Date.parse(value)>Date.parse(active.lastFailureAt);
  }
  const failure=(error)=>serial(async()=>{
    await load();const at=stamp(now);const first=!active;
    const updated={...(active??{id:randomUUID(),firstFailureAt:at,failures:0,alerted:false}),
      lastFailureAt:at,code:safeErrorCode(error,'contacts_source_failed',secrets),failures:(active?.failures??0)+1};
    await store.update((state)=>{state.runtime??={};state.runtime.contactSync??={};state.runtime.contactSync.active=clone(updated);});
    active=updated;
    if(first)log({at,type:'contact_sync_failure',incidentId:active.id,code:active.code});
    await maybeAlert();
  });
  async function settleSuccess(){
    if(!active)return;
    const wasAlerted=active.alerted||durableAlert(await store.read(),active.id);
    let recoveryDelivery='quiet';
    if(wasAlerted){
      const result=await report({type:'contact_source_recovered',incidentId:active.id,...active.legacy?{legacy:true}:{}});
      if(!accepted(result))return;
      recoveryDelivery=result.delivery;
    }
    const at=stamp(now);const incidentId=active.id;
    await store.update((state)=>{
      state.runtime??={};state.runtime.contactSync??={};
      Object.assign(state.runtime.contactSync,{active:null,lastRecoveredAt:at,lastIncidentId:incidentId});
    });active=null;
    log({at,type:'contact_sync_recovered',incidentId,ownerAlerted:wasAlerted,recoveryDelivery});
  }
  const heartbeat=()=>serial(async()=>{
    await load();
    // A prior process can finish and persist a complete pass before it records
    // recovery. That durable result is stronger evidence than a source probe.
    if(confirmedSuccess(await store.read()))await settleSuccess();else await maybeAlert();
  });
  const success=()=>serial(async()=>{await load();await settleSuccess();});
  const restoreHealth=(health)=>serial(async()=>{
    if(restored)return;
    await load();const state=await store.read();const contacts=state.contacts??{};
    const lastSuccessAt=Number.isFinite(Date.parse(contacts.lastSuccessAt))&&Date.parse(contacts.lastSuccessAt)<=+new Date(now())
      ?contacts.lastSuccessAt:null;
    if(confirmedSuccess(state)){
      health.restore('contacts',{lastSuccessAt,lastError:null});
      await settleSuccess();restored=true;return;
    }
    const code=active?.code??contacts.lastError;
    if(code)health.restore('contacts',{lastSuccessAt,lastFailureAt:active?.lastFailureAt??null,
      lastError:safeErrorCode(code,'contacts_source_failed',secrets)});
    else if(lastSuccessAt)health.restore('contacts',{lastSuccessAt,lastError:null});
    restored=true;
  });
  return {failure,success,heartbeat,restoreHealth};
}

/** Only a completed tick restores readiness or closes an incident; schedule skips do neither. */
export async function contactSyncOnce({contacts,monitor,health,signal,secrets=[],log=()=>{}}){
  try{await monitor.restoreHealth(health);}
  catch{log({type:'notification_error',code:'contacts_baseline_restore_failed'});}
  let result;let error;
  try{
    result=await contacts.tick();
    if(!result||typeof result!=='object'||Array.isArray(result))throw Object.assign(new Error('contacts_tick_invalid_result'),{code:'contacts_tick_invalid_result'});
  }catch(caught){error=caught;}
  if(signal?.aborted)return {stopped:true};
  if(error){
    const code=safeErrorCode(error,'contacts_source_failed',secrets);health.failure('contacts',code);
    try{await monitor.failure(code);}catch{log({type:'notification_error',code:'contacts_incident_save_failed'});}
    return {ok:false,code};
  }
  if(result?.skipped){
    try{await monitor.heartbeat();}catch{log({type:'notification_error',code:'contacts_alert_save_failed'});}
    return {ok:true,result};
  }
  health.success('contacts');
  try{await monitor.success();}catch{log({type:'notification_error',code:'contacts_recovery_save_failed'});}
  return {ok:true,result};
}
