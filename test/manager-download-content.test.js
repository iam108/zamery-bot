const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/manager-form');

function fixture() {
  const h = harness({ virtualClock: true }), objects = [];
  let clicks = 0;
  h.c.URL = { createObjectURL(blob) { objects.push(blob); return 'blob:original'; }, revokeObjectURL() {} };
  h.c.document.body = { appendChild() {} };
  h.c.document.createElement = () => ({ click() { clicks++; }, remove() {} });
  return { h, objects, clicks: () => clicks, file: { url: '/api/audit/orders/58/materials/original', name: 'План.pdf' }, button: { textContent: 'Скачать план', disabled: false } };
}

for (const type of ['text/html; charset=utf-8', 'Application/XHTML+XML', 'application/json', 'application/problem+json']) {
  test('manager original download refuses an HTTP 200 service page: ' + type, async () => {
    const f = fixture(); let consumed = 0;
    f.h.c.respond = () => ({ ok: true, headers: { get: () => type }, blob: async () => { consumed++; return { type }; } });
    await f.h.c.downloadExistingFile(f.file, f.button);
    assert.equal(f.clicks(), 0, 'A service page must not be downloaded under the original PDF filename');
    assert.equal(f.objects.length, 0); assert.equal(consumed, 0);
    assert.equal(f.h.requests[0].options.signal.aborted, true, 'The unread service response must not keep downloading after rejection');
    assert.match(f.h.alerts.at(-1), /вместо.*файл|вместо.*документ/);
    assert.equal(f.button.disabled, false); assert.equal(f.button.textContent, 'Скачать план');
    assert.equal(f.h.timers.size, 0);

    const original = { type: 'application/pdf', size: 128 };
    f.h.c.respond = () => ({ ok: true, headers: { get: () => 'application/pdf' }, blob: async () => original });
    await f.h.c.downloadExistingFile(f.file, f.button);
    assert.equal(f.clicks(), 1); assert.deepEqual(f.objects, [original]);
    await f.h.tick(60000); assert.equal(f.h.timers.size, 0);
  });
}

test('manager original download also checks Blob MIME when response headers are absent', async () => {
  const f = fixture();
  f.h.c.respond = () => ({ ok: true, blob: async () => ({ type: 'text/html', size: 1000 }) });
  await f.h.c.downloadExistingFile(f.file, f.button);
  assert.equal(f.clicks(), 0); assert.equal(f.objects.length, 0);
  assert.equal(f.h.requests[0].options.signal.aborted, true);
  assert.match(f.h.alerts.at(-1), /вместо.*файл|вместо.*документ/);
  assert.equal(f.button.disabled, false); assert.equal(f.h.timers.size, 0);
});

for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'application/zip', 'application/octet-stream']) {
  test('manager original download preserves a valid attachment: ' + type, async () => {
    const f = fixture(), original = { type, size: 128 };
    f.h.c.respond = () => ({ ok: true, headers: { get: () => type }, blob: async () => original });
    await f.h.c.downloadExistingFile(f.file, f.button);
    assert.equal(f.clicks(), 1); assert.deepEqual(f.objects, [original]);
    assert.equal(f.h.alerts.length, 0); assert.equal(f.button.disabled, false);
    await f.h.tick(60000); assert.equal(f.h.timers.size, 0);
  });
}
