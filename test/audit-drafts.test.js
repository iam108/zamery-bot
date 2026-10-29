const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDraftStore, prepareEvidence, validateData } = require('../src/web/audit-drafts');

function file(text = 'original', changes = {}) {
  return { id: randomUUID(), name: 'план.png', mime: 'image/png', role: 'plan', subject_id: 'plan-main', data: Buffer.from(text).toString('base64'), ...changes };
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
    await db.exec('CREATE TABLE orders(id INT PRIMARY KEY); INSERT INTO orders(id) VALUES(58),(59);');
    await run(createDraftStore(pool, limits), db, pool);
  } finally { await db.close(); }
}

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
  assert.equal((await store.removeEvidence(108, draft.id, source.id)).revision, 3);
  assert.equal((await store.current(108, 58)).evidence.length, 0);
  await assert.rejects(store.downloadEvidence(108, draft.id, source.id), error(404, 'NOT_FOUND'));
  const stored = await db.query('SELECT content,deleted_at FROM audit_evidence WHERE draft_id=$1 AND id=$2', [draft.id, source.id]);
  assert.equal(Buffer.from(stored.rows[0].content).toString(), 'original bytes');
  assert.ok(stored.rows[0].deleted_at);
  assert.equal((await store.addEvidence(108, draft.id, source)).revision, 4);
  assert.equal((await store.current(108, 58)).evidence.length, 1);
}));

test('evidence aggregate limits cannot be bypassed by recoverable removals', { skip: !process.env.PGLITE_TEST_MODULE }, async () => database(async store => {
  const draft = await store.create(108, 58);
  const first = file('123456789');
  await store.addEvidence(108, draft.id, first);
  await assert.rejects(store.addEvidence(108, draft.id, file('1234567890')), error(413, 'EVIDENCE_LIMIT'));
  await store.addEvidence(108, draft.id, file('123456789'));
  await store.removeEvidence(108, draft.id, first.id);
  await assert.rejects(store.addEvidence(108, draft.id, file('a')), error(413, 'EVIDENCE_LIMIT'));
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
  await assert.rejects(store.removeEvidence(108, draft.id, source.id), error(409, 'SUBMITTING'));
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
