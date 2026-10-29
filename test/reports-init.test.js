const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadInitializer(client) {
  let connections = 0;
  const context = { module: { exports: {} }, require(name) {
    if (name === '../db/pool') return { connect: async () => { connections++; return client; } };
    if (name === '../checklists') return {};
    throw new Error('Unexpected require: ' + name);
  } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../src/web/handoff.js'), 'utf8');
  vm.runInContext(source + '\nmodule.exports.testInitialize = ensureReports;', context);
  return { initialize: context.module.exports.testInitialize, connections: () => connections };
}

test('concurrent report initialization shares one transaction and locks before DDL', async () => {
  const queries = [];
  let released = 0;
  const h = loadInitializer({ query: async sql => { queries.push(sql); }, release: () => { released++; } });
  await Promise.all([h.initialize(), h.initialize(), h.initialize()]);
  await h.initialize();
  assert.equal(h.connections(), 1);
  assert.equal(queries[0], 'BEGIN');
  assert.equal(queries[1], 'SELECT pg_advisory_xact_lock(108, 1)');
  assert.match(queries[2], /CREATE TABLE IF NOT EXISTS reports/);
  assert.equal(queries[3], 'COMMIT');
  assert.equal(released, 1);
});

test('failed report DDL rolls back, releases connection and can be retried', async () => {
  const queries = [];
  let fail = true;
  let released = 0;
  const h = loadInitializer({ query: async sql => {
    queries.push(sql);
    if (fail && sql.includes('CREATE TABLE')) throw new Error('database unavailable');
  }, release: () => { released++; } });
  const results = await Promise.allSettled([h.initialize(), h.initialize()]);
  assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(released, 1);
  fail = false;
  await h.initialize();
  assert.equal(h.connections(), 2);
  assert.equal(queries.at(-1), 'COMMIT');
  assert.equal(released, 2);
});
