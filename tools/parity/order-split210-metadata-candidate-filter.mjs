/** Fixed Source26 SQL transformation only. No DB, caller DATA or runtime API. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_METADATA_CANDIDATE_FILTER_SOURCE=freeze({
 schema:'order-split210-source26-metadata-sql/v1',
 key:'public.order_split210_try_metadata_projection(value jsonb)',
 bytes:18638,sha256:'542aa2688ee98a42a89ac327822c619851288b4345f87744ecacbbcc69c9b9e8',
 source26_candidate_sha256:'082e4bed0cf507ceb12c9e351f97fe54c051bf9e332da50546e71f124bcc621a',
 unchanged_basis_bytes:4193843,unchanged_basis_sha256:'0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7',
});
const keys=Object.freeze(['public.financial_return_upgrade_valid()','public.buyer_address_guards()','public.ordinary181_financial_valid(manual_basis jsonb)']);

/** Only one primitive full authored function; never metadata/frame/template input. */
export function deriveOrderSplit210MetadataCandidateFilter(sourceSql){
 const pin=ORDER_SPLIT210_METADATA_CANDIDATE_FILTER_SOURCE;
 assert.equal(arguments.length,1,'exactly one authored SQL argument');
 assert.equal(typeof sourceSql,'string','exact authored SQL string required');
 assert.equal(Buffer.byteLength(sourceSql),pin.bytes,'exact Source26 SQL bytes');
 assert.equal(sha(sourceSql),pin.sha256,'exact Source26 SQL SHA');
 // Every source-fixed form has this signature field and a body_sha256 key
 // iff the ref flag is true. Excluded refs therefore cannot equal the WHOLE
 // input. Full equality and all original strict refusal branches stay below.
 assert.equal((sourceSql.match(/jsonb_build_object\('signature',item->'signature',/g)||[]).length,7);
 assert.equal((sourceSql.match(/CASE WHEN item->'body_sha256'='true'::jsonb THEN jsonb_build_object\('body_sha256',/g)||[]).length,7);
 const edits=[];
 for(const key of keys){
  const before="   FOR item IN SELECT v FROM jsonb_array_elements(entries->'metadata_compact_shapes') v WHERE v->>'key'='"+key+"' LOOP";
  assert.equal(sourceSql.split(before).length,2,'one fixed source ref loop per family');
  const after=before.slice(0,-' LOOP'.length)+" AND v->>'signature'=order_split210_try_metadata_projection.value->>'signature' AND v->'body_sha256'=to_jsonb(order_split210_try_metadata_projection.value ? 'body_sha256') LOOP";
  edits.push({beforeStart:sourceSql.indexOf(before),before,after,kind:'exclude_structurally_impossible_'+key});
 }
 edits.sort((a,b)=>a.beforeStart-b.beforeStart);let cursor=0,sql='';
 for(const e of edits){assert(e.beforeStart>=cursor);sql+=sourceSql.slice(cursor,e.beforeStart);e.afterStart=sql.length;sql+=e.after;cursor=e.beforeStart+e.before.length;}sql+=sourceSql.slice(cursor);
 let inverse=sql;
 for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}
 assert.equal(inverse,sourceSql,'whole Source26 declaration/header/body/suffix inverse');
 assert.equal((sql.match(/PERFORM public\.order_split210_require\(\)/g)||[]).length,1);
 assert.equal((sql.match(/SELECT payload_jsonb INTO STRICT entries/g)||[]).length,1);
 return freeze({schema:'order-split210-metadata-candidate-filter/v1',sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),edits,source_proofs:pin,
  candidate_filter:{keys,refs_per_family_before:4,refs_per_family_after:1,comparison_forms:7,whole_comparisons_preserved:true,ordered_subset:true,eager_form_cache:false},
  whole_source_inverse_verified:true,source_data_changed:false,cross_invocation_cache:false,new_runtime_functions:0,
  source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
}
