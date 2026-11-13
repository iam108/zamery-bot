'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {createCasePackageService,setupCasePackage,archiveParts,component}=require('../src/web/handoff-case-package');
const yauzl=require('yauzl');
const pg={skip:!process.env.PGLITE_TEST_MODULE,timeout:20000};
const meta=file=>Object.fromEntries(['id','name','mime','role','bytes','sha256'].map(k=>[k,file[k]]));
function file(name='План.pdf',content='%PDF-1.7\nsynthetic only\n%%EOF'){const buffer=Buffer.from(content);return {id:randomUUID(),name,mime:'application/pdf',role:'document',bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),buffer};}
async function collect(iterable){const chunks=[];for await(const chunk of iterable)chunks.push(chunk);return Buffer.concat(chunks);}
async function unzip(buffer){
  const zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(e,z)=>e?reject(e):resolve(z))),result=[];
  return new Promise((resolve,reject)=>{zip.on('error',reject);zip.on('end',()=>resolve(result));zip.on('entry',entry=>zip.openReadStream(entry,async(error,stream)=>{if(error)return reject(error);try{const content=await collect(stream);result.push({name:entry.fileName,buffer:content,crc:entry.crc32});zip.readEntry();}catch(e){reject(e);}}));zip.readEntry();});
}
async function fixture(run){
  const {PGlite}=require(process.env.PGLITE_TEST_MODULE),db=new PGlite();
  await db.exec(`CREATE TABLE staff(tg_id BIGINT PRIMARY KEY,role TEXT,approved BOOLEAN);INSERT INTO staff VALUES(101,'manager',true),(808,'lawyer',true),(909,'lawyer',true),(707,'auditor',true);CREATE TABLE cases(id INT PRIMARY KEY,org TEXT,address TEXT,order_id INT,lawyer_tg_id BIGINT,created_by BIGINT,handoff_submit_id TEXT,audit_text TEXT,data JSONB);CREATE TABLE audits(id INT PRIMARY KEY,order_id INT);INSERT INTO audits VALUES(51,7);`);
  const audit=file('План.pdf'),order=file('Договор.pdf'),extra=file('Доп.pdf'),initial=file('Согласие.pdf'),batch=randomUUID(),submit=randomUUID();
  const extract={id:randomUUID(),name:'Большая выписка.pdf',mime:'application/pdf',source:'stored',bytes:2*1024*1024*1024,sha256:'a'.repeat(64)};
  const state={version:2,body:{order_id:7,report_id:51,report_src:'a',submit_id:submit},packet:{order:{id:7,org:'Название заведения'},report:{id:51,src:'a',order_id:7,text:'Проверено: границы соблюдены.',media:[meta(audit)],telegram_url:'https://t.me/c/123/456',video_url:'https://disk.yandex.ru/i/video'},materials:[meta(order)],egrn_links:[extract],archive_url:'https://disk.yandex.ru/d/archive'}};
  await db.query("INSERT INTO cases VALUES(39,'ООО «Тестовый лимон»','Москва',7,808,101,$1,'Сохранённый отчёт',$2)",[submit,JSON.stringify({_handoff:state})]);
  let before=async()=>{},loaded=[],calls=[];
  const pool={query:async(sql,args)=>{calls.push([sql,args]);await before(sql,args);return db.query(sql,args);}};
  const dependencies={pool,materials:{async download(id,fid){loaded.push('order');assert.equal(id,7);assert.equal(fid,order.id);return order;}},reports:{async file(id,fid){loaded.push('audit');assert.equal(id,51);assert.equal(fid,audit.id);return audit;}},manual:{async read(owner,sid,id){loaded.push('initial');assert.equal(String(owner),'101');assert.equal(sid,submit);assert.equal(id,initial.id);return initial;}},documents:{async list(id,actor){assert.equal(id,39);assert.ok([101,808].includes(Number(actor)));return {files:[{...meta(extra),batch_id:batch}]};},async file(cid,bid,fid){loaded.push('extra');assert.equal(cid,39);assert.equal(bid,batch);assert.equal(fid,extra.id);return extra;}},egrn:{async list(id){assert.equal(id,7);return [extract];},async link(id,fid){assert.equal(id,7);assert.equal(fid,extract.id);return {url:'https://example.test/egrn/download'};}}};
  const save=async()=>db.query('UPDATE cases SET data=$1 WHERE id=39',[JSON.stringify({_handoff:state})]);
  try{await run({db,pool,state,audit,order,extra,initial,extract,submit,batch,loaded,calls,dependencies,save,before(fn){before=fn;},service:createCasePackageService(dependencies)});}finally{await db.close();}
}

test('package includes frozen audit/order/supplemental bytes, current company, external links and a valid ZIP directory',pg,()=>fixture(async h=>{
  await h.db.exec('ALTER TABLE cases ADD COLUMN contacts JSONB, ADD COLUMN client TEXT, ADD COLUMN phone TEXT, ADD COLUMN comment TEXT, ADD COLUMN inn TEXT');
  const contacts = [{name:'Сотрудник',phone:'+70000000001',tg:'@contact_one',comment:'Вход со двора.'},
    {name:'Администратор',phone:'+70000000002',tg:'@contact_two',comment:'Связаться после 11:00.'}];
  const comment = 'Сначала согласовать встречу.\n'+('Примечание к комплекту. '.repeat(32))+'Проверить оригинал.';
  h.state.fields = {cad_num:'77:01:0000001:1'};
  await h.save();
  await h.db.query('UPDATE cases SET contacts=$1,comment=$2,inn=$3,client=$4,phone=$5 WHERE id=39',[JSON.stringify(contacts),comment,'7700000000','Устаревший контакт','000']);
  const pack=await h.service.prepare(39,808);assert.deepEqual(h.loaded,[],'Prepare must not load originals');
  const buffer=await collect(archiveParts(pack.items,{check:pack.check}));assert.equal(buffer.length,pack.length);
  const contents=await unzip(buffer);assert.equal(contents.length,5);assert.ok(contents.every(e=>e.name.startsWith('ООО «Тестовый лимон»/Клиент №39/')));
  assert.deepEqual(h.loaded,['audit','order','extra']);
  for(const [folder,original]of [['Аудит',h.audit],['Документы заявки',h.order],['Дополнительные документы',h.extra]])assert.ok(contents.find(e=>e.name.includes('/'+folder+'/')).buffer.equals(original.buffer));
  const summary=contents.find(e=>e.name.endsWith('Отчёт.txt')).buffer.toString();
  assert.match(summary,/^ООО «Тестовый лимон»/);
  assert.match(summary,/ИНН 7700000000 · Кадастровый номер 77:01:0000001:1/);
  assert.ok(summary.includes('Сотрудник · +70000000001 · @contact_one\nВход со двора.'));
  assert.ok(summary.includes('Администратор · +70000000002 · @contact_two\nСвязаться после 11:00.'));
  assert.ok(summary.includes('Комментарий менеджера\n'+comment));
  assert.doesNotMatch(summary,/Устаревший контакт/);
  const links=contents.find(e=>e.name.endsWith('Ссылки.txt')).buffer.toString();assert.match(links,/не включены в ZIP/);assert.match(links,/https:\/\/example.test\/egrn\/download/);assert.match(links,/Видео осмотра/);assert.match(links,/Архив объекта/);
  const {crc32}=require('../src/web/order-materials');for(const e of contents)assert.equal(e.crc,crc32(e.buffer));
}));

test('package never uses source organization or unsaved order/audit documents',pg,()=>fixture(async h=>{
  h.state.packet.materials=[];h.state.packet.report.media=[];await h.save();
  const pack=await h.service.prepare(39,101),contents=await unzip(await collect(archiveParts(pack.items,{check:pack.check})));
  assert.deepEqual(h.loaded,['extra']);assert.ok(!pack.name.includes('Название заведения'));assert.ok(contents.every(e=>!e.name.includes('/Документы заявки/')));
  assert.match(contents.find(e=>e.name.endsWith('Ссылки.txt')).buffer.toString(),/Оригиналы аудита не сохранены/);
}));

test('manual clients include only the frozen initial manager selection',pg,()=>fixture(async h=>{
  h.state.body={order_id:null,report_id:null,manual_client:true,submit_id:h.submit,manual_files:[meta(h.initial)]};h.state.packet={order:null,report:null,materials:[],manual_materials:[meta(h.initial)]};await h.save();await h.db.exec('UPDATE cases SET order_id=NULL WHERE id=39');
  const pack=await h.service.prepare(39,808),contents=await unzip(await collect(archiveParts(pack.items,{check:pack.check})));
  assert.ok(contents.find(e=>e.name.includes('/Документы менеджера/')).buffer.equals(h.initial.buffer));assert.deepEqual(h.loaded,['initial','extra']);
  h.state.body.manual_files=[];await h.save();await assert.rejects(h.service.prepare(39,808),e=>e.code==='CASE_PACKAGE_CHANGED');
}));

test('approved manager and assigned lawyer only; no foreign, unapproved or missing actor access',pg,()=>fixture(async h=>{
  for(const actor of [909,707,999,undefined])await assert.rejects(h.service.prepare(39,actor),e=>[401,403].includes(e.status));
  await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=808');await assert.rejects(h.service.prepare(39,808),e=>e.status===403);assert.deepEqual(h.loaded,[]);
  await assert.rejects(h.service.prepare('39/../../etc',101),e=>e.status===400);
}));

test('revocation after original read aborts ZIP before revealing that original',pg,()=>fixture(async h=>{
  h.dependencies.reports.file=async()=>{await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=808');return h.audit;};
  const pack=await h.service.prepare(39,808),chunks=[];
  await assert.rejects(async()=>{for await(const chunk of archiveParts(pack.items,{check:pack.check}))chunks.push(chunk);},e=>e.status===403);
  const partial=Buffer.concat(chunks);assert.ok(!partial.includes(h.audit.buffer));await assert.rejects(unzip(partial));
}));

test('assignment change cancels even a manager download, instead of mixing two case versions',pg,()=>fixture(async h=>{
  const pack=await h.service.prepare(39,101);await h.db.exec('UPDATE cases SET lawyer_tg_id=909 WHERE id=39');await assert.rejects(collect(archiveParts(pack.items,{check:pack.check})),e=>e.code==='CASE_PACKAGE_CHANGED');assert.deepEqual(h.loaded,[]);
}));

test('a changed manager comment aborts a prepared archive before reading originals',pg,()=>fixture(async h=>{
  await h.db.exec("ALTER TABLE cases ADD COLUMN comment TEXT DEFAULT 'Подтверждённое примечание'");
  const pack=await h.service.prepare(39,808);
  await h.db.exec("UPDATE cases SET comment='Новое примечание' WHERE id=39");
  await assert.rejects(collect(archiveParts(pack.items,{check:pack.check})),e=>e.code==='CASE_PACKAGE_CHANGED');
  assert.deepEqual(h.loaded,[]);
}));

test('revocation just before ZIP completion prevents a valid archive',pg,()=>fixture(async h=>{
  const pack=await h.service.prepare(39,808);let checks=0;const check=async()=>{if(++checks===pack.items.length*2+2)await h.db.exec('UPDATE staff SET approved=false WHERE tg_id=808');return pack.check();};
  const chunks=[];await assert.rejects(async()=>{for await(const chunk of archiveParts(pack.items,{check}))chunks.push(chunk);},e=>e.status===403);await assert.rejects(unzip(Buffer.concat(chunks)));
}));

test('tampered originals are never sent as complete ZIP and retry can recover',pg,()=>fixture(async h=>{
  const pack=await h.service.prepare(39,808),original=h.audit.buffer;h.audit.buffer=Buffer.alloc(original.length,0);
  await assert.rejects(collect(archiveParts(pack.items,{check:pack.check})),e=>e.code==='CASE_PACKAGE_INTEGRITY');
  h.audit.buffer=original;assert.equal((await unzip(await collect(archiveParts(pack.items,{check:pack.check})))).length,5);
}));

test('cross-case audit or changed snapshot fails closed before any original is loaded',pg,()=>fixture(async h=>{
  await h.db.exec('UPDATE audits SET order_id=88 WHERE id=51');await assert.rejects(h.service.prepare(39,808),e=>e.code==='CASE_PACKAGE_CHANGED');
  await h.db.exec('UPDATE audits SET order_id=7 WHERE id=51');const pack=await h.service.prepare(39,808);h.state.packet.materials=[];await h.save();await assert.rejects(collect(archiveParts(pack.items,{check:pack.check})),e=>e.code==='CASE_PACKAGE_CHANGED');assert.deepEqual(h.loaded,[]);
}));

test('unavailable EGRN link is explicit and does not download the multi-gigabyte original',pg,()=>fixture(async h=>{
  h.dependencies.egrn.link=async()=>{throw new Error('Unavailable');};const pack=await h.service.prepare(39,808),contents=await unzip(await collect(archiveParts(pack.items,{check:pack.check})));
  assert.match(contents.find(e=>e.name.endsWith('Ссылки.txt')).buffer.toString(),/ссылка недоступна; обновите ссылку/);assert.equal(contents.length,5);
}));

test('legacy case does not invent an audit/order linkage and preserves its saved report',pg,()=>fixture(async h=>{
  await h.db.exec("UPDATE cases SET data='{}' WHERE id=39");const pack=await h.service.prepare(39,808),contents=await unzip(await collect(archiveParts(pack.items,{check:pack.check})));
  assert.deepEqual(h.loaded,['extra']);assert.match(contents.find(e=>e.name.endsWith('Ссылки.txt')).buffer.toString(),/Историческая передача/);assert.match(contents.find(e=>e.name.endsWith('Отчёт.txt')).buffer.toString(),/Сохранённый отчёт/);
}));

test('paths are safe for Windows and Mac, duplicates get stable unique prefixes',pg,()=>fixture(async h=>{
  h.audit.name='../../CON:bad\\name.pdf';h.order.name=h.audit.name;h.state.packet.report.media=[meta(h.audit)];h.state.packet.materials=[meta(h.order)];await h.save();await h.db.query('UPDATE cases SET org=$1 WHERE id=39',['../..\\C:\\NUL:*?']);
  const pack=await h.service.prepare(39,808),contents=await unzip(await collect(archiveParts(pack.items,{check:pack.check})));
  assert.equal(new Set(contents.map(e=>e.name)).size,contents.length);for(const entry of contents){assert.ok(!/[\\:*?"<>|\x00-\x1f]/.test(entry.name));assert.ok(entry.name.split('/').every(p=>p!=='.'&&p!=='..'));}
  assert.equal(component('CON.txt'),'_CON.txt');assert.equal(component('...'),'Документ');assert.equal(component('nul'),'_nul');
}));

test('download cancellation stops before loading another original',pg,()=>fixture(async h=>{
  const pack=await h.service.prepare(39,808),controller=new AbortController(),stream=archiveParts(pack.items,{check:pack.check,signal:controller.signal});await stream.next();controller.abort();
  await assert.rejects(collect(stream),e=>e.name==='AbortError');assert.deepEqual(h.loaded,[]);
}));

test('HTTP package uses authenticated actor, exact length, attachment filename and no-store',async()=>{
  const express=require('express'),app=express();app.use((req,res,next)=>{req.tgUser={id:808};next();});
  const buffer=Buffer.from('synthetic'),items=[{path:'ООО/Клиент №39/file.txt',bytes:buffer.length,load:async()=>buffer}],length=(await collect(archiveParts(items))).length;
  setupCasePackage(app,{service:{async prepare(caseId,actor){assert.equal(caseId,'39');assert.equal(actor,808);return {name:'ООО.zip',items,length,check:async()=>{}};}}});
  const server=app.listen(0,'127.0.0.1');try{await new Promise(resolve=>server.once('listening',resolve));const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/handoff/cases/39/package');assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.equal(res.headers.get('content-length'),String(length));assert.match(res.headers.get('content-disposition'),/filename\*=UTF-8''/);assert.equal((await unzip(Buffer.from(await res.arrayBuffer()))).length,1);}finally{await new Promise(resolve=>server.close(resolve));}
});

test('HTTP access failure produces JSON without ZIP bytes',async()=>{
  const express=require('express'),app=express();setupCasePackage(app,{service:{async prepare(){throw Object.assign(new Error('Нет доступа'),{status:403,code:'CASE_PACKAGE_FORBIDDEN'});}}});
  const server=app.listen(0,'127.0.0.1');try{await new Promise(resolve=>server.once('listening',resolve));const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/handoff/cases/39/package');assert.equal(res.status,403);assert.equal((await res.json()).code,'CASE_PACKAGE_FORBIDDEN');}finally{await new Promise(resolve=>server.close(resolve));}
});

test('changed order metadata and replaced same-size bytes cannot enter the packet',pg,()=>fixture(async h=>{
  const pack=await h.service.prepare(39,808);h.order.name='Подмена.pdf';await assert.rejects(collect(archiveParts(pack.items,{check:pack.check})),e=>e.code==='CASE_PACKAGE_INTEGRITY');
  h.order.name='Договор.pdf';h.order.buffer=Buffer.alloc(h.order.bytes,49);h.order.sha256=createHash('sha256').update(h.order.buffer).digest('hex');
  await assert.rejects(collect(archiveParts(pack.items,{check:pack.check})),e=>e.code==='CASE_PACKAGE_INTEGRITY');
}));

test('very long original filenames preserve their extension and package oversized metadata rejects before reads',pg,()=>fixture(async h=>{
  h.audit.name='Длинное'.repeat(60)+'.pdf';h.state.packet.report.media=[meta(h.audit)];await h.save();const pack=await h.service.prepare(39,808);assert.match(pack.items.find(i=>i.path.includes('/Аудит/')).path,/\.pdf$/);
  h.dependencies.documents.list=async()=>({files:Array.from({length:100},()=>({...meta(h.extra),id:randomUUID(),bytes:12*1024*1024,batch_id:h.batch}))});
  await assert.rejects(h.service.prepare(39,808),e=>e.code==='CASE_PACKAGE_TOO_LARGE');assert.deepEqual(h.loaded,[]);
}));

test('later EGRN delivery without frozen original is explicitly excluded, never looked up by cadastre',pg,()=>fixture(async h=>{
  h.state.packet.egrn_links=[];h.state.egrn={result:'attached'};await h.save();h.dependencies.egrn.list=()=>{throw new Error('Must not query unrelated extracts');};
  const pack=await h.service.prepare(39,808),contents=await unzip(await collect(archiveParts(pack.items,{check:pack.check})));
  assert.match(contents.find(e=>e.name.endsWith('Ссылки.txt')).buffer.toString(),/ЕГРН отправлена юристу отдельно в Telegram. В ZIP оригинала нет/);
}));

test('HTTP interrupted original is a failed download, not an apparently successful partial ZIP',async()=>{
  const express=require('express'),app=express(),items=[{path:'ООО/Клиент №39/file.pdf',bytes:30,load:async()=>{throw new Error('synthetic read interruption');}}];
  setupCasePackage(app,{service:{async prepare(){return {name:'ООО.zip',items,length:500,check:async()=>{}};}}});
  const server=app.listen(0,'127.0.0.1');try{await new Promise(resolve=>server.once('listening',resolve));await assert.rejects(async()=>{const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/handoff/cases/39/package');await res.arrayBuffer();});}finally{await new Promise(resolve=>server.close(resolve));}
});
