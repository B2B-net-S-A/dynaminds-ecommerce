/** QA111 read-only preservation gate. No phase runner or evidence-file writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { pool } from '../server/db';
import { verifyWmsLotsPreservationTrace } from './wms-lots-preservation-trace';
import { verifyWmsLotsBackgroundProvenance } from './wms-lots-background-provenance';
import { earlierPurchaseProjection } from './replenishment-preservation-projection';

const baselinePath = 'data/wms-lots-stage111-baseline.json';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (value: string) => createHash('sha256').update(value).digest('hex');
const identifier = (name: string) => {
  assert(/^[a-z][a-z0-9_]*$/.test(name));
  return '"' + name + '"';
};

export async function verifyWmsLotsPreservation(
  originalSha?: string,
  transaction?: PoolClient,
  options: {
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
  const additional = options.additionalMigrations ?? [];
  assert(
    additional.every((name) =>
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
  const raw = await readFile(baselinePath, 'utf8');
  if (originalSha) assert.equal(bytesHash(raw), originalSha, 'Original baseline was modified');
  const baseline = JSON.parse(raw);
  assert.equal(baseline.stage, 111);
  assert.equal(baseline.baseline_rebased, false);
  assert.equal(baseline.runtime_revision, '846a3fb');
  assert.equal(baseline.schema, '089_packing_workstation');
  const c = transaction ?? (await pool.connect());
  try {
    if (!transaction) {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
    } else {
      const context = (
        await c.query(`SELECT current_setting('transaction_isolation') isolation,
        current_setting('transaction_read_only') read_only,current_setting('TimeZone') timezone`)
      ).rows[0];
      assert.equal(context.isolation, 'repeatable read');
      assert.equal(context.read_only, 'on');
      assert.equal(context.timezone, 'UTC');
    }
    const firms = (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const databases = (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
    assert(
      baseline.firms.every((id: string) => firms.includes(id)),
      'Missing an earlier firm',
    );
    assert(
      baseline.users.every((id: string) => users.includes(id)),
      'Missing an earlier user',
    );
    assert.deepEqual(databases, baseline.databases, 'Database inventory changed');
    const changed: Array<{ table: string; before_count: number; after_count: number }> = [];
    for (const name of baseline.names) {
      const columns = (
        await c.query(
          `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
          [name],
        )
      ).rows.map((r) => r.column_name);
      let where = '',
        params: unknown[] = [];
      if (name === 'tenants') {
        where = 'WHERE t.id=ANY($1::uuid[])';
        params = [baseline.firms];
      } else if (name === 'users') {
        where = 'WHERE t.id=ANY($1::uuid[])';
        params = [baseline.users];
      } else if (columns.includes('tenant_id')) {
        where = 'WHERE t.tenant_id=ANY($1::uuid[])';
        params = [baseline.firms];
      } else if (columns.includes('user_id')) {
        where = 'WHERE t.user_id=ANY($1::uuid[])';
        params = [baseline.users];
      } else if (name === 'migrations') {
        where = 'WHERE NOT name=ANY($1::text[])';
        params = [
          [
            '090_wms_lots',
            '091_wms_lot_packing',
            '092_wms_stocktakes',
            '093_wms_validation_scopes',
            ...additional,
          ],
        ];
      }
      const projection = await earlierPurchaseProjection(
        c,
        name,
        additional.includes('099_replenishment_plans'),
        where,
        params,
      );
      const rows = (
        await c.query(
          `SELECT ${projection} row FROM ${identifier(name)} t ${where} ORDER BY 1`,
          params,
        )
      ).rows;
      if (['tenants', 'users', 'memberships'].includes(name)) {
        assert.equal(
          rows.length,
          baseline.before[name].count,
          'Earlier identity count changed: ' + name,
        );
        assert.equal(
          hash(rows),
          baseline.before[name].sha256,
          'Earlier identity data changed: ' + name,
        );
      }
      if (
        rows.length !== baseline.before[name].count ||
        hash(rows) !== baseline.before[name].sha256
      )
        changed.push({
          table: name,
          before_count: baseline.before[name].count,
          after_count: rows.length,
        });
    }
    const clockTrace = changed.length ? await verifyWmsLotsPreservationTrace(c, baseline) : null;
    const backgroundTrace = changed.length
      ? await verifyWmsLotsBackgroundProvenance(c, baseline)
      : null;
    const tracedTables = new Set([
      ...(clockTrace?.traced_tables ?? []),
      ...(backgroundTrace?.tables.filter((t) => t.status !== 'NOT_PROVEN').map((t) => t.table) ??
        []),
    ]);
    const traced =
      clockTrace?.status === 'PROVEN_EXACT_CLOCK_RECONSTRUCTION' &&
      backgroundTrace?.status === 'PROVEN_BACKGROUND_PROVENANCE' &&
      changed.every((entry) => tracedTables.has(entry.table));
    if (!transaction) await c.query('COMMIT');
    return {
      status: !changed.length || traced ? 'PASS' : 'RAW_DRIFT_REQUIRES_REVIEW',
      raw_status: changed.length ? 'RAW_DIFFERENCES_RETAINED' : 'RAW_EXACT',
      baseline_file: baselinePath,
      originalsha256: bytesHash(raw),
      original_baseline_sha256: bytesHash(raw),
      baseline_rebased: false,
      earlier_firms: baseline.firms.length,
      earlier_users: baseline.users.length,
      original_databases: baseline.databases.length,
      compared_tables: baseline.names.length,
      changed,
      exact_tables: baseline.names.length - changed.length,
      traced_background_tables: traced ? changed.length : 0,
      unproven_changes: changed.filter((entry) => !tracedTables.has(entry.table)),
      clock_trace: clockTrace,
      background_trace: backgroundTrace,
    };
  } finally {
    if (!transaction) {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
}
