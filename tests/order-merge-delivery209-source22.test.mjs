/** Pure source integration only. Never installs SQL or accepts a runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderMergeDelivery209Bodies,assembleOrderMergeDelivery209} from '../tools/parity/order-merge-delivery209-source.mjs';
import {deriveOrderMergeDelivery209Predecessor,projectOrderMergeDelivery209FunctionCheck,projectOrderMergeDelivery209Descriptor} from '../tools/parity/order-merge-delivery209-predecessor.mjs';
import {deriveOrderMergeDelivery209ValidationSnapshot} from '../tools/parity/order-merge-delivery209-validation-snapshot.mjs';
import {deriveOrderMergeDelivery209SourceHashPort} from '../tools/parity/order-merge-delivery209-source-hash-port.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS,assertOrderMergeDelivery209StartupBeforeRecords} from '../tools/parity/order-merge-delivery209-startup-roster.mjs';
import {deriveOrderMergeDelivery209StartupClosure} from '../tools/parity/order-merge-delivery209-startup-capability-closure.mjs';
import {deriveOrderMergeDelivery209PimStartupSharing} from '../tools/parity/order-merge-delivery209-pim-startup-sharing.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const source166=read('server/166_buyer_address_sidecar.sql'),source204=read('server/204_partial_commercial_sale_scope.sql'),source181=read('server/181_same_root_guard_observations.sql');
const source168=read('server/168_physical_parcel_wz.sql');
const buyer=deriveOrderMergeDelivery209Bodies({source166});
const candidate=deriveOrderMergeDelivery209Predecessor({changes:buyer,source166,source204,source181,source168,runtimeRevision:22});
const all=[...buyer,...candidate.changes];
const assembled=assembleOrderMergeDelivery209({source166,core:read('tools/parity/order-merge-delivery209-business.sql'),predecessor:candidate});
const beforeRecords=all.map(c=>({kind:c.kind,key:c.key,value:c.before}));
const startup=deriveOrderMergeDelivery209StartupClosure({source204});
const hashPort=deriveOrderMergeDelivery209SourceHashPort({projectionBasis:candidate.projection_basis,beforeRecords,runtimeRevision:22});

test('Source22 authenticates the complete seven public BEFORE records and retains every header/ACL',()=>{
 assert.equal(candidate.runtime_revision,22);assert.equal(candidate.startup_function_count,7);
 assert.equal(all.length,17);assert.deepEqual(all.slice(10).map(c=>c.key),ORDER_MERGE_DELIVERY209_STARTUP_KEYS);
 assertOrderMergeDelivery209StartupBeforeRecords(beforeRecords.slice(10));
 for(const c of all.slice(10)){
  const {source:s,definition:d,...before}=c.before,{source:t,definition:e,...after}=c.after;
  assert.deepEqual(after,before,c.key);assert.notEqual(t,s,c.key);
  assert.equal(e,d.replace(s,()=>t));
  assert.equal(t.split('merge_delivery209_local_frame:=public.order_merge_delivery209_checked_projection_map();').length,2);
 }
 for(const c of all)assert.equal(Object.keys(c.before).length,24);
 for(const flag of ['source_compilation_performed','native_certification','application_activation'])assert.equal(candidate[flag],false);
});

test('all seventeen payload members and fresh snapshot bindings refer to the FINAL projected bodies',()=>{
 const marker="INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'";
 const start=candidate.preambleSql.indexOf(marker);assert(start>=0);
 const text=candidate.preambleSql.slice(start+marker.length,-4).replaceAll("''","'");
 assert.equal(Buffer.byteLength(text),candidate.projection_basis.bytes);
 assert.equal(createHash('sha256').update(text).digest('hex'),candidate.projection_basis.sha256);
 const entries=JSON.parse(text);assert.equal(entries.length,17);
 for(let i=0;i<17;i++){
  assert.equal(entries[i].key,all[i].key);assert.deepEqual(entries[i].before,all[i].before);
  assert.deepEqual(entries[i].after,all[i].after);
  assert.deepEqual(entries[i].after_check,projectOrderMergeDelivery209FunctionCheck(all[i].after));
 }
 const snapshot=deriveOrderMergeDelivery209ValidationSnapshot({changes:all,runtimeRevision:22});
 assert.equal(snapshot.keys.length,17);assert(assembled.sql.includes(snapshot.sql));
 const checked=candidate.sql.split('$checked209$')[1];
 for(const token of ['jsonb_array_length(current_rows)<>17','jsonb_array_length(entries)<>17',
  'binding_ordinal NOT BETWEEN 1 AND 17','IF validated<>17','generate_series(0,16)'])assert(checked.includes(token),token);
 for(let i=0;i<17;i++)assert(candidate.preambleSql.includes('before_'+i+' jsonb GENERATED ALWAYS AS'));
 assert.equal(hashPort.before_hashes.length,17);assert(candidate.sql.includes(hashPort.sql));
});

test('public wave and its existing private clone use the same fresh source/metadata side',()=>{
 const publicWave=all.find(c=>c.key==='public.wave_print177_valid()').after.source;
 const privateWave=candidate.runtime_closure_helpers.find(h=>h.key==='public.order_merge_delivery209_wave_valid(manual_basis jsonb)').value.source;
 for(const source of [publicWave,privateWave]){
  assert.equal(source.split('merge_delivery209_local_frame:=public.order_merge_delivery209_checked_projection_map();').length,2);
  assert(source.includes('public.order_merge_delivery209_predecessor_source(oid, merge_delivery209_local_frame) INTO STRICT current_source189'));
  assert(source.includes('public.order_merge_delivery209_predecessor_source_sha(oid, merge_delivery209_local_frame) INTO leaf_sha'));
  assert(source.includes('public.order_merge_delivery209_predecessor_metadata(public.wave_print177_metadata(), merge_delivery209_local_frame)'));
 }
 assert(publicWave.includes('public.order_merge_delivery209_startup_operative_valid(merge_delivery209_local_frame)'));
 const helper=candidate.runtime_closure_helpers.find(h=>h.key==='public.order_merge_delivery209_startup_operative_valid(entries jsonb)');
 assert.deepEqual(helper,startup.helpers[0]);assert.equal(candidate.runtime_closure_helpers.length,11);
 assert(candidate.sql.includes(helper.value.definition.trimEnd()));
 assert(candidate.sql.includes('REVOKE ALL ON FUNCTION public.order_merge_delivery209_startup_operative_valid(jsonb) FROM PUBLIC,dyna_app;'));
});

test('history map compares both six-root metadata sides through the same complete source projection',()=>{
 const helper=candidate.runtime_closure_helpers.find(h=>h.key==='public.order_merge_delivery209_history_predecessor_project(v jsonb, entries jsonb)');
 const expected='public.order_merge_delivery209_predecessor_metadata(public.pim_dictionary_function_metadata(to_regprocedure(entry204.sig)), entries)';
 const code=spans(helper.value.source).filter(span=>span.executable).map(span=>span.text).join(' ');
 assert.equal(code.split(expected).length,2);
 assert(code.includes('r->(entry204.name) IS DISTINCT FROM '+expected));
 assert(code.includes('public.partial_sale204_predecessor_definition(to_regprocedure(entry204.sig))'));
});

test('PIM private leaves share only this invocation wave while retaining projected source checks and sealed ACL',()=>{
 const sharing=deriveOrderMergeDelivery209PimStartupSharing({source204,source168});
 for(let i=0;i<sharing.helpers.length;i++){
  const before=sharing.helpers[i],final=candidate.runtime_closure_helpers.find(h=>h.key===before.key),expected=sharing.expected_projection_counts[i];assert(final);
  const {source:a,definition:ad,...ah}=before.value,{source:b,definition:bd,...bh}=final.value;assert.deepEqual(bh,ah);assert.equal(bd,ad.replace(a,()=>b));
  const code=spans(b).filter(span=>span.executable).map(span=>span.text).join(' ');
  assert(!/\bprosrc\b|\bpg_get_functiondef\s*\(/.test(code));
  assert.equal((code.match(/public\.order_merge_delivery209_predecessor_source_sha\([^,]+, entries\)/g)||[]).length,expected.source_hash_sites);
  if(expected.identity)assert.equal(b,a);else assert.notEqual(b,a);
  assert(candidate.helper_keys.includes(final.key.slice(0,final.key.indexOf('('))));
  assert(assembled.sql.includes('REVOKE ALL ON FUNCTION '+final.key.replace('entries jsonb, wave_ok boolean','jsonb,boolean')+' FROM PUBLIC,dyna_app;'));
 }
 const pim=all.find(c=>c.key==='public.pim_dictionary_valid()').after.source,code=spans(pim).filter(span=>span.executable).map(span=>span.text).join(' ');
 assert.equal((code.match(/wave_ok:=public\.wave_print177_valid\(\)/g)||[]).length,1);
 for(const name of ['operative_valid','packed_guards','parcel_valid','issuer_guards'])assert(code.includes('public.order_merge_delivery209_pim_'+name+'(merge_delivery209_local_frame,wave_ok)'));
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({changes:buyer,source166,source204,source181,runtimeRevision:22}),/literal Source168/);
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({changes:buyer,source166,source204,source181,source168:source168+'\n',runtimeRevision:22}));
});

test('the expanded descriptor oracle rejects every startup field drift and name ambiguity',()=>{
 const expected=all.map(c=>({...c,after:projectOrderMergeDelivery209FunctionCheck(c.after)}));
 const rows=expected.map(c=>({kind:'function',key:c.key,value:c.after}));
 assert.deepEqual(projectOrderMergeDelivery209Descriptor(rows,expected,expected[10].key),expected[10].before);
 for(let index=10;index<17;index++)for(const field of Object.keys(rows[index].value)){
  const changed=structuredClone(rows),v=changed[index].value[field];
  changed[index].value[field]=typeof v==='boolean'?!v:typeof v==='number'?v+1:v===null?'nonnull':null;
  assert.throws(()=>projectOrderMergeDelivery209Descriptor(changed,expected,expected[10].key),/exact complete AFTER descriptor/);
 }
 for(const changed of [rows.slice(0,-1),[...rows,rows[16]],
  [...rows,{...rows[16],key:'public.packed_label_print_guards(unexpected integer)'}]])
  assert.throws(()=>projectOrderMergeDelivery209Descriptor(changed,expected,expected[10].key),/missing|duplicate|overloaded/);
 for(const field of ['owner','acl','source','definition']){
  const changed=structuredClone(beforeRecords);changed[16].value[field]=field==='acl'?[]:'changed';
  assert.throws(()=>deriveOrderMergeDelivery209SourceHashPort({projectionBasis:candidate.projection_basis,beforeRecords:changed,runtimeRevision:22}));
 }
 assert.throws(()=>deriveOrderMergeDelivery209ValidationSnapshot({changes:all}));
 assert.throws(()=>deriveOrderMergeDelivery209SourceHashPort({projectionBasis:candidate.projection_basis,beforeRecords}));
});
