import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from './state.mjs';
import {createPollingMonitor,pollOnce,safeNotification} from './polling.mjs';
import {createNotifier} from './notifier.mjs';

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'license-polling-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(path.join(dir,'state.json'));await store.update(()=>{});
  let instant=Date.parse('2026-11-04T11:00:00Z');const events=[];const logs=[];
  const now=()=>new Date(instant);
  const report=async(event)=>{events.push(event);return {delivery:'sent'};};
  return {store,events,logs,now,advance:(ms)=>{instant+=ms;},report,
    monitor:()=>createPollingMonitor({store,report,now,log:(event)=>logs.push(event)})};
}

test('single network failure recovers quietly; sustained outage alerts once then recovers',async(t)=>{
  const h=await fixture(t);const monitor=h.monitor();
  await monitor.failure({code:'network_error',phase:'receive'});h.advance(5000);await monitor.success();
  assert.equal(h.events.length,0);assert.equal((await h.store.read()).runtime.telegramPolling.active,null);
  await monitor.failure({code:'timeout',phase:'receive'});h.advance(120000);
  await monitor.failure({code:'timeout',phase:'receive'});await monitor.failure({code:'timeout',phase:'receive'});
  assert.equal(h.events.length,1);assert.equal(h.events[0].type,'telegram_error');
  await monitor.success();await monitor.success();
  assert.equal(h.events.length,2);assert.equal(h.events[1].type,'telegram_recovered');
  assert.equal(h.events[0].incidentId,h.events[1].incidentId);
});

test('storage failure alerts immediately and recovery survives restart',async(t)=>{
  const h=await fixture(t);await h.monitor().failure({code:'state_locked',phase:'persist'});
  assert.equal(h.events[0].code,'state_locked');const id=h.events[0].incidentId;
  await h.monitor().success();assert.equal(h.events[1].incidentId,id);
  assert.equal((await h.store.read()).runtime.telegramPolling.active,null);
});

test('unrecorded alert delivery is retried and a persisted alert gets recovery after uncertain delivery',async(t)=>{
  const h=await fixture(t);let calls=0;
  const report=async(event)=>{calls++;
    if(calls===1){await h.store.update((s)=>{s.runtime.notifications={one:{event,status:'pending'}};});throw new Error('storage unavailable');}
    h.events.push(event);return {delivery:'pending'};
  };
  const monitor=createPollingMonitor({store:h.store,report,now:h.now});
  await assert.rejects(monitor.failure({code:'state_locked',phase:'persist'}));
  await h.monitor().success();assert.equal(h.events[0].type,'telegram_recovered');
});

test('queued legacy error receives one recovery after successful durable poll',async(t)=>{
  const h=await fixture(t);
  await h.store.update((s)=>{s.runtime={notifications:{legacy:{status:'sent',createdAt:h.now().toISOString(),
    event:{type:'telegram_error',code:'telegram_poll_failed'}}}};});
  await h.monitor().success();await h.monitor().success();
  assert.equal(h.events.length,1);assert.equal(h.events[0].type,'telegram_recovered');
  assert.match(h.events[0].incidentId,/^[a-f0-9]{32}$/);
});

test('receive and durable-save failures have distinct phases; persistence failure does not request next offset',async()=>{
  const state={telegram:{offset:42,inbox:[]}};let requests=0;const failures=[];
  const args={store:{read:async()=>state},telegram:{getUpdates:async({offset})=>{requests++;assert.equal(offset,42);return[{update_id:42}];}},
    persist:async()=>{throw new Error('disk stalled');},health:{failure:(_name,code)=>failures.push(code),success:()=>assert.fail('not persisted')},
    monitor:{failure:async({phase})=>assert.equal(phase,'persist'),success:()=>assert.fail()}};
  const result=await pollOnce(args);assert.equal(result.code,'telegram_persist_failed');assert.equal(result.phase,'persist');
  assert.equal(requests,1);assert.equal(state.telegram.offset,42);assert.deepEqual(failures,['telegram_persist_failed']);
  args.telegram.getUpdates=async()=>{throw Object.assign(new Error('safe'),{code:'network_error'});};
  args.monitor.failure=async({phase})=>assert.equal(phase,'receive');
  assert.equal((await pollOnce(args)).code,'network_error');
});

test('notification persistence errors cannot turn successful poll into failure or kill retry',async()=>{
  let successes=0;const logs=[];
  const result=await pollOnce({store:{read:async()=>({})},telegram:{getUpdates:async()=>[]},persist:async()=>{},
    health:{success:()=>successes++,failure:()=>assert.fail()},monitor:{success:async()=>{throw new Error('private');}},log:(e)=>logs.push(e)});
  assert.equal(result.ok,true);assert.equal(successes,1);assert.equal(logs[0].code,'polling_recovery_save_failed');
  const safe=safeNotification(async()=>{throw new Error('private credential');},{log:(e)=>logs.push(e)});
  assert.equal((await safe()).delivery,'failed');assert.ok(!JSON.stringify(logs).includes('private'));
});

test('failure reporting may fail while polling remains retryable; intentional cancellation is quiet',async()=>{
  const controller=new AbortController();const logs=[];
  const args={store:{read:async()=>{throw new Error('private state contents');}},telegram:{},persist:()=>assert.fail(),
    health:{failure:()=>{},success:()=>assert.fail()},monitor:{failure:async()=>{throw new Error('failed notification');}},log:(e)=>logs.push(e)};
  const result=await pollOnce(args);assert.equal(result.ok,false);assert.equal(result.code,'state_read_failed');
  assert.equal(logs.length,1);controller.abort();args.signal=controller.signal;
  assert.deepEqual(await pollOnce(args),{stopped:true});assert.equal(logs.length,1);
});

test('actual notifier confirms recovery only after durable source save and keeps business queue intact',async(t)=>{
  const h=await fixture(t);const calls=[];const owner='123456789';
  const telegram={getUpdates:async()=>[{update_id:42}],call:async(method,params)=>{
    if(method==='getChat')return {id:Number(owner),type:'private'};
    calls.push(params);return {message_id:calls.length,chat:{id:Number(owner),type:'private'}};
  }};
  const report=createNotifier({store:h.store,telegram,ownerChatId:owner,now:h.now,log:()=>{}});
  const monitor=createPollingMonitor({store:h.store,report,now:h.now});
  await monitor.failure({code:'state_locked',phase:'persist'});
  const before=await h.store.read();
  const result=await pollOnce({store:h.store,telegram,monitor,health:{success:()=>{},failure:()=>assert.fail()},
    persist:async()=>h.store.update((s)=>{s.telegram={offset:43,inbox:[{updateId:42,message:{text:'source'}}]};})});
  const after=await h.store.read();
  assert.equal(result.ok,true);assert.equal(after.telegram.offset,43);assert.equal(after.telegram.inbox.length,1);
  assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.sources,before.sources);assert.deepEqual(after.api,before.api);
  assert.equal(calls.length,2);assert.ok(calls.every((call)=>call.chat_id===owner));
  assert.match(calls[0].text,/очереди/u);assert.match(calls[1].text,/восстановлено/u);
  assert.equal(after.runtime.telegramPolling.active,null);
});
