/** ROOT ONLY. Encrypted native recovery of accepted QA131, never a migration of the source.
 * QA_EXPECTED_REVISION=<feature SHA> DYNA_WORKER_DISABLED=true tsx this-file verify
 * Own restored DB + rollback-only SQL probes + isolated read-only HTTP preview.
 * Source-only authoring: root runs after accepted Chrome and genuine restart.
 * No migrations, provider traffic, Docker, source writes or baseline rebasing. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
type Row = Record<string, any>;
const schema = '114_price_matrix_imports',
  port = 4103,
  runId = randomUUID();
const reportPath = 'docs/price-matrix-import-recovery-qa.json';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let source: pg.Client | undefined, copy: pg.Client | undefined, child: ChildProcess | undefined;
let log: Awaited<ReturnType<typeof open>> | undefined, database: string | undefined;
type Recovery = typeof import('../server/recovery');
let recovery: Recovery | undefined, pool: pg.Pool | undefined;
let originalManifest: Awaited<ReturnType<Recovery['tableFingerprints']>> | undefined;
let originalSchema: string | undefined, originalDatabases: string[] | undefined;
let report: Row | undefined,
  step = 'preflight';
let sourceVerified = false,
  inventoryVerified = false,
  filesVerified = false,
  resourcesVerified = false;
let outputAllowed = false;
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
  assert.equal(names.length, 318);
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
  assert.equal(h.price_matrix_import_available, true);
}
async function readGet(s: Row, path: string, cookie: string) {
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
const matrixTables = [
  'price_matrix_import_previews',
  'price_matrix_import_targets',
  'price_matrix_import_executions',
  'price_matrix_import_execution_targets',
  'price_matrix_import_profiles',
  'price_matrix_import_profile_revisions',
  'price_matrix_import_core_witnesses',
  'price_matrix_import_execution_admissions',
];
async function guards(c: pg.Client, s: Row, cp: Row) {
  const { priceMatrixImportAvailable } = await import('../server/price-matrix-import');
  assert.equal(await priceMatrixImportAvailable(c as unknown as pg.PoolClient), true);
  const foreign = (
    await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [s.tenant])
  ).rows[0]?.id;
  assert(foreign);
  const publicTables = matrixTables.slice(0, 6);
  await rollback(c, async () => {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [foreign]);
    for (const t of publicTables)
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [s.tenant])).rows[0]
          .n,
        0,
      );
  });
  await rollback(c, async () => {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
    for (const t of publicTables)
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n,
        cp.evidence[t].length,
      );
  });
  for (const t of matrixTables) {
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
    await rollback(c, async () => {
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
      await refused(c, `DELETE FROM ${t} WHERE false`, [], '42501');
    });
  }
  for (const t of matrixTables.slice(6)) {
    await rollback(c, async () => {
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
      await refused(c, `SELECT * FROM ${t}`, [], '42501');
    });
    assert.equal(
      (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [s.tenant])).rows[0].n,
      0,
      'Private admissions/witnesses cleaned at original COMMIT',
    );
  }
  for (const t of publicTables.filter((t) => t !== 'price_matrix_import_profiles'))
    await rollback(c, () =>
      refused(c, `UPDATE ${t} SET tenant_id=tenant_id WHERE tenant_id=$1`, [s.tenant], '23514'),
    );
  await rollback(c, () =>
    refused(c, 'DELETE FROM price_matrix_import_profiles WHERE tenant_id=$1', [s.tenant], '23514'),
  );
  await rollback(c, async () => {
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [foreign]);
    await refused(
      c,
      `INSERT INTO price_matrix_import_execution_targets(tenant_id,execution_id,preview_id,price_list_id,core_execution_id)
      SELECT $1::uuid,execution_id,preview_id,price_list_id,core_execution_id
      FROM price_matrix_import_execution_targets WHERE tenant_id=$2 LIMIT 1`,
      [foreign, s.tenant],
      '23503',
    );
  });
  const privateFunctions = [
    'price_matrix_import_require(uuid,uuid,boolean)',
    'price_matrix_import_validate_target(jsonb,uuid,uuid)',
    'price_matrix_import_execution_valid(uuid)',
    'price_matrix_import_complete()',
    'price_matrix_import_core_witness()',
    'price_matrix_import_budget()',
    'price_matrix_import_receipt()',
    'price_matrix_import_seal()',
    'price_matrix_import_immutable()',
    'price_matrix_import_admission_complete()',
    'price_matrix_import_exclusive()',
  ];
  for (const f of privateFunctions)
    assert.equal(
      (await c.query("SELECT has_function_privilege('dyna_app',$1,'EXECUTE') allowed", [f])).rows[0]
        .allowed,
      false,
    );
  return {
    availability_guard_set: true,
    force_rls_tables: 8,
    foreign_scope_tables: 6,
    private_select_denials: 2,
    private_commit_rows: 0,
    immutable_evidence_tables: 5,
    immutable_profile_delete: true,
    app_direct_write_denials: 8,
    composite_fk_rejected: true,
    private_function_execute_denials: privateFunctions.length,
    all_sql_probes_rolled_back: true,
  };
}
function flags(v: Row) {
  assert.equal(v.available, true);
  assert.equal(v.read_only, true);
  assert.equal(v.current_role, 'admin');
  assert.equal(v.can_read, true);
  assert.equal(v.can_write, false);
}
function ms(value: unknown) {
  assert.equal(typeof value, 'string');
  return new Date(value as string).toISOString();
}
function previewProjection(p: Row, e: Row) {
  return {
    id: p.id,
    actor_id: p.actor_id,
    file_name: p.file_name,
    source_hash: p.source_hash,
    targets: p.targets,
    warnings: p.warnings,
    summary: p.summary,
    scope_hash: p.scope_hash,
    execution_id: e.id,
    can_execute: false,
    created_at: ms(p.created_at),
  };
}
function executionProjection(p: Row, e: Row) {
  return {
    ...previewProjection(p, e),
    id: e.id,
    preview_id: p.id,
    core_execution_ids: e.core_execution_ids,
    ack_missing_price_list_ids: e.ack_missing_price_list_ids,
    created_at: ms(e.created_at),
  };
}
async function api(s: Row, cp: Row, cookie: string) {
  const p = cp.evidence.price_matrix_import_previews[0],
    e = cp.evidence.price_matrix_import_executions[0],
    profile = cp.evidence.price_matrix_import_profiles[0];
  const get = (s: Row, path: string) => readGet(s, path, cookie);
  const prefix = '/price-matrix-imports';
  const options = await get(s, prefix + '/options');
  flags(options);
  assert.equal(options.catalog_currency, 'PLN');
  assert.equal(options.meta.cursor, null);
  const optionKeys = [
    'id',
    'name',
    'currency',
    'version',
    'active',
    'fallback',
    'adjustment_bps',
    'adjustment_amount',
  ];
  assert.deepEqual(
    options.price_lists,
    [...cp.evidence.price_lists]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((l) => Object.fromEntries(optionKeys.map((k) => [k, l[k]]))),
  );
  const { PRICE_MATRIX_IMPORT_LIMITS } = await import('../server/price-matrix-import-schema');
  assert.deepEqual(options.limits, PRICE_MATRIX_IMPORT_LIMITS);
  const result: Row[] = [];
  for (const kind of ['previews', 'executions'] as const) {
    const row = kind === 'previews' ? p : e,
      projection = kind === 'previews' ? previewProjection(p, e) : executionProjection(p, e);
    const history = await get(s, prefix + '/' + kind);
    flags(history);
    assert.deepEqual(history.meta, { total: 1, cursor: null });
    assert.deepEqual(history.data, [projection]);
    const detail = await get(s, prefix + '/' + kind + '/' + row.id);
    flags(detail);
    assert.deepEqual(detail[kind === 'previews' ? 'preview' : 'execution'], projection);
    const collected: Row[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    let page = 0;
    do {
      const r = await get(
        s,
        prefix +
          '/' +
          kind +
          '/' +
          row.id +
          '/rows' +
          (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      );
      flags(r);
      assert.equal(r.meta.total, 53);
      assert.equal(r.data.length, page === 0 ? 50 : 3);
      collected.push(...r.data);
      cursor = r.meta.cursor;
      assert.equal(cursor, page === 0 ? '50' : null);
      if (cursor) {
        assert(!seen.has(cursor));
        seen.add(cursor);
      }
      page++;
      assert(page <= 2);
    } while (cursor);
    assert.equal(page, 2);
    assert.deepEqual(collected, p.rows);
    result.push({
      kind,
      history_count: 1,
      pages: 2,
      rows: 53,
      cells: 106,
      full_sql_projection_sha256: hash(projection),
      rows_sha256: hash(collected),
    });
  }
  const profileProjection = {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    targets: profile.targets,
    created_at: ms(profile.created_at),
    updated_at: ms(profile.updated_at),
  };
  const profiles = await get(s, prefix + '/profiles');
  flags(profiles);
  assert.deepEqual(profiles.meta, { total: 1, cursor: null });
  assert.deepEqual(profiles.data, [profileProjection]);
  const detail = await get(s, prefix + '/profiles/' + profile.id);
  flags(detail);
  assert.deepEqual(detail.profile, profileProjection);
  for (const [method, path] of [
    ['POST', prefix + '/previews'],
    ['POST', prefix + '/previews/' + p.id + '/execute'],
    ['POST', prefix + '/profiles'],
    ['PATCH', prefix + '/profiles/' + profile.id],
  ] as const) {
    const response = await request(
      `http://127.0.0.1:${port}`,
      path,
      cookie,
      method,
      '{"malformed":',
      s.tenant,
    );
    assert.equal(response.status, 423);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  }
  return {
    readonly_malformed_writes: 4,
    no_store: true,
    options_exact: true,
    profile_count: 1,
    profile_version: 1,
    profile_sql_projection_sha256: hash(profileProjection),
    histories: result,
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
  outputAllowed = true;
  const configured = process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json';
  const cfg = await lstat(configured);
  assert(cfg.isFile() && !cfg.isSymbolicLink(), 'Existing native config required');
  await file(configured, true);
  await file('.recovery-key', true);
  recovery = await import('../server/recovery');
  pool = (await import('../server/db')).pool;
  const local = recovery.localDatabase();
  assert.equal(local.database, 'dynaminds');
  const s: Row = JSON.parse(
    (await file('data/price-matrix-import-stage131.json', true)).toString(),
  );
  const cp: Row = JSON.parse(
    (await file('data/price-matrix-import-stage131-chrome-checkpoint.json', true)).toString(),
  );
  assert.equal(s.stage, 131);
  assert.equal(s.setup_complete, true);
  assert.equal(s.pending, null);
  assert.equal(s.completed.length, 60);
  assert.equal(s.products.length, 53);
  assert.equal(new Set(s.products.map((p: Row) => p.id)).size, 53);
  assert.equal(cp.stage, 131);
  assert.equal(cp.status, 'PASS');
  assert.equal(cp.chrome_verified, true);
  assert.equal(cp.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(s.revision, cp.revision);
  assert.equal(s.schema_revision, schema);
  assert.equal(cp.schema_revision, schema);
  const setupBytes = preserved.get('data/price-matrix-import-stage131.json')!;
  const checkpointBytes = preserved.get(
    'data/price-matrix-import-stage131-chrome-checkpoint.json',
  )!;
  assert.deepEqual(cp.setup, {
    path: 'data/price-matrix-import-stage131.json',
    bytes: setupBytes.length,
    sha256: bytesHash(setupBytes),
  });
  assert.equal(Object.keys(cp.snapshot).length, 318);
  const csv = await file(s.files.csv.path);
  assert.equal(csv.length, s.files.csv.bytes);
  assert.equal(bytesHash(csv), s.files.csv.sha256);
  assert.equal(cp.source_csv_sha256, bytesHash(csv));
  const setupReport: Row = JSON.parse(
    (await file('docs/price-matrix-import-native-setup-qa.json')).toString(),
  );
  assert.equal(setupReport.status, 'PASS');
  assert.equal(setupReport.private_setup_sha256, bytesHash(setupBytes));
  assert.equal(setupReport.setup_checkpoint_sha256, hash(s.setup_checkpoint));
  for (const path of [
    'docs/price-matrix-import-native-chrome-qa.json',
    'docs/price-matrix-import-native-restart-qa.json',
  ]) {
    const accepted: Row = JSON.parse((await file(path)).toString());
    assert.equal(accepted.status, 'PASS');
    assert.equal(accepted.stage, 131);
    assert.equal(accepted.revision, cp.revision);
    assert.equal(accepted.schema_revision, schema);
    assert.equal(accepted.table_count, 318);
    assert.equal(accepted.all_other_business_tables_exact, true);
    assert.equal(accepted.chrome_verified, true);
    assert.equal(accepted.checkpoint_sha256, bytesHash(checkpointBytes));
    assert.equal(accepted.setup_sha256, bytesHash(setupBytes));
    assert.equal(accepted.snapshot_sha256, hash(cp.snapshot));
    assert.equal(accepted.evidence_sha256, hash(cp.evidence));
    assert.equal(accepted.background_workers_enabled, false);
    if (path.includes('restart')) assert.equal(accepted.restart_verified, true);
  }
  // Root's independent historical checker owns thirteen older accepted firms. Its
  // original byte map is an immutable prerequisite, not a new/rebased baseline.
  const history: Row = JSON.parse(
    (await file('docs/price-matrix-import-history-before.json')).toString(),
  );
  assert.equal(history.status, 'PASS');
  assert.equal(history.firms.length, 13);
  assert.equal(Object.keys(history.private_fixture_sha256).length, 11);
  for (const [path, digest] of Object.entries(history.private_fixture_sha256)) {
    assert.match(path, /^data\/[a-z0-9-]+\.json$/);
    assert.equal(bytesHash(await file(path, true)), digest);
  }
  await health('http://127.0.0.1:4100', false);
  process.env.APP_REVISION = cp.revision;
  originalDatabases = (
    await pool!.query('SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname')
  ).rows.map((r) => r.datname);
  source = new pg.Client(local);
  await source.connect();
  const before = await rr(source, async () => ({
    own: await own(source!, s),
    manifest: await recovery!.tableFingerprints(source!),
    schema: await recovery!.schemaFingerprint(source!),
  }));
  assert.deepEqual(before.own, cp.snapshot);
  assert.equal(Object.keys(before.manifest).length, 333);
  originalManifest = before.manifest;
  originalSchema = before.schema;
  step = 'encrypted-backup-and-restore';
  await absent(resolve('data', 'qa131-backups', runId));
  await absent(resolve('data', 'qa131-restores', runId));
  const backup = await recovery!.createBackup({
    directory: resolve('data', 'qa131-backups', runId),
  });
  assert.equal(backup.status, 'created');
  assert.equal(backup.source, 'dynaminds');
  assert.equal(backup.tables, 333);
  assert.equal(backup.encryption, 'AES-256-GCM');
  const backupStat = await lstat(backup.file);
  assert(
    backupStat.isFile() && !backupStat.isSymbolicLink() && (backupStat.mode & 0o777) === 0o600,
  );
  const backupBytes = await readFile(backup.file);
  assert.equal(backupBytes.length, backup.bytes);
  assert.equal(bytesHash(backupBytes), backup.sha256);
  assert.equal(backupBytes.subarray(0, 8).toString(), 'DYNAEC01');
  const restored = await recovery!.restoreBackup(backup.file, {
    directory: resolve('data', 'qa131-restores', runId),
  });
  const ownedDatabase = recovery!.restoreDatabaseName(restored.database);
  assert(!originalDatabases.includes(ownedDatabase));
  database = ownedDatabase;
  assert.equal(restored.source, 'dynaminds');
  assert.equal(restored.revision, cp.revision);
  assert.equal(restored.status, 'verified');
  assert.equal(restored.tables, 333);
  assert(
    Number.isSafeInteger(restored.encrypted_records_verified) &&
      restored.encrypted_records_verified > 0,
  );
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
    manifest: await recovery!.tableFingerprints(copy!),
    schema: await recovery!.schemaFingerprint(copy!),
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
  log = await open(resolve(restored.directory, 'qa131-preview.log'), 'wx', 0o600);
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
  const { readonly_malformed_writes, ...retainedApi } = http;
  assert.equal(readonly_malformed_writes, 4);
  assert.deepEqual(retainedApi, cp.api);
  const after = await rr(copy, async () => ({
    own: await own(copy!, s),
    manifest: await recovery!.tableFingerprints(copy!),
    schema: await recovery!.schemaFingerprint(copy!),
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
    stage: 131,
    phase: 'encrypted_native_restore',
    revision: cp.revision,
    schema_revision: schema,
    whole_instance_tables: restored.tables,
    whole_manifest_exact_before_preview: true,
    whole_schema_exact: true,
    own_tables_verified: 318,
    original_private_files_verified: 11,
    historical_checker_reference: 'docs/price-matrix-import-history-before.json',
    previous_firms_in_full_instance_manifest: 13,
    source_schema_sha256: originalSchema,
    checkpoint_snapshot_sha256: hash(cp.snapshot),
    checkpoint_evidence_sha256: hash(cp.evidence),
    chrome_and_restart_reports_verified: true,
    encrypted_records_verified: restored.encrypted_records_verified,
    backup_encryption: backup.encryption,
    backup_sha256: backup.sha256,
    backup_bytes: backup.bytes,
    backup_artifacts_retained: true,
    cleanup_scope: 'Only this helper child process and its validated new restored database',
    lost_response_native_verified: false,
    scale_capacity_verified: false,
    protection,
    http,
    original_and_preview_cookie_isolated: true,
    own_checkpoint_sha256: bytesHash(
      preserved.get('data/price-matrix-import-stage131-chrome-checkpoint.json')!,
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
    `data/price-matrix-import-recovery-failure-${runId}.txt`,
    step + '\n' + (err.stack ?? err.message) + '\n',
    { flag: 'wx', mode: 0o600 },
  ).catch(() => {});
  process.stderr.write(
    JSON.stringify({ status: 'FAIL', step, error: err.name, code: err.code ?? null }) + '\n',
  );
  report = {
    status: 'FAIL',
    stage: 131,
    phase: 'encrypted_native_restore',
    step,
    error: err.name,
    code: err.code ?? null,
    full_goal_complete: false,
  };
  process.exitCode = 1;
} finally {
  const errors: string[] = [];
  const cleanupStart = errors.length;
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
  if (recovery && pool && database && originalDatabases && !originalDatabases.includes(database))
    await attempt(() =>
      pool!.query(`DROP DATABASE ${recovery!.restoreDatabaseName(database!)} WITH (FORCE)`),
    );
  resourcesVerified = errors.length === cleanupStart;
  if (recovery && source && originalManifest && originalSchema)
    await attempt(() =>
      rr(source!, async () => {
        assert.deepEqual(await recovery!.tableFingerprints(source!), originalManifest);
        assert.equal(await recovery!.schemaFingerprint(source!), originalSchema);
        await health('http://127.0.0.1:4100', false);
        sourceVerified = true;
      }),
    );
  const filesStart = errors.length;
  for (const [path, b] of preserved)
    await attempt(async () => {
      const st = await lstat(path);
      assert(st.isFile() && !st.isSymbolicLink());
      assert.equal(bytesHash(await readFile(path)), bytesHash(b));
    });
  filesVerified = preserved.size > 0 && errors.length === filesStart;
  if (pool && originalDatabases)
    await attempt(async () => {
      assert.deepEqual(
        (
          await pool!.query(
            'SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname',
          )
        ).rows.map((r) => r.datname),
        originalDatabases,
      );
      inventoryVerified = true;
    });
  await attempt(async () => {
    await source?.end();
  });
  await attempt(async () => {
    await pool?.end();
  });
  if (report && outputAllowed) {
    report.source_manifest_exact = sourceVerified;
    report.owned_resources_cleaned = resourcesVerified;
    report.database_inventory_exact = inventoryVerified;
    report.original_private_and_public_bytes_exact = filesVerified;
    if (errors.length) report.status = 'FAIL_CLEANUP';
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        tables: report.whole_instance_tables ?? null,
        own_tables: report.own_tables_verified ?? null,
        encrypted_records: report.encrypted_records_verified ?? null,
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
