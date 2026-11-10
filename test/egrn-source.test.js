'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const { readStatusResponse, readFileResponse } = require('../src/bot/egrn-source');

const sha = value => createHash('sha256').update(value).digest('hex');
function pdf(bytes = 257, fill = 0x5e) { const value = Buffer.alloc(bytes, fill); value.write('%PDF-1.7\n'); return value; }
async function* pieces(value, size = 7) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}
async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'egrn-source-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function read(file) {
  const parts = []; for await (const part of file.open()) parts.push(part);
  return Buffer.concat(parts);
}
async function empty(directory) { assert.deepEqual(await fs.readdir(directory), [], 'All private response workspaces must be removed'); }
function status(file, extra = {}) { return { id_req: 77, status: [{ type: 'processed', file: file.toString('base64') }], ...extra }; }

// Independent bit-at-a-time ZIP CRC, checked against the standard test vector.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = entry.data, method = entry.deflate ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(raw) : raw, crc = entry.crc === undefined ? crc32(raw) : entry.crc;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(directory, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('request selection ignores other orders even when id_req follows their embedded files', async t => {
  const directory = await root(t), wanted = pdf(259), other = pdf(261, 0x63);
  const body = JSON.stringify({ old: { status: [{ file: other.toString('base64') }], id_req: 3 }, selected: { status: [{ file: wanted.toString('base64') }], id_req: '77' } });
  const result = await readStatusResponse(pieces(body, 3), { idReq: 77, root: directory });
  try {
    assert.equal(result.item.id_req, '77'); assert.equal(result.hasFiles, true);
    const docs = await result.documents('77:01:0000000:1'); assert.equal(docs.length, 1); assert.equal(docs[0].bytes, wanted.length);
    assert.equal(docs[0].sha256, sha(wanted)); assert.deepEqual(await read(docs[0]), wanted);
    assert.deepEqual(await read(docs[0]), wanted, 'Each open() must return a fresh readable source for retries');
    assert.doesNotMatch(JSON.stringify(result.item), /base64|localPath|zamery-egrn-source-/);
  } finally { await result.cleanup(); }
  await empty(directory);
});

test('numeric BIGINT request tokens retain exact identity and cannot select an adjacent foreign original', async t => {
  const directory = await root(t), wanted = pdf(301, 0x61), other = pdf(303, 0x62);
  const encode = (id, file) => '{"id_req":' + id + ',"status":[{"type":"processed","file":"' + file.toString('base64') + '"}]}';
  const body = '{"other":' + encode('9007199254740992', other) + ',"selected":' + encode('9007199254740993', wanted) + '}';
  const result = await readStatusResponse(pieces(body, 3), { idReq: '9007199254740993', root: directory });
  try {
    assert.equal(result.item.id_req, '9007199254740993');
    const docs = await result.documents(); assert.equal(docs.length, 1); assert.deepEqual(await read(docs[0]), wanted);
  } finally { await result.cleanup(); }
  await empty(directory);
  await assert.rejects(readStatusResponse(pieces(encode('9007199254740993', other)), { idReq: '9007199254740992', root: directory }), error => error.code === 'EGRN_SOURCE_REQUEST');
  await empty(directory);
});

test('array-shaped request identities cannot authorize an embedded or downloadable original', async t => {
  const directory = await root(t);
  const body = JSON.stringify({ id_req: [77], status: [{ type: 'processed', file: pdf().toString('base64') }], download_url: 'https://provider.example/foreign.pdf' });
  await assert.rejects(readStatusResponse(pieces(body), { idReq: 77, root: directory }), error => error.code === 'EGRN_SOURCE_REQUEST');
  await empty(directory);
});

test('a matching request cannot inherit files from an explicitly different nested request', async t => {
  const directory = await root(t), wanted = pdf(259), other = pdf(261, 0x63);
  const body = JSON.stringify({ ...status(wanted), previous: status(other, { id_req: 3 }) });
  const result = await readStatusResponse(pieces(body), { idReq: 77, root: directory });
  try { const docs = await result.documents(); assert.equal(docs.length, 1); assert.equal(docs[0].sha256, sha(wanted)); }
  finally { await result.cleanup(); }
  await empty(directory);
});

test('missing or duplicate matching request identifiers cannot deliver another order', async t => {
  const directory = await root(t), file = pdf();
  for (const value of [
    { old: status(file, { id_req: 3 }) },
    { a: status(file), b: status(file) },
    { status: [], previous: status(file, { id_req: 3 }) }
  ]) {
    await assert.rejects(readStatusResponse(pieces(JSON.stringify(value)), { idReq: 77, root: directory }), error => error.code === 'EGRN_SOURCE_REQUEST');
    await empty(directory);
  }
});

test('nested foreign request URLs are removed before the poller can use URL fallback', async t => {
  const directory = await root(t);
  const body = JSON.stringify({ id_req: 77, status: [{ type: 'processed' }], result_url: 'https://provider.example/own.pdf', previous: { id_req: 3, result_url: 'https://provider.example/foreign.pdf' } });
  const result = await readStatusResponse(pieces(body), { idReq: 77, root: directory });
  try {
    assert.equal(result.item.result_url, 'https://provider.example/own.pdf');
    assert.equal(Object.hasOwn(result.item, 'previous'), false);
    assert.doesNotMatch(JSON.stringify(result.item), /foreign/);
    assert.deepEqual(await result.documents(), []);
  } finally { await result.cleanup(); }
  await empty(directory);
});

test('an unambiguous id-less status response remains supported without a processed status marker', async t => {
  const directory = await root(t), file = pdf();
  const result = await readStatusResponse(pieces(JSON.stringify({ status: [{ file: file.toString('base64') }] })), { idReq: 77, root: directory });
  try { assert.equal(result.hasFiles, true); assert.deepEqual(await read((await result.documents())[0]), file); }
  finally { await result.cleanup(); }
  await empty(directory);
});

test('historical duplicate files are deduplicated before they exhaust the response workspace budget', async t => {
  const directory = await root(t), file = pdf(800), value = { id_req: 77, status: Array.from({ length: 4 }, (_, i) => ({ id_status: i, file: file.toString('base64') })) };
  const result = await readStatusResponse(pieces(JSON.stringify(value)), { idReq: 77, root: directory, maxBytes: file.length });
  try { const docs = await result.documents(); assert.equal(docs.length, 1); assert.equal(docs[0].sha256, sha(file)); }
  finally { await result.cleanup(); }
  await empty(directory);
});

test('base64 quartets, padding, escaped slashes and whitespace survive arbitrary JSON boundaries', async t => {
  const directory = await root(t);
  for (const bytes of [256, 257, 258]) {
    const file = pdf(bytes, 0xff), b64 = file.toString('base64').match(/.{1,5}/g).join('\n \t');
    const body = JSON.stringify({ id_req: 77, status: [{ file: b64 }], label: 'Здание: Москва — первый этаж' }).replaceAll('/', '\\/');
    for (const size of [1, 2, 3, 17]) {
      const result = await readStatusResponse(pieces(body, size), { idReq: 77, root: directory });
      try { const docs = await result.documents(); assert.equal(docs.length, 1); assert.deepEqual(await read(docs[0]), file); }
      finally { await result.cleanup(); }
    }
  }
  await empty(directory);
});

test('invalid base64 and malformed JSON after an embedded file remove partial and completed temporary files', async t => {
  const directory = await root(t), b64 = pdf().toString('base64');
  for (const broken of [b64.slice(0, 20) + '@' + b64.slice(21), b64 + '=AAAA', b64.slice(0, -4) + 'A===']) {
    await assert.rejects(readStatusResponse(pieces(JSON.stringify({ id_req: 77, status: [{ file: broken }] })), { idReq: 77, root: directory }));
    await empty(directory);
  }
  const body = JSON.stringify(status(pdf()));
  await assert.rejects(readStatusResponse(pieces(body.slice(0, -1) + ',"broken":'), { idReq: 77, root: directory }), error => error.code === 'EGRN_SOURCE_RESPONSE');
  await empty(directory);
});

test('metadata string, key and nesting limits fail without retaining provider response files', async t => {
  const directory = await root(t);
  let nested = null; for (let i = 0; i < 70; i++) nested = { next: nested };
  for (const value of [{ id_req: 77, label: 'x'.repeat(64 * 1024 + 1) }, { ['x'.repeat(513)]: 1 }, nested]) {
    await assert.rejects(readStatusResponse(pieces(JSON.stringify(value), 1024), { idReq: 77, root: directory }), error => error.code === 'EGRN_SOURCE_METADATA');
    await empty(directory);
  }
});

test('provider metadata cannot mutate prototypes and JSON comments are rejected by the strict parser', async t => {
  const directory = await root(t);
  const encoded = pdf().toString('base64');
  const payload = '{"id_req":77,"__proto__":{"egrn_polluted":true},"constructor":{"prototype":{"egrn_polluted":true}},"status":[{"type":"processed","file":"' + encoded + '"}]}';
  const result = await readStatusResponse(pieces(payload, 5), { idReq: 77, root: directory });
  try {
    assert.equal({}.egrn_polluted, undefined);
    assert.equal(Object.getPrototypeOf(result.item), null);
    assert.equal(Object.hasOwn(result.item, '__proto__'), true);
    assert.equal(result.item.__proto__.egrn_polluted, true);
    assert.equal((await result.documents()).length, 1);
  } finally { await result.cleanup(); }
  await empty(directory);
  for (const comment of ['/* not JSON */', '// not JSON\n']) {
    await assert.rejects(readStatusResponse(pieces(comment + payload, 5), { idReq: 77, root: directory }), error => error.code === 'EGRN_SOURCE_RESPONSE');
    await empty(directory);
  }
});

test('stored and deflated ZIP PDFs are extracted sequentially, with duplicate content and XML excluded', async t => {
  const directory = await root(t), first = pdf(289), second = pdf(293, 0x62);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const archive = zip([{ name: 'папка/первый.pdf', data: first }, { name: 'second.PDF', data: second, deflate: true }, { name: 'same.pdf', data: first, deflate: true }, { name: 'data.xml', data: Buffer.from('<root/>') }]);
  const result = await readStatusResponse(pieces(JSON.stringify(status(archive)), 11), { idReq: 77, root: directory });
  try {
    const docs = await result.documents('77:01:0000000:1'); assert.equal(docs.length, 2); assert.ok(docs.every(doc => doc.kind === 'pdf'));
    assert.deepEqual(new Set(docs.map(doc => doc.sha256)), new Set([sha(first), sha(second)]));
    for (const doc of docs) assert.equal(sha(await read(doc)), doc.sha256);
  } finally { await result.cleanup(); }
  await empty(directory);
});

test('ZIP CRC failures or archives without PDFs preserve the complete original ZIP rather than an unsafe PDF', async t => {
  const directory = await root(t), file = pdf();
  for (const archive of [zip([{ name: 'bad.pdf', data: file, crc: 0 }]), zip([{ name: 'data.xml', data: Buffer.from('<root/>') }])]) {
    const result = await readStatusResponse(pieces(JSON.stringify(status(archive))), { idReq: 77, root: directory });
    try { const docs = await result.documents(); assert.equal(docs.length, 1); assert.equal(docs[0].kind, 'zip'); assert.deepEqual(await read(docs[0]), archive); }
    finally { await result.cleanup(); }
  }
  await empty(directory);
});

test('aborting ZIP extraction is an operational failure and cannot silently become a successful ZIP fallback', async t => {
  const directory = await root(t), controller = new AbortController(), archive = zip([{ name: 'plan.pdf', data: pdf(), deflate: true }]);
  const result = await readStatusResponse(pieces(JSON.stringify(status(archive))), { idReq: 77, root: directory, signal: controller.signal });
  try { controller.abort(); await assert.rejects(result.documents(), error => error.code === 'EGRN_SOURCE_ABORTED'); }
  finally { await result.cleanup(); }
  await empty(directory);
});

test('file limits apply to decoded bytes at the exact boundary and reject larger input without leftovers', async t => {
  const directory = await root(t), file = pdf(257);
  for (const json of [false, true]) {
    const load = maxBytes => json ? readStatusResponse(pieces(JSON.stringify(status(file))), { idReq: 77, root: directory, maxBytes }) : readFileResponse(pieces(file), 'source.pdf', { root: directory, maxBytes });
    const exact = await load(file.length); await exact.cleanup(); await empty(directory);
    await assert.rejects(load(file.length - 1), error => error.code === 'EGRN_FILE_TOO_LARGE'); await empty(directory);
  }
});

test('direct file downloads verify expected length, report source failures and close their iterator', async t => {
  const directory = await root(t), file = pdf();
  for (const expectedBytes of [file.length - 1, file.length + 1]) {
    await assert.rejects(readFileResponse(pieces(file), 'source.pdf', { root: directory, expectedBytes }), error => error.code === 'EGRN_SOURCE_INCOMPLETE'); await empty(directory);
  }
  let closed = false;
  async function* broken() { try { yield file.subarray(0, 30); throw new Error('synthetic body transport failure'); } finally { closed = true; } }
  await assert.rejects(readFileResponse(broken(), 'source.pdf', { root: directory })); assert.equal(closed, true); await empty(directory);
  await assert.rejects(readStatusResponse(broken(), { root: directory, idReq: 77 })); await empty(directory);
});

test('aborting source consumption removes its workspace and does not leave a readable partial original', async t => {
  const directory = await root(t), file = pdf(), controller = new AbortController(); let closed = false;
  async function* body() { try { yield file.subarray(0, 40); controller.abort(); yield file.subarray(40); } finally { closed = true; } }
  await assert.rejects(readFileResponse(body(), 'source.pdf', { root: directory, signal: controller.signal }), error => error.code === 'EGRN_SOURCE_ABORTED');
  assert.equal(closed, true); await empty(directory);
  const statusController = new AbortController(); let statusClosed = false;
  async function* partialStatus() {
    try { yield Buffer.from('{"id_req":77,"status":[{"file":"' + file.toString('base64').slice(0, 80)); statusController.abort(); yield Buffer.from('"}]}'); }
    finally { statusClosed = true; }
  }
  await assert.rejects(readStatusResponse(partialStatus(), { idReq: 77, root: directory, signal: statusController.signal }), error => /^EGRN_SOURCE_/.test(error.code));
  assert.equal(statusClosed, true); await empty(directory);
  const parsed = await readFileResponse(pieces(file), 'source.pdf', { root: directory });
  await parsed.cleanup(); await parsed.cleanup(); assert.throws(() => parsed.file.open(), error => error.code === 'EGRN_SOURCE_CLOSED'); await empty(directory);
});

test('300 MiB JSON base64 input streams through a child with a 96 MiB JavaScript heap and cleans all files', { timeout: 120000 }, async t => {
  const directory = await root(t);
  const child = spawn(process.execPath, ['--max-old-space-size=96', path.join(__dirname, 'fixtures/egrn-stream-memory.cjs'), directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(exit.code, 0, 'The bounded-heap streaming fixture failed: ' + errors.slice(-1500)); assert.equal(exit.signal, null);
  const result = JSON.parse(output); assert.equal(result.bytes, 300 * 1024 * 1024); assert.equal(result.hashMatches, true); assert.equal(result.cleaned, true);
  await empty(directory);
});
