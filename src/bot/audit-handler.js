const { getOrderById } = require('../db/queries');
const { saveAudit } = require('../web/handoff');
const { esc } = require('./formatter');
const { buildInspectionReport, validateInspection } = require('./audit-inspection');
const { splitTelegramHtml, photoCaption, deliveryMedia } = require('./audit-delivery');
const { createHash } = require('crypto');
const { normalizeWorkflow, validateWorkflow, buildWorkflowReport } = require('./audit-workflow');

// Отчёты, которые уже обрабатываются или отправлены (защита от дубля при повторной отправке)
const seenSubmits = new Map();

// JSONB may return the same object with a different key order after a
// checkpoint. Sort object keys recursively while retaining array order and
// JSON.stringify's normal handling of dates, undefined and other JSON values.
function canonicalJson(value) {
  return JSON.stringify(value, (key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
  });
}

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
  data = normalizeWorkflow(data);
  validateInspection(data);
  validateWorkflow(data);
  const mediaLimit = data.schema_version === 3 ? 60 : 10;
  if (data.photos && (!Array.isArray(data.photos) || data.photos.length > mediaLimit ||
    data.photos.some(function (p) { return !p || typeof p.data !== 'string' || !p.data; }))) {
    throw new Error('Можно отправить до ' + mediaLimit + ' корректных фотографий');
  }
  if (data.documents && (!Array.isArray(data.documents) || data.documents.length > 60 || data.documents.some(p => !p || !(Buffer.isBuffer(p.source) && p.source.length || typeof p.data === 'string' && p.data) || !/^(image\/(jpeg|png|webp|gif|heic|heif|avif|tiff|bmp)|application\/pdf)$/.test(p.mime)))) throw new Error('Проверьте оригиналы приложенных документов.');
  const key = data.submit_id ? String(ctx.from && ctx.from.id || '') + ':' + data.submit_id : null;
  let progress = key && seenSubmits.get(key);
  // Keep only a digest, not full base64 images, during the retry window.
  const digestData = data.documents ? { ...data, documents: data.documents.map(({ source, data: binary, ...meta }) => ({ ...meta, contentHash: createHash('sha256').update(source || Buffer.from(binary, 'base64')).digest('hex') })) } : data;
  const signature = createHash('sha256').update(canonicalJson(digestData)).digest('hex');
  if (!progress && ctx.auditDelivery) {
    const stored = await ctx.auditDelivery.load();
    progress = key && seenSubmits.get(key) || (stored && stored.signature ? { ...stored, job: null } : null);
  }
  if (progress && progress.signature !== signature) {
    // Existing checkpoints used insertion-ordered JSON. Accept them only
    // when that exact old serialization still matches; then checkpoint the
    // canonical signature. Never bypass the unchanged-payload check.
    const legacySignature = createHash('sha256').update(JSON.stringify(digestData)).digest('hex');
    if (progress.signature !== legacySignature) throw new Error('Этот отчёт уже начал отправляться. Повторите без изменений или откройте новую форму для нового отчёта.');
    progress.signature = signature;
  }
  if (!progress) {
    progress = { signature, textIds: [], photoIds: [], documentIds: [], saved: false, handoffSent: false, replied: false, job: null };
  }
  if (key && !seenSubmits.has(key)) {
      seenSubmits.set(key, progress);
      const timer = setTimeout(function () { seenSubmits.delete(key); }, 30 * 60 * 1000);
      if (timer.unref) timer.unref();
  }
  progress.documentIds = progress.documentIds || [];
  if (progress.job) return progress.job;
  const job = handleAuditReportInner(ctx, data, progress);
  progress.job = job;
  job.catch(function () { if (progress.job === job) progress.job = null; });
  return job;
}

async function handleAuditReportInner(ctx, data, progress) {
  validateInspection(data);
  async function checkpoint() {
    if (ctx.auditDelivery) {
      const { signature, textIds, photoIds, documentIds, saved, handoffSent, replied } = progress;
      await ctx.auditDelivery.save({ signature, textIds, photoIds, documentIds, saved, handoffSent, replied });
    }
  }
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
  var inspectionReport = buildInspectionReport(data);
  lines.push.apply(lines, inspectionReport.html);
  plain.push.apply(plain, inspectionReport.plain);
  const workflowReport = buildWorkflowReport(data);
  lines.push.apply(lines, workflowReport.html);
  plain.push.apply(plain, workflowReport.plain);

  if (data.object_category === 'tobacco' && data.ui_version !== 5) {
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
  } else if (![4, 5].includes(data.ui_version)) {
    lines.push('🏢 <b>Здание:</b> ' + esc(data.building_type || '—'));
    lines.push('📐 <b>Границы:</b> ' + esc(data.boundaries || '—'));
    lines.push(data.schema_version === 3 ? '📋 <b>Сверка с представленным планом:</b> ' + esc(data.bti || 'Не проверено') : '📋 <b>БТИ:</b> ' + (data.bti === 'Да' ? y + ' Подходит' : data.bti === 'Нет' ? '❌ Не подходит' : '❓ Не проверено'));
    lines.push('🔧 <b>ТО:</b> ' + esc(data.to || '—'));
    lines.push('');
    if (data.schema_version !== 3) {
    lines.push('<b>Планировка и границы:</b>');
    lines.push((data.chk_bti_match ? y : n) + ' Фактическая планировка соответствует БТИ');
    lines.push((data.chk_hall ? y : n) + ' Торговый зал / зал обслуживания определён');
    lines.push((data.chk_storage ? y : n) + ' Подсобные и складские помещения определены');
    lines.push((data.chk_no_replan ? y : n) + ' Нет самовольных перепланировок');
    lines.push((data.chk_clear_borders ? y : n) + ' Границы объекта однозначно определимы');
    lines.push((data.chk_cadastr ? y : n) + ' Кадастровый номер не разделён (объект единый)');
    }
    plain.push('Здание: ' + (data.building_type || '—') + ', границы: ' + (data.boundaries || '—') +
      ', БТИ: ' + (data.bti || '—') + ', ТО: ' + (data.to || '—'));
  }

  if (data.object_category !== 'tobacco' && !inspectionReport.html.length) {
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

  if (data.video_url && data.ui_version !== 5) { lines.push(''); lines.push('🎥 <b>Видео:</b> ' + esc(data.video_url)); plain.push('Видео: ' + data.video_url); }

  lines.push('');
  if (data.ui_version !== 5) lines.push((data.object_category === 'tobacco' ? '📝 <b>3. Итог:</b> ' : '📝 <b>Итог:</b> ') + esc(data.conclusion));
  if (data.t_comment) { lines.push('💬 <b>Комментарий:</b> ' + esc(data.t_comment)); plain.push('Комментарий: ' + data.t_comment); }
  lines.push('');
  lines.push('👤 <i>Аудитор: ' + esc(actor) + '</i>');
  if (data.ui_version !== 5) plain.push('Итог: ' + data.conclusion);

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
  var textParts = splitTelegramHtml(text);
  for (let i = progress.textIds.length; i < textParts.length; i++) {
    const m = await tgRetry(function () { return tg.sendMessage(GROUP_ID, textParts[i], {
      parse_mode: 'HTML', reply_to_message_id: replyToMsgId || undefined,
    }); });
    progress.textIds.push(m.message_id);
    await checkpoint();
  }

  const mediaPacket = deliveryMedia(data);
  const photos = mediaPacket.photos;
  const documents = mediaPacket.documents;
  if (photos.length) {
    try {
      for (let offset = progress.photoIds.length; offset < photos.length;) {
        const batch = photos.slice(offset, offset + 10);
      if (batch.length === 1) {
        const photo = batch[0];
        const m = await tgRetry(function () { return tg.sendPhoto(GROUP_ID,
          { source: Buffer.from(photo.data, 'base64') },
          { caption: photoCaption(photo, data.order_id), reply_to_message_id: progress.textIds[0] }); });
        progress.photoIds.push(m.message_id);
      } else {
        const media = batch.map(function (p) {
          return { type: 'photo', media: { source: Buffer.from(p.data, 'base64') }, caption: photoCaption(p, data.order_id) };
        });
        const msgs = await tgRetry(function () { return tg.sendMediaGroup(GROUP_ID, media, { reply_to_message_id: progress.textIds[0] }); });
        msgs.forEach(function (m) { progress.photoIds.push(m.message_id); });
      }
        offset = progress.photoIds.length;
        await checkpoint();
      }
    } catch (e) {
      console.error('audit photos:', e.message);
      throw new Error('Текст отчёта отправлен, но фотографии не доставлены. Повторите отправку — уже отправленный текст не продублируется.');
    }
  }

  if (documents.length) {
    try {
      for (let offset = progress.documentIds.length; offset < documents.length;) {
        const batch = documents.slice(offset, offset + 10);
        const caption = file => {
          const subject = (data.entrances || []).find(e => e.id === file.subject_id)?.label || (data.zones || []).find(z => z.id === file.subject_id)?.name || '';
          return (photoCaption(file, data.order_id) + (subject ? ' · ' + subject : '') + '\n' + (file.name || 'Документ')).slice(0, 900);
        };
        if (batch.length === 1) {
          const file = batch[0];
          const m = await tgRetry(() => tg.sendDocument(GROUP_ID, { source: file.source || Buffer.from(file.data, 'base64'), filename: file.name }, { caption: caption(file), reply_to_message_id: progress.textIds[0] }));
          progress.documentIds.push(m.message_id);
        } else {
          const media = batch.map(file => ({ type: 'document', media: { source: file.source || Buffer.from(file.data, 'base64'), filename: file.name }, caption: caption(file) }));
          const msgs = await tgRetry(() => tg.sendMediaGroup(GROUP_ID, media, { reply_to_message_id: progress.textIds[0] }));
          msgs.forEach(m => progress.documentIds.push(m.message_id));
        }
        offset = progress.documentIds.length;
        await checkpoint();
      }
    } catch (e) {
      console.error('audit originals:', e.message);
      throw new Error('Отчёт отправлен частично: не все оригиналы доставлены. Повторите отправку без изменений — подтверждённые пакеты сохраняются.');
    }
  }

  var sentIds = progress.textIds.concat(progress.photoIds, progress.documentIds);
  if (!progress.saved) {
    await saveAudit(data.order_id ? parseInt(data.order_id) : null, plain.join('\n'), GROUP_ID, sentIds, data);
    progress.saved = true;
    await checkpoint();
  }

  if (data.order_id && !progress.handoffSent) {
    await tgRetry(function () { return tg.sendMessage(GROUP_ID,
      '⚖️ Отчёт по заявке #' + data.order_id + ' добавлен — проверьте замечания перед передачей юристу', {
      reply_to_message_id: sentIds[0],
      reply_markup: { inline_keyboard: [[{ text: '⚖️ Передать юристу', callback_data: 'handoff:' + data.order_id }]] },
    }); });
    progress.handoffSent = true;
    await checkpoint();
  }

  if (ctx.reply && !progress.replied) {
    await ctx.reply('✅ Отчёт' + (photos.length ? ' и фото (' + photos.length + ')' : '') + ' отправлены в группу!');
    progress.replied = true;
    await checkpoint();
  }

}

module.exports = { handleAuditReport };
