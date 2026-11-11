'use strict';

// A document batch has its own persisted identity. Retrying it never submits
// the client again, and a lost upload response is reconciled from the server.
function documentsUI(o) {
  var $=o.node,api=o.api,M=o.model,files=[],queue=[],batches=[],busy=false,ready=true,error='',historyError='',historyCase='',context={},restored=false;
  var D={id:o.uuid(),hasDraft:false,attempt:null},limits={files:20,fileBytes:12582912,totalBytes:104857600};
  function validId(value){return typeof value==='string'&&/^[a-f\d-]{36}$/i.test(value);}
  function caseNumber(value){return /^[1-9]\d*$/.test(String(value))&&Number.isSafeInteger(Number(value))?Number(value):null;}
  function snapshot(){return {id:D.id,hasDraft:D.hasDraft,attempt:D.attempt};}
  function restore(value){
    if(restored)return;restored=true;
    if(value&&validId(value.id)){D.id=value.id;D.hasDraft=value.hasDraft===true;D.attempt=value.attempt&&validId(value.attempt.submit_id)&&value.attempt.submit_id===D.id&&caseNumber(value.attempt.case_id)&&Array.isArray(value.attempt.files)?value.attempt:null;ready=!D.hasDraft;if(D.attempt){try{files=metadata(D.attempt.files);ready=true;}catch(e){error=e.message;ready=false;}}}
  }
  function emit(){render();o.changed();}
  function base(id){return '/api/handoff/cases/'+id+'/documents';}
  function staging(){return '/api/handoff/manual-materials?submit_id='+encodeURIComponent(D.id);}
  function metadata(value){
    if(!Array.isArray(value))throw new Error('Состав документов не подтверждён. Повторите проверку.');
    return value.map(function(f){if(!f||!validId(f.id)||typeof f.name!=='string'||typeof f.mime!=='string'||typeof f.role!=='string'||!Number.isSafeInteger(Number(f.bytes))||Number(f.bytes)<1||!/^[a-f\d]{64}$/i.test(f.sha256||''))throw new Error('Состав документов не подтверждён. Повторите проверку.');return {id:f.id,name:f.name,mime:f.mime,role:f.role,bytes:Number(f.bytes),sha256:f.sha256};});
  }
  function applyStaging(result){files=metadata(result&&result.files);ready=true;D.hasDraft=files.length>0;if(result.limits)Object.keys(limits).forEach(function(k){if(Number.isSafeInteger(result.limits[k])&&result.limits[k]>0)limits[k]=result.limits[k];});}
  async function readStaging(){applyStaging(await api(staging()));}
  function locked(){return busy||context.locked||!!D.attempt||context.readonly;}
  function outstanding(){return !!(D.hasDraft||D.attempt||queue.length||busy);}
  function blocking(){return !context.readonly&&(busy||queue.length>0||D.hasDraft&&!ready);}
  function render(next){
    if(next)context=next;
    $('extra-documents').hidden=!context.visible;
    $('extra-documents-title').textContent=context.caseId?'Документы клиента':'Дополнительные документы';
    $('extra-documents-help').textContent=context.readonly?'Здесь — дополнительные файлы от менеджера. Все документы собраны в полном комплекте.':context.caseId?'Прикрепите новые файлы и нажмите «Дослать документы».':'Отчёт и документы заявки уже включены. При необходимости приложите договор, ТО или другие файлы.';
    $('extra-document-input').disabled=locked()||queue.length>0;
    $('extra-document-add').hidden=!!context.readonly;$('extra-document-add').disabled=$('extra-document-input').disabled;
    $('extra-document-limit').textContent='До '+limits.files+' файлов, по '+o.bytes(limits.fileBytes)+' каждый.';
    $('extra-document-limit').hidden=!!context.readonly;
    $('extra-document-list').innerHTML=files.map(function(f){return '<li><span><strong>'+M.escape(f.name)+'</strong><small>'+M.escape(o.bytes(f.bytes))+'</small></span><button type="button" class="text-button" data-extra-remove="'+M.escape(f.id)+'"'+(locked()?' disabled':'')+'>Убрать</button></li>';}).join('');
    $('extra-document-status').textContent=error||(busy?'Сохраняю документы…':D.attempt?(D.attempt.review?'Нужно проверить доставку. Автоматический повтор остановлен.':'Документы ещё не доставлены. Повторите отправку этого пакета.'):D.hasDraft?'Файлы сохранены. '+(context.caseId?'Нажмите «Дослать документы».':'Будут отправлены при передаче.'):'');
    $('extra-document-status').classList.toggle('error',!!error||!!D.attempt);
    $('extra-document-send').hidden=!context.caseId||context.readonly||!outstanding();
    $('extra-document-send').textContent=D.attempt?'Повторить отправку документов':'Дослать документы';
    $('extra-document-send').disabled=busy||context.locked||queue.length>0||!ready||!!(D.attempt&&D.attempt.review);
    $('extra-document-retry').hidden=(!error&&!(!ready&&D.hasDraft))||!!D.attempt||context.readonly;
    $('extra-document-retry').disabled=busy||context.locked;
    $('extra-document-cancel').hidden=!queue.length||busy||context.readonly;
    $('extra-document-history').innerHTML=batches.map(function(batch){var status=batch.status==='delivered'?'Доставлено':batch.status==='review'?'Нужна проверка доставки':'Доставка не завершена';return '<li><strong>'+M.escape(status)+'</strong>'+batch.files.map(function(f){return '<button class="download-row" type="button" data-extra-download="'+M.escape(batch.id+':'+f.id)+'"><span><strong>'+M.escape(f.name)+'</strong><small>'+M.escape(o.bytes(f.bytes))+'</small></span><span aria-hidden="true">↓</span></button>';}).join('')+(batch.retry&&!context.readonly?'<button class="soft-button" type="button" data-extra-retry="'+M.escape(batch.id)+'"'+(busy||context.locked?' disabled':'')+'>Продолжить доставку</button>':'')+'</li>';}).join('');
    $('extra-document-history-status').textContent=historyError;
    $('extra-document-history-retry').hidden=!historyError;$('extra-document-history-retry').disabled=busy;
    if(context.visible&&context.caseId&&String(context.caseId)!==historyCase){historyCase=String(context.caseId);batches=[];historyError='';$('extra-document-history').innerHTML='';void loadHistory();}
    if(context.visible&&D.hasDraft&&!ready&&!busy&&!D.attempt&&!error){void recover();}
  }
  async function loadHistory(){
    var id=caseNumber(context.caseId);if(!id)return;historyError='';
    try{var result=await api(base(id));if(String(context.caseId)!==String(id))return;
      if(!result||Number(result.case_id)!==id||!Array.isArray(result.batches))throw new Error('Список документов не подтверждён.');
      batches=result.batches.map(function(b){if(!b||!validId(b.id)||!['delivered','pending','review'].includes(b.status))throw new Error('Статус документов не подтверждён.');metadata(b.files);return b;});
      var matched=D.attempt&&batches.find(function(b){return b.id===D.id;});if(matched){if(matched.status==='delivered')clearDraft();else {D.attempt.review=matched.status==='review'||matched.retry===false;error=matched.warn||'';}}
    }catch(e){if(String(context.caseId)!==String(id))return;historyError=e.message;}emit();
  }
  function clearDraft(){D={id:o.uuid(),hasDraft:false,attempt:null};files=[];queue=[];ready=true;error='';}
  async function recover(){if(busy||context.readonly)return;busy=true;error='';emit();try{await readStaging();}catch(e){error=e.message;}finally{busy=false;emit();}}
  async function upload(){
    if(locked()||!queue.length)return;busy=true;D.hasDraft=true;ready=false;error='';emit();
    try{await readStaging();while(queue.length){var f=queue[0];D.hasDraft=true;
      if(f.size>limits.fileBytes)throw new Error('Файл «'+f.name+'» больше '+o.bytes(limits.fileBytes)+'. Уберите его из очереди.');
      var body=new FormData();body.append('file',f,f.name);applyStaging(await api(staging(),{method:'POST',body:body}));queue.shift();emit();
    }$('extra-document-input').value='';}catch(e){error=e.message;}finally{busy=false;emit();}
  }
  async function remove(id){if(locked())return;busy=true;error='';emit();try{applyStaging(await api('/api/handoff/manual-materials/'+encodeURIComponent(id)+'?submit_id='+encodeURIComponent(D.id),{method:'DELETE'}));}catch(e){error=e.message;}finally{busy=false;emit();}}
  async function cancelQueue(){if(busy||D.attempt||context.readonly)return;busy=true;error='';emit();try{await readStaging();queue=[];$('extra-document-input').value='';}catch(e){error=e.message;}finally{busy=false;emit();}}
  function checked(result,id,submitId){
    if(!result||result.ok!==true||Number(result.case_id)!==id||result.batch?.id!==submitId||!['delivered','pending','review'].includes(result.batch.status)||typeof result.delivery_complete!=='boolean'||result.delivery_complete!==(result.batch.status==='delivered'))throw new Error('Доставка документов не подтверждена. Повторите этот пакет.');
    metadata(result.batch.files);return result;
  }
  async function send(caseId){
    var id=caseNumber(caseId||context.caseId);if(!id||busy||context.readonly||D.attempt?.review)return false;
    if(D.attempt&&Number(D.attempt.case_id)!==id){error='Этот пакет относится к другому клиенту. Откройте его карточку.';emit();return false;}
    if(!outstanding())return true;
    busy=true;error='';emit();
    try{if(!D.attempt){await readStaging();if(!files.length){clearDraft();return true;}D.attempt={case_id:id,submit_id:D.id,files:files.map(function(f){return Object.assign({},f);})};emit();}
      var result=checked(await api(base(id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submit_id:D.attempt.submit_id,files:D.attempt.files})}),id,D.id);
      batches=[result.batch].concat(batches.filter(function(b){return b.id!==result.batch.id;}));
      if(result.delivery_complete){clearDraft();return true;}D.attempt.review=result.batch.status==='review'||result.batch.retry===false;error=result.warn||result.batch.warn||'Документы ещё не доставлены.';return false;
    }catch(e){error=e.message;return false;}finally{busy=false;emit();}
  }
  async function retryBatch(id){
    var c=caseNumber(context.caseId);if(!c||busy||context.locked||context.readonly)return;busy=true;error='';emit();
    try{var result=checked(await api(base(c)+'/'+encodeURIComponent(id)+'/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),c,id);batches=[result.batch].concat(batches.filter(function(b){return b.id!==id;}));if(D.attempt&&D.id===id){if(result.delivery_complete)clearDraft();else D.attempt.review=result.batch.status==='review'||result.batch.retry===false;}error=result.warn||result.batch.warn||'';}catch(e){error=e.message;}finally{busy=false;emit();}
  }
  $('extra-document-add').onclick=function(){if(!locked())$('extra-document-input').click();};
  $('extra-document-input').onchange=function(){if(locked())return;queue=Array.from(this.files||[]);void upload();};
  $('extra-document-retry').onclick=function(){if(queue.length)void upload();else void recover();};
  $('extra-document-cancel').onclick=function(){void cancelQueue();};
  $('extra-document-send').onclick=function(){void send();};
  $('extra-document-list').onclick=function(e){var button=e.target.closest('[data-extra-remove]');if(button)void remove(button.dataset.extraRemove);};
  $('extra-document-history').onclick=function(e){var retry=e.target.closest('[data-extra-retry]');if(retry){void retryBatch(retry.dataset.extraRetry);return;}var button=e.target.closest('[data-extra-download]');if(!button)return;var parts=button.dataset.extraDownload.split(':'),batch=batches.find(function(b){return b.id===parts[0];}),file=batch&&batch.files.find(function(f){return f.id===parts[1];});if(file)o.download(file,button);};
  $('extra-document-history-retry').onclick=function(){void loadHistory();};
  return {restore:restore,snapshot:snapshot,render:render,blocking:blocking,outstanding:outstanding,pendingDelivery:function(){return outstanding()||batches.some(function(b){return b.status!=='delivered';});},send:send,summary:function(){return files.map(function(f){return f.name;});},reset:clearDraft};
}

module.exports=documentsUI;
