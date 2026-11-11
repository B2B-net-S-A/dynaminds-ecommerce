/** Actual adapter + actual CRM business port + codec on CLOSED transaction/query ports.
 * Real migration/RLS checks are separate in base-wire-crm.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { transformSync } from 'esbuild';
import { z, ZodError } from 'zod';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import * as requestLifetime from '../server/ordinary-request-lifetime';
import * as wireDispatch from '../server/base-wire-crm-dispatch';
import * as wireDictionaries from '../server/base-wire-crm-dictionaries';
import { ensure, Problem } from '../server/errors';
const uid=(n:number)=>`31000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function load(name:string,ports:Record<string,any>) {
  const module={exports:{} as any};
  new Function('require','module','exports',transformSync(readFileSync(new URL('../server/'+name,import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'node24'}).code)(
    (key:string)=>{ assert(Object.hasOwn(ports,key),'Unexpected import '+key); return ports[key]; },module,module.exports);
  return module.exports;
}
const schema=load('crm-schema.ts',{zod:{z}});
const authority=load('base-wire-crm-authority.ts',{'./errors':{ensure}});
const codec=load('base-wire-codec.ts',{zod:{z},'./errors':{Problem}});
const adapter=load('base-wire-crm.ts',{'node:crypto':crypto,zod:{z},'./errors':{ensure},'./crm-schema':schema,'./base-wire-codec':codec,'./base-wire-crm-authority':authority});
function fixture() {
  const tenants=[uid(1),uid(2)], users=[uid(3),uid(4)];
  const actors=tenants.map((tenantId,i)=>({tenantId,userId:users[i],role:'admin',source:'api',apiKeyId:uid(i+5)}));
  const s:any={clients:[],commands:[],maps:[],audits:[],roles:{[users[0]]:'admin',[users[1]]:'admin'},revoked:[],extra:[],definitions:[],files:[],orders:[],orderLinks:[],scopes:Object.fromEntries(actors.map(a=>[a.apiKeyId,['crm:read','crm:write']]))};
  // Closed crypto port: opaque handles only. This tests custody/DTO translation,
  // not cryptographic strength or the real application key store.
  const vault=new Map<string,unknown>();
  const security={encrypt:(value:unknown)=>{const token='closed-cipher-'+crypto.randomUUID();vault.set(token,structuredClone(value));return token;},
    decrypt:(token:string)=>{assert(vault.has(token),'Only this fixture owns ciphertext');return structuredClone(vault.get(token)) as any;}};
  for(let i=0;i<2;i++)s.maps.push({kind:'status',tenant_id:tenants[i],local_id:uid(i+7),public_id:String(i+1)});
  let next=100, tenant='',reading=false;
  const queries:{sql:string;args:any[];reading:boolean}[]=[];
  const out=(rows:any[])=>({rows:structuredClone(rows),rowCount:rows.length});
  const own=(x:any)=>x.tenant_id===tenant;
  const c:any={query:async(sql:string,args:any[]=[])=>{
    queries.push({sql,args:structuredClone(args),reading});
    if(reading)assert(/^SELECT/.test(sql)&&!/FOR UPDATE|FOR SHARE|advisory/.test(sql),'Read must remain readonly without locks');
    if(sql.startsWith('SELECT public.base_wire218_authority')) {
      const actor=actors.find(a=>a.tenantId===tenant&&a.userId===args[0]&&a.apiKeyId===args[1]);
      const permitted=actor&&s.scopes[actor.apiKeyId]?.includes('crm:read')&&(!args[2]||s.scopes[actor.apiKeyId]?.includes('crm:write'));
      const role=actor&&permitted&&!s.revoked.includes(actor.apiKeyId)?s.roles[actor.userId]:null;
      return out([{role:args[2]&&role!=='admin'?null:role}]);
    }
    if(sql.includes('public.customer_message_role')||sql.includes('public.order_field_role'))return out([{role:s.roles[args[0]]}]);
    if(sql.startsWith('SELECT pg_advisory'))return out([]);
    const map=/FROM base_wire218_(client|status|field)_ids/.exec(sql);
    if(map){
      const rows=s.maps.filter((m:any)=>own(m)&&m.kind===map[1]&&m.tenant_id===args[0]&&
        (sql.startsWith('SELECT local_id')?m.public_id===String(args[1])&&m.local_id!==null:m.local_id===args[1]));
      return out(rows.map((r:any)=>sql.startsWith('SELECT local_id')?{local_id:r.local_id}:{public_id:r.public_id}));
    }
    if(sql.startsWith('SELECT * FROM crm_commands'))return out(s.commands.filter((x:any)=>own(x)&&x.client_key===args[0]));
    if(sql.startsWith('INSERT INTO crm_commands')){
      if(s.rejectJournalInsert||s.commands.some((x:any)=>own(x)&&x.client_key===args[1]))return out([]);
      s.commands.push({tenant_id:args[0],client_key:args[1],actor_id:args[2],request_hash:args[3],request:JSON.parse(args[4]),response:JSON.parse(args[5])});return out([{client_key:args[1]}]);
    }
    if(sql==='SELECT id FROM crm_statuses WHERE is_primary')return out([{id:s.maps.find((m:any)=>own(m)&&m.kind==='status').local_id}]);
    if(sql.startsWith('SELECT id FROM crm_statuses WHERE id='))return out(s.maps.filter((m:any)=>own(m)&&m.kind==='status'&&m.local_id===args[0]).map((m:any)=>({id:m.local_id})));
    if(sql.startsWith('SELECT * FROM crm_clients WHERE id='))return out(s.clients.filter((x:any)=>own(x)&&x.id===args[0]&&!x.deleted_at));
    if(sql.startsWith('INSERT INTO crm_clients')){
      const r={id:uid(next++),tenant_id:args[0],status_id:args[1],profile:JSON.parse(args[2]),version:1,created_at:'2026-10-19T00:00:00.000Z',updated_at:'2026-10-19T00:00:00.000Z',deleted_at:null};
      s.clients.push(r);s.maps.push({kind:'client',tenant_id:r.tenant_id,local_id:r.id,public_id:String(next++)});return out([r]);
    }
    if(sql.startsWith('UPDATE crm_clients SET profile=')){
      const r=s.clients.find((x:any)=>own(x)&&x.id===args[0]);Object.assign(r,{profile:JSON.parse(args[1]),status_id:args[2],version:r.version+1,updated_at:'2026-10-19T01:00:00.000Z'});return out([r]);
    }
    if(sql.startsWith('UPDATE crm_clients SET deleted_at=')){
      assert.equal(args.length,1);const r=s.clients.find((x:any)=>own(x)&&x.id===args[0]&&!x.deleted_at);assert(r);
      Object.assign(r,{deleted_at:'2026-10-19T02:00:00.000Z',updated_at:'2026-10-19T02:00:00.000Z',version:r.version+1});return out([]);
    }
    if(sql.startsWith('SELECT\n EXISTS(SELECT 1 FROM pg_catalog.pg_attribute')){
      assert(sql.includes("to_regclass('public.crm_extra_fields')")&&sql.includes(' AS archive_valid'));
      return out([{version_present:true,archive_present:true,version_valid:true,archive_valid:true}]);
    }
    if(sql.startsWith('SELECT id AS extra_field_id,name,editor_type,options,position,version'))return out(s.definitions.filter(own).sort((a:any,b:any)=>a.position-b.position||a.id.localeCompare(b.id)).map((r:any)=>({extra_field_id:r.id,name:r.name,editor_type:r.editor_type,options:r.options,position:r.position,version:r.version,archived:r.archived_at!==null})));
    if(sql.startsWith('SELECT * FROM crm_extra_fields WHERE id=ANY'))return out(s.definitions.filter((x:any)=>own(x)&&args[0].includes(x.id)).sort((a:any,b:any)=>a.id.localeCompare(b.id)));
    if(sql.startsWith('INSERT INTO crm_files')){
      assert.equal(args.length,10);s.files.push({id:args[0],tenant_id:args[1],client_id:args[2],field_id:args[3],actor_id:args[4],title:args[5],mime_type:args[6],byte_count:args[7],content_sha256:args[8],encrypted_bytes:args[9]});return out([]);
    }
    if(sql.startsWith('INSERT INTO crm_values')){
      const old=s.extra.find((x:any)=>own(x)&&x.client_id===args[1]&&x.field_id===args[2]);
      const value={tenant_id:args[0],client_id:args[1],field_id:args[2],editor_type:args[3],value:JSON.parse(args[4]),file_id:args[5]};
      if(old)Object.assign(old,value);else s.extra.push(value);return out([]);
    }
    if(sql.startsWith('DELETE FROM crm_values WHERE client_id=')){
      s.extra=s.extra.filter((x:any)=>!(own(x)&&x.client_id===args[0]&&x.field_id===args[1]));return out([]);
    }
    if(sql.startsWith('SELECT v.field_id'))return out(s.extra.filter((x:any)=>own(x)&&x.client_id===args[0]).map((x:any)=>({...x,title:s.files.find((f:any)=>own(f)&&f.id===x.file_id)?.title})));
    if(sql.startsWith('SELECT f.* FROM crm_files f JOIN crm_values'))return out(s.files.filter((f:any)=>own(f)&&f.client_id===args[0]&&f.field_id===args[1]&&s.extra.some((v:any)=>own(v)&&v.client_id===f.client_id&&v.field_id===f.field_id&&v.file_id===f.id)));
    if(sql.startsWith('SELECT * FROM crm_clients WHERE deleted_at IS NULL')){
      assert(sql.includes('ORDER BY created_at DESC,id LIMIT'));
      let rows=s.clients.filter((x:any)=>own(x)&&!x.deleted_at&&(!args[0]||x.status_id===args[0])&&(!args[1]||x.id===args[1]));
      const filters=[...sql.matchAll(/profile->>'([a-z_]+)' ILIKE '%' \|\| \$(\d+) \|\| '%'/g)];
      for(const m of filters){const wanted=String(args[Number(m[2])-1]).replace(/\\([\\%_])/g,'$1').toLowerCase();rows=rows.filter((x:any)=>String(x.profile[m[1]]).toLowerCase().includes(wanted));}
      rows.sort((a:any,b:any)=>b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
      return out(rows.slice(args.at(-1),args.at(-1)+args.at(-2)));
    }
    assert.fail('Unhandled controlled query '+sql);
  }};
  const transaction=async(actor:any,writing:boolean,work:any)=>{
    const saved=structuredClone(s);tenant=actor.tenantId;reading=!writing;
    try{return await work(c);}catch(e){for(const key of Object.keys(s))delete s[key];Object.assign(s,saved);throw e;}finally{reading=false;}
  };
  const service=load('crm.ts',{'node:crypto':crypto,zod:{z},'./db':{
    tenantTx:(t:string,fn:any)=>transaction({tenantId:t},true,fn),tenantReadTx:(t:string,fn:any)=>transaction({tenantId:t},false,fn)},
    './domain':{audit:async(_c:any,a:any,action:any,id:any,detail:any)=>s.audits.push({tenant_id:a.tenantId,action,id,detail})},
    './security':security,'./errors':{ensure},'./crm-schema':schema,
    './crm-field-definitions':load('crm-field-definitions.ts',{zod:{z},'./errors':{ensure}}),
    './base-wire-crm-authority':authority});
  const wire=adapter.createBaseWireCrmService({transaction,authorize:authority.authorizeBaseWireCrmInTx,domain:service.createCrmClientWirePort});
  const call=(method:string,parameters:any,actor=actors[0],options:any={})=>wire.execute(actor,method,parameters,options);
  const localActor={tenantId:tenants[0],userId:users[0],role:'admin'};
  return {s,actors,localActor,c,queries,call,wire,service,transaction};
}
test('actual CRM domain is shared: native UI create→wire update→native detail retains omitted fields and numeric identity',async()=>{
  const f=fixture(), native=await f.service.executeCrmCommand(f.localActor,'POST','/api/crm/clients',{client_key:uid(20),login:'UI profile',phone:'123',email:'keep@example.test',notes:'retained',star:4});
  const list=await f.call('getCrmClients',{page:1}),id=list.clients[0].crm_client_id;
  assert(Number.isSafeInteger(id)&&id>0);
  assert(!Object.hasOwn(list.clients[0],'notes'));assert(!Object.hasOwn(list.clients[0],'custom_extra_fields'));
  const ack=await f.call('addCrmClient',{crm_client_id:id,phone:'',star:0});assert.deepEqual(ack,{crm_client_id:id});
  const shown=await f.service.getCrmClient(f.localActor,native.data.id,{});
  assert.equal(shown.data.phone,'');assert.equal(shown.data.star,0);assert.equal(shown.data.email,'keep@example.test');assert.equal(shown.data.notes,'retained');
  const detail=await f.call('getCrmClientData',{crm_client_id:id});
  assert.equal(detail.crm_client_id,id);assert.equal(detail.notes,'retained');assert(!Object.hasOwn(detail,'data'));assert(!Object.hasOwn(detail,'custom_extra_fields'));
});
test('wire create is visible to native UI domain; only explicit keyed creates reconcile, identical unkeyed requests are distinct',async()=>{
  const f=fixture(),body={login:'Created by wire'},a=await f.call('addCrmClient',body),b=await f.call('addCrmClient',body);
  assert.notEqual(a.crm_client_id,b.crm_client_id);assert.equal(f.s.clients.length,2);
  const key={clientKey:uid(30)},once=await f.call('addCrmClient',{login:'keyed'},undefined,key);
  assert.deepEqual(await f.call('addCrmClient',{login:'keyed'},undefined,key),once);
  await assert.rejects(f.call('addCrmClient',{login:'different original'},undefined,key));
  assert.equal((await f.service.getCrmClient(f.localActor,f.s.clients.at(-1).id,{})).data.login,'keyed');
});
test('keyed update reconciles historical original after its own CAS increment and later native UI edits',async()=>{
  const f=fixture(),id=(await f.call('addCrmClient',{login:'before',notes:'original'})).crm_client_id,key={clientKey:uid(31)};
  const original={crm_client_id:id,login:'wire edit'},ack=await f.call('addCrmClient',original,undefined,key);
  const local=f.s.clients[0];await f.service.executeCrmCommand(f.localActor,'PATCH','/api/crm/clients/'+local.id,{client_key:uid(32),version:local.version,notes:'later UI'});
  assert.deepEqual(await f.call('addCrmClient',original,undefined,key),ack);
  assert.equal(f.s.clients[0].profile.notes,'later UI');assert.equal(f.s.clients[0].version,3);
});
test('pagination100/page2, literal substring filters and detail extras opt-in execute real domain read path with zero allocations',async()=>{
  const f=fixture();for(let i=0;i<102;i++)await f.call('addCrmClient',{login:'matched-'+i,notes:'private'});
  await f.call('addCrmClient',{login:'matched-foreign'},f.actors[1]);
  const snapshot=structuredClone(f.s),cut=f.queries.length;
  const p1=(await f.call('getCrmClients',{page:1,filter_login:'matched-'})).clients;
  const p2=(await f.call('getCrmClients',{page:2,filter_login:'matched-'})).clients;
  assert.equal(p1.length,100);assert.equal(p2.length,2);assert.equal(new Set([...p1,...p2].map((r:any)=>r.crm_client_id)).size,102);
  for(const r of [...p1,...p2]){assert(!Object.hasOwn(r,'notes'));assert(!Object.hasOwn(r,'custom_extra_fields'));}
  const id=p1[0].crm_client_id,local=f.s.maps.find((m:any)=>m.kind==='client'&&m.public_id===String(id));
  const field=uid(50);f.s.maps.push({kind:'field',tenant_id:f.actors[0].tenantId,local_id:field,public_id:'9000'});
  f.s.extra.push({tenant_id:f.actors[0].tenantId,client_id:local.local_id,field_id:field,value:0,editor_type:'number'});
  const detail=await f.call('getCrmClientData',{crm_client_id:id,include_custom_extra_fields:true});assert.deepEqual(detail.custom_extra_fields,{'9000':0});
  assert(f.queries.slice(cut).every(q=>q.reading&&q.sql.startsWith('SELECT')));
  assert.deepEqual(f.s.clients,snapshot.clients);assert.deepEqual(f.s.commands,snapshot.commands);assert.deepEqual(f.s.audits,snapshot.audits);
  await f.call('addCrmClient',{login:'literal%_\\name'});
  assert.equal((await f.call('getCrmClients',{page:1,filter_login:'%_\\'})).clients.length,1);
});
test('foreign numeric resources and freshly revoked/downgraded credentials cannot mutate; ordinary REST retains session-only boundary',async()=>{
  const f=fixture(),id=(await f.call('addCrmClient',{login:'private'})).crm_client_id;
  const snapshot=structuredClone(f.s);
  await assert.rejects(f.call('getCrmClientData',{crm_client_id:id},f.actors[1]),(e:any)=>e.status===404);
  await assert.rejects(f.call('addCrmClient',{crm_client_id:id,login:'foreign'},f.actors[1]),(e:any)=>e.status===404);
  assert.deepEqual(f.s,snapshot);
  f.s.roles[f.actors[0].userId]='viewer';await f.call('getCrmClientData',{crm_client_id:id});
  await assert.rejects(f.call('addCrmClient',{crm_client_id:id,login:'stale cached admin'}),(e:any)=>e.status===403);
  f.s.revoked.push(f.actors[0].apiKeyId);await assert.rejects(f.call('getCrmClientData',{crm_client_id:id}),(e:any)=>e.status===403);
  await assert.rejects(f.service.getCrmClient(f.actors[0],f.s.clients[0].id,{}),(e:any)=>e.status===403);
});
test('authority proof cannot be forged, transferred to another connection/principal or upgraded from read to write',async()=>{
  const f=fixture();await f.transaction(f.actors[0],false,async(c:any)=>{
    const p=await authority.authorizeBaseWireCrmInTx(c,f.actors[0],false);
    assert.doesNotThrow(()=>f.service.createCrmClientWirePort(c,f.actors[0],p));
    await assert.rejects(f.service.createCrmClientWirePort(c,f.actors[0],p).save(null,{login:'no'},uid(90)),(e:any)=>e.status===403);
    await assert.rejects(f.service.createCrmClientWirePort(c,f.actors[0],p).remove(uid(100),uid(91),'not-a-write-proof'),(e:any)=>e.status===403);
    await assert.rejects(f.service.createCrmClientWirePort({},f.actors[0],p).detail(uid(100),false),(e:any)=>e.status===403);
    await assert.rejects(f.service.createCrmClientWirePort(c,f.actors[1],p).detail(uid(100),false),(e:any)=>e.status===403);
    await assert.rejects(f.service.createCrmClientWirePort(c,f.actors[0],{writing:true}).detail(uid(100),false),(e:any)=>e.status===403);
  });assert.equal(f.s.clients.length,0);
});
test('invalid IDs/pages/extras flags and missing backfill fail before DML, never allocate identities on GET',async()=>{
  const f=fixture();for(const id of [0,-1,1.2,'1',null,Number.MAX_SAFE_INTEGER+1])await assert.rejects(f.call('getCrmClientData',{crm_client_id:id}));
  for(const page of [0,-1,1.5,'2'])await assert.rejects(f.call('getCrmClients',{page}));
  await assert.rejects(f.call('getCrmClientData',{crm_client_id:1,include_custom_extra_fields:'true'}));assert.equal(f.queries.length,0);
  const id=(await f.call('addCrmClient',{login:'missing mapping'})).crm_client_id;
  f.s.maps=f.s.maps.filter((m:any)=>m.kind!=='status');const snapshot=structuredClone(f.s),cut=f.queries.length;
  await assert.rejects(f.call('getCrmClientData',{crm_client_id:id}),(e:any)=>e.status===503);
  assert.deepEqual(f.s,snapshot);assert(f.queries.slice(cut).every(q=>q.reading&&q.sql.startsWith('SELECT')));
});

function routeHarness(f:ReturnType<typeof fixture>, options:{readOnly?:boolean;available?:boolean;afterAuth?:()=>void}={}) {
  const shared=load('base-wire-routes.ts',{'@fastify/rate-limit':rateLimit,zod:{z,ZodError},'./errors':{Problem,ensure},
    './base-wire-codec':codec,'./ordinary-request-lifetime':requestLifetime});
  const routes=load('base-wire-crm-routes.ts',{'@fastify/rate-limit':rateLimit,zod:{z,ZodError},'./errors':{Problem,ensure},
    './base-wire-routes':shared,'./base-wire-crm':adapter,'./base-wire-crm-dispatch':wireDispatch,'./base-wire-crm-dictionaries':wireDictionaries,
    './base-wire-codec':codec,'./ordinary-request-lifetime':requestLifetime});
  const app=Fastify();
  routes.registerBaseWireCrmRoutes(app,{service:f.wire,available:options.available??true,readOnly:options.readOnly??false,
    authenticate:async(token:string,scope:string)=>{
      assert(['crm:read','crm:write'].includes(scope));
      ensure(token==='closed-own-key',401,'Token must never appear in error');
      const a=f.actors[0];ensure(f.s.scopes[a.apiKeyId]?.includes('crm:read')&&(scope!=='crm:write'||f.s.scopes[a.apiKeyId]?.includes('crm:write')),403,'Scope missing');
      options.afterAuth?.();
      return{id:a.userId,tenant_id:a.tenantId,role:a.role,api_key_id:a.apiKeyId,scopes:['crm:read','crm:write']};
    }});
  return {app,request:(method:string,parameters:any,headers:Record<string,string>={})=>app.inject({method:'POST',url:'/connector.php',
    headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'closed-own-key',...headers},
    payload:new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString()})};
}
function envelope(r:any,status:'SUCCESS'|'ERROR') {
  const body=r.json();assert.equal(body.status,status,r.body);
  assert.equal(r.headers['content-type'],'application/json; charset=utf-8');
  if(status==='ERROR'){
    assert.deepEqual(Object.keys(body).sort(),['error_code','error_message','status']);
    assert(!/closed-own-key|SELECT |stack|tenant_id|permission denied|private/.test(r.body));
  }
  return body;
}
test('actual registered Fastify form route dispatches through adapter and real CRM core, then native UI domain reads same profile',async t=>{
  const f=fixture(),h=routeHarness(f);t.after(()=>h.app.close());
  const made=envelope(await h.request('addCrmClient',{login:'HTTP form profile',phone:'+48 123',notes:'detail only'}),'SUCCESS');
  assert.deepEqual(Object.keys(made).sort(),['crm_client_id','status']);
  const r=await h.request('getCrmClientData',{crm_client_id:made.crm_client_id});
  const detail=envelope(r,'SUCCESS');assert.equal(detail.phone,'+48 123');assert.equal(detail.notes,'detail only');
  assert.equal(r.headers['cache-control'],'private, no-store');
  const shown=await f.service.getCrmClient(f.localActor,f.s.clients[0].id,{});assert.equal(shown.data.login,'HTTP form profile');
});
test('actual route refuses cookie-only/conflicting credentials and workspace mismatch before CRM access',async t=>{
  const f=fixture(),h=routeHarness(f);t.after(()=>h.app.close());
  const plain=new URLSearchParams({method:'getCrmClients',parameters:'{"page":1}'}).toString();
  envelope(await h.app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded',cookie:'ordinary-session=closed-own-key'},payload:plain}),'ERROR');
  envelope(await h.app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'closed-own-key'},
    payload:plain+'&token=conflicting-token'}),'ERROR');
  envelope(await h.request('getCrmClients',{page:1},{'x-workspace-id':f.actors[1].tenantId}),'ERROR');
  assert.equal(f.queries.length,0);
});
test('fresh in-transaction authorization defeats revocation after route authentication with no profile or receipt effect',async t=>{
  const f=fixture(),h=routeHarness(f,{afterAuth:()=>f.s.revoked.push(f.actors[0].apiKeyId)});t.after(()=>h.app.close());
  const r=await h.request('addCrmClient',{login:'late revoked'});envelope(r,'ERROR');assert.equal(r.statusCode,403);
  assert.equal(f.s.clients.length,0);assert.equal(f.s.commands.length,0);assert.equal(f.s.audits.length,0);
});
test('readonly/unavailable routes refuse writes, keep local reads, and retain codec ERROR envelope for malformed inputs',async t=>{
  const f=fixture();await f.call('addCrmClient',{login:'readonly local profile'});
  const h=routeHarness(f,{readOnly:true}),absent=routeHarness(f,{available:false});t.after(async()=>{await h.app.close();await absent.app.close();});
  const before=structuredClone(f.s),cut=f.queries.length;
  const blocked=await h.request('addCrmClient',{login:'blocked'});envelope(blocked,'ERROR');assert.equal(blocked.statusCode,423);
  envelope(await absent.request('getCrmClients',{page:1}),'ERROR');assert.equal(f.queries.length,cut);
  const list=envelope(await h.request('getCrmClients',{page:1}),'SUCCESS');assert.equal(list.clients.length,1);
  for(const payload of ['method=getCrmClients&parameters=%7B','method=unsupported&parameters=%7B%7D',
    'method=getCrmClients&method=addCrmClient&parameters=%7B%7D','method=getCrmClients&parameters=%7B%22page%22%3A1%2C%22page%22%3A2%7D',
    'method=getCrmClientData&parameters=%7B%22crm_client_id%22%3A9007199254740993%7D']){
    envelope(await h.app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'closed-own-key'},payload}),'ERROR');
  }
  assert.deepEqual(f.s,before);
});

test('retained24-field add contract goes through the actual form codec and domain; omitted fields survive explicit empty text',async t=>{
  const f=fixture(),h=routeHarness(f);t.after(()=>h.app.close());
  const contract=JSON.parse(readFileSync(new URL('../docs/parity/base-api-client-contracts.v1.json',import.meta.url),'utf8'));
  const profile={crm_client_id:0,status_id:1,star:5,contractor_id:123,
    login:'Klient + Łódź',phone:'+48 123 456',email:'full@example.test',notes:'Notatka & szczegóły = zachowane',
    invoice_company:'Firma fakturowa',invoice_fullname:'Jan Żółć',invoice_address:'Długa 1/2',invoice_postcode:'90-001',invoice_city:'Łódź',invoice_state:'Łódzkie',invoice_country_code:'PL',invoice_tax_id:'PL 123-456-789',
    delivery_company:'Odbiorca',delivery_fullname:'Anna Ćma',delivery_address:'Krótka 7',delivery_postcode:'10-001',delivery_city:'Berlin',delivery_state:'Berlin',delivery_country_code:'DE',custom_extra_fields:{}};
  assert.deepEqual(Object.keys(profile).sort(),contract.methods.find((m:any)=>m.method==='addCrmClient').input.parameters.map((p:any)=>p.name).sort());
  assert.equal(Object.keys(profile).length,24);
  const made=envelope(await h.request('addCrmClient',profile),'SUCCESS'),id=made.crm_client_id;
  const expected:any={...profile,crm_client_id:id,invoice_tax_id:'PL123456789'};delete expected.custom_extra_fields;
  const detail=envelope(await h.request('getCrmClientData',{crm_client_id:id}),'SUCCESS');
  assert.deepEqual(detail,{status:'SUCCESS',...expected});
  const list=envelope(await h.request('getCrmClients',{filter_crm_client_id:id}),'SUCCESS');
  const {notes,...listed}=expected;assert.deepEqual(list,{status:'SUCCESS',clients:[listed]});
  const local=f.s.clients[0],shown=await f.service.getCrmClient(f.localActor,local.id,{});
  for(const [key,value]of Object.entries(expected))if(key!=='crm_client_id'&&key!=='status_id')assert.deepEqual(shown.data[key],value);
  // Empty text is explicit input; omitting the other profile fields must not
  // clear them. Extra-field clearing has its separately documented '' rule.
  envelope(await h.request('addCrmClient',{crm_client_id:id,phone:'',invoice_company:'',notes:'',star:0}),'SUCCESS');
  assert.deepEqual(envelope(await h.request('getCrmClientData',{crm_client_id:id}),'SUCCESS'),
    {status:'SUCCESS',...expected,phone:'',invoice_company:'',notes:'',star:0});
  assert.equal(f.s.clients.length,1);assert.equal(f.s.clients[0].id,local.id);
});

function sevenEditorFixture(f:ReturnType<typeof fixture>){
  const editors=['text','number','select','checkbox','radio','date','file'];
  const ids:Record<string,string>={},local:Record<string,string>={};
  for(const [i,editor_type]of editors.entries()){
    const id=uid(700+i),publicId=String(6001+i);ids[editor_type]=publicId;local[editor_type]=id;
    f.s.maps.push({kind:'field',tenant_id:f.actors[0].tenantId,local_id:id,public_id:publicId});
    f.s.definitions.push({id,tenant_id:f.actors[0].tenantId,name:'Pole '+editor_type,position:i,version:1,editor_type,options:editor_type==='select'?['Pilne','Zwykłe']:editor_type==='checkbox'?['Email','SMS']:editor_type==='radio'?['Firma','Osoba']:[],archived_at:null});
  }
  return{ids,local};
}
test('all seven local editor representations translate numeric field IDs, preserve options and return private title/url without base64',async t=>{
  // Retained Base docs leave scalar/container encodings and exact2MB semantics
  // open. These are the existing local domain representations, not new claims
  // about undocumented vendor serialization or a vendor byte ceiling.
  const f=fixture(),h=routeHarness(f),{ids,local}=sevenEditorFixture(f);t.after(()=>h.app.close());
  const bytes=Buffer.from([251,239,255,0,65]),upload=bytes.toString('base64');assert(upload.includes('+'));
  const values:any={[ids.text]:'Ćma + tekst & =',[ids.number]:0,[ids.select]:'Pilne',[ids.checkbox]:['Email','SMS'],[ids.radio]:'Firma',[ids.date]:'2024-02-29',[ids.file]:{title:'umowa.bin',file:'data:'+upload}};
  const made=envelope(await h.request('addCrmClient',{login:'Siedem edytorów',custom_extra_fields:values}),'SUCCESS'),id=made.crm_client_id;
  const shown=envelope(await h.request('getCrmClientData',{crm_client_id:id,include_custom_extra_fields:true}),'SUCCESS');
  const file={title:'umowa.bin',url:`/connector.php/files/clients/${id}/fields/${ids.file}`};
  assert.deepEqual(shown.custom_extra_fields,{...values,[ids.file]:file});
  assert(!JSON.stringify(shown).includes(upload));
  assert.equal(f.s.extra.length,7);
  for(const type of Object.keys(ids))assert(f.s.extra.some((r:any)=>r.field_id===local[type]&&r.editor_type===type));
  const native=await f.service.getCrmClient(f.localActor,f.s.clients[0].id,{include_custom_extra_fields:'true'});
  for(const type of ['text','number','select','checkbox','radio','date'])assert.deepEqual(native.data.custom_extra_fields[local[type]],values[ids[type]]);
  assert.equal(native.data.custom_extra_fields[local.file].title,file.title);
  const downloaded=await h.app.inject({method:'GET',url:file.url,headers:{'x-bltoken':'closed-own-key'}});
  assert.equal(downloaded.statusCode,200);assert.deepEqual(downloaded.rawPayload,bytes);
  assert.equal(downloaded.headers['x-content-type-options'],'nosniff');assert(String(downloaded.headers['content-disposition']).startsWith('attachment;'));
  assert(!JSON.stringify(f.s.commands).includes(upload),'The real domain journals only redacted upload custody');
  assert(!JSON.stringify(f.s.files).includes(upload),'The file query receives only the closed crypto port opaque handle');
  const hidden=envelope(await h.request('getCrmClientData',{crm_client_id:id}),'SUCCESS');assert(!Object.hasOwn(hidden,'custom_extra_fields'));
  envelope(await h.request('addCrmClient',{crm_client_id:id,custom_extra_fields:{[ids.select]:''}}),'SUCCESS');
  const afterClear=envelope(await h.request('getCrmClientData',{crm_client_id:id,include_custom_extra_fields:true}),'SUCCESS');
  const remaining={...shown.custom_extra_fields};delete remaining[ids.select];assert.deepEqual(afterClear.custom_extra_fields,remaining);
  assert.equal(afterClear.custom_extra_fields[ids.number],0,'Zero is a value, not the explicit empty-string clear command');
  envelope(await h.request('addCrmClient',{crm_client_id:id,custom_extra_fields:{[ids.file]:''}}),'SUCCESS');
  assert.equal((await h.app.inject({method:'GET',url:file.url,headers:{'x-bltoken':'closed-own-key'}})).statusCode,404);
  assert.equal(f.s.files.length,1,'Clearing a value disconnects it without rewriting retained file history');
});
test('local editor option/date/type and documented title40 refusals roll back whole profile/value/journal effects',async t=>{
  const f=fixture(),h=routeHarness(f),{ids}=sevenEditorFixture(f);t.after(()=>h.app.close());
  const id=envelope(await h.request('addCrmClient',{login:'Keep',custom_extra_fields:{[ids.text]:'unchanged',[ids.number]:0}}),'SUCCESS').crm_client_id;
  const snapshot=structuredClone(f.s);
  const invalid=[{[ids.select]:'Nieistniejąca opcja'},{[ids.radio]:'Nieistniejąca opcja'},{[ids.checkbox]:['Email','Email']},{[ids.checkbox]:['Obca opcja']},
    {[ids.date]:'2023-02-29'},{[ids.number]:'123'},{[ids.file]:{title:'x'.repeat(41),file:'data:QQ=='}}];
  for(const custom_extra_fields of invalid){
    const r=await h.request('addCrmClient',{crm_client_id:id,login:'must roll back',custom_extra_fields});
    envelope(r,'ERROR');assert.equal(r.statusCode,422);assert.deepEqual(f.s,snapshot);
  }
});
test('all six partial filters and exact status/client IDs combine as AND without allocating identities or exposing a foreign tenant',async t=>{
  const f=fixture(),h=routeHarness(f);t.after(()=>h.app.close());
  const secondStatus=uid(800);f.s.maps.push({kind:'status',tenant_id:f.actors[0].tenantId,local_id:secondStatus,public_id:'2000'});
  const target={status_id:2000,email:'target@example.test',phone:'+48 7654321',login:'CaseSensitiveName',invoice_company:'DYNAMINDS firma',invoice_tax_id:'PL 123-456-789',invoice_fullname:'Anna Żółć'};
  const id=envelope(await h.request('addCrmClient',target),'SUCCESS').crm_client_id;
  const other=envelope(await h.request('addCrmClient',{email:'other@example.test',phone:'11111',login:'Other',invoice_company:'Else',invoice_tax_id:'99999',invoice_fullname:'Other Person'}),'SUCCESS').crm_client_id;
  await f.call('addCrmClient',{...target,status_id:2},f.actors[1]);
  const saved=structuredClone(f.s),cut=f.queries.length;
  const filters={filter_email:'GET@EXAMPLE',filter_phone:'7654',filter_login:'sensitiv',filter_invoice_company:'dynaminds',filter_invoice_tax_id:'23-45',filter_invoice_fullname:'ŻÓŁ'};
  for(const [key,value]of Object.entries(filters))assert.deepEqual(envelope(await h.request('getCrmClients',{[key]:value}),'SUCCESS').clients.map((r:any)=>r.crm_client_id),[id],key);
  for(const query of [{filter_status_id:2000},{filter_crm_client_id:id},{...filters,filter_status_id:2000,filter_crm_client_id:id}])
    assert.deepEqual(envelope(await h.request('getCrmClients',query),'SUCCESS').clients.map((r:any)=>r.crm_client_id),[id]);
  assert.deepEqual(envelope(await h.request('getCrmClients',{filter_email:filters.filter_email,filter_phone:'11111'}),'SUCCESS').clients,[]);
  assert.deepEqual(envelope(await h.request('getCrmClients',{filter_crm_client_id:other,filter_status_id:2000}),'SUCCESS').clients,[]);
  assert.deepEqual(envelope(await h.request('getCrmClients',{filter_status_id:2}),'SUCCESS').clients,[],'Foreign status IDs do not resolve into the current tenant');
  assert.deepEqual(envelope(await h.request('getCrmClients',{filter_crm_client_id:Number.MAX_SAFE_INTEGER}),'SUCCESS').clients,[]);
  assert.deepEqual(f.s,saved);assert(f.queries.slice(cut).every(q=>q.reading&&q.sql.startsWith('SELECT')));
});
test('actual codec preserves the largest safe mapped ID and refuses rounded/unsafe/null/malformed target IDs before domain access',async t=>{
  const f=fixture(),h=routeHarness(f);t.after(()=>h.app.close());
  const created=envelope(await h.request('addCrmClient',{login:'safe maximum'}),'SUCCESS');
  const mapping=f.s.maps.find((m:any)=>m.kind==='client'&&m.public_id===String(created.crm_client_id));mapping.public_id=String(Number.MAX_SAFE_INTEGER);
  const maximum=envelope(await h.request('getCrmClientData',{crm_client_id:Number.MAX_SAFE_INTEGER}),'SUCCESS');assert.equal(maximum.crm_client_id,Number.MAX_SAFE_INTEGER);
  const cut=f.queries.length,saved=structuredClone(f.s);
  for(const token of ['0','-1','1.5','null','"1"','[]','{}','9007199254740992','9007199254740993','1.0000000000000001','1e-999']){
    const payload=new URLSearchParams({method:'getCrmClientData',parameters:'{"crm_client_id":'+token+'}'}).toString();
    const r=await h.app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'closed-own-key'},payload});
    envelope(r,'ERROR');assert(r.statusCode>=400&&r.statusCode<500);
  }
  for(const custom_extra_fields of [{'01':'no'},{'9007199254740993':'no'}])envelope(await h.request('addCrmClient',{custom_extra_fields}),'ERROR');
  assert.deepEqual(f.s,saved);
  // Invalid IDs fail in codec/schema before the transaction. The unsafe numeric
  // field key is validated after the existing locked authority, still no writes.
  assert(f.queries.slice(cut).every(q=>!/^(?:INSERT|UPDATE|DELETE)/.test(q.sql)));
  for(const method of ['deleteCrmClientStatus','deleteCrmClientStatusGroup','getCrmClientStatuses'])envelope(await h.request(method,{}),'ERROR');
});

function historicalOrderFixture(f:ReturnType<typeof fixture>,clientId:string){
  const order={id:uid(900),tenant_id:f.actors[0].tenantId,number:'OLD/2026/1',version:7,status:'shipped',total:1230,currency:'PLN',
    buyer:{name:'Historical buyer',email:'old@example.test'},items:[{id:uid(901),product_id:uid(902),quantity:1,total:1230}],
    payments:[{id:uid(903),amount:1230,external_id:'retained-payment'}],documents:[{id:uid(904),number:'FV/1',total:1230}],
    history:[{kind:'created',at:'2026-10-17T00:00:00Z'},{kind:'shipped',at:'2026-10-18T00:00:00Z'}]};
  f.s.orders.push(order);f.s.orderLinks.push({tenant_id:f.actors[0].tenantId,client_id:clientId,order_id:order.id});
  return structuredClone({orders:f.s.orders,links:f.s.orderLinks});
}
const crmBusinessCut=(f:ReturnType<typeof fixture>)=>structuredClone({clients:f.s.clients,maps:f.s.maps,commands:f.s.commands,audits:f.s.audits,extra:f.s.extra,files:f.s.files,orders:f.s.orders,links:f.s.orderLinks});
test('deleteCrmClient uses the same native soft-delete/journal, preserves whole historical order/link/file rows and never reuses its numeric ID',async t=>{
  const f=fixture(),h=routeHarness(f),{ids}=sevenEditorFixture(f);t.after(()=>h.app.close());
  const id=envelope(await h.request('addCrmClient',{login:'Delete through wire',custom_extra_fields:{[ids.file]:{title:'old.bin',file:'data:QQ=='}}}),'SUCCESS').crm_client_id;
  const client=f.s.clients[0],history=historicalOrderFixture(f,client.id),mapping=structuredClone(f.s.maps),files=structuredClone(f.s.files),extra=structuredClone(f.s.extra),version=client.version;
  const contract=JSON.parse(readFileSync(new URL('../docs/parity/base-api-client-contracts.v1.json',import.meta.url),'utf8')).methods.find((m:any)=>m.method==='deleteCrmClient');
  assert.deepEqual(contract.input.parameters.map((p:any)=>p.name),['crm_client_id']);
  assert.deepEqual(contract.output.fields.map((p:any)=>p.path),['status']);
  const cut=f.queries.length,deleted=await h.request('deleteCrmClient',{crm_client_id:id});
  assert.deepEqual(envelope(deleted,'SUCCESS'),{status:'SUCCESS'});
  assert(f.s.clients[0].deleted_at);assert.equal(f.s.clients[0].version,version+1);assert.equal(f.s.clients[0].id,client.id);
  assert.deepEqual(f.s.maps,mapping);assert.deepEqual(f.s.files,files);assert.deepEqual(f.s.extra,extra);
  assert.deepEqual({orders:f.s.orders,links:f.s.orderLinks},history);
  const authorityQuery=f.queries.slice(cut).find(q=>q.sql.startsWith('SELECT public.base_wire218_authority'));assert.equal(authorityQuery?.args[2],true);
  const journal=f.s.commands.at(-1);assert.equal(journal.request.method,'DELETE');assert.equal(journal.request.path,'/api/crm/clients/'+client.id);
  assert.deepEqual(journal.response,{data:{id:client.id,deleted:true}});assert.equal(journal.request.body.version,version);
  assert.equal(f.s.audits.at(-1).action,'crm.clients.delete');
  await assert.rejects(f.service.getCrmClient(f.localActor,client.id,{}),(e:any)=>e.status===404);
  const saved=crmBusinessCut(f),readCut=f.queries.length;
  assert.equal((await h.request('getCrmClientData',{crm_client_id:id})).statusCode,404);
  assert.deepEqual(envelope(await h.request('getCrmClients',{filter_crm_client_id:id}),'SUCCESS').clients,[]);
  assert.equal((await h.app.inject({method:'GET',url:`/connector.php/files/clients/${id}/fields/${ids.file}`,headers:{'x-bltoken':'closed-own-key'}})).statusCode,404);
  assert.deepEqual(crmBusinessCut(f),saved);assert(f.queries.slice(readCut).every(q=>q.reading&&q.sql.startsWith('SELECT')));
  const next=envelope(await h.request('addCrmClient',{login:'New independent profile'}),'SUCCESS').crm_client_id;assert.notEqual(next,id);
});
test('delete rejects foreign/missing/invalid IDs without effects; repeat-delete refusal is local policy, not an invented Base guarantee',async t=>{
  const f=fixture(),h=routeHarness(f);t.after(()=>h.app.close());
  const foreign=await f.call('addCrmClient',{login:'Other company'},f.actors[1]);
  const own=envelope(await h.request('addCrmClient',{login:'Keep'}),'SUCCESS').crm_client_id;
  const saved=crmBusinessCut(f);
  for(const crm_client_id of [foreign.crm_client_id,Number.MAX_SAFE_INTEGER]){
    const r=await h.request('deleteCrmClient',{crm_client_id});envelope(r,'ERROR');assert.equal(r.statusCode,404);assert.deepEqual(crmBusinessCut(f),saved);
  }
  for(const body of [{},{crm_client_id:0},{crm_client_id:null},{crm_client_id:'1'},{crm_client_id:own,version:1}]){
    const r=await h.request('deleteCrmClient',body);envelope(r,'ERROR');assert.equal(r.statusCode,422);assert.deepEqual(crmBusinessCut(f),saved);
  }
  envelope(await h.request('deleteCrmClient',{crm_client_id:own}),'SUCCESS');
  const removed=crmBusinessCut(f);const repeated=await h.request('deleteCrmClient',{crm_client_id:own});
  envelope(repeated,'ERROR');assert.equal(repeated.statusCode,404);assert.deepEqual(crmBusinessCut(f),removed);
});
test('delete requires crm:write and fresh write authority; stale principal/revoked key cannot delete or replay a retained ACK',async t=>{
  for(const mode of ['read-only-scope','stale-role','late-revoked','readonly-preview'] as const){
    const f=fixture(),id=(await f.call('addCrmClient',{login:'Must survive'})).crm_client_id;
    if(mode==='read-only-scope')f.s.scopes[f.actors[0].apiKeyId]=['crm:read'];
    const h=routeHarness(f,{readOnly:mode==='readonly-preview',afterAuth:()=>{
      if(mode==='stale-role')f.s.roles[f.actors[0].userId]='viewer';
      if(mode==='late-revoked')f.s.revoked.push(f.actors[0].apiKeyId);
    }});t.after(()=>h.app.close());const before=crmBusinessCut(f);
    const r=await h.request('deleteCrmClient',{crm_client_id:id});envelope(r,'ERROR');assert.equal(r.statusCode,mode==='readonly-preview'?423:403);
    assert.deepEqual(crmBusinessCut(f),before);
    assert.equal(adapter.baseWireCrmScope('deleteCrmClient'),'crm:write');
  }
  const f=fixture(),id=(await f.call('addCrmClient',{login:'Fresh replay gate'})).crm_client_id,key={clientKey:uid(950)};
  assert.deepEqual(await f.call('deleteCrmClient',{crm_client_id:id},undefined,key),{});
  const saved=crmBusinessCut(f);f.s.revoked.push(f.actors[0].apiKeyId);const cut=f.queries.length;
  await assert.rejects(f.call('deleteCrmClient',{crm_client_id:id},undefined,key),(e:any)=>e.status===403);
  assert.deepEqual(crmBusinessCut(f),saved);assert(!f.queries.slice(cut).some(q=>q.sql.startsWith('SELECT * FROM crm_commands')),'Fresh authority runs before the original receipt lookup');
});
test('lost delete COMMIT ACK reconciles only the original actor/key/body without deleting again or changing historical orders',async t=>{
  const f=fixture(),id=(await f.call('addCrmClient',{login:'Lost ACK'})).crm_client_id;
  const history=historicalOrderFixture(f,f.s.clients[0].id),beforeVersion=f.s.clients[0].version;
  let loseAck=true;
  f.wire=adapter.createBaseWireCrmService({transaction:async(actor:any,writing:boolean,work:any)=>{
    const result=await f.transaction(actor,writing,work);if(writing&&loseAck){loseAck=false;throw new Error('closed transport lost COMMIT ACK');}return result;
  },authorize:authority.authorizeBaseWireCrmInTx,domain:f.service.createCrmClientWirePort});
  const h=routeHarness(f);t.after(()=>h.app.close());const headers={'idempotency-key':uid(951)},body={crm_client_id:id};
  const lost=await h.request('deleteCrmClient',body,headers),unknown=envelope(lost,'ERROR');assert.equal(lost.statusCode,500);assert.equal(unknown.error_code,'LOCAL_BASE_WIRE_OUTCOME_UNCONFIRMED');
  const committed=crmBusinessCut(f),cut=f.queries.length;
  assert(f.s.clients[0].deleted_at);assert.equal(f.s.clients[0].version,beforeVersion+1);
  assert.deepEqual(envelope(await h.request('deleteCrmClient',body,headers),'SUCCESS'),{status:'SUCCESS'});
  assert.deepEqual(crmBusinessCut(f),committed);assert(!f.queries.slice(cut).some(q=>/^(?:INSERT|UPDATE|DELETE)/.test(q.sql)));
  assert.deepEqual({orders:f.s.orders,links:f.s.orderLinks},history);
  await assert.rejects(f.call('deleteCrmClient',{crm_client_id:id+1},undefined,{clientKey:headers['idempotency-key']}),(e:any)=>e.status===409);
  const secondKey={...f.actors[0],apiKeyId:uid(952)};f.actors.push(secondKey);f.s.scopes[secondKey.apiKeyId]=['crm:read','crm:write'];
  await assert.rejects(f.call('deleteCrmClient',body,secondKey,{clientKey:headers['idempotency-key']}),(e:any)=>e.status===409);
  assert.deepEqual(crmBusinessCut(f),committed);
});
test('delete uses the current locked native version and rolls back the soft-delete if its journal insertion fails',async t=>{
  const f=fixture(),h=routeHarness(f);t.after(()=>h.app.close());
  const id=envelope(await h.request('addCrmClient',{login:'Before UI edit'}),'SUCCESS').crm_client_id,local=f.s.clients[0];
  await f.service.executeCrmCommand(f.localActor,'PATCH','/api/crm/clients/'+local.id,{client_key:uid(953),version:local.version,notes:'Later UI edit'});
  const version=f.s.clients[0].version,saved=crmBusinessCut(f);f.s.rejectJournalInsert=true;
  const failed=await h.request('deleteCrmClient',{crm_client_id:id});envelope(failed,'ERROR');assert.equal(failed.statusCode,409);assert.deepEqual(crmBusinessCut(f),saved);
  f.s.rejectJournalInsert=false;
  envelope(await h.request('deleteCrmClient',{crm_client_id:id}),'SUCCESS');
  assert.equal(f.s.commands.at(-1).request.body.version,version);assert.equal(f.s.clients[0].profile.notes,'Later UI edit');
});

test('getCrmClientExtraFields uses retained table/example ARRAY as local choice and discovers the same seven native editors/options without allocation',async t=>{
  const f=fixture(),h=routeHarness(f),{ids}=sevenEditorFixture(f);t.after(()=>h.app.close());
  const contract=JSON.parse(readFileSync(new URL('../docs/parity/base-api-client-contracts.v1.json',import.meta.url),'utf8')).methods.find((m:any)=>m.method==='getCrmClientExtraFields');
  assert.deepEqual(contract.input.parameters,[]);
  assert.equal(contract.output.fields.find((p:any)=>p.path==='extra_fields').documented_type,'array');
  const native=await f.service.getCrmDictionaries(f.localActor,'fields'),expectedTypes=contract.output.fields.find((p:any)=>p.path==='extra_fields[].editor_type').documented_values;
  assert.deepEqual(native.data.map((r:any)=>r.editor_type),expectedTypes);
  const before=structuredClone(f.s),cut=f.queries.length;
  const response=await h.request('getCrmClientExtraFields',{}),shown=envelope(response,'SUCCESS');
  assert.deepEqual(Object.keys(shown).sort(),['extra_fields','status']);assert(Array.isArray(shown.extra_fields));
  assert.deepEqual(shown.extra_fields,expectedTypes.map((editor_type:string)=>({
    extra_field_id:Number(ids[editor_type]),name:'Pole '+editor_type,editor_type,
    ...(['select','checkbox','radio'].includes(editor_type)?{options:f.s.definitions.find((r:any)=>r.editor_type===editor_type).options}:{}),
  })));
  assert.equal(response.headers['cache-control'],'private, no-store');
  assert.equal(adapter.baseWireCrmScope('getCrmClientExtraFields'),'crm:read');
  assert(!JSON.stringify(shown).includes(f.actors[0].tenantId));
  for(const row of shown.extra_fields){
    assert(Number.isSafeInteger(row.extra_field_id)&&row.extra_field_id>0);
    assert.deepEqual(Object.keys(row).sort(),['extra_field_id','name','editor_type',...(['select','checkbox','radio'].includes(row.editor_type)?['options']:[])].sort());
  }
  assert.deepEqual(f.s,before);assert(f.queries.slice(cut).every(q=>q.reading&&/^SELECT/.test(q.sql)&&!/FOR UPDATE|FOR SHARE|advisory/.test(q.sql)));
});
test('active-only field discovery is LOCAL policy; archived values and numeric identities stay readable and foreign definitions stay isolated',async t=>{
  const f=fixture(),h=routeHarness(f),{ids,local}=sevenEditorFixture(f);t.after(()=>h.app.close());
  const id=envelope(await h.request('addCrmClient',{custom_extra_fields:{[ids.text]:'retained archived value'}}),'SUCCESS').crm_client_id;
  // Reflect the native217 archive state; no new Base definition-write operation
  // or undocumented vendor archive flag is invented by this read adapter.
  f.s.definitions.find((r:any)=>r.id===local.text).archived_at='2026-10-19T03:00:00.000Z';
  f.s.definitions.push({id:uid(799),tenant_id:f.actors[1].tenantId,name:'Foreign private field',editor_type:'text',options:[],position:0,version:1,archived_at:null});
  f.s.maps.push({kind:'field',tenant_id:f.actors[1].tenantId,local_id:uid(799),public_id:'6999'});
  const before=structuredClone(f.s),cut=f.queries.length;
  const own=envelope(await h.request('getCrmClientExtraFields',{}),'SUCCESS').extra_fields;
  assert.equal(own.length,6);assert(!own.some((r:any)=>r.extra_field_id===Number(ids.text)||r.name==='Foreign private field'));
  const foreign=await f.call('getCrmClientExtraFields',{},f.actors[1]);
  assert.deepEqual(foreign,{extra_fields:[{extra_field_id:6999,name:'Foreign private field',editor_type:'text'}]});
  assert.equal(envelope(await h.request('getCrmClientData',{crm_client_id:id,include_custom_extra_fields:true}),'SUCCESS').custom_extra_fields[ids.text],'retained archived value');
  assert.deepEqual(f.s,before);assert(f.queries.slice(cut).every(q=>q.reading&&q.sql.startsWith('SELECT')));
});
test('field discovery keeps fresh read authority in readonly preview and fails closed for missing/unsafe numeric mappings without allocations',async t=>{
  const f=fixture(),{local}=sevenEditorFixture(f);f.s.roles[f.actors[0].userId]='viewer';f.s.scopes[f.actors[0].apiKeyId]=['crm:read'];
  const h=routeHarness(f,{readOnly:true});t.after(()=>h.app.close());
  assert.equal(envelope(await h.request('getCrmClientExtraFields',{}),'SUCCESS').extra_fields.length,7);
  const cut=f.queries.length;envelope(await h.request('getCrmClientExtraFields',{page:1}),'ERROR');assert.equal(f.queries.length,cut);
  const original=f.s.maps.find((m:any)=>m.kind==='field'&&m.local_id===local.text),saved=structuredClone(f.s);
  f.s.maps=f.s.maps.filter((m:any)=>m!==original);
  const missing=structuredClone(f.s),failed=await h.request('getCrmClientExtraFields',{});envelope(failed,'ERROR');assert.equal(failed.statusCode,503);assert.deepEqual(f.s,missing);
  f.s.maps=structuredClone(saved.maps);f.s.maps.find((m:any)=>m.kind==='field'&&m.local_id===local.text).public_id='9007199254740992';
  const unsafe=structuredClone(f.s),bad=await h.request('getCrmClientExtraFields',{});envelope(bad,'ERROR');assert.equal(bad.statusCode,503);assert.deepEqual(f.s,unsafe);
  f.s.maps=structuredClone(saved.maps);
  const racing=routeHarness(f,{afterAuth:()=>f.s.revoked.push(f.actors[0].apiKeyId)});t.after(()=>racing.app.close());
  const queries=f.queries.length,denied=await racing.request('getCrmClientExtraFields',{});envelope(denied,'ERROR');assert.equal(denied.statusCode,403);
  assert(!f.queries.slice(queries).some(q=>q.sql.includes('FROM crm_extra_fields')),'Revocation after authentication refuses before reading definitions');
  assert.deepEqual(f.s.maps,saved.maps);assert.deepEqual(f.s.definitions,saved.definitions);
});
