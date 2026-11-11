/** Real selected route/class bodies, without importing app/db or calling a provider. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import Fastify from 'fastify';
import {z} from 'zod';
import {ensure,Problem} from '../server/errors';
const appSource=readFileSync(new URL('../server/app.ts',import.meta.url),'utf8');
const integrationSource=readFileSync(new URL('../server/integrations.ts',import.meta.url),'utf8');
const runtimeSource=readFileSync(new URL('../server/ordinary-local-runtime.ts',import.meta.url),'utf8');
const routeStart=appSource.indexOf("  app.get('/api/inpost/points', async (req) => {");
const routeEnd=appSource.indexOf('  registerPortalRoutes(',routeStart);
assert(routeStart>=0&&routeEnd>routeStart);const route=appSource.slice(routeStart,routeEnd);
function actualClass(start:string,end:string){const from=integrationSource.indexOf(start),to=integrationSource.indexOf(end,from+start.length);assert(from>=0&&to>from);return integrationSource.slice(from,to).replace(/^export /,'');}
const classes=actualClass('export class ApiClient {','export class Dpd extends')+actualClass('export class InPost extends','export class Fakturownia extends');
const transformed=transformSync(classes+route,{loader:'ts',format:'cjs',target:'es2022'}).code;
async function fixture(transport?:(url:string,init:RequestInit)=>Promise<Response>){
 const app=Fastify({logger:false});let unconfiguredCalls=0;
 const fallback=async()=>{unconfiguredCalls++;throw Error('UNINJECTED_TRANSPORT_MUST_NOT_RUN');};
 new Function('app','z','safeFetch','integrationTransport','ensure','Problem','setTimeout',transformed)(app,z,fallback,transport,ensure,Problem,async()=>{});
 await app.ready();return{app,unconfiguredCalls:()=>unconfiguredCalls};
}
const item={name:'FIXTURE1',type:['parcel_locker'],address:{line1:'Fixture'},status:'Operating',location:{latitude:52,longitude:21}};
test('exact normal InPost route passes configured transport into real constructor and GET request',async()=>{
 const calls:Array<{url:string;init:RequestInit}>=[];
 const f=await fixture(async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({items:[item],page:2,count:1}),{status:200});});
 try{const r=await f.app.inject({method:'GET',url:'/api/inpost/points?city=Warszawa&page=2'});assert.equal(r.statusCode,200);assert.deepEqual(r.json(),{data:[item],page:2,count:1});assert.equal(f.unconfiguredCalls(),0);assert.equal(calls.length,1);const u=new URL(calls[0]!.url);assert.equal(u.origin,'https://api-shipx-pl.easypack24.net');assert.equal(u.pathname,'/v1/points');assert.deepEqual(Object.fromEntries(u.searchParams),{city:'Warszawa',per_page:'20',page:'2'});assert.equal(calls[0]!.init.method,'GET');assert.equal(calls[0]!.init.body,undefined);assert.equal(new Headers(calls[0]!.init.headers).has('Authorization'),false);assert.equal(new Headers(calls[0]!.init.headers).has('Cookie'),false);}finally{await f.app.close();}
});
test('ordinary runtime actual disabled fallback refuses route before unconfigured transport',async()=>{
 const match=runtimeSource.match(/\(async\(\)=>\{throw new Error\('Ordinary local provider transport disabled'\);\}\)/);assert(match);
 const disabled=new Function('return '+match[0])() as (url:string,init:RequestInit)=>Promise<Response>;
 const f=await fixture(disabled);try{const r=await f.app.inject({method:'GET',url:'/api/inpost/points?city=Warszawa'});assert.equal(r.statusCode,500);assert.equal(f.unconfiguredCalls(),0);}finally{await f.app.close();}
});
test('malformed route query refuses before any selected transport dispatch',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;throw Error('MUST_NOT_DISPATCH');});try{await f.app.inject({method:'GET',url:'/api/inpost/points?city=X&page=0'});assert.equal(calls,0);assert.equal(f.unconfiguredCalls(),0);}finally{await f.app.close();}
});
