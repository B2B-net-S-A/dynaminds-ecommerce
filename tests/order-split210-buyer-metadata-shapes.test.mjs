/** SOURCE-only differential representation tests. No DB or runtime admission. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ORDER_SPLIT210_SOURCE_CONTRACT as source} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-split210-source-contract.mjs';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as source209} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {deriveOrderSplit210BuyerMetadataShapes,projectOrderSplit210BuyerMetadataShape,ORDER_SPLIT210_BUYER_METADATA_KEY as key} from '../tools/parity/order-split210-buyer-metadata-shapes.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const change=source.changes.find(c=>c.key===key);assert(change);
const ancestor208=source209.changes.find(c=>c.key===key).before;
const program=deriveOrderSplit210BuyerMetadataShapes({change,ancestor208});
// Differential oracle is the ORIGINAL existing six-key PIM formatter, not the
// new compact implementation or metadata observed from a database.
const closure=readFileSync(new URL('../tools/parity/order-split210-closure.mjs',import.meta.url),'utf8');
const oldFormatter=/function pim\(value,name,bodyHash\)\{return \{[\s\S]+?\};\}/.exec(closure);assert(oldFormatter);
const originalPim=new Function('sha','return ('+oldFormatter[0]+')')(sha);
const originalShapes=program.refs.map(ref=>({ref,before:originalPim(change.before,ref.signature,ref.body_sha256),after:originalPim(change.after,ref.signature,ref.body_sha256),ancestor:originalPim(ancestor208,ref.signature,ref.body_sha256)}));
test('four compact selectors reconstruct the exact old whole20/21 fields on both sides',()=>{
 assert.equal(program.refs.length,4);assert.deepEqual(program.refs.map(r=>r.signature),[key,key,key.slice(7),key.slice(7)]);assert.deepEqual(program.refs.map(r=>r.body_sha256),[false,true,false,true]);
 for(const{ref,before,after,ancestor}of originalShapes){assert.equal(Object.keys(before).length,ref.body_sha256?21:20);for(const value of [before,after])assert.deepEqual(projectOrderSplit210BuyerMetadataShape({change,ancestor208,value}),before);assert.deepEqual(projectOrderSplit210BuyerMetadataShape({change,ancestor208,value:ancestor}),ancestor,'exact208 identity reaches the identical old209 tail input');assert.deepEqual(before.acl,change.before.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]));for(const field of ['argument_modes','argument_names','defaults'])assert(Object.hasOwn(before,field));}
});
test('recognized whole shapes refuse header, orderedACL, extra, definition and bodySHA drift or mixed sides',()=>{
 for(const{before,after,ancestor}of originalShapes){
  const poison=[v=>v.owner='other',v=>v.strict=!v.strict,v=>v.acl=[],v=>v.acl[0][0]='foreign',v=>v.extra=true,v=>v.definition+=' ',v=>v.argument_modes=[],v=>v.configuration=null,v=>v.cost=101,v=>v.rows=1];
  if(Object.hasOwn(after,'body_sha256')){poison.push(v=>{v.definition=ancestor.definition;});poison.push(v=>v.body_sha256='a'.repeat(64));poison.push(v=>v.definition=before.definition);}
  else poison.push(v=>v.body_sha256='a'.repeat(64));
  for(const mutate of poison){const bad=structuredClone(after);mutate(bad);assert.throws(()=>projectOrderSplit210BuyerMetadataShape({change,ancestor208,value:bad}),/exact whole source buyer PIM metadata/);}
 }
 assert.equal(projectOrderSplit210BuyerMetadataShape({change,ancestor208,value:{signature:'public.unrelated()'}}),null);
});
test('source descriptors and caller options are independently pinned; getters never run',()=>{
 for(const side of ['before','after']){const bad=structuredClone(change);bad[side].source+=' ';assert.throws(()=>deriveOrderSplit210BuyerMetadataShapes({change:bad,ancestor208}),/source-authenticated buyer/);}
 assert.throws(()=>deriveOrderSplit210BuyerMetadataShapes({change,ancestor208,ready:true}),/exact buyer source fields/);
 let called=false;const bad=structuredClone(change);Object.defineProperty(bad.before,'definition',{enumerable:true,get(){called=true;return change.before.definition;}});assert.throws(()=>deriveOrderSplit210BuyerMetadataShapes({change:bad,ancestor208}),/data properties only/);assert.equal(called,false);
 const badAncestor=structuredClone(ancestor208);badAncestor.definition+=' ';assert.throws(()=>deriveOrderSplit210BuyerMetadataShapes({change,ancestor208:badAncestor}),/source-authenticated buyer ancestor208/);
 const getterAncestor=structuredClone(ancestor208);Object.defineProperty(getterAncestor,'source',{enumerable:true,get(){called=true;return ancestor208.source;}});assert.throws(()=>deriveOrderSplit210BuyerMetadataShapes({change,ancestor208:getterAncestor}),/data properties only/);assert.equal(called,false);
 const value=structuredClone(originalShapes[0].after);Object.defineProperty(value,'definition',{enumerable:true,get(){called=true;return 'spoof';}});assert.throws(()=>projectOrderSplit210BuyerMetadataShape({change,ancestor208,value}),/data properties only/);assert.equal(called,false);
});
test('fixed SQL preserves whole equality, tagged hashes, ordered grant tuples and strict fallback after caller freshguard',()=>{
 const sql=program.sql;assert(sql.includes("entries->'changes'"));assert(sql.includes("entries->'metadata_compact_shapes'"));assert(sql.includes("entry->'before_check'")&&sql.includes("entry->'after_check'"));assert(sql.includes("entry->'ancestor208_check'"));assert(sql.includes("entries->'metadata_ancestor_records'"));assert(sql.includes("result:=(jsonb_build_object"));assert(sql.includes('IF value=result THEN RETURN value;END IF;'));assert(sql.includes("->'source'->1"));assert(sql.includes('WITH ORDINALITY buyer_acl(a,ordinal)'));assert(sql.includes('ORDER BY ordinal'));assert(sql.includes("jsonb_build_array(a->'grantor',a->'grantee',a->'privilege',a->'grantable')"));
 for(const field of ['definition','owner','language','volatility','strict','leakproof','security_definer','parallel','kind','returns_set','arguments','result','argument_modes','argument_names','defaults','config','cost','rows','acl'])assert(sql.includes("->'"+field+"'"),field);
 assert(sql.includes('OR value=result THEN RETURN result;'));assert(sql.includes("USING ERRCODE='55000'"));assert(!/\b(?:pg_proc|pg_class|CREATE|INSERT|UPDATE|DELETE|COMMIT|EXECUTE|sha256\()\b/.test(sql));
 assert.equal(program.requires_fresh_full210_guard,true);assert.equal(program.requires_authenticated_immutable_basis,true);assert.equal(program.new_runtime_functions,0);assert.equal(program.native_acceptance,false);
});
test('buyer-only dedup frees more than1MB without dropping any other shape or increasing4MiB',()=>{
 assert(program.saved_data_bytes>=1000000);assert(program.compact_ref_bytes<1000);const threeFullBeforeAfterBudget=960000;assert(4129919-559392-program.saved_data_bytes+threeFullBeforeAfterBudget<4194304);assert(Object.isFrozen(program)&&Object.isFrozen(program.refs));assert.equal(program.source_compilation_performed,false);
});
