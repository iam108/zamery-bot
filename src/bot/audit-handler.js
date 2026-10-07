const { getOrderById } = require('../db/queries');
const { saveAudit } = require('../web/handoff');

async function handleAuditReport(ctx, data) {
  const GROUP_ID = process.env.GROUP_CHAT_ID;
  const actor = ctx.from
    ? (ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name)
    : 'аудитор';

  var zonesText = 'Нет';
  if (data.zones && data.zones.length > 0) {
    zonesText = data.zones.map(function(z) {
      var line = '• ' + z.name;
      if (z.dist) line += ' — ' + z.dist + ' м';
      if (z.info) line += '\n  ' + z.info;
      return line;
    }).join('\n');
  }

  var y = '✅';
  var n = '—';
  var header = '🔍 *Отчёт аудитора*';
  if (data.order_id) header += ' по заявке *#' + data.order_id + '*';

  var lines = [header, ''];
  // Короткий текст для юриста (без Markdown)
  var plain = [];

  if (data.object_category === 'tobacco') {
    lines.push('🚬 *Тип: Табак*', '');
    lines.push('*Торговый объект:*');
    lines.push((data.chk_shop ? y : n) + ' Объект является магазином или павильоном');
    lines.push((data.chk_address ? y : n) + ' Объект соответствует заявленному адресу');
    lines.push((data.chk_area ? y : n) + ' Площадь не менее 5 м²');
    lines.push('');
    lines.push('*Торговый зал:*');
    lines.push((data.chk_no_display ? y : n) + ' Нет открытой выкладки табачной продукции');
    lines.push((data.chk_price_list ? y : n) + ' Есть перечень продукции с ценами');
    lines.push((data.chk_price_format ? y : n) + ' Перечень в установленном формате');
    lines.push((data.chk_no_ads ? y : n) + ' Нет рекламы и изображений продукции');
    lines.push((data.chk_on_demand ? y : n) + ' Демонстрация только по требованию покупателя');
    lines.push((data.chk_marking ? y : n) + ' Есть маркировка товара');
    lines.push((data.chk_cash ? y : n) + ' Есть установленная касса');
    lines.push('');
    lines.push('*Ассортимент:*');
    lines.push((data.chk_no_single ? y : n) + ' Нет поштучной продажи сигарет');
    lines.push((data.chk_no_unpack ? y : n) + ' Нет продукции без потребительской упаковки');
    lines.push((data.chk_no_banned ? y : n) + ' Нет насвая, снюса и запрещённой продукции');
    lines.push((data.chk_no_chew ? y : n) + ' Нет запрещённой никотинсодержащей продукции для жевания/нюханья');
    lines.push((data.chk_nicotine_limit ? y : n) + ' Никотинсодержащие жидкости в пределах нормы');
  } else {
    lines.push('🏢 *Здание:* ' + (data.building_type || '—'));
    lines.push('📐 *Границы:* ' + (data.boundaries || '—'));
    lines.push('📋 *БТИ:* ' + (data.bti === 'Да' ? y + ' Подходит' : '❌ Не подходит'));
    lines.push('🔧 *ТО:* ' + (data.to || '—'));
    lines.push('');
    lines.push('*Планировка и границы:*');
    lines.push((data.chk_bti_match ? y : n) + ' Фактическая планировка соответствует БТИ');
    lines.push((data.chk_hall ? y : n) + ' Торговый зал / зал обслуживания определён');
    lines.push((data.chk_storage ? y : n) + ' Подсобные и складские помещения определены');
    lines.push((data.chk_no_replan ? y : n) + ' Нет самовольных перепланировок');
    lines.push((data.chk_clear_borders ? y : n) + ' Границы объекта однозначно определимы');
    lines.push((data.chk_cadastr ? y : n) + ' Кадастровый номер не разделён (объект единый)');
    plain.push('Здание: ' + (data.building_type || '—') + ', границы: ' + (data.boundaries || '—') +
      ', БТИ: ' + (data.bti || '—') + ', ТО: ' + (data.to || '—'));
  }

  lines.push('');
  lines.push('🚫 *Зоны:*');
  lines.push(zonesText);
  plain.push('Зоны: ' + zonesText);

  if (data.nearby) { lines.push(''); lines.push('👁 *На заметку:* ' + data.nearby); plain.push('На заметку: ' + data.nearby); }

  var extras = [];
  if (data.veranda) extras.push('🏗 Веранда');
  if (data.patz) extras.push('📄 ПАТЗ');
  if (data.replan) extras.push('🔨 Перепланировка');
  if (data.passport_interest) extras.push('🛡 Интерес к паспорту безопасности');
  if (data.is_owner) extras.push('🔑 Собственник');
  if (extras.length > 0) {
    lines.push('');
    lines.push('*Доп. характеристики:*');
    extras.forEach(function(e) { lines.push('✅ ' + e); });
    plain.push('Доп.: ' + extras.join(', '));
  }

  if (data.video_url) { lines.push(''); lines.push('🎥 *Видео:* ' + data.video_url); plain.push('Видео: ' + data.video_url); }

  lines.push('');
  lines.push('📝 *Итог:* ' + data.conclusion);
  lines.push('');
  lines.push('👤 _Аудитор: ' + actor + '_');
  plain.push('Итог: ' + data.conclusion);

  var text = lines.join('\n');

  var replyToMsgId = null;
  if (data.order_id) {
    try {
      const order = await getOrderById(data.order_id);
      if (order && order.telegram_msg_id) replyToMsgId = order.telegram_msg_id;
    } catch(e) {
      console.error('getOrderById error:', e.message);
    }
  }

  var tg = ctx.telegram;
  var sentIds = [];

  if (data.photos && data.photos.length > 0) {
    try {
      var media = data.photos.map(function(p, i) {
        return {
          type: 'photo',
          media: { source: Buffer.from(p.data, 'base64') },
          caption: i === 0 ? text : undefined,
          parse_mode: i === 0 ? 'Markdown' : undefined,
        };
      });
      var msgs = await tg.sendMediaGroup(GROUP_ID, media, replyToMsgId ? { reply_to_message_id: replyToMsgId } : {});
      msgs.forEach(function(m) { sentIds.push(m.message_id); });
    } catch (e) {
      console.error('media group error:', e.message);
      var m1 = await tg.sendMessage(GROUP_ID, text, { parse_mode: 'Markdown', reply_to_message_id: replyToMsgId || undefined });
      sentIds.push(m1.message_id);
    }
  } else {
    var m2 = await tg.sendMessage(GROUP_ID, text, { parse_mode: 'Markdown', reply_to_message_id: replyToMsgId || undefined });
    sentIds.push(m2.message_id);
  }

  // Сохраняем отчёт: текст + ID сообщений с файлами (файлы остаются в Telegram)
  try {
    await saveAudit(data.order_id ? parseInt(data.order_id) : null, plain.join('\n'), GROUP_ID, sentIds);
  } catch (e) {
    console.error('saveAudit error:', e.message);
  }

  // Кнопка передачи юристу
  if (data.order_id) {
    await tg.sendMessage(GROUP_ID, '⚖️ Заявка #' + data.order_id + ' готова к передаче юристу', {
      reply_to_message_id: sentIds[0],
      reply_markup: { inline_keyboard: [[{ text: '⚖️ Передать юристу', callback_data: 'handoff:' + data.order_id }]] },
    });
  }

  if (ctx.reply) await ctx.reply('✅ Отчёт отправлен в группу!');
}

module.exports = { handleAuditReport };
