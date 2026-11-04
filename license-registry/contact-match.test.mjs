import test from 'node:test';
import assert from 'node:assert/strict';
import {planContactEnrichment,parseContactRequest,normalizeContactPhone,normalizeContactTelegram} from './contact-match.mjs';

const INN='9705148570';
const ADDRESS='Москва, ул. Пушкина, д. 1, этаж 1, помещ. 2';
const person={name:'Иван Иванов',phone:'8 (999) 123-45-67',tg:'@ivan_ivanov'};
const row=(changes={})=>({rowNumber:504,inn:INN,address:ADDRESS,values:Array(17).fill(''),...changes});
const source=(changes={})=>({id:10,request_id:20,order_id:30,inn:INN,address:ADDRESS,contacts:[person],...changes});
const plan=(r=row(),cases=[source()])=>planContactEnrichment({row:r,cases});

test('unique same-object case fills only blank M/N/O and keeps provenance without a sales-role inference',()=>{
  const result=plan();assert.equal(result.action,'update');
  assert.deepEqual(result.updates,[{row:504,column:'M',before:'',after:'Иван Иванов'},
    {row:504,column:'N',before:'',after:'+79991234567'},{row:504,column:'O',before:'',after:'https://t.me/ivan_ivanov'}]);
  assert.deepEqual(result.provenance,[{caseId:10,requestId:20,orderId:30,source:'case_contacts'}]);
  assert.equal(result.candidate.role,'unspecified');assert.equal(result.candidate.salesContactConfirmed,false);
});

test('INN plus exact normalized object address excludes other-company and other-object contacts',()=>{
  const cases=[source({id:1,address:'Москва, улица Пушкина, дом 1, этаж 1, помещение 2'}),
    source({id:2,address:'Москва, ул. Пушкина, д. 1, этаж 2, пом. 2',contacts:[{name:'Анна',phone:'89990000001'}]}),
    source({id:3,inn:'7736274613',contacts:[{name:'Ольга',phone:'89990000002'}]})];
  assert.equal(plan(row(),cases).action,'update');assert.equal(plan(row(),cases).provenance.length,1);
  assert.equal(plan(row(),[cases[1]]).reason,'contact_source_not_found');
  assert.equal(plan(row(),[cases[2]]).reason,'contact_source_not_found');
});

test('identical normalized tuples across cases dedupe without choosing a latest case',()=>{
  const cases=[source(),source({id:11,created_at:'2099-01-01',contacts:[{name:'иван иванов',phone:'+7 999 1234567',tg:'https://t.me/Ivan_Ivanov/'}]})];
  const result=plan(row(),cases);assert.equal(result.action,'update');assert.equal(result.provenance.length,2);
  assert.deepEqual(result.provenance.map(p=>p.caseId),[10,11]);
});

test('same INN/object with different contacts is review even if one case is newer',()=>{
  const cases=[source(),source({id:11,created_at:'2099-01-01',contacts:[{name:'Анна',phone:'89990000001',tg:'@anna_user'}]})];
  assert.equal(plan(row(),cases).reason,'contact_source_ambiguous');
  assert.deepEqual(plan(row(),cases).updates,[]);
  assert.equal(plan(row(),[source({contacts:[person,{...person,name:'Анна'}]})]).reason,'contact_source_ambiguous');
});

test('existing phone selects one matching tuple; name and Telegram stay from that same person',()=>{
  const values=Array(17).fill('');values[13]='+79991234567';
  const result=plan(row({values}),[source({contacts:[person,{name:'Анна',phone:'89990000001',tg:'@anna_user'}]})]);
  assert.equal(result.action,'update');assert.deepEqual(result.updates.map(u=>u.column),['M','O']);
  assert.equal(result.candidate.name,'Иван Иванов');
});

test('conflicting filled destination cells are preserved and never mixed with another contact',()=>{
  const values=Array(17).fill('');values[12]='Анна';values[13]='+79991234567';
  const result=plan(row({values}),[source({contacts:[person,{name:'Анна',phone:'89990000001',tg:'@anna_user'}]})]);
  assert.equal(result.reason,'contact_existing_conflict');assert.deepEqual(result.updates,[]);
  assert.equal(values[12],'Анна');assert.equal(values[13],'+79991234567');
  values[13]='не звонить';assert.equal(plan(row({values})).reason,'contact_existing_value_unverified');
});

test('all populated contact fields produce noop and are never replaced',()=>{
  const values=Array(17).fill('');values[12]='Существующий';values[13]='текст сотрудника';values[14]='ссылка сотрудника';
  assert.equal(plan(row({values}),[]).action,'noop');assert.deepEqual(plan(row({values}),[]).updates,[]);
});

test('valid legacy client/phone fallback works only when structured contacts are empty',()=>{
  const result=plan(row(),[source({contacts:[],client:'Иван Иванов',phone:'89991234567'})]);
  assert.equal(result.action,'update');assert.equal(result.provenance[0].source,'case_legacy');
  assert.deepEqual(result.updates.map(u=>u.column),['M','N']);
  const structured=plan(row(),[source({client:'Другой',phone:'89990000001'})]);
  assert.equal(structured.candidate.name,'Иван Иванов');
  assert.equal(plan(row(),[source({contacts:[],contacts_text:'Иван 89991234567',author_id:123,submitted_by:123})]).reason,'contact_source_empty');
});

test('invalid source tuples do not silently disappear in favor of another contact',()=>{
  assert.equal(plan(row(),[source({contacts:[person,{name:'Анна',phone:'неизвестен'}]})]).reason,'contact_source_invalid');
  assert.equal(plan(row(),[source({contacts:'private free text'})]).reason,'contact_source_invalid');
  assert.equal(plan(row(),[source({id:null})]).reason,'contact_source_invalid');
  assert.equal(plan(row(),[source({contacts:[{name:'=IMPORTDATA("x")',phone:'89991234567'}]})]).reason,'contact_source_invalid');
});

test('explicit onsite/staff roles are not promoted into generic client or sales contacts',()=>{
  for(const role of ['auditor','staff','submitter','site_contact','контакт для выезда']){
    const result=plan(row(),[source({contacts:[{...person,role}]})]);
    assert.equal(result.reason,'contact_role_not_client');assert.deepEqual(result.updates,[]);
  }
  assert.equal(plan(row(),[source({contacts:[{...person,role:'client'}]})]).candidate.salesContactConfirmed,false);
});

test('missing/invalid identity and absent sources never select a contact',()=>{
  assert.equal(plan(row({inn:'9705148571'})).reason,'contact_inn_invalid');
  assert.equal(plan(row({inn:''})).reason,'contact_inn_invalid');
  assert.equal(plan(row({address:''})).reason,'contact_object_address_required');
  assert.equal(plan(row({rowNumber:1})).reason,'contact_row_required');
  assert.equal(plan(row(),[]).reason,'contact_source_not_found');
  assert.equal(planContactEnrichment({row:row()}).reason,'contact_sources_required');
});

test('phone and Telegram normalization accept specific contacts and reject unsafe links or formulas',()=>{
  assert.equal(normalizeContactPhone('8(999)1234567'),'+79991234567');
  assert.equal(normalizeContactPhone('9991234567'),'+79991234567');
  assert.equal(normalizeContactPhone('+44 1234 5678'),'+4412345678');
  for(const value of ['+79991234567 доб. 1','=79991234567','123',79991234567])assert.equal(normalizeContactPhone(value),null);
  assert.equal(normalizeContactTelegram('@Some_User'),'https://t.me/some_user');
  assert.equal(normalizeContactTelegram('https://t.me/Some_User/'),'https://t.me/some_user');
  for(const value of ['http://t.me/some_user','https://evil.t.me/some_user','https://t.me/some_user?start=abc',
    'https://t.me/some_user/22','https://t.me/+join','https://t.me/share','https://x:t@t.me/some_user','=HYPERLINK("x")'])assert.equal(normalizeContactTelegram(value),null);
});

const requestText=['📩 Новая форма заполнена:','Имя клиента: Иван Иванов','Номер: 8 (999) 123-45-67',
  'Наименование организации: ООО «Хорошот»',`ИНН: ${INN}`,`Адрес лицензирования: ${ADDRESS}`,'Telegram: @ivan_ivanov'].join('\n');

test('explicit incoming unassigned form becomes a matching source with request provenance',()=>{
  const parsed=parseContactRequest({id:42,text:requestText,created_at:'2026-11-04T10:00:00Z',author_id:777});
  assert.equal(parsed.status,'ready');assert.equal(parsed.source.inn,INN);assert.equal(parsed.source.org,'ООО «Хорошот»');
  assert.deepEqual(parsed.source.contacts,[{name:'Иван Иванов',phone:'+79991234567',tg:'https://t.me/ivan_ivanov'}]);
  const result=plan(row(),[parsed.source]);assert.equal(result.action,'update');
  assert.deepEqual(result.provenance,[{caseId:null,requestId:42,orderId:null,source:'incoming_request'}]);
  assert.ok(!JSON.stringify(result).includes('777'));
});

test('incoming source never guesses a missing client field from arbitrary author or phone',()=>{
  assert.equal(parseContactRequest({id:1,text:'Иван 89991234567'}),null);
  for(const field of ['Имя клиента: Иван Иванов\n','Номер: 8 (999) 123-45-67\n','Наименование организации: ООО «Хорошот»\n',`ИНН: ${INN}\n`,`Адрес лицензирования: ${ADDRESS}\n`]){
    const parsed=parseContactRequest({id:1,text:requestText.replace(field,''),author:'Иван',author_id:777});
    assert.equal(parsed.status,'review');
  }
});

test('multiple INNs, organizations, explicit client fields or phones in an incoming request are review',()=>{
  for(const suffix of ['\nИНН: 7736274613','\nДругое ООО «Компания»','\nИмя клиента: Анна',
    '\nТелефон 2: +79990000001','\nКомментарий: звонить также +90 555 555 55 55']){
    assert.equal(parseContactRequest({id:1,text:requestText+suffix}).status,'review');
  }
  assert.equal(parseContactRequest({id:1,text:requestText.replace(INN,'9705148571')}).reason,'contact_request_inn_invalid');
  assert.equal(parseContactRequest({id:1,text:requestText.replace('@ivan_ivanov','https://evil.example/ivan')}).status,'review');
});

test('matching request and handoff contact dedupe while different sources remain ambiguous',()=>{
  const incoming=parseContactRequest({id:42,text:requestText}).source;
  const result=plan(row(),[incoming,source()]);assert.equal(result.action,'update');assert.equal(result.provenance.length,2);
  const different=parseContactRequest({id:43,text:requestText.replace('Иван Иванов','Анна').replace('123-45-67','000-00-01').replace('ivan_ivanov','anna_user')}).source;
  assert.equal(plan(row(),[incoming,different]).reason,'contact_source_ambiguous');
});

test('numeric or non-string populated cells are never treated as empty destinations',()=>{
  const values=Array(17).fill('');values[13]=79991234567;
  const result=plan(row({values}));assert.equal(result.action,'update');assert.deepEqual(result.updates.map(u=>u.column),['M','O']);
  values[13]=0;assert.equal(plan(row({values})).reason,'contact_existing_value_unverified');
  values[13]={formulaValue:'=1'};assert.equal(plan(row({values})).reason,'contact_existing_value_unverified');
});

test('incoming client forms accept explicit organization INN and object address labels',()=>{
  const text=['Новая форма заполнена','Имя клиента: Иван Иванов','Номер: +79991234567',
    'Наименование организации: ООО Тест',`ИНН организации: ${INN}`,`Адрес объекта: ${ADDRESS}`].join('\n');
  const parsed=parseContactRequest({id:31,text});assert.equal(parsed.status,'ready');
  assert.equal(parsed.source.inn,INN);assert.equal(parsed.source.address,ADDRESS);
  assert.equal(planContactEnrichment({row:row(),cases:[parsed.source]}).action,'update');
});
