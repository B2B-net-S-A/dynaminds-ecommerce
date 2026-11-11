/** Exact source-compiled 213 inverse. Metadata only; never installation or write authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
import {LOCAL_WOO_READ213_SOURCE_CONTRACT as E} from './local-woo-read213-source-contract.mjs';
const identity=r=>r.kind+'\0'+r.key;
const countKeys={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',type:'types'};
const same=(a,b)=>JSON.stringify(canonical212(a))===JSON.stringify(canonical212(b));
const expectedAdded=new Map(E.additions.map(r=>[identity(r),r]));
const expectedChanged=new Map(E.changes.map(r=>[identity(r.after),r]));
function footprint(r){
 const family=/(?:^|[.:])_?local_woo_read_(?:reconciliations?|occurrence_reconciliation_identity|dispatch_reconciliation_identity)/;
 return family.test(r.key)
  ||['constraint','constraint_relation','table','function'].some(k=>typeof r.value[k]==='string'&&family.test(r.value[k]))
  ||r.kind==='constraint'&&/\bREFERENCES\s+(?:public\.)?local_woo_read_reconciliation/.test(r.value.definition??'');
}
export function projectCompiledLocalWooRead213Catalogue(input){
 assert.equal(arguments.length,1);const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=original.records.some(r=>footprint(r)||expectedAdded.has(identity(r))||expectedChanged.has(identity(r))&&same(r,expectedChanged.get(identity(r)).after));
 if(!active){
  // A missing receipt table cannot hide a partially applied constraint/index change.
  const predecessorPresent=rows.has('relation\0public.local_woo_read_occurrences')||[...expectedChanged.keys()].some(key=>rows.has(key));
  if(predecessorPresent)for(const [key,pair]of expectedChanged)assert(same(rows.get(key),pair.before),'213 absent predecessor descriptor missing or differs');
  return freeze212({catalogue:original,active:false,removed_records:0,changed_records:0,mode:'SOURCE213_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 }
 for(const [key,expected]of expectedAdded)assert(same(rows.get(key),expected),'213 exact complete addition descriptor:'+key);
 for(const [key,pair]of expectedChanged)assert(same(rows.get(key),pair.after),'213 exact complete changed descriptor:'+key);
 for(const r of original.records)if(footprint(r))assert(expectedAdded.has(identity(r))||expectedChanged.has(identity(r)),'213 unexpected receipt footprint');
 const records=original.records.filter(r=>!expectedAdded.has(identity(r))).map(r=>expectedChanged.get(identity(r))?.before??r),counts={...original.counts};
 for(const r of E.additions){assert(Object.hasOwn(countKeys,r.kind));assert(counts[countKeys[r.kind]]>0);counts[countKeys[r.kind]]--;}
 const body={schema:original.schema,postgres_major:original.postgres_major,scope:[...original.scope],sql_sha256:original.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:E.additions.length,changed_records:E.changes.length,mode:'SOURCE_COMPILED_EXACT213_TO212',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
