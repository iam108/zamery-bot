'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createStaffMenu,getStaffMenu}=require('../src/bot/staff-menu');

function fixture(options={}) {
  let time=0;
  const staff=new Map((options.staff??[42]).map(id=>[String(id),true]));
  const calls=[],keys=[],queries=[],waits=[],logs=[];
  const pool={async query(sql,args){
    queries.push({sql,args});
    if(options.query)return options.query(sql,args,staff);
    const ids=[...staff].filter(([,approved])=>approved).map(([id])=>id);
    return {rows:(sql.includes('LIMIT 100')?ids.filter(id=>BigInt(id)>BigInt(args[0])).sort((a,b)=>Number(BigInt(a)-BigInt(b))).slice(0,100):ids.filter(id=>id===args[0])).map(tg_id=>({tg_id}))};
  }};
  const auth={async ensureStaff(){},keyQuery(id){keys.push(id);return 'u='+id+'&k=synthetic-'+id;}};
  const telegram={async setChatMenuButton(value){calls.push({value,time});return options.send?options.send(value,calls.length):true;}};
  const service=createStaffMenu({pool,auth,telegram,webappUrl:'https://example.invalid/',logger:{error(...value){logs.push(value);}},now:()=>time,async wait(ms){waits.push(ms);time+=ms;await options.onWait?.(ms,staff);},...options.config});
  return {service,staff,calls,keys,queries,waits,logs,auth,pool,telegram};
}
function telegramError(code,retry) { return {response:{error_code:code,parameters:{retry_after:retry}},message:'private synthetic-key raw error'}; }

test('personal menus contain only the same approved actor key and always specify a private chat',async()=>{
  const h=fixture({staff:[42,77,99]});
  assert.deepEqual(await h.service.syncApproved(),{updated:3,skipped:0,failed:0});
  assert.deepEqual(h.calls.map(x=>x.value.chatId),[42,77,99]);
  for(const {value} of h.calls) {
    assert.equal(value.menuButton.type,'web_app');assert.equal(value.menuButton.text,'📋 Новая заявка');
    const url=new URL(value.menuButton.web_app.url);
    assert.equal(url.origin,'https://example.invalid');assert.equal(url.pathname,'/form');
    assert.equal(url.searchParams.get('u'),String(value.chatId));assert.equal(url.searchParams.get('k'),'synthetic-'+value.chatId);
    assert.deepEqual([...url.searchParams.keys()].sort(),['k','u']);
  }
  assert.deepEqual(h.calls.map(x=>x.time),[0,1000,2000]);
});

test('actual Telegraf serializes the personal menu into chat_id, never the global menu',async()=>{
  const {Telegram}=require('telegraf'),telegram=new Telegram('synthetic-token');
  let payload;telegram.callApi=async(method,value)=>{assert.equal(method,'setChatMenuButton');payload=value;return true;};
  const h=fixture();const service=createStaffMenu({pool:h.pool,auth:h.auth,telegram,webappUrl:'https://example.invalid'});
  assert.deepEqual(await service.refresh(42),{state:'updated'});
  assert.equal(payload.chat_id,42);assert.equal(payload.menu_button.type,'web_app');assert.equal(new URL(payload.menu_button.web_app.url).searchParams.get('u'),'42');
});

test('invalid targets cannot produce a key or change the global/default menu',async()=>{
  const h=fixture();
  for(const value of [undefined,null,true,[],[42],{},0,-42,'-10042','@staff','42.0',' 42',Number.MAX_SAFE_INTEGER+1])assert.equal((await h.service.refresh(value)).code,'STAFF_MENU_INVALID_PRIVATE_CHAT');
  assert.equal(h.queries.length,0);assert.equal(h.keys.length,0);assert.equal(h.calls.length,0);
});

test('unknown and revoked staff never receive menu keys',async()=>{
  const h=fixture();h.staff.set('42',false);
  for(const id of [42,99])assert.equal((await h.service.refresh(id)).code,'STAFF_MENU_NOT_APPROVED');
  assert.deepEqual(h.keys,[]);assert.deepEqual(h.calls,[]);
});

test('same actor pending refreshes are deduplicated and different actors remain serial',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const h=fixture({staff:[42,77],async send(_value,n){if(n===1)await gate;return true;}});
  const one=h.service.refresh(42);assert.equal(h.service.refresh('42'),one);
  const two=h.service.refresh(77);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.length,1);release();await Promise.all([one,two]);
  assert.deepEqual(h.calls.map(x=>x.value.chatId),[42,77]);assert.deepEqual(h.waits,[1000]);
});

test('queued and listed staff approval is rechecked after rate-limit waits',async()=>{
  const h=fixture({staff:[42,77],onWait(_ms,staff){staff.set('77',false);}});
  assert.deepEqual(await h.service.syncApproved(),{updated:1,skipped:1,failed:0});
  assert.deepEqual(h.keys,['42']);assert.deepEqual(h.calls.map(x=>x.value.chatId),[42]);
});

test('429 retries are bounded and recheck approval before generating another key',async()=>{
  const h=fixture({send(){throw telegramError(429,1);}});
  assert.equal((await h.service.refresh(42)).code,'TELEGRAM_429');assert.equal(h.calls.length,3);assert.deepEqual(h.waits,[2000,2000]);
  const revoked=fixture({send(){throw telegramError(429,1);},onWait(_ms,staff){staff.set('42',false);}});
  assert.equal((await revoked.service.refresh(42)).code,'STAFF_MENU_NOT_APPROVED');assert.equal(revoked.calls.length,1);assert.equal(revoked.keys.length,1);
});

test('non-429 and unsafe retry_after errors never cause automatic retry or raw error logs',async()=>{
  for(const [code,retry] of [[502,1],[403,1],[400,1],[429,0],[429,31],[429,1.5],[429,'1']]) {
    const h=fixture({send(){throw telegramError(code,retry);}});assert.equal((await h.service.refresh(42)).state,'failed');assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);
    assert.doesNotMatch(JSON.stringify(h.logs),/private|synthetic|raw error/);
  }
});

test('a failed recipient does not stop other approved staff menu repairs',async()=>{
  const h=fixture({staff:[42,77,99],send(_value,n){if(n===1)throw telegramError(403);if(n===2)return false;return true;}});
  assert.deepEqual(await h.service.syncApproved(),{updated:1,skipped:0,failed:2});assert.equal(h.calls.length,3);
});

test('a hung Telegram request is bounded and the next recipient still runs',async()=>{
  const h=fixture({staff:[42,77],config:{timeoutMs:10},send(_value,n){return n===1?new Promise(()=>{}):true;}});
  assert.deepEqual(await h.service.syncApproved(),{updated:1,skipped:0,failed:1});assert.equal(h.calls.length,2);
  assert.ok(h.logs.some(row=>row.includes('STAFF_MENU_TIMEOUT')));
});

test('approval lookup and URL/key configuration failures issue no API or sensitive logs',async()=>{
  const h=fixture({query(){throw new Error('synthetic database detail');}});
  assert.equal((await h.service.refresh(42)).state,'failed');assert.deepEqual(h.keys,[]);assert.deepEqual(h.calls,[]);assert.doesNotMatch(JSON.stringify(h.logs),/synthetic database/);
  for(const webappUrl of ['http://example.invalid','https://example.invalid/form','https://example.invalid/?u=99&k=bad','https://user:password@example.invalid','bad']) {
    const invalid=fixture({config:{webappUrl}});assert.equal((await invalid.service.refresh(42)).state,'failed');assert.equal(invalid.calls.length,0);assert.equal(invalid.keys.length,0);
  }
  const wrong=fixture({config:{auth:{ensureStaff:async()=>{},keyQuery:()=> 'u=77&k=wrong-actor'}}});
  assert.equal((await wrong.service.refresh(42)).state,'failed');assert.equal(wrong.calls.length,0);
});

test('startup scans bounded pages, deduplicates concurrent scans and handles every approved actor once',async()=>{
  const h=fixture({staff:Array.from({length:101},(_,n)=>n+1)});
  const scan=h.service.syncApproved();assert.equal(h.service.syncApproved(),scan);
  assert.deepEqual(await scan,{updated:101,skipped:0,failed:0});
  assert.equal(h.calls.length,101);assert.equal(new Set(h.calls.map(x=>x.value.chatId)).size,101);
  assert.deepEqual(h.queries.filter(x=>x.sql.includes('LIMIT 100')).map(x=>x.args[0]),['0','100']);
});

test('a failed startup scan can be retried and a bot reuses the same configured menu service',async()=>{
  let bad=true;const h=fixture({query(sql){if(bad)throw Error('db');return {rows:[]};}});
  assert.equal((await h.service.syncApproved()).failed,1);bad=false;assert.deepEqual(await h.service.syncApproved(),{updated:0,skipped:0,failed:0});
  const bot={telegram:h.telegram};assert.equal(getStaffMenu(bot,{pool:h.pool,auth:h.auth,webappUrl:'https://example.invalid'}),getStaffMenu(bot));
});

test('real SQL approval policy includes every approved role and excludes revoked staff at final lookup',{skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();
  try {
    await db.exec("CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(42,'lawyer',true),(77,'auditor',true),(99,'manager',true),(123,'lawyer',false)");
    let clock=0;const calls=[],keys=[];
    const service=createStaffMenu({pool:db,auth:{async ensureStaff(){},keyQuery(id){keys.push(id);return 'u='+id+'&k=synthetic';}},telegram:{async setChatMenuButton(value){calls.push(value);return true;}},webappUrl:'https://example.invalid',now:()=>clock,async wait(ms){clock+=ms;await db.query('UPDATE staff SET approved=false WHERE tg_id=77');},logger:{error(){}}});
    assert.deepEqual(await service.syncApproved(),{updated:2,skipped:1,failed:0});
    assert.deepEqual(calls.map(x=>x.chatId),[42,99]);assert.deepEqual(keys,['42','99']);
    assert.equal((await service.refresh(123)).state,'skipped');
  } finally {await db.close();}
});
