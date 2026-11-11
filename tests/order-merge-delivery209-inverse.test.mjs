/** SMALL SYNTHETIC metadata records, not source-compiled E209 or Native proof.
 * Real authored core text supplies only the eight FK semantic declarations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectOrderMergeDelivery209RecordSet as project,deriveOrderMergeDelivery209ForeignKeys as deriveFks,
 ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS as keys,ORDER_MERGE_DELIVERY209_INVERSE_LIMITS as limits}
 from '../tools/parity/order-merge-delivery209-inverse.mjs';
import {ORDER_MERGE_DELIVERY209_CHECK_EXPRESSIONS as expressions} from '../tools/parity/order-merge-delivery209-constraints.mjs';
const source209Business=readFileSync(new URL('../tools/parity/order-merge-delivery209-business.sql',import.meta.url),'utf8'),options={source209Business};
const copy=structuredClone,id=r=>r.kind+'\0'+r.key,sort=rows=>rows.sort((a,b)=>id(a)<id(b)?-1:id(a)>id(b)?1:0);
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const acl=[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}];
const fn=(source='BEGIN RETURN true;END')=>({owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,argument_names:null,argument_modes:null,arguments:'',result:'boolean',defaults:null,source,binary:null,config:['search_path=pg_catalog, public'],definition:'CREATE FUNCTION synthetic() RETURNS boolean AS $$'+source+'$$ LANGUAGE plpgsql',acl_null:false,acl:copy(acl)});
const relation=()=>({owner:'postgres',kind:'r',persistence:'p',access_method:'heap',row_security:true,force_row_security:true,replica_identity:'d',partition:false,partition_bound:null,partition_key:null,options:null,tablespace:null,acl_null:false,acl:[],view:null});
const constraint=(kind,definition,deferred=false)=>({kind,deferrable:deferred,deferred,validated:true,local:true,inheritance_count:0,no_inherit:true,definition});
const trigger=(name,func,type,deferred=false)=>({internal:false,name,enabled:'O',type,function:func,attributes:[],arguments:'',constraint:deferred?name:null,constraint_relation:null,deferrable:deferred,deferred,has_when:false,old_table:null,new_table:null,definition:'SYNTHETIC COMPILED-DEFINITION PLACEHOLDER '+name});
// Independent literal declarations from the authored receipt table.
const fkOracle=[
 ['tenant_id,execution_id','order_merge_executions','tenant_id,id',false],
 ['tenant_id,merge_preview_id','order_merge_previews','tenant_id,id',false],
 ['tenant_id,source_order_id','orders','tenant_id,id',false],['tenant_id,target_order_id','orders','tenant_id,id',false],
 ['actor_id','users','id',false],['tenant_id,api_key_id','api_keys','tenant_id,id',false],
 ['tenant_id,target_order_id,preview_id','buyer_address_previews','tenant_id,order_id,id',true],
 ['tenant_id,target_order_id,receipt_id','buyer_address_receipts','tenant_id,order_id,id',true],
];
function fixture(){
 const changes=keys.map((key,i)=>({kind:'function',key,before:fn('BEGIN RETURN '+i+';END'),after:fn('BEGIN RETURN '+(i+10)+';END')}));
 for(const table of ['buyer_address_previews','buyer_address_receipts'])for(const role of ['kind','actor'])changes.push({kind:'constraint',key:'public.'+table+'.synthetic_'+role+'_check',before:constraint('c',expressions[role+'_before']),after:constraint('c',expressions[role+'_after'])});
 const additions=['receipts','manifest','projection_basis'].map(s=>({kind:'relation',key:'public.order_merge_delivery209_'+s,value:relation()}));
 additions.push({kind:'function',key:'public.order_merge_delivery209_projection_map()',value:fn()});
 additions.push({kind:'type',key:'public._order_merge_delivery209_receipts',value:{owner:'postgres',kind:'b',category:'A',defined:true,not_null:false,base:null,element:'order_merge_delivery209_receipts',default:null,collation:null,enum_labels:[],acl_null:true,acl:[],default_expression:null,length:-1,by_value:false,preferred:false,delimiter:',',relation:null,subscript:'array_subscript_handler(internal)',array:null,input:'array_in(cstring,oid,integer)',output:'array_out(anyarray)',receive:'array_recv(internal,oid,integer)',send:'array_send(anyarray)',modifier_input:null,modifier_output:null,analyze:'array_typanalyze(internal)',alignment:'d',storage:'x',modifier:-1,dimensions:0}});
 additions.push({kind:'trigger',key:'public.order_merge_previews.order_merge_delivery209_source_preview',value:trigger('order_merge_delivery209_source_preview','order_merge_delivery209_preview_guard()',7)});
 additions.push({kind:'trigger',key:'public.order_merge_executions.order_merge_delivery209_complete',value:trigger('order_merge_delivery209_complete','order_merge_delivery209_complete()',5,true)});
 additions.push({kind:'constraint',key:'public.order_merge_executions.order_merge_delivery209_complete',value:constraint('t','TRIGGER DEFERRABLE INITIALLY DEFERRED',true)});
 fkOracle.forEach(([columns,target,remote,deferred],i)=>{
  // Names deliberately need not preserve namespace prefix (real PG truncates).
  const name=i===6?'order_merge_delivery209_rece_tenant_target_preview_fkey':'synthetic_fk_'+i;
  additions.push({kind:'constraint',key:'public.order_merge_delivery209_receipts.'+name,value:constraint('f',`FOREIGN KEY (${columns.split(',').join(', ')}) REFERENCES ${target}(${remote.split(',').join(', ')})`+(deferred?' DEFERRABLE INITIALLY DEFERRED':''),deferred)});
  for(const [action,type,table,opposite]of [['check_ins',5,'order_merge_delivery209_receipts',target],['check_upd',17,'order_merge_delivery209_receipts',target],['noaction_del',9,target,'order_merge_delivery209_receipts'],['noaction_upd',17,target,'order_merge_delivery209_receipts']]){
   const func='"RI_FKey_'+action+'"()';additions.push({kind:'trigger',key:`public.${table}.internal:${name}:${func}:${type}:`,value:{internal:true,name:null,enabled:'O',type,function:func,attributes:[],arguments:'',constraint:name,constraint_relation:opposite,deferrable:deferred,deferred,has_when:false,old_table:null,new_table:null,definition:null}});
  }
 });
 const unrelated=[{kind:'opaque_future_kind',key:'public.foreign_object',value:{original:{keep:['all','fields']}}},
  {kind:'function',key:'public.unrelated_order_merge_delivery209_mention()',value:{source:'order_merge_delivery209_receipts',arbitrary_header:true}}];
 const expected={schema:'source209-order-merge-delivery-exact-inverse/v1',additions:sort(additions),changes,removed:[]};
 const before=sort([...changes.map(c=>({kind:c.kind,key:c.key,value:copy(c.before)})),...copy(unrelated)]);
 const after=sort([...changes.map(c=>({kind:c.kind,key:c.key,value:copy(c.after)})),...copy(additions),...copy(unrelated)]);
 return {expected,before,after,unrelated};
}
test('source-only inverse requires explicit expectation AND literal source; no observed default, proof flag or other FK grammar adoption',()=>{
 const f=fixture();assert.throws(()=>project(f.after));assert.throws(()=>project(f.after,f.expected));
 assert.throws(()=>project(f.after,{...f.expected,source_compilation_proven:true},options));
 assert.throws(()=>project(f.after,f.expected,{source209Business:source209Business+'\n'}));
 assert.deepEqual(deriveFks(source209Business).map(f=>[f.columns.join(','),f.target,f.referenced_columns.join(','),f.deferred]),fkOracle);
});
test('exact14 descriptor inverse removes the entire expected addition roster and retains unknown unrelated records for parent comparison',()=>{
 const f=fixture(),snapshot=JSON.stringify(f.after),r=project(f.after,f.expected,options);
 assert.deepEqual(JSON.parse(JSON.stringify(r.records)),f.before);assert.equal(r.active,true);assert.equal(r.mode,'active209_inverse');assert.equal(r.changed_records,14);assert.equal(r.removed_records,f.expected.additions.length);assert.equal(r.authority,false);
 assert.equal(JSON.stringify(f.after),snapshot);assert(Object.isFrozen(r)&&Object.isFrozen(r.records));
 const unrelated=r.records.find(x=>x.key==='public.foreign_object');assert.deepEqual(JSON.parse(JSON.stringify(unrelated.value)),{original:{keep:['all','fields']}});
 assert(r.records.some(x=>x.key==='public.unrelated_order_merge_delivery209_mention()'));
});
test('deeply immutable caller rows are fully checked and reused; mutable inputs are captured without freezing or later caller poisoning',()=>{
 const f=fixture();freeze(f.after);freeze(f.expected);const r=project(f.after,f.expected,options);
 assert.equal(r.records.find(x=>x.key==='public.foreign_object'),f.after.find(x=>x.key==='public.foreign_object'));
 assert.equal(r.records.find(x=>x.key===keys[0]).value,f.expected.changes[0].before);
 const mutable=fixture(),r2=project(mutable.after,mutable.expected,options);assert(!Object.isFrozen(mutable.after));
 mutable.after.find(x=>x.key==='public.foreign_object').value.original.keep.push('POISON');mutable.expected.changes[0].before.source='POISON';
 assert(!JSON.stringify(r2).includes('POISON'));assert.throws(()=>{r2.records[0].value.extra=true;});
 const shallow=fixture();Object.freeze(shallow.after);shallow.after.forEach(Object.freeze);
 const r3=project(shallow.after,shallow.expected,options);assert(!Object.isFrozen(shallow.after[0].value));
 shallow.after.find(x=>x.key==='public.foreign_object').value.original.keep.push('SHALLOW_POISON');
 assert(!JSON.stringify(r3).includes('SHALLOW_POISON'),'Frozen parents do not brand mutable descendants');
});
test('absent209 on205 requires ALL14 exact BEFORE records, including missing/overloaded205 marker and four CHECKs',()=>{
 const f=fixture(),r=project(f.before,f.expected,options);assert.equal(r.mode,'absent209_on205');assert.equal(r.active,false);assert.equal(r.authority,false);
 for(const c of f.expected.changes){
  const bad=copy(f.before);bad.find(r=>id(r)===id(c)).value.definition+=' ';assert.throws(()=>project(bad,f.expected,options));
  assert.throws(()=>project(f.before.filter(r=>id(r)!==id(c)),f.expected,options));
 }
 const overloaded=sort([...copy(f.before),{kind:'function',key:'public.catalog_header205_valid(extra text)',value:fn()}]);assert.throws(()=>project(overloaded,f.expected,options));
});
test('earlier pre205 identity is explicitly inactive and preserves every unrelated raw fact, never READY',()=>{
 const f=fixture(),old=freeze([{kind:'opaque_future_kind',key:'public.pre205',value:{drift:'must reach parent comparator'}}]),earlier={...options,phase:'pre205_identity'},r=project(old,f.expected,earlier);
 assert.equal(r.mode,'pre205_identity');assert.equal(r.records,old);assert.equal(r.active,false);assert.equal(r.authority,false);assert.equal(r.changed_records,0);assert.equal(r.removed_records,0);assert(!Object.hasOwn(r,'ready'));
 // Partial209 cannot use the earlier identity path.
 assert.throws(()=>project(old,f.expected,options),'Default may not mistake missing205 for an earlier frame');
 assert.throws(()=>project(sort([...copy(old),copy(f.expected.additions[0])]),f.expected,earlier));
 assert.throws(()=>project([{kind:'function',key:'public.return_credit206_guards()',value:fn()}],f.expected,earlier));
 assert.throws(()=>project(f.before,f.expected,earlier));
});
test('every missing addition, namespace extra, external kind substitution and foreign-linked trigger is refused',()=>{
 const f=fixture();for(const a of f.expected.additions)assert.throws(()=>project(f.after.filter(r=>id(r)!==id(a)),f.expected,options));
 const extra=[{kind:'opaque_future_kind',key:'public.order_merge_delivery209_surprise',value:{}},
  {kind:'trigger',key:'public.orders.foreign_link',value:{function:'order_merge_delivery209_immutable()'}},
  {kind:'trigger',key:'public.other.internal:unknown',value:{constraint_relation:'order_merge_delivery209_receipts'}},
  {kind:'trigger',key:'public.other.internal:wrong',value:{constraint:'synthetic_fk_0'}}];
 for(const r of extra)assert.throws(()=>project(sort([...copy(f.after),r]),f.expected,options));
 const bad=copy(f.after),external=bad.find(r=>r.key==='public.order_merge_executions.order_merge_delivery209_complete'&&r.kind==='trigger');external.kind='rule';assert.throws(()=>project(sort(bad),f.expected,options));
});
test('all changed functions refuse overloads and header/ACL/config/source/definition drift, even with all additions intact',()=>{
 const f=fixture();for(const key of keys){
  const base=key.slice(0,key.indexOf('(')),overload={kind:'function',key:base+'(extra text)',value:fn()};assert.throws(()=>project(sort([...copy(f.after),overload]),f.expected,options));
  for(const [field,value]of [['owner','foreign'],['acl',[]],['config',['search_path=public']],['source','tampered'],['definition','tampered'],['strict',true]]){
   const bad=copy(f.after);bad.find(r=>r.key===key).value[field]=value;assert.throws(()=>project(bad,f.expected,options));
  }
 }
});
test('eight full authored FK records and all32 RI metadata records remain exact; no prefix-only or alternate actions admission',()=>{
 const f=fixture(),riRows=f.after.filter(r=>r.kind==='trigger'&&r.value.internal===true);assert.equal(riRows.length,32);
 for(const row of riRows)for(const [field,value]of [['type',31],['function','"RI_FKey_cascade_del"()'],['constraint','foreign'],['constraint_relation','foreign'],['deferrable',!row.value.deferrable],['deferred',!row.value.deferred],['attributes',['tenant_id']],['arguments','00'],['definition','fake'],['enabled','D']]){
  const bad=copy(f.after);bad.find(r=>id(r)===id(row)).value[field]=value;assert.throws(()=>project(bad,f.expected,options));
 }
 for(const mutate of [e=>e.additions.find(r=>r.kind==='constraint'&&r.value.kind==='f').value.definition+=' ON DELETE CASCADE',
  e=>e.additions.find(r=>r.kind==='constraint'&&r.value.kind==='f').value.definition='FOREIGN KEY (tenant_id) REFERENCES orders(tenant_id)',
  e=>e.additions=e.additions.filter(r=>!(r.kind==='constraint'&&r.value.kind==='f')).slice(),
  e=>e.additions=e.additions.filter(r=>!(r.kind==='trigger'&&r.value.internal===true&&r.value.type===5)),
  e=>e.additions.find(r=>r.kind==='trigger'&&r.value.internal===true).value.no_such_header=true]){
  const e=copy(f.expected);mutate(e);assert.throws(()=>project(f.after,e,options));
 }
});
test('CHECK oracle rejects permissive grammar/semantics and any missing full metadata; expectation cannot change grants or remove old records',()=>{
 const f=fixture();for(const mutate of [e=>e.changes.find(c=>c.kind==='constraint').after.definition="CHECK (kind IN('access','delivery','merge_inherit','foreign'))",
  e=>e.changes.find(c=>c.kind==='constraint').after.no_inherit=false,e=>delete e.changes[0].before.acl,
  e=>e.changes[0].after.acl.push({grantor:'postgres',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false}),
  e=>e.removed.push({kind:'function',key:'public.old()'}),e=>e.changes.pop(),e=>e.changes[0].key='public.foreign()',e=>e.changes[1]=copy(e.changes[0])]){
  const e=copy(f.expected);mutate(e);assert.throws(()=>project(f.after,e,options));
 }
});
test('input shape is bounded plain JSON: accessors are never executed, sparse/extra/prototype/cycle/duplicate/order defects refuse',()=>{
 const f=fixture();let calls=0;const getter={kind:'unknown',key:'public.getter',value:{}};Object.defineProperty(getter.value,'x',{enumerable:true,get(){calls++;return 1;}});
 const hidden={kind:'unknown',key:'public.hidden',value:{}};Object.defineProperty(hidden.value,'x',{enumerable:false,value:1});
 const symbol={kind:'unknown',key:'public.symbol',value:{[Symbol('x')]:1}},cycle={kind:'unknown',key:'public.cycle',value:{}};cycle.value.self=cycle;
 for(const input of [[getter],[hidden],[symbol],[cycle],[{kind:'unknown',key:'public.date',value:new Date()}],Array(2),[...f.after].reverse(),sort([...copy(f.after),copy(f.after[0])])])assert.throws(()=>project(input,f.expected,options));
 assert.equal(calls,0);
 for(const value of [undefined,NaN,Infinity,()=>true])assert.throws(()=>project([{kind:'unknown',key:'public.bad',value:{bad:value}}],f.expected,options));
 assert.throws(()=>project(Array(limits.records+1),f.expected,options));
 const huge={kind:'unknown',key:'public.huge',value:{text:'x'.repeat(limits.record_bytes)}};assert.throws(()=>project([huge],f.expected,options),/record bytes/);
});

// The extended fixture remains synthetic AFTER/own metadata, with seven REAL
// independently pinned Source204 BEFORE descriptors. It grants no Native proof.
let source22Before;
async function fixture22(){
 if(!source22Before){
  const {deriveOrderMergeDelivery209StartupClosure}=await import('../tools/parity/order-merge-delivery209-startup-capability-closure.mjs');
  const source204=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
  source22Before=deriveOrderMergeDelivery209StartupClosure({source204}).historical_predecessors;
 }
 const f=fixture(),checks=f.expected.changes.filter(c=>c.kind==='constraint');
 const seven=source22Before.map(r=>{
  const before=copy(r.value),source=before.source+'\n-- SYNTHETIC Source22 AFTER fixture, not compiled SQL\n';
  return{kind:r.kind,key:r.key,before,after:{...copy(before),source,definition:before.definition.replace(before.source,()=>source)}};
 });
 const changes=[...f.expected.changes.filter(c=>c.kind==='function'),...seven,...checks];
 const additions=copy(f.expected.additions);let i=0;
 while(additions.length<259)additions.push({kind:'function',key:'public.order_merge_delivery209_synthetic_'+String(i++).padStart(3,'0')+'()',value:fn()});
 const expected={...f.expected,changes,additions:sort(additions)};
 return{expected,before:sort([...changes.map(c=>({kind:c.kind,key:c.key,value:copy(c.before)})),...copy(f.unrelated)]),after:sort([...changes.map(c=>({kind:c.kind,key:c.key,value:copy(c.after)})),...copy(additions),...copy(f.unrelated)])};
}
const options22={...options,runtimeRevision:22};

test('Source22 requires explicit framing and exact17 function keys plus four independent CHECKs',async()=>{
 const f=await fixture22();
 assert.throws(()=>project(f.after,f.expected,options),/exact14 changes/);
 for(const runtimeRevision of [null,0,17,23,'22',false])assert.throws(()=>project(f.after,f.expected,{...options,runtimeRevision}),/supported runtime revision/);
 const old=fixture();assert.throws(()=>project(old.after,old.expected,options22),/exact21 changes/);
 assert.equal(project(old.after,old.expected,options).changed_records,14,'default framing remains unchanged');
 for(const runtimeRevision of [18,19,20,21])assert.equal(project(old.after,old.expected,{...options,runtimeRevision}).changed_records,14,'historical framing remains14/10');
 const current=project(f.after,f.expected,options22);
 assert.equal(current.changed_records,21);assert.equal(current.removed_records,259);assert.equal(current.authority,false);
 assert.deepEqual(JSON.parse(JSON.stringify(current.records)),f.before);
 const absent=project(f.before,f.expected,options22);assert.equal(absent.changed_records,0);assert.equal(absent.mode,'absent209_on205');assert.equal(absent.authority,false);
});

test('Source22 pins every complete Source204 BEFORE record, without adopting even matching mutated caller/current data',async()=>{
 const f=await fixture22();
 for(const original of source22Before){
  for(const field of ['owner','source','definition','config','acl']){
   const expected=copy(f.expected),current=copy(f.after),change=expected.changes.find(c=>c.key===original.key),before=change.before;
   const value=field==='acl'?[]:field==='config'?['search_path=public']:String(before[field])+'SYNTHETIC_DRIFT';
   before[field]=value;
   // Preserve header parity on both sides: the independent BEFORE pin, rather
   // than merely before/after header equality, must reject this contract.
   if(field==='source'){
    const oldSource=change.after.source;
    change.after.source+='\n-- SYNTHETIC matching current source drift\n';
    change.after.definition=change.after.definition.replace(oldSource,()=>change.after.source);
   }else if(field==='definition')change.after.definition+='\n-- SYNTHETIC matching current definition drift\n';
   else change.after[field]=copy(value);
   current.find(r=>r.kind==='function'&&r.key===original.key).value=copy(change.after);
   // Current AFTER metadata exactly matches the forged expectation. A later
   // current/expected mismatch cannot make this regression pass accidentally.
   assert.deepEqual(current.find(r=>r.key===original.key).value,change.after);
   assert.throws(()=>project(current,expected,options22),/literal complete Source204 AFTER record/);
  }
 }
});

test('Source22 rejects missing/overloaded/drifting public roots and preserves exact259 addition scope',async()=>{
 const f=await fixture22();
 for(const original of source22Before){
  const key=original.key,base=key.slice(0,key.indexOf('('));
  assert.throws(()=>project(f.after.filter(r=>r.key!==key),f.expected,options22));
  assert.throws(()=>project(sort([...copy(f.after),{kind:'function',key:base+'(extra text)',value:fn()}]),f.expected,options22));
  const drift=copy(f.after);drift.find(r=>r.key===key).value.acl=[];assert.throws(()=>project(drift,f.expected,options22));
 }
 for(const count of [258,260]){
  const expected=copy(f.expected);
  if(count===258)expected.additions=expected.additions.filter(r=>r.key!=='public.order_merge_delivery209_synthetic_000()');
  else expected.additions=sort([...expected.additions,{kind:'function',key:'public.order_merge_delivery209_extra()',value:fn()}]);
  assert.equal(expected.additions.length,count);assert.throws(()=>project(f.after,expected,options22),/exact259/);
 }
 const extra={kind:'function',key:'public.order_merge_delivery209_extra()',value:fn()};assert.throws(()=>project(sort([...copy(f.after),extra]),f.expected,options22));
 const bad=copy(f.after),ri=bad.find(r=>r.kind==='trigger'&&r.value.internal);ri.value.constraint_relation='foreign';assert.throws(()=>project(bad,f.expected,options22));
 const expected=copy(f.expected);expected.additions.find(r=>r.kind==='trigger'&&r.value.internal).value.function='"RI_FKey_cascade_del"()';assert.throws(()=>project(f.after,expected,options22));
});

test('Source22 keeps inactive pre205 identity strict and retains bounds/full descriptors',async()=>{
 const f=await fixture22(),old=freeze([{kind:'opaque_future_kind',key:'public.pre205',value:{all:'facts survive'}}]);
 const result=project(old,f.expected,{...options22,phase:'pre205_identity'});assert.equal(result.records,old);assert.equal(result.authority,false);assert.equal(result.active,false);
 assert.throws(()=>project(f.before,f.expected,{...options22,phase:'pre205_identity'}));
 assert.throws(()=>project(sort([...copy(old),copy(f.expected.additions[0])]),f.expected,{...options22,phase:'pre205_identity'}));
 const bad=copy(f.expected);delete bad.changes.find(c=>c.key===source22Before[0].key).after.defaults;assert.throws(()=>project(f.after,bad,options22));
 assert.throws(()=>project(Array(limits.records+1),f.expected,options22),/record count/);
});
