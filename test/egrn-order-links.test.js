const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderEgrnLinks, setupOrderEgrnLinks } = require('../src/web/order-egrn-links');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test('public-group medium originals upgrade existing numeric references and keep exact order binding', {skip:!process.env.PGLITE_TEST_MODULE},async()=>{
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),pool={query:(sql,args)=>args?db.query(sql,args):db.exec(sql).then(results=>results.at(-1))};
  try{
    await db.exec(`CREATE TABLE orders(id INT PRIMARY KEY);INSERT INTO orders VALUES(1),(2);CREATE TABLE egrn_files(id UUID PRIMARY KEY,name TEXT,mime TEXT,bytes BIGINT,sha256 TEXT);
      CREATE TABLE egrn_orders(id BIGINT PRIMARY KEY,file_msgs JSONB);
      CREATE TABLE order_egrn_telegram_links(order_id INT NOT NULL REFERENCES orders(id),id UUID NOT NULL,egrn_order_id BIGINT NOT NULL,chat_id BIGINT NOT NULL,message_id BIGINT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,bytes BIGINT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(order_id,id));`);
    await db.query('INSERT INTO order_egrn_telegram_links(order_id,id,egrn_order_id,chat_id,message_id,name,mime,bytes) VALUES(1,$1,19,-10012345,77,$2,$3,35000000)',[OTHER,'Old.pdf','application/pdf']);
    const record={key:'native-original',chat:108,id:88,file_id:'SYNTHETIC_FILE',name:'Current.pdf',mime:'application/pdf',bytes:35*1024*1024,deliveries:[{chat:'@SyntheticMeasurements',id:99}]};
    await db.query('INSERT INTO egrn_orders VALUES(19,$1)',[JSON.stringify([record])]);
    const files={ensure:async()=>{},get:async()=>assert.fail('No paid/order/object operation')},service=createOrderEgrnLinks({pool,files});
    await service.register({id:19,deliver:[{order_id:1,chat:'@SyntheticMeasurements'}]},[record]);
    const refs=await service.list(1),current=refs.find(value=>value.name==='Current.pdf');assert.ok(current);assert.equal(refs.length,2);
    assert.deepEqual(await service.link(1,OTHER),{ok:true,url:'https://t.me/c/12345/77'});
    assert.deepEqual(await service.link(1,current.id),{ok:true,url:'https://t.me/SyntheticMeasurements/99'});
    const delivery=await service.delivery(1,current.id,current);assert.equal(delivery.chat_id,'@SyntheticMeasurements');assert.equal(delivery.message_id,99);assert.equal(delivery.file_id,record.file_id);
    await assert.rejects(service.link(2,current.id),error=>error.status===404);
    const restarted=createOrderEgrnLinks({pool,files});await restarted.ensure();assert.deepEqual(await restarted.link(1,OTHER),{ok:true,url:'https://t.me/c/12345/77'});
    await service.register({id:19,deliver:[{order_id:1}]},[{...record,deliveries:[{chat:'@bad/unsafe',id:99}]}]);
    assert.equal((await service.list(1)).length,2);
  }finally{await db.close();}
});

test('large originals are linked to every explicit request without copying their bytes', { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite();
  const pool = { query: (sql, values) => values ? db.query(sql, values) : db.exec(sql).then(result => result.at(-1)) };
  const file = { id: ID, egrn_order_id: 9, name: 'Большая выписка.pdf', mime: 'application/pdf', bytes: 393 * 1024 * 1024, sha256: 'a'.repeat(64) };
  const files = { async ensure() {}, async get(id) { return id === ID ? file : null; }, chunks() { assert.fail('Listing references must not read the large original'); } };
  let links = 0;
  const service = createOrderEgrnLinks({ pool, files, makeUrl(id) { assert.equal(id, ID); return 'https://bot.example.test/egrn-files/' + id + '/download?fresh=' + (++links); } });
  try {
    await db.exec('CREATE TABLE orders(id INT PRIMARY KEY); INSERT INTO orders VALUES(1),(2); CREATE TABLE egrn_files(id UUID PRIMARY KEY,name TEXT,mime TEXT,bytes BIGINT,sha256 TEXT);');
    await db.query('INSERT INTO egrn_files VALUES($1,$2,$3,$4,$5)', [ID, file.name, file.mime, file.bytes, file.sha256]);
    const order = { id: 9, deliver: [{ chat: 11, order_id: 1 }, { chat: 12, order_id: 2 }, { chat: 13, order_id: 1 }, { chat: 14 }] };
    const records = [{ kind: 'link', original_id: ID }];
    await service.register(order, records); await service.register(order, records);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM order_egrn_links')).rows[0].n, 2);
    const first = await service.list(1);
    assert.deepEqual(first, [{ id: ID, name: file.name, mime: file.mime, bytes: file.bytes, sha256: file.sha256, role: 'egrn', source: 'stored', url: '/api/audit/orders/1/egrn/' + ID + '/link' }]);
    assert.equal(links, 0, 'Stored packet references have stable URLs without expiring signatures');
    assert.notEqual((await service.link(1, ID)).url, (await service.link(1, ID)).url, 'Each explicit download gets a fresh signed URL');
    await assert.rejects(service.link(1, OTHER), error => error.status === 404);
    await assert.rejects(service.register({ ...order, id: 10 }, records), error => error.status === 409);
    await db.query('DELETE FROM egrn_files WHERE id=$1', [ID]);
    assert.deepEqual(await service.list(1), [], 'Expired/missing originals cannot leave a fake available file');
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='order_egrn_links' AND column_name IN ('content','buffer','url')")).rows[0].n, 0);
  } finally { await db.close(); }
});

test('the authenticated link route uses its order/file pair and returns no-cache metadata only', async () => {
  const routes = [];
  setupOrderEgrnLinks({ get(path, run) { routes.push({ path, run }); } }, { async link(order, original) { assert.equal(order, '7'); assert.equal(original, ID); return { ok: true, url: 'https://bot.example.test/original' }; } });
  const headers = {}, body = [];
  const res = { set(name, value) { headers[name] = value; return this; }, json(value) { body.push(value); return this; } };
  assert.equal(routes[0].path, '/api/audit/orders/:orderId/egrn/:originalId/link');
  await routes[0].run({ params: { orderId: '7', originalId: ID } }, res);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.deepEqual(body, [{ ok: true, url: 'https://bot.example.test/original' }]);
});

test('medium native Telegram originals retain only source metadata and expose no invented content hash or file credential', { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite(), pool = { query: (sql, values) => values ? db.query(sql, values) : db.exec(sql).then(result => result.at(-1)) };
  const files = { async ensure() {}, async get() { assert.fail('A native Telegram reference has no second stored original'); } };
  const service = createOrderEgrnLinks({ pool, files, makeUrl() { assert.fail('Native references must not mint an object download URL'); } });
  try {
    await db.exec('CREATE TABLE orders(id INT PRIMARY KEY); INSERT INTO orders VALUES(1); CREATE TABLE egrn_files(id UUID PRIMARY KEY,name TEXT,mime TEXT,bytes BIGINT,sha256 TEXT);');
    const record = { chat: -10012345, id: 77, name: 'Выписка.pdf', mime: 'application/pdf', bytes: 35*1024*1024, file_id:'PRIVATE_TELEGRAM_FILE_ID' };
    await service.register({ id: 19, deliver: [{ order_id:1, chat:9 }] }, [record]);
    const refs = await service.list(1);
    assert.equal(refs.length,1); assert.equal(refs[0].source,'telegram'); assert.equal(refs[0].bytes,record.bytes);
    assert.equal(Object.hasOwn(refs[0],'sha256'),false); assert.equal(JSON.stringify(refs).includes('PRIVATE_TELEGRAM_FILE_ID'),false);
    assert.deepEqual(await service.link(1,refs[0].id),{ok:true,url:'https://t.me/c/12345/77'});
    await assert.rejects(service.link(2,refs[0].id),error=>error.status===404);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM egrn_files')).rows[0].n,0);
  } finally {await db.close();}
});

test('a medium original received privately links its confirmed workgroup copy to each explicit order', { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),pool={query:(sql,args)=>args?db.query(sql,args):db.exec(sql).then(results=>results.at(-1))};
  try{
    await db.exec('CREATE TABLE orders(id INT PRIMARY KEY); INSERT INTO orders VALUES(1),(2); CREATE TABLE egrn_files(id UUID PRIMARY KEY,name TEXT,mime TEXT,bytes BIGINT,sha256 TEXT); CREATE TABLE egrn_orders(id BIGINT PRIMARY KEY,file_msgs JSONB);');
    const record={key:'embedded:0:statement.pdf',chat:108,id:77,file_id:'SAVED_NATIVE_FILE_ID',name:'statement.pdf',mime:'application/pdf',bytes:35*1024*1024,deliveries:[{chat:-10012345,id:88}]};
    await db.query('INSERT INTO egrn_orders VALUES(19,$1)',[JSON.stringify([record])]);
    const service=createOrderEgrnLinks({pool,files:{ensure:async()=>{}},makeUrl:()=>assert.fail('No stored copy or paid lookup')});
    await service.register({id:19,deliver:[{order_id:1,chat:-10012345},{order_id:2,chat:-10012345}]},[record]);
    for(const order of [1,2]){
      const refs=await service.list(order);assert.equal(refs.length,1);assert.equal(refs[0].source,'telegram');assert.equal(refs[0].sha256,undefined);
      assert.deepEqual(await service.link(order,refs[0].id),{ok:true,url:'https://t.me/c/12345/88'});
      const delivery=await service.delivery(order,refs[0].id,refs[0]);assert.equal(delivery.kind,'telegram');assert.equal(delivery.file_id,record.file_id);assert.equal(delivery.message_id,88);assert.equal(String(delivery.chat_id),'-10012345');assert.equal(delivery.source_key,record.key);
      assert.ok(delivery.legacy_receipt_keys.includes(JSON.stringify(['-10012345',record.key])));
      assert.equal(JSON.stringify(refs).includes('SAVED_NATIVE_FILE_ID'),false);
      await assert.rejects(service.delivery(order,refs[0].id,{...refs[0],bytes:1}),error=>error.status===409);
    }
  }finally{await db.close();}
});

test('repairing a deleted Telegram source refreshes existing references without changing their reviewed identity', { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),pool={query:(sql,args)=>args?db.query(sql,args):db.exec(sql).then(results=>results.at(-1))};
  try{
    await db.exec('CREATE TABLE orders(id INT PRIMARY KEY); INSERT INTO orders VALUES(1),(2); CREATE TABLE egrn_files(id UUID PRIMARY KEY,name TEXT,mime TEXT,bytes BIGINT,sha256 TEXT); CREATE TABLE egrn_orders(id BIGINT PRIMARY KEY,file_msgs JSONB);');
    const service=createOrderEgrnLinks({pool,files:{ensure:async()=>{}}}),order={id:19,deliver:[{order_id:1},{order_id:2}]};
    const original={key:'pdf',chat:-10012345,id:77,file_id:'FILE_ID',name:'statement.pdf',mime:'application/pdf',bytes:35*1024*1024};
    await service.register(order,[original]);const reviewed=(await service.list(1))[0];
    const repaired={...original,reference_chat:original.chat,reference_id:original.id,chat:-10098765,id:99,deliveries:[{chat:2001,id:100}]};
    await db.query('INSERT INTO egrn_orders VALUES(19,$1)',[JSON.stringify([repaired])]);await service.register(order,[repaired]);
    for(const id of [1,2]){const refs=await service.list(id);assert.equal(refs.length,1);assert.equal(refs[0].id,reviewed.id);assert.deepEqual(await service.link(id,reviewed.id),{ok:true,url:'https://t.me/c/98765/99'});}
    const delivered=await service.delivery(1,reviewed.id,reviewed);assert.equal(delivered.file_id,'FILE_ID');assert.ok(delivered.legacy_receipt_keys.includes(JSON.stringify(['2001','pdf'])));
    await service.register(order,[{...repaired,name:'Different original.pdf',id:123}]);
    assert.deepEqual(await service.link(1,reviewed.id),{ok:true,url:'https://t.me/c/98765/99'},'Another original cannot retarget the reviewed reference');
    assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM order_egrn_telegram_links')).rows[0].count),2);
  }finally{await db.close();}
});

test('delivery of a stored reviewed original refreshes its signed URL and exposes only exact legacy receipt keys', { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite(),pool={query:(sql,args)=>args?db.query(sql,args):db.exec(sql).then(results=>results.at(-1))};
  try{
    await db.exec('CREATE TABLE orders(id INT PRIMARY KEY); INSERT INTO orders VALUES(1); CREATE TABLE egrn_files(id UUID PRIMARY KEY,name TEXT,mime TEXT,bytes BIGINT,sha256 TEXT); CREATE TABLE egrn_orders(id BIGINT PRIMARY KEY,file_msgs JSONB);');
    const file={id:ID,egrn_order_id:19,source_key:'url:0',name:'large.pdf',mime:'application/pdf',bytes:350*1024*1024,sha256:'a'.repeat(64)};
    await db.query('INSERT INTO egrn_files VALUES($1,$2,$3,$4,$5)',[ID,file.name,file.mime,file.bytes,file.sha256]);
    await db.query('INSERT INTO egrn_orders VALUES(19,$1)',[JSON.stringify([{kind:'link',key:'url:0',original_id:ID,deliveries:[{chat:2001,id:1}]}])]);
    let signed=0;const service=createOrderEgrnLinks({pool,files:{ensure:async()=>{},get:async()=>file},makeUrl:()=> 'https://bot.example/large?fresh='+(++signed)});
    await service.register({id:19,deliver:[{order_id:1}]},[{kind:'link',original_id:ID}]);const expected=(await service.list(1))[0];
    const a=await service.delivery(1,ID,expected),b=await service.delivery(1,ID,expected);assert.equal(a.kind,'link');assert.notEqual(a.url,b.url);assert.equal(a.source_key,'url:0');assert.deepEqual(a.legacy_receipt_keys,[JSON.stringify(['2001','url:0'])]);
    await db.query('UPDATE egrn_orders SET file_msgs=$1 WHERE id=19',[JSON.stringify([{kind:'link',key:'url:0',original_id:OTHER,deliveries:[{chat:2001,id:1}]}])]);
    const different=await service.delivery(1,ID,expected);assert.equal(different.source_key,undefined);assert.equal(different.legacy_receipt_keys,undefined);
    await assert.rejects(service.delivery(1,ID,{...expected,sha256:'b'.repeat(64)}),error=>error.status===409);
  }finally{await db.close();}
});
