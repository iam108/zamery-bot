const { createHash, randomUUID } = require('node:crypto');

const MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1; // PostgreSQL INTEGER upper bound.
const CHUNK_BYTES = 1024 * 1024;
const DIRECT_MIGRATION_BYTES = 50 * 1024 * 1024;
const UUID_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
const COLUMNS = 'id,egrn_order_id,source_key,name,mime,bytes,sha256,storage,object_key';
const DDL = `
  CREATE TABLE IF NOT EXISTS egrn_files (
    id UUID PRIMARY KEY,
    egrn_order_id BIGINT NOT NULL CHECK(egrn_order_id > 0),
    source_key TEXT NOT NULL CHECK(length(source_key) BETWEEN 1 AND 512),
    name TEXT NOT NULL,
    mime TEXT NOT NULL CHECK(mime IN ('application/pdf','application/zip')),
    bytes INTEGER NOT NULL CONSTRAINT egrn_files_bytes_check CHECK(bytes BETWEEN 1 AND ${MAX_BYTES}),
    sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(egrn_order_id,source_key,sha256)
  );
  ALTER TABLE egrn_files DROP CONSTRAINT IF EXISTS egrn_files_bytes_check;
  ALTER TABLE egrn_files ADD CONSTRAINT egrn_files_bytes_check CHECK(bytes BETWEEN 1 AND ${MAX_BYTES});
  ALTER TABLE egrn_files ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'postgres';
  ALTER TABLE egrn_files ADD COLUMN IF NOT EXISTS object_key TEXT;
  ALTER TABLE egrn_files DROP CONSTRAINT IF EXISTS egrn_files_storage_check;
  ALTER TABLE egrn_files ADD CONSTRAINT egrn_files_storage_check CHECK(storage IN ('postgres','s3'));
  CREATE INDEX IF NOT EXISTS egrn_files_order ON egrn_files(egrn_order_id,created_at,id);
  CREATE TABLE IF NOT EXISTS egrn_file_chunks (
    file_id UUID NOT NULL REFERENCES egrn_files(id) ON DELETE CASCADE,
    chunk_no INTEGER NOT NULL CHECK(chunk_no >= 0),
    content BYTEA NOT NULL CHECK(octet_length(content) BETWEEN 1 AND ${CHUNK_BYTES}),
    PRIMARY KEY(file_id,chunk_no)
  );
`;
function error(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function orderId(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) throw error(400, 'EGRN_FILE_ORDER', 'Некорректный номер заказа выписки.');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw error(400, 'EGRN_FILE_ORDER', 'Некорректный номер заказа выписки.');
  return id;
}
function validId(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function sourceKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\p{Cc}\p{Cf}]/u.test(value) ||
      /[a-z][a-z\d+.-]*:\/\/|[?&=]|(?:authorization|password|secret|token|api[_-]?key)\s*[:=]|^armrus:/i.test(value)) {
    throw error(400, 'EGRN_FILE_SOURCE', 'Некорректный идентификатор файла выписки.');
  }
  return value.trim();
}
function fileType(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw error(400, 'EGRN_FILE_EMPTY', 'Файл выписки пуст или не получен.');
  if (buffer.length > MAX_BYTES) throw error(413, 'EGRN_FILE_TOO_LARGE', 'Файл выписки превышает допустимый размер.');
  if (buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { mime: 'application/pdf', extension: 'pdf' };
  if (['504b0304', '504b0506', '504b0708'].includes(buffer.subarray(0, 4).toString('hex'))) return { mime: 'application/zip', extension: 'zip' };
  throw error(415, 'EGRN_FILE_TYPE', 'Сохранить можно только оригинал выписки в PDF или ZIP.');
}
function streamDetails(input) {
  const bytes = input?.bytes;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw error(400, 'EGRN_FILE_SIZE', 'Не указан корректный размер файла выписки.');
  if (bytes > MAX_BYTES) throw error(413, 'EGRN_FILE_TOO_LARGE', 'Файл выписки превышает допустимый размер.');
  if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(input.sha256)) throw error(400, 'EGRN_FILE_HASH', 'Не указана контрольная сумма файла выписки.');
  if (typeof input.open !== 'function' && typeof input.chunks?.[Symbol.asyncIterator] !== 'function') throw error(400, 'EGRN_FILE_STREAM', 'Не получен поток оригинала выписки.');
  return { bytes, sha256: input.sha256.toLowerCase() };
}
function cancelled() { return error(499, 'EGRN_FILE_CANCELLED', 'Сохранение оригинала выписки отменено.'); }
async function streamReader(input, bytes) {
  const signal = input.signal;
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw error(400, 'EGRN_FILE_STREAM', 'Некорректный сигнал отмены сохранения.');
  let done = false, closed = false, part = null, offset = 0, received = 0, produced = 0, rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  abortPromise.catch(() => {});
  const abort = () => rejectAbort(cancelled());
  signal?.addEventListener('abort', abort, { once: true });
  function check() { if (closed || signal?.aborted) throw cancelled(); }
  let source, iterator;
  try {
    check();
    const opening = Promise.resolve().then(() => typeof input.open === 'function' ? input.open() : input.chunks);
    // If an asynchronous opener settles after cancellation, release the late
    // source without keeping the transaction or a network/file handle alive.
    opening.then(value => {
      if (!signal?.aborted) return;
      try { value?.destroy?.(); } catch (_) {}
      try { Promise.resolve(value?.[Symbol.asyncIterator]?.().return?.()).catch(() => {}); } catch (_) {}
    }).catch(() => {});
    source = await Promise.race([opening, abortPromise]); check();
    if (typeof source?.[Symbol.asyncIterator] !== 'function') throw error(400, 'EGRN_FILE_STREAM', 'Не получен поток оригинала выписки.');
    iterator = source[Symbol.asyncIterator]();
  } catch (failure) { signal?.removeEventListener('abort', abort); throw failure; }
  async function load() {
    while (!part || offset === part.length) {
      check();
      if (done) return false;
      const next = await Promise.race([Promise.resolve().then(() => iterator.next()), abortPromise]);
      check();
      if (next.done) { done = true; return false; }
      if (!(Buffer.isBuffer(next.value) || next.value instanceof Uint8Array)) throw error(400, 'EGRN_FILE_STREAM', 'Поток выписки содержит некорректные данные.');
      part = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength); offset = 0;
      received += part.length;
      if (received > MAX_BYTES) throw error(413, 'EGRN_FILE_TOO_LARGE', 'Файл выписки превышает допустимый размер.');
      if (received > bytes) throw error(409, 'EGRN_FILE_SIZE', 'Размер оригинала выписки не совпадает с заявленным.');
    }
    return true;
  }
  return {
    check,
    async next() {
      check();
      if (produced === bytes) { if (await load()) throw error(409, 'EGRN_FILE_SIZE', 'Размер оригинала выписки не совпадает с заявленным.'); return null; }
      const content = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, bytes - produced)); let written = 0;
      while (written < content.length && await load()) {
        const length = Math.min(content.length - written, part.length - offset);
        part.copy(content, written, offset, offset + length); written += length; offset += length;
      }
      if (written !== content.length) throw error(409, 'EGRN_FILE_SIZE', 'Оригинал выписки получен не полностью.');
      produced += written; return content;
    },
    async close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', abort);
      if (!done) {
        try { if (typeof source.destroy === 'function') source.destroy(); } catch (_) {}
        try {
          // An async generator may queue return() behind a stalled next().
          // Request cleanup without restoring an unbounded wait after timeout;
          // check() prevents any late chunk from reviving this reader.
          Promise.resolve(iterator.return?.()).catch(() => {});
        } catch (_) {}
      }
    }
  };
}
function filename(value, extension) {
  let name = typeof value === 'string' ? value.normalize('NFC').split(/[?#]/)[0].split(/[\\/]/).pop() : '';
  name = name.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/[<>:"|*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '');
  name = name.replace(/\.[a-z\d]{1,8}$/i, '').replace(/[.\s]+$/, '');
  if (!name) name = 'Выписка ЕГРН';
  let shortened = '';
  for (const character of name) {
    if (Buffer.byteLength(shortened + character) > 200) break;
    shortened += character;
  }
  return shortened + '.' + extension;
}
function fileId(order, key, sha256) {
  const hash = createHash('sha1').update(UUID_NAMESPACE).update(JSON.stringify(['egrn-file-v1', String(order), key, sha256])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
function metadata(row) {
  return { id: row.id, name: row.name, mime: row.mime, bytes: Number(row.bytes), sha256: row.sha256,
    egrn_order_id: Number(row.egrn_order_id), source_key: row.source_key };
}
function createEgrnFileStore(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  let ready;
  const objects = options.objectStore === undefined ? require('./egrn-object-store').createEgrnObjectStore() : options.objectStore;
  async function ensure() {
    if (!ready) ready = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(108,17)');
        await client.query(DDL);
        await client.query('COMMIT');
      } catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; }
      finally { client.release(); }
    })().catch(failure => { ready = null; throw failure; });
    return ready;
  }
  async function save(input) {
    orderId(input?.egrn_order_id); sourceKey(input?.source_key);
    const buffer = input?.buffer; fileType(buffer);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    return saveStream({ ...input, bytes: buffer.length, sha256, open: async function* () { yield buffer; } });
  }
  async function saveStream(input) {
    if (objects && objects.configured()) return saveObjectStream(input);
    return savePostgresStream(input);
  }
  async function savePostgresStream(input) {
    const order = orderId(input?.egrn_order_id), key = sourceKey(input?.source_key);
    const { bytes, sha256 } = streamDetails(input), id = fileId(order, key, sha256);
    if (input.signal?.aborted) throw cancelled();
    await ensure();
    const client = await pool.connect(); let reader;
    try {
      await client.query('BEGIN');
      // Serialize identical content before opening a potentially expensive source.
      const compact = id.replace(/-/g, '');
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [parseInt(compact.slice(0, 8), 16) | 0, parseInt(compact.slice(8, 16), 16) | 0]);
      if (input.signal?.aborted) throw cancelled();
      const existing = (await client.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
      if (existing) {
        if (Number(existing.egrn_order_id) !== order || existing.source_key !== key || existing.sha256 !== sha256 || Number(existing.bytes) !== bytes) throw error(409, 'EGRN_FILE_CONFLICT', 'Не удалось подтвердить ранее сохранённый файл выписки.');
        await client.query('COMMIT'); return metadata(existing);
      }
      reader = await streamReader(input, bytes);
      let content = await reader.next();
      const type = fileType(content), name = filename(input.name, type.extension);
      const inserted = await client.query(`INSERT INTO egrn_files(${COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,'postgres',NULL) ON CONFLICT(id) DO NOTHING RETURNING ${COLUMNS}`,
        [id, order, key, name, type.mime, bytes, sha256]);
      let result;
      if (inserted.rows.length) {
        const writtenHash = createHash('sha256');
        for (let chunk = 0; content; chunk++, content = await reader.next()) {
          reader.check();
          writtenHash.update(content);
          await client.query('INSERT INTO egrn_file_chunks(file_id,chunk_no,content) VALUES($1,$2,$3)', [id, chunk, content]);
        }
        if (writtenHash.digest('hex') !== sha256) throw error(409, 'EGRN_FILE_CHANGED', 'Файл изменился во время сохранения. Повторите попытку.');
        result = metadata(inserted.rows[0]);
      } else {
        const existing = (await client.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
        if (!existing || Number(existing.egrn_order_id) !== order || existing.source_key !== key || existing.sha256 !== sha256 || Number(existing.bytes) !== bytes || existing.mime !== type.mime) {
          throw error(409, 'EGRN_FILE_CONFLICT', 'Не удалось подтвердить ранее сохранённый файл выписки.');
        }
        result = metadata(existing);
      }
      reader.check();
      await client.query('COMMIT');
      return result;
    } catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; }
    finally { if (reader) await reader.close(); client.release(); }
  }
  function matches(row, order, key, sha256, bytes) {
    return row && Number(row.egrn_order_id) === order && row.source_key === key && row.sha256 === sha256 && Number(row.bytes) === bytes;
  }
  async function removeAttempt(key) {
    try { await objects.remove(key); }
    catch (_) { console.error('egrn object cleanup: temporary storage failure'); }
  }
  async function linkObject(id, order, key, name, mime, bytes, sha256, objectKey) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const compact = id.replace(/-/g, '');
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [parseInt(compact.slice(0, 8), 16) | 0, parseInt(compact.slice(8, 16), 16) | 0]);
      const existing = (await client.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
      if (existing) {
        if (!matches(existing, order, key, sha256, bytes)) throw error(409, 'EGRN_FILE_CONFLICT', 'Не удалось подтвердить ранее сохранённый файл выписки.');
        await client.query('COMMIT'); return existing;
      }
      const inserted = await client.query(`INSERT INTO egrn_files(${COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLUMNS}`,
        [id, order, key, name, mime, bytes, sha256, 's3', objectKey]);
      await client.query('COMMIT'); return inserted.rows[0];
    } catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; }
    finally { client.release(); }
  }
  async function saveObjectStream(input) {
    const order = orderId(input?.egrn_order_id), key = sourceKey(input?.source_key);
    const { bytes, sha256 } = streamDetails(input), id = fileId(order, key, sha256);
    if (input.signal?.aborted) throw cancelled();
    await ensure();
    const existing = (await pool.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
    if (existing) {
      if (!matches(existing, order, key, sha256, bytes)) throw error(409, 'EGRN_FILE_CONFLICT', 'Не удалось подтвердить ранее сохранённый файл выписки.');
      return metadata(existing);
    }
    // Each attempt owns a fresh key. A failed/concurrent attempt can only
    // delete its own unreferenced object, never an older committed original.
    const objectKey = 'egrn-originals/' + id + '/' + randomUUID();
    let reader, attempted = false, linked = false, verified = false;
    try {
      reader = await streamReader(input, bytes);
      const first = await reader.next(), type = fileType(first), name = filename(input.name, type.extension);
      async function* content() {
        const hash = createHash('sha256'); let chunk = first;
        while (chunk) { reader.check(); hash.update(chunk); yield chunk; chunk = await reader.next(); }
        if (hash.digest('hex') !== sha256) throw error(409, 'EGRN_FILE_CHANGED', 'Контрольная сумма оригинала выписки не совпала.');
        reader.check(); verified = true;
      }
      attempted = true;
      await objects.put({ key: objectKey, bytes, sha256, mime: type.mime, body: content(), signal: input.signal });
      if (!verified) throw error(409, 'EGRN_FILE_INCOMPLETE', 'Хранилище не подтвердило получение оригинала выписки.');
      reader.check();
      const row = await linkObject(id, order, key, name, type.mime, bytes, sha256, objectKey);
      linked = row.object_key === objectKey;
      if (!linked) await removeAttempt(objectKey);
      return metadata(row);
    } catch (failure) {
      if (attempted && !linked) {
        // A lost COMMIT acknowledgement must not cause deletion of a live
        // object. Reconcile using a fresh connection; retain it if DB is down.
        let keep = true;
        try {
          const row = (await pool.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
          keep = row?.object_key === objectKey;
          if (keep && matches(row, order, key, sha256, bytes)) return metadata(row);
        } catch (_) {}
        if (!keep) await removeAttempt(objectKey);
      }
      throw failure;
    } finally { if (reader) await reader.close(); }
  }
  async function get(id) {
    if (!validId(id)) return null;
    await ensure();
    const row = (await pool.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
    return row ? metadata(row) : null;
  }
  async function listByOrder(id) {
    id = orderId(id); await ensure();
    return (await pool.query(`SELECT ${COLUMNS} FROM egrn_files WHERE egrn_order_id=$1 ORDER BY created_at,id`, [id])).rows.map(metadata);
  }
  async function migrateLegacyOriginal(original, request = {}) {
    const controller = new AbortController(); let rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = reject; }); interrupted.catch(() => {});
    const abort = () => {
      controller.abort(); rejectAbort(cancelled());
    };
    const timeout = Math.min(20 * 60 * 1000, Math.max(1, options.migrationTimeoutMs || 20 * 60 * 1000));
    const timer = setTimeout(() => {
      controller.abort(); rejectAbort(error(503, 'EGRN_FILE_MIGRATION_TIMEOUT', 'Перенос оригинала выписки временно недоступен. Повторите попытку.'));
    }, timeout);
    request.signal?.addEventListener('abort', abort, { once: true });
    const step = pending => Promise.race([pending, interrupted]);
    const check = () => { if (controller.signal.aborted) throw cancelled(); };
    const id = original.id, objectKey = 'egrn-originals/' + id + '/' + randomUUID();
    let client, released = false, attempted = false, verified = false, commitAttempted = false, linked = false;
    try {
      if (request.signal?.aborted) { abort(); throw cancelled(); }
      const acquiring = pool.connect();
      acquiring.then(value => { if (controller.signal.aborted && !client) { released = true; value.release(true); } }, () => {});
      client = await step(acquiring); check();
      await step(client.query('BEGIN'));
      await step(client.query("SET LOCAL lock_timeout = '30s'"));
      await step(client.query("SET LOCAL statement_timeout = '60s'"));
      // Other processes use the same per-file transaction lock. The winner
      // copies once; waiters re-read the S3 mapping instead of re-uploading.
      const compact = id.replace(/-/g, '');
      await step(client.query('SELECT pg_advisory_xact_lock($1,$2)', [parseInt(compact.slice(0, 8), 16) | 0, parseInt(compact.slice(8, 16), 16) | 0]));
      const row = (await step(client.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id]))).rows[0];
      if (!row) throw error(404, 'EGRN_FILE_NOT_FOUND', 'Файл выписки не найден.');
      if (!matches(row, Number(original.egrn_order_id), original.source_key, original.sha256, Number(original.bytes))) {
        throw error(409, 'EGRN_FILE_CONFLICT', 'Не удалось подтвердить ранее сохранённый файл выписки.');
      }
      if (row.storage === 's3') {
        await step(client.query('COMMIT')); return row;
      }
      async function* body() {
        const hash = createHash('sha256'); let total = 0, index = 0;
        while (total < Number(row.bytes)) {
          check();
          const part = (await step(client.query('SELECT content FROM egrn_file_chunks WHERE file_id=$1 AND chunk_no=$2', [id, index]))).rows[0];
          if (!part) throw error(500, 'EGRN_FILE_INCOMPLETE', 'Оригинал выписки сохранён не полностью.');
          const content = Buffer.from(part.content);
          if (content.length !== Math.min(CHUNK_BYTES, Number(row.bytes) - total)) throw error(500, 'EGRN_FILE_INCOMPLETE', 'Размер сохранённой выписки не совпадает.');
          if (!index && fileType(content).mime !== row.mime) throw error(500, 'EGRN_FILE_CORRUPT', 'Тип оригинала выписки не совпадает.');
          hash.update(content); total += content.length; index++; yield content;
        }
        check();
        const extra = await step(client.query('SELECT chunk_no FROM egrn_file_chunks WHERE file_id=$1 AND chunk_no >= $2 LIMIT 1', [id, index]));
        if (extra.rows.length || hash.digest('hex') !== row.sha256) throw error(500, 'EGRN_FILE_CORRUPT', 'Не удалось подтвердить целостность оригинала выписки.');
        check(); verified = true;
      }
      attempted = true;
      await step(objects.put({ key: objectKey, ...metadata(row), body: body(), signal: controller.signal }));
      if (!verified) throw error(409, 'EGRN_FILE_INCOMPLETE', 'Хранилище не подтвердило получение оригинала выписки.');
      check();
      const changed = (await step(client.query(`UPDATE egrn_files SET storage='s3',object_key=$2 WHERE id=$1 AND storage='postgres' AND object_key IS NULL AND bytes=$3 AND sha256=$4 RETURNING ${COLUMNS}`,
        [id, objectKey, Number(row.bytes), row.sha256]))).rows[0];
      if (!changed) throw error(409, 'EGRN_FILE_CONFLICT', 'Не удалось сохранить перенос оригинала выписки.');
      check(); commitAttempted = true;
      await step(client.query('COMMIT')); linked = true;
      console.info('egrn original migrated', { file_id: id, bytes: Number(row.bytes) });
      // Keep the old immutable chunks in this rollout. A download opened
      // before the mapping changed can finish reading its original safely.
      return changed;
    } catch (failure) {
      if (client && !released) {
        if (commitAttempted || controller.signal.aborted) { client.release(true); released = true; }
        else {
          try { await step(client.query('ROLLBACK')); }
          catch (_) { client.release(true); released = true; }
        }
      }
      if (attempted && !linked) {
        // A COMMIT may succeed even when its acknowledgement is lost. Never
        // remove that object until a fresh connection confirms its mapping.
        let keep = commitAttempted;
        if (commitAttempted) {
          try {
            const row = await reconcileMigration(id);
            if (row?.storage === 's3' && row.object_key === objectKey && matches(row, Number(original.egrn_order_id), original.source_key, original.sha256, Number(original.bytes))) {
              console.info('egrn original migrated', { file_id: id, bytes: Number(row.bytes) });
              return row;
            }
          } catch (_) {}
        }
        if (!keep) await removeAttempt(objectKey);
      }
      throw failure;
    } finally {
      clearTimeout(timer); request.signal?.removeEventListener('abort', abort);
      if (client && !released) client.release();
    }
  }
  async function reconcileMigration(id) {
    let client, released = false, timedOut = false, rejectTimeout;
    const deadline = new Promise((_, reject) => { rejectTimeout = reject; }); deadline.catch(() => {});
    const timeout = Math.min(30000, Math.max(1, options.migrationReconcileTimeoutMs || 30000));
    const timer = setTimeout(() => { timedOut = true; rejectTimeout(error(503, 'EGRN_FILE_MIGRATION_TIMEOUT', 'Не удалось подтвердить перенос выписки.')); }, timeout);
    try {
      const acquiring = pool.connect();
      acquiring.then(value => { if (timedOut && !client) { released = true; value.release(true); } }, () => {});
      client = await Promise.race([acquiring, deadline]);
      if (timedOut) throw error(503, 'EGRN_FILE_MIGRATION_TIMEOUT', 'Не удалось подтвердить перенос выписки.');
      return (await Promise.race([client.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id]), deadline])).rows[0];
    } finally { clearTimeout(timer); if (client && !released) client.release(timedOut || undefined); }
  }
  async function downloadUrl(id, options = {}) {
    if (!validId(id)) throw error(404, 'EGRN_FILE_NOT_FOUND', 'Файл выписки не найден.');
    if (options.signal?.aborted) throw cancelled();
    await ensure();
    let row = (await pool.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
    if (!row) throw error(404, 'EGRN_FILE_NOT_FOUND', 'Файл выписки не найден.');
    if (row.storage === 'postgres' && Number(row.bytes) > DIRECT_MIGRATION_BYTES && objects && objects.configured()) {
      row = await migrateLegacyOriginal(row, options);
    }
    // Small originals and installations without S3 retain the existing path.
    // A configured storage failure never falls back to paid file proxying.
    if (row.storage !== 's3') return null;
    return objects.downloadUrl({ key: row.object_key, ...metadata(row), signal: options.signal }, options);
  }
  async function* chunks(id, options = {}) {
    if (options.signal?.aborted) throw cancelled();
    if (!validId(id)) throw error(404, 'EGRN_FILE_NOT_FOUND', 'Файл выписки не найден.');
    await ensure();
    const row = (await pool.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
    const file = row && metadata(row);
    if (!file) throw error(404, 'EGRN_FILE_NOT_FOUND', 'Файл выписки не найден.');
    if (row.storage === 's3') {
      const source = await objects.get({ key: row.object_key, bytes: file.bytes, sha256: file.sha256, signal: options.signal });
      const reader = await streamReader({ chunks: source, signal: options.signal }, file.bytes), hash = createHash('sha256');
      try {
        for (let chunk = await reader.next(); chunk; chunk = await reader.next()) { hash.update(chunk); yield chunk; }
        if (hash.digest('hex') !== file.sha256) throw error(500, 'EGRN_FILE_CORRUPT', 'Не удалось подтвердить целостность оригинала выписки.');
      } finally { await reader.close(); }
      return;
    }
    const hash = createHash('sha256'); let total = 0, index = 0;
    while (total < file.bytes) {
      if (options.signal?.aborted) throw cancelled();
      const row = (await pool.query('SELECT content FROM egrn_file_chunks WHERE file_id=$1 AND chunk_no=$2', [id, index])).rows[0];
      if (!row) throw error(500, 'EGRN_FILE_INCOMPLETE', 'Оригинал выписки сохранён не полностью.');
      const content = Buffer.from(row.content);
      if (content.length !== Math.min(CHUNK_BYTES, file.bytes - total)) throw error(500, 'EGRN_FILE_INCOMPLETE', 'Размер сохранённой выписки не совпадает.');
      hash.update(content); total += content.length; index++;
      yield content;
    }
    const extra = await pool.query('SELECT chunk_no FROM egrn_file_chunks WHERE file_id=$1 AND chunk_no >= $2 LIMIT 1', [id, index]);
    if (extra.rows.length || hash.digest('hex') !== file.sha256) throw error(500, 'EGRN_FILE_CORRUPT', 'Не удалось подтвердить целостность оригинала выписки.');
  }
  return { ensure, save, saveStream, get, listByOrder, downloadUrl, chunks };
}

// Resolve the existing pool lazily: importing helpers does not open a connection.
let singleton;
function store() { return singleton ||= createEgrnFileStore(require('../db/pool')); }
module.exports = { MAX_BYTES, createEgrnFileStore,
  ensure: (...args) => store().ensure(...args), save: (...args) => store().save(...args),
  saveStream: (...args) => store().saveStream(...args),
  get: (...args) => store().get(...args), listByOrder: (...args) => store().listByOrder(...args),
  downloadUrl: (...args) => store().downloadUrl(...args),
  chunks: (...args) => store().chunks(...args) };
