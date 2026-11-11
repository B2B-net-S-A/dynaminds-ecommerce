/** QA115 actual encrypted backup and owned isolated restore; no provider calls. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  localDatabase,
  restoreDatabaseName,
  tableFingerprints,
} from '../server/recovery';
type Json = Record<string, any>;
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const source = localDatabase(),
  port = 4155;
const admin = new pg.Client({ ...source, database: 'postgres' });
let child: ReturnType<typeof spawn> | undefined,
  owned: string | undefined,
  copied: pg.Client | undefined;
let prior: string[] = [];
const sha = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let stage = 'prerequisites',
  report: Json | undefined;
try {
  await admin.connect();
  prior = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
    (r) => r.datname,
  );
  const s: Json = JSON.parse(await readFile('data/catalog-export-profiles-stage115.json', 'utf8'));
  assert(s.setup_complete && !s.pending && s.accepted_checkpoint);
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as Json;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '096_catalog_export_profiles');
  const probe = createServer();
  await new Promise<void>((done, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => done());
  });
  await new Promise<void>((done) => probe.close(() => done()));
  process.env.APP_REVISION = revision;
  stage = 'encrypted_backup';
  const backup = await createBackup();
  stage = 'isolated_restore';
  const restored = await restoreBackup(backup.file, {
    directory: 'data/catalog-export-profiles-115-restore',
  });
  const name = restoreDatabaseName(restored.database);
  assert(!prior.includes(name));
  owned = name;
  assert.equal(restored.status, 'verified');
  assert.equal(restored.revision, revision);
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      restored.preview_only &&
      restored.worker_enabled === false,
  );
  const config: Json = JSON.parse(await readFile(restored.config, 'utf8'));
  copied = new pg.Client({ ...source, database: name, password: config.dbPassword });
  await copied.connect();
  const profiles = (
    await copied.query(
      'SELECT to_jsonb(p) row FROM catalog_export_profiles p WHERE tenant_id=$1 ORDER BY id',
      [s.tenant],
    )
  ).rows;
  assert.equal(profiles.length, 3);
  assert.equal(
    createHash('sha256').update(JSON.stringify(profiles)).digest('hex'),
    s.accepted_checkpoint.profiles_sha256,
  );
  const rls = (
    await copied.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='catalog_export_profiles'::regclass",
    )
  ).rows[0];
  assert(rls.relrowsecurity && rls.relforcerowsecurity);
  const foreign = (await copied.query('SELECT id FROM tenants WHERE id<>$1 LIMIT 1', [s.tenant]))
    .rows[0];
  assert(foreign);
  await copied.query('BEGIN');
  await copied.query('SET LOCAL ROLE dyna_app');
  await copied.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
  assert.equal(
    (await copied.query('SELECT count(*)::int n FROM catalog_export_profiles')).rows[0].n,
    3,
  );
  // The low-level reader sees only its selected tenant under FORCE RLS.
  await copied.query("SELECT set_config('app.tenant_id',$1,true)", [foreign.id]);
  assert.equal(
    (await copied.query('SELECT count(*)::int n FROM catalog_export_profiles')).rows[0].n,
    0,
  );
  assert.equal(
    (
      await copied.query('SELECT count(*)::int n FROM catalog_export_profiles WHERE tenant_id=$1', [
        s.tenant,
      ])
    ).rows[0].n,
    0,
  );
  await copied.query('ROLLBACK');
  const before = await tableFingerprints(copied);
  stage = 'readonly_loopback';
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      resolve(restored.directory, 'result.json'),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DYNA_PREVIEW_PORT: String(port) },
      stdio: 'ignore',
    },
  );
  const base = `http://127.0.0.1:${port}/api`;
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const h = (await r.json()) as Json;
        assert(h.restore_preview);
        assert.equal(h.schema_revision, '096_catalog_export_profiles');
        assert.equal(h.revision, revision);
        ready = true;
        break;
      }
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
    assert(child.exitCode === null && child.signalCode === null, 'Owned preview exited');
    await delay(150);
  }
  assert(ready, 'Owned preview did not become ready');
  assert.equal(
    (await fetch(base + '/catalog/export-profiles', { headers: { cookie: s.cookie } })).status,
    401,
    'Original source cookie is not the preview cookie',
  );
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: s.email, password: s.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'X-Workspace-ID': s.tenant };
  const listResponse = await fetch(base + '/catalog/export-profiles', { headers });
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()) as Json;
  assert(list.available && list.read_only && !list.can_manage && list.data.length === 3);
  for (const p of list.data) {
    const detail = await fetch(base + '/catalog/export-profiles/' + p.id, { headers });
    assert.equal(detail.status, 200);
    assert.deepEqual(((await detail.json()) as Json).profile, p);
  }
  const files = [];
  for (const format of ['csv', 'xml']) {
    const saved = s.profiles.find((p: Json) => p.profile.definition.format === format);
    const p = list.data.find((p: Json) => p.id === saved.profile.id);
    assert(p);
    const r = await fetch(base + '/catalog/exports/file', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...p.definition, selection: 'selected', ids: [s.product.id] }),
    });
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer()),
      native = await readFile(`docs/catalog-export-profiles-native-custom.${format}`);
    assert.deepEqual(bytes, native);
    files.push({ format, bytes: bytes.length, sha256: sha(bytes) });
  }
  let denied = 0;
  for (const [method, path] of [
    ['POST', '/catalog/export-profiles'],
    ['PATCH', '/catalog/export-profiles/' + list.data[0].id],
    ['POST', '/catalog/export-profiles/' + list.data[0].id + '/archive'],
    ['POST', '/catalog/export-profiles/' + list.data[0].id + '/restore'],
  ]) {
    const r = await fetch(base + path, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(r.status, 423);
    denied++;
  }
  const after = await tableFingerprints(copied);
  for (const [table, fingerprint] of Object.entries(before))
    if (table !== 'sessions')
      assert.deepEqual(after[table], fingerprint, 'Readonly copy changed: ' + table);
  report = {
    status: 'PASS',
    runtime_revision: revision,
    schema_revision: '096_catalog_export_profiles',
    tables: restored.tables,
    row_manifest_exact_before_preview: true,
    schema_fingerprint_exact: true,
    encrypted_records_verified: restored.encrypted_records_verified,
    profiles_exact: 3,
    force_rls: true,
    rls_scope_checks: 3,
    profile_gets: 4,
    export_files: files,
    writes_denied_before_parse: denied,
    non_session_tables_exact_after_preview: true,
    source_cookie_denied: true,
    preview_only: true,
    worker_enabled: false,
    provider_operations: false,
    full_goal_complete: false,
  };
} catch (e) {
  await writeFile(
    'docs/catalog-export-profiles-recovery-failed-qa.json',
    JSON.stringify(
      {
        status: 'FAIL',
        stage,
        error: e instanceof Error ? e.message : 'Unknown failure',
        full_goal_complete: false,
      },
      null,
      2,
    ),
  );
  throw e;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let n = 0; n < 30 && child.exitCode === null && child.signalCode === null; n++)
      await delay(100);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((done) => child!.once('exit', () => done()));
    }
  }
  await copied?.end().catch(() => {});
  if (owned) {
    assert(!prior.includes(owned));
    await admin.query('DROP DATABASE ' + restoreDatabaseName(owned) + ' WITH (FORCE)');
  }
  if (prior.length)
    assert.deepEqual(
      (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
        (r) => r.datname,
      ),
      prior,
      'Owned restore cleanup must conserve all earlier databases',
    );
  await admin.end();
  await pool.end();
}
assert(report);
report.owned_preview_and_database_removed = true;
await writeFile('docs/catalog-export-profiles-recovery-qa.json', JSON.stringify(report, null, 2));
process.stdout.write(
  JSON.stringify({ status: 'PASS', tables: report.tables, profiles: 3, files: 2, denied: 4 }) +
    '\n',
);
