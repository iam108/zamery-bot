const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const defaultPool = require('../db/pool');

const COMMON_ARCHIVE_URL = 'https://disk.360.yandex.ru/d/RPoUCOS6PFusPQ';
const SERVICES = ['Получение', 'Продление', 'Переоформление'];
const ROLES = ['plan', 'egrn', 'archive', 'document'];
const LIMITS = { files: 20, fileBytes: 12 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 };
const DDL = `
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS service TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS cad_num TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS archive_url TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_submit_id TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_signature TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS orders_request_submit ON orders(submitted_by,request_submit_id);
  CREATE TABLE IF NOT EXISTS order_materials (
    order_id INT NOT NULL REFERENCES orders(id),
    id UUID NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    role TEXT NOT NULL,
    bytes INT NOT NULL,
    sha256 TEXT NOT NULL,
    content BYTEA NOT NULL,
    telegram_msg_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(order_id,id)
  );
`;
function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
function orderNumber(value) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) throw error('Некорректный номер заявки.'); return n; }
function cleanName(value) { return String(value || 'Документ').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'Документ'; }
function guessRole(name) { return /егрн|egrn|выписк/i.test(name) ? 'egrn' : /архив|archive/i.test(name) ? 'archive' : /план|график|бти|bti|plan/i.test(name) ? 'plan' : 'document'; }
function normalizeArchive(value) {
  if (!value) return '';
  require('./order-archive').parseArchiveUrl(value);
  const url = new URL(String(value).trim());
  if (url.href.length > 2000) throw error('Слишком длинная ссылка на архив объекта.');
  return url.href;
}
const DOCUMENT_MIMES = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip' };
function prepareMaterials(files, roles) {
  if (!Array.isArray(files) || files.length > LIMITS.files) throw error('Можно прикрепить до 20 файлов.');
  let selected = roles || [];
  if (typeof selected === 'string') { try { selected = JSON.parse(selected); } catch (e) { throw error('Не удалось прочитать назначение файлов.'); } }
  if (!Array.isArray(selected)) throw error('Проверьте назначение файлов.');
  let total = 0;
  return files.map((file, index) => {
    const name = cleanName(file.originalname || file.name);
    let mime = String(file.mimetype || file.mime || '').toLowerCase();
    const extension = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if ((!mime || mime === 'application/octet-stream') && DOCUMENT_MIMES[extension]) mime = DOCUMENT_MIMES[extension];
    if (mime === 'application/x-zip-compressed') mime = 'application/zip';
    const buffer = file.buffer;
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > LIMITS.fileBytes) throw error('Файл «' + name + '» должен быть не больше 12 МБ.');
    if (!Object.values(DOCUMENT_MIMES).includes(mime) && !/^image\/(jpeg|png|webp|gif|heic|heif|avif|tiff|bmp)$/.test(mime)) throw error('Файл «' + name + '»: поддерживаются PDF, изображения, Word, Excel и ZIP.');
    total += buffer.length;
    if (total > LIMITS.totalBytes) throw error('Общий объём документов заявки не должен превышать 100 МБ.');
    const role = selected[index] || guessRole(name);
    if (!ROLES.includes(role)) throw error('Выберите назначение документа «' + name + '».');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    let id = createHash('sha256').update(name + '\n' + mime + '\n' + role + '\n' + sha256).digest('hex').slice(0, 32);
    id = id.slice(0, 12) + '4' + id.slice(13, 16) + '8' + id.slice(17);
    id = id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' + id.slice(16, 20) + '-' + id.slice(20);
    return { id, name, mime, role, bytes: buffer.length, sha256, buffer };
  });
}
function normalizeManagerOrder(input, files) {
  const data = { ...input };
  for (const field of ['address', 'owner_name', 'object_type']) if (!String(data[field] || '').trim()) throw error('Заполните адрес, чей объект и тип объекта.');
  for (const field of ['address', 'owner_name', 'object_type', 'object_name', 'service', 'cad_num', 'zones_info', 'contacts', 'deadline']) data[field] = String(data[field] || '').trim();
  if (data.address.length > 500 || data.owner_name.length > 500 || data.object_name.length > 500 || data.contacts.length > 4000 || data.zones_info.length > 4000 || data.cad_num.length > 100) throw error('Слишком длинное поле заявки.');
  if (!/табак|другое/i.test(data.object_type) && !SERVICES.includes(data.service)) throw error('Менеджеру нужно выбрать услугу: получение, продление или переоформление.');
  data.has_video = input.has_video === true || input.has_video === 'true';
  data.archive_url = data.service === 'Продление' ? normalizeArchive(input.archive_url) : '';
  if (data.service === 'Продление' && !data.archive_url && !files.some(file => file.role === 'archive')) throw error('При продлении добавьте ссылку на архив объекта или прикрепите архивные материалы.');
  data.request_submit_id = String(input.submit_id || '').slice(0, 40) || null;
  const signature = { ...data, submitted_by: undefined, tg_user_id: undefined, submit_id: undefined, file_roles: undefined, request_signature: undefined, request_submit_id: undefined, files: files.map(({ buffer, ...file }) => file) };
  data.request_signature = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
  return data;
}
function metadata(row) {
  return { id: row.id, name: row.name, mime: row.mime, role: row.role, bytes: Number(row.bytes), sha256: row.sha256,
    telegram_msg_id: row.telegram_msg_id, url: '/api/audit/orders/' + row.order_id + '/materials/' + row.id };
}
function createMaterialsStore(pool = defaultPool) {
  let ready;
  async function ensure() {
    if (!ready) ready = (async () => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(108,4)'); await client.query(DDL); await client.query('COMMIT'); }
      catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    })().catch(e => { ready = null; throw e; });
    return ready;
  }
  async function transaction(fn) {
    await ensure(); const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  async function list(id, originals = false, role) {
    await ensure(); id = orderNumber(id);
    const found = await pool.query('SELECT id FROM orders WHERE id=$1', [id]);
    if (!found.rows.length) throw error('Заявка не найдена.', 404);
    if (role && !ROLES.includes(role)) throw error('Неизвестное назначение документа.');
    const rows = (await pool.query('SELECT ' + (originals ? '*' : 'order_id,id,name,mime,role,bytes,sha256,telegram_msg_id') + ' FROM order_materials WHERE order_id=$1' + (role ? ' AND role=$2' : '') + ' ORDER BY created_at,id', role ? [id, role] : [id])).rows;
    return rows.map(row => originals ? { ...metadata(row), buffer: Buffer.from(row.content) } : metadata(row));
  }
  return {
    ensure, list,
    async save(id, prepared) {
      id = orderNumber(id);
      return transaction(async client => {
        const found = await client.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [id]);
        if (!found.rows.length) throw error('Заявка не найдена.', 404);
        for (const file of prepared) await client.query('INSERT INTO order_materials(order_id,id,name,mime,role,bytes,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(order_id,id) DO NOTHING', [id, file.id, file.name, file.mime, file.role, file.bytes, file.sha256, file.buffer]);
        const counts = (await client.query('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM order_materials WHERE order_id=$1', [id])).rows[0];
        if (Number(counts.count) > LIMITS.files || Number(counts.bytes) > LIMITS.totalBytes) throw error('В заявке может быть до 20 файлов и не больше 100 МБ.');
      });
    },
    async download(id, fileId) {
      id = orderNumber(id);
      if (!/^[0-9a-f-]{36}$/i.test(String(fileId))) throw error('Некорректный номер документа.');
      await ensure(); const row = (await pool.query('SELECT * FROM order_materials WHERE order_id=$1 AND id=$2', [id, fileId])).rows[0];
      if (!row) throw error('Документ не найден.', 404);
      return { ...metadata(row), buffer: Buffer.from(row.content) };
    },
    async delivered(id, fileId, messageId) { await ensure(); await pool.query('UPDATE order_materials SET telegram_msg_id=$1 WHERE order_id=$2 AND id=$3', [messageId, orderNumber(id), fileId]); },
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(buffer) { let value = 0xffffffff; for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function* zipParts(files) {
  const central = []; let offset = 0;
  files.forEach((file, i) => { // Names are unique even when two supplied documents share a filename.
    const name = Buffer.from(String(i + 1).padStart(2, '0') + '-' + cleanName(file.name), 'utf8');
    const crc = crc32(file.buffer); const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(file.buffer.length, 18); header.writeUInt32LE(file.buffer.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(file.buffer.length, 20); entry.writeUInt32LE(file.buffer.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push({ header, name, content: file.buffer, directory: Buffer.concat([entry, name]) }); offset += header.length + name.length + file.buffer.length;
  });
  for (const entry of central) { yield entry.header; yield entry.name; yield entry.content; }
  const start = offset;
  for (const entry of central) { yield entry.directory; offset += entry.directory.length; }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16); yield end;
}
function attachment(res, name) { res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').set('Content-Disposition', "attachment; filename=\"documents\"; filename*=UTF-8''" + encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))); }
const store = createMaterialsStore();
async function loadOrderMaterials(orderId, ids) {
  const files = await store.list(orderId, true);
  if (ids == null) return files;
  if (!Array.isArray(ids) || ids.length > LIMITS.files) throw error('Проверьте документы заявки.');
  const selected = files.filter(file => ids.includes(file.id));
  if (selected.length !== new Set(ids).size) throw error('Один из документов не относится к этой заявке.', 404);
  return selected;
}
function setupOrderMaterials(app, materials = store) {
  const route = fn => async (req, res) => { try { await fn(req, res); } catch (e) { console.error('order materials:', e.message); if (!res.headersSent) res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : 'Не удалось открыть документы заявки.' }); else res.destroy(e); } };
  app.get('/api/audit/orders/:id/materials', route(async (req, res) => res.json({ ok: true, materials: await materials.list(req.params.id), download_url: '/api/audit/orders/' + orderNumber(req.params.id) + '/materials/download-all' })));
  app.get('/api/audit/orders/:id/materials/download-all', route(async (req, res) => {
    const files = await materials.list(req.params.id, true, req.query.role);
    if (!files.length) throw error('В заявке пока нет документов этого типа.', 404);
    attachment(res, 'Заявка-' + orderNumber(req.params.id) + (req.query.role === 'archive' ? '-архив' : '-документы') + '.zip'); res.type('application/zip'); Readable.from(zipParts(files)).pipe(res);
  }));
  app.get('/api/audit/orders/:id/materials/:fileId', route(async (req, res) => { const file = await materials.download(req.params.id, req.params.fileId); attachment(res, file.name); res.type(file.mime).send(file.buffer); }));
}

module.exports = { COMMON_ARCHIVE_URL, SERVICES, ROLES, LIMITS, DDL, prepareMaterials, normalizeManagerOrder, normalizeArchive, guessRole, zipParts, createMaterialsStore, setupOrderMaterials,
  ensureOrderMaterials: store.ensure, saveOrderMaterials: store.save, listOrderMaterials: store.list, loadOrderMaterials, downloadOrderMaterial: store.download, markOrderMaterialDelivered: store.delivered };
