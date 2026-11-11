/** Export-only actual CORE function adapter. Loading the real module is a separate Root-owned step. */
import assert from 'node:assert/strict';
import {participateSharedOriginalFactory} from '../../../server/large-import/shared-session-writer';
import {runOriginalWriter,assertOriginalWriterBinding,type OriginalWriterBinding} from '../../../server/large-import/original-writer-participation';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import type {Actor} from '../../../server/domain';
import type * as Native from '../../../server/catalog-file-import';
import {ensure} from '../../../server/errors';
import {catalogFileImportPreviewInput,catalogFileImportExecuteInput} from '../../../server/catalog-file-import-schema';
import type {Ports,Ref,Head,CoreAck,CorePage} from '../pim-large-import-job-coordinator-backend5/coordinator';
export type NativeCoreModule=Pick<typeof Native,'createCatalogFileImportPreview'|'catalogFileImportPreviewDetail'|'executeCatalogFileImport'|'catalogFileImportExecutionDetail'>;
export type CoreEvidence={save(kind:'core-preview'|'core-preview-page'|'core-execution'|'core-execution-page',bytes:Uint8Array):Promise<Ref>};
const principal=(a:Actor)=>({tenantId:a.tenantId,userId:a.userId,apiKeyId:a.apiKeyId??null,role:a.role});
const hash=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex');
/** Exact durable/wire data: valid native Dates become ISO; unsupported lossy values refuse. */
function durableCoreValue(value:unknown):unknown{
 const active=new WeakSet<object>();let nodes=0;
 const copy=(v:unknown,depth:number):unknown=>{
  assert(depth<=64&&++nodes<=1000000,'core-durable-data-bound');
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){assert(Number.isFinite(v)&&!Object.is(v,-0),'core-durable-number');return v;}
  assert(typeof v==='object'&&v!==null,'core-durable-data-type');
  if(Object.getPrototypeOf(v)===Date.prototype){assert(Reflect.ownKeys(v).length===0&&Number.isFinite(Date.prototype.getTime.call(v)),'core-durable-date');return Date.prototype.toISOString.call(v);}
  assert(!active.has(v),'core-durable-cycle');active.add(v);
  try{
   const array=Array.isArray(v),prototype=Object.getPrototypeOf(v);
   assert(array?prototype===Array.prototype:prototype===Object.prototype||prototype===null,'core-durable-plain-data');
   const own=Reflect.ownKeys(v);assert(own.every(k=>typeof k==='string'),'core-durable-symbol-key');
   if(array){const names=new Set(own);assert(own.length===v.length+1&&names.has('length')&&Array.from({length:v.length},(_,i)=>String(i)).every(k=>names.has(k)),'core-durable-dense-array');}
   const result:any=array?[]:{};
   for(const key of own){if(array&&key==='length')continue;const descriptor:PropertyDescriptor=Object.getOwnPropertyDescriptor(v,key)!;assert(descriptor.enumerable&&Object.hasOwn(descriptor,'value'),'core-durable-own-data');Object.defineProperty(result,key,{value:copy(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});}
   return result;
  }finally{active.delete(v);}
 };
 return copy(value,0);
}
/** Host must import the ACTUAL adopted CORE namespace; mock callbacks in controls are not native proof. */
type CorePort=Ports<Actor>['core'];
const coreBindings=new WeakMap<object,{actor:Actor;original:FastifyRequest;native:NativeCoreModule;catalogId:string}>();
const coreObservations=new AsyncLocalStorage<{port:object;kind:'core-preview'|'core-execute';result:CoreAck}[]>();
export async function observeNativeCoreResults<T>(work:()=>Promise<T>){const results:{port:object;kind:'core-preview'|'core-execute';result:CoreAck}[]=[];let value:T|undefined,failed=false,error:unknown;try{value=await coreObservations.run(results,work);}catch(e){failed=true;error=e;}return{value,failed,error,results:[...results]};}
export function inspectNativeCoreBinding(port:CorePort,actor:Actor,original:FastifyRequest){const held=coreBindings.get(port);assert(held&&held.actor===actor&&held.original===original,'core-authentic-bound-driver');return{native:held.native,catalogId:held.catalogId};}
export function createNativeCoreDriver(native:NativeCoreModule,input:{available():boolean;readOnly:boolean;evidence:CoreEvidence;writer?:OriginalWriterBinding}){
 const writer=input.writer,module={...native},evidence=input.evidence,available=input.available,readOnly=input.readOnly;
 return{bind(runtimeActor:Actor,original:FastifyRequest,catalogId:string):Ports<Actor>['core']{
  if(writer)assertOriginalWriterBinding(writer,runtimeActor,original);
  // Exactly the public CORE route's apiKeyId projection and products read/write gate; no browser Actor authority.
  const nativeActor={...original.actor,...(original.apiScopes?{apiKeyId:original.currentUser?.api_key_id}:{})};
  assert.deepEqual(principal(runtimeActor),principal(nativeActor),'core-same-original-request');const captured=principal(runtimeActor);
  const check=(a:Actor,write=false)=>{assert.equal(a,runtimeActor,'core-runtime-actor-identity');assert.deepEqual(principal(a),captured,'core-runtime-actor-changed');assert.deepEqual(principal({...original.actor,...(original.apiScopes?{apiKeyId:original.currentUser?.api_key_id}:{})}),captured,'core-original-request-changed');ensure(!original.apiScopes||(original.apiScopes.includes('products:read')&&(!write||original.apiScopes.includes('products:write'))),403,'Wymagany scope products:read i products:write');ensure(!original.apiScopes||typeof original.currentUser?.api_key_id==='string',401,'Brak kontekstu klucza API');if(write)ensure(!readOnly,423,'Tryb tylko do odczytu');ensure(available(),503,'Brak rzeczywistego modułu CORE');};
  const save=async(kind:Parameters<CoreEvidence['save']>[0],value:unknown)=>{const bytes=new Uint8Array(Buffer.from(JSON.stringify(durableCoreValue(value))));ensure(bytes.length<=8388608,413,'Pełne świadectwo CORE przekracza limit');const ref=structuredClone(await evidence.save(kind,new Uint8Array(bytes)));assert(ref?.sha256===hash(bytes)&&ref.byte_count===bytes.length&&typeof ref.id==='string'&&ref.id,'core-owned-witness-readback');return ref;};
  const head=(v:unknown):Head=>{assert(v&&typeof v==='object'&&!Array.isArray(v),'core-head');const x=durableCoreValue(v) as Record<string,unknown>;const required=['id','actor_id','scope_hash','total','created','updated','unchanged','invalid','ready','created_at','config','active_product_rules'];assert(required.every(k=>Object.hasOwn(x,k)),'core-full-native-head');assert(x.actor_id===captured.userId&&typeof x.id==='string'&&typeof x.scope_hash==='string'&&/^[a-f0-9]{64}$/.test(x.scope_hash)&&Number.isSafeInteger(x.total)&&Number(x.total)>0&&Number(x.total)<=500&&typeof x.ready==='boolean','core-head-owner');return x as Head;};
  const ack=async(kind:'core-preview'|'core-execution',value:any):Promise<CoreAck>=>({head:head(value[kind==='core-preview'?'preview':'execution']),reused:value.reused===true,witness:await save(kind,value)});
  const page=async(kind:'core-preview-page'|'core-execution-page',value:any):Promise<CorePage>=>{assert(Array.isArray(value.rows)&&value.rows.length>=1&&value.rows.length<=100&&(value.meta?.cursor===null||typeof value.meta?.cursor==='string'),'core-full-page');return{head:head(value[kind==='core-preview-page'?'preview':'execution']),rows:durableCoreValue(value.rows) as CorePage['rows'],next:value.meta.cursor,witness:await save(kind,value)};};
  const port:CorePort={
   async preview(a,raw){check(a,true);const q=catalogFileImportPreviewInput.parse(structuredClone(raw));ensure(q.catalog_id===catalogId,422,'Inny katalog');const result=await module.createCatalogFileImportPreview(nativeActor,q);check(a,true);const captured=await ack('core-preview',result);coreObservations.getStore()?.push({port,kind:'core-preview',result:structuredClone(captured)});return captured;},
   async previewPage(a,id,cursor){check(a);const result=await module.catalogFileImportPreviewDetail(nativeActor,id,cursor??undefined);check(a);return page('core-preview-page',result);},
   async execute(a,id,raw){check(a,true);const q=catalogFileImportExecuteInput.parse(structuredClone(raw));ensure(q.confirmed===true,422,'Wymagana osobna zgoda CORE');const result=await module.executeCatalogFileImport(nativeActor,id,q);check(a,true);const captured=await ack('core-execution',result);coreObservations.getStore()?.push({port,kind:'core-execute',result:structuredClone(captured)});return captured;},
   async executionPage(a,id,cursor){check(a);const result=await module.catalogFileImportExecutionDetail(nativeActor,id,cursor??undefined);check(a);return page('core-execution-page',result);},
  };participateSharedOriginalFactory(original,port,["preview", "previewPage", "execute", "executionPage"]);coreBindings.set(port,{actor:runtimeActor,original,native:module,catalogId});return port;
 }};
}
/** Never called by the author/tests. Root imports native functions only after exact adopted-source admission. */
export async function loadActualCoreModule():Promise<NativeCoreModule>{return import('../../../server/catalog-file-import');}
