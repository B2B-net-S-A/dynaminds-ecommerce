/** Concrete same-client SQL/FS part group. Root supplies only genuine private transport/Actor binding. */
import assert from 'node:assert/strict';
import {requireActiveSharedWriterActor} from '../../../server/large-import/shared-session-writer';
import {transaction,type Client} from '../pim-large-import173-runtime-hooks-backend/storage';
import {digest} from './publisher';
import type {createQuotaRawStore,PartPermit} from './store';
import type {Prepared} from './publisher';
import type {Observed} from '../pim-large-import-write-hook-registry-backend/group';
export type NativePartCommit=Readonly<{kind:'native-part-committed-readback/v1'}>;
type PartCommitFacts={part:PartPermit;prepared:Prepared;actor:object;client:Client;raw:Observed;resource:Observed;row:{tenant_id:string;blob_id:string;offset_bytes:string;byte_count:number;sha256:string}};
const nativePartCommits=new WeakMap<object,PartCommitFacts>();
/** Lookup only: the mint is private to append AFTER its actual readback transaction COMMIT. */
export function inspectNativePartCommit(token:NativePartCommit){const held=nativePartCommits.get(token);assert(held,'part-authentic-committed-readback');return{...held,raw:structuredClone(held.raw),resource:structuredClone(held.resource),row:structuredClone(held.row)};}
export type PartDriverPorts<A>={
 /** SAME dedicated app-role client for this privately captured original Actor, no pool borrow after locks. */
 client(a:A):Client;
 /** Same native current-admit FOR SHARE, retained through each BEGIN/COMMIT. No discarded autocommit substitute. */
 admit(c:Client,a:A):Promise<void>;
 cleanupFailure(error:unknown):void;
};
export function createPreparedPartDriver<A>(store:ReturnType<typeof createQuotaRawStore<A>>,ports:PartDriverPorts<A>){
 const client=ports.client,admit=ports.admit,cleanup=ports.cleanupFailure;
 const tx=<T>(c:Client,a:A,work:()=>Promise<T>)=>transaction(c,async()=>{requireActiveSharedWriterActor(a as object);await admit(c,a);requireActiveSharedWriterActor(a as object);const value=await work();requireActiveSharedWriterActor(a as object);await admit(c,a);return value;},cleanup);
 return{
  async append(a:A,handle:string,input:Uint8Array,offset:number){const bytes=new Uint8Array(input);const c=client(a);const p:PartPermit=await store.preparePart(a,handle,bytes,offset);const meta=JSON.parse(p.metadata.payload_text!);let failed=false,first:unknown,value:{sha256:string;byte_count:number}|undefined;
   try{
    assert(p.scope.tenantId===meta.tenant_id,'part-exact-owned-plan');
    if(!p.replay)await store.writePreparedPart(p,c);
    const committed=await tx(c,a,async()=>{
     const fs=await store.inspectPreparedPart(p),r=(await c.query('SELECT p.tenant_id,p.blob_id,p.offset_bytes::text offset_bytes,p.byte_count,p.sha256 FROM public.large_import_parts173 p JOIN public.large_import_blobs173 b ON (b.tenant_id,b.id)=(p.tenant_id,p.blob_id) WHERE p.tenant_id=$1 AND p.blob_id=$2 AND p.offset_bytes=$3 AND b.actor_id=$4 AND b.api_key_id IS NOT DISTINCT FROM $5',[meta.tenant_id,meta.blob_id,offset,p.scope.actorId,p.scope.apiKeyId])).rows[0];
     assert(r&&r.tenant_id===meta.tenant_id&&r.blob_id===meta.blob_id&&r.offset_bytes===String(offset)&&r.byte_count===bytes.length&&r.sha256===digest(bytes)&&fs.sha256===r.sha256&&fs.byte_count===r.byte_count,'part-complete-actual-pg-fs-readback');const text=JSON.stringify(r);value={sha256:r.sha256,byte_count:r.byte_count};return{prepared:fs.prepared,raw:fs.raw,row:structuredClone(r) as PartCommitFacts['row'],resource:{...p.metadata,state:'settled' as const,witness:{id:`native-row/v1:${meta.tenant_id}:parts:${meta.blob_id}:${offset}`,sha256:digest(text),byte_count:Buffer.byteLength(text)}}};
    });
    // Native quota calls occur only AFTER BOTH SQL transactions closed successfully.
    assert(a&&typeof a==='object','part-original-actor-object');const commit=Object.freeze({kind:'native-part-committed-readback/v1' as const});nativePartCommits.set(commit,{part:p,prepared:committed.prepared,actor:a as object,client:c,raw:structuredClone(committed.raw),row:structuredClone(committed.row),resource:structuredClone(committed.resource)});
    await store.completePreparedPart(p,commit);
   }catch(e){failed=true;first=e;try{await store.failPreparedPart(p);}catch(err){try{cleanup(err);}catch{}}}
   finally{try{await store.releasePreparedPart(p);}catch(e){try{cleanup(e);}catch{}if(!failed){failed=true;first=e;}}}
   if(failed)throw first;return value!;
  },
 };
}
