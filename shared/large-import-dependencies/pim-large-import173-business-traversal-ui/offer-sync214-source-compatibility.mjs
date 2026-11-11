/** Exact independently compiled214 metadata inverse; no installation or business authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
import {OFFER_SYNC214_SOURCE_CONTRACT as E} from './offer-sync214-source-contract.mjs';
const identity=r=>r.kind+'\0'+r.key;
const countKeys={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',type:'types'};
const same=(a,b)=>JSON.stringify(canonical212(a))===JSON.stringify(canonical212(b));
const additions=new Map(E.additions.map(r=>[identity(r),r]));
function footprint(r){
 const family=/(?:^|[.:])_?offer_sync_commands?/;
 return family.test(r.key)
  ||['constraint','constraint_relation','table','function'].some(k=>typeof r.value[k]==='string'&&family.test(r.value[k]))
  ||r.kind==='constraint'&&/\bREFERENCES\s+(?:public\.)?offer_sync_commands?/.test(r.value.definition??'');
}
export function projectCompiledOfferSync214Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=original.records.some(r=>footprint(r)||additions.has(identity(r)));
 if(!active)return freeze212({catalogue:original,active:false,removed_records:0,changed_records:0,mode:'SOURCE214_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 for(const[key,expected]of additions)assert(same(rows.get(key),expected),'214 exact complete addition descriptor:'+key);
 for(const r of original.records)if(footprint(r))assert(additions.has(identity(r)),'214 unexpected command footprint');
 const records=original.records.filter(r=>!additions.has(identity(r))),counts={...original.counts};
 for(const r of E.additions){assert(Object.hasOwn(countKeys,r.kind));assert(counts[countKeys[r.kind]]>0);counts[countKeys[r.kind]]--;}
 const body={schema:original.schema,postgres_major:original.postgres_major,scope:[...original.scope],sql_sha256:original.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:E.additions.length,changed_records:0,mode:'SOURCE_COMPILED_EXACT214_TO213',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
