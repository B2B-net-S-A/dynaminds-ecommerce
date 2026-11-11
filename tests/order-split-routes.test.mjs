/** Real Fastify.inject and cookie parsing, ordinary middleware FIXTURE only.
 * Controlled service/query ports test HTTP routing, not real session DB auth,
 * Native210, transaction commit, installed schema or split business acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {z} from 'zod';
import {createServer} from 'vite';
let dbCalls=0;
const virtualDb='\0controlled-split-route-db';
const vite=await createServer({plugins:[{name:'controlled-split-route-db',enforce:'pre',transform(source,id){if(id.endsWith('/server/order-split-transport.ts')){assert.equal(source.split("import('./db')").length-1,4);return source.replaceAll("import('./db')","import('virtual:controlled-split-route-db')");}},resolveId(id){if(id==='virtual:controlled-split-route-db')return virtualDb;},load(id){if(id.endsWith('/server/db.ts'))throw Error('Real DB import prohibited in controlled split test');if(id===virtualDb)return `let port;export const setTenantTx=v=>{port=v};export const tenantTx=(...args)=>port(...args);`;}}],server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const R=await vite.ssrLoadModule(path.resolve('server/order-split-routes.ts'));
const T=await vite.ssrLoadModule(path.resolve('server/order-split-transport.ts'));
const {Problem}=await vite.ssrLoadModule(path.resolve('server/errors.ts'));
const DB=await vite.ssrLoadModule('virtual:controlled-split-route-db');
DB.setTenantTx(()=>{dbCalls++;throw new Problem(503,'Brak dostępnego Native210')});
test.after(()=>vite.close());
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,tenant=id(1),user=id(2),order=id(3),line=id(4),command=id(5),slot=id(6),previewId=id(7);
const preview={client_key:command,source_order_id:order,expected_source_version:'7',children:[{slot_id:slot,name:'Osobna paczka',delivery_minor:0,items:[{source_item_id:line,quantity:1}]}]};
const execute={client_key:id(8),preview_id:previewId,scope_hash:'a'.repeat(64),confirmed:true};
const cookieHeader='dyna_session_preview_4103=PRIVATE_ROUTING_SESSION',headers={cookie:cookieHeader,'x-workspace-id':tenant};
async function app(options={}){
 const app=Fastify({logger:false});await app.register(cookie);app.decorateRequest('actor');app.decorateRequest('currentUser');app.decorateRequest('apiScopes');
 // Deliberate ordinary middleware stand-in, not real credential authentication.
 app.addHook('onRequest',async req=>{req.actor={tenantId:tenant,userId:user,role:'operator',source:'manual',...options.actor};req.currentUser={id:user,tenant_id:tenant,role:'operator',...options.currentUser};req.apiScopes=options.apiScopes;});
 app.setErrorHandler((e,_req,reply)=>reply.code(e instanceof Problem?e.status:e instanceof z.ZodError?422:e.statusCode??500).send({detail:e instanceof Problem?e.message:'Żądanie odrzucone'}));
 const calls=[];
 const transport=options.real?undefined:options.transport??{
  async preview(request,body){calls.push({kind:'preview',request,body});return {id:previewId};},
  async execute(request,body){calls.push({kind:'execute',request,body});return {id:id(9)};},
  async read(request,input){calls.push({kind:'read',request,input});return {routing_only:true,input};},
  async lineage(request,id){calls.push({kind:'lineage',request,id});return {schema:'order-split-lineage/v1',order_id:id,lineage:null};},
 };
 R.registerOrderSplitRoutes(app,{sessionName:'dyna_session_preview_4103',readOnly:!!options.readOnly,...(transport?{transport}:{})});await app.ready();
 return{app,calls,async close(){await app.close();}};
}
const inject=(h,url,extra={})=>h.app.inject({url,headers,...extra});
test('browser POST ports validate exact logical intent and bind a fresh captured request per HTTP request',async()=>{
 const h=await app();try{
  for(const[path,body]of [['previews',preview],['executions',execute]]){const r=await inject(h,'/api/order-splits/'+path,{method:'POST',payload:body});assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');}
  assert.deepEqual(h.calls.map(c=>c.kind),['preview','execute']);assert.deepEqual(h.calls[0].body,preview);assert.deepEqual(h.calls[1].body,execute);
  for(const c of h.calls){assert.equal(c.request.tenantId,tenant);assert.equal(c.request.userId,user);assert.equal(c.request.role,'operator');assert.equal(c.request.readOnly,false);assert.equal(Object.isFrozen(c.request),true);assert.equal(JSON.stringify(c.request).includes('PRIVATE_'),false);assert.equal(Object.hasOwn(c.request,'hash'),false);}
  assert.notEqual(h.calls[0].request,h.calls[1].request);
 }finally{await h.close();}
});
test('original command GET and all ten result views use exactly the browser URL/operation protocol',async()=>{
 const h=await app();try{
  const r=await inject(h,`/api/order-splits/commands/${command}?operation=preview`);assert.equal(r.statusCode,200);assert.deepEqual(h.calls.at(-1).input,{operation:'preview',client_key:command,view:'command'});
  for(const kind of ['previews','executions'])for(const view of ['head','source','source-items','children','commercial']){
   const paged=view==='source-items'||view==='children',url=`/api/order-splits/${kind}/${previewId}/${view}`+(paged?'?limit=2&cursor=opaque%2Fcursor%2B':'');
   const r=await inject(h,url);assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');assert.deepEqual(h.calls.at(-1).input,{operation:kind==='previews'?'preview':'execute',id:previewId,view,...(paged?{query:{limit:2,cursor:'opaque/cursor+'}}:{})});
  }
  await inject(h,`/api/order-splits/previews/${previewId}/children`);assert.deepEqual(h.calls.at(-1).input.query,{limit:100});
  assert.ok(h.calls.every(c=>c.kind==='read'));
 }finally{await h.close();}
});
test('readonly configuration permits ordinary reads while refusing both writes before service dispatch',async()=>{
 const h=await app({readOnly:true});try{
  for(const[path,body]of [['previews',preview],['executions',execute]]){const r=await inject(h,'/api/order-splits/'+path,{method:'POST',payload:body});assert.equal(r.statusCode,423);assert.equal(r.headers['cache-control'],'no-store');}
  assert.equal(h.calls.length,0);const r=await inject(h,`/api/order-splits/commands/${command}?operation=execute`);assert.equal(r.statusCode,200);assert.equal(h.calls.length,1);assert.equal(h.calls[0].request.readOnly,true);
 }finally{await h.close();}
});
test('missing own cookie, workspace/actor mismatch, API principal and viewer write are refused by actual capture/route prechecks',async()=>{
 const cases=[{options:{},headers:{'x-workspace-id':tenant},status:401},{options:{},headers:{...headers,'x-workspace-id':id(99)},status:409},{options:{currentUser:{id:id(99)}},status:401},{options:{currentUser:{tenant_id:id(99)}},status:401},{options:{currentUser:{role:'admin'}},status:401},{options:{apiScopes:[]},status:403},{options:{actor:{apiKeyId:id(99)},currentUser:{api_key_id:id(99)}},status:403},{options:{actor:{role:'viewer'},currentUser:{role:'viewer'}},status:403},{options:{},headers:{cookie:'dyna_session=PRIVATE_OTHER_COOKIE','x-workspace-id':tenant},status:401}];
 for(const c of cases){const h=await app(c.options);try{const r=await inject(h,'/api/order-splits/previews',{method:'POST',payload:preview,...(c.headers?{headers:c.headers}:{})});assert.equal(r.statusCode,c.status);assert.equal(h.calls.length,0);assert.equal(r.body.includes('PRIVATE_'),false);}finally{await h.close();}}
});
test('strict body/UUID/operation/page/query schemas reject malformed or injected authority without transport calls',async()=>{
 const h=await app();try{
  const cases=[['/api/order-splits/previews',{method:'POST',payload:{...preview,tenant_id:tenant}}],['/api/order-splits/previews?available=true',{method:'POST',payload:preview}],['/api/order-splits/executions',{method:'POST',payload:{...execute,confirmed:false}}],['/api/order-splits/executions',{method:'POST',payload:{...execute,scope_hash:'bad'}}],[`/api/order-splits/commands/${command}`,{}],[`/api/order-splits/commands/${command}?operation=other`,{}],[`/api/order-splits/commands/${command}?operation=preview&skip_auth=true`,{}],['/api/order-splits/commands/bad?operation=preview',{}],[`/api/order-splits/previews/${previewId}/head?cursor=x`,{}],[`/api/order-splits/previews/${previewId}/children?limit=101`,{}],[`/api/order-splits/previews/${previewId}/children?limit=1.5`,{}],[`/api/order-splits/previews/${previewId}/children?cursor=`,{}],[`/api/order-splits/previews/${previewId}/children?cursor=${'a'.repeat(2049)}`,{}],['/api/order-splits/previews/bad/source',{}]];
  for(const[url,extra]of cases){const r=await inject(h,url,extra);assert.equal(r.statusCode,422,url);assert.equal(r.headers['cache-control'],'no-store');}assert.equal(h.calls.length,0);
  const unknown=await inject(h,`/api/order-splits/other/${previewId}/head`);assert.equal(unknown.statusCode,404);assert.equal(h.calls.length,0);
 }finally{await h.close();}
});
test('POST parser and real byte limit fail before service dispatch; unknown singular execute route is absent',async()=>{
 const h=await app();try{
  const big=await inject(h,'/api/order-splits/previews',{method:'POST',payload:{...preview,oversized:'a'.repeat(1048576)}});assert.equal(big.statusCode,413);assert.equal(big.headers['cache-control'],'no-store');
  const malformed=await inject(h,'/api/order-splits/previews',{method:'POST',payload:'{broken',headers:{...headers,'content-type':'application/json'}});assert.equal(malformed.statusCode,400);assert.equal(malformed.headers['cache-control'],'no-store');
  const absent=await inject(h,'/api/order-splits/execute',{method:'POST',payload:execute});assert.equal(absent.statusCode,404);assert.equal(h.calls.length,0);
 }finally{await h.close();}
});
test('actual default transport enters controlled DB port once per write and propagates unavailable Native503',async()=>{
 const before=dbCalls,h=await app({real:true});try{for(const[path,payload]of [['previews',preview],['executions',execute]]){const r=await inject(h,'/api/order-splits/'+path,{method:'POST',payload});assert.equal(r.statusCode,503);assert.equal(r.body.includes('PRIVATE_'),false);assert.equal(r.headers['cache-control'],'no-store');}assert.equal(dbCalls-before,2);}finally{await h.close();}
});
test('real InTx read export through a controlled query port rechecks current IAM and retains original lookup404, never writes',async()=>{
 const calls=[],c={async query(sql,args=[]){calls.push({sql,args});if(sql.includes('split210:context'))return{rows:[{role:'dyna_app',owner:'postgres',tenant,root:'100',started:'2026-10-18',pid:'2',read_only:'off'}]};if(sql.includes('buyer_address_identity('))return{rows:[{proof:{role:'operator',account_version:'1'}}]};if(sql.includes('pg_get_userbyid(relowner)'))return{rows:[{role:'dyna_app',owner:'postgres',tenant,root:'100',started:'2026-10-18',relation_owner:'postgres'}]};if(sql==='RESET ROLE'||sql==='SET LOCAL ROLE dyna_app'||sql.startsWith("SELECT set_config('app.tenant_id'"))return{rows:[]};if(sql.includes('split210:record-bound'))return{rows:[{count:'0',bytes:'0'}]};throw Error('Unexpected controlled query');}};
 const transport={async preview(){throw Error('must not write');},async execute(){throw Error('must not write');},read:(a,input)=>T.readOrderSplitInTx(c,a,input,'x'.repeat(64)),async lineage(){throw Error('not this test');}};
 const h=await app({transport});try{const r=await inject(h,`/api/order-splits/commands/${command}?operation=preview`);assert.equal(r.statusCode,404);assert.ok(calls.some(c=>c.sql.includes('buyer_address_identity(')));assert.ok(calls.some(c=>c.sql.includes('client_key=$3')&&c.args[0]===tenant&&c.args[1]===user&&c.args[2]===command));assert.ok(calls.every(c=>!/^\s*(INSERT|UPDATE|DELETE|COMMIT)/.test(c.sql)));assert.equal(JSON.stringify(calls).includes('PRIVATE_ROUTING_SESSION'),false);}finally{await h.close();}
});
test('normal transport Problems remain errors, never fabricated accepted acknowledgements',async()=>{
 for(const status of [401,403,404,409,503]){
  const transport={async preview(){throw new Problem(status,'Odmowa');},async execute(){throw new Problem(status,'Odmowa');},async read(){throw new Problem(status,'Odmowa');},async lineage(){throw new Problem(status,'Odmowa');}},h=await app({transport});try{const r=await inject(h,'/api/order-splits/previews',{method:'POST',payload:preview});assert.equal(r.statusCode,status);assert.deepEqual(r.json(),{detail:'Odmowa'});}finally{await h.close();}
 }
});

test('order-scoped lineage GET permits ordinary viewer/readonly, rejects extra query, badUUID and API keys before dispatch',async()=>{
 for(const role of ['admin','operator','viewer']){const h=await app({readOnly:true,actor:{role},currentUser:{role}});try{
  const r=await inject(h,`/api/order-splits/orders/${order}/lineage`);assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');assert.deepEqual(r.json(),{schema:'order-split-lineage/v1',order_id:order,lineage:null});assert.equal(h.calls[0].kind,'lineage');assert.equal(h.calls[0].request.role,role);assert.equal(h.calls[0].request.readOnly,true);
  for(const suffix of ['?cursor=x','?actor_id='+user,'?limit=100'])assert.equal((await inject(h,`/api/order-splits/orders/${order}/lineage`+suffix)).statusCode,422);
  assert.equal((await inject(h,'/api/order-splits/orders/not-uuid/lineage')).statusCode,422);assert.equal(h.calls.length,1);
 }finally{await h.close();}}
 for(const options of [{apiScopes:[]},{actor:{apiKeyId:id(99)},currentUser:{api_key_id:id(99)}}]){const h=await app(options);try{assert.equal((await inject(h,`/api/order-splits/orders/${order}/lineage`)).statusCode,403);assert.equal(h.calls.length,0);}finally{await h.close();}}
});
