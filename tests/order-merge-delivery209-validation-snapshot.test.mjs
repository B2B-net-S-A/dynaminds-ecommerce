/** Independent source-query tests. No PostgreSQL execution or runtime verdict. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {deriveOrderMergeDelivery209ValidationSnapshot as derive} from '../tools/parity/order-merge-delivery209-validation-snapshot.mjs';
import {deriveOrderMergeDelivery209Bodies,deriveOrderMergeDelivery209Manifest,deriveOrderMergeDelivery209FingerprintRecords} from '../tools/parity/order-merge-delivery209-source.mjs';
import {HEADER205_SOURCE_CONTRACT as E205} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/header205-source-contract.mjs';
import {RECORDS_SQL} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';

// This producer consumes only authenticated roster identities; it does not
// authenticate AFTER values or grant admission. Actual source-generation and
// checked-map integration must supply and independently compare those values.
const source166=readFileSync(new URL('../server/166_buyer_address_sidecar.sql',import.meta.url),'utf8');
const changes=[...deriveOrderMergeDelivery209Bodies({source166}),...E205.changes,
 ...E205.additions.map(record=>({kind:record.kind,key:record.key,before:record.value,after:record.value}))];
const expectedKeys=[
 'public.buyer_address_preview_guard()','public.buyer_address_state_guard()','public.buyer_address_guards()','public.buyer_address_fingerprint()',
 'public.manual_inventory_off_valid()','public.manual_inventory_off_projection_valid()','public.partial_sale204_predecessor_definition(fn oid)',
 'public.ordinary187_valid()','public.partial_sale204_valid()','public.catalog_header205_valid()',
];
const result=derive({changes}),sha=value=>createHash('sha256').update(value).digest('hex');
const executable=source=>spans(source).filter(span=>span.executable).map(span=>span.text).join('');
const replaceOnce=(source,before,after)=>{assert.equal(source.split(before).length,2,'independent inverse has exactly one edit');return source.replace(before,()=>after);};

function fingerprintSubselect(query){
 const marker="'fingerprint',(";assert.equal(query.split(marker).length,2);
 const start=query.indexOf(marker)+marker.length;let depth=1,offset=0,end;
 for(const part of spans(query)){
  if(part.executable)for(let index=0;index<part.text.length;index++){
   const position=offset+index;if(position<start)continue;
   if(part.text[index]==='(')depth++;
   else if(part.text[index]===')'&&--depth===0){end=position;break;}
  }
  if(end!==undefined)break;offset+=part.text.length;
 }
 assert(end>start,'closed fingerprint subselect');assert(query.slice(end).startsWith("),\n 'legacy',("));
 return query.slice(start,end);
}

test('snapshot uses the exact closed ordered4buyer+5E205+addition function identities',()=>{
 assert.deepEqual(changes.map(change=>change.key),expectedKeys);assert.deepEqual(result.keys,expectedKeys);
 assert.equal(result.function_key,'public.order_merge_delivery209_validation_snapshot()');
 const names=[...result.legacy_query.matchAll(/'([a-z_][a-z_0-9]*)'/g)].map(match=>match[1]);
 const expectedNames=expectedKeys.map(key=>key.slice(7,key.indexOf('(')));
 for(const name of expectedNames)assert.equal(names.filter(value=>value===name).length,1,name);
 assert(result.legacy_query.endsWith("WHERE n.nspname='public' AND p.proname=ANY(ARRAY["+expectedNames.map(name=>"'"+name+"'").join(',')+"]::text[])"));
 assert.equal(new Set(result.keys).size,10);assert(Object.isFrozen(result.keys));
});

test('one materialized canonical legacy query is shared by exactly the original digest and full-row return consumers',()=>{
 assert(result.query.startsWith('WITH legacy209_current(kind,key,value) AS MATERIALIZED ('+result.legacy_query+')\nSELECT jsonb_build_object('));
 assert.equal(result.query.split(result.legacy_query).length-1,1,'large fresh CURRENT24 expressions occur in the producer exactly once');
 assert.equal((executable(result.query).match(/\blegacy209_current\b/g)||[]).length,3,'one declaration plus two consumers');
 assert.equal(result.query.split('FROM legacy209_current legacy209(kind,key,value)').length-1,1);
 assert.equal(result.query.split('FROM legacy209_current)').length-1,1);
 assert(!result.query.includes('NOT MATERIALIZED'));
 assert(result.query.includes("'legacy',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'key',key,'value',value) ORDER BY key COLLATE \"C\"),'[]'::jsonb) FROM legacy209_current)"));
});

test('independent full canonical function arm proves every current header, ACL, and complete tagged text field is retained',()=>{
 const arm=RECORDS_SQL.split('\n').filter(line=>line.startsWith(" UNION ALL SELECT 'function',"));assert.equal(arm.length,1);
 let expected=replaceOnce(arm[0].replace(/^ UNION ALL /,''),"WHERE n.nspname IN ('public','ordinary187_private')",
  "WHERE n.nspname='public' AND p.proname=ANY(ARRAY["+expectedKeys.map(key=>"'"+key.slice(7,key.indexOf('('))+"'").join(',')+"]::text[])");
 for(const[field,expression]of [['source','p.prosrc'],['definition','pg_catalog.pg_get_functiondef(p.oid)']])
  expected=replaceOnce(expected,"'"+field+"',"+expression,"'"+field+"',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to("+expression+",'UTF8')),'hex'))");
 assert.equal(result.legacy_query,expected,'entire canonical reader arm, not a selected header subset');
 const fields=['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'];
 assert.equal(fields.length,24);for(const field of fields)assert(result.legacy_query.includes("'"+field+"',"),field);
 assert.equal(result.current_descriptor_fields,24);assert.deepEqual(result.current_complete_text_digests,['source','definition']);
 assert.equal(result.legacy_query.split("'sha256-utf8-text/v1'").length-1,2);
 assert(!/\bsubstr\(|\bleft\(|\bright\(/.test(result.legacy_query));
});

test('inverse CTE substitution reproduces the whole original fingerprint body byte for byte',()=>{
 const old=deriveOrderMergeDelivery209Manifest(changes).split('$fp209$');assert.equal(old.length,3);
 const current=fingerprintSubselect(result.query);
 const restored=replaceOnce(current,'FROM legacy209_current legacy209(kind,key,value)','FROM('+result.legacy_query+') legacy209(kind,key,value)');
 assert.equal(sha(restored),sha(old[1]));assert.equal(restored,old[1]);
 assert.equal(result.original_fingerprint_source,old[1]);
 assert(restored.includes('FROM('+deriveOrderMergeDelivery209FingerprintRecords()+') own209)'),'complete fresh eight-kind own collection remains literal');
 assert(restored.includes("'projection_payload',(SELECT jsonb_build_object('byte_count',payload_octets,'sha256',payload_sha256)"));
 assert(restored.includes("'profile','merge-delivery-complete-record-text-digests/v2'"));
 for(const label of ['legacy','constraints'])assert(restored.includes("'"+label+"',(SELECT jsonb_agg(jsonb_build_array(kind,key,"));
 assert.equal((restored.match(/ORDER BY kind COLLATE "C",key COLLATE "C"/g)||[]).length,2);
});

test('returned rows preserve overload/missing/duplicate visibility instead of performing or fabricating expected-map admission',()=>{
 assert(!/\bDISTINCT\b|\bLIMIT\b|\bGROUP BY\b|jsonb_object_agg\(/.test(result.legacy_query));
 assert(!result.query.includes('jsonb_object_agg('));
 assert(result.legacy_query.includes("p.proname=ANY(ARRAY["),'all same-name overloads are selected');
 assert(!result.legacy_query.includes('WHERE p.oid='),'not just the first OID matching an expected signature');
 assert(result.requires_independent_complete_ten_expected_checks);
 assert(!result.query.includes('after_check'));
 assert(!/jsonb_build_object\(\s*'valid'|jsonb_build_object\(\s*'accepted'/.test(result.query));
 // Count-preservation algebra only. Native integration must enforce the exact
 // ten identities and ALL24 values; the snapshot deliberately hides no row.
 const expected=expectedKeys.map(key=>({kind:'function',key,value:{source:['sha256-utf8-text/v1',null]}}));
 const collect=rows=>rows.map(row=>structuredClone(row)).sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key)));
 for(const rows of [[],expected.slice(1),[...expected,expected[0]],[...expected,{kind:'function',key:'public.buyer_address_guards(unexpected integer)',value:{}}]])
  assert.equal(collect(rows).length,rows.length);
});

test('wrapper and private SQL do not recurse through validity, expose a caller frame or store a verdict',()=>{
 assert.equal(result.fingerprint_source,"\n SELECT public.order_merge_delivery209_validation_snapshot()->>'fingerprint'\n");
 assert(result.sql.startsWith('CREATE FUNCTION public.order_merge_delivery209_validation_snapshot() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $snapshot209$\n'));
 assert.equal(result.sql.split('$snapshot209$').length,3);assert.equal(result.sql.split('$snapshot209$')[1],'\n'+result.query+'\n');
 assert(result.sql.endsWith('REVOKE ALL ON FUNCTION public.order_merge_delivery209_validation_snapshot() FROM PUBLIC,dyna_app;\n'));
 const text=executable(result.query);
 assert(!/\b(?:public\.)?order_merge_delivery209_(?:fingerprint|valid|validation_snapshot)\s*\(/.test(text),'no function-execution cycle while reading current pg_proc descriptors');
 assert(!/\bset_config\s*\(|\bcurrent_setting\s*\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bGRANT\b/.test(text));
 assert(!result.sql.includes('entries jsonb'));assert(!result.sql.includes('RETURNS boolean'));
 assert.equal(result.materialization_scope,'one SQL invocation; fresh catalogue reads on every call');
});

test('altered, missing, duplicate, reordered, foreign-schema and wrong-kind roster inputs fail closed',()=>{
 for(const invalid of [undefined,null,[],changes.slice(1),[...changes,changes[0]],changes.slice().reverse(),
  changes.map((change,index)=>index===1?changes[0]:change),
  changes.map((change,index)=>index===0?{...change,kind:'relation'}:change),
  changes.map((change,index)=>index===6?{...change,key:'public.partial_sale204_predecessor_definition(fn integer)'}:change),
  changes.map((change,index)=>index===0?{...change,key:'foreign.buyer_address_preview_guard()'}:change),
  changes.map((change,index)=>index===0?{...change,key:"public.buyer_address_preview_guard(); SELECT true--()"}:change)])
  assert.throws(()=>derive({changes:invalid}));
 assert.throws(()=>derive());
});

test('query construction ignores descriptor payload as authority and never claims compilation, integration or performance',()=>{
 const payload=changes.map(change=>({...change,before:{source:'not trusted'},after:{source:'not trusted'},observed_valid:true}));
 const other=derive({changes:payload});assert.equal(other.query,result.query,'only fixed source identities choose fresh current records');
 assert(!other.query.includes('not trusted'));assert(!other.query.includes('observed_valid'));
 for(const key of ['integrated','performance_measured','source_compilation_performed','native_certification','application_activation'])assert.equal(result[key],false,key);
 assert(Object.isFrozen(result));
 const module=readFileSync(new URL('../tools/parity/order-merge-delivery209-validation-snapshot.mjs',import.meta.url),'utf8');
 assert(!/from\s+['"](?:pg|node:fs|node:child_process|node:http|node:https)['"]|\bfetch\s*\(|\bexec\s*\(|\bspawn\s*\(/.test(module),'import-inert query producer');
});
