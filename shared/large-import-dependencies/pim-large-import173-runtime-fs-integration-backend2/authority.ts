/** Opaque publication custody. Factory/import has no IO; no caller-owned Actor or generic FS callback can establish authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bindOriginalPublicationMetadata,type BoundMetadataPorts,type Ports as TransportPorts} from '../pim-large-import173-composed-runtime-backend/transport';
import type {Actor} from '../../../server/domain';
import type {OwnedRequest} from '../pim-large-import-upload-quota-broker-backend3/broker';
import type {Client,MetadataPorts} from './storage';
import type {Scope,OwnedQuota} from './publisher';
type Request=Parameters<ReturnType<typeof import('../pim-large-import173-composed-runtime-backend/transport')['createDedicatedMetadataTransport']>['capture']>[0];
export type PublicationAuthority=Readonly<{kind:'private-publication-authority/v2'}>;
type Facts={original:Request;actor:Actor;scope:Scope;request:OwnedRequest;auth:readonly unknown[];token:string;metadata:Pick<MetadataPorts,'connect'|'admit'|'cleanupFailure'>;cleanupConnect():Promise<Client>;used:WeakSet<Client>};
const privateFacts=new WeakMap<object,Facts>();
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export function createPublicationAuthorityFactory(config:TransportPorts){const ports={...config};return{
 bind(actor:Actor,original:Request,input:OwnedRequest,metadata:Pick<MetadataPorts,'connect'|'admit'|'cleanupFailure'>):PublicationAuthority{
  const bound=bindOriginalPublicationMetadata(ports,metadata as BoundMetadataPorts,original,actor),captured=bound.actor;assert.equal(captured,actor,'publication-same-genuine-original-actor');assert.deepEqual({tenant:actor.tenantId,user:actor.userId,key:actor.apiKeyId??null,role:actor.role},{tenant:captured.tenantId,user:captured.userId,key:captured.apiKeyId??null,role:captured.role},'publication-same-original-principal');
  const request=structuredClone(input);assert(['upload','job','review'].includes(request.kind)&&typeof request.privateToken==='string'&&request.privateToken.length>=32,'publication-owned-request');assert(request.kind==='upload'||request.ceiling.raw===0,'publication-business-no-raw-growth');
  const cleanupConnect=()=>bound.cleanupConnect();
  const handle=Object.freeze({kind:'private-publication-authority/v2' as const});privateFacts.set(handle,{original,actor,scope:{tenantId:actor.tenantId,actorId:actor.userId,apiKeyId:actor.apiKeyId??null},request,auth:bound.auth,token:sha(request.privateToken),metadata:{...metadata},cleanupConnect,used:new WeakSet<Client>()});return handle;
 },
};}
/** Internal typed lookup only; no execution callback, token/credential serialization or reconstructed handles. */
export function requirePublicationAuthority(handle:PublicationAuthority,actor:object,owned:OwnedQuota){const f=privateFacts.get(handle);assert(f&&f.actor===actor,'publication-private-original-actor');assert.deepEqual(f.scope,owned.scope,'publication-owned-scope');assert(f.request.reservationId===owned.reservationId,'publication-same-reservation');return f;}
export type PublicationClient=Client;
