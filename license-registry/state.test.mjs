import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initialState, createStore, addJob, dueJobs, reserveFetch, recordResponse,
  recordFailure, savePlan, acknowledge, clearApiBlock, stateSummary, recoverExpiredFetches } from './state.mjs';

const execute = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const NOW = '2026-11-01T07:00:00.000Z';
const BEFORE = '2026-10-31T06:00:00.000Z';
function job(id = 'one', extras = {}) {
  return { id, sourceEventKey: `telegram:-100:msg-${id}`, inn: '9705148570', organization: 'ООО «ХОРОШОТ»',
    operation: 'issuance', status: 'waiting', nextCheckAt: BEFORE, attempts: 0, ...extras };
}
function plannedState() {
  const state = initialState(); addJob(state, job(), { now: BEFORE });
  recordResponse(state, 'one', { http_status: 200, response: { items: [] } }, { now: NOW, importedFrom: '/fixture.json' });
  const plan = savePlan(state, 'one', { action: 'update', updates: [{ row: 3, column: 'J', before: '2026-06-13', after: '2027-10-27' }] }, { now: NOW, expectedCells: { J3: '2027-10-27' } });
  const receipt = { verified: true, planHash: plan.hash, spreadsheetId: state.config.spreadsheetId,
    sheetName: state.config.sheetName, verifiedAt: NOW, cells: { J3: '2027-10-27' } };
  return { state, plan, receipt };
}
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'license-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('state file and private directory are restricted; a failed update preserves the previous JSON', async (t) => {
  const dir = await temporary(t); const file = path.join(dir, 'private', 'state.json'); const store = createStore(file);
  await store.update((state) => addJob(state, job(), { now: NOW }));
  await assert.rejects(store.update((state) => { state.jobs = {}; throw new Error('interrupted'); }), /interrupted/u);
  assert.equal(Object.keys((await store.read()).jobs).length, 1);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['state.json']);
});

test('concurrent writers serialize and do not lose jobs or journal entries', async (t) => {
  const dir = await temporary(t); const store = createStore(path.join(dir, 'private', 'state.json'));
  await Promise.all(Array.from({ length: 16 }, (_, n) => store.update(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, n % 3));
    return addJob(state, job(String(n)), { now: NOW });
  })));
  const state = await store.read(); assert.equal(Object.keys(state.jobs).length, 16); assert.equal(state.journal.length, 16);
});

test('a live lock refuses another run without rewriting the state', async (t) => {
  const dir = await temporary(t); const file = path.join(dir, 'state.json');
  const store = createStore(file, { lockTimeoutMs: 30 });
  await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, token: 'another-run' }));
  await assert.rejects(store.update(() => {}), /locked/u);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('an old live lock is never reclaimed even when single-replica recovery is enabled', async (t) => {
  const dir = await temporary(t); const file = path.join(dir, 'state.json');
  const lockFile = `${file}.lock`;
  const owner = { pid: process.pid, token: 'live', hostname: os.hostname(), createdAt: BEFORE };
  await fs.writeFile(lockFile, JSON.stringify(owner));
  await fs.utimes(lockFile, new Date(BEFORE), new Date(BEFORE));
  const store = createStore(file, { lockTimeoutMs: 30, staleLockMs: 1, singleReplica: true });
  await assert.rejects(store.update(() => {}), /locked/u);
  assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), owner);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('a dead local owner is reclaimed and competing writers still preserve every update', async (t) => {
  const dir = await temporary(t); const file = path.join(dir, 'state.json');
  const { stdout } = await execute(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadPid = Number(stdout);
  await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: deadPid, hostname: os.hostname(), token: 'dead' }));
  await Promise.all(Array.from({ length: 12 }, (_, n) => createStore(file).update(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, n % 3));
    addJob(state, job(String(n)), { now: NOW });
  })));
  const state = await createStore(file).read();
  assert.equal(Object.keys(state.jobs).length, 12);
  assert.equal(state.journal.length, 12);
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('foreign-container locks require explicit single-replica mode and an expired stale interval', async (t) => {
  const dir = await temporary(t); const file = path.join(dir, 'state.json'); const lockFile = `${file}.lock`;
  const owner = { pid: process.pid, hostname: `${os.hostname()}-previous-container`, token: 'old-container' };
  await fs.writeFile(lockFile, JSON.stringify(owner));
  await assert.rejects(createStore(file, { lockTimeoutMs: 30, singleReplica: true }).update(() => {}), /locked/u);
  await fs.utimes(lockFile, new Date(BEFORE), new Date(BEFORE));
  await assert.rejects(createStore(file, { lockTimeoutMs: 30, staleLockMs: 1 }).update(() => {}), /locked/u);
  await createStore(file, { staleLockMs: 1, singleReplica: true }).update((state) => addJob(state, job(), { now: NOW }));
  assert.equal(Object.keys((await createStore(file).read()).jobs).length, 1);
  await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
});

test('a partial abandoned lock is recovered only after its stale interval in single-replica mode', async (t) => {
  const dir = await temporary(t); const file = path.join(dir, 'state.json'); const lockFile = `${file}.lock`;
  await fs.writeFile(lockFile, '{');
  await assert.rejects(createStore(file, { lockTimeoutMs: 30, singleReplica: true }).update(() => {}), /locked/u);
  await fs.utimes(lockFile, new Date(BEFORE), new Date(BEFORE));
  await assert.rejects(createStore(file, { lockTimeoutMs: 30, staleLockMs: 1 }).update(() => {}), /locked/u);
  await createStore(file, { staleLockMs: 1, singleReplica: true }).update(() => {});
  assert.equal((await createStore(file).read()).version, 1);
});

test('new locks record process/container identity and release only their own token', async (t) => {
  const dir = await temporary(t); const file = path.join(dir, 'state.json');
  await createStore(file).update(async () => {
    const owner = JSON.parse(await fs.readFile(`${file}.lock`, 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.hostname, os.hostname());
    assert.equal(typeof owner.token, 'string');
    assert.ok(Number.isFinite(Date.parse(owner.createdAt)));
    if (process.platform === 'linux') {
      assert.equal(typeof owner.bootId, 'string');
      assert.equal(typeof owner.pidNamespace, 'string');
      assert.equal(typeof owner.processStart, 'string');
    }
    await fs.writeFile(`${file}.lock`, JSON.stringify({ ...owner, token: 'replacement-token' }));
  });
  assert.equal(JSON.parse(await fs.readFile(`${file}.lock`, 'utf8')).token, 'replacement-token');
});

test('malformed private JSON is preserved and its contents are not included in errors', async (t) => {
  const dir = await temporary(t); const file = path.join(dir, 'state.json'); const fixtureSecret = 'private-message-content';
  await fs.writeFile(file, fixtureSecret);
  const store = createStore(file);
  await assert.rejects(store.update(() => {}), (error) => /not valid JSON/u.test(error.message) && !error.message.includes(fixtureSecret));
  assert.equal(await fs.readFile(file, 'utf8'), fixtureSecret);
});

test('source message and duplicate document are deduplicated without replacing the original job', () => {
  const state = initialState();
  assert.equal(addJob(state, job('a', { fingerprint: 'doc:123' }), { now: NOW }).created, true);
  assert.equal(addJob(state, job('a'), { now: NOW }).created, false);
  const second = addJob(state, job('b', { fingerprint: 'doc:123' }), { now: NOW });
  assert.equal(second.created, false); assert.equal(second.job.id, 'a');
  assert.equal(state.sources['telegram:-100:msg-b'], 'a'); assert.equal(Object.keys(state.jobs).length, 1);
});

test('due includes unfinished planned writes but excludes tomorrow and completed jobs', () => {
  const state = initialState();
  addJob(state, job('past'), { now: NOW }); addJob(state, job('future', { nextCheckAt: '2026-11-02T06:00:00Z' }), { now: NOW });
  addJob(state, job('write', { status: 'planned' }), { now: NOW }); addJob(state, job('done', { status: 'done' }), { now: NOW });
  const due = dueJobs(state, NOW); assert.deepEqual(new Set(due.map((x) => x.id)), new Set(['past', 'write']));
  assert.equal(due.find((x) => x.id === 'write').nextAction, 'write_and_readback');
});

test('per-run, daily and total reserve limits stop additional API attempts', () => {
  const state = initialState();
  for (let n = 0; n < 4; n++) addJob(state, job(String(n)), { now: NOW });
  for (let n = 0; n < 3; n++) reserveFetch(state, String(n), { now: NOW, runId: 'same-run' });
  assert.throws(() => reserveFetch(state, '3', { now: NOW, runId: 'same-run' }), /Per-run/u);
  state.api.daily['2026-11-01'] = 10;
  assert.throws(() => reserveFetch(state, '3', { now: NOW, runId: 'next-run' }), /Daily/u);
  state.api.daily['2026-11-01'] = 0; state.api.attemptedCalls = 80;
  assert.throws(() => reserveFetch(state, '3', { now: NOW, runId: 'next-run' }), /reserve/u);
  assert.equal(state.jobs['3'].status, 'waiting'); assert.equal(state.jobs['3'].attempts, 0);
});

test('fetch leases recover only expired requests and keep every reserved quota/attempt counted', () => {
  const state = initialState(); addJob(state, job(), { now: BEFORE });
  const { reservation } = reserveFetch(state, 'one', { now: NOW, runId: 'run' });
  assert.equal(state.jobs.one.fetchStartedAt, NOW);
  const api = structuredClone(state.api); const entries = state.journal.length;
  assert.deepEqual(recoverExpiredFetches(state, { now: '2026-11-01T07:01:59.999Z' }), { recovered: [] });
  assert.equal(state.journal.length, entries);
  const recoveredAt = '2026-11-01T07:02:00.000Z';
  assert.deepEqual(recoverExpiredFetches(state, { now: recoveredAt }), { recovered: [{ id: 'one', status: 'waiting',
    nextCheckAt: recoveredAt, reason: 'api_fetch_lease_expired' }] });
  assert.deepEqual(state.api, api); assert.equal(state.jobs.one.attempts, 1);
  assert.equal(state.jobs.one.fetchReservation, undefined); assert.equal(state.jobs.one.fetchStartedAt, undefined);
  assert.equal(dueJobs(state, recoveredAt)[0].id, 'one');
  assert.equal(state.journal.at(-1).type, 'api_fetch_recovered');
  assert.equal(state.journal.at(-1).reservation, reservation);
  assert.deepEqual(recoverExpiredFetches(state, { now: recoveredAt }), { recovered: [] });
  assert.equal(state.journal.length, entries + 1);
});

test('recovered reservations fence late success/failure without changing the replacement request or API block', () => {
  const state = initialState(); addJob(state, job(), { now: BEFORE });
  const first = reserveFetch(state, 'one', { now: NOW, runId: 'run' });
  const later = '2026-11-01T07:03:00.000Z';
  recoverExpiredFetches(state, { now: later });
  const snapshot = structuredClone(state);
  assert.throws(() => recordResponse(state, 'one', { items: [] }, { reservation: first.reservation, now: later }), /reservation/u);
  assert.throws(() => recordFailure(state, 'one', { code: 'access_ip_blocked', reservation: first.reservation, now: later }), /reservation/u);
  assert.deepEqual(state, snapshot);
  const second = reserveFetch(state, 'one', { now: later, runId: 'run' });
  assert.notEqual(first.reservation, second.reservation);
  assert.throws(() => recordResponse(state, 'one', { items: [] }, { reservation: first.reservation, now: later }), /reservation/u);
  assert.throws(() => recordFailure(state, 'one', { code: 'network_error', reservation: first.reservation, now: later }), /reservation/u);
  assert.equal(state.jobs.one.fetchReservation, second.reservation);
  recordResponse(state, 'one', { items: [] }, { reservation: second.reservation, now: later });
  assert.equal(state.jobs.one.status, 'fetched'); assert.equal(state.jobs.one.attempts, 2);
  assert.equal(state.api.attemptedCalls, 2); assert.equal(state.api.blocked, null);
  assert.equal(state.jobs.one.fetchStartedAt, undefined);
  assert.throws(() => recordResponse(state, 'one', { items: [] }, { reservation: second.reservation, now: later }), /reservation/u);
});

test('a live request cannot accept an unreserved or imported result or an unreserved failure', () => {
  const state = initialState(); addJob(state, job(), { now: BEFORE });
  reserveFetch(state, 'one', { now: NOW });
  const before = structuredClone(state);
  assert.throws(() => recordResponse(state, 'one', { items: [] }, { now: NOW }), /reservation/u);
  assert.throws(() => recordResponse(state, 'one', { items: [] }, { importedFrom: '/cached.json', now: NOW }), /reservation/u);
  assert.throws(() => recordFailure(state, 'one', { code: 'network_error', now: NOW }), /reservation/u);
  assert.deepEqual(state, before);
});

test('lease recovery supports legacy timestamps and preserves fetched/planned jobs and global API blocks', () => {
  const { state, receipt } = plannedState();
  addJob(state, job('legacy', { status: 'fetching', attempts: 3, fetchReservation: 'legacy' }), { now: BEFORE });
  addJob(state, job('fetched', { status: 'fetched' }), { now: BEFORE });
  state.api.attemptedCalls = 3;
  state.api.blocked = { code: 'authentication_failed', at: NOW };
  const originalPlan = structuredClone(state.jobs.one.plan);
  const result = recoverExpiredFetches(state, { now: NOW });
  assert.deepEqual(result.recovered.map((item) => item.id), ['legacy']);
  assert.equal(state.jobs.legacy.attempts, 3); assert.equal(state.api.attemptedCalls, 3);
  assert.deepEqual(state.jobs.one.plan, originalPlan); assert.equal(state.jobs.fetched.status, 'fetched');
  assert.equal(state.api.blocked.code, 'authentication_failed');
  assert.throws(() => reserveFetch(state, 'legacy', { now: NOW }), /blocked/u);
  assert.equal(acknowledge(state, 'one', receipt, { now: NOW }).job.status, 'done');
  assert.throws(() => recoverExpiredFetches(state, { now: 'invalid' }), /lease/u);
  assert.throws(() => recoverExpiredFetches(state, { now: NOW, leaseMs: 0 }), /lease/u);
});

test('the last expired attempt needs review and cannot reserve another call or refund quota', () => {
  const state = initialState(); addJob(state, job('one', { attempts: 6 }), { now: BEFORE });
  reserveFetch(state, 'one', { now: NOW });
  assert.equal(state.jobs.one.attempts, 7);
  const api = structuredClone(state.api);
  const later = '2026-11-01T07:03:00.000Z';
  const recovered = recoverExpiredFetches(state, { now: later }).recovered;
  assert.deepEqual(recovered, [{ id: 'one', status: 'review', nextCheckAt: null, reason: 'maximum_attempts_reached' }]);
  assert.deepEqual(state.api, api); assert.equal(state.jobs.one.attempts, 7);
  assert.equal(dueJobs(state, later).length, 0);
  state.jobs.one.status = 'waiting'; state.jobs.one.nextCheckAt = later;
  assert.throws(() => reserveFetch(state, 'one', { now: later }), /Maximum API attempts/u);
  assert.deepEqual(state.api, api);
});

test('explicit maximum attempts applies to both reservations and crash recovery', () => {
  const state = initialState({ maxAttempts: 2 }); addJob(state, job('one', { attempts: 1 }), { now: BEFORE });
  reserveFetch(state, 'one', { now: NOW });
  recoverExpiredFetches(state, { now: '2026-11-01T07:03:00.000Z' });
  assert.equal(state.jobs.one.status, 'review'); assert.equal(state.jobs.one.attempts, 2);
  const invalid = initialState({ maxAttempts: 0 }); addJob(invalid, job(), { now: BEFORE });
  assert.throws(() => reserveFetch(invalid, 'one', { now: NOW }), /maximum/u);
  assert.throws(() => recoverExpiredFetches(invalid, { now: NOW }), /maximum/u);
});

test('an IP denial globally blocks more calls until an explicit recheck; no network setting is changed', () => {
  const state = initialState(); addJob(state, job('a'), { now: NOW }); addJob(state, job('b'), { now: NOW });
  const { reservation } = reserveFetch(state, 'a', { now: NOW });
  recordFailure(state, 'a', { code: 'access_ip_blocked', message: 'API rejected the source IP', reservation, now: NOW });
  assert.equal(state.jobs.a.status, 'blocked');
  assert.throws(() => reserveFetch(state, 'b', { now: NOW }), /API is blocked/u);
  assert.throws(() => clearApiBlock(state, {}), /explicit reason/u);
  clearApiBlock(state, { reason: 'Operator verified the existing authorized connection', now: NOW });
  assert.equal(state.api.blocked, null); assert.equal(state.jobs.a.status, 'waiting');
  assert.equal(state.journal.at(-1).type, 'api_block_cleared_for_recheck');
});

test('imported cached response does not consume another API call and incomplete pagination needs review', () => {
  const state = initialState(); addJob(state, job(), { now: NOW });
  recordResponse(state, 'one', { http_status: 200, response: { items: [], nextpage: 'false' } }, { now: NOW, importedFrom: '/cached.json' });
  assert.equal(state.jobs.one.status, 'fetched'); assert.equal(state.api.attemptedCalls, 0);
  recordResponse(state, 'one', { http_status: 200, response: { items: [], nextpage: true } }, { now: NOW, importedFrom: '/partial.json' });
  assert.equal(state.jobs.one.status, 'review'); assert.equal(state.jobs.one.reason, 'incomplete_api_pagination');
});

test('planning is pending, never completion, and acknowledgements require matching fresh cell readback', () => {
  const { state, receipt } = plannedState();
  assert.equal(stateSummary(state).pendingWrites, 1); assert.equal(state.jobs.one.status, 'planned');
  for (const bad of [
    { ...receipt, verified: false }, { ...receipt, planHash: 'wrong' },
    { ...receipt, spreadsheetId: 'another-file' }, { ...receipt, cells: {} },
    { ...receipt, cells: { J3: '2026-06-13' } }, { ...receipt, verifiedAt: BEFORE },
    { ...receipt, verifiedAt: 'not-a-date' },
  ]) assert.throws(() => acknowledge(state, 'one', bad, { now: NOW }));
  assert.equal(state.jobs.one.status, 'planned');
  assert.equal(acknowledge(state, 'one', receipt, { now: NOW }).alreadyDone, false);
  assert.equal(acknowledge(state, 'one', receipt, { now: NOW }).alreadyDone, true);
  assert.equal(state.journal.filter((x) => x.type === 'write_verified').length, 1);
  assert.equal(stateSummary(state).pendingWrites, 0);
  assert.throws(() => recordFailure(state, 'one', { code: 'retry', now: NOW }), /completed/u);
});

test('an acknowledgement cannot be made from an empty expected-cell plan', () => {
  const { state } = plannedState();
  assert.throws(() => savePlan(state, 'one', { action: 'noop' }, { expectedCells: {}, now: NOW }), /readback cells/u);
});

async function cli(t, dir, args, { fail = false } = {}) {
  const argv = [path.join(directory, 'cli.mjs'), ...args, '--state', path.join(dir, 'private', 'state.json'), '--now', NOW];
  try { const { stdout } = await execute(process.execPath, argv); if (fail) assert.fail('Expected CLI rejection'); return JSON.parse(stdout); }
  catch (error) { if (!fail || !error.stderr) throw error; return JSON.parse(error.stderr); }
}

test('offline CLI runs ingest → cached response → append plan → verified ack exactly once', async (t) => {
  const dir = await temporary(t);
  const context = path.join(dir, 'context.json'); const input = path.join(dir, 'messages.json');
  const api = path.join(dir, 'api.json'); const proof = path.join(dir, 'readback.json');
  await fs.writeFile(context, JSON.stringify({ values: [['B24', '', '', '', 'Организация', '', 'ИНН']] }));
  await fs.writeFile(input, JSON.stringify([{ id: 42, chat_id: -100, date: '2026-10-28T10:00:00+03:00',
    text: 'ООО «ХОРОШОТ» положительно. Решение о выдаче лицензии', inn: '9705148570' }]));
  const ingest = await cli(t, dir, ['ingest', '--file', input, '--context', context]);
  const id = ingest.results[0].id; assert.equal(ingest.results[0].created, true);
  await fs.writeFile(api, JSON.stringify({ http_status: 200, response: { items: [{ ИНН: '9705148570',
    'КПП подразделения': '770501001', 'Номер лицензии': '77РПО0021680', 'Дата выдачи': '2026-10-28',
    'Дата окончания': '2027-10-27', 'Вид лицензии': 'Розничная продажа, общепит',
    'Адрес подразделения': 'Москва, Средний Овчинниковский переулок, 3', 'Статус лицензии': 'действующая',
    'Дата изменения': '2026-10-28' }] } }));
  await cli(t, dir, ['import-response', '--job', id, '--file', api]);
  const { plan } = await cli(t, dir, ['plan', '--job', id, '--context', context]);
  assert.equal(plan.action, 'append'); assert.equal(plan.rowNumber, 2); assert.equal(plan.expectedCells.J2, '2027-10-27');
  const receipt = { verified: true, verifiedAt: NOW, planHash: plan.hash, spreadsheetId: plan.spreadsheetId,
    sheetName: plan.sheetName, cells: { ...plan.expectedCells, I2: '28.10.2026', J2: '27.10.2027' } };
  await fs.writeFile(proof, JSON.stringify({ ...receipt, cells: {} }));
  assert.match((await cli(t, dir, ['ack', '--job', id, '--receipt', proof], { fail: true })).error, /Readback mismatch/u);
  await fs.writeFile(proof, JSON.stringify(receipt));
  assert.equal((await cli(t, dir, ['ack', '--job', id, '--receipt', proof])).job.status, 'done');
  assert.equal((await cli(t, dir, ['ack', '--job', id, '--receipt', proof])).alreadyDone, true);
  const duplicate = await cli(t, dir, ['ingest', '--file', input, '--context', context]);
  assert.equal(duplicate.results[0].duplicate, true); assert.equal(duplicate.summary.jobs, 1);
  assert.equal(duplicate.summary.api.attemptedCalls, 0);
});

test('an unresolved positive message remains reviewable and can be resolved by verified context', async (t) => {
  const dir = await temporary(t); const context = path.join(dir, 'context.json'); const input = path.join(dir, 'messages.json');
  await fs.writeFile(context, JSON.stringify({ values: [] }));
  const message = { id: 123, chat_id: -100, date: '2026-10-28T10:00:00+03:00', text: 'Хорошот положительно' };
  await fs.writeFile(input, JSON.stringify([message]));
  assert.equal((await cli(t, dir, ['ingest', '--file', input, '--context', context])).results[0].status, 'review');
  await fs.writeFile(input, JSON.stringify([{ ...message, inn: '9705148570', organization: 'ООО «ХОРОШОТ»', operation: 'issuance' }]));
  const resolved = await cli(t, dir, ['ingest', '--file', input, '--context', context]);
  assert.equal(resolved.results[0].resolved, true); assert.equal(resolved.results[0].status, 'waiting');
});

test('Python key validation uses a restricted file, does not call the network, and does not echo the key', async (t) => {
  const dir = await temporary(t); const keyPath = path.join(dir, 'key'); const fixtureKey = 'a'.repeat(40);
  await fs.writeFile(keyPath, fixtureKey, { mode: 0o600 });
  const args = [path.join(directory, 'network-helper.py'), '--method', 'validate', '--key-file', keyPath];
  const result = await execute('python3', args);
  assert.equal(JSON.parse(result.stdout).valid, true); assert.equal(result.stdout.includes(fixtureKey), false);
  await fs.chmod(keyPath, 0o644);
  const rejected = JSON.parse((await execute('python3', args)).stdout);
  assert.equal(rejected.attempted, false); assert.match(rejected.transport_error, /not be readable/u);
});

test('invalid CLI JSON does not echo a mistakenly supplied secret input', async (t) => {
  const dir = await temporary(t); const input = path.join(dir, 'input'); const context = path.join(dir, 'context.json');
  const fixtureSecret = 'z'.repeat(40); await fs.writeFile(input, fixtureSecret); await fs.writeFile(context, '[]');
  const result = await cli(t, dir, ['ingest', '--file', input, '--context', context], { fail: true });
  assert.match(result.error, /Invalid JSON/u); assert.equal(result.error.includes(fixtureSecret), false);
});
