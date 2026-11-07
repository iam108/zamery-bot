const { esc } = require('./formatter');
const { followupTasks, CONCLUSIONS, TERRITORY_CLEAR_LABEL } = require('./audit-workflow');

const value = item => typeof item === 'string' || typeof item === 'number' ? String(item).trim() : '';
const answer = (item, yes, no, unknown = 'не проверено') => item === 'Да' ? yes : item === 'Нет' ? no : unknown;
const unique = items => [...new Set(items.map(value).filter(Boolean))];
function plural(count, one, few, many) {
  const n = Number(count);
  return n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
}
function visitDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value(date));
  return match ? match[3] + '.' + match[2] + '.' + match[1] : value(date) || 'не указана';
}
function sourceLink(source) {
  try {
    const url = new URL(source);
    if (['https:', 'http:'].includes(url.protocol) && url.href.length <= 1000) return '<a href="' + esc(url.href).replace(/"/g, '&quot;') + '">Источник сведений</a>';
  } catch (_) {}
  return esc(source);
}

// A projection of the auditor's recorded facts. It never changes answers,
// guesses an action from free text or checks an address inside an image.
function buildAuditSummary(data, actor) {
  const {isGenericAudit,buildGenericAuditSummary}=require('./audit-generic');
  if(isGenericAudit(data))return buildGenericAuditSummary(data,actor);
  const p = data.inspection || {}, w = data.workflow || {}, packet = data.request_packet || {};
  const html = [], plain = [];
  const pair = (formatted, text) => { html.push(formatted); plain.push(text); };
  const line = text => pair(esc(text), text);
  const blank = () => pair('', '');
  const heading = text => pair('<b>' + esc(text) + '</b>', text);
  const field = (label, text) => { if (value(text)) line(label + ': ' + text); };
  const marks = data.map?.annotations || [];
  const code = (item, tool) => value(marks.find(mark => mark.id === (item.mark_id || item.id) && mark.tool === tool)?.code);
  const entrances = data.entrances || [], zones = data.zones || [];
  const org = value(p.org || packet.org) || 'Организация не указана';
  const address = value(p.address || packet.address) || 'адрес не указан';
  const service = value(p.service || packet.service) || (data.object_category === 'tobacco' ? 'Проверка объекта' : 'услуга не указана');
  const category = { catering: 'алкоголь · общепит', retail: 'алкоголь · магазин', tobacco: 'табак' }[data.object_category] || 'тип объекта не указан';
  const number = data.order_id ? '№' + value(data.order_id) : 'аудитора';
  pair('<b>' + esc(org + ' · отчёт ' + number) + '</b>', 'Отчёт аудитора' + (data.order_id ? ' №' + value(data.order_id) : ''));
  plain.push('Организация: ' + org);
  pair(esc(service + ' · ' + category), 'Услуга: ' + service);
  plain.push('Тип объекта: ' + category);
  pair(esc(visitDate(p.visit_date) + ' · аудитор ' + (value(actor) || 'не указан')), 'Дата осмотра: ' + visitDate(p.visit_date));
  plain.push('Аудитор: ' + (value(actor) || 'не указан'));
  pair('📍 <b>По заявке:</b> ' + esc(address), 'Адрес: ' + address);

  blank();
  const outcome = CONCLUSIONS[w.conclusion_status] || 'Результат не указан';
  const icon = { ready: '🟢', actions: '🟠', insufficient: '🟡', obstacle: '🔴' }[w.conclusion_status] || '⚪';
  pair(icon + ' <b>Итог аудитора: ' + esc(outcome.toLowerCase()) + '</b>', 'Результат аудитора: ' + outcome);
  const tasks = followupTasks(data), labels = unique(tasks.map(task => task.label));
  labels.forEach(label => line('• ' + label));
  if (value(w.mitigation)) field('Предлагаемые действия', w.mitigation);
  if (w.conclusion_status === 'actions' && !labels.length && !value(w.mitigation)) {
    line('Конкретное действие не указано.');
    line('Уточнить причину выбранного итога.');
  }

  blank(); heading('По осмотру');
  line((value(data.building_type) ? value(data.building_type) + ' здание' : 'Тип здания не указан') +
    ' · этаж: план ' + (value(p.floor_plan) || 'не указан') + ' / факт ' + (value(p.floor_actual) || 'не указан'));
  const cadastral = value(p.cadastral_count);
  line((cadastral ? cadastral + ' ' + plural(cadastral, 'кадастр', 'кадастра', 'кадастров') : 'Количество кадастров не указано') + ' · ' +
    answer(p.rooms_complete, 'вся площадь входит в объект', 'не вся площадь входит в объект', 'полнота площади не отмечена'));
  if (Number(p.cadastral_count) > 1) field('Граница между кадастрами', p.inter_cadastral_boundary || 'не отмечена');
  line(answer(p.within_cadastral, 'Границы соблюдены', 'Границы нарушены', 'Границы не проверены') + ' · ' +
    answer(data.bti, 'планировка совпадает', 'есть изменения планировки', 'планировка не проверена'));
  const to = data.to === 'Нужно' ? 'ТО требуется' : data.to === 'Не нужно' ? 'ТО не нужно' : 'Необходимость ТО не отмечена';
  const kkt = value(p.kkt_count);
  line(to + ' · ' + (kkt ? kkt + ' ' + plural(kkt, 'касса', 'кассы', 'касс') : 'количество касс не указано') +
    ' · ' + answer(p.kkt_ip, 'есть касса ИП', 'кассы ИП нет', 'наличие кассы ИП не отмечено'));
  if (value(p.plan_note) && !tasks.some(task => task.id === 'plan-mismatch')) field('По плану', p.plan_note);
  field('Стены и перегородки', p.structural_elements);
  field('Основание по стенам', data.plan?.wall_basis);
  field('Состояние помещения', p.repair_state);
  field('Риски', p.risks);

  if (data.object_category === 'tobacco') {
    line('Табак: выкладка — ' + (value(p.tobacco_display).toLowerCase() || 'не проверена') +
      '; перечень цен — ' + (value(p.tobacco_price_list).toLowerCase() || 'не проверен') +
      '; реклама — ' + (value(p.tobacco_advertising).toLowerCase() || 'не проверена'));
  } else if (p.alcohol_present === 'Нет') line('Алкоголя на объекте нет');
  else if (p.alcohol_present === 'Да' && service === 'Продление') {
    line(answer(p.alcohol_within_licensed, 'Алкоголь в лицензированной зоне', 'Алкоголь за пределами лицензированной зоны', 'Алкоголь есть; размещение в лицензированной зоне не проверено'));
  } else line(p.alcohol_present === 'Да' ? 'Алкоголь на объекте есть' : 'Наличие алкоголя не проверено');

  if (service === 'Продление') {
    if (w.archive_skipped === 'Да') line('Архив: сверка пропущена');
    else {
      line('Архив: ' + answer(p.archive_match, 'планировка совпадает', 'есть расхождения', p.archive_match === 'Не проверено' ? 'сверка не выполнена' : 'результат сверки не отмечен'));
      line('Лицензированные границы: ' + answer(p.licensed_boundaries_match, 'сохранены', 'есть расхождения', p.licensed_boundaries_match === 'Не проверено' ? 'не проверены' : 'результат сверки не отмечен'));
    }
  }

  blank(); heading('Территория');
  if (w.territory_result === 'clear') line(TERRITORY_CLEAR_LABEL);
  if (w.territory_result === 'findings' && data.map?.mode === 'attached') line('Готовая схема территории приложена.');
  const entranceNames = entrances.map(item => {
    const mark = code(item, 'entrance'), name = value(item.label);
    return mark ? mark + (name && !/^Вход\s*\d+$/i.test(name) && name !== mark ? ' — ' + name : '') : name || 'без отметки';
  });
  line((entrances.length === 1 ? 'Вход: ' : 'Входы: ') + (entranceNames.join('; ') || 'не отмечены'));
  for (const item of entrances) {
    const notes = unique([item.location, item.notes, ['Нет доступа', 'Не осмотрен'].includes(item.access) ? item.access : '']);
    if (notes.length) field(code(item, 'entrance') || value(item.label) || 'Вход', notes.join(' · '));
  }
  const measurements = marks.filter(mark => ['route', 'straight'].includes(mark.tool));
  if (!zones.length && w.territory_result !== 'clear') line('Организации не перечислены.');
  for (const zone of zones) {
    const status = { clear: 'без замечаний', checked: 'без замечаний', licensed: 'есть сведения о лицензии', disputed: 'спорное место', confirmed: 'отмечено ограничение', pending: 'нужно уточнить', other: 'наблюдение' }[zone.status] || 'результат не указан';
    const distances = measurements.filter(mark => mark.toObjectId === zone.id || mark.toObjectId === zone.mark_id).map(mark => value(mark.distance));
    const dist = value(zone.dist), distance = dist && !distances.includes(dist) ? '; ' + (dist === 'Не проверено' ? 'расстояние не проверено' : dist + ' м') : '';
    const entrance = w.territory_result === 'findings' && !distances.length && entrances.find(item => item.id === zone.entrance_id);
    const origin = entrance && (code(entrance, 'entrance') || value(entrance.label));
    line('• ' + [code(zone, 'hazard'), value(zone.name) || 'Организация'].filter(Boolean).join(' · ') + ' — ' + status + distance + (origin ? ' от входа «' + origin + '»' : ''));
    if (value(zone.source)) pair('  ' + sourceLink(value(zone.source)), 'Источник: ' + value(zone.source));
    unique([zone.resolution, zone.note, zone.info]).forEach(note => line('  ' + note));
    if (value(zone.method) && !distances.length) field('Способ замера', zone.method);
    if (value(zone.points) && !distances.length) field('Точки замера', zone.points);
  }
  for (const mark of measurements) {
    const from = entrances.find(item => item.id === mark.fromEntranceId || item.mark_id === mark.fromEntranceId);
    const to = zones.find(item => item.id === mark.toObjectId || item.mark_id === mark.toObjectId);
    const endpoints = [from && (code(from, 'entrance') || value(from.label)), to && (code(to, 'hazard') || value(to.name))].filter(Boolean).join(' → ');
    line([value(mark.code) || 'Замер', endpoints, value(mark.distance) ? value(mark.distance) + ' м' : 'расстояние не указано', mark.tool === 'straight' ? 'прямая линия' : 'путь замера'].filter(Boolean).join(' · '));
  }
  field('Аудитор сообщил', w.territory_notes);

  const comment = typeof data.conclusion === 'string' ? data.conclusion : '';
  if (comment.trim() && comment.trim() !== outcome) { blank(); heading('Комментарий аудитора'); line(comment); }
  field('Клиент сообщил / договорённости', w.followup_notes);
  field('Дополнение аудитора', data.t_comment);
  field('На заметку', data.nearby);
  const extras = [[data.veranda, 'веранда'], [data.patz, 'ПАТЗ'], [data.replan, 'перепланировка отмечена'],
    [data.passport_interest, 'интерес к паспорту безопасности'], [data.is_owner, 'собственник']].filter(([on]) => on).map(([, title]) => title);
  if (extras.length) field('Дополнительно', extras.join(' · '));

  // Handoff retains exact references; Telegram displays their dedicated buttons.
  const video = Object.hasOwn(w, 'video_url') ? w.video_url : data.video_url;
  if (value(video)) plain.push('Видео: ' + value(video));
  if (value(video) && p.video_status && p.video_status !== 'Сделано') field('Состояние видео', p.video_status);
  if (service === 'Продление' && value(packet.archive_url || p.archive_url)) plain.push('Архивная папка: ' + value(packet.archive_url || p.archive_url));
  if (data.plan?.page) plain.push('Основной план: лист ' + data.plan.page);
  for (const plan of data.additional_plans || []) plain.push('Дополнительный план: лист ' + plan.page);
  return { html: html.join('\n'), plain: plain.join('\n') };
}

// The brief is a separate projection for fresh delivery versions. Keep the
// full summary above unchanged: old partial deliveries depend on its chunks,
// and saved reports/original archives must retain every recorded observation.
function briefText(item, limit) {
  const text=value(item).replace(/\s+/g,' ');
  if(esc(text).length<=limit)return text;
  let result='',length=0;
  for(const character of text){const size=esc(character).length;if(length+size>limit-1)break;result+=character;length+=size;}
  return result.trimEnd()+'…';
}

function buildAuditBrief(data, actor) {
  const {isGenericAudit}=require('./audit-generic'),generic=isGenericAudit(data);
  const p=data.inspection||{},w=data.workflow||{},packet=data.request_packet||{},html=[],plain=[];
  const line=(text,limit=220,bold=false)=>{const short=briefText(text,limit);html.push(bold?'<b>'+esc(short)+'</b>':esc(short));plain.push(short);};
  const blank=()=>{html.push('');plain.push('');};
  const org=briefText(p.org||packet.org||'Организация не указана',160),number=data.order_id?'№'+briefText(data.order_id,20):'аудитора';
  line(org+' · отчёт '+number,210,true);
  const service=value(p.service||packet.service)||(data.object_category==='tobacco'?'Проверка объекта':'услуга не указана');
  const category={catering:'алкоголь · общепит',retail:'алкоголь · магазин',tobacco:'табак'}[data.object_category]||'тип объекта не указан';
  line(generic?'Общий осмотр · Другое':service+' · '+category,110);
  line('📍 '+value(p.address||packet.address||'адрес не указан'),245);
  const outcome=CONCLUSIONS[w.conclusion_status]||'Результат не указан';
  if(generic)line('Итог аудитора: '+(value(data.conclusion)||'не указан'),310,true);
  else{
    const icon={ready:'🟢',actions:'🟠',insufficient:'🟡',obstacle:'🔴'}[w.conclusion_status]||'⚪';
    line(icon+' Итог аудитора: '+outcome.toLowerCase(),110,true);
  }

  blank();
  const building=['Жилое','Нежилое'].includes(data.building_type)?data.building_type.toLowerCase():'не отмечено';
  const to={'Нужно':'требуется','Не нужно':'не требуется','Не обязательно':'не обязательно'}[data.to]||'не проверено';
  const facts=['Здание: '+building,'ТО: '+to];
  if(!generic){
    if(data.object_category==='tobacco'){
      facts.push('Выкладка: '+(['Закрытая','Открытая','Товара нет'].includes(p.tobacco_display)?p.tobacco_display.toLowerCase():'не проверена'));
      facts.push('Перечень цен: '+({'Есть':'есть','Нет':'нет'}[p.tobacco_price_list]||'не проверен'));
      facts.push('Реклама: '+({'Есть':'есть','Нет':'нет'}[p.tobacco_advertising]||'не проверена'));
    }else facts.push('Алкоголь: '+answer(p.alcohol_present,'есть','нет','наличие не проверено'));
  }
  line(facts.join(' · '),230);

  if(!generic){
    const entrances=Array.isArray(data.entrances)?data.entrances:[],zones=Array.isArray(data.zones)?data.zones:[];
    const inspected=entrances.filter(entrance=>entrance.access==='Осмотрен').length;
    const plan=answer(data.bti,'совпадает','есть расхождения','не проверен');
    const territory=w.territory_result==='clear'&&!zones.length?'зон и спорных объектов не выявлено':w.territory_result==='findings'&&zones.length?'описано '+zones.length+' организаций':w.territory_result==='clear'&&zones.length?'ответы расходятся':'результат не отмечен';
    line('Осмотр: входы '+inspected+' из '+entrances.length+' · план: '+plan+' · территория: '+territory,220);

    const issues=require('./audit-workflow').compactReportIssues(data);
    const label=issue=>issue.id==='floor-mismatch'?'Этаж: по плану '+(value(p.floor_plan)||'не указан')+', фактически '+(value(p.floor_actual)||'не указан')+'.':issue.label;
    const actions=unique(issues.filter(issue=>issue.kind==='adverse').map(label));
    if(value(w.mitigation))actions.unshift('Предлагает аудитор: '+value(w.mitigation));
    const questions=unique(issues.filter(issue=>issue.kind==='unverified'||issue.kind==='missing_required').map(label));
    if(w.conclusion_status==='actions'&&!actions.length){
      actions.push('Конкретные действия не указаны.');questions.push('Уточнить причину выбранного итога.');
    }
    const list=(heading,items,limit,cap)=>{
      if(!items.length)return;blank();line(heading,50,true);
      items.slice(0,limit).forEach(item=>line('• '+item,cap));
      if(items.length>limit)line('Ещё '+(items.length-limit)+' пунктов — в полном отчёте.',70);
    };
    list('Замечания / действия',actions,3,150);
    list('Уточнить юристу',questions,2,140);
    if(w.conclusion_status==='ready'&&!actions.length&&!questions.length)line('Замечаний по проверенным пунктам не отмечено.',100);
    const comment=value(data.conclusion);
    if(comment&&comment!==outcome){blank();line('Комментарий аудитора: '+comment,160);}
  }
  blank();line((value(p.visit_date)?visitDate(p.visit_date)+' · ':'')+'Аудитор: '+(value(actor)||'не указан'),100);
  const originals=(Array.isArray(data.documents)&&data.documents.length)||(Array.isArray(data.evidence)&&data.evidence.length);
  line(originals?'Полный текст и исходники — в приложениях к отчёту.':'Полный текст — в приложенном файле отчёта.',80);
  return{html:html.join('\n'),plain:plain.join('\n')};
}

module.exports = { buildAuditSummary, buildAuditBrief };
