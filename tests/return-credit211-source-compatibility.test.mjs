/** Source-only tests: preserved controlled draft AFTER plus the independently
 * compiled fixed211 descriptors. No app, SQL, HTTP, Native or builds execute. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RETURN_CREDIT207_SOURCE_CONTRACT as E207} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
import {RETURN_CREDIT211_DRAFT_PREDECESSOR as B,RETURN_CREDIT211_SOURCE_STATUS,RETURN_CREDIT211_DRAFT_STATUS,RETURN_CREDIT211_SOURCE_CONTRACT as E211,RETURN_CREDIT211_SOURCE_ORIGIN as ORIGIN211,validateReturnCredit211DraftContract} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-contract.mjs';
import {projectReturnCredit211RecordSet as project,projectReturnCredit211Catalogue,projectCompiledReturnCredit211RecordSet as fixedProject,projectCompiledReturnCredit211Catalogue} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-compatibility.mjs';
import {validateRecoverySchema,SCHEMA_VERSION,SQL_SHA256} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
const clone=structuredClone,id=r=>r.kind+'\0'+r.key,sort=rs=>rs.sort((a,b)=>id(a)<id(b)?-1:1);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(v).digest('hex');
const sample=kind=>clone(E207.additions.find(r=>r.kind===kind));
function fixture(){
 const changes=B.changes.map(r=>{
  const before=clone(r.value);let after;
  if(r.kind==='function'){
   const source=before.source+'\n-- CONTROLLED uncompiled211 candidate';
   after={...before,source,definition:before.definition.replace(before.source,()=>source)};
  }else if(r.kind==='constraint')after={...before,definition:'FOREIGN KEY (tenant_id, return_receipt_id) REFERENCES return_credit211_acceptances(tenant_id, id)'};
  else after={...before,constraint_relation:'return_credit211_acceptances'};
  return{kind:r.kind,key:r.key,before,after};
 });
 const additions=['relation','column','constraint','index','policy','trigger','function','type'].map(kind=>{
  const row=sample(kind);
  return JSON.parse(JSON.stringify(row).replaceAll('return_credit206_','return_credit211_'));
 });
 // The two target-side RI records have no211 name in their constraint/function.
 additions.push(...clone(B.required_retarget_parent_triggers));
 const expected={schema:'source211-return-credit148-exact-inverse-draft/v1',...Object.fromEntries(['source_compilation_proven','native_certification','application_activation','business_acceptance'].map(k=>[k,false])),additions:sort(additions),changes,removed:clone(B.removed)};
 const unrelated=[{kind:'relation',key:'public.unrelated',value:clone(sample('relation').value)},
  {kind:'constraint',key:'public.unrelated.literal_mention',value:{...clone(sample('constraint').value),kind:'c',definition:"CHECK (note <> 'return_credit211_acceptances')"}},
  {kind:'function',key:'public.unrelated_return_credit211_mention()',value:clone(B.changes.find(r=>r.kind==='function').value)}];
 const before=sort([...clone(unrelated),...clone(B.changes),...clone(B.removed)]);
 const after=sort([...clone(unrelated),...changes.map(c=>({kind:c.kind,key:c.key,value:clone(c.after)})),...clone(additions)]);
 return{expected,before,after,unrelated};
}

test('source-owned209 footprint contains three full24 functions, FK, two changed child RI and two removed parent RI',()=>{
 assert.equal(B.stage,209);assert.equal(B.changes.length,6);assert.equal(B.removed.length,2);
 assert.equal(B.changes.filter(r=>r.kind==='function').length,3);
 for(const row of B.changes.filter(r=>r.kind==='function'))assert.equal(Object.keys(row.value).length,24);
 for(const row of B.changes.filter(r=>r.kind==='trigger'))assert.equal(row.value.constraint_relation,'catalog_stock_return_receipts');
 for(const row of B.removed)assert(row.key.startsWith('public.catalog_stock_return_receipts.internal:'));
 assert.equal(RETURN_CREDIT211_DRAFT_STATUS.source_compilation_proven,false);
 assert(Object.isFrozen(B)&&Object.isFrozen(B.changes[0].value));
});

test('exact eight-kind inverse restores every full predecessor descriptor and both old RI records without changing inputs',()=>{
 const f=fixture(),saved=clone(f),p=project(f.after,f.expected);
 assert.deepEqual(p.records,canonical(f.before));assert.equal(p.active,true);assert.equal(p.changed_records,6);
 assert.equal(p.removed_records,10);assert.equal(p.restored_records,2);
 assert.equal(p.removed_counts.triggers,3);assert.equal(p.restored_counts.triggers,2);
 assert.equal(p.authority,false);assert.equal(p.source_compilation_proven,false);
 assert.equal(p.native_certification,false);assert.equal(p.application_activation,false);assert.equal(p.business_acceptance,false);
 assert.deepEqual(f,saved);assert(!Object.isFrozen(f.after));assert(Object.isFrozen(p.records[0].value));
 assert.throws(()=>{p.records[0].key='poison';});
 for(const row of f.unrelated)assert.deepEqual(p.records.find(r=>id(r)===id(row)),canonical(row));
});

test('absence requires the exact whole209 footprint, including old parent RI and unchanged function metadata',()=>{
 const f=fixture(),p=project(f.before,f.expected);assert.equal(p.active,false);assert.deepEqual(p.records,canonical(f.before));
 for(const c of f.expected.changes){
  const x=clone(f.before);x.find(r=>id(r)===id(c)).value=clone(c.after);assert.throws(()=>project(x,f.expected),/intact literal209/);
 }
 for(const r of B.removed)assert.throws(()=>project(f.before.filter(x=>id(x)!==id(r)),f.expected),/original parent RI/);
});

test('missing or extra additions of any of the eight kinds, partial installs and unknown incoming dependencies refuse',()=>{
 const f=fixture();
 for(const r of f.expected.additions)assert.throws(()=>project(f.after.filter(x=>id(x)!==id(r)),f.expected));
 for(const kind of ['relation','column','constraint','index','policy','trigger','function','type']){
  const row=clone(f.expected.additions.find(r=>r.kind===kind));row.key='public.return_credit211_extra.'+kind;
  assert.throws(()=>project(sort([...clone(f.after),row]),f.expected),/complete addition roster/);
 }
 const incoming=clone(B.required_retarget_parent_triggers[0]);incoming.key='public.foreign.internal:unexpected_fk';incoming.value.constraint_relation='return_credit211_acceptances';
 assert.throws(()=>project(sort([...clone(f.after),incoming]),f.expected),/complete addition roster/);
 const badForeignKey={kind:'constraint',key:'public.foreign.arbitrary_fk',value:{...clone(sample('constraint').value),kind:'f',definition:'FOREIGN KEY (x) REFERENCES return_credit211_acceptances(id)'}};
 assert.throws(()=>project(sort([...clone(f.after),badForeignKey]),f.expected),/complete addition roster/);
});

test('every complete AFTER field matters; old RI coexistence cannot be normalized away',()=>{
 const f=fixture();
 for(const target of [...f.expected.additions,...f.expected.changes]){
  const x=clone(f.after);x.find(r=>id(r)===id(target)).value.poison=true;assert.throws(()=>project(x,f.expected));
 }
 for(const target of f.expected.changes.filter(r=>r.kind==='function'))for(const key of Object.keys(target.after)){
  const x=clone(f.after);x.find(r=>id(r)===id(target)).value[key]=target.after[key]===null?'CONTROLLED_POISON':null;assert.throws(()=>project(x,f.expected));
 }
 for(const row of B.removed)assert.throws(()=>project(sort([...clone(f.after),clone(row)]),f.expected),/old parent RI still present/);
});

test('changed-object overloads, missing objects, duplicate/unordered/sparse records and non-JSON values refuse',()=>{
 const f=fixture();
 for(const c of f.expected.changes.filter(r=>r.kind==='function')){
  assert.throws(()=>project(f.after.filter(r=>id(r)!==id(c)),f.expected),/missing\/overloaded/);
  const overload={kind:'function',key:c.key.replace('(', '(extra integer, '),value:clone(c.after)};
  assert.throws(()=>project(sort([...clone(f.after),overload]),f.expected),/missing\/overloaded/);
 }
 assert.throws(()=>project(sort([...clone(f.after),clone(f.after[0])]),f.expected),/duplicate/);
 assert.throws(()=>project([...f.after].reverse(),f.expected),/unordered/);
 const sparse=clone(f.after);delete sparse[0];assert.throws(()=>project(sparse,f.expected),/dense/);
 for(const poison of [undefined,NaN,Infinity,1n,()=>true]){
  const x=clone(f.after);x[0].value.poison=poison;assert.throws(()=>project(x,f.expected));
 }
 let accessed=false;const getter=clone(f.after);Object.defineProperty(getter[0].value,'poison',{enumerable:true,get(){accessed=true;return true;}});
 assert.throws(()=>project(getter,f.expected),/accessors/);assert.equal(accessed,false);
});

test('a candidate cannot claim compilation/acceptance, redefine a BEFORE, weaken any22 function field or change the FK/RI topology',()=>{
 const f=fixture();assert.throws(()=>project(f.after));assert.throws(()=>project(f.after,undefined));
 for(const flag of ['source_compilation_proven','native_certification','application_activation','business_acceptance']){
  const x=clone(f.expected);x[flag]=true;assert.throws(()=>validateReturnCredit211DraftContract(x),/cannot claim/);
 }
 const mutations=[x=>x.changes[0].before.validated=false,x=>x.removed.pop(),x=>x.changes.pop(),x=>x.additions.pop(),
  x=>x.changes.find(c=>c.kind==='function').after.cost=0,
  x=>delete x.changes.find(c=>c.kind==='function').after.acl,
  x=>x.changes.find(c=>c.kind==='function').after.definition+='\n',
  x=>x.changes.find(c=>c.kind==='constraint').after.validated=false,
  x=>x.changes.find(c=>c.kind==='trigger').after.constraint_relation='public.elsewhere'];
 for(const mutate of mutations){const x=clone(f.expected);mutate(x);assert.throws(()=>project(f.after,x));}
});

const counter={relation:'relations',index:'indexes',column:'columns',constraint:'constraints',function:'functions',trigger:'triggers',policy:'policies',type:'types'};
const countKeys='relations,indexes,sequences,inheritance,columns,constraints,policies,triggers,unsupported_internal_trigger_when,functions,types,event_triggers,default_acl,roles,role_memberships,extensions,rules,unsupported_relations,unsupported_routines,operators,operator_classes,operator_families,operator_family_operators,operator_family_procedures,access_methods,languages,extension_members,unsupported_ranges,unsupported_operator_shells,unsupported_statistics,unsupported_publications,unsupported_subscriptions,unsupported_collations,unsupported_foreign_servers,unsupported_languages'.split(',');
function fullMembership(rows){
 const ids=new Set(rows.map(id));
 const base=[...SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}})),
  ...SOURCE_SELECTION.required_tables.map(key=>({kind:'relation',key,value:clone(sample('relation').value)})),
  ...SOURCE_SELECTION.required_functions.map(key=>({kind:'function',key,value:clone(B.changes.find(r=>r.kind==='function').value)}))];
 return sort([...clone(rows),...base.filter(r=>!ids.has(id(r)))]);
}
function seal(rows){
 const counts={schemas:[...SCOPE].sort(),...Object.fromEntries(countKeys.map(k=>[k,0]))};
 for(const row of rows)if(counter[row.kind])counts[counter[row.kind]]++;
 const body={schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records:rows};
 return{...body,sha256:hash(JSON.stringify(canonical(body)))};
}
test('full catalogue inverse restores canonical membership/counts/digest including net RI movement; corruption is not accepted as an envelope',()=>{
 const f=fixture(),before=seal(fullMembership(f.before)),after=seal(fullMembership(f.after)),saved=clone(after);
 const expected=validateRecoverySchema(before),p=projectReturnCredit211Catalogue(after,f.expected);
 assert.deepEqual(p.catalogue,expected);assert.equal(p.catalogue.sha256,expected.sha256);
 assert.equal(p.catalogue.counts.triggers,after.counts.triggers-3+2);
 assert.deepEqual(after,saved);assert.equal(projectReturnCredit211Catalogue(before,f.expected).active,false);
 const corrupt=clone(after);corrupt.counts.triggers--;assert.throws(()=>projectReturnCredit211Catalogue(corrupt,f.expected));
 assert.throws(()=>projectReturnCredit211Catalogue(after));
});

function compiledFixture(){
 const unrelated=fixture().unrelated;
 return{before:sort([...clone(unrelated),...clone(B.changes),...clone(B.removed)]),
  after:sort([...clone(unrelated),...clone(E211.additions),...E211.changes.map(c=>({kind:c.kind,key:c.key,value:clone(c.after)}))])};
}
test('fixed contract pins independent EC15770 publication and keeps Native/business certification false',()=>{
 assert.equal(E211.schema,'source211-return-credit148-exact-inverse/v1');
 assert.equal(E211.additions.length,140);assert.equal(E211.changes.length,6);assert.equal(E211.removed.length,2);
 assert.equal(ORIGIN211.compiler_receipt_sha256,'5f6898ea8db70e111714b67c4825438bb3f3490671d456449304f19e1db3aebd');
 assert.equal(ORIGIN211.root_review_sha256,'c12fbf6fd56dafd2dda3939bb3fbb73355c44f22a5b3d712207fba68c452210f');
 assert.equal(ORIGIN211.vector_bytes,498300);assert.equal(ORIGIN211.vector_sha256,'6f57fc2dd3d2af2595ac0cd6bc89661f8044a1aaa8407de22b987c1251aa1a1f');
 assert.equal(ORIGIN211.sql_bytes,205593);assert.equal(ORIGIN211.sql_sha256,'dd4b84617213f88f99e38aa43028785da422dddafb4b5f0035c9343a7f2535ac');
 assert.equal(ORIGIN211.source_compilation_proven,true);assert.equal(ORIGIN211.independent_empty_source_database,true);
 assert.equal(RETURN_CREDIT211_SOURCE_STATUS.source_compilation_proven,true);
 for(const flag of ['native_certification','application_activation','business_acceptance'])assert.equal(ORIGIN211[flag],false);
 assert(Object.isFrozen(E211.additions[0].value)&&Object.isFrozen(ORIGIN211));
 assert.throws(()=>{E211.changes[0].after.poison=true;});
});
test('fixed inverse uses the actual source-compiled140/6/2 and restores all unrelated values without caller authority',()=>{
 const f=compiledFixture(),saved=clone(f.after),p=fixedProject(f.after);
 assert.deepEqual(p.records,canonical(f.before));assert.equal(p.active,true);
 assert.equal(p.removed_records,140);assert.equal(p.restored_records,2);assert.equal(p.changed_records,6);
 assert.equal(p.removed_counts.triggers,28);assert.equal(p.restored_counts.triggers,2);
 assert.equal(p.source_compilation_proven,true);assert.equal(p.authority,false);assert.equal(p.native_certification,false);
 assert.deepEqual(f.after,saved);
 assert.throws(()=>fixedProject(f.after,E211),/no caller expectation/);
 assert.throws(()=>fixedProject(f.after,{native_certification:true}),/no caller expectation/);
 // The old explicit API remains genuinely draft, including on compiled rows.
 const draft={...clone(E211),schema:'source211-return-credit148-exact-inverse-draft/v1',source_compilation_proven:false,native_certification:false,application_activation:false,business_acceptance:false};
 assert.equal(project(f.after,draft).source_compilation_proven,false);
});
test('fixed exact absence permits earlier205/pre207 identity and refuses stripped successor functions, FK and child RI',()=>{
 for(const rows of [[],fixture().unrelated,B.changes,B.removed,compiledFixture().before]){
  const input=sort(clone(rows)),p=fixedProject(input);assert.equal(p.active,false);assert.deepEqual(p.records,canonical(input));assert.equal(p.authority,false);
 }
 for(const c of E211.changes){
  const input=sort([...clone(fixture().unrelated),{kind:c.kind,key:c.key,value:clone(c.after)}]);
  assert.throws(()=>fixedProject(input),/partial successor/);
 }
 const earlier=seal(fullMembership(fixture().unrelated)),p=projectCompiledReturnCredit211Catalogue(earlier);
 assert.equal(p.active,false);assert.deepEqual(p.catalogue,validateRecoverySchema(earlier));
});
test('fixed source contract rejects partial/excess namespaces, unknown incoming dependencies and retired RI coexistence',()=>{
 const f=compiledFixture();
 for(const kind of ['relation','column','constraint','index','policy','trigger','function','type']){
  const row=E211.additions.find(r=>r.kind===kind);assert(row);
  assert.throws(()=>fixedProject(f.after.filter(r=>id(r)!==id(row))),/complete addition roster/);
  const extra=clone(row);extra.key='public.return_credit211_unexpected.'+kind;
  assert.throws(()=>fixedProject(sort([...clone(f.after),extra])),/complete addition roster/);
 }
 const incoming=clone(B.required_retarget_parent_triggers[0]);incoming.key='public.other.internal:foreign';incoming.value.constraint_relation='return_credit211_acceptances';
 assert.throws(()=>fixedProject(sort([...clone(f.after),incoming])),/complete addition roster/);
 for(const old of B.removed)assert.throws(()=>fixedProject(sort([...clone(f.after),clone(old)])),/old parent RI/);
});
test('fixed full24 AFTER authorization rejects every function descriptor mutation and changed-function overload',()=>{
 const f=compiledFixture();
 for(const target of E211.changes.filter(r=>r.kind==='function')){
  assert.equal(Object.keys(target.after).length,24);
  for(const field of Object.keys(target.after)){
   const x=clone(f.after);x.find(r=>id(r)===id(target)).value[field]=target.after[field]===null?'CONTROLLED_POISON':null;
   assert.throws(()=>fixedProject(x),/full AFTER/);
  }
  const overload={kind:'function',key:target.key.replace('(', '(other integer, '),value:clone(target.after)};
  assert.throws(()=>fixedProject(sort([...clone(f.after),overload])),/missing\/overloaded/);
 }
 for(const row of E211.additions){
  const x=clone(f.after);x.find(r=>id(r)===id(row)).value.poison=true;
  assert.throws(()=>fixedProject(x),/complete addition roster/);
 }
});
test('fixed catalogue restores whole predecessor counts and digest while rejecting bad envelopes and arbitrary approval arguments',()=>{
 const f=compiledFixture(),before=seal(fullMembership(f.before)),after=seal(fullMembership(f.after)),saved=clone(after);
 const p=projectCompiledReturnCredit211Catalogue(after);
 assert.equal(p.active,true);assert.deepEqual(p.catalogue,validateRecoverySchema(before));assert.deepEqual(after,saved);
 assert.equal(p.catalogue.counts.triggers,after.counts.triggers-28+2);
 assert.throws(()=>projectCompiledReturnCredit211Catalogue(after,E211),/no caller expectation/);
 const bad=clone(after);bad.counts.functions--;assert.throws(()=>projectCompiledReturnCredit211Catalogue(bad));
 const poisoned=clone(after);poisoned.records[0].value.owner='CONTROLLED_POISON';assert.throws(()=>projectCompiledReturnCredit211Catalogue(poisoned));
});
