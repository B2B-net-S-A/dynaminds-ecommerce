/** Fixed Source27 and Source29 guard SQL transformation. No execution or runtime input API. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210TriggerConstraintMap} from './order-split210-trigger-constraint-map.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
export const ORDER_SPLIT210_VALID_SNAPSHOT_SOURCE=freeze({
 schema:'order-split210-source27-valid-sql/v1',key:'public.order_split210_valid()',
 bytes:52236,sha256:'67978756d8bf03a359d831d62f2e6a97ccecc32965260b37b326e4d051a5f78a',
 source27_candidate_sha256:'eeb5034d0d26766f4548a895e3a23b9ae2ab9ad7854215583e8995d9a218c6e3',
 unchanged_basis_bytes:4193843,unchanged_basis_sha256:'0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7',
});

export const ORDER_SPLIT210_VALID_SNAPSHOT_SOURCE29=freeze({
 schema:'order-split210-source29-valid-sql/v1',key:'public.order_split210_valid()',
 bytes:52236,sha256:'b69aa93ce59080ffae9f206676a35361d567967f368509cd8118231e592ec394',
 authored_basis_bytes:4192445,authored_basis_sha256:'fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45',
 metadata_source_bytes:6507,metadata_source_sha256:'cfad1ebdc47ddd2f3c72b058a1736dd4767a244d7ea4c22f51c3a1a655f4499e',
});

/** Only the two independently pinned authored declarations are accepted. The two
 * query arms and complete external selector are taken literally from it.
 * No caller can provide records, a fingerprint, SQL fragments or a verdict. */
export function deriveOrderSplit210ValidSnapshot(sourceSql){
 assert.equal(arguments.length,1,'one fixed authored SQL argument');
 assert.equal(typeof sourceSql,'string','authored SQL string required');
 const digest=sha(sourceSql),pin=[ORDER_SPLIT210_VALID_SNAPSHOT_SOURCE,ORDER_SPLIT210_VALID_SNAPSHOT_SOURCE29].find(p=>p.bytes===Buffer.byteLength(sourceSql)&&p.sha256===digest);
 assert(pin,'exact finite Source27 or Source29 guard bytes/SHA');
 const head='CREATE FUNCTION '+pin.key+' RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $closure210$';
 assert(sourceSql.startsWith(head)&&sourceSql.endsWith('$closure210$;\n'),'complete declaration/header/suffix');
 assert(!/\blive_(changed|own|all|external|fingerprint)\b/.test(sourceSql),'fresh local names');
 const aggregate=`coalesce(jsonb_agg(record ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]'::jsonb)`;
 const prefix='SELECT '+aggregate+' INTO actual FROM(';
 const selectedStart=sourceSql.indexOf(prefix),selectedEnd=sourceSql.indexOf(') full_after;',selectedStart);
 assert(selectedStart>0&&selectedEnd>selectedStart);
 const changedQuery=sourceSql.slice(selectedStart+prefix.length,selectedEnd);
 const externalStart=sourceSql.indexOf(prefix,selectedEnd),externalEnd=sourceSql.indexOf(';',externalStart);
 assert(externalStart>selectedEnd&&externalEnd>externalStart&&sourceSql.indexOf(prefix,externalEnd)<0,'exactly two live record reads');
 const externalStatement=sourceSql.slice(externalStart,externalEnd+1);
 const split=externalStatement.indexOf(') external_live WHERE ');assert(split>prefix.length);
 const ownQuery=externalStatement.slice(prefix.length,split);
 const externalPredicate=externalStatement.slice(split+') external_live WHERE '.length,-1);
 assert(changedQuery.startsWith("SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM("));
 assert(ownQuery.startsWith('WITH rels AS MATERIALIZED('));
 assert.equal((externalPredicate.match(/'public\.[^']+'/g)||[]).length,36,'whole fixed external36 selector');
 const fingerprintExpression=`encode(sha256(convert_to(jsonb_build_object('records',(SELECT ${aggregate} FROM live_all),'basis',(SELECT jsonb_build_object('count',count(*),'bytes',min(payload_octets),'sha',min(payload_sha256)) FROM public.order_split210_projection_basis))::text,'UTF8')),'hex')`;
 const capture=`WITH live_changed AS MATERIALIZED(${changedQuery}),live_own AS MATERIALIZED(${ownQuery}),live_all AS MATERIALIZED(SELECT record FROM live_own UNION ALL SELECT record FROM live_changed) SELECT (SELECT ${aggregate} FROM live_changed),(SELECT ${aggregate} FROM live_own WHERE ${externalPredicate}),${fingerprintExpression} INTO actual,live_external,live_fingerprint;`;
 const edits=[],add=(before,after,kind)=>{const at=sourceSql.indexOf(before);assert(at>=0&&sourceSql.indexOf(before,at+1)<0,'one fixed '+kind);edits.push({beforeStart:at,before,after,kind});};
 add('actual jsonb; entries jsonb;','actual jsonb; entries jsonb; live_external jsonb; live_fingerprint text;','invocation_local_outputs');
 add(sourceSql.slice(selectedStart,selectedEnd+') full_after;'.length),capture,'single_statement_complete_capture');
 add(externalStatement,'actual:=live_external;','reuse_exact_external_rows');
 add('RETURN m.fingerprint IS NOT DISTINCT FROM public.order_split210_fingerprint();','RETURN m.fingerprint IS NOT DISTINCT FROM live_fingerprint;','reuse_same_ordered_fingerprint');
 edits.sort((a,b)=>a.beforeStart-b.beforeStart);let sql='',cursor=0;
 for(const edit of edits){assert(edit.beforeStart>=cursor,'disjoint fixed edits');sql+=sourceSql.slice(cursor,edit.beforeStart);edit.afterStart=sql.length;sql+=edit.after;cursor=edit.beforeStart+edit.before.length;}sql+=sourceSql.slice(cursor);
 let triggerConstraintMap;
 if(pin===ORDER_SPLIT210_VALID_SNAPSHOT_SOURCE29){
  const priorSql=sql;
  assert.equal(Buffer.byteLength(priorSql),52821,'entire previous Source29 guard');
  assert.equal(sha(priorSql),'8265baf087e1a1d5b3290c17cd0018a153dc766e341399774285481d510eab24');
  const into=' INTO actual,live_external,live_fingerprint;';
  const line=' '+capture,at=priorSql.indexOf(line);
  assert(at>=0&&priorSql.indexOf(line,at+1)<0&&line.endsWith(into),'one complete Source29 capture line');
  const query=line.slice(0,-into.length)+';';
  const mapped=deriveOrderSplit210TriggerConstraintMap(query);
  const bodyEdits=mapped.edits.map(edit=>({...edit,beforeStart:at+edit.beforeStart,afterStart:at+edit.afterStart}));
  let optimized=priorSql;
  for(const edit of [...bodyEdits].reverse()){
   assert.equal(optimized.slice(edit.beforeStart,edit.beforeStart+edit.before.length),edit.before);
   optimized=optimized.slice(0,edit.beforeStart)+edit.after+optimized.slice(edit.beforeStart+edit.before.length);
  }
  let previous=optimized;
  for(const edit of [...bodyEdits].reverse()){
   assert.equal(previous.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);
   previous=previous.slice(0,edit.afterStart)+edit.before+previous.slice(edit.afterStart+edit.after.length);
  }
  assert.equal(previous,priorSql,'entire optimized guard inverse to current Source29');
  const mappedLine=mapped.sql.slice(0,-1)+into;
  assert.equal(optimized,priorSql.slice(0,at)+mappedLine+priorSql.slice(at+line.length),'only the reviewed query-local edits');
  edits.find(edit=>edit.kind==='single_statement_complete_capture').after=mappedLine.slice(1);
  sql='';cursor=0;
  for(const edit of edits){sql+=sourceSql.slice(cursor,edit.beforeStart);edit.afterStart=sql.length;sql+=edit.after;cursor=edit.beforeStart+edit.before.length;}sql+=sourceSql.slice(cursor);
  assert.equal(sql,optimized,'composed raw-source edits equal the whole-guard transformation');
  const ownStart=mapped.sql.indexOf(',live_own AS MATERIALIZED(')+',live_own AS MATERIALIZED('.length;
  const ownEnd=mapped.sql.indexOf('),live_all AS MATERIALIZED(',ownStart);assert(ownStart>0&&ownEnd>ownStart);
  triggerConstraintMap={source_proofs:mapped.source_proofs,query_sql:mapped.sql,query_bytes:mapped.bytes,query_sha256:mapped.sha256,
   effective_own_query:mapped.sql.slice(ownStart,ownEnd),body_edits:bodyEdits,
   previous_guard:{bytes:Buffer.byteLength(priorSql),sha256:sha(priorSql)},whole_previous_guard_inverse_verified:true,
   cross_invocation_cache:false,new_runtime_functions:0,performance_acceptance:false};
 }
 let inverse=sql;for(const edit of [...edits].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);}assert.equal(inverse,sourceSql,'whole pinned guard inverse');
 assert.equal(sql.split(changedQuery).length,2);assert.equal(sql.split(triggerConstraintMap?.effective_own_query??ownQuery).length,2);
 assert(!sql.includes('public.order_split210_fingerprint()'),'no second live catalogue traversal');
 return freeze({schema:'order-split210-same-statement-valid-snapshot/v1',sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),edits,source_proofs:pin,
  ...(triggerConstraintMap?{trigger_constraint_map:triggerConstraintMap}:{}),
  queries:{changed_functions:changedQuery,own:ownQuery,external_predicate:externalPredicate,aggregate,fingerprint_expression:fingerprintExpression},
  snapshot:{changed_reads_before:2,changed_reads_after:1,own_reads_before:2,own_reads_after:1,changed_descriptors:22,own_kinds:8,external_records:36,scope:'one SQL statement in one guard invocation',standalone_fingerprint_changed:false},
  whole_source_inverse_verified:true,source_data_changed:false,cross_invocation_cache:false,new_runtime_functions:0,
  source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
}
