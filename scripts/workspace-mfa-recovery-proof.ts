import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
} from '../server/recovery';
let child: ReturnType<typeof spawn> | undefined, database: string | undefined;
let receipt: Record<string, unknown> | undefined;
try {
  const f = JSON.parse(await readFile('data/workspace-mfa-stage078.json', 'utf8'));
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  assert.equal(health.schema_revision, '057_workspace_mfa');
  process.env.APP_REVISION = health.revision;
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/workspace-mfa-078-restore',
  });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  try {
    assert.equal((await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n, 57);
    for (const table of [
      'workspace_security_policies',
      'stock',
      'orders',
      'reservations',
      'sessions',
    ]) {
      const sql = `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`;
      assert.deepEqual(
        (await c.query(sql, [f.tenant])).rows,
        (await pool.query(sql, [f.tenant])).rows,
      );
    }
    const accountSql =
      'SELECT to_jsonb(a) row FROM account_security a WHERE user_id=ANY($1::uuid[]) ORDER BY 1';
    const users = [f.admin.user.id, f.member.user.id];
    assert.deepEqual(
      (await c.query(accountSql, [users])).rows,
      (await pool.query(accountSql, [users])).rows,
    );
    assert.equal(
      (
        await c.query(
          "SELECT has_table_privilege('dyna_app','workspace_security_policies','SELECT') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    const constraint = (
      await c.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='sessions_mfa_proof_expiry'",
      )
    ).rows[0].definition;
    assert.match(constraint, /mfa_verified_at.*expires_at/);
  } finally {
    await c.end();
  }
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      restored.directory + '/result.json',
    ],
    {
      env: { ...process.env, DYNA_PREVIEW_PORT: '4102' },
      stdio: 'ignore',
    },
  );
  let ready = false;
  for (let n = 0; n < 100; n++) {
    assert.equal(child.exitCode, null, 'Preview exited before readiness');
    try {
      if ((await fetch('http://127.0.0.1:4102/api/health')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(100);
  }
  assert(ready);
  let cookie = '';
  async function request(path: string, method = 'GET', payload?: unknown, status = 200) {
    const r = await fetch('http://127.0.0.1:4102/api' + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = (await r.json()) as any;
    assert.equal(r.status, status, path + ':' + JSON.stringify(body));
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
    return body;
  }
  const login = await request('/auth/login', 'POST', {
    email: f.admin.email,
    password: f.password,
    code: f.admin.codes[0],
  });
  assert.equal(login.user.mfa_required, false);
  assert.match(cookie, /^dyna_session_preview_4102=/);
  const p = await request('/workspaces/security');
  assert.equal(p.require_mfa, true);
  assert.equal(p.members.length, 2);
  assert(p.members.every((m: any) => m.mfa_enabled));
  await request('/products');
  await request('/orders');
  for (const [path, method, payload] of [
    [
      '/workspaces/security',
      'PATCH',
      { require_mfa: false, version: 1, password: f.password, code: f.admin.codes[1] },
    ],
    ['/auth/security/enroll', 'POST', { password: f.password }],
    ['/auth/security/verify', 'POST', { password: f.password, code: f.admin.codes[1] }],
  ] as const)
    await request(path, method, payload, 423);
  const live = await fetch('http://127.0.0.1:4100/api/workspaces/security', {
    headers: { cookie },
  });
  assert.equal(live.status, 401);
  // Change only the disposable copy's own QA proof to exercise the restricted preview session.
  const copy = new pg.Client({ ...localDatabase(), database });
  await copy.connect();
  try {
    await copy.query('UPDATE sessions SET mfa_verified_at=NULL WHERE user_id=$1', [
      f.admin.user.id,
    ]);
  } finally {
    await copy.end();
  }
  const gated = await request('/products', 'GET', undefined, 403);
  assert.equal(gated.code, 'MFA_REQUIRED');
  assert.equal((await request('/auth/me')).user.mfa_required, true);
  await request('/auth/security');
  await request('/workspaces');
  await request(
    '/auth/security/verify',
    'POST',
    { password: f.password, code: f.admin.codes[1] },
    423,
  );
  const manifest = JSON.parse(await readFile(restored.directory + '/manifest.json', 'utf8'));
  receipt = {
    checked_at: new Date().toISOString(),
    revision: health.revision,
    source_schema: health.schema_revision,
    table_count: Object.keys(manifest.tables).length,
    migrations: 57,
    encrypted_records_verified: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    worker_enabled: restored.worker_enabled,
    own_qa_tables_exact: 6,
    policy_tenant_sql_denied: true,
    proof_expiry_constraint_preserved: true,
    preview_mfa_login: 200,
    preview_policy_get: 200,
    preview_business_gets: 2,
    preview_mutations: 423,
    preview_unproven_gate: 403,
    preview_recovery_routes_accessible: true,
    preview_cookie_rejected_live: 401,
    provider_http: 0,
    temporary_database_cleanup: false,
  };
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((r) => child!.once('exit', () => r()));
  }
  if (database) {
    await pool.query(`DROP DATABASE ${database} WITH (FORCE)`);
    assert.equal(
      (await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount,
      0,
    );
    if (receipt) receipt.temporary_database_cleanup = true;
  }
  await pool.end();
}
if (receipt) {
  await writeFile('docs/workspace-mfa-recovery-qa.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    JSON.stringify({
      restored: true,
      tables: receipt.table_count,
      migrations: 57,
      cleaned: receipt.temporary_database_cleanup,
    }),
  );
}
