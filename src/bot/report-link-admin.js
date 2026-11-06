'use strict';

const { randomBytes } = require('node:crypto');
const helpers = require('../web/order-report-link');
const BATCH_SIZE = 20, PREVIEW_TTL = 10 * 60 * 1000, MAX_PREVIEWS = 100;
const APPLY = /^report_links_apply:([A-Za-z0-9_-]{16})$/;
const REASONS = {
  ORDER_MISSING: 'заявка больше не найдена',
  ORDER_CARD_MISSING: 'нет исходной карточки',
  WORKING_CHAT_MISSING: 'не настроен рабочий чат',
  REPORT_LINK_MISSING: 'нет подтверждённой ссылки на отчёт',
  ORDER_CARD_UNAVAILABLE: 'исходная карточка недоступна для обновления',
};

function createReportLinkAdmin(options = {}) {
  const previews = new Map(), now = options.now || Date.now, token = options.token || (() => randomBytes(12).toString('base64url'));
  const previewLinks = options.previewOrderReportLinks || helpers.previewOrderReportLinks;
  const applyLinks = options.applyOrderReportLinks || helpers.applyOrderReportLinks;
  let active = null;
  const group = () => String(options.groupId ?? process.env.GROUP_CHAT_ID ?? '');
  function allowed(ctx) {
    const configured = typeof options.adminIds === 'function' ? options.adminIds() : options.adminIds ?? process.env.ADMIN_TG_IDS ?? '';
    const admins = Array.isArray(configured) ? configured.map(String) : String(configured).split(/[\s,;]+/).filter(Boolean);
    return ctx.chat?.type === 'private' && admins.includes(String(ctx.from?.id));
  }
  function cleanup() { for (const [actor, entry] of previews) if (entry !== active && now() >= entry.expiresAt) previews.delete(actor); }
  const keyboard = (entry, retry = false) => ({ reply_markup: { inline_keyboard: [[{ text: retry ? 'Повторить оставшиеся' : 'Добавить переходы', callback_data: 'report_links_apply:' + entry.token }]] } });
  const answer = (ctx, text) => Promise.resolve().then(() => ctx.answerCbQuery(text)).catch(() => {});
  const nextPage = entry => entry.nextAfterId == null ? '' : '\nСледующая порция: /report_links ' + entry.nextAfterId;
  function summary(entry) {
    let text = 'Переходы к отчётам: готово ' + entry.linked + ', пропущено ' + entry.skipped.length + ', осталось ' + entry.remaining.length + '.';
    for (const item of entry.skipped) text += '\n#' + item.order_id + ' — ' + (REASONS[item.code] || 'карточка недоступна');
    return text + (!entry.remaining.length ? nextPage(entry) : '\nПовтор продолжит только оставшиеся карточки.');
  }

  async function preview(ctx) {
    if (!allowed(ctx)) return;
    cleanup(); const actor = String(ctx.from.id), previous = previews.get(actor);
    if (previous === active) return ctx.reply('Обновление уже выполняется. Дождитесь результата.');
    const match = String(ctx.message?.text || '').match(/^\/report_links(?:@[a-z\d_]+)?(?:\s+(\d+))?\s*$/i), afterId = Number(match?.[1] || 0);
    if (!match || !Number.isSafeInteger(afterId) || afterId < 0 || afterId > 2147483647) return ctx.reply('Предварительный просмотр: /report_links. Следующая порция: /report_links номер_последней_заявки.');
    if (!previous && previews.size >= MAX_PREVIEWS) return ctx.reply('Сейчас открыто слишком много просмотров. Повторите через десять минут.');
    try {
      const targetGroup = group();
      const result = await previewLinks({ pool: options.pool, groupId: targetGroup, limit: BATCH_SIZE, afterId });
      cleanup();
      if (previews.get(actor) === active) return ctx.reply('Обновление уже выполняется. Дождитесь результата.');
      if (!previews.has(actor) && previews.size >= MAX_PREVIEWS) return ctx.reply('Сейчас открыто слишком много просмотров. Повторите через десять минут.');
      if (!Array.isArray(result.items) || result.items.length > BATCH_SIZE) throw new Error('Invalid preview');
      const remaining = [...new Set(result.items.filter(item => !item.code).map(item => item.order_id))];
      if (remaining.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) throw new Error('Invalid preview');
      const skipped = result.items.filter(item => item.code).map(item => ({ order_id: item.order_id, code: item.code }));
      const entry = { token: token(), actor, chat: String(ctx.chat.id), group: targetGroup, remaining, linked: 0, skipped, phase: 'ready', expiresAt: now() + PREVIEW_TTL, nextAfterId: result.nextAfterId };
      if (!/^[A-Za-z0-9_-]{16}$/.test(entry.token)) throw new Error('Invalid preview token');
      previews.delete(actor);
      if (!result.items.length) return ctx.reply('Заявок с сохранёнными отчётами больше нет.');
      let text = 'Предварительный просмотр · ' + result.items.length + ' заявок.\n';
      text += result.items.map(item => '#' + item.order_id + ' — ' + (item.code ? REASONS[item.code] || 'карточка недоступна' : 'добавить переход к готовому отчёту')).join('\n');
      text += '\n\nДо нажатия кнопки карточки не меняются. Просмотр действует десять минут.' + nextPage(entry);
      if (remaining.length) previews.set(actor, entry);
      return ctx.reply(text, remaining.length ? keyboard(entry) : undefined);
    } catch (_) { return ctx.reply('Не удалось подготовить список. Карточки не менялись; повторите /report_links позднее.'); }
  }

  async function apply(ctx) {
    if (!allowed(ctx)) return answer(ctx, 'Команда доступна администратору в личном чате.');
    cleanup(); const actor = String(ctx.from.id), entry = previews.get(actor), match = String(ctx.callbackQuery?.data || '').match(APPLY);
    if (!match || !entry || entry.token !== match[1] || entry.chat !== String(ctx.chat.id) || entry.group !== group()) return answer(ctx, 'Просмотр устарел. Выполните /report_links заново.');
    if (active) return answer(ctx, 'Обновление уже выполняется. Дождитесь результата.');
    if (entry.phase === 'done') return answer(ctx, 'Эти карточки уже обработаны. Готово: ' + entry.linked + ', пропущено: ' + entry.skipped.length + '.');
    active = entry; entry.phase = 'running'; await answer(ctx, 'Добавляю переходы…');
    let failed = false;
    try {
      const ids = entry.remaining.slice(), result = await applyLinks(ids, {
        pool: options.pool, groupId: entry.group, telegram: ctx.telegram, queries: options.queries,
        getOrderById: options.getOrderById, withOrderDeliveryLock: options.withOrderDeliveryLock, cardOptions: options.cardOptions,
      });
      if (!Array.isArray(result.results) || result.results.length > ids.length || result.results.some((item, index) => item.order_id !== ids[index] || !['linked', 'skipped'].includes(item.state))) throw new Error('Invalid apply result');
      for (const item of result.results) {
        if (item.state === 'linked') entry.linked++;
        else entry.skipped.push({ order_id: item.order_id, code: item.code });
      }
      entry.remaining = ids.slice(result.results.length);
      failed = !result.complete || entry.remaining.length > 0;
    } catch (_) { failed = true; }
    finally { entry.phase = entry.remaining.length ? 'ready' : 'done'; entry.expiresAt = now() + PREVIEW_TTL; active = null; }
    // Commit the in-memory receipt before the private confirmation: a lost DM
    // acknowledgement must not cause the next button tap to repeat this batch.
    return ctx.reply((failed ? 'Обновление остановлено. ' : '') + summary(entry), entry.remaining.length ? keyboard(entry, true) : undefined);
  }

  return { preview, apply };
}

function setupReportLinkAdmin(bot, options = {}) {
  const commands = createReportLinkAdmin(options);
  bot.command('report_links', commands.preview);
  bot.action(APPLY, commands.apply);
  return commands;
}

module.exports = { setupReportLinkAdmin, createReportLinkAdmin, BATCH_SIZE, PREVIEW_TTL, MAX_PREVIEWS };
