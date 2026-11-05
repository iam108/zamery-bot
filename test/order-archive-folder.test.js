const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const yauzl = require('yauzl');
const { downloadArchive, setupOrderArchive } = require('../src/web/order-archive');
const { zipParts } = require('../src/web/order-materials');

const publicKey = 'https://disk.360.yandex.ru/d/RPoUCOS6PFusPQ';
const root = '/Ч/ЧООКДИ', archive = publicKey + '?path=' + encodeURIComponent(root);
const digest = (field, buffer) => createHash(field).update(buffer).digest('hex');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(options = {}) {
  const calls = [], originals = new Map(), resources = new Map();
  function directory(path) { const node = { type: 'dir', name: path.split('/').pop(), path, children: [] }; resources.set(path, node); return node; }
  function file(path, text) {
    const buffer = Buffer.from(text), node = { type: 'file', name: path.split('/').pop(), path, size: buffer.length, mime_type: 'application/octet-stream', sha256: digest('sha256', buffer), md5: digest('md5', buffer) };
    originals.set(path, buffer); resources.set(path, node); return node;
  }
  const folder = directory(root), nested = directory(root + '/Планы'), empty = directory(root + '/Пустая папка');
  folder.children.push(file(root + '/Акт.txt', 'Original act'), nested, empty, file(root + '/Нулевой файл.txt', ''));
  nested.children.push(file(nested.path + '/План 1.txt', 'Nested original plan'), file(nested.path + '/Акт.txt', 'Another act with the same basename'));
  function metadata(node) { const { children, ...result } = node; return result; }
  const fetch = async (value, init) => {
    const url = new URL(value), path = url.searchParams.get('path'); calls.push({ url, init });
    assert.equal(init.headers?.Authorization, undefined);
    if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const custom = await options.respond?.({ url, init, path, resources, originals, metadata }); if (custom) return custom;
    if (url.hostname === 'downloader.disk.yandex.ru') {
      assert.ok(originals.has(path)); const body = originals.get(path);
      return new Response(body, { headers: { 'Content-Length': String(body.length), 'Content-Type': 'application/octet-stream' } });
    }
    assert.equal(url.origin + url.pathname.replace(/\/download$/, ''), 'https://cloud-api.yandex.net/v1/disk/public/resources');
    assert.equal(url.searchParams.get('public_key'), publicKey); assert.ok(path === root || path.startsWith(root + '/'));
    const node = resources.get(path); assert.ok(node, 'Only the selected subtree can be requested');
    if (url.pathname.endsWith('/download')) {
      if (path === root) return json({ error: 'InternalServerError' }, options.nativeStatus || 500);
      return json({ href: 'https://downloader.disk.yandex.ru/original?path=' + encodeURIComponent(path) });
    }
    if (!url.searchParams.has('offset') || node.type === 'file') return json(metadata(node));
    const offset = Number(url.searchParams.get('offset')), limit = 2;
    return json({ ...metadata(node), _embedded: { total: node.children.length, offset, limit, items: node.children.slice(offset, offset + limit).map(metadata) } });
  };
  return { calls, resources, originals, folder, fetch, metadata };
}
async function unzip(buffer) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
    if (error) return reject(error); const entries = new Map(); zip.on('error', reject); zip.once('end', () => resolve(entries));
    zip.on('entry', entry => zip.openReadStream(entry, (error, input) => {
      if (error) return reject(error); const chunks = []; input.on('error', reject); input.on('data', chunk => chunks.push(chunk)); input.once('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
    })); zip.readEntry();
  }));
}

test('unavailable native folder ZIP falls back to all paginated nested originals and empty directories', async () => {
  const mock = fixture(), result = await downloadArchive(archive, mock), contents = await unzip(result.buffer);
  assert.equal(result.name, 'ЧООКДИ.zip'); assert.equal(result.mime, 'application/zip'); assert.equal(result.bytes, result.buffer.length);
  assert.deepEqual([...contents.keys()].sort(), ['Акт.txt', 'Нулевой файл.txt', 'Планы/', 'Планы/Акт.txt', 'Планы/План 1.txt', 'Пустая папка/'].sort());
  for (const [path, buffer] of mock.originals) { const found = contents.get(path.slice(root.length + 1)); assert.ok(found.equals(buffer)); assert.equal(digest('sha256', found), mock.resources.get(path).sha256); }
  const pages = mock.calls.filter(call => call.url.searchParams.has('offset'));
  assert.ok(pages.some(call => call.url.searchParams.get('path') === root && call.url.searchParams.get('offset') === '2'));
  assert.ok(pages.every(call => call.url.searchParams.get('limit') === '100' && call.url.searchParams.get('sort') === 'name'));
  assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/download') && call.url.searchParams.get('path') === root).length, 1);
});

test('native folder ZIP remains the first choice and its original bytes are returned unchanged', async () => {
  const original = Buffer.concat([...zipParts([{ name: 'Original.txt', buffer: Buffer.from('Native original') }])]);
  const mock = fixture({ respond({ url, path }) {
    if (path === root && url.pathname.endsWith('/download')) return json({ href: 'https://downloader.disk.yandex.ru/native' });
    if (url.pathname === '/native') return new Response(original, { headers: { 'Content-Type': 'application/zip' } });
  } });
  const result = await downloadArchive(archive, mock); assert.ok(result.buffer.equals(original)); assert.equal(mock.calls.length, 3);
});

test('ZIP transfer 5xx and native ZIP timeouts allow fallback, without consuming the parent deadline', async () => {
  for (const mode of ['transfer-503', 'native-timeout']) {
    const mock = fixture({ respond({ url, path, init }) {
      if (path === root && url.pathname.endsWith('/download')) {
        if (mode === 'native-timeout') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        return json({ href: 'https://downloader.disk.yandex.ru/native' });
      }
      if (url.pathname === '/native') return new Response(null, { status: 503 });
    } });
    const result = await downloadArchive(archive, { ...mock, nativeTimeoutMs: 10, timeoutMs: 3000 }); assert.equal((await unzip(result.buffer)).size, 6);
  }
});

test('denied throttled missing malformed and truncated native archives never trigger folder enumeration', async () => {
  for (const status of [400, 401, 403, 404, 429]) {
    const mock = fixture({ nativeStatus: status }); await assert.rejects(downloadArchive(archive, mock), error => error.code === 'ARCHIVE_UNAVAILABLE');
    assert.equal(mock.calls.length, 2);
  }
  for (const body of [Buffer.from('not a ZIP'), Buffer.from('504b0304140000000000', 'hex')]) {
    const mock = fixture({ respond({ url, path }) {
      if (path === root && url.pathname.endsWith('/download')) return json({ href: 'https://downloader.disk.yandex.ru/native' });
      if (url.pathname === '/native') return new Response(body, { headers: { 'Content-Type': 'application/zip' } });
    } });
    await assert.rejects(downloadArchive(archive, mock), error => ['ARCHIVE_UNAVAILABLE', 'ARCHIVE_INCOMPLETE'].includes(error.code)); assert.equal(mock.calls.length, 3);
  }
});

test('all file bytes and ZIP overhead share the same budget and a too-large manifest downloads no files', async () => {
  const normal = await downloadArchive(archive, fixture()), exact = await downloadArchive(archive, { ...fixture(), maxBytes: normal.bytes }); assert.ok(exact.buffer.equals(normal.buffer));
  const small = fixture(); await assert.rejects(downloadArchive(archive, { ...small, maxBytes: normal.bytes - 1 }), error => error.code === 'ARCHIVE_TOO_LARGE');
  assert.equal(small.calls.filter(call => call.url.hostname === 'downloader.disk.yandex.ru').length, 0);
});

test('file changes, invalid hashes, missing files and child access limits fail the whole fallback', async () => {
  for (const mode of ['size', 'hash', 'changed', 'missing', 'denied', 'throttled']) {
    const mock = fixture({ respond({ url, path, metadata, resources }) {
      if (path === root + '/Акт.txt' && mode === 'changed' && url.hostname === 'downloader.disk.yandex.ru') return new Response(Buffer.from('Changed act!'));
      if (path === root + '/Акт.txt' && url.hostname === 'cloud-api.yandex.net' && !url.pathname.endsWith('/download')) {
        if (mode === 'missing') return json({ error: 'NotFound' }, 404);
        if (mode === 'denied') return json({ error: 'Forbidden' }, 403);
        if (mode === 'throttled') return json({ error: 'TooManyRequests' }, 429);
        const item = metadata(resources.get(path));
        if (mode === 'size') item.size++;
        else if (mode === 'changed') for (const field of ['sha256', 'md5']) item[field] = digest(field, Buffer.from('Changed act!'));
        else item.sha256 = '0'.repeat(64);
        return json(item);
      }
    } });
    await assert.rejects(downloadArchive(archive, mock), error => ['ARCHIVE_INCOMPLETE', 'ARCHIVE_INTEGRITY', 'ARCHIVE_UNAVAILABLE'].includes(error.code));
    assert.equal(mock.calls.filter(call => call.url.searchParams.get('path') === root && call.url.pathname.endsWith('/download')).length, 1);
  }
});

test('an exact public root folder with a trailing slash remains a valid empty ZIP', async () => {
  const { assembleFolderArchive } = require('../src/web/order-archive-folder');
  const result = await assembleFolderArchive({ parsed: { path: '/' }, metadata: { name: 'Empty root' }, maxBytes: 22, signal: new AbortController().signal,
    requestMetadata: async path => { assert.equal(path, ''); return { type: 'dir', path: '/', _embedded: { items: [], total: 0, offset: 0, limit: 100 } }; },
    downloadFile: () => assert.fail('An empty folder has no file requests'), fail: () => assert.fail('Valid empty folder'),
  });
  assert.equal(result.bytes, 22); assert.equal((await unzip(result.buffer)).size, 0);
});

test('malformed names paths duplicates pagination and traversal caps cannot produce a partial ZIP', async () => {
  for (const mode of ['dot', 'slash', 'backslash', 'outside', 'duplicate', 'offset', 'total', 'empty-page', 'unknown-size', 'depth', 'entries']) {
    const mock = fixture({ respond({ url, path, resources, metadata }) {
      if (path !== root || !url.searchParams.has('offset')) return;
      const offset = Number(url.searchParams.get('offset')), children = resources.get(root).children;
      const page = { ...metadata(resources.get(root)), _embedded: { total: children.length, offset, limit: 2, items: children.slice(offset, offset + 2).map(metadata) } }, embedded = page._embedded;
      if (!offset) {
        if (mode === 'dot') embedded.items[0].name = '..';
        if (mode === 'slash') embedded.items[0].name = 'wrong/name';
        if (mode === 'backslash') embedded.items[0].name = 'wrong\\name';
        if (mode === 'outside') embedded.items[0].path = '/Другой объект/Акт.txt';
        if (mode === 'duplicate') embedded.items[1] = { ...embedded.items[0] };
        if (mode === 'offset') embedded.offset = 1;
        if (mode === 'empty-page') embedded.items = [];
        if (mode === 'unknown-size') delete embedded.items[0].size;
      } else if (mode === 'total') embedded.total++;
      return json(page);
    } });
    const options = mode === 'depth' ? { folderMaxDepth: 0 } : mode === 'entries' ? { folderMaxEntries: 2 } : {};
    await assert.rejects(downloadArchive(archive, { ...mock, ...options }), error => error.code === 'ARCHIVE_INCOMPLETE', mode);
    assert.equal(mock.calls.filter(call => call.url.hostname === 'downloader.disk.yandex.ru').length, 0, mode);
  }
});

test('parent cancellation stops manifest traversal and active child downloads without another request', async () => {
  for (const stage of ['initial', 'listing', 'file']) {
    const controller = new AbortController(); if (stage === 'initial') controller.abort();
    const mock = fixture({ respond({ url, path, init }) {
      if (stage === 'listing' && url.searchParams.has('offset')) { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }
      if (stage === 'file' && url.hostname === 'downloader.disk.yandex.ru') return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); controller.abort();
      });
    } });
    await assert.rejects(downloadArchive(archive, { ...mock, signal: controller.signal }), error => error.code === 'ARCHIVE_TIMEOUT');
    if (stage === 'initial') assert.equal(mock.calls.length, 0);
    if (stage === 'file') assert.equal(mock.calls.filter(call => call.url.hostname === 'downloader.disk.yandex.ru').length, 1);
  }
});

test('preserving ZIP paths is explicit and rejects unsafe or duplicate relative names', async () => {
  const buffer = Buffer.from('Original');
  const standard = await unzip(Buffer.concat([...zipParts([{ name: 'Same.txt', buffer }, { name: 'Same.txt', buffer }]) ])); assert.deepEqual([...standard.keys()], ['01-Same.txt', '02-Same.txt']);
  for (const relative_path of ['', '/absolute.txt', '../escape.txt', 'dir/../escape.txt', 'dir\\escape.txt', 'dir//file.txt', 'C:/file.txt', 'bad\u0000name']) assert.throws(() => [...zipParts([{ relative_path, buffer }], { preservePaths: true })]);
  assert.throws(() => [...zipParts([{ relative_path: 'same.txt', buffer }, { relative_path: 'same.txt', buffer }], { preservePaths: true })]);
});

test('archive route propagates a disconnected browser to the provider request', async () => {
  const { EventEmitter } = require('node:events'); let handler, started, aborted = false;
  const ready = new Promise(resolve => { started = resolve; });
  setupOrderArchive({ get(path, callback) { handler = callback; } }, { getOrder: async () => ({ service: 'Продление', archive_url: archive }), fetch(url, init) {
    started(); return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
  } });
  const req = Object.assign(new EventEmitter(), { params: { id: '58' } }), res = Object.assign(new EventEmitter(), { set() { return this; }, status() { return this; }, json() {} });
  const running = handler(req, res); await ready; res.emit('close'); await running; assert.equal(aborted, true); assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});
