const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { MAX_BYTES, createEgrnFileStore } = require('../src/bot/egrn-files');

const MiB = 1024 * 1024;
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
function pdf(bytes = 48) { const buffer = Buffer.alloc(bytes, 0x61); buffer.write('%PDF-1.7\n'); return buffer; }
function zip() { const buffer = Buffer.alloc(32); buffer.writeUInt32LE(0x04034b50); return buffer; }
const input = (buffer = pdf(), extra = {}) => ({ egrn_order_id: 1, source_key: 'embedded:0:ЕГРН.pdf', name: 'Выписка ЕГРН.pdf', buffer, ...extra });
async function read(store, id) {
  const hash = createHash('sha256'); let bytes = 0, count = 0;
  for await (const chunk of store.chunks(id)) { assert.ok(Buffer.isBuffer(chunk)); assert.ok(chunk.length <= MiB); hash.update(chunk); bytes += chunk.length; count++; }
  return { bytes, count, sha256: hash.digest('hex') };
}

// A transactional in-memory SQL fixture for the large-file boundary. PostgreSQL
// syntax, actual BYTEA, constraints and rollback are additionally tested below.
function memoryPool(options = {}) {
  let files = new Map(), chunks = new Map(), lock = Promise.resolve(), released = 0;
  const calls = [];
  function cloneChunks(value) { return new Map([...value].map(([id, entries]) => [id, new Map(entries)])); }
  async function query(sql, params = [], state = { files, chunks }) {
    calls.push({ sql, chunk: sql.startsWith('INSERT INTO egrn_file_chunks') ? params[1] : undefined,
      bytes: sql.startsWith('INSERT INTO egrn_file_chunks') ? params[2].length : undefined });
    if (sql.includes('CREATE TABLE') || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('INSERT INTO egrn_files(')) {
      if (state.files.has(params[0])) return { rows: [] };
      const [id, egrn_order_id, source_key, name, mime, bytes, sha256] = params;
      const row = { id, egrn_order_id, source_key, name, mime, bytes, sha256 };
      state.files.set(id, row); return { rows: [{ ...row }] };
    }
    if (sql.startsWith('INSERT INTO egrn_file_chunks')) {
      if (!state.chunks.has(params[0])) state.chunks.set(params[0], new Map());
      state.chunks.get(params[0]).set(params[1], options.retain === false ? { bytes: params[2].length } : Buffer.from(params[2]));
      if (options.onChunk) await options.onChunk(params);
      return { rows: [] };
    }
    if (sql.includes(' FROM egrn_files WHERE id=')) return { rows: state.files.has(params[0]) ? [{ ...state.files.get(params[0]) }] : [] };
    if (sql.includes(' FROM egrn_files WHERE egrn_order_id=')) return { rows: [...state.files.values()].filter(row => row.egrn_order_id === params[0]).map(row => ({ ...row })) };
    const parts = state.chunks.get(params[0]) || new Map();
    if (sql.startsWith('SELECT content FROM egrn_file_chunks')) return { rows: parts.has(params[1]) ? [{ content: parts.get(params[1]) }] : [] };
    if (sql.startsWith('SELECT chunk_no FROM egrn_file_chunks')) return { rows: [...parts.keys()].filter(n => n >= params[1]).map(chunk_no => ({ chunk_no })).slice(0, 1) };
    throw new Error('Unexpected SQL fixture request: ' + sql);
  }
  return {
    calls, get released() { return released; }, query: (sql, params) => query(sql, params),
    async connect() {
      const previous = lock; let unlock;
      lock = new Promise(resolve => { unlock = resolve; }); await previous;
      let state, done = false;
      return { async query(sql, params) {
        if (sql === 'BEGIN') { state = { files: new Map(files), chunks: cloneChunks(chunks) }; return { rows: [] }; }
        if (sql === 'COMMIT') { files = state.files; chunks = state.chunks; state = null; return { rows: [] }; }
        if (sql === 'ROLLBACK') { state = null; return { rows: [] }; }
        return query(sql, params, state || { files, chunks });
      }, release() { if (!done) { done = true; released++; unlock(); } } };
    }
  };
}

test('invalid order, source credentials, empty/non-document and oversized files never touch PostgreSQL', async () => {
  const pool = memoryPool(), store = createEgrnFileStore(pool);
  assert.equal(MAX_BYTES, 2 * 1024 * MiB - 1);
  for (const request of [input(pdf(), { egrn_order_id: 0 }), input(pdf(), { egrn_order_id: '1e2' }), input(pdf(), { source_key: 'https://files.example/result?token=secret' }), input(pdf(), { source_key: 'token:secret' }), input(pdf(), { source_key: '' }), input(Buffer.alloc(0)), input(Buffer.from('<html>error</html>'))]) {
    await assert.rejects(store.save(request), failure => [400, 415].includes(failure.status));
  }
  await assert.rejects(store.saveStream({ ...input(), bytes: MAX_BYTES + 1, sha256: digest(pdf()), open: async function* () { throw new Error('must not open'); } }), failure => failure.status === 413 && failure.code === 'EGRN_FILE_TOO_LARGE');
  assert.equal(pool.calls.length, 0);
  assert.equal(await store.get('not-a-uuid'), null);
});

test('safe Unicode basenames and actual magic determine downloadable metadata', async () => {
  const pool = memoryPool(), store = createEgrnFileStore(pool);
  const saved = await store.save(input(pdf(), { name: '../../раздел\\Акт\u0000\r\n\u202e оценки.zip' }));
  assert.equal(saved.name, 'Акт оценки.pdf');
  assert.equal(saved.mime, 'application/pdf');
  assert.deepEqual(Object.keys(saved).sort(), ['id', 'name', 'mime', 'bytes', 'sha256', 'egrn_order_id', 'source_key'].sort());
  const zipped = await store.save(input(zip(), { source_key: 'url:0', name: 'https://files.example/Документы.zip?token=secret' }));
  assert.equal(zipped.name, 'Документы.zip');
  assert.equal(zipped.mime, 'application/zip');
  assert.equal(JSON.stringify(zipped).includes('secret'), false);
  assert.equal(JSON.stringify(zipped).includes('https://'), false);
});

test('parallel duplicate saves are stable, preserve the first name and do not duplicate chunks', async () => {
  const pool = memoryPool(), store = createEgrnFileStore(pool), buffer = pdf(2 * MiB + 9);
  const [first, again] = await Promise.all([store.save(input(buffer)), store.save(input(buffer, { name: 'Переименовано.pdf' }))]);
  assert.equal(first.id, again.id);
  assert.equal(again.name, first.name);
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(pool.calls.filter(call => call.sql.startsWith('INSERT INTO egrn_file_chunks')).length, 3);
  const otherSource = await store.save(input(buffer, { source_key: 'url:1' }));
  const otherOrder = await store.save(input(buffer, { egrn_order_id: 2 }));
  const different = await store.save(input(pdf(40)));
  assert.equal(new Set([first.id, otherSource.id, otherOrder.id, different.id]).size, 4);
  assert.equal((await store.listByOrder(1)).length, 3);
  assert.equal((await store.listByOrder(2)).length, 1);
  assert.equal((await store.listByOrder(3)).length, 0);
});

test('100 MiB is saved in 1 MiB chunks and streamed with the exact original SHA-256', async () => {
  const pool = memoryPool(), store = createEgrnFileStore(pool), buffer = pdf(100 * MiB);
  const expected = digest(buffer), saved = await store.save(input(buffer));
  assert.equal(saved.bytes, 100 * MiB);
  assert.equal(saved.sha256, expected);
  // Reading never depends on the caller retaining or leaving its buffer untouched.
  buffer.fill(0);
  assert.deepEqual(await read(store, saved.id), { bytes: 100 * MiB, count: 100, sha256: expected });
  assert.equal(pool.calls.filter(call => call.sql.startsWith('INSERT INTO egrn_file_chunks')).length, 100);
  assert.equal(pool.calls.filter(call => call.sql.startsWith('SELECT content FROM egrn_file_chunks')).length, 100);
});

test('unknown files cannot stream an empty successful download', async () => {
  const store = createEgrnFileStore(memoryPool());
  for (const id of ['not-an-id', '00000000-0000-5000-8000-000000000000']) {
    await assert.rejects(read(store, id), failure => failure.status === 404 && failure.code === 'EGRN_FILE_NOT_FOUND');
  }
});

test('saveStream joins tiny fragments, splits oversized chunks and deduplicates without opening its source', async () => {
  const pool = memoryPool(), store = createEgrnFileStore(pool), buffer = pdf(2 * MiB + 17);
  const details = { egrn_order_id: 1, source_key: 'stream:0', name: 'Поток.pdf', bytes: buffer.length, sha256: digest(buffer) };
  let opened = 0, closed = 0;
  const saved = await store.saveStream({ ...details, open: async function* () {
    opened++;
    try { yield buffer.subarray(0, 1); yield buffer.subarray(1, 4); yield buffer.subarray(4); }
    finally { closed++; }
  } });
  assert.equal(opened, 1); assert.equal(closed, 1);
  assert.deepEqual(await read(store, saved.id), { bytes: buffer.length, count: 3, sha256: details.sha256 });
  assert.deepEqual(pool.calls.filter(call => call.chunk !== undefined).map(call => call.bytes), [MiB, MiB, 17]);
  const duplicate = await store.saveStream({ ...details, name: 'Другое имя.pdf', open() { opened++; throw new Error('A duplicate must not reopen the original.'); } });
  assert.deepEqual(duplicate, saved);
  assert.equal(opened, 1);
  assert.equal(pool.calls.filter(call => call.chunk !== undefined).length, 3);
  assert.equal((await store.save(input(buffer, { source_key: details.source_key }))).id, saved.id);
});

test('a stream over 200 MiB is persisted with bounded chunks without constructing a full file Buffer', async () => {
  const pool = memoryPool({ retain: false }), store = createEgrnFileStore(pool);
  const slab = pdf(3 * MiB + 47), tail = Buffer.alloc(19, 0x62), repeat = 67;
  const hash = createHash('sha256'); for (let index = 0; index < repeat; index++) hash.update(slab); hash.update(tail);
  const bytes = slab.length * repeat + tail.length, sha256 = hash.digest('hex');
  let opened = 0, closed = 0;
  const saved = await store.saveStream({ egrn_order_id: 1, source_key: 'large-stream', name: 'Большая выписка.pdf', bytes, sha256,
    open: async function* () {
      opened++;
      try { for (let index = 0; index < repeat; index++) yield slab; yield tail; }
      finally { closed++; }
    } });
  assert.ok(bytes > 200 * MiB);
  assert.equal(saved.bytes, bytes); assert.equal(saved.sha256, sha256);
  assert.equal(opened, 1); assert.equal(closed, 1);
  const inserts = pool.calls.filter(call => call.chunk !== undefined);
  assert.equal(inserts.length, Math.ceil(bytes / MiB));
  assert.equal(inserts.reduce((sum, call) => sum + call.bytes, 0), bytes);
  assert.ok(inserts.every(call => call.bytes <= MiB));
});

test('short, extra, wrong-hash, invalid-magic and failing streams roll back metadata and partial chunks', async () => {
  const buffer = pdf(MiB + 30);
  for (const [mode, expected] of [['short', 'EGRN_FILE_SIZE'], ['extra', 'EGRN_FILE_SIZE'], ['hash', 'EGRN_FILE_CHANGED'], ['type', 'EGRN_FILE_TYPE'], ['failure', undefined]]) {
    const pool = memoryPool(), store = createEgrnFileStore(pool); let closed = false;
    const source = mode === 'type' ? Buffer.alloc(buffer.length, 0x78) : buffer;
    const bytes = source.length + (mode === 'short' ? 1 : mode === 'extra' ? -1 : 0);
    await assert.rejects(store.saveStream({ egrn_order_id: 1, source_key: mode, name: 'Выписка.pdf', bytes,
      sha256: mode === 'hash' ? '0'.repeat(64) : digest(source),
      chunks: (async function* () {
        try { yield source.subarray(0, MiB); if (mode === 'failure') throw new Error('injected source failure'); yield source.subarray(MiB); }
        finally { closed = true; }
      })()
    }), failure => expected ? failure.code === expected : /injected source failure/.test(failure.message));
    assert.equal(closed, true, mode);
    assert.deepEqual(await store.listByOrder(1), [], mode);
  }
});

test('cancellation while awaiting the source closes it and rolls back the active transaction', { timeout: 2000 }, async () => {
  const pool = memoryPool(), store = createEgrnFileStore(pool), controller = new AbortController();
  const buffer = pdf(MiB + 30); let reads = 0, closed = false;
  const chunks = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      reads++;
      if (reads === 1) return Promise.resolve({ value: buffer.subarray(0, MiB), done: false });
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    },
    return() { closed = true; return Promise.resolve({ done: true }); }
  };
  await assert.rejects(store.saveStream({ egrn_order_id: 1, source_key: 'cancel', name: 'Выписка.pdf',
    bytes: buffer.length, sha256: digest(buffer), chunks, signal: controller.signal }), failure => failure.code === 'EGRN_FILE_CANCELLED');
  assert.equal(closed, true);
  assert.deepEqual(await store.listByOrder(1), []);
});

test('cancellation does not wait for an asynchronous opener and cleans up a late source', { timeout: 2000 }, async () => {
  const store = createEgrnFileStore(memoryPool()), controller = new AbortController();
  let finishOpen, started, closed = false;
  const opening = new Promise(resolve => { finishOpen = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  const saving = store.saveStream({ egrn_order_id: 1, source_key: 'cancel-open', name: 'Выписка.pdf',
    bytes: 48, sha256: digest(pdf()), signal: controller.signal, open() { started(); return opening; } });
  await begun; controller.abort();
  await assert.rejects(saving, failure => failure.code === 'EGRN_FILE_CANCELLED');
  finishOpen({ [Symbol.asyncIterator]() { return { return() { closed = true; return Promise.resolve({ done: true }); } }; } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, true);
  assert.deepEqual(await store.listByOrder(1), []);
});

test('PostgreSQL schema, BYTEA copies, streaming, rollback and restart persistence', { skip: !process.env.PGLITE_TEST_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite(); let tail = Promise.resolve();
  // PGlite has one connection; give transactions an exclusive connection lease.
  const pool = { async connect() {
    const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
    return { query: (sql, params) => params ? db.query(sql, params) : db.exec(sql), release };
  }, async query(sql, params) {
    const client = await pool.connect();
    try { return await client.query(sql, params); } finally { client.release(); }
  } };
  const store = createEgrnFileStore(pool);
  try {
    await store.ensure(); await store.ensure();
    const buffer = pdf(2 * MiB + 17), expected = digest(buffer);
    const saved = await store.save(input(buffer));
    assert.deepEqual(await read(store, saved.id), { bytes: buffer.length, count: 3, sha256: expected });
    const firstYield = await store.chunks(saved.id).next(); firstYield.value.fill(0);
    assert.equal((await read(store, saved.id)).sha256, expected, 'Returned Buffers must not alias durable BYTEA.');
    const again = await store.save(input(buffer, { name: 'Другое имя.pdf' }));
    assert.deepEqual(again, saved);
    const restarted = createEgrnFileStore(pool);
    assert.deepEqual(await restarted.get(saved.id), saved);
    assert.equal((await restarted.listByOrder(1)).length, 1);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_file_chunks', [])).rows[0].count), 3);

    // Upgrade the deployed 200 MiB named constraint without replacing its files.
    await pool.query('ALTER TABLE egrn_files DROP CONSTRAINT egrn_files_bytes_check; ALTER TABLE egrn_files ADD CONSTRAINT egrn_files_bytes_check CHECK(bytes BETWEEN 1 AND 209715200)');
    await createEgrnFileStore(pool).ensure(); await createEgrnFileStore(pool).ensure();
    assert.deepEqual(await restarted.get(saved.id), saved);
    assert.equal((await read(restarted, saved.id)).sha256, expected);
    const definition = (await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='egrn_files_bytes_check'", [])).rows[0].definition;
    assert.ok(definition.includes(String(MAX_BYTES)));
    const migrationClient = await pool.connect();
    try {
      await migrationClient.query('BEGIN');
      await migrationClient.query('INSERT INTO egrn_files(id,egrn_order_id,source_key,name,mime,bytes,sha256) VALUES($1,1,$2,$3,$4,$5,$6)',
        ['00000000-0000-5000-8000-000000000001', 'migration-proof', 'Выписка.pdf', 'application/pdf', MAX_BYTES, expected]);
      await migrationClient.query('ROLLBACK');
    } finally { migrationClient.release(); }

    // PostgreSQL must roll back both metadata and the already-written first chunk.
    const failPool = { ...pool, async connect() {
      const client = await pool.connect();
      return { release: client.release, async query(sql, params) {
        if (sql.startsWith('INSERT INTO egrn_file_chunks') && params[1] === 1) throw new Error('injected storage failure');
        return client.query(sql, params);
      } };
    } };
    await assert.rejects(createEgrnFileStore(failPool).save(input(buffer, { source_key: 'rollback' })), /injected storage failure/);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_files', [])).rows[0].count), 1);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_file_chunks', [])).rows[0].count), 3);
    const retried = await store.save(input(buffer, { source_key: 'rollback' }));
    assert.equal((await read(store, retried.id)).sha256, expected);

    // Mutation across an await cannot produce a committed file with the wrong hash.
    const changing = pdf(MiB + 30);
    const mutatePool = { ...pool, async connect() {
      const client = await pool.connect();
      return { release: client.release, async query(sql, params) {
        const result = await client.query(sql, params);
        if (sql.startsWith('INSERT INTO egrn_file_chunks') && params[1] === 0) changing[MiB + 1] ^= 1;
        return result;
      } };
    } };
    await assert.rejects(createEgrnFileStore(mutatePool).save(input(changing, { source_key: 'changing' })), failure => failure.code === 'EGRN_FILE_CHANGED');
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_files', [])).rows[0].count), 2);

    await pool.query('DELETE FROM egrn_file_chunks WHERE file_id=$1 AND chunk_no=1', [saved.id]);
    await assert.rejects(read(store, saved.id), failure => failure.code === 'EGRN_FILE_INCOMPLETE');
    await pool.query('INSERT INTO egrn_file_chunks(file_id,chunk_no,content) VALUES($1,1,$2)', [saved.id, buffer.subarray(MiB, 2 * MiB)]);
    const tampered = Buffer.from(buffer.subarray(0, MiB)); tampered[50] ^= 1;
    await pool.query('UPDATE egrn_file_chunks SET content=$1 WHERE file_id=$2 AND chunk_no=0', [tampered, saved.id]);
    await assert.rejects(read(store, saved.id), failure => failure.code === 'EGRN_FILE_CORRUPT');
    await assert.rejects(pool.query('INSERT INTO egrn_file_chunks(file_id,chunk_no,content) VALUES($1,0,$2)', ['00000000-0000-5000-8000-000000000000', Buffer.from('x')]), /foreign key/i);
    await assert.rejects(pool.query('INSERT INTO egrn_file_chunks(file_id,chunk_no,content) VALUES($1,100,$2)', [saved.id, Buffer.alloc(MiB + 1)]), /check constraint/i);
  } finally { await db.close(); }
});
