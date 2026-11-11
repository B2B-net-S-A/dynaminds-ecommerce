/** Exact independently compiled245 inverse (only own additions: the two comm253_ per-order indexes on email_messages and sms_messages, which leave those relation records unchanged, and portal253_link_policies, inbound253_schedules, the append-only inbound253_matches, channel253_connections, channel253_threads and the append-only channel253_messages with their keys, checks, indexes, row types, tenant_scope policies and the RI triggers of the two own foreign keys; no function, no changed record, no core object) and full244/243/242/241/240/239/238/237/236/235/234/233/232/231/230/229/228/227/226/225/224/223/222/221/220/219/218/217 predecessors. No installation authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
import {S5_COMM245_SOURCE_CONTRACT as E} from './s5-comm245-source-contract.mjs';
import {CUSTOM_EVENTS_CHECKSUMS244_SOURCE_CONTRACT as E244} from './custom-events-checksums244-source-contract.mjs';
import {KSEF_PURCHASE243_SOURCE_CONTRACT as E243} from './ksef-purchase243-source-contract.mjs';
import {PAYU_SESSIONS242_SOURCE_CONTRACT as E242} from './payu-sessions242-source-contract.mjs';
import {VERDICT_GATES241_SOURCE_CONTRACT as E241} from './verdict-gates241-source-contract.mjs';
import {BUYER_AVAILABLE240_SOURCE_CONTRACT as E240} from './buyer-available240-source-contract.mjs';
import {WZ_ISSUER239_SOURCE_CONTRACT as E239} from './wz-issuer239-source-contract.mjs';
import {AUDIT_LOG238_SOURCE_CONTRACT as E238} from './audit-log238-source-contract.mjs';
import {AUTH_SECURITY237_SOURCE_CONTRACT as E237} from './auth-security237-source-contract.mjs';
import {BUYER_AVAILABLE236_SOURCE_CONTRACT as E236} from './buyer-available236-source-contract.mjs';
import {WMS_EVIDENCE_USAGE235_SOURCE_CONTRACT as E235} from './wms-evidence-usage235-source-contract.mjs';
import {CARRIERS234_SOURCE_CONTRACT as E234} from './carriers234-source-contract.mjs';
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
// 245 changes nothing; older changed records are read back through each successor inverse: 244, 243 and 242 (none), 241 (three functions), 240 (two functions), 239, 238, 237, 236 and 235 (none), 234 (two functions), 233, 232 and 231 (the 229 CHECK).
const inverses=[E244.changes,E243.changes,E242.changes,E241.changes,E240.changes,E239.changes,E238.changes,E237.changes,E236.changes,E235.changes,E234.changes,E233.changes,E232.changes,E231.changes].map(list=>new Map(list.map(r=>[identity(r.after),r])));
function footprint(r){
 // The plain name prefix (a \b form would miss _pkey/_key and index keys, CUSTOM-EVENTS244).
 const family=/(?:^|[.:"])_?(?:comm253|portal253|inbound253|channel253)_/;
 return family.test(r.key)||['constraint','constraint_relation','table','function'].some(k=>typeof r.value[k]==='string'&&family.test(r.value[k]))
  ||r.kind==='constraint'&&/\bREFERENCES\s+(?:public\.)?channel253_(?:connections|threads)\b/.test(r.value.definition??'');
}
export function projectCompiledS5Comm245Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=original.records.some(r=>footprint(r)||additions.has(identity(r)))||E.changes.some(c=>rows.has(identity(c.before))&&!same(rows.get(identity(c.before)),c.before));
 if(!active)return freeze212({catalogue:original,active:false,removed_records:0,changed_records:0,mode:'SOURCE245_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 // The record as it stood right after migration 244-depth (245 itself changes nothing).
 const view=(k,depth)=>{let r=rows.get(k);for(let i=0;i<depth;i++){const x=inverses[i].get(k);if(x&&same(r,x.after))r=x.before;}return r;};
 for(const[key,expected]of additions)assert(same(rows.get(key),expected),'245 exact complete addition descriptor:'+key);
 for(const[key,change]of changes)assert(same(rows.get(key),change.after),'245 exact complete changed descriptor:'+key);
 for(const r of original.records)if(footprint(r))assert(additions.has(identity(r)),'245 unexpected footprint');
 for(const expected of [...E244.additions,...E244.changes.map(c=>c.after)])assert(same(view(identity(expected),0),expected),'245 requires complete244 predecessor:'+identity(expected));
 for(const expected of [...E243.additions,...E243.changes.map(c=>c.after)])assert(same(view(identity(expected),1),expected),'245 requires complete243 predecessor:'+identity(expected));
 for(const expected of [...E242.additions,...E242.changes.map(c=>c.after)])assert(same(view(identity(expected),2),expected),'245 requires complete242 predecessor:'+identity(expected));
 for(const expected of [...E241.additions,...E241.changes.map(c=>c.after)])assert(same(view(identity(expected),3),expected),'245 requires complete241 predecessor:'+identity(expected));
 for(const expected of [...E240.additions,...E240.changes.map(c=>c.after)])assert(same(view(identity(expected),4),expected),'245 requires complete240 predecessor:'+identity(expected));
 for(const expected of [...E239.additions,...E239.changes.map(c=>c.after)])assert(same(view(identity(expected),5),expected),'245 requires complete239 predecessor:'+identity(expected));
 for(const expected of [...E238.additions,...E238.changes.map(c=>c.after)])assert(same(view(identity(expected),6),expected),'245 requires complete238 predecessor:'+identity(expected));
 for(const expected of [...E237.additions,...E237.changes.map(c=>c.after)])assert(same(view(identity(expected),7),expected),'245 requires complete237 predecessor:'+identity(expected));
 for(const expected of [...E236.additions,...E236.changes.map(c=>c.after)])assert(same(view(identity(expected),8),expected),'245 requires complete236 predecessor:'+identity(expected));
 for(const expected of [...E235.additions,...E235.changes.map(c=>c.after)])assert(same(view(identity(expected),9),expected),'245 requires complete235 predecessor:'+identity(expected));
 for(const expected of [...E234.additions,...E234.changes.map(c=>c.after)])assert(same(view(identity(expected),10),expected),'245 requires complete234 predecessor:'+identity(expected));
 for(const expected of [...E233.additions,...E233.changes.map(c=>c.after)])assert(same(view(identity(expected),11),expected),'245 requires complete233 predecessor:'+identity(expected));
 for(const expected of [...E232.additions,...E232.changes.map(c=>c.after)])assert(same(view(identity(expected),12),expected),'245 requires complete232 predecessor:'+identity(expected));
 for(const expected of E231.changes.map(c=>c.after))assert(same(view(identity(expected),13),expected),'245 requires complete231 predecessor:'+identity(expected));
 for(const expected of E230.additions)assert(same(view(identity(expected),14),expected),'245 requires complete230 predecessor:'+identity(expected));
 for(const expected of E229.additions)assert(same(view(identity(expected),14),expected),'245 requires complete229 predecessor:'+identity(expected));
 for(const expected of E228.additions)assert(same(view(identity(expected),14),expected),'245 requires complete228 predecessor:'+identity(expected));
 for(const expected of E227.additions)assert(same(view(identity(expected),14),expected),'245 requires complete227 predecessor:'+identity(expected));
 for(const expected of E226.additions)assert(same(view(identity(expected),14),expected),'245 requires complete226 predecessor:'+identity(expected));
 for(const expected of E225.additions)assert(same(view(identity(expected),14),expected),'245 requires complete225 predecessor:'+identity(expected));
 for(const expected of E224.additions)assert(same(view(identity(expected),14),expected),'245 requires complete224 predecessor:'+identity(expected));
 for(const expected of E223.additions)assert(same(view(identity(expected),14),expected),'245 requires complete223 predecessor:'+identity(expected));
 for(const expected of E222.additions)assert(same(view(identity(expected),14),expected),'245 requires complete222 predecessor:'+identity(expected));
 for(const expected of E221.additions)assert(same(view(identity(expected),14),expected),'245 requires complete221 predecessor:'+identity(expected));
 for(const expected of E220.additions)assert(same(view(identity(expected),14),expected),'245 requires complete220 predecessor:'+identity(expected));
 for(const expected of E219.additions)assert(same(view(identity(expected),14),expected),'245 requires complete219 predecessor:'+identity(expected));
 for(const expected of E218.additions)assert(same(view(identity(expected),14),expected),'245 requires complete218 predecessor:'+identity(expected));
 for(const expected of [...E217.additions,...E217.changes.map(c=>c.after)])assert(same(view(identity(expected),14),expected),'245 requires complete217 predecessor:'+identity(expected));
 const records=original.records.filter(r=>!additions.has(identity(r))).map(r=>changes.get(identity(r))?.before??r),counts={...original.counts};
 for(const r of E.additions){assert(Object.hasOwn(countKeys,r.kind));assert(counts[countKeys[r.kind]]>0);counts[countKeys[r.kind]]--;}
 const body={schema:original.schema,postgres_major:original.postgres_major,scope:[...original.scope],sql_sha256:original.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:E.additions.length,changed_records:E.changes.length,mode:'SOURCE_COMPILED_EXACT245_TO244',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
