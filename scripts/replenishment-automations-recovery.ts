/** Operator-only121 encrypted recovery; no source mutations or provider worker. */
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
const statePath = 'data/replenishment-automations-stage121.json';
assert.equal((await lstat(statePath)).mode & 0o077, 0);
const s = JSON.parse(await readFile(statePath, 'utf8')) as Json;
assert(s.stage === 121 && s.accepted_checkpoint && s.setup_complete);
assert.equal(s.runtime_revision, revision, 'Accepted source revision differs');
assert.equal(s.schema_revision, '102_replenishment_automations');
const source = localDatabase(),
  port = 4161,
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
    const membership = (
      await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
        s.tenant,
        s.user,
      ])
    ).rows;
    assert.equal(membership.length, 1, 'Own accepted membership required');
    assert.equal(membership[0].role, 'admin', 'Own accepted administrator required');
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
    assert.deepEqual(await checkpoint(c), s.accepted_checkpoint, 'Source121 changed');
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
  const sourceHealthResponse = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(sourceHealthResponse.status, 200);
  const sourceHealth = (await sourceHealthResponse.json()) as Json;
  assert.equal(sourceHealth.revision, revision);
  assert.equal(sourceHealth.schema_revision, s.schema_revision);
  assert.equal(sourceHealth.restore_preview, false);
  assert.equal(sourceHealth.replenishment_automations_available, true);
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
  assert.deepEqual(await checkpoint(copied), s.accepted_checkpoint);
  assert.equal(
    (await copied.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
    '102_replenishment_automations',
  );
  const tables = [
    'replenishment_automation_rules',
    'replenishment_automation_rule_items',
    'replenishment_automation_runs',
  ];
  const permissions = (
    await copied.query(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege('dyna_app',c.oid,'SELECT') app_select,has_table_privilege('dyna_app',c.oid,'INSERT') app_insert FROM pg_class c WHERE c.oid=ANY($1::regclass[]) ORDER BY c.relname`,
      [tables],
    )
  ).rows;
  assert.equal(permissions.length, 3);
  for (const p of permissions) assert(p.relrowsecurity && p.relforcerowsecurity && p.app_select);
  assert.equal(
    permissions.find((p) => p.relname === 'replenishment_automation_runs').app_insert,
    false,
  );
  const triggers = (
    await copied.query(
      `SELECT t.tgname,t.tgenabled,p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='stock'::regclass AND t.tgname='replenishment_automation_stock' AND NOT t.tgisinternal`,
    )
  ).rows;
  assert.deepEqual(triggers, [
    {
      tgname: 'replenishment_automation_stock',
      tgenabled: 'O',
      proname: 'replenishment_automation_capture',
    },
  ]);
  const rules = (
    await copied.query(
      'SELECT * FROM replenishment_automation_rules WHERE tenant_id=$1 ORDER BY id',
      [s.tenant],
    )
  ).rows;
  const runs = (
    await copied.query(
      'SELECT * FROM replenishment_automation_runs WHERE tenant_id=$1 ORDER BY id',
      [s.tenant],
    )
  ).rows;
  assert(rules.length >= 1 && runs.length >= 1 && runs.some((r) => r.state === 'done'));
  const before = await tableFingerprints(copied);
  const sessionsBefore = (
    await copied.query('SELECT to_jsonb(t) row FROM sessions t ORDER BY token_hash')
  ).rows;
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
    assert(child.exitCode === null, 'Copy server exited');
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
      health.replenishment_automations_available &&
      health.schema_revision === '102_replenishment_automations' &&
      health.revision === revision,
  );
  assert.equal((await call('/replenishment/automations/options', s.cookie)).status, 401);
  const login = await call(
    '/auth/login',
    '',
    'POST',
    JSON.stringify({ email: s.email, password: s.password }),
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const optionsResponse = await call('/replenishment/automations/options', cookie);
  assert.equal(optionsResponse.status, 200);
  const options = (await optionsResponse.json()) as Json;
  assert(options.available && options.read_only && !options.can_manage);
  const readbacks: Json[] = [];
  for (const r of rules) {
    const response = await call('/replenishment/automations/rules/' + r.id, cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()) as Json;
    const items: Json[] = (
      await copied.query(
        'SELECT product_id,policy_id,policy_version,product_version FROM replenishment_automation_rule_items WHERE tenant_id=$1 AND rule_id=$2 ORDER BY product_id',
        [s.tenant, r.id],
      )
    ).rows;
    assert.deepEqual(body.rule, {
      id: r.id,
      name: r.name,
      version: r.version,
      definition: r.definition,
      actor_id: r.actor_id,
      policy_items: items,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    });
    assert(body.read_only && !body.can_manage);
    readbacks.push({ kind: 'rule', id: r.id, full_public_head_exact: true, items: items.length });
  }
  for (const r of runs) {
    const response = await call('/replenishment/automations/runs/' + r.id, cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()) as Json;
    assert.deepEqual(body.run, {
      id: r.id,
      rule_id: r.rule_id,
      rule_version: r.rule_version,
      version: r.version,
      state: r.state,
      name: r.name,
      definition: r.definition,
      actor_id: r.actor_id,
      policy_items: r.policy_items,
      crossings: r.crossings,
      result: r.result,
      created_at: new Date(r.created_at).toISOString(),
      finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      can_cancel: false,
    });
    readbacks.push({ kind: 'run', id: r.id, full_public_head_exact: true, state: r.state });
    if (r.result.preview_id && r.result.execution_id) {
      for (const [kind, id, table] of [
        ['preview', r.result.preview_id, 'replenishment_previews'],
        ['execution', r.result.execution_id, 'replenishment_executions'],
      ]) {
        const h: Json = (
          await copied.query(
            `SELECT groups,summary,scope_hash FROM ${table} WHERE tenant_id=$1 AND id=$2`,
            [s.tenant, id],
          )
        ).rows[0];
        assert(h);
        const response = await call(
          '/replenishment/' + (kind === 'preview' ? 'previews/' : 'executions/') + id,
          cookie,
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as Json;
        assert.deepEqual(body[kind].groups, h.groups);
        assert.deepEqual(
          Object.fromEntries(
            ['total', 'purchase', 'unchanged', 'invalid', 'conflicts'].map((key) => [
              key,
              body[kind][key],
            ]),
          ),
          h.summary,
        );
        assert.equal(body[kind].scope_hash, h.scope_hash);
        readbacks.push({ kind, id, full_groups_summary_scope_exact: true });
      }
    }
  }
  const rejected: Json[] = [];
  for (const [method, path] of [
    ['POST', '/replenishment/automations/rules'],
    ['PATCH', '/replenishment/automations/rules/' + rules[0].id],
    ['POST', '/replenishment/automations/runs/' + runs[0].id + '/cancel'],
  ]) {
    const response = await call(path, cookie, method, '{');
    assert.equal(response.status, 423);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    rejected.push({ method, path, status: 423 });
  }
  const after = await tableFingerprints(copied);
  for (const name of Object.keys(before))
    if (name !== 'sessions')
      assert.deepEqual(after[name], before[name], 'Copy HTTP mutated ' + name);
  const sessionsAfter = (
    await copied.query('SELECT to_jsonb(t) row FROM sessions t ORDER BY token_hash')
  ).rows;
  assert.equal(
    sessionsAfter.length,
    sessionsBefore.length + 1,
    'Exactly one own copy login session',
  );
  const oldSessionKeys = new Set(sessionsBefore.map((x) => x.row.token_hash));
  assert(
    hash(sessionsAfter.filter((x) => oldSessionKeys.has(x.row.token_hash))) ===
      hash(sessionsBefore),
    'Existing sessions remain exact',
  );
  const freshSession = sessionsAfter.find((x) => !oldSessionKeys.has(x.row.token_hash))?.row;
  assert(
    freshSession && freshSession.user_id === s.user && freshSession.tenant_id === s.tenant,
    'New session belongs only to own copied administrator',
  );
  assert.equal(
    (
      await fetch('http://127.0.0.1:4100/api/replenishment/automations/options', {
        headers: { cookie },
        signal: AbortSignal.timeout(10000),
      })
    ).status,
    401,
  );
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
    automation_tables_force_rls: true,
    app_direct_run_insert_denied: true,
    stock_capture_trigger_enabled: true,
    readbacks,
    malformed_writes: rejected,
    copy_business_tables_unchanged: true,
    preexisting_sessions_exact: true,
    own_copy_login_sessions_added: 1,
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
    'docs/replenishment-automations-recovery-qa.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile('data/replenishment-automations-recovery-copy-log.txt', copyLog, { mode: 0o600 });
  console.log(
    JSON.stringify({ status: report.status, phase, copy_removed: report.owned_copy_removed }),
  );
}
