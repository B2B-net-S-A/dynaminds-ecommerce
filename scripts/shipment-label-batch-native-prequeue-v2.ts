/** One-shot own QA150 negative whole-order issue + read-only preview boundary. */
import assert from 'node:assert/strict';
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{pool}from'../server/db';
const root='<workspace>/app';
assert.equal(process.cwd(),root);assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,root+'/.local.json');
const s=JSON.parse(await readFile(root+'/data/shipment-label-batch-stage150.json','utf8'));
assert.equal(s.complete,true);assert.equal(s.pending,null);
const path=root+'/data/shipment-label-batch-stage150-prequeue-v2.json';
const report='<workspace>/worktrees/stock-file-import/docs/shipment-label-batch-native150-prequeue-v2.json';
const oldRaw=await readFile(root+'/data/shipment-label-batch-stage150-prequeue.json','utf8');
const old=JSON.parse(oldRaw);assert.equal(old.complete,false);assert.equal(old.pending.path,'/orders/'+s.orders[0].id+'/ship');
const original_journal_sha256=createHash('sha256').update(oldRaw).digest('hex');
const journal:any={stage:150,pending:null,complete:false,completed:[]};
await writeFile(path,JSON.stringify(journal)+'\n',{flag:'wx',mode:0o600});
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function snapshot(){const c=await pool.connect();const out:Record<string,unknown>={};try{
await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
const names=(await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name")).rows.map(v=>v.table_name);
for(const name of names){assert.match(name,/^[a-z_][a-z0-9_]*$/);const key=['users','tenants'].includes(name)?'id':'tenant_id';const id=name==='users'?s.user_id:s.tenant_id;const rows=(await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=$1 ORDER BY 1`,[id])).rows;out[name]={count:rows.length,sha256:hash(rows)};}
await c.query('COMMIT');return out;}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}}
try{
const h=await(await fetch('http://127.0.0.1:4100/api/health')).json();assert.equal(h.revision,process.env.QA_EXPECTED_REVISION);assert.equal(h.schema_revision,'133_order_shipments');assert.equal(h.background_workers_enabled,false);
const before=await snapshot();const counts=(await pool.query('SELECT (SELECT count(*) FROM print_jobs WHERE tenant_id=$1)::int jobs,(SELECT count(*) FROM shipment_label_batch_previews WHERE tenant_id=$1)::int previews,(SELECT count(*) FROM shipment_label_batch_executions WHERE tenant_id=$1)::int executions',[s.tenant_id])).rows[0];assert.deepEqual(counts,{jobs:0,previews:1,executions:0});
journal.pending={step:'deny-whole-order-demo-dispatch',method:'POST',path:'/orders/'+s.orders[0].id+'/ship-demo',body:{}};await writeFile(path,JSON.stringify(journal)+'\n',{mode:0o600});
const r=await fetch('http://127.0.0.1:4100/api'+journal.pending.path,{method:'POST',headers:{cookie:s.cookie,'X-Workspace-ID':s.tenant_id,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(10000)});assert.equal(r.status,409);journal.completed.push({step:journal.pending.step,status:r.status});journal.pending=null;
const after=await snapshot();assert.deepEqual(after,before);journal.complete=true;await writeFile(path,JSON.stringify(journal)+'\n',{mode:0o600});
await writeFile(report,JSON.stringify({stage:150,status:'PREQUEUE_BOUNDARY_PASS',revision:h.revision,tenant_id:s.tenant_id,counts,whole_order_issue_status:409,all_tables_unchanged:Object.keys(before).length,before,after,provider_requests:0,full_goal_complete:false,prior_wrong_route_journal_preserved:true,original_journal_sha256},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'PREQUEUE_BOUNDARY_PASS',counts,tables:Object.keys(before).length,whole_order_issue_status:409}));
}finally{await pool.end();}
