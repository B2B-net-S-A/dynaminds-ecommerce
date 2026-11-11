/** Export-only application composition. Default unavailable; no default pool/listen/workers. */
import type {FastifyInstance} from 'fastify';
import {Problem,ensure} from '../errors';
import type {createComposedLargeImportRuntime} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/runtime';
import type {Ports as MetadataTransportPorts} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/transport';
import {inspectCompositeStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import type {ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/api';
import {bindComposedRuntime,type Binding,type OriginalBindingRuntime} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/contracts';
import {createOwnedMetadataReader,type ReadPorts} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/readonly-store';
import {registerLargeImportRoutes} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/routes';
import {inspectReadiness,type WriteHookRegistry} from '../../shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/registry';
declare module 'fastify'{interface FastifyContextConfig{largeImportSameParserAlias?:boolean;}}
// One exact cold inspector per genuine Startup. Request capture keys include this
// function identity; public registration and producer brokers must share its issuer.
const metadataPreflights=new WeakMap<ReviewedStartup,MetadataTransportPorts['preflightOwner173']>();
export function createReviewedMetadataPreflight(startup:ReviewedStartup):MetadataTransportPorts['preflightOwner173']{
 let inspect=metadataPreflights.get(startup);
 if(!inspect){inspect=async c=>{await inspectCompositeStartup(c,startup);return 'VALID' as const;};metadataPreflights.set(startup,inspect);}
 return inspect;
}
export const mandatoryHooks=['durable-byte-store','durable-upload-registry','raw-intents','blob-intents','batch-intents','job-intents','review-intents','event-intents','native-core-eligibility','native-core-pim-drivers','current-actor-custody'] as const;
export type NativeDrivers={
 /** Private reviewed complete12/34 startup handle; no caller JSON profile or owner helper self-attestation. */
 startup:ReviewedStartup;
 transport:Omit<MetadataTransportPorts,'preflightOwner173'>;
 /** Private registry handle requires independently saved native operation/wiring coverage and complete retained inventory. No JSON ready flag. */
 registry:WriteHookRegistry;
 /** REQUIRED source-reviewed runtime successor using this exact registry at every actual mutation call site. No unwrapped4ccd default. */
 runtimeFactory(transport:MetadataTransportPorts,registry:WriteHookRegistry):OriginalBindingRuntime;
 forActor:Parameters<typeof bindComposedRuntime>[1]['forActor'];
 reader?:ReadPorts;
 tenantAvailability?:(req:import('fastify').FastifyRequest)=>{available:boolean;reason?:string};
};
export async function createLargeImportApplication(input:NativeDrivers|undefined,readOnly:boolean){
 let available=false,independentCreates=false;const tenantAvailability=input?.tenantAvailability??(()=>({available:true}));
 let binding:Binding={startup:async()=>false,bind:async()=>{throw new Problem(503,'Duże importy wymagają kompletnego certyfikowanego podłączenia');}};
 let reader:ReturnType<typeof createOwnedMetadataReader>|undefined;
 if(input){
  // Capture ALL mutable construction values before the first await. Runtime request custody still uses ORIGINAL requests.
  const startup=input.startup,transport={...input.transport},forActor=input.forActor,registry=input.registry,runtimeFactory=input.runtimeFactory,readPorts=input.reader?{...input.reader}:undefined;
  const inspect=createReviewedMetadataPreflight(startup);
  let c:Awaited<ReturnType<typeof transport.connectOwner>>|undefined,failed=false,first:unknown;
  try{c=await transport.connectOwner();await inspect(c);}catch(e){failed=true;first=e;}finally{if(c)try{await c.end();}catch(e){if(!failed){failed=true;first=e;}}}if(failed)throw first;
  const hooks=await inspectReadiness(registry);
  if(hooks){ensure(hooks.ready===true&&typeof hooks.independentCreates==='boolean'&&mandatoryHooks.every(x=>hooks.hooks.includes(x))&&new Set(hooks.hooks).size===hooks.hooks.length,503,'Niekompletne porty lub pokrycie mutacji limitami');
   available=true;independentCreates=hooks.independentCreates;
   ensure(typeof runtimeFactory==='function',503,'Brak certyfikowanego podłączenia rejestru do rzeczywistych mutacji');
   const runtime=runtimeFactory({...transport,preflightOwner173:inspect},registry);
   ensure(typeof runtime.metadataBinding==='function',503,'Brak oryginalnego powiązania metadanych runtime');
   binding=bindComposedRuntime(runtime,{startup:async()=>({certified:true,coreReview:true,streamUpload:true,independentCreates}),forActor});
   reader=readPorts?createOwnedMetadataReader(readPorts):undefined;
  }
 }
 return {available,independentCreates,tenantAvailability,register:(app:FastifyInstance)=>registerLargeImportRoutes(app,{binding,readOnly,tenantAvailability,...(reader?{reader}:{})})};
}
export type ApplicationModule=Awaited<ReturnType<typeof createLargeImportApplication>>;
