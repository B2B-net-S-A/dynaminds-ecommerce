/** Metadata representation ONLY. `expected` is REQUIRED, separately source-
 * authored, pinned and reviewed by the trusted caller. Source compilation
 * and Native acceptance are separate proofs, never granted by this inverse. This module authenticates
 * the closed source roster, not that caller's descriptor authority. No default
 * contract, DB/FS IO, Native verdict, IAM, installation or readiness admission. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRecoverySchema} from "../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs";

export const ORDER_SPLIT210_V2_CHANGED_FUNCTION_KEYS=Object.freeze([
 'public.fa3_draft_fingerprint()','public.b2b_invoice_fingerprint()',
 'public.b2b_credit_fingerprint()','public.wms_row_guard()',
 'public.order_merge_delivery209_validation_snapshot()',
 'public.order_merge_delivery209_predecessor_descriptor(fn oid)',
 'public.order_merge_delivery209_predecessor_definition(fn oid)',
 'public.order_merge_delivery209_predecessor_source(fn oid)',
 'public.order_merge_delivery209_predecessor_metadata(value jsonb)',
 'public.order_merge_delivery209_predecessor_descriptor(fn oid, entries jsonb)',
 'public.order_merge_delivery209_predecessor_definition(fn oid, entries jsonb)',
 'public.order_merge_delivery209_predecessor_source(fn oid, entries jsonb)',
 'public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)',
 'public.order_merge_delivery209_predecessor_source_sha(fn oid, entries jsonb)',
 'public.buyer_address_guards()',
]);
export const ORDER_SPLIT210_V3_CHANGED_FUNCTION_KEYS=Object.freeze([
 ...ORDER_SPLIT210_V2_CHANGED_FUNCTION_KEYS,'public.financial_return_upgrade_valid()',
]);
export const ORDER_SPLIT210_V4_CHANGED_FUNCTION_KEYS=Object.freeze([
 ...ORDER_SPLIT210_V3_CHANGED_FUNCTION_KEYS,
 'public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)',
 'public.order_merge_delivery209_buyer_guards(manual_basis jsonb)',
 'public.order_merge_delivery209_startup_operative_valid(entries jsonb)',
 'public.ordinary181_financial_valid(manual_basis jsonb)',
]);
export const ORDER_SPLIT210_V5_CHANGED_FUNCTION_KEYS=Object.freeze([
 ...ORDER_SPLIT210_V4_CHANGED_FUNCTION_KEYS,'public.ordinary181_credit_calculate(projection_ok boolean)',
]);
export const ORDER_SPLIT210_V6_CHANGED_FUNCTION_KEYS=Object.freeze([
 ...ORDER_SPLIT210_V5_CHANGED_FUNCTION_KEYS,'public.ordinary180_projection_valid(b jsonb)',
]);
export const ORDER_SPLIT210_V7_CHANGED_FUNCTION_KEYS=Object.freeze([...ORDER_SPLIT210_V6_CHANGED_FUNCTION_KEYS]);
export const ORDER_SPLIT210_CHANGED_FUNCTION_KEYS=ORDER_SPLIT210_V6_CHANGED_FUNCTION_KEYS;
const profiles=Object.freeze({
 'source210-order-split-exact-inverse/v2':ORDER_SPLIT210_V2_CHANGED_FUNCTION_KEYS,
 'source210-order-split-exact-inverse/v3':ORDER_SPLIT210_V3_CHANGED_FUNCTION_KEYS,
 'source210-order-split-exact-inverse/v4':ORDER_SPLIT210_V4_CHANGED_FUNCTION_KEYS,
 'source210-order-split-exact-inverse/v5':ORDER_SPLIT210_V5_CHANGED_FUNCTION_KEYS,
 'source210-order-split-exact-inverse/v6':ORDER_SPLIT210_V6_CHANGED_FUNCTION_KEYS,
 'source210-order-split-exact-inverse/v7':ORDER_SPLIT210_V7_CHANGED_FUNCTION_KEYS,
});
export const ORDER_SPLIT210_ADDITION_COUNTS=Object.freeze({relation:24,column:131,constraint:168,index:16,policy:8,trigger:103,function:27,type:16});
export const ORDER_SPLIT210_V7_ADDITION_COUNTS=Object.freeze({...ORDER_SPLIT210_ADDITION_COUNTS,column:132});
const counts=Object.freeze({relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types'});
const id=r=>r.kind+'\0'+r.key,sha=s=>createHash('sha256').update(s).digest('hex');
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v),'210 object required');assert.deepEqual(Object.keys(v).sort(),keys.slice().sort(),'210 exact fields');};
function equal(a,b){if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));}
function capture(v,depth=0,budget={nodes:0,bytes:0}){
 assert(++budget.nodes<=200000&&depth<=64,'210 expected JSON bounds');
 if(v===null||typeof v==='boolean')return v;
 if(typeof v==='number'){assert(Number.isFinite(v),'210 finite JSON');return v;}
 if(typeof v==='string'){budget.bytes+=Buffer.byteLength(v);assert(budget.bytes<=8388608&&Buffer.from(v).toString('utf8')===v,'210 bounded UTF8');return v;}
 assert(v&&typeof v==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)),'210 plain JSON');
 const array=Array.isArray(v),keys=Reflect.ownKeys(v),descriptors=Object.getOwnPropertyDescriptors(v),out=array?[]:Object.create(null);
 assert(array||Object.getPrototypeOf(v)!==Array.prototype,'210 object prototype');
 if(array)assert(v.length<=100000&&keys.length===v.length+1,'210 dense bounded array');
 for(const k of keys){assert(typeof k==='string','210 no symbols');if(array&&k==='length')continue;
  if(array)assert(/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length,'210 array index');
  const d=descriptors[k];assert(Object.hasOwn(d,'value')&&d.enumerable,'210 data properties only');budget.bytes+=Buffer.byteLength(k)+3;assert(budget.bytes<=8388608,'210 expected byte-work bound');
  Object.defineProperty(out,k,{value:capture(d.value,depth+1,budget),enumerable:true});
 }return Object.freeze(out);
}
function row(r){exact(r,['kind','key','value']);assert(Object.hasOwn(counts,r.kind),'210 declared kind');assert(typeof r.key==='string'&&r.key.length&&Buffer.byteLength(r.key)<=8192&&!r.key.includes('\0'),'210 record key');assert(r.value&&typeof r.value==='object'&&!Array.isArray(r.value),'210 full record value');}
function expectation(expected){
 const e=capture(expected);exact(e,['schema','additions','changes','removed','inactive_ancestors']);assert(Object.hasOwn(profiles,e.schema),'210 explicit known inverse version');const keys=profiles[e.schema];assert(equal(e.removed,[]),'210 no source removals');
 const v7=e.schema==='source210-order-split-exact-inverse/v7',additionCount=v7?494:493;
 assert(Array.isArray(e.additions)&&e.additions.length===additionCount&&Array.isArray(e.changes)&&e.changes.length===keys.length,'210 complete source counts');
 if(e.schema==='source210-order-split-exact-inverse/v3')assert.deepEqual(e.changes.map(c=>c.key),[...keys],'210 ordered sixteen function identities');
 if(e.schema==='source210-order-split-exact-inverse/v4')assert.deepEqual(e.changes.map(c=>c.key),[...keys],'210 ordered twenty function identities');
 if(e.schema==='source210-order-split-exact-inverse/v5')assert.deepEqual(e.changes.map(c=>c.key),[...keys],'210 ordered twenty-one function identities');
 if(e.schema==='source210-order-split-exact-inverse/v6'||v7)assert.deepEqual(e.changes.map(c=>c.key),[...keys],'210 ordered twenty-two function identities');
 let previous='';const actualCounts=Object.fromEntries(Object.keys(counts).map(k=>[k,0]));
 for(const r of e.additions){row(r);assert(id(r)>previous,'210 sorted unique additions');previous=id(r);actualCounts[r.kind]++;}
 assert.deepEqual(actualCounts,v7?ORDER_SPLIT210_V7_ADDITION_COUNTS:ORDER_SPLIT210_ADDITION_COUNTS,'210 all eight source kind counts');
 assert.equal(sha(e.additions.map(id).join('\n')),v7?'56f044ef08fa8edf5e020795c3c5c46cdb38d536f8107ede5d240acc4178b5ec':'ad4160f6bdd4d57c141eee5cf5b6483e89826d645be46fcc6b3dd41d64fed6f4','210 independent exact versioned identity roster');
 if(v7){
  const scalar=e.additions.find(r=>r.kind==='column'&&r.key==='public.order_split210_projection_basis.payload_schema');
  const{default:expression,...descriptor}=scalar.value;
  assert(typeof expression==='string'&&expression.length>0,'210 v7 full source-compiled generated expression required');
  assert.deepEqual(descriptor,{position:6,type:'text',not_null:false,generated:'s',identity:'',storage:'x',compression:'',statistics:null,options:null,foreign_options:null,collation:'"default"',acl_null:true,acl:[]},'210 v7 exact appended nullable schema scalar descriptor');
 }
 const seen=new Set(),additionIds=new Set(e.additions.map(id));
 for(const c of e.changes){exact(c,['kind','key','before','after']);assert.equal(c.kind,'function');assert(keys.includes(c.key)&&!seen.has(c.key),'210 fixed versioned function identities');seen.add(c.key);assert(!additionIds.has(id(c)),'210 additions and changes disjoint');
  row({kind:c.kind,key:c.key,value:c.before});row({kind:c.kind,key:c.key,value:c.after});
  const {source:bs,definition:bd,...bh}=c.before,{source:as,definition:ad,...ah}=c.after;
  assert(typeof bs==='string'&&typeof as==='string'&&typeof bd==='string'&&typeof ad==='string'&&bs!==as&&bd!==ad,'210 full before/after source and definitions');
  assert.equal(Object.keys(c.before).length,24,'210 complete function descriptor');assert(equal(bh,ah),'210 literal unchanged function headers and ACL');
 }
 assert(Array.isArray(e.inactive_ancestors)&&e.inactive_ancestors.length===1,'210 one independently source-authenticated inactive ancestor');
 const ancestor=e.inactive_ancestors[0];row(ancestor);assert.equal(ancestor.kind,'function');assert.equal(ancestor.key,'public.buyer_address_guards()');
 assert.equal(canonicalDigest(ancestor.value),'49c63177a92fe4bff983abf62bd0326a4d9cb47e56ba75c1fac2a6d0df893ed3','210 exact accepted208 buyer ancestor');
 const buyer=e.changes.find(c=>c.key===ancestor.key);assert(buyer);assert.equal(canonicalDigest(buyer.before),'a7fcbb15ba9b5bae29886c346db8ce8e3407acf46413185b996f87b6268e28a5','210 exact accepted209 buyer BEFORE');
 if(['source210-order-split-exact-inverse/v3','source210-order-split-exact-inverse/v4','source210-order-split-exact-inverse/v5','source210-order-split-exact-inverse/v6'].includes(e.schema)||v7){
  const financial=e.changes.find(c=>c.key==='public.financial_return_upgrade_valid()');
  assert.equal(canonicalDigest(financial.before),'7f3cfbe609e30b603c93f220273c54a2f1f9637b81fcea4540cef2372e51c199','210 exact source204/208/209 financial BEFORE');
 }
 if(['source210-order-split-exact-inverse/v4','source210-order-split-exact-inverse/v5','source210-order-split-exact-inverse/v6'].includes(e.schema)||v7){
  const beforePins=[
   '1c5d4a9984888bda480259f4398dabe24fafcef06a20bbefddafa0544f98a0c3',
   'd6b4357ef19c898bae5b298bb7677c3be0722a0c62eedcaca9e2b23a386ba4a9',
   '53bbd21fed89d2e45d439e58fff05cf5f721be878a2128ca6af25503f28b2871',
   '85a2ac0dc5c7a46ae2db18505b4961bfc163a122dd91240490d3542967942477',
  ];
  for(let i=0;i<beforePins.length;i++)assert.equal(canonicalDigest(e.changes[16+i].before),beforePins[i],'210 exact complete source209/204 successor BEFORE');
 }
 if(['source210-order-split-exact-inverse/v5','source210-order-split-exact-inverse/v6'].includes(e.schema)||v7){
  const credit=e.changes[20];
  assert.equal(credit.key,'public.ordinary181_credit_calculate(projection_ok boolean)');
  assert.equal(canonicalDigest(credit.before),'ee435112e587dc13f430bd6d46f819e21e5a92f33b7a9e59d664b91bd116fef1','210 exact complete source189 credit BEFORE');
 }
 if(e.schema==='source210-order-split-exact-inverse/v6'||v7){
  assert.equal(e.changes[21].key,'public.ordinary180_projection_valid(b jsonb)');
  assert.equal(canonicalDigest(e.changes[21].before),'8d586129ef7525342d0a6d2fd208a64b0d024e2634aeeb5613e997f4f8d57b71','210 exact complete source180 projection BEFORE');
 }
 return e;
}
const own=s=>typeof s==='string'&&/^(?:public\.)?_?order_split210_/.test(s);
function related(r,additionIds){
 if(additionIds.has(id(r))||own(r.key))return true;
 if(['trigger','constraint'].includes(r.kind)&&r.key.includes('order_split210_'))return true;
 if(r.kind==='trigger')return own(r.value.function)||own(r.value.constraint)||own(r.value.constraint_relation);
 if(r.kind==='index')return own(r.value.table);
 if(r.kind==='column')return own(r.value.type);
 if(r.kind==='type')return ['relation','element','array','base'].some(k=>own(r.value[k]));
 return false;
}
function canonicalDigest(value){
 const hash=createHash('sha256');const visit=v=>{
  if(Array.isArray(v)){hash.update('[');v.forEach((x,i)=>{if(i)hash.update(',');visit(x);});hash.update(']');return;}
  if(v!==null&&typeof v==='object'){const keys=Object.keys(Object.fromEntries(Object.keys(v).sort().map(k=>[k,null])));hash.update('{');keys.forEach((k,i)=>{if(i)hash.update(',');hash.update(JSON.stringify(k)+':');visit(v[k]);});hash.update('}');return;}
  hash.update(JSON.stringify(v));
 };visit(value);return hash.digest('hex');
}

/** Active inverse requires ALL494 whole additions in v7 (493 in v2–v6) and every whole
 * current AFTER descriptor in the explicit profile: v2=15, v3=16, v4=20, v5=21. The16th
 * financial BEFORE is the same complete source204/208/209 descriptor; it does
 * not add an inactive ancestor. V4 independently pins the four complete
 * predecessor descriptors; the three own209 helpers may be absent in208,
 * while ordinary181 financial must have its exact full BEFORE descriptor.
 * Absent210 permits the earlier208 representation:
 * four business BEFORE records, one fixed208 buyer ancestor and no ten209
 * slots; otherwise exact209 BEFORE records. No ancestor is ever substituted.
 * Optional209 helper groups must remain complete. Outer209/full-parent comparison remains mandatory; no TX authority. */
export function projectOrderSplit210Catalogue(value,expected){
 const input=validateRecoverySchema(value),e=expectation(expected),additionIds=new Set(e.additions.map(id));
 const selected=input.records.filter(r=>related(r,additionIds)),byId=new Map(input.records.map(r=>[id(r),r]));
 const active=selected.length>0||e.changes.some(c=>byId.has(id(c))&&equal(byId.get(id(c)).value,c.after));
 const groups=new Map();for(const c of e.changes){const name=c.key.slice(0,c.key.indexOf('('));if(!groups.has(name))groups.set(name,[]);groups.get(name).push(c.key);}
 for(const [name,keys]of groups){const actual=input.records.filter(r=>r.kind==='function'&&r.key.slice(0,r.key.indexOf('('))===name).map(r=>r.key).sort();if(!active&&!actual.length&&name.startsWith('public.order_merge_delivery209_'))continue;assert.deepEqual(actual,keys.slice().sort(),'210 missing/overloaded changed function');}
 const removedCounts=Object.fromEntries(Object.values(counts).map(k=>[k,0]));
 if(!active){const earlier208=!input.records.some(r=>r.kind==='function'&&r.key.startsWith('public.order_merge_delivery209_'));for(const c of e.changes){const actual=byId.get(id(c));if(!actual&&c.key.startsWith('public.order_merge_delivery209_'))continue;const ancestor=earlier208&&e.inactive_ancestors.find(r=>id(r)===id(c));assert(actual&&(equal(actual.value,c.before)||(ancestor&&equal(actual.value,ancestor.value))),'210 absent requires exact source BEFORE or closed208 buyer ancestor for every present changed function');}return Object.freeze({catalogue:input,mode:'absent210_identity',active:false,removed_records:0,changed_records:0,removed_counts:Object.freeze(removedCounts),authority:false});}
 assert(equal(selected,e.additions),'210 complete current addition roster and full descriptors');
 for(const c of e.changes)assert(byId.has(id(c))&&equal(byId.get(id(c)).value,c.after),'210 complete current AFTER descriptor');
 const changes=new Map(e.changes.map(c=>[id(c),c]));
 const records=[];for(const r of input.records){if(additionIds.has(id(r))){removedCounts[counts[r.kind]]++;continue;}const c=changes.get(id(r));records.push(c?Object.freeze({kind:r.kind,key:r.key,value:c.before}):r);}
 assert.equal(input.records.length-records.length,e.additions.length,'210 exact versioned record removal accounting');
 const finalCounts={...input.counts};for(const [key,n]of Object.entries(removedCounts)){assert(finalCounts[key]>=n,'210 bounded kind count subtraction');finalCounts[key]-=n;}
 const body={schema:input.schema,postgres_major:input.postgres_major,scope:input.scope,sql_sha256:input.sql_sha256,counts:finalCounts,records};
 const catalogue=validateRecoverySchema({...body,sha256:canonicalDigest(body)});
 return Object.freeze({catalogue,mode:'active210_inverse',active:true,removed_records:e.additions.length,changed_records:e.changes.length,removed_counts:Object.freeze(removedCounts),authority:false});
}
