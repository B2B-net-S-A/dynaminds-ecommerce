/** Pure Source28-body transformation; no database, runtime frame or IO. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const header="CREATE OR REPLACE FUNCTION public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$";
const suffix='$function$\n';
export const ORDER_SPLIT210_METADATA_FRESH_MAP_SOURCE=freeze({
 schema:'order-split210-source28-metadata-two-argument/v1',
 key:'public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)',
 bytes:7215,sha256:'5b404950a17eced165ede37317f67a3a162598699b1b759e8afdfd73d5ba3406',
 definition_bytes:7447,definition_sha256:'46fbe312eed54c4df6e31fdacdb63fe3763267402c582c1d5d7aedbf6844ff11',
 descriptor_canonical_sha256:'6aa8d5fd6f10f4cfc3baec0d02a5617326ee9ac0dec2bb3bffc851db84978c89',
 parent_source_bytes:28449419,parent_source_sha256:'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a',
 checked_map_sql_bytes:5540,checked_map_sql_sha256:'8eb4b0bf05fa737a94755b5cbd783fb69728d776fabb41e9c78b7c11959ad7e5',
 source210_snapshot_bytes:21739,source210_snapshot_sha256:'611cb9304d6f540b31b72a1a627a2e87a5964129dfc0335120e587c4ecdd791c',
 source210_snapshot_definition_bytes:21940,source210_snapshot_definition_sha256:'61765199e83747bd2a16a709c450f260eaf48a828f4606bb97c43b62d8c2dfc4',
 source210_snapshot_descriptor_sha256:'53e5ae39c22a139c8de50800accd44987bae0c4265fb1c1885d9fd0ad76a7b03',
 snapshot_sql_bytes:15812,snapshot_sql_sha256:'fccf501dfdf9b530a173abc15505e9e3c0dd4d9c77a915c0837a0c3368ef771c',
 basis_bytes:21756960,basis_sha256:'ed45aecdcf4d959c7ff636cd315a12162316f030cb1e382e7e82e5ed6eb4a2d4',
});

/** Use the SAME fresh snapshot trust root as original209_valid; do not trust a
 * checked-map callee which the removed independent fingerprint authenticated.
 * The source-authored Source210 snapshot starts with its own complete require.
 * Parse original typed caller fields before it; preserve whole17 descriptors,
 * overload checks and literal manifest predicates, then the original DATA tail.
 * Private simultaneous-fault message precedence is not an admission contract.
 */
export function deriveOrderSplit210MetadataFreshMap(sourceBody){
 const pin=ORDER_SPLIT210_METADATA_FRESH_MAP_SOURCE;
 assert.equal(arguments.length,1,'exactly one authored body');
 assert.equal(typeof sourceBody,'string','primitive authored body required');
 assert.equal(Buffer.byteLength(sourceBody),pin.bytes,'exact Source28 body bytes');
 assert.equal(sha(sourceBody),pin.sha256,'exact Source28 body SHA');
 const definitionBefore=header+sourceBody+suffix;
 assert.equal(Buffer.byteLength(definitionBefore),pin.definition_bytes);assert.equal(sha(definitionBefore),pin.definition_sha256);
 assert(!sourceBody.includes('split210_caller_frame')&&!sourceBody.includes('split210_fresh_frame'));
 const start=sourceBody.indexOf(' validated:=0;\n -- One current-catalogue query, no per-entry SPI and no wide JSONB tuple sort.\n');
 const finalGuard=" IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' OR public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;\n";
 assert(start>0&&sourceBody.split(finalGuard).length===2);
 const end=sourceBody.indexOf(finalGuard,start)+finalGuard.length;assert(end>start);
 const before=sourceBody.slice(start,end);
 const rosterLine=before.split('\n').find(line=>line.includes('binding_ordinal NOT BETWEEN 1 AND 17 OR entry'));
 assert(rosterLine&&rosterLine.includes("RAISE EXCEPTION '209 exact predecessor roster required' USING ERRCODE='55000'"));
 const typed="FROM ROWS FROM(jsonb_to_recordset(entries) AS(key text,after_check jsonb)) WITH ORDINALITY AS a(key,after_check,ordinal)";
 assert.equal(before.split(typed).length,2);
 const after=` -- Only original typed fields: unknown entry properties are not authority.
 SELECT jsonb_agg(jsonb_build_object('key',a.key,'after_check',a.after_check) ORDER BY a.ordinal)
 INTO split210_caller_frame
 ${typed};
 -- Independently authenticate the snapshot callee BEFORE dispatch; its own
 -- require remains too. No checked-map callee or caller frame is authority.
 PERFORM public.order_split210_require();
 -- SAME fresh snapshot as209_valid; Source210 snapshot retains its require.
 split210_fresh_snapshot:=public.order_merge_delivery209_validation_snapshot();
 IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8'
  OR(SELECT count(*) FROM public.order_merge_delivery209_manifest)<>1 OR(SELECT count(*) FROM public.buyer_address_manifest)<>1 THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 SELECT * INTO split210_manifest FROM public.order_merge_delivery209_manifest WHERE id;
 IF jsonb_typeof(split210_fresh_snapshot) IS DISTINCT FROM 'object' OR split210_manifest.profile IS DISTINCT FROM 'merge-delivery-inheritance/v1'
  OR split210_manifest.original166 IS DISTINCT FROM(SELECT to_jsonb(b) FROM public.buyer_address_manifest b)
  OR split210_manifest.fingerprint IS DISTINCT FROM(split210_fresh_snapshot->>'fingerprint')
  THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 split210_fresh_frame:=split210_fresh_snapshot->'legacy';
 IF jsonb_typeof(split210_fresh_frame) IS DISTINCT FROM 'array' OR jsonb_array_length(split210_fresh_frame)<>17 THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;
 validated:=0;
 FOR entry,binding_ordinal IN
  SELECT v,ordinal::integer FROM jsonb_array_elements(split210_caller_frame) WITH ORDINALITY a(v,ordinal)
 LOOP
  validated:=validated+1;
${rosterLine}
  SELECT count(*) INTO total FROM jsonb_array_elements(split210_fresh_frame) r(value)
   WHERE r.value->>'kind'='function' AND split_part(r.value->>'key','(',1)=split_part(entry->>'key','(',1);
  IF total IS DISTINCT FROM 1 THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;
  SELECT r.value->>'key',r.value->'value' INTO actual_key,live FROM jsonb_array_elements(split210_fresh_frame) r(value)
   WHERE r.value->>'kind'='function' AND split_part(r.value->>'key','(',1)=split_part(entry->>'key','(',1);
  IF actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'
   THEN RAISE EXCEPTION '209 exact complete successor descriptor required' USING ERRCODE='55000';END IF;
 END LOOP;
 IF validated<>17 THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;
 -- All17 fresh bindings above; authenticate the original full AFTER strings.
`;
 const edits=[{kind:'local-frames',beforeStart:sourceBody.indexOf('DECLARE '),before:'DECLARE ',after:'DECLARE split210_caller_frame jsonb;split210_fresh_frame jsonb;split210_fresh_snapshot jsonb;split210_manifest public.order_merge_delivery209_manifest%ROWTYPE;'},
  {kind:'fresh-authenticated-snapshot',beforeStart:start,before,after}];
 let cursor=0,source='';for(const edit of edits){assert(edit.beforeStart>=cursor);assert.equal(sourceBody.slice(edit.beforeStart,edit.beforeStart+edit.before.length),edit.before);source+=sourceBody.slice(cursor,edit.beforeStart);edit.afterStart=source.length;source+=edit.after;cursor=edit.beforeStart+edit.before.length;}source+=sourceBody.slice(cursor);
 let inverse=source;for(const edit of [...edits].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);}
 assert.equal(inverse,sourceBody,'entire raw-body inverse');assert.equal(header+inverse+suffix,definitionBefore,'entire fixed-header CREATE inverse');
 const payloadStart=' SELECT count(*) OVER(),id,payload IS NOT NULL,payload_octets,payload_sha256,payload_jsonb INTO total,source_id,payload_present,payload_bytes,payload_hash,entries FROM public.order_merge_delivery209_projection_basis;';
 assert.equal(source.slice(source.indexOf(payloadStart)),sourceBody.slice(sourceBody.indexOf(payloadStart)),'entire original DATA load/51 suffix/final JSONB parse');
 assert.equal(source.split('public.order_merge_delivery209_validation_snapshot()').length,2);
 assert(!source.includes('public.order_merge_delivery209_checked_projection_map('));
 assert(!source.includes('public.order_merge_delivery209_valid()'));
 const definition=header+source+suffix;
 return freeze({schema:'order-split210-metadata-fresh-map/v1',source,source_bytes:Buffer.byteLength(source),source_sha256:sha(source),
  definition,sql:definition,bytes:Buffer.byteLength(definition),sha256:sha(definition),edits,source_proofs:pin,
  full_body_inverse_verified:true,full_definition_inverse_verified:true,fresh_snapshot_calls_per_strict_invocation:1,caller_side_require_before_snapshot:true,checked_map_callee_dependency:false,
  incoming_typed_fields:['key','after_check'],ignored_extra_entry_properties:true,full_after_check_equality:true,
  existing_changed_function:true,new_runtime_functions:0,trusted_frame_api:false,cross_invocation_cache:false,
  parent209_data_changed:false,source210_descriptor_replacement_required:true,source210_data_delta_measured:false,
  source_compilation_performed:false,native_certification:false,application_activation:false,
  performance_acceptance:false,business_acceptance:false});
}
