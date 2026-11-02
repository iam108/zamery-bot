const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const yauzl = require('yauzl');
const { presentationMedia, photoCaption, deliveryMedia, MAX_ARCHIVE_BYTES } = require('../src/bot/audit-delivery');
const { compactVisit, addOrganization } = require('./helpers/audit-v5');

const sha = value => createHash('sha256').update(value).digest('hex');
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => { for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function crc32(buffer) { let value = 0xffffffff; for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; }
function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on('error', reject); zip.on('end', () => resolve(entries));
      zip.on('entry', entry => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = []; stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            const content = Buffer.concat(chunks);
            try { assert.equal(content.length, entry.uncompressedSize); assert.equal(crc32(content), entry.crc32); assert.equal(entry.generalPurposeBitFlag & 0x800, 0x800); }
            catch (error) { zip.close(); reject(error); return; }
            entries.push({ name: entry.fileName, content }); zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
function fixture() {
  const data = addOrganization(compactVisit(), { id: 'org-4', code: 'О4', name: 'Учебный центр', status: 'licensed', source: 'Реестр лицензий, запись 123' });
  data.order_id = 64; data.inspection.floor_plan = '1'; data.plan.page = 6;
  data.map.annotations.push({ id: 'measure-1', code: 'М1', tool: 'route', fromEntranceId: 'entrance-1', toObjectId: 'org-4', distance: '12,5', points: [{ x: .2, y: .3 }, { x: .8, y: .4 }] });
  data.workflow.video_url = 'https://disk.yandex.ru/d/synthetic-video';
  data.workflow.documents = { egrn: 'Есть' };
  data.request_packet.materials = [{ id: 'manager-document', name: 'Исходная выписка.pdf', role: 'egrn', bytes: 393000000, url: '/api/audit/orders/64/materials/manager-document' }];
  data.documents = data.evidence.map((file, index) => ({ ...file, name: index === 2 || index === 5 ? 'Фото.jpg' : file.name, source: Buffer.from('unchanged original ' + index + ' ' + file.role) }));
  return data;
}

test('new presentation has one ordered image set and ZIP-only documents, while legacy media is unchanged', async () => {
  const data = fixture(), original = data.documents.map(file => file.source), packet = presentationMedia(data);
  assert.deepEqual(packet.photos.map(file => file.role), ['map', 'plan', 'entrance', 'zone']);
  assert.ok(packet.photos.every(file => Buffer.isBuffer(file.source) && file.data === undefined));
  assert.equal(packet.documents.length, 1); assert.equal(packet.documents[0].mime, 'application/zip');
  assert.match(packet.documents[0].name, /Отчёт-64-оригиналы\.zip$/);
  assert.equal(packet.documents[0].bytes, packet.documents[0].source.length);
  assert.equal(data.documents[0].data, undefined); original.forEach((bytes, index) => assert.equal(data.documents[index].source, bytes));
  const entries = await unzip(packet.documents[0].source), manifest = entries[0].content.toString('utf8');
  assert.match(entries[0].name, /Содержание отчёта\.txt$/);
  assert.equal(entries.length, original.length + 1); assert.equal(new Set(entries.map(file => file.name)).size, entries.length);
  assert.deepEqual(entries.slice(1).map(file => sha(file.content)).sort(), original.map(sha).sort());
  assert.match(manifest, /О4 · Учебный центр/); assert.match(manifest, /12,5 м/); assert.match(manifest, /Реестр лицензий, запись 123/);
  assert.match(manifest, /https:\/\/disk.yandex.ru\/d\/synthetic-video/); assert.match(manifest, /Исходная выписка.pdf/);
  assert.match(manifest, /"documents": \{\s+"egrn": "Есть"/);
  assert.doesNotMatch(manifest, /"source": \{|"type": "Buffer"|object_key|audit-originals|egrn-originals/);
  for (const file of data.documents) assert.match(manifest, new RegExp(sha(file.source)));
  assert.equal(deliveryMedia(data).documents, data.documents, 'Existing partial deliveries retain individual original documents');
});

test('photo captions use actual scheme codes, subjects, observed status and measured path without inventing compliance', () => {
  const data = fixture(), packet = presentationMedia(data);
  assert.match(packet.photos[0].caption, /^Схема территории/);
  assert.match(packet.photos[1].caption, /^План помещения · лист 6/);
  assert.match(packet.photos[2].caption, /В1 · Главный вход/);
  assert.match(packet.photos[3].caption, /О4 · Учебный центр/); assert.match(packet.photos[3].caption, /Есть сведения о лицензии/);
  assert.match(packet.photos[3].caption, /От В1: 12,5 м · по пути замера/); assert.doesNotMatch(packet.photos[3].caption, /лицензия действующая|зона отсутствует/i);
  data.entrances[0].label = 'Вход 1'; data.map.annotations[0].code = 'В3';
  assert.match(photoCaption(packet.photos[2], 64, data), /^В3 · Вход ·/); assert.doesNotMatch(photoCaption(packet.photos[2], 64, data), /Вход 1/);
  assert.equal(photoCaption({ role: 'map' }, 64), 'Карта и входы · отчёт по заявке #64');
});

test('the main marked plan precedes extra sheets and extra captions do not borrow the main floor', () => {
  const data = fixture();
  data.additional_plans = [{ id: 'extra-b', page: 2 }, { id: 'extra-a', page: 3 }];
  data.documents.push({ id: 'second', role: 'plan', subject_id: 'annotation-extra-a', mime: 'image/png', name: 'А-доп.png', source: Buffer.from('second extra') }, { id: 'first', role: 'plan', subject_id: 'annotation-extra-b', mime: 'image/png', name: 'Б-доп.png', source: Buffer.from('first extra') });
  const plans = presentationMedia(data).photos.filter(file => file.role === 'plan');
  assert.deepEqual(plans.map(file => file.subject_id), ['annotation', 'annotation-extra-b', 'annotation-extra-a']);
  assert.match(plans[0].caption, /Этаж на плане: 1/); assert.match(plans[1].caption, /лист 2/); assert.match(plans[2].caption, /лист 3/);
  assert.doesNotMatch(plans[1].caption + plans[2].caption, /Этаж на плане/);
});

test('ZIP part bytes and names are deterministic when the server returns original documents in another order', () => {
  const data = fixture(), first = presentationMedia(data), shuffled = presentationMedia({ ...data, documents: [...data.documents].reverse() });
  assert.deepEqual(first.photos.map(file => file.id), shuffled.photos.map(file => file.id));
  assert.deepEqual(first.documents.map(file => file.name), shuffled.documents.map(file => file.name));
  first.documents.forEach((file, i) => assert.ok(file.source.equals(shuffled.documents[i].source)));
});

test('ZIP splitting includes UTF-8 headers and readable manifests in the exact byte limit', async () => {
  const data = fixture(); data.documents.forEach((file, index) => { file.source = Buffer.alloc(1500, index + 1); file.name = 'Совпадающее имя — №.png'; });
  const maximum = 8500, packet = presentationMedia(data, { maxArchiveBytes: maximum, summaryText: 'Короткий итог' });
  assert.ok(packet.documents.length > 1);
  const decoded = [];
  for (const [index, archive] of packet.documents.entries()) {
    assert.ok(archive.source.length <= maximum); assert.match(archive.name, new RegExp('-' + (index + 1) + '-из-' + packet.documents.length + '\\.zip$'));
    const entries = await unzip(archive.source); assert.match(entries[0].content.toString('utf8'), new RegExp('Часть ' + (index + 1) + ' из ' + packet.documents.length)); decoded.push(...entries.slice(1));
  }
  assert.deepEqual(decoded.map(file => sha(file.content)).sort(), data.documents.map(file => sha(file.source)).sort());
});

test('a ZIP fits an exact boundary and a smaller limit fails before any original could be dropped', () => {
  const data = fixture(); data.documents = [data.documents[0]];
  const one = presentationMedia(data, { summaryText: 'Итог' }).documents[0];
  assert.equal(presentationMedia(data, { maxArchiveBytes: one.source.length, summaryText: 'Итог' }).documents[0].source.length, one.source.length);
  assert.throws(() => presentationMedia(data, { maxArchiveBytes: one.source.length - 1, summaryText: 'Итог' }), /не помещается/);
});

test('part manifests remain within the cap when the number of ZIP parts needs two digits', async () => {
  const data = { ui_version: 5, order_id: 64, inspection: {}, workflow: {}, documents: Array.from({ length: 15 }, (_, index) => ({ id: String(index), name: 'Оригинал-' + index + '.pdf', role: 'document', mime: 'application/pdf', source: Buffer.alloc(500, index) })) };
  const maximum = 1700, packet = presentationMedia(data, { maxArchiveBytes: maximum, summaryText: 'Итог' });
  assert.ok(packet.documents.length >= 10);
  let count = 0;
  for (const archive of packet.documents) { assert.ok(archive.source.length <= maximum); count += (await unzip(archive.source)).length - 1; }
  assert.equal(count, 15);
});

test('images over the preview threshold and unsupported preview formats stay complete in the originals ZIP', async () => {
  const data = fixture();
  data.documents.push({ id: 'large', name: 'Большое фото.jpg', role: 'interior', mime: 'image/jpeg', source: Buffer.alloc(10 * 1024 * 1024 + 1, 53) }, { id: 'heic', name: 'Телефон.heic', role: 'interior', mime: 'image/heic', source: Buffer.from('unmodified heic original') });
  const packet = presentationMedia(data); assert.ok(!packet.photos.some(file => ['large', 'heic'].includes(file.id)));
  const decoded = await unzip(packet.documents[0].source);
  for (const id of ['large', 'heic']) { const original = data.documents.find(file => file.id === id); assert.ok(decoded.some(file => sha(file.content) === sha(original.source))); }
});

test('multiple images of one subject are numbered without changing the recorded subject or its files', () => {
  const data = fixture(), entry = data.documents.find(file => file.role === 'entrance');
  data.documents.push({ ...entry, id: 'more', name: 'Ещё фото.jpg', source: Buffer.from('another photo of same entrance') });
  const photos = presentationMedia(data).photos.filter(file => file.role === 'entrance');
  assert.equal(photos.length, 2); assert.match(photos[0].caption, /Фото 1 из 2/); assert.match(photos[1].caption, /Фото 2 из 2/);
  assert.equal(data.entrances[0].label, 'Главный вход');
});

test('invalid source hashes, overlarge files and attempts to raise the Telegram archive cap are rejected', () => {
  const data = fixture(); data.documents[0].sha256 = '0'.repeat(64);
  assert.throws(() => presentationMedia(data), /изменился/);
  delete data.documents[0].sha256; data.documents[0].source = Buffer.alloc(12 * 1024 * 1024 + 1);
  assert.throws(() => presentationMedia(data), /12 МБ/);
  assert.throws(() => presentationMedia(fixture(), { maxArchiveBytes: MAX_ARCHIVE_BYTES + 1 }), /предельный размер/);
  assert.throws(() => presentationMedia({ ...fixture(), documents: Array.from({ length: 61 }, () => ({ source: Buffer.from('x') })) }), /60 оригиналов/);
  const shared = Buffer.alloc(12 * 1024 * 1024);
  assert.throws(() => presentationMedia({ ...fixture(), documents: Array.from({ length: 9 }, (_, id) => ({ id, name: 'file.pdf', role: 'document', mime: 'application/pdf', source: shared })) }), /100 МБ/);
});

test('a maximum 100 MiB packet has bounded ZIP parts, retains all originals and stays below 512 MiB peak RSS', { timeout: 60000 }, () => {
  const code = `
    const assert = require('node:assert/strict');
    const { presentationMedia, MAX_ARCHIVE_BYTES } = require(${JSON.stringify(require.resolve('../src/bot/audit-delivery'))});
    const data = { ui_version:5, order_id:64, inspection:{}, workflow:{}, documents:Array.from({length:25},(_,i)=>({id:String(i),name:'Фото-'+i+'.jpg',role:'interior',mime:'image/jpeg',source:Buffer.alloc(4*1024*1024,i)})) };
    const start=Date.now(), packet=presentationMedia(data,{summaryText:'Максимальный проверочный комплект'});
    assert.equal(packet.photos.length,25); assert.ok(packet.documents.length>1); assert.ok(packet.documents.every(file=>file.source.length<=MAX_ARCHIVE_BYTES));
    assert.ok(packet.photos.every(file=>Buffer.isBuffer(file.source)&&file.data===undefined));
    const yauzl=require(${JSON.stringify(require.resolve('yauzl'))}), crypto=require('node:crypto');
    const expected=data.documents.map(file=>crypto.createHash('sha256').update(file.source).digest('hex')).sort();
    const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
    (async()=>{
      const received=[];
      for(const archive of packet.documents) await new Promise((resolve,reject)=>yauzl.fromBuffer(archive.source,{lazyEntries:true,validateEntrySizes:true},(error,zip)=>{
        if(error)return reject(error);let index=0;zip.on('error',reject);zip.on('end',resolve);
        zip.on('entry',entry=>zip.openReadStream(entry,(error,stream)=>{
          if(error)return reject(error);const digest=crypto.createHash('sha256');let crc=0xffffffff,bytes=0;const manifest=index++===0;
          stream.on('error',reject);stream.on('data',chunk=>{digest.update(chunk);bytes+=chunk.length;for(const byte of chunk)crc=table[(crc^byte)&255]^(crc>>>8);});
          stream.on('end',()=>{try{assert.equal(bytes,entry.uncompressedSize);assert.equal((crc^0xffffffff)>>>0,entry.crc32);if(!manifest)received.push(digest.digest('hex'));zip.readEntry();}catch(error){zip.close();reject(error);}});
        }));zip.readEntry();
      }));
      assert.deepEqual(received.sort(),expected);
      const rss=process.resourceUsage().maxRSS*1024;
      console.log(JSON.stringify({elapsedMs:Date.now()-start,peakRss:rss,parts:packet.documents.length,bytes:packet.documents.reduce((n,f)=>n+f.source.length,0),originalsVerified:received.length}));
      assert.ok(rss<512*1024*1024,'The complete 100 MiB presentation must fit within 512 MiB RSS');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const output = execFileSync(process.execPath, ['--max-old-space-size=192', '-e', code], { encoding: 'utf8', timeout: 55000 });
  const metrics = JSON.parse(output.trim()); assert.ok(metrics.bytes >= 100 * 1024 * 1024); assert.ok(metrics.parts <= 3);
  console.log('100 MiB presentation resource check:', metrics);
});
