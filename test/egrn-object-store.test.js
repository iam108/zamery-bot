const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
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

test('audit originals accept images privately, and neither namespace can access the other', async () => {
  const h = fixture({ namespace: 'audit-originals' }), auditKey = key.replace('egrn-originals/', 'audit-originals/');
  for (const mime of ['image/jpeg', 'image/png', 'application/pdf']) {
    await h.store.put({ ...file(), key: auditKey, mime });
    const body = await h.store.get({ key: auditKey, bytes: data.length, sha256 });
    const chunks = []; for await (const part of body) chunks.push(part);
    assert.deepEqual(Buffer.concat(chunks), data);
    assert.equal(h.calls.at(-2).input.ACL, undefined);
  }
  await assert.rejects(h.store.put({ ...file(), key: auditKey, mime: 'image/svg+xml' }), { code: 'EGRN_OBJECT_ARGUMENT' });
  await assert.rejects(h.store.get({ key, bytes: data.length, sha256 }), { code: 'EGRN_OBJECT_ARGUMENT' });
  await assert.rejects(h.store.remove(key), { code: 'EGRN_OBJECT_ARGUMENT' });
  const egrn = fixture();
  await assert.rejects(egrn.store.put({ ...file(), mime: 'image/png' }), { code: 'EGRN_OBJECT_ARGUMENT' });
  await assert.rejects(egrn.store.get({ key: auditKey, bytes: data.length, sha256 }), { code: 'EGRN_OBJECT_ARGUMENT' });
  await assert.rejects(egrn.store.remove(auditKey), { code: 'EGRN_OBJECT_ARGUMENT' });
  assert.equal(egrn.calls.length, 0);
  assert.throws(() => createEgrnObjectStore({ namespace: '../other' }), { code: 'EGRN_OBJECT_ARGUMENT' });
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

for(const failure of ['deadline','cancel','early-ack'])test('a '+failure+' during a stalled upload iterator settles without waiting for its return', {timeout:1000},async()=>{
  let release,entered;
  const blocked=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const controller=new AbortController();let consumed=0,heads=0;
  const source=(async function*(){yield data.subarray(0,5);entered();await blocked;yield data.subarray(5);})();
  const h=fixture({timeoutMs:15,async send(command){
    if(command.operation==='PutObjectCommand') {
      const consume=(async()=>{for await(const chunk of command.input.Body)consumed+=chunk.length;})();consume.catch(()=>{});
      if(failure==='early-ack')return {};
      await consume;return {};
    }
    heads++;return {};
  }});
  const result=h.store.put({...file(),body:source,signal:controller.signal}).then(()=>({ok:true}),error=>({error}));
  try {
    await started;if(failure==='cancel')controller.abort();
    const outcome=await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve({stalled:true}),80))]);
    assert.equal(outcome.stalled,undefined,'Cleanup must not wait for the stalled async iterator');
    assert.equal(outcome.error?.code,failure==='cancel'?'EGRN_OBJECT_CANCELLED':'EGRN_OBJECT_TIMEOUT');assert.equal(heads,0);
  } finally {release();await result;}
  const after=consumed;await new Promise(resolve=>setImmediate(resolve));assert.equal(consumed,after,'A late source cannot restart the canceled PUT');
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

const signedObjectUrl = async (_client, command, options) => {
  const url = new URL('/' + command.input.Key, 'https://' + env.EGRN_S3_BUCKET + '.t3.storageapi.dev');
  url.search = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Expires': String(options.expiresIn),
    'X-Amz-Signature': 'a'.repeat(64) }).toString();
  return url.href;
};

test('direct download verifies only HEAD, signs a private GET and uses a bounded TTL', async () => {
  const signed = [], h = fixture({ getSignedUrl: async (...args) => { signed.push(args); return signedObjectUrl(...args); } });
  await h.store.put(file()); h.calls.length = 0;
  const result = new URL(await h.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf', name: '../план\r\n.pdf' }));
  assert.deepEqual(h.calls.map(x => x.operation), ['HeadObjectCommand']);
  assert.equal(h.calls[0].input.ChecksumMode, 'ENABLED');
  assert.equal(result.hostname, env.EGRN_S3_BUCKET + '.t3.storageapi.dev');
  assert.equal(result.searchParams.get('X-Amz-Expires'), '300');
  const [, command, options] = signed[0];
  assert.equal(command.operation, 'GetObjectCommand');
  assert.equal(command.input.ResponseContentType, 'application/pdf');
  assert.equal(command.input.ResponseCacheControl, 'private, no-store');
  assert.equal(command.input.ResponseContentDisposition, 'attachment; filename="egrn.pdf"; filename*=UTF-8\'\'' + encodeURIComponent('план.pdf'));
  assert.equal(options.expiresIn, 300);
  assert.ok(options.signingDate instanceof Date);
  assert.equal(command.input.ACL, undefined);
});

test('direct links reject unsupported namespaces, types and expiry before using S3', async () => {
  const h = fixture({ getSignedUrl: signedObjectUrl });
  const value = { key, bytes: data.length, sha256, mime: 'application/pdf' };
  for (const expiresIn of [0, 301, 1.5, '300', NaN]) {
    await assert.rejects(h.store.downloadUrl(value, { expiresIn }), { code: 'EGRN_OBJECT_ARGUMENT' });
  }
  for (const expiresAt of [0, -1, 1.5, '300', NaN]) {
    await assert.rejects(h.store.downloadUrl(value, { expiresAt }), { code: 'EGRN_OBJECT_ARGUMENT' });
  }
  await assert.rejects(h.store.downloadUrl({ ...value, mime: 'image/png' }), { code: 'EGRN_OBJECT_ARGUMENT' });
  await assert.rejects(h.store.downloadUrl({ ...value, key: '../another-file' }), { code: 'EGRN_OBJECT_ARGUMENT' });
  const audit = fixture({ namespace: 'audit-originals', getSignedUrl: signedObjectUrl });
  await assert.rejects(audit.store.downloadUrl({ ...value, key: key.replace('egrn-originals/', 'audit-originals/') }), { code: 'EGRN_OBJECT_ARGUMENT' });
  assert.equal(h.calls.length + audit.calls.length, 0);
});

test('a direct link is never issued for a missing or changed stored original', async () => {
  for (const changed of [{ ContentLength: 1 }, { Metadata: { sha256: '0'.repeat(64) } }, { ChecksumSHA256: 'wrong' }]) {
    let signed = false;
    const h = fixture({ send: async () => ({ ContentLength: data.length, Metadata: { sha256 }, ...changed }),
      getSignedUrl: async () => { signed = true; } });
    await assert.rejects(h.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf' }), { code: 'EGRN_OBJECT_VERIFY' });
    assert.equal(signed, false);
  }
  const missing = fixture({ send: async () => { throw Object.assign(new Error('private object key'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }); } });
  await assert.rejects(missing.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf' }), error => {
    assert.equal(error.code, 'EGRN_OBJECT_SIGN'); assert.equal(error.provider_status, 404);
    assert.equal(error.stack.includes('private object key'), false); return true;
  });
});

test('the signed lifetime cannot outlive the outer link or grow during a delayed HEAD', async () => {
  let now = 1800000000000, signedOptions;
  const h = fixture({ now: () => now, send: async () => { now += 4000; return { ContentLength: data.length, Metadata: { sha256 } }; },
    getSignedUrl: async (...args) => { signedOptions = args[2]; return signedObjectUrl(...args); } });
  const link = await h.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf' }, { expiresAt: 1800000010 });
  assert.equal(new URL(link).searchParams.get('X-Amz-Expires'), '6');
  assert.equal(signedOptions.signingDate.getTime(), now);
  assert.equal(signedOptions.signingDate.getTime() / 1000 + signedOptions.expiresIn, 1800000010);
  now = 1800000010000;
  const before = h.calls.length;
  await assert.rejects(h.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf' }, { expiresAt: 1800000010 }), { code: 'EGRN_OBJECT_EXPIRED', status: 403 });
  assert.equal(h.calls.length, before);
});

test('expiry during HEAD or signing does not produce a fresh direct link', async () => {
  for (const stage of ['head', 'sign']) {
    let now = 1800000000000, signed = false;
    const h = fixture({ now: () => now,
      send: async () => { if (stage === 'head') now += 3000; return { ContentLength: data.length, Metadata: { sha256 } }; },
      getSignedUrl: async (...args) => { signed = true; now += 3000; return signedObjectUrl(...args); } });
    await assert.rejects(h.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf' }, { expiresAt: 1800000002 }), { code: 'EGRN_OBJECT_EXPIRED' });
    assert.equal(signed, stage === 'sign');
  }
});

test('direct signing rejects unsafe URLs and never exposes provider secrets in errors', async () => {
  for (const url of ['https://outside.example/private', 'http://' + env.EGRN_S3_BUCKET + '.t3.storageapi.dev/' + key,
    'https://user:pass@' + env.EGRN_S3_BUCKET + '.t3.storageapi.dev/' + key]) {
    const h = fixture({ getSignedUrl: async () => url }); await h.store.put(file());
    await assert.rejects(h.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf' }), { code: 'EGRN_OBJECT_SIGN' });
  }
  const h = fixture({ getSignedUrl: async () => { throw new Error('https://private/?secret=' + env.EGRN_S3_SECRET_ACCESS_KEY); } }); await h.store.put(file());
  await assert.rejects(h.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf' }), error =>
    error.code === 'EGRN_OBJECT_SIGN' && !error.stack.includes(env.EGRN_S3_SECRET_ACCESS_KEY) && !error.stack.includes('https://private/'));
});

for (const stage of ['head', 'sign']) test('direct download signing has a deadline during ' + stage, { timeout: 1000 }, async () => {
  const h = fixture({ signingTimeoutMs: 15,
    send: async () => stage === 'head' ? new Promise(() => {}) : { ContentLength: data.length, Metadata: { sha256 } },
    getSignedUrl: () => new Promise(() => {}) });
  await assert.rejects(h.store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf' }), { code: 'EGRN_OBJECT_TIMEOUT' });
  assert.equal(h.calls[0].options.abortSignal.aborted, true);
});

for (const stage of ['head', 'sign']) test('direct signing aborts promptly during ' + stage + ' and a cancelled request does not contact S3', async () => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const h = fixture({ send: async () => {
    if (stage === 'head') { started(); return new Promise(() => {}); }
    return { ContentLength: data.length, Metadata: { sha256 } };
  }, getSignedUrl: () => { started(); return new Promise(() => {}); } });
  const controller = new AbortController(), value = { key, bytes: data.length, sha256, mime: 'application/pdf', signal: controller.signal };
  const pending = h.store.downloadUrl(value); await startedPromise; controller.abort();
  await assert.rejects(pending, { code: 'EGRN_OBJECT_CANCELLED' });
  const count = h.calls.length;
  await assert.rejects(h.store.downloadUrl(value), { code: 'EGRN_OBJECT_CANCELLED' });
  assert.equal(h.calls.length, count);
});

test('the real AWS signer produces a canonical private download with Unicode filename and short expiry', async () => {
  const { S3Client } = require('@aws-sdk/client-s3');
  const now = Date.UTC(2026, 10, 11, 18, 30, 0), requests = [];
  const client = new S3Client({ endpoint: env.EGRN_S3_ENDPOINT, region: 'auto', credentials: {
    accessKeyId: env.EGRN_S3_ACCESS_KEY_ID, secretAccessKey: env.EGRN_S3_SECRET_ACCESS_KEY }, forcePathStyle: false,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { async handle(request) {
      requests.push(request.method);
      return { response: { statusCode: 200, headers: { 'content-length': String(data.length), 'x-amz-meta-sha256': sha256 }, body: Readable.from([]) } };
    } } });
  try {
    const store = createEgrnObjectStore({ env, client, now: () => now });
    const result = new URL(await store.downloadUrl({ key, bytes: data.length, sha256, mime: 'application/pdf', name: 'Выписка ЕГРН №75.pdf' }, { expiresAt: Math.floor(now / 1000) + 47 }));
    assert.deepEqual(requests, ['HEAD']); // Signing never downloads the original through the bot.
    assert.equal(result.origin, 'https://' + env.EGRN_S3_BUCKET + '.t3.storageapi.dev');
    assert.equal(result.pathname, '/' + key);
    assert.equal(result.searchParams.get('X-Amz-Date'), '20261111T183000Z');
    assert.equal(result.searchParams.get('X-Amz-Expires'), '47');
    assert.equal(result.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.equal(result.searchParams.get('response-content-type'), 'application/pdf');
    assert.equal(result.searchParams.get('response-cache-control'), 'private, no-store');
    assert.equal(result.searchParams.get('response-content-disposition'), 'attachment; filename="egrn.pdf"; filename*=UTF-8\'\'' + encodeURIComponent('Выписка ЕГРН №75.pdf'));
    assert.equal(result.href.includes(env.EGRN_S3_SECRET_ACCESS_KEY), false);
    const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const canonicalQuery = [...result.searchParams].filter(([name]) => name !== 'X-Amz-Signature')
      .map(([name, value]) => encode(name) + '=' + encode(value)).sort().join('&');
    const canonical = ['GET', result.pathname, canonicalQuery, 'host:' + result.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = result.searchParams.get('X-Amz-Credential').split('/').slice(1).join('/');
    const toSign = ['AWS4-HMAC-SHA256', result.searchParams.get('X-Amz-Date'), scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
    let signingKey = Buffer.from('AWS4' + env.EGRN_S3_SECRET_ACCESS_KEY);
    for (const part of scope.split('/')) signingKey = hmac(signingKey, part);
    assert.equal(createHmac('sha256', signingKey).update(toSign).digest('hex'), result.searchParams.get('X-Amz-Signature'));
  } finally { client.destroy(); }
});
