'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPdf, pdfOperation, releasePdf } = require('../src/web/audit-plan-editor').helpers;
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a stalled PDF module import has a bounded result and cannot open a late document', { timeout: 1000 }, async () => {
  let finish, opens = 0;
  const pending = loadPdf(new Uint8Array(), { timeoutMs: 10, loadLibrary: () => new Promise(resolve => { finish = resolve; }) });
  await assert.rejects(pending, { code: 'AUDIT_PDF_TIMEOUT' });
  finish({ getDocument() { opens++; } }); await settle(); assert.equal(opens, 0);
});

test('a stalled PDF worker rejects without awaiting stuck cleanup and destroys a late document', { timeout: 1000 }, async () => {
  let finish, destroyed = 0, lateDestroyed = 0;
  const task = { promise: new Promise(resolve => { finish = resolve; }), destroy() { destroyed++; return new Promise(() => {}); } };
  await assert.rejects(loadPdf(new Uint8Array(), { timeoutMs: 10, loadLibrary: async () => ({ getDocument: () => task }) }), { code: 'AUDIT_PDF_TIMEOUT' });
  assert.equal(destroyed, 1);
  finish({ numPages: 6, destroy() { lateDestroyed++; return new Promise(() => {}); } }); await settle();
  assert.equal(lateDestroyed, 1); assert.equal(destroyed, 1);
});

test('cancelling PDF validation releases its worker before a late original can succeed', { timeout: 1000 }, async () => {
  const controller = new AbortController(); let finish, destroyed = 0;
  const task = { promise: new Promise(resolve => { finish = resolve; }), destroy() { destroyed++; } };
  const pending = loadPdf(new Uint8Array(), { signal: controller.signal, loadLibrary: async () => ({ getDocument: () => task }) });
  await settle(); controller.abort(); await assert.rejects(pending, { code: 'AUDIT_PDF_CANCELLED' }); assert.equal(destroyed, 1);
  finish({ numPages: 6, destroy() {} }); await settle(); assert.equal(destroyed, 1);
});

test('an already cancelled PDF operation performs no import or worker work', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadPdf(new Uint8Array(), { signal: controller.signal, loadLibrary() { assert.fail('Cancelled import'); } }), { code: 'AUDIT_PDF_CANCELLED' });
});

test('valid six-page PDFs remain reusable while missing pages reject and release their worker', async () => {
  let destroyed = 0;
  const task = { promise: Promise.resolve({ numPages: 6 }), destroy() { destroyed++; return new Promise(() => {}); } };
  const loaded = await loadPdf(new Uint8Array(), { loadLibrary: async () => ({ getDocument: () => task }) });
  assert.equal(loaded.pdf.numPages, 6); assert.equal(destroyed, 0); releasePdf(loaded); releasePdf(loaded); assert.equal(destroyed, 1);
  await assert.rejects(loadPdf(new Uint8Array(), { loadLibrary: async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }), destroy() { destroyed++; } }) }) }), /нет страниц/);
  assert.equal(destroyed, 2);
});

test('a stalled page or render operation cancels once and cannot acknowledge its late completion', { timeout: 1000 }, async () => {
  let finish, cancels = 0, outcome;
  const pending = pdfOperation(() => new Promise(resolve => { finish = resolve; }), { timeoutMs: 10, cancel() { cancels++; return new Promise(() => {}); } });
  pending.then(value => { outcome = value; }, error => { outcome = error; });
  await assert.rejects(pending, { code: 'AUDIT_PDF_TIMEOUT' }); const timeout = outcome;
  finish('late raster'); await settle(); assert.equal(outcome, timeout); assert.equal(cancels, 1);
});
