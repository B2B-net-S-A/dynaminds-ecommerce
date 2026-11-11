/** QA112 actual restore, run only by the coordinator after final API/UI/restart acceptance. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { pool } from '../server/db';
import { verifyWmsStocktakesPreservation } from './wms-stocktakes-preservation';
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
const statePath = 'data/wms-stocktakes-stage112.json';
const baselinePath = 'data/wms-stocktakes-stage112-baseline.json';
const schema = '093_wms_validation_scopes';
const port = 4152;
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
const stocktakeTables = [
  'wms_stocktakes',
  'wms_stocktake_lines',
  'wms_stocktake_scope_layers',
  'wms_stocktake_measurements',
  'wms_stocktake_measurement_layers',
  'wms_stocktake_reviews',
  'wms_stocktake_review_rows',
  'wms_stocktake_postings',
];
const collector = 'wms_validation_scopes';
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
  'order_events',
  'audit_events',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
  ...wmsTables,
  ...stocktakeTables,
  collector,
];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const rowDigest = (rows: unknown[]): Digest => ({
  count: rows.length,
  sha256: sha(JSON.stringify(rows)),
});
let child: ReturnType<typeof spawn> | undefined;
let ownedDatabase: string | undefined;
let priorDatabases: string[] | undefined;
let report: Json | undefined;
let preservationExpectedHash: string | undefined;

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
  const baselineBytes = await readFile(baselinePath);
  const baselineHash = sha(baselineBytes);
  const baseline: Json = JSON.parse(baselineBytes.toString('utf8'));
  assert.equal(baseline.firms.length, 105);
  assert.equal(baseline.users.length, 89);
  assert.equal(baseline.databases.length, 17);
  assert.equal(state.ui_verified, true, 'Actual UI acceptance must precede restore');
  assert.equal(state.restart_verified, true, 'Actual complete restart must precede restore');
  assert(
    state.api_acceptance &&
      (state.api_acceptance === true || state.api_acceptance.status === 'PASS'),
  );
  assert.equal(state.schema, schema);
  assert.equal(state.own_snapshot_timezone, 'UTC');
  const expectedRevision = process.env.QA_EXPECTED_REVISION ?? state.runtime_revision;
  assert.match(expectedRevision, /^[a-f0-9]{7,40}$/);
  assert.equal(state.runtime_revision, expectedRevision, 'Accepted source revision must match');
  assert.equal(state.native_operator_ui_verified, true, 'Actual operator UI must precede restore');
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
  assert(health.wms_lots_available && health.wms_stocktakes_available && !health.restore_preview);
  priorDatabases = await databaseNames();
  for (const name of baseline.databases)
    assert(priorDatabases.includes(name), 'Original database absent');
  await portIsFree();
  const preservationBeforeBackup = await verifyWmsStocktakesPreservation();
  assert.equal(preservationBeforeBackup.status, 'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND');
  assert.equal(
    preservationBeforeBackup.original_baseline_sha256,
    baselineHash,
    'Original baseline bytes unchanged',
  );
  preservationExpectedHash = baselineHash;
  process.env.APP_REVISION = state.runtime_revision;
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/wms-stocktakes-112-restore',
  });
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
    immutableChecks = 0;
  let originalSessions: Json[] = [],
    heads: Json[] = [],
    lines: Json[] = [],
    reviews: Json[] = [],
    reviewRows: Json[] = [],
    measurements: Json[] = [],
    postings: Json[] = [],
    operations: Json[] = [],
    orders: Json[] = [],
    physicalBases: Json[] = [];
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
    originalSessions = (await c.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY 1')).rows;
    const rows = async (table: string) =>
      (await c.query(`SELECT * FROM "${table}" WHERE tenant_id=$1 ORDER BY 1`, [state.tenant]))
        .rows;
    heads = await rows('wms_stocktakes');
    lines = await rows('wms_stocktake_lines');
    reviews = await rows('wms_stocktake_reviews');
    reviewRows = await rows('wms_stocktake_review_rows');
    measurements = await rows('wms_stocktake_measurements');
    postings = await rows('wms_stocktake_postings');
    operations = await rows('wms_operations');
    orders = await rows('orders');
    physicalBases = (
      await c.query(
        `SELECT p.product_id,p.location,l.lot_id,sum(p.quantity)::int quantity,sum(p.reserved)::int reserved FROM wms_layer_positions p JOIN wms_cost_layers l ON (l.tenant_id,l.id,l.product_id)=(p.tenant_id,p.layer_id,p.product_id) WHERE p.tenant_id=$1 AND p.warehouse_id=$2 GROUP BY p.product_id,p.location,l.lot_id`,
        [state.tenant, state.warehouse],
      )
    ).rows;
    assert(
      heads.filter((h) => h.state === 'posted').length >= 2 &&
        heads.some((h) => h.state === 'cancelled'),
    );
    assert(heads.every((h) => ['posted', 'cancelled'].includes(h.state)));
    assert.equal(postings.length, heads.filter((h) => h.state === 'posted').length);
    for (const p of postings) {
      const h = heads.find((h) => h.id === p.stocktake_id),
        r = reviews.find((r) => r.id === p.review_id),
        op = operations.find((o) => o.id === p.operation_id);
      assert(h && r && op);
      assert.equal(h.posting_id, p.id);
      assert.equal(h.last_review_id, r.id);
      assert.equal(op.kind, 'stocktake_post');
      assert.equal(op.stocktake_id, h.id);
      assert.equal(op.stocktake_posting_id, p.id);
      assert.equal(op.stocktake_review_id, r.id);
      assert.equal(op.request.stocktake_id, h.id);
      assert.equal(op.request.posting_id, p.id);
      assert.equal(op.request.review_id, r.id);
      assert.equal(op.result.stocktake_id, h.id);
      assert.equal(op.result.posting_id, p.id);
      assert.equal(op.result.review_id, r.id);
      assert.equal(op.result.summary.currency, h.currency);
      assert.equal(
        op.result.summary.known_delta_minor,
        (
          BigInt(p.result.summary.known_surplus_minor) - BigInt(p.result.summary.known_loss_minor)
        ).toString(),
      );
      assert.equal(
        String(op.result.summary.unknown_delta_quantity),
        String(-p.result.summary.unknown_loss_quantity),
      );
      assert.equal(
        String(op.result.summary.incoming_quantity),
        String(p.result.summary.surplus_quantity),
      );
      assert.equal(
        String(op.result.summary.outgoing_quantity),
        String(p.result.summary.shortage_quantity),
      );
      assert.deepEqual(p.result.summary, r.summary);
    }
    assert.equal(
      (await c.query('SELECT count(*)::int n FROM wms_validation_scopes')).rows[0].n,
      0,
      'Collector globally empty',
    );
    for (const table of [...wmsTables, ...stocktakeTables, collector]) {
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
      if (table === collector) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
          assert.equal(
            (
              await c.query('SELECT has_table_privilege($1,$2,$3) permitted', [
                'dyna_app',
                table,
                privilege,
              ])
            ).rows[0].permitted,
            false,
          );
        assert.equal(
          (
            await c.query(
              `SELECT count(*)::int n FROM pg_class r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) a WHERE r.oid=$1::regclass AND a.grantee=0`,
              [table],
            )
          ).rows[0].n,
          0,
        );
        for (const signature of [
          'wms_validate_quantity_scope(uuid,uuid,uuid,boolean)',
          'wms_validate_operation_scope(uuid,uuid)',
          'wms_enqueue_validation_scopes()',
          'wms_flush_validation_scope()',
        ]) {
          assert.equal(
            (
              await c.query('SELECT has_function_privilege($1,$2,$3) permitted', [
                'dyna_app',
                signature,
                'EXECUTE',
              ])
            ).rows[0].permitted,
            false,
          );
          assert.equal(
            (
              await c.query(
                `SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`,
                [signature],
              )
            ).rows[0].n,
            0,
          );
        }
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE dyna_app');
          await c.query("SELECT set_config('app.tenant_id',$1,true)", [state.tenant]);
          await assert.rejects(
            c.query('SELECT count(*) FROM wms_validation_scopes'),
            (e: any) => e.code === '42501',
          );
        } finally {
          await c.query('ROLLBACK');
        }
        continue;
      }
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
      // Probe real populated records only. Mutable positions retain their genuine
      // legal update path; DELETE is forbidden. All own heads are terminal.
      if (!counts[table]) continue;
      const probes = [`DELETE FROM "${table}" WHERE tenant_id=$1`];
      if (!['wms_layer_positions', 'wms_reservation_layers'].includes(table))
        probes.push(`UPDATE "${table}" SET tenant_id=tenant_id WHERE tenant_id=$1`);
      for (const sql of probes) {
        await c.query('BEGIN');
        try {
          await assert.rejects(c.query(sql, [state.tenant]), (e: any) => e.code === '23514');
          immutableChecks++;
        } finally {
          await c.query('ROLLBACK');
        }
      }
    }
    for (const table of stocktakeTables)
      assert(counts[table] > 0, 'Accepted stocktake evidence missing: ' + table);
    assert.deepEqual(await tableFingerprints(c), manifest.tables, 'Every probe rolled back');
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
      assert(h.restore_preview && h.wms_lots_available && h.wms_stocktakes_available);
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
    assert(result.available && result.read_only);
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
      assert(Array.isArray(r.data) && r.data.length <= (path.includes('/stocktakes') ? 100 : 50));
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
  const json = (v: unknown) => JSON.parse(JSON.stringify(v));
  const prefix = '/wms-lots/stocktakes';
  const metadata = await read(prefix + '/metadata');
  assert(metadata.policy.enabled);
  assert.equal(metadata.policy.currency, 'PLN');
  assert.equal(metadata.limits.positions, 10000);
  assert.equal(metadata.limits.count_batch, 100);
  const rootMeta = await read('/wms-lots');
  assert(rootMeta.policy.enabled);
  const valuation = (await read('/wms-lots/valuation')).valuation;
  assert.equal(valuation.known_minor, '923');
  assert.equal(valuation.unknown_quantity, '0');
  const list = await pages(prefix + '?limit=100');
  assert.deepEqual(list.map((r) => r.id).sort(), heads.map((r) => r.id).sort());
  let comparedLines = 0,
    comparedReviews = 0,
    comparedMeasurements = 0;
  for (const h of heads) {
    const detail = (await read(prefix + '/' + h.id)).stocktake;
    for (const key of [
      'id',
      'warehouse_id',
      'name',
      'state',
      'version',
      'scope_hash',
      'blind',
      'policy_version',
      'currency',
      'posting_id',
      'created_at',
    ])
      assert.deepEqual(detail[key], json(h[key]), key);
    assert.equal(detail.latest_review_id, h.last_review_id);
    assert.equal(detail.needs_recount_count, 0);
    const expectedLines = lines.filter((l) => l.stocktake_id === h.id),
      actualLines = await pages(prefix + '/' + h.id + '/lines?limit=100');
    assert.deepEqual(actualLines.map((l) => l.id).sort(), expectedLines.map((l) => l.id).sort());
    assert.equal(detail.line_count, expectedLines.length);
    assert.equal(detail.counted_count, expectedLines.filter((l) => l.counted !== null).length);
    for (const expected of expectedLines) {
      const actual = actualLines.find((l) => l.id === expected.id)!;
      for (const key of [
        'id',
        'product_id',
        'sku',
        'name',
        'location',
        'lot',
        'counted',
        'version',
      ])
        assert.deepEqual(actual[key], json(expected[key]), key);
      const current = physicalBases.find(
        (b) =>
          b.product_id === expected.product_id &&
          b.location === expected.location &&
          b.lot_id === expected.lot_id,
      );
      assert.equal(actual.current_quantity, current?.quantity ?? 0);
      assert.equal(actual.reserved, current?.reserved ?? 0);
      assert.equal(
        actual.difference,
        expected.counted === null ? null : expected.counted - (current?.quantity ?? 0),
      );
      assert.equal(actual.original_quantity, expected.original.quantity);
      assert.equal(actual.needs_recount, false);
      assert.match(actual.basis_token, /^[a-f0-9]{64}$/);
      comparedLines++;
    }
    const expectedMeasurements = measurements.filter((m) => m.stocktake_id === h.id),
      actualMeasurements = await pages(prefix + '/' + h.id + '/measurements?limit=100');
    assert.deepEqual(
      actualMeasurements.map((m) => m.id).sort(),
      expectedMeasurements.map((m) => m.id).sort(),
    );
    for (const m of expectedMeasurements) {
      const actual = actualMeasurements.find((v) => v.id === m.id)!;
      assert.equal(actual.kind, m.kind);
      assert.equal(actual.created_at, json(m.created_at));
      assert.deepEqual(actual.result, {
        id: m.id,
        stocktake_id: m.stocktake_id,
        version: m.result.version,
        updated: m.result.updated ?? 0,
      });
      comparedMeasurements++;
    }
    const expectedReviews = reviews.filter((r) => r.stocktake_id === h.id),
      actualReviews = await pages(prefix + '/' + h.id + '/reviews?limit=100');
    assert.deepEqual(
      actualReviews.map((r) => r.id).sort(),
      expectedReviews.map((r) => r.id).sort(),
    );
    for (const r of expectedReviews) {
      const actual = (await read(prefix + '/' + h.id + '/reviews/' + r.id)).review;
      assert.equal(actual.scope_hash, r.scope_hash);
      assert.equal(actual.stocktake_version, r.stocktake_version);
      assert.deepEqual(actual.summary, r.summary);
      assert.equal(actual.created_at, json(r.created_at));
      const expectedRows = reviewRows.filter((v) => v.review_id === r.id),
        actualRows = await pages(prefix + '/' + h.id + '/reviews/' + r.id + '/rows?limit=100');
      assert.deepEqual(
        actualRows.map((v) => v.line_id).sort(),
        expectedRows.map((v) => v.line_id).sort(),
      );
      for (const row of expectedRows) {
        const actual = actualRows.find((v) => v.line_id === row.line_id)!;
        const ln = lines.find((l) => l.id === row.line_id)!;
        assert.equal(actual.counted, row.after.quantity);
        assert.equal(actual.product_id, row.product_id);
        assert.equal(actual.location, ln.location);
        assert.deepEqual(actual.lot, ln.lot);
        assert.deepEqual(actual.before, row.before);
        assert.deepEqual(actual.after, row.after);
        assert.deepEqual(actual.fragments, row.fragments);
        assert.deepEqual(actual.errors, []);
      }
      comparedReviews++;
    }
    if (h.state === 'posted') {
      const p = postings.find((p) => p.stocktake_id === h.id)!;
      const actual = (await read(prefix + '/' + h.id + '/posting')).posting;
      assert.equal(actual.id, p.id);
      assert.equal(actual.review_id, p.review_id);
      assert.equal(actual.wms_operation_id, p.operation_id);
      assert.equal(actual.changed, p.result.changed);
      assert.deepEqual(actual.summary, p.result.summary);
      assert.equal(actual.created_at, json(p.created_at));
    }
  }
  for (const op of operations.filter((o) => o.kind === 'stocktake_post')) {
    const actual = await read('/wms-lots/operations/' + op.id);
    assert.deepEqual(actual.request, op.request);
    assert.deepEqual(actual.result, op.result);
  }
  const positions = await pages('/wms-lots/positions');
  assert.equal(
    positions.reduce((n, r) => n + r.quantity, 0),
    9,
  );
  assert.equal(
    positions.reduce((n, r) => n + r.reserved, 0),
    5,
  );
  const order = orders.find((o) => o.id === state.order.id);
  assert(order);
  assert.equal(order.status, 'picking');
  const allocations = await pages('/wms-lots/orders/' + order.id + '/allocations');
  assert.equal(
    allocations.reduce((n, r) => n + r.quantity, 0),
    5,
  );
  assert.equal(
    allocations.reduce((n, r) => n + r.scanned, 0),
    1,
  );
  const sample = heads.find((h) => h.state === 'posted')!;
  const writes = [
    prefix,
    prefix + '/' + sample.id + '/counts',
    prefix + '/' + sample.id + '/reviews',
    prefix + '/' + sample.id + '/post',
    prefix + '/' + sample.id + '/reopen',
    prefix + '/' + sample.id + '/cancel',
  ];
  for (const path of writes) assert.equal((await req(path, 'POST', '{')).status, 423, path);
  assert.equal((await req(prefix + '/metadata', 'GET', undefined, baseline.firms[0])).status, 409);
  assert.equal(
    (
      await fetch('http://127.0.0.1:4100/api' + prefix + '/metadata', {
        headers: { cookie },
        signal: AbortSignal.timeout(5000),
      })
    ).status,
    401,
  );
  assert.deepEqual(await ownSnapshot(state, fresh, true), expectedSnapshot(state, true));
  const check = new pg.Client({ ...localDatabase(), database: fresh });
  await check.connect();
  try {
    await check.query("SET TIME ZONE 'UTC'");
    const sessions: Json[] = (
      await check.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY 1')
    ).rows;
    assert.equal(sessions.length, originalSessions.length + 1);
    const oldTokens = new Set(originalSessions.map((r) => r.row.token_hash));
    assert.deepEqual(
      sessions.filter((r) => oldTokens.has(r.row.token_hash)),
      originalSessions,
    );
    const createdSession = sessions.find((r) => !oldTokens.has(r.row.token_hash))!.row;
    assert.equal(createdSession.user_id, state.user);
    assert.equal(createdSession.tenant_id, state.tenant);
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
  assert.equal(sha(await readFile(baselinePath)), baselineHash);
  report = {
    stage: 112,
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
    force_rls_tables: wmsTables.length + stocktakeTables.length + 1,
    wms_table_counts: counts,
    immutable_checks: immutableChecks,
    operation_results_exact: postings.length,
    stocktake_heads_exact: heads.length,
    stocktake_lines_exact: comparedLines,
    review_receipts_exact: comparedReviews,
    measurements_exact: comparedMeasurements,
    postings_exact: postings.length,
    private_collector_empty_no_app_or_public_grants: true,
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
      if (preservationExpectedHash) {
        const preservationAfterCleanup = await verifyWmsStocktakesPreservation();
        assert.equal(preservationAfterCleanup.status, 'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND');
        assert.equal(preservationAfterCleanup.original_baseline_sha256, preservationExpectedHash);
        assert.equal(
          sha(await readFile(baselinePath)),
          preservationAfterCleanup.original_baseline_sha256,
        );
        if (report) report.preservation_after_cleanup = preservationAfterCleanup;
      }
    } finally {
      await pool.end();
    }
  }
}
assert(report);
report.owned_preview_and_database_removed = true;
await writeFile('docs/wms-stocktakes-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
