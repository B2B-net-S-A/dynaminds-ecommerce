/** Held source-only native resource groups. No default DB/app/FS or public readiness. */
import assert from 'node:assert/strict';import {requireActiveSharedOriginalRequest,participateSharedOriginalFactory} from '../../../server/large-import/shared-session-writer';import {createHash} from 'node:crypto';
import {createDedicatedMetadataTransport,type Ports} from '../../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import {quotaTransaction} from '../../../shared/large-import-dependencies/pim-large-import-upload-quota-broker-backend3/transaction';
import type {Actor} from '../../../server/domain';
import type {Client} from '../../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/storage';
import type {Resource,Observed,OwnedRequest} from '../../../shared/large-import-dependencies/pim-large-import173-upload-once-replay-backend/broker';
type Request=Parameters<ReturnType<typeof createDedicatedMetadataTransport>['capture']>[0];
export type CommittedGroup=Readonly<{kind:'committed-native-resource-group/v1';size:number}>;
const clone=<T>(v:T):T=>structuredClone(v),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const hex=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const exact=(a:Resource,b:Resource)=>a.key===b.key&&a.kind===b.kind&&a.byte_count===b.byte_count&&a.sha256===b.sha256&&a.payload_text===b.payload_text;
function validate(r:Resource){assert(r&&Object.keys(r).every(k=>['key','kind','byte_count','sha256','payload_text','state','witness'].includes(k)),'group-resource-fields');assert(/^(raw|blob|batch|job|review|event):[a-z0-9:-]{1,160}$/.test(r.key)&&r.key.split(':')[0]===r.kind&&count(r.byte_count)&&hex(r.sha256),'group-resource-shape');if(r.kind==='raw')assert(r.payload_text===undefined,'group-raw-text');else assert(typeof r.payload_text==='string'&&Buffer.byteLength(r.payload_text)===r.byte_count&&sha(r.payload_text)===r.sha256,'group-original-utf8-payload');}
function detach(items:readonly Resource[]){assert(Array.isArray(items)&&items.length>0&&items.length<=64,'group-bound');const out=clone(items) as Resource[],keys=new Set<string>();for(const r of out){validate(r);assert(!keys.has(r.key),'group-duplicate-key');keys.add(r.key);}out.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);assert(Buffer.byteLength(JSON.stringify(out))<=8388608,'group-byte-bound');return out;}
const wire=(r:Resource)=>({key:r.key,kind:r.kind,byte_count:r.byte_count,sha256:r.sha256,payload_text:r.payload_text??null});
/** Trusted registered publisher must use complete actual readbacks; native rows are not a FS witness. */
export function createNativeResourceGroupBroker(input:Ports){
 const ports={...input},transport=createDedicatedMetadataTransport(ports),facts=new WeakMap<Actor,string>(),originals=new WeakMap<Actor,Request>();
 return{
  capture(original:Request){const actor=transport.capture(original),raw=actor.apiKeyId?original.headers.authorization?.replace(/^Bearer /,''):(original.cookies[ports.sessionName]??original.headers.authorization?.replace(/^Bearer /,''));assert(raw);facts.set(actor,sha(raw));originals.set(actor,original);return actor;},
  bind(actor:Actor,owned:OwnedRequest){
   owned=clone(owned);const digest=facts.get(actor);assert(digest,'group-original-captured-actor');assert(uuid(owned.requestId)&&uuid(owned.reservationId)&&hex(owned.privateToken)&&['upload','job','review'].includes(owned.kind),'group-original-owned-identity');assert(count(owned.ceiling.raw)&&count(owned.ceiling.metadata)&&count(owned.ceiling.objects)&&owned.ceiling.objects>0,'group-original-ceiling');
   const {scope,ports:metadata}=transport.bind(actor),auth=[actor.userId,actor.tenantId,actor.apiKeyId??null,actor.role,digest],token=sha(owned.privateToken),permits=new WeakMap<CommittedGroup,{resources:Resource[];states:string[];settling:boolean;settled:boolean;rows:any[]}>();
   const report=(e:unknown)=>{try{metadata.cleanupFailure(e);}catch{}};
   const invoke=async(name:'intent_many'|'settle_many',items:unknown[])=>{const original=originals.get(actor);assert(original,'shared-group-original-request');requireActiveSharedOriginalRequest(original);let c:Client|undefined,failed=false,first:unknown,result:any;
    try{c=await metadata.connect(scope);result=await quotaTransaction(c,async()=>{
     await metadata.admit(c!,scope);const row=(await c!.query(`SELECT public.large_import_quota_${name}173($1,$2,$3,$4,$5,$6,$7,$8::jsonb) fact`,[...auth,owned.reservationId,token,JSON.stringify(items)])).rows[0];assert(Array.isArray(row?.fact),'group-native-complete-return');await metadata.admit(c!,scope);return clone(row.fact);
    },report);}catch(e){failed=true;first=e;}finally{if(c)try{await c.end();}catch(e){report(e);if(!failed){failed=true;first=e;}}}if(failed)throw first;return result as any[];
   };
   const check=(rows:any[],resources:Resource[],settlement?:Observed[])=>{assert.equal(rows.length,resources.length,'group-native-return-count');for(let i=0;i<resources.length;i++){const x=rows[i],r=resources[i];assert(x?.tenant_id===scope.tenantId&&x.reservation_id===owned.reservationId&&x.resource_key===r.key&&x.kind===r.kind&&String(x.byte_count)===String(r.byte_count)&&x.sha256===r.sha256&&x.payload_text===(r.payload_text??null),'group-native-exact-original-binding');assert(settlement?x.state===settlement[i].state:['intent','settled','quarantined'].includes(x.state),'group-native-state');}};
   return participateSharedOriginalFactory(originals.get(actor)!,{
    /** Returns only after the actual group COMMIT and concrete client close. No FS callback here. */
    async intentMany(items:readonly Resource[]):Promise<CommittedGroup>{const resources=detach(items),rows=await invoke('intent_many',resources.map(wire));check(rows,resources);const p=Object.freeze({kind:'committed-native-resource-group/v1' as const,size:resources.length});permits.set(p,{resources,states:rows.map(r=>r.state),settling:false,settled:false,rows:clone(rows)});return p;},
    intentFacts(p:CommittedGroup){const held=permits.get(p);assert(held,'group-private-committed-receipt');return clone(held.rows);},
    /** Freshly copied facts only; caller cannot mint/transplant a group or mutate its plan. */
    resources(p:CommittedGroup){const held=permits.get(p);assert(held,'group-private-committed-receipt');return held.resources.map((r,i)=>({...clone(r),native_state:held.states[i]}));},
    async settleMany(p:CommittedGroup,observed:readonly Observed[]){const held=permits.get(p);assert(held&&!held.settling&&!held.settled,'group-private-unsettled-receipt');const actual=detach(observed) as Observed[];assert.equal(actual.length,held.resources.length,'group-partial-readback');for(let i=0;i<actual.length;i++){const x=actual[i];assert(exact(x,held.resources[i])&&['settled','quarantined'].includes(x.state)&&x.witness&&typeof x.witness.id==='string'&&x.witness.id.length>0&&x.witness.id.length<=1024&&hex(x.witness.sha256)&&count(x.witness.byte_count),'group-complete-actual-readback');assert(held.states[i]!=='quarantined'||x.state==='quarantined','group-quarantine-replay');}
     held.settling=true;try{const rows=await invoke('settle_many',actual.map(r=>({...wire(r),state:r.state})));check(rows,held.resources,actual);held.settled=true;return clone(rows);}finally{held.settling=false;}
    },
   },['intentMany','settleMany']);
  },
 };
}

/** Trusted assembly adapter; no alternate Actor/native proof or generic FS callback. */
export function attachNativeResourceGroups<T extends {unknown():Promise<void>;snapshot():Promise<any>}>(native:T,group:ReturnType<ReturnType<typeof createNativeResourceGroupBroker>['bind']>){
 const pending=new Map<string,{phase:'reserving'|'committed'|'settling'|'failed';permit?:CommittedGroup}>();const groupKey=(r:readonly Resource[])=>detach(r).map(x=>x.key).join('\n');
 return {...native,
  async intentMany(items:readonly Resource[]){const plan=detach(items),key=groupKey(plan);assert(!pending.has(key),'group-unfinished-plan');const slot:{phase:'reserving'|'committed'|'settling'|'failed';permit?:CommittedGroup}={phase:'reserving'};pending.set(key,slot);try{const permit=await group.intentMany(plan);slot.permit=permit;const facts=group.intentFacts(permit);slot.phase='committed';return facts;}catch(e){slot.phase='failed';throw e;}},
  async settleMany(items:readonly Observed[]){const actual=detach(items) as Observed[],key=groupKey(actual),slot=pending.get(key);assert(slot?.phase==='committed'&&slot.permit,'group-original-plan-required');slot.phase='settling';try{const result=await group.settleMany(slot.permit,actual);pending.delete(key);return result;}catch(e){slot.phase='failed';throw e;}},
 };
}
