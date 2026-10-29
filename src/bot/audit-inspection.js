const { esc } = require('./formatter');

const ANSWERS = ['Да', 'Нет', 'Не проверено'];
const SERVICES = ['Получение', 'Продление', 'Переоформление'];
const ALCOHOL_CATEGORIES = ['catering', 'retail'];

function usesInspection(data) {
  return ALCOHOL_CATEGORIES.includes(data.object_category) &&
    (data.schema_version === 2 || data.inspection != null);
}

function validateInspection(data) {
  if (!usesInspection(data)) return;
  const p = data.inspection;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Заполните сведения об объекте и услуге.');
  if (!SERVICES.includes(p.service)) throw new Error('Выберите услугу: получение, продление или переоформление.');
  if (typeof data.conclusion !== 'string' || !data.conclusion.trim()) throw new Error('Укажите итог аудитора.');
  const choices = { building_type: ['Жилое', 'Нежилое', 'Не проверено'], boundaries: ['Да', 'Нет', 'Под вопросом', 'Не проверено'], bti: ANSWERS, to: ['Нужно', 'Не нужно', 'Не обязательно', 'Не проверено'] };
  for (const [key, options] of Object.entries(choices)) {
    if (!options.includes(data[key])) throw new Error('Ответьте на вопросы о здании, границах, БТИ и ТО; можно выбрать «Не проверено».');
  }
  for (const [key, label] of [['org', 'организацию'], ['address', 'адрес объекта']]) {
    if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error('Укажите ' + label + '.');
  }
  const required = ['archive_available', 'alcohol_present', 'within_cadastral', 'all_entrances_checked', 'zones_checked'];
  if (p.archive_available === 'Да') required.push('archive_match');
  if (p.service === 'Продление') {
    required.push('licensed_boundaries_match');
    if (p.alcohol_present !== 'Нет') required.push('alcohol_within_licensed');
  }
  for (const key of required) {
    if (!ANSWERS.includes(p[key])) throw new Error('Ответьте на вопросы проверки; если данных нет, выберите «Не проверено».');
  }
  for (const [key, value] of Object.entries(p)) {
    if (typeof value !== 'string' || value.length > (['risks', 'structural_elements', 'plan_note'].includes(key) ? 2000 : 500)) {
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
      if (zone[key] != null && (typeof zone[key] !== 'string' || zone[key].length > 1000)) throw new Error('Проверьте данные соседней организации.');
    }
  }
  if (data.photos != null && (!Array.isArray(data.photos) || data.photos.length > 10)) throw new Error('Можно прикрепить до 10 изображений.');
}

function buildInspectionReport(data) {
  if (!usesInspection(data)) return { html: [], plain: [] };
  validateInspection(data);
  const p = data.inspection;
  const plain = [];
  const warnings = [];
  function field(label, value) { plain.push(label + ': ' + (value || 'Не указано')); }
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
  field('Архив доступен', p.archive_available);
  if (p.archive_available === 'Да') field('Совпадает с архивом', p.archive_match);
  if (p.archive_available !== 'Да') warnings.push('Архивная сверка не выполнена: ' + p.archive_available.toLowerCase() + '.');
  else if (p.archive_match !== 'Да') warnings.push('Совпадение с архивом: ' + p.archive_match.toLowerCase() + '.');
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
  for (const zone of data.zones || []) {
    plain.push('• ' + zone.name + (zone.dist ? ' — ' + zone.dist + ' м' : ' — расстояние не указано') +
      (zone.license ? '; лицензия: ' + zone.license : '; сведения о лицензии не указаны') + (zone.info ? '; ' + zone.info : ''));
  }
  if (!(data.zones || []).length) plain.push('Соседние организации не перечислены; это само по себе не означает отсутствие зон ограничений.');
  plain.push('');
  field('Состояние ремонта', p.repair_state);
  field('Риски и необходимые действия', p.risks);
  field('Видео осмотра', p.video_status);
  const roles = new Set((data.photos || []).map(photo => photo.role));
  field('План с цветной разметкой', roles.has('plan') ? 'Приложен' : 'Не приложен');
  field('Карта организаций и входов', roles.has('map') ? 'Приложена' : 'Не приложена');
  plain.push('Разметка: сиреневый — заявленные границы; жёлтый — аренда; красный — зал обслуживания; зелёный — бар.');
  if (warnings.length) {
    plain.push('', 'ТРЕБУЕТ ВНИМАНИЯ');
    for (const warning of warnings) plain.push('⚠️ ' + warning);
  }
  return { html: plain.map(line => esc(line)), plain };
}

module.exports = { validateInspection, buildInspectionReport, usesInspection };
