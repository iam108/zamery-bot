(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  try { if (tg) { tg.ready(); tg.expand(); } } catch (e) {}
  var params = new URLSearchParams(window.location.search);
  var orderId = params.get('order_id') || '';
  var legacyLink = document.querySelector('.legacy-link'); if (legacyLink) legacyLink.href = '/audit/legacy' + window.location.search;
  var storedUid = ''; try { storedUid = sessionStorage.getItem('tg_u') || ''; } catch (e) {}
  var uid = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? String(tg.initDataUnsafe.user.id) : (params.get('u') || storedUid || 'staff');
  var localKey = 'audit-wizard-v3:' + uid + ':' + (orderId || 'new');
  var STEPS = [
    ['На объекте', 'Входы и окружение', 'Сфотографируйте входы и подозрительные организации. Сомнения можно уточнить после выезда.'],
    ['Помещение и план', 'Помещение и план', 'Снимите помещение и отметьте фактические границы на готовой графике.'],
    ['Отчёт', 'Результат проверки', 'Краткий вывод и вопросы, которые осталось решить.']
  ];
  var TRI = ['', 'Да', 'Нет', 'Не проверено'];
  var defaults = {
    schema_version: 3, ui_version: 4, object_category: 'catering', order_id: orderId,
    inspection: {service:'',org:'',address:'',visit_date:'',region:'МСК',floor_plan:'',floor_actual:'',plan_source:'',plan_note:'',structural_elements:'',archive_available:'',archive_match:'',archive_url:'',alcohol_present:'',alcohol_within_licensed:'',within_cadastral:'',licensed_boundaries_match:'',entrances_plan:'',entrances_actual:'',all_entrances_checked:'',zones_checked:'',video_status:'',repair_state:'',risks:''},
    workflow: {step:0,contact_name:'',contact_phone:'',call_status:'',appointment_at:'',access_notes:'',preliminary_status:'',precheck_notes:'',documents:{egrn:'',lease:'',plan:'',license:''},video_url:'',followup_notes:'',mitigation:'',conclusion_status:''},
    entrances: [], zones: [], plan: {evidence_id:'',annotations:[],wall_basis:''},
    building_type:'',boundaries:'',bti:'',to:'',nearby:'',veranda:false,patz:false,passport:false,owner_info:'',conclusion:''
  };
  var state = {data:clone(defaults),draft:null,evidence:[],dirty:false,version:0,conflict:false,submitting:false,frozen:false,completed:false,loaded:false,localSaved:false,pendingUploads:0,uploadText:'',serverError:'',recoveryData:null,packet:null,viewStep:null,packetError:''};
  var tail = Promise.resolve();
  var timer = null;
  var toastTimer = null;
  var editor = null;
  var blobUrls = new Map();
  var uploadIds = new Map();
  var downloadJobs = new Set();
  var fieldId = 0;
  var root = document.getElementById('step-content');
  var $ = function (s) { return document.querySelector(s); };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function stable(value) { if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object'){var out={};Object.keys(value).sort().forEach(function(k){out[k]=stable(value[k]);});return out;}return value; }
  function merge(base, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
    Object.keys(value).forEach(function (key) {
      if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) merge(base[key], value[key]);
      else base[key] = value[key];
    });
    return base;
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function get(path) { return path.split('.').reduce(function (v,k) { return v == null ? '' : v[k]; },state.data); }
  function set(path, value) { var keys=path.split('.'),last=keys.pop(),o=state.data;keys.forEach(function(k){if(!o[k])o[k]={};o=o[k];});o[last]=value; }
  function uuid() { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16);}); }
  function id(prefix) { return prefix + '-' + uuid(); }
  function localDate() { var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function step() { var n=Number(state.viewStep!=null?state.viewStep:state.data.workflow.step);return Number.isInteger(n)?Math.max(0,Math.min(2,n)):0; }
  function isRenewal() { return state.data.inspection.service==='Продление'; }
  function bytes(n) { return Number(n)>=1024*1024?(Number(n)/1024/1024).toFixed(1)+' МБ':Math.max(1,Math.round(Number(n||0)/1024))+' КБ'; }
  function timeLabel() { return new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}); }
  function notify(message) { $('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(function(){$('#toast').hidden=true;},5000); }
  function notice(message) { $('#app-notice').textContent=message;$('#app-notice').hidden=!message; }
  function status(text,tone) { $('#save-state').textContent=text;$('#save-state').dataset.tone=tone||''; }
  function queue(fn) { var next=tail.catch(function(){}).then(fn);tail=next.catch(function(){});return next; }
  function localSave() {
    if(state.completed||state.frozen)return;
    try { localStorage.setItem(localKey,JSON.stringify({draft_id:state.draft&&state.draft.id,revision:state.draft&&state.draft.revision,data:state.data,dirty:state.dirty,saved_at:Date.now()}));state.localSaved=true; }
    catch(e) {state.localSaved=false;if(state.dirty)status('Не удалось сохранить на устройстве. Сохраните на сервер.','warning');}
  }
  function changed() {
    if(state.submitting||state.frozen)return;
    state.version++;state.dirty=true;state.serverError='';localSave();refreshChrome();
    if(!state.conflict)status(state.localSaved?'На устройстве · сохраняю на сервер…':'Сохраняю на сервер…');
    clearTimeout(timer);timer=setTimeout(function(){saveNow().catch(function(){});},800);
  }
  async function request(url,options) {
    var response=await fetch(url,options||{});var text=await response.text();var data;
    try{data=JSON.parse(text);}catch(e){throw new Error('Сервер вернул непонятный ответ. Черновик остался на устройстве.');}
    if(!response.ok||data.ok===false){var error=new Error(data.error||'Не удалось выполнить запрос.');error.status=response.status;error.payload=data;throw error;}
    return data;
  }
  function adoptRevision(result) {
    var draft=result.draft||null;
    if(draft){state.draft=Object.assign({},state.draft||{},draft);if(Array.isArray(draft.evidence))state.evidence=draft.evidence;}
    else if(state.draft&&result.revision!=null)state.draft.revision=result.revision;
    if(result.evidence&&Array.isArray(result.evidence))state.evidence=result.evidence;
    $('#draft-id').textContent=orderId?'Заявка #'+orderId:'Черновик';
  }
  async function flush() {
    if(state.frozen)throw new Error('Версия отчёта зафиксирована. Повторите отправку без изменений.');
    if(state.conflict)throw new Error('Сначала разрешите конфликт версий.');
    clearTimeout(timer);
    while(state.dirty||!state.draft){
      var version=state.version;var data=clone(state.data);
      status('Сохраняю на сервер…');
      try{
        var creating=!state.draft;
        var result=state.draft?await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision,data:data})}):await request('/api/audit/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:orderId||null,data:data})});
        if(creating&&result.draft&&result.draft.data&&JSON.stringify(stable(result.draft.data))!==JSON.stringify(stable(data))){adoptRevision(result);var conflict=new Error('В другом окне уже создана другая версия проверки.');conflict.status=409;throw conflict;}
        adoptRevision(result);state.dirty=state.version!==version;state.serverError='';localSave();
      }catch(error){
        state.serverError=error.message;
        if(error.status===409){state.conflict=true;$('#conflict-panel').hidden=false;status('Конфликт версий · ваши правки на устройстве','warning');}
        else status((state.localSaved?'Только на устройстве · ':'Не сохранено · ')+error.message,'warning');
        throw error;
      }
    }
    status('Сохранено на сервере · '+timeLabel(),'success');return state.draft;
  }
  function saveNow(){return queue(flush);}

  function input(label,path,options) {
    options=options||{};var fid='aw-field-'+(++fieldId),value=get(path),type=options.type||'text';
    var attrs=' id="'+fid+'" data-bind="'+esc(path)+'"'+(options.maxlength?' maxlength="'+options.maxlength+'"':'')+(options.placeholder?' placeholder="'+esc(options.placeholder)+'"':'');
    var control;
    if(options.options){control='<select'+attrs+'>'+options.options.map(function(option){var val=typeof option==='object'?option.value:option;var name=typeof option==='object'?option.label:option;return '<option value="'+esc(val)+'"'+(String(value)===String(val)?' selected':'')+'>'+esc(val===''?(options.empty||'Выберите ответ'):name)+'</option>';}).join('')+'</select>';}
    else if(type==='textarea')control='<textarea'+attrs+' rows="'+(options.rows||3)+'">'+esc(value)+'</textarea>';
    else control='<input type="'+esc(type)+'"'+attrs+' value="'+esc(value)+'"'+(options.inputmode?' inputmode="'+esc(options.inputmode)+'"':'')+(type==='number'?' min="0" step="'+(options.step||'0.01')+'"':'')+'>';
    return '<label class="field'+(options.wide?' wide':'')+'" for="'+fid+'"><span class="field-label">'+esc(label)+'</span>'+control+(options.help?'<span class="field-help">'+esc(options.help)+'</span>':'')+'</label>';
  }
  function tri(label,path,help,wide) {return input(label,path,{options:TRI,help:help,wide:wide});}
  function checkbox(label,path) {return '<label class="check-field"><input type="checkbox" data-bind="'+esc(path)+'"'+(get(path)?' checked':'')+'><span>'+esc(label)+'</span></label>';}
  function select(label,path,options,help,wide){return input(label,path,{options:[''].concat(options),help:help,wide:wide});}
  function heading(index){return '<div class="step-heading"><h2>'+esc(STEPS[index][1])+'</h2><p>'+esc(STEPS[index][2])+'</p></div>';}
  function uploader(role,subject,label,imagesOnly){var uid=id('upload');return '<label class="upload-control" for="'+uid+'"><input type="file" id="'+uid+'" data-upload-role="'+esc(role)+'" data-upload-subject="'+esc(subject||'')+'" accept="'+(imagesOnly?'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif,image/tiff,image/bmp':'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif,image/tiff,image/bmp,application/pdf')+'"'+(imagesOnly?' capture="environment"':'')+' multiple><span class="upload-label">'+esc(label||'Добавить файл или фото')+'</span></label>';}
  function evidenceFor(role,subject){return state.evidence.filter(function(e){return e.role===role&&(subject==null||String(e.subject_id||'')===String(subject));});}
  function evidenceCards(role,subject){var files=evidenceFor(role,subject);if(!files.length)return '';return '<div class="evidence-grid">'+files.map(function(e){var image=/^image\//.test(e.mime||e.mime_type||'');return '<article class="evidence-card"><div class="evidence-preview">'+(image?'<img alt="'+esc(e.name||'Фото')+'" data-evidence-image="'+esc(e.id)+'">':'PDF')+'</div><div class="evidence-details"><div class="evidence-name">'+esc(e.name||'Файл')+'</div><div class="evidence-meta">Оригинал · '+bytes(e.size||e.bytes||0)+'</div><div class="evidence-actions"><button type="button" data-open-evidence="'+esc(e.id)+'">Открыть</button><button type="button" class="remove-evidence" data-delete-evidence="'+esc(e.id)+'" aria-label="Удалить '+esc(e.name||'файл')+'">Убрать</button></div></div></article>';}).join('')+'</div>';}
  function evidenceBlock(role,subject,title,help){return '<div class="section-heading"><div><h3>'+esc(title)+'</h3>'+(help?'<p>'+esc(help)+'</p>':'')+'</div></div><div class="upload-row">'+uploader(role,subject,'Сделать фото',true)+uploader(role,subject,'Выбрать файл')+'</div>'+evidenceCards(role,subject);}

  function packetFiles() { return state.packet && Array.isArray(state.packet.materials) ? state.packet.materials : []; }
  function packetContactText(raw) {
    if (!raw) return '';
    try { if (typeof raw === 'string') raw = JSON.parse(raw); } catch (e) {}
    if (Array.isArray(raw)) return raw.map(packetContactText).filter(Boolean).join('; ');
    if (raw && typeof raw === 'object') return [raw.name || raw.contact_name, raw.phone || raw.contact_phone, raw.comment].filter(Boolean).join(' · ');
    return String(raw);
  }
  function packetPhone() { var text = packetContactText(state.packet && state.packet.contacts); var match = text.match(/\+?\d[\d() -]{8,}\d/); return match ? match[0].replace(/[^+\d]/g, '') : ''; }
  function managerFilesHtml(files, planActions) {
    if (!files.length) return '<p class="field-note">Менеджер пока не приложил файлы.</p>';
    return '<div class="manager-files">' + files.map(function (file) {
      var role = { plan: 'План', egrn: 'ЕГРН', archive: 'Архив', document: 'Документ' }[file.role] || 'Документ';
      var canMark = planActions && /^image\/(jpeg|png|webp)$/.test(file.mime || '');
      return '<article class="manager-file"><div><span class="tag">' + role + '</span><strong>' + esc(file.name) + '</strong><small>' + bytes(file.bytes) + '</small></div><div class="action-row"><button type="button" class="button secondary" data-download-material="' + esc(file.id) + '" aria-label="Скачать ' + esc(file.name) + '">Скачать</button>' + (canMark ? '<button type="button" class="button primary" data-use-plan="' + esc(file.id) + '">Разметить</button>' : '') + '</div></article>';
    }).join('') + '</div>';
  }
  function packetSummary() {
    var packet = state.packet || state.data.request_packet || {}, p = state.data.inspection;
    var contact = packetContactText(packet.contacts), phone = packetPhone(), files = packetFiles();
    var archiveFiles = files.filter(function (f) { return f.role === 'archive'; });
    var hasArchive = !!packet.archive_url || archiveFiles.length > 0;
    var html = '<section class="request-packet"><div class="packet-title"><span class="tag">Заявка менеджера</span><span>' + esc(p.service || 'Услуга не указана') + '</span></div><h2>' + esc(packet.object_name || packet.org || p.org || 'Объект из заявки') + '</h2><p class="packet-address">' + esc(packet.address || p.address || 'Адрес не указан') + '</p><div class="action-row"><button type="button" class="button secondary" data-copy-address>Скопировать адрес</button>' + (phone ? '<a class="button secondary" href="tel:' + esc(phone) + '">Позвонить</a>' : '') + '</div>';
    if (contact) html += '<p class="packet-contact">' + esc(contact) + '</p>';
    if (packet.deadline) html += '<p class="packet-deadline">Срок: ' + esc(String(packet.deadline).slice(0, 10)) + '</p>';
    if (packet.zones_info) html += '<div class="packet-task"><strong>Задача от менеджера</strong><p>' + esc(packet.zones_info) + '</p></div>';
    if (packet.video_required || packet.has_video) html += '<p class="field-note">По заявке нужно снять видео.</p>';
    if (isRenewal()) html += '<div class="archive-box"><h3>Архив для продления</h3>' + (hasArchive ? '<div class="action-row"><button type="button" class="button primary" data-download-archive>Скачать архив</button>' + (packet.archive_url ? '<button type="button" class="button secondary" data-copy-archive>Скопировать ссылку</button>' : '') + '</div>' : '<p>Архив не приложен к заявке. Менеджеру нужно добавить его.</p>') + '</div>';
    html += '<details class="packet-details"><summary>Документы заявки' + (files.length ? ' · ' + files.length : '') + '</summary>' + (files.length ? '<button type="button" class="button secondary full" data-download-materials>Скачать все документы</button>' : '') + managerFilesHtml(files, false) + '</details></section>';
    if (packet.can_edit_packet && !state.frozen && !state.completed) html += '<p class="field-note"><a href="/form?order_id=' + encodeURIComponent(orderId) + '">Менеджеру: дополнить заявку и документы</a></p>';
    if (!p.service || !p.address || !p.org) html += '<div class="note-box warning">В заявке не хватает данных объекта или услуги. Это дополняет менеджер. Наблюдения можно сохранить в черновик.</div>';
    return html;
  }
  function entranceCards() {
    var html = '<section class="capture-section"><div class="section-heading"><h2>Входы</h2></div>';
    if (!state.data.entrances.length) html += '<p class="field-note">Добавьте вход — и сразу сделайте фото.</p>';
    state.data.entrances.forEach(function (e, i) {
      var base = 'entrances.' + i;
      html += '<article class="repeat-card"><div class="card-top"><h3>' + esc(e.label || 'Вход ' + (i + 1)) + '</h3><button type="button" class="card-remove" data-remove-entrance="' + esc(e.id) + '">Убрать</button></div><div class="upload-row">' + uploader('entrance', e.id, 'Фото входа', true) + uploader('entrance', e.id, 'Выбрать фото') + '</div>' + evidenceCards('entrance', e.id);
      html += '<details class="details-block"><summary>Описание / если не удалось осмотреть</summary><div class="fields">' + input('Как обозначить вход', base + '.label', { maxlength: 200 }) + input('Где находится', base + '.location', { placeholder: 'Например: со двора', maxlength: 500 }) + select('Назначение', base + '.kind', ['Для посетителей', 'Служебный', 'Аварийный / эвакуационный', 'Не установлено']) + select('Осмотр', base + '.access', ['Осмотрен', 'Нет доступа', 'Не осмотрен', 'Не проверено']) + input('Примечание', base + '.notes', { type: 'textarea', wide: true, maxlength: 2000, placeholder: 'Что не удалось проверить' }) + '</div></details></article>';
    });
    return html + '<button type="button" class="button secondary full" data-add-entrance>＋ Добавить вход</button><div class="compact-check">' + tri('Все входы проверены?', 'inspection.all_entrances_checked') + '</div><details class="details-block"><summary>Фасад и количество входов</summary><div class="upload-row">' + uploader('exterior', 'facade', 'Фото фасада и адреса', true) + uploader('exterior', 'facade', 'Выбрать файл') + '</div>' + evidenceCards('exterior', 'facade') + '<div class="fields">' + input('Входов на плане', 'inspection.entrances_plan', { inputmode: 'numeric', maxlength: 100 }) + input('Фактически входов', 'inspection.entrances_actual', { inputmode: 'numeric', maxlength: 100 }) + '</div></details></section>';
  }
  function zoneCards() {
    var html = '<section class="capture-section"><div class="section-heading"><h2>Организации рядом</h2></div>';
    if (!state.data.zones.length) html += '<p class="field-note">Увидели возможную зону ограничения — сфотографируйте. Проверить сведения можно дома.</p>';
    state.data.zones.forEach(function (z, i) {
      var base = 'zones.' + i, entries = state.data.entrances.map(function (e) { return { value: e.id, label: e.label || e.id }; });
      html += '<article class="repeat-card"><div class="card-top"><div><h3>' + esc(z.name || 'Организация ' + (i + 1)) + '</h3><span class="tag">' + esc(z.status === 'confirmed' ? 'Есть ограничение' : z.status === 'excluded' ? 'Проверена' : 'Уточнить после выезда') + '</span></div><button type="button" class="card-remove" data-remove-zone="' + esc(z.id) + '">Убрать</button></div><div class="upload-row">' + uploader('zone', z.id, 'Фото организации', true) + uploader('zone', z.id, 'Выбрать файл') + '</div>' + evidenceCards('zone', z.id) + '<div class="fields">' + input('Название или примета', base + '.name', { maxlength: 500, wide: true }) + input('Расстояние, м', base + '.dist', { inputmode: 'decimal', placeholder: 'Если измерили', maxlength: 100 }) + input('Что заметили', base + '.info', { type: 'textarea', placeholder: 'Короткое примечание', maxlength: 2000 }) + '</div>';
      html += '<details class="details-block"><summary>Подробности замера</summary><div class="fields">' + select('От какого входа', base + '.entrance_id', entries) + select('Способ замера', base + '.method', ['Пешеходный маршрут', 'Прямая линия', 'По карте / геопорталу', 'Другой', 'Не измерено']) + input('Откуда и куда измеряли', base + '.points', { maxlength: 1000, wide: true }) + '</div></details>';
      html += '<details class="details-block"><summary>Уточнить после выезда</summary><div class="fields">' + input('Сведения / лицензия', base + '.license', { maxlength: 1000 }) + input('Источник проверки', base + '.source', { maxlength: 2000, placeholder: 'Реестр, ссылка или документ' }) + select('Результат', base + '.status', [{ value: 'pending', label: 'Нужно уточнить' }, { value: 'confirmed', label: 'Ограничение подтверждено' }, { value: 'excluded', label: 'Ограничение не применяется' }], '', true) + input('Основание результата', base + '.resolution', { type: 'textarea', wide: true, maxlength: 2000 }) + '</div></details></article>';
    });
    return html + '<button type="button" class="button secondary full" data-add-zone>＋ Добавить организацию</button><div class="compact-check">' + tri('Окружение проверено со всех входов?', 'inspection.zones_checked') + '</div><details class="details-block"><summary>Добавить схему окружения</summary><div class="upload-row">' + uploader('map', 'surroundings', 'Карта / схема') + '</div>' + evidenceCards('map', 'surroundings') + '</details></section>';
  }
  function outsideStep() { return packetSummary() + entranceCards() + zoneCards(); }
  function insideStep() {
    var p = state.data.inspection, packet = state.packet || {}, files = packetFiles().filter(function (f) { return ['plan', 'egrn', 'archive'].includes(f.role); });
    var videoRequired = !!(packet.video_required || packet.has_video);
    var html = heading(1) + '<div class="upload-row">' + uploader('interior', 'rooms', 'Фото помещения', true) + uploader('interior', 'rooms', 'Выбрать фото') + '</div>' + evidenceCards('interior', 'rooms');
    var videoFields = '<p class="field-note">Покажите вход, все комнаты и стены, зал, бар, склад и кассу.</p><div class="fields">' + select('Видео осмотра', 'inspection.video_status', ['Сделано', 'Снято — загрузить позже', 'Не сделано', 'Не проверено']) + input('Ссылка на видео', 'workflow.video_url', { type: 'url', maxlength: 2000, placeholder: 'Например, сообщение с видео в Telegram' }) + '</div>';
    html += videoRequired ? '<section class="capture-section"><h3>Видео по заявке менеджера</h3>' + videoFields + '</section>' : '<details class="details-block"><summary>Добавить видео</summary>' + videoFields + '</details>';
    html += '<div class="fields" style="margin-top:20px">' + tri('Есть алкоголь на объекте?', 'inspection.alcohol_present') + (isRenewal() && p.alcohol_present === 'Да' ? tri('Весь алкоголь в лицензированных границах?', 'inspection.alcohol_within_licensed') : '') + '</div>';
    html += '<p class="field-note">' + esc(p.service === 'Получение' ? 'Для получения: по вашему рабочему правилу алкоголя на объекте быть не должно.' : p.service === 'Продление' ? 'Для продления: алкоголь должен оставаться в лицензированных границах.' : 'Оцените размещение алкоголя применительно к заявке.') + '</p>';
    html += '<section class="capture-section"><div class="section-heading"><h2>План и границы</h2></div>' + managerFilesHtml(files, true) + '<div class="upload-row">' + uploader('plan', 'source', 'Добавить снимок плана', true) + uploader('plan', 'source', 'Выбрать графику') + '</div>' + evidenceCards('plan', 'source') + '<div class="plan-editor-shell" id="plan-editor"></div><div class="fields">' + tri('Помещение в кадастровых границах?', 'inspection.within_cadastral') + tri('Планировка совпадает с графикой?', 'bti') + (isRenewal() ? tri('Границы совпадают с лицензированными?', 'inspection.licensed_boundaries_match') + tri('Планировка совпадает с архивом?', 'inspection.archive_match') : '') + input('Расхождения и состояние помещения', 'inspection.structural_elements', { type: 'textarea', wide: true, maxlength: 2000, placeholder: 'Что отличается от плана, какие стены или перегородки отметить' }) + '</div></section>';
    html += '<details class="details-block"><summary>Дополнительные замечания</summary><div class="fields">' + input('Состояние ремонта', 'inspection.repair_state', { maxlength: 500 }) + select('Техническое обследование', 'to', ['Нужно', 'Не нужно', 'Не проверено']) + input('Риски / что исправить', 'inspection.risks', { type: 'textarea', wide: true, maxlength: 2000 }) + '</div></details>';
    return html;
  }
  var CHECKS = [['inspection.alcohol_present', 'Наличие алкоголя', 1], ['inspection.within_cadastral', 'Кадастровые границы', 1], ['inspection.all_entrances_checked', 'Осмотр входов', 0], ['inspection.zones_checked', 'Проверка окружения', 0]];
  function issues() {
    var out = [], p = state.data.inspection, packet = state.packet || {};
    function task(key, title, detail, view) { out.push({ key: key, title: title, detail: detail || '', step: view }); }
    if (!p.service || !p.org || !p.address) task('packet', 'Менеджеру нужно дополнить заявку', 'Не хватает объекта, адреса или услуги', 0);
    var unknown = CHECKS.filter(function (c) { return !get(c[0]) || get(c[0]) === 'Не проверено'; });
    if (unknown.length) task('unchecked', 'Осмотр не завершён', unknown.map(function (c) { return c[1]; }).join(', '), unknown[0][2]);
    if (!state.data.entrances.length) task('no-entrances', 'Нет фотографий входов', 'Зафиксируйте каждый вход', 0);
    state.data.entrances.forEach(function (e) { if (e.access === 'Нет доступа' || e.access === 'Не осмотрен') task('entrance-' + e.id, e.label + ' — не проверен', e.notes, 0); if (!evidenceFor('entrance', e.id).length) task('entrance-photo-' + e.id, e.label + ' — нет фото', '', 0); });
    state.data.zones.forEach(function (z) {
      if (z.status === 'pending' || !z.status) task('zone-' + z.id, z.name + ' — уточнить', z.info, 0);
      else if (!z.source && !z.resolution) task('source-' + z.id, z.name + ' — основание не заполнено', '', 0);
      if (z.status === 'confirmed') task('restricted-' + z.id, z.name + ' — есть ограничение', 'Нужна проработка', 0);
    });
    if ((packet.video_required || packet.has_video) && (p.video_status !== 'Сделано' || !state.data.workflow.video_url)) task('video', 'Нужно видео по заявке', p.video_status || '', 1);
    if (isRenewal()) {
      if (!(packet.archive_url || packetFiles().some(function (f) { return f.role === 'archive'; }))) task('archive', 'В заявке нет архива', 'Архив добавляет менеджер', 0);
      if (p.archive_match !== 'Да' || p.licensed_boundaries_match !== 'Да') task('renewal-match', 'Сверка с прошлой проверкой не завершена', '', 1);
      if (p.alcohol_present !== 'Нет' && p.alcohol_within_licensed !== 'Да') task('alcohol-zone', 'Проверить размещение алкоголя', '', 1);
    }
    if (p.service === 'Получение' && p.alcohol_present === 'Да') task('acquisition-alcohol', 'На объекте есть алкоголь', 'Нужно устранить по рабочему правилу', 1);
    if (state.data.bti === 'Нет') task('plan-mismatch', 'Планировка отличается от графики', '', 1);
    if (state.data.to === 'Нужно') task('technical-survey', 'Нужно техническое обследование', '', 1);
    if (!packetFiles().some(function (file) { return file.role === 'plan' || file.role === 'egrn'; }) && !state.evidence.some(function (file) { return file.role === 'plan'; })) task('plan', 'Менеджер не приложил план / ЕГРН', 'Нужна графика из заявки', 1);
    if (p.within_cadastral === 'Нет' || p.all_entrances_checked === 'Нет' || p.zones_checked === 'Нет') task('findings', 'Есть замечания по осмотру', 'Опишите их в заключении', 1);
    return out;
  }
  function tasksHtml(tasks) { return '<div class="task-list">' + tasks.map(function (t) { return '<div class="task"><div class="task-main"><p>' + esc(t.title) + '</p>' + (t.detail ? '<small>' + esc(t.detail) + '</small>' : '') + '</div><button type="button" data-go-step="' + t.step + '">Открыть</button></div>'; }).join('') + '</div>'; }
  function reportStep() {
    var tasks = issues();
    return heading(2) + '<div class="fields">' + select('Результат', 'workflow.conclusion_status', [{ value: 'ready', label: 'Соответствует по проверенным пунктам' }, { value: 'actions', label: 'Нужны действия' }, { value: 'insufficient', label: 'Нужно уточнить' }, { value: 'obstacle', label: 'Есть препятствие' }], '', true) + input('Краткое заключение', 'conclusion', { type: 'textarea', rows: 5, wide: true, maxlength: 6000, placeholder: 'Что обнаружили и что делать дальше' }) + '</div>' + (tasks.length ? '<details class="details-block"><summary>Что осталось уточнить · ' + tasks.length + '</summary>' + tasksHtml(tasks) + '</details>' : '') + '<details class="details-block"><summary>Доработать после выезда</summary><div class="fields">' + input('Что удалось уточнить', 'workflow.followup_notes', { type: 'textarea', wide: true, maxlength: 5000 }) + input('Как проработать замечания', 'workflow.mitigation', { type: 'textarea', wide: true, maxlength: 5000, placeholder: 'Предложение и что нужно перепроверить' }) + input('Дата осмотра', 'inspection.visit_date', { type: 'date' }) + '</div></details><p class="field-note">Незаполненные проверки останутся «Не проверено». Черновик можно сохранить и закончить позже.</p><button type="button" class="button primary full" id="submit-audit">Отправить отчёт</button><p class="field-note" id="submit-status" role="status" aria-live="polite"></p>';
  }
  function normalizeLayout() {
    if (Number(state.data.ui_version) !== 4) {
      var old = Number(state.data.workflow.step) || 0, next = old < 4 ? 0 : old < 6 ? 1 : 2;
      if (state.frozen) state.viewStep = 2;
      else { state.data.workflow.step = next; state.data.ui_version = 4; state.dirty = true; }
    }
    if (!state.frozen) state.data.inspection.region = 'МСК';
  }
  function render() {
    if (editor) { try { editor.destroy(); } catch (e) {} editor = null; }
    fieldId = 0;
    if (!orderId) { root.innerHTML = '<div class="empty-state"><h2>Откройте проверку из заявки менеджера</h2><p>В чате «Замеры 2.0» нажмите кнопку проверки у нужной заявки. Адрес и документы подставятся автоматически.</p></div>'; root.setAttribute('aria-busy', 'false'); $('#steps').hidden = true; $('#previous-step').disabled = true; $('#next-step').disabled = true; $('#save-now').hidden = true; return; }
    var index = step(); root.innerHTML = [outsideStep, insideStep, reportStep][index](); root.setAttribute('aria-busy', 'false');
    bind(); refreshChrome(); loadThumbnails(); if (index === 1) mountEditor(); freezeControls();
  }
  function mountEditor() { var container = $('#plan-editor'); if (!container) return; if (window.AuditPlanEditor && typeof window.AuditPlanEditor.mount === 'function') { try { editor = window.AuditPlanEditor.mount(container, { getState: function () { return state.data.plan; }, onChange: function (plan) { if (state.frozen) return; state.data.plan = plan; changed(); }, evidenceUrl: evidenceUrl, evidence: state.evidence }); } catch (error) { container.textContent = 'Не удалось открыть редактор. Оригинал можно скачать выше.'; } } }
  function refreshChrome() {
    var index = step(); $('#steps').innerHTML = STEPS.map(function (s, i) { return '<button type="button" class="step-button" data-step="' + i + '"' + (i === index ? ' aria-current="step"' : '') + ' aria-label="' + esc(s[0]) + '"><span>' + (i + 1) + '</span><span>' + esc(s[0]) + '</span></button>'; }).join('');
    $('#steps').querySelectorAll('[data-step]').forEach(function (b) { b.onclick = function () { go(Number(b.dataset.step)); }; });
    $('#object-title').textContent = state.data.inspection.org || 'Данные из заявки менеджера'; $('#step-counter').textContent = (index + 1) + ' из 3'; $('#previous-step').disabled = index === 0 || state.submitting; $('#next-step').textContent = index === 2 ? 'К осмотру' : 'Далее →'; $('#next-step').disabled = state.submitting; $('#save-now').disabled = state.submitting || state.frozen || state.conflict;
  }
  function go(index) { if (state.submitting) return; var next = Math.max(0, Math.min(2, index)); if (state.frozen) state.viewStep = next; else { state.data.workflow.step = next; changed(); } render(); window.scrollTo({ top: 0, behavior: 'auto' }); }
  function sanitizeService() { if (!isRenewal()) { state.data.inspection.archive_available = ''; state.data.inspection.archive_match = ''; state.data.inspection.archive_url = ''; state.data.inspection.licensed_boundaries_match = ''; state.data.inspection.alcohol_within_licensed = ''; } else if (state.data.inspection.alcohol_present === 'Нет') state.data.inspection.alcohol_within_licensed = ''; }
  function bind() {
    root.querySelectorAll('[data-bind]').forEach(function (control) { var handler = function () { if (state.submitting || state.frozen) return; var path = control.dataset.bind; set(path, control.type === 'checkbox' ? control.checked : control.value); changed(); if (path === 'inspection.alcohol_present') { sanitizeService(); render(); } }; control.addEventListener(control.tagName === 'SELECT' || control.type === 'checkbox' ? 'change' : 'input', handler); });
    root.querySelectorAll('[data-go-step]').forEach(function (b) { b.onclick = function () { go(Number(b.dataset.goStep)); }; });
    root.querySelectorAll('[data-upload-role]').forEach(function (control) { control.onchange = function () { var files = Array.from(control.files || []); control.value = ''; uploadFiles(files, control.dataset.uploadRole, control.dataset.uploadSubject).catch(function (error) { notify(error.message); }); }; });
    root.querySelectorAll('[data-open-evidence]').forEach(function (b) { b.onclick = function () { openEvidence(b.dataset.openEvidence); }; });
    root.querySelectorAll('[data-delete-evidence]').forEach(function (b) { b.onclick = function () { deleteEvidence(b.dataset.deleteEvidence); }; });
    root.querySelectorAll('[data-download-material]').forEach(function (b) { b.onclick = function () { var file = packetFiles().find(function (f) { return String(f.id) === b.dataset.downloadMaterial; }); if (file) downloadResource(file.url, file.name); }; });
    root.querySelectorAll('[data-use-plan]').forEach(function (b) { b.onclick = function () { useManagerPlan(b.dataset.usePlan); }; });
    var b = $('[data-download-materials]'); if (b) b.onclick = function () { downloadResource(state.packet.materials_download_url || '/api/audit/orders/' + encodeURIComponent(orderId) + '/materials/download-all', 'Документы-заявки-' + orderId + '.zip'); };
    b = $('[data-download-archive]'); if (b) b.onclick = function () { var attached=packetFiles().some(function(file){return file.role==='archive';});var url=state.packet.archive_download_url||(attached?'/api/audit/orders/'+encodeURIComponent(orderId)+'/materials/download-all?role=archive':'/api/audit/orders/'+encodeURIComponent(orderId)+'/archive/download');downloadResource(url,'Архив-заявки-'+orderId+'.zip'); };
    b = $('[data-copy-address]'); if (b) b.onclick = function () { copyText(state.data.inspection.address, 'Адрес скопирован'); };
    b = $('[data-copy-archive]'); if (b) b.onclick = function () { copyText(state.packet.archive_url, 'Ссылка на архив скопирована'); };
    b = $('[data-add-entrance]'); if (b) b.onclick = function () { var n = state.data.entrances.length + 1; state.data.entrances.push({ id: id('entrance'), label: 'Вход ' + n, kind: '', location: '', facing: '', access: '', notes: '' }); if (!state.data.inspection.visit_date) state.data.inspection.visit_date = localDate(); changed(); render(); };
    b = $('[data-add-zone]'); if (b) b.onclick = function () { state.data.zones.push({ id: id('zone'), name: 'Организация ' + (state.data.zones.length + 1), type: '', status: 'pending', entrance_id: state.data.entrances.length === 1 ? state.data.entrances[0].id : '', dist: '', method: '', points: '', license: '', source: '', info: '', resolution: '' }); changed(); render(); };
    root.querySelectorAll('[data-remove-entrance]').forEach(function (button) { button.onclick = function () { var eid = button.dataset.removeEntrance; if (evidenceFor('entrance', eid).length || state.data.zones.some(function (z) { return z.entrance_id === eid; })) { notify('У входа есть фото или замеры. Сначала уберите их привязку.'); return; } state.data.entrances = state.data.entrances.filter(function (e) { return e.id !== eid; }); changed(); render(); }; });
    root.querySelectorAll('[data-remove-zone]').forEach(function (button) { button.onclick = function () { var zid = button.dataset.removeZone; if (evidenceFor('zone', zid).length) { notify('Сначала уберите файлы этой организации.'); return; } state.data.zones = state.data.zones.filter(function (z) { return z.id !== zid; }); changed(); render(); }; });
    b = $('#submit-audit'); if (b) b.onclick = submit;
  }
  async function copyText(text, message) { try { if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('unsupported'); await navigator.clipboard.writeText(text || ''); notify(message); } catch (e) { notify('Адрес или ссылка доступны в заявке — выделите и скопируйте текст.'); } }
  async function downloadResource(url, filename) {
    if(downloadJobs.has(url)){notify('Файл уже готовится. Дождитесь скачивания.');return;}downloadJobs.add(url);
    try {
      var resolved = new URL(url, location.origin); if (resolved.origin !== location.origin || !resolved.pathname.startsWith('/api/audit/orders/')) throw new Error('Некорректная ссылка документа');
      notify('Подготавливаю файл…'); var response = await fetch(resolved.pathname + resolved.search);
      if (!response.ok || (response.headers.get('Content-Type')||'').includes('application/json')) { var error; try { error = await response.json(); } catch (e) {} throw new Error(error && error.error || 'Не удалось скачать файл. Проверьте связь.'); }
      var disposition = response.headers.get('Content-Disposition') || '', named = disposition.match(/filename\*=UTF-8''([^;]+)/i); if (named) { try { filename = decodeURIComponent(named[1]); } catch (e) {} }
      var blob = await response.blob(), objectUrl = URL.createObjectURL(blob), link = document.createElement('a'); link.href = objectUrl; link.download = filename || 'Документ'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000); notify('Файл подготовлен к сохранению. Форма остаётся открытой.');
    } catch (error) { notify(error.message); } finally { downloadJobs.delete(url); }
  }
  async function useManagerPlan(fileId) {
    var file = packetFiles().find(function (f) { return String(f.id) === String(fileId); }); if (!file || state.frozen || state.submitting) return;
    if(String(state.data.plan.manager_material_id||'')===String(fileId)&&state.evidence.some(function(e){return e.id===state.data.plan.evidence_id;})){notify('Этот план уже открыт для разметки.');return;}
    if(state.data.plan.annotations.length&&!window.confirm('Заменить текущий план и его разметку новым файлом?'))return;
    queue(async function () {
      try { await flush(); status('Открываю графику из заявки…'); var response = await fetch(file.url); if (!response.ok) throw new Error('Не удалось получить план из заявки.'); var blob = await response.blob(); var encoded = await readBase64(blob); var uploaded = await postEvidence({ name: file.name, type: file.mime }, 'plan', 'source', encoded); state.data.plan = { evidence_id: uploaded.id, manager_material_id: fileId, annotations: [], wall_basis: '' }; state.data.inspection.plan_source = file.role === 'egrn' ? 'ЕГРН' : file.role === 'archive' ? 'Архив' : 'План из заявки'; state.dirty = true; state.version++; await flush(); render(); notify('План готов к разметке.'); }
      catch (error) { status('Не удалось открыть графику', 'warning'); notify(error.message); }
    });
  }

  async function evidenceUrl(eid){if(blobUrls.has(String(eid)))return blobUrls.get(String(eid));if(!state.draft)throw new Error('Сначала сохраните черновик.');var response=await fetch('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence/'+encodeURIComponent(eid));if(!response.ok)throw new Error('Не удалось загрузить оригинал файла.');var url=URL.createObjectURL(await response.blob());blobUrls.set(String(eid),url);return url;}
  function loadThumbnails(){root.querySelectorAll('[data-evidence-image]').forEach(function(image){evidenceUrl(image.dataset.evidenceImage).then(function(url){if(image.isConnected)image.src=url;}).catch(function(){if(image.isConnected)image.alt='Превью недоступно. Оригинал можно открыть повторно.';});});}
  async function openEvidence(eid){try{var url=await evidenceUrl(eid);var e=state.evidence.find(function(x){return String(x.id)===String(eid);});var link=document.createElement('a');link.href=url;link.download=e&&e.name||'document';document.body.appendChild(link);link.click();link.remove();}catch(error){notify(error.message);}}
  function readBase64(file){return new Promise(function(resolve,reject){var reader=new FileReader();reader.onload=function(){resolve(String(reader.result).split(',')[1]);};reader.onerror=function(){reject(new Error('Не удалось прочитать файл '+file.name));};reader.readAsDataURL(file);});}
  async function evidenceId(file,role,subject,data){var key=[file.name,file.type||file.mime,role,subject||'',data].join('\n');if(window.crypto&&crypto.subtle&&window.TextEncoder){var digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));var hex=Array.from(new Uint8Array(digest)).map(function(n){return n.toString(16).padStart(2,'0');}).join('').slice(0,32);hex=hex.slice(0,12)+'4'+hex.slice(13,16)+'8'+hex.slice(17);return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20,32);}var hash=0;for(var i=0;i<key.length;i++)hash=(Math.imul(31,hash)+key.charCodeAt(i))|0;var short=file.name+':'+role+':'+subject+':'+data.length+':'+hash;if(!uploadIds.has(short))uploadIds.set(short,uuid());return uploadIds.get(short);}
  async function postEvidence(file,role,subject,data,eid){var result=await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:eid||await evidenceId(file,role,subject,data),revision:state.draft.revision,name:file.name,mime:file.type||file.mime,role:role,subject_id:subject||'',data:data})});adoptRevision(result);var evidence=result.evidence;if(evidence&&!Array.isArray(evidence)){state.evidence=state.evidence.filter(function(e){return String(e.id)!==String(evidence.id);});state.evidence.push(evidence);}return evidence;}
  async function uploadFiles(files,role,subject){if(!files.length)return;if(state.submitting||state.frozen||state.conflict){notify('Сначала завершите текущую операцию с черновиком.');return;}var allowed=['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/avif','image/tiff','image/bmp','application/pdf'];var invalid=files.find(function(f){return !allowed.includes(f.type)||f.size>12*1024*1024;});if(invalid)throw new Error(invalid.size>12*1024*1024?'Файл '+invalid.name+' больше 12 МБ.':'Поддерживаются изображения и PDF. Выберите другой формат для '+invalid.name+'.');if(state.evidence.length+state.pendingUploads+files.length>60)throw new Error('В одной проверке можно сохранить до 60 файлов.');var total=state.evidence.reduce(function(n,e){return n+Number(e.size||e.bytes||0);},0)+files.reduce(function(n,f){return n+f.size;},0);if(total>100*1024*1024)throw new Error('Общий объём файлов проверки больше 100 МБ.');state.pendingUploads+=files.length;status('Загружаю оригиналы файлов…');return queue(async function(){try{await flush();for(var i=0;i<files.length;i++){status('Загружаю оригинал '+(i+1)+' из '+files.length+'…');var data=await readBase64(files[i]);await postEvidence(files[i],role,subject,data);state.pendingUploads--;localSave();}status('Оригиналы сохранены на сервере · '+timeLabel(),'success');render();}catch(error){state.pendingUploads=0;status('Файлы сохранены не полностью · '+error.message,'warning');if(error.status===409){state.conflict=true;$('#conflict-panel').hidden=false;}throw error;}});}
  async function deleteEvidence(eid){if(state.submitting||state.frozen||state.conflict)return;var evidence=state.evidence.find(function(e){return String(e.id)===String(eid);});if(!evidence)return;if(!window.confirm('Убрать файл «'+(evidence.name||'документ')+'» из этой проверки?'))return;queue(async function(){try{await flush();var result=await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence/'+encodeURIComponent(eid),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});adoptRevision(result);state.evidence=state.evidence.filter(function(e){return String(e.id)!==String(eid);});if(String(state.data.plan.evidence_id)===String(eid)){state.data.plan.evidence_id='';state.data.plan.annotations=[];state.dirty=true;state.version++;await flush();}if(blobUrls.has(String(eid))){URL.revokeObjectURL(blobUrls.get(String(eid)));blobUrls.delete(String(eid));}localSave();render();notify('Файл убран из проверки.');}catch(error){notify(error.message);}});}
  async function exportPlan(){if(!window.AuditPlanEditor||!state.data.plan.evidence_id||!state.data.plan.annotations.length)return null;var host=document.createElement('div');host.className='export-shell';document.body.appendChild(host);var api;try{api=window.AuditPlanEditor.mount(host,{getState:function(){return state.data.plan;},onChange:function(){},evidenceUrl:evidenceUrl,evidence:state.evidence});await api.refresh();return await api.exportPreview();}finally{if(api)api.destroy();host.remove();}}
  function freezeControls(){
    if(!state.frozen)return;
    root.querySelectorAll('input,select,textarea').forEach(function(control){control.disabled=true;});
    root.querySelectorAll('button').forEach(function(button){if(button.id!=='submit-audit'&&!button.hasAttribute('data-open-evidence')&&!button.hasAttribute('data-go-step')&&!button.hasAttribute('data-download-material')&&!button.hasAttribute('data-download-materials')&&!button.hasAttribute('data-download-archive')&&!button.hasAttribute('data-copy-address')&&!button.hasAttribute('data-copy-archive'))button.disabled=true;});
    root.querySelectorAll('.plan-editor-shell canvas').forEach(function(canvas){canvas.style.pointerEvents='none';});
    var submitButton=$('#submit-audit');if(submitButton)submitButton.textContent='Повторить отправку этой версии';
    var submitStatus=$('#submit-status');if(submitStatus)submitStatus.textContent='Отправка началась — версия зафиксирована. Можно просмотреть этапы и повторить отправку без изменений.';
    notice('Отправка началась — версия зафиксирована. Можно просмотреть данные и повторить отправку без изменений.');
    $('#save-now').disabled=true;
  }
  function frozenSnapshot(remote){
    clearTimeout(timer);var currentStep=step();
    if(remote){state.draft=remote;state.data=restoreData(remote.data);state.viewStep=currentStep;state.packet=state.data.request_packet||null;state.evidence=remote.evidence||[];}
    state.frozen=true;state.dirty=false;render();status('Версия зафиксирована · повторите отправку без изменений','warning');
  }
  async function checkSubmissionState(entered,error){
    if(!entered)return;
    try{
      var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId));
      if(result.draft&&String(result.draft.id)===String(state.draft.id)){
        if(result.draft.submitting){frozenSnapshot(result.draft);return;}
        state.draft=result.draft;state.frozen=false;state.dirty=false;localSave();render();return;
      }
      frozenSnapshot(null);
    }catch(e){
      if(error&&error.payload&&error.payload.frozen===false){state.frozen=false;render();return;}
      frozenSnapshot(null);
    }
  }
  async function submit(){
    if(state.submitting)return;
    var p=state.data.inspection;
    if(!state.frozen){
      if(!p.org.trim()||!p.address.trim()||!p.service){notify('В заявке не хватает данных. Менеджеру нужно дополнить объект, адрес или услугу. Наблюдения сохранены в черновике.');go(0);return;}
      if(!state.data.conclusion.trim()||!state.data.workflow.conclusion_status){notify('Укажите результат и краткое заключение.');return;}
      if(state.data.workflow.conclusion_status==='ready'&&issues().length){notify('Есть открытые вопросы. Выберите «Нужно уточнить» или «Нужны действия», либо завершите проверку.');return;}
      state.data.ui_version=4;state.data.inspection.region='МСК';
      ['alcohol_present','within_cadastral','all_entrances_checked','zones_checked'].forEach(function(key){if(!p[key])p[key]='Не проверено';});
      if(isRenewal()){if(!p.archive_available)p.archive_available=state.packet&&(state.packet.archive_url||packetFiles().some(function(f){return f.role==='archive';}))?'Да':'Не проверено';if(!p.archive_match)p.archive_match='Не проверено';if(!p.licensed_boundaries_match)p.licensed_boundaries_match='Не проверено';if(p.alcohol_present!=='Нет'&&!p.alcohol_within_licensed)p.alcohol_within_licensed='Не проверено';}
      ['building_type','boundaries','bti','to'].forEach(function(key){if(!state.data[key])state.data[key]='Не проверено';});
      state.data.zones.forEach(function(zone,i){if(!zone.name.trim())zone.name='Организация '+(i+1)+' — название уточнить';});
      state.dirty=true;state.version++;localSave();
    }
    var enteredSubmission=state.frozen;
    state.submitting=true;document.body.classList.add('submitting');refreshChrome();
    var submitStatus=$('#submit-status');if(submitStatus)submitStatus.textContent=state.frozen?'Повторяю отправку зафиксированной версии…':'Сохраняю последнюю версию и проверяю приложения…';
    try{
      await queue(async function(){
        if(!state.frozen){
          await flush();var preview=await exportPlan();
          if(preview){if(submitStatus)submitStatus.textContent='Сохраняю размеченный план…';await postEvidence({name:preview.name,type:preview.mime},preview.role||'plan',preview.subject_id||'annotation',preview.data);}
        }
        if(submitStatus)submitStatus.textContent='Передаю отчёт. Дождитесь подтверждения…';
        enteredSubmission=true;state.frozen=true;clearTimeout(timer);
        var result=await request('/api/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft_id:state.draft.id,revision:state.draft.revision})});
        adoptRevision(result);state.dirty=false;state.completed=true;document.body.classList.remove('submitting');
        try{if(state.recoveryData)localStorage.setItem(localKey+':recovery',JSON.stringify({data:state.recoveryData,saved_at:Date.now()}));localStorage.removeItem(localKey);}catch(e){}
        if(editor){editor.destroy();editor=null;}
        root.innerHTML='<div class="success-screen"><div class="success-mark">✓</div><h2>Отчёт отправлен</h2><p>Материалы и замечания сохранены с этой заявкой.</p><a class="button secondary" href="/requests">К заявкам</a></div>';
        $('#next-step').disabled=true;$('#previous-step').disabled=true;status('Отчёт отправлен · '+timeLabel(),'success');
        try{if(tg)tg.HapticFeedback.notificationOccurred('success');}catch(e){}
      });
    }catch(error){
      state.submitting=false;document.body.classList.remove('submitting');
      await checkSubmissionState(enteredSubmission,error);
      refreshChrome();
      if(error.status===409&&!state.frozen){state.conflict=true;$('#conflict-panel').hidden=false;}
      submitStatus=$('#submit-status');
      if(submitStatus)submitStatus.textContent='Отправка не подтверждена: '+error.message+(state.frozen?' Повторите отправку этой версии без изменений.':' Исправьте замечания и повторите.');
      notify('Отправка не подтверждена. '+error.message);
    }
  }

  function downloadCopy(){var data=JSON.stringify({exported_at:new Date().toISOString(),draft_id:state.draft&&state.draft.id,data:state.recoveryData||state.data,evidence:state.evidence.map(function(e){return{id:e.id,name:e.name,role:e.role,subject_id:e.subject_id};})},null,2);var link=document.createElement('a');var url=URL.createObjectURL(new Blob([data],{type:'application/json'}));link.href=url;link.download='audit-draft-'+(state.draft&&state.draft.id||'local')+'.json';link.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
  async function reloadServer(){
    if(!window.confirm('Загрузить серверную версию вместо локальных правок? При необходимости сначала скачайте свою копию.'))return;
    try{var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId));if(!result.draft)throw new Error('Серверная версия не найдена.');state.data=restoreData(result.draft.data);state.draft=result.draft;state.evidence=result.draft.evidence||[];state.conflict=false;state.dirty=false;state.frozen=!!result.draft.submitting;state.viewStep=state.frozen?2:null;state.packet=state.data.request_packet||null;$('#conflict-panel').hidden=true;if(!state.frozen)await fetchPacket();localSave();render();status(state.frozen?'Повторите отправку этой версии':'Загружено с сервера',state.frozen?'warning':'success');}catch(error){notify(error.message);}
  }
  function prefillContact(raw){
    if(!raw)return;
    var parsed=raw;
    if(typeof raw==='string'){try{parsed=JSON.parse(raw);}catch(e){parsed=raw;}}
    if(Array.isArray(parsed))parsed=parsed[0]||'';
    if(parsed&&typeof parsed==='object'){
      state.data.workflow.contact_name=String(parsed.name||parsed.contact_name||'');
      state.data.workflow.contact_phone=String(parsed.phone||parsed.contact_phone||'');
      if(!state.data.workflow.contact_name&&!state.data.workflow.contact_phone)state.data.workflow.access_notes=JSON.stringify(parsed);
      return;
    }
    var text=String(parsed).trim();var matches=text.match(/\+?\d[\d() -]{8,}\d/g)||[];
    var phone=matches.find(function(value){var digits=value.replace(/\D/g,'');return digits.length>=10&&digits.length<=15;});
    if(phone)state.data.workflow.contact_phone=phone.trim();
    if(text!==phone)state.data.workflow.access_notes='Контакты из заявки: '+text;
  }
  function restoreData(raw){
    var next=merge(clone(defaults),raw||{});
    if(Number(raw&&raw.ui_version)!==4){var old=Number(raw&&raw.workflow&&raw.workflow.step)||0;next.workflow.step=old<4?0:old<6?1:2;}
    next.ui_version=4;next.inspection.region='МСК';return next;
  }
  async function fetchPacket(){
    if(state.frozen){state.packet=state.data.request_packet||state.packet;return;}
    var packet=await request('/api/audit/prefill?order_id='+encodeURIComponent(orderId));
    if(['tobacco','other'].includes(packet.object_category)){window.location.replace('/audit/legacy'+window.location.search);return;}
    var before=JSON.stringify(stable(state.data));state.packet=packet;
    state.data.inspection.org=packet.org||'';state.data.inspection.address=packet.address||'';state.data.inspection.service=packet.service||'';state.data.inspection.region='МСК';
    state.data.object_category=['catering','retail'].includes(packet.object_category)?packet.object_category:'catering';
    state.data.request_packet=clone(packet);state.data.order_material_ids=packetFiles().map(function(file){return file.id;});
    prefillContact(packet.contacts);state.data.inspection.archive_url=packet.archive_url||'';
    if(isRenewal())state.data.inspection.archive_available=packet.archive_url||packetFiles().some(function(file){return file.role==='archive';})?'Да':'Не проверено';
    else sanitizeService();
    if(before!==JSON.stringify(stable(state.data))){state.version++;state.dirty=true;}
    state.packetError='';
  }
  async function initialize(){
    if(!orderId){state.loaded=true;render();status('Откройте заявку менеджера');return;}
    var local=null;try{local=JSON.parse(localStorage.getItem(localKey)||'null');}catch(e){}
    if(local&&local.data){state.data=restoreData(local.data);state.dirty=!!local.dirty;state.draft=local.draft_id?{id:local.draft_id,revision:local.revision}:null;state.localSaved=true;state.packet=state.data.request_packet||null;}
    try{
      var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId));
      if(!result.draft&&local&&!local.dirty){state.data=clone(defaults);state.draft=null;state.evidence=[];state.dirty=false;local=null;state.localSaved=false;try{localStorage.removeItem(localKey);}catch(e){}}
      if(result.draft){
        var remote=result.draft;
        if(remote.submitting){if(local&&local.dirty){state.recoveryData=clone(local.data);state.conflict=true;$('#conflict-panel').hidden=false;}state.draft=remote;state.data=restoreData(remote.data);state.evidence=remote.evidence||[];state.frozen=true;state.viewStep=2;state.dirty=false;state.packet=state.data.request_packet||null;}
        else if(local&&local.dirty){if(String(local.draft_id||'')===String(remote.id)&&Number(local.revision)===Number(remote.revision)){state.draft=remote;state.evidence=remote.evidence||[];}else{state.draft=remote;state.evidence=remote.evidence||[];state.conflict=true;$('#conflict-panel').hidden=false;}}
        else{state.data=restoreData(remote.data);state.draft=remote;state.evidence=remote.evidence||[];state.dirty=Number(remote.data&&remote.data.ui_version)!==4;}
      }
      if(!state.frozen&&!state.conflict){try{await fetchPacket();}catch(error){state.packet=state.data.request_packet||null;state.packetError=error.message;notice('Материалы заявки сейчас недоступны. Сохранённые наблюдения остаются в черновике.');}}
      normalizeLayout();state.data.schema_version=3;state.data.order_id=orderId;state.loaded=true;render();$('#draft-id').textContent='Заявка #'+orderId;localSave();
      if(state.frozen)status('Версия зафиксирована — можно повторить отправку','warning');
      else if(state.conflict)status('Есть другая версия. Ваши правки сохранены на устройстве.','warning');
      else if(state.dirty)saveNow().catch(function(){});
      else status(state.draft?'Черновик загружен':'Данные заявки загружены',state.draft?'success':'');
    }catch(error){state.loaded=true;state.packet=state.data.request_packet||null;normalizeLayout();render();state.serverError=error.message;status(state.localSaved?'Восстановлено с устройства':'Нет связи с сервером','warning');notice('Можно продолжить текст на этом устройстве. Для файлов и отправки нужен доступ к серверу.');}
  }
  $('#previous-step').onclick=function(){go(step()-1);};$('#next-step').onclick=function(){go(step()===2?0:step()+1);};$('#save-now').onclick=function(){saveNow().then(function(){notify('Черновик сохранён на сервере.');}).catch(function(error){notify(error.message);});};$('#download-copy').onclick=downloadCopy;$('#reload-server').onclick=reloadServer;
  window.addEventListener('online',function(){if(state.dirty&&!state.conflict)saveNow().catch(function(){});});
  window.addEventListener('beforeunload',function(event){localSave();if(state.dirty||state.pendingUploads){event.preventDefault();event.returnValue='';}});
  initialize();
})();
