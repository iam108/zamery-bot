import {hash} from './state.mjs';
import {normalizeAddress,normalizeDate,normalizeLicenseNumber,parseSheetRows,localDate} from './core.mjs';
import {buildContactPlan} from './contact-google.mjs';

const COLS={M:12,N:13,O:14};const CONTACT_COLS=Object.keys(COLS);
const clone=(value)=>JSON.parse(JSON.stringify(value));
const canonical=(value)=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])])):value;
const digest=(value)=>hash(canonical(value));
function fail(code,planHash,reason){throw Object.assign(new Error(code),{code,...(planHash?{planHash}:{}),...(reason?{reason}:{})});}
const now=(google)=>new Date(typeof google.now==='function'?google.now():Date.now());
function positiveId(value){const text=String(value??'');if(!/^[1-9]\d*$/u.test(text)||!Number.isSafeInteger(Number(text)))fail('manual_contact_plan_invalid');return text;}
function authorization(input,row){
  if(!input||typeof input.reviewId!=='string'||!/^[a-f0-9]{64}$/u.test(input.reviewId))fail('manual_contact_plan_invalid');
  const result={reviewId:input.reviewId,ownerChatId:positiveId(input.ownerChatId),sourceMessageId:positiveId(input.sourceMessageId)};
  if(input.explicitRow!=null){if(!Number.isInteger(input.explicitRow)||input.explicitRow!==row)fail('manual_contact_plan_invalid');result.explicitRow=row;}
  return result;
}
function contact(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('manual_contact_plan_invalid');
  const text=(value)=>{if(typeof value!=='string'||!value.trim()||value.length>4096||/[\u0000-\u001f\u007f]/u.test(value))fail('manual_contact_plan_invalid');return value.trim();};
  return {name:text(input.name),phone:text(input.phone),...(input.telegram==null?{}:{telegram:text(input.telegram)})};
}
function identity(google,input){
  let prepared;
  try{prepared=buildContactPlan(google,{...input,updates:[{column:'M',before:'',after:'identity validation'}],hash:undefined,expectedCells:undefined});}
  catch{fail('manual_contact_plan_invalid');}
  return Object.fromEntries(['spreadsheetId','sheetName','sheetId','rowNumber','inn','licenseNumber','issueDate','expiryDate','address'].map((key)=>[key,prepared[key]]));
}
function displayed(cell={}){
  if(cell.formattedValue!=null)return String(cell.formattedValue);
  const value=cell.effectiveValue??cell.userEnteredValue??{};
  if(value.stringValue!=null)return value.stringValue;
  if(value.numberValue!=null){
    if(['DATE','DATE_TIME'].includes((cell.effectiveFormat??cell.userEnteredFormat)?.numberFormat?.type))return new Date((value.numberValue-25569)*86400000).toISOString().slice(0,10);
    return String(value.numberValue);
  }
  return value.boolValue==null?'':String(value.boolValue);
}
function contactValue(cell={}){return typeof cell.userEnteredValue?.stringValue==='string'?cell.userEnteredValue.stringValue:displayed(cell);}
function nonemptyObject(value){return value&&Object.keys(value).length?clone(value):null;}
function snapshot(cell={}){
  return {entered:nonemptyObject(cell.userEnteredValue),effective:nonemptyObject(cell.effectiveValue),displayed:displayed(cell),
    note:cell.note??'',validation:nonemptyObject(cell.dataValidation),format:nonemptyObject(cell.userEnteredFormat)};
}
function snapshotValue(value){return typeof value.entered?.stringValue==='string'?value.entered.stringValue:value.displayed;}
function metadata(value){return {note:value.note,validation:value.validation,format:value.format};}
function protectedCell(cell={}){return cell.userEnteredValue?.formulaValue!=null||(cell.note!=null&&String(cell.note)!=='');}
function rowIdentity(cells){return {inn:displayed(cells[6]).trim(),licenseNumber:normalizeLicenseNumber(displayed(cells[7])),
  issueDate:normalizeDate(displayed(cells[8])),expiryDate:normalizeDate(displayed(cells[9])),address:normalizeAddress(displayed(cells[11]))};}
function matches(value,plan){return value.inn===plan.inn&&normalizeLicenseNumber(value.licenseNumber)===plan.licenseNumber
  &&normalizeDate(value.issueDate)===plan.issueDate&&normalizeDate(value.expiryDate)===plan.expiryDate&&normalizeAddress(value.address)===plan.address;}
async function readState(google,plan,preparing=false){
  let context;let cells;
  try{context=await google.context();}catch{fail('manual_contact_read_failed',plan.hash);}
  const rows=parseSheetRows(context.values,{startRow:context.startRow??1});const selected=rows.find((row)=>row.rowNumber===plan.rowNumber);
  if(!selected||!matches(selected,plan))fail(preparing?'manual_contact_identity_changed':'manual_contact_plan_stale',plan.hash);
  const today=localDate(now(google),'Europe/Moscow');
  const ambiguous=rows.filter((row)=>matches(row,plan)).length>1||(plan.issueDate<=today&&plan.expiryDate>=today
    &&rows.filter((row)=>row.inn===plan.inn&&normalizeAddress(row.address)===plan.address&&row.issueDate&&row.expiryDate&&row.issueDate<=today&&row.expiryDate>=today).length>1);
  if(ambiguous&&plan.authorization.explicitRow!==plan.rowNumber)fail(preparing?'manual_contact_row_ambiguous':'manual_contact_plan_stale',plan.hash);
  try{cells=await google.readRow(plan.rowNumber);}catch{fail('manual_contact_read_failed',plan.hash);}
  if(!Array.isArray(cells)||!matches(rowIdentity(cells),plan))fail(preparing?'manual_contact_identity_changed':'manual_contact_plan_stale',plan.hash);
  const contacts=Object.fromEntries(CONTACT_COLS.map((column)=>[column,snapshot(cells[COLS[column]])]));
  const nonContactRowHash=digest(Array.from({length:17},(_,index)=>[12,13,14].includes(index)?null:snapshot(cells[index])));
  return {cells,identity:rowIdentity(cells),contacts,nonContactRowHash};
}
function afterValues(before,person){return {M:person.name,N:person.phone,O:person.telegram??before.O};}
function changes(before,after){return CONTACT_COLS.filter((column)=>before[column]!==after[column]).map((column)=>({column,before:before[column],after:after[column]}));}
function expected(plan,after){return {[`G${plan.rowNumber}`]:plan.inn,[`H${plan.rowNumber}`]:plan.licenseNumber,
  [`I${plan.rowNumber}`]:plan.issueDate,[`J${plan.rowNumber}`]:plan.expiryDate,[`L${plan.rowNumber}`]:plan.address,
  ...Object.fromEntries(CONTACT_COLS.map((column)=>[`${column}${plan.rowNumber}`,after[column]]))};}

export async function prepareManualContactPlan(google,input){
  const person=contact(input?.contact);const base=identity(google,input);const auth=authorization(input.authorization,base.rowNumber);
  const current=await readState(google,{...base,authorization:auth},true);
  const before=Object.fromEntries(CONTACT_COLS.map((column)=>[column,snapshotValue(current.contacts[column])]));
  const after=afterValues(before,person);const updates=changes(before,after);
  if(updates.some((update)=>protectedCell(current.cells[COLS[update.column]])))fail('manual_contact_cell_protected');
  const unsigned={version:1,...base,authorization:auth,contact:person,before,after,updates,
    needsConfirmation:updates.some((update)=>update.before!==''),beforeSnapshots:current.contacts,
    nonContactRowHash:current.nonContactRowHash,expectedCells:expected(base,after)};
  return {...unsigned,hash:digest(unsigned)};
}
function validatePlan(google,input){
  if(!input||typeof input.hash!=='string'||!/^[a-f0-9]{64}$/u.test(input.hash))fail('manual_contact_plan_invalid');
  const {hash:signature,...unsigned}=input;
  if(input.version!==1||digest(unsigned)!==signature)fail('manual_contact_plan_invalid');
  const base=identity(google,input);const auth=authorization(input.authorization,base.rowNumber);const person=contact(input.contact);
  let before;
  try{before=Object.fromEntries(CONTACT_COLS.map((column)=>[column,snapshotValue(input.beforeSnapshots[column])]));}catch{fail('manual_contact_plan_invalid');}
  const after=afterValues(before,person);const updates=changes(before,after);
  if(CONTACT_COLS.some((column)=>typeof before[column]!=='string')||!/^([a-f0-9]{64})$/u.test(input.nonContactRowHash??'')
    ||digest(input.before)!==digest(before)||digest(input.after)!==digest(after)||digest(input.updates)!==digest(updates)
    ||input.needsConfirmation!==updates.some((update)=>update.before!=='')||digest(input.expectedCells)!==digest(expected(base,after))
    ||digest(input.authorization)!==digest(auth)||Object.keys(base).some((key)=>input[key]!==base[key]))fail('manual_contact_plan_invalid');
  return clone(input);
}
function guard(plan,current){if(current.nonContactRowHash!==plan.nonContactRowHash)fail('manual_contact_plan_stale',plan.hash);}
function beforeMatches(plan,current){return CONTACT_COLS.every((column)=>digest(current.contacts[column])===digest(plan.beforeSnapshots[column]));}
function afterMatches(plan,current){
  const changed=new Set(plan.updates.map((update)=>update.column));
  return CONTACT_COLS.every((column)=>{
    if(snapshotValue(current.contacts[column])!==plan.after[column])return false;
    if(!changed.has(column))return digest(current.contacts[column])===digest(plan.beforeSnapshots[column]);
    return !protectedCell(current.cells[COLS[column]])&&current.cells[COLS[column]]?.userEnteredValue?.stringValue===plan.after[column]
      &&digest(metadata(current.contacts[column]))===digest(metadata(plan.beforeSnapshots[column]));
  });
}
function receipt(google,plan,current,appliedCells){
  guard(plan,current);if(!afterMatches(plan,current))fail('manual_contact_readback_pending',plan.hash,beforeMatches(plan,current)?undefined:'manual_contact_plan_stale');
  const actual={...expected({...plan,...current.identity},Object.fromEntries(CONTACT_COLS.map((column)=>[column,snapshotValue(current.contacts[column])])))};
  return {verified:true,planHash:plan.hash,spreadsheetId:plan.spreadsheetId,sheetName:plan.sheetName,sheetId:plan.sheetId,
    rowNumber:plan.rowNumber,verifiedAt:now(google).toISOString(),action:appliedCells.length?'update':'noop',appliedCells,cells:actual};
}

export async function verifyManualContactPlan(google,input){
  const plan=validatePlan(google,input);
  try{return receipt(google,plan,await readState(google,plan),[]);}
  catch(error){
    if(['manual_contact_plan_stale','manual_contact_identity_changed','manual_contact_cell_protected','manual_contact_row_ambiguous'].includes(error.code)){
      fail('manual_contact_readback_pending',plan.hash,error.code==='manual_contact_cell_protected'?error.code:'manual_contact_plan_stale');
    }
    throw error;
  }
}

export async function applyManualContactPlan(google,input,{confirmed=false}={}){
  const plan=validatePlan(google,input);
  if(plan.needsConfirmation&&confirmed!==true)fail('manual_contact_confirmation_required',plan.hash);
  let current=await readState(google,plan);guard(plan,current);
  if(afterMatches(plan,current))return receipt(google,plan,current,[]);
  if(!beforeMatches(plan,current))fail('manual_contact_plan_stale',plan.hash);
  current=await readState(google,plan);guard(plan,current);
  if(afterMatches(plan,current))return receipt(google,plan,current,[]);
  if(!beforeMatches(plan,current))fail('manual_contact_plan_stale',plan.hash);
  if(plan.updates.some((update)=>protectedCell(current.cells[COLS[update.column]])))fail('manual_contact_cell_protected',plan.hash);
  const requests=plan.updates.map((update)=>({updateCells:{start:{sheetId:plan.sheetId,rowIndex:plan.rowNumber-1,columnIndex:COLS[update.column]},
    rows:[{values:[{userEnteredValue:{stringValue:update.after}}]}],fields:'userEnteredValue'}}));
  try{await google.request(':batchUpdate',{body:{requests,includeSpreadsheetInResponse:false}});}catch{fail('manual_contact_write_unconfirmed',plan.hash);}
  return receipt(google,plan,await readState(google,plan),plan.updates.map((update)=>`${update.column}${plan.rowNumber}`));
}
