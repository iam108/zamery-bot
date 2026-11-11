'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const { createEgrnFileStore } = require('../src/bot/egrn-files');
const { createDownloadUrl, setupEgrnDownloads } = require('../src/web/egrn-downloads');

const MiB = 1024 * 1024, BYTES = 100 * MiB;
const ID = '00000000-0000-5000-8000-000000000011';
const SECRET = 'synthetic-old-seven-day-download-signing-secret';
const HOST = 'synthetic-legacy-files.storage.example.test';

function request(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url.pathname + url.search, headers: { host: url.host } }, res => {
      const hash = createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0);
      res.on('data', part => { hash.update(part); bytes += part.length; if (prefix.length < 5) prefix = Buffer.concat([prefix, part.subarray(0, 5 - prefix.length)]); });
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes, sha256: hash.digest('hex'), prefix }));
    });
    req.setTimeout(60000, () => req.destroy(new Error('Synthetic legacy download timed out')));
    req.on('error', reject);
  });
}
async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function close(server) { if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }

test('an old 100 MiB PostgreSQL original survives failed migrations and the same link then downloads directly without repeat copying', { timeout: 120000 }, async () => {
  let db, directory, provider, appServer;
  try {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'egrn-legacy-direct-'));
    const { PGlite } = require(process.env.PGLITE_TEST_MODULE || '@electric-sql/pglite'); db = new PGlite();
    let tail = Promise.resolve(), chunkReads = 0, uploadFailure = false;
    const recordQuery = (sql, params) => {
      if (/SELECT\s+content\s+FROM\s+egrn_file_chunks/i.test(sql)) chunkReads++;
      return params ? db.query(sql, params) : db.exec(sql);
    };
    const pool = {
      async connect() {
        const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await previous;
        let released = false;
        return { query: recordQuery, release() { if (!released) { released = true; unlock(); } } };
      },
      async query(sql, params) { const client = await pool.connect(); try { return await client.query(sql, params); } finally { client.release(); } }
    };
    const objects = new Map(), stats = { attempts: 0, completed: 0, signs: 0, removals: 0, gets: 0 };
    const objectStore = {
      configured() { return true; },
      async put(file) {
        stats.attempts++;
        if (uploadFailure) throw Object.assign(new Error('Synthetic storage unavailable'), { code: 'EGRN_OBJECT_WRITE' });
        const target = path.join(directory, createHash('sha256').update(file.key).digest('hex'));
        const hash = createHash('sha256'); let bytes = 0;
        async function* body() {
          for await (const part of file.body) { assert.ok(part.length <= MiB); bytes += part.length; hash.update(part); yield part; }
        }
        await pipeline(Readable.from(body()), fs.createWriteStream(target, { flags: 'wx' }));
        assert.equal(bytes, file.bytes); assert.equal(hash.digest('hex'), file.sha256);
        assert.equal((await fsp.stat(target)).size, file.bytes);
        objects.set(file.key, { path: target, bytes, sha256: file.sha256 }); stats.completed++;
      },
      async remove(key) {
        stats.removals++; objects.delete(key);
        await fsp.rm(path.join(directory, createHash('sha256').update(key).digest('hex')), { force: true });
      },
      async downloadUrl(file) {
        stats.signs++;
        const saved = objects.get(file.key); assert.ok(saved, 'Only a completely verified object can be signed');
        assert.equal(saved.bytes, file.bytes); assert.equal(saved.sha256, file.sha256);
        return 'https://' + HOST + '/' + file.key + '?signature=synthetic-only';
      },
      async get() { stats.gets++; assert.fail('The app must not proxy a migrated original'); }
    };
    const files = createEgrnFileStore(pool, { objectStore }); await files.ensure();
    const expected = createHash('sha256');
    const chunk = index => { const value = Buffer.alloc(MiB, (index * 19 + 5) % 251); if (!index) value.write('%PDF-1.7\n'); return value; };
    for (let i = 0; i < 100; i++) expected.update(chunk(i));
    const sha256 = expected.digest('hex');
    await pool.query("INSERT INTO egrn_files(id,egrn_order_id,source_key,name,mime,bytes,sha256,storage) VALUES($1,1,'legacy-synthetic','Старая выписка.pdf','application/pdf',$2,$3,'postgres')", [ID, BYTES, sha256]);
    for (let i = 0; i < 100; i++) await pool.query('INSERT INTO egrn_file_chunks(file_id,chunk_no,content) VALUES($1,$2,$3)', [ID, i, chunk(i)]);
    provider = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'https://' + req.headers.host), saved = objects.get(url.pathname.slice(1));
        if (req.headers.host !== HOST || url.searchParams.get('signature') !== 'synthetic-only' || !saved) { res.writeHead(403).end(); return; }
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': saved.bytes, 'content-disposition': 'attachment; filename="egrn.pdf"' });
        await pipeline(fs.createReadStream(saved.path), res);
      } catch (error) { res.destroy(error); }
    });
    const providerPort = await listen(provider), app = express();
    const now = () => Date.UTC(2026, 10, 11, 12);
    setupEgrnDownloads(app, { store: files, secret: SECRET, now }); appServer = http.createServer(app);
    const appPort = await listen(appServer), oldLink = new URL(createDownloadUrl(ID, { origin: 'https://old-bot.example.test', secret: SECRET, now }));
    const state = async () => (await pool.query('SELECT storage,object_key,sha256 FROM egrn_files WHERE id=$1', [ID])).rows[0];
    const storedChunks = async () => Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_file_chunks WHERE file_id=$1', [ID])).rows[0].count);

    // A same-size corrupt original must not change the authoritative location.
    await pool.query('UPDATE egrn_files SET sha256=$1 WHERE id=$2', ['0'.repeat(64), ID]);
    const corrupt = await request(appPort, oldLink); assert.equal(corrupt.status, 503); assert.equal(corrupt.headers.location, undefined);
    assert.equal((await state()).storage, 'postgres'); assert.equal((await state()).object_key, null); assert.equal(await storedChunks(), 100);
    assert.equal(stats.completed, 0); assert.equal(objects.size, 0);
    await pool.query('UPDATE egrn_files SET sha256=$1 WHERE id=$2', [sha256, ID]);

    uploadFailure = true;
    const failed = await request(appPort, oldLink); assert.equal(failed.status, 503); assert.equal(failed.headers.location, undefined);
    assert.equal((await state()).storage, 'postgres'); assert.equal(await storedChunks(), 100); assert.equal(stats.completed, 0);
    uploadFailure = false;

    // A legacy download may already be between chunks when the mapping moves.
    // It must finish from its original PostgreSQL source after the new direct
    // link has been published, without depending on a now-different row.
    const inFlight = files.chunks(ID)[Symbol.asyncIterator](), inFlightHash = createHash('sha256');
    let inFlightBytes = 0;
    const first = await inFlight.next(); assert.equal(first.done, false);
    inFlightHash.update(first.value); inFlightBytes += first.value.length;
    const migrated = await request(appPort, oldLink);
    assert.equal(migrated.status, 302); assert.equal(migrated.bytes, 0); assert.equal(migrated.headers['cache-control'], 'private, no-store');
    const after = await state(); assert.equal(after.storage, 's3'); assert.equal(after.sha256, sha256); assert.ok(after.object_key);
    assert.equal(await storedChunks(), 100, 'Keep legacy chunks so downloads already in progress cannot lose their source');
    const direct = await request(providerPort, new URL(migrated.headers.location));
    assert.equal(direct.status, 200); assert.equal(direct.bytes, BYTES); assert.equal(direct.sha256, sha256); assert.equal(direct.prefix.toString(), '%PDF-');
    for (let next = await inFlight.next(); !next.done; next = await inFlight.next()) { inFlightHash.update(next.value); inFlightBytes += next.value.length; }
    assert.equal(inFlightBytes, BYTES); assert.equal(inFlightHash.digest('hex'), sha256);
    const reads = chunkReads, attempts = stats.attempts;
    const again = await request(appPort, oldLink); assert.equal(again.status, 302); assert.equal(again.headers.location, migrated.headers.location);
    assert.equal(chunkReads, reads, 'A repeated old link must not read PostgreSQL file chunks again');
    assert.equal(stats.attempts, attempts); assert.equal(stats.completed, 1); assert.equal(stats.gets, 0);
    assert.equal(objects.size, 1); assert.ok(stats.removals >= 1);
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_files', [])).rows[0].count), 1);
  } finally {
    await close(appServer); await close(provider); await db?.close();
    if (directory) await fsp.rm(directory, { recursive: true, force: true });
  }
});
