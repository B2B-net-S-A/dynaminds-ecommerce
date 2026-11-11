/** Actual pure source exports; no PG/deparser/Native or application acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deriveOrderSplit210ForeignKeyRoster as derive,parseOrderSplit210ForeignKeyDeclaration as parse,
 orderSplit210ForeignKeyName as name,assertOrderSplit210ForeignKeyBasisRoster as verify,
 ORDER_SPLIT210_FK_SOURCE_SHA256 as pin,ORDER_SPLIT210_FK_SCHEMA_SHA256 as schemaPin}
 from '../tools/parity/order-split210-foreign-keys.mjs';
const sources={source210:readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8'),
 sourceSchema:readFileSync(new URL('../server/schema.sql',import.meta.url),'utf8')};
const run=()=>derive(sources),all=r=>[...r.constraints,...r.ri_triggers],copy=structuredClone;
// Literal independent table/column/target oracle, not production parser output.
const oracle=[
 ['previews','tenant_id','tenants','id'],['previews','actor_id','users','id'],
 ['previews','tenant_id,source_order_id','orders','tenant_id,id'],['previews','tenant_id,api_key_id','api_keys','tenant_id,id'],
 ['source_rows','tenant_id,preview_id','order_split210_previews','tenant_id,id'],['source_rows','tenant_id,source_order_id','orders','tenant_id,id'],
 ['executions','actor_id','users','id'],['executions','tenant_id,preview_id','order_split210_previews','tenant_id,id'],
 ['executions','tenant_id,source_order_id','orders','tenant_id,id'],['executions','tenant_id,api_key_id','api_keys','tenant_id,id'],
 ['targets','tenant_id,execution_id,preview_id','order_split210_executions','tenant_id,id,preview_id'],
 ['targets','tenant_id,order_id','orders','tenant_id,id'],['targets','tenant_id,source_order_id','orders','tenant_id,id'],
 ['allocations','tenant_id,execution_id,result_index','order_split210_targets','tenant_id,execution_id,result_index'],
 ['allocations','tenant_id,execution_id,preview_id','order_split210_executions','tenant_id,id,preview_id'],
 ['allocations','tenant_id,preview_id,source_item_id','order_split210_source_rows','tenant_id,preview_id,source_item_id'],
 ['replay_duties','actor_id','users','id'],['replay_duties','tenant_id,api_key_id','api_keys','tenant_id,id'],
];
test('complete18 FK/72 RI source roster matches independent local/referenced column oracle',()=>{
 const r=run();assert.equal(r.source_sha256,pin);assert.equal(r.schema_source_sha256,schemaPin);
 assert.deepEqual(r.counts,{foreign_keys:18,ri_triggers:72,own_ri_triggers:48,external_ri_triggers:24});
 assert.deepEqual(r.foreign_keys.map(f=>[f.table.replace('order_split210_',''),f.columns.join(','),f.referenced_table,f.referenced_columns.join(',')]),oracle);
 assert.equal(r.constraints.length,18);assert.equal(new Set(r.ri_triggers.map(t=>t.key)).size,72);
 assert(verify(all(r),sources).authored_basis_equal);assert(verify(all(r).reverse(),sources).authored_basis_equal);
});
test('three actual long composite names use PG63byte balancing, not prefix or naive concatenation truncation',()=>{
 const r=run(),rows=r.foreign_keys.filter(f=>f.table==='order_split210_allocations');
 assert.deepEqual(rows.map(f=>f.name),[
  'order_split210_allocations_tenant_id_execution_id_result_i_fkey',
  'order_split210_allocations_tenant_id_execution_id_preview__fkey',
  'order_split210_allocations_tenant_id_preview_id_source_ite_fkey']);
 for(const f of rows){assert.equal(Buffer.byteLength(f.name),63);assert.notEqual(f.name,(f.table+'_'+f.columns.join('_')+'_fkey').slice(0,63));}
 const table='a'.repeat(63),column='b'.repeat(63),first='a'.repeat(29)+'_'+'b'.repeat(28)+'_fkey';
 assert.equal(name(table,[column]),first);
 assert.equal(name(table,[column],[first]),'a'.repeat(28)+'_'+'b'.repeat(28)+'_fkey1');
 for(const args of [['foreign.name',['id']],['x',['quoted-name']],['x',['id','id']],['é',['id']],['x',['id'],['bad.name']]])assert.throws(()=>name(...args));
});
test('each FK has exactly two child checks and two parent actions, bound to full original FK name/opposite relation',()=>{
 const r=run();
 for(const f of r.foreign_keys){
  const linked=r.ri_triggers.filter(t=>t.value.constraint===f.name);assert.equal(linked.length,4);
  const expected=[['check_ins',5,f.table,f.referenced_table],['check_upd',17,f.table,f.referenced_table],
   ['noaction_del',9,f.referenced_table,f.table],['noaction_upd',17,f.referenced_table,f.table]];
  for(const [action,type,table,opposite]of expected){
   const fn='"RI_FKey_'+action+'"()',t=linked.find(t=>t.value.function===fn);assert(t);
   assert.equal(t.key,`public.${table}.internal:${f.name}:${fn}:${type}:`);
   assert.deepEqual(t.value,{internal:true,name:null,enabled:'O',type,function:fn,attributes:[],arguments:'',constraint:f.name,
    constraint_relation:opposite,deferrable:f.deferred,deferred:f.deferred,has_when:false,old_table:null,new_table:null,definition:null});
  }
 }
});
test('only explicit targets order reference defers its four RI triggers; full eight-field FK metadata is preserved',()=>{
 const r=run(),deferred=r.foreign_keys.filter(f=>f.deferred);assert.equal(deferred.length,1);
 assert.equal(deferred[0].table,'order_split210_targets');assert.deepEqual(deferred[0].columns,['tenant_id','order_id']);
 assert.equal(r.ri_triggers.filter(t=>t.value.deferrable&&t.value.deferred).length,4);
 for(const f of r.foreign_keys){
  assert.equal(f.on_update,'NO ACTION');assert.equal(f.on_delete,'NO ACTION');assert.equal(f.update_action,'a');assert.equal(f.delete_action,'a');assert.equal(f.match,'SIMPLE');
  const c=r.constraints.find(c=>c.key===f.constraint_key);assert(c);
  assert.deepEqual(Object.keys(c.value).sort(),['kind','deferrable','deferred','validated','local','inheritance_count','no_inherit','definition'].sort());
  assert.equal(c.value.kind,'f');assert.equal(c.value.no_inherit,true);assert.equal(c.value.inheritance_count,0);assert.equal(c.value.validated,true);assert.equal(c.value.local,true);
  assert.equal(c.value.definition.schema,'uncompiled-pg-foreign-key-definition/v1');
  assert.deepEqual(c.value.definition.semantic_ast,{...Object.fromEntries(Object.entries(f).filter(([k])=>k!=='constraint_key'))});
 }
});
test('omitted referenced columns require actual pinned source primary keys, no presumed id',()=>{
 const table='order_split210_previews',declaration='actor_id uuid NOT NULL REFERENCES public.users';
 assert.throws(()=>parse({table,declaration}),/source primary key/);
 assert.deepEqual(parse({table,declaration,primaryKeys:{users:['id']}}).referenced_columns,['id']);
 const r=run();assert.equal(r.foreign_keys.filter(f=>f.referenced_columns_implicit).length,4);
 assert.throws(()=>derive({...sources,sourceSchema:sources.sourceSchema.replace('CREATE TABLE users (id uuid PRIMARY KEY','CREATE TABLE users (id uuid NOT NULL')}),/literal base/);
});
test('strict parser refuses unknown actions, partial validation, named/quoted/schema drift, duplicate or incomplete columns',()=>{
 const table='order_split210_targets',good='FOREIGN KEY(tenant_id,order_id) REFERENCES public.orders(tenant_id,id)';
 assert(parse({table,declaration:good}).validated);assert(parse({table,declaration:good+' DEFERRABLE INITIALLY DEFERRED'}).deferred);
 for(const declaration of [good+' ON DELETE CASCADE',good+' ON UPDATE RESTRICT',good+' MATCH FULL',good+' NOT VALID',good+' NOT ENFORCED',good+' DEFERRABLE',
  'CONSTRAINT chosen '+good,good.replace('public.','private.'),good.replace('order_id','"order_id"'),good.replace('tenant_id,order_id','tenant_id,tenant_id'),
  good.replace('tenant_id,id)','id)'),good.replace('(tenant_id,id)','(tenant_id,tenant_id)'),good+'; DROP TABLE public.orders',
  'order_id uuid REFERENCES public.orders(id)','order_id uuid NOT NULL REFERENCES public.orders(id) DEFAULT gen_random_uuid()'])assert.throws(()=>parse({table,declaration}));
});
test('missing/extra/duplicate/tampered FK or linked internal RI never passes authored basis equality',()=>{
 const r=run(),mutations=[
  rs=>rs.pop(),rs=>rs.push(copy(rs[0])),rs=>rs.push({...copy(rs[0]),key:'public.other.foreign_fkey'}),
  rs=>rs[0].kind='f',rs=>rs[0].value.no_inherit=false,rs=>rs[0].value.definition='guessed PG text',
  rs=>rs[0].value.definition.semantic_ast.referenced_columns.reverse(),rs=>rs[0].value.definition.semantic_ast.on_delete='CASCADE',
  rs=>rs[0].value.definition.semantic_ast.columns.push('surprise'),rs=>rs[0].value.extra=undefined,
  rs=>rs.find(r=>r.kind==='trigger').value.constraint_relation='other',rs=>rs.find(r=>r.kind==='trigger').value.constraint+='suffix',
  rs=>rs.find(r=>r.kind==='trigger').value.function='"RI_FKey_cascade_del"()',rs=>rs.find(r=>r.kind==='trigger').value.type=31,
  rs=>rs.find(r=>r.kind==='trigger').value.enabled='D',rs=>rs.find(r=>r.kind==='trigger').value.deferrable=true,
  rs=>rs.find(r=>r.kind==='trigger').value.attributes=['order_id'],rs=>rs.find(r=>r.kind==='trigger').value.arguments='00',
  rs=>rs.find(r=>r.kind==='trigger').value.definition='fake internal deparser',rs=>rs.find(r=>r.kind==='trigger').value.name='RI_ConstraintTrigger_a_123',
  rs=>rs.find(r=>r.kind==='trigger').key+='foreign',rs=>delete rs.find(r=>r.kind==='trigger').value.new_table,
 ];
 for(const mutate of mutations){const rows=copy(all(r));mutate(rows);assert.throws(()=>verify(rows,sources));}
});
test('source recut and real compilation/namespace verification remain explicit, no Native or deparser claim',()=>{
 const r=run();for(const key of ['compiled_catalogue_records','source_compilation_performed','native_certification','application_activation'])assert.equal(r[key],false);
 assert.deepEqual(r.namespace_precondition,{generated_fk_names_unoccupied:true,verified:false});assert.deepEqual(r.unresolved_pg_fields,['constraint.definition']);
 assert(Object.isFrozen(r)&&Object.isFrozen(r.foreign_keys[0].referenced_columns)&&Object.isFrozen(r.ri_triggers[0].value));
 for(const source210 of [sources.source210+'\n',sources.source210.replace('REFERENCES public.tenants','REFERENCES public.users'),sources.source210.replace('FOREIGN KEY(tenant_id,preview_id)','FOREIGN KEY(tenant_id,preview_id,source_item_id)')])assert.throws(()=>derive({...sources,source210}),/literal frozen/);
});
