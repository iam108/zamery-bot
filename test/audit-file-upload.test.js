const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/web/audit-wizard-client.js'), 'utf8');
function actualFunction(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name + ' exists in the shipped browser client');
  const rest = source.slice(start), next = rest.slice(1).search(/\n  (?:(?:async )?function |var )/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
function load(context, ...names) { if(names.includes('request'))names=['requestWithDeadline',...names];vm.runInContext(names.map(actualFunction).join('\n'), context); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function arrayBuffer(bytes) { return Uint8Array.from(bytes).buffer; }
function file(name = '1000168435.jpg', bytes = [0xff, 0xd8, 0xff, 0xe0, 0, 1]) {
  return { name, type: 'image/jpeg', size: bytes.length, arrayBuffer: async () => arrayBuffer(bytes) };
}
// Complete 2×2 images. These exercise actual encoded image bytes, not just
// matching extensions or a header fragment. No fixture reads or network needed.
const images = [
  { name: 'territory.png', type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPQrdgHRAwQCgAkngWNJSaBZgAAAABJRU5ErkJggg==' },
  { name: 'territory.jpg', type: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A8nooor+wD+Uz/9k=' }
];
function harness() {
  const events = [], notices = [], status = [], uploads = [];
  const c = {
    window: {}, tg: null, console, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout, clearTimeout, queueMicrotask,
    state: { evidence: [], pendingUploads: 0, submitting: false, frozen: false, conflict: false, packet: {} },
    tail: Promise.resolve(), queuedJobs: 0,
    status(text) { status.push(text); }, notify(text) { notices.push(text); },
    flush: async () => { events.push('flush'); },
    postEvidence: async (chosen, role, subject, data) => {
      const evidence = { id: 'evidence-' + (uploads.length + 1), name: chosen.name, role, subject_id: subject };
      uploads.push({ file: chosen, role, subject, data }); c.state.evidence.push(evidence); return evidence;
    },
    localSave() {}, render() { events.push('render'); }, timeLabel: () => '12:00',
    $: () => null,
    FileReader: class {
      readAsDataURL() { throw new Error('Unexpected FileReader fallback'); }
    }
  };
  vm.createContext(c); load(c, 'updateClosingConfirmation', 'queue', 'readBase64', 'fileMime', 'uploadFiles');
  return { c, events, notices, status, uploads };
}

test('selected Android file bytes are encoded directly, including data larger than one conversion chunk', async () => {
  const { c } = harness(), bytes = Array.from({ length: 70001 }, (_, n) => n % 256);
  const chosen = file('large-screenshot.jpg', bytes);
  assert.equal(await c.readBase64(chosen), Buffer.from(bytes).toString('base64'));
});

for (const image of images) test('a complete ' + image.type + ' screenshot reaches evidence storage byte-for-byte', async () => {
  const { c, uploads } = harness(), original = Buffer.from(image.data, 'base64'), chosen = file(image.name, original);
  chosen.type = image.type;
  await c.uploadFiles([chosen], 'map-source', 'source', { noRender: true });
  assert.equal(uploads.length, 1); assert.equal(uploads[0].file.type, image.type);
  assert.deepEqual(Buffer.from(uploads[0].data, 'base64'), original);
  assert.equal(c.state.pendingUploads, 0);
});

for (const [index, image] of images.entries()) test('Android generic MIME is resolved for ' + image.type, async () => {
  const { c, uploads } = harness(), original = Buffer.from(image.data, 'base64');
  const chosen = file(image.name, original);
  chosen.type = index ? '' : 'application/octet-stream';
  await c.uploadFiles([chosen], 'map', 'attached', { allowedTypes: ['image/jpeg','image/png'] });
  assert.equal(uploads[0].file.type, image.type);
  assert.deepEqual(Buffer.from(uploads[0].data, 'base64'), original);
});

test('a non-image renamed to PNG is rejected in the finished-scheme flow', async () => {
  const { c, uploads } = harness(), chosen = file('renamed.png', Buffer.from('%PDF-1.7'));
  chosen.type = 'application/octet-stream';
  await assert.rejects(c.uploadFiles([chosen], 'map', 'attached', { allowedTypes: ['image/jpeg','image/png'] }), /Выберите JPG или PNG/);
  assert.equal(uploads.length, 0);
  assert.equal(c.state.pendingUploads, 0);
});

test('an HTML edge challenge is distinguished from the draft API JSON errors', async () => {
  const { c } = harness();
  load(c, 'request');
  c.fetch = async () => ({ status: 200, ok: true, text: async () => '<title>Checking your browser…</title>' });
  await assert.rejects(c.request('/api/audit/drafts/current'), /ограничил доступ/);
  c.fetch = async () => ({ status: 409, ok: false, text: async () => '{"ok":false,"error":"Конфликт","code":"REVISION_CONFLICT"}' });
  await assert.rejects(c.request('/api/audit/drafts/current'), error => error.status === 409 && error.payload.code === 'REVISION_CONFLICT');
});

test('a failed native Blob read falls back to FileReader and preserves every byte', async () => {
  const { c } = harness(), bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0xff]);
  let reads = 0;
  c.FileReader = class {
    readAsDataURL(chosen) {
      assert.equal(chosen.name, '1000168435.jpg'); reads++;
      queueMicrotask(() => { this.result = 'data:image/jpeg;base64,' + bytes.toString('base64'); this.onload(); });
    }
  };
  const chosen = file(); chosen.arrayBuffer = async () => { throw Object.assign(new Error('provider read failed'), { name: 'NotReadableError' }); };
  assert.equal(await c.readBase64(chosen), bytes.toString('base64'));
  assert.equal(reads, 1);
});

test('a WebView without Blob.arrayBuffer still reads a selected image', async () => {
  const { c } = harness(), chosen = file(); delete chosen.arrayBuffer;
  const expected = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]).toString('base64');
  c.FileReader = class {
    readAsDataURL() { queueMicrotask(() => { this.result = 'data:image/jpeg;base64,' + expected; this.onload(); }); }
  };
  assert.equal(await c.readBase64(chosen), expected);
});

for (const event of ['onerror', 'onabort']) test('FileReader ' + event + ' rejects instead of leaving the upload queue pending', { timeout: 1000 }, async () => {
  const { c } = harness(), chosen = file(); delete chosen.arrayBuffer;
  c.FileReader = class { readAsDataURL() { queueMicrotask(() => this[event]()); } };
  await assert.rejects(c.readBase64(chosen), /файл|прочитать|загруз|отмен/i);
});

test('synchronous FileReader access errors are returned as a normal failed read', async () => {
  const { c } = harness(), chosen = file(); delete chosen.arrayBuffer;
  c.FileReader = class { readAsDataURL() { throw Object.assign(new Error('permission denied'), { name: 'SecurityError' }); } };
  await assert.rejects(c.readBase64(chosen));
});

for (const count of [0, 2, 5]) test('an empty or truncated provider read is never uploaded as the complete screenshot (' + count + ' bytes)', async () => {
  const { c, uploads } = harness(), chosen = file(), partial = Buffer.alloc(count, 0xff);
  chosen.arrayBuffer = async () => arrayBuffer(partial);
  c.FileReader = class {
    readAsDataURL() { queueMicrotask(() => { this.result = 'data:image/jpeg;base64,' + partial.toString('base64'); this.onload(); }); }
  };
  await assert.rejects(c.uploadFiles([chosen], 'map-source', 'source', { noRender: true }));
  assert.equal(uploads.length, 0);
  assert.equal(c.state.pendingUploads, 0);
});

test('all selected files start reading before a blocked queue or draft save can lose their picker access', async () => {
  const { c, events, uploads } = harness(), gate = deferred(), reads = [];
  c.tail = gate.promise;
  c.readBase64 = chosen => { reads.push(chosen.name); events.push('read:' + chosen.name); return Promise.resolve('original-' + chosen.name); };
  const chosen = [file('first.jpg'), file('second.jpg')];
  const delivery = c.uploadFiles(chosen, 'map-source', 'source', { noRender: true });
  assert.deepEqual(reads, ['first.jpg', 'second.jpg']);
  assert.equal(c.state.pendingUploads, 2, 'Pending includes the time spent waiting for the queue');
  await settle(); assert.equal(events.includes('flush'), false); assert.equal(uploads.length, 0);
  gate.resolve(); await delivery;
  assert.ok(events.indexOf('read:first.jpg') < events.indexOf('flush'));
  assert.ok(events.indexOf('read:second.jpg') < events.indexOf('flush'));
  assert.deepEqual(uploads.map(row => row.data), ['original-first.jpg', 'original-second.jpg']);
  assert.equal(c.state.pendingUploads, 0);
});

test('already captured editor source data is reused rather than rereading an expired Android file handle', async () => {
  const { c, uploads } = harness(), chosen = file();
  c.readBase64 = () => { assert.fail('The editor already captured these bytes'); };
  await c.uploadFiles([chosen], 'map-source', 'source', { noRender: true, preparedData: [Promise.resolve('captured-original')] });
  assert.equal(uploads.length, 1); assert.equal(uploads[0].data, 'captured-original');
  assert.equal(c.state.pendingUploads, 0);
});

for (const image of images) test('the territory editor captures ' + image.type + ' immediately and hands captured bytes to the upload queue', async () => {
  const { c } = harness(), capture = deferred(), chosen = file(image.name, Buffer.from(image.data, 'base64'));
  chosen.type = image.type; let reads = 0, forwarded;
  c.readBase64 = selected => { assert.equal(selected, chosen); reads++; return capture.promise; };
  c.uploadFiles = async (selected, role, subject, options) => {
    forwarded = { selected, role, subject, options }; return [{ id: 'saved-source' }];
  };
  load(c, 'uploadEditorSource');
  const upload = c.uploadEditorSource(chosen, 'map-source');
  assert.equal(reads, 1, 'Access the Android provider in the selection callback itself');
  assert.equal(forwarded, undefined, 'Do not queue unresolved provider access as a future file read');
  capture.resolve(image.data); assert.equal((await upload).id, 'saved-source');
  assert.equal(forwarded.role, 'map-source'); assert.equal(forwarded.subject, 'source');
  assert.equal(forwarded.options.noRender, true);
  assert.equal(await forwarded.options.preparedData[0], image.data);
  assert.equal(reads, 1, 'The original Android file handle is not accessed twice');
});

test('an unreadable territory source does not reach the upload queue', async () => {
  const { c } = harness();
  c.readBase64 = async () => { throw new Error('Не удалось прочитать файл'); };
  c.uploadFiles = () => { assert.fail('There are no captured bytes to upload'); };
  load(c, 'uploadEditorSource');
  await assert.rejects(c.uploadEditorSource(file(), 'map-source'), /прочитать/);
});

test('an otherwise ready report cannot be submitted or frozen while a territory source is still being captured', async () => {
  const { c, events, notices, uploads } = harness(), capture = deferred(), requests = [], node = { disabled: false, textContent: '', innerHTML: '' };
  c.state.data = {
    schema_version: 3, ui_version: 5, object_category: 'catering',
    inspection: { org: 'ООО Готовый объект', address: 'Москва, Мясницкая, 15', service: 'Получение', visit_date: '2026-11-02' },
    workflow: { conclusion_status: 'ready' }, conclusion: 'Соответствует по проверенным пунктам',
    entrances: [], zones: [], additional_plans: [],
    map: { evidence_id: 'existing-map', page: 1, annotations: [{ id: 'entrance', tool: 'entrance' }] },
    plan: { evidence_id: 'existing-plan', page: 1, annotations: [{ id: 'boundary', tool: 'boundary' }] }
  };
  c.state.draft = { id: 'ready-draft', revision: 5 }; c.state.version = 1;
  c.readBase64 = () => capture.promise;
  c.editor = { flush: async () => { events.push('editor.flush'); } };
  c.issues = () => []; c.isRenewal = () => false; c.evidenceFor = () => [];
  c.refreshChrome = () => {}; c.$ = () => node; c.root = node;
  c.document = { body: { classList: { add() {}, remove() {} } } };
  c.exportGraphic = async () => null; c.removeGeneratedEvidence = async () => {};
  c.request = async url => { requests.push(url); return {}; }; c.adoptRevision = () => {};
  c.localStorage = { setItem() {}, removeItem() {} }; c.tg = null; c.timer = null;
  c.checkSubmissionState = async () => {};
  load(c, 'requiredIssues', 'uploadEditorSource', 'submit');
  const sourceUpload = c.uploadEditorSource(file(), 'map-source');
  assert.equal(c.state.pendingUploads, 1);
  await c.submit();
  assert.equal(events.includes('editor.flush'), false, 'The guard must run before any submission work');
  assert.equal(c.state.submitting, false); assert.equal(c.state.frozen, false);
  assert.equal(c.state.completed, undefined); assert.equal(requests.length, 0); assert.equal(uploads.length, 0);
  assert.ok(notices.some(text => /Дождитесь загрузки/.test(text)));
  capture.resolve('complete-source'); await sourceUpload;
  assert.equal(c.state.pendingUploads, 0); assert.equal(uploads.length, 1);
  assert.equal(c.state.frozen, false); assert.equal(requests.length, 0);
});

test('a failed read sends no evidence and the same filename can be retried successfully', async () => {
  const { c, uploads } = harness(), chosen = file(); let failed = true;
  c.readBase64 = async () => { if (failed) throw new Error('Не удалось прочитать файл'); return 'complete-original'; };
  await assert.rejects(c.uploadFiles([chosen], 'map-source', 'source', { noRender: true }), /прочитать/);
  assert.equal(uploads.length, 0); assert.equal(c.state.pendingUploads, 0);
  failed = false;
  await c.uploadFiles([chosen], 'map-source', 'source', { noRender: true });
  assert.equal(uploads.length, 1); assert.equal(uploads[0].file.name, chosen.name);
  assert.equal(uploads[0].data, 'complete-original'); assert.equal(c.state.pendingUploads, 0);
});

test('a captured read rejection is handled while an earlier queue job is still pending', async () => {
  const { c, uploads } = harness(), gate = deferred(); c.tail = gate.promise;
  c.readBase64 = async () => { throw new Error('Не удалось прочитать файл'); };
  const delivery = c.uploadFiles([file()], 'map-source', 'source', { noRender: true });
  const failed = assert.rejects(delivery, /прочитать/);
  await settle(); assert.equal(uploads.length, 0);
  gate.resolve(); await failed;
  assert.equal(c.state.pendingUploads, 0);
});

test('one failed selection does not clear the pending counter of another captured selection', async () => {
  const { c, uploads } = harness(), firstRead = deferred(), nextRead = deferred();
  c.readBase64 = chosen => chosen.name === 'first.jpg' ? firstRead.promise : nextRead.promise;
  const first = c.uploadFiles([file('first.jpg')], 'map-source', 'source', { noRender: true });
  const second = c.uploadFiles([file('second.jpg')], 'map-source', 'source', { noRender: true });
  const firstFailed = assert.rejects(first, /прочитать/);
  assert.equal(c.state.pendingUploads, 2);
  firstRead.reject(new Error('Не удалось прочитать файл')); await firstFailed;
  assert.equal(c.state.pendingUploads, 1, 'Submission must remain blocked while another file is still being read');
  assert.equal(uploads.length, 0);
  nextRead.resolve('second-original'); await second;
  assert.equal(c.state.pendingUploads, 0); assert.equal(uploads.length, 1);
  assert.equal(uploads[0].file.name, 'second.jpg');
});

for (const fail of [false, true]) test('file input is retained until upload ' + (fail ? 'failure' : 'success') + ' and then permits selecting the same file again', async () => {
  const { c, notices } = harness(), gate = deferred(); let calls = 0;
  const control = { files: [file()], value: 'C:\\fakepath\\1000168435.jpg', dataset: { uploadRole: 'map-source', uploadSubject: 'source' } };
  const scope = { querySelectorAll: query => query === '[data-upload-role]' ? [control] : [], querySelector: () => null };
  c.uploadFiles = async chosen => { calls++; assert.equal(chosen[0].name, '1000168435.jpg'); await gate.promise; if (fail) throw new Error('Не удалось прочитать файл'); };
  load(c, 'bind'); c.bind(scope); control.onchange();
  assert.equal(control.value, 'C:\\fakepath\\1000168435.jpg', 'Resetting the picker before reading can revoke provider access');
  gate.resolve(); await settle();
  assert.equal(control.value, ''); assert.equal(notices.length, fail ? 1 : 0);
  control.value = 'C:\\fakepath\\1000168435.jpg'; control.onchange(); await settle();
  assert.equal(calls, 2); assert.equal(control.value, '');
});
