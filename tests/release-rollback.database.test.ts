/** MIG-4 on a real clone (dynaminds_mig145_20261028_NN at release N = ledger up to 243, data of release N): the
 * upgrade takes the MIG-3 backup and applies 244-263; the rollback is refused while the N+1 database is in use and
 * without consent; after N+1 stops, the confirmed rollback restores the backup into a NEW database whose ledger is N's
 * and whose every table is the pre-upgrade state (row count and digest), and leaves the N+1 database as it was.
 * Starting release N on the restored database is in docs/release-upgrade-rollback.md (packaged releases).
 *
 *   DATABASE_URL=postgres://postgres:…@127.0.0.1:57084/dynaminds_mig145_20261028_NN DYNA_TEST=true DYNA_MIGRATION_BACKUP=required \
 *   DYNA_LOCAL_CONFIG_PATH=<config> DYNA_IMAGE_DIR=<images of the clone> MIG4_DATA_DIR=<new private dir> \
 *   node node_modules/tsx/dist/cli.mjs --test tests/release-rollback.database.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'invalid://missing', database = new URL(url);
assert.equal(process.env.DYNA_TEST, 'true');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_(?:mig145_20261028|m25[0123]_20261028|m(?:25[456789]|26[0123])_202610(?:2[89]|30))_[0-9]{2}$/, 'disposable clone dynaminds_mig145_20261028_NN (or m250/m251/m252/m253/m254/m255/m256/m257/m258/m259/m260/m261/m262/m263) at 243 required');
assert.equal(process.env.DYNA_MIGRATION_BACKUP, 'required');
const data = process.env.MIG4_DATA_DIR!;
assert(data && data.startsWith('/'), 'MIG4_DATA_DIR=<absolute new directory>');
mkdirSync(data, { mode: 0o700 }); chmodSync(data, 0o700);
process.env.DYNA_DATA_DIR = data;

const at = (name: string) => { const u = new URL(url); u.pathname = '/' + name; return u.toString(); };
async function query<T = Record<string, unknown>>(db: string, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: at(db), options: '-c timezone=UTC -c extra_float_digits=3 -c DateStyle=ISO' });
  await c.connect();
  try { return (await c.query(sql)).rows as T[]; } finally { await c.end(); }
}
/** Row count and digest of every public table (tools/parity/table-fingerprints.mjs, inline). */
async function fingerprints(db: string) {
  const tables = await query<{ relname: string; cols: string[] }>(db, `SELECT c.relname, array_agg(a.attname::text ORDER BY a.attnum) cols FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname`);
  const out: Record<string, string> = {};
  for (const t of tables) {
    const row = t.cols.map((x) => `coalesce("${x}"::text,'∅')`).join(`||'|'||`);
    const [r] = await query<{ n: string; d: string }>(db, `SELECT count(*) n, md5(coalesce(string_agg(v, E'\\n' ORDER BY v),'')) d FROM (SELECT ${row} v FROM public."${t.relname}") s`);
    out[t.relname] = r.n + ':' + r.d;
  }
  return out;
}
const ledger = async (db: string) => (await query<{ name: string }>(db, 'SELECT name FROM migrations ORDER BY name')).map((r) => r.name);

test('upgrade with the MIG-3 backup, then the consented rollback restores release N into a new database', { timeout: 1800000 }, async () => {
  const n = new URL(url).pathname.slice(1);
  const before = await fingerprints(n), ledgerN = await ledger(n);
  assert.equal(ledgerN.at(-1), '243_ksef_purchase');
  const { migrate, pool, lastMigrationBackup } = await import('../server/db');
  await migrate();
  const receipt = lastMigrationBackup();
  assert(receipt, 'MIG-3 backup taken before 244-263');
  assert.deepEqual(receipt.pending, ['244_custom_events_checksums', '245_s5_comm', '246_b2b_trade_credit_directory', '247_sales_dimensions_repricing', '248_guard_verdicts', '249_catalog_ai', '250_wms_evidence_settle_unlocked', '251_b2b_network_lifecycle', '252_mirakl_operations', '253_mirakl_webhook_retention', '254_carrier_returns', '255_stock_verdict', '256_return_receipt_verdicts', '257_order_merge_snapshot_index_paths', '258_wz_issuer_refresh', '259_jobs_running_lease', '260_automation_runs_queued_job', '261_stocktake_evidence_usage', '262_revoke_public_temporary', '263_manual_off_verdict', '264_order_status_labels', '265_wms_order_line_resize', '266_accountant_order_settings', '267_status_categories_automation_editors', '268_cancelled_label_relabel', '269_order_warehouse_transfer']);
  assert.deepEqual(readdirSync(join(data, 'backups/pre-migration')).sort(), [receipt.id + '.dyna', receipt.id + '.dyna.json']);
  const ledgerN1 = await ledger(n), afterUpgrade = await fingerprints(n);
  assert.equal(ledgerN1.length, ledgerN.length + 20);

  const { rollbackToBackup, RollbackRefusedError } = await import('../server/release-rollback');
  const restores = join(data, 'restores'), keyFile = join(data, '.recovery-key');
  await assert.rejects(() => rollbackToBackup({ backup: receipt.file, keyFile, directory: restores }), (e) => e instanceof RollbackRefusedError && /--confirm/.test(e.message));
  // The process still holds its pool connections to the N+1 database: that is a running N+1.
  await pool.query('SELECT 1');
  await assert.rejects(() => rollbackToBackup({ backup: receipt.file, keyFile, directory: restores, confirm: n }), (e) => e instanceof RollbackRefusedError && /inne połączenia: zatrzymaj wydanie N\+1/.test(e.message));
  await pool.end();
  const t = performance.now();
  const r = await rollbackToBackup({ backup: receipt.file, keyFile, directory: restores, confirm: n });
  console.log('rollback ms', Math.round(performance.now() - t), r.database);
  assert.equal(r.status, 'rolled_back'); assert.equal(r.preview_only, false); assert.equal(r.rollback_of, n);
  assert.deepEqual(r.ledger.removed, receipt.pending);
  assert.equal(r.ledger.restored, ledgerN.length);
  assert.deepEqual(JSON.parse(readFileSync(join(r.directory, 'rollback.json'), 'utf8')).database, r.database);
  assert.equal(JSON.parse(readFileSync(join(r.directory, 'result.json'), 'utf8')).purpose, 'rollback');
  try {
    assert.deepEqual(await ledger(r.database), ledgerN, 'restored ledger = release N');
    const restored = await fingerprints(r.database);
    assert.deepEqual(Object.keys(restored), Object.keys(before), 'the same tables as before the upgrade (no 244-249, 251 or 252 table)');
    const differ = Object.keys(before).filter((k) => restored[k] !== before[k]);
    assert.deepEqual(differ, [], 'every table of release N restored row for row');
    assert.deepEqual(await fingerprints(n), afterUpgrade, 'the N+1 database is left as it was');
  } finally {
    await query('postgres', `DROP DATABASE IF EXISTS ${r.database} WITH (FORCE)`);
  }
});
