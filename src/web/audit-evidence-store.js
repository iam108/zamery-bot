const { randomUUID, createHash } = require('node:crypto');
const { createEgrnObjectStore } = require('../bot/egrn-object-store');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^audit-originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
const MAX_BYTES = 12 * 1024 * 1024;
class AuditEvidenceStorageError extends Error {
  constructor(code) {
    super('Не удалось подтвердить оригинал материала проверки. Повторите загрузку или открытие файла.');
    this.status = 503; this.code = code;
  }
}
function invalid(code = 'AUDIT_EVIDENCE_INTEGRITY') { throw new AuditEvidenceStorageError(code); }
function createAuditEvidenceStore(options = {}) {
  const objects = options.objectStore || createEgrnObjectStore({ namespace: 'audit-originals' });
  function validate(row) {
    if (!Number.isSafeInteger(Number(row.bytes)) || Number(row.bytes) < 1 || Number(row.bytes) > MAX_BYTES || !/^[0-9a-f]{64}$/.test(row.sha256 || '')) invalid();
  }
  function key(draftId) {
    if (!UUID.test(draftId || '')) invalid('AUDIT_EVIDENCE_ARGUMENT');
    return 'audit-originals/' + draftId.toLowerCase() + '/' + randomUUID();
  }
  async function put(objectKey, file) {
    validate(file);
    if (!KEY.test(objectKey) || !Buffer.isBuffer(file.content) || file.content.length !== file.bytes) invalid();
    await objects.put({ key: objectKey, bytes: file.bytes, sha256: file.sha256, mime: file.mime,
      body: (async function* () { yield file.content; })() });
  }
  async function read(row) {
    validate(row);
    if (!row.storage || row.storage === 'postgres') {
      const content = Buffer.from(row.content || []);
      if (content.length !== Number(row.bytes) || createHash('sha256').update(content).digest('hex') !== row.sha256) invalid();
      return content;
    }
    if (row.storage !== 's3' || !KEY.test(row.object_key || '') || !row.object_key.startsWith('audit-originals/' + row.draft_id + '/')) invalid();
    let source;
    try {
      source = await objects.get({ key: row.object_key, bytes: Number(row.bytes), sha256: row.sha256, mime: row.mime });
      const chunks = [], hash = createHash('sha256'); let count = 0;
      for await (const value of source) {
        const chunk = Buffer.from(value); count += chunk.length;
        if (count > Number(row.bytes) || count > MAX_BYTES) invalid();
        hash.update(chunk); chunks.push(chunk);
      }
      if (count !== Number(row.bytes) || hash.digest('hex') !== row.sha256) invalid();
      return Buffer.concat(chunks, count);
    } catch (error) {
      source?.destroy?.();
      if (error instanceof AuditEvidenceStorageError) throw error;
      throw new AuditEvidenceStorageError('AUDIT_EVIDENCE_READ');
    }
  }
  return { configured: () => objects.configured(), key, put, read,
    async remove(objectKey) { if (!KEY.test(objectKey || '')) invalid('AUDIT_EVIDENCE_ARGUMENT'); await objects.remove(objectKey); } };
}

module.exports = { createAuditEvidenceStore, AuditEvidenceStorageError };
