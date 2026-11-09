// Доступ к мини-приложению: проверка подписи Telegram (initData) и списка сотрудников
const crypto = require('crypto');
const pool = require('../db/pool');

function equalHex(expected, value) {
  return typeof value === 'string' && value.length === expected.length &&
    /^[a-f0-9]+$/.test(value) && crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'));
}

function canManageCases(staff, userId) {
  if (!staff || staff.approved !== true) return false;
  const admins = String(process.env.ADMIN_TG_IDS || '').split(/[\s,;]+/).filter(Boolean);
  return staff.role === 'manager' || admins.includes(String(userId));
}

function canAccessCase(staff, userId, caseRow) {
  if (!caseRow || !staff || staff.approved !== true) return false;
  return canManageCases(staff, userId) ||
    staff.role === 'lawyer' && String(caseRow.lawyer_tg_id) === String(userId);
}

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
    if (!equalHex(calc, hash)) return null;
    const date = p.get('auth_date');
    if (!/^\d{1,12}$/.test(date || '')) return null;
    const authDate = Number(date), now = Date.now() / 1000;
    if (authDate > now + 60 || now - authDate > 7 * 24 * 3600) return null;
    const user = JSON.parse(p.get('user') || 'null');
    return user && Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
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
  if (typeof uid !== 'string' || !/^[1-9]\d{0,15}$/.test(uid) || !Number.isSafeInteger(Number(uid))) return null;
  const calc = userKey(uid);
  if (!equalHex(calc, key)) return null;
  return { id: Number(uid) };
}

// Только одобренные сотрудники
async function requireStaff(req, res, next) {
  try {
    await ensureStaff();
    const rawInit = req.get('X-Tg-Init') || '';
    const rawU = req.get('X-Tg-U') || '', rawK = req.get('X-Tg-K') || '';
    const user = checkInitData(rawInit) || checkUserKey(rawU, rawK);
    if (!user) {
      // Диагностика: что именно пришло от телефона
      const code = 'подпись: ' + (!rawInit ? 'нет' : 'неверная') + ', ключ: ' + (!rawU ? 'нет' : 'неверный');
      console.log('auth 401', req.method, req.originalUrl.split('?')[0], '|', code, '| init len', rawInit.length, '| u', rawU, '| ua', (req.get('User-Agent') || '').slice(0, 60));
      return res.status(401).json({ ok: false, error: 'Нет доступа (' + code + '). Напишите боту /start и откройте кнопкой из новой клавиатуры.' });
    }
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
  if (!Number.isSafeInteger(caseId) || caseId < 1 || caseId > 2147483647 ||
      typeof exp !== 'string' || !/^[1-9]\d{0,11}$/.test(exp) || Date.now() / 1000 > Number(exp)) return false;
  const calc = crypto.createHmac('sha256', sigKey()).update(caseId + ':' + exp).digest('hex').slice(0, 32);
  return equalHex(calc, sig);
}

// Подключается на страницах мини-приложения: добавляет подпись Telegram к каждому запросу к нашему серверу
// Ключ из ссылки запоминается на время сессии, чтобы переходы внутри приложения (список → форма) тоже работали
const CLIENT_JS = "(function(){var f=window.fetch;if(!f||f.__tg)return;" +
  "var q=new URLSearchParams(location.search),ku=q.get('u'),kk=q.get('k');" +
  "try{if(ku&&kk){sessionStorage.setItem('tg_u',ku);sessionStorage.setItem('tg_k',kk)}else{ku=sessionStorage.getItem('tg_u');kk=sessionStorage.getItem('tg_k')}}catch(e){}" +
  "var w=function(u,o){o=o||{};try{var tg=window.Telegram&&window.Telegram.WebApp;var d=tg&&tg.initData;" +
  // The official SDK reads the opaque, URL-encoded tgWebAppData launch
  // parameter from the fragment. Forward that same signed query if the SDK
  // has not loaded; only requireStaff may validate or trust its contents.
  "if(!d){var fragment=String(location.hash||'').replace(/^#/,'');var start=fragment.indexOf('?');if(start>=0)fragment=fragment.slice(start+1);d=new URLSearchParams(fragment).get('tgWebAppData')||'';}" +
  "var s=String(u);if(typeof Request==='function'){try{s=Object.getOwnPropertyDescriptor(Request.prototype,'url').get.call(u)}catch(e){}}" +
  "if(new URL(s,location.href).origin===location.origin){var h=new Headers(o.headers||(u&&u.headers)||{});" +
  "if(d){try{h.set('X-Tg-Init',d)}catch(e){}}if(ku&&kk){h.set('X-Tg-U',ku);h.set('X-Tg-K',kk)}o.headers=h;}}catch(e){}" +
  "return f.call(this,u,o)};w.__tg=1;window.fetch=w;})();";

// The form embeds exactly the same bridge as /auth.js so a failed extra
// script request cannot remove authentication from an otherwise valid entry.
function clientScript() { return CLIENT_JS; }

function setupAuth(app) {
  ensureStaff().catch(function (e) { console.error('staff table:', e.message); });
  app.get('/auth.js', function (req, res) { res.type('application/javascript').set('Cache-Control', 'no-cache').send(CLIENT_JS); });
  // Все API мини-приложения — только для сотрудников. Исключение: приём заявок из Google-формы (свой токен)
  app.use(['/api/order', '/api/audit', '/api/handoff', '/api/checklist', '/api/reports', '/api/requests', '/checklist/view'], function (req, res, next) {
    if (req.baseUrl === '/api/requests' && req.path === '/incoming') return next();
    return requireStaff(req, res, next);
  });
}

module.exports = { setupAuth, requireStaff, checkInitData, signCase, checkCaseSig, ensureStaff, keyQuery, canManageCases, canAccessCase, clientScript };
