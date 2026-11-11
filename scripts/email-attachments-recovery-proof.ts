import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const f = JSON.parse(await readFile('data/email-stage084.json', 'utf8')),
    health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(health.schema_revision, '063_email_attachments');
  process.env.APP_REVISION = health.revision;
  const tables = [
    'channels',
    'orders',
    'order_items',
    'products',
    'stock',
    'documents',
    'shipments',
    'email_templates',
    'email_batches',
    'email_messages',
    'email_message_files',
    'invoice_email_files',
    'odoo_invoice_exports',
    'odoo_invoice_files',
    'automation_rules',
    'automation_runs',
    'jobs',
  ];
  const before: any = {};
  for (const t of tables)
    before[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
        f.tenant,
      ])
    ).rows;
  assert.equal(before.email_message_files.length, 3);
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/email-084-restore' });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const config = JSON.parse(await readFile(restored.config, 'utf8')),
    c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let count = 0;
  try {
    for (const t of tables)
      assert.deepEqual(
        (
          await c.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [
            f.tenant,
          ])
        ).rows,
        before[t],
        t,
      );
    for (const file of before.email_message_files.map((r: any) => r.row)) {
      const bytes = Buffer.from(
        decrypt(file.content_encrypted, config.encryptionKey).file_base64,
        'base64',
      );
      assert.equal(bytes.length, file.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      count++;
    }
    for (const t of ['email_message_files', 'invoice_email_files']) {
      const meta = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [t],
        )
      ).rows[0];
      assert(meta.relrowsecurity && meta.relforcerowsecurity);
      for (const grant of ['UPDATE', 'DELETE'])
        assert.equal(
          (await c.query("SELECT has_table_privilege('dyna_app',$1,$2) allowed", [t, grant]))
            .rows[0].allowed,
          false,
        );
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id<>$1`, [f.tenant])).rows[0]
          .n,
        0,
      );
      await c.query('ROLLBACK');
    }
  } finally {
    await c.end();
  }
  let occupied = false;
  try {
    await fetch('http://127.0.0.1:4102/api/health');
    occupied = true;
  } catch {}
  assert(!occupied);
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
        const h = (await r.json()) as any;
        assert(h.restore_preview && h.email_attachments_available);
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(200);
  }
  assert(ready);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: f.email, password: f.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(cookie.startsWith('dyna_session_preview_4102='));
  for (const file of before.email_message_files.map((r: any) => r.row)) {
    const r = await fetch(base + '/email/messages/' + file.message_id + '/attachment', {
      headers: { cookie },
    });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert(r.headers.get('content-disposition')?.startsWith('attachment;'));
  }
  for (const path of [
    '/documents/' + f.document + '/email-file',
    '/email/templates',
    '/email/preview',
    '/email/batches/' + before.email_batches[0].row.id + '/queue',
  ])
    assert.equal(
      (
        await fetch(base + path, {
          method: 'POST',
          headers: { cookie, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      423,
    );
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/auth/me', { headers: { cookie } })).status,
    401,
  );
  for (const t of tables)
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
    stage: 84,
    at: new Date().toISOString(),
    revision: health.revision,
    schema: health.schema_revision,
    backup: backup.file,
    tables: restored.tables,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    own_tables_exact: tables.length,
    decrypted_email_files: count,
    binary_attachment_GET_200: 3,
    mutations_POST_423: 4,
    preview_cookie_live_401: true,
    force_RLS_preserved: true,
    UPDATE_DELETE_denied: true,
    worker_enabled: false,
    owned_restore_removed_in_finally: true,
  };
  await writeFile('data/email-attachments-recovery-qa.json', JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((r) => child!.once('exit', () => r()));
    child.kill('SIGTERM');
    await exited;
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
