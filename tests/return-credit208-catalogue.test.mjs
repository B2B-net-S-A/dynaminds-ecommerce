/** Actual compiled descriptors in structural memberships. No Native authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RETURN_CREDIT208_SOURCE_CONTRACT as E} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit208-source-contract.mjs';
import {RETURN_CREDIT207_SOURCE_CONTRACT as P} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
import {projectReturnCredit208Catalogue as project} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit208-source-compatibility.mjs';
import {projectReturnCredit207Catalogue as predecessor} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-compatibility.mjs';
import {SCHEMA_VERSION,SQL_SHA256,validateRecoverySchema} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x,sha=x=>createHash('sha256').update(x).digest('hex');
const counter={relation:'relations',index:'indexes',column:'columns',constraint:'constraints',function:'functions',trigger:'triggers',policy:'policies',type:'types'};
function seal(input){
 const {sha256,...body}=structuredClone(input);body.records.sort((a,b)=>(a.kind+'\0'+a.key)<(b.kind+'\0'+b.key)?-1:1);
 for(const key of Object.values(counter))body.counts[key]=body.records.filter(r=>counter[r.kind]===key).length;
 return{...body,sha256:sha(JSON.stringify(canonical(body)))};
}
function fixture(){
 const record=(kind,key,fields)=>({kind,key,value:Object.fromEntries(fields.split(',').map(k=>[k,k==='acl'?[]:null]))});
 const records=SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}}));
 for(const key of SOURCE_SELECTION.required_tables)records.push(record('relation',key,'owner,kind,persistence,access_method,row_security,force_row_security,replica_identity,partition,partition_bound,partition_key,options,tablespace,acl_null,acl,view'));
 for(const key of SOURCE_SELECTION.required_functions)records.push(record('function',key,'owner,language,kind,cost,rows,security_definer,leakproof,strict,returns_set,volatility,parallel,support,variadic,argument_names,argument_modes,arguments,result,defaults,source,binary,config,definition,acl_null,acl'));
 records.push(...P.additions.map(r=>{const c=E.changes.find(c=>c.kind===r.kind&&c.key===r.key);return c?{kind:r.kind,key:r.key,value:structuredClone(c.after)}:structuredClone(r);}),...structuredClone(E.additions));
 return seal({schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts:Object.fromEntries(Object.entries(E.counts_before).map(([k,v])=>[k,typeof v==='number'?0:v])),records});
}
test('compiled208 exact inverse composes with207 and strict inactive205 is identity on repeated nested comparison',()=>{
 const input=fixture(),saved=structuredClone(input),p=project(input);assert(p.active);assert.equal(p.removed_records,28);assert.equal(p.changed_records,2);assert.equal(p.authority,false);assert.equal(validateRecoverySchema(p.catalogue),p.catalogue);assert.deepEqual(input,saved);
 for(const c of E.changes)assert.deepEqual(canonical(p.catalogue.records.find(r=>r.kind===c.kind&&r.key===c.key).value),canonical(c.before));
 for(const[k,n]of Object.entries(p.removed_counts))assert.equal(p.catalogue.counts[k],input.counts[k]-n);
 const after207=project(p.catalogue);assert.equal(after207.active,false);assert.equal(after207.catalogue,p.catalogue);
 const full205=predecessor(p.catalogue);assert(full205.active);assert.equal(project(full205.catalogue).catalogue,full205.catalogue);assert.equal(project(full205.catalogue).active,false);
});
test('partial/missing/extra208 namespace, either changed descriptor or bad integrity cannot be projected',()=>{
 for(const kind of Object.keys(counter)){
  const missing=fixture(),i=missing.records.findIndex(r=>r.kind===kind&&r.key.includes('return_credit208_'));assert(i>=0);missing.records.splice(i,1);assert.throws(()=>project(seal(missing)),/addition-roster/);
  const extra=fixture(),r=structuredClone(E.additions.find(r=>r.kind===kind));r.key+='__unreviewed';extra.records.push(r);assert.throws(()=>project(seal(extra)),/addition-roster/);
 }
 for(const c of E.changes){const bad=fixture();bad.records.find(r=>r.key===c.key).value.source+=' tamper';assert.throws(()=>project(seal(bad)),/changed-descriptor/);}
 const bad=fixture();bad.sha256='0'.repeat(64);assert.throws(()=>project(bad),/snapshot-integrity/);
});
test('inactive208 requires literal207 when206 exists; mixed upgrade and source206-only remain refusals',()=>{
 const p=project(fixture()).catalogue;
 for(const c of E.changes){const bad=structuredClone(p);bad.records.find(r=>r.key===c.key).value=structuredClone(c.after);assert.throws(()=>project(seal(bad)),/exact207-before/);}
 const partial=structuredClone(p);partial.records=partial.records.filter(r=>!r.key.includes('return_credit206_')||r.key.includes('return_credit206_parent('));assert.throws(()=>project(seal(partial)),/overload-missing/);
});
test('source review pins actual compiler and QA while Native business acceptance/activation remain false',()=>{
 assert.equal(E.compiler_receipt_sha256,'b52b3ab3d28b5dca944a7a14936d1118dd724510e23911dcc7d4e6fe44064381');assert.equal(E.compiler_delta_gzip_sha256,'3d6147ff42c3baf995985b031c1749825a90f14500c277d42a899738f909a91b');
 assert(E.source_compilation_proven&&E.source_reviewed&&E.old_certificate_rows_not_updated);assert.equal(E.root_review_receipt_sha256,'bb8f0c73f18281c941f8a378323016ada241e49e7d106586dbaa09ba7fb816f4');
 assert.equal(E.application_activation,false);assert.equal(E.native_certification,false);assert.equal(E.reviewed,false);assert.equal(E.native_guard_qa.exit.exit_code,0);
});
