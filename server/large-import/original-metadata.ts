/** Exact private runtime capability; no request recapture or second client namespace. */
import assert from'node:assert/strict';import type{Actor}from'../domain';import type{FastifyRequest}from'fastify';
import{assertOriginalMetadataBinding,type BoundMetadataPorts}from'../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
export type OriginalMetadataBinding=Readonly<{scope:Readonly<{tenantId:string;userId:string;apiKeyId:string|null}>;ports:BoundMetadataPorts}>;
export function requireOriginalMetadataBinding(binding:OriginalMetadataBinding|undefined,actor:Actor,original:FastifyRequest):OriginalMetadataBinding{
 assert(binding,'local-runtime-original-metadata-binding-required');assertOriginalMetadataBinding(binding.ports,original,actor);assert.deepEqual(binding.scope,{tenantId:actor.tenantId,userId:actor.userId,apiKeyId:actor.apiKeyId??null});
 return Object.freeze({scope:Object.freeze({...binding.scope}),ports:binding.ports});
}
