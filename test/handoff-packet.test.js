const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const { createPacketService, setupHandoffPacket, normalizeContacts, innFromOrder } = require('../src/web/handoff-packet');
const { createAuditEvidenceStore } = require('../src/web/audit-evidence-store');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('structured and named client Telegram contacts survive while the labeled legal INN is filled from manager facts', () => {
  assert.deepEqual(normalizeContacts({ name: 'Карина', phone: '+79991234567', tg: '@karina_work' }), [{ name: 'Карина', phone: '+79991234567', tg: '@karina_work' }]);
  const line = normalizeContacts('Карина @karina_work +7 999 123 45 67');
  assert.equal(line[0].name, 'Карина'); assert.equal(line[0].tg, '@karina_work');
  assert.deepEqual(normalizeContacts('Карина @karina_work'), [{ name: 'Карина', phone: '', tg: '@karina_work' }]);
  assert.deepEqual(normalizeContacts('Аудитор: @blanjik'), []);
  assert.equal(innFromOrder({ zones_info: 'ИНН организации 7708421305. Сверить графику.' }), '7708421305');
  assert.equal(innFromOrder({ zones_info: 'ИНН не предоставлен, телефон 79991234567.' }), '');
});
test('contact parsing uses only manager contacts, handles phone before/after name, and never turns provenance or auditor into a client', () => {
  for (const source of ['Карина +7 (999) 123-45-67', '+7 (999) 123-45-67 Карина', 'Карина\n+7 (999) 123-45-67']) {
    assert.deepEqual(normalizeContacts(source), [{ name: 'Карина', phone: '+7 (999) 123-45-67' }]);
  }
  const withSource = normalizeContacts('Карина: +7 999 123 45 67. Контакт передала Ирина');
  assert.equal(withSource[0].name, 'Карина'); assert.match(withSource[0].comment, /Контакт передала Ирина/);
  const noClientName = normalizeContacts('Контакт передала Ирина; +7 999 123 45 67');
  assert.equal(noClientName[0].name, ''); assert.match(noClientName[0].comment, /передала Ирина/);
  assert.deepEqual(normalizeContacts('Аудитор Саша +7 999 123 45 67'), []);
  assert.deepEqual(normalizeContacts(JSON.stringify([{ name: 'Карина', phone: '+79991234567' }, { name: 'Саша', role: 'auditor', phone: '+79990000000' }])), [{ name: 'Карина', phone: '+79991234567' }]);
  assert.deepEqual(normalizeContacts({ name: 'Контакт передала Ирина', phone: '+79991234567' }), [{ name: '', phone: '+79991234567', comment: 'Контакт передала Ирина' }]);
});
test('INN is only structured INN or an explicitly labelled manager note, not an arbitrary number', () => {
  assert.equal(innFromOrder({ inn: '7701234567', zones_info: 'ИНН 7707654321' }), '7701234567');
  assert.equal(innFromOrder({ zones_info: 'ООО Пример; ИНН: 770123456789, проверить документы' }), '770123456789');
  assert.equal(innFromOrder({ zones_info: 'Телефон 7701234567; кадастр 77:01:0004016:1064' }), '');
  assert.equal(innFromOrder({ zones_info: 'ИНН: 7701234567891' }), '');
});
test('a new-client packet honestly has null order / report and needs no database or EGRN request', async()=>{
  const service=createPacketService({pool:{query(){throw new Error('No source query expected');}},evidenceStore:{read(){throw new Error('No file read expected');}},lookupEgrn(){throw new Error('No cad_num');}});
  const packet=await service.packet({});
  assert.equal(packet.order,null);assert.equal(packet.report,null);assert.deepEqual(packet.materials,[]);assert.equal(packet.archive_url,'');assert.deepEqual(packet.egrn,{cad_num:'',status:'missing'});
  assert.match(packet.signature,/^[a-f0-9]{64}$/);
});

async function database(run) {
  const { PGlite } = require(process.env.PGLITE_TEST_MODULE), db = new PGlite(), sql = [], gets = [];
  const pool = { async query(query, params) { sql.push(query); assert.match(query, /^(?:SELECT|WITH RECURSIVE)\b/, 'The packet service is read-only'); return db.query(query, params); } };
  const draftId = randomUUID(), otherDraft = randomUUID(), originals = new Map();
  const files = [
    { id:randomUUID(), name:'Поэтажный план (6 листов).pdf', mime:'application/pdf', role:'plan-source', subject_id:'plan', content:Buffer.from('%PDF-1.7\ncomplete original\n%%EOF'), storage:'postgres' },
    { id:randomUUID(), name:'Схема территории — Лесная, 5.png', mime:'image/png', role:'map', subject_id:'annotation', content:Buffer.from('original PNG bytes, no transformation'), storage:'s3' }
  ];
  const metadata = files.map(file => ({ id:file.id,name:file.name,mime:file.mime,role:file.role,subject_id:file.subject_id,bytes:file.content.length,sha256:sha(file.content) }));
  const data = { ui_version:5, inspection:{ address:'Москва, Мясницкая, 15', floor_plan:'1', rooms_complete:'Нет' }, workflow:{ conclusion_status:'actions', video_url:'https://disk.yandex.ru/i/video' },
    request_packet:{ cad_num:'DO NOT USE', service:'DO NOT USE', contacts:'Ирина +79990000000', materials:[{ object_key:'secret old EGRN object' }] }, evidence:metadata,
    documents:metadata.map(({bytes,...file})=>file), source_draft_id:draftId, storage_key:'private secret', entrances:[], zones:[], map:{annotations:[]} };
  const completeText = 'Отчёт аудитора\nАдрес: Москва, Мясницкая, 15\nАудитор: Саша Я.\n' + 'Полный сохранённый текст и ответы.\n'.repeat(450);
  try {
    await db.exec(`CREATE TABLE orders(id INT PRIMARY KEY,address TEXT,owner_name TEXT,object_name TEXT,object_type TEXT,contacts TEXT,zones_info TEXT,cad_num TEXT,service TEXT,archive_url TEXT,telegram_msg_id BIGINT);
      CREATE TABLE audits(id INT PRIMARY KEY,order_id INT,text TEXT,report_data JSONB,draft_id UUID,chat_id BIGINT,msg_ids BIGINT[],created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE reports(id INT PRIMARY KEY,text TEXT,author TEXT,chat_id BIGINT,msg_ids BIGINT[],reply_to BIGINT,first_id BIGINT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE cases(id INT PRIMARY KEY,order_id INT,lawyer_tg_id BIGINT,lawyer_name TEXT,data JSONB DEFAULT '{}',handoff_submit_id TEXT);
      CREATE TABLE order_materials(order_id INT,id UUID,name TEXT,mime TEXT,role TEXT,bytes INT,sha256 TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE audit_evidence(draft_id UUID,id UUID,name TEXT,mime TEXT,role TEXT,subject_id TEXT,bytes INT,sha256 TEXT,content BYTEA,storage TEXT,object_key TEXT,deleted_at TIMESTAMPTZ);
      CREATE TABLE egrn_orders(id INT PRIMARY KEY,cad_num TEXT,status TEXT,files_sent INT,created_at TIMESTAMPTZ DEFAULT NOW(),type_doc TEXT DEFAULT 'kvarmrusxmlpdf',file_msgs JSONB DEFAULT '[]',delivery_manifest JSONB DEFAULT '[]');
      CREATE TABLE egrn_files(id UUID,egrn_order_id BIGINT);`);
    await db.query('INSERT INTO orders VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [60,'Москва, Лесная, 5','Саша Ч.','ООО «ЧООКДИ»','Общепит алкоголь','Карина +7 999 123 45 67\nПеред выездом позвонить. Контакт передала Ирина','ИНН: 7701234567','77:01:0004016:1064','Продление',null,50]);
    await db.query('INSERT INTO orders VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [61,'Москва, Другой объект','Менеджер','Другая компания','Табак','','','','Получение',null,51]);
    for (const [id, draft] of [[14,draftId],[15,null]]) await db.query('INSERT INTO audits(id,order_id,text,report_data,draft_id,chat_id,msg_ids) VALUES($1,60,$2,$3,$4,$5,$6)', [id,completeText,JSON.stringify(data),draft,'-1001234567890',[102,100,101]]);
    await db.query('INSERT INTO audits(id,order_id,text,report_data,draft_id) VALUES(16,61,$1,$2,$3)', ['Other audit',JSON.stringify({evidence:[]}),otherDraft]);
    for (const file of files) {
      const key = file.storage === 's3' ? 'audit-originals/' + draftId + '/' + randomUUID() : null;
      if (key) originals.set(key,file.content);
      await db.query('INSERT INTO audit_evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [draftId,file.id,file.name,file.mime,file.role,file.subject_id,file.content.length,sha(file.content),key?null:file.content,file.storage,key,new Date()]);
    }
    const store = createAuditEvidenceStore({ objectStore:{ configured:()=>true, async get(input) { gets.push(input.key); assert.ok(originals.has(input.key)); return Readable.from([originals.get(input.key)]); } } });
    const service = createPacketService({pool,evidenceStore:store,workingChatId:'-1001234567890'});
    await run({db,pool,sql,gets,files,metadata,data,draftId,service,store,completeText});
  } finally { await db.close(); }
}
const pg = {skip:!process.env.PGLITE_TEST_MODULE};
test('a v3 audit link follows its logical summary even when the photo album was sent first', pg, async () => database(async h => {
  const logicalIds = [1004,1001,1002,1003,1005,1006];
  await h.db.query('UPDATE audits SET msg_ids=$1 WHERE id=15', [logicalIds]);
  const selected = await h.service.packet({ order_id:60,report_src:'a',report_id:15 });
  assert.equal(selected.report.telegram_url,'https://t.me/c/1234567890/1004');
  const latest = await h.service.packet({ order_id:60 });
  assert.equal(latest.report.id,15);
  assert.equal(latest.report.telegram_url,selected.report.telegram_url);
  assert.deepEqual((await h.db.query('SELECT msg_ids FROM audits WHERE id=15')).rows[0].msg_ids,logicalIds,
    'Resolving the report link must not reorder the persisted delivery receipts');
}));
test('saved audit 15 resolves original source_draft_id, exposes full immutable report, and downloads private S3 / old PostgreSQL originals exactly', pg, async () => database(async h => {
  const packet = await h.service.packet({order_id:60,report_src:'a',report_id:15});
  assert.equal(packet.order.org,'ООО «ЧООКДИ»'); assert.equal(packet.order.address,'Москва, Лесная, 5');
  assert.equal(packet.order.kind,'Общепит'); assert.equal(packet.order.region,'МСК'); assert.equal(packet.order.inn,'7701234567');
  assert.equal(packet.order.cad_num,'77:01:0004016:1064'); assert.equal(packet.order.service,'Продление');
  assert.equal(packet.order.contacts[0].name,'Карина'); assert.equal(packet.order.contacts.length,1);
  assert.equal(packet.report.text,h.completeText); assert.equal(packet.report.actor,'Саша Я.'); assert.equal(packet.report.inspection.rooms_complete,'Нет');
  assert.deepEqual(packet.report.historical_address_difference,{report:'Москва, Мясницкая, 15',order:'Москва, Лесная, 5'});
  assert.equal(packet.report.telegram_url,'https://t.me/c/1234567890/102'); assert.equal(packet.report.video_url,'https://disk.yandex.ru/i/video');
  assert.equal(packet.archive_url,''); assert.equal(packet.order.archive_url,''); assert.equal(packet.report.media.length,2);
  assert.doesNotMatch(JSON.stringify(packet),/object_key|storage_key|audit-originals|secret|"content"|"buffer"|DO NOT USE|79990000000/);
  for (const file of h.files) {
    const response = await h.service.file(15,file.id); assert.deepEqual(response.buffer,file.content); assert.equal(response.sha256,sha(file.content));
  }
  assert.equal(h.gets.length,1); assert.equal((await h.service.packet({report_src:'a',report_id:15})).order.id,60);
  assert.match(packet.signature,/^[a-f0-9]{64}$/); assert.equal(packet.egrn.status,'missing');
}));
test('saved-report membership, order binding, SHA / role / MIME / subject checks run before private storage reads', pg, async () => database(async h => {
  await assert.rejects(h.service.packet({order_id:60,report_src:'a',report_id:16}),e=>e.code==='REPORT_ORDER_MISMATCH');
  await assert.rejects(h.service.file(15,randomUUID()),e=>e.code==='FILE_NOT_IN_REPORT');
  await assert.rejects(h.service.file(15,"' OR TRUE"),e=>e.status===400);
  const target = h.files[1], initialGets=h.gets.length;
  for (const [column,bad,good] of [['role','interior',target.role],['mime','image/jpeg',target.mime],['subject_id','other',target.subject_id],['sha256','a'.repeat(64),sha(target.content)]]) {
    await h.db.query('UPDATE audit_evidence SET '+column+'=$1 WHERE id=$2',[bad,target.id]);
    await assert.rejects(h.service.file(15,target.id),e=>e.code==='REPORT_FILE_CHANGED');
    assert.equal(h.gets.length,initialGets);
    await h.db.query('UPDATE audit_evidence SET '+column+'=$1 WHERE id=$2',[good,target.id]);
  }
  const plan=h.files[0]; await h.db.query('UPDATE audit_evidence SET content=$1 WHERE id=$2',[Buffer.alloc(plan.content.length,90),plan.id]);
  await assert.rejects(h.service.file(15,plan.id),e=>e.code==='AUDIT_EVIDENCE_INTEGRITY');
  const invalid = {...h.data,documents:[{...h.metadata[0],role:'different'}]};
  await h.db.query('UPDATE audits SET report_data=$1 WHERE id=15',[JSON.stringify(invalid)]);
  await assert.rejects(h.service.packet({order_id:60,report_id:15}),e=>e.code==='REPORT_FILES_CHANGED');
}));
test('packet signature changes with current order or source materials, not EGRN readiness; EGRN lookup remains SELECT-only', pg, async () => database(async h => {
  const first=await h.service.packet({order_id:60,report_id:15});
  await h.db.query("INSERT INTO egrn_orders(id,cad_num,status,files_sent) VALUES(70,'77:01:0004016:1064','ordered',0)");
  const waiting=await h.service.packet({order_id:60,report_id:15}); assert.equal(waiting.egrn.status,'waiting'); assert.equal(waiting.signature,first.signature);
  await h.db.query('INSERT INTO egrn_files VALUES($1,70)',[randomUUID()]);
  assert.equal((await h.service.packet({order_id:60,report_id:15})).egrn.status,'waiting','A stored object alone does not prove reusable delivery');
  await h.db.query("UPDATE egrn_orders SET status='done',files_sent=1,file_msgs=$1 WHERE id=70",[JSON.stringify([{key:'original-one',file_id:'telegram-pdf',id:400,chat:108}])]);
  const ready=await h.service.packet({order_id:60,report_id:15}); assert.equal(ready.egrn.status,'available'); assert.equal(ready.egrn.file_count,1); assert.equal(ready.signature,first.signature);
  const material={id:randomUUID(),name:'Выписка.pdf',mime:'application/pdf',role:'egrn',bytes:393400000,sha256:'b'.repeat(64)};
  await h.db.query('INSERT INTO order_materials(order_id,id,name,mime,role,bytes,sha256) VALUES(60,$1,$2,$3,$4,$5,$6)',Object.values(material));
  const withFile=await h.service.packet({order_id:60,report_id:15}); assert.notEqual(withFile.signature,first.signature); assert.equal(withFile.egrn.available_in,'materials');
  assert.equal(withFile.materials[0].bytes,393400000); assert.equal(withFile.materials[0].url,'/api/audit/orders/60/materials/'+material.id);
  await h.db.query("UPDATE orders SET address='Москва, Лесная, 5, комната 75' WHERE id=60");
  assert.notEqual((await h.service.packet({order_id:60,report_id:15})).signature,withFile.signature);
  assert.ok(h.sql.every(sql=>/^SELECT\b/.test(sql)));
  const injected=createPacketService({pool:h.pool,evidenceStore:h.store,lookupEgrn:async()=>({status:'available',provider_url:'https://secret',raw:'private',file_count:1})});
  assert.doesNotMatch(JSON.stringify((await injected.packet({order_id:60,report_id:15})).egrn),/secret|private|provider/);
}));
test('legacy report keeps every saved / reply text, honestly exposes no fabricated inline files, and keeps real archive link only', pg, async()=>database(async h=>{
  await h.db.query('INSERT INTO reports(id,text,author,chat_id,msg_ids,reply_to,first_id) VALUES(9,$1,$2,$3,$4,50,90)', ['Legacy full report','Мария','-1001234567890',[90]]);
  await h.db.query('INSERT INTO reports(id,text,author,chat_id,msg_ids,reply_to,first_id) VALUES(10,$1,$2,$3,$4,90,91)', ['Saved reply notes','Мария','-1001234567890',[91]]);
  const packet=await h.service.packet({order_id:60,report_src:'r',report_id:9});
  assert.equal(packet.report.telegram_url,'https://t.me/c/1234567890/90');
  assert.equal(packet.report.text,'Legacy full report\n\nSaved reply notes'); assert.equal(packet.report.actor,'Мария'); assert.deepEqual(packet.report.media,[]); assert.equal(packet.report.linked,1);
  assert.equal(packet.archive_url,'');
  await h.db.query("UPDATE orders SET archive_url='https://disk.yandex.ru/d/actual-archive' WHERE id=60");
  assert.equal((await h.service.packet({order_id:60,report_src:'r',report_id:9})).archive_url,'https://disk.yandex.ru/d/actual-archive');
  await assert.rejects(h.service.packet({order_id:61,report_src:'r',report_id:9}),e=>e.code==='REPORT_ORDER_MISMATCH');
  await h.db.query('INSERT INTO reports(id,text,author,chat_id,msg_ids,first_id) VALUES(11,$1,$2,$3,$4,120)', ['Заявка #60\nЧей объект: ООО ЧООКДИ','Автор заявки','-1001234567890',[120]]);
  const card=await h.service.packet({report_src:'r',report_id:11});
  assert.equal(card.order.id,60); assert.ok(card.report.text.includes(h.completeText)); assert.doesNotMatch(card.report.text,/Чей объект/); assert.equal(card.report.actor,'Саша Я.'); assert.deepEqual(card.report.media,[]);
}));
test('legal owner is preferred over brand and inspection cannot leak private metadata; corrected order address stays authoritative', pg, async()=>database(async h=>{
  await h.db.query("UPDATE orders SET owner_name='ООО «ЧООКДИ»',object_name='ЧООКДИ' WHERE id=60");
  const data={...h.data,inspection:{...h.data.inspection,object_key:'private-original-key',buffer:'private-bytes'}};
  await h.db.query('UPDATE audits SET report_data=$1 WHERE id=15',[JSON.stringify(data)]);
  const packet=await h.service.packet({order_id:60,report_id:15});
  assert.equal(packet.order.org,'ООО «ЧООКДИ»');assert.equal(packet.order.address,'Москва, Лесная, 5');assert.doesNotMatch(JSON.stringify(packet),/private-original-key|private-bytes|object_key|"buffer"/);
  await h.db.query("UPDATE orders SET owner_name='Саша Ч.',object_name='ЧООКДИ' WHERE id=60");
  data.inspection.org='ООО «ЧООКДИ»';await h.db.query('UPDATE audits SET report_data=$1 WHERE id=15',[JSON.stringify(data)]);
  assert.equal((await h.service.packet({order_id:60,report_id:15})).order.org,'ООО «ЧООКДИ»');
}));
test('EGRN preview ignores receipts older than thirty days and other document types, matching the reusable-order cache',pg,async()=>database(async h=>{
  await h.db.query("INSERT INTO egrn_orders(id,cad_num,status,files_sent,created_at,file_msgs) VALUES(70,'77:01:0004016:1064','done',1,NOW()-INTERVAL '31 days',$1)",[JSON.stringify([{id:400,chat:108,key:'old-original'}])]);
  await h.db.query("INSERT INTO egrn_orders(id,cad_num,status,files_sent,type_doc,file_msgs) VALUES(71,'77:01:0004016:1064','done',1,'other-document',$1)",[JSON.stringify([{id:401,chat:108,key:'wrong-type'}])]);
  await h.db.query('INSERT INTO egrn_files VALUES($1,70)',[randomUUID()]);
  assert.equal((await h.service.packet({order_id:60,report_id:15})).egrn.status,'missing');
  assert.ok(h.sql.every(sql=>!sql.includes('FROM egrn_files')),'Object presence must not override delivery-cache rules');
}));
test('newest pending EGRN order takes precedence over an older delivered original; failed orders do not mask the valid cache',pg,async()=>database(async h=>{
  await h.db.query("INSERT INTO egrn_orders(id,cad_num,status,files_sent,created_at,file_msgs) VALUES(70,'77:01:0004016:1064','done',1,NOW()-INTERVAL '2 days',$1)",[JSON.stringify([{id:400,chat:108,key:'ready-older'}])]);
  await h.db.query("INSERT INTO egrn_orders(id,cad_num,status,files_sent) VALUES(71,'77:01:0004016:1064','ordered',0)");
  assert.equal((await h.service.packet({order_id:60,report_id:15})).egrn.status,'waiting');
  await h.db.query("UPDATE egrn_orders SET status='failed' WHERE id=71");
  assert.equal((await h.service.packet({order_id:60,report_id:15})).egrn.status,'available');
}));
test('stopped EGRN delivery is unknown and only a complete saved link manifest becomes reusable without files_sent',pg,async()=>database(async h=>{
  await h.db.query("INSERT INTO egrn_orders(id,cad_num,status,files_sent) VALUES(70,'77:01:0004016:1064','failed',0)");
  assert.equal((await h.service.packet({order_id:60,report_id:15})).egrn.status,'missing');
  await h.db.query("UPDATE egrn_orders SET status='done',files_sent=-1 WHERE id=70");
  assert.equal((await h.service.packet({order_id:60,report_id:15})).egrn.status,'unknown');
  await h.db.query("UPDATE egrn_orders SET files_sent=0,file_msgs=$1,delivery_manifest=$2 WHERE id=70",[JSON.stringify([{kind:'link',key:'one',url:'https://provider-secret.invalid/file'}]),JSON.stringify(['one','two'])]);
  assert.equal((await h.service.packet({order_id:60,report_id:15})).egrn.status,'waiting');
  await h.db.query('UPDATE egrn_orders SET delivery_manifest=$1 WHERE id=70',[JSON.stringify(['one'])]);
  const egrn=(await h.service.packet({order_id:60,report_id:15})).egrn;assert.equal(egrn.status,'available');assert.doesNotMatch(JSON.stringify(egrn),/provider-secret|url|key/);
}));
test('packet exposes existing assignment and its resumable submit ID without changing the source signature or claiming legacy delivery completion',pg,async()=>database(async h=>{
  const first=await h.service.packet({order_id:60,report_id:15});assert.equal(first.assignment,null);
  await h.db.query("INSERT INTO cases(id,order_id,lawyer_name) VALUES(800,60,'Юрист ранее')");
  const legacy=await h.service.packet({order_id:60,report_id:15});assert.deepEqual(legacy.assignment,{case_id:800,lawyer_name:'Юрист ранее',submit_id:null});assert.equal(legacy.signature,first.signature);
  const submitId=randomUUID();await h.db.query('UPDATE cases SET data=$1,handoff_submit_id=$2 WHERE id=800',[JSON.stringify({_handoff:{completed:false}}),submitId]);
  const pending=await h.service.packet({order_id:60,report_id:15});assert.deepEqual(pending.assignment,{case_id:800,lawyer_name:'Юрист ранее',submit_id:submitId,delivery_complete:false});assert.equal(pending.signature,first.signature);
  await h.db.query('UPDATE cases SET data=$1 WHERE id=800',[JSON.stringify({_handoff:{completed:true}})]);
  assert.equal((await h.service.packet({order_id:60,report_id:15})).assignment.delivery_complete,true);
}));

test('required group notice projects only safe delivery state while private completion and source signature remain independent',pg,async()=>database(async h=>{
  const first=await h.service.packet({order_id:60,report_id:15});
  await h.db.query("INSERT INTO cases(id,order_id,lawyer_name) VALUES(800,60,'Мария')");
  for(const [status,intent,expected] of [['pending',null,'pending'],['rejected',null,'rejected'],['blocked',null,'blocked'],['confirmed',null,'confirmed'],['unknown',null,'unknown'],['sending',null,'unknown'],['rejected',{key:'private-intent'},'unknown']]){
    await h.db.query('UPDATE cases SET data=$1 WHERE id=800',[JSON.stringify({_handoff:{completed:true,groupNotice:{required:true,status,intent,target:'-100PRIVATE',warning:'private detail',cursors:{101:99}}}})]);
    const p=await h.service.packet({order_id:60,report_id:15}),notice=p.assignment.group_notice;
    assert.equal(p.assignment.delivery_complete,true);assert.equal(p.signature,first.signature);assert.equal(notice.status,expected);assert.equal(notice.manual_review,expected==='unknown');assert.equal(notice.retry,['pending','rejected','blocked'].includes(expected));assert.ok(notice.message);
    assert.doesNotMatch(JSON.stringify(p.assignment),/PRIVATE|private|intent|cursors|target|warning/);
  }
  await h.db.query('UPDATE cases SET data=$1 WHERE id=800',[JSON.stringify({_handoff:{completed:true,groupNotice:{required:false,status:'pending'}}})]);
  assert.equal((await h.service.packet({order_id:60,report_id:15})).assignment.group_notice,undefined);
  assert.ok(h.sql.every(sql=>/^SELECT\b/.test(sql)));
}));

test('packet route grants group-only resume to managers for safe pending states and keeps private completion truthful',async()=>{
  const routes=new Map();let assignment,role='manager';
  setupHandoffPacket({get(path,run){routes.set(path,run);}},{pool:{async query(){return{rows:[{tg_id:101,role,approved:true,access_case:{id:75,order_id:60,lawyer_tg_id:101,data:{}}}]};}},service:{async packet(){return{order:{id:60},assignment:JSON.parse(JSON.stringify(assignment))};}}});
  const read=async()=>{let result;const res={set(){return this;},status(){return this;},json(value){result=value;}};await routes.get('/api/handoff/packet')({staff:{approved:true,role},tgUser:{id:101},query:{}},res);return result.assignment;};
  for(const status of ['pending','rejected','blocked','unknown','confirmed']){
    assignment={case_id:75,delivery_complete:true,group_notice:{status,manual_review:status==='unknown',retry:['pending','rejected','blocked'].includes(status)}};
    const result=await read();assert.equal(result.delivery_complete,true);assert.equal(result.can_resume,['pending','rejected','blocked'].includes(status));
  }
  assignment={case_id:75,delivery_complete:true};assert.equal((await read()).can_resume,false,'legacy completed handoffs do not acquire a retry');
  assignment={case_id:75,delivery_complete:true,group_notice:{status:'rejected',retry:true}};role='lawyer';assert.equal((await read()).can_resume,false);
  role='manager';assignment={case_id:75,delivery_complete:false};assert.equal((await read()).can_resume,true,'existing private partial recovery stays available');
});

test('HTTP files inherit the /api/handoff staff guard, preserve UTF-8 filenames and bytes, and hide unexpected storage errors', async () => {
  const express=require('express'),app=express(),calls=[],bytes=Buffer.from('exact original');
  app.use('/api/handoff',(req,res,next)=>{if(req.get('X-Test-Staff')!=='approved')return res.status(403).json({ok:false});req.staff={role:'manager',approved:true};req.tgUser={id:101};next();});
  setupHandoffPacket(app,{pool:{async query(){return{rows:[{tg_id:101,role:'manager',approved:true,access_case:null}]};}},service:{ async packet() {calls.push('packet');return {ok:true};}, async file(id) {calls.push('file');if(id==='99')throw new Error('secret storage key and credentials');return {name:'План «Лесная, 5».pdf',mime:'application/pdf',buffer:bytes};} }});
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  try {
    assert.equal((await fetch(origin+'/api/handoff/packet')).status,403);
    assert.equal((await fetch(origin+'/api/handoff/reports/15/files/'+randomUUID())).status,403); assert.deepEqual(calls,[]);
    const headers={'X-Test-Staff':'approved'},path='/api/handoff/reports/15/files/'+randomUUID();
    const inline=await fetch(origin+path,{headers}); assert.equal(inline.status,200); assert.equal(inline.headers.get('content-type'),'application/pdf');
    assert.match(inline.headers.get('content-disposition'),/^inline;/); assert.match(inline.headers.get('content-disposition'),/filename\*=UTF-8''%D0/);
    assert.equal(inline.headers.get('x-content-type-options'),'nosniff'); assert.match(inline.headers.get('cache-control'),/no-store/);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()),bytes);
    const download=await fetch(origin+path+'?download=1',{headers}); assert.match(download.headers.get('content-disposition'),/^attachment;/); await download.arrayBuffer();
    const failed=await fetch(origin+'/api/handoff/reports/99/files/'+randomUUID(),{headers}); assert.equal(failed.status,503); assert.doesNotMatch(await failed.text(),/secret|credentials|storage key/);
  } finally { server.close(); await once(server,'close'); }
});

test('large EGRN metadata is part of the reviewed handoff without downloading or duplicating the original', pg, async () => database(async h => {
  const fileId = randomUUID();
  const large = { id: fileId, name: 'Крупная выписка.pdf', mime: 'application/pdf', role: 'egrn', bytes: 350 * 1024 * 1024,
    sha256: 'c'.repeat(64), url: '/api/audit/orders/60/egrn/' + fileId + '/link' };
  const service = createPacketService({ pool: h.pool, evidenceStore: h.store, listEgrnLinks: async id => { assert.equal(id, 60); return [large]; } });
  const packet = await service.packet({ order_id: 60, report_id: 15, report_src: 'a' });
  assert.deepEqual(packet.egrn_links, [large]);
  assert.equal(packet.materials.some(file => file.id === fileId), false);
  assert.equal(h.gets.length, 0);
  assert.notEqual(packet.signature, (await h.service.packet({ order_id: 60, report_id: 15, report_src: 'a' })).signature);
}));

test('an assigned lawyer cannot combine their order with an unrelated unlinked report', async () => {
  const express = require('express'), app = express();
  let manager = false;
  const assigned = { id: 5, order_id: 60, lawyer_tg_id: 101, data: {} };
  app.use((req, res, next) => { req.staff = { approved: true, role: manager ? 'manager' : 'lawyer' }; req.tgUser = { id: 101 }; next(); });
  const pool = { async query() { return { rows: [{tg_id:101,role:manager?'manager':'lawyer',approved:true,access_case:assigned}] }; } };
  setupHandoffPacket(app, { pool, service: {
    async packet(query) { return { order: { id: 60 }, report: { id: Number(query.report_id), src: query.report_src || 'a', order_id: query.report_id === '15' ? 60 : null } }; },
  } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(origin + '/api/handoff/packet?order_id=60&report_id=15')).status, 200);
    for (const src of ['a', 'r']) {
      const result = await fetch(origin + '/api/handoff/packet?order_id=60&report_id=900&report_src=' + src);
      assert.equal(result.status, 403); assert.equal((await result.json()).code, 'CASE_FORBIDDEN');
    }
    assigned.data = { _handoff: { body: { report_id: 900, report_src: 'r' } } };
    assert.equal((await fetch(origin + '/api/handoff/packet?order_id=60&report_id=900&report_src=r')).status, 200);
    assert.equal((await fetch(origin + '/api/handoff/packet?order_id=60&report_id=901&report_src=r')).status, 403);
    manager = true;
    assert.equal((await fetch(origin + '/api/handoff/packet?order_id=60&report_id=901&report_src=r')).status, 200);
  } finally { server.close(); await once(server, 'close'); }
});

test('the assigned lawyer can download media from the exact unlinked historical audit a manager handed off', pg, async () => database(async h => {
  await h.db.exec("CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(101,'lawyer',true)");
  await h.db.query('UPDATE audits SET order_id=NULL WHERE id=15');
  await h.db.query('INSERT INTO cases(id,order_id,lawyer_tg_id,data) VALUES(800,60,101,$1)', [JSON.stringify({ _handoff: { body: { report_id: 15, report_src: 'a' } } })]);
  const express = require('express'), app = express();
  app.use((req,res,next) => { req.staff = { approved: true, role: 'lawyer' }; req.tgUser = { id: 101 }; next(); });
  setupHandoffPacket(app, { service: h.service, pool: h.pool });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const packetResponse = await fetch(origin + '/api/handoff/packet?order_id=60&report_id=15');
    assert.equal(packetResponse.status, 200);
    const packet = await packetResponse.json();
    for (const media of packet.report.media) {
      assert.match(media.url, /\?order_id=60$/);
      const downloaded = await fetch(origin + media.url);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), h.files.find(file => file.id === media.id).content);
    }
    const denied = await fetch(origin + packet.report.media[0].url.replace('order_id=60', 'order_id=61'));
    assert.equal(denied.status, 403);
    assert.equal((await fetch(origin + packet.report.media[0].url.split('?')[0])).status, 403);
  } finally { server.close(); await once(server, 'close'); }
}));

test('a no-order case authorizes only its assigned current staff and frozen report, including exact original-file URLs',pg,async()=>database(async h=>{
  await h.db.exec("CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(101,'lawyer',true),(102,'lawyer',true),(103,'manager',true);UPDATE audits SET order_id=NULL WHERE id IN(14,15)");
  const state={_handoff:{version:2,body:{order_id:null,report_src:'a',report_id:15}}};
  await h.db.query('INSERT INTO cases(id,order_id,lawyer_tg_id,data) VALUES(800,NULL,101,$1),(801,NULL,102,$1)',[JSON.stringify(state)]);
  let actor=101;const express=require('express'),app=express();app.use((req,res,next)=>{req.staff={role:actor===103?'manager':'lawyer',approved:true};req.tgUser={id:actor};next();});setupHandoffPacket(app,{service:h.service,pool:h.pool});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const check=async(path,status)=>{const r=await fetch(origin+path);assert.equal(r.status,status,path);return r;};
  try{
    const p=await(await check('/api/handoff/packet?case_id=800&report_src=a&report_id=15',200)).json();assert.equal(p.order,null);assert.equal(p.report.id,15);assert.equal(p.request,undefined);
    for(const file of p.report.media){assert.equal(new URL(file.url,origin).searchParams.get('case_id'),'800');assert.deepEqual(Buffer.from(await(await check(file.url,200)).arrayBuffer()),h.files.find(value=>value.id===file.id).content);}
    for(const path of ['/api/handoff/packet?case_id=801&report_id=15','/api/handoff/packet?case_id=800&report_id=14','/api/handoff/packet?case_id=800&report_id=15&order_id=60',p.report.media[0].url.replace('case_id=800','case_id=801'),p.report.media[0].url.split('?')[0]]){await(await check(path,403)).json();}
    await h.db.query('UPDATE staff SET approved=false WHERE tg_id=101');await(await check('/api/handoff/packet?case_id=800&report_id=15',403)).json();await h.db.query("UPDATE staff SET approved=true,role='auditor' WHERE tg_id=101");await(await check('/api/handoff/packet?case_id=800&report_id=15',403)).json();
    actor=103;await(await check('/api/handoff/packet?case_id=800&report_id=15',200)).json();await(await check('/api/handoff/packet?case_id=800&report_id=14',403)).json();
  }finally{server.close();await once(server,'close');}
}));

test('a no-order original download rechecks its case after the private object read before exposing bytes',pg,async()=>database(async h=>{
  await h.db.exec("CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(101,'lawyer',true),(102,'lawyer',true);UPDATE audits SET order_id=NULL WHERE id=15");
  await h.db.query('INSERT INTO cases(id,order_id,lawyer_tg_id,data) VALUES(800,NULL,101,$1)',[JSON.stringify({_handoff:{version:2,body:{order_id:null,report_src:'a',report_id:15}}})]);
  const read=h.store.read;h.store.read=async row=>{const result=await read(row);await h.db.exec('UPDATE cases SET lawyer_tg_id=102 WHERE id=800');return result;};
  const express=require('express'),app=express();app.use((req,res,next)=>{req.staff={role:'lawyer',approved:true};req.tgUser={id:101};next();});setupHandoffPacket(app,{service:h.service,pool:h.pool});const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/handoff/reports/15/files/'+h.files[0].id+'?case_id=800');assert.equal(r.status,403);assert.equal((await r.json()).code,'CASE_FORBIDDEN');}finally{server.close();await once(server,'close');}
}));

for (const change of ['approval','role','assignment']) test('an order-bound original rechecks current '+change+' after storage and remains accessible after restoration',pg,async()=>database(async h=>{
  const previousAdmins=process.env.ADMIN_TG_IDS;process.env.ADMIN_TG_IDS='';
  await h.db.exec("CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(101,'lawyer',true),(102,'lawyer',true);INSERT INTO cases(id,order_id,lawyer_tg_id,data) VALUES(800,60,101,'{}')");
  const read=h.store.read;
  h.store.read=async row=>{
    const original=await read(row);
    await h.db.exec(change==='approval'?'UPDATE staff SET approved=false WHERE tg_id=101':change==='role'?"UPDATE staff SET role='auditor' WHERE tg_id=101":'UPDATE cases SET lawyer_tg_id=102 WHERE id=800');
    return original;
  };
  const express=require('express'),app=express();
  app.use(async(req,res,next)=>{req.tgUser={id:101};req.staff=(await h.db.query('SELECT * FROM staff WHERE tg_id=101')).rows[0];next();});
  setupHandoffPacket(app,{service:h.service,pool:h.pool});
  const file=h.files[change==='approval'?1:0];
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port+'/api/handoff/reports/15/files/'+file.id;
  try {
    const denied=await fetch(url);assert.equal(denied.status,403);assert.equal((await denied.json()).code,'CASE_FORBIDDEN');
    h.store.read=read;await h.db.exec("UPDATE staff SET approved=true,role='lawyer' WHERE tg_id=101;UPDATE cases SET lawyer_tg_id=101 WHERE id=800");
    const restored=await fetch(url);assert.equal(restored.status,200);assert.deepEqual(Buffer.from(await restored.arrayBuffer()),file.content);
    if(change==='approval')assert.equal(h.gets.length,2,'The S3 fixture was read before each final authorization; its bytes were withheld from the denied HTTP response');
  } finally {server.close();await once(server,'close');if(previousAdmins===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=previousAdmins;}
}));

for (const role of ['manager','configured admin']) test('a current '+role+' retains original access without an assignment but still needs approval after storage',pg,async()=>database(async h=>{
  const previousAdmins=process.env.ADMIN_TG_IDS,actor=role==='manager'?101:103;process.env.ADMIN_TG_IDS=role==='manager'?'':'103';
  await h.db.exec("CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(101,'manager',true),(103,'auditor',true)");
  const express=require('express'),app=express();
  app.use(async(req,res,next)=>{req.tgUser={id:actor};req.staff=(await h.db.query('SELECT * FROM staff WHERE tg_id=$1',[actor])).rows[0];next();});
  setupHandoffPacket(app,{service:h.service,pool:h.pool});const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port+'/api/handoff/reports/15/files/'+h.files[0].id,read=h.store.read;
  try {
    const allowed=await fetch(url);assert.equal(allowed.status,200);assert.deepEqual(Buffer.from(await allowed.arrayBuffer()),h.files[0].content);
    h.store.read=async row=>{const original=await read(row);await h.db.query('UPDATE staff SET approved=false WHERE tg_id=$1',[actor]);return original;};
    const denied=await fetch(url);assert.equal(denied.status,403);assert.equal((await denied.json()).code,'CASE_FORBIDDEN');
  } finally {server.close();await once(server,'close');if(previousAdmins===undefined)delete process.env.ADMIN_TG_IDS;else process.env.ADMIN_TG_IDS=previousAdmins;}
}));
