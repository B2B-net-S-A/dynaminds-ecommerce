import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
 ORDER_MERGE_DELIVERY209_HISTORY_SOURCE as PINS,
 deriveOrderMergeDelivery209HistoryClosure,
 orderMergeDelivery209HistorySqlSpans as spans,
 projectOrderMergeDelivery209HistorySource as project,
} from '../tools/parity/order-merge-delivery209-history-closure.mjs';

const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
const result=deriveOrderMergeDelivery209HistoryClosure({source204});
const sha=value=>createHash('sha256').update(value).digest('hex');
const reverse=source=>spans(source).map(span=>!span.executable?span.text:span.text
 .replaceAll('public.order_merge_delivery209_predecessor_source(p.oid, entries)','p.prosrc')
 .replaceAll('public.order_merge_delivery209_predecessor_definition(p.oid, entries)','pg_catalog.pg_get_functiondef(p.oid)')).join('');

test('actual Source204 full predecessor is independently pinned by compiled source contract',async()=>{
 const {PACKING204_SOURCE_CONTRACT:E204}=await import('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs');
 const compiled=E204.changes.filter(change=>change.key===PINS.predecessor_key);
 assert.equal(compiled.length,1);
 assert.deepEqual(result.historical_predecessor,{kind:compiled[0].kind,key:compiled[0].key,value:compiled[0].after});
 assert.equal(sha(source204),PINS.source204_sha256);
 assert.equal(sha(result.historical_predecessor.value.source),PINS.predecessor_source_sha256);
 assert.equal(Object.keys(result.historical_predecessor.value).length,24);
});

test('only six executable leaf reads change; every historical literal and all other bytes survive',()=>{
 const before=result.historical_predecessor.value.source,after=result.helper.value.source;
 assert.equal(reverse(after),before);
 assert.deepEqual(spans(after).filter(span=>!span.executable),spans(before).filter(span=>!span.executable));
 assert.deepEqual(result.projection_sites,{source_reads:3,definition_reads:3});
 assert(after.includes("IF r#>>'{buyer_address_guards,definition}' IS DISTINCT FROM live349->>'definition' THEN RAISE EXCEPTION"));
 assert(after.includes("IF r#>>'{manual_inventory_off_valid,definition}' IS DISTINCT FROM live349->>'definition' THEN RAISE EXCEPTION"));
 assert(after.includes("computed349:=public.partial_sale204_predecessor_definition('public.buyer_address_guards()'::regprocedure)"));
 assert(after.includes("computed349:=public.partial_sale204_predecessor_definition('public.manual_inventory_off_valid()'::regprocedure)"));
 assert(after.includes("IF r IS DISTINCT FROM expected349 THEN RAISE EXCEPTION '177 predecessor profile changed'"));
});

test('own clone preserves complete header/ACL and changes no historical routine',()=>{
 const before=result.historical_predecessor.value,after=result.helper.value;
 for(const key of Object.keys(before).filter(key=>!['arguments','argument_names','source','definition'].includes(key)))assert.deepEqual(after[key],before[key],key);
 assert.equal(after.arguments,'v jsonb, entries jsonb');
 assert.deepEqual(after.argument_names,['v','entries']);
 assert.equal(after.definition.split(after.source).length,2);
 assert.equal(after.definition.split(after.source)[1],'$functionx$\n');
 assert(!after.source.includes('$functionx$'),'authored safe dollar delimiter');
 assert.equal((result.sql.match(/^CREATE OR REPLACE FUNCTION /gm)||[]).length,1);
 assert(result.sql.startsWith('CREATE OR REPLACE FUNCTION public.order_merge_delivery209_history_predecessor_project('));
 assert(result.sql.endsWith('REVOKE ALL ON FUNCTION public.order_merge_delivery209_history_predecessor_project(jsonb,jsonb) FROM PUBLIC,dyna_app;\n'));
 assert(!/^GRANT|^UPDATE|^ALTER|^DROP|^INSERT/m.test(result.sql));
 assert.equal(result.unchanged_legacy_change_roster,14);
 assert.equal(result.requires_own_fingerprint_and_all_nonowner_acl_seal,true);
 for(const key of ['source_compilation_performed','native_certification','application_activation'])assert.equal(result[key],false,key);
 assert(Object.isFrozen(result.helper.value.acl));
});

test('replacement is one fixed projected-map187 call; original map projection remains required',()=>{
 assert.deepEqual(result.replacement,{
  key:'public.ordinary187_valid()',
  before:'public.ordinary177_predecessor_project(public.order_merge_delivery209_predecessor_metadata(public.large_import173_predecessor_map(), merge_delivery209_local_frame))',
  after:'public.order_merge_delivery209_history_predecessor_project(public.order_merge_delivery209_predecessor_metadata(public.large_import173_predecessor_map(), merge_delivery209_local_frame), merge_delivery209_local_frame)',
  expected_executable_occurrences:1,
 });
});

test('actual Source18 failing definitions match authenticated predecessor leaves, not raw live definitions',async()=>{
 // Independent representation oracle: the historical comparison expects a
 // BEFORE209 full definition. Raw AFTER209 is necessarily different. The new
 // private leaf port supplies the authenticated BEFORE, never a caller value.
 const {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT:E209}=await import('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs');
 for(const key of ['public.buyer_address_guards()','public.manual_inventory_off_valid()']){
  const change=E209.changes.find(change=>change.key===key);assert(change);
  const input=JSON.parse(JSON.stringify({definition:change.after.definition}).replace(JSON.stringify(change.after.definition),JSON.stringify(change.before.definition)));
  const compare=definition=>assert.equal(input.definition,definition,'204 exact current predecessor input required');
  assert.throws(()=>compare(change.after.definition));
  compare(change.before.definition);
  assert.throws(()=>compare(change.before.definition+'\n'));
 }
 const current187=E209.changes.find(change=>change.key==='public.ordinary187_valid()');
 assert(current187);
 // The promoted contract is21: its187 already uses this own history clone.
 // Keep the exact fixed edge assertion rather than refreshing a body pin.
 const executable187=spans(current187.after.source).filter(span=>span.executable).map(span=>span.text).join('');
 assert.equal(executable187.split(result.replacement.after).length-1,1);
 assert.equal(executable187.split(result.replacement.before).length-1,0);
 assert.equal(result.helper.value.source.split('public.order_merge_delivery209_predecessor_definition(p.oid, entries)').length-1,3);
});

test('pin refuses source/header/trailing drift without adopting observed caller records',()=>{
 for(const mutated of [source204+'\n',source204.replace('STABLE SECURITY DEFINER','VOLATILE SECURITY DEFINER'),source204.replace('177 predecessor profile changed','changed message')]){
  assert.notEqual(mutated,source204);assert.throws(()=>deriveOrderMergeDelivery209HistoryClosure({source204:mutated}),/literal Source204 input/);
 }
 assert.throws(()=>deriveOrderMergeDelivery209HistoryClosure({source204:null}));
});

test('transform rejects missing, extra, and unrecognized live reads',()=>{
 const original=result.historical_predecessor.value.source;
 let replaced=false;
 const missing=spans(original).map(span=>{if(!span.executable||replaced||!span.text.includes('p.prosrc'))return span.text;replaced=true;return span.text.replace('p.prosrc','p.other_source');}).join('');
 assert(replaced);assert.throws(()=>project(missing),/three complete/);
 assert.throws(()=>project(original+'\n SELECT p.prosrc;'),/three complete/);
 assert.throws(()=>project(original+'\n SELECT pg_get_functiondef(q.oid);'),/unprojected/);
});

test('lexical boundaries exclude nested comments, escaped text and dollar-quoted historical SQL',()=>{
 const text="SELECT p.prosrc, pg_catalog.pg_get_functiondef(p.oid);\n";
 const literal="'p.prosrc' E'quote\\\'p.prosrc' $$pg_catalog.pg_get_functiondef(p.oid)$$ /* a /* p.prosrc */ z */ -- p.prosrc\n";
 const source=text.repeat(3)+literal;
 const transformed=project(source);
 assert.equal(reverse(transformed.source),source);
 assert(transformed.source.endsWith(literal));
 for(const broken of ["'missing","/* missing",'$unclosed$missing'])assert.throws(()=>spans(broken),/closed SQL/);
});

test('explicit revisions18–21 retain the complete historical helper SQL bytes',()=>{
 for(const runtimeRevision of [18,19,20,21]){
  const historical=deriveOrderMergeDelivery209HistoryClosure({source204,runtimeRevision});
  assert.deepEqual(historical,result);
  assert.equal(sha(historical.sql),'db3a41f296fb5ea2810457822c86f5da8d8fdb1e02655a51f85f50f294627315');
  assert.equal(sha(historical.helper.value.source),'2339411067f387132be02712ea69873e7eedc9fe5f2e13a4ac551dd045812318');
 }
 for(const runtimeRevision of [null,undefined,0,23,'22']){
  if(runtimeRevision===undefined)continue; // Missing option is the historical default.
  assert.throws(()=>deriveOrderMergeDelivery209HistoryClosure({source204,runtimeRevision}),/supported history source revision/);
 }
});

test('Source22 projects one live six-root metadata producer and preserves the entire204 inverse',()=>{
 const current=deriveOrderMergeDelivery209HistoryClosure({source204,runtimeRevision:22});
 const raw='public.pim_dictionary_function_metadata(to_regprocedure(entry204.sig))';
 const wrapped='public.order_merge_delivery209_predecessor_metadata('+raw+', entries)';
 const unproject=source=>spans(source).map(span=>span.executable?span.text.replaceAll(wrapped,raw):span.text).join('');
 assert.equal(current.helper.value.source.split(wrapped).length-1,1);
 assert.equal(unproject(current.helper.value.source),result.helper.value.source);
 assert.equal(reverse(unproject(current.helper.value.source)),current.historical_predecessor.value.source);
 assert.deepEqual(spans(current.helper.value.source).filter(span=>!span.executable),spans(result.helper.value.source).filter(span=>!span.executable));
 assert.deepEqual(current.projection_sites,{source_reads:3,definition_reads:3,metadata_reads:1});
 // Reproduce the actual failing boundary's shape: the exact comparison and
 // exception remain, with ONLY its live producer moved to the input's side.
 assert(current.helper.value.source.includes("IF r->(entry204.name) IS DISTINCT FROM "+wrapped+" THEN RAISE EXCEPTION '204 exact current predecessor input required' USING ERRCODE='55000';END IF;"));
 assert(current.helper.value.source.includes("r:=jsonb_set(r,ARRAY[entry204.name,'definition'],to_jsonb(public.partial_sale204_predecessor_definition(to_regprocedure(entry204.sig))),false)"));
 for(const key of Object.keys(result.helper.value).filter(k=>!['source','definition'].includes(k)))assert.deepEqual(current.helper.value[key],result.helper.value[key],key);
 assert.equal(current.helper.value.definition.replace(current.helper.value.source,()=>result.helper.value.source),result.helper.value.definition);
 assert.equal(current.sql.replace(current.helper.value.definition.trimEnd(),()=>result.helper.value.definition.trimEnd()),result.sql);
 assert.deepEqual(current.replacement,result.replacement);
 assert.deepEqual(current.historical_predecessor,result.historical_predecessor);
});

test('Source22 refuses missing or extra executable metadata sites and ignores quoted lookalikes',()=>{
 const original=result.historical_predecessor.value.source;
 const raw='public.pim_dictionary_function_metadata(to_regprocedure(entry204.sig))';
 const extra="\nSELECT "+raw+";";
 assert.throws(()=>project(original+extra,{runtimeRevision:22}),/exact one executable six-root/);
 const missing=spans(original).map(span=>span.executable?span.text.replaceAll(raw,'public.other_metadata(to_regprocedure(entry204.sig))'):span.text).join('');
 assert.throws(()=>project(missing,{runtimeRevision:22}),/exact one executable six-root/);
 const quoted="\n-- "+raw+"\nSELECT '"+raw+"', $lookalike$"+raw+"$lookalike$;";
 const projected=project(original+quoted,{runtimeRevision:22});
 assert.equal(projected.sites.metadata_reads,1);
 assert(projected.source.endsWith(quoted));
});
