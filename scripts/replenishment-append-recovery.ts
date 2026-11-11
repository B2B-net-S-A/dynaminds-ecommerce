/** Operator-only120 encrypted recovery; no source mutations or provider worker. */
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
const statePath = 'data/replenishment-append-stage120.json';
assert.equal((await lstat(statePath)).mode & 0o077, 0);
const s = JSON.parse(await readFile(statePath, 'utf8')) as Json;
assert(s.stage === 120 && s.accepted_checkpoint && s.setup_complete);
const source = localDatabase(),
  port = 4159,
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
    assert.deepEqual(await checkpoint(c), s.accepted_checkpoint, 'Source120 changed');
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
  assert.deepEqual(await checkpoint(copied), s.accepted_checkpoint, 'Restored120 differs');
  assert.equal(
    (await copied.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
    '101_replenishment_append',
  );
  const collector = (
    await copied.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,
    has_table_privilege('dyna_app',c.oid,'SELECT') AS app_select,
    has_table_privilege('dyna_app',c.oid,'INSERT') AS app_insert,
    has_table_privilege('dyna_app',c.oid,'UPDATE') AS app_update,
    has_table_privilege('dyna_app',c.oid,'DELETE') AS app_delete
    FROM pg_class c WHERE c.oid='replenishment_append_preparations'::regclass`)
  ).rows[0];
  assert(collector.relrowsecurity && collector.relforcerowsecurity);
  assert(
    !collector.app_select &&
      !collector.app_insert &&
      !collector.app_update &&
      !collector.app_delete,
  );
  assert.equal(
    Number(
      (await copied.query('SELECT count(*) FROM replenishment_append_preparations')).rows[0].count,
    ),
    0,
  );
  const seals = (
    await copied.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,
    has_table_privilege('dyna_app',c.oid,'SELECT') AS app_select,
    has_table_privilege('dyna_app',c.oid,'INSERT') AS app_insert,
    has_table_privilege('dyna_app',c.oid,'UPDATE') AS app_update,
    has_table_privilege('dyna_app',c.oid,'DELETE') AS app_delete
    FROM pg_class c WHERE c.oid='replenishment_append_seals'::regclass`)
  ).rows[0];
  assert(seals.relrowsecurity && seals.relforcerowsecurity);
  assert(!seals.app_select && !seals.app_insert && !seals.app_update && !seals.app_delete);
  const sealsCount = Number(
    (
      await copied.query('SELECT count(*) FROM replenishment_append_seals WHERE tenant_id=$1', [
        s.tenant,
      ])
    ).rows[0].count,
  );
  const appendExecutions = Number(
    (
      await copied.query(
        `SELECT count(*) FROM replenishment_executions e
    WHERE e.tenant_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.groups) g WHERE g->'destination'->>'kind'='existing_draft')`,
        [s.tenant],
      )
    ).rows[0].count,
  );
  assert(appendExecutions >= 1);
  assert.equal(sealsCount, appendExecutions);
  assert.equal(
    Number(
      (
        await copied.query(
          `SELECT count(*) FROM replenishment_append_seals s
    LEFT JOIN replenishment_executions e ON (e.tenant_id,e.id)=(s.tenant_id,s.execution_id)
    WHERE s.tenant_id=$1 AND e.id IS NULL`,
          [s.tenant],
        )
      ).rows[0].count,
    ),
    0,
  );
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
      health.replenishment_append_available &&
      health.schema_revision === '101_replenishment_append',
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
    options.append_available && options.read_only && !options.can_preview && !options.can_execute,
  );
  const heads = (
    await copied.query(
      'SELECT * FROM replenishment_previews WHERE tenant_id=$1 ORDER BY created_at,id',
      [s.tenant],
    )
  ).rows;
  assert(heads.length >= 1);
  const readbacks: Json[] = [];
  let appends = 0;
  for (const h of heads) {
    const hr = await call('/replenishment/previews/' + h.id, cookie);
    assert.equal(hr.status, 200);
    assert.equal(hr.headers.get('cache-control'), 'no-store');
    const hp = (await hr.json()) as Json;
    assert.deepEqual(hp.preview.groups, h.groups);
    const rows: Json[] = [];
    let next: string | null = null;
    do {
      const rr = await call(
        '/replenishment/previews/' +
          h.id +
          '/rows?limit=100' +
          (next ? '&cursor=' + encodeURIComponent(next) : ''),
        cookie,
      );
      assert.equal(rr.status, 200);
      const rp = (await rr.json()) as Json;
      rows.push(...rp.data);
      next = rp.meta.cursor;
    } while (next);
    const stored: Json[] = (
      await copied.query(
        'SELECT id,status,snapshot,result FROM replenishment_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
        [s.tenant, h.id],
      )
    ).rows;
    assert.equal(rows.length, stored.length);
    for (let i = 0; i < stored.length; i++) {
      assert.equal(rows[i].id, stored[i].id);
      assert.equal(rows[i].status, stored[i].status);
      assert.equal(rows[i].recommended_quantity, stored[i].result.recommended_quantity);
    }
    appends += h.groups.filter((g: Json) => g.destination?.kind === 'existing_draft').length;
    readbacks.push({
      kind: 'preview',
      id: h.id,
      full_destination_groups_exact: true,
      rows: rows.length,
    });
  }
  const executions = (
    await copied.query(
      'SELECT id,groups FROM replenishment_executions WHERE tenant_id=$1 ORDER BY created_at,id',
      [s.tenant],
    )
  ).rows;
  assert(executions.length >= 1 && appends >= 1);
  for (const e of executions) {
    const er = await call('/replenishment/executions/' + e.id, cookie);
    assert.equal(er.status, 200);
    const ep = (await er.json()) as Json;
    assert.deepEqual(ep.execution.groups, e.groups);
    readbacks.push({ kind: 'execution', id: e.id, full_destination_groups_exact: true });
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
    collector_private_and_empty: true,
    seals_private_and_bound: true,
    own_durable_seals: sealsCount,
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
    'docs/replenishment-append-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile('data/replenishment-append-recovery-copy-log.txt', copyLog, { mode: 0o600 });
  console.log(
    JSON.stringify({ status: report.status, phase, copy_removed: report.owned_copy_removed }),
  );
}
