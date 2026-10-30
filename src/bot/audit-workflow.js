const { esc } = require('./formatter');
const { validateInspection, compactInspectionIssues } = require('./audit-inspection');

const CONCLUSIONS = { ready: 'Соответствует по проверенным пунктам', actions: 'Нужны действия', insufficient: 'Недостаточно данных', obstacle: 'Выявлено препятствие' };
const ZONE_STATUS = { pending: 'Требует уточнения', confirmed: 'Ограничение подтверждено аудитором', excluded: 'Ограничение исключено с основанием' };
const PLAN_TOOLS = new Set(['boundary', 'lease', 'hall', 'bar', 'partition', 'structural', 'opening']);
const COMPACT_PLAN_TOOLS = new Set([...PLAN_TOOLS, 'licensed', 'license', 'cadastral', 'room', 'removed', 'text']);
const MAP_TOOLS = new Set(['entrance', 'hazard', 'route', 'straight', 'text']);
const COMPACT_ZONE_STATUS = { pending: 'Требует уточнения', clear: 'Без замечаний', licensed: 'Есть сведения о лицензии', disputed: 'Спорное место', confirmed: 'Ограничение отмечено аудитором', other: 'Наблюдение' };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function normalizeWorkflow(input) {
  if (input.schema_version !== 3) return input;
  const data = { ...input, inspection: { ...(input.inspection || {}) }, workflow: { ...(input.workflow || {}) } };
  const p = data.inspection;
  if (data.ui_version >= 4) {
    const packet = data.request_packet || {};
    p.region = 'МСК';
    for (const key of ['org', 'address', 'service', 'archive_url']) if (packet[key] != null) p[key] = String(packet[key]);
    if (packet.object_category) data.object_category = packet.object_category;
    if (p.service === 'Продление') p.archive_available = packet.archive_url || (packet.materials || []).some(f => f.role === 'archive') ? 'Да' : 'Нет';
  }
  if (data.ui_version === 5) {
    if (p.service !== 'Продление') {
      for (const key of ['archive_available', 'archive_match', 'archive_url', 'licensed_boundaries_match', 'alcohol_within_licensed']) delete p[key];
      delete data.workflow.archive_skipped;
    } else if (data.workflow.archive_skipped === 'Да') {
      p.archive_available = 'Нет'; delete p.archive_match; delete p.licensed_boundaries_match;
    } else {
      p.archive_available = [...(data.evidence || []), ...(data.request_packet?.materials || [])].some(file => file.role === 'archive') ? 'Да' : 'Нет';
    }
    if (p.cadastral_count === '1') delete p.inter_cadastral_boundary;
    if (data.object_category === 'tobacco') { delete p.alcohol_present; delete p.alcohol_within_licensed; }
    data.video_url = Object.hasOwn(data.workflow, 'video_url') ? data.workflow.video_url : data.video_url || '';
    data.entrances = data.entrances || []; data.zones = data.zones || [];
    return data;
  }
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
  data.zones = (data.zones || []).map((z, i) => ({ ...z, ...(data.ui_version === 4 && !String(z.name || '').trim() ? { name: 'Неустановленная организация ' + (i + 1) } : {}), status: z.status || 'pending' }));
  return data;
}

function simpleFollowupTasks(data) {
  const p = data.inspection || {}, packet = data.request_packet || {}, tasks = [];
  const evidence = [...(data.evidence || []), ...(packet.materials || [])];
  const add = (id, label) => tasks.push({ id, label });
  if (!data.entrances?.length) add('entrances', 'Добавить фотографии входов');
  for (const entrance of data.entrances || []) {
    if (['Нет доступа', 'Не осмотрен'].includes(entrance.access)) add('entrance:' + entrance.id, (entrance.label || 'Вход') + ': нужно досмотреть');
    if (!evidence.some(e => e.subject_id === entrance.id && e.role === 'entrance')) add('entrance-photo:' + entrance.id, (entrance.label || 'Вход') + ': нет фотографии');
  }
  for (const zone of data.zones || []) {
    if (zone.status === 'pending') add('zone:' + zone.id, (zone.name || 'Организация рядом') + ': уточнить ограничение');
  }
  for (const [key, label] of [['alcohol_present', 'Наличие алкоголя'], ['within_cadastral', 'Границы помещения'], ['all_entrances_checked', 'Все входы'], ['zones_checked', 'Окружение']]) if (!p[key] || p[key] === 'Не проверено') add(key, label + ': не проверено');
  if (p.service === 'Продление') {
    if (p.archive_available !== 'Да') add('archive-missing', 'Менеджер не передал архив предыдущей проверки');
    else if (p.archive_match !== 'Да') add('archive', 'Сверить фактическую планировку с архивом');
    if (p.licensed_boundaries_match !== 'Да') add('licensed-boundaries', 'Проверить лицензированные границы');
    if (p.alcohol_present !== 'Нет' && p.alcohol_within_licensed !== 'Да') add('alcohol-zone', 'Проверить размещение алкоголя в лицензированных границах');
  }
  if (packet.video_required && (p.video_status !== 'Сделано' || !(data.workflow?.video_url || data.video_url))) add('video', 'Приложить видео, указанное в задании менеджера');
  if (data.bti === 'Нет') add('plan-mismatch', 'Планировка отличается от представленной графики');
  if (data.to === 'Нужно') add('technical-survey', 'Нужно техническое обследование');
  if (!evidence.some(e => ['plan', 'plan-source', 'egrn'].includes(e.role))) add('plan', 'В заявке нет плана / ЕГРН — запросить у менеджера');
  return tasks;
}

function followupTasks(data) {
  if (data.ui_version === 5) return compactFollowupTasks(data);
  if (data.ui_version === 4) return simpleFollowupTasks(data);
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
  if (data.ui_version === 5) return validateCompactWorkflow(data);
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
    if (zone.status !== 'pending' && !(zone.resolution || '').trim() && !(zone.source || '').trim()) throw new Error('Добавьте основание решения по организации «' + zone.name + '».');
    if (zone.entrance_id && !data.entrances.some(e => e.id === zone.entrance_id)) throw new Error('Выберите существующий вход для замера зоны.');
    if (zone.dist && zone.dist !== 'Не проверено' && !/^\d{1,6}(?:[.,]\d{1,2})?$/.test(zone.dist)) throw new Error('Расстояние: число в метрах или «Не проверено».');
  }
  for (const [key, value] of Object.entries(w)) {
    if (key === 'documents') { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Проверьте список документов.'); continue; }
    if (key === 'step') { if (!Number.isInteger(value) || value < 0 || value > (data.ui_version === 4 ? 2 : 7)) throw new Error('Некорректный этап проверки.'); continue; }
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
    const adverse = data.zones.some(z => z.status === 'confirmed') || p.within_cadastral !== 'Да' || p.all_entrances_checked !== 'Да' || p.zones_checked !== 'Да' || (data.ui_version !== 4 && (data.boundaries !== 'Да' || data.bti === 'Нет' || data.to === 'Нужно')) ||
      (p.service === 'Получение' && p.alcohol_present !== 'Нет') ||
      (p.service === 'Продление' && (p.licensed_boundaries_match !== 'Да' || (p.alcohol_present !== 'Нет' && p.alcohol_within_licensed !== 'Да')));
    if (tasks.length || adverse) throw new Error('Есть открытые вопросы или замечания. Уточните их либо выберите итог «Нужны действия», «Недостаточно данных» или «Выявлено препятствие».');
  }
}

function buildWorkflowReport(data) {
  if (data.schema_version !== 3) return { plain: [], html: [] };
  validateWorkflow(data);
  if (data.ui_version === 5) return buildCompactWorkflowReport(data);
  if (data.ui_version === 4) return buildSimpleReport(data);
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

function buildSimpleReport(data) {
  const packet = data.request_packet || {}, p = data.inspection || {}, w = data.workflow || {}, plain = [];
  const field = (label, value) => { if (value) plain.push(label + ': ' + value); };
  plain.push('', 'ЗАДАНИЕ ИЗ ЗАЯВКИ');
  field('Контакт', packet.contacts);
  field('Срок', packet.deadline);
  field('Задача менеджера', packet.zones_info);
  if (packet.materials?.length) field('Документы заявки', packet.materials.map(f => f.name).join('; '));
  if (p.service === 'Продление') field('Архив предыдущей проверки', packet.archive_url || (packet.materials || []).filter(f => f.role === 'archive').map(f => f.name).join('; '));
  plain.push('', 'НА ОБЪЕКТЕ');
  for (const entrance of data.entrances || []) {
    plain.push('• ' + (entrance.label || 'Вход'));
    field('Примечание', [entrance.location, entrance.notes, entrance.access].filter(Boolean).join(' · '));
  }
  for (const z of data.zones || []) {
    plain.push('• ' + z.name + ' — ' + ZONE_STATUS[z.status]);
    field('Расстояние', z.dist ? z.dist + ' м' : '');
    field('Как измерено', [z.method, z.points].filter(Boolean).join(' · '));
    field('Наблюдения', z.info);
    field('Результат проверки', z.resolution);
    field('Источник', z.source);
  }
  if (data.plan?.annotations?.length) field('Отметки на плане', String(data.plan.annotations.length));
  field('Основание определения стен', data.plan?.wall_basis);
  if (['Да', 'Нет'].includes(data.bti)) field('Планировка совпадает с графикой', data.bti);
  if (['Нужно', 'Не нужно', 'Не обязательно'].includes(data.to)) field('Техническое обследование', data.to);
  field('Видео', w.video_url);
  plain.push('', 'ИТОГ');
  field('Результат аудитора', CONCLUSIONS[w.conclusion_status]);
  const tasks = simpleFollowupTasks(data);
  if (tasks.length) { plain.push('Осталось уточнить:'); tasks.forEach(t => plain.push('• ' + t.label)); }
  field('Доработка', w.followup_notes);
  field('Предлагаемые действия', w.mitigation);
  return { plain, html: plain.map(esc) };
}

function hydrateDraftReport(draft) {
  const activeEvidence = (draft.evidence || []).map(({ buffer, data: ignored, ...meta }) => meta);
  const data = normalizeWorkflow({ ...draft.data, evidence: activeEvidence, schema_version: 3, order_id: draft.order_id || null, submit_id: 'draft:' + draft.id + ':' + draft.revision });
  data.draft_id = draft.id;
  data.evidence = activeEvidence;
  data.documents = (draft.evidence || []).map(file => ({ id: file.id, name: file.name, mime: file.mime, role: file.role, subject_id: file.subject_id, sha256: file.sha256, source: file.buffer }));
  data.photos = [];
  validateWorkflow(data);
  return data;
}

function compactFollowupTasks(data) {
  const tasks = compactInspectionIssues(data);
  if (data.request_packet?.video_required && data.inspection?.video_status !== 'Сделано') tasks.push({ id: 'video-status', label: 'Готовность видео из задания менеджера не подтверждена.' });
  for (const entrance of data.entrances || []) if (['Нет доступа', 'Не осмотрен'].includes(entrance.access)) tasks.push({ id: 'entrance:' + entrance.id, label: (entrance.label || 'Вход') + ': нужно досмотреть.' });
  for (const zone of data.zones || []) {
    if (['pending', 'disputed', 'confirmed'].includes(zone.status)) tasks.push({ id: 'zone:' + zone.id, label: (zone.name || 'Организация') + ': ' + COMPACT_ZONE_STATUS[zone.status].toLowerCase() + (zone.resolution || zone.note ? ' — ' + (zone.resolution || zone.note) : '') });
  }
  return tasks;
}

function validateCompactDrawing(drawing, type, evidence, subject, requireMarks) {
  if (!drawing || typeof drawing !== 'object' || Array.isArray(drawing)) throw new Error(type === 'map' ? 'Добавьте схему территории.' : 'Выберите лист плана помещения.');
  const source = evidence.find(file => file.id === drawing.evidence_id);
  const sourceRoles = type === 'map' ? ['map-source'] : ['plan-source', 'egrn', 'archive'];
  if (!source || !sourceRoles.includes(source.role)) throw new Error(type === 'map' ? 'Исходный скриншот схемы не найден в материалах. Загрузите его снова.' : 'Исходный файл выбранного плана не найден в материалах. Загрузите его снова.');
  if (!Number.isInteger(drawing.page) || drawing.page < 1 || drawing.page > 10000) throw new Error('Укажите номер выбранной страницы плана или схемы.');
  if (!Array.isArray(drawing.annotations) || drawing.annotations.length > 200) throw new Error('Проверьте список отметок на плане или схеме.');
  if (requireMarks && !drawing.annotations.length) throw new Error(type === 'map' ? 'Отметьте входы и проверенные организации на схеме.' : 'Отметьте границы помещения на плане.');
  if (drawing.pending && Array.isArray(drawing.pending.points) && drawing.pending.points.length) throw new Error('Завершите незамкнутую разметку или отмените её перед отправкой.');
  const ids = new Set(), tools = type === 'map' ? MAP_TOOLS : COMPACT_PLAN_TOOLS;
  for (const mark of drawing.annotations) {
    if (!mark || !nonempty(mark.id) || mark.id.length > 100 || ids.has(mark.id) || !tools.has(mark.tool)) throw new Error('Некорректная или повторная отметка на плане или схеме.');
    ids.add(mark.id);
    const polygon = type !== 'map' && ['boundary', 'licensed', 'license', 'cadastral', 'room', 'bar', 'lease', 'hall'].includes(mark.tool);
    const minimum = polygon ? 3 : ['entrance', 'hazard', 'opening', 'text'].includes(mark.tool) ? 1 : 2;
    if (!Array.isArray(mark.points) || mark.points.length < minimum || mark.points.length > 1500 || mark.points.some(pt => !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y) || pt.x < 0 || pt.x > 1 || pt.y < 0 || pt.y > 1)) throw new Error('Некорректная геометрия отметки на плане или схеме.');
    if (polygon) {
      const area = mark.points.reduce((sum, point, i) => { const next = mark.points[(i + 1) % mark.points.length]; return sum + point.x * next.y - next.x * point.y; }, 0) / 2;
      if (Math.abs(area) <= 1e-8) throw new Error('Граница на плане должна образовывать замкнутую область.');
    }
    for (const key of ['code', 'label', 'status', 'source', 'sourceUrl', 'note', 'fromEntranceId', 'toObjectId']) if (mark[key] != null && (typeof mark[key] !== 'string' || mark[key].length > 2000)) throw new Error('Проверьте подпись отметки на схеме или плане.');
    if (mark.distance != null && mark.distance !== '' && !/^\d{1,6}(?:[.,]\d{1,2})?$/.test(String(mark.distance))) throw new Error('Расстояние на схеме указывается числом в метрах.');
  }
  if (drawing.annotations.length) {
    const previews = evidence.filter(file => file.role === type && file.subject_id === subject && /^image\//.test(file.mime || ''));
    if (!previews.length || drawing.preview_evidence_id && !previews.some(file => file.id === drawing.preview_evidence_id)) throw new Error(type === 'map' ? 'Сохраните изображение размеченной схемы перед отправкой.' : 'Сохраните изображение размеченного плана перед отправкой.');
  }
}

function validateCompactWorkflow(data) {
  validateInspection(data);
  const p = data.inspection, w = data.workflow || {}, evidence = data.evidence || [];
  if (!CONCLUSIONS[w.conclusion_status]) throw new Error('Выберите результат выезда.');
  if (!Array.isArray(evidence) || evidence.length > 60) throw new Error('Проверьте комплект файлов отчёта.');
  if (!Array.isArray(data.entrances) || !data.entrances.length || data.entrances.length > 30) throw new Error('Отметьте хотя бы один вход на схеме и добавьте его фото.');
  if (!Array.isArray(data.zones) || data.zones.length > 20) throw new Error('Можно описать до 20 проверенных организаций.');
  const ids = new Set();
  for (const item of [...data.entrances, ...data.zones]) {
    if (!item || !nonempty(item.id) || item.id.length > 100 || ids.has(item.id)) throw new Error('Некорректная или повторная карточка входа или организации.');
    ids.add(item.id);
    for (const [key, value] of Object.entries(item)) if (typeof value !== 'string' || value.length > 2000) throw new Error('Проверьте поле карточки входа или организации: ' + key);
  }
  for (const [key, value] of Object.entries(w)) {
    if (key === 'documents') { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Проверьте список документов.'); continue; }
    if (key === 'step') { if (!Number.isInteger(value) || value < 0 || value > 2) throw new Error('Некорректный раздел отчёта.'); continue; }
    if (typeof value !== 'string' || value.length > 6000) throw new Error('Проверьте поле отчёта: ' + key);
  }
  if (w.archive_skipped && !['Да', 'Нет'].includes(w.archive_skipped)) throw new Error('Проверьте отметку о пропуске архива.');
  const video = Object.hasOwn(w, 'video_url') ? w.video_url : data.video_url || '';
  if (video) { try { const url = new URL(video); if (url.protocol !== 'https:') throw new Error(); } catch (_) { throw new Error('Укажите полную HTTPS-ссылку на видео.'); } }
  if (data.request_packet?.video_required && !video) throw new Error('Менеджер запросил видео: приложите ссылку на Яндекс Диск.');
  if (p.service === 'Продление' && w.archive_skipped !== 'Да' && ![...evidence, ...(data.request_packet?.materials || [])].some(file => file.role === 'archive')) throw new Error('Архивная графика не приложена. Добавьте архив или явно выберите «Архив не предоставлен».');
  validateCompactDrawing(data.map, 'map', evidence, 'annotation', true);
  validateCompactDrawing(data.plan, 'plan', evidence, 'annotation', true);
  if (data.additional_plans != null && (!Array.isArray(data.additional_plans) || data.additional_plans.length > 20)) throw new Error('Проверьте дополнительные планы.');
  const additionalIds = new Set();
  for (const plan of data.additional_plans || []) {
    if (!plan || !nonempty(plan.id) || plan.id.length > 80 || additionalIds.has(plan.id)) throw new Error('У дополнительного плана должен быть отдельный идентификатор.');
    additionalIds.add(plan.id); validateCompactDrawing(plan, 'plan', evidence, 'annotation-' + plan.id, false);
  }
  const marks = data.map.annotations;
  for (const entrance of data.entrances) {
    if (!marks.some(mark => mark.id === (entrance.mark_id || entrance.id) && mark.tool === 'entrance')) throw new Error('Вход «' + (entrance.label || entrance.id) + '» не привязан к отметке на схеме.');
    if (!evidence.some(file => file.subject_id === entrance.id && file.role === 'entrance' && /^image\//.test(file.mime || ''))) throw new Error('Добавьте фото входа «' + (entrance.label || entrance.id) + '».');
  }
  for (const zone of data.zones) {
    if (!nonempty(zone.name) || !COMPACT_ZONE_STATUS[zone.status]) throw new Error('Укажите название и результат проверки организации.');
    if (zone.status === 'licensed' && !nonempty(zone.source)) throw new Error('Для сведений о лицензии организации «' + zone.name + '» укажите источник.');
    if (zone.status === 'confirmed' && !nonempty(zone.source) && !nonempty(zone.resolution) && !nonempty(zone.note)) throw new Error('Укажите основание отмеченного ограничения по организации «' + zone.name + '».');
    if (!marks.some(mark => mark.id === (zone.mark_id || zone.id) && mark.tool === 'hazard')) throw new Error('Организация «' + zone.name + '» не привязана к отметке на схеме.');
    if (!evidence.some(file => file.subject_id === zone.id && file.role === 'zone' && /^image\//.test(file.mime || ''))) throw new Error('Добавьте фото организации «' + zone.name + '».');
    if (zone.entrance_id && !data.entrances.some(item => item.id === zone.entrance_id)) throw new Error('У замера выбран несуществующий вход.');
    if (zone.dist && zone.dist !== 'Не проверено' && !/^\d{1,6}(?:[.,]\d{1,2})?$/.test(zone.dist)) throw new Error('Расстояние: число в метрах или «Не проверено».');
  }
  for (const mark of marks) {
    if (mark.tool === 'entrance' && !data.entrances.some(item => (item.mark_id || item.id) === mark.id)) throw new Error('Добавьте сведения и фото для каждого отмеченного входа.');
    if (mark.tool === 'hazard' && !data.zones.some(item => (item.mark_id || item.id) === mark.id)) throw new Error('Добавьте сведения и фото для каждой отмеченной организации.');
    if (['route', 'straight'].includes(mark.tool)) {
      if (!(Number(String(mark.distance || '').replace(',', '.')) > 0)) throw new Error('Укажите измеренное расстояние для каждой линии замера.');
      if (!data.entrances.some(item => item.id === mark.fromEntranceId) || !data.zones.some(item => item.id === mark.toObjectId)) throw new Error('Свяжите линию замера с существующим входом и организацией.');
    }
  }
  if (w.conclusion_status === 'ready' && compactFollowupTasks(data).length) throw new Error('В отчёте есть замечания или непроверенные сведения. Выберите «Нужны действия» или «Недостаточно данных».');
}

function buildCompactWorkflowReport(data) {
  const packet = data.request_packet || {}, w = data.workflow || {}, plain = [], evidence = data.evidence || [];
  const field = (label, value) => { if (value) plain.push(label + ': ' + value); };
  const contactText = value => {
    if (!value) return '';
    if (typeof value === 'string') { try { return contactText(JSON.parse(value)); } catch (_) { return value; } }
    if (Array.isArray(value)) return value.map(contactText).filter(Boolean).join('; ');
    if (typeof value === 'object') return [value.name || value.contact_name, value.phone || value.contact_phone, value.comment].filter(Boolean).join(' · ');
    return String(value);
  };
  field('Контакт', contactText(packet.contacts)); field('Задача менеджера', packet.zones_info);
  const name = drawing => evidence.find(file => file.id === drawing.evidence_id)?.name || 'Выбранный файл';
  field('План', name(data.plan) + ' · лист ' + data.plan.page + ' · разметка приложена');
  for (const plan of data.additional_plans || []) field('Дополнительный план', name(plan) + ' · лист ' + plan.page + (plan.annotations.length ? ' · разметка приложена' : ' · исходник'));
  field('Схема территории', 'Размеченное изображение приложено');
  const markCode = item => data.map.annotations.find(mark => mark.id === (item.mark_id || item.id))?.code || '';
  plain.push('Входы: ' + data.entrances.map(item => [markCode(item), item.label !== markCode(item) ? item.label : ''].filter(Boolean).join(' · ') || 'Вход').join('; '));
  if (data.zones.length) {
    plain.push('Проверенные организации:');
    for (const zone of data.zones) {
      plain.push('• ' + [markCode(zone), zone.name].filter(Boolean).join(' · ') + ' — ' + COMPACT_ZONE_STATUS[zone.status] + (zone.dist ? '; ' + zone.dist + ' м' : ''));
      field('Источник', zone.source); field('Наблюдение', zone.resolution || zone.note || zone.info);
    }
  } else plain.push('Проверенные организации не перечислены.');
  const video = Object.hasOwn(w, 'video_url') ? w.video_url : data.video_url;
  field('Видео', video);
  if (video && data.inspection.video_status && data.inspection.video_status !== 'Сделано') field('Состояние видео', data.inspection.video_status);
  if (packet.materials?.length) field('Исходные документы заявки', packet.materials.map(file => file.name).join('; '));
  const base = process.env.WEBAPP_URL;
  if (base && data.order_id) { try { const url = new URL('/audit?order_id=' + encodeURIComponent(data.order_id), base); if (['https:', 'http:'].includes(url.protocol)) field('Заявка и полный комплект документов', url.href); } catch (_) {} }
  field('Результат аудитора', CONCLUSIONS[w.conclusion_status]);
  if (data.conclusion && data.conclusion !== CONCLUSIONS[w.conclusion_status]) field('Комментарий аудитора', data.conclusion);
  field('Дополнение по территории', w.territory_notes);
  const tasks = compactFollowupTasks(data);
  if (tasks.length) { plain.push('Замечания:'); tasks.forEach(task => plain.push('• ' + task.label)); }
  field('Клиент сообщил / дополнения', w.followup_notes); field('Предлагаемые действия', w.mitigation);
  return { plain, html: plain.map(esc) };
}

module.exports = { normalizeWorkflow, validateWorkflow, buildWorkflowReport, followupTasks, hydrateDraftReport, CONCLUSIONS };
