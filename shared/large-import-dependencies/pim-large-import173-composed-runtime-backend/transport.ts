/** Source-only integration proposal. No default pool/connection/app/worker/route/registry. */
import {createHash} from 'node:crypto';
import {requireActiveSharedMetadataScope,requireActiveSharedOriginalWriter} from '../../../server/large-import/shared-session-writer';
import {captureLargeImportAuthority as capturePimAuthority,admitLargeImport173} from './authority';
import type {Actor} from '../../../server/domain';
import type {Client,MetadataPorts} from './storage';
import type {Principal} from '../pim-large-import-job-coordinator-backend3/coordinator';
type Request=Parameters<typeof capturePimAuthority>[0];
type Fact={scope:Principal;credentialHash:string;original:Request;actor:Actor;role:Actor['role']};
type CaptureCustody={fact:Fact;connect:Ports['connectOwner'];preflight:Ports['preflightOwner173'];owner:string;session:string};
const capturedCustody=new WeakMap<Actor,CaptureCustody>();
// Private exact Original/transport index, not a principal tuple or caller Actor cache.
// Only the first real request capture mints this Actor; recapture retains its identity.
const originalCaptures=new WeakMap<Request,Array<{actor:Actor;custody:CaptureCustody}>>();
export type BoundMetadataPorts=MetadataPorts;
const originalBindings=new WeakMap<BoundMetadataPorts,Fact>();
const ownedOriginalConnections187=new WeakMap<Client,Fact>();
const originalCleanupBindings=new WeakMap<BoundMetadataPorts,{captureCurrent():Actor;connect():Promise<Client>}>();
/** Exact same genuine request and bound port object only. This assertion never adopts a client,
 * admits another Actor, connects, or substitutes scope equality for transport WeakMap custody. */
export function assertOriginalMetadataBinding(candidate:BoundMetadataPorts,original:Request,actor:Actor):void{
 const scope={tenantId:actor.tenantId,userId:actor.userId,apiKeyId:actor.apiKeyId??null};
 const fact=originalBindings.get(candidate);need(fact&&fact.actor===actor&&fact.role===actor.role&&fact.original===original&&same(scope,fact.scope),'metadata-original-bound-ports-required');
 const raw=scope.apiKeyId?original.headers.authorization?.replace(/^Bearer /,''):(original.cookies[factSessionNames.get(candidate)!]??original.headers.authorization?.replace(/^Bearer /,''));
 need(raw&&createHash('sha256').update(raw).digest('hex')===fact.credentialHash,'metadata-original-bound-credential-changed');
}
const factSessionNames=new WeakMap<BoundMetadataPorts,string>();
function need(v:unknown,message:string):asserts v{if(!v)throw Error(message);}
const clone=<T>(v:T):T=>structuredClone(v);
const same=(a:Principal,b:Principal)=>a.tenantId===b.tenantId&&a.userId===b.userId&&a.apiKeyId===b.apiKeyId;
export type Ports={
 /** Fresh dedicated owner connection. Not pooled/recycled; same c will hold the entire real session advisory lease. */
 connectOwner():Promise<Client>;
 expectedOwner:string;
 /** Private exact173 owner certificate/remnant/ledger check on this c before role/tenant locks. ABSENT means unavailable. */
 preflightOwner173(c:Client):Promise<'ABSENT'|'VALID'>;
 /** REQUIRED future certified173 app-role native entrypoint. Must check current real credential/account/membership/MFA/scopes and pin admission to each metadata checkpoint. Existing pim_dictionary_identity is not a substitute. */
 
 cleanupFailure(error:unknown):void;
 sessionName:string;
};
export function createDedicatedMetadataTransport(input:Ports){
 const ports={...input};
 need(ports.expectedOwner.length>0&&ports.expectedOwner!=='dyna_app','metadata-owner-config');
 const captures=new WeakMap<Actor,Fact>(),connections=new WeakMap<Client,Actor>(),used=new WeakSet<Client>();
 const report=(error:unknown)=>{try{ports.cleanupFailure(error);}catch{}};
 function capture(request:Request):Actor{
  // This exact import uses actual service WeakMap admission. Caller is the genuine already-authenticated original HTTP handler, never a deserialized Actor.
  const observed=capturePimAuthority(request,ports.sessionName);need(observed.role==='admin','metadata-admin-required');
  const raw=observed.apiKeyId?request.headers.authorization?.replace(/^Bearer /,''):(request.cookies[ports.sessionName]??request.headers.authorization?.replace(/^Bearer /,''));need(raw,'metadata-request-credential');
  const scope={tenantId:observed.tenantId,userId:observed.userId,apiKeyId:observed.apiKeyId??null},credentialHash=createHash('sha256').update(raw).digest('hex');
  const prior=originalCaptures.get(request)?.find(x=>x.custody.connect===ports.connectOwner&&x.custody.preflight===ports.preflightOwner173&&x.custody.owner===ports.expectedOwner&&x.custody.session===ports.sessionName);
  if(prior){
   const held=capturedCustody.get(prior.actor);need(held===prior.custody&&held.fact.actor===prior.actor&&held.fact.original===request,'metadata-original-capture-private-custody');
   need(held.fact.role===observed.role&&same(held.fact.scope,scope)&&held.fact.credentialHash===credentialHash,'metadata-original-recapture-current-credential');
   captures.set(prior.actor,held.fact);assertOriginalMetadataBinding(bind(prior.actor).ports,request,prior.actor);return prior.actor;
  }
  const actor=observed,fact:Fact={scope,credentialHash,original:request,actor,role:actor.role},custody:CaptureCustody={fact,connect:ports.connectOwner,preflight:ports.preflightOwner173,owner:ports.expectedOwner,session:ports.sessionName};
  captures.set(actor,fact);capturedCustody.set(actor,custody);let held=originalCaptures.get(request);if(!held){held=[];originalCaptures.set(request,held);}held.push({actor,custody});return actor;
 }
 function bind(actor:Actor):{scope:Principal;ports:MetadataPorts}{
  const shared=capturedCustody.get(actor);need(shared&&shared.connect===ports.connectOwner&&shared.preflight===ports.preflightOwner173&&shared.owner===ports.expectedOwner&&shared.session===ports.sessionName,'metadata-original-captured-actor-transport-required');const fact=captures.get(actor)??shared.fact;need(fact,'metadata-original-captured-actor-required');const scope=clone(fact.scope);
  const admission=async(c:Client,p:Principal)=>{need(connections.get(c)===actor&&same(p,fact.scope),'metadata-client-actor-binding');await admitLargeImport173(c,{actor,credential_hash:fact.credentialHash,writing:true});const state=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];need(state?.role==='dyna_app'&&state.tenant===fact.scope.tenantId,'metadata-session-role-tenant');};
  const metadata:MetadataPorts={
   connect:async p=>{
    need(same(p,fact.scope),'metadata-principal-binding');let c:Client|undefined,owned=false,failed=false,first:unknown;
    try{c=await ports.connectOwner();need(!used.has(c),'metadata-dedicated-connection-reused');owned=true;used.add(c);const initial=(await c.query('SELECT current_user role,session_user session_role')).rows[0];need(initial?.role===ports.expectedOwner&&initial.session_role===ports.expectedOwner,'metadata-real-owner-transport');await c.query('SET SESSION jit=off');need(await ports.preflightOwner173(c)==='VALID','metadata173-not-certified');
     await c.query('SET SESSION ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,false)",[fact.scope.tenantId]);await c.query("SET SESSION statement_timeout='8s'");connections.set(c,actor);await admission(c,p);ownedOriginalConnections187.set(c,fact);return c;
    }catch(error){failed=true;first=error;}finally{if(failed&&owned&&c){connections.delete(c);ownedOriginalConnections187.delete(c);try{await c.end();}catch(error){report(error);}}}throw first;
   },
   admit:admission,
   cleanupFailure:report,
  };originalBindings.set(metadata,fact);factSessionNames.set(metadata,ports.sessionName);Object.freeze(metadata);
  // Upload lock cleanup preserves the existing no-growth native cleanup ABI. It is
  // issued only by this same captured transport, never by adopting a supplied Client.
  const connectCleanup=async():Promise<Client>=>{
   const currentCleanup=()=>{requireActiveSharedMetadataScope(fact.scope,true);requireActiveSharedOriginalWriter(actor,fact.original);need(capture(fact.original)===actor,'metadata-cleanup-same-current-original-actor');assertOriginalMetadataBinding(metadata,fact.original,actor);};
   currentCleanup();let c:Client|undefined,owned=false,failed=false,first:unknown;
   try{c=await ports.connectOwner();need(!used.has(c),'metadata-dedicated-connection-reused');used.add(c);owned=true;const initial=(await c.query('SELECT current_user role,session_user session_role')).rows[0];need(initial?.role===ports.expectedOwner&&initial.session_role===ports.expectedOwner,'metadata-real-owner-transport');need(await ports.preflightOwner173(c)==='VALID','metadata173-not-certified');await c.query('SET SESSION ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,false)",[fact.scope.tenantId]);await c.query("SET SESSION statement_timeout='8s'");const role=(await c.query("SELECT current_user role,session_user session_role,current_setting('role',true) role_setting,current_setting('app.tenant_id',true) tenant")).rows[0];need(role?.role==='dyna_app'&&role.session_role===ports.expectedOwner&&role.role_setting==='dyna_app'&&role.tenant===fact.scope.tenantId,'metadata-cleanup-real-role-tenant');currentCleanup();connections.set(c,actor);ownedOriginalConnections187.set(c,fact);return c;
   }catch(e){failed=true;first=e;}finally{if(failed&&owned&&c){connections.delete(c);ownedOriginalConnections187.delete(c);try{await c.end();}catch(e){report(e);}}}throw first;
  };
  originalCleanupBindings.set(metadata,{captureCurrent:()=>capture(fact.original),connect:connectCleanup});return {scope,ports:metadata};
 }
 return {capture,bind,bindCleanup:(actor:Actor)=>{const bound=bind(actor);const held=originalCleanupBindings.get(bound.ports);need(held,'metadata-private-cleanup-binding-required');return held.connect;}};
}

/** Genuine provided original ports resolve the private Actor/credential and cleanup issuer.
 * Registered factories may wrap complete preflight; no wrapper may adopt a tuple or Client. */
export function bindOriginalPublicationMetadata(config:Ports,candidate:BoundMetadataPorts,original:Request,actor:Actor):Readonly<{actor:Actor;auth:readonly unknown[];cleanupConnect():Promise<Client>}>{
 assertOriginalMetadataBinding(candidate,original,actor);const fact=originalBindings.get(candidate)!,custody=capturedCustody.get(actor),held=originalCleanupBindings.get(candidate);
 need(custody&&custody.fact===fact&&custody.fact.original===original&&custody.connect===config.connectOwner&&custody.owner===config.expectedOwner&&custody.session===config.sessionName&&held,'publication-original-metadata-transport-custody');
 need(held.captureCurrent()===actor,'publication-same-genuine-original-actor');assertOriginalMetadataBinding(candidate,original,actor);
 return Object.freeze({actor,auth:Object.freeze([fact.scope.userId,fact.scope.tenantId,fact.scope.apiKeyId,fact.role,fact.credentialHash]),cleanupConnect:held.connect});
}

/** Native187 journal bridge: current original proof only, never caller credentials or cached IAM.
 * Called on the dedicated preallocated owner journal TX, outside worker/resource locks. */
export async function admitOriginalEpochJournal(c:Client,candidate:BoundMetadataPorts,original:Request,actor:Actor):Promise<void>{
 assertOriginalMetadataBinding(candidate,original,actor);const fact=originalBindings.get(candidate)!;
 const row=(await c.query("SELECT current_user role,session_user session_role,current_setting('role',true) role_setting")).rows[0];
 need(row?.role==='postgres'&&row.session_role==='postgres'&&row.role_setting==='none','epoch-journal-owned-role-none');
 await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[fact.scope.tenantId]);
 let failed=false,first:unknown;
 try{await admitLargeImport173(c,{actor,credential_hash:fact.credentialHash,writing:true});assertOriginalMetadataBinding(candidate,original,actor);}catch(e){failed=true;first=e;}
 try{await c.query('SET LOCAL ROLE NONE');}catch(e){if(!failed){failed=true;first=e;}}
 if(failed)throw first;
}

/** Lookup only: populated solely by actual fresh owner→native preflight→session role→original admission connect.
 * Different legitimate bound ports may share this original captured actor, but a raw Client/tuple cannot adopt it. */
export function assertOriginalMetadataClientBinding187(c:Client,candidate:BoundMetadataPorts,original:Request,actor:Actor):void{
 assertOriginalMetadataBinding(candidate,original,actor);const issued=ownedOriginalConnections187.get(c),expected=originalBindings.get(candidate)!;
 need(issued&&issued.actor===actor&&issued.original===original&&issued.role===expected.role&&issued.credentialHash===expected.credentialHash&&same(issued.scope,expected.scope),'epoch187-original-issued-metadata-client-required');
}
