/** Stage112 immutable snapshot before any live schema or business changes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { verifyWmsLotsPreservation } from './wms-lots-preservation-gate';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const health = await fetch('http://127.0.0.1:4100/api/health').then((response) =>
    response.json(),
  );
  assert.equal(health.revision, '3b152a1');
  assert.equal(health.schema_revision, '091_wms_lot_packing');
  assert.equal(health.restore_preview, false);
  const preservation = await verifyWmsLotsPreservation();
  assert.equal(preservation.status, 'PASS');
  const c = await pool.connect();
  let baseline: any;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    assert.equal(
      (await c.query("SELECT to_regclass('public.wms_stocktakes') present")).rows[0].present,
      null,
    );
    const names = (
      await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    ).rows.map((r) => r.tablename as string);
    const before: Record<string, { count: number; sha256: string }> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const rows = (await c.query(`SELECT to_jsonb(t) row FROM "${name}" t ORDER BY 1`)).rows;
      before[name] = { count: rows.length, sha256: hash(rows) };
    }
    baseline = {
      stage: 112,
      captured_at: new Date().toISOString(),
      runtime_revision: health.revision,
      schema: health.schema_revision,
      firms: (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      users: (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id),
      databases: (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
        (r) => r.datname,
      ),
      names,
      before,
      prior_stage111_preservation: preservation,
      baseline_rebased: false,
      raw_scope:
        'All public tables, including operational clocks. Raw differences must remain visible and be independently proved; never rebase.',
    };
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  await writeFile('data/wms-stocktakes-stage112-baseline.json', JSON.stringify(baseline, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  const report = {
    stage: 112,
    status: 'CAPTURED_BEFORE_LIVE_MIGRATION',
    runtime_revision: baseline.runtime_revision,
    schema: baseline.schema,
    prior_firms: baseline.firms.length,
    prior_users: baseline.users.length,
    prior_databases: baseline.databases.length,
    captured_raw_tables: baseline.names.length,
    prior_stage111_preservation: preservation.status,
    baseline_rebased: false,
    goal_complete: false,
  };
  await writeFile('docs/wms-stocktakes-baseline-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  await pool.end();
}
