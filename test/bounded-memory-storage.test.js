const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const { finished } = require('node:stream/promises');
const multer = require('multer');
const { boundedMemoryStorage } = require('../src/web/bounded-memory-storage');
const { setupManagerOrders } = require('../src/web/manager-orders');

function multipart(files, fields = [['file_roles','["plan","archive"]']]) {
  const boundary = 'bounded-upload-fixture', parts = [];
  for (const [name,value] of fields) parts.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"\r\n\r\n'+value+'\r\n'));
  files.forEach((buffer,index)=>parts.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="files"; filename="original-'+index+'.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),buffer,Buffer.from('\r\n')));
  parts.push(Buffer.from('--'+boundary+'--\r\n'));
  return { body:Buffer.concat(parts),headers:{'content-type':'multipart/form-data; boundary='+boundary} };
}
function streamOf(packet, chunkBytes=3) {
  const req=Readable.from((function*(){for(let offset=0;offset<packet.body.length;offset+=chunkBytes)yield packet.body.subarray(offset,offset+chunkBytes);})());
  req.method='POST';req.headers={...packet.headers,'content-length':String(packet.body.length)};return req;
}
function directParser(storage, limits={}) {
  const selected={fileSize:12,files:2,fields:4,fieldSize:100,parts:7,...limits};
  const parse=multer({storage,limits:selected}).array('files',selected.files);
  return (req,done)=>parse(req,{},error=>{if(error){storage.cleanup(req,error);if(!req.destroyed)req.resume();}else storage.complete(req);done(error);});
}
async function parsePacket(parser, packet) {
  const req=streamOf(packet),ended=finished(req).catch(()=>{});
  const error=await new Promise(resolve=>parser(req,resolve));await ended;return {req,error};
}
function observed(limit) {
  const snapshots=[];return {snapshots,storage:boundedMemoryStorage({totalBytes:limit,onChange:state=>snapshots.push(state)})};
}
function emptyOnFailure(result, snapshots) {
  assert.ok((result.req.files||[]).every(file=>!Buffer.isBuffer(file.buffer)));
  assert.equal(snapshots.at(-1).retainedBytes,0);assert.ok(snapshots.every(state=>state.retainedBytes>=0));
}

test('an aggregate cap stops two individually valid files before retaining their combined bytes',async()=>{
  const h=observed(10),result=await parsePacket(directParser(h.storage),multipart([Buffer.from('abcdef'),Buffer.from('ghijkl')]));
  assert.equal(result.error.code,'LIMIT_TOTAL_FILE_SIZE');emptyOnFailure(result,h.snapshots);
  assert.ok(Math.max(...h.snapshots.map(state=>state.peakBytes))<=10);
});

test('multiple originals at the combined boundary keep exact binary bytes, metadata and normal fields',async()=>{
  const h=observed(10),files=[Buffer.from([0,255,128,1,2,3]),Buffer.from([4,5,6,7])];
  const result=await parsePacket(directParser(h.storage),multipart(files));assert.equal(result.error,undefined);
  assert.equal(result.req.body.file_roles,'["plan","archive"]');assert.equal(result.req.files.length,2);
  files.forEach((buffer,index)=>{const file=result.req.files[index];assert.ok(file.buffer.equals(buffer));assert.equal(file.size,buffer.length);assert.equal(file.originalname,'original-'+index+'.pdf');assert.equal(file.mimetype,'application/pdf');});
  assert.ok(h.snapshots.every(state=>state.retainedBytes<=10));
  assert.equal(result.req.listenerCount('aborted'),0);
});

test('file-size and count rejections clear earlier buffer aliases as well as active chunks',async()=>{
  for(const [files,code]of [[[Buffer.alloc(13,1)],'LIMIT_FILE_SIZE'],[[Buffer.from('a'),Buffer.from('b'),Buffer.from('c')],'LIMIT_FILE_COUNT']]){
    const h=observed(30),result=await parsePacket(directParser(h.storage),multipart(files));assert.equal(result.error.code,code);emptyOnFailure(result,h.snapshots);
  }
});

test('field count, field size and part limits remain finite and do not drop declared fields silently',async()=>{
  for(const [fields,limits,code]of [
    [[['a','1'],['b','2'],['c','3']],{fields:2},'LIMIT_FIELD_COUNT'],
    [[['contacts','123456789']],{fieldSize:8},'LIMIT_FIELD_VALUE'],
    [[['a','1'],['b','2']],{parts:2},'LIMIT_PART_COUNT'],
  ]){
    const h=observed(30),result=await parsePacket(directParser(h.storage,limits),multipart([],fields));assert.equal(result.error.code,code);assert.equal((result.req.files||[]).length,0);
  }
});

test('repeated and concurrent multipart requests each receive a fresh aggregate budget',async()=>{
  const h=observed(10),parse=directParser(h.storage),packet=multipart([Buffer.from('abcdef'),Buffer.from('ghij')]);
  const results=await Promise.all([parsePacket(parse,packet),parsePacket(parse,packet)]);results.push(await parsePacket(parse,packet));
  for(const result of results){assert.equal(result.error,undefined);assert.equal(result.req.files.reduce((sum,file)=>sum+file.buffer.length,0),10);}
});

for(const disconnect of ['aborted','error'])test('a disconnected '+disconnect+' request releases completed originals and a partial file without invoking the handler',async()=>{
  const h=observed(30),packet=multipart([Buffer.from('first-exact'),Buffer.from('second-incomplete')]),req=new PassThrough();
  req.method='POST';req.headers={...packet.headers,'content-length':String(packet.body.length)};
  let callbacks=0;const parsed=new Promise(resolve=>directParser(h.storage)(req,error=>{callbacks++;resolve(error);}));
  const offset=packet.body.indexOf(Buffer.from('second-incomplete'))+4;req.write(packet.body.subarray(0,offset));await new Promise(resolve=>setImmediate(resolve));
  if(disconnect==='aborted'){req.aborted=true;req.emit('aborted');req.destroy();}else req.destroy(new Error('Synthetic disconnected upload'));
  const error=await parsed;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(error.code,'UPLOAD_ABORTED');assert.equal(callbacks,1);emptyOnFailure({req},h.snapshots);
});

test('malformed multipart input releases originals and unfinished chunks through the real parser',async()=>{
  const h=observed(30),packet=multipart([Buffer.from('first'),Buffer.from('second')]);
  packet.body=packet.body.subarray(0,packet.body.indexOf(Buffer.from('second'))+3);
  const result=await parsePacket(directParser(h.storage),packet);assert.ok(result.error);emptyOnFailure(result,h.snapshots);
});

function managerParser(options) {
  let parse;setupManagerOrders({get(){},post(path,middleware){if(path==='/api/order')parse=middleware;}},options);
  return async packet=>{
    const req=streamOf(packet,32),ended=finished(req).catch(()=>{});let called=false,reply;
    const res={status(value){this.statusCode=value;return this;},json(body){reply={status:this.statusCode,body};return this;}};
    await new Promise(resolve=>{const json=res.json;res.json=function(body){json.call(this,body);resolve();return this;};parse(req,res,()=>{called=true;resolve();});});await ended;
    return {req,called,reply};
  };
}

test('manager setup uses the bounded storage path and rejects combined bytes before its save handler',async()=>{
  const parse=managerParser({uploadLimits:{fileBytes:12,totalBytes:10,files:2}}),result=await parse(multipart([Buffer.from('abcdef'),Buffer.from('ghijkl')]));
  assert.equal(result.called,false);assert.equal(result.reply.status,413);assert.match(result.reply.body.error,/Общий объём.*100 МБ/);
  assert.ok(result.req.files.every(file=>!Buffer.isBuffer(file.buffer)));
});

test('normal manager fields and twenty originals remain supported by the actual default setup',async()=>{
  const values=[['address','А'.repeat(500)],['owner_name','Клиент'],['object_type','Общепит алкоголь'],['object_name','Объект'],['service','Получение'],['contacts','К'.repeat(4000)],['zones_info','З'.repeat(4000)],['deadline','2026-12-01'],['has_video','true'],['cad_num','77:01:0000001:12'],['archive_url',''],['submit_id','manager-intent'],['packet_revision','2'],['egrn_order','1'],['file_roles',JSON.stringify(Array(20).fill('plan'))]];
  const files=Array.from({length:20},(_,index)=>Buffer.from([0,255,index])),result=await managerParser()(multipart(files,values));
  assert.equal(result.called,true);assert.equal(result.reply,undefined);assert.equal(result.req.files.length,20);
  for(const [name,value]of values)assert.equal(result.req.body[name],value);
  files.forEach((file,index)=>assert.ok(result.req.files[index].buffer.equals(file)));
});

test('default manager setup allows all 64 fields and rejects an extra field or oversized text explicitly',async()=>{
  const parse=managerParser(),fields=Array.from({length:64},(_,index)=>['field_'+index,'value']);
  const valid=await parse(multipart([],fields));assert.equal(valid.called,true);assert.equal(Object.keys(valid.req.body).length,64);
  for(const values of [fields.concat([['extra','value']]),[['contacts','x'.repeat(64*1024+1)]]]){
    const invalid=await parse(multipart([],values));assert.equal(invalid.called,false);assert.equal(invalid.reply.status,413);assert.match(invalid.reply.body.error,/текста или полей/);
  }
});
