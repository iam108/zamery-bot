const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { createEgrnObjectStore } = require('../src/bot/egrn-object-store');

const env = { EGRN_S3_ENDPOINT: 'https://t3.storageapi.dev', EGRN_S3_BUCKET: 'synthetic-files-abc123',
  EGRN_S3_REGION: 'auto', EGRN_S3_ACCESS_KEY_ID: 'synthetic-access-key', EGRN_S3_SECRET_ACCESS_KEY: 'synthetic-secret-not-live' };
const key = 'egrn-originals/00000000-0000-5000-8000-000000000001/00000000-0000-4000-8000-000000000002';
const data = Buffer.from('%PDF-1.7\nsynthetic original only');
const sha256 = createHash('sha256').update(data).digest('hex');
const file = () => ({ key, bytes: data.length, sha256, mime: 'application/pdf', body: (async function* () { yield data.subarray(0, 5); yield data.subarray(5); })() });
const sdk = Object.fromEntries(['PutObjectCommand', 'HeadObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand'].map(name => [name, class { constructor(input) { this.input = input; this.operation = name; } }]));
function fixture(overrides = {}) {
  const calls = [], objects = new Map();
  const client = { async send(command, options) {
    const { input, operation } = command; calls.push({ input, operation, options });
    if (overrides.send) return overrides.send(command, options);
    if (operation === 'PutObjectCommand') {
      assert.ok(input.Body instanceof Readable);
      assert.equal(Buffer.isBuffer(input.Body), false);
      const parts = []; for await (const part of input.Body) parts.push(part);
      const buffer = Buffer.concat(parts), hash = createHash('sha256').update(buffer).digest();
      objects.set(input.Key, { buffer, ContentLength: buffer.length, ChecksumSHA256: hash.toString('base64'), Metadata: input.Metadata });
      return {};
    }
    if (operation === 'HeadObjectCommand') return objects.get(input.Key);
    if (operation === 'GetObjectCommand') return { ...objects.get(input.Key), Body: Readable.from([objects.get(input.Key).buffer]) };
    if (operation === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
    throw new Error('Unexpected command');
  } };
  return { calls, objects, client, store: createEgrnObjectStore({ env, sdk, client, ...overrides }) };
}

test('S3 is optional, but partial or unsafe configuration never silently falls back', () => {
  assert.equal(createEgrnObjectStore({ env: {} }).configured(), false);
  for (const changed of [{ EGRN_S3_SECRET_ACCESS_KEY: '' }, { EGRN_S3_ENDPOINT: 'http://t3.storageapi.dev' },
    { EGRN_S3_ENDPOINT: 'https://user:pass@t3.storageapi.dev' }, { EGRN_S3_ENDPOINT: 'https://t3.storageapi.dev/path' },
    { EGRN_S3_ENDPOINT: 'https://t3.storageapi.dev/?token=private' }, { EGRN_S3_BUCKET: '../other' }]) {
    assert.throws(() => createEgrnObjectStore({ env: { ...env, ...changed } }).configured(), error => error.code === 'EGRN_OBJECT_CONFIG');
  }
});

test('known-size streaming upload carries SHA-256 and checks durable HEAD before succeeding', async () => {
  const h = fixture(); await h.store.put(file());
  assert.deepEqual(h.calls.map(call => call.operation), ['PutObjectCommand', 'HeadObjectCommand']);
  const input = h.calls[0].input;
  assert.equal(input.ContentLength, data.length);
  assert.equal(input.ChecksumSHA256, Buffer.from(sha256, 'hex').toString('base64'));
  assert.deepEqual(input.Metadata, { sha256 });
  assert.equal(input.Bucket, env.EGRN_S3_BUCKET);
  assert.equal(input.ACL, undefined); // Railway buckets stay private.
  const body = await h.store.get({ key, bytes: data.length, sha256 });
  const parts = []; for await (const part of body) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), data);
  await h.store.remove(key); assert.equal(h.objects.size, 0);
});

test('SDK uses virtual-hosted style, explicit checksums and no retries of a one-shot stream', async () => {
  const h = fixture(); let config;
  const SDK = { ...sdk, S3Client: class { constructor(value) { config = value; } send(...args) { return h.client.send(...args); } } };
  await createEgrnObjectStore({ env, sdk: SDK }).put(file());
  assert.equal(config.endpoint, env.EGRN_S3_ENDPOINT);
  assert.equal(config.region, 'auto');
  assert.equal(config.forcePathStyle, false);
  assert.equal(config.maxAttempts, 1);
  assert.equal(config.requestChecksumCalculation, 'WHEN_REQUIRED');
  assert.equal(config.responseChecksumValidation, 'WHEN_REQUIRED');
});

test('wrong durable length, hash or missing metadata rejects the completed upload', async () => {
  for (const changed of [{ ContentLength: data.length - 1 }, { ChecksumSHA256: Buffer.alloc(32).toString('base64') }, { Metadata: {} }]) {
    const h = fixture({ send: async command => {
      if (command.operation === 'PutObjectCommand') { for await (const part of command.input.Body) {} return {}; }
      return { ContentLength: data.length, ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'), Metadata: { sha256 }, ...changed };
    } });
    await assert.rejects(h.store.put(file()), error => error.code === 'EGRN_OBJECT_VERIFY');
  }
});

test('invalid keys and GET metadata cannot escape the private namespace or expose wrong bytes', async () => {
  const h = fixture();
  await assert.rejects(h.store.remove('../other-file'), error => error.code === 'EGRN_OBJECT_ARGUMENT');
  await assert.rejects(h.store.put({ ...file(), key: 'https://files.example/private' }), error => error.code === 'EGRN_OBJECT_ARGUMENT');
  assert.equal(h.calls.length, 0);
  let returned;
  const bad = fixture({ send: async () => { returned = Readable.from([data]); return { ContentLength: 1, Metadata: { sha256 }, Body: returned }; } });
  await assert.rejects(bad.store.get({ key, bytes: data.length, sha256 }), error => error.code === 'EGRN_OBJECT_VERIFY');
  assert.equal(returned.destroyed, true);
});

test('SDK failures are sanitized, while stream integrity failures retain their safe code', async () => {
  const h = fixture({ send: async () => { throw Object.assign(new Error('https://private.example/?key=' + env.EGRN_S3_SECRET_ACCESS_KEY), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }); } });
  await assert.rejects(h.store.put(file()), error => {
    assert.equal(error.code, 'EGRN_OBJECT_WRITE'); assert.equal(error.provider_status, 403);
    assert.equal(error.provider_code, 'AccessDenied');
    assert.equal(String(error.stack).includes(env.EGRN_S3_SECRET_ACCESS_KEY), false);
    assert.equal(String(error.stack).includes('private.example'), false); return true;
  });
  const broken = fixture();
  await assert.rejects(broken.store.put({ ...file(), body: (async function* () { throw Object.assign(new Error('Incorrect original hash.'), { code: 'EGRN_FILE_CHANGED' }); })() }), error => error.code === 'EGRN_FILE_CHANGED');
  const forged = fixture({ send: async () => { throw Object.assign(new Error(env.EGRN_S3_SECRET_ACCESS_KEY), { code: 'EGRN_OBJECT_CONFIG' }); } });
  await assert.rejects(forged.store.put(file()), error => error.code === 'EGRN_OBJECT_WRITE' && !String(error.stack).includes(env.EGRN_S3_SECRET_ACCESS_KEY));
});

test('an unresponsive SDK cannot keep an upload pending beyond the configured deadline', { timeout: 1000 }, async () => {
  const h = fixture({ timeoutMs: 15, send: () => new Promise(() => {}) });
  await assert.rejects(h.store.put(file()), error => error.code === 'EGRN_OBJECT_TIMEOUT');
  assert.equal(h.calls[0].options.abortSignal.aborted, true);
  assert.equal(h.calls[0].input.Body.destroyed, true);
});

test('a stalled object download times out before headers and aborts the SDK request', {timeout:1000},async()=>{
  const h=fixture({timeoutMs:15,send:()=>new Promise(()=>{})});
  await assert.rejects(h.store.get({key,bytes:data.length,sha256}),error=>error.code==='EGRN_OBJECT_TIMEOUT');
  assert.equal(h.calls[0].options.abortSignal.aborted,true);
});

test('cancelling a download destroys an already opened object stream',async()=>{
  const h=fixture();await h.store.put(file());const controller=new AbortController();
  const body=await h.store.get({key,bytes:data.length,sha256,signal:controller.signal});
  controller.abort();assert.equal(body.destroyed,true);
  await new Promise(resolve=>setImmediate(resolve));
});

test('an object arriving after cancellation is closed rather than left unread',async()=>{
  let complete;
  const h=fixture({send:()=>new Promise(resolve=>{complete=resolve;})}),controller=new AbortController();
  const pending=h.store.get({key,bytes:data.length,sha256,signal:controller.signal});
  controller.abort();await assert.rejects(pending,error=>error.code==='EGRN_OBJECT_CANCELLED');
  const body=Readable.from([data]);complete({ContentLength:data.length,Metadata:{sha256},Body:body});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(body.destroyed,true);
});

test('cleanup DELETE has a bounded deadline even when the SDK ignores cancellation', { timeout: 1000 }, async () => {
  const h = fixture({ cleanupTimeoutMs: 15, send: () => new Promise(() => {}) });
  await assert.rejects(h.store.remove(key), error => error.code === 'EGRN_OBJECT_TIMEOUT' && error.status === 503);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].operation, 'DeleteObjectCommand');
  assert.equal(h.calls[0].options.abortSignal.aborted, true);
});

test('cleanup clears its deadline after success or sanitized provider failure', async () => {
  const successful = fixture({ cleanupTimeoutMs: 10 });
  await successful.store.remove(key);
  const failed = fixture({ cleanupTimeoutMs: 10, send: async () => {
    throw Object.assign(new Error('https://private.example/?key=' + env.EGRN_S3_SECRET_ACCESS_KEY), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  } });
  await assert.rejects(failed.store.remove(key), error => {
    assert.equal(error.code, 'EGRN_OBJECT_DELETE'); assert.equal(error.provider_status, 403);
    assert.equal(String(error.stack).includes(env.EGRN_S3_SECRET_ACCESS_KEY), false);
    assert.equal(String(error.stack).includes('private.example'), false); return true;
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(successful.calls[0].options.abortSignal.aborted, false);
  assert.equal(failed.calls[0].options.abortSignal.aborted, false);
});

test('the real AWS SDK serializes streaming PUT/HEAD/GET with Content-Length and no aws-chunked trailer', async () => {
  const { S3Client } = require('@aws-sdk/client-s3');
  const requests = [];
  const checksum = Buffer.from(sha256, 'hex').toString('base64');
  const client = new S3Client({ endpoint: env.EGRN_S3_ENDPOINT, region: 'auto',
    credentials: { accessKeyId: env.EGRN_S3_ACCESS_KEY_ID, secretAccessKey: env.EGRN_S3_SECRET_ACCESS_KEY },
    forcePathStyle: false, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { async handle(request) {
      requests.push(request.method);
      assert.equal(request.hostname, env.EGRN_S3_BUCKET + '.t3.storageapi.dev');
      if (request.method === 'PUT') {
        assert.equal(request.headers['content-length'], String(data.length));
        assert.equal(request.headers['x-amz-checksum-sha256'], checksum);
        assert.notEqual(request.headers['content-encoding'], 'aws-chunked');
        assert.equal(request.headers['x-amz-decoded-content-length'], undefined);
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of request.body) { hash.update(chunk); bytes += chunk.length; }
        assert.equal(bytes, data.length); assert.equal(hash.digest('hex'), sha256);
      }
      return { response: { statusCode: request.method === 'DELETE' ? 204 : 200,
        headers: { 'content-length': String(data.length), 'x-amz-meta-sha256': sha256, 'x-amz-checksum-sha256': checksum },
        body: Readable.from(request.method === 'GET' ? [data] : []) } };
    } }
  });
  const store = createEgrnObjectStore({ env, client });
  try {
    await store.put(file());
    const body = await store.get({ key, bytes: data.length, sha256 });
    for await (const chunk of body) assert.deepEqual(chunk, data);
    await store.remove(key);
    assert.deepEqual(requests, ['PUT', 'HEAD', 'GET', 'DELETE']);
  } finally { client.destroy(); }
});
