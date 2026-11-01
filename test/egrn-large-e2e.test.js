const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const { createEgrnFileStore } = require('../src/bot/egrn-files');
const { createLargeDelivery } = require('../src/bot/egrn-large-delivery');
const { createDownloadUrl, setupEgrnDownloads } = require('../src/web/egrn-downloads');

const MiB = 1024 * 1024;
const BYTES = 100 * MiB;
const SECRET = 'synthetic-egrn-large-e2e-signing-secret-only';

function postgresPool(db, sqlLog) {
  // An isolated PGlite instance has one connection. Lease it exclusively for
  // transactions while retaining the same pool interface as node-postgres.
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const previous = tail; let unlock;
      tail = new Promise(resolve => { unlock = resolve; }); await previous;
      let released = false;
      return {
        query(sql, params) {
          sqlLog.push(sql); // Never retain large BYTEA parameters or signed URLs.
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
function realExtractor(pool, traffic) {
  const context = {
    module: { exports: {} }, Buffer, process: { env: {} }, console,
    require(name) {
      if (name === '../db/pool') return pool;
      if (name === './formatter') return require('../src/bot/formatter');
      throw new Error('Unexpected dependency while extracting an embedded PDF: ' + name);
    },
    fetch() { traffic.external++; throw new Error('External requests and paid EGRN orders are forbidden in this test.'); },
    setTimeout() { throw new Error('The extractor must not start a poller.'); },
    setInterval() { throw new Error('The extractor must not start a poller.'); }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/bot/egrn.js'), 'utf8'), context);
  return context.module.exports.extractDocs;
}
function streamRequest(port, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: url.pathname + url.search, method }, response => {
      const hash = createHash('sha256'); let bytes = 0;
      response.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('The local download was interrupted.')));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes, sha256: hash.digest('hex') }));
    });
    request.setTimeout(120000, () => request.destroy(new Error('The local download timed out.')));
    request.on('error', reject); request.end();
  });
}

test('100 MiB embedded EGRN PDF persists in PostgreSQL, reaches every recipient as a link and downloads exactly',
  { skip: !process.env.PGLITE_TEST_MODULE, timeout: 180000 }, async () => {
    const { PGlite } = require(process.env.PGLITE_TEST_MODULE);
    const db = new PGlite(), sqlLog = [], pool = postgresPool(db, sqlLog);
    const traffic = { external: 0, documentUploads: 0 }, messages = [], records = [];
    let server, now = Date.UTC(2026, 10, 1, 10), persistCount = 0;
    const signing = { origin: 'https://bot.example.test', secret: SECRET, now: () => now };
    const order = { id: 201, id_statement: 9001, cad_num: '77:01:0000000:1', label: 'Учебный объект',
      chat_id: -100101, status_msg_id: 11, ordered_by: 501, deliver: [{ chat: -100202, reply: 22 }] };
    try {
      await pool.query('CREATE TABLE egrn_orders(id BIGINT PRIMARY KEY,file_msgs JSONB NOT NULL DEFAULT \'[]\')');
      await pool.query('INSERT INTO egrn_orders(id) VALUES($1)', [order.id]);
      const seededOrders = sqlLog.filter(sql => /^INSERT INTO egrn_orders\b/i.test(sql)).length;

      let original = Buffer.allocUnsafe(BYTES);
      // Distinct chunks make a wrong chunk order observable without requiring
      // an additional incompressible 100 MiB copy inside the WASM database.
      for (let index = 0; index < 100; index++) {
        original.fill((index * 17 + 23) % 251, index * MiB, (index + 1) * MiB);
        original.writeUInt32LE(index, index * MiB + 64);
      }
      original.write('%PDF-1.7\n');
      const expectedSha256 = createHash('sha256').update(original).digest('hex');
      let providerResponse = { status: [{ file: original.toString('base64') }] };
      original = null;
      const extracted = realExtractor(pool, traffic)(providerResponse, order.cad_num);
      providerResponse = null;
      assert.equal(extracted.length, 1);
      assert.equal(extracted[0].kind, 'pdf');
      assert.equal(extracted[0].buf.length, BYTES);
      assert.equal(createHash('sha256').update(extracted[0].buf).digest('hex'), expectedSha256);

      const store = createEgrnFileStore(pool);
      const telegram = {
        async sendDocument() { traffic.documentUploads++; throw new Error('100 MiB originals must not be uploaded to Telegram.'); },
        async sendMessage(chat, text, options) {
          // The original and its descriptor must survive a restart even if
          // the process dies immediately after this first notification.
          const descriptor = (await pool.query('SELECT file_msgs FROM egrn_orders WHERE id=$1', [order.id])).rows[0].file_msgs;
          assert.equal(descriptor.length, 1);
          assert.equal(descriptor[0].kind, 'link');
          assert.ok(await store.get(descriptor[0].original_id));
          messages.push({ chat, text, options });
          return { message_id: 1000 + messages.length };
        }
      };
      const delivery = createLargeDelivery({ store, telegram,
        makeUrl: id => createDownloadUrl(id, signing),
        async persist(value, descriptors) {
          assert.equal(value.id, order.id); persistCount++;
          await pool.query('UPDATE egrn_orders SET file_msgs=$1 WHERE id=$2', [JSON.stringify(descriptors), value.id]);
        }
      });
      await delivery.deliver(order, extracted[0], 'embedded:0:' + extracted[0].name, records);
      extracted[0].buf = null;
      if (typeof global.gc === 'function') global.gc();
      assert.equal(persistCount, 4);
      assert.equal(messages.length, 3);
      assert.deepEqual(new Set(messages.map(message => message.chat)), new Set([order.chat_id, order.ordered_by, order.deliver[0].chat]));
      assert.equal(records.length, 1);
      assert.equal(records[0].deliveries.length, 3);
      const id = records[0].original_id;
      for (const message of messages) {
        assert.match(message.text, /100 МБ/);
        const buttons = message.options.reply_markup.inline_keyboard;
        const link = new URL(buttons[0][0].url);
        assert.equal(link.origin, signing.origin);
        assert.equal(link.pathname, '/egrn-files/' + id + '/download');
        assert.deepEqual([...link.searchParams.keys()], ['exp', 'sig']);
        assert.equal(link.href.includes(SECRET), false);
        assert.equal(buttons[1][0].callback_data, 'egf:' + id);
      }
      assert.equal(messages.find(message => message.chat === order.chat_id).options.reply_parameters.message_id, 11);
      assert.equal(messages.find(message => message.chat === order.deliver[0].chat).options.reply_parameters.message_id, 22);

      const stored = (await pool.query('SELECT id,egrn_order_id,source_key,name,mime,bytes,sha256 FROM egrn_files', [])).rows;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].id, id);
      assert.equal(Number(stored[0].bytes), BYTES);
      assert.equal(stored[0].sha256, expectedSha256);
      const totals = (await pool.query('SELECT COUNT(*) AS count,SUM(octet_length(content)) AS bytes FROM egrn_file_chunks WHERE file_id=$1', [id])).rows[0];
      assert.equal(Number(totals.count), 100);
      assert.equal(Number(totals.bytes), BYTES);
      const persisted = (await pool.query('SELECT file_msgs FROM egrn_orders WHERE id=$1', [order.id])).rows[0].file_msgs;
      for (const value of [stored, persisted]) {
        const serialized = JSON.stringify(value);
        assert.equal(serialized.includes('https://'), false);
        assert.equal(serialized.includes('sig='), false);
        assert.equal(serialized.includes(SECRET), false);
        assert.equal(serialized.includes('base64'), false);
      }

      // Recreate the store before downloading: there is no process-local file
      // buffer, filesystem fallback, or in-memory metadata fixture to rely on.
      const freshStore = createEgrnFileStore(pool);
      const app = express(); setupEgrnDownloads(app, { store: freshStore, secret: SECRET, now: () => now });
      server = http.createServer(app);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const port = server.address().port, firstLink = new URL(messages[0].options.reply_markup.inline_keyboard[0][0].url);
      const beforeHead = sqlLog.filter(sql => sql.startsWith('SELECT content FROM egrn_file_chunks')).length;
      const head = await streamRequest(port, firstLink, 'HEAD');
      assert.equal(head.status, 200); assert.equal(head.bytes, 0);
      assert.equal(head.headers['content-length'], String(BYTES));
      assert.equal(sqlLog.filter(sql => sql.startsWith('SELECT content FROM egrn_file_chunks')).length, beforeHead);
      const downloaded = await streamRequest(port, firstLink);
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.bytes, BYTES);
      assert.equal(downloaded.sha256, expectedSha256);
      assert.equal(downloaded.headers['content-length'], String(BYTES));
      assert.equal(downloaded.headers['content-type'], 'application/pdf');
      assert.equal(downloaded.headers['cache-control'], 'private, no-store');
      assert.match(downloaded.headers['content-disposition'], /^attachment;/);

      now += 8 * 86400 * 1000;
      assert.equal((await streamRequest(port, firstLink, 'HEAD')).status, 403);
      await delivery.copy(records[0], { chat: 777 });
      const refreshed = new URL(messages[3].options.reply_markup.inline_keyboard[0][0].url);
      assert.equal(refreshed.pathname, firstLink.pathname);
      assert.notEqual(refreshed.search, firstLink.search);
      assert.equal((await streamRequest(port, refreshed, 'HEAD')).status, 200);
      assert.equal((await pool.query('SELECT id FROM egrn_files', [])).rows.length, 1);
      assert.equal(sqlLog.filter(sql => /^INSERT INTO egrn_orders\b/i.test(sql)).length, seededOrders);
      assert.equal(traffic.external, 0);
      assert.equal(traffic.documentUploads, 0);
    } finally {
      if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
      await db.close();
    }
  });
