import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleSheetsClient,REGISTRY_HEADERS} from './google.mjs';
import {buildContactPlan,applyContactPlan,verifyContactPlan} from './contact-google.mjs';

const identity={rowNumber:2,inn:'9721255266',licenseNumber:'77РПО0021046',issueDate:'2026-04-17',expiryDate:'2029-04-16',
  address:'Россия, Москва, пер. Большой Толмачёвский, д. 5, стр. 4, этажи 1/-1'};
const updates=[{column:'M',before:'',after:'Анна Иванова'},{column:'N',before:'',after:'+79990000001'},
  {column:'O',before:'',after:'https://t.me/client_fixture'}];
const copy=(value)=>structuredClone(value);
function fixture({licenseBlank=false}={}){
  const row=Array(17).fill('');Object.assign(row,{0:'PRIVATE_INTERNAL_LINK',4:'ООО «СВЕРТЭ»',6:identity.inn,
    7:licenseBlank?'':identity.licenseNumber,8:identity.issueDate,9:identity.expiryDate,10:'Общепит ',11:identity.address,
    15:'keep@example.test',16:'Ручной комментарий'});
  const values=[[...REGISTRY_HEADERS],row];const overrides=new Map();const calls=[];const batches=[];
  const google=new GoogleSheetsClient({spreadsheetId:'contacts-fixture',sheetName:'Реестр лицензий',sheetId:0,
    now:()=>new Date('2026-11-05T09:00:00.000Z')});
  const properties={sheetId:0,title:google.sheetName,gridProperties:{rowCount:100,columnCount:17}};
  const metadata={spreadsheetId:google.spreadsheetId,sheets:[{properties}]};let rowReads=0;let valueReads=0;
  const controls={};
  google.request=async(suffix='',options={})=>{
    calls.push({suffix,options:copy(options)});
    if(suffix===':batchUpdate'){
      batches.push(copy(options.body));
      for(const item of options.body.requests){
        assert.deepEqual(Object.keys(item),['updateCells']);const change=item.updateCells;
        assert.equal(change.fields,'userEnteredValue');assert.equal(change.start.sheetId,0);
        assert.ok([12,13,14].includes(change.start.columnIndex));
        const value=change.rows[0].values[0].userEnteredValue;
        assert.deepEqual(Object.keys(value),['stringValue']);assert.equal(typeof value.stringValue,'string');
        values[change.start.rowIndex][change.start.columnIndex]=value.stringValue;
      }
      controls.afterBatch?.();return {};
    }
    if(suffix.startsWith('/values/')){controls.beforeValues?.(++valueReads);return {values:copy(values)};}
    if(options.query?.ranges){
      controls.beforeRowRead?.(++rowReads);
      const rowNumber=Number(options.query.ranges.match(/!A(\d+):/u)[1]);
      return {...copy(metadata),sheets:[{properties,data:[{startRow:rowNumber-1,startColumn:0,rowData:[{
        values:(values[rowNumber-1]??[]).map((value,index)=>({...value===''?{}:{formattedValue:value,userEnteredValue:{stringValue:value}},
          ...copy(overrides.get(`${rowNumber}:${index}`)??{})}))}]}]}]};
    }
    return copy(metadata);
  };
  return {google,row,values,overrides,calls,batches,controls,input:{...identity,licenseNumber:licenseBlank?'':identity.licenseNumber,updates:copy(updates)}};
}

test('empty M/N/O receive strings through a minimal batch and all target/identity cells are read back',async()=>{
  const h=fixture();const original=copy(h.row);const plan=buildContactPlan(h.google,h.input);
  const result=await applyContactPlan(h.google,plan);
  assert.equal(result.verified,true);assert.equal(result.planHash,plan.hash);assert.equal(result.action,'update');
  assert.deepEqual(result.appliedCells,['M2','N2','O2']);assert.deepEqual(result.cells,plan.expectedCells);
  assert.equal(h.batches.length,1);assert.equal(h.batches[0].requests.length,3);
  assert.equal(h.row[13],'+79990000001');assert.equal(typeof h.row[13],'string');
  for(let index=0;index<17;index++)if(![12,13,14].includes(index))assert.equal(h.row[index],original[index]);
  const replay=await applyContactPlan(h.google,plan);
  assert.equal(replay.verified,true);assert.equal(replay.action,'noop');assert.deepEqual(replay.appliedCells,[]);assert.equal(h.batches.length,1);
});

test('already-expected targets plus blank targets only write the remaining empty cells',async()=>{
  const h=fixture();h.row[12]=updates[0].after;h.row[14]=updates[2].after;
  const result=await applyContactPlan(h.google,h.input);
  assert.deepEqual(result.appliedCells,['N2']);assert.equal(h.batches[0].requests.length,1);
  assert.equal(h.batches[0].requests[0].updateCells.start.columnIndex,13);
});

test('a manually named different person prevents filling the rest of a combined contact proposal',async()=>{
  const h=fixture();h.row[12]='Мария Петрова';
  await assert.rejects(applyContactPlan(h.google,h.input),{code:'contact_cell_conflict'});
  assert.equal(h.row[12],'Мария Петрова');assert.equal(h.row[13],'');assert.equal(h.row[14],'');assert.equal(h.batches.length,0);
});

test('formulas, notes and manually numeric phone cells are protected even when their visible result looks empty or expected',async()=>{
  for(const cell of[
    {formattedValue:'',userEnteredValue:{formulaValue:'=""'}},
    {formattedValue:updates[1].after,userEnteredValue:{formulaValue:`="${updates[1].after}"`}},
    {note:'Не менять контакт'},
    {note:' '},
    {formattedValue:'79990000001',userEnteredValue:{numberValue:79990000001}},
  ]){
    const h=fixture();h.overrides.set('2:13',cell);
    await assert.rejects(applyContactPlan(h.google,h.input),(error)=>['contact_cell_protected','contact_cell_conflict'].includes(error.code));
    assert.equal(h.batches.length,0);
  }
});

test('wrong organization, license, address or period never receives another client contact',async()=>{
  for(const mismatch of[{inn:'9705148570'},{licenseNumber:'77РПО0021680'},{address:'Москва, другой адрес'},
    {issueDate:'2026-04-18'},{expiryDate:'2029-04-17'}]){
    const h=fixture();await assert.rejects(applyContactPlan(h.google,{...h.input,...mismatch}),{code:'contact_identity_changed'});
    assert.equal(h.batches.length,0);
  }
});

test('a row reorder between planning and the final preflight is rejected before writing',async()=>{
  const h=fixture();const other=copy(h.row);other[6]='9705148570';other[7]='77РПО0021680';
  h.controls.beforeValues=(count)=>{if(count===2)h.values.splice(1,0,other);};
  await assert.rejects(applyContactPlan(h.google,h.input),{code:'contact_row_moved'});assert.equal(h.batches.length,0);
});

test('a manual edit between the two row reads aborts the whole batch',async()=>{
  const h=fixture();h.controls.beforeRowRead=(count)=>{if(count===2)h.row[13]='+78880000000';};
  await assert.rejects(applyContactPlan(h.google,h.input),{code:'contact_cell_conflict'});
  assert.equal(h.row[12],'');assert.equal(h.row[13],'+78880000000');assert.equal(h.batches.length,0);
});

test('a committed batch with an unknown response is recovered by readback without another write',async()=>{
  const h=fixture();let failed=false;
  h.controls.afterBatch=()=>{if(!failed){failed=true;throw new Error('unknown_batch_commit');}};
  const plan=buildContactPlan(h.google,h.input);
  await assert.rejects(applyContactPlan(h.google,plan),{code:'contact_write_unconfirmed',planHash:plan.hash});
  const recovered=await applyContactPlan(h.google,plan);
  assert.equal(recovered.verified,true);assert.equal(recovered.action,'noop');assert.equal(h.batches.length,1);
  assert.deepEqual(recovered.cells,plan.expectedCells);
});

test('a lost post-write readback also recovers without repeating the committed update',async()=>{
  const h=fixture();let failed=false;
  h.controls.beforeRowRead=(count)=>{if(count===3&&!failed){failed=true;throw new Error('readback_unavailable');}};
  await assert.rejects(applyContactPlan(h.google,h.input),{code:'contact_read_failed'});
  assert.equal((await applyContactPlan(h.google,h.input)).verified,true);assert.equal(h.batches.length,1);
});

test('a valid current period with blank H is enriched while H remains blank and guarded',async()=>{
  const h=fixture({licenseBlank:true});const result=await applyContactPlan(h.google,h.input);
  assert.equal(result.verified,true);assert.equal(result.cells.H2,'');assert.equal(h.row[7],'');
  const raced=fixture({licenseBlank:true});raced.controls.beforeRowRead=()=>{raced.row[7]=identity.licenseNumber;};
  await assert.rejects(applyContactPlan(raced.google,raced.input),{code:'contact_identity_changed'});assert.equal(raced.batches.length,0);
});

test('duplicate or overlapping active rows block enrichment; an expired historical period does not',async()=>{
  for(const samePeriod of[true,false]){
    const h=fixture({licenseBlank:true});const other=copy(h.row);if(!samePeriod)other[9]='2030-04-16';h.values.push(other);
    await assert.rejects(applyContactPlan(h.google,h.input),{code:'contact_row_ambiguous'});assert.equal(h.batches.length,0);
  }
  const h=fixture();const historical=copy(h.row);historical[9]='2025-04-16';h.values.push(historical);
  assert.equal((await applyContactPlan(h.google,h.input)).verified,true);
});

test('invalid columns, non-empty before, numeric phones, duplicate updates and signed-plan tampering fail before any Google read',async()=>{
  for(const changes of[
    [{column:'H',before:'',after:'bad'}],[{column:'N',before:'',after:79990000001}],
    [{column:'N',before:'manual',after:'+79990000001'}],[updates[0],updates[0]],
  ]){
    const h=fixture();await assert.rejects(applyContactPlan(h.google,{...h.input,updates:changes}),{code:'contact_plan_invalid'});assert.equal(h.calls.length,0);
  }
  const h=fixture();const plan=buildContactPlan(h.google,h.input);plan.updates[1].after='+78880000000';
  await assert.rejects(applyContactPlan(h.google,plan),{code:'contact_plan_invalid'});assert.equal(h.calls.length,0);
});

test('read-only verification never sends a batch for blank, partially filled, conflicted or moved contacts',async()=>{
  for(const configure of[
    ()=>{},(h)=>{h.row[12]=updates[0].after;},(h)=>{h.row[13]='+78880000000';},
    (h)=>{h.row[6]='9705148570';},(h)=>{h.overrides.set('2:13',{note:'Не менять'});},
  ]){
    const h=fixture();const plan=buildContactPlan(h.google,h.input);configure(h);
    await assert.rejects(verifyContactPlan(h.google,plan),{code:'contact_readback_pending'});
    assert.equal(h.batches.length,0);assert.ok(h.calls.every((call)=>call.options.body===undefined));
  }
});

test('read-only verification acknowledges a committed plan after a lost response without permitting another write',async()=>{
  const h=fixture();const plan=buildContactPlan(h.google,h.input);
  h.controls.afterBatch=()=>{throw new Error('unknown_commit');};
  await assert.rejects(applyContactPlan(h.google,plan),{code:'contact_write_unconfirmed'});
  const writes=h.batches.length;const checked=await verifyContactPlan(h.google,plan);
  assert.equal(checked.verified,true);assert.equal(checked.planHash,plan.hash);assert.equal(checked.action,'noop');
  assert.deepEqual(checked.cells,plan.expectedCells);assert.equal(h.batches.length,writes);
  await assert.rejects(verifyContactPlan(h.google,h.input),{code:'contact_plan_invalid'});
});
