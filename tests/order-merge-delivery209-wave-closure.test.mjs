import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {
 ORDER_MERGE_DELIVERY209_WAVE_SOURCE as PINS,
 deriveOrderMergeDelivery209WaveClosure,
 projectOrderMergeDelivery209OperativeSource as operative,
 projectOrderMergeDelivery209WaveSource as wave,
} from '../tools/parity/order-merge-delivery209-wave-closure.mjs';
import {deriveOrderMergeDelivery209Bodies} from '../tools/parity/order-merge-delivery209-source.mjs';
import {deriveOrderMergeDelivery209Predecessor} from '../tools/parity/order-merge-delivery209-predecessor.mjs';

const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
const result=deriveOrderMergeDelivery209WaveClosure({source204});
const sha=value=>createHash('sha256').update(value).digest('hex');
// The published E209 contract is now Native21 (b37cf5a) and already carries these edges.
// The historical Source18 ordinary187 body is re-derived from source and pinned to the Native18 contract (b37cf5a^).
const source166=readFileSync(new URL('../server/166_buyer_address_sidecar.sql',import.meta.url),'utf8');
function source18Ordinary187(){
 const body=deriveOrderMergeDelivery209Predecessor({changes:deriveOrderMergeDelivery209Bodies({source166}),source166}).changes.find(change=>change.key==='public.ordinary187_valid()').after.source;
 assert.equal(Buffer.byteLength(body),1536929);assert.equal(sha(body),'a5035cc50f4a27534cf6462e7ba4be4673ca78f22229fd168d562f810fb51df6','exact historical Native18 ordinary187 body');
 return body;
}
const executable=source=>spans(source).filter(span=>span.executable).map(span=>span.text).join('');
const reverse=(source,index)=>spans(source).map(span=>!span.executable?span.text:index===0
 ?span.text.replaceAll('public.order_merge_delivery209_constraint_definition(c.oid)','pg_get_constraintdef(c.oid,true)')
 :span.text.replaceAll('public.order_merge_delivery209_history_operative_valid(manual_basis)','public.ordinary181_history_operative_valid(manual_basis)')).join('');

test('both historical full24 records match independent compiled Source204 contract',async()=>{
 const {PACKING204_SOURCE_CONTRACT:E204}=await import('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs');
 assert.equal(sha(source204),PINS.source204_sha256);
 for(const record of result.historical_predecessors){
  const records=E204.changes.filter(change=>change.key===record.key);assert.equal(records.length,1);
  assert.deepEqual(record,{kind:records[0].kind,key:records[0].key,value:records[0].after});
  assert.equal(Object.keys(record.value).length,24);
 }
});

test('operative clone changes exactly the buyer319 arm and preserves all financial/document constraints',()=>{
 const before=result.historical_predecessors[0].value.source,after=result.helpers[0].value.source;
 assert.equal(reverse(after,0),before);
 assert.deepEqual(result.projection_sites[0],{buyer319_constraint_definitions:1});
 const oldArm=before.split('\n').filter(line=>line.includes('pg_get_constraintdef(c.oid,true)'));
 assert.equal(oldArm.length,1);assert(oldArm[0].includes("starts_with(t.relname,'buyer_address_')"));
 assert.equal((executable(after).match(/public\.order_merge_delivery209_constraint_definition\(c\.oid\)/g)||[]).length,1);
 assert.equal((executable(after).match(/pg_get_constraintdef\(k\.oid,true\)/g)||[]).length,(executable(before).match(/pg_get_constraintdef\(k\.oid,true\)/g)||[]).length);
 assert.equal((executable(after).match(/pg_get_constraintdef\(oid,true\)/g)||[]).length,(executable(before).match(/pg_get_constraintdef\(oid,true\)/g)||[]).length);
 assert.equal((executable(after).match(/pg_get_constraintdef\(k\.oid,true\)/g)||[]).length,3);
 assert(after.includes("cert.original166_manifest->>'fingerprint' IS DISTINCT FROM buyer319_fingerprint"));
});

test('wave clone changes only its one real operative call; quoted old wave bodies remain literal',()=>{
 const before=result.historical_predecessors[1].value.source,after=result.helpers[1].value.source;
 assert.equal(reverse(after,1),before);
 assert.deepEqual(result.projection_sites[1],{operative_calls:1});
 for(let index=0;index<2;index++)assert.deepEqual(spans(result.helpers[index].value.source).filter(span=>!span.executable),spans(result.historical_predecessors[index].value.source).filter(span=>!span.executable));
 assert(after.includes('RETURN public.wave_print177_history_nested172_valid() IS TRUE AND public.order_merge_delivery209_history_operative_valid(manual_basis) IS TRUE;'));
 assert(spans(after).some(span=>!span.executable&&span.text.startsWith('$packing189_old_source$')),'historical dollar-quoted wave source remains present');
 assert(after.includes('EXCEPTION WHEN OTHERS THEN RETURN false;'));
});

test('parent/PIM keep original call graph and consume corrected wave without a second operative edge',()=>{
 const source181=readFileSync(new URL('../server/181_same_root_guard_observations.sql',import.meta.url),'utf8');
 const body=name=>{const start=source181.indexOf('CREATE FUNCTION public.'+name+'(');assert(start>=0);const tag='$ordinary181$',open=source181.indexOf('AS '+tag,start)+3+tag.length;return source181.slice(open,source181.indexOf(tag,open));};
 const parents=executable(body('ordinary181_history_parents_valid')),pim=executable(body('ordinary181_history_pim_valid'));
 assert(parents.includes('RETURN public.ordinary181_history_pim_valid(manual_basis,wave_ok) IS NOT DISTINCT FROM true;'));
 assert(!pim.includes('ordinary181_history_operative_valid('));assert(!parents.includes('ordinary181_history_operative_valid('));
 for(const name of ['ordinary181_nested_valid','ordinary181_packed_guards','ordinary181_parcel_valid','ordinary181_warehouse_issuer_guards'])assert(pim.includes('public.'+name+'(wave_ok)'),name);
 assert.deepEqual(result.call_graph.retained_wave_consumers.map(name=>name.slice(7)).sort(),['ordinary181_nested_valid','ordinary181_packed_guards','ordinary181_parcel_valid','ordinary181_warehouse_issuer_guards'].sort());
});

test('one fixed executable187 wave call is replaced; history parents call is preserved',async()=>{
 const body=source18Ordinary187();
 assert.deepEqual(result.replacement,{key:'public.ordinary187_valid()',before:'public.ordinary181_wave_valid(manual_basis)',after:'public.order_merge_delivery209_wave_valid(manual_basis)',expected_executable_occurrences:1});
 assert.equal(executable(body).split(result.replacement.before).length-1,1);
 assert(executable(body).includes('RETURN public.ordinary181_history_parents_valid(manual_basis,wave_ok);'));
 const changed=spans(body).map(span=>span.executable?span.text.replace(result.replacement.before,result.replacement.after):span.text).join('');
 assert(executable(changed).includes('wave_ok:=public.order_merge_delivery209_wave_valid(manual_basis);'));
 assert(executable(changed).includes('RETURN public.ordinary181_history_parents_valid(manual_basis,wave_ok);'));
});

test('complete original headers/ACL survive own namespace cloning; activation remains false',()=>{
 for(let index=0;index<2;index++){
  const before=result.historical_predecessors[index].value,after=result.helpers[index].value;
  for(const key of Object.keys(before).filter(key=>!['source','definition'].includes(key)))assert.deepEqual(after[key],before[key],key);
  assert.equal(after.definition.split(after.source).length,2);
  assert(!after.source.includes('$function$'),'same safe deparser delimiter');
 }
 assert.equal((result.sql.match(/^CREATE OR REPLACE FUNCTION public.order_merge_delivery209_/gm)||[]).length,2);
 assert.equal((result.sql.match(/^REVOKE ALL ON FUNCTION public.order_merge_delivery209_/gm)||[]).length,2);
 assert(!/^GRANT|^UPDATE|^INSERT|^ALTER|^DROP/m.test(result.sql));
 assert.equal(result.unchanged_legacy_change_roster,14);
 assert.equal(result.requires_own_fingerprint_and_all_nonowner_acl_seal,true);
 for(const key of ['source_compilation_performed','native_certification','application_activation'])assert.equal(result[key],false,key);
 assert(Object.isFrozen(result.helpers[0].value.acl));
});

test('source pins refuse header, constraint, and trailing drift without accepting an observed record',()=>{
 for(const input of [source204+'\n',source204.replace('pg_get_constraintdef(c.oid,true)','pg_get_constraintdef(c.oid,false)'),source204.replace('STABLE SECURITY DEFINER','VOLATILE SECURITY DEFINER')]){
  assert.notEqual(input,source204);assert.throws(()=>deriveOrderMergeDelivery209WaveClosure({source204:input}),/literal Source204 input/);
 }
 assert.throws(()=>deriveOrderMergeDelivery209WaveClosure({source204:null}));
});

test('missing/extra executable edges fail, while quoted/commented lookalikes never transform',()=>{
 const oldConstraint='pg_get_constraintdef(c.oid,true)',oldCall='public.ordinary181_history_operative_valid(manual_basis)';
 for(const [transform,token] of [[operative,oldConstraint],[wave,oldCall]]){
  const quoted="'"+token+"' /* "+token+" */ $history$"+token+'$history$';
  assert.equal(transform('SELECT '+token+'; '+quoted).source.endsWith(quoted),true);
  assert.throws(()=>transform('SELECT 1; '+quoted),/exact one/);
  assert.throws(()=>transform('SELECT '+token+','+token),/exact one/);
 }
});
