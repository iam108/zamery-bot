'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { createDownloadUrl, setupEgrnDownloads } = require('../src/web/egrn-downloads');

const ID = '5b06f37d-8aca-44e0-a271-c52844e39881';
const OTHER_ID = 'ab06f37d-8aca-44e0-a271-c52844e39881';
const NOW = Date.UTC(2026, 10, 1, 10);
const SECRET = 'synthetic-download-signing-key-for-tests-only';
const options = { origin: 'https://files.example.test', secret: SECRET, now: () => NOW };
function url(id = ID, extra = {}) { return new URL(createDownloadUrl(id, { ...options, ...extra })); }
function routePath(value) { return value.pathname + value.search; }
function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, res => {
      const parts = [];
      res.on('data', part => parts.push(part)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject); req.end();
  });
}
async function fixture(t, supplied = {}) {
  const data = Buffer.from('%PDF-1.7\nsmall synthetic fixture\n');
  const calls = [];
  const store = {
    async ensure() { calls.push('ensure'); },
    async get(id) { calls.push(['get', id]); return id === ID ? { id, name: 'Выписка ЕГРН.pdf', mime: 'application/pdf', bytes: data.length } : null; },
    async *chunks(id) { calls.push(['chunks', id]); yield data.subarray(0, 5); yield data.subarray(5); },
    ...supplied
  };
  const app = express(); setupEgrnDownloads(app, { store, secret: SECRET, now: () => NOW });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { port: server.address().port, server, store, data, calls };
}

test('links contain a per-file signature and seven-day expiry, without provider or bot credentials', () => {
  const link = url();
  assert.equal(link.origin, 'https://files.example.test');
  assert.equal(link.pathname, '/egrn-files/' + ID + '/download');
  assert.deepEqual([...link.searchParams.keys()], ['exp', 'sig']);
  assert.equal(Number(link.searchParams.get('exp')), NOW / 1000 + 7 * 86400);
  assert.match(link.searchParams.get('sig'), /^[0-9a-f]{64}$/);
  assert.equal(link.href.includes(SECRET), false);
  assert.notEqual(url(OTHER_ID).searchParams.get('sig'), link.searchParams.get('sig'));
  assert.notEqual(url(ID, { ttlSeconds: 3600 }).searchParams.get('sig'), link.searchParams.get('sig'));
  assert.equal(url(ID.toUpperCase()).href, link.href);
});

test('missing or unsafe public origin and signing configuration fail before a delivery can report success', () => {
  for (const origin of [undefined, '', 'http://files.example.test', 'https://files.example.test/audit', 'https://files.example.test/?key=x', 'https://files.example.test/#x', 'https://user:pass@files.example.test']) {
    const previous = process.env.WEBAPP_URL;
    try {
      delete process.env.WEBAPP_URL;
      assert.throws(() => createDownloadUrl(ID, { ...options, origin }), error => error.code === 'EGRN_DOWNLOAD_CONFIG');
    } finally { if (previous === undefined) delete process.env.WEBAPP_URL; else process.env.WEBAPP_URL = previous; }
  }
  for (const secret of ['', 'short', null]) assert.throws(() => createDownloadUrl(ID, { ...options, secret }), error => error.code === 'EGRN_DOWNLOAD_CONFIG');
  for (const ttlSeconds of [0, -1, 7 * 86400 + 1, 1.5, Infinity]) assert.throws(() => createDownloadUrl(ID, { ...options, ttlSeconds }), error => error.code === 'EGRN_DOWNLOAD_CONFIG');
  for (const id of ['../file', ID + '/other', '', 'not-a-uuid']) assert.throws(() => createDownloadUrl(id, options), error => error.code === 'EGRN_DOWNLOAD_INVALID_ID');
});

test('default links use WEBAPP_URL and a separate BOT_TOKEN-derived key, with explicit secret taking precedence', () => {
  const saved = Object.fromEntries(['WEBAPP_URL', 'BOT_TOKEN', 'EGRN_DOWNLOAD_SECRET'].map(key => [key, process.env[key]]));
  try {
    process.env.WEBAPP_URL = 'https://files.example.test/';
    process.env.BOT_TOKEN = 'synthetic-token-not-a-live-telegram-credential';
    delete process.env.EGRN_DOWNLOAD_SECRET;
    const derived = createDownloadUrl(ID, { now: () => NOW });
    assert.equal(derived.includes(process.env.BOT_TOKEN), false);
    assert.notEqual(derived, createDownloadUrl(ID, { ...options, secret: process.env.BOT_TOKEN }));
    process.env.EGRN_DOWNLOAD_SECRET = SECRET;
    assert.equal(createDownloadUrl(ID, { now: () => NOW }), url().href);
    delete process.env.EGRN_DOWNLOAD_SECRET; delete process.env.BOT_TOKEN;
    assert.throws(() => createDownloadUrl(ID, { now: () => NOW }), error => error.code === 'EGRN_DOWNLOAD_CONFIG');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('GET downloads the exact bytes using only the signed URL and private attachment headers', async t => {
  const h = await fixture(t), result = await request(h.port, routePath(url()));
  assert.equal(result.status, 200); assert.deepEqual(result.body, h.data);
  assert.equal(result.headers['content-length'], String(h.data.length));
  assert.equal(result.headers['content-type'], 'application/pdf');
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['accept-ranges'], 'none');
  assert.match(result.headers['content-disposition'], /^attachment; filename="egrn\.pdf"; filename\*=UTF-8''/);
  assert.match(decodeURIComponent(result.headers['content-disposition']), /Выписка ЕГРН\.pdf/);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(JSON.stringify(result.headers).includes(SECRET), false);
  assert.deepEqual(h.calls, ['ensure', ['get', ID], ['chunks', ID]]);
});

for(const emptyTail of [false,true])test('a late stored-original integrity failure cannot become a completed HTTP download, empty tail='+emptyTail,async t=>{
  const data=Buffer.from('%PDF-1.7\ncorrupted same-size original\n');
  const h=await fixture(t,{async get(){return{name:'original.pdf',mime:'application/pdf',bytes:data.length};},async *chunks(){yield data.subarray(0,8);yield data.subarray(8);if(emptyTail)yield Buffer.alloc(0);await new Promise(resolve=>setTimeout(resolve,25));throw Object.assign(new Error('Stored checksum mismatch'),{code:'EGRN_FILE_CORRUPT'});}});
  await assert.rejects(request(h.port,routePath(url())),/aborted|reset|socket|closed/i);
});

test('the final original bytes reach the client only after successful iterator integrity completion',async t=>{
  const data=Buffer.from('%PDF-1.7\nverified original\n');let verified=false;
  const h=await fixture(t,{async get(){return{name:'original.pdf',mime:'application/pdf',bytes:data.length};},async *chunks(){yield data;await new Promise(resolve=>setTimeout(resolve,25));verified=true;}});
  const result=await request(h.port,routePath(url()));assert.equal(result.status,200);assert.ok(result.body.equals(data));assert.equal(verified,true);
});

test('HEAD exposes the same size and filename without opening or buffering the body', async t => {
  const h = await fixture(t), result = await request(h.port, routePath(url()), 'HEAD');
  assert.equal(result.status, 200); assert.equal(result.body.length, 0);
  assert.equal(result.headers['content-length'], String(h.data.length));
  assert.match(result.headers['content-disposition'], /^attachment;/);
  assert.deepEqual(h.calls, ['ensure', ['get', ID]]);
});

test('expired, tampered, cross-file and malformed capabilities never access the store', async t => {
  const h = await fixture(t);
  const tampered = url(); tampered.searchParams.set('sig', '0'.repeat(64));
  const crossFile = url(); crossFile.pathname = crossFile.pathname.replace(ID, OTHER_ID);
  const changedExpiry = url(); changedExpiry.searchParams.set('exp', String(NOW / 1000 + 60));
  const duplicate = url(); duplicate.searchParams.append('sig', duplicate.searchParams.get('sig'));
  const invalidId = url(); invalidId.pathname = invalidId.pathname.replace(ID, 'not-a-uuid');
  const expired = url(ID, { now: () => NOW - 8 * 86400 * 1000 });
  const unbounded = url(ID, { now: () => NOW + 2 * 86400 * 1000 });
  for (const link of [tampered, crossFile, changedExpiry, duplicate, invalidId, expired, unbounded]) {
    const result = await request(h.port, routePath(link));
    assert.equal(result.status, 403); assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.equal(result.body.toString().includes(SECRET), false);
  }
  const unsigned = await request(h.port, '/egrn-files/' + ID + '/download'); assert.equal(unsigned.status, 403);
  assert.deepEqual(h.calls, []);
});

test('valid signatures cannot turn missing files or store failures into a successful download', async t => {
  const h = await fixture(t);
  assert.equal((await request(h.port, routePath(url(OTHER_ID)))).status, 404);
  h.store.get = async () => { throw new Error('internal database details must remain private'); };
  const failure = await request(h.port, routePath(url()));
  assert.equal(failure.status, 503); assert.doesNotMatch(failure.body.toString(), /database|internal|details/);
  assert.equal(failure.headers['content-disposition'], undefined);
});

test('ZIP attachments retain their format and sanitize filenames without exposing a stored path or header controls', async t => {
  const data = Buffer.from('PK\x03\x04synthetic-zip');
  const h = await fixture(t, {
    async get() { return { filename: '/private/archive/План"\r\nInjected: yes.zip', mime_type: 'application/x-zip-compressed', bytes: String(data.length) }; },
    async *chunks() { yield data; }
  });
  const result = await request(h.port, routePath(url()));
  assert.equal(result.status, 200); assert.deepEqual(result.body, data); assert.equal(result.headers['content-type'], 'application/zip');
  const disposition = result.headers['content-disposition'];
  assert.match(disposition, /^attachment; filename="egrn\.zip";/);
  assert.doesNotMatch(disposition, /private|archive|[\r\n]/);
  assert.equal(result.headers.injected, undefined);
});

test('100 MiB HTTP download is streamed with backpressure and matches a separately computed hash', async t => {
  const totalChunks = 100, chunk = Buffer.alloc(1024 * 1024, 0x65), expected = crypto.createHash('sha256');
  for (let i = 0; i < totalChunks; i++) expected.update(chunk);
  const expectedHash = expected.digest('hex'); let produced = 0, completed = false;
  const h = await fixture(t, {
    async get() { return { name: 'large.pdf', mime: 'application/pdf', bytes: totalChunks * chunk.length }; },
    async *chunks() { try { for (let i = 0; i < totalChunks; i++) { produced++; yield chunk; } } finally { completed = true; } }
  });
  const result = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: h.port, path: routePath(url()) }, res => {
      res.pause();
      setTimeout(async () => {
        try {
          assert.ok(produced < totalChunks, 'A paused client must stop the producer before the complete file is buffered');
          const received = crypto.createHash('sha256'); let bytes = 0;
          for await (const part of res) { bytes += part.length; received.update(part); }
          resolve({ bytes, hash: received.digest('hex'), status: res.statusCode, length: res.headers['content-length'] });
        } catch (error) { res.destroy(); reject(error); }
      }, 40);
    });
    req.on('error', reject);
  });
  assert.equal(result.status, 200); assert.equal(result.bytes, 100 * 1024 * 1024);
  assert.equal(result.length, String(result.bytes)); assert.equal(result.hash, expectedHash); assert.equal(completed, true);
});

test('disconnecting a download closes the producer instead of draining the remaining file', async t => {
  let produced = 0, stopped;
  const closed = new Promise(resolve => { stopped = resolve; });
  const h = await fixture(t, {
    async get() { return { name: 'large.pdf', mime: 'application/pdf', bytes: 256 * 1024 * 1024 }; },
    async *chunks() { try { for (let i = 0; i < 4096; i++) { produced++; yield Buffer.alloc(64 * 1024); } } finally { stopped(); } }
  });
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: h.port, path: routePath(url()) }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
  let timeout;
  await Promise.race([closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The source was not closed after disconnect')), 2000); })]).finally(() => clearTimeout(timeout));
  assert.ok(produced < 4096, 'Aborting must stop the source, not finish reading the stored file');
});
