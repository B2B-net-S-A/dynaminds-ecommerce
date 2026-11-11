/** Pure source-bound proposal. No database, runtime frame, cache or IO. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const ORDER_MERGE_DELIVERY209_METADATA_TRAVERSAL_SOURCE=freeze({
 schema:'order-merge-delivery209-authored-metadata-sql/v1',
 key:'public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)',
 bytes:7116,sha256:'6b9cb7db2d94bb318d03c1d1e70f7c7a060f68ad791e073e5298c7e913c071eb',
 authored_source_bytes:28449419,authored_source_sha256:'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a',
 basis_bytes:21756960,basis_sha256:'ed45aecdcf4d959c7ff636cd315a12162316f030cb1e382e7e82e5ed6eb4a2d4',
 expected17_canonical_sha256:'47487b6b5ae241b7d55db5a0ba42e183698905229444e9350b23dd2b7f43d91a',
});

/** Exactly one primitive authored CREATE declaration, including final LF.
 * replace(text,text,text) is strict: even an impossible needle must propagate
 * a SQL NULL replacement. Preserve that before the length exclusion.
 * JSON quoting contributes at least two UTF8 bytes and never shortens text.
 * Thus rawAfterBytes+2 > currentResultBytes proves no match ANYWHERE in the
 * original serialized text, including keys and escaped-quote suffixes. The
 * result length is recomputed after EACH original step, preserving cascades.
 */
export function deriveOrderMergeDelivery209MetadataTraversalOpt(sourceSql){
 const pin=ORDER_MERGE_DELIVERY209_METADATA_TRAVERSAL_SOURCE;
 assert.equal(arguments.length,1,'exactly one authored SQL argument');
 assert.equal(typeof sourceSql,'string','primitive authored SQL required');
 assert.equal(Buffer.byteLength(sourceSql),pin.bytes,'exact metadata SQL bytes');
 assert.equal(sha(sourceSql),pin.sha256,'exact metadata SQL SHA');
 const before="   after_value:=entry->'after'->>field;before_value:=entry->'before'->>field;\n   result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);";
 const after="   after_value:=entry->'after'->>field;before_value:=entry->'before'->>field;\n   IF after_value IS NULL OR before_value IS NULL THEN result:=NULL;\n   ELSIF octet_length(after_value)+2<=octet_length(result) THEN\n    result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);\n   END IF;";
 const beforeStart=sourceSql.indexOf(before);assert(beforeStart>=0);
 assert.equal(sourceSql.split(before).length,2,'one fixed source/definition loop');
 const sql=sourceSql.slice(0,beforeStart)+after+sourceSql.slice(beforeStart+before.length);
 const inverse=sql.slice(0,beforeStart)+before+sql.slice(beforeStart+after.length);
 assert.equal(inverse,sourceSql,'whole declaration/header/ACL/body inverse');
 // Both complete validations, all17 descriptor/overload checks, authenticated
 // DATA load, hash replacements, ordering and final JSONB parse stay literal.
 const guard="public.order_merge_delivery209_valid() IS DISTINCT FROM true";
 assert.equal(sourceSql.split(guard).length,2);assert.equal(sql.split(guard).length,2);
 assert.equal(sourceSql.split("FOREACH field IN ARRAY ARRAY['source','definition'] LOOP").length,2);
 assert.equal(sql.slice(0,beforeStart),sourceSql.slice(0,beforeStart));
 assert.equal(sql.slice(beforeStart+after.length),sourceSql.slice(beforeStart+before.length));
 return freeze({
  schema:'order-merge-delivery209-metadata-length-exclusion/v1',sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),
  edits:[{beforeStart,afterStart:beforeStart,before,after}],source_proofs:pin,
  source_definition_steps:34,unchanged_hash_steps:17,ordered_raw_text_replacement:true,
  whole_source_inverse_verified:true,fresh_validation_preserved:true,source_data_changed:false,
  new_runtime_functions:0,cross_invocation_cache:false,trusted_frame_api:false,
  source_compilation_performed:false,native_certification:false,application_activation:false,
  performance_acceptance:false,business_acceptance:false,
 });
}
