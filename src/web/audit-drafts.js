const { randomUUID, createHash } = require('node:crypto');
const defaultPool = require('../db/pool');
const { createAuditEvidenceStore, AuditEvidenceStorageError } = require('./audit-evidence-store');

const LIMITS = Object.freeze({ metadataBytes: 1024 * 1024, fileBytes: 12 * 1024 * 1024, files: 60, totalBytes: 100 * 1024 * 1024 });
const DDL = `
  CREATE TABLE IF NOT EXISTS audit_drafts (
    id UUID PRIMARY KEY,
    author_tg_id BIGINT NOT NULL,
    order_id INT,
    revision INT NOT NULL DEFAULT 1,
    data JSONB NOT NULL DEFAULT '{}',
    delivery JSONB NOT NULL DEFAULT '{}',
    submitting_revision INT,
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE audit_drafts ADD COLUMN IF NOT EXISTS delivery JSONB NOT NULL DEFAULT '{}';
  CREATE UNIQUE INDEX IF NOT EXISTS audit_drafts_current
    ON audit_drafts (author_tg_id, COALESCE(order_id, 0)) WHERE submitted_at IS NULL;
  CREATE TABLE IF NOT EXISTS audit_evidence (
    draft_id UUID NOT NULL REFERENCES audit_drafts(id),
    id UUID NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    role TEXT NOT NULL,
    subject_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    bytes INT NOT NULL,
    sha256 TEXT NOT NULL,
    content BYTEA,
    storage TEXT NOT NULL DEFAULT 'postgres',
    object_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (draft_id, id)
  );
  ALTER TABLE audit_evidence ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'postgres';
  ALTER TABLE audit_evidence ADD COLUMN IF NOT EXISTS object_key TEXT;
  ALTER TABLE audit_evidence ALTER COLUMN content DROP NOT NULL;
`;

class DraftError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new DraftError(status, code, message); }
function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail(400, 'INVALID_ID', 'Некорректный номер черновика или файла.');
  return value.toLowerCase();
}
function ownerId(value) {
  const id = String(value == null ? '' : value);
  if (!/^[1-9]\d{0,19}$/.test(id)) fail(400, 'INVALID_OWNER', 'Не удалось определить сотрудника.');
  return id;
}
function orderId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) fail(400, 'INVALID_ORDER', 'Некорректный номер заявки.');
  return n;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'INVALID_REVISION', 'Не указана версия черновика.');
  return value;
}
function validateData(value, limits = LIMITS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_DATA', 'Данные черновика должны быть объектом.');
  let json;
  try { json = JSON.stringify(value); } catch (e) { fail(400, 'INVALID_DATA', 'Не удалось прочитать данные черновика.'); }
  if (Buffer.byteLength(json, 'utf8') > limits.metadataBytes) fail(413, 'DRAFT_TOO_LARGE', 'Слишком много текста в черновике. Файлы нужно добавлять отдельно.');
  function visit(v, depth) {
    if (depth > 40) fail(400, 'INVALID_DATA', 'Слишком сложная структура черновика.');
    if (typeof v === 'string') {
      if (/^data:[^,]*;base64,/i.test(v) || (v.length > 2048 && /^[A-Za-z0-9+/]+={0,2}$/.test(v))) fail(400, 'INLINE_FILE', 'Файлы нужно загружать отдельно от ответов.');
      return;
    }
    if (v && typeof v === 'object') {
      for (const [key, entry] of Object.entries(v)) {
        if (/^(base64|buffer)$/i.test(key) && entry) fail(400, 'INLINE_FILE', 'Файлы нужно загружать отдельно от ответов.');
        visit(entry, depth + 1);
      }
    }
  }
  visit(value, 0);
  return JSON.parse(json);
}
function filename(value) {
  const name = String(value || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  if (!name || name === '.' || name === '..') fail(400, 'INVALID_FILE', 'Укажите имя файла.');
  return name;
}
function prepareEvidence(input, limits = LIMITS) {
  if (!input || typeof input !== 'object') fail(400, 'INVALID_FILE', 'Не указан файл.');
  const id = uuid(input.id);
  const name = filename(input.name);
  const mime = String(input.mime || '').toLowerCase();
  if (!/^(image\/(jpeg|png|webp|gif|heic|heif|avif|tiff|bmp)|application\/pdf)$/.test(mime)) fail(400, 'UNSUPPORTED_FILE', 'Можно добавить изображение или PDF. Видео укажите ссылкой.');
  const role = String(input.role || 'photo');
  const kind = String(input.kind || '');
  const subject = String(input.subject_id || '');
  if (!/^[a-z0-9_-]{1,40}$/i.test(role) || !/^[a-z0-9_-]{0,40}$/i.test(kind) || !/^[a-z0-9_-]{0,100}$/i.test(subject)) fail(400, 'INVALID_FILE', 'Не удалось определить раздел файла.');
  const encoded = input.data;
  if (typeof encoded === 'string' && encoded.length > Math.ceil(limits.fileBytes / 3) * 4) fail(413, 'FILE_TOO_LARGE', 'Файл превышает допустимый размер: 12 МБ.');
  // Repeating a four-character capture can exhaust V8's RegExp stack on a
  // normal phone photo. Validate the alphabet and canonical encoding instead.
  if (typeof encoded !== 'string' || !encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail(400, 'INVALID_FILE', 'Файл повреждён. Выберите его заново.');
  const content = Buffer.from(encoded, 'base64');
  if (!content.length || content.length > limits.fileBytes) fail(413, 'FILE_TOO_LARGE', 'Файл превышает допустимый размер: 12 МБ.');
  if (content.toString('base64') !== encoded) fail(400, 'INVALID_FILE', 'Файл повреждён. Выберите его заново.');
  return { id, name, mime, role, kind, subject_id: subject, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), content };
}
function evidenceMetadata(row) {
  return { id: row.id, name: row.name, mime: row.mime, role: row.role, subject_id: row.subject_id, kind: row.kind, bytes: Number(row.bytes), sha256: row.sha256, created_at: row.created_at };
}

function createDraftStore(pool = defaultPool, configuredLimits = LIMITS, options = {}) {
  const limits = Object.assign({}, LIMITS, configuredLimits);
  const originals = createAuditEvidenceStore(options);
  let initialized;
  async function ensureTables() {
    if (!initialized) initialized = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(108, 3)');
        await client.query(DDL);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    })().catch(e => { initialized = null; throw e; });
    return initialized;
  }
  async function transaction(fn) {
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  async function find(client, owner, id, lock = false) {
    const row = (await client.query('SELECT * FROM audit_drafts WHERE id=$1 AND author_tg_id=$2' + (lock ? ' FOR UPDATE' : ''), [uuid(id), ownerId(owner)])).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'Черновик не найден.');
    return row;
  }
  function mutable(row) {
    if (row.submitted_at) fail(409, 'ALREADY_SUBMITTED', 'Этот отчёт уже отправлен. Откройте новую проверку.');
    if (row.submitting_revision != null) fail(409, 'SUBMITTING', 'Отчёт уже отправляется. Повторите отправку без изменения данных.');
  }
  function checkRevision(row, expected) {
    if (Number(row.revision) !== revision(expected)) fail(409, 'REVISION_CONFLICT', 'Черновик изменился в другом окне. Обновите данные перед сохранением.');
  }
  async function snapshot(client, row, includeOriginals = false) {
    const files = (await client.query('SELECT ' + (includeOriginals ? '*' : 'id,name,mime,role,subject_id,kind,bytes,sha256,created_at') + ' FROM audit_evidence WHERE draft_id=$1 AND deleted_at IS NULL ORDER BY created_at,id', [row.id])).rows;
    return { id: row.id, order_id: row.order_id, revision: Number(row.revision), data: row.data, updated_at: row.updated_at, submitted_at: row.submitted_at, submitting: row.submitting_revision != null,
      evidence: files.map(file => includeOriginals ? Object.assign(evidenceMetadata(file), { draft_id: row.id, content: file.content, storage: file.storage, object_key: file.object_key }) : evidenceMetadata(file)) };
  }
  async function hydrate(value) {
    const evidence = [];
    for (const file of value.evidence) evidence.push(Object.assign(evidenceMetadata(file), { buffer: await originals.read(file) }));
    return Object.assign({}, value, { evidence });
  }
  async function bump(client, id) {
    return (await client.query('UPDATE audit_drafts SET revision=revision+1,updated_at=NOW() WHERE id=$1 RETURNING revision', [id])).rows[0].revision;
  }
  async function evidencePreflight(client, owner, id, file) {
    const row = await find(client, owner, id, true);
    const existing = (await client.query('SELECT id,name,mime,role,subject_id,kind,bytes,sha256,created_at,deleted_at,storage,object_key FROM audit_evidence WHERE draft_id=$1 AND id=$2', [row.id, file.id])).rows[0];
    if (existing) {
      if (['name', 'mime', 'role', 'subject_id', 'kind', 'sha256'].some(key => existing[key] !== file[key])) fail(409, 'FILE_CONFLICT', 'Под этим номером уже сохранён другой файл.');
      let next = Number(row.revision);
      if (existing.deleted_at) {
        mutable(row);
        await client.query('UPDATE audit_evidence SET deleted_at=NULL WHERE draft_id=$1 AND id=$2', [row.id, file.id]);
        next = Number(await bump(client, row.id));
      }
      return { result: { evidence: evidenceMetadata(existing), revision: next }, object_key: existing.object_key };
    }
    mutable(row);
    // Removed originals remain recoverable and count against the same limits.
    const totals = (await client.query('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM audit_evidence WHERE draft_id=$1', [row.id])).rows[0];
    if (Number(totals.count) >= limits.files || Number(totals.bytes) + file.bytes > limits.totalBytes) fail(413, 'EVIDENCE_LIMIT', 'Достигнут лимит материалов проверки: 60 файлов или 100 МБ.');
    return { row };
  }
  async function insertEvidence(client, row, file, objectKey) {
    const saved = (await client.query('INSERT INTO audit_evidence(draft_id,id,name,mime,role,subject_id,kind,bytes,sha256,content,storage,object_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,name,mime,role,subject_id,kind,bytes,sha256,created_at',
      [row.id, file.id, file.name, file.mime, file.role, file.subject_id, file.kind, file.bytes, file.sha256, objectKey ? null : file.content, objectKey ? 's3' : 'postgres', objectKey || null])).rows[0];
    return { evidence: evidenceMetadata(saved), revision: Number(await bump(client, row.id)) };
  }
  return {
    ensureTables,
    async withDraftDeliveryLock(owner, id, run) {
      const draftId = uuid(id);
      await ensureTables();
      const client = await pool.connect();
      let locked = false, unlockError;
      try {
        await find(client, owner, draftId);
        const result = await client.query('SELECT pg_try_advisory_lock(109,hashtext($1)) AS locked', [draftId]);
        if (!result.rows[0].locked) fail(409, 'DELIVERY_BUSY', 'Этот отчёт уже отправляется. Дождитесь результата и повторите проверку.');
        locked = true;
        return await run();
      } finally {
        if (locked) {
          try { await client.query('SELECT pg_advisory_unlock(109,hashtext($1))', [draftId]); }
          catch (e) { unlockError = e; }
        }
        // Discard a connection if unlocking failed; returning a still-locked
        // session to the pool would block future retries until a restart.
        client.release(unlockError);
      }
    },
    async current(owner, requestedOrder) {
      const actor = ownerId(owner), order = orderId(requestedOrder);
      return transaction(async client => {
        const row = (await client.query('SELECT * FROM audit_drafts WHERE author_tg_id=$1 AND order_id IS NOT DISTINCT FROM $2::int AND submitted_at IS NULL FOR SHARE', [actor, order])).rows[0];
        return row ? snapshot(client, row) : null;
      });
    },
    async listOpen(owner) {
      const actor = ownerId(owner);
      await ensureTables();
      const { rows } = await pool.query(`
        SELECT d.order_id,
               COALESCE(NULLIF(btrim(o.object_name), ''), NULLIF(btrim(o.owner_name), ''), '') AS object_name,
               COALESCE(o.address, '') AS address,
               d.updated_at,
               d.submitting_revision IS NOT NULL AS submitting
        FROM audit_drafts d
        JOIN orders o ON o.id = d.order_id
        WHERE d.author_tg_id = $1 AND d.submitted_at IS NULL
        ORDER BY d.updated_at DESC, d.order_id DESC
        LIMIT 50
      `, [actor]);
      return rows;
    },
    async create(owner, requestedOrder, data = {}) {
      const actor = ownerId(owner), order = orderId(requestedOrder), safe = validateData(data, limits);
      return transaction(async client => {
        if (order && !(await client.query('SELECT id FROM orders WHERE id=$1', [order])).rows.length) fail(404, 'ORDER_NOT_FOUND', 'Заявка не найдена.');
        const created = (await client.query('INSERT INTO audit_drafts(id,author_tg_id,order_id,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *', [randomUUID(), actor, order, JSON.stringify(safe)])).rows[0];
        const row = created || (await client.query('SELECT * FROM audit_drafts WHERE author_tg_id=$1 AND order_id IS NOT DISTINCT FROM $2::int AND submitted_at IS NULL FOR SHARE', [actor, order])).rows[0];
        if (!row) fail(409, 'REVISION_CONFLICT', 'Черновик изменился в другом окне. Откройте проверку заново.');
        return snapshot(client, row);
      });
    },
    async update(owner, id, expected, data) {
      const safe = validateData(data, limits);
      return transaction(async client => {
        const row = await find(client, owner, id, true); mutable(row); checkRevision(row, expected);
        const updated = (await client.query('UPDATE audit_drafts SET data=$1,revision=revision+1,updated_at=NOW() WHERE id=$2 RETURNING *', [JSON.stringify(safe), row.id])).rows[0];
        return snapshot(client, updated);
      });
    },
    async addEvidence(owner, id, input) {
      const file = prepareEvidence(input, limits);
      if (!originals.configured()) return transaction(async client => {
        const ready = await evidencePreflight(client, owner, id, file);
        return ready.result || insertEvidence(client, ready.row, file);
      });
      const ready = await transaction(client => evidencePreflight(client, owner, id, file));
      if (ready.result) return ready.result;
      const objectKey = originals.key(ready.row.id);
      let retained = false;
      try {
        // The original and its verified HEAD exist before the short metadata
        // transaction. A slow storage service never holds a PostgreSQL lock.
        await originals.put(objectKey, file);
        const stored = await transaction(async client => {
          const latest = await evidencePreflight(client, owner, id, file);
          if (latest.result) return latest;
          const saved = await insertEvidence(client, latest.row, file, objectKey);
          return { result: saved, object_key: objectKey };
        });
        retained = stored?.object_key === objectKey;
        return stored.result;
      } catch (error) {
        // A COMMIT acknowledgement can be lost after the object pointer became
        // durable. Never remove that original merely because the caller saw an
        // error. If reconciliation is unavailable, retain the attempt safely.
        try {
          const recovered = await transaction(async client => {
            const row = await find(client, owner, id);
            const saved = (await client.query('SELECT * FROM audit_evidence WHERE draft_id=$1 AND id=$2', [row.id, file.id])).rows[0];
            return { row, saved };
          });
          retained = recovered.saved?.object_key === objectKey;
          if (retained && !recovered.saved.deleted_at && ['name', 'mime', 'role', 'subject_id', 'kind', 'sha256'].every(key => recovered.saved[key] === file[key])) return { evidence: evidenceMetadata(recovered.saved), revision: Number(recovered.row.revision) };
        } catch (_) { retained = true; }
        throw error;
      } finally { if (!retained) await originals.remove(objectKey).catch(() => {}); }
    },
    async removeEvidence(owner, id, fileId) {
      return transaction(async client => {
        const row = await find(client, owner, id, true); mutable(row);
        const removed = await client.query('UPDATE audit_evidence SET deleted_at=NOW() WHERE draft_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id', [row.id, uuid(fileId)]);
        return { revision: removed.rows.length ? Number(await bump(client, row.id)) : Number(row.revision) };
      });
    },
    async downloadEvidence(owner, id, fileId) {
      const file = await transaction(async client => {
        const row = await find(client, owner, id);
        const file = (await client.query('SELECT * FROM audit_evidence WHERE draft_id=$1 AND id=$2 AND deleted_at IS NULL', [row.id, uuid(fileId)])).rows[0];
        if (!file) fail(404, 'NOT_FOUND', 'Файл не найден.');
        return file;
      });
      return Object.assign(evidenceMetadata(file), { buffer: await originals.read(file) });
    },
    async loadDraftForSubmit(owner, id, expected) {
      const loaded = await transaction(async client => {
        const row = await find(client, owner, id, true); checkRevision(row, expected);
        return snapshot(client, row, true);
      });
      if (loaded.submitted_at) return Object.assign({}, loaded, { evidence: loaded.evidence.map(evidenceMetadata) });
      // Hydration happens before freezing: a failed original read must leave an
      // editable report, and no network request holds the row lock meanwhile.
      const complete = await hydrate(loaded);
      return transaction(async client => {
        const row = await find(client, owner, id, true); checkRevision(row, expected);
        if (!row.submitted_at && row.submitting_revision == null) {
          await client.query('UPDATE audit_drafts SET submitting_revision=revision WHERE id=$1', [row.id]);
          row.submitting_revision = row.revision;
        }
        return Object.assign({}, complete, { submitted_at: row.submitted_at, submitting: row.submitting_revision != null });
      });
    },
    async releaseDraftSubmission(owner, id, expected) {
      return transaction(async client => {
        const row = await find(client, owner, id, true); checkRevision(row, expected);
        if (row.delivery && Object.keys(row.delivery).length) fail(409, 'PARTIAL_DELIVERY', 'Отправка уже началась. Повторите её без изменения отчёта.');
        if (!row.submitted_at) await client.query('UPDATE audit_drafts SET submitting_revision=NULL WHERE id=$1', [row.id]);
      });
    },
    async loadDraftDelivery(owner, id) {
      return transaction(async client => (await find(client, owner, id)).delivery || {});
    },
    async saveDraftDelivery(owner, id, expected, progress) {
      const safe = validateData(progress, Object.assign({}, limits, { metadataBytes: 256 * 1024 }));
      return transaction(async client => {
        const row = await find(client, owner, id, true); checkRevision(row, expected);
        if (Number(row.submitting_revision) !== Number(row.revision)) fail(409, 'NOT_SUBMITTING', 'Отчёт не подготовлен к отправке.');
        await client.query('UPDATE audit_drafts SET delivery=$1,updated_at=NOW() WHERE id=$2', [JSON.stringify(safe), row.id]);
      });
    },
    async markDraftSubmitted(owner, id, expected) {
      return transaction(async client => {
        const row = await find(client, owner, id, true); checkRevision(row, expected);
        if (!row.submitted_at) {
          if (Number(row.submitting_revision) !== Number(row.revision)) fail(409, 'NOT_SUBMITTING', 'Сначала подготовьте отчёт к отправке.');
          await client.query('UPDATE audit_drafts SET submitted_at=NOW(),submitting_revision=NULL,updated_at=NOW() WHERE id=$1', [row.id]);
        }
      });
    },
  };
}

const store = createDraftStore();
function setupAuditDrafts(app, draftStore = store) {
  function route(fn) { return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); }
    catch (e) {
      if (!(e instanceof DraftError)) console.error('audit drafts:', e.message);
      res.status(e.status || 500).json({ ok: false, code: e.code || 'DRAFT_ERROR', error: e instanceof DraftError || e instanceof AuditEvidenceStorageError ? e.message : 'Не удалось сохранить материалы проверки. Повторите попытку.' });
    }
  }; }
  app.get('/api/audit/drafts/current', route(async (req, res) => res.json({ ok: true, draft: await draftStore.current(req.tgUser.id, req.query.order_id) })));
  app.get('/api/audit/drafts/open', route(async (req, res) => res.json({ ok: true, drafts: await draftStore.listOpen(req.tgUser.id) })));
  app.post('/api/audit/drafts', route(async (req, res) => {
    const draft = await draftStore.create(req.tgUser.id, req.body.order_id, req.body.data || {});
    res.json({ ok: true, draft, id: draft.id, revision: draft.revision });
  }));
  app.put('/api/audit/drafts/:id', route(async (req, res) => {
    const draft = await draftStore.update(req.tgUser.id, req.params.id, req.body.revision, req.body.data);
    res.json({ ok: true, draft, revision: draft.revision });
  }));
  app.post('/api/audit/drafts/:id/evidence', route(async (req, res) => res.json(Object.assign({ ok: true }, await draftStore.addEvidence(req.tgUser.id, req.params.id, req.body)))));
  app.delete('/api/audit/drafts/:id/evidence/:fileId', route(async (req, res) => res.json(Object.assign({ ok: true }, await draftStore.removeEvidence(req.tgUser.id, req.params.id, req.params.fileId)))));
  app.get('/api/audit/drafts/:id/evidence/:fileId', route(async (req, res) => {
    const file = await draftStore.downloadEvidence(req.tgUser.id, req.params.id, req.params.fileId);
    const encoded = encodeURIComponent(file.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    res.set('X-Content-Type-Options', 'nosniff').set('Content-Disposition', "attachment; filename=\"document\"; filename*=UTF-8''" + encoded).type(file.mime).send(file.buffer);
  }));
}

module.exports = { setupAuditDrafts, createDraftStore, validateData, prepareEvidence, DraftError, LIMITS, DDL,
  loadDraftForSubmit: store.loadDraftForSubmit, releaseDraftSubmission: store.releaseDraftSubmission, markDraftSubmitted: store.markDraftSubmitted,
  loadDraftDelivery: store.loadDraftDelivery, saveDraftDelivery: store.saveDraftDelivery, withDraftDeliveryLock: store.withDraftDeliveryLock };
