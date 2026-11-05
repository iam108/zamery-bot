const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { compactVisit, addOrganization } = require('./helpers/audit-v5');
const { normalizeWorkflow, validateWorkflow } = require('../src/bot/audit-workflow');
const source = fs.readFileSync(path.join(__dirname, '../src/web/audit-wizard-client.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function actualFunction(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name + ' is in the production client');
  const rest = source.slice(start), next = rest.slice(1).search(/\n  (?:(?:async )?function |var )/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
function harness(data = compactVisit()) {
  if (!data.workflow.territory_result) {
    data.workflow.territory_result = data.zones.length ? 'findings' : 'clear';
    if (data.zones.length) data.map.mode = 'draw';
    else data.map = { evidence_id: '', page: 1, annotations: [] };
  }
  const evidence = data.evidence; delete data.evidence;
  const calls = [], nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', outerHTML: '', textContent: '', disabled: false,
      querySelectorAll: () => [], scrollIntoView: () => calls.push(['scroll', selector]), focus: () => calls.push(['focus', selector]) });
    return nodes.get(selector);
  };
  const c = {
    state: { data, evidence, packet: data.request_packet, draft: { id: randomUUID(), revision: 10 }, version: 0, dirty: false,
      pendingUploads: 0, submitting: false, frozen: false, completed: false },
    root: { querySelector: node, querySelectorAll: () => [], innerHTML: '' },
    $: node, tail: Promise.resolve(), queuedJobs: 0, timer: null, clearTimeout, editor: null, tg: null, orderId: '58', localKey: 'synthetic-audit-submit-feedback', clone: copy,
    defaults: { map: { evidence_id: '', page: 1, annotations: [] } },
    OUTCOME_LABELS: { ready: 'Соответствует по проверенным пунктам', actions: 'Нужны действия', insufficient: 'Недостаточно данных', obstacle: 'Выявлено препятствие' },
    MAP_IMAGE_TYPES: ['image/jpeg','image/png'], ZONE_STATUS: { clear:'Без замечаний', licensed:'Есть сведения о лицензии', disputed:'Спорное место', confirmed:'Есть ограничение', pending:'Нужно уточнить', other:'Наблюдение' },
    esc: value => String(value == null ? '' : value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    document: { body: { classList: { add() {}, remove() {} } } },
    localStorage: { removeItem() {}, setItem() {} },
    set(key, value) { const parts = key.split('.'); let object = c.state.data; while (parts.length > 1) object = object[parts.shift()]; object[parts[0]] = value; },
    changed() { c.state.dirty = true; c.state.version++; }, localSave() {}, refreshChrome() {}, render() {},
    notify: message => calls.push(['notify', message]), status() {}, timeLabel: () => '12:00',
    flush: async () => calls.push(['flush']), checkSubmissionState: async () => {},
    exportGraphic: async (drawing, kind) => ({ name: kind + '.png', mime: 'image/png', role: kind, data: 'synthetic-preview' }),
    postEvidence: async (file, role, subject) => {
      const result = { id: randomUUID(), name: file.name, mime: file.type, role, subject_id: subject };
      c.state.evidence.push(result); c.state.draft.revision++; return result;
    },
    request: async (url, options) => {
      calls.push(['request', url]);
      if (options?.method === 'DELETE') return { ok: true, revision: c.state.draft.revision + 1 };
      assert.equal(url, '/api/audit');
      // The server's real validator must accept the exact facts and generated
      // evidence after the actual browser submission path has prepared them.
      validateWorkflow(normalizeWorkflow({ ...copy(c.state.data), evidence: copy(c.state.evidence) }));
      return { ok: true };
    },
  };
  vm.createContext(c);
  vm.runInContext(['updateClosingConfirmation','setOutcome','queue','isRenewal','packetFiles','evidenceFor','adoptRevision','removeGeneratedEvidence','mapMode','rememberTerritory','switchTerritoryMode','chooseTerritory','hasEvidenceImage','validDistance','territoryIssues','issues','tasksHtml',
    'offersActions','reportFeedback','bindReportFeedback','refreshReportFeedback','chooseConclusion','showReportIssues','reportPreview','submit'].map(actualFunction).join('\n'), c);
  return { c, calls, node };
}

test('a contradictory positive result shows the exact missing-area answer beside submission, not a hidden generic warning', async () => {
  const data = compactVisit('catering', 'Продление');
  data.inspection.rooms_complete = 'Нет'; data.inspection.alcohol_present = 'Да'; data.inspection.alcohol_within_licensed = 'Да';
  data.conclusion = 'Помещение без изменений с последней проверки.';
  const { c, calls, node } = harness(data), before = copy(c.state.data);
  const tasks = c.issues(), html = c.reportFeedback(tasks);
  assert.equal(tasks.length, 1); assert.equal(tasks[0].key, 'rooms-incomplete');
  assert.match(html, /Не вся площадь по выбранному плану входит в объект/);
  assert.match(html, /data-go-step="1"/); assert.match(html, /Помещение →/);
  assert.match(html, /data-conclusion-choice="actions"/); assert.match(html, /data-conclusion-choice="insufficient"/);
  assert.doesNotMatch(html, /<details|\shidden(?:>|\s)/);
  await c.submit();
  assert.deepEqual(copy(c.state.data), before, 'Blocking submission cannot rewrite the auditor observations');
  assert.equal(c.state.completed, false); assert.equal(c.state.submitting, false);
  assert.ok(!calls.some(item => item[0] === 'request'));
  assert.ok(calls.some(item => item[0] === 'focus' && item[1] === '#report-feedback'));
  assert.match(node('#report-feedback').outerHTML, /Часть не входит/);
});

test('a blocked positive result does not create a stale positive comment before the auditor chooses another outcome', async () => {
  const data = compactVisit(); data.inspection.rooms_complete = 'Нет'; data.conclusion = '';
  const { c } = harness(data); await c.submit();
  assert.equal(c.state.data.conclusion, '');
});

for (const previous of ['', 'ready']) test('sending with findings keeps the truthful acquisition answers and comment from ' + (previous || 'an unset outcome'), async () => {
  const data = compactVisit();
  data.inspection.alcohol_present = 'Да';
  data.to = 'Нужно';
  data.conclusion = 'Зон нет. Алкоголь есть, ТО нужно.';
  data.workflow.conclusion_status = previous;
  const { c, calls, node } = harness(data);
  c.refreshReportFeedback();
  assert.equal(node('#submit-audit').textContent, 'Отправить с замечаниями');
  assert.equal(node('#submit-outcome').hidden, false);
  await c.submit('actions');
  assert.equal(c.state.completed, true);
  assert.equal(calls.filter(([name, url]) => name === 'request' && url === '/api/audit').length, 1);
  assert.equal(c.state.data.workflow.conclusion_status, 'actions');
  assert.equal(c.state.data.inspection.alcohol_present, 'Да');
  assert.equal(c.state.data.to, 'Нужно');
  assert.equal(c.state.data.building_type, 'Жилое');
  assert.equal(c.state.data.conclusion, 'Зон нет. Алкоголь есть, ТО нужно.');
});

for (const outcome of ['actions', 'insufficient']) test('explicitly choosing ' + outcome + ' preserves observations and requires a separate Send click', async () => {
  const data = compactVisit(); data.inspection.rooms_complete = 'Нет'; data.conclusion = 'Часть площади занята соседями.';
  const { c, calls, node } = harness(data), before = copy(c.state.data);
  c.chooseConclusion(outcome); before.workflow.conclusion_status = outcome;
  assert.deepEqual(copy(c.state.data), before);
  assert.ok(!calls.some(item => item[0] === 'request'));
  assert.equal(node('[data-bind="workflow.conclusion_status"]').value, outcome);
  assert.doesNotMatch(node('#report-feedback').outerHTML, /data-conclusion-choice=/);
  assert.match(node('.report-preview').outerHTML, /Часть площади занята соседями/);
  await c.submit();
  assert.equal(c.state.completed, true, JSON.stringify(calls));
  assert.equal(calls.filter(item => item[0] === 'request' && item[1] === '/api/audit').length, 1);
  assert.equal(c.state.data.inspection.rooms_complete, 'Нет');
});

test('correcting the area answer explicitly permits a positive report with otherwise complete facts', async () => {
  const data = compactVisit(); data.inspection.rooms_complete = 'Нет'; const { c, calls } = harness(data);
  assert.ok(c.issues().some(item => item.key === 'rooms-incomplete'));
  c.state.data.inspection.rooms_complete = 'Да';
  assert.equal(c.issues().length, 0); await c.submit();
  assert.equal(c.state.completed, true);
  assert.equal(calls.filter(item => item[0] === 'request' && item[1] === '/api/audit').length, 1);
  assert.equal(c.state.data.workflow.conclusion_status, 'ready');
});

test('decimal-comma measurements accepted by the server are not falsely blocked in the browser', async () => {
  const data = addOrganization(compactVisit());
  data.map.annotations.push({ id: 'measurement', tool: 'straight', code: 'М1', distance: '12,5',
    fromEntranceId: data.entrances[0].id, toObjectId: data.zones[0].id, points: [{ x: .2, y: .3 }, { x: .8, y: .4 }] });
  data.zones[0].dist = '12,5'; const { c } = harness(data);
  assert.equal(c.issues().length, 0); await c.submit(); assert.equal(c.state.completed, true);
});

test('clear territory keeps entrance evidence, omits map export, and requires the explicit outcome', async () => {
  const { c, calls } = harness();
  delete c.state.data.workflow.territory_result;
  await c.submit();
  assert.equal(c.state.completed, false);
  assert.match(calls.find(([action]) => action === 'notify')[1], /Выберите результат проверки территории/);
  c.chooseTerritory('clear');
  c.exportGraphic = async (_drawing, kind) => {
    assert.equal(kind, 'plan');
    return { name: 'plan.png', mime: 'image/png', role: 'plan', data: 'synthetic-preview' };
  };
  await c.submit();
  assert.equal(c.state.completed, true);
});

test('switching modes preserves the drawn draft and manual entrance photos', () => {
  const data = addOrganization(compactVisit());
  const { c } = harness(data);
  const drawn = copy(c.state.data.map), drawZones = copy(c.state.data.zones);
  c.chooseTerritory('clear');
  assert.deepEqual(copy(c.state.data.zones), []);
  assert.equal(c.state.data.map.evidence_id, '');
  c.state.data.entrances[0].label = 'Боковой вход';
  c.chooseTerritory('findings');
  assert.deepEqual(copy(c.state.data.map), drawn);
  assert.deepEqual(copy(c.state.data.zones), drawZones);
  c.switchTerritoryMode('attached');
  assert.equal(c.state.data.entrances[0].label, 'Боковой вход');
  assert.equal(c.hasEvidenceImage('entrance', c.state.data.entrances[0].id), true);
  assert.deepEqual(copy(c.state.data.map.annotations), []);
});

test('archive originals uploaded with auditor evidence count just like archive documents in the request', async () => {
  const data = compactVisit('catering', 'Продление'); data.evidence.push(...data.request_packet.materials); data.request_packet.materials = [];
  const { c } = harness(data); assert.equal(c.issues().length, 0); await c.submit(); assert.equal(c.state.completed, true);
});

test('unchecked archive comparison and uninspected entrances remain visible before a positive submission', () => {
  const data = compactVisit('catering', 'Продление'); data.inspection.archive_match = 'Не проверено'; data.entrances[0].access = 'Не осмотрен';
  const { c } = harness(data), tasks = c.issues();
  assert.ok(tasks.some(item => item.key === 'archive-unchecked'));
  assert.ok(tasks.some(item => item.key === 'entrance-' + data.entrances[0].id));
  assert.match(c.reportFeedback(tasks), /Сверка с архивом не выполнена/);
  assert.match(c.reportFeedback(tasks), /осмотр не завершён/);
});

test('hidden renewal and extra-cadastral answers do not block an acquisition with one cadastral unit', () => {
  const data = compactVisit(); Object.assign(data.inspection, { archive_match: 'Нет', licensed_boundaries_match: 'Нет', inter_cadastral_boundary: 'Объединены' });
  const { c } = harness(data); assert.equal(c.issues().length, 0);
});

test('quick outcome buttons stay inert for a frozen report and the issue action opens its named section', () => {
  const { c } = harness(), before = copy(c.state.data); c.state.frozen = true;
  c.chooseConclusion('actions'); assert.deepEqual(copy(c.state.data), before);
  const outcomeButton = { dataset: { conclusionChoice: 'insufficient' } }, sectionButton = { dataset: { goStep: '1' } }, events = [];
  c.chooseConclusion = value => events.push(['choice', value]); c.go = value => events.push(['section', value]);
  c.bindReportFeedback({ querySelectorAll: selector => selector === '[data-conclusion-choice]' ? [outcomeButton] : [sectionButton] });
  outcomeButton.onclick(); sectionButton.onclick();
  assert.deepEqual(events, [['choice', 'insufficient'], ['section', 1]]);
});

test('the area question distinguishes a missing part of the premises from a removed internal partition', () => {
  const { c } = harness(); c.activePlanId = 'main'; c.heading = () => ''; c.managerFilesHtml = () => ''; c.evidenceBlock = () => '';
  c.input = label => label; c.choices = (path, label, options) => label + options.map(item => item[1]).join(' ');
  vm.runInContext(actualFunction('insideStep'), c);
  const html = c.insideStep();
  assert.match(html, /Вся площадь по плану входит в объект/);
  assert.match(html, /часть площади отрезана или занята соседями/);
  assert.match(html, /убрана только внутренняя перегородка/);
  assert.doesNotMatch(html, /Все комнаты по плану на месте/);
});
