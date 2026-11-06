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
  const db = new PGlite(), calls = { paid: 0, status: [], documents: [], copies: [], messages: [] };
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
    process: { env: { EGRN_TOKEN: 'synthetic', EGRN_DECLARANT_ID: '1', EGRN_CHAT_ID: '-100123', ADMIN_TG_IDS: options.adminIDs || '111' } },
    console: { log() {}, error() {} }, setTimeout(fn) { poll = fn; }, setInterval() {},
    require(name) {
      if (name === '../db/pool') return pool;
      if (name === './order-evidence') return { async registerOriginal() { return {}; }, async registerCached() { return {}; } };
      return localRequire(name);
    },
    async fetch(url, request = {}) {
      assert.equal(request.method, 'POST'); const attempt = ++calls.paid;
      const response = await options.orderApi?.(attempt); if (response instanceof Response) return response;
      return new Response(JSON.stringify({ id_statement: 9000 + attempt }));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nmodule.exports.qa={ensureTables,reserveOrder,setStatus(fn){apiStatus=fn;}};', sandbox, { filename });
  const api = sandbox.module.exports;
  const telegram = {
    async sendMessage(chat, text) { calls.messages.push({ chat, text }); return { message_id: 100 + calls.messages.length }; },
    async editMessageText() {},
    async sendDocument(chat, file, extra) { calls.documents.push({ chat, file, extra }); await options.sendDocument?.(extra); return { message_id: 200 + calls.documents.length, document: { file_id: 'test-only-original', mime_type: 'application/pdf' } }; },
    async callApi(method, value) { calls.copies.push(value); await options.copy?.(value); return { message_id: 300 + calls.copies.length }; },
  };
  const bot = { on() {}, hears() {}, action(pattern, handler) { actions.push({ pattern, handler }); }, command(name, handler) { commands.push({ name, handler }); }, telegram };
  api.setupEgrn(bot);
  await api.qa.ensureTables();
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
