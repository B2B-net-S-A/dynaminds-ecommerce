/** Pure metadata representation inverse, not Native/IAM/startup admission.
 * REQUIRED expected records must separately be source-compiled, pinned and
 * reviewed by the caller. This argument is NOT authenticated here; no default
 * E209, observed adoption or source-proof flag is fabricated by this module.
 * No large E204/E205 constants, catalogue reader, DB or filesystem imports.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertOrderMergeDelivery209ConstraintChanges} from './order-merge-delivery209-constraints.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS,assertOrderMergeDelivery209StartupBeforeRecords} from './order-merge-delivery209-startup-roster.mjs';

export const ORDER_MERGE_DELIVERY209_INVERSE_LIMITS=Object.freeze({records:100000,record_bytes:8388608,encoded_bytes:134217728,json_nodes:1000000,json_depth:64});
export const ORDER_MERGE_DELIVERY209_BUSINESS_SHA256='79b71530489d59418d5f6a5df119ed2300da6f9aa7200c0433270ed174ce0fca';
export const ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS=Object.freeze([
 'public.buyer_address_preview_guard()','public.buyer_address_state_guard()',
 'public.buyer_address_guards()','public.buyer_address_fingerprint()',
 'public.manual_inventory_off_valid()','public.manual_inventory_off_projection_valid()',
 'public.partial_sale204_predecessor_definition(fn oid)','public.ordinary187_valid()',
 'public.partial_sale204_valid()','public.catalog_header205_valid()',
]);
export const ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS_V22=Object.freeze([
 ...ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS,...ORDER_MERGE_DELIVERY209_STARTUP_KEYS,
]);
const L=ORDER_MERGE_DELIVERY209_INVERSE_LIMITS,P='order_merge_delivery209_',ownTable=P+'receipts';
const sha=s=>createHash('sha256').update(s).digest('hex'),id=r=>r.kind+'\0'+r.key;
const externalPreview='public.order_merge_previews.order_merge_delivery209_source_preview';
const externalComplete='public.order_merge_executions.order_merge_delivery209_complete';
const fields={
 relation:['owner','kind','persistence','access_method','row_security','force_row_security','replica_identity','partition','partition_bound','partition_key','options','tablespace','acl_null','acl','view'],
 column:['position','type','not_null','generated','identity','storage','compression','statistics','options','foreign_options','collation','default','acl_null','acl'],
 constraint:['kind','deferrable','deferred','validated','local','inheritance_count','no_inherit','definition'],
 index:['table','unique','primary','exclusion','immediate','clustered','valid','ready','live','replica_identity','nulls_not_distinct','definition'],
 policy:['command','permissive','roles','using','check'],
 trigger:['internal','name','enabled','type','function','attributes','arguments','constraint','constraint_relation','deferrable','deferred','has_when','old_table','new_table','definition'],
 function:['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'],
 type:['owner','kind','category','defined','not_null','base','element','default','collation','enum_labels','acl_null','acl','default_expression','length','by_value','preferred','delimiter','relation','subscript','array','input','output','receive','send','modifier_input','modifier_output','analyze','alignment','storage','modifier','dimensions'],
};
function exact(v,keys){assert(v&&typeof v==='object'&&!Array.isArray(v),'209 object required');assert.deepEqual(Object.keys(v).sort(),[...keys].sort(),'209 exact fields');}
function equal(a,b){
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
}
// Fully inspect data properties before reuse. Foreign frozen objects do not
// acquire reader identity or authority; every call validates shape/bounds again.
// Only deeply immutable JSON nodes are reused. Mutable caller input is copied,
// never frozen/mutated in place. No verdict or projection cache exists.
function capture(v,depth=0,budget={nodes:0,bytes:0}){
 assert(++budget.nodes<=L.json_nodes&&depth<=L.json_depth,'209 JSON bounds');
 const charge=n=>{budget.bytes+=n;assert(budget.bytes<=L.encoded_bytes,'209 JSON byte-work bound');};
 charge(2);
 if(v===null||typeof v==='boolean')return v;
 if(typeof v==='string'){const n=Buffer.byteLength(v);assert(n<=L.record_bytes,'209 string bound');charge(n);assert(Buffer.from(v,'utf8').toString('utf8')===v,'209 valid UTF8 required');return v;}
 if(typeof v==='number'){assert(Number.isFinite(v),'209 finite JSON number');return v;}
 assert(v&&typeof v==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)),'209 plain JSON only');
 const array=Array.isArray(v);assert(array||Object.getPrototypeOf(v)!==Array.prototype,'209 plain JSON object');
 const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(v);
 assert(keys.every(k=>typeof k==='string'),'209 no symbol properties');
 if(array){assert(v.length<=L.json_nodes,'209 array bound');assert(keys.length===v.length+1,'209 dense array without extra properties');}
 const container=()=>array?[]:Object.create(null);
 let out=Object.isFrozen(v)?null:container();
 for(let i=0;i<keys.length;i++){
  const k=keys[i];
  if(array&&k==='length')continue;
  if(array)assert(/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length,'209 array index');
  else charge(Buffer.byteLength(k)+3);
  const d=descriptors[k];assert(Object.hasOwn(d,'value')&&d.enumerable,'209 enumerable data properties only');
  const child=capture(d.value,depth+1,budget);
  if(out===null&&child!==d.value){
   out=container();
   // Earlier validated children were unchanged; do not build a parallel full
   // tree for an already deeply frozen reader-owned metadata snapshot.
   for(let j=0;j<i;j++){const old=keys[j];if(array&&old==='length')continue;Object.defineProperty(out,old,{value:descriptors[old].value,enumerable:true,writable:true,configurable:true});}
  }
  if(out!==null)Object.defineProperty(out,k,{value:child,enumerable:true,writable:true,configurable:true});
 }
 return out===null?v:Object.freeze(out);
}
function shape(r){exact(r,['kind','key','value']);assert(typeof r.kind==='string'&&/^[a-z][a-z_0-9]*$/.test(r.kind),'209 record kind');
 assert(typeof r.key==='string'&&r.key.length>0&&Buffer.byteLength(r.key)<=8192&&!r.key.includes('\0'),'209 record key');assert(r.value&&typeof r.value==='object'&&!Array.isArray(r.value),'209 value object');}
function size(r,budget){const n=Buffer.byteLength(JSON.stringify(r));assert(n<=L.record_bytes,'209 record bytes');budget.bytes+=n;assert(budget.bytes<=L.encoded_bytes,'209 record-set bytes');}
function records(input){
 assert(Array.isArray(input)&&input.length<=L.records,'209 record count');const rows=capture(input);let previous='';const budget={bytes:0};
 for(const r of rows){shape(r);const key=id(r);assert(key>previous,'209 sorted unique records');previous=key;
  size(r,budget);}
 return rows;
}
function complete(kind,value){assert(Object.hasOwn(fields,kind),'209 supported addition kind');exact(value,fields[kind]);}
const functionName=key=>key.slice(0,key.indexOf('('));
function own(r){return r.key.startsWith('public.'+P)||r.key.startsWith('public._'+P);}
const cols=s=>s.split(',').map(c=>{c=c.trim();assert(/^[a-z][a-z_0-9]{0,62}$/.test(c),'209 FK column');return c;});

/** All eight declarations come from the pinned authored business source, NOT
 * expected/current metadata or a guessed constraint-name prefix. */
export function deriveOrderMergeDelivery209ForeignKeys(source209Business){
 assert(typeof source209Business==='string'&&Buffer.byteLength(source209Business)<=1048576,'209 bounded source required');
 assert.equal(sha(source209Business),ORDER_MERGE_DELIVERY209_BUSINESS_SHA256,'209 literal business source');
 const block=/^CREATE TABLE public\.order_merge_delivery209_receipts\(\n([\s\S]*?)^\);/m.exec(source209Business);assert(block,'209 own receipt declaration');
 const declarations=[...block[1].matchAll(/FOREIGN KEY\(([^)]+)\) REFERENCES public\.([a-z][a-z_0-9]*)\(([^)]+)\)( DEFERRABLE INITIALLY DEFERRED)?/g)];
 assert.equal(declarations.length,8);assert.equal((block[1].match(/\bREFERENCES\b/g)||[]).length,8);
 return Object.freeze(declarations.map(m=>Object.freeze({columns:Object.freeze(cols(m[1])),target:m[2],referenced_columns:Object.freeze(cols(m[3])),deferrable:!!m[4],deferred:!!m[4]})));
}
function parseFk(definition){
 assert(typeof definition==='string');const m=/^FOREIGN KEY \(([a-z_0-9, ]+)\) REFERENCES (?:public\.)?([a-z][a-z_0-9]*)\(([a-z_0-9, ]+)\)( DEFERRABLE INITIALLY DEFERRED)?$/.exec(definition);
 assert(m,'209 supported exact FK definition/actions');return{columns:cols(m[1]),target:m[2],referenced_columns:cols(m[3]),deferrable:!!m[4],deferred:!!m[4]};
}
function ri(name,fk,check,event){
 const table=check?ownTable:fk.target,opposite=check?fk.target:ownTable;
 const fn='"RI_FKey_'+(check?'check_'+(event==='INSERT'?'ins':'upd'):'noaction_'+(event==='DELETE'?'del':'upd'))+'"()',type=event==='INSERT'?5:event==='DELETE'?9:17;
 return {kind:'trigger',key:`public.${table}.internal:${name}:${fn}:${type}:`,value:{internal:true,name:null,enabled:'O',type,function:fn,attributes:[],arguments:'',constraint:name,
  constraint_relation:opposite,deferrable:fk.deferrable,deferred:fk.deferred,has_when:false,old_table:null,new_table:null,definition:null}};
}
function foreignKeys(additions,source){
 const authored=deriveOrderMergeDelivery209ForeignKeys(source),seen=new Set(),byName=new Map(),riRows=[];
 const candidates=additions.filter(r=>r.kind==='constraint'&&r.value.kind==='f');assert.equal(candidates.length,8,'209 all eight authored FKs');
 for(const row of candidates){
  const m=/^public\.order_merge_delivery209_receipts\.([a-z_][a-z_0-9]{0,62})$/.exec(row.key);assert(m,'209 own FK identity');
  const fk=parseFk(row.value.definition),position=authored.findIndex(a=>equal(a,fk));assert(position>=0&&!seen.has(position),'209 exact distinct authored FK columns/target/actions');seen.add(position);
  assert(equal(row.value,{kind:'f',deferrable:fk.deferrable,deferred:fk.deferred,validated:true,local:true,inheritance_count:0,no_inherit:true,definition:row.value.definition}),'209 full FK metadata');
  assert(!byName.has(m[1]),'209 distinct authored FK name');byName.set(m[1],fk);
  riRows.push(ri(m[1],fk,true,'INSERT'),ri(m[1],fk,true,'UPDATE'),ri(m[1],fk,false,'DELETE'),ri(m[1],fk,false,'UPDATE'));
 }
 const actual=additions.filter(r=>r.kind==='trigger'&&r.value.internal===true);
 const expected=[...riRows].sort((a,b)=>id(a)<id(b)?-1:1);assert(equal(actual,expected),'209 complete exact32 linked RI records');
 return byName;
}
function externalTrigger(r){
 const completeGuard=r.key===externalComplete,name=completeGuard?'order_merge_delivery209_complete':'order_merge_delivery209_source_preview';
 const {definition,...metadata}=r.value;assert(typeof definition==='string'&&definition.length>0,'209 compiled external trigger definition');
 assert(equal(metadata,{internal:false,name,enabled:'O',type:completeGuard?5:7,function:completeGuard?'order_merge_delivery209_complete()':'order_merge_delivery209_preview_guard()',attributes:[],arguments:'',constraint:completeGuard?name:null,
  constraint_relation:null,deferrable:completeGuard,deferred:completeGuard,has_when:false,old_table:null,new_table:null}),'209 exact external trigger metadata');
}
function expectation(input,source,runtimeRevision){
 const functionKeys=runtimeRevision===22?ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS_V22:ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS;
 const changesCount=functionKeys.length+4;
 const e=capture(input);exact(e,['schema','additions','changes','removed']);assert.equal(e.schema,'source209-order-merge-delivery-exact-inverse/v1');assert(equal(e.removed,[]),'209 no removals');
 assert(Array.isArray(e.changes)&&e.changes.length===changesCount,'209 exact'+changesCount+' changes');const ids=new Set(),functions=new Set(),checks=[];
 for(const c of e.changes){
  exact(c,['kind','key','before','after']);shape({kind:c.kind,key:c.key,value:c.before});assert(!ids.has(id(c)),'209 duplicate change');ids.add(id(c));
  assert(!equal(c.before,c.after),'209 real descriptor change');complete(c.kind,c.before);complete(c.kind,c.after);
  if(c.kind==='function'){
   assert(functionKeys.includes(c.key),'209 exact changed function key');functions.add(c.key);
   assert(typeof c.before.source==='string'&&typeof c.after.source==='string'&&c.before.source!==c.after.source,'209 changed complete function source');
   assert(typeof c.before.definition==='string'&&typeof c.after.definition==='string','209 full function definitions');
   const {source:bs,definition:bd,...before}=c.before,{source:as,definition:ad,...after}=c.after;
   assert(equal(before,after),'209 function headers/ACL remain literal');
  }else{assert.equal(c.kind,'constraint');assert(c.before.kind==='c'&&c.after.kind==='c');assert(/^public\.(buyer_address_previews|buyer_address_receipts)\.[a-z_][a-z_0-9]{0,62}$/.test(c.key),'209 exact CHECK identity');checks.push(c);}
 }
 assert.equal(functions.size,functionKeys.length);assertOrderMergeDelivery209ConstraintChanges(checks);
 if(runtimeRevision===22){
  // These seven full BEFORE records come from literal Source204 AFTER pins.
  // Their independent source witness cannot be replaced by caller/current JSON.
  // AFTER/additions still require the caller's separately compiled contract.
  assertOrderMergeDelivery209StartupBeforeRecords(ORDER_MERGE_DELIVERY209_STARTUP_KEYS.map(key=>{
   const c=e.changes.find(change=>change.kind==='function'&&change.key===key);
   assert(c,'209 complete Source22 predecessor roster');return{kind:c.kind,key:c.key,value:c.before};
  }));
 }
 const additions=records(e.additions);assert(additions.length>0,'209 complete additions required');const fks=foreignKeys(additions,source);
 if(runtimeRevision===22)assert.equal(additions.length,259,'209 Source22 exact259 source-compiled additions');
 const budget={bytes:0};for(const c of e.changes)for(const side of ['before','after'])size({kind:c.kind,key:c.key,value:c[side]},budget);for(const r of additions)size(r,budget);
 for(const r of additions){
  complete(r.kind,r.value);assert(!ids.has(id(r)),'209 additions/changes disjoint');
  if(own(r))continue;
  if(r.kind==='trigger'&&[externalPreview,externalComplete].includes(r.key)){externalTrigger(r);continue;}
  if(r.kind==='constraint'&&r.key===externalComplete){assert(equal(r.value,{kind:'t',deferrable:true,deferred:true,validated:true,local:true,inheritance_count:0,no_inherit:true,definition:'TRIGGER DEFERRABLE INITIALLY DEFERRED'}),'209 exact external deferred constraint');continue;}
  assert(r.kind==='trigger'&&r.value.internal===true&&fks.has(r.value.constraint),'209 exact addition scope');
 }
 for(const suffix of ['receipts','manifest','projection_basis'])assert(additions.some(r=>r.kind==='relation'&&r.key==='public.'+P+suffix),'209 all own relations');
 for(const key of [externalPreview,externalComplete])assert(additions.some(r=>r.kind==='trigger'&&r.key===key),'209 both external triggers');
 assert(additions.some(r=>r.kind==='constraint'&&r.key===externalComplete),'209 external completion constraint');
 return {changes:e.changes,additions,fks,functionKeys,changesCount};
}
function related(r,e){
 if(own(r)||r.key===externalPreview||r.key===externalComplete)return true;
 if(r.kind!=='trigger')return false;
 return e.fks.has(r.value.constraint)||['constraint_relation','function'].some(k=>typeof r.value[k]==='string'&&new RegExp('^(?:public\\.)?'+P).test(r.value[k]));
}

/** Metadata only. The caller must separately authenticate the compiled expected
 * contract; even an active result does not mean installed/READY/Native-valid.
 * phase is a trusted comparison-path selector, NEVER a runtime request field.
 * Explicit pre205_identity preserves every row for the required parent compare;
 * it cannot verify a missing205 gate or be accepted as source/Native readiness. */
export function projectOrderMergeDelivery209RecordSet(input,expected,{source209Business,phase='post205',runtimeRevision=21}={}){
 assert(phase==='post205'||phase==='pre205_identity','209 fixed comparison phase');
 assert([18,19,20,21,22].includes(runtimeRevision),'209 explicit supported runtime revision');
 const e=expectation(expected,source209Business,runtimeRevision),rows=records(input),selected=rows.filter(r=>related(r,e));
 const has205=rows.some(r=>r.kind==='function'&&functionName(r.key)==='public.catalog_header205_valid');
 if(phase==='pre205_identity'){
  assert(!selected.length&&!has205&&!rows.some(r=>/^public\._?return_credit20[678]_/.test(r.key)),'209 pre205 identity only before later families');
  return Object.freeze({records:rows,mode:'pre205_identity',active:false,removed_records:0,changed_records:0,authority:false});
 }
 assert(has205,'209 post205 comparison requires original205 marker');
 const byId=new Map(rows.map(r=>[id(r),r]));
 for(const key of e.functionKeys){
  const found=rows.filter(r=>r.kind==='function'&&functionName(r.key)===functionName(key));assert(found.length===1&&found[0].key===key,'209 missing/overloaded changed function');
 }
 if(!selected.length){
  for(const c of e.changes)assert(byId.has(id(c))&&equal(byId.get(id(c)).value,c.before),'209 absent requires exact'+e.changesCount+' predecessor records');
  return Object.freeze({records:rows,mode:'absent209_on205',active:false,removed_records:0,changed_records:0,authority:false});
 }
 assert(equal(selected,e.additions),'209 complete current addition roster/descriptors');
 for(const c of e.changes)assert(byId.has(id(c))&&equal(byId.get(id(c)).value,c.after),'209 complete current successor descriptor');
 const removed=new Set(e.additions.map(id)),changes=new Map(e.changes.map(c=>[id(c),c]));
 const out=[];for(const r of rows)if(!removed.has(id(r))){const c=changes.get(id(r));out.push(c?Object.freeze({kind:r.kind,key:r.key,value:c.before}):r);}
 return Object.freeze({records:Object.freeze(out),mode:'active209_inverse',active:true,removed_records:e.additions.length,changed_records:e.changesCount,authority:false});
}
