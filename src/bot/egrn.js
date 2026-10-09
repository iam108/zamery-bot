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
  const r = await fetch(API + '?id_req=' + encodeURIComponent(idReq), { headers: authHeaders() });
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

function readStatus(item) {
  const st = Array.isArray(item && item.status) ? item.status : [];
  const types = st.map(function (s) { return String(s.type || '') + ' ' + String(s.statusDescription || ''); }).join(' | ');
  const done = /processed|выполнено/i.test(types);
  const failed = !done && /reject|error|fail|cancel|denied|отказ|ошибк|отклон/i.test(types);
  // самый свежий статус — с наибольшим id_status
  const last = st.slice().sort(function (a, b) { return (b.id_status || 0) - (a.id_status || 0); })[0];
  const human = last ? String(last.statusDescription || last.type || '').replace(/^в статусе\s*/i, '').replace(/['"«»]/g, '') : 'отправлена';
  return { done: done, failed: failed, text: human, kuvd: last && last.kuvdNumbers };
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
  const r = await fetch(url, { headers: authHeaders() });
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
    return [{ text: '📄 Заказать выписку', callback_data: 'eg:' + pid + ':kv' }];
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
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Заказано: ' + nameOf(ctx.from), callback_data: 'noop' }]] }); } catch (e) {}
    } catch (e) {
      console.error('egrn order:', e.message);
      try { await ctx.answerCbQuery('Не удалось заказать: ' + e.message.slice(0, 150), { show_alert: true }); } catch (x) {}
    }
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
  async function poll() {
    if (!configured()) return;
    let rows = [];
    try {
      rows = (await pool.query("SELECT * FROM egrn_orders WHERE status IN ('ordered','done') AND files_sent = 0 AND created_at > NOW() - INTERVAL '" + MAX_POLL_HOURS + " hours' ORDER BY id LIMIT 20")).rows;
    } catch (e) { return console.error('egrn poll:', e.message); }
    for (const o of rows) {
      try {
        const j = await apiStatus(o.id_statement);
        const item = findReq(j, o.id_statement);
        const st = readStatus(item);
        const newStatus = st.failed ? 'failed' : st.done ? 'done' : 'ordered';
        const changed = newStatus !== o.status || st.text !== o.status_text;
        await pool.query('UPDATE egrn_orders SET status=$1, status_text=$2, raw=$3, polls=polls+1, updated_at=NOW() WHERE id=$4', [newStatus, st.text, item, o.id]);
        Object.assign(o, { status: newStatus, status_text: st.text, polls: o.polls + 1 });
        if (changed && o.status_msg_id) {
          try { await bot.telegram.editMessageText(o.chat_id, Number(o.status_msg_id), undefined, cardText(o), { parse_mode: 'HTML' }); } catch (e) {}
        }
        if (newStatus === 'failed') {
          await pool.query('UPDATE egrn_orders SET files_sent = -1 WHERE id=$1', [o.id]);
          try { await bot.telegram.sendMessage(o.ordered_by, '❌ Выписка по ' + o.cad_num + ' не выполнена: ' + st.text); } catch (e) {}
          continue;
        }
        if (newStatus !== 'done') continue;

        const urls = findFileUrls(item);
        if (!urls.length) {
          // файлы иногда появляются не сразу — ждём ещё несколько опросов
          if (o.polls >= 10) {
            await pool.query("UPDATE egrn_orders SET files_sent = -1, error='файлы не найдены в ответе API' WHERE id=$1", [o.id]);
            const t = cardText(o, '⚠️ Готово, но файл не пришёл через API — посмотрите в кабинете armrus.org');
            try { await bot.telegram.editMessageText(o.chat_id, Number(o.status_msg_id), undefined, t, { parse_mode: 'HTML' }); } catch (e) {}
          }
          continue;
        }
        let sent = 0;
        const fileMsgs = [];
        const caption = '📄 Выписка ЕГРН ' + o.cad_num + (o.label ? ' — ' + o.label : '');
        for (const u of urls.slice(0, 6)) {
          try {
            const f = await download(u);
            const extra = { caption: caption.slice(0, 1000) };
            if (o.status_msg_id) extra.reply_to_message_id = Number(o.status_msg_id);
            const m = await bot.telegram.sendDocument(o.chat_id, { source: f.buf, filename: f.name }, extra);
            if (m && m.message_id) fileMsgs.push({ chat: Number(o.chat_id), id: m.message_id });
            sent++;
          } catch (e) { console.error('egrn file:', e.message); }
        }
        if (sent) {
          await pool.query('UPDATE egrn_orders SET files_sent=$1, file_msgs=$2 WHERE id=$3', [sent, JSON.stringify(fileMsgs), o.id]);
          // копии: заказавшему и туда, куда выписку ждут (заявка на замер, юрист, «Заявки по клиенту»)
          const targets = (Array.isArray(o.deliver) ? o.deliver : []).slice();
          if (String(o.ordered_by) !== String(o.chat_id) && !targets.some(function (t) { return String(t.chat) === String(o.ordered_by); })) targets.push({ chat: Number(o.ordered_by) });
          await copyFiles(fileMsgs, targets);
        }
      } catch (e) {
        console.error('egrn status', o.id_statement, e.message);
        await pool.query('UPDATE egrn_orders SET error=$1, polls=polls+1 WHERE id=$2', [e.message.slice(0, 300), o.id]);
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
// targets: [{ chat, reply }]
async function attachOrOrder(opts) {
  const cad = (String(opts.cad || '').match(CAD_RE) || [])[0];
  if (!cad) return { result: 'none' };
  await ensureTables();
  const prev = (await pool.query(
    "SELECT * FROM egrn_orders WHERE cad_num=$1 AND type_doc=$2 AND status <> 'failed' AND created_at > NOW() - INTERVAL '30 days' ORDER BY id DESC LIMIT 1",
    [cad, TYPE_DOC])).rows[0];
  if (prev && prev.files_sent > 0 && Array.isArray(prev.file_msgs) && prev.file_msgs.length) {
    await copyFiles(prev.file_msgs, opts.targets || []);
    return { result: 'attached', cad: cad };
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

module.exports = { setupEgrn, parseCads, readStatus, findFileUrls, findReq, attachOrOrder, CAD_RE };
