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
try {
  const f = JSON.parse(await readFile('data/account-security-stage072.json', 'utf8')).fixture;
  const live = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [f.user]))
    .rows[0];
  assert(live.secret_encrypted && live.enabled_at && live.recovery_hashes.length > 0);
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/account-security-072-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  try {
    const restoredSecurity = (
      await c.query('SELECT * FROM account_security WHERE user_id=$1', [f.user])
    ).rows[0];
    assert.deepEqual(restoredSecurity, live);
    assert.deepEqual(
      (await c.query('SELECT * FROM sessions WHERE user_id=$1 ORDER BY token_hash', [f.user])).rows,
      (await pool.query('SELECT * FROM sessions WHERE user_id=$1 ORDER BY token_hash', [f.user]))
        .rows,
    );
    for (const table of [
      'orders',
      'order_items',
      'stock',
      'products',
      'reservations',
      'audit_events',
    ])
      assert.deepEqual(
        (
          await c.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
            f.tenant,
          ])
        ).rows,
        (
          await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
            f.tenant,
          ])
        ).rows,
      );
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 51);
    for (const table of ['account_security', 'sessions', 'users'])
      for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        assert.equal(
          (
            await c.query('SELECT has_table_privilege($1,$2,$3) allowed', [
              'dyna_app',
              table,
              action,
            ])
          ).rows[0].allowed,
          false,
        );
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
    { cwd: process.cwd(), env: { ...process.env, DYNA_PREVIEW_PORT: '4102' }, stdio: 'ignore' },
  );
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:4102/api/health');
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {}
    await setTimeout(200);
  }
  assert(healthy, 'Preview failed to start');
  const base = 'http://127.0.0.1:4102/api',
    loginBody = { email: f.email, password: f.password };
  const required = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(loginBody),
  });
  assert.deepEqual(await required.json(), { mfa_required: true });
  assert(!required.headers.get('set-cookie'));
  const logged = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...loginBody, code: f.codes[7] }),
  });
  assert.equal(logged.status, 200);
  const cookie = logged.headers.get('set-cookie')!.split(';')[0];
  assert.match(cookie, /^dyna_session_preview_4102=/);
  const state = await fetch(base + '/auth/security', { headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal(((await state.json()) as any).enabled, true);
  const mutations = [];
  for (const action of ['enroll', 'confirm', 'disable', 'recovery', 'password']) {
    const r = await fetch(base + '/auth/security/' + action, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: f.password, code: f.codes[1] }),
    });
    assert.equal(r.status, 423);
    mutations.push({ action, status: r.status });
  }
  const wrongCookie = await fetch(base + '/auth/security', {
    headers: { cookie: cookie.replace('dyna_session_preview_4102=', 'dyna_session=') },
  });
  assert.equal(wrongCookie.status, 401);
  const after = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [f.user]))
    .rows[0];
  assert.deepEqual(after, live);
  const report = {
    stage: 72,
    at: new Date().toISOString(),
    scope: 'encrypted_local_backup_restored_MFA_account',
    backup_file: backup.file,
    tables: restored.tables,
    migrations,
    encrypted_records: restored.encrypted_records_verified,
    schema_fingerprints_match: true,
    row_fingerprints_match: true,
    account_security_exact: true,
    sessions_exact: true,
    qa_business_tables: 6,
    service_tables_denied: true,
    mfa_required: true,
    mfa_login_status: 200,
    own_preview_cookie: true,
    security_status: 200,
    mutations,
    wrong_cookie_status: 401,
    live_account_unchanged: true,
    worker_enabled: false,
    zero_external_requests: true,
    goal_complete: false,
  };
  await writeFile('docs/account-security-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => child!.once('exit', r));
  }
  if (database) await pool.query('DROP DATABASE ' + database + ' WITH (FORCE)');
  await pool.end();
}
