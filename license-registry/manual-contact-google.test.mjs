import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleSheetsClient,REGISTRY_HEADERS} from './google.mjs';
import {prepareManualContactPlan,applyManualContactPlan,verifyManualContactPlan} from './manual-contact-google.mjs';

const identity={rowNumber:2,inn:'9721255266',licenseNumber:'77РПО0021046',issueDate:'2026-04-17',expiryDate:'2029-04-16',
  address:'Москва, пер. Большой Толмачёвский, д. 5, стр. 4, этажи 1/-1'};
const auth={reviewId:'a'.repeat(64),ownerChatId:42,sourceMessageId:99};
const person={name:'Анна Иванова',phone:'+79990000001'};
const copy=(value)=>structuredClone(value);
function fixture({empty=false,blankLicense=false}={}){
  const row=Array(17).fill('');Object.assign(row,{0:'PRIVATE_ROW_ANCHOR_A',4:'ООО «СВЕРТЭ»',6:identity.inn,
    7:blankLicense?'':identity.licenseNumber,8:identity.issueDate,9:identity.expiryDate,10:'Общепит ',11:identity.address,
    12:empty?'':'Прежний контакт',13:empty?'':'+78880000000',14:'https://t.me/original_chat',15:'keep@example.test',16:'Комментарий сотрудника'});
  const values=[[...REGISTRY_HEADERS],row];const overrides=new Map();const calls=[];const batches=[];const controls={};let rowReads=0;
  const google=new GoogleSheetsClient({spreadsheetId:'manual-contacts-fixture',sheetName:'Реестр лицензий',sheetId:0,
    now:()=>new Date('2026-11-05T12:00:00.000Z')});
  const properties={sheetId:0,title:google.sheetName,gridProperties:{rowCount:100,columnCount:17}};
  const metadata={spreadsheetId:google.spreadsheetId,sheets:[{properties}]};
  google.request=async(suffix='',options={})=>{
    calls.push({suffix,options:copy(options)});
    if(suffix===':batchUpdate'){
      batches.push(copy(options.body));
      for(const item of options.body.requests){
        const change=item.updateCells;assert.ok(change);assert.equal(change.fields,'userEnteredValue');
        assert.ok([12,13,14].includes(change.start.columnIndex));
        const value=change.rows[0].values[0].userEnteredValue;assert.deepEqual(Object.keys(value),['stringValue']);
        assert.equal(typeof value.stringValue,'string');values[change.start.rowIndex][change.start.columnIndex]=value.stringValue;
      }
      controls.afterBatch?.();return {};
    }
    if(suffix.startsWith('/values/'))return {values:copy(values)};
    if(options.query?.ranges){
      rowReads++;controls.beforeRead?.(rowReads);const number=Number(options.query.ranges.match(/!A(\d+):/u)[1]);
      return {...copy(metadata),sheets:[{properties,data:[{startRow:number-1,startColumn:0,rowData:[{
        values:(values[number-1]??[]).map((value,index)=>({...value===''?{}:{formattedValue:value,userEnteredValue:{stringValue:value}},
          ...copy(overrides.get(`${number}:${index}`)??{})}))}]}]}]};
    }
    return copy(metadata);
  };
  return {google,row,values,overrides,calls,batches,controls,input:{...identity,licenseNumber:blankLicense?'':identity.licenseNumber,
    contact:copy(person),authorization:copy(auth)}};
}

test('preview records before/after and replacement requires confirmation, then changes only explicit M/N strings',async()=>{
  const h=fixture();const original=copy(h.row);const plan=await prepareManualContactPlan(h.google,h.input);
  assert.equal(plan.needsConfirmation,true);assert.deepEqual(plan.before,{M:original[12],N:original[13],O:original[14]});
  assert.deepEqual(plan.after,{M:person.name,N:person.phone,O:original[14]});assert.deepEqual(plan.updates.map((u)=>u.column),['M','N']);
  assert.equal(plan.authorization.ownerChatId,'42');assert.equal(plan.authorization.sourceMessageId,'99');
  await assert.rejects(applyManualContactPlan(h.google,plan),{code:'manual_contact_confirmation_required'});
  await assert.rejects(applyManualContactPlan(h.google,plan,{confirmed:'true'}),{code:'manual_contact_confirmation_required'});
  assert.equal(h.batches.length,0);
  const receipt=await applyManualContactPlan(h.google,plan,{confirmed:true});
  assert.equal(receipt.verified,true);assert.equal(receipt.planHash,plan.hash);assert.deepEqual(receipt.appliedCells,['M2','N2']);
  assert.deepEqual(receipt.cells,plan.expectedCells);assert.equal(h.batches.length,1);assert.equal(h.batches[0].requests.length,2);
  for(let index=0;index<17;index++)if(![12,13].includes(index))assert.equal(h.row[index],original[index]);
});

test('new values in empty M/N do not require extra confirmation and absent Telegram preserves O',async()=>{
  const h=fixture({empty:true});const plan=await prepareManualContactPlan(h.google,h.input);
  assert.equal(plan.needsConfirmation,false);assert.equal(plan.after.O,'https://t.me/original_chat');
  assert.equal((await applyManualContactPlan(h.google,plan)).verified,true);assert.equal(h.row[14],'https://t.me/original_chat');
});

test('supplied Telegram is an explicit change and a filled O requires confirmation',async()=>{
  const h=fixture();h.row[12]=person.name;h.row[13]=person.phone;
  const plan=await prepareManualContactPlan(h.google,{...h.input,contact:{...person,telegram:'https://t.me/new_chat'}});
  assert.deepEqual(plan.updates.map((u)=>u.column),['O']);assert.equal(plan.needsConfirmation,true);
  await applyManualContactPlan(h.google,plan,{confirmed:true});assert.equal(h.row[14],'https://t.me/new_chat');
  assert.equal(h.batches[0].requests[0].updateCells.start.columnIndex,14);
});

test('matching existing values resolve as a no-op with no confirmation or write',async()=>{
  const h=fixture();const plan=await prepareManualContactPlan(h.google,{...h.input,contact:{name:h.row[12],phone:h.row[13]}});
  assert.equal(plan.needsConfirmation,false);assert.deepEqual(plan.updates,[]);
  assert.equal((await applyManualContactPlan(h.google,plan)).action,'noop');assert.equal(h.batches.length,0);
});

test('formulas and notes on changed targets cannot be overwritten even after an owner confirmation',async()=>{
  for(const cell of[{userEnteredValue:{formulaValue:'="+78880000000"'}},{note:'Не менять телефон'},{note:' '}]){
    const h=fixture();h.overrides.set('2:13',cell);
    await assert.rejects(prepareManualContactPlan(h.google,h.input),{code:'manual_contact_cell_protected'});assert.equal(h.batches.length,0);
  }
});

test('an omitted Telegram column can retain an existing formula unchanged while M/N are replaced',async()=>{
  const h=fixture();h.overrides.set('2:14',{formattedValue:'Клиентский чат',userEnteredValue:{formulaValue:'=HYPERLINK("https://t.me/original_chat","Клиентский чат")'}});
  const plan=await prepareManualContactPlan(h.google,h.input);assert.equal(plan.after.O,'Клиентский чат');
  const receipt=await applyManualContactPlan(h.google,plan,{confirmed:true});assert.equal(receipt.cells.O2,'Клиентский чат');
  assert.ok(h.batches[0].requests.every((request)=>request.updateCells.start.columnIndex!==14));
});

test('any changed contact after preview, including an omitted O, requires a fresh preview',async()=>{
  const h=fixture();const plan=await prepareManualContactPlan(h.google,h.input);h.row[14]='https://t.me/human_edit';
  await assert.rejects(applyManualContactPlan(h.google,plan,{confirmed:true}),{code:'manual_contact_plan_stale'});
  await assert.rejects(verifyManualContactPlan(h.google,plan),{code:'manual_contact_readback_pending',reason:'manual_contact_plan_stale'});
  assert.equal(h.batches.length,0);
});

test('an edit during the second preflight and a changed non-contact row field both prevent mutation',async()=>{
  const h=fixture();const plan=await prepareManualContactPlan(h.google,h.input);
  h.controls.beforeRead=(count)=>{if(count===3)h.row[13]='+77770000000';};
  await assert.rejects(applyManualContactPlan(h.google,plan,{confirmed:true}),{code:'manual_contact_plan_stale'});assert.equal(h.batches.length,0);
  const changed=fixture();const second=await prepareManualContactPlan(changed.google,changed.input);changed.row[16]='Новый комментарий';
  await assert.rejects(applyManualContactPlan(changed.google,second,{confirmed:true}),{code:'manual_contact_plan_stale'});assert.equal(changed.batches.length,0);
});

test('duplicate active rows require an explicit integer row and that selected snapshot cannot move',async()=>{
  const h=fixture({blankLicense:true});const duplicate=copy(h.row);duplicate[0]='PRIVATE_ROW_ANCHOR_B';h.values.push(duplicate);
  await assert.rejects(prepareManualContactPlan(h.google,h.input),{code:'manual_contact_row_ambiguous'});
  await assert.rejects(prepareManualContactPlan(h.google,{...h.input,authorization:{...auth,explicitRow:true}}),{code:'manual_contact_plan_invalid'});
  const selected=await prepareManualContactPlan(h.google,{...h.input,authorization:{...auth,explicitRow:2}});
  [h.values[1],h.values[2]]=[h.values[2],h.values[1]];
  await assert.rejects(applyManualContactPlan(h.google,selected,{confirmed:true}),{code:'manual_contact_plan_stale'});assert.equal(h.batches.length,0);
  const chosen=await prepareManualContactPlan(h.google,{...h.input,authorization:{...auth,explicitRow:2}});
  assert.equal((await applyManualContactPlan(h.google,chosen,{confirmed:true})).verified,true);
  assert.equal(h.values[1][12],person.name);assert.equal(h.values[2][12],'Прежний контакт');assert.equal(h.values[1][7],'');
});

test('an unknown committed batch is completed by read-only verification without another write',async()=>{
  const h=fixture();const plan=await prepareManualContactPlan(h.google,h.input);
  h.controls.afterBatch=()=>{throw new Error('unknown_batch_commit');};
  await assert.rejects(applyManualContactPlan(h.google,plan,{confirmed:true}),{code:'manual_contact_write_unconfirmed'});
  const receipt=await verifyManualContactPlan(h.google,plan);
  assert.equal(receipt.verified,true);assert.equal(receipt.action,'noop');assert.equal(receipt.planHash,plan.hash);
  assert.deepEqual(receipt.cells,plan.expectedCells);assert.equal(h.batches.length,1);
  assert.equal((await applyManualContactPlan(h.google,plan,{confirmed:true})).action,'noop');assert.equal(h.batches.length,1);
});

test('read-only pending is retryable only while the full preview snapshot is unchanged',async()=>{
  const h=fixture();const plan=await prepareManualContactPlan(h.google,h.input);
  await assert.rejects(verifyManualContactPlan(h.google,plan),(error)=>error.code==='manual_contact_readback_pending'&&error.reason===undefined);
  assert.equal(h.batches.length,0);
  h.row[12]=person.name;
  await assert.rejects(verifyManualContactPlan(h.google,plan),{code:'manual_contact_readback_pending',reason:'manual_contact_plan_stale'});
  await assert.rejects(applyManualContactPlan(h.google,plan,{confirmed:true}),{code:'manual_contact_plan_stale'});assert.equal(h.batches.length,0);
});

test('invalid authorization, wrong review identity and plan tampering cannot authorize replacement',async()=>{
  const h=fixture();
  for(const authorization of[{...auth,reviewId:'bad'},{...auth,ownerChatId:-42},{...auth,sourceMessageId:0},{...auth,explicitRow:3}]){
    await assert.rejects(prepareManualContactPlan(h.google,{...h.input,authorization}),{code:'manual_contact_plan_invalid'});
  }
  await assert.rejects(prepareManualContactPlan(h.google,{...h.input,inn:'9705148570',authorization:{...auth,explicitRow:2}}),{code:'manual_contact_identity_changed'});
  const plan=await prepareManualContactPlan(h.google,h.input);plan.needsConfirmation=false;
  await assert.rejects(applyManualContactPlan(h.google,plan,{confirmed:true}),{code:'manual_contact_plan_invalid'});assert.equal(h.batches.length,0);
});

test('two validated people retain their order in multiline M/N string values and full readback',async()=>{
  const h=fixture();const contact={name:' Сергей \n Алёна ',phone:'+7 (999) 111-22-33\n8 (888) 444-55-66',
    persons:[{name:'Сергей',phone:'79991112233'},{name:'Алёна',phone:'+78884445566'}]};
  const plan=await prepareManualContactPlan(h.google,{...h.input,contact});
  assert.deepEqual(plan.contact.persons,[{name:'Сергей',phone:'+79991112233'},{name:'Алёна',phone:'+78884445566'}]);
  assert.equal(plan.after.M,'Сергей\nАлёна');assert.equal(plan.after.N,'+79991112233\n+78884445566');
  assert.equal(plan.after.O,'https://t.me/original_chat');assert.equal(plan.needsConfirmation,true);
  const result=await applyManualContactPlan(h.google,plan,{confirmed:true});
  assert.equal(h.row[12],'Сергей\nАлёна');assert.equal(h.row[13],'+79991112233\n+78884445566');
  assert.equal(result.cells.M2,plan.after.M);assert.equal(result.cells.N2,plan.after.N);assert.deepEqual(result.cells,plan.expectedCells);
  assert.deepEqual(result.appliedCells,['M2','N2']);assert.equal(h.batches[0].requests.length,2);
  assert.equal(h.batches[0].requests[1].updateCells.rows[0].values[0].userEnteredValue.stringValue,plan.after.N);
});

test('paired LF fields can supply up to five people without persons and single-person shape remains compatible',async()=>{
  const h=fixture({empty:true});const people=Array.from({length:5},(_,index)=>({name:['Иван','Борис','Анна','Алёна','Сергей'][index],phone:`+7999000000${index+1}`}));
  const plan=await prepareManualContactPlan(h.google,{...h.input,contact:{name:people.map((p)=>p.name).join('\n'),phone:people.map((p)=>p.phone).join('\n')}});
  assert.deepEqual(plan.contact.persons,people);assert.equal(plan.needsConfirmation,false);
  assert.equal((await applyManualContactPlan(h.google,plan)).verified,true);assert.equal(h.row[12].split('\n').length,5);
  const single=fixture();const one=await prepareManualContactPlan(single.google,{...single.input,contact:{name:' Анна  Иванова ',phone:'8 (999) 000-00-01'}});
  assert.deepEqual(one.contact,{name:'Анна Иванова',phone:'+79990000001'});
});

test('mismatched persons, swapped labels, unpaired lines, excess people and other controls fail before reading Google',async()=>{
  const pair={name:'Сергей\nАлёна',phone:'+79990000001\n+79990000002'};
  for(const contact of[
    {...pair,persons:[{name:'Алёна',phone:'+79990000002'},{name:'Сергей',phone:'+79990000001'}]},
    {...pair,persons:[{name:'Сергей',phone:'+79990000001'}]},
    {...pair,persons:[{name:'Сергей',phone:'+79990000002'},{name:'Алёна',phone:'+79990000001'}]},
    {...pair,persons:null},{...pair,phone:'+79990000001'},{...pair,name:'Сергей\n\nАлёна'},
    {...pair,name:'Сергей\r\nАлёна'},{...pair,name:'Сергей\t\nАлёна'},
    {...pair,persons:[{name:'Сергей\nАлёна',phone:'+79990000001'},{name:'Алёна',phone:'+79990000002'}]},
    {name:Array(6).fill('Сергей').join('\n'),phone:Array(6).fill('+79990000001').join('\n')},
    {...pair,persons:[{name:'Сергей',phone:'+79990000001',role:'owner'},{name:'Алёна',phone:'+79990000002'}]},
  ]){
    const h=fixture();await assert.rejects(prepareManualContactPlan(h.google,{...h.input,contact}),{code:'manual_contact_plan_invalid'});assert.equal(h.calls.length,0);
  }
});

test('a committed two-person update survives an unknown response and readonly replay without another mutation',async()=>{
  const h=fixture();const contact={name:'Сергей\nАлёна',phone:'+79990000001\n+79990000002',
    persons:[{name:'Сергей',phone:'+79990000001'},{name:'Алёна',phone:'+79990000002'}]};
  const plan=await prepareManualContactPlan(h.google,{...h.input,contact});
  h.controls.afterBatch=()=>{throw new Error('unknown_multiline_commit');};
  await assert.rejects(applyManualContactPlan(h.google,plan,{confirmed:true}),{code:'manual_contact_write_unconfirmed'});
  const checked=await verifyManualContactPlan(h.google,plan);assert.equal(checked.verified,true);
  assert.equal(checked.cells.M2,'Сергей\nАлёна');assert.equal(checked.cells.N2,'+79990000001\n+79990000002');
  assert.equal(checked.cells.O2,'https://t.me/original_chat');assert.equal(h.batches.length,1);
  assert.equal((await applyManualContactPlan(h.google,plan,{confirmed:true})).action,'noop');assert.equal(h.batches.length,1);
});
