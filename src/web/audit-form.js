function auditForm() {
  function field(id, label, placeholder, type) {
    return '<label class="inspection-field" for="i_' + id + '">' + label +
      '<input id="i_' + id + '" type="' + (type || 'text') + '" placeholder="' + (placeholder || '') + '"></label>';
  }
  function selectField(id, label, values, change) {
    return '<label class="inspection-field" for="i_' + id + '">' + label +
      '<select id="i_' + id + '"' + (change ? ' onchange="updateInspection()"' : '') + '><option value="">Выберите ответ</option>' +
      values.map(function (v) { return '<option value="' + v + '">' + v + '</option>'; }).join('') + '</select></label>';
  }
  function tri(id, label, change) { return selectField(id, label, ['Да', 'Нет', 'Не проверено'], change); }
  var inspectionHtml = '<div id="block-inspection">' +
    '<div class="section"><div class="section-title">Объект и услуга</div>' +
    field('org', 'Организация / название объекта *', 'ООО, ИП или название') +
    field('address', 'Адрес объекта *', 'Город, улица, дом, помещение') +
    field('visit_date', 'Дата осмотра', '', 'date') +
    selectField('service', 'Услуга *', ['Получение', 'Продление', 'Переоформление'], true) + '</div>' +
    '<div class="section"><div class="section-title">Алкоголь на объекте</div>' +
    '<p class="inspection-note" id="alcohol-rule">Сначала выберите услугу.</p>' +
    tri('alcohol_present', 'Есть ли алкоголь на объекте? *', true) +
    '<div id="renewal-alcohol" class="hidden">' + tri('alcohol_within_licensed', 'Весь алкоголь находится в лицензированной зоне? *', true) + '</div>' +
    '<p class="inspection-warning" id="alcohol-warning" aria-live="polite"></p></div>' +
    '<div class="section"><div class="section-title">План, этаж и архив</div>' +
    field('floor_plan', 'Этаж на плане', 'Например: подвал; если неизвестно — Не проверено') +
    field('floor_actual', 'Фактический этаж', 'Например: подвал; если неизвестно — Не проверено') +
    selectField('plan_source', 'Источник графики', ['ЕГРН', 'БТИ', 'Архив', 'Другое', 'Нет графики', 'Не проверено']) +
    field('plan_note', 'Уточнение источника', 'Дата / номер документа, другое основание') +
    tri('archive_available', 'Есть ли архивный план / материалы? *', true) +
    '<div id="archive-match" class="hidden">' + tri('archive_match', 'Фактическая планировка совпадает с архивом? *') + '</div>' +
    '<label class="inspection-field" for="i_structural_elements">Фактические конструктивные элементы<textarea id="i_structural_elements" placeholder="Стены, перегородки, колонны, проёмы; что отличается от плана"></textarea></label>' +
    '<p class="inspection-note">На плане: сиреневый — заявляемые границы; жёлтый — аренда; красный — зал обслуживания; зелёный — бар.</p>' +
    '<label class="file-label">📐 План с цветной разметкой<input type="file" id="inspection-plan" accept="image/*" multiple onchange="previewPhotos(this, \'plan\')"></label>' +
    '<label class="file-label" style="margin-top:8px">🗺 Схема / карта соседних организаций и входов<input type="file" id="inspection-map" accept="image/*" multiple onchange="previewPhotos(this, \'map\')"></label>' +
    '<p class="inspection-note">План, схема и обычные фото — до 10 изображений вместе. Все выбранные файлы видны в фотоотчёте ниже.</p></div>' +
    '<div class="section"><div class="section-title">Границы и входы</div>' +
    tri('within_cadastral', 'Объект находится в границах кадастрового помещения? *') +
    '<div id="renewal-boundaries" class="hidden">' + tri('licensed_boundaries_match', 'Фактические границы соответствуют лицензированным? *') + '</div>' +
    field('entrances_plan', 'Количество входов на плане', 'Число или Не проверено') +
    field('entrances_actual', 'Количество фактических входов / выходов', 'Число или Не проверено') +
    tri('all_entrances_checked', 'Осмотр проведён со всех входов? *') +
    tri('zones_checked', 'Организации и ограничения поблизости проверены? *') + '</div>' +
    '<div class="section"><div class="section-title">Состояние и риски</div>' +
    selectField('video_status', 'Видео осмотра', ['Сделано', 'Не сделано', 'Не проверено']) +
    field('repair_state', 'Состояние ремонта', 'Готово / идёт ремонт / что нужно завершить') +
    '<label class="inspection-field" for="i_risks">Риски и действия до проверки<textarea id="i_risks" placeholder="Что выявлено и что нужно исправить; если рисков нет — укажите это"></textarea></label></div></div>';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Отчёт аудитора</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<script src="/auth.js"><\/script>
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
textarea,input[type=text],input[type=url],input[type=date],select{width:100%;padding:12px 14px;background:var(--tg-theme-secondary-bg-color,#1e293b);border:1.5px solid transparent;border-radius:12px;color:var(--tg-theme-text-color,#f1f5f9);font-size:15px;outline:none;font-family:inherit}
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
.photos-preview img{width:72px;height:72px;object-fit:cover;border-radius:8px;display:block}
.ph{position:relative}
.ph-label{display:block;font-size:12px;margin-top:4px;color:var(--tg-theme-hint-color,#94a3b8)}
.ph-x{position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:11px;border:0;background:#f87171;color:#fff;font-size:12px;line-height:22px;padding:0;cursor:pointer}
.inspection-field{display:block;font-size:14px;margin-bottom:12px;line-height:1.45}
.inspection-field input,.inspection-field select,.inspection-field textarea{display:block;margin-top:6px}
.inspection-note{font-size:13px;line-height:1.5;color:var(--tg-theme-hint-color,#94a3b8);margin:8px 0 12px}
.inspection-warning{font-size:14px;line-height:1.45;color:#fbbf24;margin-top:10px}
select{appearance:auto}
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

${inspectionHtml}

<!-- ОБЩЕПИТ / МАГАЗИН -->
<div id="block-catering-retail">
  <div class="section">
    <div class="section-title">Тип здания</div>
    <div class="radio-group" id="building-type">
      <div class="radio-btn" data-val="Жилое" onclick="selectRadio(this,'building-type')">🏠 Жилое</div>
      <div class="radio-btn" data-val="Нежилое" onclick="selectRadio(this,'building-type')">🏢 Нежилое</div>
      <div class="radio-btn" data-val="Не проверено" onclick="selectRadio(this,'building-type')">❓ Не проверено</div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">Помещение в своих границах</div>
    <div class="radio-group" id="boundaries">
      <div class="radio-btn" data-val="Да" onclick="selectRadio(this,'boundaries')">✅ Да</div>
      <div class="radio-btn" data-val="Нет" onclick="selectRadio(this,'boundaries')">❌ Нет</div>
      <div class="radio-btn" data-val="Под вопросом" onclick="selectRadio(this,'boundaries')">❓ Под вопросом</div>
      <div class="radio-btn" data-val="Не проверено" onclick="selectRadio(this,'boundaries')">❓ Не проверено</div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">БТИ подходит для лицензии</div>
    <div class="radio-group" id="bti">
      <div class="radio-btn" data-val="Да" onclick="selectRadio(this,'bti')">✅ Да</div>
      <div class="radio-btn" data-val="Нет" onclick="selectRadio(this,'bti')">❌ Нет</div>
      <div class="radio-btn" data-val="Не проверено" onclick="selectRadio(this,'bti')">❓ Не проверено</div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">Техническое обследование (ТО)</div>
    <div class="radio-group" id="to">
      <div class="radio-btn" data-val="Нужно" onclick="selectRadio(this,'to')">🔧 Нужно</div>
      <div class="radio-btn" data-val="Не нужно" onclick="selectRadio(this,'to')">✅ Не нужно</div>
      <div class="radio-btn" data-val="Не обязательно" onclick="selectRadio(this,'to')">📌 Не обязательно</div>
      <div class="radio-btn" data-val="Не проверено" onclick="selectRadio(this,'to')">❓ Не проверено</div>
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
    <div class="section-title">Адрес объекта</div>
    <input type="text" id="t_address" placeholder="Город, улица, дом">
  </div>
  <div class="section">
    <div class="section-title">1. Торговый зал</div>
    <div class="chk-row" onclick="toggleChk('chk_t_no_display')"><div class="chk-box" id="chk_t_no_display"></div><span class="chk-label">В торговом зале отсутствует выкладка и демонстрация табачной продукции</span></div>
    <div class="chk-row" onclick="toggleChk('chk_t_price_place')"><div class="chk-box" id="chk_t_price_place"></div><span class="chk-label">Есть место для размещения перечня табачной продукции с ценами</span></div>
    <div class="chk-row" onclick="toggleChk('chk_t_photo_hall')"><div class="chk-box" id="chk_t_photo_hall"></div><span class="chk-label">Сделаны фотографии торгового зала и входа</span></div>
    <div class="chk-row" onclick="toggleChk('chk_t_photo_shelves')"><div class="chk-box" id="chk_t_photo_shelves"></div><span class="chk-label">Сделаны фотографии стеллажей с продукцией и размещённых рядом ценников, перечней и рекламных материалов</span></div>
  </div>
  <div class="section">
    <div class="section-title">2. Зоны запрета</div>
    <div class="chk-row" onclick="toggleChk('chk_t_edu_checked')"><div class="chk-box" id="chk_t_edu_checked"></div><span class="chk-label">Проверено наличие образовательных организаций поблизости</span></div>
    <div class="chk-row" onclick="toggleChk('chk_t_edu_measured')"><div class="chk-box" id="chk_t_edu_measured"></div><span class="chk-label">Если образовательная организация обнаружена, измерено расстояние до входа в магазин по кратчайшему пешеходному маршруту</span></div>
    <div class="chk-row" onclick="toggleChk('chk_t_edu_photo')"><div class="chk-box" id="chk_t_edu_photo"></div><span class="chk-label">Сделаны фотографии входа в образовательную организацию</span></div>
    <input type="text" id="t_edu_name" placeholder="Название образовательной организации" style="margin-top:4px">
    <input type="text" id="t_edu_dist" inputmode="numeric" placeholder="Расстояние, м" style="margin-top:8px">
  </div>
</div>

<!-- ОБЩИЕ БЛОКИ -->
<div id="block-common">
<div class="section">
  <div class="section-title">Проверенные организации рядом</div>
  <div id="zones-list"></div>
  <button class="add-zone" onclick="addZone()">+ Добавить организацию</button>
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

</div>

<div class="section">
  <div class="section-title">Ссылка на видео (Яндекс Диск)</div>
  <input type="url" id="video-url" placeholder="https://disk.yandex.ru/...">
</div>

<div class="section">
  <div class="section-title">Фотоотчёт</div>
  <label class="file-label">
    📷 Прикрепить фото (до 10, можно добавлять)
    <span class="file-count" id="photo-count">не выбрано</span>
    <input type="file" id="photos" accept="image/*" multiple onchange="previewPhotos(this)">
  </label>
  <div class="photos-preview" id="photos-preview"></div>
</div>

<div class="section">
  <div class="section-title">Итог аудитора <span class="required">*</span></div>
  <textarea id="conclusion" placeholder="Сделаем / под вопросом / не сделаем..."></textarea>
</div>

<div class="section" id="block-t-comment" style="display:none">
  <div class="section-title">Комментарий</div>
  <textarea id="t_comment" placeholder="Что важно знать юристу"></textarea>
</div>

<div class="bottom">
  <button class="submit-btn" id="submit-btn" onclick="submitForm()">Отправить отчёт</button>
</div>

<script>
var tg = (window.Telegram && window.Telegram.WebApp) || { ready: function () {}, expand: function () {}, close: function () {}, showAlert: function (m) { alert(m); }, HapticFeedback: { notificationOccurred: function () {} }, initDataUnsafe: {} };
try { tg.ready(); tg.expand(); } catch (e) {}
var orderId = new URLSearchParams(window.location.search).get('order_id') || '';
// Один id на отчёт: при повторной отправке сервер не создаст дубль
var submitId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var currentCat = 'catering';
var checks = {};
var detailSelections = {catering:{},retail:{},other:{'building-type':'Жилое',boundaries:'Да',bti:'Да',to:'Не обязательно'}};
var inspectionFields = ['service','org','address','visit_date','floor_plan','floor_actual','plan_source','plan_note','structural_elements','archive_available','archive_match','alcohol_present','alcohol_within_licensed','within_cadastral','licensed_boundaries_match','entrances_plan','entrances_actual','all_entrances_checked','zones_checked','video_status','repair_state','risks'];
function isAlcoholInspection() { return currentCat === 'catering' || currentCat === 'retail'; }
function inspectionValue(name) { return document.getElementById('i_' + name).value.trim(); }
function serializeInspection() {
  if (!isAlcoholInspection()) return null;
  var out = {};
  inspectionFields.forEach(function (name) { out[name] = inspectionValue(name); });
  if (out.archive_available !== 'Да') out.archive_match = '';
  if (out.service !== 'Продление') {
    out.alcohol_within_licensed = '';
    out.licensed_boundaries_match = '';
  } else if (out.alcohol_present === 'Нет') out.alcohol_within_licensed = '';
  return out;
}
function updateInspection() {
  var service = inspectionValue('service');
  var present = inspectionValue('alcohol_present');
  var renewal = service === 'Продление';
  document.getElementById('renewal-alcohol').classList.toggle('hidden', !renewal || present === 'Нет' || !present);
  document.getElementById('renewal-boundaries').classList.toggle('hidden', !renewal);
  var archive = inspectionValue('archive_available') === 'Да';
  document.getElementById('archive-match').classList.toggle('hidden', !archive);
  if (!archive) document.getElementById('i_archive_match').value = '';
  if (!renewal) {
    document.getElementById('i_alcohol_within_licensed').value = '';
    document.getElementById('i_licensed_boundaries_match').value = '';
  } else if (present === 'Нет') document.getElementById('i_alcohol_within_licensed').value = '';
  var rule = service === 'Получение' ? 'Для получения: на объекте не должно быть алкоголя.' : renewal ? 'Для продления: имеющийся алкоголь должен находиться в лицензированной зоне.' : service === 'Переоформление' ? 'Условия переоформления уточняются отдельно. Зафиксируйте фактическую ситуацию.' : 'Сначала выберите услугу.';
  document.getElementById('alcohol-rule').textContent = rule;
  var warning = '';
  if (service === 'Получение' && present === 'Да') warning = 'Выявлен алкоголь: необходимо убрать его до проверки. Отметьте это в рисках и заключении.';
  else if (renewal && present === 'Да' && inspectionValue('alcohol_within_licensed') === 'Нет') warning = 'Алкоголь находится за пределами лицензированной зоны: нужно переместить его в лицензированную зону до проверки.';
  else if (present === 'Не проверено' || (renewal && present === 'Да' && inspectionValue('alcohol_within_licensed') === 'Не проверено')) warning = 'Размещение алкоголя не подтверждено. Нужна дополнительная проверка.';
  document.getElementById('alcohol-warning').textContent = warning;
}
function validateInspection(inspection) {
  if (!inspection) return '';
  var required = {service:'Услуга',org:'Организация / название объекта',address:'Адрес объекта',archive_available:'Наличие архива',alcohol_present:'Наличие алкоголя',within_cadastral:'Границы кадастрового помещения',all_entrances_checked:'Осмотр со всех входов',zones_checked:'Проверка организаций поблизости'};
  if (inspection.archive_available === 'Да') required.archive_match = 'Соответствие архиву';
  if (inspection.service === 'Продление') {
    required.licensed_boundaries_match = 'Лицензированные границы';
    if (inspection.alcohol_present !== 'Нет') required.alcohol_within_licensed = 'Алкоголь в лицензированной зоне';
  }
  var missing = Object.keys(required).find(function (name) { return !inspection[name]; });
  if (missing) { document.getElementById('i_' + missing).focus(); return 'Укажите: ' + required[missing] + '. Если сведений нет, выберите или напишите «Не проверено».'; }
  var radios = {'building-type':'Тип здания',boundaries:'Помещение в своих границах',bti:'БТИ',to:'Техническое обследование'};
  var empty = Object.keys(radios).find(function (name) { return !getRadioVal(name); });
  return empty ? 'Укажите: ' + radios[empty] + '. Можно выбрать «Не проверено».' : '';
}
var localDate = new Date();
document.getElementById('i_visit_date').value = localDate.getFullYear() + '-' + String(localDate.getMonth() + 1).padStart(2, '0') + '-' + String(localDate.getDate()).padStart(2, '0');
updateInspection();
if (orderId) {
  fetch('/api/audit/prefill?order_id=' + encodeURIComponent(orderId)).then(function (response) { return response.json(); }).then(function (data) {
    if (!data || !data.ok) return;
    if (!inspectionValue('org')) document.getElementById('i_org').value = data.org || '';
    if (!inspectionValue('address')) document.getElementById('i_address').value = data.address || '';
    if (data.object_category && ['catering','retail','tobacco','other'].indexOf(data.object_category) !== -1) {
      var category = document.querySelector('#obj-cat .radio-btn[data-val="' + data.object_category + '"]');
      if (category) selectCat(category);
    }
    if (data.address && !document.getElementById('t_address').value) document.getElementById('t_address').value = data.address;
  }).catch(function () {});
}

function selectCat(el) {
  var groups = ['building-type','boundaries','bti','to'];
  if (detailSelections[currentCat]) groups.forEach(function (group) { detailSelections[currentCat][group] = getRadioVal(group); });
  document.querySelectorAll('#obj-cat .radio-btn').forEach(function(b) { b.classList.remove('active'); });
  el.classList.add('active');
  currentCat = el.dataset.val;
  document.getElementById('block-inspection').classList.toggle('hidden', !isAlcoholInspection());
  document.getElementById('block-catering-retail').classList.toggle('hidden', currentCat === 'tobacco');
  document.getElementById('block-tobacco').classList.toggle('hidden', currentCat !== 'tobacco');
  document.getElementById('block-common').classList.toggle('hidden', currentCat === 'tobacco');
  document.getElementById('block-t-comment').style.display = currentCat === 'tobacco' ? '' : 'none';
  groups.forEach(function (group) {
    document.querySelectorAll('#' + group + ' .radio-btn').forEach(function (button) {
      button.classList.toggle('active', !!(detailSelections[currentCat] && detailSelections[currentCat][group] === button.dataset.val));
    });
  });
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
    '<input type="text" aria-label="Лицензия организации" placeholder="Лицензия: номер / не проверена" class="zone-license" style="margin-bottom:8px">' +
    '<input type="text" aria-label="Уточнения по организации" placeholder="Доп. сведения: входы, ИНН, результаты проверки" style="width:100%" class="zone-info">';
  document.getElementById('zones-list').appendChild(div);
}
function removeZone(id) { var el = document.getElementById(id); if (el) el.remove(); }

var photoFiles = [];
var MAX_PHOTOS = 10; // больше в один альбом Telegram не пускает
// Повторный выбор добавляет фото к уже выбранным; у каждой миниатюры — ✕
function previewPhotos(input, role) {
  role = role || 'photo';
  var added = Array.from(input.files || []);
  var skipped = 0;
  added.forEach(function(f) {
    var dup = photoFiles.find(function(x) { return x.name === f.name && x.size === f.size; });
    if (dup) { if (role !== 'photo') dup.auditRole = role; return; }
    if (photoFiles.length >= MAX_PHOTOS) { skipped++; return; }
    f.auditRole = role;
    photoFiles.push(f);
  });
  input.value = ''; // чтобы можно было выбрать те же файлы снова после удаления
  drawPhotos();
  if (skipped) tg.showAlert('Можно прикрепить не больше ' + MAX_PHOTOS + ' фото. Лишние (' + skipped + ') не добавлены.');
}
function drawPhotos() {
  document.getElementById('photo-count').textContent = photoFiles.length ? photoFiles.length + ' из ' + MAX_PHOTOS : 'не выбрано';
  var p = document.getElementById('photos-preview'); p.innerHTML = '';
  photoFiles.forEach(function(f, i) {
    var w = document.createElement('div'); w.className = 'ph';
    var img = document.createElement('img'); img.src = URL.createObjectURL(f); w.appendChild(img);
    var x = document.createElement('button'); x.type = 'button'; x.className = 'ph-x'; x.textContent = '✕';
    x.onclick = function() { photoFiles.splice(i, 1); drawPhotos(); };
    w.appendChild(x);
    var label = document.createElement('span'); label.className = 'ph-label'; label.textContent = ({plan:'План',map:'Схема',photo:'Фото'})[f.auditRole || 'photo']; w.appendChild(label);
    p.appendChild(w);
  });
}
function toBase64(file) {
  return new Promise(function(res, rej) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function() {
      var max = 1600;
      var w = img.width, h = img.height;
      if (w > max || h > max) {
        if (w > h) { h = Math.round(h * max / w); w = max; }
        else { w = Math.round(w * max / h); h = max; }
      }
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.7).split(',')[1]);
    };
    img.onerror = rej;
    img.src = url;
  });
}

async function submitForm() {
  var inspection = serializeInspection();
  var inspectionError = validateInspection(inspection);
  if (inspectionError) { tg.showAlert(inspectionError); return; }
  var conclusion = document.getElementById('conclusion').value.trim();
  if (!conclusion) { document.getElementById('conclusion').style.borderColor = '#f87171'; return; }
  var btn = document.getElementById('submit-btn');
  if (btn.disabled) return; // защита от двойного нажатия
  btn.disabled = true; btn.textContent = 'Готовлю фото...';

  var zones = [];
  document.querySelectorAll('.zone-item').forEach(function(z) {
    var name = z.querySelector('.zone-name').value.trim();
    if (name) zones.push({ name: name, dist: z.querySelector('.zone-dist').value.trim(), info: z.querySelector('.zone-info').value.trim(), license: z.querySelector('.zone-license').value.trim() });
  });

  var photos = [];
  try {
    for (var i = 0; i < Math.min(photoFiles.length, MAX_PHOTOS); i++) {
      photos.push({ data: await toBase64(photoFiles[i]), name: photoFiles[i].name, role: isAlcoholInspection() ? (photoFiles[i].auditRole || 'photo') : 'photo' });
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Отправить отчёт';
    tg.showAlert('Не удалось подготовить фото. Удалите повреждённое изображение или выберите его заново. Данные отчёта остались в форме.');
    return;
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
    t_address: (document.getElementById('t_address') || {}).value || '',
    t_edu_name: (document.getElementById('t_edu_name') || {}).value || '',
    t_edu_dist: (document.getElementById('t_edu_dist') || {}).value || '',
    t_comment: (document.getElementById('t_comment') || {}).value || '',
    tg_user_id: tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : null,
    submit_id: submitId,
  };

  if (inspection) { payload.schema_version = 2; payload.inspection = inspection; }

  // Добавляем все чекбоксы
  Object.keys(checks).forEach(function(k) { payload[k] = checks[k]; });

  var body = JSON.stringify(payload);
  var waits = [0, 8000, 15000, 30000];
  var lastErr = '';
  for (var attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) {
      for (var s = waits[attempt] / 1000; s > 0; s--) { btn.textContent = 'Сервер занят, повтор через ' + s + ' с…'; await sleep(1000); }
    }
    btn.textContent = attempt ? 'Отправляем ещё раз…' : 'Отправляем...';
    try {
      var r = await fetch('/api/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
      var text = await r.text();
      var result = null;
      try { result = JSON.parse(text); } catch (pe) { result = null; }
      if (result && result.ok) {
        btn.textContent = '✅ Отчёт отправлен!';
        try { tg.HapticFeedback.notificationOccurred('success'); } catch (he) {}
        setTimeout(function() { tg.close(); }, 1500);
        return;
      }
      lastErr = result ? (result.error || 'Ошибка сервера') : ('Сервер ответил: ' + (text || r.status).toString().slice(0, 80));
      var busy = r.status === 429 || r.status >= 500 || !result || /429|rate|too many|timeout/i.test(lastErr);
      if (!busy) break; // ошибка не из-за нагрузки — повторять бессмысленно
    } catch (e) {
      lastErr = 'Нет связи: ' + e.message;
    }
  }
  btn.disabled = false; btn.textContent = 'Отправить отчёт';
  tg.showAlert('Отчёт не отправлен. ' + lastErr + ' Данные остались в форме — попробуйте ещё раз через минуту.');
}
<\/script>
</body></html>`;
}

module.exports = { auditForm };
