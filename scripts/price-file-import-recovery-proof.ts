/** ROOT ONLY. Encrypted native recovery of accepted QA130, never a migration of the source.
 * QA_EXPECTED_REVISION=<feature SHA> DYNA_WORKER_DISABLED=true tsx this-file verify
 * Own restored DB + rollback-only SQL probes + isolated read-only HTTP preview. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
  tableFingerprints,
  schemaFingerprint,
} from '../server/recovery';
import { priceFileImportAvailable } from '../server/price-file-import';
type Row = Record<string, any>;
const schema = '113_price_file_imports',
  port = 4103,
  runId = randomUUID();
const reportPath = 'docs/price-file-import-recovery-qa.json';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let source: pg.Client | undefined, copy: pg.Client | undefined, child: ChildProcess | undefined;
let log: Awaited<ReturnType<typeof open>> | undefined, database: string | undefined;
let originalManifest: Awaited<ReturnType<typeof tableFingerprints>> | undefined;
let originalSchema: string | undefined, originalDatabases: string[] | undefined;
let report: Row | undefined,
  step = 'preflight';
const preserved = new Map<string, Buffer>();
async function file(path: string, privateFile = false) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink());
  assert(st.size <= 32 * 1024 * 1024);
  if (privateFile) assert.equal(st.mode & 0o777, 0o600);
  const b = await readFile(path);
  preserved.set(path, b);
  return b;
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Existing output refuses overwrite');
}
async function rr<T>(c: pg.Client, fn: () => Promise<T>) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    const r = await fn();
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function own(c: pg.Client, s: Row) {
  const names: string[] = (
    await c.query(
      "SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1",
    )
  ).rows.map((r) => r.table_name);
  assert.equal(names.length, 310);
  const result: Row = {};
  for (const name of names) {
    assert.match(name, /^[a-z_][a-z0-9_]*$/);
    const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
    const rows = (
      await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
        name === 'users' ? s.user : s.tenant,
      ])
    ).rows;
    result[name] = { count: rows.length, sha256: hash(rows) };
  }
  return result;
}
async function request(
  base: string,
  path: string,
  cookie = '',
  method = 'GET',
  raw?: string,
  tenant?: string,
) {
  assert(path.startsWith('/') && !path.startsWith('//'));
  return fetch(base + '/api' + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(tenant ? { 'X-Workspace-ID': tenant } : {}),
      ...(raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(raw !== undefined ? { body: raw } : {}),
  });
}
async function health(base: string, preview: boolean) {
  const r = await request(base, '/health');
  assert.equal(r.status, 200);
  const h: Row = await r.json();
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.restore_preview, preview);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.price_file_import_available, true);
}
async function get(s: Row, path: string, cookie: string) {
  const r = await request(`http://127.0.0.1:${port}`, path, cookie, 'GET', undefined, s.tenant);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const text = await r.text();
  assert(Buffer.byteLength(text) <= 8 * 1024 * 1024);
  const b: Row = JSON.parse(text);
  assert.equal(b.read_only, true);
  assert.equal(b.can_write, false);
  return b;
}
async function rollback(c: pg.Client, fn: () => Promise<void>) {
  await c.query('BEGIN');
  try {
    await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}
async function refused(c: pg.Client, sql: string, values: unknown[], code: string) {
  let error: unknown;
  try {
    await c.query(sql, values);
  } catch (e) {
    error = e;
  }
  assert(error);
  assert.equal((error as { code?: string }).code, code);
}
async function guards(c: pg.Client, s: Row, cp: Row) {
  assert.equal(await priceFileImportAvailable(c as unknown as pg.PoolClient), true);
  const foreign = (
    await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [s.tenant])
  ).rows[0].id;
  await rollback(c, async () => {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [foreign]);
    for (const t of ['price_file_import_previews', 'price_file_import_executions'])
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [s.tenant])).rows[0]
          .n,
        0,
      );
  });
  await rollback(c, async () => {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM price_file_import_previews')).rows[0].n,
      2,
    );
    await refused(c, 'SELECT * FROM price_file_import_core_witnesses', [], '42501');
  });
  for (const t of ['price_file_import_previews', 'price_file_import_executions'])
    await rollback(c, () =>
      refused(
        c,
        `UPDATE ${t} SET created_at=created_at WHERE id=$1`,
        [cp.evidence[t === 'price_file_import_previews' ? 'previews' : 'executions'][0].id],
        '23514',
      ),
    );
  for (const t of [
    'price_file_import_previews',
    'price_file_import_executions',
    'price_file_import_profiles',
    'price_file_import_profile_revisions',
    'price_file_import_core_witnesses',
  ]) {
    const r = (
      await c.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [t],
      )
    ).rows[0];
    assert(r.relrowsecurity && r.relforcerowsecurity);
    assert.equal(
      (
        await c.query("SELECT has_table_privilege('dyna_app',$1,'INSERT,UPDATE,DELETE') allowed", [
          t,
        ])
      ).rows[0].allowed,
      false,
    );
  }
  return {
    availability_guard_set: true,
    force_rls_tables: 5,
    foreign_scope_tables: 2,
    private_witness_denied: true,
    immutable_receipts: 2,
    app_direct_writes_denied_tables: 5,
  };
}
async function api(s: Row, cp: Row, cookie: string) {
  const p = '/price-file-imports';
  const options = await get(s, p + '/options', cookie);
  assert.equal(options.available, true);
  const profiles = await get(s, p + '/profiles', cookie);
  assert.equal(profiles.meta.total, 0);
  let pagesCount = 0,
    fullRows = 0;
  for (const kind of ['previews', 'executions'] as const) {
    const history = await get(s, p + '/' + kind, cookie);
    assert.equal(history.meta.total, 2);
    assert.equal(history.meta.cursor, null);
    const original = cp.evidence[kind];
    assert.deepEqual(
      history.data.map((r: Row) => r.id).sort(),
      original.map((r: Row) => r.id).sort(),
    );
    for (const record of original) {
      const preview: Row =
        kind === 'previews'
          ? record
          : cp.evidence.previews.find((r: Row) => r.id === record.preview_id);
      const detail = await get(s, p + '/' + kind + '/' + record.id, cookie),
        head = detail[kind === 'previews' ? 'preview' : 'execution'];
      assert.equal(head.can_execute, false);
      assert.equal(head.scope_hash, preview.scope_hash);
      assert.equal(head.source_hash, preview.source_hash);
      assert.deepEqual(head.summary, preview.summary);
      assert.deepEqual(head.definition, preview.definition);
      const found: Row[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const part = await get(
          s,
          p +
            '/' +
            kind +
            '/' +
            record.id +
            '/rows' +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
          cookie,
        );
        assert.equal(part.meta.total, preview.rows.length);
        assert(part.data.length <= 50);
        found.push(...part.data);
        cursor = part.meta.cursor;
        if (cursor) {
          assert(!seen.has(cursor));
          seen.add(cursor);
        }
        pagesCount++;
      } while (cursor);
      assert.deepEqual(found, preview.rows);
      fullRows += found.length;
    }
  }
  const id = cp.evidence.previews[0].id;
  for (const [method, path] of [
    ['POST', p + '/previews'],
    ['POST', p + '/previews/' + id + '/execute'],
    ['POST', p + '/profiles'],
    ['PATCH', p + '/profiles/' + randomUUID()],
  ] as const) {
    const r = await request(
      `http://127.0.0.1:${port}`,
      path,
      cookie,
      method,
      '{"malformed":',
      s.tenant,
    );
    assert.equal(r.status, 423);
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  }
  return {
    history_heads: 4,
    full_row_reads: fullRows,
    row_pages: pagesCount,
    readonly_malformed_writes: 4,
    no_store_verified: true,
    profiles_empty_verified: true,
  };
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', ok);
  });
  await new Promise<void>((ok, bad) => server.close((e) => (e ? bad(e) : ok())));
}
async function stopChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((ok) => child!.once('exit', () => ok()));
  child.kill('SIGTERM');
  if (!(await Promise.race([closed.then(() => true), delay(10000).then(() => false)]))) {
    child.kill('SIGKILL');
    await closed;
  }
}
try {
  assert.equal(process.argv[2], 'verify');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{40}$/);
  await absent(reportPath);
  const local = localDatabase();
  assert.equal(local.database, 'dynaminds');
  const s: Row = JSON.parse((await file('data/price-file-import-stage130.json', true)).toString());
  const cp: Row = JSON.parse(
    (await file('data/price-file-import-stage130-chrome-checkpoint.json', true)).toString(),
  );
  assert(s.setup_complete && s.pending === null && s.products.length === 53);
  assert.equal(cp.stage, 130);
  assert.equal(cp.status, 'PASS');
  assert.equal(cp.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(cp.schema_revision, schema);
  for (const path of [
    'docs/price-file-import-native-chrome-qa.json',
    'docs/price-file-import-native-restart-qa.json',
  ]) {
    const accepted: Row = JSON.parse((await file(path)).toString());
    assert.equal(accepted.status, 'PASS');
    assert.equal(accepted.revision, cp.revision);
    assert.equal(accepted.all_own_baseline_tables_verified, true);
    assert.equal(
      accepted.checkpoint_sha256,
      bytesHash(preserved.get('data/price-file-import-stage130-chrome-checkpoint.json')!),
    );
    if (path.includes('restart')) assert.equal(accepted.restart_verified, true);
  }
  assert.equal(cp.setup_sha256, bytesHash(preserved.get('data/price-file-import-stage130.json')!));
  await health('http://127.0.0.1:4100', false);
  process.env.APP_REVISION = cp.revision;
  originalDatabases = (
    await pool.query('SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname')
  ).rows.map((r) => r.datname);
  source = new pg.Client(local);
  await source.connect();
  const before = await rr(source, async () => ({
    own: await own(source!, s),
    manifest: await tableFingerprints(source!),
    schema: await schemaFingerprint(source!),
  }));
  assert.deepEqual(before.own, cp.snapshot);
  originalManifest = before.manifest;
  originalSchema = before.schema;
  step = 'encrypted-backup-and-restore';
  const backup = await createBackup({ directory: resolve('data', 'qa130-backups', runId) });
  const restored = await restoreBackup(backup.file, {
    directory: resolve('data', 'qa130-restores', runId),
  });
  database = restoreDatabaseName(restored.database);
  assert(!originalDatabases.includes(database));
  assert.equal(restored.source, 'dynaminds');
  assert.equal(restored.revision, cp.revision);
  assert.equal(restored.status, 'verified');
  assert(
    restored.preview_only &&
      restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      restored.worker_enabled === false,
  );
  copy = new pg.Client({ ...local, database });
  await copy.connect();
  step = 'copied-full-fingerprints';
  const recovered = await rr(copy, async () => ({
    own: await own(copy!, s),
    manifest: await tableFingerprints(copy!),
    schema: await schemaFingerprint(copy!),
  }));
  assert.deepEqual(recovered, before);
  assert.equal(
    (await copy.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
    schema,
  );
  const originalSessions = (
    await copy.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY token_hash')
  ).rows;
  step = 'copied-guards';
  const protection = await guards(copy, s, cp);
  await freePort();
  log = await open(resolve(restored.directory, 'qa130-preview.log'), 'wx', 0o600);
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
      env: {
        ...process.env,
        DYNA_PREVIEW_PORT: String(port),
        DYNA_WORKER_DISABLED: 'true',
        APP_REVISION: cp.revision,
      },
      stdio: ['ignore', log.fd, log.fd],
    },
  );
  let spawnError = false;
  child.once('error', () => {
    spawnError = true;
  });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    assert(!spawnError && child.exitCode === null);
    try {
      await health(`http://127.0.0.1:${port}`, true);
      ready = true;
      break;
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
    await delay(200);
  }
  assert(ready);
  step = 'readonly-auth-isolation';
  const login = await request(
    `http://127.0.0.1:${port}`,
    '/auth/login',
    '',
    'POST',
    JSON.stringify({ email: s.email, password: s.password }),
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(typeof cookie === 'string' && cookie.startsWith('dyna_session_preview_4103='));
  const me = await request(`http://127.0.0.1:${port}`, '/auth/me', cookie);
  assert.equal(me.status, 200);
  const actor: Row = await me.json();
  assert.equal(actor.user.id, s.user);
  assert.equal(actor.user.tenant_id, s.tenant);
  assert.equal((await request(`http://127.0.0.1:${port}`, '/auth/me', s.cookie)).status, 401);
  assert.equal((await request('http://127.0.0.1:4100', '/auth/me', cookie)).status, 401);
  step = 'copied-full-http-evidence';
  const http = await api(s, cp, cookie);
  const after = await rr(copy, async () => ({
    own: await own(copy!, s),
    manifest: await tableFingerprints(copy!),
    schema: await schemaFingerprint(copy!),
  }));
  assert.deepEqual(after.own, cp.snapshot);
  assert.equal(after.schema, before.schema);
  for (const [name, fp] of Object.entries(before.manifest))
    if (name !== 'sessions') assert.deepEqual(after.manifest[name], fp);
  const sessionRows = (
    await copy.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY token_hash')
  ).rows;
  assert.equal(sessionRows.length, Number(before.manifest.sessions.count) + 1);
  for (const old of originalSessions) {
    const retained = sessionRows.find((r: Row) => r.row.token_hash === old.row.token_hash);
    assert.deepEqual(retained, old);
  }
  const addedSessions = sessionRows.filter(
    (r: Row) => !originalSessions.some((old: Row) => old.row.token_hash === r.row.token_hash),
  );
  assert.equal(addedSessions.length, 1);
  assert.equal(addedSessions[0].row.user_id, s.user);
  assert.equal(addedSessions[0].row.tenant_id, s.tenant);
  report = {
    status: 'PASS',
    stage: 130,
    phase: 'encrypted_native_restore',
    revision: cp.revision,
    schema_revision: schema,
    whole_instance_tables: restored.tables,
    whole_manifest_exact_before_preview: true,
    whole_schema_exact: true,
    own_tables_verified: 310,
    encrypted_records_verified: restored.encrypted_records_verified,
    backup_encryption: backup.encryption,
    backup_sha256: backup.sha256,
    backup_bytes: backup.bytes,
    protection,
    http,
    original_and_preview_cookie_isolated: true,
    own_checkpoint_sha256: bytesHash(
      preserved.get('data/price-file-import-stage130-chrome-checkpoint.json')!,
    ),
    non_session_manifest_exact_after_preview: true,
    source_manifest_exact: false,
    owned_resources_cleaned: false,
    database_inventory_exact: false,
    background_workers_enabled: false,
    docker_used: false,
    provider_transport_enabled: false,
    full_goal_complete: false,
  };
} catch (e) {
  const err = e as Error & { code?: string };
  await writeFile(
    `data/price-file-import-recovery-failure-${runId}.txt`,
    step + '\n' + (err.stack ?? err.message) + '\n',
    { flag: 'wx', mode: 0o600 },
  ).catch(() => {});
  process.stderr.write(
    JSON.stringify({ status: 'FAIL', step, error: err.name, code: err.code ?? null }) + '\n',
  );
  process.exitCode = 1;
} finally {
  const errors: string[] = [];
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      errors.push((e as Error).name);
    }
  };
  await attempt(stopChild);
  await attempt(async () => {
    await copy?.end();
  });
  await attempt(async () => {
    await log?.close();
  });
  if (database && originalDatabases && !originalDatabases.includes(database))
    await attempt(() => pool.query(`DROP DATABASE ${restoreDatabaseName(database!)} WITH (FORCE)`));
  if (source && originalManifest && originalSchema)
    await attempt(() =>
      rr(source!, async () => {
        assert.deepEqual(await tableFingerprints(source!), originalManifest);
        assert.equal(await schemaFingerprint(source!), originalSchema);
      }),
    );
  for (const [path, b] of preserved)
    await attempt(async () => assert.equal(bytesHash(await readFile(path)), bytesHash(b)));
  if (originalDatabases)
    await attempt(async () =>
      assert.deepEqual(
        (
          await pool.query(
            'SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname',
          )
        ).rows.map((r) => r.datname),
        originalDatabases,
      ),
    );
  await attempt(async () => {
    await source?.end();
  });
  await pool.end();
  if (report) {
    report.source_manifest_exact = !errors.length;
    report.owned_resources_cleaned = !errors.length;
    report.database_inventory_exact = !errors.length;
    report.status = errors.length ? 'FAIL_CLEANUP' : 'PASS';
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        tables: report.whole_instance_tables,
        own_tables: 310,
        encrypted_records: report.encrypted_records_verified,
        source_manifest_exact: report.source_manifest_exact,
        full_goal_complete: false,
      }) + '\n',
    );
  }
  if (errors.length) {
    process.stderr.write(JSON.stringify({ status: 'FAIL_CLEANUP', errors }) + '\n');
    process.exitCode = 1;
  }
}
