/** Root-operated read-only preservation. BEFORE must precede any native catalog DDL. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const primary = '<workspace>/app';
const docs = '<workspace>/worktrees/stock-file-import/docs';
const phase = process.argv[2];
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Fingerprint = { count: number; sha256: string };
async function regular(path: string, mode?: number) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Regular owned file required');
  if (mode !== undefined) assert.equal(stat.mode & 0o777, mode, 'Private mode required');
  return { sha256: sha(await readFile(path)), mode: stat.mode & 0o777 };
}
async function main() {
  assert(['before', 'after-source-gates', 'after-migration', 'after-final', 'after-restart'].includes(phase));
  assert.equal(resolve(process.cwd()), primary);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(primary, '.local.json'));
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const config = await regular(resolve(primary, '.local.json'), 0o600);
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{40}$/);
  const expectedSchema = ['before', 'after-source-gates'].includes(phase)
    ? '141_email_inbound' : process.env.QA157_SCHEMA_REVISION;
  assert(expectedSchema && /^\d{3}_[a-z_]+$/.test(expectedSchema), 'Explicit schema revision required');
  const healthReply = await fetch('http://127.0.0.1:4100/api/health', { signal: AbortSignal.timeout(10000) });
  assert.equal(healthReply.status, 200);
  const health: any = await healthReply.json();
  assert.equal(health.status, 'ok'); assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, expectedSchema); assert.equal(health.mode, 'local');
  assert.equal(health.background_workers_enabled, false); assert.equal(health.restore_preview, false);
  const baselinePath = resolve(docs, 'product-catalogs-preservation157-before.json');
  const prior: any = phase === 'before' ? null : JSON.parse(await readFile(baselinePath, 'utf8'));
  if (prior) { assert.equal(prior.stage, 157); assert.equal(prior.phase, 'before'); assert.equal(prior.status, 'PRESERVATION_PASS'); }
  // Import db only after the existing configuration and health were proven.
  const { pool } = await import('../server/db');
  try {
    const url = new URL(pool.options.connectionString!);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432'); assert.equal(url.pathname, '/dynaminds');
    const c = await pool.connect();
    const tables: Record<string, Fingerprint> = {}, columns: Record<string, string[]> = {};
    let tenants: string[] = [], users: string[] = [];
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const native = (await c.query('SELECT current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port')).rows[0];
      assert.deepEqual(native, { role: 'postgres', host: '127.0.0.1', port: 55432 });
      tenants = prior?.tenants ?? (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map(r => r.id);
      users = prior?.users ?? (await c.query('SELECT id FROM users ORDER BY id')).rows.map(r => r.id);
      if (!prior) assert.equal(tenants.length, 162, 'Expected all earlier native firms before catalog DDL');
      const names: string[] = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('tenants','users') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1")).rows.map(r => r.table_name);
      assert(names.length >= 413);
      if (prior) assert(Object.keys(prior.tables).every(n => names.includes(n)), 'Earlier table missing');
      for (const name of names) {
        assert.match(name, /^[a-z_][a-z0-9_]*$/);
        columns[name] = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY 1", [name])).rows.map(r => r.column_name);
        const oldColumns: string[] = prior?.columns[name] ?? columns[name];
        assert(oldColumns.every(n => columns[name].includes(n)), 'Earlier column missing');
        for (const column of oldColumns) assert.match(column, /^[a-z_][a-z0-9_]*$/);
        const key = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
        const rows = (await c.query(`SELECT to_jsonb(q) row FROM (SELECT ${oldColumns.map(n => `"${n}"`).join(',')} FROM "${name}" WHERE "${key}"=ANY($1::uuid[])) q ORDER BY 1`, [name === 'users' ? users : tenants])).rows;
        tables[name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
        if (prior?.tables[name]) assert.deepEqual(tables[name], prior.tables[name], 'Earlier business rows changed');
        // New catalog tables legitimately backfill earlier firms. Preserve their
        // counts as evidence; specific derived backfill is checked by SQL tests.
      }
      await c.query('COMMIT');
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    const private_files: Record<string, { sha256: string; mode: number }> = {};
    const names: string[] = prior ? Object.keys(prior.private_files) : (await readdir(resolve(primary, 'data'))).filter(n => n.endsWith('.json')).sort();
    for (const name of names) {
      assert.match(name, /^[A-Za-z0-9_.-]+\.json$/);
      private_files[name] = await regular(resolve(primary, 'data', name));
      if (prior) assert.deepEqual(private_files[name], prior.private_files[name], 'Earlier private file changed');
    }
    if (!prior) {
      const historical = JSON.parse(await readFile(resolve(docs, 'email-inbound-preservation156-before.json'), 'utf8'));
      assert.equal(Object.keys(historical.private_files).length, 363);
      for (const [name, value] of Object.entries(historical.private_files)) assert.deepEqual(private_files[name], value, 'Historical private custody changed');
    }
    if (prior) assert.deepEqual(config, prior.config, 'Local config changed');
    const report = { stage: 157, status: 'PRESERVATION_PASS', phase, revision,
      schema_revision: expectedSchema, tenants, users, tables, columns, private_files, config,
      old_column_projection_exact: true, new_backfill_independently_validated: false,
      sessions_excluded: true, baseline_rebased: false, full_goal_complete: false };
    const file = await open(resolve(docs, `product-catalogs-preservation157-${phase}.json`), 'wx', 0o644);
    try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    process.stdout.write(JSON.stringify({ status: report.status, phase, earlier_firms: tenants.length,
      tables: Object.keys(tables).length, private_files: names.length, backfill_proven: false }) + '\n');
  } finally { await pool.end(); }
}
main().catch(() => { process.stderr.write('QA157_PRESERVATION_FAILED_NO_PRIVATE_OUTPUT\n'); process.exitCode = 1; });
