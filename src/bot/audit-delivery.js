// Telegram limits message text separately from media captions. Keep each HTML
// message conservatively below the text limit, balancing tags at each boundary.
function splitTelegramHtml(html, limit = 3500) {
  const tokens = String(html).match(/<\/?[a-zA-Z][^>]*>|&(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);|[^]/gu) || [];
  const chunks = [];
  let stack = [];
  let current = '';
  const close = tags => tags.slice().reverse().map(tag => '</' + tag.name + '>').join('');
  const open = tags => tags.map(tag => tag.source).join('');
  function flush() {
    if (!current) return;
    chunks.push(current + close(stack));
    current = open(stack);
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let nextStack = stack.slice();
    if (token.charAt(0) === '<') {
      const tag = token.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b/);
      const name = tag[2].toLowerCase();
      if (tag[1]) {
        if (!nextStack.length || nextStack[nextStack.length - 1].name !== name) throw new Error('Некорректная разметка отчёта');
        nextStack.pop();
      } else if (!/\/\s*>$/.test(token) && name !== 'br') nextStack.push({ name, source: token });
    }
    if (current.length + token.length + close(nextStack).length > limit) flush();
    if (current.length + token.length + close(nextStack).length > limit) throw new Error('Слишком длинный элемент разметки отчёта');
    current += token;
    stack = nextStack;
    // Prefer whole lines instead of splitting the next paragraph across messages.
    if (token === '\n' && i + 1 < tokens.length) {
      let nextLineLength = 0;
      for (let n = i + 1; n < tokens.length && tokens[n] !== '\n'; n++) nextLineLength += tokens[n].length;
      if (current.length + nextLineLength + close(stack).length > limit) flush();
    }
  }
  if (current && current !== open(stack)) chunks.push(current + close(stack));
  return chunks;
}

function photoCaption(photo, orderId, data) {
  if (data?.ui_version === 5) {
    const description = describeFile(photo, data);
    const lines = [description.title + (orderId ? ' · заявка #' + String(orderId).slice(0, 30) : '')];
    lines.push(...description.details);
    if (photo.presentation_count > 1) lines.push('Фото ' + photo.presentation_index + ' из ' + photo.presentation_count);
    return shortText(lines.join('\n'), 900);
  }
  const label = { plan: 'План с разметкой', 'plan-source': 'Оригинал плана', map: 'Карта и входы', photo: 'Фото объекта', entrance: 'Вход объекта', exterior: 'Фасад и адресная табличка', zone: 'Соседняя организация', interior: 'Внутри помещения', act: 'Акт выездной оценки', document: 'Документ объекта' }[photo.role] || 'Материалы объекта';
  const title = photo.role === 'plan' && photo.subject_id === 'source' ? 'Оригинал представленного плана' : label;
  return title + (orderId ? ' · отчёт по заявке #' + String(orderId).slice(0, 30) : ' · отчёт аудитора');
}

const MAX_ARCHIVE_BYTES = 45 * 1024 * 1024;
const MAX_ORIGINAL_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ROLE_TITLES = { map: 'Схема территории', plan: 'План с разметкой', entrance: 'Фото входа', zone: 'Фото проверенной организации', interior: 'Фото помещения', 'map-source': 'Исходный скриншот территории', 'plan-source': 'Исходный план', archive: 'Архивные материалы', egrn: 'Выписка ЕГРН', bti: 'План БТИ', lease: 'Договор аренды', document: 'Документ объекта', photo: 'Фото объекта', exterior: 'Фасад', act: 'Акт выездной оценки' };
const ROLE_ORDER = ['map', 'plan', 'entrance', 'zone', 'interior', 'map-source', 'plan-source', 'egrn', 'archive', 'bti', 'lease', 'document', 'photo', 'exterior', 'act'];
const ZONE_STATUS = { clear: 'Без замечаний', checked: 'Без замечаний', licensed: 'Есть сведения о лицензии', pending: 'Нужно уточнить', disputed: 'Спорный результат', confirmed: 'Отмечено ограничение', other: 'Наблюдение' };
function shortText(value, limit) {
  const text = String(value || ''); if (text.length <= limit) return text;
  let head = text.slice(0, limit - 1); if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head.trimEnd() + '…';
}
function oneLine(value) { return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim(); }
function markedSubject(file, data) {
  const entries = file.role === 'entrance' ? data.entrances || [] : file.role === 'zone' ? data.zones || [] : [];
  const entry = entries.find(item => String(item.id) === String(file.subject_id));
  const mark = entry && (data.map?.annotations || []).find(item => item.id === (entry.mark_id || entry.id));
  return { entry, mark, code: mark?.code || '' };
}
function entranceCode(id, data) {
  const entrance = (data.entrances || []).find(item => item.id === id);
  return (data.map?.annotations || []).find(item => item.tool === 'entrance' && item.id === (entrance?.mark_id || id))?.code || entrance?.label || 'входа';
}
function describeFile(file, data) {
  const { entry, mark, code } = markedSubject(file, data), details = [];
  let title = ROLE_TITLES[file.role] || 'Материал объекта';
  if (file.role === 'entrance') {
    let label = oneLine(entry?.label || mark?.label || 'Вход');
    if ((code || !data.workflow?.territory_result) && /^Вход\s*(?:№\s*)?\d+$/i.test(label)) label = 'Вход';
    title = [code, label].filter(Boolean).join(' · ');
    if (['Нет доступа', 'Не осмотрен'].includes(entry?.access)) details.push(entry.access);
  } else if (file.role === 'zone') {
    title = [code, oneLine(entry?.name || mark?.label || 'Проверенная организация')].filter(Boolean).join(' · ');
    if (ZONE_STATUS[entry?.status || mark?.status]) details.push(ZONE_STATUS[entry?.status || mark?.status]);
    const measurements = (data.map?.annotations || []).filter(item => ['route', 'straight'].includes(item.tool) && [entry?.id, entry?.mark_id].filter(Boolean).includes(item.toObjectId));
    measurements.forEach(item => { if (item.distance) details.push('От ' + entranceCode(item.fromEntranceId, data) + ': ' + item.distance + ' м · ' + (item.tool === 'straight' ? 'по прямой' : 'по пути замера')); });
    if (!measurements.length && entry?.dist) details.push((entry.entrance_id ? 'От ' + entranceCode(entry.entrance_id, data) + ': ' : 'Расстояние: ') + entry.dist + (entry.dist === 'Не проверено' ? '' : ' м'));
    if (entry?.status === 'licensed' && entry.source) details.push('Источник: ' + oneLine(entry.source));
    if (entry?.note || entry?.resolution) details.push(oneLine(entry.note || entry.resolution));
  } else if (file.role === 'plan') {
    const plan = file.subject_id === 'annotation' ? data.plan : (data.additional_plans || []).find(item => 'annotation-' + item.id === file.subject_id);
    title = 'План помещения' + (plan?.page ? ' · лист ' + plan.page : '');
    const floor = file.subject_id === 'annotation' ? data.inspection?.floor_plan : plan?.floor_plan;
    if (floor) details.push('Этаж на плане: ' + oneLine(floor));
  } else if (file.role === 'map') {
    title = 'Схема территории';
    const marks = (data.map?.annotations || []).filter(item => ['entrance', 'hazard'].includes(item.tool));
    if (marks.length) details.push(marks.map(item => {
      const linked = item.tool === 'entrance' ? (data.entrances || []).find(e => (e.mark_id || e.id) === item.id) : (data.zones || []).find(e => (e.mark_id || e.id) === item.id);
      let label = oneLine(linked?.name || linked?.label || item.label);
      if (item.tool === 'entrance' && /^Вход\s*(?:№\s*)?\d+$/i.test(label)) label = 'Вход';
      return [item.code, label].filter(Boolean).join(' — ');
    }).join('; '));
  }
  return { title, details, code };
}
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function compareCode(a, b) {
  const left = /^(\D+)(\d+)$/.exec(a), right = /^(\D+)(\d+)$/.exec(b);
  if (left && right && left[1] === right[1]) return Number(left[2]) - Number(right[2]);
  return compareText(a, b);
}
function originalName(value) { return String(value || 'Документ').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'Документ'; }
function archiveName(file, description) {
  const original = originalName(file.name), extension = /\.[a-z\d]{1,10}$/i.exec(original)?.[0] || '';
  const title = oneLine(description.title).replace(/[\\/]/g, '_');
  const name = title + ' — ' + original;
  if (name.length <= 180) return name;
  return shortText(name.slice(0, extension ? -extension.length : undefined), 180 - extension.length) + extension;
}
function publicAnswers(data) {
  const rootBlocked = new Set(['documents', 'photos', 'evidence', 'submit_id', 'draft_id']);
  const blocked = new Set(['buffer', 'content', 'base64', 'object_key', 'storage']);
  function clean(value, depth = 0) {
    if (depth > 40 || Buffer.isBuffer(value) || value instanceof Uint8Array) return undefined;
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1)).filter(item => item !== undefined);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !blocked.has(key) && !(depth === 0 && rootBlocked.has(key))).map(key => [key, clean(value[key], depth + 1)]).filter(([, item]) => item !== undefined));
    return value;
  }
  return clean(data);
}
function zipSize(entries) {
  return 22 + entries.reduce((size, file, index) => size + 76 + 2 * Buffer.byteLength(String(index + 1).padStart(2, '0') + '-' + originalName(file.name), 'utf8') + file.buffer.length, 0);
}

// This is intentionally separate from deliveryMedia: old partial deliveries
// must keep their original per-document cursors and original media ordering.
function presentationMedia(data, options = {}) {
  if (data.ui_version !== 5) return deliveryMedia(data);
  const { createHash } = require('node:crypto');
  const { zipParts } = require('../web/order-materials');
  const maximum = options.maxArchiveBytes === undefined ? MAX_ARCHIVE_BYTES : options.maxArchiveBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ARCHIVE_BYTES) throw new Error('Некорректный предельный размер архива отчёта.');
  const input = data.documents || [];
  if (!Array.isArray(input) || input.length > 60) throw new Error('В отчёте допускается до 60 оригиналов.');
  let totalBytes = 0;
  const files = input.map(file => {
    const buffer = Buffer.isBuffer(file.source) ? file.source : typeof file.data === 'string' ? Buffer.from(file.data, 'base64') : null;
    if (!buffer?.length || buffer.length > MAX_ORIGINAL_BYTES) throw new Error('Оригинал файла отчёта должен быть не больше 12 МБ.');
    totalBytes += buffer.length;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (file.sha256 && file.sha256 !== sha256) throw new Error('Оригинал файла отчёта изменился. Повторите открытие отчёта.');
    const description = describeFile(file, data);
    return { file, buffer, sha256, description, name: archiveName(file, description) };
  });
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Общий объём оригиналов отчёта не должен превышать 100 МБ.');
  const rank = file => { const index = ROLE_ORDER.indexOf(file.role); return index < 0 ? ROLE_ORDER.length : index; };
  const planRank = file => file.subject_id === 'annotation' ? 0 : (data.additional_plans || []).findIndex(plan => 'annotation-' + plan.id === file.subject_id) + 1 || (data.additional_plans || []).length + 1;
  files.sort((a, b) => rank(a.file) - rank(b.file) || (a.file.role === 'plan' ? planRank(a.file) - planRank(b.file) : 0) || compareCode(a.description.code, b.description.code) || compareText(originalName(a.file.name), originalName(b.file.name)) || compareText(a.sha256, b.sha256) || compareText(String(a.file.id || ''), String(b.file.id || '')));
  if (!files.length) return { photos: [], documents: [] };
  const summary = options.summaryText === undefined ? require('./audit-summary').buildAuditSummary(data).plain : String(options.summaryText);
  const answers = JSON.stringify(publicAnswers(data), null, 2);
  function entries(part, index, count) {
    const lines = ['ОТЧЁТ АУДИТОРА' + (data.order_id ? ' · заявка #' + data.order_id : ''), 'Часть ' + index + ' из ' + count, '', summary, '', 'ФАЙЛЫ ЭТОЙ ЧАСТИ', 'Оригинальные байты сохранены без изменения качества.'];
    part.forEach((item, i) => {
      lines.push('', String(i + 2).padStart(2, '0') + '-' + originalName(item.name), 'Исходное имя: ' + originalName(item.file.name), 'Назначение: ' + (ROLE_TITLES[item.file.role] || 'Материал объекта'), item.description.title, ...item.description.details, 'Размер: ' + item.buffer.length + ' байт', 'SHA-256: ' + item.sha256);
    });
    lines.push('', 'ПОЛНЫЕ ОТВЕТЫ И МЕТАДАННЫЕ ЗАЯВКИ', answers);
    return [{ name: 'Содержание отчёта.txt', buffer: Buffer.from(lines.join('\r\n') + '\r\n', 'utf8') }, ...part.map(item => ({ name: item.name, buffer: item.buffer }))];
  }
  function partition(count) {
    const result = []; let current = [];
    for (const file of files) {
      if (zipSize(entries(current.concat(file), result.length + 1, count)) > maximum) {
        if (!current.length) throw new Error('Один оригинал вместе с описанием не помещается в допустимый размер архива.');
        result.push(current); current = [];
      }
      current.push(file);
      if (zipSize(entries(current, result.length + 1, count)) > maximum) throw new Error('Один оригинал вместе с описанием не помещается в допустимый размер архива.');
    }
    if (current.length) result.push(current);
    return result;
  }
  // Account for the final part count in the actual UTF-8 manifest, including
  // the extra digit if a very small test limit creates ten or more parts.
  let groups = partition(1), estimate = 1;
  while (groups.length !== estimate) { estimate = groups.length; groups = partition(estimate); }
  const order = oneLine(data.order_id || 'аудит').replace(/[^a-zа-яё\d_-]/ig, '_').slice(0, 30);
  const documents = groups.map((part, index) => {
    const source = Buffer.concat(Array.from(zipParts(entries(part, index + 1, groups.length))));
    if (source.length > maximum) throw new Error('Архив оригиналов превысил допустимый размер.');
    return { source, mime: 'application/zip', name: 'Отчёт-' + order + '-оригиналы' + (groups.length > 1 ? '-' + (index + 1) + '-из-' + groups.length : '') + '.zip',
      caption: 'Оригиналы выезда' + (data.order_id ? ' · заявка #' + data.order_id : '') + (groups.length > 1 ? '\nЧасть ' + (index + 1) + ' из ' + groups.length : '') + '\n' + part.length + ' файлов · исходники и полная графика без изменения качества.', bytes: source.length };
  });
  const previewRoles=['map','plan','entrance','zone','interior'].concat(data.object_category==='other'?['photo','exterior']:[]);
  const inline = files.filter(item => /^(image\/(jpeg|png))$/.test(item.file.mime) && previewRoles.includes(item.file.role) && !['source', 'original'].includes(item.file.subject_id) && item.buffer.length <= 10 * 1024 * 1024);
  const photos = inline.map(item => {
    const peers = inline.filter(other => other.file.role === item.file.role && other.file.subject_id === item.file.subject_id);
    const { data: encoded, ...metadata } = item.file;
    const photo = { ...metadata, source: item.buffer, presentation_index: peers.indexOf(item) + 1, presentation_count: peers.length };
    photo.caption = photoCaption(photo, data.order_id, data); return photo;
  });
  return { photos, documents };
}

// Preserve original bytes for the lawyer. Telegram previews are additional
// views, never replacements for the originals retained by the draft/handoff.
function deliveryMedia(data) {
  const documents = data.documents || [];
  if (data.ui_version !== 5) return { photos: data.photos || [], documents };
  const rank = file => file.role === 'map' ? 0 : file.role === 'plan' ? 1 : file.role === 'entrance' ? 2 : file.role === 'zone' ? 3 : 4;
  const inline = documents.filter(file =>
    /^(image\/(jpeg|png))$/.test(file.mime) &&
    ['map', 'plan', 'entrance', 'zone', 'interior'].includes(file.role) &&
    !['source', 'original'].includes(file.subject_id) &&
    (file.source ? file.source.length : Buffer.byteLength(file.data || '', 'base64')) <= 10 * 1024 * 1024
  ).sort((a, b) => rank(a) - rank(b));
  return { photos: inline.map(file => ({ ...file, data: file.data || file.source.toString('base64') })), documents };
}

module.exports = { splitTelegramHtml, photoCaption, deliveryMedia, presentationMedia, MAX_ARCHIVE_BYTES };
