'use strict';

const MESSAGE = 'Не удалось доставить ссылку на выписку. Повторим отправку автоматически.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function temporaryError() {
  return Object.assign(new Error(MESSAGE), { code: 'EGRN_LARGE_DELIVERY_TEMPORARY', temporary: true });
}
function positive(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function chatId(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (/^@[a-z][a-z0-9_]{4,31}$/i.test(text)) return text.toLowerCase();
  const number = Number(text);
  return Number.isSafeInteger(number) && number !== 0 ? number : null;
}
function target(value) {
  if (!value || typeof value !== 'object') return null;
  const chat = chatId(value.chat);
  if (chat === null) return null;
  const reply = positive(value.reply);
  return reply ? { chat, reply } : { chat };
}
function targetKey(value) { return String(value.chat) + ':' + (value.reply || ''); }
function requiredTargets(order) {
  const main = target({ chat: order.chat_id, reply: order.status_msg_id });
  const values = [main, ...(Array.isArray(order.deliver) ? order.deliver : [])];
  const requester = chatId(order.ordered_by);
  if (requester !== null && (!main || requester !== main.chat)) values.push({ chat: requester });
  const unique = new Map();
  for (const value of values) {
    const normalized = target(value);
    if (normalized) unique.set(targetKey(normalized), normalized);
  }
  return { main, targets: [...unique.values()] };
}
function metadata(value, id, order) {
  if (!value || !UUID.test(String(value.id || '')) || id && String(value.id) !== String(id) ||
      typeof value.name !== 'string' || !value.name.trim() || typeof value.mime !== 'string' || !value.mime.trim() ||
      !Number.isSafeInteger(Number(value.bytes)) || Number(value.bytes) <= 0 ||
      order && value.egrn_order_id != null && Number(value.egrn_order_id) !== positive(order.id)) throw temporaryError();
  return { id: String(value.id), name: value.name, mime: value.mime, bytes: Number(value.bytes) };
}
function receipt(value) {
  const destination = target(value), id = value && positive(value.id);
  return destination && id ? { ...destination, id } : null;
}
function receipts(record) {
  const values = new Map();
  for (const value of Array.isArray(record.deliveries) ? record.deliveries : []) {
    const normalized = receipt(value);
    if (normalized) values.set(targetKey(normalized), normalized);
  }
  return [...values.values()];
}
function sizeLabel(bytes) {
  return String(Math.max(0.1, Math.round(bytes / 1024 / 1024 * 10) / 10)).replace('.', ',');
}
function messageText(record) {
  const cad = String(record.cad_num || '').slice(0, 100), label = String(record.label || '').slice(0, 180);
  return '📄 Выписка ЕГРН' + (cad ? ' ' + cad : '') + (label ? ' — ' + label : '') +
    '\n' + String(record.name).slice(0, 220) + '\nРазмер: ' + sizeLabel(record.bytes) + ' МБ.\nСкачайте оригинал по кнопке ниже.';
}

function createLargeDelivery(options = {}) {
  const store = options.store || {
    save(input) { return require('./egrn-files').save(input); },
    get(id) { return require('./egrn-files').get(id); }
  };
  const makeUrl = options.makeUrl || (id => require('../web/egrn-downloads').createDownloadUrl(id));
  const telegram = options.telegram, persist = options.persist;
  function requireSender() {
    if (!telegram || typeof telegram.sendMessage !== 'function' || typeof makeUrl !== 'function') throw temporaryError();
  }
  function requirePersist() { if (typeof persist !== 'function') throw temporaryError(); }
  function ensureRecord(records, record) {
    if (!Array.isArray(records)) throw temporaryError();
    const index = records.findIndex(value => value && value.key === record.key);
    if (index < 0) records.push(record); else if (records[index] !== record) records[index] = record;
  }
  function setMainReceipt(record, main) {
    record.chat = main ? main.chat : null;
    const sent = main && record.deliveries.find(value => targetKey(value) === targetKey(main));
    if (sent) record.id = sent.id; else delete record.id;
  }
  async function persistRecords(order, records) {
    try { await persist(order, records); } catch (_) { throw temporaryError(); }
  }
  async function signedUrl(id) {
    try {
      const value = await makeUrl(id), url = new URL(String(value));
      if (url.protocol !== 'https:' || url.username || url.password) throw temporaryError();
      return url.href;
    } catch (_) { throw temporaryError(); }
  }
  async function send(record, destination, preparedUrl) {
    const url = preparedUrl || await signedUrl(record.original_id);
    const extra = {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [
        [{ text: 'Скачать выписку · ' + sizeLabel(record.bytes) + ' МБ', url }],
        [{ text: 'Обновить ссылку', callback_data: 'egf:' + record.original_id }]
      ] }
    };
    if (destination.reply) extra.reply_parameters = { message_id: destination.reply, allow_sending_without_reply: true };
    return telegram.sendMessage(destination.chat, messageText(record), extra);
  }
  async function complete(order, record, records, descriptorSaved) {
    requireSender(); requirePersist();
    if (!order || !positive(order.id) || !record || record.kind !== 'link' || !UUID.test(String(record.original_id || ''))) throw temporaryError();
    ensureRecord(records, record);
    record.deliveries = receipts(record);
    const required = requiredTargets(order);
    setMainReceipt(record, required.main);
    if (!required.targets.length) throw temporaryError();
    const confirmed = new Set(record.deliveries.map(targetKey));
    const missing = required.targets.filter(value => !confirmed.has(targetKey(value)));
    if (!descriptorSaved && missing.length) await persistRecords(order, records);
    let failures = false;
    for (const destination of missing) {
      // Signing is independent of Telegram. A missing signing configuration
      // stops immediately; no unusable link or provider error is sent.
      const url = await signedUrl(record.original_id);
      let message;
      try {
        message = await send(record, destination, url);
        if (!message || !positive(message.message_id)) throw temporaryError();
      } catch (_) { failures = true; continue; }
      record.deliveries.push({ ...destination, id: positive(message.message_id) });
      setMainReceipt(record, required.main);
      // A database failure must stop the batch before another recipient is
      // notified, limiting the unavoidable send-before-commit crash window.
      await persistRecords(order, records);
    }
    if (failures) throw temporaryError();
    return record;
  }
  async function deliver(order, file, key, records) {
    try {
      requireSender(); requirePersist();
      if (!order || !positive(order.id) || !file || typeof file.name !== 'string' || !file.name.trim() ||
          !Buffer.isBuffer(file.buf) || !file.buf.length || typeof key !== 'string' || !key || !Array.isArray(records) ||
          !store || typeof store.save !== 'function') throw temporaryError();
      const saved = metadata(await store.save({ egrn_order_id: positive(order.id), source_key: key, name: file.name, buffer: file.buf }), null, order);
      if (saved.bytes !== file.buf.length) throw temporaryError();
      const existing = records.find(value => value && value.key === key);
      if (existing && (existing.kind !== 'link' || existing.original_id !== saved.id || existing.name !== saved.name ||
          existing.mime !== saved.mime || Number(existing.bytes) !== saved.bytes)) throw temporaryError();
      const record = existing || { key, kind: 'link', original_id: saved.id, name: saved.name, mime: saved.mime, bytes: saved.bytes,
        cad_num: String(order.cad_num || ''), label: String(order.label || ''), deliveries: [], chat: chatId(order.chat_id) };
      ensureRecord(records, record);
      // The durable descriptor precedes every first notification. It allows a
      // restarted poller to retry delivery without re-fetching the original.
      await persistRecords(order, records);
      return await complete(order, record, records, true);
    } catch (_) { throw temporaryError(); }
  }
  async function retry(order, record, records) {
    try {
      requireSender(); requirePersist();
      if (!record || record.kind !== 'link' || !UUID.test(String(record.original_id || '')) ||
          !store || typeof store.get !== 'function') throw temporaryError();
      const saved = metadata(await store.get(record.original_id), record.original_id, order);
      if (saved.name !== record.name || saved.mime !== record.mime || saved.bytes !== Number(record.bytes)) throw temporaryError();
      return await complete(order, record, records, false);
    } catch (_) { throw temporaryError(); }
  }
  async function copy(record, value) {
    try {
      requireSender();
      const destination = target(value);
      if (!destination || !record || record.kind !== 'link' || !UUID.test(String(record.original_id || '')) ||
          !store || typeof store.get !== 'function') throw temporaryError();
      const saved = metadata(await store.get(record.original_id), record.original_id);
      if (saved.name !== record.name || saved.mime !== record.mime || saved.bytes !== Number(record.bytes)) throw temporaryError();
      const message = await send(record, destination);
      if (!message || !positive(message.message_id)) throw temporaryError();
      return message;
    } catch (_) { throw temporaryError(); }
  }
  return { deliver, retry, copy };
}

module.exports = { createLargeDelivery };
