const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDraftStore, prepareEvidence, setupAuditDrafts, validateData } = require('../src/web/audit-drafts');

function file(text = 'original', changes = {}) {
  return { revision: 1, id: randomUUID(), name: 'план.png', mime: 'image/png', role: 'plan', subject_id: 'plan-main', data: Buffer.from(text).toString('base64'), ...changes };
}
function error(status, code) { return e => e.status === status && e.code === code; }

test('draft metadata rejects inline files and oversized or malformed data', () => {
  assert.deepEqual(validateData({ workflow: { step: 2, entrances: [{ id: 'door-1', evidence: [randomUUID()] }] } }).workflow.step, 2);
  assert.throws(() => validateData({ image: 'data:image/png;base64,YQ==' }), error(400, 'INLINE_FILE'));
  assert.throws(() => validateData({ original: { base64: 'YQ==' } }), error(400, 'INLINE_FILE'));
  assert.throws(() => validateData({ data: 'x'.repeat(40) }, { metadataBytes: 20 }), error(413, 'DRAFT_TOO_LARGE'));
  assert.throws(() => validateData([]), error(400, 'INVALID_DATA'));
});

test('evidence preserves original bytes and rejects unsupported files or broken base64', () => {
  const source = file('bytes-without-resizing', { name: '../план\r\n.png' });
  const prepared = prepareEvidence(source);
  assert.equal(prepared.content.toString(), 'bytes-without-resizing');
  assert.equal(prepared.name, 'план.png');
  assert.equal(prepared.bytes, Buffer.byteLength('bytes-without-resizing'));
  assert.throws(() => prepareEvidence(file('a', { mime: 'image/svg+xml' })), error(400, 'UNSUPPORTED_FILE'));
  assert.throws(() => prepareEvidence(file('a', { data: '%%%invalid' })), error(400, 'INVALID_FILE'));
  assert.throws(() => prepareEvidence(file('12345'), { fileBytes: 4 }), error(413, 'FILE_TOO_LARGE'));
});

test('a full-size phone image is validated without overflowing the regular-expression stack', () => {
  const original = Buffer.alloc(6 * 1024 * 1024, 123);
  const prepared = prepareEvidence(file('', { data: original.toString('base64'), name: 'phone.jpg', mime: 'image/jpeg' }));
  assert.equal(prepared.bytes, original.length);
  assert.ok(prepared.content.equals(original));
});

test('delivery lock checks owner, canonicalizes UUID, excludes another sender and releases after errors', async () => {
  const id = randomUUID(), queries = [], released = [];
  let acquired = true, failUnlock = false;
  const pool = { async connect() { return {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT * FROM audit_drafts')) return { rows: params[1] === '108' ? [{ id }] : [] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: acquired }] };
      if (sql.includes('pg_advisory_unlock') && failUnlock) throw new Error('connection lost');
      return { rows: [] };
    },
    release(e) { released.push(e); },
  }; } };
  const store = createDraftStore(pool);
  let calls = 0;
  await store.withDraftDeliveryLock(108, id.toUpperCase(), async () => { calls++; });
  assert.equal(calls, 1);
  assert.equal(queries.find(q => q.sql.includes('pg_try_advisory_lock')).params[0], id);
  assert.ok(queries.some(q => q.sql.includes('pg_advisory_unlock')));
  await assert.rejects(store.withDraftDeliveryLock(109, id, async () => { calls++; }), error(404, 'NOT_FOUND'));
  acquired = false;
  await assert.rejects(store.withDraftDeliveryLock(108, id, async () => { calls++; }), error(409, 'DELIVERY_BUSY'));
  assert.equal(calls, 1);
  acquired = true;
  await assert.rejects(store.withDraftDeliveryLock(108, id, async () => { throw new Error('delivery failed'); }), /delivery failed/);
  assert.ok(queries.at(-1).sql.includes('pg_advisory_unlock'));
  failUnlock = true;
  await store.withDraftDeliveryLock(108, id, async () => {});
  assert.match(released.at(-1).message, /connection lost/); // The pool discards a possibly still-locked session.
});

async function database(run, limits) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
  const db = new PGlite();
  // One isolated transaction lease at a time, matching a pool with one PostgreSQL connection.
  let tail = Promise.resolve();
  const query = (sql, params) => params ? db.query(sql, params) : db.exec(sql);
  const pool = { query, async connect() {
    let unlock;
    const next = new Promise(resolve => { unlock = resolve; });
    const previous = tail; tail = next;
    await previous;
    return { query, release: unlock };
  } };
  try {
    await db.exec('CREATE TABLE orders(id INT PRIMARY KEY, object_name TEXT, owner_name TEXT, address TEXT); INSERT INTO orders(id) VALUES(58),(59);');
    await run(createDraftStore(pool, limits), db, pool);
  } finally { await db.close(); }
}

test('open draft route uses authenticated identity, ignores requested owner, and disables caching', async () => {
  let route, response;
  const app = {
    get(path, handler) { if (path === '/api/audit/drafts/open') route = handler; },
    post() {}, put() {}, delete() {},
  };
  setupAuditDrafts(app, { async listOpen(owner) { assert.equal(owner, 108); return [{ order_id: 58 }]; } });
  await route({ tgUser: { id: 108 }, query: { owner: 999 } }, {
    set(name, value) { assert.equal(name, 'Cache-Control'); assert.equal(value, 'no-store'); },
    json(value) { response = value; },
  });
  assert.deepEqual(response, { ok: true, drafts: [{ order_id: 58 }] });
});

test('open draft list returns only owned unfinished linked orders, most recent first, at most 50', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async (store, db) => {
  await db.exec(`
    UPDATE orders SET object_name='Объект', owner_name='Клиент', address='Адрес' WHERE id=58;
    UPDATE orders SET object_name='   ', owner_name='Другой объект' WHERE id=59;
    INSERT INTO orders(id) SELECT generate_series(60, 114);
  `);
  await store.create(108, 58, { private: 'Hidden field' });
  await store.create(108, 59);
  await store.create(109, 59);
  await store.create(108, null);
  const submitted = await store.create(108, 60);
  const orphaned = await store.create(108, 61);
  await db.query('DELETE FROM orders WHERE id=61');
  await db.query('UPDATE audit_drafts SET submitted_at=NOW() WHERE id=$1', [submitted.id]);
  await db.query("UPDATE audit_drafts SET updated_at='2026-11-02 09:30:00Z' WHERE author_tg_id=108");
  await db.query("UPDATE audit_drafts SET updated_at='2026-11-02 10:30:00Z', submitting_revision=1 WHERE author_tg_id=108 AND order_id=59");
  await db.query("UPDATE audit_drafts SET updated_at='2026-11-02 12:30:00Z' WHERE id=$1", [orphaned.id]);
  const list = await store.listOpen(108);
  assert.deepEqual(list.map(row => ({ ...row, updated_at: new Date(row.updated_at).toISOString() })), [
    { order_id: 59, object_name: 'Другой объект', address: '', updated_at: '2026-11-02T10:30:00.000Z', submitting: true },
    { order_id: 58, object_name: 'Объект', address: 'Адрес', updated_at: '2026-11-02T09:30:00.000Z', submitting: false },
  ]);
  assert.deepEqual((await store.listOpen(109)).map(row => row.order_id), [59]);
  assert.deepEqual(await store.listOpen(110), []);
  await db.query("INSERT INTO audit_drafts(id,author_tg_id,order_id,updated_at) SELECT gen_random_uuid(),108,id,'2026-11-01 10:30:00Z' FROM orders WHERE id>=62");
  const capped = await store.listOpen(108);
  assert.equal(capped.length, 50);
  assert.deepEqual(capped.slice(0, 3).map(row => row.order_id), [59, 58, 114]);
}));

test('drafts isolate authors, preserve current draft on retry, and reject stale saves', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async store => {
  const a = await store.create(108, 58, { org: 'A', workflow: { step: 1 } });
  const same = await store.create(108, 58, { org: 'must not overwrite' });
  const b = await store.create(109, 58, { org: 'B' });
  assert.equal(same.id, a.id);
  assert.equal(same.data.org, 'A');
  assert.notEqual(a.id, b.id);
  assert.equal((await store.current(108, 58)).id, a.id);
  assert.equal(await store.current(108, 59), null);
  await assert.rejects(store.update(109, a.id, a.revision, { org: 'stolen' }), error(404, 'NOT_FOUND'));
  const results = await Promise.allSettled([
    store.update(108, a.id, a.revision, { org: 'first' }),
    store.update(108, a.id, a.revision, { org: 'second' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal((await store.current(108, 58)).revision, 2);
  assert.equal((await store.current(109, 58)).data.org, 'B');
  await assert.rejects(store.create(108, 999, {}), error(404, 'ORDER_NOT_FOUND'));
}));

test('evidence retries are idempotent, downloads are scoped, and removals retain recoverable originals', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async (store, db) => {
  const draft = await store.create(108, 58);
  const source = file('original bytes');
  const added = await store.addEvidence(108, draft.id, source);
  const retry = await store.addEvidence(108, draft.id, source);
  assert.equal(added.revision, 2);
  assert.equal(retry.revision, 2);
  assert.equal((await store.current(108, 58)).evidence.length, 1);
  const downloaded = await store.downloadEvidence(108, draft.id, source.id);
  assert.equal(downloaded.buffer.toString(), 'original bytes');
  assert.equal(Object.hasOwn((await store.current(108, 58)).evidence[0], 'buffer'), false);
  await assert.rejects(store.downloadEvidence(109, draft.id, source.id), error(404, 'NOT_FOUND'));
  await assert.rejects(store.addEvidence(108, draft.id, { ...source, name: 'other.png' }), error(409, 'FILE_CONFLICT'));
  await assert.rejects(store.addEvidence(108, draft.id, { ...source, data: Buffer.from('changed').toString('base64') }), error(409, 'FILE_CONFLICT'));
  assert.equal((await store.removeEvidence(108, draft.id, source.id, 2)).revision, 3);
  assert.equal((await store.current(108, 58)).evidence.length, 0);
  await assert.rejects(store.downloadEvidence(108, draft.id, source.id), error(404, 'NOT_FOUND'));
  const stored = await db.query('SELECT content,deleted_at FROM audit_evidence WHERE draft_id=$1 AND id=$2', [draft.id, source.id]);
  assert.equal(Buffer.from(stored.rows[0].content).toString(), 'original bytes');
  assert.ok(stored.rows[0].deleted_at);
  assert.equal((await store.addEvidence(108, draft.id, { ...source, revision: 3 })).revision, 4);
  assert.equal((await store.current(108, 58)).evidence.length, 1);
}));

test('evidence aggregate limits cannot be bypassed by recoverable removals', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async store => {
  const draft = await store.create(108, 58);
  const first = file('123456789');
  await store.addEvidence(108, draft.id, first);
  await assert.rejects(store.addEvidence(108, draft.id, file('1234567890', { revision: 2 })), error(413, 'EVIDENCE_LIMIT'));
  await store.addEvidence(108, draft.id, file('123456789', { revision: 2 }));
  await store.removeEvidence(108, draft.id, first.id, 3);
  await assert.rejects(store.addEvidence(108, draft.id, file('a', { revision: 4 })), error(413, 'EVIDENCE_LIMIT'));
}, { fileBytes: 12, totalBytes: 18, files: 2 }));

test('submission freezes a revision, resumes durable delivery after restart, and closes idempotently', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async (store, db, pool) => {
  const draft = await store.create(108, 58, { workflow: { conclusion: 'Нужна проверка зоны' } });
  const source = file();
  await store.addEvidence(108, draft.id, source);
  await assert.rejects(store.loadDraftForSubmit(108, draft.id, 1), error(409, 'REVISION_CONFLICT'));
  const snapshot = await store.loadDraftForSubmit(108, draft.id, 2);
  assert.equal(snapshot.submitting, true);
  assert.equal(snapshot.evidence[0].buffer.toString(), 'original');
  assert.equal((await store.addEvidence(108, draft.id, source)).revision, 2); // A lost file-upload response can be retried after final freeze.
  await assert.rejects(store.addEvidence(108, draft.id, file('new file')), error(409, 'SUBMITTING'));
  await assert.rejects(store.update(108, draft.id, 2, {}), error(409, 'SUBMITTING'));
  await assert.rejects(store.removeEvidence(108, draft.id, source.id, 2), error(409, 'SUBMITTING'));
  await store.releaseDraftSubmission(108, draft.id, 2); // Safe before Telegram side effects.
  await store.loadDraftForSubmit(108, draft.id, 2);
  await store.saveDraftDelivery(108, draft.id, 2, { textIds: [110, 111], documentIds: [112], saved: false });
  const restarted = createDraftStore(pool);
  assert.deepEqual(await restarted.loadDraftDelivery(108, draft.id), { textIds: [110, 111], documentIds: [112], saved: false });
  await assert.rejects(restarted.loadDraftDelivery(109, draft.id), error(404, 'NOT_FOUND'));
  await assert.rejects(restarted.releaseDraftSubmission(108, draft.id, 2), error(409, 'PARTIAL_DELIVERY'));
  await restarted.markDraftSubmitted(108, draft.id, 2);
  await restarted.markDraftSubmitted(108, draft.id, 2);
  assert.ok((await restarted.loadDraftForSubmit(108, draft.id, 2)).submitted_at);
  assert.equal(await restarted.current(108, 58), null);
  const next = await restarted.create(108, 58, { workflow: { step: 1 } });
  assert.notEqual(next.id, draft.id);
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM audit_evidence')).rows[0].count, 1);
}));

test('explicit delivery retry is owner-scoped, frozen, acknowledged and bound to exactly one unknown attempt', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async (store, db, pool) => {
  const locks = [], lockPool = { async connect() { return { async query(sql, params) {
    if (sql.includes('pg_try_advisory_lock')) { locks.push(params[0]); return { rows: [{ locked: true }] }; }
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    return db.query(sql, params);
  }, release() {} }; } };
  const retryStore = createDraftStore(pool, undefined, { lockPool });
  const draft = await store.create(108, 58, { observation: 'Frozen original' }), first = randomUUID(), next = randomUUID();
  const input = { revision: 1, cursor: first, acknowledge_duplicate_risk: true };
  await assert.rejects(retryStore.retryDraftDelivery(108, draft.id, input), error(409, 'NOT_SUBMITTING'));
  await store.loadDraftForSubmit(108, draft.id, 1);
  await store.saveDraftDelivery(108, draft.id, 1, { signature: 'unchanged', textIds: [100], photoIds: [], documentIds: [], inflight: { id: first, stage: 'photos', index: 0, count: 2 } });
  assert.deepEqual((await store.current(108, 58)).delivery_unknown, { cursor: first, stage: 'photos', count: 2 });
  await assert.rejects(retryStore.retryDraftDelivery(109, draft.id, input), error(404, 'NOT_FOUND'));
  await assert.rejects(retryStore.retryDraftDelivery(108, draft.id, { ...input, acknowledge_duplicate_risk: false }), error(400, 'DELIVERY_RETRY_CONFIRMATION_REQUIRED'));
  await assert.rejects(retryStore.retryDraftDelivery(108, draft.id, { ...input, revision: 2 }), error(409, 'REVISION_CONFLICT'));
  assert.deepEqual(await retryStore.retryDraftDelivery(108, draft.id, input), { ok: true });
  assert.deepEqual(await retryStore.retryDraftDelivery(108, draft.id, input), { ok: true, already_confirmed: true });
  const cleared = await store.loadDraftDelivery(108, draft.id);
  assert.equal(cleared.inflight, undefined); assert.equal(cleared.lastRiskRetryCursor, first); assert.deepEqual(cleared.textIds, [100]);
  assert.equal((await store.current(108, 58)).data.observation, 'Frozen original');
  await store.saveDraftDelivery(108, draft.id, 1, { ...cleared, inflight: { id: next, stage: 'photos', index: 0, count: 2 } });
  await assert.rejects(retryStore.retryDraftDelivery(108, draft.id, input), error(409, 'DELIVERY_RETRY_STALE'));
  assert.equal((await store.loadDraftDelivery(108, draft.id)).inflight.id, next, 'Repeated old HTTP cannot reset a later unknown attempt');
  assert.equal((await store.current(108, 58)).submitting, true); assert.equal(locks.length, 5);
  await store.saveDraftDelivery(108, draft.id, 1, { ...cleared, saved: true });await store.markDraftSubmitted(108, draft.id, 1);
  const finished = await store.loadDraftDelivery(108, draft.id);
  assert.deepEqual(await retryStore.retryDraftDelivery(108, draft.id, input), { ok: true, already_submitted: true }, 'A stale window must be able to discover that another window already completed the report');
  assert.deepEqual(await store.loadDraftDelivery(108, draft.id), finished, 'Late consent never edits the completed report');
}));

test('stale evidence mutations cannot bypass draft metadata concurrency and exact retries remain idempotent', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async (store) => {
  const draft = await store.create(108, 58, { conclusion: 'First' });
  const original = file('first image');
  const added = await store.addEvidence(108, draft.id, original);
  assert.equal((await store.addEvidence(108, draft.id, original)).revision, 2);
  const changed = await store.update(108, draft.id, added.revision, { conclusion: 'New answers from another tab' });
  await assert.rejects(store.addEvidence(108, draft.id, file('stale attachment', { revision: 2 })), error(409, 'REVISION_CONFLICT'));
  await assert.rejects(store.addEvidence(108, draft.id, original), error(409, 'REVISION_CONFLICT'));
  await assert.rejects(store.removeEvidence(108, draft.id, original.id, 2), error(409, 'REVISION_CONFLICT'));
  assert.equal((await store.current(108, 58)).data.conclusion, 'New answers from another tab');
  const removed = await store.removeEvidence(108, draft.id, original.id, changed.revision);
  assert.equal((await store.removeEvidence(108, draft.id, original.id, changed.revision)).revision, removed.revision);
  await store.update(108, draft.id, removed.revision, { conclusion: 'Even newer answers' });
  await assert.rejects(store.removeEvidence(108, draft.id, original.id, changed.revision), error(409, 'REVISION_CONFLICT'));
  assert.equal((await store.current(108, 58)).data.conclusion, 'Even newer answers');
}));

test('delivery lock can use an independent pool while ordinary draft queries remain available', { timeout: 1000 }, async () => {
  const id = randomUUID(), events = [];
  const query = async (sql, params) => {
    if (sql.startsWith('SELECT * FROM audit_drafts')) return { rows: [{ id, author_tg_id: params[1] }] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    return { rows: [] };
  };
  let tail = Promise.resolve(), leases = 0;
  const pool = { async connect() {
    let unlock; const previous = tail; tail = new Promise(resolve => { unlock = resolve; });
    await previous; leases++;
    return { query, release: unlock };
  } };
  const lockPool = { async connect() { return { query: async (...args) => { events.push('lock-query'); return query(...args); }, release() { events.push('unlock'); } }; } };
  const store = createDraftStore(pool, undefined, { lockPool });
  await Promise.all(Array.from({ length: 10 }, () => store.withDraftDeliveryLock(108, id, async () => {
    const client = await pool.connect();
    await client.query('SELECT 1'); client.release();
  })));
  assert.equal(events.filter(event => event === 'unlock').length, 10);
  assert.ok(leases >= 11);
});

test('ten simultaneous deliveries on a one-slot pg pool leave ordinary SQL available', { timeout: 2500 }, async () => {
  const { EventEmitter } = require('node:events');
  const { Pool } = require('pg');
  const clients = [];
  class SyntheticClient extends EventEmitter {
    constructor(options) { super(); this.options=options; this._queryable=true; this._ending=false; clients.push(this); }
    connect(callback) { queueMicrotask(()=>callback()); }
    ref() {}
    unref() {}
    end(callback) { this._ending=true; queueMicrotask(()=>{ this.emit('end'); callback?.(); }); }
    query(sql, params, callback) {
      if(typeof params==='function'){callback=params;params=undefined;}
      let rows=[];
      if(sql.startsWith('SELECT * FROM audit_drafts'))rows=[{id:params[0],author_tg_id:params[1]}];
      if(sql.includes('pg_try_advisory_lock'))rows=[{locked:true}];
      const result={rows};
      if(callback){setImmediate(()=>callback(null,result));return;}
      return Promise.resolve(result);
    }
  }
  const pool=new Pool({Client:SyntheticClient,max:1,connectionTimeoutMillis:500,idleTimeoutMillis:20,allowExitOnIdle:true});
  try {
    const store=createDraftStore(pool);let completed=0;
    await Promise.all(Array.from({length:10},(_,index)=>store.withDraftDeliveryLock(108,randomUUID(),async()=>{
      await pool.query('SELECT 1');completed++;
    })));
    assert.equal(completed,10);
    assert.equal(pool.waitingCount,0);
    assert.ok(clients.some(client=>client.options.max===2),'Session locks must have their own bounded pool');
    assert.ok(clients.some(client=>client.options.max===1),'Normal queries stay on the original pool');
  } finally { await require('../src/web/audit-drafts').closeDeliveryLockPool(pool); await pool.end(); }
  assert.ok(clients.every(client=>client._ending),'All owned pools close during test cleanup');
});
