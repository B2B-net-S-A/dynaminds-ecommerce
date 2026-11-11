/** Static coverage of the startup ACL normalizer's contract list (server/ordinary-legacy-schema.mjs) against every
 * source contract of 207/208/209 and of migration-manifest.mjs. pg_dump omits an explicit ACL equal to the owner's
 * default, so a restored database has NULL there; the normalizer may materialize it only for a record of a listed
 * contract. A release migration whose added relation/schema keeps an explicit owner-only ACL and is missing from the
 * list makes every restored-from-dump database refuse at start ("NNN exact complete addition descriptor" or
 * "NNN requires completeMMM predecessor"). No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {RELEASE_MIGRATIONS} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
import {PACKING189_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-contract.mjs';
const DIR='../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/';
const source=readFileSync(new URL('../server/ordinary-legacy-schema.mjs',import.meta.url),'utf8');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
const relationOrSchema=r=>r&&(r.kind==='relation'||r.kind==='schema');
// Superset of pg_dump's default-equivalent ACL: only the owner postgres, granted by itself, nothing grantable.
const ownerOnly=v=>v&&v.acl_null===false&&Array.isArray(v.acl)&&v.acl.length>0&&v.acl.every(a=>a.grantor==='postgres'&&a.grantee==='postgres'&&a.grantable===false);

async function contract(name){
 const module=await import(new URL(DIR+name+'-source-contract.mjs',import.meta.url));
 const found=Object.entries(module).filter(([,v])=>v&&typeof v==='object'&&Array.isArray(v.additions));
 assert.equal(found.length,1,name+': exactly one exported source contract with additions');
 return {file:name,name:found[0][0],value:found[0][1]};
}
const contracts=await Promise.all(['return-credit207','return-credit208','order-merge-delivery209',...RELEASE_MIGRATIONS.map(m=>m.cold.contract)].map(contract));
/** The contracts a dump restore needs in the list, and the listed ones missing from it. */
export function missingNormalizerContracts(listed,all){
 const required=all.filter(c=>c.value.additions.some(r=>relationOrSchema(r)&&ownerOnly(r.value)));
 return {required:required.map(c=>c.name),missing:required.filter(c=>!listed.includes(c.name)).map(c=>c.name)};
}
const imports=new Map([...source.matchAll(/^import \{([A-Z0-9_]+_SOURCE_CONTRACT)\} from '([^']+)';$/gm)].map(m=>[m[1],m[2]]));
const loop=source.match(/for\(const contract of \[([^\]]+)\]\)/);
assert(loop,'normalizer contract loop');
const listed=loop[1].split(',').map(s=>s.trim());

test('the normalizer list covers every source contract whose added relation/schema keeps an explicit owner-only ACL',()=>{
 const {required,missing}=missingNormalizerContracts(listed,contracts);
 assert.deepEqual(missing,[],'add these contracts (import + list) to server/ordinary-legacy-schema.mjs normalizeOrdinaryLegacyOwnerAcls');
 // 30.10.2026 (dump of a HEAD database, ledger 263): 207, 209, 211, 219, 220, 221, 223, 224, 236, 237, 239, 244, 248, 261.
 assert.ok(required.length>=14);
 for(const name of ['CRM219_SOURCE_CONTRACT','BASE_WIRE220_SOURCE_CONTRACT','STOCKTAKE_EVIDENCE_USAGE261_SOURCE_CONTRACT'])assert(required.includes(name),name);
});

test('every listed contract is imported from its own source-contract module, once, in migration order',()=>{
 assert.equal(new Set(listed).size,listed.length);
 const order=contracts.map(c=>c.name);
 assert.deepEqual(listed,[...listed].sort((a,b)=>order.indexOf(a)-order.indexOf(b)));
 for(const name of listed){
  const c=contracts.find(x=>x.name===name);assert(c,name+' is a 207/208/209 or release-manifest contract');
  assert.equal(imports.get(name),DIR+c.file+'-source-contract.mjs',name+' import path');
 }
 assert.deepEqual([...imports.keys()].sort(),[...listed].sort(),'no unused or unlisted contract import');
});

test('the normalizer reads additions only: no contract changes a relation/schema into an explicit owner-only ACL',()=>{
 // A change whose after-descriptor is owner-only would also lose its ACL in a dump; the normalizer then needs the change
 // (not only the additions) as its expectation. Refuse until that is implemented and reviewed.
 const changed=contracts.flatMap(c=>(c.value.changes??[]).filter(x=>relationOrSchema(x.after)&&ownerOnly(x.after.value)).map(x=>c.file+':'+x.after.key));
 assert.deepEqual(changed,[]);
});

test('the listed additions never conflict with the legacy189 expectation or each other (the start would always refuse)',()=>{
 const expected=new Map(PACKING189_CONTRACT.dependency_compilation.object_hashes);
 for(const name of listed)for(const r of contracts.find(c=>c.name===name).value.additions)if(relationOrSchema(r)){
  const key=sha(r.kind+'\0'+r.key),value=sha(JSON.stringify(canonical(r)));
  assert(!expected.has(key)||expected.get(key)===value,'legacy-owner-acl-source-expectation-conflict:'+name+':'+r.key);expected.set(key,value);
 }
});

test('refusal: a new release contract with an owner-only addition that is not listed is reported missing',()=>{
 const sequence={kind:'relation',key:'public.future264_ids_id_seq',value:{owner:'postgres',kind:'S',acl_null:false,acl:['SELECT','UPDATE','USAGE'].map(privilege=>({grantor:'postgres',grantee:'postgres',privilege,grantable:false}))}};
 const future={file:'future264',name:'FUTURE264_SOURCE_CONTRACT',value:{additions:[sequence],changes:[]}};
 assert.deepEqual(missingNormalizerContracts(listed,[...contracts,future]).missing,['FUTURE264_SOURCE_CONTRACT']);
 // A relation granted to dyna_app keeps an explicit ACL in the dump and needs no entry.
 const granted={...future,value:{additions:[{...sequence,value:{...sequence.value,acl:[...sequence.value.acl,{grantor:'postgres',grantee:'dyna_app',privilege:'USAGE',grantable:false}]}}],changes:[]}};
 assert.deepEqual(missingNormalizerContracts(listed,[...contracts,granted]).missing,[]);
 // Dropping a needed contract from the list is reported (the 23.10 refusal: Source219 missing).
 assert.deepEqual(missingNormalizerContracts(listed.filter(n=>n!=='CRM219_SOURCE_CONTRACT'),contracts).missing,['CRM219_SOURCE_CONTRACT']);
});
