const { Telegraf, Markup } = require('telegraf');
const { createOrder, updateOrderStatus, getOrderById, addLog, getStats, setTelegramMsgId } = require('../db/queries');
const { formatOrderMessage, STATUS_EMOJI } = require('./formatter');
const { handleAuditReport } = require('./audit-handler');

function setupBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);
  const GROUP_ID = process.env.GROUP_CHAT_ID;
  const WEBAPP_URL = process.env.WEBAPP_URL;

  bot.start(async (ctx) => {
    await ctx.reply(
      '👋 Привет!\n\nВыбери действие:',
      Markup.keyboard([
        [Markup.button.webApp('📋 Новая заявка', WEBAPP_URL + '/form')],
        [Markup.button.webApp('🔍 Отчёт аудитора', WEBAPP_URL + '/audit')],
      ]).resize()
    );
  });

  bot.command('stats', async (ctx) => {
    try {
      const s = await getStats();
      await ctx.reply(
        '*📊 Статистика заявок*\n\n' +
        '🆕 Новые: ' + s.new_count + '\n' +
        '🔧 В работе: ' + s.in_progress_count + '\n' +
        '✅ Выполнены: ' + s.done_count + '\n' +
        '❌ Отменены: ' + s.cancelled_count + '\n' +
        '⚠️ Просрочены: ' + s.overdue_count + '\n' +
        '─────────────\n' +
        '📁 Всего: ' + s.total_count,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('stats error:', err);
    }
  });

  bot.command('panel', async (ctx) => {
    await ctx.reply(
      '🖥 Веб-панель для просмотра всех заявок:',
      Markup.inlineKeyboard([
        Markup.button.url('Открыть панель', WEBAPP_URL + '/admin'),
      ])
    );
  });

  bot.on('web_app_data', async (ctx) => {
    try {
      const raw = ctx.webAppData && ctx.webAppData.data && ctx.webAppData.data.text();
      if (!raw) return;

      const data = JSON.parse(raw);

      // Отчёт аудитора
      if (data.type === 'audit') {
        await handleAuditReport(ctx, data);
        return;
      }

      // Заявка на замер
      data.submitted_by = ctx.from.id;
      const order = await createOrder(data);
      await addLog(order.id, 'created', String(ctx.from.id), 'Заявка создана через Mini App');

      await ctx.reply(
        '✅ Заявка #' + order.id + ' принята!\n\nМы получили её и скоро свяжемся.',
        Markup.removeKeyboard()
      );

      const text = formatOrderMessage(order);
      const msg = await ctx.telegram.sendMessage(GROUP_ID, text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔧 Взять в работу', callback_data: 'status:in_progress:' + order.id },
            { text: '✅ Готово', callback_data: 'status:done:' + order.id },
          ]],
        },
      });

      await setTelegramMsgId(order.id, msg.message_id);

    } catch (err) {
      console.error('web_app_data error:', err);
      await ctx.reply('❌ Ошибка при сохранении. Попробуйте ещё раз.');
    }
  });

  bot.action(/^status:(\w+):(\d+)$/, async (ctx) => {
    const newStatus = ctx.match[1];
    const orderId = ctx.match[2];
    const actor = ctx.from.username || String(ctx.from.id);

    try {
      const order = await updateOrderStatus(parseInt(orderId), newStatus, actor);
      if (!order) return ctx.answerCbQuery('Заявка не найдена');

      const text = formatOrderMessage(order);
      let buttons = [];
      if (newStatus === 'in_progress') {
        buttons = [[
          { text: '✅ Готово', callback_data: 'status:done:' + orderId },
          { text: '❌ Отменить', callback_data: 'status:cancelled:' + orderId },
        ]];
      } else if (newStatus === 'new') {
        buttons = [[{ text: '🔧 Взять в работу', callback_data: 'status:in_progress:' + orderId }]];
      }

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
      });

      const labels = { in_progress: 'взял в работу', done: 'закрыл', cancelled: 'отменил' };
      await ctx.answerCbQuery(STATUS_EMOJI[newStatus] + ' @' + actor + ' ' + (labels[newStatus] || newStatus));

    } catch (err) {
      console.error('callback error:', err);
      await ctx.answerCbQuery('Ошибка, попробуйте ещё раз');
    }
  });

  return bot;
}

module.exports = { setupBot };
