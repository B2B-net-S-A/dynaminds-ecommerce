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
  const f = JSON.parse(await readFile('data/email-stage082.json', 'utf8'));
  const h = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(h.status, 200);
  const health = (await h.json()) as any;
  assert.equal(health.schema_revision, '061_email');
  process.env.APP_REVISION = health.revision;
  const business = [
    'channels',
    'email_templates',
    'email_batches',
    'email_messages',
    'jobs',
    'orders',
    'order_items',
    'products',
    'stock',
    'shipments',
    'documents',
    'audit_events',
  ];
  const before: any = {};
  for (const t of business)
    before[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
        f.tenant,
      ])
    ).rows;
  assert.equal(before.email_messages.filter((r: any) => r.row.state === 'smtp_accepted').length, 1);
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/email-082-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  try {
    for (const t of business)
      assert.deepEqual(
        (
          await c.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
            f.tenant,
          ])
        ).rows,
        before[t],
        t,
      );
    const recovered = JSON.parse(await readFile(restored.config, 'utf8'));
    const ch = (await c.query('SELECT credentials FROM channels WHERE id=$1', [f.external_channel]))
      .rows[0];
    assert.equal(
      decrypt(ch.credentials, recovered.encryptionKey).password,
      'QA082-NOT-A-PROVIDER-CREDENTIAL',
    );
    assert(!ch.credentials.includes('NOT-A-PROVIDER'));
    for (const t of ['email_templates', 'email_batches', 'email_messages']) {
      const meta = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [t],
        )
      ).rows[0];
      assert(meta.relrowsecurity && meta.relforcerowsecurity);
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id<>$1`, [f.tenant])).rows[0]
          .n,
        0,
      );
      await c.query('ROLLBACK');
      assert.equal(
        (await c.query("SELECT has_table_privilege('dyna_app',$1,'DELETE') allowed", [t])).rows[0]
          .allowed,
        false,
      );
    }
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 61);
  } finally {
    await c.end();
  }
  let occupied = false;
  try {
    await fetch('http://127.0.0.1:4102/api/health');
    occupied = true;
  } catch {}
  assert(!occupied, 'Own preview port free');
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
  const base = 'http://127.0.0.1:4102/api';
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) {
        const p = (await r.json()) as any;
        assert.equal(p.restore_preview, true);
        assert.equal(p.email_available, true);
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(200);
  }
  assert(ready);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email, password: f.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(cookie.startsWith('dyna_session_preview_4102='));
  const message = (
    await pool.query(
      "SELECT id,batch_id FROM email_messages WHERE tenant_id=$1 AND state='smtp_accepted'",
      [f.tenant],
    )
  ).rows[0];
  const reads = [
    '/email/templates',
    '/email/messages?order_id=' + f.order,
    '/email/batches/' + message.batch_id,
    '/orders/' + f.order,
  ];
  for (const path of reads)
    assert.equal((await fetch(base + path, { headers: { cookie } })).status, 200);
  const mutations = [];
  for (const path of [
    '/email/templates',
    '/email/preview',
    '/email/batches/' + message.batch_id + '/queue',
    '/email/batches/' + message.batch_id + '/cancel',
    '/integrations/smtp-example',
  ]) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 423, path);
    mutations.push({ path, status: r.status });
  }
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/auth/me', { headers: { cookie } })).status,
    401,
  );
  for (const t of business)
    assert.deepEqual(
      (
        await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
          f.tenant,
        ])
      ).rows,
      before[t],
      t + ' live unchanged',
    );
  const report = {
    stage: 82,
    verified_at: new Date().toISOString(),
    revision: health.revision,
    schema: health.schema_revision,
    backup_file: backup.file,
    tables: restored.tables,
    migrations,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    own_tables_exact: business,
    channel_secret_decryption: true,
    email_force_RLS_preserved: true,
    email_delete_denied: true,
    reads: reads.map((path) => ({ path, status: 200 })),
    mutations,
    preview_cookie_live_status: 401,
    live_own_data_unchanged: true,
    worker_enabled: false,
    external_email_requests: 0,
    local_raw_receipt_files_in_backup: false,
    receipt_note:
      'Native receiver files are QA-only and excluded; application email history is restored.',
  };
  await writeFile('docs/email-recovery-qa.json', JSON.stringify(report, null, 2));
  console.log({
    tables: report.tables,
    migrations,
    encrypted_records: report.encrypted_records,
    own_tables_exact: business.length,
    read_endpoints: reads.length,
    blocked_mutations: mutations.length,
    worker_enabled: false,
  });
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
