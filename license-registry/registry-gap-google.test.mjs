import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from './state.mjs';
import {REGISTRY_HEADERS} from './google.mjs';
import {prepareRegistryGapPlan,applyRegistryGapPlan,verifyRegistryGapPlan} from './registry-gap-google.mjs';

const INN='9705148570';const copy=(value)=>structuredClone(value);
const auth={requestId:'gap:row:2:fixture',ownerChatId:'123456789',source:'owner',sourceMessageId:'101'};
const updates=[{column:'G',after:INN},{column:'H',after:'77РПО0021680'},{column:'I',after:'28.10.2026'},
  {column:'J',after:'27.10.2027'},{column:'K',after:'Розничная продажа алкогольной продукции при оказании услуг общественного питания'},
  {column:'L',after:'Россия, Москва, ул. Пушкина, д. 1'},{column:'M',after:'Сергей\nАлёна'},
  {column:'N',after:'+79991112233\n+79994445566'},{column:'O',after:'@client_fixture'},{column:'P',after:'client@example.test'}];
function cell(value=''){return value===''?{}:{formattedValue:String(value),userEnteredValue:{stringValue:String(value)},effectiveValue:{stringValue:String(value)}};}
function fixture({inn='',dateFormat=false}={}){
  const row=Array(17).fill('');Object.assign(row,{0:'PRIVATE_INTERNAL_LINK',1:'Партнёр',2:'15000',3:'Ссылка',4:'ООО «ХОРОШОТ»',5:'Бренд',6:inn,16:'Комментарий менеджера'});
  const cells=row.map(cell);const rows=[[...REGISTRY_HEADERS].map(cell),cells];const calls=[];const controls={};
  if(dateFormat)for(const index of [8,9])cells[index]={userEnteredFormat:{numberFormat:{type:'DATE',pattern:'dd mmm yyyy'},backgroundColor:{red:1}},effectiveFormat:{numberFormat:{type:'DATE',pattern:'dd mmm yyyy'}}};
  let contextReads=0,rowReads=0;
  const google={spreadsheetId:'gap-fixture',sheetName:'Реестр лицензий',sheetId:0,now:()=>new Date('2026-11-05T09:00:00Z'),
    async context(){controls.beforeContext?.(++contextReads);return {values:rows.map(row=>row.map(c=>c.formattedValue??c.userEnteredValue?.stringValue??'')),startRow:1};},
    async readRow(number){controls.beforeRow?.(++rowReads);if(controls.readError)throw new Error('private read');return copy(rows[number-1]);},
    async request(suffix,{body}){
      assert.equal(suffix,':batchUpdate');controls.beforeBatch?.();calls.push(copy(body));
      for(const item of body.requests){
        assert.deepEqual(Object.keys(item),['updateCells']);const update=item.updateCells;
        assert.equal(update.start.sheetId,0);assert.ok(update.start.columnIndex>=6&&update.start.columnIndex<=15);
        const current=rows[update.start.rowIndex][update.start.columnIndex],next=update.rows[0].values[0];
        current.userEnteredValue=copy(next.userEnteredValue);current.effectiveValue=copy(next.userEnteredValue);
        if(next.userEnteredValue.numberValue!=null){
          current.formattedValue=new Date((next.userEnteredValue.numberValue-25569)*86400000).toISOString().slice(0,10);
        }else current.formattedValue=next.userEnteredValue.stringValue;
        if(next.userEnteredFormat?.numberFormat){current.userEnteredFormat={...(current.userEnteredFormat??{}),numberFormat:copy(next.userEnteredFormat.numberFormat)};
          current.effectiveFormat={...(current.effectiveFormat??{}),numberFormat:copy(next.userEnteredFormat.numberFormat)};}
      }
      controls.afterBatch?.();return {};
    }};
  return {google,row,cells,rows,calls,controls,input:{rowNumber:2,expectedRowValues:copy(row),updates:copy(updates),authorization:copy(auth)}};
}

test('fills only empty allowed cells, creates native DATE values, preserves manual fields and verifies readback',async()=>{
  const h=fixture();const before=copy(h.cells);const plan=await prepareRegistryGapPlan(h.google,h.input);
  assert.equal(plan.updates.length,10);assert.equal(plan.afterValues[10],'Общепит ');
  const receipt=await applyRegistryGapPlan(h.google,plan);
  assert.equal(receipt.verified,true);assert.equal(receipt.planHash,plan.hash);assert.equal(receipt.action,'update');
  assert.deepEqual(receipt.appliedCells,['G2','H2','I2','J2','K2','L2','M2','N2','O2','P2']);
  assert.equal(receipt.cells.G2,INN);assert.equal(receipt.cells.I2,'2026-10-28');assert.equal(receipt.cells.J2,'2027-10-27');
  assert.equal(h.cells[6].userEnteredValue.stringValue,INN);assert.equal(h.cells[13].userEnteredValue.stringValue,'+79991112233\n+79994445566');
  assert.equal(h.cells[8].userEnteredValue.numberValue,46323);assert.equal(h.cells[8].userEnteredFormat.numberFormat.type,'DATE');
  for(const index of [0,1,2,3,4,5,16])assert.deepEqual(h.cells[index],before[index]);
  assert.equal(h.calls.length,1);assert.equal(h.rows.length,2);
  assert.deepEqual((await verifyRegistryGapPlan(h.google,plan)).cells,plan.expectedCells);
  assert.equal((await applyRegistryGapPlan(h.google,plan)).action,'noop');assert.equal(h.calls.length,1);
});

test('existing DATE formatting and other cell formatting remain intact',async()=>{
  const h=fixture({dateFormat:true});const before=copy(h.cells[8].userEnteredFormat);const plan=await prepareRegistryGapPlan(h.google,h.input);
  assert.equal(plan.updates.find(u=>u.column==='I').setDateFormat,false);
  await applyRegistryGapPlan(h.google,plan);assert.deepEqual(h.cells[8].userEnteredFormat,before);
  const request=h.calls[0].requests.find(r=>r.updateCells.start.columnIndex===8);assert.equal(request.updateCells.fields,'userEnteredValue');
});

test('equivalent nonempty values yield noop while different nonempty values are conflicts',async()=>{
  const h=fixture({inn:INN});h.input.updates=[{column:'G',after:INN}];
  const plan=await prepareRegistryGapPlan(h.google,h.input);assert.deepEqual(plan.updates,[]);
  assert.equal((await applyRegistryGapPlan(h.google,plan)).action,'noop');assert.equal(h.calls.length,0);
  h.input.updates=[{column:'G',after:'7736274613'}];await assert.rejects(prepareRegistryGapPlan(h.google,h.input),{code:'registry_gap_conflict'});
});

test('formulas, notes, numeric occupied cells and hidden existing values are not overwritten',async()=>{
  for(const existing of [
    {formattedValue:'',userEnteredValue:{formulaValue:'=""'}},
    {note:'Не заполнять'}, {note:' '},
    {formattedValue:'',userEnteredValue:{numberValue:123},effectiveValue:{numberValue:123}},
    {formattedValue:'',userEnteredValue:{stringValue:'hidden'}},
  ]){
    const h=fixture();h.cells[7]=existing;
    await assert.rejects(prepareRegistryGapPlan(h.google,h.input),error=>['registry_gap_cell_protected','registry_gap_conflict'].includes(error.code));
    assert.equal(h.calls.length,0);
  }
});

test('a row move, different company or a manual edit between preflights prevents a batch',async()=>{
  for(const mutation of [
    h=>{h.rows.splice(1,0,Array(17).fill('').map(cell));},
    h=>{h.cells[4]=cell('ООО ДРУГОЕ');},
    h=>{h.cells[16]=cell('Новое примечание менеджера');},
    h=>{h.cells[7]=cell('77РПО0099999');},
  ]){
    const h=fixture();const plan=await prepareRegistryGapPlan(h.google,h.input);let calls=0;
    h.controls.beforeContext=()=>{if(++calls===2)mutation(h);};
    await assert.rejects(applyRegistryGapPlan(h.google,plan),{code:'registry_gap_conflict'});assert.equal(h.calls.length,0);
  }
});

test('identical ambiguous rows need an explicit target row authorization',async()=>{
  const h=fixture();h.rows.push(copy(h.cells));
  await assert.rejects(prepareRegistryGapPlan(h.google,h.input),{code:'registry_gap_conflict'});
  h.input.authorization.explicitRow=2;const plan=await prepareRegistryGapPlan(h.google,h.input);await applyRegistryGapPlan(h.google,plan);
  assert.equal(h.cells[6].userEnteredValue.stringValue,INN);assert.equal(h.rows[2][6].userEnteredValue,undefined);
});

test('unknown committed response is recovered by read-only verification with no repeated write',async()=>{
  const h=fixture();const plan=await prepareRegistryGapPlan(h.google,h.input);h.controls.afterBatch=()=>{throw new Error('unknown commit');};
  await assert.rejects(applyRegistryGapPlan(h.google,plan),{code:'registry_gap_write_unconfirmed'});
  assert.equal(h.calls.length,1);assert.equal((await verifyRegistryGapPlan(h.google,plan)).verified,true);assert.equal(h.calls.length,1);
  assert.equal((await applyRegistryGapPlan(h.google,plan)).action,'noop');assert.equal(h.calls.length,1);
});

test('read-only verification of uncommitted or conflicted plans never sends a batch',async()=>{
  const h=fixture();const plan=await prepareRegistryGapPlan(h.google,h.input);
  await assert.rejects(verifyRegistryGapPlan(h.google,plan),{code:'registry_gap_readback_pending'});assert.equal(h.calls.length,0);
  h.cells[13]=cell('+79990000000');await assert.rejects(verifyRegistryGapPlan(h.google,plan),{code:'registry_gap_readback_pending'});assert.equal(h.calls.length,0);
});

test('invalid INN, license, dates, activity, contacts, authorization or columns fail before Google access',async()=>{
  for(const change of [
    {updates:[{column:'G',after:'9705148571'}]},
    {updates:[{column:'G',after:INN},{column:'H',after:'invalid'}]},
    {updates:[{column:'G',after:INN},{column:'I',after:'2027-12-31'},{column:'J',after:'2026-01-01'}]},
    {updates:[{column:'G',after:INN},{column:'K',after:'unknown'}]},
    {updates:[{column:'G',after:INN},{column:'M',after:'Сергей\nАлёна'},{column:'N',after:'+79991112233'}]},
    {updates:[{column:'G',after:INN},{column:'N',after:79991112233}]},
    {updates:[{column:'E',after:'Другая компания'}]},
    {updates:[{column:'G',after:INN},{column:'G',after:INN}]},
    {authorization:{...auth,ownerChatId:'-1'}},
    {expectedRowValues:Array(17).fill('')},
  ]){
    const h=fixture();let reads=0;h.google.context=async()=>{reads++;throw new Error('should not read');};
    await assert.rejects(prepareRegistryGapPlan(h.google,{...h.input,...change}),{code:'registry_gap_plan_invalid'});assert.equal(reads,0);
  }
});

test('signed plan tampering is rejected before a Google read',async()=>{
  const h=fixture();const plan=await prepareRegistryGapPlan(h.google,h.input);plan.updates[0].after='7736274613';
  let reads=0;h.google.context=async()=>{reads++;throw new Error('should not read');};
  await assert.rejects(applyRegistryGapPlan(h.google,plan),{code:'registry_gap_plan_invalid'});assert.equal(reads,0);
});

test('an already correct noted or formula cell is a preserved no-op while other gaps fill',async()=>{
  const h=fixture({inn:INN});h.cells[6].note='Проверено вручную';h.cells[7]={formattedValue:'77РПО0021680',
    userEnteredValue:{formulaValue:'="77РПО0021680"'},effectiveValue:{stringValue:'77РПО0021680'}};
  h.input.expectedRowValues[7]='77РПО0021680';const before=h.cells.slice(6,8).map(copy);
  const plan=await prepareRegistryGapPlan(h.google,h.input);assert.ok(!plan.updates.some(update=>['G','H'].includes(update.column)));
  assert.equal((await applyRegistryGapPlan(h.google,plan)).verified,true);assert.deepEqual(h.cells.slice(6,8),before);
});
