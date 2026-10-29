const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { promisify } = require('node:util');
const PgSession = require('connect-pg-simple')(require('express-session'));

// Optional isolated PostgreSQL/WASM runtime; never connects to the production database.
test('migration and session persistence, expiry, touch and logout in PostgreSQL',
  { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
    const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
    const db = new PGlite();
    const pool = {
      query: (sql, params) => params ? db.query(sql, params) : db.exec(sql),
      connect: async () => ({ query: pool.query, release() {} }),
      end: async () => {},
    };
    const context = { module: { exports: {} }, console: { log() {}, error() {} }, require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === './pool') return pool;
      throw new Error('Unexpected require: ' + name);
    } };
    vm.createContext(context);
    const source = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
    vm.runInContext(source.replace(/migrate\(\)\.then\([\s\S]*$/, 'module.exports = migrate;'), context);
    const options = { pool, tableName: 'web_sessions', pruneSessionInterval: false };
    const first = new PgSession(options);
    const second = new PgSession(options);
    const call = (store, method, ...args) => promisify(store[method]).call(store, ...args);
    try {
      await context.module.exports();
      await context.module.exports(); // Safe to rerun the deployed migration.
      const expires = new Date(Date.now() + 86400000);
      await call(first, 'set', 'restart-check', { auth: true, cookie: { expires } });
      await first.close();
      assert.equal((await call(second, 'get', 'restart-check')).auth, true);
      await call(second, 'touch', 'restart-check', { cookie: { expires: new Date(Date.now() + 172800000) } });
      const expiry = await db.query('SELECT expire FROM web_sessions WHERE sid=$1', ['restart-check']);
      assert.ok(new Date(expiry.rows[0].expire) > expires);
      await call(second, 'set', 'expired-check', { auth: true, cookie: { expires: new Date(Date.now() - 60000) } });
      assert.equal(await call(second, 'get', 'expired-check'), undefined);
      await call(second, 'pruneSessions');
      const expired = await db.query('SELECT sid FROM web_sessions WHERE sid=$1', ['expired-check']);
      assert.equal(expired.rows.length, 0);
      await call(second, 'destroy', 'restart-check');
      assert.equal(await call(second, 'get', 'restart-check'), undefined);
    } finally {
      await first.close();
      await second.close();
      await db.close();
    }
  });
