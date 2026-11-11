/** Actual Fastify wire child, dispatcher, rate-limit and request lifetime.
 * Credential/domain ports are closed; no PostgreSQL, listener or219 acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { registerBaseWireCrmRoutes } from '../server/base-wire-crm-routes';
import { createBaseWireCrmDispatch, BASE_WIRE_CRM_DISPATCH_METHODS, baseWireCrmDispatchScope } from '../server/base-wire-crm-dispatch';
import { BASE_WIRE_CRM_METHODS } from '../server/base-wire-crm';
import { BASE_WIRE_CRM_DICTIONARY_METHODS } from '../server/base-wire-crm-dictionaries';
import type { Actor } from '../server/domain';
import type { BaseWireJson } from '../server/base-wire-codec';
import { Problem } from '../server/errors';
import { createOrdinaryRequestLifetime, installOrdinaryRequestLifetime, inspectOrdinaryRequests,
  beginOrdinaryShutdown, drainOrdinaryRequests } from '../server/ordinary-request-lifetime';

const uid=(n:number)=>`85000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const dictionaryWrites=['addCrmClientStatusGroup','addCrmClientStatus','deleteCrmClientStatusGroup','deleteCrmClientStatus'];
const payloads:Record<string,Record<string,BaseWireJson>>={
  addCrmClient:{crm_client_id:11}, getCrmClientData:{crm_client_id:11,login:'Łódź'},
  getCrmClients:{clients:[{crm_client_id:11}]}, deleteCrmClient:{}, getCrmClientExtraFields:{extra_fields:[]},
  getCrmClientStatusGroups:{status_groups:[{group_id:21,name:'Main'}]},
  getCrmClientStatuses:{statuses:[{status_id:31,name:'New'}]},
  addCrmClientStatusGroup:{group_id:22},addCrmClientStatus:{status_id:32},
  deleteCrmClientStatusGroup:{},deleteCrmClientStatus:{},
};
async function fixture(options:{dictionaryAvailable?:boolean;readOnly?:boolean;available?:boolean;failure?:Problem}={}) {
  const app=Fastify(),lifetime=createOrdinaryRequestLifetime();installOrdinaryRequestLifetime(app,lifetime);
  await app.register(rateLimit,{max:600,timeWindow:60000});
  const authenticated:{token:string;scope:string}[]=[],calls:{kind:string;actor:Actor;method:string;parameters:unknown;options:unknown}[]=[],files:{actor:Actor;clientId:number;fieldId:number}[]=[];
  const file={title:'owned Łódź.csv',mime_type:'application/octet-stream',bytes:Buffer.from([0,255,44,10])};
  const invoke=async(kind:string,actor:Actor,method:string,parameters:Record<string,BaseWireJson>,settings:unknown)=>{
    calls.push({kind,actor,method,parameters,options:settings});if(options.failure)throw options.failure;
    return structuredClone(payloads[method]);
  };
  // Keep dictionary capability true in the inner dispatcher: the route's
  // independent startup gate must refuse before even authenticating/delegating.
  const service=createBaseWireCrmDispatch({crm218Verified:true,dictionary219Verified:true,readOnly:options.readOnly??false},{
    clients:{execute:(actor,method,parameters,settings)=>invoke('clients',actor,method,parameters,settings),
      file:async(actor,clientId,fieldId)=>{files.push({actor,clientId,fieldId});return file;}},
    dictionaries:{execute:(actor,method,parameters,settings)=>invoke('dictionaries',actor,method,parameters,settings)},
  });
  const selected={available:options.available??true,readOnly:options.readOnly??false,service,requestLifetime:lifetime,
    ...(Object.hasOwn(options,'dictionaryAvailable')?{dictionaryAvailable:options.dictionaryAvailable}:{}),
    authenticate:async(token:string,scope:'crm:read'|'crm:write')=>{
      authenticated.push({token,scope});const match=/^closed-([12])-([ab])$/.exec(token);
      if(!match)throw new Problem(401,'private credential detail: permission denied for table api_keys');
      return{id:uid(10+Number(match[1])),tenant_id:uid(Number(match[1])),role:'admin' as const,
        api_key_id:uid(20+2*Number(match[1])+(match[2]==='b'?1:0)),scopes:['crm:read','crm:write']};
    }};
  registerBaseWireCrmRoutes(app,selected);
  const request=(method='getCrmClients',parameters:Record<string,BaseWireJson>={},headers:Record<string,string>={})=>app.inject({
    method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'closed-1-a',...headers},
    payload:new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString(),
  });
  const readFile=(token='closed-1-a')=>app.inject({method:'GET',url:'/connector.php/files/clients/11/fields/41',headers:{'x-bltoken':token}});
  return{app,lifetime,selected,authenticated,calls,files,file,request,readFile};
}
function envelope(response:any,status:number,payload?:Record<string,BaseWireJson>) {
  assert.equal(response.statusCode,status,response.body);
  assert.equal(response.headers['content-type'],'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'],'private, no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
  const body=response.json();
  if(status===200)assert.deepEqual(body,{status:'SUCCESS',...payload});
  else{
    assert.equal(body.status,'ERROR');assert.deepEqual(Object.keys(body).sort(),['error_code','error_message','status']);
    assert(!/closed-|85000000|private|SELECT|stack/.test(response.body));
  }
  return body;
}
async function idle(h:Awaited<ReturnType<typeof fixture>>) {
  await new Promise<void>(resolve=>setImmediate(resolve));
  const state=inspectOrdinaryRequests(h.lifetime);assert.equal(state.active_requests,0);assert.equal(state.active_tasks,0);
}

test('dictionary capability defaults false and rejects all six before auth, service or tenant quota',async t=>{
  const h=await fixture();t.after(()=>h.app.close());
  for(let i=0;i<120;i++)envelope(await h.request(BASE_WIRE_CRM_DICTIONARY_METHODS[i%6],{dictionaryAvailable:true},{'x-bltoken':'invalid'}),503);
  assert.deepEqual(h.authenticated,[]);assert.deepEqual(h.calls,[]);assert.deepEqual(h.files,[]);await idle(h);
  for(let i=0;i<100;i++)envelope(await h.request(),200,payloads.getCrmClients);
  envelope(await h.request(),429);assert.equal(h.calls.length,100);await idle(h);
  for(const value of [false,null,'true',1]){
    const refused=await fixture({dictionaryAvailable:value as any});t.after(()=>refused.app.close());
    for(const method of BASE_WIRE_CRM_DICTIONARY_METHODS)envelope(await refused.request(method),503);
    assert.deepEqual(refused.authenticated,[]);assert.deepEqual(refused.calls,[]);await idle(refused);
  }
});

test('enabled six methods use the actual dispatch scope, SUCCESS envelope and original actor/options',async t=>{
  const h=await fixture({dictionaryAvailable:true});t.after(()=>h.app.close());
  for(const method of BASE_WIRE_CRM_DICTIONARY_METHODS){
    const parameters={name:'Original Łódź'},clientKey=uid(90);
    envelope(await h.request(method,parameters,{'idempotency-key':clientKey}),200,payloads[method]);
    assert.equal(h.authenticated.at(-1)?.scope,baseWireCrmDispatchScope(method));
    assert.deepEqual(h.calls.at(-1),{kind:'dictionaries',actor:{tenantId:uid(1),userId:uid(11),role:'admin',apiKeyId:uid(22),source:'api'},method,parameters,options:{clientKey}});
  }
  // Later mutation of route options cannot activate/deactivate a startup snapshot.
  h.selected.dictionaryAvailable=false;
  envelope(await h.request('getCrmClientStatuses'),200,payloads.getCrmClientStatuses);await idle(h);
});

test('readonly rejects four dictionary writes before auth and keeps both dictionary reads',async t=>{
  for(const dictionaryAvailable of [false,true]){
    const h=await fixture({dictionaryAvailable,readOnly:true});t.after(()=>h.app.close());
    for(const method of dictionaryWrites)envelope(await h.request(method),423);
    assert.deepEqual(h.authenticated,[]);assert.deepEqual(h.calls,[]);
    for(const method of ['getCrmClientStatusGroups','getCrmClientStatuses'])
      envelope(await h.request(method),dictionaryAvailable?200:503,dictionaryAvailable?payloads[method]:undefined);
    await idle(h);
  }
});

test('all eleven methods, two keys and the file route share one tenant bucket; another tenant remains independent',async t=>{
  const h=await fixture({dictionaryAvailable:true});t.after(()=>h.app.close());
  for(let i=0;i<100;i++){
    const method=BASE_WIRE_CRM_DISPATCH_METHODS[i%11];
    envelope(await h.request(method,{}, {'x-bltoken':`closed-1-${i%2?'a':'b'}`}),200,payloads[method]);
  }
  for(const method of ['getCrmClients','getCrmClientStatuses']){
    const response=await h.request(method);envelope(response,429);
    assert.equal(Number(response.headers['x-ratelimit-limit']),100);assert(Number(response.headers['retry-after'])>=1);
  }
  assert.equal(h.calls.length,100);assert.equal(new Set(h.calls.map(c=>c.method)).size,11);
  envelope(await h.request('getCrmClientStatuses',{}, {'x-bltoken':'closed-2-a'}),200,payloads.getCrmClientStatuses);
  // SEC-013: the attachment GET takes the same tenant bucket (it used to bypass it).
  const limited=await h.readFile();envelope(limited,429);assert.equal(Number(limited.headers['x-ratelimit-limit']),100);assert.equal(h.files.length,0);
  const file=await h.readFile('closed-2-a');assert.equal(file.statusCode,200);assert.deepEqual(file.rawPayload,h.file.bytes);
  assert.equal(h.files.length,1);assert.equal(h.authenticated.at(-1)?.scope,'crm:read');await idle(h);
});

test('legacy five methods and binary file contract are unchanged when dictionaries are absent',async t=>{
  const h=await fixture({dictionaryAvailable:false});t.after(()=>h.app.close());
  for(const method of BASE_WIRE_CRM_METHODS)envelope(await h.request(method),200,payloads[method]);
  assert(h.calls.every(c=>c.kind==='clients'));
  const file=await h.readFile();assert.equal(file.statusCode,200);assert.deepEqual(file.rawPayload,h.file.bytes);
  assert.equal(file.headers['content-type'],h.file.mime_type);assert.equal(file.headers['cache-control'],'private, no-store');
  assert.equal(file.headers['x-content-type-options'],'nosniff');
  assert.equal(file.headers['content-disposition'],"attachment; filename*=UTF-8''"+encodeURIComponent(h.file.title));
  assert.deepEqual(h.files[0],{actor:{tenantId:uid(1),userId:uid(11),role:'admin',apiKeyId:uid(22),source:'api'},clientId:11,fieldId:41});
  await idle(h);beginOrdinaryShutdown(h.lifetime);assert.equal((await drainOrdinaryRequests(h.lifetime)).active_tasks,0);
});

test('enabled dictionaries preserve token/workspace validation, unknown-method refusal and safe service errors',async t=>{
  const h=await fixture({dictionaryAvailable:true});t.after(()=>h.app.close());
  envelope(await h.request('getCrmClientStatuses',{}, {'x-bltoken':'invalid'}),401);
  envelope(await h.request('getCrmClientStatuses',{}, {'x-workspace-id':uid(2)}),409);
  envelope(await h.request('getCrmClientStatuses',{}, {'idempotency-key':'invalid'}),422);
  const count=h.authenticated.length;
  envelope(await h.request('unsupported'),400);assert.equal(h.authenticated.length,count);assert.deepEqual(h.calls,[]);
  await idle(h);
  const failure=await fixture({dictionaryAvailable:true,failure:new Problem(503,'private SQL detail')});t.after(()=>failure.app.close());
  const error=envelope(await failure.request('addCrmClientStatusGroup'),503);
  assert.equal(error.error_code,'LOCAL_BASE_WIRE_OUTCOME_UNCONFIRMED');await idle(failure);
  const absent=await fixture({dictionaryAvailable:true,available:false});t.after(()=>absent.app.close());
  envelope(await absent.request('getCrmClientStatuses'),503);assert.deepEqual(absent.authenticated,[]);assert.deepEqual(absent.calls,[]);
});
