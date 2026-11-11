/** Owned local UI preview without seeds/migrations/workers. Before/after capture. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const input=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));assert.equal(input.database,'dynaminds_test_1791436044774');
const target=new URL(input.environment.DATABASE_URL);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55432');assert.equal(target.pathname,'/'+input.database);assert.equal(resolve(input.environment.DYNA_LOCAL_CONFIG_PATH),resolve(input.configuration.path));
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const directory=resolve(input.directory,'chrome-xml1');await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),b=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,b,{flag:'wx',mode:0o600});return{path,sha256:hash(b)};}
const make=(db:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:db});
async function capture(){const c=make(input.database);try{await c.connect();return await captureDatabase(c,false);}finally{await c.end();}}
const before=await capture(),beforeRef=await save('before.private.json',before);
Object.assign(process.env,input.environment,{DYNA_IMAGE_DIR:input.images,DYNA_PG_TOOLS:input.pg_tools,DYNA_WORKER_DISABLED:'true'});
const {pool}=await import('../server/db'),{buildApp}=await import('../server/app');
let providerCalls=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{++providerCalls;throw Error('Preview external fetch forbidden');};
const app=await buildApp({logging:false,backgroundWorkersEnabled:false,trustedLocalUiOrigin:'http://localhost:5197',integrationTransport:async()=>{++providerCalls;throw Error('Preview provider transport forbidden');}});
await app.listen({host:'127.0.0.1',port:4195});const {createServer}=await import('vite');
const web=await createServer({server:{host:'127.0.0.1',port:5197,strictPort:true,proxy:{'/api/':'http://127.0.0.1:4195'}}});await web.listen();
console.log(JSON.stringify({status:'ROOT_FA3_XML_LOCAL_UI_READY',pid:process.pid,database:input.database,web:'http://localhost:5197',directory,workers:false,seed:false,migrate:false}));
let closing=false;
async function close(){if(closing)return;closing=true;let failure:unknown;
 try{await web.close();await app.close();await pool.end();const after=await capture(),afterRef=await save('after.private.json',after);
  const oldSessions=before.graph.rows.sessions;assert.equal(after.graph.rows.sessions.length,oldSessions.length+1);
  for(const r of oldSessions)assert(after.graph.rows.sessions.some((n:any)=>hash(JSON.stringify(n))===hash(JSON.stringify(r))));
  assert.deepEqual({...after,graph:{...after.graph,rows:{...after.graph.rows,sessions:oldSessions}}},before,'Only genuine browser login adds a session; all other562 rows/metadata/sequences literal');
  assert.equal(providerCalls,0);assert.equal(hash(await readFile(input.configuration.path)),input.configuration.sha256);
  const admin=make('postgres');try{await admin.connect();assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[input.database])).rows[0].n,0);}finally{await admin.end();}
  const result=await save('closure.private.json',{status:'ROOT_FA3_XML_CHROME_PREVIEW_CLOSED',database:input.database,before:beforeRef,after:afterRef,only_one_genuine_browser_login_session_added:true,whole562_other_rows_and_metadata_literal:true,provider_calls:providerCalls,owned_clients_closed:true,owned_listeners_closed:true});console.log(JSON.stringify({status:'ROOT_FA3_XML_CHROME_PREVIEW_CLOSED',result}));
 }catch(e){failure=e;await save('failure.private.json',{name:(e as any)?.name,message:(e as any)?.message,stack:(e as any)?.stack});console.log(JSON.stringify({status:'ROOT_FA3_XML_CHROME_PREVIEW_CLOSE_FAILED',directory}));}
 finally{globalThis.fetch=oldFetch;process.exit(failure?1:0);}
}
process.on('SIGINT',close);process.on('SIGTERM',close);
