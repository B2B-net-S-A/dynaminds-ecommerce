import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {PACKING204_SOURCE_CONTRACT as E204} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
import {deriveOrderMergeDelivery209WaveClosure} from '../tools/parity/order-merge-delivery209-wave-closure.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS as KEYS,ORDER_MERGE_DELIVERY209_STARTUP_SOURCE as PINS,
 deriveOrderMergeDelivery209StartupClosure as derive,projectOrderMergeDelivery209StartupMetadata as metadata,
 projectOrderMergeDelivery209StartupWave as wave,projectOrderMergeDelivery209StartupOperative as operative,
} from '../tools/parity/order-merge-delivery209-startup-capability-closure.mjs';

const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
const result=derive({source204}),sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const executable=s=>spans(s).map(x=>x.executable?x.text:x.text.replace(/[^\n]/g,' ')).join('');
const historical=key=>E204.changes.find(c=>c.key===key).after;
const publicWave=historical('public.wave_print177_valid()').source;
const mask=source=>spans(source).map(x=>x.executable?x.text:x.text.replace(/[^\n]/g,' ')).join('');
const mutateExecutable=(source,before,after)=>{let changed=false;return spans(source).map(s=>{
 if(!s.executable||changed||!s.text.includes(before))return s.text;changed=true;return s.text.replace(before,after);
}).join('');};

// Independent inverse: recognize outer wrappers, balance their full call tree,
// then remove only the final frame argument. It does not import producer edits.
function removeMetadataWrappers(source){
 const masked=mask(source),needle='public.order_merge_delivery209_predecessor_metadata(',edits=[];
 for(let start=masked.indexOf(needle);start>=0;start=masked.indexOf(needle,start+needle.length)){
  const argStart=start+needle.length;let depth=1,end=argStart;
  while(depth&&end<masked.length){if(masked[end]==='(')depth++;else if(masked[end]===')')depth--;end++;}
  assert.equal(depth,0);const contents=source.slice(argStart,end-1),tail=', merge_delivery209_local_frame';
  assert(contents.endsWith(tail));edits.push({start,end,original:contents.slice(0,-tail.length)});
 }
 let restored=source;for(const e of edits.reverse())restored=restored.slice(0,e.start)+e.original+restored.slice(e.end);return restored;
}

test('seven complete BEFORE records come from independent E204 and match literal authored full definitions',()=>{
 assert.equal(sha(source204),PINS.source204_sha256);
 assert.deepEqual(result.historical_predecessors.map(r=>r.key),KEYS);assert.equal(KEYS.length,7);
 for(const r of result.historical_predecessors){
  const c=E204.changes.filter(c=>c.key===r.key);assert.equal(c.length,1);
  assert.deepEqual(r,{kind:c[0].kind,key:c[0].key,value:c[0].after});assert.equal(Object.keys(r.value).length,24);
  assert(source204.includes(r.value.definition.trimEnd()+';'));
 }
 const clone=result.historical_operative_predecessor;
 assert.deepEqual(clone,{kind:'function',key:PINS.operative_before_key,value:historical(PINS.operative_before_key)});
 assert.equal(sha(JSON.stringify(canonical(clone))),PINS.operative_before_record_sha256);
});

test('the complete literal wave-SHA caller roster includes cooperative and packed guards, not warehouse issuer',()=>{
 // Separate executable scan of every E204 changed function, not the producer's list.
 const users=[];
 for(const c of E204.changes.filter(c=>c.kind==='function')){
  const s=c.after.source,m=mask(s).split('\n'),lines=s.split('\n');
  if(m.some((l,i)=>/\bprosrc\b/.test(l)&&lines[i].includes("to_regprocedure('public.wave_print177_valid()')")))users.push(c.key);
 }
 assert.deepEqual(users.sort(),[...KEYS.filter(k=>k!=='public.wave_print177_valid()'),'public.ordinary187_valid()'].sort());
 assert(!users.includes('public.warehouse_wz_issuer_guards()'));
 for(const key of ['public.cooperation171_valid()','public.packed_label_print_guards()']){
  const c=result.changes.find(c=>c.key===key);assert(c);assert(executable(c.before.source).includes('public.wave_print177_valid()'));
 }
 const source168=readFileSync(new URL('../server/168_physical_parcel_wz.sql',import.meta.url),'utf8');
 assert(source168.includes('RETURN expected IS NOT NULL AND public.parcel_physical_wz_valid();'));
});

test('private operative body changes only the exact buyer251 CHECK arm and keeps the original terminal/cert checks',()=>{
 const h=result.helpers[0],before=result.historical_operative_predecessor.value.source;
 assert.equal(h.key,'public.order_merge_delivery209_startup_operative_valid(entries jsonb)');
 const old='pg_get_constraintdef(c.oid,true)',next='public.order_merge_delivery209_constraint_definition(c.oid)';
 assert.equal(executable(h.value.source).split(next).length-1,1);
 const inverse=spans(h.value.source).map(s=>s.executable?s.text.replace(next,old):s.text).join('');
 assert.equal(inverse,before);assert.deepEqual(spans(h.value.source).filter(s=>!s.executable),spans(before).filter(s=>!s.executable));
 assert.equal((executable(h.value.source).match(/pg_get_constraintdef\(k\.oid,true\)/g)||[]).length,4);
 assert(h.value.source.includes("cert.original166_manifest->>'fingerprint' IS DISTINCT FROM buyer_fp251"));
 assert(h.value.source.includes('EXCEPTION')===before.includes('EXCEPTION'));
 assert.equal(sha(JSON.stringify(canonical(h))),'f5082d2bae4acef908387ed1b425a490738d64cd78cc7490d4a2157abe0a7e24');
});

test('helper header is source-derived with only new identity/argument; public header/ACL fields remain exact',()=>{
 for(const c of result.changes){
  for(const field of Object.keys(c.before).filter(k=>!['source','definition'].includes(k)))assert.deepEqual(c.after[field],c.before[field],c.key+' '+field);
  assert.equal(c.after.definition.replace(c.after.source,'<SOURCE>'),c.before.definition.replace(c.before.source,'<SOURCE>'));
 }
 for(const name of ['wave_print177_valid','operative_delivery_valid'])assert(result.changes.find(c=>c.key==='public.'+name+'()').after.acl.some(a=>a.grantee==='dyna_app'));
 const h=result.helpers[0].value,b=result.historical_operative_predecessor.value;
 for(const field of Object.keys(b).filter(k=>!['source','definition','arguments','argument_names'].includes(k)))assert.deepEqual(h[field],b[field],field);
 assert.deepEqual(h.argument_names,['entries']);assert.equal(h.arguments,'entries jsonb');assert(h.acl.every(a=>a.grantee==='postgres'));
 assert(result.sql.endsWith('REVOKE ALL ON FUNCTION public.order_merge_delivery209_startup_operative_valid(jsonb) FROM PUBLIC,dyna_app;\n'));
 assert(!/\bGRANT\b/.test(result.sql));
});

test('targeted wave metadata and one operative redirect reverse to every original byte including nested historical quotes',()=>{
 const after=result.changes.find(c=>c.key==='public.wave_print177_valid()').after.source;
 let restored=removeMetadataWrappers(after);
 restored=spans(restored).map(s=>s.executable?s.text.replace('public.order_merge_delivery209_startup_operative_valid(merge_delivery209_local_frame)','public.wave_print177_history_operative_delivery_valid()'):s.text).join('');
 assert.equal(restored,publicWave);
 assert.deepEqual(spans(after).filter(s=>!s.executable),spans(publicWave).filter(s=>!s.executable));
 const beforeReturns=executable(publicWave).match(/\bRETURN\s+false;/g)?.length;
 assert.equal(executable(after).match(/\bRETURN\s+false;/g)?.length,beforeReturns);
 assert(after.includes('RETURN public.wave_print177_history_nested172_valid() IS TRUE AND public.order_merge_delivery209_startup_operative_valid(merge_delivery209_local_frame) IS TRUE;'));
 assert(after.includes('EXCEPTION WHEN OTHERS THEN RETURN false;'));
});

test('the other six roots retain their original predicates/dynamic dispatch until the mandatory generic parent stage',()=>{
 for(const c of result.changes.filter(c=>c.key!=='public.wave_print177_valid()'))assert.deepEqual(c.after,c.before);
 const pim=result.changes.find(c=>c.key==='public.pim_dictionary_valid()').after.source;
 assert.equal((executable(pim).match(/\bEXECUTE\s+format/g)||[]).length,4);
 assert(pim.includes("FOR guard_name IN SELECT key FROM jsonb_object_keys(public.pim_dictionary_predecessor_metadata()) keys(key) ORDER BY key LOOP EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;IF guard_ok IS DISTINCT FROM true THEN RETURN false;END IF;END LOOP;"));
 assert.equal(result.parent_stage.preprojection_only,true);assert.equal(result.parent_stage.required_final_scope,17);
 for(const field of ['generic_live_source_and_definition_projection','entry_checked_frame_injection','source_hash_projection','final_after_authentication_before_data'])assert.equal(result.parent_stage[field],true);
});

test('metadata wrapping follows complete balanced calls and does not touch literal/comment decoys or Unicode offsets',()=>{
 const prefix="-- π😀 decoy public.pim_dictionary_function_metadata(x)\n",modified=prefix+publicWave;
 const projected=metadata(modified);assert.equal(removeMetadataWrappers(projected.source),modified);
 assert(projected.source.startsWith(prefix));
 const strings=spans(projected.source).filter(s=>!s.executable);assert.deepEqual(strings,spans(modified).filter(s=>!s.executable));
 const c=metadata(publicWave).counts;assert.deepEqual(c,{pim_dictionary_function_metadata:11,wave_print177_metadata:1,wave_print177_packed_metadata:2,wave_print177_operative_metadata:2});
 assert.equal(executable(projected.source).split('public.order_merge_delivery209_predecessor_metadata(').length-1,16);
 // Nested to_regprocedure('public.'||sig) must remain wholly within one wrapper.
 assert(projected.source.includes("public.order_merge_delivery209_predecessor_metadata(public.pim_dictionary_function_metadata(to_regprocedure('public.'||sig)), merge_delivery209_local_frame)"));
});

test('the same source-only metadata stage applies to the existing own209 wave without rewriting its operative edge',()=>{
 const current=deriveOrderMergeDelivery209WaveClosure({source204}).helpers[1].value.source;
 const projected=metadata(current);assert.equal(removeMetadataWrappers(projected.source),current);
 assert(projected.source.includes('public.order_merge_delivery209_history_operative_valid(manual_basis)'));
 assert(!projected.source.includes('public.order_merge_delivery209_startup_operative_valid('));
 assert.equal(result.existing_helper_projection.requires_fresh_entry_frame_injection,true);
 assert.equal(result.existing_helper_projection.requires_generic_live_source_projection,true);
});

test('missing/extra metadata producers, duplicate terminal, malformed parentheses and unsafe identifier fail closed',()=>{
 assert.throws(()=>metadata(mutateExecutable(publicWave,'public.wave_print177_metadata()','public.unknown_metadata()')),/sixteen/);
 assert.throws(()=>metadata(publicWave+'\nPERFORM public.wave_print177_metadata();'),/sixteen/);
 assert.throws(()=>metadata(publicWave,{frameName:'x); SELECT true;--'}),/identifier/);
 assert.throws(()=>metadata(mutateExecutable(publicWave,'public.wave_print177_metadata()','public.wave_print177_metadata(')),/complete live metadata call/);
 assert.throws(()=>wave(mutateExecutable(publicWave,'public.wave_print177_history_operative_delivery_valid()','public.unknown_operative()')),/one actual/);
 assert.throws(()=>wave(publicWave+'\nPERFORM public.wave_print177_history_operative_delivery_valid();'),/one actual/);
 assert.throws(()=>operative(result.historical_operative_predecessor.value.source.replaceAll('pg_get_constraintdef(c.oid,true)','pg_get_constraintdef(k.oid,true)')),/one exact/);
});

test('source drift refuses before derivation, input expectations are not accepted and no Native/app authority is minted',()=>{
 assert.throws(()=>derive({source204:source204+'\n'}),/literal Source204 source pin/);
 assert.throws(()=>derive({source204:null}));
 assert.equal(result.source_compilation_performed,false);assert.equal(result.native_certification,false);assert.equal(result.application_activation,false);
 assert.equal(result.unchanged_historical_certificate_rows,true);assert.equal(Object.isFrozen(result.changes[0].before.acl),true);
 const producer=readFileSync(new URL('../tools/parity/order-merge-delivery209-startup-capability-closure.mjs',import.meta.url),'utf8');
 assert(!/from ['"]pg['"]|createRequire|readFileSync|process\.env|\.query\(/.test(producer));
 assert(!/\b(?:INSERT INTO|UPDATE public\.|ALTER TABLE|COMMIT;)\b/.test(result.sql));
});
