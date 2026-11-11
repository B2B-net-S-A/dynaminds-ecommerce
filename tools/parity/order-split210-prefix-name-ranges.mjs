/** Finite Source32→33 query-only derivation. No SQL execution or runtime authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const ORDER_SPLIT210_PREFIX_NAME_RANGES_SOURCE=freeze({
 schema:'order-split210-prefix-name-ranges-source32/v1',
 authored_program:{bytes:4524613,sha256:'a737148ee97845de656b38d5a92dea341c6040c2ae8b39557d2e248c26c6fc8b'},
 valid:{bytes:53130,sha256:'19558e1f578684cf667275c1f0afa81f458e4f5e4db118a1c56f522bfe0c6c29'},
 query:{bytes:18197,sha256:'0dfdef3651ea239e02ab8c4bfa73537d25b5466d3edad263e4b1ff927e8fa3be'},
 output_valid:{bytes:53744,sha256:'73e000ed23e1714056ba808181d93f3e76437c553a03ef967b7a4792f61a7f2c'},
 measured_query:{bytes:18811,sha256:'7a5547d3cebe9d9071180ccf97a06318ccdc1dc48a2800e4c5a6c2f923f38955'},
 payload:{bytes:3590688,sha256:'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3'},
 diagnostic37:{receipt_sha256:'31055fc3048904da8629ed11f87631190234763de61d2e3d0f8a507e0373616c',root_review_sha256:'277cf44851062e6547f22c48a3e9a8c73a159eb14cc9e171c8d546fc04b0a537',direct_query_parity:true,same_function_SPI_measured:false,full187_accepted:false},
});
const atoms=freeze([
 ['relname','order_split210_',2829],['t.tgname','order_split210_',2988],
 ['k.conname','order_split210_',7171],['p.proname','order_split210_',11737],
 ['t.typname','order_split210_',14212],['t.typname','_order_split210_',14256],
]);
const head='CREATE FUNCTION public.order_split210_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $closure210$';
const tail='$closure210$;\n',capture=' WITH live_changed AS MATERIALIZED(',into=' INTO actual,live_external,live_fingerprint;';
function pinned(sql,ref,label){assert.equal(typeof sql,'string',label+' primitive source');assert.equal(Buffer.byteLength(sql),ref.bytes,label+' bytes');assert.equal(sha(sql),ref.sha256,label+' SHA256');}
function reverse(sql,edits){for(const e of [...edits].reverse()){assert.equal(sql.slice(e.afterStart,e.afterStart+e.after.length),e.after);sql=sql.slice(0,e.afterStart)+e.before+sql.slice(e.afterStart+e.after.length);}return sql;}

/** Keep all original prefix predicates, scope branches, descriptors and STABLE snapshot. */
export function deriveOrderSplit210PrefixNameRanges(validSql){
 assert.equal(arguments.length,1,'one complete authored Source32 declaration');const pin=ORDER_SPLIT210_PREFIX_NAME_RANGES_SOURCE;
 pinned(validSql,pin.valid,'Source32 valid');assert(validSql.startsWith(head)&&validSql.endsWith(tail),'whole fixed header and suffix');
 const start=validSql.indexOf(capture),end=validSql.indexOf(into,start);assert(start>head.length&&end>start);assert.equal(validSql.indexOf(capture,start+1),-1);assert.equal(validSql.indexOf(into,end+1),-1);
 const query=validSql.slice(start,end)+';';pinned(query,pin.query,'entire Source32 capture');
 let result='',cursor=0;const queryEdits=[];
 for(const [column,lower,beforeStart] of atoms){
  const before=`starts_with(${column},'${lower}')`,upper=lower.slice(0,-1)+'`';
  assert.equal(query.slice(beforeStart,beforeStart+before.length),before,'one exact measured prefix atom');assert.equal(query.indexOf(before),beforeStart);assert.equal(query.indexOf(before,beforeStart+before.length),-1);assert(beforeStart>=cursor);
  const after=`(${column} COLLATE "C">='${lower}'::name AND ${column} COLLATE "C"<'${upper}'::name AND ${before})`;
  result+=query.slice(cursor,beforeStart);const afterStart=result.length;result+=after;cursor=beforeStart+before.length;queryEdits.push({column,lower,upper,beforeStart,afterStart,before,after});
 }
 result+=query.slice(cursor);pinned(result,pin.measured_query,'exact measured D37 query');assert.equal(reverse(result,queryEdits),query,'whole capture byte inverse');
 const sql=validSql.slice(0,start)+result.slice(0,-1)+validSql.slice(end),edits=queryEdits.map(e=>({...e,beforeStart:e.beforeStart+start,afterStart:e.afterStart+start}));
 pinned(sql,pin.output_valid,'Source33 valid');assert.equal(reverse(sql,edits),validSql,'whole Source32 valid inverse');
 assert.equal(sql.slice(0,start),validSql.slice(0,start));assert.equal(sql.slice(start+result.length-1),validSql.slice(end),'entire INTO and all guard checks preserved');
 assert(sql.startsWith(head)&&sql.endsWith(tail));
 const bodyStart=head.length,bodyEnd=sql.length-tail.length,bodyEdits=edits.map(e=>({...e,beforeStart:e.beforeStart-bodyStart,afterStart:e.afterStart-bodyStart}));
 assert.equal(reverse(sql.slice(bodyStart,bodyEnd),bodyEdits),validSql.slice(bodyStart,validSql.length-tail.length),'whole body inverse');
 return freeze({schema:'order-split210-prefix-name-ranges-candidate/v1',sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),query_sql:result,query:pin.measured_query,edits,query_edits:queryEdits,body_edits:bodyEdits,source_proofs:pin,
  whole_source_inverse_verified:true,whole_body_inverse_verified:true,whole_capture_inverse_verified:true,original_prefix_predicates_preserved:6,name_ranges_added:6,header_and_suffix_preserved:true,new_runtime_functions:0,cross_invocation_cache:false,
  source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false,performance_acceptance:false});
}
