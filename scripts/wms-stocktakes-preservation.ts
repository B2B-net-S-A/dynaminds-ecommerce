/** Retain raw drift; prove older business rows and trace known background activity independently. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import type { PoolClient } from 'pg';
import { verifyWmsLotsPreservation } from './wms-lots-preservation-gate';
import { earlierPurchaseProjection } from './replenishment-preservation-projection';
type Json = Record<string, any>;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const baselinePath = 'data/wms-stocktakes-stage112-baseline.json';
const background = new Set([
  'audit_events',
  'automation_schedule_runs',
  'automation_schedules',
  'listings',
  'odoo_catalog_schedules',
  'odoo_catalog_sync_items',
  'odoo_catalog_sync_runs',
  'jobs',
  'order_status_configs',
]);
export async function verifyWmsStocktakesPreservation(
  options: {
    transaction?: PoolClient;
    additionalMigrations?: readonly (
      | '094_wms_stocktake_scans'
      | '095_stocktake_scan_recovery'
      | '096_catalog_export_profiles'
      | '097_catalog_export_sources'
      | '098_catalog_file_imports'
      | '099_replenishment_plans'
      | '100_replenishment_forecast'
    )[];
  } = {},
) {
  const additiveMigrations = options.additionalMigrations ?? [];
  assert(
    additiveMigrations.every((name) =>
      [
        '094_wms_stocktake_scans',
        '095_stocktake_scan_recovery',
        '096_catalog_export_profiles',
        '097_catalog_export_sources',
        '098_catalog_file_imports',
        '099_replenishment_plans',
        '100_replenishment_forecast',
      ].includes(name),
    ),
  );
  const allowedMigrations = [
    '092_wms_stocktakes',
    '093_wms_validation_scopes',
    ...additiveMigrations,
  ];
  const raw = await readFile(baselinePath, 'utf8');
  const b: Json = JSON.parse(raw);
  assert.equal(b.stage, 112);
  assert.equal(b.baseline_rebased, false);
  const qa111: Json = JSON.parse(await readFile('data/wms-lots-stage111.json', 'utf8'));
  assert(b.firms.includes(qa111.tenant));
  const c = options.transaction ?? (await pool.connect());
  try {
    if (!options.transaction) {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
    }
    const earlier = await verifyWmsLotsPreservation(
      b.prior_stage111_preservation.originalsha256,
      c,
      { additionalMigrations: additiveMigrations },
    );
    assert.equal(earlier.status, 'PASS', 'Original104 source trace must share the112 snapshot');
    const firms = (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const databases = (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
    assert(b.firms.every((id: string) => firms.includes(id)));
    assert(b.users.every((id: string) => users.includes(id)));
    assert.deepEqual(databases, b.databases, 'Only owned disposable DBs may be removed');
    const changed: Json[] = [];
    const transformed: Json[] = [];
    let exact = 0;
    for (const name of b.names as string[]) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const columns = (
        await c.query(
          `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
          [name],
        )
      ).rows.map((r) => r.column_name);
      let where = '',
        params: unknown[] = [];
      if (name === 'tenants' || name === 'users') {
        where = 'WHERE t.id=ANY($1::uuid[])';
        params = [name === 'users' ? b.users : b.firms];
      } else if (columns.includes('tenant_id')) {
        where = 'WHERE t.tenant_id=ANY($1::uuid[])';
        params = [b.firms];
      } else if (columns.includes('user_id')) {
        where = 'WHERE t.user_id=ANY($1::uuid[])';
        params = [b.users];
      }
      const projection = await earlierPurchaseProjection(
        c,
        name,
        additiveMigrations.includes('099_replenishment_plans'),
        where,
        params,
      );
      const rows = (
        await c.query(`SELECT ${projection} row FROM "${name}" t ${where} ORDER BY 1`, params)
      ).rows;
      const before = b.before[name];
      const isExact = rows.length === before.count && hash(rows) === before.sha256;
      if (isExact) {
        ++exact;
        continue;
      }
      changed.push({
        table: name,
        before_count: before.count,
        after_count: rows.length,
        before_sha256: before.sha256,
        after_sha256: hash(rows),
      });
      let projected = rows;
      if (name === 'migrations') {
        projected = rows.filter((r) => !allowedMigrations.includes(r.row.name));
      } else if (name === 'wms_operations' && columns.includes('stocktake_id')) {
        projected = rows.map(({ row }) => {
          assert.equal(row.stocktake_id, null);
          assert.equal(row.stocktake_posting_id, null);
          assert.equal(row.stocktake_review_id, null);
          const value = { ...row };
          delete value.stocktake_id;
          delete value.stocktake_posting_id;
          delete value.stocktake_review_id;
          return { row: value };
        });
      } else if (name === 'wms_cost_layers' && columns.includes('stocktake_line_id')) {
        projected = rows.map(({ row }) => {
          assert.equal(row.stocktake_line_id, null);
          const value = { ...row };
          delete value.stocktake_line_id;
          return { row: value };
        });
      }
      // ORDER BY to_jsonb(t) must be applied after the precisely documented projection as well.
      if (projected !== rows) {
        const expression =
          name === 'wms_operations'
            ? "to_jsonb(t)-ARRAY['stocktake_id','stocktake_posting_id','stocktake_review_id']"
            : name === 'wms_cost_layers'
              ? "to_jsonb(t)-'stocktake_line_id'"
              : 'to_jsonb(t)';
        projected =
          name === 'migrations'
            ? (
                await c.query(
                  `SELECT to_jsonb(t) row FROM migrations t
          WHERE NOT name=ANY($1::text[]) ORDER BY 1`,
                  [allowedMigrations],
                )
              ).rows
            : (
                await c.query(
                  `SELECT ${expression} row FROM "${name}" t ${where} ORDER BY 1`,
                  params,
                )
              ).rows;
        assert.equal(projected.length, before.count, 'Original row count: ' + name);
        assert.equal(hash(projected), before.sha256, 'Original projected business data: ' + name);
        transformed.push({
          table: name,
          proof: 'EXACT_ORIGINAL_PROJECTION',
          added_columns_null: name !== 'migrations',
        });
      } else {
        assert(background.has(name), 'Unexplained original data drift: ' + name);
        assert(
          earlier.changed.some((r) => r.table === name),
          'Missing independent original104 source proof: ' + name,
        );
        // The additional105th firm is not covered by the original104 gate; check it exactly.
        const own = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
            qa111.tenant,
          ])
        ).rows;
        assert.equal(
          own.length,
          qa111.own_snapshot[name].count,
          'QA111 original row count: ' + name,
        );
        assert.equal(
          hash(own),
          qa111.own_snapshot[name].sha256,
          'QA111 original background rows: ' + name,
        );
        transformed.push({
          table: name,
          proof: 'ORIGINAL104_SOURCE_TRACED_AND_QA111_EXACT',
          stage112_raw_snapshot_exact: false,
        });
      }
    }
    if (!options.transaction) await c.query('COMMIT');
    return {
      stage: 112,
      status: 'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND',
      baseline_file: baselinePath,
      original_baseline_sha256: createHash('sha256').update(raw).digest('hex'),
      baseline_rebased: false,
      prior_firms: b.firms.length,
      current_firms: firms.length,
      prior_users: b.users.length,
      current_users: users.length,
      prior_databases: databases.length,
      compared_tables: b.names.length,
      raw_exact_tables: exact,
      raw_differences: changed,
      explained: transformed,
      prior_stage111: earlier.status,
      goal_complete: false,
    };
  } finally {
    if (!options.transaction) {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
}
if (process.argv[1]?.endsWith('/wms-stocktakes-preservation.ts')) {
  try {
    const label = process.argv[2];
    assert(label && /^[a-z0-9-]+$/.test(label));
    const result = await verifyWmsStocktakesPreservation();
    await writeFile(
      'docs/wms-stocktakes-preservation-' + label + '.json',
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log({
      stage: 112,
      status: result.status,
      raw_exact_tables: result.raw_exact_tables,
      explained_tables: result.explained.length,
      prior_firms: result.prior_firms,
      prior_databases: result.prior_databases,
    });
  } finally {
    await pool.end();
  }
}
