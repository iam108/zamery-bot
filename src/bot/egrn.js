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
const MAX_FAILURES = 5;
const REQUEST_TIMEOUT_MS = 60 * 1000;

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

function documentRecord(message, chat, key, file) {
  const record = { chat: Number(chat), id: message.message_id, key: key };
  if (message.document && message.document.file_id) {
    record.file_id = message.document.file_id;
    record.name = file.name;
    record.mime = message.document.mime_type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : /\.zip$/i.test(file.name) ? 'application/zip' : 'application/octet-stream');
    record.bytes = file.buf.length;
  }
  return record;
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
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Authorization-Token': process.env.EGRN_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cad_num: cad, type_doc: typeDoc, id_declarant: parseInt(process.env.EGRN_DECLARANT_ID) || process.env.EGRN_DECLARANT_ID }),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok || !j || !j.id_statement) throw new Error('API ' + r.status + ': ' + String(text).slice(0, 200));
  return j.id_statement;
}

function authHeaders() {
  const h = {};
  if (process.env.EGRN_LOGIN) h['Authorization-Login'] = process.env.EGRN_LOGIN;
  if (process.env.EGRN_PASSWORD) h['Authorization-Password'] = process.env.EGRN_PASSWORD;
  if (process.env.EGRN_TOKEN) h['Authorization-Token'] = process.env.EGRN_TOKEN;
  return h;
}

async function apiStatus(idReq) {
  const r = await fetch(API + '?id_req=' + encodeURIComponent(idReq), { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok || !j) throw new Error('API ' + r.status + ': ' + String(text).slice(0, 200));
  return j;
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
    if (method === 0) data = comp; else if (method === 8) data = zlib.inflateRawSync(comp);
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
  const r = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!r.ok) throw new Error('download ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  let name = '';
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) { try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; } }
  if (!name) name = decodeURIComponent((url.split('?')[0].split('/').pop() || 'vypiska'));
  if (!/\.[a-z0-9]{2,4}$/i.test(name)) {
    const ct = r.headers.get('content-type') || '';
    name += /pdf/.test(ct) ? '.pdf' : /zip/.test(ct) ? '.zip' : /xml/.test(ct) ? '.xml' : '';
  }
  return { buf: buf, name: name };
}

function cardText(o, extra) {
  const t = TYPES[o.type_doc] || { short: o.type_doc, icon: '📄' };
  const icon = o.status === 'done' ? '✅' : o.status === 'failed' ? '❌' : '⏳';
  return icon + ' <b>Выписка ЕГРН ' + t.short + '</b>\n' +
    '<code>' + esc(o.cad_num) + '</code>' + (o.label ? ' — ' + esc(o.label) : '') + '\n' +
    'Статус: ' + esc(o.status_text || 'заказана') + (o.id_statement ? ' · заявка №' + o.id_statement : '') + '\n' +
    'Заказал(а): ' + esc(o.ordered_name || '') + (extra ? '\n' + extra : '');
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

      // Уже заказывали за 30 дней?
      if (!ctx.match[3]) {
        const prev = (await pool.query(
          "SELECT * FROM egrn_orders WHERE cad_num=$1 AND type_doc=$2 AND status <> 'failed' AND created_at > NOW() - INTERVAL '30 days' ORDER BY id DESC LIMIT 1",
          [p.cad_num, typeDoc])).rows[0];
        if (prev) {
          await ctx.answerCbQuery();
          return ctx.reply('Выписку по ' + p.cad_num + ' уже заказывали ' + new Date(prev.created_at).toLocaleDateString('ru-RU') + ' (' + (prev.ordered_name || '') + '), статус: ' + (prev.status_text || prev.status) + '. Заказать ещё раз?', {
            reply_markup: { inline_keyboard: [[{ text: 'Да, заказать ещё раз', callback_data: 'eg:' + p.id + ':' + ctx.match[2] + ':force' }]] },
          });
        }
      }
      await ctx.answerCbQuery('Заказываю…');
      const idSt = await apiOrder(p.cad_num, typeDoc);
      const target = CHAT() || ctx.from.id;
      const o = (await pool.query(
        "INSERT INTO egrn_orders (cad_num, label, type_doc, ordered_by, ordered_name, id_statement, status, status_text, chat_id) VALUES ($1,$2,$3,$4,$5,$6,'ordered','заказана',$7) RETURNING *",
        [p.cad_num, p.label, typeDoc, ctx.from.id, nameOf(ctx.from), idSt, target])).rows[0];
      const opts = { parse_mode: 'HTML' };
      if (String(p.chat_id) === String(target) && p.src_msg_id) opts.reply_to_message_id = Number(p.src_msg_id);
      let msg;
      try { msg = await ctx.telegram.sendMessage(target, cardText(o), opts); }
      catch (e) { delete opts.reply_to_message_id; msg = await ctx.telegram.sendMessage(target, cardText(o), opts); }
      await pool.query('UPDATE egrn_orders SET status_msg_id=$1 WHERE id=$2', [msg.message_id, o.id]);
      if (String(target) !== String(ctx.from.id)) {
        try { await ctx.telegram.sendMessage(ctx.from.id, '⏳ Выписка по ' + p.cad_num + ' заказана (№' + idSt + '). Пришлю, когда будет готова.'); } catch (e) {}
      }
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
    const text = o.status === 'done'
      ? '⚠️ Выписка готова, но ' + (tooLarge ? 'файл слишком большой для отправки в Telegram.' : 'не все файлы удалось доставить после нескольких попыток.')
      : '⚠️ Не удалось проверить готовность выписки после нескольких попыток.';
    const fallback = '\nСкачайте выписку или проверьте заявку №' + o.id_statement + ' в личном кабинете: https://armrus.org';
    if (o.status_msg_id) {
      try { await bot.telegram.editMessageText(o.chat_id, Number(o.status_msg_id), undefined, cardText(o, text + fallback), { parse_mode: 'HTML' }); }
      catch (e) { console.error('egrn notification:', o.id_statement, e.message); }
    }
    // Личное уведомление — только заказавшему сотруднику, без технических ошибок и ссылок с токенами.
    const target = o.ordered_by || o.chat_id;
    if (target) {
      try { await bot.telegram.sendMessage(target, text + '\nКадастровый номер: ' + o.cad_num + fallback); }
      catch (e) { console.error('egrn notification:', o.id_statement, e.message); }
    }
  }

  async function saveFailure(o, errors, permanent, fileMsgs) {
    const failures = (o.failures || 0) + 1;
    const stopped = permanent || failures >= MAX_FAILURES;
    const retryAt = stopped ? null : new Date(Date.now() + 3 * 60 * 1000 * Math.pow(2, failures - 1));
    await pool.query('UPDATE egrn_orders SET files_sent=$1, file_msgs=$2, error=$3, failures=$4, retry_at=$5, updated_at=NOW() WHERE id=$6',
      [stopped ? -1 : 0, JSON.stringify(fileMsgs), errors.join('; ').slice(0, 300), failures, retryAt, o.id]);
    if (stopped) await notifyStopped(o, permanent);
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

  async function pollOrders() {
    let rows = [];
    try {
      rows = (await pool.query("SELECT * FROM egrn_orders WHERE status IN ('ordered','done') AND files_sent = 0 AND (retry_at IS NULL OR retry_at <= NOW()) AND created_at > NOW() - INTERVAL '" + MAX_POLL_HOURS + " hours' ORDER BY id LIMIT 20")).rows;
    } catch (e) { return console.error('egrn poll:', e.message); }
    for (const o of rows) {
      try {
        const j = await apiStatus(o.id_statement);
        const item = findReq(j, o.id_statement);
        const st = readStatus(item);
        const newStatus = st.failed ? 'failed' : st.done ? 'done' : 'ordered';
        const changed = newStatus !== o.status || st.text !== o.status_text;
        await pool.query('UPDATE egrn_orders SET status=$1, status_text=$2, raw=$3, polls=polls+1, updated_at=NOW() WHERE id=$4', [newStatus, st.done && !/выполн/i.test(st.text) ? 'готова' : st.text, stripB64(item), o.id]);
        if (st.done && !/выполн/i.test(st.text)) st.text = 'готова';
        Object.assign(o, { status: newStatus, status_text: st.text, polls: o.polls + 1 });
        if (changed && o.status_msg_id) {
          try { await bot.telegram.editMessageText(o.chat_id, Number(o.status_msg_id), undefined, cardText(o), { parse_mode: 'HTML' }); } catch (e) {}
        }
        if (newStatus === 'failed') {
          await pool.query('UPDATE egrn_orders SET files_sent = -1 WHERE id=$1', [o.id]);
          try { await bot.telegram.sendMessage(o.ordered_by, '❌ Выписка по ' + o.cad_num + ' не выполнена: ' + st.text); } catch (e) {}
          continue;
        }
        if (newStatus !== 'done') {
          await pool.query('UPDATE egrn_orders SET failures=0, retry_at=NULL, error=NULL WHERE id=$1', [o.id]);
          continue;
        }

        const embedded = extractDocs(item, o.cad_num);
        const urls = embedded.length ? [] : findFileUrls(item);
        if (!embedded.length && !urls.length) {
          await saveFailure(o, ['файлы не найдены в ответе API'], false, o.file_msgs || []);
          continue;
        }
        let sent = 0;
        const deliveryErrors = [];
        let permanent = false;
        const fileMsgs = Array.isArray(o.file_msgs) ? o.file_msgs.slice() : [];
        const newlySent = [];
        function fileError(e, name, size) {
          console.error('egrn file:', JSON.stringify({ order_id: o.id, id_statement: o.id_statement,
            filename: name, bytes: size, error: e.message }));
          deliveryErrors.push(String(e.message || 'ошибка доставки'));
          if (documentTooLarge(e)) permanent = true;
        }
        const caption = '📄 Выписка ЕГРН ' + o.cad_num + (o.label ? ' — ' + o.label : '');
        // PDF — в чат; XML и архив — тоже в чат, но без звука, для архива и будущего разбора
        for (const [index, d] of embedded.entries()) {
          const key = 'embedded:' + index + ':' + d.name;
          if (fileMsgs.some(function (f) { return f.key === key; })) continue;
          try {
            checkDocumentSize(d.buf);
            await registerOriginal(o.deliver, d);
            const extra = { caption: d.kind === 'pdf' ? caption.slice(0, 1000) : (d.kind === 'xml' ? 'XML ' + o.cad_num : 'Архив ' + o.cad_num), disable_notification: d.kind !== 'pdf' };
            if (o.status_msg_id) extra.reply_to_message_id = Number(o.status_msg_id);
            const m = await bot.telegram.sendDocument(o.chat_id, { source: d.buf, filename: d.name }, extra);
            if (m && m.message_id && d.kind !== 'xml') {
              const record = documentRecord(m, o.chat_id, key, d);
              fileMsgs.push(record); newlySent.push(record);
            }
            if (d.kind === 'pdf' || d.kind === 'zip') sent++;
          } catch (e) {
            fileError(e, d.name, d.buf.length);
          }
        }
        for (const [index, u] of urls.slice(0, 6).entries()) {
          const key = 'url:' + index;
          if (fileMsgs.some(function (f) { return f.key === key; })) continue;
          let f;
          try {
            f = await download(u);
            checkDocumentSize(f.buf);
            await registerOriginal(o.deliver, f);
            const extra = { caption: caption.slice(0, 1000) };
            if (o.status_msg_id) extra.reply_to_message_id = Number(o.status_msg_id);
            const m = await bot.telegram.sendDocument(o.chat_id, { source: f.buf, filename: f.name }, extra);
            if (m && m.message_id) {
              const record = documentRecord(m, o.chat_id, key, f);
              fileMsgs.push(record); newlySent.push(record);
            }
            sent++;
          } catch (e) {
            fileError(e, f ? f.name : 'download', f ? f.buf.length : null);
          }
        }
        if (deliveryErrors.length) {
          await saveFailure(o, deliveryErrors, permanent, fileMsgs);
        } else if (sent || fileMsgs.length) {
          await pool.query('UPDATE egrn_orders SET files_sent=$1, file_msgs=$2, error=$3, failures=0, retry_at=NULL WHERE id=$4',
            [fileMsgs.length || sent, JSON.stringify(fileMsgs), null, o.id]);
        }
        if (sent) {
          // копии: заказавшему и туда, куда выписку ждут (заявка на замер, юрист, «Заявки по клиенту»)
          const targets = (Array.isArray(o.deliver) ? o.deliver : []).slice();
          if (String(o.ordered_by) !== String(o.chat_id) && !targets.some(function (t) { return String(t.chat) === String(o.ordered_by); })) targets.push({ chat: Number(o.ordered_by) });
          await copyFiles(newlySent, targets);
        }
      } catch (e) {
        console.error('egrn status', o.id_statement, e.message);
        await saveFailure(o, [String(e.message || 'ошибка проверки статуса')], false, o.file_msgs || []);
      }
    }
  }
  setTimeout(poll, 30 * 1000);
  setInterval(poll, 3 * 60 * 1000);
}

async function copyFiles(fileMsgs, targets) {
  if (!tgApi) return 0;
  let n = 0;
  for (const t of targets) {
    for (const fm of fileMsgs) {
      try {
        await tgApi.callApi('copyMessage', Object.assign({ chat_id: t.chat, from_chat_id: fm.chat, message_id: fm.id },
          t.reply ? { reply_parameters: { message_id: Number(t.reply), allow_sending_without_reply: true } } : {}));
        n++;
      } catch (e) { console.error('egrn copy:', e.message); }
    }
  }
  return n;
}

// Для форм «Заявка на замер» и «Передать юристу»:
// есть свежая выписка — прикладываем сразу; нет и разрешён заказ — заказываем и доставим, когда будет готова.
// targets: [{ chat, reply, order_id? }] — order_id links originals to a visit request.
async function attachOrOrder(opts) {
  const cad = (String(opts.cad || '').match(CAD_RE) || [])[0];
  if (!cad) return { result: 'none' };
  await ensureTables();
  const prev = (await pool.query(
    "SELECT * FROM egrn_orders WHERE cad_num=$1 AND type_doc=$2 AND status <> 'failed' AND created_at > NOW() - INTERVAL '30 days' ORDER BY id DESC LIMIT 1",
    [cad, TYPE_DOC])).rows[0];
  if (prev && prev.files_sent > 0 && Array.isArray(prev.file_msgs) && prev.file_msgs.length) {
    await copyFiles(prev.file_msgs, opts.targets || []);
    let packet = {};
    if ((opts.targets || []).some(t => t && t.order_id)) {
      try { packet = await require('./order-evidence').registerCached(opts.targets, prev.file_msgs, tgApi); }
      catch (e) { console.error('egrn packet: original unavailable'); packet = { packet_warning: 'Оригинал выписки не добавлен к документам заявки. Прикрепите его к заявке.' }; }
    }
    return { result: 'attached', cad: cad, ...packet };
  }
  if (prev && prev.files_sent < 0) {
    // Остановка доставки не означает, что нужно повторно оплачивать выписку.
    return { result: 'unavailable', cad: cad, id: prev.id_statement };
  }
  if (prev && prev.status !== 'failed' && prev.files_sent >= 0) {
    // уже заказана и ещё не готова — просто добавляем получателей
    const merged = (Array.isArray(prev.deliver) ? prev.deliver : []).concat(opts.targets || []);
    await pool.query('UPDATE egrn_orders SET deliver=$1 WHERE id=$2', [JSON.stringify(merged), prev.id]);
    return { result: 'waiting', cad: cad };
  }
  if (!opts.order || !configured()) return { result: 'none', cad: cad };
  const idSt = await apiOrder(cad, TYPE_DOC);
  const target = process.env.EGRN_CHAT_ID || opts.orderedBy;
  const o = (await pool.query(
    "INSERT INTO egrn_orders (cad_num, label, type_doc, ordered_by, ordered_name, id_statement, status, status_text, chat_id, deliver) VALUES ($1,$2,$3,$4,$5,$6,'ordered','заказана',$7,$8) RETURNING *",
    [cad, opts.label || '', TYPE_DOC, opts.orderedBy, opts.orderedName || '', idSt, target, JSON.stringify(opts.targets || [])])).rows[0];
  if (tgApi && target) {
    try {
      const m = await tgApi.sendMessage(target, cardText(o, opts.note ? esc(opts.note) : ''), { parse_mode: 'HTML' });
      await pool.query('UPDATE egrn_orders SET status_msg_id=$1 WHERE id=$2', [m.message_id, o.id]);
    } catch (e) { console.error('egrn card:', e.message); }
  }
  return { result: 'ordered', cad: cad, id: idSt };
}

module.exports = { setupEgrn, parseCads, readStatus, findFileUrls, findReq, attachOrOrder, CAD_RE, extractDocs, unzip, stripB64 };
