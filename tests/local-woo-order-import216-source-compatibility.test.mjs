/** Source-derived complete metadata attacks; no SQL or runtime business acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {LOCAL_WOO_ORDER_IMPORT216_SOURCE_CONTRACT as E,LOCAL_WOO_ORDER_IMPORT216_SQL as SQL,LOCAL_WOO_ORDER_IMPORT216_SOURCE_ORIGIN as O} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-order-import216-source-contract.mjs';
import {OFFER_SYNC214_SOURCE_CONTRACT as E214} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/offer-sync214-source-contract.mjs';
import {LOCAL_WOO_READ213_SOURCE_CONTRACT as E213} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read213-source-contract.mjs';
import {LOCAL_WOO_READ212_SOURCE_CONTRACT as E212,digest212,canonical212} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read212-source-contract.mjs';
import {RETURN_CREDIT211_SOURCE_CONTRACT as E211} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-contract.mjs';
import {projectCompiledLocalWooOrderImport216Catalogue as project} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-order-import216-source-compatibility.mjs';
import {projectCompiledOfferSync214Catalogue as project214} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/offer-sync214-source-compatibility.mjs';
import {projectCompiledLocalWooRead213Catalogue as project213} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read213-source-compatibility.mjs';
import {SCHEMA_VERSION,SQL_SHA256,validateRecoverySchema} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {CRM215_SOURCE_CONTRACT as E215} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm215-source-contract.mjs';
import {projectCompiledCrm215Catalogue as project215} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/crm215-source-compatibility.mjs';
const clone=structuredClone,id=r=>r.kind+'\0'+r.key,sample=k=>clone(E211.additions.find(r=>r.kind===k).value);
const counters={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types'};
function seal(records){records=clone(records).sort((a,b)=>id(a)<id(b)?-1:1);const counts=Object.fromEntries(Object.keys(E.counts_before).map(k=>[k,k==='schemas'?[...SCOPE].sort():0]));for(const r of records)if(counters[r.kind])counts[counters[r.kind]]++;const body={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records};return{...body,sha256:digest212(body)};}
function fixture(){
 const base=[...SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}})),...SOURCE_SELECTION.required_tables.map(key=>({kind:'relation',key,value:sample('relation')})),...SOURCE_SELECTION.required_functions.map(key=>({kind:'function',key,value:sample('function')}))];
 const changes=new Map(E213.changes.map(x=>[id(x.after),x.after])),earlier=[...base,...clone(E212.additions)],before213=[...earlier.map(r=>changes.get(id(r))??r),...clone(E213.additions)],before214=[...before213,...clone(E214.additions)],before=[...before214,...clone(E215.additions)];
 return{earlier:seal(before214),before:seal(before),after:seal([...before,...clone(E.additions)])};
}
test('216 independent source contract pins exact SQL and predecessor without business authority',()=>{assert.deepEqual(SQL,{bytes:6343,sha256:'04878be0b869e319fc86667c9c94f4254bd3b7a3ad7951d374a8c0ac012a5994'});assert.equal(E.additions.length,202);assert.equal(E.predecessor_sha256,'20bdf54a48172caa833be5be7258dfedd12d037ed396a9a6075616d7517d3340');assert(E.additions.length>0);assert.deepEqual(E.changes,[]);assert.deepEqual(E.removed,[]);assert.equal(O.source_compilation_proven,true);assert.equal(O.native_certification,false);assert.equal(O.application_activation,false);assert.equal(O.business_acceptance,false);});
test('216 complete inverse preserves all predecessor rows/counts/hash and composes with215',()=>{const f=fixture(),p=project(f.after);assert.equal(p.active,true);assert.equal(p.authority,false);assert.equal(p.native_certification,false);assert.deepEqual(p.catalogue,validateRecoverySchema(f.before));assert.deepEqual(project215(p.catalogue).catalogue,validateRecoverySchema(f.earlier));assert.equal(project(f.before).active,false);assert(Object.isFrozen(p.catalogue.records));assert.throws(()=>project(f.after,E));});
test('every missing or changed addition is refused despite valid outer digests',()=>{const f=fixture();for(const r of E.additions){assert.throws(()=>project(seal(f.after.records.filter(x=>id(x)!==id(r)))),id(r));const rs=clone(f.after.records),target=rs.find(x=>id(x)===id(r));if(target.kind==='column')target.value.position++;else if(target.kind==='relation')target.value.force_row_security=!target.value.force_row_security;else if(target.kind==='constraint')target.value.definition+=' ';else if(target.kind==='policy')target.value.roles=['public'];else if(target.kind==='trigger')target.value.enabled=target.value.enabled==='O'?'D':'O';else if(target.kind==='index')target.value.unique=!target.value.unique;else if(target.kind==='type')target.value.owner='dyna_app';else if(target.kind==='function')target.value.cost++;assert.notDeepEqual(target,r);assert.throws(()=>project(seal(rs)));}});
test('owner, RLS, grants and related FK triggers cannot be hidden by the inverse',()=>{const f=fixture();for(const mutate of [r=>r.value.owner='dyna_app',r=>r.value.row_security=false,r=>r.value.force_row_security=false,r=>r.value.acl.push({grantee:'PUBLIC',grantor:'postgres',privilege:'UPDATE',grantable:false})]){const rows=clone(f.after.records);mutate(rows.find(r=>r.kind==='relation'&&r.key==='public.local_woo_order_import_commands'));assert.throws(()=>project(seal(rows)));}assert(E.additions.some(r=>r.kind==='trigger'&&r.key.includes('public.inbound_orders.')));assert(E.additions.some(r=>r.kind==='trigger'&&r.key.includes('public.users.')));});
test('unattached import216 namespaces and overloaded helpers cannot borrow absent or active216',()=>{const f=fixture();for(const key of ['public.local_woo_order_import_commands_poison()','public.local_woo_order_import216_shadow(x integer)','public._local_woo_order_import216_other()'])for(const basis of [f.before,f.after])assert.throws(()=>project(seal([...basis.records,{kind:'function',key,value:sample('function')}])));});
test('unrelated predecessor mutations remain visible to the full cold comparison',()=>{const f=fixture(),rs=clone(f.after.records),target=rs.find(r=>r.kind==='function'&&f.before.records.some(p=>id(p)===id(r)));target.value.cost++;const p=project(seal(rs));assert.notDeepEqual(canonical212(p.catalogue),canonical212(f.before));assert.equal(p.catalogue.records.find(r=>id(r)===id(target)).value.cost,target.value.cost);});

test('all full function fields, null prototypes and nested descriptor fields are enforced',()=>{
 const f=fixture(),expected=E.additions.find(r=>r.kind==='function');assert.equal(Object.keys(expected.value).length,24);
 for(const key of Object.keys(expected.value)){const rows=clone(f.after.records);delete rows.find(r=>id(r)===id(expected)).value[key];assert.throws(()=>project(seal(rows)),key);}
 const rows=clone(f.after.records),relation=rows.find(r=>r.kind==='relation'&&r.key==='public.local_woo_order_import_controls');relation.value.acl[0].privilege='TRUNCATE';assert.throws(()=>project(seal(rows)));
 const nullProto=value=>Array.isArray(value)?value.map(nullProto):value&&typeof value==='object'?Object.assign(Object.create(null),Object.fromEntries(Object.entries(value).map(([k,v])=>[k,nullProto(v)]))):value;
 assert.deepEqual(project(nullProto(f.after)).catalogue,validateRecoverySchema(f.before));
});
test('unknown incoming import216 FK, index relation and index column cannot hide in either activity state',()=>{
 const f=fixture();for(const basis of [f.before,f.after]){
  const fk=clone(E.additions.find(r=>r.kind==='constraint'&&r.value.definition.includes('REFERENCES')));fk.key='public.orders.foreign_import216_link';fk.value.definition='FOREIGN KEY (id) REFERENCES public.local_woo_order_import_controls(id)';assert.throws(()=>project(seal([...basis.records,fk])));
  const index=clone(E.additions.find(r=>r.kind==='relation'&&r.value.kind==='i'));index.key='public.local_woo_order_import_foreign_idx';assert.throws(()=>project(seal([...basis.records,index])));
  const column=clone(E.additions.find(r=>r.kind==='column'));column.key='public.local_woo_order_import_foreign_idx.foreign';assert.throws(()=>project(seal([...basis.records,column])));
 }
});
test('projection does not mutate its input or accept extra fields under a matching descriptor identity',()=>{
 const f=fixture(),before=clone(f.after);project(f.after);assert.deepEqual(f.after,before);
 const rows=clone(f.after.records);rows.find(r=>r.kind==='function'&&r.key.startsWith('public.local_woo_order_import216_')).value.unrecognized=true;assert.throws(()=>project(seal(rows)));
});


