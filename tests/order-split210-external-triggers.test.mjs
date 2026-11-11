/** Authored basis tests only: no PostgreSQL/deparser/Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210TriggerRoster as derive,parseOrderSplit210TriggerDeclaration as parse,
  assertOrderSplit210TriggerBasisRoster as verify,ORDER_SPLIT210_TRIGGER_SOURCE_SHA256 as pin}
  from '../tools/parity/order-split210-external-triggers.mjs';
const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8');
const run=()=>derive({source210});
const all=r=>[...r.triggers,...r.constraints];
const clone=structuredClone;
// Independent literal table oracle; it is deliberately not obtained by parsing
// the same FOREACH arrays as the production derivation.
const bound=['orders','order_items','order_pick_items','reservations','reservation_locations','wms_reservation_layers',
  'stock','stock_locations','wms_layer_positions','stock_movements','stock_location_movements','wms_layer_movements'];
const rechecks=[];

test('closed source-derived27 triggers/3 constraint pairs match independent external and own table oracles',()=>{
  const r=run();assert.equal(r.source_sha256,pin);
  assert.deepEqual(r.counts,{own:15,external_bound:12,external_deferred:0,triggers:27,constraints:3});
  assert.deepEqual(r.groups.external_bound,bound.map(t=>`public.${t}.order_split210_bound`).sort());
  assert.deepEqual(r.groups.external_deferred,rechecks.map(t=>`public.${t}.order_split210_late_recheck`).sort());
  const own=['previews','source_rows','executions','targets','allocations','replay_duties'].map(s=>'order_split210_'+s);
  assert.deepEqual(r.groups.own_tables,[...own].sort());
  assert.deepEqual(r.groups.own,[...own.flatMap(t=>['immutable','no_truncate'].map(n=>`public.${t}.order_split210_${n}`)),
    'public.order_split210_previews.order_split210_preview_complete',
    'public.order_split210_executions.order_split210_execution_complete',
    'public.order_split210_replay_duties.order_split210_replay_complete'].sort());
  assert.deepEqual(r.constraint_pairs,r.constraints.map(c=>({trigger_key:c.key,constraint_key:c.key})));
  assert(verify(all(r),{source210}).authored_basis_equal);
});

test('complete RECORDS_SQL metadata fields and event masks are independently pinned',()=>{
  const r=run(),fields=['internal','name','enabled','type','function','attributes','arguments','constraint','constraint_relation',
    'deferrable','deferred','has_when','old_table','new_table','definition'].sort();
  for(const t of r.triggers){
    assert.deepEqual(Object.keys(t.value).sort(),fields);
    assert.equal(t.value.internal,false);assert.equal(t.value.enabled,'O');assert.equal(t.value.arguments,'');
    assert.deepEqual(t.value.attributes,[]);assert.equal(t.value.has_when,false);
    assert.equal(t.value.constraint_relation,null);assert.equal(t.value.old_table,null);assert.equal(t.value.new_table,null);
  }
  for(const [name,type,fn] of [['order_split210_bound',31,'order_split210_bound_guard()'],
    ['order_split210_immutable',27,'order_split210_immutable()'],['order_split210_no_truncate',34,'order_split210_immutable()'],
    ['order_split210_execution_complete',5,'order_split210_complete()']]){
    const rows=r.triggers.filter(t=>t.value.name===name);assert(rows.length>0);
    for(const t of rows){assert.equal(t.value.type,type);assert.equal(t.value.function,fn);}
  }
  for(const c of r.constraints){
    assert.equal(c.kind,'constraint');assert.equal(c.value.kind,'t');
    assert.deepEqual(Object.keys(c.value).sort(),['kind','deferrable','deferred','validated','local','inheritance_count','no_inherit','definition'].sort());
    assert.equal(c.value.deferrable,true);assert.equal(c.value.deferred,true);assert.equal(c.value.validated,true);
    assert.equal(c.value.local,true);assert.equal(c.value.no_inherit,true);assert.equal(c.value.inheritance_count,0);
    const t=r.triggers.find(t=>t.key===c.key);assert(t);assert.equal(t.value.constraint,c.key.split('.').at(-1));
  }
});

test('uncompiled definition AST is explicit; native deparser strings cannot masquerade as authored basis',()=>{
  const r=run();
  for(const flag of ['compiled_catalogue_records','source_compilation_performed','native_certification','application_activation','foreign_key_ri_roster_complete'])assert.equal(r[flag],false);
  assert.deepEqual(r.unresolved_pg_fields,['trigger.definition','constraint.definition']);
  const original=r.triggers.find(t=>t.value.name==='order_split210_bound');
  assert.deepEqual(original.value.definition.semantic_ast,{schema:'public',table:'order_items',name:'order_split210_bound',
    timing:'BEFORE',events:['INSERT','DELETE','UPDATE'],level:'ROW',function_schema:'public',function_name:'order_split210_bound_guard',
    function_arguments:[],constraint:false,deferrable:false,deferred:false,when:null,old_table:null,new_table:null});
  const records=clone(all(r));records[0].value.definition='CREATE TRIGGER guessed text';
  assert.throws(()=>verify(records,{source210}),/exact authored/);
  assert(Object.isFrozen(r)&&Object.isFrozen(original.value.definition.semantic_ast.events));
});

test('missing/extra/duplicate/source-alias or changed known metadata cannot enter exact basis',()=>{
  const r=run();
  for(const mutate of[
    rs=>rs.pop(),rs=>rs.push({...clone(rs[0]),key:'public.other.order_split210_bound'}),rs=>rs.push(clone(rs[0])),
    rs=>rs[0].kind='t',rs=>rs[0].kind='source',rs=>rs[0].key=rs[0].key.replace('public.','foreign.'),
    rs=>rs[0].value.enabled='D',rs=>rs[0].value.function='different_guard()',rs=>rs[0].value.type+=2,
    rs=>rs[0].value.deferrable=!rs[0].value.deferrable,rs=>rs[0].value.deferred=!rs[0].value.deferred,rs=>rs[0].value.arguments='00',
    rs=>rs[0].value.attributes=['quantity'],rs=>rs[0].value.internal=true,rs=>rs[0].value.has_when=true,
    rs=>rs[0].value.constraint_relation='orders',rs=>rs[0].value.old_table='old_rows',
    rs=>rs[0].value.extra='surprise',rs=>rs[0].value.extra=undefined,rs=>delete rs[0].value.new_table,
    rs=>rs.find(x=>x.kind==='constraint').value.kind='c',rs=>rs.find(x=>x.kind==='constraint').value.no_inherit=false,
    rs=>rs[0].value.definition.semantic_ast.table='other',
  ]){const records=clone(all(r));mutate(records);assert.throws(()=>verify(records,{source210}));}
  // Source-table aliases do not alter catalogue kind: real constraint kind t
  // belongs in value.kind, never in the outer discriminator.
  assert(verify(all(r).reverse(),{source210}).authored_basis_equal);
});

test('restricted semantic parser supports source whitespace and event order without guessing unsafe clauses',()=>{
  const a=parse('CREATE TRIGGER order_split210_bound BEFORE INSERT OR UPDATE OR DELETE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.order_split210_bound_guard();');
  const b=parse('CREATE TRIGGER order_split210_bound\nBEFORE DELETE OR INSERT OR UPDATE ON public.orders\nFOR EACH ROW EXECUTE FUNCTION public.order_split210_bound_guard()');
  assert.deepEqual(a,b);assert.equal(a.trigger.value.type,31);
  for(const sql of[
    'CREATE TRIGGER x AFTER INSERT ON public.orders FOR EACH ROW WHEN (true) EXECUTE FUNCTION public.f()',
    'CREATE TRIGGER x BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.f(\'argument\')',
    'CREATE TRIGGER x BEFORE INSERT OR INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.f()',
    'CREATE TRIGGER x BEFORE TRUNCATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.f()',
    'CREATE CONSTRAINT TRIGGER x BEFORE INSERT ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.f()',
    'CREATE TRIGGER x AFTER INSERT ON foreign.orders FOR EACH ROW EXECUTE FUNCTION public.f()',
    'CREATE TRIGGER x AFTER INSERT ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.f()',
  ])assert.throws(()=>parse(sql));
});

test('any changed source requires an explicit recut, not a prefix-based exception',()=>{
  assert.throws(()=>derive({source210:source210+'\n'}),/literal frozen/);
  assert.throws(()=>derive({source210:source210.replace("'stock_movements'","'other'")}),/literal frozen/);
  assert.throws(()=>derive({source210:source210+'\nCREATE TRIGGER order_split210_ignored BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.order_split210_bound_guard();'}),/literal frozen/);
});

test('removing external rechecks preserves all original Native source/quantity/money/history/IAM terminal functions',()=>{
  const prior={no_effects:'6223b164c6afe4c76913bf0fecd1026748c1b8f44d1df12e8f19954bdd543d69',
    terminal:'61af3fc882cd8fce1db8653bec8551e231aa932dfcb83dbded2897fbfa403ffd',
    capture:'c6b76d6cba81e382f201a83ad025468def60749863389265100e893b97b19c94',
    preview:'a1e369d223e16a8e83a9cd3ad9918b00447739a53c15294486583b8f34bb9768',
    execute:'6b66f2377ce09cdeab40d2109d336bfd79fc1bde0bd1cf238c8f5caa21535932',
    row_admission:'4b0c2da7c1d5f12611a1d11951e1c8a382aa4f902ccc767aced302e20cf98eff'};
  for(const [name,hash]of Object.entries(prior)){
    const start=source210.indexOf('CREATE FUNCTION public.order_split210_'+name+'(');
    assert(start>=0);const body=source210.indexOf('$$',start),end=source210.indexOf('$$;',body+2)+3;
    assert.equal(createHash('sha256').update(source210.slice(start,end)).digest('hex'),hash,name+' unchanged from reviewed a20 core');
  }
  assert(!source210.includes('order_split210_recheck'));
  assert(source210.includes('After every sibling finalizer AND constraint drain'));
  assert(source210.includes('no business DML/provider wait may follow it'));
  // Presence is not a claim of SQL execution; actual managed tail remains absent.
  assert.equal(run().application_activation,false);
});
