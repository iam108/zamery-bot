const { esc } = require('./formatter');

const ANSWERS = ['Да', 'Нет', 'Не проверено'];
const SERVICES = ['Получение', 'Продление', 'Переоформление'];
const ALCOHOL_CATEGORIES = ['catering', 'retail'];

function usesInspection(data) {
  return data.ui_version === 5 || ALCOHOL_CATEGORIES.includes(data.object_category) &&
    (data.schema_version === 2 || data.inspection != null);
}

function validateInspection(data) {
  if (!usesInspection(data)) return;
  if (data.ui_version === 5) return validateCompactInspection(data);
  const p = data.inspection;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Заполните сведения об объекте и услуге.');
  if (!SERVICES.includes(p.service)) throw new Error('Выберите услугу: получение, продление или переоформление.');
  if (typeof data.conclusion !== 'string' || !data.conclusion.trim()) throw new Error('Укажите итог аудитора.');
  const choices = { building_type: ['Жилое', 'Нежилое', 'Не проверено'], boundaries: ['Да', 'Нет', 'Под вопросом', 'Не проверено'], bti: ANSWERS, to: ['Нужно', 'Не нужно', 'Не обязательно', 'Не проверено'] };
  for (const [key, options] of Object.entries(data.ui_version === 4 ? {} : choices)) {
    if (!options.includes(data[key])) throw new Error('Ответьте на вопросы о здании, границах, БТИ и ТО; можно выбрать «Не проверено».');
  }
  for (const [key, label] of [['org', 'организацию'], ['address', 'адрес объекта']]) {
    if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error('Укажите ' + label + '.');
  }
  const required = ['alcohol_present', 'within_cadastral', 'all_entrances_checked', 'zones_checked'];
  if (p.service === 'Продление') {
    required.push('archive_available', 'licensed_boundaries_match');
    if (p.archive_available === 'Да') required.push('archive_match');
    if (p.alcohol_present !== 'Нет') required.push('alcohol_within_licensed');
  }
  for (const key of required) {
    if (!ANSWERS.includes(p[key])) throw new Error('Ответьте на вопросы проверки; если данных нет, выберите «Не проверено».');
  }
  for (const [key, value] of Object.entries(p)) {
    if (typeof value !== 'string' || value.length > (['risks', 'structural_elements', 'plan_note', 'archive_url'].includes(key) ? 2000 : 500)) {
      throw new Error('Слишком длинное или некорректное поле проверки: ' + key);
    }
  }
  for (const key of ['entrances_plan', 'entrances_actual']) {
    if (p[key] && p[key] !== 'Не проверено' && !/^\d{1,3}$/.test(p[key])) throw new Error('Количество входов: число от 0 до 999 или «Не проверено».');
  }
  if (data.zones != null && (!Array.isArray(data.zones) || data.zones.length > 20)) throw new Error('Можно указать до 20 соседних организаций.');
  for (const zone of data.zones || []) {
    if (!zone || typeof zone.name !== 'string' || !zone.name.trim()) throw new Error('Укажите название соседней организации.');
    for (const key of ['name', 'dist', 'license', 'info']) {
      if (zone[key] != null && (typeof zone[key] !== 'string' || zone[key].length > (data.schema_version === 3 ? 2000 : 1000))) throw new Error('Проверьте данные соседней организации.');
    }
  }
  const photoLimit = data.schema_version === 3 ? 60 : 10;
  if (data.photos != null && (!Array.isArray(data.photos) || data.photos.length > photoLimit)) throw new Error('Можно прикрепить до ' + photoLimit + ' изображений.');
}

function buildInspectionReport(data) {
  if (!usesInspection(data)) return { html: [], plain: [] };
  validateInspection(data);
  if (data.ui_version === 5) return buildCompactInspectionReport(data);
  const p = data.inspection;
  const plain = [];
  const warnings = [];
  function field(label, value) { if (data.ui_version === 4 && !value) return; plain.push(label + ': ' + (value || 'Не указано')); }
  field('Организация', p.org);
  field('Адрес', p.address);
  field('Дата осмотра', p.visit_date);
  field('Услуга', p.service);
  plain.push('');
  plain.push('ПЛАН И АРХИВ');
  field('Этаж по плану', p.floor_plan);
  field('Фактический этаж', p.floor_actual);
  field('Источник графики', p.plan_source);
  if (p.plan_note) field('Пояснение к графике', p.plan_note);
  field('Фактические конструктивные элементы', p.structural_elements);
  if (p.service === 'Продление') {
    field('Архив доступен', p.archive_available);
    if (p.archive_available === 'Да') field('Совпадает с архивом', p.archive_match);
    if (p.archive_available !== 'Да') warnings.push('Архивная сверка не выполнена: ' + p.archive_available.toLowerCase() + '.');
    else if (p.archive_match !== 'Да') warnings.push('Совпадение с архивом: ' + p.archive_match.toLowerCase() + '.');
  }
  plain.push('');
  plain.push('АЛКОГОЛЬ И ГРАНИЦЫ');
  field('Алкоголь на объекте', p.alcohol_present);
  if (p.service === 'Получение') {
    field('Проверка для получения', p.alcohol_present === 'Нет' ? 'Алкоголь отсутствует' : p.alcohol_present === 'Да' ? 'Есть алкоголь — требуется убрать' : 'Отсутствие алкоголя не проверено');
    if (p.alcohol_present !== 'Нет') warnings.push(p.alcohol_present === 'Да' ? 'Получение: алкоголь на объекте необходимо убрать.' : 'Получение: отсутствие алкоголя не подтверждено.');
  } else if (p.service === 'Продление') {
    field('Алкоголь в лицензированной зоне', p.alcohol_present === 'Нет' ? 'Не оценивается — алкоголя нет' : p.alcohol_within_licensed);
    field('Границы лицензирования соблюдены', p.licensed_boundaries_match);
    if (p.alcohol_present === 'Не проверено') warnings.push('Продление: наличие алкоголя не проверено.');
    if (p.alcohol_present !== 'Нет' && p.alcohol_within_licensed !== 'Да') warnings.push(p.alcohol_within_licensed === 'Нет' ? 'Продление: алкоголь находится за пределами лицензированной зоны.' : 'Продление: размещение алкоголя в лицензированной зоне не подтверждено.');
    if (p.licensed_boundaries_match !== 'Да') warnings.push('Соблюдение границ лицензирования: ' + p.licensed_boundaries_match.toLowerCase() + '.');
  } else plain.push('Размещение алкоголя при переоформлении: требуется отдельная оценка.');
  field('В пределах кадастрового помещения', p.within_cadastral);
  if (p.within_cadastral !== 'Да') warnings.push('Кадастровые границы: ' + p.within_cadastral.toLowerCase() + '.');
  plain.push('');
  plain.push('ВХОДЫ И ОКРУЖЕНИЕ');
  field('Входов на плане', p.entrances_plan);
  field('Входов/выходов фактически', p.entrances_actual);
  field('Проверено со всех входов', p.all_entrances_checked);
  field('Проверены соседние организации', p.zones_checked);
  if (p.all_entrances_checked !== 'Да') warnings.push('Проверка со всех входов: ' + p.all_entrances_checked.toLowerCase() + '.');
  if (p.zones_checked !== 'Да') warnings.push('Проверка соседних организаций: ' + p.zones_checked.toLowerCase() + '.');
  if (/^\d+$/.test(p.entrances_plan) && /^\d+$/.test(p.entrances_actual) && Number(p.entrances_plan) !== Number(p.entrances_actual)) warnings.push('Количество входов на плане и фактически различается — уточните схему.');
  for (const zone of data.ui_version === 4 ? [] : data.zones || []) {
    plain.push('• ' + zone.name + (zone.dist ? ' — ' + zone.dist + ' м' : ' — расстояние не указано') +
      (zone.license ? '; лицензия: ' + zone.license : '; сведения о лицензии не указаны') + (zone.info ? '; ' + zone.info : ''));
  }
  if (!(data.zones || []).length) plain.push(data.ui_version === 4 && p.zones_checked === 'Да' ? 'Организации с замечаниями не отмечены.' : 'Соседние организации не перечислены; это само по себе не означает отсутствие зон ограничений.');
  plain.push('');
  field('Состояние ремонта', p.repair_state);
  field('Риски и необходимые действия', p.risks);
  field('Видео осмотра', p.video_status);
  const roles = new Set([...(data.photos || []), ...(data.evidence || []), ...(data.request_packet?.materials || [])].map(photo => photo.role));
  if (data.schema_version === 3) field('Представленный план / ЕГРН', roles.has('plan') || roles.has('plan-source') || roles.has('egrn') ? 'Приложен' : 'Не приложен');
  const markedPlan = data.schema_version === 3 ? (data.evidence || []).some(e => e.role === 'plan' && e.subject_id === 'annotation') : roles.has('plan');
  field('План с цветной разметкой', markedPlan ? 'Приложен' : 'Не приложен');
  field('Карта организаций и входов', roles.has('map') ? 'Приложена' : 'Не приложена');
  plain.push('Разметка: сиреневый — заявленные границы; жёлтый — аренда; красный — зал обслуживания; зелёный — бар.');
  if (warnings.length) {
    plain.push('', 'ТРЕБУЕТ ВНИМАНИЯ');
    for (const warning of warnings) plain.push('⚠️ ' + warning);
  }
  return { html: plain.map(line => esc(line)), plain };
}

const TOBACCO_CHOICES = {
  tobacco_display: ['Закрытая', 'Открытая', 'Товара нет', 'Не проверено'],
  tobacco_price_list: ['Есть', 'Нет', 'Не проверено'],
  tobacco_advertising: ['Есть', 'Нет', 'Не проверено'],
};
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const floorKey = value => String(value || '').trim().toLowerCase().replace(/этаж/g, '').replace(/\s+/g, ' ').trim();

function validateCompactInspection(data) {
  const p = data.inspection;
  if (!['catering', 'retail', 'tobacco'].includes(data.object_category)) throw new Error('Менеджеру нужно уточнить тип объекта в заявке.');
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Заполните сведения осмотра.');
  if (!SERVICES.includes(p.service)) throw new Error('В заявке не указана услуга.');
  for (const [key, label] of [['org', 'организацию'], ['address', 'адрес объекта'], ['floor_plan', 'этаж на плане'], ['floor_actual', 'фактический этаж']]) {
    if (!nonempty(p[key])) throw new Error('Укажите ' + label + '.');
  }
  for (const [key, choices, label] of [
    ['building_type', ['Жилое', 'Нежилое'], 'жилое или нежилое здание'],
    ['bti', ['Да', 'Нет'], 'совпадает ли помещение с представленным планом'],
    ['to', ['Нужно', 'Не нужно'], 'требуется ли техническое описание'],
  ]) if (!choices.includes(data[key])) throw new Error('Укажите, ' + label + '.');
  if (!/^[1-9]\d?$/.test(p.cadastral_count || '') || typeof p.cadastral_count !== 'string') throw new Error('Количество кадастровых помещений: целое число от 1 до 99.');
  if (Number(p.cadastral_count) > 1 && !['Сохранена', 'Объединены'].includes(p.inter_cadastral_boundary)) throw new Error('Укажите, сохранены ли границы между кадастровыми помещениями.');
  for (const [key, label] of [['rooms_complete', 'все ли комнаты из плана входят в объект'], ['within_cadastral', 'соблюдены ли границы помещения'], ['kkt_ip', 'есть ли касса ИП']]) {
    if (!['Да', 'Нет'].includes(p[key])) throw new Error('Укажите, ' + label + '.');
  }
  if (!['1', '2'].includes(p.kkt_count)) throw new Error('Выберите количество касс: 1 или 2.');
  if (data.bti === 'Нет' && !nonempty(p.plan_note)) throw new Error('Коротко опишите, что отличается на плане.');
  if (data.object_category === 'tobacco') {
    for (const [key, choices] of Object.entries(TOBACCO_CHOICES)) if (!choices.includes(p[key])) throw new Error('Укажите состояние выкладки, перечня цен и рекламы табака.');
  } else {
    if (!ANSWERS.includes(p.alcohol_present)) throw new Error('Укажите наличие алкоголя на объекте.');
    if (p.service === 'Продление' && p.alcohol_present === 'Да' && !ANSWERS.includes(p.alcohol_within_licensed)) throw new Error('Укажите размещение алкоголя относительно лицензированной зоны.');
  }
  for (const key of ['archive_match', 'licensed_boundaries_match']) if (p[key] && !ANSWERS.includes(p[key])) throw new Error('Проверьте ответ о сверке с архивом.');
  for (const [key, value] of Object.entries(p)) {
    if (typeof value !== 'string' || value.length > (['risks', 'structural_elements', 'plan_note', 'archive_url'].includes(key) ? 2000 : 500)) throw new Error('Слишком длинное или некорректное поле проверки: ' + key);
  }
  if (data.conclusion != null && (typeof data.conclusion !== 'string' || data.conclusion.length > 6000)) throw new Error('Проверьте комментарий аудитора.');
}

function compactInspectionIssues(data) {
  const p = data.inspection || {}, tasks = [];
  const add = (id, label) => tasks.push({ id, label });
  if (floorKey(p.floor_plan) !== floorKey(p.floor_actual)) add('floor-mismatch', 'Этаж на плане и фактический этаж различаются.');
  if (p.within_cadastral === 'Нет') add('cadastral-boundaries', 'Аудитор отметил нарушение границ помещения.');
  if (Number(p.cadastral_count) > 1 && p.inter_cadastral_boundary === 'Объединены') add('inter-cadastral', 'Помещения из ' + p.cadastral_count + ' кадастров объединены.');
  if (p.rooms_complete === 'Нет') add('rooms-incomplete', 'Не все комнаты из плана входят в объект.');
  if (data.bti === 'Нет') add('plan-mismatch', 'Расхождения планировки: ' + (p.plan_note || 'описание не заполнено'));
  if (data.to === 'Нужно') add('technical-description', 'Требуется техническое описание.');
  if (p.service === 'Продление') {
    if (data.workflow?.archive_skipped === 'Да') add('archive-skipped', 'Архив не предоставлен; сверка с архивом не выполнена.');
    else if (p.archive_match === 'Нет') add('archive-mismatch', 'Аудитор отметил расхождения с архивом.');
    else if (p.archive_match === 'Не проверено') add('archive-unchecked', 'Сверка с архивом не выполнена.');
    if (data.workflow?.archive_skipped !== 'Да' && p.licensed_boundaries_match === 'Нет') add('licensed-boundaries', 'Аудитор отметил расхождение лицензированных границ.');
  }
  if (data.object_category === 'tobacco') {
    if (p.tobacco_display === 'Открытая') add('tobacco-display', 'Зафиксирована открытая выкладка табачной продукции.');
    else if (p.tobacco_display === 'Не проверено') add('tobacco-display', 'Выкладка табака не проверена.');
    if (p.tobacco_price_list !== 'Есть') add('tobacco-prices', p.tobacco_price_list === 'Нет' ? 'Перечень продукции с ценами отсутствует.' : 'Перечень цен не проверен.');
    if (p.tobacco_advertising !== 'Нет') add('tobacco-ads', p.tobacco_advertising === 'Есть' ? 'Зафиксирована реклама табака.' : 'Реклама табака не проверена.');
  } else {
    if (p.alcohol_present === 'Не проверено') add('alcohol-unknown', 'Наличие алкоголя не установлено.');
    else if (p.service === 'Получение' && p.alcohol_present === 'Да') add('alcohol-new', 'Получение: на объекте есть алкоголь (рабочее правило команды — убрать).');
    if (p.service === 'Продление' && p.alcohol_present === 'Да' && p.alcohol_within_licensed !== 'Да') add('alcohol-zone', p.alcohol_within_licensed === 'Нет' ? 'Алкоголь находится за пределами лицензированной зоны.' : 'Размещение алкоголя в лицензированной зоне не подтверждено.');
  }
  return tasks;
}

function buildCompactInspectionReport(data) {
  const p = data.inspection, plain = [];
  const field = (label, value) => { if (value) plain.push(label + ': ' + value); };
  field('Организация', p.org); field('Адрес', p.address); field('Услуга', p.service); field('Дата осмотра', p.visit_date);
  field('Здание', data.building_type + ' · указано аудитором');
  plain.push('Этаж: по плану — ' + p.floor_plan + '; фактически — ' + p.floor_actual);
  field('Кадастровых помещений', p.cadastral_count);
  if (Number(p.cadastral_count) > 1) field('Границы между кадастрами', p.inter_cadastral_boundary);
  field('Все комнаты из плана входят в объект', p.rooms_complete);
  field('Границы помещения соблюдены', p.within_cadastral);
  field('Планировка совпадает с планом', data.bti); field('Что отличается', p.plan_note);
  field('Техническое описание', data.to);
  plain.push('Кассы: ' + p.kkt_count + '; касса ИП: ' + p.kkt_ip.toLowerCase());
  if (data.object_category === 'tobacco') {
    plain.push('Табак: выкладка — ' + p.tobacco_display.toLowerCase() + '; перечень цен — ' + p.tobacco_price_list.toLowerCase() + '; реклама — ' + p.tobacco_advertising.toLowerCase());
  } else {
    field('Алкоголь на объекте', p.alcohol_present);
    if (p.service === 'Продление' && p.alcohol_present !== 'Нет') field('Алкоголь в лицензированной зоне', p.alcohol_within_licensed);
  }
  if (p.service === 'Продление' && data.workflow?.archive_skipped !== 'Да') {
    field('Сверка с архивом', p.archive_match); field('Лицензированные границы совпадают', p.licensed_boundaries_match);
  }
  return { plain, html: plain.map(esc) };
}

module.exports = { validateInspection, buildInspectionReport, usesInspection, compactInspectionIssues, TOBACCO_CHOICES };
