const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('status transitions and log records commit together and stale actions do not reopen completed work',
  { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
    const { PGlite } = require(process.env.PGLITE_TEST_MODULE); const db = new PGlite();
    await db.exec("CREATE TABLE orders(id INT PRIMARY KEY,status TEXT); INSERT INTO orders VALUES(17,'new'); CREATE TABLE logs(order_id INT,action TEXT,actor TEXT CHECK(actor <> 'reject-test'),details TEXT);");
    const pool = { connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }) };
    const c = vm.createContext({ module: { exports: {} }, require: name => { assert.equal(name, './pool'); return pool; } });
    vm.runInContext(fs.readFileSync(require.resolve('../src/db/queries'), 'utf8'), c);
    try {
      const { updateOrderStatus } = c.module.exports;
      await assert.rejects(updateOrderStatus(17, 'in_progress', 'reject-test', ['new']));
      assert.equal((await db.query('SELECT status FROM orders WHERE id=17')).rows[0].status, 'new');
      await updateOrderStatus(17, 'done', 'Manager', ['new', 'in_progress']);
      assert.equal((await db.query('SELECT count(*) AS n FROM logs')).rows[0].n, 1);
      assert.equal(await updateOrderStatus(17, 'in_progress', 'Stale auditor', ['new']), undefined);
      assert.equal((await db.query('SELECT status FROM orders WHERE id=17')).rows[0].status, 'done');
      assert.equal((await db.query('SELECT count(*) AS n FROM logs')).rows[0].n, 1);
    } finally { await db.close(); }
  });
