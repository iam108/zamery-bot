const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArchiveUrl, downloadArchive, setupOrderArchive } = require('../src/web/order-archive');

const URL = 'https://disk.360.yandex.ru/d/RPoUCOS6PFusPQ/%D0%9B/%D0%9B%D0%95%D0%9E%D0%9D';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const folderZip = Buffer.concat([...require('../src/web/order-materials').zipParts([{name:'Original.txt',buffer:Buffer.from('Original archive fixture')}])]);
function mockDownload({ metadata, href, body, finalResponse } = {}) {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return json(metadata || { type: 'dir', name: 'ЛЕОН' });
    if (calls.length === 2) return json({ href: href || 'https://downloader.disk.yandex.ru/disk/temporary' });
    return finalResponse || new Response(body || folderZip, { headers: { 'content-type': 'application/zip' } });
  } };
}

test('archive parser keeps the exact company path and rejects a whole shared archive', () => {
  assert.deepEqual(parseArchiveUrl(URL), { publicKey: 'https://disk.360.yandex.ru/d/RPoUCOS6PFusPQ', path: '/Л/ЛЕОН' });
  assert.throws(() => parseArchiveUrl('https://disk.360.yandex.ru/d/RPoUCOS6PFusPQ'), e => e.code === 'COMMON_ARCHIVE');
  assert.throws(() => parseArchiveUrl('https://disk.360.yandex.ru/d/RPoUCOS6PFusPQ/Л'), e => e.code === 'COMMON_ARCHIVE');
  for (const url of ['http://disk.yandex.ru/d/abcdefghi', 'https://disk.yandex.ru.evil.test/d/abcdefghi', 'https://user:pass@disk.yandex.ru/d/abcdefghi', 'https://127.0.0.1/d/abcdefghi']) assert.throws(() => parseArchiveUrl(url), e => e.code === 'INVALID_ARCHIVE');
});

test('company folder downloads as a genuine ZIP without passing credentials', async () => {
  const mock = mockDownload();
  const file = await downloadArchive(URL, mock);
  assert.equal(file.name, 'ЛЕОН.zip');
  assert.equal(file.mime, 'application/zip');
  assert.ok(file.buffer.equals(folderZip));
  for (const request of mock.calls.slice(0, 2)) {
    assert.equal(new global.URL(request.url).searchParams.get('path'), '/Л/ЛЕОН');
    assert.equal(request.options.headers.Authorization, undefined);
  }
});

test('single PDF preserves original bytes and file name', async () => {
  const original = Buffer.from('%PDF-1.7\noriginal bytes');
  const file = await downloadArchive('https://yadi.sk/i/abcdefghi', mockDownload({ metadata: { type: 'file', name: 'Акт.pdf', mime_type: 'application/pdf', size: original.length }, body: original, finalResponse: new Response(original, { headers: { 'content-type': 'application/pdf' } }) }));
  assert.equal(file.name, 'Акт.pdf');
  assert.ok(file.buffer.equals(original));
});

test('shortening a valid long archive filename preserves its PDF extension and original bytes',async()=>{
  const body=Buffer.from('%PDF-1.7\noriginal'),name='План помещения '.repeat(20)+'.pdf';
  const result=await downloadArchive('https://yadi.sk/i/abcdefghi',mockDownload({metadata:{type:'file',name,mime_type:'application/pdf',size:body.length},body}));
  assert.ok(Array.from(result.name).length<=160);assert.ok(result.name.endsWith('.pdf'));assert.ok(result.buffer.equals(body));
});

test('a truncated source file cannot be accepted merely because its PDF header is present',async()=>{
  const body=Buffer.from('%PDF-1.7\ntruncated');
  await assert.rejects(downloadArchive('https://yadi.sk/i/abcdefghi',mockDownload({metadata:{type:'file',name:'План.pdf',mime_type:'application/pdf',size:body.length+100},body})),e=>e.code==='ARCHIVE_INCOMPLETE');
});

test('a short HTTP response with a declared original size is rejected even without file metadata',async()=>{
  const response=new Response(folderZip,{headers:{'Content-Type':'application/zip','Content-Length':String(folderZip.length+100)}});
  await assert.rejects(downloadArchive(URL,mockDownload({finalResponse:response})),e=>e.code==='ARCHIVE_INCOMPLETE');
});

test('a folder ZIP without its complete directory is rejected even if its PK prefix is valid',async()=>{
  for(const body of [Buffer.from('504b0304140000000000','hex'),folderZip.subarray(0,folderZip.length-10)])
    await assert.rejects(downloadArchive(URL,mockDownload({body})),e=>e.code==='ARCHIVE_INCOMPLETE');
});

test('a source file must match its published checksums, not only its size and PDF header',async()=>{
  const {createHash}=require('node:crypto'),body=Buffer.from('%PDF-1.7\ncomplete original');
  const metadata={type:'file',name:'План.pdf',mime_type:'application/pdf',size:body.length,sha256:createHash('sha256').update(body).digest('hex'),md5:createHash('md5').update(body).digest('hex')};
  const complete=await downloadArchive('https://yadi.sk/i/abcdefghi',mockDownload({metadata,body}));assert.ok(complete.buffer.equals(body));
  for(const field of ['sha256','md5'])await assert.rejects(downloadArchive('https://yadi.sk/i/abcdefghi',mockDownload({metadata:{...metadata,[field]:'0'.repeat(field==='sha256'?64:32)},body})),e=>e.code==='ARCHIVE_INTEGRITY');
});

test('decoded HTTP content is checked against the original metadata rather than compressed transfer length',async()=>{
  const body=Buffer.from('%PDF-1.7\ncomplete original');
  for(const length of [10,body.length+100]){
    const response=new Response(body,{headers:{'Content-Type':'application/pdf','Content-Encoding':'gzip','Content-Length':String(length)}});
    const result=await downloadArchive('https://yadi.sk/i/abcdefghi',{...mockDownload({metadata:{type:'file',name:'План.pdf',mime_type:'application/pdf',size:body.length},finalResponse:response}),maxBytes:body.length});
    assert.ok(result.buffer.equals(body));
  }
});

test('provider download links and redirects cannot escape trusted HTTPS hosts', async () => {
  const direct = mockDownload({ href: 'http://127.0.0.1/private' });
  await assert.rejects(downloadArchive(URL, direct), e => e.code === 'UNTRUSTED_DOWNLOAD');
  assert.equal(direct.calls.length, 2);
  const redirect = mockDownload({ finalResponse: new Response(null, { status: 302, headers: { location: 'https://evil.test/secret' } }) });
  await assert.rejects(downloadArchive(URL, redirect), e => e.code === 'UNTRUSTED_DOWNLOAD');
  assert.equal(redirect.calls.length, 3);
});

test('oversized downloads and HTML errors never become a fake archive', async () => {
  await assert.rejects(downloadArchive(URL, { ...mockDownload({ metadata: { type: 'dir', name: 'Большой', size: 101 } }), maxBytes: 100 }), e => e.code === 'ARCHIVE_TOO_LARGE');
  await assert.rejects(downloadArchive(URL, { ...mockDownload({ body: Buffer.alloc(101) }), maxBytes: 100 }), e => e.code === 'ARCHIVE_TOO_LARGE');
  await assert.rejects(downloadArchive(URL, mockDownload({ finalResponse: new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }) })), e => e.code === 'ARCHIVE_UNAVAILABLE');
  await assert.rejects(downloadArchive(URL, mockDownload({ body: Buffer.from('not-a-zip') })), e => e.code === 'ARCHIVE_UNAVAILABLE');
});

test('route validates request, service and archived link before any provider request', async () => {
  let handler, requested = 0;
  const app = { get(path, fn) { assert.equal(path, '/api/audit/orders/:id/archive/download'); handler = fn; } };
  const state = { order: null };
  setupOrderArchive(app, { getOrder: async () => state.order, fetch: async () => { requested++; throw new Error('must not request'); } });
  async function call(id) {
    const result = { headers: {} };
    const res = { set(k, v) { result.headers[k] = v; return this; }, status(s) { result.status = s; return this; }, json(v) { result.body = v; } };
    await handler({ params: { id } }, res); return result;
  }
  assert.equal((await call('bad')).body.code, 'INVALID_ORDER');
  assert.equal((await call('58')).body.code, 'ORDER_NOT_FOUND');
  state.order = { service: 'Получение', archive_url: URL };
  assert.equal((await call('58')).body.code, 'NOT_RENEWAL');
  state.order = { service: 'Продление', archive_url: '' };
  assert.equal((await call('58')).body.code, 'ARCHIVE_MISSING');
  assert.equal(requested, 0);
});

test('route returns original archive bytes with a safe Unicode attachment name', async () => {
  let handler;
  const mock = mockDownload({ metadata: { type: 'dir', name: '../ЛЕОН\r\n' } });
  setupOrderArchive({ get(path, fn) { handler = fn; } }, { getOrder: async () => ({ service: 'Продление', archive_url: URL }), fetch: mock.fetch });
  const result = { headers: {} };
  const res = { set(k, v) { result.headers[k] = v; return this; }, type(mime) { result.mime = mime; return this; }, send(body) { result.body = body; }, status(code) { result.status = code; return this; }, json(body) { result.body = body; } };
  await handler({ params: { id: '58' } }, res);
  assert.equal(result.mime, 'application/zip');
  assert.ok(result.body.equals(folderZip));
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(/[\r\n]/.test(result.headers['Content-Disposition']), false);
  assert.ok(result.headers['Content-Disposition'].includes(encodeURIComponent('ЛЕОН.zip')));
});
