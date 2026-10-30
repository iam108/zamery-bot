'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {helpers:H,tools} = require('../src/web/audit-plan-editor');
const G = require('../public/audit-editor-geometry');
const triangle = [{x:.1,y:.1},{x:.8,y:.1},{x:.5,y:.7}];

test('legacy ids are stable and pre-existing codes survive earlier gaps',()=>{
 const original={evidence_id:'source',annotations:[{tool:'boundary',points:triangle},{id:'real',code:'Г1',tool:'boundary',points:triangle}]};
 const s=H.normalise(original);assert.equal(s.annotations[1].code,'Г1');assert.equal(s.annotations[0].code,'Г2');assert.equal(H.normalise(original).annotations[0].id,s.annotations[0].id);assert.equal(original.annotations[0].id,undefined);
});
test('four entrances receive independent sequential labels and stable codes',()=>{
 let s={annotations:[]};for(let i=0;i<4;i++)s=H.addMark(s,'entrance',[{x:.1*i,y:.2}]);
 assert.deepEqual(s.annotations.map(m=>m.label),['Вход 1','Вход 2','Вход 3','Вход 4']);assert.deepEqual(s.annotations.map(m=>m.code),['В1','В2','В3','В4']);
 s.annotations[0].label='Вход со двора';s=H.addMark(s,'entrance',[{x:.8,y:.4}]);assert.equal(s.annotations.at(-1).label,'Вход 5');assert.equal(s.annotations[0].label,'Вход со двора');
});
test('single entrance and organization auto-link measurements; ambiguous endpoints stay empty',()=>{
 let s=H.addMark({},'entrance',[{x:.1,y:.1}]);s=H.addMark(s,'hazard',[{x:.6,y:.6}]);s=H.addMark(s,'route',[{x:.1,y:.1},{x:.6,y:.6}]);
 assert.equal(s.annotations[2].fromEntranceId,s.annotations[0].id);assert.equal(s.annotations[2].toObjectId,s.annotations[1].id);
 s=H.addMark(s,'entrance',[{x:.3,y:.1}]);s=H.addMark(s,'straight',[{x:.3,y:.1},{x:.6,y:.6}]);assert.equal(s.annotations.at(-1).fromEntranceId,undefined);assert.equal(s.annotations.at(-1).toObjectId,undefined);
});
test('pending contour survives normalization and blocks source change and export',()=>{
 const state=H.normalise({evidence_id:'a',page:2,pending:{tool:'boundary',points:triangle.slice(0,2)}});
 assert.equal(state.pending.points.length,2);assert.throws(()=>H.assertExportable(state),/Замкните/);assert.throws(()=>H.selectSource(state,'b',1),/Сначала/);
 const done=H.addMark(state,'boundary',triangle);assert.equal(done.pending,null);assert.doesNotThrow(()=>H.assertExportable(done));
});
test('crossing or degenerate polygons cannot be committed',()=>{
 assert.throws(()=>H.addMark({},'boundary',[{x:.1,y:.1},{x:.8,y:.8},{x:.8,y:.1},{x:.1,y:.8}]),/угла/);
 assert.throws(()=>H.addMark({},'boundary',[{x:.1,y:.1},{x:.3,y:.3},{x:.5,y:.5}]),/угла/);
 assert.equal(H.addMark({},'bar',triangle).annotations[0].tool,'bar');
});
test('selecting another PDF page versions old marks and restoring preserves original IDs',()=>{
 const marked={...H.addMark({},'boundary',triangle),evidence_id:'pdf',page:6};const markId=marked.annotations[0].id;
 const changed=H.selectSource(marked,'pdf',2);assert.equal(changed.page,2);assert.deepEqual(changed.annotations,[]);assert.equal(changed.versions[0].page,6);
 const back=H.restoreSource(changed);assert.equal(back.page,6);assert.equal(back.annotations[0].id,markId);assert.equal(back.versions.at(-1).page,2);
 assert.deepEqual(H.selectSource(marked,'pdf',6),H.normalise(marked));
});
test('annotations are independent between originals and additional instances',()=>{
 const first=H.addMark({evidence_id:'one',page:1},'licensed',triangle);const second=H.addMark({evidence_id:'two',page:3},'cadastral',triangle);
 second.annotations[0].label='Другой кадастр';assert.equal(first.annotations[0].label,undefined);assert.notEqual(first.annotations[0].id,second.annotations[0].id);
});
test('number sequence does not reuse a deleted entrance code',()=>{
 let s=H.addMark({},'entrance',[{x:.1,y:.1}]);s.annotations=[];s=H.addMark(s,'entrance',[{x:.2,y:.2}]);assert.equal(s.annotations[0].code,'В2');
});
test('organizations start pending, legal conclusions are never inferred',()=>{
 const s=H.addMark({},'hazard',[{x:.5,y:.5}]);assert.equal(s.annotations[0].status,'pending');assert.match(H.legendEntries(s,'map')[0].text,/не указан/);
 s.annotations[0].status='clear';s.annotations[0].label='Кафе';assert.match(H.legendEntries(s,'map')[0].text,/без замечаний/);
});
test('source filtering excludes generated annotation images and supports map originals',()=>{
 assert.equal(H.eligible({id:'1',role:'plan',mime:'image/png',subject_id:'annotation'},'plan'),false);
 assert.equal(H.eligible({id:'extra-preview',role:'plan',mime:'image/png',subject_id:'additional-1'},'plan'),false);
 assert.equal(H.eligible({id:'2',role:'map-source',mime:'image/png'},'map'),true);
 assert.equal(H.eligible({id:'3',role:'entrance',mime:'image/png'},'map'),false);
 assert.equal(H.eligible({id:'4',role:'egrn',mime:'application/pdf'},'plan'),true);
});
test('PDF detection supports generic MIME and binary signature',()=>{
 assert.equal(H.isPDF({name:'scan.bin',mime:'application/octet-stream'},Buffer.from('%PDF-1.7\n')),true);
 assert.equal(H.isPDF({name:'plan.PDF'}),true);
 assert.equal(H.isPDF({name:'x.png'},Buffer.from('abcd')),false);
});
test('geometry matches short point tools, legacy tools and plan polygons',()=>{
 assert.equal(tools.opening.point,true);assert.equal(tools.bar.polygon,true);assert.equal(tools.lease.polygon,true);assert.equal(tools.hall.polygon,true);
 const s=H.addMark({},'opening',[{x:.2,y:.4}]);assert.equal(s.annotations[0].points.length,1);
 assert.ok(!H.toolNames('plan','tobacco').some(([key])=>key==='licensed'));
});
test('hit-testing distinguishes corners and contour body using display pixels',()=>{
 const s=H.addMark({},'boundary',triangle);assert.deepEqual(H.hitTest(s,{x:.102,y:.102},600,400,12),{id:s.annotations[0].id,vertex:0});
 assert.deepEqual(H.hitTest(s,{x:.45,y:.3},600,400,12),{id:s.annotations[0].id,vertex:-1});
 assert.equal(H.hitTest(s,{x:.99,y:.99},600,400,12),null);
});
test('export renders selected source once and long names only below original drawing',()=>{
 const source={width:1200,height:800},calls=[];
 const ctx={font:'',measureText:t=>({width:String(t).length*8}),fillText:(...args)=>calls.push(['text',...args]),drawImage:(...args)=>calls.push(['image',...args]),fillRect(){},clearRect(){},save(){},restore(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},setLineDash(){},arc(){},strokeRect(){}};
 const canvas={getContext:()=>ctx};let s=H.addMark({},'boundary',triangle,{label:'Полное длинное название помещения и перегородок'});
 const output=H.renderScene(canvas,source,s,{artifact:true,scale:.75});assert.ok(output.height>source.height);assert.equal(calls.filter(c=>c[0]==='image').length,1);assert.equal(calls.find(c=>c[0]==='image')[1],source);
 assert.ok(calls.some(c=>c[0]==='text'&&c[1]==='Г1'&&c[3]<800));assert.ok(calls.filter(c=>c[0]==='text'&&String(c[1]).includes('Полное')).every(c=>c[3]>800));
});
test('history stores pending vertices and preserves captions during separate deletion undo',()=>{
 const m={id:'a',type:'contour',isClosed:true,code:'Г1',points:triangle,label:'Первый контур'};let h=G.createHistory([m]);h=G.commitHistory(h,[{...m,label:'Новое длинное название'}]);h=G.commitHistory(h,[]);h=G.undoHistory(h);assert.equal(h.present[0].label,'Новое длинное название');
 h=G.commitHistory(h,[...h.present,{id:'draft',type:'draft-contour',points:triangle.slice(0,2)}]);h=G.undoHistory(h);h=G.redoHistory(h);assert.equal(h.present.at(-1).points.length,2);
});

test('slow saves serialize first and latest state without a PUT for every typed character',async()=>{
 const writes=[];let release;const gate=new Promise(resolve=>{release=resolve;});
 const queue=H.createSaveQueue(async value=>{writes.push(value);if(value.name==='A')await gate;});
 queue.enqueue({name:'A'});await Promise.resolve();queue.enqueue({name:'AB'});queue.enqueue({name:'ABC'});release();await queue.flush();assert.deepEqual(writes,[{name:'A'},{name:'ABC'}]);
});
test('failed durable save rejects flush; retry writes the newest snapshot',async()=>{
 let fail=true;const writes=[];const queue=H.createSaveQueue(async value=>{writes.push(value);if(fail)throw new Error('offline');});
 await assert.rejects(queue.enqueue({page:2}),/offline/);await assert.rejects(queue.flush(),/offline/);fail=false;await queue.enqueue({page:3});await queue.flush();assert.deepEqual(writes,[{page:2},{page:3}]);
});
