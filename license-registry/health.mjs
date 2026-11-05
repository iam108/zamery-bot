import {setTimeout as sleep} from 'node:timers/promises';

const NAMES=Object.freeze(['telegram','google','api','worker']);
function fail(code){throw Object.assign(new Error(code),{code});}

/** Only stable identifiers leave the process; provider bodies and paths do not. */
export function safeErrorCode(error,fallback='unknown_error',secrets=[]){
  let value=String(typeof error==='string'?error:error?.code??error?.message??'');
  for(const secret of secrets)if(secret)value=value.replaceAll(secret,'[REDACTED]');
  return /^[A-Za-z][A-Za-z0-9_]{0,119}$/u.test(value)?value:fallback;
}

function nonnegativeInteger(value){
  if(typeof value==='string'&&!/^\d+$/u.test(value.trim()))return null;
  if(typeof value!=='string'&&typeof value!=='number')return null;
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>=0?number:null;
}

/** Validate the observed API-FNS stat contract, not merely HTTP 200. */
export function validateFsrarStat(envelope){
  if(envelope?.transport_error)fail('fsrar_stat_network_error');
  const body=envelope?.response;
  const detail=String(envelope?.error??body?.error??body?.Ошибка??body?.non_json_response??(typeof body==='string'?body:''));
  if(envelope?.http_status===401||/неверн\p{L}*\s+ключ|недействительн\p{L}*\s+ключ|invalid.?key/iu.test(detail))fail('fsrar_authentication_failed');
  if(envelope?.http_status===403||/доступ с данного ip|ip.{0,40}(?:запрещ|недопуст)/iu.test(detail))fail('fsrar_access_ip_blocked');
  if(envelope?.http_status!==200)fail('fsrar_stat_http_error');
  if(envelope.error||!body||typeof body!=='object'||Array.isArray(body)||body.error||body.Ошибка||body.non_json_response)fail('fsrar_stat_invalid_response');
  const methods=body['Методы'];
  if(!methods||typeof methods!=='object'||Array.isArray(methods)||!Object.hasOwn(methods,'fsrar'))fail('fsrar_method_unavailable');
  const method=methods.fsrar;
  if(!method||typeof method!=='object'||Array.isArray(method))fail('fsrar_stat_invalid_quota');
  const total=nonnegativeInteger(method['Лимит']);
  const used=nonnegativeInteger(method['Истрачено']);
  if(total==null||used==null||used>total)fail('fsrar_stat_invalid_quota');
  if(total===0)fail('fsrar_method_unavailable');
  if(String(method['ТипЛимита']??'').trim().toLowerCase()!=='по запросам')fail('fsrar_stat_unsupported_limit');
  if(used===total)fail('fsrar_quota_exhausted');
  return {total,used,remaining:total-used,limitType:'requests'};
}

export function createReadiness({now=()=>new Date(),telegramMaxAgeMs=90_000,workerMaxAgeMs=180_000,secrets=[],contactsEnabled=false,ownerRepliesEnabled=false,registryCompletionEnabled=false}={}){
  const names=[...NAMES,...(contactsEnabled?['contacts']:[]),...(ownerRepliesEnabled?['ownerReplies']:[]),...(registryCompletionEnabled?['registryCompletion']:[])];
  const dependencies=Object.fromEntries(names.map((name)=>[name,{ok:false,lastSuccessAt:null,lastFailureAt:null,lastError:null}]));
  let started=false;let dryRun=false;let phase='starting';let startupError=null;let retryAt=null;
  const stamp=()=>new Date(now()).toISOString();
  function dependency(name){if(!Object.hasOwn(dependencies,name))throw new Error('unknown_health_dependency');return dependencies[name];}
  return {
    begin(stage='starting'){
      started=false;phase=stage;retryAt=null;
      for(const value of Object.values(dependencies))value.ok=false;
    },
    stage(value){phase=value;},
    success(name){Object.assign(dependency(name),{ok:true,lastSuccessAt:stamp(),lastError:null});},
    failure(name,error,fallback=`${name}_failed`){Object.assign(dependency(name),{
      ok:false,lastFailureAt:stamp(),lastError:safeErrorCode(error,fallback,secrets)});},
    startupFailure(error,{delayMs=0}={}){
      started=false;phase='configuration_error';startupError=safeErrorCode(error,'startup_failed',secrets);
      retryAt=new Date(+new Date(now())+delayMs).toISOString();
    },
    running({dryRun:observe=false}={}){started=true;dryRun=observe;phase=observe?'dry_run':'running';startupError=null;retryAt=null;},
    stopping(){started=false;phase='stopping';retryAt=null;},
    snapshot(){
      const instant=+new Date(now());const result=structuredClone(dependencies);
      for(const [name,maxAge]of [['telegram',telegramMaxAgeMs],['worker',workerMaxAgeMs],['ownerReplies',120_000],['registryCompletion',180_000]]){
        if(result[name]?.ok&&instant-Date.parse(result[name].lastSuccessAt)>maxAge){
          result[name].ok=false;result[name].lastError=`${name}_stale`;
        }
      }
      const ready=started&&names.every((name)=>result[name].ok);
      return {ready,stage:ready?(dryRun?'dry_run':'running'):started?'degraded':phase,
        lastError:startupError??names.map((name)=>result[name].lastError).find(Boolean)??null,
        retryAt,dependencies:result};
    },
  };
}

export function createHealthHandler(health){
  return (req,res)=>{
    if(req.url!=='/health'&&req.url!=='/ready'){res.writeHead(404);res.end();return;}
    const snapshot=health.snapshot();
    res.writeHead(req.url==='/health'||snapshot.ready?200:503,{
      'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({service:'license-registry',...snapshot}));
  };
}

/** Retries initialization only. The caller starts long-running loops once. */
export async function retryStartup(initialize,{signal,wait=sleep,onFailure=()=>{},initialDelayMs=30_000,maxDelayMs=300_000}={}){
  if(!Number.isFinite(initialDelayMs)||initialDelayMs<0||!Number.isFinite(maxDelayMs)||maxDelayMs<initialDelayMs)throw new Error('invalid_startup_retry_delay');
  let delay=initialDelayMs;let attempt=0;
  while(!signal?.aborted){
    try{const result=await initialize();return signal?.aborted?null:result;}
    catch(error){
      if(signal?.aborted)return null;
      attempt++;await onFailure(error,{attempt,delayMs:delay});
      try{await wait(delay,undefined,{signal});}catch(error){if(signal?.aborted)return null;throw error;}
      delay=Math.min(maxDelayMs,delay*2);
    }
  }
  return null;
}
