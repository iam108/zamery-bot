'use strict';

const { createOrderTelegramDelivery, messageId } = require('../web/order-telegram-delivery');
const PREVIEW_TTL = 10 * 60 * 1000, MAX_PREVIEWS = 100;

function createOrderDeliveryAdmin(options = {}) {
  const pool = options.pool || require('../db/pool');
  const delivery = options.delivery || createOrderTelegramDelivery({ pool, groupId: options.groupId });
  const withLock = options.withOrderDeliveryLock || require('../db/order-delivery-lock').createOrderDeliveryLock(pool);
  const previews = new Map(), now = options.now || Date.now;
  function allowed(ctx) {
    const configured = typeof options.adminIds === 'function' ? options.adminIds() : options.adminIds ?? process.env.ADMIN_TG_IDS ?? '';
    const admins = Array.isArray(configured) ? configured.map(String) : String(configured).split(/[\s,;]+/).filter(Boolean);
    return ctx.chat?.type === 'private' && admins.includes(String(ctx.from?.id));
  }
  function cleanup() { for (const [actor, entry] of previews) if (now() >= entry.expiresAt) previews.delete(actor); }
  async function preview(ctx) {
    if (!allowed(ctx)) return;
    const match = String(ctx.message?.text || '').match(/^\/order_delivery(?:@[a-z\d_]+)?\s+([1-9]\d*)\s*$/i);
    const id = messageId(match?.[1]), cursor = messageId(ctx.message?.message_id), actor = String(ctx.from.id);
    if (!id || id > 2147483647 || !cursor) return ctx.reply('Проверить доставку: /order_delivery номер_заявки');
    cleanup(); const previous = previews.get(actor);
    if (previous && cursor <= previous.cursor) return ctx.reply('Уже открыт более новый просмотр. Выполните /order_delivery заново новым сообщением.');
    if (!previous && previews.size >= MAX_PREVIEWS) return ctx.reply('Сейчас открыто слишком много просмотров. Повторите через десять минут.');
    const entry = { id, cursor, chat: String(ctx.chat.id), expiresAt: now() + PREVIEW_TTL, ready: false };
    previews.set(actor, entry);
    try {
      const result = await withLock(id, () => delivery.preview(id, { actorId: ctx.from.id, messageId: cursor }));
      if (previews.get(actor) !== entry) return;
      if (!Array.isArray(result.slots) || result.slots.length > 21 || result.slots.some(slot => !Number.isSafeInteger(slot.generation) || slot.generation < 1)) throw new Error('Invalid delivery preview');
      entry.slots = result.slots;
      let text = 'Доставка заявки #' + id + ': ';
      if (!entry.slots.length) text += 'неподтверждённых попыток нет.';
      else {
        text += entry.slots.length + ' неподтверждённых попыток.\n';
        text += entry.slots.map((slot, index) => (index + 1) + '. ' + String(slot.name).replace(/[\r\n]/g, ' ').slice(0, 180)).join('\n');
        text += '\n\nСначала проверьте рабочий чат: сообщение могло дойти. Только если выбранной части там нет, разрешите повтор:\n/order_delivery_retry ' + id + ' 1 confirm_missing\nЗамените 1 номером части выше. Повтор может создать дубликат. Просмотр действует десять минут; разрешение само ничего не отправляет.';
      }
      await ctx.reply(text);
      if (previews.get(actor) === entry) { entry.ready = true; entry.expiresAt = now() + PREVIEW_TTL; }
    } catch (_) {
      if (previews.get(actor) === entry) previews.delete(actor);
      return ctx.reply('Не удалось проверить доставку. Ничего не отправлялось. Повторите /order_delivery позднее.');
    }
  }
  async function retry(ctx) {
    if (!allowed(ctx)) return;
    const match = String(ctx.message?.text || '').match(/^\/order_delivery_retry(?:@[a-z\d_]+)?\s+([1-9]\d*)\s+([1-9]\d*)\s+confirm_missing\s*$/i);
    if (!match) return ctx.reply('Сначала проверьте чат и выполните /order_delivery номер_заявки. Затем: /order_delivery_retry номер_заявки номер_части confirm_missing. Повтор может создать дубликат.');
    cleanup(); const actor = String(ctx.from.id), entry = previews.get(actor), id = messageId(match[1]), index = Number(match[2]) - 1, cursor = messageId(ctx.message?.message_id);
    if (!entry?.ready || entry.id !== id || entry.chat !== String(ctx.chat.id) || !Number.isSafeInteger(index) || index < 0 || index >= entry.slots.length || !cursor || cursor <= entry.cursor) return ctx.reply('Нет актуального просмотренного состояния. Выполните /order_delivery ' + (id || 'номер_заявки') + ' заново; ничего не отправлялось.');
    const slot = entry.slots[index];
    try {
      const result = await withLock(id, () => delivery.allowRetry(id, slot.slot, { actorId: ctx.from.id, messageId: cursor, expectedGeneration: slot.generation }));
      if (result.state === 'stale' && previews.get(actor) === entry) previews.delete(actor);
      return ctx.reply(result.warning);
    } catch (_) { return ctx.reply('Не удалось сохранить разрешение. Ничего не отправлялось. Снова проверьте /order_delivery ' + id + '.'); }
  }
  return { preview, retry };
}

function setupOrderDeliveryAdmin(bot, options = {}) {
  const commands = createOrderDeliveryAdmin(options);
  bot.command('order_delivery', commands.preview);
  bot.command('order_delivery_retry', commands.retry);
  return commands;
}
module.exports = { createOrderDeliveryAdmin, setupOrderDeliveryAdmin, PREVIEW_TTL, MAX_PREVIEWS };
