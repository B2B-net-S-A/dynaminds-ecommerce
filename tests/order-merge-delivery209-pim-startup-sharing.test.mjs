/** Pure source derivation only: no PostgreSQL, application or provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderMergeDelivery209PimStartupSharing,projectOrderMergeDelivery209PimSharingSource} from '../tools/parity/order-merge-delivery209-pim-startup-sharing.mjs';
import {projectOrderMergeDelivery209Source} from '../tools/parity/order-merge-delivery209-predecessor.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
const source204=fs.readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
const source168=fs.readFileSync(new URL('../server/168_physical_parcel_wz.sql',import.meta.url),'utf8');
const result=deriveOrderMergeDelivery209PimStartupSharing({source204,source168});
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const sha=v=>createHash('sha256').update(v).digest('hex');
const executable=s=>spans(s).filter(s=>s.executable).map(s=>s.text).join(' ');

test('complete source-derived issuer matches fixed independently compiled208 full24 record',()=>{
 assert.equal(result.complete_source_derivation,true);assert.equal(result.before.length,4);assert.equal(result.helpers.length,4);
 const issuer=result.before.at(-1);assert.equal(issuer.key,'public.warehouse_wz_issuer_guards()');
 assert.equal(sha(JSON.stringify(canonical(issuer))),'137385ee76a0222c5efa29b452ae2914b45ff373d181448cbc61eae0bcbddbd8');
 assert.equal(Buffer.byteLength(issuer.value.source),1908);assert.equal(Object.keys(issuer.value).length,24);
 assert.equal(result.source_compilation_performed,false);assert.equal(result.native_certification,false);assert.equal(result.application_activation,false);assert.equal(result.preprojection_only,true);
});

test('three leaves retain complete metadata and original body except exactly one wave evaluation',()=>{
 for(let i=0;i<3;i++){
  const before=result.before[i],after=result.helpers[i];assert.equal((executable(after.value.source).match(/\bwave_ok\b/g)||[]).length,1);
  assert.equal(after.value.source.replace(/\bwave_ok\b/,'public.wave_print177_valid()'),before.value.source);
  for(const key of Object.keys(before.value).filter(k=>!['source','definition','arguments','argument_names','acl','acl_null'].includes(k)))assert.deepEqual(after.value[key],before.value[key]);
  assert.deepEqual(after.value.argument_names,['entries','wave_ok']);assert.equal(after.value.arguments,'entries jsonb, wave_ok boolean');
  assert(after.value.source.includes("to_regprocedure('public.wave_print177_valid()')"));
  assert(after.value.source.includes('789ecccafca44cb6243dfbe14e642f4d6ee59e87305e11682feef848b521f091'));
 }
 const packed=result.helpers[1].value.source;assert(packed.includes('public.label_print_guards() IS DISTINCT FROM true OR public.print_job_guards() IS DISTINCT FROM true'));
});

test('issuer preserves every installed,14-trigger,ACL,automatic-WZ and manifest predicate literally',()=>{
 const before=result.before[3],after=result.helpers[3];
 assert.equal(after.value.source.replace('public.order_merge_delivery209_pim_parcel_valid(entries,wave_ok)','public.parcel_physical_wz_valid()'),before.value.source);
 for(const text of ['warehouse_wz_issuer_installed()','warehouse_automatic_wz_guards()','<>14','a.grantee<>c.relowner','a.grantee<>p.proowner','SELECT fingerprint INTO expected','expected IS NOT NULL AND'])assert(after.value.source.includes(text));
});

test('independent three-edit inverse restores WHOLE PIM and keeps every original25 dispatcher',()=>{
 const change=result.changes[0];assert.equal(change.key,'public.pim_dictionary_valid()');let source=change.after.source;
 assert.equal((executable(source).match(/\bwave_ok\s*:=\s*public\.wave_print177_valid\(\)/g)||[]).length,1);
 const command="EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;";
 const dispatch="IF guard_name='operative_delivery_valid' THEN guard_ok:=public.order_merge_delivery209_pim_operative_valid(merge_delivery209_local_frame,wave_ok);ELSIF guard_name='packed_label_print_guards' THEN guard_ok:=public.order_merge_delivery209_pim_packed_guards(merge_delivery209_local_frame,wave_ok);ELSIF guard_name='parcel_physical_wz_valid' THEN guard_ok:=public.order_merge_delivery209_pim_parcel_valid(merge_delivery209_local_frame,wave_ok);ELSIF guard_name='warehouse_wz_issuer_guards' THEN guard_ok:=public.order_merge_delivery209_pim_issuer_guards(merge_delivery209_local_frame,wave_ok);ELSE "+command+'END IF;';
 assert.equal(source.split(dispatch).length,2);source=source.replace(dispatch,()=>command);
 const split='THEN RETURN false;END IF;\n wave_ok:=public.wave_print177_valid();\n IF wave_ok IS DISTINCT FROM true THEN RETURN false;END IF;';
 assert.equal(source.split(split).length,2);source=source.replace(split,'OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;');
 source=source.replace('DECLARE wave_ok boolean;','DECLARE');assert.equal(source,change.before.source);
 assert.equal(change.after.source.split(command).length-1,4,'all four original dynamic dispatchers including fallback remain');
 assert(change.after.source.includes('jsonb_object_keys(public.pim_dictionary_predecessor_metadata())'));
});

test('only private ports and invocation-local data; parent projection/sealing still explicitly required',()=>{
 for(const helper of result.helpers){assert.deepEqual(helper.value.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);assert.equal(helper.value.acl_null,false);assert(result.sql.includes('REVOKE ALL ON FUNCTION '+helper.key.replace('entries jsonb, wave_ok boolean','jsonb,boolean')+' FROM PUBLIC,dyna_app;'));}
 const code=executable(result.sql);assert(!/\b(?:INSERT|UPDATE|DELETE|set_config|current_setting)\b/.test(code.replace(/\bcurrent_setting\s*\([^)]*\)/g,'')));
 assert.equal(result.parent_requirements.private_generic_source_projection_frame,'entries');assert.equal(result.parent_requirements.genuine_pim_entry_frame_required,true);assert.equal(result.parent_requirements.private_acl_seal_required,true);assert.equal(result.shared_wave_evaluations,1);
});

test('closed four-helper projection roster agrees with actual generic producer; issuer alone is identity',()=>{
 assert.deepEqual(result.expected_projection_counts.map(r=>[r.key.split('_pim_')[1].split('(')[0],r.counts.source_reads,r.counts.definition_reads,r.counts.metadata_reads,r.source_hash_sites,r.identity]),[
  ['operative_valid',1,0,0,1,false],['packed_guards',1,0,0,1,false],['parcel_valid',11,0,0,11,false],['issuer_guards',0,0,0,0,true],
 ]);
 for(let i=0;i<3;i++){
  const projected=projectOrderMergeDelivery209Source(result.helpers[i].value.source,{frame:'entries'});
  assert.deepEqual(projected.counts,result.expected_projection_counts[i].counts);
  assert(!/\bprosrc\b/.test(executable(projected.source)));
  assert(projected.source.includes('predecessor_source('));assert(projected.source.includes(', entries)'));
 }
 // An identity leaf is handled by its own exact-zero branch. The generic
 // producer still refuses source-free input; its global assertion stays intact.
 assert.throws(()=>projectOrderMergeDelivery209Source(result.helpers[3].value.source,{frame:'entries'}),/must actually read/);
 assert.equal(result.expected_projection_counts.length,result.helpers.length);
});

test('wrong source and malformed dispatcher shapes refuse; missing issuer never claims complete dispatch',()=>{
 assert.throws(()=>deriveOrderMergeDelivery209PimStartupSharing({source204:source204+'\n',source168}));
 assert.throws(()=>deriveOrderMergeDelivery209PimStartupSharing({source204,source168:source168+'\n'}));
 const partial=deriveOrderMergeDelivery209PimStartupSharing({source204});assert.equal(partial.complete_source_derivation,false);assert.equal(partial.helpers.length,3);assert.deepEqual(partial.changes,[]);assert.deepEqual(partial.missing_source_anchors,['public.warehouse_wz_issuer_guards()']);
 const source=result.changes[0].before.source;assert.throws(()=>projectOrderMergeDelivery209PimSharingSource(source.replace('public.wave_print177_valid() IS DISTINCT','public.foreign() IS DISTINCT')));
 assert.throws(()=>projectOrderMergeDelivery209PimSharingSource(source.replace("EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;",'')));
});
