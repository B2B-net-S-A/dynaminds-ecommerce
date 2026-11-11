/** Unwired finite query candidate. Preserve all records; compute the own producer once. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderMergeDelivery209ValidationSnapshot} from './order-merge-delivery209-validation-snapshot.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
const flags={integrated:false,performance_measured:false,source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false};
export const ORDER_MERGE_DELIVERY209_OWN_MATERIALIZED_KEYS=freeze(['buyer_address_preview_guard()','buyer_address_state_guard()','buyer_address_guards()','buyer_address_fingerprint()','manual_inventory_off_valid()','manual_inventory_off_projection_valid()','partial_sale204_predecessor_definition(fn oid)','ordinary187_valid()','partial_sale204_valid()','catalog_header205_valid()','pim_dictionary_valid()','nested172_valid()','parcel_physical_wz_valid()','operative_delivery_valid()','wave_print177_valid()','cooperation171_valid()','packed_label_print_guards()'].map(k=>'public.'+k));
export const ORDER_MERGE_DELIVERY209_OWN_MATERIALIZED_SOURCE=freeze({
 schema:'order-merge-delivery209-own-materialized-source/v1',runtime_revision:22,legacy_functions:17,
 query_bytes:15625,query_sha256:'a15d8d01b6781bd2666beb0d4573efe89ed71cb0b153b2441c6af3b2116cf4e1',
 source31_snapshot_bytes:21739,source31_snapshot_sha256:'611cb9304d6f540b31b72a1a627a2e87a5964129dfc0335120e587c4ecdd791c',
 source31_metadata_bytes:28068,source31_metadata_sha256:'d3d059467f193f5334f1fc35d6469f120445251cbf9aedfa15c9045793b14c00',
 source31_snapshot_definition_bytes:21940,source31_snapshot_definition_sha256:'61765199e83747bd2a16a709c450f260eaf48a828f4606bb97c43b62d8c2dfc4',
 source31_metadata_definition_bytes:28300,source31_metadata_definition_sha256:'00e5a1912773134c953342c96cfabc3a9f1a74c653f78ec3cf678f5de5c8a672',
});
const head="'own',(SELECT coalesce(jsonb_agg(jsonb_build_array(record->>'kind',record->>'key',encode(sha256(convert_to((record->'value')::text,'UTF8')),'hex')) ORDER BY record->>'kind' COLLATE \"C\",record->>'key' COLLATE \"C\"),'[]'::jsonb) FROM(";
const cteMarker='WITH legacy209_current(kind,key,value) AS MATERIALIZED (';
function pin(s,bytes,digest){assert.equal(typeof s,'string');assert.equal(Buffer.byteLength(s),bytes,'whole finite input bytes');assert.equal(sha(s),digest,'whole finite input SHA');}
function editSource(source,changes){
 const edits=changes.map(e=>{assert.equal(source.split(e.before).length,2,'one complete source edit');return{...e,beforeStart:source.indexOf(e.before)};}).sort((a,b)=>a.beforeStart-b.beforeStart);
 let cursor=0,sql='';for(const e of edits){assert(e.beforeStart>=cursor,'disjoint source edits');sql+=source.slice(cursor,e.beforeStart);e.afterStart=sql.length;sql+=e.after;cursor=e.beforeStart+e.before.length;}sql+=source.slice(cursor);
 let inverse=sql;for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}assert.equal(inverse,source,'whole source inverse');return{sql,edits};
}
function materialize(query){
 assert.equal(query.split(head).length,2,'one entire fixed own aggregate');assert.equal(query.split(cteMarker).length,2,'one original17 producer');assert(!query.includes('own209_current'),'fresh statement-local CTE name');
 const open=query.indexOf(head)+head.length,end=query.indexOf(') own209)',open);assert(end>open&&query.indexOf(') own209)',end+1)<0,'complete own producer boundary');const own=query.slice(open,end);
 const kindCount=new Map();for(const match of own.matchAll(/SELECT '(relation|column|constraint|index|policy|trigger|function|type)'/g))kindCount.set(match[1],(kindCount.get(match[1])??0)+1);assert.deepEqual([...kindCount.keys()].sort(),['relation','column','constraint','index','policy','trigger','function','type'].sort(),'all8 unchanged own arms');
 const cte='WITH own209_current(record) AS MATERIALIZED ('+own+'), legacy209_current(kind,key,value) AS MATERIALIZED (';
 const changed=editSource(query,[{kind:'one-invocation-complete-own-producer',before:cteMarker,after:cte},{kind:'reuse-materialized-complete-own-records',before:' FROM('+own+') own209',after:' FROM own209_current own209'}]);
 assert.equal(changed.sql.split(own).length,2,'one complete own producer in candidate');
 return{...changed,own_query:own,own_cte:cte,original_query:query,current_descriptor_fields:24,current_complete_text_digests:['source','definition'],own_catalogue_kinds:8,scope:'one original SQL statement, fresh on each invocation',cross_invocation_cache:false,new_runtime_functions:0,dispatch_changes:0,guard_changes:0,sql_snapshot_boundary_changed:false,whole_source_inverse_verified:true,...flags};
}
/** Actual Source22/17 query from the existing producer, not protected WIP or caller SQL. */
export function deriveOrderMergeDelivery209SnapshotOwnMaterialized(input){
 assert.equal(arguments.length,1,'one explicit source assembly');assert(input&&typeof input==='object'&&!Array.isArray(input));assert.deepEqual(Object.keys(input).sort(),Object.hasOwn(input,'runtimeRevision')?['changes','runtimeRevision']:['changes'],'closed source assembly fields');const {changes,runtimeRevision=22}=input;assert.equal(runtimeRevision,22,'only actual17 Source22 snapshot');
 const original=deriveOrderMergeDelivery209ValidationSnapshot({changes,runtimeRevision});assert.deepEqual(original.keys,ORDER_MERGE_DELIVERY209_OWN_MATERIALIZED_KEYS);const p=ORDER_MERGE_DELIVERY209_OWN_MATERIALIZED_SOURCE;pin(original.query,p.query_bytes,p.query_sha256);
 const next=materialize(original.query);assert.equal(original.sql.split(original.query).length,2);const sql=original.sql.replace(original.query,()=>next.sql);
 return freeze({...next,schema:'order-merge-delivery209-own-materialized-candidate/v1',query:next.sql,sql,query_bytes:Buffer.byteLength(next.sql),query_sha256:sha(next.sql),original_sql:original.sql,keys:original.keys,runtime_revision:22,source_proofs:p});
}
const snapshotPrefix='\n SELECT public.order_split210_require();\n';
const snapshotHeader="CREATE OR REPLACE FUNCTION public.order_merge_delivery209_validation_snapshot()\n RETURNS jsonb\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$";
const metadataHeader="CREATE OR REPLACE FUNCTION public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$";
const suffix='$function$\n',tag='$split210_composite_snapshot$';
/** Both Source31 sites change together; production source assembly remains unwired. */
export function deriveOrderSplit210SnapshotOwnMaterialized(snapshotBody,metadataBody){
 assert.equal(arguments.length,2,'both exact Source31 bodies');const p=ORDER_MERGE_DELIVERY209_OWN_MATERIALIZED_SOURCE;pin(snapshotBody,p.source31_snapshot_bytes,p.source31_snapshot_sha256);pin(metadataBody,p.source31_metadata_bytes,p.source31_metadata_sha256);
 pin(snapshotHeader+snapshotBody+suffix,p.source31_snapshot_definition_bytes,p.source31_snapshot_definition_sha256);pin(metadataHeader+metadataBody+suffix,p.source31_metadata_definition_bytes,p.source31_metadata_definition_sha256);
 assert(snapshotBody.startsWith(snapshotPrefix),'independent fresh whole210 require');const original=snapshotBody.slice(snapshotPrefix.length),next=materialize(original),snapshot=snapshotPrefix+next.sql;
 const before=' EXECUTE '+tag+original+tag+' INTO split210_fresh_snapshot;',after=' EXECUTE '+tag+next.sql+tag+' INTO split210_fresh_snapshot;';assert(!next.sql.includes(tag));const metadata=editSource(metadataBody,[{kind:'same-materialized-own-query-in-fixed-composite',before,after}]);
 const snapshotEdits=next.edits.map(e=>({...e,beforeStart:e.beforeStart+snapshotPrefix.length,afterStart:e.afterStart+snapshotPrefix.length}));let previous=snapshot;for(const e of [...snapshotEdits].reverse())previous=previous.slice(0,e.afterStart)+e.before+previous.slice(e.afterStart+e.after.length);assert.equal(previous,snapshotBody);
 return freeze({schema:'order-split210-source31-own-materialized-candidate/v1',snapshot:{source:snapshot,definition:snapshotHeader+snapshot+suffix,edits:snapshotEdits,bytes:Buffer.byteLength(snapshot),sha256:sha(snapshot)},metadata:{source:metadata.sql,definition:metadataHeader+metadata.sql+suffix,edits:metadata.edits,bytes:Buffer.byteLength(metadata.sql),sha256:sha(metadata.sql)},original_snapshot:snapshotBody,original_metadata:metadataBody,query:next.sql,original_query:original,own_query:next.own_query,keys_count:17,current_descriptor_fields:24,own_catalogue_kinds:8,whole_source_inverse_verified:true,whole_definition_inverse_verified:true,source_proofs:p,standalone_require_unchanged:true,composite_require_unchanged:true,spi_boundary_unchanged:true,volatility_unchanged:true,dispatch_changes:0,cross_invocation_cache:false,new_runtime_functions:0,...flags});
}
