const { createHash } = require('node:crypto');

const MAX_BYTES = 200 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const UUID_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
const COLUMNS = 'id,egrn_order_id,source_key,name,mime,bytes,sha256';
const DDL = `
  CREATE TABLE IF NOT EXISTS egrn_files (
    id UUID PRIMARY KEY,
    egrn_order_id BIGINT NOT NULL CHECK(egrn_order_id > 0),
    source_key TEXT NOT NULL CHECK(length(source_key) BETWEEN 1 AND 512),
    name TEXT NOT NULL,
    mime TEXT NOT NULL CHECK(mime IN ('application/pdf','application/zip')),
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND ${MAX_BYTES}),
    sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(egrn_order_id,source_key,sha256)
  );
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
  if (buffer.length > MAX_BYTES) throw error(413, 'EGRN_FILE_TOO_LARGE', 'Файл выписки превышает лимит 200 МБ.');
  if (buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { mime: 'application/pdf', extension: 'pdf' };
  if (['504b0304', '504b0506', '504b0708'].includes(buffer.subarray(0, 4).toString('hex'))) return { mime: 'application/zip', extension: 'zip' };
  throw error(415, 'EGRN_FILE_TYPE', 'Сохранить можно только оригинал выписки в PDF или ZIP.');
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
function createEgrnFileStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
  let ready;
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
    const order = orderId(input?.egrn_order_id), key = sourceKey(input?.source_key), buffer = input?.buffer;
    const type = fileType(buffer), name = filename(input?.name, type.extension);
    const sha256 = createHash('sha256').update(buffer).digest('hex'), id = fileId(order, key, sha256);
    await ensure();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`INSERT INTO egrn_files(${COLUMNS}) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING ${COLUMNS}`,
        [id, order, key, name, type.mime, buffer.length, sha256]);
      let result;
      if (inserted.rows.length) {
        const writtenHash = createHash('sha256');
        for (let start = 0, chunk = 0; start < buffer.length; start += CHUNK_BYTES, chunk++) {
          // One private chunk at a time; do not duplicate an entire 100–200 MiB file.
          const content = Buffer.from(buffer.subarray(start, start + CHUNK_BYTES));
          writtenHash.update(content);
          await client.query('INSERT INTO egrn_file_chunks(file_id,chunk_no,content) VALUES($1,$2,$3)', [id, chunk, content]);
        }
        if (writtenHash.digest('hex') !== sha256) throw error(409, 'EGRN_FILE_CHANGED', 'Файл изменился во время сохранения. Повторите попытку.');
        result = metadata(inserted.rows[0]);
      } else {
        const existing = (await client.query(`SELECT ${COLUMNS} FROM egrn_files WHERE id=$1`, [id])).rows[0];
        if (!existing || Number(existing.egrn_order_id) !== order || existing.source_key !== key || existing.sha256 !== sha256 || Number(existing.bytes) !== buffer.length || existing.mime !== type.mime) {
          throw error(409, 'EGRN_FILE_CONFLICT', 'Не удалось подтвердить ранее сохранённый файл выписки.');
        }
        result = metadata(existing);
      }
      await client.query('COMMIT');
      return result;
    } catch (failure) { await client.query('ROLLBACK').catch(() => {}); throw failure; }
    finally { client.release(); }
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
  async function* chunks(id) {
    const file = await get(id);
    if (!file) throw error(404, 'EGRN_FILE_NOT_FOUND', 'Файл выписки не найден.');
    const hash = createHash('sha256'); let total = 0, index = 0;
    while (total < file.bytes) {
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
  return { ensure, save, get, listByOrder, chunks };
}

// Resolve the existing pool lazily: importing helpers does not open a connection.
let singleton;
function store() { return singleton ||= createEgrnFileStore(require('../db/pool')); }
module.exports = { MAX_BYTES, createEgrnFileStore,
  ensure: (...args) => store().ensure(...args), save: (...args) => store().save(...args),
  get: (...args) => store().get(...args), listByOrder: (...args) => store().listByOrder(...args),
  chunks: (...args) => store().chunks(...args) };
