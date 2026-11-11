/** Fixed Source25 SQL transformation only. No execution, cache or runtime API. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_METADATA_TEXT_SOURCE=freeze({
 schema:'order-split210-source25-metadata-sql/v1',
 key:'public.order_split210_try_metadata_projection(value jsonb)',
 bytes:18515,sha256:'340a48e3fc8882323372a636d45631722e21f0bf22d5bad1f1e4617c3f58df0f',
 source25_candidate_sha256:'d9498e231ea31c10c2182c94de442ac4e5edd94525ab8db8fcfee314582de4d3',
 unchanged_basis_bytes:4193843,unchanged_basis_sha256:'0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7',
});

/** One primitive, independently fixed authored SQL string; never caller DATA. */
export function deriveOrderSplit210MetadataText(sourceSql){
 const pin=ORDER_SPLIT210_METADATA_TEXT_SOURCE;
 assert.equal(arguments.length,1,'exactly one authored SQL argument');
 assert.equal(typeof sourceSql,'string','exact authored SQL string required');
 assert.equal(Buffer.byteLength(sourceSql),pin.bytes,'exact Source25 SQL bytes');
 assert.equal(sha(sourceSql),pin.sha256,'exact Source25 SQL SHA');
 assert(!/\bwalk_text\b/.test(sourceSql),'new local cannot shadow the authored source');
 const edits=[],add=(at,before,after,kind)=>{assert.equal(sourceSql.slice(at,at+before.length),before);edits.push({beforeStart:at,before,after,kind});};
 const declaration='walk_index integer;walk_child record;walk_text_path text[];';
 assert.equal(sourceSql.split(declaration).length,2);
 add(sourceSql.indexOf(declaration),declaration,declaration+'walk_text text;','invocation_local_text');
 const gates=[...sourceSql.matchAll(/^ IF value IS NULL OR NOT\([^\n]+$/gm)];
 assert.equal(gates.length,2,'one root and one current-node cheap gate');
 assert(gates[0][0].endsWith('THEN RETURN NULL;END IF;'));
 assert(gates[1][0].endsWith('THEN walk_projection:=NULL;EXIT metadata_node;END IF;'));
 for(const [i,m]of gates.entries()){
  assert.equal((m[0].match(/value::text/g)||[]).length,7,'seven original complete JSONB serializations');
  // SQL NULL still takes the cheap exit without casting; JSONB null is a
  // normal non-NULL value whose text is "null". The original OR order stays.
  add(m.index,m[0],' walk_text:=CASE WHEN value IS NULL THEN NULL ELSE value::text END;\n'+m[0].replaceAll('value::text','walk_text'),i===0?'root_text_once':'current_node_text_once');
 }
 edits.sort((a,b)=>a.beforeStart-b.beforeStart);
 let cursor=0,sql='';
 for(const e of edits){assert(e.beforeStart>=cursor,'disjoint source edits');sql+=sourceSql.slice(cursor,e.beforeStart);e.afterStart=sql.length;sql+=e.after;cursor=e.beforeStart+e.before.length;}sql+=sourceSql.slice(cursor);
 let inverse=sql;
 for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}
 assert.equal(inverse,sourceSql,'whole Source25 declaration/header/body/suffix inverse');
 assert.equal((sql.match(/value::text/g)||[]).length,2,'one cast site per unchanged gate');
 assert.equal((sql.match(/PERFORM public\.order_split210_require\(\)/g)||[]).length,1);
 assert.equal((sql.match(/SELECT payload_jsonb INTO STRICT entries/g)||[]).length,1);
 return freeze({schema:'order-split210-local-metadata-text/v1',sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),edits,source_proofs:pin,
  serialization:{gates:2,old_cast_sites:14,new_cast_sites:2,maximum_casts_per_gate_before:7,maximum_casts_per_gate_after:1,sql_null_casts:0},
  whole_source_inverse_verified:true,source_data_changed:false,cross_invocation_cache:false,new_runtime_functions:0,
  source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
}
