/** Concrete same-client SQL/FS part group. Root supplies only genuine private transport/Actor binding. */
import assert from 'node:assert/strict';
import {transaction,type Client} from '../pim-large-import173-runtime-hooks-backend/storage';
import {digest} from './publisher';
import {createQuotaRawStore,type PartPermit} from './store';
import type {Observed} from '../pim-large-import-write-hook-registry-backend/group';
export type PartDriverPorts<A>={
 /** SAME dedicated app-role client for this privately captured original Actor, no pool borrow after locks. */
 client(a:A):Client;
 /** Same native current-admit FOR SHARE, retained through each BEGIN/COMMIT. No discarded autocommit substitute. */
 admit(c:Client,a:A):Promise<void>;
 cleanupFailure(error:unknown):void;
};
export function createPreparedPartDriver<A>(store:ReturnType<typeof createQuotaRawStore<A>>,ports:PartDriverPorts<A>){
 const client=ports.client,admit=ports.admit,cleanup=ports.cleanupFailure;
 const tx=<T>(c:Client,a:A,work:()=>Promise<T>)=>transaction(c,async()=>{await admit(c,a);const value=await work();await admit(c,a);return value;},cleanup);
 return{
  async append(a:A,handle:string,input:Uint8Array,offset:number){const bytes=new Uint8Array(input);const c=client(a);const p:PartPermit=await store.preparePart(a,handle,bytes,offset);const meta=JSON.parse(p.metadata.payload_text!);let failed=false,first:unknown,value:{sha256:string;byte_count:number}|undefined;
   try{
    assert(p.scope.tenantId===meta.tenant_id,'part-exact-owned-plan');
    if(!p.replay)await tx(c,a,async()=>{
     const role=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];assert(role?.role==='dyna_app'&&role.tenant===meta.tenant_id,'part-real-role-scope');
     // FORCE RLS is tenant-only. Explicit owner/key predicates retain the exact captured private principal.
     const b=(await c.query('SELECT storage_id,raw_sha256,max_bytes FROM public.large_import_blobs173 WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 AND api_key_id IS NOT DISTINCT FROM $4',[meta.tenant_id,meta.blob_id,p.scope.actorId,p.scope.apiKeyId])).rows[0];assert(b&&b.storage_id===handle&&b.raw_sha256===null&&offset+bytes.length<=Number(b.max_bytes),'part-native-active-owned-blob');
     await store.writePreparedPart(p);
     await c.query('INSERT INTO public.large_import_parts173(tenant_id,blob_id,offset_bytes,byte_count,sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,blob_id,offset_bytes) DO NOTHING',[meta.tenant_id,meta.blob_id,offset,bytes.length,digest(bytes)]);
    });
    const actual:Observed=await tx(c,a,async()=>{
     const fs=await store.inspectPreparedPart(p),r=(await c.query('SELECT p.tenant_id,p.blob_id,p.offset_bytes::text offset_bytes,p.byte_count,p.sha256 FROM public.large_import_parts173 p JOIN public.large_import_blobs173 b ON (b.tenant_id,b.id)=(p.tenant_id,p.blob_id) WHERE p.tenant_id=$1 AND p.blob_id=$2 AND p.offset_bytes=$3 AND b.actor_id=$4 AND b.api_key_id IS NOT DISTINCT FROM $5',[meta.tenant_id,meta.blob_id,offset,p.scope.actorId,p.scope.apiKeyId])).rows[0];
     assert(r&&r.tenant_id===meta.tenant_id&&r.blob_id===meta.blob_id&&r.offset_bytes===String(offset)&&r.byte_count===bytes.length&&r.sha256===digest(bytes)&&fs.sha256===r.sha256&&fs.byte_count===r.byte_count,'part-complete-actual-pg-fs-readback');const text=JSON.stringify(r);value={sha256:r.sha256,byte_count:r.byte_count};return{...p.metadata,state:'settled',witness:{id:`native-row/v1:${meta.tenant_id}:parts:${meta.blob_id}:${offset}`,sha256:digest(text),byte_count:Buffer.byteLength(text)}};
    });
    // Native quota calls occur only AFTER BOTH SQL transactions closed successfully.
    await store.completePreparedPart(p,actual);
   }catch(e){failed=true;first=e;try{await store.failPreparedPart(p);}catch(err){try{cleanup(err);}catch{}}}
   finally{try{await store.releasePreparedPart(p);}catch(e){try{cleanup(e);}catch{}if(!failed){failed=true;first=e;}}}
   if(failed)throw first;return value!;
  },
 };
}
