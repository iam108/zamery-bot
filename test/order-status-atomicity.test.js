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

test('Telegram status mutation checks current approval in its SQL statement and leaves no status log on denial',
  {skip:!process.env.PGLITE_TEST_MODULE},async()=>{
    const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();let revoke=false;
    try{
      await db.exec("CREATE TABLE orders(id INT PRIMARY KEY,status TEXT);INSERT INTO orders VALUES(17,'new');CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,approved BOOLEAN);INSERT INTO staff VALUES(808,true);CREATE TABLE logs(order_id INT,action TEXT,actor TEXT,details TEXT);");
      const pool={connect:async()=>({async query(sql,args){if(revoke&&sql.startsWith('UPDATE orders SET status')){revoke=false;await db.exec('UPDATE staff SET approved=false WHERE tg_id=808');}return db.query(sql,args);},release(){}})};
      const c=vm.createContext({module:{exports:{}},require:name=>{assert.equal(name,'./pool');return pool;}});vm.runInContext(fs.readFileSync(require.resolve('../src/db/queries'),'utf8'),c);
      revoke=true;assert.equal(await c.module.exports.updateOrderStatus(17,'done','Actor',['new'],808),undefined);assert.equal((await db.query('SELECT status FROM orders WHERE id=17')).rows[0].status,'new');assert.equal(Number((await db.query('SELECT count(*) FROM logs')).rows[0].count),0);
      await db.exec('UPDATE staff SET approved=true WHERE tg_id=808');assert.equal((await c.module.exports.updateOrderStatus(17,'done','Actor',['new'],808)).status,'done');assert.equal(Number((await db.query('SELECT count(*) FROM logs')).rows[0].count),1);
    }finally{await db.close();}
  });
