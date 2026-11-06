const { Telegraf, Markup } = require('telegraf');
const { updateOrderStatus, getOrderById, getStats } = require('../db/queries');
const { formatOrderMessage, STATUS_EMOJI } = require('./formatter');
const { cardOptions } = require('../web/manager-orders');
const { loadOrderReportLink } = require('../web/order-report-link');
const { withOrderDeliveryLock } = require('../db/order-delivery-lock');
const { approvalKeyboard, createStaffApprovalHandler } = require('./staff-approval');

function setupBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);
  const GROUP_ID = process.env.GROUP_CHAT_ID;
  const WEBAPP_URL = process.env.WEBAPP_URL;
  require('../web/handoff').setupReportsBot(bot);
  require('./egrn').setupEgrn(bot);
  const pool = require('../db/pool');
  require('./report-link-admin').setupReportLinkAdmin(bot, { pool });
  require('./order-delivery-admin').setupOrderDeliveryAdmin(bot, { pool });
  require('./handoff-status-admin').setupHandoffStatusAdmin(bot, { pool });
  require('./handoff-notice-admin').setupHandoffNoticeAdmin(bot, { pool });
  const auth = require('../web/auth');
  const { ensureStaff, canManageCases } = auth;
  const openCase = require('./case-open').setupCaseOpen(bot, { pool, auth, webappUrl: WEBAPP_URL });
  const { parsePairing, approvePairing, canPair } = require('../web/workspace');
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

  async function approvedActor(ctx, manageOnly = false) {
    let staff;
    try { staff = await getMe(ctx.from.id); }
    catch (error) {
      console.error('Telegram staff lookup failed:', error.code || error.name || 'error');
      const text = 'Не удалось проверить доступ. Повторите действие.';
      if (ctx.callbackQuery) await ctx.answerCbQuery(text, { show_alert: true });
      else await ctx.reply(text);
      return null;
    }
    if (!staff || staff.approved !== true || manageOnly && !canManageCases(staff, ctx.from.id)) {
      const text = manageOnly ? 'Действие доступно менеджеру.' : 'Нет доступа. Нажмите /start и дождитесь одобрения.';
      if (ctx.callbackQuery) await ctx.answerCbQuery(text, { show_alert: true });
      else await ctx.reply(text);
      return null;
    }
    return staff;
  }

  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (String(ctx.startPayload || '').startsWith('case_')) return openCase(ctx, String(ctx.startPayload).slice(5));
    const me = await getMe(ctx.from.id);
    if (String(ctx.startPayload || '').startsWith('mac_')) {
      if (!canPair(me)) return ctx.reply('Подключение Мака доступно одобренным юристам и менеджерам.');
      if (!parsePairing(ctx.startPayload)) return ctx.reply('Ссылка истекла. Откройте новую ссылку из приложения на Маке.');
      return ctx.reply('Подключить «Рабочий стол ЛРС» к вашему аккаунту? Подтвердите, если вы сами открыли ссылку из приложения на Маке.',
        Markup.inlineKeyboard([[Markup.button.callback('Подключить Мак', ctx.startPayload)]]));
    }
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

  bot.action(/^mac_[A-Za-z0-9_-]{43}_[0-9a-z]{1,8}$/, async ctx => {
    if (ctx.chat.type !== 'private') return ctx.answerCbQuery('Откройте личный чат с ботом.');
    if (!await approvePairing(pool, ctx.from.id, ctx.callbackQuery.data)) {
      return ctx.answerCbQuery('Ссылка уже использована, истекла или подключение недоступно.', { show_alert: true });
    }
    await ctx.answerCbQuery('Мак подключён.');
    await ctx.editMessageText('Мак подключён. Вернитесь в «Рабочий стол ЛРС».');
  });

  bot.action(/^role:(manager|lawyer|auditor)$/, async (ctx) => {
    const role = ctx.match[1];
    const uid = String(ctx.from.id);
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Без имени';
    const me = await getMe(ctx.from.id);
    const list = await approvers();
    const isAdmin = adminIds().indexOf(uid) !== -1;
    // Only a configured administrator may bootstrap staff approval.
    if (isAdmin) {
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
    const kb = approvalKeyboard(uid, role);
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

  bot.action(/^(ap|rj):(\d+)(?::(manager|lawyer|auditor))?$/, createStaffApprovalHandler({ pool, approvers, adminIds }));

  bot.command('role', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    await ctx.reply('Сменить роль (нужно одобрение администратора):', roleKb());
  });

  bot.command('stats', async (ctx) => {
    try {
      if (!await approvedActor(ctx)) return;
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
    if (!await approvedActor(ctx, true)) return;
    await ctx.reply(
      '🖥 Веб-панель для просмотра всех заявок:',
      Markup.inlineKeyboard([
        Markup.button.url('Открыть панель', WEBAPP_URL + '/admin'),
      ])
    );
  });

  bot.on('web_app_data', async (ctx) => {
    if (ctx.chat.type !== 'private' || !await approvedActor(ctx)) return;
    // Current forms use HTTP saves. Delayed sendData events from old pages
    // must not create another order or bypass the frozen report workflow.
    await ctx.reply('Эта версия формы устарела. Откройте /start и отправьте заявку или отчёт через новые кнопки.');
  });

  // Кнопка "Написать отчёт" — отправляем ссылку в личку аудитору
  bot.action(/^report:(\d+)$/, async (ctx) => {
    if (!await approvedActor(ctx)) return;
    const orderId = ctx.match[1];
    const userId = ctx.from.id;
    const auditUrl = WEBAPP_URL + '/audit?order_id=' + orderId + '&' + require('../web/auth').keyQuery(userId);

    try {
      await ctx.telegram.sendMessage(userId,
        '🔍 Проверка по заявке #' + orderId + ': созвон, выезд, входы, зоны, помещение и план. Черновик можно продолжить после выезда.',
        Markup.inlineKeyboard([
          Markup.button.webApp('🔍 Открыть проверку', auditUrl),
        ])
      );
      await ctx.answerCbQuery('Ссылка отправлена в личку 👆');
    } catch (e) {
      await ctx.answerCbQuery('Напиши боту в личку сначала — нажми /start');
    }
  });

  async function refreshOrderCard(ctx, order) {
    try {
      const report = await loadOrderReportLink(order.id, { pool });
      await ctx.editMessageText(formatOrderMessage(order), cardOptions(order, report?.url));
    }
    catch (error) {
      if (!/message is not modified/i.test(error.response?.description || error.message || '')) throw error;
    }
  }

  bot.action(/^status:(new|in_progress|done|cancelled):(\d+)$/, async (ctx) => {
    if (!await approvedActor(ctx)) return;
    if (String(ctx.chat.id) !== String(GROUP_ID)) return ctx.answerCbQuery('Откройте исходную заявку в рабочем чате.', { show_alert: true });
    const newStatus = ctx.match[1];
    const orderId = ctx.match[2];
    const actor = ctx.from.username ? '@' + ctx.from.username : [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || String(ctx.from.id);

    try {
      await withOrderDeliveryLock(Number(orderId), async () => {
      if (!await approvedActor(ctx)) return;
      const current = await getOrderById(Number(orderId));
      if (!current) return ctx.answerCbQuery('Заявка не найдена');
      if (current.status === newStatus) {
        await refreshOrderCard(ctx, current);
        return ctx.answerCbQuery('Этот статус уже установлен.');
      }
      const allowed = newStatus === 'in_progress' ? ['new'] : newStatus === 'new' ? [] : ['new', 'in_progress'];
      if (!allowed.includes(current.status)) {
        await refreshOrderCard(ctx, current);
        return ctx.answerCbQuery('Карточка обновлена. Статус уже изменился.', { show_alert: true });
      }
      const order = await updateOrderStatus(Number(orderId), newStatus, actor, allowed, ctx.from.id);
      if (!order) { if (!await approvedActor(ctx)) return; return ctx.answerCbQuery('Статус заявки уже изменился. Обновите карточку.'); }

      await refreshOrderCard(ctx, order);

      if (newStatus === 'in_progress') {
        const auditUrl = WEBAPP_URL + '/audit?order_id=' + orderId + '&' + require('../web/auth').keyQuery(ctx.from.id);
        await ctx.telegram.sendMessage(ctx.from.id,
          '🔍 Заявка #' + orderId + ' в работе. Начните с контакта и согласования выезда; затем форма проведёт по входам, окружению, помещению и графике.',
          Markup.inlineKeyboard([Markup.button.webApp('Начать проверку по шагам', auditUrl)])
        ).catch(e => console.error('audit workflow link:', e.message));
      }

      const labels = { in_progress: 'взял в работу', done: 'закрыл', cancelled: 'отменил' };
      await ctx.answerCbQuery(STATUS_EMOJI[newStatus] + ' ' + (ctx.from.username ? '@' + ctx.from.username : (ctx.from.first_name || '')) + ' ' + (labels[newStatus] || newStatus));
      });

    } catch (err) {
      console.error('callback error:', err);
      await ctx.answerCbQuery(err.code === 'ORDER_DELIVERY_BUSY' ? 'Заявка сейчас обновляется. Дождитесь результата и нажмите кнопку ещё раз.' : 'Ошибка, попробуйте ещё раз');
    }
  });
  require('./manual-order-attachments').setupManualOrderAttachments(bot, { pool, getMe, groupId: GROUP_ID });
    // Кнопка «Передать юристу» в группе замеров → ссылка на форму в личку
  bot.action(/^handoff:(\d+)$/, async (ctx) => {
    if (!await approvedActor(ctx, true)) return;
    const orderId = ctx.match[1];
    try {
      await ctx.telegram.sendMessage(ctx.from.id, '⚖️ Передать заявку #' + orderId + ' юристу:', {
        reply_markup: { inline_keyboard: [[{ text: '📝 Открыть форму', web_app: { url: WEBAPP_URL + '/handoff?order_id=' + orderId + '&' + require('../web/auth').keyQuery(ctx.from.id) } }]] },
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
    if (ctx.chat.type !== 'private') return;
    const me = await getMe(ctx.from.id);
    if (!me || me.approved !== true || me.role !== 'lawyer' && !canManageCases(me, ctx.from.id)) return ctx.reply('Нет доступа. Нажмите /start.');
    const { rows } = await pool.query(
      "SELECT id, org, checklist_key, service, data, data->>'_stage' AS stage FROM cases WHERE lawyer_tg_id=$1 AND COALESCE(data->>'_stage', '') <> 'Архив' ORDER BY created_at DESC LIMIT 30",
      [ctx.from.id]
    );
    if (!rows.length) return ctx.reply('У вас нет открытых клиентов 🎉');
    await ctx.reply('📂 Ваши клиенты в работе:', {
      reply_markup: { inline_keyboard: rows.map(function(c) {
        const counts = require('../web/handoff').checklistCounts(c, c.data || {});
        const progress = counts ? counts.done + '/' + counts.total : 'Чек-лист не выбран';
        return [{ text: c.org + ' · ' + (c.stage || 'Сбор документов') + ' · ' + progress, web_app: { url: WEBAPP_URL + '/checklist?case_id=' + c.id + '&' + require('../web/auth').keyQuery(ctx.from.id) } }];
      }) },
    });
  }

  bot.catch(error => {
    console.error('Telegram update failed:', error.code || error.response?.error_code || error.name || 'error');
  });
  return bot;
}

module.exports = { setupBot };
