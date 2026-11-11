'use strict';

const { test } = require('node:test');
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
const { readStatusResponse } = require('../src/bot/egrn-source');
const { createEgrnFileStore } = require('../src/bot/egrn-files');
const { createLargeDelivery } = require('../src/bot/egrn-large-delivery');
const { createDownloadUrl, setupEgrnDownloads } = require('../src/web/egrn-downloads');

const MiB = 1024 * 1024;
const BYTES = 300 * MiB;
const SECRET = 'synthetic-private-s3-end-to-end-signing-key';

function postgresPool(db, sqlLog) {
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const previous = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await previous;
      let released = false;
      return {
        query(sql, params) {
          // A 500 MiB database cannot hold this original plus PostgreSQL WAL.
          // The S3 path must never even attempt a BYTEA/chunk write.
          assert.doesNotMatch(sql, /^INSERT INTO egrn_file_chunks\b/i);
          assert.ok(!(params || []).some(value => Buffer.isBuffer(value) || value instanceof Uint8Array), 'Binary file data must never enter PostgreSQL');
          sqlLog.push(sql);
          return params ? db.query(sql, params) : db.exec(sql);
        },
        release() { if (!released) { released = true; unlock(); } }
      };
    },
    async query(sql, params) { const client = await pool.connect(); try { return await client.query(sql, params); } finally { client.release(); } }
  };
  return pool;
}

// This fake is an independent private storage service. It persists both bytes
// and object metadata on disk, so recreating a client retains no JS file cache.
function filesystemS3(directory, stats) {
  const files = key => {
    assert.match(key, /^egrn-originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    const base = path.join(directory, createHash('sha256').update(key).digest('hex'));
    return { body: base + '.bin', metadata: base + '.json' };
  };
  return {
    configured() { return true; },
    async put(file) {
      stats.puts++; const target = files(file.key), hash = createHash('sha256'); let bytes = 0;
      async function* measured() {
        for await (const chunk of file.body) {
          assert.ok(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array); assert.ok(chunk.byteLength <= MiB);
          bytes += chunk.byteLength; hash.update(chunk); stats.maxWriteChunk = Math.max(stats.maxWriteChunk, chunk.byteLength); yield chunk;
        }
      }
      await pipeline(Readable.from(measured(), { objectMode: false }), fs.createWriteStream(target.body, { flags: 'wx', mode: 0o600 }));
      const sha256 = hash.digest('hex'); assert.equal(bytes, file.bytes); assert.equal(sha256, file.sha256);
      await fsp.writeFile(target.metadata, JSON.stringify({ key: file.key, bytes, sha256, mime: file.mime }), { mode: 0o600 });
      stats.storedBytes += bytes;
    },
    async get(file) {
      stats.gets++; const target = files(file.key), saved = JSON.parse(await fsp.readFile(target.metadata, 'utf8'));
      assert.equal(saved.key, file.key); assert.equal(saved.bytes, file.bytes); assert.equal(saved.sha256, file.sha256);
      assert.equal((await fsp.stat(target.body)).size, file.bytes);
      return fs.createReadStream(target.body, { highWaterMark: MiB });
    },
    async downloadUrl(file) {
      const target = files(file.key), saved = JSON.parse(await fsp.readFile(target.metadata, 'utf8'));
      assert.equal(saved.bytes, file.bytes); assert.equal(saved.sha256, file.sha256);
      return 'https://synthetic-storage.example/files/' + path.basename(target.body);
    },
    async remove(key) { stats.removals++; const target = files(key); await Promise.all([fsp.rm(target.body, { force: true }), fsp.rm(target.metadata, { force: true })]); }
  };
}

async function* providerResponse(idReq, generated) {
  const decoy = Buffer.from('%PDF-1.7\nA different request must never be delivered.\n');
  yield Buffer.from('{"other":{"id_req":9,"file":"' + decoy.toString('base64') + '"},"selected":{"status":[{"file":"');
  const hash = createHash('sha256'), width = 48 * 1024;
  for (let offset = 0, index = 0; offset < BYTES; offset += width, index++) {
    const chunk = Buffer.alloc(width, (index * 29 + 17) % 251); if (!index) chunk.write('%PDF-1.7\n'); chunk.writeUInt32LE(index, 64);
    hash.update(chunk); generated.bytes += chunk.length;
    const encoded = Buffer.from(chunk.toString('base64')); assert.equal(encoded.length, 64 * 1024); yield encoded;
  }
  generated.sha256 = hash.digest('hex');
  // The id follows the large string: selecting a request cannot depend on key order.
  yield Buffer.from('"}],"id_req":' + JSON.stringify(idReq) + '}}');
}

function download(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: url.pathname + url.search, method }, response => {
      const hash = createHash('sha256'); let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
      response.on('error', reject); response.on('aborted', () => reject(new Error('The synthetic local download was interrupted')));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes, sha256: hash.digest('hex') }));
    });
    request.setTimeout(120000, () => request.destroy(new Error('The synthetic local download timed out')));
    request.on('error', reject); request.end();
  });
}

test('300 MiB provider JSON reaches private object storage, metadata-only PostgreSQL and three recipients before an exact signed HTTP download',
  { skip: !process.env.PGLITE_TEST_MODULE, timeout: 240000 }, async () => {
    let server, storageServer, db, directory, bundle;
    try {
      // Test local listening before generating or writing the large fixture.
      const app = express(); server = http.createServer(app);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
      db = new PGlite(); const sqlLog = [], pool = postgresPool(db, sqlLog);
      directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'zamery-private-s3-e2e-'));
      const spool = path.join(directory, 'spool'), bucket = path.join(directory, 'private-bucket');
      await fsp.mkdir(spool, { mode: 0o700 }); await fsp.mkdir(bucket, { mode: 0o700 });
      storageServer = http.createServer((req, res) => {
        const name = req.url.slice('/files/'.length);
        if (!/^\/files\/[0-9a-f]{64}\.bin$/.test(req.url)) return res.writeHead(404).end();
        res.setHeader('Content-Length', String(BYTES));
        fs.createReadStream(path.join(bucket, name)).pipe(res);
      });
      await new Promise(resolve => storageServer.listen(0, '127.0.0.1', resolve));
      const stats = { puts: 0, gets: 0, removals: 0, storedBytes: 0, maxWriteChunk: 0 };
      const objects = filesystemS3(bucket, stats), store = createEgrnFileStore(pool, { objectStore: objects });
      const generated = { bytes: 0 }, order = { id: 901, id_req: 77001, cad_num: '77:01:0000000:901', label: 'Synthetic S3 fixture',
        chat_id: -100901, status_msg_id: 91, ordered_by: 5901, deliver: [{ chat: -100902, reply: 92 }] };
      await pool.query('CREATE TABLE egrn_orders(id BIGINT PRIMARY KEY,file_msgs JSONB NOT NULL DEFAULT \'[]\')');
      await pool.query('INSERT INTO egrn_orders(id) VALUES($1)', [order.id]);
      bundle = await readStatusResponse(providerResponse(order.id_req, generated), { root: spool, idReq: order.id_req });
      const docs = await bundle.documents(order.cad_num); assert.equal(docs.length, 1);
      assert.equal(docs[0].bytes, BYTES); assert.equal(docs[0].sha256, generated.sha256); assert.equal(generated.bytes, BYTES);
      assert.equal(docs[0].buf, undefined);
      const messages = [], records = [], signing = { origin: 'https://files.example.test', secret: SECRET, now: () => Date.UTC(2026, 10, 1) };
      const delivery = createLargeDelivery({ store, makeUrl: id => createDownloadUrl(id, signing),
        telegram: {
          async sendDocument() { assert.fail('The large original must not be uploaded to Telegram'); },
          async sendMessage(chat, text, options) {
            const durable = (await pool.query('SELECT file_msgs FROM egrn_orders WHERE id=$1', [order.id])).rows[0].file_msgs;
            assert.equal(durable.length, 1); assert.equal(durable[0].kind, 'link');
            const stored = (await pool.query('SELECT storage,object_key FROM egrn_files WHERE id=$1', [durable[0].original_id])).rows[0];
            assert.equal(stored.storage, 's3'); assert.ok(stored.object_key);
            messages.push({ chat, text, options }); return { message_id: 9000 + messages.length };
          }
        },
        async persist(value, descriptors) {
          assert.equal(value.id, order.id);
          assert.doesNotMatch(JSON.stringify(descriptors), /https?:\/\/|sig=|base64|localPath|private-bucket|"buffer"|"open"/);
          await pool.query('UPDATE egrn_orders SET file_msgs=$1 WHERE id=$2', [JSON.stringify(descriptors), value.id]);
        }
      });
      await delivery.deliver(order, docs[0], 'embedded:0:' + docs[0].name, records);
      assert.equal(stats.puts, 1); assert.equal(stats.storedBytes, BYTES); assert.ok(stats.maxWriteChunk <= MiB);
      assert.deepEqual(messages.map(message => [message.chat, message.options.reply_parameters?.message_id]), [[order.chat_id, 91], [order.deliver[0].chat, 92], [order.ordered_by, undefined]]);
      assert.equal(records[0].deliveries.length, 3);
      const id = records[0].original_id, stored = (await pool.query('SELECT storage,object_key,bytes,sha256 FROM egrn_files WHERE id=$1', [id])).rows[0];
      assert.equal(stored.storage, 's3'); assert.equal(Number(stored.bytes), BYTES); assert.equal(stored.sha256, generated.sha256);
      assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_file_chunks', [])).rows[0].count), 0);
      assert.equal(sqlLog.filter(sql => /^INSERT INTO egrn_orders\b/i.test(sql)).length, 1);

      await bundle.cleanup(); bundle = null; await assert.doesNotReject(() => fsp.readdir(bucket)); assert.deepEqual(await fsp.readdir(spool), []);
      const fresh = createEgrnFileStore(pool, { objectStore: filesystemS3(bucket, stats) });
      setupEgrnDownloads(app, { store: fresh, secret: SECRET, now: signing.now });
      const url = new URL(messages[0].options.reply_markup.inline_keyboard[0][0].url), port = server.address().port;
      assert.equal(url.pathname, '/egrn-files/' + id + '/download'); assert.equal(url.href.includes(SECRET), false);
      const beforeHead = stats.gets, head = await download(port, url, 'HEAD');
      assert.equal(head.status, 200); assert.equal(head.bytes, 0); assert.equal(head.headers['content-length'], String(BYTES)); assert.equal(stats.gets, beforeHead);
      const redirect = await download(port, url);
      assert.equal(redirect.status, 302); assert.equal(redirect.bytes, 0);
      assert.equal(redirect.headers['cache-control'], 'private, no-store');
      const received = await download(storageServer.address().port, new URL(redirect.headers.location));
      assert.equal(received.status, 200); assert.equal(received.bytes, BYTES); assert.equal(received.sha256, generated.sha256);
      assert.equal(stats.gets, beforeHead, 'The bot must not GET original bytes for a direct download');

      // A wrong expected checksum cannot become a second durable object or a
      // notification; its partial attempt belongs only to the failed save.
      const bad = Buffer.from('%PDF-1.7\nincorrect expected checksum');
      await assert.rejects(fresh.saveStream({ egrn_order_id: order.id, source_key: 'wrong-checksum', name: 'bad.pdf', bytes: bad.length, sha256: '0'.repeat(64), open: async function* () { yield bad; } }), error => error.code === 'EGRN_FILE_CHANGED');
      assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_files', [])).rows[0].count), 1);
      assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM egrn_file_chunks', [])).rows[0].count), 0);
      assert.equal((await fsp.readdir(bucket)).filter(name => name.endsWith('.bin')).length, 1); assert.equal(stats.removals, 1); assert.equal(messages.length, 3);
      await delivery.retry(order, records[0], records); assert.equal(messages.length, 3); assert.equal(stats.puts, 2);
    } finally {
      await bundle?.cleanup();
      if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
      if (storageServer) await new Promise(resolve => { storageServer.closeAllConnections(); storageServer.close(resolve); });
      if (db) await db.close();
      if (directory) await fsp.rm(directory, { recursive: true, force: true });
    }
  });
