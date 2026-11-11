import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {orderMergeDelivery209HistorySqlSpans as spans,deriveOrderMergeDelivery209HistoryClosure} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderMergeDelivery209WaveClosure} from '../tools/parity/order-merge-delivery209-wave-closure.mjs';
import {ORDER_MERGE_DELIVERY209_BUYER_SOURCE as PINS,deriveOrderMergeDelivery209BuyerClosure,
 projectOrderMergeDelivery209BuyerSource as buyer,projectOrderMergeDelivery209BuyerPimSource as pim,
 projectOrderMergeDelivery209BuyerParentsSource as parents} from '../tools/parity/order-merge-delivery209-buyer-closure.mjs';
import {deriveOrderMergeDelivery209Bodies} from '../tools/parity/order-merge-delivery209-source.mjs';
import {deriveOrderMergeDelivery209Predecessor} from '../tools/parity/order-merge-delivery209-predecessor.mjs';

const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
const source181=readFileSync(new URL('../server/181_same_root_guard_observations.sql',import.meta.url),'utf8');
const result=deriveOrderMergeDelivery209BuyerClosure({source204,source181});
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
const substitutions=[['pg_get_constraintdef(c.oid,true)','public.order_merge_delivery209_constraint_definition(c.oid)'],
 ['public.ordinary181_buyer_guards(manual_basis)','public.order_merge_delivery209_buyer_guards(manual_basis)'],
 ['public.ordinary181_history_pim_valid(manual_basis,wave_ok)','public.order_merge_delivery209_history_pim_valid(manual_basis,wave_ok)']];
const reverse=(source,index)=>spans(source).map(span=>span.executable?span.text.replaceAll(substitutions[index][1],substitutions[index][0]):span.text).join('');

test('buyer full24 matches independent E204;181 functions are freshly source-derived and204-authenticated',async()=>{
 const {PACKING204_SOURCE_CONTRACT:E}=await import('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs');
 const record=result.historical_predecessors[0],change=E.changes.find(item=>item.key===record.key);
 assert(change);assert.deepEqual(record,{kind:change.kind,key:change.key,value:change.after});
 assert.equal(sha(source181),PINS.source181_sha256);assert.equal(sha(source204),PINS.source204_sha256);
 for(const [index,record] of result.historical_predecessors.entries()){
  assert.equal(Object.keys(record.value).length,24);assert.equal(sha(record.value.source),PINS.predecessors[index].source_sha256);
  if(index){
   const clause=source204.split('\n').find(line=>line.includes("p.oid=to_regprocedure('public."+PINS.predecessors[index].name+"(jsonb,boolean)')")&&line.includes(PINS.predecessors[index].source_sha256));
   assert(clause.includes("pg_get_function_result(p.oid)='boolean'"));
   assert(clause.includes("pg_get_function_identity_arguments(p.oid)='manual_basis jsonb, wave_ok boolean'"));
   assert(clause.includes("p.proargnames IS NOT DISTINCT FROM ARRAY['manual_basis','wave_ok']::text[]"));
   assert(clause.includes("p.proconfig=ARRAY['search_path=pg_catalog, public','TimeZone=UTC']::text[]"));
  }
 }
 assert.equal(result.full_before_descriptors_compiler_verified,false,'no invented compiled proof for181 deparser templates');
});

test('buyer251 changes its one raw buyer constraint arm and preserves all other predicate bytes',()=>{
 const before=result.historical_predecessors[0].value.source,after=result.helpers[0].value.source;
 assert.equal(reverse(after,0),before);
 assert.deepEqual(result.projection_sites[0],{buyer251_constraint_definitions:1});
 const arm=before.split('\n').filter(line=>line.includes(substitutions[0][0]));
 assert.equal(arm.length,1);assert(arm[0].includes("starts_with(t.relname,'buyer_address_')"));
 assert(after.includes('seal.fingerprint IS DISTINCT FROM buyer_fp251'));assert(after.includes('seal.predecessor_certificates IS DISTINCT FROM buyer410_projected'));
 assert(after.includes('basis.root_xid,basis.start_at,basis.backend_pid,basis.owner_name'));
 assert.equal((executable(after).match(/pg_get_constraintdef\(k\.oid,true\)/g)||[]).length,(executable(before).match(/pg_get_constraintdef\(k\.oid,true\)/g)||[]).length);
 assert(after.includes('public.partial_sale204_predecessor_definition(p.oid)'));
});

test('all three real PIM branches dispatch buyer through own helper; other guard branches stay literal',()=>{
 const before=result.historical_predecessors[1].value.source,after=result.helpers[1].value.source;
 assert.equal(reverse(after,1),before);assert.deepEqual(result.projection_sites[1],{buyer_calls:3});
 const lines=before.split('\n').filter(line=>line.includes(substitutions[1][0]));assert.equal(lines.length,3);
 for(const line of lines)assert(line.includes("ELSIF guard_name='buyer_address_guards' THEN guard_ok:="+substitutions[1][0]));
 assert.equal(executable(after).split(substitutions[1][1]).length-1,3);
 assert(!executable(after).includes(substitutions[1][0]));
 for(const name of ['ordinary181_financial_valid','ordinary181_credit_source_valid','ordinary181_invoice_guards','ordinary181_fa3_guards','ordinary181_nested_valid']){
  assert.equal(executable(after).split('public.'+name+'(').length,executable(before).split('public.'+name+'(').length,name);
 }
});

test('parent clone changes only its terminal PIM call, retaining28 exact parent hashes and roster checks',()=>{
 const before=result.historical_predecessors[2].value.source,after=result.helpers[2].value.source;
 assert.equal(reverse(after,2),before);assert.deepEqual(result.projection_sites[2],{pim_calls:1});
 assert(after.includes('RETURN '+substitutions[2][1]+' IS NOT DISTINCT FROM true;'));
 assert(after.includes('public.ordinary177_parent_hash(expected.signature)'));assert(after.includes('IF live_sha IS DISTINCT FROM expected.body_sha256 THEN RETURN false;END IF;'));
 assert.equal((before.match(/\('public\.[^']+', '[0-9a-f]{64}'\)/g)||[]).length,28);
 assert(!after.includes('order_merge_delivery209_wave_valid('),'wave result is propagated, not re-evaluated or replaced');
});

test('Source19 executable187 tail gets one exact new edge; old map/wave fixes and quoted history are preserved',async()=>{
 let source19=source18Ordinary187();
 for(const edge of [deriveOrderMergeDelivery209HistoryClosure({source204}).replacement,deriveOrderMergeDelivery209WaveClosure({source204}).replacement]){
  assert.equal(executable(source19).split(edge.before).length-1,1);
  source19=spans(source19).map(span=>span.executable?span.text.replace(edge.before,edge.after):span.text).join('');
 }
 const edge=result.replacement;assert.equal(executable(source19).split(edge.before).length-1,1);
 const source20=spans(source19).map(span=>span.executable?span.text.replace(edge.before,edge.after):span.text).join('');
 assert(source20.includes('RETURN '+edge.after+';'));assert(executable(source20).includes('wave_ok:=public.order_merge_delivery209_wave_valid(manual_basis);'));
 assert(executable(source20).includes('public.order_merge_delivery209_history_predecessor_project('));
 assert.deepEqual(spans(source20).filter(span=>!span.executable),spans(source19).filter(span=>!span.executable));
 assert.equal(spans(source20).map(span=>span.executable?span.text.replace(edge.after,edge.before):span.text).join(''),source19);
});

test('own clone headers/ACLs and every quoted historical definition are unchanged; installation stays private/unaccepted',()=>{
 for(let index=0;index<3;index++){
  const before=result.historical_predecessors[index].value,after=result.helpers[index].value;
  for(const key of Object.keys(before).filter(key=>!['source','definition'].includes(key)))assert.deepEqual(after[key],before[key],key);
  assert.equal(reverse(after.source,index),before.source);assert.deepEqual(spans(after.source).filter(span=>!span.executable),spans(before.source).filter(span=>!span.executable));
  assert(after.definition.includes(after.source));assert.equal(Object.keys(after).length,24);assert(Object.isFrozen(after.acl));
 }
 assert.equal((result.sql.match(/^CREATE OR REPLACE FUNCTION public.order_merge_delivery209_/gm)||[]).length,3);
 assert.equal((result.sql.match(/^REVOKE ALL ON FUNCTION public.order_merge_delivery209_/gm)||[]).length,3);
 assert(!/^GRANT|^UPDATE|^INSERT|^ALTER|^DROP/m.test(result.sql));assert.equal(result.unchanged_legacy_change_roster,14);
 assert.equal(result.requires_own_fingerprint_and_all_nonowner_acl_seal,true);
 for(const key of ['source_compilation_performed','native_certification','application_activation'])assert.equal(result[key],false);
});

test('both literal source inputs refuse header/body/ACL/trailing drift; no observed-record override exists',()=>{
 for(const [key,source] of [['source204',source204],['source181',source181]]){
  for(const modified of [source+'\n',source.replace('STABLE SECURITY DEFINER','VOLATILE SECURITY DEFINER'),source.replace('FROM PUBLIC,dyna_app','FROM PUBLIC')]){
   assert.notEqual(modified,source);assert.throws(()=>deriveOrderMergeDelivery209BuyerClosure({source204,source181,[key]:modified}),new RegExp('literal '+key+' input'));
  }
  assert.throws(()=>deriveOrderMergeDelivery209BuyerClosure({source204,source181,[key]:null}));
 }
});

test('literal-aware transforms reject missing/extra edges and preserve quoted/commented lookalikes',()=>{
 for(const [index,transform] of [buyer,pim,parents].entries()){
  const [before,after]=substitutions[index],count=index===1?3:1;
  const lookalikes="'"+before+"' /* "+before+" */ $history$"+before+'$history$';
  const output=transform(Array(count).fill(before).join(';')+';'+lookalikes).source;
  assert(output.endsWith(lookalikes));assert.equal(executable(output).split(after).length-1,count);assert(!output.includes('public.public.'));
  assert.throws(()=>transform(Array(count-1).fill(before).join(';')+';'+lookalikes),/exact executable/);
  assert.throws(()=>transform(Array(count+1).fill(before).join(';')),/exact executable/);
 }
});
