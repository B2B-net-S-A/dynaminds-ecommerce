/** Finite Source33 query candidate only. No SQL execution or generator wiring. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const ORDER_SPLIT210_CONSTRAINT_CANDIDATES_SOURCE=freeze({
 schema:'order-split210-constraint-candidates-source33/v1',
 authored_program:{bytes:4525227,sha256:'23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d'},
 valid:{bytes:53744,sha256:'73e000ed23e1714056ba808181d93f3e76437c553a03ef967b7a4792f61a7f2c'},
 body:{bytes:53578,sha256:'5525a9adb76cbc72e07b907b8a5d5c6723d7df0ba41449f6d8f701cc702e3df2'},
 query:{bytes:18811,sha256:'7a5547d3cebe9d9071180ccf97a06318ccdc1dc48a2800e4c5a6c2f923f38955'},
 payload:{bytes:3590688,sha256:'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3'},
});
const head='CREATE FUNCTION public.order_split210_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $closure210$';
const tail='$closure210$;\n',capture=' WITH live_changed AS MATERIALIZED(',into=' INTO actual,live_external,live_fingerprint;';
const ownRelation="k.conrelid IN(SELECT oid FROM rels)";
const publicPrefix="n.nspname='public' AND (k.conname COLLATE \"C\">='order_split210_'::name AND k.conname COLLATE \"C\"<'order_split210`'::name AND starts_with(k.conname,'order_split210_'))";
const catalogueJoins='JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace LEFT JOIN pg_catalog.pg_class c ON c.oid=k.conrelid';
const originalTail='FROM pg_catalog.pg_constraint k '+catalogueJoins+' WHERE '+ownRelation+' OR('+publicPrefix+')';
const selectedTail='FROM source33_constraints k '+catalogueJoins;
const insertion='), entries(kind,key,value)AS(';
const candidateCtes=', source33_constraint_oids AS MATERIALIZED('
 +'SELECT k.oid FROM pg_catalog.pg_constraint k WHERE '+ownRelation
 +' UNION SELECT k.oid FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace WHERE '+publicPrefix+')'
 +', source33_constraints AS MATERIALIZED(SELECT k.* FROM source33_constraint_oids source33_pick JOIN pg_catalog.pg_constraint k ON k.oid=source33_pick.oid)';

function pinned(value,pin,label){assert.equal(typeof value,'string',label+' primitive source');assert.equal(Buffer.byteLength(value),pin.bytes,label+' bytes');assert.equal(sha(value),pin.sha256,label+' SHA256');}
function reverse(value,edits){for(const edit of [...edits].reverse()){assert.equal(value.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);value=value.slice(0,edit.afterStart)+edit.before+value.slice(edit.afterStart+edit.after.length);}return value;}

/** Split the two original OR scopes, deduplicating only catalogue OIDs. Every
 * selected row is rejoined to the same live pg_constraint snapshot, then passed
 * to the unchanged full descriptor expression/namespace join/LEFT JOIN class.
 * In particular, the own-relation arm gets no extra namespace/type condition;
 * the public-prefix arm still includes domain constraints with conrelid=0.
 * There is no callee dispatch, cache, verdict reuse or claimed query-plan gain.
 */
export function deriveOrderSplit210ConstraintCandidates(validSql){
 assert.equal(arguments.length,1,'one complete authored Source33 declaration');
 const pin=ORDER_SPLIT210_CONSTRAINT_CANDIDATES_SOURCE;
 pinned(validSql,pin.valid,'Source33 valid');assert(validSql.startsWith(head)&&validSql.endsWith(tail),'whole fixed header/suffix');
 const body=validSql.slice(head.length,-tail.length);pinned(body,pin.body,'whole Source33 body');
 const start=validSql.indexOf(capture),end=validSql.indexOf(into,start);
 assert(start>head.length&&end>start);assert.equal(validSql.indexOf(capture,start+1),-1);assert.equal(validSql.indexOf(into,end+1),-1);
 const query=validSql.slice(start,end)+';';pinned(query,pin.query,'whole Source33 capture');
 assert(!/\bsource33_(?:constraint_oids|constraints|pick)\b/.test(validSql),'new statement-local names');
 const queryEdits=[];
 function edit(before,after,kind){const beforeStart=query.indexOf(before);assert(beforeStart>=0&&query.indexOf(before,beforeStart+before.length)<0,'one exact '+kind);queryEdits.push({kind,beforeStart,before,after});}
 edit(insertion,')'+candidateCtes+', entries(kind,key,value)AS(','two_scope_oid_union');
 edit(originalTail,selectedTail,'same_full_constraint_descriptor');
 queryEdits.sort((a,b)=>a.beforeStart-b.beforeStart);
 let candidate='',cursor=0;
 for(const edit of queryEdits){assert(edit.beforeStart>=cursor);candidate+=query.slice(cursor,edit.beforeStart);edit.afterStart=candidate.length;candidate+=edit.after;cursor=edit.beforeStart+edit.before.length;}
 candidate+=query.slice(cursor);assert.equal(reverse(candidate,queryEdits),query,'whole capture inverse');
 // The selector contains no descriptor value/pg_node_tree UNION equality and no
 // UNION ALL duplicate rows when one OID satisfies both original branches.
 assert(candidate.includes('SELECT k.oid FROM pg_catalog.pg_constraint k WHERE '+ownRelation+' UNION SELECT k.oid'));
 assert.equal((candidate.match(/starts_with\(/g)||[]).length,(query.match(/starts_with\(/g)||[]).length,'every original prefix predicate retained exactly once');
 const sql=validSql.slice(0,start)+candidate.slice(0,-1)+validSql.slice(end);
 const edits=queryEdits.map(edit=>({...edit,beforeStart:edit.beforeStart+start,afterStart:edit.afterStart+start}));
 assert.equal(reverse(sql,edits),validSql,'whole Source33 declaration inverse');
 assert.equal(sql.slice(0,start),validSql.slice(0,start));assert.equal(sql.slice(start+candidate.length-1),validSql.slice(end),'entire INTO/checks/fingerprint tail unchanged');
 assert(sql.startsWith(head)&&sql.endsWith(tail));
 const bodyEdits=edits.map(edit=>({...edit,beforeStart:edit.beforeStart-head.length,afterStart:edit.afterStart-head.length}));
 assert.equal(reverse(sql.slice(head.length,-tail.length),bodyEdits),body,'whole Source33 body inverse');
 return freeze({schema:'order-split210-constraint-candidates-candidate/v1',sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),query_sql:candidate,query:{bytes:Buffer.byteLength(candidate),sha256:sha(candidate)},edits,query_edits:queryEdits,body_edits:bodyEdits,source_proofs:pin,
  invariants:{constraint_scope_branches:2,deduplication:'catalogue_oid_only',descriptor_fields_unchanged:true,public_namespace:'constraint namespace, not relation namespace',domain_constraints_included:true,own_relation_namespace_unrestricted:true,other_own_arms_unchanged:7,all_guard_checks_unchanged:true,all_require_calls_unchanged:true,statement_snapshot_and_SPI_boundary_unchanged:true},
  whole_source_inverse_verified:true,whole_body_inverse_verified:true,whole_capture_inverse_verified:true,header_and_suffix_preserved:true,source_data_changed:false,new_runtime_functions:0,cross_invocation_cache:false,
  sql_executed:false,source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false,performance_acceptance:false});
}
