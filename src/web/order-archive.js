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
  const name = Array.from(last).slice(0, 160).join('');
  return name && name !== '.' && name !== '..' ? name : fallback;
}
function contentDisposition(name) {
  let encoded;
  try { encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
  catch (e) { encoded = 'archive.zip'; }
  return 'attachment; filename="archive"; filename*=UTF-8\'\'' + encoded;
}
async function readBounded(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
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
  return Buffer.concat(chunks, bytes);
}
async function requestJson(fetcher, url, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 15000); if (timer.unref) timer.unref();
  try {
    const response = await fetcher(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(502, 'ARCHIVE_UNAVAILABLE', 'Яндекс сейчас не отдаёт архив по этой ссылке. Попробуйте позднее или попросите менеджера прикрепить прошлый план и акт к заявке.');
    }
    return JSON.parse((await readBounded(response, 1024 * 1024)).toString('utf8'));
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    if (controller.signal.aborted) fail(504, 'ARCHIVE_TIMEOUT', 'Яндекс не ответил вовремя. Попробуйте позднее или используйте документы, приложенные менеджером к заявке.');
    fail(502, 'ARCHIVE_UNAVAILABLE', 'Не удалось получить архив с Яндекс Диска.');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

async function downloadArchive(value, options = {}) {
  const parsed = parseArchiveUrl(value);
  const fetcher = options.fetch || global.fetch;
  const maxBytes = options.maxBytes || DEFAULT_LIMIT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 90000);
  if (timer.unref) timer.unref();
  try {
    const query = new URLSearchParams({ public_key: parsed.publicKey });
    if (parsed.path) query.set('path', parsed.path);
    const metadata = await requestJson(fetcher, API + '?' + query, controller.signal);
    if (!['file', 'dir'].includes(metadata.type)) fail(502, 'ARCHIVE_UNAVAILABLE', 'Не удалось определить файл или папку архива.');
    if (Number(metadata.size) > maxBytes) fail(413, 'ARCHIVE_TOO_LARGE', 'Архив слишком большой. Попросите менеджера приложить нужные документы отдельно.');
    const link = await requestJson(fetcher, API + '/download?' + query, controller.signal);
    let href = link.href, response;
    for (let hop = 0; hop < 6; hop++) {
      if (!isDownloadUrl(href)) fail(502, 'UNTRUSTED_DOWNLOAD', 'Яндекс вернул неподходящую ссылку для скачивания.');
      response = await fetcher(href, { redirect: 'manual', signal: controller.signal });
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
      fail(502, 'ARCHIVE_UNAVAILABLE', 'Архив временно недоступен для скачивания. Попросите менеджера приложить документы к заявке.');
    }
    const responseType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (responseType === 'text/html' || responseType === 'application/json') {
      await response.body?.cancel().catch(() => {});
      fail(502, 'ARCHIVE_UNAVAILABLE', 'Вместо архива Яндекс вернул страницу ошибки. Попробуйте позднее.');
    }
    const buffer = await readBounded(response, maxBytes);
    if (!buffer.length) fail(502, 'ARCHIVE_UNAVAILABLE', 'Яндекс передал пустой файл архива.');
    const folder = metadata.type === 'dir';
    if (folder && !['504b0304', '504b0506', '504b0708'].includes(buffer.subarray(0, 4).toString('hex'))) fail(502, 'ARCHIVE_UNAVAILABLE', 'Яндекс не сформировал ZIP архива. Попросите менеджера приложить нужные документы к заявке.');
    if (!folder && metadata.mime_type === 'application/pdf' && !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail(502, 'ARCHIVE_UNAVAILABLE', 'Содержимое архивного PDF не подтверждено. Попробуйте позднее.');
    const mime = folder ? 'application/zip' : /^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/i.test(metadata.mime_type || '') ? metadata.mime_type : 'application/octet-stream';
    const name = safeFilename(metadata.name) + (folder ? '.zip' : '');
    return { buffer, name, mime, bytes: buffer.length };
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    if (controller.signal.aborted) fail(504, 'ARCHIVE_TIMEOUT', 'Яндекс не успел подготовить архив. Попробуйте позднее или попросите менеджера прикрепить документы.');
    // Do not expose provider URLs, request headers or temporary download links.
    fail(502, 'ARCHIVE_UNAVAILABLE', 'Не удалось скачать архив с Яндекс Диска. Попробуйте позднее или попросите менеджера прикрепить документы.');
  } finally { clearTimeout(timer); }
}

function setupOrderArchive(app, options = {}) {
  const getOrder = options.getOrder || (id => require('../db/queries').getOrderById(id));
  app.get('/api/audit/orders/:id/archive/download', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) fail(400, 'INVALID_ORDER', 'Некорректный номер заявки.');
      const order = await getOrder(id);
      if (!order) fail(404, 'ORDER_NOT_FOUND', 'Заявка не найдена.');
      if (order.service !== 'Продление') fail(400, 'NOT_RENEWAL', 'Архив предыдущей проверки предусмотрен для продления.');
      if (!order.archive_url) fail(404, 'ARCHIVE_MISSING', 'Менеджер ещё не приложил ссылку на архив. Проверьте документы заявки или запросите прошлый план и акт у менеджера.');
      const file = await downloadArchive(order.archive_url, options);
      res.set('X-Content-Type-Options', 'nosniff').set('Content-Disposition', contentDisposition(file.name)).type(file.mime).send(file.buffer);
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, code: e.code || 'ARCHIVE_ERROR', error: e instanceof ArchiveError ? e.message : 'Не удалось открыть архив заявки.' });
    }
  });
}

module.exports = { setupOrderArchive, downloadArchive, parseArchiveUrl, isDownloadUrl, contentDisposition, ArchiveError };
