'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');
const yauzl = require('yauzl');
const { downloadArchive } = require('../src/web/order-archive');
const { zipParts, crc32 } = require('../src/web/order-materials');
const key = 'https://disk.yandex.ru/d/abcdefghi', root = '/Объект';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// Produce structurally valid ZIP entries, optionally deflating a different
// equal-length payload while retaining the original published CRC.
function nativeZip(files) {
  const data = [], directory = []; let offset = 0;
  for (const file of files) {
    const single = Buffer.concat([...zipParts([file], { preservePaths: true })]);
    const contentAt = 30 + single.readUInt16LE(26), centralAt = contentAt + file.buffer.length;
    const header = Buffer.from(single.subarray(0, contentAt)), central = Buffer.from(single.subarray(centralAt, single.length - 22));
    const payload = file.deflate ? deflateRawSync(file.payload || file.buffer) : file.payload || file.buffer;
    if (file.deflate) { header.writeUInt16LE(8, 8); central.writeUInt16LE(8, 10); }
    header.writeUInt32LE(payload.length, 18); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(offset, 42);
    data.push(header, payload); directory.push(central); offset += header.length + payload.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, central, end]);
}
function nativeFetch(buffer) {
  const calls = [];
  return { calls, async fetch(value) {
    const url = new URL(value); calls.push(url);
    if (url.hostname === 'downloader.disk.yandex.ru') return new Response(buffer, { headers: { 'Content-Type': 'application/zip' } });
    if (url.pathname.endsWith('/download')) return json({ href: 'https://downloader.disk.yandex.ru/native' });
    return json({ type: 'dir', path: root, name: 'Объект' });
  } };
}
const archive = options => downloadArchive(key + '?path=' + encodeURIComponent(root), options);

test('incremental CRC keeps its original API and agrees with the standard vector across empty and arbitrary chunks', () => {
  const body = Buffer.from('123456789'); assert.equal(crc32(body), 0xcbf43926); assert.equal(crc32(Buffer.alloc(0)), 0);
  for (let split = 0; split <= body.length; split++) assert.equal(crc32(body.subarray(split), crc32(body.subarray(0, split))), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0), 0xcbf43926), 0xcbf43926);
});

test('native ZIP preserves valid UTF8 nested, directory, empty and deflated entries byte for byte', async () => {
  const original = nativeZip([
    { relative_path: 'Планы/', directory: true, buffer: Buffer.alloc(0) },
    { relative_path: 'Планы/Поэтажный план.txt', buffer: Buffer.from('Полный исходный план'), deflate: true },
    { relative_path: 'Пустой.txt', buffer: Buffer.alloc(0), deflate: true },
    { relative_path: 'Акт.txt', buffer: Buffer.from('Original act') },
  ]);
  const mock = nativeFetch(original), result = await archive(mock);
  assert.ok(result.buffer.equals(original)); assert.equal(mock.calls.length, 3);
});

test('stored and deflated entry payload corruption is rejected without replacing the native ZIP by a folder fallback', async () => {
  for (const deflate of [false, true]) {
    const corrupt = nativeZip([{ relative_path: 'План.txt', buffer: Buffer.from('Original plan'), payload: Buffer.from('Changed! plan'), deflate }]);
    const mock = nativeFetch(corrupt);
    await assert.rejects(archive(mock), error => error.code === 'ARCHIVE_INCOMPLETE');
    assert.equal(mock.calls.length, 3); assert.equal(mock.calls.some(url => url.searchParams.has('offset')), false);
  }
});

test('invalid deflate data, unreadable local headers and incorrect expanded sizes cannot be reported as complete native ZIPs', async () => {
  const valid = nativeZip([{ relative_path: 'План.txt', buffer: Buffer.from('Original plan'), deflate: true }]);
  for (const mode of ['deflate', 'local-header', 'expanded-size']) {
    const corrupt = Buffer.from(mode === 'local-header' ? nativeZip([{ relative_path: 'Первый.txt', buffer: Buffer.from('First original') }, { relative_path: 'План.txt', buffer: Buffer.from('Original plan'), deflate: true }]) : valid);
    const dataAt = 30 + corrupt.readUInt16LE(26), size = corrupt.readUInt32LE(18), centralAt = dataAt + size;
    if (mode === 'deflate') corrupt.fill(0xff, dataAt, dataAt + size);
    if (mode === 'local-header') corrupt.writeUInt32LE(0, centralAt);
    if (mode === 'expanded-size') { corrupt.writeUInt32LE(100, 22); corrupt.writeUInt32LE(100, centralAt + 24); }
    const mock = nativeFetch(corrupt); await assert.rejects(archive(mock), error => error.code === 'ARCHIVE_INCOMPLETE', mode); assert.equal(mock.calls.length, 3);
  }
});

test('expanded entry contents are streamed without imposing a new cap below a valid compressed native archive', async () => {
  const original = nativeZip([{ relative_path: 'Большой план.txt', buffer: Buffer.alloc(2 * 1024 * 1024, 65), deflate: true }]);
  const result = await archive({ ...nativeFetch(original), maxBytes: original.length }); assert.ok(result.buffer.equals(original));
});

test('parent abort during an expanded entry destroys the active stream, closes the ZIP and never begins its next entry or fallback', async t => {
  const controller = new AbortController(); let destroyed = false, closed = false, opened = 0;
  const fromBuffer = yauzl.fromBuffer;
  t.mock.method(yauzl, 'fromBuffer', (buffer, options, callback) => fromBuffer(buffer, options, (error, zip) => {
    if (error) return callback(error);
    const close = zip.close, open = zip.openReadStream;
    zip.close = function () { closed = true; return close.call(this); };
    zip.openReadStream = function (entry, done) {
      opened++;
      return open.call(this, entry, (error, input) => {
        if (input) { const destroy = input.destroy; input.destroy = function (...args) { destroyed = true; return destroy.apply(this, args); }; input.once('data', () => controller.abort()); }
        done(error, input);
      });
    };
    callback(null, zip);
  }));
  const original = nativeZip([{ relative_path: 'Первый.txt', buffer: Buffer.alloc(128 * 1024, 65), deflate: true }, { relative_path: 'Второй.txt', buffer: Buffer.from('Next original') }]);
  const mock = nativeFetch(original); await assert.rejects(archive({ ...mock, signal: controller.signal }), error => error.code === 'ARCHIVE_TIMEOUT');
  assert.equal(destroyed, true); assert.equal(closed, true); assert.equal(opened, 1); assert.equal(mock.calls.length, 3);
});

test('genuine JSON and HTML originals remain part of the fallback when normalized declared MIME matches the response', async () => {
  for (const [mime, name, original] of [['Application/JSON; charset=utf-8','annotations.json','{"plan":"Original annotations"}'],['TEXT/HTML; charset=utf-8','index.html','<!doctype html><p>Original archived plan</p>']]) {
    const body = Buffer.from(original), path = root + '/' + name;
    const file = { type: 'file', name, path, mime_type: mime, size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    const fetch = async value => {
      const url = new URL(value), selected = url.searchParams.get('path');
      if (url.hostname === 'downloader.disk.yandex.ru') return new Response(body, { headers: { 'Content-Type': mime } });
      if (url.pathname.endsWith('/download')) return selected === root ? json({}, 500) : json({ href: 'https://downloader.disk.yandex.ru/original' });
      if (selected === path) return json(file);
      return json({ type: 'dir', name: 'Объект', path: root, ...(url.searchParams.has('offset') ? { _embedded: { items: [file], total: 1, offset: 0, limit: 100 } } : {}) });
    };
    const result = await archive({ fetch });
    assert.ok(result.buffer.equals(Buffer.concat([...zipParts([{ relative_path: name, buffer: body }], { preservePaths: true })])));
  }
});

test('matching JSON MIME still requires exact original size and checksums; PDF and folder HTML errors stay rejected', async () => {
  const original = Buffer.from('{"original":1}'), changed = Buffer.from('{"original":2}');
  for (const mode of ['hash','size','pdf','folder']) {
    let calls = 0;
    const file = { type: mode === 'folder' ? 'dir' : 'file', name: 'Original', size: original.length, mime_type: mode === 'pdf' ? 'application/pdf' : 'application/json', sha256: createHash('sha256').update(original).digest('hex') };
    const fetch = async value => {
      calls++; const url = new URL(value);
      if (url.hostname === 'downloader.disk.yandex.ru') return new Response(mode === 'size' ? original.subarray(0, 2) : changed, { headers: { 'Content-Type': ['pdf','folder'].includes(mode) ? 'text/html' : 'application/json' } });
      return url.pathname.endsWith('/download') ? json({ href: 'https://downloader.disk.yandex.ru/original' }) : json(file);
    };
    await assert.rejects(archive({ fetch }), error => error.code === ({ hash: 'ARCHIVE_INTEGRITY', size: 'ARCHIVE_INCOMPLETE', pdf: 'ARCHIVE_UNAVAILABLE', folder: 'ARCHIVE_UNAVAILABLE' })[mode]);
    assert.equal(calls, 3);
  }
});
