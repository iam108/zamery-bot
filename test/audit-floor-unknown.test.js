const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { compactVisit } = require('./helpers/audit-v5');
const { compactReportIssues, validateWorkflow } = require('../src/bot/audit-workflow');
const rules = require('../public/audit-report-issues');

const copy = value => JSON.parse(JSON.stringify(value));
function clientIssues(data) {
  const source = fs.readFileSync(require.resolve('../src/web/audit-wizard-client'), 'utf8');
  const start = source.indexOf('  function issues(){'), end = source.indexOf('\n  function requiredIssues(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    window: { AuditReportIssues: rules }, URL,
    state: { data: copy(data), packet: copy(data.request_packet), evidence: copy(data.evidence) },
    territoryIssues() {}, isRenewal: () => data.inspection.service === 'Продление', packetFiles: () => data.request_packet.materials || [],
  });
  vm.runInContext(source.slice(start, end), context);
  return Array.from(context.issues(), item => ({ key: item.key, title: item.title }));
}

for (const text of ['не проверено', 'НЕ ПРОВЕРЕНО', '  Не\t проверено  ']) test('free-text unverified floors cannot become a ready report: '+JSON.stringify(text), () => {
  const data = compactVisit(); data.inspection.floor_plan = data.inspection.floor_actual = text;
  const before = copy(data), issues = compactReportIssues(data);
  assert.deepEqual(issues.map(issue => issue.id), ['unverified:floor_plan', 'unverified:floor_actual']);
  assert.ok(issues.every(issue => issue.kind === 'unverified' && issue.suggested_conclusion === 'insufficient'));
  assert.throws(() => validateWorkflow(data), error => error.code === 'AUDIT_CONCLUSION_CONFLICT');
  assert.deepEqual(clientIssues(data).map(issue => issue.key), ['unverified:floor_plan', 'unverified:floor_actual']);
  assert.equal(rules.describe(data, { id:'floor-mismatch' }).kind, 'unverified');
  assert.deepEqual(data, before, 'Recorded floor strings and conclusion must remain unchanged');
  data.workflow.conclusion_status = 'insufficient'; assert.doesNotThrow(() => validateWorkflow(data));
});

test('one unchecked free-text floor is a question rather than a confirmed floor discrepancy', () => {
  const data = compactVisit(); data.inspection.floor_actual = 'не проверено';
  const issues = compactReportIssues(data); assert.equal(issues.length, 1);
  assert.equal(issues[0].id, 'unverified:floor_actual'); assert.equal(issues[0].kind, 'unverified');
  assert.deepEqual(clientIssues(data).map(issue => issue.key), ['unverified:floor_actual']);
  assert.throws(() => validateWorkflow(data), error => error.code === 'AUDIT_CONCLUSION_CONFLICT');
});

test('trusted older deliveries keep their former matching-floor behavior without waiving a known unequal floor', () => {
  for (const text of ['не проверено', 'НЕ ПРОВЕРЕНО', '  Не\t проверено  ']) {
    const data = compactVisit(); data.inspection.floor_plan = data.inspection.floor_actual = text;
    const before = copy(data); assert.doesNotThrow(() => validateWorkflow(data, { legacyDelivery:true }));
    assert.deepEqual(data, before); data.inspection.floor_actual = '1';
    assert.throws(() => validateWorkflow(data, { legacyDelivery:true }), error => error.code === 'AUDIT_CONCLUSION_CONFLICT' && error.issues.some(issue => issue.id === 'floor-mismatch'));
  }
});

test('ordinary matching and unequal known floor values retain their existing meaning', () => {
  const data = compactVisit(); assert.deepEqual(compactReportIssues(data), []); assert.deepEqual(clientIssues(data), []);
  assert.doesNotThrow(() => validateWorkflow(data)); data.inspection.floor_actual = '2 этаж';
  assert.equal(compactReportIssues(data)[0].id, 'floor-mismatch'); assert.equal(compactReportIssues(data)[0].kind, 'adverse');
  assert.deepEqual(clientIssues(data).map(issue => issue.key), ['floor-mismatch']);
});
