'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { hydrateDraftReport, activeDraftEvidence, validateWorkflow } = require('../src/bot/audit-workflow');
const { buildAuditSummary } = require('../src/bot/audit-summary');
const { presentationMedia } = require('../src/bot/audit-delivery');
const { createAuditSubmitter } = require('../src/web/audit-submit');

function visit() {
  return { schema_version:3,ui_version:5,object_category:'other',order_id:62,
    request_packet:{order_id:62,object_category:'other',org:'Другой объект',address:'Москва, Тестовая, 62',service:'',materials:[]},
    inspection:{org:'Другой объект',address:'Москва, Тестовая, 62',service:'',visit_date:'2026-11-06'},
    workflow:{step:2,video_url:''},building_type:'Не проверено',boundaries:'Под вопросом',bti:'Не проверено',to:'Не обязательно',
    nearby:'Соседнее помещение ремонтируют',veranda:true,patz:true,replan:true,passport_interest:true,is_owner:true,
    conclusion:'Нужно уточнить назначение помещения; владелец предоставит документы.',entrances:[],zones:[{id:'neighbor',name:'Соседнее помещение',dist:'около 30',info:'Идёт ремонт',license:'Не проверено'}],
    plan:{evidence_id:'',page:1,annotations:[]},map:{evidence_id:'',page:1,annotations:[]},additional_plans:[],evidence:[] };
}

test('Other hydrates the existing draft with optional legacy facts and exact originals without a licence service or marked plan',()=>{
  const data=visit(),buffer=Buffer.from('synthetic exact original'),file={id:randomUUID(),name:'Осмотр.png',mime:'image/png',role:'photo',subject_id:'object',buffer};
  const report=hydrateDraftReport({id:randomUUID(),order_id:62,revision:7,data,evidence:[file]});
  assert.equal(report.schema_version,3);assert.equal(report.ui_version,5);assert.equal(report.object_category,'other');assert.equal(report.inspection.service,'');
  assert.equal(report.conclusion,data.conclusion);assert.ok(report.documents[0].source.equals(buffer));assert.equal(report.submit_id.endsWith(':7'),true);
  assert.doesNotThrow(()=>validateWorkflow(report));
});

test('a generic summary retains recorded facts without inventing alcohol checks or a positive licence conclusion',()=>{
  const data=visit();data.workflow.conclusion_status='ready';
  const summary=buildAuditSummary(data,'@synthetic_auditor');
  for(const text of [data.inspection.org,data.inspection.address,data.conclusion,'Не обязательно','Под вопросом',data.nearby,'Соседнее помещение','ПАТЗ','Собственник'])assert.ok(summary.plain.includes(text),text);
  assert.match(summary.plain,/Другое|Общий осмотр/);assert.doesNotMatch(summary.plain,/Алкоголь|Лицензирован|соответствует по проверенным/i);
});

test('changing a reviewed task to Other preserves all existing original roles even when an earlier alcohol territory result was clear',()=>{
  const data=visit();data.workflow.territory_result='clear';
  const files=['photo','map-source','map','zone','plan-source'].map(role=>({id:randomUUID(),role,subject_id:'older-subject'}));
  assert.deepEqual(activeDraftEvidence({data,evidence:files}),files);
});

test('generic photo evidence participates in the normal preview and original ZIP presentation',()=>{
  const data=visit(),source=Buffer.from('synthetic original photo');
  data.documents=[{id:randomUUID(),name:'Фото.png',mime:'image/png',role:'photo',subject_id:'object',source}];
  const media=presentationMedia(data);
  assert.equal(media.photos.length,1);assert.ok(media.photos[0].source.equals(source));assert.equal(media.documents.length,1);assert.match(media.documents[0].name,/\.zip$/);
});

test('Other still requires the actual manager identity, a written result and a usable requested video link',()=>{
  const base=visit();
  assert.doesNotThrow(()=>validateWorkflow(base));
  for(const change of [d=>d.inspection.org='',d=>d.inspection.address='',d=>d.conclusion=' ',d=>d.workflow.video_url='javascript:alert(1)',d=>d.request_packet.video_required=true]){
    const data=structuredClone(base);change(data);assert.throws(()=>validateWorkflow(data));
  }
});

test('durable generic submission accepts an empty service only for the trusted Other packet and cannot relabel another category',async()=>{
  const data=visit(),id=randomUUID(),draft={id,order_id:62,revision:1,data,evidence:[]},state={submitted:false,delivery:{}};
  const drafts={loadDraftForSubmit:async()=>draft,loadDraftDelivery:async()=>state.delivery,saveDraftDelivery:async(_a,_i,_r,p)=>{state.delivery=p;},releaseDraftSubmission:async()=>{},markDraftSubmitted:async()=>{state.submitted=true;}};
  let delivered=0;const submit=createAuditSubmitter(drafts,async(_ctx,value)=>{delivered++;assert.equal(value.object_category,'other');},{loadPacket:async()=>data.request_packet});
  await submit(1001,id,1,{});assert.equal(delivered,1);assert.equal(state.submitted,true);
  const other=createAuditSubmitter({...drafts,loadDraftDelivery:async()=>({})},async()=>assert.fail('A forged generic category cannot bypass trusted source validation'),{loadPacket:async()=>({...data.request_packet,object_category:'catering',service:'Получение'})});
  await assert.rejects(other(1001,id,1,{}),error=>error.code==='AUDIT_PACKET_CHANGED');
});
