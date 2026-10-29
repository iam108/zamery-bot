const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const pool = require('../db/pool');
const path = require('path');
const { getOrders, getOrderById, updateOrderStatus, getOrderLogs, getStats } = require('../db/queries');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function setupWeb(app) {
  
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.use(express.static(path.join(__dirname, '../../public')));

  app.use(session({
    store: new PgSession({ pool: pool, tableName: 'web_sessions' }),
    secret: process.env.SESSION_SECRET || 'zamery-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 86400000 },
  }));

  require('./auth').setupAuth(app);
  require('../db/pool').query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS submitted_name TEXT').catch((e) => console.error('orders.submitted_name:', e.message));

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
    const order = await getOrderById(parseInt(req.params.id) || 0);
    if (!order) return res.status(404).send('Заявка не найдена');
    const logs = await getOrderLogs(order.id);
    res.send(orderDetailPage(order, logs));
  });

  app.post('/admin/api/status', requireAuth, async (req, res) => {
    const { id, status } = req.body;
    if (['new', 'in_progress', 'done', 'cancelled'].indexOf(status) === -1) return res.status(400).json({ ok: false });
    const order = await updateOrderStatus(parseInt(id), status, 'admin-web');
    res.json({ ok: true, order });
  });

  // Общий пакет менеджера: новая заявка или дополнение существующей.
  require('./manager-orders').setupManagerOrders(app);

  require('./order-materials').setupOrderMaterials(app);
  require('./order-archive').setupOrderArchive(app);

  require('./audit-drafts').setupAuditDrafts(app);

  // API для отчёта аудитора
  app.get('/api/audit/prefill', async (req, res) => {
    try {
      const id = Number(req.query.order_id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Некорректный номер заявки' });
      const materialStore = require('./order-materials');
      await materialStore.ensureOrderMaterials();
      const order = await getOrderById(id);
      if (!order) return res.status(404).json({ ok: false, error: 'Заявка не найдена' });
      const type = String(order.object_type || '').toLowerCase();
      const category = /табак/.test(type) ? 'tobacco' : /общепит/.test(type) ? 'catering' : /магазин|рознич|торговл/.test(type) ? 'retail' : 'other';
      const materials = await materialStore.listOrderMaterials(order.id);
      res.json({ ok: true, order_id: order.id, org: order.owner_name || order.object_name || '', object_name: order.object_name || '', address: order.address || '', object_category: category,
        service: order.service || '', region: 'МСК', cad_num: order.cad_num || '', archive_url: order.service === 'Продление' ? order.archive_url || '' : '',
        zones_info: order.zones_info || '', has_video: !!order.has_video, video_required: !!order.has_video, contacts: order.contacts || '', deadline: order.deadline || null,
        status: order.status || 'new', materials, materials_download_url: '/api/audit/orders/' + order.id + '/materials/download-all',
        archive_download_url: order.service === 'Продление' ? (materials.some(file => file.role === 'archive') ? '/api/audit/orders/' + order.id + '/materials/download-all?role=archive' : order.archive_url ? '/api/audit/orders/' + order.id + '/archive/download' : '') : '',
        can_edit_packet: req.staff.role === 'manager' || String(order.submitted_by) === String(req.tgUser.id),
        manager_edit_url: '/form?order_id=' + order.id, telegram_msg_id: order.telegram_msg_id || null });
    } catch (e) {
      console.error('audit prefill:', e.message);
      res.status(500).json({ ok: false, error: 'Не удалось загрузить данные заявки' });
    }
  });
  app.post('/api/audit', async (req, res) => {
  try {
    const data = req.body;
    const { handleAuditReport } = require('../bot/audit-handler');
    const botInstance = require('../bot/instance');
    const fakeCtx = {
      from: { id: req.tgUser.id, username: req.tgUser.username || null, first_name: req.staff.name },
      telegram: botInstance.telegram,
      reply: async () => {},
    };
    if (data.draft_id) {
      const drafts = require('./audit-drafts');
      const submit = require('./audit-submit').createAuditSubmitter(drafts, handleAuditReport, { loadPacket: require('./audit-packet').loadAuditPacket });
      return res.json(await submit(req.tgUser.id, data.draft_id, data.revision, fakeCtx));
    }
    if (data.schema_version === 3) return res.status(400).json({ ok: false, error: 'Сначала сохраните черновик новой формы.' });
    await handleAuditReport(fakeCtx, data);
    res.json({ ok: true });
  } catch (e) {
    console.error('api/audit error:', e);
    res.status(e.status || 400).json({ ok: false, error: e.message });
  }
});
  // ── Stats page ───────────────────────────────────────────
  app.get('/admin/stats', requireAuth, async (req, res) => {
    const { getStatsByMonth, getStatsByType } = require('../db/queries');
    const byMonth = await getStatsByMonth();
    const byType = await getStatsByType();
    res.send(statsPage({ byMonth, byType }));
  });

  // ── Objects page ─────────────────────────────────────────
  app.get('/admin/objects', requireAuth, async (req, res) => {
    const { searchObjects } = require('../db/queries');
    const { search = '' } = req.query;
    const objects = await searchObjects({ search });
    res.send(objectsPage({ objects, search }));
  });

  app.get('/admin/objects/detail', requireAuth, async (req, res) => {
    const { getOrdersByObject } = require('../db/queries');
    const { address, name } = req.query;
    const orders = await getOrdersByObject(address, name);
    res.send(objectDetailPage({ orders, address, name }));
  });
    app.use(function(err, req, res, next) {
    console.error('server error:', err.message);
    res.status(200).json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (макс 50 МБ)' : err.message });
  });
  app.get('/form', (req, res) => res.send(miniAppForm()));

  const { auditForm } = require('./audit-form');
  const auditWizard = require('./audit-wizard');
  app.get('/audit', (req, res) => res.send(auditWizard()));
  app.get('/audit/legacy', (req, res) => res.send(auditForm()));
  app.get('/audit-wizard.css', (req, res) => res.type('text/css').send(auditWizard.css()));
  app.get('/audit-wizard-client.js', (req, res) => res.type('application/javascript').send(auditWizard.client()));
  app.get('/audit-plan-editor.js', (req, res) => res.sendFile(require('path').join(__dirname, 'audit-plan-editor.js')));
    require('./handoff').setupHandoff(app);
    require('./handoff').setupReportsWeb(app, upload);
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
    return `<tr onclick="location='/admin/order/${parseInt(o.id)}'" style="cursor:pointer">
      <td><strong>#${o.id}</strong></td><td>${esc(o.owner_name)}</td>
      <td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(o.address)}</td>
      <td>${esc(o.object_type)}</td>
      <td style="color:${isOverdue ? '#f87171' : 'inherit'}">${d}</td>
      <td><span class="badge" style="background:${statusColors[o.status]}20;color:${statusColors[o.status]};border:1px solid ${statusColors[o.status]}40">${statusLabels[o.status]}</span></td>
      <td style="color:#64748b;font-size:12px">${created}</td>
    </tr>`;
  }).join('');
  const pager = totalPages > 1 ? Array.from({length:totalPages},(_,i)=>i+1)
    .map(p=>`<a href="?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}&page=${p}" class="${p===page?'active':''}">${p}</a>`).join('') : '';
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
<div class="topbar"><h1>📋 Замеры</h1><div style="display:flex;gap:8px;align-items:center"><a href="/admin/stats" style="padding:6px 12px;border:1px solid #334155;border-radius:8px;font-size:13px;color:#94a3b8;text-decoration:none">📊 Стат</a><a href="/admin/objects" style="padding:6px 12px;border:1px solid #334155;border-radius:8px;font-size:13px;color:#94a3b8;text-decoration:none">🏢 Объекты</a><a href="/admin/logout" style="color:#94a3b8;font-size:13px;text-decoration:none">Выйти</a></div></div>
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
    <input name="search" placeholder="Поиск по адресу, имени, контакту..." value="${esc(search)}">
    <input type="hidden" name="status" value="${esc(status)}">
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
    return `<div class="log-row"><span class="log-time">${t}</span><span class="log-actor">${esc(l.actor)}</span><span class="log-action">${esc(l.details||l.action)}</span></div>`;
  }).join('') || '<div style="color:#64748b;padding:16px">Нет записей</div>';
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Заявка #${esc(order.id)}</title>
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
    <p style="margin-bottom:16px"><a href="/form?order_id=${parseInt(order.id)}" style="color:#a5b4fc">Данные и документы заявки →</a></p>
    <div class="field"><span class="field-label">Адрес</span><span>${esc(order.address)}</span></div>
    <div class="field"><span class="field-label">Чей объект</span><span>${esc(order.owner_name)}</span></div>
    <div class="field"><span class="field-label">Тип</span><span>${esc(order.object_type)}</span></div>
    ${order.object_name?`<div class="field"><span class="field-label">Название</span><span>${esc(order.object_name)}</span></div>`:''}
    <div class="field"><span class="field-label">Видео</span><span>${order.has_video?'✅ Да':'— Нет'}</span></div>
    ${order.zones_info?`<div class="field"><span class="field-label">Зоны</span><span>${esc(order.zones_info)}</span></div>`:''}
    <div class="field"><span class="field-label">Крайний срок</span><span>${deadline}</span></div>
    ${order.contacts?`<div class="field"><span class="field-label">Контакты</span><span>${esc(order.contacts)}</span></div>`:''}
    <div class="field"><span class="field-label">Статус</span>
      <span class="badge" style="background:${statusColors[order.status]}20;color:${statusColors[order.status]};border:1px solid ${statusColors[order.status]}40">${statusLabels[order.status]}</span>
    </div>
    ${order.submitted_name ? `<div class="field"><span class="field-label">Оставил(а)</span><span>${esc(order.submitted_name)}</span></div>` : ''}
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
  const r = await fetch('/admin/api/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: ${parseInt(order.id)}, status }) });
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
<script src="/auth.js"><\/script>
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
<h1 id="form-heading">📋 Заявка на выезд · Москва</h1>
<p style="font-size:14px;line-height:1.5;margin-bottom:20px;color:var(--tg-theme-hint-color,#94a3b8)">Заполняет менеджер. Данные и все приложенные документы автоматически получит аудитор.</p>
<p id="packet-status" role="status" style="font-size:14px;line-height:1.5;margin-bottom:16px" hidden></p>
<button id="packet-retry" type="button" onclick="loadExistingPacket()" style="padding:10px 14px;margin-bottom:16px" hidden>Повторить загрузку</button>
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
  <select id="object_type" onchange="updateService()">
    <option value="">— выбрать —</option>
    <option value="Общепит алкоголь">🍺 Общепит алкоголь</option>
    <option value="Розничная торговля">🛒 Розничная торговля</option>
    <option value="Табак">🚬 Табак</option>
    <option value="Другое">📦 Другое</option>
</select>
  <div class="err" id="err-object_type">Выберите тип</div>
</div>
<div class="field" id="service-field">
  <label for="service">Услуга <span class="required">*</span></label>
  <select id="service" onchange="updateService()">
    <option value="">— выбрать —</option>
    <option>Получение</option><option>Продление</option><option>Переоформление</option>
  </select>
  <div class="err" id="err-service">Выберите услугу</div>
</div>
<div class="field" id="archive-field" style="display:none">
  <label for="archive_url">Архив объекта для продления</label>
  <input id="archive_url" type="url" maxlength="2000" placeholder="Ссылка на папку или файл объекта в Яндекс Диске">
  <p style="font-size:13px;line-height:1.5;color:var(--tg-theme-hint-color,#94a3b8);margin-top:7px">Добавьте ссылку именно этого объекта или прикрепите архивные материалы ниже с назначением «Архив». Аудитор получит их вместе с заявкой.</p>
  <a href="https://disk.360.yandex.ru/d/RPoUCOS6PFusPQ" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:8px;color:var(--tg-theme-link-color,#7bb5ff)">Открыть общий архив ↗</a>
  <div class="err" id="err-archive_url">Для продления нужна ссылка на архив объекта или файл с назначением «Архив»</div>
</div>
<div class="field">
  <label>Название объекта</label>
  <input id="object_name" type="text" placeholder="Например: Кафе «Весна»">
</div>
<div class="field">
  <div class="toggle-row" onclick="toggleVideo(event)" style="cursor:pointer">
    <span>🎥 Нужно видео</span>
    <label class="toggle" onclick="event.stopPropagation()">
      <input type="checkbox" id="has_video">
      <span class="slider"></span>
    </label>
  </div>
</div>
<div class="field">
  <label>Кадастровый номер (для выписки ЕГРН)</label>
  <input id="cad_num" type="text" inputmode="decimal" placeholder="77:17:0120316:38939">
  <div class="toggle-row" onclick="toggleEgrn(event)" style="cursor:pointer;margin-top:8px">
    <span style="font-size:14px">📄 Заказать выписку, если её ещё нет</span>
    <label class="toggle" onclick="event.stopPropagation()">
      <input type="checkbox" id="egrn_order">
      <span class="slider"></span>
    </label>
  </div>
</div>
<div class="field">
  <label>Информация о зонах</label>
  <textarea id="zones_info" placeholder="Что проверить на выезде, известные организации рядом, особенности объекта" maxlength="4000"></textarea>
</div>
<div class="field">
  <label>Крайний срок</label>
  <input id="deadline" type="date">
</div>
<div class="field">
  <label>Контакты и доп. информация</label>
  <textarea id="contacts" placeholder="Имя и телефон человека на объекте, комментарий менеджера" maxlength="4000"></textarea>
</div>
<div class="field">
  <label>Пакет документов аудитору</label>
  <p style="font-size:13px;line-height:1.5;color:var(--tg-theme-hint-color,#94a3b8);margin-bottom:8px">План, выписка ЕГРН, материалы прошлого продления и другие документы. До 20 файлов, каждый до 12 МБ, всего до 100 МБ. Аудитор сможет скачать всё одним ZIP.</p>
  <div id="existing-files" style="margin-bottom:10px"></div>
  <label class="toggle-row" style="cursor:pointer;justify-content:flex-start;gap:12px">
    <span>📎 Прикрепить файлы</span>
    <span class="file-count" id="file-count" style="color:var(--tg-theme-hint-color,#64748b);font-size:13px">не выбрано</span>
    <input type="file" id="attachments" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip" multiple style="display:none" onchange="previewFiles(this)">
  </label>
  <div id="files-preview" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"></div>
</div>
<div class="bottom">
  <button class="submit-btn" id="submit-btn" onclick="submitForm()">Отправить заявку</button>
</div>
<script>
var tg = (window.Telegram && window.Telegram.WebApp) || {
  ready: function () {}, expand: function () {}, close: function () {},
  showAlert: function (m) { alert(m); }, initDataUnsafe: {}
};
try { tg.ready(); tg.expand(); } catch (e) {}
function tgUserId() {
  try { return tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : ''; } catch (e) { return ''; }
}
function toggleEgrn(e) {
  if (e) e.stopPropagation();
  var cb = document.getElementById('egrn_order');
  cb.checked = !cb.checked;
}
function toggleVideo(e) {
  if (e) e.stopPropagation();
  var cb = document.getElementById('has_video');
  cb.checked = !cb.checked;
}
var attachedFiles = [];
var existingFiles = [];
var editOrderId = new URLSearchParams(location.search).get('order_id');
var packetReady = !editOrderId, packetCanEdit = !editOrderId;
var submitId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function enablePacketEditing(enabled) {
  document.querySelectorAll('input,select,textarea').forEach(function(el){el.disabled=!enabled;});
  document.getElementById('submit-btn').disabled = !enabled;
}
async function downloadExistingFile(file, button) {
  var label = button.textContent; button.disabled=true;button.textContent='Скачиваем…';
  try {
    var response=await fetch(file.url); if(!response.ok) { var failure=await response.json(); throw new Error(failure.error || 'Не удалось скачать документ.'); }
    var blob=await response.blob(), url=URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url;link.download=file.name;document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url);},60000);
  } catch(e) { tg.showAlert(e.message); }
  finally {button.disabled=false;button.textContent=label;}
}
function renderExistingFiles() {
  var box=document.getElementById('existing-files');box.innerHTML='';
  if(!existingFiles.length) return;
  var note=document.createElement('p');note.textContent='Уже в заявке · '+existingFiles.length+' файл(ов). Повторно прикреплять не нужно.';note.style.cssText='font-size:13px;line-height:1.5;margin:10px 0';box.appendChild(note);
  existingFiles.forEach(function(file){
    var button=document.createElement('button');button.type='button';button.textContent='↓ '+file.name;button.style.cssText='display:block;text-align:left;overflow-wrap:anywhere;width:100%;padding:12px;border:0;border-radius:10px;background:var(--tg-theme-secondary-bg-color,#1e293b);color:var(--tg-theme-link-color,#7bb5ff);margin-bottom:6px;font-size:14px';button.onclick=function(){downloadExistingFile(file,button);};box.appendChild(button);
  });
}
async function loadExistingPacket() {
  if(!editOrderId) return;
  packetReady=false;packetCanEdit=false;enablePacketEditing(false);
  var status=document.getElementById('packet-status');status.hidden=false;status.textContent='Загружаем заявку #'+editOrderId+'…';document.getElementById('packet-retry').hidden=true;
  document.getElementById('form-heading').textContent='📋 Заявка #'+editOrderId+' · Москва';
  document.getElementById('submit-btn').textContent='Сохранить изменения';
  try {
    var response=await fetch('/api/order/'+encodeURIComponent(editOrderId)), data=await response.json();
    if(!response.ok || !data.ok) throw new Error(data.error || 'Не удалось открыть заявку.');
    var order=data.order;
    ['address','owner_name','object_type','object_name','service','cad_num','archive_url','zones_info','contacts'].forEach(function(id){
      var field=document.getElementById(id),value=order[id] || '';
      if(field.tagName === 'SELECT' && value && !Array.from(field.options).some(function(option){return option.value===value;})) {var option=document.createElement('option');option.value=value;option.textContent=value;field.appendChild(option);}
      field.value=value;
    });
    document.getElementById('deadline').value=order.deadline ? String(order.deadline).slice(0,10) : '';
    document.getElementById('has_video').checked=!!order.has_video;
    document.getElementById('egrn_order').checked=false;
    existingFiles=data.materials || [];renderExistingFiles();renderFiles();updateService();
    packetReady=true;packetCanEdit=!!data.can_edit;enablePacketEditing(packetCanEdit);
    status.textContent=packetCanEdit ? 'Изменения попадут в эту же заявку. Можно добавить документы — сохранённые файлы останутся в пакете аудитора.' : 'Просмотр заявки. Дополнить её может автор или менеджер.';
  } catch(e) { status.textContent=e.message;document.getElementById('packet-retry').hidden=false; }
}
function updateService() {
  var other = /табак|другое/i.test(document.getElementById('object_type').value);
  document.getElementById('service-field').style.display = other ? 'none' : '';
  document.getElementById('archive-field').style.display = !other && document.getElementById('service').value === 'Продление' ? '' : 'none';
}
function materialRole(name) { return /егрн|egrn|выписк/i.test(name) ? 'egrn' : /архив|archive/i.test(name) ? 'archive' : /план|график|бти|bti|plan/i.test(name) ? 'plan' : 'document'; }
function previewFiles(input) {
  var incoming = Array.from(input.files || []); input.value = '';
  var total = attachedFiles.reduce(function(n,f) { return n + f.size; }, existingFiles.reduce(function(n,f){return n+f.bytes;},0));
  for (var f of incoming) {
    if (attachedFiles.some(function(old) { return old.name === f.name && old.size === f.size && old.lastModified === f.lastModified; })) continue;
    if (f.size > 12*1024*1024 || total + f.size > 100*1024*1024 || attachedFiles.length+existingFiles.length >= 20) { tg.showAlert('До 20 файлов: каждый не больше 12 МБ, общий объём до 100 МБ, включая уже сохранённые. Файл «' + f.name + '» не добавлен.'); continue; }
    f.materialRole = materialRole(f.name); attachedFiles.push(f); total += f.size;
  }
  renderFiles();
}
function renderFiles() {
  document.getElementById('file-count').textContent = attachedFiles.length ? attachedFiles.length + ' файл(ов)' : 'не выбрано';
  var p = document.getElementById('files-preview'); p.innerHTML = ''; p.style.display = 'block';
  attachedFiles.forEach(function(f,index) {
    var tag = document.createElement('div'); tag.style.cssText = 'padding:12px;background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;font-size:13px;margin-top:8px';
    var name = document.createElement('div'); name.textContent = f.name; name.style.cssText = 'overflow-wrap:anywhere;margin-bottom:7px'; tag.appendChild(name);
    var select = document.createElement('select'); select.setAttribute('aria-label','Назначение файла '+f.name); select.style.cssText='font-size:14px;padding:9px;margin-bottom:7px';
    [['plan','План / графика'],['egrn','Выписка ЕГРН'],['archive','Архив прошлого продления'],['document','Другой документ / фото']].forEach(function(item) { var option = document.createElement('option'); option.value=item[0]; option.textContent=item[1]; select.appendChild(option); });
    select.value=f.materialRole; select.onchange=function(){f.materialRole=select.value;}; tag.appendChild(select);
    var remove = document.createElement('button'); remove.type='button'; remove.textContent='Убрать файл'; remove.style.cssText='border:0;background:none;color:#f87171;font:inherit;padding:6px 0'; remove.onclick=function(){attachedFiles.splice(index,1);renderFiles();};tag.appendChild(remove);p.appendChild(tag);
  });
}
function fileToBase64(file) {
  return new Promise(function(res) { var r = new FileReader(); r.onload = function() { res(r.result.split(',')[1]); }; r.readAsDataURL(file); });
}
async function submitForm() {
  if(!packetReady || !packetCanEdit) return;
  var valid = true;
  ['address','owner_name','object_type'].forEach(function(id) {
    var el = document.getElementById(id);
    var err = document.getElementById('err-' + id);
    if (!el.value.trim()) { err.classList.add('show'); el.style.borderColor='#f87171'; valid=false; }
    else { err.classList.remove('show'); el.style.borderColor='transparent'; }
  });
  var alcohol = !/табак|другое/i.test(document.getElementById('object_type').value);
  var service = alcohol ? document.getElementById('service').value : '';
  var serviceError = document.getElementById('err-service');
  serviceError.classList.toggle('show', alcohol && !service); if (alcohol && !service) valid = false;
  var archiveMissing = service === 'Продление' && !document.getElementById('archive_url').value.trim() && !attachedFiles.some(function(f){return f.materialRole === 'archive';}) && !existingFiles.some(function(f){return f.role === 'archive';});
  document.getElementById('err-archive_url').classList.toggle('show', archiveMissing); if (archiveMissing) valid=false;
  if (!valid) return;
  var btn = document.getElementById('submit-btn');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = 'Отправляем...';
  try {
  var formData = new FormData();
formData.append('address', document.getElementById('address').value.trim());
formData.append('owner_name', document.getElementById('owner_name').value.trim());
formData.append('object_type', document.getElementById('object_type').value);
formData.append('object_name', document.getElementById('object_name').value.trim());
formData.append('service', service);
formData.append('archive_url', service === 'Продление' ? document.getElementById('archive_url').value.trim() : '');
formData.append('file_roles', JSON.stringify(attachedFiles.map(function(f){return f.materialRole || 'document';})));
formData.append('has_video', document.getElementById('has_video').checked);
formData.append('zones_info', document.getElementById('zones_info').value.trim());
formData.append('deadline', document.getElementById('deadline').value || '');
formData.append('contacts', document.getElementById('contacts').value.trim());
formData.append('tg_user_id', tgUserId());
formData.append('cad_num', document.getElementById('cad_num').value.trim());
formData.append('egrn_order', document.getElementById('egrn_order').checked ? '1' : '');
attachedFiles.forEach(function(f) {
  formData.append('files', f, f.name);
});
formData.append('submit_id', submitId);
var result = null, lastErr = '';
var waits = [0, 8, 15, 30];
for (var attempt = 0; attempt < waits.length; attempt++) {
  for (var s = waits[attempt]; s > 0; s--) { btn.textContent = 'Сервер занят, повтор через ' + s + ' с…'; await new Promise(function (ok) { setTimeout(ok, 1000); }); }
  btn.textContent = attempt ? 'Отправляем ещё раз…' : 'Отправляем...';
  try {
    var r = await fetch('/api/order'+(editOrderId ? '/'+encodeURIComponent(editOrderId) : ''), { method: 'POST', body: formData });
    var txt = await r.text();
    try { result = JSON.parse(txt); } catch (pe) { result = null; }
    if (result && result.ok) break;
    var snippet = String(txt || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    lastErr = result ? (result.error || 'ошибка сервера') + ' [' + r.status + ']' : 'сервер ответил ' + r.status + (snippet ? ': ' + snippet : '');
    var retry = r.status === 429 || r.status === 409 || r.status >= 500 || !result || (result && result.busy);
    if (!retry) break;
  } catch (ne) { lastErr = 'нет связи (' + ne.message + ')'; }
  result = null;
}
    if (result && result.ok) {
      if (result.warning) { btn.disabled = false; btn.textContent = 'Повторить доставку'; tg.showAlert(result.warning); return; }
      if(editOrderId) {
        attachedFiles=[];submitId=Date.now().toString(36)+Math.random().toString(36).slice(2,8);
        await loadExistingPacket();tg.showAlert('Заявка #'+result.id+' обновлена. Пакет документов доступен аудитору.');return;
      }
      btn.textContent = '✅ Заявка отправлена!';
if (attachedFiles.length > 0) {
    tg.showAlert('Заявка #' + result.id + ' принята, файлы прикреплены.', function () { tg.close(); });
} else {
  setTimeout(function() { tg.close(); }, 1500);
}
    } else { throw new Error(lastErr || 'ошибка сервера'); }
  } catch(e) {
    btn.disabled = false; btn.textContent = editOrderId ? 'Сохранить изменения' : 'Отправить заявку';
    tg.showAlert('Заявка не отправлена: ' + e.message + '. Данные остались в форме — попробуйте ещё раз.');
  }
}
if(editOrderId) loadExistingPacket();
<\/script></body></html>`;
}
function statsPage({ byMonth, byType }) {
  const statusColors = { new:'#6366f1', in_progress:'#f59e0b', done:'#22c55e', cancelled:'#6b7280' };
  
  const monthRows = byMonth.map(r => {
    const d = new Date(r.month + '-01').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    const pct = r.total > 0 ? Math.round(r.done / r.total * 100) : 0;
    return `<tr>
      <td>${d}</td>
      <td style="font-weight:600">${r.total}</td>
      <td style="color:#22c55e">${r.done}</td>
      <td style="color:#6b7280">${r.cancelled}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:6px;background:#1a2744;border-radius:3px">
            <div style="width:${pct}%;height:100%;background:#22c55e;border-radius:3px"></div>
          </div>
          <span style="font-size:12px;color:#64748b;width:32px">${pct}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');

  const typeRows = byType.map(r => {
    const pct = r.total > 0 ? Math.round(r.done / r.total * 100) : 0;
    return `<tr>
      <td>${esc(r.object_type || '—')}</td>
      <td style="font-weight:600">${r.total}</td>
      <td style="color:#22c55e">${r.done}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:6px;background:#1a2744;border-radius:3px">
            <div style="width:${pct}%;height:100%;background:#6366f1;border-radius:3px"></div>
          </div>
          <span style="font-size:12px;color:#64748b;width:32px">${pct}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Статистика — Замеры</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh}
  .topbar{background:#1e293b;border-bottom:1px solid #334155;padding:0 24px;height:60px;display:flex;align-items:center;gap:16px}
  .topbar a{color:#94a3b8;font-size:13px;text-decoration:none}
  .topbar h1{font-size:17px;font-weight:700;flex:1}
  .nav{display:flex;gap:8px}
  .nav a{padding:6px 14px;border-radius:8px;text-decoration:none;font-size:13px;color:#94a3b8;border:1px solid #334155}
  .nav a:hover,.nav a.active{background:#6366f1;color:#fff;border-color:#6366f1}
  .main{padding:24px;max-width:1000px;margin:0 auto}
  h2{font-size:15px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:16px;margin-top:32px}
  h2:first-child{margin-top:0}
  .table-wrap{background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{padding:12px 16px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1px solid #334155}
  td{padding:13px 16px;border-bottom:1px solid #1a2744;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#263351}
</style></head><body>
<div class="topbar">
  <a href="/admin">← Назад</a>
  <h1>📊 Статистика</h1>
  <div class="nav">
    <a href="/admin/stats" class="active">📊 Статистика</a>
    <a href="/admin/objects">🏢 Объекты</a>
  </div>
</div>
<div class="main">
  <h2>По месяцам</h2>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Месяц</th><th>Всего</th><th>Выполнено</th><th>Отменено</th><th>Успешность</th></tr></thead>
      <tbody>${monthRows || '<tr><td colspan="5" style="text-align:center;padding:32px;color:#64748b">Нет данных</td></tr>'}</tbody>
    </table>
  </div>

  <h2>По типам объектов</h2>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Тип объекта</th><th>Всего</th><th>Выполнено</th><th>Конверсия</th></tr></thead>
      <tbody>${typeRows || '<tr><td colspan="4" style="text-align:center;padding:32px;color:#64748b">Нет данных</td></tr>'}</tbody>
    </table>
  </div>
</div></body></html>`;
}

function objectsPage({ objects, search }) {
  const rows = objects.map(o => {
    const last = new Date(o.last_visit).toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric' });
    const name = o.object_name || '—';
    const params = new URLSearchParams({ address: o.address, name: o.object_name || '' });
    return `<tr onclick="location='/admin/objects/detail?${params}'" style="cursor:pointer">
      <td><strong>${esc(name)}</strong><div style="font-size:12px;color:#64748b;margin-top:2px">${esc(o.address)}</div></td>
      <td>${esc(o.object_type || '—')}</td>
      <td style="text-align:center"><span style="background:#6366f120;color:#6366f1;border:1px solid #6366f140;padding:3px 10px;border-radius:20px;font-size:13px">${o.visits}</span></td>
      <td style="color:#22c55e">${o.done_count}</td>
      <td style="color:#64748b;font-size:12px">${last}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Объекты — Замеры</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh}
  .topbar{background:#1e293b;border-bottom:1px solid #334155;padding:0 24px;height:60px;display:flex;align-items:center;gap:16px}
  .topbar a{color:#94a3b8;font-size:13px;text-decoration:none}
  .topbar h1{font-size:17px;font-weight:700;flex:1}
  .nav{display:flex;gap:8px}
  .nav a{padding:6px 14px;border-radius:8px;text-decoration:none;font-size:13px;color:#94a3b8;border:1px solid #334155}
  .nav a:hover,.nav a.active{background:#6366f1;color:#fff;border-color:#6366f1}
  .main{padding:24px;max-width:1000px;margin:0 auto}
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
</style></head><body>
<div class="topbar">
  <a href="/admin">← Назад</a>
  <h1>🏢 Объекты</h1>
  <div class="nav">
    <a href="/admin/stats">📊 Статистика</a>
    <a href="/admin/objects" class="active">🏢 Объекты</a>
  </div>
</div>
<div class="main">
  <form class="search-row" method="GET" action="/admin/objects">
    <input name="search" placeholder="Поиск по названию, адресу, контакту..." value="${esc(search)}" autofocus>
    <button type="submit">Найти</button>
  </form>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Объект</th><th>Тип</th><th>Визитов</th><th>Выполнено</th><th>Последний визит</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:32px;color:#64748b">Ничего не найдено</td></tr>'}</tbody>
    </table>
  </div>
</div></body></html>`;
}

function objectDetailPage({ orders, address, name }) {
  const statusColors = { new:'#6366f1', in_progress:'#f59e0b', done:'#22c55e', cancelled:'#6b7280' };
  const statusLabels = { new:'Новая', in_progress:'В работе', done:'Готово', cancelled:'Отменена' };

  const rows = orders.map(o => {
    const d = new Date(o.created_at).toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric' });
    const deadline = o.deadline ? new Date(o.deadline).toLocaleDateString('ru-RU') : '—';
    return `<tr onclick="location='/admin/order/${parseInt(o.id)}'" style="cursor:pointer">
      <td><strong>#${o.id}</strong></td>
      <td style="color:#64748b;font-size:13px">${d}</td>
      <td>${deadline}</td>
      <td>${esc(o.contacts || '—')}</td>
      <td><span style="background:${statusColors[o.status]}20;color:${statusColors[o.status]};border:1px solid ${statusColors[o.status]}40;padding:3px 10px;border-radius:20px;font-size:12px">${statusLabels[o.status]}</span></td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name || address)} — Замеры</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh}
  .topbar{background:#1e293b;border-bottom:1px solid #334155;padding:0 24px;height:60px;display:flex;align-items:center;gap:16px}
  .topbar a{color:#94a3b8;font-size:13px;text-decoration:none}
  .topbar h1{font-size:16px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .main{padding:24px;max-width:900px;margin:0 auto}
  .meta{background:#1e293b;border-radius:12px;border:1px solid #334155;padding:20px;margin-bottom:20px}
  .meta .addr{font-size:13px;color:#64748b;margin-top:4px}
  .meta .count{font-size:28px;font-weight:700;color:#6366f1;margin-top:12px}
  .meta .count-label{font-size:12px;color:#64748b}
  .table-wrap{background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{padding:12px 16px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1px solid #334155}
  td{padding:13px 16px;border-bottom:1px solid #1a2744;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#263351}
</style></head><body>
<div class="topbar">
  <a href="/admin/objects">← Объекты</a>
  <h1>${esc(name || address)}</h1>
</div>
<div class="main">
  <div class="meta">
    <div style="font-size:16px;font-weight:600">${esc(name || '—')}</div>
    <div class="addr">📍 ${esc(address)}</div>
    <div class="count">${orders.length}</div>
    <div class="count-label">визитов всего</div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Дата</th><th>Дедлайн</th><th>Контакты</th><th>Статус</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:32px;color:#64748b">Нет заявок</td></tr>'}</tbody>
    </table>
  </div>
</div></body></html>`;
}
module.exports = { setupWeb, miniAppForm };
