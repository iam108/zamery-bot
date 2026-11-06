'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { telegramMessageUrl, loadOrderReportLink, syncOrderReportLink, previewOrderReportLinks, applyOrderReportLinks } = require('../src/web/order-report-link');
const pg = { skip: !process.env.PGLITE_TEST_MODULE }, GROUP = '-1001111111111', OTHER = '-1002222222222';
const rejection = (code, description) => Object.assign(new Error(description), { response: { error_code: code, description } });

async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite(), calls = [], reads = [];
  await db.exec('CREATE TABLE orders(id INT PRIMARY KEY,status TEXT,telegram_msg_id BIGINT); CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ);');
  await db.query("INSERT INTO orders VALUES(60,'in_progress',50),(61,'done',51),(62,'done',NULL),(63,'cancelled',53)");
  let inside = false, lockedReads = false, beforeLock, send, tail = Promise.resolve();
  const pool = { async query(sql, params) { assert.match(sql,/^SELECT\b/,'The report-link helpers must not change application data'); if (lockedReads) assert.equal(inside,true,'Resolve report within the order-card lock'); reads.push(sql); return db.query(sql,params); } };
  const options = { pool, groupId: GROUP, async getOrderById(id) { assert.equal(inside,true,'Read the current order inside the card lock'); return (await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0]; },
    async withOrderDeliveryLock(id,run) { const previous = tail; let release; tail = new Promise(resolve=>{ release=resolve; }); await previous; inside=true; try { if(beforeLock)await beforeLock(id); return await run(); } finally { inside=false; release(); } },
    telegram: { async editMessageReplyMarkup(...args) { assert.equal(inside,true); calls.push(args); if(send)await send(args); return { ok:true }; } },
    cardOptions(order,url) { assert.equal(inside,true); return { reply_markup:{ inline_keyboard:[[{text:order.status,callback_data:'status:'+order.status+':'+order.id}],[{text:'Перейти к отчёту',url}]] } }; },
  };
  const audit = async ({id=1,order=60,chat=GROUP,ids=[101,102],at='2026-11-01T12:00:00Z'}={}) => db.query('INSERT INTO audits VALUES($1,$2,$3,$4,$5)',[id,order,chat,ids,at]);
  try { await run({db,pool,options,calls,reads,audit,lockReads(){lockedReads=true;},onLock(fn){beforeLock=fn;},onSend(fn){send=fn;},sync:(id=60,extra={})=>syncOrderReportLink(id,{...options,...extra})}); }
  finally { await db.close(); }
}

test('Telegram report links accept only supported exact chat and positive safe message IDs',()=>{
  assert.equal(telegramMessageUrl(GROUP,101),'https://t.me/c/1111111111/101');
  assert.equal(telegramMessageUrl('@public_audit','101'),'https://t.me/public_audit/101');
  for(const [chat,id]of [[GROUP,0],[GROUP,-1],[GROUP,1.5],[GROUP,'1e2'],[GROUP,Infinity],[GROUP,Number.MAX_SAFE_INTEGER+1],['-100000',1],['42',1],['bad',1],['@bad',1]])assert.equal(telegramMessageUrl(chat,id),null);
});

test('latest saved report is scoped to the exact order and preserves its first stored summary ID instead of a minimum ID',pg,()=>fixture(async h=>{
  await h.audit(); await h.audit({id:2,ids:[209,201],at:'2026-11-02T12:00:00Z'}); await h.audit({id:3,order:61,chat:OTHER,ids:[999],at:'2026-11-03T12:00:00Z'});
  assert.deepEqual(await loadOrderReportLink(60,{pool:h.pool}),{audit_id:2,chat_id:GROUP,message_id:209,url:'https://t.me/c/1111111111/209'});
  assert.equal((await loadOrderReportLink(61,{pool:h.pool})).message_id,999); assert.equal(await loadOrderReportLink(62,{pool:h.pool}),null); assert.equal(h.calls.length,0);
}));

test('a partial report and malformed newer rows cannot replace the previous valid persisted report',pg,()=>fixture(async h=>{
  await h.audit(); const previous = await loadOrderReportLink(60,{pool:h.pool});
  // A partially delivered report has no audit row yet. Later malformed legacy
  // records must not erase the previous usable summary either.
  for(const [index,chat,ids]of [[2,GROUP,[]],[3,GROUP,[0,900]],[4,null,[901]],[5,-42,[902]],[6,GROUP,[Number.MAX_SAFE_INTEGER+1]]])await h.audit({id:index,chat,ids,at:'2026-11-04T12:00:00Z'});
  assert.deepEqual(await loadOrderReportLink(60,{pool:h.pool}),previous);
  await h.audit({id:7,chat:OTHER,ids:[777,700],at:'2026-11-01T12:00:00Z'});
  assert.equal((await loadOrderReportLink(60,{pool:h.pool})).audit_id,7,'Equal timestamps use the deterministic newest audit ID');
}));

test('sync rereads order status, card ID and latest report within the shared lock, then edits only markup',pg,()=>fixture(async h=>{
  await h.audit(); const old = await loadOrderReportLink(60,{pool:h.pool}); assert.equal(old.audit_id,1); h.lockReads();
  h.onLock(async()=>{await h.db.query("UPDATE orders SET status='done',telegram_msg_id=500 WHERE id=60");await h.audit({id:2,chat:OTHER,ids:[777],at:'2026-11-05T12:00:00Z'});});
  const result = await h.sync(); assert.equal(result.state,'linked'); assert.equal(result.audit_id,2); assert.equal(result.card_message_id,500);
  assert.deepEqual(h.calls,[ [GROUP,500,undefined,{inline_keyboard:[[{text:'done',callback_data:'status:done:60'}],[{text:'Перейти к отчёту',url:'https://t.me/c/2222222222/777'}]]}] ]);
}));

test('a lost markup ACK retries the latest complete report without sending a replacement card or reverting newer reports',pg,()=>fixture(async h=>{
  await h.audit(); h.lockReads(); let first=true;
  h.onSend(()=>{if(first){first=false;throw new Error('Synthetic lost markup ACK');}});
  await assert.rejects(h.sync(),/lost markup ACK/);
  await h.audit({id:2,chat:OTHER,ids:[222],at:'2026-11-06T12:00:00Z'});
  h.onSend(()=>{throw rejection(400,'Bad Request: message is not modified');});
  const result=await h.sync(); assert.equal(result.state,'linked'); assert.equal(result.audit_id,2); assert.equal(h.calls.length,2);
  assert.equal(h.calls[1][3].inline_keyboard[1][0].url,'https://t.me/c/2222222222/222');
}));

test('only explicit uneditable-card errors are terminal skips; unrelated Telegram failures remain retryable errors',pg,()=>fixture(async h=>{
  await h.audit(); h.lockReads();
  for(const description of ['Bad Request: message to edit not found',"Bad Request: message can't be edited",'Bad Request: message cannot be edited']){
    h.onSend(()=>{throw rejection(400,description);});const result=await h.sync();assert.equal(result.state,'skipped');assert.equal(result.code,'ORDER_CARD_UNAVAILABLE');assert.ok(result.warning);
  }
  for(const failure of [rejection(429,'Too Many Requests'),rejection(403,'Forbidden'),rejection(500,'message is not modified'),new Error('message is not modified')]){
    h.onSend(()=>{throw failure;});await assert.rejects(h.sync(),error=>error===failure);
  }
}));

test('missing order, card, chat and saved report produce explicit visible outcomes without Telegram calls',pg,()=>fixture(async h=>{
  h.lockReads();
  for(const [id,extra,code]of [[99,{},'ORDER_MISSING'],[62,{},'ORDER_CARD_MISSING'],[60,{groupId:''},'WORKING_CHAT_MISSING'],[60,{},'REPORT_LINK_MISSING']]){
    const result=await h.sync(id,extra);assert.equal(result.state,'skipped');assert.equal(result.code,code);assert.ok(result.warning);
  }
  assert.equal(h.calls.length,0);
}));

test('preview is SELECT-only, stable, paginated and bounded, including warnings for absent original card IDs',pg,()=>fixture(async h=>{
  await h.audit();await h.audit({id:2,order:61});await h.audit({id:3,order:62});
  const first=await previewOrderReportLinks({pool:h.pool,groupId:GROUP,limit:2});assert.deepEqual(first.items.map(item=>item.order_id),[60,61]);assert.equal(first.nextAfterId,61);
  const second=await previewOrderReportLinks({pool:h.pool,groupId:GROUP,limit:2,afterId:first.nextAfterId});assert.deepEqual(second.items.map(item=>item.order_id),[62]);assert.equal(second.nextAfterId,null);assert.equal(second.items[0].code,'ORDER_CARD_MISSING');
  assert.equal((await previewOrderReportLinks({pool:h.pool,groupId:'',limit:1})).items[0].code,'WORKING_CHAT_MISSING');
  for(const limit of [0,101,1.5,'2'])await assert.rejects(previewOrderReportLinks({pool:h.pool,limit}),error=>error.code==='INVALID_LIMIT');
  assert.equal(h.calls.length,0);assert.ok(h.reads.every(sql=>/^SELECT\b/.test(sql)));
}));

test('bounded apply deduplicates IDs, remains sequential and stops on the first unknown or throttled edit',pg,()=>fixture(async h=>{
  await h.audit();await h.audit({id:2,order:61});await h.audit({id:3,order:63});h.lockReads();
  h.onSend(args=>{if(args[1]===51)throw rejection(429,'Retry later');});
  const partial=await applyOrderReportLinks([60,60,61,63],h.options);assert.equal(partial.complete,false);assert.equal(partial.failed_order_id,61);assert.deepEqual(partial.results.map(item=>item.order_id),[60]);assert.deepEqual(h.calls.map(args=>args[1]),[50,51]);assert.ok(partial.error.message);
  h.onSend(null);const complete=await applyOrderReportLinks([61,63,63],h.options);assert.equal(complete.complete,true);assert.deepEqual(complete.results.map(item=>item.order_id),[61,63]);
  const count=h.calls.length;for(const ids of [[60,'bad'],Array(101).fill(60),'60'])await assert.rejects(applyOrderReportLinks(ids,h.options),error=>error.status===400);assert.equal(h.calls.length,count);
}));

test('overlapping report syncs finish with the newest persisted report and preserve the existing order-card target',pg,()=>fixture(async h=>{
  await h.audit();h.lockReads();let start,release;const started=new Promise(resolve=>{start=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  h.onSend(async()=>{if(h.calls.length===1){start();await wait;}});
  const first=h.sync();await started;await h.audit({id:2,chat:OTHER,ids:[222],at:'2026-11-06T12:00:00Z'});const second=h.sync();release();
  await Promise.all([first,second]);assert.equal(h.calls.length,2);assert.ok(h.calls.every(args=>args[0]===GROUP&&args[1]===50));assert.equal(h.calls.at(-1)[3].inline_keyboard[1][0].url,'https://t.me/c/2222222222/222');
}));
