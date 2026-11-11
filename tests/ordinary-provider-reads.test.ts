import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareOrdinaryProviderReads,type ProviderReadPolicy} from '../server/ordinary-provider-reads';
import {ProviderReadError} from '../server/provider-read-transport';
const allowed={readOnly:false,localWooFixture:false};
const selected=():ProviderReadPolicy=>({routes:[{origin:'https://provider.example',path:'/v1/products/:id',queryKeys:['cursor']}]});

test('default opt-out is inert, including readonly recovery and local Woo simulation',()=>{
 for(const context of [allowed,{readOnly:true,localWooFixture:false},{readOnly:false,localWooFixture:true}])assert.equal(prepareOrdinaryProviderReads(undefined,context),undefined);
});
test('explicit reads refuse readonly recovery before transport construction',()=>{
 assert.throws(()=>prepareOrdinaryProviderReads(selected(),{readOnly:true,localWooFixture:false}),/ordinary-readonly-no-provider-reads/);
});
test('explicit reads cannot override the local Woo fixture transport',()=>{
 assert.throws(()=>prepareOrdinaryProviderReads(selected(),{readOnly:false,localWooFixture:true}),/ordinary-provider-reads-no-local-woo-fixture/);
});
test('private policy rejects malformed routes and unknown options without requests',()=>{
 for(const policy of [null,[],{routes:selected().routes,request:()=>{}},{routes:[{origin:'https://provider.example',path:'/v1/*'}]}])assert.throws(()=>prepareOrdinaryProviderReads(policy as ProviderReadPolicy,allowed));
});
test('constructed option snapshots routes; mutated destinations and writes refuse before DNS',async()=>{
 const policy=selected(),read=prepareOrdinaryProviderReads(policy,allowed)!;assert.equal(typeof read,'function');
 policy.routes[0]!.origin='https://changed.example';
 await assert.rejects(read('https://changed.example/v1/products/123',{}),(e:unknown)=>e instanceof ProviderReadError&&e.code==='ROUTE');
 for(const init of [{method:'POST'},{method:'GET',body:'write'},{method:'GET',headers:{Cookie:'session=not-forwarded'}}])await assert.rejects(read('https://provider.example/v1/products/123',init),(e:unknown)=>e instanceof ProviderReadError&&['METHOD','BODY','HEADERS'].includes(e.code));
});
