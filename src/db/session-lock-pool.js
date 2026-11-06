const { Pool } = require('pg');

// Long-lived session advisory locks cannot occupy the ordinary SQL pool:
// delivery invokes other services that need their own query connections.
const sessionLockPools = new WeakMap();
function getSessionLockPool(pool, configuredPool, family = 'default') {
  if (configuredPool) return configuredPool;
  if (!(pool instanceof Pool)) return pool;
  if (!sessionLockPools.has(pool)) sessionLockPools.set(pool, new Map());
  const families = sessionLockPools.get(pool);
  if (!families.has(family)) {
    const locks = new Pool({ ...pool.options, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, allowExitOnIdle: true });
    locks.on('error', error => console.error('delivery session lock:', error.code || error.name));
    families.set(family, locks);
  }
  return families.get(family);
}
async function closeSessionLockPool(pool) {
  const families = sessionLockPools.get(pool);
  if (!families) return;
  sessionLockPools.delete(pool);
  const closed = await Promise.allSettled([...families.values()].map(locks => Promise.resolve().then(() => locks.end())));
  const failed = closed.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

module.exports = { getSessionLockPool, closeSessionLockPool };
