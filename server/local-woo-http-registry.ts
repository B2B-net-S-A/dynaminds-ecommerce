/** Up to five construction-selected local stores; credentials never choose an arbitrary destination. */
import assert from 'node:assert/strict';
import type {Actor} from './domain';
import type {Transport} from './integrations';
import {ensure} from './errors';
import {localWooOrigin} from './local-woo-http-transport';
import {MAX_LOCAL_WOO_STORES} from '../shared/local-woo-origins';
import {createLocalWooHttpFixture,assertLocalWooHttpFixture,readConfiguredLocalWooHttpChannel,type LocalWooFixtureConfiguration,type LocalWooHttpFixture} from './local-woo-http-fixture';

export type LocalWooHttpRegistry=Readonly<{transport:Transport;close:()=>Promise<void>}>;
type Entry={configuration:LocalWooFixtureConfiguration;fixture:LocalWooHttpFixture};
const owned=new WeakMap<LocalWooHttpRegistry,{entries:readonly Entry[];closed:boolean}>();
export function validateLocalWooFixtureConfigurations(input:readonly LocalWooFixtureConfiguration[]){
 assert(Array.isArray(input)&&input.length>=1&&input.length<=MAX_LOCAL_WOO_STORES,'one-to-five-local-Woo-stores-required');
 const values=structuredClone(input);
 for(const field of ['fixtureId','channelId'] as const)assert.equal(new Set(values.map(c=>c[field])).size,values.length,'distinct-local-Woo-identities-required');
 assert.equal(new Set(values.map(c=>localWooOrigin(c.origin))).size,values.length,'distinct-local-Woo-origins-required');
 return values;
}
function state(registry:LocalWooHttpRegistry){const s=owned.get(registry);ensure(s&&!s.closed,503,'Lokalne sklepy są niedostępne');return s;}
export function assertLocalWooHttpRegistry(registry:LocalWooHttpRegistry){for(const e of state(registry).entries)assertLocalWooHttpFixture(e.fixture);}
export function localWooRegistryChannelIds(registry:LocalWooHttpRegistry):readonly string[]{return Object.freeze(state(registry).entries.map(e=>e.configuration.channelId));}
export function localWooRegistryFixture(registry:LocalWooHttpRegistry,actor:Actor,channelId:string){
 const e=state(registry).entries.find(e=>e.configuration.channelId===channelId&&e.configuration.tenantId===actor.tenantId&&e.configuration.userId===actor.userId);
 ensure(e,404,'Brak własnego skonfigurowanego sklepu');return e.fixture;
}
export async function readConfiguredLocalWooChannels(registry:LocalWooHttpRegistry,actor:Actor){
 const entries=state(registry).entries.filter(e=>e.configuration.tenantId===actor.tenantId&&e.configuration.userId===actor.userId);
 ensure(actor.role==='admin'&&!actor.apiKeyId,403,'Wymagana własna sesja administratora');
 const data=[];for(const e of entries)data.push(await readConfiguredLocalWooHttpChannel(e.fixture,actor));
 return {scope:'local_https_fixture' as const,provider_verified:false,data};
}
export async function createLocalWooHttpRegistry(input:readonly LocalWooFixtureConfiguration[]):Promise<LocalWooHttpRegistry>{
 const configurations=validateLocalWooFixtureConfigurations(input),entries:Entry[]=[];
 try{for(const configuration of configurations)entries.push({configuration,fixture:await createLocalWooHttpFixture(configuration)});}
 catch(first){await Promise.allSettled(entries.map(e=>e.fixture.close()));throw first;}
 const s={entries,closed:false};let closing:Promise<void>|undefined;
 const registry:LocalWooHttpRegistry=Object.freeze({
  transport:async(url,init)=>{
   const active=state(registry);let destination:URL;
   try{destination=new URL(url);}catch{throw new Error('Local Woo destination refused');}
   const entry=active.entries.find(e=>localWooOrigin(e.configuration.origin)===destination.origin);
   ensure(entry,403,'Transport dopuszcza wyłącznie skonfigurowane lokalne sklepy');
   return entry.fixture.transport(url,init);
  },
  close:()=>closing??=(async()=>{
   s.closed=true;const results=await Promise.allSettled(entries.map(e=>e.fixture.close()));
   for(const r of results)if(r.status==='rejected')throw r.reason;
  })(),
 });
 owned.set(registry,s);return registry;
}
