'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const path = require('node:path');
const { Readable } = require('node:stream');
const { PGlite } = require('@electric-sql/pglite');
const { devices } = require('playwright');

const root = path.resolve(__dirname, '../..');
const GROUP = '-1001000000001';
const AUDITOR = 1001;
const LAWYER = 3001;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function databasePool(db, { master = false } = {}) {
  const advisory = new Map();
  let tail = Promise.resolve();
  async function lease() { const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous; return release; }
  async function execute(sql, values) {
    if (!values && !sql.startsWith('SELECT')) return db.exec(sql);
    const result = await db.query(sql, values); return { ...result, rowCount: result.affectedRows == null ? result.rows.length : result.affectedRows };
  }
  const pool = {
    async query(sql, values) { const release = await lease(); try { return await execute(sql, values); } finally { release(); } },
    async connect() {
      let release; const owner = Symbol('session');
      return { async query(sql, values) {
        if (master && /pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)/.test(sql)) {
          if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 0 };
          const key = sql.match(/\((\d+),/)[1] + ':' + JSON.stringify(values);
          if (/pg_advisory_unlock/.test(sql)) { if (advisory.get(key) === owner) advisory.delete(key); return { rows: [{ unlocked: true }] }; }
          const locked = !advisory.has(key) || advisory.get(key) === owner; if (locked) advisory.set(key, owner); return { rows: [{ locked }] };
        }
        if (sql === 'BEGIN' && !release) release = await lease();
        try { return await (release ? execute(sql, values) : pool.query(sql, values)); }
        finally { if (release && /^(COMMIT|ROLLBACK)$/.test(sql)) { release(); release = null; } }
      }, release() { if (release) { release(); release = null; } for (const [key, value] of advisory) if (value === owner) advisory.delete(key); } };
    },
  };
  return pool;
}

async function createService({ master = false } = {}) {
  const db = new PGlite(), pool = databasePool(db, { master }), objects = new Map(), messages = [], originals = new Map(), egrnRequests = [], timers = [];
  const env = { BOT_TOKEN: 'synthetic-e2e-token', GROUP_CHAT_ID: GROUP, WEBAPP_URL: 'https://example.invalid', DATABASE_URL: 'postgres://example.invalid/e2e' };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const caches = new Map();
  function replace(name, exports) { const file = require.resolve(path.join(root, name)); caches.set(file, require.cache[file]); require.cache[file] = { id: file, filename: file, loaded: true, exports }; }
  let nextMessage = 500;
  const telegram = { getMe: async () => ({ id: 9999, username: 'synthetic_e2e_bot' }) };
  async function binary(file) {
    const value = file?.source; if (value == null) return null;
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    const chunks = []; for await (const chunk of value) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
  }
  function recorded(chat, payload) { const item = { ...payload, chat: String(chat), message_id: ++nextMessage }; originals.set(item.chat + ':' + item.message_id, item); return item; }
  for (const method of ['sendMessage', 'sendPhoto', 'sendMediaGroup', 'sendDocument', 'editMessageText', 'editMessageReplyMarkup']) {
    telegram[method] = async (...args) => {
      assert.ok(String(args[0]) === GROUP || master && String(args[0]) === String(LAWYER));
      const event = { method, args }; messages.push(event);
      if (!master) return method === 'sendMediaGroup' ? args[1].map(() => ({ message_id: ++nextMessage })) : { message_id: ++nextMessage };
      if (method === 'sendMediaGroup') { event.items = []; for (const item of args[1]) event.items.push(recorded(args[0], { kind: item.type, bytes: await binary(item.media), caption: item.caption })); return event.items; }
      const item = recorded(args[0], { kind: method, text: method === 'sendMessage' ? args[1] : undefined, bytes: ['sendDocument','sendPhoto'].includes(method) ? await binary(args[1]) : null, filename: args[1]?.filename });
      event.item = item; return item;
    };
  }
  if (master) telegram.callApi = async (method, payload) => {
    assert.equal(String(payload.chat_id), String(LAWYER)); assert.ok(['copyMessage','copyMessages'].includes(method));
    const ids = method === 'copyMessages' ? payload.message_ids : [payload.message_id], items = ids.map(id => {
      const source = originals.get(String(payload.from_chat_id) + ':' + id); assert.ok(source, 'Telegram copies must reference a recorded source message');
      return recorded(payload.chat_id, { ...source, copied_from: { chat: String(payload.from_chat_id), id } });
    });
    messages.push({ method, args: [payload], items }); return method === 'copyMessages' ? items : items[0];
  };
  const objectStore = {
    configured: () => true,
    async put(input) { const chunks = []; for await (const chunk of input.body) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); assert.equal(bytes.length, input.bytes); assert.equal(hash(bytes), input.sha256); objects.set(input.key, bytes); },
    async get(input) { assert.ok(objects.has(input.key)); return Readable.from([objects.get(input.key)]); },
    async remove(key) { objects.delete(key); },
  };
  replace('src/db/pool.js', pool); replace('src/bot/instance.js', { telegram });
  replace('src/bot/egrn-object-store.js', { createEgrnObjectStore: () => objectStore });
  replace('src/bot/egrn.js', { attachOrOrder: async input => { egrnRequests.push(input); throw new Error('E2E forbids EGRN requests'); } });
  const nativeFetch = global.fetch;
  global.fetch = function (url, options) { const target = new URL(String(url)); if (target.hostname !== '127.0.0.1') throw new Error('E2E forbids outbound HTTP'); return nativeFetch(url, options); };
  let server;
  try {
    await pool.query(`CREATE TABLE orders(id SERIAL PRIMARY KEY,created_at TIMESTAMPTZ DEFAULT NOW(),address TEXT,owner_name TEXT,object_type TEXT,object_name TEXT,has_video BOOLEAN,zones_info TEXT,deadline DATE,contacts TEXT,status TEXT,submitted_by BIGINT,submitted_name TEXT,telegram_msg_id BIGINT);
      CREATE TABLE logs(id SERIAL PRIMARY KEY,order_id INT,action TEXT,actor TEXT,details TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE web_sessions(sid VARCHAR PRIMARY KEY,sess JSON,expire TIMESTAMP(6));
      CREATE TABLE audits(id SERIAL PRIMARY KEY,order_id INT,text TEXT,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW(),report_data JSONB,draft_id UUID UNIQUE);`);
    for (const id of [58, 59, 60, 61, 62]) await pool.query(`INSERT INTO orders(id,address,owner_name,object_type,object_name,has_video,status,submitted_by,submitted_name,telegram_msg_id)
      VALUES($1,$2,'Synthetic client','Общепит алкоголь',$3,false,'in_progress',2001,'Synthetic manager',$1::int::bigint)`, [id, 'Москва, Тестовая улица, ' + id, 'Synthetic object ' + id]);
    await pool.query(require('../../src/web/order-materials').DDL); await pool.query("UPDATE orders SET service='Получение'");
    await pool.query(require('../../src/web/audit-drafts').DDL);
    const auth = require('../../src/web/auth'); await auth.ensureStaff();
    await pool.query("INSERT INTO staff(tg_id,name,role,approved) VALUES(1001,'Synthetic auditor','auditor',true),(2001,'Manager A','manager',true),(2002,'Manager B','manager',true)");
    if (master) await pool.query("INSERT INTO staff(tg_id,name,role,approved) VALUES($1,'Synthetic lawyer','lawyer',true)", [LAWYER]);
    const app = require('express')();
    const nativeInterval = global.setInterval, nativeTimeout = global.setTimeout;
    global.setInterval = (...args) => { const timer = nativeInterval(...args).unref(); timers.push(() => clearInterval(timer)); return timer; };
    global.setTimeout = (...args) => { const timer = nativeTimeout(...args).unref(); timers.push(() => clearTimeout(timer)); return timer; };
    try { require('../../src/web/index').setupWeb(app); } finally { global.setInterval = nativeInterval; global.setTimeout = nativeTimeout; }
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    return { origin, pool, objects, messages, originals, egrnRequests, keyQuery: auth.keyQuery,
      async draft(order) { return (await pool.query('SELECT * FROM audit_drafts WHERE order_id=$1 AND author_tg_id=$2 AND submitted_at IS NULL', [order, AUDITOR])).rows[0]; },
      async close() { timers.forEach(clear => clear()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); global.fetch = nativeFetch; for (const [key,value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } for (const [file,cached] of caches) { if (cached) require.cache[file] = cached; else delete require.cache[file]; } },
    };
  } catch (error) { timers.forEach(clear => clear()); if (server) server.close(); await db.close(); global.fetch = nativeFetch; throw error; }
}

async function openPage(browser, service, uid = AUDITOR, { pathname = '/audit?order_id=58', mobile = true } = {}) {
  const context = await browser.newContext(mobile ? devices['Pixel 7'] : { viewport: { width: 1280, height: 900 } });
  const errors = [], blocked = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('https://telegram.org/js/')) return route.fulfill({ contentType: 'application/javascript', body: "window.__e2eAlerts=[];window.Telegram={WebApp:{initData:'',platform:'android',initDataUnsafe:{},ready(){},expand(){},close(){},showAlert(message){window.__e2eAlerts.push(message)},enableClosingConfirmation(){},disableClosingConfirmation(){},HapticFeedback:{notificationOccurred(){}}}};" });
    if (url.startsWith(service.origin + '/') || /^(?:blob:|data:)/.test(url)) return route.continue();
    blocked.push(url); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.origin + pathname + (pathname.includes('?') ? '&' : '?') + service.keyQuery(uid), { waitUntil: 'domcontentloaded' });
  return { context, page, errors, blocked };
}

function multiPagePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 6 /Kids [3 0 R 5 0 R 7 0 R 9 0 R 11 0 R 13 0 R] >>'];
  for (let index = 0; index < 6; index++) { const content = (index === 3 ? '0 0.75 0' : '0.9 0 0') + ' rg\n0 0 400 300 re f\n'; objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources <<>> /Contents ' + (4 + index * 2) + ' 0 R >>', '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream'); }
  let result = '%PDF-1.4\n'; const offsets = ['0000000000 65535 f \n'];
  for (const [index,object] of objects.entries()) { offsets.push(String(Buffer.byteLength(result)).padStart(10,'0') + ' 00000 n \n'); result += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; }
  return Buffer.from(result + 'xref\n0 ' + offsets.length + '\n' + offsets.join('') + 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + Buffer.byteLength(result) + '\n%%EOF\n');
}
async function sampleImage(page, mime) { return Buffer.from(await page.evaluate(type => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#39a0bb'; ctx.fillRect(0,0,400,300); ctx.fillStyle = '#eea300'; ctx.fillRect(80,80,240,140); return canvas.toDataURL(type).split(',')[1]; }, mime), 'base64'); }
async function until(check, description, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(description); }

module.exports = { createService, openPage, multiPagePdf, sampleImage, until, hash, AUDITOR, LAWYER, GROUP };
