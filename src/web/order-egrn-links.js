'use strict';

// A request references the already saved large original. It never stores a
// second BYTEA/object copy, and fresh download links are issued on demand.
const { createHash } = require('node:crypto');
const MATERIAL_BYTES = 12 * 1024 * 1024;
const DDL = `
  CREATE TABLE IF NOT EXISTS order_egrn_links (
    order_id INT NOT NULL REFERENCES orders(id),
    original_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(order_id, original_id)
  );
  CREATE TABLE IF NOT EXISTS order_egrn_telegram_links (
    order_id INT NOT NULL REFERENCES orders(id),
    id UUID NOT NULL,
    egrn_order_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(order_id,id)
  );
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function failure(message, status = 400) { return Object.assign(new Error(message), { status }); }
function orderId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw failure('Некорректный номер заявки.');
  return id;
}
function originalId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure('Некорректный номер выписки.');
  return value.toLowerCase();
}
function telegramMessage(value) {
  const chat = String(value.chat_id ?? value.chat ?? ''), message = Number(value.message_id ?? value.id);
  return /^-100[1-9]\d+$/.test(chat) && Number.isSafeInteger(message) && message > 0
    ? 'https://t.me/c/' + chat.slice(4) + '/' + message : '';
}
function telegramReferenceId(record) {
  let hex = createHash('sha1').update('egrn-telegram-reference:v1\n' + record.chat + ':' + record.id).digest('hex').slice(0,32);
  hex = hex.slice(0,12) + '5' + hex.slice(13,16) + '8' + hex.slice(17);
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
function createOrderEgrnLinks(options = {}) {
  const pool = options.pool || require('../db/pool');
  const files = options.files || require('../bot/egrn-files');
  const makeUrl = options.makeUrl || (id => require('./egrn-downloads').createDownloadUrl(id));
  let ready;
  async function ensure() {
    if (options.readOnly) return;
    if (!ready) ready = pool.query(DDL).catch(error => { ready = null; throw error; });
    await ready;
  }
  function metadata(file, order) {
    return { id: file.id, name: file.name, mime: file.mime, bytes: Number(file.bytes), sha256: file.sha256,
      role: 'egrn', source: 'stored', url: '/api/audit/orders/' + order + '/egrn/' + file.id + '/link' };
  }
  return {
    ensure,
    async register(order, records) {
      const targets = [...new Set((order.deliver || []).map(value => Number(value?.order_id)).filter(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647))];
      if (!targets.length) return;
      const saved = (records || []).filter(record => record?.kind === 'link');
      const telegram = (records || []).filter(record => record && record.kind !== 'link' && Number(record.bytes) > MATERIAL_BYTES && telegramMessage(record));
      if (!saved.length && !telegram.length) return;
      await ensure();
      for (const record of saved) {
        const id = originalId(record.original_id), file = await files.get(id);
        if (!file || Number(file.egrn_order_id) !== Number(order.id)) throw failure('Оригинал выписки не относится к этому заказу.', 409);
        for (const target of targets) await pool.query('INSERT INTO order_egrn_links(order_id,original_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [target, id]);
      }
      // Medium files remain in Telegram. Retain only source-message metadata,
      // so the auditor can open the exact original without another stored copy.
      for (const record of telegram) {
        if (typeof record.name !== 'string' || !record.name || !['application/pdf','application/zip'].includes(record.mime) || !Number.isSafeInteger(Number(record.bytes))) throw failure('Не подтверждены сведения о выписке в Telegram.', 409);
        for (const target of targets) await pool.query(`INSERT INTO order_egrn_telegram_links(order_id,id,egrn_order_id,chat_id,message_id,name,mime,bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [target, telegramReferenceId(record), order.id, record.chat, record.id, record.name, record.mime, record.bytes]);
      }
    },
    async list(order) {
      order = orderId(order); await ensure(); if (!options.readOnly) await files.ensure();
      const result = await pool.query(`SELECT f.id,f.name,f.mime,f.bytes,f.sha256 FROM order_egrn_links link
        JOIN egrn_files f ON f.id=link.original_id WHERE link.order_id=$1 ORDER BY link.created_at,f.id`, [order]);
      const native = await pool.query('SELECT id,name,mime,bytes FROM order_egrn_telegram_links WHERE order_id=$1 ORDER BY created_at,id', [order]);
      return result.rows.map(file => metadata(file, order)).concat(native.rows.map(file => ({
        id: file.id, name: file.name, mime: file.mime, bytes: Number(file.bytes), role: 'egrn', source: 'telegram',
        url: '/api/audit/orders/' + order + '/egrn/' + file.id + '/link',
      })));
    },
    async link(order, original) {
      order = orderId(order); original = originalId(original); await ensure();
      const allowed = await pool.query('SELECT 1 FROM order_egrn_links WHERE order_id=$1 AND original_id=$2', [order, original]);
      if (!allowed.rows.length) {
        const native = (await pool.query('SELECT chat_id,message_id FROM order_egrn_telegram_links WHERE order_id=$1 AND id=$2', [order, original])).rows[0];
        const url = native && telegramMessage(native);
        if (!url) throw failure('Выписка не относится к этой заявке.', 404);
        return { ok: true, url };
      }
      const file = await files.get(original);
      if (!file) throw failure('Оригинал выписки больше недоступен.', 404);
      return { ok: true, url: await makeUrl(original) };
    },
  };
}
let singleton;
function store() { return singleton ||= createOrderEgrnLinks(); }
function setupOrderEgrnLinks(app, service = store()) {
  app.get('/api/audit/orders/:orderId/egrn/:originalId/link', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await service.link(req.params.orderId, req.params.originalId)); }
    catch (error) { return res.status(error.status || 503).json({ ok: false, error: error.status ? error.message : 'Не удалось открыть выписку. Повторите попытку позднее.' }); }
  });
}
module.exports = { DDL, createOrderEgrnLinks, setupOrderEgrnLinks,
  listOrderLinks: order => store().list(order), registerOrderLinks: (order, records) => store().register(order, records) };
