'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const TTL_SECONDS = 7 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configError(message) {
  return Object.assign(new Error(message), { code: 'EGRN_DOWNLOAD_CONFIG' });
}
function clock(options) {
  const value = typeof options.now === 'function' ? options.now() : options.now === undefined ? Date.now() : options.now;
  const seconds = Math.floor(Number(value) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw configError('Некорректное время для ссылки на выписку.');
  return seconds;
}
function secret(options) {
  const configured = options.secret === undefined ? process.env.EGRN_DOWNLOAD_SECRET : options.secret;
  if (configured !== undefined) {
    if (!(typeof configured === 'string' || Buffer.isBuffer(configured)) || Buffer.byteLength(configured) < 32) {
      throw configError('EGRN_DOWNLOAD_SECRET должен содержать не менее 32 байт.');
    }
    return configured;
  }
  const token = process.env.BOT_TOKEN;
  if (typeof token !== 'string' || !token.trim()) throw configError('Для ссылок на выписки нужен EGRN_DOWNLOAD_SECRET или BOT_TOKEN.');
  // The bot credential itself never appears in a download URL. This key has
  // its own domain, separate from Telegram authentication and other links.
  return crypto.createHmac('sha256', token).update('zamery-bot:egrn-download-key:v1').digest();
}
function origin(options) {
  let url;
  try { url = new URL(options.origin === undefined ? process.env.WEBAPP_URL : options.origin); } catch (_) {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw configError('Для скачивания выписок задайте WEBAPP_URL: HTTPS-адрес приложения без пути и параметров.');
  }
  return url.origin;
}
function sign(id, expires, key) {
  return crypto.createHmac('sha256', key).update('egrn-file:v1\n' + id + '\n' + expires).digest('hex');
}
function createDownloadUrl(fileId, options = {}) {
  if (typeof fileId !== 'string' || !UUID.test(fileId)) throw Object.assign(new Error('Некорректный идентификатор файла выписки.'), { code: 'EGRN_DOWNLOAD_INVALID_ID' });
  const base = origin(options), key = secret(options);
  const ttl = options.ttlSeconds === undefined ? TTL_SECONDS : options.ttlSeconds;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > TTL_SECONDS) throw configError('Ссылка на выписку может действовать от 1 секунды до 7 дней.');
  const id = fileId.toLowerCase(), expires = clock(options) + ttl;
  const url = new URL('/egrn-files/' + id + '/download', base);
  url.search = new URLSearchParams({ exp: String(expires), sig: sign(id, expires, key) }).toString();
  return url.href;
}
function verify(id, query, options) {
  if (typeof id !== 'string' || !UUID.test(id) || typeof query.exp !== 'string' || !/^[1-9]\d{0,10}$/.test(query.exp) ||
      typeof query.sig !== 'string' || !/^[0-9a-f]{64}$/.test(query.sig)) return false;
  const expires = Number(query.exp), now = clock(options);
  // A small clock skew allowance also lets separate web/bot processes share
  // freshly generated seven-day links without accepting unbounded expiry.
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + TTL_SECONDS + 60) return false;
  const expected = Buffer.from(sign(id.toLowerCase(), expires, secret(options)), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(query.sig, 'hex'));
}
function metadata(file) {
  const mime = String(file.mime || file.mime_type || file.content_type || '').toLowerCase().split(';')[0].trim();
  const name = String(file.name || file.filename || '');
  const type = mime === 'application/pdf' || !mime && /\.pdf$/i.test(name) ? 'application/pdf' :
    ['application/zip', 'application/x-zip-compressed'].includes(mime) || !mime && /\.zip$/i.test(name) ? 'application/zip' : '';
  const rawBytes = file.bytes === undefined ? file.size : file.bytes;
  const bytes = typeof rawBytes === 'string' && /^\d+$/.test(rawBytes) ? Number(rawBytes) : rawBytes;
  if (!type || !Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid stored file metadata');
  const extension = type === 'application/pdf' ? 'pdf' : 'zip';
  // A stored filename is presentation only, never a filesystem path/header.
  let filename = Buffer.from(name, 'utf8').toString('utf8').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  filename = Array.from(filename).slice(0, 180).join('');
  if (!filename || filename === '.' || filename === '..') filename = 'Выписка ЕГРН.' + extension;
  else if (!filename.toLowerCase().endsWith('.' + extension)) filename += '.' + extension;
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return { bytes, type, disposition: 'attachment; filename="egrn.' + extension + '"; filename*=UTF-8\'\'' + encoded };
}
function setupEgrnDownloads(app, options = {}) {
  const store = options.store || require('../bot/egrn-files');
  async function download(req, res) {
    res.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    try {
      if (!verify(req.params.id, req.query || {}, options)) return res.status(403).type('text/plain').send('Ссылка недействительна или устарела. Получите новую ссылку в боте.');
      const id = req.params.id.toLowerCase();
      await store.ensure();
      const file = await store.get(id);
      if (!file) return res.status(404).type('text/plain').send('Файл выписки не найден.');
      const info = metadata(file);
      res.set({ 'Content-Type': info.type, 'Content-Length': String(info.bytes), 'Content-Disposition': info.disposition, 'Accept-Ranges': 'none' });
      if (req.method === 'HEAD') return res.end();
      const controller = new AbortController(), abort = () => controller.abort();
      req.once('aborted', abort); res.once('close', abort);
      async function* body() {
        let sent = 0, tail;
        for await (const chunk of store.chunks(id, { signal: controller.signal })) {
          if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) || sent + chunk.byteLength > info.bytes) throw new Error('Invalid stored file content');
          sent += chunk.byteLength;
          if (!chunk.byteLength) continue;
          if (tail) yield tail;
          tail = chunk;
        }
        if (sent !== info.bytes) throw new Error('Incomplete stored file content');
        // Store iterators validate their final checksum at EOF. Retain one
        // bounded chunk so Content-Length cannot make a client accept all
        // bytes before that validation (or a last metadata query) succeeds.
        if (tail) yield tail;
      }
      // pipeline destroys the source/async iterator on a disconnected client,
      // and waits for response drain instead of collecting the file in RAM.
      try { await pipeline(Readable.from(body(), { objectMode: false, highWaterMark: 64 * 1024 }), res); }
      finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
    } catch (_) {
      if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
      res.removeHeader('Content-Length'); res.removeHeader('Content-Disposition');
      return res.status(503).type('text/plain').send('Скачивание выписки временно недоступно. Повторите попытку позднее.');
    }
  }
  app.head('/egrn-files/:id/download', download);
  app.get('/egrn-files/:id/download', download);
}

module.exports = { createDownloadUrl, setupEgrnDownloads };
