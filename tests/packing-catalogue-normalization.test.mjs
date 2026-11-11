import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRecoverySchema,SCHEMA_VERSION,SQL_SHA256} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
import {HEADER205_SOURCE_CONTRACT as H} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/header205-source-contract.mjs';
import {PACKING204_SOURCE_CONTRACT as P} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs';
import {projectHeaderMetadata205Catalogue} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/header205-source-compatibility.mjs';
import {projectPartialCommercial204Catalogue} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-compatibility.mjs';

const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(x).digest('hex');
const seal=v=>({...v,sha256:hash(JSON.stringify(canonical(v)))});
const countNames=['relations','indexes','sequences','inheritance','columns','constraints','policies','triggers','unsupported_internal_trigger_when','functions','types','event_triggers','default_acl','roles','role_memberships','extensions','rules','unsupported_relations','unsupported_routines','operators','operator_classes','operator_families','operator_family_operators','operator_family_procedures','access_methods','languages','extension_members','unsupported_ranges','unsupported_operator_shells','unsupported_statistics','unsupported_publications','unsupported_subscriptions','unsupported_collations','unsupported_foreign_servers','unsupported_languages'];
/** Structural file-only fixture, not native observations/installation/acceptance.
 * Required memberships are synthetic; only204/205 compared descriptors use literal Source contracts. */
function fixture(){
 const records=new Map(),add=r=>records.set(r.kind+'\0'+r.key,structuredClone(r));
 for(const key of SCOPE)add({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}});
 const relation=Object.fromEntries(['owner','kind','persistence','access_method','row_security','force_row_security','replica_identity','partition','partition_bound','partition_key','options','tablespace','acl_null','acl','view'].map(k=>[k,k==='acl'?[]:null]));
 for(const key of SOURCE_SELECTION.required_tables)add({kind:'relation',key,value:relation});
 const routine=Object.fromEntries(['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'].map(k=>[k,k==='acl'?[]:null]));
 for(const key of SOURCE_SELECTION.required_functions)add({kind:'function',key,value:routine});
 for(const c of [P,H]){for(const r of c.additions)add(r);for(const r of c.changes)add({kind:r.kind,key:r.key,value:r.after});}
 const ordered=[...records.values()].sort((a,b)=>{const x=a.kind+'\0'+a.key,y=b.kind+'\0'+b.key;return x<y?-1:x>y?1:0;});
 const counts={schemas:[...SCOPE].sort(),...Object.fromEntries(countNames.map(k=>[k,0]))};
 counts.functions=ordered.filter(r=>r.kind==='function').length;counts.relations=ordered.filter(r=>r.kind==='relation').length;
 return seal({schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records:ordered});
}
function dataOnlyFrozen(v){
 if(v===null||typeof v!=='object')return;
 assert(Object.isFrozen(v));assert([Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(v)));
 for(const key of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,key);assert(Object.hasOwn(d,'value'),'no accessor survives normalization');assert(!d.writable&&!d.configurable);dataOnlyFrozen(d.value);}
}

test('legal JSON keeps its canonical hash; validated counts and schemas are owned snapshots without input mutation',()=>{
 const input=fixture(),before=JSON.stringify(input),output=validateRecoverySchema(input);
 assert.equal(output.sha256,input.sha256);assert.equal(hash(JSON.stringify(canonical(Object.fromEntries(Object.entries(output).filter(([k])=>k!=='sha256'))))),input.sha256);
 assert.deepEqual(JSON.parse(JSON.stringify(output)),JSON.parse(before));dataOnlyFrozen(output);
 assert.notEqual(output.counts,input.counts);assert.notEqual(output.counts.schemas,input.counts.schemas);
 assert(!Object.isFrozen(input.counts));assert(!Object.isFrozen(input.counts.schemas));
 input.counts.functions=0;input.counts.schemas[0]='changed';assert.equal(output.counts.functions,JSON.parse(before).counts.functions);assert.deepEqual(output.counts.schemas,JSON.parse(before).counts.schemas);
});
test('counter and schemas getters are refused without invoking them, including a frozen accessor',()=>{
 for(const key of ['functions','schemas']){
  const input=fixture();let called=0;const prior=input.counts[key];
  Object.defineProperty(input.counts,key,{enumerable:true,configurable:true,get(){called++;return prior;}});Object.freeze(input.counts);
  assert.throws(()=>validateRecoverySchema(input),/recovery-count-own-data/);assert.equal(called,0);
 }
 const input=fixture();let called=0;const original=input.counts.schemas[0];Object.defineProperty(input.counts.schemas,'0',{enumerable:true,configurable:true,get(){called++;return original;}});
 assert.throws(()=>validateRecoverySchema(input),/recovery-count-schema-own-data/);assert.equal(called,0);
});
test('counter bounds, unsupported members, schemas density and exact scope stay enforced',()=>{
 for(const change of [v=>{v.counts.functions=-1;},v=>{v.counts.functions=50001;},v=>{v.counts.unsupported_statistics=1;},v=>{v.counts.extra=0;},v=>{delete v.counts.schemas[0];},v=>{v.counts.schemas.length=100000000;},v=>{v.counts.schemas[0]='foreign';}]){
  const input=fixture();change(input);assert.throws(()=>validateRecoverySchema(input));
 }
 const poisoned=fixture();poisoned.sha256='0'.repeat(64);assert.throws(()=>validateRecoverySchema(poisoned),/recovery-snapshot-integrity/);
});
test('both205 projection branches return frozen data-only snapshots and preserve independent canonical hashes',()=>{
 const input=fixture(),after=projectHeaderMetadata205Catalogue(input);assert.equal(after.active,true);dataOnlyFrozen(after.catalogue);
 assert.notEqual(after.catalogue.counts,input.counts);assert.notEqual(after.catalogue.counts.schemas,input.counts.schemas);
 const again=projectHeaderMetadata205Catalogue(after.catalogue);assert.equal(again.active,false);dataOnlyFrozen(again.catalogue);assert.equal(again.catalogue.sha256,after.catalogue.sha256);
 const expected=structuredClone(input);expected.records=expected.records.filter(r=>!H.additions.some(e=>r.kind===e.kind&&r.key===e.key)).map(r=>{const e=H.changes.find(e=>r.kind===e.kind&&r.key===e.key);return e?{...r,value:structuredClone(e.before)}:r;});expected.counts.functions-=H.additions.length;delete expected.sha256;
 assert.equal(after.catalogue.sha256,seal(expected).sha256);
});
test('204 consumes validated205 output and still checks complete source descriptors, hashes and overloads',()=>{
 const input=fixture(),output=projectPartialCommercial204Catalogue(input);assert.equal(output.active,true);dataOnlyFrozen(output.catalogue);
 const inactive=projectPartialCommercial204Catalogue(output.catalogue);assert.equal(inactive.active,false);dataOnlyFrozen(inactive.catalogue);assert.equal(inactive.catalogue.sha256,output.catalogue.sha256);
 const h=projectHeaderMetadata205Catalogue(input).catalogue,expected=structuredClone(h);
 expected.records=expected.records.filter(r=>!P.additions.some(e=>r.kind===e.kind&&r.key===e.key)).map(r=>{const e=P.changes.find(e=>r.kind===e.kind&&r.key===e.key);return e?{...r,value:structuredClone(e.before)}:r;});expected.counts.functions-=P.additions.length;delete expected.sha256;
 assert.equal(output.catalogue.sha256,seal(expected).sha256);
 for(const field of ['source','definition','owner','acl']){
  const bad=fixture(),target=bad.records.find(r=>r.kind===P.changes[0].kind&&r.key===P.changes[0].key);target.value[field]=field==='acl'?[]:'changed';
  const {sha256,...body}=bad;assert.throws(()=>projectPartialCommercial204Catalogue(seal(body)));
 }
 const overload=fixture(),duplicate=structuredClone(overload.records.find(r=>r.kind===P.changes[0].kind&&r.key===P.changes[0].key));
 duplicate.key=duplicate.key.replace(/\)$/,'text)');overload.records.push(duplicate);overload.records.sort((a,b)=>{const x=a.kind+'\0'+a.key,y=b.kind+'\0'+b.key;return x<y?-1:x>y?1:0;});overload.counts.functions++;delete overload.sha256;assert.throws(()=>projectPartialCommercial204Catalogue(seal(overload)));
 const mixed=fixture(),target=mixed.records.find(r=>r.kind===P.changes[0].kind&&r.key===P.changes[0].key);target.value=structuredClone(P.changes[0].before);delete mixed.sha256;assert.throws(()=>projectPartialCommercial204Catalogue(seal(mixed)));
 const bad=fixture();bad.sha256='0'.repeat(64);assert.throws(()=>projectPartialCommercial204Catalogue(bad),/recovery-snapshot-integrity/);
});


test('own primitive SHA is captured once; a malicious frozen getter is refused without invocation in every projection branch',()=>{
 const raw=fixture(),without205=projectHeaderMetadata205Catalogue(raw).catalogue,without204=projectPartialCommercial204Catalogue(raw).catalogue;
 for(const baseline of [raw,without205,without204]){
  for(const work of [validateRecoverySchema,projectHeaderMetadata205Catalogue,projectPartialCommercial204Catalogue]){
   const input=structuredClone(baseline),declared=input.sha256;let called=0;
   Object.defineProperty(input,'sha256',{enumerable:true,configurable:false,get(){return ++called<=2?declared:'0'.repeat(64);}});Object.freeze(input);
   assert.throws(()=>work(input),/recovery-sha-own-data/);assert.equal(called,0);
  }
 }
 for(const invalid of [null,0,true,{},new String(raw.sha256),raw.sha256.toUpperCase()]){
  const input=structuredClone(raw);input.sha256=invalid;assert.throws(()=>validateRecoverySchema(input),/recovery-sha-shape/);
 }
});
test('other top-level fields are read once and normalized to owned immutable output; every205 and204 return revalidates',()=>{
 const raw=fixture();
 const input=structuredClone(raw),reads={};
 for(const key of ['schema','postgres_major','scope','sql_sha256','counts','records']){const captured=input[key];reads[key]=0;
  Object.defineProperty(input,key,{enumerable:true,configurable:false,get(){reads[key]++;return captured;}});
 }
 Object.freeze(input);const normalized=validateRecoverySchema(input);
 assert.deepEqual(reads,Object.fromEntries(Object.keys(reads).map(k=>[k,1])));dataOnlyFrozen(normalized);
 assert.deepEqual(validateRecoverySchema(normalized),normalized);
 const after205=projectHeaderMetadata205Catalogue(raw),inactive205=projectHeaderMetadata205Catalogue(after205.catalogue);
 const after204=projectPartialCommercial204Catalogue(raw),inactive204=projectPartialCommercial204Catalogue(after204.catalogue);
 for(const result of [after205,inactive205,after204,inactive204]){
  dataOnlyFrozen(result.catalogue);const validated=validateRecoverySchema(result.catalogue);
  assert.deepEqual(validated,result.catalogue);assert.equal(validated.sha256,result.catalogue.sha256);
  assert.equal(validated,result.catalogue); // Owned immutable representation is reused; foreign alias checks remain separate.
 }
 assert(after205.active&&after204.active);assert(!inactive205.active&&!inactive204.active);
});

test('only owned normalized outputs reuse representation; identical foreign frozen values and clones still normalize independently',()=>{
 const foreign=fixture();const deepFreeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))deepFreeze(x);Object.freeze(v);}return v;};
 deepFreeze(foreign);const first=validateRecoverySchema(foreign),second=validateRecoverySchema(foreign);
 assert.notEqual(first,foreign);assert.notEqual(first,second);assert.notEqual(first.records,foreign.records);assert.notEqual(first.counts,foreign.counts);
 assert.equal(validateRecoverySchema(first),first);assert.equal(validateRecoverySchema(second),second);dataOnlyFrozen(first);
 const clone=deepFreeze(structuredClone(first)),third=validateRecoverySchema(clone);assert.notEqual(third,first);assert.notEqual(third,clone);assert.notEqual(validateRecoverySchema(clone),third);
 assert.equal(third.sha256,first.sha256);assert.equal(validateRecoverySchema(third),third);
 const bad=structuredClone(first);bad.records.find(r=>r.kind==='function').value.definition+=' changed';Object.freeze(bad);
 assert.throws(()=>validateRecoverySchema(bad),/recovery-snapshot-integrity/);
 const getters={...foreign};let reads=0;Object.defineProperty(getters,'records',{enumerable:true,get(){reads++;return foreign.records;}});Object.freeze(getters);
 const a=validateRecoverySchema(getters),b=validateRecoverySchema(getters);assert.equal(reads,2);assert.notEqual(a,b);assert.equal(validateRecoverySchema(a),a);
});

test('owned normalization does not retain caller Array species/proxies or sparse inherited array values',()=>{
 const input=fixture();let species=0;
 class ForeignArray extends Array{static get [Symbol.species](){species++;return class extends Array{};}}
 Object.setPrototypeOf(input.records,ForeignArray.prototype);
 const nested=input.records.find(r=>r.kind==='function');nested.value.config=new ForeignArray('controlled');
 delete input.sha256;const sealed=seal(input);species=0;
 const value=validateRecoverySchema(sealed);assert.equal(species,0);assert.equal(Object.getPrototypeOf(value.records),Array.prototype);
 assert.equal(Object.getPrototypeOf(value.records.find(r=>r.kind==='function').value.config),Array.prototype);dataOnlyFrozen(value);assert.equal(validateRecoverySchema(value),value);
 const sparse=structuredClone(value);sparse.records.find(r=>r.kind==='function').value.config=Array(2);delete sparse.sha256;
 assert.throws(()=>validateRecoverySchema(seal(sparse)),/recovery-dense-json-array/);
 const missing=structuredClone(value);delete missing.records[0];assert.throws(()=>validateRecoverySchema(missing),/recovery-dense-record-array/);
});

// Controlled transport on an unconnected native Client/Socket. Exercises reader
// custody and every read call, NOT actual PostgreSQL/Native installation proof.
import pg from 'pg';
import {Socket} from 'node:net';
import {readPackingCatalogue,inspectPackingCatalogueContext} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {CONTEXT_SQL,COUNT_SQL,LENGTH_SQL,PAYLOAD_SQL} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
test('reader still executes each fresh read and normalization never receives its separate private custody root',async()=>{
 const c=new pg.Client({host:'127.0.0.1',port:57081,database:'controlled_no_connection'}),stream=c.connection.stream;
 assert(stream instanceof Socket);Object.defineProperty(stream,'remoteAddress',{value:'127.0.0.1'});Object.defineProperty(stream,'remotePort',{value:57081});c.processID=71;
 const selected={database:'controlled_no_connection',data_directory:'/controlled',port:57081,native_start_epoch:'1792255528'};
 const context={...selected,owner:'postgres',role:'postgres',address:'127.0.0.1',backend_pid:71,server_version_num:'180000',read_only:'off',isolation:'read committed',timezone:'UTC',jit:'off',search_path:'pg_catalog, public',schema_lock:1,statement_timeout:'8s',lock_timeout:'8s',transaction_started_at:'2026-10-17T10:00:00Z',snapshot:'7:7:',root_xid:'7'};
 const input=fixture(),calls=[];
 c.query=async sql=>{
  calls.push(sql);const payload=input.records.map(record=>({record:JSON.stringify(record)}));let rows;
  if(sql===CONTEXT_SQL)rows=[context];else if(sql===COUNT_SQL)rows=[input.counts];
  else if(sql===LENGTH_SQL)rows=[{records:payload.length,encoded_bytes:String(payload.reduce((n,r)=>n+Buffer.byteLength(r.record),0)),largest_record:String(Math.max(...payload.map(r=>Buffer.byteLength(r.record))))}];
  else if(sql===PAYLOAD_SQL)rows=payload;else assert.fail('Unexpected reader SQL');
  c.connection.emit('readyForQuery',{status:'T'});return{rows};
 };
 try{
  const first=await readPackingCatalogue(c,selected);assert.deepEqual(inspectPackingCatalogueContext(first),context);
  const normalized=validateRecoverySchema(first);assert.notEqual(normalized,first);assert.equal(validateRecoverySchema(first),normalized);assert.equal(validateRecoverySchema(normalized),normalized);
  assert.throws(()=>inspectPackingCatalogueContext(normalized),/packing-code-owned-catalogue-required/);
  assert.throws(()=>inspectPackingCatalogueContext(structuredClone(first)),/packing-code-owned-catalogue-required/);
  input.records.find(r=>r.kind==='function').value.definition+=' controlled metadata drift';
  const second=await readPackingCatalogue(c,selected);assert.notEqual(second,first);assert.notEqual(second.sha256,first.sha256);
  assert.deepEqual(calls,[CONTEXT_SQL,COUNT_SQL,LENGTH_SQL,PAYLOAD_SQL,COUNT_SQL,CONTEXT_SQL,CONTEXT_SQL,COUNT_SQL,LENGTH_SQL,PAYLOAD_SQL,COUNT_SQL,CONTEXT_SQL]);
  const next=validateRecoverySchema(second);assert.notEqual(next,second);assert.notEqual(next,normalized);assert.throws(()=>inspectPackingCatalogueContext(next),/packing-code-owned-catalogue-required/);
 }finally{stream.destroy();}
});


test('a changing record-value accessor cannot register a shape different from the one actually checked',()=>{
 const input=fixture(),target=input.records.find(r=>r.kind==='function'),original=target.value;
 const bad=structuredClone(input);bad.records.find(r=>r.kind==='function').value={unchecked:true};delete bad.sha256;
 input.sha256=seal(bad).sha256;let reads=0;
 // Former records() shape/ACL checks read value four times, then canonical()
 // copied its fifth unchecked result. The own snapshot must be captured first.
 Object.defineProperty(target,'value',{enumerable:true,configurable:false,get(){return ++reads<=4?original:{unchecked:true};}});Object.freeze(target);
 assert.throws(()=>validateRecoverySchema(input),/recovery-snapshot-integrity/);assert.equal(reads,1);
});
