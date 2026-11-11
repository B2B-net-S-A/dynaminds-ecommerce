/** Exact independently compiled234 inverse (the replaced order_shipments_guard() and shopify_capture_dispatch() read back to their 134/108 bodies; the own DHL pickup table dhl234_pickups) and full233/232/231/230/229/228/227/226/225/224/223/222/221/220/219/218/217 predecessors. No installation authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
import {CARRIERS234_SOURCE_CONTRACT as E} from './carriers234-source-contract.mjs';
import {FISCAL_RECEIPTS233_SOURCE_CONTRACT as E233} from './fiscal-receipts233-source-contract.mjs';
import {INVOICE_CORRECTIONS232_SOURCE_CONTRACT as E232} from './invoice-corrections232-source-contract.mjs';
import {KSEF_INVOICE231_SOURCE_CONTRACT as E231} from './ksef-invoice231-source-contract.mjs';
import {INVOICE230_SOURCE_CONTRACT as E230} from './invoice230-source-contract.mjs';
import {KSEF229_SOURCE_CONTRACT as E229} from './ksef229-source-contract.mjs';
import {RODO228_SOURCE_CONTRACT as E228} from './rodo228-source-contract.mjs';
import {NBP_RATES227_SOURCE_CONTRACT as E227} from './nbp-rates227-source-contract.mjs';
import {TAX_MODEL226_SOURCE_CONTRACT as E226} from './tax-model226-source-contract.mjs';
import {PRODUCT_DELETIONS225_SOURCE_CONTRACT as E225} from './product-deletions225-source-contract.mjs';
import {BASE_WIRE_CATEGORIES224_SOURCE_CONTRACT as E224} from './base-wire-categories224-source-contract.mjs';
import {RETURN_REASONS223_SOURCE_CONTRACT as E223} from './return-reasons223-source-contract.mjs';
import {ORDER_SPLIT222_SOURCE_CONTRACT as E222} from './order-split222-source-contract.mjs';
import {BASE_WIRE221_SOURCE_CONTRACT as E221} from './base-wire221-source-contract.mjs';
import {BASE_WIRE220_SOURCE_CONTRACT as E220} from './base-wire220-source-contract.mjs';
import {CRM219_SOURCE_CONTRACT as E219} from './crm219-source-contract.mjs';
import {CRM218_SOURCE_CONTRACT as E218} from './crm218-source-contract.mjs';
import {CRM217_SOURCE_CONTRACT as E217} from './crm217-source-contract.mjs';
const identity=r=>r.kind+'\0'+r.key;
const countKeys={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types',sequence:'sequences'};
const same=(a,b)=>JSON.stringify(canonical212(a))===JSON.stringify(canonical212(b));
const additions=new Map(E.additions.map(r=>[identity(r),r])),changes=new Map(E.changes.map(r=>[identity(r.after),r]));
// Changed records are read back through each successor inverse: 234 (two functions), 233, 232 and 231 (the 229 CHECK).
const inverses=[E.changes,E233.changes,E232.changes,E231.changes].map(list=>new Map(list.map(r=>[identity(r.after),r])));
function footprint(r){
 const family=/(?:^|[.:])_?dhl234_/;
 return family.test(r.key)||['constraint','constraint_relation','table','function'].some(k=>typeof r.value[k]==='string'&&family.test(r.value[k]))
  ||r.kind==='constraint'&&/\bREFERENCES\s+(?:public\.)?dhl234_/.test(r.value.definition??'');
}
export function projectCompiledCarriers234Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=original.records.some(r=>footprint(r)||additions.has(identity(r)))||E.changes.some(c=>rows.has(identity(c.before))&&!same(rows.get(identity(c.before)),c.before));
 if(!active)return freeze212({catalogue:original,active:false,removed_records:0,changed_records:0,mode:'SOURCE234_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 // The record as it stood right after migration 234-depth.
 const view=(k,depth)=>{let r=rows.get(k);for(let i=0;i<depth;i++){const x=inverses[i].get(k);if(x&&same(r,x.after))r=x.before;}return r;};
 for(const[key,expected]of additions)assert(same(rows.get(key),expected),'234 exact complete addition descriptor:'+key);
 for(const[key,change]of changes)assert(same(rows.get(key),change.after),'234 exact complete changed descriptor:'+key);
 for(const r of original.records)if(footprint(r))assert(additions.has(identity(r)),'234 unexpected footprint');
 for(const expected of [...E233.additions,...E233.changes.map(c=>c.after)])assert(same(view(identity(expected),1),expected),'234 requires complete233 predecessor:'+identity(expected));
 for(const expected of [...E232.additions,...E232.changes.map(c=>c.after)])assert(same(view(identity(expected),2),expected),'234 requires complete232 predecessor:'+identity(expected));
 for(const expected of E231.changes.map(c=>c.after))assert(same(view(identity(expected),3),expected),'234 requires complete231 predecessor:'+identity(expected));
 for(const expected of E230.additions)assert(same(view(identity(expected),4),expected),'234 requires complete230 predecessor:'+identity(expected));
 for(const expected of E229.additions)assert(same(view(identity(expected),4),expected),'234 requires complete229 predecessor:'+identity(expected));
 for(const expected of E228.additions)assert(same(view(identity(expected),4),expected),'234 requires complete228 predecessor:'+identity(expected));
 for(const expected of E227.additions)assert(same(view(identity(expected),4),expected),'234 requires complete227 predecessor:'+identity(expected));
 for(const expected of E226.additions)assert(same(view(identity(expected),4),expected),'234 requires complete226 predecessor:'+identity(expected));
 for(const expected of E225.additions)assert(same(view(identity(expected),4),expected),'234 requires complete225 predecessor:'+identity(expected));
 for(const expected of E224.additions)assert(same(view(identity(expected),4),expected),'234 requires complete224 predecessor:'+identity(expected));
 for(const expected of E223.additions)assert(same(view(identity(expected),4),expected),'234 requires complete223 predecessor:'+identity(expected));
 for(const expected of E222.additions)assert(same(view(identity(expected),4),expected),'234 requires complete222 predecessor:'+identity(expected));
 for(const expected of E221.additions)assert(same(view(identity(expected),4),expected),'234 requires complete221 predecessor:'+identity(expected));
 for(const expected of E220.additions)assert(same(view(identity(expected),4),expected),'234 requires complete220 predecessor:'+identity(expected));
 for(const expected of E219.additions)assert(same(view(identity(expected),4),expected),'234 requires complete219 predecessor:'+identity(expected));
 for(const expected of E218.additions)assert(same(view(identity(expected),4),expected),'234 requires complete218 predecessor:'+identity(expected));
 for(const expected of [...E217.additions,...E217.changes.map(c=>c.after)])assert(same(view(identity(expected),4),expected),'234 requires complete217 predecessor:'+identity(expected));
 const records=original.records.filter(r=>!additions.has(identity(r))).map(r=>changes.get(identity(r))?.before??r),counts={...original.counts};
 for(const r of E.additions){assert(Object.hasOwn(countKeys,r.kind));assert(counts[countKeys[r.kind]]>0);counts[countKeys[r.kind]]--;}
 const body={schema:original.schema,postgres_major:original.postgres_major,scope:[...original.scope],sql_sha256:original.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:E.additions.length,changed_records:E.changes.length,mode:'SOURCE_COMPILED_EXACT234_TO233',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
