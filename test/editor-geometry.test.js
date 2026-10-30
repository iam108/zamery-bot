'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const G = require('../public/audit-editor-geometry.js');
const p = (x, y) => ({ x, y });
const rectangle = [p(.2,.2), p(.8,.2), p(.8,.8), p(.2,.8)];
const contour = (overrides = {}) => ({ id:'boundary-11', type:'contour', code:'Г7', points:structuredClone(rectangle), isClosed:true, label:'Граница помещения по актуальной поэтажке', ...overrides });
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-11, `${a} ≠ ${b}`);
const freeze = value => { Object.freeze(value); for (const v of Object.values(value)) if (v && typeof v === 'object') freeze(v); return value; };

test('browser UMD exposes the same API without CommonJS or structuredClone', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../public/audit-editor-geometry.js'), 'utf8'), context);
  assert.equal(typeof context.AuditEditorGeometry.moveVertex, 'function');
  assert.equal(context.AuditEditorGeometry.closedContour(rectangle), true);
  const h = context.AuditEditorGeometry.createHistory([contour()]);
  h.present[0].label = 'copy';
  assert.equal(h.present[0].code,'Г7');
});

test('coordinates clamp, while corrupt inputs are rejected instead of silently becoming zero', () => {
  assert.deepEqual(G.clampPoint(p(-.3,1.8)),p(0,1));
  assert.deepEqual(G.clampPoint(p(.1,.9)),p(.1,.9));
  near(G.distance(p(0,0),p(.3,.4)),.5);
  for (const bad of [p(NaN,0), p(0,Infinity), {x:'0',y:0},null]) assert.throws(() => G.clampPoint(bad),TypeError);
});

test('closed contours accept both winding directions and explicit closing vertex', () => {
  assert.equal(G.closedContour(rectangle),true);
  assert.equal(G.closedContour(rectangle.toReversed()),true);
  assert.equal(G.closedContour([...rectangle,rectangle[0]]),true);
  near(G.signedArea(rectangle),.36);
  near(G.signedArea(rectangle.toReversed()),-.36);
});

test('unclosed drafts, repeated vertices, degenerate and crossing shapes cannot masquerade as a boundary', () => {
  const invalid = [[], [p(.1,.1),p(.5,.5)], [p(0,0),p(.5,.5),p(1,1)],
    [p(.1,.1),p(.1,.1),p(.8,.8)], [p(.1,.1),p(.10001,.1),p(.1,.10001)],
    [p(.1,.1),p(.9,.9),p(.1,.9),p(.9,.1)],
    [p(.1,.1),p(.9,.8),p(.1,.9),p(.8,.1)], // nonzero-area self intersection
    [p(-.1,0),p(.5,0),p(.5,.5)], [p(0,0),p(NaN,.8),p(1,0)]];
  invalid.forEach(points => assert.equal(G.closedContour(points),false,JSON.stringify(points)));
  assert.equal(G.closedContour([p(0,0),p(1,0),p(0,1)]),true);
});

test('moving a corner clamps it, preserves identity/caption and never mutates input', () => {
  const source = freeze(contour({attachments:[{id:'photo-7'}]}));
  const changed = G.moveVertex(source,0,p(-.4,-.3));
  assert.deepEqual(changed.points[0],p(0,0));
  assert.deepEqual(source.points[0],p(.2,.2));
  assert.equal(changed.id,source.id); assert.equal(changed.code,source.code); assert.equal(changed.label,source.label);
  changed.attachments[0].id='different'; assert.equal(source.attachments[0].id,'photo-7');
  assert.throws(() => G.moveVertex(source,-1,p(0,0)),RangeError);
  assert.throws(() => G.moveVertex(source,4,p(0,0)),RangeError);
  assert.throws(() => G.moveVertex(source,.5,p(0,0)),RangeError);
  assert.throws(() => G.moveVertex(source,0,p(.8,.2)),RangeError);
});

test('remove vertex retains valid area, but refuses collapse of a committed triangle', () => {
  const source=freeze(contour());
  const changed=G.removeVertex(source,1);
  assert.equal(changed.points.length,3); assert.equal(G.closedContour(changed.points),true);
  assert.equal(source.points.length,4); assert.equal(changed.code,'Г7');
  assert.throws(() => G.removeVertex(changed,0),RangeError);
  assert.throws(() => G.removeVertex(source,6),RangeError);
});

test('whole-contour movement clamps translation as one vector and never flattens the shape at an edge', () => {
  const source=freeze(contour());
  const moved=G.moveContour(source,12,-12);
  near(moved.points[0].x,.4); near(moved.points[0].y,0);
  near(G.signedArea(moved.points),G.signedArea(source.points));
  for (let i=0;i<source.points.length;i++) {
    near(moved.points[i].x-source.points[i].x,.2); near(moved.points[i].y-source.points[i].y,-.2);
    assert.ok(moved.points[i].x>=0 && moved.points[i].x<=1 && moved.points[i].y>=0 && moved.points[i].y<=1);
  }
  const again=G.moveContour(moved,1,-1); assert.deepEqual(again,moved);
  assert.equal(moved.id,source.id); assert.deepEqual(source.points,rectangle);
});

test('nearest vertex uses hit tolerance and visually topmost contour, excluding drafts', () => {
  const bottom=contour({id:'bottom'}), top=contour({id:'top'});
  const draft=contour({id:'draft',isClosed:false});
  const picked=G.nearestVertex([bottom,top,draft],p(.21,.2),.011);
  assert.equal(picked.markId,'top'); assert.equal(picked.index,0); near(picked.distance,.01);
  assert.equal(G.nearestVertex([bottom],p(.21,.2),.009),null);
  assert.equal(G.nearestVertex([bottom],p(.2,.2),0).index,0);
  assert.throws(() => G.nearestVertex([bottom],p(.2,.2),-1),RangeError);
});

test('point-in-polygon respects concavities and includes vertices/edges', () => {
  const lshape=[p(.1,.1),p(.9,.1),p(.9,.4),p(.4,.4),p(.4,.9),p(.1,.9)];
  assert.equal(G.closedContour(lshape),true);
  assert.equal(G.pointInPolygon(p(.2,.8),lshape),true);
  assert.equal(G.pointInPolygon(p(.8,.8),lshape),false);
  assert.equal(G.pointInPolygon(p(.4,.6),lshape),true);
  assert.equal(G.pointInPolygon(p(.4,.4),lshape),true);
  assert.equal(G.pointInPolygon(p(0,0),lshape),false);
  assert.equal(G.pointInPolygon(p(.1,.1),[p(0,0),p(.2,.2)]),false);
});

test('hit-test selects topmost interior or nearby edge without selecting a draft', () => {
  const bottom=contour({id:'bottom'}), top=contour({id:'top'}), draft=contour({id:'draft',isClosed:false});
  assert.equal(G.hitTestContour([bottom,top,draft],p(.5,.5)),'top');
  assert.equal(G.hitTestContour([bottom],p(.19,.5),.011),'bottom');
  assert.equal(G.hitTestContour([bottom],p(.19,.5),.009),null);
  assert.equal(G.hitTestContour([draft],p(.5,.5)),null);
});

test('codes never reuse deleted numbers when the monotonic counter is retained outside history', () => {
  assert.deepEqual(G.getNextContourCode([{code:'Г1'},{code:'Г12'},{code:'О99'}],4),{code:'Г13',sequence:13});
  const counter=G.getNextContourCode([contour()],0).sequence;
  assert.equal(counter,8);
  assert.deepEqual(G.getNextContourCode([],counter),{code:'Г9',sequence:9});
  assert.equal(G.getNextContourCode([{code:'Г1'}],counter).code,'Г9');
  assert.throws(() => G.getNextContourCode([],-1),RangeError);
});

test('draft vertices have a distinct type and survive undo/redo without becoming committed contours', () => {
  let h=G.createHistory([]);
  const draft={id:'__draft-contour',type:'draft-contour',points:[p(.1,.1),p(.8,.1)]};
  h=G.commitHistory(h,[draft]);
  const three={...draft,points:[...draft.points,p(.5,.8)]};
  h=G.commitHistory(h,[three]);
  const committed=contour({points:three.points});
  h=G.commitHistory(h,[committed]);
  const undo=G.undoHistory(h); assert.equal(undo.present[0].type,'draft-contour'); assert.equal(undo.present[0].points.length,3);
  const undo2=G.undoHistory(undo); assert.equal(undo2.present[0].points.length,2);
  const redo=G.redoHistory(G.redoHistory(undo2));
  assert.deepEqual(redo.present,[committed]); assert.equal(redo.present[0].id,'boundary-11');
  assert.throws(() => G.commitHistory(h,[{...committed,isClosed:false}]),/Draft contour/);
});

test('history is immutable, bounded and preserves full captions/identities through edits', () => {
  const caption='Длинное пояснение для легенды: лицензированные границы, крыльцо и спорная перегородка, требующая сверки с БТИ';
  const initial=[contour({label:caption})];
  const h0=G.createHistory(initial,2); initial[0].label='changed outside';
  assert.equal(h0.present[0].label,caption);
  const h1=G.commitHistory(freeze(h0),[G.moveVertex(h0.present[0],0,p(.1,.1))]);
  const h2=G.commitHistory(freeze(h1),[G.moveContour(h1.present[0],.05,.05)]);
  const h3=G.commitHistory(freeze(h2),[{...h2.present[0],label:caption+'; уточнено'}]);
  assert.equal(h3.past.length,2);
  const undone=G.undoHistory(freeze(h3)); assert.equal(undone.present[0].label,caption);
  const redone=G.redoHistory(freeze(undone)); assert.deepEqual(redone.present,h3.present);
  assert.equal(redone.present[0].id,'boundary-11'); assert.equal(redone.present[0].code,'Г7');
  redone.present[0].points[0].x=0; assert.notEqual(h3.present[0].points[0].x,0);
});

test('identical commit retains redo, while a genuine edit creates a new history branch', () => {
  const h0=G.createHistory([contour()]);
  const h1=G.commitHistory(h0,[{...contour(),label:'Новое пояснение'}]);
  const undo=G.undoHistory(h1);
  const noOp=G.commitHistory(undo,[{...undo.present[0]}]);
  assert.equal(noOp.past.length,undo.past.length); assert.equal(noOp.future.length,1);
  assert.equal(G.redoHistory(noOp).present[0].label,'Новое пояснение');
  const branch=G.commitHistory(undo,[{...undo.present[0],label:'Иная поправка'}]);
  assert.equal(branch.future.length,0);
  assert.deepEqual(G.redoHistory(branch),branch);
});

test('screen stroke remains two CSS pixels at every supported zoom', () => {
  for (const scale of [.25,.5,1,2,4,12]) near(G.strokeWidth(scale)*scale,2);
  near(G.strokeWidth(3,3)*3,3);
  for (const scale of [0,-1,NaN,Infinity]) assert.throws(() => G.strokeWidth(scale));
});

test('badges stay inside viewport edges and do not collapse to zero on a tiny view', () => {
  const viewport={width:320,height:180},badge={width:32,height:22};
  for (const anchor of [p(-50,-30),p(0,0),p(320,180),p(500,400)]) {
    const b=G.badgeBounds(anchor,badge,viewport);
    assert.ok(b.x>=0 && b.y>=0 && b.x+b.width<=320 && b.y+b.height<=180);
    assert.equal(b.width,32); assert.equal(b.height,22); assert.equal(b.clipped,false);
  }
  const tiny=G.badgeBounds(p(1,1),badge,{width:6,height:5});
  assert.deepEqual(tiny,{x:0,y:0,width:6,height:5,clipped:true});
});

test('legend keeps sparse stable codes and complete captions, never includes draft contours', () => {
  const long='Отмеченная граница помещения — длинное пояснение, которое не должно переноситься огромной надписью на чертёж';
  const marks=[contour({id:'b1',code:'Г1',label:long}),contour({id:'b8',code:'Г8'}),
    {id:'o4',code:'О4',type:'problem',label:'Проверенная организация'},contour({id:'draft',isClosed:false}),
    {id:'__draft-contour',code:'Г9',type:'draft-contour',points:rectangle}];
  const legend=G.buildLegend(marks);
  assert.deepEqual(legend.map(x=>x.code),['Г1','Г8','О4']); assert.equal(legend[0].label,long);
  assert.equal(legend[1].markId,'b8');
});
