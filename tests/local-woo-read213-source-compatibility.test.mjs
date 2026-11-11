/** Controlled metadata attacks with valid outer digests; never SQL or write authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {LOCAL_WOO_READ213_SOURCE_CONTRACT as E,LOCAL_WOO_READ213_SQL as SQL,LOCAL_WOO_READ213_SOURCE_ORIGIN as ORIGIN} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read213-source-contract.mjs';
import {LOCAL_WOO_READ212_SOURCE_CONTRACT as E212,canonical212,digest212} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read212-source-contract.mjs';
import {RETURN_CREDIT211_SOURCE_CONTRACT as E211} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-contract.mjs';
import {projectCompiledLocalWooRead213Catalogue as project} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read213-source-compatibility.mjs';
import {projectCompiledLocalWooRead212Catalogue as project212} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read212-source-compatibility.mjs';
import {SCHEMA_VERSION,SQL_SHA256,validateRecoverySchema} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
const clone=structuredClone,id=r=>r.kind+'\0'+r.key,sample=k=>clone(E211.additions.find(r=>r.kind===k).value);
const counters={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types'};
function seal(records){
 records=clone(records).sort((a,b)=>id(a)<id(b)?-1:1);const counts=Object.fromEntries(Object.keys(E.counts_before).map(k=>[k,k==='schemas'?[...SCOPE].sort():0]));
 for(const r of records)if(counters[r.kind])counts[counters[r.kind]]++;
 const body={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records};return{...body,sha256:digest212(body)};
}
function fixture(){
 const base=[...SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}})),...SOURCE_SELECTION.required_tables.map(key=>({kind:'relation',key,value:sample('relation')})),...SOURCE_SELECTION.required_functions.map(key=>({kind:'function',key,value:sample('function')}))];
 const before=[...base,...clone(E212.additions)],changes=new Map(E.changes.map(x=>[id(x.after),x.after]));
 return{earlier:seal(base),before:seal(before),after:seal([...before.map(r=>changes.get(id(r))??r),...clone(E.additions)])};
}
test('SQL pin and exact compiled vector retain metadata-only boundaries',async()=>{
 const b=await fs.readFile(new URL('../server/213_local_woo_read_reconciliation.sql',import.meta.url));assert.equal(b.length,SQL.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),SQL.sha256);
 assert.equal(E.additions.length,64);assert.equal(E.changes.length,2);assert.deepEqual(E.removed,[]);assert.equal(ORIGIN.source_compilation_proven,true);assert.equal(ORIGIN.native_certification,false);assert.equal(ORIGIN.application_activation,false);assert.equal(ORIGIN.business_acceptance,false);
});
test('complete inverse preserves predecessor rows/counts/hash and composes with212; no caller vector',()=>{
 const f=fixture(),p=project(f.after);assert.equal(p.active,true);assert.equal(p.authority,false);assert.equal(p.native_certification,false);assert.deepEqual(p.catalogue,validateRecoverySchema(f.before));assert.deepEqual(project212(p.catalogue).catalogue,validateRecoverySchema(f.earlier));assert(Object.isFrozen(p.catalogue.records));assert.throws(()=>project(f.after,E));
 assert.equal(project(f.before).active,false);assert.equal(project(f.earlier).active,false);
});
test('every missing addition and mixed predecessor/current constraints refuses with a valid digest',()=>{
 const f=fixture();for(const r of E.additions)assert.throws(()=>project(seal(f.after.records.filter(x=>id(x)!==id(r)))),id(r));
 for(const pair of E.changes){assert.throws(()=>project(seal(f.after.records.filter(x=>id(x)!==id(pair.after)))));assert.throws(()=>project(seal(f.after.records.map(x=>id(x)===id(pair.after)?pair.before:x))));assert.throws(()=>project(seal(f.before.records.filter(x=>id(x)!==id(pair.before)))));}
});
test('receipt owner, ACL, FORCE RLS and policy tampering cannot be hidden by the213 inverse',()=>{
 const f=fixture();for(const mutate of [r=>r.value.owner='dyna_app',r=>r.value.force_row_security=false,r=>r.value.row_security=false,r=>r.value.acl.push({grantee:'PUBLIC',grantor:'postgres',privilege:'UPDATE',grantable:false})]){const rows=clone(f.after.records);mutate(rows.find(r=>r.kind==='relation'&&r.key==='public.local_woo_read_reconciliations'));assert.throws(()=>project(seal(rows)));}
 const rows=clone(f.after.records);rows.find(r=>r.kind==='policy'&&r.key==='public.local_woo_read_reconciliations.tenant_scope').value.roles=['public'];assert.throws(()=>project(seal(rows)));
});
test('same-name FK, parent RI trigger and index-column substitutions refuse',()=>{
 const f=fixture();for(const select of [r=>r.kind==='constraint'&&r.value.kind==='f',r=>r.kind==='trigger',r=>r.kind==='column'&&r.key.includes('reconciliation_identity')]){const target=E.additions.find(select);assert(target);const rows=clone(f.after.records),r=rows.find(x=>id(x)===id(target));if(r.kind==='constraint')r.value.definition=r.value.definition.replace(/REFERENCES\s+\w+/,'REFERENCES orders');else if(r.kind==='trigger')r.value.constraint_relation='orders';else r.value.position+=1;assert.notDeepEqual(r,target,'the attack must actually change its descriptor');assert.throws(()=>project(seal(rows)));}
});
test('unattached family suffixes, overloads and identity namespaces cannot borrow absent or active213',()=>{
 const f=fixture();for(const key of ['public.local_woo_read_reconciliations_poison()','public.local_woo_read_reconciliation_other(x integer)','public.local_woo_read_occurrence_reconciliation_identity_shadow()','public.local_woo_read_dispatch_reconciliation_identity_shadow()'])for(const basis of [f.before,f.after,f.earlier]){const r={kind:'function',key,value:sample('function')};assert.throws(()=>project(seal([...basis.records,r])));}
});
test('unrelated predecessor mutation remains visible for the following full cold comparison',()=>{
 const f=fixture(),rows=clone(f.after.records),target=rows.find(r=>r.kind==='function');target.value.cost+=1;const projected=project(seal(rows));assert.notDeepEqual(canonical212(projected.catalogue),canonical212(f.before));assert.equal(projected.catalogue.records.find(r=>id(r)===id(target)).value.cost,target.value.cost);
});
