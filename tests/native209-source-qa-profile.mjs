/** Explicit source QA framing only. No DB/files, observed adoption or admission. */
import assert from 'node:assert/strict';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS} from '../tools/parity/order-merge-delivery209-startup-roster.mjs';
const legacyKeys=Object.freeze([
 'public.buyer_address_preview_guard()','public.buyer_address_state_guard()',
 'public.buyer_address_guards()','public.buyer_address_fingerprint()',
 'public.manual_inventory_off_valid()','public.manual_inventory_off_projection_valid()',
 'public.partial_sale204_predecessor_definition(fn oid)','public.ordinary187_valid()',
 'public.partial_sale204_valid()','public.catalog_header205_valid()',
]);
const helpers=Object.freeze([
 'public.order_merge_delivery209_history_predecessor_project(jsonb,jsonb)',
 'public.order_merge_delivery209_history_operative_valid(jsonb)',
 'public.order_merge_delivery209_wave_valid(jsonb)',
 'public.order_merge_delivery209_buyer_guards(jsonb)',
 'public.order_merge_delivery209_history_pim_valid(jsonb,boolean)',
 'public.order_merge_delivery209_history_parents_valid(jsonb,boolean)',
 'public.order_merge_delivery209_validation_snapshot()',
 'public.order_merge_delivery209_predecessor_source_sha(oid,jsonb)',
]);
const columns=count=>Object.freeze([
 Object.freeze({name:'projection_keys',constraint:'order_merge_delivery209_keys_source',kind:'array'}),
 Object.freeze({name:'projection_checks',constraint:'order_merge_delivery209_checks_source',kind:'array'}),
 ...Array.from({length:count},(_,i)=>Object.freeze({name:'before_'+i,constraint:'order_merge_delivery209_before_'+i+'_source',kind:'object'})),
]);
export const NATIVE209_SOURCE_QA_V1=Object.freeze({
 schema:'dynaminds-owned-native209-guard-qa/v1',runtimeRevision:21,
 sourceSha256:'95605368565cbec656fd41db95192879d450d700d13424bb7b575186c447572b',
 legacyKeys,columns:columns(10),fullRuntimeHelpers:helpers,startupKeys:Object.freeze([]),nativeTests:45,
});
export const NATIVE209_SOURCE_QA_V22=Object.freeze({
 schema:'dynaminds-owned-native209-guard-qa/v22',runtimeRevision:22,
 sourceSha256:'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a',sourceBytes:28449419,
 legacyKeys:Object.freeze([...legacyKeys,...ORDER_MERGE_DELIVERY209_STARTUP_KEYS]),columns:columns(17),
 fullRuntimeHelpers:Object.freeze([...helpers,'public.order_merge_delivery209_startup_operative_valid(jsonb)',
  ...['operative_valid','packed_guards','parcel_valid','issuer_guards'].map(name=>'public.order_merge_delivery209_pim_'+name+'(jsonb,boolean)')]),
 startupKeys:ORDER_MERGE_DELIVERY209_STARTUP_KEYS,nativeTests:53,
});
export function native209SourceQaProfile(locator){
 assert(locator&&typeof locator==='object'&&!Array.isArray(locator));
 if(locator.schema===NATIVE209_SOURCE_QA_V1.schema){
  assert(!Object.hasOwn(locator,'runtimeRevision')&&!Object.hasOwn(locator,'sourceSqlPath'),'v1 framing remains literal');
  assert.equal(locator.expected209SqlSha256,NATIVE209_SOURCE_QA_V1.sourceSha256);return NATIVE209_SOURCE_QA_V1;
 }
 assert.equal(locator.schema,NATIVE209_SOURCE_QA_V22.schema,'explicit source QA schema required');
 assert.equal(locator.runtimeRevision,22,'no source revision fallback');assert.equal(locator.expected209SqlSha256,NATIVE209_SOURCE_QA_V22.sourceSha256,'fixed Source22 SQL, never caller-chosen SHA');
 assert(typeof locator.sourceSqlPath==='string'&&locator.sourceSqlPath.length>0);return NATIVE209_SOURCE_QA_V22;
}
