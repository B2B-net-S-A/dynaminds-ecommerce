/** Source-only statement-local sharing. No SQL execution or runtime admission. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210HistoryOperativeSuccessor} from './order-split210-history-operative-successor.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const keys=['public.fa3_draft_fingerprint()','public.b2b_invoice_fingerprint()'];
const oldPort="public.order_split210_predecessor_definition(p.oid,'partial204')";
const strict="p.proallargtypes IS NULL AND p.protrftypes IS NULL AND p.prosqlbody IS NULL AND(SELECT count(*) FROM pg_proc q WHERE q.pronamespace='public'::regnamespace AND q.proname=p.proname)=1";
export const ORDER_SPLIT210_HISTORY_FINANCIAL_SHARING_SOURCE=freeze({
 key:'public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)',
 original209_before_full24_sha256:'1c5d4a9984888bda480259f4398dabe24fafcef06a20bbefddafa0544f98a0c3',
 source23_after_full24_sha256:'66fb44d36dea0cff189e343d9b35edc77f934102e9971655ee32a4b49b651cdf',
 source23_after_source_sha256:'fe25f9cf360a90180caa80c7528fd9fa88ef399ea300859631828ba904b197d5',
 source23_after_source_bytes:75646,
 family_keys:keys,bound_tables:['order_items','orders'],
 old_data_bytes:4192139,data_cap_bytes:4194304,
});
function code(source){return spans(source).map(s=>s.executable?s.text:s.text.replace(/[^\n]/g,' ')).join('');}

/** Only frozen authored210 SQL is accepted; no frame, metadata or verdict API. */
export function deriveOrderSplit210HistoryFinancialSharing(options){
 const base=deriveOrderSplit210HistoryOperativeSuccessor(options),pin=ORDER_SPLIT210_HISTORY_FINANCIAL_SHARING_SOURCE;
 assert.equal(base.change.key,pin.key);assert.equal(digest(base.change.before),pin.original209_before_full24_sha256);
 const before=base.change.after,source=before.source;
 assert.equal(digest(before),pin.source23_after_full24_sha256,'complete current Source23 successor');
 assert.equal(sha(source),pin.source23_after_source_sha256);assert.equal(Buffer.byteLength(source),pin.source23_after_source_bytes);
 assert.deepEqual(base.statement_local_bound_targets.map(g=>g.targets),[pin.bound_tables,pin.bound_tables]);
 const classifications=base.edits.filter(e=>e.kind==='statement_local_bound_classification');assert.equal(classifications.length,2);
 assert.equal(classifications[0].after,classifications[1].after,'same source-bound query prefix');
 const previous=classifications[0].after;
 const prefix=`PERFORM public.order_split210_require();
 WITH split210_bound_verified AS MATERIALIZED(
   SELECT t.oid FROM pg_catalog.pg_trigger t
   JOIN pg_catalog.pg_class rel ON rel.oid=t.tgrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=rel.relnamespace
   JOIN(VALUES ('order_items','order_split210_bound'),('orders','order_split210_bound')) declared(table_name,trigger_name)
    ON declared.table_name=rel.relname AND declared.trigger_name=t.tgname
   WHERE n.nspname='public'
  ),split210_family AS MATERIALIZED(
   SELECT payload_jsonb#>'{families,partial204}' defs FROM public.order_split210_projection_basis WHERE id
  )
  SELECT jsonb_build_object(`;
 // A malformed strict descriptor takes the UNCHANGED strict fallback, including
 // its original55000 refusal. Foreign/unscoped functions take that same path.
 const projected="CASE WHEN p.oid IN("+keys.map(k=>"'"+k+"'::regprocedure").join(',')+") AND "+strict+
  " THEN(SELECT defs->>('public.'||p.proname||'()') FROM split210_family) ELSE "+oldPort+' END';
 const edits=[];
 for(const [i,site]of classifications.entries()){
  const start=site.afterStart,end=source.indexOf(') INTO financial214;',start)+') INTO financial214;'.length;
  assert(end>start);const old=source.slice(start,end);assert(old.startsWith(previous));
  assert.equal(code(source).slice(start,start+4),'WITH','executable exact statement start');
  assert.equal(old.split(oldPort).length-1,1,'one original family fold per statement');
  assert.equal(old.split('public.order_split210_is_added_trigger(oid)').length-1,1);
  // The independent parent derivation proves both complete table/membership
  // intersections; neither a prefix nor arbitrary live trigger is excluded.
  const replacement=prefix+old.slice(previous.length).replace(oldPort,projected);
  edits.push({kind:'statement_local_financial_sharing',family:['158','159'][i],beforeStart:start,before:old,after:replacement});
 }
 let afterSource='',cursor=0;for(const e of edits){assert(e.beforeStart>=cursor);afterSource+=source.slice(cursor,e.beforeStart);e.afterStart=afterSource.length;afterSource+=e.after;cursor=e.beforeStart+e.before.length;}afterSource+=source.slice(cursor);
 let inverse=afterSource;for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}assert.equal(inverse,source,'entire Source23 AFTER inverse');
 const after={...before,source:afterSource,definition:before.definition.replace(source,()=>afterSource)};
 assert.equal(after.definition.replace(afterSource,()=>source),before.definition,'whole definition inverse');
 assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([k])=>!['source','definition'].includes(k))),Object.fromEntries(Object.entries(before).filter(([k])=>!['source','definition'].includes(k))));
 // Measure actual canonical DATA representation, including JSON escaping, both
 // raw source/definition copies AND both tagged descriptor hash changes.
 const tagged=v=>({...v,source:['sha256-utf8-text/v1',sha(v.source)],definition:['sha256-utf8-text/v1',sha(v.definition)]});
 const change=v=>({kind:'function',key:pin.key,before:base.change.before,after:v,before_check:tagged(base.change.before),after_check:tagged(v)});
 const delta=Buffer.byteLength(JSON.stringify(canonical(change(after))))-Buffer.byteLength(JSON.stringify(canonical(change(before))));
 const predicted=pin.old_data_bytes+delta;
 assert(predicted<=pin.data_cap_bytes,'source-derived DATA budget exceeded: '+predicted);
 return freeze({schema:'order-split210-history-financial-sharing/v1',change:{kind:'function',key:pin.key,before:base.change.before,after},sql:after.definition+';\n',edits,
  source23_change:base.change,source_proofs:pin,original209_edits:base.edits,
  source_after_sha256:sha(afterSource),whole_source23_inverse_verified:true,whole_original209_inverse_verified:base.whole_source_inverse_verified,
  budget:{previous_data_bytes:pin.old_data_bytes,canonical_change_delta_bytes:delta,predicted_data_bytes:predicted,cap_bytes:pin.data_cap_bytes,remaining_bytes:pin.data_cap_bytes-predicted},
  sharing:{statements:2,fresh_whole_guards:2,per_statement_bound_oids:2,per_statement_family_keys:2,cross_statement_cache:false,unknown_fallback_preserved:true},
  target_metadata_adopted:false,assembled:false,source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
}
