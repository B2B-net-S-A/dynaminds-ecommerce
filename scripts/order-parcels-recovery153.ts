/** ROOT ONLY, one shot. Source authoring is not a recovery result.
 * Run from the primary app after QA153 release/RMA acceptance; no migrations.
 * Restores its own encrypted archive into a random database, probes only that copy,
 * and removes only its own child process/database. Archives and custody remain private.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, open, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const root='<workspace>/app',port=4108;
const revision=process.env.QA_EXPECTED_REVISION??'',schema='138_order_parcel_returns';
const fixturePath=resolve(root,'data/order-parcels-stage153.json');
const checkpointPath=resolve(root,'data/order-parcels-stage153-after-release-checkpoint.json');
const journalPath=resolve(root,'data/order-parcels-stage153-recovery.json');
const reportPath=resolve(root,'docs/order-parcels-native153-recovery.json');
const runId=randomUUID(),backupDir=resolve(root,'data/backups/order-parcels153-'+runId),restoreDir=resolve(root,'data/restores/order-parcels153-'+runId);
type Row=Record<string,any>;type Rows=Record<string,Row[]>;
type Recovery=typeof import('../server/recovery');
const tables=['order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments','order_parcel_release_previews','order_parcel_releases','order_parcel_release_admissions','order_parcel_return_claims','order_parcel_return_receipts','order_parcel_return_admissions'];
const privateTables=new Set(['order_parcel_release_admissions','order_parcel_return_admissions']);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
async function fileSha(path:string){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
const uuid=(v:unknown):string=>{assert.equal(typeof v,'string');assert.match(v as string,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);return v as string;};
const one=(r:Row[])=>{assert.equal(r.length,1,'Unique own graph identity');return r[0];};
let step='preflight',journal:Row|undefined,ownedDatabase:string|undefined,child:ChildProcess|undefined,childExited=false;
let source:pg.Client|undefined,copy:pg.Client|undefined,recovery:Recovery|undefined,pool:pg.Pool|undefined;
let beforeManifest:Row|undefined,beforeSchema:string|undefined,beforeDatabases:string[]|undefined;
let report:Row|undefined,outputReserved=false,ownedDatabaseDropped=false;
const preserved=new Map<string,Buffer>();
async function absent(path:string){try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive output already exists');}
async function privateRead(path:string){const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&0o777,0o600);assert(s.size<=64*1024*1024);const b=await readFile(path);preserved.set(path,b);return b;}
async function wx(path:string,value:unknown){const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}}
async function custody(label:string,action:()=>Promise<void>){assert(journal&&journal.pending===null);step=label;journal.pending={step:label,started_at:new Date().toISOString()};await save();await action();journal.completed.push({step:label,completed_at:new Date().toISOString()});journal.pending=null;await save();}
async function save(){assert(journal);const s=await lstat(journalPath);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&0o777,0o600);const tmp=journalPath+'.'+randomUUID()+'.tmp';await wx(tmp,journal);await rename(tmp,journalPath);const d=await open(dirname(journalPath),'r');try{await d.sync();}finally{await d.close();}}
async function rr<T>(c:pg.Client,fn:()=>Promise<T>){await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{await c.query("SET LOCAL TimeZone='UTC'");const r=await fn();await c.query('COMMIT');return r;}finally{await c.query('ROLLBACK').catch(()=>{});}}
async function capture(c:pg.Client,a:Row){
 const names=(await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND(table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY 1")).rows.map(r=>r.table_name as string);
 const rows:Rows={};for(const n of names){assert.match(n,/^[a-z_][a-z0-9_]*$/);const key=['users','tenants'].includes(n)?'id':'tenant_id';rows[n]=(await c.query(`SELECT to_jsonb(q) row FROM "${n}" q WHERE ${key}=$1 ORDER BY 1`,[n==='users'?a.user_id:a.tenant_id])).rows.map(r=>r.row);}
 return {rows,snapshot:Object.fromEntries(Object.entries(rows).map(([n,r])=>[n,{count:r.length,sha256:hash(r.map(row=>({row})))}]))};
}
function graph(a:Row,rows:Rows){
 const order=one(rows.orders.filter(r=>r.id===a.order_id));assert.equal(order.status,'shipped');assert.equal(order.total,11900);assert.equal(order.currency,'PLN');
 assert.deepEqual(rows.order_items.filter(r=>r.order_id===order.id).map(r=>r.line_total).sort((x,y)=>x-y),[1000,3400,7500]);
 const plan=one(rows.order_parcel_plans.filter(r=>r.order_id===order.id));assert.equal(plan.payload.protocol,'commercial_v1');
 const release=one(rows.order_parcel_releases.filter(r=>r.order_id===order.id));assert.equal(release.plan_id,plan.id);assert.equal(release.receipt.operation_id,release.id);
 const dispatches=rows.order_parcel_dispatches.filter(r=>r.plan_id===plan.id);assert(dispatches.length>=1);
 const cancelled=new Set<number>(release.payload.pending.map((p:Row)=>p.index));assert(cancelled.size>=1);
 for(const allocation of rows.order_parcel_allocations.filter(r=>r.plan_id===plan.id)){const d=dispatches.filter(r=>r.parcel_index===allocation.index);assert.equal(d.length,cancelled.has(allocation.index)?0:1);const shipment=one(rows.shipments.filter(r=>r.id===allocation.shipment_id));assert.equal(Boolean(shipment.dispatched_at),d.length===1);}
 const rma=one(rows.return_cases.filter(r=>r.order_id===order.id));assert.equal(rma.state,'refund_pending');assert.equal(rma.remedy,'refund');assert.equal(rma.refund_amount,5200);assert.equal(rma.refunded_shipping,0);assert.equal(rma.refunded_at,null);assert.equal(rma.settlement,null);
 const lines=rows.return_items.filter(r=>r.return_id===rma.id);assert.equal(lines.reduce((n,r)=>n+r.accepted,0),3);assert.equal(lines.reduce((n,r)=>n+r.restocked,0),3);assert.equal(lines.reduce((n,r)=>n+r.refund_amount,0),5200);
 const receipt=one(rows.order_parcel_return_receipts.filter(r=>r.return_id===rma.id));assert.deepEqual(receipt.body,rma.receipt);
 const claims=rows.order_parcel_return_claims.filter(r=>r.return_id===rma.id);assert.equal(claims.reduce((n,r)=>n+r.quantity,0),3);
 for(const claim of claims){const origin=one(rows.order_parcel_commercial_origins.filter(r=>r.id===claim.origin_id));const issue=one(rows.order_parcel_origin_issues.filter(r=>r.origin_id===origin.id&&r.dispatch_id===claim.dispatch_id));assert.equal(origin.item_id,claim.item_id);assert.equal(origin.order_id,order.id);assert(issue.quantity>=claim.quantity);}
 for(const [name,c,l] of [['A',3,3],['B',2,4]] as const){assert(Array.isArray(a.components));const id=uuid(one(a.components.filter((p:Row)=>p.letter===name)).id);const s=one(rows.stock.filter(r=>r.product_id===id));assert.equal(s.on_hand,10);assert.equal(s.reserved,0);assert.equal(s.available,10);
  const reservations=rows.reservations.filter(r=>r.order_id===order.id&&r.product_id===id);const reservation=one(reservations);assert.equal(reservation.quantity,6);assert.equal(reservation.consumed_quantity,c);assert.equal(reservation.released_quantity,l);assert.equal(reservation.state,'released');
  for(const t of ['reservations','reservation_locations','wms_reservation_layers'])for(const hold of rows[t].filter(r=>r.order_id===order.id&&r.product_id===id)){const remaining=hold.quantity-hold.consumed_quantity-hold.released_quantity;assert.equal(remaining,0);assert.equal(hold.quantity,hold.consumed_quantity+hold.released_quantity+remaining);assert(hold.consumed_quantity>=0&&hold.released_quantity>=0);}
  if(a.on){const holds=rows.wms_reservation_layers.filter(r=>r.order_id===order.id&&r.product_id===id);assert(holds.length>0);assert.equal(holds.reduce((n,r)=>n+r.quantity,0),6);assert.equal(holds.reduce((n,r)=>n+r.consumed_quantity,0),c);assert.equal(holds.reduce((n,r)=>n+r.released_quantity,0),l);}
 }
 const payments=rows.payment_entries.filter(r=>r.order_id===order.id);assert.equal(payments.length,1);assert.equal(payments[0].kind,'receipt');assert.equal(payments[0].amount,11900);assert.equal(rows.documents.filter(r=>r.order_id===order.id).length,0);
 for(const f of rows.wms_return_fragments.filter(r=>r.return_id===rma.id)){const issue=one(rows.wms_issue_fragments.filter(r=>r.id===f.issue_fragment_id));assert.equal(issue.order_id,order.id);assert.equal(f.product_id,issue.product_id);assert.equal(f.layer_id,issue.layer_id);if(issue.unit_cost_minor===null)assert.equal(f.value_minor,null);else assert.equal(BigInt(f.value_minor),BigInt(issue.unit_cost_minor)*BigInt(f.quantity));assert(rows.order_parcel_origin_fragments.some(m=>m.fragment_id===issue.id&&m.dispatch_id===issue.operation_id));}
 const returned=rows.wms_return_fragments.filter(r=>r.return_id===rma.id);
 if(a.on){assert.equal(returned.reduce((n,r)=>n+r.quantity,0),5);assert.equal(returned.reduce((n,r)=>n+BigInt(r.value_minor),0n),2000n);for(const [name,quantity] of [['A',3],['B',2]] as const){const component=one(a.components.filter((p:Row)=>p.letter===name));assert.equal(returned.filter(r=>r.product_id===component.id).reduce((n,r)=>n+r.quantity,0),quantity);}}else assert.equal(returned.length,0);
 return {order_id:order.id,plan_id:plan.id,release_id:release.id,preview_id:release.preview_id,return_id:rma.id,dispatches:dispatches.length};
}
async function rollback(c:pg.Client,fn:()=>Promise<void>){await c.query('BEGIN');try{await fn();}finally{await c.query('ROLLBACK');}}
async function deny(c:pg.Client,sql:string,args:unknown[],code:string,message?:string){let error:any;try{await c.query(sql,args);}catch(e){error=e;}assert(error,'Expected explicit denial');assert.equal(error.code,code);if(message)assert.equal(error.message,message);}
async function guards(c:pg.Client,a:Row,rows:Rows,foreign:string){
 assert.equal((await c.query('SELECT order_parcel_guards() AND order_parcel_installed() AND order_parcel_commercial_guards() AND order_parcel_release_guards() AND order_parcel_return_installed() ok')).rows[0].ok,true);
 for(const t of tables){const s=(await c.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[t])).rows[0];assert(s.relrowsecurity&&s.relforcerowsecurity);assert.equal((await c.query("SELECT has_table_privilege('dyna_app',$1,'INSERT,UPDATE,DELETE') allowed",[t])).rows[0].allowed,false);
  await rollback(c,async()=>{await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenant_id]);await deny(c,`DELETE FROM ${t} WHERE false`,[],'42501');});
  if(privateTables.has(t)){await rollback(c,async()=>{await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenant_id]);await deny(c,`SELECT * FROM ${t}`,[],'42501');});}
  else {await rollback(c,async()=>{await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[foreign]);assert.equal((await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`,[a.tenant_id])).rows[0].n,0);});
   if(rows[t].length)await rollback(c,()=>deny(c,`UPDATE ${t} SET tenant_id=tenant_id WHERE tenant_id=$1`,[a.tenant_id],'23514',t.startsWith('order_parcel_origin')||t==='order_parcel_commercial_origins'?'Pochodzenie handlowe paczki jest niezmienne i wymaga rzeczywistej operacji':t.startsWith('order_parcel_return')?'Pochodzenie zwrotu jest niezmienne':'Dowód zwolnienia paczek jest niezmienny'));
  }
 }
 const functions=(await c.query("SELECT oid::regprocedure::text signature,has_function_privilege('dyna_app',oid,'EXECUTE') app_exec,EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_exec FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'order_parcel_return_%' OR proname LIKE 'order_parcel_release_%' OR proname LIKE 'order_parcel_commercial_%') ORDER BY 1")).rows;
 const publicFunctions=new Set(['order_parcel_commercial_installed()','order_parcel_commercial_guards()','order_parcel_commercial_lines(uuid)','order_parcel_release_installed()','order_parcel_release_guards()','order_parcel_release_source(uuid,uuid,uuid)','order_parcel_release_store_preview(uuid,uuid,jsonb,uuid,uuid)','order_parcel_release_prepare(uuid,uuid,jsonb,uuid,uuid)','order_parcel_release_scope(uuid,uuid,uuid)','order_parcel_release_finish(uuid,jsonb,uuid,uuid)','order_parcel_return_installed()','order_parcel_return_lock(uuid,uuid,uuid)','order_parcel_return_request(uuid,uuid,uuid,uuid,jsonb)','order_parcel_return_finish_request(uuid,uuid,uuid)','order_parcel_return_prepare_receive(uuid,uuid,uuid,jsonb,jsonb)','order_parcel_return_finish_receive(uuid,uuid,uuid)','order_parcel_return_decision(uuid,uuid,uuid,jsonb)']);
 for(const f of functions){assert.equal(f.public_exec,false);assert.equal(f.app_exec,publicFunctions.has(f.signature));}
 assert(functions.length>publicFunctions.size);return {force_rls:9,app_write_denials:9,private_select_denials:2,foreign_scope_tables:7,private_function_acl:true};
}
async function request(base:string,path:string,cookie='',method='GET',raw?:string,tenant?:string){assert(path.startsWith('/')&&!path.startsWith('//'));return fetch(base+'/api'+path,{method,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),headers:{...(cookie?{cookie}:{}),...(tenant?{'X-Workspace-ID':tenant}:{}),...(raw===undefined?{}:{'Content-Type':'application/json'})},...(raw===undefined?{}:{body:raw})});}
async function health(base:string,preview:boolean){const r=await request(base,'/health');assert.equal(r.status,200);const h:Row=await r.json();assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,schema);assert.equal(h.restore_preview,preview);assert.equal(h.background_workers_enabled,false);assert.equal(h.order_parcels_available,true);assert.equal(h.order_parcel_releases_available,true);}
async function http(a:Row,e:Row){
 const base=`http://127.0.0.1:${port}`;const login=await request(base,'/auth/login','','POST',JSON.stringify({email:a.email,password:a.password}));assert.equal(login.status,200);let cookie=login.headers.get('set-cookie')?.split(';')[0]??'';assert(cookie.startsWith('dyna_session_preview_'+port+'='));
 const loginBody:Row=await login.json();if(loginBody.user?.tenant_id!==a.tenant_id){const sw=await request(base,'/workspaces/switch',cookie,'POST',JSON.stringify({tenant_id:a.tenant_id}));assert.equal(sw.status,200);cookie=sw.headers.get('set-cookie')?.split(';')[0]??'';}
 const me=await request(base,'/auth/me',cookie);assert.equal(me.status,200);const actor:Row=await me.json();assert.equal(actor.user.id,a.user_id);assert.equal(actor.user.tenant_id,a.tenant_id);assert.equal((await request(base,'/auth/me',a.cookie)).status,401);assert.equal((await request('http://127.0.0.1:4100','/auth/me',cookie)).status,401);
 async function get(path:string){const r=await request(base,path,cookie,'GET',undefined,a.tenant_id);assert.equal(r.status,200);assert.match(r.headers.get('cache-control')??'',/no-store/);const b=Buffer.from(await r.arrayBuffer());assert(b.length<=8*1024*1024);return JSON.parse(b.toString('utf8')) as Row;}
 const plan=await get('/order-parcels/plans/'+e.plan_id);assert.equal(plan.read_only,true);assert.equal(plan.can_write,false);assert.equal(plan.plan.id,e.plan_id);assert(plan.plan.progress.every((r:Row)=>['cancelled','dispatched'].includes(r.state)));
 const release=await get('/order-parcel-releases/releases/'+e.release_id);assert.equal(release.read_only,true);assert.equal(release.can_write,false);assert.equal(release.release.id,e.release_id);
 const preview=await get('/order-parcel-releases/previews/'+e.preview_id);assert.equal(preview.preview.can_release,false);assert.equal(preview.read_only,true);
 const rma=await get('/returns/'+e.return_id);assert.equal(rma.id,e.return_id);assert.equal(rma.refund_amount,5200);assert.equal(rma.state,'refund_pending');assert.equal(rma.parcel_origins_required,true);
 const source=await get('/order-parcels/orders/'+e.order_id+'/source');assert.equal(source.read_only,true);assert.equal(source.can_write,false);assert.equal(source.source.can_preview,false);
 const writes=[`/order-parcel-releases/plans/${e.plan_id}/previews`,`/order-parcel-releases/previews/${e.preview_id}/release`,`/order-parcels/previews/${plan.plan.preview_id}/apply`,`/order-parcels/plans/${e.plan_id}/parcels/1/dispatch`,`/orders/${e.order_id}/returns`,`/returns/${e.return_id}/receive`];
 for(const path of writes)for(const prefix of ['', '/v1'])assert.equal((await request(base,prefix+path,cookie,'POST','{',a.tenant_id)).status,423,'Restore denies write before malformed body parsing');
 return {metadata_reads:5,malformed_write_denials:12,main_copy_cookie_isolation:true};
}
async function freePort(){await new Promise<void>((ok,bad)=>{const s=createServer();s.once('error',bad);s.listen(port,'127.0.0.1',()=>s.close(e=>e?bad(e):ok()));});}
async function stopChild(){if(!child||childExited)return;const p=child;await new Promise<void>((ok,bad)=>{const timer=setTimeout(()=>{p.kill('SIGKILL');bad(Error('Owned preview shutdown timeout'));},10000);p.once('exit',()=>{clearTimeout(timer);childExited=true;ok();});p.kill('SIGINT');});}
try{
 assert.equal(process.cwd(),root);assert.match(revision,/^[a-f0-9]{40}$/);assert.equal(process.env.DYNA_WORKER_DISABLED,'true');assert.equal(process.env.QA153_RECOVERY_VERIFIED,'true');
 for(const path of [journalPath,reportPath,backupDir,restoreDir])await absent(path);await freePort();
 const fixtureBytes=await privateRead(fixturePath),checkpointBytes=await privateRead(checkpointPath),fixture:Row=JSON.parse(fixtureBytes.toString()),cp:Row=JSON.parse(checkpointBytes.toString());
 assert.equal(fixture.pending,null);assert.equal(fixture.complete,true);assert(fixture.off&&fixture.on);assert.equal(cp.stage,153);assert.equal(cp.phase,'after-release');assert.equal(cp.revision,revision);assert.equal(cp.schema_revision,schema);assert.equal(cp.setup_file_sha256,sha(fixtureBytes));assert.equal(cp.firms.length,2);
 const actors=[{...fixture.off,on:false},{...fixture.on,on:true}];for(const a of actors){uuid(a.tenant_id);uuid(a.user_id);uuid(a.order_id);assert(typeof a.cookie==='string'&&typeof a.password==='string'&&typeof a.email==='string');const accepted=one(cp.firms.filter((f:Row)=>f.tenant_id===a.tenant_id&&f.user_id===a.user_id&&f.order_id===a.order_id));assert.equal(accepted.evidence.phase,'after-release');assert.equal(accepted.on,a.on);}
 assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,resolve(root,'.local.json'));await privateRead(resolve(root,'.local.json'));const keyPath=resolve(root,'.recovery-key');await privateRead(keyPath);
 recovery=await import('../server/recovery');const db=await import('../server/db');pool=db.pool;const local=recovery.localDatabase();assert.equal(local.database,'dynaminds');await recovery.recoveryKey(keyPath,false);
 await health('http://127.0.0.1:4100',false);source=new pg.Client(local);await source.connect();
 const sourceBefore=await rr(source,async()=>{assert.deepEqual((await source!.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0],{role:'postgres',db:'dynaminds',host:'127.0.0.1',port:55432});
  const own=[];for(const a of actors){const captured=await capture(source!,a),accepted=one(cp.firms.filter((f:Row)=>f.tenant_id===a.tenant_id));assert.deepEqual(captured.snapshot,accepted.snapshot);assert.deepEqual(captured.rows,accepted.rows);own.push({a,captured,e:graph(a,captured.rows)});}return {own,manifest:await recovery!.tableFingerprints(source!),schema:await recovery!.schemaFingerprint(source!)};});
 beforeManifest=sourceBefore.manifest;beforeSchema=sourceBefore.schema;beforeDatabases=(await source.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname);
 journal={stage:153,status:'IN_PROGRESS',run_id:runId,revision,schema_revision:schema,fixture_sha256:sha(fixtureBytes),checkpoint_sha256:sha(checkpointBytes),pending:null,completed:[],backup_directory:backupDir,restore_directory:restoreDir};await wx(journalPath,journal);outputReserved=true;
 let backup:Awaited<ReturnType<Recovery['createBackup']>>|undefined,restored:Awaited<ReturnType<Recovery['restoreBackup']>>|undefined;
 await custody('encrypted-backup',async()=>{backup=await recovery!.createBackup({directory:backupDir,keyFile:keyPath});journal!.backup=backup;});assert(backup);assert.equal(backup.status,'created');assert.equal(backup.source,'dynaminds');assert.equal(backup.encryption,'AES-256-GCM');assert.equal(backup.tables,Object.keys(beforeManifest).length);assert.equal(await fileSha(backup.file),backup.sha256);
 await custody('disposable-restore',async()=>{restored=await recovery!.restoreBackup(backup!.file,{directory:restoreDir,keyFile:keyPath});const name=recovery!.restoreDatabaseName(restored.database);assert(!beforeDatabases!.includes(name));ownedDatabase=name;journal!.restored=restored;});assert(restored&&ownedDatabase);assert.equal(restored.status,'verified');assert.equal(restored.worker_enabled,false);assert.equal(restored.preview_only,true);assert.equal(restored.source,'dynaminds');assert.equal(restored.tables,Object.keys(beforeManifest).length);assert.equal(restored.row_fingerprints_match,true);assert.equal(restored.schema_fingerprint_match,true);
 copy=new pg.Client({...local,database:ownedDatabase});await copy.connect();const initial=await rr(copy,async()=>{assert.deepEqual(await recovery!.tableFingerprints(copy!),beforeManifest);assert.equal(await recovery!.schemaFingerprint(copy!),beforeSchema);const sessions=(await copy!.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY token_hash')).rows;for(const x of sourceBefore.own){const actual=await capture(copy!,x.a);assert.deepEqual(actual,x.captured);graph(x.a,actual.rows);}return {sessions};});
 const probes:Row[]=[];for(const x of sourceBefore.own)await custody('rollback-copy-guards-'+(x.a.on?'on':'off'),async()=>{probes.push(await guards(copy!,x.a,x.captured.rows,actors.find(a=>a.tenant_id!==x.a.tenant_id)!.tenant_id));});
 await rr(copy,async()=>{assert.deepEqual(await recovery!.tableFingerprints(copy!),beforeManifest);assert.equal(await recovery!.schemaFingerprint(copy!),beforeSchema);});
 await custody('readonly-preview-start',async()=>{child=spawn(process.execPath,['--import','tsx','scripts/restore-preview.ts','--result',resolve(restored!.directory,'result.json')],{cwd:root,env:{...process.env,DYNA_PREVIEW_PORT:String(port),DYNA_WORKER_DISABLED:'true',APP_REVISION:revision},stdio:'ignore'});child.once('exit',()=>{childExited=true;});child.once('error',()=>{childExited=true;});let ready=false;for(let i=0;i<60&&!childExited;i++){try{await health(`http://127.0.0.1:${port}`,true);ready=true;break;}catch{}await delay(250);}assert(ready,'Owned read-only preview ready');});
 const api:Row[]=[];for(const x of sourceBefore.own)await custody('readonly-copy-login-'+(x.a.on?'on':'off'),async()=>{api.push(await http(x.a,x.e));});
 await rr(copy,async()=>{const after=await recovery!.tableFingerprints(copy!);for(const [n,fp] of Object.entries(beforeManifest!))if(n!=='sessions')assert.deepEqual(after[n],fp);assert.equal(await recovery!.schemaFingerprint(copy!),beforeSchema);for(const x of sourceBefore.own)assert.deepEqual(await capture(copy!,x.a),x.captured);
  const sessions=(await copy!.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY token_hash')).rows;for(const old of initial.sessions)assert.deepEqual(one(sessions.filter(r=>r.row.token_hash===old.row.token_hash)),old);const fresh=sessions.filter(r=>!initial.sessions.some(o=>o.row.token_hash===r.row.token_hash));assert.equal(fresh.length,2);for(const a of actors)assert.equal(fresh.filter(r=>r.row.user_id===a.user_id&&r.row.tenant_id===a.tenant_id).length,1);
 });
 report={status:'PASS',stage:153,phase:'encrypted_native_restore',revision,schema_revision:schema,whole_instance_tables:Object.keys(beforeManifest).length,own_tables:cp.firms.map((f:Row)=>Object.keys(f.snapshot).length),whole_manifest_before_preview_exact:true,whole_schema_acl_exact:true,nine_tables_exact:true,quantity_conservation:true,accepted_checkpoint_sha256:sha(checkpointBytes),probes,api,sessions_only_added:2,provider_calls:0,paper_verified:false,raw_late_pin_verified:false,full_goal_complete:false};
}catch(e){const x=e as {name?:string;code?:string};if(journal)journal.private_error=e instanceof Error?{name:e.name,message:e.message,stack:e.stack}:String(e);report={status:'FAIL',stage:153,step,error:x.name??'Error',code:x.code??null,full_goal_complete:false};process.exitCode=1;}
finally{
 const failures:string[]=[];const attempt=async(label:string,fn:()=>Promise<unknown>)=>{try{await fn();}catch{failures.push(label);}};
 await attempt('owned-preview-stop',stopChild);await attempt('owned-copy-disconnect',async()=>{await copy?.end();});
 if(recovery&&pool&&ownedDatabase&&beforeDatabases&&!beforeDatabases.includes(ownedDatabase))await attempt('owned-database-drop',async()=>{await pool!.query(`DROP DATABASE ${recovery!.restoreDatabaseName(ownedDatabase!)} WITH (FORCE)`);ownedDatabaseDropped=true;});
 if(source&&recovery&&beforeManifest&&beforeSchema)await attempt('source-preserved',()=>rr(source!,async()=>{assert.deepEqual(await recovery!.tableFingerprints(source!),beforeManifest);assert.equal(await recovery!.schemaFingerprint(source!),beforeSchema);await health('http://127.0.0.1:4100',false);}));
 for(const [path,bytes] of preserved)await attempt('private-bytes-preserved',async()=>{const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&0o777,0o600);assert.equal(sha(await readFile(path)),sha(bytes));});
 if(source&&beforeDatabases)await attempt('database-inventory-preserved',async()=>{assert.deepEqual((await source!.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname),beforeDatabases);});
 await attempt('source-disconnect',async()=>{await source?.end();});await attempt('pool-disconnect',async()=>{await pool?.end();});
 if(failures.length){process.exitCode=1;report={...report,status:'FAIL',cleanup_failures:failures};}
 if(outputReserved){await attempt('custody-final',async()=>{journal!.status=report?.status==='PASS'?'PASS':'FAIL';journal!.stopped_at=new Date().toISOString();journal!.cleanup_failures=failures;await save();});if(failures.length)report={...report,status:'FAIL',cleanup_failures:failures};await attempt('report-exclusive',()=>wx(reportPath,{...report,source_and_private_files_preserved:!failures.length,owned_database_created:Boolean(ownedDatabase),owned_database_removed:ownedDatabaseDropped,owned_preview_started:Boolean(child),owned_preview_stopped:Boolean(child)&&childExited&&!failures.includes('owned-preview-stop'),archive_retained_private:Boolean(journal!.backup)}));}
 if(failures.length)process.exitCode=1;
 process.stdout.write(JSON.stringify({status:process.exitCode?'FAIL':'PASS',stage:153,step:process.exitCode?step:'complete',code:report?.code??null,full_goal_complete:false})+'\n');
}
