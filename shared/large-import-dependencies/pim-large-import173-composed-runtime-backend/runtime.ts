/** Export-only composition. No default pool, app, HTTP routes, registry or role reset. */
import {createDedicatedMetadataTransport,type Ports as TransportPorts} from './transport';
import {createPostgresJobStore,createPostgresBlobMetadata,type RawStorage} from './storage';
import {createLargeImportCoordinator} from '../pim-large-import-job-coordinator-backend5/coordinator';
import type {Ports4} from '../pim-large-import-job-coordinator-backend5/core-review';
import type {Actor} from '../../../server/domain';
import assert from 'node:assert/strict';
export function createComposedLargeImportRuntime(transportPorts:TransportPorts){
 const transport=createDedicatedMetadataTransport(transportPorts);
 return {capture:transport.capture,bind(actor:Actor,raw:RawStorage,business:Omit<Ports4<Actor>,'jobs'|'blob'>){
  const {scope,ports}=transport.bind(actor),store=createPostgresJobStore(ports,scope),blobs=createPostgresBlobMetadata(ports,scope,raw);
  const authority=async(a:Actor)=>{assert.equal(a,actor,'runtime-original-captured-actor');const current=await business.authority(a);assert.deepEqual(current,scope,'runtime-current-principal');return current;};
  return {scope,coordinator:createLargeImportCoordinator({...business,authority,jobs:store,blob:blobs}),blobs};
 }};
}
