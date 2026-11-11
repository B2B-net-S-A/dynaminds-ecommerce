/** Actual wire route + existing rate-limit plugin, closed credential/domain ports.
 * Local tenant quota, not a claim about Base's undisclosed quota-key algorithm.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { registerBaseWireCrmRoutes } from '../server/base-wire-crm-routes';
import { Problem } from '../server/errors';
import { createOrdinaryRequestLifetime,installOrdinaryRequestLifetime,inspectOrdinaryRequests,
  beginOrdinaryShutdown,drainOrdinaryRequests } from '../server/ordinary-request-lifetime';
const uid=(n:number)=>`61000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture(parent=true,readOnly=false) {
 const app=Fastify(),lifetime=createOrdinaryRequestLifetime(),calls:any[]=[],authenticated:string[]=[];
 installOrdinaryRequestLifetime(app,lifetime);
 if(parent)await app.register(rateLimit,{max:600,timeWindow:60000});
 registerBaseWireCrmRoutes(app,{available:true,readOnly,requestLifetime:lifetime,
  authenticate:async(token,scope)=>{
   const m=/^closed-([1-9])-([ab])$/.exec(token);if(!m)throw new Problem(401,'refused secret token');
   authenticated.push(token);return{id:uid(10+Number(m[1])),tenant_id:uid(Number(m[1])),role:'admin',api_key_id:uid(30+Number(m[1])*2+(m[2]==='b'?1:0)),scopes:[scope]};
  },service:{execute:async(actor:any,method:any)=>{calls.push({actor,method});return method==='addCrmClient'?{crm_client_id:1}:method==='getCrmClientExtraFields'?{extra_fields:[]}:{clients:[]};},file:async()=>assert.fail('Not part of five-method quota')} as any});
 const request=(tenant=1,key='a',method='getCrmClients',headers:Record<string,string>={})=>app.inject({method:'POST',url:'/connector.php',
  headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':`closed-${tenant}-${key}`,...headers},
  payload:new URLSearchParams({method,parameters:JSON.stringify(method==='getCrmClientData'||method==='deleteCrmClient'?{crm_client_id:1}:method==='addCrmClient'?{login:'closed-test'}:method==='getCrmClientExtraFields'?{}:{page:1})}).toString()});
 return{app,lifetime,calls,authenticated,request};
}
function refused(r:any,limit=100){
 assert.equal(r.statusCode,429,r.body);const body=r.json();assert.equal(body.status,'ERROR');
 assert.deepEqual(Object.keys(body).sort(),['error_code','error_message','status']);
 assert(!/closed-|61000000|secret|rateLimitRan/.test(r.body));
 assert.equal(r.headers['cache-control'],'private, no-store');assert.equal(Number(r.headers['x-ratelimit-limit']),limit);
 assert(Number(r.headers['retry-after'])>=1&&Number(r.headers['retry-after'])<=60);
}
async function idle(h:Awaited<ReturnType<typeof fixture>>){
 await new Promise<void>(r=>setImmediate(r));assert.equal(inspectOrdinaryRequests(h.lifetime).active_requests,0);
}

test('100 requests/min is shared by tenant across keys and all5 methods; another tenant has its own quota',async t=>{
 const h=await fixture();t.after(()=>h.app.close());
 for(let i=0;i<100;i++){
  const methods=['getCrmClients','getCrmClientData','addCrmClient','deleteCrmClient','getCrmClientExtraFields'];
  assert.equal((await h.request(1,i%2?'a':'b',methods[i%5])).statusCode,200);
 }
 refused(await h.request(1,'a'));refused(await h.request(1,'b'));
 assert.equal(h.calls.length,100);
 assert.equal((await h.request(2)).statusCode,200);assert.equal(h.calls.length,101);
 await idle(h);beginOrdinaryShutdown(h.lifetime);const done=await drainOrdinaryRequests(h.lifetime);assert.equal(done.active_tasks,0);
});
test('window ends at60000ms; rejected calls do not slide or double-increment it',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1000000});
 const h=await fixture(false);t.after(()=>h.app.close());
 for(let i=0;i<100;i++)assert.equal((await h.request()).statusCode,200);
 refused(await h.request());t.mock.timers.tick(59999);refused(await h.request());
 t.mock.timers.tick(1);const allowed=await h.request();assert.equal(allowed.statusCode,200);assert.equal(Number(allowed.headers['x-ratelimit-remaining']),99);
 assert.equal(h.calls.length,101);await idle(h);
});
test('parent600/IP remains effective across tenant quotas and fails before extra authentication/domain',async t=>{
 const h=await fixture();t.after(()=>h.app.close());
 for(let tenant=1;tenant<=6;tenant++)for(let i=0;i<100;i++)assert.equal((await h.request(tenant)).statusCode,200);
 assert.equal(h.calls.length,600);assert.equal(h.authenticated.length,600);
 refused(await h.request(7),600);assert.equal(h.calls.length,600);assert.equal(h.authenticated.length,600);await idle(h);
});
test('readonly calls use same in-memory quota without a domain mutation; unauthenticated or spoofed tenants cannot burn a tenant bucket',async t=>{
 const h=await fixture(true,true);t.after(()=>h.app.close());
 const before=h.calls.length;
 for(const method of ['addCrmClient','deleteCrmClient'])assert.equal((await h.request(1,'a',method)).statusCode,423);assert.equal(h.calls.length,before);
 for(let i=0;i<5;i++){
  assert.equal((await h.request(1,'a','getCrmClients',{'x-bltoken':'invalid-secret'})).statusCode,401);
  assert.equal((await h.request(1,'a','getCrmClients',{'x-workspace-id':uid(2)})).statusCode,409);
 }
 for(let i=0;i<100;i++)assert.equal((await h.request()).statusCode,200);
 refused(await h.request());assert(h.calls.every(c=>c.method==='getCrmClients'));
 await idle(h);
});
test('connector.php attachment GET takes the same tenant bucket as POST; another tenant is unaffected (SEC-013)',async t=>{
 const app=Fastify(),files:string[]=[];t.after(()=>app.close());
 registerBaseWireCrmRoutes(app,{available:true,readOnly:false,
  authenticate:async token=>{const m=/^closed-([1-9])-([ab])$/.exec(token);if(!m)throw new Problem(401,'refused secret token');
   return{id:uid(10+Number(m[1])),tenant_id:uid(Number(m[1])),role:'admin',api_key_id:uid(30+Number(m[1])*2+(m[2]==='b'?1:0)),scopes:['crm:read']};},
  service:{execute:async()=>({clients:[]}),file:async(actor:any)=>{files.push(actor.tenantId);return{title:'a.txt',mime_type:'text/plain',bytes:Buffer.from('x')};}} as any});
 const file=(tenant=1,key='a')=>app.inject({method:'GET',url:'/connector.php/files/clients/1/fields/2',headers:{'x-bltoken':`closed-${tenant}-${key}`}});
 const post=(tenant=1)=>app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':`closed-${tenant}-a`},
  payload:new URLSearchParams({method:'getCrmClients',parameters:JSON.stringify({page:1})}).toString()});
 for(let i=0;i<99;i++)assert.equal((await file(1,i%2?'a':'b')).statusCode,200);
 assert.equal((await post()).statusCode,200);
 refused(await file(1));refused(await file(1,'b'));refused(await post());
 assert.equal(files.length,99);
 const other=await file(2);assert.equal(other.statusCode,200);assert.equal(Number(other.headers['x-ratelimit-remaining']),99);
 assert.equal((await app.inject({method:'GET',url:'/connector.php/files/clients/1/fields/2',headers:{'x-bltoken':'invalid-secret'}})).statusCode,401);
 assert.equal(files.length,100);
});
