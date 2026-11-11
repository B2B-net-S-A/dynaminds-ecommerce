/** Actual Source249 descriptor (S8 catalog AI: catalog_ai_batches/catalog_ai_batch_items with the one own foreign key and its RI triggers, catalog_ai_attribute_proposals, catalog_ai_image_jobs and catalog_ai_match_proposals; RLS forced with one tenant_scope policy each, dyna_app SELECT/INSERT/UPDATE without DELETE, five plpgsql BEFORE UPDATE trigger functions without SECURITY DEFINER; no change of an existing record) and inverse attacks; no PG/app/provider. Real compiled catalogues are opt-in. */
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
import{KSEF_PURCHASE243_SOURCE_CONTRACT as E243,KSEF_PURCHASE243_SOURCE_ORIGIN as O243,KSEF_PURCHASE243_SQL as SQL243}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ksef-purchase243-source-contract.mjs';
import{projectCompiledKsefPurchase243Catalogue as project243}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ksef-purchase243-source-compatibility.mjs';
const own243=/(?:^|[.:"])_?ksef243_/,TABLES243=['ksef243_purchase_corrections','ksef243_purchase_events','ksef243_purchase_invoices','ksef243_purchase_rates','ksef243_purchase_rejects','ksef243_purchase_sync'];
/** after242 (fixture242().after), and after243 with the own additions. */
function fixture243(){const before=fixture242().after;return{before,after:seal([...before.records,...clone(E243.additions)])};}
import{CUSTOM_EVENTS_CHECKSUMS244_SOURCE_CONTRACT as E244,CUSTOM_EVENTS_CHECKSUMS244_SOURCE_ORIGIN as O244,CUSTOM_EVENTS_CHECKSUMS244_SQL as SQL244}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/custom-events-checksums244-source-contract.mjs';
import{projectCompiledCustomEventsChecksums244Catalogue as project244}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/custom-events-checksums244-source-compatibility.mjs';
const own244=/(?:^|[.:"])_?(?:custom_event_(?:defs|calls)|migration_checksums)/,TABLES244=['custom_event_calls','custom_event_defs','migration_checksums'];
/** after243 (fixture243().after), and after244 with the own additions. */
function fixture244(){const before=fixture243().after;return{before,after:seal([...before.records,...clone(E244.additions)])};}
import{S5_COMM245_SOURCE_CONTRACT as E245,S5_COMM245_SOURCE_ORIGIN as O245,S5_COMM245_SQL as SQL245}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/s5-comm245-source-contract.mjs';
import{projectCompiledS5Comm245Catalogue as project245}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/s5-comm245-source-compatibility.mjs';
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own245=/(?:^|[.:"])_?(?:comm253|portal253|inbound253|channel253)_/,TABLES245=['channel253_connections','channel253_messages','channel253_threads','inbound253_matches','inbound253_schedules','portal253_link_policies'];
/** after244 (fixture244().after), and after245 with the own additions. */
function fixture245(){const before=fixture244().after;return{before,after:seal([...before.records,...clone(E245.additions)])};}
import{B2B_TRADE_CREDIT_DIRECTORY246_SOURCE_CONTRACT as E246,B2B_TRADE_CREDIT_DIRECTORY246_SOURCE_ORIGIN as O246,B2B_TRADE_CREDIT_DIRECTORY246_SQL as SQL246}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/b2b-trade-credit-directory246-source-contract.mjs';
import{projectCompiledB2bTradeCreditDirectory246Catalogue as project246}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/b2b-trade-credit-directory246-source-compatibility.mjs';
import{SALES_DIMENSIONS_REPRICING247_SOURCE_CONTRACT as E247,SALES_DIMENSIONS_REPRICING247_SOURCE_ORIGIN as O247,SALES_DIMENSIONS_REPRICING247_SQL as SQL247}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/sales-dimensions-repricing247-source-contract.mjs';
import{projectCompiledSalesDimensionsRepricing247Catalogue as project247}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/sales-dimensions-repricing247-source-compatibility.mjs';
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own246=/(?:^|[.:"])_?b2b254_/,TABLES246=['b2b254_directory_profiles','b2b254_directory_requests','b2b254_trade_charges','b2b254_trade_lines'];
const FORCED246=['audit238_event_keys','custom_event_calls','custom_event_defs','payu242_configs','payu242_notifications','payu242_refunds','payu242_sessions'];
/** after245 (fixture245().after), and after246 with the seven FORCE flags set and the own additions. */
function fixture246(){const before=fixture245().after,next=new Map(E246.changes.map(c=>[id(c.after),c.after]));return{before,after:seal([...before.records.map(r=>next.has(id(r))?clone(next.get(id(r))):r),...clone(E246.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own247=/(?:^|[.:"])_?(?:order_sales_dimensions|repricing_overrides|repricing_channel_results)/,TABLES247=['order_sales_dimensions','repricing_channel_results','repricing_overrides'];
/** after246 (fixture246().after), and after247 with the own additions. */
function fixture247(){const before=fixture246().after;return{before,after:seal([...before.records,...clone(E247.additions)])};}
import{GUARD_VERDICTS248_SOURCE_CONTRACT as E248,GUARD_VERDICTS248_SOURCE_ORIGIN as O248,GUARD_VERDICTS248_SQL as SQL248}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/guard-verdicts248-source-contract.mjs';
import{projectCompiledGuardVerdicts248Catalogue as project248}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/guard-verdicts248-source-compatibility.mjs';
import*as PROJECTORS from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/release-cold-projectors.mjs';
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own248=/(?:^|[.:"])_?guard_verdict/,FUNCTIONS248=['public.guard_verdict(g text)','public.guard_verdict_basis()','public.guard_verdict_full(g text)'];
/** after247 (fixture247().after), and after248 with the own additions. */
function fixture248(){const before=fixture247().after;return{before,after:seal([...before.records,...clone(E248.additions)])};}
import{CATALOG_AI249_SOURCE_CONTRACT as E249,CATALOG_AI249_SOURCE_ORIGIN as O249,CATALOG_AI249_SQL as SQL249}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/catalog-ai249-source-contract.mjs';
import{projectCompiledCatalogAi249Catalogue as project249}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/catalog-ai249-source-compatibility.mjs';
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own249=/(?:^|[.:"])_?catalog_ai_(?:batch|attribute|image|match)/,TABLES249=['catalog_ai_attribute_proposals','catalog_ai_batch_items','catalog_ai_batches','catalog_ai_image_jobs','catalog_ai_match_proposals'];
const FUNCTIONS249=['public.catalog_ai_attribute_immutable()','public.catalog_ai_batch_items_forward()','public.catalog_ai_batches_frozen()','public.catalog_ai_image_jobs_immutable()','public.catalog_ai_match_immutable()'];
/** after248 (fixture248().after), and after249 with the own additions. */
function fixture249(){const before=fixture248().after;return{before,after:seal([...before.records,...clone(E249.additions)])};}
test('249 is source-compiled from the exact registered SQL: own additions only, nothing of an existing record',async()=>{const b=await fs.readFile(new URL('../server/249_catalog_ai.sql',import.meta.url));assert.equal(b.length,SQL249.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),SQL249.sha256);assert.deepEqual(E249.sql,{...SQL249});assert.equal(E249.schema,'source249-catalog-ai-exact-inverse/v1');
 assert.deepEqual(E249.changes,[]);assert.deepEqual(E249.removed,[]);assert.equal(E249.source_compilation_proven,true);assert.equal(O249.additions,E249.additions.length);assert.equal(O249.changes,0);for(const x of['native_certification','application_activation','business_acceptance'])assert.equal(O249[x],false);
 assert.equal(E249.additions.length,414);assert(E249.additions.every(r=>own249.test(r.key)),'every addition is an own object');
 const kinds={};for(const r of E249.additions)kinds[r.kind]=(kinds[r.kind]??0)+1;assert.deepEqual(kinds,{column:166,constraint:160,function:5,index:27,policy:5,relation:32,trigger:9,type:10});
 assert.deepEqual(E249.additions.filter(r=>r.kind==='relation'&&r.value.kind==='r').map(r=>r.key).sort(),TABLES249.map(t=>'public.'+t));
 for(const t of TABLES249){const rel=E249.additions.find(r=>r.key==='public.'+t);assert.equal(rel.value.row_security,true,t);assert.equal(rel.value.force_row_security,true,t+': forced');
  assert.deepEqual(rel.value.acl.filter(a=>a.grantee==='dyna_app').map(a=>a.privilege).sort(),['INSERT','SELECT','UPDATE'],t+': dyna_app without DELETE');assert(!rel.value.acl.some(a=>a.grantee==='PUBLIC'),t+': nothing for PUBLIC');}
 assert.deepEqual(E249.additions.filter(r=>r.kind==='policy').map(r=>r.key).sort(),TABLES249.map(t=>'public.'+t+'.tenant_scope'));
 assert.deepEqual(E249.additions.filter(r=>r.kind==='function').map(r=>r.key).sort(),FUNCTIONS249);
 for(const f of E249.additions.filter(r=>r.kind==='function'))assert.equal(f.value.security_definer,false,f.key+': no SECURITY DEFINER');
 assert.deepEqual(E249.additions.filter(r=>r.kind==='trigger'&&!r.key.includes('internal:')).map(r=>r.key).sort(),['public.catalog_ai_attribute_proposals.catalog_ai_attribute_immutable','public.catalog_ai_batch_items.catalog_ai_batch_items_forward','public.catalog_ai_batches.catalog_ai_batches_frozen','public.catalog_ai_image_jobs.catalog_ai_image_jobs_immutable','public.catalog_ai_match_proposals.catalog_ai_match_immutable']);
 assert.equal(E249.additions.filter(r=>r.kind==='trigger'&&r.key.includes('internal:catalog_ai_batch_items_tenant_id_batch_id_fkey:')).length,4,'the RI triggers of the one own foreign key');
 assert.deepEqual(E249.additions.filter(r=>r.kind==='constraint'&&/\bREFERENCES\b/.test(r.value.definition??'')).map(r=>r.value.definition),['FOREIGN KEY (tenant_id, batch_id) REFERENCES catalog_ai_batches(tenant_id, id)'],'the only foreign key joins the two own batch tables');
 const counts={...E249.counts_before};for(const r of E249.additions)counts[counters[r.kind]]++;assert.deepEqual(counts,{...E249.counts_after});
 assert.equal(E249.predecessor_sha256,O248.after248.sha256);assert.equal(O249.before249.sha256,O248.after248.sha256);assert.equal(O249.before249.sha256,'a50f4eeae1f429a70a5ec1b95c8ae98a82a317e8196bd02e3d27159f5ca016cd');
 assert.equal(PROJECTORS.projectCompiledCatalogAi249Catalogue,project249,'one line in release-cold-projectors.mjs');});
test('the 249 footprint matches nothing of 070 (ai_catalog_drafts, catalog_ai_pending_count) and nothing on after248',()=>{const f=fixture249();
 assert.deepEqual(f.before.records.filter(r=>own249.test(r.key)).map(r=>r.key),[]);
 for(const k of['public.ai_catalog_drafts','public.catalog_ai_pending_count()','public.ai_catalog_drafts_pkey'])assert(!own249.test(k),k);});
test('complete249 inverse restores the exact 248 catalogue (no own 249 object)',()=>{const f=fixture249(),p=project249(f.after);assert.equal(p.active,true);assert.equal(p.mode,'SOURCE_COMPILED_EXACT249_TO248');assert.equal(p.authority,false);assert.equal(p.removed_records,E249.additions.length);assert.equal(p.changed_records,0);
 assert.deepEqual(p.catalogue,validateRecoverySchema(f.before));assert(Object.isFrozen(p.catalogue.records));
 assert.equal(project248(p.catalogue).mode,'SOURCE_COMPILED_EXACT248_TO247');assert.throws(()=>project249(f.after,E249));});
test('absent249 keeps the exact predecessor catalogue as identity, also for an older 247 catalogue',()=>{const f=fixture249();for(const c of[f.before,fixture247().after]){const p=project249(c);assert.equal(p.active,false);assert.equal(p.mode,'SOURCE249_ABSENT_PREDECESSOR_IDENTITY');assert.deepEqual(p.catalogue,validateRecoverySchema(c));}});
test('a missing, tampered, regranted or extra own 249 object refuses',()=>{const f=fixture249();
 for(const kind of['relation','constraint','index','column','type','function','policy','trigger']){const a=E249.additions.find(r=>r.kind===kind);assert.throws(()=>project249(seal(f.after.records.filter(r=>id(r)!==id(a)))),/249 exact complete addition descriptor/,kind);}
 const extra=clone(E249.additions.find(r=>r.kind==='function'&&r.key==='public.catalog_ai_match_immutable()'));extra.key='public.catalog_ai_match_immutable2()';assert.throws(()=>project249(seal([...f.after.records,extra])),/249 unexpected footprint/,'own extra function');
 const body=clone(f.after.records),fn=body.find(r=>r.kind==='function'&&r.key==='public.catalog_ai_attribute_immutable()');fn.value={...fn.value,definition:String(fn.value.definition)+' '};assert.throws(()=>project249(seal(body)),/249 exact complete addition descriptor/,'trigger function body changed');
 const grant=clone(f.after.records),t=grant.find(r=>r.key==='public.catalog_ai_image_jobs');t.value={...t.value,acl:[...t.value.acl,{grantable:false,grantee:'dyna_app',grantor:'postgres',privilege:'DELETE'}]};assert.throws(()=>project249(seal(grant)),/249 exact complete addition descriptor/,'DELETE granted to dyna_app');
 const open=clone(f.after.records),u=open.find(r=>r.key==='public.catalog_ai_batches');u.value={...u.value,force_row_security:false};assert.throws(()=>project249(seal(open)),/249 exact complete addition descriptor/,'FORCE RLS dropped');
 const pol=clone(f.after.records).filter(r=>r.key!=='public.catalog_ai_match_proposals.tenant_scope');assert.throws(()=>project249(seal(pol)),/249 exact complete addition descriptor/,'policy dropped');});
test('249 without complete248, 247 or older refuses',()=>{const f=fixture249();
 for(const[C,tag]of[[E248,'248'],[E247,'247'],[E246,'246'],[E245,'245'],[E243,'243'],[E239,'239'],[E237,'237'],[E236,'236'],[E235,'235'],[E234,'234'],[E233,'233'],[E230,'230']]){const a=C.additions.find(r=>r.kind==='relation');assert.throws(()=>project249(seal(f.after.records.filter(r=>id(r)!==id(a)))),new RegExp('249 requires complete'+tag),tag);}
 for(const[C,tag]of[[E247,'247'],[E244,'244'],[E242,'242'],[E238,'238']]){const a=C.additions.find(r=>r.kind==='policy');assert.throws(()=>project249(seal(f.after.records.filter(r=>id(r)!==id(a)))),new RegExp('249 requires complete'+tag),tag);}
 const fn248=f.after.records.filter(r=>r.key!=='public.guard_verdict(g text)');assert.throws(()=>project249(seal(fn248)),/249 requires complete248/,'248 verdict dropped');
 for(const name of['payu242_configs','custom_event_defs']){const off=f.after.records.map(r=>r.kind==='relation'&&r.key==='public.'+name?clone(E246.changes.find(c=>c.after.key===r.key).before):r);assert.throws(()=>project249(seal(off)),/249 requires complete246/,name+' without the 246 FORCE flag');}
 const gate=f.after.records.filter(r=>id(r)!==GATE);assert.throws(()=>project249(seal(gate)),/249 requires complete241/,'241 gate dropped');
 const basis=f.after.records.map(r=>id(r)===BASIS?clone(E240.changes.find(c=>id(c.after)===BASIS).before):r);assert.throws(()=>project249(seal(basis)),/249 requires complete240/,'240 basis reverted');});
const real249=process.env.DYNA_CATALOG_AI249_COMPILED_CATALOGUES;
test('opt-in real compiled248→249 catalogues invert exactly 249→248',{skip:!(real249&&existsSync(real249+'/after249.catalogue.private.json.gz'))},()=>{const load=n=>JSON.parse(gunzipSync(readFileSync(real249+'/'+n+'.catalogue.private.json.gz'),{maxOutputLength:268435456}));const before=load('before249'),after=load('after249');assert.equal(before.sha256,E249.predecessor_sha256);assert.equal(after.sha256,O249.after249.sha256);
 const p=project249(after);assert.equal(p.mode,'SOURCE_COMPILED_EXACT249_TO248');assert.deepEqual(p.catalogue,validateRecoverySchema(before));assert.equal(p.catalogue.sha256,before.sha256);assert.equal(project248(p.catalogue).mode,'SOURCE_COMPILED_EXACT248_TO247');assert.equal(project249(before).mode,'SOURCE249_ABSENT_PREDECESSOR_IDENTITY');});
