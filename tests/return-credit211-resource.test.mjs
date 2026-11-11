/** Pure resource/SQL-literal tests, no PG/HTTP/runtime factory or app build. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {assembleReturnCredit211SourceCandidate} from '../tools/parity/return-credit211-source.mjs';
import {buildReturnCredit211Resource,RETURN_CREDIT211_RESOURCE_DEFINITION,RETURN_CREDIT211_RESOURCE_MIGRATION,RETURN_CREDIT211_NATIVE_RESOURCE} from '../tools/parity/return-credit211-resource.mjs';
import {RETURN_CREDIT211_SOURCE_CONTRACT as E211,RETURN_CREDIT211_SOURCE_ORIGIN as ORIGIN} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-contract.mjs';
const read=p=>fs.readFile(new URL('../'+p,import.meta.url),'utf8'),hash=s=>createHash('sha256').update(s).digest('hex');
const [source148,source206,source207,nativeSql]=await Promise.all(['server/148_return_destinations.sql','server/206_return_credit_destinations_history.sql','server/207_consumer_return_credit.sql','server/211_return_credit148_acceptance.sql'].map(read));
const input={source148,source206,source207,nativeSql},candidate=assembleReturnCredit211SourceCandidate(input);
const id=r=>r.kind+'\0'+r.key,order=(a,b)=>id(a)<id(b)?-1:id(a)>id(b)?1:0;

test('full install is the whole reviewed candidate plus one literal source seal, never the core alone',()=>{
 const r=buildReturnCredit211Resource(input);
 assert.equal(r.sql,candidate.sql+r.seal.sql);assert.equal(r.sql.slice(0,candidate.sql.length),candidate.sql);
 assert.equal(r.candidate.bytes,205593);assert.equal(r.candidate.sha256,'dd4b84617213f88f99e38aa43028785da422dddafb4b5f0035c9343a7f2535ac');
 assert.equal(r.bytes,Buffer.byteLength(r.sql));assert.equal(r.sha256,hash(r.sql));assert(r.bytes<=16777216);
 assert.equal((r.seal.sql.match(/INSERT INTO public\.return_credit211_metadata/g)||[]).length,1);
 assert(!/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(r.sql));
 for(const c of candidate.function_changes)assert(r.sql.includes(c.after.replace('CREATE FUNCTION ','CREATE OR REPLACE FUNCTION ')));
 assert(r.sql.includes('FOREIGN KEY(tenant_id,return_receipt_id) REFERENCES public.return_credit211_acceptances(tenant_id,id)'));
 assert(!/UPDATE (?:public\.)?(?:return_credit206_manifest|return_credit208_manifest|order_merge_delivery209_manifest)\b/i.test(r.sql));
});

test('the three seal literals recover every compiled field and exact authored array order',()=>{
 const r=buildReturnCredit211Resource(input),literals=[...r.seal.sql.matchAll(/'((?:''|[^'])*)'::jsonb/g)].map(m=>JSON.parse(m[1].replaceAll("''","'")));
 assert.equal(literals.length,3);assert.deepEqual(literals[0],[...E211.additions].sort(order));
 assert.deepEqual(literals[1],candidate.descriptor_changes);assert.deepEqual(literals[2],candidate.removed_records);
 assert.equal(literals[0].length,140);assert.equal(literals[1].length,6);assert.equal(literals[2].length,2);
 assert(literals[0].some(r=>r.kind==='function'&&r.value.source.includes("'")),'real function text exercises apostrophe escaping');
 assert(r.seal.sql.includes("current_setting('standard_conforming_strings') IS DISTINCT FROM 'on'"));
 const statements=r.seal.sql.replace(/'(?:''|[^'])*'/g,"''");
 assert(!statements.includes('pg_catalog.'),'expected new metadata never comes from a live catalogue');
});

test('existing history rows retain their actual timestamps; only new metadata is Source-compiled',()=>{
 const r=buildReturnCredit211Resource(input);
 for(const table of ['return_credit206_manifest','return_credit208_manifest','order_merge_delivery209_manifest'])assert(r.seal.sql.includes('(SELECT to_jsonb(m) FROM public.'+table+' m WHERE id)'));
 assert(r.seal.sql.includes("'"+ORIGIN.compiler_sha256+"'"));
 assert.deepEqual(r.source_authority,{compiler_sha256:ORIGIN.compiler_sha256,compiler_receipt_sha256:ORIGIN.compiler_receipt_sha256,root_review_sha256:ORIGIN.root_review_sha256});
 assert.equal(r.source_compilation_proven,true);assert.equal(r.source_compilation_performed,false);
 for(const k of ['native_certification','application_activation','business_acceptance'])assert.equal(r[k],false,k);
 assert.equal(r.pg_calls,0);assert.equal(r.network_requests,0);
});

test('one complete ordinary SQL member has an exact optional Native identity alias and209 parent',()=>{
 const r=buildReturnCredit211Resource(input);
 assert.deepEqual(r.definition,RETURN_CREDIT211_RESOURCE_DEFINITION);assert.deepEqual(r.migration,RETURN_CREDIT211_RESOURCE_MIGRATION);
 assert.equal(r.definition.source,'server/211_return_credit148_acceptance_install.sql');
 assert.equal(r.migration.file,'211_return_credit148_acceptance_install.sql');assert.equal(r.migration.parent,209);assert.equal(r.migration.installs_split210,false);
 assert.deepEqual(r.native_edge,{...RETURN_CREDIT211_NATIVE_RESOURCE,sha256:r.sha256});
 assert.deepEqual(r.storage,{path:r.native_edge.path,bytes:r.bytes,sha256:r.sha256,encoding:'identity'});
 assert(Object.isFrozen(r));assert(Object.isFrozen(r.source_authority));
});

test('no caller-provided expectation, approval, SQL suffix, callback or source drift can authorize a seal',()=>{
 for(const key of Object.keys(input))assert.throws(()=>buildReturnCredit211Resource({...input,[key]:input[key]+'\n'}),key);
 for(const extra of [{expected:E211},{approved:true},{seal:'SELECT 1;'},{native_certification:true},{callback:()=>{}}])assert.throws(()=>buildReturnCredit211Resource({...input,...extra}));
 for(const bad of [null,undefined,[],{},Buffer.from('x')])assert.throws(()=>buildReturnCredit211Resource(bad));
 const accessor={...input};Object.defineProperty(accessor,'source148',{enumerable:true,get(){throw Error('must not execute getter');}});assert.throws(()=>buildReturnCredit211Resource(accessor),/literal source inputs/);
 assert.throws(()=>buildReturnCredit211Resource(input,{}));
});

test('actual producer refuses a missing or unproved fixed vector and full AFTER poison',async()=>{
 // Substitute only the module's fixed-data import in a controlled module copy.
 // Run the real producer, never a mirror implementation or a runtime callback.
 const source=await read('tools/parity/return-credit211-resource.mjs');
 const helperLine="import {assembleReturnCredit211SourceCandidate} from './return-credit211-source.mjs';";
 const authorityLine="import {RETURN_CREDIT211_SOURCE_CONTRACT as E211,RETURN_CREDIT211_SOURCE_ORIGIN as ORIGIN} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-contract.mjs';";
 assert.equal(source.split(helperLine).length,2);assert.equal(source.split(authorityLine).length,2);
 async function producer(e,o){
  const text=source.replace(helperLine,()=>"import {assembleReturnCredit211SourceCandidate} from "+JSON.stringify(new URL('../tools/parity/return-credit211-source.mjs',import.meta.url).href)+';')
   .replace(authorityLine,()=>'const E211='+JSON.stringify(e)+';const ORIGIN='+JSON.stringify(o)+';');
  return(await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'))).buildReturnCredit211Resource;
 }
 for(const[e,o]of [[null,ORIGIN],[E211,{...ORIGIN,source_compilation_proven:false}],[E211,{...ORIGIN,independent_empty_source_database:false}],[{...E211,additions:E211.additions.slice(1)},ORIGIN],[E211,{...ORIGIN,sql_sha256:'0'.repeat(64)}]]){
  const build=await producer(e,o);assert.throws(()=>build(input));
 }
 const poisoned=structuredClone(E211);poisoned.changes.find(r=>r.kind==='function').after.source+='\n';
 const poisonedBuild=await producer(poisoned,ORIGIN);assert.throws(()=>poisonedBuild(input),/six complete AFTER/);
 const postNative=await producer(E211,{...ORIGIN,native_certification:true});
 assert.equal(postNative(input).native_certification,false,'emission never mints installed Native acceptance');
});
