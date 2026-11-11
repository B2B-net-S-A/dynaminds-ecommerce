/** Actual route registration with closed IO; no DB, HTTP, provider or worker startup. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {z} from 'zod';
import {ensure, Problem} from '../server/errors';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base='/api/integrations/:id/offer-sync/commands';
function fixture(readOnly=false){
 const routes=new Map<string,any>(),calls:any[]=[],error={value:undefined as unknown};
 const commands=Object.fromEntries(['configure','observe','cancel'].map(name=>[name,async(...args:any[])=>{calls.push([name,...args]);if(error.value)throw error.value;return{status:name};}]));
 const source=readFileSync(new URL('../server/offer-sync-routes.ts',import.meta.url),'utf8');
 const ports:any={fastify:{},zod:{z},'./db':{tenantTx:()=>assert.fail('No DB in command routes')},'./errors':{ensure},'./offer-sync':{enqueueOfferSync:()=>assert.fail('No enqueue in command routes')},'./offer-sync-configuration':{offerSyncInput:{parse:(b:any)=>b},configureOfferSyncInTx:()=>assert.fail('No legacy configuration in commands')},'./offer-sync-commands':{createOfferSyncCommands:()=>commands}};
 const module={exports:{} as any},code=transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code;
 new Function('module','exports','require',code)(module,module.exports,(name:string)=>{assert(Object.hasOwn(ports,name),name);return ports[name];});
 const app={get:(p:string,fn:any)=>routes.set('GET '+p,fn),patch:(p:string,fn:any)=>routes.set('PATCH '+p,fn),post:(p:string,fn:any)=>routes.set('POST '+p,fn)};
 module.exports.registerOfferSyncRoutes(app,{readOnly,sessionName:'owned_session'});
 const req=()=>({headers:{},cookies:{owned_session:'owned'},actor:{tenantId:id(1),userId:id(2),role:'admin'},currentUser:{tenant_id:id(1),id:id(2),role:'admin'},params:{id:id(3)},query:{},body:{client_key:id(4),version:7,enabled:false}} as any);
 async function invoke(path:string,r=req()){let status=200;const reply:any={code:(s:number)=>{status=s;return reply;},send:(v:any)=>v};const value=await routes.get('POST '+path)(r,reply);return{status,value};}
 return{calls,routes,req,invoke,error};
}
test('configure, observe and cancel preserve actor/channel/original complete body and invoke exactly one core method',async()=>{
 for(const[tail,name,code]of [['','configure',201],['/observe','observe',200],['/cancel','cancel',200]] as const){const f=fixture(),r=f.req(),body=structuredClone(r.body);const result=await f.invoke(base+tail,r);assert.equal(result.status,code);assert.deepEqual(result.value,{status:name});assert.deepEqual(f.calls,[[name,r.actor,id(3),body]]);assert.deepEqual(r.body,body);}
});
test('all commands reject bearer, API key, absent cookie, foreign/stale principal and malformed route/query before core',async()=>{
 const mutations=[(r:any)=>r.headers.authorization='Bearer x',(r:any)=>r.cookies={},(r:any)=>r.actor.apiKeyId=id(5),(r:any)=>r.apiScopes=[],(r:any)=>r.actor.source='api',(r:any)=>r.actor.role='viewer',(r:any)=>r.currentUser=undefined,(r:any)=>r.currentUser.role='viewer',(r:any)=>r.currentUser.id=id(6),(r:any)=>r.currentUser.tenant_id=id(6),(r:any)=>r.currentUser.api_key_id=id(5),(r:any)=>r.params.id='bad',(r:any)=>r.query={extra:true}];
 for(const tail of ['','/observe','/cancel'])for(const mutate of mutations){const f=fixture(),r=f.req();mutate(r);await assert.rejects(f.invoke(base+tail,r));assert.equal(f.calls.length,0);}
});
test('readonly refuses configure/cancel and permits only observation of the original result',async()=>{
 const f=fixture(true);for(const tail of ['','/cancel'])await assert.rejects(f.invoke(base+tail),(e:any)=>e.status===423);assert.equal(f.calls.length,0);const r=f.req();await f.invoke(base+'/observe',r);assert.deepEqual(f.calls,[['observe',r.actor,id(3),r.body]]);
});
test('lost ACK and core refusal propagate without retry, enqueue or rewritten key',async()=>{
 const f=fixture(),failure=Error('Lost ACK');f.error.value=failure;const r=f.req(),body=structuredClone(r.body);await assert.rejects(f.invoke(base,r),e=>e===failure);assert.deepEqual(f.calls,[['configure',r.actor,id(3),body]]);assert.deepEqual(r.body,body);
});
test('actual app passes native readonly and session-name options',()=>{
 const source=readFileSync(new URL('../server/app.ts',import.meta.url),'utf8');assert.equal(source.split('registerOfferSyncRoutes(app, {readOnly, sessionName});').length,2);
});

test('actual global restore-preview middleware allows only observational command POST, keeping configure/cancel blocked',()=>{
 const source=readFileSync(new URL('../server/app.ts',import.meta.url),'utf8'),a=source.indexOf("    if (readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))"),b=source.indexOf("    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin)",a);assert(a>0&&b>a);
 const guard=new Function('readOnly','req','ensure','Problem',source.slice(a,b)),observe='/api/integrations/'+id(3)+'/offer-sync/commands/observe';
 assert.doesNotThrow(()=>guard(true,{method:'POST',url:observe},ensure,Problem));
 assert.doesNotThrow(()=>guard(true,{method:'POST',url:observe+'?extra=true'},ensure,Problem)); // The strict native route rejects this query before core.
 for(const method of ['PATCH','PUT','DELETE'])assert.throws(()=>guard(true,{method,url:observe},ensure,Problem),(e:any)=>e.status===423);
 for(const suffix of ['', '/cancel','/observe/','/observe/dispatch','/observe-extra'])assert.throws(()=>guard(true,{method:'POST',url:'/api/integrations/'+id(3)+'/offer-sync/commands'+suffix},ensure,Problem),(e:any)=>e.status===423);
 assert.throws(()=>guard(true,{method:'POST',url:observe.replace(id(3),'invalid')},ensure,Problem),(e:any)=>e.status===423);
 for(const url of ['/api/orders','/api/jobs/'+id(4)+'/run','/api/integrations/'+id(3)+'/offer-sync'])assert.throws(()=>guard(true,{method:'POST',url},ensure,Problem),(e:any)=>e.status===423);
 assert.doesNotThrow(()=>guard(false,{method:'POST',url:'/api/orders'},ensure,Problem));
});
