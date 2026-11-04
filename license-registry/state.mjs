import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
  spreadsheetId: '15je7KIryEg09thZVLpguVWXmWlxCsft2ULC6dc2m-vs',
  sheetName: 'Реестр лицензий', timeZone: 'Europe/Moscow',
  apiTotalLimit: 100, apiReserve: 20, dailyLimit: 10, runLimit: 3, maxAttempts: 7,
});
const iso = (value = new Date()) => new Date(value).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reclaimers = new Map();
const writers = new Map();
async function serializeWriter(file, operation) {
  const previous = writers.get(file) ?? Promise.resolve();
  let unlock;
  const pending = new Promise((resolve) => { unlock = resolve; });
  writers.set(file, pending);
  await previous;
  try { return await operation(); }
  finally {
    unlock();
    if (writers.get(file) === pending) writers.delete(file);
  }
}
const optionalRead = async (file) => fs.readFile(file, 'utf8').then((value) => value.trim()).catch(() => null);
async function processStart(pid) {
  const stat = await optionalRead(`/proc/${pid}/stat`);
  // The process name in parentheses may contain spaces or closing parentheses.
  return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/u)[19] ?? null : null;
}
async function lockIdentity() {
  return { hostname: os.hostname(), bootId: await optionalRead('/proc/sys/kernel/random/boot_id'),
    pidNamespace: await fs.readlink('/proc/self/ns/pid').catch(() => null), processStart: await processStart(process.pid) };
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;

export function initialState(config = {}) {
  return { version: 1, config: { ...DEFAULT_CONFIG, ...config }, jobs: {}, sources: {},
    api: { attemptedCalls: 0, daily: {}, runs: {}, blocked: null }, journal: [], cursors: {} };
}
function validateState(state) {
  if (state?.version !== 1 || !state.jobs || !state.sources || !state.api || !Array.isArray(state.journal)) throw new Error('Invalid state file; refusing to overwrite it');
  return state;
}
export function createStore(statePath, { lockTimeoutMs = 5000, staleLockMs = 300_000, singleReplica = false } = {}) {
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0 || !Number.isFinite(staleLockMs) || staleLockMs < 0) throw new Error('Invalid lock timeout');
  const absolute = path.resolve(statePath);
  const lockPath = `${absolute}.lock`;
  let identity;
  async function ensureDirectory() {
    await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(absolute), 0o700);
  }
  async function read() {
    try { return validateState(JSON.parse(await fs.readFile(absolute, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return initialState();
      if (error instanceof SyntaxError) throw new Error('State file is not valid JSON; refusing to overwrite it');
      throw error;
    }
  }
  async function lock() {
    await ensureDirectory();
    identity ??= lockIdentity();
    const currentIdentity = await identity;
    const until = Date.now() + lockTimeoutMs;
    const token = randomUUID();
    while (true) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, ...currentIdentity, createdAt: new Date().toISOString() })); }
        catch (error) {
          // Only remove the inode opened exclusively by this call. A failed
          // metadata write must not leave a live-PID lock owned by nobody.
          try { if (sameFile(await handle.stat(), await fs.stat(lockPath))) await fs.unlink(lockPath); }
          catch {}
          throw error;
        }
        finally { await handle.close(); }
        return async () => {
          try {
            const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (current.token === token) await fs.unlink(lockPath);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await reclaim(currentIdentity)) continue;
        if (Date.now() >= until) throw Object.assign(new Error('State is locked by another run; no work was performed'), { code: 'state_locked' });
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  async function reclaim(currentIdentity) {
    // Recovery is for one worker/replica. Serialize its contenders so a second
    // waiter cannot remove the fresh lock acquired after the first recovery.
    const previous = reclaimers.get(lockPath) ?? Promise.resolve();
    let unlock;
    const pending = new Promise((resolve) => { unlock = resolve; });
    reclaimers.set(lockPath, pending);
    await previous;
    try {
      let before; let owner;
      try {
        before = await fs.stat(lockPath);
        try { owner = JSON.parse(await fs.readFile(lockPath, 'utf8')); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      const old = Date.now() - before.mtimeMs >= staleLockMs;
      let abandoned = false;
      const foreign = owner?.hostname && owner.hostname !== currentIdentity.hostname;
      const differentBoot = owner?.bootId && currentIdentity.bootId && owner.bootId !== currentIdentity.bootId;
      const differentNamespace = owner?.pidNamespace && currentIdentity.pidNamespace && owner.pidNamespace !== currentIdentity.pidNamespace;
      if (foreign || differentNamespace) {
        // A previous container is only known to be gone when deployment ensures
        // a single replica with no overlapping processes using this volume.
        abandoned = singleReplica && old;
      } else if (differentBoot) abandoned = true;
      else if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
          if (owner.processStart) {
            const started = await processStart(owner.pid);
            abandoned = Boolean(started && started !== owner.processStart);
          }
        } catch (error) { abandoned = error.code === 'ESRCH'; }
        // EPERM and a live/reused PID without a start identity fail closed.
      } else abandoned = singleReplica && old;
      if (!abandoned) return false;
      try {
        if (!sameFile(before, await fs.stat(lockPath))) return false;
        await fs.unlink(lockPath);
        return true;
      } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    } finally {
      unlock();
      if (reclaimers.get(lockPath) === pending) reclaimers.delete(lockPath);
    }
  }
  async function update(mutator) {
    // Same-process callers, including different store instances, queue before
    // their filesystem-lock timeout starts. External ownership is still checked.
    return serializeWriter(absolute, async () => {
      const release = await lock();
      let temporary;
      try {
        const state = clone(await read());
        const result = await mutator(state);
        validateState(state);
        temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, absolute);
        await fs.chmod(absolute, 0o600);
        return result;
      } finally {
        if (temporary) await fs.unlink(temporary).catch(() => {});
        await release();
      }
    });
  }
  return { path: absolute, read, update };
}

function journal(state, entry, now) {
  state.journal.push({ at: iso(now), ...clone(entry) });
}
export function addJob(state, job, { now = new Date() } = {}) {
  const existing = state.sources[job.sourceEventKey];
  if (existing) return { created: false, job: state.jobs[existing], reason: 'duplicate_source' };
  const documentDuplicate = job.fingerprint && Object.values(state.jobs).find((prior) => prior.fingerprint === job.fingerprint);
  if (documentDuplicate) {
    state.sources[job.sourceEventKey] = documentDuplicate.id;
    journal(state, { type: 'duplicate_document', jobId: documentDuplicate.id, sourceEventKey: job.sourceEventKey }, now);
    return { created: false, job: documentDuplicate, reason: 'duplicate_document' };
  }
  if (state.jobs[job.id]) throw new Error('Job identity collision');
  const stored = { ...clone(job), createdAt: iso(now), updatedAt: iso(now) };
  state.jobs[job.id] = stored;
  state.sources[job.sourceEventKey] = job.id;
  journal(state, { type: 'ingested', jobId: job.id, sourceEventKey: job.sourceEventKey, status: job.status }, now);
  return { created: true, job: stored };
}
export function requireJob(state, id) {
  const job = state.jobs[id];
  if (!job) throw new Error('Unknown job');
  return job;
}
export function dueJobs(state, now = new Date()) {
  const instant = +new Date(now);
  return Object.values(state.jobs).filter((job) =>
    ['fetched', 'planned'].includes(job.status) || (job.status === 'waiting' && Date.parse(job.nextCheckAt) <= instant)
  ).sort((a, b) => String(a.nextCheckAt ?? a.createdAt).localeCompare(String(b.nextCheckAt ?? b.createdAt)))
    .map((job) => ({ ...clone(job), nextAction: job.status === 'planned' ? 'write_and_readback' : job.status === 'fetched' ? 'plan' : 'fetch' }));
}
function dayKey(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
export function reserveFetch(state, id, { now = new Date(), runId } = {}) {
  const job = requireJob(state, id);
  if (job.status !== 'waiting') throw new Error('Job is not waiting for an API request');
  if (!(Date.parse(job.nextCheckAt) <= +new Date(now))) throw new Error('Job is not due yet');
  const maxAttempts = state.config.maxAttempts ?? 7;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid maximum API attempts');
  if (!Number.isInteger(job.attempts ?? 0) || (job.attempts ?? 0) < 0) throw new Error('Invalid API attempt counter');
  if ((job.attempts ?? 0) >= maxAttempts) throw new Error('Maximum API attempts reached; review is required');
  if (state.api.blocked) throw new Error(`API is blocked: ${state.api.blocked.code}; explicit recheck is required`);
  const day = dayKey(now, state.config.timeZone);
  const run = runId || `${day}:daily`;
  const used = state.api.attemptedCalls;
  if (used >= state.config.apiTotalLimit - state.config.apiReserve) throw new Error('API quota reserve reached');
  if ((state.api.daily[day] ?? 0) >= state.config.dailyLimit) throw new Error('Daily API limit reached');
  if ((state.api.runs[run] ?? 0) >= state.config.runLimit) throw new Error('Per-run API limit reached');
  state.api.attemptedCalls += 1;
  state.api.daily[day] = (state.api.daily[day] ?? 0) + 1;
  state.api.runs[run] = (state.api.runs[run] ?? 0) + 1;
  job.status = 'fetching';
  job.attempts = (job.attempts ?? 0) + 1;
  job.fetchReservation = randomUUID();
  job.fetchStartedAt = iso(now);
  job.updatedAt = iso(now);
  journal(state, { type: 'api_attempt_reserved', jobId: id, sourceEventKey: job.sourceEventKey, attempt: job.attempts, runId: run }, now);
  return { reservation: job.fetchReservation, job: clone(job) };
}
export function recoverExpiredFetches(state, { now = new Date(), leaseMs = 120_000 } = {}) {
  const instant = +new Date(now);
  if (!Number.isFinite(instant) || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Invalid API fetch lease');
  const maxAttempts = state.config.maxAttempts ?? 7;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid maximum API attempts');
  const recovered = [];
  for (const job of Object.values(state.jobs)) {
    if (job.status !== 'fetching') continue;
    const startedAt = job.fetchStartedAt ?? job.updatedAt ?? job.createdAt;
    const started = Date.parse(startedAt);
    if (Number.isFinite(started) && instant - started < leaseMs) continue;
    const reservation = job.fetchReservation ?? null;
    const exhausted = (job.attempts ?? 0) >= maxAttempts;
    job.status = exhausted ? 'review' : 'waiting';
    job.reason = exhausted ? 'maximum_attempts_reached' : 'api_fetch_lease_expired';
    job.lastError = 'The worker stopped before recording an API response; the reserved attempt remains counted';
    job.nextCheckAt = exhausted ? null : iso(now);
    job.updatedAt = iso(now);
    delete job.fetchReservation;
    delete job.fetchStartedAt;
    journal(state, { type: 'api_fetch_recovered', jobId: job.id, sourceEventKey: job.sourceEventKey,
      reservation, fetchStartedAt: startedAt ?? null, attempt: job.attempts ?? 0, status: job.status, reason: job.reason }, now);
    recovered.push({ id: job.id, status: job.status, nextCheckAt: job.nextCheckAt, reason: job.reason });
  }
  return { recovered };
}
function assertFetchReservation(job, reservation) {
  if ((reservation && (job.status !== 'fetching' || job.fetchReservation !== reservation)) ||
      (job.status === 'fetching' && !reservation)) throw new Error('Stale or missing API reservation');
}
export function recordResponse(state, id, envelope, { now = new Date(), reservation, importedFrom } = {}) {
  const job = requireJob(state, id);
  if (['done', 'planned'].includes(job.status)) throw new Error('A completed or planned job cannot import another response');
  assertFetchReservation(job, reservation);
  if (!reservation && !importedFrom) throw new Error('A live API response requires its reservation');
  const response = envelope?.response ?? envelope;
  if (envelope?.http_status != null && envelope.http_status !== 200) throw new Error('Only successful API responses can be recorded');
  if (!response || !Array.isArray(response.items)) throw new Error('API response has no items array');
  job.apiItems = clone(response.items);
  job.apiIncomplete = ![undefined, null, false, 0, '', 'false'].includes(response.nextpage);
  job.apiReceivedAt = iso(now);
  job.apiEvidence = importedFrom ?? 'live_api';
  job.status = job.apiIncomplete ? 'review' : 'fetched';
  job.reason = job.apiIncomplete ? 'incomplete_api_pagination' : null;
  job.updatedAt = iso(now);
  delete job.fetchReservation;
  delete job.fetchStartedAt;
  journal(state, { type: importedFrom ? 'api_response_imported' : 'api_response_received', jobId: id, sourceEventKey: job.sourceEventKey, records: response.items.length, incomplete: job.apiIncomplete, evidence: job.apiEvidence }, now);
  return clone(job);
}
export function recordFailure(state, id, { code, message, nextCheckAt, now = new Date(), reservation, terminal = false } = {}) {
  const job = requireJob(state, id);
  if (job.status === 'done') throw new Error('A completed job cannot be retried');
  assertFetchReservation(job, reservation);
  const block = ['access_ip_blocked', 'authentication_failed', 'quota_exhausted'].includes(code);
  job.status = block ? 'blocked' : terminal ? 'review' : 'waiting';
  job.reason = String(code ?? 'request_failed');
  job.lastError = String(message ?? code ?? 'request failed').slice(0, 1000);
  job.nextCheckAt = block || terminal ? null : nextCheckAt;
  job.updatedAt = iso(now);
  delete job.fetchReservation;
  delete job.fetchStartedAt;
  delete job.plan;
  if (block) state.api.blocked = { code, at: iso(now), jobId: id };
  journal(state, { type: 'processing_failed', jobId: id, sourceEventKey: job.sourceEventKey, code: job.reason, terminal: terminal || block }, now);
  return clone(job);
}
export function savePlan(state, id, plan, { expectedCells, now = new Date() } = {}) {
  const job = requireJob(state, id);
  if (job.status !== 'fetched' && job.status !== 'planned') throw new Error('A fetched response is required before planning');
  if (!['append', 'update', 'noop'].includes(plan.action)) throw new Error('Only actionable plans can be saved');
  if (!expectedCells || typeof expectedCells !== 'object' || !Object.keys(expectedCells).length) throw new Error('Expected readback cells are required');
  const normalized = { ...clone(plan), expectedCells: clone(expectedCells), spreadsheetId: state.config.spreadsheetId, sheetName: state.config.sheetName };
  job.plan = { ...normalized, hash: hash(normalized), createdAt: iso(now) };
  job.status = 'planned';
  job.updatedAt = iso(now);
  journal(state, { type: 'write_planned', jobId: id, sourceEventKey: job.sourceEventKey, action: plan.action, planHash: job.plan.hash, updates: clone(plan.updates ?? []) }, now);
  return clone(job.plan);
}
function comparable(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value.trim() : value;
}
export function acknowledge(state, id, receipt, { now = new Date() } = {}) {
  const job = requireJob(state, id);
  if (job.status === 'done' && receipt?.planHash === job.receipt?.planHash) return { alreadyDone: true, job: clone(job) };
  if (job.status !== 'planned' || !job.plan) throw new Error('A planned write is required');
  if (receipt?.verified !== true || receipt.planHash !== job.plan.hash) throw new Error('A matching verified readback receipt is required');
  if (receipt.spreadsheetId !== state.config.spreadsheetId || receipt.sheetName !== state.config.sheetName) throw new Error('Readback belongs to a different spreadsheet or sheet');
  if (!receipt.verifiedAt || !Number.isFinite(Date.parse(receipt.verifiedAt)) || Date.parse(receipt.verifiedAt) < Date.parse(job.plan.createdAt)) throw new Error('Readback predates the write plan or has an invalid timestamp');
  if (!receipt.cells || typeof receipt.cells !== 'object') throw new Error('Readback cells are required');
  for (const [cell, value] of Object.entries(job.plan.expectedCells)) {
    if (!Object.hasOwn(receipt.cells, cell) || comparable(receipt.cells[cell]) !== comparable(value)) throw new Error(`Readback mismatch at ${cell}`);
  }
  job.status = 'done';
  job.completedAt = iso(now);
  job.updatedAt = iso(now);
  job.receipt = clone(receipt);
  journal(state, { type: 'write_verified', jobId: id, sourceEventKey: job.sourceEventKey, planHash: job.plan.hash, updates: clone(job.plan.updates ?? []), readback: clone(receipt.cells), verifiedAt: receipt.verifiedAt }, now);
  return { alreadyDone: false, job: clone(job) };
}
export function clearApiBlock(state, { reason, nextCheckAt, now = new Date() } = {}) {
  if (!String(reason ?? '').trim()) throw new Error('An explicit reason for rechecking access is required');
  const previous = state.api.blocked;
  state.api.blocked = null;
  for (const job of Object.values(state.jobs)) if (job.status === 'blocked') { job.status = 'waiting'; job.nextCheckAt = nextCheckAt ?? iso(now); job.updatedAt = iso(now); }
  journal(state, { type: 'api_block_cleared_for_recheck', previous, reason }, now);
}
export function stateSummary(state) {
  const counts = {};
  for (const job of Object.values(state.jobs)) counts[job.status] = (counts[job.status] ?? 0) + 1;
  return { version: state.version, jobs: Object.keys(state.jobs).length, counts, api: clone(state.api), journalEntries: state.journal.length,
    pendingWrites: Object.values(state.jobs).filter((job) => job.status === 'planned').length };
}
