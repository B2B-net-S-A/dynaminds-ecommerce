/** Actual Source242 descriptor (own payu242_ PayU session tables: configs, sessions, notifications and refunds with their keys, checks, indexes, row types and tenant_scope policies; no changed record, no foreign key, every core object untouched) and inverse attacks; no PG/app/provider. Real compiled catalogues are opt-in. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import{existsSync,readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{createHash}from'node:crypto';
import{INVOICE230_SOURCE_CONTRACT as E230,INVOICE230_SOURCE_ORIGIN as O230,INVOICE230_SQL as SQL230}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/invoice230-source-contract.mjs';
import{projectCompiledInvoice230Catalogue as project230}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/invoice230-source-compatibility.mjs';
import{KSEF_INVOICE231_SOURCE_CONTRACT as E231,KSEF_INVOICE231_SOURCE_ORIGIN as O231,KSEF_INVOICE231_SQL as SQL231}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ksef-invoice231-source-contract.mjs';
import{projectCompiledKsefInvoice231Catalogue as project231}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ksef-invoice231-source-compatibility.mjs';
import{INVOICE_CORRECTIONS232_SOURCE_CONTRACT as E232,INVOICE_CORRECTIONS232_SOURCE_ORIGIN as O232,INVOICE_CORRECTIONS232_SQL as SQL232}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/invoice-corrections232-source-contract.mjs';
import{projectCompiledInvoiceCorrections232Catalogue as project232}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/invoice-corrections232-source-compatibility.mjs';
import{FISCAL_RECEIPTS233_SOURCE_CONTRACT as E233,FISCAL_RECEIPTS233_SOURCE_ORIGIN as O233,FISCAL_RECEIPTS233_SQL as SQL233}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/fiscal-receipts233-source-contract.mjs';
import{projectCompiledFiscalReceipts233Catalogue as project233}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/fiscal-receipts233-source-compatibility.mjs';
import{KSEF229_SOURCE_CONTRACT as E229,KSEF229_SOURCE_ORIGIN as O229}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ksef229-source-contract.mjs';
import{projectCompiledKsef229Catalogue as project229}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ksef229-source-compatibility.mjs';
import{RODO228_SOURCE_CONTRACT as E228,RODO228_SOURCE_ORIGIN as O228}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/rodo228-source-contract.mjs';
import{projectCompiledRodo228Catalogue as project228}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/rodo228-source-compatibility.mjs';
import{NBP_RATES227_SOURCE_CONTRACT as E227}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/nbp-rates227-source-contract.mjs';
import{projectCompiledNbpRates227Catalogue as project227}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/nbp-rates227-source-compatibility.mjs';
import{TAX_MODEL226_SOURCE_CONTRACT as E226}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/tax-model226-source-contract.mjs';
import{projectCompiledTaxModel226Catalogue as project226}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/tax-model226-source-compatibility.mjs';
import{PRODUCT_DELETIONS225_SOURCE_CONTRACT as E225}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/product-deletions225-source-contract.mjs';
import{BASE_WIRE_CATEGORIES224_SOURCE_CONTRACT as E224}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire-categories224-source-contract.mjs';
import{projectCompiledBaseWireCategories224Catalogue as project224}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire-categories224-source-compatibility.mjs';
import{RETURN_REASONS223_SOURCE_CONTRACT as E223}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-reasons223-source-contract.mjs';
import{projectCompiledReturnReasons223Catalogue as project223}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-reasons223-source-compatibility.mjs';
import{ORDER_SPLIT222_SOURCE_CONTRACT as E222}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-split222-source-contract.mjs';
import{projectCompiledOrderSplit222Catalogue as project222}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-split222-source-compatibility.mjs';
import{BASE_WIRE221_SOURCE_CONTRACT as E221}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire221-source-contract.mjs';
import{projectCompiledBaseWire221Catalogue as project221}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire221-source-compatibility.mjs';
import{BASE_WIRE220_SOURCE_CONTRACT as E220}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire220-source-contract.mjs';
import{projectCompiledBaseWire220Catalogue as project220}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire220-source-compatibility.mjs';
import{CRM219_SOURCE_CONTRACT as E219}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm219-source-contract.mjs';
import{CRM218_SOURCE_CONTRACT as E218}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm218-source-contract.mjs';
import{projectCompiledCrm219Catalogue as project219}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm219-source-compatibility.mjs';
import{projectCompiledCrm218Catalogue as project218}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm218-source-compatibility.mjs';
import{CRM217_SOURCE_CONTRACT as E}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm217-source-contract.mjs';
import{projectCompiledCrm217Catalogue as project217}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm217-source-compatibility.mjs';
import{LOCAL_WOO_ORDER_IMPORT216_SOURCE_CONTRACT as E216}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-order-import216-source-contract.mjs';
import{CRM215_SOURCE_CONTRACT as E215}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm215-source-contract.mjs';
import{OFFER_SYNC214_SOURCE_CONTRACT as E214}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/offer-sync214-source-contract.mjs';
import{LOCAL_WOO_READ213_SOURCE_CONTRACT as E213}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read213-source-contract.mjs';
import{LOCAL_WOO_READ212_SOURCE_CONTRACT as E212,digest212}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read212-source-contract.mjs';
import{RETURN_CREDIT211_SOURCE_CONTRACT as E211}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-contract.mjs';
import{SCHEMA_VERSION,SQL_SHA256,validateRecoverySchema}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import{SOURCE_SELECTION}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
import{SCOPE}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
const clone=structuredClone,id=r=>r.kind+'\0'+r.key,counters={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types',sequence:'sequences'};
function seal(records){records=clone(records).sort((a,b)=>id(a)<id(b)?-1:1);const counts=Object.fromEntries(Object.keys(E.counts_before).map(k=>[k,k==='schemas'?[...SCOPE].sort():0]));for(const r of records)if(counters[r.kind])counts[counters[r.kind]]++;const body={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records};return{...body,sha256:digest212(body)};}function fixture(){const c232=new Map(E232.changes.map(x=>[id(x.after),x.after])),c231=new Map(E231.changes.map(x=>[id(x.after),x.after])),sample=k=>clone(E211.additions.find(r=>r.kind===k).value),base=[...SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}})),...SOURCE_SELECTION.required_tables.map(key=>({kind:'relation',key,value:sample('relation')})),...SOURCE_SELECTION.required_functions.map(key=>({kind:'function',key,value:sample('function')}))],c213=new Map(E213.changes.map(x=>[id(x.after),x.after])),before215=[...[...base,...clone(E212.additions)].map(r=>c213.get(id(r))??r),...clone(E213.additions),...clone(E214.additions)],before217=[...before215,...clone(E215.additions),...clone(E216.additions)],c217=new Map(E.changes.map(x=>[id(x.after),x.after])),before218=[...before217.map(r=>c217.get(id(r))??r),...clone(E.additions)],before219=[...before218,...clone(E218.additions)],before220=[...before219,...clone(E219.additions)],before221=[...before220,...clone(E220.additions)],before222=[...before221,...clone(E221.additions)],before223=[...before222,...clone(E222.additions)],before224=[...before223,...clone(E223.additions)],before225=[...before224,...clone(E224.additions)],before226=[...before225,...clone(E225.additions)],before227=[...before226,...clone(E226.additions)],before228=[...before227,...clone(E227.additions)],before229=[...before228,...clone(E228.additions)],before230=[...before229,...clone(E229.additions)];return{before217:seal(before217),before218:seal(before218),before219:seal(before219),before220:seal(before220),before221:seal(before221),before222:seal(before222),before223:seal(before223),before224:seal(before224),before225:seal(before225),before226:seal(before226),before227:seal(before227),before228:seal(before228),before229:seal(before229),before230:seal(before230),after230:seal([...before230,...clone(E230.additions)]),after231:seal([...before230,...clone(E230.additions)].map(r=>c231.get(id(r))??r)),after232:seal([...[...before230,...clone(E230.additions)].map(r=>c231.get(id(r))??r),...clone(E232.additions)].map(r=>c232.get(id(r))??r)),after:seal([...[...[...before230,...clone(E230.additions)].map(r=>c231.get(id(r))??r),...clone(E232.additions)].map(r=>c232.get(id(r))??r),...clone(E233.additions)])};}
import{CARRIERS234_SOURCE_CONTRACT as E234,CARRIERS234_SOURCE_ORIGIN as O234,CARRIERS234_SQL as SQL234}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/carriers234-source-contract.mjs';
import{projectCompiledCarriers234Catalogue as project234}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/carriers234-source-compatibility.mjs';
const family=/(?:^|[.:])_?dhl234_/,GUARD='function\0public.order_shipments_guard()',CAPTURE='function\0public.shopify_capture_dispatch()';
/** after233 with the two functions as 134/108 left them, and after234 with their 234 bodies and the own additions. */
function fixture234(){const f=fixture(),put=(records,list)=>{const m=new Map(records.map(r=>[id(r),r]));for(const r of list)m.set(id(r),clone(r));return[...m.values()];};
 const before=put(f.after.records,E234.changes.map(c=>c.before)),after=[...put(before,E234.changes.map(c=>c.after)),...clone(E234.additions)];
 return{before:seal(before),after:seal(after),after233:f.after};}
import{WMS_EVIDENCE_USAGE235_SOURCE_CONTRACT as E235,WMS_EVIDENCE_USAGE235_SOURCE_ORIGIN as O235,WMS_EVIDENCE_USAGE235_SQL as SQL235}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wms-evidence-usage235-source-contract.mjs';
import{projectCompiledWmsEvidenceUsage235Catalogue as project235}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wms-evidence-usage235-source-compatibility.mjs';
const own=/(?:^|[.:])_?wms_evidence_/,fingerprinted=['wms_operations','wms_cost_layers','wms_layer_movements','wms_issue_fragments','wms_return_fragments'];
/** after234 (the 234 functions and dhl234 additions on top of after233), and after235 with the own additions. */
function fixture235(){const f=fixture(),put=(records,list)=>{const m=new Map(records.map(r=>[id(r),r]));for(const r of list)m.set(id(r),clone(r));return[...m.values()];};
 const before=[...put(f.after.records,E234.changes.map(c=>c.after)),...clone(E234.additions)];
 return{before:seal(before),after:seal([...before,...clone(E235.additions)])};}
import{BUYER_AVAILABLE236_SOURCE_CONTRACT as E236,BUYER_AVAILABLE236_SOURCE_ORIGIN as O236,BUYER_AVAILABLE236_SQL as SQL236}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available236-source-contract.mjs';
import{projectCompiledBuyerAvailable236Catalogue as project236}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available236-source-compatibility.mjs';
const own236=/(?:^|[.:])_?buyer_available236(?:_|\()/;
/** after235 (fixture235().after), and after236 with the own additions. */
function fixture236(){const before=fixture235().after;return{before,after:seal([...before.records,...clone(E236.additions)])};}
import{AUTH_SECURITY237_SOURCE_CONTRACT as E237,AUTH_SECURITY237_SOURCE_ORIGIN as O237,AUTH_SECURITY237_SQL as SQL237}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/auth-security237-source-contract.mjs';
import{projectCompiledAuthSecurity237Catalogue as project237}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/auth-security237-source-compatibility.mjs';
const own237=/(?:^|[.:])_?auth237_/;
/** after236 (fixture236().after), and after237 with the own additions. */
function fixture237(){const before=fixture236().after;return{before,after:seal([...before.records,...clone(E237.additions)])};}
import{AUDIT_LOG238_SOURCE_CONTRACT as E238,AUDIT_LOG238_SOURCE_ORIGIN as O238,AUDIT_LOG238_SQL as SQL238}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/audit-log238-source-contract.mjs';
import{projectCompiledAuditLog238Catalogue as project238}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/audit-log238-source-compatibility.mjs';
const own238=/(?:^|[.:])_?audit238_/;
/** after237 (fixture237().after), and after238 with the own additions. */
function fixture238(){const before=fixture237().after;return{before,after:seal([...before.records,...clone(E238.additions)])};}
import{WZ_ISSUER239_SOURCE_CONTRACT as E239,WZ_ISSUER239_SOURCE_ORIGIN as O239,WZ_ISSUER239_SQL as SQL239}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wz-issuer239-source-contract.mjs';
import{projectCompiledWzIssuer239Catalogue as project239}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wz-issuer239-source-compatibility.mjs';
const own239=/(?:^|[.:])_?wz_issuer239_/;
/** after238 (fixture238().after), and after239 with the own additions. */
function fixture239(){const before=fixture238().after;return{before,after:seal([...before.records,...clone(E239.additions)])};}
import{BUYER_AVAILABLE240_SOURCE_CONTRACT as E240,BUYER_AVAILABLE240_SOURCE_ORIGIN as O240,BUYER_AVAILABLE240_SQL as SQL240}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available240-source-contract.mjs';
import{projectCompiledBuyerAvailable240Catalogue as project240}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available240-source-compatibility.mjs';
const VERDICT='function\0public.buyer_available236()',BASIS='function\0public.buyer_available236_basis()';
/** after239 (fixture239().after), and after240 with buyer_available236() and its basis replaced by their 240 records. */
function fixture240(){const before=fixture239().after,next=new Map(E240.changes.map(c=>[id(c.after),c.after]));return{before,after:seal(before.records.map(r=>next.has(id(r))?clone(next.get(id(r))):r))};}
import{VERDICT_GATES241_SOURCE_CONTRACT as E241,VERDICT_GATES241_SOURCE_ORIGIN as O241,VERDICT_GATES241_SQL as SQL241}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/verdict-gates241-source-contract.mjs';
import{projectCompiledVerdictGates241Catalogue as project241}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/verdict-gates241-source-compatibility.mjs';
const WZ='function\0public.wz_issuer239_verdict()',WZB='function\0public.wz_issuer239_basis()',GATE='function\0public.verdict241_ddl_intact()';
/** after240 (fixture240().after), and after241 with the own addition and the two verdicts replaced by their 241 records. */
function fixture241(){const before=fixture240().after,next=new Map(E241.changes.map(c=>[id(c.after),c.after]));return{before,after:seal([...before.records.map(r=>next.has(id(r))?clone(next.get(id(r))):r),...clone(E241.additions)])};}
import{PAYU_SESSIONS242_SOURCE_CONTRACT as E242,PAYU_SESSIONS242_SOURCE_ORIGIN as O242,PAYU_SESSIONS242_SQL as SQL242}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/payu-sessions242-source-contract.mjs';
import{projectCompiledPayuSessions242Catalogue as project242}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/payu-sessions242-source-compatibility.mjs';
const own242=/(?:^|[.:])_?payu242_/,TABLES=['payu242_configs','payu242_notifications','payu242_refunds','payu242_sessions'];
/** after241 (fixture241().after), and after242 with the own additions. */
function fixture242(){const before=fixture241().after;return{before,after:seal([...before.records,...clone(E242.additions)])};}
test('242 is source-compiled from the exact registered SQL: own payu242_ additions only, no changed record, no core object',async()=>{const b=await fs.readFile(new URL('../server/242_payu_sessions.sql',import.meta.url));assert.equal(b.length,SQL242.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),SQL242.sha256);assert.deepEqual(E242.sql,{...SQL242});assert.equal(E242.schema,'source242-payu-sessions-exact-inverse/v1');
 assert.deepEqual(E242.removed,[]);assert.deepEqual(E242.changes,[]);assert.equal(E242.source_compilation_proven,true);assert.equal(O242.additions,E242.additions.length);assert.equal(O242.changes,0);for(const x of['native_certification','application_activation','business_acceptance'])assert.equal(O242[x],false);
 assert(E242.additions.every(r=>own242.test(r.key)),'every addition is an own payu242_ object');
 assert(!E242.additions.some(r=>/\b(?:orders|payment_entries|channels)\b/.test(JSON.stringify(r.value))),'nothing on a core payment table');
 assert.deepEqual(E242.additions.filter(r=>r.kind==='relation'&&r.value.kind==='r').map(r=>r.key).sort(),TABLES.map(t=>'public.'+t));
 assert.deepEqual(E242.additions.filter(r=>r.kind==='policy').map(r=>r.key).sort(),TABLES.map(t=>'public.'+t+'.tenant_scope'));
 assert.deepEqual(E242.additions.filter(r=>r.kind==='function'||r.kind==='trigger'),[],'no function and no trigger');
 assert(!E242.additions.some(r=>r.kind==='constraint'&&/\bREFERENCES\b/.test(r.value.definition??'')),'no foreign key to a core table');
 const grants=t=>E242.additions.find(r=>r.key==='public.'+t).value.acl.filter(a=>a.grantee==='dyna_app').map(a=>a.privilege).sort();
 for(const t of['payu242_configs','payu242_sessions','payu242_refunds'])assert.deepEqual(grants(t),['INSERT','SELECT','UPDATE'],t);
 assert.deepEqual(grants('payu242_notifications'),['INSERT','SELECT'],'the notification log is append-only for dyna_app');
 const counts={...E242.counts_before};for(const r of E242.additions)counts[counters[r.kind]]++;assert.deepEqual(counts,{...E242.counts_after});
 assert.equal(E242.predecessor_sha256,O241.after241.sha256);assert.equal(O242.before242.sha256,O241.after241.sha256);});
test('complete242 inverse restores the exact 241 catalogue (no payu242_)',()=>{const f=fixture242(),p=project242(f.after);assert.equal(p.active,true);assert.equal(p.mode,'SOURCE_COMPILED_EXACT242_TO241');assert.equal(p.authority,false);assert.equal(p.removed_records,E242.additions.length);assert.equal(p.changed_records,0);
 assert.deepEqual(p.catalogue,validateRecoverySchema(f.before));assert(Object.isFrozen(p.catalogue.records));assert.equal(project241(p.catalogue).mode,'SOURCE_COMPILED_EXACT241_TO240');assert.throws(()=>project242(f.after,E242));});
test('absent242 keeps the exact predecessor catalogue as identity, also for an older 240 catalogue',()=>{const f=fixture242();for(const c of[f.before,fixture240().after]){const p=project242(c);assert.equal(p.active,false);assert.equal(p.mode,'SOURCE242_ABSENT_PREDECESSOR_IDENTITY');assert.deepEqual(p.catalogue,validateRecoverySchema(c));}});
test('a missing, tampered, regranted or extra payu242_ object refuses',()=>{const f=fixture242();
 for(const kind of['relation','constraint','index','column','type','policy']){const a=E242.additions.find(r=>r.kind===kind);assert.throws(()=>project242(seal(f.after.records.filter(r=>id(r)!==id(a)))),/242 exact complete addition descriptor/,kind);}
 const extra=clone(E242.additions.find(r=>r.kind==='index'));extra.key=extra.key+'_extra';assert.throws(()=>project242(seal([...f.after.records,extra])),/242 unexpected footprint/,'own extra index');
 const tampered=clone(f.after.records),pol=tampered.find(r=>r.kind==='policy'&&r.key==='public.payu242_sessions.tenant_scope');pol.value={...pol.value,using:'true'};assert.throws(()=>project242(seal(tampered)),/242 exact complete addition descriptor/,'policy opened');
 const acl=clone(f.after.records),log=acl.find(r=>r.key==='public.payu242_notifications');log.value={...log.value,acl:[...log.value.acl,{grantable:false,grantee:'dyna_app',grantor:'postgres',privilege:'DELETE'}]};assert.throws(()=>project242(seal(acl)),/242 exact complete addition descriptor/,'DELETE granted on the log');});
test('242 without complete241, 240, 239, 238, 237, 236, 235, 234 or 233 refuses',()=>{const f=fixture242();
 const gate=f.after.records.filter(r=>id(r)!==GATE);assert.throws(()=>project242(seal(gate)),/242 requires complete241/,'241 gate dropped');
 const wz=f.after.records.map(r=>id(r)===WZ?clone(E241.changes.find(c=>id(c.after)===WZ).before):r);assert.throws(()=>project242(seal(wz)),/242 requires complete241/,'241 WZ verdict reverted');
 const basis=f.after.records.map(r=>id(r)===BASIS?clone(E240.changes.find(c=>id(c.after)===BASIS).before):r);assert.throws(()=>project242(seal(basis)),/242 requires complete240/,'240 basis reverted');
 for(const[C,tag]of[[E239,'239'],[E238,'238'],[E237,'237'],[E236,'236'],[E235,'235'],[E234,'234'],[E233,'233'],[E230,'230']]){const a=C.additions.find(r=>r.kind==='relation');assert.throws(()=>project242(seal(f.after.records.filter(r=>id(r)!==id(a)))),new RegExp('242 requires complete'+tag),tag);}
 const old=clone(f.after.records).map(r=>id(r)===GUARD?clone(E234.changes.find(c=>id(c.after)===GUARD).before):r);assert.throws(()=>project242(seal(old)),/242 requires complete234/,'234 guard body reverted');});
const real242=process.env.DYNA_PAYU_SESSIONS242_COMPILED_CATALOGUES;
test('opt-in real compiled241→242 catalogues invert exactly 242→241',{skip:!(real242&&existsSync(real242+'/after242.catalogue.private.json.gz'))},()=>{const load=n=>JSON.parse(gunzipSync(readFileSync(real242+'/'+n+'.catalogue.private.json.gz'),{maxOutputLength:268435456}));const before=load('before242'),after=load('after242');assert.equal(before.sha256,E242.predecessor_sha256);assert.equal(after.sha256,O242.after242.sha256);
 const p=project242(after);assert.equal(p.mode,'SOURCE_COMPILED_EXACT242_TO241');assert.deepEqual(p.catalogue,validateRecoverySchema(before));assert.equal(p.catalogue.sha256,before.sha256);assert.equal(project241(p.catalogue).mode,'SOURCE_COMPILED_EXACT241_TO240');assert.equal(project242(before).mode,'SOURCE242_ABSENT_PREDECESSOR_IDENTITY');});
