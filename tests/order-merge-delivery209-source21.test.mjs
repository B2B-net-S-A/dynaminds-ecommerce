/** Source21 integration. No SQL dispatch, Native or runtime acceptance. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {deriveOrderMergeDelivery209Bodies,deriveOrderMergeDelivery209Manifest,assembleOrderMergeDelivery209,deriveOrderMergeDelivery209Seal} from '../tools/parity/order-merge-delivery209-source.mjs';
import {deriveOrderMergeDelivery209Predecessor,projectOrderMergeDelivery209FunctionCheck,projectOrderMergeDelivery209Descriptor,orderMergeDelivery209SqlSpans as spans} from '../tools/parity/order-merge-delivery209-predecessor.mjs';
import {deriveOrderMergeDelivery209ValidationSnapshot} from '../tools/parity/order-merge-delivery209-validation-snapshot.mjs';
import {deriveOrderMergeDelivery209SourceHashPort,rewriteOrderMergeDelivery209SourceHashes} from '../tools/parity/order-merge-delivery209-source-hash-port.mjs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8'),sha=value=>createHash('sha256').update(value).digest('hex');
const source166=read('server/166_buyer_address_sidecar.sql'),source204=read('server/204_partial_commercial_sale_scope.sql'),source181=read('server/181_same_root_guard_observations.sql'),core=read('tools/parity/order-merge-delivery209-business.sql');
const buyer=deriveOrderMergeDelivery209Bodies({source166}),base={changes:buyer,source166};
const routine=(sql,tag)=>{assert.equal(sql.split(tag).length,3);return sql.split(tag)[1];};
const localTags=['$local_descriptor209$','$local_definition209$','$local_source209$'];
// Release huge historical DATA/escaped SQL between derivations; preserve exact
// whole-program hashes and the small descriptors/ports needed by comparisons.
function summary(runtimeRevision){
 const candidate=deriveOrderMergeDelivery209Predecessor({...base,...(runtimeRevision>=19?{source204}:{}),...(runtimeRevision>=20?{source181}:{}),runtimeRevision});
 const assembled=assembleOrderMergeDelivery209({source166,core,predecessor:candidate});
 return{sql_sha256:assembled.sql_sha256,bytes:Buffer.byteLength(assembled.sql),changes:candidate.changes,
  projection_basis:candidate.projection_basis,projection_counts:candidate.projection_counts,runtime_closure_helpers:candidate.runtime_closure_helpers,
  ports:Object.fromEntries(localTags.map(tag=>[tag,routine(candidate.sql,tag)]))};
}
const historical=[18,19,20].map(summary),prior=historical[2];
const candidate=deriveOrderMergeDelivery209Predecessor({...base,source204,source181,runtimeRevision:21});
const all=[...buyer,...candidate.changes],snapshot=deriveOrderMergeDelivery209ValidationSnapshot({changes:all}),
 hashPort=deriveOrderMergeDelivery209SourceHashPort({projectionBasis:candidate.projection_basis});
const hashSites=[2,0,23,78,1,7];
const executable=source=>spans(source).filter(part=>part.executable).map(part=>part.text).join('');

test('full Source18/19/20 SQL bytes and SHA remain literal, including wrapped default own fingerprint',()=>{
 for(const [index,expected]of [
  ['9e25cb8442f85380eac367c26ba0d0c9fd0f7f6ac1588ed281cab153d9d8b50d',27029809],
  ['97208701dc50ceef2e47140c1cbfde68fb4eeb41ab3bd59ed4f9206d07814a30',27462515],
  ['d69ed0c143b42caaa5f830c1978a0e7013894d06c75113017c17d1aa34d3350e',27553076],
 ].entries())assert.deepEqual([historical[index].sql_sha256,historical[index].bytes],expected);
});

test('exact111 closed SHA edits reverse every complete legacy body and definition to Source20 without header/ACL changes',()=>{
 let total=0,remaining=0;const changed=[];
 assert.equal(candidate.changes.length,6);assert.deepEqual(candidate.changes.map(change=>change.key),prior.changes.map(change=>change.key));
 for(let index=0;index<6;index++){
  const current=candidate.changes[index],before=prior.changes[index],witness=rewriteOrderMergeDelivery209SourceHashes(before.after.source,{expectedSites:hashSites[index]});
  assert.equal(current.after.source,witness.source);assert.deepEqual(current.before,before.before);
  let restored=current.after.source;
  for(const edit of [...witness.replacements].reverse()){
   assert.equal(restored.slice(edit.rewritten_start,edit.rewritten_end),edit.after);
   restored=restored.slice(0,edit.rewritten_start)+edit.before+restored.slice(edit.rewritten_end);
  }
  assert.equal(restored,before.after.source);assert.equal(current.after.definition.replace(current.after.source,()=>restored),before.after.definition);
  for(const field of Object.keys(before.after).filter(field=>!['source','definition'].includes(field)))assert.deepEqual(current.after[field],before.after[field],field);
  total+=witness.count;remaining+=(executable(current.after.source).match(/order_merge_delivery209_predecessor_source\(/g)||[]).length;
  if(witness.count)changed.push(current.key);
 }
 assert.equal(total,111);assert.equal(remaining,73);assert.equal(changed.length,5,'zero-site manual projection remains byte-identical');
 assert.deepEqual(candidate.projection_counts,prior.projection_counts);assert.deepEqual(candidate.runtime_closure_helpers,prior.runtime_closure_helpers,'all six actual runtime history adapters are literal');
});

test('Source21 DATA computes AFTER/check only after all hash edits and retains exact original full24 BEFORE records',()=>{
 const marker="INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'",start=candidate.preambleSql.indexOf(marker);
 assert(start>=0&&candidate.preambleSql.endsWith("');\n"));const raw=candidate.preambleSql.slice(start+marker.length,-4).replaceAll("''","'");
 assert.equal(Buffer.byteLength(raw),candidate.projection_basis.bytes);assert.equal(sha(raw),candidate.projection_basis.sha256);
 const entries=JSON.parse(raw);assert.equal(entries.length,10);
 for(let index=0;index<10;index++){
  assert.equal(entries[index].key,all[index].key);assert.deepEqual(entries[index].before,all[index].before);assert.deepEqual(entries[index].after,all[index].after);
  assert.deepEqual(entries[index].after_check,projectOrderMergeDelivery209FunctionCheck(all[index].after));
 }
 assert.notDeepEqual(candidate.projection_basis,prior.projection_basis);
 assert(candidate.sql.includes(hashPort.sql),'port is derived from the FINAL source-owned basis');
});

test('manifest installs one private snapshot before the fingerprint wrapper; inverse restores all original manifest bytes',()=>{
 const old=deriveOrderMergeDelivery209Manifest(all),current=deriveOrderMergeDelivery209Manifest(all,{validationSnapshot:true});
 assert.equal(current.split(snapshot.sql).length-1,1);
 assert(current.indexOf(snapshot.sql)<current.indexOf('CREATE FUNCTION public.order_merge_delivery209_fingerprint()'));
 const withoutSnapshot=current.replace(snapshot.sql+'\n','');
 assert.equal(routine(withoutSnapshot,'$fp209$'),snapshot.fingerprint_source);
 assert.equal(withoutSnapshot.replace('$fp209$'+snapshot.fingerprint_source+'$fp209$',()=>'$fp209$'+snapshot.original_fingerprint_source+'$fp209$'),old);
 assert.throws(()=>deriveOrderMergeDelivery209Manifest(all,{directOwnRows:true,validationSnapshot:true}),/wrapped own fingerprint/);
 assert(!executable(snapshot.query).includes('order_merge_delivery209_valid()'));assert(!executable(snapshot.query).includes('order_merge_delivery209_fingerprint()'));
 assert.equal((snapshot.query.match(/AS MATERIALIZED\s*\(/g)||[]).length,2,'one legacy CTE plus unchanged own relations CTE');
});

test('checked frame uses one fresh snapshot and retains all manifest, UTF8, source-row and exact10 CURRENT24 checks',()=>{
 const body=routine(candidate.sql,'$checked209$');
 assert.equal(body.split('snapshot_value:=public.order_merge_delivery209_validation_snapshot();').length-1,1);
 assert(!body.includes('public.order_merge_delivery209_valid()'),'no second full fingerprint invocation');
 for(const token of ["current_setting('server_encoding') IS DISTINCT FROM 'UTF8'",'count(*) FROM public.order_merge_delivery209_manifest)<>1',
  'count(*) FROM public.buyer_address_manifest)<>1','SELECT * INTO m FROM public.order_merge_delivery209_manifest WHERE id',
  "m.profile IS DISTINCT FROM 'merge-delivery-inheritance/v1'",'m.original166 IS DISTINCT FROM(SELECT to_jsonb(b) FROM public.buyer_address_manifest b)',
  "m.fingerprint IS DISTINCT FROM(snapshot_value->>'fingerprint')","jsonb_typeof(current_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(current_rows)<>10",
  'payload_present IS DISTINCT FROM true','source_id IS DISTINCT FROM true','payload_bytes IS DISTINCT FROM '+candidate.projection_basis.bytes,
  "payload_hash IS DISTINCT FROM '"+candidate.projection_basis.sha256+"'",'binding_ordinal NOT BETWEEN 1 AND 10',"IF total IS DISTINCT FROM 1 THEN",
  "actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'",'IF validated<>10 THEN'])assert(body.includes(token),token);
 assert(body.includes('SELECT count(*) INTO total FROM jsonb_array_elements(current_rows)'));
 assert(body.includes("r.value->>'kind'='function' AND split_part(r.value->>'key','(',1)=split_part(entry->>'key','(',1)"),'per-name overload check, not only complete-key lookup');
 assert(body.includes('WITH ORDINALITY AS a(key,after_check,ordinal)'));
 assert.equal((body.match(/FROM pg_catalog\.pg_proc/g)||[]).length,1,'only unchanged selected-name identity lookup, no duplicate full10 hash query');
 assert(!body.includes('pg_get_functiondef'));assert(!body.includes('jsonb_object_agg('));
 const pre=body.indexOf('IF scoped IS DISTINCT FROM true THEN RETURN NULL;');assert(pre>=0&&pre<body.indexOf('snapshot_value:='),'unscoped identity stays before transformed authority');
});

test('local selected CURRENT24 ports are untouched except the source-derived byte/hash constants',()=>{
 for(const tag of localTags){
  let body=routine(candidate.sql,tag);const old=prior.ports[tag];
  for(const field of ['bytes','sha256']){
   const before=String(prior.projection_basis[field]),after=String(candidate.projection_basis[field]),count=old.split(before).length-1;
   assert(count===0||count===1);assert.equal(body.split(after).length-1,count);if(count)body=body.replace(after,()=>before);
  }
  assert.equal(sha(body),sha(old),tag);
 }
 const descriptor=routine(candidate.sql,'$local_descriptor209$');
 assert(descriptor.includes('209 invocation frame required'));assert(descriptor.includes('IF total<>1 OR entry IS NULL'));
 assert(descriptor.includes("live IS DISTINCT FROM entry->'after_check'"));assert(descriptor.includes("jsonb_typeof(selected_before) IS DISTINCT FROM 'object'"));
});

test('independent existing exact-record oracle rejects every CURRENT24 field drift and all snapshot roster ambiguities',()=>{
 const expected=all.map(change=>({...change,after:projectOrderMergeDelivery209FunctionCheck(change.after)}));
 const rows=expected.map(change=>({kind:'function',key:change.key,value:change.after}));
 assert.equal(rows.length,10);for(const row of rows)assert.equal(Object.keys(row.value).length,24);
 assert.deepEqual(projectOrderMergeDelivery209Descriptor(rows,expected,expected[0].key),expected[0].before);
 for(let index=0;index<10;index++)for(const field of Object.keys(rows[index].value)){
  const changed=structuredClone(rows),value=changed[index].value[field];
  changed[index].value[field]=typeof value==='boolean'?!value:typeof value==='number'?value+1:value===null?'nonnull':null;
  assert.throws(()=>projectOrderMergeDelivery209Descriptor(changed,expected,expected[0].key),/exact complete AFTER descriptor/,rows[index].key+':'+field);
 }
 for(const changed of [rows.slice(1),[...rows,rows[0]],
  [...rows,{kind:'function',key:'public.buyer_address_guards(unexpected integer)',value:rows[0].value}]])
  assert.throws(()=>projectOrderMergeDelivery209Descriptor(changed,expected,expected[0].key),/missing|duplicate|overloaded/);
});

test('new hash port retains exact current24, overloaded-name refusal, compact-frame check and final source-row provenance',()=>{
 const body=routine(hashPort.sql,'$source_sha209$');
 for(const token of ["jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>10",'IF total<>1 OR entry IS NULL',
  "live IS DISTINCT FROM entry->'after_check'",'source_id IS DISTINCT FROM true','payload_present IS DISTINCT FROM true',
  'payload_bytes IS DISTINCT FROM '+candidate.projection_basis.bytes,"payload_hash IS DISTINCT FROM '"+candidate.projection_basis.sha256+"'"])
  assert(body.includes(token),token);
 for(const field of ['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'])assert(body.includes("'"+field+"',"),field);
 assert.equal(body.split("'sha256-utf8-text/v1'").length-1,2);assert(!body.includes('payload_jsonb'));assert(!/SELECT[^;]*before_[0-9]/.test(body));
 assert.equal(hashPort.before_hashes.length,10);for(const record of hashPort.before_hashes)assert.equal(record.sha256,sha(all.find(change=>change.key===record.key).before.source));
 const beforeRecords=all.map(change=>({kind:change.kind,key:change.key,value:change.before}));
 assert.equal(deriveOrderMergeDelivery209SourceHashPort({projectionBasis:candidate.projection_basis,beforeRecords}).sql,hashPort.sql);
 for(const field of ['owner','acl','source','definition']){
  const invalid=structuredClone(beforeRecords);invalid[0].value[field]=field==='acl'?[]:'altered';
  assert.throws(()=>deriveOrderMergeDelivery209SourceHashPort({projectionBasis:candidate.projection_basis,beforeRecords:invalid}),/complete independently compiled source BEFORE basis/);
 }
 assert.throws(()=>deriveOrderMergeDelivery209SourceHashPort({projectionBasis:candidate.projection_basis,beforeRecords:beforeRecords.slice(1)}));
});

test('assembly has both new sealed own functions, preserves old certificates and rejects malformed revision provenance',t=>{
 const assembled=assembleOrderMergeDelivery209({source166,core,predecessor:candidate});
 t.diagnostic('Source21 candidate '+JSON.stringify({bytes:Buffer.byteLength(assembled.sql),sha256:assembled.sql_sha256,basis:candidate.projection_basis}));
 assert(assembled.sql.includes(snapshot.sql));assert(assembled.sql.includes(hashPort.sql));
 assert(candidate.helper_keys.includes('public.order_merge_delivery209_validation_snapshot'));assert(candidate.helper_keys.includes('public.order_merge_delivery209_predecessor_source_sha'));
 for(const signature of ['validation_snapshot()','predecessor_source_sha(oid,jsonb)'])assert(assembled.sql.includes('REVOKE ALL ON FUNCTION public.order_merge_delivery209_'+signature+' FROM PUBLIC,dyna_app;'));
 const seal=deriveOrderMergeDelivery209Seal();assert(assembled.sql.endsWith(seal));assert(seal.includes('WHERE grantee<>o.owner'));
 assert(!seal.includes('GRANT EXECUTE ON FUNCTION public.order_merge_delivery209_validation_snapshot'));assert(!seal.includes('GRANT EXECUTE ON FUNCTION public.order_merge_delivery209_predecessor_source_sha'));
 for(const relation of ['buyer_address_manifest','large_import173_certificate','wave_print177_certificate'])assert(!assembled.sql.includes('UPDATE public.'+relation));
 for(const result of [candidate,assembled])for(const flag of ['source_compilation_performed','native_certification','application_activation'])assert.equal(result[flag],false);
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({...base,source204,runtimeRevision:21}),/literal Source181/);
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({...base,source204,source181:source181+'\n',runtimeRevision:21}),/literal source181/);
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({...base,source204,source181,runtimeRevision:23}),/supported source revision/);
});
