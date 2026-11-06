'use strict';

const { esc } = require('./formatter');
const isGenericAudit = data => data?.ui_version === 5 && data.object_category === 'other';
const FLAGS = {
  chk_bti_match:'Фактическая планировка соответствует БТИ',chk_hall:'Торговый зал / зал обслуживания определён',
  chk_storage:'Подсобные и складские помещения определены',chk_no_replan:'Нет самовольных перепланировок',
  chk_clear_borders:'Границы объекта однозначно определимы',chk_cadastr:'Кадастровый номер не разделён',
  veranda:'Веранда',patz:'ПАТЗ',replan:'Перепланировка',passport_interest:'Интерес к паспорту безопасности',is_owner:'Собственник',
};
const CHOICES = {building_type:['Жилое','Нежилое','Не проверено'],boundaries:['Да','Нет','Под вопросом','Не проверено'],bti:['Да','Нет','Не проверено'],to:['Нужно','Не нужно','Не обязательно','Не проверено']};
function validateGenericAudit(data) {
  const p=data.inspection,w=data.workflow;
  if(!p||typeof p!=='object'||Array.isArray(p)||!w||typeof w!=='object'||Array.isArray(w))throw new Error('Проверьте сведения общего осмотра.');
  for(const [value,label]of [[p.org,'организацию'],[p.address,'адрес объекта'],[data.conclusion,'итог аудитора']])if(typeof value!=='string'||!value.trim()||value.length>6000)throw new Error('Укажите '+label+'.');
  for(const [key,values]of Object.entries(CHOICES))if(data[key]&& !values.includes(data[key]))throw new Error('Проверьте ответ: '+key+'.');
  for(const key of Object.keys(FLAGS))if(data[key]!=null&&typeof data[key]!=='boolean')throw new Error('Проверьте отметку характеристики объекта.');
  for(const value of [data.nearby,w.followup_notes,p.visit_date])if(value!=null&&(typeof value!=='string'||value.length>6000))throw new Error('Слишком длинное или некорректное поле осмотра.');
  if(!Array.isArray(data.zones)||data.zones.length>20||data.zones.some(zone=>!zone||typeof zone!=='object'||Array.isArray(zone)||Object.values(zone).some(value=>typeof value!=='string'||value.length>2000)))throw new Error('Проверьте сведения об организациях рядом.');
  if(!Array.isArray(data.evidence)||data.evidence.length>60)throw new Error('Проверьте комплект файлов отчёта.');
  const video=Object.hasOwn(w,'video_url')?w.video_url:data.video_url||'';
  if(video){try{if(typeof video!=='string'||video.length>2000||new URL(video).protocol!=='https:')throw new Error();}catch(_){throw new Error('Укажите полную HTTPS-ссылку на видео.');}}
  if(data.request_packet?.video_required&&!video)throw new Error('Менеджер запросил видео: приложите ссылку на Яндекс Диск.');
}
function buildGenericAuditSummary(data,actor) {
  const p=data.inspection||{},w=data.workflow||{},packet=data.request_packet||{},plain=[];
  const field=(label,value)=>{if(typeof value==='string'&&value.trim())plain.push(label+': '+value.trim());};
  plain.push('Общий осмотр · Другое'+(data.order_id?' · заявка #'+data.order_id:''));
  field('Организация',p.org||packet.org);field('Адрес',p.address||packet.address);field('Дата осмотра',p.visit_date);field('Аудитор',actor);
  plain.push('');field('Итог аудитора',data.conclusion);
  for(const [key,label]of [['building_type','Здание'],['boundaries','Границы помещения'],['bti','БТИ'],['to','ТО']])field(label,data[key]);
  for(const [key,label]of Object.entries(FLAGS))if(data[key]===true)plain.push('Отмечено аудитором: '+label);
  for(const zone of data.zones||[]){const name=String(zone.name||'').trim();if(name)plain.push('Организация рядом: '+[name,zone.dist,zone.info,zone.license].filter(Boolean).join(' · '));}
  field('На заметку',data.nearby);field('Клиент сообщил / дополнения',w.followup_notes);field('Видео',Object.hasOwn(w,'video_url')?w.video_url:data.video_url);
  if(packet.materials?.length)field('Документы заявки',packet.materials.map(file=>file.name).join('; '));
  return {plain:plain.join('\n'),html:plain.map(esc).join('\n')};
}
module.exports={isGenericAudit,validateGenericAudit,buildGenericAuditSummary};
