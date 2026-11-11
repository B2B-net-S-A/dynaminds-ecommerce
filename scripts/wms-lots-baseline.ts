/** Immutable111 raw baseline before migration; no writes except the new private evidence file. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
try {
  const health = (await fetch('http://127.0.0.1:4100/api/health').then((r) => r.json())) as any;
  assert.equal(health.revision, '846a3fb');
  assert.equal(health.schema_revision, '089_packing_workstation');
  assert.equal(health.restore_preview, false);
  const c = await pool.connect();
  let baseline: any;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    assert.equal(
      (await c.query("SELECT to_regclass('public.wms_lots') present")).rows[0].present,
      null,
    );
    const names = (
      await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    ).rows.map((r) => r.tablename as string);
    const before: Record<string, { count: number; sha256: string }> = {};
    let listingRows: any[] = [];
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const rows = (await c.query(`SELECT to_jsonb(t) row FROM "${name}" t ORDER BY 1`)).rows;
      before[name] = { count: rows.length, sha256: hash(rows) };
      if (name === 'listings') listingRows = rows;
    }
    const firms = (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const databases = (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
    baseline = {
      stage: 111,
      captured_at: new Date().toISOString(),
      runtime_revision: health.revision,
      schema: health.schema_revision,
      firms,
      users,
      databases,
      names,
      before,
      listing_rows: listingRows,
      raw_scope:
        'All public table rows at capture, including operational clocks. Acceptance must explain expected new records and traced scheduler drift separately; never rebase.',
      baseline_rebased: false,
    };
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  await writeFile('data/wms-lots-stage111-baseline.json', JSON.stringify(baseline, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  const report = {
    stage: 111,
    status: 'CAPTURED_BEFORE_IMPLEMENTATION_MIGRATION',
    runtime_revision: baseline.runtime_revision,
    schema: baseline.schema,
    prior_firms: baseline.firms.length,
    prior_users: baseline.users.length,
    prior_databases: baseline.databases.length,
    captured_raw_tables: baseline.names.length,
    baseline_rebased: false,
    goal_complete: false,
  };
  await writeFile('docs/wms-lots-baseline-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  await pool.end();
}
