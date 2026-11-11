'use strict';

const {createHash}=require('node:crypto');
const {getSessionLockPool}=require('../db/session-lock-pool');
const {canManageCases,canAccessCase}=require('../web/auth');
const {cardText,cardOptions}=require('../web/handoff-submit');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const positive=value=>/^[1-9]\d*$/.test(String(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const TTL=10*60*1000;
function problem(message){throw Object.assign(new Error(message),{code:'HANDOFF_COMPANY_BLOCKED'});}
function company(value){if(typeof value!=='string'||!value.trim()||value.trim().length>500||/[\x00-\x1f\x7f]/.test(value))problem('Укажите наименование организации одной строкой, до 500 символов.');return value.trim();}
function admin(options,id){const value=typeof options.adminIds==='function'?options.adminIds():options.adminIds??process.env.ADMIN_TG_IDS??'';return (Array.isArray(value)?value:String(value).split(/[\s,;]+/)).map(String).includes(String(id));}
const LOAD=`SELECT c.*,actor.tg_id AS actor_id,actor.role AS actor_role,actor.approved AS actor_approved,
  lawyer.role AS recipient_role,lawyer.approved AS recipient_approved
  FROM cases c LEFT JOIN staff actor ON actor.tg_id=$2 LEFT JOIN staff lawyer ON lawyer.tg_id=c.lawyer_tg_id WHERE c.id=$1`;
function createHandoffCompanyService(options={}){
  const pool=options.pool||require('../db/pool'),telegram=()=>options.telegram||require('./instance').telegram;
  const now=options.now||Date.now;
  async function load(client,id,actor){
    if(!positive(id)||Number(id)>2147483647||!positive(actor)||!admin(options,actor))problem('Команда доступна только настроенному администратору.');
    const c=(await client.query(LOAD,[id,actor])).rows[0],s=object(object(c?.data)._handoff),lawyer=String(c?.lawyer_tg_id||'');
    if(!c||!canManageCases({role:c.actor_role,approved:c.actor_approved},actor)||!canAccessCase({role:c.recipient_role,approved:c.recipient_approved},lawyer,c))problem('Доступ администратора или назначенного юриста изменился.');
    if(s.version!==2||s.completed!==true||s.inflight||s.manual_review||s.materials?.inflight||s.body?.lawyer_tg_id==null||String(s.body.lawyer_tg_id)!==lawyer||Number(s.body.order_id||0)!==Number(c.order_id||0)||s.body.submit_id!==c.handoff_submit_id||!positive(s.cards?.[lawyer])||!s.fields||!s.packet)problem('Нельзя изменить незавершённую или изменившуюся передачу.');
    const notice=s.groupNotice,target=String(options.clientsChatId??process.env.CLIENTS_CHAT_ID??'');
    if(notice?.status!=='confirmed'||notice.intent||!positive(notice.receipt?.message_id)||!/^-[1-9]\d*$/.test(target)||notice.target!==target||String(notice.receipt.chat_id)!==target||typeof notice.text!=='string'||(notice.text.match(/^Организация:.*$/gm)||[]).length!==1)problem('Не подтверждены существующие сообщения передачи. Повторная отправка не выполняется.');
    if(!Array.isArray(c.contacts)||!Array.isArray(s.packet.materials))problem('Сохранённая карточка требует отдельной проверки.');
    return {c,s,privateChat:lawyer,privateId:Number(s.cards[lawyer]),groupChat:target,groupId:Number(notice.receipt.message_id)};
  }
  function view(row,newOrg){
    const {c,s}=row,updated={...c,org:newOrg},groupText=s.groupNotice.text.replace(/^Организация:.*$/m,()=> 'Организация: '+newOrg);
    return {case_id:Number(c.id),old_org:c.org,new_org:newOrg,lawyer_id:String(c.lawyer_tg_id),lawyer_name:c.lawyer_name,
      private_message_id:row.privateId,group_message_id:row.groupId,group_chat:row.groupChat,
      private_text:cardText(updated,s),group_text:groupText,revision:digest({c:{...c,data:undefined},checkpoint:s,new_org:newOrg})};
  }
  async function preview(id,newOrg,actor){return view(await load(pool,id,actor),company(newOrg));}
  async function edit(chat,id,text,extra){
    let timer;
    try{const receipt=await Promise.race([Promise.resolve().then(()=>telegram().editMessageText(chat,id,undefined,text,extra)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Edit timeout')),options.timeoutMs||10000);})]);
      if(!receipt||Array.isArray(receipt)||Number(receipt.message_id)!==id||String(receipt.chat?.id)!==chat)throw new Error('Unconfirmed edit');
    }catch(error){if(error?.response?.error_code!==400||!/message is not modified/i.test(String(error?.response?.description||'')))throw error;}
    finally{clearTimeout(timer);}
  }
  async function apply(expected,actor){
    if(!expected||!/^[a-f\d]{64}$/.test(expected.revision||''))problem('Сначала откройте предварительный просмотр.');
    let row=await load(pool,expected.case_id,actor),client,locked=false,unlockError;
    const key=String(row.c.created_by)+':'+row.c.handoff_submit_id;
    try{
      client=await getSessionLockPool(pool,options.lockPool,'company-correction').connect();
      locked=!!(await client.query('SELECT pg_try_advisory_lock(111,hashtext($1)) AS locked',[key])).rows[0]?.locked;
      if(!locked)problem('Передача обновляется. Откройте предварительный просмотр позднее.');
      row=await load(client,expected.case_id,actor);
      const current=view(row,company(expected.new_org));
      if(current.revision!==expected.revision||current.old_org!==expected.old_org||current.lawyer_id!==expected.lawyer_id)problem('Карточка изменилась после просмотра. Нужен новый предварительный просмотр.');
      const {c}=row;let s=row.s;
      if(s.companyCorrection?.completed&&s.companyCorrection.new_org===expected.new_org&&c.org===expected.new_org)return {complete:true,unchanged:true};
      const previous=s.companyCorrection,newState=structuredClone(s);
      newState.body.org=expected.new_org;newState.fields.org=expected.new_org;
      newState.companyCorrection=previous?.new_org===expected.new_org&&c.org===expected.new_org?previous:{old_org:c.org,new_org:expected.new_org,actor_id:String(actor),at:new Date(now()).toISOString(),private_updated:false,group_updated:false,completed:false};
      const saved=await client.query("UPDATE cases SET org=$1,handoff_signature=$2,data=jsonb_set(data,'{_handoff}',$3::jsonb) WHERE id=$4 AND org=$5 AND lawyer_tg_id=$6 AND data->'_handoff'=$7::jsonb RETURNING id",[expected.new_org,digest(newState.body),JSON.stringify(newState),c.id,c.org,c.lawyer_tg_id,JSON.stringify(s)]);
      if(!saved.rows.length)problem('Карточка изменилась. Нужен новый просмотр.');
      s=newState;
      const fresh=async()=>{const checked=await load(client,c.id,actor);if(checked.c.org!==expected.new_org||checked.privateChat!==row.privateChat||checked.privateId!==row.privateId||checked.groupId!==row.groupId||canonical(checked.s)!==canonical(s))problem('Карточка или получатель изменились. Редактирование остановлено.');return checked;};
      const record=async(next)=>{const result=await client.query("UPDATE cases SET data=jsonb_set(data,'{_handoff}',$1::jsonb) WHERE id=$2 AND org=$3 AND lawyer_tg_id=$4 AND data->'_handoff'=$5::jsonb RETURNING id",[JSON.stringify(next),c.id,expected.new_org,c.lawyer_tg_id,JSON.stringify(s)]);if(!result.rows.length)problem('Название сохранено, но результат обновления сообщений требует проверки.');s=next;};
      try{
        if(!s.companyCorrection.private_updated){const checked=await fresh();await edit(row.privateChat,row.privateId,cardText(checked.c,s),cardOptions(options.webappUrl||process.env.WEBAPP_URL,checked.c,s));const next=structuredClone(s);next.companyCorrection.private_updated=true;await record(next);}
        if(!s.companyCorrection.group_updated){await fresh();await edit(row.groupChat,row.groupId,current.group_text,{disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:s.body.manual_client===true?'Открыть клиента':'Открыть клиента и отчёт',url:'https://t.me/LRSZamer_bot?start=case_'+c.id}]]}});const next=structuredClone(s);next.groupNotice.text=current.group_text;next.companyCorrection.group_updated=true;await record(next);}
        await fresh();const next=structuredClone(s);next.companyCorrection.completed=true;await record(next);return{complete:true};
      }catch(_){return{complete:false,warning:'Название в карточке сохранено. Обновление существующих сообщений не завершено: проверьте их и откройте предварительный просмотр снова. Новые сообщения и документы не отправлялись.'};}
    }finally{if(client){if(locked)try{await client.query('SELECT pg_advisory_unlock(111,hashtext($1))',[key]);}catch(error){unlockError=error;}client.release(unlockError);}}
  }
  return{preview,apply};
}
function setupHandoffCompanyAdmin(bot,options={}){
  const service=options.service||createHandoffCompanyService(options),previews=new Map(),now=options.now||Date.now;
  const allowed=ctx=>ctx.chat?.type==='private'&&admin(options,ctx.from?.id);
  const message=error=>error?.code==='HANDOFF_COMPANY_BLOCKED'?error.message:'Не удалось подтвердить изменение. Откройте предварительный просмотр заново.';
  async function preview(ctx){
    if(!allowed(ctx))return;const match=String(ctx.message?.text||'').match(/^\/handoff_company(?:@[a-z\d_]+)?\s+([1-9]\d*)\s+(.+)$/i),actor=String(ctx.from.id),cursor=Number(ctx.message?.message_id),old=previews.get(actor);
    if(!match||!positive(cursor))return ctx.reply('Предварительный просмотр: /handoff_company номер_клиента новое_наименование');
    if(old?.applying||old&&cursor<=old.cursor)return ctx.reply('Дождитесь результата текущей команды или отправьте новую.');
    for(const [key,value]of previews)if(!value.applying&&now()>=value.expires)previews.delete(key);
    if(previews.size>=100&&!previews.has(actor))return ctx.reply('Повторите просмотр через десять минут.');
    const entry={cursor,chat:String(ctx.chat.id),expires:now()+TTL};previews.set(actor,entry);
    try{const result=await service.preview(Number(match[1]),match[2],ctx.from.id);if(previews.get(actor)!==entry)return;
      await ctx.reply('Клиент #'+result.case_id+'\nБыло: '+result.old_org+'\nБудет: '+result.new_org+'\nЮрист: '+result.lawyer_name+' ('+result.lawyer_id+')\nСуществующие сообщения: личное '+result.private_message_id+', чат клиентов '+result.group_message_id+'.\nЧат клиентов: '+result.group_chat+'\n'+(/^-100[1-9]\d*$/.test(result.group_chat)?'https://t.me/c/'+result.group_chat.slice(4)+'/'+result.group_message_id+'\n':'')+'Будут обновлены только название клиента и две карточки; исходный отчёт и документы сохраняются.\nПрименить: /handoff_company_apply '+result.case_id,{disable_web_page_preview:true});
      if(previews.get(actor)===entry){entry.result=result;entry.expires=now()+TTL;}
    }catch(error){if(previews.get(actor)===entry)previews.delete(actor);await ctx.reply(message(error));}
  }
  async function apply(ctx){
    if(!allowed(ctx))return;const match=String(ctx.message?.text||'').match(/^\/handoff_company_apply(?:@[a-z\d_]+)?\s+([1-9]\d*)\s*$/i),actor=String(ctx.from.id),entry=previews.get(actor),cursor=Number(ctx.message?.message_id);
    if(!match||!entry?.result||entry.applying||now()>=entry.expires||entry.chat!==String(ctx.chat.id)||cursor<=entry.cursor||Number(match[1])!==entry.result.case_id)return ctx.reply('Нет актуального просмотра. Выполните /handoff_company номер_клиента новое_наименование заново.');
    entry.applying=true;
    try{const result=await service.apply(entry.result,ctx.from.id);await ctx.reply(result.complete?'Клиент #'+entry.result.case_id+': название и две существующие карточки обновлены. Отчёт и документы не пересылались.\nЛичное сообщение '+entry.result.private_message_id+' у юриста '+entry.result.lawyer_name+'.'+(/^-100[1-9]\d*$/.test(entry.result.group_chat)?'\nhttps://t.me/c/'+entry.result.group_chat.slice(4)+'/'+entry.result.group_message_id:''):result.warning,{disable_web_page_preview:true});}
    catch(error){await ctx.reply(message(error));}
    finally{if(previews.get(actor)===entry)previews.delete(actor);}
  }
  bot.command('handoff_company',preview);bot.command('handoff_company_apply',apply);return{preview,apply};
}
module.exports={createHandoffCompanyService,setupHandoffCompanyAdmin,TTL};
