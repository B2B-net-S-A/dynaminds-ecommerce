/** Exact independently compiled266 inverse (own additions: the owner-private tables accountant266_memberships and accountant266_invitations with every record of their own (columns, constraints, PK indexes, row types, tenant policies and the RI triggers of their foreign keys, including those on memberships and workspace_invitations keyed internal:<fk>), the tenant table tenant_order_settings with its policy, and the functions accountant266_is_member(uuid) and accountant266_finance_member(uuid); one changed record, payment_allocation_access(uuid,uuid,boolean) (last written by 124, older than 217, so read back directly), gaining a session accountant; no removal) and the complete265..217 predecessor, each older changed record read back through its successor inverses. Metadata only; no installation or business authority. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
import {ACCOUNTANT_ORDER_SETTINGS266_SOURCE_CONTRACT as E} from './accountant-order-settings266-source-contract.mjs';
import {WMS_ORDER_LINE_RESIZE265_SOURCE_CONTRACT as E265} from './wms-order-line-resize265-source-contract.mjs';
import {ORDER_STATUS_LABELS264_SOURCE_CONTRACT as E264} from './order-status-labels264-source-contract.mjs';
import {MANUAL_OFF_VERDICT263_SOURCE_CONTRACT as E263} from './manual-off-verdict263-source-contract.mjs';
import {REVOKE_PUBLIC_TEMPORARY262_SOURCE_CONTRACT as E262} from './revoke-public-temporary262-source-contract.mjs';
import {STOCKTAKE_EVIDENCE_USAGE261_SOURCE_CONTRACT as E261} from './stocktake-evidence-usage261-source-contract.mjs';
import {AUTOMATION_RUNS_QUEUED_JOB260_SOURCE_CONTRACT as E260} from './automation-runs-queued-job260-source-contract.mjs';
import {JOBS_RUNNING_LEASE259_SOURCE_CONTRACT as E259} from './jobs-running-lease259-source-contract.mjs';
import {WZ_ISSUER258_SOURCE_CONTRACT as E258} from './wz-issuer258-source-contract.mjs';
import {ORDER_MERGE_SNAPSHOT257_SOURCE_CONTRACT as E257} from './order-merge-snapshot257-source-contract.mjs';
import {RETURN_RECEIPT_VERDICTS256_SOURCE_CONTRACT as E256} from './return-receipt-verdicts256-source-contract.mjs';
import {STOCK_VERDICT255_SOURCE_CONTRACT as E255} from './stock-verdict255-source-contract.mjs';
import {CARRIER_RETURNS254_SOURCE_CONTRACT as E254} from './carrier-returns254-source-contract.mjs';
import {MIRAKL_WEBHOOK_RETENTION253_SOURCE_CONTRACT as E253} from './mirakl-webhook-retention253-source-contract.mjs';
import {MIRAKL_OPERATIONS252_SOURCE_CONTRACT as E252} from './mirakl-operations252-source-contract.mjs';
import {B2B_NETWORK_LIFECYCLE251_SOURCE_CONTRACT as E251} from './b2b-network-lifecycle251-source-contract.mjs';
import {WMS_EVIDENCE_SETTLE250_SOURCE_CONTRACT as E250} from './wms-evidence-settle250-source-contract.mjs';
import {CATALOG_AI249_SOURCE_CONTRACT as E249} from './catalog-ai249-source-contract.mjs';
import {GUARD_VERDICTS248_SOURCE_CONTRACT as E248} from './guard-verdicts248-source-contract.mjs';
import {SALES_DIMENSIONS_REPRICING247_SOURCE_CONTRACT as E247} from './sales-dimensions-repricing247-source-contract.mjs';
import {B2B_TRADE_CREDIT_DIRECTORY246_SOURCE_CONTRACT as E246} from './b2b-trade-credit-directory246-source-contract.mjs';
import {S5_COMM245_SOURCE_CONTRACT as E245} from './s5-comm245-source-contract.mjs';
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
const same=(a,b)=>JSON.stringify(canonical212(a))===JSON.stringify(canonical212(b));
const countKeys={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types',sequence:'sequences'};
const additions=new Map(E.additions.map(r=>[identity(r),r])),changes=new Map(E.changes.map(r=>[identity(r.after),r]));
assert.equal(E.additions.length,60,'266 adds the 60 records of its three tables and two functions');assert.deepEqual(E.changes.map(c=>identity(c.after)),['function\0public.payment_allocation_access(uid uuid, kid uuid, pin boolean)'],'266 changes only payment_allocation_access');
// 266 adds its tables and functions and changes the 124 body of payment_allocation_access (older than 217, so read back directly); older changed records are read back through each successor inverse: 265 (the 108 wms_row_guard), 264 (none), 263 (none), 262 (none), 261 (the two 149 bodies stocktake_adjustment_budget/_manifest), 260 (none), 259 (none), 258 (wz_issuer239_verdict), 257 (the Source209 snapshot), 256 (none), 255 (none), 254 (none), 253 (none), 252 (none), 251 (none), 250 (the 235 settle), 249 (none), 248 (none), 247 (none), 246 (seven force_row_security flags), 245, 244, 243 and 242 (none), 241 (three functions), 240 (two functions), 239, 238, 237, 236 and 235 (none), 234 (two functions), 233, 232 and 231 (the 229 CHECK).
const inverses=[E265.changes,E264.changes,E263.changes,E262.changes,E261.changes,E260.changes,E259.changes,E258.changes,E257.changes,E256.changes,E255.changes,E254.changes,E253.changes,E252.changes,E251.changes,E250.changes,E249.changes,E248.changes,E247.changes,E246.changes,E245.changes,E244.changes,E243.changes,E242.changes,E241.changes,E240.changes,E239.changes,E238.changes,E237.changes,E236.changes,E235.changes,E234.changes,E233.changes,E232.changes,E231.changes].map(list=>new Map(list.map(r=>[identity(r.after),r])));
function footprint(r){
 // The plain name prefixes accountant266_ and tenant_order_settings (the prefix form of CUSTOM-EVENTS244) right after a dot,
 // colon or quote: the tables, their columns, constraints, indexes, row types, policies and triggers (the RI triggers on
 // memberships and workspace_invitations keyed by internal:<fk>), and the two functions. Nothing on 265 carries them; the
 // changed payment_allocation_access is matched as an exact changed record.
 const family=/(?:^|[.:"])_?(?:accountant266_|tenant_order_settings)/;
 return family.test(r.key)||['constraint','constraint_relation','table','function'].some(k=>typeof r.value[k]==='string'&&family.test(r.value[k]));
}
export function projectCompiledAccountantOrderSettings266Catalogue(input){
 assert.equal(arguments.length,1);
 const original=validateRecoverySchema(input),rows=new Map(original.records.map(r=>[identity(r),r]));
 // 266 is active when one of its own records or its changed body is present; any other body of payment_allocation_access is judged by
 // the inverse of the migration that wrote it.
 const active=original.records.some(r=>footprint(r)||additions.has(identity(r)))||E.changes.some(c=>rows.has(identity(c.after))&&same(rows.get(identity(c.after)),c.after));
 if(!active)return freeze212({catalogue:original,active:false,removed_records:0,changed_records:0,mode:'SOURCE266_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 // The record as it stood right after migration 265 (266 removes its additions and reads its changed record back), then each older successor inverse.
 const prior=new Map(original.records.filter(r=>!additions.has(identity(r))).map(r=>[identity(r),changes.get(identity(r))?.before??r]));
 const view=(k,depth)=>{let r=prior.get(k);for(let i=0;i<depth;i++){const x=inverses[i].get(k);if(x&&same(r,x.after))r=x.before;}return r;};
 for(const[key,expected]of additions)assert(same(rows.get(key),expected),'266 exact complete addition descriptor:'+key);
 for(const[key,change]of changes)assert(same(rows.get(key),change.after),'266 exact complete changed descriptor:'+key);
 for(const r of original.records)if(footprint(r))assert(additions.has(identity(r)),'266 unexpected footprint');
 for(const expected of [...E265.additions,...E265.changes.map(c=>c.after)])assert(same(view(identity(expected),0),expected),'266 requires complete265 predecessor:'+identity(expected));
 for(const expected of [...E264.additions,...E264.changes.map(c=>c.after)])assert(same(view(identity(expected),1),expected),'266 requires complete264 predecessor:'+identity(expected));
 for(const expected of [...E263.additions,...E263.changes.map(c=>c.after)])assert(same(view(identity(expected),2),expected),'266 requires complete263 predecessor:'+identity(expected));
 for(const expected of [...E262.additions,...E262.changes.map(c=>c.after)])assert(same(view(identity(expected),3),expected),'266 requires complete262 predecessor:'+identity(expected));
 for(const expected of [...E261.additions,...E261.changes.map(c=>c.after)])assert(same(view(identity(expected),4),expected),'266 requires complete261 predecessor:'+identity(expected));
 for(const expected of [...E260.additions,...E260.changes.map(c=>c.after)])assert(same(view(identity(expected),5),expected),'266 requires complete260 predecessor:'+identity(expected));
 for(const expected of [...E259.additions,...E259.changes.map(c=>c.after)])assert(same(view(identity(expected),6),expected),'266 requires complete259 predecessor:'+identity(expected));
 for(const expected of [...E258.additions,...E258.changes.map(c=>c.after)])assert(same(view(identity(expected),7),expected),'266 requires complete258 predecessor:'+identity(expected));
 for(const expected of [...E257.additions,...E257.changes.map(c=>c.after)])assert(same(view(identity(expected),8),expected),'266 requires complete257 predecessor:'+identity(expected));
 for(const expected of [...E256.additions,...E256.changes.map(c=>c.after)])assert(same(view(identity(expected),9),expected),'266 requires complete256 predecessor:'+identity(expected));
 for(const expected of [...E255.additions,...E255.changes.map(c=>c.after)])assert(same(view(identity(expected),10),expected),'266 requires complete255 predecessor:'+identity(expected));
 for(const expected of [...E254.additions,...E254.changes.map(c=>c.after)])assert(same(view(identity(expected),11),expected),'266 requires complete254 predecessor:'+identity(expected));
 for(const expected of [...E253.additions,...E253.changes.map(c=>c.after)])assert(same(view(identity(expected),12),expected),'266 requires complete253 predecessor:'+identity(expected));
 for(const expected of [...E252.additions,...E252.changes.map(c=>c.after)])assert(same(view(identity(expected),13),expected),'266 requires complete252 predecessor:'+identity(expected));
 for(const expected of [...E251.additions,...E251.changes.map(c=>c.after)])assert(same(view(identity(expected),14),expected),'266 requires complete251 predecessor:'+identity(expected));
 for(const expected of [...E250.additions,...E250.changes.map(c=>c.after)])assert(same(view(identity(expected),15),expected),'266 requires complete250 predecessor:'+identity(expected));
 for(const expected of [...E249.additions,...E249.changes.map(c=>c.after)])assert(same(view(identity(expected),16),expected),'266 requires complete249 predecessor:'+identity(expected));
 for(const expected of [...E248.additions,...E248.changes.map(c=>c.after)])assert(same(view(identity(expected),17),expected),'266 requires complete248 predecessor:'+identity(expected));
 for(const expected of [...E247.additions,...E247.changes.map(c=>c.after)])assert(same(view(identity(expected),18),expected),'266 requires complete247 predecessor:'+identity(expected));
 for(const expected of [...E246.additions,...E246.changes.map(c=>c.after)])assert(same(view(identity(expected),19),expected),'266 requires complete246 predecessor:'+identity(expected));
 for(const expected of [...E245.additions,...E245.changes.map(c=>c.after)])assert(same(view(identity(expected),20),expected),'266 requires complete245 predecessor:'+identity(expected));
 for(const expected of [...E244.additions,...E244.changes.map(c=>c.after)])assert(same(view(identity(expected),21),expected),'266 requires complete244 predecessor:'+identity(expected));
 for(const expected of [...E243.additions,...E243.changes.map(c=>c.after)])assert(same(view(identity(expected),22),expected),'266 requires complete243 predecessor:'+identity(expected));
 for(const expected of [...E242.additions,...E242.changes.map(c=>c.after)])assert(same(view(identity(expected),23),expected),'266 requires complete242 predecessor:'+identity(expected));
 for(const expected of [...E241.additions,...E241.changes.map(c=>c.after)])assert(same(view(identity(expected),24),expected),'266 requires complete241 predecessor:'+identity(expected));
 for(const expected of [...E240.additions,...E240.changes.map(c=>c.after)])assert(same(view(identity(expected),25),expected),'266 requires complete240 predecessor:'+identity(expected));
 for(const expected of [...E239.additions,...E239.changes.map(c=>c.after)])assert(same(view(identity(expected),26),expected),'266 requires complete239 predecessor:'+identity(expected));
 for(const expected of [...E238.additions,...E238.changes.map(c=>c.after)])assert(same(view(identity(expected),27),expected),'266 requires complete238 predecessor:'+identity(expected));
 for(const expected of [...E237.additions,...E237.changes.map(c=>c.after)])assert(same(view(identity(expected),28),expected),'266 requires complete237 predecessor:'+identity(expected));
 for(const expected of [...E236.additions,...E236.changes.map(c=>c.after)])assert(same(view(identity(expected),29),expected),'266 requires complete236 predecessor:'+identity(expected));
 for(const expected of [...E235.additions,...E235.changes.map(c=>c.after)])assert(same(view(identity(expected),30),expected),'266 requires complete235 predecessor:'+identity(expected));
 for(const expected of [...E234.additions,...E234.changes.map(c=>c.after)])assert(same(view(identity(expected),31),expected),'266 requires complete234 predecessor:'+identity(expected));
 for(const expected of [...E233.additions,...E233.changes.map(c=>c.after)])assert(same(view(identity(expected),32),expected),'266 requires complete233 predecessor:'+identity(expected));
 for(const expected of [...E232.additions,...E232.changes.map(c=>c.after)])assert(same(view(identity(expected),33),expected),'266 requires complete232 predecessor:'+identity(expected));
 for(const expected of E231.changes.map(c=>c.after))assert(same(view(identity(expected),34),expected),'266 requires complete231 predecessor:'+identity(expected));
 for(const expected of E230.additions)assert(same(view(identity(expected),35),expected),'266 requires complete230 predecessor:'+identity(expected));
 for(const expected of E229.additions)assert(same(view(identity(expected),35),expected),'266 requires complete229 predecessor:'+identity(expected));
 for(const expected of E228.additions)assert(same(view(identity(expected),35),expected),'266 requires complete228 predecessor:'+identity(expected));
 for(const expected of E227.additions)assert(same(view(identity(expected),35),expected),'266 requires complete227 predecessor:'+identity(expected));
 for(const expected of E226.additions)assert(same(view(identity(expected),35),expected),'266 requires complete226 predecessor:'+identity(expected));
 for(const expected of E225.additions)assert(same(view(identity(expected),35),expected),'266 requires complete225 predecessor:'+identity(expected));
 for(const expected of E224.additions)assert(same(view(identity(expected),35),expected),'266 requires complete224 predecessor:'+identity(expected));
 for(const expected of E223.additions)assert(same(view(identity(expected),35),expected),'266 requires complete223 predecessor:'+identity(expected));
 for(const expected of E222.additions)assert(same(view(identity(expected),35),expected),'266 requires complete222 predecessor:'+identity(expected));
 for(const expected of E221.additions)assert(same(view(identity(expected),35),expected),'266 requires complete221 predecessor:'+identity(expected));
 for(const expected of E220.additions)assert(same(view(identity(expected),35),expected),'266 requires complete220 predecessor:'+identity(expected));
 for(const expected of E219.additions)assert(same(view(identity(expected),35),expected),'266 requires complete219 predecessor:'+identity(expected));
 for(const expected of E218.additions)assert(same(view(identity(expected),35),expected),'266 requires complete218 predecessor:'+identity(expected));
 for(const expected of [...E217.additions,...E217.changes.map(c=>c.after)])assert(same(view(identity(expected),35),expected),'266 requires complete217 predecessor:'+identity(expected));
 const records=original.records.filter(r=>!additions.has(identity(r))).map(r=>changes.get(identity(r))?.before??r),counts={...original.counts};
 for(const r of E.additions){assert(Object.hasOwn(countKeys,r.kind));assert(counts[countKeys[r.kind]]>0);counts[countKeys[r.kind]]--;}
 const body={schema:original.schema,postgres_major:original.postgres_major,scope:[...original.scope],sql_sha256:original.sql_sha256,counts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:E.additions.length,changed_records:E.changes.length,mode:'SOURCE_COMPILED_EXACT266_TO265',source_compilation_proven:true,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
