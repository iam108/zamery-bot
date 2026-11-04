import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createReadiness,createHealthHandler,validateFsrarStat,safeErrorCode,retryStartup} from './health.mjs';

const INITIAL='2026-11-02T06:00:00.000Z';
function fixture(){
  const clock={at:Date.parse(INITIAL)};
  const health=createReadiness({now:()=>new Date(clock.at)});
  const ready=()=>{for(const name of ['telegram','google','api','worker'])health.success(name);health.running();};
  return {clock,health,ready};
}
const stat=(method={'Лимит':'100','ТипЛимита':'по запросам','Истрачено':'2'})=>({
  http_status:200,response:{'Методы':{fsrar:method}}});

test('readiness requires independent Telegram, Google, API and worker success',()=>{
  const {health}=fixture();
  assert.equal(health.snapshot().ready,false);
  for(const name of ['telegram','google','api'])health.success(name);
  health.running();assert.equal(health.snapshot().ready,false);
  health.success('worker');assert.equal(health.snapshot().ready,true);
  for(const name of ['telegram','google','api']){
    health.failure(name,`${name}_unavailable`);
    health.success('worker');
    assert.equal(health.snapshot().ready,false);
    assert.equal(health.snapshot().dependencies[name].lastError,`${name}_unavailable`);
    health.success(name);assert.equal(health.snapshot().ready,true);
  }
});

test('a worker tick never hides a polling failure and recovery requires another successful poll',()=>{
  const {health,clock,ready}=fixture();ready();
  health.failure('telegram','polling_conflict');
  clock.at+=60000;health.success('worker');health.success('google');health.success('api');
  const failed=health.snapshot();
  assert.equal(failed.ready,false);assert.equal(failed.lastError,'polling_conflict');
  assert.equal(failed.dependencies.telegram.lastSuccessAt,INITIAL);
  assert.equal(failed.dependencies.telegram.lastFailureAt,INITIAL);
  health.success('telegram');assert.equal(health.snapshot().ready,true);
});

test('missing successful polling for over 90 seconds causes readiness failure without mutating history',()=>{
  const {health,clock,ready}=fixture();ready();
  clock.at+=90000;health.success('worker');assert.equal(health.snapshot().ready,true);
  clock.at++;const stale=health.snapshot();
  assert.equal(stale.ready,false);assert.equal(stale.dependencies.telegram.lastError,'telegram_stale');
  assert.equal(stale.dependencies.telegram.lastSuccessAt,INITIAL);
  health.success('telegram');assert.equal(health.snapshot().ready,true);
});

test('a hung worker becomes unready after 180 seconds even while polling remains healthy',()=>{
  const {health,clock,ready}=fixture();ready();
  clock.at+=180000;health.success('telegram');assert.equal(health.snapshot().ready,true);
  clock.at++;health.success('telegram');
  assert.equal(health.snapshot().ready,false);
  assert.equal(health.snapshot().lastError,'worker_stale');
  health.success('worker');assert.equal(health.snapshot().ready,true);
});

test('startup configuration failures and shutdown cannot become ready through unrelated successes',()=>{
  const {health,ready}=fixture();ready();
  health.startupFailure('fsrar_stat_invalid_response',{delayMs:30000});
  for(const name of ['telegram','google','api','worker'])health.success(name);
  assert.equal(health.snapshot().ready,false);assert.equal(health.snapshot().stage,'configuration_error');
  assert.equal(health.snapshot().retryAt,'2026-11-02T06:00:30.000Z');
  health.running({dryRun:true});assert.equal(health.snapshot().stage,'dry_run');
  assert.equal(health.snapshot().lastError,null);
  health.stopping();assert.equal(health.snapshot().ready,false);assert.equal(health.snapshot().stage,'stopping');
});

test('HTTP health stays live while readiness returns 503 for degraded dependencies',async(t)=>{
  const {health,ready}=fixture();
  const server=http.createServer(createHealthHandler(health));
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise((resolve)=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  let response=await fetch(`${base}/health`);assert.equal(response.status,200);assert.equal((await response.json()).ready,false);
  assert.equal((await fetch(`${base}/ready`)).status,503);
  ready();response=await fetch(`${base}/ready`);assert.equal(response.status,200);assert.equal((await response.json()).ready,true);
  health.failure('api','access_ip_blocked');assert.equal((await fetch(`${base}/ready`)).status,503);
  assert.equal((await fetch(`${base}/health`)).status,200);assert.equal((await fetch(`${base}/unknown`)).status,404);
});

test('stat verifies the actual fsrar method and bounded numeric request quota',()=>{
  assert.deepEqual(validateFsrarStat(stat()),{total:100,used:2,remaining:98,limitType:'requests'});
  assert.deepEqual(validateFsrarStat(stat({'Лимит':100,'ТипЛимита':'по запросам','Истрачено':0})),
    {total:100,used:0,remaining:100,limitType:'requests'});
  for(const response of [null,'ok',[],{}, {'Методы':{}},{'Методы':[]}]){
    assert.throws(()=>validateFsrarStat({http_status:200,response}));
  }
  assert.throws(()=>validateFsrarStat(stat({'Лимит':'0','ТипЛимита':'по запросам','Истрачено':'0'})),{code:'fsrar_method_unavailable'});
  assert.throws(()=>validateFsrarStat(stat({'Лимит':'100','ТипЛимита':'по запросам','Истрачено':'100'})),{code:'fsrar_quota_exhausted'});
});

test('stat rejects malformed, negative, fractional and conflicting quotas instead of accepting HTTP 200',()=>{
  for(const [total,used]of [[undefined,'0'],['100',undefined],['','0'],['NaN','0'],['1e2','0'],['-1','0'],
    [100,-1],[100,2.5],[100,101],[true,0],[Infinity,0],[100,null],[Number.MAX_SAFE_INTEGER+1,0]]){
    assert.throws(()=>validateFsrarStat(stat({'Лимит':total,'ТипЛимита':'по запросам','Истрачено':used})),{code:'fsrar_stat_invalid_quota'});
  }
  assert.throws(()=>validateFsrarStat(stat({'Лимит':'100','ТипЛимита':'неизвестно','Истрачено':'2'})),{code:'fsrar_stat_unsupported_limit'});
});

test('stat access and authentication failures have precise codes without exposing provider bodies',()=>{
  const secret='private-value-that-must-not-be-logged';
  for(const [response,code]of [
    [{http_status:403,error:`Доступ с данного IP запрещен ${secret}`},'fsrar_access_ip_blocked'],
    [{http_status:200,response:{error:`Неверный ключ ${secret}`}},'fsrar_authentication_failed'],
    [{http_status:200,response:`Ошибка: Неверный ключ ${secret}`},'fsrar_authentication_failed'],
    [{http_status:401,response:{}},'fsrar_authentication_failed'],
    [{http_status:502,response:{}},'fsrar_stat_http_error'],
    [{transport_error:`Timeout ${secret}`},'fsrar_stat_network_error'],
  ])assert.throws(()=>validateFsrarStat(response),(error)=>error.code===code&&!error.message.includes(secret));
});

test('health and report error identifiers redact secrets and suppress arbitrary provider text',()=>{
  const secret='a'.repeat(40);
  assert.equal(safeErrorCode({code:'ENOENT'}),'ENOENT');
  assert.equal(safeErrorCode(new Error('missing_google_credentials')),'missing_google_credentials');
  assert.equal(safeErrorCode(new Error(`File /private/path ${secret}`),'safe_fallback',[secret]),'safe_fallback');
  assert.equal(safeErrorCode({code:secret},'safe_fallback',[secret]),'safe_fallback');
  const health=createReadiness({secrets:[secret]});health.failure('api',{code:secret});
  assert.equal(JSON.stringify(health.snapshot()).includes(secret),false);
});

test('startup retries use bounded exponential backoff and start no overlapping attempts',async()=>{
  const delays=[];const failures=[];let attempts=0;let active=0;let maximumActive=0;
  const result=await retryStartup(async()=>{
    active++;maximumActive=Math.max(maximumActive,active);
    try{await Promise.resolve();if(++attempts<7)throw new Error('google_network_error');return {runtime:'one'};}
    finally{active--;}
  },{wait:async(delay)=>{delays.push(delay);},onFailure:async(error,meta)=>{failures.push({code:error.message,...meta});}});
  assert.deepEqual(delays,[30000,60000,120000,240000,300000,300000]);
  assert.equal(maximumActive,1);assert.equal(attempts,7);assert.deepEqual(result,{runtime:'one'});
  assert.deepEqual(failures.map((failure)=>failure.attempt),[1,2,3,4,5,6]);
});

test('a transient startup failure recovers with unchanged credentials and clears configuration readiness',async()=>{
  const {health,clock}=fixture();let attempts=0;
  const runtime=await retryStartup(async()=>{
    health.begin();health.success('telegram');
    if(++attempts===1)throw new Error('google_network_error');
    health.success('google');health.success('api');health.success('worker');health.running();return {ready:true};
  },{onFailure:async(error,{delayMs})=>{health.failure('google',error);health.startupFailure(error,{delayMs});
    assert.equal(health.snapshot().ready,false);},wait:async(delay)=>{clock.at+=delay;}});
  assert.deepEqual(runtime,{ready:true});assert.equal(attempts,2);assert.equal(health.snapshot().ready,true);
  assert.equal(health.snapshot().lastError,null);
});

test('shutdown aborts startup backoff and never starts another attempt',async()=>{
  const controller=new AbortController();let attempts=0;
  const result=await retryStartup(async()=>{attempts++;throw new Error('fsrar_stat_network_error');},{
    signal:controller.signal,wait:async()=>{controller.abort();throw new Error('Aborted');}});
  assert.equal(result,null);assert.equal(attempts,1);
  assert.equal(await retryStartup(async()=>{attempts++;},{signal:controller.signal}),null);
  assert.equal(attempts,1);
  const abortedDuringInitialization=new AbortController();
  assert.equal(await retryStartup(async()=>{abortedDuringInitialization.abort();return {runtime:'discarded'};},
    {signal:abortedDuringInitialization.signal}),null);
});

test('enabled contact source is independently visible without invalidating core dependency successes',()=>{
  const health=createReadiness({contactsEnabled:true});
  for(const name of ['telegram','google','api','worker'])health.success(name);health.running();
  assert.equal(health.snapshot().ready,false);assert.equal(health.snapshot().dependencies.worker.ok,true);
  health.success('contacts');assert.equal(health.snapshot().ready,true);
  health.failure('contacts','contacts_source_failed');
  assert.equal(health.snapshot().ready,false);assert.equal(health.snapshot().dependencies.telegram.ok,true);
  assert.equal(health.snapshot().dependencies.api.ok,true);
});
