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
    ['Объект', 'Объект и предварительная оценка', 'Подтвердите адрес, услугу и документы. Оценка на этом этапе предварительная.'],
    ['Выезд', 'Договориться о выезде', 'Согласуйте время, контакт на месте и доступ. Маршрут откроется по адресу объекта.'],
    ['Входы', 'Начните снаружи', 'Зафиксируйте фасад и каждый вход или выход отдельно — в том числе со двора.'],
    ['Зоны', 'Проверьте окружение', 'Фотографируйте и подозрительные организации. Их статус можно уточнить после выезда.'],
    ['Внутри', 'Осмотрите помещение', 'Снимите маршрут по всем комнатам, стены, зал, склад и размещение алкоголя.'],
    ['План', 'Сопоставьте помещение с планом', 'Отметьте границы и фактические конструктивные элементы. Если назначение стены не установлено, так и укажите.'],
    ['Доработка', 'Вернитесь к открытым вопросам', 'Все сомнения остаются здесь вместе с фотографиями. Можно продолжить дома с другого устройства после сохранения.'],
    ['Итог', 'Соберите результат проверки', 'Проверьте комплектность и сформулируйте вывод. Открытые вопросы передаются вместе с отчётом.']
  ];
  var TRI = ['', 'Да', 'Нет', 'Не проверено'];
  var defaults = {
    schema_version: 3, object_category: 'catering', order_id: orderId,
    inspection: {service:'',org:'',address:'',visit_date:'',region:'',municipality:'',building_placement:'',urban_rural:'',catering_type:'',area_total:'',area_hall:'',floor_plan:'',floor_actual:'',plan_source:'',plan_note:'',structural_elements:'',archive_available:'',archive_match:'',archive_url:'',alcohol_present:'',alcohol_within_licensed:'',within_cadastral:'',licensed_boundaries_match:'',entrances_plan:'',entrances_actual:'',all_entrances_checked:'',zones_checked:'',video_status:'',repair_state:'',risks:''},
    workflow: {step:0,contact_name:'',contact_phone:'',call_status:'',appointment_at:'',access_notes:'',preliminary_status:'',precheck_notes:'',documents:{egrn:'',lease:'',plan:'',license:''},video_url:'',followup_notes:'',mitigation:'',conclusion_status:''},
    entrances: [], zones: [], plan: {evidence_id:'',annotations:[],wall_basis:''},
    building_type:'',boundaries:'',bti:'',to:'',nearby:'',veranda:false,patz:false,passport:false,owner_info:'',conclusion:''
  };
  var state = {data:clone(defaults),draft:null,evidence:[],dirty:false,version:0,conflict:false,submitting:false,frozen:false,completed:false,loaded:false,localSaved:false,pendingUploads:0,uploadText:'',serverError:'',recoveryData:null};
  var tail = Promise.resolve();
  var timer = null;
  var toastTimer = null;
  var editor = null;
  var blobUrls = new Map();
  var uploadIds = new Map();
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
  function step() { var n=Number(state.data.workflow.step);return Number.isInteger(n)?Math.max(0,Math.min(7,n)):0; }
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
  function heading(index){return '<div class="step-heading"><div class="step-kicker">Этап '+(index+1)+' из 8</div><h2>'+esc(STEPS[index][1])+'</h2><p>'+esc(STEPS[index][2])+'</p></div>';}
  function uploader(role,subject,label,imagesOnly){var uid=id('upload');return '<label class="upload-control" for="'+uid+'"><input type="file" id="'+uid+'" data-upload-role="'+esc(role)+'" data-upload-subject="'+esc(subject||'')+'" accept="'+(imagesOnly?'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif,image/tiff,image/bmp':'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif,image/tiff,image/bmp,application/pdf')+'"'+(imagesOnly?' capture="environment"':'')+' multiple><span class="upload-label">'+esc(label||'Добавить файл или фото')+'</span></label>';}
  function evidenceFor(role,subject){return state.evidence.filter(function(e){return e.role===role&&(subject==null||String(e.subject_id||'')===String(subject));});}
  function evidenceCards(role,subject){var files=evidenceFor(role,subject);if(!files.length)return '';return '<div class="evidence-grid">'+files.map(function(e){var image=/^image\//.test(e.mime||e.mime_type||'');return '<article class="evidence-card"><div class="evidence-preview">'+(image?'<img alt="'+esc(e.name||'Фото')+'" data-evidence-image="'+esc(e.id)+'">':'PDF')+'</div><div class="evidence-details"><div class="evidence-name">'+esc(e.name||'Файл')+'</div><div class="evidence-meta">Оригинал · '+bytes(e.size||e.bytes||0)+'</div><div class="evidence-actions"><button type="button" data-open-evidence="'+esc(e.id)+'">Открыть</button><button type="button" class="remove-evidence" data-delete-evidence="'+esc(e.id)+'" aria-label="Удалить '+esc(e.name||'файл')+'">Убрать</button></div></div></article>';}).join('')+'</div>';}
  function evidenceBlock(role,subject,title,help){return '<div class="section-heading"><div><h3>'+esc(title)+'</h3>'+(help?'<p>'+esc(help)+'</p>':'')+'</div></div><div class="upload-row">'+uploader(role,subject,'Сделать фото',true)+uploader(role,subject,'Выбрать файл')+'</div>'+evidenceCards(role,subject);}

  function objectStep(){
    var p=state.data.inspection;
    return heading(0)+'<div class="fields">'+input('Организация / название объекта','inspection.org',{placeholder:'Название клиента или заведения',maxlength:500})+select('Формат','object_category',[{value:'catering',label:'Общепит'},{value:'retail',label:'Магазин'}])+input('Адрес и помещение','inspection.address',{wide:true,placeholder:'Город, улица, дом, помещение',maxlength:500})+select('Услуга','inspection.service',['Получение','Продление','Переоформление'])+select('Регион','inspection.region',['МСК','МО','Другой','Не проверено'])+input('Муниципалитет / городской округ','inspection.municipality',{placeholder:'Нужен для проверки местных ограничений',maxlength:500})+'</div><details class="details-block"><summary>Характеристики помещения</summary><div class="fields">'+select('Населённый пункт','inspection.urban_rural',['Городской','Сельский','Не проверено'])+select('Здание','building_type',['Жилое','Нежилое','Не проверено'])+select('Размещение помещения','inspection.building_placement',['В многоквартирном доме','В пристройке к МКД','Отдельное здание','Другое','Не проверено'])+(state.data.object_category==='catering'?select('Вид общепита','inspection.catering_type',['Ресторан','Кафе','Бар','Буфет','Другое','Не проверено']):'')+input('Общая площадь, м²','inspection.area_total',{type:'number',help:'По документу; уточнить источник ниже.'})+input('Площадь зала обслуживания, м²','inspection.area_hall',{type:'number',help:'Отдельно от общей площади.'})+'</div></details><div class="note-box">Собираем факты для конкретного региона и формата. Расстояние или площадь сами по себе не дают автоматического заключения.</div><div class="section-heading"><h3>Документы до выезда</h3></div><div class="fields">'+select('Выписка ЕГРН','workflow.documents.egrn',['Есть','Нужно запросить','Не проверено'])+select('Договор / основание пользования','workflow.documents.lease',['Есть','Нужно запросить','Не проверено'])+select('План помещения','workflow.documents.plan',['Есть','Нужно запросить','Не проверено'])+(isRenewal()?select('Действующая лицензия и границы','workflow.documents.license',['Есть','Нужно запросить','Не проверено']):'')+'</div><div class="upload-row">'+uploader('document','precheck','Прикрепить документ')+'</div>'+evidenceCards('document','precheck')+'<div class="fields" style="margin-top:22px">'+select('Предварительная оценка','workflow.preliminary_status',['Нужен выезд','Нужны документы','Есть риск — обсудить с юристом','Не проверено'],'Это ещё не итог проверки.',true)+input('Что выяснить до выезда','workflow.precheck_notes',{type:'textarea',wide:true,placeholder:'Какие документы запросить, какие вопросы задать',maxlength:4000})+'</div>'+(isRenewal()?'<div class="section-heading"><h3>Материалы предыдущей проверки</h3></div><div class="fields">'+tri('Архив доступен?','inspection.archive_available')+input('Ссылка на папку / документ архива','inspection.archive_url',{type:'url',placeholder:'https://disk.yandex.ru/…',help:'Сверьте, что адрес и помещение относятся к этому объекту.',maxlength:2000})+'</div>':'');
  }
  function appointmentStep(){var p=state.data.inspection,w=state.data.workflow;var phone=w.contact_phone.replace(/[^+\d]/g,'');return heading(1)+'<div class="fields">'+input('Контакт на месте','workflow.contact_name',{placeholder:'Кто встретит аудитора',maxlength:500})+input('Телефон','workflow.contact_phone',{type:'tel',placeholder:'+7 …',maxlength:100})+select('Созвон с клиентом','workflow.call_status',['Нужно позвонить','Не дозвонился','Ожидаю ответ','Связался — дату уточняем','Выезд согласован','Выезд перенесён','Не требуется'])+input('Согласованные дата и время','workflow.appointment_at',{type:'datetime-local'})+input('Дата осмотра для отчёта','inspection.visit_date',{type:'date'})+input('Как попасть на объект','workflow.access_notes',{type:'textarea',wide:true,placeholder:'Пропуск, парковка, ключи, какие комнаты должны открыть',maxlength:2000})+'</div><div class="action-row" style="margin-top:20px">'+(phone?'<a class="button secondary" href="tel:'+esc(phone)+'">Позвонить клиенту</a>':'')+(p.address?'<a class="button secondary" target="_blank" rel="noopener noreferrer" href="https://yandex.ru/maps/?text='+encodeURIComponent(p.address)+'">Открыть адрес и маршрут ↗</a>':'')+'</div><div class="note-box"><h3>Перед выездом</h3>Уточните доступ ко всем входам и помещениям. Возьмите представленный план и материалы прошлой проверки, если это продление.</div><button type="button" class="button primary full" data-start-visit>Я на объекте → перейти к входам</button>';}
  function entranceStep(){
    var html=heading(2);
    if(!state.data.entrances.length)html+='<div class="empty-state">Добавьте первый вход и сфотографируйте его.</div>';
    state.data.entrances.forEach(function(e,i){
      var base='entrances.'+i;
      html+='<article class="repeat-card"><div class="card-top"><div><h3>'+esc(e.label||'Вход '+(i+1))+'</h3><p class="card-subtitle">Вход / выход '+(i+1)+'</p></div><button type="button" class="card-remove" data-remove-entrance="'+esc(e.id)+'">Убрать</button></div>';
      html+='<div class="fields">'+input('Обозначение',base+'.label',{placeholder:'Вход 1',maxlength:200,wide:true})+'</div>';
      html+='<div class="upload-row">'+uploader('entrance',e.id,'Фото этого входа',true)+uploader('entrance',e.id,'Выбрать фото')+'</div>'+evidenceCards('entrance',e.id);
      html+='<div class="fields">'+select('Назначение',base+'.kind',['Для посетителей','Служебный','Аварийный / эвакуационный','Не установлено'])+select('Доступ / осмотр',base+'.access',['Осмотрен','Нет доступа','Не осмотрен','Не проверено'])+input('Где расположен',base+'.location',{placeholder:'Фасад, двор, левая сторона…',maxlength:500})+select('Сторона выхода',base+'.facing',['На улицу','Во двор','Другое','Не проверено'])+input('Примечание',base+'.notes',{type:'textarea',wide:true,placeholder:'Чем обозначен на плане, почему нет доступа',maxlength:2000})+'</div></article>';
    });
    html+='<button type="button" class="button secondary full" data-add-entrance>＋ Добавить вход / выход</button><details class="details-block"><summary>Сводка входов: план и факт</summary><div class="fields">'+input('Входов на представленном плане','inspection.entrances_plan',{inputmode:'numeric',placeholder:'Количество или «Не проверено»',maxlength:100})+input('Фактических входов / выходов','inspection.entrances_actual',{inputmode:'numeric',placeholder:'Количество или «Не проверено»',maxlength:100})+'</div><p class="field-note">Отдельно зафиксируйте доступные посетителям входы, служебные двери и выходы. У каждой фотографии будет свой номер входа.</p></details><div class="section-heading"><h3>Фасад и адресная табличка</h3></div><div class="upload-row">'+uploader('exterior','facade','Сделать фото фасада',true)+uploader('exterior','facade','Выбрать файл')+'</div>'+evidenceCards('exterior','facade')+'<div class="fields" style="margin-top:22px">'+tri('Все фактические входы и выходы осмотрены?','inspection.all_entrances_checked','Если доступа не было, вопрос останется в доработке.',true)+'</div>';
    return html;
  }
  function zonesStep(){
    var html=heading(3)+'<div class="note-box warning">Фиксируйте фактическое расстояние, точки и способ замера. Применимые границы и исключения проверяются по действующим правилам конкретного места.</div>';
    if(!state.data.zones.length)html+='<div class="empty-state">Соседние организации ещё не добавлены. Это не означает, что ограничений нет.</div>';
    state.data.zones.forEach(function(z,i){
      var b='zones.'+i;
      var entranceOptions=state.data.entrances.map(function(e){return{value:e.id,label:e.label||e.id};});
      html+='<article class="repeat-card"><div class="card-top"><div><h3>'+esc(z.name||'Организация '+(i+1))+'</h3><span class="tag">'+esc(z.status==='confirmed'?'Ограничение подтверждено':z.status==='excluded'?'Исключена с основанием':'Нужно проверить')+'</span></div><button type="button" class="card-remove" data-remove-zone="'+esc(z.id)+'">Убрать</button></div>';
      html+='<div class="fields">'+input('Название / вывеска',b+'.name',{placeholder:'Например, стоматология',maxlength:500})+select('Предполагаемый тип',b+'.type',['Образовательная','Медицинская','Спортивная','Культурная','Транспорт / вокзал','Рынок','Военный объект','Другой','Не установлен'])+'</div>';
      html+='<div class="upload-row">'+uploader('zone',z.id,'Фото вывески / входа',true)+uploader('zone',z.id,'Фото, схема или документ')+'</div>'+evidenceCards('zone',z.id);
      html+='<div class="fields" style="margin-top:16px">'+input('Наблюдения на месте',b+'.info',{type:'textarea',wide:true,placeholder:'Что увидели и что нужно уточнить дома',maxlength:2000})+'</div>';
      html+='<details class="details-block"><summary>Замер и маршрут</summary><div class="fields">'+select('От какого входа объекта проверяем',b+'.entrance_id',entranceOptions,'Сопоставьте замер с конкретным входом.')+input('Измеренное расстояние, м',b+'.dist',{inputmode:'decimal',placeholder:'Факт замера, без автоматического вывода',maxlength:100})+select('Способ замера',b+'.method',['Пешеходный маршрут','Прямая линия','По карте / геопорталу','Другой','Не измерено'])+input('Начальная и конечная точки',b+'.points',{placeholder:'От какой двери / границы до какой',maxlength:1000})+'</div></details>';
      html+='<details class="details-block"><summary>Проверить после выезда</summary><div class="fields">'+input('Лицензия / сведения об организации',b+'.license',{placeholder:'Номер, реестр или «нужно проверить»',maxlength:1000})+input('Источник проверки',b+'.source',{placeholder:'Ссылка на реестр, документ, карта',maxlength:2000})+select('Результат проверки',b+'.status',[{value:'pending',label:'Нужно уточнить'},{value:'confirmed',label:'Ограничение подтверждено'},{value:'excluded',label:'Организация исключена из ограничений'}],'Не делайте положительный вывод только по вывеске.',true)+input('Основание результата / что уточнить',b+'.resolution',{type:'textarea',wide:true,placeholder:'Почему это ограничение или почему оно не применяется; что ещё нужно проверить',maxlength:2000})+'</div></details></article>';
    });
    html+='<button type="button" class="button secondary full" data-add-zone>＋ Добавить организацию / подозрение</button><div class="section-heading"><h3>Карта организаций и входов</h3></div><div class="upload-row">'+uploader('map','surroundings','Прикрепить карту / схему')+'</div>'+evidenceCards('map','surroundings')+'<div class="fields" style="margin-top:22px">'+tri('Окружение проверено со всех входов?','inspection.zones_checked','Неосмотренные стороны и сомнения остаются в доработке.',true)+input('Другие наблюдения рядом','nearby',{type:'textarea',wide:true,placeholder:'Закрытые помещения, ремонт, потенциальные новые организации',maxlength:2000})+'</div>';
    return html;
  }
  function interiorStep(){var p=state.data.inspection;var rule=p.service==='Получение'?'Получение: по вашему рабочему правилу алкоголь должен отсутствовать на объекте.':p.service==='Продление'?'Продление: при наличии алкоголя нужно проверить, что он весь в лицензированных границах.':'Размещение алкоголя при переоформлении требует отдельной оценки.';return heading(4)+'<div class="note-box"><h3>Что показать на видео</h3>Адрес и табличку → путь от входа → все комнаты и стены → зал, бар и склад → кассу, мебель и фактическое размещение алкоголя. Отдельно отметьте закрытые части.</div><div class="fields">'+select('Видео осмотра','inspection.video_status',['Сделано','Снято — загрузить позже','Не сделано','Не проверено'],'Статус «снято» не означает, что файл уже загружен.')+input('Ссылка на видео','workflow.video_url',{type:'url',placeholder:'Ссылка на сохранённое видео',maxlength:2000})+tri('Есть алкоголь на объекте?','inspection.alcohol_present')+(isRenewal()&&p.alcohol_present!=='Нет'?tri('Весь алкоголь в лицензированной зоне?','inspection.alcohol_within_licensed'):'')+input('Состояние ремонта','inspection.repair_state',{placeholder:'Готово / ремонт / что осталось завершить',maxlength:500})+input('Риски и наблюдения внутри','inspection.risks',{type:'textarea',wide:true,placeholder:'Что обнаружено и что нужно исправить',maxlength:2000})+'</div><div class="note-box'+(p.service==='Получение'&&p.alcohol_present==='Да'?' warning':'')+'">'+esc(rule)+'</div><div class="section-heading"><h3>Помещения на фото</h3></div><div class="upload-row">'+uploader('interior','rooms','Снять помещение',true)+uploader('interior','rooms','Добавить фото')+'</div>'+evidenceCards('interior','rooms')+'<details class="details-block"><summary>Состав помещения и дополнительные наблюдения</summary><div class="info-grid">'+checkbox('Зал обслуживания / торговый зал определён','chk_hall')+checkbox('Подсобные и складские помещения определены','chk_storage')+checkbox('ККТ и мебель зафиксированы','chk_kkt_furniture')+checkbox('Все стены и комнаты зафиксированы','chk_all_rooms')+checkbox('Есть веранда','veranda')+checkbox('Есть ПАТЗ','patz')+checkbox('Нужен вопрос по паспорту безопасности','passport')+'</div><div class="fields">'+input('Собственник / основание пользования','owner_info',{type:'textarea',wide:true,placeholder:'Что известно на выезде; документы проверяет юрист',maxlength:2000})+'</div></details>';}
  function planStep(){var p=state.data.inspection;return heading(5)+'<div class="fields">'+select('Источник графики','inspection.plan_source',['ЕГРН','БТИ','Архив','Договор аренды','Другое','Нет графики','Не проверено'])+input('Номер / дата документа','inspection.plan_note',{placeholder:'Какой именно план использован',maxlength:2000})+input('Этаж по плану','inspection.floor_plan',{placeholder:'Подвал, первый… или «Не проверено»',maxlength:500})+input('Фактический этаж','inspection.floor_actual',{placeholder:'По осмотру',maxlength:500})+'</div><div class="section-heading"><div><h3>Исходный план</h3><p>Изображение можно разметить здесь. PDF сохраняется оригиналом; для рисования добавьте изображение нужной страницы.</p></div></div><div class="upload-row">'+uploader('plan','source','Загрузить план / графику')+'</div>'+evidenceCards('plan','source')+'<div class="plan-legend"><span><i style="--color:#a573d4"></i>Заявленные границы</span><span><i style="--color:#c39b31"></i>Аренда</span><span><i style="--color:#d15b70"></i>Зал</span><span><i style="--color:#409c76"></i>Бар</span></div><div class="plan-editor-shell" id="plan-editor"><div class="plan-placeholder">Редактор плана загружается. Исходник и пояснения можно сохранить независимо от редактора.</div></div><div class="fields">'+tri('Объект внутри кадастрового помещения?','inspection.within_cadastral')+select('Границы объекта однозначны?','boundaries',['Да','Нет','Под вопросом','Не проверено'])+(isRenewal()?tri('Границы совпадают с лицензированными?','inspection.licensed_boundaries_match')+tri('Планировка совпадает с архивом?','inspection.archive_match'):'')+select('Фактическая планировка соответствует представленному плану?','bti',['Да','Нет','Не проверено'],'Отметьте фактические расхождения; юридическую применимость документа проверяет юрист.')+select('Техническое обследование','to',['Нужно','Не нужно','Не обязательно','Не проверено'])+input('Стены, перегородки, колонны, проёмы','inspection.structural_elements',{type:'textarea',wide:true,placeholder:'Фактическое расположение и отличия от плана',maxlength:2000})+'</div><details class="details-block"><summary>Дополнительные результаты сверки</summary><div class="info-grid">'+checkbox('Фактическая планировка соответствует представленному БТИ','chk_bti_match')+checkbox('Расхождений с планом не обнаружено','chk_no_replan')+checkbox('Границы однозначно определимы','chk_clear_borders')+checkbox('Кадастровое помещение не разделено / не объединено','chk_cadastr')+checkbox('Есть изменения планировки — нужна оценка','replan')+'</div></details>';}

  var CHECKS=[
    ['inspection.service','Услуга',0],['inspection.region','Регион',0],['inspection.building_placement','Размещение помещения',0],['building_type','Тип здания',0],['inspection.alcohol_present','Наличие алкоголя',4],['inspection.within_cadastral','Кадастровые границы',5],['boundaries','Однозначность границ',5],['bti','Сверка с представленным планом',5],['to','Техническое обследование',5],['inspection.all_entrances_checked','Осмотр всех входов',2],['inspection.zones_checked','Проверка окружения',3]
  ];
  function issues(){var out=[];function task(key,title,detail,s){out.push({key:key,title:title,detail:detail||'',step:s});}
    CHECKS.forEach(function(c){var v=get(c[0]);if(!v||v==='Не проверено'||v==='Под вопросом'||v==='Не установлено')task(c[0],c[1]+' — уточнить',v?'Ответ: '+v:'Ответ пока не указан',c[2]);});
    if(isRenewal()){['archive_available','archive_match','licensed_boundaries_match'].forEach(function(k){if(!get('inspection.'+k)||get('inspection.'+k)==='Не проверено')task('inspection.'+k,({archive_available:'Архив предыдущей проверки',archive_match:'Сверка с архивом',licensed_boundaries_match:'Лицензированные границы'})[k], 'Требуется подтверждение', k==='archive_available'?0:5);});if(state.data.inspection.alcohol_present!=='Нет'&&state.data.inspection.alcohol_within_licensed!=='Да')task('renewal-alcohol','Размещение алкоголя в лицензированных границах',state.data.inspection.alcohol_within_licensed||'Не проверено',4);}
    if(state.data.inspection.service==='Получение'&&state.data.inspection.alcohol_present==='Да')task('acquisition-alcohol','Алкоголь на объекте при получении','Нужно устранить по вашему рабочему правилу',4);
    if(!state.data.entrances.length)task('no-entrances','Не добавлены входы','Зафиксируйте фактические входы и выходы',2);if(/^\d+$/.test(state.data.inspection.entrances_actual)&&Number(state.data.inspection.entrances_actual)!==state.data.entrances.length)task('entrance-count','Количество входов не совпадает с карточками','Добавьте каждый фактический вход отдельно',2);
    state.data.entrances.forEach(function(e,i){if(e.access!=='Осмотрен')task('entrance-access-'+e.id,(e.label||'Вход '+(i+1))+' — осмотр',e.notes||e.access||'Осмотр не подтверждён',2);if(!evidenceFor('entrance',e.id).length)task('entrance-photo-'+e.id,(e.label||'Вход '+(i+1))+' — нет фото','Добавьте фото или укажите причину в примечании',2);if(e.facing==='Не проверено'||!e.facing)task('entrance-facing-'+e.id,(e.label||'Вход '+(i+1))+' — сторона выхода','Улица / двор / другое',2);});
    state.data.zones.forEach(function(z,i){var title=z.name||'Организация '+(i+1);if(z.status==='pending'||!z.status)task('zone-'+z.id,title+' — нужно уточнить',z.resolution||z.info||'Фотографии и сведения сохранены в карточке организации',3);else if(!z.resolution||!z.source)task('zone-source-'+z.id,title+' — не указано основание','Укажите источник и пояснение результата',3);if(z.status==='confirmed')task('zone-confirmed-'+z.id,title+' — ограничение подтверждено','Нужна оценка юриста и план действий',3);if(!evidenceFor('zone',z.id).length)task('zone-photo-'+z.id,title+' — нет доказательства','Добавьте фото, схему или документ',3);});
    var video=state.data.inspection.video_status;if(video!=='Сделано'||!state.data.workflow.video_url)task('video','Видео осмотра',video==='Снято — загрузить позже'?'Снято, но ещё не загружено':!state.data.workflow.video_url?'Нет ссылки на сохранённое видео':video||'Статус не указан',4);
    if(!evidenceFor('plan','source').length)task('plan','Не приложен исходный план','Если документа нет, запросите его и отметьте это в выводе',5);
    ['egrn','lease','plan'].forEach(function(k){if(state.data.workflow.documents[k]!=='Есть')task('document-'+k,({egrn:'ЕГРН',lease:'Основание пользования',plan:'План помещения'})[k]+' — документ',state.data.workflow.documents[k]||'Наличие не проверено',0);});
    ['within_cadastral','licensed_boundaries_match','archive_match','all_entrances_checked','zones_checked'].forEach(function(k){if(get('inspection.'+k)==='Нет'&&(isRenewal()||!['licensed_boundaries_match','archive_match'].includes(k)))task('negative-'+k,({within_cadastral:'Объект выходит за кадастровые границы',licensed_boundaries_match:'Лицензированные границы не совпадают',archive_match:'Есть расхождения с архивом',all_entrances_checked:'Не все входы осмотрены',zones_checked:'Окружение проверено не полностью'})[k],'Нужны пояснение и дальнейшие действия',k==='all_entrances_checked'?2:k==='zones_checked'?3:5);});
    return out;
  }
  function tasksHtml(tasks){if(!tasks.length)return '<div class="note-box">Открытых вопросов по заполненным данным не найдено. Итоговую оценку всё равно подтверждает аудитор.</div>';return '<div class="task-list">'+tasks.map(function(t){return '<div class="task"><span class="task-marker">?</span><div class="task-main"><p>'+esc(t.title)+'</p><small>'+esc(t.detail)+'</small></div><button type="button" data-go-step="'+t.step+'">Перейти</button></div>';}).join('')+'</div>';}
  function followupStep(){var list=issues();return heading(6)+'<div class="summary-grid"><div class="summary-item"><strong>'+list.length+'</strong><span>Открытых вопросов</span></div><div class="summary-item"><strong>'+state.data.zones.filter(function(z){return z.status==='pending';}).length+'</strong><span>Организаций уточнить</span></div><div class="summary-item"><strong>'+state.evidence.length+'</strong><span>Файлов сохранено</span></div></div>'+tasksHtml(list)+'<div class="fields">'+input('Результаты доработки','workflow.followup_notes',{type:'textarea',wide:true,placeholder:'Что удалось уточнить после выезда. Результат по каждой организации внесите в её карточку.',maxlength:5000})+input('Варианты устранения рисков','workflow.mitigation',{type:'textarea',wide:true,placeholder:'Предлагаемое действие → что должен проверить юрист → повторная проверка. Возможность решения не считается подтверждённой автоматически.',maxlength:5000})+'</div><div class="note-box warning">Изменение входа или границ — предложение для проверки специалистом. Оно само по себе не подтверждает, что объект удалось вывести из зоны ограничения.</div>';}
  function reviewStep(){var p=state.data.inspection,list=issues();var rows=[['Объект',p.org||'Не указан'],['Адрес',p.address||'Не указан'],['Услуга',p.service||'Не указана'],['Регион',p.region||'Не указан'],['Дата осмотра',p.visit_date||'Не указана'],['Входы',state.data.entrances.length+' карточек'],['Организации рядом',state.data.zones.length+' карточек'],['Оригиналы файлов',state.evidence.length+' сохранено']];return heading(7)+'<dl class="review-list">'+rows.map(function(r){return '<div class="review-row"><dt>'+esc(r[0])+'</dt><dd>'+esc(r[1])+'</dd></div>';}).join('')+'</dl><div class="fields">'+select('Результат аудитора','workflow.conclusion_status',[{value:'ready',label:'Соответствует по проверенным пунктам'},{value:'actions',label:'Нужны действия'},{value:'insufficient',label:'Недостаточно данных'},{value:'obstacle',label:'Выявлено препятствие'}],'Положительный вывод доступен только после проработки открытых вопросов.',true)+input('Заключение аудитора','conclusion',{type:'textarea',wide:true,rows:5,placeholder:'Что проверено, какие риски подтверждены, что сделать дальше и какие вопросы остались.',maxlength:6000})+'</div>'+(list.length?'<div class="note-box warning"><strong>'+list.length+' открытых вопросов.</strong> Они попадут в отчёт. Можно передать результат «Недостаточно данных» или «Нужны действия», чтобы юрист видел ситуацию.</div><button type="button" class="button secondary full" data-mark-unknown>Пустые проверки отметить «Не проверено»</button><details class="details-block"><summary>Посмотреть открытые вопросы</summary>'+tasksHtml(list)+'</details>':'<div class="note-box">Проверьте заключение перед отправкой. Заполненный чек-лист сам по себе не является решением о выдаче лицензии.</div>')+'<div class="section-heading"><h3>Материалы проверки</h3></div><p class="field-note">Файлы привязаны к входам, организациям и плану. Оригиналы сохранены отдельно от превью. Внутренний отчёт аудитора и официальный акт выездной оценки — разные документы.</p><div class="action-row" style="margin-top:18px"><button type="button" class="button primary full" id="submit-audit">Сохранить и отправить отчёт</button></div><p class="field-note" id="submit-status" role="status" aria-live="polite">Перед отправкой проверю сохранение черновика и приложений.</p>';}

  function render(){
    if(editor){try{editor.destroy();}catch(e){}editor=null;}
    fieldId=0;var index=step();var views=[objectStep,appointmentStep,entranceStep,zonesStep,interiorStep,planStep,followupStep,reviewStep];root.innerHTML=views[index]();root.setAttribute('aria-busy','false');
    bind();refreshChrome();loadThumbnails();if(index===5)mountEditor();freezeControls();
  }
  function mountEditor(){var container=$('#plan-editor');if(!container)return;if(window.AuditPlanEditor&&typeof window.AuditPlanEditor.mount==='function'){try{editor=window.AuditPlanEditor.mount(container,{getState:function(){return state.data.plan;},onChange:function(plan){if(state.frozen)return;state.data.plan=plan;changed();},evidenceUrl:evidenceUrl,evidence:state.evidence});}catch(error){container.innerHTML='<div class="plan-placeholder">Не удалось открыть редактор. План сохранён оригиналом; можно добавить размеченную графику отдельным файлом.</div>';}}}
  function stepCompletion(){var p=state.data.inspection,w=state.data.workflow;var values=[
    [p.org,p.address,p.service,p.region,state.data.building_type,w.preliminary_status],
    [w.contact_name,w.contact_phone,w.call_status,w.appointment_at],
    [p.entrances_plan,p.entrances_actual,p.all_entrances_checked,state.data.entrances.length&&state.data.entrances.every(function(e){return e.label&&e.kind&&e.access&&evidenceFor('entrance',e.id).length;})],
    [p.zones_checked,state.data.zones.every(function(z){return z.name&&z.status&&evidenceFor('zone',z.id).length;})],
    [p.alcohol_present,p.video_status,p.repair_state,w.video_url],
    [p.plan_source,p.floor_plan,p.floor_actual,p.within_cadastral,state.data.boundaries,state.data.bti,state.data.to,evidenceFor('plan','source').length],
    [issues().length===0||w.followup_notes,w.mitigation||issues().length===0],
    [w.conclusion_status,state.data.conclusion]
  ];return values.map(function(arr){return arr.filter(Boolean).length/arr.length;});}
  function refreshChrome(){var index=step(),complete=stepCompletion(),percent=Math.round(complete.reduce(function(a,b){return a+b;},0)/8*100);$('#steps').innerHTML=STEPS.map(function(s,i){return '<button type="button" class="step-button'+(complete[i]===1?' is-complete':'')+'" data-step="'+i+'"'+(i===index?' aria-current="step"':'')+' aria-label="Этап '+(i+1)+': '+esc(s[0])+'"><span>'+(complete[i]===1?'✓':i+1)+'</span><span>'+esc(s[0])+'</span></button>';}).join('');$('#steps').querySelectorAll('[data-step]').forEach(function(b){b.onclick=function(){go(Number(b.dataset.step));};});$('#completion-value').textContent=percent+'%';$('#completion').setAttribute('aria-valuenow',String(percent));$('#completion-bar').style.width=percent+'%';$('#object-title').textContent=state.data.inspection.org||state.data.inspection.address||'Проверка объекта';$('#step-counter').textContent=(index+1)+' из 8';$('#previous-step').disabled=index===0||state.submitting;$('#next-step').textContent=index===7?'К открытым вопросам':'Далее →';$('#next-step').disabled=state.submitting;$('#save-now').disabled=state.submitting||state.frozen||state.conflict;var nav=$('#steps'),active=nav.querySelector('[aria-current=step]');if(active&&nav.scrollWidth>nav.clientWidth)nav.scrollLeft=active.offsetLeft-nav.clientWidth/2+active.offsetWidth/2;}
  function go(index){if(state.submitting)return;state.data.workflow.step=Math.max(0,Math.min(7,index));if(!state.frozen)changed();render();window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
  function sanitizeService(){if(!isRenewal()){state.data.inspection.archive_available='';state.data.inspection.archive_match='';state.data.inspection.archive_url='';state.data.inspection.licensed_boundaries_match='';state.data.inspection.alcohol_within_licensed='';}else if(state.data.inspection.alcohol_present==='Нет')state.data.inspection.alcohol_within_licensed='';}
  function bind(){
    root.querySelectorAll('[data-bind]').forEach(function(control){var handler=function(){if(state.submitting||state.frozen)return;var path=control.dataset.bind;set(path,control.type==='checkbox'?control.checked:control.value);if(path==='inspection.service'){sanitizeService();changed();render();return;}changed();if(path==='object_category'||path==='inspection.alcohol_present'){sanitizeService();render();}};control.addEventListener(control.tagName==='SELECT'||control.type==='checkbox'?'change':'input',handler);});
    root.querySelectorAll('[data-go-step]').forEach(function(b){b.onclick=function(){go(Number(b.dataset.goStep));};});
    root.querySelectorAll('[data-upload-role]').forEach(function(control){control.onchange=function(){var files=Array.from(control.files||[]);control.value='';uploadFiles(files,control.dataset.uploadRole,control.dataset.uploadSubject).catch(function(error){notify(error.message);});};});
    root.querySelectorAll('[data-open-evidence]').forEach(function(b){b.onclick=function(){openEvidence(b.dataset.openEvidence);};});
    root.querySelectorAll('[data-delete-evidence]').forEach(function(b){b.onclick=function(){deleteEvidence(b.dataset.deleteEvidence);};});
    var b=$('[data-add-entrance]');if(b)b.onclick=function(){var n=state.data.entrances.length+1;state.data.entrances.push({id:id('entrance'),label:'Вход '+n,kind:'',location:'',facing:'',access:'',notes:''});changed();render();};
    b=$('[data-add-zone]');if(b)b.onclick=function(){state.data.zones.push({id:id('zone'),name:'',type:'',status:'pending',entrance_id:'',dist:'',method:'',points:'',license:'',source:'',info:'',resolution:''});changed();render();};
    root.querySelectorAll('[data-remove-entrance]').forEach(function(button){button.onclick=function(){var eid=button.dataset.removeEntrance;if(evidenceFor('entrance',eid).length){notify('Сначала уберите файлы этого входа, чтобы не потерять связь с фото.');return;}if(state.data.zones.some(function(z){return z.entrance_id===eid;})){notify('Этот вход используется в замерах организаций. Сначала измените привязку в этапе «Зоны».');return;}state.data.entrances=state.data.entrances.filter(function(e){return e.id!==eid;});changed();render();};});
    root.querySelectorAll('[data-remove-zone]').forEach(function(button){button.onclick=function(){var zid=button.dataset.removeZone;if(evidenceFor('zone',zid).length){notify('Сначала уберите файлы организации, чтобы не потерять связь с доказательствами.');return;}state.data.zones=state.data.zones.filter(function(z){return z.id!==zid;});changed();render();};});
    b=$('[data-start-visit]');if(b)b.onclick=function(){if(!state.data.inspection.visit_date)state.data.inspection.visit_date=localDate();go(2);};
    b=$('[data-mark-unknown]');if(b)b.onclick=function(){CHECKS.forEach(function(c){if(!get(c[0])&&c[0]!=='inspection.service')set(c[0],'Не проверено');});if(isRenewal()){['archive_available','archive_match','licensed_boundaries_match'].forEach(function(k){if(!state.data.inspection[k])state.data.inspection[k]='Не проверено';});if(state.data.inspection.alcohol_present!=='Нет'&&!state.data.inspection.alcohol_within_licensed)state.data.inspection.alcohol_within_licensed='Не проверено';}changed();render();notify('Пустые проверки отмечены «Не проверено». Открытые вопросы сохранены.');};
    b=$('#submit-audit');if(b)b.onclick=submit;
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
    root.querySelectorAll('button').forEach(function(button){if(button.id!=='submit-audit'&&!button.hasAttribute('data-open-evidence')&&!button.hasAttribute('data-go-step'))button.disabled=true;});
    root.querySelectorAll('.plan-editor-shell canvas').forEach(function(canvas){canvas.style.pointerEvents='none';});
    var submitButton=$('#submit-audit');if(submitButton)submitButton.textContent='Повторить отправку этой версии';
    var submitStatus=$('#submit-status');if(submitStatus)submitStatus.textContent='Отправка началась — версия зафиксирована. Можно просмотреть этапы и повторить отправку без изменений.';
    notice('Отправка началась — версия зафиксирована. Можно просмотреть данные и повторить отправку без изменений.');
    $('#save-now').disabled=true;
  }
  function frozenSnapshot(remote){
    clearTimeout(timer);var currentStep=step();
    if(remote){state.draft=remote;state.data=merge(clone(defaults),remote.data||{});state.data.workflow.step=currentStep;state.evidence=remote.evidence||[];}
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
      if(!p.org.trim()||!p.address.trim()||!p.service){notify('Укажите объект, адрес и услугу в первом этапе.');go(0);return;}
      if(!state.data.conclusion.trim()||!state.data.workflow.conclusion_status){notify('Укажите результат и заключение аудитора.');return;}
      if(state.data.workflow.conclusion_status==='ready'&&issues().length){notify('Есть открытые вопросы. Проработайте их или выберите результат без положительного подтверждения.');return;}
      var required=CHECKS.filter(function(c){return !get(c[0]);});
      if(isRenewal()){
        ['archive_available','licensed_boundaries_match'].forEach(function(k){if(!p[k])required.push(['inspection.'+k,k]);});if(p.archive_available==='Да'&&!p.archive_match)required.push(['inspection.archive_match']);
        if(p.alcohol_present!=='Нет'&&!p.alcohol_within_licensed)required.push(['inspection.alcohol_within_licensed']);
      }
      if(required.length){notify('Есть пустые проверки. Ответьте на них или явно отметьте «Не проверено».');return;}
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
        root.innerHTML='<div class="success-screen"><div class="success-mark">✓</div><h2>Отчёт отправлен</h2><p>Внутренний отчёт передан. Оригиналы и размеченная копия сохранены с этой проверкой.</p><a class="button secondary" href="/requests">К заявкам</a></div>';
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
  async function reloadServer(){if(!window.confirm('Загрузить серверную версию вместо локальных правок? При необходимости сначала скачайте свою копию.'))return;try{var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId));if(!result.draft)throw new Error('Серверная версия не найдена. Локальные правки сохранены.');state.data=merge(clone(defaults),result.draft.data||{});state.data.schema_version=3;state.draft=result.draft;state.evidence=result.draft.evidence||result.evidence||[];state.conflict=false;state.dirty=false;state.frozen=!!result.draft.submitting;$('#conflict-panel').hidden=true;localSave();render();status(state.frozen?'Версия зафиксирована · повторите отправку без изменений':'Загружена серверная версия',state.frozen?'warning':'success');}catch(error){notify(error.message);}}
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
  async function initialize(){
    var local=null;try{local=JSON.parse(localStorage.getItem(localKey)||'null');}catch(e){}
    if(local&&local.data){state.data=merge(clone(defaults),local.data);state.dirty=!!local.dirty;state.draft=local.draft_id?{id:local.draft_id,revision:local.revision}:null;state.localSaved=true;}
    try{
      var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId));
      if(!result.draft&&local&&!local.dirty){
        state.data=clone(defaults);state.draft=null;state.evidence=[];state.dirty=false;local=null;state.localSaved=false;
        try{localStorage.removeItem(localKey);}catch(e){}
      }
      if(result.draft){
        var remote=result.draft;
        if(remote.submitting){
          if(local&&local.dirty){state.recoveryData=clone(local.data);state.conflict=true;$('#conflict-panel').hidden=false;}
          state.draft=remote;state.data=merge(clone(defaults),remote.data||{});state.evidence=remote.evidence||result.evidence||[];state.frozen=true;state.dirty=false;state.data.workflow.step=7;
        }else if(local&&local.dirty){
          if(String(local.draft_id||'')===String(remote.id)&&Number(local.revision)===Number(remote.revision)){state.draft=remote;state.evidence=remote.evidence||result.evidence||[];notice('Восстановлены локальные изменения. Сохраню их на сервер.');}
          else{state.draft=remote;state.evidence=remote.evidence||result.evidence||[];state.conflict=true;$('#conflict-panel').hidden=false;}
        }else{
          state.data=merge(clone(defaults),remote.data||{});state.draft=remote;state.evidence=remote.evidence||result.evidence||[];state.dirty=false;notice('');
        }
      }else if(!local&&orderId){
        try{
          var prefill=await request('/api/audit/prefill?order_id='+encodeURIComponent(orderId));
          if(['tobacco','other'].includes(prefill.object_category)){window.location.replace('/audit/legacy'+window.location.search);return;}state.data.inspection.org=prefill.org||'';state.data.inspection.address=prefill.address||'';
          if(['catering','retail'].includes(prefill.object_category))state.data.object_category=prefill.object_category;
          if(['Получение','Продление','Переоформление'].includes(prefill.service))state.data.inspection.service=prefill.service;
          prefillContact(prefill.contacts);
        }catch(e){notice('Не удалось подставить данные заявки. Их можно заполнить вручную.');}
      }
      state.data.schema_version=3;state.data.order_id=orderId||state.data.order_id||'';
      if(!state.frozen)sanitizeService();state.loaded=true;render();
      $('#draft-id').textContent=orderId?'Заявка #'+orderId:'Новый черновик';localSave();
      if(state.frozen)status('Версия зафиксирована · повторите отправку без изменений','warning');
      else if(state.conflict)status('Конфликт версий · ваши правки на устройстве','warning');
      else if(state.dirty)saveNow().catch(function(){});
      else status(state.draft?'Черновик загружен с сервера':'Начните заполнение — черновик сохранится автоматически',state.draft?'success':'');
    }catch(error){
      state.loaded=true;render();state.serverError=error.message;
      status((state.localSaved?'Восстановлено с устройства · ':'Нет связи с сервером · ')+error.message,'warning');
      notice('Работу можно продолжить на этом устройстве. Для файлов, продолжения с другого устройства и отправки нужен доступ к серверу.');
    }
  }
  $('#previous-step').onclick=function(){go(step()-1);};$('#next-step').onclick=function(){go(step()===7?6:step()+1);};$('#save-now').onclick=function(){saveNow().then(function(){notify('Черновик сохранён на сервере.');}).catch(function(error){notify(error.message);});};$('#download-copy').onclick=downloadCopy;$('#reload-server').onclick=reloadServer;
  window.addEventListener('online',function(){if(state.dirty&&!state.conflict)saveNow().catch(function(){});});
  window.addEventListener('beforeunload',function(event){localSave();if(state.dirty||state.pendingUploads){event.preventDefault();event.returnValue='';}});
  initialize();
})();
