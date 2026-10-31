const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/web/audit-wizard-client.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function actualFunction(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name + ' exists in the real browser client');
  const rest = source.slice(start), next = rest.slice(1).search(/\n  (?:(?:async )?function |var )/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
function load(c, ...names) { vm.runInContext(names.map(actualFunction).join('\n'), c); }
function harness() {
  const calls=[],nodes=new Map();
  const node=key=>{if(!nodes.has(key))nodes.set(key,{textContent:'',innerHTML:'',dataset:{},style:{},disabled:false,hidden:false,querySelector:()=>null,querySelectorAll:()=>[],remove(){calls.push(['host-removed']);}});return nodes.get(key);};
  const c={
    state:{data:{schema_version:3,ui_version:5,object_category:'catering',inspection:{org:'Тест',address:'Москва',service:'Получение',visit_date:'2026-10-30'},workflow:{step:2,conclusion_status:'actions'},conclusion:'Есть замечания',entrances:[],zones:[],plan:{evidence_id:'plan-original',page:6,annotations:[{id:'p1',tool:'boundary'}]},map:{evidence_id:'map-original',page:1,annotations:[{id:'e1',tool:'entrance'}]},additional_plans:[]},draft:{id:'draft-test',revision:10},evidence:[],dirty:false,serverError:'',version:0,frozen:false,submitting:false,completed:false,packet:{materials:[]}},
    $:node,root:node('#root'),calls,tail:Promise.resolve(),timer:null,editor:null,activePlanId:'main',orderId:'123',localKey:'test-only',tg:null,
    clone:copy,clearTimeout,setTimeout,console,
    document:{body:{classList:{add(){},remove(){}},appendChild(){calls.push(['host-added']);}},createElement:()=>node('export-host')},
    window:{},localStorage:{setItem(){},removeItem(){}},
    render(){calls.push(['render']);},refreshChrome(){},notify(text){calls.push(['notify',text]);},notice(){},status(text){calls.push(['status',text]);},timeLabel:()=> '12:00',localDate:()=> '2026-10-30',localSave(){},issues:()=>[],packetFiles:()=>[],
    changed(){c.state.dirty=true;c.state.version++;},syncMapCards(){},evidenceUrl:async id=>'blob:'+id,uploadEditorSource:async()=>{},
    flush:async()=>{calls.push(['flush']);c.state.dirty=false;},
    exportGraphic:async(plan,kind,subject)=>{calls.push(['export',kind,subject,plan.evidence_id]);return {name:kind+'.png',mime:'image/png',role:kind,data:'generated-'+plan.evidence_id};},
    postEvidence:async(file,role,subject,data)=>{const e={id:'new-'+role+'-'+subject,role,subject_id:subject};c.state.evidence.push(e);c.state.draft.revision++;calls.push(['upload',e.id,data]);return e;},
    request:async(url,options)=>{calls.push(['request',url,options]);if(options?.method==='DELETE')return {ok:true,revision:c.state.draft.revision+1};return {ok:true};},
    checkSubmissionState:async entered=>{calls.push(['check-submission',entered]);},
    defaults:{inspection:{region:'МСК'},workflow:{step:0},plan:{},map:{},additional_plans:[]}
  };
  vm.createContext(c);load(c,'queue','step','isRenewal','evidenceFor','adoptRevision','removeGeneratedEvidence','submit','currentPlan','setCurrentPlan');return c;
}

test('the first Call click dispatches the one-shot dial URL without opening a contact dialog',()=>{
  const c=harness(),button={},events=[];
  c.actions=require('../public/audit-actions');c.phoneHandoffBase='https://iam108.github.io/zamery-bot/';
  c.packetPhone=()=>'+79995554433';c.saveNow=async()=>{events.push('save');};
  c.openExternal=url=>{events.push(['open',url]);return true;};c.showContact=()=>{assert.fail('An intermediate contact dialog adds an unnecessary step');};
  const scope={querySelectorAll:()=>[],querySelector:s=>s==='[data-call]'?button:null};load(c,'nativePhoneLink','phoneActionUrl','saveBeforePhone','bindPhoneAction','bind');c.bind(scope);
  button.onclick({preventDefault(){events.push('prevent');}});
  assert.equal(events.filter(e=>Array.isArray(e)).length,1);
  const url=new URL(events.find(e=>Array.isArray(e))[1]);assert.equal(url.origin,'https://iam108.github.io');assert.equal(url.pathname,'/zamery-bot/audit-call.html');
  const hash=new URLSearchParams(url.hash.slice(1));assert.equal(hash.get('phone'),'+79995554433');assert.equal(hash.get('dial'),'1');
});

test('iOS Telegram Call keeps the real tel link tap even when saving fails',()=>{
  const c=harness(),button={};let saves=0;
  c.actions=require('../public/audit-actions');c.phoneHandoffBase='https://iam108.github.io/zamery-bot/';
  c.tg={platform:'ios',openLink(){assert.fail('The SDK rejects tel URLs; the native link must handle this tap');}};
  c.window.TelegramWebviewProxy={postEvent(){}};
  c.packetPhone=()=>'+79995554433';c.localSave=()=>{throw new Error('storage full');};c.saveNow=()=>{saves++;throw new Error('offline');};
  c.openExternal=()=>assert.fail('iOS must not visit an HTTPS handoff page');c.showContact=()=>assert.fail('No contact sheet is needed before iOS dialing');
  const scope={querySelectorAll:()=>[],querySelector:s=>s==='[data-call]'?button:null};
  load(c,'nativePhoneLink','phoneActionUrl','saveBeforePhone','bindPhoneAction','bind');c.bind(scope);
  assert.equal(button.href,'tel:+79995554433');assert.equal(button.target,'_blank');assert.equal(button.rel,'noopener');
  assert.doesNotThrow(()=>button.onclick({preventDefault(){assert.fail('Canceling the tap loses the native iOS URL-opening path');}}));
  assert.equal(saves,1,'The server save is attempted independently of local storage failure');
});

test('native phone selection requires a real iOS bridge or an ordinary iPhone browser',()=>{
  for(const [name,platform,bridge,userAgent,native] of [
    ['Telegram iOS','ios',true,'',true],
    ['Telegram macOS','macos',true,'Mozilla/5.0 (iPhone)',false],
    ['Telegram Android','android',true,'',false],
    ['SDK-only desktop preview','ios',false,'Mozilla/5.0 (Macintosh)',false],
    ['Safari on iPhone','unknown',false,'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',true]
  ]){
    const c=harness();c.actions=require('../public/audit-actions');c.phoneHandoffBase='https://iam108.github.io/zamery-bot/';c.tg={platform};
    c.window.navigator={userAgent};if(bridge)c.window.TelegramWebviewProxy={postEvent(){}};
    load(c,'nativePhoneLink','phoneActionUrl');
    assert.equal(c.nativePhoneLink(),native,name);
    const href=c.phoneActionUrl('+79995554433');
    assert.equal(href.startsWith('tel:'),native,name);
    if(!native){const url=new URL(href);assert.equal(url.host,'iam108.github.io',name);assert.equal(new URLSearchParams(url.hash.slice(1)).get('dial'),'1',name);}
  }
});

test('a pending server save does not hold up the desktop phone handoff',()=>{
  const c=harness(),button={};let opened=0;
  c.actions=require('../public/audit-actions');c.phoneHandoffBase='https://iam108.github.io/zamery-bot/';
  c.saveNow=()=>new Promise(()=>{});c.openExternal=()=>{opened++;return true;};
  load(c,'nativePhoneLink','phoneActionUrl','saveBeforePhone','bindPhoneAction');c.bindPhoneAction(button,'+79995554433',()=>assert.fail('Dispatch succeeded'));
  button.onclick({preventDefault(){}});assert.equal(opened,1);
});

test('contact sheet uses the same native iOS and desktop handoff behavior as the main Call button',()=>{
  for(const native of [true,false]){
    const c=harness(),elements=new Map();let opened=0,prevented=0;
    const element=selector=>{if(!elements.has(selector))elements.set(selector,{});return elements.get(selector);};
    const dialog={setAttribute(){},querySelector:element,addEventListener(){},showModal(){this.open=true;}};
    c.document.getElementById=()=>null;c.document.createElement=()=>dialog;
    c.actions=require('../public/audit-actions');c.phoneHandoffBase='https://iam108.github.io/zamery-bot/';c.packetPhone=()=>'+79995554433';
    c.tg={platform:native?'ios':'macos'};c.window.TelegramWebviewProxy={postEvent(){}};
    c.saveNow=async()=>{};c.esc=String;c.openExternal=()=>{opened++;return false;};
    load(c,'nativePhoneLink','phoneActionUrl','saveBeforePhone','bindPhoneAction','packetContactText','showContact');c.showContact();
    const dial=element('[data-dial]');assert.equal(dial.target,'_blank');assert.equal(dial.href.startsWith('tel:'),native);
    dial.onclick({preventDefault(){prevented++;}});
    assert.equal(prevented,native?0:1);assert.equal(opened,native?0:1);
    if(!native)assert.match(element('[data-contact-status]').textContent,/Скопируйте номер/);
  }
});

test('route binding prepares the saved object once and reuses it across renders',()=>{
  const c=harness(),button={};let prepared=0,bound=0;
  c.routeController=null;c.routeControllerKey='';c.state.packet.address='Москва, Тестовая, 1';
  c.actions=require('../public/audit-actions');c.saveBeforePhone=()=>{};c.openExternal=()=>true;
  c.window.AuditRoute={prepare(options){prepared++;assert.equal(options.address,'Москва, Тестовая, 1');options.load();return{bind(b){assert.equal(b,button);bound++;}};}};
  const scope={querySelectorAll:()=>[],querySelector:s=>s==='[data-route]'?button:null};
  load(c,'bindRouteAction','bind');c.bind(scope);c.bind(scope);
  assert.equal(prepared,1);assert.equal(bound,2);assert.equal(c.calls.find(x=>x[0]==='request')[1],'/api/audit/orders/123/route');
});

test('retry exports only current images and retires removed extra artifacts while keeping originals',async()=>{
  const c=harness();c.state.data.additional_plans=[{id:'extra-kept',evidence_id:'extra-original',page:2,annotations:[{id:'x1',tool:'licensed'}]}];
  c.state.evidence=[{id:'map-original',role:'map-source',subject_id:'source'},{id:'plan-original',role:'plan-source',subject_id:'source'},{id:'removed-extra-original',role:'plan-source',subject_id:'source'},{id:'entrance-photo',role:'entrance',subject_id:'e1'},
    {id:'map-old',role:'map',subject_id:'annotation'},{id:'plan-old',role:'plan',subject_id:'annotation'},{id:'extra-old',role:'plan',subject_id:'annotation-extra-kept'},{id:'retired-extra-png',role:'plan',subject_id:'annotation-extra-removed'}];
  await c.submit();
  const remaining=c.state.evidence.map(e=>e.id);for(const id of ['map-original','plan-original','removed-extra-original','entrance-photo'])assert.ok(remaining.includes(id),id);
  for(const id of ['map-old','plan-old','extra-old','retired-extra-png'])assert.ok(!remaining.includes(id),id);
  assert.equal(c.state.evidence.filter(e=>e.role==='map').length,1);assert.equal(c.state.evidence.filter(e=>e.role==='plan').length,2);
  const requests=c.calls.filter(call=>call[0]==='request'),last=requests.at(-1);assert.equal(last[1],'/api/audit');
  assert.equal(JSON.parse(last[2].body).revision,c.state.draft.revision);assert.equal(c.state.completed,true);
});

test('failure to retire a generated image stops submission without reporting success',async()=>{
  const c=harness();c.state.evidence=[{id:'retired-extra-png',role:'plan',subject_id:'annotation-removed'}];
  const request=c.request;c.request=async(url,options)=>{if(options?.method==='DELETE')throw new Error('save failed');return request(url,options);};
  await c.submit();assert.equal(c.state.completed,false);assert.equal(c.state.frozen,false);assert.ok(c.state.evidence.some(e=>e.id==='retired-extra-png'));
  assert.ok(!c.calls.some(call=>call[0]==='request'&&call[1]==='/api/audit'));
});

test('frozen submission retry sends the exact revision and never regenerates or cleans evidence',async()=>{
  const c=harness();c.state.frozen=true;c.state.evidence=[{id:'frozen-export',role:'plan',subject_id:'annotation-retired-but-frozen'}];
  const before=copy({data:c.state.data,evidence:c.state.evidence});await c.submit();
  assert.deepEqual(copy({data:c.state.data,evidence:c.state.evidence}),before);assert.ok(!c.calls.some(call=>['export','upload','flush'].includes(call[0])));
  const requests=c.calls.filter(call=>call[0]==='request');assert.equal(requests.length,1);assert.equal(JSON.parse(requests[0][2].body).revision,10);assert.equal(c.state.completed,true);
});

test('restoring a frozen server snapshot preserves its UI version, source page and evidence',()=>{
  const c=harness();load(c,'merge','restoreData','frozenSnapshot');c.state.data.workflow.step=1;
  const remote={id:'draft-test',revision:17,submitting:true,data:{schema_version:3,ui_version:4,inspection:{org:'Зафиксированный объект'},workflow:{step:2},plan:{evidence_id:'frozen-plan',page:6,annotations:[{id:'old-valid-mark'}]},request_packet:{org:'Менеджер: исходная версия'}},evidence:[{id:'frozen-plan',role:'plan-source'}]};
  c.frozenSnapshot(remote);
  assert.equal(c.state.data.ui_version,4);assert.equal(c.state.data.plan.page,6);assert.equal(c.state.data.plan.annotations[0].id,'old-valid-mark');assert.equal(c.state.draft.revision,17);assert.equal(c.state.viewStep,1);assert.equal(c.state.frozen,true);assert.equal(c.state.dirty,false);assert.deepEqual(copy(c.state.evidence),remote.evidence);assert.equal(c.state.packet.org,remote.data.request_packet.org);
});

test('unchanged editor snapshot retries a previously failed write instead of falsely acknowledging save',async()=>{
  const c=harness();c.state.data.workflow.step=1;let options,writes=0;
  c.window.AuditPlanEditor={mount(container,value){options=value;return {};}};
  c.saveNow=async()=>{writes++;if(writes===1){c.state.serverError='failed';throw new Error('write failed');}c.state.dirty=false;c.state.serverError='';return c.state.draft;};load(c,'mountEditor');c.mountEditor();
  const changed=copy(c.state.data.plan);changed.annotations.push({id:'new-mark',tool:'partition'});
  await assert.rejects(options.onChange(changed),/write failed/);assert.equal(c.state.data.plan.annotations.length,2);assert.equal(c.state.dirty,true);
  await options.onChange(copy(changed));assert.equal(writes,2);assert.equal(c.state.dirty,false);
  await options.onChange(copy(changed));assert.equal(writes,2,'A clean identical snapshot needs no extra request');
  c.state.frozen=true;assert.equal(options.onChange({annotations:[]}),false);assert.equal(c.state.data.plan.annotations.length,2);
});

test('extra export receives that exact page, never writes draft facts, and cleans its temporary mount',async()=>{
  const c=harness(),extra={evidence_id:'EXTRA',page:4,annotations:[{id:'extra-line'}]};let mounted;
  c.window.AuditPlanEditor={mount(host,options){mounted=options;return {async refresh(){c.calls.push(['refresh']);},async exportPreview(){c.calls.push(['export-preview']);return {data:'PNG'};},destroy(){c.calls.push(['destroy']);}};}};
  load(c,'exportGraphic');const before=copy(c.state.data),result=await c.exportGraphic(extra,'plan','annotation-extra');
  assert.equal(mounted.getState(),extra);assert.equal(mounted.getState().page,4);assert.equal(result.subject_id,'annotation-extra');mounted.onChange({evidence_id:'SHOULD NOT WRITE'});assert.deepEqual(copy(c.state.data),before);
  assert.deepEqual(c.calls.filter(call=>['refresh','export-preview','destroy','host-removed'].includes(call[0])).map(call=>call[0]),['refresh','export-preview','destroy','host-removed']);
});

test('queued save writes the newest edit after the in-flight snapshot without deadlock', {timeout:1500},async()=>{
  const c=harness();c.state.dirty=true;c.state.version=1;load(c,'flush','saveNow');let requests=0;const bodies=[];
  c.request=async(url,options)=>{requests++;bodies.push(JSON.parse(options.body));if(requests===1){c.state.data.conclusion='Edited during request';c.state.version++;c.state.dirty=true;}return {ok:true,revision:c.state.draft.revision+1};};
  await c.saveNow();assert.equal(requests,2);assert.equal(bodies[0].data.conclusion,'Есть замечания');assert.equal(bodies[1].data.conclusion,'Edited during request');assert.equal(c.state.dirty,false);assert.equal(c.state.draft.revision,12);
});

test('late callback from a removed extra editor cannot overwrite the main plan',async()=>{
  const c=harness();c.state.data.workflow.step=1;c.activePlanId='extra-removed';
  const extra={id:'extra-removed',evidence_id:'EXTRA-SOURCE',page:2,annotations:[{id:'extra-mark'}]};
  c.state.data.additional_plans=[copy(extra)];let mounted;
  c.window.AuditPlanEditor={mount(host,options){mounted=options;return {};}};c.saveNow=async()=>c.state.draft;
  load(c,'mountEditor');c.mountEditor();const main=copy(c.state.data.plan);
  // A queued editor callback may settle after the extra was removed/rerendered.
  c.state.data.additional_plans=[];c.activePlanId='main';
  const next=copy(extra);next.annotations.push({id:'last-extra-edit'});
  const accepted=await mounted.onChange(next);
  assert.deepEqual(copy(c.state.data.plan),main,'A retired editor cannot target whichever plan is now active');
  assert.equal(accepted,false,'A callback for a removed plan must explicitly refuse the save');
});

test('numeric input persists before blur and only rebuilds dependent controls on change',async()=>{
  const c=harness(),listeners={};
  const control={tagName:'INPUT',type:'number',value:'2',dataset:{bind:'inspection.cadastral_count'},addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
  const scope={querySelectorAll:selector=>selector==='[data-bind]'?[control]:[],querySelector:()=>null};
  load(c,'set','sanitizeService','bind','flush','saveNow');c.bind(scope);
  for(const handle of listeners.input)handle();
  assert.equal(c.state.data.inspection.cadastral_count,'2');assert.equal(c.state.dirty,true);assert.equal(c.calls.some(call=>call[0]==='render'),false,'Typing must not destroy/recreate the focused number input');
  await c.saveNow();const write=c.calls.find(call=>call[0]==='request');assert.equal(JSON.parse(write[2].body).data.inspection.cadastral_count,'2');
  for(const handle of listeners.change)await handle();assert.equal(c.calls.filter(call=>call[0]==='render').length,1);
  c.state.frozen=true;control.value='3';for(const handle of listeners.input)handle();assert.equal(c.state.data.inspection.cadastral_count,'2');
});

for(const deleted of [false,true])test('manager PDF download keeps its captured extra target when user '+(deleted?'removes it':'switches to main'),async()=>{
  const c=harness();c.activePlanId='extra-target';c.state.data.additional_plans=[{id:'extra-target',evidence_id:'old-extra',page:3,annotations:[{id:'old'}]}];
  c.packetFiles=()=>[{id:'manager-pdf',name:'plan.pdf',mime:'application/pdf',role:'egrn',url:'/api/audit/orders/123/materials/manager-pdf/download'}];
  let started,release;const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  c.fetch=async()=>{started();await gate;return {ok:true,blob:async()=>({type:'application/pdf'})};};c.readBase64=async()=> 'PDF';load(c,'useManagerPlan');
  const main=copy(c.state.data.plan);await c.useManagerPlan('manager-pdf');await entered;
  c.activePlanId='main';if(deleted)c.state.data.additional_plans=[];release();await c.tail;
  assert.deepEqual(copy(c.state.data.plan),main,'The selected target cannot change during the network await');
  if(!deleted)assert.equal(c.state.data.additional_plans[0].manager_material_id,'manager-pdf');
  else assert.equal(c.state.data.additional_plans.length,0);
});
