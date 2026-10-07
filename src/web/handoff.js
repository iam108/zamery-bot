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
    ALTER TABLE cases ADD COLUMN IF NOT EXISTS contacts JSONB DEFAULT '[]';
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
  var cl = Array.isArray(c.contacts) && c.contacts.length ? c.contacts : [{ name: c.client, phone: c.phone }];
  cl.forEach(function (x) {
    var line = [x.name, x.phone, x.tg ? (String(x.tg).charAt(0) === '@' ? x.tg : '@' + x.tg) : ''].filter(Boolean).map(esc).join(', ');
    if (line) L.push('👤 ' + line);
  });
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
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS reply_to BIGINT;
    CREATE INDEX IF NOT EXISTS reports_reply ON reports (chat_id, reply_to);
  `);
}

var MERGE_SEC = 180; // сообщения одного автора подряд в пределах 3 минут — один отчёт

async function addToReports(chatId, msgId, text, author, authorId, mgid, date, replyTo) {
  var when = date || new Date();
  var r = null;
  if (mgid) r = (await pool.query('SELECT id FROM reports WHERE chat_id=$1 AND mgid=$2 ORDER BY id DESC LIMIT 1', [chatId, mgid])).rows[0];
  if (!r) r = (await pool.query(
    "SELECT id FROM reports WHERE chat_id=$1 AND author=$2 AND created_at > $3::timestamptz - INTERVAL '" + MERGE_SEC + " seconds' AND created_at <= $3::timestamptz + INTERVAL '5 seconds' AND ($4::bigint IS NULL OR reply_to = $4) ORDER BY id DESC LIMIT 1",
    [chatId, author, when, replyTo || null])).rows[0];
  if (r) {
    await pool.query(
      "UPDATE reports SET msg_ids = array_append(msg_ids, $1), text = CASE WHEN $2 = '' THEN text WHEN text = '' THEN $2 ELSE text || E'\\n' || $2 END, mgid = COALESCE(mgid, $3), reply_to = COALESCE(reply_to, $5) WHERE id=$4 AND NOT ($1 = ANY(msg_ids))",
      [msgId, text || '', mgid || null, r.id, replyTo || null]);
    return;
  }
  await pool.query(
    'INSERT INTO reports (chat_id, first_id, msg_ids, text, author, author_id, mgid, created_at, reply_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (chat_id, first_id) DO NOTHING',
    [chatId, msgId, [msgId], text || '', author, authorId || null, mgid || null, when, replyTo || null]);
}

// Бот запоминает каждое сообщение в чате замеров
function setupReportsBot(bot) {
  ensureReports().catch(function (e) { console.error('reports table:', e.message); });
  bot.action(/^rq:(\d+)$/, async function (ctx) {
    var id = ctx.match[1];
    var done = (await pool.query('SELECT lawyer_name FROM cases WHERE request_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
    if (done) return ctx.answerCbQuery('Уже передано: ' + done.lawyer_name, { show_alert: true });
    try {
      await ctx.telegram.sendMessage(ctx.from.id, '⚖️ Распределить заявку', {
        reply_markup: { inline_keyboard: [[{ text: '📝 Открыть форму', web_app: { url: process.env.WEBAPP_URL + '/handoff?request_id=' + id } }]] }
      });
      await ctx.answerCbQuery('Форма отправлена вам в личку');
    } catch (e) {
      await ctx.answerCbQuery('Сначала напишите боту /start в личке', { show_alert: true });
    }
  });
  bot.action('noop', function (ctx) { return ctx.answerCbQuery(); });
  bot.on('message', async function (ctx, next) {
    var cid = String(ctx.chat.id);
    if (cid === String(process.env.GROUP_CHAT_ID) || cid === String(process.env.CLIENTS_CHAT_ID)) {
      var m = ctx.message;
      var text = m.text || m.caption || '';
      var hasMedia = !!(m.photo || m.document || m.video);
      if (text || hasMedia) {
        var author = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'аудитор';
        try { await addToReports(ctx.chat.id, m.message_id, text, author, ctx.from.id, m.media_group_id, new Date(m.date * 1000), m.reply_to_message ? m.reply_to_message.message_id : null); }
        catch (e) { console.error('report save:', e.message); }
      }
    }
    return next();
  });
}

// Карточка заявки (от бота или старой формы), а не отчёт
function isOrderCard(t) { return /^[^\wА-Яа-я]*(Новая заявка|Заявка\s*#\d+)/i.test(t || '') || /Чей объект\s*:/.test(t || ''); }
function orderNum(t) { var m = String(t || '').match(/Заявка\s*#(\d+)/i); return m ? parseInt(m[1]) : null; }

// Поиск: по адресу, названию, ИНН, #номеру заявки — по всем словам сразу
async function searchReports(q) {
  var words = String(q || '').toLowerCase().replace(/ё/g, 'е').split(/[\s,.;]+/).filter(function (w) { return w.length > 1 || /^\d+$/.test(w); }).slice(0, 6);
  var params = [], condA = [], condR = [];
  words.forEach(function (w) {
    params.push('%' + w.replace(/^#/, '') + '%');
    var n = '$' + params.length;
    condA.push("replace(lower(concat_ws(' ', a.text, o.address, o.object_name, o.owner_name, '#' || a.order_id)), 'ё', 'е') LIKE " + n);
    condR.push("replace(lower(concat_ws(' ', r.text, o2.address, o2.object_name, o2.owner_name, '#' || o2.id)), 'ё', 'е') LIKE " + n);
  });
  var sql =
    "SELECT 'a' AS src, a.id, a.text, a.created_at, a.order_id, o.address, NULL::text AS author " +
    "FROM audits a LEFT JOIN orders o ON o.id = a.order_id " + (condA.length ? 'WHERE ' + condA.join(' AND ') : '') +
    " UNION ALL " +
    "SELECT 'r', r.id, r.text, r.created_at, o2.id, o2.address, r.author FROM reports r " +
    "LEFT JOIN orders o2 ON o2.telegram_msg_id = r.reply_to " +
    "WHERE r.text <> '' " + (condR.length ? 'AND ' + condR.join(' AND ') : '') +
    " ORDER BY created_at DESC LIMIT 20";
  var rows = (await pool.query(sql, params)).rows;
  for (var i = 0; i < rows.length; i++) {
    var it = rows[i];
    it.kind = it.src === 'r' && isOrderCard(it.text) ? 'order' : 'report';
    if (it.kind === 'order') {
      if (!it.order_id) it.order_id = orderNum(it.text);
      var full = await getReport('r', it.id);
      it.linked = full ? full.linked : 0;
    }
  }
  return rows;
}

// Отчёт + всё, что пришло ответом на него (для карточки заявки — сам отчёт аудитора)
async function getReport(src, id) {
  if (src === 'a') {
    var a = (await pool.query('SELECT * FROM audits WHERE id=$1', [id])).rows[0];
    return a ? { chat_id: a.chat_id, msg_ids: a.msg_ids, text: a.text, linked: 0 } : null;
  }
  var r = (await pool.query('SELECT * FROM reports WHERE id=$1', [id])).rows[0];
  if (!r) return null;
  var ids = (r.msg_ids || []).map(Number);
  var replies = (await pool.query(
    'SELECT * FROM reports WHERE chat_id=$1 AND reply_to = ANY($2::bigint[]) AND id <> $3 ORDER BY first_id', [r.chat_id, ids, r.id])).rows;
  var num = isOrderCard(r.text) ? orderNum(r.text) : null;
  var audits = num ? (await pool.query('SELECT * FROM audits WHERE order_id=$1 ORDER BY created_at', [num])).rows : [];
  var texts = replies.map(function (x) { return x.text; }).filter(Boolean).concat(audits.map(function (x) { return x.text; }));
  replies.forEach(function (x) { ids = ids.concat((x.msg_ids || []).map(Number)); });
  return {
    chat_id: r.chat_id,
    msg_ids: ids,
    extra: audits.filter(function (x) { return String(x.chat_id) === String(r.chat_id); }).reduce(function (acc, x) { return acc.concat((x.msg_ids || []).map(Number)); }, []),
    text: isOrderCard(r.text) ? (texts.join('\n\n') || '') : [r.text].concat(texts).join('\n\n'),
    linked: replies.length + audits.length
  };
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
      out.push({ id: m.id, date: new Date(m.date), author: m.from || '', text: t, media: !!(m.photo || m.file), reply: m.reply_to_message_id || null });
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
    var rm = body.match(/class="reply_to details"[\s\S]{0,300}?go_to_message(-?\d+)/);
    out.push({ id: id, date: date, author: lastAuthor, text: tm ? clean(tm[1]) : '', media: media, reply: rm ? parseInt(rm[1]) : null });
  }
  return out;
}

function adminImportPage(msg, isErr) {
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Импорт чатов</title>' +
    '<style>body{font-family:-apple-system,sans-serif;background:#0f172a;color:#f1f5f9;padding:32px;max-width:640px;margin:0 auto;line-height:1.5}a{color:#94a3b8}' +
    '.card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:24px;margin-top:16px}input{margin:14px 0;color:#f1f5f9}' +
    'button{padding:12px 20px;background:#6366f1;color:#fff;border:0;border-radius:10px;font-size:15px;cursor:pointer}.ok{color:#22c55e;font-weight:600}.err{color:#f87171;font-weight:600}button:disabled{opacity:.6}#fc{color:#94a3b8;font-size:13px}ol{padding-left:20px;color:#cbd5e1}</style></head><body>' +
    '<a href="/admin">← Назад</a><h1 style="margin-top:12px">Импорт истории чатов</h1>' +
    (msg ? '<p class="' + (isErr ? 'err' : 'ok') + '">' + esc(msg) + '</p>' : '') +
    '<div class="card"><ol><li>Telegram Desktop → нужный чат → ⋮ → «Экспорт истории чата».</li><li>Снять все галочки (фото, файлы не нужны), формат HTML или JSON.</li>' +
    '<li>Загрузить сюда все файлы <b>messages*.html</b> или <b>result.json</b>.</li></ol>' +
    '<form method="POST" action="/admin/import" enctype="multipart/form-data" onsubmit="var f=document.getElementById(\'fi\');if(!f.files.length){alert(\'Сначала выберите файлы\');return false}var b=document.getElementById(\'sb\');b.disabled=true;b.textContent=\'Загружаю, не закрывайте страницу…\'">' +
    '<p style="margin-top:14px"><b>Какой чат загружаете:</b></p>' +
    '<label style="display:block;margin:6px 0"><input type="radio" name="chat" value="zamery" checked style="margin:0 8px 0 0">Замеры (отчёты аудиторов)</label>' +
    '<label style="display:block;margin:6px 0"><input type="radio" name="chat" value="clients" style="margin:0 8px 0 0">Заявки по клиенту</label>' +
    '<input id="fi" type="file" name="files" multiple accept=".html,.json" onchange="document.getElementById(\'fc\').textContent=this.files.length?\'Выбрано файлов: \'+this.files.length:\'\'"><div id="fc"></div><br>' +
    '<button id="sb" type="submit">Загрузить</button></form>' +
    '<p style="color:#94a3b8;font-size:13px">Повторная загрузка не создаёт дублей.</p></div></body></html>';
}

function setupReportsWeb(app, upload) {
  setupRequestsWeb(app);
  ensureReports().catch(function (e) { console.error('reports table:', e.message); });

  app.get('/api/reports/get', async function (req, res) {
    try {
      var r = await getReport(req.query.src, parseInt(req.query.id));
      if (!r) return res.json({ ok: false });
      res.json({ ok: true, text: r.text || '', files: (r.msg_ids || []).length + (r.extra || []).length });
    } catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
  });

  app.get('/api/reports/search', async function (req, res) {
    try { res.json({ ok: true, items: await searchReports(req.query.q) }); }
    catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
  });

  function auth(req, res, next) { if (req.session && req.session.auth) return next(); res.redirect('/admin/login'); }
  app.get('/admin/import', auth, function (req, res) { res.send(adminImportPage()); });
  app.post('/admin/import', auth, upload.array('files', 50), async function (req, res) {
    try {
      var files = req.files || [];
      if (!files.length) return res.send(adminImportPage('Файлы не выбраны. Нажмите «Выберите файлы» и отметьте messages.html.', true));
      var msgs = [];
      files.forEach(function (f) { msgs = msgs.concat(parseExport(f.buffer, f.originalname)); });
      msgs.sort(function (a, b) { return a.id - b.id; });
      var chatId = req.body.chat === 'clients' ? process.env.CLIENTS_CHAT_ID : process.env.GROUP_CHAT_ID;

      // Склеиваем в памяти: один автор подряд в пределах 3 минут = один отчёт
      var groups = [], cur = null;
      msgs.forEach(function (m) {
        if (!m.text && !m.media) return;
        var author = m.author || 'аудитор';
        var sameThread = !m.reply || (cur && m.reply === cur.reply);
        if (cur && cur.author === author && (m.date - cur.last) <= MERGE_SEC * 1000 && sameThread) {
          cur.ids.push(m.id); if (m.text) cur.text.push(m.text); cur.last = m.date;
        } else {
          cur = { first: m.id, ids: [m.id], text: m.text ? [m.text] : [], author: author, date: m.date, last: m.date, reply: m.reply || null };
          groups.push(cur);
        }
      });

      // Пересобираем ранее импортированное (без дублей); живые записи бота не трогаем
      if (msgs.length) {
        await pool.query('DELETE FROM reports WHERE chat_id=$1 AND author_id IS NULL AND first_id BETWEEN $2 AND $3',
          [chatId, msgs[0].id, msgs[msgs.length - 1].id]);
      }
      var live = new Set((await pool.query('SELECT unnest(msg_ids) AS id FROM reports WHERE chat_id=$1', [chatId])).rows.map(function (x) { return String(x.id); }));
      groups = groups.filter(function (g) { return !g.ids.some(function (id) { return live.has(String(id)); }); });

      // Пишем пачками по 500
      var added = 0;
      for (var i = 0; i < groups.length; i += 500) {
        var part = groups.slice(i, i + 500);
        var r = await pool.query(
          "INSERT INTO reports (chat_id, first_id, msg_ids, text, author, created_at, reply_to) " +
          "SELECT $1, f, string_to_array(ids, ',')::bigint[], t, a, d, NULLIF(rp, 0) FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::bigint[]) AS x(f, ids, t, a, d, rp) " +
          "ON CONFLICT (chat_id, first_id) DO UPDATE SET reply_to = COALESCE(reports.reply_to, EXCLUDED.reply_to), msg_ids = EXCLUDED.msg_ids, text = EXCLUDED.text",
          [chatId,
            part.map(function (g) { return g.first; }),
            part.map(function (g) { return g.ids.join(','); }),
            part.map(function (g) { return g.text.join('\n'); }),
            part.map(function (g) { return g.author; }),
            part.map(function (g) { return g.date.toISOString(); }),
            part.map(function (g) { return g.reply || 0; })]);
        added += r.rowCount;
      }
      var cnt = (await pool.query('SELECT COUNT(*)::int AS c FROM reports WHERE chat_id=$1', [chatId])).rows[0].c;
      res.send(adminImportPage('Готово. Файлов: ' + files.length + ', сообщений: ' + msgs.length + ', отчётов загружено: ' + added + '. Всего в базе: ' + cnt + '.'));
    } catch (e) { console.error('import:', e); res.send(adminImportPage('Ошибка: ' + e.message, true)); }
  });
}


// ── Заявки по клиенту: нераспределённые ───────────────────────────────
var REQ_RE = 'Новая форма заполнена|Наименование организации|ИНН[^0-9]{0,6}[0-9]{10}';
var NOT_REQ_RE = 'Клиент передан юристу|Чек-лист выполнен|Красный флаг|Запросить документы|Заявка не распределена';

function parseRequest(text) {
  var t = String(text || '');
  var f = {};
  function grab(re) { var m = t.match(re); return m ? m[1].replace(/^[\s:]+/, '').trim() : ''; }
  f.client = grab(/Имя клиента\s*:([^\n]*)/i) || grab(/Клиент\s*:([^\n+\d]*)/i);
  f.phone = grab(/Номер\s*:([^\n]*)/i) || (t.match(/\+?[78][\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/) || [''])[0];
  f.org = grab(/Наименование организации\s*:([^\n]*)/i);
  if (!f.org) { var m = t.match(/^\s*((?:ООО|ИП|АО|ПАО|ЗАО)\s*[^\n]*)/im); if (m) f.org = m[1].trim(); }
  f.inn = grab(/ИНН[^\d\n]*(\d{10,12})/i);
  f.city = grab(/Город\s*:([^\n]*)/i);
  f.address = grab(/Адрес лицензирования\s*:([^\n]*)/i) || grab(/Адрес\s*:([^\n]*)/i);
  var kind = grab(/Вид объекта\s*:([^\n]*)/i) || t.slice(0, 200);
  f.kind = /табак/i.test(kind) ? 'Табак' : /магазин|розниц/i.test(kind) ? 'Магазин' : /общепит|кафе|бар|ресторан/i.test(kind) ? 'Общепит' : '';
  var svc = grab(/Услуга\s*:([^\n]*)/i) || t.slice(0, 200);
  f.service = /переоформ/i.test(svc) ? 'Переоформление' : /продлен/i.test(svc) ? 'Продление' : /получен/i.test(svc) ? 'Получение' : '';
  var where = (f.city + ' ' + f.address).toLowerCase();
  f.region = /московская обл|городской округ/.test(where) ? 'МО' : /москва/.test(where) ? 'МСК' : (f.city ? 'МО' : '');
  f.priority = /горящ|срочно/i.test(t) ? '🔥 горящий' : '';
  var comment = [];
  var com = grab(/Комментари[ий]\s*:([^\n]*)/i); if (com) comment.push(com);
  var osob = grab(/Особые услуги\s*:([^\n]*)/i); if (osob) comment.push('Особые услуги: ' + osob);
  var tech = grab(/Техническое описание\s*:([^\n]*)/i); if (tech) comment.push('Техническое описание: ' + tech);
  var zones = grab(/Зоны запрета\s*:([^\n]*)/i); if (zones) comment.push('Зоны запрета: ' + zones);
  var amo = (t.match(/https?:\/\/\S*amocrm\S*/i) || [''])[0]; if (amo) comment.push('AmoCRM: ' + amo);
  f.comment = comment.join('\n');
  Object.keys(f).forEach(function (k) { if (!f[k]) delete f[k]; });
  return f;
}

async function ensureRequests() {
  await pool.query(`
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS dismissed BOOLEAN DEFAULT false;
    ALTER TABLE cases ADD COLUMN IF NOT EXISTS request_id INT;
  `);
}

async function listRequests(q, limit) {
  var params = [process.env.CLIENTS_CHAT_ID, REQ_RE, NOT_REQ_RE];
  var where = '';
  String(q || '').toLowerCase().replace(/ё/g, 'е').split(/[\s,.;]+/).filter(function (w) { return w.length > 1; }).slice(0, 5).forEach(function (w) {
    params.push('%' + w + '%');
    where += " AND replace(lower(r.text), 'ё', 'е') LIKE $" + params.length;
  });
  var sql = "SELECT r.id, r.text, r.created_at, r.author FROM reports r " +
    "WHERE r.chat_id = $1 AND NOT COALESCE(r.dismissed, false) AND r.text ~* $2 AND NOT (r.text ~* $3) " +
    "AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.request_id = r.id)" + where +
    " ORDER BY r.created_at DESC LIMIT " + (limit || 100);
  return (await pool.query(sql, params)).rows;
}

function setupRequestsWeb(app) {
  ensureReports().then(ensureRequests).catch(function (e) { console.error('requests table:', e.message); });

  app.get('/api/requests', async function (req, res) {
    try {
      var rows = await listRequests(req.query.q, 150);
      var total = (await pool.query(
        "SELECT COUNT(*)::int AS c FROM reports r WHERE r.chat_id=$1 AND NOT COALESCE(r.dismissed,false) AND r.text ~* $2 AND NOT (r.text ~* $3) AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.request_id = r.id)",
        [process.env.CLIENTS_CHAT_ID, REQ_RE, NOT_REQ_RE])).rows[0].c;
      res.json({ ok: true, total: total, items: rows.map(function (r) { return { id: r.id, created_at: r.created_at, author: r.author, f: parseRequest(r.text) }; }) });
    } catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
  });

  app.post('/api/requests/dismiss', async function (req, res) {
    try {
      if (req.body.older_days) {
        var r = await pool.query("UPDATE reports SET dismissed = true WHERE chat_id=$1 AND created_at < NOW() - ($2 || ' days')::interval AND text ~* $3 AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.request_id = reports.id)",
          [process.env.CLIENTS_CHAT_ID, String(parseInt(req.body.older_days) || 30), REQ_RE]);
        return res.json({ ok: true, n: r.rowCount });
      }
      await pool.query('UPDATE reports SET dismissed = $1 WHERE id = $2', [req.body.undo ? false : true, parseInt(req.body.id)]);
      res.json({ ok: true });
    } catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
  });

  app.get('/requests', function (req, res) { res.send(requestsPage()); });

  // Google-форма → сюда (Apps Script). Бот публикует заявку в «Заявки по клиенту» с кнопкой «Распределить»
  app.post('/api/requests/incoming', async function (req, res) {
    try {
      var token = req.query.token || req.body.token;
      if (!process.env.REQUEST_TOKEN || token !== process.env.REQUEST_TOKEN) return res.status(403).json({ ok: false, error: 'bad token' });
      var CLIENTS = process.env.CLIENTS_CHAT_ID;
      var fields = Array.isArray(req.body.fields) ? req.body.fields : [];
      var lines = fields
        .filter(function (x) { return x && String(x.a || '').trim(); })
        .map(function (x) { return String(x.q || '').replace(/[\s:]+$/, '') + ': ' + String(x.a).trim(); });
      if (!lines.length) return res.json({ ok: false, error: 'empty' });
      var text = '📩 Новая форма заполнена:\n\n' + lines.join('\n');
      var row = (await pool.query(
        "INSERT INTO reports (chat_id, first_id, msg_ids, text, author, created_at) VALUES ($1, -floor(random()*1e12)::bigint, '{}', $2, 'Google-форма', NOW()) RETURNING id",
        [CLIENTS, text])).rows[0];
      var bot = require('../bot/instance');
      var msg = await bot.telegram.sendMessage(CLIENTS, text.slice(0, 4000), {
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '⚖️ Распределить', callback_data: 'rq:' + row.id }]] }
      });
      await pool.query('UPDATE reports SET first_id=$1, msg_ids=$2 WHERE id=$3', [msg.message_id, [msg.message_id], row.id]);
      res.json({ ok: true, id: row.id });
    } catch (e) { console.error('incoming request:', e); res.status(500).json({ ok: false, error: e.message }); }
  });
}

function requestsClient() {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg && tg.ready) { tg.ready(); tg.expand(); }
  var scheme = (tg && tg.colorScheme) || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = scheme;
  try { tg.setHeaderColor(scheme === 'dark' ? '#070B16' : '#E8EEF6'); tg.setBackgroundColor(scheme === 'dark' ? '#070B16' : '#E8EEF6'); } catch (e) {}
  function $(i) { return document.getElementById(i); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmt(s) { var d = new Date(s); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''); }
  function haptic() { try { tg.HapticFeedback.selectionChanged(); } catch (e) {} }

  var seq = 0, timer = null;
  function load() {
    var my = ++seq;
    $('list').classList.add('loading');
    fetch('/api/requests?q=' + encodeURIComponent($('q').value.trim())).then(function (r) { return r.json(); }).then(function (d) {
      if (my !== seq) return;
      $('list').classList.remove('loading');
      $('count').textContent = d.ok ? d.total : '—';
      var box = $('list'); box.innerHTML = '';
      if (!d.ok) { box.appendChild(el('div', 'empty', 'Ошибка загрузки')); return; }
      if (!d.items.length) { box.appendChild(el('div', 'empty', $('q').value ? 'Ничего не найдено' : 'Все заявки распределены')); return; }
      d.items.forEach(function (it) {
        var f = it.f || {};
        var card = el('article', 'glass card');
        var top = el('div', 'ctop');
        top.appendChild(el('div', 'org', f.org || f.client || 'Без названия'));
        top.appendChild(el('div', 'date', fmt(it.created_at)));
        card.appendChild(top);
        var chips = el('div', 'chips');
        [f.kind, f.region === 'МО' ? 'Подмосковье' : f.region === 'МСК' ? 'Москва' : '', f.service].filter(Boolean).forEach(function (c) { chips.appendChild(el('span', 'chip', c)); });
        if (f.priority) chips.appendChild(el('span', 'chip hot', 'Горящий'));
        card.appendChild(chips);
        var lines = [f.inn ? 'ИНН ' + f.inn : '', f.address || f.city || '', [f.client, f.phone].filter(Boolean).join(', ')].filter(Boolean);
        lines.forEach(function (l) { card.appendChild(el('div', 'line', l)); });
        var act = el('div', 'acts');
        var go = el('button', 'go', 'Распределить'); go.type = 'button';
        go.onclick = function () { haptic(); location.href = '/handoff?request_id=' + it.id; };
        var hide = el('button', 'hide', 'Скрыть'); hide.type = 'button';
        hide.onclick = function () {
          haptic(); card.classList.add('gone');
          fetch('/api/requests/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: it.id }) })
            .then(function () { setTimeout(function () { card.remove(); $('count').textContent = Math.max(0, parseInt($('count').textContent) - 1); }, 250); });
        };
        act.appendChild(hide); act.appendChild(go);
        card.appendChild(act);
        box.appendChild(card);
      });
    });
  }
  $('q').oninput = function () { clearTimeout(timer); timer = setTimeout(load, 250); };
  $('old').onclick = function () {
    var go = function () {
      fetch('/api/requests/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ older_days: 30 }) })
        .then(function (r) { return r.json(); }).then(function (d) { load(); if (tg && tg.showAlert) tg.showAlert('Скрыто: ' + (d.n || 0)); });
    };
    if (tg && tg.showConfirm) tg.showConfirm('Скрыть все нераспределённые заявки старше 30 дней?', function (ok) { if (ok) go(); });
    else if (confirm('Скрыть все нераспределённые заявки старше 30 дней?')) go();
  };
  load();
}

function requestsPage() {
  var css = [
    ':root{--bg:#E8EEF6;--ink:#0E1A2B;--ink2:#5B6B82;--glass:rgba(255,255,255,.56);--glass2:rgba(255,255,255,.74);--edge:rgba(255,255,255,.85);--well:rgba(14,26,43,.06);--ok:#1FA971;--bad:#E5484D;--accent:#2F6BFF;--o1:#8EC5FF;--o2:#C3B2FF;--o3:#9CEBD3;--shadow:0 10px 30px rgba(30,52,90,.12),0 1px 2px rgba(30,52,90,.06)}',
    '[data-theme=dark]{--bg:#070B16;--ink:#EEF2F8;--ink2:#93A0B5;--glass:rgba(28,36,56,.48);--glass2:rgba(36,46,70,.66);--edge:rgba(255,255,255,.14);--well:rgba(255,255,255,.07);--ok:#2FB57C;--bad:#FF6369;--accent:#3E6EF2;--o1:#1D4ED8;--o2:#6D28D9;--o3:#0F766E;--shadow:0 12px 34px rgba(0,0,0,.45)}',
    '*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}html{background:var(--bg)}',
    'body{font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",Roboto,sans-serif;color:var(--ink);min-height:100vh;padding:0 14px 40px;letter-spacing:-.01em}',
    '.bg{position:fixed;inset:-20%;z-index:-1;pointer-events:none;filter:blur(60px);opacity:.75}[data-theme=dark] .bg{opacity:.42}',
    '.bg i{position:absolute;border-radius:50%}.bg i:nth-child(1){width:55%;height:45%;left:-5%;top:5%;background:var(--o1)}.bg i:nth-child(2){width:50%;height:45%;right:-5%;top:30%;background:var(--o2)}.bg i:nth-child(3){width:55%;height:40%;left:15%;bottom:0;background:var(--o3)}',
    '.glass{background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:1px solid var(--edge);box-shadow:var(--shadow);position:relative}',
    '.top{padding:18px 4px 12px;display:flex;align-items:flex-end;gap:12px}',
    'h1{font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.025em;flex:1}',
    '#count{font-size:15px;font-weight:700;color:#fff;background:var(--bad);border-radius:999px;padding:4px 11px;margin-bottom:3px}',
    '.bar{position:sticky;top:10px;z-index:5;display:flex;gap:8px;padding:6px;border-radius:999px;background:var(--glass2);margin-bottom:12px}',
    '#q{flex:1;border:0;background:transparent;font:inherit;font-size:15px;color:var(--ink);padding:9px 12px;outline:none}',
    '#q::placeholder{color:var(--ink2)}',
    '#old{border:0;border-radius:999px;background:var(--well);color:var(--ink2);font:inherit;font-size:13px;font-weight:600;padding:8px 12px;cursor:pointer;white-space:nowrap}',
    '.card{border-radius:20px;padding:14px 16px;margin-bottom:10px;transition:opacity .25s,transform .25s}',
    '.card.gone{opacity:0;transform:translateX(30px)}',
    '.ctop{display:flex;gap:10px;align-items:baseline}',
    '.org{flex:1;font-size:16.5px;font-weight:650;letter-spacing:-.015em;line-height:1.25}',
    '.date{font-size:12.5px;color:var(--ink2);white-space:nowrap}',
    '.chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 6px}',
    '.chip{font-size:12px;font-weight:600;padding:3px 9px;border-radius:8px;background:var(--well);color:var(--ink2)}',
    '.chip.hot{background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}',
    '.line{font-size:14px;color:var(--ink2);line-height:1.4}',
    '.acts{display:flex;gap:8px;margin-top:12px}',
    '.acts button{border:0;border-radius:12px;font:inherit;font-size:14.5px;font-weight:600;padding:11px 14px;cursor:pointer}',
    '.go{flex:1;background:var(--accent);color:#fff}.hide{background:var(--well);color:var(--ink2)}',
    '.empty{text-align:center;color:var(--ink2);padding:40px 0;font-size:15px}',
    '#list.loading{opacity:.5}',
    '@media (prefers-reduced-motion:reduce){*{transition:none!important}}'
  ].join('\n');
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">' +
    '<title>Нераспределённые заявки</title><script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>' + css + '</style></head><body>' +
    '<div class="bg" aria-hidden="true"><i></i><i></i><i></i></div>' +
    '<header class="top"><h1>Нераспределённые</h1><span id="count">…</span></header>' +
    '<div class="bar glass"><input id="q" type="search" placeholder="Поиск: название, ИНН, телефон" autocomplete="off"><button id="old" type="button" title="Скрыть заявки старше 30 дней">Скрыть старые</button></div>' +
    '<main id="list"></main>' +
    '<script>(' + requestsClient.toString() + ')();</script></body></html>';
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
      var request = null, reqId = parseInt(req.query.request_id) || 0;
      if (reqId) {
        var rq = (await pool.query('SELECT id, text, created_at FROM reports WHERE id=$1', [reqId])).rows[0];
        if (rq) request = { id: rq.id, text: rq.text, created_at: rq.created_at, f: parseRequest(rq.text) };
      }
      res.json({
        ok: true, lawyers: lawyers, request: request,
        report: audit ? { src: 'a', id: audit.id, text: audit.text, created_at: audit.created_at, order_id: audit.order_id } : null,
        order: order ? {
          id: order.id, org: order.object_name || '', client: order.owner_name || '',
          owner: order.owner_name || '', name: order.object_name || '', zones: order.zones_info || '',
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
      var contacts = Array.isArray(d.contacts) ? d.contacts.filter(function (x) { return x && (x.name || x.phone || x.tg); }).slice(0, 10) : [];
      if (contacts.length) { d.client = d.client || contacts[0].name || ''; d.phone = d.phone || contacts[0].phone || ''; }
      var picked = null;
      if (d.report_src && d.report_id) {
        picked = await getReport(d.report_src, parseInt(d.report_id));
        if (picked && picked.text) d.audit_text = picked.text;
      }
      var total = 0;
      var audit = null;
      if (picked) audit = picked;
      if (audit && audit.msg_ids) audit.msg_ids = Array.from(new Set(audit.msg_ids.concat(audit.extra || []).map(Number))).sort(function (x, y) { return x - y; }).slice(0, 100);
      if (audit && audit.text && !d.audit_text_manual) d.audit_text = audit.text;
      var c = (await pool.query(
        `INSERT INTO cases (order_id, lawyer_tg_id, lawyer_name, checklist_key, org, inn, client, phone, address,
          region, kind, service, priority, comment, audit_text, total, created_by, contacts, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [d.order_id || null, lawyer.tg_id, lawyer.name, d.checklist_key, d.org, d.inn, d.client, d.phone, d.address,
          d.region, d.kind, d.service, d.priority, d.comment, d.audit_text, total, d.tg_user_id || null, JSON.stringify(contacts), parseInt(d.request_id) || null]
      )).rows[0];

      var text = caseText(c);
      var reqRow = c.request_id ? (await pool.query('SELECT chat_id, msg_ids, first_id FROM reports WHERE id=$1', [c.request_id])).rows[0] : null;

      // 1) Чат «Заявки по клиенту»: файлы аудитора + карточка
      var CLIENTS = process.env.CLIENTS_CHAT_ID;
      if (CLIENTS) {
        if (audit && audit.msg_ids && audit.msg_ids.length) {
          try { await bot.telegram.callApi('copyMessages', { chat_id: CLIENTS, from_chat_id: audit.chat_id, message_ids: audit.msg_ids.map(Number) }); }
          catch (e) { console.error('copy to clients chat:', e.message); }
        }
        var opts = { parse_mode: 'HTML' };
        if (reqRow && String(reqRow.chat_id) === String(CLIENTS)) opts.reply_to_message_id = Number(reqRow.first_id);
        try { await bot.telegram.sendMessage(CLIENTS, text, opts); }
        catch (e) { delete opts.reply_to_message_id; await bot.telegram.sendMessage(CLIENTS, text, opts); }
        if (reqRow && String(reqRow.chat_id) === String(CLIENTS)) {
          try { await bot.telegram.editMessageReplyMarkup(CLIENTS, Number(reqRow.first_id), undefined, { inline_keyboard: [[{ text: '✅ Передано: ' + lawyer.name, callback_data: 'noop' }]] }); }
          catch (e) { /* заявка опубликована другим ботом — кнопку не поменять */ }
        }
      }

      // 2) Юристу в личку: исходная заявка, файлы аудитора, карточка + кнопка чек-листа
      if (reqRow && reqRow.msg_ids && reqRow.msg_ids.length) {
        try { await bot.telegram.callApi('copyMessages', { chat_id: lawyer.tg_id, from_chat_id: reqRow.chat_id, message_ids: reqRow.msg_ids.map(Number).sort(function (x, y) { return x - y; }) }); }
        catch (e) { console.error('copy request to lawyer:', e.message); }
      }
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

  // Запрос недостающих документов: в «Заявки по клиенту» и менеджеру
  app.post('/api/checklist/request', async function (req, res) {
    try {
      var c = (await pool.query('SELECT * FROM cases WHERE id=$1', [parseInt(req.body.case_id)])).rows[0];
      if (!c) return res.json({ ok: false, error: 'Клиент не найден' });
      var list = (req.body.missing || []).map(function (x) { return String(x).slice(0, 200); }).slice(0, 40);
      if (!list.length) return res.json({ ok: false, error: 'Список пуст' });
      var msg = '📨 <b>Запросить документы у клиента</b>\n🏢 ' + esc(c.org) + (c.inn ? ' · ИНН ' + esc(c.inn) : '') + '\n\n' +
        list.map(function (x) { return '• ' + esc(x); }).join('\n') +
        '\n\n⚖️ ' + esc(req.body.by || c.lawyer_name) + '\n#заявка' + c.id;
      var sent = 0;
      if (process.env.CLIENTS_CHAT_ID) { try { await bot.telegram.sendMessage(process.env.CLIENTS_CHAT_ID, msg, { parse_mode: 'HTML' }); sent++; } catch (e) { console.error(e.message); } }
      if (c.created_by && String(c.created_by) !== String(c.lawyer_tg_id)) { try { await bot.telegram.sendMessage(c.created_by, msg, { parse_mode: 'HTML' }); sent++; } catch (e) { console.error(e.message); } }
      res.json({ ok: sent > 0, error: sent ? null : 'Не удалось отправить' });
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
  var tg = (window.Telegram && window.Telegram.WebApp) || { ready: function () {}, expand: function () {}, close: function () { history.back(); }, showAlert: function (m, cb) { alert(m); if (cb) cb(); }, initDataUnsafe: {} };
  tg.ready(); tg.expand();
  var scheme = tg.colorScheme || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = scheme;
  try { tg.setHeaderColor(scheme === 'dark' ? '#070B16' : '#E8EEF6'); tg.setBackgroundColor(scheme === 'dark' ? '#070B16' : '#E8EEF6'); } catch (e) {}
  var Q = new URLSearchParams(location.search);
  var orderId = Q.get('order_id') || '';
  var requestId = Q.get('request_id') || '';
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
    var meta = $('chosen-meta');
    if (it.kind === 'order') {
      meta.textContent = it.linked ? 'Заявка' + (it.order_id ? ' #' + it.order_id : '') + ' + отчёт аудитора: прикрепится вместе с фото' : 'Заявка' + (it.order_id ? ' #' + it.order_id : '') + ': отчёта в ответах нет. Найдите отчёт отдельно';
      meta.className = 'chosen-m' + (it.linked ? '' : ' no');
    } else {
      meta.textContent = 'Отчёт' + (it.order_id ? ' по заявке #' + it.order_id : '') + ', ' + (it.author ? it.author + ', ' : '') + fmtDate(it.created_at);
      meta.className = 'chosen-m';
    }
    try { tg.HapticFeedback.selectionChanged(); } catch (e) {}
    fillFrom(it.text);
    fetch('/api/reports/get?src=' + it.src + '&id=' + it.id).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok || !REP || REP.id !== it.id || REP.src !== it.src) return;
      if (d.text) { REP.text = d.text; $('chosen-text').textContent = preview(d.text); fillFrom(d.text); }
    });
  }
  // ── Контакты: несколько человек, у каждого имя, телефон, ник в Telegram
  var PHONE_RE = /(?:\+7|8|7)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
  function digits(x) { return String(x || '').replace(/\D/g, '').replace(/^8/, '7'); }
  function normPhone(x) { var d = digits(x); return d.length === 11 ? '+7 ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9) : x; }
  function contactRows() { return Array.prototype.slice.call(document.querySelectorAll('#contacts .ct')); }
  function readContacts() {
    return contactRows().map(function (r) {
      return { name: r.querySelector('.c-name').value.trim(), phone: r.querySelector('.c-phone').value.trim(), tg: r.querySelector('.c-tg').value.trim().replace(/^https?:\/\/t\.me\//i, '') };
    }).filter(function (c) { return c.name || c.phone || c.tg; });
  }
  function addContact(c, force) {
    c = c || {};
    var rows = contactRows();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], ph = r.querySelector('.c-phone'), nm = r.querySelector('.c-name'), tgi = r.querySelector('.c-tg');
      var same = (c.phone && digits(ph.value) && digits(ph.value) === digits(c.phone)) || (c.tg && tgi.value && tgi.value.replace('@', '').toLowerCase() === c.tg.replace('@', '').toLowerCase());
      var empty = !nm.value && !ph.value && !tgi.value;
      if (same || (empty && !force)) {
        if (c.name && !nm.value) nm.value = c.name;
        if (c.phone && !ph.value) ph.value = normPhone(c.phone);
        if (c.tg && !tgi.value) tgi.value = c.tg.charAt(0) === '@' ? c.tg : '@' + c.tg;
        return r;
      }
    }
    var row = document.createElement('div'); row.className = 'ct';
    row.innerHTML = '<input class="c-name" placeholder="Имя" autocomplete="off">' +
      '<input class="c-phone" placeholder="+7 ..." inputmode="tel" autocomplete="off">' +
      '<input class="c-tg" placeholder="@ник в Telegram" autocomplete="off">' +
      '<button type="button" class="c-x" aria-label="Удалить контакт">✕</button>';
    row.querySelector('.c-name').value = c.name || '';
    row.querySelector('.c-phone').value = c.phone ? normPhone(c.phone) : '';
    row.querySelector('.c-tg').value = c.tg ? (c.tg.charAt(0) === '@' ? c.tg : '@' + c.tg) : '';
    row.querySelector('.c-x').onclick = function () { row.remove(); if (!contactRows().length) addContact({}, true); };
    $('contacts').appendChild(row);
    return row;
  }
  $('add-contact').onclick = function () { var r = addContact({}, true); r.querySelector('.c-name').focus(); };

  // Разбор контактов из текста: каждый телефон со своим именем и ником
  function cleanName(x) {
    var n = String(x || '').replace(/(?:https?:\/\/)?t\.me\/\S+|@[A-Za-z0-9_]+/g, ' ')
      .replace(/^[^A-Za-zА-Яа-яЁё]*(Контакты|Клиент|Имя клиента|Номер|Телефон|Тел)\s*:?\s*:?/i, ' ')
      .replace(/[^A-Za-zА-Яа-яЁё\s\-]/g, ' ').replace(/\s+/g, ' ').trim()
      .split(' ').filter(function (w) { return !/^(доп|доб|тел|моб|сумма|оплата|руб|и|номер)$/i.test(w); }).join(' ');
    n = n.split(' ').slice(0, 3).join(' ');
    return n.length > 40 || /^(контакты|клиент|номер|телефон)$/i.test(n) ? '' : n;
  }
  function nicksIn(x) { return (String(x || '').match(/(?:@|t\.me\/)([A-Za-z][A-Za-z0-9_]{3,31})/g) || []).map(function (v) { return '@' + v.replace(/^(@|t\.me\/)/, ''); }); }
  function parseContacts(t) {
    var out = [];
    String(t || '').split('\n').forEach(function (line) {
      var ms = [], m, re = new RegExp(PHONE_RE.source, 'g');
      while ((m = re.exec(line))) ms.push({ ph: m[0], start: m.index, end: m.index + m[0].length });
      if (!ms.length) {
        var nk = nicksIn(line);
        if (nk.length) out.push({ name: cleanName(line), phone: '', tg: nk[0] });
        return;
      }
      var before = line.slice(0, ms[0].start);
      ms.forEach(function (x, k) {
        var after = line.slice(x.end, k + 1 < ms.length ? ms[k + 1].start : line.length);
        var name = cleanName(after) || (k === 0 ? cleanName(before) : '');
        var nk = nicksIn(after);
        if (!nk.length && k === 0) nk = nicksIn(before);
        out.push({ name: name, phone: x.ph, tg: nk[0] || '' });
      });
    });
    return out;
  }

  // Заполняем пустые поля из текста заявки или отчёта
  function fillFrom(t) {
    t = String(t || '').replace(/[*`]/g, '');
    function set(id, v) { if (v && !$(id).value.trim()) $(id).value = v.replace(/^[\s:]+/, '').trim(); }
    function grab(re) { var m = t.match(re); return m ? m[1].trim() : ''; }
    set('inn', grab(/ИНН[^\d\n]*(\d{10,12})/i));
    var owner = grab(/(?:Чей объект|Наименование организации)\s*:\s*:?\s*([^\n]+)/i) || grab(/^\s*((?:ООО|ИП|АО|ПАО|ЗАО)\s*[^\n]*)/im);
    var oname = grab(/Название(?: объекта)?\s*:\s*([^\n]+)/i);
    set('org', owner && oname && owner.indexOf(oname) === -1 ? owner + ' (' + oname + ')' : owner || oname);
    set('address', grab(/Адрес(?: лицензирования)?\s*:\s*([^\n]+)/i));
    var who = grab(/(?:Имя клиента|Клиент)\s*:\s*:?\s*([А-Яа-яЁёA-Za-z][^\n+\d]*)/i);
    var list = parseContacts(t);
    if (who) { if (list.length && !list[0].name) list[0].name = who.trim(); else if (!list.length) list.push({ name: who.trim() }); }
    list.forEach(function (c) { addContact(c); });
    var tp = grab(/(?:Тип|Вид объекта)\s*:\s*([^\n]+)/i);
    var head = (tp + ' ' + t.slice(0, 300));
    if (/табак/i.test(head)) mark('kind', 'Табак'); else if (/магазин|розниц/i.test(head)) mark('kind', 'Магазин'); else if (/общепит/i.test(head)) mark('kind', 'Общепит');
    if (/переоформ/i.test(head)) mark('service', 'Переоформление'); else if (/продлен/i.test(head)) mark('service', 'Продление'); else if (/получен/i.test(head)) mark('service', 'Получение');
    if (/московская обл|городской округ/i.test(t)) mark('region', 'МО'); else if (/москва/i.test(head)) mark('region', 'МСК');
  }
  $('chosen-x').onclick = function () { choose(null); $('rq').focus(); };
  addContact({}, true);

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
        var tag = document.createElement('span');
        if (it.kind === 'order') { tag.className = 'tag ' + (it.linked ? 'tag-ok' : 'tag-no'); tag.textContent = it.linked ? 'Заявка · отчёт есть' : 'Заявка · отчёта нет'; }
        else { tag.className = 'tag tag-rep'; tag.textContent = 'Отчёт'; }
        m.appendChild(tag);
        m.appendChild(document.createTextNode((it.order_id ? '#' + it.order_id + ', ' : '') + (it.author ? it.author + ', ' : '') + fmtDate(it.created_at)));
        row.appendChild(m); row.appendChild(t);
        row.onclick = function () { choose(it); };
        box.appendChild(row);
      });
    });
  }
  $('rq').oninput = function () { clearTimeout(timer); timer = setTimeout(search, 250); };
  $('rq').onfocus = function () { if (!$('results').children.length) search(); };

  fetch('/api/handoff/prefill?order_id=' + orderId + '&request_id=' + requestId).then(function (r) { return r.json(); }).then(function (d) {
    var L = $('lawyers');
    if (!d.lawyers.length) { var w = document.createElement('span'); w.className = 'warn'; w.textContent = 'Нет зарегистрированных юристов. Пусть нажмут /start в боте.'; L.appendChild(w); }
    d.lawyers.forEach(function (x) {
      var p = document.createElement('div'); p.className = 'pill'; p.textContent = x.name;
      p.onclick = function () { try { tg.HapticFeedback.selectionChanged(); } catch (e) {} S.lawyer = x.tg_id; L.querySelectorAll('.pill').forEach(function (q) { q.classList.remove('on'); }); p.classList.add('on'); };
      L.appendChild(p);
    });
    if (d.order) {
      $('sub').textContent = 'По заявке на замер #' + d.order.id;
      var o = d.order;
      $('org').value = o.owner && o.name && o.owner !== o.name ? o.owner + ' (' + o.name + ')' : (o.owner || o.name || '');
      $('address').value = o.address || '';
      parseContacts(o.contacts).forEach(function (c) { addContact(c); });
      var rest = String(o.contacts || '').replace(PHONE_RE, '').replace(/@[A-Za-z0-9_]+/g, '').trim();
      $('comment').value = [o.zones ? 'Зоны: ' + o.zones : '', rest && rest.length > 15 ? rest : ''].filter(Boolean).join('\n');
      mark('region', d.order.region); mark('kind', d.order.kind);
      if (d.report) choose(d.report);
      else if (d.order.address) { $('rq').value = d.order.address.split(',').slice(-2).join(' '); search(); }
    } else if (d.request) {
      var F = d.request.f || {};
      $('sub').textContent = 'Заявка от ' + new Date(d.request.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      ['org', 'inn', 'address', 'comment'].forEach(function (k) { if (F[k]) $(k).value = F[k]; });
      if (!F.address && F.city) $('address').value = F.city;
      if (F.client || F.phone) addContact({ name: F.client || '', phone: F.phone || '' });
      fillFrom(d.request.text);
      mark('region', F.region || 'МСК'); mark('kind', F.kind || 'Общепит');
      mark('service', F.service || 'Получение');
      mark('priority', F.priority || 'обычный');
      if (/Коммент\S*\s+аудитора/i.test(d.request.text)) {
        // отчёт аудитора уже внутри заявки
        choose({ src: 'r', id: d.request.id, text: d.request.text, created_at: d.request.created_at, kind: 'report' });
      } else {
        var qv = F.inn || (F.org || '').replace(/^(ООО|ИП|АО)\s*/i, '').replace(/["«»]/g, '') || (F.address || '').split(',').slice(-2).join(' ');
        if (qv) { $('rq').value = qv; search(); }
      }
      return;
    } else { $('sub').textContent = 'Новый клиент'; mark('region', 'МСК'); mark('kind', 'Общепит'); }
    mark('service', 'Получение'); mark('priority', 'обычный');
  });

  window.send = async function () {
    if (!S.lawyer) { tg.showAlert('Выберите юриста'); return; }
    if (!$('org').value.trim()) { tg.showAlert('Укажите организацию'); return; }
    var b = $('go'); b.disabled = true; b.textContent = 'Отправляем...';
    try {
      var r = await fetch('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        order_id: orderId ? parseInt(orderId) : null, request_id: requestId ? parseInt(requestId) : null, lawyer_tg_id: S.lawyer, region: S.region, kind: S.kind, service: S.service, priority: S.priority,
        org: $('org').value.trim(), inn: $('inn').value.trim(), contacts: readContacts(),
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
  var css = [
    ':root{--bg:#E8EEF6;--ink:#0E1A2B;--ink2:#5B6B82;--glass:rgba(255,255,255,.56);--glass2:rgba(255,255,255,.74);--edge:rgba(255,255,255,.85);--hair:rgba(14,26,43,.08);--well:rgba(14,26,43,.06);',
    ' --ok:#1FA971;--bad:#E5484D;--accent:#2F6BFF;--o1:#8EC5FF;--o2:#C3B2FF;--o3:#9CEBD3;--shadow:0 10px 30px rgba(30,52,90,.12),0 1px 2px rgba(30,52,90,.06)}',
    '[data-theme=dark]{--bg:#070B16;--ink:#EEF2F8;--ink2:#93A0B5;--glass:rgba(28,36,56,.48);--glass2:rgba(36,46,70,.66);--edge:rgba(255,255,255,.14);--hair:rgba(255,255,255,.08);--well:rgba(255,255,255,.07);',
    ' --ok:#2FB57C;--bad:#FF6369;--accent:#3E6EF2;--o1:#1D4ED8;--o2:#6D28D9;--o3:#0F766E;--shadow:0 12px 34px rgba(0,0,0,.45)}',
    '*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}',
    'html{background:var(--bg)}',
    'body{font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",Roboto,sans-serif;color:var(--ink);min-height:100vh;padding:0 14px 110px;letter-spacing:-.01em}',
    '.field-bg{position:fixed;inset:-20%;z-index:-1;pointer-events:none;filter:blur(60px);opacity:.75}',
    '[data-theme=dark] .field-bg{opacity:.42}',
    '.field-bg i{position:absolute;border-radius:50%}',
    '.field-bg i:nth-child(1){width:55%;height:45%;left:-5%;top:5%;background:var(--o1)}',
    '.field-bg i:nth-child(2){width:50%;height:45%;right:-5%;top:30%;background:var(--o2)}',
    '.field-bg i:nth-child(3){width:55%;height:40%;left:15%;bottom:0;background:var(--o3)}',
    '.glass{background:var(--glass);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:1px solid var(--edge);box-shadow:var(--shadow);position:relative}',
    '.glass:before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,.35),rgba(255,255,255,0) 38%)}',
    '[data-theme=dark] .glass:before{background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,0) 40%)}',
    '.top{padding:18px 4px 14px}',
    '.kicker{font-size:13px;color:var(--ink2);font-weight:500}',
    'h1{font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-.025em;margin-top:4px}',
    '.grp{border-radius:22px;margin-bottom:12px;padding:14px 16px 16px}',
    '.grp h2{font-size:16px;font-weight:650;letter-spacing:-.015em;margin-bottom:10px;position:relative}',
    '.f{margin-top:12px}.f:first-of-type{margin-top:0}',
    '.lbl{display:block;font-size:13px;color:var(--ink2);margin-bottom:6px}',
    '.req{color:var(--bad)}',
    'input,textarea{width:100%;font:inherit;font-size:15px;color:var(--ink);background:var(--well);border:1px solid transparent;border-radius:12px;padding:11px 13px;outline:none;-webkit-appearance:none;position:relative}',
    'input::placeholder,textarea::placeholder{color:var(--ink2);opacity:.75}',
    'input:focus,textarea:focus{border-color:var(--accent);background:var(--glass2)}',
    'textarea{resize:vertical;min-height:72px}',
    '.pills{display:flex;flex-wrap:wrap;gap:6px;position:relative}',
    '.pill{padding:8px 13px;border-radius:11px;background:var(--well);font-size:14px;font-weight:550;cursor:pointer;user-select:none;transition:background .18s,color .18s,transform .12s}',
    '.pill:active{transform:scale(.96)}',
    '.pill.on{background:var(--accent);color:#fff}',
    '#lawyers .pill{padding:10px 16px;font-size:15px}',
    '#lawyers .pill.on{background:var(--ok)}',
    '.warn{font-size:13px;color:var(--bad)}',
    // поиск отчёта
    '#rq{padding-left:38px;background-image:radial-gradient(circle at 18px 50%,transparent 5px,var(--ink2) 5.5px,var(--ink2) 7px,transparent 7.5px);background-repeat:no-repeat}',
    '.res{display:block;width:100%;text-align:left;background:var(--well);color:var(--ink);border:0;border-radius:14px;padding:11px 13px;margin-top:6px;font:inherit;cursor:pointer;position:relative}',
    '.res:active{transform:scale(.99)}',
    '.res-t{font-size:14px;line-height:1.35}',
    '.res-m{display:flex;align-items:center;gap:8px;margin:0 0 5px;font-size:12px;color:var(--ink2)}',
    '.tag{font-size:11.5px;font-weight:650;padding:2px 8px;border-radius:7px}',
    '.tag-rep{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}',
    '.tag-ok{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}',
    '.tag-no{background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)}',
    '.empty{font-size:13px;color:var(--ink2);padding:10px 2px}',
    '.chosen{background:var(--glass2);border:1px solid color-mix(in srgb,var(--ok) 55%,var(--edge));border-radius:16px;padding:12px 14px;position:relative}',
    '.chosen:before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:2px;background:var(--ok)}',
    '.chosen-t{font-size:14px;line-height:1.45;white-space:pre-wrap;max-height:180px;overflow:auto;padding-right:30px}',
    '.chosen-m{font-size:12.5px;color:var(--ok);margin-top:8px;font-weight:600}',
    '.chosen-m.no{color:var(--bad)}',
    '#chosen-x,.c-x{position:absolute;width:26px;height:26px;border-radius:13px;border:0;background:var(--well);color:var(--ink2);font-size:12px;cursor:pointer;z-index:1}',
    '#chosen-x{top:10px;right:10px}',
    // контакты
    '.ct{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;border-radius:16px;background:var(--well);margin-bottom:8px;position:relative}',
    '.ct input{padding:10px 12px;font-size:14px;background:var(--glass2)}',
    '.ct .c-name{grid-column:1/-1;padding-right:40px;font-weight:600}',
    '.c-x{top:13px;right:13px}',
    '.addc{width:100%;padding:11px;border-radius:14px;border:1.5px dashed color-mix(in srgb,var(--accent) 45%,transparent);background:none;color:var(--accent);font:inherit;font-size:14px;font-weight:600;cursor:pointer}',
    // нижняя панель
    '.dock{position:fixed;left:12px;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:6;border-radius:999px;padding:7px;background:var(--glass2)}',
    '.btn{width:100%;padding:14px;border:0;border-radius:999px;background:var(--accent);color:#fff;font:inherit;font-size:16px;font-weight:650;cursor:pointer;position:relative}',
    '.btn:disabled{opacity:.6}',
    'button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '@media (prefers-reduced-motion:reduce){*{transition:none!important}}'
  ].join('\n');

  function seg(g, opts) {
    return '<div class="pills" data-g="' + g + '">' + opts.map(function (o) { return '<div class="pill" data-v="' + o[0] + '">' + o[1] + '</div>'; }).join('') + '</div>';
  }

  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">' +
    '<title>Передать юристу</title><script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>' + css + '</style></head><body>' +
    '<div class="field-bg" aria-hidden="true"><i></i><i></i><i></i></div>' +
    '<header class="top"><div class="kicker" id="sub">Загрузка…</div><h1>Передать юристу</h1></header>' +

    '<section class="glass grp"><h2>Отчёт аудитора</h2>' +
    '<input id="rq" type="search" autocomplete="off" placeholder="Адрес, название, ИНН или #номер">' +
    '<div id="chosen" class="chosen" hidden><button id="chosen-x" type="button" aria-label="Убрать отчёт">✕</button><div id="chosen-text" class="chosen-t"></div><div id="chosen-meta" class="chosen-m"></div></div>' +
    '<div id="results"></div></section>' +

    '<section class="glass grp"><h2>Клиент</h2>' +
    '<div class="f"><label class="lbl" for="org">Организация <span class="req">*</span></label><input id="org" placeholder="ООО «Название»"></div>' +
    '<div class="f"><label class="lbl" for="inn">ИНН</label><input id="inn" inputmode="numeric" placeholder="10 или 12 цифр"></div>' +
    '<div class="f"><label class="lbl" for="address">Адрес</label><textarea id="address" rows="2" style="min-height:56px"></textarea></div>' +
    '<div class="f"><span class="lbl">Контакты</span><div id="contacts"></div>' +
    '<button type="button" id="add-contact" class="addc">+ Добавить контакт</button></div>' +
    '</section>' +

    '<section class="glass grp"><h2>Лицензия</h2>' +
    '<div class="f"><span class="lbl">Регион</span>' + seg('region', [['МСК', 'Москва'], ['МО', 'Подмосковье']]) + '</div>' +
    '<div class="f"><span class="lbl">Вид объекта</span>' + seg('kind', [['Общепит', 'Общепит'], ['Магазин', 'Магазин'], ['Табак', 'Табак']]) + '</div>' +
    '<div class="f"><span class="lbl">Услуга</span>' + seg('service', [['Получение', 'Получение'], ['Продление', 'Продление'], ['Переоформление', 'Переоформление']]) + '</div>' +
    '<div class="f"><span class="lbl">Приоритет</span>' + seg('priority', [['обычный', 'Обычный'], ['🔥 горящий', 'Горящий']]) + '</div>' +
    '</section>' +

    '<section class="glass grp"><h2>Кому передать</h2>' +
    '<div class="f"><span class="lbl">Юрист <span class="req">*</span></span><div class="pills" id="lawyers"></div></div>' +
    '<div class="f"><label class="lbl" for="comment">Комментарий для юриста</label><textarea id="comment" placeholder="Что важно знать: сроки, особенности, договорённости"></textarea></div>' +
    '</section>' +

    '<div class="dock glass"><button class="btn" id="go" type="button" onclick="send()">Передать юристу</button></div>' +
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
    if (it.t === 'docs') return !!(v && v.m && it.o.every(function (x) { return v.m[x]; }));
    return v !== undefined && v !== '';
  }
  function isProblem(it) {
    var v = D[it.id];
    if (it.t === 'k') return !!(v && v.s === 'bad');
    if (it.t === 'flag') return !!(v && v.s === 'yes');
    if (it.t === 'docs') return !!(v && ((v.m && it.o.some(function (x) { return v.m[x] === 'bad'; })) || String(v.other || '').trim()));
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
      var g = group('s' + si, s.t, items, s.red, s.skip ? { mode: s.skip, label: s.skipLabel, items: items } : null);
      items.forEach(function (it) { g.body.appendChild(renderItem(it)); });
      root.appendChild(g.box);
    });
    var cm = el('section', 'glass grp');
    var ch = el('div', 'gh'); ch.appendChild(el('span', 'gt', 'Комментарий')); cm.appendChild(ch);
    var cb = el('div', 'gb'); var cr = el('div', 'row col');
    var ta = el('textarea', 'note plain'); ta.rows = 3; ta.placeholder = 'Заметки юриста по клиенту';
    ta.value = D._comment || '';
    ta.oninput = function () { D._comment = ta.value; changed(); };
    cr.appendChild(ta); cb.appendChild(cr); cm.appendChild(cb);
    root.appendChild(cm);

    window.scrollTo(0, y);
    summary();
  }
  function alertMsg(m) { if (tg && tg.showAlert) tg.showAlert(m); else alert(m); }

  function group(key, title, items, red, skip) {
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
    if (skip) {
      var sk = el('span', 'skip', skip.label || 'Пропустить');
      sk.setAttribute('role', 'button');
      sk.onclick = function (e) {
        e.stopPropagation();
        skip.items.forEach(function (it) {
          if (it.t === 'flag' && !(D[it.id] && D[it.id].s)) D[it.id] = { s: 'no', c: '', by: ME, at: today() };
          if (it.t === 'k' && !(D[it.id] && D[it.id].s)) D[it.id] = { s: skip.mode === 'no' ? 'ok' : 'na', c: '', by: ME, at: today() };
          if (it.t === 'docs') {
            D[it.id] = D[it.id] || {}; D[it.id].m = Object.assign({}, D[it.id].m || {});
            it.o.forEach(function (doc) { if (!D[it.id].m[doc]) D[it.id].m[doc] = 'ok'; });
            D[it.id].by = ME; D[it.id].at = today();
          }
        });
        OPEN[key] = false; haptic('ok'); render(); changed();
      };
      if (!items.every(resolved)) head.appendChild(sk);
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

    if (it.t === 'docs') {
      w.classList.add('col');
      var dv = v || {}, mark = dv.m || {};
      var missing = it.o.filter(function (doc) { return mark[doc] === 'bad'; });
      var answered = it.o.filter(function (doc) { return mark[doc]; }).length;
      if (missing.length) w.classList.add('st-bad'); else if (answered === it.o.length) w.classList.add('st-ok');
      var list = el('div', 'doclist');
      it.o.forEach(function (doc) {
        var dr = el('div', 'docrow' + (mark[doc] === 'bad' ? ' lack' : ''));
        dr.appendChild(el('div', 'docname', doc));
        dr.appendChild(segmented([['ok', 'Есть'], ['bad', 'Нет']], mark[doc], function (x) {
          D[it.id] = D[it.id] || {}; D[it.id].m = Object.assign({}, D[it.id].m || {});
          if (x) D[it.id].m[doc] = x; else delete D[it.id].m[doc];
          D[it.id].by = ME; D[it.id].at = today();
          haptic(x === 'bad' ? 'warn' : null); redraw();
        }, 'tri'));
        list.appendChild(dr);
      });
      w.appendChild(list);
      var other = el('input', 'inp'); other.placeholder = 'Ещё не хватает (через запятую)'; other.value = dv.other || '';
      other.oninput = function () { D[it.id] = D[it.id] || {}; D[it.id].other = other.value; changed(); };
      other.onchange = function () { redraw(); };
      w.appendChild(other);
      var extra = String(dv.other || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      if (missing.length || extra.length) {
        var req = el('button', 'sign reqbtn', dv.reqAt ? 'Запрошено ' + dv.reqAt + ' — запросить ещё раз' : 'Запросить недостающие (' + (missing.length + extra.length) + ')'); req.type = 'button';
        req.onclick = async function () {
          req.disabled = true; req.textContent = 'Отправляю…';
          try {
            var r = await fetch('/api/checklist/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ case_id: CASE.id, missing: missing.concat(extra), by: ME }) });
            var j = await r.json();
            if (!j.ok) throw new Error(j.error || 'Ошибка');
            D[it.id].reqAt = today(); haptic('ok'); redraw();
            alertMsg('Запрос отправлен в чат «Заявки по клиенту» и менеджеру');
          } catch (e) { req.disabled = false; req.textContent = 'Запросить недостающие'; alertMsg('Не отправилось: ' + e.message); }
        };
        w.appendChild(req);
      }
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
      if (it.t === 'docs' && v && isProblem(it)) {
        var ml = it.o.filter(function (x) { return v.m && v.m[x] === 'bad'; }).concat(String(v.other || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean));
        probs.push({ l: 'Не хватает документов', c: ml.join(', ') + (v.reqAt ? ' (запрошено ' + v.reqAt + ')' : ''), flag: false });
      }
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
  document.getElementById('printBtn').onclick = function () {
    // Внутри Telegram печать не работает — открываем версию для печати в браузере (там «Сохранить как PDF»)
    var url = location.origin + '/checklist?case_id=' + CASE.id + '&print=1';
    if (tg && tg.openLink && tg.initData) { flush(); tg.openLink(url); }
    else window.print();
  };
  if (/[?&]print=1/.test(location.search)) {
    Object.keys(OPEN).forEach(function (k) { OPEN[k] = true; });
    setTimeout(function () { window.print(); }, 700);
  }

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
    '.reqbtn{margin-top:10px;width:100%}.reqbtn:disabled{opacity:.6}',
    '.skip{font-size:12.5px;font-weight:650;color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);padding:5px 10px;border-radius:999px;cursor:pointer;white-space:nowrap}',
    '.doclist{margin:-2px 0 10px}',
    '.docrow{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--hair)}',
    '.docrow:last-child{border-bottom:0}',
    '.docname{flex:1;font-size:14.5px;line-height:1.3}',
    '.docrow.lack .docname{color:var(--bad);font-weight:600}',
    '.misslist{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}',
    '.miss{border:1px solid var(--hair);background:var(--well);color:var(--ink);font:inherit;font-size:13px;padding:7px 11px;border-radius:10px;cursor:pointer;text-align:left}',
    '.miss.on{background:color-mix(in srgb,var(--bad) 16%,transparent);border-color:color-mix(in srgb,var(--bad) 50%,transparent);color:var(--bad);font-weight:600}',
    '.note.plain{border-color:transparent;margin-top:0}',
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
    ' .field,.dock,#capsule .pbad,.chev,.link,.sign,.skip{display:none!important}',
    ' .docrow{padding:2px 0}.docname{font-size:11px}.docrow.lack .docname{color:#000;text-decoration:underline}',
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

module.exports = { setupHandoff: setupHandoff, saveAudit: saveAudit, setupReportsBot: setupReportsBot, setupReportsWeb: setupReportsWeb, setupRequestsWeb: setupRequestsWeb };
