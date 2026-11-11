'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const { createEgrnObjectStore } = require('../src/bot/egrn-object-store');
const { createEgrnFileStore } = require('../src/bot/egrn-files');
const { createDownloadUrl, setupEgrnDownloads } = require('../src/web/egrn-downloads');

const MiB = 1024 * 1024, BYTES = 100 * MiB;
const ID = '00000000-0000-5000-8000-000000000001';
const KEY = 'egrn-originals/' + ID + '/00000000-0000-4000-8000-000000000002';
const SECRET = 'synthetic-seven-day-download-link-signing-secret';
const ACCESS = 'synthetic-access-key', S3_SECRET = 'synthetic-object-secret-not-live';
const BUCKET = 'synthetic-direct-files', HOST = BUCKET + '.storage.example.test';
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Independent SigV4 verifier: this does not use the AWS presigner or production
// signing helpers. Transport is mapped to localhost while the signed Host,
// method, path and query remain exactly those the browser receives.
function validSignature(url, now) {
  const q = url.searchParams;
  if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || q.get('X-Amz-SignedHeaders') !== 'host') return false;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(q.get('X-Amz-Date') || '');
  if (!match) return false;
  const at = Date.UTC(...match.slice(1).map((value, i) => Number(value) - (i === 1 ? 1 : 0)));
  const seconds = Number(q.get('X-Amz-Expires'));
  if (!Number.isInteger(seconds) || seconds < 1 || now < at || now >= at + seconds * 1000) return false;
  const [access, date, region, service, terminal] = (q.get('X-Amz-Credential') || '').split('/');
  if (access !== ACCESS || date !== match[1] + match[2] + match[3] || region !== 'auto' || service !== 's3' || terminal !== 'aws4_request') return false;
  const query = [...q].filter(([key]) => key !== 'X-Amz-Signature').map(([key, value]) => [encode(key), encode(value)])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(pair => pair.join('=')).join('&');
  const canonical = ['GET', url.pathname, query, 'host:' + url.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = [date, region, service, terminal].join('/');
  const value = ['AWS4-HMAC-SHA256', q.get('X-Amz-Date'), scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + S3_SECRET, date), region), service), terminal);
  return hmac(key, value).toString('hex') === q.get('X-Amz-Signature');
}

function queryString(query) {
  const out = new URLSearchParams();
  for (const [name, value] of Object.entries(query || {})) for (const item of Array.isArray(value) ? value : [value]) out.append(name, String(item));
  return out.toString();
}
function localRequest(port, url, extra = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: url.pathname + url.search, headers: { host: url.host, ...extra } }, response => {
      const hash = createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0);
      response.on('data', chunk => { bytes += chunk.length; hash.update(chunk); if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes, hash: hash.digest('hex'), prefix }));
    });
    request.setTimeout(30000, () => request.destroy(new Error('Synthetic local download timed out')));
    request.on('error', reject); request.end();
  });
}
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function close(server) { if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }

test('100 MiB original downloads directly from independently verified private S3, including ranges, expiry and fresh links', { timeout: 90000 }, async () => {
  let directory, provider, appServer, db, client;
  try {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'egrn-direct-e2e-'));
    const original = path.join(directory, 'original.pdf'), expected = createHash('sha256');
    async function* source() {
      for (let i = 0; i < 100; i++) {
        const chunk = Buffer.alloc(MiB, (i * 17 + 3) % 251); if (!i) chunk.write('%PDF-1.7\n');
        expected.update(chunk); yield chunk;
      }
    }
    await pipeline(Readable.from(source()), fs.createWriteStream(original, { flags: 'wx' }));
    const sha256 = expected.digest('hex');
    let now = Date.UTC(2026, 10, 11, 12), heads = 0, providerGets = 0, providerBytes = 0;
    provider = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'https://' + req.headers.host);
        if (req.headers.host !== HOST || url.pathname !== '/' + KEY) { res.writeHead(404).end(); return; }
        if (req.method === 'HEAD') {
          heads++; res.writeHead(200, { 'content-length': BYTES, 'x-amz-meta-sha256': sha256, 'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64') }).end(); return;
        }
        if (req.method !== 'GET' || !validSignature(url, now)) { res.writeHead(403).end('Denied'); return; }
        providerGets++;
        const ranged = req.headers.range === 'bytes=0-31', bytes = ranged ? 32 : BYTES;
        const headers = { 'content-length': bytes, 'content-type': url.searchParams.get('response-content-type'),
          'content-disposition': url.searchParams.get('response-content-disposition'), 'cache-control': url.searchParams.get('response-cache-control'), 'accept-ranges': 'bytes' };
        if (ranged) headers['content-range'] = 'bytes 0-31/' + BYTES;
        res.writeHead(ranged ? 206 : 200, headers);
        const content = fs.createReadStream(original, ranged ? { start: 0, end: 31 } : {});
        content.on('data', part => { providerBytes += part.length; }); await pipeline(content, res);
      } catch (error) { res.destroy(error); }
    });
    const providerPort = await listen(provider), sdkMethods = [];
    client = new S3Client({ endpoint: 'https://storage.example.test', region: 'auto',
      credentials: { accessKeyId: ACCESS, secretAccessKey: S3_SECRET }, forcePathStyle: false, maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { handle(request) {
        sdkMethods.push(request.method);
        return new Promise((resolve, reject) => {
          const query = queryString(request.query);
          const forwarded = http.request({ host: '127.0.0.1', port: providerPort, method: request.method,
            path: request.path + (query ? '?' + query : ''), headers: { ...request.headers, host: request.hostname } }, response => {
            resolve({ response: { statusCode: response.statusCode, headers: response.headers, body: response } });
          });
          forwarded.on('error', reject); forwarded.end();
        });
      } }
    });
    const env = { EGRN_S3_ENDPOINT: 'https://storage.example.test', EGRN_S3_BUCKET: BUCKET,
      EGRN_S3_ACCESS_KEY_ID: ACCESS, EGRN_S3_SECRET_ACCESS_KEY: S3_SECRET, EGRN_S3_REGION: 'auto' };
    const objects = createEgrnObjectStore({ env, client, now: () => now });
    const { PGlite } = require(process.env.PGLITE_TEST_MODULE || '@electric-sql/pglite'); db = new PGlite();
    const sql = [];
    const pool = {
      async query(query, params) { sql.push(query); return params ? db.query(query, params) : db.exec(query); },
      async connect() { return { query: pool.query, release() {} }; }
    };
    const files = createEgrnFileStore(pool, { objectStore: objects }); await files.ensure();
    await pool.query("INSERT INTO egrn_files(id,egrn_order_id,source_key,name,mime,bytes,sha256,storage,object_key) VALUES($1,1,'synthetic-source',$2,'application/pdf',$3,$4,'s3',$5)",
      [ID, '/private/archive/Выписка\r\nподмена.pdf', BYTES, sha256, KEY]);
    let botBodyReads = 0;
    const store = { ...files, async *chunks() { botBodyReads++; assert.fail('The bot must not read or proxy S3 document bytes'); } };
    const app = express(); setupEgrnDownloads(app, { store, secret: SECRET, now: () => now });
    appServer = http.createServer(app); const appPort = await listen(appServer);
    const outerOptions = { origin: 'https://bot.example.test', secret: SECRET, now: () => now };
    const outer = new URL(createDownloadUrl(ID, outerOptions));
    const before = await localRequest(appPort, outer);
    assert.equal(before.status, 302); assert.equal(before.bytes, 0); assert.equal(before.headers['cache-control'], 'private, no-store');
    assert.equal(before.headers['referrer-policy'], 'no-referrer');
    const direct = new URL(before.headers.location);
    assert.equal(direct.host, HOST); assert.equal(Number(direct.searchParams.get('X-Amz-Expires')), 300);
    assert.equal(direct.href.includes(S3_SECRET), false); assert.equal(direct.href.includes(SECRET), false);
    const received = await localRequest(providerPort, direct);
    assert.equal(received.status, 200); assert.equal(received.bytes, BYTES); assert.equal(received.hash, sha256);
    assert.equal(received.headers['content-type'], 'application/pdf');
    assert.equal(received.headers['cache-control'], 'private, no-store');
    assert.match(decodeURIComponent(received.headers['content-disposition']), /Выпискаподмена\.pdf/);
    assert.doesNotMatch(received.headers['content-disposition'], /private|archive|[\r\n]/);
    const range = await localRequest(providerPort, direct, { range: 'bytes=0-31' });
    assert.equal(range.status, 206); assert.equal(range.bytes, 32); assert.equal(range.prefix.subarray(0, 5).toString(), '%PDF-');
    const tampered = new URL(direct); tampered.searchParams.set('response-content-disposition', 'inline');
    assert.equal((await localRequest(providerPort, tampered)).status, 403);
    const unsigned = new URL(direct); unsigned.search = '';
    assert.equal((await localRequest(providerPort, unsigned)).status, 403);
    now += 301000;
    assert.equal((await localRequest(providerPort, direct)).status, 403);
    const fresh = await localRequest(appPort, outer); assert.equal(fresh.status, 302);
    const refreshed = new URL(fresh.headers.location); assert.notEqual(refreshed.href, direct.href);
    assert.equal((await localRequest(providerPort, refreshed, { range: 'bytes=0-31' })).status, 206);
    now += 7 * 86400000;
    const previousHeads = heads;
    assert.equal((await localRequest(appPort, outer)).status, 403); assert.equal(heads, previousHeads);
    const renewedOuter = new URL(createDownloadUrl(ID, outerOptions));
    const renewed = await localRequest(appPort, renewedOuter); assert.equal(renewed.status, 302);
    assert.equal((await localRequest(providerPort, new URL(renewed.headers.location), { range: 'bytes=0-31' })).status, 206);
    assert.equal(botBodyReads, 0); assert.ok(heads >= 3); assert.equal(providerGets, 4);
    assert.equal(providerBytes, BYTES + 96); assert.ok(sdkMethods.every(method => method === 'HEAD'));
    assert.equal(sql.some(query => /egrn_file_chunks.*SELECT|SELECT.*egrn_file_chunks|INSERT INTO egrn_orders/i.test(query)), false);
  } finally {
    client?.destroy(); await close(appServer); await close(provider); await db?.close();
    if (directory) await fsp.rm(directory, { recursive: true, force: true });
  }
});
