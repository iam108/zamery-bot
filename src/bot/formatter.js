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

function formatOrderMessage(order) {
  const deadline = order.deadline
    ? format(new Date(order.deadline), 'd MMMM yyyy', { locale: ru })
    : '—';

  const lines = [
    `📋 *Заявка #${order.id}*`,
    ``,
    `📍 *Адрес:* ${order.address}`,
    `👤 *Чей объект:* ${order.owner_name}`,
    `🏢 *Тип:* ${order.object_type}`,
  ];

  if (order.object_name) {
    lines.push(`🏷 *Название:* ${order.object_name}`);
  }

  lines.push(`🎥 *Видео:* ${order.has_video ? 'Да' : 'Нет'}`);

  if (order.zones_info) {
    lines.push(`📐 *Зоны:* ${order.zones_info}`);
  }

  lines.push(`⏰ *Крайний срок:* ${deadline}`);

  if (order.contacts) {
    lines.push(`📞 *Контакты:* ${order.contacts}`);
  }

  lines.push(``);
  lines.push(`${STATUS_EMOJI[order.status]} *Статус:* ${STATUS_LABEL[order.status]}`);

  const createdAt = format(new Date(order.created_at), 'd MMM HH:mm', { locale: ru });
  lines.push(`🕐 _Создана: ${createdAt}_`);

  return lines.join('\n');
}

module.exports = { formatOrderMessage, STATUS_EMOJI, STATUS_LABEL };
