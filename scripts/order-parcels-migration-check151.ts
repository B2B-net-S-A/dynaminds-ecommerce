/** Root-only transactional DDL check. Always rolls back, never creates fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';
import { orderParcelsAvailable } from '../server/order-parcels';

async function main() {
  const root='<workspace>/app';
  const source='<workspace>/worktrees/stock-file-import';
  const variant=process.argv[2]??'initial';
  assert(['initial','counter-field','completion-fix'].includes(variant));
  const correction=variant==='completion-fix';
  const migration=correction?'135_order_parcel_completion_fix':'134_order_parcels';
  assert.equal(resolve(process.cwd()),root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,resolve(root,'.local.json'));
  assert.equal(process.env.QA151_MIGRATION_CONFIRM,'ROLLBACK_DDL_CHECK_ONLY');
  const revision=process.env.QA_EXPECTED_REVISION;
  assert.match(revision??'',/^[a-f0-9]{40}$/);
  const health=await(await fetch('http://127.0.0.1:4100/api/health')).json();
  assert.equal(health.revision,revision);
  assert.equal(health.schema_revision,correction?'134_order_parcels':'133_order_shipments');
  assert.equal(health.background_workers_enabled,false);
  assert.equal(health.restore_preview,false);
  const sql=await readFile(resolve(source,`server/${migration}.sql`),'utf8');
  const c=await pool.connect();
  try {
    assert.equal((await c.query('SELECT current_user AS role')).rows[0].role,'postgres');
    assert.equal((await c.query('SELECT EXISTS(SELECT 1 FROM migrations WHERE name=$1) installed',[migration])).rows[0].installed,false);
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='2s'");
    await c.query("SET LOCAL statement_timeout='15s'");
    await c.query(sql);
    await c.query('INSERT INTO migrations(name) VALUES($1)',[migration]);
    assert.equal(await orderParcelsAvailable(c),true);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('ROLLBACK');
    assert.equal((await c.query("SELECT to_regclass('order_parcel_plans') IS NULL gone")).rows[0].gone,!correction);
    assert.equal((await c.query('SELECT EXISTS(SELECT 1 FROM migrations WHERE name=$1) installed',[migration])).rows[0].installed,false);
    const report={stage:151,status:'PASS',revision,schema_revision:health.schema_revision,migration,
      migration_sha256:createHash('sha256').update(sql).digest('hex'),
      guards_inside_transaction:true,rolled_back:true,fixtures_created:false,full_goal_complete:false};
    await writeFile(resolve(source,`docs/order-parcels-migration-check151${variant==='initial'?'':'-'+variant}.json`),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    process.stdout.write(JSON.stringify(report)+'\n');
  } catch(e) {
    await c.query('ROLLBACK').catch(()=>{});
    const error=e as {code?:string;message?:string;position?:string;where?:string};
    process.stderr.write(JSON.stringify({status:'FAILED',code:error.code,message:error.message,
      position:error.position,where:error.where,rolled_back:true})+'\n');
    process.exitCode=1;
  } finally {c.release();}
}
main().finally(()=>pool.end());
