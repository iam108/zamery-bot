const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Pool } = require('pg');
const { createOrderDeliveryLock } = require('../src/db/order-delivery-lock');
const { closeSessionLockPool } = require('../src/db/session-lock-pool');
const { createManagerHandlers } = require('../src/web/manager-orders');
const materialModule = require('../src/web/order-materials');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('independent local callers serialize before mutation and an expired waiter cannot let a later call overtake the owner', async () => {
  const pool = {}, first = createOrderDeliveryLock(pool), impatient = createOrderDeliveryLock(pool, { waitMs: 10 }), later = createOrderDeliveryLock(pool);
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const held = first(58, async () => { entered = true; await gate; }); await settle(); assert.equal(entered, true);
  await assert.rejects(impatient(58, () => assert.fail('No mutation before admission')), error => error.status === 409 && error.code === 'ORDER_DELIVERY_BUSY' && error.busy);
  let advanced = false; const waiting = later(58, () => { advanced = true; }); await settle(); assert.equal(advanced, false);
  release(); await Promise.all([held, waiting]); assert.equal(advanced, true);
});

test('separate workers use the same advisory namespace and hold it through the complete business action', async () => {
  const held = new Set(), released = []; let number = 0;
  const lockPool = { async connect() { const session = ++number; return {
    async query(sql, values) {
      assert.match(sql, /119/); const id = values[0];
      if (sql.includes('pg_try_advisory_lock')) { if (held.has(id)) return { rows: [{ locked: false }] }; held.add(id); return { rows: [{ locked: true }] }; }
      assert.ok(held.delete(id)); return { rows: [{ pg_advisory_unlock: true }] };
    }, release(error) { released.push({ session, error }); },
  }; } };
  const workerA = createOrderDeliveryLock({}, { lockPool, waitMs: 100, pollMs: 1 }), workerB = createOrderDeliveryLock({}, { lockPool, waitMs: 100, pollMs: 1 });
  const events = []; let release; const gate = new Promise(resolve => { release = resolve; });
  const first = workerA(58, async () => { events.push('A mutation'); await gate; events.push('A delivery'); }); await settle();
  const second = workerB(58, () => { events.push('B mutation and delivery'); }); await settle(); assert.deepEqual(events, ['A mutation']);
  release(); await Promise.all([first, second]); assert.deepEqual(events, ['A mutation', 'A delivery', 'B mutation and delivery']); assert.equal(released.length, 2); assert.equal(held.size, 0);
});

test('foreign advisory contention returns busy without running work and failed unlock discards the owning session', async () => {
  let running = false, releaseError;
  const blocked = createOrderDeliveryLock({}, { waitMs: 5, pollMs: 1, lockPool: { async connect() { return { query: async () => ({ rows: [{ locked: false }] }), release() {} }; } } });
  await assert.rejects(blocked(58, () => { running = true; }), error => error.code === 'ORDER_DELIVERY_BUSY'); assert.equal(running, false);
  const unlockFailure = new Error('Synthetic unlock failure');
  const healthy = createOrderDeliveryLock({}, { lockPool: { async connect() { return { async query(sql) { if (sql.includes('pg_advisory_unlock')) throw unlockFailure; return { rows: [{ locked: true }] }; }, release(error) { releaseError = error; } }; } } });
  assert.equal(await healthy(58, () => 'confirmed'), 'confirmed'); assert.equal(releaseError, unlockFailure);
});

test('a one-slot SQL pool remains available while a separate bounded session pool owns order delivery', { timeout: 2000 }, async () => {
  const clients = []; let nested = 0;
  class Client extends EventEmitter {
    constructor(options) { super(); this.options = options; this._queryable = true; this._ending = false; clients.push(this); }
    connect(callback) { queueMicrotask(() => callback()); } ref() {} unref() {}
    end(callback) { this._ending = true; queueMicrotask(() => { this.emit('end'); callback?.(); }); }
    query(sql, values, callback) {
      if (typeof values === 'function') { callback = values; values = undefined; }
      if (sql === 'SELECT nested_business_query') nested++;
      const result = { rows: sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [] };
      if (callback) { setImmediate(() => callback(null, result)); return; } return Promise.resolve(result);
    }
  }
  const pool = new Pool({ Client, max: 1, connectionTimeoutMillis: 200, idleTimeoutMillis: 20, allowExitOnIdle: true }), lock = createOrderDeliveryLock(pool);
  try {
    await Promise.all([1, 2, 3, 4].map(id => lock(id, () => pool.query('SELECT nested_business_query'))));
    assert.equal(nested, 4); assert.equal(pool.waitingCount, 0); assert.ok(clients.some(client => client.options.max === 2));
  } finally { await closeSessionLockPool(pool); await pool.end(); }
  assert.ok(clients.every(client => client._ending));
});

test('concurrent creation confirmations from different handlers publish one card and one copy of each original', async () => {
  const pool = {}, files = new Map(); let order, cards = 0, documents = 0, creates = 0, releaseCard, cardStarted;
  const started = new Promise(resolve => { cardStarted = resolve; }), gate = new Promise(resolve => { releaseCard = resolve; });
  const materials = { ...materialModule, ensureOrderMaterials: async () => {}, listOrderMaterials: async (id, originals) => [...files.values()].map(file => originals ? { ...file } : { id: file.id, role: file.role }), markOrderMaterialDelivered: async (id, fileId, msg) => { files.get(fileId).telegram_msg_id = msg; } };
  const queries = { async createOrderWithMaterials(data, originals) { creates++; order ||= { ...data, id: 58, packet_revision: 1, status: 'new', submitted_name: 'Автор' }; for (const file of originals) if (!files.has(file.id)) files.set(file.id, { ...file }); return { ...order }; },
    getOrderById: async () => ({ ...order }), setTelegramMsgId: async (id, msg) => { order.telegram_msg_id = msg; }, addLog: async () => {} };
  let locked=false,reportUrl='https://t.me/c/111111/101';const reports=[],keyboards=[],orderLock=createOrderDeliveryLock(pool);
  const options = { pool, queries, materials, format: () => 'order',withOrderDeliveryLock:(id,run)=>orderLock(id,async()=>{locked=true;try{return await run();}finally{locked=false;}}),loadOrderReportLink:async id=>{assert.equal(id,58);assert.equal(locked,true);reports.push(reportUrl);return{url:reportUrl};}, attachOrOrder: () => assert.fail('No paid API'), getTelegram: () => ({ async sendMessage(chat,text,opts) { keyboards.push(opts);cards++; cardStarted(); await gate; return { message_id: 900 }; }, async editMessageText(chat,msg,unused,text,opts) {keyboards.push(opts);}, async sendDocument() { documents++; return { message_id: 901 }; } }) };
  options.telegramDelivery = require('./helpers/order-delivery').orderDeliveryDouble(options);
  const a = createManagerHandlers(options), b = createManagerHandlers(options), request = () => ({ params: {}, tgUser: { id: 108 }, staff: { name: 'Автор', role: 'manager' }, body: { address: 'Москва', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: 'Получение', submit_id: 'same-creation' }, files: [{ originalname: 'План.pdf', mimetype: 'application/pdf', buffer: Buffer.from('exact original') }] });
  const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }), ra = response(), rb = response();
  const first = a.save(request(), ra); await started; const second = b.save(request(), rb); await settle(); assert.equal(creates, 2); assert.equal(cards, 1);
  reportUrl='https://t.me/c/111111/209';releaseCard(); await Promise.all([first, second]); assert.equal(ra.body.ok, true); assert.equal(rb.body.ok, true); assert.equal(cards, 1); assert.equal(documents, 1); assert.equal(files.size, 1);
  assert.deepEqual(reports,['https://t.me/c/111111/101','https://t.me/c/111111/209']);assert.deepEqual(keyboards.map(opts=>opts.reply_markup.inline_keyboard.flat().find(button=>button.url).url),reports);
});
