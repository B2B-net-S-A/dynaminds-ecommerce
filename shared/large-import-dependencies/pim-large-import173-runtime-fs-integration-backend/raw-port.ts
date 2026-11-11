/** Actual raw filesystem lifecycle adapter, bound to the original private Actor. */
import assert from 'node:assert/strict';
import {createQuotaRawStore} from '../pim-large-import173-fs-hooks-backend2/store';
import {createPreparedPartDriver} from '../pim-large-import173-fs-hooks-backend2/parts-driver';
import type {Client} from './storage';
export type BoundRawPort={
 appendExact(handle:string,b:Uint8Array,offset:number):Promise<void>;
 inspect(handle:string):Promise<{sha256:string;byte_count:number}>;
 read(handle:string):AsyncIterable<Uint8Array>;
 appendPrepared(c:Client,admit:()=>Promise<void>,cleanupFailure:(error:unknown)=>void,handle:string,b:Uint8Array,offset:number):Promise<void>;
 prepareSealedRead(handle:string):ReturnType<ReturnType<typeof createQuotaRawStore>['prepareSealedRead']>;
};
const bindings=new WeakMap<object,object>();
export function createBoundRawPort<A extends object>(store:ReturnType<typeof createQuotaRawStore<A>>,actor:A):BoundRawPort{
 assert(actor&&typeof actor==='object','prepared-raw-original-actor');const port:BoundRawPort=Object.freeze({
  async appendExact(){throw Error('prepared-part-lifecycle-required');},
  inspect:(handle:string)=>store.inspect(actor,handle),
  read:(handle:string)=>store.read(actor,handle),
  prepareSealedRead:(handle:string)=>store.prepareSealedRead(actor,handle),
  async appendPrepared(c:Client,admit:()=>Promise<void>,cleanupFailure:(error:unknown)=>void,handle:string,input:Uint8Array,offset:number){const bytes=new Uint8Array(input),driver=createPreparedPartDriver(store,{client:a=>{assert.equal(a,actor,'prepared-raw-original-actor');return c;},admit:async(client,a)=>{assert.equal(client,c,'prepared-raw-same-client');assert.equal(a,actor,'prepared-raw-original-actor');await admit();},cleanupFailure});await driver.append(actor,handle,bytes,offset);},
 });bindings.set(port,actor);return port;
}
export function assertBoundRawPort(port:unknown,actor:object):asserts port is BoundRawPort{assert(port&&typeof port==='object'&&bindings.get(port)===actor,'prepared-raw-source-owned-binding');}

/** Concrete upload byte port and SAME metadata raw object, both bound to original capture + catalog + admitted file ceiling. */
export function createBoundUploadBytes<A extends object>(store:ReturnType<typeof createQuotaRawStore<A>>,actor:A,catalogId:string,maxBytes:number){
 assert(/^[a-f0-9-]{36}$/.test(catalogId)&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=30000000,'prepared-upload-config');
 const raw=createBoundRawPort(store,actor),check=(a:A)=>assert.equal(a,actor,'prepared-upload-original-actor');
 return {raw,bytes:Object.freeze({
  create:async(a:A,blobId:string)=>{check(a);return store.create(actor,blobId,catalogId,maxBytes);},
  seal:async(a:A,handle:string,fact:{sha256:string;byte_count:number})=>{check(a);return store.seal(actor,handle,structuredClone(fact));},
  prepareCleanup:async(a:A,handle:string)=>{check(a);const permit=await store.prepareQuarantine(actor,handle);let consumed=false;const once=()=>{assert(!consumed,'prepared-upload-cleanup-once');consumed=true;};return Object.freeze({publishFailure:async()=>{once();await store.publishPreparedQuarantine(permit);},retainUnused:async()=>{once();await store.retainUnusedQuarantine(permit);}});},
 })};
}
