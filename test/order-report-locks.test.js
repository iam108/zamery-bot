const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Pool } = require('pg');
const { getSessionLockPool, closeSessionLockPool } = require('../src/db/session-lock-pool');
const { createOrderDeliveryLock } = require('../src/db/order-delivery-lock');

function fixture() {
  const clients = [], queries = [];
  class Client extends EventEmitter {
    constructor(options) { super(); this.options = options; this._queryable = true; this._ending = false; clients.push(this); }
    connect(callback) { queueMicrotask(() => callback()); } ref() {} unref() {}
    end(callback) { this._ending = true; queueMicrotask(() => { this.emit('end'); callback?.(); }); }
    query(sql, values, callback) {
      if (typeof values === 'function') { callback = values; values = undefined; }
      queries.push({ sql, values, client: this });
      const result = { rows: sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : [] };
      if (callback) { setImmediate(() => callback(null, result)); return; } return Promise.resolve(result);
    }
  }
  const pool = new Pool({ Client, max: 1, connectionTimeoutMillis: 100, idleTimeoutMillis: 20, allowExitOnIdle: true });
  return { pool, clients, queries };
}

test('two outer audit sessions can both finish nested order links while the ordinary SQL pool has one slot', { timeout: 2000 }, async () => {
  const h = fixture(), drafts = getSessionLockPool(h.pool), orders = getSessionLockPool(h.pool, undefined, 'order');
  drafts.options.connectionTimeoutMillis = 40;
  assert.equal(drafts.options.max, 2); assert.equal(orders.options.max, 2);
  const lock = createOrderDeliveryLock(h.pool), held = []; let ready, entered = 0;
  const barrier = new Promise(resolve => { ready = resolve; });
  try {
    const outcomes = await Promise.allSettled([58, 59].map(async id => {
      const client = await drafts.connect(); held.push(client);
      try {
        await client.query('SELECT pg_try_advisory_lock(109,hashtext($1)) AS locked', ['draft-' + id]);
        if (++entered === 2) ready(); await barrier;
        await lock(id, () => h.pool.query('SELECT nested_report_link_business_query'));
        await client.query('SELECT pg_advisory_unlock(109,hashtext($1))', ['draft-' + id]);
      } finally { client.release(); held.splice(held.indexOf(client), 1); }
    }));
    const failed = outcomes.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    assert.equal(h.queries.filter(item => item.sql === 'SELECT nested_report_link_business_query').length, 2);
    assert.equal(h.queries.filter(item => item.sql.includes('pg_try_advisory_lock(119')).length, 2);
    assert.equal(h.pool.totalCount, 1); assert.equal(h.pool.waitingCount, 0); assert.equal(drafts.waitingCount, 0); assert.equal(orders.waitingCount, 0);
  } finally { held.forEach(client => client.release()); await closeSessionLockPool(h.pool); await h.pool.end(); }
  assert.ok(h.clients.every(client => client._ending), 'Closing the base pool closes every owned lock family');
});

test('order callers share one family while audit and handoff keep their existing default family', async () => {
  const h = fixture();
  try {
    const defaults = getSessionLockPool(h.pool), orders = getSessionLockPool(h.pool, undefined, 'order');
    assert.equal(getSessionLockPool(h.pool), defaults); assert.equal(getSessionLockPool(h.pool, undefined, 'order'), orders); assert.notEqual(defaults, orders);
    const injected = { end() { assert.fail('An explicitly injected pool is not owned'); } };
    assert.equal(getSessionLockPool(h.pool, injected, 'order'), injected);
    const adapter = { end() { assert.fail('A caller adapter is not owned'); } }; assert.equal(getSessionLockPool(adapter, undefined, 'order'), adapter); await closeSessionLockPool(adapter);
    await closeSessionLockPool(h.pool);
    assert.notEqual(getSessionLockPool(h.pool), defaults); assert.notEqual(getSessionLockPool(h.pool, undefined, 'order'), orders);
  } finally { await closeSessionLockPool(h.pool); await h.pool.end(); }
});

test('cleanup still closes every family if one owned session pool fails to close', async () => {
  const h = fixture(), defaults = getSessionLockPool(h.pool), orders = getSessionLockPool(h.pool, undefined, 'order');
  const originalDefault = defaults.end.bind(defaults), originalOrders = orders.end.bind(orders), failure = new Error('Synthetic close failure'); let orderClosed = false;
  defaults.end = async () => { await originalDefault(); throw failure; };
  orders.end = async () => { orderClosed = true; await originalOrders(); };
  try { await assert.rejects(closeSessionLockPool(h.pool), error => error === failure); assert.equal(orderClosed, true); await closeSessionLockPool(h.pool); }
  finally { await h.pool.end(); }
});
