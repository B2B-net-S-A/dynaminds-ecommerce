/** QA105 readonly recovery. Run after native acceptance and restart, never logs secrets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
  manifestSchema,
  tableFingerprints,
  schemaFingerprint,
} from '../server/recovery';

const statePath = 'data/product-logistics-stage105.json';
const schema = '084_product_logistics_recovery';
const evidenceTables = [
  'catalog_bulk_edit_previews',
  'catalog_bulk_edit_rows',
  'catalog_bulk_edit_executions',
  'catalog_bulk_edit_execution_rows',
];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let child: ReturnType<typeof spawn> | undefined;
let database: string | undefined;
let report: any;
let priorDatabases: string[] | undefined;
async function databaseNames() {
  const client = new pg.Client({ ...localDatabase(), database: 'postgres' });
  await client.connect();
  try {
    return (await client.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map((r) =>
      String(r.datname),
    );
  } finally {
    await client.end();
  }
}
const logisticsFields = [
  'weight_grams',
  'length_mm',
  'width_mm',
  'height_mm',
  'manufacturer',
] as const;
const logisticsOf = (p: any) => Object.fromEntries(logisticsFields.map((k) => [k, p[k]]));
async function ownSnapshot(state: any, databaseName = localDatabase().database) {
  const client = new pg.Client({ ...localDatabase(), database: databaseName });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert(typeof state.own_snapshot_timezone === 'string');
    await client.query("SELECT set_config('TimeZone',$1,true)", [state.own_snapshot_timezone]);
    const values: Record<string, string> = {};
    for (const name of state.own_names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const column = name === 'tenants' ? 'id' : 'tenant_id';
      values[name] = digest(
        (
          await client.query(
            `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${column}=$1 ORDER BY 1`,
            [state.tenant],
          )
        ).rows,
      );
    }
    await client.query('COMMIT');
    return values;
  } finally {
    await client.end();
  }
}
try {
  const stat = await lstat(statePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert(state.ui_verified === true, 'Require accepted final UI state');
  assert(
    state.execution_id && state.preview_id && state.tenant && state.bundle?.id && state.order?.id,
  );
  assert(Array.isArray(state.products) && state.products.length === 3);
  assert(Array.isArray(state.own_names) && state.own_snapshot);
  for (const name of [...evidenceTables, 'product_logistics'])
    assert(
      state.own_names.includes(name) && state.own_snapshot[name],
      'Missing module snapshot ' + name,
    );
  for (const table of [
    'jobs',
    'audit_events',
    'outbound_events',
    'outbound_deliveries',
    'email_messages',
    'sms_messages',
  ])
    assert(
      state.own_names.includes(table) && state.own_snapshot[table],
      'Missing strengthened snapshot ' + table,
    );
  const live = 'http://127.0.0.1:4100/api';
  const health = (await (await fetch(live + '/health')).json()) as any;
  assert.equal(health.schema_revision, schema);
  assert(health.catalog_bulk_edit_available && health.product_logistics_available);
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  assert.equal(
    health.revision,
    state.runtime_revision,
    'Recovery source must match accepted runtime',
  );
  if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
  process.env.APP_REVISION = health.revision;
  const before = await ownSnapshot(state);
  assert.deepEqual(
    before,
    state.own_snapshot,
    'Recovery source must match the accepted own snapshot',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')",
        [state.tenant],
      )
    ).rows[0].n,
    0,
    'Own jobs must be terminal before snapshot',
  );
  priorDatabases = await databaseNames();
  const expectedProducts = (
    await pool.query(
      `SELECT p.id,p.version,l.weight_grams,l.length_mm,l.width_mm,l.height_mm,l.manufacturer
     FROM products p LEFT JOIN product_logistics l ON (l.tenant_id,l.product_id)=(p.tenant_id,p.id)
     WHERE p.tenant_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY p.id`,
      [state.tenant, state.products.map((p: any) => p.id)],
    )
  ).rows;
  assert.equal(expectedProducts.length, state.products.length);
  assert(
    expectedProducts.every((p) => logisticsFields.every((k) => p[k] !== null)),
    'Final accepted physical profiles must be complete',
  );
  const expectedById = new Map<string, any>(expectedProducts.map((p) => [String(p.id), p]));
  const expectedPreview = (
    await pool.query(
      'SELECT scope_hash FROM catalog_bulk_edit_previews WHERE tenant_id=$1 AND id=$2',
      [state.tenant, state.preview_id],
    )
  ).rows[0];
  const expectedExecution = (
    await pool.query(
      'SELECT preview_id,scope_hash,state FROM catalog_bulk_edit_executions WHERE tenant_id=$1 AND id=$2',
      [state.tenant, state.execution_id],
    )
  ).rows[0];
  assert(expectedPreview && expectedExecution?.state === 'done');
  assert.equal(expectedExecution.preview_id, state.preview_id);
  const port = Number(process.env.DYNA_PREVIEW_PORT ?? 4102);
  assert(Number.isInteger(port) && port >= 4101 && port <= 4199);
  let occupied = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    occupied = true;
  } catch {}
  assert(!occupied, 'Preview port occupied');
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/product-logistics-105-restore',
  });
  const createdDatabase = restoreDatabaseName(restored.database);
  assert(!priorDatabases.includes(createdDatabase), 'Never clean up any pre-existing database');
  database = createdDatabase;
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      !restored.worker_enabled,
  );
  assert.equal(restored.revision, health.revision);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8')),
  );
  assert.deepEqual(await ownSnapshot(state, database), before);
  const client = new pg.Client({ ...localDatabase(), database });
  await client.connect();
  let migrations = 0;
  let foreign = '';
  try {
    await client.query("SET TIME ZONE 'UTC'");
    assert.deepEqual(await tableFingerprints(client), manifest.tables);
    assert.equal(
      await schemaFingerprint(client, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
    const rows = (await client.query('SELECT name FROM migrations ORDER BY name')).rows;
    migrations = rows.length;
    assert.equal(rows.at(-1)?.name, schema);
    foreign = (
      await client.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [state.tenant])
    ).rows[0].id;
    for (const table of [...evidenceTables, 'product_logistics']) {
      const rls = (
        await client.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(rls.relrowsecurity && rls.relforcerowsecurity);
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE dyna_app');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [foreign]);
        assert.equal(
          (
            await client.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          0,
        );
      } finally {
        await client.query('ROLLBACK');
      }
      assert(
        (
          await client.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
            state.tenant,
          ])
        ).rows[0].n > 0,
        'Missing own evidence ' + table,
      );
      if (table === 'product_logistics') {
        assert.equal(
          (
            await client.query(
              'SELECT count(*)::int n FROM product_logistics WHERE tenant_id=$1 AND weight_grams IS NOT NULL',
              [state.tenant],
            )
          ).rows[0].n,
          3,
        );
        continue; // Mutable catalogue profiles have FORCE RLS, while evidence remains append-only.
      }
      for (const statement of [
        `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`,
        `DELETE FROM ${table} WHERE tenant_id=$1`,
      ]) {
        await client.query('BEGIN');
        try {
          await assert.rejects(client.query(statement, [state.tenant]), /immutable/i);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    }
  } finally {
    await client.end();
  }
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
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const h = (await response.json()) as any;
        assert(h.restore_preview && h.catalog_bulk_edit_available && h.product_logistics_available);
        assert.equal(h.schema_revision, schema);
        assert.equal(h.revision, health.revision);
        ready = true;
        break;
      }
    } catch {}
    assert(child.exitCode === null && child.signalCode === null, 'Preview exited');
    await setTimeout(200);
  }
  assert(ready);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const req = (path: string, method = 'GET', body?: unknown, workspace = state.tenant) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', 'X-Workspace-Id': workspace },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const selectionIds = [...state.products.map((p: any) => p.id), state.bundle.id];
  assert(new Set(selectionIds).size === selectionIds.length);
  const reads = [
    '/catalog-bulk-edit',
    '/catalog-bulk-edit/selection?ids=' + selectionIds.join(','),
    '/catalog-bulk-edit/previews/' + state.preview_id,
    '/catalog-bulk-edit/previews/' + state.preview_id + '/rows',
    '/catalog-bulk-edit/executions',
    '/catalog-bulk-edit/executions/' + state.execution_id,
    '/catalog-bulk-edit/executions/' + state.execution_id + '/rows',
    ...state.products.map((p: any) => '/products/' + p.id),
    '/orders/' + state.order.id + '/product-logistics',
  ];
  for (const path of reads) {
    const response = await req(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const json = (await response.json()) as any;
    if (path.startsWith('/products/')) {
      const expected = expectedById.get(json.id);
      assert(expected);
      assert.equal(json.product_logistics_available, true);
      assert.equal(json.version, expected.version);
      assert.deepEqual(logisticsOf(json), logisticsOf(expected));
      continue;
    }
    if (path.endsWith('/product-logistics')) {
      assert.equal(json.available, true);
      assert.equal(json.basis, 'current_catalog');
      assert.equal(json.total_known_weight_grams, 12250);
      assert.equal(json.complete, true);
      assert.equal(json.weight_overflow, false);
      assert.deepEqual(json.missing_weight_product_ids, []);
      for (const item of json.items) {
        const expected = expectedById.get(item.product_id);
        assert(expected);
        assert.equal(item.version, expected.version);
        assert.deepEqual(logisticsOf(item), logisticsOf(expected));
      }
      continue;
    }
    assert(json.available && json.read_only);
    assert.equal(json.can_write, false, path + ' can_write');
    assert.equal(json.can_read, true, path + ' can_read');
    assert.equal(json.current_role, 'admin');
    if (path === '/catalog-bulk-edit/selection?ids=' + selectionIds.join(',')) {
      assert.equal(json.product_logistics_available, true);
      assert.deepEqual(new Set(json.data.map((p: any) => p.id)), new Set(selectionIds));
      for (const product of json.data) {
        assert.equal(product.product_logistics_available, true);
        if (product.id === state.bundle.id) continue;
        const expected = expectedById.get(product.id);
        assert(expected);
        assert.equal(product.version, expected.version);
        assert.deepEqual(logisticsOf(product), logisticsOf(expected));
      }
    }
    if (path === '/catalog-bulk-edit/previews/' + state.preview_id)
      assert.equal(json.preview.scope_hash, expectedPreview.scope_hash);
    if (path === '/catalog-bulk-edit/executions/' + state.execution_id) {
      assert.equal(json.execution.state, 'done');
      assert.equal(json.execution.preview_id, state.preview_id);
      assert.equal(json.execution.scope_hash, expectedExecution.scope_hash);
    }
  }
  const writes: [string, string][] = [
    ['/catalog-bulk-edit/previews', 'POST'],
    ['/catalog-bulk-edit/previews/' + state.preview_id + '/execute', 'POST'],
    ['/products/' + state.products[0].id, 'PATCH'],
  ];
  for (const [path, method] of writes)
    assert.equal((await req(path, method, { invalid: true })).status, 423, path);
  assert.equal((await req('/catalog-bulk-edit', 'GET', undefined, foreign)).status, 409);
  assert.equal((await fetch(live + '/catalog-bulk-edit', { headers: { cookie } })).status, 401);
  assert.deepEqual(await ownSnapshot(state, database), before);
  assert.deepEqual(await ownSnapshot(state), before);
  report = {
    stage: 105,
    verified_at: new Date().toISOString(),
    source_revision: health.revision,
    schema,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations,
    all_snapshot_rows_verified: true,
    schema_fingerprint_verified: true,
    encrypted_records_verified: restored.encrypted_records_verified,
    accepted_ui_state_verified: true,
    complete_order_weight_grams: 12250,
    own_profiles_verified: expectedProducts.length,
    protected_existing_databases: priorDatabases.length,
    own_business_fingerprints: Object.keys(before).length,
    force_RLS_verified: true,
    foreign_rows_hidden: true,
    evidence_append_only: true,
    module_execution_immutable: true,
    preview_read_paths: reads.length,
    preview_mutation_statuses: writes.map(() => 423),
    workspace_mismatch_status: 409,
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    external_provider_verified: false,
    goal_complete: false,
  };
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    if (!(await Promise.race([ended.then(() => true), setTimeout(10000).then(() => false)]))) {
      child.kill('SIGKILL');
      await ended;
    }
  }
  if (database) {
    const admin = new pg.Client({ ...localDatabase(), database: 'postgres' });
    await admin.connect();
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [database],
      );
      await admin.query('DROP DATABASE ' + restoreDatabaseName(database));
    } finally {
      await admin.end();
    }
  }
  await pool.end();
  if (priorDatabases)
    assert.deepEqual(
      await databaseNames(),
      priorDatabases,
      'All pre-existing databases must remain untouched, including on failure',
    );
}
assert(report);
assert(priorDatabases);
assert.deepEqual(
  await databaseNames(),
  priorDatabases,
  'All pre-existing databases must remain untouched',
);
report.preview_database_removed = true;
report.pre_existing_databases_preserved = true;
report.own_preview_process_stopped = true;
await writeFile('docs/product-logistics-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log({
  stage: 105,
  tables: report.restore_tables,
  migrations: report.migrations,
  encrypted: report.encrypted_records_verified,
  reads: report.preview_read_paths,
  writes423: report.preview_mutation_statuses.length,
  cleanup: true,
});
