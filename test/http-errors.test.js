const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { asyncHandler, errorHandler } = require('../src/web/http-errors');

test('asynchronous route failures reach a final safe error handler and leave the server available', async () => {
  const app = express();
  app.get('/late-route', asyncHandler(async () => { throw new Error('synthetic-private-database-detail'); }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const failed = await fetch(origin + '/late-route');
    assert.equal(failed.status, 500);
    const body = await failed.json(); assert.equal(body.ok, false);
    assert.doesNotMatch(body.error, /private|database-detail/);
    assert.equal((await (await fetch(origin + '/health')).json()).ok, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('oversized input returns 413 rather than a successful HTTP status', async () => {
  const app = express();
  app.use(express.json({ limit: '20b' }));
  app.post('/input', (_req, res) => res.json({ ok: true })); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await fetch('http://127.0.0.1:' + server.address().port + '/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(40) }) });
    assert.equal(result.status, 413); assert.equal((await result.json()).ok, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
