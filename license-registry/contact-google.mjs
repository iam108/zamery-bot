import {hash} from './state.mjs';
import {isValidInn,normalizeAddress,normalizeDate,normalizeLicenseNumber,parseSheetRows,localDate} from './core.mjs';

const COLUMNS={M:12,N:13,O:14};
const IDENTITY_COLUMNS=['G','H','I','J','L'];
function fail(code,planHash){throw Object.assign(new Error(code),{code,...(planHash?{planHash}:{})});}
const clean=(value)=>String(value??'').trim();
function currentTime(google){const value=typeof google.now==='function'?google.now():new Date();return new Date(value);}

export function buildContactPlan(google,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||!google?.spreadsheetId||!google?.sheetName
    ||!Number.isInteger(google.sheetId)||google.sheetId<0||!Number.isInteger(input.rowNumber)||input.rowNumber<2
    ||input.rowNumber>100000||typeof input.inn!=='string'||!isValidInn(input.inn)
    ||typeof input.licenseNumber!=='string'||typeof input.issueDate!=='string'||typeof input.expiryDate!=='string'
    ||typeof input.address!=='string'||input.address.length>4096||!normalizeAddress(input.address))fail('contact_plan_invalid');
  for(const key of['spreadsheetId','sheetName','sheetId'])if(input[key]!=null&&input[key]!==google[key])fail('contact_plan_invalid');
  const licenseNumber=normalizeLicenseNumber(input.licenseNumber);
  const issueDate=normalizeDate(input.issueDate);const expiryDate=normalizeDate(input.expiryDate);
  if((licenseNumber&&!/^\d{2}[А-ЯA-Z]{2,4}\d{4,10}$/u.test(licenseNumber))||!issueDate||!expiryDate||expiryDate<issueDate
    ||!Array.isArray(input.updates)||!input.updates.length||input.updates.length>3)fail('contact_plan_invalid');
  const seen=new Set();
  const updates=input.updates.map((update)=>{
    if(!update||!Object.hasOwn(COLUMNS,update.column)||seen.has(update.column)||update.before!==''
      ||typeof update.after!=='string'||!update.after.trim()||update.after.length>4096||/[\u0000-\u001f\u007f]/u.test(update.after))fail('contact_plan_invalid');
    seen.add(update.column);return {column:update.column,before:'',after:update.after.trim()};
  }).sort((a,b)=>COLUMNS[a.column]-COLUMNS[b.column]);
  const unsigned={version:1,spreadsheetId:google.spreadsheetId,sheetName:google.sheetName,sheetId:google.sheetId,
    rowNumber:input.rowNumber,inn:input.inn.trim(),licenseNumber,issueDate,expiryDate,address:normalizeAddress(input.address),updates};
  const expectedCells=Object.fromEntries(IDENTITY_COLUMNS.map((column,index)=>[`${column}${unsigned.rowNumber}`,
    [unsigned.inn,licenseNumber,issueDate,expiryDate,unsigned.address][index]]));
  for(const update of updates)expectedCells[`${update.column}${unsigned.rowNumber}`]=update.after;
  unsigned.expectedCells=expectedCells;
  const signature=hash(unsigned);
  if((input.version!=null&&input.version!==1)||(input.hash!=null&&input.hash!==signature)
    ||(input.expectedCells!=null&&hash(input.expectedCells)!==hash(expectedCells)))fail('contact_plan_invalid');
  return {...unsigned,hash:signature};
}

function displayed(cell={}){
  if(cell.formattedValue!=null)return cell.formattedValue;
  const value=cell.effectiveValue??cell.userEnteredValue??{};
  if(value.stringValue!=null)return value.stringValue;
  if(value.numberValue!=null){
    if(['DATE','DATE_TIME'].includes((cell.effectiveFormat??cell.userEnteredFormat)?.numberFormat?.type)){
      const date=new Date((value.numberValue-25569)*86400000);return Number.isFinite(+date)?date.toISOString().slice(0,10):'';
    }
    return String(value.numberValue);
  }
  return value.boolValue==null?'':String(value.boolValue);
}
function sameIdentity(row,plan){
  return clean(row.inn)===plan.inn&&normalizeLicenseNumber(row.licenseNumber)===plan.licenseNumber
    &&normalizeDate(row.issueDate)===plan.issueDate&&normalizeDate(row.expiryDate)===plan.expiryDate
    &&normalizeAddress(row.address)===plan.address;
}
function actualIdentity(cells){
  return {inn:clean(displayed(cells[6])),licenseNumber:normalizeLicenseNumber(displayed(cells[7])),
    issueDate:normalizeDate(displayed(cells[8])),expiryDate:normalizeDate(displayed(cells[9])),address:normalizeAddress(displayed(cells[11]))};
}
function verifyContext(context,plan,google){
  if(!Array.isArray(context?.values))fail('contact_read_failed',plan.hash);
  const rows=parseSheetRows(context.values,{startRow:context.startRow??1});
  const matches=rows.filter((row)=>sameIdentity(row,plan));
  if(matches.length>1)fail('contact_row_ambiguous',plan.hash);
  if(matches.length!==1)fail('contact_identity_changed',plan.hash);
  if(matches[0].rowNumber!==plan.rowNumber)fail('contact_row_moved',plan.hash);
  const today=localDate(currentTime(google),'Europe/Moscow');
  if(plan.issueDate<=today&&plan.expiryDate>=today){
    const active=rows.filter((row)=>row.inn===plan.inn&&normalizeAddress(row.address)===plan.address
      &&row.issueDate&&row.expiryDate&&row.issueDate<=today&&row.expiryDate>=today);
    if(active.length!==1)fail('contact_row_ambiguous',plan.hash);
  }
}
function targetValue(cell={}){
  if(cell.userEnteredValue?.formulaValue!=null||(cell.note!=null&&String(cell.note)!==''))return {protected:true};
  const entered=cell.userEnteredValue;
  if(entered&&Object.keys(entered).length){
    if(typeof entered.stringValue!=='string')return {conflict:true};
    if(entered.stringValue===''&&String(displayed(cell))!=='')return {conflict:true};
    return {value:entered.stringValue};
  }
  const effective=cell.effectiveValue;
  if(effective&&Object.keys(effective).length){
    if(typeof effective.stringValue!=='string')return {conflict:true};
    return {value:effective.stringValue};
  }
  return {value:String(displayed(cell))};
}
async function inspect(google,plan){
  let context;let cells;
  try{context=await google.context();}catch{fail('contact_read_failed',plan.hash);}
  verifyContext(context,plan,google);
  try{cells=await google.readRow(plan.rowNumber);}catch{fail('contact_read_failed',plan.hash);}
  if(!Array.isArray(cells))fail('contact_identity_changed',plan.hash);
  const identity=actualIdentity(cells);
  if(!sameIdentity(identity,plan))fail('contact_identity_changed',plan.hash);
  const pending=[];const actual=Object.fromEntries(IDENTITY_COLUMNS.map((column,index)=>[`${column}${plan.rowNumber}`,
    [identity.inn,identity.licenseNumber,identity.issueDate,identity.expiryDate,identity.address][index]]));
  for(const update of plan.updates){
    const cell=targetValue(cells[COLUMNS[update.column]]);
    if(cell.protected)fail('contact_cell_protected',plan.hash);
    if(cell.conflict||(cell.value!==''&&cell.value!==update.after))fail('contact_cell_conflict',plan.hash);
    if(cell.value==='')pending.push(update);
    actual[`${update.column}${plan.rowNumber}`]=cell.value;
  }
  return {pending,actual};
}
function receipt(google,plan,result,appliedCells){
  if(result.pending.length||Object.entries(plan.expectedCells).some(([key,value])=>result.actual[key]!==value))fail('contact_readback_mismatch',plan.hash);
  return {verified:true,planHash:plan.hash,spreadsheetId:plan.spreadsheetId,sheetName:plan.sheetName,sheetId:plan.sheetId,
    rowNumber:plan.rowNumber,verifiedAt:currentTime(google).toISOString(),action:appliedCells.length?'update':'noop',
    appliedCells,cells:result.actual};
}

/** Resolve an uncertain prior write without granting permission for a new one. */
export async function verifyContactPlan(google,input){
  if(typeof input?.hash!=='string')fail('contact_plan_invalid');
  const plan=buildContactPlan(google,input);
  try{
    const checked=await inspect(google,plan);
    if(checked.pending.length)fail('contact_readback_pending',plan.hash);
    return receipt(google,plan,checked,[]);
  }catch(error){
    if(['contact_identity_changed','contact_row_moved','contact_row_ambiguous','contact_cell_protected','contact_cell_conflict',
      'contact_readback_mismatch'].includes(error.code)){
      throw Object.assign(new Error('contact_readback_pending'),{code:'contact_readback_pending',planHash:plan.hash,reason:error.code});
    }
    throw error;
  }
}

/** Replays verify expected values first; only still-empty M/N/O cells can be written. */
export async function applyContactPlan(google,input){
  const plan=buildContactPlan(google,input);
  let checked=await inspect(google,plan);
  if(!checked.pending.length)return receipt(google,plan,checked,[]);
  // Repeat identity and all target-cell preconditions immediately before batch.
  checked=await inspect(google,plan);
  if(!checked.pending.length)return receipt(google,plan,checked,[]);
  const appliedCells=checked.pending.map((update)=>`${update.column}${plan.rowNumber}`);
  const requests=checked.pending.map((update)=>({updateCells:{start:{sheetId:plan.sheetId,rowIndex:plan.rowNumber-1,
    columnIndex:COLUMNS[update.column]},rows:[{values:[{userEnteredValue:{stringValue:update.after}}]}],fields:'userEnteredValue'}}));
  try{await google.request(':batchUpdate',{body:{requests,includeSpreadsheetInResponse:false}});}
  catch{fail('contact_write_unconfirmed',plan.hash);}
  return receipt(google,plan,await inspect(google,plan),appliedCells);
}
