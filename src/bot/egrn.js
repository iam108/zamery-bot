// Заказ выписок ЕГРН через API armrus.org
// Переменные Railway: EGRN_TOKEN, EGRN_LOGIN, EGRN_PASSWORD, EGRN_DECLARANT_ID, EGRN_CHAT_ID
const pool = require('../db/pool');
const { esc } = require('./formatter');

const API = process.env.EGRN_API_URL || 'https://armrus.org/api_r/request_egrn/statement/v4';
const TYPES = {
  kvarmrusxmlpdf: { short: 'об объекте', icon: '📄' },
  etrparmrusxmlpdf: { short: 'о переходе прав', icon: '🔁' },
};
// Кадастровый номер: 77:17:0120316:38939 (квартал 6–7 цифр, номер 1–9 цифр)
const CAD_RE = /\b\d{2}:\d{2}:\d{6,7}:\d{1,9}\b/g;
const MAX_POLL_HOURS = 72;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_RECEIVED_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const MAX_DOCUMENT_FILES = 32; // Same bounded packet size as egrn-source MAX_FILES.
const MAX_FAILURES = 5;
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
let budgetService;
function budget() { return budgetService ||= require('./egrn-budget').createEgrnBudget({ pool }); }
let telegramDeliveryService;
function telegramDelivery() { return telegramDeliveryService ||= require('./egrn-telegram-delivery').createEgrnTelegramDelivery({ pool, env: process.env }); }
async function readBudgetText() {
  try { return budget().describe(await budget().snapshot()); }
  catch (_) { return 'Учёт заказов временно недоступен; остаток не сверён.'; }
}
function isMeasurementsChat(chat) { return !!process.env.GROUP_CHAT_ID && String(chat) === String(process.env.GROUP_CHAT_ID); }
function budgetSuffix(chat, text) { return !isMeasurementsChat(chat) && text ? '\n' + text : ''; }
async function messageBudgetText(chat) { return isMeasurementsChat(chat) ? '' : 'Учёт на момент сообщения: ' + await readBudgetText(); }
async function budgetText(order) {
  try {
    if (order?.id_statement) await budget().accept(order.id, order.id_statement);
    return await readBudgetText();
  } catch (_) { return 'Учёт заказов временно недоступен; остаток не сверён.'; }
}
function budgetCaption(text, accounting) {
  if (!accounting) return String(text).slice(0, 1000);
  const suffix = '\n' + accounting;
  return String(text).slice(0, Math.max(0, 1000 - suffix.length)).replace(/[\uD800-\uDBFF]$/, '') + suffix;
}
async function budgetResult(result, order) {
  const text = await budgetText(order);
  return { ...result, budget_text: text };
}

function checkDocumentSize(buf) {
  if (buf.length <= MAX_DOCUMENT_BYTES) return;
  const err = new Error('Файл слишком большой для Telegram: ' + buf.length + ' байт (лимит ' + MAX_DOCUMENT_BYTES + ')');
  err.code = 'EGRN_DOCUMENT_TOO_LARGE';
  throw err;
}

function documentTooLarge(err) {
  return !!err && (err.code === 'EGRN_DOCUMENT_TOO_LARGE' ||
    Number(err.response && err.response.error_code) === 413 ||
    Number(err.code) === 413 ||
    /^413\b/.test(String(err.message || '')));
}

async function registerOriginal(targets, file) {
  if (!(targets || []).some(t => t && t.order_id)) return;
  try { await require('./order-evidence').registerOriginal(targets, file); }
  catch (e) { console.error('egrn packet: original unavailable'); }
}

function largeDelivery(order) {
  return require('./egrn-large-delivery').createLargeDelivery({ telegram: tgApi,
    budgetText: messageBudgetText,
    sendOriginal: order ? (record, target, run) => telegramDelivery().send(order, { kind: 'large-link', key: record.key, target }, run) : undefined,
    persist: async function (order, records) {
      await persistFileRecords(order, records);
    }
  });
}

function hasReusableFiles(order) {
  const files = Array.isArray(order && order.file_msgs) ? order.file_msgs : [];
  const manifest = Array.isArray(order && order.delivery_manifest) ? order.delivery_manifest : [];
  return !!(order && order.status === 'done' && files.length &&
    (order.files_sent > 0 || manifest.length && manifest.every(key => files.some(file => sourceKey(file) === key))));
}

function lostLease() { return Object.assign(new Error('Обработка выписки уже продолжена другим процессом.'), { code: 'EGRN_LEASE_LOST' }); }
async function claimDelivery(id) {
  const result = await pool.query("UPDATE egrn_orders SET processing_token=gen_random_uuid(),processing_until=NOW()+INTERVAL '2 minutes' WHERE id=$1 AND status IN ('ordered','done') AND (processing_until IS NULL OR processing_until<=NOW()) RETURNING *", [id]);
  return result.rows[0] || null;
}
async function renewDelivery(order) {
  const result = await pool.query("UPDATE egrn_orders SET processing_until=NOW()+INTERVAL '2 minutes' WHERE id=$1 AND processing_token=$2 AND processing_until>NOW()", [order.id, order.processing_token]);
  if (result.rowCount === 0) throw lostLease();
}
function keepDeliveryAlive(order) {
  let pending = null, failure = null;
  const timer = setInterval(() => {
    if (!pending) pending = renewDelivery(order).catch(error => { failure = error; }).finally(() => { pending = null; });
  }, 30000);
  if (timer?.unref) timer.unref();
  return {
    assert() { if (failure) throw failure; },
    async close() {
      if (timer && typeof clearInterval === 'function') clearInterval(timer);
      if (pending) await pending;
      await pool.query('UPDATE egrn_orders SET processing_token=NULL,processing_until=NULL WHERE id=$1 AND processing_token=$2', [order.id, order.processing_token]);
    },
  };
}
async function persistFileRecords(order, records) {
  await telegramDelivery().persist(order, records);
  if ((order.deliver || []).some(target => target?.order_id) && records.some(file => file.kind==='link' || Number(file.bytes) > 12 * 1024 * 1024)) await require('../web/order-egrn-links').registerOrderLinks(order, records);
}

function nativeDeliveryTargets(order, record) {
  const values = [{ chat: order.chat_id }, ...(Array.isArray(order.deliver) ? order.deliver : [])];
  if (order.ordered_by) values.push({ chat: order.ordered_by });
  const unique = new Map();
  for (const value of values) {
    if (!value || !/^-?[1-9]\d*$/.test(String(value.chat || ''))) continue;
    if (record.document_kind === 'xml' && String(value.chat) !== String(record.chat)) continue;
    if (!unique.has(String(value.chat))) unique.set(String(value.chat), value);
  }
  return [...unique.values()];
}
async function nativePrimaryTarget(order) {
  for (const target of nativeDeliveryTargets(order, {})) {
    try { await telegramDelivery().authorize(order, target); return target; }
    catch (error) { if (error.code !== 'EGRN_RECIPIENT_UNAVAILABLE') throw error; }
  }
  throw Object.assign(new Error('Нет доступного получателя оригинала выписки. Проверьте доступ сотрудника и назначение; новый платный заказ не создавался.'), { code: 'EGRN_RECIPIENT_UNAVAILABLE', uncertain: false });
}
async function sendNativePrimary(order, file, key, extra) {
  const target = await nativePrimaryTarget(order), configured = { ...extra };
  if (String(target.chat) !== String(order.chat_id)) {
    delete configured.reply_parameters;
    if (target.reply) configured.reply_parameters = { message_id: Number(target.reply), allow_sending_without_reply: true };
  }
  // Provider reads, downloads and original registration may take minutes.
  // Read only the current counter after the protocol preflight, then retain
  // its final recipient and lease checks immediately before the transport.
  const message = await telegramDelivery().send(order, { kind: 'native-primary', key, target }, async recheck => {
    configured.caption=budgetCaption(configured.caption,await messageBudgetText(target.chat));
    if(recheck)await recheck();
    return tgApi.sendDocument(target.chat,{source:file.buf,filename:file.name},configured);
  });
  return { message, chat: target.chat };
}

async function deliverNativeRecord(order, record, records) {
  await renewDelivery(order);
  if (!Number.isSafeInteger(Number(record.id)) || Number(record.id) < 1 || !record.chat) throw new Error('Не найден оригинал выписки в Telegram.');
  const confirmed = {};
  const deliveries = Array.isArray(record.deliveries) ? record.deliveries : [];
  // Legacy native records already prove their delivery to the primary chat.
  confirmed[JSON.stringify([String(record.chat), record.key || String(record.chat) + ':' + String(record.id)])] = true;
  for (const receipt of deliveries) {
    if (receipt && receipt.id) confirmed[JSON.stringify([String(receipt.chat), record.key || String(record.chat) + ':' + String(record.id)])] = true;
  }
  let blocked;
  for (const target of nativeDeliveryTargets(order, record)) try { await copyFiles([record], [target], { strict: true, confirmed,
    budgetText: true,
    deliveryOrder: order,
    onSourceRepaired: () => persistFileRecords(order, records),
    async onCopied(key, message) {
      const chat = JSON.parse(key)[0];
      record.deliveries = deliveries;
      deliveries.push({ chat, id: Number(message.message_id) });
      await persistFileRecords(order, records);
    }
  }); } catch (error) {
    if (error.code === 'EGRN_RECIPIENT_UNAVAILABLE' || error.failure_code === 'EGRN_RECIPIENT_UNAVAILABLE') blocked ||= error;
    else throw error;
  }
  if (blocked) throw blocked;
}

async function markDelivered(order, records) {
  telegramDelivery().assertAvailable(order);
  if ((order.deliver || []).some(target => target?.order_id) && records.some(file => file.kind==='link' || Number(file.bytes)>12*1024*1024)) await require('../web/order-egrn-links').registerOrderLinks(order, records);
  // A new recipient registered while delivery was running keeps the row
  // pending, so the next round sends only their missing originals.
  await pool.query("UPDATE egrn_orders SET files_sent=$1,file_msgs=$2,error=$3,failures=0,retry_at=NULL,updated_at=NOW() WHERE id=$4 AND delivery_revision=$5 AND processing_token=$6 AND NOT (COALESCE(delivery_state,'{}'::jsonb) ? 'inflight')",
    [records.length, JSON.stringify(records), null, order.id, Number(order.delivery_revision || 0), order.processing_token]);
}

function sourceKey(record) { return record.key || String(record.chat) + ':' + String(record.id); }

async function resumeLargeDelivery(order) {
  const records = Array.isArray(order.file_msgs) ? order.file_msgs : [];
  const manifest = Array.isArray(order.delivery_manifest) ? order.delivery_manifest : [];
  if (order.status !== 'done' || !manifest.length || !manifest.every(key => records.some(file => sourceKey(file) === key))) return false;
  for (const record of records) {
    if (record.kind === 'link') await largeDelivery(order).retry(order, record, records);
    else await deliverNativeRecord(order, record, records);
  }
  await markDelivered(order, records);
  return true;
}

function documentRecord(message, chat, key, file) {
  const mime = message.document?.mime_type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : /\.zip$/i.test(file.name) ? 'application/zip' : 'application/octet-stream');
  const record = { chat: Number(chat), id: message.message_id, key, document_kind: file.kind || '', name: file.name, mime, bytes: file.buf.length, sha256: originalHash(file) };
  if (message.document?.file_id) record.file_id = message.document.file_id;
  return record;
}

function originalHash(file) {
  if (Buffer.isBuffer(file?.buf)) {
    const actual = require('node:crypto').createHash('sha256').update(file.buf).digest('hex');
    if (file.sha256 && file.sha256.toLowerCase() !== actual) throw Object.assign(new Error('Оригинал выписки изменился после получения.'), { code: 'EGRN_FILE_CHANGED' });
    return actual;
  }
  if (/^[a-f\d]{64}$/i.test(file?.sha256 || '')) return file.sha256.toLowerCase();
  throw Object.assign(new Error('Не удалось подтвердить содержимое оригинала выписки.'), { code: 'EGRN_FILE_IDENTITY' });
}
function recordHash(record) {
  if (/^[a-f\d]{64}$/i.test(record?.sha256 || '')) return record.sha256.toLowerCase();
  return /^sha256:([a-f\d]{64})$/.exec(record?.key || '')?.[1] || null;
}
function matchingOriginal(file, records) {
  const hash = originalHash(file), existing = records.find(record => recordHash(record) === hash);
  if (existing && Number(existing.bytes) !== documentBytes(file)) throw Object.assign(new Error('Размер ранее доставленного оригинала не совпадает.'), { code: 'EGRN_FILE_IDENTITY' });
  return { hash, existing, key: existing?.key || 'sha256:' + hash };
}
async function verifyPartialRecords(order, records) {
  let changed = false;
  for (const record of records) {
    if (recordHash(record)) continue;
    if (record.kind === 'link') {
      const file = await require('./egrn-files').get(record.original_id);
      if (file && Number(file.egrn_order_id) === Number(order.id) && file.name === record.name && file.mime === record.mime && Number(file.bytes) === Number(record.bytes) && /^[a-f\d]{64}$/i.test(file.sha256 || '')) {
        record.sha256 = file.sha256.toLowerCase(); changed = true; continue;
      }
    }
    throw Object.assign(new Error('Старый частичный комплект не содержит подтверждения содержимого оригиналов. Проверьте уже доставленные файлы вручную; новая платная выписка не заказывалась.'), { code: 'EGRN_LEGACY_FILE_IDENTITY' });
  }
  if (changed) await persistFileRecords(order, records);
}

const TYPE_DOC = 'kvarmrusxmlpdf'; // выписка об объекте
let tgApi = null; // bot.telegram — задаётся в setupEgrn, нужен и формам (заявка на замер, передача юристу)

let ready = null;
function ensureTables() {
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS egrn_orders (
        id            SERIAL PRIMARY KEY,
        cad_num       TEXT NOT NULL,
        label         TEXT,
        type_doc      TEXT NOT NULL,
        ordered_by    BIGINT,
        ordered_name  TEXT,
        id_statement  BIGINT,
        status        TEXT DEFAULT 'new',      -- new | ordered | done | failed
        status_text   TEXT,
        chat_id       BIGINT,
        status_msg_id BIGINT,
        files_sent    INT DEFAULT 0,
        polls         INT DEFAULT 0,
        error         TEXT,
        raw           JSONB,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS deliver JSONB DEFAULT '[]';
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS file_msgs JSONB DEFAULT '[]';
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS failures INT NOT NULL DEFAULT 0;
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ;
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS delivery_manifest JSONB NOT NULL DEFAULT '[]';
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS delivery_revision INT NOT NULL DEFAULT 0;
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS request_key TEXT;
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS processing_token UUID;
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS processing_until TIMESTAMPTZ;
      ALTER TABLE egrn_orders ADD COLUMN IF NOT EXISTS delivery_state JSONB NOT NULL DEFAULT '{}';
      CREATE UNIQUE INDEX IF NOT EXISTS egrn_orders_request_key ON egrn_orders(request_key) WHERE request_key IS NOT NULL;
      UPDATE egrn_orders SET status='order_unknown',status_text='Заказ требует проверки у поставщика',
        error='Не подтверждён результат первоначального заказа',updated_at=NOW()
        WHERE status='ordering' AND created_at < NOW() - INTERVAL '5 minutes';
      UPDATE egrn_orders SET files_sent=0, failures=0, retry_at=NULL, error='Повторная доставка крупной выписки', updated_at=NOW()
        WHERE files_sent=-1 AND status='done' AND created_at > NOW() - INTERVAL '30 days'
        AND (error LIKE '%Файл слишком большой для Telegram:%'
          OR error ~* '(^|;[[:space:]]*)413([:[:space:]]|$)'
          OR error ~* '(^|;[[:space:]]*)Request Entity Too Large([[:space:][:punct:]]|$)'
          OR error = 'Файл выписки превышает 200 МБ.');
      CREATE TABLE IF NOT EXISTS egrn_pending (
        id         SERIAL PRIMARY KEY,
        cad_num    TEXT NOT NULL,
        label      TEXT,
        chat_id    BIGINT,
        src_msg_id BIGINT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `).catch(function (e) { ready = null; throw e; });
  }
  return ready;
}

function configured() { return !!(process.env.EGRN_TOKEN && process.env.EGRN_DECLARANT_ID); }

// «77:17:0120316:38939 - ООО Скандинавия» → [{ cad, label }]
function parseCads(text) {
  const t = String(text || '');
  const out = [];
  t.split('\n').forEach(function (line) {
    const cads = line.match(CAD_RE) || [];
    if (!cads.length) return;
    const label = line.replace(CAD_RE, ' ').replace(/^[\s\-–—:,.;]+|[\s\-–—:,.;]+$/g, '').replace(/\s+/g, ' ').trim();
    cads.forEach(function (cad) { if (!out.some(function (x) { return x.cad === cad; })) out.push({ cad: cad, label: label.slice(0, 120) }); });
  });
  return out;
}

async function apiOrder(cad, typeDoc) {
  let response;
  try {
    response = await fetch(API, {
      method: 'POST',
      headers: { 'Authorization-Token': process.env.EGRN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cad_num: cad, type_doc: typeDoc, id_declarant: parseInt(process.env.EGRN_DECLARANT_ID) || process.env.EGRN_DECLARANT_ID }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    const statement = data?.id_statement;
    if (!response.ok || typeof statement === 'number' && !Number.isSafeInteger(statement) || !/^[1-9]\d{0,18}$/.test(String(statement || '')) || BigInt(statement)>9223372036854775807n) throw new Error('Unconfirmed order');
    return data.id_statement;
  } catch (cause) {
    const rejected = response && [400, 401, 403, 404, 405, 409, 422].includes(response.status);
    throw Object.assign(new Error(rejected
      ? 'Поставщик отклонил заказ выписки. Проверьте настройки и данные заказа.'
      : 'Поставщик не подтвердил результат заказа. Проверьте личный кабинет перед повторным заказом.'),
    { code: rejected ? 'EGRN_ORDER_REJECTED' : 'EGRN_ORDER_UNCONFIRMED', uncertain: !rejected });
  }
}

async function reserveOrder(cad, opts) {
  await budget().ensure();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The lock protects only the short reservation transaction. Provider I/O
    // happens after COMMIT, so a slow service never consumes a locked pool slot.
    await client.query('SELECT pg_advisory_xact_lock(117,hashtext($1))', [cad + '\n' + TYPE_DOC]);
    let previous;
    if (opts.requestKey) previous = (await client.query('SELECT * FROM egrn_orders WHERE request_key=$1', [opts.requestKey])).rows[0];
    if (!previous && opts.force) previous = (await client.query("SELECT * FROM egrn_orders WHERE cad_num=$1 AND type_doc=$2 AND status IN ('ordering','order_unknown') ORDER BY id DESC LIMIT 1", [cad, TYPE_DOC])).rows[0];
    if (!previous && !opts.force) previous = (await client.query(
      "SELECT * FROM egrn_orders WHERE cad_num=$1 AND type_doc=$2 AND status <> 'failed' AND created_at > NOW() - INTERVAL '30 days' ORDER BY id DESC LIMIT 1",
      [cad, TYPE_DOC])).rows[0];
    if (previous) {
      await client.query('COMMIT');
      return { order: previous, created: false };
    }
    const target = process.env.EGRN_CHAT_ID || opts.orderedBy;
    const order = (await client.query(
      "INSERT INTO egrn_orders(cad_num,label,type_doc,ordered_by,ordered_name,status,status_text,chat_id,deliver,request_key) VALUES($1,$2,$3,$4,$5,'ordering','Подтверждаю заказ у поставщика',$6,$7,$8) RETURNING *",
      [cad, opts.label || '', TYPE_DOC, opts.orderedBy, opts.orderedName || '', target, JSON.stringify(opts.targets || []), opts.requestKey || null])).rows[0];
    await budget().reserveInTransaction(client, order.id);
    await client.query('COMMIT');
    return { order, created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function placeReservedOrder(order) {
  let statement;
  try {
    statement = await apiOrder(order.cad_num, order.type_doc);
    await budget().accept(order.id, statement);
    const result = await pool.query("UPDATE egrn_orders SET id_statement=$1,status='ordered',status_text='заказана',error=NULL,updated_at=NOW() WHERE id=$2 RETURNING *", [statement, order.id]);
    return result.rows[0];
  } catch (error) {
    // A lost HTTP or database acknowledgement must not trigger another paid
    // POST. Retain the reservation even after a process restart.
    if (error.uncertain === false && !statement) {
      let client, failed;
      try {
        client = await pool.connect(); await client.query('BEGIN');
        // Use the same order-row -> account-row lock order as reconciliation.
        // Neither a failed order with a stranded reserve nor a released
        // reserve with an unconfirmed local order may escape this transaction.
        await client.query('UPDATE egrn_orders SET status=$1,status_text=$2,error=$2,updated_at=NOW() WHERE id=$3', ['failed', error.message, order.id]);
        await budget().rejectInTransaction(client, order.id);
        await client.query('COMMIT');
      } catch (failure) {
        failed = failure;
        if (client) await client.query('ROLLBACK').catch(() => {});
      } finally { if (client) client.release(); }
      if (!failed) throw error;
      error = Object.assign(new Error('Поставщик отклонил заказ, но подтверждение учёта не сохранилось. Администратору нужно сверить запись бота ' + order.id + ' командой /egrn_reconcile ' + order.id + ' no_order. Повторный платный заказ не создан.'), { uncertain: true, code: 'EGRN_ORDER_REJECTION_CHECKPOINT' });
    }
    const details = error.code === 'EGRN_ORDER_REJECTION_CHECKPOINT' ? error.message : 'Заказ требует проверки у поставщика';
    await pool.query('UPDATE egrn_orders SET status=$1,status_text=$2,error=$2,id_statement=COALESCE($3,id_statement),updated_at=NOW() WHERE id=$4',
      ['order_unknown', details, statement || null, order.id]).catch(() => {});
    if (statement) error = Object.assign(new Error('Заказ создан у поставщика, но подтверждение в боте не сохранено. Передайте администратору номер ' + statement + '.'), { uncertain: true, code: 'EGRN_ORDER_CHECKPOINT' });
    throw error;
  }
}

async function mergeTargets(order, targets) {
  if (!Array.isArray(targets) || !targets.length) return order;
  const result = await pool.query(`UPDATE egrn_orders SET deliver=(
      SELECT COALESCE(jsonb_agg(target), '[]'::jsonb) FROM (
        SELECT DISTINCT target FROM jsonb_array_elements(COALESCE(deliver,'[]'::jsonb) || $1::jsonb) AS entry(target)
      ) unique_targets
    ), delivery_revision=delivery_revision+1,
    files_sent=CASE WHEN files_sent>0 THEN 0 ELSE files_sent END,
    failures=0,retry_at=NULL,updated_at=NOW() WHERE id=$2 RETURNING *`, [JSON.stringify(targets), order.id]);
  if (!result.rows[0]) throw new Error('Заказ выписки больше недоступен.');
  return result.rows[0];
}

function authHeaders() {
  const h = {};
  if (process.env.EGRN_LOGIN) h['Authorization-Login'] = process.env.EGRN_LOGIN;
  if (process.env.EGRN_PASSWORD) h['Authorization-Password'] = process.env.EGRN_PASSWORD;
  if (process.env.EGRN_TOKEN) h['Authorization-Token'] = process.env.EGRN_TOKEN;
  return h;
}

let cleanedSources;
async function apiStatus(idReq) {
  const source = require('./egrn-source');
  if (!cleanedSources) cleanedSources = source.cleanupStale().catch(() => { cleanedSources = null; });
  await cleanedSources;
  return require('./egrn-source-retry').readWithRetry(async (attempt, { signal }) => {
    console.log('egrn receive:', JSON.stringify({ id_statement: idReq, attempt }));
    const r = await fetch(API + '?id_req=' + encodeURIComponent(idReq), { headers: authHeaders(), signal });
    if (!r.ok || !r.body) {
      await r.body?.cancel().catch(() => {});
      const temporary = !r.body && r.ok || [408, 425, 429, 500, 502, 503, 504].includes(r.status);
      throw Object.assign(new Error('Сервис ЕГРН временно недоступен.'), { code: temporary ? 'EGRN_SOURCE_RESPONSE' : 'EGRN_SOURCE_HTTP_' + r.status });
    }
    // fetch cancels its own response body on deadline. A completely received
    // local original must survive that deadline while being stored/delivered.
    try { return await source.readStatusResponse(r.body, { idReq }); }
    catch (error) { await r.body.cancel().catch(() => {}); throw error; }
  }, { onRetry(info) { console.error('egrn receive retry:', JSON.stringify({ id_statement: idReq, ...info })); } });
}

// Ищем запись по нашей заявке в ответе (формат: { "0": {...}, "1": {...} } или сразу объект)
function findReq(j, idReq) {
  if (j && String(j.id_req) === String(idReq)) return j;
  let found = null;
  (function walk(o) {
    if (found || !o || typeof o !== 'object') return;
    if (String(o.id_req) === String(idReq)) { found = o; return; }
    Object.keys(o).forEach(function (k) { walk(o[k]); });
  })(j);
  return found || j;
}

function statusList(item) {
  const raw = item && item.status;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.keys(raw).map(function (k) { return raw[k]; }).filter(function (x) { return x && typeof x === 'object' && (x.type || x.statusDescription); });
  return [];
}

function readStatus(item) {
  const st = statusList(item);
  const types = st.map(function (s) { return String(s.type || '') + ' ' + String(s.statusDescription || ''); }).join(' | ');
  const done = /processed|выполнено/i.test(types) || findEmbeddedFiles(item).length > 0; // файл в ответе = выписка готова
  const failed = !done && /reject|error|fail|cancel|denied|отказ|ошибк|отклон/i.test(types);
  // самый свежий статус — с наибольшим id_status
  const last = st.slice().sort(function (a, b) { return (b.id_status || 0) - (a.id_status || 0); })[0];
  const human = last ? String(last.statusDescription || last.type || '').replace(/^в статусе\s*/i, '').replace(/['"«»]/g, '') : 'отправлена';
  return { done: done, failed: failed, text: human, kuvd: last && last.kuvdNumbers };
}

// Файлы прямо в ответе: base64 ZIP (UEsDB…) или PDF (JVBER…), обычно в status.file
function findEmbeddedFiles(item) {
  const out = [];
  (function walk(o, key) {
    if (o == null) return;
    if (typeof o === 'string') {
      const t = o.replace(/\s+/g, '');
      if (t.length > 200 && /^(UEsDB|UEsFB|JVBER)/.test(t)) out.push({ key: key || 'file', b64: t });
      return;
    }
    if (typeof o === 'object') Object.keys(o).forEach(function (k) { walk(o[k], k); });
  })(item, '');
  return out;
}

// Минимальная распаковка ZIP (stored / deflate) — центральный каталог
function unzip(buf) {
  const zlib = require('zlib');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('не ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const comp = buf.slice(start, start + csize);
    let data = null;
    if (method === 0) data = comp; else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_RECEIVED_BYTES });
    if (data && (data.length > MAX_RECEIVED_BYTES || files.reduce((sum, file) => sum + file.data.length, 0) + data.length > MAX_RECEIVED_BYTES)) throw new Error('Архив выписки превышает допустимый объём распаковки.');
    if (data && !/\/$/.test(name)) files.push({ name: name, data: data });
    p += 46 + nlen + elen + clen;
  }
  return files;
}

// Из ответа → файлы для отправки: PDF из архива (+ сам архив с XML на случай, если PDF нет)
function extractDocs(item, cad) {
  const docs = [];
  const base = String(cad || 'vypiska').replace(/:/g, '-');
  findEmbeddedFiles(item).forEach(function (f, i) {
    if (f.b64.length > Math.ceil(MAX_RECEIVED_BYTES / 3) * 4) throw Object.assign(new Error('Файл выписки превышает 2 ГБ.'), { code: 'EGRN_FILE_TOO_LARGE' });
    const buf = Buffer.from(f.b64, 'base64');
    if (/^JVBER/.test(f.b64)) { docs.push({ name: 'ЕГРН_' + base + (i ? '_' + i : '') + '.pdf', buf: buf, kind: 'pdf' }); return; }
    try {
      const files = unzip(buf);
      const pdfs = files.filter(function (x) { return /\.pdf$/i.test(x.name); });
      pdfs.forEach(function (x, j) { docs.push({ name: 'ЕГРН_' + base + (pdfs.length > 1 ? '_' + (j + 1) : '') + '.pdf', buf: x.data, kind: 'pdf' }); });
      const xml = files.find(function (x) { return /\.xml$/i.test(x.name); });
      // XML в чат не отправляем — нужен только PDF
      if (!pdfs.length) docs.push({ name: 'ЕГРН_' + base + '.zip', buf: buf, kind: 'zip' });
    } catch (e) {
      docs.push({ name: 'ЕГРН_' + base + '.zip', buf: buf, kind: 'zip' });
    }
  });
  return docs;
}

// Убрать base64 из ответа перед сохранением в базу (чтобы /egrn_debug был читаемым)
function stripB64(item) {
  return JSON.parse(JSON.stringify(item, function (k, v) {
    return typeof v === 'string' && v.length > 200 && /^(UEsDB|UEsFB|JVBER)/.test(v) ? '<файл base64, ' + v.length + ' символов>' : v;
  }));
}

// Все ссылки на файлы в ответе — формат файлов в документации не описан, поэтому ищем везде
function findFileUrls(item) {
  const urls = [];
  (function walk(o, key) {
    if (o == null) return;
    if (typeof o === 'string') {
      if (/^https?:\/\//i.test(o) && (/file|download|pdf|zip|xml|doc|result|answer/i.test(o + ' ' + (key || '')))) urls.push(o);
      return;
    }
    if (typeof o === 'object') Object.keys(o).forEach(function (k) { walk(o[k], k); });
  })(item, '');
  return urls.filter(function (u, i) { return urls.indexOf(u) === i; });
}

async function download(url) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let target;
  try { target = new URL(url); } catch (_) { throw new Error('Сервис передал некорректную ссылку на выписку.'); }
  let r;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Сервис передал небезопасную ссылку на выписку.');
    // Custom authorization headers must not follow a link/redirect to a
    // different file-hosting service. Those links supply their own access.
    const headers = target.origin === new URL(API).origin ? authHeaders() : {};
    r = await fetch(target.href, { headers, signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(r.status)) break;
    const location = r.headers.get('location'); await r.body?.cancel().catch(() => {});
    if (!location || redirects === 5) throw new Error('Не удалось открыть ссылку на выписку.');
    target = new URL(location, target);
  }
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error('Не удалось скачать выписку (HTTP ' + r.status + ').'); }
  if (Number(r.headers.get('content-length')) > MAX_RECEIVED_BYTES) {
    await r.body?.cancel().catch(() => {});
    throw Object.assign(new Error('Файл выписки превышает 2 ГБ.'), { code: 'EGRN_FILE_TOO_LARGE' });
  }
  if (!r.body) throw new Error('Сервис ЕГРН не передал содержимое файла.');
  try {
    let name = '';
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) { try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; } }
    if (!name) {
      name = target.pathname.split('/').pop() || 'vypiska';
      try { name = decodeURIComponent(name); } catch (_) { name = 'vypiska'; }
    }
    if (!/\.[a-z0-9]{2,4}$/i.test(name)) {
      const ct = r.headers.get('content-type') || '';
      name += /pdf/.test(ct) ? '.pdf' : /zip/.test(ct) ? '.zip' : /xml/.test(ct) ? '.xml' : '';
    }
    const received = await require('./egrn-source').readFileResponse(r.body, name);
    return Object.assign(received.file, { cleanup: received.cleanup });
  } catch (error) { await r.body.cancel().catch(() => {}); throw error; }
}

function documentBytes(file) { return file.buf ? file.buf.length : file.bytes; }
async function smallDocument(file) {
  if (file.buf) return file;
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_DOCUMENT_BYTES || typeof file.open !== 'function') throw new Error('Некорректный файл выписки.');
  const chunks = []; let size = 0;
  for await (const chunk of file.open()) {
    size += chunk.byteLength;
    if (size > file.bytes) throw new Error('Размер полученной выписки изменился.');
    chunks.push(chunk);
  }
  if (size !== file.bytes) throw new Error('Файл выписки получен не полностью.');
  const complete = Object.assign({}, file, { buf: Buffer.concat(chunks, size) });
  originalHash(complete);
  return complete;
}

function cardText(o, extra) {
  const t = TYPES[o.type_doc] || { short: o.type_doc, icon: '📄' };
  const icon = o.status === 'done' ? '✅' : o.status === 'failed' ? '❌' : '⏳';
  return icon + ' <b>Выписка ЕГРН ' + t.short + '</b>\n' +
    '<code>' + esc(o.cad_num) + '</code>' + (o.label ? ' — ' + esc(o.label) : '') + '\n' +
    'Статус: ' + esc(o.status_text || 'заказана') + (o.id_statement ? ' · заявка №' + o.id_statement : '') + '\n' +
    'Заказал(а): ' + esc(o.ordered_name || '') + budgetSuffix(o.chat_id, esc(o.budget_text || '')) + (extra ? '\n' + extra : '');
}

function setupEgrn(bot) {
  ensureTables().catch(function (e) { console.error('egrn tables:', e.message); });
  const CHAT = function () { return process.env.EGRN_CHAT_ID; };
  const waitInput = {}; // userId → время ожидания строки с кадастровым номером

  async function canOrder(uid, chatId) {
    if (CHAT() && String(chatId) === String(CHAT())) return true; // участник чата выписок
    const admins = String(process.env.ADMIN_TG_IDS || '').split(/[\s,;]+/);
    if (admins.indexOf(String(uid)) !== -1) return true;
    const s = (await pool.query('SELECT 1 FROM staff WHERE tg_id=$1 AND approved = true', [uid])).rows[0];
    return !!s;
  }
  function nameOf(from) { return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id); }

  function orderButtons(pid) {
    return [{ text: '📄 Заказать выписку', callback_data: 'eg:' + pid + ':kv' }, { text: '✖️ Не нужно', callback_data: 'egx:' + pid }];
  }

  // Погасить кнопки только у этого номера: строку с кнопками pid заменяем надписью
  async function closeRow(ctx, pid, label) {
    try {
      const msg = ctx.callbackQuery && ctx.callbackQuery.message;
      const kb = msg && msg.reply_markup && msg.reply_markup.inline_keyboard;
      if (!kb) return;
      const re = new RegExp('^egx?:' + pid + '(:|$)');
      let changed = false;
      const rows = kb.map(function (row) {
        if (row.some(function (b) { return b.callback_data && re.test(b.callback_data); })) { changed = true; return [{ text: label, callback_data: 'noop' }]; }
        return row;
      });
      if (changed) await ctx.editMessageReplyMarkup({ inline_keyboard: rows });
    } catch (e) { console.error('egrn closeRow:', e.message); }
  }

  async function offer(ctx, items, chatId, srcMsgId, intro) {
    const rows = [];
    for (const it of items.slice(0, 8)) {
      const p = (await pool.query('INSERT INTO egrn_pending (cad_num, label, chat_id, src_msg_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [it.cad, it.label, chatId, srcMsgId || null])).rows[0];
      if (items.length > 1) rows.push([{ text: it.cad + (it.label ? ' — ' + it.label.slice(0, 24) : ''), callback_data: 'noop' }]);
      rows.push(orderButtons(p.id));
    }
    const opts = { reply_markup: { inline_keyboard: rows }, disable_notification: true };
    if (srcMsgId) opts.reply_to_message_id = srcMsgId;
    await ctx.telegram.sendMessage(chatId, intro, opts);
  }

  // ── Чат выписок: сообщение с кадастровым номером → кнопки «Заказать»
  bot.on('message', async function (ctx, next) {
    try {
      const text = ctx.message.text || ctx.message.caption || '';
      // 1) личка менеджера после кнопки «📄 Выписка ЕГРН»
      if (ctx.chat.type === 'private' && waitInput[ctx.from.id] && text && text.charAt(0) !== '/') {
        if (Date.now() - waitInput[ctx.from.id] > 15 * 60 * 1000) { delete waitInput[ctx.from.id]; return next(); }
        const items = parseCads(text);
        if (!items.length) return ctx.reply('Не нашёл кадастровый номер. Формат: 77:17:0120316:38939 - ООО Скандинавия');
        delete waitInput[ctx.from.id];
        return offer(ctx, items, ctx.chat.id, ctx.message.message_id, 'Заказать выписку об объекте?' + (configured() ? '' : '\n⚠️ Заказ не настроен: нет доступов к API в Railway.'));
      }
      // 2) сообщение в чате выписок
      if (CHAT() && String(ctx.chat.id) === String(CHAT()) && text) {
        const items = parseCads(text);
        if (items.length) await offer(ctx, items, ctx.chat.id, ctx.message.message_id, 'Заказать выписку об объекте?');
      }
    } catch (e) { console.error('egrn message:', e.message); }
    return next();
  });

  tgApi = bot.telegram;
  bot.hears('📄 Выписка ЕГРН', async function (ctx) {
    if (!(await canOrder(ctx.from.id, ctx.chat.id))) return ctx.reply('Нет доступа. Нажмите /start.');
    waitInput[ctx.from.id] = Date.now();
    await ctx.reply('Пришлите кадастровый номер и организацию, как в чате выписок:\n<code>77:17:0120316:38939 - ООО Скандинавия</code>\n\nМожно несколько строк — по одной на объект.', { parse_mode: 'HTML' });
  });

  // ── Нажатие «Заказать»
  bot.action(/^eg:(\d+):(kv)(:force)?$/, async function (ctx) {
    try {
      const cbChat = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.chat ? ctx.callbackQuery.message.chat.id : ctx.from.id;
      if (!(await canOrder(ctx.from.id, cbChat))) return ctx.answerCbQuery('Нет доступа к заказу выписок', { show_alert: true });
      if (!configured()) return ctx.answerCbQuery('Нет доступов к API ЕГРН в Railway (EGRN_TOKEN, EGRN_DECLARANT_ID)', { show_alert: true });
      const p = (await pool.query('SELECT * FROM egrn_pending WHERE id=$1', [ctx.match[1]])).rows[0];
      if (!p) return ctx.answerCbQuery('Кнопка устарела, пришлите номер ещё раз', { show_alert: true });
      const typeDoc = TYPE_DOC;

      await ctx.answerCbQuery('Проверяю заказ…');
      const result = await attachOrOrder({ cad: p.cad_num, label: p.label, order: true,
        orderedBy: ctx.from.id, orderedName: nameOf(ctx.from), force: !!ctx.match[3],
        requestKey: ctx.match[3] ? 'telegram:' + p.id : null,
        targets: [{ chat: cbChat }], note: 'Заказ из Telegram' });
      if (result.result === 'attached') {
        return ctx.reply('Готовая выписка отправлена выше. Новую выписку заказывать не потребовалось.' + budgetSuffix(cbChat, result.budget_text), {
          reply_markup: { inline_keyboard: [[{ text: 'Заказать новую выписку ещё раз', callback_data: 'eg:' + p.id + ':' + ctx.match[2] + ':force' }]] },
        });
      }
      if (result.result === 'uncertain') return ctx.reply(result.packet_warning + budgetSuffix(cbChat, result.budget_text));
      if (result.result === 'waiting') return ctx.reply('Выписка по ' + p.cad_num + ' уже в работе. Пришлю её после готовности.' + budgetSuffix(cbChat, result.budget_text));
      if (result.result === 'unavailable') return ctx.reply('Выписка уже заказана, но её доставка остановлена. Передайте администратору номер ' + result.id + ' для повтора доставки.');
      if (result.result !== 'ordered') return ctx.reply('Не удалось подтвердить заказ выписки. Повторный платный заказ не создавался.');
      await ctx.reply('⏳ Выписка по ' + p.cad_num + ' заказана (№' + result.id + '). Пришлю, когда будет готова.' + budgetSuffix(cbChat, result.budget_text));
      await closeRow(ctx, p.id, '✅ Заказано · ' + nameOf(ctx.from));
    } catch (e) {
      console.error('egrn order:', e.message);
      try { await ctx.answerCbQuery('Не удалось заказать: ' + e.message.slice(0, 150), { show_alert: true }); } catch (x) {}
    }
  });

  // «Не нужно» — гасим кнопки этого номера
  bot.action(/^egx:(\d+)$/, async function (ctx) {
    try {
      const cbChat = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.chat ? ctx.callbackQuery.message.chat.id : ctx.from.id;
      if (!(await canOrder(ctx.from.id, cbChat))) return ctx.answerCbQuery('Нет доступа', { show_alert: true });
      await pool.query('DELETE FROM egrn_pending WHERE id=$1', [ctx.match[1]]);
      await closeRow(ctx, ctx.match[1], '✖️ Не заказываем · ' + nameOf(ctx.from));
      await ctx.answerCbQuery('Не заказываем');
    } catch (e) { try { await ctx.answerCbQuery('Ошибка: ' + e.message.slice(0, 100), { show_alert: true }); } catch (x) {} }
  });

  bot.action(/^egf:([0-9a-f-]{36})$/i, async function (ctx) {
    try {
      const message = ctx.callbackQuery && ctx.callbackQuery.message;
      const chat = message && message.chat ? message.chat.id : ctx.from.id;
      if (!(await canOrder(ctx.from.id, chat))) return ctx.answerCbQuery('Нет доступа к выпискам', { show_alert: true });
      const file = await require('./egrn-files').get(ctx.match[1]);
      if (!file) return ctx.answerCbQuery('Сохранённая выписка не найдена.', { show_alert: true });
      const url = require('../web/egrn-downloads').createDownloadUrl(file.id);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [
        [{ text: 'Скачать выписку · ' + Math.ceil(file.bytes / 1024 / 1024) + ' МБ', url }],
        [{ text: 'Обновить ссылку', callback_data: 'egf:' + file.id }]
      ] });
      await ctx.answerCbQuery('Ссылка обновлена. Повторный заказ не создавался.');
    } catch (_) {
      await ctx.answerCbQuery('Не удалось обновить ссылку. Попробуйте позднее.', { show_alert: true }).catch(() => {});
    }
  });

  // These commands record the provider account; they never transfer money.
  const budgetReviews = new Map();
  function budgetAdmin(ctx) {
    return ctx.chat?.type === 'private' && String(process.env.ADMIN_TG_IDS || '').split(/[\s,;]+/).includes(String(ctx.from?.id));
  }
  for (const [command, operation] of [['egrn_topup', 'topup'], ['egrn_balance', 'syncBalance']]) {
    bot.command(command, async function (ctx) {
      if (!budgetAdmin(ctx)) return;
      const match = String(ctx.message?.text || '').match(new RegExp('^/' + command + '(?:@[a-z\\d_]+)?\\s+(.+?)\\s*$', 'i'));
      if (!match) return ctx.reply(operation === 'topup' ? 'Учесть уже выполненное пополнение: /egrn_topup 2500,50. Сумма может быть любой. Команда денег не переводит.' : 'Зафиксировать известный остаток: /egrn_balance 2500,50. Это необязательная сверка, а не пополнение.');
      if (!Number.isSafeInteger(ctx.message.message_id) || ctx.message.message_id < 1) return ctx.reply('Не удалось определить номер сообщения. Отправьте команду отдельным сообщением.');
      try {
        await ensureTables();
        const context = { actorId: ctx.from.id, sourceKey: 'telegram:' + ctx.chat.id + ':' + ctx.message.message_id };
        if (operation === 'syncBalance') {
          const reviewed = budgetReviews.get(String(ctx.from.id)), age = reviewed ? Date.now() - reviewed.at : -1;
          context.expectedSnapshot = age >= 0 && age < 5 * 60 * 1000 ? reviewed.revision : null;
        }
        const snapshot = await budget()[operation](match[1], context);
        return ctx.reply((operation === 'topup' ? 'Пополнение учтено: ' : 'Сверка остатка записана: ') + match[1] + ' ₽.\n' + budget().describe(snapshot));
      } catch (failure) {
        if (failure.code === 'EGRN_BUDGET_SNAPSHOT_CHANGED' || failure.code === 'EGRN_BUDGET_REVIEW_REQUIRED') budgetReviews.delete(String(ctx.from.id));
        return ctx.reply(failure.status ? failure.message : 'Не удалось подтвердить запись. Проверьте /egrn_budget перед повторной командой.');
      }
    });
  }
  bot.command('egrn_budget', async function (ctx) {
    if (!budgetAdmin(ctx)) return;
    try {
      await ensureTables();
      const snapshot = await budget().snapshot(), history = await budget().previewHistory();
      const range = history.fromDate ? new Date(history.fromDate).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' — ' + new Date(history.toDate).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'даты не сохранены';
      const result = await ctx.reply(budget().describe(snapshot) + '\n\nДо начала учёта: ' + history.confirmedOrders + ' подтверждённых заказов (' + range + '). Оценка по текущей цене: ' + (history.estimatedKopecks / 100).toFixed(2) + ' ₽; это не подтверждение списаний. Неопределённых старых заказов: ' + history.unknownOrders + '. Старое пополнение автоматически не добавлено.');
      budgetReviews.set(String(ctx.from.id), { revision: require('./egrn-budget').snapshotRevision(snapshot), at: Date.now() });
      return result;
    } catch (_) { return ctx.reply('Учёт временно недоступен. Повторите позднее; платный заказ не создавался.'); }
  });

  // Resolve an ambiguous paid request only after an administrator has checked
  // the provider cabinet. This operation binds an existing order; it never POSTs.
  bot.command('egrn_reconcile', async function (ctx) {
    if (ctx.chat?.type !== 'private') return;
    const admins = String(process.env.ADMIN_TG_IDS || '').split(/[\s,;]+/);
    if (!admins.includes(String(ctx.from.id))) return ctx.reply('Сверить заказ может только администратор.');
    const match = String(ctx.message?.text || '').match(/^\/egrn_reconcile(?:@[a-z\d_]+)?\s+([1-9]\d{0,9})\s+([1-9]\d{0,18}|no_order)\s*$/i);
    if (!match || Number(match[1]) > 2147483647 || match[2].toLowerCase() !== 'no_order' && BigInt(match[2]) > 9223372036854775807n) {
      return ctx.reply('После проверки кабинета поставщика укажите номер записи бота и существующего заказа: /egrn_reconcile запись номер_поставщика. Если подтверждено отсутствие заказа: /egrn_reconcile запись no_order. Команда ничего не заказывает.');
    }
    let client;
    try {
      await ensureTables(); await budget().ensure();
      client = await pool.connect(); await client.query('BEGIN');
      const absent = match[2].toLowerCase() === 'no_order';
      const result = await client.query(`UPDATE egrn_orders SET id_statement=$1,status=$2,status_text=$3,
        files_sent=0,failures=0,retry_at=NULL,error=NULL,updated_at=NOW()
        WHERE id=$4 AND status IN ('ordering','order_unknown')
          AND ($1::bigint IS NULL OR id_statement IS NULL OR id_statement=$1)
          AND ($1::bigint IS NULL OR NOT EXISTS (SELECT 1 FROM egrn_orders other WHERE other.id<>$4 AND other.id_statement=$1))
        RETURNING id`, [absent ? null : match[2], absent ? 'failed' : 'ordered',
        absent ? 'Отсутствие заказа подтверждено администратором' : 'Заказ сверён с поставщиком', match[1]]);
      if (result.rows.length) {
        if (absent) await budget().rejectInTransaction(client, match[1]);
        else await budget().acceptInTransaction(client, match[1], match[2]);
      }
      await client.query('COMMIT');
      return ctx.reply(result.rows.length
        ? absent ? 'Отсутствие заказа зафиксировано. Следующий заказ можно создать обычной кнопкой.' : 'Существующий заказ привязан. Бот проверит его готовность и доставит выписку.'
        : 'Не найдена подходящая неопределённая запись. Уже подтверждённые заказы не изменены.');
    } catch (error) { if (client) await client.query('ROLLBACK').catch(() => {}); console.error('egrn reconcile:', error.code || 'unavailable'); return ctx.reply('Не удалось сохранить сверку. Заказ не создавался.'); }
    finally { if (client) client.release(); }
  });

  // Админу: сырой ответ API по заказу — чтобы разобраться с форматом
  bot.command('egrn_debug', async function (ctx) {
    const admins = String(process.env.ADMIN_TG_IDS || '').split(/[\s,;]+/);
    if (admins.indexOf(String(ctx.from.id)) === -1) return;
    const id = parseInt((ctx.message.text.split(/\s+/)[1] || '0'));
    const o = (await pool.query(id ? 'SELECT * FROM egrn_orders WHERE id=$1' : 'SELECT * FROM egrn_orders ORDER BY id DESC LIMIT 1', id ? [id] : [])).rows[0];
    if (!o) return ctx.reply('Заказов нет');
    await ctx.reply('Заказ #' + o.id + ' · №' + o.id_statement + ' · ' + o.status + '\n' + (o.error ? 'Ошибка: ' + o.error + '\n' : '') + JSON.stringify(o.raw || {}, null, 1).slice(0, 3500));
  });

  // ── Опрос статусов
  async function notifyStopped(o, tooLarge) {
    const text = o.file_limit_exceeded ? '⚠️ Поставщик передал больше 32 файлов или ссылок на оригиналы. Полный комплект не подтверждён; новые файлы не отправлены. Проверьте комплект у поставщика. Новый платный заказ не создавался.' : o.delivery_unknown ? '⚠️ Результат отправки оригинала не подтверждён. Проверьте сообщения в чате. После проверки администратор может разрешить повтор: /egrn_retry ' + o.id_statement + '. Новый платный заказ не создавался.' : o.recipient_unavailable ? '⚠️ Доставка выписки ожидает проверки доступа получателя или назначения юриста. Подтверждённые файлы сохранены; новый платный заказ не создавался.' : o.identity_unconfirmed ? '⚠️ Не удалось подтвердить оригиналы в старом частичном комплекте. Проверьте ранее доставленные файлы вручную; автоматическая пересылка остановлена и новый платный заказ не создан.' : o.status === 'done'
      ? '⚠️ Выписка готова, но ' + (tooLarge ? 'не удалось подготовить файл для скачивания.' : 'не все файлы удалось доставить после нескольких попыток.')
      : '⚠️ Не удалось проверить готовность выписки после нескольких попыток.';
    const fallback = '\nСкачайте выписку или проверьте заявку №' + o.id_statement + ' в личном кабинете: https://armrus.org';
    if (o.status_msg_id) {
      try { await telegramDelivery().authorize(o, {chat:o.chat_id});await bot.telegram.editMessageText(o.chat_id, Number(o.status_msg_id), undefined, cardText(o, text + fallback), { parse_mode: 'HTML' }); }
      catch (e) { console.error('egrn notification:', o.id_statement, e.message); }
    }
    // Личное уведомление — только заказавшему сотруднику, без технических ошибок и ссылок с токенами.
    const targets=[o.ordered_by||o.chat_id,...String(process.env.ADMIN_TG_IDS||'').split(/[\s,;]+/),process.env.EGRN_CHAT_ID,process.env.GROUP_CHAT_ID].filter(Boolean);
    for (const target of [...new Set(targets.map(String))]) {
      try { await telegramDelivery().authorize(o,{chat:target});await bot.telegram.sendMessage(target, text + '\nКадастровый номер: ' + o.cad_num + fallback);break; }
      catch (e) { console.error('egrn notification:', o.id_statement, e.code || 'unavailable'); }
    }
  }

  async function saveFailure(o, errors, permanent, fileMsgs) {
    const failures = (o.failures || 0) + 1;
    const stopped = permanent || failures >= MAX_FAILURES;
    const retryAt = stopped ? null : new Date(Date.now() + 3 * 60 * 1000 * Math.pow(2, failures - 1));
    await pool.query('UPDATE egrn_orders SET files_sent=$1, file_msgs=$2, error=$3, failures=$4, retry_at=$5, updated_at=NOW() WHERE id=$6 AND processing_token=$7',
      [stopped ? -1 : 0, JSON.stringify(fileMsgs), errors.join('; ').slice(0, 300), failures, retryAt, o.id, o.processing_token]);
    if (stopped || o.recipient_unavailable && o.error !== errors.join('; ').slice(0,300)) await notifyStopped(o, permanent);
  }

  let polling = false;
  async function poll() {
    if (!configured() || polling) return;
    polling = true;
    try {
      await ensureTables();
      await pollOrders();
    } catch (e) {
      console.error('egrn poll:', e.message);
    } finally { polling = false; }
  }

  async function pollOrders(onlyId) {
    let rows = [];
    try {
      rows = (await pool.query("SELECT * FROM egrn_orders WHERE status IN ('ordered','done') AND files_sent = 0 AND (processing_until IS NULL OR processing_until<=NOW()) AND (retry_at IS NULL OR retry_at <= NOW()) AND ((status='ordered' AND created_at > NOW() - INTERVAL '" + MAX_POLL_HOURS + " hours') OR (status='done' AND created_at > NOW() - INTERVAL '30 days'))" +
        (onlyId ? ' AND id=$1' : '') + ' ORDER BY updated_at NULLS FIRST,id LIMIT 20', onlyId ? [onlyId] : undefined)).rows;
    } catch (e) { return console.error('egrn poll:', e.message); }
    for (const candidate of rows) {
      const o = await claimDelivery(candidate.id);
      if (!o) continue;
      const lease = keepDeliveryAlive(o);
      let source;
      try {
        telegramDelivery().assertAvailable(o);
        o.budget_text = await budgetText(o);
        if (await resumeLargeDelivery(o)) continue;
        const j = await apiStatus(o.id_statement);
        source = j && typeof j.cleanup === 'function' && typeof j.documents === 'function' ? j : null;
        lease.assert();
        const item = source ? source.item : findReq(j, o.id_statement);
        const st = readStatus(item);
        if (source?.hasFiles) { st.done = true; st.failed = false; }
        const newStatus = st.failed ? 'failed' : st.done ? 'done' : 'ordered';
        const changed = newStatus !== o.status || st.text !== o.status_text;
        const savedStatus = await pool.query('UPDATE egrn_orders SET status=$1,status_text=$2,raw=$3,polls=polls+1,updated_at=NOW() WHERE id=$4 AND processing_token=$5', [newStatus, st.done && !/выполн/i.test(st.text) ? 'готова' : st.text, stripB64(item), o.id, o.processing_token]);
        if (savedStatus.rowCount === 0) throw lostLease();
        if (st.done && !/выполн/i.test(st.text)) st.text = 'готова';
        Object.assign(o, { status: newStatus, status_text: st.text, polls: o.polls + 1 });
        if (changed && o.status_msg_id) {
          try { o.budget_text=await messageBudgetText(o.chat_id);await telegramDelivery().authorize(o,{chat:o.chat_id});await bot.telegram.editMessageText(o.chat_id, Number(o.status_msg_id), undefined, cardText(o), { parse_mode: 'HTML' }); } catch (e) {}
        }
        if (newStatus === 'failed') {
          await pool.query('UPDATE egrn_orders SET files_sent = -1 WHERE id=$1 AND processing_token=$2', [o.id, o.processing_token]);
          try { await telegramDelivery().authorize(o,{chat:o.ordered_by});await bot.telegram.sendMessage(o.ordered_by, '❌ Выписка по ' + o.cad_num + ' не выполнена: ' + st.text); } catch (e) {}
          continue;
        }
        if (newStatus !== 'done') {
          await pool.query('UPDATE egrn_orders SET failures=0,retry_at=NULL,error=NULL WHERE id=$1 AND processing_token=$2', [o.id, o.processing_token]);
          continue;
        }

        const embedded = source ? await source.documents(o.cad_num) : extractDocs(item, o.cad_num);
        const urls = findFileUrls(item);
        // A response may mix embedded originals with separately downloadable
        // graphics. Validate the whole candidate list before any new send;
        // a bounded incomplete packet must never become a successful prefix.
        if (new Set(embedded.map(originalHash)).size + urls.length > MAX_DOCUMENT_FILES) throw Object.assign(new Error('Поставщик передал больше 32 файлов или ссылок на оригиналы. Полный комплект не подтверждён.'), { code: 'EGRN_SOURCE_FILES' });
        if (!embedded.length && !urls.length) {
          await saveFailure(o, ['файлы не найдены в ответе API'], false, o.file_msgs || []);
          continue;
        }
        const fileMsgs = Array.isArray(o.file_msgs) ? o.file_msgs.slice() : [];
        // Retain confirmed ACKs for the failure checkpoint as well. The
        // inflight marker still requires explicit review if that write fails.
        o.file_msgs = fileMsgs;
        await verifyPartialRecords(o, fileMsgs);
        const embeddedKeys = [...new Set(embedded.map(file => matchingOriginal(file, fileMsgs).key))];
        const manifest = embeddedKeys.concat(urls.map((_, index) => 'pending-url:' + index));
        await pool.query('UPDATE egrn_orders SET delivery_manifest=$1 WHERE id=$2 AND processing_token=$3', [JSON.stringify(manifest), o.id, o.processing_token]);
        o.delivery_manifest = manifest;
        const deliveryErrors = [];
        let permanent = false;
        function fileError(e, name, size) {
          console.error('egrn file:', JSON.stringify({ order_id: o.id, id_statement: o.id_statement,
            filename: name, bytes: size, error: e.message,
            delivery_stage: e.delivery_stage, failure_code: e.failure_code, constraint: e.constraint,
            provider_code: e.provider_code, provider_status: e.provider_status }));
          deliveryErrors.push(String(e.message || 'ошибка доставки'));
          if (e.code === 'EGRN_RECIPIENT_UNAVAILABLE' || e.failure_code === 'EGRN_RECIPIENT_UNAVAILABLE') o.recipient_unavailable = true;
          if (e.uncertain === true) throw e;
          if (e.code === 'EGRN_FILE_TOO_LARGE' || e.code === 'EGRN_FILE_TYPE') permanent = true;
        }
        const caption = '📄 Выписка ЕГРН ' + o.cad_num + (o.label ? ' — ' + o.label : '');
        // PDF — в чат; XML и архив — тоже в чат, но без звука, для архива и будущего разбора
        for (const [index, original] of embedded.entries()) {
          let d = original;
          try {
            const { existing, key, hash } = matchingOriginal(d, fileMsgs); d.sha256 = hash;
            if (existing) { if (existing.kind === 'link') await largeDelivery(o).retry(o, existing, fileMsgs); continue; }
            if (documentBytes(d) > MAX_DOCUMENT_BYTES) { await largeDelivery(o).deliver(o, d, key, fileMsgs); continue; }
            d = await smallDocument(d);
            checkDocumentSize(d.buf);
            await registerOriginal(o.deliver, d);
            const extra = { caption: d.kind === 'pdf' ? caption : (d.kind === 'xml' ? 'XML ' : 'Архив ') + o.cad_num, disable_notification: d.kind !== 'pdf' };
            if (o.status_msg_id) extra.reply_parameters = { message_id: Number(o.status_msg_id), allow_sending_without_reply: true };
            await renewDelivery(o);
            let m, chat;
            try { const sent=await sendNativePrimary(o,d,key,extra);m=sent.message;chat=sent.chat; }
            catch (error) { if (!documentTooLarge(error)) throw error; await largeDelivery(o).deliver(o, d, key, fileMsgs); continue; }
            if (m && m.message_id) {
              const record = documentRecord(m, chat, key, d);
              fileMsgs.push(record);
              await persistFileRecords(o, fileMsgs);
            }
          } catch (e) {
            fileError(e, d.name, documentBytes(d));
          }
        }
        for (const [index, u] of urls.entries()) {
          let f;
          try {
            f = await download(u);
            const { existing, key, hash } = matchingOriginal(f, fileMsgs); f.sha256 = hash;
            manifest[embeddedKeys.length + index] = key;
            await pool.query('UPDATE egrn_orders SET delivery_manifest=$1 WHERE id=$2 AND processing_token=$3', [JSON.stringify([...new Set(manifest)]), o.id, o.processing_token]);
            o.delivery_manifest = [...new Set(manifest)];
            if (existing) { if (existing.kind === 'link') await largeDelivery(o).retry(o, existing, fileMsgs); continue; }
            if (documentBytes(f) > MAX_DOCUMENT_BYTES) { await largeDelivery(o).deliver(o, f, key, fileMsgs); continue; }
            f = await smallDocument(f);
            checkDocumentSize(f.buf);
            await registerOriginal(o.deliver, f);
            const extra = { caption: caption.slice(0, 1000) };
            if (o.status_msg_id) extra.reply_parameters = { message_id: Number(o.status_msg_id), allow_sending_without_reply: true };
            await renewDelivery(o);
            let m, chat;
            try { const sent=await sendNativePrimary(o,f,key,extra);m=sent.message;chat=sent.chat; }
            catch (error) { if (!documentTooLarge(error)) throw error; await largeDelivery(o).deliver(o, f, key, fileMsgs); continue; }
            if (m && m.message_id) {
              const record = documentRecord(m, chat, key, f);
              fileMsgs.push(record);
              await persistFileRecords(o, fileMsgs);
            }
          } catch (e) {
            fileError(e, f ? f.name : 'download', f ? documentBytes(f) : null);
          } finally { if (f?.cleanup) await f.cleanup(); }
        }
        if (!deliveryErrors.length && fileMsgs.length) {
          for (const record of fileMsgs) if (record.kind !== 'link') {
            try { await deliverNativeRecord(o, record, fileMsgs); }
            catch (error) { fileError(error, record.name || 'original', record.bytes); }
          }
        }
        if (deliveryErrors.length) await saveFailure(o, deliveryErrors, permanent, fileMsgs);
        else if (fileMsgs.length && manifest.every(key => fileMsgs.some(file => file.key === key))) await markDelivered(o, fileMsgs);
        else await saveFailure(o, ['Не подтверждена доставка всех оригиналов выписки.'], false, fileMsgs);
      } catch (e) {
        console.error('egrn status', o.id_statement, e.message,
          JSON.stringify({ source_code: e.source_code, source_name: e.source_name, source_bytes: e.source_bytes }));
        if (e.code === 'EGRN_LEGACY_FILE_IDENTITY') o.identity_unconfirmed = true;
        if (e.code === 'EGRN_SOURCE_FILES') o.file_limit_exceeded = true;
        if(e.uncertain===true)o.delivery_unknown=true;
        if(e.code==='EGRN_RECIPIENT_UNAVAILABLE'||e.failure_code==='EGRN_RECIPIENT_UNAVAILABLE')o.recipient_unavailable=true;
        if (e.code !== 'EGRN_LEASE_LOST') await saveFailure(o, [String(e.message || 'ошибка проверки статуса')], e.uncertain===true||['EGRN_FILE_TOO_LARGE', 'EGRN_LEGACY_FILE_IDENTITY', 'EGRN_SOURCE_FILES'].includes(e.code), o.file_msgs || []);
      } finally {
        try { if (source) await source.cleanup(); } finally { await lease.close(); }
      }
    }
  }
  // Support operation only: redeliver a known ready order, never apiOrder().
  // Keep the poll guard while resetting the backoff and processing this row.
  bot.command('egrn_retry', async function (ctx) {
    if (ctx.chat?.type !== 'private') return ctx.reply('Повтор доставки доступен в личном чате с ботом.');
    if (!(await canOrder(ctx.from.id, ctx.chat.id))) return ctx.reply('Нет доступа. Нажмите /start.');
    const match = String(ctx.message?.text || '').match(/^\/egrn_retry(?:@[a-z\d_]+)?\s+([1-9]\d{0,14})\s*$/i);
    if (!match) return ctx.reply('Укажите номер уже готового заказа: /egrn_retry номер. Новый заказ не создаётся.');
    const ownsPollGuard = !polling;
    if (ownsPollGuard) polling = true;
    try {
      await ensureTables();
      // Even a command received while another delivery is busy must consume
      // its cursor. Replaying it later cannot authorize a newer unknown send.
      const decision = await telegramDelivery().retry(match[1],ctx.from.id,ctx.message?.message_id,{consumeOnly:!ownsPollGuard});
      if (decision.state==='replayed') return ctx.reply('Эта команда уже обработана. Проверьте сообщения в чате; для нового разрешения повтора отправьте новую команду.');
      if (decision.state==='busy') return ctx.reply('Доставка этой выписки уже выполняется. Повторите команду после её завершения.');
      if (decision.state==='admin_required') return ctx.reply('Результат прошлой отправки не подтверждён. Проверьте сообщения в чате; повтор может разрешить администратор новой командой /egrn_retry.');
      if (decision.state==='invalid') return ctx.reply('Не удалось подтвердить сообщение команды. Отправьте новую команду /egrn_retry.');
      if (decision.state!=='ready') return ctx.reply('Нет готовой недоставленной выписки с таким номером за последние 30 дней.');
      const order = decision.order;
      await ctx.reply('Разрешён повтор доставки готовой выписки. Проверьте ранее полученные сообщения: при потерянном ответе Telegram возможен повтор файла. Новый платный заказ не создаётся.');
      await pollOrders(order.id);
      const latest = (await pool.query('SELECT files_sent FROM egrn_orders WHERE id=$1', [order.id])).rows[0];
      await ctx.reply(latest?.files_sent > 0 ? 'Выписка доставлена.' : 'Доставка пока не завершена. Проверьте сообщения в чате и причину в уведомлении; новый платный заказ не создавался.');
    } catch (error) {
      console.error('egrn retry:', /^[a-z\d_]{1,80}$/i.test(String(error.code || '')) ? error.code : 'unavailable');
      await ctx.reply('Не удалось повторить доставку. Новый платный заказ не создавался.');
    } finally { if (ownsPollGuard) polling = false; }
  });
  setTimeout(poll, 30 * 1000);
  setInterval(poll, 3 * 60 * 1000);
}

async function checkCopyTarget(options, destination) {
  if (typeof options.beforeSend !== 'function') return;
  try { await options.beforeSend(destination); }
  catch (error) {
    const blocked = error && typeof error === 'object' ? error : new Error('Получатель выписки сейчас недоступен.');
    blocked.uncertain = false; blocked.delivery_stage = 'validation'; throw blocked;
  }
}
async function copyNativeOriginal(record, destination, options) {
  const copy = () => telegramDelivery().send(options.deliveryOrder, {kind:'native-copy',key:sourceKey(record),target:destination}, async recheck => {
    await checkCopyTarget(options, destination);
    const accounting=options.budgetText ? await messageBudgetText(destination.chat) : '';
    await checkCopyTarget(options,destination);
    if(recheck)await recheck();
    // Override the source caption in the measurements chat so a cached copy
    // cannot inherit accounting text from the EGRN chat's original.
    return tgApi.callApi('copyMessage', Object.assign({ chat_id: destination.chat, from_chat_id: record.chat, message_id: record.id },
      options.budgetText || isMeasurementsChat(destination.chat) ? { caption: budgetCaption('📄 ' + String(record.name || 'Выписка ЕГРН'), accounting) } : {},
      destination.reply ? { reply_parameters: { message_id: Number(destination.reply), allow_sending_without_reply: true } } : {}));
  });
  try { return await copy(); }
  catch (error) {
    const missing = Number(error.response?.error_code) === 400 && /message to copy not found/i.test(error.response?.description || error.message || '');
    if (!missing || typeof record.file_id !== 'string' || !record.file_id || typeof tgApi.sendDocument !== 'function') throw error;
    // A deleted message does not delete Telegram's reusable original. Repair
    // only this exact file and retain its original reference identity.
    const originChat = record.chat, originId = record.id, key = sourceKey(record);
    let repairChat = /^-100[1-9]\d+$/.test(String(destination.chat)) ? destination.chat : originChat;
    if (options.deliveryOrder) try { await telegramDelivery().authorize(options.deliveryOrder,{chat:repairChat}); }
    catch (failure) {
      if(failure.code!=='EGRN_RECIPIENT_UNAVAILABLE')throw failure;
      repairChat=destination.chat;
    }
    const sameChat = String(repairChat) === String(destination.chat);
    const extra = { disable_notification: true };
    if (sameChat && destination.reply) extra.reply_parameters = { message_id: Number(destination.reply), allow_sending_without_reply: true };
    const repaired = await telegramDelivery().send(options.deliveryOrder,{kind:'native-repair',key,target:{chat:repairChat,...(sameChat&&destination.case_id!=null?{case_id:destination.case_id}:{})}},async recheck=>{
      await checkCopyTarget(options,destination);
      extra.caption=budgetCaption('📄 '+String(record.name||'Выписка ЕГРН').slice(0,220),options.budgetText?await messageBudgetText(repairChat):'');
      await checkCopyTarget(options,destination);
      if(recheck)await recheck();
      return tgApi.sendDocument(repairChat,record.file_id,extra);
    });
    if (!Number.isSafeInteger(Number(repaired?.message_id)) || Number(repaired.message_id) < 1)
      throw Object.assign(new Error('Telegram не подтвердил восстановление оригинала выписки.'), { code: 'EGRN_COPY_SOURCE_RECEIPT', uncertain: true });
    record.reference_chat ??= originChat; record.reference_id ??= originId;
    record.key ||= key; record.chat = repairChat; record.id = Number(repaired.message_id);
    if (repaired.document?.file_id) record.file_id = repaired.document.file_id;
    try { if (options.onSourceRepaired) await options.onSourceRepaired(record); }
    catch (failure) { failure.uncertain = true; failure.code ||= 'EGRN_COPY_CHECKPOINT'; throw failure; }
    return sameChat ? repaired : await copy();
  }
}

async function copyFiles(fileMsgs, targets, options = {}) {
  options = { ...options, strict: options.strict !== false };
  if (!tgApi) {
    if (options.strict) throw Object.assign(new Error('Не удалось подключить доставку выписки.'), { code: 'EGRN_COPY_UNAVAILABLE', uncertain: false });
    return 0;
  }
  const confirmed = options.confirmed || {};
  let n = 0;
  for (const t of targets) {
    for (const fm of fileMsgs) {
      // A reply thread is not another recipient. Keep receipts stable when the
      // same case is resumed with a new card or a refreshed download URL.
      const key = JSON.stringify([String(t.chat), fm.key || String(fm.chat) + ':' + String(fm.id)]);
      if (confirmed[key] === true) continue;
      let stage = 'telegram';
      try {
        const message = fm.kind === 'link' ? await largeDelivery(options.deliveryOrder).copy(fm, t, { beforeSend: destination => checkCopyTarget(options, destination) }) : await copyNativeOriginal(fm, t, options);
        if (options.strict && !(fm.kind === 'link' && message === true) && (!Number.isSafeInteger(Number(message?.message_id)) || Number(message.message_id) < 1)) {
          throw Object.assign(new Error('Telegram не подтвердил доставку выписки.'), { code: 'EGRN_COPY_RECEIPT', uncertain: true });
        }
        // Persist each acknowledgement before attempting another original.
        // A failed receipt write must propagate even for legacy callers using
        // this opt-in callback; continuing would create untracked duplicates.
        stage = 'checkpoint';
        if (options.onCopied) await options.onCopied(key, message);
        if (options.strict || options.confirmed || options.onCopied) confirmed[key] = true;
        n++;
      } catch (e) {
        console.error('egrn copy:', fm.kind === 'link' ? 'Не удалось доставить ссылку на сохранённую выписку.' : options.strict ? 'Не удалось подтвердить доставку выписки.' : e.message);
        if (options.strict) {
          // Keep Telegram's explicit rejection intact. A lost response or a
          // lost database acknowledgement cannot safely be resent blindly.
          if (!e || typeof e !== 'object') e = new Error('Не удалось подтвердить доставку выписки.');
          if (stage === 'checkpoint') { e.uncertain = true; e.code ||= 'EGRN_COPY_CHECKPOINT'; }
          else if (typeof e.uncertain !== 'boolean') {
            const beforeSend = ['validation', 'storage', 'descriptor', 'signing'].includes(e.delivery_stage);
            e.uncertain = !beforeSend && !e.response && !/^TELEGRAM_\d+$/.test(String(e.failure_code || ''));
            e.code ||= 'EGRN_COPY_FAILED';
          }
        }
        if (fm.kind === 'link' || options.strict || options.onCopied) throw e;
      }
    }
  }
  return n;
}

// Для форм «Заявка на замер» и «Передать юристу»:
// есть свежая выписка — прикладываем сразу; нет и разрешён заказ — заказываем и доставим, когда будет готова.
// targets: [{ chat, reply, order_id? }] — order_id links originals to a visit request.
async function deliverCachedCopy(order, targets, copyOptions = {}) {
  const records = Array.isArray(order.file_msgs) ? order.file_msgs : [];
  const confirmed = { ...copyOptions.confirmed };
  for (const record of records) {
    const key = sourceKey(record);
    if (record.kind !== 'link' && record.chat && record.id) confirmed[JSON.stringify([String(record.chat), key])] = true;
    for (const receipt of Array.isArray(record.deliveries) ? record.deliveries : []) {
      if (receipt?.id) confirmed[JSON.stringify([String(receipt.chat), key])] = true;
    }
  }
  for (const target of targets) for (const record of records) {
    await renewDelivery(order);
    await copyFiles([record], [target], { ...copyOptions, deliveryOrder:order, budgetText: true, strict: true, confirmed,
      onSourceRepaired: () => persistFileRecords(order, records),
      async onCopied(key, message) {
        if (message?.message_id) {
          const chat = JSON.parse(key)[0];
          record.deliveries ||= [];
          record.deliveries.push({ chat, id: Number(message.message_id),
            ...(record.kind==='link'&&Number.isSafeInteger(Number(target.reply))&&Number(target.reply)>0 ? {reply:Number(target.reply)} : {}) });
          await persistFileRecords(order, records);
        }
        if (copyOptions.onCopied) await copyOptions.onCopied(key, message);
      }
    });
  }
  return records;
}

function uncertainOrder(order, cad) {
  return { result: 'uncertain', cad, id: order.id_statement || null,
    packet_warning: 'Результат заказа выписки по ' + cad + ' требует проверки у поставщика. ' +
      'Проверьте личный кабинет https://armrus.org и передайте администратору номер заказа. ' +
      'Номер записи бота: ' + order.id + '. Повторный платный заказ не создан.' };
}

async function attachOrOrder(opts) {
  const cad = (String(opts.cad || '').match(CAD_RE) || [])[0];
  if (!cad) return { result: 'none' };
  await ensureTables();
  let prev;
  if (!opts.force) prev = (await pool.query(
    "SELECT * FROM egrn_orders WHERE cad_num=$1 AND type_doc=$2 AND status <> 'failed' AND created_at > NOW() - INTERVAL '30 days' ORDER BY id DESC LIMIT 1",
    [cad, TYPE_DOC])).rows[0];
  if (!prev) {
    if (!opts.order || !configured()) return budgetResult({ result: 'none', cad });
    const reservation = await reserveOrder(cad, opts);
    prev = reservation.order;
    if (reservation.created) {
      const order = await placeReservedOrder(prev);
      order.budget_text = await budgetText(order);
      if (tgApi && order.chat_id) {
        try {
          order.budget_text=await messageBudgetText(order.chat_id);
          await telegramDelivery().authorize(order,{chat:order.chat_id});
          const message = await tgApi.sendMessage(order.chat_id, cardText(order, opts.note ? esc(opts.note) : ''), { parse_mode: 'HTML' });
          await pool.query('UPDATE egrn_orders SET status_msg_id=$1 WHERE id=$2', [message.message_id, order.id]);
        } catch (error) { console.error('egrn card:', error.message); }
      }
      return { result: 'ordered', cad, id: order.id_statement, budget_text: await readBudgetText() };
    }
  }
  if (prev.status === 'ordering' && Date.now() - new Date(prev.created_at).getTime() > 2 * 60 * 1000) {
    prev = (await pool.query("UPDATE egrn_orders SET status='order_unknown',status_text='Заказ требует проверки у поставщика',updated_at=NOW() WHERE id=$1 AND status='ordering' RETURNING *", [prev.id])).rows[0] || prev;
  }
  if (prev.status === 'order_unknown') return budgetResult(uncertainOrder(await mergeTargets(prev, opts.targets), cad), prev);
  if (prev.status === 'ordering') { await mergeTargets(prev, opts.targets); return budgetResult({ result: 'waiting', cad }, prev); }
  if (prev.status === 'failed') return budgetResult({ result: 'unavailable', cad, id: prev.id_statement }, prev);
  if (prev.delivery_state?.inflight && new Date(prev.processing_until).getTime()>Date.now()) {
    await mergeTargets(prev,opts.targets);
    return budgetResult({result:'waiting',cad},prev);
  }
  telegramDelivery().assertAvailable(prev);
  if ((prev.files_sent > 0 || hasReusableFiles(prev)) && Array.isArray(prev.file_msgs) && prev.file_msgs.length) {
    const wasComplete = prev.files_sent > 0;
    prev = await mergeTargets(prev, opts.targets);
    const leased = await claimDelivery(prev.id);
    if (!leased) return budgetResult({ result: 'waiting', cad }, prev);
    const lease = keepDeliveryAlive(leased);
    try {
      telegramDelivery().assertAvailable(leased);
      leased.budget_text = await budgetText(leased);
      if (!Array.isArray(leased.delivery_manifest) || !leased.delivery_manifest.length) {
        leased.delivery_manifest = [...new Set(leased.file_msgs.map(sourceKey))];
        await pool.query('UPDATE egrn_orders SET delivery_manifest=$1 WHERE id=$2 AND processing_token=$3', [JSON.stringify(leased.delivery_manifest), leased.id, leased.processing_token]);
      }
      const records = await deliverCachedCopy(leased, opts.targets || [], opts.copyOptions);
      if ((leased.deliver || []).some(target => target && target.order_id) && records.some(file => file.kind === 'link' || Number(file.bytes)>12*1024*1024)) await require('../web/order-egrn-links').registerOrderLinks(leased, records);
      let packet = {};
      // Medium originals already belong to the packet through Telegram refs.
      // Only small originals need another byte copy in order_materials.
      const smallOriginals = records.filter(file => file.kind !== 'link' && !(Number(file.bytes) > 12 * 1024 * 1024));
      if ((opts.targets || []).some(target => target && target.order_id) && smallOriginals.length) {
        try { packet = await require('./order-evidence').registerCached(opts.targets, smallOriginals, tgApi); }
        catch (error) { console.error('egrn packet: original unavailable'); packet = { packet_warning: 'Оригинал выписки не добавлен к документам заявки. Прикрепите его к заявке.' }; }
      }
      // The cached order was already complete before these targets joined.
      // Only this generation may be acknowledged; another join leaves it open.
      if (wasComplete) await markDelivered(leased, records);
      return { result: 'attached', cad, ...packet, budget_text: await readBudgetText() };
    } finally { await lease.close(); }
  }
  if (prev.files_sent < 0) return budgetResult({ result: 'unavailable', cad, id: prev.id_statement }, prev);
  await mergeTargets(prev, opts.targets);
  return budgetResult({ result: 'waiting', cad }, prev);
}

module.exports = { setupEgrn, parseCads, readStatus, findFileUrls, findReq, attachOrOrder, CAD_RE, extractDocs, unzip, stripB64 };
