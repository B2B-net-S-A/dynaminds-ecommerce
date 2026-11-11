/** QA110 backup/restore proof. Run explicitly by the root; cleanup owns only its fresh copy. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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

type Json = Record<string, any>;
const state: Json = JSON.parse(await readFile('data/packing-workstation-stage110.json', 'utf8'));
const baseline: Json = JSON.parse(
  await readFile('data/packing-workstation-stage110-baseline.json', 'utf8'),
);
const native: Json = JSON.parse(await readFile('docs/packing-workstation-native-qa.json', 'utf8'));
const schema = '089_packing_workstation';
const port = 4150;
const packingTables = [
  'packing_stations',
  'packing_cartons',
  'packing_policies',
  'packing_sessions',
  'packing_operations',
  'packing_previews',
  'packing_receipts',
  'order_packing_profiles',
];
const checkpointTables = [
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'products',
  'product_logistics',
  'shipping_plans',
  'shipments',
  'documents',
  'payment_entries',
  ...packingTables,
];
const effectTables = [
  'jobs',
  'order_events',
  'audit_events',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
  'order_local_financial_fences',
];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let child: ReturnType<typeof spawn> | undefined;
let database: string | undefined;
let prior: string[] = [];
let report: Json | undefined;

async function databaseNames() {
  const c = new pg.Client({ ...localDatabase(), database: 'postgres' });
  await c.connect();
  try {
    return (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname as string,
    );
  } finally {
    await c.end();
  }
}
async function ownSnapshot(tables: string[], db = localDatabase().database) {
  const c = new pg.Client({ ...localDatabase(), database: db });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Record<string, string> = {};
    for (const table of tables) {
      assert(/^[a-z][a-z0-9_]*$/.test(table));
      result[table] = hash(
        (
          await c.query(`SELECT to_jsonb(t) row FROM "${table}" t WHERE tenant_id=$1 ORDER BY 1`, [
            state.tenant,
          ])
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
async function exactCheckpoints(db = localDatabase().database) {
  assert.deepEqual(
    await ownSnapshot(checkpointTables, db),
    state.checkpoint,
    'Original23 checkpoint must remain exact; no normalization or rebase',
  );
  assert.deepEqual(
    await ownSnapshot(effectTables, db),
    state.effects_checkpoint,
    'Effects checkpoint must remain exact; no normalization or rebase',
  );
}
function noPrivateLease(value: unknown) {
  if (Array.isArray(value)) return value.forEach(noPrivateLease);
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert(
        !['lease_token', 'lease_token_hash', 'token_hash'].includes(key),
        'A public packing response must not contain private lease credentials',
      );
      noPrivateLease(item);
    }
  }
}

try {
  const liveResponse = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(liveResponse.status, 200);
  const health: Json = await liveResponse.json();
  assert.equal(health.schema_revision, schema);
  assert(health.packing_workstation_available && !health.restore_preview);
  assert.equal(typeof health.revision, 'string');
  assert(health.revision.length > 0);
  assert(
    native.ui_verified && native.restart_verified,
    'Actual UI and full restart acceptance must precede recovery',
  );
  assert.equal(native.runtime_revision, health.revision);
  assert.deepEqual(native.preservation.untraced_mismatches, []);
  assert(state.api_receipt?.id && state.ui_receipt?.id && state.ui_session_id && state.ui_plan_id);
  assert.equal(new Set(checkpointTables).size, 23);
  assert.deepEqual(Object.keys(state.checkpoint).sort(), [...checkpointTables].sort());
  assert.deepEqual([...state.effects_names].sort(), [...effectTables].sort());
  assert.deepEqual(Object.keys(state.effects_checkpoint).sort(), [...effectTables].sort());
  await exactCheckpoints();
  prior = await databaseNames();
  for (const name of baseline.databases) assert(prior.includes(name), 'Previous database absent');
  process.env.APP_REVISION = health.revision;
  let occupied = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    occupied = true;
  } catch {}
  assert(!occupied, 'Restore preview port is already occupied');
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/packing-workstation-110-restore',
  });
  const fresh = restoreDatabaseName(restored.database);
  assert(!prior.includes(fresh), 'Never adopt an existing database for cleanup');
  database = fresh;
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  assert.equal(restored.revision, health.revision);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8')),
  );
  await exactCheckpoints(database);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  let priorCopySessions: Json[] = [];
  let receipts: Json[] = [];
  let operations: Json[] = [];
  const packingCounts: Record<string, number> = {};
  let immutableChecks = 0;
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
      'Accepted own QA jobs must be terminal',
    );
    priorCopySessions = (
      await c.query('SELECT to_jsonb(s) row FROM sessions s WHERE tenant_id=$1 ORDER BY 1', [
        state.tenant,
      ])
    ).rows;
    receipts = (
      await c.query(
        `SELECT r.*,p.scope_hash,p.full_snapshot preview_snapshot,p.session_id,
        o.status order_status,o.version current_order_version,
        q.receipt_id current_receipt_id,q.revision current_profile_revision
       FROM packing_receipts r
       JOIN packing_previews p ON (p.tenant_id,p.id)=(r.tenant_id,r.preview_id)
       JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
       JOIN order_packing_profiles q ON (q.tenant_id,q.order_id)=(r.tenant_id,r.order_id)
       WHERE r.tenant_id=$1 ORDER BY r.id`,
        [state.tenant],
      )
    ).rows;
    assert.equal(receipts.length, 2);
    assert.deepEqual(
      receipts.map((r) => r.id).sort(),
      [state.api_receipt.id, state.ui_receipt.id].sort(),
    );
    await c.query("SELECT set_config('app.tenant_id',$1,false)", [state.tenant]);
    for (const receipt of receipts) {
      assert.deepEqual(receipt.full_snapshot, receipt.preview_snapshot);
      assert.equal(receipt.order_status, 'packed');
      assert.equal(String(receipt.current_order_version), receipt.after_order_version);
      assert.equal(receipt.current_receipt_id, receipt.id);
      assert.equal(receipt.current_profile_revision, receipt.profile_revision);
      assert.notEqual(receipt.before_fulfillment_hash, receipt.after_fulfillment_hash);
      assert.equal(
        (await c.query('SELECT packing_fulfillment_hash($1) h', [receipt.order_id])).rows[0].h,
        receipt.after_fulfillment_hash,
      );
      assert.equal(receipt.full_snapshot.fulfillment_hash, receipt.before_fulfillment_hash);
      assert(
        receipt.full_snapshot.fulfillment.physical.every((r: Json) => r.scanned === r.quantity),
      );
      assert(
        receipt.full_snapshot.fulfillment.allocations.every((r: Json) => r.scanned === r.quantity),
      );
    }
    operations = (
      await c.query(
        'SELECT id,client_key,kind,target_id,result FROM packing_operations WHERE tenant_id=$1 ORDER BY id',
        [state.tenant],
      )
    ).rows;
    assert(operations.length > 0);
    for (const table of packingTables) {
      const flags = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(flags.relrowsecurity && flags.relforcerowsecurity, table);
      packingCounts[table] = (
        await c.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [state.tenant])
      ).rows[0].n;
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE dyna_app');
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [baseline.ids[0]]);
        assert.equal(
          (
            await c.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          0,
          'Foreign tenant packing rows must be hidden',
        );
      } finally {
        await c.query('ROLLBACK');
      }
    }
    for (const table of ['packing_operations', 'packing_previews', 'packing_receipts']) {
      assert(packingCounts[table] > 0);
      for (const statement of [
        `UPDATE "${table}" SET tenant_id=tenant_id WHERE tenant_id=$1`,
        `DELETE FROM "${table}" WHERE tenant_id=$1`,
      ]) {
        await c.query('BEGIN');
        try {
          await assert.rejects(
            c.query(statement, [state.tenant]),
            (error: any) => error.code === '23514' && /niezmienny|nieusuwalna/i.test(error.message),
          );
          immutableChecks++;
        } finally {
          await c.query('ROLLBACK');
        }
      }
    }
    assert.deepEqual(
      await tableFingerprints(c),
      manifest.tables,
      'SQL isolation/immutability probes must not alter restored manifest rows',
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
      assert(h.restore_preview && h.packing_workstation_available);
      assert.equal(h.schema_revision, schema);
      assert.equal(h.revision, health.revision);
      ready = true;
      break;
    }
    assert(child.exitCode === null && child.signalCode === null, 'Own preview process exited');
    await setTimeout(200);
  }
  assert(ready, 'Own restored preview did not become ready');
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  });
  assert.equal(login.status, 200, 'Copy login status');
  assert(login.headers.get('set-cookie'));
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const req = (path: string, method = 'GET', rawBody?: string, workspace = state.tenant) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', 'X-Workspace-Id': workspace },
      body: rawBody,
    });
  const reads: string[] = [];
  let pagedResponses = 0;
  async function read(path: string): Promise<Json> {
    const response = await req(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    const raw = await response.text();
    assert(
      Buffer.byteLength(raw, 'utf8') <= 5 * 1024 * 1024,
      'Complete HTTP response exceeds 5 MiB',
    );
    const data: Json = JSON.parse(raw);
    assert(
      data.available && data.read_only && data.can_read && !data.can_write && !data.can_admin,
      path,
    );
    noPrivateLease(data);
    reads.push(path);
    return data;
  }
  async function pages(path: string) {
    const rows: Json[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await read(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      assert(Array.isArray(response.data) && response.data.length <= 50, path);
      rows.push(...response.data);
      pagedResponses++;
      cursor = response.meta.cursor;
      assert(cursor === null || typeof cursor === 'string');
      if (cursor) {
        assert(!seen.has(cursor), 'Pagination cursor repeated');
        seen.add(cursor);
      }
    } while (cursor);
    return rows;
  }
  await read('/packing');
  assert((await pages('/packing/stations')).some((r) => r.id === state.station.id));
  assert((await pages('/packing/cartons')).some((r) => r.id === state.carton.id));
  const candidates = await read('/packing/candidates?warehouse_id=' + state.warehouse);
  assert(
    !candidates.data.some((r: Json) => [state.api_order.id, state.ui_order.id].includes(r.id)),
  );
  const history = await pages('/packing/receipts');
  assert.equal(new Set(history.map((r) => r.id)).size, receipts.length);
  assert.deepEqual(history.map((r) => r.id).sort(), receipts.map((r) => r.id).sort());
  let itemRows = 0;
  let allocationRows = 0;
  for (const frozen of receipts) {
    const saved = frozen.id === state.api_receipt.id ? state.api_receipt : state.ui_receipt;
    const detail = await read('/packing/receipts/' + frozen.id);
    assert.deepEqual(
      detail.receipt,
      saved,
      'Full frozen receipt head must equal accepted native/UI head',
    );
    assert.deepEqual(detail.result, frozen.result);
    const historicHead = history.find((r) => r.id === frozen.id);
    assert.deepEqual(
      historicHead,
      detail.receipt,
      'History scope must equal complete receipt scope',
    );
    const p = await read('/packing/previews/' + frozen.preview_id);
    assert.equal(p.preview.scope_hash, detail.receipt.scope_hash);
    assert.deepEqual(p.snapshot_summary, detail.snapshot_summary);
    assert.deepEqual(detail.snapshot_summary.measurements, frozen.full_snapshot.measurements);
    assert.equal(
      detail.snapshot_summary.physical_count,
      frozen.full_snapshot.fulfillment.physical.length,
    );
    assert.equal(
      detail.snapshot_summary.allocation_count,
      frozen.full_snapshot.fulfillment.allocations.length,
    );
    const reference = new Map<string, Json>(
      (frozen.full_snapshot.reference?.items ?? []).map((r: Json) => [r.product_id, r]),
    );
    const expectedItems = frozen.full_snapshot.fulfillment.physical.map((r: Json) =>
      frozen.full_snapshot.reference ? { ...r, reference: reference.get(r.product_id) ?? null } : r,
    );
    const previewItems = await pages('/packing/previews/' + frozen.preview_id + '/items');
    const receiptItems = await pages('/packing/receipts/' + frozen.id + '/items');
    assert.deepEqual(previewItems, expectedItems);
    assert.deepEqual(receiptItems, expectedItems);
    const previewAllocations = await pages(
      '/packing/previews/' + frozen.preview_id + '/allocations',
    );
    const receiptAllocations = await pages('/packing/receipts/' + frozen.id + '/allocations');
    assert.deepEqual(previewAllocations, frozen.full_snapshot.fulfillment.allocations);
    assert.deepEqual(receiptAllocations, frozen.full_snapshot.fulfillment.allocations);
    itemRows += receiptItems.length;
    allocationRows += receiptAllocations.length;
    const profile = (await read('/packing/orders/' + frozen.order_id + '/profile')).profile;
    assert(profile.current);
    assert.equal(profile.receipt_id, frozen.id);
    assert.equal(profile.revision, frozen.profile_revision);
    assert.equal(profile.scope_hash, frozen.scope_hash);
    assert.deepEqual(profile.stale_reasons, []);
    const session = await read('/packing/sessions/' + frozen.session_id);
    assert.equal(session.session.state, 'finished');
    assert(!session.can_scan && !session.can_finish && !session.can_takeover);
    const physical = await pages('/packing/sessions/' + frozen.session_id + '/items');
    assert.deepEqual(
      physical.map(({ current_sku, current_ean, ...row }) => row),
      frozen.full_snapshot.fulfillment.physical,
    );
    assert.deepEqual(
      await pages('/packing/sessions/' + frozen.session_id + '/allocations'),
      frozen.full_snapshot.fulfillment.allocations,
    );
  }
  for (const operation of operations) {
    const d = await read('/packing/operations/' + operation.client_key);
    assert.equal(d.operation.id, operation.id);
    assert.equal(d.operation.kind, operation.kind);
    assert.deepEqual(d.operation.result, operation.result);
  }
  const shippingResponse = await req('/orders/' + state.ui_order.id + '/shipping');
  assert.equal(shippingResponse.status, 200);
  const shipping = ((await shippingResponse.json()) as Json).data;
  assert.equal(shipping.length, 1);
  const bound = shipping[0];
  assert.equal(bound.id, state.ui_plan_id);
  assert.equal(bound.state, 'ready');
  assert.equal(bound.simulation, 'true');
  assert.equal(bound.input.packing.receipt_id, state.ui_receipt.id);
  assert.equal(bound.input.packing_snapshot.receipt_id, state.ui_receipt.id);
  assert.equal(bound.input.receiver.first_name, 'QA110 Szkic');
  assert(!Object.hasOwn(bound.order_snapshot, 'packing'));
  assert.deepEqual(bound.payload.parcels, [
    {
      dimensions: { length: 380, width: 200, height: 100, unit: 'mm' },
      weight: { amount: 2.375, unit: 'kg' },
      is_non_standard: false,
    },
  ]);
  reads.push('/orders/' + state.ui_order.id + '/shipping');
  const writes: Array<[string, string]> = [
    ['POST', '/packing/sessions'],
    ['POST', '/packing/previews'],
    ['POST', '/packing/previews/' + state.api_receipt.preview_id + '/finish'],
    ['POST', '/packing/sessions/' + state.ui_session_id + '/scans'],
    ['PATCH', '/packing/policy'],
    ['PATCH', '/packing/stations/' + state.station.id],
    ['PATCH', '/packing/cartons/' + state.carton.id],
  ];
  for (const [method, path] of writes)
    assert.equal(
      (await req(path, method, '{')).status,
      423,
      'Readonly must reject before JSON parsing: ' + path,
    );
  assert.equal((await req('/packing', 'GET', undefined, baseline.ids[0])).status, 409);
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/packing', { headers: { cookie } })).status,
    401,
  );
  await exactCheckpoints(database);
  const check = new pg.Client({ ...localDatabase(), database });
  await check.connect();
  try {
    await check.query("SET TIME ZONE 'UTC'");
    const sessions: Json[] = (
      await check.query('SELECT to_jsonb(s) row FROM sessions s WHERE tenant_id=$1 ORDER BY 1', [
        state.tenant,
      ])
    ).rows;
    assert.equal(sessions.length, priorCopySessions.length + 1);
    const previous = new Set(priorCopySessions.map((s) => s.row.token_hash));
    assert.deepEqual(
      sessions.filter((s) => previous.has(s.row.token_hash)),
      priorCopySessions,
    );
    assert.equal(sessions.find((s) => !previous.has(s.row.token_hash))?.row.user_id, state.user);
    // Authentication is the only accepted row change in the complete restored manifest.
    const actual = await tableFingerprints(check);
    assert.deepEqual(
      Object.fromEntries(Object.entries(actual).filter(([name]) => name !== 'sessions')),
      Object.fromEntries(Object.entries(manifest.tables).filter(([name]) => name !== 'sessions')),
    );
    assert.equal(
      await schemaFingerprint(check, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
  } finally {
    await check.end();
  }
  await exactCheckpoints();
  report = {
    stage: 110,
    status: 'PASS',
    revision: health.revision,
    schema,
    backup_id: backup.id,
    tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    schema_and_all_rows_exact_before_preview: true,
    all_other_manifest_tables_exact_after_preview: true,
    own_checkpoint_tables_exact: checkpointTables.length,
    own_effects_tables_exact: effectTables.length,
    checkpoint_normalization: false,
    force_rls_tables: packingTables.length,
    packing_table_counts: packingCounts,
    immutable_checks: immutableChecks,
    immutable_receipt_verified: true,
    current_profiles_verified: receipts.length,
    frozen_receipts_verified: receipts.length,
    full_http_receipt_pages_verified: true,
    receipt_item_rows: itemRows,
    bound_shipping_plan_verified: true,
    receipt_allocation_rows: allocationRows,
    paged_responses: pagedResponses,
    operation_results_verified: operations.length,
    copy_authentication_session_added: 1,
    copied_prior_sessions_exact: true,
    read_paths: reads.length,
    writes423: writes.length,
    workspace_mismatch: 409,
    copy_cookie_on_live: 401,
    worker_enabled: false,
    provider_verified: false,
    goal_complete: false,
    prior_databases: prior.length,
    original_baseline_databases_preserved: baseline.databases.length,
  };
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise<void>((done) => child!.once('exit', () => done()));
    child.kill('SIGTERM');
    if (!(await Promise.race([ended.then(() => true), setTimeout(10000).then(() => false)]))) {
      child.kill('SIGKILL');
      await ended;
    }
  }
  if (database) {
    assert(!prior.includes(database), 'Cleanup must never target a previous database');
    const c = new pg.Client({ ...localDatabase(), database: 'postgres' });
    await c.connect();
    try {
      await c.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [database],
      );
      await c.query('DROP DATABASE ' + restoreDatabaseName(database));
    } finally {
      await c.end();
    }
  }
  await pool.end();
  if (prior.length)
    assert.deepEqual(await databaseNames(), prior, 'All previous database names must remain exact');
}
assert(report);
report.own_preview_removed = true;
await writeFile(
  'docs/packing-workstation-recovery-qa.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(report);
