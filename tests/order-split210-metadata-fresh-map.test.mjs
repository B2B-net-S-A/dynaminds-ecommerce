/** Source-only equivalence of frame admission, not a PostgreSQL execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210MetadataFreshMap as derive,ORDER_SPLIT210_METADATA_FRESH_MAP_SOURCE as PIN} from '../tools/parity/order-split210-metadata-fresh-map.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const copy=structuredClone;
// Frozen full24 Source28 BEFORE witness, independent of a future H publication
// and of a future producer which may already emit the proposed AFTER body.
const before=JSON.parse(gunzipSync(Buffer.from('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','base64'),{maxOutputLength:32768}).toString('utf8'));
assert.equal(sha(JSON.stringify(canonical(before))),PIN.descriptor_canonical_sha256);
assert.equal(Buffer.byteLength(before.source),7215);assert.equal(sha(before.source),PIN.sha256);
assert.equal(Buffer.byteLength(before.definition),7447);assert.equal(sha(before.definition),PIN.definition_sha256);
const proposal=derive(before.source);
const parent=readFileSync(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url),'utf8');
assert.equal(Buffer.byteLength(parent),PIN.parent_source_bytes);assert.equal(sha(parent),PIN.parent_source_sha256);
const marker="INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'";
const basisLine=parent.split('\n').find(line=>line.startsWith(marker));assert(basisLine?.endsWith("');"));
const basisText=basisLine.slice(marker.length,-3).replaceAll("''","'");
assert.equal(Buffer.byteLength(basisText),PIN.basis_bytes);assert.equal(sha(basisText),PIN.basis_sha256);
const basis=JSON.parse(basisText);assert.equal(basis.length,17);
const expected=basis.map(e=>({key:e.key,after_check:e.after_check}));
const names=expected.map(e=>e.key.slice(7,e.key.indexOf('(')));
// Independently fixed SOURCE28 snapshot/full24 and SOURCE209 checked-map.
const snapshotBefore=JSON.parse(gunzipSync(Buffer.from('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','base64'),{maxOutputLength:65536}));
const checkedMapBefore=JSON.parse(gunzipSync(Buffer.from('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','base64'),{maxOutputLength:16384}));
const authenticChecked=[checkedMapBefore],authenticSnapshot=[{key:'public.order_merge_delivery209_validation_snapshot()',value:snapshotBefore}];
assert.equal(sha(JSON.stringify(canonical(snapshotBefore))),PIN.source210_snapshot_descriptor_sha256);
assert.equal(Buffer.byteLength(snapshotBefore.source),PIN.source210_snapshot_bytes);assert.equal(sha(snapshotBefore.source),PIN.source210_snapshot_sha256);
assert.equal(Buffer.byteLength(snapshotBefore.definition),PIN.source210_snapshot_definition_bytes);assert.equal(sha(snapshotBefore.definition),PIN.source210_snapshot_definition_sha256);
const SQL_NULL=Symbol('SQL NULL');
const reject=(message='refused')=>{throw Object.assign(Error(message),{code:'55000'});};
const native=()=>{throw Object.assign(Error('controlled native jsonb_to_recordset row-shape error'),{code:'22023'});};
const keyText=v=>v==null?null:typeof v==='string'?v:JSON.stringify(v);
function typedRows(entries){
 if(!Array.isArray(entries)||entries.length!==17)reject('array17');
 return entries.map((row,i)=>{
  if(!row||typeof row!=='object'||Array.isArray(row))native();
  return{ordinal:i+1,key:keyText(row.key),after_check:row.after_check??null};
 });
}
function ctx(){return{current:copy(expected),manifestRows:1,buyerManifestRows:1,profile:'merge-delivery-inheritance/v1',parent166Equal:true,fingerprintEqual:true,encoding:'UTF8',sourceId:true,payloadPresent:true,payloadBytes:21756960,payloadHash:PIN.basis_sha256,source210Valid:true,checkedMapFunctions:copy(authenticChecked),snapshotFunctions:copy(authenticSnapshot)};}
function requireSource210(c){if(!c.source210Valid||!same(c.snapshotFunctions,authenticSnapshot))reject('210 whole snapshot descriptor/overload');}
function sourceState(c){
 if(!same(c.checkedMapFunctions,authenticChecked))reject('209 complete own namespace fingerprint');
 if(c.current.length!==17||expected.some(row=>{const found=c.current.filter(r=>r.key===row.key);return found.length!==1||!same(found[0],row);}))reject('209 whole legacy fingerprint');
 if(!c.source210Valid||c.manifestRows!==1||c.buyerManifestRows!==1||c.profile!=='merge-delivery-inheritance/v1'||!c.parent166Equal||!c.fingerprintEqual||c.encoding!=='UTF8')reject('current complete installation');
 if(!c.sourceId||!c.payloadPresent||c.payloadBytes!==21756960||c.payloadHash!==PIN.basis_sha256)reject('source DATA');
}
function originalCurrentLookup(c,key){
 const name=key?.split('(')[0];const rows=c.current.filter(row=>row.key.split('(')[0]===name);
 if(rows.length!==1)reject('current overload');return rows[0];
}
function relevant(value){return value!==SQL_NULL&&names.some(name=>JSON.stringify(value).includes(name));}
// Independent old model: a typed per-row CURRENT catalogue comparison, then
// the original whole-manifest fingerprint/own-source validation, then DATA.
function original(value,entries,c,counts={}){
 if(!relevant(value))return value;
 const rows=typedRows(entries);
 for(const row of rows){
  if(row.key!==expected[row.ordinal-1].key)reject('ordered roster');
  const current=originalCurrentLookup(c,row.key);
  requireSource210(c);
  if(current.key!==row.key||!same(current.after_check,row.after_check))reject('whole current descriptor');
 }
 counts.original_current_passes=(counts.original_current_passes??0)+1;
 sourceState(c);
 if(c.current.length!==17||expected.some(row=>{const actual=c.current.filter(r=>r.key===row.key);return actual.length!==1||!same(actual[0],row);}))reject('current fingerprint');
 counts.original_current_passes++;
 return value;
}
// Independent new model: caller independently authenticates Source210 first;
// the same fresh snapshot trust root supplies legacy rows and the fingerprint.
// It NEVER executes the checked-map callee, including a hostile replacement.
function freshSnapshot(c,counts){
 counts.fresh_snapshot_calls=(counts.fresh_snapshot_calls??0)+1;sourceState(c);
 return c.current.map(row=>({kind:'function',key:row.key,value:copy(row.after_check)}));
}
function proposed(value,entries,c,counts={}){
 if(!relevant(value))return value;
 const caller=typedRows(entries); // Original native recordset conversion first.
 counts.caller_require_calls=(counts.caller_require_calls??0)+1;requireSource210(c);
 const fresh=freshSnapshot(c,counts);
 if(!Array.isArray(fresh)||fresh.length!==17)reject('fresh complete snapshot legacy');
 for(const row of caller){
  if(row.key!==expected[row.ordinal-1].key)reject('ordered roster');
  const candidates=fresh.filter(r=>r.kind==='function'&&r.key.split('(')[0]===row.key.split('(')[0]);
  if(candidates.length!==1)reject('current overload');
  if(candidates[0].key!==row.key||!same(candidates[0].value,row.after_check))reject('whole fresh descriptor');
 }
 return value;
}
function outcome(fn,...args){try{return{value:fn(...args)};}catch(e){return{error:e.code};}}
const VALUE={metadata:'public.pim_dictionary_valid()'};
function compare(entries=expected,c=ctx(),value=VALUE){const old=outcome(original,value,entries,copy(c)),next=outcome(proposed,value,entries,copy(c));assert.deepEqual(next,old);return next;}

test('exact raw-body and full CREATE inverse preserves complete header/ACL, early ports, DATA,51 suffix and final parse',()=>{
 assert.equal(proposal.edits.length,2);let inverse=proposal.source;
 for(const edit of [...proposal.edits].reverse()){
  assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);
  inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);
 }
 assert.equal(inverse,before.source);assert.equal(before.definition.replace(before.source,()=>proposal.source),proposal.definition);assert.equal(proposal.sql,proposal.definition);
 const after={...before,source:proposal.source,definition:proposal.definition};
 const strip=({source,definition,...header})=>header;assert.deepEqual(strip(after),strip(before));assert.equal(Object.keys(after).length,24);
 const span=proposal.edits[1],originalPrefix=before.source.slice(proposal.edits[0].beforeStart+proposal.edits[0].before.length,span.beforeStart);
 assert(proposal.source.includes(originalPrefix));assert(originalPrefix.includes('order_split210_try_metadata_projection(value)'));
 assert(originalPrefix.includes('result:=value::text'));assert(originalPrefix.includes('IF NOT EXISTS(SELECT FROM unnest('));
 assert.equal(proposal.source.slice(span.afterStart+span.after.length),before.source.slice(span.beforeStart+span.before.length));
 assert(proposal.source.endsWith(' RETURN result::jsonb;\nEND'));
 assert.equal((proposal.source.match(/result:=replace\(/g)||[]).length,2);
 assert.equal((proposal.source.match(/order_merge_delivery209_validation_snapshot\(\)/g)||[]).length,1);assert(!proposal.source.includes('order_merge_delivery209_checked_projection_map('));
 assert(proposal.source.indexOf('PERFORM public.order_split210_require()')<proposal.source.indexOf('split210_fresh_snapshot:=public.order_merge_delivery209_validation_snapshot()'));
 assert(!proposal.source.includes('order_merge_delivery209_valid()'));assert(!proposal.source.includes('order_split210_project209_record('));
 assert.equal(proposal.parent209_data_changed,false);assert.equal(proposal.source210_descriptor_replacement_required,true);
 for(const k of ['source210_data_delta_measured','trusted_frame_api','cross_invocation_cache','source_compilation_performed','native_certification','performance_acceptance','application_activation','business_acceptance'])assert.equal(proposal[k],false);
 assert(Object.isFrozen(proposal)&&Object.isFrozen(proposal.edits[0]));
});

test('actual existing checked-map source authenticates a fresh snapshot, full17 headers/overloads, manifests, UTF8 and DATA',()=>{
 const extract=(name,tag)=>{const start=parent.indexOf('CREATE FUNCTION public.'+name+'(');const first=parent.indexOf(tag,start);const end=parent.indexOf(tag+';',first+tag.length)+(tag+';').length;return parent.slice(start,end)+'\n';};
 const checked=extract('order_merge_delivery209_checked_projection_map','$checked209$'),snapshot=extract('order_merge_delivery209_validation_snapshot','$snapshot209$');
 assert.equal(Buffer.byteLength(checked),PIN.checked_map_sql_bytes);assert.equal(sha(checked),PIN.checked_map_sql_sha256);
 assert.equal(Buffer.byteLength(snapshot),PIN.snapshot_sql_bytes);assert.equal(sha(snapshot),PIN.snapshot_sql_sha256);
 assert.equal((checked.match(/snapshot_value:=public.order_merge_delivery209_validation_snapshot\(\)/g)||[]).length,1);
 for(const text of ["current_setting('server_encoding') IS DISTINCT FROM 'UTF8'",'order_merge_delivery209_manifest','buyer_address_manifest','m.original166 IS DISTINCT FROM','m.fingerprint IS DISTINCT FROM',"current_rows:=snapshot_value->'legacy'",'jsonb_array_length(current_rows)<>17','jsonb_array_length(source_keys)<>17','jsonb_array_length(source_checks)<>17',"actual_key IS DISTINCT FROM entry->>'key'", "live IS DISTINCT FROM entry->'after_check'",'validated<>17','payload_bytes IS DISTINCT FROM 21756960',PIN.basis_sha256])assert(checked.includes(text),text);
 assert(checked.includes("SELECT count(*) INTO total FROM jsonb_array_elements(current_rows)"));
 for(const field of Object.keys(basis[0].after_check))assert(snapshot.includes("'"+field+"'"),'whole tagged header '+field);
 assert(snapshot.includes("'source',jsonb_build_array('sha256-utf8-text/v1'"));assert(snapshot.includes("'definition',jsonb_build_array('sha256-utf8-text/v1'"));
});

test('rejects wrong body, wrappers, changed port/header assumptions and getters without caller-data access',()=>{
 for(const v of [null,undefined,{},new String(before.source),before.definition,before.source+'\n',before.source.replace('55000','55001'),before.source.replace('payload_hash text','foreign_hash text')])assert.throws(()=>derive(v));
 let read=false;assert.throws(()=>derive({get source(){read=true;return before.source;}}));assert.equal(read,false);assert.throws(()=>derive(before.source,{}));
});

test('valid compact/full frames and arbitrary extra entry properties retain old admission and ignore only those properties',()=>{
 for(const frame of [expected,basis,basis.map(e=>({...e,irrelevant:{foreign:'never authority'},unknown:42}))])assert.deepEqual(compare(frame),{value:VALUE});
 const extra=copy(expected);extra[0].after_check.extra='must not be ignored';assert.equal(compare(extra).error,'55000');
});

test('all17 key ordinals, signatures, missing/null/scalar/partial after-checks refuse identically',()=>{
 for(const mutate of [f=>f.pop(),f=>f.push(copy(f[0])),f=>f.reverse(),f=>{[f[0],f[1]]=[f[1],f[0]];},f=>f[0].key='public.unknown()',f=>f[0].key=null,f=>f[0].key=33,f=>f[0].key={},f=>f[0].after_check=null,f=>delete f[0].after_check,f=>f[0].after_check=[],f=>f[0].after_check=42,f=>delete f[0].after_check.owner,f=>f[0].after_check.source=['sha256-utf8-text/v1','0'.repeat(64)],f=>f[0].after_check.definition=['sha256-utf8-text/v1','0'.repeat(64)]]){
  const frame=copy(expected);mutate(frame);assert.equal(compare(frame).error,'55000');
 }
});

test('original typed recordset extraction is retained and native row-shape errors occur before snapshot authentication',()=>{
 const typed='FROM ROWS FROM(jsonb_to_recordset(entries) AS(key text,after_check jsonb)) WITH ORDINALITY AS a(key,after_check,ordinal)';
 assert(before.source.includes(typed));assert(proposal.source.includes(typed));assert(proposal.source.indexOf(typed)<proposal.source.indexOf('PERFORM public.order_split210_require()'));
 for(const row of [null,[],1,'foreign',true]){
  const frame=copy(expected);frame[8]=row;assert.equal(compare(frame).error,'22023');const counts={};assert.equal(outcome(proposed,VALUE,frame,ctx(),counts).error,'22023');assert.equal(counts.fresh_snapshot_calls??0,0);
 }
 for(const frame of [null,{},'array',true,[]])assert.equal(compare(frame).error,'55000');
});

test('every current full24 header/hash drift, overload, signature and own installation/DATA fault remains55000',()=>{
 for(const field of Object.keys(expected[0].after_check)){
  const c=ctx();c.current[0].after_check[field]={unexpected:'current drift'};assert.equal(compare(expected,c).error,'55000',field);
 }
 for(const mutate of [c=>c.current.push(copy(c.current[0])),c=>c.current.pop(),c=>c.current[0].key='public.buyer_address_preview_guard(x integer)',c=>c.manifestRows=0,c=>c.manifestRows=2,c=>c.buyerManifestRows=0,c=>c.profile=null,c=>c.profile='other',c=>c.parent166Equal=false,c=>c.fingerprintEqual=false,c=>c.encoding='LATIN1',c=>c.sourceId=false,c=>c.payloadPresent=false,c=>c.payloadBytes--,c=>c.payloadHash='0'.repeat(64),c=>c.source210Valid=false]){
  const c=ctx();mutate(c);assert.equal(compare(expected,c).error,'55000');
 }
});

test('fresh source is validated every strict invocation including forged caller checks; no verdict or frame cache',()=>{
 const counts={},c=ctx();assert.deepEqual(proposed(VALUE,expected,c,counts),VALUE);assert.deepEqual(proposed(VALUE,basis,c,counts),VALUE);assert.equal(counts.fresh_snapshot_calls,2);
 const forged=copy(expected);forged[5].after_check.owner='foreign';assert.equal(outcome(proposed,VALUE,forged,c,counts).error,'55000');assert.equal(counts.fresh_snapshot_calls,3);
 c.current[0].after_check.owner='changed after prior call';assert.equal(outcome(proposed,VALUE,expected,c,counts).error,'55000');assert.equal(counts.fresh_snapshot_calls,4);
 const oldCounts={};original(VALUE,expected,ctx(),oldCounts);assert.equal(oldCounts.original_current_passes,2);
});

test('SQLNULL, JSONnull and irrelevant foreign containers retain early identity and never parse unneeded frames',()=>{
 for(const value of [SQL_NULL,null,'unknown',{},[{foreign:null}],{'unrelated':'quotes" \\ 🧪'}]){
  const counts={};assert.deepEqual(compare({invalid:'deliberately unparsed'},ctx(),value),{value});assert.equal(proposed(value,null,ctx(),counts),value);assert.equal(counts.fresh_snapshot_calls??0,0);
 }
 assert.notEqual(outcome(proposed,SQL_NULL,null,ctx()).value,outcome(proposed,null,null,ctx()).value);
});


test('direct snapshot source witness retains its internal require; caller independently authenticates it before dispatch',()=>{
 assert(snapshotBefore.source.startsWith('\n SELECT public.order_split210_require();\n'));
 assert(snapshotBefore.source.includes('WITH split210_snapshot_map(split210_key,after_record,before_record) AS MATERIALIZED'));
 const typed=proposal.source.indexOf('FROM ROWS FROM(jsonb_to_recordset(entries)');
 const auth=proposal.source.indexOf('PERFORM public.order_split210_require()');
 const dispatch=proposal.source.indexOf('split210_fresh_snapshot:=public.order_merge_delivery209_validation_snapshot()');
 assert(typed>0&&typed<auth&&auth<dispatch);
 for(const predicate of ["current_setting('server_encoding') IS DISTINCT FROM 'UTF8'",'(SELECT count(*) FROM public.order_merge_delivery209_manifest)<>1','(SELECT count(*) FROM public.buyer_address_manifest)<>1',"split210_manifest.profile IS DISTINCT FROM 'merge-delivery-inheritance/v1'",'split210_manifest.original166 IS DISTINCT FROM(SELECT to_jsonb(b) FROM public.buyer_address_manifest b)',"split210_manifest.fingerprint IS DISTINCT FROM(split210_fresh_snapshot->>'fingerprint')", "split210_fresh_frame:=split210_fresh_snapshot->'legacy'",'IF total IS DISTINCT FROM 1 THEN',"actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'"])assert(proposal.source.includes(predicate),predicate);
 const a=parent.indexOf('CREATE FUNCTION public.order_merge_delivery209_checked_projection_map('),b=parent.indexOf('$checked209$;',a);
 const checked=parent.slice(a,b);
 const sourceLoop=checked.slice(checked.indexOf('  SELECT count(*) INTO total FROM jsonb_array_elements(current_rows)'),checked.indexOf(' END LOOP;',checked.indexOf('  SELECT count(*) INTO total FROM jsonb_array_elements(current_rows)')));
 assert(proposal.source.includes(sourceLoop.replaceAll('current_rows','split210_fresh_frame')),'literal source209 full17 namespace/overload/key/whole24 comparison');
 assert.equal(proposal.caller_side_require_before_snapshot,true);assert.equal(proposal.checked_map_callee_dependency,false);
});

test('tampered checked-map or shadow overload cannot bypass independent own209 fingerprint; snapshot body/header drift refuses before dispatch',()=>{
 for(const field of Object.keys(checkedMapBefore.value)){
  const c=ctx();c.checkedMapFunctions[0].value[field]={hostile:'returned SOURCE17 frame without checking installation'};
  assert.equal(compare(expected,c).error,'55000','checked-map '+field);
 }
 for(const key of ['public.order_merge_delivery209_checked_projection_map()','public.order_merge_delivery209_checked_projection_map(foreign text)']){
  const c=ctx();c.checkedMapFunctions.push({key,value:copy(checkedMapBefore.value)});assert.equal(compare(expected,c).error,'55000');
 }
 for(const field of Object.keys(snapshotBefore)){
  const c=ctx();c.snapshotFunctions[0].value[field]={hostile:'forged snapshot omitted its internal require'};
  assert.equal(compare(expected,c).error,'55000','snapshot '+field);
  const counts={};assert.equal(outcome(proposed,VALUE,expected,c,counts).error,'55000');assert.equal(counts.caller_require_calls,1);assert.equal(counts.fresh_snapshot_calls??0,0,'independent guard BEFORE hostile body dispatch');
 }
 const overloaded=ctx();overloaded.snapshotFunctions.push({key:'public.order_merge_delivery209_validation_snapshot(x oid DEFAULT NULL::oid)',value:copy(snapshotBefore)});assert.equal(compare(expected,overloaded).error,'55000');
 const c=ctx(),counts={};assert.deepEqual(proposed(VALUE,expected,c,counts),VALUE);c.checkedMapFunctions[0].value.source='RETURN forged_source_frame;';
 assert.equal(outcome(proposed,VALUE,expected,c,counts).error,'55000');assert.equal(counts.fresh_snapshot_calls,2,'fresh fingerprint after a previous accepted invocation');
});
