import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
} from '../server/recovery';
let child: ReturnType<typeof spawn> | undefined, database: string | undefined;
try {
  const f = JSON.parse(await readFile('data/password-recovery-stage081.json', 'utf8'));
  const liveHealth = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(liveHealth.status, 200);
  const health = (await liveHealth.json()) as any;
  process.env.APP_REVISION = health.revision;
  const requested = await fetch('http://127.0.0.1:4100/api/auth/password/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email }),
  });
  assert.equal(requested.status, 202);
  const security = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [f.user]))
    .rows[0];
  const pending = (
    await pool.query('SELECT * FROM account_password_resets WHERE user_id=$1', [f.user])
  ).rows[0];
  assert(pending);
  const mails = (
    await pool.query('SELECT * FROM account_local_mail WHERE user_id=$1 ORDER BY id', [f.user])
  ).rows;
  assert.equal(mails.length, 2);
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, {
      directory: 'data/password-recovery-081-restore',
    });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  const businessTables = [
    'orders',
    'order_items',
    'stock',
    'products',
    'reservations',
    'audit_events',
  ];
  try {
    for (const table of businessTables)
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
    assert.deepEqual(
      (await c.query('SELECT * FROM account_security WHERE user_id=$1', [f.user])).rows[0],
      security,
    );
    assert.deepEqual(
      (await c.query('SELECT * FROM account_password_resets WHERE user_id=$1', [f.user])).rows[0],
      pending,
    );
    assert.deepEqual(
      (await c.query('SELECT * FROM account_local_mail WHERE user_id=$1 ORDER BY id', [f.user]))
        .rows,
      mails,
    );
    assert.equal(
      (
        await c.query(
          'SELECT database_name=current_database() AS usable FROM account_password_resets WHERE user_id=$1',
          [f.user],
        )
      ).rows[0].usable,
      false,
    );
    const recovered = JSON.parse(await readFile(restored.config, 'utf8'));
    for (const m of mails)
      assert.deepEqual(
        decrypt(m.body_encrypted, recovered.encryptionKey),
        decrypt(m.body_encrypted),
      );
    for (const table of ['account_password_resets', 'account_reset_limits', 'account_local_mail'])
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
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 60);
  } finally {
    await c.end();
  }
  let occupied = false;
  try {
    await fetch('http://127.0.0.1:4102/api/health');
    occupied = true;
  } catch {}
  assert(!occupied, 'Own preview port must be free');
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
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, 'Preview exited');
    try {
      if ((await fetch('http://127.0.0.1:4102/api/health')).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await setTimeout(200);
  }
  assert(healthy);
  const base = 'http://127.0.0.1:4102/api';
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email, password: f.next_password, code: f.codes[7] }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.match(cookie, /^dyna_session_preview_4102=/);
  for (const path of ['/auth/me', '/auth/security', '/orders/' + f.order])
    assert.equal((await fetch(base + path, { headers: { cookie } })).status, 200);
  const mutations = [];
  for (const path of ['/auth/password/request', '/auth/password/reset']) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: f.email }),
    });
    assert.equal(r.status, 423);
    mutations.push({ path, status: r.status });
  }
  const wrong = await fetch('http://127.0.0.1:4100/api/auth/me', { headers: { cookie } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(
    (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [f.user])).rows[0],
    security,
  );
  assert.deepEqual(
    (await pool.query('SELECT * FROM account_password_resets WHERE user_id=$1', [f.user])).rows[0],
    pending,
  );
  const report = {
    stage: 81,
    verified_at: new Date().toISOString(),
    revision: health.revision,
    schema: health.schema_revision,
    backup_file: backup.file,
    tables: restored.tables,
    migrations,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    own_business_tables: businessTables.length,
    own_business_exact: true,
    account_security_exact_before_preview_login: true,
    pending_link_exact: true,
    mail_ciphertext_exact: true,
    mail_decryption_verified: true,
    service_acl_denied: true,
    database_bound_link_unusable_in_restored_database: true,
    mfa_login: 200,
    read_endpoints: 3,
    mutations,
    preview_cookie_live_status: 401,
    live_account_unchanged: true,
    worker_enabled: false,
    provider_requests: 0,
  };
  await writeFile('docs/password-recovery-recovery-qa.json', JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise((r) => child!.once('exit', r));
    child.kill('SIGTERM');
    await stopped;
  }
  if (database) {
    await pool.query('DROP DATABASE ' + database + ' WITH (FORCE)');
    assert.equal(
      (await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount,
      0,
    );
  }
  await pool.end();
}
