/** QA111 actual restore, run only by the coordinator after API/UI/restart acceptance. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { pool } from '../server/db';
import { verifyWmsLotsPreservation } from './wms-lots-preservation-gate';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
  manifestSchema,
  tableFingerprints,
  schemaFingerprint,
} from '../server/recovery';

type Json = Record<string, any>;
type Digest = { count: number; sha256: string };
const statePath = 'data/wms-lots-stage111.json';
const baselinePath = 'data/wms-lots-stage111-baseline.json';
const schema = '091_wms_lot_packing';
const port = 4151;
const wmsTables = [
  'wms_policies',
  'wms_operations',
  'wms_previews',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
];
const requiredTables = [
  'products',
  'product_sku_aliases',
  'product_logistics',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'stock_location_operations',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'warehouse_documents',
  'warehouse_document_lines',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'return_cases',
  'return_items',
  'payment_entries',
  'order_local_financial_fences',
  'shipping_plans',
  'shipments',
  'documents',
  'order_events',
  'audit_events',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
  ...wmsTables,
];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const rowDigest = (rows: unknown[]): Digest => ({
  count: rows.length,
  sha256: sha(JSON.stringify(rows)),
});
let child: ReturnType<typeof spawn> | undefined;
let ownedDatabase: string | undefined;
let priorDatabases: string[] | undefined;
let report: Json | undefined;

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
async function ownSnapshot(state: Json, database = localDatabase().database, skipSessions = false) {
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SELECT set_config('TimeZone',$1,true)", [state.own_snapshot_timezone]);
    const result: Record<string, Digest> = {};
    for (const name of state.own_names as string[]) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      if (skipSessions && name === 'sessions') continue;
      result[name] = rowDigest(
        (
          await c.query(
            `SELECT to_jsonb(t) row FROM "${name}" t
        WHERE ${['tenants', 'users'].includes(name) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
            [name === 'users' ? state.user : state.tenant],
          )
        ).rows,
      );
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
function expectedSnapshot(state: Json, skipSessions = false) {
  return Object.fromEntries(
    Object.entries(state.own_snapshot).filter(([name]) => !skipSessions || name !== 'sessions'),
  );
}
async function portIsFree() {
  // Detect any TCP listener, including a non-HTTP process. Never kill or adopt it.
  const listener = createServer();
  try {
    await new Promise<void>((done, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', () => done());
    });
  } finally {
    if (listener.listening) await new Promise<void>((done) => listener.close(() => done()));
  }
}
const withoutSessions = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'sessions'));

try {
  const stat = await lstat(statePath);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600,
    'Private accepted state required',
  );
  const state: Json = JSON.parse(await readFile(statePath, 'utf8'));
  const baselineRaw = await readFile(baselinePath, 'utf8');
  const baseline: Json = JSON.parse(baselineRaw);
  assert.equal(baseline.firms.length, 104);
  assert.equal(baseline.users.length, 88);
  assert.equal(baseline.databases.length, 17);
  assert.equal(state.ui_verified, true, 'Actual UI acceptance must precede restore');
  assert.equal(state.restart_verified, true, 'Actual complete restart must precede restore');
  assert(
    state.api_acceptance &&
      (state.api_acceptance === true || state.api_acceptance.status === 'PASS'),
  );
  assert.equal(state.preservation?.status, 'PASS');
  assert.equal(
    state.preservation.originalsha256,
    sha(baselineRaw),
    'Original baseline must never be rebased',
  );
  assert.equal(state.schema, schema);
  assert.equal(state.own_snapshot_timezone, 'UTC');
  assert.match(state.runtime_revision, /^[a-f0-9]{7,40}$/);
  assert(
    typeof state.email === 'string' &&
      typeof state.password === 'string' &&
      state.user &&
      state.tenant,
  );
  assert(
    Array.isArray(state.own_names) && new Set(state.own_names).size === state.own_names.length,
  );
  assert.deepEqual(Object.keys(state.own_snapshot).sort(), [...state.own_names].sort());
  for (const name of requiredTables) {
    assert(state.own_names.includes(name), 'Missing accepted checkpoint table: ' + name);
    assert(Number.isInteger(state.own_snapshot[name].count));
    assert.match(state.own_snapshot[name].sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(
    await ownSnapshot(state),
    state.own_snapshot,
    'Accepted own source state must remain exact',
  );
  const healthResponse = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(healthResponse.status, 200);
  const health: Json = await healthResponse.json();
  assert.equal(health.schema_revision, schema);
  assert.equal(health.revision, state.runtime_revision);
  assert(health.wms_lots_available && !health.restore_preview);
  priorDatabases = await databaseNames();
  for (const name of baseline.databases)
    assert(priorDatabases.includes(name), 'Original database absent');
  await portIsFree();
  const preservationBeforeBackup = await verifyWmsLotsPreservation(state.preservation.originalsha256);
  assert.equal(preservationBeforeBackup.status, 'PASS', 'Earlier firms must pass a fresh gate before backup');
  process.env.APP_REVISION = state.runtime_revision;
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, { directory: 'data/wms-lots-111-restore' });
  const fresh = restoreDatabaseName(restored.database);
  assert(!priorDatabases.includes(fresh), 'Never adopt an existing database for cleanup');
  ownedDatabase = fresh;
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  assert.equal(restored.revision, state.runtime_revision);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8')),
  );
  assert.deepEqual(
    await ownSnapshot(state, fresh),
    state.own_snapshot,
    'Restored accepted state must remain exact',
  );
  const c = new pg.Client({ ...localDatabase(), database: fresh });
  await c.connect();
  let migrations = 0,
    immutableChecks = 0,
    sourceFkChecks = 0;
  let originalSessions: Json[] = [],
    operations: Json[] = [],
    previews: Json[] = [],
    lots: Json[] = [],
    orders: Json[] = [];
  let purchaseId = '',
    returnId = '',
    documentId = '';
  const counts: Record<string, number> = {};
  try {
    await c.query("SET TIME ZONE 'UTC'");
    assert.deepEqual(await tableFingerprints(c), manifest.tables);
    assert.equal(
      await schemaFingerprint(c, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
    const ms = (await c.query('SELECT name FROM migrations ORDER BY name')).rows;
    migrations = ms.length;
    assert.equal(ms.at(-1)?.name, schema);
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')",
          [state.tenant],
        )
      ).rows[0].n,
      0,
      'Accepted own jobs must be terminal',
    );
    originalSessions = (
      await c.query('SELECT to_jsonb(s) row FROM sessions s WHERE tenant_id=$1 ORDER BY 1', [
        state.tenant,
      ])
    ).rows;
    operations = (
      await c.query('SELECT * FROM wms_operations WHERE tenant_id=$1 ORDER BY id', [state.tenant])
    ).rows;
    previews = (
      await c.query('SELECT * FROM wms_previews WHERE tenant_id=$1 ORDER BY id', [state.tenant])
    ).rows;
    lots = (await c.query('SELECT id FROM wms_lots WHERE tenant_id=$1 ORDER BY id', [state.tenant]))
      .rows;
    orders = (await c.query('SELECT id FROM orders WHERE tenant_id=$1 ORDER BY id', [state.tenant]))
      .rows;
    purchaseId = (
      await c.query('SELECT id FROM purchase_orders WHERE tenant_id=$1 ORDER BY id LIMIT 1', [
        state.tenant,
      ])
    ).rows[0]?.id;
    returnId = (
      await c.query('SELECT id FROM return_cases WHERE tenant_id=$1 ORDER BY id LIMIT 1', [
        state.tenant,
      ])
    ).rows[0]?.id;
    documentId = (
      await c.query('SELECT id FROM warehouse_documents WHERE tenant_id=$1 ORDER BY id LIMIT 1', [
        state.tenant,
      ])
    ).rows[0]?.id;
    assert(
      purchaseId && returnId && documentId,
      'Actual PO/PZ/return sources must survive restore',
    );
    assert(
      operations.some((o) => o.kind === 'opening') && operations.some((o) => o.kind === 'receipt'),
    );
    assert(
      operations.some((o) => o.kind === 'dispatch') && operations.some((o) => o.kind === 'return'),
    );
    for (const table of wmsTables) {
      const flags = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(flags.relrowsecurity && flags.relforcerowsecurity, table);
      counts[table] = (
        await c.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [state.tenant])
      ).rows[0].n;
      assert(counts[table] > 0, 'Full accepted lifecycle must populate ' + table);
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE dyna_app');
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [baseline.firms[0]]);
        assert.equal(
          (
            await c.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          0,
        );
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [state.tenant]);
        assert.equal(
          (
            await c.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          counts[table],
        );
      } finally {
        await c.query('ROLLBACK');
      }
      const probes = [`DELETE FROM "${table}" WHERE tenant_id=$1`];
      if (!['wms_layer_positions', 'wms_reservation_layers'].includes(table))
        probes.push(`UPDATE "${table}" SET tenant_id=tenant_id WHERE tenant_id=$1`);
      for (const sql of probes) {
        await c.query('BEGIN');
        try {
          await assert.rejects(
            c.query(sql, [state.tenant]),
            (error: any) => error.code === '23514',
          );
          immutableChecks++;
        } finally {
          await c.query('ROLLBACK');
        }
      }
    }
    const foreignProduct = (
      await c.query('SELECT id FROM products WHERE tenant_id<>$1 ORDER BY id LIMIT 1', [
        state.tenant,
      ])
    ).rows[0];
    assert(foreignProduct, 'A genuine earlier foreign product is needed for composite FK proof');
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [state.tenant]);
      await assert.rejects(
        c.query(
          `INSERT INTO wms_lots(id,tenant_id,product_id,operation_id,lot_code,origin)
        VALUES($1,$2,$3,$4,'FOREIGN-SOURCE-PROBE','opening')`,
          [
            randomUUID(),
            state.tenant,
            foreignProduct.id,
            operations.find((o) => o.kind === 'opening')!.id,
          ],
        ),
        (error: any) => error.code === '23503',
      );
      sourceFkChecks++;
    } finally {
      await c.query('ROLLBACK');
    }
    assert.deepEqual(
      await tableFingerprints(c),
      manifest.tables,
      'Rolled-back probes must preserve every row',
    );
  } finally {
    await c.end();
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
  for (let n = 0; n < 80; n++) {
    let h: Json | undefined;
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (r.ok) h = await r.json();
    } catch {}
    if (h) {
      assert(h.restore_preview && h.wms_lots_available);
      assert.equal(h.schema_revision, schema);
      assert.equal(h.revision, state.runtime_revision);
      ready = true;
      break;
    }
    assert(child.exitCode === null && child.signalCode === null, 'Owned preview exited');
    await setTimeout(200);
  }
  assert(ready, 'Owned preview failed readiness');
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  });
  assert.equal(login.status, 200);
  assert(login.headers.get('set-cookie'));
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const req = (path: string, method = 'GET', body?: string, workspace = state.tenant) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', 'X-Workspace-Id': workspace },
      body,
      signal: AbortSignal.timeout(10000),
    });
  let getCount = 0,
    pageCount = 0;
  async function read(path: string): Promise<Json> {
    const r = await req(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const raw = await r.text();
    assert(Buffer.byteLength(raw, 'utf8') <= 5 * 1024 * 1024);
    const result: Json = JSON.parse(raw);
    assert(result.available && result.read_only && result.can_read);
    for (const [key, value] of Object.entries(result))
      if (key.startsWith('can_') && !['can_read', 'can_read_value'].includes(key))
        assert.equal(value, false, key);
    getCount++;
    return result;
  }
  async function pages(path: string) {
    const rows: Json[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const r = await read(
        path +
          (cursor ? (path.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor) : ''),
      );
      assert(Array.isArray(r.data) && r.data.length <= 50);
      rows.push(...r.data);
      pageCount++;
      cursor = r.meta.cursor;
      assert(cursor === null || typeof cursor === 'string');
      if (cursor) {
        assert(!cursors.has(cursor));
        cursors.add(cursor);
      }
      assert(pageCount <= 10000, 'Pagination must remain bounded');
    } while (cursor);
    return rows;
  }
  assert((await read('/wms-lots')).policy.enabled);
  await pages('/wms-lots/opening-scope');
  await pages('/wms-lots/positions');
  await read('/wms-lots/valuation');
  const history = await pages('/wms-lots/operations');
  assert.deepEqual(history.map((r) => r.id).sort(), operations.map((r) => r.id).sort());
  for (const operation of operations) {
    const d = await read('/wms-lots/operations/' + operation.id);
    assert.equal(d.operation.id, operation.id);
    assert.equal(d.operation.kind, operation.kind);
    assert.deepEqual(d.request, operation.request);
    assert.deepEqual(d.result, operation.result);
  }
  for (const p of previews) {
    const prefix = p.kind === 'opening' ? 'opening-previews' : 'movement-previews';
    const d = await read('/wms-lots/' + prefix + '/' + p.id);
    assert.equal(d.preview.scope_hash, p.scope_hash);
    const rows = await pages('/wms-lots/' + prefix + '/' + p.id + '/rows');
    assert.deepEqual(rows, p.snapshot.rows ?? p.snapshot.fragments);
  }
  for (const lot of lots) await pages('/wms-lots/lots/' + lot.id + '/trace');
  for (const order of orders) {
    await pages('/wms-lots/orders/' + order.id + '/allocations');
    await pages('/wms-lots/orders/' + order.id + '/return-fragments');
  }
  const openingId = previews.find((p) => p.kind === 'opening')!.id;
  const movementId = previews.find((p) => p.kind !== 'opening')?.id;
  assert(movementId, 'Accepted lifecycle must contain a real movement preview');
  const writes = [
    '/wms-lots/opening-previews',
    '/wms-lots/opening-previews/' + openingId + '/activate',
    '/wms-lots/receipts',
    '/wms-lots/movement-previews',
    '/wms-lots/movement-previews/' + movementId + '/execute',
    '/purchase-orders/' + purchaseId + '/receive',
    '/returns/' + returnId + '/receive',
    '/warehouse-documents/' + documentId + '/post',
  ];
  for (const path of writes) assert.equal((await req(path, 'POST', '{')).status, 423, path);
  assert.equal((await req('/wms-lots', 'GET', undefined, baseline.firms[0])).status, 409);
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/wms-lots', { headers: { cookie } })).status,
    401,
  );
  assert.deepEqual(await ownSnapshot(state, fresh, true), expectedSnapshot(state, true));
  const check = new pg.Client({ ...localDatabase(), database: fresh });
  await check.connect();
  try {
    await check.query("SET TIME ZONE 'UTC'");
    const sessions: Json[] = (
      await check.query('SELECT to_jsonb(s) row FROM sessions s WHERE tenant_id=$1 ORDER BY 1', [
        state.tenant,
      ])
    ).rows;
    assert.equal(sessions.length, originalSessions.length + 1);
    const oldTokens = new Set(originalSessions.map((r) => r.row.token_hash));
    assert.deepEqual(
      sessions.filter((r) => oldTokens.has(r.row.token_hash)),
      originalSessions,
    );
    assert.equal(sessions.find((r) => !oldTokens.has(r.row.token_hash))?.row.user_id, state.user);
    assert.deepEqual(
      withoutSessions(await tableFingerprints(check)),
      withoutSessions(manifest.tables),
    );
    assert.equal(
      await schemaFingerprint(check, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
  } finally {
    await check.end();
  }
  assert.deepEqual(
    await ownSnapshot(state),
    state.own_snapshot,
    'Source must remain exact after restore QA',
  );
  assert.equal(sha(await readFile(baselinePath, 'utf8')), state.preservation.originalsha256);
  report = {
    stage: 111,
    status: 'PASS',
    revision: state.runtime_revision,
    schema,
    backup_id: backup.id,
    tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    all_manifest_rows_and_schema_exact_before_preview: true,
    all_other_manifest_tables_exact_after_preview: true,
    own_snapshot_tables_exact: state.own_names.length,
    own_snapshot_normalized: false,
    force_rls_tables: wmsTables.length,
    wms_table_counts: counts,
    immutable_checks: immutableChecks,
    genuine_foreign_source_fk_checks: sourceFkChecks,
    operation_results_exact: operations.length,
    preview_rows_exact: previews.length,
    paged_responses: pageCount,
    readonly_gets: getCount,
    writes423: writes.length,
    copy_authentication_session_added: 1,
    copied_prior_sessions_exact: true,
    worker_enabled: false,
    provider_verified: false,
    goal_complete: false,
    original_baseline_databases_preserved: 17,
    original_baseline_file_unchanged: true,
    preservation_before_backup: preservationBeforeBackup,
    source_snapshot_exact_after_restore: true,
  };
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => child!.once('exit', () => done()));
    child.kill('SIGTERM');
    if (!(await Promise.race([exited.then(() => true), setTimeout(10000).then(() => false)]))) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  try {
    if (ownedDatabase) {
      assert(priorDatabases && !priorDatabases.includes(ownedDatabase));
      const c = new pg.Client({ ...localDatabase(), database: 'postgres' });
      await c.connect();
      try {
        await c.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
          [ownedDatabase],
        );
        await c.query('DROP DATABASE ' + restoreDatabaseName(ownedDatabase));
      } finally {
        await c.end();
      }
    }
  } finally {
    try {
      if (priorDatabases)
        assert.deepEqual(
          await databaseNames(),
          priorDatabases,
          'All earlier databases must remain exact even on failure',
        );
      if (report) {
        const preservationAfterCleanup = await verifyWmsLotsPreservation(
          report.preservation_before_backup.originalsha256,
        );
        assert.equal(preservationAfterCleanup.status, 'PASS', 'Earlier firms must pass after restore cleanup');
        report.preservation_after_cleanup = preservationAfterCleanup;
      }
    } finally {
      await pool.end();
    }
  }
}
assert(report);
report.owned_preview_and_database_removed = true;
await writeFile('docs/wms-lots-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
