import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareOrdinaryConnectorAccess} from '../server/ordinary-provider-reads';
import {createOrdinaryConnectorTransport, ProviderReadError} from '../server/provider-read-transport';
import {bindOrdinaryConnectorTransport, ordinaryConnectorOrigins, assertDisjointConnectorOrigins} from '../server/ordinary-connector-routing';
import {assertOrdinaryConnectorJobExecution} from '../server/ordinary-connector-jobs';

const configuration={providers:[{provider:'inpost' as const,mode:'sandbox' as const,access:'read' as const}]};
test('coexisting construction is inert and retains readonly and branded-capability boundaries',()=>{
 const transport=prepareOrdinaryConnectorAccess(configuration,{readOnly:false,localWooFixture:true});assert(transport);
 assert.deepEqual(ordinaryConnectorOrigins(transport),['https://sandbox-api-shipx-pl.easypack24.net']);
 assert.throws(()=>prepareOrdinaryConnectorAccess(configuration,{readOnly:true,localWooFixture:true}),/readonly/);
 assert.throws(()=>ordinaryConnectorOrigins((async()=>new Response()) as any));
 assert.equal(prepareOrdinaryConnectorAccess(undefined,{readOnly:false,localWooFixture:true}),undefined);
});
test('ambiguous destination ownership is rejected before dispatch',()=>{
 const transport=createOrdinaryConnectorTransport(configuration);
 assert.throws(()=>assertDisjointConnectorOrigins(transport,['https://sandbox-api-shipx-pl.easypack24.net']),/origin-overlap/);
 assert.doesNotThrow(()=>assertDisjointConnectorOrigins(transport,['https://localhost:8443','https://localhost:8444']));
 assert.throws(()=>assertDisjointConnectorOrigins(transport,['https://localhost:8443/']),/exact-origin/);
});
test('one chosen connector request never falls back after failure or unsupported method',async()=>{
 let dns=0,fallback=0;
 const connector=createOrdinaryConnectorTransport(configuration,{resolve:async()=>{dns++;throw Error('controlled DNS unavailable');}});
 const route=bindOrdinaryConnectorTransport(async()=>{fallback++;return new Response('unexpected');},connector)!;
 await assert.rejects(route('https://sandbox-api-shipx-pl.easypack24.net/v1/points',{}),e=>e instanceof ProviderReadError&&e.code==='DNS');
 assert.equal(dns,1);assert.equal(fallback,0);
 await assert.rejects(route('https://sandbox-api-shipx-pl.easypack24.net/v1/points',{method:'DELETE'}));
 assert.equal(dns,1);assert.equal(fallback,0);
 await assert.rejects(route('not-a-url',{}));assert.equal(fallback,0);
});
test('owned local-store routing cannot acquire connector DNS access',async()=>{
 let dns=0;const calls:string[]=[];
 const connector=createOrdinaryConnectorTransport(configuration,{resolve:async()=>{dns++;throw Error('must not run');}});
 const local=async(url:string)=>{assert(['https://localhost:8443','https://localhost:8444'].includes(new URL(url).origin));calls.push(url);return new Response('local');};
 const route=bindOrdinaryConnectorTransport(local,connector)!;
 for(const port of [8443,8444])assert.equal(await(await route(`https://localhost:${port}/wp-json/wc/v3/products/1`,{})).text(),'local');
 await assert.rejects(route('https://outside.example/products',{}));
 assert.equal(dns,0);assert.equal(calls.length,2);
 assert.equal(bindOrdinaryConnectorTransport(local,undefined),local);
});
test('manual sandbox jobs may coexist, while live and Woo connector jobs stay refused',()=>{
 const transport=createOrdinaryConnectorTransport(configuration);
 assert.doesNotThrow(()=>assertOrdinaryConnectorJobExecution({mode:'sandbox_manual_once'},transport,false,true));
 assert.throws(()=>assertOrdinaryConnectorJobExecution({mode:'sandbox_manual_once'},transport,true,true));
 assert.throws(()=>assertOrdinaryConnectorJobExecution({mode:'sandbox_manual_once'},createOrdinaryConnectorTransport({providers:[{provider:'inpost',mode:'live',access:'write'}]}),false,true));
 assert.throws(()=>assertOrdinaryConnectorJobExecution({mode:'sandbox_manual_once'},createOrdinaryConnectorTransport({providers:[{provider:'woocommerce',storeUrl:'https://shop.example',access:'write'}]}),false,true));
});
