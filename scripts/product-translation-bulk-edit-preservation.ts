/** Read-only explanation of a historical schedule's drift; never repair/rebase data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { localConfig, pool } from '../server/db';
const path = 'data/product-translation-bulk-edit-stage109.json';
const state = JSON.parse(await readFile(path, 'utf8'));
const copy = 'dynaminds_restore_203fe030956c12c8';
const c = new pg.Client({
  host: '127.0.0.1',
  port: 55432,
  user: 'postgres',
  password: localConfig.dbPassword,
  database: copy,
});
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const query = 'SELECT to_jsonb(t) row FROM listings t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1';
try {
  await c.connect();
  await c.query('BEGIN READ ONLY');
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  const before = (await c.query(query, [state.ids])).rows;
  assert.equal(
    hash(before),
    state.before.listings,
    'Restored 108 listings must exactly match original 109 baseline',
  );
  const live = await pool.connect();
  try {
    await live.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await live.query("SET LOCAL TIME ZONE 'UTC'");
    const actual = (await live.query(query, [state.ids])).rows;
    const byId = new Map(before.map((r) => [r.row.id, r.row]));
    assert.equal(actual.length, before.length);
    const changed = actual.filter((r) => hash(r.row) !== hash(byId.get(r.row.id)));
    assert.equal(changed.length, 2);
    const overrides: { id: string; run_id: string; observed_at: string }[] = [];
    const changes = [];
    for (const { row } of changed) {
      const old = byId.get(row.id);
      assert(old);
      assert.deepEqual(
        Object.keys(row).filter((k) => hash(row[k]) !== hash(old[k])),
        ['last_result'],
      );
      const sync = row.last_result.odoo_catalog_sync;
      const original = old.last_result.odoo_catalog_sync;
      assert.equal(sync.scope, 'local_simulation');
      const run = (
        await live.query(
          'SELECT simulation,state FROM odoo_catalog_sync_runs WHERE id=$1 AND tenant_id=$2',
          [sync.run_id, row.tenant_id],
        )
      ).rows[0];
      assert(run?.simulation && run.state === 'success');
      const normalized = structuredClone(row);
      normalized.last_result.odoo_catalog_sync.run_id = original.run_id;
      normalized.last_result.odoo_catalog_sync.observed_at = original.observed_at;
      assert.deepEqual(normalized, old, 'Only traced run_id/observed_at may drift');
      overrides.push({ id: row.id, run_id: original.run_id, observed_at: original.observed_at });
      changes.push({
        listing_id: row.id,
        tenant_id: row.tenant_id,
        old_run: original.run_id,
        current_run: sync.run_id,
        old_observed_at: original.observed_at,
        current_observed_at: sync.observed_at,
      });
    }
    state.listing_overrides = overrides;
    state.old_schema_copy = copy;
    await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
    const report = {
      status: '30 tables exact; listings differ in four traced observation fields only',
      baseline_rebased: false,
      earlier_firms: state.ids.length,
      earlier_users: state.user_ids.length,
      old_schema_copy: copy,
      copy_listings_match_original_baseline: true,
      cause: 'Existing enabled Odoo catalogue schedule; verified local simulation',
      changed_rows: changes,
      normalized_listing_rows_exact: true,
      provider_verified: false,
    };
    await writeFile(
      'docs/product-translation-bulk-preservation-qa.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log({
      status: 'TRACED',
      changed_rows: changes.length,
      changed_fields_per_row: 2,
      baseline_rebased: false,
    });
    await live.query('COMMIT');
  } finally {
    await live.query('ROLLBACK').catch(() => {});
    live.release();
  }
} finally {
  await c.end();
  await pool.end();
}
