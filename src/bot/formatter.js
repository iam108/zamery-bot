const { format } = require('date-fns');
const { ru } = require('date-fns/locale');
const MOSCOW_CREATED = new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
const CALENDAR_DEADLINE = new Intl.DateTimeFormat('ru-RU', { timeZone:'UTC', day:'numeric', month:'long', year:'numeric' });

function deadlineLabel(value) {
  if (!value) return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(value + 'T12:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) return '—';
    const parts = Object.fromEntries(CALENDAR_DEADLINE.formatToParts(date).map(part => [part.type,part.value]));
    return parts.day + ' ' + parts.month + ' ' + parts.year;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? format(date, 'd MMMM yyyy', { locale: ru }) : '—';
}
function creationLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = Object.fromEntries(MOSCOW_CREATED.formatToParts(date).map(part => [part.type,part.value]));
  return parts.day + ' ' + parts.month + ' ' + parts.hour + ':' + parts.minute;
}

const STATUS_EMOJI = {
  new:         '🆕',
  in_progress: '🔧',
  done:        '✅',
  cancelled:   '❌',
};

const STATUS_LABEL = {
  new:         'Новая',
  in_progress: 'В работе',
  done:        'Выполнена',
  cancelled:   'Отменена',
};

// Экранирование для parse_mode: 'HTML' — любые символы в адресах и контактах безопасны
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; });
}

// Limit escaped HTML, not the source string: one '&' takes five characters.
// Iterate complete code points so a shortened card cannot split an emoji/entity.
function preview(value, limit) {
  const text = String(value == null ? '' : value);
  if (esc(text).length <= limit) return esc(text);
  let result = '';
  for (const character of text) {
    const encoded = esc(character);
    if (result.length + encoded.length > limit - 1) break;
    result += encoded;
  }
  return result + '…';
}

function contactPreview(value) {
  const text = String(value);
  if (esc(text).length <= 850) return esc(text);
  const phones = [];
  for (const pattern of [/(?:^|[^\d+])((?:\+?7|8)?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2})(?!\d)/g, /(?:^|[^\d+])(\+(?:\d[ ()-]*){7,14}\d)(?!\d)/g]) {
    for (const match of text.matchAll(pattern)) phones.push({ index: match.index, value: match[1].trim() });
  }
  const unique = new Map();
  for (const phone of phones.sort((a, b) => a.index - b.index)) {
    const digits = phone.value.replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
    if (!unique.has(digits)) unique.set(digits, phone.value);
  }
  const prefix = unique.size ? preview('Телефоны: ' + [...unique.values()].slice(0, 8).join('; ') + '\n', 320) : '';
  return prefix + preview(text, 850 - prefix.length);
}

function formatOrderMessage(order) {
  const deadline = deadlineLabel(order.deadline);

  const lines = [
    '📋 <b>Заявка #' + order.id + '</b>',
    '',
    '📍 <b>Адрес:</b> ' + preview(order.address, 500),
    '👤 <b>Чей объект:</b> ' + preview(order.owner_name, 350),
    '🏢 <b>Тип:</b> ' + preview(order.object_type, 120),
  ];

  if (order.object_name) lines.push('🏷 <b>Название:</b> ' + preview(order.object_name, 350));
  if (order.service) lines.push('📋 <b>Услуга:</b> ' + preview(order.service, 80));
  if (order.cad_num) lines.push('📄 <b>Кадастровый номер:</b> ' + preview(order.cad_num, 120));
  if (order.service === 'Продление' && order.archive_url) lines.push('🗂 <b>Архив объекта:</b> ' + (esc(order.archive_url).length <= 300 ? esc(order.archive_url) : 'Ссылка сохранена в заявке'));
  lines.push('🎥 <b>Нужно видео:</b> ' + (order.has_video ? 'Да' : 'Нет'));
  if (order.zones_info) lines.push('📐 <b>Задача и известные зоны:</b> ' + preview(order.zones_info, 800));
  lines.push('⏰ <b>Крайний срок:</b> ' + deadline);
  if (order.contacts) lines.push('📞 <b>Контакты:</b> ' + contactPreview(order.contacts));

  lines.push('');
  lines.push(STATUS_EMOJI[order.status] + ' <b>Статус:</b> ' + STATUS_LABEL[order.status]);

  const createdAt = creationLabel(order.created_at);
  if (order.submitted_name) lines.push('👤 <b>Заявку оставил(а):</b> ' + preview(order.submitted_name, 160));
  lines.push('🕐 <i>Создана: ' + createdAt + '</i>');

  return lines.join('\n');
}

module.exports = { formatOrderMessage, STATUS_EMOJI, STATUS_LABEL, esc };
