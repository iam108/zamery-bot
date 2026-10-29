const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('audit keeps structured answers and attachment roles without image base64', async () => {
  const queries = [];
  const context = { module: { exports: {} }, require(name) {
    if (name === '../db/pool') return { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    if (name === '../checklists') return {};
    throw new Error('Unexpected require: ' + name);
  } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/web/handoff.js'), 'utf8'), context);
  const data = { schema_version: 2, inspection: { service: 'Продление' }, photos: [{ name: 'plan.png', role: 'plan', data: 'PRIVATE_BASE64' }] };
  await context.module.exports.saveAudit(58, 'Отчёт', 10, [1, 2], data);
  const saved = JSON.parse(queries[0].params[4]);
  assert.equal(saved.inspection.service, 'Продление');
  assert.deepEqual(saved.photos, [{ name: 'plan.png', role: 'plan' }]);
  assert.equal(queries[0].params[4].includes('PRIVATE_BASE64'), false);
  assert.equal(data.photos[0].data, 'PRIVATE_BASE64');
});
