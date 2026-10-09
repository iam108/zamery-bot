const { Telegraf, Markup } = require('telegraf');
const { createOrder, updateOrderStatus, getOrderById, addLog, getStats, setTelegramMsgId } = require('../db/queries');
const { formatOrderMessage, STATUS_EMOJI } = require('./formatter');
const { handleAuditReport } = require('./audit-handler');

function setupBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);
  const GROUP_ID = process.env.GROUP_CHAT_ID;
  const WEBAPP_URL = process.env.WEBAPP_URL;
  require('../web/handoff').setupReportsBot(bot);
  require('./egrn').setupEgrn(bot);
  const pool = require('../db/pool');
  const { ensureStaff } = require('../web/auth');
  const { esc } = require('./formatter');
  const ROLES = { manager: 'Менеджер', lawyer: 'Юрист', auditor: 'Аудитор' };
  const roleKb = () => Markup.inlineKeyboard([
    [Markup.button.callback('👔 Менеджер', 'role:manager')],
    [Markup.button.callback('⚖️ Юрист', 'role:lawyer')],
    [Markup.button.callback('🔍 Аудитор', 'role:auditor')],
  ]);
  const adminIds = () => String(process.env.ADMIN_TG_IDS || '').split(/[\s,;]+/).filter(Boolean);

  // Кто одобряет: ADMIN_TG_IDS из Railway, а если не задано — все одобренные менеджеры
  async function approvers() {
    const ids = adminIds();
    if (ids.length) return ids;
    const { rows } = await pool.query("SELECT tg_id FROM staff WHERE role='manager' AND approved = true");
    return rows.map(r => String(r.tg_id));
  }
  async function getMe(id) {
    await ensureStaff();
    return (await pool.query('SELECT * FROM staff WHERE tg_id=$1', [id])).rows[0];
  }

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const me = await getMe(ctx.from.id);
    if (!me) return ctx.reply('👋 Привет! Кто вы в команде?', roleKb());
    if (!me.approved) return ctx.reply('⏳ Заявка на доступ (' + (ROLES[me.requested_role || me.role] || '') + ') ждёт одобрения. Как только её одобрят, я напишу.');
    // Кнопки клавиатуры не получают подпись Telegram — добавляем личный ключ сотрудника
    const kq = '?' + require('../web/auth').keyQuery(ctx.from.id);
    console.log('/start keyboard with key for', ctx.from.id, me.role);
    const zamer = Markup.button.webApp('📋 Заявка на замер', WEBAPP_URL + '/form' + kq);
    let kb;
    const requestsBtn = Markup.button.webApp('📥 Нераспределённые', WEBAPP_URL + '/requests' + kq);
    const handoffBtn = Markup.button.webApp('⚖️ Передать юристу', WEBAPP_URL + '/handoff' + kq);
    if (me.role === 'manager') kb = [[requestsBtn], [zamer, handoffBtn], ['📄 Выписка ЕГРН']];
    else if (me.role === 'lawyer') kb = [[requestsBtn], [zamer, '📂 Мои клиенты'], ['📄 Выписка ЕГРН']];
    else kb = [[Markup.button.webApp('🔍 Отчёт аудитора', WEBAPP_URL + '/audit' + kq)], ['📄 Выписка ЕГРН']];
    const pending = me.requested_role && me.requested_role !== me.role ? '\n⏳ Запрос на роль «' + ROLES[me.requested_role] + '» ждёт одобрения.' : '';
    await ctx.reply('👋 ' + me.name + ' (' + ROLES[me.role] + ')' + pending + '\n\nВыбери действие:', Markup.keyboard(kb).resize());
  });

  bot.action(/^role:(manager|lawyer|auditor)$/, async (ctx) => {
    const role = ctx.match[1];
    const uid = String(ctx.from.id);
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Без имени';
    const me = await getMe(ctx.from.id);
    const list = await approvers();
    const isAdmin = adminIds().indexOf(uid) !== -1;
    const anyApproved = (await pool.query('SELECT 1 FROM staff WHERE approved = true LIMIT 1')).rows.length > 0;

    // Админ — сразу. Самый первый сотрудник в пустой базе — тоже сразу (иначе некому одобрять)
    if (isAdmin || (!anyApproved && !list.length)) {
      await pool.query(
        'INSERT INTO staff (tg_id, name, username, role, approved, requested_role) VALUES ($1,$2,$3,$4,true,NULL) ON CONFLICT (tg_id) DO UPDATE SET name=$2, username=$3, role=$4, approved=true, requested_role=NULL',
        [ctx.from.id, name, ctx.from.username || null, role]);
      await ctx.editMessageText('✅ Вы зарегистрированы как: ' + ROLES[role] + '\n\nНажмите /start');
      return ctx.answerCbQuery();
    }
    if (me && me.approved && me.role === role) {
      await ctx.editMessageText('У вас уже роль «' + ROLES[role] + '». Нажмите /start');
      return ctx.answerCbQuery();
    }
    if (me) await pool.query('UPDATE staff SET name=$2, username=$3, requested_role=$4 WHERE tg_id=$1', [ctx.from.id, name, ctx.from.username || null, role]);
    else await pool.query('INSERT INTO staff (tg_id, name, username, role, approved, requested_role) VALUES ($1,$2,$3,$4,false,$4)', [ctx.from.id, name, ctx.from.username || null, role]);

    const text = '🙋 <b>' + (me && me.approved ? 'Смена роли' : 'Новый сотрудник') + '</b>\n' + esc(name) + (ctx.from.username ? ' (@' + esc(ctx.from.username) + ')' : '') +
      (me && me.approved ? '\nСейчас: ' + ROLES[me.role] : '') + '\nПросит роль: <b>' + ROLES[role] + '</b>';
    const kb = { inline_keyboard: [[{ text: '✅ Одобрить', callback_data: 'ap:' + uid }, { text: '❌ Отклонить', callback_data: 'rj:' + uid }]] };
    let sent = 0;
    for (const id of list) {
      if (id === uid) continue;
      try { await ctx.telegram.sendMessage(id, text, { parse_mode: 'HTML', reply_markup: kb }); sent++; } catch (e) { console.error('approve notify:', e.message); }
    }
    await ctx.editMessageText(sent
      ? '⏳ Запрос на роль «' + ROLES[role] + '» отправлен на одобрение. Я напишу, когда его одобрят.'
      : '⏳ Запрос сохранён, но отправить его на одобрение некому. Попросите администратора открыть бота.');
    await ctx.answerCbQuery();
  });

  bot.action(/^(ap|rj):(\d+)$/, async (ctx) => {
    const list = await approvers();
    if (list.indexOf(String(ctx.from.id)) === -1) return ctx.answerCbQuery('Одобрять может только администратор', { show_alert: true });
    const uid = ctx.match[2];
    const u = (await pool.query('SELECT * FROM staff WHERE tg_id=$1', [uid])).rows[0];
    if (!u || !u.requested_role) {
      await ctx.editMessageText('Запрос уже обработан.');
      return ctx.answerCbQuery();
    }
    const who = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const wanted = ROLES[u.requested_role];
    if (ctx.match[1] === 'ap') {
      await pool.query('UPDATE staff SET role=requested_role, approved=true, requested_role=NULL WHERE tg_id=$1', [uid]);
      await ctx.editMessageText('✅ ' + u.name + ' — ' + wanted + '. Одобрил(а): ' + who);
      try { await ctx.telegram.sendMessage(uid, '✅ Доступ открыт: ' + wanted + '. Нажмите /start'); } catch (e) {}
    } else {
      if (u.approved) await pool.query('UPDATE staff SET requested_role=NULL WHERE tg_id=$1', [uid]);
      else await pool.query('DELETE FROM staff WHERE tg_id=$1', [uid]);
      await ctx.editMessageText('❌ ' + u.name + ' — запрос на роль «' + wanted + '» отклонён. ' + who);
      try { await ctx.telegram.sendMessage(uid, '❌ Запрос на роль «' + wanted + '» отклонён.'); } catch (e) {}
    }
    await ctx.answerCbQuery();
  });

  bot.command('role', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply('Сменить роль (нужно одобрение администратора):', roleKb());
  });

  bot.command('stats', async (ctx) => {
    try {
      const s = await getStats();
      await ctx.reply(
        '<b>📊 Статистика заявок</b>\n\n' +
        '🆕 Новые: ' + s.new_count + '\n' +
        '🔧 В работе: ' + s.in_progress_count + '\n' +
        '✅ Выполнены: ' + s.done_count + '\n' +
        '❌ Отменены: ' + s.cancelled_count + '\n' +
        '⚠️ Просрочены: ' + s.overdue_count + '\n' +
        '─────────────\n' +
        '📁 Всего: ' + s.total_count,
        { parse_mode: 'HTML' }
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

      if (data.type === 'audit') {
        await handleAuditReport(ctx, data);
        return;
      }

      data.submitted_by = ctx.from.id;
      const order = await createOrder(data);
      await addLog(order.id, 'created', String(ctx.from.id), 'Заявка создана через Mini App');

      await ctx.reply(
        '✅ Заявка #' + order.id + ' принята!\n\nМы получили её и скоро свяжемся.',
        Markup.removeKeyboard()
      );

      const text = formatOrderMessage(order);
      const msg = await ctx.telegram.sendMessage(GROUP_ID, text, {
        parse_mode: 'HTML',
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

  // Кнопка "Написать отчёт" — отправляем ссылку в личку аудитору
  bot.action(/^report:(\d+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    const userId = ctx.from.id;
    const auditUrl = WEBAPP_URL + '/audit?order_id=' + orderId;

    try {
      await ctx.telegram.sendMessage(userId,
        '📋 Заполни отчёт по заявке #' + orderId + ':',
        Markup.inlineKeyboard([
          Markup.button.webApp('🔍 Открыть форму отчёта', auditUrl),
        ])
      );
      await ctx.answerCbQuery('Ссылка отправлена в личку 👆');
    } catch (e) {
      await ctx.answerCbQuery('Напиши боту в личку сначала — нажми /start');
    }
  });

  bot.action(/^status:(new|in_progress|done|cancelled):(\d+)$/, async (ctx) => {
    const newStatus = ctx.match[1];
    const orderId = ctx.match[2];
    const actor = ctx.from.username ? '@' + ctx.from.username : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id);

    try {
      const order = await updateOrderStatus(parseInt(orderId), newStatus, actor);
      if (!order) return ctx.answerCbQuery('Заявка не найдена');

      const text = formatOrderMessage(order);
      let buttons = [];

      if (newStatus === 'in_progress') {
        buttons = [[
          { text: '✅ Готово', callback_data: 'status:done:' + orderId },
          { text: '❌ Отменить', callback_data: 'status:cancelled:' + orderId },
        ], [
          { text: '📋 Написать отчёт', callback_data: 'report:' + orderId },
        ]];
      } else if (newStatus === 'new') {
        buttons = [[
          { text: '🔧 Взять в работу', callback_data: 'status:in_progress:' + orderId },
        ]];
      } else if (newStatus === 'done') {
        buttons = [[
          { text: '📋 Написать отчёт', callback_data: 'report:' + orderId },
        ]];
      }

      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
      });

      const labels = { in_progress: 'взял в работу', done: 'закрыл', cancelled: 'отменил' };
      await ctx.answerCbQuery(STATUS_EMOJI[newStatus] + ' ' + (ctx.from.username ? '@' + ctx.from.username : (ctx.from.first_name || '')) + ' ' + (labels[newStatus] || newStatus));

    } catch (err) {
      console.error('callback error:', err);
      await ctx.answerCbQuery('Ошибка, попробуйте ещё раз');
    }
  });
// Получаем файлы от пользователя в личке — прикрепляем к последней заявке
bot.on(['photo', 'document'], async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  
  try {
    const me = await getMe(ctx.from.id);
    if (!me || !me.approved) return ctx.reply('Нет доступа. Нажмите /start.');
    // Последняя открытая заявка этого пользователя
    const order = (await pool.query(
      "SELECT * FROM orders WHERE submitted_by=$1 AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1", [ctx.from.id])).rows[0];
    if (!order) return ctx.reply('Нет открытых заявок, к которым можно прикрепить файл.');
    const replyTo = order.telegram_msg_id;
    
    const caption = '📎 Файл к заявке #' + order.id;
    
    if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      await ctx.telegram.sendPhoto(GROUP_ID, photo.file_id, {
        caption: caption,
        reply_to_message_id: replyTo,
      });
    } else if (ctx.message.document) {
      await ctx.telegram.sendDocument(GROUP_ID, ctx.message.document.file_id, {
        caption: caption,
        reply_to_message_id: replyTo,
      });
    }
    
    await ctx.reply('✅ Файл прикреплён к заявке #' + order.id);
  } catch(e) {
    console.error('file attach error:', e.message);
    await ctx.reply('Ошибка при прикреплении файла.');
  }
});
    // Кнопка «Передать юристу» в группе замеров → ссылка на форму в личку
  bot.action(/^handoff:(\d+)$/, async (ctx) => {
    const orderId = ctx.match[1];
    try {
      await ctx.telegram.sendMessage(ctx.from.id, '⚖️ Передать заявку #' + orderId + ' юристу:', {
        reply_markup: { inline_keyboard: [[{ text: '📝 Открыть форму', web_app: { url: WEBAPP_URL + '/handoff?order_id=' + orderId } }]] },
      });
      await ctx.answerCbQuery('Форма отправлена вам в личку 👆');
    } catch (e) {
      await ctx.answerCbQuery('Сначала напишите боту /start в личке', { show_alert: true });
    }
  });

   // Юрист: список моих клиентов с чек-листами
  bot.hears('📂 Мои клиенты', (ctx) => showCases(ctx));
  bot.command('cases', (ctx) => showCases(ctx));
  async function showCases(ctx) {
    const me = await getMe(ctx.from.id);
    if (!me || !me.approved) return ctx.reply('Нет доступа. Нажмите /start.');
    const { rows } = await pool.query(
           "SELECT id, org, done, total, data->>'_stage' AS stage FROM cases WHERE lawyer_tg_id=$1 AND COALESCE(data->>'_stage', '') <> 'Архив' ORDER BY created_at DESC LIMIT 30",
      [ctx.from.id]
    );
    if (!rows.length) return ctx.reply('У вас нет открытых клиентов 🎉');
    await ctx.reply('📂 Ваши клиенты в работе:', {
      reply_markup: { inline_keyboard: rows.map(function(c) {
                return [{ text: c.org + ' · ' + (c.stage || 'Сбор документов') + ' · ' + c.done + '/' + c.total, web_app: { url: WEBAPP_URL + '/checklist?case_id=' + c.id } }];
      }) },
    });
  }

  return bot;
}

module.exports = { setupBot };
