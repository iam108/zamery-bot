const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createReportImportUpload, cleanupReportImport } = require('../src/web/report-import-upload');

async function multipart(files, fields = []) {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  for (const [name, bytes] of files) form.append('files', new Blob([bytes], { type: 'application/json' }), name);
  const request = new Request('https://local.test/admin/import', { method: 'POST', body: form });
  const body = Buffer.from(await request.arrayBuffer());
  return { body, headers: { 'content-type': request.headers.get('content-type'), 'content-length': String(body.length) } };
}
function run(middleware, payload, streaming = false) {
  const req = streaming ? new PassThrough() : Readable.from([payload.body]);
  req.headers = payload.headers; req.method = 'POST';
  const res = new EventEmitter(); res.headers = {}; res.statusCode = 200; res.writableFinished = false;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  res.set = (name, value) => { res.headers[name] = value; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.send = message => { res.writableFinished = true; finish({ ok: false, status: res.statusCode, message }); return res; };
  const started = middleware(req, res, () => finish({ ok: true }));
  return { req, res, done, started };
}
async function parent(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-report-upload-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}
async function waitFor(fn) {
  const until = Date.now() + 2000;
  while (!fn()) { assert.ok(Date.now() < until, 'Upload should settle without waiting for a network timeout'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('50 small browser multipart files spool exact bytes to private generated paths and cleanup is idempotent', async t => {
  const directory = await parent(t), files = Array.from({ length: 50 }, (_, n) => [n === 0 ? '../source.json' : 'report-' + n + '.json', Buffer.from([0, 255, 128, n])]);
  const upload = createReportImportUpload({ parentDirectory: directory, fileBytes: 12 });
  const op = run(upload, await multipart(files)); assert.deepEqual(await op.done, { ok: true });
  const work = op.req.reportImportWork;
  assert.equal(op.req.files.length, 50); assert.equal((await fs.stat(work.directory)).mode & 0o777, 0o700);
  for (let n = 0; n < files.length; n++) {
    const file = op.req.files[n];
    assert.equal(path.dirname(file.path), work.directory); assert.match(path.basename(file.path), /^[0-9a-f-]{36}$/);
    assert.equal((await fs.stat(file.path)).mode & 0o777, 0o600); assert.ok((await fs.readFile(file.path)).equals(files[n][1]));
    assert.equal(file.buffer, undefined, 'The importer receives paths instead of retaining every original in RAM');
  }
  await Promise.all([cleanupReportImport(op.req), cleanupReportImport(op.req)]);
  assert.deepEqual(await fs.readdir(directory), []); assert.equal(op.req.listenerCount('aborted'), 0); assert.equal(op.req.listenerCount('error'), 0); assert.equal(op.res.listenerCount('close'), 0);
});

test('the admission slot stays held during processing and is available after caller cleanup', async t => {
  const directory = await parent(t), upload = createReportImportUpload({ parentDirectory: directory, fileBytes: 12 });
  const payload = await multipart([['report.json', Buffer.from('1234')]]), first = run(upload, payload);
  assert.deepEqual(await first.done, { ok: true });
  const busy = run(upload, payload), rejected = await busy.done;
  assert.equal(rejected.status, 503); assert.equal(busy.res.headers['Retry-After'], '30'); assert.equal(busy.req.reportImportWork, undefined);
  assert.equal((await fs.readdir(directory)).length, 1);
  await cleanupReportImport(first.req);
  const retried = run(upload, payload); assert.deepEqual(await retried.done, { ok: true }); await cleanupReportImport(retried.req);
  assert.deepEqual(await fs.readdir(directory), []);
});

for (const scenario of ['oversized file', 'too many files', 'too many fields']) test(scenario + ' rejects and removes all partial disk files before returning the slot', async t => {
  const directory = await parent(t), upload = createReportImportUpload({ parentDirectory: directory, fileBytes: 12, maxFiles: 2 });
  const files = scenario === 'oversized file' ? [['small.json', Buffer.from('ok')], ['large.json', Buffer.alloc(13)]] : scenario === 'too many files' ? [1, 2, 3].map(n => ['report-' + n + '.json', Buffer.from('ok')]) : [['small.json', Buffer.from('ok')]];
  const fields = scenario === 'too many fields' ? [1, 2, 3, 4, 5].map(n => ['field-' + n, 'x']) : [];
  const op = run(upload, await multipart(files, fields)), failure = await op.done;
  assert.equal(failure.ok, false); assert.equal(failure.status, 413); assert.deepEqual(await fs.readdir(directory), []);
  const next = run(upload, await multipart([['retry.json', Buffer.from('valid')]])); assert.deepEqual(await next.done, { ok: true }); await cleanupReportImport(next.req);
});

for (const event of ['aborted', 'error', 'response close']) test(event + ' during a partial multipart file closes output and releases temporary storage', async t => {
  const directory = await parent(t), upload = createReportImportUpload({ parentDirectory: directory, fileBytes: 100 });
  const payload = await multipart([['partial.json', Buffer.from('PAYLOAD-BYTES-NOT-FINISHED')]]), op = run(upload, payload, true);
  op.req.write(payload.body.subarray(0, payload.body.indexOf(Buffer.from('PAYLOAD')) + 3));
  await waitFor(() => op.req.reportImportWork && op.req.reportImportWork.active.size > 0);
  if (event === 'response close') op.res.emit('close'); else if (event === 'error') op.req.emit('error', new Error('Synthetic client stream failure')); else op.req.emit('aborted');
  await waitFor(() => op.req.reportImportWork.cleanup); await op.req.reportImportWork.cleanup;
  assert.equal(op.req.reportImportWork.aborted, true); assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(op.req.reportImportWork.active.size, 0); assert.equal(op.req.reportImportWork.closing.size, 0);
  op.req.end();
  const next = run(upload, await multipart([['retry.json', Buffer.from('valid')]])); assert.deepEqual(await next.done, { ok: true }); await cleanupReportImport(next.req);
});

test('an early disconnected response cleans a directory even before multipart parsing starts', async t => {
  const directory = await parent(t), upload = createReportImportUpload({ parentDirectory: directory });
  const payload = await multipart([['unused.json', Buffer.from('unused')]]), op = run(upload, payload, true);
  op.res.emit('close'); await op.started;
  assert.equal(op.req.reportImportWork.aborted, true); assert.deepEqual(await fs.readdir(directory), []); op.req.end();
  const next = run(upload, payload); assert.deepEqual(await next.done, { ok: true }); await cleanupReportImport(next.req);
});

test('a temporary directory preparation error releases admission so a corrected retry succeeds', async t => {
  const directory = await parent(t), unavailable = path.join(directory, 'parent'), payload = await multipart([['report.json', Buffer.from('valid')]]);
  await fs.writeFile(unavailable, 'not a directory');
  const upload = createReportImportUpload({ parentDirectory: unavailable }), rejected = run(upload, payload);
  assert.equal((await rejected.done).status, 503); assert.equal(rejected.req.listenerCount('aborted'), 0); assert.equal(rejected.res.listenerCount('close'), 0);
  await fs.unlink(unavailable); await fs.mkdir(unavailable);
  const next = run(upload, payload); assert.deepEqual(await next.done, { ok: true }); await cleanupReportImport(next.req);
  assert.deepEqual(await fs.readdir(unavailable), []);
});
