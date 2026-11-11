/** Export-only standalone173 transport wrapper. No default pool, native HTTP, fixture actor or optimistic grant. */
import assert from 'node:assert/strict';import {AsyncLocalStorage} from 'node:async_hooks';import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';import type {Actor} from '../../../server/domain';
import {createDedicatedMetadataTransport,type Ports as TransportPorts} from '../pim-large-import173-composed-runtime-backend/transport';
import {transaction} from '../pim-large-import173-runtime-fs-integration-backend2/storage';
import type {Eligibility} from '../pim-large-import-job-coordinator-backend5/core-review';import type {Ref} from '../pim-large-import-job-coordinator-backend5/coordinator';
import type {BatchInput,Facts} from './native-reader';
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>hash(JSON.stringify(canonical(v)));
export type Evidence={save(label:'core-source-eligibility'|'core-current-quota',bytes:Uint8Array):Promise<Ref>};
export type Backend={/** Exact export wired by intended catalog-file-import.ts; not an unreviewed optimistic implementation. */inspectCoreBatchEligibilityInTx(c:PoolClient,actor:Actor,input:BatchInput):Promise<Facts>};
const eligibilityObservations=new AsyncLocalStorage<{actor:Actor;result:Eligibility}[]>();
export async function observeNativeEligibility<T>(work:()=>Promise<T>){const results:{actor:Actor;result:Eligibility}[]=[];let value:T|undefined,failed=false,error:unknown;try{value=await eligibilityObservations.run(results,work);}catch(e){failed=true;error=e;}return{value,failed,error,results:[...results]};}
export function createCoreEligibilityProducer(transportPorts:TransportPorts,backend:Backend,evidence:Evidence){
 const transport=createDedicatedMetadataTransport(transportPorts);
 return{capture:transport.capture,bind(actor:Actor){const {scope,ports}=transport.bind(actor);
  return async(a:Actor,input:BatchInput):Promise<Eligibility>=>{assert.equal(a,actor,'eligibility-original-captured-actor');input=structuredClone(input);let c:Awaited<ReturnType<typeof ports.connect>>|undefined,failed=false,first:unknown,snapshot:Facts|undefined;
   try{c=await ports.connect(scope);snapshot=await transaction(c,async()=>{await ports.admit(c!,scope);const facts=structuredClone(await backend.inspectCoreBatchEligibilityInTx(c as unknown as PoolClient,actor,input));
    assert(facts.schema==='catalog-core-eligibility-facts/v1'&&facts.index===input.index&&facts.preview_id===input.preview.ack.head.id&&facts.scope_hash===input.preview.ack.head.scope_hash,'eligibility-native-facts-binding');assert.deepEqual(facts.principal,{...scope,role:'admin'});assert.equal(facts.quota.reserved,false);
    await ports.admit(c!,scope);return facts;
   },ports.cleanupFailure);}catch(error){failed=true;first=error;}finally{if(c)try{await c.end();}catch(error){try{ports.cleanupFailure(error);}catch{}if(!failed){failed=true;first=error;}}}if(failed)throw first;/* Preserve exact detached facts; end the worker and owned client before preparing/publishing its two witnesses. */const facts=snapshot!;
    const save=async(label:'core-source-eligibility'|'core-current-quota',value:unknown)=>{const bytes=new Uint8Array(Buffer.from(JSON.stringify(value))),sha=hash(bytes),size=bytes.length;assert(size<=33554432,'eligibility-witness-bytes');const ref=structuredClone(await evidence.save(label,new Uint8Array(bytes)));assert(typeof ref.id==='string'&&ref.id.length>0&&ref.sha256===sha&&ref.byte_count===size,'eligibility-actual-saved-witness');return ref;};
    const source=await save('core-source-eligibility',facts),quota=await save('core-current-quota',{schema:'core-quota-observation/v1',preview_id:facts.preview_id,...facts.quota});
    const result:Eligibility={eligible:true,authority_revision:'current-admit173/81cfb07ca5fdc5f51a4f1d237080d30672b6902f71cad25c859fcc935f0a1f3a:'+digest(facts.principal),source_hash:digest({schema:'core-fresh-source/v1',request_hash:facts.request_hash,scope_hash:facts.scope_hash,...facts.source}),sources:[source],quota_witness:quota};
    eligibilityObservations.getStore()?.push({actor,result:structuredClone(result)});return result;
  };
 }};
}
