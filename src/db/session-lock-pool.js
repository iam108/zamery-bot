const { Pool } = require('pg');

// Long-lived session advisory locks cannot occupy the ordinary SQL pool:
// delivery invokes other services that need their own query connections.
const sessionLockPools = new WeakMap();
function getSessionLockPool(pool, configuredPool) {
  if (configuredPool) return configuredPool;
  if (!(pool instanceof Pool)) return pool;
  if (!sessionLockPools.has(pool)) {
    const locks = new Pool({ ...pool.options, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, allowExitOnIdle: true });
    locks.on('error', error => console.error('delivery session lock:', error.code || error.name));
    sessionLockPools.set(pool, locks);
  }
  return sessionLockPools.get(pool);
}
async function closeSessionLockPool(pool) {
  const locks = sessionLockPools.get(pool);
  if (!locks) return;
  sessionLockPools.delete(pool);
  await locks.end();
}

module.exports = { getSessionLockPool, closeSessionLockPool };
