'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {compactVisit}=require('./helpers/audit-v5');
const {normalizeWorkflow,validateWorkflow,compactReportIssues,hydrateDraftReport,buildWorkflowReport}=require('../src/bot/audit-workflow');
const {buildAuditSummary}=require('../src/bot/audit-summary');
const {presentationMedia}=require('../src/bot/audit-delivery');
const {createAuditSubmitter}=require('../src/web/audit-submit');

function attached(mime='application/pdf') {
  const data=compactVisit('tobacco','');
  data.workflow.territory_result='clear';delete data.map;
  const source=data.evidence.find(file=>file.id===data.plan.evidence_id),preview=data.evidence.find(file=>file.role==='plan');
  source.mime=mime;source.name=mime==='application/pdf'?'Мой план.pdf':'Мой план.png';
  data.plan={mode:'attached',evidence_id:source.id,page:mime==='application/pdf'?3:1,annotations:[],preview_evidence_id:preview.id};
  return data;
}
function draft(data) {return {id:randomUUID(),revision:1,order_id:58,data,evidence:data.evidence.map(file=>({...file,buffer:Buffer.from('original:'+file.id)}))};}

for(const mime of ['image/jpeg','image/png','application/pdf'])test('a ready-made '+mime+' main plan accepts its owned source and selected page without internal annotations',()=>{
  const data=attached(mime);
  for(const outcome of ['ready','actions','insufficient','obstacle']) {
    data.workflow.conclusion_status=outcome;assert.doesNotThrow(()=>validateWorkflow(data));
    assert.ok(!compactReportIssues(data).some(issue=>issue.control==='plan.annotations'));
  }
  const input=draft(data),hydrated=hydrateDraftReport(input),media=presentationMedia(hydrated);
  assert.ok(media.photos.some(file=>file.id===data.plan.preview_evidence_id));
  const original=hydrated.documents.find(file=>file.id===data.plan.evidence_id);
  assert.deepEqual(original.source,input.evidence.find(file=>file.id===original.id).buffer);
  assert.equal(hydrated.plan.page,data.plan.page);
});

const invalid=[
  ['missing source',d=>d.evidence=d.evidence.filter(f=>f.id!==d.plan.evidence_id),/Исходный файл/],
  ['wrong source role',d=>d.evidence.find(f=>f.id===d.plan.evidence_id).role='photo',/Исходный файл/],
  ['unsupported source MIME',d=>d.evidence.find(f=>f.id===d.plan.evidence_id).mime='text/html',/изображение или PDF/],
  ['missing page',d=>delete d.plan.page,/номер выбранной страницы/],
  ['zero page',d=>d.plan.page=0,/номер выбранной страницы/],
  ['missing preview reference',d=>delete d.plan.preview_evidence_id,/изображение выбранного листа/],
  ['unowned preview',d=>d.plan.preview_evidence_id=randomUUID(),/изображение выбранного листа/],
  ['wrong preview subject',d=>d.evidence.find(f=>f.id===d.plan.preview_evidence_id).subject_id='annotation-extra',/изображение выбранного листа/],
  ['PDF preview',d=>d.evidence.find(f=>f.id===d.plan.preview_evidence_id).mime='application/pdf',/изображение выбранного листа/],
  ['non-PNG preview',d=>d.evidence.find(f=>f.id===d.plan.preview_evidence_id).mime='image/jpeg',/изображение выбранного листа/],
  ['active old marks',d=>d.plan.annotations=[{id:'old',tool:'boundary',points:[{x:.1,y:.1},{x:.5,y:.1},{x:.5,y:.5}]}],/готового плана.*разметк/],
  ['pending old contour',d=>d.plan.pending={tool:'boundary',points:[{x:.1,y:.1}]},/готового плана.*разметк/],
];
for(const [label,change,message]of invalid)test('ready-made plan still rejects '+label+' with an obstacle outcome',()=>{
  const data=attached();data.workflow.conclusion_status='obstacle';change(data);assert.throws(()=>validateWorkflow(data),message);
});

test('draw remains the default and an unknown mode cannot waive its geometry',()=>{
  const legacy=compactVisit();assert.doesNotThrow(()=>validateWorkflow(legacy));
  legacy.plan.annotations=[];assert.throws(()=>validateWorkflow(legacy),/границы помещения/);
  legacy.plan.mode='draw';assert.throws(()=>validateWorkflow(legacy),/границы помещения/);
  legacy.plan.mode='unexpected';assert.throws(()=>validateWorkflow(legacy),/способ.*плана/);
});

test('structured missing-data diagnosis accepts the completed attached plan and requires its selected preview',()=>{
  const data=attached();assert.deepEqual(compactReportIssues(data),[]);
  delete data.plan.preview_evidence_id;
  const issues=compactReportIssues(data);assert.ok(issues.some(issue=>issue.control==='plan.preview_evidence_id'&&issue.blocks_submission));
  assert.ok(!issues.some(issue=>issue.control==='plan.annotations'));
});

test('full report describes an attached plan without claiming internal annotations',()=>{
  const data=attached(),text=buildWorkflowReport(data).plain.join('\n');
  assert.match(text,/План: Мой план.pdf · лист 3 · готовый план приложен/);
  assert.doesNotMatch(text,/разметка приложена/);
  const media=presentationMedia(hydrateDraftReport(draft(data)));
  assert.match(media.photos.find(file=>file.role==='plan').caption,/План помещения · лист 3/);
  assert.match(buildAuditSummary(data,'Аудитор').plain,/Основной план: лист 3/);
});

function zipEntries(buffer) {
  const yauzl=require('yauzl');
  return new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,zip)=>{
    if(error)return reject(error);const files=new Map();zip.on('error',reject);zip.on('end',()=>resolve(files));
    zip.on('entry',entry=>zip.openReadStream(entry,(error,input)=>{if(error)return reject(error);const chunks=[];input.on('error',reject);input.on('data',chunk=>chunks.push(chunk));input.on('end',()=>{files.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});}));zip.readEntry();
  }));
}

test('inactive plan-mode storage survives normalization but does not enter Telegram or the original ZIP',async()=>{
  const data=attached(),inactiveSource={id:randomUUID(),role:'plan-source',mime:'application/pdf',name:'PARKED-original.pdf'},inactivePreview={id:randomUUID(),role:'plan',subject_id:'annotation',mime:'image/png',name:'PARKED-preview.png'};
  data.evidence.push(inactiveSource,inactivePreview);
  data.plan_modes={draw:{evidence_id:inactiveSource.id,page:5,preview_evidence_id:inactivePreview.id,annotations:[],pending:{points:[{x:.1,y:.1}]},private_test_marker:'PARKED-ONLY-ANSWERS'}};
  const before=JSON.parse(JSON.stringify(data));assert.deepEqual(normalizeWorkflow(data).plan_modes,data.plan_modes);
  const hydrated=hydrateDraftReport(draft(data));assert.deepEqual(data,before);
  assert.ok(hydrated.documents.some(file=>file.id===data.plan.evidence_id));
  assert.ok(hydrated.documents.some(file=>file.id===data.plan.preview_evidence_id));
  assert.ok(!hydrated.documents.some(file=>[inactiveSource.id,inactivePreview.id].includes(file.id)));
  const media=presentationMedia(hydrated),entries=await zipEntries(media.documents[0].source),text=[...entries.values()].map(buffer=>buffer.toString()).join('\n');
  assert.ok(!media.photos.some(file=>file.id===inactivePreview.id));assert.doesNotMatch(text,/PARKED/);assert.match(text,/Готовый план помещения/);
  assert.ok([...entries.values()].some(buffer=>buffer.equals(Buffer.from('original:'+data.plan.evidence_id))));
});

test('an inactive source still used by an active additional sheet is retained',()=>{
  const data=attached(),source={id:randomUUID(),role:'plan-source',mime:'application/pdf',name:'Shared.pdf'};data.evidence.push(source);
  data.plan_modes={draw:{evidence_id:source.id,page:2,annotations:[],pending:{points:[{x:.1,y:.1}]}}};
  data.additional_plans=[{id:'extra',evidence_id:source.id,page:2,annotations:[]}];
  assert.ok(hydrateDraftReport(draft(data)).documents.some(file=>file.id===source.id));
});

test('a manager original remains in the report even when its ID also occurs in an inactive plan',()=>{
  const data=attached(),source={id:randomUUID(),role:'archive',mime:'application/pdf',name:'Manager original.pdf'};data.evidence.push(source);
  data.request_packet.materials=[{...source}];data.plan_modes={draw:{evidence_id:source.id,page:1,annotations:[]}};
  assert.ok(hydrateDraftReport(draft(data)).documents.some(file=>file.id===source.id));
});

test('switching back to explicit draw keeps its active geometry and omits only the parked attached plan',()=>{
  const data=compactVisit(),preview=data.evidence.find(file=>file.role==='plan');
  data.plan.mode='draw';data.plan.preview_evidence_id=preview.id;
  const parked={id:randomUUID(),role:'plan-source',mime:'image/png',name:'PARKED.png'};data.evidence.push(parked);
  data.plan_modes={attached:{mode:'attached',evidence_id:parked.id,page:1,annotations:[],pending:{points:[{x:.1,y:.1}]}}};
  const hydrated=hydrateDraftReport(draft(data));
  assert.equal(hydrated.plan.annotations.length,1);assert.ok(hydrated.documents.some(file=>file.id===data.plan.evidence_id));
  assert.ok(!hydrated.documents.some(file=>file.id===parked.id));
});

test('inactive flat source versions are omitted while versions still used by active plans remain original documents',()=>{
  const data=attached(),parked={id:randomUUID(),role:'plan-source',mime:'application/pdf',name:'PARKED-version.pdf'},shared={id:randomUUID(),role:'plan-source',mime:'application/pdf',name:'Shared-version.pdf'};
  data.evidence.push(parked,shared);
  data.plan_modes={draw:{evidence_id:'parked-current',versions:[{evidence_id:parked.id,page:1},{evidence_id:shared.id,page:2}]}};
  data.additional_plans=[{id:'extra',evidence_id:data.plan.evidence_id,page:2,annotations:[],versions:[{evidence_id:shared.id,page:2}]}];
  const hydrated=hydrateDraftReport(draft(data));
  assert.ok(!hydrated.documents.some(file=>file.id===parked.id));assert.ok(hydrated.documents.some(file=>file.id===shared.id));
  assert.equal(data.plan_modes.draw.versions[0].evidence_id,parked.id);
});

test('actual submit hydration accepts the ready-made source and delivers only the active preview once',async()=>{
  const data=attached(),snapshot=draft(data);let sends=0,submitted=0;
  const submit=createAuditSubmitter({async loadDraftForSubmit(){return snapshot;},async loadDraftDelivery(){return {};},async saveDraftDelivery(){},async markDraftSubmitted(){submitted++;},async releaseDraftSubmission(){assert.fail('Valid attached plan must not release submission');}},async(_ctx,report)=>{sends++;assert.equal(report.plan.mode,'attached');assert.equal(report.documents.filter(file=>file.role==='plan').length,1);},{loadPacket:async()=>data.request_packet});
  assert.equal((await submit(42,snapshot.id,1,{checkAuditAccess:async()=>{}})).ok,true);assert.equal(sends,1);assert.equal(submitted,1);
});
