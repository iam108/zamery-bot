// A small handoff surface. Saved report contents remain read-only; corrections
// belong to the manager's object card, never to the auditor's recorded answers.
function handoffModel() {
  function text(value) { return value == null ? '' : String(value).trim(); }
  function escape(value) { return text(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function kind(value) { var v = text(value); return /табак|tobacco/i.test(v) ? 'Табак' : /магазин|розниц|retail/i.test(v) ? 'Магазин' : /общепит|catering/i.test(v) ? 'Общепит' : v; }
  function profile(order) {
    var o = order || {}, owner = text(o.owner), name = text(o.name);
    return { org: text(o.org) || (owner && name && owner !== name ? owner + ' (' + name + ')' : owner || name), address: text(o.address), inn: text(o.inn), cad_num: text(o.cad_num), region: text(o.region), kind: kind(o.kind || o.object_type), service: text(o.service) };
  }
  function contacts(list) { return Array.isArray(list) ? list.map(function (c) { return { name: text(c.name), phone: text(c.phone), tg: text(c.tg), comment: text(c.comment) }; }).filter(function (c) { return c.name || c.phone || c.tg || c.comment; }) : []; }
  function fingerprint(p) { return JSON.stringify(['org', 'address', 'inn', 'cad_num', 'region', 'kind', 'service'].map(function (key) { return text(p[key]); })); }
  function restore(state, cached, source) {
    if (!cached || cached.version !== 2) return state;
    state.lawyer = cached.lawyer || null;
    state.priority = ['обычный', 'срочно'].indexOf(cached.priority) >= 0 ? cached.priority : 'обычный';
    state.comment = typeof cached.comment === 'string' ? cached.comment : '';
    state.submitId = cached.submitId || state.submitId;
    // Explicit edits are restored only for the same underlying object snapshot.
    if (cached.fingerprint === fingerprint(source)) {
      if (cached.profile) state.profile = Object.assign({}, source, cached.profile);
      if (Array.isArray(cached.contacts) && (!cached.sourceContacts || JSON.stringify(cached.sourceContacts) === JSON.stringify(state.sourceContacts || []))) state.contacts = contacts(cached.contacts);
      state.egrnOrder = cached.egrnOrder === true;
    }
    if (cached.pending && cached.pending.payload) state.pending = cached.pending;
    if (cached.completed) state.completed = cached.completed;
    return state;
  }
  function status(value) { return { ready: 'Соответствует', actions: 'Нужны действия', insufficient: 'Нужно уточнить', obstacle: 'Есть препятствия', completed: 'Отчёт готов', submitted: 'Отчёт готов', done: 'Отчёт готов' }[value] || text(value) || 'Итог не указан'; }
  function isSource(file) { return /source$/.test(text(file.role)) || ['source', 'original'].indexOf(text(file.subject_id)) >= 0; }
  function isImage(file) { return /^image\//i.test(file.mime || '') || /\.(png|jpe?g|webp|gif|avif)$/i.test(file.name || ''); }
  function gallery(media) { return (media || []).filter(function (file) { return isImage(file) && !isSource(file); }).sort(function (a, b) { var rank = { map: 0, plan: 1, entrance: 2, zone: 3, interior: 4 }; return (rank[a.role] == null ? 5 : rank[a.role]) - (rank[b.role] == null ? 5 : rank[b.role]); }); }
  function packageInfo(packet) {
    var report = packet && packet.report, media = report && Array.isArray(report.media) ? report.media : [], images = gallery(media);
    return { report: !!(report && text(report.text)), maps: images.filter(function (f) { return f.role === 'map'; }).length, plans: images.filter(function (f) { return f.role === 'plan'; }).length, photos: images.filter(function (f) { return ['map', 'plan'].indexOf(f.role) < 0; }).length, originals: media.length, egrnLinks: packet && Array.isArray(packet.egrn_links) ? packet.egrn_links.length : 0, materials: packet && Array.isArray(packet.materials) ? packet.materials.length : 0, video: !!(report && text(report.video_url)), egrn: packet && packet.egrn ? packet.egrn.status : 'unknown', known: !!packet && packet.files_known !== false && (!report || report.src !== 'r' || media.length > 0), materialsKnown: !!packet && packet.files_known !== false && Array.isArray(packet.materials) };
  }
  function safeHttp(value) { try { var u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; } }
  function protectedUrl(value, origin) {
    try { var u = new URL(value, origin); return u.origin === origin && /^\/api\/(handoff\/|audit\/orders\/|egrn\/)/.test(u.pathname) ? u.pathname + u.search : ''; } catch (_) { return ''; }
  }
  function mediaLabel(file) { return text(file.caption) || ({ map: 'Схема прилегающей территории', plan: 'Размеченный план', entrance: 'Вход', zone: 'Проверенная организация', interior: 'Помещение', 'map-source': 'Исходный скриншот территории', 'plan-source': 'Исходный план' }[file.role] || 'Материал отчёта'); }
  function conflict(packet, p) { var report = packet && packet.report, old = text(report && (report.address || report.inspection && report.inspection.address)); return old && text(p.address) && old.toLowerCase() !== text(p.address).toLowerCase() ? 'В сохранённом отчёте указан прежний адрес: ' + old + '. В передаче используется адрес из заявки выше.' : ''; }
  function groupNotice(value) {
    if(!value||typeof value!=='object')return null;
    var state=value.manual_review===true||value.status==='sending'||value.status==='unknown'?'unknown':['pending','rejected','blocked','confirmed'].indexOf(value.status)>=0?value.status:'unknown';
    var messages={confirmed:'Сводка в чате клиентов опубликована.',pending:'Сводка в чат клиентов ещё не отправлена.',rejected:'Сводку не удалось отправить в чат клиентов. Можно повторить только сводку.',blocked:'Сводка в чат клиентов пока не опубликована. Повторите проверку публикации.',unknown:'Публикация сводки в чате клиентов не подтверждена. Сначала проверьте чат; автоматический повтор остановлен.'};
    return {status:state,message:messages[state],manual_review:state==='unknown',retry:['pending','rejected','blocked'].indexOf(state)>=0};
  }
  return { text: text, escape: escape, kind: kind, profile: profile, contacts: contacts, fingerprint: fingerprint, restore: restore, status: status, isSource: isSource, isImage: isImage, gallery: gallery, packageInfo: packageInfo, safeHttp: safeHttp, protectedUrl: protectedUrl, mediaLabel: mediaLabel, conflict: conflict, groupNotice:groupNotice };
}

function handoffClient() {
  var M = window.HandoffModel, $ = function (id) { return document.getElementById(id); };
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  var query = new URLSearchParams(location.search), orderId = query.get('order_id') || '', requestId = query.get('request_id') || '', readonly = query.get('view') === 'report';
  var userId = tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id || query.get('u') || sessionValue('tg_u') || 'staff';
  var cacheKey = 'handoff-v2:' + userId + ':' + (orderId ? 'order-' + orderId : requestId ? 'request-' + requestId : 'new');
  var S = { profile: {}, source: {}, sourceLoaded: false, sourceContacts: [], contacts: [], lawyer: null, lawyers: [], priority: 'обычный', comment: '', packet: null, report: null, selectedReport: null, egrnOrder: false, submitId: uuid(), pending: null, completed: null, existingAssignment: null, loading: true, packetError: '', error: '', review: false, sending: false };
  var layer = '', reportFocus = null, zoomFocus = null, imageEpoch = 0, imageUrls = [], imageControllers = [], zoomScale = 1, searchTimer, searchSequence = 0, packetSequence = 0;
  function sessionValue(key) { try { return sessionStorage.getItem(key); } catch (_) { return ''; } }
  function uuid() { return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16); }); }
  function save() {
    if (readonly) return;
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ version: 2, fingerprint: M.fingerprint(S.source), packetSignature: S.packet && S.packet.signature || '', sourceContacts: S.sourceContacts, profile: S.profile, contacts: S.contacts, lawyer: S.lawyer, priority: S.priority, comment: S.comment, egrnOrder: S.egrnOrder, submitId: S.submitId, pending: S.pending, completed: S.completed })); } catch (_) {}
  }
  function cached() { try { return JSON.parse(sessionValue(cacheKey) || 'null'); } catch (_) { return null; } }
  function api(url, options) {
    return fetch(url, options).then(async function (response) {
      var data; try { data = await response.json(); } catch (_) { throw new Error(response.status === 401 || response.status === 403 ? 'Откройте форму из рабочего бота.' : 'Сервер вернул непонятный ответ. Попробуйте ещё раз.'); }
      if (!response.ok || data.ok === false) { var error = new Error(data.error || data.warn || 'Не удалось загрузить данные (' + response.status + ').'); error.status = response.status; error.code = data.code; error.data = data; throw error; }
      return data;
    });
  }
  function announce(message) { $('notice').textContent = message || ''; }
  function date(value) { if (!value) return 'дата не указана'; var d = new Date(value); return isNaN(d.getTime()) ? 'дата не указана' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); }
  function bytes(value) { var n = Number(value); return n > 0 ? n >= 1048576 ? (n / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' МБ' : Math.ceil(n / 1024) + ' КБ' : ''; }
  function filesLabel(value) { var n = Number(value), tail = n % 100; return n + ' ' + (tail >= 11 && tail <= 14 ? 'файлов' : n % 10 === 1 ? 'файл' : n % 10 >= 2 && n % 10 <= 4 ? 'файла' : 'файлов'); }
  function emptyProfile() { return { org: '', address: '', inn: '', cad_num: '', region: 'МСК', kind: '', service: '' }; }
  function assignmentName() { var l = S.lawyers.find(function (x) { return String(x.tg_id) === String(S.lawyer); }); return l ? l.name : ''; }
  function egrnText(info) { return { available: 'ЕГРН · получена', waiting: 'ЕГРН · заказана, ожидается', missing: 'ЕГРН · не приложена', unknown: 'ЕГРН · наличие не подтверждено' }[info.egrn] || 'ЕГРН · наличие не подтверждено'; }
  function packetLines() {
    var info = M.packageInfo(S.packet), lines = [];
    if (info.report) lines.push('Отчёт аудитора'); else lines.push('Отчёт аудитора не выбран');
    if (info.known) { lines.push('Схемы: ' + info.maps, 'Планы: ' + info.plans, 'Фото: ' + info.photos, 'Оригиналы аудита: ' + info.originals); }
    else lines.push('Вложения старого отчёта: состав не подтверждён');
    lines.push(info.materialsKnown ? 'Документы заявки: ' + info.materials : 'Документы заявки: состав не подтверждён');
    if (info.egrnLinks) lines.push('Крупные выписки ЕГРН по ссылке: ' + info.egrnLinks);
    lines.push(info.video ? 'Видео по ссылке' : 'Видео не приложено', egrnText(info));
    if (S.egrnOrder) lines.push('Заказать новую ЕГРН по указанному кадастровому номеру');
    return lines;
  }
  function renderObject() {
    var p = S.profile;
    $('object-org').textContent = p.org || 'Организация не указана';
    $('object-address').textContent = p.address || 'Добавьте адрес объекта';
    $('object-meta').textContent = [p.kind, p.service, p.region].filter(Boolean).join(' · ') || 'Укажите тип объекта и услугу';
    $('object-source').textContent = orderId ? 'Заявка на замер №' + orderId : requestId ? 'Заявка клиента №' + requestId : 'Новый клиент';
    ['org', 'address', 'inn', 'cad_num', 'region', 'kind', 'service'].forEach(function (key) { $(key).value = p[key] || ''; });
    $('contacts').innerHTML = S.contacts.map(function (c, i) { return '<div class="contact-row"><div class="contact-fields"><label>Имя<input data-contact="' + i + '" data-field="name" value="' + M.escape(c.name) + '" autocomplete="name"></label><label>Телефон<input data-contact="' + i + '" data-field="phone" value="' + M.escape(c.phone) + '" inputmode="tel" autocomplete="tel"></label><label>Telegram<input data-contact="' + i + '" data-field="tg" value="' + M.escape(c.tg) + '" placeholder="@имя"></label>' + (c.comment ? '<p class="contact-note">' + M.escape(c.comment) + '</p>' : '') + '</div><button type="button" class="icon-button remove-contact" data-remove-contact="' + i + '" aria-label="Удалить контакт ' + M.escape(c.name || i + 1) + '">×</button></div>'; }).join('');
    $('no-contacts').hidden = !!S.contacts.length;
    $('historical-note').textContent = M.conflict(S.packet, p);
    $('historical-note').hidden = !$('historical-note').textContent;
  }
  function renderPacket() {
    var report = S.packet && S.packet.report, info = M.packageInfo(S.packet);
    $('packet-loading').hidden = !S.loading;
    $('packet-error').hidden = !S.packetError;
    $('packet-error-text').textContent = S.packetError;
    $('packet-content').hidden = S.loading || !!S.packetError;
    $('report-status').textContent = report ? M.status(report.status) : 'Отчёта пока нет';
    $('report-status').dataset.status = report && report.status || '';
    $('report-date').textContent = report ? [date(report.created_at), report.actor].filter(Boolean).join(' · ') : 'Можно выбрать сохранённый отчёт';
    $('open-report').disabled = !info.report;
    $('packet-counts').innerHTML = info.known ? [['Схемы', info.maps], ['Планы', info.plans], ['Фото', info.photos], ['Оригиналы аудита', info.originals]].map(function (item) { return '<div class="count"><strong>' + item[1] + '</strong><span>' + item[0] + '</span></div>'; }).join('') : '<p class="muted">Состав вложений старого отчёта не подтверждён. При передаче сохраняется доступная переписка; фотографии здесь не восстановлены.</p>';
    $('video-state').textContent = info.video ? 'Видео · ссылка приложена' : 'Видео · не приложено';
    $('materials-state').textContent = 'Документы заявки · ' + (info.materialsKnown ? filesLabel(info.materials) : 'состав не подтверждён');
    $('egrn-state').textContent = egrnText(info);
    $('archive-state').hidden = !(S.packet && S.packet.archive_url);
    $('archive-state').textContent = 'Архив объекта · ссылка приложена';
    $('egrn-order').checked = S.egrnOrder;
    $('egrn-order-box').hidden = info.egrn === 'available' || !S.profile.cad_num;
    $('egrn-cad').textContent = S.profile.cad_num || '';
    $('choose-report').textContent = report ? 'Выбрать другой отчёт' : 'Выбрать отчёт';
  }
  function renderAssignment() {
    $('lawyers').innerHTML = '<option value="">Выберите юриста</option>' + S.lawyers.map(function (l) { var known=(typeof l.active_cases==='number'||typeof l.active_cases==='string'&&/^\d+$/.test(l.active_cases))&&Number.isSafeInteger(Number(l.active_cases))&&Number(l.active_cases)>=0;return '<option value="' + M.escape(l.tg_id) + '"' + (String(l.tg_id) === String(S.lawyer) ? ' selected' : '') + '>' + M.escape(l.name) + (known?' · '+Number(l.active_cases)+' в работе':'') + '</option>'; }).join('');
    $('lawyer-empty').hidden = S.loading || S.lawyers.length > 0;
    $('priority').value = S.priority;
    $('comment').value = S.comment;
    updateFooter();
  }
  function updateFooter() {
    var b = $('go'), name = assignmentName(), locked = !!S.pending || !!S.completed || !!S.existingAssignment;
    b.textContent = 'Передать' + (name ? ' · ' + name : ' юристу');
    b.disabled = S.loading || !!S.packetError || S.sending || locked;
    $('form-error').textContent = S.error;
    $('form-error').hidden = !S.error;
    $('assignment').hidden = readonly || !!S.existingAssignment;
    $('footer').hidden = readonly || S.review || locked;
    $('review').hidden = !S.review || readonly;
    $('main-form').hidden = S.review && !readonly;
    $('readonly-note').hidden = !readonly;
    $('page-title').textContent = readonly ? 'Отчёт аудитора' : 'Передача юристу';
    $('page-subtitle').textContent = readonly ? 'Материалы осмотра и оригиналы' : 'Объект, готовый комплект и ответственный';
    $('delivery').hidden = readonly || !locked;
    if (S.existingAssignment) {
      var assignment = S.existingAssignment, confirmed = assignment.delivery_complete === true && assignment.manual_review !== true, incomplete = assignment.delivery_complete === false && assignment.manual_review !== true, group=M.groupNotice(assignment.group_notice),groupRetry=confirmed&&group&&group.retry;
      $('delivery-title').textContent = (confirmed ? 'Уже передано: ' : 'Юрист назначен: ') + (assignment.lawyer_name || 'юристу');
      $('delivery-text').textContent = 'Клиент №' + assignment.case_id + '.' + (confirmed ? ' Доставка полного комплекта подтверждена. Материалы отчёта можно открыть выше.' : incomplete ? ' Доставка этого комплекта ещё не завершена. Повторное создание клиента недоступно.' : ' Подтверждение доставки не сохранено. Нужна проверка доставки.') + (assignment.message ? ' ' + assignment.message : '');
      if(group)$('delivery-text').textContent+='\nЛичная доставка юристу: '+(confirmed?'подтверждена.':'ещё не подтверждена.')+'\n'+group.message;
      $('retry-send').hidden = assignment.can_resume !== true || confirmed&&!groupRetry;
      $('retry-send').disabled = S.sending;
      $('retry-send').textContent = groupRetry ? (S.sending?'Отправляю сводку…':'Повторить сводку в чат') : S.sending ? 'Продолжаю доставку…' : 'Продолжить доставку';
    } else if (S.pending) {
      $('delivery-title').textContent = S.pending.manualReview ? 'Нужна проверка доставки' : 'Доставка не завершена';
      $('delivery-text').textContent = (S.pending.caseId ? 'Передача №' + S.pending.caseId + '. ' : '') + (S.pending.message || (orderId ? 'Подтверждение не получено. Повторите эту же передачу: новая заявка создана не будет.' : 'Подтверждение не получено. Проверьте личные сообщения юриста перед повторной отправкой.'));
      $('retry-send').hidden = S.pending.manualReview === true || S.pending.retry === false;
      $('retry-send').disabled = S.sending;
      $('retry-send').textContent = S.sending ? 'Продолжаю доставку…' : orderId ? 'Повторить доставку' : 'Повторить отправку';
    } else if (S.completed) {
      var completedGroup=M.groupNotice(S.completed.groupNotice);
      $('delivery-title').textContent = 'Передано · ' + (S.completed.name || 'юристу');
      $('delivery-text').textContent = (S.completed.warn || 'Карточка и собранный комплект отправлены юристу в Telegram.') + (S.completed.egrnNote ? '\n' + S.completed.egrnNote : '');
      if(completedGroup)$('delivery-text').textContent='Личная доставка полного комплекта юристу подтверждена.\n'+$('delivery-text').textContent+'\n'+completedGroup.message;
      $('retry-send').hidden = !(completedGroup&&completedGroup.retry&&S.completed.canResumeNotice===true);
      $('retry-send').disabled = S.sending;
      $('retry-send').textContent = S.sending?'Отправляю сводку…':'Повторить сводку в чат';
    }
    $('details-editable').disabled = locked;
    $('lawyers').disabled = locked;
    $('priority').disabled = locked;
    $('comment').disabled = locked;
    $('choose-report').disabled = locked;
    $('egrn-order').disabled = locked;
  }
  function render() { renderObject(); renderPacket(); renderAssignment(); }
  function fieldChanged(key, value) { S.profile[key] = value; S.error = ''; save(); renderObject(); renderPacket(); updateFooter(); }
  function buildPayload() {
    var p = S.profile, rep = S.packet && S.packet.report || S.report;
    return Object.assign({ order_id: orderId ? Number(orderId) : null, request_id: requestId ? Number(requestId) : null, lawyer_tg_id: S.lawyer, priority: S.priority, comment: S.comment.trim(), contacts: M.contacts(S.contacts), egrn_order: S.egrnOrder === true, report_src: rep ? rep.src : null, report_id: rep ? rep.id : null, audit_text: rep ? rep.text || '' : '', tg_user_id: tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : null }, p, orderId ? { handoff_version: 2, submit_id: S.submitId, packet_signature: S.packet && S.packet.signature } : {});
  }
  function hasClientContact() { return S.contacts.some(function (contact) { return M.text(contact.name) || M.text(contact.phone) || M.text(contact.tg); }); }
  function validation() {
    if (!S.lawyer || !assignmentName()) return 'Выберите юриста, которому передать клиента.';
    if (!M.text(S.profile.org)) return 'Укажите организацию в карточке объекта.';
    if (!M.text(S.profile.address)) return 'Укажите адрес в карточке объекта.';
    if (!M.text(S.profile.kind) || !M.text(S.profile.service)) return 'Укажите тип объекта и услугу в карточке объекта.';
    if (orderId && !hasClientContact()) return 'Добавьте контакт клиента: имя, телефон или Telegram.';
    if (orderId && !S.packet) return 'Комплект ещё не загружен. Повторите загрузку.';
    if (S.egrnOrder && !M.text(S.profile.cad_num)) return 'Для заказа ЕГРН нужен кадастровый номер.';
    return '';
  }
  function showReview() {
    if (S.existingAssignment || S.pending || S.completed || readonly) return;
    S.error = validation();
    if (S.error) { updateFooter(); $('form-error').scrollIntoView({ block: 'center', behavior: 'auto' }); if (!S.lawyer) $('lawyers').focus(); else { $('details').open = true; if (orderId && !hasClientContact()) ($('contacts').querySelector('input[data-contact]') || $('add-contact')).focus(); else $('org').focus(); } return; }
    S.review = true; save();
    $('review-lawyer').textContent = assignmentName();
    $('review-org').textContent = S.profile.org;
    $('review-address').textContent = S.profile.address;
    $('review-meta').textContent = [S.profile.kind, S.profile.service, S.priority === 'срочно' ? 'Срочно' : 'Обычный приоритет'].filter(Boolean).join(' · ');
    $('review-list').innerHTML = packetLines().map(function (line) { return '<li>' + M.escape(line) + '</li>'; }).join('');
    $('review-comment').textContent = S.comment.trim(); $('review-comment').hidden = !S.comment.trim();
    updateFooter(); $('review').scrollIntoView({ block: 'start', behavior: 'auto' }); $('confirm-send').focus();
  }
  async function send(savedPayload) {
    if (S.sending || readonly) return;
    if(S.completed){
      var completedNotice=M.groupNotice(S.completed.groupNotice);
      if(!completedNotice||!completedNotice.retry||S.completed.canResumeNotice!==true)return;
      S.existingAssignment={case_id:S.completed.id,lawyer_name:S.completed.name,delivery_complete:true,group_notice:completedNotice,can_resume:true,egrnNote:S.completed.egrnNote};S.completed=null;
    }
    if (S.existingAssignment) {
      if (S.existingAssignment.can_resume !== true) return;
      var existingNotice=M.groupNotice(S.existingAssignment.group_notice);
      if(S.existingAssignment.delivery_complete===true&&(!existingNotice||!existingNotice.retry))return;
      S.sending = true; updateFooter();
      try {
        var resumed = await api('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume_case_id: S.existingAssignment.case_id }) });
        if (resumed.delivery_complete) {
          var resumedNotice=M.groupNotice(resumed.group_notice);
          S.completed = { id: resumed.id, name: S.existingAssignment.lawyer_name, warn: resumed.warn || '',egrnNote:S.existingAssignment.egrnNote||'',groupNotice:resumedNotice,canResumeNotice:!!(resumedNotice&&resumedNotice.retry) };
          S.existingAssignment = null;
        } else {
          S.error = resumed.warn || 'Доставка ещё не завершена. Повторите попытку.';
          S.existingAssignment.message = S.error; S.existingAssignment.manual_review = resumed.manual_review === true;
          S.existingAssignment.can_resume = resumed.retry !== false && resumed.manual_review !== true;
        }
      } catch (error) { S.error = error.message; S.existingAssignment.message = S.error; }
      finally { S.sending = false; save(); updateFooter(); }
      return;
    }
    if (!savedPayload && !S.review) return;
    var payload = savedPayload || buildPayload();
    S.sending = true;
    // Cache the exact body before dispatch: a failed response resumes this case.
    S.pending = { payload: payload, name: assignmentName(), message: 'Передача выполняется. Если связь прервётся, повтор продолжит эту же отправку.' };
    save(); updateFooter(); $('confirm-send').disabled = true; $('confirm-send').textContent = 'Передаю…';
    try {
      var result = await api('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      S.review = false;
      if (result.delivery_complete === false || result.retry === true || result.manual_review === true) {
        S.pending.message = result.warn || result.error || 'Часть комплекта ещё не доставлена. Повторите доставку этой же передачи.';
        S.pending.caseId = result.id || result.case_id; S.pending.manualReview = result.manual_review === true; S.pending.retry = result.retry;
      } else {
        var egrnNote = { attached: 'ЕГРН приложена.', waiting: 'Заказанная ЕГРН ещё ожидается; после получения бот доставит её отдельно.', none: 'Готовая выписка ЕГРН в комплекте отсутствует.' }[result.egrn_note] || (typeof result.egrn_note === 'string' ? result.egrn_note : '');
        var resultNotice=M.groupNotice(result.group_notice);
        S.completed = { id: result.id, name: S.pending.name, warn: result.warn || '', egrnNote: egrnNote,groupNotice:resultNotice,canResumeNotice:!!(resultNotice&&resultNotice.retry) }; S.pending = null;
        try { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success'); } catch (_) {}
      }
    } catch (error) {
      S.review = false;
      if (error.data && error.data.case_created === false) {
        S.pending = null; S.error = error.message; S.submitId = uuid();
        if (/PACKET|SNAPSHOT|MATERIAL.*CHANGED/i.test(error.code || '')) S.packetError = error.message + ' Обновите комплект перед повторной передачей.';
      } else {
        S.pending.message = error.message + (error.data && error.data.manual_review ? '' : orderId ? ' Отправка не подтверждена. Повтор продолжит эту же передачу.' : ' Отправка не подтверждена. Перед повтором проверьте сообщения юриста: заявка могла быть создана.');
        if (error.data) { S.pending.caseId = error.data.id || error.data.case_id; S.pending.manualReview = error.data.manual_review === true; S.pending.retry = error.data.retry; }
        if (error.code === 'HANDOFF_ALREADY_ASSIGNED' && error.data && error.data.case_id) S.existingAssignment = { case_id: error.data.case_id, lawyer_name: error.data.lawyer_name || '', delivery_complete: error.data.delivery_complete, can_resume: error.data.can_resume === true };
      }
    } finally {
      S.sending = false; save(); renderPacket(); updateFooter(); $('confirm-send').disabled = false; $('confirm-send').textContent = 'Подтвердить передачу'; (S.pending || S.completed ? $('delivery') : $('packet-error').hidden ? $('form-error') : $('packet-error')).scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }
  function applyPacket(data, options) {
    var packet = data.packet || data;
    if (!packet || !packet.order && !packet.report) throw new Error('Комплект не найден. Повторите загрузку.');
    S.packet = packet; S.report = packet.report || null; S.packetError = '';
    if (packet.order && (!S.sourceLoaded || !options || options.profile !== false)) {
      S.source = Object.assign(emptyProfile(), M.profile(packet.order)); S.profile = Object.assign({}, S.source); S.contacts = M.contacts(packet.order.contacts);
      S.sourceContacts = M.contacts(packet.order.contacts);
      S.sourceLoaded = true;
      var previous = readonly ? null : cached(); M.restore(S, previous, S.source);
      if (previous && previous.packetSignature && previous.packetSignature !== packet.signature && !S.pending) { S.completed = null; S.submitId = uuid(); }
      if (S.lawyer && !S.lawyers.some(function (x) { return String(x.tg_id) === String(S.lawyer); })) S.lawyer = null;
    } else if (packet.order) {
      var nextSource = Object.assign(emptyProfile(), M.profile(packet.order)), nextProfile = Object.assign({}, nextSource);
      Object.keys(nextProfile).forEach(function (key) { if (S.profile[key] !== S.source[key]) nextProfile[key] = S.profile[key]; });
      if (JSON.stringify(S.contacts) === JSON.stringify(S.sourceContacts)) S.contacts = M.contacts(packet.order.contacts);
      S.sourceContacts = M.contacts(packet.order.contacts);
      S.profile = nextProfile; S.source = nextSource;
    }
    var assigned = packet.assignment;
    if (assigned && assigned.case_id) {
      var samePending = assigned.delivery_complete === false && assigned.manual_review !== true && assigned.can_resume !== false && S.pending && S.pending.payload && S.pending.payload.handoff_version === 2 && assigned.submit_id && assigned.submit_id === S.pending.payload.submit_id;
      if (S.completed && (String(S.completed.id) !== String(assigned.case_id) || assigned.delivery_complete !== true || assigned.manual_review === true)) S.completed = null;
      if(S.completed){S.completed.groupNotice=M.groupNotice(assigned.group_notice);S.completed.canResumeNotice=assigned.can_resume===true;}
      S.existingAssignment = samePending || S.completed ? null : assigned;
    } else S.existingAssignment = null;
  }
  async function loadPacket(rep, options) {
    var sequence = ++packetSequence;
    if (rep && rep.id) S.selectedReport = { id: rep.id, src: rep.src };
    var qs = new URLSearchParams(); if (orderId) qs.set('order_id', orderId); if (requestId) qs.set('request_id', requestId); if (rep && rep.id) { qs.set('report_src', rep.src); qs.set('report_id', rep.id); }
    S.loading = true; S.packetError = ''; renderPacket(); updateFooter();
    try { var data = await api('/api/handoff/packet?' + qs.toString()); if (sequence !== packetSequence) return false; applyPacket(data, options); return true; }
    catch (error) { if (sequence === packetSequence) S.packetError = error.message; return false; }
    finally { if (sequence === packetSequence) { S.loading = false; render(); if (readonly && !S.packetError && S.packet && S.packet.report && S.packet.report.text) openReport(); } }
  }
  async function load() {
    S.loading = true; S.error = ''; render();
    try {
      var pref = await api('/api/handoff/prefill?order_id=' + encodeURIComponent(orderId) + '&request_id=' + encodeURIComponent(requestId));
      S.lawyers = pref.lawyers || [];
      var explicit = query.get('report_id') && query.get('report_src') ? { id: query.get('report_id'), src: query.get('report_src') } : null;
      if (orderId) {
        await loadPacket(explicit || pref.report);
      } else {
        var f = pref.request && pref.request.f || {};
        S.source = Object.assign(emptyProfile(), M.profile(pref.order || f)); S.profile = Object.assign({}, S.source);
        S.contacts = M.contacts(pref.order && pref.order.contacts);
        if (!S.contacts.length && (f.client || f.phone)) S.contacts = [{ name: M.text(f.client), phone: M.text(f.phone), tg: '', comment: '' }];
        S.sourceContacts = M.contacts(S.contacts);
        if (!readonly) M.restore(S, cached(), S.source);
        S.packet = { order: S.profile, report: null, materials: [], files_known: false, egrn: { status: 'unknown' } };
        if (explicit || pref.report) await chooseReport(explicit || pref.report, false);
      }
    } catch (error) { S.packetError = error.message; }
    finally {
      S.loading = false; render();
      if (readonly && !$('report-dialog').open && S.packet && S.packet.report && S.packet.report.text) openReport();
      else if (readonly && !S.packetError) announce('Сохранённый отчёт не найден.');
    }
  }
  async function chooseReport(it, closeAfter) {
    if (!it || !it.id) return;
    if (orderId && it.order_id && String(it.order_id) !== String(orderId)) { $('search-error').textContent = 'Это отчёт другой заявки. Откройте передачу из нужной заявки.'; return; }
    if (!orderId && it.order_id) {
      // A source order already identified by the saved report must survive a
      // temporary packet failure. Keep V2 and retry the complete original set.
      orderId = String(it.order_id); cacheKey = 'handoff-v2:' + userId + ':order-' + orderId;
    }
    if (orderId) {
      if (!await loadPacket(it, { profile: false })) { if (S.packetError) $('search-error').textContent = S.packetError; return; }
      if (S.packetError) { $('search-error').textContent = S.packetError; return; }
    } else {
      var sequence = ++packetSequence;
      S.selectedReport = { id: it.id, src: it.src }; S.loading = true; S.packetError = ''; renderPacket(); updateFooter();
      try {
        var data, metadata = it.metadata || {};
        // The packet endpoint also returns valid unlinked legacy reports. An
        // error cannot prove that a saved report has no source order/materials.
        data = await api('/api/handoff/packet?report_src=' + encodeURIComponent(it.src) + '&report_id=' + encodeURIComponent(it.id));
        if (sequence !== packetSequence) return;
        S.packet = data.packet || data; S.report = S.packet.report;
        if (S.packet.order) {
          metadata = Object.assign({}, metadata, M.profile(S.packet.order));
          if (S.packet.order.id && S.packet.signature) {
            // A saved audit with a verified source order uses the complete V2
            // package, even when the manager arrived through report search.
            orderId = String(S.packet.order.id); cacheKey = 'handoff-v2:' + userId + ':order-' + orderId;
            applyPacket(S.packet); metadata = S.profile;
          }
        }
        // Only labelled structured metadata may fill an empty new-client card.
        ['org', 'address', 'service', 'inn', 'cad_num', 'kind', 'region'].forEach(function (key) { if (!S.profile[key] && metadata[key]) S.profile[key] = M.text(metadata[key]); });
        if (!S.contacts.length && S.packet.order) S.contacts = M.contacts(S.packet.order.contacts);
      } catch (error) { if (sequence === packetSequence) { S.packetError = error.message; $('search-error').textContent = error.message; } return; }
      finally { if (sequence === packetSequence) { S.loading = false; render(); } }
    }
    save(); render(); if (closeAfter !== false) closeSearch();
  }
  async function searchReports() {
    var sequence = ++searchSequence; $('search-error').textContent = ''; $('search-results').innerHTML = '<p class="muted">Ищу отчёты…</p>';
    try {
      var data = await api('/api/reports/search?q=' + encodeURIComponent($('report-query').value.trim())); if (sequence !== searchSequence) return;
      var items = (data.items || []).filter(function (it) { return !orderId || !it.order_id || String(it.order_id) === String(orderId); });
      if (!items.length) { $('search-results').innerHTML = '<p class="muted">Отчётов не найдено. Попробуйте часть адреса или название.</p>'; return; }
      $('search-results').innerHTML = '';
      items.forEach(function (it) {
        var row = document.createElement('button'); row.type = 'button'; row.className = 'report-result';
        var meta = it.metadata || {}, heading = document.createElement('strong'); heading.textContent = meta.org || 'Отчёт ' + (it.order_id ? 'по заявке №' + it.order_id : 'аудитора');
        var caption = document.createElement('span'); caption.textContent = [meta.address, date(it.created_at), it.author].filter(Boolean).join(' · ');
        var excerpt = document.createElement('p'); excerpt.textContent = (it.text || '').split('\n').filter(Boolean).slice(0, 2).join(' · ');
        row.appendChild(heading); row.appendChild(caption); row.appendChild(excerpt); row.onclick = function () { chooseReport(it); }; $('search-results').appendChild(row);
      });
    } catch (error) { if (sequence === searchSequence) { $('search-results').innerHTML = ''; $('search-error').textContent = error.message; } }
  }
  function openDialog(id, focusId) {
    var dialog = $(id); if (!dialog.open) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
    document.body.classList.add('sheet-open'); if (focusId) $(focusId).focus();
  }
  function closeDialog(id) {
    var dialog = $(id); if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('sheet-open');
  }
  function closeSearch(fromHistory) { closeDialog('search-dialog'); $('choose-report').focus(); if (!fromHistory && history.state && history.state.handoffLayer === 'search') history.back(); }
  function layerHistory(value) { layer = value; try { history.pushState({ handoffLayer: value }, '', location.href); } catch (_) {} }
  function releaseImages() {
    imageEpoch++; imageControllers.forEach(function (controller) { controller.abort(); }); imageControllers = [];
    imageUrls.forEach(function (url) { URL.revokeObjectURL(url); }); imageUrls = [];
  }
  async function fetchImage(file, image, card, epoch) {
    var url = M.protectedUrl(file.url, location.origin);
    if (!url) { card.querySelector('.image-state').textContent = 'Предпросмотр недоступен. Скачайте оригинал ниже.'; return; }
    var controller = new AbortController(); imageControllers.push(controller);
    try {
      var response = await fetch(url, { signal: controller.signal }); if (!response.ok) throw new Error('Не удалось загрузить изображение');
      var blob = await response.blob(); if (epoch !== imageEpoch || !$('report-dialog').open) return;
      var blobUrl = URL.createObjectURL(blob); imageUrls.push(blobUrl);
      image.onload = function () { if (epoch !== imageEpoch) return; card.querySelector('.image-state').hidden = true; image.hidden = false; card.querySelector('.zoom-hint').hidden = false; card.querySelector('.image-open').disabled = false; };
      image.onerror = function () { card.querySelector('.image-state').textContent = 'Формат не открывается в браузере. Скачайте оригинал.'; };
      image.src = blobUrl;
      card.querySelector('.image-open').onclick = function () { openZoom(blobUrl, M.mediaLabel(file), this); };
    } catch (error) {
      if (controller.signal.aborted || epoch !== imageEpoch) return;
      var state = card.querySelector('.image-state'); state.textContent = 'Изображение не загрузилось. ';
      var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = 'Повторить'; retry.onclick = function () { state.textContent = 'Загружаю…'; fetchImage(file, image, card, epoch); }; state.appendChild(retry);
    }
  }
  function downloadButton(file, index) { return '<button type="button" class="download-row" data-download="' + index + '"><span><strong>' + M.escape(file.name || M.mediaLabel(file)) + '</strong><small>' + M.escape([file.role === 'egrn' ? 'ЕГРН' : M.mediaLabel(file), bytes(file.bytes)].filter(Boolean).join(' · ')) + '</small></span><span aria-hidden="true">↓</span></button>'; }
  async function download(file, button) {
    var url = M.protectedUrl(file.url, location.origin);
    if (!url) { announce('Ссылка на оригинал недоступна.'); return; }
    var old = button.innerHTML; button.disabled = true; button.textContent = 'Скачиваю…';
    try {
      if (/\/egrn\/[0-9a-f-]+\/link(?:\?|$)/i.test(url)) {
        var link = await api(url), downloadUrl = M.safeHttp(link.url);
        if (!downloadUrl) throw new Error('Не удалось открыть оригинал выписки.');
        if (tg && tg.openLink) tg.openLink(downloadUrl);
        else { var original = document.createElement('a'); original.href = downloadUrl; original.target = '_blank'; original.rel = 'noopener'; original.click(); }
        return;
      }
      var u = new URL(url, location.origin); u.searchParams.set('download', '1');
      var response = await fetch(u.pathname + u.search); if (!response.ok) throw new Error('Не удалось скачать файл. Попробуйте ещё раз.');
      var blob = await response.blob(), blobUrl = URL.createObjectURL(blob), a = document.createElement('a'); a.href = blobUrl; a.download = file.name || 'Документ'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 30000);
    } catch (error) { $('report-notice').textContent = error.message; }
    finally { button.disabled = false; button.innerHTML = old; }
  }
  function openReport() {
    var report = S.packet && S.packet.report; if (!report || !report.text) return;
    releaseImages(); reportFocus = document.activeElement; $('report-text').textContent = report.text;
    $('report-heading').textContent = S.profile.org || 'Отчёт аудитора';
    $('report-subtitle').textContent = [M.status(report.status), date(report.created_at), report.actor].filter(Boolean).join(' · ');
    $('report-address-note').textContent = M.conflict(S.packet, S.profile); $('report-address-note').hidden = !$('report-address-note').textContent;
    $('report-notice').textContent = '';
    var video = M.safeHttp(report.video_url), archive = M.safeHttp(S.packet.archive_url), telegram = M.safeHttp(report.telegram_url);
    $('report-video').hidden = !video; if (video) $('report-video').href = video;
    $('report-archive').hidden = !archive; if (archive) $('report-archive').href = archive;
    $('report-telegram').hidden = !telegram; if (telegram) $('report-telegram').href = telegram;
    var media = Array.isArray(report.media) ? report.media : [], images = M.gallery(media), list = media.concat(S.packet.materials || [], S.packet.egrn_links || []), epoch = imageEpoch;
    $('gallery').innerHTML = ''; $('gallery-empty').hidden = images.length > 0;
    $('gallery-empty').textContent = !M.packageInfo(S.packet).known ? 'Вложения старого отчёта здесь не восстановлены. Откройте оригинальные сообщения в Telegram, если ссылка доступна.' : 'Фотографии и графика к этому отчёту не приложены.';
    images.forEach(function (file) {
      var card = document.createElement('figure'); card.className = 'report-image'; card.innerHTML = '<figcaption>' + M.escape(M.mediaLabel(file)) + '</figcaption><button type="button" class="image-open" disabled aria-label="Увеличить ' + M.escape(M.mediaLabel(file)) + '"><img hidden alt="' + M.escape(M.mediaLabel(file)) + '"><span class="zoom-hint" aria-hidden="true" hidden>⤢</span></button><div class="image-state" role="status">Загружаю изображение…</div>';
      $('gallery').appendChild(card); fetchImage(file, card.querySelector('img'), card, epoch);
    });
    $('report-originals').innerHTML = list.map(downloadButton).join(''); $('originals-empty').hidden = list.length > 0;
    $('report-originals').querySelectorAll('[data-download]').forEach(function (button) { button.onclick = function () { download(list[Number(button.dataset.download)], button); }; });
    $('report-close').textContent = readonly ? 'Закрыть отчёт' : 'К передаче';
    openDialog('report-dialog', 'report-close'); $('report-body').scrollTop = 0; layerHistory('report');
  }
  function closeReport(fromHistory) {
    if ($('zoom-dialog').open) closeZoom(true);
    closeDialog('report-dialog'); releaseImages(); $('gallery').innerHTML = ''; layer = '';
    if (reportFocus && reportFocus.focus) reportFocus.focus();
    if (!fromHistory && history.state && history.state.handoffLayer === 'report') history.back();
  }
  function openZoom(url, label, trigger) {
    zoomFocus = trigger; zoomScale = 1; $('zoom-image').src = url; $('zoom-image').alt = label; $('zoom-label').textContent = label; setZoom(1); openDialog('zoom-dialog', 'zoom-close'); layerHistory('zoom');
  }
  function setZoom(value) { zoomScale = Math.max(1, Math.min(4, value)); $('zoom-image').style.width = zoomScale * 100 + '%'; $('zoom-minus').disabled = zoomScale <= 1; $('zoom-plus').disabled = zoomScale >= 4; $('zoom-value').textContent = Math.round(zoomScale * 100) + '%'; }
  function closeZoom(fromHistory) { closeDialog('zoom-dialog'); $('zoom-image').removeAttribute('src'); layer = 'report'; if (zoomFocus && zoomFocus.focus) zoomFocus.focus(); if (!fromHistory && history.state && history.state.handoffLayer === 'zoom') history.back(); }
  function back() {
    if ($('zoom-dialog').open) { closeZoom(); return; }
    if ($('report-dialog').open) { closeReport(); return; }
    if ($('search-dialog').open) { closeSearch(); return; }
    if (S.review) { S.review = false; updateFooter(); $('go').focus(); return; }
    if (tg) tg.close(); else if (requestId) location.href = '/requests'; else history.back();
  }
  ['org', 'address', 'inn', 'cad_num', 'region', 'kind', 'service'].forEach(function (key) { $(key).addEventListener('change', function () { fieldChanged(key, this.value.trim()); }); });
  $('contacts').addEventListener('input', function (event) { var input = event.target; if (input.dataset.contact != null && S.contacts[Number(input.dataset.contact)]) { S.contacts[Number(input.dataset.contact)][input.dataset.field] = input.value; save(); } });
  $('contacts').addEventListener('click', function (event) { var button = event.target.closest('[data-remove-contact]'); if (!button) return; S.contacts.splice(Number(button.dataset.removeContact), 1); save(); renderObject(); });
  $('add-contact').onclick = function () { S.contacts.push({ name: '', phone: '', tg: '', comment: '' }); renderObject(); var inputs = $('contacts').querySelectorAll('input'); if (inputs.length) inputs[inputs.length - 3].focus(); save(); };
  $('lawyers').onchange = function () { S.lawyer = this.value || null; S.error = ''; save(); updateFooter(); };
  $('priority').onchange = function () { S.priority = this.value; save(); };
  $('comment').oninput = function () { S.comment = this.value; save(); };
  $('egrn-order').onchange = function () { S.egrnOrder = this.checked; save(); };
  $('go').onclick = showReview;
  $('review-back').onclick = function () { S.review = false; updateFooter(); $('go').focus(); };
  $('confirm-send').onclick = function () { send(); };
  $('retry-send').onclick = function () { if (S.existingAssignment||S.completed) send(); else if (S.pending) send(S.pending.payload); };
  $('retry-load').onclick = function () { if (S.lawyers.length && orderId) loadPacket(S.selectedReport || S.report, { profile: false }); else if (S.selectedReport) chooseReport(S.selectedReport, false); else load(); };
  $('open-report').onclick = openReport;
  $('choose-report').onclick = function () { openDialog('search-dialog', 'report-query'); layerHistory('search'); searchReports(); };
  $('report-query').oninput = function () { clearTimeout(searchTimer); searchTimer = setTimeout(searchReports, 250); };
  $('search-retry').onclick = searchReports;
  $('search-close').onclick = function () { closeSearch(); };
  $('report-close').onclick = function () { closeReport(); };
  $('jump-text').onclick = function () { $('report-text').scrollIntoView({ block: 'start', behavior: 'auto' }); };
  $('jump-images').onclick = function () { $('report-images-heading').scrollIntoView({ block: 'start', behavior: 'auto' }); };
  $('jump-files').onclick = function () { $('report-files-heading').scrollIntoView({ block: 'start', behavior: 'auto' }); };
  $('zoom-close').onclick = function () { closeZoom(); };
  $('zoom-plus').onclick = function () { setZoom(zoomScale + 0.5); };
  $('zoom-minus').onclick = function () { setZoom(zoomScale - 0.5); };
  $('zoom-fit').onclick = function () { setZoom(1); };
  $('back').onclick = back;
  ['report-dialog', 'zoom-dialog', 'search-dialog'].forEach(function (id) { $(id).addEventListener('cancel', function (event) { event.preventDefault(); back(); }); });
  window.addEventListener('popstate', function () { if ($('zoom-dialog').open && (!history.state || history.state.handoffLayer !== 'zoom')) closeZoom(true); if ($('report-dialog').open && (!history.state || !history.state.handoffLayer)) closeReport(true); if ($('search-dialog').open && (!history.state || history.state.handoffLayer !== 'search')) closeSearch(true); });
  window.addEventListener('pagehide', function () { save(); releaseImages(); });
  if (tg && tg.BackButton) { try { tg.BackButton.show(); tg.BackButton.onClick(back); } catch (_) {} }
  if (readonly) document.body.classList.add('readonly');
  var dark = tg && tg.colorScheme === 'dark' || !tg && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { if (tg) { tg.setHeaderColor(dark ? '#111928' : '#e8f1fc'); tg.setBackgroundColor(dark ? '#111928' : '#e8f1fc'); } } catch (_) {}
  load();
}

function handoffPage() {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>Передача юристу · ЛРС</title><style>
:root{font:100%/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#152338;background:#e9f1fa;--ink:#152338;--muted:#596b83;--glass:rgba(255,255,255,.61);--solid:#f5f8ff;--border:rgba(255,255,255,.9);--input:rgba(130,150,188,.13);--blue:#3167ff;--shadow:0 16px 48px rgba(56,84,144,.10),inset 0 1px 0 rgba(255,255,255,.9)}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 8% 12%,#bedfff 0,transparent 48%),radial-gradient(ellipse at 95% 45%,#e0d6ff 0,transparent 51%),radial-gradient(ellipse at 25% 95%,#c7f1e5 0,transparent 55%),#e9f1fa;background-attachment:fixed;color:var(--ink)}button,input,select,textarea{font:inherit;color:inherit}button,a,input,select,textarea{-webkit-tap-highlight-color:transparent}button,a{touch-action:manipulation}button{cursor:pointer;min-height:46px;border:0;line-height:1.25;transition:background .12s ease,transform .12s ease}button:active:not(:disabled){transform:scale(.975)}button:disabled{cursor:default;opacity:.48}button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #265df4;outline-offset:3px}[hidden]{display:none!important}h1,h2,h3,p{margin:0}h1{font-size:1.8rem;line-height:1.15;letter-spacing:-.035em}h2{font-size:1.23rem;line-height:1.3;letter-spacing:-.018em}h3{font-size:1.07rem;line-height:1.4}small,.muted{color:var(--muted)}small{font-size:.83rem}.shell{width:min(100%,800px);margin:auto;padding:20px 16px calc(126px + env(safe-area-inset-bottom))}.page-heading{display:flex;align-items:center;gap:12px;margin:4px 0 22px}.page-heading small{display:block;margin-top:6px}.back,.icon-button{border-radius:50%;background:var(--input);min-width:46px;flex:none}.back{font-size:1.3rem}.glass{background:var(--glass);border:1.5px solid var(--border);border-radius:30px;box-shadow:var(--shadow);backdrop-filter:blur(24px) saturate(125%);-webkit-backdrop-filter:blur(24px) saturate(125%)}.card{padding:24px;margin:0 0 18px}.card-header{display:flex;align-items:start;justify-content:space-between;gap:12px;margin-bottom:17px}.object-source{font-size:.77rem;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:9px}.object-org{font-size:1.38rem;letter-spacing:-.025em;line-height:1.25;overflow-wrap:anywhere}.object-address{font-size:1.05rem;line-height:1.5;margin-top:9px}.object-meta{margin-top:10px;color:var(--muted);font-size:.9rem}.text-button{color:#2558db;background:transparent;border-radius:14px;padding:9px 12px;min-height:44px;font-weight:600}.details{margin-top:16px}.details>summary{list-style:none;cursor:pointer;color:#2558db;font-weight:600;min-height:44px;display:flex;align-items:center;justify-content:space-between}.details>summary::-webkit-details-marker{display:none}.details>summary:after{content:'＋';font-size:1.2rem}.details[open]>summary:after{content:'−'}.details[open]>summary{margin-bottom:15px}.details-editable{border:0;padding:0;margin:0;min-width:0}.fields{display:grid;grid-template-columns:1fr 1fr;gap:15px}.wide{grid-column:1/-1}label{display:block;font-size:.86rem;font-weight:600;color:var(--muted)}input,select,textarea{display:block;width:100%;border:1px solid transparent;border-radius:17px;background:var(--input);padding:13px 15px;margin-top:7px;min-height:50px;font-size:1rem;font-weight:400;color:var(--ink)}textarea{resize:vertical;min-height:98px;line-height:1.5}input::placeholder,textarea::placeholder{color:var(--muted);opacity:.8}input:focus,textarea:focus,select:focus{background:var(--solid)}.contacts-title{margin:23px 0 12px}.contact-row{display:flex;gap:10px;align-items:start;margin:10px 0 16px}.contact-fields{flex:1;min-width:0;display:grid;grid-template-columns:1fr 1fr;gap:10px}.contact-fields label:last-of-type{grid-column:1/-1}.contact-note{font-size:.85rem;color:var(--muted);grid-column:1/-1;white-space:pre-wrap}.remove-contact{margin-top:25px;font-size:1.4rem}.note{font-size:.85rem;line-height:1.5;color:var(--muted);margin-top:16px;padding:12px 14px;border-radius:16px;background:var(--input)}.report-overview{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}.status{font-size:1.05rem;font-weight:650;letter-spacing:-.015em}.status[data-status=ready]{color:#10865b}.status[data-status=actions],.status[data-status=insufficient]{color:#9b5700}.status[data-status=obstacle]{color:#b22645}.outline-button,.soft-button{padding:13px 17px;border-radius:18px;background:var(--input);font-weight:600}.outline-button{background:rgba(255,255,255,.35);border:1px solid rgba(100,126,169,.2)}.full{width:100%}.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:20px 0}.count strong{display:block;font-size:1.55rem;font-weight:650;line-height:1.3;letter-spacing:-.03em}.count span{font-size:.75rem;color:var(--muted);line-height:1.35;display:block;margin-top:3px}.package-details{display:grid;gap:8px;font-size:.88rem;color:var(--muted)}.package-details p{display:flex;align-items:baseline;gap:9px}.package-details p:before{content:'•';color:#6685bc}.check{font-weight:400;display:flex;gap:10px;align-items:start;margin-top:17px;padding:13px;background:var(--input);border-radius:16px}.check input{flex:none;display:inline;width:21px;height:21px;min-height:21px;margin:2px 0 0;accent-color:var(--blue)}.check small{display:block;line-height:1.4;margin-top:5px}.packet-bottom{margin-top:12px;display:flex;justify-content:flex-end}.assignment-fields{display:grid;grid-template-columns:1fr 1fr;gap:16px}.assignment-fields .wide{margin-top:1px}.assignment-fields #lawyers{font-weight:600}.footer{position:fixed;bottom:0;left:0;right:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(0deg,rgba(220,239,247,.88),rgba(234,242,255,.68));border-top:1px solid var(--border);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);z-index:10}.footer-inner{width:min(100%,768px);margin:auto}.primary{color:white;background:var(--blue);padding:16px 24px;border-radius:22px;font-weight:650;box-shadow:0 8px 22px rgba(49,103,255,.18);min-height:56px}.footer small{display:block;text-align:center;margin-top:6px;font-size:.73rem}.error{color:#9b243a;font-size:.88rem;white-space:pre-wrap;margin:12px 0}.loading{color:var(--muted);padding:18px 0}.review-title{margin:10px 0 21px}.review-eyebrow{font-size:.8rem;color:var(--muted);margin:14px 0 4px}.review-lawyer{font-size:1.6rem;line-height:1.3;letter-spacing:-.025em}.review-address{margin:7px 0}.review-list{padding:0;list-style:none;display:grid;gap:7px;margin:14px 0 0;font-size:.95rem}.review-list li{display:flex;gap:10px;align-items:baseline}.review-list li:before{content:'•';color:#6685bc}.review-actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}.review-comment{white-space:pre-wrap;margin-top:18px}.delivery h2{margin-bottom:8px}.delivery p{color:var(--muted);white-space:pre-wrap}.delivery button{margin-top:16px}.notice{font-size:.9rem;color:var(--muted);white-space:pre-wrap;margin:10px 0}.readonly .details,.readonly #choose-report,.readonly #egrn-order-box{display:none}.readonly .shell{padding-bottom:30px}dialog{color:var(--ink);background:var(--solid);border:0;padding:0;max-width:none;max-height:none;overscroll-behavior:contain}dialog::backdrop{background:rgba(20,34,56,.4);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}.sheet{width:min(100%,1000px);height:100dvh;height:100vh;height:100dvh;margin:0 auto;border-radius:0;overflow:hidden;box-shadow:0 0 90px rgba(12,31,60,.18)}.sheet-inner{height:100%;display:flex;flex-direction:column}.sheet-header{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:18px 22px calc(14px + env(safe-area-inset-top));flex:none;background:var(--glass);border-bottom:1px solid rgba(124,146,180,.12);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px)}.sheet-tabs{display:flex;gap:7px;padding:8px 18px 10px;background:var(--solid);flex:none;border-bottom:1px solid rgba(124,146,180,.12)}.sheet-tabs button{flex:1;background:var(--input);border-radius:14px;padding:9px 10px;font-size:.86rem;font-weight:600;min-height:44px}.sheet-heading{min-width:0}.sheet-heading h2{overflow-wrap:anywhere}.sheet-heading small{display:block;margin-top:4px}.sheet-header button{flex:none}.sheet-body{overflow:auto;flex:1;padding:22px 24px calc(40px + env(safe-area-inset-bottom));overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.full-report-text{font:inherit;font-size:1rem;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;margin:0 0 24px;max-height:none;overflow:visible}.report-link{display:block;border-radius:17px;background:var(--input);padding:14px 17px;color:#2558db;font-weight:600;text-decoration:none;margin:12px 0}.report-section{margin:32px 0 16px}.report-image{margin:0 0 24px;border-radius:20px;overflow:hidden;border:1px solid rgba(108,132,166,.15);background:rgba(255,255,255,.6)}.report-image figcaption{font-size:.9rem;padding:12px 15px;font-weight:600;white-space:pre-wrap}.image-open{position:relative;width:100%;display:block;padding:0;background:#e3eaf2;min-height:0}.image-open:disabled{opacity:1}.image-open img{width:100%;display:block;height:auto;max-height:none}.image-state{padding:18px;color:var(--muted);font-size:.9rem}.zoom-hint{position:absolute;bottom:12px;right:12px;background:rgba(255,255,255,.9);color:#223248;box-shadow:0 2px 8px #0002;border-radius:12px;padding:5px 12px;font-size:1.3rem}.download-row{display:flex;align-items:center;justify-content:space-between;gap:14px;text-align:left;background:var(--input);border-radius:17px;padding:14px 16px;width:100%;margin:10px 0}.download-row strong{font-weight:550;display:block;overflow-wrap:anywhere}.download-row small{display:block;margin-top:4px}.download-row>span:last-child{font-size:1.4rem}.zoom-sheet{width:100vw;height:100dvh;margin:0;background:#121a29;color:#fff}.zoom-sheet .sheet-header{background:#182236;border-color:#ffffff15}.zoom-sheet .sheet-header small{color:#b9c7de}.zoom-sheet button{color:white;background:#ffffff18}.zoom-toolbar{display:flex;gap:8px;align-items:center;justify-content:center;padding:10px;background:#182236}.zoom-toolbar button{border-radius:14px;padding:8px 17px;min-width:48px}.zoom-content{flex:1;overflow:auto;display:block;padding:12px;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y pinch-zoom}.zoom-content img{display:block;width:100%;height:auto;max-width:none;margin:0 auto;transform-origin:top left}.search-sheet{height:90dvh;bottom:0;top:auto;border-radius:28px 28px 0 0}.report-result{display:block;text-align:left;width:100%;background:var(--input);border-radius:18px;padding:16px;margin:12px 0}.report-result strong,.report-result span{display:block}.report-result span{font-size:.8rem;color:var(--muted);margin-top:6px}.report-result p{font-size:.9rem;margin-top:8px;line-height:1.4}.sheet-open{overflow:hidden}.select-report-search{margin-bottom:16px}.readonly-note{margin-bottom:15px}.info{color:var(--muted);font-size:.87rem}.empty{color:var(--muted);font-size:.9rem;padding:12px 0}.block-gap{margin-top:16px}
[data-theme=dark]{--ink:#ecf1ff;--muted:#b1c1d8;--glass:rgba(34,46,69,.85);--solid:#172134;--border:rgba(190,211,255,.2);--input:rgba(151,174,222,.13);--blue:#507eff;--shadow:0 16px 48px #0002,inset 0 1px 0 #ffffff12;background:#111928}[data-theme=dark] body{background:radial-gradient(ellipse at 10% 10%,#203e64 0,transparent 50%),radial-gradient(ellipse at 96% 55%,#342c57 0,transparent 53%),radial-gradient(ellipse at 30% 100%,#1c454a 0,transparent 50%),#111928}[data-theme=dark] .text-button,[data-theme=dark] .details>summary,[data-theme=dark] .report-link{color:#adc3ff}[data-theme=dark] .footer{background:rgba(27,40,62,.86)}[data-theme=dark] .outline-button,[data-theme=dark] .report-image{background:rgba(37,51,77,.8)}[data-theme=dark] .status[data-status=ready]{color:#6ee3ad}[data-theme=dark] .status[data-status=actions],[data-theme=dark] .status[data-status=insufficient]{color:#ffd18a}[data-theme=dark] .status[data-status=obstacle],[data-theme=dark] .error{color:#ffb3bd}[data-theme=dark] .image-open{background:#21314a}
@media(max-width:550px){.shell{padding:17px 12px calc(130px + env(safe-area-inset-bottom))}.card{padding:21px 19px;border-radius:28px;margin-bottom:15px}.page-heading{padding:0 4px;margin-bottom:19px}.page-heading small{font-size:.79rem}h1{font-size:1.6rem}.object-org{font-size:1.28rem}.fields{grid-template-columns:1fr}.wide{grid-column:auto}.assignment-fields{grid-template-columns:1fr}.assignment-fields .wide{grid-column:auto}.contact-fields{grid-template-columns:1fr}.contact-fields label:last-of-type{grid-column:auto}.sheet-header{padding:14px 14px calc(12px + env(safe-area-inset-top));gap:10px}.sheet-header h2{font-size:1rem}.sheet-header small{font-size:.76rem}.sheet-header .soft-button{font-size:.86rem;padding:10px 13px}.sheet-body{padding:20px 17px calc(32px + env(safe-area-inset-bottom))}.full-report-text{font-size:.94rem}.count strong{font-size:1.45rem}.count span{font-size:.72rem}.counts{gap:6px}.contact-note{grid-column:auto}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition:none!important;animation:none!important}button:active:not(:disabled){transform:none}}@media(prefers-reduced-transparency:reduce){.glass,.footer,.sheet-header{background:var(--solid);backdrop-filter:none;-webkit-backdrop-filter:none}}@media(prefers-contrast:more){.glass{border-color:var(--muted);background:var(--solid)}input,select,textarea{border-color:var(--muted)}.muted,small{color:var(--ink)}}
</style><script src="https://telegram.org/js/telegram-web-app.js"></script><script src="/auth.js"></script></head><body>
<main class="shell"><header class="page-heading"><button id="back" class="back" type="button" aria-label="Назад">←</button><div><h1 id="page-title">Передача юристу</h1><small id="page-subtitle">Объект, готовый комплект и ответственный</small></div></header><p id="readonly-note" class="info readonly-note" hidden>Просмотр материалов. Изменения и передача здесь недоступны.</p><p id="notice" class="notice" role="status" aria-live="polite"></p>
<div id="main-form"><section class="glass card" aria-labelledby="object-org"><p id="object-source" class="object-source"></p><h2 id="object-org" class="object-org">Загружаю объект…</h2><p id="object-address" class="object-address"></p><p id="object-meta" class="object-meta"></p><details id="details" class="details"><summary>Изменить сведения и контакты</summary><p id="historical-note" class="note" hidden></p><fieldset id="details-editable" class="details-editable"><div class="fields"><label class="wide">Организация<input id="org" autocomplete="organization"></label><label class="wide">Адрес объекта<input id="address" autocomplete="street-address"></label><label>ИНН<input id="inn" inputmode="numeric"></label><label>Кадастровый номер<input id="cad_num" placeholder="77:01:0000000:0000"></label><label>Регион<select id="region"><option value="">Выберите</option><option>МСК</option><option>МО</option><option>СПб</option></select></label><label>Тип объекта<select id="kind"><option value="">Выберите</option><option>Общепит</option><option>Магазин</option><option>Табак</option></select></label><label class="wide">Услуга<select id="service"><option value="">Выберите</option><option>Получение</option><option>Продление</option><option>Переоформление</option></select></label></div><h3 class="contacts-title">Контакты клиента</h3><p id="no-contacts" class="empty">В заявке нет сохранённых контактов.</p><div id="contacts"></div><button type="button" id="add-contact" class="text-button">＋ Добавить контакт</button></fieldset></details></section>
<section class="glass card" aria-labelledby="packet-title"><div class="card-header"><h2 id="packet-title">Комплект юристу</h2></div><p id="packet-loading" class="loading" role="status">Собираю сохранённые материалы…</p><div id="packet-error" hidden><p id="packet-error-text" class="error" role="alert"></p><button type="button" id="retry-load" class="soft-button">Повторить загрузку</button></div><div id="packet-content" hidden><div class="report-overview"><span id="report-status" class="status"></span><small id="report-date"></small></div><button type="button" id="open-report" class="outline-button full">Открыть полный отчёт</button><div id="packet-counts" class="counts"></div><div class="package-details"><p id="video-state"></p><p id="materials-state"></p><p id="egrn-state"></p><p id="archive-state" hidden></p></div><label id="egrn-order-box" class="check" hidden><input type="checkbox" id="egrn-order"><span>Заказать новую выписку ЕГРН<small>По кадастровому номеру <span id="egrn-cad"></span>. Это новый заказ у поставщика.</small></span></label><div class="packet-bottom"><button type="button" id="choose-report" class="text-button">Выбрать отчёт</button></div></div></section>
<section id="assignment" class="glass card" aria-labelledby="assignment-title"><div class="card-header"><h2 id="assignment-title">Кому передать</h2></div><div class="assignment-fields"><label>Юрист<select id="lawyers"><option value="">Выберите юриста</option></select></label><label>Приоритет<select id="priority"><option value="обычный">Обычный</option><option value="срочно">Срочно</option></select></label><label class="wide">Комментарий юристу <span class="muted">· необязательно</span><textarea id="comment" placeholder="Только то, что важно при передаче"></textarea></label></div><p id="lawyer-empty" class="error" hidden>Нет доступных юристов. Юристу нужно зарегистрироваться через /start в боте.</p><p id="form-error" class="error" role="alert" hidden></p></section></div>
<section id="review" hidden aria-labelledby="review-title"><h2 id="review-title" class="review-title">Проверьте передачу</h2><div class="glass card"><p class="review-eyebrow">Получатель в Telegram</p><h3 id="review-lawyer" class="review-lawyer"></h3><p class="review-eyebrow">Объект</p><h3 id="review-org"></h3><p id="review-address" class="review-address"></p><p id="review-meta" class="muted"></p><p class="review-eyebrow block-gap">Что получит юрист</p><ul id="review-list" class="review-list"></ul><p id="review-comment" class="review-comment"></p><div class="review-actions"><button type="button" id="confirm-send" class="primary full">Подтвердить передачу</button><button type="button" id="review-back" class="soft-button full">Вернуться к редактированию</button></div></div></section>
<section id="delivery" class="glass card delivery" hidden role="status"><h2 id="delivery-title"></h2><p id="delivery-text"></p><button type="button" id="retry-send" class="primary full">Повторить доставку</button></section></main>
<footer id="footer" class="footer"><div class="footer-inner"><button type="button" class="primary full" id="go" disabled>Передать юристу</button><small>Перед отправкой покажем получателя и состав комплекта</small></div></footer>
<dialog id="report-dialog" class="sheet" aria-labelledby="report-heading"><div class="sheet-inner"><header class="sheet-header"><div class="sheet-heading"><h2 id="report-heading">Отчёт аудитора</h2><small id="report-subtitle"></small></div><button type="button" id="report-close" class="soft-button">К передаче</button></header><nav class="sheet-tabs" aria-label="Разделы полного отчёта"><button type="button" id="jump-text">Текст</button><button type="button" id="jump-images">Схемы и фото</button><button type="button" id="jump-files">Файлы</button></nav><div id="report-body" class="sheet-body"><p id="report-address-note" class="note" hidden></p><pre id="report-text" class="full-report-text"></pre><a id="report-video" class="report-link" target="_blank" rel="noopener noreferrer" hidden>Смотреть видео ↗</a><a id="report-archive" class="report-link" target="_blank" rel="noopener noreferrer" hidden>Архив объекта ↗</a><a id="report-telegram" class="report-link" target="_blank" rel="noopener noreferrer" hidden>Оригинальные сообщения в Telegram ↗</a><h3 id="report-images-heading" class="report-section">Схемы, планы и фотографии</h3><p id="gallery-empty" class="empty"></p><div id="gallery"></div><h3 id="report-files-heading" class="report-section">Оригиналы и документы заявки</h3><p class="info">Нажмите на файл, чтобы скачать его целиком.</p><p id="originals-empty" class="empty">Сохранённых файлов нет.</p><div id="report-originals"></div><p id="report-notice" class="error" role="status"></p></div></div></dialog>
<dialog id="zoom-dialog" class="zoom-sheet" aria-labelledby="zoom-label"><div class="sheet-inner"><header class="sheet-header"><h2 id="zoom-label">Изображение</h2><button type="button" id="zoom-close" class="soft-button">Назад к отчёту</button></header><div class="zoom-toolbar"><button type="button" id="zoom-minus" aria-label="Уменьшить">−</button><span id="zoom-value">100%</span><button type="button" id="zoom-plus" aria-label="Увеличить">＋</button><button type="button" id="zoom-fit">Вписать</button></div><div class="zoom-content"><img id="zoom-image" alt=""></div></div></dialog>
<dialog id="search-dialog" class="sheet search-sheet" aria-labelledby="search-title"><div class="sheet-inner"><header class="sheet-header"><h2 id="search-title">Сохранённые отчёты</h2><button type="button" id="search-close" class="soft-button">Закрыть</button></header><div class="sheet-body"><label class="select-report-search">Название, адрес или ИНН<input type="search" id="report-query" autocomplete="off" placeholder="Найти отчёт"></label><p id="search-error" class="error" role="status"></p><button type="button" id="search-retry" class="text-button">Обновить поиск</button><div id="search-results"></div></div></div></dialog>
<script>window.HandoffModel=(${handoffModel.toString()})();(${handoffClient.toString()})();</script></body></html>`;
}

module.exports = handoffPage;
module.exports.client = handoffClient;
module.exports.model = handoffModel;
