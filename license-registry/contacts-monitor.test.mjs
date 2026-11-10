import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from './state.mjs';
import {createReadiness} from './health.mjs';
import {createContactsMonitor,contactSyncOnce} from './contacts-monitor.mjs';
import {createNotifier} from './notifier.mjs';

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'license-contacts-monitor-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStore(path.join(dir,'state.json'));await store.update(()=>{});
  let instant=Date.parse('2026-11-10T08:00:00Z');const events=[];const logs=[];
  const now=()=>new Date(instant);const report=async(event)=>{events.push(event);return {delivery:'sent'};};
  const health=createReadiness({contactsEnabled:true,now});
  const monitor=()=>createContactsMonitor({store,report,now,log:(event)=>logs.push(event)});
  return {store,events,logs,now,report,health,monitor,advance:(ms)=>{instant+=ms;}};
}
const unavailable=(code)=>Object.assign(new Error('private provider contents'),{code});

test('an isolated Google transport failure recovers quietly after a completed tick',async(t)=>{
  const h=await fixture(t);const monitor=h.monitor();let failing=true;
  const contacts={tick:async()=>{if(failing)throw unavailable('google_network_error');return {updated:0};}};
  const args={...h,contacts,monitor};
  assert.equal((await contactSyncOnce(args)).ok,false);assert.equal(h.events.length,0);
  assert.equal(h.health.snapshot().dependencies.contacts.lastError,'google_network_error');
  h.advance(60000);failing=false;assert.equal((await contactSyncOnce(args)).ok,true);
  assert.equal(h.health.snapshot().dependencies.contacts.ok,true);assert.equal(h.events.length,0);
  assert.equal((await h.store.read()).runtime.contactSync.active,null);
  assert.ok(!JSON.stringify(h.logs).includes('private provider'));
});

test('sustained Google failure alerts once after two minutes without bypassing scheduled retry',async(t)=>{
  const h=await fixture(t);const monitor=h.monitor();let calls=0;let skip=true;
  const contacts={sourceFactory:()=>assert.fail('never precheck the source'),async tick(){calls++;return skip?{skipped:'not_due'}:{updated:0};}};
  await monitor.failure('google_network_error');const id=(await h.store.read()).runtime.contactSync.active.id;
  h.advance(119999);await contactSyncOnce({...h,monitor,contacts});assert.equal(h.events.length,0);
  h.advance(1);await contactSyncOnce({...h,monitor,contacts});await contactSyncOnce({...h,monitor,contacts});
  assert.equal(calls,3);assert.equal(h.events.length,1);assert.equal(h.events[0].type,'contact_source_error');
  assert.equal(h.events[0].code,'google_network_error');assert.equal(h.events[0].incidentId,id);
  assert.equal(h.health.snapshot().dependencies.contacts.ok,false);
  skip=false;await contactSyncOnce({...h,monitor,contacts});await contactSyncOnce({...h,monitor,contacts});
  assert.equal(h.events.length,2);assert.equal(h.events[1].type,'contact_source_recovered');assert.equal(h.events[1].incidentId,id);
});

test('credential or schema errors alert immediately; a later incident has a new identity',async(t)=>{
  const h=await fixture(t);const monitor=h.monitor();
  await monitor.failure('contacts_source_credentials_missing');await monitor.failure('contacts_source_credentials_missing');
  assert.equal(h.events.length,1);const first=h.events[0].incidentId;
  await monitor.success();await monitor.failure('contacts_source_schema_conflict');
  assert.equal(h.events.length,3);assert.equal(h.events[2].code,'contacts_source_schema_conflict');
  assert.notEqual(h.events[2].incidentId,first);
});

test('a persisted failed contact pass is not made healthy by not_due or busy after restart',async(t)=>{
  const h=await fixture(t);const success='2026-11-10T07:00:00.000Z';
  await h.store.update((s)=>{s.contacts={lastSuccessAt:success,lastError:'google_network_error',retryAt:'2026-11-10T08:05:00Z',records:{keep:{status:'planned',plan:{private:'unchanged'}}}};});
  const before=await h.store.read();
  for(const skipped of ['not_due','busy']){
    const monitor=h.monitor();await contactSyncOnce({...h,monitor,contacts:{tick:async()=>({skipped})}});
    const observed=h.health.snapshot().dependencies.contacts;
    assert.equal(observed.ok,false);assert.equal(observed.lastError,'google_network_error');assert.equal(observed.lastSuccessAt,success);
  }
  assert.deepEqual((await h.store.read()).contacts,before.contacts);assert.equal(h.events.length,0);
});

test('healthy persisted baseline keeps its original success time and does not force an early tick',async(t)=>{
  const h=await fixture(t);const success='2026-11-10T07:55:00.000Z';
  await h.store.update((s)=>{s.contacts={lastSuccessAt:success,lastError:null,nextSyncAt:'2026-11-10T08:10:00Z'};});
  const before=await h.store.read();let calls=0;
  await contactSyncOnce({...h,monitor:h.monitor(),contacts:{tick:async()=>{calls++;return {skipped:'not_due'};}}});
  const observed=h.health.snapshot().dependencies.contacts;
  assert.equal(observed.ok,true);assert.equal(observed.lastSuccessAt,success);assert.equal(calls,1);
  assert.deepEqual((await h.store.read()).contacts,before.contacts);assert.equal(h.events.length,0);
});

test('legacy sent or pending alerts recover once only after a complete pass, including restart',async(t)=>{
  for(const status of ['sent','pending']){
    const h=await fixture(t);
    await h.store.update((s)=>{s.runtime={notifications:{legacy:{status,createdAt:h.now().toISOString(),event:{type:'contact_source_error',code:'unknown_error'}}}};
      s.contacts={lastSuccessAt:'2026-11-10T07:00:00Z',lastError:null,records:{keep:{status:'planned',plan:{keep:true}}}};});
    const before=await h.store.read();let monitor=h.monitor();
    await contactSyncOnce({...h,monitor,contacts:{tick:async()=>({skipped:'not_due'})}});
    assert.equal(h.health.snapshot().dependencies.contacts.ok,false);assert.equal(h.events.length,0);
    monitor=h.monitor();await contactSyncOnce({...h,monitor,contacts:{tick:async()=>({updated:0})}});
    await contactSyncOnce({...h,monitor:h.monitor(),contacts:{tick:async()=>({updated:0})}});
    assert.equal(h.events.length,1);assert.equal(h.events[0].type,'contact_source_recovered');assert.equal(h.events[0].legacy,true);
    assert.match(h.events[0].incidentId,/^[a-f0-9]{32}$/u);
    assert.deepEqual((await h.store.read()).contacts,before.contacts);
  }
});

test('a complete persisted pass newer than a legacy alert restores health and recovery without an early scan',async(t)=>{
  const h=await fixture(t);const success='2026-11-10T07:56:00.000Z';
  await h.store.update((s)=>{
    s.runtime={notifications:{legacy:{status:'sent',createdAt:'2026-11-10T07:55:00.000Z',
      event:{type:'contact_source_error',code:'unknown_error'}}}};
    s.contacts={lastSuccessAt:success,lastError:null,nextSyncAt:'2026-11-10T08:10:00.000Z',records:{keep:{status:'planned',plan:{unchanged:true}}}};
  });
  const before=await h.store.read();const contacts={tick:async()=>({skipped:'not_due'})};
  await contactSyncOnce({...h,monitor:h.monitor(),contacts});
  assert.equal(h.health.snapshot().dependencies.contacts.ok,true);
  assert.equal(h.health.snapshot().dependencies.contacts.lastSuccessAt,success);
  assert.equal(h.events.length,1);assert.equal(h.events[0].type,'contact_source_recovered');assert.equal(h.events[0].legacy,true);
  await contactSyncOnce({...h,monitor:h.monitor(),contacts});assert.equal(h.events.length,1);
  assert.deepEqual((await h.store.read()).contacts,before.contacts);
});

test('restart after a completed pass but before recovery persistence closes the existing incident',async(t)=>{
  const h=await fixture(t);await h.monitor().failure('contacts_source_permissions_invalid');
  const id=h.events[0].incidentId;h.advance(60000);const success=h.now().toISOString();
  await h.store.update((s)=>{s.contacts={lastSuccessAt:success,lastError:null,nextSyncAt:'2026-11-10T08:16:00.000Z'};});
  await contactSyncOnce({...h,monitor:h.monitor(),contacts:{tick:async()=>({skipped:'not_due'})}});
  assert.equal(h.events.length,2);assert.equal(h.events[1].type,'contact_source_recovered');assert.equal(h.events[1].incidentId,id);
  assert.equal(h.health.snapshot().dependencies.contacts.ok,true);
  assert.equal(h.health.snapshot().dependencies.contacts.lastSuccessAt,success);
  assert.equal((await h.store.read()).runtime.contactSync.active,null);
});

test('a durable alert followed by a report exception still receives one matching recovery',async(t)=>{
  const h=await fixture(t);
  const monitor=createContactsMonitor({store:h.store,now:h.now,report:async(event)=>{
    await h.store.update((s)=>{s.runtime.notifications={saved:{event,status:'pending'}};});throw new Error('delivery failed');
  }});
  await assert.rejects(monitor.failure('contacts_source_permissions_invalid'));
  const id=(await h.store.read()).runtime.contactSync.active.id;
  await h.monitor().success();await h.monitor().success();
  assert.equal(h.events.length,1);assert.equal(h.events[0].type,'contact_source_recovered');assert.equal(h.events[0].incidentId,id);
});

test('notification or incident storage errors never turn a successful contact pass into failure',async()=>{
  const calls=[];const logs=[];const monitor={restoreHealth:async()=>{},success:async()=>{throw new Error('notification disk');},
    failure:async()=>{throw new Error('notification disk');},heartbeat:async()=>{throw new Error('notification disk');}};
  const health={success:(name)=>calls.push(['success',name]),failure:(name,code)=>calls.push(['failure',name,code])};
  const args={monitor,health,log:(e)=>logs.push(e)};
  assert.equal((await contactSyncOnce({...args,contacts:{tick:async()=>({updated:1})}})).ok,true);
  assert.deepEqual(calls,[['success','contacts']]);assert.equal(logs[0].code,'contacts_recovery_save_failed');
  assert.equal((await contactSyncOnce({...args,contacts:{tick:async()=>{throw unavailable('google_network_error');}}})).ok,false);
  assert.deepEqual(calls[1],['failure','contacts','google_network_error']);assert.equal(logs[1].code,'contacts_incident_save_failed');
  await contactSyncOnce({...args,contacts:{tick:async()=>({skipped:'not_due'})}});
  assert.equal(calls.length,2);assert.equal(logs[2].code,'contacts_alert_save_failed');
});

test('simultaneous monitor calls share one incident and intentional shutdown stays quiet',async(t)=>{
  const h=await fixture(t);const monitor=h.monitor();
  await Promise.all([monitor.failure('contacts_source_permissions_invalid'),monitor.failure('contacts_source_permissions_invalid')]);
  assert.equal(h.events.length,1);assert.equal((await h.store.read()).runtime.contactSync.active.failures,2);
  await Promise.all([monitor.success(),monitor.success()]);assert.equal(h.events.length,2);
  const controller=new AbortController();controller.abort();const before=await h.store.read();
  const result=await contactSyncOnce({...h,monitor,signal:controller.signal,contacts:{tick:async()=>{throw unavailable('contacts_source_closed');}}});
  assert.deepEqual(result,{stopped:true});assert.equal(h.events.length,2);
  assert.deepEqual((await h.store.read()).contacts,before.contacts);
});

test('actual notifier supersedes an undelivered legacy alert and delivers one confirmed recovery',async(t)=>{
  const h=await fixture(t);const sent=[];const owner='123456789';
  const telegram={call:async(method,params)=>{if(method==='getChat')return {id:Number(owner),type:'private'};
    sent.push(params.text);return {message_id:sent.length,chat:{id:Number(owner),type:'private'}};}};
  const report=createNotifier({store:h.store,telegram,ownerChatId:owner,now:h.now,log:()=>{}});
  // Queue a legacy failure while Telegram is unavailable, then restore delivery.
  telegram.call=async()=>{throw unavailable('network_error');};await report({type:'contact_source_error',code:'contacts_source_failed'});
  telegram.call=async(method,params)=>{if(method==='getChat')return {id:Number(owner),type:'private'};
    sent.push(params.text);return {message_id:sent.length,chat:{id:Number(owner),type:'private'}};};
  const monitor=createContactsMonitor({store:h.store,report,now:h.now});
  await contactSyncOnce({...h,monitor,contacts:{tick:async()=>({updated:0})}});await monitor.success();
  assert.equal(sent.length,1);assert.match(sent[0],/восстановлено/u);
  const notifications=Object.values((await h.store.read()).runtime.notifications);
  assert.equal(notifications.find((item)=>item.event.type==='contact_source_error').status,'superseded');
  assert.equal(notifications.find((item)=>item.event.type==='contact_source_recovered').status,'sent');
});

test('an invalid tick result never clears a failed incident or marks contacts ready',async(t)=>{
  const h=await fixture(t);const monitor=h.monitor();await monitor.failure('contacts_source_schema_conflict');
  const incident=(await h.store.read()).runtime.contactSync.active.id;
  const result=await contactSyncOnce({...h,monitor,contacts:{tick:async()=>undefined}});
  assert.equal(result.ok,false);assert.equal(h.health.snapshot().dependencies.contacts.ok,false);
  assert.equal((await h.store.read()).runtime.contactSync.active.id,incident);
  assert.equal(h.events.length,1);
});
