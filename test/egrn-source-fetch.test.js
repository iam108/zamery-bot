'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ replies = [], sourceError, statusError } = {}) {
  const requests = [], reads = [];
  const source = {
    async cleanupStale() {},
    async readStatusResponse(body, options) { reads.push({ body, options }); if (statusError) throw statusError; return { item: { id_req: options.idReq }, cleanup() {} }; },
    async readFileResponse(body, name) { reads.push({ body, name }); if (sourceError) throw sourceError; return { file: { name, bytes: 300 * 1024 * 1024, open() {} }, cleanup() {} }; }
  };
  const context = {
    module: { exports: {} }, Buffer, URL, AbortSignal, console,
    process: { env: { EGRN_API_URL: 'https://provider.example/status', EGRN_TOKEN: 'synthetic-test-token', EGRN_LOGIN: 'synthetic-login' } },
    require(name) {
      if (name === '../db/pool') return {};
      if (name === './formatter') return { esc: String };
      if (name === './egrn-source') return source;
      throw new Error('Unexpected dependency: ' + name);
    },
    async fetch(url, options) {
      assert.equal(options.method, undefined, 'A delivery retry must never place a paid POST order');
      requests.push({ url, options });
      const reply = replies.shift(); assert.ok(reply, 'Unexpected outbound request'); return reply;
    }
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '../src/bot/egrn.js'), 'utf8');
  vm.runInContext(code + '\nmodule.exports.testHooks={apiStatus,download};', context);
  return { ...context.module.exports.testHooks, requests, reads };
}
function response({ status = 200, headers = {} } = {}) {
  let cancelled = 0;
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers),
    body: { async cancel() { cancelled++; } }, get cancelled() { return cancelled; } };
}

test('status preparation failure cancels the unconsumed provider response without a second request', async () => {
  const reply = response(), expected = Object.assign(new Error('Synthetic temporary directory failure'), { code: 'ENOSPC' });
  const h = harness({ replies: [reply], statusError: expected });
  await assert.rejects(h.apiStatus(77), error => error === expected);
  assert.equal(reply.cancelled, 1); assert.equal(h.requests.length, 1); assert.equal(h.reads[0].options.idReq, 77);
});

test('file preparation failure cancels its unconsumed response body', async () => {
  const reply = response(), expected = new Error('Synthetic temporary directory failure');
  const h = harness({ replies: [reply], sourceError: expected });
  await assert.rejects(h.download('https://provider.example/file.pdf'), error => error === expected);
  assert.equal(reply.cancelled, 1); assert.equal(h.requests.length, 1);
});

test('a provider redirect does not forward its authorization headers to the file host', async () => {
  const redirect = response({ status: 302, headers: { location: 'https://files.example/original.pdf' } }), file = response();
  const h = harness({ replies: [redirect, file] });
  const downloaded = await h.download('https://provider.example/original.pdf');
  assert.equal(downloaded.bytes, 300 * 1024 * 1024); assert.equal(redirect.cancelled, 1);
  assert.equal(h.requests[0].options.headers['Authorization-Token'], 'synthetic-test-token');
  assert.equal(Object.keys(h.requests[1].options.headers).length, 0);
  assert.ok(h.requests.every(request => request.options.redirect === 'manual'));
});

test('external file hosts never receive provider authentication and malformed URL filenames use a safe fallback', async () => {
  const reply = response({ headers: { 'content-type': 'application/pdf' } }), h = harness({ replies: [reply] });
  const downloaded = await h.download('https://files.example/%invalid');
  assert.equal(h.reads[0].name, 'vypiska.pdf'); assert.equal(downloaded.name, 'vypiska.pdf');
  assert.equal(Object.keys(h.requests[0].options.headers).length, 0);
});

test('oversized headers and failed HTTP statuses cancel their bodies before processing', async () => {
  for (const reply of [response({ headers: { 'content-length': String(2 * 1024 ** 3) } }), response({ status: 503 })]) {
    const h = harness({ replies: [reply] });
    await assert.rejects(h.download('https://provider.example/original.pdf'));
    assert.equal(reply.cancelled, 1); assert.equal(h.reads.length, 0);
  }
});

test('insecure file links and redirects are rejected before an insecure request can be sent', async () => {
  const direct = harness(); await assert.rejects(direct.download('http://provider.example/file.pdf'));
  assert.equal(direct.requests.length, 0);
  const reply = response({ status: 302, headers: { location: 'http://files.example/file.pdf' } }), redirected = harness({ replies: [reply] });
  await assert.rejects(redirected.download('https://provider.example/file.pdf'));
  assert.equal(redirected.requests.length, 1); assert.equal(reply.cancelled, 1);
});
