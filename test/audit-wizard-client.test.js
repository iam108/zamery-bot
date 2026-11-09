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
function load(c, ...names) { if(names.includes('fetchAuditFile')||names.includes('request'))names=['requestWithDeadline',...names];if(names.includes('postEvidence')&&source.includes('async function recoverEvidenceUpload('))names=['recoverEvidenceUpload',...names];vm.runInContext(names.map(actualFunction).join('\n'), c); }
function harness() {
  const calls=[],nodes=new Map();
  const node=key=>{if(!nodes.has(key))nodes.set(key,{textContent:'',innerHTML:'',dataset:{},style:{},disabled:false,hidden:false,querySelector:()=>null,querySelectorAll:()=>[],remove(){calls.push(['host-removed']);}});return nodes.get(key);};
  const c={
    state:{data:{schema_version:3,ui_version:5,object_category:'catering',inspection:{org:'Тест',address:'Москва',service:'Получение',visit_date:'2026-10-30'},workflow:{step:2,conclusion_status:'actions',territory_result:'findings'},conclusion:'Есть замечания',entrances:[],zones:[],plan:{evidence_id:'plan-original',page:6,annotations:[{id:'p1',tool:'boundary'}]},map:{evidence_id:'map-original',page:1,annotations:[{id:'e1',tool:'entrance'}]},additional_plans:[]},draft:{id:'draft-test',revision:10},evidence:[],dirty:false,serverError:'',version:0,frozen:false,submitting:false,completed:false,packet:{materials:[]}},
    $:node,root:node('#root'),calls,tail:Promise.resolve(),timer:null,pendingSave:null,queuedJobs:0,closingConfirmation:false,saveRetries:0,editor:null,activePlanId:'main',managerPlanIntents:new Map(),orderId:'123',localKey:'test-only',tg:null,
    clone:copy,clearTimeout,setTimeout,console,TextEncoder,URL,OUTCOME_LABELS:{ready:'Соответствует по проверенным пунктам',actions:'Нужны действия'},
    document:{body:{classList:{add(){},remove(){}},appendChild(){calls.push(['host-added']);}},createElement:()=>node('export-host')},
    window:{},localStorage:{setItem(){},removeItem(){}},
    render(){calls.push(['render']);},refreshChrome(){},notify(text){calls.push(['notify',text]);},notice(){},status(text){calls.push(['status',text]);},timeLabel:()=> '12:00',localDate:()=> '2026-10-30',localSave(){},issues:()=>[],packetFiles:()=>[],
    changed(){c.state.dirty=true;c.state.version++;},syncMapCards(){},evidenceUrl:async id=>'blob:'+id,uploadEditorSource:async()=>{},
    flush:async()=>{calls.push(['flush']);c.state.dirty=false;},
    exportGraphic:async(plan,kind,subject)=>{calls.push(['export',kind,subject,plan.evidence_id]);return {name:kind+'.png',mime:'image/png',role:kind,data:'generated-'+plan.evidence_id};},
    postEvidence:async(file,role,subject,data)=>{const e={id:'new-'+role+'-'+subject,role,subject_id:subject};c.state.evidence.push(e);c.state.draft.revision++;calls.push(['upload',e.id,data]);return e;},
    request:async(url,options)=>{calls.push(['request',url,options]);if(options?.method==='DELETE')return {ok:true,revision:c.state.draft.revision+1};return {ok:true};},
    checkSubmissionState:async entered=>{calls.push(['check-submission',entered]);},
    territoryIssues(){},
    defaults:{inspection:{region:'МСК'},workflow:{step:0},plan:{},map:{},additional_plans:[]}
  };
  vm.createContext(c);load(c,'requiredIssues','stable','sameData','draftWriteOptions','updateClosingConfirmation','recoverUnconfirmedWrite','setOutcome','queue','step','isRenewal','evidenceFor','mapMode','adoptRevision','removeGeneratedEvidence','submit','currentPlan','setCurrentPlan');return c;
}

test('switching the main plan to a ready artwork parks all drawn points and restores both modes after a draft reload',()=>{
  const c=harness();load(c,'switchPlanMode','merge','restoreData');
  c.state.data.plan.pending={tool:'boundary',points:[{x:.2,y:.3}]};const drawn=copy(c.state.data.plan);
  c.switchPlanMode('attached');assert.equal(c.state.data.plan.mode,'attached');assert.deepEqual(copy(c.state.data.plan.annotations),[]);assert.equal(c.state.data.plan.pending,null);
  assert.deepEqual(copy(c.state.data.plan_modes.draw),drawn);
  Object.assign(c.state.data.plan,{evidence_id:'ready-pdf',page:4});const attached=copy(c.state.data.plan);
  c.state.data=c.restoreData(copy(c.state.data));c.switchPlanMode('draw');
  assert.deepEqual(copy(c.state.data.plan.pending),drawn.pending);assert.deepEqual(copy(c.state.data.plan.annotations),drawn.annotations);assert.equal(c.state.data.plan.evidence_id,drawn.evidence_id);
  c.switchPlanMode('attached');assert.deepEqual(copy(c.state.data.plan),attached);
});

test('a frozen legacy drawing keeps its exact former mode-less shape while an editable old drawing retains draw semantics',()=>{
  const c=harness();load(c,'merge','restoreData');c.defaults.plan={mode:'attached',evidence_id:'',page:1,annotations:[],pending:null};
  const raw=copy(c.state.data);raw.plan.pending={tool:'boundary',points:[{x:.2,y:.3}]};
  const frozen=c.restoreData(raw,true);assert.equal(Object.hasOwn(frozen.plan,'mode'),false);assert.deepEqual(copy(frozen.plan),raw.plan);
  const editable=c.restoreData(raw,false);assert.equal(editable.plan.mode,'draw');assert.deepEqual(copy(editable.plan.pending),raw.plan.pending);
});

test('restoring a frozen completed legacy plan never invents pending or removes an explicitly stored empty mode',()=>{
  const c=harness();load(c,'merge','restoreData');c.defaults.plan={mode:'attached',evidence_id:'',page:1,annotations:[],pending:null};
  for(const mode of [undefined,'']){
    const raw=copy(c.state.data);delete raw.plan.pending;if(mode!==undefined)raw.plan.mode=mode;
    const restored=c.restoreData(raw,true);assert.deepEqual(copy(restored.plan),raw.plan);
  }
});

test('the actual artwork export renders the selected page without marks and cleans its temporary editor',async()=>{
  const c=harness(),before=copy(c.state.data);let destroyed=0;
  c.state.data.plan={mode:'attached',evidence_id:'ready-pdf',page:4,annotations:[],pending:null};const selected=copy(c.state.data.plan);
  c.window.AuditPlanEditor={mount(host,options){assert.equal(options.artworkOnly,true);assert.deepEqual(copy(options.getState()),selected);return{refresh:async()=>{},exportPreview:async()=>({name:'Готовый план.png',mime:'image/png',data:'synthetic-page-4'}),destroy(){destroyed++;}};}};
  load(c,'exportGraphic');const result=await c.exportGraphic(c.state.data.plan,'plan','annotation');
  assert.equal(result.mime,'image/png');assert.equal(result.subject_id,'annotation');assert.equal(destroyed,1);assert.deepEqual(copy(c.state.data.plan),selected);
  assert.equal(c.calls.filter(call=>call[0]==='host-removed').length,1);assert.deepEqual(copy(c.state.data.inspection),before.inspection);
});

for(const cancelled of [false,true])test('PDF '+(cancelled?'chooser cancellation':'worker deadline')+' releases the actual upload count and cannot apply a late original', {timeout:1000},async()=>{
  const c=harness(),tools=require('../src/web/audit-plan-editor').helpers,controller=new AbortController();let finish,destroyed=0,uploads=0;
  c.state.pendingUploads=0;const before=copy(c.state.data.plan);
  const task={promise:new Promise(resolve=>{finish=resolve;}),destroy(){destroyed++;return new Promise(()=>{});}};
  c.window.AuditPlanEditor={helpers:{...tools,loadPdf:(bytes,options)=>tools.loadPdf(bytes,{...options,timeoutMs:cancelled?60000:10,loadLibrary:async()=>({getDocument:()=>task})})}};
  c.readBase64=async()=>Buffer.from('%PDF-1.7\nSynthetic original').toString('base64');c.fileMime=()=> 'application/pdf';c.atob=value=>Buffer.from(value,'base64').toString('binary');
  c.uploadFiles=async()=>{uploads++;assert.fail('Unvalidated PDF must not reach evidence POST');};
  load(c,'uploadEditorSource');const pending=c.uploadEditorSource({name:'Delayed.pdf',type:'application/pdf',size:30},'plan-source',controller.signal);
  if(cancelled){await new Promise(setImmediate);assert.equal(c.state.pendingUploads,1);controller.abort();}
  await assert.rejects(pending,error=>error.code===(cancelled?'AUDIT_PDF_CANCELLED':'AUDIT_PDF_TIMEOUT'));
  assert.equal(c.state.pendingUploads,0);assert.equal(destroyed,1);assert.equal(uploads,0);assert.deepEqual(copy(c.state.data.plan),before);
  const calls=c.calls.length;finish({numPages:6,destroy(){}});await new Promise(setImmediate);assert.equal(c.calls.length,calls);assert.equal(uploads,0);
});

test('unknown delivery disables ordinary submit and offers an explicit checked-chat retry', async () => {
  const c=harness();c.state.frozen=true;c.state.draft.delivery_unknown={cursor:'attempt-1',stage:'photos',count:2};
  load(c,'freezeControls');c.freezeControls();
  assert.equal(c.$('#submit-audit').disabled,true);assert.equal(c.$('#retry-unknown-delivery').hidden,false);
  assert.match(c.$('#submit-status').textContent,/проверьте чат.*дубликаты/i);
  await c.submit('');assert.equal(c.calls.some(call=>call[0]==='request'),false);
});

test('cancelling the explicit duplicate-risk confirmation contacts no retry or submit endpoint', async () => {
  const c=harness();c.state.frozen=true;c.state.draft.delivery_unknown={cursor:'attempt-1',stage:'summary',count:1};
  c.window.confirm=()=>false;c.freezeControls=()=>{};load(c,'retryUnconfirmedDelivery');
  await c.retryUnconfirmedDelivery();assert.equal(c.calls.some(call=>call[0]==='request'),false);
  assert.equal(c.state.draft.delivery_unknown.cursor,'attempt-1');
});

test('explicit retry confirms only the displayed frozen attempt before resuming the report', async () => {
  const c=harness();c.state.frozen=true;c.state.draft.delivery_unknown={cursor:'attempt-1',stage:'originals',count:1};
  c.window.confirm=message=>{assert.match(message,/дубликатов/);return true;};c.freezeControls=()=>{};
  c.submit=async()=>{assert.equal(c.state.draft.delivery_unknown,undefined);assert.equal(c.state.retryingDelivery,false);c.calls.push(['resume']);};
  load(c,'retryUnconfirmedDelivery');await c.retryUnconfirmedDelivery();
  const sent=c.calls.find(call=>call[0]==='request');assert.match(sent[1],/draft-test\/retry-delivery$/);
  assert.deepEqual(JSON.parse(sent[2].body),{revision:10,cursor:'attempt-1',acknowledge_duplicate_risk:true});
  assert.equal(c.calls.filter(call=>call[0]==='resume').length,1);
});

test('a stale retry cursor reloads the current unknown attempt without sending any report part', async () => {
  const c=harness();c.state.frozen=true;c.state.draft.delivery_unknown={cursor:'attempt-1',stage:'photos',count:2};
  c.window.confirm=()=>true;c.freezeControls=()=>{};c.request=async()=>{throw Object.assign(new Error('Retry cursor changed'),{status:409});};
  c.checkSubmissionState=async()=>{c.state.draft.delivery_unknown={cursor:'attempt-2',stage:'photos',count:2};};
  c.submit=async()=>assert.fail('The stale HTTP retry cannot start delivery');load(c,'retryUnconfirmedDelivery');
  await c.retryUnconfirmedDelivery();assert.equal(c.state.draft.delivery_unknown.cursor,'attempt-2');assert.equal(c.state.retryingDelivery,false);
});

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

test('route click opens the start-point chooser rather than sending an empty origin to Maps',()=>{
  const c=harness(),button={};let opened=0;
  c.showRoute=()=>{opened++;};c.openExternal=()=>{assert.fail('No empty-origin route should be dispatched by the first click');};
  const scope={querySelectorAll:()=>[],querySelector:s=>s==='[data-route]'?button:null};load(c,'bind');c.bind(scope);
  let prevented=false;button.onclick({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(opened,1);
});

test('iPhone opens the saved object address in Maps immediately without geocoding or another dialog',()=>{
  const c=harness(),opened=[],saved=[];
  c.actions=require('../public/audit-actions');c.tg={platform:'ios'};c.window.TelegramWebviewProxy={postEvent(){}};
  c.state.packet={address:'Москва, Лесная, 5, этаж 1, комната 75'};
  c.state.data.inspection.address='Москва, старый адрес';
  c.window.AuditRoute={open(){assert.fail('The agreed free option needs no intermediate chooser');}};
  c.fetch=()=>assert.fail('No paid or free geocoder is contacted');
  c.localSave=()=>saved.push('local');c.saveNow=async()=>{saved.push('server');throw new Error('offline');};
  c.openExternal=url=>{opened.push(url);return true;};
  load(c,'opensMapAddress','mapAddress','routeActionUrl','saveBeforePhone','showRoute');
  c.showRoute();
  assert.equal(opened.length,1);const url=new URL(opened[0]);assert.equal(url.origin,'https://yandex.ru');
  assert.equal(url.searchParams.get('text'),'Москва, Лесная, 5');assert.equal(url.searchParams.has('rtext'),false);
  assert.deepEqual(saved,['local','server']);
});

test('Android retains route origin and GPS chooser while using the current manager address',()=>{
  const c=harness(),dialogs=[];
  c.actions=require('../public/audit-actions');c.tg={platform:'android'};c.window.TelegramWebviewProxy={postEvent(){}};
  c.state.packet={address:'Москва, Лесная, 5'};
  c.window.AuditRoute={open:options=>dialogs.push(options)};c.openExternal=()=>assert.fail('The chooser must remain available');
  load(c,'opensMapAddress','mapAddress','routeActionUrl','showRoute');c.showRoute();
  assert.equal(dialogs.length,1);assert.equal(dialogs[0].address,c.state.packet.address);assert.equal(dialogs[0].telegram,c.tg);
  assert.equal(new URL(c.routeActionUrl()).searchParams.get('rtext'),'~Москва, Лесная, 5');
});

test('a missing iPhone object address does not open a blank map',()=>{
  const c=harness();c.actions=require('../public/audit-actions');c.tg={platform:'ios'};c.window.TelegramWebviewProxy={postEvent(){}};
  c.state.packet={address:''};c.state.data.inspection.address='';c.openExternal=()=>assert.fail('A blank map is not a useful destination');
  load(c,'opensMapAddress','mapAddress','routeActionUrl','showRoute');c.showRoute();
  assert.match(c.calls.at(-1)[1],/не указан адрес/);
});

test('the territory picker retains its Android file handle until upload settles',async()=>{
  for(const outcome of ['success','failure']){
    const c=harness(),file={name:'карта.png'};
    const control={files:[file],value:file.name,dataset:{territoryUpload:'draw'}};
    let finish;
    c.uploadTerritoryImage=(selected,mode)=>{
      assert.equal(selected,file);assert.equal(mode,'draw');
      return new Promise((resolve,reject)=>{finish=outcome==='success'?resolve:()=>reject(new Error('upload failed'));});
    };
    load(c,'bind');c.bind({querySelectorAll:selector=>selector==='[data-territory-upload]'?[control]:[],querySelector:()=>null});
    control.onchange();assert.equal(control.value,file.name);
    finish();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(control.value,'');
    assert.equal(c.calls.some(([action])=>action==='notify'),outcome==='failure');
  }
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

test('regenerated drawings save their new preview IDs before submitting and preserve original sources',async()=>{
  const c=harness();
  c.state.data.map.preview_evidence_id='map-old';c.state.data.plan.preview_evidence_id='plan-old';
  c.state.evidence=[{id:'map-original',role:'map-source',subject_id:'source'},{id:'plan-original',role:'plan-source',subject_id:'source'},
    {id:'map-old',role:'map',subject_id:'annotation'},{id:'plan-old',role:'plan',subject_id:'annotation'}];
  let persisted;
  c.flush=async()=>{persisted=copy(c.state.data);c.calls.push(['flush']);c.state.dirty=false;};
  const request=c.request;c.request=async(url,options)=>{
    if(url==='/api/audit'){
      for(const kind of ['map','plan']){
        const drawing=persisted[kind],preview=c.state.evidence.find(e=>e.id===drawing.preview_evidence_id);
        assert.ok(preview,'The server must receive a pointer to the current image');
        assert.equal(preview.role,kind);assert.equal(preview.subject_id,'annotation');
        assert.equal(drawing.evidence_id,kind+'-original');
      }
    }
    return request(url,options);
  };
  await c.submit();assert.equal(c.state.completed,true);
  assert.equal(persisted.map.preview_evidence_id,'new-map-annotation');
  assert.equal(persisted.plan.preview_evidence_id,'new-plan-annotation');
  assert.equal(c.state.evidence.some(e=>e.id==='map-old'||e.id==='plan-old'),false);
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

test('restoring a frozen server submission discards an editable packet-review prompt and permits exact retry',async()=>{
  const c=harness();load(c,'merge','restoreData','frozenSnapshot');
  c.state.pendingPacket={org:'New manager packet'};c.state.packetError='Сверьте обновление';
  c.renderPacketUpdate=()=>c.calls.push(['review-panel']);
  const remote={...c.state.draft,revision:17,submitting:true,data:copy(c.state.data),evidence:[]};
  c.frozenSnapshot(remote);await c.submit();
  assert.equal(c.state.pendingPacket,null);assert.equal(c.state.packetError,'');assert.equal(c.state.completed,true);
  const sent=c.calls.find(call=>call[0]==='request'&&call[1]==='/api/audit');assert.equal(JSON.parse(sent[2].body).revision,17);
  assert.equal(c.calls.some(call=>['flush','export','upload'].includes(call[0])),false);
});

test('an explicit server reload clears old packet-review state when another window froze the draft',async()=>{
  const c=harness();load(c,'merge','restoreData','reloadServer');c.window.confirm=()=>true;
  c.state.pendingPacket={org:'New manager packet'};c.state.packetError='Сверьте обновление';c.renderPacketUpdate=()=>{};
  const remote={...c.state.draft,revision:17,submitting:true,data:copy(c.state.data),evidence:[]};
  c.request=async(url,options)=>{c.calls.push(['request',url,options]);return options?{ok:true}:{draft:remote};};
  await c.reloadServer();await c.submit();
  assert.equal(c.state.pendingPacket,null);assert.equal(c.state.packetError,'');assert.equal(c.state.completed,true);
});

test('a packet fetch finishing after submission froze cannot replace or reopen review of that frozen packet',async()=>{
  const c=harness();c.state.data.request_packet={org:'Original',address:'Original address',service:'Получение',object_category:'catering',materials:[]};
  const before=copy(c.state.data);let finish;
  c.request=()=>new Promise(resolve=>{finish=resolve;});c.renderPacketUpdate=()=>assert.fail('Frozen retry cannot reopen editable packet review');
  load(c,'packetIdentity','hasInspectionWork','fetchPacket');const fetching=c.fetchPacket();
  c.state.frozen=true;finish({...before.request_packet,address:'New manager address'});await fetching;
  assert.deepEqual(copy(c.state.data),before);assert.equal(c.state.pendingPacket,undefined);assert.equal(c.state.packet.address,'Original address');
});

test('unchanged editor snapshot retries a previously failed write instead of falsely acknowledging save',async()=>{
  const c=harness();c.state.data.workflow.step=1;let options,writes=0;
  c.window.AuditPlanEditor={mount(container,value){options=value;return {};}};
  c.saveNow=async()=>{writes++;if(writes===1){c.state.serverError='failed';throw new Error('write failed');}c.state.dirty=false;c.state.serverError='';return c.state.draft;};load(c,'mountEditor');c.mountEditor();
  const changed=copy(c.state.data.plan);changed.annotations.push({id:'new-mark',tool:'partition'});
  assert.equal(options.onSnapshot(changed),true);
  await assert.rejects(options.onChange(),/write failed/);assert.equal(c.state.data.plan.annotations.length,2);assert.equal(c.state.dirty,true);
  assert.equal(options.onSnapshot(copy(changed)),true);await options.onChange();assert.equal(writes,2);assert.equal(c.state.dirty,false);
  assert.equal(options.onSnapshot(copy(changed)),true);await options.onChange();assert.equal(writes,2,'A clean identical snapshot needs no extra request');
  c.state.frozen=true;assert.equal(options.onSnapshot({annotations:[]}),false);assert.equal(c.state.data.plan.annotations.length,2);
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
  const accepted=mounted.onSnapshot(next);
  assert.deepEqual(copy(c.state.data.plan),main,'A retired editor cannot target whichever plan is now active');
  assert.equal(accepted,false,'A callback for a removed plan must explicitly refuse the save');
});

test('numeric input updates its dependent controls without swallowing the next tap on blur',async()=>{
  const c=harness(),listeners={};
  const control={tagName:'INPUT',type:'number',value:'2',dataset:{bind:'inspection.cadastral_count'},addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
  const scope={querySelectorAll:selector=>selector==='[data-bind]'?[control]:[],querySelector:()=>null};
  const boundary={hidden:true};c.root.querySelector=selector=>selector==='[data-cadastral-boundary]'?boundary:null;
  load(c,'set','sanitizeService','bind','flush','saveNow');c.bind(scope);
  for(const handle of listeners.input)handle();
  assert.equal(boundary.hidden,false);
  assert.equal(c.state.data.inspection.cadastral_count,'2');assert.equal(c.state.dirty,true);assert.equal(c.calls.some(call=>call[0]==='render'),false,'Typing must not destroy/recreate the focused number input');
  await c.saveNow();const write=c.calls.find(call=>call[0]==='request');assert.equal(JSON.parse(write[2].body).data.inspection.cadastral_count,'2');
  assert.equal(listeners.change,undefined);
  control.value='1';for(const handle of listeners.input)handle();assert.equal(boundary.hidden,true);
  c.state.frozen=true;control.value='3';for(const handle of listeners.input)handle();assert.equal(c.state.data.inspection.cadastral_count,'1');
});

for(const deleted of [false,true])test('manager PDF download keeps its captured extra target when user '+(deleted?'removes it':'switches to main'),async()=>{
  const c=harness();c.activePlanId='extra-target';c.state.data.additional_plans=[{id:'extra-target',evidence_id:'old-extra',page:3,annotations:[{id:'old'}]}];
  c.packetFiles=()=>[{id:'manager-pdf',name:'plan.pdf',mime:'application/pdf',role:'egrn',url:'/api/audit/orders/123/materials/manager-pdf/download'}];
  let started,release;const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  c.fetch=async()=>{started();await gate;return new Response('%PDF-1.4',{headers:{'Content-Type':'application/pdf'}});};c.readBase64=async()=> 'PDF';load(c,'fetchAuditFile','useManagerPlan');
  const main=copy(c.state.data.plan);await c.useManagerPlan('manager-pdf');await entered;
  c.activePlanId='main';if(deleted)c.state.data.additional_plans=[];release();await c.tail;
  assert.deepEqual(copy(c.state.data.plan),main,'The selected target cannot change during the network await');
  if(!deleted)assert.equal(c.state.data.additional_plans[0].manager_material_id,'manager-pdf');
  else assert.equal(c.state.data.additional_plans.length,0);
});

const auditChallenge = () => new Response('<title>Checking your browser</title>', {headers:{'Content-Type':'text/html; charset=utf-8'}});
const auditPDF = () => new Response('%PDF-1.4 original', {headers:{'Content-Type':'application/pdf','Content-Disposition':"attachment; filename*=UTF-8''plan.pdf"}});

test('an HTML challenge never occupies the evidence cache and the same original can open again', async () => {
  const c = harness(), replies = [auditChallenge(), auditPDF()];
  c.blobUrls = new Map();
  c.fetch = async (url, options) => { assert.match(url, /\/evidence\/plan-original$/); assert.equal(options.cache,'no-store'); return replies.shift(); };
  c.URL = {createObjectURL(blob) { assert.equal(blob.type,'application/pdf'); return 'blob:original'; }};
  load(c,'fetchAuditFile','evidenceUrl');
  await assert.rejects(c.evidenceUrl('plan-original'), error => error.code === 'AUDIT_FILE_RESPONSE' && /временно ограничил доступ/.test(error.message));
  assert.equal(c.blobUrls.size,0);
  assert.equal(await c.evidenceUrl('plan-original'),'blob:original');
  assert.equal(await c.evidenceUrl('plan-original'),'blob:original');
  assert.equal(replies.length,0);
});

test('manager document retries save and import only the actual PDF after an HTML challenge', async () => {
  const c = harness(), replies = [auditChallenge(), auditPDF(), auditChallenge(), auditPDF()], downloads = [];
  const url = '/api/audit/orders/123/materials/manager-pdf';
  c.fetch = async () => replies.shift();
  c.location = {origin:'https://example.test'};
  c.downloadJobs = new Set();
  c.setTimeout = () => {};
  c.URL = class extends URL { static createObjectURL(blob) { assert.equal(blob.type,'application/pdf'); return 'blob:plan'; } };
  c.document.createElement = () => ({click() { downloads.push(this.download); },remove() {}});
  c.packetFiles = () => [{id:'manager-pdf',name:'plan.pdf',mime:'application/pdf',role:'egrn',url}];
  c.readBase64 = async blob => { assert.equal(await blob.text(),'%PDF-1.4 original'); return 'PDF'; };
  load(c,'fetchAuditFile','downloadResource','useManagerPlan');
  await c.downloadResource(url,'fallback.pdf');
  assert.deepEqual(downloads,[]);
  assert.match(c.calls.at(-1)[1],/временно ограничил доступ/);
  await c.downloadResource(url,'fallback.pdf');
  assert.deepEqual(downloads,['plan.pdf']);
  assert.equal(c.downloadJobs.size,0);
  await c.useManagerPlan('manager-pdf'); await c.tail;
  assert.equal(c.state.data.plan.manager_material_id,undefined);
  assert.equal(c.calls.filter(call => call[0] === 'upload').length,0);
  await c.useManagerPlan('manager-pdf'); await c.tail;
  assert.equal(c.state.data.plan.manager_material_id,'manager-pdf');
  assert.equal(c.calls.filter(call => call[0] === 'upload').length,1);
});

test('audit file responses retain supported binary and named attachment types and explain ordinary JSON errors', async () => {
  const c = harness(); load(c,'fetchAuditFile');
  for (const type of ['image/jpeg','image/png','application/pdf','application/zip','application/octet-stream','text/plain']) {
    c.fetch = async () => new Response('original',{headers:{'Content-Type':type,'Content-Disposition':'attachment; filename="original"'}});
    assert.equal(await (await c.fetchAuditFile('/file','Не удалось открыть файл')).blob.text(),'original');
  }
  c.fetch = async () => new Response('rate limited',{headers:{'Content-Type':'text/plain'}});
  await assert.rejects(c.fetchAuditFile('/file','Не удалось открыть файл'),/временно ограничил доступ/);
  c.fetch = async () => new Response(JSON.stringify({ok:false,error:'Материал удалён'}),{status:404,headers:{'Content-Type':'application/json'}});
  await assert.rejects(c.fetchAuditFile('/file','Не удалось открыть файл'),/Материал удалён/);
});

test('closing with an unconfirmed edit dispatches the write with keepalive, without replacing a not-yet-loaded draft', async () => {
  const c=harness(),writes=[];
  load(c,'saveOnExit','flush','saveNow');
  c.localSave=()=>writes.push('local');
  c.request=async(url,options)=>{writes.push([url,options]);return {ok:true,revision:11};};
  c.state.dirty=true;c.state.loaded=false;c.saveOnExit();
  assert.deepEqual(writes,[]);
  c.state.loaded=true;c.saveOnExit();const saving=c.pendingSave;
  assert.equal(writes.filter(Array.isArray).length,1,'the request starts in the exit handler, before any queued microtask');
  c.saveOnExit();await saving;
  const calls=writes.filter(Array.isArray);
  assert.equal(calls.length,1);
  assert.equal(calls[0][1].keepalive,true);
  assert.equal(c.state.dirty,false);
  assert.equal(c.draftWriteOptions('PUT',{text:'я'.repeat(33000)}).keepalive,false,'count UTF-8 bytes, not just characters');
});

test('after a lost acknowledgement, a newer observation saves on the revision that actually reached the server', async () => {
  const c=harness();load(c,'flush','saveNow');
  const first=copy(c.state.data);c.state.attempt={draft_id:c.state.draft.id,data:first};
  c.state.data.conclusion='Замечание после первого запроса';c.state.dirty=true;
  const requests=[];c.request=async(url,options)=>{
    requests.push([url,options]);
    if(!options)return {draft:{...c.state.draft,revision:11,data:first,evidence:[{id:'original'}]}};
    return {revision:12};
  };
  await c.saveNow();
  assert.match(requests[0][0],/drafts\/current/);
  assert.equal(JSON.parse(requests[1][1].body).revision,11);
  assert.equal(JSON.parse(requests[1][1].body).data.conclusion,'Замечание после первого запроса');
  assert.equal(c.state.evidence[0].id,'original');
  assert.equal(c.state.dirty,false);assert.equal(c.state.attempt,null);
});

test('a newer save by another window is not overwritten while recovering a lost acknowledgement', async () => {
  const c=harness();load(c,'flush','saveNow');
  const first=copy(c.state.data);c.state.attempt={draft_id:c.state.draft.id,data:first};
  c.state.data.conclusion='Мои несохранённые правки';c.state.dirty=true;
  c.request=async(url,options)=>{
    assert.equal(options,undefined);
    return {draft:{...c.state.draft,revision:12,data:{...first,conclusion:'Правка из другого окна'}}};
  };
  await assert.rejects(c.saveNow(),/изменился в другом окне/);
  assert.equal(c.state.conflict,true);
  assert.equal(c.state.data.conclusion,'Мои несохранённые правки');
  assert.equal(c.state.attempt.data.conclusion,first.conclusion);
});

test('changing the outcome removes the old automatic outcome text and keeps actual comments', () => {
  const c=harness();
  c.state.data.workflow.conclusion_status='ready';
  c.state.data.conclusion='Соответствует по проверенным пунктам';
  c.setOutcome('actions');
  assert.equal(c.state.data.conclusion,'');
  c.state.data.conclusion='На плане и по факту разные границы';
  c.setOutcome('insufficient');
  assert.equal(c.state.data.conclusion,'На плане и по факту разные границы');
});

test('reopening a reported conflict does not treat the competing revision as the base of local edits', () => {
  const c=harness();load(c,'reconcileDraft');
  const local={draft_id:c.state.draft.id,revision:12,data:copy(c.state.data),dirty:true,conflict:true};
  const remote={...c.state.draft,revision:12,data:{...copy(c.state.data),conclusion:'Сохранено из другого окна'}};
  c.state.dirty=true;c.reconcileDraft(local,remote);
  assert.equal(c.state.conflict,true);
  assert.equal(c.$('#conflict-panel').hidden,false);
  assert.equal(c.state.data.conclusion,'Есть замечания');
});

test('manager identity changes keep original observations until an explicit material recheck', async () => {
  const c=harness();
  c.state.data.request_packet={org:'Old company',address:'Old address',service:'Получение',object_category:'catering',cad_num:'77:01:1:1',materials:[]};
  const original=copy(c.state.data), updated={...original.request_packet,address:'New address',cad_num:'77:01:1:2'};
  c.request=async()=>updated;c.renderPacketUpdate=()=>c.calls.push(['review-panel']);
  load(c,'packetIdentity','hasInspectionWork','applyPacket','fetchPacket');
  await c.fetchPacket();
  assert.deepEqual(copy(c.state.data),original);
  assert.equal(c.state.pendingPacket.address,'New address');
  assert.match(c.state.packetError,/изменились/);
  await c.submit();
  assert.equal(c.state.completed,false);
  assert.ok(!c.calls.some(call=>['flush','export','upload'].includes(call[0])));
  c.window.confirm=()=>true;c.prefillContact=()=>{};c.sanitizeService=()=>{};
  c.saveNow=async()=>c.state.draft;
  load(c,'acceptPacketUpdate');await c.acceptPacketUpdate();
  assert.equal(c.state.data.request_packet.address,'New address');
  assert.equal(c.state.data.inspection.address,'New address');
  assert.equal(c.state.data.packet_rechecks[0].previous.address,'Old address');
  assert.equal(c.state.data.packet_rechecks[0].current.cad_num,'77:01:1:2');
  assert.equal(c.state.pendingPacket,null);
});

test('browser and server compare the same reviewed source facts while ignoring delivery URLs and file order',()=>{
  const c=harness();load(c,'packetIdentity');
  const {packetReviewIdentity}=require('../src/bot/audit-packet-review');
  const packet={org:' ООО Тест ',address:'Москва',service:'Продление',object_category:'catering',cad_num:'77:01:1:2',archive_url:'https://disk.yandex.ru/d/archive',zones_info:'Проверить школу',video_required:true,
    materials:[{id:'two',name:'План.pdf',role:'plan',mime:'application/pdf',bytes:'20',sha256:'hash2',url:'/private-link'},{id:'one',name:'Договор.pdf',role:'document',bytes:10,sha256:'hash1'}],
    egrn_links:[{id:'large',role:'egrn',bytes:300000000,name:'Выписка.pdf',url:'/fresh-signed-link'}]};
  assert.deepEqual(copy(c.packetIdentity(packet)),packetReviewIdentity(packet));
  assert.deepEqual(copy(c.packetIdentity({...packet,contacts:'Новый контакт',deadline:'2026-12-01',packet_revision:20,materials:packet.materials.toReversed().map(file=>({...file,url:'/new-download-url'}))})),packetReviewIdentity(packet));
});

test('an updated public archive is inspectable before accepting its packet while the original snapshot stays intact',()=>{
  const c=harness();load(c,'esc','packetIdentity','renderPacketUpdate');
  c.state.data.request_packet={org:'Company',address:'Address',service:'Продление',archive_url:'https://disk.yandex.ru/d/old-archive',materials:[]};
  c.state.pendingPacket={...c.state.data.request_packet,archive_url:'https://disk.yandex.ru/d/new-archive'};
  c.managerFilesHtml=()=>'';c.largeEgrnFilesHtml=()=>'';c.acceptPacketUpdate=()=>{};
  c.renderPacketUpdate();
  assert.ok(c.$('#app-notice').innerHTML.includes('href="https://disk.yandex.ru/d/new-archive"'));
  assert.equal(c.state.data.request_packet.archive_url,'https://disk.yandex.ru/d/old-archive');
});

test('an invalid updated archive remains visible as a problem without creating an executable or credential-bearing link',()=>{
  for(const archive of ['javascript:alert(1)','https://user:secret@disk.yandex.ru/d/archive','not-a-url']){
    const c=harness();load(c,'esc','packetIdentity','renderPacketUpdate');
    c.state.data.request_packet={org:'Company',address:'Address',service:'Продление',archive_url:'https://disk.yandex.ru/d/old',materials:[]};
    c.state.pendingPacket={...c.state.data.request_packet,archive_url:archive};c.managerFilesHtml=()=>'';c.largeEgrnFilesHtml=()=>'';c.acceptPacketUpdate=()=>{};
    c.renderPacketUpdate();assert.match(c.$('#app-notice').innerHTML,/Ссылка некорректна/);assert.doesNotMatch(c.$('#app-notice').innerHTML,/href=/);
  }
});

for(const observation of ['territory result','video link','plan note'])test('a saved '+observation+' requires explicit review when the manager changes the source object',async()=>{
  const c=harness();c.state.evidence=[];
  c.state.data={inspection:{org:'Company',address:'Old address',service:'Получение',region:'МСК'},workflow:{step:0},conclusion:'',entrances:[],zones:[],plan:{annotations:[]},map:{annotations:[]},additional_plans:[],object_category:'catering',request_packet:{org:'Company',address:'Old address',service:'Получение',object_category:'catering',materials:[]}};
  if(observation==='territory result')c.state.data.workflow.territory_result='clear';
  if(observation==='video link')c.state.data.workflow.video_url='https://disk.yandex.ru/i/visit-video';
  if(observation==='plan note')c.state.data.inspection.plan_note='Стена на плане отсутствует по факту';
  const before=copy(c.state.data),updated={...before.request_packet,address:'New address'};
  c.request=async()=>updated;c.renderPacketUpdate=()=>{};c.prefillContact=()=>{};c.sanitizeService=()=>{};
  load(c,'packetIdentity','hasInspectionWork','applyPacket','fetchPacket');await c.fetchPacket();
  assert.deepEqual(copy(c.state.data),before);assert.equal(c.state.pendingPacket,updated);
});

for(const change of ['materials','egrn_links','archive_url','zones_info'])test('updated manager '+change+' requires review without losing auditor observations',async()=>{
  const c=harness();c.state.data.request_packet={org:'Company',address:'Address',service:'Получение',object_category:'catering',cad_num:'77:01:1:1',materials:[]};
  const original=copy(c.state.data),next={...original.request_packet,[change]:change.endsWith('links')||change==='materials'?[{id:'fresh-source',role:'egrn',name:'Свежая выписка.pdf'}]:'Новые сведения'};
  c.request=async()=>next;c.renderPacketUpdate=()=>{};
  load(c,'packetIdentity','hasInspectionWork','fetchPacket');await c.fetchPacket();
  assert.deepEqual(copy(c.state.data),original);assert.equal(c.state.pendingPacket,next);
  await c.submit();assert.equal(c.state.completed,false);assert.equal(c.calls.some(call=>['flush','export','upload'].includes(call[0])),false);
});

test('a source-update submission response opens source review instead of a false draft conflict',async()=>{
  const c=harness(),original=copy(c.state.data);let fetched=0;
  c.checkSubmissionState=async()=>{c.state.frozen=false;};
  c.fetchPacket=async()=>{fetched++;c.state.pendingPacket={address:'updated'};};
  c.request=async(url,options)=>{
    if(options?.method==='DELETE')return{ok:true,revision:++c.state.draft.revision};
    throw Object.assign(new Error('Документы обновлены'),{status:409,payload:{code:'AUDIT_PACKET_CHANGED'}});
  };
  await c.submit();assert.equal(fetched,1);assert.notEqual(c.state.conflict,true);assert.equal(c.state.frozen,false);assert.equal(c.state.completed,false);
  assert.equal(c.state.data.conclusion,original.conclusion);assert.equal(c.state.data.plan.evidence_id,original.plan.evidence_id);
});

test('a local-only draft is discoverable from the same employee general menu', async () => {
  const c=harness();c.uid='108';c.root.setAttribute=()=>{};c.document.querySelector=()=>null;
  const values=new Map([
    ['audit-wizard-v3:108:123',JSON.stringify({dirty:true,saved_at:Date.now(),data:{order_id:'123',inspection:{org:'Local inspection',address:'Москва'}}})],
    ['audit-wizard-v3:109:124',JSON.stringify({dirty:true,data:{order_id:'124',inspection:{org:'Other employee'}}})],
    ['audit-wizard-v3:108:123:recovery',JSON.stringify({dirty:true,data:{order_id:'123'}})]
  ]);
  c.localStorage={length:values.size,key:i=>[...values.keys()][i],getItem:key=>values.get(key)};
  c.request=async()=>({ok:true,drafts:[]});
  load(c,'esc','localDraftCards','setFormNavigation','openDrafts');await c.openDrafts();
  assert.match(c.root.innerHTML,/Local inspection/);
  assert.match(c.root.innerHTML,/order_id=123/);
  assert.match(c.root.innerHTML,/Есть правки на этом устройстве/);
  assert.doesNotMatch(c.root.innerHTML,/Other employee|order_id=124|recovery/);
});

test('a failed source read cannot reuse a previous marked-plan preview', async () => {
  const c=harness();load(c,'exportGraphic');
  let destroyed=false;
  c.window.AuditPlanEditor={mount:()=>({refresh:async()=>{},exportPreview:async()=>null,destroy(){destroyed=true;}})};
  await assert.rejects(c.exportGraphic({...c.state.data.plan,preview_evidence_id:'old-preview'},'plan','annotation'),/актуальное изображение плана/);
  assert.equal(destroyed,true);
});

test('large EGRN opens a freshly requested URL without loading its binary in the form', async () => {
  const c=harness(),id='d1b8c4da-4f14-4f51-a5b3-545b5e718dad',requests=[],opened=[];
  c.state.packet.egrn_links=[{id,name:'Большая выписка.pdf',bytes:400*1024*1024,url:'/api/audit/orders/123/egrn/'+id+'/link'}];
  c.window.location={origin:'https://bot.example'};c.request=async url=>{requests.push(url);return {ok:true,url:'https://bot.example/egrn-files/'+id+'/download?token=fresh'};};
  c.openExternal=url=>{opened.push(url);return true;};c.fetchAuditFile=()=>assert.fail('A huge original must never enter browser Blob memory');
  load(c,'packetEgrnLinks','openLargeEgrn');const button={disabled:false};
  await c.openLargeEgrn(id,button);
  assert.deepEqual(requests,[c.state.packet.egrn_links[0].url]);assert.equal(opened.length,1);
  assert.match(opened[0],/token=fresh/);assert.equal(button.disabled,false);
});

test('removing an extra-plan source clears every live reference without changing another original', async () => {
  const c=harness();
  c.window.confirm=()=>true;c.blobUrls=new Map();
  c.state.data.additional_plans=[{id:'extra',evidence_id:'extra-source',page:4,annotations:[{id:'mark'}],preview_evidence_id:'extra-preview',pending:{points:[{x:.1,y:.1}]}}];
  c.state.evidence=[{id:'extra-source',role:'plan-source',name:'extra.pdf'}];
  const main=copy(c.state.data.plan);
  load(c,'deleteEvidence');await c.deleteEvidence('extra-source');await c.tail;
  assert.equal(c.state.data.additional_plans[0].evidence_id,'');
  assert.equal(c.state.data.additional_plans[0].annotations.length,0);
  assert.equal(c.state.data.additional_plans[0].pending,null);
  assert.equal(c.state.data.additional_plans[0].preview_evidence_id,undefined);
  assert.deepEqual(copy(c.state.data.plan),main);
});

test('a Telegram-only EGRN original opens its message with Telegram native navigation', async () => {
  const c=harness(),id='d1b8c4da-4f14-4f51-a5b3-545b5e718dad',opened=[];
  c.state.packet.egrn_links=[{id,source:'telegram',name:'Выписка.pdf',bytes:20*1024*1024,url:'/api/audit/orders/123/egrn/'+id+'/link'}];
  c.window.location={origin:'https://bot.example'};c.request=async()=>({ok:true,url:'https://t.me/c/123456/789'});
  c.tg={openTelegramLink:url=>opened.push(url)};c.openExternal=()=>assert.fail('Use Telegram navigation for a Telegram original');
  load(c,'esc','packetEgrnLinks','largeEgrnFilesHtml','openLargeEgrn');c.bytes=()=> '20 МБ';
  assert.match(c.largeEgrnFilesHtml(),/Открыть в Telegram/);
  await c.openLargeEgrn(id,{disabled:false});
  assert.deepEqual(opened,['https://t.me/c/123456/789']);
});

for (const newer of ['source', 'geometry']) test('a late manager document preserves a newer ' + newer + ' choice on the same plan', async () => {
  const c = harness(); let started, release;
  const opened = new Promise(resolve => { started = resolve; }), delayed = new Promise(resolve => { release = resolve; });
  c.packetFiles = () => [{ id: 'manager-delayed', name: 'Delayed.pdf', mime: 'application/pdf', role: 'plan', url: '/api/audit/orders/123/materials/manager-delayed' }];
  c.fetchAuditFile = async () => { started(); await delayed; return { blob: { type: 'application/pdf' } }; };
  c.readBase64 = async () => Buffer.from('Original manager PDF').toString('base64'); load(c, 'useManagerPlan');
  c.useManagerPlan('manager-delayed'); await opened;
  c.state.data.plan = newer === 'source'
    ? { evidence_id: 'newer-original', page: 3, annotations: [{ id: 'newer-mark', tool: 'boundary' }] }
    : { ...copy(c.state.data.plan), annotations: [{ id: 'newer-mark', tool: 'boundary', label: 'Drawn during the download' }] };
  const wanted = copy(c.state.data.plan); c.changed(); release(); await c.tail;
  assert.deepEqual(c.state.data.plan, wanted, 'Completing an older document download must not replace newer inspection work');
  assert.equal(c.calls.filter(item => item[0] === 'upload').length, 1, 'The downloaded manager original remains available independently');
});

test('a newer manager-document request supersedes an older pending import even when the newer download fails', async () => {
  const c = harness(); let started, release;
  const opened = new Promise(resolve => { started = resolve; }), delayed = new Promise(resolve => { release = resolve; });
  const files = ['first', 'second'].map(id => ({ id, name: id + '.pdf', mime: 'application/pdf', role: 'plan', url: '/api/audit/orders/123/materials/' + id }));
  c.packetFiles = () => files;
  c.fetchAuditFile = async url => { if (url.endsWith('/second')) throw new Error('Synthetic newer document unavailable'); started(); await delayed; return { blob: { type: 'application/pdf' } }; };
  c.readBase64 = async () => Buffer.from('Original first manager PDF').toString('base64'); load(c, 'useManagerPlan');
  const wanted = copy(c.state.data.plan); c.useManagerPlan('first'); await opened; c.useManagerPlan('second'); release(); await c.tail;
  assert.deepEqual(c.state.data.plan, wanted, 'A failed newer choice must not silently activate an older request');
  assert.ok(c.calls.some(item => item[0] === 'notify' && /newer document unavailable/.test(item[1])));
});

test('a confirmed scheme deletion is immediately reflected in the UI even when its follow-up draft save fails', async () => {
  const c = harness(), renders = []; let saves = 0;
  c.window.confirm = () => true; c.blobUrls = new Map();
  c.state.data.map = { mode: 'attached', evidence_id: 'attached-scheme', page: 1, annotations: [] };
  c.state.evidence = [{ id: 'attached-scheme', role: 'map', subject_id: 'attached', mime: 'image/png', name: 'Scheme.png' }];
  c.flush = async () => { if (++saves === 2) throw new Error('Synthetic follow-up PUT failed'); };
  c.render = () => renders.push({ source: c.state.data.map.evidence_id, files: c.state.evidence.map(file => file.id) });
  load(c, 'deleteEvidence'); await c.deleteEvidence('attached-scheme'); await c.tail;
  assert.equal(c.state.data.map.evidence_id, ''); assert.equal(c.state.dirty, true);
  assert.deepEqual(renders, [{ source: '', files: [] }], 'The server-confirmed deletion must remove its stale visible card before retrying metadata');
  assert.ok(c.calls.some(item => item[0] === 'notify' && /follow-up PUT failed/.test(item[1])));
});

async function evidenceDatabase(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite();
  const query = (sql, params) => params ? db.query(sql, params) : db.exec(sql);
  const pool = { query, async connect() { return { query, release() {} }; } };
  const store = require('../src/web/audit-drafts').createDraftStore(pool, undefined, { objectStore: { configured: () => false } });
  try { await db.exec('CREATE TABLE orders(id INT PRIMARY KEY); INSERT INTO orders VALUES(123);'); await run(store, db); }
  finally { await db.close(); }
}

test('a committed evidence upload with a lost ACK does not turn the next observation into a false draft conflict', { skip: !process.env.PGLITE_TEST_MODULE }, () => evidenceDatabase(async (store, db) => {
  const c = harness(), fileId = require('node:crypto').randomUUID(), original = Buffer.from('Original phone image');
  c.state.draft = await store.create(108, 123, c.state.data); c.evidenceId = async () => fileId;
  c.crypto = require('node:crypto').webcrypto; c.window.crypto = c.crypto; c.atob = value => Buffer.from(value, 'base64').toString('binary');
  c.request = async (url, options) => {
    if (!options) return { draft: await store.current(108, 123) };
    const input = JSON.parse(options.body);
    if (url.endsWith('/evidence')) { await store.addEvidence(108, c.state.draft.id, input); c.state.data.conclusion = 'Typed while the original upload was in flight'; c.changed(); throw Object.assign(new Error('Synthetic lost evidence ACK'), { retryable: true }); }
    return { draft: await store.update(108, c.state.draft.id, input.revision, input.data) };
  };
  load(c, 'postEvidence', 'flush', 'saveNow');
  let uploadError; try { await c.postEvidence({ name: 'Phone.png', type: 'image/png' }, 'entrance', 'door-1', original.toString('base64')); } catch (error) { uploadError = error; }
  assert.equal(c.state.data.conclusion, 'Typed while the original upload was in flight');
  c.state.data.conclusion = 'A new observation after the selected photo'; c.changed();
  await c.saveNow();
  assert.equal(uploadError, undefined, 'A matching committed original is recovered through its owned server snapshot');
  assert.equal(!!c.state.conflict, false); assert.equal((await store.current(108, 123)).data.conclusion, c.state.data.conclusion);
  const files = (await db.query('SELECT content FROM audit_evidence')).rows; assert.equal(files.length, 1); assert.ok(Buffer.from(files[0].content).equals(original));
}));

test('uncertain evidence recovery cannot adopt another window newer draft revision', { skip: !process.env.PGLITE_TEST_MODULE }, () => evidenceDatabase(async store => {
  const c = harness(), fileId = require('node:crypto').randomUUID();
  c.state.draft = await store.create(108, 123, c.state.data); const baseline = c.state.draft.revision;
  c.evidenceId = async () => fileId; c.crypto = require('node:crypto').webcrypto; c.window.crypto = c.crypto; c.atob = value => Buffer.from(value, 'base64').toString('binary');
  c.request = async (url, options) => {
    if (!options) return { draft: await store.current(108, 123) };
    const result = await store.addEvidence(108, c.state.draft.id, JSON.parse(options.body));
    await store.update(108, c.state.draft.id, result.revision, { ...copy(c.state.data), conclusion: 'Another window newer observation' });
    throw Object.assign(new Error('Synthetic lost evidence ACK'), { retryable: true });
  };
  load(c, 'postEvidence');
  await assert.rejects(c.postEvidence({ name: 'Phone.png', type: 'image/png' }, 'entrance', 'door-1', Buffer.from('Original').toString('base64')), /lost evidence ACK/);
  assert.equal(c.state.draft.revision, baseline); assert.equal(c.state.evidence.length, 0);
  assert.equal((await store.current(108, 123)).data.conclusion, 'Another window newer observation');
}));

test('uncertain evidence recovery verifies original bytes rather than trusting only file ID and size', { skip: !process.env.PGLITE_TEST_MODULE }, () => evidenceDatabase(async (store, db) => {
  const c = harness(), fileId = require('node:crypto').randomUUID();
  c.state.draft = await store.create(108, 123, c.state.data); const baseline = c.state.draft.revision;
  c.evidenceId = async () => fileId; c.crypto = require('node:crypto').webcrypto; c.window.crypto = c.crypto; c.atob = value => Buffer.from(value, 'base64').toString('binary');
  c.request = async (url, options) => {
    if (!options) return { draft: await store.current(108, 123) };
    await store.addEvidence(108, c.state.draft.id, JSON.parse(options.body));
    await db.query('UPDATE audit_evidence SET sha256=$1 WHERE id=$2', ['0'.repeat(64), fileId]);
    throw Object.assign(new Error('Synthetic lost evidence ACK'), { retryable: true });
  };
  load(c, 'postEvidence');
  await assert.rejects(c.postEvidence({ name: 'Phone.png', type: 'image/png' }, 'entrance', 'door-1', Buffer.from('Original').toString('base64')), /lost evidence ACK/);
  assert.equal(c.state.draft.revision, baseline); assert.equal(c.state.evidence.length, 0);
}));
