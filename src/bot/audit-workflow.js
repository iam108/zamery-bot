const { esc } = require('./formatter');

const CONCLUSIONS = { ready: 'Соответствует по проверенным пунктам', actions: 'Нужны действия', insufficient: 'Недостаточно данных', obstacle: 'Выявлено препятствие' };
const ZONE_STATUS = { pending: 'Требует уточнения', confirmed: 'Ограничение подтверждено аудитором', excluded: 'Ограничение исключено с основанием' };
const PLAN_TOOLS = new Set(['boundary', 'lease', 'hall', 'bar', 'partition', 'structural', 'opening']);

function normalizeWorkflow(input) {
  if (input.schema_version !== 3) return input;
  const data = { ...input, inspection: { ...(input.inspection || {}) }, workflow: { ...(input.workflow || {}) } };
  const p = data.inspection;
  for (const key of ['alcohol_present', 'within_cadastral', 'all_entrances_checked', 'zones_checked']) if (!p[key]) p[key] = 'Не проверено';
  for (const key of ['building_type', 'boundaries', 'bti', 'to']) if (!data[key]) data[key] = 'Не проверено';
  if (p.service === 'Продление') {
    for (const key of ['archive_available', 'licensed_boundaries_match']) if (!p[key]) p[key] = 'Не проверено';
    if (p.archive_available === 'Да' && !p.archive_match) p.archive_match = 'Не проверено';
    if (p.alcohol_present !== 'Нет' && !p.alcohol_within_licensed) p.alcohol_within_licensed = 'Не проверено';
  } else {
    for (const key of ['archive_available', 'archive_match', 'archive_url', 'licensed_boundaries_match', 'alcohol_within_licensed']) delete p[key];
  }
  data.video_url = data.workflow.video_url || data.video_url || '';
  data.entrances = data.entrances || [];
  data.zones = (data.zones || []).map(z => ({ ...z, status: z.status || 'pending' }));
  return data;
}

function followupTasks(data) {
  const p = data.inspection || {}, w = data.workflow || {}, evidence = data.evidence || [];
  const tasks = [];
  const add = (id, label) => tasks.push({ id, label });
  for (const [key, label] of [['region', 'Регион'], ['building_placement', 'Размещение помещения в здании']]) if (!p[key] || p[key] === 'Не проверено') add(key, label + ': требуется уточнение');
  if (!data.entrances?.length) add('entrances', 'Не перечислены фактические входы и выходы');
  if (/^\d+$/.test(p.entrances_actual) && Number(p.entrances_actual) !== (data.entrances || []).length) add('entrance-count', 'Количество фактических входов не совпадает с отдельными карточками входов');
  for (const entrance of data.entrances || []) {
    if (!['Осмотрен', 'Доступен', 'Да', 'checked', 'accessible'].includes(entrance.access)) add('entrance:' + entrance.id, (entrance.label || 'Вход') + ': доступ / осмотр требует уточнения');
    if (!evidence.some(e => e.subject_id === entrance.id && e.role === 'entrance')) add('entrance-photo:' + entrance.id, (entrance.label || 'Вход') + ': нет фотографии');
    if (!entrance.facing || entrance.facing === 'Не проверено') add('entrance-facing:' + entrance.id, (entrance.label || 'Вход') + ': не установлена сторона выхода');
  }
  for (const zone of data.zones || []) {
    if (zone.status === 'pending') add('zone:' + zone.id, (zone.name || 'Соседняя организация') + ': нужно проверить ограничение');
    if (!evidence.some(e => e.subject_id === zone.id && e.role === 'zone')) add('zone-photo:' + zone.id, (zone.name || 'Соседняя организация') + ': нет фотографии');
  }
  for (const [key, label] of [['alcohol_present', 'Наличие алкоголя'], ['within_cadastral', 'Кадастровые границы'], ['all_entrances_checked', 'Осмотр всех входов'], ['zones_checked', 'Проверка окружения']]) if (!p[key] || p[key] === 'Не проверено') add(key, label + ': не проверено');
  if (p.service === 'Продление') {
    if (p.archive_available !== 'Да' || p.archive_match !== 'Да') add('archive', 'Архивная сверка продления не завершена');
    if (p.licensed_boundaries_match !== 'Да') add('licensed-boundaries', 'Требуется проверить лицензированные границы');
    if (p.alcohol_present !== 'Нет' && p.alcohol_within_licensed !== 'Да') add('alcohol-zone', 'Размещение алкоголя в лицензированной зоне не подтверждено');
  }
  if (p.video_status !== 'Сделано' || !(w.video_url || data.video_url)) add('video', 'Видео осмотра не приложено ссылкой');
  if (!evidence.some(e => ['plan', 'plan-source'].includes(e.role))) add('plan', 'Не приложен план помещения');
  if (!p.plan_source || ['Нет графики', 'Не проверено'].includes(p.plan_source)) add('plan-source', 'Не установлен источник графики');
  for (const [key, label] of [['floor_plan', 'Этаж по плану'], ['floor_actual', 'Фактический этаж']]) if (!p[key] || p[key] === 'Не проверено') add(key, label + ': не проверено');
  if (p.floor_plan && p.floor_actual && p.floor_plan !== p.floor_actual) add('floor-mismatch', 'Различаются этаж по плану и фактический этаж');
  for (const [key, label] of [['building_type', 'Тип здания'], ['boundaries', 'Границы помещения'], ['bti', 'Сверка с представленным планом'], ['to', 'Необходимость ТО']]) if (!data[key] || data[key] === 'Не проверено' || data[key] === 'Под вопросом') add(key, label + ': требуется уточнение');
  for (const [key, label] of [['egrn', 'ЕГРН'], ['lease', 'Основание пользования'], ['plan', 'План помещения']]) if (w.documents?.[key] !== 'Есть') add('document:' + key, label + ': требуется документ / подтверждение наличия');
  return tasks;
}

function validateWorkflow(data) {
  if (data.schema_version !== 3) return;
  const w = data.workflow || {}, p = data.inspection || {};
  if (!CONCLUSIONS[w.conclusion_status]) throw new Error('Выберите итог проверки: соответствует, нужны действия, недостаточно данных или препятствие.');
  if (!Array.isArray(data.entrances) || data.entrances.length > 30) throw new Error('Можно описать до 30 входов.');
  if (!Array.isArray(data.zones) || data.zones.length > 20) throw new Error('Можно описать до 20 соседних организаций.');
  const ids = new Set();
  for (const [items, label] of [[data.entrances, 'входа'], [data.zones, 'организации']]) {
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)) throw new Error('Некорректная или повторная карточка ' + label + '.');
      ids.add(item.id);
      for (const [key, value] of Object.entries(item)) if (typeof value !== 'string' || value.length > 2000) throw new Error('Проверьте поле карточки ' + label + ': ' + key);
    }
  }
  for (const zone of data.zones) {
    if (!ZONE_STATUS[zone.status]) throw new Error('Укажите статус проверки соседней организации.');
    if (zone.status !== 'pending' && (!(zone.resolution || '').trim() || !(zone.source || '').trim())) throw new Error('Добавьте основание и источник решения по организации «' + zone.name + '».');
    if (zone.entrance_id && !data.entrances.some(e => e.id === zone.entrance_id)) throw new Error('Выберите существующий вход для замера зоны.');
    if (zone.dist && zone.dist !== 'Не проверено' && !/^\d{1,6}(?:[.,]\d{1,2})?$/.test(zone.dist)) throw new Error('Расстояние: число в метрах или «Не проверено».');
  }
  for (const [key, value] of Object.entries(w)) {
    if (key === 'documents') { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Проверьте список документов.'); continue; }
    if (key === 'step') { if (!Number.isInteger(value) || value < 0 || value > 7) throw new Error('Некорректный этап проверки.'); continue; }
    if (typeof value !== 'string' || value.length > 6000) throw new Error('Слишком длинное или некорректное поле выезда: ' + key);
  }
  for (const url of [w.video_url, p.archive_url]) if (url && !/^https?:\/\/\S+$/i.test(url)) throw new Error('Для видео и архива укажите ссылку http или https.');
  const plan = data.plan || {};
  if (plan.annotations != null && (!Array.isArray(plan.annotations) || plan.annotations.length > 200)) throw new Error('Слишком много отметок на плане.');
  for (const mark of plan.annotations || []) {
    if (!mark || !PLAN_TOOLS.has(mark.tool) || !Array.isArray(mark.points) || mark.points.length < 2 || mark.points.length > 1000 || mark.points.some(pt => !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y) || pt.x < 0 || pt.x > 1 || pt.y < 0 || pt.y > 1)) throw new Error('Некорректная разметка плана.');
  }
  if (w.conclusion_status === 'ready') {
    const tasks = followupTasks(data);
    const adverse = data.zones.some(z => z.status === 'confirmed') || p.within_cadastral !== 'Да' || p.all_entrances_checked !== 'Да' || p.zones_checked !== 'Да' || data.boundaries !== 'Да' || data.bti === 'Нет' || data.to === 'Нужно' ||
      (p.service === 'Получение' && p.alcohol_present !== 'Нет') ||
      (p.service === 'Продление' && (p.licensed_boundaries_match !== 'Да' || (p.alcohol_present !== 'Нет' && p.alcohol_within_licensed !== 'Да')));
    if (tasks.length || adverse) throw new Error('Есть открытые вопросы или замечания. Уточните их либо выберите итог «Нужны действия», «Недостаточно данных» или «Выявлено препятствие».');
  }
}

function buildWorkflowReport(data) {
  if (data.schema_version !== 3) return { plain: [], html: [] };
  validateWorkflow(data);
  const w = data.workflow || {}, p = data.inspection || {}, plain = [];
  const field = (label, value) => plain.push(label + ': ' + (value || 'Не проверено'));
  plain.push('', 'ПОДГОТОВКА И ВЫЕЗД');
  field('Регион / муниципалитет', [p.region, p.municipality].filter(Boolean).join(' · '));
  field('Предварительная оценка', w.preliminary_status);
  if (w.precheck_notes) field('До выезда', w.precheck_notes);
  field('Созвон', w.call_status);
  field('Согласованный выезд', w.appointment_at);
  field('Контакт на месте', [w.contact_name, w.contact_phone].filter(Boolean).join(' · '));
  if (w.access_notes) field('Условия доступа', w.access_notes);
  for (const [key, label] of [['building_placement', 'Размещение в здании'], ['catering_type', 'Вид общепита'], ['urban_rural', 'Город / село'], ['area_total', 'Общая площадь, м²'], ['area_hall', 'Площадь зала обслуживания, м²'], ['tenure_basis', 'Основание пользования'], ['lease_term', 'Срок аренды']]) if (p[key]) field(label, p[key]);
  plain.push('', 'ФАКТИЧЕСКИЕ ВХОДЫ И ВЫХОДЫ');
  for (const e of data.entrances || []) {
    plain.push('• ' + (e.label || 'Вход') + ' [' + e.id + ']');
    field('Назначение / расположение', [e.kind, e.location, e.facing].filter(Boolean).join(' · '));
    field('Доступ / осмотр', e.access);
    if (e.notes) field('Наблюдения', e.notes);
    const files = (data.evidence || []).filter(f => f.subject_id === e.id);
    field('Доказательства входа', files.length ? files.map(f => f.name).join('; ') : 'Не приложены');
  }
  plain.push('', 'СОСЕДНИЕ ОРГАНИЗАЦИИ: ПРОВЕРКА РЕШЕНИЙ');
  for (const z of data.zones || []) {
    plain.push('• ' + z.name + ' [' + z.id + '] — ' + (ZONE_STATUS[z.status] || 'Требует уточнения'));
    field('Предполагаемый вид деятельности', z.type);
    field('Проверяемый вход', (data.entrances || []).find(e => e.id === z.entrance_id)?.label || z.entrance_id);
    field('Расстояние, м / метод', [z.dist, z.method].filter(Boolean).join(' · '));
    field('Точки и путь измерения', z.points);
    field('Источник проверки', z.source);
    if (z.resolution) field('Основание решения', z.resolution);
    const files = (data.evidence || []).filter(f => f.subject_id === z.id);
    field('Доказательства организации', files.length ? files.map(f => f.name).join('; ') : 'Не приложены');
  }
  plain.push('Расстояния зафиксированы как наблюдения. Применимость ограничения и местного правила требует проверки.');
  if (data.plan?.annotations?.length) field('Отметки на графике', String(data.plan.annotations.length));
  if (data.plan?.wall_basis) field('Основание определения стен', data.plan.wall_basis);
  if (p.archive_url && p.service === 'Продление') field('Архив предыдущей проверки', p.archive_url);
  plain.push('', 'ДОРАБОТКА И ИТОГ');
  field('Статус оценки аудитора', CONCLUSIONS[w.conclusion_status]);
  const tasks = followupTasks(data);
  if (tasks.length) { plain.push('Открытые вопросы:'); tasks.forEach(t => plain.push('• ' + t.label)); }
  else plain.push('Открытых вопросов в отмеченных пунктах нет. Это не является решением о выдаче лицензии.');
  if (w.mitigation) field('Предлагаемая проработка / повторная проверка', w.mitigation);
  if (w.followup_notes) field('Результаты доработки', w.followup_notes);
  plain.push('Внутренний отчёт аудитора. Официальный акт выездной оценки прикладывается отдельно.');
  return { plain, html: plain.map(esc) };
}

function hydrateDraftReport(draft) {
  const data = normalizeWorkflow({ ...draft.data, schema_version: 3, order_id: draft.order_id || null, submit_id: 'draft:' + draft.id + ':' + draft.revision });
  data.draft_id = draft.id;
  data.evidence = (draft.evidence || []).map(({ buffer, data: ignored, ...meta }) => meta);
  data.documents = (draft.evidence || []).map(file => ({ id: file.id, name: file.name, mime: file.mime, role: file.role, subject_id: file.subject_id, sha256: file.sha256, source: file.buffer }));
  data.photos = [];
  validateWorkflow(data);
  return data;
}

module.exports = { normalizeWorkflow, validateWorkflow, buildWorkflowReport, followupTasks, hydrateDraftReport, CONCLUSIONS };
