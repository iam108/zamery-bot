#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { extractEvent, parseSheetRows, prepareJob, sourceEventKey, nextMorning,
  selectLicense, planSheetUpsert, planRetry, normalizeDate, isValidInn } from './core.mjs';
import { createStore, addJob, requireJob, dueJobs, reserveFetch, recordResponse,
  recordFailure, savePlan, acknowledge, clearApiBlock, stateSummary } from './state.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const executeFile = promisify(execFile);
function argumentsOf(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) throw new Error('Options must use --name value');
    const name = rest[i].slice(2);
    if (!rest[i + 1] || rest[i + 1].startsWith('--')) options[name] = true;
    else options[name] = rest[++i];
  }
  return { command, options };
}
const { command, options } = argumentsOf(process.argv.slice(2));
const store = createStore(options.state || path.join(directory, 'private', 'state.json'));
const now = options.now || new Date().toISOString();
const required = (name) => { if (typeof options[name] !== 'string') throw new Error(`--${name} is required`); return options[name]; };
const readJson = async (name) => {
  const text = await fs.readFile(required(name), 'utf8');
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON input for --${name}; input contents were not printed`); }
};
const flatten = (value) => Array.isArray(value) ? value.map((p) => typeof p === 'string' ? p : p?.text ?? '').join('') : String(value ?? '');
function rowsOf(context) {
  const values = Array.isArray(context) ? context : context.values ?? context.structuredContent?.values;
  if (!Array.isArray(values)) throw new Error('Context must contain a bounded array of sheet rows');
  return { rows: parseSheetRows(values, { startRow: context.startRow ?? 1 }), values, startRow: context.startRow ?? 1 };
}
function summary(job) {
  return { id: job.id, sourceEventKey: job.sourceEventKey, organization: job.organization,
    inn: job.inn, operation: job.operation, status: job.status, nextCheckAt: job.nextCheckAt,
    attempts: job.attempts ?? 0, reason: job.reason ?? null, sourceUrl: job.sourceUrl ?? null,
    nextAction: job.nextAction };
}
async function network(method, job, { validate = false } = {}) {
  const args = [path.join(directory, 'network-helper.py'), '--key-file', required('key-file'),
    '--method', validate ? 'validate' : method];
  if (!validate && method === 'fsrar') {
    args.push('--inn', job.inn);
    if (job.kpp) args.push('--kpp', job.kpp);
  }
  const { stdout } = await executeFile('python3', args, { timeout: 23000, maxBuffer: 3_000_000 });
  return JSON.parse(stdout);
}
function responseFailure(envelope) {
  const value = envelope.response;
  const detail = String(envelope.error ?? envelope.transport_error ?? value?.non_json_response ?? value?.error ?? value?.Ошибка ?? '');
  if (/ip.{0,30}(?:запрещ|недопуст)|доступ с данного ip/iu.test(detail)) return { code: 'access_ip_blocked', message: detail };
  if (/неверн\p{L}* ключ|недействительн\p{L}* ключ|invalid.?key/iu.test(detail) || envelope.http_status === 401) return { code: 'authentication_failed', message: detail || 'Authentication rejected' };
  if (/лимит|квот|quota|limit exceeded/iu.test(detail)) return { code: 'quota_exhausted', message: detail };
  if (envelope.http_status === 403) return { code: 'access_ip_blocked', message: detail || 'API access forbidden; manual investigation required' };
  if (envelope.http_status !== 200 || !value || !Array.isArray(value.items)) return { code: envelope.transport_error ? 'network_error' : 'invalid_api_response', message: detail || 'No valid bounded API response' };
  return null;
}
function retryFor(job, reason, state) {
  const next = planRetry({ ...job, status: 'waiting' }, { now, timeZone: state.config.timeZone,
    quotaRemaining: state.config.apiTotalLimit - state.api.attemptedCalls, quotaReserve: state.config.apiReserve });
  return recordFailure(state, job.id, { code: next.status === 'waiting' ? reason : next.reason, message: reason, now,
    nextCheckAt: next.nextCheckAt, terminal: next.status === 'review' || next.status === 'quota_exhausted' });
}
function expectedCells(plan, job) {
  const cells = {};
  for (const update of plan.updates ?? []) cells[`${update.column}${update.row}`] = update.after;
  // A no-op still requires proof that the correct license and its dates were read.
  if (plan.action === 'noop') {
    const row = plan.rowNumber;
    Object.assign(cells, { [`G${row}`]: job.selectedLicense.inn,
      [`H${row}`]: job.selectedLicense.licenseNumber, [`I${row}`]: job.selectedLicense.issueDate,
      [`J${row}`]: job.selectedLicense.expiryDate });
  }
  return cells;
}
function appendRowOf(context) {
  const explicit = options['append-row'];
  if (explicit) {
    const row = Number(explicit);
    if (!Number.isInteger(row) || row < 2) throw new Error('Invalid append row');
    const existing = context.values[row - context.startRow];
    if (Array.isArray(existing) && existing.some((v) => v != null && String(v) !== '')) throw new Error('The proposed append row is occupied');
    return row;
  }
  let last = context.startRow - 1;
  context.values.forEach((row, index) => { if (Array.isArray(row) && row.some((v) => v != null && String(v) !== '')) last = context.startRow + index; });
  return Math.max(2, last + 1);
}

async function main() {
  switch (command) {
    case 'help':
      return { commands: ['ingest --file messages.json --context sheet-values.json', 'due --now ISO',
        'fetch --job ID --key-file PATH [--run-id ID]', 'import-response --job ID --file response.json',
        'plan --job ID --context sheet-values.json [--append-row N]', 'ack --job ID --receipt readback.json',
        'retry --job ID --error CODE', 'unblock --reason TEXT', 'checkpoint --chat ID --message ID --date ISO', 'status'],
      note: 'This helper never sends Telegram messages or writes Google Sheets. The authorized agent writes the plan through Google MCP and acknowledges verified cell readback.' };
    case 'status': return stateSummary(await store.read());
    case 'due': return { jobs: dueJobs(await store.read(), now).map(summary) };
    case 'ingest': {
      const input = await readJson('file');
      const messages = Array.isArray(input) ? input : input.messages;
      if (!Array.isArray(messages)) throw new Error('Input must contain an array of Telegram messages');
      const context = rowsOf(await readJson('context'));
      return store.update((state) => {
        const results = [];
        for (const raw of messages) {
          const message = { ...raw, text: flatten(raw.text ?? raw.caption), chatId: raw.chatId ?? raw.chat_id,
            address: raw.address ?? raw.object_address, url: raw.url ?? raw.source_url };
          // Explicit metadata may be supplied only from a verified chat/client context.
          if (raw.inn) {
            if (!isValidInn(String(raw.inn))) throw new Error('Invalid enriched INN');
            message.text += ` ИНН ${raw.inn}`;
          }
          let extraction = extractEvent(message, context.rows, { timeZone: state.config.timeZone });
          if (extraction.status === 'ignore') { results.push({ status: 'ignored', reason: extraction.reason, messageId: raw.id }); continue; }
          let source;
          try { source = sourceEventKey(message); } catch { results.push({ status: 'review', reason: 'missing_message_identity' }); continue; }
          let event = extraction.event;
          if (!event) {
            event = { id: source, sourceEventKey: source, reportedAt: raw.date,
              organization: raw.organization ?? null, inn: raw.inn ?? null,
              operation: raw.operation ?? 'unknown', nextCheckAt: null };
          } else {
            if (!event.organization && raw.organization) event.organization = String(raw.organization);
            if (event.operation === 'unknown' && ['issuance', 'renewal', 'reissue'].includes(raw.operation)) event.operation = raw.operation;
          }
          const existingId = state.sources[source];
          const existing = existingId && state.jobs[existingId];
          if (existing?.status === 'review' && extraction.status === 'event' && !existing.apiItems) {
            Object.assign(existing, event, { id: existingId, status: 'waiting', reason: null, updatedAt: now });
            state.journal.push({ at: now, type: 'context_resolved', jobId: existingId, sourceEventKey: source });
            results.push({ created: false, resolved: true, ...summary(existing) }); continue;
          }
          const prepared = extraction.status === 'review' ? { job: { ...event,
            id: createHash('sha256').update(source).digest('hex').slice(0, 24), attempts: 0 } }
            : prepareJob(event, [], { timeZone: state.config.timeZone });
          const job = { ...prepared.job, sourceText: flatten(raw.text ?? raw.caption).slice(0, 20000) };
          if (extraction.status === 'review') { job.status = 'review'; job.reason = extraction.reason; job.nextCheckAt = null; }
          const result = addJob(state, job, { now });
          results.push({ created: result.created, duplicate: !result.created, ...summary(result.job) });
        }
        return { results, summary: stateSummary(state) };
      });
    }
    case 'fetch': {
      const id = required('job');
      const validation = await network('validate', null, { validate: true });
      if (!validation.valid) throw new Error(validation.transport_error || 'Key validation failed');
      const reservation = await store.update((state) => reserveFetch(state, id, { now, runId: options['run-id'] }));
      let envelope;
      try { envelope = await network('fsrar', reservation.job); }
      catch { envelope = { transport_error: 'Network helper did not return a valid response', attempted: true }; }
      return store.update((state) => {
        const failure = responseFailure(envelope);
        if (failure) {
          const job = requireJob(state, id);
          const retry = planRetry({ ...job, status: 'waiting' }, { now, timeZone: state.config.timeZone });
          return { ...summary(recordFailure(state, id, { ...failure, now, reservation: reservation.reservation,
            nextCheckAt: retry.nextCheckAt, terminal: retry.status === 'review' })), apiBlocked: Boolean(state.api.blocked) };
        }
        const job = recordResponse(state, id, envelope, { now, reservation: reservation.reservation });
        return { ...summary(job), records: job.apiItems.length, incomplete: job.apiIncomplete };
      });
    }
    case 'import-response': {
      const envelope = await readJson('file');
      if (responseFailure(envelope.response ? envelope : { http_status: 200, response: envelope })) throw new Error('The imported response is not a successful API result');
      return store.update((state) => {
        const job = recordResponse(state, required('job'), envelope, { now, importedFrom: path.resolve(required('file')) });
        return { ...summary(job), records: job.apiItems.length };
      });
    }
    case 'plan': {
      const context = rowsOf(await readJson('context'));
      return store.update((state) => {
        const job = requireJob(state, required('job'));
        if (!['fetched', 'planned'].includes(job.status)) throw new Error('Fetch or import a successful API response first');
        if (job.apiIncomplete) return summary(recordFailure(state, job.id, { code: 'incomplete_api_pagination', terminal: true, now }));
        const selection = selectLicense(job, job.apiItems);
        if (selection.status === 'waiting') return summary(retryFor(job, selection.reason, state));
        if (selection.status !== 'ready') return summary(recordFailure(state, job.id, { code: selection.reason, terminal: true, now }));
        job.selectedLicense = selection.license;
        const plan = planSheetUpsert(selection.license, context.rows, job);
        if (plan.action === 'waiting') return summary(retryFor(job, plan.reason, state));
        if (plan.action === 'review') return summary(recordFailure(state, job.id, { code: plan.reason, terminal: true, now }));
        if (plan.action === 'append') { plan.rowNumber = appendRowOf(context); plan.updates = plan.updates.map((u) => ({ ...u, row: plan.rowNumber })); }
        const saved = savePlan(state, job.id, plan, { expectedCells: expectedCells(plan, job), now });
        return { job: summary(job), plan: saved };
      });
    }
    case 'ack': {
      const receipt = await readJson('receipt');
      // Google may display existing dates as dd.mm.yyyy; compare their calendar values.
      if (receipt.cells) for (const [cell, value] of Object.entries(receipt.cells)) if (/^[IJ]\d+$/u.test(cell)) receipt.cells[cell] = normalizeDate(value) ?? value;
      return store.update((state) => { const result = acknowledge(state, required('job'), receipt, { now }); return { alreadyDone: result.alreadyDone, job: summary(result.job) }; });
    }
    case 'retry':
      return store.update((state) => summary(retryFor(requireJob(state, required('job')), required('error'), state)));
    case 'unblock':
      return store.update((state) => { clearApiBlock(state, { reason: required('reason'), nextCheckAt: now, now }); return stateSummary(state); });
    case 'checkpoint':
      return store.update((state) => {
        const chat = required('chat'); const message = required('message'); const date = required('date');
        if (!Number.isFinite(Date.parse(date))) throw new Error('A valid checkpoint date is required');
        const previous = state.cursors[chat];
        if (previous && Date.parse(date) < Date.parse(previous.date)) throw new Error('A checkpoint cannot move backwards');
        state.cursors[chat] = { messageId: message, date, updatedAt: now };
        state.journal.push({ at: now, type: 'source_checkpoint', chatId: chat, before: previous ?? null, after: state.cursors[chat] });
        return state.cursors[chat];
      });
    default: throw new Error('Unknown command; run help');
  }
}

try { console.log(JSON.stringify(await main(), null, 2)); }
catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
