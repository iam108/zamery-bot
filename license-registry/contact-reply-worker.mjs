import {hash} from './state.mjs';
import {normalizeAddress,normalizeDate,normalizeLicenseNumber,parseSheetRows} from './core.mjs';
import {parseOwnerContactReply,findContactReview} from './contact-reply-input.mjs';
import {prepareManualContactPlan,applyManualContactPlan,verifyManualContactPlan} from './manual-contact-google.mjs';

const positive=(value)=>/^\d+$/u.test(String(value??''))&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const clean=(value)=>String(value??'').trim();
const clip=(value,length=180)=>clean(value).slice(0,length)||'—';
const stamp=(now)=>new Date(now()).toISOString();
const failure=(code)=>Object.assign(new Error(code),{code});
const terminal=new Set(['manual_contact_plan_stale','manual_contact_cell_protected','manual_contact_row_ambiguous','manual_contact_plan_invalid']);
const active=new Set(['awaiting_contact','preparing','selecting_row','awaiting_replace','planned']);
const rowKey=(row)=>hash([clean(row.inn),normalizeAddress(row.address),normalizeLicenseNumber(row.licenseNumber),normalizeDate(row.issueDate),normalizeDate(row.expiryDate)]);
function initialize(state){
  state.contactReplies??={};const replies=state.contactReplies;
  for(const name of ['sessions','messageIndex','outbox','processed'])replies[name]??={};
  state.telegram??={offset:0,inbox:[]};state.telegram.ownerInbox??=[];
  return replies;
}
function enqueue(state,session,kind,text,at,keyboard){
  const replies=initialize(state);const id=hash([session.id,kind,text]);
  replies.outbox[id]??={id,sessionId:session.id,kind,text,replyToMessageId:session.sourceMessageId,
    ...(keyboard?{keyboard}:{}),status:'pending',createdAt:at,attempts:0};
}
function preview(session){
  const plan=session.plan;
  const lines=[`Строка ${plan.rowNumber}. Предлагаю заменить контакт:`,
    `Имя: ${clip(plan.before.M)} → ${clip(plan.after.M)}`,
    `Телефон: ${clip(plan.before.N)} → ${clip(plan.after.N)}`];
  lines.push(session.contact.telegram?`Telegram: ${clip(plan.before.O)} → ${clip(plan.after.O)}`:
    `Telegram: ${clip(plan.after.O)} (сохраняется)`);
  lines.push('Подтверди замену кнопкой.');return lines.join('\n');
}
function receiptFor(plan,raw){
  if(raw?.verified!==true||raw.planHash!==plan.hash||raw.spreadsheetId!==plan.spreadsheetId
    ||raw.sheetName!==plan.sheetName||raw.sheetId!==plan.sheetId||raw.rowNumber!==plan.rowNumber
    ||!Number.isFinite(Date.parse(raw.verifiedAt))||!raw.cells
    ||Object.entries(plan.expectedCells).some(([cell,value])=>raw.cells[cell]!==value))throw failure('manual_contact_receipt_invalid');
  const allowed=new Set(plan.updates.map((change)=>`${change.column}${plan.rowNumber}`));
  if(!Array.isArray(raw.appliedCells)||raw.appliedCells.some((cell)=>!allowed.has(cell)))throw failure('manual_contact_receipt_invalid');
  return {verified:true,planHash:plan.hash,spreadsheetId:plan.spreadsheetId,sheetName:plan.sheetName,sheetId:plan.sheetId,
    rowNumber:plan.rowNumber,verifiedAt:raw.verifiedAt,action:raw.action,appliedCells:[...new Set(raw.appliedCells)],
    cells:Object.fromEntries(Object.keys(plan.expectedCells).map((cell)=>[cell,raw.cells[cell]]))};
}

/** Authenticated private replies create durable, row-bound manual contact intents. */
export class ContactReplyWorker{
  constructor({store,google,telegram,ownerChatId,botId,now=()=>new Date(),log=()=>{},
    preparePlan=prepareManualContactPlan,applyPlan=applyManualContactPlan,verifyPlan=verifyManualContactPlan}={}){
    if(typeof store?.read!=='function'||typeof store?.update!=='function'||typeof google?.context!=='function'
      ||typeof telegram?.call!=='function'||!positive(ownerChatId)||!positive(botId))throw failure('contact_reply_configuration_invalid');
    Object.assign(this,{store,google,telegram,ownerChatId:String(ownerChatId),botId:String(botId),now,log,preparePlan,applyPlan,verifyPlan});
    this.busy=false;
  }
  logCode(code){try{this.log({at:stamp(this.now),type:'contact_reply_error',code});}catch{}}
  scoped(session){return session?.ownerChatId===this.ownerChatId&&session?.botId===this.botId;}
  authenticated(event){
    return event&&['message','callback'].includes(event.kind)&&event.chatType==='private'
      &&String(event.ownerChatId)===this.ownerChatId&&String(event.fromId)===this.ownerChatId
      &&String(event.botId)===this.botId&&positive(event.messageId);
  }
  async answer(event,text){
    if(event?.kind!=='callback'||!this.authenticated(event)||typeof event.callbackQueryId!=='string')return;
    try{await this.telegram.call('answerCallbackQuery',{callback_query_id:event.callbackQueryId,text});}
    catch{this.logCode('contact_reply_callback_unavailable');}
  }
  async consume(entry){
    const event=entry.event;let answer;
    const outcome=await this.store.update((state)=>{
      const replies=initialize(state);const key=`${this.botId}:${this.ownerChatId}:${entry.updateId}`;
      const finish=(status)=>{
        replies.processed[key]??={status,at:stamp(this.now)};
        state.telegram.ownerInbox=state.telegram.ownerInbox.filter((item)=>item.updateId!==entry.updateId);
        return status;
      };
      if(replies.processed[key])return finish('duplicate');
      if(!this.authenticated(event)||event.updateId!==entry.updateId)return finish('ignored');
      const at=stamp(this.now);
      if(event.kind==='callback'){
        const match=String(event.data??'').match(/^cr:([a-f0-9]{32}):(replace|cancel|row:([1-9]\d{0,5}))$/u);
        const session=match&&replies.sessions[match[1]];
        if(!this.scoped(session)||event.replyTo?.fromBotId!==this.botId
          ||replies.messageIndex[String(event.replyTo.messageId)]!==session.id){answer='Это действие уже недоступно.';return finish('ignored');}
        const review=state.contacts?.reviews?.[session.reviewId];
        if(review?.manualReplySession!==session.id||!active.has(session.status)){answer='Уже обработано.';return finish('ignored');}
        if(match[2]==='replace'&&session.status==='awaiting_replace'){
          session.confirmed=true;session.status='planned';session.updatedAt=at;answer='Подтверждено.';return finish('confirmed');
        }
        if(match[2].startsWith('row:')&&session.status==='selecting_row'&&session.rowChoices?.includes(Number(match[3]))){
          session.rowNumber=Number(match[3]);session.explicitRow=Number(match[3]);session.status='preparing';session.updatedAt=at;
          answer='Строка выбрана.';return finish('selected');
        }
        if(match[2]==='cancel'&&!(session.status==='planned'&&session.writeAttempted)){
          session.status='cancelled';session.updatedAt=at;answer='Отменено.';
          enqueue(state,session,'cancelled','Изменение контакта отменено.',at);return finish('cancelled');
        }
        answer='Это действие уже недоступно.';return finish('ignored');
      }
      let previous;
      if(event.replyTo?.fromBotId===this.botId)previous=replies.sessions[replies.messageIndex[String(event.replyTo.messageId)]];
      if(previous&&!this.scoped(previous))return finish('ignored');
      const reviewId=previous?.reviewId??findContactReview(state,event);
      const review=reviewId&&state.contacts?.reviews?.[reviewId];
      if(!review||!/^[a-f0-9]{64}$/u.test(reviewId)||review.status==='resolved')return finish('ignored');
      if(previous?.status==='planned'){return finish('ignored');}
      const assigned=review.manualReplySession&&replies.sessions[review.manualReplySession];
      if(assigned&&!this.scoped(assigned))return finish('ignored');
      if(assigned?.status==='planned')return finish('ignored');
      const parsed=parseOwnerContactReply(event);
      const id=hash([this.botId,this.ownerChatId,entry.updateId]).slice(0,32);
      const session={id,reviewId,ownerChatId:this.ownerChatId,botId:this.botId,sourceMessageId:event.messageId,sourceUpdateId:entry.updateId,
        status:parsed.status==='contact'?'preparing':'awaiting_contact',createdAt:at,updatedAt:at,
        ...(parsed.status==='contact'?{contact:structuredClone(parsed.contact),...(parsed.rowNumber?{rowNumber:parsed.rowNumber,explicitRow:parsed.rowNumber}:{})}:{})};
      if(assigned&&active.has(assigned.status)){
        assigned.status='superseded';assigned.updatedAt=at;
        for(const item of Object.values(replies.outbox))if(item.sessionId===assigned.id&&['pending','sending'].includes(item.status))item.status='superseded';
      }
      replies.sessions[id]=session;review.manualReplySession=id;
      if(parsed.status!=='contact')enqueue(state,session,'help','Пришли контакт одним ответом:\nИмя: Иван Иванов\nТелефон: +79991234567\nTelegram: @username\nСтроку Telegram можно пропустить. Можно также отправить контакт Telegram.',at);
      return finish(parsed.status==='contact'?'intent_saved':'needs_contact');
    });
    if(answer)await this.answer(event,answer);
    return outcome;
  }
  async stale(id,reason){
    return this.store.update((state)=>{
      const session=initialize(state).sessions[id];if(!this.scoped(session)||!active.has(session.status))return;
      session.status='stale';session.reason=terminal.has(reason)?reason:'manual_contact_plan_stale';session.updatedAt=stamp(this.now);
      enqueue(state,session,'stale','Данные строки изменились или ячейка защищена. Я ничего не заменял повторно. Ответь на это сообщение с именем и телефоном — я подготовлю новую проверку.',stamp(this.now));
    });
  }
  async prepare(id){
    const state=await this.store.read();const session=state.contactReplies?.sessions?.[id];
    if(!this.scoped(session)||session.status!=='preparing')return;
    const review=state.contacts?.reviews?.[session.reviewId];
    if(!review||review.status==='resolved'||review.manualReplySession!==id)return;
    const context=await this.google.context();
    const rows=parseSheetRows(context.values,{startRow:context.startRow??1}).filter((row)=>rowKey(row)===review.rowKey);
    if(!rows.length)return this.stale(id,'manual_contact_plan_stale');
    let row;
    if(session.rowNumber)row=rows.find((item)=>item.rowNumber===session.rowNumber);
    else if(rows.length===1)row=rows[0];
    if(!row){
      const choices=rows.map((item)=>item.rowNumber).sort((a,b)=>a-b);
      return this.store.update((current)=>{
        const saved=initialize(current).sessions[id];if(!this.scoped(saved)||saved.status!=='preparing')return;
        saved.status='selecting_row';saved.rowChoices=choices;saved.updatedAt=stamp(this.now);
        const shown=choices.slice(0,20);
        enqueue(current,saved,'choose_row',`Для этой лицензии найдены строки: ${shown.join(', ')}${choices.length>shown.length?' и другие':''}. Выбери строку для контакта.${choices.length>shown.length?' Другую строку укажи в новом ответе вместе с контактом: Строка: номер.':''}`,stamp(this.now),
          shown.map((number)=>[{text:`Строка ${number}`,callback_data:`cr:${id}:row:${number}`}]))});
    }
    const authorization={reviewId:session.reviewId,ownerChatId:this.ownerChatId,sourceMessageId:session.sourceMessageId,
      ...(session.explicitRow?{explicitRow:session.explicitRow}:{})};
    let plan;
    try{plan=await this.preparePlan(this.google,{rowNumber:row.rowNumber,inn:row.inn,licenseNumber:row.licenseNumber??'',
      issueDate:row.issueDate,expiryDate:row.expiryDate,address:row.address,contact:session.contact,authorization});}
    catch(error){if(terminal.has(error.code))return this.stale(id,error.code);throw error;}
    await this.store.update((current)=>{
      const saved=initialize(current).sessions[id];const target=current.contacts?.reviews?.[session.reviewId];
      if(!this.scoped(saved)||saved.status!=='preparing'||target?.manualReplySession!==id||target.status==='resolved')return;
      Object.assign(saved,{plan:structuredClone(plan),status:plan.needsConfirmation?'awaiting_replace':'planned',confirmed:false,updatedAt:stamp(this.now)});
      if(plan.needsConfirmation)enqueue(current,saved,'preview',preview(saved),stamp(this.now),[[
        {text:'Заменить',callback_data:`cr:${id}:replace`},{text:'Отмена',callback_data:`cr:${id}:cancel`}]]);
    });
  }
  async acknowledge(id,raw){
    return this.store.update((state)=>{
      const session=initialize(state).sessions[id];if(!this.scoped(session))throw failure('contact_reply_scope_mismatch');
      if(session.status==='done')return false;
      if(session?.status!=='planned'||!session.plan)throw failure('manual_contact_receipt_invalid');
      const receipt=receiptFor(session.plan,raw);const review=state.contacts?.reviews?.[session.reviewId];
      if(review?.manualReplySession!==id)throw failure('manual_contact_receipt_invalid');
      Object.assign(session,{status:'done',receipt,completedAt:stamp(this.now),updatedAt:stamp(this.now)});
      Object.assign(review,{status:'resolved',resolvedAt:stamp(this.now),manualContactPlanHash:session.plan.hash});
      state.journal.push({at:stamp(this.now),type:'manual_contact_write_verified',reviewId:session.reviewId,planHash:session.plan.hash,
        rowNumber:session.plan.rowNumber,cells:session.plan.updates.map((change)=>`${change.column}${session.plan.rowNumber}`)});
      enqueue(state,session,'done',`Контакт сохранён и проверен в строке ${session.plan.rowNumber}.\nИмя: ${clip(session.plan.after.M)}\nТелефон: ${clip(session.plan.after.N)}\nTelegram: ${clip(session.plan.after.O)}`,stamp(this.now));
      return true;
    });
  }
  async apply(id){
    let session=(await this.store.read()).contactReplies?.sessions?.[id];if(!this.scoped(session)||session.status!=='planned')return false;
    try{return await this.acknowledge(id,await this.verifyPlan(this.google,session.plan));}
    catch(error){
      if(terminal.has(error.code)||terminal.has(error.reason))return this.stale(id,error.reason??error.code);
      if(error.code!=='manual_contact_readback_pending')throw error;
    }
    const allowed=await this.store.update((state)=>{
      const current=initialize(state).sessions[id];const review=current&&state.contacts?.reviews?.[current.reviewId];
      if(!this.scoped(current)||current.status!=='planned'||review?.manualReplySession!==id||review.status==='resolved')return false;
      if(current.plan.needsConfirmation&&!current.confirmed)return false;
      current.writeAttempted=true;current.lastWriteAttemptAt=stamp(this.now);return true;
    });
    if(!allowed)return false;
    session=(await this.store.read()).contactReplies.sessions[id];
    if(!this.scoped(session)||session.status!=='planned')return false;
    try{return await this.acknowledge(id,await this.applyPlan(this.google,session.plan,{confirmed:session.confirmed===true}));}
    catch(error){if(terminal.has(error.code))return this.stale(id,error.code);throw error;}
  }
  async flushOutbox(){
    let sent=0;
    const snapshot=await this.store.read();
    const items=Object.values(snapshot.contactReplies?.outbox??{}).filter((entry)=>this.scoped(snapshot.contactReplies?.sessions?.[entry.sessionId])
      &&(entry.status==='pending'||entry.status==='sending'&&Date.parse(entry.leaseUntil)<=+new Date(this.now()))).slice(0,10);
    for(const item of items){
      const claimed=await this.store.update((state)=>{
        const replies=initialize(state);const current=replies.outbox[item.id];
        if(!this.scoped(replies.sessions[current?.sessionId]))return false;
        if(!current||!['pending','sending'].includes(current.status)
          ||current.status==='sending'&&Date.parse(current.leaseUntil)>+new Date(this.now()))return false;
        current.status='sending';current.attempts++;current.leaseUntil=new Date(+new Date(this.now())+30_000).toISOString();return true;
      });
      if(!claimed)continue;
      try{
        const result=await this.telegram.call('sendMessage',{chat_id:this.ownerChatId,text:item.text,
          reply_parameters:{message_id:item.replyToMessageId},link_preview_options:{is_disabled:true},
          ...(item.keyboard?{reply_markup:{inline_keyboard:item.keyboard}}:{})});
        if(!positive(result?.message_id)||String(result.chat?.id)!==this.ownerChatId||result.chat.type!=='private'
          ||result.from?.is_bot!==true||String(result.from.id)!==this.botId)throw failure('contact_reply_delivery_unverified');
        await this.store.update((state)=>{
          const replies=initialize(state);const current=replies.outbox[item.id];
          if(current?.sessionId!==item.sessionId||!this.scoped(replies.sessions[current.sessionId]))throw failure('contact_reply_scope_mismatch');
          current.status='sent';current.sentAt=stamp(this.now);current.telegramMessageId=Number(result.message_id);
          current.deliveryOwnerChatId=this.ownerChatId;current.deliveryBotId=this.botId;
          replies.messageIndex[String(result.message_id)]=item.sessionId;
        });sent++;
      }catch{this.logCode('contact_reply_delivery_unavailable');break;}
    }
    return sent;
  }
  async tick(){
    if(this.busy)return {skipped:'busy'};this.busy=true;
    const summary={processed:0,saved:0,sent:0};
    try{
      const inbox=[...((await this.store.read()).telegram?.ownerInbox??[])].sort((a,b)=>a.updateId-b.updateId).slice(0,100);
      for(const entry of inbox){await this.consume(entry);summary.processed++;}
      const ids=Object.values((await this.store.read()).contactReplies?.sessions??{}).filter((session)=>this.scoped(session)).map((session)=>session.id);
      for(const id of ids){
        try{
          const status=(await this.store.read()).contactReplies.sessions[id].status;
          if(status==='preparing')await this.prepare(id);
          if((await this.store.read()).contactReplies.sessions[id].status==='planned'&&await this.apply(id))summary.saved++;
        }catch(error){this.logCode(error.code==='state_locked'?'state_locked':'contact_reply_processing_unavailable');}
      }
      summary.sent=await this.flushOutbox();return summary;
    }finally{this.busy=false;}
  }
}
