import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import Fastify from 'fastify';
// Actual registered Fastify handler and parsers; injected DB/auth are source controls, not native RLS proof.
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp=await mkdtemp(path.join(root,'data/source-drafts/.verification-history-controls-'));
const source=await readFile(path.join(root,'server/integration-workspace.ts'),'utf8');
const output=path.join(tmp,'routes.mjs');
const inventory=await readFile(path.join(root,'server/inventory.ts'),'utf8');
const paging=inventory.slice(inventory.indexOf('export function decodePage'),inventory.indexOf('const stockFields'));
await build({stdin:{contents:source,loader:'ts',resolveDir:path.join(root,'server')},outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'history-source-dependencies',setup(b){
 b.onResolve({filter:/^\.\/db$/},()=>({path:'db',namespace:'control'}));
 b.onResolve({filter:/^\.\/integrations$/},()=>({path:'registry',namespace:'control'}));
 b.onResolve({filter:/^\.\/inventory$/},()=>({path:'paging',namespace:'control'}));
 b.onLoad({filter:/.*/,namespace:'control'},({path:p})=>({contents:p==='db'?`export const tenantTx=()=>{throw Error('unexpected writer')};export const tenantReadTx=(t,f)=>globalThis.__historyRead(t,f);`:p==='registry'?`export const registry=[{id:'woocommerce',name:'WooCommerce'}];`:`import {z} from 'zod';import {Problem} from ${JSON.stringify(path.join(root,'server/errors.ts'))};${paging}`,loader:'ts',resolveDir:root}));
}}]});
const {registerIntegrationWorkspaceRoutes}=await import(pathToFileURL(output));
const tenant='745e0000-0000-4000-8000-000000000001',other='07500000-0000-4000-8000-000000000001',channel='edd13000-0000-4000-8000-000000000001';
const runId=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
let sqlCalls=[];
async function makeApp(){const app=Fastify();app.decorateRequest('actor',null);app.addHook('onRequest',async(req,reply)=>{if(!req.headers['x-test-tenant'])return reply.code(401).send({});req.actor={tenantId:req.headers['x-test-tenant']};});registerIntegrationWorkspaceRoutes(app);app.setErrorHandler((e,_q,r)=>r.code(e.status??422).send({error:e.message}));await app.ready();return app;}
const app=await makeApp();
const rows=Array.from({length:59},(_,i)=>({id:runId(i+1),operation:'connection',status:i%2?'error':'verified_read',created_at:'2026-10-11T00:00:00.000001Z',page_time:'2026-10-11T00:00:00.000001Z',scope:i%2?'SECRET-TOKEN':'read_only',detail:{password:'SECRET'},tenant_id:tenant})).reverse();
globalThis.__historyRead=async(t,f)=>{assert.equal(t,tenant);return f({query:async(sql,values)=>{sqlCalls.push({sql,values});assert(sql.startsWith('SELECT'));assert(!/FOR (?:SHARE|UPDATE)|INSERT|DELETE|UPDATE/.test(sql));if(sql.includes('FROM channels'))return{rows:values[0]===tenant&&values[1]===channel?[{id:channel,name:'Own Woo',provider:'woocommerce',credentials:'SECRET'}]:[]};assert(sql.includes('tenant_id=$1 AND channel_id=$2'));assert(sql.includes('(created_at,id)<'));assert(sql.includes('ORDER BY created_at DESC,id DESC LIMIT $5'));let selected=rows.filter(r=>!values[3]||r.id<values[3]);return{rows:selected.slice(0,values[4])};}});};
const request=(query='',id=channel,auth=tenant)=>app.inject({url:'/api/integrations/'+id+'/verification-history'+query,headers:auth?{'x-test-tenant':auth}:{}});
try {
 await test('all59 older runs traverse bounded pages with microsecond/UUID ties; safe DTO only',async()=>{let after=null,found=[],pages=0;do{const r=await request('?limit=7'+(after?'&after='+after:''));assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['cache-control'],'no-store');const p=r.json();assert(p.data.length<=7);assert(!r.body.includes('SECRET'));assert(!r.body.includes('tenant_id'));assert(!r.body.includes('page_time'));assert.deepEqual(Object.keys(p.data[0]).sort(),['created_at','id','operation','scope','status']);found.push(...p.data.map(x=>x.id));after=p.next;assert(++pages<12);}while(after);assert.equal(pages,9);assert.deepEqual(found,rows.map(x=>x.id));assert.equal(new Set(found).size,59);});
 await test('cursor binds original tenant/channel/page size; unknown query and invalid UUID refuse before DB',async()=>{const first=(await request('?limit=7')).json();const n=sqlCalls.length;for(const u of ['?limit=8&after='+first.next,'?limit=7&retry=true','?limit=101','?after=bad'])assert.equal((await request(u)).statusCode,422);assert.equal((await request('?limit=7&after='+first.next,runId(900))).statusCode,422);assert.equal((await request('?limit=7&after='+first.next,channel,other)).statusCode,422);assert.equal(sqlCalls.length,n);assert.equal((await request('', 'bad')).statusCode,422);assert.equal((await request('',channel,null)).statusCode,401);});
 await test('own channel must exist; empty tail has no next; scalar limit+1 and reader selected',async()=>{assert.equal((await request('',runId(999))).statusCode,404);const after=Buffer.from(JSON.stringify({tenant,channel,limit:7,time:rows[0].page_time,id:runId(0)})).toString('base64url');const r=await request('?limit=7&after='+after);assert.deepEqual(r.json().data,[]);assert.equal(r.json().next,null);assert.equal(sqlCalls.at(-1).values[4],8);});
 await test('actual reader failure is not replaced with fabricated page success',async()=>{globalThis.__historyRead=async()=>{throw Object.assign(new Error('readonly-source-refusal'),{status:503});};const r=await request();assert.equal(r.statusCode,503);assert.equal(r.json().error,'readonly-source-refusal');});
} finally {await app.close();delete globalThis.__historyRead;await rm(tmp,{recursive:true,force:true});}
