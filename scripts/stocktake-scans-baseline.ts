/** Capture stage 113 once, before live migration; never rebase accepted earlier data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { verifyWmsStocktakesPreservation } from './wms-stocktakes-preservation';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stateFiles = [
  'data/wms-stocktakes-stage112.json',
  'data/wms-stocktakes-extended112.json',
  'data/wms-stocktakes-large-stage112.json',
];
try {
  const response = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.revision, 'f78a919');
  assert.equal(health.schema_revision, '093_wms_validation_scopes');
  assert.equal(health.restore_preview, false);
  const accepted = JSON.parse(await readFile('docs/wms-stocktakes-acceptance-qa.json', 'utf8'));
  assert.equal(accepted.status, 'PASS_LOCAL112');
  assert.equal(accepted.pending_contract_gates.length, 0);
  const prior = await verifyWmsStocktakesPreservation();
  assert.equal(prior.status, 'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND');
  const original = await readFile('data/wms-stocktakes-stage112-baseline.json');
  const originalSha = createHash('sha256').update(original).digest('hex');
  assert.equal(originalSha, '04cc921ff540ea1ab55e89add0c8593cd30a6a3255993cd84040ff71113a7cc9');
  const c = await pool.connect();
  let baseline: any;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    assert.equal(
      (await c.query("SELECT to_regclass('public.stocktake_scan_receipts') present")).rows[0]
        .present,
      null,
    );
    const names = (
      await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    ).rows.map((r) => r.tablename as string);
    const before: Record<string, { count: number; sha256: string }> = {};
    const columns: Record<string, string[]> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const rows = (await c.query(`SELECT to_jsonb(t) row FROM "${name}" t ORDER BY 1`)).rows;
      before[name] = { count: rows.length, sha256: hash(rows) };
      columns[name] = (
        await c.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [name],
        )
      ).rows.map((r) => r.column_name);
    }
    const ownCheckpoints = [];
    for (const file of stateFiles) {
      const raw = await readFile(file);
      const state = JSON.parse(raw.toString('utf8'));
      assert.equal(state.own_snapshot_timezone, 'UTC');
      for (const name of state.own_names) {
        assert(/^[a-z][a-z0-9_]*$/.test(name));
        const identity = name === 'users' ? state.user : state.tenant;
        const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
            identity,
          ])
        ).rows;
        assert.deepEqual(
          { count: rows.length, sha256: hash(rows) },
          state.own_snapshot[name],
          'Accepted 112 checkpoint changed: ' + file + '/' + name,
        );
      }
      ownCheckpoints.push({
        file,
        sha256: createHash('sha256').update(raw).digest('hex'),
        tenant: state.tenant,
        snapshot: state.own_snapshot,
      });
    }
    baseline = {
      stage: 113,
      captured_at: new Date().toISOString(),
      runtime_revision: health.revision,
      schema: health.schema_revision,
      baseline_rebased: false,
      firms: (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      users: (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id),
      databases: (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
        (r) => r.datname,
      ),
      names,
      before,
      columns,
      own_checkpoints: ownCheckpoints,
      original_stage112_baseline_sha256: originalSha,
      prior_stage112_preservation: prior,
      raw_scope:
        'All public tables; raw differences must remain visible and independently explained. Earlier accepted checkpoints are exact, not rebased.',
    };
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const baselineBytes = JSON.stringify(baseline, null, 2);
  await writeFile('data/stocktake-scans-stage113-baseline.json', baselineBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  const report = {
    stage: 113,
    status: 'CAPTURED_BEFORE_LIVE_MIGRATION',
    runtime_revision: baseline.runtime_revision,
    schema: baseline.schema,
    prior_firms: baseline.firms.length,
    prior_users: baseline.users.length,
    prior_databases: baseline.databases.length,
    captured_raw_tables: baseline.names.length,
    accepted_stage112_checkpoints: baseline.own_checkpoints.length,
    prior_stage112_preservation: prior.status,
    original_stage112_baseline_sha256: originalSha,
    original_baseline_sha256: createHash('sha256').update(baselineBytes).digest('hex'),
    baseline_rebased: false,
    goal_complete: false,
  };
  await writeFile('docs/stocktake-scans-baseline-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  await pool.end();
}
