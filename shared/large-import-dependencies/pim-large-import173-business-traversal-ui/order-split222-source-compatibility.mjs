/** Exact independently compiled222 inverse and full221/220/219/218/217 predecessors. No installation authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
import {ORDER_SPLIT222_SOURCE_CONTRACT as E} from './order-split222-source-contract.mjs';
import {BASE_WIRE221_SOURCE_CONTRACT as E221} from './base-wire221-source-contract.mjs';
import {BASE_WIRE220_SOURCE_CONTRACT as E220} from './base-wire220-source-contract.mjs';
import {CRM219_SOURCE_CONTRACT as E219} from './crm219-source-contract.mjs';
import {CRM218_SOURCE_CONTRACT as E218} from './crm218-source-contract.mjs';
import {CRM217_SOURCE_CONTRACT as E217} from './crm217-source-contract.mjs';
const identity=r=>r.kind+'\0'+r.key;
const countKeys={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types',sequence:'sequences'};
const same=(a,b)=>JSON.stringify(canonical212(a))===JSON.stringify(canonical212(b));
const additions=new Map(E.additions.map(r=>[identity(r),r])),changes=new Map(E.changes.map(r=>[identity(r.after),r]));
function footprint(r){
 const family=/(?:^|[.:])_?order_split222_/;
 return family.test(r.key)||['constraint','constraint_relation','table','function'].some(k=>typeof r.value[k]==='string'&&family.test(r.value[k]))
  ||r.kind==='constraint'&&/\bREFERENCES\s+(?:public\.)?order_split222_/.test(r.value.definition??'');
}
export function projectCompiledOrderSplit222Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=original.records.some(r=>footprint(r)||additions.has(identity(r)))||E.changes.some(c=>rows.has(identity(c.before))&&!same(rows.get(identity(c.before)),c.before));
 if(!active)return freeze212({catalogue:original,active:false,removed_records:0,changed_records:0,mode:'SOURCE222_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 for(const[key,expected]of additions)assert(same(rows.get(key),expected),'222 exact complete addition descriptor:'+key);
 for(const[key,change]of changes)assert(same(rows.get(key),change.after),'222 exact complete changed descriptor:'+key);
 for(const r of original.records)if(footprint(r))assert(additions.has(identity(r)),'222 unexpected footprint');
 for(const expected of E221.additions)assert(same(changes.get(identity(expected))?.before??rows.get(identity(expected)),expected),'222 requires complete221 predecessor:'+identity(expected));
 for(const expected of E220.additions)assert(same(changes.get(identity(expected))?.before??rows.get(identity(expected)),expected),'222 requires complete220 predecessor:'+identity(expected));
 for(const expected of E219.additions)assert(same(changes.get(identity(expected))?.before??rows.get(identity(expected)),expected),'222 requires complete219 predecessor:'+identity(expected));
 for(const expected of E218.additions)assert(same(changes.get(identity(expected))?.before??rows.get(identity(expected)),expected),'222 requires complete218 predecessor:'+identity(expected));
 for(const expected of [...E217.additions,...E217.changes.map(c=>c.after)])assert(same(changes.get(identity(expected))?.before??rows.get(identity(expected)),expected),'222 requires complete217 predecessor:'+identity(expected));
 const records=original.records.filter(r=>!additions.has(identity(r))).map(r=>changes.get(identity(r))?.before??r),counts={...original.counts};
 for(const r of E.additions){assert(Object.hasOwn(countKeys,r.kind));assert(counts[countKeys[r.kind]]>0);counts[countKeys[r.kind]]--;}
 const body={schema:original.schema,postgres_major:original.postgres_major,scope:[...original.scope],sql_sha256:original.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:E.additions.length,changed_records:E.changes.length,mode:'SOURCE_COMPILED_EXACT222_TO221',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
