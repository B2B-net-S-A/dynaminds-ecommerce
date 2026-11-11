/** Root-only QA148: read-only comparison with the unchanged QA147 checkpoint. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = '<workspace>/app';
const reportPath = '<workspace>/worktrees/stock-file-import/docs/print-jobs-access-race-native.json';
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
async function main() {
  assert.equal(resolve(process.cwd()), root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const setupBytes = await readFile(resolve(root, 'data/shipment-label-cache-stage147.json'));
  const setup = JSON.parse(setupBytes.toString());
  const previous = JSON.parse(await readFile(resolve(root, 'data/shipment-label-cache-stage147-after-restart.json'), 'utf8'));
  assert.equal(previous.setup_sha256, digest(setupBytes));
  const health = await (await fetch('http://127.0.0.1:4100/api/health')).json();
  assert.equal(health.revision, '0bd511781fcee5128b262bde92222f90d8882fbc');
  assert.equal(health.schema_revision, '131_shipment_label_cache');
  assert.equal(health.background_workers_enabled, false);
  const { pool } = await import('../server/db');
  const c = await pool.connect();
  try {
    const url = new URL(pool.options.connectionString!);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name")).rows.map(r => r.table_name);
    const rows: Record<string, unknown[]> = {};
    for (const name of [...names, 'users', 'tenants']) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      rows[name] = (await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${['users', 'tenants'].includes(name) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`, [name === 'users' ? setup.user_id : setup.tenant_id])).rows.map(r => r.row);
    }
    const hash = digest(JSON.stringify(rows));
    assert.equal(hash, digest(JSON.stringify(previous.rows)), 'Own snapshot hash changed.');
    assert.equal(Object.keys(rows).length, 373);
    await c.query('COMMIT');
    const report = { stage: 148, status: 'OWN_READ_ONLY_PRESERVATION_PASS', api_revision: health.revision, ui_source_sha256: digest(await readFile(resolve(root, 'web/print-jobs.tsx'))), schema_revision: health.schema_revision, tenant_id: setup.tenant_id, own_tables: 373, snapshot_sha256: hash, comparison: 'Original stage147 after-restart checkpoint; not rebased.', sessions_excluded: true, business_writes: 0, provider_requests: 0, full_goal_verified: false };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write('QA148_OWN_READ_ONLY_PRESERVATION_PASS\n');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); await pool.end(); }
}
main().catch(() => { process.stderr.write('QA148_READBACK_FAILED_NO_PRIVATE_OUTPUT\n'); process.exitCode = 1; });
