/** Source20 composition only. No SQL execution, Native, runtime, or business PASS. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {deriveOrderMergeDelivery209Bodies,assembleOrderMergeDelivery209,
 deriveOrderMergeDelivery209FingerprintRows,deriveOrderMergeDelivery209FingerprintRecords,
 deriveOrderMergeDelivery209Records,deriveOrderMergeDelivery209Manifest,deriveOrderMergeDelivery209Seal} from '../tools/parity/order-merge-delivery209-source.mjs';
import {deriveOrderMergeDelivery209Predecessor,orderMergeDelivery209SqlSpans as spans,
 projectOrderMergeDelivery209FunctionCheck,projectOrderMergeDelivery209Descriptor} from '../tools/parity/order-merge-delivery209-predecessor.mjs';
import {deriveOrderMergeDelivery209HistoryClosure} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderMergeDelivery209WaveClosure} from '../tools/parity/order-merge-delivery209-wave-closure.mjs';
import {deriveOrderMergeDelivery209BuyerClosure} from '../tools/parity/order-merge-delivery209-buyer-closure.mjs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const source166=read('server/166_buyer_address_sidecar.sql'),source204=read('server/204_partial_commercial_sale_scope.sql'),
 source181=read('server/181_same_root_guard_observations.sql'),core=read('tools/parity/order-merge-delivery209-business.sql');
const buyer=deriveOrderMergeDelivery209Bodies({source166});
const base={changes:buyer,source166};
const routine=(sql,tag)=>{assert.equal(sql.split(tag).length,3,'one complete function body '+tag);return sql.split(tag)[1];};
const localTags=['$local_descriptor209$','$local_definition209$','$local_source209$','$checked209$'];
// Do not retain three21MiB payload strings and their SQL-escaped copies at once.
// Complete historical programs are hashed before dropping their DATA/SQL;
// comparisons below retain only function descriptors and the small local ports.
function historicalSummary(options){
 const candidate=deriveOrderMergeDelivery209Predecessor(options);
 const assembled=assembleOrderMergeDelivery209({source166,core,predecessor:candidate});
 return {changes:candidate.changes,projection_counts:candidate.projection_counts,runtime_revision:candidate.runtime_revision,
  runtime_closure_helpers:candidate.runtime_closure_helpers,sql_bytes:Buffer.byteLength(assembled.sql),sql_sha256:assembled.sql_sha256,
  projection_basis:candidate.projection_basis,source_compilation_performed:candidate.source_compilation_performed,
  application_activation:candidate.application_activation,native_certification:candidate.native_certification,
  ports:Object.fromEntries(localTags.map(tag=>[tag,routine(candidate.sql,tag)]))};
}
const source18=historicalSummary(base);
const source19=historicalSummary({...base,source204});
const source20=deriveOrderMergeDelivery209Predecessor({...base,source204,source181,runtimeRevision:20});
const history=deriveOrderMergeDelivery209HistoryClosure({source204}),wave=deriveOrderMergeDelivery209WaveClosure({source204}),
 buyerClosure=deriveOrderMergeDelivery209BuyerClosure({source204,source181});
const sha=value=>createHash('sha256').update(value).digest('hex');
const executable=source=>spans(source).filter(span=>span.executable).map(span=>span.text).join('');
const literals=source=>spans(source).filter(span=>!span.executable).map(span=>span.text);
const change=(candidate,key)=>candidate.changes.find(item=>item.key==='public.'+key);

test('Source18 and Source19 full default SQL remain exact independently pinned historical programs',()=>{
 for(const [candidate,bytes,digest] of [[source18,27029809,'9e25cb8442f85380eac367c26ba0d0c9fd0f7f6ac1588ed281cab153d9d8b50d'],
  [source19,27462515,'97208701dc50ceef2e47140c1cbfde68fb4eeb41ab3bd59ed4f9206d07814a30']]){
  assert.equal(candidate.sql_bytes,bytes);assert.equal(candidate.sql_sha256,digest);
 }
 assert.equal(source18.runtime_revision,18);assert.equal(source19.runtime_revision,19);assert.equal(source20.runtime_revision,20);
});

test('Source20 changes exactly two of ten legacy AFTER records, preserving all BEFORE/header/ACL fields',()=>{
 const before=[...buyer,...source19.changes],after=[...buyer,...source20.changes],changed=[];
 assert.equal(after.length,10);assert.deepEqual(after.map(row=>row.key),before.map(row=>row.key));
 for(let index=0;index<10;index++){
  assert.deepEqual(after[index].before,before[index].before);
  if(sha(after[index].after.source)!==sha(before[index].after.source)){
   changed.push(after[index].key);
   for(const field of Object.keys(before[index].after).filter(field=>!['source','definition'].includes(field)))assert.deepEqual(after[index].after[field],before[index].after[field],field);
  }else assert.deepEqual(after[index],before[index]);
 }
 assert.deepEqual(changed.sort(),['public.ordinary187_valid()','public.partial_sale204_predecessor_definition(fn oid)']);
 assert.deepEqual(source20.projection_counts,source19.projection_counts);
 assert(!after.some(row=>/public\.ordinary(?:177|181)_/.test(row.key)),'no historical181/177 function mutation');
});

test('all three executable187 call edits reverse to complete Source18; only third edit reverses to Source19',()=>{
 const current=change(source20,'ordinary187_valid()'),old=change(source18,'ordinary187_valid()'),prior=change(source19,'ordinary187_valid()');
 let restored=current.after.source;
 for(const edge of [buyerClosure.replacement,wave.replacement,history.replacement]){
  assert.equal(executable(restored).split(edge.after).length-1,1);
  restored=spans(restored).map(span=>span.executable?span.text.replace(edge.after,edge.before):span.text).join('');
  if(edge===buyerClosure.replacement)assert.equal(restored,prior.after.source);
 }
 assert.equal(restored,old.after.source);assert.equal(current.after.definition.replace(current.after.source,()=>restored),old.after.definition);
 assert.deepEqual(literals(current.after.source),literals(old.after.source));
 assert(executable(current.after.source).includes('RETURN public.order_merge_delivery209_history_parents_valid(manual_basis,wave_ok);'));
});

test('typed-OID fast entry has the exact closed ten signatures and only changes frame acquisition',()=>{
 const current=change(source20,'partial_sale204_predecessor_definition(fn oid)'),prior=change(source19,'partial_sale204_predecessor_definition(fn oid)');
 const text=executable(current.after.source),prefix='IF fn=ANY(ARRAY[',suffix=']::oid[]) THEN merge_delivery209_local_frame:=public.order_merge_delivery209_checked_projection_map(fn); ELSE merge_delivery209_local_frame:=NULL;END IF;';
 // Read the exact injected statement, including SQL literals: executable spans
 // alone omit the ten quoted typed identities by design.
 const start=current.after.source.indexOf(prefix),end=current.after.source.indexOf(suffix,start)+suffix.length;
 assert(start>0&&end>start);const gate=current.after.source.slice(start,end);
 const signatures=[...gate.matchAll(/'([^']+)'::regprocedure/g)].map(match=>match[1]);
 const expected=['public.buyer_address_preview_guard()','public.buyer_address_state_guard()','public.buyer_address_guards()','public.buyer_address_fingerprint()',
  'public.manual_inventory_off_valid()','public.manual_inventory_off_projection_valid()','public.partial_sale204_predecessor_definition(oid)',
  'public.ordinary187_valid()','public.partial_sale204_valid()','public.catalog_header205_valid()'];
 assert.deepEqual(signatures,expected);assert.equal(new Set(signatures).size,10);
 const ordinary='merge_delivery209_local_frame:=public.order_merge_delivery209_checked_projection_map(fn);';
 assert.equal(current.after.source.replace(gate,()=>ordinary),prior.after.source);
 assert.equal(current.after.definition.replace(current.after.source,()=>prior.after.source),prior.after.definition);
 // Original header+quoted proof literals are preserved except the ten new
 // typed constants; restored full source above proves all old quoted bytes.
 assert(text.includes('ELSE merge_delivery209_local_frame:=NULL;END IF;'));
 assert.equal(current.after.source.split('IF fn=ANY(ARRAY[').length-1,1);
 for(const row of source20.changes.filter(row=>row.key!==current.key))assert(!row.after.source.includes('IF fn=ANY(ARRAY['));
});

test('fast entry does not weaken unexpected-overload/null-frame/full-current validation or unchanged identity',()=>{
 // These bodies are exactly the previous reviewed local projection ports.
 for(const tag of localTags){
  const actual=routine(source20.sql,tag),before=source19.ports[tag];
  // Authored DATA changed with187+partial AFTERs; only its exact byte/SHA
  // constants may differ in the selected-row provenance checks. No predicate,
  // metadata field, NULL/overload handling or canonical query is normalized.
  let normalized=actual;
  for(const field of ['bytes','sha256']){
   const old=String(source19.projection_basis[field]),next=String(source20.projection_basis[field]);
   const count=before.split(old).length-1;assert(count===0||count===1,'bounded basis constant occurrence');
   assert.equal(actual.split(next).length-1,count,'same exact source basis binding sites');
   if(count)normalized=normalized.replace(next,()=>old);
  }
  assert.equal(sha(normalized),sha(before),'identical local port except source-derived basis constants '+tag);
 }
 const descriptor=routine(source20.sql,'$local_descriptor209$'),source=routine(source20.sql,'$local_source209$'),checked=routine(source20.sql,'$checked209$');
 assert(descriptor.includes("IF jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>10 THEN RAISE EXCEPTION '209 invocation frame required' USING ERRCODE='55000'"));
 assert(descriptor.includes("IF total<>1 OR entry IS NULL OR entry->>'key' IS DISTINCT FROM actual_key OR live IS DISTINCT FROM entry->'after_check'"));
 assert(descriptor.indexOf('209 invocation frame required')<descriptor.indexOf('RETURN selected_before'));
 assert(source.includes('RETURN public.order_merge_delivery209_predecessor_descriptor(fn,entries)'));assert(source.includes('IF scoped IS DISTINCT FROM true THEN'));
 assert(checked.includes("IF total IS DISTINCT FROM 1 THEN RAISE EXCEPTION '209 complete predecessor scope required'"));
 assert(checked.includes('IF public.order_merge_delivery209_valid()')||checked.includes("OR public.order_merge_delivery209_valid()"));
 assert(checked.includes('IF validated<>10 THEN RAISE EXCEPTION'));
 // Independent current-record oracle covers drift/overload failures for every
 // one of the ten source-authored bindings (not a Native execution claim).
 const all=[...buyer,...source20.changes],rows=all.map(row=>({kind:row.kind,key:row.key,value:row.after}));
 for(const row of all){
  assert.deepEqual(projectOrderMergeDelivery209Descriptor(rows,all,row.key),row.before);
  const overload={kind:'function',key:row.key.slice(0,row.key.indexOf('('))+'(unexpected integer)',value:row.after};
  assert.throws(()=>projectOrderMergeDelivery209Descriptor([...rows,overload],all,row.key),/overloaded/);
 }
 const foreign={kind:'function',key:'public.unchanged_probe()',value:{source:'actual changed bytes',acl:null}};
 assert.deepEqual(projectOrderMergeDelivery209Descriptor([...rows,foreign],all,foreign.key),foreign.value,'identity preserves current drift');
});

test('six own helpers have exact source-derived full24 metadata, private ACL and installer ordering',()=>{
 const expected=[history.helper,...wave.helpers,...buyerClosure.helpers];assert.equal(expected.length,6);
 assert.deepEqual(source20.runtime_closure_helpers,expected);
 const first=source20.sql.indexOf(source20.changes[0].after.definition.trimEnd()+';');assert(first>0);
 for(const helper of expected){
  assert.equal(Object.keys(helper.value).length,24);assert.equal(helper.value.owner,'postgres');assert(helper.value.security_definer);
  assert.deepEqual(helper.value.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
  const position=source20.sql.indexOf(helper.value.definition.trimEnd()+';');assert(position>=0&&position<first);
  assert.equal(source20.sql.split(helper.value.definition.trimEnd()+';').length-1,1);
  const name=helper.key.slice(0,helper.key.indexOf('(')),types=helper.value.arguments.split(', ').map(argument=>argument.slice(argument.indexOf(' ')+1)).join(',');
  assert(source20.sql.includes('REVOKE ALL ON FUNCTION '+name+'('+types+') FROM PUBLIC,dyna_app;'));assert(source20.helper_keys.includes(name));
 }
 const seal=deriveOrderMergeDelivery209Seal();assert(seal.includes("starts_with(p.proname,'order_merge_delivery209_')"));assert(seal.includes('WHERE grantee<>o.owner'));
 for(const helper of expected)assert(!seal.includes('GRANT EXECUTE ON FUNCTION '+helper.key.slice(0,helper.key.indexOf('('))+'('));
});

test('Source20 DATA binds both changed AFTER/check records to exact original BEFORE, without adopting observed values',()=>{
 const marker="INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'",start=source20.preambleSql.indexOf(marker);
 assert(start>=0&&source20.preambleSql.endsWith("');\n"));
 const raw=source20.preambleSql.slice(start+marker.length,-4).replaceAll("''","'");
 assert.equal(Buffer.byteLength(raw),source20.projection_basis.bytes);assert.equal(sha(raw),source20.projection_basis.sha256);
 const entries=JSON.parse(raw),all=[...buyer,...source20.changes];assert.equal(entries.length,10);
 for(let index=0;index<10;index++){
  assert.equal(entries[index].key,all[index].key);assert.deepEqual(entries[index].before,all[index].before);assert.deepEqual(entries[index].after,all[index].after);
  assert.deepEqual(entries[index].after_check,projectOrderMergeDelivery209FunctionCheck(all[index].after));
 }
});

test('Source20 default and experimental direct-own assembly retain complete fingerprint scope and false acceptance flags',t=>{
 const baseline=(()=>{const result=assembleOrderMergeDelivery209({source166,core,predecessor:source20});return{bytes:Buffer.byteLength(result.sql),sha256:result.sql_sha256};})();
 t.diagnostic('Source20 default candidate '+JSON.stringify(baseline));
 const current=assembleOrderMergeDelivery209({source166,core,predecessor:source20,directOwnRows:true});
 assert(current.sql.includes(deriveOrderMergeDelivery209Manifest(current.changes,{directOwnRows:true})));
 assert(current.sql.includes('FROM('+deriveOrderMergeDelivery209FingerprintRows()+') own209)'));
 const old=deriveOrderMergeDelivery209FingerprintRecords(),terminal="SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries";
 assert.equal(deriveOrderMergeDelivery209FingerprintRows(),old.slice(0,-terminal.length)+'SELECT kind,key,value FROM entries');
 const arms=deriveOrderMergeDelivery209Records().split('\n').filter(line=>/^(?: UNION ALL )?SELECT '(?:relation|column|constraint|index|policy|trigger|function|type)',/.test(line));
 assert.equal(arms.length,8);for(const arm of arms)assert(arm.includes('jsonb_build_object('),'every complete top-level descriptor is a non-NULL JSON object');
 for(const result of [source18,source19,source20,current])for(const flag of ['source_compilation_performed','application_activation','native_certification'])assert.equal(result[flag],false);
 assert.equal(current.changes.length,10);
 for(const relation of ['buyer_address_manifest','wave_print177_certificate','large_import173_certificate'])assert(!current.sql.includes('UPDATE public.'+relation));
 assert(!current.sql.includes('CREATE FUNCTION public.order_merge_delivery209_predecessor_source_sha('),'held hash prototype not integrated');
});

test('revision and source provenance refuse unknown/missing/altered inputs rather than falling back',()=>{
 for(const runtimeRevision of [null,0,17,23,'20',NaN])assert.throws(()=>deriveOrderMergeDelivery209Predecessor({...base,source204,source181,runtimeRevision}),/supported source revision/);
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({...base,source204,source181}),/requires explicit Source20/);
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({...base,source204,runtimeRevision:20}),/needs literal Source181/);
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({...base,source204,runtimeRevision:18}),/Source18 has no indirect/);
 for(const source181 of [null,read('server/181_same_root_guard_observations.sql')+'\n'])assert.throws(()=>deriveOrderMergeDelivery209Predecessor({...base,source204,source181,runtimeRevision:20}));
});
