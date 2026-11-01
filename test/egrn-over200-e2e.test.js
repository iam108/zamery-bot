'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { readStatusResponse } = require('../src/bot/egrn-source');
const { createEgrnFileStore } = require('../src/bot/egrn-files');
const { createLargeDelivery } = require('../src/bot/egrn-large-delivery');
const { createDownloadUrl, setupEgrnDownloads } = require('../src/web/egrn-downloads');

const MiB = 1024 * 1024;
const BYTES = 300 * MiB;
// Every encoded part ends on a base64 boundary; no complete original or
// provider JSON string is ever allocated by this fixture.
const SOURCE_CHUNK = 48 * 1024;
const SECRET = 'synthetic-over200-e2e-signing-secret';

function postgresPool(db, sqlLog) {
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const previous = tail; let unlock;
      tail = new Promise(resolve => { unlock = resolve; }); await previous;
      let released = false;
      return {
        query(sql, params) {
          sqlLog.push(sql); // Do not retain BYTEA parameters or signed links.
          return params ? db.query(sql, params) : db.exec(sql);
        },
        release() { if (!released) { released = true; unlock(); } }
      };
    },
    async query(sql, params) {
      const client = await pool.connect();
      try { return await client.query(sql, params); } finally { client.release(); }
    }
  };
  return pool;
}

async function* providerResponse(idReq, generated) {
  const decoy = Buffer.from('%PDF-1.7\nDifferent request, never deliver this.\n%%EOF');
  yield Buffer.from('{"requests":[{"id_req":"another-request","status":"ready","file":"' + decoy.toString('base64') +
    '"},{"id_req":' + JSON.stringify(idReq) + ',"status":"ready","file":"');
  const hash = createHash('sha256');
  for (let index = 0, offset = 0; offset < BYTES; index++, offset += SOURCE_CHUNK) {
    const content = Buffer.alloc(Math.min(SOURCE_CHUNK, BYTES - offset), (index * 17 + 23) % 251);
    content.writeUInt32LE(index, 64);
    if (!index) content.write('%PDF-1.7\n');
    if (offset + content.length === BYTES) content.write('\n%%EOF\n', content.length - 7);
    hash.update(content); generated.bytes += content.length; generated.chunks++;
    const encoded = Buffer.from(content.toString('base64'));
    generated.maxEncodedChunk = Math.max(generated.maxEncodedChunk, encoded.length);
    yield encoded;
  }
  generated.sha256 = hash.digest('hex');
  yield Buffer.from('"}]}');
}

function streamRequest(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: url.pathname + url.search, method }, response => {
      const hash = createHash('sha256'); let bytes = 0;
      response.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('The synthetic download was interrupted.')));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes, sha256: hash.digest('hex') }));
    });
    request.setTimeout(180000, () => request.destroy(new Error('The synthetic download timed out.')));
    request.on('error', reject); request.end();
  });
}

test('300 MiB streamed provider JSON selects its request, persists the original, notifies all targets and downloads exactly',
  { skip: !process.env.PGLITE_TEST_MODULE, timeout: 420000 }, async () => {
    let db, server, root, bundle;
    try {
      // Fail before generating hundreds of MiB when local listening is denied
      // by a test runner sandbox. The HTTP leg is a real streamed download.
      const app = express(); server = http.createServer(app);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
      db = new PGlite(); const sqlLog = [], pool = postgresPool(db, sqlLog);
      root = await fsp.mkdtemp(path.join(os.tmpdir(), 'zamery-over200-e2e-'));
      await fsp.writeFile(path.join(root, 'keep.txt'), 'Unrelated sibling must survive source cleanup.', { mode: 0o600 });
      const generated = { bytes: 0, chunks: 0, maxEncodedChunk: 0, sha256: null };
      const order = { id: 301, id_req: 'synthetic-300-mib-request', cad_num: '77:01:0000000:301', label: 'Synthetic test object',
        chat_id: -100301, status_msg_id: 31, ordered_by: 5301, deliver: [{ chat: -100302, reply: 32 }] };

      bundle = await readStatusResponse(providerResponse(order.id_req, generated), { root, idReq: order.id_req });
      assert.equal(bundle.item.id_req, order.id_req); assert.equal(bundle.item.status, 'ready'); assert.equal(bundle.hasFiles, true);
      assert.equal(generated.bytes, BYTES); assert.equal(generated.chunks, BYTES / SOURCE_CHUNK);
      assert.equal(generated.maxEncodedChunk, 64 * 1024);
      const workspaceNames = (await fsp.readdir(root)).filter(name => name !== 'keep.txt');
      assert.equal(workspaceNames.length, 1);
      const workspace = path.join(root, workspaceNames[0]);
      assert.equal((await fsp.stat(workspace)).mode & 0o777, 0o700);
      for (const name of await fsp.readdir(workspace)) assert.equal((await fsp.stat(path.join(workspace, name))).mode & 0o777, 0o600);
      const docs = await bundle.documents(order.cad_num);
      assert.equal(docs.length, 1, 'Do not deliver the file belonging to another id_req');
      const file = docs[0];
      assert.equal(file.kind, 'pdf'); assert.equal(file.bytes, BYTES); assert.equal(file.sha256, generated.sha256);
      assert.equal(file.buf, undefined); assert.equal(file.localPath, undefined);
      assert.doesNotMatch(JSON.stringify(bundle.item), /JVBER|localPath|zamery-egrn-source-/);
      let opened = 0; const open = file.open;
      file.open = () => { opened++; return open(); };

      await pool.query('CREATE TABLE egrn_orders(id BIGINT PRIMARY KEY,file_msgs JSONB NOT NULL DEFAULT \'[]\')');
      await pool.query('INSERT INTO egrn_orders(id) VALUES($1)', [order.id]);
      const store = createEgrnFileStore(pool), records = [], messages = [];
      let persistCount = 0, streamSaves = 0, documentUploads = 0;
      const saveStream = store.saveStream;
      store.save = async () => assert.fail('A streamed 300 MiB original must not use the Buffer API');
      store.saveStream = async input => {
        streamSaves++; assert.equal(input.buffer, undefined); assert.equal(input.bytes, BYTES);
        assert.equal(input.sha256, generated.sha256); assert.equal(typeof input.open, 'function');
        return saveStream(input);
      };
      const signing = { origin: 'https://bot.example.test', secret: SECRET, now: () => Date.UTC(2026, 10, 1, 10) };
      const delivery = createLargeDelivery({ store,
        makeUrl: id => createDownloadUrl(id, signing),
        telegram: {
          async sendDocument() { documentUploads++; assert.fail('Large originals must reach Telegram as links'); },
          async sendMessage(chat, text, options) {
            const durable = (await pool.query('SELECT file_msgs FROM egrn_orders WHERE id=$1', [order.id])).rows[0].file_msgs;
            assert.equal(durable.length, 1); assert.equal(durable[0].kind, 'link');
            const original = await store.get(durable[0].original_id);
            assert.equal(original.bytes, BYTES); assert.equal(original.sha256, generated.sha256);
            messages.push({ chat, text, options }); return { message_id: 3000 + messages.length };
          }
        },
        async persist(value, descriptors) {
          persistCount++; assert.equal(value.id, order.id);
          assert.doesNotMatch(JSON.stringify(descriptors), /https?:\/\/|sig=|base64|localPath|zamery-egrn-source-|"buffer"|"open"/);
          await pool.query('UPDATE egrn_orders SET file_msgs=$1 WHERE id=$2', [JSON.stringify(descriptors), value.id]);
        }
      });
      await delivery.deliver(order, file, 'embedded:0:' + file.name, records);
      assert.equal(streamSaves, 1); assert.equal(opened, 1); assert.equal(persistCount, 4);
      assert.equal(documentUploads, 0); assert.equal(messages.length, 3); assert.equal(records.length, 1);
      assert.deepEqual(messages.map(message => [message.chat, message.options.reply_parameters?.message_id]),
        [[order.chat_id, 31], [order.deliver[0].chat, 32], [order.ordered_by, undefined]]);
      assert.equal(records[0].deliveries.length, 3);
      const id = records[0].original_id;
      const metadata = await store.get(id);
      assert.equal(metadata.bytes, BYTES); assert.equal(metadata.sha256, generated.sha256);
      const totals = (await pool.query('SELECT COUNT(*) AS count,SUM(octet_length(content)) AS bytes FROM egrn_file_chunks WHERE file_id=$1', [id])).rows[0];
      assert.equal(Number(totals.count), 300); assert.equal(Number(totals.bytes), BYTES);
      for (const message of messages) {
        assert.match(message.text, /300 МБ/); assert.doesNotMatch(message.text, /another-request|private\/|zamery-egrn-source-/);
        const buttons = message.options.reply_markup.inline_keyboard;
        assert.equal(buttons[1][0].callback_data, 'egf:' + id);
        const url = new URL(buttons[0][0].url);
        assert.equal(url.origin, signing.origin); assert.equal(url.pathname, '/egrn-files/' + id + '/download');
        assert.deepEqual([...url.searchParams.keys()], ['exp', 'sig']); assert.equal(url.href.includes(SECRET), false);
      }

      // Remove the source before HTTP download: only the PostgreSQL original
      // can serve the bytes. An already delivered retry must remain metadata-only.
      await bundle.cleanup(); assert.deepEqual(await fsp.readdir(root), ['keep.txt']);
      assert.throws(() => open(), { code: 'EGRN_SOURCE_CLOSED' });
      await delivery.retry(order, records[0], records);
      assert.equal(messages.length, 3); assert.equal(opened, 1); assert.equal(streamSaves, 1);
      const freshStore = createEgrnFileStore(pool);
      setupEgrnDownloads(app, { store: freshStore, secret: SECRET, now: signing.now });
      const link = new URL(messages[0].options.reply_markup.inline_keyboard[0][0].url), port = server.address().port;
      const chunkReads = () => sqlLog.filter(sql => sql.startsWith('SELECT content FROM egrn_file_chunks')).length;
      const beforeHead = chunkReads(), head = await streamRequest(port, link, 'HEAD');
      assert.equal(head.status, 200); assert.equal(head.bytes, 0); assert.equal(head.headers['content-length'], String(BYTES));
      assert.equal(chunkReads(), beforeHead, 'HEAD must not read the original chunks');
      const downloaded = await streamRequest(port, link);
      assert.equal(downloaded.status, 200); assert.equal(downloaded.bytes, BYTES); assert.equal(downloaded.sha256, generated.sha256);
      assert.equal(downloaded.headers['content-length'], String(BYTES)); assert.equal(downloaded.headers['content-type'], 'application/pdf');
      assert.equal(downloaded.headers['cache-control'], 'private, no-store'); assert.match(downloaded.headers['content-disposition'], /^attachment;/);
      assert.equal(chunkReads() - beforeHead, 300);
      assert.equal((await pool.query('SELECT id FROM egrn_files', [])).rows.length, 1);
      assert.equal(sqlLog.filter(sql => /^INSERT INTO egrn_orders\b/i.test(sql)).length, 1, 'Only the synthetic seeded order exists');
    } finally {
      try {
        await bundle?.cleanup();
        if (root) assert.deepEqual(await fsp.readdir(root), ['keep.txt'], 'Source cleanup must remove only its private workspace');
      } finally {
        if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
        if (db) await db.close();
        if (root) await fsp.rm(root, { recursive: true, force: true });
      }
    }
  });
