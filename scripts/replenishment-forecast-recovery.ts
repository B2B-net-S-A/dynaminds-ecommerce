/** Operator-only119 encrypted recovery; no source mutations or provider worker. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  localDatabase,
  restoreDatabaseName,
  createBackup,
  restoreBackup,
  tableFingerprints,
} from '../server/recovery';
import { pool } from '../server/db';
type Json = Record<string, any>;
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const statePath = 'data/replenishment-forecast-stage119.json';
assert.equal((await lstat(statePath)).mode & 0o077, 0);
const s = JSON.parse(await readFile(statePath, 'utf8')) as Json;
assert(s.stage === 119 && s.accepted_checkpoint && s.setup_complete);
const source = localDatabase(),
  port = 4158,
  url = `http://127.0.0.1:${port}/api`;
const admin = new pg.Client({ ...source, database: 'postgres' });
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let copied: pg.Client | undefined,
  child: ReturnType<typeof spawn> | undefined,
  owned: string | undefined;
let copyLog = '',
  phase = 'prerequisites',
  prior: string[] = [],
  report: Json = { status: 'PENDING', revision, full_goal_complete: false };
async function checkpoint(c: pg.Client | pg.PoolClient) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Json = {};
    for (const name of Object.keys(s.accepted_checkpoint).sort()) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const field = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${field}=$1 ORDER BY 1`, [
          name === 'users' ? s.user : s.tenant,
        ])
      ).rows;
      result[name] = { count: rows.length, sha256: hash(rows) };
    }
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function verifySource() {
  const c = await pool.connect();
  try {
    assert.deepEqual(await checkpoint(c), s.accepted_checkpoint, 'Source119 changed');
  } finally {
    c.release();
  }
}
async function call(path: string, cookie = '', method = 'GET', body?: string) {
  return fetch(url + path, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(10000),
  });
}
try {
  await admin.connect();
  prior = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
    (r) => r.datname,
  );
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await verifySource();
  phase = 'encrypted backup and full restore';
  const backup = await createBackup();
  const restored = await restoreBackup(backup.file);
  owned = restoreDatabaseName(restored.database);
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      restored.preview_only &&
      restored.worker_enabled === false,
  );
  copied = new pg.Client({ ...source, database: owned });
  await copied.connect();
  assert.deepEqual(await checkpoint(copied), s.accepted_checkpoint, 'Restored119 differs');
  assert.equal(
    (await copied.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
    '100_replenishment_forecast',
  );
  const journalTriggers = (
    await copied.query(
      "SELECT tgname FROM pg_trigger WHERE tgrelid='stock_movements'::regclass AND NOT tgisinternal AND tgname LIKE 'replenishment_forecast_%' ORDER BY tgname",
    )
  ).rows.map((r) => r.tgname);
  assert.deepEqual(journalTriggers, [
    'replenishment_forecast_admission',
    'replenishment_forecast_delete',
    'replenishment_forecast_insert',
    'replenishment_forecast_update',
  ]);
  const before = await tableFingerprints(copied);
  phase = 'read-only HTTP';
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      restored.directory + '/result.json',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DYNA_PREVIEW_PORT: String(port), APP_REVISION: revision },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (d) => (copyLog += d.toString()));
  child.stderr?.on('data', (d) => (copyLog += d.toString()));
  let health: Json | undefined;
  for (let i = 0; i < 80; i++) {
    assert(child.exitCode === null, 'Copy server exited: ' + copyLog.slice(-2000));
    try {
      const r = await call('/health');
      if (r.ok) {
        health = (await r.json()) as Json;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert(
    health?.restore_preview &&
      health.replenishment_forecast_available &&
      health.schema_revision === '100_replenishment_forecast',
  );
  const cross = await call('/replenishment/options', s.cookie);
  assert.equal(cross.status, 401);
  const login = await call(
    '/auth/login',
    '',
    'POST',
    JSON.stringify({ email: s.email, password: s.password }),
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const optionsResponse = await call('/replenishment/options', cookie);
  assert.equal(optionsResponse.status, 200);
  const options = (await optionsResponse.json()) as Json;
  assert(
    options.forecast_available && options.read_only && !options.can_preview && !options.can_execute,
  );
  const heads = (
    await copied.query(
      'SELECT * FROM replenishment_previews WHERE tenant_id=$1 ORDER BY created_at,id',
      [s.tenant],
    )
  ).rows;
  assert.equal(heads.length, 2);
  const readbacks: Json[] = [];
  for (const h of heads) {
    const hr = await call('/replenishment/previews/' + h.id, cookie);
    assert.equal(hr.status, 200);
    const hp = (await hr.json()) as Json;
    assert.deepEqual(hp.preview.config.forecast, h.config.forecast);
    assert.deepEqual(hp.preview.config.forecast_window, h.config.forecast_window);
    const rr = await call('/replenishment/previews/' + h.id + '/rows', cookie);
    assert.equal(rr.status, 200);
    assert.equal(rr.headers.get('cache-control'), 'no-store');
    const rp = (await rr.json()) as Json;
    const row: Json = (
      await copied.query(
        'SELECT snapshot,result FROM replenishment_rows WHERE tenant_id=$1 AND preview_id=$2',
        [s.tenant, h.id],
      )
    ).rows[0];
    assert.equal(rp.data.length, 1);
    assert.deepEqual(rp.data[0].demand, row.snapshot.demand);
    assert.equal(rp.data[0].recommended_quantity, row.result.recommended_quantity);
    readbacks.push({ id: h.id, demand_exact: true, result_exact: true });
  }
  const rejected = [];
  for (const path of [
    '/replenishment/previews',
    '/replenishment/policies',
    '/replenishment/previews/' + heads[0].id + '/execute',
  ]) {
    const r = await call(path, cookie, 'POST', '{malformed');
    assert.equal(r.status, 423);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    rejected.push({ path, status: 423 });
  }
  const after = await tableFingerprints(copied);
  for (const name of Object.keys(before))
    if (name !== 'sessions')
      assert.deepEqual(after[name], before[name], 'Copy HTTP mutated ' + name);
  const sourceCross = await fetch('http://127.0.0.1:4100/api/replenishment/options', {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(sourceCross.status, 401);
  report = {
    status: 'PASS',
    revision,
    schema_revision: health.schema_revision,
    backup: {
      tables: backup.tables,
      migrations: backup.schema,
      encryption: backup.encryption,
      sha256: backup.sha256,
    },
    restore: {
      tables: restored.tables,
      encrypted_records_verified: restored.encrypted_records_verified,
      row_fingerprints_match: true,
      schema_fingerprint_match: true,
      worker_enabled: false,
    },
    own_checkpoint_tables: Object.keys(s.accepted_checkpoint).length,
    own_checkpoint_sha256: hash(s.accepted_checkpoint),
    source_copy_exact: true,
    journal_triggers: journalTriggers,
    readbacks,
    malformed_writes: rejected,
    copy_business_tables_unchanged: true,
    cross_source_copy_sessions_denied: true,
    chrome_copy_verified: false,
    provider_operations: false,
    full_goal_complete: false,
  };
} catch (e) {
  report = {
    status: 'FAIL',
    revision,
    phase,
    error: e instanceof Error ? e.message : String(e),
    full_goal_complete: false,
  };
  throw e;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child!.once('exit', resolve)), delay(5000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child!.once('exit', resolve));
    }
  }
  await copied?.end();
  if (owned) await admin.query(`DROP DATABASE "${restoreDatabaseName(owned)}"`);
  if (prior.length) {
    const now = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
    assert.deepEqual(now, prior, 'Original database inventory changed');
    await verifySource();
    report.source_after_cleanup_exact = true;
    report.original_database_names = prior.length;
    report.owned_copy_removed = true;
  }
  await admin.end();
  await pool.end();
  await writeFile(
    'docs/replenishment-forecast-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile('data/replenishment-forecast-recovery-copy-log.txt', copyLog, { mode: 0o600 });
  console.log(
    JSON.stringify({ status: report.status, phase, copy_removed: report.owned_copy_removed }),
  );
}
