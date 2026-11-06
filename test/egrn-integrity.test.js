const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

const CAD = '77:17:0120316:999';
const filename = path.join(__dirname, '../src/bot/egrn.js');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);
const pg = { skip: !process.env.PGLITE_TEST_MODULE, timeout: 15000 };
function gate() {
  let resolve;
  return { promise: new Promise(yes => { resolve = yes; }), open: () => resolve() };
}
async function fixture(options = {}) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite(), calls = { paid: 0, status: [], documents: [], copies: [], messages: [], edits: [] };
  let tail = Promise.resolve(), poll, clockOffset = 0;
  class Clock extends Date { static now() { return Date.now() + clockOffset; } }
  const pool = {
    async connect() {
      const before = tail, next = gate(); tail = next.promise; await before;
      return { async query(sql, params) {
        await options.beforeQuery?.(sql, params);
        if (params) return db.query(sql, params);
        const values = await db.exec(sql); return values.at(-1) || { rows: [] };
      }, release() { next.open(); } };
    },
    async query(sql, params) { const client = await pool.connect(); try { return await client.query(sql, params); } finally { client.release(); } },
  };
  const actions = [], commands = [];
  const sandbox = {
    module: { exports: {} }, Buffer, AbortSignal, URL, Date: Clock,
    process: { env: { EGRN_TOKEN: 'synthetic', EGRN_DECLARANT_ID: '1', EGRN_CHAT_ID: '-100123', ADMIN_TG_IDS: options.adminIDs || '111', ...(options.groupChatId?{GROUP_CHAT_ID:options.groupChatId}:{}) } },
    console: { log() {}, error() {} }, setTimeout(fn) { poll = fn; }, setInterval() {},
    require(name) {
      if (name === '../db/pool') return pool;
      if (name === './order-evidence') return { async registerOriginal() { return {}; }, async registerCached() { return {}; } };
      if (name === './egrn-large-delivery' && options.largeDelivery) return {createLargeDelivery: options.largeDelivery};
      if (name === './egrn-telegram-delivery' && options.beforeDispatch) return {createEgrnTelegramDelivery(config){
        const protocol=localRequire(name).createEgrnTelegramDelivery(config);
        return {...protocol,send(order,operation,run){return protocol.send(order,operation,async(...args)=>{await options.beforeDispatch(operation);return run(...args);});}};
      }};
      return localRequire(name);
    },
    async fetch(url, request = {}) {
      assert.equal(request.method, 'POST'); const attempt = ++calls.paid;
      const response = await options.orderApi?.(attempt); if (response instanceof Response) return response;
      return new Response(JSON.stringify({ id_statement: 9000 + attempt }));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nmodule.exports.qa={ensureTables,reserveOrder,copyFiles,setStatus(fn){apiStatus=fn;},setDownload(fn){download=fn;}};', sandbox, { filename });
  const api = sandbox.module.exports;
  const telegram = {
    async sendMessage(chat, text) { calls.messages.push({ chat, text }); return { message_id: 100 + calls.messages.length }; },
    async editMessageText(chat,id,inline,text) { calls.edits.push({chat,id,text}); },
    async sendDocument(chat, file, extra) { const call={chat,file,extra};calls.documents.push(call);await options.sendDocument?.(extra,call);call.delivered=true;return options.documentReceipt ? options.documentReceipt(call) : { message_id: 200 + calls.documents.length, document: { file_id: 'test-only-original-'+calls.documents.length, mime_type: 'application/pdf' } }; },
    async callApi(method, value) { calls.copies.push(value); await options.copy?.(value); return options.copyReceipt ? options.copyReceipt(value) : { message_id: 300 + calls.copies.length }; },
  };
  const bot = { on() {}, hears() {}, action(pattern, handler) { actions.push({ pattern, handler }); }, command(name, handler) { commands.push({ name, handler }); }, telegram };
  api.setupEgrn(bot);
  await api.qa.ensureTables();
  await pool.query('CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,approved BOOLEAN,role TEXT)');
  await pool.query("INSERT INTO staff(tg_id,approved,role) VALUES(111,true,'manager'),(222,true,'lawyer'),(333,true,'lawyer')");
  api.qa.setStatus(async id => {
    calls.status.push(Number(id));
    const done = options.ready ? options.ready(Number(id)) : true;
    return { id_req: id, status: [{ type: done ? 'processed' : 'waiting', statusDescription: done ? 'Выполнено' : 'В работе', ...(done ? { file: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(300, 32), Buffer.from('\n%%EOF')]).toString('base64') } : {}) }] };
  });
  const add = async ({ id = 7001, cad = CAD, status = 'ordered', filesSent = 0, files = [], targets = [], card = null } = {}) => (await pool.query(
    'INSERT INTO egrn_orders(cad_num,type_doc,id_statement,status,status_text,chat_id,ordered_by,status_msg_id,deliver,file_msgs,files_sent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [cad, 'kvarmrusxmlpdf', id, status, 'В работе', -100123, 111, card, JSON.stringify(targets), JSON.stringify(files), filesSent])).rows[0];
  return { db, pool, calls, api, actions, commands, telegram, add, budget: require('../src/bot/egrn-budget').createEgrnBudget({pool}), poll: () => poll(), anotherPoller() { api.setupEgrn(bot); const run = poll; return run; },
    advanceClock(ms) { clockOffset += ms; },
    restartCommands() { const start = commands.length; api.setupEgrn(bot); return commands.slice(start); },
    row: async id => (await pool.query('SELECT * FROM egrn_orders WHERE id=$1', [id])).rows[0],
    attach: (chat = 111, extra = {}) => api.attachOrOrder({ cad: CAD, order: true, orderedBy: chat, targets: [{ chat }], ...extra }),
    close: () => db.close() };
}

function retryContext(id, message_id, replies=[],actor=111) { return {from:{id:actor},chat:{type:'private',id:actor},message:{text:'/egrn_retry '+id,message_id},async reply(text){replies.push(text);}}; }

const measurementsChat='-100456';
const accountingPattern=/Заказано выписок|Расчётно осталось|По учтённым пополнениям|Учёт на момент|Остаток не сверён/i;
test('new EGRN delivery retains accounting in the EGRN chat and private receipts but strips it from the measurements destination',pg,async()=>{
  const h=await fixture({groupChatId:measurementsChat});try{
    await h.budget.syncBalance('1000',{sourceKey:'synthetic-opening'});await h.attach(111,{targets:[{chat:Number(measurementsChat),reply:88}]});await h.poll();
    assert.match(h.calls.messages.find(value=>String(value.chat)==='-100123').text,accountingPattern);
    assert.match(h.calls.documents.find(value=>String(value.chat)==='-100123').extra.caption,accountingPattern);
    assert.match(h.calls.copies.find(value=>String(value.chat_id)==='111').caption,accountingPattern);
    const working=h.calls.copies.find(value=>String(value.chat_id)===measurementsChat);assert.ok(working);assert.equal(Object.hasOwn(working,'caption'),true);assert.doesNotMatch(working.caption,accountingPattern);
    assert.match(h.calls.edits.find(value=>String(value.chat)==='-100123').text,accountingPattern);
    const budget=await h.budget.snapshot();assert.equal(budget.confirmedOrders,1);assert.equal(budget.balanceKopecks,87100);assert.equal(h.calls.paid,1);
  }finally{await h.close();}
});

test('cached copies into the measurements chat explicitly replace inherited source captions even without requested accounting',pg,async()=>{
  const h=await fixture({groupChatId:measurementsChat});try{
    await h.budget.syncBalance('1000',{sourceKey:'synthetic-opening'});await h.attach();await h.poll();
    const result=await h.attach(111,{targets:[{chat:measurementsChat,reply:88}]});assert.equal(result.result,'attached');
    const first=h.calls.copies.at(-1);assert.equal(String(first.chat_id),measurementsChat);assert.equal(Object.hasOwn(first,'caption'),true);assert.doesNotMatch(first.caption,accountingPattern);
    const order=(await h.pool.query('SELECT * FROM egrn_orders ORDER BY id LIMIT 1')).rows[0];
    await h.api.qa.copyFiles(order.file_msgs,[{chat:measurementsChat,reply:99}],{strict:true});
    const plain=h.calls.copies.at(-1);assert.equal(Object.hasOwn(plain,'caption'),true,'Omitting caption would inherit the EGRN source counter in Telegram');assert.doesNotMatch(plain.caption,accountingPattern);
    assert.equal(h.calls.paid,1);assert.equal((await h.budget.snapshot()).balanceKopecks,87100);
  }finally{await h.close();}
});

test('deleted-source repair into the measurements chat uses the retained original without inheriting accounting or making another paid request',pg,async()=>{
  let missing=true;const h=await fixture({groupChatId:measurementsChat,copy(value){if(missing&&String(value.chat_id)===measurementsChat){missing=false;throw{response:{error_code:400,description:'Bad Request: message to copy not found'}};}}});try{
    await h.budget.syncBalance('1000',{sourceKey:'synthetic-opening'});await h.attach();await h.poll();
    assert.equal((await h.attach(111,{targets:[{chat:measurementsChat}]})).result,'attached');
    const repaired=h.calls.documents.at(-1);assert.equal(String(repaired.chat),measurementsChat);assert.equal(typeof repaired.file,'string');assert.doesNotMatch(repaired.extra.caption,accountingPattern);
    assert.doesNotMatch(h.calls.copies.at(-1).caption,accountingPattern);assert.equal(h.calls.paid,1);assert.equal((await h.budget.snapshot()).confirmedOrders,1);assert.equal((await h.budget.snapshot()).balanceKopecks,87100);
  }finally{await h.close();}
});

test('an older order whose primary card and original target are the measurements chat omits accounting on its refreshed card and original',pg,async()=>{
  const h=await fixture({groupChatId:measurementsChat});try{
    await h.budget.syncBalance('1000',{sourceKey:'synthetic-opening'});await h.attach();
    await h.pool.query('UPDATE egrn_orders SET chat_id=$1',[measurementsChat]);await h.poll();
    const refreshed=h.calls.edits.find(value=>String(value.chat)===measurementsChat);assert.ok(refreshed);assert.doesNotMatch(refreshed.text,accountingPattern);
    const original=h.calls.documents.find(value=>String(value.chat)===measurementsChat);assert.ok(original);assert.doesNotMatch(original.extra.caption,accountingPattern);
    assert.match(h.calls.copies.find(value=>String(value.chat_id)==='111').caption,accountingPattern);assert.equal(h.calls.paid,1);assert.equal((await h.budget.snapshot()).balanceKopecks,87100);
  }finally{await h.close();}
});

test('uncertain Telegram order replies filter the counter by destination without hiding the provider warning or changing the reserved charge',pg,async()=>{
  const h=await fixture({groupChatId:measurementsChat,orderApi(){throw new Error('Synthetic provider ACK lost');}});try{
    await h.budget.syncBalance('1000',{sourceKey:'synthetic-opening'});await assert.rejects(h.attach());
    const pending=(await h.pool.query('INSERT INTO egrn_pending(cad_num,label) VALUES($1,$2) RETURNING id',[CAD,'Synthetic order'])).rows[0];
    const action=h.actions.find(value=>String(value.pattern).includes('eg:')).handler;
    for(const chat of [Number(measurementsChat),'-100123',111]){
      const replies=[];await action({from:{id:111,first_name:'Synthetic manager'},chat:{id:chat},callbackQuery:{message:{chat:{id:chat}}},match:['eg:'+pending.id+':kv',String(pending.id),'kv'],answerCbQuery:async()=>{},reply:async text=>replies.push(text)});
      assert.equal(replies.length,1);assert.match(replies[0],/требует проверки у поставщика/);if(String(chat)===measurementsChat)assert.doesNotMatch(replies[0],accountingPattern);else assert.match(replies[0],accountingPattern);
    }
    const budget=await h.budget.snapshot();assert.equal(h.calls.paid,1);assert.equal(budget.confirmedOrders,0);assert.equal(budget.pendingOrders,1);assert.equal(budget.balanceKopecks,100000);assert.equal(budget.reservedKopecks,12900);
  }finally{await h.close();}
});

for(const busyStage of ['native-send','provider-status'])test('runtime busy retry consumes its actor cursor during '+busyStage+' and cannot reopen a later unknown attempt',pg,async()=>{
  const entered=gate(),release=gate();let first=true;
  const h=await fixture({adminIDs:'111,222',async sendDocument(){if(first&&busyStage==='native-send'){first=false;entered.open();await release.promise;}throw new Error('Synthetic accepted original ACK lost');}});try{
    const order=await h.add();
    if(busyStage==='provider-status')h.api.qa.setStatus(async()=>{if(first){first=false;entered.open();await release.promise;}return{id_req:7001,status:[{type:'processed',file:Buffer.from('%PDF-1.7\n'+'A'.repeat(300)+'\n%%EOF').toString('base64')}]};});
    const command=h.commands.find(c=>c.name==='egrn_retry').handler,running=h.poll();await entered.promise;await command(retryContext(7001,101));release.open();await running;
    assert.equal(h.calls.documents.length,1);assert.equal((await h.row(order.id)).delivery_state.retry_cursors?.['111'],101);
    await command(retryContext(7001,201,[],222));assert.equal(h.calls.documents.length,2);const current=await h.row(order.id),attempt=current.delivery_state.inflight.attempt;
    await command(retryContext(7001,101));assert.equal(h.calls.documents.length,2);assert.equal((await h.row(order.id)).delivery_state.inflight.attempt,attempt);assert.equal(h.calls.paid,0);
  }finally{release.open();await h.close();}
});

test('cached large-link copy into a case thread checkpoints its exact reply target without an unknown state',pg,async()=>{
  const id='11111111-1111-4111-8111-111111111111',meta={id,name:'full.pdf',mime:'application/pdf',bytes:100*1024*1024},h=await fixture({largeDelivery:options=>require('../src/bot/egrn-large-delivery').createLargeDelivery({...options,store:{get:async()=>meta},makeUrl:()=> 'https://fixture.invalid/full.pdf'})});try{
    const order=await h.add({status:'done',filesSent:1,files:[{key:'exact-large',kind:'link',original_id:id,name:meta.name,mime:meta.mime,bytes:meta.bytes,chat:-100123,deliveries:[{chat:-100123,id:99}]}]});
    assert.equal((await h.attach(222,{targets:[{chat:222,reply:91}]})).result,'attached');const saved=await h.row(order.id);assert.equal(saved.delivery_state.inflight,undefined);assert.ok(saved.file_msgs[0].deliveries.some(r=>Number(r.chat)===222&&r.reply===91));assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('lost native primary ACK stops automatic restart delivery until a new explicit admin event, without another paid POST',pg,async()=>{
  let lose=true;const h=await fixture({sendDocument(){if(lose)throw new Error('Network ACK lost after physical acceptance');}});try{
    const order=await h.add();await h.poll();let saved=await h.row(order.id);assert.equal(saved.files_sent,-1);assert.ok(saved.delivery_state.inflight);assert.equal(h.calls.documents.length,1);assert.equal(saved.file_msgs.length,0);
    await h.anotherPoller()();await assert.rejects(h.attach(222),e=>e.code==='EGRN_DELIVERY_UNCONFIRMED');assert.equal(h.calls.documents.length,1);assert.equal(h.calls.paid,0);
    let command=h.restartCommands().find(c=>c.name==='egrn_retry').handler;await command(retryContext(7001,101));assert.equal(h.calls.documents.length,2);saved=await h.row(order.id);assert.equal(saved.files_sent,-1);const attempt=saved.delivery_state.inflight.attempt;
    command=h.restartCommands().find(c=>c.name==='egrn_retry').handler;await command(retryContext(7001,101));assert.equal(h.calls.documents.length,2);assert.equal((await h.row(order.id)).delivery_state.inflight.attempt,attempt);
    lose=false;await command(retryContext(7001,102));saved=await h.row(order.id);assert.equal(saved.files_sent,1);assert.equal(saved.delivery_state.inflight,undefined);assert.equal(h.calls.documents.length,3);assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('a lost extra-recipient copy ACK keeps original receipts and does not copy again automatically after restart',pg,async()=>{
  let lose=true;const h=await fixture({copy(value){if(lose&&Number(value.chat_id)===222)throw new Error('Lost copy ACK');}});try{
    const order=await h.add({targets:[{chat:222}]});await h.poll();let saved=await h.row(order.id);assert.equal(saved.files_sent,-1);assert.equal(saved.file_msgs.length,1);assert.ok(saved.delivery_state.inflight);assert.equal(saved.file_msgs[0].deliveries?.some(r=>Number(r.chat)===222)||false,false);
    await h.anotherPoller()();assert.equal(h.calls.copies.filter(v=>Number(v.chat_id)===222).length,1);assert.equal(h.calls.documents.length,1);
    lose=false;await h.commands.find(c=>c.name==='egrn_retry').handler(retryContext(7001,201));saved=await h.row(order.id);assert.equal(saved.files_sent,1);assert.equal(h.calls.documents.length,1);assert.equal(h.calls.copies.filter(v=>Number(v.chat_id)===222).length,2);assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('deleted-source repair ACK loss persists its own unknown intent and cannot silently resend the retained file_id',pg,async()=>{
  let lose=true;const h=await fixture({copy(value){if(Number(value.message_id)===501)throw {response:{error_code:400,description:'Bad Request: message to copy not found'}};},sendDocument(){if(lose)throw new Error('Lost retained-file send ACK');}});try{
    const order=await h.add({status:'done',filesSent:1,files:[{key:'exact-original',chat:-100123,id:501,file_id:'retained-id',name:'full.pdf',bytes:35*1024*1024,mime:'application/pdf'}]});
    await assert.rejects(h.attach(222),e=>e.uncertain===true);let saved=await h.row(order.id);assert.equal(saved.delivery_state.inflight.kind,'native-repair');assert.equal(h.calls.documents.length,1);
    await h.anotherPoller()();await assert.rejects(h.attach(222),e=>e.code==='EGRN_DELIVERY_UNCONFIRMED');assert.equal(h.calls.documents.length,1);assert.equal(h.calls.paid,0);
    lose=false;await h.commands.find(c=>c.name==='egrn_retry').handler(retryContext(7001,250));saved=await h.row(order.id);assert.equal(saved.files_sent,1);assert.equal(saved.delivery_state.inflight,undefined);assert.equal(h.calls.documents.length,2,'only the newly authorized source repair is needed');assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('postACK native checkpoint failure leaves an unknown marker and a salvaged receipt, so explicit retry does not resend the original',pg,async()=>{
  let fail=true;const h=await fixture({beforeQuery(sql){if(fail&&sql.startsWith('UPDATE egrn_orders SET file_msgs=')){fail=false;throw new Error('Lost checkpoint before write');}}});try{
    const order=await h.add();await h.poll();let saved=await h.row(order.id);assert.equal(saved.files_sent,-1);assert.ok(saved.delivery_state.inflight);assert.equal(saved.file_msgs.length,1);assert.equal(h.calls.documents.length,1);
    await h.anotherPoller()();assert.equal(h.calls.documents.length,1);await h.commands.find(c=>c.name==='egrn_retry').handler(retryContext(7001,301));saved=await h.row(order.id);assert.equal(saved.files_sent,1);assert.equal(saved.delivery_state.inflight,undefined);assert.equal(h.calls.documents.length,1);assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('a durable intent SQL failure prevents Telegram send, and a later safe retry delivers only once',pg,async()=>{
  let fail=true;const h=await fixture({beforeQuery(sql){if(fail&&sql.includes('jsonb_set(COALESCE(delivery_state')){fail=false;throw new Error('Intent storage unavailable');}}});try{
    const order=await h.add();await h.poll();let saved=await h.row(order.id);assert.equal(saved.files_sent,0);assert.equal(saved.delivery_state.inflight,undefined);assert.equal(h.calls.documents.length,0);
    await h.pool.query('UPDATE egrn_orders SET retry_at=NULL WHERE id=$1',[order.id]);await h.poll();saved=await h.row(order.id);assert.equal(saved.files_sent,1);assert.equal(h.calls.documents.length,1);assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('revoked or reassigned private recipients stay pending without physical copies, while approved recipients retain their receipts',pg,async()=>{
  const h=await fixture();try{
    await h.pool.query('CREATE TABLE cases(id INT PRIMARY KEY,lawyer_tg_id BIGINT)');await h.pool.query('INSERT INTO cases VALUES(9,333)');await h.pool.query('UPDATE staff SET approved=false WHERE tg_id=333');
    const order=await h.add({targets:[{chat:222,case_id:9},{chat:333}]});await h.poll();let saved=await h.row(order.id);assert.equal(saved.files_sent,0);assert.equal(h.calls.documents.length,1);assert.equal(h.calls.copies.some(v=>[222,333].includes(Number(v.chat_id))),false);assert.ok(saved.file_msgs[0].deliveries.some(r=>Number(r.chat)===111));assert.equal(saved.delivery_state.inflight,undefined);
    await h.pool.query('UPDATE cases SET lawyer_tg_id=222 WHERE id=9');await h.pool.query('UPDATE staff SET approved=true WHERE tg_id=333');await h.pool.query('UPDATE egrn_orders SET retry_at=NULL WHERE id=$1',[order.id]);await h.poll();saved=await h.row(order.id);assert.equal(saved.files_sent,1);assert.equal(h.calls.documents.length,1);assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('revoked private primary is never sent a document or stopped notification; the configured group retains a safe original source',pg,async()=>{
  const h=await fixture({adminIDs:'111'});try{
    await h.pool.query('UPDATE staff SET approved=false WHERE tg_id=222');const order=await h.add({targets:[{chat:-100123}]});await h.pool.query('UPDATE egrn_orders SET chat_id=222,ordered_by=222 WHERE id=$1',[order.id]);await h.poll();
    const saved=await h.row(order.id);assert.equal(saved.files_sent,0);assert.equal(h.calls.documents.length,1);assert.equal(h.calls.documents[0].chat,-100123);assert.equal(h.calls.copies.some(v=>Number(v.chat_id)===222),false);assert.equal(h.calls.messages.some(v=>Number(v.chat)===222),false);assert.ok(h.calls.messages.some(v=>Number(v.chat)===111&&/доступа получателя/.test(v.text)));assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('concurrent requests reserve one paid order and keep both recipients', pg, async () => {
  const started = gate(), release = gate();
  const h = await fixture({ orderApi: async () => { started.open(); await release.promise; } });
  try {
    const first = h.attach(111); await started.promise;
    const second = await h.attach(222); assert.equal(second.result, 'waiting');
    release.open(); assert.equal((await first).result, 'ordered');
    assert.equal(h.calls.paid, 1);
    const rows = (await h.pool.query('SELECT * FROM egrn_orders')).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'ordered');
    assert.deepEqual(rows[0].deliver.map(t => Number(t.chat)).sort(), [111, 222]);
  } finally { release.open(); await h.close(); }
});

test('atomic recipient registration does not lose a concurrent requester', pg, async () => {
  const h = await fixture();
  try {
    const original = await h.add(); await Promise.all([h.attach(222), h.attach(333)]);
    assert.deepEqual((await h.row(original.id)).deliver.map(t => Number(t.chat)).sort(), [222, 333]);
    assert.equal(h.calls.paid, 0);
  } finally { await h.close(); }
});

test('unconfirmed provider result remains a durable reservation and never silently orders again', pg, async () => {
  const h = await fixture({ orderApi() { throw new Error('Synthetic response lost after sending'); } });
  try {
    await assert.rejects(h.attach(), error => error.code === 'EGRN_ORDER_UNCONFIRMED');
    assert.equal((await h.pool.query('SELECT status FROM egrn_orders')).rows[0].status, 'order_unknown');
    const retry = await h.attach(); assert.equal(retry.result, 'uncertain');
    assert.match(retry.packet_warning, /личный кабинет/);
    const forced = await h.attach(111, { force: true, requestKey: 'telegram:1' });
    assert.equal(forced.result, 'uncertain'); assert.equal(h.calls.paid, 1);
  } finally { await h.close(); }
});

test('a reservation surviving process death before the POST is not converted into another paid request', pg, async () => {
  const h = await fixture();
  try {
    const reserved = await h.api.qa.reserveOrder(CAD, { orderedBy: 111, targets: [{ chat: 111 }] });
    assert.equal(reserved.created, true); assert.equal(h.calls.paid, 0);
    await h.pool.query("UPDATE egrn_orders SET created_at=NOW()-INTERVAL '3 minutes' WHERE id=$1", [reserved.order.id]);
    const retry = await h.attach(222);
    assert.equal(retry.result, 'uncertain'); assert.equal(h.calls.paid, 0);
  } finally { await h.close(); }
});

test('successful provider order followed by a failed checkpoint keeps its known statement number for reconciliation', pg, async () => {
  let failed = false;
  const h = await fixture({ beforeQuery(sql) { if (!failed && sql.startsWith('UPDATE egrn_orders SET id_statement=')) { failed = true; throw new Error('Synthetic database acknowledgement lost'); } } });
  try {
    await assert.rejects(h.attach(), error => error.code === 'EGRN_ORDER_CHECKPOINT');
    const order = (await h.pool.query('SELECT * FROM egrn_orders')).rows[0];
    assert.equal(order.status, 'order_unknown'); assert.equal(Number(order.id_statement), 9001);
    assert.equal((await h.attach()).result, 'uncertain'); assert.equal(h.calls.paid, 1);
    const accounting=await h.budget.snapshot();assert.equal(accounting.confirmedOrders,1);assert.equal(accounting.pendingOrders,0);assert.equal(accounting.trackedNetKopecks,-12900);
  } finally { await h.close(); }
});

test('a failed atomic accounting reservation rolls back the local order before any paid POST', pg, async () => {
  let fail=true;const h=await fixture({beforeQuery(sql){if(fail&&sql.startsWith('INSERT INTO egrn_budget_orders'))throw new Error('Synthetic reservation checkpoint failure');}});
  try {
    await assert.rejects(h.attach(),/reservation checkpoint/);assert.equal(h.calls.paid,0);assert.equal((await h.pool.query('SELECT * FROM egrn_orders')).rows.length,0);
    assert.equal((await h.budget.snapshot()).pendingOrders,0);fail=false;await h.attach();assert.equal(h.calls.paid,1);assert.equal((await h.budget.snapshot()).confirmedOrders,1);
  }finally{await h.close();}
});

test('parallel distinct cadastral orders preserve shared topups and one charge per accepted provider statement', pg, async () => {
  const h=await fixture();try{
    await h.budget.topup('1000',{sourceKey:'new-topup',actorId:111});await Promise.all([h.attach(),h.attach(222,{cad:'77:17:0120316:998'})]);
    const state=await h.budget.snapshot();assert.equal(h.calls.paid,2);assert.equal(state.confirmedOrders,2);assert.equal(state.pendingOrders,0);assert.equal(state.trackedNetKopecks,74200);assert.equal(state.trackedRemainingOrders,5);assert.equal(state.balanceKnown,false);
  }finally{await h.close();}
});

test('an unconfirmed paid POST reserves money until reconciliation and cannot debit or POST twice', pg, async () => {
  const h=await fixture({orderApi(){throw new Error('Synthetic provider ACK loss');}});try{
    await h.budget.topup('500',{sourceKey:'new-topup',actorId:111});await assert.rejects(h.attach());let state=await h.budget.snapshot();assert.equal(state.confirmedOrders,0);assert.equal(state.pendingOrders,1);assert.equal(state.trackedAvailableKopecks,37100);
    await h.attach();assert.equal(h.calls.paid,1);const row=(await h.pool.query('SELECT * FROM egrn_orders')).rows[0];
    const handler=h.commands.find(c=>c.name==='egrn_reconcile').handler;await handler({chat:{type:'private'},from:{id:111},message:{text:'/egrn_reconcile '+row.id+' 9001'},reply:async()=>{}});
    state=await h.budget.snapshot();assert.equal(state.confirmedOrders,1);assert.equal(state.pendingOrders,0);assert.equal(state.trackedNetKopecks,37100);await h.attach();assert.equal(h.calls.paid,1);assert.equal((await h.budget.snapshot()).confirmedOrders,1);
  }finally{await h.close();}
});

test('a definite provider rejection releases the reservation without creating an unknown or a charge', pg, async () => {
  const h=await fixture({orderApi(){return new Response('{}',{status:422});}});try{
    await assert.rejects(h.attach(),error=>error.code==='EGRN_ORDER_REJECTED');assert.equal(h.calls.paid,1);const state=await h.budget.snapshot();assert.equal(state.confirmedOrders,0);assert.equal(state.pendingOrders,0);assert.equal((await h.pool.query('SELECT * FROM egrn_orders')).rows[0].status,'failed');
  }finally{await h.close();}
});

for(const failedWrite of ['order','budget'])test('a rejected provider request with a lost '+failedWrite+' checkpoint remains atomically reserved and explicitly reconcilable', pg, async()=>{
  let fail=true;const h=await fixture({orderApi(){return new Response('{}',{status:400});},beforeQuery(sql,params){
    const target=failedWrite==='budget'?sql.startsWith("UPDATE egrn_budget_orders SET state='rejected'"):sql.startsWith('UPDATE egrn_orders SET status=$1')&&params?.[0]==='failed';
    if(fail&&target){fail=false;throw new Error('Synthetic lost rejection checkpoint');}
  }});
  try{
    await h.budget.topup('500',{sourceKey:'before-rejected-order',actorId:111});
    await assert.rejects(h.attach(),error=>error.code==='EGRN_ORDER_REJECTION_CHECKPOINT');
    const row=(await h.pool.query('SELECT * FROM egrn_orders')).rows[0],pending=await h.budget.snapshot();assert.equal(row.status,'order_unknown');assert.equal(pending.pendingOrders,1);assert.equal(pending.confirmedOrders,0);assert.equal(pending.trackedAvailableKopecks,37100);
    assert.equal((await h.attach()).result,'uncertain');assert.equal(h.calls.paid,1);
    const replies=[],handler=h.commands.find(command=>command.name==='egrn_reconcile').handler;
    await handler({chat:{type:'private'},from:{id:111},message:{text:'/egrn_reconcile '+row.id+' no_order'},reply:async text=>replies.push(text)});
    assert.match(replies.at(-1),/Отсутствие заказа зафиксировано/);const resolved=await h.budget.snapshot();assert.equal(resolved.pendingOrders,0);assert.equal(resolved.confirmedOrders,0);assert.equal(resolved.trackedAvailableKopecks,50000);assert.equal(h.calls.paid,1);
    assert.equal((await h.budget.syncBalance('500',{sourceKey:'after-reconciliation',actorId:111})).balanceKnown,true);
  }finally{await h.close();}
});

test('private admin topups accept arbitrary amounts and repeat Telegram update IDs do not double the recorded credit', pg, async () => {
  const h=await fixture();try{
    const handler=h.commands.find(c=>c.name==='egrn_topup').handler,replies=[];
    const ctx={chat:{id:111,type:'private'},from:{id:111},message:{message_id:51,text:'/egrn_topup 2500,50'},reply:async text=>replies.push(text)};
    await handler({...ctx,from:{id:222}});await handler({...ctx,chat:{id:-100123,type:'supergroup'}});assert.equal((await h.budget.snapshot()).recordedTopupsKopecks,0);
    await handler(ctx);await handler(ctx);assert.equal((await h.budget.snapshot()).recordedTopupsKopecks,250050);assert.ok(replies.every(text=>/По учтённым пополнениям/.test(text)));assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('balance commands require a recent private per-admin review and reject an intervening accepted order or credit', pg, async()=>{
  const h=await fixture({adminIDs:'111,222'});try{
    const command=name=>h.commands.find(c=>c.name===name).handler,replies=[];
    const ctx=(text,id,uid=111)=>({chat:{id:uid,type:'private'},from:{id:uid},message:{message_id:id,text},reply:async message=>replies.push(message)});
    await command('egrn_balance')(ctx('/egrn_balance 4711',50));assert.match(replies.at(-1),/Сначала.*\/egrn_budget/);assert.equal((await h.budget.snapshot()).balanceKnown,false);
    await command('egrn_budget')(ctx('/egrn_budget',51));await command('egrn_balance')(ctx('/egrn_balance 4711',51,222));assert.match(replies.at(-1),/Сначала.*\/egrn_budget/);await h.attach();await command('egrn_balance')(ctx('/egrn_balance 4711',52));assert.match(replies.at(-1),/Учёт изменился/);assert.equal((await h.budget.snapshot()).balanceKnown,false);
    await command('egrn_budget')(ctx('/egrn_budget',53));await h.budget.topup('1000',{sourceKey:'intervening-credit',actorId:111});await command('egrn_balance')(ctx('/egrn_balance 4711',54));assert.match(replies.at(-1),/Учёт изменился/);assert.equal((await h.budget.snapshot()).balanceKnown,false);
    await command('egrn_budget')(ctx('/egrn_budget',55));h.advanceClock(5*60*1000);await command('egrn_balance')(ctx('/egrn_balance 4711',56));assert.match(replies.at(-1),/Сначала.*\/egrn_budget/);assert.equal((await h.budget.snapshot()).balanceKnown,false);assert.equal(h.calls.paid,1);
  }finally{await h.close();}
});

test('a guarded balance records once, exact Telegram replay survives a changed snapshot and restart requires a new review for new messages', pg, async()=>{
  const h=await fixture();try{
    const command=name=>h.commands.find(c=>c.name===name).handler,replies=[];
    const ctx=(text,id)=>({chat:{id:111,type:'private'},from:{id:111},message:{message_id:id,text},reply:async message=>replies.push(message)});
    await command('egrn_budget')(ctx('/egrn_budget',61));const accepted=ctx('/egrn_balance 4711',62);await command('egrn_balance')(accepted);assert.match(replies.at(-1),/Сверка остатка записана/);assert.equal((await h.budget.snapshot()).balanceKopecks,471100);
    await h.budget.topup('1000',{sourceKey:'later-credit',actorId:111});await h.attach();await command('egrn_balance')(accepted);assert.equal((await h.budget.snapshot()).balanceKopecks,558200);
    const restarted=h.restartCommands(),balance=restarted.find(c=>c.name==='egrn_balance').handler;await balance(ctx('/egrn_balance 4711',63));assert.match(replies.at(-1),/Сначала.*\/egrn_budget/);assert.equal((await h.budget.snapshot()).balanceKopecks,558200);
    await balance(accepted);assert.match(replies.at(-1),/Сверка остатка записана/);assert.equal((await h.budget.snapshot()).balanceKopecks,558200);assert.equal(h.calls.paid,1);
  }finally{await h.close();}
});

test('order confirmations, ready native captions and free cache reuse expose the same current accounting without another charge', pg, async () => {
  const h=await fixture();try{
    await h.budget.topup('500',{sourceKey:'new-topup',actorId:111});const ordered=await h.attach();assert.match(ordered.budget_text,/осталось 2/);assert.ok(h.calls.messages.some(m=>/Заказано выписок: 1/.test(m.text)));
    await h.poll();assert.ok(h.calls.documents.some(d=>/Заказано выписок: 1/.test(d.extra.caption)&&/осталось 2/.test(d.extra.caption)));
    const cached=await h.attach(222);assert.equal(cached.result,'attached');assert.match(cached.budget_text,/осталось 2/);assert.equal(h.calls.paid,1);assert.equal((await h.budget.snapshot()).confirmedOrders,1);
  }finally{await h.close();}
});

for(const waitingFor of ['provider-status','original-download'])test('native ready delivery reads the current counter after a slow '+waitingFor+' while another order is accepted',pg,async()=>{
  const entered=gate(),release=gate(),h=await fixture();try{
    await h.budget.syncBalance('1000',{sourceKey:'synthetic-opening'});await h.attach();
    const original=Buffer.from('%PDF-1.7\n'+'A'.repeat(300)+'\n%%EOF');
    h.api.qa.setStatus(async id=>{
      if(waitingFor==='provider-status'){entered.open();await release.promise;}
      return{id_req:id,status:[{type:'processed',statusDescription:'Выполнено',...(waitingFor==='provider-status'?{file:original.toString('base64')}:{download_url:'https://synthetic.invalid/original.pdf'})}]};
    });
    h.api.qa.setDownload(async()=>{entered.open();await release.promise;return{buf:original,name:'full-original.pdf',kind:'pdf'};});
    const running=h.poll();await entered.promise;await h.attach(222,{cad:'77:17:0120316:998'});release.open();await running;
    const snapshot=await h.budget.snapshot();assert.equal(snapshot.confirmedOrders,2);assert.equal(snapshot.balanceKopecks,74200);assert.equal(h.calls.paid,2);
    assert.ok(h.calls.documents.length);for(const sent of h.calls.documents){assert.match(sent.extra.caption,/Учёт на момент сообщения: Заказано выписок: 2/);assert.match(sent.extra.caption,/осталось: 5/);}
    if(waitingFor==='provider-status'){assert.ok(h.calls.edits.length);assert.match(h.calls.edits[0].text,/Заказано выписок: 2/);assert.match(h.calls.edits[0].text,/осталось: 5/);}
    for(const copy of h.calls.copies){assert.match(copy.caption,/Заказано выписок: 2/);assert.match(copy.caption,/осталось: 5/);}
  }finally{release.open();await h.close();}
});

for(const repair of [false,true])test('cached native '+(repair?'missing-source fallback':'copy')+' refreshes its counter after preflight waiting without a duplicate charge',pg,async()=>{
  const entered=gate(),release=gate();let rejectMissing=false;
  const h=await fixture({async copy(){if(rejectMissing){rejectMissing=false;entered.open();await release.promise;throw{response:{error_code:400,description:'Bad Request: message to copy not found'}};}}});try{
    await h.budget.syncBalance('1000',{sourceKey:'synthetic-opening'});await h.attach();await h.poll();
    rejectMissing=repair;
    const running=h.attach(222,{copyOptions:repair?{}:{async beforeSend(){entered.open();await release.promise;}}});await entered.promise;
    await h.attach(333,{cad:'77:17:0120316:998'});release.open();const result=await running;
    assert.equal(result.result,'attached');assert.match(result.budget_text,/Заказано выписок: 2/);assert.match(result.budget_text,/осталось: 5/);
    const copied=h.calls.copies.at(-1);assert.equal(Number(copied.chat_id),222);assert.match(copied.caption,/Заказано выписок: 2/);assert.match(copied.caption,/осталось: 5/);
    if(repair){assert.equal(typeof h.calls.documents.at(-1).file,'string');assert.match(h.calls.documents.at(-1).extra.caption,/Заказано выписок: 2/);assert.match(h.calls.documents.at(-1).extra.caption,/осталось: 5/);}
    assert.equal(h.calls.paid,2);const snapshot=await h.budget.snapshot();assert.equal(snapshot.confirmedOrders,2);assert.equal(snapshot.balanceKopecks,74200);assert.equal(snapshot.pendingOrders,0);
  }finally{release.open();await h.close();}
});

test('an unavailable readonly counter cannot stop a confirmed original delivery or change its charge',pg,async()=>{
  let failSnapshot=false;const h=await fixture({beforeQuery(sql){if(failSnapshot&&sql.startsWith('SELECT a.balance_kopecks'))throw new Error('Synthetic counter read failure');}});try{
    await h.attach();h.api.qa.setStatus(async id=>{failSnapshot=true;return{id_req:id,status:[{type:'processed',file:Buffer.from('%PDF-1.7\n'+'A'.repeat(300)+'\n%%EOF').toString('base64')}]};});
    await h.poll();assert.equal(h.calls.documents.length,1);assert.match(h.calls.documents[0].extra.caption,/Учёт заказов временно недоступен/);
    assert.equal(Number((await h.pool.query('SELECT files_sent FROM egrn_orders')).rows[0].files_sent),1);failSnapshot=false;
    assert.equal((await h.budget.snapshot()).confirmedOrders,1);assert.equal(h.calls.paid,1);
  }finally{await h.close();}
});

for(const kind of ['native-primary','native-copy','native-repair'])test(kind+' reads its counter after a delayed delivery protocol preflight',pg,async()=>{
  const entered=gate(),release=gate();let hold=false,missing=false;
  const h=await fixture({async beforeDispatch(operation){if(hold&&operation.kind===kind){hold=false;entered.open();await release.promise;}},copy(){if(missing){missing=false;throw{response:{error_code:400,description:'Bad Request: message to copy not found'}};}}});try{
    await h.budget.syncBalance('1000',{sourceKey:'synthetic-opening'});await h.attach();
    if(kind!=='native-primary')await h.poll();
    hold=true;missing=kind==='native-repair';const running=kind==='native-primary'?h.poll():h.attach(222);await entered.promise;
    await h.attach(333,{cad:'77:17:0120316:998'});release.open();await running;
    const caption=kind==='native-copy'?h.calls.copies.at(-1).caption:h.calls.documents.at(-1).extra.caption;
    assert.match(caption,/Заказано выписок: 2/);assert.match(caption,/осталось: 5/);assert.equal(h.calls.paid,2);assert.equal((await h.budget.snapshot()).balanceKopecks,74200);
  }finally{release.open();await h.close();}
});

test('source repair repeats the destination guard after accounting even when its safe upload target is the working group',pg,async()=>{
  const entered=gate(),release=gate();let missing=true;
  const h=await fixture({copy(value){if(missing&&Number(value.chat_id)===222){missing=false;throw{response:{error_code:400,description:'Bad Request: message to copy not found'}};}}});try{
    await h.attach();await h.poll();const row=(await h.pool.query('SELECT * FROM egrn_orders ORDER BY id LIMIT 1')).rows[0];
    await h.pool.query('CREATE TABLE cases(id INT PRIMARY KEY,lawyer_tg_id BIGINT)');await h.pool.query('INSERT INTO cases VALUES(39,222)');
    const query=h.pool.query.bind(h.pool);let armed=true;
    h.pool.query=async(sql,args)=>{
      if(armed&&sql.startsWith('SELECT a.balance_kopecks')){
        const current=(await h.db.query('SELECT delivery_state FROM egrn_orders WHERE id=$1',[row.id])).rows[0];
        if(current.delivery_state?.inflight?.kind==='native-repair'){armed=false;entered.open();await release.promise;}
      }
      return query(sql,args);
    };
    const before=h.calls.documents.length,running=h.attach(222,{targets:[{chat:222,case_id:39}],copyOptions:{async beforeSend(){
      const staff=(await h.pool.query('SELECT approved FROM staff WHERE tg_id=222')).rows[0];
      if(!staff.approved)throw Object.assign(new Error('Revoked handoff recipient'),{code:'HANDOFF_RECIPIENT_UNAVAILABLE'});
    }}});
    await entered.promise;await h.pool.query('UPDATE staff SET approved=false WHERE tg_id=222');release.open();
    await assert.rejects(running,error=>error.code==='HANDOFF_RECIPIENT_UNAVAILABLE'&&error.uncertain===false);
    assert.equal(h.calls.documents.length,before);assert.equal(h.calls.copies.filter(value=>Number(value.chat_id)===222).length,1);assert.equal((await h.row(row.id)).delivery_state.inflight,undefined);assert.equal(h.calls.paid,1);
  }finally{release.open();await h.close();}
});

test('failed recipient delivery resumes from native receipts without refetching or reuploading the original', pg, async () => {
  let failed = true;
  const h = await fixture({ copy(value) { if (failed && Number(value.chat_id) === 222) throw { response: { error_code: 403 }, message: 'Synthetic Telegram rejection' }; } });
  try {
    const original = await h.add({ targets: [{ chat: 222 }] }); await h.poll();
    assert.equal((await h.row(original.id)).files_sent, 0);
    failed = false; await h.pool.query('UPDATE egrn_orders SET retry_at=NULL WHERE id=$1', [original.id]); await h.poll();
    assert.ok((await h.row(original.id)).files_sent > 0);
    assert.equal(h.calls.documents.length, 1); assert.deepEqual(h.calls.status, [7001]);
    assert.equal(h.calls.copies.filter(c => Number(c.chat_id) === 111).length, 1);
    assert.equal(h.calls.copies.filter(c => Number(c.chat_id) === 222).length, 2);
  } finally { await h.close(); }
});

for(const sourceKind of ['embedded','url'])test('partial '+sourceKind+' delivery matches exact originals after provider order changes, rather than reusing the previous array position', pg, async()=>{
  let attempt=0,phase=0;const h=await fixture({sendDocument(){if(++attempt===2)throw Object.assign(new Error('Synthetic rejected second document'),{response:{error_code:400,description:'Bad Request: rejected second file'}});}});
  const a=Buffer.from('%PDF-1.7\nORIGINAL-A\n'+'A'.repeat(300)+'\n%%EOF'),b=Buffer.from('%PDF-1.7\nORIGINAL-B\n'+'B'.repeat(300)+'\n%%EOF');
  try{
    const order=await h.add();
    h.api.qa.setStatus(async()=>({id_req:7001,status:(phase++===0?[a,b]:[b,a]).map(buf=>({type:'processed',statusDescription:'Выполнено',...(sourceKind==='embedded'?{file:buf.toString('base64')}:{download:'https://provider.invalid/'+(buf===a?'original-A':'original-B')+'.pdf'})}))}));
    h.api.qa.setDownload(async url=>({name:'provider-original.pdf',kind:'pdf',buf:url.includes('original-A')?a:b}));
    await h.poll();assert.equal((await h.row(order.id)).file_msgs.length,1);await h.pool.query('UPDATE egrn_orders SET retry_at=NULL WHERE id=$1',[order.id]);await h.poll();
    const row=await h.row(order.id),delivered=h.calls.documents.filter(call=>call.delivered);assert.equal(row.files_sent,2);assert.equal(delivered.filter(call=>call.file.source.equals(a)).length,1);assert.equal(delivered.filter(call=>call.file.source.equals(b)).length,1);assert.equal(h.calls.paid,0);assert.equal(new Set(row.file_msgs.map(record=>record.sha256)).size,2);
  }finally{await h.close();}
});

test('an incomplete legacy native packet without a content identity is explicitly stopped before any guessed replacement or resend',pg,async()=>{
  const h=await fixture(),a=Buffer.from('%PDF-1.7\nA'+'A'.repeat(300)+'\n%%EOF');try{
    const row=await h.add({status:'done',files:[{key:'embedded:0:old.pdf',chat:-100123,id:501,file_id:'legacy-original',name:'old.pdf',mime:'application/pdf',bytes:a.length}]});
    h.api.qa.setStatus(async()=>({id_req:7001,status:[{type:'processed',statusDescription:'Выполнено',file:a.toString('base64')}]}));await h.poll();
    const saved=await h.row(row.id);assert.equal(saved.files_sent,-1);assert.match(saved.error,/Старый частичный комплект/);assert.equal(h.calls.documents.length,0);assert.equal(h.calls.copies.length,0);assert.ok(h.calls.messages.some(call=>/вручную/.test(call.text)));assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('a verified legacy content identity keeps its original receipt key when the provider reorders the partial packet',pg,async()=>{
  const h=await fixture(),a=Buffer.from('%PDF-1.7\nA'+'A'.repeat(300)+'\n%%EOF'),b=Buffer.from('%PDF-1.7\nB'+'B'.repeat(300)+'\n%%EOF'),sha=require('node:crypto').createHash('sha256').update(a).digest('hex');try{
    const row=await h.add({status:'done',files:[{key:'legacy-original-A',sha256:sha,chat:-100123,id:501,file_id:'legacy-original',name:'old.pdf',mime:'application/pdf',bytes:a.length}]});
    h.api.qa.setStatus(async()=>({id_req:7001,status:[b,a].map(buf=>({type:'processed',statusDescription:'Выполнено',file:buf.toString('base64')}))}));await h.poll();
    const saved=await h.row(row.id);assert.equal(saved.files_sent,2);assert.equal(h.calls.documents.length,1);assert.ok(h.calls.documents[0].file.source.equals(b));assert.ok(saved.file_msgs.some(record=>record.key==='legacy-original-A'&&record.id===501));assert.equal(h.calls.paid,0);
  }finally{await h.close();}
});

test('waiting orders rotate out of a full polling batch so a newer ready order is checked', pg, async () => {
  const h = await fixture({ ready: id => id === 7021 });
  try {
    for (let i = 1; i <= 21; i++) await h.add({ id: 7000 + i, cad: '77:17:0120316:' + i });
    await h.poll(); await h.poll();
    assert.ok(h.calls.status.includes(7021)); assert.equal(h.calls.documents.length, 1);
  } finally { await h.close(); }
});

test('a deleted status card does not prevent delivery of the ready original', pg, async () => {
  const h = await fixture({ sendDocument(extra) { assert.equal(extra.reply_to_message_id, undefined); assert.equal(extra.reply_parameters.allow_sending_without_reply, true); } });
  try {
    const original = await h.add({ card: 999 }); await h.poll();
    assert.ok((await h.row(original.id)).files_sent > 0); assert.equal(h.calls.documents.length, 1);
  } finally { await h.close(); }
});

test('a ready native document is reused by the Telegram order action instead of offering only another paid order', pg, async () => {
  const h = await fixture();
  try {
    await h.add({ status: 'done', filesSent: 1, files: [{ key: 'pdf', chat: -100123, id: 7, name: 'statement.pdf' }] });
    const pending = (await h.pool.query('INSERT INTO egrn_pending(cad_num,chat_id) VALUES($1,$2) RETURNING id', [CAD, 111])).rows[0];
    const replies = [], action = h.actions.find(a => a.pattern.test('eg:' + pending.id + ':kv'));
    await action.handler({ match: ['eg:' + pending.id + ':kv', String(pending.id), 'kv'], from: { id: 111 }, callbackQuery: { message: { chat: { id: 111 } } }, async answerCbQuery() {}, async reply(text) { replies.push(text); }, telegram: h.telegram });
    assert.equal(h.calls.copies.length, 1); assert.equal(h.calls.paid, 0);
    assert.ok(replies.some(text => /Готовая выписка отправлена/.test(text)));
  } finally { await h.close(); }
});

test('overlapping poller instances claim each order once without holding a pooled connection', pg, async () => {
  const entered = gate(), release = gate();
  const h = await fixture({ async sendDocument() { entered.open(); await release.promise; } });
  try {
    const original = await h.add();
    const first = h.poll(); await entered.promise;
    const secondPoller = h.anotherPoller(); await secondPoller();
    assert.equal(h.calls.documents.length, 1); assert.deepEqual(h.calls.status, [7001]);
    release.open(); await first;
    const saved = await h.row(original.id); assert.ok(saved.files_sent > 0); assert.equal(saved.processing_token, null);
  } finally { release.open(); await h.close(); }
});

test('an expired delivery lease can be resumed after a process stopped', pg, async () => {
  const h = await fixture();
  try {
    const original = await h.add();
    await h.pool.query("UPDATE egrn_orders SET processing_token=gen_random_uuid(),processing_until=NOW()+INTERVAL '1 minute' WHERE id=$1", [original.id]);
    await h.poll(); assert.equal(h.calls.documents.length, 0);
    await h.pool.query("UPDATE egrn_orders SET processing_until=NOW()-INTERVAL '1 minute' WHERE id=$1", [original.id]);
    await h.poll(); assert.equal(h.calls.documents.length, 1); assert.ok((await h.row(original.id)).files_sent > 0);
  } finally { await h.close(); }
});

test('a recipient joining during delivery is retained pending and receives the cached original next round', pg, async () => {
  const entered = gate(), release = gate(); let block = true;
  const h = await fixture({ async copy(value) { if (block && Number(value.chat_id) === 111) { entered.open(); await release.promise; } } });
  try {
    const original = await h.add(); const delivery = h.poll(); await entered.promise;
    assert.equal((await h.attach(222)).result, 'waiting');
    block = false; release.open(); await delivery;
    assert.equal((await h.row(original.id)).files_sent, 0, 'new recipient must not be acknowledged by an older generation');
    await h.poll(); assert.ok((await h.row(original.id)).files_sent > 0);
    assert.equal(h.calls.documents.length, 1); assert.deepEqual(h.calls.status, [7001]);
    assert.equal(h.calls.copies.filter(c => Number(c.chat_id) === 222).length, 1);
    assert.equal(h.calls.copies.filter(c => Number(c.chat_id) === 111).length, 1);
  } finally { release.open(); await h.close(); }
});

test('an administrator can bind a verified existing provider order without creating a paid order', pg, async () => {
  const h = await fixture();
  try {
    const original = await h.add({ status: 'order_unknown' });
    const handler = h.commands.find(command => command.name === 'egrn_reconcile').handler;
    const replies = [];
    await handler({ chat: { type: 'private' }, from: { id: 222 }, message: { text: '/egrn_reconcile ' + original.id + ' 7001' }, async reply(value) { replies.push(value); } });
    assert.equal((await h.row(original.id)).status, 'order_unknown');
    await handler({ chat: { type: 'private' }, from: { id: 111 }, message: { text: '/egrn_reconcile ' + original.id + ' 7001' }, async reply(value) { replies.push(value); } });
    assert.equal((await h.row(original.id)).status, 'ordered'); assert.equal(h.calls.paid, 0);
    assert.ok(replies.some(value => /Существующий заказ привязан/.test(value)));
  } finally { await h.close(); }
});
