const { format } = require('date-fns');
const { ru } = require('date-fns/locale');

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

function formatOrderMessage(order) {
  const deadline = order.deadline
    ? format(new Date(order.deadline), 'd MMMM yyyy', { locale: ru })
    : '—';

  const lines = [
    '📋 <b>Заявка #' + order.id + '</b>',
    '',
    '📍 <b>Адрес:</b> ' + esc(order.address),
    '👤 <b>Чей объект:</b> ' + esc(order.owner_name),
    '🏢 <b>Тип:</b> ' + esc(order.object_type),
  ];

  if (order.object_name) lines.push('🏷 <b>Название:</b> ' + esc(order.object_name));
  lines.push('🎥 <b>Видео:</b> ' + (order.has_video ? 'Да' : 'Нет'));
  if (order.zones_info) lines.push('📐 <b>Зоны:</b> ' + esc(order.zones_info));
  lines.push('⏰ <b>Крайний срок:</b> ' + deadline);
  if (order.contacts) lines.push('📞 <b>Контакты:</b> ' + esc(order.contacts));

  lines.push('');
  lines.push(STATUS_EMOJI[order.status] + ' <b>Статус:</b> ' + STATUS_LABEL[order.status]);

  const createdAt = format(new Date(order.created_at), 'd MMM HH:mm', { locale: ru });
  lines.push('🕐 <i>Создана: ' + createdAt + '</i>');

  return lines.join('\n');
}

module.exports = { formatOrderMessage, STATUS_EMOJI, STATUS_LABEL, esc };
