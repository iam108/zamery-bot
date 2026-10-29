const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/web/handoff.js'), 'utf8');
function loadServer(audit) {
  const context = { module: { exports: {} }, require(name) {
    if (name === '../db/pool') return { query: async () => ({ rows: [audit] }) };
    if (name === '../checklists') return {};
    throw new Error('Unexpected require: ' + name);
  } };
  vm.createContext(context);
  vm.runInContext(source + '\nmodule.exports.testMetadata = auditMetadata; module.exports.testGetReport = getReport; module.exports.testClient = handoffClient;', context);
  return context.module.exports;
}

test('structured audit service wins over unrelated service words in report text', () => {
  const server = loadServer();
  const metadata = server.testMetadata({ report_data: { inspection: {
    service: 'Продление', org: 'ООО Объект', address: 'Адрес'
  } }, text: 'Получение документов\nУслуга: Получение' });
  assert.equal(metadata.service, 'Продление');
  assert.equal(metadata.org, 'ООО Объект');
  assert.equal(metadata.address, 'Адрес');
});

test('legacy service fallback prefers explicit field, including after a long address', () => {
  const server = loadServer();
  assert.equal(server.testMetadata({ text: 'Получение документов\n' + 'Адрес '.repeat(100) + '\nУслуга: Продление\n' }).service, 'Продление');
  assert.equal(server.testMetadata({ text: 'Общепит · Москва · Продление' }).service, 'Продление');
  assert.equal(server.testMetadata({ text: 'Отчёт аудитора' }).service, '');
  assert.equal(server.testMetadata({ report_data: JSON.stringify({ inspection: { service: 'Переоформление' } }) }).service, 'Переоформление');
});

test('audit document lookup returns service metadata for report selection from search', async () => {
  const server = loadServer({ chat_id: 10, msg_ids: [5], text: 'Отчёт', report_data: { inspection: { service: 'Продление' } } });
  const report = await server.testGetReport('a', 7);
  assert.equal(report.metadata.service, 'Продление');
});

test('order prefill and report selection preserve renewal through the client callback', async () => {
  const server = loadServer();
  const client = server.testClient.toString();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, textContent: '', className: '', innerHTML: '', children: [], appendChild() {} });
    return elements.get(id);
  };
  const report = { src: 'a', id: 7, text: 'Организация: Объект\nУслуга: Продление', created_at: '2026-10-29', metadata: { service: 'Продление' } };
  const context = { S: { service: 'Получение', priority: 'обычный' }, REP: null, orderId: 58, requestId: '',
    $: element, parseContacts: () => [], addContact() {}, search() {}, PHONE_RE: /test/g,
    tg: { HapticFeedback: { selectionChanged() {} } },
    preview: t => String(t), fmtDate: () => '29.10.26',
    document: { createElement: () => ({}), querySelectorAll: () => [] },
    fetch: async url => ({ json: async () => url.startsWith('/api/reports/get')
      ? { ok: true, text: report.text, metadata: report.metadata }
      : { lawyers: [], order: { id: 58, owner: 'Клиент', name: 'Объект', address: 'Адрес', contacts: '', region: 'МСК', kind: 'Общепит' }, report } }),
  };
  context.mark = (key, value) => { context.S[key] = value; };
  vm.createContext(context);
  const helper = client.slice(client.indexOf('  function applyReportMetadata('), client.indexOf('  // ── Контакты:'));
  const fill = client.slice(client.indexOf('  function fillFrom('), client.indexOf("  $('chosen-x').onclick"));
  const prefill = client.slice(client.indexOf("  fetch('/api/handoff/prefill?"), client.indexOf('  window.send ='));
  vm.runInContext(helper + '\n' + fill + '\n' + prefill, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.S.service, 'Продление');
  // A new report picked from search must prefer authoritative structured metadata.
  const next = { src: 'a', id: 8, text: 'Услуга: Получение', metadata: { service: 'Продление' } };
  vm.runInContext('choose(' + JSON.stringify(next) + ');', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.S.service, 'Продление');
});
