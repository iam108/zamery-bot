const defaultPool = require('../db/pool');
const defaultMaterials = require('../web/order-materials');
const { telegramOriginal } = require('./order-evidence');
const { createOrderDeliveryLock } = require('../db/order-delivery-lock');
const { messageId, hasUnknownMaterialDelivery } = require('../web/order-telegram-delivery');

// Receipts contain Telegram identifiers only. File bytes use order_materials and
// its existing size limits; no second original or large-file store is created.
const DDL = `CREATE TABLE IF NOT EXISTS manual_order_attachments (
  source_chat_id BIGINT NOT NULL, source_message_id BIGINT NOT NULL,
  actor_tg_id BIGINT NOT NULL, file JSONB NOT NULL,
  order_id INT REFERENCES orders(id), material_id UUID,
  stage TEXT NOT NULL DEFAULT 'pending', lease_until TIMESTAMPTZ,
  group_message_id BIGINT, reply_kind TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_chat_id,source_message_id)
);
ALTER TABLE manual_order_attachments ADD COLUMN IF NOT EXISTS retry_generation UUID NOT NULL DEFAULT gen_random_uuid();`;
const OPEN = "status NOT IN ('done','cancelled')";
const materialStateReady = new WeakMap();
async function manualMaterialDeliveryState(pool, orderId, materialId) {
  if (typeof pool.query !== 'function') return null;
  if (!materialStateReady.has(pool)) materialStateReady.set(pool, pool.query(DDL).catch(error => { materialStateReady.delete(pool); throw error; }));
  await materialStateReady.get(pool);
  return (await pool.query("SELECT stage,group_message_id FROM manual_order_attachments WHERE order_id=$1 AND material_id=$2 ORDER BY CASE WHEN stage='sent' AND group_message_id IS NOT NULL THEN 0 WHEN stage='sending' THEN 1 ELSE 2 END,updated_at DESC LIMIT 1", [orderId, materialId])).rows[0] || null;
}
const sourceNumber = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
function sourceFile(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    return { file_id: photo.file_id, bytes: photo.file_size || 0, name: 'Фото-' + message.message_id + '.jpg', mime: 'image/jpeg', photo: true };
  }
  const doc = message.document;
  if (!doc) return null;
  const name = doc.file_name || 'Документ', extension = name.split('.').pop().toLowerCase();
  let mime = String(doc.mime_type || 'application/octet-stream').toLowerCase();
  const images = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', heic: 'heic', heif: 'heif', avif: 'avif', tif: 'tiff', tiff: 'tiff', bmp: 'bmp' };
  if ((!mime || mime === 'application/octet-stream') && images[extension]) mime = 'image/' + images[extension];
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return { file_id: doc.file_id, bytes: doc.file_size || 0, name, mime, photo: false };
}
function createManualOrderAttachments(options = {}) {
  const pool = options.pool || defaultPool, materials = options.materials || defaultMaterials;
  const groupId = options.groupId || process.env.GROUP_CHAT_ID;
  const withOrderLock = options.withOrderDeliveryLock || createOrderDeliveryLock(pool);
  const log = () => (options.log || console.error)('manual attachment: operation unavailable');
  let ready;
  function ensure() {
    if (!ready) ready = pool.query(DDL).catch(error => { ready = null; throw error; });
    return ready;
  }
  async function receipt(chat, message) {
    return (await pool.query('SELECT * FROM manual_order_attachments WHERE source_chat_id=$1 AND source_message_id=$2', [chat, message])).rows[0];
  }
  async function authorized(ctx) {
    if (ctx.chat?.type !== 'private' || !sourceNumber(ctx.from?.id)) return false;
    const staff = await options.getMe(ctx.from.id);
    if (staff?.approved === true) return true;
    const text = 'Нет доступа. Нажмите /start и дождитесь одобрения.';
    if (ctx.callbackQuery) await ctx.answerCbQuery(text, { show_alert: true }); else await ctx.reply(text);
    return false;
  }
  async function publicationAccess(ctx, orderId) {
    // The order lock holds ownership/status stable across official edits.
    // Staff approval is read last, after downloads, saves and intent writes.
    let order, staff;
    try {
      order = (await pool.query('SELECT id FROM orders WHERE id=$1 AND submitted_by=$2 AND '+OPEN,[orderId,ctx.from.id])).rows[0];
      staff = await options.getMe(ctx.from.id);
    } catch (_) { /* Missing current evidence never permits a publication. */ }
    if (!order || staff?.approved !== true) throw Object.assign(new Error('Attachment publication unavailable'), { code: 'MANUAL_PUBLICATION_UNAVAILABLE' });
  }
  async function notify(ctx, row, kind, text, extra) {
    if (row.reply_kind === kind) return;
    await ctx.reply(text, extra);
    await pool.query('UPDATE manual_order_attachments SET reply_kind=$3 WHERE source_chat_id=$1 AND source_message_id=$2', [row.source_chat_id, row.source_message_id, kind]);
  }
  const retryKeyboard = row => ({ reply_markup: { inline_keyboard: [[{ text: 'Проверил чат — повторить отправку', callback_data: 'manual_retry:' + row.source_message_id + ':' + row.retry_generation }]] } });
  async function publicationWarning(ctx, row, unknown) {
    await notify(ctx, row, unknown ? 'unknown' : 'group-error', 'Файл сохранён в документах заявки #' + row.order_id + '. ' + (unknown
      ? 'Подтверждение отправки в рабочий чат не получено. Перед повтором проверьте чат: исходное сообщение могло дойти.'
      : 'В рабочий чат отправить не удалось. Нажмите кнопку, чтобы повторить отправку этого же файла.'), retryKeyboard(row));
  }
  async function choose(ctx, row) {
    const orders = (await pool.query('SELECT id,address,object_name,owner_name FROM orders WHERE submitted_by=$1 AND ' + OPEN + ' ORDER BY created_at DESC', [ctx.from.id])).rows;
    if (!orders.length) return notify(ctx, row, 'no-orders', 'Нет ваших открытых заявок. Файл остаётся в этом чате и пока ни к одной заявке не прикреплён.');
    if (orders.length === 1) return process(ctx, row, orders[0].id);
    const keyboard = orders.slice(0, 30).map(order => [{ text: ('#' + order.id + ' · ' + (order.object_name || order.owner_name || order.address || 'Заявка')).slice(0, 64), callback_data: 'manual_attach:' + row.source_message_id + ':' + order.id }]);
    return notify(ctx, row, 'selection', 'К какой заявке прикрепить файл «' + row.file.name + '»? Выберите заявку ниже. До выбора файл никуда не отправляется.' + (orders.length > 30 ? ' Показаны последние 30 открытых заявок; остальные доступны через форму заявки.' : ''), { reply_markup: { inline_keyboard: keyboard } });
  }
  async function confirmDelivery(row, messageId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const original = await client.query('UPDATE order_materials SET telegram_msg_id=$1 WHERE order_id=$2 AND id=$3 RETURNING id', [messageId, row.order_id, row.material_id]);
      if (!original.rows.length) throw new Error('Original no longer available');
      await client.query("UPDATE manual_order_attachments SET stage='sent',group_message_id=$3,lease_until=NULL,updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id, messageId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function process(ctx, initial, orderId, explicitRetry = false, expectedGeneration = null) {
    return withOrderLock(orderId, () => processLocked(ctx, initial, orderId, explicitRetry, expectedGeneration));
  }
  async function processLocked(ctx, initial, orderId, explicitRetry = false, expectedGeneration = null) {
    if (!await authorized(ctx)) return;
    let row = await receipt(initial.source_chat_id, initial.source_message_id);
    if (!row || String(row.actor_tg_id) !== String(ctx.from.id)) return;
    if (row.order_id && Number(row.order_id) !== Number(orderId)) return ctx.reply('Этот файл уже относится к заявке #' + row.order_id + '. Для другой заявки отправьте его отдельным сообщением.');
    if (row.stage === 'sent') return notify(ctx, row, 'sent', '✅ Файл сохранён в документах заявки #' + row.order_id + ' и отправлен в рабочий чат.');
    if (explicitRetry && row.retry_generation !== expectedGeneration) return ctx.reply('Кнопка относится к прошлой попытке. Сначала проверьте чат: сообщение могло дойти. Для повтора текущей попытки используйте обновлённую кнопку; возможен дубликат.', retryKeyboard(row));
    if (row.stage === 'sending' && !explicitRetry) return publicationWarning(ctx, row, true);
    const order = (await pool.query('SELECT * FROM orders WHERE id=$1 AND submitted_by=$2 AND ' + OPEN, [orderId, ctx.from.id])).rows[0];
    if (!order) return ctx.reply('Заявка закрыта или недоступна. Файл к ней не прикреплён.');
    if (Number(row.file.bytes) > materials.LIMITS.fileBytes) return notify(ctx, row, 'oversize', 'Файл «' + row.file.name + '» больше 12 МБ. В документы заявки он не добавлен. Оригинал остаётся в вашем сообщении Telegram. Для большого файла используйте ссылку на Яндекс Диск в форме заявки.');
    const claimed = (await pool.query(`UPDATE manual_order_attachments SET order_id=$3,stage='processing',lease_until=NOW()+INTERVAL '60 seconds',updated_at=NOW(),reply_kind=NULL,retry_generation=gen_random_uuid()
      WHERE source_chat_id=$1 AND source_message_id=$2 AND (order_id IS NULL OR order_id=$3)
      AND (NOT $4::boolean OR retry_generation=$5::uuid)
      AND (stage IN ('pending','saved') OR stage='processing' AND lease_until<NOW() OR $4::boolean AND stage='sending' AND (lease_until IS NULL OR lease_until<NOW())) RETURNING *`, [row.source_chat_id, row.source_message_id, order.id, explicitRetry, expectedGeneration])).rows[0];
    if (!claimed) return ctx.reply('Этот файл уже обрабатывается. Повторите проверку чуть позже; повторно отправлять сам файл не нужно.');
    row = claimed;
    let sending = false, published = false, requested = false;
    try {
      if (!row.material_id) {
        const link = await ctx.telegram.getFileLink(row.file.file_id);
        const buffer = await (options.download || telegramOriginal)(link, options.fetch || globalThis.fetch);
        if (Number(row.file.bytes) > 0 && buffer.length !== Number(row.file.bytes)) throw new Error('Incomplete Telegram original');
        await publicationAccess(ctx,order.id);
        const prepared = materials.prepareMaterials([{ originalname: row.file.name, mimetype: row.file.mime, buffer }]);
        await materials.saveOrderMaterials(order.id, prepared);
        row.material_id = prepared[0].id;
        await pool.query("UPDATE manual_order_attachments SET material_id=$3,updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id, row.material_id]);
      }
      await publicationAccess(ctx,order.id);
      const publishedOriginal = (await pool.query('SELECT telegram_msg_id FROM order_materials WHERE order_id=$1 AND id=$2', [order.id, row.material_id])).rows[0];
      if (sourceNumber(publishedOriginal?.telegram_msg_id)) {
        await confirmDelivery(row, Number(publishedOriginal.telegram_msg_id)); published = true;
        return notify(ctx, row, 'sent', '✅ Файл сохранён в документах заявки #' + order.id + ' и отправлен в рабочий чат.');
      }
      const deliveryRow = (await pool.query('SELECT telegram_delivery FROM orders WHERE id=$1', [order.id])).rows[0];
      if (!deliveryRow) throw new Error('Order no longer available');
      if (hasUnknownMaterialDelivery(deliveryRow, row.material_id)) {
        await pool.query("UPDATE manual_order_attachments SET stage='saved',lease_until=NULL WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id]);
        return notify(ctx, row, 'manager-unknown', 'Файл сохранён в документах заявки #' + order.id + '. Отправка этого оригинала из формы заявки не подтверждена: сообщение могло дойти. Автоматический повтор остановлен. Проверьте чат; администратор может открыть /order_delivery ' + order.id + '. Повтор может создать дубликат.');
      }
      if (!groupId) {
        await pool.query("UPDATE manual_order_attachments SET stage='saved',lease_until=NULL WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id]);
        return publicationWarning(ctx, row, false);
      }
      const previous = (await pool.query('SELECT telegram_msg_id FROM order_materials WHERE order_id=$1 AND telegram_msg_id IS NOT NULL', [order.id])).rows;
      const known = new Set([order.telegram_msg_id,...previous.map(file => file.telegram_msg_id)].map(messageId).filter(Boolean));
      // Durable intent precedes the Telegram call. A crash or unknown network
      // acknowledgement requires an explicit retry instead of duplicate posts.
      await pool.query("UPDATE manual_order_attachments SET stage='sending',lease_until=NOW()+INTERVAL '60 seconds',updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id]);
      sending = true;
      const extra = { caption: '📎 Файл к заявке #' + order.id };
      if (sourceNumber(order.telegram_msg_id)) Object.assign(extra, { reply_to_message_id: Number(order.telegram_msg_id), allow_sending_without_reply: true });
      await publicationAccess(ctx,order.id);
      requested = true;
      const delivered = row.file.photo ? await ctx.telegram.sendPhoto(groupId, row.file.file_id, extra) : await ctx.telegram.sendDocument(groupId, row.file.file_id, extra);
      const receipt = messageId(delivered?.message_id), chat = String(groupId);
      const matchingChat = delivered?.chat == null || (chat.startsWith('@') ? String(delivered.chat.username || '').toLowerCase() === chat.slice(1).toLowerCase() : String(delivered.chat.id) === chat);
      if (!receipt || known.has(receipt) || !matchingChat) throw new Error('Telegram acknowledgement unavailable');
      await confirmDelivery(row, receipt);
      published = true;
      await notify(ctx, row, 'sent', '✅ Файл сохранён в документах заявки #' + order.id + ' и отправлен в рабочий чат.');
    } catch (error) {
      log();
      if (published) return; // A failed private acknowledgement must never resend the group post.
      if (!requested && error.code === 'MANUAL_PUBLICATION_UNAVAILABLE') {
        await pool.query("UPDATE manual_order_attachments SET stage=CASE WHEN material_id IS NULL THEN 'pending' ELSE 'saved' END,lease_until=NULL,reply_kind=NULL,updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2",[row.source_chat_id,row.source_message_id]).catch(log);
        return ctx.reply('Не удалось подтвердить текущий доступ или статус заявки. Файл не отправлен в рабочий чат. '+(row.material_id?'Сохранённый оригинал остаётся в документах заявки.':'Оригинал остаётся в вашем сообщении Telegram; в документы заявки он не добавлен.')+' После восстановления доступа повторите прикрепление.',retryKeyboard(row));
      }
      const rejected = sending && Number(error.response?.error_code) >= 400 && Number(error.response?.error_code) < 500;
      if (sending) {
        await pool.query("UPDATE manual_order_attachments SET stage=CASE WHEN $3::boolean THEN 'saved' ELSE stage END,lease_until=NULL,updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id, rejected]).catch(log);
        return publicationWarning(ctx, row, !rejected);
      }
      await pool.query("UPDATE manual_order_attachments SET stage='pending',lease_until=NULL,updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id]).catch(log);
      await ctx.reply('Не удалось сохранить файл в документах заявки #' + order.id + '. Файл пока не отправлен в рабочий чат. Нажмите кнопку для повторной попытки; заново присылать файл не нужно.', retryKeyboard(row));
    }
  }
  async function safe(ctx, run) {
    try { if (await authorized(ctx)) { await ensure(); await run(); } }
    catch (error) { log(); await ctx.reply(error.code === 'ORDER_DELIVERY_BUSY' ? 'Заявка сейчас обновляется. Повторите прикрепление через несколько секунд; оригинал остаётся в этом чате.' : 'Не удалось обработать вложение. Оригинал остаётся в этом чате. Повторите действие.'); }
  }
  async function receive(ctx) {
    return safe(ctx, async () => {
      const file = sourceFile(ctx.message || {});
      if (!file?.file_id || !sourceNumber(ctx.message.message_id)) return;
      await pool.query('INSERT INTO manual_order_attachments(source_chat_id,source_message_id,actor_tg_id,file) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [ctx.chat.id, ctx.message.message_id, ctx.from.id, JSON.stringify(file)]);
      const row = await receipt(ctx.chat.id, ctx.message.message_id);
      if (row.order_id) return process(ctx, row, row.order_id);
      return choose(ctx, row);
    });
  }
  async function select(ctx) {
    return safe(ctx, async () => {
      await ctx.answerCbQuery();
      const match = /^manual_attach:(\d+):(\d+)$/.exec(ctx.callbackQuery?.data || '');
      if (!match) return;
      const row = await receipt(ctx.chat.id, Number(match[1]));
      if (!row || String(row.actor_tg_id) !== String(ctx.from.id)) return ctx.reply('Вложение не найдено в вашем личном чате. Отправьте файл ещё раз.');
      return process(ctx, row, Number(match[2]));
    });
  }
  async function retry(ctx) {
    return safe(ctx, async () => {
      await ctx.answerCbQuery();
      const match = /^manual_retry:(\d+)(?::([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}))?$/i.exec(ctx.callbackQuery?.data || '');
      if (!match) return;
      const row = await receipt(ctx.chat.id, Number(match[1]));
      if (!row || String(row.actor_tg_id) !== String(ctx.from.id) || !row.order_id) return ctx.reply('Вложение не найдено. Отправьте файл ещё раз.');
      return process(ctx, row, row.order_id, true, match[2] || null);
    });
  }
  return { receive, select, retry, ensure };
}
function setupManualOrderAttachments(bot, options) {
  const handler = createManualOrderAttachments(options);
  bot.on(['photo', 'document'], handler.receive);
  bot.action(/^manual_attach:\d+:\d+$/, handler.select);
  bot.action(/^manual_retry:\d+(?::[a-f\d-]{36})?$/i, handler.retry);
  return handler;
}
module.exports = { DDL, sourceFile, createManualOrderAttachments, setupManualOrderAttachments, manualMaterialDeliveryState };
