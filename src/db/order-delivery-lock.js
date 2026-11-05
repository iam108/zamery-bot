const { Pool } = require('pg');
const defaultPool = require('./pool');
const { getSessionLockPool } = require('./session-lock-pool');

const queues = new WeakMap();
function busy() {
  return Object.assign(new Error('Заявка уже обновляется. Дождитесь результата и повторите ту же отправку.'), { status: 409, code: 'ORDER_DELIVERY_BUSY', busy: true });
}
function localLock(pool, id, waitMs) {
  if (!queues.has(pool)) queues.set(pool, new Map());
  const orders = queues.get(pool);
  let queue = orders.get(id);
  return new Promise((resolve, reject) => {
    const grant = () => {
      let released = false;
      resolve(() => {
        if (released) return; released = true;
        const next = queue.shift();
        if (next) { clearTimeout(next.timer); next.grant(); }
        else orders.delete(id);
      });
    };
    if (!queue) { queue = []; orders.set(id, queue); grant(); return; }
    const waiter = { grant, timer: setTimeout(() => { queue.splice(queue.indexOf(waiter), 1); reject(busy()); }, waitMs) };
    queue.push(waiter);
  });
}

function createOrderDeliveryLock(pool = defaultPool, options = {}) {
  const waitMs = options.waitMs == null ? 5000 : options.waitMs, pollMs = options.pollMs || 25;
  return async (value, run) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw Object.assign(new Error('Некорректный номер заявки.'), { status: 400 });
    const started = Date.now(), releaseLocal = await localLock(pool, id, waitMs);
    let client, locked = false, unlockError;
    try {
      // In-memory adapters use the same local queue. Real PostgreSQL workers
      // additionally share a session lock without occupying the SQL pool.
      if (pool instanceof Pool || options.lockPool) {
        client = await getSessionLockPool(pool, options.lockPool).connect();
        for (;;) {
          locked = !!(await client.query('SELECT pg_try_advisory_lock(119,$1) AS locked', [id])).rows[0]?.locked;
          if (locked) break;
          const remaining = waitMs - (Date.now() - started);
          if (remaining <= 0) throw busy();
          await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
        }
      }
      return await run();
    } finally {
      if (locked) { try { await client.query('SELECT pg_advisory_unlock(119,$1)', [id]); } catch (error) { unlockError = error; } }
      if (client) client.release(unlockError);
      releaseLocal();
    }
  };
}

const withOrderDeliveryLock = createOrderDeliveryLock();
module.exports = { createOrderDeliveryLock, withOrderDeliveryLock };
