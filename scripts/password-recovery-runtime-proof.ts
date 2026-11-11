import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { checkPassword, decrypt } from '../server/security';
try {
  const f = JSON.parse(await readFile('data/password-recovery-stage081.json', 'utf8'));
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '060_password_recovery');
  assert(health.password_recovery_available);
  const user = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [f.user])).rows[0];
  assert(checkPassword(f.next_password, user.password_hash));
  const security = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [f.user]))
    .rows[0];
  assert(security.enabled_at);
  assert.equal(security.secret_encrypted, f.mfa_before.secret_encrypted);
  assert.equal(security.recovery_hashes.length, 5);
  const stock = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      f.tenant,
      f.product,
    ])
  ).rows[0];
  assert.deepEqual(stock, { on_hand: 10, reserved: 2 });
  const checkedLogs = [
    ...new Set(['data/dev-stage081.log', process.argv[2] ?? 'data/dev-stage081.log']),
  ];
  const log = (await Promise.all(checkedLogs.map((path) => readFile(path, 'utf8')))).join('\n');
  const secrets = [f.password, f.next_password, f.secret, f.token, ...f.codes];
  for (const row of (
    await pool.query('SELECT body_encrypted FROM account_local_mail WHERE user_id=$1', [f.user])
  ).rows) {
    const body = decrypt(row.body_encrypted);
    if (body.url) secrets.push(body.url.split('#password-reset=')[1]);
  }
  for (const value of secrets) assert(!log.includes(value), 'Authentication secret was logged');
  const cli = await readFile('data/password-recovery-cli081.txt', 'utf8');
  assert(cli.includes('local_mailbox'));
  assert(cli.includes(f.reset_url));
  assert.equal((await stat('data/password-recovery-cli081.txt')).mode & 0o777, 0o600);
  let restoredDatabases = 0;
  for (const entry of await readdir('data/password-recovery-081-restore')) {
    const result = JSON.parse(
      await readFile('data/password-recovery-081-restore/' + entry + '/result.json', 'utf8'),
    );
    assert.equal(
      (await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [result.database])).rowCount,
      0,
    );
    restoredDatabases++;
  }
  assert(restoredDatabases > 0);
  const report = {
    stage: 81,
    verified_at: new Date().toISOString(),
    revision,
    schema: health.schema_revision,
    stock,
    mfa_enabled: true,
    new_password_verified: true,
    plaintext_credentials_absent_from_checked_runtime_log: true,
    checked_logs: checkedLogs,
    local_mail_cli_verified: true,
    private_cli_output_mode: '0600',
    own_restore_databases_removed: restoredDatabases,
  };
  await writeFile('data/password-recovery-runtime081.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(report);
} finally {
  await pool.end();
}
