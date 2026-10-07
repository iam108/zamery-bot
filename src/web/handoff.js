// Передача клиента юристу + чек-листы юриста
const pool = require('../db/pool');
const { LISTS, STAGES, pickChecklist, flagLabels } = require('../checklists');

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audits (
      id         SERIAL PRIMARY KEY,
      order_id   INT,
      text       TEXT,
      chat_id    BIGINT,
      msg_ids    BIGINT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS staff (
      tg_id      BIGINT PRIMARY KEY,
      name       TEXT NOT NULL,
      username   TEXT,
      role       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cases (
      id            SERIAL PRIMARY KEY,
      order_id      INT,
      lawyer_tg_id  BIGINT,
      lawyer_name   TEXT,
      checklist_key TEXT,
      org TEXT, inn TEXT, client TEXT, phone TEXT, address TEXT,
      region TEXT, kind TEXT, service TEXT, priority TEXT, comment TEXT,
      audit_text    TEXT,
      data          JSONB DEFAULT '{}',
      done          INT DEFAULT 0,
      total         INT DEFAULT 0,
      created_by    BIGINT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      completed_at  TIMESTAMPTZ
    );
  `);
}

async function saveAudit(orderId, text, chatId, msgIds) {
  await pool.query(
    'INSERT INTO audits (order_id, text, chat_id, msg_ids) VALUES ($1,$2,$3,$4)',
    [orderId || null, text, chatId, msgIds]
  );
}

function guessRegion(address) {
  var a = (address || '').toLowerCase();
  if (a.indexOf('московская обл') !== -1 || a.indexOf(' мо,') !== -1 || a.indexOf('городской округ') !== -1) return 'МО';
  if (a.indexOf('москва') !== -1) return 'МСК';
  return 'МО';
}
function guessKind(t) {
  t = (t || '').toLowerCase();
  if (t.indexOf('табак') !== -1) return 'Табак';
  if (t.indexOf('общепит') !== -1) return 'Общепит';
  return 'Магазин';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); }
function json(o) { return JSON.stringify(o).replace(/</g, '\\u003c'); }

function caseText(c) {
  var icon = { 'Общепит': '🍺', 'Магазин': '🛒', 'Табак': '🚬' }[c.kind] || '📦';
  var L = [];
  L.push('⚖️ <b>Клиент передан юристу</b>');
  L.push(icon + ' <b>' + esc(c.kind) + ' · ' + esc(c.region) + ' · ' + esc(c.service) + '</b>');
  L.push('');
  L.push('🏢 <b>' + esc(c.org) + '</b>');
  if (c.inn) L.push('ИНН: <code>' + esc(c.inn) + '</code>');
  L.push('👤 Клиент: ' + esc(c.client) + (c.phone ? ' ' + esc(c.phone) : ''));
  if (c.address) L.push('📍 Адрес: ' + esc(c.address));
  if (c.priority) L.push('⚡ Приоритет: ' + esc(c.priority));
  L.push('⚖️ Юрист: ' + esc(c.lawyer_name));
  if (c.audit_text) { L.push(''); L.push('🔍 <b>Комментарий аудитора:</b>'); var at = String(c.audit_text).replace(/[*_`]/g, ''); L.push(esc(at.length > 1500 ? at.slice(0, 1500) + '…' : at)); }
  if (c.comment) { L.push(''); L.push('💬 <b>Комментарий менеджера:</b>'); L.push(esc(c.comment)); }
  L.push(''); L.push('#заявка' + c.id);
  return L.join('\n');
}


// ── Отчёты из чата замеров: запоминание, поиск, импорт выгрузки ─────────
async function ensureReports() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id         SERIAL PRIMARY KEY,
      chat_id    BIGINT,
      first_id   BIGINT,
      msg_ids    BIGINT[] DEFAULT '{}',
      text       TEXT DEFAULT '',
      author     TEXT,
      author_id  BIGINT,
      mgid       TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (chat_id, first_id)
    );
    CREATE INDEX IF NOT EXISTS reports_chat_time ON reports (chat_id, created_at DESC);
  `);
}

var MERGE_SEC = 180; // сообщения одного автора подряд в пределах 3 минут — один отчёт

async function addToReports(chatId, msgId, text, author, authorId, mgid, date) {
  var when = date || new Date();
  var r = null;
  if (mgid) r = (await pool.query('SELECT id FROM reports WHERE chat_id=$1 AND mgid=$2 ORDER BY id DESC LIMIT 1', [chatId, mgid])).rows[0];
  if (!r) r = (await pool.query(
    "SELECT id FROM reports WHERE chat_id=$1 AND author=$2 AND created_at > $3::timestamptz - INTERVAL '" + MERGE_SEC + " seconds' AND created_at <= $3::timestamptz + INTERVAL '5 seconds' ORDER BY id DESC LIMIT 1",
    [chatId, author, when])).rows[0];
  if (r) {
    await pool.query(
      "UPDATE reports SET msg_ids = array_append(msg_ids, $1), text = CASE WHEN $2 = '' THEN text WHEN text = '' THEN $2 ELSE text || E'\\n' || $2 END, mgid = COALESCE(mgid, $3) WHERE id=$4 AND NOT ($1 = ANY(msg_ids))",
      [msgId, text || '', mgid || null, r.id]);
    return;
  }
  await pool.query(
    'INSERT INTO reports (chat_id, first_id, msg_ids, text, author, author_id, mgid, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (chat_id, first_id) DO NOTHING',
    [chatId, msgId, [msgId], text || '', author, authorId || null, mgid || null, when]);
}

// Бот запоминает каждое сообщение в чате замеров
function setupReportsBot(bot) {
  ensureReports().catch(function (e) { console.error('reports table:', e.message); });
  bot.on('message', async function (ctx, next) {
    if (String(ctx.chat.id) === String(process.env.GROUP_CHAT_ID)) {
      var m = ctx.message;
      var text = m.text || m.caption || '';
      var hasMedia = !!(m.photo || m.document || m.video);
      if (text || hasMedia) {
        var author = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'аудитор';
        try { await addToReports(ctx.chat.id, m.message_id, text, author, ctx.from.id, m.media_group_id, new Date(m.date * 1000)); }
        catch (e) { console.error('report save:', e.message); }
      }
    }
    return next();
  });
}

// Поиск: по адресу, названию, ИНН, #номеру заявки — по всем словам сразу
async function searchReports(q) {
  var words = String(q || '').toLowerCase().replace(/ё/g, 'е').split(/[\s,.;]+/).filter(function (w) { return w.length > 1 || /^\d+$/.test(w); }).slice(0, 6);
  var params = [], condA = [], condR = [];
  words.forEach(function (w) {
    params.push('%' + w.replace(/^#/, '') + '%');
    var n = '$' + params.length;
    condA.push("replace(lower(concat_ws(' ', a.text, o.address, o.object_name, o.owner_name, '#' || a.order_id)), 'ё', 'е') LIKE " + n);
    condR.push("replace(lower(r.text), 'ё', 'е') LIKE " + n);
  });
  var sql =
    "SELECT 'a' AS src, a.id, a.text, a.created_at, a.order_id, o.address, o.object_name, NULL AS author " +
    "FROM audits a LEFT JOIN orders o ON o.id = a.order_id " + (condA.length ? 'WHERE ' + condA.join(' AND ') : '') +
    " UNION ALL " +
    "SELECT 'r', r.id, r.text, r.created_at, NULL, NULL, NULL, r.author FROM reports r WHERE r.text <> '' " + (condR.length ? 'AND ' + condR.join(' AND ') : '') +
    " ORDER BY created_at DESC LIMIT 20";
  return (await pool.query(sql, params)).rows;
}

async function getReport(src, id) {
  if (src === 'a') {
    var a = (await pool.query('SELECT * FROM audits WHERE id=$1', [id])).rows[0];
    return a ? { chat_id: a.chat_id, msg_ids: a.msg_ids, text: a.text } : null;
  }
  var r = (await pool.query('SELECT * FROM reports WHERE id=$1', [id])).rows[0];
  return r ? { chat_id: r.chat_id, msg_ids: r.msg_ids, text: r.text } : null;
}

var RU_MONTHS = { 'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12 };
function parseExportDate(body) {
  var m = body.match(/class="pull_right date details" title="([^"]+)"/);
  if (!m) return new Date();
  var t = m[1], p;
  if ((p = t.match(/(\d{1,2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})/))) {
    return new Date(p[3] + '-' + p[2] + '-' + ('0' + p[1]).slice(-2) + 'T' + p[4] + ':' + p[5] + ':' + p[6] + '+03:00');
  }
  if ((p = t.match(/(\d{1,2}) ([а-я]+) (\d{4}), (\d{2}):(\d{2}):(\d{2})/i)) && RU_MONTHS[p[2].toLowerCase()]) {
    return new Date(p[3] + '-' + ('0' + RU_MONTHS[p[2].toLowerCase()]).slice(-2) + '-' + ('0' + p[1]).slice(-2) + 'T' + p[4] + ':' + p[5] + ':' + p[6] + '+03:00');
  }
  return new Date();
}

// Разбор выгрузки Telegram Desktop (HTML или JSON)
function parseExport(buf, name) {
  var s = buf.toString('utf8');
  var out = [];
  function clean(h) {
    return h.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
  }
  if (/\.json$/i.test(name) || s.trim().charAt(0) === '{') {
    var j = JSON.parse(s);
    (j.messages || []).forEach(function (m) {
      if (m.type !== 'message') return;
      var t = typeof m.text === 'string' ? m.text : (m.text || []).map(function (x) { return typeof x === 'string' ? x : x.text; }).join('');
      out.push({ id: m.id, date: new Date(m.date), author: m.from || '', text: t, media: !!(m.photo || m.file) });
    });
    return out;
  }
  var blocks = s.split(/<div class="message default clearfix( joined)?" id="message(-?\d+)">/);
  var lastAuthor = '';
  for (var i = 1; i + 2 < blocks.length; i += 3) {
    var id = parseInt(blocks[i + 1]);
    var body = blocks[i + 2];
    var fm = body.match(/<div class="from_name">\s*([\s\S]*?)\s*<\/div>/);
    if (fm) lastAuthor = clean(fm[1]).replace(/\s+\d{2}\.\d{2}\.\d{4}.*$/, '');
    var date = parseExportDate(body);
    var tm = body.match(/<div class="text">([\s\S]*?)<\/div>/);
    var media = /class="media_wrap|class="photo_wrap|class="media clearfix/.test(body);
    out.push({ id: id, date: date, author: lastAuthor, text: tm ? clean(tm[1]) : '', media: media });
  }
  return out;
}

function adminImportPage(msg) {
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Импорт отчётов</title>' +
    '<style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;padding:32px;max-width:640px;margin:0 auto;line-height:1.5}a{color:#94a3b8}' +
    '.card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:24px;margin-top:16px}input{margin:14px 0;color:#f1f5f9}' +
    'button{padding:12px 20px;background:#6366f1;color:#fff;border:0;border-radius:10px;font-size:15px;cursor:pointer}.ok{color:#22c55e;font-weight:600}ol{padding-left:20px;color:#cbd5e1}</style></head><body>' +
    '<a href="/admin">← Назад</a><h1 style="margin-top:12px">Импорт отчётов из чата замеров</h1>' +
    (msg ? '<p class="ok">' + esc(msg) + '</p>' : '') +
    '<div class="card"><ol><li>Telegram Desktop → чат замеров → ⋮ → «Экспорт истории чата».</li><li>Снять все галочки (фото, файлы не нужны), формат HTML или JSON.</li>' +
    '<li>Загрузить сюда все файлы <b>messages*.html</b> или <b>result.json</b>.</li></ol>' +
    '<form method="POST" enctype="multipart/form-data"><input type="file" name="files" multiple accept=".html,.json"><br><button type="submit">Загрузить</button></form>' +
    '<p style="color:#94a3b8;font-size:13px">Повторная загрузка не создаёт дублей.</p></div></body></html>';
}

function setupReportsWeb(app, upload) {
  ensureReports().catch(function (e) { console.error('reports table:', e.message); });

  app.get('/api/reports/search', async function (req, res) {
    try { res.json({ ok: true, items: await searchReports(req.query.q) }); }
    catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
  });

  function auth(req, res, next) { if (req.session && req.session.auth) return next(); res.redirect('/admin/login'); }
  app.get('/admin/import', auth, function (req, res) { res.send(adminImportPage()); });
  app.post('/admin/import', auth, upload.array('files', 30), async function (req, res) {
    try {
      var msgs = [];
      (req.files || []).forEach(function (f) { msgs = msgs.concat(parseExport(f.buffer, f.originalname)); });
      msgs.sort(function (a, b) { return a.id - b.id; });
      var chatId = process.env.GROUP_CHAT_ID, n = 0;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m.text && !m.media) continue;
        await addToReports(chatId, m.id, m.text, m.author || 'аудитор', null, null, m.date);
        n++;
      }
      var cnt = (await pool.query('SELECT COUNT(*)::int AS c FROM reports WHERE chat_id=$1', [chatId])).rows[0].c;
      res.send(adminImportPage('Обработано сообщений: ' + n + '. Отчётов в базе: ' + cnt + '.'));
    } catch (e) { console.error('import:', e); res.send(adminImportPage('Ошибка: ' + e.message)); }
  });
}

function setupHandoff(app) {
  ensureTables().catch(function (e) { console.error('handoff tables error:', e.message); });
  const bot = require('../bot/instance');
  const WEBAPP_URL = process.env.WEBAPP_URL;

  // Данные для предзаполнения формы
  app.get('/api/handoff/prefill', async function (req, res) {
    try {
      var orderId = parseInt(req.query.order_id) || 0;
      var order = null, audit = null;
      if (orderId) {
        order = (await pool.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0] || null;
        audit = (await pool.query('SELECT * FROM audits WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1', [orderId])).rows[0] || null;
      }
      var lawyers = (await pool.query("SELECT tg_id, name FROM staff WHERE role='lawyer' ORDER BY name")).rows;
      res.json({
        ok: true, lawyers: lawyers,
        report: audit ? { src: 'a', id: audit.id, text: audit.text, created_at: audit.created_at, order_id: audit.order_id } : null,
        order: order ? {
          id: order.id, org: order.object_name || '', client: order.owner_name || '',
          address: order.address || '', contacts: order.contacts || '',
          region: guessRegion(order.address), kind: guessKind(order.object_type)
        } : null,
        audit_text: audit ? audit.text : ''
      });
    } catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
  });

  // Создание передачи юристу
  app.post('/api/handoff', async function (req, res) {
    try {
      var d = req.body;
      var lawyer = (await pool.query('SELECT * FROM staff WHERE tg_id=$1', [d.lawyer_tg_id])).rows[0];
      if (!lawyer) return res.json({ ok: false, error: 'Юрист не найден. Он должен нажать /start в боте и выбрать роль «Юрист».' });
      if (d.kind === 'Табак') d.checklist_key = null; else d.checklist_key = pickChecklist(d.region, d.kind, d.service);
      var total = 0;
      var c = (await pool.query(
        `INSERT INTO cases (order_id, lawyer_tg_id, lawyer_name, checklist_key, org, inn, client, phone, address,
          region, kind, service, priority, comment, audit_text, total, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [d.order_id || null, lawyer.tg_id, lawyer.name, d.checklist_key, d.org, d.inn, d.client, d.phone, d.address,
          d.region, d.kind, d.service, d.priority, d.comment, d.audit_text, total, d.tg_user_id || null]
      )).rows[0];

      var text = caseText(c);
      var audit = null;
      if (d.report_src && d.report_id) audit = await getReport(d.report_src, parseInt(d.report_id));
      if (audit && audit.msg_ids) audit.msg_ids = audit.msg_ids.map(Number).sort(function (x, y) { return x - y; }).slice(0, 100);

      // 1) Чат «Заявки по клиенту»: файлы аудитора + карточка
      var CLIENTS = process.env.CLIENTS_CHAT_ID;
      if (CLIENTS) {
        if (audit && audit.msg_ids && audit.msg_ids.length) {
          try { await bot.telegram.callApi('copyMessages', { chat_id: CLIENTS, from_chat_id: audit.chat_id, message_ids: audit.msg_ids.map(Number) }); }
          catch (e) { console.error('copy to clients chat:', e.message); }
        }
        await bot.telegram.sendMessage(CLIENTS, text, { parse_mode: 'HTML' });
      }

      // 2) Юристу в личку: файлы + карточка + кнопка чек-листа
      if (audit && audit.msg_ids && audit.msg_ids.length) {
        try { await bot.telegram.callApi('copyMessages', { chat_id: lawyer.tg_id, from_chat_id: audit.chat_id, message_ids: audit.msg_ids.map(Number) }); }
        catch (e) { console.error('copy to lawyer:', e.message); }
      }
      var kb = c.checklist_key
        ? { inline_keyboard: [[{ text: '📋 Открыть чек-лист', web_app: { url: WEBAPP_URL + '/checklist?case_id=' + c.id } }]] }
        : undefined;
      try {
        await bot.telegram.sendMessage(lawyer.tg_id, '🆕 <b>У вас новый клиент</b>\n\n' + text, { parse_mode: 'HTML', reply_markup: kb });
      } catch (e) {
        console.error('lawyer DM:', e.message);
        return res.json({ ok: true, id: c.id, warn: 'Карточка отправлена в чат, но юрист не получил личное сообщение — пусть нажмёт /start в боте.' });
      }
      res.json({ ok: true, id: c.id });
    } catch (e) { console.error('api/handoff error:', e); res.json({ ok: false, error: e.message }); }
  });

  // Сохранение чек-листа
  app.post('/api/checklist/save', async function (req, res) {
    try {
      var id = parseInt(req.body.case_id);
      var c = (await pool.query('SELECT * FROM cases WHERE id=$1', [id])).rows[0];
      if (!c) return res.json({ ok: false, error: 'not found' });
      var data = req.body.data || {};
      var old = c.data || {};
      var done = parseInt(req.body.done) || 0;
      var total = parseInt(req.body.total) || 0;
      var nowDone = total > 0 && done >= total;
      await pool.query(
        'UPDATE cases SET data=$1, done=$2, total=$3, completed_at=' + (nowDone ? 'COALESCE(completed_at, NOW())' : 'NULL') + ' WHERE id=$4',
        [data, done, total, id]
      );

      var CLIENTS = process.env.CLIENTS_CHAT_ID;
      // Новые красные флаги ЕГРН → сразу уведомление
      var labels = flagLabels(c.checklist_key);
      var fresh = Object.keys(labels).filter(function (fid) {
        return data[fid] && data[fid].s === 'yes' && !(old[fid] && old[fid].s === 'yes');
      });
      if (fresh.length) {
        var msg = '🚩 <b>Красный флаг ЕГРН</b>\n🏢 ' + esc(c.org) + (c.inn ? ' · ИНН ' + esc(c.inn) : '') + '\n\n' +
          fresh.map(function (fid) { return '• ' + esc(labels[fid]) + (data[fid].c ? ' — ' + esc(data[fid].c) : ''); }).join('\n') +
          '\n\n⚖️ ' + esc(c.lawyer_name) + '\n#заявка' + c.id;
        if (CLIENTS) { try { await bot.telegram.sendMessage(CLIENTS, msg, { parse_mode: 'HTML' }); } catch (e) { console.error(e.message); } }
        if (c.created_by && String(c.created_by) !== String(c.lawyer_tg_id)) {
          try { await bot.telegram.sendMessage(c.created_by, msg, { parse_mode: 'HTML' }); } catch (e) { console.error(e.message); }
        }
      }
      // Смена этапа
      if (data._stage && data._stage !== old._stage && CLIENTS) {
        try { await bot.telegram.sendMessage(CLIENTS, '📌 <b>' + esc(c.org) + '</b>: ' + esc(data._stage) + '\n⚖️ ' + esc(c.lawyer_name) + '\n#заявка' + c.id, { parse_mode: 'HTML' }); } catch (e) { console.error(e.message); }
      }
      if (nowDone && !c.completed_at && CLIENTS) {
        await bot.telegram.sendMessage(CLIENTS, '✅ <b>Чек-лист выполнен</b>\n🏢 ' + esc(c.org) + '\n⚖️ ' + esc(c.lawyer_name) + '\n#заявка' + c.id, { parse_mode: 'HTML' });
      }
      res.json({ ok: true });
    } catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
  });

  app.get('/handoff', function (req, res) { res.send(handoffPage()); });

  app.get('/checklist', async function (req, res) {
    var c = (await pool.query('SELECT * FROM cases WHERE id=$1', [parseInt(req.query.case_id) || 0])).rows[0];
    if (!c || !c.checklist_key) return res.send('Чек-лист не найден');
    res.send(checklistPage(c, LISTS[c.checklist_key]));
  });
}

var BASE_CSS = [
  '*{box-sizing:border-box;margin:0;padding:0}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--tg-theme-bg-color,#0f172a);color:var(--tg-theme-text-color,#f1f5f9);padding:16px 16px 110px}',
  'h1{font-size:20px;font-weight:700;margin-bottom:4px;padding-top:6px}',
  '.sub{font-size:13px;color:var(--tg-theme-hint-color,#64748b);margin-bottom:18px}',
  '.field{margin-bottom:14px}',
  'label.l{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--tg-theme-hint-color,#64748b);margin-bottom:6px}',
  'input,select,textarea{width:100%;padding:12px 14px;background:var(--tg-theme-secondary-bg-color,#1e293b);border:1.5px solid transparent;border-radius:12px;color:var(--tg-theme-text-color,#f1f5f9);font-size:15px;outline:none;font-family:inherit;-webkit-appearance:none}',
  'textarea{resize:vertical;min-height:80px}',
  '.pills{display:flex;gap:8px;flex-wrap:wrap}',
  '.pill{padding:9px 14px;background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:10px;font-size:14px;cursor:pointer;border:1.5px solid transparent;user-select:none}',
  '.pill.on{border-color:var(--tg-theme-button-color,#6366f1);color:var(--tg-theme-button-color,#6366f1)}',
  '.audit{background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;padding:12px 14px;font-size:14px;white-space:pre-wrap;line-height:1.45}',
  '.bottom{position:fixed;bottom:0;left:0;right:0;padding:12px 16px;background:var(--tg-theme-bg-color,#0f172a);border-top:1px solid rgba(128,128,128,.25);display:flex;gap:8px}',
  '.btn{flex:1;padding:15px;background:var(--tg-theme-button-color,#6366f1);color:var(--tg-theme-button-text-color,#fff);border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer}',
  '.btn.sec{flex:0 0 auto;background:var(--tg-theme-secondary-bg-color,#1e293b);color:var(--tg-theme-text-color,#f1f5f9)}',
  '.btn:disabled{opacity:.5}'
].join('\n');

function handoffClient() {
  var tg = window.Telegram.WebApp; tg.ready(); tg.expand();
  var Q = new URLSearchParams(location.search);
  var orderId = Q.get('order_id') || '';
  var S = { lawyer: null, region: 'МСК', kind: 'Общепит', service: 'Получение', priority: 'обычный' };
  var REP = null; // выбранный отчёт {src,id,text}
  function $(i) { return document.getElementById(i); }
  function mark(g, v) { S[g] = v; document.querySelectorAll('[data-g=' + g + '] .pill').forEach(function (p) { p.classList.toggle('on', p.dataset.v === v); }); }
  document.querySelectorAll('[data-g]').forEach(function (box) { box.addEventListener('click', function (e) { var p = e.target.closest('.pill'); if (p) mark(box.dataset.g, p.dataset.v); }); });

  function fmtDate(s) { var d = new Date(s); return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + String(d.getFullYear()).slice(2); }
  function preview(t) { return String(t || '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim(); }

  function choose(it) {
    REP = it ? { src: it.src, id: it.id, text: it.text } : null;
    $('results').innerHTML = '';
    var box = $('chosen');
    if (!REP) { box.hidden = true; $('rq').hidden = false; return; }
    $('rq').hidden = true; box.hidden = false;
    $('chosen-text').textContent = preview(it.text);
    $('chosen-meta').textContent = (it.order_id ? 'Заявка #' + it.order_id + ', ' : '') + (it.author ? it.author + ', ' : '') + fmtDate(it.created_at);
    try { tg.HapticFeedback.selectionChanged(); } catch (e) {}
    fillFrom(it.text);
  }
  // Заполняем пустые поля из текста отчёта
  function fillFrom(t) {
    t = String(t || '');
    function set(id, v) { if (v && !$(id).value.trim()) $(id).value = v.trim(); }
    var m;
    if ((m = t.match(/ИНН[^\d\n]*(\d{10,12})/i))) set('inn', m[1]);
    if ((m = t.match(/^\s*((?:ООО|ИП|АО|ПАО|ЗАО)\s*[^\n]*)/im))) set('org', m[1]);
    if ((m = t.match(/Адрес\s*:\s*([^\n]+)/i))) set('address', m[1]);
    if ((m = t.match(/Клиент\s*:\s*([^\n+\d]+)/i))) set('client', m[1]);
    if ((m = t.match(/\+?[78][\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/))) set('phone', m[0]);
    var head = t.slice(0, 300);
    if (/табак/i.test(head)) mark('kind', 'Табак'); else if (/магазин|розниц/i.test(head)) mark('kind', 'Магазин'); else if (/общепит/i.test(head)) mark('kind', 'Общепит');
    if (/переоформ/i.test(head)) mark('service', 'Переоформление'); else if (/продлен/i.test(head)) mark('service', 'Продление'); else if (/получен/i.test(head)) mark('service', 'Получение');
    if (/московская обл|городской округ/i.test(t)) mark('region', 'МО'); else if (/москва/i.test(head)) mark('region', 'МСК');
  }
  $('chosen-x').onclick = function () { choose(null); $('rq').focus(); };

  var timer = null, seq = 0;
  function search() {
    var q = $('rq').value.trim(), my = ++seq;
    fetch('/api/reports/search?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (d) {
      if (my !== seq) return;
      var box = $('results'); box.innerHTML = '';
      if (!d.ok) return;
      if (!d.items.length) { var e = document.createElement('div'); e.className = 'empty'; e.textContent = q ? 'Ничего не нашлось. Попробуйте часть адреса или ИНН.' : 'Отчётов пока нет'; box.appendChild(e); return; }
      d.items.forEach(function (it) {
        var row = document.createElement('button'); row.type = 'button'; row.className = 'res';
        var t = document.createElement('div'); t.className = 'res-t'; t.textContent = preview(it.text).slice(0, 160);
        var m = document.createElement('div'); m.className = 'res-m';
        m.textContent = (it.order_id ? '#' + it.order_id + ' · ' : '') + (it.address ? it.address + ' · ' : '') + (it.author ? it.author + ' · ' : '') + fmtDate(it.created_at);
        row.appendChild(t); row.appendChild(m);
        row.onclick = function () { choose(it); };
        box.appendChild(row);
      });
    });
  }
  $('rq').oninput = function () { clearTimeout(timer); timer = setTimeout(search, 250); };
  $('rq').onfocus = function () { if (!$('results').children.length) search(); };

  fetch('/api/handoff/prefill?order_id=' + orderId).then(function (r) { return r.json(); }).then(function (d) {
    var L = $('lawyers');
    if (!d.lawyers.length) { var w = document.createElement('span'); w.className = 'warn'; w.textContent = 'Нет зарегистрированных юристов. Пусть нажмут /start в боте.'; L.appendChild(w); }
    d.lawyers.forEach(function (x) {
      var p = document.createElement('div'); p.className = 'pill'; p.textContent = x.name;
      p.onclick = function () { S.lawyer = x.tg_id; L.querySelectorAll('.pill').forEach(function (q) { q.classList.remove('on'); }); p.classList.add('on'); };
      L.appendChild(p);
    });
    if (d.order) {
      $('sub').textContent = 'По заявке на замер #' + d.order.id;
      $('org').value = d.order.org; $('client').value = d.order.client; $('address').value = d.order.address; $('comment').value = d.order.contacts;
      mark('region', d.order.region); mark('kind', d.order.kind);
      if (d.report) choose(d.report);
      else if (d.order.address) { $('rq').value = d.order.address.split(',').slice(-2).join(' '); search(); }
    } else { $('sub').textContent = 'Новый клиент'; mark('region', 'МСК'); mark('kind', 'Общепит'); }
    mark('service', 'Получение'); mark('priority', 'обычный');
  });

  window.send = async function () {
    if (!S.lawyer) { tg.showAlert('Выберите юриста'); return; }
    if (!$('org').value.trim()) { tg.showAlert('Укажите организацию'); return; }
    var b = $('go'); b.disabled = true; b.textContent = 'Отправляем...';
    try {
      var r = await fetch('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        order_id: orderId ? parseInt(orderId) : null, lawyer_tg_id: S.lawyer, region: S.region, kind: S.kind, service: S.service, priority: S.priority,
        org: $('org').value.trim(), inn: $('inn').value.trim(), client: $('client').value.trim(), phone: $('phone').value.trim(),
        address: $('address').value.trim(), comment: $('comment').value.trim(),
        report_src: REP ? REP.src : null, report_id: REP ? REP.id : null, audit_text: REP ? REP.text : '',
        tg_user_id: tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : null }) });
      var j = await r.json(); if (!j.ok) throw new Error(j.error || 'Ошибка');
      b.textContent = '✅ Передано';
      if (j.warn) tg.showAlert(j.warn, function () { tg.close(); }); else setTimeout(function () { tg.close(); }, 1200);
    } catch (e) { b.disabled = false; b.textContent = 'Передать юристу'; tg.showAlert('Ошибка: ' + e.message); }
  };
}

function handoffPage() {
  var css = BASE_CSS + '\n' + [
    '.res{display:block;width:100%;text-align:left;background:var(--tg-theme-secondary-bg-color,#1e293b);color:var(--tg-theme-text-color,#f1f5f9);border:0;border-radius:12px;padding:11px 13px;margin-top:6px;font:inherit;cursor:pointer}',
    '.res:active{opacity:.7}',
    '.res-t{font-size:14px;line-height:1.35}',
    '.res-m{font-size:12px;color:var(--tg-theme-hint-color,#64748b);margin-top:4px}',
    '.empty{font-size:13px;color:var(--tg-theme-hint-color,#64748b);padding:10px 2px}',
    '.chosen{background:var(--tg-theme-secondary-bg-color,#1e293b);border:1.5px solid #22c55e;border-radius:12px;padding:12px 14px;position:relative}',
    '.chosen-t{font-size:14px;line-height:1.45;white-space:pre-wrap;max-height:180px;overflow:auto;padding-right:26px}',
    '.chosen-m{font-size:12px;color:#22c55e;margin-top:6px;font-weight:600}',
    '#chosen-x{position:absolute;top:8px;right:8px;width:26px;height:26px;border-radius:13px;border:0;background:rgba(128,128,128,.25);color:inherit;font-size:14px;cursor:pointer}',
    '.warn{font-size:13px;color:#f87171}'
  ].join('\n');
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<title>Передать юристу</title><script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>' + css + '</style></head><body>' +
    '<h1>⚖️ Передать юристу</h1><p class="sub" id="sub">Загрузка...</p>' +
    '<div class="field"><label class="l">Отчёт аудитора</label>' +
    '<input id="rq" type="search" autocomplete="off" placeholder="Адрес, название, ИНН или #номер заявки">' +
    '<div id="chosen" class="chosen" hidden><button id="chosen-x" type="button" aria-label="Убрать">✕</button><div id="chosen-text" class="chosen-t"></div><div id="chosen-meta" class="chosen-m"></div></div>' +
    '<div id="results"></div></div>' +
    '<div class="field"><label class="l">Юрист *</label><div class="pills" id="lawyers"></div></div>' +
    '<div class="field"><label class="l">Регион</label><div class="pills" data-g="region"><div class="pill" data-v="МСК">МСК</div><div class="pill" data-v="МО">МО</div></div></div>' +
    '<div class="field"><label class="l">Вид</label><div class="pills" data-g="kind"><div class="pill" data-v="Общепит">🍺 Общепит</div><div class="pill" data-v="Магазин">🛒 Магазин</div><div class="pill" data-v="Табак">🚬 Табак</div></div></div>' +
    '<div class="field"><label class="l">Услуга</label><div class="pills" data-g="service"><div class="pill" data-v="Получение">Получение</div><div class="pill" data-v="Продление">Продление</div><div class="pill" data-v="Переоформление">Переоформление</div></div></div>' +
    '<div class="field"><label class="l">Приоритет</label><div class="pills" data-g="priority"><div class="pill" data-v="обычный">Обычный</div><div class="pill" data-v="🔥 горящий">🔥 Горящий</div></div></div>' +
    '<div class="field"><label class="l">Организация *</label><input id="org" placeholder="ООО «КАИСА»"></div>' +
    '<div class="field"><label class="l">ИНН</label><input id="inn" inputmode="numeric" placeholder="7708285998"></div>' +
    '<div class="field"><label class="l">Клиент</label><input id="client" placeholder="Имя"></div>' +
    '<div class="field"><label class="l">Телефон</label><input id="phone" inputmode="tel" placeholder="+7 ..."></div>' +
    '<div class="field"><label class="l">Адрес</label><textarea id="address"></textarea></div>' +
    '<div class="field"><label class="l">Комментарий менеджера</label><textarea id="comment" placeholder="Что важно знать юристу"></textarea></div>' +
    '<div class="bottom"><button class="btn" id="go" onclick="send()">Передать юристу</button></div>' +
    '<script>(' + handoffClient.toString() + ')();</script></body></html>';
}

// Клиентский код чек-листа (Liquid Glass). Выполняется в браузере.
function checklistClient() {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg && tg.ready) { tg.ready(); tg.expand(); }
  var scheme = (tg && tg.colorScheme) || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = scheme;
  if (tg && tg.setHeaderColor) { try { tg.setHeaderColor(scheme === 'dark' ? '#070B16' : '#E8EEF6'); tg.setBackgroundColor(scheme === 'dark' ? '#070B16' : '#E8EEF6'); } catch (e) {} }

  var CFG = window.__CFG;
  var L = CFG.list, D = CFG.data || {}, CASE = CFG.caseInfo;
  var OPEN = {};
  var ME = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user)
    ? [tg.initDataUnsafe.user.first_name, tg.initDataUnsafe.user.last_name].filter(Boolean).join(' ')
    : CASE.lawyer;
  var root = document.getElementById('list');

  function haptic(kind) {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (kind === 'warn') tg.HapticFeedback.notificationOccurred('warning');
      else if (kind === 'ok') tg.HapticFeedback.notificationOccurred('success');
      else tg.HapticFeedback.selectionChanged();
    } catch (e) {}
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function today() { var d = new Date(); return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear(); }

  function visible(it) {
    if (!it.when) return true;
    return Object.keys(it.when).every(function (key) {
      if (key === 'svc') return CASE.service === it.when.svc;
      return D[key] === undefined || D[key] === it.when[key];
    });
  }
  function termMonths(v) {
    if (!v || !v.from || !v.to) return null;
    var a = new Date(v.from), b = new Date(v.to);
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() >= a.getDate() ? 0 : -1);
  }
  function resolved(it) {
    var v = D[it.id];
    if (it.t === 'k' || it.t === 'flag') return !!(v && v.s);
    if (it.t === 'term') return !!(v && v.from && v.to);
    if (it.t === 'sig') return !!(v && v.at);
    return v !== undefined && v !== '';
  }
  function isProblem(it) {
    var v = D[it.id];
    if (it.t === 'k') return !!(v && v.s === 'bad');
    if (it.t === 'flag') return !!(v && v.s === 'yes');
    if (it.t === 'term') { var m = termMonths(v); return m != null && m < 12; }
    return false;
  }
  function allItems() {
    var out = [];
    L.passport.forEach(function (it) { if (visible(it)) out.push(it); });
    L.sections.forEach(function (s) { s.i.forEach(function (it) { if (visible(it)) out.push(it); }); });
    return out;
  }

  // ── Элементы управления ───────────────────────────────
  function segmented(opts, cur, onPick, tone) {
    var w = el('div', 'seg' + (tone ? ' ' + tone : ''));
    opts.forEach(function (o) {
      var val = typeof o === 'string' ? o : o[0];
      var label = typeof o === 'string' ? o : o[1];
      var b = el('button', 'sg' + (cur === val ? ' on' : '') + (typeof o === 'string' ? '' : ' v-' + val), label);
      b.type = 'button';
      b.onclick = function () { onPick(cur === val ? undefined : val); };
      w.appendChild(b);
    });
    return w;
  }

  // ── Отрисовка ─────────────────────────────────────────
  function render() {
    var y = window.scrollY;
    root.innerHTML = '';

    var stage = group('stage', 'Этап', null);
    var st = el('div', 'row col');
    st.appendChild(segmented(CFG.stages, D._stage || CFG.stages[0], function (v) { D._stage = v || CFG.stages[0]; haptic(); render(); changed(); }, 'wrap'));
    stage.body.appendChild(st);
    root.appendChild(stage.box);

    var pass = group('passport', 'Паспорт объекта', L.passport.filter(visible));
    L.passport.forEach(function (it) {
      if (!visible(it)) return;
      var r = el('div', 'row col');
      r.appendChild(el('div', 'lbl', it.l));
      r.appendChild(segmented(it.o, D[it.id], function (v) { D[it.id] = v; haptic(); render(); changed(); }));
      pass.body.appendChild(r);
    });
    root.appendChild(pass.box);

    L.sections.forEach(function (s, si) {
      var items = s.i.filter(visible);
      if (!items.length) return;
      var g = group('s' + si, s.t, items, s.red);
      items.forEach(function (it) { g.body.appendChild(renderItem(it)); });
      root.appendChild(g.box);
    });
    window.scrollTo(0, y);
    summary();
  }

  function group(key, title, items, red) {
    var box = el('section', 'glass grp' + (red ? ' red' : ''));
    box.id = 'g-' + key;
    var head = el('button', 'gh');
    head.type = 'button';
    var t = el('span', 'gt', title);
    head.appendChild(t);
    if (items) {
      var done = items.filter(resolved).length;
      var probs = items.filter(isProblem).length;
      var cnt = el('span', 'gc' + (done === items.length ? ' full' : ''), done + '/' + items.length);
      if (probs) head.appendChild(el('span', 'gp', String(probs)));
      head.appendChild(cnt);
    }
    var chev = el('span', 'chev');
    head.appendChild(chev);
    var body = el('div', 'gb');
    var isOpen = OPEN[key] !== undefined ? OPEN[key] : !(items && items.length && items.every(resolved) && !items.some(isProblem));
    if (!isOpen) box.classList.add('closed');
    head.onclick = function () { OPEN[key] = box.classList.contains('closed'); box.classList.toggle('closed'); haptic(); };
    box.appendChild(head); box.appendChild(body);
    return { box: box, body: body };
  }

  function renderItem(it) {
    var v = D[it.id];
    var w = el('div', 'row');
    var line = el('div', 'line');
    line.appendChild(el('div', 'lbl', it.l));
    w.appendChild(line);
    function redraw() { var n = renderItem(it); w.replaceWith(n); changed(); }

    if (it.t === 'k') {
      var cur = v && v.s;
      if (cur) w.classList.add('st-' + cur);
      w.appendChild(segmented([['ok', 'Ок'], ['bad', 'Проблема'], ['na', 'Н/П']], cur, function (x) {
        D[it.id] = x ? { s: x, c: (v && v.c) || '', by: ME, at: today() } : undefined;
        haptic(x === 'bad' ? 'warn' : null); redraw();
      }, 'tri'));
      if (cur === 'bad') w.appendChild(note(it, 'Что не так?'));
      if (cur && v.by) w.appendChild(el('div', 'meta', v.by + ', ' + v.at));
    }

    if (it.t === 'flag') {
      var fs = v && v.s;
      if (fs) w.classList.add(fs === 'yes' ? 'st-bad' : 'st-ok');
      w.appendChild(segmented([['no', 'Нет'], ['yes', 'Есть']], fs, function (x) {
        D[it.id] = x ? { s: x, c: (v && v.c) || '', by: ME, at: today() } : undefined;
        haptic(x === 'yes' ? 'warn' : null); redraw();
      }, 'tri flagseg'));
      if (fs === 'yes') w.appendChild(note(it, 'Номер записи, дата, кем наложено'));
    }

    if (it.t === 'r') {
      w.classList.add('col');
      w.appendChild(segmented(it.o, v, function (x) { D[it.id] = x; haptic(); redraw(); }, 'wrap'));
    }

    if (it.t === 'f' || it.t === 'd') {
      w.classList.add('col');
      var inp = el('input', 'inp');
      if (it.t === 'd') inp.type = 'date';
      inp.value = v || '';
      inp.placeholder = 'Не заполнено';
      inp.oninput = function () { D[it.id] = inp.value; changed(); };
      inp.onchange = function () { summary(); };
      w.appendChild(inp);
    }

    if (it.t === 'term') {
      w.classList.add('col');
      var tv = v || {};
      var two = el('div', 'two');
      var a = el('input', 'inp'); a.type = 'date'; a.value = tv.from || '';
      var b = el('input', 'inp'); b.type = 'date'; b.value = tv.to || '';
      var info = el('div', 'meta');
      function upd() {
        D[it.id] = { from: a.value, to: b.value };
        var m = termMonths(D[it.id]);
        info.textContent = m == null ? '' : (m < 12 ? 'Срок ' + m + ' мес. — меньше года, ставка 16,5%' : 'Срок ' + Math.floor(m / 12) + ' г. ' + (m % 12) + ' мес.');
        info.className = 'meta' + (m != null && m < 12 ? ' warn' : '');
        w.classList.toggle('st-bad', m != null && m < 12);
        w.classList.toggle('st-ok', m != null && m >= 12);
      }
      a.onchange = function () { upd(); changed(); };
      b.onchange = function () { upd(); changed(); };
      two.appendChild(cap('с', a)); two.appendChild(cap('по', b));
      w.appendChild(two); w.appendChild(info);
      if (tv.from && tv.to) upd();
    }

    if (it.t === 'sig') {
      w.classList.add('col');
      if (v && v.at) {
        w.classList.add('st-ok');
        var m2 = el('div', 'meta signed', v.by + ', ' + v.at);
        var undo = el('button', 'link', 'Отменить'); undo.type = 'button';
        undo.onclick = function () { D[it.id] = undefined; haptic(); redraw(); };
        m2.appendChild(undo);
        w.appendChild(m2);
      } else {
        var btn = el('button', 'sign', 'Подтвердить'); btn.type = 'button';
        btn.onclick = function () { D[it.id] = { by: ME, at: today() }; haptic('ok'); redraw(); };
        w.appendChild(btn);
      }
    }
    return w;
  }

  function cap(t, input) { var x = el('label', 'cap'); x.appendChild(el('span', null, t)); x.appendChild(input); return x; }
  function note(it, ph) {
    var t = el('textarea', 'note');
    t.placeholder = ph; t.rows = 2;
    t.value = (D[it.id] && D[it.id].c) || '';
    t.oninput = function () { D[it.id].c = t.value; changed(); };
    return t;
  }

  // ── Итоги: капсула прогресса + список проблем ─────────
  function stats() {
    var items = allItems(), done = 0, probs = [];
    items.forEach(function (it) {
      if (resolved(it)) done++;
      var v = D[it.id];
      if (it.t === 'k' && v && v.s === 'bad') probs.push({ l: it.l, c: v.c, flag: false });
      if (it.t === 'flag' && v && v.s === 'yes') probs.push({ l: it.l, c: v.c, flag: true });
      if (it.t === 'term') { var m = termMonths(v); if (m != null && m < 12) probs.push({ l: 'Срок договора меньше года', c: m + ' мес., ставка 16,5%', flag: false }); }
    });
    return { total: items.length, done: done, probs: probs };
  }

  function summary() {
    var s = stats();
    var pct = s.total ? s.done / s.total : 0;
    var ring = document.getElementById('ring');
    var C = 2 * Math.PI * 15;
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C * (1 - pct);
    document.getElementById('pnum').textContent = s.done;
    document.getElementById('ptot').textContent = 'из ' + s.total;
    var pb = document.getElementById('pbad');
    pb.textContent = s.probs.length ? s.probs.length + (s.probs.length === 1 ? ' проблема' : s.probs.length < 5 ? ' проблемы' : ' проблем') : 'Без проблем';
    pb.className = 'pbad' + (s.probs.length ? ' on' : '');

    var box = document.getElementById('probs');
    box.innerHTML = '';
    if (!s.probs.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('div', 'pt', 'Требует внимания'));
    s.probs.forEach(function (p) {
      var r = el('div', 'pr' + (p.flag ? ' fl' : ''));
      r.appendChild(el('span', 'dot'));
      var tx = el('div', 'ptx');
      tx.appendChild(el('div', 'pl', p.l));
      if (p.c) tx.appendChild(el('div', 'pc', p.c));
      r.appendChild(tx);
      box.appendChild(r);
    });
  }
  document.getElementById('capsule').onclick = function () {
    var p = document.getElementById('probs');
    if (!p.hidden) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ── Сохранение ────────────────────────────────────────
  var timer = null, refresh = null;
  function changed() {
    setSt('saving', 'Сохраняю…');
    summary();
    clearTimeout(refresh); refresh = setTimeout(refreshCounters, 250);
    clearTimeout(timer); timer = setTimeout(flush, 700);
  }
  function refreshCounters() {
    // Обновляем счётчики в заголовках разделов без полной перерисовки
    L.sections.forEach(function (s, si) {
      var box = document.getElementById('g-s' + si); if (!box) return;
      var items = s.i.filter(visible);
      var done = items.filter(resolved).length, probs = items.filter(isProblem).length;
      var gc = box.querySelector('.gc'); if (gc) { gc.textContent = done + '/' + items.length; gc.classList.toggle('full', done === items.length); }
      var gp = box.querySelector('.gp');
      if (probs && !gp) { gp = el('span', 'gp'); box.querySelector('.gh').insertBefore(gp, gc); }
      if (gp) { if (probs) gp.textContent = probs; else gp.remove(); }
    });
  }
  function setSt(cls, t) { var s = document.getElementById('st'); s.className = 'st ' + cls; s.textContent = t; }
  async function flush() {
    clearTimeout(timer);
    var s = stats();
    try {
      var r = await fetch('/api/checklist/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: CASE.id, data: D, done: s.done, total: s.total })
      });
      var j = await r.json();
      if (j.ok) setSt('ok', 'Сохранено'); else setSt('err', 'Не сохранено — повторите');
    } catch (e) { setSt('err', 'Нет связи — не сохранено'); }
  }
  document.getElementById('printBtn').onclick = function () { window.print(); };

  render();
  setSt('ok', 'Сохранено');
}

function checklistPage(c, L) {
  var css = [
    ':root{--bg:#E8EEF6;--ink:#0E1A2B;--ink2:#5B6B82;--glass:rgba(255,255,255,.56);--glass2:rgba(255,255,255,.72);--edge:rgba(255,255,255,.85);--hair:rgba(14,26,43,.08);--well:rgba(14,26,43,.06);',
    ' --ok:#1FA971;--bad:#E5484D;--na:#8A94A6;--warn:#C27C0E;--accent:#2F6BFF;--o1:#8EC5FF;--o2:#C3B2FF;--o3:#9CEBD3;--shadow:0 10px 30px rgba(30,52,90,.12),0 1px 2px rgba(30,52,90,.06)}',
    '[data-theme=dark]{--bg:#070B16;--ink:#EEF2F8;--ink2:#93A0B5;--glass:rgba(28,36,56,.48);--glass2:rgba(36,46,70,.62);--edge:rgba(255,255,255,.14);--hair:rgba(255,255,255,.08);--well:rgba(255,255,255,.07);',
    ' --ok:#34C98A;--bad:#FF6369;--na:#7C879A;--warn:#F2B243;--accent:#6E9BFF;--o1:#1D4ED8;--o2:#6D28D9;--o3:#0F766E;--shadow:0 12px 34px rgba(0,0,0,.45),0 1px 0 rgba(255,255,255,.04) inset}',
    '*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}',
    'html{background:var(--bg)}',
    'body{font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",Roboto,sans-serif;color:var(--ink);min-height:100vh;padding:0 14px 120px;letter-spacing:-.01em}',
    '.field{position:fixed;inset:-20%;z-index:-1;pointer-events:none;filter:blur(60px);opacity:.75}',
    '[data-theme=dark] .field{opacity:.42}',
    '.field i{position:absolute;border-radius:50%}',
    '.field i:nth-child(1){width:55%;height:45%;left:-5%;top:5%;background:var(--o1)}',
    '.field i:nth-child(2){width:50%;height:45%;right:-5%;top:30%;background:var(--o2)}',
    '.field i:nth-child(3){width:55%;height:40%;left:15%;bottom:0;background:var(--o3)}',
    '.glass{background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:1px solid var(--edge);box-shadow:var(--shadow);position:relative}',
    '.glass:before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,.35),rgba(255,255,255,0) 38%)}',
    '[data-theme=dark] .glass:before{background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,0) 40%)}',
    // шапка
    '.top{padding:18px 4px 10px}',
    '.kicker{font-size:13px;color:var(--ink2);font-weight:500}',
    'h1{font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.025em;margin:4px 0 6px}',
    '.facts{font-size:14px;color:var(--ink2);line-height:1.5}',
    '.facts b{color:var(--ink);font-weight:600}',
    // капсула прогресса
    '#capsule{position:sticky;top:10px;z-index:5;display:flex;align-items:center;gap:12px;padding:10px 16px 10px 10px;border-radius:999px;margin:12px 0 14px;cursor:pointer;width:100%;color:var(--ink);font:inherit;text-align:left;background:var(--glass2)}',
    '#capsule svg{width:40px;height:40px;flex-shrink:0;transform:rotate(-90deg)}',
    '#capsule .trk{fill:none;stroke:var(--well);stroke-width:4}',
    '#ring{fill:none;stroke:var(--ok);stroke-width:4;stroke-linecap:round;transition:stroke-dashoffset .45s cubic-bezier(.2,.8,.2,1)}',
    '.pnums{display:flex;align-items:baseline;gap:5px}',
    '#pnum{font-size:22px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums}',
    '#ptot{font-size:14px;color:var(--ink2)}',
    '.pbad{margin-left:auto;font-size:13px;font-weight:600;color:var(--ok);padding:6px 11px;border-radius:999px;background:var(--well)}',
    '.pbad.on{color:#fff;background:var(--bad)}',
    // проблемы
    '#probs{border-radius:22px;padding:14px 16px;margin-bottom:14px;border-color:color-mix(in srgb,var(--bad) 45%,var(--edge))}',
    '#probs .pt{font-size:15px;font-weight:700;color:var(--bad);margin-bottom:8px}',
    '.pr{display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--hair)}',
    '.pr:first-of-type{border-top:0}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--warn);margin-top:6px;flex-shrink:0}',
    '.pr.fl .dot{background:var(--bad);box-shadow:0 0 0 4px color-mix(in srgb,var(--bad) 20%,transparent)}',
    '.pl{font-size:14px;font-weight:600}.pc{font-size:13px;color:var(--ink2);margin-top:1px}',
    // группы
    '.grp{border-radius:22px;margin-bottom:12px;overflow:hidden}',
    '.grp.red{border-color:color-mix(in srgb,var(--bad) 40%,var(--edge))}',
    '.gh{display:flex;align-items:center;gap:8px;width:100%;padding:14px 16px;background:none;border:0;color:var(--ink);font:inherit;text-align:left;cursor:pointer;position:relative}',
    '.gt{flex:1;font-size:16px;font-weight:650;letter-spacing:-.015em}',
    '.grp.red .gt{color:var(--bad)}',
    '.gc{font-size:13px;color:var(--ink2);font-variant-numeric:tabular-nums}',
    '.gc.full{color:var(--ok);font-weight:600}',
    '.gp{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--bad);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}',
    '.chev{width:9px;height:9px;border-right:2px solid var(--ink2);border-bottom:2px solid var(--ink2);transform:rotate(45deg);margin:-4px 2px 0 4px;transition:transform .25s}',
    '.grp.closed .chev{transform:rotate(-45deg);margin-top:0}',
    '.grp.closed .gb{display:none}',
    '.gb{padding:0 0 6px}',
    // строки
    '.row{position:relative;padding:12px 16px 12px 20px;border-top:1px solid var(--hair);display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
    '.row.col{display:block}',
    '.row:before{content:"";position:absolute;left:8px;top:14px;bottom:14px;width:3px;border-radius:2px;background:transparent;transition:background .2s}',
    '.row.st-ok:before{background:var(--ok)}.row.st-bad:before{background:var(--bad)}.row.st-na:before{background:var(--na)}',
    '.row.st-na .lbl{color:var(--ink2)}',
    '.line{flex:1 1 180px;min-width:0}',
    '.lbl{font-size:15px;line-height:1.35}',
    '.row.col .lbl{margin-bottom:8px;font-size:14px;color:var(--ink2)}',
    // сегменты
    '.seg{display:inline-flex;padding:3px;border-radius:12px;background:var(--well);gap:2px;flex-shrink:0}',
    '.seg.wrap{display:flex;flex-wrap:wrap;gap:4px;background:none;padding:0}',
    '.sg{border:0;background:none;color:var(--ink);font:inherit;font-size:13px;font-weight:550;padding:7px 11px;border-radius:9px;cursor:pointer;white-space:nowrap;transition:background .18s,color .18s,transform .12s}',
    '.sg:active{transform:scale(.96)}',
    '.seg.wrap .sg{background:var(--well);padding:8px 13px;border-radius:11px}',
    '.sg.on{background:var(--glass2);box-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 .5px var(--edge) inset;color:var(--ink)}',
    '.seg.wrap .sg.on{background:var(--accent);color:#fff;box-shadow:none}',
    '.sg.on.v-ok{background:var(--ok);color:#fff}',
    '.sg.on.v-bad,.sg.on.v-yes{background:var(--bad);color:#fff}',
    '.sg.on.v-na{background:var(--na);color:#fff}',
    // поля
    '.inp,.note{width:100%;font:inherit;font-size:15px;color:var(--ink);background:var(--well);border:1px solid transparent;border-radius:12px;padding:10px 12px;outline:none;-webkit-appearance:none}',
    '.inp:focus,.note:focus{border-color:var(--accent);background:var(--glass2)}',
    '.note{margin-top:10px;resize:vertical;border-color:color-mix(in srgb,var(--bad) 35%,transparent)}',
    '.two{display:flex;gap:8px}.cap{flex:1}.cap span{display:block;font-size:12px;color:var(--ink2);margin-bottom:4px}',
    '.meta{font-size:12.5px;color:var(--ink2);margin-top:6px;width:100%}',
    '.meta.warn{color:var(--warn);font-weight:600}',
    '.meta.signed{font-size:14px;color:var(--ok);font-weight:600}',
    '.link{background:none;border:0;color:var(--ink2);font:inherit;font-size:13px;text-decoration:underline;margin-left:10px;cursor:pointer}',
    '.sign{border:0;border-radius:12px;padding:10px 16px;font:inherit;font-weight:600;color:#fff;background:var(--accent);cursor:pointer}',
    // нижняя панель
    '.dock{position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:6;border-radius:999px;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 18px;background:var(--glass2)}',
    '.st{flex:1;font-size:13px;color:var(--ink2);display:flex;align-items:center;gap:7px}',
    '.st:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok)}',
    '.st.saving:before{background:var(--warn)}.st.err{color:var(--bad)}.st.err:before{background:var(--bad)}',
    '.pbtn{border:0;border-radius:999px;padding:11px 18px;font:inherit;font-weight:600;font-size:14px;color:var(--ink);background:var(--well);cursor:pointer}',
    'button:focus-visible,.inp:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '@media (prefers-reduced-motion:reduce){*{transition:none!important}}',
    // печать
    '@media print{',
    ' html,body{background:#fff!important;color:#000;padding:0;font-size:11px}',
    ' .field,.dock,#capsule .pbad,.chev,.link,.sign{display:none!important}',
    ' .glass{background:#fff!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important;border:1px solid #bbb}',
    ' .glass:before{display:none}',
    ' #capsule{position:static;border-radius:6px;padding:4px 8px;margin:6px 0}',
    ' .grp{border-radius:6px;margin-bottom:6px;break-inside:avoid}.grp.closed .gb{display:block}',
    ' .gh{padding:5px 8px}.gt{font-size:12px}.row{padding:3px 8px 3px 14px}.lbl{font-size:11px}',
    ' .seg{background:none;padding:0}.sg{padding:1px 6px;font-size:10px;border:1px solid #bbb}.sg:not(.on){display:none}',
    ' .sg.on{background:#fff!important;color:#000!important;border:1.5px solid #000;box-shadow:none}',
    ' .inp,.note{background:#fff;border:0;border-bottom:1px solid #999;border-radius:0;padding:1px;font-size:11px}',
    ' .row:before{left:4px;top:4px;bottom:4px}.row.st-ok:before,.row.st-bad:before{background:#000}',
    ' #probs{border:2px solid #000}#probs .pt{color:#000}h1{font-size:18px}',
    '}'
  ].join('\n');

  var cfg = {
    list: L, data: c.data || {}, stages: STAGES,
    caseInfo: { id: c.id, service: c.service, lawyer: c.lawyer_name }
  };

  var facts = [
    c.inn ? 'ИНН ' + esc(c.inn) : '',
    c.address ? esc(c.address) : '',
    'Клиент: <b>' + esc(c.client) + '</b>' + (c.phone ? ', ' + esc(c.phone) : '') + '. Юрист: <b>' + esc(c.lawyer_name) + '</b>'
  ].filter(Boolean).join('<br>');

  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">' +
    '<title>Чек-лист — ' + esc(c.org) + '</title><script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>' + css + '</style></head><body>' +
    '<div class="field" aria-hidden="true"><i></i><i></i><i></i></div>' +
    '<header class="top"><div class="kicker">' + esc(L.title) + '</div><h1>' + esc(c.org) + '</h1><div class="facts">' + facts + '</div></header>' +
    '<button id="capsule" class="glass" type="button" aria-label="Прогресс чек-листа">' +
    '<svg viewBox="0 0 40 40"><circle class="trk" cx="20" cy="20" r="15"/><circle id="ring" cx="20" cy="20" r="15"/></svg>' +
    '<span class="pnums"><span id="pnum">0</span><span id="ptot"></span></span><span id="pbad" class="pbad"></span></button>' +
    '<div id="probs" class="glass" hidden></div>' +
    '<main id="list"></main>' +
    '<div class="dock glass"><span id="st" class="st"></span><button id="printBtn" class="pbtn" type="button">Печать</button></div>' +
    '<script>window.__CFG=' + json(cfg) + ';(' + checklistClient.toString() + ')();</script>' +
    '</body></html>';
}

module.exports = { setupHandoff: setupHandoff, saveAudit: saveAudit, setupReportsBot: setupReportsBot, setupReportsWeb: setupReportsWeb };
