'use strict';

// A saved audit is written only after every report message and original has
// been delivered. Preserve its message order: the first ID is the summary.
const VALID_AUDIT = `a.msg_ids[1] BETWEEN 1 AND 9007199254740991
  AND a.chat_id BETWEEN -9007199254740991 AND -1
  AND a.chat_id::text ~ '^-100[1-9][0-9]*$'`;

function invalid(message, code = 'INVALID_ORDER') { return Object.assign(new Error(message), { status: 400, code }); }
function orderNumber(value, allowZero = false) {
  const number = Number(value);
  if ((typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) || !Number.isSafeInteger(number) || number < (allowZero ? 0 : 1) || number > 2147483647) throw invalid('Некорректный номер заявки.');
  return number;
}
function telegramMessageUrl(chatId, messageId) {
  const id = Number(messageId);
  if ((typeof messageId !== 'number' && !(typeof messageId === 'string' && /^\d+$/.test(messageId))) || !Number.isSafeInteger(id) || id <= 0) return null;
  const chat = String(chatId ?? '');
  if (/^-100[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat))) return 'https://t.me/c/' + chat.slice(4) + '/' + id;
  if (/^@[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(chat)) return 'https://t.me/' + chat.slice(1) + '/' + id;
  return null;
}
function reference(row) {
  if (!row) return null;
  const url = telegramMessageUrl(row.chat_id, row.message_id);
  return url ? { audit_id: Number(row.audit_id), chat_id: String(row.chat_id), message_id: Number(row.message_id), url } : null;
}
function connection(options) { return options.pool || require('../db/pool'); }

async function loadOrderReportLink(value, options = {}) {
  const id = orderNumber(value), pool = connection(options);
  const { rows } = await pool.query(`SELECT a.id AS audit_id,a.chat_id,a.msg_ids[1] AS message_id
    FROM audits a WHERE a.order_id=$1 AND ${VALID_AUDIT}
    ORDER BY a.created_at DESC NULLS LAST,a.id DESC LIMIT 1`, [id]);
  return reference(rows[0]);
}

const WARNINGS = {
  ORDER_MISSING: 'Отчёт сохранён. Исходная заявка больше не найдена; кнопка перехода в её карточку не добавлена.',
  ORDER_CARD_MISSING: 'Отчёт сохранён. У заявки ещё нет исходной карточки в Telegram; кнопка перехода не добавлена.',
  WORKING_CHAT_MISSING: 'Отчёт сохранён, но рабочий чат заявки не настроен; кнопка перехода не добавлена.',
  REPORT_LINK_MISSING: 'Отчёт сохранён, но ссылка на опубликованное сообщение не подтверждена; кнопка перехода не добавлена.',
  ORDER_CARD_UNAVAILABLE: 'Отчёт сохранён. Исходная карточка заявки удалена или недоступна для обновления; кнопка перехода не добавлена.',
};
function skipped(id, code) { return { state: 'skipped', order_id: id, code, warning: WARNINGS[code] }; }
function targetMessage(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }
function workingChat(value) {
  const chat = String(value ?? '');
  return (/^-?[1-9]\d*$/.test(chat) && Number.isSafeInteger(Number(chat))) || /^@[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(chat) ? chat : null;
}

async function syncOrderReportLink(value, options = {}) {
  const id = orderNumber(value), pool = connection(options);
  const withLock = options.withOrderDeliveryLock || require('../db/order-delivery-lock').createOrderDeliveryLock(pool);
  const getOrder = options.getOrderById || options.queries?.getOrderById || require('../db/queries').getOrderById;
  return withLock(id, async () => {
    // Resolve both inside the same lock used by manager/status publishers.
    // A retry of an older report must link the latest persisted summary.
    const order = await getOrder(id);
    if (!order) return skipped(id, 'ORDER_MISSING');
    const message = targetMessage(order.telegram_msg_id);
    if (!message) return skipped(id, 'ORDER_CARD_MISSING');
    const chat = workingChat(options.groupId ?? process.env.GROUP_CHAT_ID);
    if (!chat) return skipped(id, 'WORKING_CHAT_MISSING');
    const report = await loadOrderReportLink(id, { pool });
    if (!report) return skipped(id, 'REPORT_LINK_MISSING');
    const telegram = options.telegram || require('../bot/instance').telegram;
    const cardOptions = options.cardOptions || require('./manager-orders').cardOptions;
    try {
      await telegram.editMessageReplyMarkup(chat, message, undefined, cardOptions(order, report.url).reply_markup);
    } catch (error) {
      const code = Number(error.response?.error_code), description = error.response?.description || error.message || '';
      if (!(code === 400 && /message is not modified/i.test(description))) {
        if (code === 400 && /message to edit not found|message (?:can't|cannot) be edited/i.test(description)) return skipped(id, 'ORDER_CARD_UNAVAILABLE');
        throw error;
      }
    }
    return { state: 'linked', order_id: id, card_chat_id: chat, card_message_id: message, ...report };
  });
}

async function previewOrderReportLinks(options = {}) {
  const afterId = orderNumber(options.afterId ?? 0, true), limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('За один раз можно проверить от 1 до 100 заявок.', 'INVALID_LIMIT');
  const { rows } = await connection(options).query(`SELECT o.id AS order_id,o.telegram_msg_id AS card_message_id,
      a.audit_id,a.chat_id,a.message_id
    FROM orders o JOIN LATERAL (
      SELECT a.id AS audit_id,a.chat_id,a.msg_ids[1] AS message_id FROM audits a
      WHERE a.order_id=o.id AND ${VALID_AUDIT} ORDER BY a.created_at DESC NULLS LAST,a.id DESC LIMIT 1
    ) a ON true WHERE o.id>$1 ORDER BY o.id LIMIT $2`, [afterId, limit]);
  const chat = workingChat(options.groupId ?? process.env.GROUP_CHAT_ID);
  const items = rows.map(row => ({ order_id: Number(row.order_id), card_chat_id: chat, card_message_id: targetMessage(row.card_message_id), ...reference(row),
    ...(!targetMessage(row.card_message_id) ? { code: 'ORDER_CARD_MISSING' } : !chat ? { code: 'WORKING_CHAT_MISSING' } : {}),
  }));
  return { items, nextAfterId: rows.length === limit ? Number(rows.at(-1).order_id) : null };
}

async function applyOrderReportLinks(values, options = {}) {
  if (!Array.isArray(values) || values.length > 100) throw invalid('За один раз можно обновить до 100 карточек.', 'INVALID_LIMIT');
  const ids = [...new Set(values.map(value => orderNumber(value)))], results = [];
  for (const id of ids) {
    try { results.push(await syncOrderReportLink(id, options)); }
    catch (error) {
      // Stop on throttling or transport trouble; never send a replacement card.
      return { results, complete: false, failed_order_id: id, error: { code: 'ORDER_CARD_LINK_RETRY', message: 'Не удалось обновить карточку заявки. Повторите обновление оставшихся карточек позднее.' } };
    }
  }
  return { results, complete: true };
}

module.exports = { telegramMessageUrl, loadOrderReportLink, syncOrderReportLink, previewOrderReportLinks, applyOrderReportLinks };
