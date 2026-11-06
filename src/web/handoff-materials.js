'use strict';

const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { zipParts, LIMITS } = require('./order-materials');
const MAX_PART_BYTES = 45 * 1024 * 1024;

function problem(code) { return Object.assign(new Error('Не удалось подтвердить полный комплект документов заявки.'), { code }); }
function digest(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
const messageId=value=>(typeof value==='number'||typeof value==='string'&&/^[1-9]\d*$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
function recipient(target) {
  if (!target || !['string', 'number'].includes(typeof target.chat)) throw problem('MATERIAL_TARGET_INVALID');
  const chat = String(target.chat);
  if (!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(chat) && (!/^-?\d+$/.test(chat) || !Number.isSafeInteger(Number(chat)) || !Number(chat))) throw problem('MATERIAL_TARGET_INVALID');
  if (target.reply != null && (!Number.isSafeInteger(Number(target.reply)) || Number(target.reply) <= 0)) throw problem('MATERIAL_TARGET_INVALID');
  return { chat: target.chat, ...(target.reply != null ? { reply: Number(target.reply) } : {}) };
}
function originals(value) {
  if (!Array.isArray(value) || value.length > LIMITS.files) throw problem('MATERIAL_PACKET_INVALID');
  let total = 0;
  return value.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || !Buffer.isBuffer(file.buffer) || !file.buffer.length ||
        !Number.isSafeInteger(Number(file.bytes)) || Number(file.bytes) !== file.buffer.length || file.buffer.length > LIMITS.fileBytes ||
        typeof file.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256) || digest(file.buffer) !== file.sha256.toLowerCase()) throw problem('MATERIAL_INTEGRITY');
    total += file.buffer.length; if (total > LIMITS.totalBytes) throw problem('MATERIAL_PACKET_LIMIT');
    return { ...file, bytes: file.buffer.length, sha256: file.sha256.toLowerCase() };
  });
}
function frozenSelection(loaded, expected) {
  if (!Array.isArray(loaded)) throw problem('MATERIAL_PACKET_INVALID');
  if (expected === undefined) return loaded;
  if (!Array.isArray(expected) || expected.length > LIMITS.files) throw problem('MATERIAL_PACKET_CHANGED');
  const used = new Set();
  return expected.map(wanted => {
    if (!wanted || typeof wanted.id !== 'string' || !wanted.id || used.has(wanted.id)) throw problem('MATERIAL_PACKET_CHANGED');
    used.add(wanted.id);
    const matches = loaded.filter(file => file && String(file.id) === wanted.id);
    if (matches.length !== 1) throw problem('MATERIAL_PACKET_CHANGED');
    const file = matches[0];
    if (!['name','mime','role'].every(key => typeof wanted[key] === 'string' && wanted[key] === file[key]) ||
        !Number.isSafeInteger(Number(wanted.bytes)) || Number(wanted.bytes) !== Number(file.bytes) ||
        typeof wanted.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(wanted.sha256) || wanted.sha256.toLowerCase() !== String(file.sha256).toLowerCase()) throw problem('MATERIAL_PACKET_CHANGED');
    return file;
  });
}
function archives(files, maximum) {
  const groups = []; let current = [], size = 22;
  for (const file of files) {
    // zipParts uses a fixed two-digit index for at most 20 originals. Measuring
    // a single entry accounts for its exact cleaned UTF-8 name and ZIP headers.
    // Buffers yielded here reference existing originals; no full ZIP is copied.
    const entryBytes = Array.from(zipParts([file])).reduce((sum, chunk) => sum + chunk.length, 0) - 22;
    if (entryBytes + 22 > maximum) throw problem('MATERIAL_ARCHIVE_LIMIT');
    if (current.length && size + entryBytes > maximum) { groups.push(current); current = []; size = 22; }
    current.push(file); size += entryBytes;
  }
  if (current.length) groups.push(current);
  return groups.map(group => {
    const chunks = Array.from(zipParts(group)), bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (bytes > maximum) throw problem('MATERIAL_ARCHIVE_LIMIT');
    return { chunks, bytes, files: group.length };
  });
}
function createHandoffMaterialsDelivery(options = {}) {
  const telegram = options.telegram;
  if (typeof telegram?.sendDocument !== 'function') throw new TypeError('A Telegram document sender is required.');
  const load = options.loadMaterials || (id => require('./order-materials').loadOrderMaterials(id));
  const maximum = options.maxPartBytes == null ? MAX_PART_BYTES : options.maxPartBytes;
  if (typeof load !== 'function' || !Number.isSafeInteger(maximum) || maximum <= 22 || maximum > MAX_PART_BYTES) throw new TypeError('Invalid handoff material delivery configuration.');

  return async function deliver(orderId, targets, excludeHashes, deliveryOptions = {}) {
    const result = { ok: false, files: 0, parts: 0, excluded: 0, ignored: 0, packetHash: null, delivered: [], failed: [], warnings: [] };
    let recipients, packets, preparingReceipt = false;
    const warn = (code, text) => { result.warnings.push(text); return code; };
    try {
      orderId = Number(orderId);
      if (!Number.isSafeInteger(orderId) || orderId < 1 || orderId > 2147483647) throw problem('MATERIAL_ORDER_INVALID');
      if (!Array.isArray(targets)) throw problem('MATERIAL_TARGET_INVALID');
      const unique = new Map(); for (const target of targets.map(recipient)) if (!unique.has(String(target.chat))) unique.set(String(target.chat), target);
      recipients = [...unique.values()];
      if (!recipients.length) throw problem('MATERIAL_TARGET_MISSING');
      if (deliveryOptions.onPart != null && typeof deliveryOptions.onPart !== 'function') throw problem('MATERIAL_RECEIPT_INVALID');
      if (deliveryOptions.onPrepared != null && typeof deliveryOptions.onPrepared !== 'function') throw problem('MATERIAL_RECEIPT_INVALID');
      if (deliveryOptions.beforeSend != null && typeof deliveryOptions.beforeSend !== 'function') throw problem('MATERIAL_RECEIPT_INVALID');
      const loaded = await load(orderId), frozen = frozenSelection(loaded, deliveryOptions.expectedFiles);
      const all = originals(frozen); result.ignored = loaded.length - frozen.length;
      const excluded = new Set(excludeHashes instanceof Set || Array.isArray(excludeHashes)
        ? [...excludeHashes].filter(hash => typeof hash === 'string' && /^[a-f\d]{64}$/i.test(hash)).map(hash => hash.toLowerCase()) : []);
      const selected = all.filter(file => !excluded.has(file.sha256));
      result.files = selected.length; result.excluded = all.length - selected.length;
      result.packetHash = digest(Buffer.from(JSON.stringify({ version: 1, orderId, maximum,
        files: all.map(file => [String(file.id || ''), file.name, String(file.mime || ''), String(file.role || ''), file.bytes, file.sha256]), excluded: [...excluded].sort() })));
      if (deliveryOptions.packetHash != null && deliveryOptions.packetHash !== result.packetHash) throw problem('MATERIAL_PACKET_CHANGED');
      packets = archives(selected, maximum); result.parts = packets.length;
      const confirmed = deliveryOptions.confirmed || {};
      if (typeof confirmed !== 'object' || Array.isArray(confirmed)) throw problem('MATERIAL_RECEIPT_INVALID');
      // Validate every recipient's checkpoint before publishing any part.
      for (const target of recipients) {
        const ids = Object.hasOwn(confirmed, String(target.chat)) ? confirmed[String(target.chat)] : [];
        if (!Array.isArray(ids) || ids.length > packets.length || ids.some(id => !messageId(id)) || new Set(ids.map(Number)).size !== ids.length) throw problem('MATERIAL_RECEIPT_INVALID');
        result.delivered.push({ ...target, messageIds: ids.map(Number), complete: false });
      }
      if (deliveryOptions.onPrepared) {
        preparingReceipt = true;
        await deliveryOptions.onPrepared({ packetHash: result.packetHash, files: result.files, parts: result.parts });
        preparingReceipt = false;
      }
    } catch (failure) {
      result.failed.push({ stage: 'prepare', code: preparingReceipt ? 'MATERIAL_CHECKPOINT_FAILED' : /^MATERIAL_[A-Z_]+$/.test(failure?.code || '') ? failure.code : 'MATERIAL_LOAD_FAILED' });
      const integrity = failure?.code === 'MATERIAL_INTEGRITY';
      const changed = failure?.code === 'MATERIAL_PACKET_CHANGED';
      warn(failure?.code, preparingReceipt ? 'Не удалось сохранить состав передаваемых документов. Новые файлы не отправлены: повторите доставку материалов без создания нового клиента.'
        : changed ? 'Документы заявки изменились после начала передачи. Не создавайте повторного клиента: сначала проверьте комплект.'
        : integrity ? 'Документы заявки не отправлены: размер или контрольная сумма одного из оригиналов не совпали. Проверьте исходные файлы.'
          : 'Не удалось получить и подготовить полный комплект документов заявки. Повторите доставку материалов без создания нового клиента.');
      return result;
    }

    let stop = false;
    for (const target of result.delivered) {
      if (stop) break;
      for (let index = target.messageIds.length; index < packets.length; index++) {
        const part = packets[index], suffix = packets.length > 1 ? '-' + String(index + 1).padStart(2, '0') + '-из-' + String(packets.length).padStart(2, '0') : '';
        const filename = 'Заявка-' + orderId + '-документы' + suffix + '.zip';
        const source = Readable.from(part.chunks, { objectMode: false }); let stage = 'recipient';
        try {
          if (deliveryOptions.beforeSend && await deliveryOptions.beforeSend(target.chat,index) === false) throw problem('MATERIAL_RECIPIENT_UNAVAILABLE');
          stage = 'telegram';
          const message = await telegram.sendDocument(target.chat, { source, filename }, {
            caption: '📎 Документы заявки #' + orderId + (packets.length > 1 ? ' · часть ' + (index + 1) + ' из ' + packets.length : '') + '\nОригиналы документов менеджера.',
            ...(target.reply != null ? { reply_to_message_id: target.reply } : {})
          });
          const id=messageId(message?.message_id),chat=String(target.chat);
          const matchingChat=message?.chat==null||(chat.startsWith('@')?String(message.chat.username||'').toLowerCase()===chat.slice(1).toLowerCase():String(message.chat.id)===chat);
          if (!id || id===target.reply || target.messageIds.includes(id) || !matchingChat) throw problem('MATERIAL_TELEGRAM_RECEIPT');
          target.messageIds.push(Number(message.message_id)); stage = 'receipt';
          if (deliveryOptions.onPart) await deliveryOptions.onPart(target.chat, index, Number(message.message_id), { packetHash: result.packetHash, files: result.files, parts: result.parts });
        } catch (failure) {
          const unavailable = stage === 'recipient' || ['MATERIAL_RECIPIENT_UNAVAILABLE','HANDOFF_RECIPIENT_UNAVAILABLE'].includes(failure?.code);
          if (unavailable) stage = 'recipient';
          result.failed.push({ chat: target.chat, ...(target.reply != null ? { reply: target.reply } : {}), part: index + 1, partIndex: index, stage,
            uncertain: stage === 'telegram' && !(Number(failure?.response?.error_code)>=400&&Number(failure?.response?.error_code)<500),
            code: unavailable ? 'MATERIAL_RECIPIENT_UNAVAILABLE' : stage === 'receipt' ? 'MATERIAL_CHECKPOINT_FAILED' : failure?.code === 'MATERIAL_TELEGRAM_RECEIPT' ? failure.code : 'MATERIAL_TELEGRAM_FAILED' });
          if (stage === 'receipt') {
            stop = true;
            warn(null, 'Часть документов доставлена, но квитанция передачи не сохранилась. Проверьте доставку перед повтором: новый клиент не требуется.');
          } else warn(null, unavailable ? 'Получатель документов больше недоступен или назначение изменилось. Проверьте юриста и повторите доставку; подтверждённые части сохранены.' : 'Не все документы заявки #' + orderId + ' доставлены одному из получателей (часть ' + (index + 1) + ' из ' + packets.length + '). Повторите доставку материалов без создания нового клиента.');
          break;
        } finally { source.destroy(); }
      }
      target.complete = target.messageIds.length === packets.length && !result.failed.some(failure => String(failure.chat) === String(target.chat));
    }
    result.ok = !result.failed.length && result.delivered.every(target => target.complete);
    result.warnings = [...new Set(result.warnings)];
    return result;
  };
}

module.exports = { createHandoffMaterialsDelivery, MAX_PART_BYTES };
