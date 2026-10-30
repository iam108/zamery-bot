'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Editor=require('../src/web/audit-plan-editor');
function domHarness(t){
 const ctx={font:'',measureText:s=>({width:String(s).length*8}),fillText(){},drawImage(){},fillRect(){},clearRect(){},save(){},restore(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},setLineDash(){},arc(){},strokeRect(){}};
 class Node{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.attributes={};this.events={};this.hidden=false;this.className='';this.textContent='';this.value='';this.width=800;this.height=600;this.clientWidth=640;this.clientHeight=450;this.scrollTop=this.scrollLeft=0;this.capture=new Set();this.open=false;this.classList={contains:c=>this.className.split(' ').includes(c),toggle:(c,on)=>{const values=new Set(this.className.split(' ').filter(Boolean));if(on===undefined)on=!values.has(c);on?values.add(c):values.delete(c);this.className=[...values].join(' ');},add:c=>this.classList.toggle(c,true),remove:c=>this.classList.toggle(c,false)};}
  append(...nodes){nodes.forEach(n=>{n.parentElement=this;this.children.push(n);});}prepend(...nodes){nodes.forEach(n=>{n.parentElement=this;});this.children.unshift(...nodes);}replaceChildren(...nodes){this.children=[];this.append(...nodes);}setAttribute(k,v){this.attributes[k]=String(v);}getAttribute(k){return this.attributes[k];}addEventListener(name,fn){(this.events[name]||=[]).push(fn);}emit(name,e={}){for(const fn of this.events[name]||[])fn({target:this,preventDefault(){},...e});}focus(){document.activeElement=this;}scrollIntoView(options){this.scrolled=true;this.scrollOptions=options;}getContext(){return ctx;}getBoundingClientRect(){return{left:0,top:0,width:600,height:400};}setPointerCapture(id){this.capture.add(id);}hasPointerCapture(id){return this.capture.has(id);}releasePointerCapture(id){this.capture.delete(id);}showModal(){this.open=true;}close(){this.open=false;this.emit('close');}
  descendants(){return this.children.flatMap(n=>[n,...n.descendants()]);}querySelectorAll(s){if(s==='[data-endpoint]')return this.descendants().filter(n=>n.dataset.endpoint);return[];}querySelector(s){if(s==='.ape-mark-row input')return this.descendants().find(n=>n.tagName==='INPUT'&&n.parentElement?.className==='ape-mark-row');return this.querySelectorAll(s)[0]||null;}get options(){return this.children;}toDataURL(){return'data:image/png;base64,AAAA';}
 }
 const saved={};for(const key of ['document','Image','Option','requestAnimationFrame','fetch'])saved[key]=Object.getOwnPropertyDescriptor(global,key);
 const document={createElement:tag=>new Node(tag),body:new Node('body')};
 Object.assign(global,{document,Image:class{constructor(){this.naturalWidth=800;this.naturalHeight=600;}set src(v){queueMicrotask(()=>this.onload());}},Option:class extends Node{constructor(text,value){super('option');this.textContent=text;this.value=value;}},requestAnimationFrame:fn=>fn(),fetch:async()=>({ok:true,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer})});
 t.after(()=>{for(const[key,value]of Object.entries(saved))value?Object.defineProperty(global,key,value):delete global[key];});
 const container=new Node('div'),find=(predicate)=>container.descendants().find(predicate),button=name=>find(n=>n.tagName==='BUTTON'&&n.textContent===name),canvas=()=>find(n=>n.tagName==='CANVAS'&&n.getAttribute('aria-label')==='Схема территории для разметки');
 let state={evidence_id:'map-original',page:1,annotations:[]},writes=0;const api=Editor.mount(container,{kind:'map',getState:()=>state,onChange:async value=>{state=structuredClone(value);writes++;},evidence:[{id:'map-original',name:'map.png',mime:'image/png',role:'map-source'}],evidenceUrl:async()=> 'blob:test'});
 const event=(x,y,extra={})=>({pointerId:1,button:0,pointerType:'touch',clientX:x,clientY:y,...extra}),tap=(x,y)=>{canvas().emit('pointerdown',event(x,y));canvas().emit('pointerup',event(x,y));};
 return{api,container,find,button,canvas,event,tap,get state(){return state;},get writes(){return writes;},document};
}
test('map has direct add buttons and a placed entrance switches safely to selection',async t=>{
 const h=domHarness(t);await h.api.refresh();assert.ok(h.button('+ Вход'));assert.ok(h.button('+ Организация'));assert.ok(h.button('+ Замер'));
 h.tap(100,100);await h.api.flush();assert.equal(h.state.annotations.length,0,'Initial map interaction must not accidentally create an entrance');
 h.button('+ Вход').emit('click');h.tap(100,100);await h.api.flush();assert.equal(h.state.annotations.length,1);const pin=h.state.annotations[0];assert.equal(pin.label,'Вход 1');assert.equal(h.button('Выбрать').getAttribute('aria-pressed'),'true');
 const selected=h.find(n=>n.className==='ape-selected-panel');assert.equal(selected.hidden,false);assert.equal(!!selected.scrolled,false,'Adding an entrance keeps the map and tools visible');assert.ok(h.button('На карту ↑'));
 h.button('На карту ↑').emit('click');const toolbar=h.find(n=>n.className==='ape-toolbar');assert.equal(toolbar.scrolled,true,'Return to map also exposes the add controls');assert.equal(toolbar.scrollOptions.block,'start');
 h.tap(100,100);await h.api.flush();assert.equal(h.state.annotations.length,1,'Tapping an existing entrance must edit it rather than create a duplicate');assert.equal(h.state.annotations[0].id,pin.id);
 h.api.destroy();
});
test('organization card is immediately visible and typing keeps the input and stable marker',async t=>{
 const h=domHarness(t);await h.api.refresh();h.button('+ Организация').emit('click');h.tap(400,250);await h.api.flush();
 const pin=h.state.annotations[0],input=h.find(n=>n.getAttribute('aria-label')==='Название организации '+pin.code),panel=h.find(n=>n.className==='ape-selected-panel');assert.equal(panel.hidden,false);assert.equal(h.document.activeElement,input);assert.equal(pin.status,'pending');
 input.value='Проверенная школа';input.emit('input');await h.api.flush();assert.equal(h.state.annotations[0].label,'Проверенная школа');assert.equal(h.state.annotations[0].id,pin.id);assert.equal(h.find(n=>n.getAttribute('aria-label')==='Название организации '+pin.code),input,'Saving a name must not recreate the field under the keyboard');
 h.api.destroy();
});
test('small touch jitter cannot move a saved pin or create another point',async t=>{
 const h=domHarness(t);await h.api.refresh();h.button('+ Вход').emit('click');h.tap(100,100);await h.api.flush();const original=structuredClone(h.state.annotations[0]),writes=h.writes;
 h.canvas().emit('pointerdown',h.event(100,100));h.canvas().emit('pointermove',h.event(104,104));h.canvas().emit('pointerup',h.event(104,104));await h.api.flush();assert.deepEqual(h.state.annotations[0],original);assert.equal(h.writes,writes);
 h.button('+ Организация').emit('click');h.canvas().emit('pointerdown',h.event(200,200));h.canvas().emit('pointermove',h.event(230,230));h.canvas().emit('pointerup',h.event(230,230));await h.api.flush();assert.equal(h.state.annotations.length,1,'A dragging gesture is not a placement tap');h.api.destroy();
});

test('drawn measurement opens its distance/endpoints immediately and preserves a manual choice',async t=>{
 const h=domHarness(t);await h.api.refresh();
 h.button('+ Вход').emit('click');h.tap(60,40);await h.api.flush();const first=h.state.annotations[0];
 h.button('+ Вход').emit('click');h.tap(240,40);await h.api.flush();const second=h.state.annotations[1];
 h.button('+ Организация').emit('click');h.tap(480,280);await h.api.flush();const org=h.state.annotations[2];
 h.button('+ Замер').emit('click');const panel=h.find(n=>n.className==='ape-selected-panel');assert.equal(panel.hidden,true,'The old organization card is hidden while drawing a new measurement');
 h.canvas().emit('pointerdown',h.event(240,40));h.canvas().emit('pointermove',h.event(300,90));h.canvas().emit('pointermove',h.event(400,200));h.canvas().emit('pointerup',h.event(480,280));await h.api.flush();
 const measurement=h.state.annotations[3];assert.equal(measurement.fromEntranceId,second.id);assert.equal(measurement.toObjectId,org.id);assert.equal(panel.hidden,false);
 const distance=h.find(n=>n.getAttribute('aria-label')==='Замер '+measurement.code+', м');assert.ok(distance);distance.value='125';distance.emit('input');await h.api.flush();assert.equal(h.state.annotations[3].distance,'125');
 const from=h.find(n=>n.getAttribute('aria-label')==='От входа · '+measurement.code);from.value=first.id;from.emit('change');await h.api.flush();assert.equal(h.state.annotations[3].fromEntranceId,first.id);assert.equal(h.state.annotations[3].distance,'125');h.api.destroy();
});
test('map marker deletion and undo restore the same IDs, not another entrance number',async t=>{
 const h=domHarness(t);await h.api.refresh();h.button('+ Вход').emit('click');h.tap(100,100);await h.api.flush();const first=structuredClone(h.state.annotations[0]);
 h.find(n=>n.getAttribute('aria-label')==='Удалить отметку '+first.code).emit('click');await h.api.flush();assert.equal(h.state.annotations.length,0);
 h.find(n=>n.getAttribute('aria-label')==='Отменить действие').emit('click');await h.api.flush();assert.deepEqual(h.state.annotations[0],first);
 h.button('+ Вход').emit('click');h.tap(200,120);await h.api.flush();assert.equal(h.state.annotations[1].code,'В2');h.api.destroy();
});
