'use strict';

const { STAGES } = require('../checklists');
const MAX_CASES = 3, MAX_RECIPIENTS = 6;
// One statement gives assignment, staff access and saved receipts the same
// snapshot. Project only operational fields; never load contacts or documents.
const STATUS_SQL = `SELECT o.id AS order_id,o.status AS order_status,o.telegram_msg_id AS order_message_id,o.created_at AS order_created_at,
  c.id AS case_id,c.lawyer_tg_id,c.lawyer_name,c.created_by,c.created_at AS case_created_at,c.case_completed_at,c.case_status,c.case_stage,c.total_cases,
  s.tg_id AS staff_tg_id,s.name AS staff_name,s.username AS staff_username,s.role AS staff_role,s.approved AS staff_approved,
  c.checkpoint IS NOT NULL AND c.checkpoint<>'null'::jsonb AS has_checkpoint,
  c.checkpoint->'version' AS checkpoint_version,c.checkpoint->'completed' AS completed,
  COALESCE(c.checkpoint->'manual_review' NOT IN ('null'::jsonb,'false'::jsonb,'""'::jsonb),false) AS manual_review,
  c.checkpoint->'inflight'->>'type' AS inflight_type,c.checkpoint->'inflight'->>'chat' AS inflight_chat,
  c.checkpoint->'inflight' IS NOT NULL AND c.checkpoint->'inflight'<>'null'::jsonb AS inflight,
  c.checkpoint->'recipients' AS recipients,c.checkpoint->'cards' AS cards,
  c.checkpoint->'auditCopies' AS audit_copies,c.checkpoint->'requestCopies' AS request_copies,
  c.checkpoint#>'{materials,confirmed}' AS material_receipts,c.checkpoint#>'{materials,completed}' AS materials_completed,
  c.checkpoint#>'{materials,inflight}' AS materials_inflight,c.checkpoint#>'{materials,parts}' AS material_parts,
  c.checkpoint#>'{materials,files}' AS material_files,
  c.checkpoint#>'{linkedEgrn,confirmed}' AS linked_receipts,c.checkpoint#>'{linkedEgrn,completed}' AS linked_completed,
  CASE WHEN jsonb_typeof(COALESCE(c.checkpoint#>'{linkedEgrn,files}',c.checkpoint#>'{packet,egrn_links}'))='array'
    THEN jsonb_array_length(COALESCE(c.checkpoint#>'{linkedEgrn,files}',c.checkpoint#>'{packet,egrn_links}')) END AS linked_files,
  c.checkpoint#>'{egrn,completed}' AS egrn_completed,c.checkpoint#>>'{egrn,result}' AS egrn_result,
  c.checkpoint#>'{egrn,order_started}' AS egrn_order_started,c.checkpoint#>'{egrn,uncertain}' AS egrn_uncertain,
  c.checkpoint#>'{egrn,copies}' AS egrn_copies
FROM orders o LEFT JOIN LATERAL (
  SELECT id,lawyer_tg_id,lawyer_name,created_by,created_at,to_jsonb(cases)->>'completed_at' AS case_completed_at,
    to_jsonb(cases)->>'status' AS case_status,data->>'_stage' AS case_stage,data->'_handoff' AS checkpoint,COUNT(*) OVER() AS total_cases
  FROM cases WHERE order_id=o.id ORDER BY id DESC LIMIT ${MAX_CASES}
) c ON true LEFT JOIN staff s ON s.tg_id=c.lawyer_tg_id WHERE o.id=$1 ORDER BY c.id DESC`;

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const positive = value => (typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value)>0;
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value>=0 ? String(value) : '?';
const flag = value => value===true?'да':value===false?'нет':'неизвестно';
const chatId = value => ['number','string'].includes(typeof value) && /^-?[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : null;
const id = value => positive(value)?String(value):'—';
const label = value => typeof value==='string'&&value.trim()?value.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,80):'—';
const date = value => { const parsed=new Date(value);return value!=null&&Number.isFinite(parsed.getTime())?parsed.toISOString():'неизвестно'; };
const receipts = value => new Set((Array.isArray(value)?value:[]).filter(positive).map(String)).size;
function copyCount(value) {
  const checkpoint=object(value);
  return receipts([...(Array.isArray(checkpoint.messageIds)?checkpoint.messageIds:[]),
    ...Object.values(object(checkpoint.sources)).flatMap(source=>Array.isArray(source?.messageIds)?source.messageIds:[])]);
}
function egrnCopies(value) {
  const counts=new Map();
  for(const [key,confirmed] of Object.entries(object(value))) {
    if(confirmed!==true)continue;
    try { const parsed=JSON.parse(key),chat=Array.isArray(parsed)&&chatId(parsed[0]);if(chat)counts.set(chat,(counts.get(chat)||0)+1); } catch (_) {}
  }
  return counts;
}
function caseLines(row) {
  const role=['manager','lawyer','auditor'].includes(row.staff_role)?row.staff_role:'неизвестно';
  const lines=['','Клиент #'+id(row.case_id)+' · создан UTC '+date(row.case_created_at),
    'Этап '+(STAGES.includes(row.case_stage)?row.case_stage:row.case_stage?'unknown':'Сбор документов')+' · status '+(row.case_status==null?'не хранится':label(row.case_status))+' · completed_at UTC '+(row.case_completed_at==null?'—':date(row.case_completed_at)),
    'Назначен TG '+id(row.lawyer_tg_id)+' · staff '+(row.staff_tg_id!=null?'найден':'нет')+' · роль '+role+' · approved '+flag(row.staff_approved),
    'staff: '+label(row.staff_name)+' · '+(typeof row.staff_username==='string'&&/^[a-z\d_]{1,32}$/i.test(row.staff_username)?'@'+row.staff_username:'username не указан')+' · сохранённый юрист: '+label(row.lawyer_name),
    'Создал TG '+id(row.created_by)];
  if(row.has_checkpoint!==true) { lines.push('Checkpoint: legacy/unknown; квитанций передачи нет. Доставка не подтверждена.');return lines; }
  const version=Number.isInteger(row.checkpoint_version)&&row.checkpoint_version>0&&row.checkpoint_version<=100?String(row.checkpoint_version):'unknown';
  lines.push('Checkpoint v'+version+' · completed '+flag(row.completed)+' · manual_review '+flag(row.manual_review));
  lines.push('Получатель checkpoint совпадает с назначенным: '+(Array.isArray(row.recipients)?flag(row.recipients.some(target=>chatId(target?.chat)===chatId(row.lawyer_tg_id))):'неизвестно'));
  if(version!=='2')lines.push('Старый/неизвестный формат: доставка по этим данным не подтверждается.');
  const type=['card','audit','request','linked-egrn'].includes(row.inflight_type)?row.inflight_type:'unknown';
  lines.push('inflight '+flag(row.inflight)+(row.inflight===true?' · '+type+' · TG '+(chatId(row.inflight_chat)||'?'):''));
  lines.push('Материалы: completed '+flag(row.materials_completed)+' · inflight '+flag(row.materials_inflight)+' · файлов '+count(row.material_files)+' · ZIP-частей '+count(row.material_parts));
  lines.push('Связанные ЕГРН: completed '+flag(row.linked_completed)+' · файлов '+count(row.linked_files));
  const result=['included','included-links','none','missing','attached','ordered','waiting','unavailable'].includes(row.egrn_result)?row.egrn_result:'unknown';
  lines.push('ЕГРН: '+result+' · completed '+flag(row.egrn_completed)+' · order_started '+flag(row.egrn_order_started)+' · uncertain '+flag(row.egrn_uncertain));
  const maps=[row.cards,row.audit_copies,row.request_copies,row.material_receipts,row.linked_receipts].map(object),copies=egrnCopies(row.egrn_copies);
  const targets=new Set([chatId(row.lawyer_tg_id),...(Array.isArray(row.recipients)?row.recipients:[]).map(target=>chatId(target?.chat)),...maps.flatMap(map=>Object.keys(map).map(chatId)),...copies.keys()].filter(Boolean));
  for(const chat of [...targets].slice(0,MAX_RECIPIENTS)) {
    const linked=Object.values(object(object(row.linked_receipts)[chat])).filter(receipt=>positive(receipt?.message_id)||typeof receipt?.legacy_receipt==='string'&&receipt.legacy_receipt.length>0).length;
    lines.push('TG '+chat+': карточка '+(positive(object(row.cards)[chat])?'1 (msg '+id(object(row.cards)[chat])+')':'0')+
      '; отчёт '+copyCount(object(row.audit_copies)[chat])+'; заявка '+copyCount(object(row.request_copies)[chat])+
      '; ZIP '+receipts(object(row.material_receipts)[chat])+'/'+count(row.material_parts)+'; ЕГРН-ссылки '+linked+'/'+count(row.linked_files)+'; ЕГРН-копии '+(copies.get(chat)||0));
  }
  if(targets.size>MAX_RECIPIENTS)lines.push('Ещё получателей в checkpoint: '+(targets.size-MAX_RECIPIENTS)+'.');
  return lines;
}
function createHandoffStatusAdmin(options={}) {
  const pool=options.pool||require('../db/pool');
  return async function status(ctx) {
    const configured=typeof options.adminIds==='function'?options.adminIds():options.adminIds??process.env.ADMIN_TG_IDS??'';
    const admins=Array.isArray(configured)?configured.map(String):String(configured).split(/[\s,;]+/).filter(Boolean);
    if(ctx.chat?.type!=='private'||!admins.includes(String(ctx.from?.id)))return;
    const match=String(ctx.message?.text||'').match(/^\/handoff_status(?:@[a-z\d_]+)?\s+([1-9]\d*)\s*$/i);
    if(!match||!positive(match[1])||Number(match[1])>2147483647)return ctx.reply('Проверить передачу: /handoff_status номер_заявки');
    let rows;
    try { rows=(await pool.query(STATUS_SQL,[Number(match[1])])).rows; }
    catch (_) { return ctx.reply('Не удалось прочитать состояние передачи. Данные и доставка не изменялись.'); }
    if(!rows.length)return ctx.reply('Заявка #'+match[1]+' не найдена. Данные и доставка не изменялись.');
    const order=rows[0],orderStatus=['new','in_progress','done','cancelled'].includes(order.order_status)?order.order_status:'unknown';
    const lines=['Передача заявки #'+id(order.order_id),'Заявка: '+orderStatus+' · карточка msg '+id(order.order_message_id)+' · создана UTC '+date(order.order_created_at)];
    if(order.case_id==null)lines.push('Клиенты по этой заявке не найдены.');
    else {lines.push('Клиентов по заявке: '+String(order.total_cases)+'; показаны последние '+rows.length+'.');for(const row of rows)lines.push(...caseLines(row));}
    lines.push('','Это сохранённые статусы и квитанции БД. Наличие сообщений в Telegram не проверялось. Ничего не отправлено повторно.');
    let text='';for(const line of lines){if(text.length+line.length+1>3500){await ctx.reply(text);text='';}text+=(text?'\n':'')+line;}if(text)await ctx.reply(text);
  };
}
function setupHandoffStatusAdmin(bot,options={}) {
  const status=createHandoffStatusAdmin(options);bot.command('handoff_status',status);return status;
}
module.exports={createHandoffStatusAdmin,setupHandoffStatusAdmin,STATUS_SQL,MAX_CASES};
