/** Exact independently compiled240 inverse (one changed record: the own buyer_available236() read back to its 236 body; no addition, no removal, no buyer_address_ object) and full239/238/237/236/235/234/233/232/231/230/229/228/227/226/225/224/223/222/221/220/219/218/217 predecessors. No installation authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
import {BUYER_AVAILABLE240_SOURCE_CONTRACT as E} from './buyer-available240-source-contract.mjs';
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
// Changed records are read back through each successor inverse: 240 (buyer_available236()), 239, 238, 237, 236 and 235 (none), 234 (two functions), 233, 232 and 231 (the 229 CHECK).
const inverses=[E.changes,E239.changes,E238.changes,E237.changes,E236.changes,E235.changes,E234.changes,E233.changes,E232.changes,E231.changes].map(list=>new Map(list.map(r=>[identity(r.after),r])));
// 240 adds no object of its own; it is active exactly when buyer_available236() is not the 236 record.
export function projectCompiledBuyerAvailable240Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 const active=original.records.some(r=>additions.has(identity(r)))||E.changes.some(c=>rows.has(identity(c.before))&&!same(rows.get(identity(c.before)),c.before));
 if(!active)return freeze212({catalogue:original,active:false,removed_records:0,changed_records:0,mode:'SOURCE240_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 // The record as it stood right after migration 240-depth.
 const view=(k,depth)=>{let r=rows.get(k);for(let i=0;i<depth;i++){const x=inverses[i].get(k);if(x&&same(r,x.after))r=x.before;}return r;};
 for(const[key,expected]of additions)assert(same(rows.get(key),expected),'240 exact complete addition descriptor:'+key);
 for(const[key,change]of changes)assert(same(rows.get(key),change.after),'240 exact complete changed descriptor:'+key);
 for(const expected of [...E239.additions,...E239.changes.map(c=>c.after)])assert(same(view(identity(expected),1),expected),'240 requires complete239 predecessor:'+identity(expected));
 for(const expected of [...E238.additions,...E238.changes.map(c=>c.after)])assert(same(view(identity(expected),2),expected),'240 requires complete238 predecessor:'+identity(expected));
 for(const expected of [...E237.additions,...E237.changes.map(c=>c.after)])assert(same(view(identity(expected),3),expected),'240 requires complete237 predecessor:'+identity(expected));
 for(const expected of [...E236.additions,...E236.changes.map(c=>c.after)])assert(same(view(identity(expected),4),expected),'240 requires complete236 predecessor:'+identity(expected));
 for(const expected of [...E235.additions,...E235.changes.map(c=>c.after)])assert(same(view(identity(expected),5),expected),'240 requires complete235 predecessor:'+identity(expected));
 for(const expected of [...E234.additions,...E234.changes.map(c=>c.after)])assert(same(view(identity(expected),6),expected),'240 requires complete234 predecessor:'+identity(expected));
 for(const expected of [...E233.additions,...E233.changes.map(c=>c.after)])assert(same(view(identity(expected),7),expected),'240 requires complete233 predecessor:'+identity(expected));
 for(const expected of [...E232.additions,...E232.changes.map(c=>c.after)])assert(same(view(identity(expected),8),expected),'240 requires complete232 predecessor:'+identity(expected));
 for(const expected of E231.changes.map(c=>c.after))assert(same(view(identity(expected),9),expected),'240 requires complete231 predecessor:'+identity(expected));
 for(const expected of E230.additions)assert(same(view(identity(expected),10),expected),'240 requires complete230 predecessor:'+identity(expected));
 for(const expected of E229.additions)assert(same(view(identity(expected),10),expected),'240 requires complete229 predecessor:'+identity(expected));
 for(const expected of E228.additions)assert(same(view(identity(expected),10),expected),'240 requires complete228 predecessor:'+identity(expected));
 for(const expected of E227.additions)assert(same(view(identity(expected),10),expected),'240 requires complete227 predecessor:'+identity(expected));
 for(const expected of E226.additions)assert(same(view(identity(expected),10),expected),'240 requires complete226 predecessor:'+identity(expected));
 for(const expected of E225.additions)assert(same(view(identity(expected),10),expected),'240 requires complete225 predecessor:'+identity(expected));
 for(const expected of E224.additions)assert(same(view(identity(expected),10),expected),'240 requires complete224 predecessor:'+identity(expected));
 for(const expected of E223.additions)assert(same(view(identity(expected),10),expected),'240 requires complete223 predecessor:'+identity(expected));
 for(const expected of E222.additions)assert(same(view(identity(expected),10),expected),'240 requires complete222 predecessor:'+identity(expected));
 for(const expected of E221.additions)assert(same(view(identity(expected),10),expected),'240 requires complete221 predecessor:'+identity(expected));
 for(const expected of E220.additions)assert(same(view(identity(expected),10),expected),'240 requires complete220 predecessor:'+identity(expected));
 for(const expected of E219.additions)assert(same(view(identity(expected),10),expected),'240 requires complete219 predecessor:'+identity(expected));
 for(const expected of E218.additions)assert(same(view(identity(expected),10),expected),'240 requires complete218 predecessor:'+identity(expected));
 for(const expected of [...E217.additions,...E217.changes.map(c=>c.after)])assert(same(view(identity(expected),10),expected),'240 requires complete217 predecessor:'+identity(expected));
 const records=original.records.filter(r=>!additions.has(identity(r))).map(r=>changes.get(identity(r))?.before??r),counts={...original.counts};
 for(const r of E.additions){assert(Object.hasOwn(countKeys,r.kind));assert(counts[countKeys[r.kind]]>0);counts[countKeys[r.kind]]--;}
 const body={schema:original.schema,postgres_major:original.postgres_major,scope:[...original.scope],sql_sha256:original.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:E.additions.length,changed_records:E.changes.length,mode:'SOURCE_COMPILED_EXACT240_TO239',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
