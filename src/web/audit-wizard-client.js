(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  var actions = window.AuditActions;
  try { if (tg) { tg.ready(); tg.expand(); } } catch (e) {}
  var params = new URLSearchParams(window.location.search);
  var orderId = params.get('order_id') || '';
  var legacyLink = document.querySelector('.legacy-link'); if (legacyLink) legacyLink.href = '/audit/legacy' + window.location.search;
  var storedUid = ''; try { storedUid = sessionStorage.getItem('tg_u') || ''; } catch (e) {}
  var uid = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? String(tg.initDataUnsafe.user.id) : (params.get('u') || storedUid || 'staff');
  var localKey = 'audit-wizard-v3:' + uid + ':' + (orderId || 'new');
  var STEPS = [
    ['Территория', 'Схема и фотографии', 'Отметьте входы, проверенные организации и замеры на скриншоте Яндекс Карт.'],
    ['Помещение', 'План помещения', 'Выберите нужный лист PDF и отметьте фактическую планировку.'],
    ['Отчёт', 'Результат проверки', 'Краткий вывод и вопросы, которые осталось решить.']
  ];
  var TRI = ['', 'Да', 'Нет', 'Не проверено'];
  var defaults = {
    schema_version: 3, ui_version: 5, object_category: 'catering', order_id: orderId,
    inspection: {service:'',org:'',address:'',visit_date:'',region:'МСК',floor_plan:'',floor_actual:'',plan_source:'',plan_note:'',structural_elements:'',archive_available:'',archive_match:'',archive_url:'',alcohol_present:'',alcohol_within_licensed:'',within_cadastral:'',licensed_boundaries_match:'',entrances_plan:'',entrances_actual:'',all_entrances_checked:'',zones_checked:'',video_status:'',repair_state:'',risks:''},
    workflow: {step:0,contact_name:'',contact_phone:'',call_status:'',appointment_at:'',access_notes:'',preliminary_status:'',precheck_notes:'',documents:{egrn:'',lease:'',plan:'',license:''},video_url:'',followup_notes:'',mitigation:'',conclusion_status:''},
    entrances: [], zones: [], plan: {evidence_id:'',page:1,annotations:[],wall_basis:''}, map:{evidence_id:'',page:1,annotations:[]}, additional_plans:[],
    building_type:'',boundaries:'',bti:'',to:'',nearby:'',veranda:false,patz:false,passport:false,owner_info:'',conclusion:''
  };
  var state = {data:clone(defaults),draft:null,evidence:[],dirty:false,version:0,conflict:false,submitting:false,frozen:false,completed:false,loaded:false,localSaved:false,pendingUploads:0,uploadText:'',serverError:'',recoveryData:null,packet:null,viewStep:null,packetError:''};
  var tail = Promise.resolve();
  var timer = null;
  var toastTimer = null;
  var editor = null;
  var activePlanId='main';
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
  function packetPhone() { return actions.findPhone((state.packet||state.data.request_packet||{}).contacts); }
  function managerFilesHtml(files, planActions) {
    if (!files.length) return '<p class="field-note">Менеджер пока не приложил файлы.</p>';
    return '<div class="manager-files">' + files.map(function (file) {
      var role = { plan: 'План', egrn: 'ЕГРН', archive: 'Архив', document: 'Документ' }[file.role] || 'Документ';
      var canMark = planActions && (/^image\//.test(file.mime || '')||file.mime==='application/pdf'||/\.pdf$/i.test(file.name||''));
      return '<article class="manager-file"><div><span class="tag">' + role + '</span><strong>' + esc(file.name) + '</strong><small>' + bytes(file.bytes) + '</small></div><div class="action-row"><button type="button" class="button secondary" data-download-material="' + esc(file.id) + '" aria-label="Скачать ' + esc(file.name) + '">Скачать</button>' + (canMark ? '<button type="button" class="button primary" data-use-plan="' + esc(file.id) + '">Разметить</button>' : '') + '</div></article>';
    }).join('') + '</div>';
  }
  function packetSummary(){
    var packet=state.packet||state.data.request_packet||{},p=state.data.inspection,files=packetFiles(),contact=packetContactText(packet.contacts),phone=packetPhone(),archiveFiles=files.filter(function(f){return f.role==='archive';}),hasArchive=!!packet.archive_url||archiveFiles.length>0;
    var html='<section class="request-packet"><div class="packet-title"><span class="tag">Заявка #'+esc(orderId)+'</span><span>'+esc(({catering:'Алкоголь · общепит',retail:'Алкоголь · магазин',tobacco:'Табак'})[state.data.object_category]||'Объект')+' · '+esc(p.service)+'</span></div><h2>'+esc(packet.object_name||packet.org||p.org)+'</h2><p class="packet-address">'+esc(packet.address||p.address)+'</p><div class="action-row"><a class="button secondary" data-route target="_blank" rel="noopener" href="'+esc(actions.routeUrl(p.address||''))+'">Построить маршрут ↗</a>'+(phone?'<button type="button" class="button secondary" data-contact>Позвонить</button>':'')+'</div>'+(contact?'<p class="packet-contact">'+esc(contact)+'</p>':'');
    if(packet.zones_info)html+='<details class="packet-details"><summary>Комментарий менеджера</summary><p>'+esc(packet.zones_info)+'</p></details>';
    html+='<details class="packet-details"><summary>Документы заявки · '+files.length+'</summary>'+(files.length?'<button type="button" class="button secondary full" data-download-materials>Скачать всё</button>':'')+managerFilesHtml(files,false)+'<p class="field-note">Документы и папку объекта прикрепляет менеджер до передачи заявки аудитору.</p></details>';
    if(isRenewal())html+='<div class="archive-box"><div class="card-top"><h3>Архив объекта</h3><span class="tag">'+(archiveFiles.length?'Приложен':state.data.workflow.archive_skipped==='Да'?'Без архива':'Графика не приложена')+'</span></div>'+(hasArchive?'<div class="action-row"><button type="button" class="button secondary" data-download-archive>Скачать архив</button>'+(packet.archive_url?'<button type="button" class="button secondary" data-copy-archive>Скопировать ссылку</button>':'')+'</div>':'')+(!archiveFiles.length?'<button type="button" class="button secondary full" data-skip-archive>'+ (state.data.workflow.archive_skipped==='Да'?'Добавить архив / отменить пропуск':'Архива нет — продолжить')+'</button>':'')+'</div>';
    html+='</section><section class="capture-section"><div class="section-heading"><h3>Здание</h3><a class="inline-link" target="_blank" rel="noopener" href="https://dom.mos.ru/">Проверить на dom.mos.ru ↗</a></div>'+choices('building_type','Здание',[['Жилое','Жилое'],['Нежилое','Нежилое']])+'</section>';
    if(!p.service||!p.address||!p.org)html+='<div class="note-box warning">В заявке не хватает данных объекта или услуги. Это дополняет менеджер.</div>';
    return html;
  }
  function choices(path,label,options){return '<div class="choice-field"><span class="field-label">'+esc(label)+'</span><div class="choice-options" role="group" aria-label="'+esc(label)+'">'+options.map(function(o){return '<button type="button" class="button secondary'+(String(get(path))===o[0]?' selected':'')+'" aria-pressed="'+(String(get(path))===o[0])+'" data-choice="'+esc(path)+'" data-value="'+esc(o[0])+'">'+esc(o[1])+'</button>';}).join('')+'</div></div>';}

  function entranceCards(){return '<section class="capture-section"><h3>Входы</h3>'+(state.data.entrances.length?state.data.entrances.map(function(e){return '<article class="repeat-card"><h3>'+esc(e.label||'Вход')+'</h3>'+evidenceBlock('entrance',e.id,'Фото входа','')+'</article>';}).join(''):'<p class="field-note">Отметьте вход на схеме — появится место для его фотографий.</p>')+'</section>';}

  function zoneCards(){return '<section class="capture-section"><h3>Проверенные организации</h3>'+(state.data.zones.length?state.data.zones.map(function(z){return '<article class="repeat-card"><div class="card-top"><h3>'+esc(z.name||'Организация')+'</h3><span class="tag">'+esc(({clear:'Без замечаний',licensed:'Есть сведения о лицензии',disputed:'Спорное место',confirmed:'Есть ограничение',pending:'Нужно уточнить'})[z.status]||'Не проверено')+'</span></div>'+(z.dist?'<p>'+esc(z.dist)+' м</p>':'')+(z.info?'<p>'+esc(z.info)+'</p>':'')+evidenceBlock('zone',z.id,'Фото организации','')+'</article>';}).join(''):'<p class="field-note">Название, результат и замеры указываются у отметки организации на схеме.</p>')+'</section>';}

  function outsideStep(){return packetSummary()+heading(0)+'<div class="plan-editor-shell" id="map-editor"></div><div id="territory-evidence">'+entranceCards()+zoneCards()+'</div>'+input('Дополнение по территории · необязательно','workflow.territory_notes',{type:'textarea',maxlength:2000});}
  function currentPlan(planId){planId=planId||activePlanId;if(planId==='main')return state.data.plan;return state.data.additional_plans.find(function(p){return p.id===planId;});}
  function setCurrentPlan(plan,planId){planId=planId||activePlanId;if(planId==='main')state.data.plan=plan;else{var i=state.data.additional_plans.findIndex(function(p){return p.id===planId;});if(i>=0)state.data.additional_plans[i]=Object.assign({},plan,{id:planId});}}

  function insideStep(){
    var p=state.data.inspection,files=packetFiles().filter(function(f){return ['plan','egrn','archive'].includes(f.role);}),renewalArchive=isRenewal()&&state.data.workflow.archive_skipped!=='Да'&&files.some(function(f){return f.role==='archive';});
    var html=heading(1)+'<details class="details-block"><summary>Выбрать документ из заявки</summary>'+managerFilesHtml(files,true)+'</details><div class="plan-contexts"><button type="button" class="button secondary'+(activePlanId==='main'?' selected':'')+'" data-plan-context="main">Основной план</button>'+state.data.additional_plans.map(function(plan,i){return '<button type="button" class="button secondary'+(activePlanId===plan.id?' selected':'')+'" data-plan-context="'+esc(plan.id)+'">Доп. лист '+(i+1)+'</button>';}).join('')+'<button type="button" class="button secondary" data-add-plan>+ Ещё лист</button></div>'+(activePlanId!=='main'?'<button type="button" class="text-button" data-remove-plan>Убрать дополнительный лист</button>':'')+'<div class="plan-editor-shell" id="plan-editor"></div>';
    html+='<section class="capture-section"><h3>Помещение по факту</h3><div class="fields">'+input('Этаж на плане','inspection.floor_plan',{maxlength:100})+input('Фактический этаж','inspection.floor_actual',{maxlength:100})+input('Количество кадастров','inspection.cadastral_count',{type:'number',step:'1',maxlength:2})+'</div>'+choices('inspection.within_cadastral','Внешние границы помещения',[['Да','Соблюдены'],['Нет','Нарушены']])+(Number(p.cadastral_count)>1?choices('inspection.inter_cadastral_boundary','Граница между кадастрами',[['Сохранена','Сохранена'],['Объединены','Объединены']]):'')+choices('inspection.rooms_complete','Все комнаты по плану на месте',[['Да','Да'],['Нет','Часть отсутствует']])+choices('to','Нужно техническое описание (ТО)',[['Нужно','Да'],['Не нужно','Нет']])+choices('bti','Планировка по выбранному плану',[['Да','Совпадает'],['Нет','Есть изменения']])+(state.data.bti==='Нет'?input('Что отличается','inspection.plan_note',{type:'textarea',wide:true,maxlength:2000,placeholder:'Кратко. Перегородки и границы отметьте на плане.'}):'')+'</section>';
    if(renewalArchive)html+='<details class="details-block"><summary>Сверка с архивом</summary>'+managerFilesHtml(files.filter(function(f){return f.role==='archive';}),false)+choices('inspection.archive_match','Планировка совпадает с архивом',[['Да','Да'],['Нет','Нет']])+choices('inspection.licensed_boundaries_match','Лицензированные границы сохранены',[['Да','Да'],['Нет','Нет']])+'</details>';
    html+=evidenceBlock('interior','rooms','Фото помещения · необязательно','Общий вид зала, бара или помещений. Можно добавить несколько фото.');
    if(state.data.object_category==='tobacco')html+='<section class="capture-section"><h3>Табак</h3><div class="fields">'+select('Выкладка / хранение','inspection.tobacco_display',['Закрытая','Открытая','Товара нет','Не проверено'])+select('Перечень с ценами','inspection.tobacco_price_list',['Есть','Нет','Не проверено'])+select('Реклама продукции','inspection.tobacco_advertising',['Есть','Нет','Не проверено'])+'</div></section>';
    else html+='<section class="capture-section"><h3>Алкоголь на объекте</h3>'+choices('inspection.alcohol_present','Фактическое наличие',[['Нет','Алкоголя нет'],['Да','Алкоголь есть'],['Не проверено','Не проверено']])+(isRenewal()&&p.alcohol_present==='Да'?choices('inspection.alcohol_within_licensed','Алкоголь в лицензированной зоне',[['Да','В пределах'],['Нет','Есть за пределами'],['Не проверено','Не проверено']]):'')+'</section>';
    html+='<section class="capture-section"><h3>Кассы</h3>'+choices('inspection.kkt_count','Количество касс',[['1','1'],['2','2']])+choices('inspection.kkt_ip','Есть касса ИП',[['Да','Да'],['Нет','Нет']])+'</section>';
    return html;
  }
  function syncMapCards(){
    var marks=state.data.map.annotations||[],oldEntrances=state.data.entrances||[],oldZones=state.data.zones||[],before=JSON.stringify([oldEntrances,oldZones]);
    var entrances=marks.filter(function(m){return m.tool==='entrance';}).map(function(m,i){var prior=oldEntrances.find(function(e){return e.id===m.id;})||{};return Object.assign({},prior,{id:String(m.id),label:String(m.label||'Вход '+(i+1)),kind:prior.kind||'',location:prior.location||'',facing:prior.facing||'',access:prior.access||'Осмотрен',notes:prior.notes||''});});
    var zones=marks.filter(function(m){return m.tool==='hazard';}).map(function(m){var prior=oldZones.find(function(z){return z.id===m.id;})||{},measurement=marks.find(function(x){return ['route','straight'].includes(x.tool)&&x.toObjectId===m.id;});return Object.assign({},prior,{id:String(m.id),name:String(m.label||''),type:prior.type||'',status:String(m.status||'pending'),entrance_id:String(measurement&&measurement.fromEntranceId||''),dist:String(measurement&&measurement.distance||''),method:measurement?(measurement.tool==='straight'?'Прямая линия':'Пешеходный маршрут'):'',points:measurement?String(measurement.code||''):'',license:m.status==='licensed'?String(m.source||'Сведения аудитора'):'',source:String(m.source||''),info:String(m.note||''),resolution:String(m.note||'')});});
    // Legacy cards remain recoverable until their own marks are created.
    if(!marks.length&&(oldEntrances.length||oldZones.length)){state.data.legacy_territory=state.data.legacy_territory||{entrances:clone(oldEntrances),zones:clone(oldZones)};return;}
    state.data.entrances=entrances;state.data.zones=zones;
    if(before!==JSON.stringify([entrances,zones])){var host=$('#territory-evidence');if(host){host.innerHTML=entranceCards()+zoneCards();bind(host);loadThumbnails(host);}}
  }

  function issues(){
    var out=[],p=state.data.inspection,packet=state.packet||{};function add(key,title,view){out.push({key:key,title:title,detail:'',step:view});}
    if(!p.org||!p.address||!p.service)add('packet','Менеджеру нужно дополнить заявку',0);
    if(!state.data.building_type)add('building','Выберите: жилое или нежилое здание',0);
    if(!state.data.map.evidence_id||!state.data.map.annotations.length)add('map','Сохраните схему территории',0);
    if(!state.data.entrances.length)add('entrances','Отметьте входы на схеме',0);
    state.data.entrances.forEach(function(e){if(!evidenceFor('entrance',e.id).length)add('photo-'+e.id,(e.label||'Вход')+': добавьте фото',0);});
    state.data.zones.forEach(function(z){if(!z.name.trim())add('name-'+z.id,'Укажите название проверенной организации',0);if(!evidenceFor('zone',z.id).length)add('photo-'+z.id,(z.name||'Организация')+': добавьте фото',0);if(!z.status||['pending','disputed','confirmed'].includes(z.status))add('zone-'+z.id,(z.name||'Организация')+': '+(z.status==='confirmed'?'есть ограничение':'нужно уточнить'),0);if(z.status==='licensed'&&!z.source)add('source-'+z.id,(z.name||'Организация')+': укажите источник лицензии',0);});
    (state.data.map.annotations||[]).filter(function(m){return ['route','straight'].includes(m.tool);}).forEach(function(m){if(!Number(m.distance)||!m.fromEntranceId||!m.toObjectId)add('measure-'+m.id,'Замер '+(m.code||'')+': укажите расстояние и точки',0);});
    [['floor_plan','Этаж на плане'],['floor_actual','Фактический этаж'],['cadastral_count','Количество кадастров'],['rooms_complete','Наличие всех комнат'],['within_cadastral','Границы помещения'],['kkt_count','Количество касс'],['kkt_ip','Наличие кассы ИП']].forEach(function(pair){if(!p[pair[0]])add(pair[0],'Укажите: '+pair[1].toLowerCase(),1);});
    if(p.floor_plan&&p.floor_actual&&String(p.floor_plan).toLowerCase().replace(/этаж|\s/g,'')!==String(p.floor_actual).toLowerCase().replace(/этаж|\s/g,''))add('floor-mismatch','Этаж на плане и фактический этаж отличаются',1);
    if(p.archive_match==='Нет'||p.licensed_boundaries_match==='Нет')add('archive-mismatch','Есть расхождения с архивом или лицензированными границами',1);
    if(Number(p.cadastral_count)>1&&!p.inter_cadastral_boundary)add('inter','Укажите сохранность границы между кадастрами',1);
    if(p.inter_cadastral_boundary==='Объединены'||p.rooms_complete==='Нет'||p.within_cadastral==='Нет')add('bounds','Есть замечания по границам или комнатам',1);
    if(!state.data.plan.evidence_id||!state.data.plan.annotations.length)add('plan','Выберите лист и сохраните разметку плана',1);
    if(!state.data.to)add('to','Укажите, нужно ли техническое описание (ТО)',1);
    if(!state.data.bti)add('compare','Укажите результат сверки планировки',1);
    if(state.data.bti==='Нет'&&!p.plan_note.trim())add('note','Кратко опишите изменения планировки',1);
    if(state.data.bti==='Нет'||state.data.to==='Нужно')add('changes','Есть изменения планировки или требуется ТО',1);
    if(state.data.object_category==='tobacco'){[['tobacco_display','Выкладка'],['tobacco_price_list','Перечень с ценами'],['tobacco_advertising','Реклама']].forEach(function(pair){if(!p[pair[0]]||p[pair[0]]==='Не проверено')add(pair[0],'Табак: '+pair[1].toLowerCase()+' не проверены',1);});if(p.tobacco_display==='Открытая'||p.tobacco_price_list==='Нет'||p.tobacco_advertising==='Есть')add('tobacco','Есть замечания по торговле табаком',1);}
    else {if(!p.alcohol_present||p.alcohol_present==='Не проверено')add('alcohol','Зафиксируйте наличие алкоголя',1);if(p.service==='Получение'&&p.alcohol_present==='Да')add('alcohol-new','Для получения нужно убрать алкоголь',1);if(isRenewal()&&p.alcohol_present==='Да'&&p.alcohol_within_licensed!=='Да')add('alcohol-zone','Размещение алкоголя требует проверки',1);}
    if(isRenewal()&&state.data.workflow.archive_skipped==='Да')add('archive-skip','Архивная сверка не выполнена',0);else if(isRenewal()&&!packetFiles().some(function(f){return f.role==='archive';}))add('archive','Добавьте графику архива или пропустите архив',0);
    if((packet.video_required||packet.has_video)&&(!state.data.workflow.video_url||p.video_status!=='Сделано'))add('video','Добавьте ссылку на видео из задания',2);
    return out;
  }

  function tasksHtml(tasks) { return '<div class="task-list">' + tasks.map(function (t) { return '<div class="task"><div class="task-main"><p>' + esc(t.title) + '</p>' + (t.detail ? '<small>' + esc(t.detail) + '</small>' : '') + '</div><button type="button" data-go-step="' + t.step + '">Открыть</button></div>'; }).join('') + '</div>'; }
  function reportStep(){var tasks=issues(),p=state.data.inspection;return heading(2)+'<div class="fields">'+select('Результат','workflow.conclusion_status',[{value:'ready',label:'Соответствует по проверенным пунктам'},{value:'actions',label:'Нужны действия'},{value:'insufficient',label:'Нужно уточнить'},{value:'obstacle',label:'Есть препятствие'}],'',true)+input('Комментарий аудитора · необязательно','conclusion',{type:'textarea',wide:true,maxlength:6000})+input('Клиент сообщил / договорённости','workflow.followup_notes',{type:'textarea',wide:true,maxlength:2000})+input((state.packet&&(state.packet.video_required||state.packet.has_video))?'Видео в Яндекс Диске':'Видео · необязательно','workflow.video_url',{type:'url',maxlength:2000,placeholder:'https://disk.yandex.ru/d/…'})+(state.data.workflow.video_url?select('Доступность видео','inspection.video_status',['Сделано','Снято — загрузить позже','Не сделано','Не проверено']):'')+input('Дата осмотра','inspection.visit_date',{type:'date'})+'</div>'+(tasks.length?'<details class="details-block"><summary>Требуют внимания · '+tasks.length+'</summary>'+tasksHtml(tasks)+'</details>':'')+reportPreview()+'<button type="button" class="button primary full" id="submit-audit">Отправить отчёт</button><p class="field-note" id="submit-status" role="status" aria-live="polite"></p>';}
  function reportPreview(){var p=state.data.inspection,rows=[['Здание',state.data.building_type],['Этаж','план: '+(p.floor_plan||'—')+' · факт: '+(p.floor_actual||'—')],['Кадастры',(p.cadastral_count||'—')+(Number(p.cadastral_count)>1?' · '+(p.inter_cadastral_boundary||'—'):'')],['Границы',p.within_cadastral],['Все комнаты',p.rooms_complete],['ТО',state.data.to],['Кассы',(p.kkt_count||'—')+' · касса ИП: '+(p.kkt_ip||'—')]];if(state.data.object_category!=='tobacco')rows.push(['Алкоголь',p.alcohol_present]);else rows.push(['Табак',[p.tobacco_display,p.tobacco_price_list,p.tobacco_advertising].filter(Boolean).join(' · ')]);return '<section class="report-preview"><h3>Сообщение юристу</h3><p><strong>'+esc(p.address)+'</strong><br>'+esc(p.service)+' · '+esc(({catering:'Алкоголь · общепит',retail:'Алкоголь · магазин',tobacco:'Табак'})[state.data.object_category]||'')+'</p><dl class="report-facts">'+rows.map(function(r){return '<div><dt>'+esc(r[0])+'</dt><dd>'+esc(r[1]||'—')+'</dd></div>';}).join('')+'</dl>'+(state.data.workflow.conclusion_status?'<p><strong>Результат:</strong> '+esc(({ready:'Соответствует по проверенным пунктам',actions:'Нужны действия',insufficient:'Нужно уточнить',obstacle:'Есть препятствие'})[state.data.workflow.conclusion_status])+'</p>':'')+(state.data.conclusion?'<p>'+esc(state.data.conclusion)+'</p>':'')+(p.plan_note?'<p><strong>Изменения:</strong> '+esc(p.plan_note)+'</p>':'')+(state.data.workflow.archive_skipped==='Да'?'<p class="warning">Архив не предоставлен. Сверка с архивом не выполнена.</p>':'')+'<p class="field-note">Вместе с сообщением: схема, размеченные планы, фотографии, оригиналы выезда и ссылка на документы заявки.</p></section>';}

  function normalizeLayout(){if(!state.frozen){state.data.ui_version=5;state.data.inspection.region='МСК';state.data.map=state.data.map||{evidence_id:'',page:1,annotations:[]};state.data.additional_plans=state.data.additional_plans||[];}}

  function render() {
    if (editor) { try { editor.destroy(); } catch (e) {} editor = null; }
    fieldId = 0;
    if (!orderId) { root.innerHTML = '<div class="empty-state"><h2>Откройте проверку из заявки менеджера</h2><p>В чате «Замеры 2.0» нажмите кнопку проверки у нужной заявки. Адрес и документы подставятся автоматически.</p></div>'; root.setAttribute('aria-busy', 'false'); $('#steps').hidden = true; $('#previous-step').disabled = true; $('#next-step').disabled = true; $('#save-now').hidden = true; return; }
    var index = step(); root.innerHTML = [outsideStep, insideStep, reportStep][index](); root.setAttribute('aria-busy', 'false');
    bind(); refreshChrome(); loadThumbnails(); if(index===0||index===1)mountEditor(); freezeControls();
  }
  function mountEditor(){
    var kind=step()===0?'map':'plan',mountedPlanId=activePlanId,container=$(kind==='map'?'#map-editor':'#plan-editor');if(!container)return;
    function mountedPlan(){return kind==='map'?state.data.map:mountedPlanId==='main'?state.data.plan:state.data.additional_plans.find(function(p){return p.id===mountedPlanId;});}
    if(window.AuditPlanEditor&&typeof window.AuditPlanEditor.mount==='function'){try{editor=window.AuditPlanEditor.mount(container,{kind:kind,service:state.data.object_category==='tobacco'?'tobacco':'alcohol',getState:mountedPlan,onChange:function(plan){
      if(state.frozen||!mountedPlan())return false;var before=JSON.stringify(mountedPlan());if(before===JSON.stringify(plan))return (state.dirty||state.serverError)?saveNow():undefined;
      if(kind==='map'){state.data.map=plan;syncMapCards();}else if(mountedPlanId==='main')state.data.plan=plan;else{var i=state.data.additional_plans.findIndex(function(p){return p.id===mountedPlanId;});if(i<0)return false;state.data.additional_plans[i]=Object.assign({},plan,{id:mountedPlanId});}
      if(!state.data.inspection.visit_date)state.data.inspection.visit_date=localDate();changed();return saveNow();
    },evidenceUrl:evidenceUrl,evidence:state.evidence,onUpload:function(file,meta){return uploadEditorSource(file,meta.role);}});}catch(error){container.textContent='Не удалось открыть редактор. Оригинал можно скачать выше.';}}
  }

  function refreshChrome() {
    var index = step(); $('#steps').innerHTML = STEPS.map(function (s, i) { return '<button type="button" class="step-button" data-step="' + i + '"' + (i === index ? ' aria-current="step"' : '') + ' aria-label="' + esc(s[0]) + '"><span>' + (i + 1) + '</span><span>' + esc(s[0]) + '</span></button>'; }).join('');
    $('#steps').querySelectorAll('[data-step]').forEach(function (b) { b.onclick = function () { go(Number(b.dataset.step)); }; });
    $('#object-title').textContent = state.data.inspection.org || 'Данные из заявки менеджера'; $('#step-counter').textContent = (index + 1) + ' из 3'; $('#previous-step').disabled = index === 0 || state.submitting; $('#next-step').textContent = index === 2 ? 'К осмотру' : 'Далее →'; $('#next-step').disabled = state.submitting; $('#save-now').disabled = state.submitting || state.frozen || state.conflict;
  }
  async function go(index) { if (state.submitting) return;try{if(editor&&editor.flush)await editor.flush();}catch(error){notify(error.message);return;} var next = Math.max(0, Math.min(2, index)); if (state.frozen) state.viewStep = next; else { state.data.workflow.step = next; changed(); } render(); window.scrollTo({ top: 0, behavior: 'auto' }); }
  function sanitizeService() { if (!isRenewal()) { state.data.inspection.archive_available = ''; state.data.inspection.archive_match = ''; state.data.inspection.archive_url = ''; state.data.inspection.licensed_boundaries_match = ''; state.data.inspection.alcohol_within_licensed = ''; } else if (state.data.inspection.alcohol_present === 'Нет') state.data.inspection.alcohol_within_licensed = ''; }
  function bind(scope) {
    var bindRoot=scope||root;
    bindRoot.querySelectorAll('[data-bind]').forEach(function(control){
      var path=control.dataset.bind,rebuild=['inspection.alcohol_present','inspection.cadastral_count','bti','workflow.video_url'].includes(path);
      function capture(){if(state.submitting||state.frozen)return;set(path,control.type==='checkbox'?control.checked:control.value);changed();var preview=root.querySelector('.report-preview');if(step()===2&&preview)preview.outerHTML=reportPreview();}
      async function rebuildAfterChange(){if(!rebuild||state.submitting||state.frozen)return;try{if(editor&&editor.flush)await editor.flush();sanitizeService();render();}catch(error){notify(error.message);}}
      control.addEventListener(control.tagName==='SELECT'||control.type==='checkbox'?'change':'input',capture);
      if(rebuild)control.addEventListener('change',rebuildAfterChange);
    });
    bindRoot.querySelectorAll('[data-go-step]').forEach(function (b) { b.onclick = function () { go(Number(b.dataset.goStep)); }; });
    bindRoot.querySelectorAll('[data-upload-role]').forEach(function (control) { control.onchange = function () { var files = Array.from(control.files || []); control.value = ''; uploadFiles(files, control.dataset.uploadRole, control.dataset.uploadSubject).catch(function (error) { notify(error.message); }); }; });
    bindRoot.querySelectorAll('[data-open-evidence]').forEach(function (b) { b.onclick = function () { openEvidence(b.dataset.openEvidence); }; });
    bindRoot.querySelectorAll('[data-delete-evidence]').forEach(function (b) { b.onclick = function () { deleteEvidence(b.dataset.deleteEvidence); }; });
    bindRoot.querySelectorAll('[data-download-material]').forEach(function (b) { b.onclick = function () { var file = packetFiles().find(function (f) { return String(f.id) === b.dataset.downloadMaterial; }); if (file) downloadResource(file.url, file.name); }; });
    bindRoot.querySelectorAll('[data-use-plan]').forEach(function (b) { b.onclick = function () { useManagerPlan(b.dataset.usePlan); }; });
    bindRoot.querySelectorAll('[data-choice]').forEach(function(button){button.onclick=async function(){if(state.submitting||state.frozen)return;try{if(editor&&editor.flush)await editor.flush();set(button.dataset.choice,button.dataset.value);changed();render();}catch(error){notify(error.message);}};});
    bindRoot.querySelectorAll('[data-plan-context]').forEach(function(button){button.onclick=async function(){try{if(editor&&editor.flush)await editor.flush();activePlanId=button.dataset.planContext;render();}catch(error){notify(error.message);}};});
    var extraButton=bindRoot.querySelector('[data-add-plan]');if(extraButton)extraButton.onclick=async function(){try{if(editor&&editor.flush)await editor.flush();var extra={id:id('extra'),evidence_id:'',page:1,annotations:[]};state.data.additional_plans.push(extra);activePlanId=extra.id;changed();render();}catch(error){notify(error.message);}};
    var removePlan=bindRoot.querySelector('[data-remove-plan]');if(removePlan)removePlan.onclick=async function(){try{if(editor&&editor.flush)await editor.flush();}catch(error){notify(error.message);return;}state.data.retired_plans=state.data.retired_plans||[];state.data.retired_plans.push(clone(currentPlan()));state.data.additional_plans=state.data.additional_plans.filter(function(p){return p.id!==activePlanId;});activePlanId='main';changed();render();};
    var skip=bindRoot.querySelector('[data-skip-archive]');if(skip)skip.onclick=function(){state.data.workflow.archive_skipped=state.data.workflow.archive_skipped==='Да'?'':'Да';changed();render();};
    var route=bindRoot.querySelector('[data-route]');if(route)route.onclick=function(event){event.preventDefault();localSave();saveNow().catch(function(){});if(openExternal(actions.routeUrl(state.data.inspection.address)))notify('В Картах выберите, откуда ехать. Чтобы продолжить отчёт, вернитесь в Telegram.');else notify('Карты не открылись. Разрешите открытие ссылки или скопируйте адрес из заявки.');};
    bindRoot.querySelectorAll('[data-contact]').forEach(function(button){button.onclick=showContact;});
    var b = $('[data-download-materials]'); if (b) b.onclick = function () { downloadResource(state.packet.materials_download_url || '/api/audit/orders/' + encodeURIComponent(orderId) + '/materials/download-all', 'Документы-заявки-' + orderId + '.zip'); };
    b = $('[data-download-archive]'); if (b) b.onclick = function () { var attached=packetFiles().some(function(file){return file.role==='archive';});var url=state.packet.archive_download_url||(attached?'/api/audit/orders/'+encodeURIComponent(orderId)+'/materials/download-all?role=archive':'/api/audit/orders/'+encodeURIComponent(orderId)+'/archive/download');downloadResource(url,'Архив-заявки-'+orderId+'.zip'); };
    b = $('[data-copy-address]'); if (b) b.onclick = function () { copyText(state.data.inspection.address, 'Адрес скопирован'); };
    b = $('[data-copy-archive]'); if (b) b.onclick = function () { copyText(state.packet.archive_url, 'Ссылка на архив скопирована'); };
    b = $('[data-add-entrance]'); if (b) b.onclick = function () { var n = state.data.entrances.length + 1; state.data.entrances.push({ id: id('entrance'), label: 'Вход ' + n, kind: '', location: '', facing: '', access: '', notes: '' }); if (!state.data.inspection.visit_date) state.data.inspection.visit_date = localDate(); changed(); render(); };
    b = $('[data-add-zone]'); if (b) b.onclick = function () { state.data.zones.push({ id: id('zone'), name: 'Организация ' + (state.data.zones.length + 1), type: '', status: 'pending', entrance_id: state.data.entrances.length === 1 ? state.data.entrances[0].id : '', dist: '', method: '', points: '', license: '', source: '', info: '', resolution: '' }); changed(); render(); };
    bindRoot.querySelectorAll('[data-remove-entrance]').forEach(function (button) { button.onclick = function () { var eid = button.dataset.removeEntrance; if (evidenceFor('entrance', eid).length || state.data.zones.some(function (z) { return z.entrance_id === eid; })) { notify('У входа есть фото или замеры. Сначала уберите их привязку.'); return; } state.data.entrances = state.data.entrances.filter(function (e) { return e.id !== eid; }); changed(); render(); }; });
    bindRoot.querySelectorAll('[data-remove-zone]').forEach(function (button) { button.onclick = function () { var zid = button.dataset.removeZone; if (evidenceFor('zone', zid).length) { notify('Сначала уберите файлы этой организации.'); return; } state.data.zones = state.data.zones.filter(function (z) { return z.id !== zid; }); changed(); render(); }; });
    b = $('#submit-audit'); if (b) b.onclick = submit;
  }
  function openExternal(url){return actions.openExternal(url,tg,function(href,target){return window.open(href,target);});}
  function showContact(){
    var phone=packetPhone();if(!phone){notify('Телефон не указан в заявке.');return;}
    localSave();saveNow().catch(function(){});
    var dialog=document.getElementById('contact-dialog');if(dialog&&dialog.open)return;if(dialog)dialog.remove();
    dialog=document.createElement('dialog');dialog.id='contact-dialog';dialog.className='contact-dialog';dialog.setAttribute('aria-labelledby','contact-title');
    dialog.innerHTML='<div class="contact-heading"><h2 id="contact-title">Контакт для выезда</h2><button type="button" class="button secondary" data-close-contact aria-label="Закрыть контакт">Закрыть</button></div><p class="contact-description">'+esc(packetContactText((state.packet||state.data.request_packet||{}).contacts))+'</p><input class="contact-number" type="tel" aria-label="Номер телефона" readonly value="'+esc(phone)+'"><div class="contact-actions"><a class="button primary" data-dial href="tel:'+esc(phone)+'">Набрать номер ↗</a><button type="button" class="button secondary" data-copy-phone>Скопировать номер</button></div><p class="field-note" data-contact-status role="status">Окно звонка откроется отдельно. Чтобы продолжить отчёт, вернитесь в Telegram.</p>';
    document.body.appendChild(dialog);
    dialog.querySelector('[data-close-contact]').onclick=function(){dialog.close();};
    dialog.addEventListener('click',function(event){if(event.target===dialog)dialog.close();});
    dialog.querySelector('[data-copy-phone]').onclick=async function(){var ok=await copyText(phone,'Номер скопирован');var status=dialog.querySelector('[data-contact-status]');status.textContent=ok?'Номер скопирован. Можно вставить в приложении «Телефон».':'Выделите номер в поле выше и выберите «Копировать».';if(!ok){var input=dialog.querySelector('input');input.focus();input.select();}};
    dialog.querySelector('[data-dial]').onclick=function(event){
      if(tg&&tg.platform&&tg.platform!=='unknown'){event.preventDefault();var url=actions.callUrl(location.origin,phone);if(!openExternal(url))dialog.querySelector('[data-contact-status]').textContent='Окно звонка не открылось. Скопируйте номер кнопкой рядом.';}
    };
    dialog.showModal();
  }
  async function copyText(text,message){
    var previous=document.activeElement,temporary;
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){try{await navigator.clipboard.writeText(text||'');notify(message);return true;}catch(error){}}
      temporary=document.createElement('textarea');temporary.value=text||'';temporary.className='clipboard-copy';(document.querySelector('dialog[open]')||document.body).appendChild(temporary);temporary.focus();temporary.select();if(!document.execCommand('copy'))throw new Error('copy');notify(message);return true;
    }catch(error){notify('Выделите номер, адрес или ссылку и выберите «Копировать».');return false;}
    finally{if(temporary)temporary.remove();if(previous&&previous.isConnected)previous.focus();}
  }
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
  async function useManagerPlan(fileId){var targetPlanId=activePlanId;var file=packetFiles().find(function(f){return String(f.id)===String(fileId);});if(!file||state.frozen||state.submitting)return;queue(async function(){try{await flush();var current=currentPlan(targetPlanId);if(!current)return;if(String(current.manager_material_id||'')===String(fileId)&&state.evidence.some(function(e){return e.id===current.evidence_id;})){notify('Документ уже открыт. Выберите нужную страницу в редакторе.');return;}var response=await fetch(file.url);if(!response.ok)throw new Error('Не удалось получить документ из заявки.');var blob=await response.blob(),encoded=await readBase64(blob),uploaded=await postEvidence({name:file.name,type:file.mime||blob.type},'plan-source','source',encoded);var previous=clone(current);delete previous.versions;delete previous.history;delete previous.pending;var versions=(current.versions||[]).concat(current.evidence_id?[previous]:[]).slice(-20);setCurrentPlan({id:current.id,evidence_id:uploaded.id,manager_material_id:fileId,page:1,annotations:[],versions:versions},targetPlanId);state.data.inspection.plan_source=file.role==='egrn'?'ЕГРН':file.role==='archive'?'Архив':'План из заявки';state.dirty=true;state.version++;await flush();render();notify('Документ открыт. Выберите лист с графикой.');}catch(error){notify(error.message);}});}
  async function evidenceUrl(eid){if(blobUrls.has(String(eid)))return blobUrls.get(String(eid));if(!state.draft)throw new Error('Сначала сохраните черновик.');var response=await fetch('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence/'+encodeURIComponent(eid));if(!response.ok)throw new Error('Не удалось загрузить оригинал файла.');var url=URL.createObjectURL(await response.blob());blobUrls.set(String(eid),url);return url;}
  function loadThumbnails(scope){(scope||root).querySelectorAll('[data-evidence-image]').forEach(function(image){evidenceUrl(image.dataset.evidenceImage).then(function(url){if(image.isConnected)image.src=url;}).catch(function(){if(image.isConnected)image.alt='Превью недоступно. Оригинал можно открыть повторно.';});});}
  async function openEvidence(eid){try{var url=await evidenceUrl(eid);var e=state.evidence.find(function(x){return String(x.id)===String(eid);});var link=document.createElement('a');link.href=url;link.download=e&&e.name||'document';document.body.appendChild(link);link.click();link.remove();}catch(error){notify(error.message);}}
  function readBase64(file){return new Promise(function(resolve,reject){var reader=new FileReader();reader.onload=function(){resolve(String(reader.result).split(',')[1]);};reader.onerror=function(){reject(new Error('Не удалось прочитать файл '+file.name));};reader.readAsDataURL(file);});}
  async function evidenceId(file,role,subject,data){var key=[file.name,file.type||file.mime,role,subject||'',data].join('\n');if(window.crypto&&crypto.subtle&&window.TextEncoder){var digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));var hex=Array.from(new Uint8Array(digest)).map(function(n){return n.toString(16).padStart(2,'0');}).join('').slice(0,32);hex=hex.slice(0,12)+'4'+hex.slice(13,16)+'8'+hex.slice(17);return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20,32);}var hash=0;for(var i=0;i<key.length;i++)hash=(Math.imul(31,hash)+key.charCodeAt(i))|0;var short=file.name+':'+role+':'+subject+':'+data.length+':'+hash;if(!uploadIds.has(short))uploadIds.set(short,uuid());return uploadIds.get(short);}
  async function postEvidence(file,role,subject,data,eid){var result=await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:eid||await evidenceId(file,role,subject,data),revision:state.draft.revision,name:file.name,mime:file.type||file.mime,role:role,subject_id:subject||'',data:data})});adoptRevision(result);var evidence=result.evidence;if(evidence&&!Array.isArray(evidence)){state.evidence=state.evidence.filter(function(e){return String(e.id)!==String(evidence.id);});state.evidence.push(evidence);}return evidence;}
  async function uploadFiles(files,role,subject,options){options=options||{};if(!files.length)return;if(state.submitting||state.frozen||state.conflict){notify('Сначала завершите текущую операцию с черновиком.');return;}var allowed=['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/avif','image/tiff','image/bmp','application/pdf'];var invalid=files.find(function(f){return !allowed.includes(f.type)||f.size>12*1024*1024;});if(invalid)throw new Error(invalid.size>12*1024*1024?'Файл '+invalid.name+' больше 12 МБ.':'Поддерживаются изображения и PDF. Выберите другой формат для '+invalid.name+'.');if(state.evidence.length+state.pendingUploads+files.length>60)throw new Error('В одной проверке можно сохранить до 60 файлов.');var total=state.evidence.reduce(function(n,e){return n+Number(e.size||e.bytes||0);},0)+files.reduce(function(n,f){return n+f.size;},0);if(total>100*1024*1024)throw new Error('Общий объём файлов проверки больше 100 МБ.');state.pendingUploads+=files.length;status('Загружаю оригиналы файлов…');return queue(async function(){var saved=[];try{await flush();for(var i=0;i<files.length;i++){status('Загружаю оригинал '+(i+1)+' из '+files.length+'…');var data=await readBase64(files[i]);saved.push(await postEvidence(files[i],role,subject,data));state.pendingUploads--;localSave();}status('Оригиналы сохранены на сервере · '+timeLabel(),'success');if(!options.noRender)render();return saved;}catch(error){state.pendingUploads=0;status('Файлы сохранены не полностью · '+error.message,'warning');if(error.status===409){state.conflict=true;$('#conflict-panel').hidden=false;}throw error;}});}
  async function uploadEditorSource(file,role){var type=file.type||'';if(!type&&/\.pdf$/i.test(file.name)){var first=await file.slice(0,8).arrayBuffer();if(new TextDecoder().decode(first).startsWith('%PDF-'))file=new File([file],file.name,{type:'application/pdf'});}if(file.type==='application/pdf'){var pdfjs=await import('/vendor/pdfjs/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.mjs';var task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false});try{var pdf=await task.promise;if(!pdf.numPages)throw new Error('В PDF нет страниц.');await pdf.destroy();}catch(error){throw new Error('Не удалось прочитать PDF. Выберите другой файл.');}}var saved=await uploadFiles([file],role,'source',{noRender:true});return saved&&saved[0];}
  async function deleteEvidence(eid){if(state.submitting||state.frozen||state.conflict)return;var evidence=state.evidence.find(function(e){return String(e.id)===String(eid);});if(!evidence)return;if(!window.confirm('Убрать файл «'+(evidence.name||'документ')+'» из этой проверки?'))return;queue(async function(){try{await flush();var result=await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence/'+encodeURIComponent(eid),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});adoptRevision(result);state.evidence=state.evidence.filter(function(e){return String(e.id)!==String(eid);});if(String(state.data.plan.evidence_id)===String(eid)){state.data.plan.evidence_id='';state.data.plan.annotations=[];state.dirty=true;state.version++;await flush();}if(blobUrls.has(String(eid))){URL.revokeObjectURL(blobUrls.get(String(eid)));blobUrls.delete(String(eid));}localSave();render();notify('Файл убран из проверки.');}catch(error){notify(error.message);}});}
  async function removeGeneratedEvidence(eid){var result=await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence/'+encodeURIComponent(eid),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});adoptRevision(result);state.evidence=state.evidence.filter(function(e){return e.id!==eid;});}
  async function exportGraphic(plan,kind,subject){if(!window.AuditPlanEditor||!plan.evidence_id||!plan.annotations.length)return null;var host=document.createElement('div');host.className='export-shell';document.body.appendChild(host);var api;try{api=window.AuditPlanEditor.mount(host,{kind:kind,service:state.data.object_category==='tobacco'?'tobacco':'alcohol',getState:function(){return plan;},onChange:function(){},evidenceUrl:evidenceUrl,evidence:state.evidence});await api.refresh();var result=await api.exportPreview();if(result)result.subject_id=subject;return result;}finally{if(api)api.destroy();host.remove();}}
  async function exportPlan(){return exportGraphic(state.data.plan,'plan','annotation');}
  function freezeControls(){
    if(!state.frozen)return;
    root.querySelectorAll('input,select,textarea').forEach(function(control){control.disabled=true;});
    root.querySelectorAll('button').forEach(function(button){if(button.id!=='submit-audit'&&!button.hasAttribute('data-open-evidence')&&!button.hasAttribute('data-go-step')&&!button.hasAttribute('data-download-material')&&!button.hasAttribute('data-download-materials')&&!button.hasAttribute('data-download-archive')&&!button.hasAttribute('data-copy-address')&&!button.hasAttribute('data-copy-archive')&&!button.hasAttribute('data-contact'))button.disabled=true;});
    root.querySelectorAll('.plan-editor-shell canvas').forEach(function(canvas){canvas.style.pointerEvents='none';});
    var submitButton=$('#submit-audit');if(submitButton)submitButton.textContent='Повторить отправку этой версии';
    var submitStatus=$('#submit-status');if(submitStatus)submitStatus.textContent='Отправка началась — версия зафиксирована. Можно просмотреть этапы и повторить отправку без изменений.';
    notice('Отправка началась — версия зафиксирована. Можно просмотреть данные и повторить отправку без изменений.');
    $('#save-now').disabled=true;
  }
  function frozenSnapshot(remote){
    clearTimeout(timer);var currentStep=step();
    if(remote){state.draft=remote;state.data=restoreData(remote.data,true);state.viewStep=currentStep;state.packet=state.data.request_packet||null;state.evidence=remote.evidence||[];}
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
    try{if(editor&&editor.flush)await editor.flush();}catch(error){notify(error.message);return;}
    var p=state.data.inspection;
    if(!state.frozen){
      if(!p.org.trim()||!p.address.trim()||!p.service){notify('В заявке не хватает данных. Менеджеру нужно дополнить объект, адрес или услугу. Наблюдения сохранены в черновике.');go(0);return;}
      if(!state.data.workflow.conclusion_status){notify('Выберите результат проверки.');return;}if(!state.data.conclusion.trim())state.data.conclusion=({ready:'Соответствует по проверенным пунктам',actions:'Нужны действия',insufficient:'Недостаточно данных',obstacle:'Выявлено препятствие'})[state.data.workflow.conclusion_status];
      if(state.data.workflow.conclusion_status==='ready'&&issues().length){notify('Есть открытые вопросы. Выберите «Нужно уточнить» или «Нужны действия», либо завершите проверку.');return;}
      state.data.ui_version=5;state.data.inspection.region='МСК';
      p.all_entrances_checked=state.data.entrances.length&&state.data.entrances.every(function(e){return evidenceFor('entrance',e.id).length;})?'Да':'Не проверено';p.zones_checked=state.data.zones.every(function(z){return z.status&&z.status!=='pending'&&z.name&&evidenceFor('zone',z.id).length;})?'Да':'Не проверено';state.data.additional_plans=state.data.additional_plans.filter(function(p){return p.evidence_id||p.annotations.length;});['alcohol_present','within_cadastral','all_entrances_checked','zones_checked'].forEach(function(key){if(!p[key])p[key]='Не проверено';});
      if(isRenewal()){if(!p.archive_available)p.archive_available=state.packet&&(state.packet.archive_url||packetFiles().some(function(f){return f.role==='archive';}))?'Да':'Не проверено';if(p.alcohol_present==='Да'&&!p.alcohol_within_licensed)p.alcohol_within_licensed='Не проверено';}

      state.data.zones.forEach(function(zone,i){if(!zone.name.trim())zone.name='Организация '+(i+1)+' — название уточнить';});
      state.dirty=true;state.version++;localSave();
    }
    var enteredSubmission=state.frozen;
    state.submitting=true;document.body.classList.add('submitting');refreshChrome();
    var submitStatus=$('#submit-status');if(submitStatus)submitStatus.textContent=state.frozen?'Повторяю отправку зафиксированной версии…':'Сохраняю последнюю версию и проверяю приложения…';
    try{
      await queue(async function(){
        if(!state.frozen){
          await flush();var figures=[{plan:state.data.map,kind:'map',subject:'annotation'},{plan:state.data.plan,kind:'plan',subject:'annotation'}].concat(state.data.additional_plans.map(function(p){return{plan:p,kind:'plan',subject:'annotation-'+p.id};}));for(var figure of figures){var preview=await exportGraphic(figure.plan,figure.kind,figure.subject);if(preview){if(submitStatus)submitStatus.textContent='Сохраняю схему и планы…';var newPreview=await postEvidence({name:preview.name,type:preview.mime},preview.role||figure.kind,figure.subject,preview.data);var stale=state.evidence.filter(function(e){return e.role===figure.kind&&e.subject_id===figure.subject&&e.id!==newPreview.id;});for(var oldPreview of stale){await removeGeneratedEvidence(oldPreview.id);}}}
        }
        if(!state.frozen){var activeSubjects=['annotation'].concat(state.data.additional_plans.map(function(p){return 'annotation-'+p.id;}));var retiredExports=state.evidence.filter(function(e){return e.role==='plan'&&String(e.subject_id||'').startsWith('annotation-')&&!activeSubjects.includes(e.subject_id);});for(var retiredExport of retiredExports)await removeGeneratedEvidence(retiredExport.id);}
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
    try{var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId));if(!result.draft)throw new Error('Серверная версия не найдена.');state.data=restoreData(result.draft.data,!!result.draft.submitting);state.draft=result.draft;state.evidence=result.draft.evidence||[];state.conflict=false;state.dirty=false;state.frozen=!!result.draft.submitting;state.viewStep=state.frozen?2:null;state.packet=state.data.request_packet||null;$('#conflict-panel').hidden=true;if(!state.frozen)await fetchPacket();localSave();render();status(state.frozen?'Повторите отправку этой версии':'Загружено с сервера',state.frozen?'warning':'success');}catch(error){notify(error.message);}
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
  function restoreData(raw,preserveVersion){
    var next=merge(clone(defaults),raw||{});
    if(Number(raw&&raw.ui_version)<4){var old=Number(raw&&raw.workflow&&raw.workflow.step)||0;next.workflow.step=old<4?0:old<6?1:2;}
    next.ui_version=preserveVersion&&raw&&raw.ui_version?raw.ui_version:5;next.inspection.region='МСК';return next;
  }
  async function fetchPacket(){
    if(state.frozen){state.packet=state.data.request_packet||state.packet;return;}
    var packet=await request('/api/audit/prefill?order_id='+encodeURIComponent(orderId));
    if(packet.object_category==='other'){window.location.replace('/audit/legacy'+window.location.search);return;}
    var before=JSON.stringify(stable(state.data));state.packet=packet;
    state.data.inspection.org=packet.org||'';state.data.inspection.address=packet.address||'';state.data.inspection.service=packet.service||'';state.data.inspection.region='МСК';
    state.data.object_category=['catering','retail','tobacco'].includes(packet.object_category)?packet.object_category:'catering';
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
        if(remote.submitting){if(local&&local.dirty){state.recoveryData=clone(local.data);state.conflict=true;$('#conflict-panel').hidden=false;}state.draft=remote;state.data=restoreData(remote.data,true);state.evidence=remote.evidence||[];state.frozen=true;state.viewStep=2;state.dirty=false;state.packet=state.data.request_packet||null;}
        else if(local&&local.dirty){if(String(local.draft_id||'')===String(remote.id)&&Number(local.revision)===Number(remote.revision)){state.draft=remote;state.evidence=remote.evidence||[];}else{state.draft=remote;state.evidence=remote.evidence||[];state.conflict=true;$('#conflict-panel').hidden=false;}}
        else{state.data=restoreData(remote.data);state.draft=remote;state.evidence=remote.evidence||[];state.dirty=Number(remote.data&&remote.data.ui_version)!==5;}
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
