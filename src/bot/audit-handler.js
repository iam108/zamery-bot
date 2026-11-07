const { getOrderById } = require('../db/queries');
const { saveAudit } = require('../web/handoff');
const { esc } = require('./formatter');
const { buildInspectionReport, validateInspection } = require('./audit-inspection');
const { splitTelegramHtml, photoCaption, deliveryMedia, presentationMedia } = require('./audit-delivery');
const { createHash, randomUUID } = require('crypto');
const { normalizeWorkflow, validateWorkflow, buildWorkflowReport } = require('./audit-workflow');
const { syncOrderReportLink, telegramMessageUrl } = require('../web/order-report-link');

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
      // Only Telegram's explicit rate-limit refusal proves that no message
      // was accepted. A retry hint on a 5xx/network error is still an unknown
      // acknowledgement, and a long wait belongs to a deliberate later retry.
      if (e?.response?.error_code !== 429 || !Number.isSafeInteger(wait) || wait < 1 || wait > 30 || attempt === 3) throw e;
      console.log('Telegram просит подождать ' + wait + ' с');
      await new Promise(function (r) { setTimeout(r, (wait + 1) * 1000); });
    }
  }
}

async function handleAuditReport(ctx, data) {
  data = normalizeWorkflow(data);
  validateInspection(data);
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
  if (!progress?.job && ctx.auditDelivery) {
    const stored = await ctx.auditDelivery.load();
    // A receipt checkpoint or an explicit retry may have committed despite a
    // lost response. Between jobs the durable row, not this process's cache,
    // determines which physical requests may run.
    progress = stored && stored.signature ? { ...stored, job: null } : null;
  }
  if (progress && progress.signature !== signature) {
    // Existing checkpoints used insertion-ordered JSON. Accept them only
    // when that exact old serialization still matches; then checkpoint the
    // canonical signature. Never bypass the unchanged-payload check.
    const legacySignature = createHash('sha256').update(JSON.stringify(digestData)).digest('hex');
    if (progress.signature !== legacySignature) throw new Error('Этот отчёт уже начал отправляться. Повторите без изменений или откройте новую форму для нового отчёта.');
    progress.signature = signature;
  }
  // Only an exactly matched former checkpoint may retain its validation
  // contract. Request fields cannot enable this path for a fresh report.
  const legacyDelivery = !!progress && progress.signature === signature && (progress.deliveryVersion == null || [1, 2].includes(progress.deliveryVersion));
  validateWorkflow(data, { legacyDelivery });
  if (!progress) {
    progress = { signature, ...(data.ui_version === 5 ? { deliveryVersion: 3 } : {}), textIds: [], photoIds: [], documentIds: [], saved: false, handoffSent: false, orderCardLinked: false, replied: false, job: null };
  }
  if (progress.deliveryVersion != null && ![1, 2, 3].includes(progress.deliveryVersion)) throw new Error('Неизвестный формат доставки отчёта. Отправка остановлена, чтобы не потерять материалы.');
  if (key && !seenSubmits.has(key)) {
      seenSubmits.set(key, progress);
      const timer = setTimeout(function () { seenSubmits.delete(key); }, 30 * 60 * 1000);
      if (timer.unref) timer.unref();
  }
  if (key) seenSubmits.set(key, progress);
  progress.documentIds = progress.documentIds || [];
  if (progress.job) return progress.job;
  const job = handleAuditReportInner(ctx, data, progress, { legacyDelivery });
  progress.job = job;
  job.catch(function () { if (progress.job === job) progress.job = null; });
  return job;
}

async function handleAuditReportInner(ctx, data, progress, validationOptions) {
  validateInspection(data);
  function unknownDelivery() {
    const { id: cursor, stage, index, count } = progress.inflight || {};
    return Object.assign(new Error('Ответ Telegram на отправку части отчёта не подтверждён. Проверьте чат. Обычный повтор остановлен, чтобы не создать дубликаты. После проверки можно явно повторить неподтверждённую часть.'), {
      status: 409, code: 'AUDIT_DELIVERY_UNKNOWN', uncertain: true,
      ...(cursor ? { delivery_unknown: { cursor, stage, index, count } } : {}),
    });
  }
  function unconfirmedReceipt() {
    return Object.assign(new Error('Не удалось подтвердить номера отправленных сообщений отчёта. Отправка остановлена; проверьте чат перед повтором.'), { code: 'AUDIT_DELIVERY_RECEIPT', uncertain: true });
  }
  const confirmed = new Set();
  for (const field of ['textIds', 'photoIds', 'documentIds']) {
    if (!Array.isArray(progress[field])) throw unconfirmedReceipt();
    for (const id of progress[field]) {
      if (!Number.isSafeInteger(id) || id < 1 || confirmed.has(id)) throw unconfirmedReceipt();
      confirmed.add(id);
    }
  }
  function receiptIds(result, count = 1) {
    const messages = Array.isArray(result) ? result : [result], ids = messages.map(message => message?.message_id);
    const destination = String(process.env.GROUP_CHAT_ID || '');
    const wrongChat = messages.some(message => message?.chat != null && (destination.startsWith('@')
      ? String(message.chat.username || '').toLowerCase() !== destination.slice(1).toLowerCase()
      : String(message.chat.id) !== destination));
    if (wrongChat || ids.length !== count || ids.some(id => !Number.isSafeInteger(id) || id < 1 || confirmed.has(id)) || new Set(ids).size !== ids.length) throw unconfirmedReceipt();
    ids.forEach(id => confirmed.add(id)); return ids;
  }
  async function checkpoint() {
    if (ctx.auditDelivery) {
      const { signature, deliveryVersion, textIds, photoIds, documentIds, saved, handoffSent, orderCardLinked, orderCardLinkSkipped, replied, inflight, lastRiskRetryCursor } = progress;
      await ctx.auditDelivery.save({ signature, ...(deliveryVersion != null ? { deliveryVersion } : {}), textIds, photoIds, documentIds, saved, handoffSent, orderCardLinked, ...(orderCardLinkSkipped ? { orderCardLinkSkipped } : {}), replied, ...(inflight ? { inflight } : {}), ...(lastRiskRetryCursor ? { lastRiskRetryCursor } : {}) });
    }
  }
  if (progress.inflight) throw unknownDelivery();
  async function sendPart(stage, index, count, send, field) {
    if (progress.inflight) throw unknownDelivery();
    const intent = { id: randomUUID(), stage, index, count };
    progress.inflight = intent;
    // Never contact Telegram before this intent has been acknowledged by the
    // durable store. An uncertain SQL acknowledgement is conservative too.
    await checkpoint();
    let result;
    try { result = await tgRetry(send); }
    catch (error) {
      const code = Number(error.response?.error_code);
      if (code >= 400 && code < 500) {
        delete progress.inflight;
        try { await checkpoint(); }
        catch (_) { progress.inflight = intent; throw unknownDelivery(); }
        throw error;
      }
      throw unknownDelivery();
    }
    let ids;
    try { ids = receiptIds(result, count); }
    catch (_) { throw unknownDelivery(); }
    const previous = progress[field];
    if (Array.isArray(previous)) progress[field] = previous.concat(ids);
    else progress[field] = true;
    delete progress.inflight;
    try { await checkpoint(); }
    catch (_) {
      progress[field] = previous; progress.inflight = intent;
      ids.forEach(id => confirmed.delete(id));
      throw unknownDelivery();
    }
    return result;
  }
  const GROUP_ID = process.env.GROUP_CHAT_ID;
  const actor = ctx.from
    ? (ctx.from.username ? '@' + ctx.from.username : ctx.from.first_name)
    : 'аудитор';

  // Unversioned durable checkpoints must finish in the exact former order.
  // Persist the new order before Telegram can acknowledge its first message.
  const presentation = data.ui_version === 5 && [2, 3].includes(progress.deliveryVersion);
  const albumFirst = presentation && progress.deliveryVersion === 3;
  if (presentation) await checkpoint();

  var text;
  var plain;
  if (presentation) {
    const summaries = require('./audit-summary'), summary = summaries.buildAuditSummary(data, actor || 'аудитор');
    text = albumFirst ? summaries.buildAuditBrief(data, actor || 'аудитор').html : summary.html;
    plain = [summary.plain];
  } else {

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
  plain = [];
  var inspectionReport = buildInspectionReport(data);
  lines.push.apply(lines, inspectionReport.html);
  plain.push.apply(plain, inspectionReport.plain);
  const workflowReport = buildWorkflowReport(data, validationOptions);
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

  text = lines.join('\n');
  }

  var replyToMsgId = null;
  if (data.order_id) {
    try {
      const order = await getOrderById(data.order_id);
      if (order && order.telegram_msg_id) {
        const raw = order.telegram_msg_id, id = Number(raw);
        replyToMsgId = albumFirst ? (typeof raw === 'number' || typeof raw === 'string' && /^[1-9]\d*$/.test(raw)) && Number.isSafeInteger(id) && id > 0 ? id : null : raw;
      }
    } catch(e) {
      console.error('getOrderById error:', e.message);
    }
  }

  var tg = ctx.telegram;
  var textParts = splitTelegramHtml(text);
  if (progress.textIds.length > textParts.length) throw unconfirmedReceipt();
  async function sendSummary() {
    for (let i = progress.textIds.length; i < textParts.length; i++) {
      await sendPart('summary', i, 1, function () { return tg.sendMessage(GROUP_ID, textParts[i], {
        parse_mode: 'HTML', reply_to_message_id: replyToMsgId || (albumFirst ? progress.photoIds[0] : undefined), allow_sending_without_reply: true,
        ...(presentation ? { link_preview_options: { is_disabled: true } } : {}),
      }); }, 'textIds');
    }
  }
  if (!albumFirst) await sendSummary();

  const mediaPacket = presentation ? presentationMedia(data, { summaryText: plain.join('\n') }) : deliveryMedia(data);
  const photos = mediaPacket.photos;
  const reportNumber = String(data.order_id || 'аудит').replace(/[^a-zа-яё\d_-]/ig, '_').slice(0, 30);
  const documents = albumFirst ? [{ name: 'Отчёт-' + reportNumber + '-полный.txt', mime: 'text/plain', source: Buffer.from(plain.join('\n'), 'utf8'), caption: 'Полный отчёт аудитора' + (data.order_id ? ' · заявка #' + data.order_id : '') + '\nВсе записанные ответы и замечания.' }, ...mediaPacket.documents] : mediaPacket.documents;
  if (progress.photoIds.length > photos.length || progress.documentIds.length > documents.length) throw unconfirmedReceipt();
  function invalidPhoto(error) {
    return error.response?.error_code === 400 &&
      /PHOTO_INVALID|PHOTO_EXT_INVALID|IMAGE_PROCESS_FAILED|IMAGE_PROCESSING_FAILED/i.test(error.response.description || error.message || '');
  }
  function previewSource(photo) {
    return presentation && photo.source ? photo.source : Buffer.from(photo.data, 'base64');
  }
  async function sendPreview(photo) {
    const options = { caption: photoCaption(photo, data.order_id, presentation ? data : undefined),
      reply_to_message_id: albumFirst ? replyToMsgId || undefined : progress.textIds[0], allow_sending_without_reply: true };
    try { return await sendPart('photos', progress.photoIds.length, 1, () => tg.sendPhoto(GROUP_ID, { source: previewSource(photo) }, options), 'photoIds'); }
    catch (error) {
      if (!invalidPhoto(error)) throw error;
      return sendPart('photos', progress.photoIds.length, 1, () => tg.sendDocument(GROUP_ID,
        { source: previewSource(photo), filename: photo.name || 'Фото-выезда.jpg' }, options), 'photoIds');
    }
  }
  if (photos.length) {
    try {
      for (let offset = progress.photoIds.length; offset < photos.length;) {
        const batch = photos.slice(offset, offset + 10);
        if (batch.length === 1) {
          await sendPreview(batch[0]);
        } else {
          try {
            const media = batch.map(photo => ({ type: 'photo', media: { source: previewSource(photo) },
              caption: photoCaption(photo, data.order_id, presentation ? data : undefined) }));
            await sendPart('photos', offset, batch.length, () => tg.sendMediaGroup(GROUP_ID, media,
              { reply_to_message_id: albumFirst ? replyToMsgId || undefined : progress.textIds[0], allow_sending_without_reply: true }), 'photoIds');
          } catch (error) {
            if (!invalidPhoto(error)) throw error;
            // A rejected photo album has no receipts. Deliver each original
            // separately so a panorama cannot strand the whole report.
            for (const photo of batch) {
              await sendPreview(photo);
            }
          }
        }
        offset = progress.photoIds.length;
      }
    } catch (error) {
      console.error('audit photos:', error.code || error.response?.error_code || error.name || 'error');
      if (error.code === 'AUDIT_DELIVERY_RECEIPT' || error.code === 'AUDIT_DELIVERY_UNKNOWN') throw error;
      throw new Error(albumFirst ? 'Доставка фотографий не завершена. Повторите отправку без изменений — подтверждённые материалы сохраняются, итог ещё не отправлен.' : 'Текст отчёта отправлен, но доставка фотографий не подтверждена. Проверьте чат и повторите отправку — подтверждённый текст не продублируется.');
    }
  }

  if (albumFirst) await sendSummary();

  if (documents.length) {
    try {
      for (let offset = progress.documentIds.length; offset < documents.length;) {
        const batch = documents.slice(offset, offset + 10);
        const caption = file => {
          if (presentation) return file.caption;
          const subject = (data.entrances || []).find(e => e.id === file.subject_id)?.label || (data.zones || []).find(z => z.id === file.subject_id)?.name || '';
          return (photoCaption(file, data.order_id) + (subject ? ' · ' + subject : '') + '\n' + (file.name || 'Документ')).slice(0, 900);
        };
        if (batch.length === 1) {
          const file = batch[0];
          await sendPart('originals', offset, 1, () => tg.sendDocument(GROUP_ID, { source: file.source || Buffer.from(file.data, 'base64'), filename: file.name }, { caption: caption(file), reply_to_message_id: progress.textIds[0], allow_sending_without_reply: true }), 'documentIds');
        } else {
          const media = batch.map(file => ({ type: 'document', media: { source: file.source || Buffer.from(file.data, 'base64'), filename: file.name }, caption: caption(file) }));
          await sendPart('originals', offset, batch.length, () => tg.sendMediaGroup(GROUP_ID, media, { reply_to_message_id: progress.textIds[0], allow_sending_without_reply: true }), 'documentIds');
        }
        offset = progress.documentIds.length;
      }
    } catch (e) {
      console.error('audit originals:', e.message);
      if (e.code === 'AUDIT_DELIVERY_RECEIPT' || e.code === 'AUDIT_DELIVERY_UNKNOWN') throw e;
      throw new Error('Не удалось подтвердить доставку оригиналов отчёта. Проверьте чат и повторите отправку без изменений — подтверждённые пакеты сохраняются.');
    }
  }

  var sentIds = progress.textIds.concat(progress.photoIds, progress.documentIds);
  if (!progress.saved) {
    await saveAudit(data.order_id ? parseInt(data.order_id) : null, plain.join('\n'), GROUP_ID, sentIds, data);
    progress.saved = true;
    await checkpoint();
  }

  if (presentation && !progress.handoffSent) {
    const keyboard = [];
    const links = [];
    const video = Object.hasOwn(data.workflow || {}, 'video_url') ? data.workflow.video_url : data.video_url;
    if (video) links.push({ text: '▶ Видео на Диске', url: video });
    const fullReport = albumFirst && telegramMessageUrl(GROUP_ID, progress.documentIds[0]);
    if (fullReport) links.push({ text: '📄 Полный отчёт', url: fullReport });
    const originals = telegramMessageUrl(GROUP_ID, progress.documentIds[albumFirst ? 1 : 0]);
    if (originals) links.push({ text: '📎 Оригиналы', url: originals });
    if (links.length) keyboard.push(links);
    if (data.order_id) keyboard.push([{ text: '⚖️ Передать юристу', callback_data: 'handoff:' + data.order_id }]);
    if (keyboard.length) {
      try {
        await tgRetry(() => tg.editMessageReplyMarkup(GROUP_ID, progress.textIds[0], undefined, { inline_keyboard: keyboard }));
      } catch (e) {
        // Telegram may have applied the exact same keyboard before a lost
        // checkpoint. Only its explicit "not modified" response is success.
        if (!(e.response?.error_code === 400 && /message is not modified/i.test(e.response.description || ''))) throw e;
      }
    }
    progress.handoffSent = true;
    await checkpoint();
  } else if (data.order_id && !progress.handoffSent) {
    await sendPart('handoff', 0, 1, function () { return tg.sendMessage(GROUP_ID,
      '⚖️ Отчёт по заявке #' + data.order_id + ' добавлен — проверьте замечания перед передачей юристу', {
      reply_to_message_id: sentIds[0],
      reply_markup: { inline_keyboard: [[{ text: '⚖️ Передать юристу', callback_data: 'handoff:' + data.order_id }]] },
    }); }, 'handoffSent');
  }

  if (data.order_id && !progress.orderCardLinked && !progress.orderCardLinkSkipped) {
    try {
      const result = await tgRetry(() => syncOrderReportLink(data.order_id, { telegram: tg, groupId: GROUP_ID }));
      if (result.state === 'linked') progress.orderCardLinked = true;
      else if (result.state === 'skipped') progress.orderCardLinkSkipped = { code: result.code, warning: result.warning };
      else throw new Error('Не подтверждено обновление карточки заявки.');
      try { await checkpoint(); }
      catch (error) {
        // Markup is idempotent: retry its acknowledgement after a failed
        // checkpoint, while all confirmed report receipts remain untouched.
        progress.orderCardLinked = false; delete progress.orderCardLinkSkipped;
        throw error;
      }
    } catch (error) {
      throw Object.assign(new Error('Отчёт и материалы сохранены, но не удалось подтвердить кнопку «Перейти к отчёту» в заявке. Повторите отправку без изменений — отчёт не продублируется.'), { code: 'ORDER_CARD_LINK_RETRY' });
    }
  }

  const warning = progress.orderCardLinkSkipped?.warning;
  if (ctx.reply && !progress.replied) {
    const confirmation = presentation ? '✅ Отчёт и материалы отправлены в группу.' : '✅ Отчёт' + (photos.length ? ' и фото (' + photos.length + ')' : '') + ' отправлены в группу!';
    await ctx.reply(confirmation + (warning ? '\n' + warning : ''));
    progress.replied = true;
    await checkpoint();
  }

  return warning ? { warning } : {};
}

module.exports = { handleAuditReport };
