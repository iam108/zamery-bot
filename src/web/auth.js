// Доступ к мини-приложению: проверка подписи Telegram (initData) и списка сотрудников
const crypto = require('crypto');
const pool = require('../db/pool');

let ready = null;
function ensureStaff() {
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS staff (
        tg_id      BIGINT PRIMARY KEY,
        name       TEXT NOT NULL,
        username   TEXT,
        role       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE staff ADD COLUMN IF NOT EXISTS approved BOOLEAN;
      UPDATE staff SET approved = true WHERE approved IS NULL;   -- кто уже был — остаётся с доступом
      ALTER TABLE staff ALTER COLUMN approved SET DEFAULT false;
      ALTER TABLE staff ADD COLUMN IF NOT EXISTS requested_role TEXT;
    `).catch(function (e) { ready = null; throw e; });
  }
  return ready;
}

// Проверка initData по документации Telegram: HMAC-SHA256 с ключом от токена бота
function checkInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const dataCheck = Array.from(p.entries())
      .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; })
      .map(function (kv) { return kv[0] + '=' + kv[1]; }).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
    if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    const authDate = parseInt(p.get('auth_date')) || 0;
    if (Date.now() / 1000 - authDate > 7 * 24 * 3600) return null; // подпись старше недели — переоткрыть форму
    return JSON.parse(p.get('user') || 'null');
  } catch (e) { return null; }
}

// Личный ключ сотрудника для кнопок клавиатуры внизу чата:
// Telegram не передаёт подпись пользователя мини-приложениям, открытым такими кнопками
function userKey(uid) {
  return crypto.createHmac('sha256', crypto.createHash('sha256').update('staffkey:' + (process.env.BOT_TOKEN || '')).digest())
    .update(String(uid)).digest('hex').slice(0, 32);
}
function keyQuery(uid) { return 'u=' + encodeURIComponent(uid) + '&k=' + userKey(uid); }
function checkUserKey(uid, key) {
  if (!uid || !key || !/^\d+$/.test(String(uid))) return null;
  const calc = userKey(uid);
  if (calc.length !== String(key).length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(String(key)))) return null;
  return { id: parseInt(uid) };
}

// Только одобренные сотрудники
async function requireStaff(req, res, next) {
  try {
    await ensureStaff();
    const user = checkInitData(req.get('X-Tg-Init')) || checkUserKey(req.get('X-Tg-U'), req.get('X-Tg-K'));
    if (!user) return res.status(401).json({ ok: false, error: 'Нет доступа. Закройте и откройте форму заново через бота.' });
    const staff = (await pool.query('SELECT * FROM staff WHERE tg_id=$1 AND approved = true', [user.id])).rows[0];
    if (!staff) return res.status(403).json({ ok: false, error: 'Нет доступа. Нажмите /start в боте и дождитесь одобрения.' });
    req.tgUser = user;
    req.staff = staff;
    next();
  } catch (e) {
    console.error('auth:', e.message);
    res.status(500).json({ ok: false, error: 'Ошибка проверки доступа' });
  }
}

// Подписанные ссылки для печати (открываются в обычном браузере, без Telegram)
function sigKey() { return crypto.createHash('sha256').update('print:' + (process.env.BOT_TOKEN || '')).digest(); }
function signCase(caseId, hours) {
  const exp = Math.floor(Date.now() / 1000) + (hours || 24) * 3600;
  const sig = crypto.createHmac('sha256', sigKey()).update(caseId + ':' + exp).digest('hex').slice(0, 32);
  return 'exp=' + exp + '&sig=' + sig;
}
function checkCaseSig(caseId, exp, sig) {
  if (!exp || !sig || Date.now() / 1000 > parseInt(exp)) return false;
  const calc = crypto.createHmac('sha256', sigKey()).update(caseId + ':' + exp).digest('hex').slice(0, 32);
  return calc.length === String(sig).length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(String(sig)));
}

// Подключается на страницах мини-приложения: добавляет подпись Telegram к каждому запросу к нашему серверу
// Ключ из ссылки запоминается на время сессии, чтобы переходы внутри приложения (список → форма) тоже работали
const CLIENT_JS = "(function(){var f=window.fetch;if(!f||f.__tg)return;" +
  "var q=new URLSearchParams(location.search),ku=q.get('u'),kk=q.get('k');" +
  "try{if(ku&&kk){sessionStorage.setItem('tg_u',ku);sessionStorage.setItem('tg_k',kk)}else{ku=sessionStorage.getItem('tg_u');kk=sessionStorage.getItem('tg_k')}}catch(e){}" +
  "var w=function(u,o){o=o||{};try{var tg=window.Telegram&&window.Telegram.WebApp;var d=tg&&tg.initData;" +
  "var s=typeof u==='string'?u:(u&&u.url)||'';" +
  "if(s.charAt(0)==='/'||s.indexOf(location.origin)===0){var h=new Headers(o.headers||{});" +
  "if(d)h.set('X-Tg-Init',d);if(ku&&kk){h.set('X-Tg-U',ku);h.set('X-Tg-K',kk)}o.headers=h;}}catch(e){}" +
  "return f.call(this,u,o)};w.__tg=1;window.fetch=w;})();";

function setupAuth(app) {
  ensureStaff().catch(function (e) { console.error('staff table:', e.message); });
  app.get('/auth.js', function (req, res) { res.type('application/javascript').set('Cache-Control', 'no-cache').send(CLIENT_JS); });
  // Все API мини-приложения — только для сотрудников. Исключение: приём заявок из Google-формы (свой токен)
  app.use(['/api/order', '/api/audit', '/api/handoff', '/api/checklist', '/api/reports', '/api/requests', '/checklist/view'], function (req, res, next) {
    if (req.baseUrl === '/api/requests' && req.path === '/incoming') return next();
    return requireStaff(req, res, next);
  });
}

module.exports = { setupAuth, requireStaff, checkInitData, signCase, checkCaseSig, ensureStaff, keyQuery };
