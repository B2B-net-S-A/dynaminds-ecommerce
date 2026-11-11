// Actual pre-MFA backup: verify current preview code can still authenticate and rotate its old-schema sessions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { restoreBackup, restoreDatabaseName } from '../server/recovery';
let database: string | undefined, child: ReturnType<typeof spawn> | undefined;
try {
  const restored = await restoreBackup('data/backups/muu8fix3-b5ba3126d4d6491e.dyna', {
    directory: 'data/account-security-legacy072-restore',
  });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  const manifest = JSON.parse(await readFile(restored.directory + '/manifest.json', 'utf8'));
  assert.equal(manifest.schema_fingerprint_version, 2);
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      restored.directory + '/result.json',
    ],
    { cwd: process.cwd(), env: { ...process.env, DYNA_PREVIEW_PORT: '4103' }, stdio: 'ignore' },
  );
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:4103/api/health')).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await setTimeout(200);
  }
  assert(healthy);
  const base = 'http://127.0.0.1:4103/api';
  const r = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.local', password: 'DynaDemo!2026' }),
  });
  assert.equal(r.status, 200);
  const user = ((await r.json()) as any).user;
  assert(user);
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const switched = await fetch(base + '/workspaces/switch', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: user.tenant_id }),
  });
  assert.equal(switched.status, 200);
  const next = switched.headers.get('set-cookie')!.split(';')[0];
  assert.notEqual(cookie, next);
  assert.equal((await fetch(base + '/auth/me', { headers: { cookie } })).status, 401);
  assert.equal((await fetch(base + '/auth/me', { headers: { cookie: next } })).status, 200);
  const health = await (await fetch(base + '/health')).json();
  const report = {
    stage: 72,
    at: new Date().toISOString(),
    scope: 'actual_legacy_pre_MFA_backup_current_preview_auth',
    tables: restored.tables,
    legacy_fingerprint_version: 2,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    login_status: 200,
    workspace_rotation_status: 200,
    old_cookie_status: 401,
    new_cookie_status: 200,
    health,
    worker_enabled: false,
    provider_requests: 0,
    goal_complete: false,
  };
  await writeFile('docs/account-security-legacy-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((r) => child!.once('exit', r));
  }
  if (database) await pool.query('DROP DATABASE ' + database + ' WITH (FORCE)');
  await pool.end();
}
