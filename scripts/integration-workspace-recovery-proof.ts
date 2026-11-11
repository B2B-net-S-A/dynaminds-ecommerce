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
  const f = JSON.parse(await readFile('data/integration-workspace-stage077.json', 'utf8'));
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  assert.equal(health.schema_revision, '056_integration_workspace');
  process.env.APP_REVISION = health.revision;
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/integration-workspace-077-restore',
  });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let index: string;
  try {
    const migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 56);
    index = (
      await c.query(
        "SELECT indexdef FROM pg_indexes WHERE tablename='channels' AND indexname='channels_tenant_created_page'",
      )
    ).rows[0].indexdef;
    assert.match(index, /tenant_id, created_at DESC, id DESC/);
    for (const table of ['channels', 'integration_runs', 'workspace_usage']) {
      const query = `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`;
      assert.deepEqual(
        (await c.query(query, [f.tenant])).rows,
        (await pool.query(query, [f.tenant])).rows,
      );
    }
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
    { env: { ...process.env, DYNA_PREVIEW_PORT: '4102' }, stdio: 'ignore' },
  );
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch('http://127.0.0.1:4102/api/health')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(100);
  }
  assert(ready);
  const login = await fetch('http://127.0.0.1:4102/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email, password: f.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const read = async (path: string) => {
    const r = await fetch('http://127.0.0.1:4102/api' + path, { headers: { cookie } });
    assert.equal(r.status, 200);
    return (await r.json()) as any;
  };
  const workspace = await read('/integrations/workspace');
  assert.equal(workspace.summary.total, 31);
  const page1 = await read('/integrations/connections?limit=25');
  const page2 = await read('/integrations/connections?limit=25&after=' + page1.next);
  assert.deepEqual([page1.data.length, page2.data.length], [25, 6]);
  assert.equal(new Set([...page1.data, ...page2.data].map((ch: any) => ch.id)).size, 31);
  assert.equal((await read('/integrations/connections?status=attention')).total, 2);
  const blocked = await fetch('http://127.0.0.1:4102/api/integrations/amazon-example', {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(blocked.status, 423);
  const liveReject = await fetch('http://127.0.0.1:4100/api/integrations/workspace', {
    headers: { cookie },
  });
  assert.equal(liveReject.status, 401);
  const manifest = JSON.parse(await readFile(restored.directory + '/manifest.json', 'utf8'));
  receipt = {
    checked_at: new Date().toISOString(),
    revision: health.revision,
    source_schema: health.schema_revision,
    table_count: Object.keys(manifest.tables).length,
    migrations: 56,
    encrypted_records_verified: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    worker_enabled: restored.worker_enabled,
    own_qa_tables_exact: 3,
    restored_index: index,
    preview_workspace_get: 200,
    preview_page_sizes: [25, 6],
    preview_attention: 2,
    preview_mutation: blocked.status,
    preview_cookie_rejected_live: liveReject.status,
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
  await writeFile(
    'docs/integration-workspace-recovery-qa.json',
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      restored: true,
      tables: receipt.table_count,
      migrations: 56,
      pages: [25, 6],
      cleaned: receipt.temporary_database_cleanup,
    }),
  );
}
