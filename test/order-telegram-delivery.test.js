const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderTelegramDelivery } = require('../src/web/order-telegram-delivery');
const materials = require('../src/web/order-materials');
const pg = { skip: !process.env.PGLITE_TEST_MODULE, timeout: 15000 };
const rejected = (code, description = 'synthetic rejection') => Object.assign(new Error(description), { response: { error_code: code, description } });

async function fixture(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  let tail = Promise.resolve(), fault = () => false, serial = 900;
  const calls = [];
  const pool = {
    async connect() {
      const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
      return { async query(sql, args) { if (fault(sql, args)) throw new Error('Synthetic SQL failure'); return args ? db.query(sql, args) : db.exec(sql).then(result => result.at(-1)); }, release };
    },
    async query(sql, args) { const client = await pool.connect(); try { return await client.query(sql, args); } finally { client.release(); } },
  };
  await db.exec('CREATE TABLE orders(id INT PRIMARY KEY,submitted_by BIGINT,telegram_msg_id BIGINT); INSERT INTO orders VALUES(58,108,NULL),(59,109,NULL);');
  const store = materials.createMaterialsStore(pool); await store.ensure();
  const telegram = {
    async sendMessage(chat, text, extra) { calls.push({ kind: 'card', chat, text, extra }); return { message_id: serial++ }; },
    async editMessageText(chat, message, unused, text, extra) { calls.push({ kind: 'edit', chat, message, text, extra }); },
    async sendDocument(chat, file, extra) { calls.push({ kind: 'file', chat, name: file.filename, bytes: Buffer.from(file.source), extra }); return { message_id: serial++ }; },
  };
  const create = () => createOrderTelegramDelivery({ pool, telegram, groupId: '-100321', ready: store.ensure });
  const h = { db, pool, store, telegram, calls, create, row: async () => (await pool.query('SELECT * FROM orders WHERE id=58')).rows[0],
    set fault(fn) { fault = fn; }, async add(name = 'План.pdf', bytes = 'exact original') { const prepared = materials.prepareMaterials([{ originalname: name, mimetype: 'application/pdf', buffer: Buffer.from(bytes) }]); await store.save(58, prepared); return (await store.list(58, true)).find(file => file.id === prepared[0].id); } };
  try { await run(h); } finally { await db.close(); }
}
const card = delivery => delivery.publishCard({ id: 58 }, 'Synthetic original card', { reply_markup: { inline_keyboard: [] } });

test('card intent commits before Telegram and a lost ACK survives restart without a duplicate', pg, async () => fixture(async h => {
  h.telegram.sendMessage = async () => { h.calls.push({ kind: 'card' }); assert.equal((await h.row()).telegram_delivery.card.state, 'sending'); throw new Error('ACK lost after acceptance'); };
  const first = await card(h.create()); assert.equal(first.unknown, true); assert.match(first.warning, /могло дойти/);
  const second = await card(h.create()); assert.equal(second.unknown, true); assert.equal(h.calls.length, 1); assert.equal((await h.row()).telegram_msg_id, null);
  assert.deepEqual(await h.create().preview(58), { order_id: 58, slots: [{ slot: 'card', name: 'Карточка заявки', generation: 1 }] });
}));

test('an intent write failure stops before Telegram; an ACK checkpoint failure remains unknown after restart', pg, async () => fixture(async h => {
  h.fault = sql => sql.startsWith('UPDATE orders SET telegram_delivery=');
  await assert.rejects(card(h.create()), /Synthetic SQL/); assert.equal(h.calls.length, 0);
  h.fault = sql => sql.startsWith('UPDATE orders SET telegram_msg_id=');
  const result = await card(h.create()); assert.equal(result.unknown, true); assert.equal(h.calls.length, 1);
  h.fault = () => false; assert.equal((await h.row()).telegram_delivery.card.state, 'sending');
  assert.equal((await card(h.create())).unknown, true); assert.equal(h.calls.length, 1);
}));

for (const error of [new Error('network failed'), rejected(500), null]) test('network, 5xx and malformed Telegram ACK never become safely retryable: ' + (error?.message || 'malformed'), pg, async () => fixture(async h => {
  h.telegram.sendMessage = async () => { h.calls.push({ kind: 'card' }); if (error) throw error; return { message_id: 'bad' }; };
  assert.equal((await card(h.create())).unknown, true); await card(h.create()); assert.equal(h.calls.length, 1); assert.equal((await h.row()).telegram_msg_id, null);
}));

test('an explicit Telegram 4xx rejection permits a later safe retry', pg, async () => fixture(async h => {
  const send = h.telegram.sendMessage; h.telegram.sendMessage = async () => { h.calls.push({ kind: 'rejected' }); throw rejected(429); };
  const first = await card(h.create()); assert.equal(first.unknown, false); assert.equal((await h.row()).telegram_delivery.card.state, 'failed');
  h.telegram.sendMessage = send; assert.equal((await card(h.create())).ok, true); assert.equal((await h.row()).telegram_delivery.card.generation, 2);
}));

test('only exact deleted-card rejection creates a replacement; edit forbidden and not-modified never create a new card', pg, async () => fixture(async h => {
  await h.pool.query('UPDATE orders SET telegram_msg_id=899 WHERE id=58');
  for (const error of [rejected(403), rejected(400, "Bad Request: message can't be edited"), new Error('network'), rejected(400, 'Bad Request: message is not modified')]) {
    h.telegram.editMessageText = async () => { throw error; }; await card(h.create()); assert.equal(h.calls.length, 0);
  }
  h.telegram.editMessageText = async () => { throw rejected(400, 'Bad Request: message to edit not found'); };
  const replaced = await card(h.create()); assert.equal(replaced.created, true); assert.equal(h.calls.length, 1); assert.equal(Number((await h.row()).telegram_msg_id), 900);
}));

test('material receipt and JSON checkpoint roll back together; restart blocks the unknown original but delivers a different pending file', pg, async () => fixture(async h => {
  await card(h.create()); const a = await h.add('А.pdf', 'A original'), b = await h.add('Б.pdf', 'B original');
  let armed = false; const send = h.telegram.sendDocument;
  h.telegram.sendDocument = async (...args) => { const ack = await send(...args); armed = true; return ack; };
  h.fault = sql => armed && sql.startsWith('UPDATE orders SET telegram_delivery=');
  assert.equal((await h.create().publishMaterial({ id: 58 }, a)).unknown, true);
  armed = false; h.fault = () => false; h.telegram.sendDocument = send;
  const after = (await h.store.list(58, true)).find(file => file.id === a.id); assert.equal(after.telegram_msg_id, null);
  assert.equal((await h.row()).telegram_delivery.materials[a.id].state, 'sending');
  assert.equal((await h.create().publishMaterial({ id: 58 }, a)).unknown, true);
  assert.equal((await h.create().publishMaterial({ id: 58 }, b)).ok, true);
  assert.deepEqual(h.calls.filter(call => call.kind === 'file').map(call => call.name), ['А.pdf', 'Б.pdf']);
  const sent = (await h.store.list(58, true)).find(file => file.id === b.id); assert.equal((await h.create().publishMaterial({ id: 58 }, sent)).ok, true);
  assert.equal(h.calls.filter(call => call.kind === 'file').length, 2);
}));

test('receipt constraints cannot falsely confirm a missing or altered original', pg, async () => fixture(async h => {
  await card(h.create()); const file = await h.add();
  await assert.rejects(h.create().publishMaterial({ id: 59 }, file), /подтвердить оригинал/);
  await assert.rejects(h.create().publishMaterial({ id: 58 }, { ...file, buffer: Buffer.from('altered') }), /подтвердить оригинал/);
  h.telegram.sendDocument = async () => { await h.pool.query('DELETE FROM order_materials WHERE order_id=58 AND id=$1', [file.id]); h.calls.push({ kind: 'file' }); return { message_id: 990 }; };
  assert.equal((await h.create().publishMaterial({ id: 58 }, file)).unknown, true); assert.equal((await h.row()).telegram_delivery.materials[file.id].state, 'sending');
}));

test('reviewed retry is generation-bound, monotonic across restart and only reopens the selected unknown slot', pg, async () => fixture(async h => {
  await card(h.create()); const a = await h.add('А.pdf'), b = await h.add('Б.pdf');
  await h.create().publishMaterial({ id: 58 }, b);
  const send = h.telegram.sendDocument; h.telegram.sendDocument = async () => { h.calls.push({ kind: 'unknown' }); throw new Error('ACK lost'); };
  await h.create().publishMaterial({ id: 58 }, a);
  const attempt = { actorId: 108, messageId: 200, expectedGeneration: 1 };
  assert.equal((await h.create().allowRetry(58, a.id, attempt)).state, 'retry_ready');
  await h.create().publishMaterial({ id: 58 }, a); // a second uncertain generation
  assert.equal((await h.create().allowRetry(58, a.id, { ...attempt, expectedGeneration: 2 })).state, 'replayed');
  assert.equal((await h.create().allowRetry(58, a.id, { ...attempt, messageId: 201 })).state, 'stale');
  assert.equal((await h.create().allowRetry(58, a.id, { ...attempt, messageId: 202, expectedGeneration: 2 })).state, 'retry_ready');
  h.telegram.sendDocument = send;
  assert.equal((await h.create().publishMaterial({ id: 58 }, a)).ok, true);
  await h.create().publishMaterial({ id: 58 }, b); assert.equal(h.calls.filter(call => call.kind === 'file').length, 2);
  assert.equal((await h.row()).telegram_delivery.materials[a.id].generation, 3);
}));

test('a configured-chat change cannot reuse a prior confirmed material receipt in another destination', pg, async () => fixture(async h => {
  await card(h.create()); const file = await h.add(); await h.create().publishMaterial({ id: 58 }, file);
  await h.pool.query('UPDATE order_materials SET telegram_msg_id=NULL WHERE id=$1', [file.id]);
  const changed = createOrderTelegramDelivery({ pool: h.pool, telegram: h.telegram, groupId: '-100999', ready: h.store.ensure });
  const result = await changed.publishMaterial({ id: 58 }, file); assert.equal(result.ok, false); assert.match(result.warning, /чат изменился/); assert.equal(h.calls.filter(call => call.kind === 'file').length, 1);
}));

test('a repeated card/file message id is a malformed material ACK and cannot confirm original bytes',pg,async()=>fixture(async h=>{
  await card(h.create());const a=await h.add('А.pdf'),b=await h.add('Б.pdf');
  h.telegram.sendDocument=async()=>{h.calls.push({kind:'file'});return{message_id:900};};
  assert.equal((await h.create().publishMaterial({id:58},a)).unknown,true);assert.equal((await h.store.list(58)).find(file=>file.id===a.id).telegram_msg_id,null);
  h.telegram.sendDocument=async()=>({message_id:901});await h.create().publishMaterial({id:58},b);
  const c=await h.add('В.pdf');assert.equal((await h.create().publishMaterial({id:58},c)).unknown,true);assert.equal((await h.store.list(58)).find(file=>file.id===c.id).telegram_msg_id,null);
}));

test('an ACK from another chat cannot confirm a card or original in the configured working chat',pg,async()=>fixture(async h=>{
  h.telegram.sendMessage=async()=>({message_id:900,chat:{id:-100999}});
  assert.equal((await card(h.create())).unknown,true);assert.equal((await h.row()).telegram_msg_id,null);
  await h.pool.query("UPDATE orders SET telegram_msg_id=899,telegram_delivery='{}' WHERE id=58");
  const file=await h.add();h.telegram.sendDocument=async()=>({message_id:901,chat:{id:-100999}});
  assert.equal((await h.create().publishMaterial({id:58},file)).unknown,true);assert.equal((await h.store.list(58))[0].telegram_msg_id,null);
}));

test('replaying an old preview and previously busy retry after restart cannot authorize a later unknown generation',pg,async()=>fixture(async h=>{
  h.telegram.sendMessage=async()=>{throw new Error('ACK lost');};await card(h.create());
  const {createOrderDeliveryAdmin}=require('../src/bot/order-delivery-admin');let busy=false;const replies=[];
  const create=()=>createOrderDeliveryAdmin({pool:h.pool,delivery:h.create(),adminIds:[108],withOrderDeliveryLock:async(id,run)=>{if(busy)throw new Error('Order lock busy');return run();}});
  const ctx=(text,message)=>({from:{id:108},chat:{id:108,type:'private'},message:{text,message_id:message},async reply(text){replies.push(text);}});
  const first=create();await first.preview(ctx('/order_delivery 58',100));busy=true;await first.retry(ctx('/order_delivery_retry 58 1 confirm_missing',101));busy=false;
  await h.create().allowRetry(58,'card',{actorId:109,messageId:200,expectedGeneration:1});await card(h.create());assert.equal((await h.row()).telegram_delivery.card.generation,2);
  const restarted=create();await restarted.preview(ctx('/order_delivery 58',100));await restarted.retry(ctx('/order_delivery_retry 58 1 confirm_missing',101));
  assert.equal((await h.row()).telegram_delivery.card.state,'unknown','Old command updates cannot become consent for a later attempt');
  await restarted.preview(ctx('/order_delivery 58',102));await restarted.retry(ctx('/order_delivery_retry 58 1 confirm_missing',103));
  assert.equal((await h.row()).telegram_delivery.card.state,'retry_ready','A new deliberate preview and confirmation can recover the current generation');
}));
