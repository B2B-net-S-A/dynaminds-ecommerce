/** Exact independently compiled217 inverse and full216/215 predecessors. No installation authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
import {CRM217_SOURCE_CONTRACT as E} from './crm217-source-contract.mjs';
import {LOCAL_WOO_ORDER_IMPORT216_SOURCE_CONTRACT as E216} from './local-woo-order-import216-source-contract.mjs';
import {CRM215_SOURCE_CONTRACT as E215} from './crm215-source-contract.mjs';
const identity=r=>r.kind+'\0'+r.key;
const countKeys={relation:'relations',column:'columns',constraint:'constraints',index:'indexes'};
const same=(a,b)=>JSON.stringify(canonical212(a))===JSON.stringify(canonical212(b));
const additions=new Map(E.additions.map(r=>[identity(r),r])),changes=new Map(E.changes.map(r=>[identity(r.after),r]));
function footprint(r){
 return /(?:^|[.:])_?crm217_/.test(r.key)||/^public\.crm_values_field_definition_lookup(?:[._]|$)/.test(r.key)
  ||r.kind==='constraint'&&/^(?:crm_extra_fields_version_|crm_field_position_)/.test(r.key.split('.').at(-1));
}
export function projectCompiledCrm217Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=original.records.some(r=>footprint(r)||additions.has(identity(r)))||E.changes.some(c=>rows.has(identity(c.before))&&!same(rows.get(identity(c.before)),c.before));
 if(!active)return freeze212({catalogue:original,active:false,removed_records:0,changed_records:0,mode:'SOURCE217_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 for(const[key,expected]of additions)assert(same(rows.get(key),expected),'217 exact complete addition descriptor:'+key);
 for(const[key,change]of changes)assert(same(rows.get(key),change.after),'217 exact complete ACL-only changed descriptor:'+key);
 for(const r of original.records)if(footprint(r))assert(additions.has(identity(r)),'217 unexpected footprint');
 for(const expected of E216.additions)assert(same(rows.get(identity(expected)),expected),'217 requires complete216 predecessor:'+identity(expected));
 for(const expected of E215.additions)assert(same(changes.get(identity(expected))?.before??rows.get(identity(expected)),expected),'217 requires complete215 predecessor:'+identity(expected));
 const records=original.records.filter(r=>!additions.has(identity(r))).map(r=>changes.get(identity(r))?.before??r),counts={...original.counts};
 for(const r of E.additions){assert(Object.hasOwn(countKeys,r.kind));assert(counts[countKeys[r.kind]]>0);counts[countKeys[r.kind]]--;}
 const body={schema:original.schema,postgres_major:original.postgres_major,scope:[...original.scope],sql_sha256:original.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:E.additions.length,changed_records:E.changes.length,mode:'SOURCE_COMPILED_EXACT217_TO216',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
