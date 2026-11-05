const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderEgrnLinks, setupOrderEgrnLinks } = require('../src/web/order-egrn-links');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

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
