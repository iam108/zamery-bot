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
  if (c.audit_text) { L.push(''); L.push('🔍 <b>Комментарий аудитора:</b>'); L.push(esc(c.audit_text)); }
  if (c.comment) { L.push(''); L.push('💬 <b>Комментарий менеджера:</b>'); L.push(esc(c.comment)); }
  L.push(''); L.push('#заявка' + c.id);
  return L.join('\n');
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
      var audit = d.order_id ? (await pool.query('SELECT * FROM audits WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1', [d.order_id])).rows[0] : null;

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

function handoffPage() {
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<title>Передать юристу</title><script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>' + BASE_CSS + '</style></head><body>' +
    '<h1>⚖️ Передать юристу</h1><p class="sub" id="sub">Загрузка...</p>' +
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
    '<div class="field"><label class="l">Комментарий аудитора</label><div class="audit" id="audit">—</div></div>' +
    '<div class="field"><label class="l">Комментарий менеджера</label><textarea id="comment" placeholder="Что важно знать юристу"></textarea></div>' +
    '<div class="bottom"><button class="btn" id="go" onclick="send()">Передать юристу</button></div>' +
    '<script>' +
    'var tg=window.Telegram.WebApp;tg.ready();tg.expand();' +
    'var Q=new URLSearchParams(location.search);var orderId=Q.get("order_id")||"";var S={lawyer:null,region:"МСК",kind:"Общепит",service:"Получение",priority:"обычный"};var auditText="";' +
    'function mark(g,v){S[g]=v;document.querySelectorAll("[data-g="+g+"] .pill").forEach(function(p){p.classList.toggle("on",p.dataset.v===v)})}' +
    'document.querySelectorAll("[data-g]").forEach(function(box){box.addEventListener("click",function(e){var p=e.target.closest(".pill");if(p)mark(box.dataset.g,p.dataset.v)})});' +
    'function $(i){return document.getElementById(i)}' +
    'fetch("/api/handoff/prefill?order_id="+orderId).then(function(r){return r.json()}).then(function(d){' +
    ' var L=$("lawyers");if(!d.lawyers.length)L.innerHTML="<span style=\\"font-size:13px;color:#f87171\\">Нет зарегистрированных юристов. Пусть нажмут /start в боте.</span>";' +
    ' d.lawyers.forEach(function(x){var p=document.createElement("div");p.className="pill";p.textContent=x.name;p.onclick=function(){S.lawyer=x.tg_id;L.querySelectorAll(".pill").forEach(function(q){q.classList.remove("on")});p.classList.add("on")};L.appendChild(p)});' +
    ' if(d.order){$("sub").textContent="По заявке #"+d.order.id;$("org").value=d.order.org;$("client").value=d.order.client;$("address").value=d.order.address;$("comment").value=d.order.contacts;mark("region",d.order.region);mark("kind",d.order.kind)}else{$("sub").textContent="Новый клиент";mark("region","МСК");mark("kind","Общепит")}' +
    ' mark("service","Получение");mark("priority","обычный");' +
    ' auditText=d.audit_text||"";$("audit").textContent=auditText||"Отчёт аудитора не найден";' +
    '});' +
    'async function send(){' +
    ' if(!S.lawyer){tg.showAlert("Выберите юриста");return}' +
    ' if(!$("org").value.trim()){tg.showAlert("Укажите организацию");return}' +
    ' var b=$("go");b.disabled=true;b.textContent="Отправляем...";' +
    ' try{var r=await fetch("/api/handoff",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
    '  order_id:orderId?parseInt(orderId):null,lawyer_tg_id:S.lawyer,region:S.region,kind:S.kind,service:S.service,priority:S.priority,' +
    '  org:$("org").value.trim(),inn:$("inn").value.trim(),client:$("client").value.trim(),phone:$("phone").value.trim(),' +
    '  address:$("address").value.trim(),comment:$("comment").value.trim(),audit_text:auditText,' +
    '  tg_user_id:tg.initDataUnsafe&&tg.initDataUnsafe.user?tg.initDataUnsafe.user.id:null})});' +
    '  var j=await r.json();if(!j.ok)throw new Error(j.error||"Ошибка");' +
    '  b.textContent="✅ Передано";if(j.warn)tg.showAlert(j.warn,function(){tg.close()});else setTimeout(function(){tg.close()},1200);' +
    ' }catch(e){b.disabled=false;b.textContent="Передать юристу";tg.showAlert("Ошибка: "+e.message)}' +
    '}' +
    '</script></body></html>';
}

// Клиентский код чек-листа. Выполняется в браузере (передаётся как текст функции).
function checklistClient() {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  var CFG = window.__CFG;
  var L = CFG.list, D = CFG.data || {}, CASE = CFG.caseInfo;
  var ME = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user)
    ? [tg.initDataUnsafe.user.first_name, tg.initDataUnsafe.user.last_name].filter(Boolean).join(' ')
    : CASE.lawyer;
  var root = document.getElementById('list');

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

  function allItems() {
    var out = [];
    L.passport.forEach(function (it) { if (visible(it)) out.push(it); });
    L.sections.forEach(function (s) { s.i.forEach(function (it) { if (visible(it)) out.push(it); }); });
    return out;
  }

  // ── Пункты ─────────────────────────────────────────────
  function pills(opts, cur, onPick) {
    var w = el('div', 'pills');
    opts.forEach(function (o) {
      var b = el('div', 'pill' + (cur === o ? ' on' : ''), o);
      b.onclick = function () { onPick(cur === o ? undefined : o); };
      w.appendChild(b);
    });
    return w;
  }

  function render() {
    var y = window.scrollY;
    root.innerHTML = '';

    // Этап
    var st = el('div', 'sec');
    st.appendChild(el('h3', null, 'Этап'));
    st.appendChild(pills(CFG.stages, D._stage || CFG.stages[0], function (v) { D._stage = v || CFG.stages[0]; render(); changed(); }));
    root.appendChild(st);

    // Паспорт объекта
    var ps = el('div', 'sec');
    ps.appendChild(el('h3', null, 'Паспорт объекта'));
    L.passport.forEach(function (it) {
      if (!visible(it)) return;
      var w = el('div', 'rg');
      w.appendChild(el('div', 'tx', it.l));
      w.appendChild(pills(it.o, D[it.id], function (v) { D[it.id] = v; render(); changed(); }));
      ps.appendChild(w);
    });
    root.appendChild(ps);

    L.sections.forEach(function (s) {
      var items = s.i.filter(visible);
      if (!items.length) return;
      var sec = el('div', 'sec' + (s.red ? ' red' : ''));
      sec.appendChild(el('h3', null, s.t));
      items.forEach(function (it) { sec.appendChild(renderItem(it)); });
      root.appendChild(sec);
    });
    window.scrollTo(0, y);
    summary();
  }

  function renderItem(it) {
    var v = D[it.id];
    var w = el('div', 'it');
    var head = el('div', 'ih');
    head.appendChild(el('div', 'tx', it.l));
    w.appendChild(head);

    if (it.t === 'k') {
      var cur = v && v.s;
      var tri = el('div', 'tri');
      [['ok', '✅ ОК'], ['bad', '⚠️ Проблема'], ['na', '➖ Н/П']].forEach(function (o) {
        var b = el('b', o[0] + (cur === o[0] ? ' on' : ''), o[1]);
        b.onclick = function () {
          if (cur === o[0]) D[it.id] = undefined;
          else D[it.id] = { s: o[0], c: (v && v.c) || '', by: ME, at: today() };
          w.replaceWith(renderItem(it)); changed();
        };
        tri.appendChild(b);
      });
      head.appendChild(tri);
      if (cur) w.className = 'it st-' + cur;
      if (cur === 'bad') w.appendChild(note(it, 'Что не так?'));
      if (cur && v.by) w.appendChild(el('div', 'who', v.by + ' · ' + v.at));
    }

    if (it.t === 'flag') {
      var fs = v && v.s;
      var yn = el('div', 'tri');
      [['no', 'Нет'], ['yes', '🚩 Есть']].forEach(function (o) {
        var b = el('b', o[0] + (fs === o[0] ? ' on' : ''), o[1]);
        b.onclick = function () {
          if (fs === o[0]) D[it.id] = undefined;
          else D[it.id] = { s: o[0], c: (v && v.c) || '', by: ME, at: today() };
          w.replaceWith(renderItem(it)); changed();
        };
        yn.appendChild(b);
      });
      head.appendChild(yn);
      if (fs) w.className = 'it st-' + (fs === 'yes' ? 'bad' : 'ok');
      if (fs === 'yes') w.appendChild(note(it, 'Подробности (номер записи, дата, кем наложено)'));
    }

    if (it.t === 'r') w.appendChild(pills(it.o, v, function (x) { D[it.id] = x; w.replaceWith(renderItem(it)); changed(); }));

    if (it.t === 'f' || it.t === 'd') {
      var inp = el('input');
      if (it.t === 'd') inp.type = 'date';
      inp.value = v || '';
      inp.oninput = function () { D[it.id] = inp.value; changed(); };
      w.appendChild(inp);
    }

    if (it.t === 'term') {
      var tv = v || {};
      var row = el('div', 'two');
      var a = el('input'); a.type = 'date'; a.value = tv.from || '';
      var b2 = el('input'); b2.type = 'date'; b2.value = tv.to || '';
      var info = el('div', 'who');
      function upd() {
        D[it.id] = { from: a.value, to: b2.value };
        var m = termMonths(D[it.id]);
        info.textContent = m == null ? '' : (m < 12 ? '⚠️ Срок ' + m + ' мес. — меньше года (16,5%)' : '✅ Срок ' + Math.floor(m / 12) + ' г. ' + (m % 12) + ' мес.');
        info.className = 'who' + (m != null && m < 12 ? ' warn' : '');
      }
      a.oninput = function () { upd(); changed(); };
      b2.oninput = function () { upd(); changed(); };
      row.appendChild(labeled('с', a)); row.appendChild(labeled('по', b2));
      w.appendChild(row); w.appendChild(info);
      if (tv.from && tv.to) upd();
    }

    if (it.t === 'sig') {
      if (v && v.at) {
        w.className = 'it st-ok';
        var who = el('div', 'who', '✍️ ' + v.by + ' · ' + v.at);
        var undo = el('b', 'undo', 'отменить');
        undo.onclick = function () { D[it.id] = undefined; w.replaceWith(renderItem(it)); changed(); };
        who.appendChild(undo);
        w.appendChild(who);
      } else {
        var btn = el('button', 'signbtn', '✍️ Подтвердить');
        btn.onclick = function () { D[it.id] = { by: ME, at: today() }; w.replaceWith(renderItem(it)); changed(); };
        w.appendChild(btn);
      }
    }
    return w;
  }

  function labeled(t, input) { var x = el('label', 'lb'); x.appendChild(el('span', null, t)); x.appendChild(input); return x; }

  function note(it, ph) {
    var t = el('textarea', 'note');
    t.placeholder = ph;
    t.value = (D[it.id] && D[it.id].c) || '';
    t.oninput = function () { D[it.id].c = t.value; changed(); summaryLater(); };
    return t;
  }

  // ── Итоги ─────────────────────────────────────────────
  function stats() {
    var items = allItems(), done = 0, probs = [], na = 0;
    items.forEach(function (it) {
      if (resolved(it)) done++;
      var v = D[it.id];
      if (it.t === 'k' && v && v.s === 'bad') probs.push({ l: it.l, c: v.c, flag: false });
      if (it.t === 'k' && v && v.s === 'na') na++;
      if (it.t === 'flag' && v && v.s === 'yes') probs.push({ l: it.l, c: v.c, flag: true });
      if (it.t === 'term') { var m = termMonths(v); if (m != null && m < 12) probs.push({ l: 'Срок договора меньше года (16,5%)', c: m + ' мес.', flag: false }); }
    });
    return { total: items.length, done: done, probs: probs, na: na };
  }

  var sumTimer = null;
  function summaryLater() { clearTimeout(sumTimer); sumTimer = setTimeout(summary, 400); }
  function summary() {
    var s = stats();
    document.getElementById('cnt').textContent = 'Заполнено ' + s.done + ' из ' + s.total + (s.na ? ' · Н/П: ' + s.na : '') + (s.probs.length ? ' · проблем: ' + s.probs.length : '');
    document.getElementById('bar').style.width = (s.total ? Math.min(100, s.done * 100 / s.total) : 0) + '%';
    var box = document.getElementById('probs');
    box.innerHTML = '';
    if (!s.probs.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.appendChild(el('div', 'pt', '⚠️ Проблемы и риски (' + s.probs.length + ')'));
    s.probs.forEach(function (p) {
      var r = el('div', 'pr' + (p.flag ? ' fl' : ''));
      r.appendChild(el('b', null, (p.flag ? '🚩 ' : '• ') + p.l));
      if (p.c) r.appendChild(el('span', null, ' — ' + p.c));
      box.appendChild(r);
    });
  }

  // ── Сохранение ────────────────────────────────────────
  var timer = null;
  function changed() { summary(); setSt('Изменения...'); clearTimeout(timer); timer = setTimeout(flush, 800); }
  function setSt(t) { document.getElementById('st').textContent = t; }
  async function flush(manual) {
    clearTimeout(timer);
    var s = stats();
    try {
      var r = await fetch('/api/checklist/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ case_id: CASE.id, data: D, done: s.done, total: s.total })
      });
      var j = await r.json();
      setSt(j.ok ? '✓ Сохранено' : 'Ошибка сохранения');
      if (manual && tg) tg.showAlert(j.ok ? 'Сохранено' : 'Ошибка сохранения');
    } catch (e) { setSt('Нет связи — не сохранено'); }
  }
  window.saveNow = function () { flush(true); };

  render();
}

function checklistPage(c, L) {
  var css = BASE_CSS + '\n' + [
    '.card{background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.5;margin-bottom:12px}',
    '.prog{height:8px;background:rgba(128,128,128,.25);border-radius:4px;overflow:hidden;margin:6px 0 14px}',
    '.prog i{display:block;height:100%;background:#22c55e;width:0;transition:width .2s}',
    '#probs{display:none;border:1.5px solid #f87171;border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:14px;line-height:1.45}',
    '#probs .pt{font-weight:700;color:#f87171;margin-bottom:6px}',
    '#probs .pr{margin-bottom:4px}#probs .pr.fl b{color:#f87171}',
    '.sec{margin-bottom:18px}',
    '.sec h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--tg-theme-hint-color,#64748b);margin-bottom:8px}',
    '.sec.red h3{color:#f87171}',
    '.it,.rg{padding:11px 12px;background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;margin-bottom:6px;border-left:4px solid transparent}',
    '.it.st-ok{border-left-color:#22c55e}.it.st-bad{border-left-color:#f87171}.it.st-na{border-left-color:#64748b;opacity:.7}',
    '.ih{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}',
    '.tx{font-size:14px;line-height:1.4;flex:1}',
    '.rg .tx{font-size:13px;color:var(--tg-theme-hint-color,#64748b);margin-bottom:8px}',
    '.tri{display:flex;gap:4px;flex-shrink:0}',
    '.tri b{font-weight:500;font-size:12px;padding:6px 8px;border-radius:8px;background:var(--tg-theme-bg-color,#0f172a);cursor:pointer;white-space:nowrap;user-select:none}',
    '.tri b.ok.on,.tri b.no.on{background:#22c55e;color:#fff}.tri b.bad.on,.tri b.yes.on{background:#f87171;color:#fff}.tri b.na.on{background:#64748b;color:#fff}',
    '.it input,.it textarea{margin-top:8px;padding:9px 10px;font-size:14px;background:var(--tg-theme-bg-color,#0f172a)}',
    '.it textarea.note{min-height:56px;border:1px solid #f87171}',
    '.rg .pill,.it .pill{background:var(--tg-theme-bg-color,#0f172a)}.it .pills{margin-top:8px}',
    '.two{display:flex;gap:8px}.two .lb{flex:1}.lb span{font-size:11px;color:var(--tg-theme-hint-color,#64748b)}',
    '.who{font-size:12px;color:var(--tg-theme-hint-color,#64748b);margin-top:6px}.who.warn{color:#f59e0b;font-weight:600}',
    '.undo{margin-left:10px;font-weight:500;text-decoration:underline;cursor:pointer}',
    '.signbtn{margin-top:8px;padding:10px 14px;border:none;border-radius:10px;background:var(--tg-theme-button-color,#6366f1);color:#fff;font-size:14px;cursor:pointer}',
    '.save{font-size:12px;color:var(--tg-theme-hint-color,#64748b);text-align:center;margin-top:6px}',
    '@media print{',
    ' body{background:#fff;color:#000;padding:0;font-size:11px}.bottom,.save,.prog,.signbtn,.undo{display:none}',
    ' .card,.it,.rg{background:#fff;border:1px solid #bbb;padding:3px 6px;margin-bottom:2px;border-radius:3px}',
    ' .it.st-ok{border-left:4px solid #000}.it.st-bad{border-left:4px solid #000;background:#eee}.it.st-na{opacity:1}',
    ' .tri b{background:#fff;border:1px solid #bbb;padding:1px 4px;font-size:10px}.tri b:not(.on){display:none}.tri b.on{background:#fff!important;color:#000!important;border:1.5px solid #000;font-weight:700}',
    ' .pill{background:#fff!important;border:1px solid #bbb;padding:1px 5px;font-size:10px}.pill:not(.on){display:none}.pill.on{border:1.5px solid #000;color:#000;font-weight:700}',
    ' input,textarea{background:#fff!important;border:none!important;border-bottom:1px solid #999!important;border-radius:0;color:#000;padding:1px;margin-top:2px;min-height:0}',
    ' #probs{border:2px solid #000}#probs .pt,#probs .pr.fl b{color:#000}',
    ' .sec{margin-bottom:6px;break-inside:avoid}.sec h3{color:#000;margin-bottom:3px}h1{font-size:15px}',
    '}'
  ].join('\n');

  var info = [
    '<b>' + esc(c.org) + '</b>' + (c.inn ? ' · ИНН ' + esc(c.inn) : ''),
    esc(c.kind) + ' · ' + esc(c.region) + ' · ' + esc(c.service),
    c.address ? '📍 ' + esc(c.address) : '',
    '👤 ' + esc(c.client) + ' ' + esc(c.phone || ''),
    '⚖️ ' + esc(c.lawyer_name)
  ].filter(Boolean).join('<br>');

  var cfg = {
    list: L, data: c.data || {}, stages: STAGES,
    caseInfo: { id: c.id, service: c.service, lawyer: c.lawyer_name }
  };

  return '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<title>Чек-лист · ' + esc(c.org) + '</title><script src="https://telegram.org/js/telegram-web-app.js"></script>' +
    '<style>' + css + '</style></head><body>' +
    '<h1>📋 ' + esc(L.title) + '</h1>' +
    '<div class="card">' + info + '</div>' +
    '<div style="font-size:13px" id="cnt"></div><div class="prog"><i id="bar"></i></div>' +
    '<div id="probs"></div>' +
    '<div id="list"></div><div class="save" id="st"></div>' +
    '<div class="bottom"><button class="btn sec" onclick="window.print()">🖨 Печать</button><button class="btn" onclick="saveNow()">💾 Сохранить</button></div>' +
    '<script>window.__CFG=' + json(cfg) + ';(' + checklistClient.toString() + ')();</script>' +
    '</body></html>';
}


module.exports = { setupHandoff: setupHandoff, saveAudit: saveAudit };
