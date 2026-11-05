const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { createDraftStore } = require('../src/web/audit-drafts');
const { createAuditEvidenceStore } = require('../src/web/audit-evidence-store');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function file(content = Buffer.from('original PNG bytes'), changes = {}) {
  return { revision: 1, id: randomUUID(), name: 'territory.png', mime: 'image/png', role: 'map-source', subject_id: 'source', data: content.toString('base64'), ...changes };
}
function fakeObjects(hooks = {}) {
  const files = new Map(), calls = { puts: [], gets: [], deletes: [] };
  return {
    files, calls, configured: () => true,
    async put(input) {
      assert.match(input.key, /^audit-originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
      calls.puts.push(input.key); const chunks = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks); assert.equal(body.length, input.bytes); assert.equal(sha(body), input.sha256);
      files.set(input.key, { body, bytes: input.bytes, sha256: input.sha256, mime: input.mime });
      await hooks.put?.(input);
    },
    async get(input) {
      calls.gets.push(input.key); await hooks.get?.(input);
      const stored = files.get(input.key); if (!stored) throw new Error('missing synthetic object');
      return Readable.from([stored.body]);
    },
    async remove(key) { calls.deletes.push(key); files.delete(key); }
  };
}
async function database(run, options = {}) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  let tail = Promise.resolve(), active = 0;
  const sql = [], state = { forbidBinary: true, loseCommit: false };
  const query = async (text, params) => {
    if (state.forbidBinary) assert.ok(!(params || []).some(v => Buffer.isBuffer(v) || v instanceof Uint8Array), 'S3 originals must never be sent as PostgreSQL parameters');
    sql.push(text);
    const result = params ? await db.query(text, params) : await db.exec(text);
    if (text === 'COMMIT' && state.loseCommit) { state.loseCommit = false; throw new Error('synthetic lost COMMIT acknowledgement'); }
    return result;
  };
  const pool = {
    async connect() {
      const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await previous; active++;
      let released = false;
      return { query, release() { if (!released) { released = true; active--; unlock(); } } };
    },
    async query(text, params) { const c = await pool.connect(); try { return await c.query(text, params); } finally { c.release(); } }
  };
  try {
    await db.exec('CREATE TABLE orders(id INT PRIMARY KEY); INSERT INTO orders VALUES(58),(59);');
    const objects = options.objects || fakeObjects();
    await run({ db, pool, objects, sql, state, active: () => active, makeStore: limits => createDraftStore(pool, limits, { objectStore: objects }) });
  } finally { await db.close(); }
}
const pg = { skip: !process.env.PGLITE_TEST_MODULE };

test('audit JPG, PNG and PDF originals are private S3 objects with metadata-only PostgreSQL and exact original downloads', pg, async () => database(async h => {
  const store = h.makeStore(), draft = await store.create(108, 58);
  for (const [mime, name, bytes] of [
    ['image/png', 'map.png', Buffer.from('PNG original, no resizing')],
    ['image/jpeg', 'phone.jpg', Buffer.alloc(6 * 1024 * 1024, 71)],
    ['application/pdf', 'plan.pdf', Buffer.from('%PDF-1.7\noriginal plan')]
  ]) {
    const source = file(bytes, { mime, name, revision: (await store.current(108, 58)).revision });
    const added = await store.addEvidence(108, draft.id, source), puts = h.objects.calls.puts.length;
    assert.equal((await store.addEvidence(108, draft.id, source)).revision, added.revision);
    assert.equal(h.objects.calls.puts.length, puts, 'A lost upload response must not upload the original again');
    const row = (await h.db.query('SELECT * FROM audit_evidence WHERE id=$1', [source.id])).rows[0];
    assert.equal(row.content, null); assert.equal(row.storage, 's3'); assert.equal(row.sha256, sha(bytes));
    assert.ok(h.objects.files.has(row.object_key));
    assert.deepEqual((await store.downloadEvidence(108, draft.id, source.id)).buffer, bytes);
    assert.doesNotMatch(JSON.stringify(added), /object_key|audit-originals|"content"|"buffer"/);
  }
  const current = await store.current(108, 58), previousGets = h.objects.calls.gets.length;
  await assert.rejects(store.downloadEvidence(109, draft.id, current.evidence[0].id), e => e.code === 'NOT_FOUND');
  assert.equal(h.objects.calls.gets.length, previousGets, 'Authorization precedes every storage read');
  const frozen = await h.makeStore().loadDraftForSubmit(108, draft.id, current.revision);
  assert.equal(frozen.submitting, true); assert.equal(frozen.evidence.length, 3);
  frozen.evidence.forEach(item => { assert.ok(Buffer.isBuffer(item.buffer)); assert.equal(sha(item.buffer), item.sha256); });
  assert.doesNotMatch(JSON.stringify(current), /audit-originals|object_key|"content"|"buffer"/);
}));

test('existing PostgreSQL audit originals remain readable after the storage migration', pg, async () => database(async h => {
  h.state.forbidBinary = false;
  const legacy = createDraftStore(h.pool), draft = await legacy.create(108, 58), source = file();
  await legacy.addEvidence(108, draft.id, source); h.state.forbidBinary = true;
  const bytes = Buffer.from(source.data, 'base64'), store = h.makeStore();
  assert.deepEqual((await store.downloadEvidence(108, draft.id, source.id)).buffer, bytes);
  const next = await store.addEvidence(108, draft.id, { ...file(Buffer.from('new S3 file')), revision: 2 });
  assert.equal(next.revision, 3);
  assert.equal((await h.db.query("SELECT COUNT(*)::int count FROM audit_evidence WHERE storage='postgres' AND content IS NOT NULL")).rows[0].count, 1);
  assert.equal((await h.db.query("SELECT COUNT(*)::int count FROM audit_evidence WHERE storage='s3' AND content IS NULL")).rows[0].count, 1);
}));

test('storage calls hold no database transaction, failed writes leave no evidence or revision changes, and retry preserves the original', pg, async () => database(async h => {
  let rejectPut = true;
  h.objects = fakeObjects({ put() { assert.equal(h.active(), 0); if (rejectPut) throw new Error('synthetic object verification failure'); }, get() { assert.equal(h.active(), 0); } });
  const store = createDraftStore(h.pool, undefined, { objectStore: h.objects }), draft = await store.create(108, 58), source = file();
  await assert.rejects(store.addEvidence(108, draft.id, source), /verification failure/);
  assert.equal(h.objects.files.size, 0); assert.equal(h.objects.calls.deletes.length, 1);
  const untouched = await store.current(108, 58); assert.equal(untouched.revision, 1); assert.equal(untouched.evidence.length, 0);
  rejectPut = false; await store.addEvidence(108, draft.id, source);
  assert.deepEqual((await store.downloadEvidence(108, draft.id, source.id)).buffer, Buffer.from(source.data, 'base64'));
  assert.equal((await store.loadDraftForSubmit(108, draft.id, 2)).submitting, true);
}));

test('concurrent duplicate audit uploads keep one metadata row and remove only the unused attempt', pg, async () => database(async h => {
  let opened = 0, release; const gate = new Promise(resolve => { release = resolve; });
  h.objects = fakeObjects({ async put() { if (++opened === 2) release(); await gate; } });
  const store = createDraftStore(h.pool, undefined, { objectStore: h.objects }), draft = await store.create(108, 58), source = file();
  const result = await Promise.all([store.addEvidence(108, draft.id, source), store.addEvidence(108, draft.id, source)]);
  assert.equal(result[0].revision, 2); assert.equal(result[1].revision, 2);
  assert.equal(h.objects.calls.puts.length, 2); assert.equal(h.objects.files.size, 1); assert.equal(h.objects.calls.deletes.length, 1);
  const row = (await h.db.query('SELECT object_key FROM audit_evidence')).rows[0];
  assert.ok(h.objects.files.has(row.object_key)); assert.notEqual(h.objects.calls.deletes[0], row.object_key);
  assert.equal((await store.current(108, 58)).evidence.length, 1);
}));

test('a lost metadata COMMIT acknowledgement cannot remove a durable S3 original', pg, async () => database(async h => {
  const objects = fakeObjects({ put() { h.state.loseCommit = true; } });
  const store = createDraftStore(h.pool, undefined, { objectStore: objects }), draft = await store.create(108, 58), source = file();
  const result = await store.addEvidence(108, draft.id, source);
  assert.equal(result.revision, 2); assert.equal(objects.files.size, 1); assert.equal(objects.calls.deletes.length, 0);
  assert.deepEqual((await store.downloadEvidence(108, draft.id, source.id)).buffer, Buffer.from(source.data, 'base64'));
}));

test('unreadable or changed S3 originals cannot freeze a report and can be retried after recovery', pg, async () => database(async h => {
  const store = h.makeStore(), draft = await store.create(108, 58), source = file();
  await store.addEvidence(108, draft.id, source);
  const key = (await h.db.query('SELECT object_key FROM audit_evidence')).rows[0].object_key, saved = h.objects.files.get(key);
  h.objects.files.set(key, { ...saved, body: Buffer.from('wrong original') });
  await assert.rejects(store.loadDraftForSubmit(108, draft.id, 2), e => e.code === 'AUDIT_EVIDENCE_INTEGRITY');
  assert.equal((await h.db.query('SELECT submitting_revision FROM audit_drafts')).rows[0].submitting_revision, null);
  assert.equal((await store.current(108, 58)).submitting, false);
  h.objects.files.set(key, saved);
  assert.equal((await store.loadDraftForSubmit(108, draft.id, 2)).submitting, true);
}));

test('a draft edited during original hydration cannot freeze or send a stale snapshot', pg, async () => database(async h => {
  let entered, finish; const reading = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const objects = fakeObjects({ async get() { entered(); await gate; } });
  const store = createDraftStore(h.pool, undefined, { objectStore: objects }), draft = await store.create(108, 58), source = file();
  await store.addEvidence(108, draft.id, source);
  const pending = store.loadDraftForSubmit(108, draft.id, 2), failed = assert.rejects(pending, e => e.code === 'REVISION_CONFLICT');
  await reading; await store.update(108, draft.id, 2, { conclusion: 'A newer observation' }); finish(); await failed;
  assert.equal((await store.current(108, 58)).submitting, false);
}));

test('recoverable S3 removals still consume file and byte limits, and restoring never uploads again', pg, async () => database(async h => {
  const store = h.makeStore({ files: 1, totalBytes: 30, fileBytes: 30 }), draft = await store.create(108, 58), source = file(Buffer.from('recoverable original'));
  await store.addEvidence(108, draft.id, source); await store.removeEvidence(108, draft.id, source.id, 2);
  await assert.rejects(store.addEvidence(108, draft.id, { ...file(Buffer.from('second')), revision: 3 }), e => e.code === 'EVIDENCE_LIMIT');
  assert.equal(h.objects.calls.puts.length, 1); assert.equal(h.objects.calls.deletes.length, 0);
  assert.equal((await store.addEvidence(108, draft.id, { ...source, revision: 3 })).revision, 4); assert.equal(h.objects.calls.puts.length, 1);
}));

test('an audit original pointer cannot read another draft namespace even through a valid private client', async () => {
  const objects = fakeObjects(), store = createAuditEvidenceStore({ objectStore: objects });
  await assert.rejects(store.read({ draft_id: randomUUID(), storage: 's3', object_key: 'audit-originals/' + randomUUID() + '/' + randomUUID(), bytes: 1, sha256: sha(Buffer.from('x')) }), e => e.code === 'AUDIT_EVIDENCE_INTEGRITY');
  assert.equal(objects.calls.gets.length, 0);
});

test('an edit during remote original upload rejects the stale metadata write and cleans only its unused object', pg, async () => database(async h => {
  let store,draft;
  const objects=fakeObjects({async put(){await store.update(108,draft.id,1,{conclusion:'Saved in another view during upload'});}});
  store=createDraftStore(h.pool,undefined,{objectStore:objects});draft=await store.create(108,58,{conclusion:'Old view'});
  await assert.rejects(store.addEvidence(108,draft.id,file()),error=>error.code==='REVISION_CONFLICT');
  const current=await store.current(108,58);
  assert.equal(current.data.conclusion,'Saved in another view during upload');
  assert.equal(current.evidence.length,0);
  assert.equal(objects.files.size,0);
}));
