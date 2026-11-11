/** Actual Source257 descriptor (Source271: one changed record, the body of the Source209 order_merge_delivery209_validation_snapshot() with index paths and a quine self entry; same signature, attributes, owner and ACL; nothing added or removed) and inverse attacks; no PG/app/provider. Real compiled catalogues are opt-in. */
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
import{CARRIERS234_SOURCE_CONTRACT as E234,CARRIERS234_SOURCE_ORIGIN as O234,CARRIERS234_SQL as SQL234}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/carriers234-source-contract.mjs';
import{projectCompiledCarriers234Catalogue as project234}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/carriers234-source-compatibility.mjs';
import{WMS_EVIDENCE_USAGE235_SOURCE_CONTRACT as E235,WMS_EVIDENCE_USAGE235_SOURCE_ORIGIN as O235,WMS_EVIDENCE_USAGE235_SQL as SQL235}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wms-evidence-usage235-source-contract.mjs';
import{projectCompiledWmsEvidenceUsage235Catalogue as project235}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wms-evidence-usage235-source-compatibility.mjs';
import{BUYER_AVAILABLE236_SOURCE_CONTRACT as E236,BUYER_AVAILABLE236_SOURCE_ORIGIN as O236,BUYER_AVAILABLE236_SQL as SQL236}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available236-source-contract.mjs';
import{projectCompiledBuyerAvailable236Catalogue as project236}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available236-source-compatibility.mjs';
import{AUTH_SECURITY237_SOURCE_CONTRACT as E237,AUTH_SECURITY237_SOURCE_ORIGIN as O237,AUTH_SECURITY237_SQL as SQL237}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/auth-security237-source-contract.mjs';
import{projectCompiledAuthSecurity237Catalogue as project237}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/auth-security237-source-compatibility.mjs';
import{AUDIT_LOG238_SOURCE_CONTRACT as E238,AUDIT_LOG238_SOURCE_ORIGIN as O238,AUDIT_LOG238_SQL as SQL238}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/audit-log238-source-contract.mjs';
import{projectCompiledAuditLog238Catalogue as project238}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/audit-log238-source-compatibility.mjs';
import{WZ_ISSUER239_SOURCE_CONTRACT as E239,WZ_ISSUER239_SOURCE_ORIGIN as O239,WZ_ISSUER239_SQL as SQL239}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wz-issuer239-source-contract.mjs';
import{projectCompiledWzIssuer239Catalogue as project239}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wz-issuer239-source-compatibility.mjs';
import{BUYER_AVAILABLE240_SOURCE_CONTRACT as E240,BUYER_AVAILABLE240_SOURCE_ORIGIN as O240,BUYER_AVAILABLE240_SQL as SQL240}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available240-source-contract.mjs';
import{projectCompiledBuyerAvailable240Catalogue as project240}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available240-source-compatibility.mjs';
import{VERDICT_GATES241_SOURCE_CONTRACT as E241,VERDICT_GATES241_SOURCE_ORIGIN as O241,VERDICT_GATES241_SQL as SQL241}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/verdict-gates241-source-contract.mjs';
import{projectCompiledVerdictGates241Catalogue as project241}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/verdict-gates241-source-compatibility.mjs';
import{PAYU_SESSIONS242_SOURCE_CONTRACT as E242,PAYU_SESSIONS242_SOURCE_ORIGIN as O242,PAYU_SESSIONS242_SQL as SQL242}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/payu-sessions242-source-contract.mjs';
import{projectCompiledPayuSessions242Catalogue as project242}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/payu-sessions242-source-compatibility.mjs';
import{KSEF_PURCHASE243_SOURCE_CONTRACT as E243,KSEF_PURCHASE243_SOURCE_ORIGIN as O243,KSEF_PURCHASE243_SQL as SQL243}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ksef-purchase243-source-contract.mjs';
import{projectCompiledKsefPurchase243Catalogue as project243}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ksef-purchase243-source-compatibility.mjs';
import{CUSTOM_EVENTS_CHECKSUMS244_SOURCE_CONTRACT as E244,CUSTOM_EVENTS_CHECKSUMS244_SOURCE_ORIGIN as O244,CUSTOM_EVENTS_CHECKSUMS244_SQL as SQL244}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/custom-events-checksums244-source-contract.mjs';
import{projectCompiledCustomEventsChecksums244Catalogue as project244}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/custom-events-checksums244-source-compatibility.mjs';
import{S5_COMM245_SOURCE_CONTRACT as E245,S5_COMM245_SOURCE_ORIGIN as O245,S5_COMM245_SQL as SQL245}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/s5-comm245-source-contract.mjs';
import{projectCompiledS5Comm245Catalogue as project245}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/s5-comm245-source-compatibility.mjs';
import{B2B_TRADE_CREDIT_DIRECTORY246_SOURCE_CONTRACT as E246,B2B_TRADE_CREDIT_DIRECTORY246_SOURCE_ORIGIN as O246,B2B_TRADE_CREDIT_DIRECTORY246_SQL as SQL246}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/b2b-trade-credit-directory246-source-contract.mjs';
import{projectCompiledB2bTradeCreditDirectory246Catalogue as project246}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/b2b-trade-credit-directory246-source-compatibility.mjs';
import{SALES_DIMENSIONS_REPRICING247_SOURCE_CONTRACT as E247,SALES_DIMENSIONS_REPRICING247_SOURCE_ORIGIN as O247,SALES_DIMENSIONS_REPRICING247_SQL as SQL247}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/sales-dimensions-repricing247-source-contract.mjs';
import{projectCompiledSalesDimensionsRepricing247Catalogue as project247}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/sales-dimensions-repricing247-source-compatibility.mjs';
import{GUARD_VERDICTS248_SOURCE_CONTRACT as E248,GUARD_VERDICTS248_SOURCE_ORIGIN as O248,GUARD_VERDICTS248_SQL as SQL248}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/guard-verdicts248-source-contract.mjs';
import{projectCompiledGuardVerdicts248Catalogue as project248}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/guard-verdicts248-source-compatibility.mjs';
import*as PROJECTORS from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/release-cold-projectors.mjs';
import{CATALOG_AI249_SOURCE_CONTRACT as E249,CATALOG_AI249_SOURCE_ORIGIN as O249,CATALOG_AI249_SQL as SQL249}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/catalog-ai249-source-contract.mjs';
import{projectCompiledCatalogAi249Catalogue as project249}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/catalog-ai249-source-compatibility.mjs';
import{WMS_EVIDENCE_SETTLE250_SOURCE_CONTRACT as E250,WMS_EVIDENCE_SETTLE250_SOURCE_ORIGIN as O250,WMS_EVIDENCE_SETTLE250_SQL as SQL250}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wms-evidence-settle250-source-contract.mjs';
import{projectCompiledWmsEvidenceSettle250Catalogue as project250}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wms-evidence-settle250-source-compatibility.mjs';
import{B2B_NETWORK_LIFECYCLE251_SOURCE_CONTRACT as E251,B2B_NETWORK_LIFECYCLE251_SOURCE_ORIGIN as O251,B2B_NETWORK_LIFECYCLE251_SQL as SQL251}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/b2b-network-lifecycle251-source-contract.mjs';
import{projectCompiledB2bNetworkLifecycle251Catalogue as project251}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/b2b-network-lifecycle251-source-compatibility.mjs';
import{MIRAKL_OPERATIONS252_SOURCE_CONTRACT as E252,MIRAKL_OPERATIONS252_SOURCE_ORIGIN as O252,MIRAKL_OPERATIONS252_SQL as SQL252}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/mirakl-operations252-source-contract.mjs';
import{projectCompiledMiraklOperations252Catalogue as project252}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/mirakl-operations252-source-compatibility.mjs';
import{MIRAKL_WEBHOOK_RETENTION253_SOURCE_CONTRACT as E253,MIRAKL_WEBHOOK_RETENTION253_SOURCE_ORIGIN as O253,MIRAKL_WEBHOOK_RETENTION253_SQL as SQL253}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/mirakl-webhook-retention253-source-contract.mjs';
import{projectCompiledMiraklWebhookRetention253Catalogue as project253}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/mirakl-webhook-retention253-source-compatibility.mjs';
import{CARRIER_RETURNS254_SOURCE_CONTRACT as E254,CARRIER_RETURNS254_SOURCE_ORIGIN as O254,CARRIER_RETURNS254_SQL as SQL254}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/carrier-returns254-source-contract.mjs';
import{projectCompiledCarrierReturns254Catalogue as project254}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/carrier-returns254-source-compatibility.mjs';
import{STOCK_VERDICT255_SOURCE_CONTRACT as E255,STOCK_VERDICT255_SOURCE_ORIGIN as O255,STOCK_VERDICT255_SQL as SQL255}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/stock-verdict255-source-contract.mjs';
import{projectCompiledStockVerdict255Catalogue as project255}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/stock-verdict255-source-compatibility.mjs';
import{RETURN_RECEIPT_VERDICTS256_SOURCE_CONTRACT as E256,RETURN_RECEIPT_VERDICTS256_SOURCE_ORIGIN as O256,RETURN_RECEIPT_VERDICTS256_SQL as SQL256}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-receipt-verdicts256-source-contract.mjs';
import{projectCompiledReturnReceiptVerdicts256Catalogue as project256}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-receipt-verdicts256-source-compatibility.mjs';
import{ORDER_MERGE_SNAPSHOT257_SOURCE_CONTRACT as E257,ORDER_MERGE_SNAPSHOT257_SOURCE_ORIGIN as O257,ORDER_MERGE_SNAPSHOT257_SQL as SQL257}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-snapshot257-source-contract.mjs';
import{projectCompiledOrderMergeSnapshot257Catalogue as project257}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-snapshot257-source-compatibility.mjs';
const clone=structuredClone,id=r=>r.kind+'\0'+r.key,counters={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types',sequence:'sequences'};
function seal(records){records=clone(records).sort((a,b)=>id(a)<id(b)?-1:1);const counts=Object.fromEntries(Object.keys(E.counts_before).map(k=>[k,k==='schemas'?[...SCOPE].sort():0]));for(const r of records)if(counters[r.kind])counts[counters[r.kind]]++;const body={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records};return{...body,sha256:digest212(body)};}function fixture(){const c232=new Map(E232.changes.map(x=>[id(x.after),x.after])),c231=new Map(E231.changes.map(x=>[id(x.after),x.after])),sample=k=>clone(E211.additions.find(r=>r.kind===k).value),base=[...SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}})),...SOURCE_SELECTION.required_tables.map(key=>({kind:'relation',key,value:sample('relation')})),...SOURCE_SELECTION.required_functions.map(key=>({kind:'function',key,value:sample('function')}))],c213=new Map(E213.changes.map(x=>[id(x.after),x.after])),before215=[...[...base,...clone(E212.additions)].map(r=>c213.get(id(r))??r),...clone(E213.additions),...clone(E214.additions)],before217=[...before215,...clone(E215.additions),...clone(E216.additions)],c217=new Map(E.changes.map(x=>[id(x.after),x.after])),before218=[...before217.map(r=>c217.get(id(r))??r),...clone(E.additions)],before219=[...before218,...clone(E218.additions)],before220=[...before219,...clone(E219.additions)],before221=[...before220,...clone(E220.additions)],before222=[...before221,...clone(E221.additions)],before223=[...before222,...clone(E222.additions)],before224=[...before223,...clone(E223.additions)],before225=[...before224,...clone(E224.additions)],before226=[...before225,...clone(E225.additions)],before227=[...before226,...clone(E226.additions)],before228=[...before227,...clone(E227.additions)],before229=[...before228,...clone(E228.additions)],before230=[...before229,...clone(E229.additions)];return{before217:seal(before217),before218:seal(before218),before219:seal(before219),before220:seal(before220),before221:seal(before221),before222:seal(before222),before223:seal(before223),before224:seal(before224),before225:seal(before225),before226:seal(before226),before227:seal(before227),before228:seal(before228),before229:seal(before229),before230:seal(before230),after230:seal([...before230,...clone(E230.additions)]),after231:seal([...before230,...clone(E230.additions)].map(r=>c231.get(id(r))??r)),after232:seal([...[...before230,...clone(E230.additions)].map(r=>c231.get(id(r))??r),...clone(E232.additions)].map(r=>c232.get(id(r))??r)),after:seal([...[...[...before230,...clone(E230.additions)].map(r=>c231.get(id(r))??r),...clone(E232.additions)].map(r=>c232.get(id(r))??r),...clone(E233.additions)])};}
const family=/(?:^|[.:])_?dhl234_/,GUARD='function\0public.order_shipments_guard()',CAPTURE='function\0public.shopify_capture_dispatch()';
/** after233 with the two functions as 134/108 left them, and after234 with their 234 bodies and the own additions. */
function fixture234(){const f=fixture(),put=(records,list)=>{const m=new Map(records.map(r=>[id(r),r]));for(const r of list)m.set(id(r),clone(r));return[...m.values()];};
 const before=put(f.after.records,E234.changes.map(c=>c.before)),after=[...put(before,E234.changes.map(c=>c.after)),...clone(E234.additions)];
 return{before:seal(before),after:seal(after),after233:f.after};}
const own=/(?:^|[.:])_?wms_evidence_/,fingerprinted=['wms_operations','wms_cost_layers','wms_layer_movements','wms_issue_fragments','wms_return_fragments'];
/** after234 (the 234 functions and dhl234 additions on top of after233), and after235 with the own additions. */
function fixture235(){const f=fixture(),put=(records,list)=>{const m=new Map(records.map(r=>[id(r),r]));for(const r of list)m.set(id(r),clone(r));return[...m.values()];};
 const before=[...put(f.after.records,E234.changes.map(c=>c.after)),...clone(E234.additions)];
 return{before:seal(before),after:seal([...before,...clone(E235.additions)])};}
const own236=/(?:^|[.:])_?buyer_available236(?:_|\()/;
/** after235 (fixture235().after), and after236 with the own additions. */
function fixture236(){const before=fixture235().after;return{before,after:seal([...before.records,...clone(E236.additions)])};}
const own237=/(?:^|[.:])_?auth237_/;
/** after236 (fixture236().after), and after237 with the own additions. */
function fixture237(){const before=fixture236().after;return{before,after:seal([...before.records,...clone(E237.additions)])};}
const own238=/(?:^|[.:])_?audit238_/;
/** after237 (fixture237().after), and after238 with the own additions. */
function fixture238(){const before=fixture237().after;return{before,after:seal([...before.records,...clone(E238.additions)])};}
const own239=/(?:^|[.:])_?wz_issuer239_/;
/** after238 (fixture238().after), and after239 with the own additions. */
function fixture239(){const before=fixture238().after;return{before,after:seal([...before.records,...clone(E239.additions)])};}
const VERDICT='function\0public.buyer_available236()',BASIS='function\0public.buyer_available236_basis()';
/** after239 (fixture239().after), and after240 with buyer_available236() and its basis replaced by their 240 records. */
function fixture240(){const before=fixture239().after,next=new Map(E240.changes.map(c=>[id(c.after),c.after]));return{before,after:seal(before.records.map(r=>next.has(id(r))?clone(next.get(id(r))):r))};}
const WZ='function\0public.wz_issuer239_verdict()',WZB='function\0public.wz_issuer239_basis()',GATE='function\0public.verdict241_ddl_intact()';
/** after240 (fixture240().after), and after241 with the own addition and the two verdicts replaced by their 241 records. */
function fixture241(){const before=fixture240().after,next=new Map(E241.changes.map(c=>[id(c.after),c.after]));return{before,after:seal([...before.records.map(r=>next.has(id(r))?clone(next.get(id(r))):r),...clone(E241.additions)])};}
const own242=/(?:^|[.:])_?payu242_/,TABLES=['payu242_configs','payu242_notifications','payu242_refunds','payu242_sessions'];
/** after241 (fixture241().after), and after242 with the own additions. */
function fixture242(){const before=fixture241().after;return{before,after:seal([...before.records,...clone(E242.additions)])};}
const own243=/(?:^|[.:"])_?ksef243_/,TABLES243=['ksef243_purchase_corrections','ksef243_purchase_events','ksef243_purchase_invoices','ksef243_purchase_rates','ksef243_purchase_rejects','ksef243_purchase_sync'];
/** after242 (fixture242().after), and after243 with the own additions. */
function fixture243(){const before=fixture242().after;return{before,after:seal([...before.records,...clone(E243.additions)])};}
const own244=/(?:^|[.:"])_?(?:custom_event_(?:defs|calls)|migration_checksums)/,TABLES244=['custom_event_calls','custom_event_defs','migration_checksums'];
/** after243 (fixture243().after), and after244 with the own additions. */
function fixture244(){const before=fixture243().after;return{before,after:seal([...before.records,...clone(E244.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own245=/(?:^|[.:"])_?(?:comm253|portal253|inbound253|channel253)_/,TABLES245=['channel253_connections','channel253_messages','channel253_threads','inbound253_matches','inbound253_schedules','portal253_link_policies'];
/** after244 (fixture244().after), and after245 with the own additions. */
function fixture245(){const before=fixture244().after;return{before,after:seal([...before.records,...clone(E245.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own246=/(?:^|[.:"])_?b2b254_/,TABLES246=['b2b254_directory_profiles','b2b254_directory_requests','b2b254_trade_charges','b2b254_trade_lines'];
const FORCED246=['audit238_event_keys','custom_event_calls','custom_event_defs','payu242_configs','payu242_notifications','payu242_refunds','payu242_sessions'];
/** after245 (fixture245().after), and after246 with the seven FORCE flags set and the own additions. */
function fixture246(){const before=fixture245().after,next=new Map(E246.changes.map(c=>[id(c.after),c.after]));return{before,after:seal([...before.records.map(r=>next.has(id(r))?clone(next.get(id(r))):r),...clone(E246.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own247=/(?:^|[.:"])_?(?:order_sales_dimensions|repricing_overrides|repricing_channel_results)/,TABLES247=['order_sales_dimensions','repricing_channel_results','repricing_overrides'];
/** after246 (fixture246().after), and after247 with the own additions. */
function fixture247(){const before=fixture246().after;return{before,after:seal([...before.records,...clone(E247.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own248=/(?:^|[.:"])_?guard_verdict/,FUNCTIONS248=['public.guard_verdict(g text)','public.guard_verdict_basis()','public.guard_verdict_full(g text)'];
/** after247 (fixture247().after), and after248 with the own additions. */
function fixture248(){const before=fixture247().after;return{before,after:seal([...before.records,...clone(E248.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own249=/(?:^|[.:"])_?catalog_ai_(?:batch|attribute|image|match)/,TABLES249=['catalog_ai_attribute_proposals','catalog_ai_batch_items','catalog_ai_batches','catalog_ai_image_jobs','catalog_ai_match_proposals'];
const FUNCTIONS249=['public.catalog_ai_attribute_immutable()','public.catalog_ai_batch_items_forward()','public.catalog_ai_batches_frozen()','public.catalog_ai_image_jobs_immutable()','public.catalog_ai_match_immutable()'];
/** after248 (fixture248().after), and after249 with the own additions. */
function fixture249(){const before=fixture248().after;return{before,after:seal([...before.records,...clone(E249.additions)])};}
const SETTLE='function\0public.wms_evidence_usage_settle()';
/** after249 (fixture249().after), and after250 with wms_evidence_usage_settle() replaced by its 250 record. */
function fixture250(){const before=fixture249().after,next=new Map(E250.changes.map(c=>[id(c.after),c.after]));return{before,after:seal(before.records.map(r=>next.has(id(r))?clone(next.get(id(r))):r))};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own251=/(?:^|[.:"])_?b2b258_/,TABLES251=['b2b258_link_events','b2b258_link_states','b2b258_mapping_events','b2b258_mappings','b2b258_order_decisions','b2b258_order_events','b2b258_tracking_copies'];
const UPDATABLE251=['b2b258_link_states','b2b258_mappings','b2b258_order_decisions'],FUNCTIONS251=['public.b2b258_item_has_proof(item uuid)','public.b2b258_link_guard()','public.b2b258_supplier_link(account uuid)'];
/** after250 (fixture250().after), and after251 with the own additions. */
function fixture251(){const before=fixture250().after;return{before,after:seal([...before.records,...clone(E251.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own252=/(?:^|[.:"])_?mirakl262_/,TABLES252=['mirakl262_operations','mirakl262_schedules','mirakl262_webhook_endpoints','mirakl262_webhook_events'];
/** after251 (fixture251().after), and after252 with the own additions. */
function fixture252(){const before=fixture251().after;return{before,after:seal([...before.records,...clone(E252.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses index keys).
const own253=/(?:^|[.:"])_?mirakl263_/,EVENTS='public.mirakl262_webhook_events';
const TRIGGERS253=['public.mirakl262_webhook_events.mirakl263_webhook_events_append_only','public.mirakl262_webhook_events.mirakl263_webhook_events_no_truncate'];
/** after252 (fixture252().after), and after253 with the own additions. */
function fixture253(){const before=fixture252().after;return{before,after:seal([...before.records,...clone(E253.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244: a \b form misses _pkey/_key and index keys).
const own254=/(?:^|[.:"])_?carrier261_/,TABLE254='public.carrier261_returns',FK254=['carrier261_returns_actor_id_fkey','carrier261_returns_tenant_id_channel_id_fkey'];
const INDEXES254=['public.carrier261_return_history','public.carrier261_return_job','public.carrier261_return_live','public.carrier261_returns_pkey','public.carrier261_returns_tenant_id_client_key_key','public.carrier261_returns_tenant_id_id_key','public.carrier261_returns_tenant_id_reference_key'];
/** after253 (fixture253().after), and after254 with the own additions. */
function fixture254(){const before=fixture253().after;return{before,after:seal([...before.records,...clone(E254.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244).
const own255=/(?:^|[.:"])_?stock_verdict_/;
const FUNCTIONS255=['public.stock_verdict_effect_finish(uid uuid, kid uuid, eid uuid, b jsonb)','public.stock_verdict_effect_prepare(uid uuid, kid uuid, b jsonb)','public.stock_verdict_require()','public.stock_verdict_return_frame(uid uuid, kid uuid, b jsonb)','public.stock_verdict_return_prepare(uid uuid, kid uuid, b jsonb)','public.stock_verdict_return_require()'];
/** after254 (fixture254().after), and after255 with the own additions. */
function fixture255(){const before=fixture254().after;return{before,after:seal([...before.records,...clone(E255.additions)])};}
// The plain name prefix, as in the projector (CUSTOM-EVENTS244).
const own256=/(?:^|[.:"])_?return_receipt272_/,FRONT256='public.return_receipt272_financial_capture(uid uuid, kid uuid, h text, rid uuid, q jsonb)';
/** after255 (fixture255().after), and after256 with the own addition. */
function fixture256(){const before=fixture255().after;return{before,after:seal([...before.records,...clone(E256.additions)])};}
const SNAPSHOT257='function\0public.order_merge_delivery209_validation_snapshot()';
/** after256 with the snapshot as Source209 left it, and after257 with the Source271 body (the one changed record). */
function fixture257(){const f=fixture256(),put=(records,list)=>{const m=new Map(records.map(r=>[id(r),r]));for(const r of list)m.set(id(r),clone(r));return[...m.values()];};
 const before=put(f.after.records,E257.changes.map(c=>c.before));return{before:seal(before),after:seal(put(before,E257.changes.map(c=>c.after)))};}
test('257 is source-compiled from the exact registered SQL: one changed record (the 209 snapshot body), nothing added or removed',async()=>{const b=await fs.readFile(new URL('../server/257_order_merge_snapshot_index_paths.sql',import.meta.url));assert.equal(b.length,SQL257.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),SQL257.sha256);assert.deepEqual(E257.sql,{...SQL257});assert.equal(E257.schema,'source257-order-merge-snapshot-exact-inverse/v1');
 assert.deepEqual(E257.additions,[]);assert.deepEqual(E257.removed,[]);assert.equal(E257.source_compilation_proven,true);assert.equal(O257.additions,0);assert.equal(O257.changes,1);for(const x of['native_certification','application_activation','business_acceptance'])assert.equal(O257[x],false);
 assert.equal(E257.changes.length,1);const[c]=E257.changes;assert.equal(id(c.before),SNAPSHOT257);assert.equal(id(c.after),SNAPSHOT257);
 const keys=new Set([...Object.keys(c.before.value),...Object.keys(c.after.value)]);assert.deepEqual([...keys].filter(k=>JSON.stringify(c.before.value[k])!==JSON.stringify(c.after.value[k])).sort(),['definition','source'],'only the body changes: signature, attributes, owner and ACL stay');
 assert.equal(c.after.value.security_definer,true);assert.deepEqual(c.after.value.acl,c.before.value.acl);
 assert(String(c.after.value.source).startsWith('\nWITH self271(src_sha,def_sha) AS MATERIALIZED ('),'the Source271 quine self entry first');assert(String(c.before.value.source).startsWith('\nWITH legacy209_current(kind,key,value) AS MATERIALIZED ('),'the Source209 body before');
 assert.deepEqual({...E257.counts_before},{...E257.counts_after});
 assert.equal(E257.predecessor_sha256,O256.after256.sha256);assert.equal(O257.before257.sha256,O256.after256.sha256);assert.equal(O257.before257.sha256,'c64efb24d5c3b3207644f57334e09b5f78d87b5d098bd5ab1d3ad67f0752203d');
 assert.equal(O257.after257.sha256,'1b725aaa6baf29d430b050db82834a6062bee9bfc9df55de431de7829452971c');assert.equal(O257.after257.records,O257.before257.records);
 assert.equal(PROJECTORS.projectCompiledOrderMergeSnapshot257Catalogue,project257,'one line in release-cold-projectors.mjs');});
test('complete257 inverse restores the exact 256 catalogue (the Source209 snapshot), and the 256 inverse then runs on it',()=>{const f=fixture257(),p=project257(f.after);assert.equal(p.active,true);assert.equal(p.mode,'SOURCE_COMPILED_EXACT257_TO256');assert.equal(p.authority,false);assert.equal(p.removed_records,0);assert.equal(p.changed_records,1);
 assert.deepEqual(p.catalogue,validateRecoverySchema(f.before));assert(Object.isFrozen(p.catalogue.records));
 assert.equal(project256(p.catalogue).mode,'SOURCE_COMPILED_EXACT256_TO255');assert.throws(()=>project257(f.after,E257));});
test('absent257 keeps the exact predecessor catalogue as identity, also for an older 255 catalogue',()=>{const f=fixture257();for(const c of[f.before,fixture255().after]){const p=project257(c);assert.equal(p.active,false);assert.equal(p.mode,'SOURCE257_ABSENT_PREDECESSOR_IDENTITY');assert.deepEqual(p.catalogue,validateRecoverySchema(c));}});
test('a tampered, regranted, reconfigured or dropped snapshot refuses or is not claimed',()=>{const f=fixture257(),edit=fn=>{const body=clone(f.after.records),r=body.find(x=>id(x)===SNAPSHOT257);r.value=fn(r.value);return seal(body);};
 assert.throws(()=>project257(edit(v=>({...v,source:String(v.source)+' '}))),/257 exact complete changed descriptor/,'body changed');
 assert.throws(()=>project257(edit(v=>({...v,acl:[...v.acl,{grantable:false,grantee:'PUBLIC',grantor:'postgres',privilege:'EXECUTE'}]}))),/257 exact complete changed descriptor/,'public grant');
 assert.throws(()=>project257(edit(v=>({...v,security_definer:false}))),/257 exact complete changed descriptor/,'SECURITY INVOKER');
 assert.throws(()=>project257(edit(v=>({...v,config:['search_path=public']}))),/257 exact complete changed descriptor/,'search_path changed');
 // A dropped snapshot is neither the 209 nor the 257 record: the 257 projector does not claim it.
 const dropped=seal(f.after.records.filter(r=>id(r)!==SNAPSHOT257)),p=project257(dropped);assert.equal(p.active,false);});
test('257 without complete256, 255 or older refuses',()=>{const f=fixture257();
 for(const[C,tag]of[[E254,'254'],[E252,'252'],[E251,'251'],[E249,'249'],[E248,'248'],[E247,'247'],[E246,'246'],[E245,'245'],[E243,'243'],[E239,'239'],[E237,'237'],[E236,'236'],[E235,'235'],[E234,'234'],[E233,'233'],[E230,'230']]){const a=C.additions.find(r=>r.kind==='relation');assert.throws(()=>project257(seal(f.after.records.filter(r=>id(r)!==id(a)))),new RegExp('257 requires complete'+tag),tag);}
 assert.throws(()=>project257(seal(f.after.records.filter(r=>r.key!==FRONT256))),/257 requires complete256/,'256 front door dropped');
 for(const key of FUNCTIONS255){const a=E255.additions.find(r=>r.key===key);assert.throws(()=>project257(seal(f.after.records.filter(r=>id(r)!==id(a)))),/257 requires complete255/,key);}
 const t253=f.after.records.filter(r=>r.key!==TRIGGERS253[0]);assert.throws(()=>project257(seal(t253)),/257 requires complete253/,'253 append-only trigger dropped');
 const settle=f.after.records.map(r=>id(r)===SETTLE?clone(E250.changes[0].before):r);assert.throws(()=>project257(seal(settle)),/257 requires complete250/,'the 235 settle body instead of 250');
 const fn248=f.after.records.filter(r=>r.key!=='public.guard_verdict(g text)');assert.throws(()=>project257(seal(fn248)),/257 requires complete248/,'248 verdict dropped');
 const gate=f.after.records.filter(r=>id(r)!==GATE);assert.throws(()=>project257(seal(gate)),/257 requires complete241/,'241 gate dropped');
 const basis=f.after.records.map(r=>id(r)===BASIS?clone(E240.changes.find(c=>id(c.after)===BASIS).before):r);assert.throws(()=>project257(seal(basis)),/257 requires complete240/,'240 basis reverted');});
const real257=process.env.DYNA_ORDER_MERGE_SNAPSHOT257_COMPILED_CATALOGUES;
test('opt-in real compiled256→257 catalogues invert exactly 257→256',{skip:!(real257&&existsSync(real257+'/after257.catalogue.private.json.gz'))},()=>{const load=n=>JSON.parse(gunzipSync(readFileSync(real257+'/'+n+'.catalogue.private.json.gz'),{maxOutputLength:268435456}));const before=load('before257'),after=load('after257');assert.equal(before.sha256,E257.predecessor_sha256);assert.equal(after.sha256,O257.after257.sha256);
 const p=project257(after);assert.equal(p.mode,'SOURCE_COMPILED_EXACT257_TO256');assert.deepEqual(p.catalogue,validateRecoverySchema(before));assert.equal(p.catalogue.sha256,before.sha256);assert.equal(project256(p.catalogue).mode,'SOURCE_COMPILED_EXACT256_TO255');assert.equal(project257(before).mode,'SOURCE257_ABSENT_PREDECESSOR_IDENTITY');});
