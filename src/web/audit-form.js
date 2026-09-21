function auditForm() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Отчёт аудитора</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--tg-theme-bg-color,#0f172a);color:var(--tg-theme-text-color,#f1f5f9);padding:16px 16px 120px}
h1{font-size:20px;font-weight:700;margin-bottom:4px;padding-top:8px}
.subtitle{font-size:13px;color:var(--tg-theme-hint-color,#64748b);margin-bottom:20px}
.section{margin-bottom:20px}
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--tg-theme-hint-color,#64748b);margin-bottom:8px}
.radio-group{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.radio-btn{padding:9px 16px;background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:10px;font-size:14px;cursor:pointer;border:1.5px solid transparent;transition:all .15s;user-select:none}
.radio-btn.active{background:rgba(99,102,241,.15);border-color:var(--tg-theme-button-color,#6366f1);color:var(--tg-theme-button-color,#6366f1)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;margin-bottom:8px;cursor:pointer}
.toggle{position:relative;width:48px;height:28px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0;position:absolute}
.slider{position:absolute;inset:0;background:#334155;border-radius:14px;transition:.2s}
.slider:before{content:'';position:absolute;width:22px;height:22px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked+.slider{background:var(--tg-theme-button-color,#6366f1)}
.toggle input:checked+.slider:before{transform:translateX(20px)}
.chk-row{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;margin-bottom:8px;cursor:pointer}
.chk-box{width:22px;height:22px;border-radius:6px;border:2px solid #475569;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s;margin-top:1px}
.chk-box.checked{background:var(--tg-theme-button-color,#6366f1);border-color:var(--tg-theme-button-color,#6366f1)}
.chk-box.checked::after{content:'✓';color:#fff;font-size:14px;font-weight:700}
.chk-label{font-size:14px;line-height:1.4}
textarea,input[type=text],input[type=url]{width:100%;padding:12px 14px;background:var(--tg-theme-secondary-bg-color,#1e293b);border:1.5px solid transparent;border-radius:12px;color:var(--tg-theme-text-color,#f1f5f9);font-size:15px;outline:none;font-family:inherit}
textarea{resize:none;min-height:90px}
textarea:focus,input:focus{border-color:var(--tg-theme-button-color,#6366f1)}
.zone-item{background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;padding:12px;margin-bottom:8px;position:relative}
.zone-row{display:flex;gap:8px;margin-bottom:8px}
.zone-row input{flex:1}
.zone-row input:last-child{flex:0 0 80px}
.zone-remove{position:absolute;top:8px;right:10px;background:none;border:none;color:#f87171;font-size:20px;cursor:pointer;line-height:1}
.add-zone{width:100%;padding:11px;background:transparent;border:1.5px dashed #334155;border-radius:12px;color:var(--tg-theme-hint-color,#64748b);font-size:14px;cursor:pointer}
.file-label{display:flex;align-items:center;gap:10px;padding:13px 16px;background:var(--tg-theme-secondary-bg-color,#1e293b);border-radius:12px;cursor:pointer;font-size:15px}
.file-label input{display:none}
.file-count{font-size:13px;color:var(--tg-theme-hint-color,#64748b);margin-left:auto}
.photos-preview{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.photos-preview img{width:72px;height:72px;object-fit:cover;border-radius:8px}
.required{color:#f87171}
.hidden{display:none}
.bottom{position:fixed;bottom:0;left:0;right:0;padding:12px 16px;background:var(--tg-theme-bg-color,#0f172a);border-top:1px solid #1e293b}
.submit-btn{width:100%;padding:15px;background:var(--tg-theme-button-color,#6366f1);color:var(--tg-theme-button-text-color,#fff);border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer}
.submit-btn:disabled{opacity:.5}
</style>
</head>
<body>
<h1>🔍 Отчёт аудитора</h1>
<p class="subtitle">Заполни после замера объекта</p>

<div class="section">
  <div class="section-title">Тип объекта</div>
  <div class="radio-group" id="obj-cat">
    <div class="radio-btn active" data-val="catering" onclick="selectCat(this)">🍽 Общепит</div>
    <div class="radio-btn" data-val="retail" onclick="selectCat(this)">🛒 Магазин</div>
    <div class="radio-btn" data-val="tobacco" onclick="selectCat(this)">🚬 Табак</div>
    <div class="radio-btn" data-val="other" onclick="selectCat(this)">📦 Другое</div>
  </div>
</div>

<!-- ОБЩЕПИТ / МАГАЗИН -->
<div id="block-catering-retail">
  <div class="section">
    <div class="section-title">Тип здания</div>
    <div class="radio-group" id="building-type">
      <div class="radio-btn active" data-val="Жилое" onclick="selectRadio(this,'building-type')">🏠 Жилое</div>
      <div class="radio-btn" data-val="Нежилое" onclick="selectRadio(this,'building-type')">🏢 Нежилое</div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">Помещение в своих границах</div>
    <div class="radio-group" id="boundaries">
      <div class="radio-btn active" data-val="Да" onclick="selectRadio(this,'boundaries')">✅ Да</div>
      <div class="radio-btn" data-val="Нет" onclick="selectRadio(this,'boundaries')">❌ Нет</div>
      <div class="radio-btn" data-val="Под вопросом" onclick="selectRadio(this,'boundaries')">❓ Под вопросом</div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">БТИ подходит для лицензии</div>
    <div class="radio-group" id="bti">
      <div class="radio-btn active" data-val="Да" onclick="selectRadio(this,'bti')">✅ Да</div>
      <div class="radio-btn" data-val="Нет" onclick="selectRadio(this,'bti')">❌ Нет</div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">Техническое обследование (ТО)</div>
    <div class="radio-group" id="to">
      <div class="radio-btn" data-val="Нужно" onclick="selectRadio(this,'to')">🔧 Нужно</div>
      <div class="radio-btn" data-val="Не нужно" onclick="selectRadio(this,'to')">✅ Не нужно</div>
      <div class="radio-btn active" data-val="Не обязательно" onclick="selectRadio(this,'to')">📌 Не обязательно</div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">Планировка и границы</div>
    <div class="chk-row" onclick="toggleChk('chk_bti_match')"><div class="chk-box" id="chk_bti_match"></div><span class="chk-label">Фактическая планировка соответствует БТИ</span></div>
    <div class="chk-row" onclick="toggleChk('chk_hall')"><div class="chk-box" id="chk_hall"></div><span class="chk-label">Торговый зал / зал обслуживания определён</span></div>
    <div class="chk-row" onclick="toggleChk('chk_storage')"><div class="chk-box" id="chk_storage"></div><span class="chk-label">Подсобные и складские помещения определены</span></div>
    <div class="chk-row" onclick="toggleChk('chk_no_replan')"><div class="chk-box" id="chk_no_replan"></div><span class="chk-label">Нет самовольных перепланировок</span></div>
    <div class="chk-row" onclick="toggleChk('chk_clear_borders')"><div class="chk-box" id="chk_clear_borders"></div><span class="chk-label">Границы объекта однозначно определимы</span></div>
    <div class="chk-row" onclick="toggleChk('chk_cadastr')"><div class="chk-box" id="chk_cadastr"></div><span class="chk-label">Кадастровый номер не разделён (объект единый)</span></div>
  </div>
</div>

<!-- ТАБАК -->
<div id="block-tobacco" class="hidden">
  <div class="section">
    <div class="section-title">Торговый объект</div>
    <div class="chk-row" onclick="toggleChk('chk_shop')"><div class="chk-box" id="chk_shop"></div><span class="chk-label">Объект является магазином или павильоном</span></div>
    <div class="chk-row" onclick="toggleChk('chk_address')"><div class="chk-box" id="chk_address"></div><span class="chk-label">Объект соответствует заявленному адресу</span></div>
    <div class="chk-row" onclick="toggleChk('chk_area')"><div class="chk-box" id="chk_area"></div><span class="chk-label">Площадь не менее 5 м²</span></div>
  </div>
  <div class="section">
    <div class="section-title">Торговый зал</div>
    <div class="chk-row" onclick="toggleChk('chk_no_display')"><div class="chk-box" id="chk_no_display"></div><span class="chk-label">Нет открытой выкладки табачной и никотинсодержащей продукции</span></div>
    <div class="chk-row" onclick="toggleChk('chk_price_list')"><div class="chk-box" id="chk_price_list"></div><span class="chk-label">Есть перечень продукции с ценами</span></div>
    <div class="chk-row" onclick="toggleChk('chk_price_format')"><div class="chk-box" id="chk_price_format"></div><span class="chk-label">Перечень выполнен в установленном формате</span></div>
    <div class="chk-row" onclick="toggleChk('chk_no_ads')"><div class="chk-box" id="chk_no_ads"></div><span class="chk-label">Нет рекламы и изображений продукции</span></div>
    <div class="chk-row" onclick="toggleChk('chk_on_demand')"><div class="chk-box" id="chk_on_demand"></div><span class="chk-label">Демонстрация только после ознакомления с перечнем и по требованию</span></div>
    <div class="chk-row" onclick="toggleChk('chk_marking')"><div class="chk-box" id="chk_marking"></div><span class="chk-label">Есть маркировка товара</span></div>
    <div class="chk-row" onclick="toggleChk('chk_cash')"><div class="chk-box" id="chk_cash"></div><span class="chk-label">Есть установленная касса</span></div>
  </div>
  <div class="section">
    <div class="section-title">Ассортимент</div>
    <div class="chk-row" onclick="toggleChk('chk_no_single')"><div class="chk-box" id="chk_no_single"></div><span class="chk-label">Нет поштучной продажи сигарет</span></div>
    <div class="chk-row" onclick="toggleChk('chk_no_unpack')"><div class="chk-box" id="chk_no_unpack"></div><span class="chk-label">Нет продукции без потребительской упаковки</span></div>
    <div class="chk-row" onclick="toggleChk('chk_no_banned')"><div class="chk-box" id="chk_no_banned"></div><span class="chk-label">Нет насвая, снюса и запрещённой никотинсодержащей продукции</span></div>
    <div class="chk-row" onclick="toggleChk('chk_no_chew')"><div class="chk-box" id="chk_no_chew"></div><span class="chk-label">Нет запрещённой продукции для жевания, сосания или нюханья</span></div>
    <div class="chk-row" onclick="toggleChk('chk_nicotine_limit')"><div class="chk-box" id="chk_nicotine_limit"></div><span class="chk-label">Никотинсодержащие жидкости в пределах нормы по содержанию никотина</span></div>
  </div>
</div>

<!-- ОБЩИЕ БЛОКИ -->
<div class="section">
  <div class="section-title">Зоны (запрещённые объекты рядом)</div>
  <div id="zones-list"></div>
  <button class="add-zone" onclick="addZone()">+ Добавить зону</button>
</div>

<div class="section">
  <div class="section-title">Дополнительные объекты рядом</div>
  <textarea id="nearby" placeholder="Пустые помещения, ремонт, что взять на заметку..."></textarea>
</div>

<div class="section">
  <div class="section-title">Характеристики объекта</div>
  <div class="toggle-row" onclick="toggleCb('veranda')"><span>🏗 Веранда</span><div class="toggle"><input type="checkbox" id="veranda"><span class="slider"></span></div></div>
  <div class="toggle-row" onclick="toggleCb('patz')"><span>📄 ПАТЗ</span><div class="toggle"><input type="checkbox" id="patz"><span class="slider"></span></div></div>
  <div class="toggle-row" onclick="toggleCb('replan')"><span>🔨 Перепланировка</span><div class="toggle"><input type="checkbox" id="replan"><span class="slider"></span></div></div>
  <div class="toggle-row" onclick="toggleCb('passport')"><span>🛡 Паспорт безопасности</span><div class="toggle"><input type="checkbox" id="passport"><span class="slider"></span></div></div>
  <div class="toggle-row" onclick="toggleCb('owner')"><span>🔑 Собственник</span><div class="toggle"><input type="checkbox" id="owner"><span class="slider"></span></div></div>
</div>

<div class="section">
  <div class="section-title">Ссылка на видео (Яндекс Диск)</div>
  <input type="url" id="video-url" placeholder="https://disk.yandex.ru/...">
</div>

<div class="section">
  <div class="section-title">Фотоотчёт</div>
  <label class="file-label">
    📷 Прикрепить фото
    <span class="file-count" id="photo-count">не выбрано</span>
    <input type="file" id="photos" accept="image/*" multiple onchange="previewPhotos(this)">
  </label>
  <div class="photos-preview" id="photos-preview"></div>
</div>

<div class="section">
  <div class="section-title">Итог аудитора <span class="required">*</span></div>
  <textarea id="conclusion" placeholder="Сделаем / под вопросом / не сделаем..."></textarea>
</div>

<div class="bottom">
  <button class="submit-btn" id="submit-btn" onclick="submitForm()">Отправить отчёт</button>
</div>

<script>
var tg = window.Telegram.WebApp;
tg.ready(); tg.expand();
var orderId = new URLSearchParams(window.location.search).get('order_id') || '';
var currentCat = 'catering';
var checks = {};

function selectCat(el) {
  document.querySelectorAll('#obj-cat .radio-btn').forEach(function(b) { b.classList.remove('active'); });
  el.classList.add('active');
  currentCat = el.dataset.val;
  document.getElementById('block-catering-retail').classList.toggle('hidden', currentCat === 'tobacco');
  document.getElementById('block-tobacco').classList.toggle('hidden', currentCat !== 'tobacco');
}

function selectRadio(el, group) {
  document.querySelectorAll('#' + group + ' .radio-btn').forEach(function(b) { b.classList.remove('active'); });
  el.classList.add('active');
}

function getRadioVal(group) {
  var a = document.querySelector('#' + group + ' .radio-btn.active');
  return a ? a.dataset.val : '';
}

function toggleChk(id) {
  checks[id] = !checks[id];
  var box = document.getElementById(id);
  if (checks[id]) box.classList.add('checked'); else box.classList.remove('checked');
}

function toggleCb(id) {
  var cb = document.getElementById(id);
  cb.checked = !cb.checked;
}

var zoneCount = 0;
function addZone() {
  zoneCount++;
  var id = 'zone-' + zoneCount;
  var div = document.createElement('div');
  div.className = 'zone-item'; div.id = id;
  div.innerHTML = '<button class="zone-remove" onclick="removeZone(\\'' + id + '\\')">×<\/button>' +
    '<div class="zone-row"><input type="text" placeholder="Объект (стоматология, школа...)" class="zone-name"><input type="text" placeholder="Метры" class="zone-dist"><\/div>' +
    '<input type="text" placeholder="Доп. инфо (входы, лицензии, ИНН...)" style="width:100%" class="zone-info">';
  document.getElementById('zones-list').appendChild(div);
}
function removeZone(id) { var el = document.getElementById(id); if (el) el.remove(); }

var photoFiles = [];
function previewPhotos(input) {
  photoFiles = Array.from(input.files);
  document.getElementById('photo-count').textContent = photoFiles.length + ' фото';
  var p = document.getElementById('photos-preview'); p.innerHTML = '';
  photoFiles.slice(0,6).forEach(function(f) { var img = document.createElement('img'); img.src = URL.createObjectURL(f); p.appendChild(img); });
}
function toBase64(file) {
  return new Promise(function(res) { var r = new FileReader(); r.onload = function() { res(r.result.split(',')[1]); }; r.readAsDataURL(file); });
}

async function submitForm() {
  var conclusion = document.getElementById('conclusion').value.trim();
  if (!conclusion) { document.getElementById('conclusion').style.borderColor = '#f87171'; return; }
  var btn = document.getElementById('submit-btn'); btn.disabled = true; btn.textContent = 'Отправляем...';

  var zones = [];
  document.querySelectorAll('.zone-item').forEach(function(z) {
    var name = z.querySelector('.zone-name').value.trim();
    if (name) zones.push({ name: name, dist: z.querySelector('.zone-dist').value.trim(), info: z.querySelector('.zone-info').value.trim() });
  });

  var photos = [];
  for (var i = 0; i < Math.min(photoFiles.length, 5); i++) {
    photos.push({ data: await toBase64(photoFiles[i]), name: photoFiles[i].name });
  }

  var payload = {
    type: 'audit',
    order_id: orderId,
    object_category: currentCat,
    building_type: getRadioVal('building-type'),
    boundaries: getRadioVal('boundaries'),
    bti: getRadioVal('bti'),
    to: getRadioVal('to'),
    zones: zones,
    nearby: document.getElementById('nearby').value.trim(),
    veranda: document.getElementById('veranda').checked,
    patz: document.getElementById('patz').checked,
    replan: document.getElementById('replan').checked,
    passport_interest: document.getElementById('passport').checked,
    is_owner: document.getElementById('owner').checked,
    video_url: document.getElementById('video-url').value.trim(),
    photos: photos,
    conclusion: conclusion,
    tg_user_id: tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : null,
  };

  // Добавляем все чекбоксы
  Object.keys(checks).forEach(function(k) { payload[k] = checks[k]; });

  try {
    var r = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var result = await r.json();
    if (result.ok) {
      btn.textContent = '✅ Отчёт отправлен!';
      setTimeout(function() { tg.close(); }, 1500);
    } else { throw new Error(result.error || 'Ошибка сервера'); }
  } catch(e) {
    btn.disabled = false; btn.textContent = 'Отправить отчёт';
    alert('Ошибка: ' + e.message);
  }
}
<\/script>
</body></html>`;
}

module.exports = { auditForm };
