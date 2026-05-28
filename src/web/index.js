const express = require('express');
const session = require('express-session');
const path = require('path');
const { getOrders, getOrderById, updateOrderStatus, getOrderLogs, getStats, createOrder, addLog, setTelegramMsgId } = require('../db/queries');

function setupWeb(app) {
  

  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.use(express.static(path.join(__dirname, '../../public')));

  app.use(session({
    secret: process.env.SESSION_SECRET || 'zamery-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 86400000 },
  }));

  const requireAuth = (req, res, next) => {
    if (req.session.auth) return next();
    res.redirect('/admin/login');
  };

  app.get('/admin/login', (req, res) => res.send(loginPage()));
  app.post('/admin/login', (req, res) => {
    if (req.body.password === process.env.ADMIN_PASSWORD) {
      req.session.auth = true;
      res.redirect('/admin');
    } else {
      res.send(loginPage('Неверный пароль'));
    }
  });
  app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

  app.get('/admin', requireAuth, async (req, res) => {
    const stats = await getStats();
    const { status = 'all', search = '', page = 1 } = req.query;
    const limit = 20;
    const offset = (parseInt(page) - 1) * limit;
    const { orders, total } = await getOrders({ status, search, limit, offset });
    const totalPages = Math.ceil(total / limit);
    res.send(adminPage({ orders, stats, status, search, page: parseInt(page), totalPages, total }));
  });

  app.get('/admin/order/:id', requireAuth, async (req, res) => {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).send('Заявка не найдена');
    const logs = await getOrderLogs(order.id);
    res.send(orderDetailPage(order, logs));
  });

  app.post('/admin/api/status', requireAuth, async (req, res) => {
    const { id, status } = req.body;
    const order = await updateOrderStatus(id, status, 'admin-web');
    res.json({ ok: true, order });
  });

  // API для Mini App формы заявки
  app.post('/api/order', async (req, res) => {
    try {
      const data = req.body;
      const order = await createOrder(data);
      await addLog(order.id, 'created', String(data.tg_user_id || 'web'), 'Заявка создана через Mini App');

      const { formatOrderMessage } = require('../bot/formatter');
      const botInstance = require('../bot/instance');
      const text = formatOrderMessage(order);
      const msg = await botInstance.telegram.sendMessage(process.env.GROUP_CHAT_ID, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '🔧 Взять в работу', callback_data: 'status:in_progress:' + order.id },
          { text: '✅ Готово', callback_data: 'status:done:' + order.id },
        ]]}
      });
      await setTelegramMsgId(order.id, msg.message_id);
      res.json({ ok: true, id: order.id });
    } catch (e) {
      console.error('api/order error:', e);
      res.json({ ok: false, error: e.message });
    }
  });

  // API для отчёта аудитора
  app.post('/api/audit', async (req, res) => {
  try {
    const data = req.body;
    const { handleAuditReport } = require('../bot/audit-handler');
    const { Telegraf } = require('telegraf');
    const botInstance = new Telegraf(process.env.BOT_TOKEN);
    const fakeCtx = {
      from: { id: data.tg_user_id, username: null, first_name: 'аудитор' },
      telegram: botInstance.telegram,
      reply: async () => {},
    };
    await handleAuditReport(fakeCtx, data);
    res.json({ ok: true });
  } catch (e) {
    console.error('api/audit error:', e);
    res.json({ ok: false, error: e.message });
  }
});

  app.get('/form', (req, res) => res.send(miniAppForm()));

  const { auditForm } = require('./audit-form');
  app.get('/audit', (req, res) => res.send(auditForm()));
}

function loginPage(error = '') {
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Вход — Замеры</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#1e293b;border-radius:16px;padding:40px;width:100%;max-width:360px;box-shadow:0 25px 50px rgba(0,0,0,.5)}
  h1{color:#f1f5f9;font-size:24px;margin-bottom:8px}
  p{color:#94a3b8;font-size:14px;margin-bottom:32px}
  input{width:100%;padding:12px 16px;background:#0f172a;border:1px solid #334155;border-radius:10px;color:#f1f5f9;font-size:16px;outline:none}
  input:focus{border-color:#6366f1}
  button{width:100%;padding:13px;background:#6366f1;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;margin-top:12px}
  button:hover{background:#4f46e5}
  .err{color:#f87171;font-size:13px;margin-top:12px;text-align:center}
</style></head><body>
<div class="card">
  <h1>🔐 Вход</h1>
  <p>Панель управления заявками</p>
  <form method="POST" action="/admin/login">
    <input type="password" name="password" placeholder="Пароль" autofocus required>
    <button type="submit">Войти</button>
    ${error ? `<div class="err">${error}</div>` : ''}
  </form>
</div></body></html>`;
}

function adminPage({ orders, stats, status, search, page, totalPages, total }) {
  const statusOptions = [
    { value: 'all', label: 'Все' },
    { value: 'new', label: '🆕 Новые' },
    { value: 'in_progress', label: '🔧 В работе' },
    { value: 'done', label: '✅ Выполнены' },
    { value: 'cancelled', label: '❌ Отменены' },
  ];
  const statusColors = { new:'#6366f1', in_progress:'#f59e0b', done:'#22c55e', cancelled:'#6b7280' };
  const statusLabels = { new:'Новая', in_progress:'В работе', done:'Готово', cancelled:'Отменена' };
  const rows = orders.map(o => {
    const d = o.deadline ? new Date(o.deadline).toLocaleDateString('ru-RU') : '—';
    const created = new Date(o.created_at).toLocaleDateString('ru-RU', { day:'numeric', month:'short' });
    const isOverdue = o.deadline && new Date(o.deadline) < new Date() && !['done','cancelled'].includes(o.status);
    return `<tr onclick="location='/admin/order/${o.id}'" style="cursor:pointer">
      <td><strong>#${o.id}</strong></td><td>${o.owner_name}</td>
      <td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${o.address}</td>
      <td>${o.object_type}</td>
      <td style="color:${isOverdue ? '#f87171' : 'inherit'}">${d}</td>
      <td><span class="badge" style="background:${statusColors[o.status]}20;color:${statusColors[o.status]};border:1px solid ${statusColors[o.status]}40">${statusLabels[o.status]}</span></td>
      <td style="color:#64748b;font-size:12px">${created}</td>
    </tr>`;
  }).join('');
  const pager = totalPages > 1 ? Array.from({length:totalPages},(_,i)=>i+1)
    .map(p=>`<a href="?status=${status}&search=${encodeURIComponent(search)}&page=${p}" class="${p===page?'active':''}">${p}</a>`).join('') : '';
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Замеры — Панель</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh}
  .topbar{background:#1e293b;border-bottom:1px solid #334155;padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between}
  .topbar h1{font-size:18px;font-weight:700}
  .topbar a{color:#94a3b8;font-size:13px;text-decoration:none}
  .main{padding:24px;max-width:1200px;margin:0 auto}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
  .stat{background:#1e293b;border-radius:12px;padding:16px 20px;border:1px solid #334155}
  .stat .num{font-size:28px;font-weight:700;line-height:1}
  .stat .lbl{font-size:12px;color:#94a3b8;margin-top:4px}
  .filters{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
  .filters a{padding:7px 14px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500;background:#1e293b;color:#94a3b8;border:1px solid #334155;transition:all .15s}
  .filters a.active,.filters a:hover{background:#6366f1;color:#fff;border-color:#6366f1}
  .search-row{display:flex;gap:10px;margin-bottom:20px}
  .search-row input{flex:1;padding:10px 14px;background:#1e293b;border:1px solid #334155;border-radius:10px;color:#f1f5f9;font-size:14px;outline:none}
  .search-row input:focus{border-color:#6366f1}
  .search-row button{padding:10px 20px;background:#6366f1;color:#fff;border:none;border-radius:10px;font-size:14px;cursor:pointer;font-weight:500}
  .table-wrap{background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{padding:12px 16px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1px solid #334155}
  td{padding:13px 16px;border-bottom:1px solid #1a2744;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#263351}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:500}
  .pager{display:flex;gap:6px;margin-top:16px;justify-content:center}
  .pager a{padding:6px 12px;background:#1e293b;border:1px solid #334155;border-radius:8px;color:#94a3b8;text-decoration:none;font-size:13px}
  .pager a.active,.pager a:hover{background:#6366f1;color:#fff;border-color:#6366f1}
  .total{color:#64748b;font-size:13px;margin-bottom:10px}
</style></head><body>
<div class="topbar"><h1>📋 Замеры</h1><a href="/admin/logout">Выйти</a></div>
<div class="main">
  <div class="stats">
    <div class="stat"><div class="num" style="color:#6366f1">${stats.new_count}</div><div class="lbl">🆕 Новые</div></div>
    <div class="stat"><div class="num" style="color:#f59e0b">${stats.in_progress_count}</div><div class="lbl">🔧 В работе</div></div>
    <div class="stat"><div class="num" style="color:#22c55e">${stats.done_count}</div><div class="lbl">✅ Выполнены</div></div>
    <div class="stat"><div class="num" style="color:#f87171">${stats.overdue_count}</div><div class="lbl">⚠️ Просрочены</div></div>
    <div class="stat"><div class="num">${stats.total_count}</div><div class="lbl">📁 Всего</div></div>
  </div>
  <div class="filters">
    ${statusOptions.map(o=>`<a href="?status=${o.value}&search=${encodeURIComponent(search)}&page=1" class="${status===o.value?'active':''}">${o.label}</a>`).join('')}
  </div>
  <form class="search-row" method="GET" action="/admin">
    <input name="search" placeholder="Поиск по адресу, имени, контакту..." value="${search}">
    <input type="hidden" name="status" value="${status}">
    <input type="hidden" name="page" value="1">
    <button type="submit">Найти</button>
  </form>
  <div class="total">Найдено: ${total}</div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Объект</th><th>Адрес</th><th>Тип</th><th>Дедлайн</th><th>Статус</th><th>Создана</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:32px;color:#64748b">Заявок не найдено</td></tr>'}</tbody>
    </table>
  </div>
  ${pager ? `<div class="pager">${pager}</div>` : ''}
</div></body></html>`;
}

function orderDetailPage(order, logs) {
  const statusColors = { new:'#6366f1', in_progress:'#f59e0b', done:'#22c55e', cancelled:'#6b7280' };
  const statusLabels = { new:'Новая', in_progress:'В работе', done:'Готово', cancelled:'Отменена' };
  const deadline = order.deadline ? new Date(order.deadline).toLocaleDateString('ru-RU') : '—';
  const created = new Date(order.created_at).toLocaleString('ru-RU');
  const logRows = logs.map(l => {
    const t = new Date(l.created_at).toLocaleString('ru-RU');
    return `<div class="log-row"><span class="log-time">${t}</span><span class="log-actor">${l.actor}</span><span class="log-action">${l.details||l.action}</span></div>`;
  }).join('') || '<div style="color:#64748b;padding:16px">Нет записей</div>';
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Заявка #${order.id}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9}
  .topbar{background:#1e293b;border-bottom:1px solid #334155;padding:0 24px;height:60px;display:flex;align-items:center;gap:16px}
  .topbar a{color:#94a3b8;font-size:13px;text-decoration:none}
  .topbar h1{font-size:17px;font-weight:700;flex:1}
  .main{padding:24px;max-width:800px;margin:0 auto}
  .card{background:#1e293b;border-radius:12px;border:1px solid #334155;padding:24px;margin-bottom:16px}
  .card h2{font-size:14px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:16px}
  .field{display:grid;grid-template-columns:160px 1fr;gap:8px;padding:10px 0;border-bottom:1px solid #1a2744;font-size:14px}
  .field:last-child{border-bottom:none}
  .field-label{color:#64748b}
  .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:500}
  .status-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
  .status-btns button{padding:8px 16px;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer}
  .log-row{display:grid;grid-template-columns:160px 80px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid #1a2744;font-size:13px}
  .log-time{color:#64748b} .log-actor{color:#6366f1;font-weight:500} .log-action{color:#cbd5e1}
</style></head><body>
<div class="topbar"><a href="/admin">← Назад</a><h1>Заявка #${order.id}</h1></div>
<div class="main">
  <div class="card">
    <h2>Данные заявки</h2>
    <div class="field"><span class="field-label">Адрес</span><span>${order.address}</span></div>
    <div class="field"><span class="field-label">Чей объект</span><span>${order.owner_name}</span></div>
    <div class="field"><span class="field-label">Тип</span><span>${order.object_type}</span></div>
    ${order.object_name?`<div class="field"><span class="field-label">Название</span><span>${order.object_name}</span></div>`:''}
    <div class="field"><span class="field-label">Видео</span><span>${order.has_video?'✅ Да':'— Нет'}</span></div>
    ${order.zones_info?`<div class="field"><span class="field-label">Зоны</span><span>${order.zones_info}</span></div>`:''}
    <div class="field"><span class="field-label">Крайний срок</span><span>${deadline}</span></div>
    ${order.contacts?`<div class="field"><span class="field-label">Контакты</span><span>${order.contacts}</span></div>`:''}
    <div class="field"><span class="field-label">Статус</span>
      <span class="badge" style="background:${statusColors[order.status]}20;color:${statusColors[order.status]};border:1px solid ${statusColors[order.status]}40">${statusLabels[order.status]}</span>
    </div>
    <div class="field"><span class="field-label">Создана</span><span style="color:#64748b;font-size:13px">${created}</span></div>
  </div>
  <div class="card">
    <h2>Изменить статус</h2>
    <div class="status-btns">
      <button onclick="setStatus('new')" style="background:#6366f120;color:#6366f1;border:1px solid #6366f140">🆕 Новая</button>
      <button onclick="setStatus('in_progress')" style="background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b40">🔧 В работе</button>
      <button onclick="setStatus('done')" style="background:#22c55e20;color:#22c55e;border:1px solid #22c55e40">✅ Готово</button>
      <button onclick="setStatus('cancelled')" style="background:#6b728020;color:#9ca3af;border:1px solid #6b728040">❌ Отменить</button>
    </div>
  </div>
  <div class="card"><h2>История изменений</h2>${logRows}</div>
</div>
<script>
async function setStatus(status) {
  const r = await fetch('/admin/api/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: ${order.id}, status }) });
  if (r.ok) location.reload();
}
</script></body></html>`;
}

function miniAppForm() {
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Новая заявка</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--tg-theme-bg-color,#0f172a);color:var(--tg-theme-text-color,#f1f5f9);padding:16px 16px 100px}
  h1{font-size:20px;font-weight:700;margin-bottom:20px;padding-top:8px}
  .field{margin-bottom:16px}
  label{display:block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--tg-theme-hint-color,#64748b);margin-bottom:6px}
  input,select,textarea{width:100%;padding:12px 14px;background:var(--tg-theme-secondary-bg-color,#1e293b);border:1.5px solid transparent;border-radius:12px;color:var(--tg-theme-text-color,#f1f5f9);font-size:15px;outline:none;transition:border-color .2s;-webkit-appearance:none}
  input:focus,select:focus,textarea:focus{border-color:var(--tg-theme-button-color,#6366f1)}
  textarea{resize:none;min-height:80px}
  .toggle-row{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;cursor:pointer}
  .toggle{position:relative;width:48px;height:28px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0;position:absolute}
  .slider{position:absolute;inset:0;background:#334155;border-radius:14px;transition:.2s}
  .slider:before{content:'';position:absolute;width:22px;height:22px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
  .toggle input:checked+.slider{background:var(--tg-theme-button-color,#6366f1)}
  .toggle input:checked+.slider:before{transform:translateX(20px)}
  .required{color:#f87171}
  .err{color:#f87171;font-size:12px;margin-top:4px;display:none}
  .err.show{display:block}
  .bottom{position:fixed;bottom:0;left:0;right:0;padding:12px 16px;background:var(--tg-theme-bg-color,#0f172a);border-top:1px solid #334155}
  .submit-btn{width:100%;padding:15px;background:var(--tg-theme-button-color,#6366f1);color:var(--tg-theme-button-text-color,#fff);border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer}
  .submit-btn:disabled{opacity:.5}
</style></head><body>
<h1>📋 Новая заявка</h1>
<div class="field">
  <label>Адрес объекта <span class="required">*</span></label>
  <input id="address" type="text" placeholder="Город, улица, дом">
  <div class="err" id="err-address">Укажите адрес</div>
</div>
<div class="field">
  <label>Чей объект <span class="required">*</span></label>
  <input id="owner_name" type="text" placeholder="Имя владельца или организация">
  <div class="err" id="err-owner_name">Укажите владельца</div>
</div>
<div class="field">
  <label>Тип объекта <span class="required">*</span></label>
  <select id="object_type">
    <option value="">— выбрать —</option>
    <option>Общепит алкоголь</option>
    <option>Общепит безалкоголь</option>
    <option>Розничная торговля</option>
    <option>Склад</option>
    <option>Офис</option>
    <option>Производство</option>
    <option>Другое</option>
  </select>
  <div class="err" id="err-object_type">Выберите тип</div>
</div>
<div class="field">
  <label>Название объекта</label>
  <input id="object_name" type="text" placeholder="Например: Кафе «Весна»">
</div>
<div class="field">
  <div class="toggle-row" onclick="toggleVideo()">
    <span>🎥 Нужно видео</span>
    <div class="toggle"><input type="checkbox" id="has_video"><span class="slider"></span></div>
  </div>
</div>
<div class="field">
  <label>Информация о зонах</label>
  <textarea id="zones_info" placeholder="Описание зон, площадь, особенности..."></textarea>
</div>
<div class="field">
  <label>Крайний срок</label>
  <input id="deadline" type="date">
</div>
<div class="field">
  <label>Контакты и доп. информация</label>
  <textarea id="contacts" placeholder="Телефон, имя контакта, сумма, примечания..."></textarea>
</div>
<div class="bottom">
  <button class="submit-btn" id="submit-btn" onclick="submitForm()">Отправить заявку</button>
</div>
<script>
var tg = window.Telegram.WebApp;
tg.ready(); tg.expand();
function toggleVideo() {
  var cb = document.getElementById('has_video');
  cb.checked = !cb.checked;
}
async function submitForm() {
  var valid = true;
  ['address','owner_name','object_type'].forEach(function(id) {
    var el = document.getElementById(id);
    var err = document.getElementById('err-' + id);
    if (!el.value.trim()) { err.classList.add('show'); el.style.borderColor='#f87171'; valid=false; }
    else { err.classList.remove('show'); el.style.borderColor='transparent'; }
  });
  if (!valid) return;
  var btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Отправляем...';
  try {
    var r = await fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address:     document.getElementById('address').value.trim(),
        owner_name:  document.getElementById('owner_name').value.trim(),
        object_type: document.getElementById('object_type').value,
        object_name: document.getElementById('object_name').value.trim(),
        has_video:   document.getElementById('has_video').checked,
        zones_info:  document.getElementById('zones_info').value.trim(),
        deadline:    document.getElementById('deadline').value || null,
        contacts:    document.getElementById('contacts').value.trim(),
        tg_user_id:  tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : null,
      }),
    });
    var result = await r.json();
    if (result.ok) {
      btn.textContent = '✅ Заявка отправлена!';
      setTimeout(function() { tg.close(); }, 1500);
    } else { throw new Error(result.error || 'Ошибка сервера'); }
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Отправить заявку';
    alert('Ошибка: ' + e.message);
  }
}
<\/script></body></html>`;
}

module.exports = { setupWeb };
