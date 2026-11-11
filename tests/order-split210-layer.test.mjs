/** Selected accepted22b fixture, not a catalogue or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {deriveOrderSplit210HistoryOperativeSuccessor} from '../tools/parity/order-split210-history-operative-successor.mjs';
import {deriveOrderSplit210HistoryBuyerSuccessor} from '../tools/parity/order-split210-history-buyer-successor.mjs';
import {deriveOrderSplit210StartupOperativeSuccessor} from '../tools/parity/order-split210-startup-operative-successor.mjs';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deriveOrderSplit210MetadataFreshMap} from '../tools/parity/order-split210-metadata-fresh-map.mjs';
import {deriveOrderSplit210MetadataComposite} from '../tools/parity/order-split210-metadata-composite.mjs';
import {ORDER_SPLIT210_LAYER_PARENT as P,readOrderSplit210LayerSource,deriveOrderSplit210Layer} from '../tools/parity/order-split210-layer.mjs';

// Ten complete small routines + final seal extracted from the FULL byte/hash
// verified22b stream. No catalogue/observed descriptor seeds expectations.
const bundle=JSON.parse(gunzipSync(Buffer.from('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','base64'),{maxOutputLength:131072}).toString('utf8'));
const copy=v=>structuredClone(v),sha=s=>createHash('sha256').update(s).digest('hex');
const source31Layer=deriveOrderSplit210Layer({sourceBundle:bundle});
const freshFixture=/const before=JSON\.parse\(gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:32768\}\)/.exec(readFileSync(new URL('./order-split210-metadata-fresh-map.test.mjs',import.meta.url),'utf8'));assert(freshFixture);
const source28Metadata=JSON.parse(gunzipSync(Buffer.from(freshFixture[1],'base64'),{maxOutputLength:32768})),freshMap=deriveOrderSplit210MetadataFreshMap(source28Metadata.source);
const source28=c=>c.key==='public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)'?source28Metadata.source:c.after.source;
// Preserve the complete Source30/29 witnesses below AFTER a source-bound31 inverse.
const layerComposite=deriveOrderSplit210MetadataComposite(freshMap.source,source31Layer.changes[0].after.source);
const historicalLayer=copy(source31Layer),metadata31=historicalLayer.changes.find(c=>c.key==='public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)');
assert.equal(metadata31.after.source,layerComposite.source);assert.equal(metadata31.after.definition,layerComposite.definition);
let restoredMetadata=metadata31.after.source;for(const edit of [...layerComposite.edits].reverse()){assert.equal(restoredMetadata.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);restoredMetadata=restoredMetadata.slice(0,edit.afterStart)+edit.before+restoredMetadata.slice(edit.afterStart+edit.after.length);}
assert.equal(restoredMetadata,freshMap.source);metadata31.after={...metadata31.after,source:restoredMetadata,definition:freshMap.definition};delete historicalLayer.source_proofs.metadataComposite209;
const freezeHistorical=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeHistorical(child);Object.freeze(value);}return value;};
const result=freezeHistorical(historicalLayer);


const headers=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));
const liveProjection="live:=public.order_split210_project209_record(jsonb_build_object('kind','function','key',actual_key,'value',live))->'value';";
const snapshotKeys=[...P.routines.map(r=>r.key),'public.buyer_address_guards()','public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)','public.order_merge_delivery209_buyer_guards(manual_basis jsonb)','public.order_merge_delivery209_startup_operative_valid(entries jsonb)'];
const snapshotKeySql='ARRAY['+snapshotKeys.map(key=>"'"+key+"'").join(',')+']::text[]';
const snapshotProjection=alias=>`CASE WHEN ${alias}.record->>'kind' IS DISTINCT FROM 'function' OR NOT(${alias}.record->>'key'=ANY(${snapshotKeySql})) THEN ${alias}.record
 WHEN ${alias}.record IS NOT DISTINCT FROM snapshot210_binding.after_record THEN snapshot210_binding.before_record
 ELSE public.order_split210_project209_record(${alias}.record) END`;
const snapshotJoin=alias=>' LEFT JOIN split210_snapshot_map snapshot210_binding ON snapshot210_binding.split210_key='+alias+".record->>'key'";
const legacyConsumer=" FROM(SELECT jsonb_build_object('kind',kind,'key',key,'value',value) AS record FROM legacy209_current) raw_legacy209"+snapshotJoin('raw_legacy209')+' CROSS JOIN LATERAL jsonb_to_record('+snapshotProjection('raw_legacy209')+') AS legacy209(kind text,key text,value jsonb)';
const snapshotInner=source=>{
 const begin=' SELECT split210_snapshot_result.snapshot FROM(',end='\n ) split210_snapshot_result\n';
 assert(source.endsWith(end));assert.equal(source.split(begin).length-1,1);
 return source.slice(source.indexOf(begin)+begin.length,-end.length);
};
function undoLiveComposition(source){
 return source.replace('  '+liveProjection+'\n','').replace(' '+liveProjection+'\n','');
}

test('Source31 composite is the sole changed AFTER; complete source/header inverse restores historical Source30 first',()=>{
 assert.equal(source31Layer.changes.length,10);assert.deepEqual(source31Layer.source_proofs.metadataComposite209,layerComposite.source_proofs);
 for(let i=0;i<10;i++){assert.deepEqual(source31Layer.changes[i].before,result.changes[i].before);if(source31Layer.changes[i].key!==metadata31.key)assert.deepEqual(source31Layer.changes[i].after,result.changes[i].after);}
 const current=source31Layer.changes.find(c=>c.key===metadata31.key);assert.equal(Buffer.byteLength(current.after.source),28068);assert.equal(sha(current.after.source),'d3d059467f193f5334f1fc35d6469f120445251cbf9aedfa15c9045793b14c00');assert.equal(sha(current.after.definition),'00e5a1912773134c953342c96cfabc3a9f1a74c653f78ec3cf678f5de5c8a672');
 assert.deepEqual(headers(current.after),headers(metadata31.after));assert.equal(source31Layer.changes[0].after.source,result.changes[0].after.source,'standalone snapshot literal unchanged');
 assert.equal(sha(metadata31.after.source),'cfad1ebdc47ddd2f3c72b058a1736dd4767a244d7ea4c22f51c3a1a655f4499e');
});

test('accepted parent provenance and complete24-field shape are independent of caller readiness flags',()=>{
 assert.equal(P.source_contract_sha256,'121abfe5df79f03f9d3acd38e566bbcf53c18ec0b4bf418c316632138cd37070');
 assert.equal(P.native_receipt_sha256,'9942cd0f31631af320c535b424a0c41ee7a3ad912faba64a964b44da8d0f5989');
 assert.equal(P.native_review_sha256,'c3083fdf081056ef7085cae2423ecfa7233d37722769a9dfe32b37e2326737c1');
 assert.equal(P.legacy_function_count,17);assert.equal(P.source_addition_count,259);
 const fields='owner language kind cost rows security_definer leakproof strict returns_set volatility parallel support variadic argument_names argument_modes arguments result defaults source binary config definition acl_null acl'.split(' ').sort();
 for(const c of result.changes){assert.deepEqual(Object.keys(c.before).sort(),fields);assert.deepEqual(Object.keys(c.after).sort(),fields);}
});

test('all ten full predecessors come from exact accepted22b headers/source and complete private ACL seal',()=>{
 assert.equal(bundle.source_sha256,'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a');
 assert.equal(bundle.source_bytes,28449419);assert.equal(result.changes.length,10);
 assert.equal(sha(bundle.seal),'2811b1d9f543a411ea56af236b1772b69d4ab53fcadda38bda1e9dd673fb803f');
 for(const c of result.changes){
  const spec=P.routines.find(r=>r.key===c.key),raw=bundle.routines.find(r=>r.startsWith('CREATE FUNCTION '+c.key.replaceAll(', ',',')))??bundle.routines.find(r=>r.startsWith('CREATE FUNCTION '+c.key));
  assert(spec&&raw);assert.equal(sha(raw),spec.sql_sha256);assert(raw.includes(c.before.source));
  assert.equal(c.before.result,spec.result);assert.equal(c.before.language,spec.language);
  assert.equal(c.before.owner,'postgres');assert.equal(c.before.security_definer,true);assert.equal(c.before.volatility,'s');
  assert.equal(c.before.strict,false);assert.equal(c.before.parallel,'u');assert.equal(c.before.leakproof,false);
  assert.equal(c.before.cost,100);assert.equal(c.before.rows,0);assert.equal(c.before.defaults,null);
  assert.deepEqual(c.before.argument_names,spec.args?spec.args.split(', ').map(a=>a.split(' ')[0]):null);
  assert.equal(c.before.arguments,spec.args);assert.equal(c.before.argument_modes,null);
  assert.equal(c.before.acl_null,false);assert.deepEqual(c.before.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
  assert.deepEqual(c.before.config,['search_path=pg_catalog, public']);
  assert(c.before.definition.startsWith('CREATE OR REPLACE FUNCTION '+spec.key+'\n RETURNS '+spec.result+'\n LANGUAGE '+spec.language+'\n STABLE SECURITY DEFINER\n'));
  assert.deepEqual(headers(c.before),headers(c.after),'no header/owner/type/config/ACL change');
 }
});

test('nine narrow override paths and scoped live composition preserve every old209 byte',()=>{
 for(const c of result.changes.slice(1)){
  const source=source28(c);assert.equal(source.split('DECLARE split210_projection jsonb;').length-1,1);
  assert(!source.includes('order_split210_require('),'outside four business names does not acquire full210admission on190reads');
  const begin=source.indexOf('BEGIN'),start=source.indexOf('\n split210_projection:=',begin);
  assert.equal(start,begin+'BEGIN'.length,'branch is inside actual outer body, not quoted old SQL');
  const finish=source.indexOf('END IF;\n',start)+'END IF;\n'.length;assert(finish>start);
  const branch=source.slice(start,finish);
  assert.equal(branch.split('try_').length-1,1);assert(branch.includes('IF split210_projection IS NOT NULL'));
  if(c.key.includes('predecessor_metadata(')){
   assert(branch.includes('try_metadata_projection(value)'));
   assert(branch.includes('value:=split210_projection;result:=value::text;'));
   assert(source.indexOf('result text:=value::text')<begin,'original initializer remains before BEGIN');
  }else{
   assert(branch.includes('try_function_projection(fn)'));
   assert(branch.includes('RETURN '+(c.key.includes('predecessor_descriptor(')?'split210_projection':c.key.includes('predecessor_source_sha(')?"encode(sha256(convert_to(split210_projection->>'source','UTF8')),'hex')":"split210_projection->>'"+(c.key.includes('predecessor_source(')?'source':'definition')+"'")));
  }
  const old=undoLiveComposition(source.slice(0,start)+source.slice(finish)).replace('DECLARE split210_projection jsonb;','DECLARE ');
  assert.equal(old,c.before.source,'exact old declarations/body/quotes/gates unchanged after removing only the new branch');
 }
});

test('validation snapshot authenticates one source DATA map and three complete consumers with whole-query inverse',()=>{
 const c=result.changes[0],before=c.before.source,after=c.after.source;
 const require='\n SELECT public.order_split210_require();';assert(after.startsWith(require));
 assert.equal(after.split('order_split210_require()').length-1,1,'one actual entry guard before any source map/current rows');
 assert.equal(after.split('split210_snapshot_map(split210_key,after_record,before_record) AS MATERIALIZED').length-1,1);
 assert.equal(after.split('FROM public.order_split210_projection_basis basis210').length-1,1,'one authenticated immutable source DATA read');
 assert(after.includes("jsonb_array_elements(basis210.payload_jsonb->'changes')"));
 assert(after.includes("WHERE basis210.id AND change->>'key'=ANY("+snapshotKeySql+')'));
 assert.equal(snapshotKeys.length,14);assert.equal(new Set(snapshotKeys).size,14);
 assert(!after.includes('7a9ab1f2d70f7da30e988b6f0db7f388205d5963dc998d1a4fb4be42c1a8425b'),'no embedded current/self descriptor digest');
 const inner=snapshotInner(after),unwrap=' FROM(SELECT '+snapshotProjection('raw209')+' AS record FROM(';
 const a=inner.indexOf(unwrap),b=inner.indexOf(') raw209'+snapshotJoin('raw209')+') own209',a);
 assert(a>=0&&b>a);const query=inner.slice(a+unwrap.length,b);
 assert(query.includes("'source',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))"));
 assert(query.includes("'definition',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'))"));
 assert(query.includes("SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries"));
 const restored=inner.slice(0,a)+' FROM('+query+inner.slice(b+(') raw209'+snapshotJoin('raw209')).length);
 assert.equal(restored.split(legacyConsumer).length-1,2);
 let inverse=restored.replace(legacyConsumer,' FROM legacy209_current legacy209(kind,key,value)');
 inverse=inverse.replace(legacyConsumer,' FROM legacy209_current');
 assert.equal(inverse,before,'all original producer/query fields/arms/header/ACL/checks survive byte-for-byte');
 assert.equal(after.split('project209_record(').length-1,3,'strict original projector retained at every mismatch fallback');
 assert.equal(after.split('IS NOT DISTINCT FROM snapshot210_binding.after_record').length-1,3,'each consumer compares the entire tagged record');
 assert.equal(after.split('LEFT JOIN split210_snapshot_map snapshot210_binding').length-1,3);
 // The original legacy arms use unqualified kind/key/value. A joined map key
 // must never shadow those names (real CREATE FUNCTION regression C10/42702).
 const mapColumns=/split210_snapshot_map\(([^)]+)\) AS MATERIALIZED/.exec(after)[1].split(',');
 assert(mapColumns.every(name=>!['kind','key','value'].includes(name)),'joined source map cannot introduce ambiguous legacy columns');
 assert(!after.includes('snapshot210_binding.key='));
 assert(!after.includes('order_merge_delivery209_valid('),'does not recursively call its own validator');
});

// Controlled semantics for the exact SQL CASE extracted above. This is not PG
// execution or a source/current authority: the entry guard is tested separately.
function controlledSnapshotConsumer(record,map,strict){
 const source=snapshotInner(result.changes[0].after.source),start=source.indexOf('CASE WHEN raw209.record'),end=source.indexOf(' END',start)+4;
 assert.equal(source.slice(start,end),snapshotProjection('raw209'),'whole generated CASE, no partial-condition model');
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 if(record?.kind!=='function'||(typeof record.key==='string'&&!snapshotKeys.includes(record.key)))return record;
 const binding=map.find(row=>row.key===record.key);
 return binding&&equal(record,binding.after_record)?binding.before_record:strict(record);
}
test('snapshot exact full24 mapping refuses mixed headers/ACL/leaves/missing map while unknown identity stays literal',()=>{
 const c=result.changes[1],tag=v=>({...copy(v),source:['sha256-utf8-text/v1',sha(v.source)],definition:['sha256-utf8-text/v1',sha(v.definition)]});
 const after={kind:'function',key:c.key,value:tag(c.after)},before={kind:'function',key:c.key,value:tag(c.before)};
 const map=[{key:c.key,after_record:after,before_record:before}];let calls=0;
 const strict=()=>{calls++;throw new Error('strict current source rejection');};
 assert.deepEqual(controlledSnapshotConsumer(copy(after),map,strict),before);assert.equal(calls,0);
 const reordered={value:Object.fromEntries(Object.entries(after.value).reverse()),key:after.key,kind:after.kind};
 assert.deepEqual(controlledSnapshotConsumer(reordered,map,strict),before,'jsonb equality ignores member order');
 for(const field of Object.keys(after.value)){
  const poisoned=copy(after);poisoned.value[field]=field==='source'||field==='definition'?['sha256-utf8-text/v1','0'.repeat(64)]:{poison:true};
  assert.throws(()=>controlledSnapshotConsumer(poisoned,map,strict));
 }
 for(const change of [r=>delete r.value.acl,r=>r.value.extra=true,r=>r.value.source=c.after.source,r=>r.value.definition=before.value.definition]){
  const poisoned=copy(after);change(poisoned);assert.throws(()=>controlledSnapshotConsumer(poisoned,map,strict));
 }
 assert.throws(()=>controlledSnapshotConsumer(after,[],strict),'unknown/missing scoped binding never supplies BEFORE');
 const ordinary={kind:'function',key:'public.unrelated_source()',value:{arbitrary:'preserved'}};
 assert.equal(controlledSnapshotConsumer(ordinary,map,strict),ordinary);
 const overload={...copy(after),key:c.key.replace('fn oid','fn text')};
 assert.equal(controlledSnapshotConsumer(overload,map,strict),overload,'original global projector identity retained for an unlisted signature; fresh entry require must reject actual overload first');
 assert(result.changes[0].after.source.startsWith('\n SELECT public.order_split210_require();'),'overload/partial/current source check remains before the fast CASE');
 assert(calls>=29);
});

test('all three own209 successors use whole-record snapshot bindings without joining legacy17',()=>{
 const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8');
 const ownChanges=[deriveOrderSplit210HistoryOperativeSuccessor({source210}).change,deriveOrderSplit210HistoryBuyerSuccessor({source210}).change,deriveOrderSplit210StartupOperativeSuccessor({source210}).change];
 assert.deepEqual(snapshotKeys.slice(11),ownChanges.map(c=>c.key));
 for(const c of ownChanges){
 const tag=value=>({...copy(value),source:['sha256-utf8-text/v1',sha(value.source)],definition:['sha256-utf8-text/v1',sha(value.definition)]});
 const after={kind:'function',key:c.key,value:tag(c.after)},before={kind:'function',key:c.key,value:tag(c.before)};
 const map=[{key:c.key,after_record:after,before_record:before}];
 const strict=()=>{throw Error('strict current source rejection');};
 assert.deepEqual(controlledSnapshotConsumer(after,map,strict),before);
 for(const field of Object.keys(after.value)){
  const bad=copy(after);bad.value[field]={poison:true};assert.throws(()=>controlledSnapshotConsumer(bad,map,strict),/strict current source/);
 }
 assert.throws(()=>controlledSnapshotConsumer(after,[],strict),/strict current source/);
 const old=copy(after);old.value.source=before.value.source;assert.throws(()=>controlledSnapshotConsumer(old,map,strict),/strict current source/);
 const overload={...copy(after),key:c.key.replace('jsonb','text')};assert.strictEqual(controlledSnapshotConsumer(overload,map,strict),overload);
 assert(!result.changes[0].before.source.match(/p\.proname=ANY\(ARRAY\[[^\]]*history_operative_valid/),'original independent legacy17 producer excludes own209 function');
 }
});

test('snapshot retains the independent full17 MATERIALIZED producer byte-for-byte',()=>{
 const c=result.changes[0];assert.equal(c.key,'public.order_merge_delivery209_validation_snapshot()');
 const names=['buyer_address_preview_guard','buyer_address_state_guard','buyer_address_guards','buyer_address_fingerprint','manual_inventory_off_valid','manual_inventory_off_projection_valid','partial_sale204_predecessor_definition','ordinary187_valid','partial_sale204_valid','catalog_header205_valid','pim_dictionary_valid','nested172_valid','parcel_physical_wz_valid','operative_delivery_valid','wave_print177_valid','cooperation171_valid','packed_label_print_guards'];
 const roster=s=>s.match(/p\.proname=ANY\(ARRAY\[([^\]]+)\]/)[1].split(',').map(v=>v.slice(1,-1));
 assert.deepEqual(roster(c.before.source),names);assert.deepEqual(roster(c.after.source),names);
 const start=c.before.source.indexOf('WITH legacy209_current'),end=c.before.source.indexOf('SELECT jsonb_build_object(\n');assert(start>=0&&end>start);
 assert(c.after.source.includes(c.before.source.slice(start,end)),'entire canonical complete24/SHA MATERIALIZED producer remains literal');
 assert.equal(c.after.source.split('legacy209_current').length-1,3,'one MATERIALIZED producer and two consumers retained');
 assert(!result.changes.some(c=>c.key==='public.order_merge_delivery209_fingerprint()'),'fingerprint wrapper remains the accepted parent byte sequence');
});

test('new SHA port projects the actual complete source before hashing, preserving the complete original fallback',()=>{
 const c=result.changes.find(c=>c.key==='public.order_merge_delivery209_predecessor_source_sha(fn oid, entries jsonb)');assert(c);
 assert(c.after.source.includes("RETURN encode(sha256(convert_to(split210_projection->>'source','UTF8')),'hex');"));
 assert.equal(c.after.source.split('order_split210_try_function_projection(fn)').length-1,1);
 assert(!c.after.source.includes('split210_projection->>\'definition\''),'source SHA must not hash a deparser definition');
 const start=c.after.source.indexOf('\n split210_projection:='),end=c.after.source.indexOf('END IF;\n',start)+'END IF;\n'.length;
 assert.equal(undoLiveComposition(c.after.source.slice(0,start)+c.after.source.slice(end)).replace('DECLARE split210_projection jsonb;','DECLARE '),c.before.source,'full selected CURRENT24/frame/overload refusal and outside behavior unchanged');
});

test('all five historical Source28 scoped CURRENT comparisons project the whole tagged live record before unchanged parent checks',()=>{
 const keys=['predecessor_descriptor(fn oid)','predecessor_descriptor(fn oid, entries jsonb)','predecessor_source_sha(fn oid, entries jsonb)','predecessor_metadata(value jsonb)','predecessor_metadata(value jsonb, entries jsonb)'];
 for(const key of keys){
  const c=result.changes.find(c=>c.key===('public.order_merge_delivery209_'+key));assert(c);
  const source=source28(c),at=source.indexOf(liveProjection);
  assert(at>0);assert.equal(source.split(liveProjection).length-1,1);
  const predicate=(key==='predecessor_descriptor(fn oid)'||key.startsWith('predecessor_metadata('))
   ?"IF actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'"
   :"IF total<>1 OR entry IS NULL OR entry->>'key' IS DISTINCT FROM actual_key OR live IS DISTINCT FROM entry->'after_check'";
  assert.equal(source.slice(at+liveProjection.length).trimStart().slice(0,predicate.length),predicate);
  for(const leaf of ['source','definition']){
   const tagged=source.indexOf("'"+leaf+"',jsonb_build_array('sha256-utf8-text/v1'",source.indexOf('IF scoped'));
   assert(tagged>=0&&tagged<at,'current complete tagged '+leaf+' was read first');
  }
  assert(source.includes("jsonb_array_length(entries)<>17"));
  assert(source.includes("payload_bytes IS DISTINCT FROM 21756960 OR payload_hash IS DISTINCT FROM 'ed45aecdcf4d959c7ff636cd315a12162316f030cb1e382e7e82e5ed6eb4a2d4'"));
  const original=c.before.source;
  assert.deepEqual(headers(c.after),headers(c.before));
  const identityStart=original.indexOf('IF scoped IS DISTINCT FROM true THEN');
  if(identityStart>=0){
   const identityEnd=original.indexOf(' END IF;',identityStart)+' END IF;'.length;
   assert(source.includes(original.slice(identityStart,identityEnd)),'unscoped raw full identity body remains literal');
  }
 }
 assert.equal(result.changes.filter(c=>source28(c).includes(liveProjection)).length,5);
});

test('buyer never gains a direct early return and every definition/source path still calls the composed descriptor',()=>{
 for(const c of result.changes.slice(1)){
  const begin=c.after.source.indexOf('BEGIN'),branchEnd=c.after.source.indexOf('END IF;\n',begin)+'END IF;\n'.length;
  const branch=c.after.source.slice(begin,branchEnd);
  assert(!branch.includes('buyer_address_guards'),'four-business scope belongs to the strict existing private port, no buyer bypass');
  if(c.key.includes('predecessor_definition(')||c.key.includes('predecessor_source(')){
   assert(c.after.source.slice(branchEnd).includes('public.order_merge_delivery209_predecessor_descriptor(fn'));
  }
 }
 // The reader pins the complete mixed descriptor, including source and both
 // header/ACL fields. Neither a genuine source with a changed ACL/header nor
 // a caller-provided replacement row can become an accepted source bundle.
 for(const mutate of [
  b=>b.routines[1]=b.routines[1].replace('RETURNS jsonb LANGUAGE plpgsql','RETURNS text LANGUAGE plpgsql'),
  b=>b.routines[1]=b.routines[1].replace('SECURITY DEFINER SET','SECURITY DEFINER LEAKPROOF SET'),
  b=>b.seal=b.seal.replace('p.proacl acl','NULL::aclitem[] acl'),
 ]){const mixed=copy(bundle);mutate(mixed);assert.throws(()=>deriveOrderSplit210Layer({sourceBundle:mixed}));}
});

test('missing/extra/duplicate routine, changed source/header/args/config/ACL seal and forged parent all refuse',()=>{
 for(const mutate of [
  b=>b.routines.pop(),b=>b.routines.push(b.routines[0]),b=>b.routines[8]=b.routines[7],
  b=>b.routines[1]=b.routines[1].replace('fn oid','fn text'),
  b=>b.routines[1]=b.routines[1].replace('SECURITY DEFINER','SECURITY INVOKER'),
  b=>b.routines[1]=b.routines[1].replace('STABLE','VOLATILE'),
  b=>b.routines[1]=b.routines[1].replace('search_path=pg_catalog,public','search_path=public,pg_catalog'),
  b=>b.routines[1]=b.routines[1]+'-- drift\n',
  b=>b.seal=b.seal.replace('REVOKE ALL','GRANT ALL'),b=>b.source_sha256='0'.repeat(64),b=>b.source_bytes++,
 ]){const input=copy(bundle);mutate(input);assert.throws(()=>deriveOrderSplit210Layer({sourceBundle:input}));}
});

test('byte/hash source reader never promotes a partial/changed source fragment to the pinned parent',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'split210-layer-source-'));const file=path.join(dir,'fragment.sql');
 try{
  // Long unselected DATA is skipped in bounded chunks; no complete generated
  // program or fake parent fixture is fabricated to produce a success.
  await writeFile(file,'INSERT INTO hypothetical VALUES (\''+'x'.repeat(131072)+'\');\n'+bundle.routines.join('')+bundle.seal,{mode:0o600});
  await assert.rejects(readOrderSplit210LayerSource({sourcePath:file}));
 }finally{await rm(dir,{recursive:true});}
});

test('all unresolved native projection/closure contracts stay explicit; no empty READY or helper implementation',()=>{
 assert.equal(result.required_private_ports.length,4);
 const fn=result.required_private_ports.find(p=>p.key.includes('try_function_projection'));
 assert(fn.contract.includes('four business routines'));assert(fn.contract.includes('matching name/overload'));assert(fn.contract.includes('full current AFTER'));
 const metadata=result.required_private_ports.find(p=>p.key.includes('try_metadata_projection'));
 assert(metadata.contract.includes('four full target metadata'));assert(metadata.contract.includes('no substring/prefix normalization'));
 const fp=result.required_private_ports.find(p=>p.key.includes('project209_record'));
 assert(fp.contract.includes('whole current tagged-leaf canonical record'));assert(fp.contract.includes('exactly ten'));assert(fp.contract.includes('legacy buyer successor'));assert(fp.contract.includes('all17 current producer'));
 const require=result.required_private_ports.find(p=>p.key==='public.order_split210_require()');assert(require.contract.includes('NEVER executes209_valid/fingerprint'));
 for(const flag of ['source_compilation_performed','full_before_descriptors_compiler_verified','private_ports_implemented','complete_fourteen_change_closure','native_certification','application_activation'])assert.equal(result[flag],false);
 assert.equal(P.source_native_acceptance,true);assert(!('sql' in result));
 assert(Object.isFrozen(result.changes[0].after.acl));assert.throws(()=>{result.changes[0].after.acl[0].grantee='PUBLIC';});
});

test('Source29 only two-argument metadata AFTER uses an independently authenticated fresh snapshot, retaining full header and Source28 inverse',()=>{
 const key='public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)',c=result.changes.find(c=>c.key===key);
 assert.equal(c.after.source,freshMap.source);assert.equal(c.after.definition,freshMap.definition);
 assert.deepEqual(headers(c.after),headers(source28Metadata));
 let inverse=c.after.source;for(const e of [...freshMap.edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}
 assert.equal(inverse,source28Metadata.source);assert.deepEqual(result.source_proofs.metadataFreshMap209,freshMap.source_proofs);
 assert.equal((c.after.source.match(/public\.order_merge_delivery209_validation_snapshot\(\)/g)||[]).length,1);
 assert(c.after.source.indexOf('jsonb_to_recordset(entries)')<c.after.source.indexOf('PERFORM public.order_split210_require()'));
 assert(c.after.source.indexOf('PERFORM public.order_split210_require()')<c.after.source.indexOf('public.order_merge_delivery209_validation_snapshot()'));
 assert(!c.after.source.includes('public.order_merge_delivery209_checked_projection_map()'));
 assert(c.after.source.includes('split210_manifest.fingerprint IS DISTINCT FROM(split210_fresh_snapshot'));
 assert(c.after.source.includes("IF actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'"));
 assert.equal(result.changes.filter(c=>c.after.source.includes('split210_caller_frame')).length,1);
 assert.equal(result.changes.length,10);assert.equal(freshMap.new_runtime_functions,0);assert.equal(freshMap.cross_invocation_cache,false);
});
