(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  var actions = window.AuditActions;
  var phoneHandoffBase = 'https://iam108.github.io/zamery-bot/';
  try { if (tg) { tg.ready(); tg.expand(); } } catch (e) {}
  var params = new URLSearchParams(window.location.search);
  var orderId = params.get('order_id') || '';
  var legacyLink = document.querySelector('.legacy-link'); if (legacyLink) legacyLink.href = '/audit/legacy' + window.location.search;
  var storedUid = ''; try { storedUid = sessionStorage.getItem('tg_u') || ''; } catch (e) {}
  var uid = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? String(tg.initDataUnsafe.user.id) : (params.get('u') || storedUid || 'staff');
  var localKey = 'audit-wizard-v3:' + uid + ':' + (orderId || 'new');
  var STEPS = [
    ['Территория', 'Входы и проверка территории', 'Укажите результат проверки территории и приложите фото каждого входа.'],
    ['Помещение', 'План помещения', 'Выберите нужный лист PDF и отметьте фактическую планировку.'],
    ['Отчёт', 'Результат проверки', 'Краткий вывод и вопросы, которые осталось решить.']
  ];
  var TRI = ['', 'Да', 'Нет', 'Не проверено'];
  var OUTCOME_LABELS = {ready:'Соответствует по проверенным пунктам',actions:'Нужны действия',insufficient:'Недостаточно данных',obstacle:'Выявлено препятствие'};
  var ZONE_STATUS = {clear:'Без замечаний',licensed:'Есть сведения о лицензии',disputed:'Спорное место',confirmed:'Есть ограничение',pending:'Нужно уточнить',other:'Наблюдение'};
  var MAP_IMAGE_TYPES = ['image/jpeg','image/png'];
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
  var pendingSave = null, queuedJobs = 0, closingConfirmation = false, saveRetries = 0;
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
  function updateClosingConfirmation() {
    var needed=!state.completed&&(state.dirty||state.pendingUploads>0||state.submitting);
    if(!tg||needed===closingConfirmation)return;
    var method=needed?'enableClosingConfirmation':'disableClosingConfirmation';
    try{if(typeof tg[method]==='function'){tg[method]();closingConfirmation=needed;}}catch(e){}
  }
  function status(text,tone) { $('#save-state').textContent=text;$('#save-state').dataset.tone=tone||'';updateClosingConfirmation(); }
  function queue(fn,immediate) {
    var startNow=immediate&&!queuedJobs;
    queuedJobs++;
    // On real pagehide, Chromium may stop running queued callbacks before
    // the keepalive request has even been dispatched. Start the idle queue
    // in this event handler, and serialize it with regular writes.
    var next=(startNow?fn():tail.then(fn)).finally(function(){queuedJobs--;});
    tail=next.catch(function(){});return next;
  }
  function localSave() {
    if(!orderId||!state.loaded||state.completed||state.frozen||state.blocked)return;
    var snapshot={draft_id:state.draft&&state.draft.id,revision:state.draft&&state.draft.revision,data:state.data,dirty:state.dirty,conflict:state.conflict,saved_at:Date.now()};
    try{
      // The last dispatched write lets us safely recover a saved request whose
      // acknowledgement died with the WebView, without overwriting other edits.
      try{localStorage.setItem(localKey,JSON.stringify(Object.assign({},snapshot,{attempt:state.attempt||null})));}
      catch(e){localStorage.setItem(localKey,JSON.stringify(snapshot));}
      state.localSaved=true;
    }catch(e){state.localSaved=false;if(state.dirty)status('Не удалось сохранить на устройстве. Дождитесь сохранения на сервере.','warning');}
  }
  function scheduleSave(delay) {
    if(timer||!state.dirty||state.conflict||state.blocked||state.needsRestore||state.submitting||state.frozen)return;
    timer=setTimeout(function(){timer=null;saveNow().catch(function(){});},delay);
  }
  function changed() {
    if(state.submitting||state.frozen||state.blocked)return;
    state.version++;state.dirty=true;state.serverError='';saveRetries=0;localSave();refreshChrome();
    if(!state.conflict)status(state.needsRestore?(state.localSaved?'Сохранено на устройстве':'Не удалось сохранить на устройстве'):(state.localSaved?'На устройстве · сохраняю на сервер…':'Сохраняю на сервер…'),state.needsRestore?'warning':'');
    scheduleSave(350);
  }
  function saveOnExit() {
    if(!state.loaded||!orderId||!state.dirty||state.blocked||state.frozen||state.completed)return;
    localSave();
    if(!state.conflict&&!state.submitting&&!state.needsRestore)saveNow(true).catch(function(){});
  }
  function sameData(a,b) {return !!a&&!!b&&JSON.stringify(stable(a))===JSON.stringify(stable(b));}
  function draftWriteOptions(method, payload) {
    var body=JSON.stringify(payload);
    // Browsers cap all outstanding keepalive bodies at 64 KiB. The writes
    // here are serialized; oversized drafts still save normally while open.
    return {method:method,headers:{'Content-Type':'application/json'},body:body,keepalive:typeof TextEncoder!=='undefined'&&body.length<62*1024&&new TextEncoder().encode(body).length<62*1024};
  }
  async function requestWithDeadline(url,options,consume,timeoutMs) {
    var controller=typeof AbortController==='function'?new AbortController():null;
    var sourceSignal=options&&options.signal,requestOptions=Object.assign({},options||{}),deadlineTimer;
    var relayAbort=function(){if(controller)controller.abort(sourceSignal.reason);};
    if(controller){requestOptions.signal=controller.signal;if(sourceSignal){if(sourceSignal.aborted)relayAbort();else sourceSignal.addEventListener('abort',relayAbort,{once:true});}}
    var deadline=new Promise(function(resolve,reject){deadlineTimer=setTimeout(function(){
      var error=new Error('Сервер долго не отвечает. Повторите действие; сохранённый черновик останется на месте.');
      error.code='REQUEST_TIMEOUT';error.retryable=true;if(controller)controller.abort(error);reject(error);
    },timeoutMs);});
    try{return await Promise.race([Promise.resolve().then(function(){return fetch(url,requestOptions);}).then(consume),deadline]);}
    finally{clearTimeout(deadlineTimer);if(sourceSignal)sourceSignal.removeEventListener('abort',relayAbort);}
  }
  async function request(url,options) {
    var response,text,data;
    var timeoutMs=url==='/api/audit'?120000:options&&options.method==='POST'&&/\/evidence$/.test(url)?90000:30000;
    try{text=await requestWithDeadline(url,options,function(result){response=result;return response.text();},timeoutMs);}
    catch(e){if(e.code==='REQUEST_TIMEOUT')throw e;var disconnected=new Error('Нет связи с ботом. Проверьте интернет и повторите действие.');disconnected.retryable=true;throw disconnected;}
    try{data=JSON.parse(text);}catch(e){
      if(/checking your browser|turnstile|rate limited/i.test(text)||response.status===429){var restricted=new Error('Сервис временно ограничил доступ. Повторите действие через минуту.');restricted.retryable=true;throw restricted;}
      if(response.status===413){var oversized=new Error('Файл слишком большой. Максимум 12 МБ на файл.');oversized.status=413;throw oversized;}
      var unexpected=new Error('Сервер не ответил как ожидалось. Повторите действие. Если файл не появился в отчёте, выберите его заново.');
      unexpected.status=response.status;unexpected.retryable=response.status>=500||[408,425,429].indexOf(response.status)>=0;throw unexpected;
    }
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Сервер вернул некорректные данные. Повторите действие.');
    if(!response.ok||data.ok===false){var error=new Error(data.error||'Не удалось выполнить запрос.');error.status=response.status;error.retryable=response.status>=500||[408,425,429].indexOf(response.status)>=0;error.payload=data;throw error;}
    return data;
  }
  function adoptRevision(result) {
    var draft=result.draft||null;
    if(draft){state.draft=Object.assign({},state.draft||{},draft);if(Array.isArray(draft.evidence))state.evidence=draft.evidence;}
    else if(state.draft&&result.revision!=null)state.draft.revision=result.revision;
    if(result.evidence&&Array.isArray(result.evidence))state.evidence=result.evidence;
    $('#draft-id').textContent=orderId?'Заявка #'+orderId:'Черновик';
  }
  async function recoverUnconfirmedWrite() {
    var attempt=state.attempt;
    if(!attempt)return;
    var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId)), remote=result.draft;
    var sameVersion=remote&&state.draft&&String(remote.id)===String(state.draft.id)&&Number(remote.revision)===Number(state.draft.revision);
    var matched=remote&&!remote.submitting&&(!attempt.draft_id||String(attempt.draft_id)===String(remote.id))&&sameData(attempt.data,remote.data);
    if(matched){adoptRevision(result);state.dirty=!sameData(state.data,remote.data);}
    else if(!(sameVersion&&!remote.submitting)&&!(!remote&&!state.draft)){
      var conflict=new Error('Черновик изменился в другом окне. Ваши правки остались на устройстве.');conflict.status=409;throw conflict;
    }
    state.attempt=null;localSave();
  }
  async function flush() {
    if(state.frozen)throw new Error('Версия отчёта зафиксирована. Повторите отправку без изменений.');
    if(state.blocked||!orderId)throw new Error('Сначала откройте проверку из заявки.');
    if(state.needsRestore)throw new Error('Сначала восстановите связь с ботом: нажмите «Повторить» над формой.');
    if(state.conflict)throw new Error('Сначала разрешите конфликт версий.');
    clearTimeout(timer);timer=null;
    while(state.dirty||!state.draft){
      status('Сохраняю на сервер…');
      try{
        if(state.attempt)await recoverUnconfirmedWrite();
        if(!state.dirty&&state.draft)break;
        var version=state.version,data=clone(state.data);
        var creating=!state.draft,draftId=state.draft&&state.draft.id,rev=state.draft&&state.draft.revision;
        var path=creating?'/api/audit/drafts':'/api/audit/drafts/'+encodeURIComponent(draftId);
        state.attempt={draft_id:draftId||null,data:data};localSave();
        var result=await request(path,draftWriteOptions(creating?'POST':'PUT',creating?{order_id:orderId,data:data}:{revision:rev,data:data}));
        if(creating&&result.draft&&result.draft.data&&!sameData(result.draft.data,data)){adoptRevision(result);var conflict=new Error('В другом окне уже создана другая версия проверки.');conflict.status=409;throw conflict;}
        adoptRevision(result);state.dirty=state.version!==version;state.attempt=null;state.serverError='';saveRetries=0;localSave();
      }catch(error){
        state.serverError=error.message;
        if(error.status===409){state.conflict=true;localSave();$('#conflict-panel').hidden=false;status(state.localSaved?'Конфликт версий · ваши правки на устройстве':'Конфликт версий · скачайте копию ваших правок','warning');}
        else {
          status((state.localSaved?'Только на устройстве · ':'Не сохранено · ')+error.message,'warning');
          if((error.retryable||error.status>=500)&&saveRetries<3&&document.visibilityState!=='hidden')scheduleSave(2000*Math.pow(2,saveRetries++));
        }
        throw error;
      }
    }
    state.serverError='';status('Сохранено на сервере · '+timeLabel(),'success');return state.draft;
  }
  function saveNow(immediate){
    if(!pendingSave)pendingSave=queue(flush,immediate).finally(function(){pendingSave=null;});
    return pendingSave;
  }

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
  function uploader(role,subject,label,camera,imageEvidence){var uid=id('upload'),accept='image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif,image/tiff,image/bmp';return '<label class="upload-control" for="'+uid+'"><input type="file" id="'+uid+'" data-upload-role="'+esc(role)+'" data-upload-subject="'+esc(subject||'')+'" accept="'+accept+(camera||imageEvidence?'':',application/pdf')+'"'+(camera?' capture="environment"':'')+' multiple><span class="upload-label">'+esc(label||'Добавить файл или фото')+'</span></label>';}
  function evidenceFor(role,subject){return state.evidence.filter(function(e){return e.role===role&&(subject==null||String(e.subject_id||'')===String(subject));});}
  function evidenceCards(role,subject,evidenceId){var files=evidenceFor(role,subject);if(evidenceId!=null)files=files.filter(function(e){return String(e.id)===String(evidenceId);});if(!files.length)return '';return '<div class="evidence-grid">'+files.map(function(e){var image=/^image\//.test(e.mime||e.mime_type||'');return '<article class="evidence-card"><div class="evidence-preview">'+(image?'<img alt="'+esc(e.name||'Фото')+'" data-evidence-image="'+esc(e.id)+'">':'PDF')+'</div><div class="evidence-details"><div class="evidence-name">'+esc(e.name||'Файл')+'</div><div class="evidence-meta">Оригинал · '+bytes(e.size||e.bytes||0)+'</div><div class="evidence-actions"><button type="button" data-open-evidence="'+esc(e.id)+'">Открыть</button><button type="button" class="remove-evidence" data-delete-evidence="'+esc(e.id)+'" aria-label="Удалить '+esc(e.name||'файл')+'">Убрать</button></div></div></article>';}).join('')+'</div>';}
  function evidenceBlock(role,subject,title,help){var imageEvidence=role==='entrance'||role==='zone';return '<div class="section-heading"><div><h3>'+esc(title)+'</h3>'+(help?'<p>'+esc(help)+'</p>':'')+'</div></div><div class="upload-row">'+uploader(role,subject,'Сделать фото',true)+uploader(role,subject,imageEvidence?'Выбрать фото':'Выбрать файл',false,imageEvidence)+'</div>'+evidenceCards(role,subject);}

  function packetFiles() { return state.packet && Array.isArray(state.packet.materials) ? state.packet.materials : []; }
  function packetEgrnLinks() {
    var packet=state.packet||state.data.request_packet||{};
    return Array.isArray(packet.egrn_links)?packet.egrn_links:[];
  }
  function largeEgrnFilesHtml(packet) {
    var links=packet?packet.egrn_links||[]:packetEgrnLinks();
    if(!links.length)return '';
    return '<div class="manager-files">'+links.map(function(file){
      return '<article class="manager-file"><div><span class="tag">ЕГРН · оригинал</span><strong>'+esc(file.name)+'</strong><small>'+bytes(file.bytes)+'</small></div>'+
        '<div class="action-row"><button type="button" class="button secondary" data-open-egrn="'+esc(file.id)+'">'+(file.source==='telegram'?'Открыть в Telegram':'Открыть выписку ↗')+'</button></div></article>';
    }).join('')+'</div>';
  }
  async function openLargeEgrn(fileId,button) {
    var file=packetEgrnLinks().concat(state.pendingPacket&&state.pendingPacket.egrn_links||[]).find(function(item){return String(item.id)===String(fileId);});
    if(!file)return;
    if(!/^\/api\/audit\/orders\/[1-9]\d*\/egrn\/[0-9a-f-]{36}\/link$/i.test(file.url||'')){notify('Ссылка на оригинал выписки недоступна. Обновите заявку.');return;}
    if(button)button.disabled=true;
    try{
      var result=await request(file.url);
      var url=new URL(result.url,window.location.origin);
      if(url.protocol!=='https:'&&url.origin!==window.location.origin)throw new Error('Не удалось подтвердить ссылку на выписку.');
      if(url.hostname==='t.me'&&tg&&typeof tg.openTelegramLink==='function'){
        try{tg.openTelegramLink(url.href);return;}catch(e){}
      }
      if(!openExternal(url.href))notify('Не удалось открыть выписку. Разрешите открытие новой вкладки и повторите.');
    }catch(error){notify(error.message);}
    finally{if(button)button.disabled=false;}
  }
  function packetContactText(raw) {
    if (!raw) return '';
    try { if (typeof raw === 'string') raw = JSON.parse(raw); } catch (e) {}
    if (Array.isArray(raw)) return raw.map(packetContactText).filter(Boolean).join('; ');
    if (raw && typeof raw === 'object') return [raw.name || raw.contact_name, raw.phone || raw.contact_phone, raw.comment].filter(Boolean).join(' · ');
    return String(raw);
  }
  function packetPhone() { return actions.findPhone((state.packet||state.data.request_packet||{}).contacts); }
  function nativePhoneLink() {
    // Telegram iOS forwards target=_blank links to its native URL opener.
    // The WebApp SDK's openLink instead accepts only approved protocols.
    if (actions.hasTelegramBridge(window)) return !!(tg && tg.platform === 'ios');
    return /iPhone|iPad|iPod/i.test((window.navigator || {}).userAgent || '');
  }
  function phoneActionUrl(phone) { return nativePhoneLink() ? 'tel:' + phone : actions.callUrl(phoneHandoffBase, phone, true); }
  function saveBeforePhone() {
    // Saving must never cancel a real link tap or delay it behind a request.
    try { localSave(); } catch (_) {}
    try { saveNow().catch(function () {}); } catch (_) {}
  }
  function bindPhoneAction(link, phone, onFailure) {
    link.href = phoneActionUrl(phone); link.target = '_blank'; link.rel = 'noopener';
    link.onclick = function (event) {
      if (nativePhoneLink()) { saveBeforePhone(); return; }
      event.preventDefault(); saveBeforePhone();
      if (!openExternal(actions.callUrl(phoneHandoffBase, phone, true)) && onFailure) onFailure();
    };
  }
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
    var html='<section class="request-packet"><div class="packet-title"><span class="tag">Заявка #'+esc(orderId)+'</span><span>'+esc(({catering:'Алкоголь · общепит',retail:'Алкоголь · магазин',tobacco:'Табак'})[state.data.object_category]||'Объект')+' · '+esc(p.service)+'</span></div><h2>'+esc(packet.object_name||packet.org||p.org)+'</h2><p class="packet-address">'+esc(packet.address||p.address)+'</p><div class="action-row"><a class="button secondary" data-route target="_blank" rel="noopener" href="'+esc(routeActionUrl())+'">'+(opensMapAddress()?'Открыть адрес в Картах ↗':'Построить маршрут ↗')+'</a>'+(phone?'<a class="button secondary" data-call target="_blank" rel="noopener" href="'+esc(phoneActionUrl(phone))+'">Позвонить ↗</a>':'')+'</div>'+(opensMapAddress()?'<p class="field-note">Маршрут выберите в Яндекс Картах. Вернуться к отчёту можно через Telegram.</p>':'')+(contact?'<p class="packet-contact">'+esc(contact)+'</p>':'');
    if(packet.zones_info)html+='<details class="packet-details"><summary>Комментарий менеджера</summary><p>'+esc(packet.zones_info)+'</p></details>';
    html+='<details class="packet-details"><summary>Документы заявки · '+(files.length+packetEgrnLinks().length)+'</summary>'+(files.length?'<button type="button" class="button secondary full" data-download-materials>'+(packetEgrnLinks().length?'Скачать остальные файлы':'Скачать всё')+'</button>':'')+managerFilesHtml(files,false)+largeEgrnFilesHtml()+'<p class="field-note">Документы и папку объекта прикрепляет менеджер до передачи заявки аудитору.</p></details>';
    if(isRenewal())html+='<div class="archive-box"><div class="card-top"><h3>Архив объекта</h3><span class="tag">'+(archiveFiles.length?'Приложен':state.data.workflow.archive_skipped==='Да'?'Без архива':'Графика не приложена')+'</span></div>'+(hasArchive?'<div class="action-row"><button type="button" class="button secondary" data-download-archive>Скачать архив</button>'+(packet.archive_url?'<button type="button" class="button secondary" data-copy-archive>Скопировать ссылку</button>':'')+'</div>':'')+(!archiveFiles.length||state.data.workflow.archive_skipped==='Да'?'<button type="button" class="button secondary full" data-skip-archive>'+ (state.data.workflow.archive_skipped==='Да'?'Добавить архив / отменить пропуск':'Архива нет — продолжить')+'</button>':'')+'</div>';
    html+='</section><section class="capture-section"><div class="section-heading"><h3>Здание</h3><a class="inline-link" target="_blank" rel="noopener" href="https://dom.mos.ru/">Проверить на dom.mos.ru ↗</a></div>'+choices('building_type','Здание',[['Жилое','Жилое'],['Нежилое','Нежилое']])+'</section>';
    if(!p.service||!p.address||!p.org)html+='<div class="note-box warning">В заявке не хватает данных объекта или услуги. Это дополняет менеджер.</div>';
    return html;
  }
  function choices(path,label,options){return '<div class="choice-field"><span class="field-label">'+esc(label)+'</span><div class="choice-options" role="group" aria-label="'+esc(label)+'">'+options.map(function(o){return '<button type="button" class="button secondary'+(String(get(path))===o[0]?' selected':'')+'" aria-pressed="'+(String(get(path))===o[0])+'" data-choice="'+esc(path)+'" data-value="'+esc(o[0])+'">'+esc(o[1])+'</button>';}).join('')+'</div></div>';}

  function mapMode() { var map=state.data.map||{};return map.mode||(map.evidence_id||(map.annotations||[]).length?'draw':''); }
  function manualTerritory() { return state.data.workflow.territory_result==='clear'||mapMode()==='attached'; }
  function territoryUpload(mode,label) {
    var uid=id('map-upload');
    return '<label class="upload-control" for="'+uid+'"><input type="file" id="'+uid+'" data-territory-upload="'+mode+'" accept="image/jpeg,image/png,.jpg,.jpeg,.png"><span class="upload-label">'+esc(label)+'</span></label>';
  }
  function entranceCards() {
    var manual=manualTerritory();
    return '<section class="capture-section"><h3>Входы</h3>'+(manual?'<p class="field-note">Добавьте отдельную карточку с названием и фото для каждого входа.</p>':(!state.data.entrances.length?'<p class="field-note">Отметьте вход на схеме, чтобы добавить его фото.</p>':''))+
      state.data.entrances.map(function(e,i){
        var title=manual?'<div class="card-top"><h3 tabindex="-1" data-entrance-title="'+i+'">Вход '+(i+1)+'</h3><button type="button" class="button secondary card-remove" data-remove-entrance="'+esc(e.id)+'" aria-label="Убрать '+esc(e.label||'вход')+'">Убрать</button></div>'+input('Название входа','entrances.'+i+'.label',{maxlength:200,placeholder:'Например, главный вход'}):'<h3>'+esc(e.label||'Вход')+'</h3>';
        return '<article class="repeat-card">'+title+evidenceBlock('entrance',e.id,'Фото входа','')+'</article>';
      }).join('')+(manual?'<button type="button" class="button secondary full" data-add-entrance>Добавить вход</button>':'')+'</section>';
  }
  function zoneCards() {
    var manual=manualTerritory(),entrances=state.data.entrances.map(function(e,i){return{value:e.id,label:e.label||'Вход '+(i+1)};}),statuses=Object.keys(ZONE_STATUS).map(function(value){return{value:value,label:ZONE_STATUS[value]};});
    return '<section class="capture-section"><h3>Организации и спорные места</h3>'+(state.data.zones.length?'':'<p class="field-note">'+(manual?'Добавьте организацию, выберите вход, запишите расстояние и приложите фото.':'Отметьте организацию и линию замера на схеме.')+'</p>')+
      state.data.zones.map(function(z,i){
        var path='zones.'+i+'.',title;
        if(manual)title='<div class="card-top"><h3>Организация '+(i+1)+'</h3><button type="button" class="button secondary card-remove" data-remove-zone="'+esc(z.id)+'" aria-label="Убрать '+esc(z.name||'организацию')+'">Убрать</button></div><div class="fields">'+
          input('Название или адрес',path+'name',{maxlength:200,wide:true})+select('Результат проверки',path+'status',statuses,'',true)+select('Вход, от которого измеряли',path+'entrance_id',entrances,'',true)+
          input('Расстояние, м',path+'dist',{maxlength:20,help:'Укажите число или «Не проверено».'})+select('Как измерили · необязательно',path+'method',['Пешеходный маршрут','Прямая линия'])+
          input('Источник сведений о лицензии',path+'source',{maxlength:1000,help:'Заполните, если отмечены сведения о лицензии.',wide:true})+
          input('Комментарий или основание ограничения',path+'resolution',{type:'textarea',maxlength:2000,wide:true})+'</div>';
        else title='<div class="card-top"><h3>'+esc(z.name||'Организация')+'</h3><span class="tag">'+esc(ZONE_STATUS[z.status]||'Не проверено')+'</span></div>'+(z.dist?'<p>'+esc(z.dist)+(z.dist==='Не проверено'?'':' м')+'</p>':'')+(z.info?'<p>'+esc(z.info)+'</p>':'');
        return '<article class="repeat-card">'+title+evidenceBlock('zone',z.id,'Фото организации','')+'</article>';
      }).join('')+(manual?'<button type="button" class="button secondary full" data-add-zone>Добавить организацию</button>':'')+'</section>';
  }
  function territoryCards() {
    var result=state.data.workflow.territory_result;
    if(result==='clear')return entranceCards();
    return (result==='findings'&&mapMode())||(!result&&state.frozen)?entranceCards()+zoneCards():'';
  }
  function outsideStep(){
    var result=state.data.workflow.territory_result,mode=mapMode(),html=packetSummary()+heading(0);
    html+=choices('workflow.territory_result','Что нашли при проверке?',[['clear','Зон нет'],['findings','Есть организации или спорные места']]);
    if(!result&&!state.frozen&&(mode||state.data.entrances.length||state.data.zones.length))html+='<p class="field-note">Материалы прошлой версии сохранены в черновике. Выберите результат проверки, чтобы продолжить.</p>';
    if(result==='findings'){
      html+=choices('map.mode','Как оформить схему?',[['draw','Рисовать на скриншоте'],['attached','Приложить готовую схему']]);
      if(mode==='draw'){
        if(!state.data.map.evidence_id)html+='<p class="field-note">Выберите скриншот карты в JPG или PNG. Редактор откроется после загрузки.</p><div class="upload-row">'+territoryUpload('draw','Выбрать скриншот карты')+'</div>';
        else html+='<p class="field-note">Поставьте отметку организации у её входа. Проведите линию замера от входа объекта до входа соседней организации.</p>';
      }
      if(mode==='attached')html+='<p class="field-note">Приложите JPG или PNG, на котором видны вход объекта, вход соседней организации и расстояние между ними. Заполните карточки ниже.</p><div class="upload-row">'+territoryUpload('attached',state.data.map.evidence_id?'Заменить готовую схему':'Выбрать готовую схему')+'</div>'+evidenceCards('map','attached',state.data.map.evidence_id);
    }
    if((result==='findings'&&mode==='draw'&&state.data.map.evidence_id)||(!result&&state.frozen))html+='<div class="plan-editor-shell" id="map-editor"></div>';
    return html+'<div id="territory-evidence">'+territoryCards()+'</div>'+input('Дополнение по территории · необязательно','workflow.territory_notes',{type:'textarea',maxlength:2000});
  }
  function rememberTerritory(mode) {
    var versions=state.data.territory_versions||(state.data.territory_versions={});
    if(mode){
      versions[mode]={map:clone(state.data.map),zones:clone(state.data.zones)};
      versions.last_mode=mode;
    }
    if(mode==='draw')versions.draw.entrances=clone(state.data.entrances);
    else if(mode==='attached'||state.data.entrances.length||state.data.workflow.territory_result==='clear')versions.manual_entrances=clone(state.data.entrances);
    if(!mode&&state.data.zones.length)versions.unmapped_zones=clone(state.data.zones);
    return versions;
  }
  function switchTerritoryMode(mode) {
    var previousMode=mapMode();
    if(previousMode===mode){state.data.map.mode=mode;return;}
    var versions=rememberTerritory(previousMode),previous=versions[mode];
    state.data.map=previous?clone(previous.map):clone(defaults.map);
    state.data.map.mode=mode;
    state.data.zones=previous?clone(previous.zones):mode==='attached'?clone(versions.unmapped_zones||state.data.zones):[];
    if(mode==='draw')state.data.entrances=previous?clone(previous.entrances):[];
    else if(previousMode==='draw')state.data.entrances=clone(versions.manual_entrances||state.data.entrances);
    if(mode==='attached')state.data.zones.forEach(function(z){if(z.entrance_id&&!state.data.entrances.some(function(e){return e.id===z.entrance_id;})){z.entrance_id='';z.dist='';}});
    delete versions[mode];
  }
  function chooseTerritory(result) {
    var previous=state.data.workflow.territory_result,mode=mapMode();
    if(previous===result)return;
    if(result==='clear'){
      // A report without zones keeps the entrances and parks any prior map work.
      var versions=rememberTerritory(mode||(!previous&&state.data.zones.length?'draw':''));
      if(versions.manual_entrances)state.data.entrances=clone(versions.manual_entrances);
      state.data.map=clone(defaults.map);state.data.zones=[];
    }else if(previous==='clear'&&state.data.territory_versions&&state.data.territory_versions.last_mode){
      switchTerritoryMode(state.data.territory_versions.last_mode);
    }else if(mode){state.data.map.mode=mode;}
    state.data.workflow.territory_result=result;
  }
  function currentPlan(planId){planId=planId||activePlanId;if(planId==='main')return state.data.plan;return state.data.additional_plans.find(function(p){return p.id===planId;});}
  function setCurrentPlan(plan,planId){planId=planId||activePlanId;if(planId==='main')state.data.plan=plan;else{var i=state.data.additional_plans.findIndex(function(p){return p.id===planId;});if(i>=0)state.data.additional_plans[i]=Object.assign({},plan,{id:planId});}}

  function insideStep(){
    var p=state.data.inspection,files=packetFiles().filter(function(f){return ['plan','egrn','archive'].includes(f.role);}),renewalArchive=isRenewal()&&state.data.workflow.archive_skipped!=='Да'&&files.concat(state.evidence).some(function(f){return f.role==='archive';});
    var html=heading(1)+'<details class="details-block"><summary>Выбрать документ из заявки</summary>'+managerFilesHtml(files,true)+'</details><div class="plan-contexts"><button type="button" class="button secondary'+(activePlanId==='main'?' selected':'')+'" data-plan-context="main">Основной план</button>'+state.data.additional_plans.map(function(plan,i){return '<button type="button" class="button secondary'+(activePlanId===plan.id?' selected':'')+'" data-plan-context="'+esc(plan.id)+'">Доп. лист '+(i+1)+'</button>';}).join('')+'<button type="button" class="button secondary" data-add-plan>+ Ещё лист</button></div>'+(activePlanId!=='main'?'<button type="button" class="text-button" data-remove-plan>Убрать дополнительный лист</button>':'')+'<div class="plan-editor-shell" id="plan-editor"></div>';
    html+='<section class="capture-section"><h3>Помещение по факту</h3><div class="fields">'+input('Этаж на плане','inspection.floor_plan',{maxlength:100})+input('Фактический этаж','inspection.floor_actual',{maxlength:100})+input('Количество кадастров','inspection.cadastral_count',{type:'number',step:'1',maxlength:2})+'</div>'+choices('inspection.within_cadastral','Внешние границы помещения',[['Да','Соблюдены'],['Нет','Нарушены']])+'<div data-cadastral-boundary'+(Number(p.cadastral_count)>1?'':' hidden')+'>'+choices('inspection.inter_cadastral_boundary','Граница между кадастрами',[['Сохранена','Сохранена'],['Объединены','Объединены']])+'</div>'+choices('inspection.rooms_complete','Вся площадь по плану входит в объект',[['Да','Входит целиком'],['Нет','Часть не входит']])+'<p class="field-note">«Часть не входит» — часть площади отрезана или занята соседями. Если убрана только внутренняя перегородка, отметьте это ниже как изменение планировки.</p>'+choices('to','Нужно техническое описание (ТО)',[['Нужно','Да'],['Не нужно','Нет']])+choices('bti','Планировка по выбранному плану',[['Да','Совпадает'],['Нет','Есть изменения']])+(state.data.bti==='Нет'?input('Что отличается','inspection.plan_note',{type:'textarea',wide:true,maxlength:2000,placeholder:'Кратко. Перегородки и границы отметьте на плане.'}):'')+'</section>';
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
    if(!marks.length&&(oldEntrances.length||oldZones.length))state.data.legacy_territory=state.data.legacy_territory||{entrances:clone(oldEntrances),zones:clone(oldZones)};
    state.data.entrances=entrances;state.data.zones=zones;
    if(before!==JSON.stringify([entrances,zones])){var host=$('#territory-evidence');if(host){host.innerHTML=territoryCards();bind(host);loadThumbnails(host);}}
  }

  function hasEvidenceImage(role,subject){return evidenceFor(role,subject).some(function(e){return /^image\//.test(e.mime||e.mime_type||'');});}
  function validDistance(value){return /^\d{1,6}(?:[.,]\d{1,2})?$/.test(value)&&Number(String(value).replace(',','.'))>0;}
  function territoryIssues(add,requiredOnly){
    var result=state.data.workflow.territory_result,mode=mapMode(),map=state.data.map;
    if(!result){if(!state.frozen)add('territory','Выберите результат проверки территории',0);return;}
    if(result==='findings'){
      if(!mode){add('map-mode','Выберите, как оформить схему территории',0);return;}
      if(mode==='attached'){
        var attached=evidenceFor('map','attached').find(function(e){return String(e.id)===String(map.evidence_id)&&MAP_IMAGE_TYPES.includes(e.mime||e.mime_type);});
        if(!attached)add('map','Приложите готовую схему в JPG или PNG',0);
      }else if(!map.evidence_id||!map.annotations.length||map.pending&&map.pending.points.length)add('map','Сохраните разметку на скриншоте карты',0);
      if(!state.data.zones.length)add('organizations','Добавьте хотя бы одну проверенную организацию или спорное место',0);
    }
    if(!state.data.entrances.length)add('entrances',mode==='draw'?'Отметьте входы на схеме':'Добавьте карточку входа',0);
    state.data.entrances.forEach(function(e){
      if(!String(e.label||'').trim())add('entrance-name-'+e.id,'Укажите название входа',0);
      if(!hasEvidenceImage('entrance',e.id))add('photo-'+e.id,(e.label||'Вход')+': добавьте фото',0);
      if(!requiredOnly&&['Нет доступа','Не осмотрен'].includes(e.access))add('entrance-'+e.id,(e.label||'Вход')+': осмотр не завершён',0);
    });
    if(result==='clear')return;
    var marks=mode==='draw'?map.annotations:[],measurements=marks.filter(function(m){return ['route','straight'].includes(m.tool);});
    state.data.zones.forEach(function(z){
      var name=z.name||'Организация',drawn=measurements.some(function(m){return m.toObjectId===z.id;});
      if(!String(z.name||'').trim())add('name-'+z.id,'Укажите название проверенной организации',0);
      if(!hasEvidenceImage('zone',z.id))add('photo-'+z.id,name+': добавьте фото',0);
      if(!ZONE_STATUS[z.status])add('zone-status-'+z.id,name+': укажите результат проверки',0);
      else if(!requiredOnly&&['pending','disputed','confirmed'].includes(z.status))add('zone-'+z.id,name+': '+(z.status==='confirmed'?'есть ограничение':'нужно уточнить'),0);
      if(z.status==='licensed'&&!String(z.source||'').trim())add('source-'+z.id,name+': укажите источник лицензии',0);
      if(z.status==='confirmed'&&![z.source,z.resolution,z.note].some(function(v){return String(v||'').trim();}))add('resolution-'+z.id,name+': укажите основание ограничения',0);
      if(!drawn){
        if(!state.data.entrances.some(function(e){return e.id===z.entrance_id;}))add('measure-entrance-'+z.id,name+': '+(mode==='draw'?'свяжите замер с входом на схеме':'выберите вход для замера'),0);
        if(z.dist==='Не проверено'){if(!requiredOnly)add('measure-distance-'+z.id,name+': расстояние не проверено',0);}
        else if(!validDistance(z.dist))add('measure-distance-'+z.id,name+': '+(mode==='draw'?'укажите расстояние на схеме':'укажите расстояние или «Не проверено»'),0);
      }
    });
    measurements.forEach(function(m){if(!validDistance(m.distance)||!state.data.entrances.some(function(e){return e.id===m.fromEntranceId;})||!state.data.zones.some(function(z){return z.id===m.toObjectId;}))add('measure-'+m.id,'Замер '+(m.code||'')+': укажите расстояние и точки',0);});
  }

  function issues(){
    var out=[],p=state.data.inspection,packet=state.packet||{};function add(key,title,view,detail){out.push({key:key,title:title,detail:detail||'',step:view});}
    if(!p.org||!p.address||(state.data.object_category!=='tobacco'&&!p.service))add('packet','Менеджеру нужно дополнить заявку',0);
    if(!state.data.building_type)add('building','Выберите: жилое или нежилое здание',0);
    territoryIssues(add,false);
    [['floor_plan','Этаж на плане'],['floor_actual','Фактический этаж'],['cadastral_count','Количество кадастров'],['rooms_complete','Входит ли вся площадь по плану в объект'],['within_cadastral','Границы помещения'],['kkt_count','Количество касс'],['kkt_ip','Наличие кассы ИП']].forEach(function(pair){if(!p[pair[0]])add(pair[0],'Укажите: '+pair[1].toLowerCase(),1);});
    if(p.cadastral_count&&!/^[1-9]\d?$/.test(p.cadastral_count))add('cadastral_count','Количество кадастров: целое число от 1 до 99',1);
    if(p.floor_plan&&p.floor_actual&&String(p.floor_plan).trim().toLowerCase().replace(/этаж/g,'').replace(/\s+/g,' ').trim()!==String(p.floor_actual).trim().toLowerCase().replace(/этаж/g,'').replace(/\s+/g,' ').trim())add('floor-mismatch','Этаж на плане и фактический этаж отличаются',1);
    if(isRenewal()&&state.data.workflow.archive_skipped!=='Да'){
      if(p.archive_match==='Нет')add('archive-mismatch','Есть расхождения с архивом',1);
      if(!p.archive_match||p.archive_match==='Не проверено')add('archive-unchecked','Сверка с архивом не выполнена',1);
      if(p.licensed_boundaries_match==='Нет')add('licensed-boundaries','Лицензированные границы отличаются от архива',1);
      else if(p.licensed_boundaries_match!=='Да')add('licensed-boundaries-unchecked','Соблюдение лицензированных границ не подтверждено',1);
    }
    if(Number(p.cadastral_count)>1&&!p.inter_cadastral_boundary)add('inter','Укажите сохранность границы между кадастрами',1);
    if(Number(p.cadastral_count)>1&&p.inter_cadastral_boundary==='Объединены')add('inter-cadastral','Граница между кадастровыми помещениями убрана',1);
    if(p.rooms_complete==='Нет')add('rooms-incomplete','Не вся площадь по выбранному плану входит в объект',1,'Указано «Часть не входит». Если ответ выбран случайно, исправьте его в разделе «Помещение». Убранная внутренняя перегородка — это изменение планировки.');
    if(p.within_cadastral==='Нет')add('cadastral-boundaries','Указано нарушение внешних границ помещения',1);
    if(!state.data.plan.evidence_id||!state.data.plan.annotations.length)add('plan','Выберите лист и сохраните разметку плана',1);
    else if(state.data.plan.pending&&state.data.plan.pending.points&&state.data.plan.pending.points.length)add('plan','Завершите контур на плане или отмените незавершённые точки',1);
    if(!state.data.to)add('to','Укажите, нужно ли техническое описание (ТО)',1);
    if(!state.data.bti)add('compare','Укажите результат сверки планировки',1);
    if(state.data.bti==='Нет'&&!p.plan_note.trim())add('note','Кратко опишите изменения планировки',1);
    if(state.data.bti==='Нет')add('changes','Планировка отличается от представленного плана',1);
    if(state.data.to==='Нужно')add('technical-description','Требуется техническое описание (ТО)',1);
    if(state.data.object_category==='tobacco'){[['tobacco_display','Выкладка'],['tobacco_price_list','Перечень с ценами'],['tobacco_advertising','Реклама']].forEach(function(pair){if(!p[pair[0]]||p[pair[0]]==='Не проверено')add(pair[0],'Табак: '+pair[1].toLowerCase()+' не проверены',1);});if(p.tobacco_display==='Открытая'||p.tobacco_price_list==='Нет'||p.tobacco_advertising==='Есть')add('tobacco','Есть замечания по торговле табаком',1);}
    else {if(!p.alcohol_present||p.alcohol_present==='Не проверено')add('alcohol','Зафиксируйте наличие алкоголя',1);if(p.service==='Получение'&&p.alcohol_present==='Да')add('alcohol-new','Для получения нужно убрать алкоголь',1);if(isRenewal()&&p.alcohol_present==='Да'&&p.alcohol_within_licensed!=='Да')add('alcohol-zone','Размещение алкоголя требует проверки',1);}
    if(isRenewal()&&state.data.workflow.archive_skipped==='Да')add('archive-skip','Архивная сверка не выполнена',0);else if(isRenewal()&&!packetFiles().concat(state.evidence).some(function(f){return f.role==='archive';}))add('archive','Добавьте графику архива или пропустите архив',0);
    if((packet.video_required||packet.has_video)&&(!state.data.workflow.video_url||p.video_status!=='Сделано'))add('video','Добавьте ссылку на видео из задания',2);
    return out;
  }

  function requiredIssues(tasks) {
    var keys=['packet','building','floor_plan','floor_actual','cadastral_count','rooms_complete','within_cadastral','kkt_count','kkt_ip','inter','plan','to','compare','note','archive'];
    var required=tasks.filter(function(task){return keys.includes(task.key);});
    territoryIssues(function(key,title,view){if(!required.some(function(task){return task.key===key;}))required.push({key:key,title:title,step:view});},true);
    var p=state.data.inspection;
    if(!p.alcohol_present&&state.data.object_category!=='tobacco')required=required.concat(tasks.filter(function(task){return task.key==='alcohol';}));
    if(state.data.object_category==='tobacco')required=required.concat(tasks.filter(function(task){return /^tobacco_/.test(task.key)&&!p[task.key];}));
    var video=state.data.workflow.video_url||'';
    if(video){try{if(new URL(video).protocol!=='https:')throw new Error();}catch(e){required.push({key:'video-url',title:'Укажите полную HTTPS-ссылку на видео',step:2});}}
    else if(state.packet&&(state.packet.video_required||state.packet.has_video))required=required.concat(tasks.filter(function(task){return task.key==='video';}));
    return required;
  }
  function tasksHtml(tasks) { return '<div class="task-list">' + tasks.map(function (t) { return '<div class="task"><div class="task-main"><p>' + esc(t.title) + '</p>' + (t.detail ? '<small>' + esc(t.detail) + '</small>' : '') + '</div><button type="button" data-go-step="' + t.step + '">'+(['Территория →','Помещение →','Отчёт →'][t.step]||'Открыть')+'</button></div>'; }).join('') + '</div>'; }
  function offersActions(tasks) {
    var outcome=state.data.workflow.conclusion_status;
    return !state.frozen && tasks.length>0 && !requiredIssues(tasks).length && (!outcome || outcome==='ready');
  }
  function reportFeedback(tasks) {
    if(!tasks.length)return '<section id="report-feedback" hidden></section>';
    var ready=state.data.workflow.conclusion_status==='ready',missing=requiredIssues(tasks).length>0;
    return '<section id="report-feedback" class="report-feedback'+(ready?' report-feedback-warning':'')+'" tabindex="-1" aria-live="polite"><h3>'+(missing?'Дополните обязательные сведения':ready?'Итог «Соответствует» расходится с ответами':'Что требует внимания')+'</h3><p>'+(missing?'Откройте указанный раздел и заполните недостающие сведения.':ready?'Если ответы верны, выберите итог с замечаниями. Если ответ выбран случайно — исправьте его в нужном разделе.':'Эти сведения останутся в отчёте вместе с выбранным итогом.')+'</p>'+tasksHtml(tasks)+(ready&&!missing&&!state.frozen?'<div class="report-feedback-actions"><button type="button" class="button secondary" data-conclusion-choice="actions">Выбрать: Нужны действия</button><button type="button" class="button secondary" data-conclusion-choice="insufficient">Выбрать: Нужно уточнить</button></div>':'')+'</section>';
  }
  function bindReportFeedback(scope) {
    scope.querySelectorAll('[data-conclusion-choice]').forEach(function(button){button.onclick=function(){chooseConclusion(button.dataset.conclusionChoice);};});
    scope.querySelectorAll('[data-go-step]').forEach(function(button){button.onclick=function(){go(Number(button.dataset.goStep));};});
  }
  function refreshReportFeedback() {
    var area=$('#report-feedback');if(!area)return;
    var tasks=issues();
    area.outerHTML=reportFeedback(tasks);var next=$('#report-feedback');if(next)bindReportFeedback(next);
    if(state.frozen)return;
    var button=$('#submit-audit'),hint=$('#submit-outcome'),actions=offersActions(tasks);
    if(button)button.textContent=actions?'Отправить с замечаниями':'Отправить отчёт';
    if(hint)hint.hidden=!actions;
  }
  function setOutcome(value) {
    var previous=state.data.workflow.conclusion_status;
    if(value!==previous&&state.data.conclusion===OUTCOME_LABELS[previous]){
      state.data.conclusion='';
      var input=root.querySelector('[data-bind="conclusion"]');if(input)input.value='';
    }
    state.data.workflow.conclusion_status=value;
  }
  function chooseConclusion(value) {
    if(state.submitting||state.frozen||!['actions','insufficient'].includes(value))return;
    setOutcome(value);changed();
    var select=root.querySelector('[data-bind="workflow.conclusion_status"]');if(select)select.value=value;
    var preview=root.querySelector('.report-preview');if(preview)preview.outerHTML=reportPreview();
    refreshReportFeedback();
  }
  function showReportIssues() {
    refreshReportFeedback();var area=$('#report-feedback');if(!area)return;
    if(typeof area.scrollIntoView==='function')area.scrollIntoView({block:'center',behavior:'auto'});
    if(typeof area.focus==='function')area.focus({preventScroll:true});
  }
  function reportStep(){
    var tasks=issues(),actions=offersActions(tasks);
    return heading(2)+'<div class="fields">'+select('Результат','workflow.conclusion_status',[{value:'ready',label:'Соответствует по проверенным пунктам'},{value:'actions',label:'Нужны действия'},{value:'insufficient',label:'Нужно уточнить'},{value:'obstacle',label:'Есть препятствие'}],'',true)+input('Комментарий аудитора · необязательно','conclusion',{type:'textarea',wide:true,maxlength:6000})+input('Клиент сообщил / договорённости','workflow.followup_notes',{type:'textarea',wide:true,maxlength:2000})+input((state.packet&&(state.packet.video_required||state.packet.has_video))?'Видео в Яндекс Диске':'Видео · необязательно','workflow.video_url',{type:'url',maxlength:2000,placeholder:'https://disk.yandex.ru/d/…'})+(state.data.workflow.video_url?select('Доступность видео','inspection.video_status',['Сделано','Снято — загрузить позже','Не сделано','Не проверено']):'')+input('Дата осмотра','inspection.visit_date',{type:'date'})+'</div>'+reportPreview()+reportFeedback(tasks)+
      '<p class="field-note" id="submit-outcome"'+(actions?'':' hidden')+'>Итог будет «Нужны действия». Ответы и комментарий сохранятся.</p>'+
      '<button type="button" class="button primary full" id="submit-audit" aria-describedby="submit-outcome">'+(actions?'Отправить с замечаниями':'Отправить отчёт')+'</button><p class="field-note" id="submit-status" role="status" aria-live="polite"></p>';
  }
  function reportPreview(){
    var p=state.data.inspection,result=state.data.workflow.territory_result,rows=[['Здание',state.data.building_type],['Этаж','план: '+(p.floor_plan||'—')+' · факт: '+(p.floor_actual||'—')],['Кадастры',(p.cadastral_count||'—')+(Number(p.cadastral_count)>1?' · '+(p.inter_cadastral_boundary||'—'):'')],['Границы',p.within_cadastral],['Вся площадь по плану',p.rooms_complete],['ТО',state.data.to],['Кассы',(p.kkt_count||'—')+' · касса ИП: '+(p.kkt_ip||'—')]];
    if(state.data.object_category!=='tobacco')rows.push(['Алкоголь',p.alcohol_present]);else rows.push(['Табак',[p.tobacco_display,p.tobacco_price_list,p.tobacco_advertising].filter(Boolean).join(' · ')]);
    if(result)rows.push(['Территория',result==='clear'?'Зоны и спорные объекты не выявлены':'Проверено организаций и спорных мест — '+state.data.zones.length],['Входы',state.data.entrances.length]);
    var scheme=result==='findings'||state.frozen&&!result?'схема, ':'';
    return '<section class="report-preview"><h3>Сообщение юристу</h3><p><strong>'+esc(p.address)+'</strong><br>'+esc(p.service)+' · '+esc(({catering:'Алкоголь · общепит',retail:'Алкоголь · магазин',tobacco:'Табак'})[state.data.object_category]||'')+'</p><dl class="report-facts">'+rows.map(function(r){return '<div><dt>'+esc(r[0])+'</dt><dd>'+esc(r[1]||'—')+'</dd></div>';}).join('')+'</dl>'+(state.data.workflow.conclusion_status?'<p><strong>Результат:</strong> '+esc(({ready:'Соответствует по проверенным пунктам',actions:'Нужны действия',insufficient:'Нужно уточнить',obstacle:'Есть препятствие'})[state.data.workflow.conclusion_status])+'</p>':'')+(state.data.conclusion?'<p>'+esc(state.data.conclusion)+'</p>':'')+(p.plan_note?'<p><strong>Изменения:</strong> '+esc(p.plan_note)+'</p>':'')+(state.data.workflow.archive_skipped==='Да'?'<p class="warning">Архив не предоставлен. Сверка с архивом не выполнена.</p>':'')+'<p class="field-note">К сообщению прилагаются '+scheme+'размеченные планы, фотографии, оригиналы выезда и ссылка на документы заявки.</p></section>';
  }

  function normalizeLayout(){if(!state.frozen){state.data.ui_version=5;state.data.inspection.region='МСК';state.data.map=state.data.map||{evidence_id:'',page:1,annotations:[]};state.data.additional_plans=state.data.additional_plans||[];}}

  function renderPacketUpdate() {
    if(!state.pendingPacket||state.frozen)return;
    var previous=state.data.request_packet||state.packet||{},next=state.pendingPacket;
    var labels={org:'Организация',address:'Адрес',service:'Услуга',object_category:'Тип объекта',cad_num:'Кадастровый номер'};
    var categories={catering:'Алкоголь · общепит',retail:'Алкоголь · магазин',tobacco:'Табак',other:'Другой объект'};
    var changes=Object.keys(labels).filter(function(key){return String(previous[key]||'').trim()!==String(next[key]||'').trim();}).map(function(key){
      var oldValue=key==='object_category'?categories[previous[key]]:previous[key],newValue=key==='object_category'?categories[next[key]]:next[key];
      return '<p><strong>'+labels[key]+'</strong> · '+esc(oldValue||'Не указано')+' → '+esc(newValue||'Не указано')+'</p>';
    }).join('');
    if(String(previous.zones_info||'').trim()!==String(next.zones_info||'').trim())changes+='<p><strong>Задание менеджера изменилось.</strong></p><details><summary>Посмотреть новое задание</summary><p>'+esc(next.zones_info||'Комментарий убран')+'</p></details>';
    if(String(previous.archive_url||'').trim()!==String(next.archive_url||'').trim()){
      var archiveHref='';try{var archiveUrl=new URL(next.archive_url);if(archiveUrl.protocol==='https:'&&!archiveUrl.username&&!archiveUrl.password)archiveHref=archiveUrl.href;}catch(_){}
      changes+='<p><strong>Изменилась ссылка на архив объекта.</strong> '+(archiveHref?'<a class="inline-link" target="_blank" rel="noopener" href="'+esc(archiveHref)+'">Открыть обновлённый архив ↗</a>':next.archive_url?'Ссылка некорректна. Менеджеру нужно проверить архив.':'Ссылка убрана из заявки.')+'</p>';
    }
    if(sameData(packetIdentity(previous),packetIdentity(next))===false&&JSON.stringify(packetIdentity(previous).materials)!==JSON.stringify(packetIdentity(next).materials))changes+='<p><strong>Комплект документов изменился.</strong> Сверьте свежий план и другие новые материалы.</p>';
    if(!!(previous.video_required||previous.has_video)!==!!(next.video_required||next.has_video))changes+='<p><strong>Видео осмотра:</strong> '+(next.video_required||next.has_video?'теперь требуется':'менеджер больше не запрашивает')+'</p>';
    var noticeBox=$('#app-notice');noticeBox.hidden=false;
    var files=Array.isArray(next.materials)?next.materials:[];
    noticeBox.innerHTML='<strong>Менеджер изменил данные объекта</strong><p>В черновике сохранены прежние сведения и материалы. Перед отправкой сверьте их с обновлённой заявкой.</p>'+changes+
      (files.length||next.egrn_links&&next.egrn_links.length?'<details><summary>Документы обновлённой заявки</summary>'+managerFilesHtml(files,false)+largeEgrnFilesHtml(next)+'</details>':'')+
      '<button type="button" class="button secondary" id="accept-packet-update">Объект и материалы сверены</button>';
    noticeBox.querySelectorAll('[data-download-material]').forEach(function(button){button.onclick=function(){var file=files.find(function(item){return String(item.id)===button.dataset.downloadMaterial;});if(file)downloadResource(file.url,file.name);};});
    noticeBox.querySelectorAll('[data-open-egrn]').forEach(function(button){button.onclick=function(){openLargeEgrn(button.dataset.openEgrn,button);};});
    $('#accept-packet-update').onclick=acceptPacketUpdate;
  }
  async function acceptPacketUpdate() {
    if(!state.pendingPacket||state.frozen||state.submitting||state.conflict||state.blocked||state.needsRestore)return;
    if(!window.confirm('Вы сверили объект, выбранный план, фотографии и схему с обновлённой заявкой? Подтвердите только если материалы относятся к этому объекту.'))return;
    var previous=state.data.request_packet||state.packet||{},next=state.pendingPacket;
    if(next.object_category==='other'){window.location.replace('/audit/legacy'+window.location.search);return;}
    var history=state.data.packet_rechecks||[];
    state.data.packet_rechecks=history.concat([{checked_at:new Date().toISOString(),previous:packetIdentity(previous),current:packetIdentity(next)}]).slice(-10);
    applyPacket(next);state.pendingPacket=null;state.packetError='';notice('');changed();render();
    try{await saveNow();notify('Обновлённые данные заявки сохранены после сверки.');}catch(error){notify(error.message);}
  }
  function render() {
    if (editor) { try { editor.destroy(); } catch (e) {} editor = null; }
    fieldId = 0;
    var index = step(); root.innerHTML = [outsideStep, insideStep, reportStep][index](); root.setAttribute('aria-busy', 'false');
    bind(); refreshChrome(); renderPacketUpdate(); loadThumbnails(); if(index===0||index===1)mountEditor(); freezeControls();
  }
  function mountEditor(){
    var kind=step()===0?'map':'plan',mountedPlanId=activePlanId,container=$(kind==='map'?'#map-editor':'#plan-editor');if(!container)return;
    function mountedPlan(){return kind==='map'?state.data.map:mountedPlanId==='main'?state.data.plan:state.data.additional_plans.find(function(p){return p.id===mountedPlanId;});}
    function acceptSnapshot(plan) {
      if(kind==='map')plan=Object.assign({},plan,{mode:'draw'});
      if(state.frozen||state.blocked||!mountedPlan())return false;
      if(sameData(mountedPlan(),plan))return true;
      if(kind==='map'){state.data.map=plan;syncMapCards();}else if(mountedPlanId==='main')state.data.plan=plan;else{var i=state.data.additional_plans.findIndex(function(p){return p.id===mountedPlanId;});if(i<0)return false;state.data.additional_plans[i]=Object.assign({},plan,{id:mountedPlanId});}
      if(!state.data.inspection.visit_date)state.data.inspection.visit_date=localDate();changed();return true;
    }
    if(window.AuditPlanEditor&&typeof window.AuditPlanEditor.mount==='function'){try{editor=window.AuditPlanEditor.mount(container,{kind:kind,service:state.data.object_category==='tobacco'?'tobacco':'alcohol',getState:mountedPlan,onSnapshot:acceptSnapshot,onChange:function(){
      if(state.frozen||state.blocked||!mountedPlan())return false;
      return (state.dirty||state.serverError)?saveNow():undefined;
    },evidenceUrl:evidenceUrl,evidence:state.evidence,onUpload:function(file,meta){return uploadEditorSource(file,meta.role);}});}catch(error){container.textContent='Не удалось открыть редактор. Оригинал можно скачать выше.';}}
  }

  function refreshChrome() {
    var index = step(); $('#steps').innerHTML = STEPS.map(function (s, i) { return '<button type="button" class="step-button" data-step="' + i + '"' + (i === index ? ' aria-current="step"' : '') + ' aria-label="' + esc(s[0]) + '"><span>' + (i + 1) + '</span><span>' + esc(s[0]) + '</span></button>'; }).join('');
    $('#steps').querySelectorAll('[data-step]').forEach(function (b) { b.onclick = function () { go(Number(b.dataset.step)); }; });
    $('#object-title').textContent = state.data.inspection.org || 'Данные из заявки менеджера'; $('#step-counter').textContent = (index + 1) + ' из 3'; $('#previous-step').disabled = index === 0 || state.submitting; $('#next-step').textContent = index === 2 ? 'К осмотру' : 'Далее →'; $('#next-step').disabled = state.submitting; $('#save-now').disabled = state.submitting || state.frozen || state.conflict;
  }
  async function go(index) { if (state.submitting||state.blocked||!orderId||!state.loaded) return;try{if(editor&&editor.flush)await editor.flush();}catch(error){notify(error.message);return;} var next = Math.max(0, Math.min(2, index)); if (state.frozen) state.viewStep = next; else { state.data.workflow.step = next; changed(); } render(); window.scrollTo({ top: 0, behavior: 'auto' }); }
  function sanitizeService() { if (!isRenewal()) { state.data.inspection.archive_available = ''; state.data.inspection.archive_match = ''; state.data.inspection.archive_url = ''; state.data.inspection.licensed_boundaries_match = ''; state.data.inspection.alcohol_within_licensed = ''; } else if (state.data.inspection.alcohol_present === 'Нет') state.data.inspection.alcohol_within_licensed = ''; }
  function bind(scope) {
    var bindRoot=scope||root;
    bindRoot.querySelectorAll('[data-bind]').forEach(function(control){
      var path=control.dataset.bind,rebuild=['inspection.alcohol_present','bti','workflow.video_url'].includes(path);
      function capture(){if(state.submitting||state.frozen||state.blocked)return;var value=control.type==='checkbox'?control.checked:control.value;
        if(path==='workflow.conclusion_status')setOutcome(value);else set(path,value);
        if(path==='inspection.cadastral_count'){
          var boundary=root.querySelector('[data-cadastral-boundary]');
          if(boundary)boundary.hidden=!(Number(control.value)>1);
        }
        changed();var preview=root.querySelector('.report-preview');if(step()===2&&preview)preview.outerHTML=reportPreview();if(step()===2&&root.querySelector('#report-feedback'))refreshReportFeedback();}
      async function rebuildAfterChange(){if(!rebuild||state.submitting||state.frozen)return;try{if(editor&&editor.flush)await editor.flush();sanitizeService();render();}catch(error){notify(error.message);}}
      control.addEventListener(control.tagName==='SELECT'||control.type==='checkbox'?'change':'input',capture);
      if(rebuild)control.addEventListener('change',rebuildAfterChange);
    });
    bindRoot.querySelectorAll('[data-go-step]').forEach(function (b) { b.onclick = function () { go(Number(b.dataset.goStep)); }; });
    bindRoot.querySelectorAll('[data-conclusion-choice]').forEach(function (button) { button.onclick=function(){chooseConclusion(button.dataset.conclusionChoice);}; });
    bindRoot.querySelectorAll('[data-upload-role]').forEach(function (control) { control.onchange = function () { var files = Array.from(control.files || []); uploadFiles(files, control.dataset.uploadRole, control.dataset.uploadSubject).catch(function (error) { notify(error.message); }).finally(function () { control.value = ''; }); }; });
    bindRoot.querySelectorAll('[data-territory-upload]').forEach(function(control){control.onchange=function(){var file=(control.files||[])[0];if(file)uploadTerritoryImage(file,control.dataset.territoryUpload).catch(function(error){notify(error.message);}).finally(function(){control.value='';});};});
    bindRoot.querySelectorAll('[data-open-evidence]').forEach(function (b) { b.onclick = function () { openEvidence(b.dataset.openEvidence); }; });
    bindRoot.querySelectorAll('[data-delete-evidence]').forEach(function (b) { b.onclick = function () { deleteEvidence(b.dataset.deleteEvidence); }; });
    bindRoot.querySelectorAll('[data-open-egrn]').forEach(function(button){button.onclick=function(){openLargeEgrn(button.dataset.openEgrn,button);};});
    bindRoot.querySelectorAll('[data-download-material]').forEach(function (b) { b.onclick = function () { var file = packetFiles().find(function (f) { return String(f.id) === b.dataset.downloadMaterial; }); if (file) downloadResource(file.url, file.name); }; });
    bindRoot.querySelectorAll('[data-use-plan]').forEach(function (b) { b.onclick = function () { useManagerPlan(b.dataset.usePlan); }; });
    bindRoot.querySelectorAll('[data-choice]').forEach(function(button){button.onclick=async function(){
      if(state.submitting||state.frozen)return;
      var path=button.dataset.choice,value=button.dataset.value;
      if(['workflow.territory_result','map.mode'].includes(path)&&state.pendingUploads){notify('Дождитесь загрузки выбранных файлов.');return;}
      try{
        if(editor&&editor.flush)await editor.flush();
        if(path==='workflow.territory_result')chooseTerritory(value);
        else if(path==='map.mode')switchTerritoryMode(value);
        else set(path,value);
        changed();render();
      }catch(error){notify(error.message);}
    };});
    bindRoot.querySelectorAll('[data-plan-context]').forEach(function(button){button.onclick=async function(){try{if(editor&&editor.flush)await editor.flush();activePlanId=button.dataset.planContext;render();}catch(error){notify(error.message);}};});
    var extraButton=bindRoot.querySelector('[data-add-plan]');if(extraButton)extraButton.onclick=async function(){try{if(editor&&editor.flush)await editor.flush();var extra={id:id('extra'),evidence_id:'',page:1,annotations:[]};state.data.additional_plans.push(extra);activePlanId=extra.id;changed();render();}catch(error){notify(error.message);}};
    var removePlan=bindRoot.querySelector('[data-remove-plan]');if(removePlan)removePlan.onclick=async function(){try{if(editor&&editor.flush)await editor.flush();}catch(error){notify(error.message);return;}state.data.retired_plans=state.data.retired_plans||[];state.data.retired_plans.push(clone(currentPlan()));state.data.additional_plans=state.data.additional_plans.filter(function(p){return p.id!==activePlanId;});activePlanId='main';changed();render();};
    var skip=bindRoot.querySelector('[data-skip-archive]');if(skip)skip.onclick=function(){state.data.workflow.archive_skipped=state.data.workflow.archive_skipped==='Да'?'':'Да';changed();render();};
    var route=bindRoot.querySelector('[data-route]');if(route)route.onclick=function(event){event.preventDefault();showRoute();};
    var call=bindRoot.querySelector('[data-call]');if(call)bindPhoneAction(call,packetPhone(),showContact);
    bindRoot.querySelectorAll('[data-contact]').forEach(function(button){button.onclick=showContact;});
    var b = $('[data-download-materials]'); if (b) b.onclick = function () { downloadResource(state.packet.materials_download_url || '/api/audit/orders/' + encodeURIComponent(orderId) + '/materials/download-all', 'Документы-заявки-' + orderId + '.zip'); };
    b = $('[data-download-archive]'); if (b) b.onclick = function () { var attached=packetFiles().some(function(file){return file.role==='archive';});var url=state.packet.archive_download_url||(attached?'/api/audit/orders/'+encodeURIComponent(orderId)+'/materials/download-all?role=archive':'/api/audit/orders/'+encodeURIComponent(orderId)+'/archive/download');downloadResource(url,'Архив-заявки-'+orderId+'.zip'); };
    b = $('[data-copy-address]'); if (b) b.onclick = function () { copyText(state.data.inspection.address, 'Адрес скопирован'); };
    b = $('[data-copy-archive]'); if (b) b.onclick = function () { copyText(state.packet.archive_url, 'Ссылка на архив скопирована'); };
    b = bindRoot.querySelector('[data-add-entrance]'); if (b) b.onclick = function () {
      var n=state.data.entrances.length;
      if(n>=30){notify('Можно добавить до 30 входов.');return;}
      var number=n+1;while(state.data.entrances.some(function(e){return e.label==='Вход '+number;}))number++;
      state.data.entrances.push({id:id('entrance'),label:'Вход '+number,kind:'',location:'',facing:'',access:'',notes:''});
      if(!state.data.inspection.visit_date)state.data.inspection.visit_date=localDate();
      changed();render();$('[data-entrance-title="'+n+'"]').focus();
    };
    b = bindRoot.querySelector('[data-add-zone]'); if (b) b.onclick = function () {
      var n=state.data.zones.length;
      if(n>=20){notify('Можно добавить до 20 организаций.');return;}
      state.data.zones.push({id:id('zone'),name:'',type:'',status:'',entrance_id:state.data.entrances.length===1?state.data.entrances[0].id:'',dist:'',method:'',points:'',license:'',source:'',info:'',resolution:''});
      changed();render();$('[data-bind="zones.'+n+'.name"]').focus();
    };
    bindRoot.querySelectorAll('[data-remove-entrance]').forEach(function(button){button.onclick=function(){
      var eid=button.dataset.removeEntrance,linked=state.data.zones.filter(function(z){return z.entrance_id===eid;});
      if((linked.length||evidenceFor('entrance',eid).length)&&!window.confirm(linked.length?'Убрать вход с фото? Для связанных замеров нужно выбрать другой вход.':'Убрать вход и его фото из отчёта?'))return;
      state.data.entrances=state.data.entrances.filter(function(e){return e.id!==eid;});
      linked.forEach(function(z){z.entrance_id='';z.dist='';});changed();render();
    };});
    bindRoot.querySelectorAll('[data-remove-zone]').forEach(function(button){button.onclick=function(){
      var zid=button.dataset.removeZone;
      if(evidenceFor('zone',zid).length&&!window.confirm('Убрать карточку организации и её фото из отчёта?'))return;
      state.data.zones=state.data.zones.filter(function(z){return z.id!==zid;});changed();render();
    };});
    b = $('#submit-audit'); if (b) b.onclick = function(){return submit(!state.frozen&&offersActions(issues())?'actions':'');};
  }
  function openExternal(url){return actions.openExternal(url,tg,function(href,target){return window.open(href,target);},window);}
  function opensMapAddress(){return !!(tg&&tg.platform==='ios'&&actions.hasTelegramBridge(window));}
  function mapAddress(){return String(((state.packet||state.data.request_packet||{}).address)||state.data.inspection.address||'');}
  function routeActionUrl(){return opensMapAddress()?actions.searchUrl(mapAddress()):actions.routeUrl(mapAddress());}
  function showRoute(){
    if(opensMapAddress()){
      var url=routeActionUrl();if(!url){notify('В заявке не указан адрес объекта.');return;}
      saveBeforePhone();if(openExternal(url)===false)notify('Карты не открылись. Повторите нажатие.');return;
    }
    localSave();
    if(!window.AuditRoute){notify('Не удалось открыть выбор маршрута. Закройте и откройте форму заново.');return;}
    window.AuditRoute.open({address:mapAddress(),actions:actions,telegram:actions.hasTelegramBridge(window)?tg:null,openExternal:openExternal,onBeforeLeave:function(){localSave();saveNow().catch(function(){});}});
  }
  function showContact(){
    var phone=packetPhone();if(!phone){notify('Телефон не указан в заявке.');return;}
    saveBeforePhone();
    var dialog=document.getElementById('contact-dialog');if(dialog&&dialog.open)return;if(dialog)dialog.remove();
    dialog=document.createElement('dialog');dialog.id='contact-dialog';dialog.className='contact-dialog';dialog.setAttribute('aria-labelledby','contact-title');
    dialog.innerHTML='<div class="contact-heading"><h2 id="contact-title">Контакт для выезда</h2><button type="button" class="button secondary" data-close-contact aria-label="Закрыть контакт">Закрыть</button></div><p class="contact-description">'+esc(packetContactText((state.packet||state.data.request_packet||{}).contacts))+'</p><input class="contact-number" type="tel" aria-label="Номер телефона" readonly value="'+esc(phone)+'"><div class="contact-actions"><a class="button primary" data-dial target="_blank" rel="noopener" href="'+esc(phoneActionUrl(phone))+'">Набрать номер ↗</a><button type="button" class="button secondary" data-copy-phone>Скопировать номер</button></div><p class="field-note" data-contact-status role="status">Окно звонка откроется отдельно. Чтобы продолжить отчёт, вернитесь в Telegram.</p>';
    document.body.appendChild(dialog);
    dialog.querySelector('[data-close-contact]').onclick=function(){dialog.close();};
    dialog.addEventListener('click',function(event){if(event.target===dialog)dialog.close();});
    dialog.querySelector('[data-copy-phone]').onclick=async function(){var ok=await copyText(phone,'Номер скопирован');var status=dialog.querySelector('[data-contact-status]');status.textContent=ok?'Номер скопирован. Можно вставить в приложении «Телефон».':'Выделите номер в поле выше и выберите «Копировать».';if(!ok){var input=dialog.querySelector('input');input.focus();input.select();}};
    bindPhoneAction(dialog.querySelector('[data-dial]'),phone,function(){dialog.querySelector('[data-contact-status]').textContent='Окно звонка не открылось. Скопируйте номер кнопкой рядом.';});
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
  async function fetchAuditFile(url, fallback) {
    function unavailable(message) { return Object.assign(new Error(message || fallback), {code:'AUDIT_FILE_RESPONSE'}); }
    try{return await requestWithDeadline(url,{cache:'no-store'},async function(response){
    var type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    var json = /(?:\/|\+)json$/.test(type), html = type === 'text/html' || type === 'application/xhtml+xml';
    var attachment = /^attachment(?:\s*;|$)/i.test(response.headers.get('Content-Disposition') || '');
    if (response.ok && !json && !html && (attachment || /^(image|application)\//.test(type))) {
      var blob;
      try { blob = await response.blob(); } catch (error) { throw unavailable(); }
      if (!blob.size) throw unavailable('Сервер вернул пустой файл. Повторите действие.');
      return {response:response, blob:blob};
    }
    var body = '';
    try { body = await response.text(); } catch (error) {}
    if (response.status === 429 || /checking your browser|turnstile|rate limited/i.test(body)) {
      throw unavailable('Сервис временно ограничил доступ. Повторите действие через минуту.');
    }
    var error;
    if (json) { try { error = JSON.parse(body)?.error; } catch (e) {} }
    throw unavailable(typeof error === 'string' ? error : '');
    },180000);}catch(error){if(error.code==='AUDIT_FILE_RESPONSE')throw error;throw unavailable(error.code==='REQUEST_TIMEOUT'?error.message:'');}
  }
  async function downloadResource(url, filename) {
    if(downloadJobs.has(url)){notify('Файл уже готовится. Дождитесь скачивания.');return;}downloadJobs.add(url);
    try {
      var resolved = new URL(url, location.origin); if (resolved.origin !== location.origin || !resolved.pathname.startsWith('/api/audit/orders/')) throw new Error('Некорректная ссылка документа');
      notify('Подготавливаю файл…'); var result=await fetchAuditFile(resolved.pathname+resolved.search,'Не удалось скачать файл. Проверьте связь.');
      var disposition = result.response.headers.get('Content-Disposition') || '', named = disposition.match(/filename\*=UTF-8''([^;]+)/i); if (named) { try { filename = decodeURIComponent(named[1]); } catch (e) {} }
      var objectUrl = URL.createObjectURL(result.blob), link = document.createElement('a'); link.href = objectUrl; link.download = filename || 'Документ'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000); notify('Файл подготовлен к сохранению. Форма остаётся открытой.');
    } catch (error) { notify(error.message); } finally { downloadJobs.delete(url); }
  }
  async function useManagerPlan(fileId) {
    var targetPlanId = activePlanId;
    var file = packetFiles().find(function(f) { return String(f.id) === String(fileId); });
    if (!file || state.frozen || state.submitting) return;
    queue(async function() {
      try {
        await flush();
        var current = currentPlan(targetPlanId);
        if (!current) return;
        if (String(current.manager_material_id || '') === String(fileId) && state.evidence.some(function(e) { return e.id === current.evidence_id; })) {
          notify('Документ уже открыт. Выберите нужную страницу в редакторе.');
          return;
        }
        var result = await fetchAuditFile(file.url, 'Не удалось получить документ из заявки. Повторите действие.');
        var encoded = await readBase64(result.blob);
        var uploaded = await postEvidence({name:file.name, type:file.mime || result.blob.type}, 'plan-source', 'source', encoded);
        var previous = clone(current);
        delete previous.versions; delete previous.history; delete previous.pending;
        var versions = (current.versions || []).concat(current.evidence_id ? [previous] : []).slice(-20);
        setCurrentPlan({id:current.id, evidence_id:uploaded.id, manager_material_id:fileId, page:1, annotations:[], versions:versions}, targetPlanId);
        state.data.inspection.plan_source = file.role === 'egrn' ? 'ЕГРН' : file.role === 'archive' ? 'Архив' : 'План из заявки';
        state.dirty = true;
        state.version++;
        await flush();
        render();
        notify('Документ открыт. Выберите лист с графикой.');
      } catch (error) { notify(error.message); }
    });
  }
  async function evidenceUrl(eid) {
    var key = String(eid);
    if (blobUrls.has(key)) return blobUrls.get(key);
    if (!state.draft) throw new Error('Сначала сохраните черновик.');
    var path = '/api/audit/drafts/' + encodeURIComponent(state.draft.id) + '/evidence/' + encodeURIComponent(eid);
    var result = await fetchAuditFile(path, 'Не удалось загрузить оригинал файла. Повторите действие.');
    var url = URL.createObjectURL(result.blob);
    blobUrls.set(key, url);
    return url;
  }
  function loadThumbnails(scope){(scope||root).querySelectorAll('[data-evidence-image]').forEach(function(image){evidenceUrl(image.dataset.evidenceImage).then(function(url){if(image.isConnected)image.src=url;}).catch(function(){if(image.isConnected)image.alt='Превью недоступно. Оригинал можно открыть повторно.';});});}
  async function openEvidence(eid){try{var url=await evidenceUrl(eid);var e=state.evidence.find(function(x){return String(x.id)===String(eid);});var link=document.createElement('a');link.href=url;link.download=e&&e.name||'document';document.body.appendChild(link);link.click();link.remove();}catch(error){notify(error.message);}}
  async function readBase64(file) {
    function unreadable() { return new Error('Не удалось открыть «' + (file.name || 'файл') + '». Выберите его заново через «Файлы» → «На устройстве».'); }
    if (!file.size) throw new Error('Файл «' + (file.name || 'без названия') + '» пустой.');
    // Android's picker can return a temporary content-provider file. Capture
    // its bytes in the selection callback, before saving or clearing the input.
    if (typeof file.arrayBuffer === 'function') {
      try {
        var bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length !== file.size) throw unreadable();
        var binary = '';
        for (var offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768));
        return btoa(binary);
      } catch (error) { /* Some WebViews support only the FileReader path. */ }
    }
    return new Promise(function (resolve, reject) {
      var reader;
      try {
        reader = new FileReader();
        reader.onload = function () {
          var result = String(reader.result || ''), comma = result.indexOf(','), data = result.slice(comma + 1);
          var padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
          if (comma < 0 || !/;base64$/i.test(result.slice(0, comma)) || data.length % 4 || data.length / 4 * 3 - padding !== file.size || /[^A-Za-z0-9+/]/.test(data.slice(0, data.length - padding))) { reject(unreadable()); return; }
          resolve(data);
        };
        reader.onerror = reader.onabort = function () { reject(unreadable()); };
        reader.readAsDataURL(file);
      } catch (error) { reject(unreadable()); }
    });
  }
  function fileMime(file, data) {
    var declared = String(file.type || file.mime || '').toLowerCase();
    if (declared === 'image/jpg') return 'image/jpeg';
    if (declared && declared !== 'application/octet-stream') return declared;
    // Some Android providers omit the MIME type even for a valid image or PDF.
    var header = atob(data.slice(0, 12));
    if (header.startsWith('\xff\xd8\xff')) return 'image/jpeg';
    if (header.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
    if (header.startsWith('%PDF-')) return 'application/pdf';
    return '';
  }
  async function evidenceId(file,role,subject,data){var key=[file.name,file.type||file.mime,role,subject||'',data].join('\n');if(window.crypto&&crypto.subtle&&window.TextEncoder){var digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));var hex=Array.from(new Uint8Array(digest)).map(function(n){return n.toString(16).padStart(2,'0');}).join('').slice(0,32);hex=hex.slice(0,12)+'4'+hex.slice(13,16)+'8'+hex.slice(17);return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20,32);}var hash=0;for(var i=0;i<key.length;i++)hash=(Math.imul(31,hash)+key.charCodeAt(i))|0;var short=file.name+':'+role+':'+subject+':'+data.length+':'+hash;if(!uploadIds.has(short))uploadIds.set(short,uuid());return uploadIds.get(short);}
  async function postEvidence(file,role,subject,data,eid){var result=await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:eid||await evidenceId(file,role,subject,data),revision:state.draft.revision,name:file.name,mime:file.type||file.mime,role:role,subject_id:subject||'',data:data})});adoptRevision(result);var evidence=result.evidence;if(evidence&&!Array.isArray(evidence)){state.evidence=state.evidence.filter(function(e){return String(e.id)!==String(evidence.id);});state.evidence.push(evidence);}return evidence;}
  async function uploadFiles(files, role, subject, options) {
    options = options || {}; if (!files.length) return;
    if (state.submitting || state.frozen || state.conflict) { notify('Сначала завершите текущую операцию с черновиком.'); return; }
    var allowed = options.allowedTypes || ['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/avif','image/tiff','image/bmp','application/pdf'];
    var tooLarge = files.find(function (f) { return f.size > 12 * 1024 * 1024; });
    if (tooLarge) throw new Error('Файл ' + tooLarge.name + ' больше 12 МБ.');
    if (state.evidence.length + state.pendingUploads + files.length > 60) throw new Error('В одной проверке можно сохранить до 60 файлов.');
    var total = state.evidence.reduce(function (n, e) { return n + Number(e.size || e.bytes || 0); }, 0) + files.reduce(function (n, f) { return n + f.size; }, 0);
    if (total > 100 * 1024 * 1024) throw new Error('Общий объём файлов проверки больше 100 МБ.');
    state.pendingUploads += files.length; status('Читаю выбранные файлы…');
    // Start every read now, not after the network queue. Observe rejections now
    // as well: a failed picker read must not become an unhandled rejection.
    var prepared = Promise.all(options.preparedData || files.map(readBase64)).then(function (data) { return { data: data }; }, function (error) { return { error: error }; });
    return queue(async function () {
      var saved = [], remaining = files.length;
      try {
        var captured = await prepared; if (captured.error) throw captured.error;
        var originals = files.map(function (file, index) {
          var type = fileMime(file, captured.data[index]);
          if (!allowed.includes(type)) throw new Error('Формат файла «' + file.name + '» не поддерживается. ' + (options.allowedTypes ? 'Выберите JPG или PNG.' : 'Выберите изображение или PDF.'));
          return type === file.type ? file : { name: file.name, size: file.size, type: type };
        });
        await flush();
        for (var i = 0; i < files.length; i++) {
          status('Загружаю оригинал ' + (i + 1) + ' из ' + files.length + '…');
          saved.push(await postEvidence(originals[i], role, subject, captured.data[i]));
          state.pendingUploads--; remaining--; localSave();
        }
        status('Оригиналы сохранены на сервере · ' + timeLabel(), 'success'); if (!options.noRender) render(); return saved;
      } catch (error) {
        state.pendingUploads = Math.max(0, state.pendingUploads - remaining);
        status('Файлы сохранены не полностью' + (saved.length ? ' · сохранено ' + saved.length + ' из ' + files.length : '') + ' · ' + error.message, 'warning');
        if (error.status === 409) { state.conflict = true; $('#conflict-panel').hidden = false; }
        if (saved.length && !options.noRender) render();
        throw error;
      }
    });
  }
  async function uploadEditorSource(file, role) {
    if (state.submitting || state.frozen || state.conflict) throw new Error('Сначала завершите текущую операцию с черновиком.');
    if (file.size > 12 * 1024 * 1024) throw new Error('Файл ' + file.name + ' больше 12 МБ.');
    state.pendingUploads++; status('Читаю выбранный файл…');
    var data;
    try {
      data = await readBase64(file);
      var type = fileMime(file, data);
      if (type !== file.type) file = { name: file.name, size: file.size, type: type };
      if (file.type === 'application/pdf') {
        var pdfjs = await import('/vendor/pdfjs/pdf.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
        var raw = atob(data), bytes = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        var task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
        try { var pdf = await task.promise; if (!pdf.numPages) throw new Error('В PDF нет страниц.'); }
        catch (error) { throw new Error('Не удалось прочитать PDF. Выберите другой файл.'); }
        finally { await task.destroy(); }
      }
    } catch (error) { status('Файл не загружен · ' + error.message, 'warning'); throw error; }
    finally { state.pendingUploads--;updateClosingConfirmation(); }
    var saved = await uploadFiles([file], role, 'source', { noRender: true, preparedData: [data] }); return saved && saved[0];
  }
  async function uploadTerritoryImage(file,mode){
    if(state.pendingUploads){notify('Дождитесь загрузки выбранных файлов.');return;}
    var map=state.data.map,draw=mode==='draw';
    if(state.data.workflow.territory_result!=='findings'||mapMode()!==mode)return;
    var saved=await uploadFiles([file],draw?'map-source':'map',draw?'source':'attached',{noRender:true,allowedTypes:MAP_IMAGE_TYPES});
    if(!saved||!saved[0]||state.data.map!==map||state.frozen)return;
    if(draw){
      state.data.map=Object.assign({},map,{evidence_id:saved[0].id,page:1,mode:'draw'});
    }else state.data.map=Object.assign({},clone(defaults.map),{mode:'attached',evidence_id:saved[0].id});
    changed();render();
  }
  async function deleteEvidence(eid){
    if(state.submitting||state.frozen||state.conflict)return;
    var evidence=state.evidence.find(function(e){return String(e.id)===String(eid);});
    if(!evidence||!window.confirm('Убрать файл «'+(evidence.name||'документ')+'» из этой проверки?'))return;
    queue(async function(){try{
      await flush();
      var result=await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence/'+encodeURIComponent(eid),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});
      adoptRevision(result);state.evidence=state.evidence.filter(function(e){return String(e.id)!==String(eid);});
      var removedReference=false;
      [state.data.plan,state.data.map].concat(state.data.additional_plans).forEach(function(plan){
        if(String(plan.evidence_id)===String(eid)){plan.evidence_id='';plan.annotations=[];plan.pending=null;delete plan.preview_evidence_id;removedReference=true;}
        else if(String(plan.preview_evidence_id)===String(eid)){delete plan.preview_evidence_id;removedReference=true;}
      });
      if(removedReference){state.dirty=true;state.version++;await flush();}
      if(blobUrls.has(String(eid))){URL.revokeObjectURL(blobUrls.get(String(eid)));blobUrls.delete(String(eid));}
      localSave();render();notify('Файл убран из проверки.');
    }catch(error){if(error.status===409){state.conflict=true;localSave();$('#conflict-panel').hidden=false;}notify(error.message);}});
  }
  async function removeGeneratedEvidence(eid){var result=await request('/api/audit/drafts/'+encodeURIComponent(state.draft.id)+'/evidence/'+encodeURIComponent(eid),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});adoptRevision(result);state.evidence=state.evidence.filter(function(e){return e.id!==eid;});}
  async function exportGraphic(plan,kind,subject){if(!window.AuditPlanEditor||!plan.evidence_id||!plan.annotations.length)return null;var host=document.createElement('div');host.className='export-shell';document.body.appendChild(host);var api;try{api=window.AuditPlanEditor.mount(host,{kind:kind,service:state.data.object_category==='tobacco'?'tobacco':'alcohol',getState:function(){return plan;},onChange:function(){},evidenceUrl:evidenceUrl,evidence:state.evidence});await api.refresh();var result=await api.exportPreview();if(!result)throw new Error('Не удалось подготовить актуальное изображение '+(kind==='map'?'схемы':'плана')+'. Повторите загрузку исходника и отправку отчёта.');result.subject_id=subject;return result;}finally{if(api)api.destroy();host.remove();}}
  async function exportPlan(){return exportGraphic(state.data.plan,'plan','annotation');}
  function freezeControls(){
    if(!state.frozen)return;
    root.querySelectorAll('input,select,textarea').forEach(function(control){control.disabled=true;});
    root.querySelectorAll('button').forEach(function(button){if(button.id!=='submit-audit'&&!button.hasAttribute('data-open-evidence')&&!button.hasAttribute('data-open-egrn')&&!button.hasAttribute('data-go-step')&&!button.hasAttribute('data-download-material')&&!button.hasAttribute('data-download-materials')&&!button.hasAttribute('data-download-archive')&&!button.hasAttribute('data-copy-address')&&!button.hasAttribute('data-copy-archive')&&!button.hasAttribute('data-contact'))button.disabled=true;});
    root.querySelectorAll('.plan-editor-shell canvas').forEach(function(canvas){canvas.style.pointerEvents='none';});
    var submitButton=$('#submit-audit');if(submitButton)submitButton.textContent='Повторить отправку этой версии';
    var submitStatus=$('#submit-status');if(submitStatus)submitStatus.textContent='Отправка началась — версия зафиксирована. Можно просмотреть этапы и повторить отправку без изменений.';
    notice('Отправка началась — версия зафиксирована. Можно просмотреть данные и повторить отправку без изменений.');
    $('#save-now').disabled=true;
  }
  function frozenSnapshot(remote){
    clearTimeout(timer);var currentStep=step();
    state.pendingPacket=null;state.packetError='';
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
  async function submit(outcome){
    if(state.submitting)return;
    if(state.pendingPacket&&!state.frozen){renderPacketUpdate();notify(state.packetError);return;}
    if(state.pendingUploads){notify('Дождитесь загрузки выбранных файлов.');return;}
    try{if(editor&&editor.flush)await editor.flush();}catch(error){notify(error.message);return;}
    var p=state.data.inspection;
    if(!state.frozen){
      if(!p.org.trim()||!p.address.trim()||(state.data.object_category!=='tobacco'&&!p.service)){notify('В заявке не хватает данных. Менеджеру нужно дополнить объект, адрес или услугу. Наблюдения сохранены в черновике.');go(0);return;}
      var missing=requiredIssues(issues());
      if(missing.length){notify(missing[0].title);showReportIssues();return;}
      if(outcome==='actions'&&offersActions(issues()))chooseConclusion('actions');
      if(!state.data.workflow.conclusion_status){notify('Выберите результат проверки.');return;}
      if(state.data.workflow.conclusion_status==='ready'&&issues().length){showReportIssues();return;}
      state.data.ui_version=5;state.data.inspection.region='МСК';
      p.all_entrances_checked=state.data.entrances.length&&state.data.entrances.every(function(e){return !['Нет доступа','Не осмотрен'].includes(e.access)&&hasEvidenceImage('entrance',e.id);})?'Да':'Не проверено';
      p.zones_checked=state.data.workflow.territory_result==='clear'||state.data.zones.every(function(z){return z.status!=='pending'&&z.dist!=='Не проверено'&&z.name&&hasEvidenceImage('zone',z.id);})?'Да':'Не проверено';
      state.data.additional_plans=state.data.additional_plans.filter(function(p){return p.evidence_id||p.annotations.length;});['alcohol_present','within_cadastral','all_entrances_checked','zones_checked'].forEach(function(key){if(!p[key])p[key]='Не проверено';});
      if(isRenewal()){if(!p.archive_available)p.archive_available=state.packet&&(state.packet.archive_url||packetFiles().some(function(f){return f.role==='archive';}))?'Да':'Не проверено';if(p.alcohol_present==='Да'&&!p.alcohol_within_licensed)p.alcohol_within_licensed='Не проверено';}

      state.dirty=true;state.version++;localSave();
    }
    var enteredSubmission=state.frozen;
    state.submitting=true;updateClosingConfirmation();document.body.classList.add('submitting');refreshChrome();
    var submitStatus=$('#submit-status');if(submitStatus)submitStatus.textContent=state.frozen?'Повторяю отправку зафиксированной версии…':'Сохраняю последнюю версию и проверяю приложения…';
    try{
      await queue(async function(){
        if(!state.frozen){
          await flush();var figures=[{plan:state.data.plan,kind:'plan',subject:'annotation'}].concat(state.data.additional_plans.map(function(p){return{plan:p,kind:'plan',subject:'annotation-'+p.id};}));
          if(state.data.workflow.territory_result==='findings'&&mapMode()==='draw')figures.unshift({plan:state.data.map,kind:'map',subject:'annotation'});
          for(var figure of figures){var preview=await exportGraphic(figure.plan,figure.kind,figure.subject);if(preview){if(submitStatus)submitStatus.textContent='Сохраняю схему и планы…';var newPreview=await postEvidence({name:preview.name,type:preview.mime},preview.role||figure.kind,figure.subject,preview.data);figure.plan.preview_evidence_id=newPreview.id;state.dirty=true;state.version++;var stale=state.evidence.filter(function(e){return e.role===figure.kind&&e.subject_id===figure.subject&&e.id!==newPreview.id;});for(var oldPreview of stale){await removeGeneratedEvidence(oldPreview.id);}}}
        }
        if(!state.frozen){var activeSubjects=['annotation'].concat(state.data.additional_plans.map(function(p){return 'annotation-'+p.id;}));var retiredExports=state.evidence.filter(function(e){return e.role==='plan'&&String(e.subject_id||'').startsWith('annotation-')&&!activeSubjects.includes(e.subject_id);});for(var retiredExport of retiredExports)await removeGeneratedEvidence(retiredExport.id);await flush();}
        if(submitStatus)submitStatus.textContent='Передаю отчёт. Дождитесь подтверждения…';
        enteredSubmission=true;state.frozen=true;clearTimeout(timer);
        var result=await request('/api/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft_id:state.draft.id,revision:state.draft.revision})});
        adoptRevision(result);state.dirty=false;state.completed=true;document.body.classList.remove('submitting');
        try{if(state.recoveryData)localStorage.setItem(localKey+':recovery',JSON.stringify({data:state.recoveryData,saved_at:Date.now()}));localStorage.removeItem(localKey);}catch(e){}
        if(editor){editor.destroy();editor=null;}
        root.innerHTML='<div class="success-screen"><div class="success-mark">✓</div><h2>Отчёт отправлен</h2><p>Материалы и замечания сохранены с этой заявкой.</p>'+(result.warning?'<p role="status">'+esc(result.warning)+'</p>':'')+'<a class="button secondary" href="/requests">К заявкам</a></div>';
        $('#next-step').disabled=true;$('#previous-step').disabled=true;status('Отчёт отправлен · '+timeLabel(),'success');
        try{if(tg)tg.HapticFeedback.notificationOccurred('success');}catch(e){}
      });
    }catch(error){
      state.submitting=false;updateClosingConfirmation();document.body.classList.remove('submitting');
      await checkSubmissionState(enteredSubmission,error);
      refreshChrome();
      if(error.payload&&error.payload.code==='AUDIT_PACKET_CHANGED'&&!state.frozen){
        try{await fetchPacket();render();}catch(packetError){state.packetError=packetError.message;notify(packetError.message);}
      }else if(error.status===409&&!state.frozen){state.conflict=true;$('#conflict-panel').hidden=false;}
      submitStatus=$('#submit-status');
      if(submitStatus)submitStatus.textContent='Отправка не подтверждена: '+error.message+(state.frozen?' Повторите отправку этой версии без изменений.':' Исправьте замечания и повторите.');
      notify('Отправка не подтверждена. '+error.message);
    }
  }

  function downloadCopy(){var data=JSON.stringify({exported_at:new Date().toISOString(),draft_id:state.draft&&state.draft.id,data:state.recoveryData||state.data,evidence:state.evidence.map(function(e){return{id:e.id,name:e.name,role:e.role,subject_id:e.subject_id};})},null,2);var link=document.createElement('a');var url=URL.createObjectURL(new Blob([data],{type:'application/json'}));link.href=url;link.download='audit-draft-'+(state.draft&&state.draft.id||'local')+'.json';link.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
  async function reloadServer(){
    if(!window.confirm('Загрузить серверную версию вместо локальных правок? При необходимости сначала скачайте свою копию.'))return;
    try{var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId));if(!result.draft)throw new Error('Серверная версия не найдена.');state.data=restoreData(result.draft.data,!!result.draft.submitting);state.draft=result.draft;state.evidence=result.draft.evidence||[];state.conflict=false;state.dirty=false;state.attempt=null;state.frozen=!!result.draft.submitting;state.pendingPacket=null;state.packetError='';state.viewStep=state.frozen?2:null;state.packet=state.data.request_packet||null;$('#conflict-panel').hidden=true;if(!state.frozen)await fetchPacket();localSave();render();status(state.frozen?'Повторите отправку этой версии':'Загружено с сервера',state.frozen?'warning':'success');}catch(error){notify(error.message);}
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
  function packetIdentity(packet) {
    packet=packet||{};var identity={};
    ['org','address','service','object_category','cad_num','archive_url','zones_info'].forEach(function(key){identity[key]=String(packet[key]||'').trim();});
    identity.video_required=!!(packet.video_required||packet.has_video);
    identity.materials=['materials','egrn_links'].flatMap(function(source){return(Array.isArray(packet[source])?packet[source]:[]).map(function(file){return{source:source,id:String(file.id||''),role:String(file.role||''),name:String(file.name||''),mime:String(file.mime||''),bytes:Number(file.bytes)||0,sha256:String(file.sha256||'')};});}).sort(function(a,b){var left=JSON.stringify(a),right=JSON.stringify(b);return left<right?-1:left>right?1:0;});
    return identity;
  }
  function hasInspectionWork() {
    if(state.evidence.length||state.data.entrances.length||state.data.zones.length)return true;
    if(['building_type','boundaries','bti','to','nearby','veranda','patz','passport','owner_info','conclusion'].some(function(key){return !!state.data[key];}))return true;
    var sourceFields=['org','address','service','region','archive_url','archive_available'];
    if(Object.keys(state.data.inspection).some(function(key){return !sourceFields.includes(key)&&!!state.data.inspection[key];}))return true;
    var workflow=state.data.workflow||{};
    if(['territory_result','video_url','conclusion_status','followup_notes','mitigation','archive_skipped','preliminary_status','precheck_notes','call_status','appointment_at'].some(function(key){return !!workflow[key];}))return true;
    return [state.data.plan,state.data.map].concat(state.data.additional_plans||[]).some(function(plan){return plan&&(plan.evidence_id||plan.annotations&&plan.annotations.length);})||Object.values(workflow.documents||{}).some(Boolean);
  }
  function applyPacket(packet) {
    state.packet=packet;
    state.data.inspection.org=packet.org||'';state.data.inspection.address=packet.address||'';state.data.inspection.service=packet.service||'';state.data.inspection.region='МСК';
    state.data.object_category=['catering','retail','tobacco'].includes(packet.object_category)?packet.object_category:'catering';
    state.data.request_packet=clone(packet);state.data.order_material_ids=packetFiles().map(function(file){return file.id;});
    prefillContact(packet.contacts);state.data.inspection.archive_url=packet.archive_url||'';
    if(isRenewal())state.data.inspection.archive_available=packet.archive_url||packetFiles().some(function(file){return file.role==='archive';})?'Да':'Не проверено';
    else sanitizeService();
  }
  async function fetchPacket(){
    if(state.frozen){state.packet=state.data.request_packet||state.packet;return;}
    var packet=await request('/api/audit/prefill?order_id='+encodeURIComponent(orderId));
    if(state.frozen){state.packet=state.data.request_packet||state.packet;return;}
    var previous=state.data.request_packet;
    if(!previous&&hasInspectionWork())previous={org:state.data.inspection.org,address:state.data.inspection.address,service:state.data.inspection.service,object_category:state.data.object_category,cad_num:''};
    if(previous&&hasInspectionWork()&&!sameData(packetIdentity(previous),packetIdentity(packet))){
      state.packet=previous;state.pendingPacket=packet;state.packetError='Данные объекта изменились. Сверьте материалы с обновлённой заявкой.';
      renderPacketUpdate();return;
    }
    if(packet.object_category==='other'){window.location.replace('/audit/legacy'+window.location.search);return;}
    var before=JSON.stringify(stable(state.data));applyPacket(packet);
    if(before!==JSON.stringify(stable(state.data))){state.version++;state.dirty=true;}
    state.pendingPacket=null;state.packetError='';
  }
  function setFormNavigation(active) {
    $('#steps').hidden=!active;$('#previous-step').disabled=!active;$('#next-step').disabled=!active;$('#save-now').hidden=!active;
    var footer=document.querySelector('.bottom-bar');if(footer)footer.hidden=!active;
  }
  function retryScreen(title,message,retry) {
    setFormNavigation(false);root.setAttribute('aria-busy','false');
    root.innerHTML='<div class="empty-state"><h2>'+esc(title)+'</h2><p>'+esc(message)+'</p>'+(retry?'<button type="button" class="button secondary" id="retry-draft">Повторить</button>':'')+'</div>';
    if(retry)$('#retry-draft').onclick=retry;
  }
  function localDraftCards() {
    var prefix='audit-wizard-v3:'+uid+':',cards=[];
    if(uid==='staff')return cards;
    try{
      for(var i=0;i<localStorage.length;i++){
        var key=localStorage.key(i);if(!key||!key.startsWith(prefix))continue;
        var id=key.slice(prefix.length);if(!/^[1-9]\d*$/.test(id))continue;
        var local=JSON.parse(localStorage.getItem(key)||'null');
        if(!local||!local.dirty||!local.data||String(local.data.order_id)!==id)continue;
        var p=local.data.inspection||{};
        cards.push({order_id:Number(id),object_name:p.org||'Заявка #'+id,address:p.address||'',updated_at:local.saved_at,local:true});
      }
    }catch(e){}
    return cards;
  }
  async function openDrafts(){
    state.blocked=true;status('Загружаю список…');
    var back=document.querySelector('.back-link');if(back)back.hidden=true;
    $('#draft-id').textContent='Отчёты аудитора';$('#object-title').textContent='Откройте сохранённую проверку';
    try{
      var response=await request('/api/audit/drafts/open');
      if(!Array.isArray(response.drafts))throw new Error('Список черновиков пока недоступен.');
      var items=response.drafts.filter(function(d){return d&&Number.isSafeInteger(Number(d.order_id))&&Number(d.order_id)>0;});
      localDraftCards().forEach(function(local){
        var existing=items.find(function(item){return Number(item.order_id)===local.order_id;});
        if(existing)existing.local=true;else items.push(local);
      });
      items.sort(function(a,b){return new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime();});
      if(!items.length){retryScreen('Незавершённых отчётов нет','Чтобы начать, откройте нужную заявку из чата «Замеры 2.0».');status('Черновиков нет');return;}
      setFormNavigation(false);root.setAttribute('aria-busy','false');
      root.innerHTML='<div class="draft-list"><h2>Продолжить отчёт</h2>'+items.map(function(d){
        var url='/audit?order_id='+encodeURIComponent(d.order_id),date=new Date(d.updated_at);
        var when=d.local?'Есть правки на этом устройстве':d.submitting?'Отправка не подтверждена':d.updated_at&&Number.isFinite(date.getTime())?'Сохранён '+date.toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Черновик';
        return '<a class="manager-file draft-link" href="'+url+'"><strong>'+esc(d.object_name||'Заявка #'+d.order_id)+'</strong><span>'+esc(d.address||'')+'</span><small>#'+esc(d.order_id)+' · '+esc(when)+'</small></a>';
      }).join('')+'</div>';
      status('Незавершённые отчёты');
    }catch(error){retryScreen('Не удалось открыть черновики',error.message,openDrafts);status('Список недоступен','warning');}
  }
  function reconcileDraft(local,remote) {
    state.draft=remote;state.evidence=remote.evidence||[];
    if(remote.submitting){
      state.pendingPacket=null;state.packetError='';
      if(local&&local.dirty&&!sameData(local.data,remote.data)){state.recoveryData=clone(local.data);state.conflict=true;}
      state.data=restoreData(remote.data,true);state.frozen=true;state.viewStep=2;state.dirty=false;
    }else if(local&&local.dirty){
      var sameId=String(local.draft_id||'')===String(remote.id);
      var attempt=local.attempt,matchingAttempt=attempt&&(!attempt.draft_id||String(attempt.draft_id)===String(remote.id))&&sameData(attempt.data,remote.data);
      if((sameId||!local.draft_id)&&sameData(local.data,remote.data)){state.data=restoreData(remote.data);state.dirty=false;state.attempt=null;}
      else if(!local.conflict&&(matchingAttempt||(sameId&&Number(local.revision)===Number(remote.revision)))){state.attempt=null;}
      else state.conflict=true;
    }else{
      state.data=restoreData(remote.data);state.dirty=Number(remote.data&&remote.data.ui_version)!==5;
    }
    state.packet=state.data.request_packet||null;
    $('#conflict-panel').hidden=!state.conflict;
  }
  async function initialize(){
    if(!orderId){await openDrafts();return;}
    var back=document.querySelector('.back-link');if(back){back.href='/audit';back.textContent='← Черновики';}
    var local=null;try{local=JSON.parse(localStorage.getItem(localKey)||'null');}catch(e){}
    if(local&&local.data&&String(local.data.order_id||'')!==orderId)local=null;
    state.blocked=false;state.needsRestore=false;
    if(local&&local.data){
      state.data=restoreData(local.data);state.dirty=!!local.dirty;state.draft=local.draft_id?{id:local.draft_id,revision:local.revision}:null;
      state.attempt=local.attempt||null;state.localSaved=true;state.packet=state.data.request_packet||null;
    }
    try{
      var result=await request('/api/audit/drafts/current?order_id='+encodeURIComponent(orderId));
      if(!result.draft&&local&&local.draft_id){
        // A known server draft is no longer current, usually because it was
        // sent from another window. Keep unsynced data as a recovery copy.
        if(local.dirty){state.recoveryData=clone(local.data);try{localStorage.setItem(localKey+':recovery',JSON.stringify(local));}catch(e){}}
        state.data=clone(defaults);state.draft=null;state.evidence=[];state.dirty=false;state.attempt=null;local=null;state.localSaved=false;
        try{localStorage.removeItem(localKey);}catch(e){}
      }
      if(result.draft)reconcileDraft(local,result.draft);
      if(!state.frozen&&!state.conflict){try{await fetchPacket();}catch(error){state.packet=state.data.request_packet||null;state.packetError=error.message;notice('Материалы заявки сейчас недоступны. Сохранённые наблюдения остаются в черновике.');}}
      normalizeLayout();state.data.schema_version=3;state.data.order_id=orderId;state.loaded=true;setFormNavigation(true);render();$('#draft-id').textContent='Заявка #'+orderId;localSave();
      if(state.frozen)status('Версия зафиксирована — можно повторить отправку','warning');
      else if(state.conflict)status('Есть другая версия. Ваши правки сохранены на устройстве.','warning');
      else if(state.dirty)saveNow().catch(function(){});
      else status(state.draft?'Черновик загружен':'Данные заявки загружены',state.draft?'success':'');
    }catch(error){
      var authError=error.status===401||error.status===403;
      if(authError||!local||!local.data||uid==='staff'){
        state.blocked=true;
        retryScreen('Не удалось открыть проверку',authError?'Откройте заявку из личного сообщения бота в Telegram. Сохранённый черновик останется на месте.':error.message,authError?null:initialize);
        status(authError?'Нет доступа к проверке':'Черновик не загружен','warning');return;
      }
      state.loaded=true;state.needsRestore=true;setFormNavigation(true);state.packet=state.data.request_packet||null;normalizeLayout();render();state.serverError=error.message;
      status('Восстановлено с устройства','warning');
      notice('Можно продолжить текст. Чтобы загрузить сохранённые файлы и отправить отчёт, восстановите связь с ботом.');
      var retry=document.createElement('button');retry.type='button';retry.className='text-button';retry.textContent='Повторить';retry.onclick=retryRestore;$('#app-notice').append(' ',retry);
    }
  }
  function retryRestore(){
    if(!state.needsRestore)return;
    localSave();state.loaded=false;state.needsRestore=false;
    retryScreen('Восстанавливаю черновик','Проверяю ответы и материалы на сервере.');
    notice('');status('Проверяю связь с ботом…');initialize();
  }
  $('#previous-step').onclick=function(){go(step()-1);};$('#next-step').onclick=function(){go(step()===2?0:step()+1);};$('#save-now').onclick=function(){saveNow().then(function(){notify('Черновик сохранён на сервере.');}).catch(function(error){notify(error.message);});};$('#download-copy').onclick=downloadCopy;$('#reload-server').onclick=reloadServer;
  function resumeSave(){if(state.loaded&&state.dirty&&!state.conflict&&!state.frozen&&!state.blocked){saveRetries=0;saveNow().catch(function(){});}}
  window.addEventListener('online',resumeSave);
  window.addEventListener('online',retryRestore);
  window.addEventListener('pageshow',resumeSave);
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')saveOnExit();else resumeSave();});
  window.addEventListener('pagehide',saveOnExit);
  window.addEventListener('beforeunload',function(event){
    saveOnExit();
    if(!closingConfirmation&&state.loaded&&(state.dirty||state.pendingUploads)){event.preventDefault();event.returnValue='';}
  });
  initialize();
})();
