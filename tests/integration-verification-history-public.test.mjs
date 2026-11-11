import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import Fastify from 'fastify';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),tmp=await mkdtemp(path.join(root,'data/source-drafts/.history-public-controls-'));
const source=await readFile(path.join(root,'server/developer-api.ts'),'utf8');
const target='/integrations/:id/verification-history';
const boundaries={operation:['function operation(', 'export async function authenticateApiKey('],authenticateApiKey:['export async function authenticateApiKey(', 'export function publicApiDocument('],publicApiDocument:['export function publicApiDocument(', 'export function collectPublicRoutes('],collectPublicRoutes:['export function collectPublicRoutes(', 'export function registerDeveloperRoutes(']};
const fn=name=>{const [begin,end]=boundaries[name],a=source.indexOf(begin),b=source.indexOf(end,a+begin.length);assert(a>=0&&b>a,name);return source.slice(a,b);};
const variables=name=>{assert.equal(name,'apiScopes');const a=source.indexOf('export const apiScopes = ['),b=source.indexOf('] as const;',a);assert(a>=0&&b>a);return source.slice(a,b+11);};
const selected=source.split('\n').filter(line=>line.trim()===`op('GET', '${target}', 'integrations:read'),`);assert.equal(selected.length,1);
const selectedText=selected[0].trim().slice(0,-1);
const errorModule=JSON.stringify(path.join(root,'server/errors.ts'));
const contents=`import {z} from 'zod';import {createHash} from 'node:crypto';import {ensure} from ${errorModule};
${variables('apiScopes')}
const op=(method,path,scope,input)=>({method,path,scope,input});export const publicOperations=[${selectedText}];
const tokenHash=(t)=>createHash('sha256').update(t).digest('hex');const pool={query:(...args)=>globalThis.__historyKeyQuery(...args)};
const largeImportPublicOperations=[];const applyPimOpenApiContract=()=>{};const applyLargeImportOpenApiContract=()=>{};
${fn('operation')} ${fn('authenticateApiKey')} ${fn('publicApiDocument')} ${fn('collectPublicRoutes')}`;
const output=path.join(tmp,'public.mjs');
await build({stdin:{contents,loader:'ts',resolveDir:root},outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const api=await import(pathToFileURL(output));
try {
 await test('existing integrations:read only; strict bounded documented DTO/read-only mode survives',()=>{
  assert(api.apiScopes.includes('integrations:read'));assert.equal(api.publicOperations[0].scope,'integrations:read');assert.equal(api.publicOperations[0].method,'GET');
  for(const mode of [false,true]){const doc=api.publicApiDocument({readOnly:mode});const get=doc.paths['/integrations/{id}/verification-history'].get;assert.deepEqual(get['x-required-scopes'],['integrations:read']);assert.equal(get['x-read-only'],true);assert.equal(get['x-strict-query'],true);const limit=get.parameters.find(p=>p.name==='limit').schema;assert.deepEqual(limit,{type:'integer',minimum:1,maximum:100,default:25});const s=get.responses[200].content['application/json'].schema;assert.deepEqual(s.required,['channel','data','next']);assert.equal(s.additionalProperties,false);assert.equal(s.properties.data.maxItems,100);assert.equal(s.properties.data.items.properties.detail,undefined);assert(get.responses[404]&&get.responses[422]);}
 });
 await test('actual API key gate checks current scope/revocation query and refuses unrelated writer/method',async()=>{
  const token='dyna_api_'+'a'.repeat(64),req={method:'GET',url:'/api/v1/integrations/edd13000-0000-4000-8000-000000000001/verification-history?limit=25',headers:{}};
  const row={id:'u',tenant_id:'t',role:'viewer',scopes:['integrations:read']};globalThis.__historyKeyQuery=async(sql)=>{assert(sql.includes('k.revoked_at IS NULL AND k.expires_at>now()'));assert(sql.includes('JOIN memberships'));return{rows:[row]};};
  assert.equal(await api.authenticateApiKey(req,token),row);row.scopes=['integrations:write'];await assert.rejects(api.authenticateApiKey(req,token),e=>e.status===403);row.scopes=['integrations:read'];await assert.rejects(api.authenticateApiKey({...req,method:'POST'},token),e=>e.status===403);row.mfa_required=true;await assert.rejects(api.authenticateApiKey(req,token,true),e=>e.status===403);globalThis.__historyKeyQuery=async()=>({rows:[]});await assert.rejects(api.authenticateApiKey(req,token),e=>e.status===401);
 });
 await test('actual collector preserves handler/hooks for exact read alias, no write alias',async()=>{
  const app=Fastify(),finalize=api.collectPublicRoutes(app);let active=0;const seen=[];app.addHook('onRoute',r=>{if(r.method==='GET')seen.push(r);});
  const hook=async req=>{req.originalActor='same-original-actor';},handler=async req=>{active++;return{actor:req.originalActor};};
  app.get('/api'+target,{onRequest:hook},handler);finalize();await app.ready();const routes=seen.filter(r=>r.url.endsWith('/verification-history'));assert.equal(routes.length,2);assert.equal(routes[0].handler,routes[1].handler);assert.equal(routes[0].onRequest,routes[1].onRequest);
  for(const prefix of ['/api','/api/v1']){const r=await app.inject(prefix+'/integrations/edd13000-0000-4000-8000-000000000001/verification-history');assert.equal(r.statusCode,200);assert.equal(r.json().actor,'same-original-actor');}assert.equal(active,2);assert.equal((await app.inject({method:'POST',url:'/api/v1/integrations/edd13000-0000-4000-8000-000000000001/verification-history'})).statusCode,404);await app.close();
 });
} finally {delete globalThis.__historyKeyQuery;await rm(tmp,{recursive:true,force:true});}
