const { getOrderById } = require('../db/queries');
const { saveAudit } = require('../web/handoff');
const { esc } = require('./formatter');

// Отчёты, которые уже обрабатываются или отправлены (защита от дубля при повторной отправке)
const seenSubmits = new Map();

// Telegram иногда просит подождать (429 Too Many Requests) — ждём указанное время и повторяем
async function tgRetry(fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fn(); }
    catch (e) {
      const wait = e && e.response && e.response.parameters && e.response.parameters.retry_after;
      if (!wait || attempt === 3) throw e;
      console.log('Telegram просит подождать ' + wait + ' с');
      await new Promise(function (r) { setTimeout(r, (wait + 1) * 1000); });
    }
  }
}

async function handleAuditReport(ctx, data) {
  const GROUP_ID = process.env.GROUP_CHAT_ID;
  if (data.submit_id) {
    const prev = seenSubmits.get(data.submit_id);
    if (prev) return prev; // этот же отчёт уже отправлен или отправляется — ждём результат, второй раз не шлём
    const job = handleAuditReportInner(ctx, data);
    seenSubmits.set(data.submit_id, job);
    job.catch(function () { seenSubmits.delete(data.submit_id); });
    setTimeout(function () { seenSubmits.delete(data.submit_id); }, 30 * 60 * 1000);
    return job;
  }
  return handleAuditReportInner(ctx, data);
}

async function handleAuditReportInner(ctx, data) {
  const GROUP_ID = process.env.GROUP_CHAT_ID;
  const actor = ctx.from
    ? (ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name)
    : 'аудитор';

  var zonesText = 'Нет';
  var zonesPlain = 'Нет';
  if (data.zones && data.zones.length > 0) {
    zonesPlain = data.zones.map(function (z) { return '• ' + z.name + (z.dist ? ' — ' + z.dist + ' м' : '') + (z.info ? ' (' + z.info + ')' : ''); }).join('\n');
  }
  if (data.zones && data.zones.length > 0) {
    zonesText = data.zones.map(function(z) {
      var line = '• ' + esc(z.name);
      if (z.dist) line += ' — ' + esc(z.dist) + ' м';
      if (z.info) line += '\n  ' + esc(z.info);
      return line;
    }).join('\n');
  }

  var y = '✅';
  var n = '—';
  var header = '🔍 <b>Отчёт аудитора</b>';
  if (data.order_id) header += ' по заявке <b>#' + esc(data.order_id) + '</b>';

  var lines = [header, ''];
  // Короткий текст для юриста (без Markdown)
  var plain = [];

  if (data.object_category === 'tobacco') {
    lines.push('🚬 <b>Табак</b>' + (data.t_address ? ' · ' + esc(data.t_address) : ''), '');
    lines.push('<b>1. Торговый зал</b>');
    lines.push((data.chk_t_no_display ? y : n) + ' Нет выкладки и демонстрации табачной продукции');
    lines.push((data.chk_t_price_place ? y : n) + ' Есть место для перечня табачной продукции с ценами');
    lines.push((data.chk_t_photo_hall ? y : n) + ' Фото торгового зала и входа');
    lines.push((data.chk_t_photo_shelves ? y : n) + ' Фото стеллажей, ценников, перечней и рекламы');
    lines.push('');
    lines.push('<b>2. Зоны запрета</b>');
    lines.push((data.chk_t_edu_checked ? y : n) + ' Проверено наличие образовательных организаций');
    lines.push((data.chk_t_edu_measured ? y : n) + ' Измерено расстояние по кратчайшему пешеходному маршруту');
    lines.push((data.chk_t_edu_photo ? y : n) + ' Фото входа в образовательную организацию');
    if (data.t_edu_name || data.t_edu_dist) {
      lines.push('🏫 ' + esc(data.t_edu_name || 'Образовательная организация') + (data.t_edu_dist ? ' — <b>' + esc(data.t_edu_dist) + ' м</b>' : ''));
    }
    plain.push('Табак' + (data.t_address ? ', ' + data.t_address : '') +
      (data.t_edu_name || data.t_edu_dist ? '. Образовательная организация: ' + (data.t_edu_name || '—') + (data.t_edu_dist ? ', ' + data.t_edu_dist + ' м' : '') : '. Образовательных организаций не отмечено'));
  } else {
    lines.push('🏢 <b>Здание:</b> ' + esc(data.building_type || '—'));
    lines.push('📐 <b>Границы:</b> ' + esc(data.boundaries || '—'));
    lines.push('📋 <b>БТИ:</b> ' + (data.bti === 'Да' ? y + ' Подходит' : '❌ Не подходит'));
    lines.push('🔧 <b>ТО:</b> ' + esc(data.to || '—'));
    lines.push('');
    lines.push('<b>Планировка и границы:</b>');
    lines.push((data.chk_bti_match ? y : n) + ' Фактическая планировка соответствует БТИ');
    lines.push((data.chk_hall ? y : n) + ' Торговый зал / зал обслуживания определён');
    lines.push((data.chk_storage ? y : n) + ' Подсобные и складские помещения определены');
    lines.push((data.chk_no_replan ? y : n) + ' Нет самовольных перепланировок');
    lines.push((data.chk_clear_borders ? y : n) + ' Границы объекта однозначно определимы');
    lines.push((data.chk_cadastr ? y : n) + ' Кадастровый номер не разделён (объект единый)');
    plain.push('Здание: ' + (data.building_type || '—') + ', границы: ' + (data.boundaries || '—') +
      ', БТИ: ' + (data.bti || '—') + ', ТО: ' + (data.to || '—'));
  }

  if (data.object_category !== 'tobacco') {
  lines.push('');
  lines.push('🚫 <b>Зоны:</b>');
  lines.push(zonesText);
  plain.push('Зоны: ' + zonesPlain);
  }

  if (data.nearby) { lines.push(''); lines.push('👁 <b>На заметку:</b> ' + esc(data.nearby)); plain.push('На заметку: ' + data.nearby); }

  var extras = [];
  if (data.veranda) extras.push('🏗 Веранда');
  if (data.patz) extras.push('📄 ПАТЗ');
  if (data.replan) extras.push('🔨 Перепланировка');
  if (data.passport_interest) extras.push('🛡 Интерес к паспорту безопасности');
  if (data.is_owner) extras.push('🔑 Собственник');
  if (extras.length > 0) {
    lines.push('');
    lines.push('<b>Доп. характеристики:</b>');
    extras.forEach(function(e) { lines.push('✅ ' + e); });
    plain.push('Доп.: ' + extras.join(', '));
  }

  if (data.video_url) { lines.push(''); lines.push('🎥 <b>Видео:</b> ' + esc(data.video_url)); plain.push('Видео: ' + data.video_url); }

  lines.push('');
  lines.push((data.object_category === 'tobacco' ? '📝 <b>3. Итог:</b> ' : '📝 <b>Итог:</b> ') + esc(data.conclusion));
  if (data.t_comment) { lines.push('💬 <b>Комментарий:</b> ' + esc(data.t_comment)); plain.push('Комментарий: ' + data.t_comment); }
  lines.push('');
  lines.push('👤 <i>Аудитор: ' + esc(actor) + '</i>');
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
          parse_mode: i === 0 ? 'HTML' : undefined,
        };
      });
      var msgs = await tgRetry(function () { return tg.sendMediaGroup(GROUP_ID, media, replyToMsgId ? { reply_to_message_id: replyToMsgId } : {}); });
      msgs.forEach(function(m) { sentIds.push(m.message_id); });
    } catch (e) {
      console.error('media group error:', e.message);
      var m1 = await tgRetry(function () { return tg.sendMessage(GROUP_ID, text, { parse_mode: 'HTML', reply_to_message_id: replyToMsgId || undefined }); });
      sentIds.push(m1.message_id);
    }
  } else {
    var m2 = await tgRetry(function () { return tg.sendMessage(GROUP_ID, text, { parse_mode: 'HTML', reply_to_message_id: replyToMsgId || undefined }); });
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
    await tgRetry(function () { return tg.sendMessage(GROUP_ID, '⚖️ Заявка #' + data.order_id + ' готова к передаче юристу', {
      reply_to_message_id: sentIds[0],
      reply_markup: { inline_keyboard: [[{ text: '⚖️ Передать юристу', callback_data: 'handoff:' + data.order_id }]] },
    }); });
  }

  if (ctx.reply) await ctx.reply('✅ Отчёт отправлен в группу!');
}

module.exports = { handleAuditReport };
