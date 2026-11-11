/** Root QA117: actual encrypted restore and immutable import-history readback. */
import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
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
  schemaFingerprint,
} from '../server/recovery';

type Json = Record<string, any>;
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const schema = '098_catalog_file_imports',
  port = 4157;
const source = localDatabase(),
  admin = new pg.Client({ ...source, database: 'postgres' });
const path = 'data/catalog-file-import-stage117.json',
  reportPath = 'docs/catalog-file-import-recovery-qa.json';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** SQL is the oracle; JSON normalization matches public Date/string serialization only. */
function publicHead(row: Json, preview?: Json): Json {
  return JSON.parse(
    JSON.stringify({
      id: row.id,
      ...(preview ? { preview_id: row.preview_id, state: row.state } : {}),
      actor_id: row.actor_id,
      scope_hash: row.scope_hash,
      total: row.total,
      created: row.created,
      updated: row.updated,
      unchanged: row.unchanged,
      invalid: preview ? 0 : row.invalid,
      ready: preview ? true : row.ready,
      created_at: row.created_at,
      config: (preview ?? row).config,
      active_product_rules: (preview ?? row).rules_snapshot.length,
    }),
  );
}
function publicRows(rows: Json[]): Json[] {
  return rows.map((raw) => {
    const row = { ...raw };
    for (const privateKey of ['tenant_id', 'preview_id', 'execution_id', 'byte_count'])
      delete row[privateKey];
    return JSON.parse(JSON.stringify({ ...row, changes: raw.input }));
  });
}
function assertImportConfigs(previews: Json[], s: Json) {
  assert.deepEqual(
    previews.map((p) => p.config.format),
    ['xml', 'xml', 'csv'],
  );
  assert.deepEqual(
    previews.map((p) => p.config.mapping),
    [{}, {}, { sku: 'Kod dostawcy', name: 'Nowa nazwa' }],
  );
  for (const p of previews) {
    assert.equal(p.actor_id, s.user);
    assert.equal(p.config.warehouse_id, s.warehouse.id);
    assert.equal(p.config.currency, 'PLN');
    assert.equal(p.config.mode, 'update');
    assert.equal(p.config.empty_policy, 'skip');
    assert.equal(p.config.ignore_readonly_fields, false);
    assert(!Object.hasOwn(p.config, 'content'));
  }
  assert.equal(previews[2].config.delimiter, ';');
  assert.equal(previews[2].config.identity, 'sku');
}
function assertMappedRows(rows: Json[], s: Json) {
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.product_id).sort(), [s.products.a.id, s.products.b.id].sort());
  for (const [key, product] of Object.entries(s.products) as [string, Json][]) {
    const row = rows.find((r) => r.product_id === product.id);
    assert(row);
    assert.equal(row.identity_value, product.sku);
    assert.equal(row.sku, product.sku);
    assert.equal(row.current_sku, product.sku);
    assert.equal(row.matched_historical_sku, false);
    assert.equal(row.operation, 'update');
    assert.equal(row.input.name, key === 'a' ? 'QA117 Nazwa CSV A' : 'QA117 Nazwa CSV B');
    assert.equal(row.after.name, row.input.name);
    assert.equal(row.after.sku, product.sku);
    assert.deepEqual(row.changed_fields, ['name']);
    assert.deepEqual(row.errors, []);
  }
}
let state: Json | undefined,
  copied: pg.Client | undefined,
  child: ReturnType<typeof spawn> | undefined;
let owned: string | undefined,
  prior: string[] = [],
  phase = 'prerequisites';
let failed = false,
  cleanupError = false,
  checkpointVerified = false,
  report: Json | undefined;
async function checkpoint(c: pg.Client | pg.PoolClient, s: Json) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Json = {};
    assert.equal(s.own_names.length, 23);
    for (const name of s.own_names as string[]) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
          name === 'users' ? s.user : s.tenant,
        ])
      ).rows;
      result[name] = { count: rows.length, sha256: hash(rows) };
    }
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function sourceCheckpoint(s: Json) {
  const c = await pool.connect();
  try {
    return await checkpoint(c, s);
  } finally {
    c.release();
  }
}
async function globalSnapshot(c: pg.Client) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const tables = await tableFingerprints(c),
      schemaHash = await schemaFingerprint(c);
    const sessions = (await c.query('SELECT id,tenant_id,user_id FROM sessions ORDER BY id')).rows;
    await c.query('COMMIT');
    return { tables, schemaHash, sessions };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function request(base: string, endpoint: string, options: RequestInit = {}) {
  return fetch(base + endpoint, { ...options, signal: AbortSignal.timeout(30000) });
}
async function read(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()) as Json;
}
try {
  await admin.connect();
  prior = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
    (r) => r.datname,
  );
  assert.equal(prior.length, 17);
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  state = JSON.parse(await readFile(path, 'utf8'));
  const s = state!;
  assert(s.stage === 117 && s.setup_complete && !s.pending && s.accepted_checkpoint);
  assert.equal(s.runtime_revision, revision);
  assert.equal(s.schema_revision, schema);
  const native = JSON.parse(
    await readFile('docs/catalog-file-import-native-readback-qa.json', 'utf8'),
  );
  assert.equal(native.status, 'PASS');
  assert.equal(native.runtime_revision, revision);
  assert.equal(native.schema_revision, schema);
  assert.equal(native.tenant, s.tenant);
  assert.equal(native.checkpoint_sha256, hash(s.accepted_checkpoint));
  assert.equal(native.executions, 3);
  assert.deepEqual(await sourceCheckpoint(s), s.accepted_checkpoint);
  checkpointVerified = true;
  const main = 'http://127.0.0.1:4100/api';
  const health = (await (await request(main, '/health')).json()) as Json;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, schema);
  const probe = createServer();
  await new Promise<void>((done, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => done());
  });
  await new Promise<void>((done) => probe.close(() => done()));
  process.env.APP_REVISION = revision;
  phase = 'encrypted_backup';
  const backup = await createBackup();
  phase = 'isolated_restore';
  const restored = await restoreBackup(backup.file, {
    directory: 'data/catalog-file-import-117-restore',
  });
  const name = restoreDatabaseName(restored.database);
  assert(!prior.includes(name));
  owned = name;
  assert.equal(restored.status, 'verified');
  assert.equal(restored.revision, revision);
  assert.equal(restored.tables, 271);
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      restored.preview_only &&
      restored.worker_enabled === false,
  );
  const config = JSON.parse(await readFile(restored.config, 'utf8'));
  copied = new pg.Client({ ...source, database: name, password: config.dbPassword });
  await copied.connect();
  assert.deepEqual(await checkpoint(copied, s), s.accepted_checkpoint);
  const before = await globalSnapshot(copied);
  assert.equal(Object.keys(before.tables).length, 271);
  const migrations = (await copied.query('SELECT name FROM migrations ORDER BY name')).rows;
  assert.equal(migrations.length, 98);
  assert.equal(migrations.at(-1)?.name, schema);
  const tables = [
    'catalog_file_import_previews',
    'catalog_file_import_rows',
    'catalog_file_import_executions',
    'catalog_file_import_execution_rows',
  ];
  const flags = (
    await copied.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
    WHERE relname=ANY($1::text[]) AND relnamespace='public'::regnamespace`,
      [tables],
    )
  ).rows;
  assert.equal(flags.length, 4);
  assert(flags.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  const foreign = (
    await copied.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [s.tenant])
  ).rows[0];
  assert(foreign);
  await copied.query('BEGIN');
  try {
    await copied.query('SET LOCAL ROLE dyna_app');
    await copied.query("SELECT set_config('app.tenant_id',$1,true)", [foreign.id]);
    for (const table of tables)
      assert.equal(
        (
          await copied.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [
            s.tenant,
          ])
        ).rows[0].n,
        0,
      );
  } finally {
    await copied.query('ROLLBACK');
  }
  phase = 'readonly_preview';
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
  let childError = false;
  child.once('error', () => {
    childError = true;
  });
  const base = `http://127.0.0.1:${port}/api`;
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const h = (await response.json()) as Json;
        assert(h.restore_preview && h.catalog_file_imports_available);
        assert.equal(h.revision, revision);
        assert.equal(h.schema_revision, schema);
        ready = true;
        break;
      }
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
    assert(!childError && child.exitCode === null && child.signalCode === null);
    await delay(150);
  }
  assert(ready);
  assert.equal(
    (await request(base, '/catalog/file-imports/history', { headers: { cookie: s.cookie } }))
      .status,
    401,
  );
  const login = await request(base, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: s.email, password: s.password }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert(setCookie);
  const cookie = setCookie.split(';')[0];
  const headers = { cookie, 'X-Workspace-ID': s.tenant };
  const me = await read(await request(base, '/auth/me', { headers }));
  assert.equal(me.user.id, s.user);
  assert.equal((await request(main, '/auth/me', { headers: { cookie } })).status, 401);
  assert.equal(
    (
      await request(base, '/catalog/file-imports/history', {
        headers: { cookie, 'X-Workspace-ID': foreign.id },
      })
    ).status,
    409,
  );
  const options = await read(await request(base, '/catalog/file-imports/options', { headers }));
  assert(options.available && options.can_read && options.read_only && !options.can_write);
  const previews = (
    await copied.query(
      'SELECT * FROM catalog_file_import_previews WHERE tenant_id=$1 ORDER BY created_at,id',
      [s.tenant],
    )
  ).rows;
  const executions = (
    await copied.query(
      'SELECT * FROM catalog_file_import_executions WHERE tenant_id=$1 ORDER BY created_at,id',
      [s.tenant],
    )
  ).rows;
  assert.equal(previews.length, 3);
  assert.equal(executions.length, 3);
  assertImportConfigs(previews, s);
  // Keep the SQL ordering, including sub-millisecond timestamp precision.
  const orderedHistory = (
    await copied.query(
      `SELECT kind,id FROM (
      SELECT 'preview'::text kind,id,created_at FROM catalog_file_import_previews WHERE tenant_id=$1
      UNION ALL
      SELECT 'execution'::text kind,id,created_at FROM catalog_file_import_executions WHERE tenant_id=$1
    ) h ORDER BY created_at DESC,id DESC,kind DESC`,
      [s.tenant],
    )
  ).rows;
  const expectedHistory = orderedHistory.map((h) => {
    const execution = h.kind === 'execution';
    const raw = (execution ? executions : previews).find((row) => row.id === h.id);
    assert(raw);
    const parent = execution ? previews.find((p) => p.id === raw.preview_id) : undefined;
    if (execution) assert(parent);
    return { kind: h.kind, ...publicHead(raw, parent) };
  });
  const history = await read(await request(base, '/catalog/file-imports/history', { headers }));
  assert.equal(expectedHistory.length, 6);
  assert.deepEqual(history.data, expectedHistory);
  assert.equal(history.meta.cursor, null);
  assert(history.available && history.can_read && history.read_only && !history.can_write);
  for (const h of history.data as Json[]) {
    const detail = await read(
      await request(
        base,
        '/catalog/file-imports/' + (h.kind === 'preview' ? 'previews/' : 'executions/') + h.id,
        { headers },
      ),
    );
    assert(detail.available && detail.can_read && detail.read_only && !detail.can_write);
    const execution = h.kind === 'execution';
    const raw = (execution ? executions : previews).find((row) => row.id === h.id);
    assert(raw);
    const parent = execution ? previews.find((p) => p.id === raw.preview_id) : undefined;
    if (execution) {
      assert(parent);
      assert.equal(raw.actor_id, s.user);
    }
    const rows: Json[] = (
      await copied.query(
        execution
          ? 'SELECT * FROM catalog_file_import_execution_rows WHERE tenant_id=$1 AND execution_id=$2 ORDER BY index'
          : 'SELECT * FROM catalog_file_import_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
        [s.tenant, raw.id],
      )
    ).rows;
    assert.equal(rows.length, raw.total);
    if ((parent ?? raw).config.format === 'csv') assertMappedRows(rows, s);
    assert.deepEqual(execution ? detail.execution : detail.preview, publicHead(raw, parent));
    assert.deepEqual(detail.rows, publicRows(rows));
    assert.equal(detail.meta.cursor, null);
  }
  const denied = [
    '/catalog/file-imports/preview',
    '/catalog/file-imports/previews/' + previews[0].id + '/execute',
  ];
  for (const endpoint of denied) {
    const response = await request(base, endpoint, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(response.status, 423);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(await checkpoint(copied, s), s.accepted_checkpoint);
  const after = await globalSnapshot(copied);
  assert.equal(after.schemaHash, before.schemaHash);
  assert.deepEqual(Object.keys(after.tables), Object.keys(before.tables));
  for (const [name, fingerprint] of Object.entries(before.tables))
    if (name !== 'sessions')
      assert.deepEqual(after.tables[name], fingerprint, 'Readonly changed table ' + name);
  const oldIds = new Set(before.sessions.map((r) => r.id)),
    added = after.sessions.filter((r) => !oldIds.has(r.id));
  assert.equal(added.length, 1);
  assert.equal(added[0].tenant_id, s.tenant);
  assert.equal(added[0].user_id, s.user);
  assert.equal(after.sessions.length, before.sessions.length + 1);
  await copied.query("SET TIME ZONE 'UTC'");
  const oldSessions = (
    await copied.query(
      `SELECT count(*)::text count,
    coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),1,16))::bit(64)::bigint),0)::text high,
    coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),17,16))::bit(64)::bigint),0)::text low
    FROM sessions t WHERE id<>$1`,
      [added[0].id],
    )
  ).rows[0];
  assert.deepEqual(oldSessions, before.tables.sessions);
  report = {
    status: 'PASS',
    stage: 117,
    runtime_revision: revision,
    schema_revision: schema,
    tables: 271,
    migrations: 98,
    encrypted_records_verified: restored.encrypted_records_verified,
    row_manifest_exact_before_preview: true,
    schema_fingerprint_exact: true,
    own_checkpoint_tables: 23,
    own_checkpoint_exact_source_and_copy: true,
    force_rls_tables: tables,
    foreign_scope_denied: true,
    history_entries: 6,
    details: 6,
    public_heads_rows_exact: true,
    history_exact: true,
    formats_and_mapping_exact: true,
    writes_denied_before_parse: 2,
    non_session_tables_exact_after_preview: true,
    original_sessions_exact: true,
    new_own_preview_sessions: 1,
    source_cookie_denied: true,
    preview_cookie_denied_on_source: true,
    foreign_workspace_denied: true,
    preview_only: true,
    worker_enabled: false,
    provider_operations: false,
    full_goal_complete: false,
  };
} catch {
  failed = true;
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
  try {
    await copied?.end();
  } catch {
    cleanupError = true;
  }
  try {
    if (owned) {
      assert(!prior.includes(owned));
      await admin.query('DROP DATABASE ' + restoreDatabaseName(owned) + ' WITH (FORCE)');
    }
  } catch {
    cleanupError = true;
  }
  try {
    if (prior.length)
      assert.deepEqual(
        (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
          (r) => r.datname,
        ),
        prior,
      );
  } catch {
    cleanupError = true;
  }
  try {
    if (checkpointVerified && state)
      assert.deepEqual(await sourceCheckpoint(state), state.accepted_checkpoint);
  } catch {
    cleanupError = true;
  }
  await admin.end().catch(() => {});
  await pool.end().catch(() => {});
}
if (failed || cleanupError || !report) {
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: 'FAIL',
        stage: 117,
        phase,
        cleanup_verified: !cleanupError,
        private_error_details_suppressed: true,
        full_goal_complete: false,
      },
      null,
      2,
    ),
  );
  process.stderr.write(
    JSON.stringify({ status: 'FAIL', phase, cleanup_verified: !cleanupError }) + '\n',
  );
  process.exitCode = 1;
} else {
  Object.assign(report, {
    original_databases_preserved: prior.length,
    owned_preview_and_database_removed: true,
    source_checkpoint_exact_after_cleanup: true,
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({
      status: 'PASS',
      stage: 117,
      tables: 271,
      history: 6,
      denied: 2,
      original_databases_preserved: prior.length,
    }) + '\n',
  );
}
