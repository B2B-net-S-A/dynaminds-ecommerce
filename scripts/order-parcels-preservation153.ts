/** Native read-only baseline for commercial parcel changes. Never rebase accepted history. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';

const root = '<workspace>/app';
const docs = '<workspace>/worktrees/stock-file-import/docs';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const phase = process.argv[2];
const counters = new Set(['reservations', 'reservation_locations', 'wms_reservation_layers']);
async function main() {
  assert(['before', 'after-source-gates', 'after-migration', 'after-final'].includes(phase));
  assert.equal(resolve(process.cwd()), root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{40}$/);
  const response = await fetch('http://127.0.0.1:4100/api/health', { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.revision, revision);
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(health.mode, 'local');
  assert.equal(health.schema_revision, ['before','after-source-gates'].includes(phase) ? '135_order_parcel_completion_fix' : '138_order_parcel_returns');
  const prior = phase === 'before' ? null : JSON.parse(await readFile(resolve(docs, 'order-parcels-preservation153-before.json'), 'utf8'));
  const c = await pool.connect();
  const tables: Record<string, { count: number; sha256: string }> = {};
  const columns: Record<string, string[]> = {};
  let tenants: string[] = [], users: string[] = [];
  try {
    const url = new URL(pool.options.connectionString!);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SELECT current_user role')).rows[0].role, 'postgres');
    tenants = prior?.tenants ?? (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map(r => r.id);
    users = prior?.users ?? (await c.query('SELECT id FROM users ORDER BY id')).rows.map(r => r.id);
    const names: string[] = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('tenants','users') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name")).rows.map(r => r.table_name);
    if (prior) assert(Object.keys(prior.tables).every(name => names.includes(name)), 'An existing table disappeared');
    else { assert.equal(names.length, 383); assert.equal(tenants.length, 155); }
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      columns[name] = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name", [name])).rows.map(r => r.column_name);
      const original = prior?.columns[name];
      if (original) assert.deepEqual(columns[name].filter(n => !(counters.has(name) && n === 'released_quantity')), original, 'Existing columns changed');
      if (original && counters.has(name) && columns[name].includes('released_quantity')) assert.equal((await c.query(`SELECT count(*)::int n FROM "${name}" WHERE tenant_id=ANY($1::uuid[]) AND released_quantity<>0`, [tenants])).rows[0].n, 0, 'Earlier firms acquired releases');
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const projection = original && counters.has(name) ? "to_jsonb(q)-'released_quantity'" : 'to_jsonb(q)';
      const rows = (await c.query(`SELECT ${projection} row FROM "${name}" q WHERE ${key}=ANY($1::uuid[]) ORDER BY 1`, [name === 'users' ? users : tenants])).rows;
      tables[name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
      if (prior?.tables[name]) assert.deepEqual(tables[name], prior.tables[name], 'Earlier firm history changed');
      else if (prior) assert.equal(rows.length, 0, 'New records in earlier firms');
    }
    await c.query('COMMIT');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  const private_files: Record<string, { sha256: string; mode: number }> = {};
  const names = prior ? Object.keys(prior.private_files) : (await readdir(resolve(root, 'data'))).filter(n => n.endsWith('.json')).sort();
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/);
    const path = resolve(root, 'data', name), stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink());
    private_files[name] = { sha256: sha(await readFile(path)), mode: stat.mode & 0o777 };
    if (prior) assert.deepEqual(private_files[name], prior.private_files[name], 'Earlier private file changed');
  }
  const configPath = resolve(root, '.local.json'), stat = await lstat(configPath);
  assert(stat.isFile() && !stat.isSymbolicLink());
  const config = { sha256: sha(await readFile(configPath)), mode: stat.mode & 0o777 };
  if (prior) assert.deepEqual(config, prior.config, 'Local config changed');
  const report = { stage: 153, status: 'PRESERVATION_PASS', phase, revision, schema_revision: health.schema_revision, tenants, users, tables, columns, private_files, config, sessions_excluded: true, baseline_rebased: false, full_goal_complete: false };
  const file = await open(resolve(docs, `order-parcels-preservation153-${phase}.json`), 'wx', 0o644);
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  process.stdout.write(JSON.stringify({ status: report.status, phase, earlier_firms: tenants.length, tables: Object.keys(tables).length, private_files: names.length }) + '\n');
}
main().catch(() => { process.stderr.write('QA153_PRESERVATION_FAILED_NO_PRIVATE_OUTPUT\n'); process.exitCode = 1; }).finally(() => pool.end());
