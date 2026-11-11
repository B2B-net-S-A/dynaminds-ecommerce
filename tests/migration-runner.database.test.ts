/** MIG-1 on a real clone (dynaminds_mig145_20261028_NN or dynaminds_m250/m251/m252/m253/m254/m255/m256/m257/m258_2026102[89]_NN at release N = ledger up to
 * 243_ksef_purchase, so 244-263 are pending). The runner applies the pending series in one transaction under the 982376 advisory fence:
 *  1. a migration that fails in the middle of the series (248, after 244-247 ran in the same transaction, before 249,
 *     250, 251, 252, 253, 254, 255, 256, 257 and 258) rolls the whole series back: same ledger, no object of 244-247, the error names the migration; after the cause is removed
 *     the same start applies everything;
 *  2. a second instance that finds the fence taken waits for it (longer than the 8 s lock_timeout of the session)
 *     instead of failing with a raw 55P03, and then finds nothing pending; a wait longer than the budget is a clear
 *     refusal that changes nothing.
 *
 *   DATABASE_URL=postgres://postgres:…@127.0.0.1:57084/dynaminds_mig145_20261028_NN DYNA_TEST=true \
 *   DYNA_LOCAL_CONFIG_PATH=<config> node node_modules/tsx/dist/cli.mjs --test tests/migration-runner.database.test.ts */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, pool } from '../server/db';
import { MigrationFailedError, MigrationLockTimeoutError, MIGRATION_LOCK_KEY } from '../server/migration-bootstrap';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_(?:mig145_20261028|m25[0123]_20261028|m(?:25[456789]|26[0123])_202610(?:2[89]|30))_[0-9]{2}$/, 'disposable clone dynaminds_mig145_20261028_NN (or m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263) at 243 required');
after(() => pool.end());

const PENDING = ['244_custom_events_checksums', '245_s5_comm', '246_b2b_trade_credit_directory', '247_sales_dimensions_repricing', '248_guard_verdicts', '249_catalog_ai', '250_wms_evidence_settle_unlocked', '251_b2b_network_lifecycle', '252_mirakl_operations', '253_mirakl_webhook_retention', '254_carrier_returns', '255_stock_verdict', '256_return_receipt_verdicts', '257_order_merge_snapshot_index_paths', '258_wz_issuer_refresh', '259_jobs_running_lease', '260_automation_runs_queued_job', '261_stocktake_evidence_usage', '262_revoke_public_temporary', '263_manual_off_verdict', '264_order_status_labels', '265_wms_order_line_resize', '266_accountant_order_settings', '267_status_categories_automation_editors'];
const state = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM migrations) ledger,
  (SELECT md5(string_agg(name||coalesce(applied_at::text,''),',' ORDER BY name)) FROM migrations) ledger_md5,
  (SELECT max(name) FROM migrations) last,
  to_regclass('public.migration_checksums') IS NOT NULL checksums244,
  (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('custom_event_defs','portal253_link_policies','b2b254_trade_lines','order_sales_dimensions','guard_verdicts','catalog_ai_batches','b2b258_link_states','mirakl262_operations','mirakl263_webhook_events_received','carrier261_returns')) objects,
  (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE proname='guard_verdict_basis') basis248,
  (SELECT prosrc !~ 'FOR UPDATE' FROM pg_catalog.pg_proc WHERE oid='public.wms_evidence_usage_settle()'::regprocedure) settle250`)).rows[0];
const holder = async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  return { release: async () => { await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]); await c.end(); } };
};

test('a migration failing after four others in the series rolls the whole series back; removing the cause lets the same start apply all', { timeout: 600000 }, async () => {
  const before = await state();
  assert.equal(before.last, '243_ksef_purchase', 'clone at release N (243)');
  assert.deepEqual([before.checksums244, before.objects, before.basis248, before.settle250], [false, 0, 0, false]);
  // The cause: an object of the same name already exists, so 248's CREATE TABLE fails (42P07) after 244-247 ran.
  await pool.query('CREATE TABLE public.guard_verdicts(conflict int)');
  const t = performance.now();
  await assert.rejects(() => migrate(), (e: any) => {
    assert(e instanceof MigrationFailedError, String(e?.stack ?? e));
    assert.equal(e.code, 'MIGRATION_FAILED');
    assert.equal(e.migration, '248_guard_verdicts');
    assert.equal(e.file, '248_guard_verdicts.sql');
    assert.equal((e.cause as { code?: string })?.code, '42P07');
    assert.match(e.message, /^Migracja 248_guard_verdicts \(248_guard_verdicts\.sql\) nie powiodła się; cała seria \(244_custom_events_checksums … 267_status_categories_automation_editors\) została wycofana/);
    return true;
  });
  console.log('failed series ms', Math.round(performance.now() - t));
  const failed = await state();
  assert.deepEqual(failed, { ...before, objects: 1 }, 'ledger, 244 register, 244-249, 251, 252, 253, 254, 255, 256, 257 and 258 objects and the 235 settle as before (only the conflicting table)');
  await pool.query('DROP TABLE public.guard_verdicts');
  assert.deepEqual(await state(), before);
});

test('with the fence held longer than the budget, the start is refused clearly and nothing changes', { timeout: 120000 }, async () => {
  const before = await state(), lock = await holder();
  try {
    const t = performance.now();
    await assert.rejects(() => migrate({ lockWaitMs: 2000 }), (e: any) => {
      assert(e instanceof MigrationLockTimeoutError, String(e?.stack ?? e));
      assert.equal(e.code, 'MIGRATION_LOCK_TIMEOUT');
      assert.match(e.message, /^Migracje tej bazy wykonuje teraz inna instancja aplikacji/);
      return true;
    });
    const waited = performance.now() - t;
    assert(waited >= 1900 && waited < 8000, `refused after the 2 s budget, not the 8 s lock_timeout (${Math.round(waited)} ms)`);
  } finally { await lock.release(); }
  assert.deepEqual(await state(), before);
});

test('two instances started while the fence is held both wait past the 8 s lock_timeout; one applies the series, the other finds nothing pending', { timeout: 900000 }, async () => {
  const before = await state(), lock = await holder();
  let settled = 0, released = false;
  try {
    const runs = [migrate(), migrate()].map((p) => p.finally(() => { settled++; }));
    await new Promise((r) => setTimeout(r, 11000));
    assert.equal(settled, 0, 'both still waiting for the fence after 11 s');
    await lock.release(); released = true;
    await Promise.all(runs);
  } finally { if (!released) await lock.release(); }
  const after = await state();
  assert.equal(after.ledger, before.ledger + PENDING.length);
  assert.equal(after.last, '267_status_categories_automation_editors');
  assert.deepEqual([after.checksums244, after.objects, after.basis248, after.settle250], [true, 10, 1, true], 'one table of each of 244-249, 251, 252 and 254, the 253 index and the 250 settle body; 255 and 256 add functions only, 257 changes the 209 snapshot body, 258 adds a function and changes the 239 verdict, 263 adds functions only');
  const applied = (await pool.query("SELECT name FROM migration_checksums WHERE origin='applied' ORDER BY name")).rows.map((r) => r.name);
  assert.deepEqual(applied, PENDING, 'each pending migration recorded once, as applied');
  await migrate();
  assert.deepEqual(await state(), after, 'a later start changes nothing');
});
