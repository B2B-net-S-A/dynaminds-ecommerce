/** Finite Root-reviewed Source211→209 metadata inverse, not business admission.
 * Compiled entry points use only the fixed immutable contract. The original
 * explicit two-argument draft API cannot claim source or Native authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {normalizeReturnCredit211DraftRecords as records,validateReturnCredit211DraftContract,isReturnCredit211DraftFootprint,RETURN_CREDIT211_SOURCE_STATUS,RETURN_CREDIT211_DRAFT_STATUS,RETURN_CREDIT211_SOURCE_CONTRACT} from './return-credit211-source-contract.mjs';
const id=r=>r.kind+'\0'+r.key;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const countKeys={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types'};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
function one(rows,change){
 const selected=rows.filter(r=>r.kind===change.kind&&(change.kind==='function'?r.key.split('(')[0]===change.key.split('(')[0]:r.key===change.key));
 assert.deepEqual(selected.map(id),[id(change)],'211 missing/overloaded changed object');return selected[0];
}
function projectRecords(input,e,status,compiled){
 const rows=records(input),changeIds=new Set(e.changes.map(id));
 const owned=rows.filter(r=>isReturnCredit211DraftFootprint(r)&&!changeIds.has(id(r)));
 const removedCounts=Object.fromEntries(Object.values(countKeys).map(k=>[k,0]));
 const restoredCounts={...removedCounts};
 if(!owned.length){
  if(compiled){
   // Earlier source205/pre207 legitimately lacks the later six BEFORE rows.
   // Identity here approves no predecessor: the existing cold chain still
   // authenticates its own stages. A stripped successor port is never absence.
   const names=new Set(e.changes.filter(c=>c.kind==='function').map(c=>c.key.split('(')[0]));
   assert(!rows.some(r=>changeIds.has(id(r))&&isReturnCredit211DraftFootprint(r)),'211 partial successor FK or RI without complete footprint');
   assert(!rows.some(r=>r.kind==='function'&&names.has(r.key.split('(')[0])&&typeof r.value.source==='string'&&/\breturn_credit211_/.test(r.value.source)),'211 partial successor port without complete footprint');
  }else{
   for(const c of e.changes)assert.deepEqual(one(rows,c).value,c.before,'211 absence requires intact literal209 descriptor');
   for(const r of e.removed)assert.deepEqual(rows.find(x=>id(x)===id(r)),r,'211 absence requires both original parent RI');
  }
  return freeze({records:rows,active:false,mode:compiled?'SOURCE211_ABSENT_PREDECESSOR_IDENTITY':'DRAFT_ABSENT_EXACT209_FOOTPRINT',removed_records:0,restored_records:0,changed_records:0,removed_counts:removedCounts,restored_counts:restoredCounts,...status,authority:false});
 }
 assert.deepEqual(owned,e.additions,'211 exact complete addition roster and descriptors required');
 for(const c of e.changes)assert.deepEqual(one(rows,c).value,c.after,'211 full AFTER descriptor required');
 for(const r of e.removed)assert(!rows.some(x=>id(x)===id(r)),'211 replaced old parent RI still present');
 const additionIds=new Set(e.additions.map(id)),changes=new Map(e.changes.map(c=>[id(c),c]));
 const output=rows.filter(r=>!additionIds.has(id(r))).map(r=>{const c=changes.get(id(r));return c?{kind:r.kind,key:r.key,value:c.before}:r;});
 output.push(...e.removed);output.sort((a,b)=>id(a)<id(b)?-1:1);
 for(const row of e.additions)removedCounts[countKeys[row.kind]]++;
 for(const row of e.removed)restoredCounts[countKeys[row.kind]]++;
 assert.equal(rows.length-output.length,e.additions.length-e.removed.length);
 return freeze({records:output,active:true,mode:compiled?'SOURCE_COMPILED_EXACT211_TO209':'DRAFT_EXACT211_TO209',removed_records:e.additions.length,restored_records:e.removed.length,changed_records:e.changes.length,removed_counts:removedCounts,restored_counts:restoredCounts,...status,authority:false});
}
export function projectReturnCredit211RecordSet(input,candidate){
 assert.equal(arguments.length,2,'211 explicit draft expectation required');
 return projectRecords(input,validateReturnCredit211DraftContract(candidate),RETURN_CREDIT211_DRAFT_STATUS,false);
}
export function projectCompiledReturnCredit211RecordSet(input){
 assert.equal(arguments.length,1,'211 fixed source contract takes no caller expectation');
 return projectRecords(input,RETURN_CREDIT211_SOURCE_CONTRACT,RETURN_CREDIT211_SOURCE_STATUS,true);
}
export function projectReturnCredit211Catalogue(value,candidate){
 assert.equal(arguments.length,2,'211 no default runtime contract');
 const input=validateRecoverySchema(value),p=projectReturnCredit211RecordSet(input.records,candidate);
 return projectedCatalogue(input,p);
}
export function projectCompiledReturnCredit211Catalogue(value){
 assert.equal(arguments.length,1,'211 fixed source contract takes no caller expectation');
 const input=validateRecoverySchema(value),p=projectCompiledReturnCredit211RecordSet(input.records);
 return projectedCatalogue(input,p);
}
function projectedCatalogue(input,p){
 if(!p.active)return freeze({...p,catalogue:input});
 const counts={...input.counts};
 for(const key of Object.values(countKeys)){
  assert(Number.isSafeInteger(counts[key])&&counts[key]>=p.removed_counts[key],'211 count underflow');
  counts[key]=counts[key]-p.removed_counts[key]+p.restored_counts[key];
 }
 const body={schema:input.schema,postgres_major:input.postgres_major,scope:[...input.scope],sql_sha256:input.sql_sha256,counts,records:p.records};
 const catalogue=validateRecoverySchema({...body,sha256:createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')});
 return freeze({...p,catalogue});
}
