import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import * as origins from '../shared/local-woo-origins';
import {localWooOrigin} from '../server/local-woo-http-transport';
import {ensure,Problem} from '../server/errors';
const require=createRequire(import.meta.url);
const id=(n:number)=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const configurations=()=>origins.LOCAL_WOO_SCALE_ORIGINS.map((origin,i)=>({fixtureId:id(10+i),channelId:id(20+i),tenantId:id(30+i),userId:id(40+i),origin,ca:{path:'/controlled/ca.pem',sha256:'a'.repeat(64)},credentials:{path:'/controlled/credentials-'+i+'.json',sha256:'b'.repeat(64)}}));
// Execute the actual registry; its fixture construction/read/transport are explicit
// controlled ports. No DB, app factory or network is imported by this test loader.
function registryModel(failAt=-1){
 const created:any[]=[],calls:any[]=[],closed:any[]=[],live=new Set<any>();
 const fixture={
  async createLocalWooHttpFixture(configuration:any){
   if(created.length===failAt)throw Error('CONTROLLED_CONSTRUCTION_FAILURE');
   const value={configuration,transport:async(url:string,init:unknown)=>{assert(live.has(value));calls.push({configuration,url,init});return Response.json({channel_id:configuration.channelId});},close:async()=>{live.delete(value);closed.push(value);}};
   created.push(value);live.add(value);return value;
  },
  assertLocalWooHttpFixture(value:any){assert(live.has(value));},
  async readConfiguredLocalWooHttpChannel(value:any,actor:any){assert(live.has(value));assert.equal(actor.tenantId,value.configuration.tenantId);assert.equal(actor.userId,value.configuration.userId);return {channel_id:value.configuration.channelId,origin:value.configuration.origin};},
 };
 const deps:any={'./local-woo-http-fixture':fixture,'./local-woo-http-transport':{localWooOrigin},'../shared/local-woo-origins':origins,'./errors':{ensure,Problem}};
 const source=readFileSync(new URL('../server/local-woo-http-registry.ts',import.meta.url),'utf8'),code=transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code,m={exports:{}};
 new Function('module','require',code)(m,(name:string)=>{if(name in deps)return deps[name];if(name.startsWith('.'))throw Error('Unmodeled module '+name);return require(name);});
 return{api:m.exports as any,created,calls,closed};
}
test('raw local origin contract is exactly seven finite HTTPS origins; old default remains unchanged',()=>{
 assert(Object.isFrozen(origins.LOCAL_WOO_ORIGINS));assert(Object.isFrozen(origins.LOCAL_WOO_SCALE_ORIGINS));
 assert.equal(localWooOrigin(),'https://localhost:8443');assert.equal(origins.MAX_LOCAL_WOO_STORES,5);
 assert.deepEqual(origins.LOCAL_WOO_ORIGINS,['https://localhost:8443','https://localhost:8444','https://localhost:18443','https://localhost:18444','https://localhost:18445','https://localhost:18446','https://localhost:18447']);
 for(const origin of origins.LOCAL_WOO_ORIGINS){assert.equal(localWooOrigin(origin),origin);assert(origins.isLocalWooOrigin(origin));}
 for(const bad of [undefined,null,{},42,'https://localhost:18442','https://localhost:18448','http://localhost:18443','https://127.0.0.1:18443','https://LOCALHOST:18443','https://localhost:018443','https://localhost:18443/','https://localhost:18443?x=1','https://localhost:18443#x','https://user:password@localhost:18443',' https://localhost:18443','https://localhost:18443\n']){
  assert(!origins.isLocalWooOrigin(bad));if(bad!==undefined)assert.throws(()=>localWooOrigin(bad),/origin refused/);
 }
});
test('five registry rows preserve exact identities and snapshot input; empty/six/duplicate/unknown origins refuse',()=>{
 const q=registryModel(),input=configurations(),selected=q.api.validateLocalWooFixtureConfigurations(input);
 assert.deepEqual(selected,input);input[0].credentials.path='/mutated';assert.equal(selected[0].credentials.path,'/controlled/credentials-0.json');
 for(const corrupt of [()=>[],()=>[...configurations(),{...configurations()[0],fixtureId:id(90),channelId:id(91),origin:'https://localhost:8443'}],()=>configurations().map((v,i)=>i===1?{...v,fixtureId:id(10)}:v),()=>configurations().map((v,i)=>i===1?{...v,channelId:id(20)}:v),()=>configurations().map((v,i)=>i===1?{...v,origin:origins.LOCAL_WOO_SCALE_ORIGINS[0]}:v),()=>configurations().map((v,i)=>i===1?{...v,origin:'https://localhost:18448'}:v)]){
  assert.throws(()=>q.api.validateLocalWooFixtureConfigurations(corrupt()));
 }
 // Existing legitimate two-store/same-owner configuration remains allowed.
 const legacy=configurations().slice(0,2).map((v,i)=>({...v,tenantId:id(1),userId:id(2),origin:origins.LOCAL_WOO_ORIGINS[i]}));
 assert.equal(q.api.validateLocalWooFixtureConfigurations(legacy).length,2);
});
test('five actual registry dispatches and reads are isolated by configured tenant/user/channel and fixed destination',async()=>{
 const q=registryModel(),input=configurations(),registry=await q.api.createLocalWooHttpRegistry(input);
 try{
  input[0].tenantId=id(999);input[0].credentials.path='/mutated';
  const expected=configurations();assert.deepEqual(q.api.localWooRegistryChannelIds(registry),expected.map(c=>c.channelId));
  for(const config of expected){
   const actor={tenantId:config.tenantId,userId:config.userId,role:'admin'};
   assert.equal(q.api.localWooRegistryFixture(registry,actor,config.channelId).configuration.tenantId,config.tenantId);
   const dto=await q.api.readConfiguredLocalWooChannels(registry,actor);assert.equal(dto.provider_verified,false);assert.deepEqual(dto.data,[{channel_id:config.channelId,origin:config.origin}]);
   assert.deepEqual(await(await registry.transport(config.origin+'/wp-json/wc/v3/products/17',{method:'GET'})).json(),{channel_id:config.channelId});
   assert.throws(()=>q.api.localWooRegistryFixture(registry,{...actor,tenantId:id(998)},config.channelId));
   assert.throws(()=>q.api.localWooRegistryFixture(registry,{...actor,userId:id(997)},config.channelId));
   assert.throws(()=>q.api.localWooRegistryFixture(registry,actor,id(996)));
   await assert.rejects(q.api.readConfiguredLocalWooChannels(registry,{...actor,role:'viewer'}));
   await assert.rejects(q.api.readConfiguredLocalWooChannels(registry,{...actor,apiKeyId:id(995)}));
  }
  const before=q.calls.length;
  await assert.rejects(registry.transport('https://localhost:8443/wp-json/wc/v3/orders',{}));
  await assert.rejects(registry.transport('https://example.test/wp-json/wc/v3/orders',{}));assert.equal(q.calls.length,before);
  assert.equal(q.created[0].configuration.credentials.path,'/controlled/credentials-0.json');
 }finally{await registry.close();}
 assert.equal(q.closed.length,5);assert.throws(()=>q.api.localWooRegistryChannelIds(registry));
 await assert.rejects(registry.transport(origins.LOCAL_WOO_SCALE_ORIGINS[0]+'/wp-json/wc/v3/orders',{}));
});
test('construction failure closes already-created fixtures and retains the original failure',async()=>{
 const q=registryModel(3);await assert.rejects(q.api.createLocalWooHttpRegistry(configurations()),/CONTROLLED_CONSTRUCTION_FAILURE/);assert.equal(q.created.length,3);assert.equal(q.closed.length,3);
});
