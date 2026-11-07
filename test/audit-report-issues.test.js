const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { compactVisit, addOrganization } = require('./helpers/audit-v5');
const { compactReportIssues, followupTasks, validateWorkflow, normalizeWorkflow, hydrateDraftReport, buildWorkflowReport } = require('../src/bot/audit-workflow');
const { describe } = require('../public/audit-report-issues');
const clone = value => JSON.parse(JSON.stringify(value));

for (const [category, service] of [['catering', 'Получение'], ['retail', 'Получение'], ['tobacco', ''], ['catering', 'Продление']]) test('a complete checked '+category+'/'+service+' report has no invented contradiction', () => {
  const data = compactVisit(category, service);
  assert.deepEqual(compactReportIssues(data), []); assert.doesNotThrow(() => validateWorkflow(data));
});

const adverse = [
  ['rooms-incomplete', 'inspection.rooms_complete', data => { data.inspection.rooms_complete = 'Нет'; }, /Часть не входит/],
  ['cadastral-boundaries', 'inspection.within_cadastral', data => { data.inspection.within_cadastral = 'Нет'; }, /нарушение внешних границ/],
  ['inter-cadastral', 'inspection.inter_cadastral_boundary', data => { data.inspection.cadastral_count = '2'; data.inspection.inter_cadastral_boundary = 'Объединены'; }, /2 кадастров объединены/],
  ['floor-mismatch', 'inspection.floor_actual', data => { data.inspection.floor_actual = '2'; }, /на плане: «1»; фактически: «2»/],
  ['plan-mismatch', 'bti', data => { data.bti = 'Нет'; data.inspection.plan_note = 'Убрана внутренняя перегородка'; }, /Убрана внутренняя перегородка/],
  ['technical-description', 'to', data => { data.to = 'Нужно'; }, /требуется техническое описание/],
  ['alcohol-new', 'inspection.alcohol_present', data => { data.inspection.alcohol_present = 'Да'; }, /рабочему правилу команды/],
];
for (const [id, control, change, reason] of adverse) test('the server diagnoses '+id+' precisely and never rewrites the recorded answer or outcome', () => {
  const data = compactVisit(); change(data); const before = clone(data), oldTasks = followupTasks(data);
  const issue = compactReportIssues(data).find(item => item.id === id);
  assert.ok(issue); assert.equal(issue.kind, 'adverse'); assert.equal(issue.control, control); assert.equal(issue.step, 1);
  assert.equal(issue.suggested_conclusion, 'actions'); assert.equal(issue.blocks_submission, false); assert.match(issue.reason, reason); assert.match(issue.action, /выберите «Нужны действия»/);
  assert.throws(() => validateWorkflow(data), error => error.code === 'AUDIT_CONCLUSION_CONFLICT' && error.issues.some(item => item.id === id) && reason.test(error.message));
  assert.deepEqual(data, before); assert.deepEqual(followupTasks(data), oldTasks); assert.deepEqual(Object.keys(oldTasks.find(item => item.id === id)).sort(), ['id', 'label']);
  for (const outcome of ['actions', 'insufficient', 'obstacle']) { data.workflow.conclusion_status = outcome; assert.doesNotThrow(() => validateWorkflow(data)); assert.equal(data.workflow.conclusion_status, outcome); }
});

test('missing area is distinguished from a changed internal partition and benign answers stay benign', () => {
  const data = compactVisit(); data.inspection.rooms_complete = 'Нет';
  const issue = compactReportIssues(data).find(item => item.id === 'rooms-incomplete');
  assert.match(issue.action, /внутренняя перегородка.*изменение планировки/);
  data.inspection.rooms_complete = 'Да'; data.bti = 'Нет'; data.inspection.plan_note = 'Убрана внутренняя перегородка';
  assert.ok(!compactReportIssues(data).some(item => item.id === 'rooms-incomplete'));
  assert.ok(compactReportIssues(data).some(item => item.id === 'plan-mismatch'));
  data.bti = 'Да'; data.inspection.cadastral_count = '2'; data.inspection.inter_cadastral_boundary = 'Сохранена';
  data.inspection.kkt_ip = 'Да'; data.inspection.kkt_count = '2'; assert.deepEqual(compactReportIssues(data), []);
});

test('client review text, a cleared local task list and a stale category cannot waive a recorded ready contradiction', () => {
  const data = compactVisit(); data.inspection.rooms_complete = 'Нет'; data.object_category = 'other'; data.tasks = [];
  data.workflow.followup_notes = 'Всё согласовано'; data.workflow.mitigation = 'Можно отправлять'; data.workflow.reviewed_issues = 'rooms-incomplete';
  const normalized = normalizeWorkflow(data); assert.equal(normalized.object_category, 'catering');
  assert.throws(() => validateWorkflow(normalized), error => error.code === 'AUDIT_CONCLUSION_CONFLICT' && error.issues.some(issue => issue.id === 'rooms-incomplete'));
  assert.equal(normalized.inspection.rooms_complete, 'Нет'); assert.equal(normalized.workflow.conclusion_status, 'ready');
});

test('unknown floors, archive and alcohol remain unverified rather than a recorded adverse condition', () => {
  const data = compactVisit('catering', 'Продление');
  data.inspection.floor_plan = data.inspection.floor_actual = 'Не проверено'; data.inspection.archive_match = 'Не проверено';
  data.inspection.licensed_boundaries_match = 'Не проверено'; data.inspection.alcohol_present = 'Да'; data.inspection.alcohol_within_licensed = 'Не проверено';
  const issues = compactReportIssues(data), ids = issues.map(item => item.id);
  for (const id of ['unverified:floor_plan', 'unverified:floor_actual', 'archive-unchecked', 'licensed-boundaries-unchecked', 'alcohol-zone']) {
    const issue = issues.find(item => item.id === id); assert.ok(issue); assert.equal(issue.kind, 'unverified'); assert.equal(issue.suggested_conclusion, 'insufficient');
  }
  assert.ok(!ids.includes('floor-mismatch')); assert.ok(!ids.includes('alcohol-new'));
  assert.throws(() => validateWorkflow(data), error => error.code === 'AUDIT_CONCLUSION_CONFLICT' && error.issues.length === 5);
  data.workflow.conclusion_status = 'insufficient'; assert.doesNotThrow(() => validateWorkflow(data));
  data.inspection.alcohol_within_licensed = 'Нет'; assert.equal(compactReportIssues(data).find(item => item.id === 'alcohol-zone').kind, 'adverse');
});

test('renewal with alcohol inside its confirmed zone and reissue do not inherit the acquisition action', () => {
  for (const service of ['Продление', 'Переоформление']) {
    const data = compactVisit('catering', service); data.inspection.alcohol_present = 'Да'; data.inspection.alcohol_within_licensed = 'Да';
    assert.deepEqual(compactReportIssues(data), []); assert.doesNotThrow(() => validateWorkflow(data));
  }
});

test('a single unverified floor is not presented as a confirmed discrepancy', () => {
  const data = compactVisit(); data.inspection.floor_actual = 'Не проверено'; const issues = compactReportIssues(data);
  assert.equal(issues.length, 1); assert.equal(issues[0].id, 'unverified:floor_actual'); assert.equal(issues[0].kind, 'unverified');
  assert.equal(describe(data, { id: 'floor-mismatch' }).kind, 'unverified');
});

test('tobacco observations distinguish actual adverse, unverified and a required unanswered control', () => {
  const data = compactVisit('tobacco', '');
  for (const value of ['Нет', 'Не проверено', '']) {
    data.inspection.tobacco_price_list = value;
    const issue = compactReportIssues(data).find(item => item.control === 'inspection.tobacco_price_list'); assert.ok(issue);
    assert.equal(issue.kind, value === 'Нет' ? 'adverse' : value === 'Не проверено' ? 'unverified' : 'missing_required');
    assert.equal(issue.blocks_submission, !value);
    data.workflow.conclusion_status = 'actions'; if (!value) assert.throws(() => validateWorkflow(data), /перечня цен/); else assert.doesNotThrow(() => validateWorkflow(data));
  }
});

test('missing required photos and annotated originals cannot be waived by changing the conclusion', () => {
  for (const remove of ['entrance', 'plan-source', 'plan']) {
    const data = compactVisit(); data.evidence = data.evidence.filter(file => file.role !== remove);
    const issue = compactReportIssues(data).find(item => item.kind === 'missing_required'); assert.ok(issue); assert.equal(issue.blocks_submission, true); assert.equal(issue.suggested_conclusion, null);
    for (const outcome of ['ready', 'actions', 'insufficient', 'obstacle']) { data.workflow.conclusion_status = outcome; assert.throws(() => validateWorkflow(data)); }
  }
});

test('skipping a missing archive leaves an honest question while a missing required video remains blocking', () => {
  const data = compactVisit('catering', 'Продление'); data.request_packet.materials = [];
  assert.ok(compactReportIssues(data).some(item => item.id === 'required:workflow.archive_skipped'));
  data.workflow.archive_skipped = 'Да'; const skipped = compactReportIssues(data).find(item => item.id === 'archive-skipped'); assert.equal(skipped.kind, 'unverified'); assert.equal(skipped.blocks_submission, false);
  data.workflow.conclusion_status = 'insufficient'; assert.doesNotThrow(() => validateWorkflow(data));
  data.request_packet.video_required = true; assert.ok(compactReportIssues(data).some(item => item.id === 'required:workflow.video_url' && item.blocks_submission));
  assert.throws(() => validateWorkflow(data), /Менеджер запросил видео/);
});

for (const status of ['pending', 'disputed', 'confirmed']) test('a '+status+' neighbor retains its own stable control and factual status', () => {
  const data = addOrganization(compactVisit(), { id: 'neighbor-7', name: 'Соседняя организация', status, note: 'Записанное наблюдение' });
  const issue = compactReportIssues(data).find(item => item.id === 'zone:neighbor-7'); assert.ok(issue);
  assert.equal(issue.control, 'zones.neighbor-7.status'); assert.equal(issue.section, 'territory'); assert.equal(issue.kind, status === 'confirmed' ? 'adverse' : 'unverified');
  assert.match(issue.reason, /Соседняя организация/); assert.match(issue.reason, /Записанное наблюдение/);
  assert.doesNotMatch(issue.reason, /автоматическ|закон|лицензия невозможна|запрещено/);
});

test('browser and server share the exact diagnosis without browser dependencies or input mutation', () => {
  const source = fs.readFileSync(require.resolve('../public/audit-report-issues'), 'utf8'), context = vm.createContext({ window: {} }); vm.runInContext(source, context);
  const data = compactVisit(); data.inspection.rooms_complete = 'Нет'; const before = clone(data), task = followupTasks(data)[0];
  const server = describe(data, task), browser = context.window.AuditReportIssues.describe(clone(data), clone(task));
  assert.deepEqual(clone(browser), server); assert.deepEqual(data, before); assert.equal(describe(data, { id: 'unrecognized-task' }), null);
  const custom = describe(data, { id: task.id, label: 'Browser display label' }); assert.equal(custom.reason, server.reason); assert.equal(custom.control, server.control);
});

test('the compact diagnosis does not impose alcohol or plan obligations on generic and legacy audits', () => {
  assert.deepEqual(compactReportIssues({ ui_version: 5, object_category: 'other', inspection: {} }), []);
  assert.deepEqual(compactReportIssues({ ui_version: 4, inspection: {} }), []); assert.deepEqual(compactReportIssues(null), []);
});

test('only a trusted legacy-delivery option preserves an older accepted pair of unknown floor answers', () => {
  const data = compactVisit(); data.inspection.floor_plan = data.inspection.floor_actual = 'Не проверено';
  const before = clone(data), option = { legacyDelivery: true };
  assert.throws(() => validateWorkflow(data), error => error.code === 'AUDIT_CONCLUSION_CONFLICT');
  assert.doesNotThrow(() => validateWorkflow(data, option)); assert.deepEqual(data, before);
  assert.deepEqual(compactReportIssues(data).map(issue => issue.id), ['unverified:floor_plan', 'unverified:floor_actual']);
  for (const spoof of [{ legacyDelivery: true }, { workflow: { ...data.workflow, legacyDelivery: 'true' } }]) {
    assert.throws(() => validateWorkflow({ ...data, ...spoof }), error => error.code === 'AUDIT_CONCLUSION_CONFLICT');
  }
  assert.throws(() => validateWorkflow(data, { legacyDelivery: 'true' }), error => error.code === 'AUDIT_CONCLUSION_CONFLICT');
});

test('legacy delivery still rejects every earlier adverse answer and required missing photo', () => {
  const data = compactVisit(); data.inspection.floor_plan = data.inspection.floor_actual = 'Не проверено';
  const option = { legacyDelivery: true }; data.inspection.rooms_complete = 'Нет';
  assert.throws(() => validateWorkflow(data, option), error => error.code === 'AUDIT_CONCLUSION_CONFLICT' && error.issues.some(issue => issue.id === 'rooms-incomplete'));
  data.inspection.rooms_complete = 'Да'; data.inspection.floor_actual = '1';
  assert.throws(() => validateWorkflow(data, option), error => error.code === 'AUDIT_CONCLUSION_CONFLICT' && error.issues.some(issue => issue.id === 'floor-mismatch'));
  data.inspection.floor_actual = 'Не проверено'; data.evidence = data.evidence.filter(file => file.role !== 'entrance');
  assert.throws(() => validateWorkflow(data, option), /Добавьте фото входа/);
});

test('hydration and complete report rendering forward only the internal legacy validation option', () => {
  const data = compactVisit(); data.inspection.floor_plan = data.inspection.floor_actual = 'Не проверено';
  const option = { legacyDelivery: true }, snapshot = { id: 'old-frozen-draft', order_id: 58, revision: 4, data, evidence: data.evidence.map(file => ({ ...file, buffer: Buffer.from('retained original') })) };
  assert.throws(() => hydrateDraftReport(snapshot), error => error.code === 'AUDIT_CONCLUSION_CONFLICT');
  const hydrated = hydrateDraftReport(snapshot, option); assert.equal(hydrated.inspection.floor_plan, 'Не проверено'); assert.equal(hydrated.documents[0].source.toString(), 'retained original');
  assert.throws(() => buildWorkflowReport(hydrated), error => error.code === 'AUDIT_CONCLUSION_CONFLICT');
  assert.match(buildWorkflowReport(hydrated, option).plain.join('\n'), /Соответствует по проверенным пунктам/);
  assert.equal(hydrated.legacyDelivery, undefined); assert.equal(snapshot.data.legacyDelivery, undefined);
});
