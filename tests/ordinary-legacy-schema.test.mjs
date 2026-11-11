/** Actual normalizer and source-compiled207/208/209 inverses. Metadata/query
 * ports and the legacy189 hash fixture are controlled; no PG/startup acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {RETURN_CREDIT208_SOURCE_CONTRACT as E} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit208-source-contract.mjs';
import {RETURN_CREDIT207_SOURCE_CONTRACT as P} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as M} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {projectPackingOrderMergeDelivery209Catalogue as project209} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs';
import {projectReturnCredit208Catalogue as project208} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit208-source-compatibility.mjs';
import {projectReturnCredit207Catalogue as project207} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-compatibility.mjs';
import {SCHEMA_VERSION,SQL_SHA256,validateRecoverySchema} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
const source=readFileSync(new URL('../server/ordinary-legacy-schema.mjs',import.meta.url),'utf8');
// The real later (211..261) contracts the normalizer imports; their additions are new keys beside the controlled189 fixture.
const successorContracts=Object.fromEntries(await Promise.all([...source.matchAll(/^import \{([A-Z0-9_]+_SOURCE_CONTRACT)\} from '([^']+)';$/gm)]
 .filter(m=>!/^(RETURN_CREDIT20[78]|ORDER_MERGE_DELIVERY209)_/.test(m[1])).map(async m=>[m[1],(await import(new URL(m[2],new URL('../server/',import.meta.url))))[m[1]]])));
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
const counter={schema:'schemas',relation:'relations',index:'indexes',column:'columns',constraint:'constraints',function:'functions',trigger:'triggers',policy:'policies',type:'types'};
const grants=['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'].map(privilege=>({grantor:'postgres',grantee:'postgres',privilege,grantable:false}));
function seal(input){
 const {sha256,...body}=structuredClone(input);body.records.sort((a,b)=>(a.kind+'\0'+a.key)<(b.kind+'\0'+b.key)?-1:1);
 for(const [kind,key]of Object.entries(counter))if(kind!=='schema')body.counts[key]=body.records.filter(r=>r.kind===kind).length;
 return validateRecoverySchema({...body,sha256:sha(JSON.stringify(canonical(body)))});
}
function fixture(){
 const record=(kind,key,fields)=>({kind,key,value:Object.fromEntries(fields.split(',').map(k=>[k,k==='acl'?[]:k==='acl_null'?false:null]))});
 const records=SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'CREATE',grantable:false},{grantor:'postgres',grantee:'postgres',privilege:'USAGE',grantable:false}]}}));
 for(const key of new Set([...SOURCE_SELECTION.required_tables,'ordinary187_private.contexts','ordinary187_private.journal'])){
  const r=record('relation',key,'owner,kind,persistence,access_method,row_security,force_row_security,replica_identity,partition,partition_bound,partition_key,options,tablespace,acl_null,acl,view');Object.assign(r.value,{owner:'postgres',kind:'r',row_security:false,acl:structuredClone(grants)});records.push(r);
 }
 const sequence=record('relation','public.controlled_restore_id_seq','owner,kind,persistence,access_method,row_security,force_row_security,replica_identity,partition,partition_bound,partition_key,options,tablespace,acl_null,acl,view');Object.assign(sequence.value,{owner:'postgres',kind:'S',acl:['SELECT','UPDATE','USAGE'].map(privilege=>({grantor:'postgres',grantee:'postgres',privilege,grantable:false}))});records.push(sequence);
 for(const key of SOURCE_SELECTION.required_functions)records.push(record('function',key,'owner,language,kind,cost,rows,security_definer,leakproof,strict,returns_set,volatility,parallel,support,variadic,argument_names,argument_modes,arguments,result,defaults,source,binary,config,definition,acl_null,acl'));
 for(const r of P.additions){const c=E.changes.find(c=>c.kind===r.kind&&c.key===r.key);records.push(c?{kind:r.kind,key:r.key,value:structuredClone(c.after)}:structuredClone(r));}
 records.push(...structuredClone(E.additions));
 for(const c of M.changes){const index=records.findIndex(r=>r.kind===c.kind&&r.key===c.key),r={kind:c.kind,key:c.key,value:structuredClone(c.after)};if(index>=0)records[index]=r;else records.push(r);}
 records.push(...structuredClone(M.additions));
 return seal({schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts:Object.fromEntries(Object.entries(E.counts_before).map(([k,v])=>[k,typeof v==='number'?0:v])),records});
}
const trusted=fixture();
const legacy=x=>project207(project208(project209(x).catalogue).catalogue).catalogue;
const legacyExpected=legacy(trusted);
const legacyHashes=legacyExpected.records.map(r=>[sha(r.kind+'\0'+r.key),sha(JSON.stringify(canonical(r)))]);
const five=[...P.additions,...E.additions,...M.additions].filter(r=>r.kind==='relation'&&['r','p','v','m','S'].includes(r.value.kind)&&r.value.acl_null===false&&r.value.acl.length>0&&r.value.acl.every(a=>a.grantor==='postgres'&&a.grantee==='postgres'&&a.grantable===false)).map(r=>r.key);
assert.deepEqual([...five].sort(),['public.order_merge_delivery209_manifest','public.order_merge_delivery209_projection_basis','public.order_merge_delivery209_receipts','public.return_credit206_admissions','public.return_credit206_manifest']);
function restored(keys){const value=structuredClone(trusted);for(const key of keys){const row=value.records.find(r=>r.key===key&&(r.kind==='relation'||r.kind==='schema'));assert(row);row.value.acl_null=true;}return seal(value);}
function normalizer(input,{compareError,afterDrift}={}){
 const events=[],saved=structuredClone(input);let live=structuredClone(input),rawReads=0,strictReads=0,comparisons=0;
 const owner={async query(sql){events.push(sql);if(sql==='ROLLBACK')live=structuredClone(saved);if(sql.startsWith('GRANT ')){
  const schema=sql.includes('ON SCHEMA '),privateTable=sql.includes('"ordinary187_private".'),sequence=sql.includes('ON SEQUENCE ');
  const name=schema?'ordinary187_private':privateTable?'ordinary187_private.'+sql.match(/\."([^"]+)"/)[1]:'public.'+sql.match(/public\."([^"]+)"/)[1];
  const row=live.records.find(r=>r.kind===(schema?'schema':'relation')&&r.key===name);assert(row);if(sequence)assert.equal(row.value.kind,'S');row.value.acl_null=false;
 }return{rows:[]};}};
 const selected={controlled:true};const ports={assert,createHash,PACKING189_CONTRACT:{dependency_compilation:{object_hashes:legacyHashes}},RETURN_CREDIT207_SOURCE_CONTRACT:P,RETURN_CREDIT208_SOURCE_CONTRACT:E,ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT:M,...successorContracts,validateRecoverySchema,
  derivePackingColdIdentity:async client=>{assert.equal(client,owner);events.push('identity');return selected;},
  readPackingCatalogue:async(client,identity)=>{assert.equal(client,owner);assert.equal(identity,selected);events.push('raw-read');rawReads++;return seal(live);},
  observePackingColdCatalogue:async client=>{assert.equal(client,owner);events.push('strict-observe');strictReads++;if(afterDrift)afterDrift(live);const catalogue=seal(live);legacy(catalogue);return{catalogue};},
  comparePackingCompiledExpectation:(expected,catalogue)=>{events.push('full-compare');comparisons++;assert.equal(expected,ports.PACKING189_CONTRACT.dependency_compilation);assert.deepEqual(canonical(legacy(catalogue).records),canonical(legacyExpected.records),'whole controlled189 baseline after REAL209/208/207 inverses');if(compareError&&comparisons===2)throw compareError;},
 };
 // Evaluate the actual digest/normalizer implementation; only IO and the
 // independently declared legacy fixture's compilation hashes are controlled.
 const start=source.indexOf('const canonical=');assert(start>=0);
 const fn=new Function(...Object.keys(ports),source.slice(start).replace('export async function','async function')+'\nreturn normalizeOrdinaryLegacyOwnerAcls;')(...Object.values(ports));
 return{run:()=>fn(owner),events,live:()=>seal(live),reads:()=>({rawReads,strictReads,comparisons})};
}
test('actual normalizer composes real209 then208 before207, with raw reader before source checks',async()=>{
 assert(source.includes('readPackingCatalogue(owner,await derivePackingColdIdentity(owner))'));
 const input=trusted,saved=structuredClone(input);
 assert.throws(()=>project207(project209(input).catalogue),/source207 entire source-compiled descriptor/);
 const model=normalizer(input);assert.deepEqual(await model.run(),{owner_default_acls_materialized:0});
 assert.deepEqual(model.events,['BEGIN',"SET LOCAL search_path=pg_catalog,public;SET LOCAL timezone='UTC';SET LOCAL jit=off;SET LOCAL statement_timeout='8s';SET LOCAL lock_timeout='8s'",'SELECT pg_advisory_xact_lock(982376)','identity','raw-read','full-compare','COMMIT']);assert.deepEqual(canonical(input),canonical(saved));
});
test('historical205/207/208 retain inactive successor compatibility and no ACL writes',async()=>{
 for(const input of [project209(trusted).catalogue,project208(project209(trusted).catalogue).catalogue,legacyExpected]){const model=normalizer(input);assert.deepEqual(await model.run(),{owner_default_acls_materialized:0});assert.equal(model.events.at(-1),'COMMIT');assert(!model.events.some(s=>s.startsWith('GRANT ')));}
});
test('restored five later tables refuse the old strict first-observe path, then repair with full checks before and after',async()=>{
 const input=restored(five);assert.throws(()=>legacy(input),/209.*addition|209.*descriptor/);
 const model=normalizer(input);assert.deepEqual(await model.run(),{owner_default_acls_materialized:5});assert.deepEqual(model.live().records,trusted.records);
 assert.equal(model.events.filter(s=>s.startsWith('GRANT ')).length,5);assert(model.events.indexOf('full-compare')<model.events.findIndex(s=>s.startsWith('GRANT ')));assert(model.events.indexOf('strict-observe')>model.events.findLastIndex(s=>s.startsWith('GRANT ')));assert.deepEqual(model.reads(),{rawReads:1,strictReads:1,comparisons:2});
 const again=normalizer(model.live());assert.deepEqual(await again.run(),{owner_default_acls_materialized:0});assert(!again.events.some(s=>s.startsWith('GRANT ')));
});
test('legacy table/private tables/schema/sequence repair composes with all five source-compiled additions',async()=>{
 const extra=[SOURCE_SELECTION.required_tables.find(k=>k.startsWith('public.')),'ordinary187_private.contexts','ordinary187_private.journal','ordinary187_private','public.controlled_restore_id_seq'];const model=normalizer(restored([...five,...extra]));assert.deepEqual(await model.run(),{owner_default_acls_materialized:10});assert.deepEqual(model.live().records,trusted.records);assert(model.events.includes('GRANT ALL PRIVILEGES ON SEQUENCE public."controlled_restore_id_seq" TO postgres'));assert(model.events.includes('GRANT ALL ON SCHEMA "ordinary187_private" TO postgres'));
});
test('wrong owner, effective ACL, full header, missing or extra209 object and unrepairable foreign drift refuse before ANY GRANT',async()=>{
 const mutations=[
  x=>{x.records.find(r=>r.key===five[0]).value.owner='dyna_app';},
  x=>{x.records.find(r=>r.key===five[0]).value.acl.push({grantor:'postgres',grantee:'dyna_app',privilege:'SELECT',grantable:false});},
  x=>{x.records.find(r=>r.key===five[0]).value.force_row_security=!x.records.find(r=>r.key===five[0]).value.force_row_security;},
  x=>{x.records=x.records.filter(r=>r.key!=='public.order_merge_delivery209_manifest');},
  x=>{const r=structuredClone(M.additions.find(r=>r.kind==='function'));r.key=r.key.replace('(', '_foreign(');x.records.push(r);},
  x=>{const r=x.records.find(r=>r.kind==='relation'&&r.key.startsWith('public.')&&!five.includes(r.key));r.value.row_security=!r.value.row_security;},
 ];
 for(const mutate of mutations){const x=structuredClone(restored(five));mutate(x);const model=normalizer(seal(x));await assert.rejects(model.run());assert.equal(model.events.at(-1),'ROLLBACK');assert(!model.events.some(s=>s.startsWith('GRANT ')));}
});
test('partial or changed208 refuses before any grant and preserves the original failure',async()=>{
 for(const mutate of [x=>{x.records=x.records.filter(r=>r.key!==E.additions[0].key);},x=>{x.records.find(r=>r.key===E.changes[0].key).value.source+=' unreviewed';}]){const input=structuredClone(restored(five));mutate(input);const model=normalizer(seal(input));await assert.rejects(model.run());assert.equal(model.events.at(-1),'ROLLBACK');assert(!model.events.some(s=>s.startsWith('GRANT ')));}
});
test('closing unrelated drift or comparison failure rolls back ALL grants and leaves the input untouched',async()=>{
 const input=restored(five),saved=structuredClone(input),error=Error('controlled unrelated closing policy drift');const model=normalizer(input,{compareError:error});await assert.rejects(model.run(),e=>e===error);assert.equal(model.events.at(-1),'ROLLBACK');assert.deepEqual(model.live().records,input.records);assert.deepEqual(canonical(input),canonical(saved));
 const changed=normalizer(input,{afterDrift:x=>{x.records.find(r=>r.key==='public.order_merge_delivery209_receipts'&&r.kind==='relation').value.row_security=false;}});await assert.rejects(changed.run());assert.equal(changed.events.at(-1),'ROLLBACK');assert.deepEqual(changed.live().records,input.records);
});
