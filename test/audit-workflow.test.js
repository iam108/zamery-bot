const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkflow, validateWorkflow, buildWorkflowReport, followupTasks, hydrateDraftReport } = require('../src/bot/audit-workflow');

function draft(changes = {}) {
  return normalizeWorkflow({ schema_version: 3, object_category: 'catering', inspection: { org: 'Объект', address: 'Адрес', service: 'Получение' }, workflow: { step: 6, conclusion_status: 'insufficient' }, entrances: [], zones: [], conclusion: 'Нужна дополнительная проверка', ...changes });
}

test('incomplete visit remains reportable but unknowns cannot produce a positive result', () => {
  const data = draft();
  assert.doesNotThrow(() => validateWorkflow(data));
  assert.ok(followupTasks(data).some(t => t.id === 'entrances'));
  assert.equal(data.inspection.alcohol_present, 'Не проверено');
  data.workflow.conclusion_status = 'ready';
  assert.throws(() => validateWorkflow(data), /открытые вопросы/);
});

test('acquisition drops stale renewal answers; draft original remains unchanged', () => {
  const source = draft(); source.inspection.archive_available = 'Да'; source.inspection.archive_match = 'Да'; source.inspection.archive_url = 'https://disk.example/archive'; source.inspection.alcohol_within_licensed = 'Да';
  const data = normalizeWorkflow(source);
  assert.equal(data.inspection.archive_available, undefined);
  assert.equal(data.inspection.alcohol_within_licensed, undefined);
  assert.equal(source.inspection.archive_available, 'Да');
});

test('uncertain neighbor retains entrance, distance and evidence context without automatic threshold', () => {
  const data = draft({ entrances: [{ id: 'e1', label: 'Со двора', access: 'Нет доступа', facing: 'Во двор' }], zones: [{ id: 'z1', name: '<Клиника>', status: 'pending', entrance_id: 'e1', dist: '17.5', method: 'Пеший путь', points: 'Вход 1 → ворота', source: '', resolution: '' }], evidence: [{ id: 'f1', role: 'zone', subject_id: 'z1', name: 'вывеска.jpg' }] });
  const result = buildWorkflowReport(data);
  assert.match(result.plain.join('\n'), /Требует уточнения/);
  assert.match(result.plain.join('\n'), /вывеска.jpg/);
  assert.match(result.plain.join('\n'), /Со двора/);
  assert.match(result.html.join('\n'), /&lt;Клиника&gt;/);
  assert.doesNotMatch(result.plain.join('\n'), /зон нет|лицензия возможна/i);
  data.zones[0].status = 'excluded';
  assert.throws(() => validateWorkflow(data), /основание и источник/);
});

test('plan overlay rejects malformed coordinates and unrecognized wall classifications', () => {
  const data = draft({ plan: { annotations: [{ tool: 'structural', points: [{ x: 0, y: 0 }, { x: 2, y: 1 }] }] } });
  assert.throws(() => validateWorkflow(data), /разметка/);
  data.plan.annotations[0].points[1].x = 1;
  assert.doesNotThrow(() => validateWorkflow(data));
  data.plan.annotations[0].tool = 'confirmed-bearing-by-ai';
  assert.throws(() => validateWorkflow(data), /разметка/);
});

test('hydrated report retains original bytes outside structured evidence metadata', () => {
  const source = Buffer.from('original uncompressed bytes');
  const data = hydrateDraftReport({ id: 'draft-id', order_id: 58, revision: 5, data: draft(), evidence: [{ id: 'file', name: 'план.pdf', mime: 'application/pdf', role: 'plan', subject_id: 'source', buffer: source }] });
  assert.equal(data.documents[0].source, source);
  assert.equal(data.evidence[0].buffer, undefined);
  assert.equal(data.submit_id, 'draft:draft-id:5');
  assert.deepEqual(data.photos, []);
});
