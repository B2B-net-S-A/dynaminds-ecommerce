/** Controlled source/text equivalence only. No PostgreSQL or runtime timing proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210MetadataText as derive,ORDER_SPLIT210_METADATA_TEXT_SOURCE as pins} from '../tools/parity/order-split210-metadata-text.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
// Independent fixed full Source25 CREATE: no current closure/assembler import.
const source25=gunzipSync(Buffer.from('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','base64'),{maxOutputLength:18515}).toString('utf8');
const result=derive(source25),SQL_NULL=Symbol('SQL NULL');
const gates=[...source25.matchAll(/^ IF value IS NULL OR NOT\([^\n]+$/gm)].map(m=>m[0]);
const patterns=[...gates[0].matchAll(/position\('([^']+)' in value::text\)>0/g)].map(m=>m[1]);assert.equal(patterns.length,7);
const serialize=value=>JSON.stringify(value);
function oldGate(value,cast){return value!==SQL_NULL&&patterns.some(p=>cast(value).includes(p));}
function newGate(value,cast){const text=value===SQL_NULL?null:cast(value);return value!==SQL_NULL&&patterns.some(p=>text.includes(p));}
function counted(fn,value){let calls=0,bytes=0;const accepted=fn(value,v=>{calls++;const s=serialize(v);bytes+=Buffer.byteLength(s);return s;});return{accepted,calls,bytes};}

test('only three disjoint edits invert the complete independently pinned Source25 function',()=>{
 assert.equal(Buffer.byteLength(source25),pins.bytes);assert.equal(sha(source25),pins.sha256);assert.equal(result.edits.length,3);
 let inverse=result.sql;
 for(const e of [...result.edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}
 assert.equal(inverse,source25);assert.equal(result.bytes,Buffer.byteLength(result.sql));assert.equal(result.sha256,sha(result.sql));
 assert.equal(result.edits.filter(e=>e.kind.endsWith('text_once')).length,2);assert(result.whole_source_inverse_verified);
});

test('both exact seven-name predicates and exit semantics retain their original order',()=>{
 const edits=result.edits.filter(e=>e.kind.endsWith('text_once'));assert.equal(edits.length,2);
 for(let i=0;i<2;i++){
  const e=edits[i];assert.equal(e.before,gates[i]);assert.equal(e.after,' walk_text:=CASE WHEN value IS NULL THEN NULL ELSE value::text END;\n'+gates[i].replaceAll('value::text','walk_text'));
  assert.equal((e.before.match(/value::text/g)||[]).length,7);assert.equal((e.after.match(/value::text/g)||[]).length,1);
 }
 assert(result.sql.includes('THEN RETURN NULL;END IF;'));assert(result.sql.includes('THEN walk_projection:=NULL;EXIT metadata_node;END IF;'));
});

test('fresh whole guard, immutable DATA, classifier, DFS and strict refusal bytes are unchanged',()=>{
 for(const needle of ['PERFORM public.order_split210_require();','SELECT payload_jsonb INTO STRICT entries FROM public.order_split210_projection_basis WHERE id;','WHILE cardinality(walk_nodes)>0 LOOP','ORDER BY e.ord DESC','walk_changed:=true;','jsonb_set(walk_root,walk_text_path,walk_projection,false)',"USING ERRCODE='55000'"]){
  assert(source25.includes(needle));assert.equal(result.sql.split(needle).length,source25.split(needle).length,needle);
 }
 const classify=s=>s.slice(s.indexOf(" IF jsonb_typeof(value)='object' THEN"),s.indexOf('  END metadata_node;'));
 assert.equal(classify(result.sql),classify(source25));
 assert(result.sql.indexOf('PERFORM public.order_split210_require();')<result.sql.indexOf('WHILE cardinality(walk_nodes)>0 LOOP'));
 assert.equal(result.source_proofs.unchanged_basis_bytes,4193843);assert.equal(result.source_proofs.unchanged_basis_sha256,'0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7');
});

test('SQL NULL makes no serialization while JSONB null remains a normal unknown leaf',()=>{
 assert.deepEqual(counted(oldGate,SQL_NULL),{accepted:false,calls:0,bytes:0});assert.deepEqual(counted(newGate,SQL_NULL),{accepted:false,calls:0,bytes:0});
 assert.deepEqual(counted(oldGate,null),{accepted:false,calls:7,bytes:28});assert.deepEqual(counted(newGate,null),{accepted:false,calls:1,bytes:4});
 for(const value of [true,false,0,1,'',[],{}])assert.equal(oldGate(value,serialize),newGate(value,serialize));
});

test('controlled text equivalence covers every name, Unicode, escaped strings, keys and nested unknown scope',()=>{
 const values=[null,{unknown:'public.some_foreign_function()'},['escaped\\\"','ą😀','line\nnext'],{'b':'short','aa':'long'},['a/b','~','0'],{'foreign source':'SELECT jsonb_build_object(\'key\',\'value\');'}];
 for(const p of patterns)values.push(p,{signature:'public.'+p+')'},[null,{[p]:'keyword only in key'}],{foreign:'quoted "'+p+'" \\ path'});
 for(const value of values){const before=counted(oldGate,value),after=counted(newGate,value);assert.equal(after.accepted,before.accepted);assert.equal(after.calls,1);assert(before.calls>=1&&before.calls<=7);assert.equal(serialize(value),serialize(structuredClone(value)),'no key/value/array mutation');}
 // The function classifier, not this conservative text gate, still decides
 // exact whole descriptors, poisoned recognized scope and unknown containers.
 assert.equal(newGate({[patterns[0]]:'no descriptor'},serialize),true);assert.equal(newGate({unknown:'foreign'},serialize),false);
});

test('each current-node text is recomputed rather than shared across nodes or calls',()=>{
 const values=[{key:patterns[0]},null,{unknown:'plain'},[patterns.at(-1)],false];
 const seen=[];for(const value of values)assert.equal(newGate(value,v=>{seen.push(v);return serialize(v);}),oldGate(value,serialize));assert.deepEqual(seen,values);
 const a=derive(source25),b=derive(source25);assert.equal(a.sql,b.sql);assert.notEqual(a,b);assert.equal(a.cross_invocation_cache,false);assert.equal(a.new_runtime_functions,0);
});

test('primitive SQL authentication refuses edited, historical, accessor and extra authority inputs before use',()=>{
 for(const value of [null,undefined,{},[],Buffer.from(source25),source25+'\n',source25.replace('STABLE','VOLATILE'),source25.replace('RETURN NULL','RETURN true')])assert.throws(()=>derive(value));
 let called=false;const value={get sql(){called=true;throw Error('must not invoke');},toString(){called=true;throw Error('must not coerce');}};assert.throws(()=>derive(value),/SQL string/);assert.equal(called,false);
 assert.throws(()=>derive(source25,{}),/exactly one/);assert.throws(()=>derive(),/exactly one/);assert.throws(()=>derive(source25.replace('walk_changed','walk_text')),/Source25/);
});

test('controlled CPU work serializes large current JSON once per gate instead of seven times',t=>{
 const value={unknown:'x'.repeat(524288),escaped:'\\\" ą',nested:[null,false,{[patterns.at(-1)]:'last conservative name'}]};
 const before=counted(oldGate,value),after=counted(newGate,value);assert.equal(before.accepted,true);assert.equal(after.accepted,true);assert.equal(before.calls,7);assert.equal(after.calls,1);assert.equal(before.bytes,7*after.bytes);
 const iterations=12,measure=fn=>{const start=process.cpuUsage();let accepted=0;for(let i=0;i<iterations;i++)accepted+=fn(value,serialize)?1:0;return{accepted,cpu_us:process.cpuUsage(start)};};
 const old=measure(oldGate),current=measure(newGate);assert.equal(old.accepted,current.accepted);
 t.diagnostic(JSON.stringify({scope:'CONTROLLED_NODE_CPU_ONLY_NOT_PG',iterations,old_casts_per_gate:before.calls,new_casts_per_gate:after.calls,old_serialized_bytes:before.bytes,new_serialized_bytes:after.bytes,old_cpu_us:old.cpu_us,new_cpu_us:current.cpu_us}));
 // Timing is evidence only. Deterministic serialization counts/bytes above
 // prove the removed work without a flaky wall-clock or Native budget claim.
});

test('source-only output is immutable and carries no compilation or acceptance verdict',()=>{
 assert(Object.isFrozen(result)&&Object.isFrozen(result.edits)&&Object.isFrozen(result.source_proofs));assert.throws(()=>{result.edits[0].after='SQL';});
 for(const flag of ['source_data_changed','source_compilation_performed','native_certification','application_activation','business_acceptance'])assert.equal(result[flag],false);
 assert.deepEqual(result.serialization,{gates:2,old_cast_sites:14,new_cast_sites:2,maximum_casts_per_gate_before:7,maximum_casts_per_gate_after:1,sql_null_casts:0});
});
