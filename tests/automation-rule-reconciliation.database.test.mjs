/** Explicit local TEMP-only PostgreSQL check. Default SKIP; never constructs an
 * app/worker/provider. Root supplies a private locator and runs after review.
 * DYNA_AUTOMATION_RECONCILIATION_PG=true
 * DYNA_AUTOMATION_RECONCILIATION_PRIVATE=/absolute/private-0600-locator.json
 * Locator: {schema:'dynaminds-automation-reconciliation-temp-test/v1',databaseUrl}
 * No credentials, SQL parameters or server error messages are printed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {transformSync} from 'esbuild';

const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url));
const enabled=process.env.DYNA_AUTOMATION_RECONCILIATION_PG==='true';
// p276 re-pin after review (git diff 2e35002 HEAD -- server/automation-local-effects.ts): only the stock queue counter now
// states active jobs as (state='pending' OR state='running'), the same rows; no effect, lock or limit changes.
const sourceSha='e7f6414f347ff9721d8c04815f59401f359d3ad424daa5a97e182420d53f9d77';
const database='dynaminds_full_base_preview_20261017';
const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const tenant=id(1),rule=id(2),run=id(3),foreignTenant=id(4),foreignRule=id(5);
const sha=b=>createHash('sha256').update(b).digest('hex');
function sameStat(s){return[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');}
function loadPrivateLocator(){
 const file=process.env.DYNA_AUTOMATION_RECONCILIATION_PRIVATE;
 assert(typeof file==='string'&&path.isAbsolute(file)&&path.resolve(file)===file,'private-locator-path');
 assert.equal(fs.realpathSync(file),file,'private-locator-realpath');
 const before=fs.lstatSync(file,{bigint:true});
 assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid())&&(before.mode&0o777n)===0o600n&&before.size>0n&&before.size<=16384n,'private-locator-ownership');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let failed=false;
 try{
  assert.equal(sameStat(fs.fstatSync(fd,{bigint:true})),sameStat(before),'private-locator-fd');
  const bytes=Buffer.alloc(Number(before.size)+1);let count=0;
  while(count<bytes.length){const n=fs.readSync(fd,bytes,count,bytes.length-count,count);if(n===0)break;count+=n;}
  assert.equal(BigInt(count),before.size,'private-locator-size');
  assert.equal(sameStat(fs.fstatSync(fd,{bigint:true})),sameStat(before),'private-locator-stable-fd');
  assert.equal(sameStat(fs.lstatSync(file,{bigint:true})),sameStat(before),'private-locator-stable-path');assert.equal(fs.realpathSync(file),file);
  const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(0,count)));
  assert.deepEqual(Object.keys(value).sort(),['databaseUrl','schema']);assert.equal(value.schema,'dynaminds-automation-reconciliation-temp-test/v1');
  assert(typeof value.databaseUrl==='string'&&value.databaseUrl.length<=8192,'local-database-url');
  const url=new URL(value.databaseUrl);
  assert(['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='127.0.0.1'&&url.port==='57081'&&url.username==='postgres'&&url.password.length>0&&url.pathname==='/'+database&&!url.search&&!url.hash,'local-database-boundary');
  return value;
 }catch(error){failed=true;throw error;}finally{try{fs.closeSync(fd);}catch(error){if(!failed)throw error;}}
}
export function privateLocator(){
 try{return loadPrivateLocator();}catch{throw Object.assign(new Error('Private reconciliation locator is invalid'),{code:'LOCATOR_INVALID'});}
}
function actualEffects(){
 const file=path.join(root,'server/automation-local-effects.ts'),bytes=fs.readFileSync(file);assert.equal(sha(bytes),sourceSha,'actual-effects-source-pin');
 const load=(text,ports)=>{
  const code=transformSync(text,{loader:'ts',format:'cjs',target:'es2022'}).code,m={exports:{}};
  new Function('module','require',code)(m,key=>{assert(Object.hasOwn(ports,key),'forbidden-module-import');return ports[key];});return m.exports;
 };
 const errors=load(fs.readFileSync(path.join(root,'server/errors.ts'),'utf8'),{});
 return load(bytes.toString('utf8'),{'node:crypto':require('node:crypto'),'node:util':require('node:util'),
  './smtp':{localSmtpPort:()=>assert.fail('No SMTP policy/transport in reconciliation readers')},'./errors':errors,'./db':{tenantTx:()=>assert.fail('No application transactions')},'./offers':{},'./automation-local-channel':{}});
}
function actualUnresolvedEffects(){
 const bytes=fs.readFileSync(path.join(root,'server/automation-unresolved-effects.ts'));assert.equal(sha(bytes),'612faa1bccd5dd3d51130047d5d699dc452a87951924277bb0e792deb1ad30f6','actual-unresolved-source-pin');
 const load=(source,ports)=>{const code=transformSync(source,{loader:'ts',format:'cjs',target:'es2022'}).code,m={exports:{}};new Function('module','require',code)(m,key=>{assert(Object.hasOwn(ports,key),'forbidden-unresolved-module-import');return ports[key];});return m.exports;};
 const errors=load(fs.readFileSync(path.join(root,'server/errors.ts'),'utf8'),{});
 return load(bytes.toString('utf8'),{'./errors':errors});
}
async function captureUnresolvedSql(module){
 const sentinel=Object.freeze({captured:true});let captured;
 try{await module.readUnresolvedAutomaticEffects({query:async(sql)=>{assert.equal(captured,undefined,'one sealed query');captured=sql;throw sentinel;}},tenant,rule);assert.fail('capture must stop before result processing');}
 catch(error){assert.equal(error,sentinel,'only the controlled capture sentinel is accepted');}
 assert(typeof captured==='string'&&captured.startsWith('WITH stock_rows AS NOT MATERIALIZED ('),'pinned SELECT CTE captured');return captured;
}
function sealedUnresolvedReader(client,sql){return{query:(actual,args)=>{assert.equal(actual,sql,'exact pinned unresolved SELECT CTE only');return client.query(actual,args);}};}
const tables=['automation_runs','jobs','offer_plans','email_batches','email_messages'];
async function setup(c){
 await c.query('SET LOCAL search_path=pg_temp,pg_catalog');
 await c.query(`CREATE TEMP TABLE automation_runs(tenant_id uuid,id uuid,rule_id uuid,created_at timestamptz) ON COMMIT DROP`);
 await c.query(`CREATE TEMP TABLE jobs(tenant_id uuid,id uuid,state text,kind text,payload jsonb,error text,created_at timestamptz) ON COMMIT DROP`);
 await c.query(`CREATE TEMP TABLE offer_plans(tenant_id uuid,id uuid,job_id uuid,actor_id uuid,channel_id uuid,listing_id uuid,product_id uuid,operation text,state text,phase text,input jsonb,result jsonb,payload jsonb) ON COMMIT DROP`);
 await c.query(`CREATE TEMP TABLE email_batches(tenant_id uuid,id uuid,automation_run_id uuid,channel_id uuid) ON COMMIT DROP`);
 await c.query(`CREATE TEMP TABLE email_messages(tenant_id uuid,id uuid,batch_id uuid,job_id uuid,state text,error text,created_at timestamptz) ON COMMIT DROP`);
 // Match only existing production identity indexes: id PK plus (tenant_id,id)
 // UNIQUE. Source: schema/010/028,006/017,061 SQL; no new JSON/run index.
 for(const name of tables)await c.query(`ALTER TABLE pg_temp.${name} ADD PRIMARY KEY(id), ADD UNIQUE(tenant_id,id)`);
 const rows=(await c.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=ANY($1::regclass[])`,[tables])).rows;
 assert.equal(rows.length,5,'all-five-temp-relations');assert(rows.every(r=>r.nspname.startsWith('pg_temp_')&&tables.includes(r.relname)),'temp-only-fixtures');
}
async function addRun(c,r=run,t=tenant,ruleId=rule,at='2026-10-18T00:00:00Z'){
 await c.query('INSERT INTO pg_temp.automation_runs VALUES($1,$2,$3,$4)',[t,r,ruleId,at]);
}
async function addStock(c,{n=100,r=run,t=tenant,state='done',quantity=4,desired=true,missingPlan=false,effectState='done'}={}){
 const operation=id(n),plan=id(n+10000),child=id(n+20000),actor=id(6),channel=id(7),listing=id(8),product=id(9);
 const payload={run_id:r,effect_plan_id:plan,effect_job_id:child,owner_id:actor,action:{channel_id:channel},listing_id:listing,product_id:product};
 await c.query(`INSERT INTO pg_temp.jobs VALUES($1,$2,$3,'automation.local_stock',$4,NULL,'2026-10-18T01:00:00Z'),($1,$5,$6,'offer.write','{}',NULL,'2026-10-18T01:00:00Z')`,[t,operation,state,payload,child,effectState]);
 if(!missingPlan)await c.query(`INSERT INTO pg_temp.offer_plans VALUES($1,$2,$3,$4,$5,$6,$7,'sync','done','done',$8,$9,$10)`,[t,plan,child,actor,channel,listing,product,{stock:true,price:false},{desired_applied:desired},{stock_quantity:quantity}]);
 return operation;
}
async function addEmail(c,{n=500,r=run,t=tenant,state='smtp_accepted',jobState='done'}={}){
 const message=id(n),batch=id(n+10000),job=id(n+20000);
 await c.query('INSERT INTO pg_temp.email_batches VALUES($1,$2,$3,$4)',[t,batch,r,id(7)]);
 await c.query(`INSERT INTO pg_temp.jobs VALUES($1,$2,$3,'email.send','{}',NULL,'2026-10-18T01:00:00Z')`,[t,job,jobState]);
 await c.query(`INSERT INTO pg_temp.email_messages VALUES($1,$2,$3,$4,$5,NULL,'2026-10-18T01:00:00Z')`,[t,message,batch,job,state]);
}

test('actual private locator failure is sanitized, closes its descriptor and preserves finite pre-read bounds',async()=>{
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dyna-reconciliation-locator-')));fs.chmodSync(directory,0o700);
 const file=path.join(directory,'locator.private.json'),previous=process.env.DYNA_AUTOMATION_RECONCILIATION_PRIVATE,sentinel='SYNTHETIC_PRIVATE_PASSWORD_DO_NOT_ECHO';
 const originalOpen=fs.openSync,originalClose=fs.closeSync,opened=[];
 try{
  process.env.DYNA_AUTOMATION_RECONCILIATION_PRIVATE=file;
  fs.openSync=function(...args){const fd=originalOpen.apply(this,args);if(args[0]===file&&args[1]===(fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW))opened.push({fd,closed:false});return fd;};
  fs.closeSync=function(fd){const result=originalClose.call(this,fd),held=opened.findLast(entry=>entry.fd===fd&&!entry.closed);if(held)held.closed=true;return result;};
  for(const bytes of [Buffer.from('{\"databaseUrl\":\"postgresql://postgres:'+sentinel+'@127.0.0.1:57081/'+database+'\",BROKEN'),Buffer.from([0xc3,0x28]),Buffer.alloc(16385,65)]){
   fs.writeFileSync(file,bytes,{mode:0o600});const count=opened.length;
   let failure;try{privateLocator();}catch(error){failure=error;}
   assert(failure,'private loader must refuse');assert.equal(failure.message,'Private reconciliation locator is invalid');assert.equal(failure.code,'LOCATOR_INVALID');assert(!Object.hasOwn(failure,'cause'));assert(!String(failure.stack).includes(sentinel));assert(!JSON.stringify(failure).includes(sentinel));
   assert(opened.every(entry=>entry.closed),'every opened locator is closed');if(bytes.length>16384)assert.equal(opened.length,count,'oversize refuses before open/allocation');
  }
  const value={schema:'dynaminds-automation-reconciliation-temp-test/v1',databaseUrl:'postgresql://postgres:'+sentinel+'@127.0.0.1:57081/'+database};
  fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});assert(privateLocator().databaseUrl===value.databaseUrl);assert(opened.every(entry=>entry.closed));
 }finally{
  fs.openSync=originalOpen;fs.closeSync=originalClose;
  if(previous===undefined)delete process.env.DYNA_AUTOMATION_RECONCILIATION_PRIVATE;else process.env.DYNA_AUTOMATION_RECONCILIATION_PRIVATE=previous;
  fs.rmSync(directory,{recursive:true});
 }
 const sql=await captureUnresolvedSql(actualUnresolvedEffects());let calls=0;
 const port=sealedUnresolvedReader({query:async()=>{calls++;return{rows:[]};}},sql);
 assert.throws(()=>port.query(sql+' ',[]));assert.throws(()=>port.query('WITH malicious AS (DELETE FROM jobs RETURNING *) SELECT * FROM malicious',[]));assert.equal(calls,0);
 await port.query(sql,[tenant,rule,null,null]);assert.equal(calls,1);
});

test('actual own-rule reconciliation SQL on isolated TEMP fixtures; no Native/worker/scale acceptance',{skip:!enabled,timeout:120000},async t=>{
 const effects=actualEffects(),unresolved=actualUnresolvedEffects(),locator=privateLocator(),{Client}=require('pg');
 const unresolvedSql=await captureUnresolvedSql(unresolved);
 const client=new Client({connectionString:locator.databaseUrl,connectionTimeoutMillis:5000,application_name:'dyna-reconciliation-temp-test',options:'-c jit=off -c statement_timeout=8000 -c lock_timeout=8000 -c timezone=UTC'});
 let connected=false,inTx=false,primary;
 const read={query:(sql,args)=>{assert(/^SELECT\b/.test(sql),'exported-reader-select-only');return client.query(sql,args);}};
 const unresolvedRead=sealedUnresolvedReader(client,unresolvedSql);
 try{
  await client.connect();connected=true;
  const identity=(await client.query("SELECT current_database() db,current_user owner,host(inet_server_addr()) address,inet_server_port() port")).rows[0];
  assert.deepEqual(identity,{db:database,owner:'postgres',address:'127.0.0.1',port:57081},'actual-local-identity');
  assert.equal((await client.query('SHOW jit')).rows[0].jit,'off','ordinary-runtime-jit-mirror-db-ts');
  await client.query('BEGIN');inTx=true;await setup(client);
  const scenario=async(name,fn)=>t.test(name,async()=>{
   await client.query('SAVEPOINT reconciliation_case');
   try{await fn();}finally{await client.query('ROLLBACK TO SAVEPOINT reconciliation_case');await client.query('RELEASE SAVEPOINT reconciliation_case');}
  });
  await scenario('unknown email and stock remain visible outside the latest25 runs',async()=>{
   await addRun(client);for(let n=0;n<25;n++)await addRun(client,id(1000+n),tenant,rule,`2026-10-18T00:${String(n+1).padStart(2,'0')}:00Z`);
   await addEmail(client,{state:'uncertain',jobState:'failed'});await addStock(client,{missingPlan:true});
   const recent=(await client.query('SELECT id FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 ORDER BY created_at DESC,id DESC LIMIT 25',[tenant,rule])).rows.map(r=>r.id);
   assert(!recent.includes(run));assert.equal((await effects.readAutomaticEffectsPage(read,recent)).effects.size,25);
   const summary=await effects.readAutomaticRuleReconciliation(read,tenant,rule);assert.equal(summary.stock_required,true);assert.equal(summary.email_required,true);
   const all=await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule);assert.deepEqual(all.data.map(r=>r.run_id),[run,run]);assert.equal(all.has_more,false);
  });
  await scenario('unknown email and stock beyond500 details do not clear complete warning',async()=>{
   await addRun(client);
   // Bulk known histories: exact joins are populated from genuine table fields,
   // without501 sequential fixture calls or mutations outside pg_temp.
   await client.query(`INSERT INTO pg_temp.jobs SELECT $1::uuid,md5('parent'||g)::uuid,'done','automation.local_stock',jsonb_build_object('run_id',$2::text,'effect_plan_id',md5('plan'||g)::uuid,'effect_job_id',md5('child'||g)::uuid,'owner_id',$3::text,'action',jsonb_build_object('channel_id',$4::text),'listing_id',$5::text,'product_id',$6::text),NULL,'2026-10-18T02:00:00Z' FROM generate_series(1,500)g`,[tenant,run,id(6),id(7),id(8),id(9)]);
   await client.query(`INSERT INTO pg_temp.jobs SELECT $1::uuid,md5('child'||g)::uuid,'done','offer.write','{}',NULL,'2026-10-18T02:00:00Z' FROM generate_series(1,500)g`,[tenant]);
   await client.query(`INSERT INTO pg_temp.offer_plans SELECT $1::uuid,md5('plan'||g)::uuid,md5('child'||g)::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'sync','done','done','{"stock":true,"price":false}','{"desired_applied":true}','{"stock_quantity":4}' FROM generate_series(1,500)g`,[tenant,id(6),id(7),id(8),id(9)]);
   await client.query(`INSERT INTO pg_temp.email_batches SELECT $1::uuid,md5('batch'||g)::uuid,$2::uuid,$3::uuid FROM generate_series(1,500)g`,[tenant,run,id(7)]);
   await client.query(`INSERT INTO pg_temp.jobs SELECT $1::uuid,md5('emailjob'||g)::uuid,'done','email.send','{}',NULL,'2026-10-18T02:00:00Z' FROM generate_series(1,500)g`,[tenant]);
   await client.query(`INSERT INTO pg_temp.email_messages SELECT $1::uuid,md5('message'||g)::uuid,md5('batch'||g)::uuid,md5('emailjob'||g)::uuid,'smtp_accepted',NULL,'2026-10-18T02:00:00Z' FROM generate_series(1,500)g`,[tenant]);
   await addStock(client,{missingPlan:true});await addEmail(client,{state:'uncertain',jobState:'failed'});
   // Ordinary durable tables have real statistics; analyze only this own TEMP
   // fixture after its large seed. This does not reset/update global statistics.
   for(const name of tables)await client.query(`ANALYZE pg_temp.${name}`);
   const page=await effects.readAutomaticEffectsPage(read,[run]);assert.equal(page.effects.get(run).length,1000);assert(page.effects.get(run).every(e=>!e.reconciliation_required));assert.deepEqual(page.coverage,{per_kind_limit:500,stock_truncated:true,email_truncated:true});
   const summary=await effects.readAutomaticRuleReconciliation(read,tenant,rule);assert(summary.stock_required&&summary.email_required);
   const all=await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule);assert.deepEqual(all.data.map(r=>r.type==='email'?r.message_id:r.job_id),[id(100),id(500)]);assert.equal(all.has_more,false);assert.equal(all.next_cursor,null);
  });
  for(const foreign of ['tenant','rule'])await scenario('foreign '+foreign+' unknown is excluded',async()=>{
   const r=id(4000),scopeTenant=foreign==='tenant'?foreignTenant:tenant;await addRun(client,r,scopeTenant,foreign==='rule'?foreignRule:rule);await addStock(client,{r,t:scopeTenant,missingPlan:true});await addEmail(client,{r,t:scopeTenant,state:'uncertain'});
   assert.equal((await effects.readAutomaticRuleReconciliation(read,tenant,rule)).required,false);
   assert.deepEqual((await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule)).data,[]);
   for(const cursor of ['stock:'+id(100),'email:'+id(500)])await assert.rejects(()=>unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule,{reconciliation_after:cursor}),error=>error.status===422);
  });
  for(const sample of [{quantity:0},{quantity:4},{quantity:9007199254740991},{quantity:9007199254740992},{quantity:1.5},{quantity:-1},{quantity:'4'},{quantity:null},{desired:null},{desired:false},{desired:'true'},{missingPlan:true},{effectState:'running'}])await scenario('stock predicate matches actual JS reader '+JSON.stringify(sample),async()=>{
   await addRun(client);await addStock(client,sample);
   const detail=(await effects.readAutomaticEffects(read,[run])).get(run);assert.equal(detail.length,1);
   assert.equal((await effects.readAutomaticRuleReconciliation(read,tenant,rule)).stock_required,detail[0].reconciliation_required);
   assert.equal((await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule)).data.length,detail[0].reconciliation_required?1:0);
  });
  await scenario('malformed effect plan UUID refuses with22P02 rather than a false complete warning',async()=>{
   await addRun(client);await addStock(client);
   await client.query("UPDATE pg_temp.jobs SET payload=jsonb_set(payload,'{effect_plan_id}','\"invalid-uuid\"') WHERE kind='automation.local_stock'");
   await assert.rejects(()=>effects.readAutomaticRuleReconciliation(read,tenant,rule),error=>error.code==='22P02');
   // No further query in this aborted subtransaction; scenario finally rolls back.
  });
  await scenario('exact PG fractional numeric is conservatively unresolved despite JS rounding in recent details',async()=>{
   await addRun(client);await addStock(client);
   await client.query("UPDATE pg_temp.offer_plans SET payload='{\"stock_quantity\":1000000000000000.01}'::jsonb");
   const detail=(await effects.readAutomaticEffects(read,[run])).get(run);assert.equal(detail[0].reconciliation_required,false);assert.equal(detail[0].outcome,'VERIFIED');
   assert.equal((await effects.readAutomaticRuleReconciliation(read,tenant,rule)).stock_required,true);
   assert.equal((await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule)).data.length,1);
   // Exact numeric SQL is deliberately stricter than rounded JS JSON numbers;
   // equality is claimed only for the canonical integer/type vectors above.
  });
  await scenario('pending incomplete stock and queued email are not attempted unknown work',async()=>{
   await addRun(client);await addStock(client,{state:'pending',missingPlan:true});await addEmail(client,{state:'queued',jobState:'pending'});assert.equal((await effects.readAutomaticRuleReconciliation(read,tenant,rule)).required,false);
   assert.deepEqual((await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule)).data,[]);
  });
  for(const sample of [{state:'uncertain',jobState:'failed',required:true},{state:'smtp_accepted',jobState:'running',required:true},{state:'smtp_accepted',jobState:'done',required:false},{state:'failed',jobState:'failed',required:false}])await scenario('email '+sample.state+'/'+sample.jobState,async()=>{
   await addRun(client);await addEmail(client,sample);assert.equal((await effects.readAutomaticRuleReconciliation(read,tenant,rule)).email_required,sample.required);
   const page=await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule);assert.equal(page.data.length,sample.required?1:0);if(sample.state==='smtp_accepted'&&sample.required)assert.equal(page.data[0].outcome,'SMTP_ACCEPTED_NOT_DELIVERED');
  });
  await scenario('full unresolved pagination preserves PG microseconds and mixed-kind ties with every ID exactly once',async()=>{
   await addRun(client);const expected=[];
   for(let n=0;n<14;n++)for(const kind of ['stock','email']){
    const value=kind==='stock'?6000+n:7000+n,micro=(n%2===0)===(kind==='stock')?'123999':'123001',stamp='2026-10-18T01:00:00.'+micro+'+00:00';
    if(kind==='stock'){await addStock(client,{n:value,missingPlan:true});await client.query('UPDATE pg_temp.jobs SET created_at=$2 WHERE id=$1',[id(value),stamp]);}
    else{await addEmail(client,{n:value,state:'uncertain',jobState:'failed'});await client.query('UPDATE pg_temp.email_messages SET created_at=$2 WHERE id=$1',[id(value),stamp]);}
    expected.push({cursor:kind+':'+id(value),micro,rank:kind==='stock'?0:1,id:id(value)});
   }
   await client.query("UPDATE pg_temp.jobs SET payload=payload||'{\"credential\":\"SYNTHETIC_SECRET_SENTINEL\",\"lease_token\":\"SYNTHETIC_SECRET_SENTINEL\"}',error='SYNTHETIC_SECRET_SENTINEL'");
   await client.query("UPDATE pg_temp.email_messages SET error='SYNTHETIC_SECRET_SENTINEL'");
   for(const name of tables)await client.query(`ANALYZE pg_temp.${name}`);
   // Independent fixture-order oracle retains six fractional digits; it never
   // sorts the public millisecond timestamps or derives an anchor from them.
   expected.sort((a,b)=>b.micro.localeCompare(a.micro)||a.rank-b.rank||b.id.localeCompare(a.id));
   const observed=[],cursors=new Set();let query={},pages=0;
   for(;;){
    const page=await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule,query);pages++;assert(pages<=2);assert(!JSON.stringify(page).includes('SYNTHETIC_SECRET_SENTINEL'));assert(page.data.every(r=>r.created_at==='2026-10-18T01:00:00.123Z'));
    for(const value of page.data){assert.equal(Object.keys(value).length,11);assert.equal(value.reconciliation_required,true);observed.push((value.type==='email'?'email:':'stock:')+(value.type==='email'?value.message_id:value.job_id));}
    if(!page.has_more){assert.equal(page.next_cursor,null);break;}
    assert.equal(page.data.length,25);assert.equal(page.next_cursor,observed.at(-1));assert(!cursors.has(page.next_cursor));cursors.add(page.next_cursor);query={reconciliation_after:page.next_cursor};
   }
   assert.equal(pages,2);assert.equal(new Set(observed).size,28);assert.deepEqual(observed,expected.map(e=>e.cursor));
  });
  await scenario('an own anchor that resolved after observation still continues from its actual PG position',async()=>{
   await addRun(client);for(const n of [900,901,902])await addStock(client,{n,desired:false});
   const before=await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule);assert.deepEqual(before.data.map(r=>r.job_id),[id(902),id(901),id(900)]);
   await client.query('UPDATE pg_temp.offer_plans SET result=$2 WHERE id=$1',[id(10901),{desired_applied:true}]);
   const after=await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule,{reconciliation_after:'stock:'+id(901)});assert.deepEqual(after.data.map(r=>r.job_id),[id(900)]);assert.equal(after.next_cursor,null);
  });
  await scenario('verified and pending effects are excluded while a genuine email with NULL job stays safe and addressable',async()=>{
   await addRun(client);await addStock(client);await addStock(client,{n:101,state:'pending',missingPlan:true});await addEmail(client);await addEmail(client,{n:501,state:'queued',jobState:'pending'});await addEmail(client,{n:502,state:'uncertain'});
   await client.query('UPDATE pg_temp.email_messages SET job_id=NULL WHERE id=$1',[id(502)]);
   const page=await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule);assert.equal(page.data.length,1);assert.deepEqual(page.data[0],{type:'email',run_id:run,job_id:null,created_at:'2026-10-18T01:00:00.000Z',outcome:'UNKNOWN_WRITE_OR_ACK',parent_acknowledged:false,reconciliation_required:true,effect_plan_id:null,effect_job_id:null,message_id:id(502),batch_id:id(10502)});
   assert.deepEqual((await unresolved.readUnresolvedAutomaticEffects(unresolvedRead,tenant,rule,{reconciliation_after:'email:'+id(502)})).data,[]);
  });
 }catch(error){primary=error;}
 finally{
  if(inTx)try{await client.query('ROLLBACK');inTx=false;
   const rows=(await client.query('SELECT name,to_regclass(\'pg_temp.\'||name)::text relation FROM unnest($1::text[]) name',[tables])).rows;assert(rows.every(r=>r.relation===null),'temp-fixture-rollback-confirmed');
  }catch(error){primary??=error;}
  try{await client.end();}catch(error){primary??=error;}
 }
 if(primary){const code=typeof primary?.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(primary.code)?primary.code:null;throw Object.assign(new Error('TEMP reconciliation SQL test failed; no worker/Native acceptance'),{code});}
 assert(connected&&!inTx,'client-closed-rollback-complete');
});
