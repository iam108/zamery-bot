const defaultPool = require('../db/pool');
const defaultMaterials = require('../web/order-materials');
const { telegramOriginal } = require('./order-evidence');

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
);`;
const OPEN = "status NOT IN ('done','cancelled')";
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
  async function notify(ctx, row, kind, text, extra) {
    if (row.reply_kind === kind) return;
    await ctx.reply(text, extra);
    await pool.query('UPDATE manual_order_attachments SET reply_kind=$3 WHERE source_chat_id=$1 AND source_message_id=$2', [row.source_chat_id, row.source_message_id, kind]);
  }
  const retryKeyboard = row => ({ reply_markup: { inline_keyboard: [[{ text: 'Повторить отправку в рабочий чат', callback_data: 'manual_retry:' + row.source_message_id }]] } });
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
  async function process(ctx, initial, orderId, explicitRetry = false) {
    let row = await receipt(initial.source_chat_id, initial.source_message_id);
    if (!row || String(row.actor_tg_id) !== String(ctx.from.id)) return;
    if (row.order_id && Number(row.order_id) !== Number(orderId)) return ctx.reply('Этот файл уже относится к заявке #' + row.order_id + '. Для другой заявки отправьте его отдельным сообщением.');
    if (row.stage === 'sent') return notify(ctx, row, 'sent', '✅ Файл сохранён в документах заявки #' + row.order_id + ' и отправлен в рабочий чат.');
    if (row.stage === 'sending' && !explicitRetry) return publicationWarning(ctx, row, true);
    const order = (await pool.query('SELECT * FROM orders WHERE id=$1 AND submitted_by=$2 AND ' + OPEN, [orderId, ctx.from.id])).rows[0];
    if (!order) return ctx.reply('Заявка закрыта или недоступна. Файл к ней не прикреплён.');
    if (Number(row.file.bytes) > materials.LIMITS.fileBytes) return notify(ctx, row, 'oversize', 'Файл «' + row.file.name + '» больше 12 МБ. В документы заявки он не добавлен. Оригинал остаётся в вашем сообщении Telegram. Для большого файла используйте ссылку на Яндекс Диск в форме заявки.');
    const claimed = (await pool.query(`UPDATE manual_order_attachments SET order_id=$3,stage='processing',lease_until=NOW()+INTERVAL '60 seconds',updated_at=NOW(),reply_kind=NULL
      WHERE source_chat_id=$1 AND source_message_id=$2 AND (order_id IS NULL OR order_id=$3)
      AND (stage IN ('pending','saved') OR stage='processing' AND lease_until<NOW() OR $4::boolean AND stage='sending' AND (lease_until IS NULL OR lease_until<NOW())) RETURNING *`, [row.source_chat_id, row.source_message_id, order.id, explicitRetry])).rows[0];
    if (!claimed) return ctx.reply('Этот файл уже обрабатывается. Повторите проверку чуть позже; повторно отправлять сам файл не нужно.');
    row = claimed;
    let sending = false, published = false;
    try {
      if (!row.material_id) {
        const link = await ctx.telegram.getFileLink(row.file.file_id);
        const buffer = await (options.download || telegramOriginal)(link, options.fetch || globalThis.fetch);
        const prepared = materials.prepareMaterials([{ originalname: row.file.name, mimetype: row.file.mime, buffer }]);
        await materials.saveOrderMaterials(order.id, prepared);
        row.material_id = prepared[0].id;
        await pool.query("UPDATE manual_order_attachments SET material_id=$3,updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id, row.material_id]);
      }
      if (!groupId) {
        await pool.query("UPDATE manual_order_attachments SET stage='saved',lease_until=NULL WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id]);
        return publicationWarning(ctx, row, false);
      }
      // Durable intent precedes the Telegram call. A crash or unknown network
      // acknowledgement requires an explicit retry instead of duplicate posts.
      await pool.query("UPDATE manual_order_attachments SET stage='sending',lease_until=NOW()+INTERVAL '60 seconds',updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id]);
      sending = true;
      const extra = { caption: '📎 Файл к заявке #' + order.id };
      if (sourceNumber(order.telegram_msg_id)) Object.assign(extra, { reply_to_message_id: Number(order.telegram_msg_id), allow_sending_without_reply: true });
      const delivered = row.file.photo ? await ctx.telegram.sendPhoto(groupId, row.file.file_id, extra) : await ctx.telegram.sendDocument(groupId, row.file.file_id, extra);
      if (!sourceNumber(delivered?.message_id)) throw new Error('Telegram acknowledgement unavailable');
      await pool.query("UPDATE manual_order_attachments SET stage='sent',group_message_id=$3,updated_at=NOW() WHERE source_chat_id=$1 AND source_message_id=$2", [row.source_chat_id, row.source_message_id, delivered.message_id]);
      published = true;
      await notify(ctx, row, 'sent', '✅ Файл сохранён в документах заявки #' + order.id + ' и отправлен в рабочий чат.');
    } catch (error) {
      log();
      if (published) return; // A failed private acknowledgement must never resend the group post.
      const rejected = sending && Number(error.response?.error_code) >= 400;
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
    catch (error) { log(); await ctx.reply('Не удалось обработать вложение. Оригинал остаётся в этом чате. Повторите действие.'); }
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
      const match = /^manual_retry:(\d+)$/.exec(ctx.callbackQuery?.data || '');
      if (!match) return;
      const row = await receipt(ctx.chat.id, Number(match[1]));
      if (!row || String(row.actor_tg_id) !== String(ctx.from.id) || !row.order_id) return ctx.reply('Вложение не найдено. Отправьте файл ещё раз.');
      return process(ctx, row, row.order_id, true);
    });
  }
  return { receive, select, retry, ensure };
}
function setupManualOrderAttachments(bot, options) {
  const handler = createManualOrderAttachments(options);
  bot.on(['photo', 'document'], handler.receive);
  bot.action(/^manual_attach:\d+:\d+$/, handler.select);
  bot.action(/^manual_retry:\d+$/, handler.retry);
  return handler;
}
module.exports = { DDL, sourceFile, createManualOrderAttachments, setupManualOrderAttachments };
