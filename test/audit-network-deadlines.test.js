const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/web/audit-wizard-client'), 'utf8');
function actualFunction(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  if (start < 0) return '';
  const rest = source.slice(start), next = rest.slice(1).search(/\n  (?:(?:async )?function |var )/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(fetch) {
  const timers = new Map(); let serial = 0;
  const c = vm.createContext({ fetch, AbortController, Response, console,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(['requestWithDeadline', 'request', 'fetchAuditFile'].map(actualFunction).join('\n'), c);
  return { c, timers, tick(ms) { for (const [id, timer] of [...timers]) if (timer.ms <= ms) { timers.delete(id); timer.fn(); } } };
}
for (const stalled of ['headers', 'JSON body']) test('a stalled ' + stalled + ' releases the draft save and reports a retryable deadline', async () => {
  let signal, outcome;
  const h = harness(async (_url, options) => {
    signal = options.signal;
    if (stalled === 'headers') return new Promise(() => {});
    return { ok: true, status: 200, text: () => new Promise(() => {}) };
  });
  h.c.request('/api/audit/drafts/current').then(value => { outcome = value; }, error => { outcome = error; });
  await settle(); h.tick(30000); await settle();
  assert.equal(outcome?.code, 'REQUEST_TIMEOUT');
  assert.equal(outcome.retryable, true);
  assert.equal(signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test('a stalled file body stops downloading and another attempt can read the same original', async () => {
  let first = true, signal, failed;
  const h = harness(async (_url, options) => {
    if (!first) return new Response('complete PDF', { headers: { 'Content-Type': 'application/pdf' } });
    first = false; signal = options.signal;
    return { ok: true, headers: new Headers({ 'Content-Type': 'application/pdf' }), blob: () => new Promise(() => {}) };
  });
  h.c.fetchAuditFile('/original', 'Не удалось скачать оригинал').catch(error => { failed = error; });
  await settle(); h.tick(180000); await settle();
  assert.equal(failed?.code, 'AUDIT_FILE_RESPONSE'); assert.match(failed.message, /долго не отвечает/);
  assert.equal(signal.aborted, true);
  const file = await h.c.fetchAuditFile('/original', 'Не удалось скачать оригинал');
  assert.equal(await file.blob.text(), 'complete PDF');
  assert.equal(h.timers.size, 0);
});

for (const operation of [{ url:'/api/audit/drafts/id/evidence', ms:90000 }, { url:'/api/audit', ms:120000 }])
  test('a large write has time to finish but a stalled ' + operation.url + ' eventually releases its queue', async () => {
    let outcome;
    const h = harness(async () => new Promise(() => {}));
    h.c.request(operation.url, { method:'POST', body:'same original intent' }).catch(error => { outcome = error; });
    await settle(); h.tick(30000); await settle(); assert.equal(outcome, undefined);
    h.tick(operation.ms); await settle(); assert.equal(outcome?.code, 'REQUEST_TIMEOUT');
    assert.equal(h.timers.size, 0);
  });

test('an acknowledgement arriving after a deadline cannot turn the failed operation into success', async () => {
  let release, outcome;
  const h = harness(async () => new Promise(resolve => { release = resolve; }));
  h.c.request('/api/audit/drafts/id', { method:'PUT',body:'frozen write' }).then(value => { outcome = value; }, error => { outcome = error; });
  await settle(); h.tick(30000); await settle();
  const timeout = outcome;
  release(new Response(JSON.stringify({ ok:true, revision:5 })));
  await settle(); assert.equal(outcome, timeout); assert.equal(outcome.code, 'REQUEST_TIMEOUT');
  h.c.fetch = async () => new Response(JSON.stringify({ ok:true, revision:5 }));
  assert.equal((await h.c.request('/api/audit/drafts/current')).revision, 5);
  assert.equal(h.timers.size, 0);
});

for (const failure of [
  { status:502, body:'<html>Upstream unavailable</html>', type:'text/html' },
  { status:429, body:JSON.stringify({ok:false,error:'Сервер занят'}), type:'application/json' },
  { status:503, body:JSON.stringify({ok:false,error:'Повторите позже'}), type:'application/json' },
]) test('temporary ' + failure.status + ' permits autosave to retry without discarding the write', async () => {
  const h = harness(async () => new Response(failure.body, { status:failure.status,headers:{'Content-Type':failure.type} }));
  await assert.rejects(h.c.request('/api/audit/drafts/id', { method:'PUT',body:'same intent' }), error => error.status===failure.status && error.retryable===true);
  assert.equal(h.timers.size, 0);
});
