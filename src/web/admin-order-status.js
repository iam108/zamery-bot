function createAdminOrderStatus(options = {}) {
  const queries = options.queries || require('../db/queries');
  const withLock = options.withOrderDeliveryLock || require('../db/order-delivery-lock').withOrderDeliveryLock;
  const getTelegram = options.getTelegram || (() => require('../bot/instance').telegram);
  const format = options.format || require('../bot/formatter').formatOrderMessage;
  const cardOptions = options.cardOptions || require('./manager-orders').cardOptions;
  const loadReportLink = options.loadOrderReportLink || (id => require('./order-report-link').loadOrderReportLink(id, options.pool ? { pool: options.pool } : {}));
  return async function adminOrderStatus(req, res) {
    const id = Number(req.body?.id), status = req.body?.status;
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647 || !['new','in_progress','done','cancelled'].includes(status))
      return res.status(400).json({ ok:false, error:'Проверьте номер заявки и статус.' });
    try {
      const result = await withLock(id, async () => {
        const current = await queries.getOrderById(id);
        if (!current) return { missing:true };
        const order = current.status === status ? current : await queries.updateOrderStatus(id, status, 'admin-web');
        if (!order) return { missing:true };
        let warning;
        if (order.telegram_msg_id) {
          try {
            const group = options.groupId ?? process.env.GROUP_CHAT_ID;
            if (!group) throw new Error('Missing working chat');
            const report = await loadReportLink(id);
            await getTelegram().editMessageText(group, Number(order.telegram_msg_id), undefined, format(order), cardOptions(order, report?.url));
          } catch (error) {
            if (!/message is not modified/i.test(error.response?.description || error.message || ''))
              warning = 'Статус сохранён. Не удалось обновить карточку в Telegram; повторите действие для её обновления.';
          }
        }
        return { ok:true, order, ...(warning ? { warning } : {}) };
      });
      return result.missing ? res.status(404).json({ ok:false, error:'Заявка не найдена.' }) : res.json(result);
    } catch (error) {
      if (error.code === 'ORDER_DELIVERY_BUSY') return res.status(409).json({ ok:false, error:'Заявка сейчас обновляется. Повторите действие через несколько секунд.' });
      throw error;
    }
  };
}
module.exports = { createAdminOrderStatus };
