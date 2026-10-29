// Original EGRN documents belong to a request only when its target names order_id.
// Telegram links contain the bot token: never return or log them or provider errors.
const MAX_BYTES = 12 * 1024 * 1024;
const WARNING = 'Выписка доставлена в Telegram, но не все оригиналы удалось добавить к документам заявки. Прикрепите недостающую выписку к заявке.';

function orderIds(targets) {
  return [...new Set((targets || []).map(t => Number(t && t.order_id)).filter(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647))];
}
function documentMime(name, buffer) {
  if (/\.pdf$/i.test(name) && buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'application/pdf';
  if (/\.zip$/i.test(name) && buffer.length >= 4 && ['504b0304', '504b0506', '504b0708'].includes(buffer.subarray(0, 4).toString('hex'))) return 'application/zip';
  throw new Error('Unsupported EGRN document');
}
function trustedTelegramUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch (e) { throw new Error('Invalid Telegram document URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.telegram.org' || url.username || url.password || url.port || !url.pathname.startsWith('/file/')) throw new Error('Invalid Telegram document URL');
  return url;
}
async function telegramOriginal(value, fetchImpl = globalThis.fetch) {
  let url = trustedTelegramUrl(value);
  const signal = AbortSignal.timeout(15000);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetchImpl(url.href, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!next || redirect === 3) throw new Error('Telegram redirect failed');
      url = trustedTelegramUrl(new URL(next, url).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('Telegram original unavailable'); }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw new Error('EGRN document too large'); }
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Telegram body unavailable');
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new Error('EGRN document too large'); }
        chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
    if (!bytes) throw new Error('Empty EGRN document');
    return Buffer.concat(chunks, bytes);
  }
}

function createOrderEvidence(options = {}) {
  const materials = () => options.materials || require('../web/order-materials');
  const report = () => { if (options.log) options.log('egrn packet: original unavailable'); else console.error('egrn packet: original unavailable'); };
  async function registerOriginal(targets, file) {
    const ids = orderIds(targets);
    if (!ids.length) return {};
    let prepared;
    try {
      const buffer = file.buffer || file.buf;
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) throw new Error('Invalid EGRN original');
      const mime = documentMime(file.name, buffer);
      prepared = materials().prepareMaterials([{ originalname: file.name, mimetype: mime, buffer }], ['egrn']);
    } catch (e) { report(); return { packet_warning: WARNING }; }
    let failed = false;
    for (const id of ids) {
      try { await materials().saveOrderMaterials(id, prepared); } catch (e) { failed = true; report(); }
    }
    return failed ? { packet_warning: WARNING } : {};
  }
  async function registerCached(targets, files, telegram) {
    if (!orderIds(targets).length) return {};
    let failed = !files || !files.length;
    for (const file of files || []) {
      try {
        if (!file.file_id || !file.name || !telegram || !telegram.getFileLink || Number(file.bytes) > MAX_BYTES) throw new Error('Cached original unavailable');
        const link = await telegram.getFileLink(file.file_id);
        const buffer = await telegramOriginal(link, options.fetch || globalThis.fetch);
        const result = await registerOriginal(targets, { name: file.name, buffer });
        if (result.packet_warning) failed = true;
      } catch (e) { failed = true; report(); }
    }
    return failed ? { packet_warning: WARNING } : {};
  }
  return { registerOriginal, registerCached };
}

const store = createOrderEvidence();
module.exports = { MAX_BYTES, WARNING, orderIds, trustedTelegramUrl, telegramOriginal, createOrderEvidence, ...store };
