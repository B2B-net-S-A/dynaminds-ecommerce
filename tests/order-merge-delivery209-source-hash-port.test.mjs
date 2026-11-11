import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {RECORDS_SQL} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {
 ORDER_MERGE_DELIVERY209_SOURCE_HASH_BASIS as PINS,
 deriveOrderMergeDelivery209SourceHashPort,rewriteOrderMergeDelivery209SourceHashes as rewrite,
} from '../tools/parity/order-merge-delivery209-source-hash-port.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
// The hash rewrite's input is the literal pre-rewrite Source18, regardless of
// which newer source contract the product currently packages.
const source18Bytes=readFileSync(new URL('./fixtures/order-merge-delivery209-source18-contract.json.gz',import.meta.url));
assert.equal(sha(source18Bytes),'0e51f0cae47c8ad5dfacd5c25e59180278f4f8187455f617f599d2c079f1a3fb');
const E209=JSON.parse(gunzipSync(source18Bytes,{maxOutputLength:21402960}));
const basis={bytes:21150718,sha256:'78364713a307b888c634f74c6f0c37e63c77b8aab62cca922099555bbd4c6287'};
const result=deriveOrderMergeDelivery209SourceHashPort({projectionBasis:basis});
const inventory={
 'public.catalog_header205_valid()':7,
 'public.manual_inventory_off_projection_valid()':0,
 'public.manual_inventory_off_valid()':2,
 'public.ordinary187_valid()':78,
 'public.partial_sale204_predecessor_definition(fn oid)':23,
 'public.partial_sale204_valid()':1,
};
const exec=source=>spans(source).filter(span=>span.executable).map(span=>span.text).join('');

test('all ten BEFORE hash outputs are exact complete-source authenticated values in fixed producer order',async()=>{
 assert.equal(result.before_hashes.length,10);
 for(const item of result.before_hashes){const expected=E209.changes.find(change=>change.key===item.key);assert(expected);assert.equal(item.sha256,sha(expected.before.source));assert(result.sql.includes("WHEN '"+item.key+"' THEN '"+item.sha256+"'"));}
 const {HEADER205_SOURCE_CONTRACT:E205}=await import('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/header205-source-contract.mjs');
 const keys=['buyer_address_preview_guard','buyer_address_state_guard','buyer_address_guards','buyer_address_fingerprint'].map(name=>'public.'+name+'()')
  .concat(E205.changes.map(change=>change.key),E205.additions.map(row=>row.key));
 assert.deepEqual(result.before_hashes.map(item=>item.key),keys);assert.deepEqual(PINS.keys,keys);
 for(let index=0;index<keys.length;index++)assert(result.sql.includes("WHEN '"+keys[index]+"' THEN entries->"+index));
});

test('scoped path retains complete canonical CURRENT24 fields with tagged source/definition digests',()=>{
 const original=RECORDS_SQL.split('\n').find(line=>line.startsWith(" UNION ALL SELECT 'function',"));
 const expected=original.replace(/^ UNION ALL /,'').replace("WHERE n.nspname IN ('public','ordinary187_private')",'WHERE p.oid=fn')
  .replace("'source',p.prosrc","'source',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))")
  .replace("'definition',pg_catalog.pg_get_functiondef(p.oid)","'definition',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'))");
 assert(result.sql.includes(expected),'entire canonical function descriptor, never a partial header');
 for(const token of ["jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>10",'IF total<>1 OR entry IS NULL',"entry->>'key' IS DISTINCT FROM actual_key OR live IS DISTINCT FROM entry->'after_check'",'SELECT count(*) OVER(),id,payload IS NOT NULL,payload_octets,payload_sha256','total IS DISTINCT FROM 1','source_id IS DISTINCT FROM true','payload_present IS DISTINCT FROM true','payload_bytes IS DISTINCT FROM '+basis.bytes,"payload_hash IS DISTINCT FROM '"+basis.sha256+"'"])assert(result.sql.includes(token),token);
 assert(!/SELECT[^;]*before_[0-9]/.test(result.sql),'no discarded multiMB BEFORE JSONB value is loaded');
 assert(!result.sql.includes('payload_jsonb'));
});

test('unchanged-name hash is identity only; scope and missing/overload refusal remain explicit/private',()=>{
 const body=result.sql;
 assert(body.includes("IF NOT FOUND THEN RAISE EXCEPTION '209 missing unchanged function'"));
 assert(body.includes("SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') INTO actual_sha"));
 assert(body.indexOf('RETURN actual_sha;')<body.indexOf('jsonb_typeof(entries)'));
 assert(body.includes("n.nspname='public' AND p.proname=ANY(ARRAY["));
 assert(body.includes("'public.'||p.proname=split_part(actual_key,'(',1)"));
 assert(body.endsWith('REVOKE ALL ON FUNCTION public.order_merge_delivery209_predecessor_source_sha(oid,jsonb) FROM PUBLIC,dyna_app;\n'));
 assert(!body.includes('set_config('));assert(!/\bGRANT\b|CREATE TABLE|\bUPDATE\b/.test(body));
 assert(result.requires_fresh_full10_producer_frame);assert(result.preserves_selected_current_full24_validation);
 for(const flag of ['integrated','performance_measured','source_compilation_performed','native_certification','application_activation'])assert.equal(result[flag],false);
});

test('exact111 hash sites across six real bodies reverse byte-for-byte; 73 full-text sites survive',()=>{
 let total=0,originalReads=0,remainingReads=0;
 for(const[key,count]of Object.entries(inventory)){
  const body=E209.changes.find(change=>change.key===key).after.source;
  const projected=rewrite(body,{expectedSites:count});assert.equal(projected.count,count);total+=count;
  let restored=projected.source;
  for(const edit of [...projected.replacements].reverse()){
   assert.equal(restored.slice(edit.rewritten_start,edit.rewritten_end),edit.after);
   restored=restored.slice(0,edit.rewritten_start)+edit.before+restored.slice(edit.rewritten_end);
  }
  assert.equal(restored,body,key+' complete unchanged predecessor witness');
  originalReads+=(exec(body).match(/order_merge_delivery209_predecessor_source\(/g)||[]).length;
  remainingReads+=(exec(projected.source).match(/order_merge_delivery209_predecessor_source\(/g)||[]).length;
  const opaque=s=>spans(s).filter(span=>!span.executable&&!['\'UTF8\'','\'hex\''].includes(span.text)).map(span=>span.text);
  assert.deepEqual(opaque(projected.source),opaque(body),key+' all historical/comment bytes');
 }
 assert.equal(total,111);assert.equal(originalReads,184);assert.equal(remainingReads,73);
});

test('Source19 two nonhash187 edges keep the same78 hash sites',()=>{
 let body=E209.changes.find(change=>change.key==='public.ordinary187_valid()').after.source;
 const edits=[
  ['public.ordinary181_wave_valid(manual_basis)','public.order_merge_delivery209_wave_valid(manual_basis)'],
  ['public.ordinary177_predecessor_project(public.order_merge_delivery209_predecessor_metadata(public.large_import173_predecessor_map(), merge_delivery209_local_frame))','public.order_merge_delivery209_history_predecessor_project(public.order_merge_delivery209_predecessor_metadata(public.large_import173_predecessor_map(), merge_delivery209_local_frame), merge_delivery209_local_frame)'],
 ];
 for(const[before,after]of edits){assert.equal(exec(body).split(before).length-1,1);body=spans(body).map(span=>span.executable?span.text.replace(before,after):span.text).join('');}
 const projected=rewrite(body,{expectedSites:78});
 for(const[_before,after]of edits)assert(exec(projected.source).includes(after));
});

test('selector respects SQL literals, comments, plain source reads and qualification boundaries',()=>{
 const hash="encode(sha256(convert_to(public.order_merge_delivery209_predecessor_source(p.oid, merge_delivery209_local_frame),'UTF8')),'hex')";
 const opaque="'"+hash.replaceAll("'","''")+"' $old$"+hash+'$old$ /* '+hash+' */';
 const text='SELECT '+hash+", public.order_merge_delivery209_predecessor_source(p.oid, merge_delivery209_local_frame);\n"+opaque;
 const projected=rewrite(text,{expectedSites:1});assert(projected.source.endsWith(opaque));
 assert(projected.source.includes(', public.order_merge_delivery209_predecessor_source(p.oid, merge_delivery209_local_frame);'));
 assert.throws(()=>rewrite('SELECT pg_catalog.'+hash,{expectedSites:1}),/closed hash-expression roster/,'never leave pg_catalog.public qualifier corruption');
 assert.throws(()=>rewrite(hash.replace('sha256(','sha256(/* preserve */'),{expectedSites:1}),/no historical\/comment/);
 assert.throws(()=>rewrite(text,{expectedSites:2}),/closed hash-expression roster/);
 const otherEncoding=hash.replace("'UTF8'","'LATIN1'");assert.equal(rewrite(otherEncoding,{expectedSites:0}).source,otherEncoding);
});

test('explicit pure assembler basis refuses malformed shape and unsafe SQL literals',()=>{
 for(const invalid of [null,{bytes:1,sha256:'bad'},{bytes:1,sha256:'a'.repeat(64),extra:true},{bytes:0,sha256:'a'.repeat(64)}])assert.throws(()=>deriveOrderMergeDelivery209SourceHashPort({projectionBasis:invalid}));
});

test('optional frame selection preserves all111 historical default outputs and generated port SQL byte-for-byte',()=>{
 const rows=[];
 for(const[key,count]of Object.entries(inventory)){
  const original=E209.changes.find(change=>change.key===key).after.source;
  const implicit=rewrite(original,{expectedSites:count}),explicit=rewrite(original,{expectedSites:count,frameName:'merge_delivery209_local_frame'});
  assert.deepEqual(explicit,implicit);
  rows.push({key,count,sha256:sha(implicit.source)});
 }
 // Captured independently from the unchanged implementation before this edit.
 assert.equal(sha(JSON.stringify(rows)),'81b1469ae3dfb1012ed72b66949b6dae1b8f8a52ebf651850561530ff6db5398');
 assert.equal(sha(result.sql),'2c25f064a12f2f5bce660ebb319959471d80d8b054990259c957cc5d1c7b6c36');
});

test('entries frame rewrites only its exact closed hash expressions and retains a full inverse on111 real source sites',()=>{
 let total=0;
 for(const[key,count]of Object.entries(inventory)){
  const original=E209.changes.find(change=>change.key===key).after.source;
  const input=spans(original).map(span=>span.executable?span.text.replace(/\bmerge_delivery209_local_frame\b/g,'entries'):span.text).join('');
  const selected=rewrite(input,{expectedSites:count,frameName:'entries'});total+=selected.count;
  for(const edit of selected.replacements){assert(edit.after.endsWith(', entries)'));assert(edit.before.includes('entries'));assert(!edit.after.includes('merge_delivery209_local_frame'));}
  let restored=selected.source;
  for(const edit of [...selected.replacements].reverse()){assert.equal(restored.slice(edit.rewritten_start,edit.rewritten_end),edit.after);restored=restored.slice(0,edit.rewritten_start)+edit.before+restored.slice(edit.rewritten_end);}
  assert.equal(restored,input,key+' entries full-body inverse');
  const opaque=value=>spans(value).filter(span=>!span.executable&&!['\'UTF8\'','\'hex\''].includes(span.text)).map(span=>span.text);
  assert.deepEqual(opaque(selected.source),opaque(input),key+' all quoted history and comments unchanged');
 }
 assert.equal(total,111);
});

test('frame selector excludes other frames, quoted lookalikes, comments and identifier-prefix/suffix matches',()=>{
 const hash=frame=>"encode(sha256(convert_to(public.order_merge_delivery209_predecessor_source(p.oid, "+frame+"),'UTF8')),'hex')";
 const selected=hash('entries'),other=hash('merge_delivery209_local_frame');
 const opaque="'"+selected.replaceAll("'","''")+"' $history$"+selected+'$history$ /* '+selected+' */';
 const input='SELECT '+selected+', '+other+", public.order_merge_delivery209_predecessor_source(p.oid, entries);\n"+opaque;
 const output=rewrite(input,{expectedSites:1,frameName:'entries'});
 assert(output.source.includes('public.order_merge_delivery209_predecessor_source_sha(p.oid, entries)'));
 assert(output.source.includes(other));assert(output.source.endsWith(opaque));assert(output.source.includes('public.order_merge_delivery209_predecessor_source(p.oid, entries);'));
 for(const frame of ['myentries','entries2','entries_extra'])assert.equal(rewrite(hash(frame),{expectedSites:0,frameName:'entries'}).source,hash(frame));
 assert.throws(()=>rewrite(selected,{expectedSites:1}),/closed hash-expression roster/);
 assert.throws(()=>rewrite(other,{expectedSites:1,frameName:'entries'}),/closed hash-expression roster/);
 assert.throws(()=>rewrite(selected.replace('sha256(','sha256(/* keep */'),{expectedSites:1,frameName:'entries'}),/no historical\/comment/);
});

test('frame names are bounded plain SQL identifiers, never caller expressions or regex injection',()=>{
 for(const frameName of [null,1,{},'', 'Entries','entries.x','entries::jsonb','entries, other','entries;SELECT 1','entries /*x*/','"entries"','entries\\w*','entries|x','entries\n','x'.repeat(64)]){
  assert.throws(()=>rewrite('SELECT 1',{expectedSites:0,frameName}),/fixed SQL frame identifier/);
 }
 assert.equal(rewrite('SELECT 1',{expectedSites:0,frameName:'frame_2'}).source,'SELECT 1');
});
