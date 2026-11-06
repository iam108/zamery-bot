// Explicit transport double for tests whose subject is packet editing or locking.
// Durable Telegram intent/receipt behavior is covered against SQL separately.
function orderDeliveryDouble(options) {
  return {
    async publishCard(order, text, extra) {
      try {
        if (order.telegram_msg_id) {
          await options.getTelegram().editMessageText('-100321', Number(order.telegram_msg_id), undefined, text, extra);
          return { ok: true, usable: true, message_id: Number(order.telegram_msg_id) };
        }
        const sent = await options.getTelegram().sendMessage('-100321', text, extra);
        await options.queries.setTelegramMsgId(order.id, sent.message_id);
        return { ok: true, usable: true, created: true, message_id: sent.message_id };
      } catch (_) { return { ok: false, usable: !!order.telegram_msg_id, warning: 'Не удалось обновить карточку в чате.' }; }
    },
    async publishMaterial(order, file) {
      const sent = await options.getTelegram().sendDocument('-100321', { source: file.buffer, filename: file.name }, { reply_to_message_id: order.telegram_msg_id });
      await options.materials.markOrderMaterialDelivered(order.id, file.id, sent.message_id);
      return { ok: true, message_id: sent.message_id };
    },
  };
}
module.exports = { orderDeliveryDouble };
