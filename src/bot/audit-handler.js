const { getOrderById } = require('../db/queries');

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

  var lines = [
    header,
    '',
    '🏢 *Здание:* ' + (data.building_type || '—'),
    '📐 *Границы:* ' + (data.boundaries || '—'),
    '📋 *БТИ:* ' + (data.bti === 'Да' ? y + ' Подходит' : '❌ Не подходит'),
    '🔧 *ТО:* ' + (data.to || '—'),
    '',
    '🚫 *Зоны:*',
    zonesText,
  ];

  if (data.nearby) {
    lines.push('');
    lines.push('👁 *На заметку:* ' + data.nearby);
  }

  lines.push('');
  lines.push('*Характеристики:*');
  lines.push((data.veranda ? y : n) + ' Веранда');
  lines.push((data.patz ? y : n) + ' ПАТЗ');
  lines.push((data.replan ? y : n) + ' Перепланировка');
  lines.push((data.passport_interest ? y : n) + ' Паспорт безопасности');
  lines.push((data.is_owner ? y : n) + ' Собственник');

  if (data.video_url) {
    lines.push('');
    lines.push('🎥 *Видео:* ' + data.video_url);
  }

  lines.push('');
  lines.push('📝 *Итог:* ' + data.conclusion);
  lines.push('');
  lines.push('👤 _Аудитор: ' + actor + '_');

  var text = lines.join('\n');

  // Ищем reply_to_message_id если есть order_id
  var replyToMsgId = null;
  if (data.order_id) {
    try {
      const order = await getOrderById(data.order_id);
      if (order && order.telegram_msg_id) {
        replyToMsgId = order.telegram_msg_id;
      }
    } catch(e) {
      console.error('getOrderById error:', e.message);
    }
  }

  var tg = ctx.telegram;

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
      await tg.sendMediaGroup(GROUP_ID, media, replyToMsgId ? { reply_to_message_id: replyToMsgId } : {});
    } catch (e) {
      console.error('media group error:', e.message);
      await tg.sendMessage(GROUP_ID, text, {
        parse_mode: 'Markdown',
        reply_to_message_id: replyToMsgId || undefined,
      });
    }
  } else {
    await tg.sendMessage(GROUP_ID, text, {
      parse_mode: 'Markdown',
      reply_to_message_id: replyToMsgId || undefined,
    });
  }

  if (ctx.reply) {
    await ctx.reply('✅ Отчёт отправлен в группу!');
  }

module.exports = { handleAuditReport };
