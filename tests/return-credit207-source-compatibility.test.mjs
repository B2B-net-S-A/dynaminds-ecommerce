import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {RETURN_CREDIT207_SOURCE_CONTRACT as E} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
import {projectReturnCredit207Catalogue as project} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-compatibility.mjs';
import {SCHEMA_VERSION,SQL_SHA256,validateRecoverySchema} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
const counter={relation:'relations',index:'indexes',column:'columns',constraint:'constraints',function:'functions',trigger:'triggers',policy:'policies',type:'types'};
function seal(input){
 const {sha256,...body}=structuredClone(input);body.records.sort((a,b)=>{const x=a.kind+'\0'+a.key,y=b.kind+'\0'+b.key;return x<y?-1:x>y?1:0;});
 for(const key of Object.values(counter))body.counts[key]=body.records.filter(r=>counter[r.kind]===key).length;
 return{...body,sha256:sha(JSON.stringify(canonical(body)))};
}
/** Structural file-only memberships; this fixture never proves Native installation. */
function fixture(){
 const record=(kind,key,fields)=>({kind,key,value:Object.fromEntries(fields.split(',').map(k=>[k,k==='acl'?[]:null]))});
 const records=SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}}));
 for(const key of SOURCE_SELECTION.required_tables)records.push(record('relation',key,'owner,kind,persistence,access_method,row_security,force_row_security,replica_identity,partition,partition_bound,partition_key,options,tablespace,acl_null,acl,view'));
 for(const key of SOURCE_SELECTION.required_functions)records.push(record('function',key,'owner,language,kind,cost,rows,security_definer,leakproof,strict,returns_set,volatility,parallel,support,variadic,argument_names,argument_modes,arguments,result,defaults,source,binary,config,definition,acl_null,acl'));
 records.push(...structuredClone(E.additions));
 return seal({schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts:{...Object.fromEntries(Object.entries(E.counts_before).map(([k,v])=>[k,typeof v==='number'?0:v]))},records});
}
test('full source207 inverse removes all539 records and every catalogue count; predecessor remains unchanged',()=>{
 const input=fixture(),before=structuredClone(input),result=project(input);assert(result.active);assert.equal(result.removed_records,539);assert.deepEqual(input,before);
 assert.equal(result.catalogue.records.length,input.records.length-539);assert.equal(validateRecoverySchema(result.catalogue),result.catalogue);assert(Object.isFrozen(result.catalogue));
 for(const[k,n]of Object.entries(result.removed_counts))assert.equal(result.catalogue.counts[k],input.counts[k]-n);
 assert.equal(result.removed_counts.triggers,124);assert.equal(result.removed_counts.types,16);assert.equal(result.removed_counts.policies,15);
 const again=project(result.catalogue);assert.equal(again.active,false);assert.equal(again.catalogue.sha256,result.catalogue.sha256);
 assert(E.additions.some(r=>r.kind==='trigger'&&r.value.internal&&!r.key.startsWith('public.return_credit206_')),'parent-side FK triggers are included');
});
test('partial206/207, missing descriptors, aliases and extra namespace members refuse projection',()=>{
 const partial=fixture();partial.records=partial.records.filter(r=>!r.key.includes('return_credit206_')||r.key==='public.return_credit206_parent(eid uuid)');assert.throws(()=>project(seal(partial)),/exact complete/);
 for(const kind of Object.keys(counter)){
  const missing=fixture(),i=missing.records.findIndex(r=>r.kind===kind&&r.key.includes('return_credit206_'));assert(i>=0);missing.records.splice(i,1);assert.throws(()=>project(seal(missing)),/exact complete/);
  const extra=fixture(),r=structuredClone(E.additions.find(r=>r.kind===kind));r.key+='__unreviewed';extra.records.push(r);assert.throws(()=>project(seal(extra)),/exact complete/);
 }
});
test('entire descriptors retain function body/header/ACL, RLS, policy, type, index, column, constraint and FK trigger evidence',()=>{
 const changes=[['function','source','changed'],['function','security_definer',false],['function','acl',[]],['relation','force_row_security',false],['policy','roles',['PUBLIC']],['type','owner','dyna_app'],['index','valid',false],['column','not_null',false],['constraint','validated',false],['trigger','enabled','D'],['trigger','constraint_relation','unreviewed']];
 for(const[kind,key,value]of changes){const input=fixture(),r=input.records.find(r=>r.kind===kind&&r.key.includes('return_credit206_')&&JSON.stringify(r.value[key])!==JSON.stringify(value));assert(r,kind+'.'+key);r.value[key]=value;assert.throws(()=>project(seal(input)),/entire source-compiled descriptor/);}
});
test('unrelated predecessor drift remains in the projected value and integrity checks still run',()=>{
 const input=fixture(),row=input.records.find(r=>r.kind==='function'&&!r.key.includes('return_credit206_'));row.value.source='unrelated predecessor drift';
 const result=project(seal(input));assert.equal(result.catalogue.records.find(r=>r.key===row.key).value.source,row.value.source);
 const bad=fixture();bad.sha256='0'.repeat(64);assert.throws(()=>project(bad),/snapshot-integrity/);
});
test('compiled expected pins exact current206/207 source; literal188 remains unchanged',async()=>{
 for(const migration of E.migrations)for(const file of migration.files)assert.equal(sha(await readFile(new URL('../'+file.path,import.meta.url))),file.sha256);
 for(const[file,hash]of [['188_local_consumer_credit.sql','cfa89fad3148555c0d91c5293d5e4727ab80d589681724196b70eb8a798cfbc6'],['188_consumer_credit_structure.sql','a1ab15d6196fe01f4a156a3f0f97d4080811dafe816e3b20ddd0c483ef7527db']])assert.equal(sha(await readFile(new URL('../server/'+file,import.meta.url))),hash);
 assert.equal(E.reviewed,false);assert.equal(E.application_activation,false);assert.equal(E.native_certification,false);
});
