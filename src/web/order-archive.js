const { createHash } = require('node:crypto');
const yauzl = require('yauzl');
const { crc32 } = require('./order-materials');
const DEFAULT_LIMIT = 100 * 1024 * 1024;
const PUBLIC_HOSTS = new Set(['disk.yandex.ru', 'disk.360.yandex.ru', 'disk.yandex.com', 'disk.360.yandex.com', 'yadi.sk']);
const COMMON_ARCHIVE = 'RPoUCOS6PFusPQ';
const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';

class ArchiveError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new ArchiveError(status, code, message); }

function parseArchiveUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (e) { fail(400, 'INVALID_ARCHIVE', 'Менеджеру нужно добавить ссылку на архив конкретного объекта.'); }
  if (url.protocol !== 'https:' || !PUBLIC_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) fail(400, 'INVALID_ARCHIVE', 'Нужна публичная HTTPS-ссылка на файл или папку Яндекс Диска.');
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch (e) { fail(400, 'INVALID_ARCHIVE', 'Ссылка на архив повреждена. Попросите менеджера скопировать её заново.'); }
  if (!['d', 'i'].includes(parts[0]) || !/^[a-zA-Z0-9_-]{6,256}$/.test(parts[1] || '') || parts.some(part => /[\\/\u0000-\u001f]/.test(part) || part === '.' || part === '..')) fail(400, 'INVALID_ARCHIVE', 'Нужна ссылка на конкретную публичную папку или файл Яндекс Диска.');
  let path = parts.length > 2 ? '/' + parts.slice(2).join('/') : '';
  if (url.searchParams.has('path')) {
    if (path || url.searchParams.getAll('path').length > 1) fail(400, 'INVALID_ARCHIVE', 'В ссылке на архив указан неоднозначный путь.');
    path = url.searchParams.get('path') || '';
    if (!path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..' || /[\\\u0000-\u001f]/.test(part))) fail(400, 'INVALID_ARCHIVE', 'Некорректный путь в архиве.');
  }
  if (parts[1] === COMMON_ARCHIVE && path.split('/').filter(Boolean).length < 2) fail(400, 'COMMON_ARCHIVE', 'Это общий архив. Менеджеру нужно выбрать папку конкретного объекта или прикрепить прошлый план и акт к заявке.');
  return { publicKey: url.origin + '/' + parts.slice(0, 2).join('/'), path };
}

function isDownloadUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['yandex.ru', 'yandex.net', 'yandex.com', 'yandexcloud.net'].some(domain => host === domain || host.endsWith('.' + domain));
  } catch (e) { return false; }
}
function safeFilename(value, fallback = 'Архив проверки') {
  const last = String(value || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const characters = Array.from(last), extension = (last.match(/\.[a-z0-9]{1,10}$/i) || [''])[0];
  const name = characters.length > 160 ? characters.slice(0,160-extension.length).join('')+extension : last;
  return name && name !== '.' && name !== '..' ? name : fallback;
}
function contentDisposition(name) {
  let encoded;
  try { encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
  catch (e) { encoded = 'archive.zip'; }
  return 'attachment; filename="archive"; filename*=UTF-8\'\'' + encoded;
}
async function readBounded(response, limit) {
  const lengthHeader = response.headers.get('content-length');
  const length = lengthHeader != null && /^\d+$/.test(lengthHeader.trim()) ? Number(lengthHeader) : NaN;
  const encoding = (response.headers.get('content-encoding') || '').trim().toLowerCase();
  if ((!encoding || encoding === 'identity') && Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    fail(413, 'ARCHIVE_TOO_LARGE', 'Архив слишком большой для скачивания из формы. Попросите менеджера приложить нужный план и акт отдельными файлами.');
  }
  if (!response.body) fail(502, 'ARCHIVE_UNAVAILABLE', 'Яндекс не передал содержимое архива. Попробуйте позднее или попросите менеджера приложить файлы к заявке.');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) fail(413, 'ARCHIVE_TOO_LARGE', 'Архив слишком большой для скачивания из формы. Попросите менеджера приложить нужный план и акт отдельными файлами.');
    chunks.push(Buffer.from(chunk));
  }
  // Fetch decodes gzip/br automatically; their Content-Length describes the
  // encoded transfer, while these chunks contain the decoded original.
  if ((!encoding || encoding === 'identity') && Number.isSafeInteger(length) && bytes !== length)
    fail(502, 'ARCHIVE_INCOMPLETE', 'Архив скачался не полностью. Повторите скачивание; неполный файл не сохранён.');
  return Buffer.concat(chunks, bytes);
}
async function requestJson(fetcher, url, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 15000); if (timer.unref) timer.unref();
  let received = false;
  try {
    const response = await fetcher(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
    received = true;
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new ArchiveError(502, 'ARCHIVE_UNAVAILABLE', 'Яндекс сейчас не отдаёт архив по этой ссылке. Попробуйте позднее или попросите менеджера прикрепить прошлый план и акт к заявке.'), { upstreamStatus: response.status, transient: response.status >= 500 && response.status < 600 });
    }
    return JSON.parse((await readBounded(response, 1024 * 1024)).toString('utf8'));
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    if (controller.signal.aborted) throw Object.assign(new ArchiveError(504, 'ARCHIVE_TIMEOUT', 'Яндекс не ответил вовремя. Попробуйте позднее или используйте документы, приложенные менеджером к заявке.'), { transient: true });
    throw Object.assign(new ArchiveError(502, 'ARCHIVE_UNAVAILABLE', 'Не удалось получить архив с Яндекс Диска.'), { transient: !received });
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

function validateFolderZip(buffer, signal) {
  return new Promise((resolve,reject) => {
    let zip, active, settled = false;
    function finish(error) {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', aborted);
      if (active) { active.destroy(); active = null; }
      if (zip) zip.close();
      if (error) reject(error instanceof ArchiveError ? error : new ArchiveError(502,'ARCHIVE_INCOMPLETE','ZIP архива повреждён или скачался не полностью. Повторите скачивание.'));
      else resolve();
    }
    function aborted() { finish(new ArchiveError(504,'ARCHIVE_TIMEOUT','Не удалось завершить проверку архива вовремя. Повторите скачивание.')); }
    signal.addEventListener('abort',aborted,{once:true});
    if (signal.aborted) { aborted(); return; }
    // A complete central directory alone cannot confirm entry contents. Read
    // one entry at a time, checking its expanded size and incremental CRC
    // without retaining a second, expanded archive in memory.
    yauzl.fromBuffer(buffer,{lazyEntries:true,autoClose:false,validateEntrySizes:true},(error,opened) => {
      if (error) { finish(error); return; }
      zip = opened;
      if (settled) { zip.close(); return; }
      zip.on('error',finish); zip.once('end',() => finish());
      zip.on('entry',entry => {
        if (settled) return;
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) { finish(new Error('Invalid ZIP entry size')); return; }
        zip.openReadStream(entry,(error,input) => {
          if (error) { finish(error); return; }
          if (settled) { input.destroy(); return; }
          active = input; let bytes = 0, checksum = 0;
          input.on('error',finish);
          input.on('data',chunk => {
            if (settled) return;
            if (signal.aborted) { aborted(); return; }
            bytes += chunk.length;
            if (bytes > entry.uncompressedSize) { finish(new Error('ZIP entry exceeds its declared size')); return; }
            checksum = crc32(chunk,checksum);
          });
          input.once('end',() => {
            if (settled) return;
            active = null;
            if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) { finish(new Error('ZIP entry contents do not match')); return; }
            setImmediate(() => { if (!settled) zip.readEntry(); });
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function downloadNativeArchive(metadata, query, { fetcher, maxBytes, signal }) {
  try {
    const link = await requestJson(fetcher, API + '/download?' + query, signal);
    let href = link.href, response;
    for (let hop = 0; hop < 6; hop++) {
      if (!isDownloadUrl(href)) fail(502, 'UNTRUSTED_DOWNLOAD', 'Яндекс вернул неподходящую ссылку для скачивания.');
      response = await fetcher(href, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || hop === 5) fail(502, 'ARCHIVE_UNAVAILABLE', 'Яндекс не смог начать скачивание архива.');
        try { href = new URL(location, href).href; } catch (e) { fail(502, 'UNTRUSTED_DOWNLOAD', 'Яндекс вернул неподходящую ссылку для скачивания.'); }
        continue;
      }
      break;
    }
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => {});
      throw Object.assign(new ArchiveError(502, 'ARCHIVE_UNAVAILABLE', 'Архив временно недоступен для скачивания. Попросите менеджера приложить документы к заявке.'), { upstreamStatus: response?.status, transient: response?.status >= 500 && response?.status < 600 });
    }
    const responseType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const declaredType = String(metadata.mime_type || '').split(';')[0].trim().toLowerCase();
    if (['text/html','application/json'].includes(responseType) && (metadata.type !== 'file' || declaredType !== responseType)) {
      await response.body?.cancel().catch(() => {});
      fail(502, 'ARCHIVE_UNAVAILABLE', 'Вместо архива Яндекс вернул страницу ошибки. Попробуйте позднее.');
    }
    const buffer = await readBounded(response, maxBytes);
    const folder = metadata.type === 'dir';
    if (!buffer.length && (folder || metadata.size !== 0)) fail(502, 'ARCHIVE_UNAVAILABLE', 'Яндекс передал пустой файл архива.');
    if (!folder) {
      const size = metadata.size == null ? NaN : Number(metadata.size);
      if (Number.isSafeInteger(size) && size >= 0 && buffer.length !== size)
        fail(502, 'ARCHIVE_INCOMPLETE', 'Файл архива скачался не полностью или изменился. Повторите скачивание; неполный файл не сохранён.');
      for (const [field, length] of [['sha256',64],['md5',32]]) {
        if (metadata[field] == null || metadata[field] === '') continue;
        const expected = String(metadata[field]).toLowerCase();
        if (!new RegExp('^[a-f0-9]{'+length+'}$').test(expected) || createHash(field).update(buffer).digest('hex') !== expected)
          fail(502, 'ARCHIVE_INTEGRITY', 'Содержимое файла не совпало с оригиналом в архиве. Повторите скачивание.');
      }
    }
    if (folder && !['504b0304', '504b0506', '504b0708'].includes(buffer.subarray(0, 4).toString('hex'))) fail(502, 'ARCHIVE_UNAVAILABLE', 'Яндекс не сформировал ZIP архива. Попросите менеджера приложить нужные документы к заявке.');
    if (folder) await validateFolderZip(buffer, signal);
    if (!folder && metadata.mime_type === 'application/pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail(502, 'ARCHIVE_UNAVAILABLE', 'Содержимое архивного PDF не подтверждено. Попробуйте позднее.');
    const mime = folder ? 'application/zip' : /^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/i.test(metadata.mime_type || '') ? metadata.mime_type : 'application/octet-stream';
    const name = safeFilename(metadata.name) + (folder ? '.zip' : '');
    return { buffer, name, mime, bytes: buffer.length };
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    if (signal.aborted) throw Object.assign(new ArchiveError(504, 'ARCHIVE_TIMEOUT', 'Яндекс не успел подготовить архив. Попробуйте позднее или попросите менеджера прикрепить документы.'), { transient: true });
    // Do not expose provider URLs, request headers or temporary download links.
    throw Object.assign(new ArchiveError(502, 'ARCHIVE_UNAVAILABLE', 'Не удалось скачать архив с Яндекс Диска. Попробуйте позднее или попросите менеджера прикрепить документы.'), { transient: true });
  }
}

async function downloadArchive(value, options = {}) {
  const parsed = parseArchiveUrl(value), fetcher = options.fetch || global.fetch, maxBytes = options.maxBytes ?? DEFAULT_LIMIT;
  const controller = new AbortController(), abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, options.timeoutMs || 90000); if (timer.unref) timer.unref();
  try {
    if (controller.signal.aborted) fail(504, 'ARCHIVE_TIMEOUT', 'Скачивание архива прервано. Повторите скачивание.');
    const query = new URLSearchParams({ public_key: parsed.publicKey }); if (parsed.path) query.set('path', parsed.path);
    const metadata = await requestJson(fetcher, API + '?' + query, controller.signal);
    if (!['file', 'dir'].includes(metadata.type)) fail(502, 'ARCHIVE_UNAVAILABLE', 'Не удалось определить файл или папку архива.');
    if (Number(metadata.size) > maxBytes) fail(413, 'ARCHIVE_TOO_LARGE', 'Архив слишком большой. Попросите менеджера приложить нужные документы отдельно.');
    if (metadata.type !== 'dir') return await downloadNativeArchive(metadata, query, { fetcher, maxBytes, signal: controller.signal });
    const native = new AbortController(), stopNative = () => native.abort();
    controller.signal.addEventListener('abort', stopNative, { once: true });
    if (controller.signal.aborted) stopNative();
    const nativeTimer = setTimeout(stopNative, options.nativeTimeoutMs || 30000); if (nativeTimer.unref) nativeTimer.unref();
    let nativeFailure;
    try { return await downloadNativeArchive(metadata, query, { fetcher, maxBytes, signal: native.signal }); }
    catch (error) { nativeFailure = error; if (native.signal.aborted && error.code === 'ARCHIVE_TIMEOUT') error.transient = true; }
    finally { clearTimeout(nativeTimer); controller.signal.removeEventListener('abort', stopNative); }
    // Access denials, throttling and invalid/truncated content are never a
    // reason to change download methods. Only an unavailable ZIP service is.
    if (!nativeFailure.transient || controller.signal.aborted) throw nativeFailure;
    const { assembleFolderArchive } = require('./order-archive-folder');
    const assembled = await assembleFolderArchive({ parsed, metadata, signal: controller.signal, maxBytes, fail,
      maxDepth: options.folderMaxDepth, maxEntries: options.folderMaxEntries,
      requestMetadata: async (path, offset, limit) => {
        const page = new URLSearchParams({ public_key: parsed.publicKey, offset: String(offset), limit: String(limit), sort: 'name' });
        if (path) page.set('path', path);
        return requestJson(fetcher, API + '?' + page, controller.signal);
      },
      downloadFile: (path, remaining) => downloadArchive(parsed.publicKey + '?path=' + encodeURIComponent(path), { ...options, maxBytes: remaining, signal: controller.signal }),
    });
    return { ...assembled, name: safeFilename(assembled.name) + '.zip', mime: 'application/zip' };
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    if (controller.signal.aborted) fail(504, 'ARCHIVE_TIMEOUT', 'Яндекс не успел подготовить архив. Попробуйте позднее или попросите менеджера прикрепить документы.');
    fail(502, 'ARCHIVE_UNAVAILABLE', 'Не удалось скачать архив с Яндекс Диска. Попробуйте позднее или попросите менеджера прикрепить документы.');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

function setupOrderArchive(app, options = {}) {
  const getOrder = options.getOrder || (id => require('../db/queries').getOrderById(id));
  app.get('/api/audit/orders/:id/archive/download', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const controller = new AbortController(), abort = () => controller.abort();
    req.once?.('aborted', abort); res.once?.('close', abort);
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) fail(400, 'INVALID_ORDER', 'Некорректный номер заявки.');
      const order = await getOrder(id);
      if (!order) fail(404, 'ORDER_NOT_FOUND', 'Заявка не найдена.');
      if (order.service !== 'Продление') fail(400, 'NOT_RENEWAL', 'Архив предыдущей проверки предусмотрен для продления.');
      if (!order.archive_url) fail(404, 'ARCHIVE_MISSING', 'Менеджер ещё не приложил ссылку на архив. Проверьте документы заявки или запросите прошлый план и акт у менеджера.');
      const file = await downloadArchive(order.archive_url, { ...options, signal: controller.signal });
      res.set('X-Content-Type-Options', 'nosniff').set('Content-Disposition', contentDisposition(file.name)).type(file.mime).send(file.buffer);
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, code: e.code || 'ARCHIVE_ERROR', error: e instanceof ArchiveError ? e.message : 'Не удалось открыть архив заявки.' });
    } finally { req.removeListener?.('aborted', abort); res.removeListener?.('close', abort); }
  });
}

module.exports = { setupOrderArchive, downloadArchive, parseArchiveUrl, isDownloadUrl, contentDisposition, ArchiveError };
