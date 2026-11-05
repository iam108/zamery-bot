const { createHash } = require('node:crypto');
const { zipParts } = require('./order-materials');

// Public Resource metadata is paginated independently for each directory.
// Keep paths relative to the requested object, never to the shared archive.
async function assembleFolderArchive({ parsed, metadata, requestMetadata, downloadFile, signal, maxBytes, fail, maxDepth = 32, maxEntries = 10000 }) {
  const entries = [], seen = new Set(); let bytes = 22;
  const incomplete = () => fail(502, 'ARCHIVE_INCOMPLETE', 'Не удалось подтвердить полный состав папки архива. Повторите скачивание; неполный архив не сохранён.');
  const aborted = () => { if (signal.aborted) fail(504, 'ARCHIVE_TIMEOUT', 'Скачивание архива прервано. Повторите скачивание.'); };
  function add(item, relative, path) {
    if (seen.has(relative) || entries.length >= maxEntries) incomplete();
    seen.add(relative);
    const directory = item.type === 'dir', relative_path = relative + (directory ? '/' : '');
    const size = directory ? 0 : item.size;
    if (!Number.isSafeInteger(size) || size < 0) incomplete();
    const nameBytes = Buffer.byteLength(relative_path, 'utf8');
    if (nameBytes > 65535) incomplete();
    bytes += 76 + 2 * nameBytes + size;
    if (bytes > maxBytes) fail(413, 'ARCHIVE_TOO_LARGE', 'Архив слишком большой для скачивания из формы. Попросите менеджера приложить нужные документы отдельно.');
    entries.push({ relative_path, directory, path, metadata: item, size });
  }
  async function list(path, relative, depth) {
    if (depth > maxDepth) incomplete();
    let offset = 0, total;
    do {
      aborted();
      const page = await requestMetadata(path, offset, 100), embedded = page._embedded;
      if (page.type !== 'dir' || (page.path != null && page.path !== (path || '/')) || !embedded || !Array.isArray(embedded.items) || !Number.isSafeInteger(embedded.total) || embedded.total < 0 || embedded.offset !== offset || !Number.isSafeInteger(embedded.limit) || embedded.limit <= 0 || embedded.limit > 100 || embedded.items.length > embedded.limit || offset + embedded.items.length > embedded.total) incomplete();
      if (total == null) total = embedded.total;
      if (total !== embedded.total || total > maxEntries - entries.length + offset || (!embedded.items.length && offset < total)) incomplete();
      // Validate the complete page before issuing any descendant requests.
      const children = embedded.items.map(item => {
        const name = item.name;
        if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name) || (!relative && /^[a-z]:/i.test(name)) || !['file', 'dir'].includes(item.type)) incomplete();
        const childPath = (path || '') + '/' + name, childRelative = (relative ? relative + '/' : '') + name;
        if (item.path !== childPath) incomplete();
        add(item, childRelative, childPath);
        return { item, childPath, childRelative };
      });
      offset += embedded.items.length;
      for (const child of children) if (child.item.type === 'dir') await list(child.childPath, child.childRelative, depth + 1);
    } while (offset < total);
  }
  await list(parsed.path.replace(/\/+$/, ''), '', 0);
  const overhead = bytes - entries.reduce((sum, item) => sum + item.size, 0);
  let remaining = maxBytes - overhead;
  for (const entry of entries) {
    aborted();
    if (entry.directory) { entry.buffer = Buffer.alloc(0); continue; }
    const file = await downloadFile(entry.path, remaining);
    if (file.buffer.length !== entry.size) incomplete();
    for (const [field, length] of [['sha256', 64], ['md5', 32]]) {
      const expected = entry.metadata[field];
      if (expected == null || expected === '') continue;
      if (typeof expected !== 'string' || !new RegExp('^[a-f0-9]{' + length + '}$', 'i').test(expected) || createHash(field).update(file.buffer).digest('hex') !== expected.toLowerCase()) fail(502, 'ARCHIVE_INTEGRITY', 'Содержимое файла изменилось во время скачивания архива. Повторите скачивание.');
    }
    entry.buffer = file.buffer; remaining -= file.buffer.length;
  }
  aborted();
  const chunks = [];
  for (const chunk of zipParts(entries, { preservePaths: true })) { aborted(); chunks.push(chunk); }
  const buffer = Buffer.concat(chunks, bytes);
  if (buffer.length > maxBytes) fail(413, 'ARCHIVE_TOO_LARGE', 'Архив слишком большой для скачивания из формы.');
  return { buffer, name: metadata.name, bytes: buffer.length };
}

module.exports = { assembleFolderArchive };
