const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { prepareMaterials, normalizeManagerOrder, normalizeArchive, zipParts, createMaterialsStore } = require('../src/web/order-materials');

const base = () => ({ address: 'Москва, улица 1', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: 'Получение', submit_id: 'request-1', contacts: 'Контакт', zones_info: 'Проверить окружение', cad_num: '77:01:0000001:12' });
const original = (name = 'план.png', text = '123456789') => ({ originalname: name, mimetype: 'image/png', buffer: Buffer.from(text) });

test('manager packet requires service and object-specific renewal archive, not auditor guesses', () => {
  assert.throws(() => normalizeManagerOrder({ ...base(), service: '' }, []), /Менеджеру нужно выбрать услугу/);
  assert.throws(() => normalizeManagerOrder({ ...base(), service: 'Продление' }, []), /добавьте ссылку/);
  assert.throws(() => normalizeArchive('https://disk.360.yandex.ru/d/RPoUCOS6PFusPQ'), /общий архив/);
  assert.throws(() => normalizeArchive('https://unrelated.example/d/archive'), /Яндекс/);
  const renewal = normalizeManagerOrder({ ...base(), service: 'Продление', archive_url: 'https://disk.yandex.ru/d/object-specific' }, []);
  assert.equal(renewal.archive_url, 'https://disk.yandex.ru/d/object-specific');
  const files = prepareMaterials([original('Архив.png')], ['archive']);
  assert.doesNotThrow(() => normalizeManagerOrder({ ...base(), service: 'Продление' }, files));
  const acquisition = normalizeManagerOrder({ ...base(), archive_url: 'stale-irrelevant-url' }, []);
  assert.equal(acquisition.archive_url, '');
  assert.equal(acquisition.cad_num, base().cad_num);
});

test('request original files retain bytes, deterministic ids and explicit roles', () => {
  const first = prepareMaterials([original(), original('выписка.pdf')], ['plan', 'egrn']);
  const retry = prepareMaterials([original(), original('выписка.pdf')], ['plan', 'egrn']);
  assert.equal(first[0].buffer.toString(), '123456789');
  assert.equal(first[0].id, retry[0].id);
  assert.equal(first[1].role, 'egrn');
  assert.throws(() => prepareMaterials([original()], ['unexpected']), /назначение/);
  assert.throws(() => prepareMaterials([{ ...original(), buffer: Buffer.alloc(12 * 1024 * 1024 + 1) }]), /12 МБ/);
  assert.equal(normalizeManagerOrder(base(), first).request_signature, normalizeManagerOrder(base(), retry).request_signature);
  assert.notEqual(normalizeManagerOrder(base(), first).request_signature, normalizeManagerOrder({ ...base(), address: 'Другой адрес' }, first).request_signature);
  const office = prepareMaterials([{ originalname: 'Договор.docx', mimetype: 'application/octet-stream', buffer: Buffer.from('WORD_ORIGINAL') }, { originalname: 'Архив.zip', mimetype: 'application/x-zip-compressed', buffer: Buffer.from('ZIP_ORIGINAL') }]);
  assert.equal(office[0].mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(office[1].mime, 'application/zip');
  assert.equal(office[1].role, 'archive');
});

test('download-all ZIP preserves UTF-8 filenames and original file contents', () => {
  const files = prepareMaterials([original('архив.png'), original('план.png', 'original second')]);
  const zip = Buffer.concat([...zipParts(files)]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(6), 0x800);
  assert.equal(zip.readUInt16LE(8), 0); // stored, no alteration of source bytes
  assert.equal(zip.readUInt32LE(14), 0xcbf43926); // standard CRC32 test vector
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString('utf8'), '01-архив.png');
  assert.equal(zip.subarray(30 + nameLength, 30 + nameLength + 9).toString(), '123456789');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);
});

async function database(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite(); let tail = Promise.resolve();
  const query = (sql, params) => params ? db.query(sql, params) : db.exec(sql);
  const pool = { query, async connect() { let release; const next = new Promise(resolve => release = resolve); const previous = tail; tail = next; await previous; return { query, release }; } };
  try {
    await db.exec('CREATE TABLE orders(id SERIAL PRIMARY KEY,created_at TIMESTAMPTZ DEFAULT NOW(),address TEXT,owner_name TEXT,object_type TEXT,object_name TEXT,has_video BOOLEAN,zones_info TEXT,deadline DATE,contacts TEXT,submitted_by BIGINT); INSERT INTO orders(id,submitted_by) VALUES(58,108),(59,109);');
    await run(createMaterialsStore(pool), db, pool);
  } finally { await db.close(); }
}

test('persisted request packet survives retry, isolates order ids and supplies inherited metadata', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async (store, db) => {
  const prepared = prepareMaterials([original(), original('архив.png')], ['plan', 'archive']);
  await store.save(58, prepared); await store.save(58, prepared);
  const files = await store.list(58);
  assert.equal(files.length, 2);
  assert.equal(Object.hasOwn(files[0], 'buffer'), false);
  assert.ok(files.every(f => f.url.startsWith('/api/audit/orders/58/materials/')));
  assert.equal((await store.list(58, true, 'archive')).length, 1);
  assert.equal((await store.download(58, prepared[0].id)).buffer.toString(), '123456789');
  await assert.rejects(store.download(59, prepared[0].id), /не найден/);
  await store.delivered(58, prepared[0].id, 100);
  assert.equal(Number((await store.list(58)).find(f => f.id === prepared[0].id).telegram_msg_id), 100);
  assert.equal((await db.query('SELECT COUNT(*) AS count FROM order_materials')).rows[0].count, 2);
}));

test('same manager submission returns same order; changed payload cannot overwrite it', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async (store, db, pool) => {
  const context = { module: { exports: {} }, require(name) {
    if (name === './pool') return pool;
    if (name === '../web/order-materials') return { ensureOrderMaterials: store.ensure };
    throw new Error('Unexpected require: ' + name);
  } };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/db/queries.js'), 'utf8'), context);
  const payload = { ...normalizeManagerOrder(base(), []), submitted_by: 108 };
  const a = await context.module.exports.createOrder(payload);
  const b = await context.module.exports.createOrder(payload);
  assert.equal(a.id, b.id);
  assert.equal(a.service, 'Получение'); assert.equal(a.cad_num, base().cad_num);
  await assert.rejects(context.module.exports.createOrder({ ...payload, request_signature: 'different' }), /с другими данными/);
  const updated = await context.module.exports.updateOrderPacket(a.id, { ...payload, address: 'Москва, новый адрес', service: 'Продление', archive_url: 'https://disk.yandex.ru/d/object' });
  assert.equal(updated.id, a.id); assert.equal(updated.submitted_by, a.submitted_by);
  assert.equal(updated.request_submit_id, a.request_submit_id); assert.equal(updated.request_signature, a.request_signature);
  assert.equal(updated.address, 'Москва, новый адрес'); assert.equal(updated.service, 'Продление');
  const lateCreateRetry = await context.module.exports.createOrder(payload);
  assert.equal(lateCreateRetry.id, a.id); assert.equal(lateCreateRetry.address, updated.address);
}));

test('auditor prefill inherits manager service, archive, task, cadastral id and files', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/web/index.js'), 'utf8');
  const route = source.slice(source.indexOf("  app.get('/api/audit/prefill'"), source.indexOf("  app.post('/api/audit'"));
  let handler;
  const order = { id: 58, owner_name: 'Клиент', address: 'Москва, адрес', object_type: 'Розничная торговля', service: 'Продление', cad_num: '77:01:1:12', archive_url: 'https://disk.yandex.ru/d/object', zones_info: 'Проверить соседа', contacts: 'Контакт', has_video: true };
  const materials = [{ id: 'file', name: 'план.pdf', role: 'plan' }];
  const context = { app: { get(url, fn) { handler = fn; } }, Number, String, console, getOrderById: async () => order, require(name) { assert.equal(name, './order-materials'); return { ensureOrderMaterials: async () => {}, listOrderMaterials: async () => materials }; } };
  vm.createContext(context); vm.runInContext(route, context);
  let result; await handler({ query: { order_id: 58 }, staff: { role: 'manager' }, tgUser: { id: 108 } }, { json(data) { result = data; }, status() { return this; } });
  assert.equal(result.object_category, 'retail'); assert.equal(result.service, 'Продление');
  assert.equal(result.cad_num, order.cad_num); assert.equal(result.zones_info, order.zones_info); assert.equal(result.archive_url, order.archive_url);
  assert.equal(result.video_required, true); assert.equal(result.materials, materials);
  assert.equal(result.materials_download_url, '/api/audit/orders/58/materials/download-all');
  assert.equal(result.can_edit_packet, true);
});
