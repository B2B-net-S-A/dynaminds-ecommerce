/** AUTHOR_NOT_RUN. Root-only completed-map/history browser host. Import-safe.
 * CLI: tsx scripts/physical-parcel-wz-local-preview.ts <archive|snapshot>
 * <accepted-path> <accepted-sha256> <fresh-private-output-directory>
 * Root must verify API4196/UI5198 free and supply the latest accepted SOURCE
 * after-snapshot after any subsequent native gate; never use archive.copy.
 * No seed/migrate/workers/provider transport; the only admitted write is one
 * genuine normal browser password login. This is not full operator-flow QA. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {createConnection} from 'node:net';
import pg from 'pg';
import {captureDatabase,guardNames} from '../data/source-drafts/b2b-financial-return162-root-capture189';

type Artifact={path:string;sha256:string};
export type PhysicalParcelWzPreviewInput={accepted:Artifact&{kind:'archive'|'snapshot'};directory:string};
const base=resolve('data/qa-physical-parcel-wz-1791439394750'),database='dynaminds_test_1791439394750';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const self='scripts/physical-parcel-wz-local-preview.ts';
const extraGuards=['competitor_observation_guards','buyer_address_guards','operative_delivery_valid','parcel_physical_wz_valid'] as const;
const captureDependencies=['data/source-drafts/b2b-financial-return162-root-capture189.ts','scripts/stocktake-adjustments-native164-preservation.ts','scripts/return-destinations-native162-restore-readback.ts'];
async function pinned<T=any>(r:Artifact):Promise<T>{assert.match(r.sha256,/^[a-f0-9]{64}$/);const b=await readFile(resolve(r.path));assert.equal(hash(b),r.sha256,'Artifact digest');return JSON.parse(b.toString('utf8'));}
async function sourceMap(){const map:Record<string,string>={};async function visit(d:string){for(const e of await readdir(d,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=d+'/'+e.name;assert(!e.isSymbolicLink(),'Source symlinks unsupported');if(e.isDirectory())await visit(p);else if(e.isFile()&&/\.(ts|tsx|sql|css|json|html)$/.test(e.name))map[p]=hash(await readFile(p));}}await visit('server');await visit('web');for(const p of [...captureDependencies,self,'package.json','package-lock.json','tsconfig.json','vite.config.ts'])map[p]=hash(await readFile(p));return map;}
async function absent(port:number){await new Promise<void>((ok,no)=>{const s=createConnection({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();no(Error('Owned port still listening'));});s.once('error',e=>{s.destroy();if((e as NodeJS.ErrnoException).code==='ECONNREFUSED')ok();else no(e);});s.setTimeout(2000,()=>{s.destroy();no(Error('Owned port observation timed out'));});});}

export async function runPhysicalParcelWzLocalPreview(options:PhysicalParcelWzPreviewInput){
 let app:Awaited<ReturnType<typeof import('../server/app').buildApp>>|undefined;
 let web:Awaited<ReturnType<typeof import('vite').createServer>>|undefined;
 let pool:typeof import('../server/db').pool|undefined;
 let rl:ReturnType<typeof createInterface>|undefined;
 let failure:unknown,before:Awaited<ReturnType<typeof captureDatabase>>|undefined,beforeRef:Artifact|undefined,afterRef:Artifact|undefined;
 let cfgPin:Artifact|undefined,sources:Record<string,string>|undefined,sourcesRef:Artifact|undefined;
 let owner:{user:string;tenant:string}|undefined,make:((name:string)=>pg.Client)|undefined;
 const directory=resolve(options.directory);let directoryReady=false,stopRequested=false,stopResolve:(()=>void)|undefined;
 const stopped=new Promise<void>(r=>{stopResolve=r;});
 const stop=()=>{stopRequested=true;stopResolve?.();};
 const checkStop=()=>{assert(!stopRequested,'Stopped during setup');};
 const journal:Array<{index:number;method:string;route:string;status:number}>=[];
 let entering=0,completed=0,loginReserved=false,deniedWrites=0,providerCalls=0;
 const oldFetch=globalThis.fetch;
 const denyFetch:typeof fetch=async()=>{providerCalls++;throw Error('Provider fetch forbidden in completed history QA');};
 let fetchInstalled=false;
 const closerResults:Array<{resource:string;status:'fulfilled'|'rejected'}>=[];
 async function closeOne(resource:string,fn:()=>Promise<unknown>){try{await fn();closerResults.push({resource,status:'fulfilled'});}catch(e){closerResults.push({resource,status:'rejected'});failure??=e;}}
 async function save(name:string,v:unknown):Promise<Artifact>{assert(directoryReady);const path=resolve(directory,name),b=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,b,{flag:'wx',mode:0o600});return{path,sha256:hash(b)};}
 async function exclusive(){assert(make);const c=make('postgres');try{await c.connect();assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[database])).rows[0].n,0,'Owned DB must have no other clients');}finally{await c.end();}}
 async function capture(){assert(make);const c=make(database);try{await c.connect();const s=await captureDatabase(c,false);for(const n of extraGuards)s.guards[n]=(await c.query('SELECT public.'+n+'() ok')).rows[0].ok;assert.equal(Object.keys(s.graph.rows).length,566);assert.equal(s.graph.rows.migrations.length,168);assert.deepEqual(Object.keys(s.guards).sort(),[...guardNames,'financial_return_upgrade_valid',...extraGuards].sort());assert.equal(Object.keys(s.guards).length,24);assert(Object.values(s.guards).every(v=>v===true));return s;}finally{await c.end();}}
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{
  assert(options.accepted.kind==='archive'||options.accepted.kind==='snapshot');
  const rel=relative(base,directory);assert(rel&&!rel.startsWith('..'+sep)&&rel!=='..'&&!rel.startsWith(sep),'Output must be new private directory within owned QA root');
  await mkdir(directory,{mode:0o700});directoryReady=true;
  const prepRef={path:resolve(base,'preparation.private.json'),sha256:'583d54a7ef0adc6a044e956923c1c5aad09ba37c2cb589fd21042bead78f6ca3'};
  const prep=await pinned(prepRef),input=await pinned(prep.input);assert.equal(input.database,database);
  const native=await pinned({path:resolve(base,'native1/result.private.json'),sha256:'8af4e868e1489e31d6ed47e2803c160c662f8a76d0bdc76b1d63d13a2978149b'});
  assert.equal(native.status,'ROOT_PHYSICAL_WZ_168_NATIVE_FLOW_PASS');assert.equal(native.database,database);
  const install=await pinned(native.install),baseline=await pinned(install.baseline),fixture=await pinned(baseline.fixture);
  assert.deepEqual(baseline.preparation,prepRef);owner={user:fixture.user,tenant:fixture.tenant};
  assert.match(owner.user,/^[a-f0-9-]{36}$/);assert.match(owner.tenant,/^[a-f0-9-]{36}$/);
  assert.equal(fixture.credentials.user_id,owner.user);assert.equal(fixture.credentials.tenant_id,owner.tenant);
  // Credentials remain in runtime RAM only; no cookies/passwords in journal or stdout.
  cfgPin=input.configuration;assert(cfgPin);const cfgBytes=await readFile(cfgPin.path);assert.equal(hash(cfgBytes),cfgPin.sha256);
  const st=await lstat(cfgPin.path);assert(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o777)===0o600);const cfg=JSON.parse(cfgBytes.toString());
  const u=new URL(input.environment.DATABASE_URL);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55432');assert.equal(u.pathname,'/'+database);assert.equal(resolve(input.environment.DYNA_LOCAL_CONFIG_PATH),resolve(cfgPin.path));
  make=name=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:name});
  sources=await sourceMap();sourcesRef=await save('sources.private.json',sources);
  let expected:Awaited<ReturnType<typeof captureDatabase>>;
  if(options.accepted.kind==='archive'){
   const accepted=await pinned(options.accepted);assert.equal(accepted.status,'ROOT_PHYSICAL_WZ_168_ACTUAL_ENCRYPTED_ARCHIVE_RESTORE_PASS');assert.equal(accepted.source_database,database);assert.equal(accepted.owned_clients_and_runtime_pool_closed,true);
   expected=await pinned(accepted.after);const archivedSources=await pinned<Record<string,string>>(accepted.sources);
   for(const[p,h]of Object.entries(archivedSources)){const actual=hash(await readFile(p));if(p==='web/warehouse-wz-issued-documents.tsx'&&actual!==h){assert.equal(h,'bc74ace3ba55638ba0bd670362d1e1252403eae6b5ca03e2cacaec6f2522dd93');assert.equal(actual,'0d29e64e5e8318b9960845bc45ae996392ed4e53a831a48bff3102118655d55e');}else assert.equal(actual,h,'Accepted archive source '+p);}
  }else expected=await pinned(options.accepted);
  checkStop();await exclusive();before=await capture();assert.deepEqual(before,expected,'Exact latest accepted source snapshot before browser');beforeRef=await save('before.private.json',before);
  assert(before.graph.rows.users.some(x=>x.row.id===owner!.user&&x.row.tenant_id===owner!.tenant),'Fixture owner is genuine source user');
  // Config/environment precede BOTH runtime imports; import pool first so any
  // app import/build failure still has an owned pool closer registered.
  Object.assign(process.env,input.environment,{DYNA_TEST:'true',DYNA_WORKER_DISABLED:'true',DYNA_IMAGE_DIR:input.images,DYNA_PG_TOOLS:input.pg_tools,APP_REVISION:'local-physical-wz168-history'});
  globalThis.fetch=denyFetch;fetchInstalled=true;
  pool=(await import('../server/db')).pool;checkStop();const {buildApp}=await import('../server/app');
  app=await buildApp({logging:false,backgroundWorkersEnabled:false,trustedLocalUiOrigin:'http://localhost:5198',integrationTransport:async()=>{providerCalls++;throw Error('Provider transport forbidden in completed history QA');}});
  app.addHook('onRequest',async(req,reply)=>{entering++;if(!['GET','HEAD','OPTIONS'].includes(req.method)){if(req.method==='POST'&&req.url==='/api/auth/login'&&!loginReserved){loginReserved=true;}else{deniedWrites++;return reply.code(423).send({status:423,title:'Completed history QA only admits one browser login'});}}});
  app.addHook('onResponse',async(req,reply)=>{journal.push({index:completed++,method:req.method,route:req.routeOptions.url??'[unregistered]',status:reply.statusCode});});
  checkStop();await app.listen({host:'127.0.0.1',port:4196});checkStop();const {createServer}=await import('vite');
  web=await createServer({server:{host:'127.0.0.1',port:5198,strictPort:true,proxy:{'/api/':'http://127.0.0.1:4196'}}});await web.listen();checkStop();
  rl=createInterface({input:process.stdin});rl.on('line',line=>{if(line.trim()==='STOP')stop();});rl.on('close',()=>{if(!stopRequested){failure??=Error('Stdin closed before explicit STOP');stop();}});
  console.log(JSON.stringify({status:'ROOT_PHYSICAL_WZ_168_COMPLETED_HISTORY_READY',pid:process.pid,database,web:'http://localhost:5198',directory,workers:false,seed:false,migrate:false,scope:'completed map/history only'}));
  await stopped;
 }catch(e){failure??=e;}
 finally{
  // Sequential unconditional resource closure, then snapshot. Failed I/O or
  // failed assertions never skip another owned closer and never emit PASS.
  rl?.removeAllListeners();rl?.close();process.stdin.pause();
  if(web)await closeOne('vite',()=>web!.close());
  if(app)await closeOne('app',()=>app!.close());
  if(pool)await closeOne('pool',()=>pool!.end());
  try{
   if(before&&make){await exclusive();const after=await capture();afterRef=await save('after.private.json',after);
    const old=before.graph.rows.sessions,current=after.graph.rows.sessions,oldKeys=new Set(old.map(x=>x.row.token_hash));
    const added=current.filter(x=>!oldKeys.has(x.row.token_hash));assert.equal(added.length,1,'Exactly one genuine browser login session');assert.equal(current.length,old.length+1);
    for(const r of old)assert.deepEqual(current.find(x=>x.row.token_hash===r.row.token_hash),r,'Every old session literal');
    assert(owner);assert.equal(added[0].row.user_id,owner.user);assert.equal(added[0].row.tenant_id,owner.tenant);assert.match(added[0].row.token_hash,/^[a-f0-9]{64}$/);
    assert.deepEqual({...after,graph:{...after.graph,rows:{...after.graph.rows,sessions:old}}},before,'All566 other rows/metadata/guards/PK/sequence options/views literal');
    assert.equal(deniedWrites,0);assert(entering<=completed,'Native auth may refuse before the QA onRequest hook; app.close drains every response');
    const writes=journal.filter(x=>!['GET','HEAD','OPTIONS'].includes(x.method));assert.equal(writes.length,1);assert.equal(writes[0].method,'POST');assert.equal(writes[0].route,'/api/auth/login');assert.equal(writes[0].status,200);
   }
   if(app)assert.equal(app.server.listening,false);if(web)assert.equal(web.httpServer?.listening,false);
   if(app||web){await absent(4196);await absent(5198);}
   if(cfgPin)assert.equal(hash(await readFile(cfgPin.path)),cfgPin.sha256);
   if(sources)assert.deepEqual(await sourceMap(),sources,'Whole current source map literal');
   assert.equal(providerCalls,0);if(fetchInstalled)assert.equal(globalThis.fetch,denyFetch,'Own fetch hook custody');
  }catch(e){failure??=e;}
  if(fetchInstalled)globalThis.fetch=oldFetch;
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
  if(directoryReady){try{await save('requests.private.json',journal);await save('cleanup.private.json',{status:failure?'FAILED':'PASS',closers:closerResults,provider_calls:providerCalls,requests_seen_by_qa_on_request:entering,requests_completed:completed,denied_writes:deniedWrites});}catch(e){failure??=e;}}
 }
 if(failure){if(directoryReady)try{await save('failure.private.json',{name:failure instanceof Error?failure.name:'Error',message:failure instanceof Error?failure.message:String(failure),stack:failure instanceof Error?failure.stack:undefined});}catch{/* Root preserves terminal failure even if private I/O also fails. */}console.log(JSON.stringify({status:'ROOT_PHYSICAL_WZ_168_COMPLETED_HISTORY_FAILED',directory}));throw Error('Owned completed history QA failed; inspect private evidence');}
 try{assert(beforeRef&&afterRef&&sourcesRef);const result=await save('result.private.json',{status:'ROOT_PHYSICAL_WZ_168_COMPLETED_HISTORY_CLOSED_PASS',database,accepted:options.accepted,before:beforeRef,after:afterRef,sources:sourcesRef,tables:566,migrations:168,guards:24,one_genuine_owner_browser_login:true,all_old_sessions_literal:true,all_other_rows_and_metadata_literal:true,provider_calls:providerCalls,workers_seed_migrate:false,owned_resources_closed:true,browser_visual_proof:'ROOT_SEPARATE',new_operator_mapping_flow:'NOT_RUN'});console.log(JSON.stringify({status:'ROOT_PHYSICAL_WZ_168_COMPLETED_HISTORY_CLOSED_PASS',result}));return result;}catch(e){try{await save('failure.private.json',{name:e instanceof Error?e.name:'Error',message:e instanceof Error?e.message:String(e),stage:'final-result-file'});}catch{}console.log(JSON.stringify({status:'ROOT_PHYSICAL_WZ_168_COMPLETED_HISTORY_FAILED',directory}));throw Error('Final private receipt failed after resource closure');}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const[kind,path,sha256,directory]=process.argv.slice(2);if((kind!=='archive'&&kind!=='snapshot')||!path||!sha256||!directory||process.argv.length!==6){console.error('Usage: <archive|snapshot> <accepted-path> <sha256> <fresh-output-directory>');process.exitCode=1;}else await runPhysicalParcelWzLocalPreview({accepted:{kind,path,sha256},directory}).catch(()=>{process.exitCode=1;});}
