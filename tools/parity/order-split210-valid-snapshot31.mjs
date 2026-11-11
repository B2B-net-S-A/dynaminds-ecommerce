/** Finite Source31 wrapper around the unchanged authenticated historical guard pipeline. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210ValidSnapshot} from './order-split210-valid-snapshot.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
export const ORDER_SPLIT210_VALID_SNAPSHOT_SOURCE31=freeze({schema:'order-split210-source31-valid-sql/v1',key:'public.order_split210_valid()',
 bytes:52253,sha256:'4f0ed5068c80152a0459cabf2e4a280980a8e33de99190e0d7ddde7e42864d35',
 upstream_source29:{bytes:52236,sha256:'b69aa93ce59080ffae9f206676a35361d567967f368509cd8118231e592ec394'},
 physical_basis:{bytes:3590688,sha256:'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3',schema:'order-split210-projection-basis/definition-codec-v1'},
 metadata2:{source_bytes:28068,source_sha256:'d3d059467f193f5334f1fc35d6469f120445251cbf9aedfa15c9045793b14c00',definition_bytes:28300,definition_sha256:'00e5a1912773134c953342c96cfabc3a9f1a74c653f78ec3cf678f5de5c8a672'},
 rebindings:[
 {
  "kind": "physical_payload_bytes",
  "before": "payload_octets=4192445",
  "after": "payload_octets=3590688"
 },
 {
  "kind": "physical_payload_sha256",
  "before": "fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45",
  "after": "db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3"
 },
 {
  "kind": "physical_schema",
  "before": "payload_jsonb->>'schema'='order-split210-projection-basis/v1'",
  "after": "payload_jsonb->>'schema'='order-split210-projection-basis/definition-codec-v1'"
 },
 {
  "kind": "metadata2_source_sha256",
  "before": "cfad1ebdc47ddd2f3c72b058a1736dd4767a244d7ea4c22f51c3a1a655f4499e",
  "after": "d3d059467f193f5334f1fc35d6469f120445251cbf9aedfa15c9045793b14c00"
 },
 {
  "kind": "metadata2_definition_sha256",
  "before": "0ed79c936942803a5e685b3d6da8a4b4a15a3ae6c7bd6d9c7b43185786edeff0",
  "after": "00e5a1912773134c953342c96cfabc3a9f1a74c653f78ec3cf678f5de5c8a672"
 }
]});
function apply(source,edits){
 const ordered=edits.map(edit=>{const beforeStart=source.indexOf(edit.before);assert(beforeStart>=0&&source.indexOf(edit.before,beforeStart+edit.before.length)<0,'one fixed literal site: '+edit.kind);return {...edit,beforeStart};}).sort((a,b)=>a.beforeStart-b.beforeStart);
 let sql='',cursor=0;for(const edit of ordered){assert(edit.beforeStart>=cursor,'disjoint exact sites');sql+=source.slice(cursor,edit.beforeStart);edit.afterStart=sql.length;sql+=edit.after;cursor=edit.beforeStart+edit.before.length;}sql+=source.slice(cursor);
 let inverse=sql;for(const edit of [...ordered].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);}assert.equal(inverse,source,'entire fixed declaration inverse');return {sql,edits:ordered};
}
function inverse(source,edits){for(const edit of [...edits].reverse()){assert.equal(source.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);source=source.slice(0,edit.afterStart)+edit.before+source.slice(edit.afterStart+edit.after.length);}return source;}
export function deriveOrderSplit210ValidSnapshot31(sourceSql){
 assert.equal(arguments.length,1,'one exact authored Source31 declaration');assert.equal(typeof sourceSql,'string');const pin=ORDER_SPLIT210_VALID_SNAPSHOT_SOURCE31;
 assert.equal(Buffer.byteLength(sourceSql),pin.bytes,'finite Source31 declaration bytes');assert.equal(sha(sourceSql),pin.sha256,'finite Source31 declaration SHA');
 const backwards=pin.rebindings.map(e=>({kind:e.kind,before:e.after,after:e.before})),rawParent=apply(sourceSql,backwards);
 assert.equal(Buffer.byteLength(rawParent.sql),pin.upstream_source29.bytes);assert.equal(sha(rawParent.sql),pin.upstream_source29.sha256,'entire independently pinned Source29 raw declaration');
 const rawRebindings=apply(rawParent.sql,pin.rebindings);assert.equal(rawRebindings.sql,sourceSql);
 const upstream=deriveOrderSplit210ValidSnapshot(rawParent.sql);assert.equal(upstream.edits.length,4);assert(upstream.trigger_constraint_map?.whole_previous_guard_inverse_verified);
 const transformed=apply(sourceSql,upstream.edits.map(({kind,before,after})=>({kind,before,after}))),outputRebindings=apply(upstream.sql,pin.rebindings);
 assert.equal(transformed.sql,outputRebindings.sql,'only the same five authored bindings on authenticated historical output');
 assert.equal(inverse(transformed.sql,transformed.edits),sourceSql,'complete Source31 four-edit inverse');assert.equal(inverse(transformed.sql,outputRebindings.edits),upstream.sql,'complete mapped Source30 output inverse');
 const oldMap=upstream.trigger_constraint_map,capture=oldMap.query_sql.slice(0,-1),oldAt=upstream.sql.indexOf(capture),newAt=transformed.sql.indexOf(capture);
 assert(oldAt>=0&&newAt>=0&&upstream.sql.indexOf(capture,oldAt+1)<0&&transformed.sql.indexOf(capture,newAt+1)<0,'one identical whole capture query');
 const delta=newAt-oldAt,mapEdits=oldMap.body_edits.map(edit=>({...edit,beforeStart:edit.beforeStart+delta,afterStart:edit.afterStart+delta}));
 const previousGuard=inverse(transformed.sql,mapEdits),expectedPrevious=apply(inverse(upstream.sql,oldMap.body_edits),pin.rebindings);assert.equal(previousGuard,expectedPrevious.sql,'complete pre-map Source31 guard inverse');
 const delimiter='$closure210$',start=sourceSql.indexOf(delimiter)+delimiter.length,end=sourceSql.lastIndexOf(delimiter),newEnd=transformed.sql.lastIndexOf(delimiter);
 assert(start>=delimiter.length&&end>start);assert.equal(transformed.sql.slice(0,start),sourceSql.slice(0,start));assert.equal(transformed.sql.slice(newEnd),sourceSql.slice(end));const bodyEdits=transformed.edits.map(edit=>({...edit,beforeStart:edit.beforeStart-start,afterStart:edit.afterStart-start}));assert.equal(inverse(transformed.sql.slice(start,newEnd),bodyEdits),sourceSql.slice(start,end),'whole raw Source31 body inverse');
 return freeze({schema:'order-split210-source31-same-statement-valid-snapshot/v1',sql:transformed.sql,bytes:Buffer.byteLength(transformed.sql),sha256:sha(transformed.sql),edits:transformed.edits,body_edits:bodyEdits,source_proofs:pin,upstream_source_proofs:upstream.source_proofs,
  source29_raw_inverse:{bytes:pin.upstream_source29.bytes,sha256:pin.upstream_source29.sha256,edits:rawRebindings.edits,whole_source_inverse_verified:true},
  source30_mapped_inverse:{bytes:upstream.bytes,sha256:upstream.sha256,edits:outputRebindings.edits,whole_source_inverse_verified:true},
  trigger_constraint_map:{...oldMap,body_edits:mapEdits,upstream_previous_guard:oldMap.previous_guard,previous_guard:{bytes:Buffer.byteLength(previousGuard),sha256:sha(previousGuard)},capture_offset_delta:delta,whole_previous_guard_inverse_verified:true},
  queries:upstream.queries,snapshot:upstream.snapshot,whole_source_inverse_verified:true,whole_body_inverse_verified:true,header_and_suffix_preserved:true,source_data_changed:true,upstream_transform_source_unchanged:true,cross_invocation_cache:false,new_runtime_functions:0,source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false,performance_acceptance:false});
}
