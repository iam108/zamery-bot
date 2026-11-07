const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { normalizeWorkflow, validateWorkflow, buildWorkflowReport, followupTasks, hydrateDraftReport } = require('../src/bot/audit-workflow');
const { validateInspection, buildInspectionReport } = require('../src/bot/audit-inspection');
const { compactVisit, addOrganization } = require('./helpers/audit-v5');
const { buildAuditSummary } = require('../src/bot/audit-summary');
const { presentationMedia } = require('../src/bot/audit-delivery');

for (const category of ['catering', 'retail', 'tobacco']) for (const service of ['Получение', 'Продление']) {
  test('V5 ' + category + ' / ' + service + ' accepts actual facts and linked evidence without generic checkboxes', () => {
    const data = compactVisit(category, service);
    assert.doesNotThrow(() => validateInspection(data));
    assert.doesNotThrow(() => validateWorkflow(data));
    assert.equal(data.inspection.all_entrances_checked, undefined);
    assert.equal(data.inspection.zones_checked, undefined);
    const report = buildInspectionReport(data).plain.join('\n');
    assert.match(report, /Кассы: 1; касса ИП: нет/);
    assert.match(report, /Этаж: по плану — 1; фактически — 1 этаж/);
    assert.doesNotMatch(report, /Площадь|Зарегистрирован|Проверено со всех входов|Техническое обследование/);
    if (category === 'tobacco') assert.doesNotMatch(report, /Алкоголь/);
  });
}

test('V5 missing facts remain unanswered, including building type and the second cadastral boundary', () => {
  for (const key of ['floor_plan', 'floor_actual', 'cadastral_count', 'rooms_complete', 'within_cadastral', 'kkt_count', 'kkt_ip']) {
    const data = compactVisit(); delete data.inspection[key]; data.workflow.conclusion_status = 'insufficient';
    const normalized = normalizeWorkflow(data);
    assert.equal(normalized.inspection[key], undefined);
    assert.throws(() => validateWorkflow(normalized));
  }
  const data = compactVisit(); data.building_type = ''; data.inspection.cadastral_count = '2';
  assert.throws(() => validateWorkflow(data), /жилое или нежилое/);
  data.building_type = 'Нежилое';
  assert.throws(() => validateWorkflow(data), /между кадастровыми/);
  data.inspection.inter_cadastral_boundary = 'Сохранена';
  assert.doesNotThrow(() => validateWorkflow(data));
  for (const count of ['0', '-1', '1.5', '100', 2]) { data.inspection.cadastral_count = count; assert.throws(() => validateWorkflow(data), /от 1 до 99/); }
});

test('V5 concrete discrepancies are reportable with actions but cannot become a positive result', () => {
  const data = compactVisit();
  Object.assign(data.inspection, { floor_actual: 'антресоль', cadastral_count: '2', inter_cadastral_boundary: 'Объединены', rooms_complete: 'Нет', within_cadastral: 'Нет', kkt_count: '2', kkt_ip: 'Да', plan_note: 'Стеклянная перегородка <script>' });
  data.bti = 'Нет'; data.to = 'Нужно';
  assert.throws(() => validateWorkflow(data), /замечания/);
  data.workflow.conclusion_status = 'actions';
  assert.doesNotThrow(() => validateWorkflow(data));
  const ids = followupTasks(data).map(item => item.id);
  for (const id of ['floor-mismatch', 'inter-cadastral', 'rooms-incomplete', 'cadastral-boundaries', 'plan-mismatch', 'technical-description']) assert.ok(ids.includes(id));
  const report = buildInspectionReport(data);
  assert.match(report.plain.join('\n'), /Кассы: 2; касса ИП: да/);
  assert.match(report.html.join('\n'), /&lt;script&gt;/);
  assert.doesNotMatch(report.html.join('\n'), /<script>/);
  data.inspection.plan_note = '';
  assert.throws(() => validateWorkflow(data), /что отличается/);
});

test('V5 explicit archive skip permits renewal with one current plan and discloses the omitted comparison', () => {
  const raw = compactVisit('catering', 'Продление');
  raw.request_packet.materials = []; raw.request_packet.archive_url = 'https://disk.yandex.ru/d/example';
  raw.inspection.archive_match = 'Да'; raw.inspection.licensed_boundaries_match = 'Да';
  assert.throws(() => validateWorkflow(normalizeWorkflow(raw)), /Архивная графика не приложена/);
  raw.workflow.archive_skipped = 'Да'; raw.workflow.conclusion_status = 'insufficient';
  const data = normalizeWorkflow(raw);
  assert.equal(data.inspection.archive_available, 'Нет');
  assert.equal(data.inspection.archive_match, undefined);
  assert.equal(data.inspection.licensed_boundaries_match, undefined);
  assert.doesNotThrow(() => validateWorkflow(data));
  assert.match(buildWorkflowReport(data).plain.join('\n'), /Архив не предоставлен; сверка с архивом не выполнена/);
  assert.doesNotMatch(buildInspectionReport(data).plain.join('\n'), /Сверка с архивом: Да|Лицензированные границы совпадают/);
  assert.equal(raw.inspection.archive_match, 'Да', 'normalization must not mutate saved draft');
  data.workflow.conclusion_status = 'ready';
  assert.throws(() => validateWorkflow(data), /замечания/);
});

test('V5 renewal without an alcohol observation has no hidden placement requirement', () => {
  const data = compactVisit('retail', 'Продление');
  data.inspection.alcohol_present = 'Не проверено'; data.workflow.conclusion_status = 'insufficient';
  assert.doesNotThrow(() => validateWorkflow(data));
  assert.ok(followupTasks(data).some(item => item.id === 'alcohol-unknown'));
  data.inspection.alcohol_present = 'Да';
  assert.throws(() => validateWorkflow(data), /размещение алкоголя/);
  data.inspection.alcohol_within_licensed = 'Нет';
  assert.doesNotThrow(() => validateWorkflow(data));
  assert.ok(followupTasks(data).some(item => item.id === 'alcohol-zone'));
});

test('V5 hidden renewal and multiple-cadastral answers do not contaminate acquisition or single-cadastral reports', () => {
  const raw = compactVisit();
  Object.assign(raw.inspection, { archive_match: 'Нет', licensed_boundaries_match: 'Нет', inter_cadastral_boundary: 'Объединены' });
  raw.workflow.archive_skipped = 'Да';
  const data = normalizeWorkflow(raw);
  assert.deepEqual(followupTasks(data), []);
  assert.equal(data.inspection.inter_cadastral_boundary, undefined);
  assert.equal(data.workflow.archive_skipped, undefined);
  assert.equal(raw.inspection.inter_cadastral_boundary, 'Объединены');
});

test('V5 source, preview and active geometry must all exist; a yes checkbox cannot substitute for photo evidence', () => {
  for (const role of ['plan-source', 'map-source', 'plan', 'map', 'entrance']) {
    const data = compactVisit(); data.inspection.all_entrances_checked = 'Да';
    data.evidence = data.evidence.filter(file => file.role !== role);
    assert.throws(() => validateWorkflow(data), /Исходный|изображение|фото/);
  }
  const data = compactVisit(); data.plan.pending = { tool: 'boundary', points: [{ x: 0.4, y: 0.4 }] };
  assert.throws(() => validateWorkflow(data), /Завершите/);
  delete data.plan.pending; data.plan.annotations[0].points[1].x = 1.1;
  assert.throws(() => validateWorkflow(data), /геометрия/);
  data.plan.annotations[0].points = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }];
  assert.throws(() => validateWorkflow(data), /замкнутую область/);
});

test('V5 opening is a point, optional additional sheets retain independent source and annotations', () => {
  const data = compactVisit();
  data.plan.annotations.push({ id: 'opening-1', tool: 'opening', code: 'П1', points: [{ x: 0.5, y: 0.5 }] });
  const source = { id: randomUUID(), role: 'plan-source', name: 'БТИ.pdf', mime: 'application/pdf' };
  data.evidence.push(source);
  data.additional_plans.push({ id: 'extra-2', evidence_id: source.id, page: 6, annotations: [] });
  assert.doesNotThrow(() => validateWorkflow(data));
  assert.match(buildWorkflowReport(data).plain.join('\n'), /БТИ.pdf · лист 6 · исходник/);
  data.additional_plans[0].annotations = [{ id: 'extra-boundary', tool: 'cadastral', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }];
  assert.throws(() => validateWorkflow(data), /изображение размеченного плана/);
  data.evidence.push({ id: randomUUID(), role: 'plan', subject_id: 'annotation-extra-2', name: 'БТИ-разметка.png', mime: 'image/png' });
  assert.doesNotThrow(() => validateWorkflow(data));
  assert.equal(data.plan.page, 2);
});

test('V5 organization codes use actual mark IDs, clear means no remarks and disputed includes its observation', () => {
  const data = addOrganization(compactVisit(), { id: 'org-1', code: 'О1', name: 'Аптека' });
  addOrganization(data, { id: 'org-9', code: 'О9', name: 'Спорная организация', status: 'disputed', note: 'Уточнить назначение кабинета <b>' });
  data.workflow.conclusion_status = 'actions';
  assert.doesNotThrow(() => validateWorkflow(data));
  const report = buildWorkflowReport(data);
  assert.match(report.plain.join('\n'), /О1 · Аптека — Без замечаний/);
  assert.match(report.plain.join('\n'), /О9 · Спорная организация/);
  assert.match(report.html.join('\n'), /Уточнить назначение кабинета &lt;b&gt;/);
  assert.doesNotMatch(report.plain.join('\n'), /О2|Ограничение исключено/);
  data.zones[0].status = 'licensed';
  assert.throws(() => validateWorkflow(data), /источник/);
  data.zones[0].source = 'Карточка реестра № 123';
  assert.doesNotThrow(() => validateWorkflow(data));
  data.evidence = data.evidence.filter(file => file.subject_id !== 'org-9');
  assert.throws(() => validateWorkflow(data), /фото организации/);
});

test('V5 measured route links existing endpoints, supports freehand paths and rejects orphan geometry', () => {
  const data = addOrganization(compactVisit());
  const path = { id: 'route-1', code: 'М1', tool: 'route', distance: '23,5', fromEntranceId: 'entrance-1', toObjectId: 'org-4', points: Array.from({ length: 1500 }, (_, i) => ({ x: i / 1500, y: 0.4 })) };
  data.map.annotations.push(path);
  assert.doesNotThrow(() => validateWorkflow(data));
  path.fromEntranceId = 'deleted-entrance';
  assert.throws(() => validateWorkflow(data), /существующим входом/);
  path.fromEntranceId = 'entrance-1'; path.distance = '';
  assert.throws(() => validateWorkflow(data), /измеренное расстояние/);
  path.distance = '23.5'; data.zones = [];
  assert.throws(() => validateWorkflow(data), /каждой отмеченной организации|существующим входом/);
});

test('explicit clear territory can finish without a map in ready and follow-up reports but still requires entrance photos and a marked plan', () => {
  const data = compactVisit('tobacco');
  data.workflow.territory_result = 'clear';
  delete data.map;
  for (const conclusion of ['ready', 'actions', 'insufficient', 'obstacle']) {
    data.workflow.conclusion_status = conclusion;
    assert.doesNotThrow(() => validateWorkflow(data));
  }
  assert.match(buildWorkflowReport(data).plain.join('\n'), /Зоны запрета и спорные объекты не выявлены/);
  assert.match(buildAuditSummary(data, 'Аудитор').plain, /Зоны запрета и спорные объекты не выявлены/);
  assert.doesNotMatch(buildAuditSummary(data, 'Аудитор').plain, /Организации не перечислены|схема территории приложена/i);
  data.evidence = data.evidence.filter(file => file.role !== 'entrance');
  assert.throws(() => validateWorkflow(data), /Добавьте фото входа/);
  data.plan.annotations = [];
  assert.throws(() => validateWorkflow(data), /границы помещения на плане/);
});

test('explicit clear territory rejects contradictory active map and zone entries and omits inactive historical map files from delivery', () => {
  const data = addOrganization(compactVisit());
  data.workflow.territory_result = 'clear';
  assert.throws(() => validateWorkflow(data), /Для результата «Зон нет»/);
  data.map = { annotations: [] };
  assert.throws(() => validateWorkflow(data), /Для результата «Зон нет»/);
  data.zones = [];
  data.map.annotations = {};
  assert.throws(() => validateWorkflow(data), /Проверьте сведения о схеме территории/);
  data.map.annotations = [];
  data.entrances[0].label = 'Вход 1';
  data.territory_versions = { draw: { entrances: [{ id: 'parked-entrance' }], zones: [{ id: 'org-4' }] } };
  data.evidence.push({ id: randomUUID(), role: 'entrance', subject_id: 'parked-entrance', mime: 'image/jpeg', name: 'Лишний вход.jpg' });
  data.workflow.territory_notes = 'Вход со двора.';
  const evidence = data.evidence.map(file => ({ ...file, buffer: Buffer.from(file.name) }));
  const hydrated = hydrateDraftReport({ id: randomUUID(), revision: 2, order_id: 58, data, evidence });
  assert.deepEqual(hydrated.documents.map(file => file.role), ['plan-source', 'entrance', 'plan']);
  assert.equal(hydrated.territory_versions, undefined);
  assert.deepEqual(data.territory_versions.draw.entrances, [{ id: 'parked-entrance' }]);
  assert.match(buildAuditSummary(hydrated, 'Аудитор').plain, /Аудитор сообщил: Вход со двора\./);
  assert.match(buildWorkflowReport(hydrated).plain.join('\n'), /Дополнение по территории: Вход со двора\./);
  assert.equal(evidence.filter(file => ['zone', 'map', 'map-source'].includes(file.role)).length, 3);
  const media = presentationMedia(hydrated, 'Отчёт');
  const entrances = media.photos.filter(file => file.role === 'entrance');
  assert.equal(entrances.length, 1);
  assert.match(entrances[0].caption, /Вход 1/);
});

test('older V5 territory has mandatory original map semantics and only explicit results unlock the new paths', () => {
  const data = compactVisit();
  assert.doesNotThrow(() => validateWorkflow(data));
  delete data.map;
  assert.throws(() => validateWorkflow(data), /Добавьте схему территории/);
  data.workflow.territory_result = 'unknown';
  assert.throws(() => validateWorkflow(data), /Укажите результат проверки территории/);
  data.workflow.territory_result = 'findings';
  assert.throws(() => validateWorkflow(data), /хотя бы одну проверенную организацию/);
  const findings = addOrganization(compactVisit());
  findings.workflow.territory_result = 'findings';
  findings.workflow.conclusion_status = 'insufficient';
  findings.map = {};
  assert.throws(() => validateWorkflow(findings), /Выберите способ оформления схемы территории/);
  findings.map.mode = 'draw';
  assert.throws(() => validateWorkflow(findings), /Добавьте скриншот карты/);
  findings.map.mode = 'attached';
  assert.throws(() => validateWorkflow(findings), /Приложите готовую схему территории в JPG или PNG/);
});

test('explicit findings accepts finished JPG or PNG with entrance and organization cards and delivers the selected map as an album photo', () => {
  for (const mime of ['image/jpeg', 'image/png']) {
    const data = addOrganization(compactVisit());
    const attached = { id: randomUUID(), role: 'map', subject_id: 'attached', mime, name: 'Готовая схема' };
    data.workflow.territory_result = 'findings';
    data.map = { mode: 'attached', evidence_id: attached.id, annotations: [] };
    data.zones[0].dist = '12,5';
    data.zones[0].entrance_id = data.entrances[0].id;
    data.evidence.push(attached, { id: randomUUID(), role: 'zone', subject_id: 'parked-org', mime, name: 'Старая организация' });
    const evidence = data.evidence.map(file => ({ ...file, buffer: Buffer.from(file.name) }));
    const hydrated = hydrateDraftReport({ id: randomUUID(), revision: 2, order_id: 58, data, evidence });
    assert.match(buildAuditSummary(hydrated, 'Аудитор').plain, /12,5 м от входа «Главный вход»/);
    assert.match(buildAuditSummary(hydrated, 'Аудитор').plain, /Готовая схема территории приложена/);
    const album = presentationMedia(hydrated, 'Отчёт').photos;
    assert.equal(album.filter(file => file.role === 'zone').length, 1);
    assert.equal(hydrated.documents.some(file => file.subject_id === 'parked-org'), false);
    const photos = album.filter(file => file.role === 'map');
    assert.equal(photos.length, 1);
    assert.equal(photos[0].id, attached.id);
    assert.equal(photos[0].source.toString(), attached.name);
    data.zones[0].entrance_id = 'different-entrance';
    assert.throws(() => validateWorkflow(data), /несуществующий вход/);
    data.zones[0].entrance_id = data.entrances[0].id;
    attached.mime = 'application/pdf';
    assert.throws(() => validateWorkflow(data), /готовую схему территории в JPG или PNG/);
  }
});

test('drawn findings require actual measurements or an honest follow-up', () => {
  const data = addOrganization(compactVisit());
  data.workflow.territory_result = 'findings';
  assert.throws(() => validateWorkflow(data), /Выберите вход для замера/);
  data.zones[0].entrance_id = data.entrances[0].id;
  assert.throws(() => validateWorkflow(data), /Укажите расстояние/);
  data.zones[0].dist = '0';
  assert.throws(() => validateWorkflow(data), /Укажите расстояние/);
  data.zones[0].dist = 'Не проверено';
  assert.throws(() => validateWorkflow(data), error => error.code === 'AUDIT_CONCLUSION_CONFLICT' && /Соседняя организация: расстояние не проверено/.test(error.message));
  data.workflow.conclusion_status = 'insufficient';
  assert.doesNotThrow(() => validateWorkflow(data));
  assert.ok(followupTasks(data).some(task => task.id === 'zone-distance:org-4'));
  data.map.annotations.push({ id: 'route-new', tool: 'straight', distance: '20', fromEntranceId: 'entrance-1', toObjectId: 'org-4', points: [{ x: .1, y: .1 }, { x: .2, y: .2 }] });
  data.workflow.conclusion_status = 'ready';
  assert.doesNotThrow(() => validateWorkflow(data));
});

test('V5 clearing optional video removes stale links; required video cannot be silently omitted', () => {
  const data = normalizeWorkflow({ ...compactVisit(), video_url: 'https://disk.yandex.ru/d/old', workflow: { step: 2, conclusion_status: 'ready', video_url: '' } });
  assert.doesNotThrow(() => validateWorkflow(data));
  assert.equal(data.video_url, '');
  assert.doesNotMatch(buildWorkflowReport(data).plain.join('\n'), /disk.yandex.ru/);
  data.request_packet.video_required = true;
  assert.throws(() => validateWorkflow(data), /Менеджер запросил видео/);
  data.workflow.video_url = 'https://disk.yandex.ru/d/current';
  assert.throws(() => validateWorkflow(data), /замечания/);
  data.inspection.video_status = 'Сделано';
  assert.doesNotThrow(() => validateWorkflow(data));
});

test('V5 hydration uses server evidence and preserves each original byte buffer', () => {
  const data = compactVisit();
  const evidence = data.evidence.map((file, i) => ({ ...file, buffer: Buffer.from('ORIGINAL_' + i) }));
  const draft = { id: randomUUID(), revision: 8, order_id: 58, data, evidence };
  const hydrated = hydrateDraftReport(draft);
  assert.equal(hydrated.documents.length, evidence.length);
  for (const [i, file] of hydrated.documents.entries()) assert.equal(file.source.toString(), 'ORIGINAL_' + i);
  assert.equal(hydrated.evidence.some(file => file.buffer), false);
  assert.deepEqual(hydrated.plan, data.plan);
  draft.evidence = evidence.filter(file => file.role !== 'entrance');
  assert.throws(() => hydrateDraftReport(draft), /фото входа/);
});

test('V5 report links the authenticated complete request page and lists originals without exposing internal download paths', () => {
  const previous = process.env.WEBAPP_URL;
  process.env.WEBAPP_URL = 'https://audit.example.test';
  try {
    const data = compactVisit();
    data.request_packet.contacts = JSON.stringify([{ name: 'Анна', phone: '+7 900 000-00-00' }]);
    data.request_packet.materials = [{ id: 'manager-doc', name: 'Договор аренды.pdf', url: '/api/audit/orders/58/materials/manager-doc' }];
    const text = buildWorkflowReport(data).plain.join('\n');
    assert.match(text, /Договор аренды.pdf/);
    assert.match(text, /Контакт: Анна · \+7 900 000-00-00/);
    assert.match(text, /Заявка и полный комплект документов: https:\/\/audit.example.test\/audit\?order_id=58/);
    assert.doesNotMatch(text, /\/api\/|Документы отправлены/);
  } finally { if (previous === undefined) delete process.env.WEBAPP_URL; else process.env.WEBAPP_URL = previous; }
});

test('compact report includes the auditor comment and territory supplement without dropping them', () => {
  const { compactVisit } = require('./helpers/audit-v5');
  const { buildWorkflowReport } = require('../src/bot/audit-workflow');
  const data = compactVisit();
  data.conclusion = 'Клиент просит перенести барную стойку.';
  data.workflow.territory_notes = 'Второй вход со двора.';
  const report = buildWorkflowReport(data);
  assert.match(report.plain.join('\n'), /Клиент просит перенести барную стойку/);
  assert.match(report.plain.join('\n'), /Второй вход со двора/);
});
