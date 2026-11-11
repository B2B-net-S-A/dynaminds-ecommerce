/** Source-only lexical proposal and controlled text-semantics oracle.
 * No SQL execution, compiler, timing claim or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as E209} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {deriveOrderMergeDelivery209MetadataTraversalOpt as derive,ORDER_MERGE_DELIVERY209_METADATA_TRAVERSAL_SOURCE as PIN} from '../tools/parity/order-merge-delivery209-metadata-traversal-opt.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
// Independently fixed whole authored CREATE, never obtained by calling a
// future integrated producer (which would create a source-expectation cycle).
const authored=gunzipSync(Buffer.from('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','base64'),{maxOutputLength:8192}).toString('utf8');
assert.equal(Buffer.byteLength(authored),7116);assert.equal(sha(authored),PIN.sha256);
const proposal=derive(authored);
const source=readFileSync(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url),'utf8');
assert.equal(Buffer.byteLength(source),PIN.authored_source_bytes);assert.equal(sha(source),PIN.authored_source_sha256);
const inputLine=source.split('\n').find(line=>line.startsWith('INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'));
assert(inputLine);const lead="INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'";
assert(inputLine.startsWith(lead)&&inputLine.endsWith("');"));
const payload=inputLine.slice(lead.length,-3).replaceAll("''", "'");
assert.equal(Buffer.byteLength(payload),PIN.basis_bytes);assert.equal(sha(payload),PIN.basis_sha256);
const entries=JSON.parse(payload);assert.equal(entries.length,17);

const SQL_NULL=Symbol('SQL NULL');
const bytes=s=>Buffer.byteLength(s,'utf8');
// Bounded test JSONB-text subset: UTF8 strings/keys, integer numbers and
// containers. PG's actual text/escaping/error semantics need a separate SQL
// equivalence probe; this oracle deliberately does not claim to execute PG.
function jsonbText(v){
 if(v===SQL_NULL)return SQL_NULL;
 if(Array.isArray(v))return '['+v.map(jsonbText).join(', ')+']';
 if(v&&typeof v==='object')return '{'+Object.keys(v).sort((a,b)=>bytes(a)-bytes(b)||Buffer.compare(Buffer.from(a),Buffer.from(b))).map(k=>JSON.stringify(k)+': '+jsonbText(v[k])).join(', ')+'}';
 assert(v===null||typeof v==='string'||typeof v==='boolean'||Number.isSafeInteger(v));
 return JSON.stringify(v);
}
function sqlText(v){return v===null||v===undefined?SQL_NULL:typeof v==='string'?v:JSON.stringify(v);}
function token(s){return s===SQL_NULL?SQL_NULL:JSON.stringify(s);}
function replace(result,needle,replacement){
 if(result===SQL_NULL||needle===SQL_NULL||replacement===SQL_NULL)return SQL_NULL;
 // Literal replacements, including dollar signs, backslashes and quotes.
 return result.split(needle).join(replacement);
}
function digest(v){return v===SQL_NULL?SQL_NULL:sha(v);}
function project(value,basis,filtered){
 let result=value;const work={source_definition_steps:0,skipped_steps:0,quoted_bytes:0,replace_calls:0,hash_steps:0};
 const apply=(after,before,field)=>{
  if(field)work.source_definition_steps++;else work.hash_steps++;
  if(filtered&&field){
   // Same order as emitted PL/pgSQL: strict NULL before length exclusion;
   // SQL NULL current result makes the comparison unknown, hence no branch.
   if(after===SQL_NULL||before===SQL_NULL){result=SQL_NULL;return;}
   if(result===SQL_NULL)return;
   if(bytes(after)+2>bytes(result)){work.skipped_steps++;return;}
  }
  const a=token(after),b=token(before);for(const x of [a,b])if(x!==SQL_NULL)work.quoted_bytes+=bytes(x);
  work.replace_calls++;result=replace(result,a,b);
 };
 for(const entry of basis){
  for(const field of ['source','definition'])apply(sqlText(entry.after?.[field]),sqlText(entry.before?.[field]),true);
  apply(digest(sqlText(entry.after?.source)),digest(sqlText(entry.before?.source)),false);
 }
 return{result,work};
}
const equal=(value,basis=entries)=>{const old=project(value,basis,false),next=project(value,basis,true);assert.equal(next.result,old.result);return{old,next};};
const row=(after,before,definitionAfter=after,definitionBefore=before)=>({after:{source:after,definition:definitionAfter},before:{source:before,definition:definitionBefore}});

test('one exact source-bound edit has a whole-function inverse; full17 validation, guard, basis, headers and hashes stay literal',()=>{
 const start=source.indexOf('CREATE FUNCTION public.order_merge_delivery209_predecessor_metadata(value jsonb,entries jsonb)');
 const end=source.indexOf('END$local_metadata209$;',start)+'END$local_metadata209$;'.length;
 assert.equal(source.slice(start,end)+'\n',authored);
 assert.equal(proposal.edits.length,1);const e=proposal.edits[0];
 assert.equal(proposal.sql.slice(e.afterStart,e.afterStart+e.after.length),e.after);
 assert.equal(proposal.sql.slice(0,e.afterStart)+e.before+proposal.sql.slice(e.afterStart+e.after.length),authored);
 assert.equal(proposal.sql.slice(0,e.afterStart),authored.slice(0,e.beforeStart));
 assert.equal(proposal.sql.slice(e.afterStart+e.after.length),authored.slice(e.beforeStart+e.before.length));
 for(const fragment of ['validated<>17','total IS DISTINCT FROM 1',"live IS DISTINCT FROM entry->'after_check'",'order_merge_delivery209_valid() IS DISTINCT FROM true','payload_bytes IS DISTINCT FROM 21756960','result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);','RETURN result::jsonb;'])assert(proposal.sql.includes(fragment));
 assert.equal((proposal.sql.match(/result:=replace\(/g)||[]).length,2);
 assert.equal(proposal.source_definition_steps,34);assert.equal(proposal.unchanged_hash_steps,17);
 for(const k of ['source_data_changed','cross_invocation_cache','trusted_frame_api','performance_acceptance','source_compilation_performed','native_certification','application_activation','business_acceptance'])assert.equal(proposal[k],false);
 assert(Object.isFrozen(proposal)&&Object.isFrozen(proposal.edits[0]));
});

test('rejects changed bytes, headers, body, primitive wrappers and getters without invoking caller data',()=>{
 for(const v of [null,undefined,{},new String(authored),authored+'\n',authored.replace('55000','55001'),authored.replace('STABLE SECURITY DEFINER','IMMUTABLE SECURITY DEFINER')])assert.throws(()=>derive(v));
 let invoked=false;assert.throws(()=>derive({get sql(){invoked=true;return authored;}}));assert.equal(invoked,false);
 assert.throws(()=>derive(authored,{}));
});

test('actual C29 source basis is the exact authenticated17 full-record predecessor roster, independently matching published209',()=>{
 const records=entries.map(({key,before,after})=>({kind:'function',key,before,after}));
 assert.equal(sha(JSON.stringify(canonical(records))),PIN.expected17_canonical_sha256);
 assert.deepEqual(records,entries.map(e=>E209.changes.find(r=>r.kind==='function'&&r.key===e.key)));
 assert(entries.every(e=>Object.keys(e.before).length===24&&Object.keys(e.after).length===24));
 assert(entries.every(e=>typeof e.after_check.source[1]==='string'&&typeof e.after_check.definition[1]==='string'));
});

test('all17 actual whole before/after descriptors retain exact raw-text replacement results',()=>{
 for(const entry of entries){
  equal(jsonbText({[entry.key]:entry.before}));
  equal(jsonbText({[entry.key]:entry.after}));
 }
});

test('sequential cascades, length growth and duplicate renamed keys preserve the original raw serialized result',()=>{
 for(const basis of [[row('a','much longer value'),row('much longer value','final')],[row('much longer value','a'),row('a','final')],[row('a','b'),row('b','c')]]){
  const start=jsonbText({a:'a',b:'kept'}),{next}=equal(start,basis);assert.doesNotThrow(()=>JSON.parse(next.result));
 }
 const {next}=equal(jsonbText({a:'first',b:'last'}),[row('a','b')]);
 assert.equal(next.result,'{"b": "first", "b": "last"}');assert.deepEqual(JSON.parse(next.result),{b:'last'});
});

test('escaped-leading-quote suffix counterexample stays supported; no unsafe leaf equality shortcut',()=>{
 const value=jsonbText('"abc'),basis=[row('abc','xyz')];
 const {next}=equal(value,basis);assert.equal(next.result,jsonbText('"xyz'));
 assert.notEqual(JSON.parse(value),basis[0].after.source,'a whole-string equality lookup would miss this replacement');
 for(const text of ['"abc','\\"abc','""abc','abc"','line\n"abc','Zażółć 🧪 "abc'])equal(jsonbText({[text]:text}),basis);
});

test('SQL NULL differs from JSON null; oversized NULL replacement still propagates before exclusion',()=>{
 for(const value of [SQL_NULL,jsonbText(null),jsonbText(''),jsonbText({foreign:null})]){
  equal(value,[row('x'.repeat(10000),null)]);equal(value,[row(null,'before')]);equal(value,[row('a','b')]);
 }
 assert.equal(equal(jsonbText(null),[row('x'.repeat(10000),null)]).next.result,SQL_NULL);
 assert.equal(equal(jsonbText(null),[row('a','b')]).next.result,'null');
});

test('UTF8 byte lower bound covers escapes, control characters, keys, hashes and unknown nested content',()=>{
 for(const [after,before] of [['ż🧪','Łódź'],['"\\\n\t\b\f\r','\\$&"'],['a'.repeat(5000),'b'],['','empty'],['\u0001','control']]){
  assert(bytes(JSON.stringify(after))>=bytes(after)+2);
  for(const value of [after,{[after]:after,foreign:{array:[before,null,true,3]}},[sha(after),after]])equal(jsonbText(value),[row(after,before)]);
 }
 const unknown=jsonbText({foreign:{name:'not a209 binding',array:[1,null,'unrecognized']}});assert.equal(equal(unknown).next.result,unknown);
});

test('actual compact hash fixture proves avoided serialization/replace work without claiming PostgreSQL speed',()=>{
 const value=jsonbText(Object.fromEntries(entries.map(e=>[e.key,{source:sha(e.after.source),definition:sha(e.after.definition)}])));
 const {old,next}=equal(value);
 assert.equal(old.work.source_definition_steps,34);assert.equal(old.work.hash_steps,17);assert.equal(next.work.hash_steps,17);
 assert(next.work.skipped_steps>=28);assert(next.work.quoted_bytes<old.work.quoted_bytes/3);
 assert.equal(old.work.replace_calls-next.work.replace_calls,next.work.skipped_steps);
 console.log(JSON.stringify({source_only_operation_counts:{input_bytes:bytes(value),original:old.work,proposal:next.work},postgres_executed:false,performance_acceptance:false}));
});
