'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

function invalid() { return new Error('В выгрузке есть сообщение с некорректным номером или датой.'); }
function normalize(message) {
  const id = Number(message.id), date = message.date && typeof message.date.getTime === 'function' ? message.date.getTime() : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(date) || new Date(date).getUTCFullYear() < 1 || new Date(date).getUTCFullYear() > 9999) throw invalid();
  const reply = message.reply ? Number(message.reply) : null;
  if (reply !== null && (!Number.isSafeInteger(reply) || reply <= 0)) throw invalid();
  const authorId = message.authorId == null ? null : String(message.authorId);
  if (authorId !== null && (!/^\d+$/.test(authorId) || BigInt(authorId) > 9223372036854775807n)) throw invalid();
  return { id, date, author: String(message.author || ''), authorId, sender: String(message.sender || ''), mgid: message.mgid ? String(message.mgid) : null,
    text: String(message.text || ''), media: !!message.media, reply };
}
async function* lines(file, range) {
  const input = fs.createReadStream(file, { highWaterMark: 64 * 1024, ...(range || {}) });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of reader) if (line) yield line; }
  finally { reader.close(); input.destroy(); }
}
function compare(a, b) { return a.id - b.id || a.source - b.source || a.sequence - b.sequence; }
class Heap {
  constructor() { this.values = []; }
  push(value) { const a = this.values; a.push(value); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (compare(a[p].key, value.key) <= 0) break; a[i] = a[p]; i = p; } a[i] = value; }
  pop() { const a = this.values, first = a[0], last = a.pop(); if (!a.length) return first; let i = 0; while (i * 2 + 1 < a.length) { let c = i * 2 + 1; if (c + 1 < a.length && compare(a[c + 1].key, a[c].key) < 0) c++; if (compare(last.key, a[c].key) <= 0) break; a[i] = a[c]; i = c; } a[i] = last; return first; }
}
function writer(handle) {
  let chunks = [], bytes = 0;
  async function flush() { if (chunks.length) { const text = chunks.join(''); chunks = []; bytes = 0; await handle.writeFile(text); } }
  return { async write(line) { chunks.push(line); bytes += Buffer.byteLength(line); if (bytes >= 64 * 1024) await flush(); }, flush };
}
async function merge(files, target, observe, check) {
  const iterators = files.map(file => lines(file)[Symbol.asyncIterator]()), heap = new Heap(), handle = await fsp.open(target, 'wx', 0o600), output = writer(handle);
  try {
    for (let index = 0; index < iterators.length; index++) { check(); const next = await iterators[index].next(); if (!next.done) heap.push({ index, key: JSON.parse(next.value) }); }
    if (observe) observe({ readers: iterators.length, heads: heap.values.length, headBytes: heap.values.reduce((sum,item) => sum + Buffer.byteLength(JSON.stringify(item.key)), 0) });
    while (heap.values.length) {
      check();
      const item = heap.pop(); await output.write(JSON.stringify(item.key) + '\n');
      const next = await iterators[item.index].next(); if (!next.done) heap.push({ index: item.index, key: JSON.parse(next.value) });
    }
    await output.flush();
  } finally { await Promise.allSettled(iterators.map(iterator => iterator.return())); await handle.close(); }
}
async function payloadRecord(handle, key) {
  const buffer = Buffer.allocUnsafe(key.length); let position = 0;
  while (position < buffer.length) { const result = await handle.read(buffer, position, buffer.length - position, key.offset + position); if (!result.bytesRead) throw new Error('Не удалось прочитать подготовленный импорт.'); position += result.bytesRead; }
  return JSON.parse(buffer.toString('utf8'));
}

async function prepareReportImport(files, options) {
  const chunkBytes = options.chunkBytes || 2 * 1024 * 1024, fanIn = options.maxOpenRuns || 32, fileBytes = options.fileBytes || 50 * 1024 * 1024;
  if (!Array.isArray(files) || files.length > 50 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || !Number.isSafeInteger(fanIn) || fanIn < 2 || fanIn > 64) throw new Error('Проверьте файлы импорта.');
  const directory = await fsp.mkdtemp(path.join(options.parentDirectory || os.tmpdir(), 'zamery-import-spool-'));
  const payloadPath = path.join(directory, 'payload.jsonl'), sortedPath = path.join(directory, 'sorted.jsonl'), groupsPath = path.join(directory, 'groups.jsonl');
  let payload, indexHandle, groupsHandle, payloadReader;
  function check() { if (options.isAborted && options.isAborted()) throw Object.assign(new Error('Импорт прерван.'), { code: 'UPLOAD_ABORTED' }); }
  try {
    await fsp.chmod(directory, 0o700);
    payload = await fsp.open(payloadPath, 'wx', 0o600);
    let offset = 0, chunkSize = 0, chunk = [], runs = [], runNumber = 0;
    async function flush() {
      if (!chunk.length) return;
      chunk.sort(compare); const run = path.join(directory, 'run-' + runNumber++ + '.jsonl');
      await fsp.writeFile(run, chunk.map(key => JSON.stringify(key) + '\n').join(''), { flag: 'wx', mode: 0o600 });
      runs.push(run); if (options.observe) options.observe({ chunkRecords: chunk.length, chunkBytes: chunkSize });
      chunk = []; chunkSize = 0;
    }
    for (let source = 0; source < files.length; source++) {
      check();
      const file = files[source], stat = await fsp.stat(file.path);
      if (stat.size > fileBytes) throw new Error('Каждый файл импорта должен быть не больше 50 МБ.');
      let buffer = await fsp.readFile(file.path), messages = options.parseExport(buffer, file.originalname);
      buffer = null;
      if (!Array.isArray(messages)) throw invalid();
      for (let index = 0; index < messages.length; index++) {
        check();
        const message = normalize(messages[index]), line = JSON.stringify(message) + '\n', length = Buffer.byteLength(line);
        await payload.writeFile(line);
        const key = { id: message.id, source, sequence: index, offset, length }; offset += length;
        chunk.push(key); chunkSize += Buffer.byteLength(JSON.stringify(key)) + 1;
        messages[index] = null;
        if (chunkSize >= chunkBytes) await flush();
      }
      messages = null;
    }
    await flush(); await payload.close(); payload = null;
    // Merge only small keys and disk offsets. Holding full record heads here
    // could otherwise multiply a 50 MiB caption by all open run readers.
    while (runs.length > 1) {
      check();
      const next = [];
      for (let index = 0; index < runs.length; index += fanIn) {
        check();
        const group = runs.slice(index, index + fanIn), target = path.join(directory, 'merge-' + runNumber++ + '.jsonl');
        await merge(group, target, options.observe, check); next.push(target); await Promise.all(group.map(file => fsp.unlink(file)));
      }
      runs = next;
    }
    indexHandle = await fsp.open(sortedPath, 'wx', 0o600); groupsHandle = await fsp.open(groupsPath, 'wx', 0o600); payloadReader = await fsp.open(payloadPath, 'r');
    const indexes = writer(indexHandle), groups = writer(groupsHandle);
    let current = null, lastId = null, messageCount = 0, indexOffset = 0;
    if (runs.length) for await (const line of lines(runs[0])) {
      check();
      const key = JSON.parse(line);
      if (key.id === lastId) continue;
      lastId = key.id; messageCount++;
      const message = await payloadRecord(payloadReader, key);
      if (!message.text && !message.media) continue;
      const author = message.author || 'аудитор', elapsed = current ? message.date - current.last : Infinity;
      const together = current && (message.mgid && message.mgid === current.mgid ||
        (message.sender || author) === current.sender && elapsed >= 0 && elapsed <= 180000 && (message.reply || null) === current.reply && !options.startsReport(message.text));
      if (!together) {
        if (current) await groups.write(JSON.stringify(current) + '\n');
        current = { start: indexOffset, end: indexOffset, firstId: message.id, count: 0, author, authorId: message.authorId,
          sender: message.sender || author, mgid: message.mgid, date: message.date, last: message.date, reply: message.reply || null };
      }
      current.count++; current.last = message.date; current.mgid = current.mgid || message.mgid || null;
      const indexLine = JSON.stringify(key) + '\n'; await indexes.write(indexLine); indexOffset += Buffer.byteLength(indexLine); current.end = indexOffset;
    }
    if (current) await groups.write(JSON.stringify(current) + '\n');
    await indexes.flush(); await groups.flush(); await indexHandle.close(); indexHandle = null; await groupsHandle.close(); groupsHandle = null; await payloadReader.close(); payloadReader = null;
    await Promise.all(runs.map(file => fsp.unlink(file)));
    return {
      directory, messageCount,
      async *groups() { for await (const line of lines(groupsPath)) yield JSON.parse(line); },
      async *ids(group) { for await (const line of lines(sortedPath, { start: group.start, end: group.end - 1 })) yield { id: JSON.parse(line).id }; },
      async *records(group) {
        const handle = await fsp.open(payloadPath, 'r');
        try { for await (const line of lines(sortedPath, { start: group.start, end: group.end - 1 })) { const record = await payloadRecord(handle, JSON.parse(line)); record.date = new Date(record.date); yield record; } }
        finally { await handle.close(); }
      },
      async cleanup() { await fsp.rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    await Promise.allSettled([payload, indexHandle, groupsHandle, payloadReader].filter(Boolean).map(handle => handle.close()));
    await fsp.rm(directory, { recursive: true, force: true }); throw error;
  }
}

module.exports = { prepareReportImport };
