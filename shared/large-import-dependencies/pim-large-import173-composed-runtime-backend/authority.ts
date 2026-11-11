/** Export-only original HTTP request custody. No default pool, app, owner reset or PIM lifecycle call. */
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {capturePimAuthority} from '../../../server/pim-dictionaries/service';
import type {Actor} from '../../../server/domain';
import type {Client} from './storage';
type BaseRequest=Parameters<typeof capturePimAuthority>[0];
export type Request=BaseRequest&{currentUser?:BaseRequest['currentUser']&{role?:string;api_key_id?:string};apiScopes?:string[]};
type Fact={userId:string;tenantId:string;apiKeyId:string|null;role:Actor['role'];digest:string;original:Request};
const captures=new WeakMap<Actor,Fact>(),connections=new WeakMap<Client,Actor>();
/** Call only from the installed, normally authenticated original HTTP handler. Pure test requests do not prove native authentication. */
export function captureLargeImportAuthority(request:Request,sessionName:string):Actor{
 assert.equal(request.currentUser?.role,request.actor.role,'metadata-authenticated-role');
 if(request.actor.apiKeyId){assert.equal(request.currentUser?.api_key_id,request.actor.apiKeyId,'metadata-authenticated-key');assert(Array.isArray(request.apiScopes)&&request.apiScopes.includes('products:read'),'metadata-authenticated-read-scope');}
 const actor=capturePimAuthority(request,sessionName);
 const raw=actor.apiKeyId?request.headers.authorization?.replace(/^Bearer /,''):(request.cookies[sessionName]??request.headers.authorization?.replace(/^Bearer /,''));assert(raw);
 captures.set(actor,Object.freeze({userId:actor.userId,tenantId:actor.tenantId,apiKeyId:actor.apiKeyId??null,role:actor.role,digest:createHash('sha256').update(raw).digest('hex'),original:request}));return actor;
}
/** ABI consumed by the dedicated transport; digest belongs to private captured request custody, never DB readback or Actor JSON. */
type AdmissionObservation={original:Request;tenantId:string;userId:string;apiKeyId:string|null;role:Actor['role'];writing:boolean};
const admissionObservations=new AsyncLocalStorage<AdmissionObservation[]>();
export async function observeNativeAdmissions<T>(work:()=>Promise<T>){const results:AdmissionObservation[]=[];let value:T|undefined,failed=false,error:unknown;try{value=await admissionObservations.run(results,work);}catch(e){failed=true;error=e;}return{value,failed,error,results:[...results]};}
export async function admitLargeImport173(c:Client,input:{actor:Actor;credential_hash:string;writing:boolean}):Promise<void>{
 const fact=captures.get(input.actor);assert(fact,'metadata-original-request-required');assert.equal(input.credential_hash,fact.digest,'metadata-private-credential-mismatch');assert.equal(typeof input.writing,'boolean');
 const prior=connections.get(c);assert(!prior||prior===input.actor,'metadata-client-original-actor');connections.set(c,input.actor);
 const values=[fact.userId,fact.tenantId,fact.apiKeyId,fact.role,fact.digest,input.writing];
 await c.query('SELECT public.large_import173_admit($1,$2,$3,$4,$5,$6)',values);admissionObservations.getStore()?.push({original:fact.original,tenantId:fact.tenantId,userId:fact.userId,apiKeyId:fact.apiKeyId,role:fact.role,writing:input.writing});
 // Native function does not return credential or private auth-table data.
}
