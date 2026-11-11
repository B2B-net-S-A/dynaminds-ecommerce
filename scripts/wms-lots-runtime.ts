/** Read-only proof of the initial main-instance migration, before enabling a firm. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

try {
  const health = (await fetch('http://127.0.0.1:4100/api/health').then((r) => r.json())) as any;
  assert.equal(health.revision, '6842519');
  assert.equal(health.schema_revision, '091_wms_lot_packing');
  assert.equal(health.wms_lots_available, true);
  assert.equal(health.restore_preview, false);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = (
      await c.query(
        "SELECT name FROM migrations WHERE name IN ('090_wms_lots','091_wms_lot_packing') ORDER BY name",
      )
    ).rows.map((r) => r.name);
    assert.equal(migrations.length, 2);
    const policies = Number((await c.query('SELECT count(*) FROM wms_policies')).rows[0].count);
    assert.equal(policies, 0, 'Migration must not activate or backfill existing firms');
    const rls = (
      await c.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname LIKE 'wms_%' ORDER BY relname`)
    ).rows;
    assert.equal(rls.length, 10);
    assert(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity));
    const emptyTables: string[] = [];
    for (const r of rls) {
      assert(/^[a-z_]+$/.test(r.relname));
      assert.equal(Number((await c.query(`SELECT count(*) FROM "${r.relname}"`)).rows[0].count), 0);
      emptyTables.push(r.relname);
    }
    const packed = (
      await c.query("SELECT tenant_id,id FROM orders WHERE status='packed' ORDER BY tenant_id,id")
    ).rows;
    await c.query('SET LOCAL ROLE dyna_app');
    for (const order of packed) {
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [order.tenant_id]);
      const result = (
        await c.query(
          `SELECT packing_fulfillment_snapshot($1)
        IS NOT DISTINCT FROM packing_fulfillment_snapshot_without_lots($1) preserved`,
          [order.id],
        )
      ).rows[0];
      assert.equal(
        result.preserved,
        true,
        'OFF must preserve the exact existing fulfillment snapshot',
      );
    }
    await c.query('COMMIT');
    const report = {
      stage: 111,
      status: 'INITIAL_MAIN_MIGRATION_PASS',
      runtime_revision: health.revision,
      schema: health.schema_revision,
      new_migrations: migrations,
      prior_firms_automatically_activated: policies,
      empty_new_tables: emptyTables,
      force_rls_tables: rls.length,
      exact_packed_fulfillment_snapshots: packed.length,
      ui_acceptance: 'OPEN',
      backup_restore_acceptance: 'OPEN',
      goal_complete: false,
    };
    await writeFile('docs/wms-lots-runtime-qa.json', JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(report);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
} finally {
  await pool.end();
}
