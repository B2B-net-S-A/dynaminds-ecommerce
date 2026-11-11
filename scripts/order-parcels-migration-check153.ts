/** Root-only native transactional DDL check. All migrations and markers are rolled back. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';
const root = '<workspace>/app';
const source = '<workspace>/worktrees/stock-file-import';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const names = ['136_order_parcel_commercial_origins', '137_order_parcel_releases', '138_order_parcel_returns'];
const reportPath = process.env.QA153_DDL_REPORT;
let step = 'preflight';
async function main() {
 assert.equal(resolve(process.cwd()), root);
 assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root,'.local.json'));
 assert(reportPath && /^order-parcels-migration153-[a-z0-9-]+\.json$/.test(reportPath));
 const revision = process.env.QA_EXPECTED_REVISION;
 assert.match(revision ?? '', /^[a-f0-9]{40}$/);
 const health = await (await fetch('http://127.0.0.1:4100/api/health',{signal:AbortSignal.timeout(10000)})).json();
 assert.equal(health.revision,revision);assert.equal(health.schema_revision,'135_order_parcel_completion_fix');assert.equal(health.mode,'local');assert.equal(health.background_workers_enabled,false);
 const c = await pool.connect();
 const sql: Record<string,string> = {};
 for(const name of names) sql[name] = await readFile(resolve(source,'server',name+'.sql'),'utf8');
 const snapshot = async () => ({
  functions:(await c.query("SELECT oid::regprocedure::text signature,prosrc,proconfig,proacl::text acl FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1")).rows,
  columns:(await c.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
  triggers:(await c.query("SELECT tgrelid::regclass::text relation,tgname,pg_get_triggerdef(oid) definition,tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2")).rows,
  markers:(await c.query('SELECT name FROM migrations ORDER BY name')).rows,
 });
 let failure: { code:string; message:string; step:string } | null = null;
 const before = await snapshot();
 try {
  const u = new URL(pool.options.connectionString!);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55432');
  assert.equal((await c.query('SELECT current_user r')).rows[0].r,'postgres');
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  for(const name of names) {step=name;assert(!(await c.query('SELECT 1 FROM migrations WHERE name=$1',[name])).rowCount);await c.query(sql[name]);await c.query('INSERT INTO migrations(name) VALUES($1)',[name]);}
  step='guards';
  assert.deepEqual((await c.query('SELECT order_parcel_guards() parcels,order_parcel_commercial_guards() origins,order_parcel_release_guards() releases,order_parcel_return_installed() returns')).rows[0],{parcels:true,origins:true,releases:true,returns:true});
  const tables = ['order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments','order_parcel_release_previews','order_parcel_releases','order_parcel_release_admissions','order_parcel_return_claims','order_parcel_return_receipts','order_parcel_return_admissions'];
  for(const name of tables) {assert.match(name,/^[a-z_]+$/);assert.equal((await c.query(`SELECT count(*)::int n FROM ${name}`)).rows[0].n,0);assert.equal((await c.query('SELECT relrowsecurity AND relforcerowsecurity ok FROM pg_class WHERE oid=$1::regclass',[name])).rows[0].ok,true);}
  step='private-privileges';
  for(const name of ['order_parcel_release_admissions','order_parcel_return_admissions']) assert.deepEqual((await c.query("SELECT has_table_privilege('dyna_app',$1,'SELECT') r,has_table_privilege('dyna_app',$1,'INSERT') w,has_table_privilege('dyna_app',$1,'UPDATE') u,has_table_privilege('dyna_app',$1,'DELETE') d",[name])).rows[0],{r:false,w:false,u:false,d:false});
  step='constraint-flush';await c.query('SET CONSTRAINTS ALL IMMEDIATE');
 } catch(e) {const x=e as {code?:string;message?:string};failure={code:x.code??'ASSERTION',message:x.message??'Check failed',step};}
 finally {await c.query('ROLLBACK');}
 const after = await snapshot();assert.deepEqual(after,before,'Rollback must preserve the complete function/column/trigger/migration inventory');
 c.release();
 const result = {stage:153,status:failure?'FAIL_ROLLED_BACK':'PASS_ROLLED_BACK',revision,schema_revision:health.schema_revision,transaction_committed:false,business_operations:0,sources:Object.fromEntries(Object.entries(sql).map(([n,s])=>[n,createHash('sha256').update(s).digest('hex')])),schema_before_sha256:hash(before),schema_after_sha256:hash(after),failure,full_goal_complete:false};
 const f=await open(resolve(source,'docs',reportPath),'wx',0o644);try{await f.writeFile(JSON.stringify(result,null,2)+'\n');await f.sync();}finally{await f.close();}
 process.stdout.write(JSON.stringify({status:result.status,step:failure?.step??'complete',failure:failure?{code:failure.code,message:failure.message}:null})+'\n');
 if(failure) process.exitCode=1;
}
main().catch(()=>{process.stderr.write('QA153_DDL_FAILED_NO_PRIVATE_OUTPUT\n');process.exitCode=1;}).finally(()=>pool.end());
