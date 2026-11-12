/** Inert on import. Owner-only startup repair of pg_dump's omitted default ACL
 * representation, bound to the complete source-compiled relation descriptor. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RETURN_CREDIT207_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
import {RETURN_CREDIT208_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit208-source-contract.mjs';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {RETURN_CREDIT211_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-contract.mjs';
import {CRM219_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm219-source-contract.mjs';
import {BASE_WIRE220_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire220-source-contract.mjs';
import {BASE_WIRE221_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire221-source-contract.mjs';
import {RETURN_REASONS223_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-reasons223-source-contract.mjs';
import {BASE_WIRE_CATEGORIES224_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/base-wire-categories224-source-contract.mjs';
import {BUYER_AVAILABLE236_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/buyer-available236-source-contract.mjs';
import {AUTH_SECURITY237_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/auth-security237-source-contract.mjs';
import {WZ_ISSUER239_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/wz-issuer239-source-contract.mjs';
import {CUSTOM_EVENTS_CHECKSUMS244_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/custom-events-checksums244-source-contract.mjs';
import {GUARD_VERDICTS248_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/guard-verdicts248-source-contract.mjs';
import {STOCKTAKE_EVIDENCE_USAGE261_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/stocktake-evidence-usage261-source-contract.mjs';
import {ACCOUNTANT_ORDER_SETTINGS266_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/accountant-order-settings266-source-contract.mjs';
import {STATUS_CATEGORIES_AUTOMATION_EDITORS267_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/status-categories-automation-editors267-source-contract.mjs';
import {ORDER_WAREHOUSE_TRANSFER269_SOURCE_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-warehouse-transfer269-source-contract.mjs';
import {derivePackingColdIdentity,readPackingCatalogue,validateRecoverySchema} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {PACKING189_CONTRACT} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-contract.mjs';
import {observePackingColdCatalogue,comparePackingCompiledExpectation} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sha=x=>createHash('sha256').update(x).digest('hex');
// Same canonical bytes as the bounded reader, without cloning the complete catalogue.
function catalogueDigest(value){
 const h=createHash('sha256'),visit=v=>{
  if(v===null||typeof v!=='object'){h.update(JSON.stringify(v));return;}
  if(Array.isArray(v)){h.update('[');for(let i=0;i<v.length;i++){if(i)h.update(',');visit(v[i]);}h.update(']');return;}
  h.update('{');const keys=Object.keys(Object.fromEntries(Object.keys(v).sort().map(k=>[k,null])));
  for(let i=0;i<keys.length;i++){if(i)h.update(',');h.update(JSON.stringify(keys[i])+':');visit(v[keys[i]]);}h.update('}');
 };visit(value);return h.digest('hex');
}
export async function normalizeOrdinaryLegacyOwnerAcls(owner){
 await owner.query('BEGIN');
 try{
  await owner.query("SET LOCAL search_path=pg_catalog,public;SET LOCAL timezone='UTC';SET LOCAL jit=off;SET LOCAL statement_timeout='8s';SET LOCAL lock_timeout='8s'");
  await owner.query('SELECT pg_advisory_xact_lock(982376)');
  // The strict inverse cannot accept a restored default-equivalent NULL ACL.
  // Read bounded metadata first; the complete proposed graph must pass the
  // unchanged source comparison BEFORE the first GRANT. No observed row is an expectation.
  const first=await readPackingCatalogue(owner,await derivePackingColdIdentity(owner));
  const expected=new Map(PACKING189_CONTRACT.dependency_compilation.object_hashes),targets=[],replacements=new Map();
  // Every release contract whose added relation/schema keeps an explicit owner-only ACL (pg_dump omits it as the
  // default): 211 tables, 219-224 ID sequences, 236-261 verdict/usage tables,
  // 266 accountant invitation/membership tables, 267 automation editors, 269 order warehouse transfers. tests/ordinary-legacy-schema-contracts.test.mjs
  // derives the required set from migration-manifest.mjs and refuses a new migration missing here.
  for(const contract of [RETURN_CREDIT207_SOURCE_CONTRACT,RETURN_CREDIT208_SOURCE_CONTRACT,ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT,
   RETURN_CREDIT211_SOURCE_CONTRACT,CRM219_SOURCE_CONTRACT,BASE_WIRE220_SOURCE_CONTRACT,BASE_WIRE221_SOURCE_CONTRACT,
   RETURN_REASONS223_SOURCE_CONTRACT,BASE_WIRE_CATEGORIES224_SOURCE_CONTRACT,BUYER_AVAILABLE236_SOURCE_CONTRACT,AUTH_SECURITY237_SOURCE_CONTRACT,
   WZ_ISSUER239_SOURCE_CONTRACT,CUSTOM_EVENTS_CHECKSUMS244_SOURCE_CONTRACT,GUARD_VERDICTS248_SOURCE_CONTRACT,STOCKTAKE_EVIDENCE_USAGE261_SOURCE_CONTRACT,
   ACCOUNTANT_ORDER_SETTINGS266_SOURCE_CONTRACT,STATUS_CATEGORIES_AUTOMATION_EDITORS267_SOURCE_CONTRACT,ORDER_WAREHOUSE_TRANSFER269_SOURCE_CONTRACT])
   for(const record of contract.additions)if(record.kind==='relation'||record.kind==='schema'){
    const key=sha(record.kind+'\0'+record.key),value=sha(JSON.stringify(canonical(record)));
    assert(!expected.has(key)||expected.get(key)===value,'legacy-owner-acl-source-expectation-conflict');expected.set(key,value);
   }
  for(const r of first.records){
   const privateSchema=r.kind==='schema'&&r.key==='ordinary187_private',privateRelation=r.kind==='relation'&&['ordinary187_private.contexts','ordinary187_private.journal'].includes(r.key);
   if((!privateSchema&&!privateRelation&&(r.kind!=='relation'||!r.key.startsWith('public.')))||r.value.acl_null!==true)continue;
   const changed={...r,value:{...r.value,acl_null:false}};
   if(sha(JSON.stringify(canonical(changed)))!==expected.get(sha(r.kind+'\0'+r.key)))continue;
   assert.equal(r.value.owner,'postgres');
   replacements.set(r.kind+'\0'+r.key,changed);
   assert(r.value.acl.length>0&&r.value.acl.every(a=>a.grantor==='postgres'&&a.grantee==='postgres'&&a.grantable===false),'legacy-default-owner-only-acl');
   if(privateSchema){targets.push({privateSchema:true});continue;}
   assert(['r','p','v','m','S'].includes(r.value.kind));
   if(privateRelation){assert.equal(r.value.kind,'r');targets.push({privateTable:r.key.slice('ordinary187_private.'.length)});continue;}
   const name=r.key.slice('public.'.length);assert(/^[a-z][a-z0-9_]*$/.test(name));
   targets.push({name,sequence:r.value.kind==='S'});
  }
  const {sha256:unusedDigest,...body}=first;
  const proposedBody={...body,records:first.records.map(r=>replacements.get(r.kind+'\0'+r.key)??r)};
  const proposed=targets.length?validateRecoverySchema({...proposedBody,sha256:catalogueDigest(proposedBody)}):first;
  comparePackingCompiledExpectation(PACKING189_CONTRACT.dependency_compilation,proposed);
  if(targets.length){
   for(const t of targets){
    if(t.privateSchema)await owner.query('GRANT ALL ON SCHEMA "ordinary187_private" TO postgres');
    else if(t.privateTable)await owner.query(`GRANT ALL PRIVILEGES ON TABLE "ordinary187_private"."${t.privateTable}" TO postgres`);
    else await owner.query(`GRANT ALL PRIVILEGES ON ${t.sequence?'SEQUENCE':'TABLE'} public."${t.name}" TO postgres`);
   }
   const after=await observePackingColdCatalogue(owner);
   // Any other drift rolls back all grants and their DDL-generation changes.
   comparePackingCompiledExpectation(PACKING189_CONTRACT.dependency_compilation,after.catalogue);
  }
  await owner.query('COMMIT');return{owner_default_acls_materialized:targets.length};
 }catch(first){await owner.query('ROLLBACK').catch(()=>{});throw first;}
}
