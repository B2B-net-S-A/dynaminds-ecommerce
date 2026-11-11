/** Source19 composition evidence only: no PostgreSQL, runtime or business PASS. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
 deriveOrderMergeDelivery209Bodies,assembleOrderMergeDelivery209,
 deriveOrderMergeDelivery209FingerprintRecords,deriveOrderMergeDelivery209Seal,
} from '../tools/parity/order-merge-delivery209-source.mjs';
import {
 deriveOrderMergeDelivery209Predecessor,orderMergeDelivery209SqlSpans as spans,
 projectOrderMergeDelivery209FunctionCheck,
} from '../tools/parity/order-merge-delivery209-predecessor.mjs';
import {deriveOrderMergeDelivery209HistoryClosure} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderMergeDelivery209WaveClosure} from '../tools/parity/order-merge-delivery209-wave-closure.mjs';
import {RECORDS_SQL} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';

const read=name=>readFileSync(new URL('../server/'+name,import.meta.url),'utf8');
const source166=read('166_buyer_address_sidecar.sql'),source204=read('204_partial_commercial_sale_scope.sql');
const core=readFileSync(new URL('../tools/parity/order-merge-delivery209-business.sql',import.meta.url),'utf8');
const buyer=deriveOrderMergeDelivery209Bodies({source166});
const historical=deriveOrderMergeDelivery209Predecessor({changes:buyer,source166});
const current=deriveOrderMergeDelivery209Predecessor({changes:buyer,source166,source204});
const history=deriveOrderMergeDelivery209HistoryClosure({source204}),wave=deriveOrderMergeDelivery209WaveClosure({source204});
const edits=[history.replacement,wave.replacement];
const sha=value=>createHash('sha256').update(value).digest('hex');
const executable=source=>spans(source).filter(span=>span.executable).map(span=>span.text).join('');
const literal=source=>spans(source).filter(span=>!span.executable).map(span=>span.text);
const ordinary=candidate=>candidate.changes.find(change=>change.key==='public.ordinary187_valid()');

test('default mode still emits the exact independently accepted Source18 program',()=>{
 const assembled=assembleOrderMergeDelivery209({source166,core,predecessor:historical});
 assert.equal(Buffer.byteLength(assembled.sql),27029809);
 assert.equal(assembled.sql_sha256,'9e25cb8442f85380eac367c26ba0d0c9fd0f7f6ac1588ed281cab153d9d8b50d');
 assert.deepEqual(historical.projection_basis,{bytes:21150718,sha256:'78364713a307b888c634f74c6f0c37e63c77b8aab62cca922099555bbd4c6287'});
 assert.deepEqual(historical.runtime_closure_helpers,[]);
 assert.equal(historical.helper_keys.length,6);
 for(const helper of current.runtime_closure_helpers)assert(!historical.sql.includes('CREATE OR REPLACE FUNCTION '+helper.key));
});

test('Source19 changes only187 among the ten legacy routines and preserves every original BEFORE',()=>{
 const before=[...buyer,...historical.changes],after=[...buyer,...current.changes];
 assert.equal(before.length,10);assert.deepEqual(after.map(change=>change.key),before.map(change=>change.key));
 assert.equal(new Set(after.map(change=>change.key)).size,10);
 const changed=[];
 for(let index=0;index<before.length;index++){
  assert.deepEqual(after[index].before,before[index].before);
  if(sha(after[index].after.source)!==sha(before[index].after.source))changed.push(after[index].key);
  else assert.deepEqual(after[index],before[index]);
 }
 assert.deepEqual(changed,['public.ordinary187_valid()']);
 assert.deepEqual(current.projection_counts,historical.projection_counts);
 assert(!current.changes.some(change=>change.key.includes('ordinary177_')||change.key.includes('ordinary181_')));
});

test('reverse only two executable calls reproduces the full Source18 body and definition',()=>{
 const old=ordinary(historical),next=ordinary(current);let restored=next.after.source;
 for(const edit of edits){
  assert.equal(executable(restored).split(edit.after).length-1,1);
  restored=spans(restored).map(span=>span.executable?span.text.replace(edit.after,edit.before):span.text).join('');
 }
 assert.equal(restored,old.after.source);
 assert.equal(next.after.definition.replace(next.after.source,()=>restored),old.after.definition);
 assert.deepEqual(literal(next.after.source),literal(old.after.source));
 const {source,definition,...header}=next.after,{source:oldSource,definition:oldDefinition,...oldHeader}=old.after;
 assert.deepEqual(header,oldHeader);
 assert(executable(next.after.source).includes('merge_delivery209_local_frame:=public.order_merge_delivery209_checked_projection_map();'));
 assert(executable(next.after.source).includes('RETURN public.ordinary181_history_parents_valid(manual_basis,wave_ok);'));
});

test('DATA contains the exact rewritten187 AFTER/check and unchanged literal predecessor records',()=>{
 const marker="INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'";
 const start=current.preambleSql.indexOf(marker);assert(start>=0);
 const encoded=current.preambleSql.slice(start+marker.length,-4); // exact closing quote, parenthesis, semicolon, LF
 assert(current.preambleSql.endsWith("');\n"));
 const raw=encoded.replaceAll("''","'");
 assert.equal(Buffer.byteLength(raw),current.projection_basis.bytes);assert.equal(sha(raw),current.projection_basis.sha256);
 const entries=JSON.parse(raw),expected=[...buyer,...current.changes];
 assert.equal(entries.length,10);
 for(let index=0;index<entries.length;index++){
  assert.equal(entries[index].key,expected[index].key);
  assert.deepEqual(entries[index].before,expected[index].before);
  assert.deepEqual(entries[index].after,expected[index].after);
  assert.deepEqual(entries[index].after_check,projectOrderMergeDelivery209FunctionCheck(expected[index].after));
 }
 const row=entries.find(entry=>entry.key==='public.ordinary187_valid()');
 for(const field of ['source','definition'])assert.deepEqual(row.after_check[field],['sha256-utf8-text/v1',sha(row.after[field])]);
 assert.notDeepEqual(row.after_check,projectOrderMergeDelivery209FunctionCheck(ordinary(historical).after));
 assert.deepEqual(row.before,ordinary(historical).before);
});

test('three exact private own helper descriptors and definitions precede every legacy successor',()=>{
 const expected=[history.helper,...wave.helpers];
 assert.deepEqual(current.runtime_closure_helpers,expected);
 assert.equal(expected.length,3);assert.equal(new Set(expected.map(record=>record.key)).size,3);
 const firstLegacy=current.sql.indexOf(current.changes[0].after.definition.trimEnd()+';');assert(firstLegacy>=0);
 for(const helper of expected){
  assert.equal(Object.keys(helper.value).length,24);
  assert(helper.key.startsWith('public.order_merge_delivery209_'));
  assert.deepEqual(helper.value.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
  assert.equal(helper.value.security_definer,true);assert.equal(helper.value.owner,'postgres');
  const index=current.sql.indexOf(helper.value.definition.trimEnd()+';');assert(index>=0&&index<firstLegacy);
  assert.equal(current.sql.split(helper.value.definition.trimEnd()+';').length-1,1);
  const types=helper.value.arguments.split(', ').map(argument=>argument.slice(argument.indexOf(' ')+1)).join(',');
  assert(current.sql.includes('REVOKE ALL ON FUNCTION '+helper.key.slice(0,helper.key.indexOf('('))+'('+types+') FROM PUBLIC,dyna_app;'));
  assert(current.helper_keys.includes(helper.key.slice(0,helper.key.indexOf('('))));
 }
 for(const helper of expected)assert(!current.sql.includes('CREATE OR REPLACE FUNCTION '+helper.key.replace('order_merge_delivery209_history_predecessor_project','ordinary177_predecessor_project').replace('order_merge_delivery209_history_operative_valid','ordinary181_history_operative_valid').replace('order_merge_delivery209_wave_valid','ordinary181_wave_valid')));
});

test('unchanged full own fingerprint and all-nonowner seal include all three new helpers without exceptions',()=>{
 const fp=deriveOrderMergeDelivery209FingerprintRecords(),seal=deriveOrderMergeDelivery209Seal();
 const originalFunction=RECORDS_SQL.split('\n').find(line=>line.startsWith(" UNION ALL SELECT 'function',"));
 const expected=originalFunction.replace(/^ UNION ALL /,'')
  .replace("WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND starts_with(p.proname,'order_merge_delivery209_')")
  .replace("'source',p.prosrc","'source',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))")
  .replace("'definition',pg_catalog.pg_get_functiondef(p.oid)","'definition',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'))");
 assert(fp.includes(expected),'complete canonical function arm is retained with both text leaf hashes');
 assert(seal.includes("FOR o IN SELECT p.proowner owner,p.proacl acl,p.oid::regprocedure::text identity FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'order_merge_delivery209_') LOOP"));
 assert(seal.includes("WHERE grantee<>o.owner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s'"));
 for(const helper of current.runtime_closure_helpers){
  const name=helper.key.slice(7,helper.key.indexOf('('));assert(name.startsWith('order_merge_delivery209_'));
  assert(!fp.includes("p.proname<>"+name));assert(!seal.includes('GRANT EXECUTE ON FUNCTION public.'+name));
 }
 assert.equal((seal.match(/^GRANT EXECUTE ON FUNCTION /gm)||[]).length,1,'only existing inherit public entry receives an app grant');
});

test('full Source19 assembly is deterministic candidate evidence, never Native/application acceptance',()=>{
 const assembled=assembleOrderMergeDelivery209({source166,core,predecessor:current});
 assert.equal(Buffer.byteLength(assembled.sql),27462515);
 assert.equal(assembled.sql_sha256,'97208701dc50ceef2e47140c1cbfde68fb4eeb41ab3bd59ed4f9206d07814a30');
 assert.equal(assembled.changes.length,10);
 for(const result of [current,assembled])for(const flag of ['source_compilation_performed','application_activation','native_certification'])assert.equal(result[flag],false,flag);
 assert(!assembled.sql.includes('UPDATE public.large_import173_certificate'));
 assert(!assembled.sql.includes('UPDATE public.wave_print177_certificate'));
 assert(!assembled.sql.includes('UPDATE public.buyer_address_manifest'));
});

test('explicit Source204 mode refuses drift/null instead of silently falling back to old behavior',()=>{
 for(const invalid of [null,source204+'\n',source204.replace('buyer_address_','buyer_address_x')])assert.throws(()=>deriveOrderMergeDelivery209Predecessor({changes:buyer,source166,source204:invalid}));
});
