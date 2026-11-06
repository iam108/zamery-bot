'use strict';

const {messageId}=require('../web/order-telegram-delivery');
const PREVIEW_TTL=10*60*1000,MAX_PREVIEWS=100;
const STATUSES=new Set(['missing','pending','confirmed','rejected','unknown','blocked']);
function createHandoffNoticeAdmin(options={}) {
  const previews=new Map(),now=options.now||Date.now;let publisher=options.publisher;
  const service=()=>publisher||=require('../web/handoff-group-notice').createHandoffNoticePublisher({pool:options.pool});
  function allowed(ctx) {
    const configured=typeof options.adminIds==='function'?options.adminIds():options.adminIds??process.env.ADMIN_TG_IDS??'';
    const admins=Array.isArray(configured)?configured.map(String):String(configured).split(/[\s,;]+/).filter(Boolean);
    return ctx.chat?.type==='private'&&admins.includes(String(ctx.from?.id));
  }
  function cleanup(){for(const [actor,entry]of previews)if(!entry.applying&&now()>=entry.expiresAt)previews.delete(actor);}
  const current=(ctx,id)=>'Нет актуального просмотренного состояния. Выполните /handoff_notice '+(id||'номер_клиента')+' заново. Ничего не отправлялось.';
  async function consume(ctx,id,cursor) {
    // No reviewed identity is supplied: the publisher records the command's
    // cursor, then necessarily returns stale/blocked without publishing.
    try {await service().apply(id,{actorId:ctx.from.id,messageId:cursor});}catch(_){}
  }
  async function preview(ctx) {
    if(!allowed(ctx))return;
    const match=String(ctx.message?.text||'').match(/^\/handoff_notice(?:@[a-z\d_]+)?\s+([1-9]\d*)\s*$/i);
    const id=messageId(match?.[1]),cursor=messageId(ctx.message?.message_id),actor=String(ctx.from.id);
    if(!id||id>2147483647||!cursor)return ctx.reply('Посмотреть уведомление: /handoff_notice номер_клиента');
    cleanup();const previous=previews.get(actor);
    if(previous?.applying)return ctx.reply('Публикация уже выполняется. Сначала проверьте её результат.');
    if(previous&&cursor<=previous.cursor)return ctx.reply('Этот просмотр уже обработан. Выполните /handoff_notice заново новым сообщением.');
    if(!previous&&previews.size>=MAX_PREVIEWS)return ctx.reply('Сейчас открыто слишком много просмотров. Повторите через десять минут.');
    const entry={id,cursor,chat:String(ctx.chat.id),expiresAt:now()+PREVIEW_TTL,ready:false};previews.set(actor,entry);
    try {
      const result=await service().preview(id,{actorId:ctx.from.id});
      if(previews.get(actor)!==entry)return;
      if(result?.case_id!==id||!Number.isSafeInteger(result.generation)||result.generation<0||
        !/^[a-f\d]{64}$/.test(result.revision||'')||typeof result.target!=='string'||result.target.length>32||!/^-[1-9]\d*$/.test(result.target)||
        typeof result.text!=='string'||!result.text.trim()||result.text.length>3000||!STATUSES.has(result.status)||
        typeof result.can_apply!=='boolean'||typeof result.requires_confirmation!=='boolean'||
        result.status==='confirmed'&&result.can_apply||result.status==='unknown'&&result.can_apply&&!result.requires_confirmation)throw new Error('Invalid notice preview');
      entry.result=result;
      let instructions='Уведомление клиента #'+id+' · предварительный просмотр\nЧат: '+result.target+'\nСтатус: '+result.status+'.';
      if(typeof result.warning==='string'&&result.warning.length<=1000&&result.warning.trim())instructions+='\n'+result.warning;
      if(result.can_apply)instructions+='\n\n'+(result.requires_confirmation?'Сначала проверьте чат: сообщение могло дойти. Только если уведомления там нет, подтвердите повтор. Возможен дубликат.\n':'Для публикации просмотренного уведомления:\n')+
        '/handoff_notice_apply '+id+(result.requires_confirmation?' confirm_missing':'')+'\nПросмотр действует десять минут. Точный текст уведомления — следующим сообщением.';
      else instructions+='\nПубликация по этому состоянию недоступна. Ниже только сохранённый текст.';
      await ctx.reply(instructions,{disable_web_page_preview:true});
      if(previews.get(actor)!==entry)return;
      await ctx.reply(result.text,{disable_web_page_preview:true});
      if(previews.get(actor)===entry){entry.ready=true;entry.expiresAt=now()+PREVIEW_TTL;}
    } catch (_) {
      if(previews.get(actor)===entry)previews.delete(actor);
      return ctx.reply('Не удалось подготовить просмотр. Ничего не отправлялось. Повторите /handoff_notice позднее.');
    }
  }
  async function apply(ctx) {
    if(!allowed(ctx))return;
    const match=String(ctx.message?.text||'').match(/^\/handoff_notice_apply(?:@[a-z\d_]+)?\s+([1-9]\d*)(?:\s+(confirm_missing))?\s*$/i);
    const id=messageId(match?.[1]),cursor=messageId(ctx.message?.message_id),actor=String(ctx.from.id);cleanup();const entry=previews.get(actor);
    if(!id||id>2147483647||!cursor)return ctx.reply(current(ctx,id));
    if(!entry?.ready||entry.id!==id||entry.chat!==String(ctx.chat.id)||cursor<=entry.cursor){await consume(ctx,id,cursor);return ctx.reply(current(ctx,id));}
    if(!entry.result.can_apply){await consume(ctx,id,cursor);return ctx.reply('В просмотренном состоянии публикация недоступна. Откройте /handoff_notice '+id+' заново.');}
    const confirmMissing=match[2]==='confirm_missing';
    if(entry.result.requires_confirmation&&!confirmMissing){await consume(ctx,id,cursor);return ctx.reply('Сначала проверьте чат: сообщение могло дойти. Повтор может создать дубликат. Только если уведомления нет, отправьте /handoff_notice_apply '+id+' confirm_missing.');}
    // Forward concurrent valid commands too: the publisher consumes their
    // durable message cursor even if its shared lock returns busy.
    entry.applying=(entry.applying||0)+1;let busy=false;
    try {
      const result=await service().apply(id,{actorId:ctx.from.id,messageId:cursor,expectedGeneration:entry.result.generation,expectedRevision:entry.result.revision,expectedTarget:entry.result.target,confirmMissing});
      if(!['confirmed','unknown','rejected','blocked','stale','replayed','busy'].includes(result?.state)||typeof result.warning!=='string'||!result.warning.trim()||result.warning.length>2000)throw new Error('Invalid notice result');
      busy=result.state==='busy';
      if(!busy&&previews.get(actor)===entry)previews.delete(actor);
      return await ctx.reply(result.warning,{disable_web_page_preview:true});
    } catch (_) {
      if(previews.get(actor)===entry)previews.delete(actor);
      return ctx.reply('Не удалось подтвердить результат публикации. Проверьте чат и откройте /handoff_notice '+id+' заново перед следующей попыткой.');
    } finally {entry.applying--;}
  }
  return {preview,apply};
}
function setupHandoffNoticeAdmin(bot,options={}) {
  const commands=createHandoffNoticeAdmin(options);bot.command('handoff_notice',commands.preview);bot.command('handoff_notice_apply',commands.apply);return commands;
}
module.exports={createHandoffNoticeAdmin,setupHandoffNoticeAdmin,PREVIEW_TTL,MAX_PREVIEWS};
