/** QA106 recovery against the accepted SKU state; execution is a separate root-owned step. */
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

const statePath = 'data/product-sku-stage106.json';
const schema = '085_product_sku';
const evidenceTables = [
  'catalog_bulk_edit_previews',
  'catalog_bulk_edit_rows',
  'catalog_bulk_edit_executions',
  'catalog_bulk_edit_execution_rows',
];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let child: ReturnType<typeof spawn> | undefined;
let database: string | undefined;
let priorDatabases: string[] | undefined;
let report: any;

async function databaseNames() {
  const c = new pg.Client({ ...localDatabase(), database: 'postgres' });
  await c.connect();
  try {
    return (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map((r) =>
      String(r.datname),
    );
  } finally {
    await c.end();
  }
}
async function snapshots(
  state: any,
  ids: string[],
  names: string[],
  databaseName = localDatabase().database,
) {
  const c = new pg.Client({ ...localDatabase(), database: databaseName });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(typeof state.own_snapshot_timezone, 'string');
    await c.query("SELECT set_config('TimeZone',$1,true)", [state.own_snapshot_timezone]);
    const result: Record<string, string> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const column = name === 'tenants' ? 'id' : 'tenant_id';
      result[name] = digest(
        (
          await c.query(
            `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${column}=ANY($1::uuid[]) ORDER BY 1`,
            [ids],
          )
        ).rows,
      );
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.end();
  }
}
const ownSnapshot = (state: any, databaseName?: string) =>
  snapshots(state, [state.tenant], state.own_names, databaseName);
async function preservePrevious(state: any) {
  assert.deepEqual(
    await snapshots(state, state.ids, state.names),
    state.before,
    'Earlier firms must match their accepted baseline',
  );
  assert.equal(
    digest(
      (
        await pool.query(
          'SELECT id,email,name,password_hash FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
          [state.user_ids],
        )
      ).rows,
    ),
    state.users_hash,
    'Earlier users must match their accepted baseline',
  );
}
const byId = (rows: any[]) => new Map<string, any>(rows.map((r) => [String(r.id), r]));
const itemSnapshot = (rows: any[]) =>
  rows
    .map((r) => ({
      id: r.id,
      product_id: r.product_id,
      sku: r.sku,
      name: r.name,
      quantity: r.quantity,
      price: r.price,
      vat: r.vat,
      components: r.components,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

try {
  const stat = await lstat(statePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.ui_verified, true, 'Require final UI acceptance before recovery');
  assert(
    state.tenant && state.runtime_revision && Array.isArray(state.own_names) && state.own_snapshot,
  );
  assert(Array.isArray(state.products) && state.products.length === 2);
  assert(Array.isArray(state.current_products) && state.current_products.length === 2);
  assert(Array.isArray(state.aliases) && state.aliases.length === 5);
  assert(Array.isArray(state.orders) && state.orders.length === 3);
  assert(Array.isArray(state.ids) && Array.isArray(state.names) && Array.isArray(state.user_ids));
  for (const table of [
    ...evidenceTables,
    'products',
    'product_sku_aliases',
    'product_logistics',
    'catalog_imports',
    'picking_waves',
    'picking_wave_orders',
    'picking_wave_scans',
    'orders',
    'order_items',
    'order_pick_items',
    'jobs',
    'audit_events',
    'outbound_events',
    'outbound_deliveries',
    'email_messages',
    'sms_messages',
  ])
    assert(
      state.own_names.includes(table) && state.own_snapshot[table],
      'Missing accepted snapshot ' + table,
    );
  const live = 'http://127.0.0.1:4100/api';
  const healthResponse = await fetch(live + '/health');
  assert.equal(healthResponse.status, 200);
  const health = (await healthResponse.json()) as any;
  assert.equal(health.schema_revision, schema);
  assert(health.product_sku_edit_available && health.catalog_bulk_edit_available);
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  assert.equal(
    health.revision,
    state.runtime_revision,
    'Source runtime must match accepted SKU state',
  );
  if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
  process.env.APP_REVISION = health.revision;
  const before = await ownSnapshot(state);
  assert.deepEqual(before, state.own_snapshot, 'Source must match final UI snapshot');
  await preservePrevious(state);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')",
        [state.tenant],
      )
    ).rows[0].n,
    0,
    'Own jobs must be terminal',
  );
  for (const table of ['outbound_events', 'outbound_deliveries', 'email_messages', 'sms_messages'])
    assert.equal(
      (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [state.tenant]))
        .rows[0].n,
      0,
      'No provider effects in accepted own firm',
    );
  priorDatabases = await databaseNames();
  const expectedProducts = (
    await pool.query(
      'SELECT id,sku,version,name,price,vat FROM products WHERE tenant_id=$1 ORDER BY id',
      [state.tenant],
    )
  ).rows;
  assert.equal(expectedProducts.length, 2);
  const accepted = byId(state.current_products);
  for (const p of expectedProducts) {
    const saved = accepted.get(p.id);
    assert(saved);
    for (const key of ['sku', 'version', 'name', 'price', 'vat']) assert.equal(p[key], saved[key]);
  }
  const expectedById = byId(expectedProducts);
  const expectedAliases = (
    await pool.query(
      'SELECT sku,product_id FROM product_sku_aliases WHERE tenant_id=$1 ORDER BY sku',
      [state.tenant],
    )
  ).rows;
  assert.deepEqual(expectedAliases, state.aliases);
  for (const alias of expectedAliases) assert(expectedById.has(alias.product_id));
  for (const p of expectedProducts)
    assert(expectedAliases.some((a) => a.sku === p.sku && a.product_id === p.id));
  const expectedOrders = (
    await pool.query(
      'SELECT id,number,status,payment_mode,currency,total FROM orders WHERE tenant_id=$1 ORDER BY id',
      [state.tenant],
    )
  ).rows;
  assert.deepEqual(
    new Set(expectedOrders.map((o) => o.id)),
    new Set(state.orders.map((o: any) => o.id)),
  );
  const expectedOrderItems = new Map<string, any[]>();
  for (const o of expectedOrders)
    expectedOrderItems.set(
      o.id,
      itemSnapshot(
        (
          await pool.query(
            'SELECT * FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY id',
            [state.tenant, o.id],
          )
        ).rows,
      ),
    );
  const expectedWaves = (
    await pool.query(
      'SELECT id,name,state,version,warehouse_id FROM picking_waves WHERE tenant_id=$1 ORDER BY id LIMIT 101',
      [state.tenant],
    )
  ).rows;
  assert(expectedWaves.length <= 100, 'Bound own wave proof');
  const expectedCandidates = (
    await pool.query(
      `SELECT o.id FROM orders o WHERE o.tenant_id=$1 AND o.warehouse_id=$2
       AND (o.status IN ('paid','picking') OR (o.status='new' AND o.payment_mode='cod'))
       AND NOT EXISTS(SELECT 1 FROM picking_wave_orders w WHERE w.tenant_id=o.tenant_id AND w.order_id=o.id AND w.active)
       AND EXISTS(SELECT 1 FROM reservations r WHERE r.tenant_id=o.tenant_id AND r.order_id=o.id AND r.state='active')
       AND EXISTS(SELECT 1 FROM order_pick_items i WHERE i.tenant_id=o.tenant_id AND i.order_id=o.id AND i.scanned<i.quantity)
       ORDER BY o.id`,
      [state.tenant, state.warehouse],
    )
  ).rows;
  const histories = (
    await pool.query(
      'SELECT e.id,e.preview_id,e.scope_hash,e.state,p.scope_hash AS preview_scope_hash FROM catalog_bulk_edit_executions e JOIN catalog_bulk_edit_previews p ON (p.tenant_id,p.id)=(e.tenant_id,e.preview_id) WHERE e.tenant_id=$1 ORDER BY e.id LIMIT 101',
      [state.tenant],
    )
  ).rows;
  assert(
    histories.length > 0 && histories.length <= 100,
    'Require bounded actual accepted sheet history',
  );
  assert(histories.every((h) => h.state === 'done' && h.scope_hash === h.preview_scope_hash));
  const port = Number(process.env.DYNA_PREVIEW_PORT ?? 4102);
  assert(Number.isInteger(port) && port >= 4101 && port <= 4199);
  let occupied = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    occupied = true;
  } catch {}
  assert(!occupied, 'Preview port occupied');
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, { directory: 'data/product-sku-106-restore' });
  const createdDatabase = restoreDatabaseName(restored.database);
  assert(!priorDatabases.includes(createdDatabase), 'Never remove a pre-existing database');
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
  let migrations = 0,
    foreign = '';
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
    assert.deepEqual(
      (
        await client.query(
          'SELECT sku,product_id FROM product_sku_aliases WHERE tenant_id=$1 ORDER BY sku',
          [state.tenant],
        )
      ).rows,
      expectedAliases,
    );
    for (const table of ['product_sku_aliases', ...evidenceTables]) {
      const rls = (
        await client.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(rls.relrowsecurity && rls.relforcerowsecurity);
      assert(
        (
          await client.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
            state.tenant,
          ])
        ).rows[0].n > 0,
      );
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
      for (const sql of [
        `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1`,
        `DELETE FROM ${table} WHERE tenant_id=$1`,
      ]) {
        await client.query('BEGIN');
        try {
          await assert.rejects(client.query(sql, [state.tenant]), /immutable/i);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    }
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE dyna_app');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [state.tenant]);
      assert.equal(
        (
          await client.query(
            "SELECT has_table_privilege(current_user,'public.product_sku_aliases','INSERT,UPDATE,DELETE') permitted",
          )
        ).rows[0].permitted,
        false,
      );
    } finally {
      await client.query('ROLLBACK');
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
        assert(h.restore_preview && h.product_sku_edit_available && h.catalog_bulk_edit_available);
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
  const readPaths: string[] = [];
  async function read(path: string) {
    const r = await req(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
    readPaths.push(path);
    return r.json() as Promise<any>;
  }
  const sheetRead = async (path: string) => {
    const result = await read(path);
    assert(result.available && result.read_only);
    assert.equal(result.can_write, false);
    assert.equal(result.can_read, true);
    assert.equal(result.current_role, 'admin');
    return result;
  };
  const metadata = await sheetRead('/catalog-bulk-edit');
  assert.equal(metadata.product_sku_edit_available, true);
  const selection = await sheetRead(
    '/catalog-bulk-edit/selection?ids=' + expectedProducts.map((p) => p.id).join(','),
  );
  assert.equal(selection.product_sku_edit_available, true);
  assert.deepEqual(
    new Set(selection.data.map((p: any) => p.id)),
    new Set(expectedProducts.map((p) => p.id)),
  );
  for (const p of selection.data) {
    assert.equal(p.sku, expectedById.get(p.id).sku);
    assert.equal(p.version, expectedById.get(p.id).version);
    assert.equal(p.product_sku_edit_available, true);
  }
  await sheetRead('/catalog-bulk-edit/executions');
  for (const h of histories) {
    assert.equal(
      (await sheetRead('/catalog-bulk-edit/previews/' + h.preview_id)).preview.scope_hash,
      h.preview_scope_hash,
    );
    await sheetRead('/catalog-bulk-edit/previews/' + h.preview_id + '/rows');
    const execution = (await sheetRead('/catalog-bulk-edit/executions/' + h.id)).execution;
    assert.equal(execution.state, 'done');
    assert.equal(execution.preview_id, h.preview_id);
    assert.equal(execution.scope_hash, h.scope_hash);
    await sheetRead('/catalog-bulk-edit/executions/' + h.id + '/rows');
  }
  for (const p of expectedProducts) {
    const current = await read('/products/' + p.id);
    assert.equal(current.id, p.id);
    assert.equal(current.product_sku_edit_available, true);
    for (const key of ['sku', 'version', 'name', 'price', 'vat'])
      assert.equal(current[key], p[key]);
  }
  for (const o of expectedOrders) {
    const current = await read('/orders/' + o.id);
    for (const key of ['id', 'number', 'status', 'payment_mode', 'currency', 'total'])
      assert.equal(current[key], o[key]);
    assert.deepEqual(itemSnapshot(current.items), expectedOrderItems.get(o.id));
  }
  const waves = await read('/picking-waves?state=all&limit=100');
  assert.deepEqual(
    new Set(waves.data.map((w: any) => w.id)),
    new Set(expectedWaves.map((w) => w.id)),
  );
  const candidates = await read('/picking-waves/candidates?warehouse_id=' + state.warehouse);
  assert.deepEqual(
    new Set(candidates.data.map((o: any) => o.id)),
    new Set(expectedCandidates.map((o) => o.id)),
  );
  for (const w of expectedWaves) {
    const current = (await read('/picking-waves/' + w.id)).wave;
    for (const key of ['id', 'name', 'state', 'version', 'warehouse_id'])
      assert.equal(current[key], w[key]);
  }
  const writes: [string, string][] = [
    ['/products/' + expectedProducts[0].id, 'PATCH'],
    ['/catalog-bulk-edit/previews', 'POST'],
    ['/catalog-bulk-edit/previews/' + histories[0].preview_id + '/execute', 'POST'],
    ['/catalog/imports/preview', 'POST'],
    ['/orders/' + expectedOrders[0].id + '/scan', 'POST'],
    ['/picking-waves/preview', 'POST'],
    ['/picking-waves', 'POST'],
    ...(expectedWaves.length
      ? [['/picking-waves/' + expectedWaves[0].id + '/scans', 'POST'] as [string, string]]
      : []),
  ];
  for (const [path, method] of writes)
    assert.equal((await req(path, method, { invalid: true })).status, 423, path);
  assert.equal((await req('/catalog-bulk-edit', 'GET', undefined, foreign)).status, 409);
  assert.equal((await fetch(live + '/catalog-bulk-edit', { headers: { cookie } })).status, 401);
  assert.deepEqual(await ownSnapshot(state, database), before);
  assert.deepEqual(await ownSnapshot(state), before);
  await preservePrevious(state);
  report = {
    stage: 106,
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
    own_products_verified: expectedProducts.length,
    own_aliases_verified: expectedAliases.length,
    own_orders_verified: expectedOrders.length,
    own_wave_details_verified: expectedWaves.length,
    own_sheet_executions_verified: histories.length,
    protected_prior_firms: state.ids.length,
    protected_prior_users: state.user_ids.length,
    prior_fingerprints_verified: state.names.length,
    protected_existing_databases: priorDatabases.length,
    own_business_fingerprints: Object.keys(before).length,
    force_RLS_verified: true,
    foreign_aliases_hidden: true,
    aliases_immutable: true,
    direct_alias_DML_denied: true,
    sheet_evidence_immutable: true,
    preview_read_paths: readPaths.length,
    preview_mutation_statuses: writes.map(() => 423),
    workspace_mismatch_status: 409,
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    external_provider_verified: false,
    goal_complete: false,
  };
} finally {
  try {
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
  } finally {
    await pool.end();
    if (priorDatabases)
      assert.deepEqual(
        await databaseNames(),
        priorDatabases,
        'All prior databases preserved, including failure cleanup',
      );
  }
}
assert(report && priorDatabases);
report.preview_database_removed = true;
report.pre_existing_databases_preserved = true;
report.own_preview_process_stopped = true;
await writeFile('docs/product-sku-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log({
  stage: 106,
  tables: report.restore_tables,
  migrations: report.migrations,
  encrypted: report.encrypted_records_verified,
  products: report.own_products_verified,
  aliases: report.own_aliases_verified,
  orders: report.own_orders_verified,
  reads: report.preview_read_paths,
  writes423: report.preview_mutation_statuses.length,
  cleanup: true,
});
