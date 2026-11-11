/** Read-only baseline before packing110; never replace a prior baseline. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const names = [
  'tenants',
  'products',
  'product_logistics',
  'product_sku_aliases',
  'price_lists',
  'price_list_items',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'stock_location_operations',
  'listings',
  'offer_plans',
  'shipments',
  'shipping_plans',
  'documents',
  'product_translations',
  'ai_catalog_drafts',
  'deepl_catalog_drafts',
  'deepl_catalog_batches',
  'shopify_translation_plans',
  'shopify_translation_observations',
  'shopify_translation_simulations',
  'shopify_translation_claims',
  'shopify_translation_batches',
  'shopify_translation_batch_items',
  'price_bulk_edit_previews',
  'price_bulk_edit_rows',
  'price_bulk_edit_executions',
  'price_bulk_edit_execution_rows',
  'product_translation_bulk_edit_previews',
  'product_translation_bulk_edit_rows',
  'product_translation_bulk_edit_executions',
  'product_translation_bulk_edit_execution_rows',
] as const;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
try {
  const health = (await fetch('http://127.0.0.1:4100/api/health').then((r) => r.json())) as any;
  assert.equal(health.schema_revision, '088_product_translation_bulk_edit');
  assert.equal(health.revision, '0de1703');
  assert.equal(health.restore_preview, false);
  const c = await pool.connect();
  let state: any;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const ids = (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await c.query('SELECT to_jsonb(u) row FROM users u ORDER BY id')).rows;
    const databases = (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
    const before: Record<string, { count: number; sha256: string }> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const scope =
        name === 'shopify_translation_claims'
          ? 'EXISTS(SELECT 1 FROM shopify_translation_plans p WHERE p.id=t.plan_id AND p.tenant_id=ANY($1::uuid[]))'
          : `${name === 'tenants' ? 't.id' : 't.tenant_id'}=ANY($1::uuid[])`;
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${scope} ORDER BY 1`, [ids])
      ).rows;
      before[name] = { count: rows.length, sha256: hash(rows) };
    }
    const migrations = (await c.query('SELECT name FROM migrations ORDER BY name')).rows.map(
      (r) => r.name,
    );
    state = {
      stage: 110,
      captured_at: new Date().toISOString(),
      runtime_revision: health.revision,
      schema: health.schema_revision,
      ids,
      user_ids: users.map((r) => r.row.id),
      users_sha256: hash(users),
      names,
      before,
      databases,
      migrations,
      baseline_rebased: false,
      operational_jobs_sessions_schedules_in_scope: false,
    };
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  await writeFile(
    'data/packing-workstation-stage110-baseline.json',
    JSON.stringify(state, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
  const report = {
    stage: 110,
    status: 'BASELINE_CAPTURED; packing implementation and acceptance pending',
    captured_at: state.captured_at,
    runtime_revision: state.runtime_revision,
    schema: state.schema,
    prior_firms: state.ids.length,
    prior_users: state.user_ids.length,
    named_business_tables: names.length,
    prior_databases: state.databases.length,
    baseline_rebased: false,
    operational_jobs_sessions_schedules_in_scope: false,
    provider_verified: false,
    goal_complete: false,
  };
  await writeFile(
    'docs/packing-workstation-baseline-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(report);
} finally {
  await pool.end();
}
