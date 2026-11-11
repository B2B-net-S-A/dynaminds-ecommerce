/** Single registered mutation after ALL independently committed quota intents. No connection or pool creation. */
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {OPERATIONS,type Operation} from './inventory';
import type {Resource,Observed} from '../pim-large-import-upload-quota-broker-backend3/broker';
export type {Resource,Observed};
export type QuotaGroupPort = {
 intent(resource:Resource):Promise<unknown>;
 settle(resource:Observed):Promise<unknown>;
 /** Optional source-owned native group adapter; every returned intent is still checked. */
 intentMany?(resources:Resource[]):Promise<unknown[]>;
 settleMany?(resources:Observed[]):Promise<unknown[]>;
 /** Retains the entire reservation/unknown allocation. Never releases capacity or deletes bytes. */
 unknown():Promise<void>;
};
export type GroupInput = {operation:Operation;group_key:string;resources:Resource[]};
export type Readback<T> = {complete:true;group_key:string;resources:Observed[];value:T};
export type GroupDriver<T> = {
 /** Real owned mutation, same client/lease/CAS for grouped SQL writes; no caller-supplied callback per invocation. */
 write():Promise<void>;
 /** Actual bytes/rows plus authoritative stored result, not an ACK. Pending/partial facts must refuse. */
 inspect():Promise<Readback<T>>;
 /** Genuine current authority at checkpoints; actual write independently enforces IAM. */
 admit():Promise<void>;
};
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
export function validateResource(x:Resource){
 assert(x&&/^(raw|blob|batch|job|review|event):[a-z0-9:-]{1,160}$/.test(x.key)&&x.key.split(':')[0]===x.kind,'hook-resource-key');
 assert(Number.isSafeInteger(x.byte_count)&&x.byte_count>=0&&/^[a-f0-9]{64}$/.test(x.sha256),'hook-resource-bytes');
 if(x.kind==='raw')assert(x.payload_text===undefined,'hook-raw-no-text');
 else assert(typeof x.payload_text==='string'&&Buffer.byteLength(x.payload_text)===x.byte_count&&sha(x.payload_text)===x.sha256,'hook-exact-metadata-text');
}
function resourcesEqual(a:Resource,b:Resource){return a.key===b.key&&a.kind===b.kind&&a.byte_count===b.byte_count&&a.sha256===b.sha256&&a.payload_text===b.payload_text;}
function validateReadback<T>(p:GroupInput,r:Readback<T>){
 assert(r&&r.complete===true&&r.group_key===p.group_key&&Array.isArray(r.resources)&&r.resources.length===p.resources.length,'hook-complete-group-readback');
 const keys=new Set<string>();
 for(const x of r.resources){validateResource(x);const expected=p.resources.find(y=>y.key===x.key);
  assert(expected&&resourcesEqual(expected,x)&&!keys.has(x.key)&&x.state==='settled','hook-retained-group-equality');keys.add(x.key);
  assert(x.witness&&typeof x.witness.id==='string'&&x.witness.id.length>0&&Number.isSafeInteger(x.witness.byte_count)&&x.witness.byte_count>=0&&/^[a-f0-9]{64}$/.test(x.witness.sha256),'hook-owned-readback-witness');
 }
}
/** Inputs are detached before any async boundary, including Buffer-valued callers through registry planners. */
export type ExecutedGroupFacts={operation:Operation;group_key:string;resources:Resource[];intent_states:('intent'|'settled'|'quarantined')[];readback:Readback<unknown>;performed:boolean;replayed:boolean;write_calls:number};
const executedGroups=new WeakMap<object,ExecutedGroupFacts>();
const groupObservations=new AsyncLocalStorage<object[]>();
/** Observe actual source executions, not a caller verdict. Nested windows cannot borrow one another's records. */
export async function observeExecutedWriteGroups<T>(work:()=>Promise<T>):Promise<{value:T|undefined;failed:boolean;error:unknown;results:object[]}>{const results:object[]=[];let value:T|undefined,failed=false,error:unknown;try{value=await groupObservations.run(results,work);}catch(e){failed=true;error=e;}return{value,failed,error,results:[...results]};}
/** Only the original returned in-process result can carry an observation. JSON or a cloned result cannot. */
export function inspectExecutedWriteGroup(result:object):ExecutedGroupFacts{const held=executedGroups.get(result);assert(held,'hook-authentic-executed-group');return structuredClone(held);}
export async function executeWriteGroup<T>(input:GroupInput,quota:QuotaGroupPort,driver:GroupDriver<T>){
 const p=structuredClone(input);const q={intent:quota.intent,settle:quota.settle,intentMany:quota.intentMany,settleMany:quota.settleMany,unknown:quota.unknown},d={write:driver.write,inspect:driver.inspect,admit:driver.admit};
 assert((q.intentMany===undefined)===(q.settleMany===undefined),'hook-native-group-adapter-pair');
 if(q.intentMany!==undefined)assert(typeof q.intentMany==='function'&&typeof q.settleMany==='function','hook-native-group-adapter-functions');
 assert(Object.hasOwn(OPERATIONS,p.operation)&&/^[a-z0-9:-]{1,160}$/.test(p.group_key)&&Array.isArray(p.resources)&&p.resources.length>0&&p.resources.length<=1000,'hook-group-shape');
 const keys=new Set<string>();for(const r of p.resources){validateResource(r);assert(!keys.has(r.key),'hook-duplicate-resource');keys.add(r.key);}
 const kinds=new Set(p.resources.map(r=>r.kind));for(const required of OPERATIONS[p.operation])assert(kinds.has(required),'hook-group-missing-required-resource');
 let failed=false,first:unknown,written=false,value:T|undefined,replayed=false,writeCalls=0;const intentStates:ExecutedGroupFacts['intent_states']=[];let observedReadback:Readback<unknown>|undefined;
 try{
  await d.admit();const states:string[]=[];
  const checkIntent=(r:Resource,raw:unknown)=>{assert(raw&&typeof raw==='object','hook-native-intent-fact');const fact=raw as Record<string,unknown>;
   assert(fact.resource_key===r.key&&fact.kind===r.kind&&String(fact.byte_count)===String(r.byte_count)&&fact.sha256===r.sha256&&fact.payload_text===(r.payload_text??null),'hook-native-intent-binding');
   assert(fact.state==='intent'||fact.state==='settled'||fact.state==='quarantined','hook-native-intent-state');states.push(fact.state);intentStates.push(fact.state);
  };
  if(q.intentMany){
   // Native173 bounds each atomic call at 64. ALL chunks commit before a
   // mutation; a late failed/mixed chunk retains the same reservation UNKNOWN.
   for(let offset=0;offset<p.resources.length;offset+=64){const chunk=p.resources.slice(offset,offset+64);const facts:unknown=await q.intentMany(structuredClone(chunk));assert(Array.isArray(facts)&&facts.length===chunk.length,'hook-native-intent-group-complete');const seen=new Set<string>();for(const fact of facts){assert(fact&&typeof fact==='object','hook-native-intent-fact');const key=(fact as Record<string,unknown>).resource_key;assert(typeof key==='string'&&!seen.has(key),'hook-native-intent-group-duplicate');const resource=chunk.find(r=>r.key===key);assert(resource,'hook-native-intent-group-unexpected');seen.add(key);checkIntent(resource,fact);}}
  }else{
   for(const r of p.resources)checkIntent(r,await q.intent(structuredClone(r)));
  }
  if(states.every(s=>s==='settled'))replayed=true;
  else {assert(states.every(s=>s==='intent'),'hook-mixed-or-quarantined-group-requires-recovery');await d.admit();writeCalls++;await d.write();written=true;}
  const actual=structuredClone(await d.inspect());validateReadback(p,actual);observedReadback=structuredClone(actual);
  await d.admit();
  if(q.settleMany){const byKey=new Map(actual.resources.map(r=>[r.key,r]));for(let offset=0;offset<p.resources.length;offset+=64){const chunk=p.resources.slice(offset,offset+64).map(r=>byKey.get(r.key)!);const facts:unknown=await q.settleMany(structuredClone(chunk));assert(Array.isArray(facts)&&facts.length===chunk.length,'hook-native-settle-group-complete');}}
  else for(const r of actual.resources)await q.settle(structuredClone(r));
  value=actual.value;
 }catch(e){failed=true;first=e;}
 if(failed){try{await q.unknown();}catch{}throw first;}
 const result={performed:written,replayed,value:value as T};
  assert(observedReadback,'hook-observed-readback');
  executedGroups.set(result,{operation:p.operation,group_key:p.group_key,resources:structuredClone(p.resources),intent_states:intentStates,readback:observedReadback,performed:written,replayed,write_calls:writeCalls});
  groupObservations.getStore()?.push(result);
  return result;
}
