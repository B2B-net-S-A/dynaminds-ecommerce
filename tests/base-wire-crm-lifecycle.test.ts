/** Real Fastify hooks, request lifetime, rate-limit and wire child handler.
 * Closed service/auth ports; no PostgreSQL, network listener or application build.
 * These tests use the existing parent hook without requiring CRM registration
 * in buildApp. The separate application-registration test belongs to the future
 * app/auth/SQL integration package, not this standalone source component.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { transformSync } from 'esbuild';
import rateLimit from '@fastify/rate-limit';
import { registerBaseWireCrmRoutes } from '../server/base-wire-crm-routes';
import { Problem, ensure } from '../server/errors';
import { createOrdinaryRequestLifetime, installOrdinaryRequestLifetime, inspectOrdinaryRequests,
  beginOrdinaryShutdown, drainOrdinaryRequests } from '../server/ordinary-request-lifetime';
const uid=(n:number)=>`51000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const form=new URLSearchParams({method:'getCrmClients',parameters:'{"page":1}'}).toString();
const source=readFileSync(new URL('../server/app.ts',import.meta.url),'utf8');
const hookStart=source.indexOf("  app.addHook('onRequest', async (req, reply) => {");
const hookEnd=source.indexOf("  app.get('/api/health'",hookStart);
assert(hookStart>0&&hookEnd>hookStart);
const hookPrefix="  app.addHook('onRequest', async (req, reply) => {";
const hookBody=source.slice(hookStart+hookPrefix.length,hookEnd);
assert(hookBody.trimEnd().endsWith('});'));
// The literal parent hook returns before auth/cookie/Origin access for connector
// paths; execute that original body rather than a hand-written approximation.
const parentCode=transformSync('const originalHook=async (req,reply)=>{'+hookBody.slice(0,hookBody.lastIndexOf('});'))+'};',{loader:'ts',format:'cjs'}).code;
const parentHook=(readOnly:boolean)=>new Function('readOnly','Problem','ensure',parentCode+';return originalHook;')(readOnly,Problem,ensure);
async function fixture(opts:{readOnly?:boolean;authFailure?:boolean;fileFailure?:boolean;rate?:number}={}) {
  const app=Fastify(),lifetime=createOrdinaryRequestLifetime(),calls:string[]=[];
  installOrdinaryRequestLifetime(app,lifetime);
  if(opts.rate)await app.register(rateLimit,{max:opts.rate,timeWindow:'1 minute'});
  app.addHook('onRequest',parentHook(opts.readOnly??false));
  registerBaseWireCrmRoutes(app,{available:true,readOnly:opts.readOnly??false,requestLifetime:lifetime,
    authenticate:async()=>{calls.push('auth');if(opts.authFailure)throw new Problem(401,'private credential detail: permission denied for table api_keys');
      return{id:uid(1),tenant_id:uid(2),role:'admin',api_key_id:uid(3),scopes:['crm:read','crm:write']};},
    service:{execute:async()=>{calls.push('execute');return{clients:[]};},file:async()=>{calls.push('file');
      if(opts.fileFailure)throw new Problem(404,'private file path: relation crm_files');return{bytes:Buffer.from('owned'),title:'owned.txt',mime_type:'text/plain'};}} as any});
  // Same fallback distinction as buildApp with dist: unknown non-api URLs are
  // HTML. No static file or actual dist is created by this component test.
  app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api')
    ?reply.code(404).send({status:404,detail:'unknown'}):reply.type('text/html').send('<html>SPA fallback</html>'));
  const request=(payload=form)=>app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'closed-key'},payload});
  return{app,lifetime,calls,request};
}
async function idle(h:Awaited<ReturnType<typeof fixture>>) {
  await new Promise<void>(r=>setImmediate(r));
  const state=inspectOrdinaryRequests(h.lifetime);assert.equal(state.active_requests,0);assert.equal(state.active_tasks,0);
}
function error(r:any,status:number) {
  assert.equal(r.statusCode,status,r.body);const d=r.json();assert.equal(d.status,'ERROR');
  assert.deepEqual(Object.keys(d).sort(),['error_code','error_message','status']);
  assert.equal(r.headers['cache-control'],'private, no-store');
  assert.equal(r.headers['x-content-type-options'],'nosniff');
  assert(!/private|SELECT|closed-key/.test(r.body));
}
async function drained(h:Awaited<ReturnType<typeof fixture>>) {
  beginOrdinaryShutdown(h.lifetime);
  const result=await Promise.race([drainOrdinaryRequests(h.lifetime),
    new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('leaked request blocks shutdown')),250);timer.unref();})]);
  assert.equal(result.active_requests,0);assert.equal(result.active_tasks,0);
}
test('all unsupported connector methods produce405 JSON/AllowPOST instead of parent SPA and release every request',async t=>{
  const h=await fixture();t.after(()=>h.app.close());
  for(const method of ['GET','HEAD','PUT','PATCH','DELETE','OPTIONS','TRACE'] as const) {
    if(!h.app.supportedMethods.includes(method))continue;
    const r=await h.app.inject({method:method as any,url:'/connector.php'});
    assert.equal(r.statusCode,405);assert.equal(r.headers.allow,'POST');
    assert.equal(r.headers['content-type'],'application/json; charset=utf-8');
    if(method!=='HEAD')error(r,405);await idle(h);
  }
  assert.deepEqual(h.calls,[]);assert.equal((await h.app.inject('/ordinary-spa-path')).statusCode,200);await idle(h);await drained(h);
});
test('child file authorization and lookup errors finalize lifecycle and do not consume bounded admission slots',async t=>{
  for(const mode of ['authFailure','fileFailure'] as const) {
    const h=await fixture({[mode]:true});t.after(()=>h.app.close());
    for(let i=0;i<130;i++){
      // Refused authentication never reaches the tenant bucket; failed lookups count against it like POST (SEC-013).
      error(await h.app.inject({method:'GET',url:'/connector.php/files/clients/1/fields/1',headers:{'x-bltoken':'closed-key'}}),mode==='authFailure'?401:i<100?404:429);
      await idle(h);
    }
    await drained(h);
  }
});
test('parser415/413 and inherited rate429 retain safe envelope and release lifetime slots',async t=>{
  const h=await fixture();t.after(()=>h.app.close());
  error(await h.app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/octet-stream'},payload:'raw'}),415);await idle(h);
  error(await h.request('x'.repeat(4*1024*1024+1)),413);await idle(h);assert.deepEqual(h.calls,[]);await drained(h);
  const limited=await fixture({rate:1});t.after(()=>limited.app.close());
  assert.equal((await limited.request()).statusCode,200);await idle(limited);
  error(await limited.request(),429);await idle(limited);assert.deepEqual(limited.calls,['auth','execute']);await drained(limited);
});
test('readonly parent hook still allows connector reads but child refuses write before authentication/domain',async t=>{
  const h=await fixture({readOnly:true});t.after(()=>h.app.close());
  assert.equal((await h.request()).json().status,'SUCCESS');await idle(h);
  assert.equal((await h.request(new URLSearchParams({method:'getCrmClientExtraFields',parameters:'{}'}).toString())).json().status,'SUCCESS');await idle(h);
  const before=h.calls.slice();
  for(const [method,parameters]of [['addCrmClient',{login:'must not write'}],['deleteCrmClient',{crm_client_id:1}]] as const)
    error(await h.request(new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString()),423);
  assert.deepEqual(h.calls,before);await idle(h);await drained(h);
});
test('admission refusal during shutdown has no token to finalize and still returns bounded wire503 envelope',async t=>{
  const h=await fixture();t.after(()=>h.app.close());
  await h.app.ready();beginOrdinaryShutdown(h.lifetime);
  error(await h.request(),503);assert.deepEqual(h.calls,[]);await idle(h);await drained(h);
});
