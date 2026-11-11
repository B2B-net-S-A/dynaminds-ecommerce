/** Bounded comparison framing only. The caller must independently authenticate
 * the supplied immutable source-compiled expectation. No default E209, DB, FS,
 * observed adoption, Native certification or admission is provided here. */
import assert from 'node:assert/strict';
import {ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS as legacyKeys} from './order-merge-delivery209-inverse.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS as startupKeys} from './order-merge-delivery209-startup-roster.mjs';
import {assertOrderMergeDelivery209ConstraintChanges} from './order-merge-delivery209-constraints.mjs';
import {projectOrderMergeDelivery209StartupCatalogueRecords} from './order-merge-delivery209-metadata.mjs';

const LIMITS=Object.freeze({nodes:1000000,depth:64,records:100000,recordBytes:8388608,bytes:134217728});
const schema='source209-order-merge-delivery-exact-inverse/v1';
const helperKey='public.order_merge_delivery209_startup_operative_valid(entries jsonb)';
const fullKeys=Object.freeze(['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl']);
const identity=r=>r.kind+'\0'+r.key;
function exact(value,keys){assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),'exact comparison fields');}
function capture(value,depth=0,budget={nodes:0,bytes:0}){
 assert(++budget.nodes<=LIMITS.nodes&&depth<=LIMITS.depth,'comparison JSON bounds');
 const charge=n=>{budget.bytes+=n;assert(budget.bytes<=LIMITS.bytes,'comparison encoded JSON bound');};
 charge(2);
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){assert(Number.isFinite(value));charge(24);return value;}
 if(typeof value==='string'){
  assert(value.isWellFormed(),'UTF8 scalar text required');let n=Buffer.byteLength(value);assert(n<=LIMITS.recordBytes,'comparison scalar bound');
  // Count JSON escaping without creating an unbounded escaped temporary string.
  for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c===34||c===92)n++;else if(c<32)n+=[8,9,10,12,13].includes(c)?1:5;}
  charge(n);return value;
 }
 assert(value&&typeof value==='object','plain JSON required');const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
 assert(array?proto===Array.prototype:proto===Object.prototype||proto===null,'plain comparison JSON');
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);assert(keys.every(k=>typeof k==='string'),'no symbol keys');
 if(array){assert(value.length<=LIMITS.records);assert.equal(keys.length,value.length+1,'dense array without extras');}
 let out=Object.isFrozen(value)?null:array?[]:Object.create(proto);
 for(let i=0;i<keys.length;i++){
  const key=keys[i];if(array&&key==='length')continue;
  if(array)assert(/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length,'dense array index');
  const d=descriptors[key];assert(Object.hasOwn(d,'value')&&d.enumerable,'enumerable data properties only');
  if(!array){assert(key.isWellFormed()&&Buffer.byteLength(key)<=8192,'bounded UTF8 JSON key');charge(Buffer.byteLength(key)*6+3);}const child=capture(d.value,depth+1,budget);
  if(out===null&&child!==d.value){out=array?[]:Object.create(proto);for(let j=0;j<i;j++){const old=keys[j];if(array&&old==='length')continue;Object.defineProperty(out,old,{value:descriptors[old].value,enumerable:true,writable:true,configurable:true});}}
  if(out!==null)Object.defineProperty(out,key,{value:child,enumerable:true,writable:true,configurable:true});
 }
 return out===null?value:Object.freeze(out);
}
function functionChange(change){
 for(const value of [change.before,change.after]){
  exact(value,fullKeys);assert(typeof value.source==='string'&&value.source.length>0&&typeof value.definition==='string');
  assert.equal(value.definition.split(value.source).length,2,'one complete source in full definition');
 }
 const {source:bs,definition:bd,...before}=change.before,{source:as,definition:ad,...after}=change.after;
 assert.notEqual(bs,as,'real complete source change');assert.deepEqual(before,after,'complete header and ACL stay literal');
 assert.equal(ad,bd.replace(bs,()=>as),'only the complete function body changes');
}

/** Default14 is passed through unchanged in content. Source22 must be explicit:
 * metadata gets legacy14 plus its seven-root stage; the generic inverse gets
 * the ORIGINAL21 expectation and explicit runtimeRevision22. Neither is an
 * authentication of the expectation or permission to accept a live catalogue.
 */
export function frameOrderMergeDelivery209Comparison(input,options){
 const expected=capture(input);exact(expected,['schema','additions','changes','removed']);assert.equal(expected.schema,schema);
 let startup=false;if(options!==undefined){const o=capture(options);exact(o,['runtimeRevision']);assert.equal(o.runtimeRevision,22);startup=true;}
 assert.deepEqual(expected.removed,[]);assert(Array.isArray(expected.changes)&&expected.changes.length===(startup?21:14),'explicit fixed change framing');
 assert(Array.isArray(expected.additions)&&expected.additions.length>0);if(startup)assert.equal(expected.additions.length,259,'exact Source22b additions');
 const allowed=[...legacyKeys,...(startup?startupKeys:[])],seen=new Set(),functions=new Set(),checks=[],legacy=[],roots=[];
 for(const change of expected.changes){
  exact(change,['kind','key','before','after']);assert(typeof change.kind==='string'&&typeof change.key==='string'&&!change.key.includes('\0'));
  const id=identity(change);assert(!seen.has(id),'no duplicate changed identity');seen.add(id);
  if(change.kind==='function'){
   assert(allowed.includes(change.key),'fixed source function identity, no overload');functions.add(change.key);functionChange(change);
   (startupKeys.includes(change.key)?roots:legacy).push(change);
  }else{assert.equal(change.kind,'constraint');checks.push(change);legacy.push(change);}
  for(const value of [change.before,change.after])assert(Buffer.byteLength(JSON.stringify({kind:change.kind,key:change.key,value}))<=LIMITS.recordBytes,'per-record comparison bound');
 }
 assert.equal(functions.size,allowed.length);assertOrderMergeDelivery209ConstraintChanges(checks);assert.equal(legacy.length,14);
 const added=new Set();let previous='',helper;
 for(const record of expected.additions){
  exact(record,['kind','key','value']);assert(['relation','column','constraint','index','policy','trigger','function','type'].includes(record.kind));
  assert(typeof record.key==='string'&&record.key.length>0&&Buffer.byteLength(record.key)<=8192&&!record.key.includes('\0'));assert(record.value&&typeof record.value==='object'&&!Array.isArray(record.value));
  const id=identity(record);assert(id>previous&&!seen.has(id),'sorted unique disjoint additions');previous=id;assert(!added.has(id));added.add(id);
  assert(Buffer.byteLength(JSON.stringify(record))<=LIMITS.recordBytes,'per-record comparison bound');
  if(startup&&record.key.split('(')[0]===helperKey.split('(')[0]){assert.equal(record.kind,'function');assert.equal(record.key,helperKey,'no startup helper overload');assert(!helper);helper=record;}
 }
 let metadataOptions,inverseOptions,metadataExpected=expected;
 if(startup){
  assert.equal(roots.length,7);assert(helper,'exact source startup helper required');
  const byKey=new Map(roots.map(change=>[change.key,change]));
  const changes=startupKeys.map(key=>{const c=byKey.get(key);assert(c);return c;});
  const source22=Object.freeze({changes:Object.freeze(changes),additions:Object.freeze([helper])});
  // Reuse the existing source-stage validator: independent seven BEFORE pins,
  // complete24/header/body equations and exact f508 helper. These are expected
  // AFTER rows only, never an observed catalogue or a Native acceptance proof.
  projectOrderMergeDelivery209StartupCatalogueRecords([...changes.map(c=>({kind:c.kind,key:c.key,value:c.after})),helper],source22);
  metadataExpected=Object.freeze({...expected,changes:Object.freeze(legacy)});
  metadataOptions=Object.freeze({source22});inverseOptions=Object.freeze({runtimeRevision:22});
 }
 return Object.freeze({expected:metadataExpected,inverseExpected:expected,metadataOptions,inverseOptions,
  authority:false,native_acceptance:false,full_catalogue_checked:false,expected_provenance_authenticated:false});
}
