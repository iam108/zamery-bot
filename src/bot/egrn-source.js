'use strict';

// The API embeds complete PDF/ZIP files in JSON strings. Never collect that
// response (or an uncompressed archive entry) in a JavaScript string/Buffer.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const Parser = require('stream-json/Parser');
const yauzl = require('yauzl');

const MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const IO_BYTES = 64 * 1024;
const META_BYTES = 2 * 1024 * 1024;
const STRING_BYTES = 64 * 1024;
const MAX_FILES = 32;
const PREFIX = 'zamery-egrn-source-';

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function abort(signal) { if (signal?.aborted) throw failure('EGRN_SOURCE_ABORTED', 'Получение выписки прервано. Повторим попытку.'); }
function typeOf(prefix) {
  if (prefix.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'pdf';
  if (['504b0304', '504b0506', '504b0708'].includes(prefix.subarray(0, 4).toString('hex'))) return 'zip';
  throw failure('EGRN_FILE_TYPE', 'Сервис не передал оригинал выписки в PDF или ZIP.');
}

async function createWorkspace(options = {}) {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new TypeError('Invalid EGRN file limit');
  const root = options.root || os.tmpdir();
  const directory = await fsp.mkdtemp(path.join(root, PREFIX));
  const opened = new Set(), originals = new Map(); let used = 0, closed = false;
  async function dispose() {
    if (closed) return; closed = true;
    await Promise.allSettled([...opened].map(handle => handle.close())); opened.clear();
    await fsp.rm(directory, { recursive: true, force: true });
  }
  async function writer() {
    if (closed) throw failure('EGRN_SOURCE_CLOSED', 'Временный файл выписки уже закрыт.');
    const filename = path.join(directory, randomUUID());
    const handle = await fsp.open(filename, 'wx', 0o600); opened.add(handle);
    const hash = createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0), finished = false;
    async function write(content) {
      abort(options.signal);
      if (closed || finished) throw failure('EGRN_SOURCE_CLOSED', 'Временный файл выписки уже закрыт.');
      if (!(Buffer.isBuffer(content) || content instanceof Uint8Array)) throw new TypeError('Invalid file chunk');
      bytes += content.byteLength; used += content.byteLength;
      if (bytes > maxBytes || used > maxBytes * 2) throw failure('EGRN_FILE_TOO_LARGE', 'Выписка превышает допустимый объём 2 ГБ.');
      if (prefix.length < 8) prefix = Buffer.concat([prefix, content.subarray(0, 8 - prefix.length)]);
      hash.update(content);
      for (let offset = 0; offset < content.byteLength;) {
        let result;
        try { result = await handle.write(content, offset, content.byteLength - offset); }
        catch (error) {
          if (error.code === 'ENOSPC') throw failure('EGRN_SOURCE_SPACE', 'Недостаточно места для получения выписки. Повторим попытку.');
          throw failure('EGRN_SOURCE_WRITE', 'Не удалось сохранить оригинал выписки. Повторим попытку.');
        }
        if (!result.bytesWritten) throw failure('EGRN_SOURCE_WRITE', 'Не удалось сохранить оригинал выписки.');
        offset += result.bytesWritten;
      }
    }
    async function finish() {
      abort(options.signal); const kind = typeOf(prefix);
      await handle.close(); opened.delete(handle); finished = true;
      const sha256 = hash.digest('hex');
      // A provider may repeat the same complete document in several historical
      // statuses. Release that copy before receiving the next embedded file.
      const identity = kind + ':' + bytes + ':' + sha256;
      if (originals.has(identity)) { await fsp.unlink(filename); used -= bytes; return originals.get(identity); }
      if (originals.size >= MAX_FILES) throw failure('EGRN_SOURCE_FILES', 'Сервис передал слишком много файлов для одного заказа.');
      const result = { bytes, sha256, kind,
        open() {
          if (closed) throw failure('EGRN_SOURCE_CLOSED', 'Временный файл выписки уже закрыт.');
          return fs.createReadStream(filename, { highWaterMark: 1024 * 1024, signal: options.signal });
        },
        // Private to this module; never copied into raw API data or a message.
        localPath: filename
      };
      originals.set(identity, result); return result;
    }
    return { write, finish };
  }
  async function save(source, expectedBytes) {
    const out = await writer(); let bytes = 0;
    for await (const chunk of source) { bytes += chunk.byteLength; await out.write(chunk); }
    if (expectedBytes != null && bytes !== expectedBytes) throw failure('EGRN_SOURCE_INCOMPLETE', 'Сервис передал выписку не полностью. Повторим скачивание.');
    return out.finish();
  }
  return { writer, save, dispose, maxBytes };
}

function base64Writer(workspace) {
  let encoded = '', out;
  async function flush(last) {
    if (!out) out = await workspace.writer();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw failure('EGRN_SOURCE_BASE64', 'Сервис передал повреждённый файл выписки.');
    const padding = encoded.indexOf('=');
    let count = last ? encoded.length : Math.floor((padding < 0 ? encoded.length : padding) / 4) * 4;
    if (last && (encoded.length % 4 === 1 || padding >= 0 && (encoded.length % 4 !== 0 || padding < encoded.length - 2))) {
      throw failure('EGRN_SOURCE_BASE64', 'Сервис передал повреждённый файл выписки.');
    }
    if (count) { await out.write(Buffer.from(encoded.slice(0, count), 'base64')); encoded = encoded.slice(count); }
    if (!last && encoded.length > 4) throw failure('EGRN_SOURCE_BASE64', 'Сервис передал повреждённый файл выписки.');
  }
  return {
    async append(value) {
      encoded += value.replace(/\s+/g, '');
      if (encoded.length >= IO_BYTES) await flush(false);
    },
    async finish() { await flush(true); return out.finish(); }
  };
}

function selectRequest(data, idReq) {
  const matches = []; const wanted = String(idReq); let otherRequests = false;
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'id_req')) {
      if (String(value.id_req) === wanted) { matches.push(value); return; }
      otherRequests = true;
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(data);
  if (matches.length === 1) return matches[0];
  // Some versions return the requested status directly, without its id_req.
  // A collection or an explicitly different request must never be a fallback.
  if (!matches.length && !otherRequests && data && !Array.isArray(data) && !Object.hasOwn(data, 'id_req') && Object.hasOwn(data, 'status')) return data;
  throw failure('EGRN_SOURCE_REQUEST', 'В ответе сервиса нет однозначного результата нужного заказа.');
}

async function parseResponse(body, workspace, options) {
  let sourceBytes = 0;
  async function* incoming() {
    for await (const chunk of body) { sourceBytes += chunk.byteLength; yield chunk; }
  }
  const input = Readable.from(incoming(), { objectMode: false });
  const parser = new Parser({ packKeys: false, packStrings: false, packNumbers: false,
    streamKeys: true, streamStrings: true, streamNumbers: true });
  // Handle the pump's rejection immediately while consuming tokens. Destroying
  // either side on error also cancels an in-flight HTTP response body.
  const pumping = pipeline(input, parser, { signal: options.signal }); pumping.catch(() => {});
  const stack = [], files = new WeakMap(); let root, string, key, number, meta = 0, nodes = 0;
  function charge(bytes) {
    meta += bytes; if (meta > META_BYTES || ++nodes > 100000) throw failure('EGRN_SOURCE_METADATA', 'Слишком большой служебный ответ сервиса ЕГРН.');
  }
  function put(value) {
    charge(8); const parent = stack[stack.length - 1];
    if (!parent) { root = value; return; }
    if (Array.isArray(parent.value)) parent.value.push(value);
    else { Object.defineProperty(parent.value, parent.key, { value, writable: true, configurable: true, enumerable: true }); parent.key = undefined; }
  }
  try {
    for await (const token of parser) {
      abort(options.signal);
      switch (token.name) {
        case 'startObject': case 'startArray': {
          if (stack.length >= 64) throw failure('EGRN_SOURCE_METADATA', 'Слишком сложный служебный ответ сервиса ЕГРН.');
          const value = token.name === 'startObject' ? Object.create(null) : []; put(value); stack.push({ value }); break;
        }
        case 'endObject': case 'endArray': stack.pop(); break;
        case 'startKey': key = ''; break;
        case 'endKey': charge(Buffer.byteLength(key)); stack[stack.length - 1].key = key; key = undefined; break;
        case 'startNumber': number = ''; break;
        case 'numberChunk': number += token.value; if (number.length > 128) throw failure('EGRN_SOURCE_METADATA', 'Некорректное число в ответе сервиса ЕГРН.'); break;
        case 'endNumber': put(Number(number)); number = undefined; break;
        case 'trueValue': case 'falseValue': case 'nullValue': put(token.value); break;
        case 'startString': string = { value: '', mode: 'probe' }; break;
        case 'stringChunk': {
          if (key !== undefined) { key += token.value; if (key.length > 512) throw failure('EGRN_SOURCE_METADATA', 'Некорректное поле ответа сервиса ЕГРН.'); break; }
          if (string.mode === 'file') { await string.writer.append(token.value); break; }
          string.value += token.value;
          if (string.mode === 'probe') {
            const prefix = string.value.replace(/\s+/g, '');
            if (prefix.length >= 8) {
              if (/^(JVBER|UEsDB|UEsFB|UEsHC)/.test(prefix)) {
                string.mode = 'file'; string.writer = base64Writer(workspace);
                await string.writer.append(string.value); string.value = ''; break;
              }
              string.mode = 'text';
            }
          }
          if (string.value.length > STRING_BYTES) throw failure('EGRN_SOURCE_METADATA', 'Слишком длинное служебное поле сервиса ЕГРН.');
          break;
        }
        case 'endString': {
          if (string.mode === 'file') {
            const file = await string.writer.finish(), marker = { type: 'Файл выписки', bytes: file.bytes, sha256: file.sha256 };
            files.set(marker, file); put(marker);
          } else { charge(Buffer.byteLength(string.value)); put(string.value); }
          string = undefined; break;
        }
      }
    }
    await pumping;
    const item = selectRequest(root, options.idReq), selected = [], seen = new Set();
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      if (Object.hasOwn(value, 'id_req') && String(value.id_req) !== String(options.idReq)) return;
      const file = files.get(value);
      if (file) {
        if (!seen.has(file.sha256)) { selected.push(file); seen.add(file.sha256); }
        return;
      }
      for (const child of Object.values(value)) collect(child);
    }
    collect(item);
    if (selected.length > MAX_FILES) throw failure('EGRN_SOURCE_FILES', 'Сервис передал слишком много файлов для одного заказа.');
    function ownRequest(value) {
      if (!value || typeof value !== 'object') return value;
      if (Object.hasOwn(value, 'id_req') && String(value.id_req) !== String(options.idReq)) return undefined;
      const result = Array.isArray(value) ? [] : Object.create(null);
      for (const [key, child] of Object.entries(value)) {
        const clean = ownRequest(child);
        if (clean !== undefined) {
          if (Array.isArray(result)) result.push(clean);
          else Object.defineProperty(result, key, { value: clean, enumerable: true, writable: true, configurable: true });
        }
      }
      return result;
    }
    // URL fallback and persisted metadata must obey the same request boundary
    // as embedded documents, including historical nested request objects.
    return { item: ownRequest(item), files: selected };
  } catch (error) {
    input.destroy(); parser.destroy(); await pumping.catch(() => {});
    if (error.code?.startsWith('EGRN_')) throw error;
    if (error.code === 'ENOSPC') throw failure('EGRN_SOURCE_SPACE', 'Недостаточно места для получения выписки. Повторим попытку.');
    const problem = failure('EGRN_SOURCE_RESPONSE', 'Не удалось полностью прочитать ответ сервиса ЕГРН. Повторим попытку.');
    const safe = value => typeof value === 'string' && /^[A-Za-z\d_]{1,80}$/.test(value) ? value : undefined;
    problem.source_code = safe(error.code) || safe(error.cause?.code) || 'INCOMPLETE_RESPONSE';
    problem.source_name = safe(error.name) || 'Error'; problem.source_bytes = sourceBytes;
    throw problem;
  }
}

const nativeCrc32 = require('node:zlib').crc32;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buffer, previous = 0) {
  if (nativeCrc32) return nativeCrc32(buffer, previous);
  let value = previous ^ -1;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ -1) >>> 0;
}

async function documents(files, workspace, cad) {
  const base = 'ЕГРН_' + String(cad || 'vypiska').replace(/:/g, '-'), docs = [], hashes = new Set();
  function add(file, name) {
    if (hashes.has(file.sha256)) return; hashes.add(file.sha256);
    docs.push({ name, kind: file.kind, bytes: file.bytes, sha256: file.sha256, open: file.open });
  }
  for (const [index, file] of files.entries()) {
    if (file.kind === 'pdf') { add(file, base + (index ? '_' + index : '') + '.pdf'); continue; }
    let zip, extracted = [];
    try {
      zip = await yauzl.openPromise(file.localPath, { validateEntrySizes: true });
      let entries = 0, total = 0;
      for await (const entry of zip.eachEntry()) {
        if (++entries > 10000) throw failure('EGRN_SOURCE_ARCHIVE', 'В архиве слишком много файлов.');
        if (!/\.pdf$/i.test(entry.fileName) || /\/$/.test(entry.fileName)) continue;
        if (extracted.length >= MAX_FILES || entry.uncompressedSize > workspace.maxBytes || (total += entry.uncompressedSize) > workspace.maxBytes) throw failure('EGRN_SOURCE_ARCHIVE', 'Слишком большой объём графики в архиве выписки.');
        const input = await zip.openReadStreamPromise(entry); let crc = 0;
        async function* content() {
          for await (const chunk of input) { crc = crc32(chunk, crc); yield chunk; }
        }
        const pdf = await workspace.save(content(), entry.uncompressedSize);
        if (pdf.kind !== 'pdf' || crc !== entry.crc32) throw failure('EGRN_SOURCE_ARCHIVE', 'Повреждена графика в архиве выписки.');
        extracted.push(pdf);
      }
      if (!extracted.length) throw failure('EGRN_SOURCE_ARCHIVE', 'В архиве нет PDF.');
    } catch (error) {
      if (['EGRN_SOURCE_ABORTED', 'EGRN_SOURCE_SPACE', 'EGRN_SOURCE_WRITE', 'EGRN_FILE_TOO_LARGE'].includes(error.code)) throw error;
      extracted = [];
    }
    finally { zip?.close(); }
    // Preserve the full provider ZIP if its PDF cannot safely be extracted.
    if (!extracted.length) add(file, base + (index ? '_' + index : '') + '.zip');
    else for (const [j, pdf] of extracted.entries()) add(pdf, base + (extracted.length > 1 ? '_' + (j + 1) : index ? '_' + index : '') + '.pdf');
  }
  return docs;
}

async function readStatusResponse(body, options = {}) {
  const workspace = await createWorkspace(options);
  try {
    const result = await parseResponse(body, workspace, options);
    return { item: result.item, hasFiles: result.files.length > 0,
      documents: cad => documents(result.files, workspace, cad), cleanup: () => workspace.dispose() };
  } catch (error) { await workspace.dispose(); throw error; }
}

async function readFileResponse(body, name, options = {}) {
  const workspace = await createWorkspace(options);
  try {
    const file = await workspace.save(body, options.expectedBytes);
    return { file: { name, kind: file.kind, bytes: file.bytes, sha256: file.sha256, open: file.open }, cleanup: () => workspace.dispose() };
  } catch (error) { await workspace.dispose(); throw error; }
}

// Leftovers can only be this process's private temporary directories. Active
// downloads have a 20-minute deadline, so an age of 24 hours is conservative.
async function cleanupStale(root = os.tmpdir(), now = Date.now()) {
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const target = path.join(root, entry.name), info = await fsp.lstat(target);
    if (!info.isSymbolicLink() && now - info.mtimeMs > 24 * 60 * 60 * 1000) await fsp.rm(target, { recursive: true, force: true });
  }
}

module.exports = { MAX_BYTES, readStatusResponse, readFileResponse, cleanupStale, selectRequest };
