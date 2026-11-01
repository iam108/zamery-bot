const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');

const FIELDS = ['ENDPOINT', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION'];
const KEY = /^egrn-originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
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
function validate(file) {
  if (!file || !KEY.test(file.key || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 2147483647 ||
      !/^[0-9a-f]{64}$/.test(file.sha256 || '')) throw failure('EGRN_OBJECT_ARGUMENT');
}
function verify(object, file) {
  const checksum = Buffer.from(file.sha256, 'hex').toString('base64');
  if (Number(object.ContentLength) !== file.bytes || object.Metadata?.sha256 !== file.sha256 ||
      object.ChecksumSHA256 && object.ChecksumSHA256 !== checksum) throw failure('EGRN_OBJECT_VERIFY');
}
function createEgrnObjectStore(options = {}) {
  const env = options.env || process.env;
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
    validate(file);
    if (typeof file.body?.[Symbol.asyncIterator] !== 'function' || !['application/pdf', 'application/zip'].includes(file.mime)) throw failure('EGRN_OBJECT_ARGUMENT');
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
      await completion;
      const stored = await Promise.race([connection.send(new sdk.HeadObjectCommand({ Bucket: config.bucket, Key: file.key, ChecksumMode: 'ENABLED' }), { abortSignal: controller.signal }), aborted]);
      verify(stored, file);
    } catch (error) {
      body.destroy(); await completion.catch(() => {});
      throw timedOut ? failure('EGRN_OBJECT_TIMEOUT') : failure('EGRN_OBJECT_WRITE', error);
    } finally { clearTimeout(timer); file.signal?.removeEventListener('abort', abort); }
  }
  async function get(file) {
    validate(file);
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
  async function remove(key) {
    if (!KEY.test(key || '')) throw failure('EGRN_OBJECT_ARGUMENT');
    try {
      const { config, connection, sdk } = client();
      await connection.send(new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    } catch (error) { throw failure('EGRN_OBJECT_DELETE', error); }
  }
  return { configured, put, get, remove };
}

module.exports = { createEgrnObjectStore };
