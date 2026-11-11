const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');

const FIELDS = ['ENDPOINT', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION'];
const KEY = /^(egrn-originals|audit-originals)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
const AUDIT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif', 'image/tiff', 'image/bmp']);
const SAFE_ERROR = Symbol('safe-egrn-storage-error');
function failure(code, error) {
  if (error?.[SAFE_ERROR]) return error;
  if (/^EGRN_FILE_[A-Z_]+$/.test(error?.code || '')) return Object.assign(new Error('Не удалось подтвердить оригинал выписки.'),
    { code: error.code, status: Number.isInteger(error.status) ? error.status : 409, [SAFE_ERROR]: true });
  const result = Object.assign(new Error('Хранилище оригиналов выписок временно недоступно.'), { code, status: 503, [SAFE_ERROR]: true });
  if (Number.isInteger(error?.$metadata?.httpStatusCode)) result.provider_status = error.$metadata.httpStatusCode;
  if (/^[A-Za-z][A-Za-z\d]{0,80}$/.test(error?.name || '')) result.provider_code = error.name;
  return result;
}
function configuration(env) {
  const values = FIELDS.map(name => env['EGRN_S3_' + name]);
  if (values.every(value => value === undefined || value === '')) return null;
  if (values.some(value => typeof value !== 'string' || !value.trim())) throw failure('EGRN_OBJECT_CONFIG');
  const [endpoint, bucket, accessKeyId, secretAccessKey, region] = values.map(value => value.trim());
  let url;
  try { url = new URL(endpoint); } catch (_) {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z\d][a-z\d.-]{1,61}[a-z\d]$/.test(bucket) || !/^[a-z\d-]{1,64}$/.test(region)) throw failure('EGRN_OBJECT_CONFIG');
  return { endpoint: url.origin, bucket, region, credentials: { accessKeyId, secretAccessKey } };
}
function validKey(key, namespace) { return KEY.exec(key || '')?.[1] === namespace; }
function validate(file, namespace) {
  if (!file || !validKey(file.key, namespace) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 2147483647 ||
      !/^[0-9a-f]{64}$/.test(file.sha256 || '')) throw failure('EGRN_OBJECT_ARGUMENT');
}
function verify(object, file) {
  const checksum = Buffer.from(file.sha256, 'hex').toString('base64');
  if (Number(object.ContentLength) !== file.bytes || object.Metadata?.sha256 !== file.sha256 ||
      object.ChecksumSHA256 && object.ChecksumSHA256 !== checksum) throw failure('EGRN_OBJECT_VERIFY');
}
function createEgrnObjectStore(options = {}) {
  const env = options.env || process.env;
  const namespace = options.namespace || 'egrn-originals';
  if (!['egrn-originals', 'audit-originals'].includes(namespace)) throw failure('EGRN_OBJECT_ARGUMENT');
  let context;
  function configured() { return !!configuration(env); }
  function client() {
    const config = configuration(env);
    if (!config) throw failure('EGRN_OBJECT_CONFIG');
    if (!context) {
      const sdk = options.sdk || require('@aws-sdk/client-s3');
      // Railway's current buckets use virtual-hosted URLs. Known-size streams
      // carry an explicit SHA-256 header instead of an automatic CRC trailer.
      const connection = options.client || new sdk.S3Client({ endpoint: config.endpoint, region: config.region,
        credentials: config.credentials, forcePathStyle: false, maxAttempts: 1,
        requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
      context = { config, connection, sdk };
    }
    return context;
  }
  async function put(file) {
    validate(file, namespace);
    if (typeof file.body?.[Symbol.asyncIterator] !== 'function' || !(namespace === 'audit-originals' ? AUDIT_TYPES.has(file.mime) : ['application/pdf', 'application/zip'].includes(file.mime))) throw failure('EGRN_OBJECT_ARGUMENT');
    const { config, connection, sdk } = client(), controller = new AbortController();
    const body = Readable.from(file.body, { objectMode: false, highWaterMark: 1024 * 1024 });
    const completion = finished(body, { cleanup: true }); completion.catch(() => {});
    let timedOut = false, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; }); aborted.catch(() => {});
    const abort = () => { const error = failure('EGRN_OBJECT_CANCELLED'); controller.abort(); body.destroy(error); rejectAbort(error); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs || 20 * 60 * 1000);
    file.signal?.addEventListener('abort', abort, { once: true });
    if (file.signal?.aborted) abort();
    try {
      await Promise.race([connection.send(new sdk.PutObjectCommand({ Bucket: config.bucket, Key: file.key, Body: body,
        ContentLength: file.bytes, ContentType: file.mime,
        ChecksumSHA256: Buffer.from(file.sha256, 'hex').toString('base64'), Metadata: { sha256: file.sha256 } }), { abortSignal: controller.signal }), aborted]);
      // Readable.from may wait for an async iterator which ignores destroy.
      // Its completion must share the PUT deadline, including an early SDK ACK.
      await Promise.race([completion, aborted]);
      const stored = await Promise.race([connection.send(new sdk.HeadObjectCommand({ Bucket: config.bucket, Key: file.key, ChecksumMode: 'ENABLED' }), { abortSignal: controller.signal }), aborted]);
      verify(stored, file);
    } catch (error) {
      // Destruction requests iterator cleanup, but awaiting its return can
      // defeat the deadline forever when the source is stalled. The rejection
      // handler above keeps late cleanup failures observed.
      controller.abort(); body.destroy();
      throw timedOut ? failure('EGRN_OBJECT_TIMEOUT') : failure('EGRN_OBJECT_WRITE', error);
    } finally { clearTimeout(timer); file.signal?.removeEventListener('abort', abort); }
  }
  async function get(file) {
    validate(file, namespace);
    const controller = new AbortController(); let body, rejectAbort, cleaned = false;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; }); aborted.catch(() => {});
    const abort = () => {
      const error = failure('EGRN_OBJECT_CANCELLED');
      controller.abort(); body?.destroy?.(error); rejectAbort(error);
    };
    const timer = setTimeout(() => {
      const error = failure('EGRN_OBJECT_TIMEOUT'); controller.abort(); body?.destroy?.(error); rejectAbort(error);
    }, options.timeoutMs || 20 * 60 * 1000);
    function cleanup() { if (cleaned) return; cleaned = true; clearTimeout(timer); file.signal?.removeEventListener('abort', abort); }
    file.signal?.addEventListener('abort', abort, { once: true });
    if (file.signal?.aborted) abort();
    try {
      const { config, connection, sdk } = client();
      const pending = connection.send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key: file.key, ChecksumMode: 'ENABLED' }), { abortSignal: controller.signal });
      Promise.resolve(pending).then(value => { if (controller.signal.aborted) value?.Body?.destroy?.(); }, () => {});
      const object = await Promise.race([pending, aborted]);
      body = object.Body;
      body?.once?.('end', cleanup); body?.once?.('close', cleanup); body?.once?.('error', cleanup);
      try {
        verify(object, file);
        if (typeof object.Body?.[Symbol.asyncIterator] !== 'function') throw failure('EGRN_OBJECT_READ');
      } catch (error) { object.Body?.destroy?.(); throw error; }
      return object.Body;
    } catch (error) { cleanup(); body?.destroy?.(); throw failure('EGRN_OBJECT_READ', error); }
  }
  async function downloadUrl(file, { expiresIn = 300, expiresAt } = {}) {
    validate(file, namespace);
    const type = String(file.mime || '').toLowerCase().split(';')[0].trim();
    if (namespace !== 'egrn-originals' || !['application/pdf', 'application/zip'].includes(type) ||
        !Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 300 ||
        expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 1)) throw failure('EGRN_OBJECT_ARGUMENT');
    function now() {
      const value = typeof options.now === 'function' ? options.now() : Date.now();
      if (!Number.isSafeInteger(value) || value < 0) throw failure('EGRN_OBJECT_ARGUMENT');
      return value;
    }
    function remaining(at) {
      const ttl = Math.min(expiresIn, expiresAt === undefined ? expiresIn : expiresAt - Math.floor(at / 1000));
      if (ttl < 1) throw Object.assign(failure('EGRN_OBJECT_EXPIRED'), { status: 403 });
      return ttl;
    }
    remaining(now());
    const extension = type === 'application/pdf' ? 'pdf' : 'zip';
    let name = Buffer.from(String(file.name || ''), 'utf8').toString('utf8').split(/[\\/]/).pop()
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
    name = Array.from(name).slice(0, 180).join('');
    if (!name || name === '.' || name === '..') name = 'Выписка ЕГРН.' + extension;
    else if (!name.toLowerCase().endsWith('.' + extension)) name += '.' + extension;
    const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const disposition = 'attachment; filename="egrn.' + extension + '"; filename*=UTF-8\'\'' + encoded;
    const controller = new AbortController(); let timedOut = false, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; }); aborted.catch(() => {});
    const abort = () => { controller.abort(); rejectAbort(failure('EGRN_OBJECT_CANCELLED')); };
    const timeout = Math.min(30000, Math.max(1, options.signingTimeoutMs || options.timeoutMs || 30000));
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
    file.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (file.signal?.aborted) { abort(); throw failure('EGRN_OBJECT_CANCELLED'); }
      const { config, connection, sdk } = client();
      // A presigned GET transfers bytes directly from the private bucket. HEAD
      // verifies the persisted original without reading it through the bot.
      const stored = await Promise.race([connection.send(new sdk.HeadObjectCommand({ Bucket: config.bucket, Key: file.key,
        ChecksumMode: 'ENABLED' }), { abortSignal: controller.signal }), aborted]);
      verify(stored, file);
      const signingDate = new Date(now()), ttl = remaining(signingDate.getTime());
      if (controller.signal.aborted) throw failure('EGRN_OBJECT_CANCELLED');
      const sign = options.getSignedUrl || require('@aws-sdk/s3-request-presigner').getSignedUrl;
      const url = await Promise.race([sign(connection, new sdk.GetObjectCommand({ Bucket: config.bucket, Key: file.key,
        ResponseContentType: type, ResponseContentDisposition: disposition, ResponseCacheControl: 'private, no-store' }), { expiresIn: ttl, signingDate }), aborted]);
      remaining(now());
      const parsed = new URL(url), endpoint = new URL(config.endpoint);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash ||
          parsed.hostname !== config.bucket + '.' + endpoint.hostname || parsed.pathname !== '/' + file.key ||
          parsed.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' ||
          parsed.searchParams.get('X-Amz-Expires') !== String(ttl) ||
          !/^[0-9a-f]{64}$/.test(parsed.searchParams.get('X-Amz-Signature') || '')) throw failure('EGRN_OBJECT_SIGN');
      return parsed.href;
    } catch (error) {
      controller.abort();
      throw timedOut ? failure('EGRN_OBJECT_TIMEOUT') : failure('EGRN_OBJECT_SIGN', error);
    } finally { clearTimeout(timer); file.signal?.removeEventListener('abort', abort); }
  }
  async function remove(key) {
    if (!validKey(key, namespace)) throw failure('EGRN_OBJECT_ARGUMENT');
    const controller = new AbortController(); let timedOut = false, rejectTimeout;
    const deadline = new Promise((_, reject) => { rejectTimeout = reject; }); deadline.catch(() => {});
    const timeout = Math.min(30000, Math.max(1, options.cleanupTimeoutMs || options.timeoutMs || 30000));
    const timer = setTimeout(() => {
      timedOut = true; controller.abort(); rejectTimeout(failure('EGRN_OBJECT_TIMEOUT'));
    }, timeout);
    try {
      const { config, connection, sdk } = client();
      await Promise.race([connection.send(new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: controller.signal }), deadline]);
    } catch (error) { throw timedOut ? failure('EGRN_OBJECT_TIMEOUT') : failure('EGRN_OBJECT_DELETE', error); }
    finally { clearTimeout(timer); }
  }
  return { configured, put, get, remove, downloadUrl };
}

module.exports = { createEgrnObjectStore };
