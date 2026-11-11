/** Actual connector.php family registry + rate-limit plugin with closed ports.
 * The second family is a test-only dummy (the real inventory family has its own tests).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { baseWireError, baseWireSafeReason, createBaseWireFamilyRegistry, registerBaseWireRoutes, type BaseWireFamily } from '../server/base-wire-routes';
import { z } from 'zod';
import { createBaseWireCrmFamily } from '../server/base-wire-crm-routes';
import { BASE_WIRE_CRM_DISPATCH_METHODS } from '../server/base-wire-crm-dispatch';
import { Problem, ensure } from '../server/errors';
import { createOrdinaryRequestLifetime, installOrdinaryRequestLifetime, inspectOrdinaryRequests } from '../server/ordinary-request-lifetime';
const uid=(n:number)=>`71000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const orderScopes={getOrders:'orders:read',setOrderStatus:'orders:write',getInventoryProductsStock:'inventory:read'} as const;
type OrderMethod=keyof typeof orderScopes;
function dummy(calls:{family:string;method:string}[],overrides:Partial<BaseWireFamily>={}):BaseWireFamily {
  return {label:'zamówień',methods:Object.keys(orderScopes),scope:m=>orderScopes[m as OrderMethod],isWrite:m=>m==='setOrderStatus',available:true,
    service:{execute:async(_actor,method)=>{calls.push({family:'orders',method});return {orders:[]};}},...overrides};
}
async function fixture(options:{readOnly?:boolean;orders?:Partial<BaseWireFamily>}={}) {
  const app=Fastify(),lifetime=createOrdinaryRequestLifetime(),calls:{family:string;method:string}[]=[],authenticated:{token:string;scope:string}[]=[];
  installOrdinaryRequestLifetime(app,lifetime);await app.register(rateLimit,{max:600,timeWindow:60000});
  const crm=createBaseWireCrmFamily({available:true,dictionaryAvailable:true,service:{
    execute:async(_actor,method)=>{calls.push({family:'crm',method});return {clients:[]};},file:async()=>assert.fail('No file route here')}});
  registerBaseWireRoutes(app,{readOnly:options.readOnly??false,requestLifetime:lifetime,families:[crm,dummy(calls,options.orders)],
    authenticate:async(token,scope)=>{
      authenticated.push({token,scope});const m=/^closed-([1-9])$/.exec(token);if(!m)throw new Problem(401,'private credential detail: permission denied for table api_keys');
      return {id:uid(10+Number(m[1])),tenant_id:uid(Number(m[1])),role:'admin',api_key_id:uid(20+Number(m[1])),scopes:[scope]};
    }});
  const request=(method:string,tenant=1,parameters:Record<string,unknown>={page:1})=>app.inject({method:'POST',url:'/connector.php',
    headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':`closed-${tenant}`},
    payload:new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString()});
  return {app,lifetime,calls,authenticated,request};
}
function refused(r:any,status:number,code?:string) {
  assert.equal(r.statusCode,status,r.body);const body=r.json();assert.equal(body.status,'ERROR');
  assert.deepEqual(Object.keys(body).sort(),['error_code','error_message','status']);
  if(code)assert.equal(body.error_code,code);
  assert.equal(r.headers['cache-control'],'private, no-store');assert(!/private|closed-/.test(r.body));
  return body;
}
async function idle(h:Awaited<ReturnType<typeof fixture>>) {
  await new Promise<void>(r=>setImmediate(r));assert.equal(inspectOrdinaryRequests(h.lifetime).active_requests,0);
}

test('4xx Problems carry the safe Polish reason; validation, raw internal text and every 5xx stay generic',async t=>{
  const message=(error:unknown,writing=false)=>JSON.parse(baseWireError(error,writing,'magazynu').body.toString());
  assert.deepEqual(message(new Problem(422,'Podaj stan najwyżej w jednym magazynie katalogu')),
    {status:'ERROR',error_code:'LOCAL_BASE_WIRE_422',error_message:'Podaj stan najwyżej w jednym magazynie katalogu'});
  assert.deepEqual(message(new Problem(422,'Pole nie jest obsługiwane lokalnie','LOCAL_BASE_WIRE_UNSUPPORTED_FIELD')),
    {status:'ERROR',error_code:'LOCAL_BASE_WIRE_UNSUPPORTED_FIELD',error_message:'Pole nie jest obsługiwane lokalnie'});
  assert.equal(message(new Problem(409,'Za mało towaru: A-1.\nDostępne: 2')).error_message,'Za mało towaru: A-1. Dostępne: 2');
  assert.equal(message(new Problem(409,'x'.repeat(400))).error_message.length,300);
  // Raw PostgreSQL/driver text, identifiers and credentials are never a reason.
  for(const raw of ['duplicate key value violates unique constraint "products_tenant_id_sku_key"','new row for relation "stock" violates check constraint "stock_check"',
    'permission denied for table api_keys','Nie znaleziono 72000000-0000-4000-8000-000000000051','Klucz dyna_api_'+'a'.repeat(64),'','  '])
    assert.equal(message(new Problem(409,raw)).error_message,'Żądanie magazynu odrzucone.',raw);
  assert.equal(baseWireSafeReason('Stan zmieniaj metodą updateInventoryProductsStock'),'Stan zmieniaj metodą updateInventoryProductsStock');
  // Zod messages are English/structural: generic. Fastify 4xx: generic.
  assert.equal(message(z.object({a:z.number()}).safeParse({a:'x'}).error).error_message,'Żądanie magazynu odrzucone.');
  assert.equal(message(Object.assign(Error('Body cannot be empty when content-type is set'),{statusCode:400})).error_message,'Żądanie magazynu odrzucone.');
  // 5xx: generic and unconfirmed for writes, even for a Polish Problem.
  assert.deepEqual(message(new Problem(503,'Moduł Base magazynu jest niedostępny'),true),
    {status:'ERROR',error_code:'LOCAL_BASE_WIRE_OUTCOME_UNCONFIRMED',error_message:'Operacja nie została potwierdzona. Nie ponawiaj automatycznie.'});
  assert.deepEqual(message(Error('private SQL detail')),{status:'ERROR',error_code:'LOCAL_BASE_WIRE_500',error_message:'Operacja nie została potwierdzona. Nie ponawiaj automatycznie.'});
  // Over the wire: a family refusal reaches the integrator with its reason.
  const h=await fixture({orders:{service:{execute:async()=>{throw new Problem(422,'Podaj cenę w grupie podstawowej');}}}});t.after(()=>h.app.close());
  assert.equal(refused(await h.request('getOrders'),422,'LOCAL_BASE_WIRE_422').error_message,'Podaj cenę w grupie podstawowej');
  await idle(h);
});

test('registry refuses duplicate method names across and within families at startup',()=>{
  const calls:{family:string;method:string}[]=[];
  const crm=createBaseWireCrmFamily({available:true,service:{execute:async()=>({}),file:async()=>assert.fail()}});
  const clash=dummy(calls,{methods:['getOrders',BASE_WIRE_CRM_DISPATCH_METHODS[0]]});
  assert.throws(()=>createBaseWireFamilyRegistry([crm,clash]),(e:any)=>e instanceof Problem&&e.status===503);
  assert.throws(()=>createBaseWireFamilyRegistry([dummy(calls,{methods:['getOrders','getOrders']})]),(e:any)=>e.status===503);
  assert.throws(()=>createBaseWireFamilyRegistry([]),(e:any)=>e.status===503);
  assert.throws(()=>createBaseWireFamilyRegistry([dummy(calls,{methods:[]})]),(e:any)=>e.status===503);
  // Fails synchronously, before Fastify registers a second connector.php child.
  assert.throws(()=>registerBaseWireRoutes(Fastify(),{readOnly:false,families:[crm,clash],authenticate:async()=>assert.fail()}),(e:any)=>e.status===503);
  const registry=createBaseWireFamilyRegistry([crm,dummy(calls)]);
  assert.deepEqual([...registry.methods],[...BASE_WIRE_CRM_DISPATCH_METHODS,...Object.keys(orderScopes)]);
  assert(Object.isFrozen(registry.methods));assert.equal(registry.family('getOrders').label,'zamówień');assert.equal(registry.family('getCrmClients'),crm);
  assert.throws(()=>registry.family('getOrdersX'),(e:any)=>e.status===400&&e.code==='LOCAL_BASE_WIRE_METHOD');
});

test('unknown method is LOCAL_BASE_WIRE_METHOD before authentication or any family',async t=>{
  const h=await fixture();t.after(()=>h.app.close());
  for(const method of ['getOrdersX','getcrmclients','addOrder'])refused(await h.request(method),400,'LOCAL_BASE_WIRE_METHOD');
  assert.deepEqual(h.authenticated,[]);assert.deepEqual(h.calls,[]);await idle(h);
});

test('each method authenticates with its own family scope and dispatches to that family only',async t=>{
  const h=await fixture();t.after(()=>h.app.close());
  for(const [method,scope] of [...Object.entries(orderScopes),['getCrmClients','crm:read'],['addCrmClient','crm:write']] as const){
    const r=await h.request(method,1,method==='addCrmClient'?{login:'closed-test'}:{page:1});assert.equal(r.statusCode,200,r.body);
    assert.equal(h.authenticated.at(-1)?.scope,scope);
    assert.deepEqual(h.calls.at(-1),{family:method.includes('Crm')?'crm':'orders',method});
  }
  await idle(h);
});

test('availability, admission and read-only are decided per family before authentication',async t=>{
  const h=await fixture({orders:{available:false}});t.after(()=>h.app.close());
  assert.equal(refused(await h.request('getOrders'),503).error_message,'Operacja nie została potwierdzona. Nie ponawiaj automatycznie.');
  assert.deepEqual(h.authenticated,[]);assert.equal((await h.request('getCrmClients')).statusCode,200);
  const r=await fixture({readOnly:true,orders:{admit:m=>ensure(m!=='getInventoryProductsStock',503,'closed capability')}});t.after(()=>r.app.close());
  // A 4xx Problem carries its Polish reason (N28: integrators need an actionable reason).
  assert.equal(refused(await r.request('setOrderStatus'),423,'LOCAL_BASE_WIRE_423').error_message,'Podgląd kopii jest tylko do odczytu');
  assert.equal(refused(await r.request('addCrmClient',1,{login:'x'}),423).error_message,'Podgląd kopii jest tylko do odczytu');
  refused(await r.request('getInventoryProductsStock'),503);
  assert.deepEqual(r.authenticated,[]);assert.equal((await r.request('getOrders')).statusCode,200);
  await idle(h);await idle(r);
});

test('one 100/min tenant quota is shared across CRM and a second family',async t=>{
  const h=await fixture();t.after(()=>h.app.close());
  for(let i=0;i<100;i++)assert.equal((await h.request(i%2?'getOrders':'getCrmClients')).statusCode,200);
  for(const method of ['getCrmClients','getOrders','getInventoryProductsStock']){
    const r=await h.request(method);refused(r,429,'LOCAL_BASE_WIRE_RATE_LIMIT');assert.equal(Number(r.headers['x-ratelimit-limit']),100);
  }
  assert.equal(h.calls.length,100);assert.equal(h.calls.filter(c=>c.family==='orders').length,50);
  assert.equal((await h.request('getOrders',2)).statusCode,200);await idle(h);
});

// Actual authenticateBaseWireApiKey source on closed credential/SQL ports.
const source=readFileSync(new URL('../server/developer-api.ts',import.meta.url),'utf8');
const helper=source.indexOf('export function baseWireRequiredScopes'),from=source.indexOf('export async function authenticateBaseWireApiKey'),to=source.indexOf('export async function authenticateApiKey(',from);
assert(helper>0&&from>helper&&to>from);
const authCode=transformSync(source.slice(helper,to).replace('export function','function').replace('export async function','async function'),{loader:'ts',format:'cjs'}).code;
function auth(ordinary:string[],crm:string[]) {
  const queries:string[]=[];
  const pool={query:async(sql:string)=>{queries.push(sql);return {rows:crm.map(scope=>({scope}))};}};
  const loadDeveloperApiCredential=async()=>({id:uid(1),tenant_id:uid(2),api_key_id:uid(3),role:'admin',scopes:[...ordinary]});
  const apiScopes=['crm:read','crm:write','orders:read','orders:write','inventory:read','inventory:write'];
  const fn=new Function('ensure','pool','loadDeveloperApiCredential','apiScopes','isCrmScope',authCode+';return authenticateBaseWireApiKey;')(
    ensure,pool,loadDeveloperApiCredential,apiScopes,(v:string)=>v==='crm:read'||v==='crm:write');
  return {queries,call:(scope:string)=>fn('dyna_api_closed',scope,true)};
}
const forbidden=(e:any)=>e instanceof Problem&&e.status===403;
test('generalised Base wire auth: ordinary scopes from api_keys only, crm:* keeps its 218 rules',async()=>{
  let a=auth(['orders:read'],[]);
  assert.deepEqual((await a.call('orders:read')).scopes,['orders:read']);
  await assert.rejects(a.call('orders:write'),forbidden);await assert.rejects(a.call('inventory:read'),forbidden);
  await assert.rejects(a.call('admin:all'),forbidden);
  // A non-CRM family never touches base_wire218_key_scopes (may be absent without 218).
  assert.deepEqual(a.queries,[]);
  a=auth(['orders:read'],['crm:read']);
  assert.deepEqual((await a.call('crm:read')).scopes,['orders:read','crm:read']);await assert.rejects(a.call('crm:write'),forbidden);
  assert.equal(a.queries.length,2);assert(a.queries.every(sql=>sql.includes('base_wire218_key_scopes')));
  // crm:write still requires crm:read; CRM grants never satisfy an ordinary scope.
  await assert.rejects(auth(['orders:read'],['crm:write']).call('crm:write'),forbidden);
  await assert.rejects(auth(['orders:read'],['crm:read','crm:write']).call('orders:write'),forbidden);
  assert.deepEqual((await auth(['orders:read'],['crm:read','crm:write']).call('crm:write')).scopes,['orders:read','crm:read','crm:write']);
  // Every ordinary family write also requires its read scope (inventory:write needs inventory:read).
  await assert.rejects(auth(['inventory:write'],[]).call('inventory:write'),forbidden);
  await assert.rejects(auth(['orders:write'],[]).call('orders:write'),forbidden);
  assert.deepEqual((await auth(['inventory:read','inventory:write'],[]).call('inventory:write')).scopes,['inventory:read','inventory:write']);
  assert.deepEqual((await auth(['inventory:read'],[]).call('inventory:read')).scopes,['inventory:read']);
});
