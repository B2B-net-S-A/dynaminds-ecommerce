/** SYNTHETIC descriptors only, not source compilation, Native or business acceptance.
 * Uses the REAL catalogue validator and direct production209 exports. No DB/app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {projectOrderMergeDelivery209RecordSet as project,projectOrderMergeDelivery209Catalogue as catalogue} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-compatibility.mjs';
import {validateRecoverySchema,inspectPackingCatalogueContext,SCHEMA_VERSION,SQL_SHA256} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
const reader=fs.readFileSync(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs',import.meta.url),'utf8');
const FIELDS=JSON.parse(reader.match(/const FIELDS=(\{[^\n]+\});/)[1]);
const COUNTS=new Function('return '+reader.match(/const COUNTS=(\[[^\n]+\]);/)[1])();
const id=r=>r.kind+'\0'+r.key,sort=rs=>rs.sort((a,b)=>id(a)<id(b)?-1:1),clone=structuredClone;
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const map={relation:'relations',index:'indexes',sequence:'sequences',inheritance:'inheritance',column:'columns',constraint:'constraints',policy:'policies',trigger:'triggers',function:'functions',type:'types',event_trigger:'event_triggers',default_acl:'default_acl',role:'roles',role_membership:'role_memberships',extension:'extensions',rule:'rules',operator:'operators',operator_class:'operator_classes',operator_family:'operator_families',family_operator:'operator_family_operators',family_procedure:'operator_family_procedures',access_method:'access_methods',language:'languages',extension_member:'extension_members'};
function record(kind,key,patch={}){return{kind,key,value:{...Object.fromEntries(FIELDS[kind].map(k=>[k,k==='acl'?[]:k==='acl_null'||k==='has_when'?false:null])),...patch}};}
function foreignKeyRows(name,target,columns='tenant_id, source_order_id',referenced='tenant_id, id',deferred=false){
 return[
  record('constraint','public.order_merge_delivery209_receipts.'+name,{kind:'f',local:true,validated:true,no_inherit:true,inheritance_count:0,deferrable:deferred,deferred,
   definition:`FOREIGN KEY (${columns}) REFERENCES ${target}(${referenced})${deferred?' DEFERRABLE INITIALLY DEFERRED':''}`}),
  ...['del','upd'].map(action=>{const type=action==='del'?9:17,fn=`"RI_FKey_noaction_${action}"()`;return record('trigger',`public.${target}.internal:${name}:${fn}:${type}:`,
   {internal:true,constraint:name,constraint_relation:'order_merge_delivery209_receipts',function:fn,type,enabled:'O',deferrable:deferred,deferred,arguments:'',attributes:[],has_when:false,name:null,definition:null,old_table:null,new_table:null});}),
 ];
}
const functions=['public.buyer_address_preview_guard()','public.buyer_address_state_guard()','public.buyer_address_guards()','public.buyer_address_fingerprint()','public.manual_inventory_off_valid()','public.manual_inventory_off_projection_valid()','public.partial_sale204_predecessor_definition(fn oid)','public.ordinary187_valid()','public.partial_sale204_valid()','public.catalog_header205_valid()'];
function fixture(){
 const changes=functions.map((key,n)=>({kind:'function',key,before:record('function',key,{source:'SYNTHETIC208-'+n,definition:'SYNTHETIC208DEF-'+n}).value,after:record('function',key,{source:'SYNTHETIC209-'+n,definition:'SYNTHETIC209DEF-'+n}).value}));
 for(const table of ['buyer_address_previews','buyer_address_receipts'])for(const n of ['kind_check','actor_check']){
  const key='public.'+table+'.'+table+'_'+n;
  changes.push({kind:'constraint',key,before:record('constraint',key,{kind:'c',definition:'CHECK (synthetic208_'+n+')'}).value,after:record('constraint',key,{kind:'c',definition:'CHECK (synthetic209_'+n+')'}).value});
 }
 const additions=sort([
  ...['receipts','manifest','projection_basis'].map(n=>record('relation','public.order_merge_delivery209_'+n,{kind:'r',row_security:true,force_row_security:true})),
  record('function','public.order_merge_delivery209_valid()',{source:'SYNTHETIC-209-VALID'}),
  record('type','public._order_merge_delivery209_manifest'),
  record('policy','public.order_merge_delivery209_manifest.owner_scope'),
  record('column','public.order_merge_delivery209_manifest.id',{type:'boolean'}),
  record('index','public.order_merge_delivery209_manifest_pkey',{table:'order_merge_delivery209_manifest',primary:true}),
  record('trigger','public.order_merge_previews.order_merge_delivery209_source_preview',{name:'order_merge_delivery209_source_preview',internal:false}),
  record('trigger','public.order_merge_executions.order_merge_delivery209_complete',{name:'order_merge_delivery209_complete',internal:false,deferrable:true,deferred:true}),
  record('constraint','public.order_merge_executions.order_merge_delivery209_complete',{kind:'t',local:true,deferred:true,validated:true,deferrable:true,definition:'TRIGGER DEFERRABLE INITIALLY DEFERRED',no_inherit:true,inheritance_count:0}),
  ...foreignKeyRows('order_merge_delivery209_receipts_source_fkey','orders'),
 ]);
 const unrelated=record('function','public.unrelated()', {source:'UNCHANGED',cost:100});
 const expected={schema:'source209-order-merge-delivery-exact-inverse/v1',changes,additions,removed:[]};
 const before=sort([clone(unrelated),...changes.map(c=>({kind:c.kind,key:c.key,value:clone(c.before)}))]);
 const after=sort([clone(unrelated),...changes.map(c=>({kind:c.kind,key:c.key,value:clone(c.after)})),...clone(additions)]);
 return{expected,before,after,unrelated};
}
function full(extra){
 const records=sort([...SCOPE.map(s=>record('schema',s)),...SOURCE_SELECTION.required_tables.map(s=>record('relation',s)),...SOURCE_SELECTION.required_functions.map(s=>record('function',s)),...clone(extra)]);
 const counts={schemas:[...SCOPE].sort(),...Object.fromEntries(COUNTS.map(k=>[k,0]))};for(const r of records)if(map[r.kind])counts[map[r.kind]]++;
 const body={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records};return{...body,sha256:hash(body)};
}

test('exact14descriptor inverse removes only explicit complete209 additions and preserves unrelated metadata',()=>{
 const f=fixture(),saved=clone(f.after),p=project(f.after,f.expected);
 assert.deepEqual(JSON.parse(JSON.stringify(p.records)),JSON.parse(JSON.stringify(f.before)));
 assert.equal(p.active,true);assert.equal(p.changed_records,14);assert.equal(p.removed_records,f.expected.additions.length);assert.equal(p.authority,false);assert.deepEqual(f.after,saved);
 assert(Object.isFrozen(p)&&Object.isFrozen(p.records));assert.throws(()=>p.records[0].value.extra=true,TypeError);
});
test('actual PG-truncated209 FK names bind to their authored constraint and exact referenced relation/actions',()=>{
 const f=fixture();
 // Names and deparsed definitions captured from the real Source209 memory03
 // catalogue; surrounding descriptors remain explicitly synthetic fixtures.
 const actual=[
  ...foreignKeyRows('order_merge_delivery209_recei_tenant_id_target_order_id_pr_fkey','buyer_address_previews','tenant_id, target_order_id, preview_id','tenant_id, order_id, id',true),
  ...foreignKeyRows('order_merge_delivery209_recei_tenant_id_target_order_id_re_fkey','buyer_address_receipts','tenant_id, target_order_id, receipt_id','tenant_id, order_id, id',true),
  ...foreignKeyRows('order_merge_delivery209_receipt_tenant_id_merge_preview_id_fkey','order_merge_previews','tenant_id, merge_preview_id','tenant_id, id'),
 ];
 assert(actual.filter(r=>r.kind==='trigger').every(r=>!r.value.constraint.startsWith('order_merge_delivery209_receipts_')),'no newly loosened short-prefix matcher');
 f.expected.additions=sort([...f.expected.additions,...actual]);f.after=sort([...f.after,...actual]);
 const p=project(f.after,f.expected);assert.equal(p.active,true);assert.equal(p.changed_records,14);assert.equal(p.removed_records,f.expected.additions.length);
 assert.deepEqual(JSON.parse(JSON.stringify(p.records)),f.before);
 for(const row of actual.filter(r=>r.kind==='trigger'))assert(!p.records.some(r=>id(r)===id(row)));
});
test('even matching input/expectation cannot admit unowned RI, wrong target/action or incomplete FK links',()=>{
 const truncated='order_merge_delivery209_recei_tenant_id_target_order_id_pr_fkey';
 const make=()=>{const f=fixture(),rows=foreignKeyRows(truncated,'buyer_address_previews','tenant_id, target_order_id, preview_id','tenant_id, order_id, id',true);f.expected.additions=sort([...f.expected.additions,...rows]);return f;};
 for(const mutate of[
  rows=>{rows.splice(rows.findIndex(r=>r.key==='public.order_merge_delivery209_receipts.'+truncated),1);},
  rows=>{const r=rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated);r.key=r.key.replace('public.buyer_address_previews.','public.orders.');},
  rows=>{const r=rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated);r.value.constraint='order_merge_delivery209_recei_unknown_fkey';r.key=r.key.replace(truncated,r.value.constraint);},
  rows=>{rows.find(r=>r.key==='public.order_merge_delivery209_receipts.'+truncated).value.definition='FOREIGN KEY (tenant_id, target_order_id, preview_id) REFERENCES foreign_schema.buyer_address_previews(tenant_id, order_id, id) DEFERRABLE INITIALLY DEFERRED';},
  rows=>{rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated).value.constraint_relation='other_receipts';},
  rows=>{rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated).value.function='"RI_FKey_cascade_del"()';},
  rows=>{rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated).value.type=17;},
  rows=>{rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated).value.deferrable=false;},
  rows=>{rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated).value.enabled='D';},
  rows=>{rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated).value.attributes=[1];},
  rows=>{rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated).value.arguments='01';},
  rows=>{rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated).value.has_when=true;},
  rows=>{rows.splice(rows.findIndex(r=>r.kind==='trigger'&&r.value.constraint===truncated&&r.value.type===17),1);},
  rows=>{const r=clone(rows.find(r=>r.kind==='trigger'&&r.value.constraint===truncated&&r.value.type===9));r.value.function='pg_catalog.'+r.value.function;r.key=r.key.replace(':"RI_FKey',':pg_catalog."RI_FKey');rows.push(r);},
 ]){
  const f=make();mutate(f.expected.additions);sort(f.expected.additions);
  const after=sort([...f.before.filter(r=>r.key==='public.unrelated()'),...f.expected.changes.map(c=>({kind:c.kind,key:c.key,value:clone(c.after)})),...clone(f.expected.additions)]);
  assert.throws(()=>project(after,f.expected),/authored|linked|duplicate/);
 }
});
test('inactive requires every exact208 function AND CHECK descriptor; partial/mixed installation refuses',()=>{
 const f=fixture();assert.equal(project(f.before,f.expected).active,false);
 for(const c of f.expected.changes){const mixed=clone(f.before);mixed.find(r=>id(r)===id(c)).value=clone(c.after);assert.throws(()=>project(mixed,f.expected),/exact208-before/);}
 assert.throws(()=>project(f.before.filter(r=>r.key!==f.expected.changes.at(-1).key),f.expected),/exact208-before/);
});
test('missing ANY addition including externalguards, deferredconstraint and linkedRI cannot pass',()=>{
 const f=fixture();for(const a of f.expected.additions)assert.throws(()=>project(f.after.filter(r=>id(r)!==id(a)),f.expected),/addition-roster/);
});
test('extra own namespace, external prefixedguard, linkedRI and overloads refuse instead of broadprefix deletion',()=>{
 const f=fixture();
 for(const r of [record('relation','public.order_merge_delivery209_extra'),record('function','public.order_merge_delivery209_valid(extra integer)'),record('trigger','public.orders.order_merge_delivery209_extra',{internal:false}),record('type','public._order_merge_delivery209_extra')])assert.throws(()=>project(sort([...clone(f.after),r]),f.expected),/addition-roster/);
 for(const c of f.expected.changes.filter(c=>c.kind==='function')){
  assert.throws(()=>project(f.after.filter(r=>r.key!==c.key),f.expected),/overload/);
  assert.throws(()=>project(sort([...clone(f.after),record('function',c.key.replace('(', '(extra integer, '))]),f.expected),/overload/);
 }
});
test('every full added/changed descriptor is exact including ACL, headers, source and CHECK definitions',()=>{
 const f=fixture();for(const target of [...f.expected.additions,...f.expected.changes]){const rows=clone(f.after);rows.find(r=>id(r)===id(target)).value.negative_drift=true;assert.throws(()=>project(rows,f.expected),/descriptors|descriptor/);}
});
test('raw duplicate/unsorted/sparse inputs and destructive/foreign/incomplete expectations refuse',()=>{
 const f=fixture();assert.throws(()=>project(sort([...clone(f.after),clone(f.after[0])]),f.expected),/duplicate/);assert.throws(()=>project(f.after.slice().reverse(),f.expected),/record-order/);
 const sparse=clone(f.after);delete sparse[1];assert.throws(()=>project(sparse,f.expected),/dense/);
 for(const e of [undefined,{...f.expected,removed:['old']},{...f.expected,changes:[]},{...f.expected,additions:[]},{...f.expected,additions:sort([...clone(f.expected.additions),record('function','public.foreign()')])}])assert.throws(()=>project(f.after,e));
});
test('real reader-owned catalogue preserves full hash/counts and identity for inactive208',()=>{
 const f=fixture(),owned=validateRecoverySchema(full(f.before)),p=catalogue(owned,f.expected);
 assert.equal(p.catalogue,owned);assert.equal(p.records,owned.records);assert.equal(p.active,false);assert.equal(p.changed_records,0);assert.equal(Object.values(p.removed_counts).reduce((a,b)=>a+b,0),0);
 assert.throws(()=>inspectPackingCatalogueContext(p.catalogue),/code-owned/);assert(Object.isFrozen(p.removed_counts));
});
test('real reader-owned active projection verifies ALL per-kind counts/hash while reusing unchanged owned input records',()=>{
 const f=fixture(),owned=validateRecoverySchema(full(f.after)),p=catalogue(owned,f.expected),before=validateRecoverySchema(full(f.before));
 assert.equal(p.catalogue.sha256,before.sha256);assert.deepEqual(p.catalogue.counts,before.counts);assert.equal(p.catalogue.records.length,before.records.length);assert.equal(p.changed_records,14);
 for(const [kind,count]of Object.entries(map))if(Object.hasOwn(p.removed_counts,count))assert.equal(p.removed_counts[count],f.expected.additions.filter(r=>r.kind===kind).length);
 const original=owned.records.find(r=>r.key==='public.unrelated()');assert.equal(p.records.find(r=>r.key===original.key),original,'no redundant clone of unchanged owned descriptors');
 assert(Object.isFrozen(p)&&Object.isFrozen(p.catalogue)&&Object.isFrozen(p.removed_counts));assert.throws(()=>inspectPackingCatalogueContext(p.catalogue),/code-owned/);
});
test('foreign mutable/frozen/getter/digest-equal catalogue never inherits a prior validated input or custody',()=>{
 const f=fixture(),raw=full(f.after),owned=validateRecoverySchema(raw),first=catalogue(owned,f.expected);
 const foreign=clone(raw);catalogue(foreign,f.expected);foreign.records.find(r=>r.key==='public.unrelated()').value.source='drift';assert.throws(()=>catalogue(foreign,f.expected),/snapshot-integrity/);
 const two=validateRecoverySchema(clone(raw));assert.notEqual(two,owned);assert.equal(two.sha256,owned.sha256);assert.notEqual(catalogue(two,f.expected).catalogue,first.catalogue);
 const accessor={...raw};Object.defineProperty(accessor,'sha256',{enumerable:true,get:()=>raw.sha256});assert.throws(()=>catalogue(Object.freeze(accessor),f.expected),/sha-own-data/);
 assert.throws(()=>catalogue({...raw,context:{root_xid:'spoof'}},f.expected));
});
test('fresh valid integrity digest cannot authorize drift and expected data is recaptured percall',()=>{
 const f=fixture();catalogue(validateRecoverySchema(full(f.after)),f.expected);
 const changed=clone(f.after);changed.find(r=>r.key===f.expected.changes[0].key).value.source='NEW-VALID-DIGEST-BUT-FOREIGN';assert.throws(()=>catalogue(validateRecoverySchema(full(changed)),f.expected),/current-changed-descriptor/);
 let calls=0;const expected={...f.expected};Object.defineProperty(expected,'changes',{enumerable:true,get:()=>++calls===1?f.expected.changes:[]});Object.freeze(expected);
 project(f.after,expected);assert.throws(()=>project(f.after,expected),/exact14/);assert.equal(calls,2);
});
