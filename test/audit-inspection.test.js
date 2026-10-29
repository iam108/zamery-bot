const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateInspection, buildInspectionReport } = require('../src/bot/audit-inspection');

function report(service = 'Получение', changes = {}) {
  return { schema_version: 2, object_category: 'catering', conclusion: 'Требуется оценка', building_type: 'Жилое', boundaries: 'Да', bti: 'Не проверено', to: 'Не проверено', zones: [], photos: [], inspection: {
    service, org: 'Тестовый объект', address: 'Тестовый адрес', archive_available: 'Да', archive_match: 'Да',
    alcohol_present: 'Нет', within_cadastral: 'Да', all_entrances_checked: 'Да', zones_checked: 'Да',
    licensed_boundaries_match: 'Да', ...changes,
  } };
}

test('acquisition checks alcohol absence even when hidden renewal answer says in-zone', () => {
  const data = report('Получение', { alcohol_present: 'Да', alcohol_within_licensed: 'Да' });
  assert.doesNotThrow(() => validateInspection(data)); // Adverse inspection is reportable.
  const text = buildInspectionReport(data).plain.join('\n');
  assert.match(text, /Получение: алкоголь на объекте необходимо убрать/);
  assert.doesNotMatch(text, /Границы лицензирования соблюдены/);
});

test('renewal checks licensed placement and highlights violations', () => {
  const data = report('Продление', { alcohol_present: 'Да', alcohol_within_licensed: 'Нет' });
  const text = buildInspectionReport(data).plain.join('\n');
  assert.match(text, /за пределами лицензированной зоны/);
  assert.doesNotMatch(text, /необходимо убрать/);
});

test('renewal without alcohol does not invent a violation or reuse hidden placement', () => {
  const text = buildInspectionReport(report('Продление', { alcohol_within_licensed: 'Нет' })).plain.join('\n');
  assert.match(text, /Не оценивается — алкоголя нет/);
  assert.doesNotMatch(text, /за пределами лицензированной зоны/);
});

test('unknown alcohol presence stays unknown', () => {
  const text = buildInspectionReport(report('Получение', { alcohol_present: 'Не проверено' })).plain.join('\n');
  assert.match(text, /отсутствие алкоголя не подтверждено/);
  assert.doesNotMatch(text, /Проверка для получения: Алкоголь отсутствует/);
});

test('renewal requires placement answer when presence is unknown', () => {
  assert.throws(() => validateInspection(report('Продление', { alcohol_present: 'Не проверено' })), /Ответьте на вопросы/);
});

test('service and object identity cannot be silently omitted', () => {
  assert.throws(() => validateInspection(report('', {})), /Выберите услугу/);
  assert.throws(() => validateInspection(report('Получение', { address: ' ' })), /адрес/);
  assert.throws(() => validateInspection(report('Получение', { org: '' })), /организацию/);
});

test('archive mismatch is conditional and missing archive cannot be declared matching', () => {
  const text = buildInspectionReport(report('Продление', { archive_available: 'Нет', archive_match: 'Да' })).plain.join('\n');
  assert.match(text, /Архивная сверка не выполнена/);
  assert.doesNotMatch(text, /Совпадает с архивом: Да/);
});

test('acquisition has no mandatory previous archive or archive warning', () => {
  const data = report('Получение');
  delete data.inspection.archive_available;
  delete data.inspection.archive_match;
  assert.doesNotThrow(() => validateInspection(data));
  const text = buildInspectionReport(data).plain.join('\n');
  assert.doesNotMatch(text, /Архив доступен|Архивная сверка не выполнена|Совпадает с архивом/);
});

test('empty nearby list does not mean zones absent and no 25m threshold is inferred', () => {
  const data = report('Получение', { zones_checked: 'Не проверено' });
  data.zones = [{ name: 'Сосед', dist: '20', license: 'номер 1', info: 'вход со двора' }];
  const text = buildInspectionReport(data).plain.join('\n');
  assert.match(text, /20 м; лицензия: номер 1/);
  assert.match(text, /Проверка соседних организаций: не проверено/);
  assert.doesNotMatch(text, /Зон нет|25|продление возможно/i);
  data.zones = [];
  assert.match(buildInspectionReport(data).plain.join('\n'), /не означает отсутствие зон/);
});

test('plan and map attachments are named; XML/HTML injection is escaped', () => {
  const data = report('Получение', { org: '<script>test</script>', video_status: 'Сделано' });
  data.photos = [{ role: 'plan' }, { role: 'map' }];
  const result = buildInspectionReport(data);
  assert.match(result.plain.join('\n'), /План с цветной разметкой: Приложен/);
  assert.match(result.plain.join('\n'), /Видео осмотра: Сделано/);
  assert.match(result.html.join('\n'), /&lt;script&gt;/);
});

test('legacy reports and tobacco retain compatibility', () => {
  const legacy = { object_category: 'catering', conclusion: 'test' };
  assert.doesNotThrow(() => validateInspection(legacy));
  assert.deepEqual(buildInspectionReport(legacy), { html: [], plain: [] });
  const tobacco = { schema_version: 2, object_category: 'tobacco' };
  assert.doesNotThrow(() => validateInspection(tobacco));
});

test('invalid entrance counts and overlong fields fail before external delivery', () => {
  assert.throws(() => validateInspection(report('Получение', { entrances_plan: '-1' })), /Количество входов/);
  assert.throws(() => validateInspection(report('Получение', { risks: 'x'.repeat(2001) })), /длинное/);
  assert.doesNotThrow(() => validateInspection(report('Получение', { entrances_plan: 'Не проверено' })));
});
