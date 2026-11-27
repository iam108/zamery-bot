'use strict';

const { savedCaseProfile, technicalDescriptionPaymentLabel } = require('./handoff-case-profile');

// Keep room for the case label and an organization-name correction.
const PART_BODY_LIMIT = 3400;
const reportStatuses = {
  ready: 'Соответствует по проверенным пунктам',
  actions: 'Нужны действия',
  insufficient: 'Нужно уточнить',
  obstacle: 'Есть препятствие',
};

const asText = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const oneLine = value => asText(value).replace(/[\x00-\x1f\x7f]/g, ' ');
const count = items => Array.isArray(items) ? items.length : 0;

function splitNotice(text, caseId) {
  if (text.length <= 3500) return [text];

  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + PART_BODY_LIMIT, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start + PART_BODY_LIMIT / 2) end = newline + 1;
      // Telegram's limit is enforced conservatively in UTF-16 units. Do not
      // separate the two halves of an emoji when splitting a long paragraph.
      else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks.map((chunk, index) => index === 0 ? chunk :
    'Клиент #' + caseId + ' · продолжение ' + (index + 1) + '/' + chunks.length + '\n\n' + chunk);
}

function buildGroupNoticeParts(row, state) {
  const profile = savedCaseProfile(row) || {};
  const fields = state.fields || {};
  const payment = technicalDescriptionPaymentLabel(fields.technical_description_payment);
  const ids = (row.order_id ? 'Заявка #' + row.order_id + ' · ' : row.request_id ?
    'Исходная заявка #' + row.request_id + ' · ' : '') + 'Клиент #' + row.id;
  const lines = ['Клиент передан юристу · ' + oneLine(row.lawyer_name), '', 'Организация: ' + oneLine(profile.org)];
  const objectName = oneLine(row.object_name);
  if (objectName && objectName !== oneLine(profile.org)) lines.push('Объект: ' + objectName);
  const metadata = [profile.kind, profile.service, profile.region,
    profile.priority && 'Приоритет: ' + profile.priority].filter(Boolean).map(oneLine);
  lines.push(oneLine(profile.address));
  if (metadata.length) lines.push(metadata.join(' · '));
  lines.push(ids);

  const cad = profile.cad_num || asText(fields.cad_num);
  if (profile.inn) lines.push('ИНН: ' + profile.inn);
  if (cad) lines.push('Кадастровый номер: ' + cad);
  if (payment) lines.push('ТО: ' + payment);
  if (state.manager_name) lines.push('Передал: ' + oneLine(state.manager_name));
  if (state.checklistUnavailable === true) lines.push('', 'Для этой услуги пока нет подходящего чек-листа. Клиент передан юристу; карточка, документы и доработка доступны.');

  if (profile.contacts?.length) {
    lines.push('', 'Контакты');
    for (const [index, contact] of profile.contacts.entries()) {
      const details = [contact.name, contact.phone, contact.tg].filter(Boolean).join(' · ');
      lines.push((index + 1) + '. ' + (details || 'Примечание'));
      if (contact.comment) lines.push(contact.comment);
    }
  }
  if (profile.comment) lines.push('', 'Комментарий менеджера', profile.comment);

  const packet = state.packet || {};
  const manual = state.body?.manual_client === true;
  const manualDocuments = count(packet.manual_materials);
  lines.push('', manual ?
    manualDocuments ? 'Карточка и документы отправлены в личку юриста.' : 'Карточка отправлена в личку юриста.' :
    'Отчёт и собранные материалы — в личке юриста.');

  const report = packet.report;
  if (report) {
    const status = reportStatuses[report.status];
    const audit = ['Отчёт аудитора', status, oneLine(report.actor)].filter(Boolean);
    lines.push(audit.join(' · '));
    if (oneLine(report.readiness?.territory)) lines.push('Территория: ' + oneLine(report.readiness.territory));
    if (count(report.media)) lines.push('Оригиналы аудита: ' + report.media.length);
  }
  if (count(packet.materials)) lines.push('Документы заявки: ' + packet.materials.length);
  if (manualDocuments) lines.push('Документы клиента: ' + manualDocuments);
  if (count(state.extraDocuments?.files)) lines.push('Дополнительные документы: ' + state.extraDocuments.files.length);
  if (report?.video_url) lines.push('Видео осмотра приложено.');
  if (packet.archive_url) lines.push('Архив объекта приложен.');

  const egrn = state.egrn?.result;
  if (egrn === 'attached') lines.push('ЕГРН: отправлена отдельным сообщением.');
  else if (['waiting', 'ordered'].includes(egrn)) lines.push('ЕГРН: ожидается.');
  else if (egrn === 'uncertain') lines.push('ЕГРН: результат заказа не подтверждён; нужна проверка у поставщика.');
  else if (['none', 'missing', 'unavailable'].includes(egrn)) lines.push('ЕГРН: отсутствует в комплекте.');
  else if (egrn === 'included' || count(packet.egrn_links)) lines.push('ЕГРН: входит в комплект.');

  if (row.active_cases != null && Number.isSafeInteger(Number(row.active_cases))) {
    lines.push('Клиентов в работе у юриста: ' + Number(row.active_cases));
  }
  return splitNotice(lines.join('\n'), row.id);
}

module.exports = { buildGroupNoticeParts };
