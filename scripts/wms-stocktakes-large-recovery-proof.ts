/** Coordinator-only QA112 boundary: 10000 scoped lines, 100 counts, cancel, actual restore.
 * The bin layout is explicit synthetic SQL. This is not a 10000-correction/capacity/UI claim.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { pool, tenantTx } from '../server/db';
import { enlistWmsActorInTx } from '../server/wms-lots-transaction';
import { wmsLotsHash } from '../server/wms-lots';
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
const phase = process.argv[2];
const statePath = 'data/wms-stocktakes-large-stage112.json';
const primaryPath = 'data/wms-stocktakes-stage112.json';
const extendedPath = 'data/wms-stocktakes-extended112.json';
const baselinePath = 'data/wms-stocktakes-stage112-baseline.json';
const schema = '093_wms_validation_scopes';
const prefix = '/wms-lots/stocktakes';
const port = 4153;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const digest = (rows: unknown[]): Digest => ({
  count: rows.length,
  sha256: sha(JSON.stringify(rows)),
});
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const identifier = (name: string) => {
  assert(/^[a-z][a-z0-9_]*$/.test(name));
  return '"' + name + '"';
};
let cookie = '',
  child: ReturnType<typeof spawn> | undefined,
  ownedDatabase: string | undefined;
let priorDatabases: string[] | undefined,
  baselineHash: string | undefined,
  result: Json | undefined;
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
const physicalTables = [
  'products',
  'stock',
  'stock_locations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'stock_movements',
  'stock_location_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_reservation_layers',
  'wms_issue_fragments',
  'wms_return_fragments',
];
const save = (s: Json) => writeFile(statePath, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
async function privateJson(path: string) {
  const stat = await lstat(path);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600,
    'Private regular0600 state required',
  );
  return JSON.parse(await readFile(path, 'utf8')) as Json;
}
async function api(path: string, method = 'GET', body?: unknown, statuses = [200]) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(30000),
  });
  assert(statuses.includes(r.status), `${method} ${path}: HTTP ${r.status}`);
  const next = r.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  return r.json() as Promise<Json>;
}
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
async function snapshot(s: Json, names: string[], database = localDatabase().database) {
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Record<string, Digest> = {};
    for (const name of names)
      out[name] = digest(
        (
          await c.query(
            `SELECT to_jsonb(t) row FROM ${identifier(name)} t
      WHERE ${['tenants', 'users'].includes(name) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
            [name === 'users' ? s.user : s.tenant],
          )
        ).rows,
      );
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
async function ownNames() {
  return (
    await pool.query(`SELECT DISTINCT t.table_name FROM information_schema.tables t JOIN information_schema.columns col USING(table_schema,table_name)
    WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND col.column_name='tenant_id'
    UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`)
  ).rows.map((r) => r.table_name as string);
}
async function preservation(expected: string) {
  const proof = await verifyWmsStocktakesPreservation();
  assert.equal(proof.status, 'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND');
  assert.equal(proof.original_baseline_sha256, expected);
  assert.equal(sha(await readFile(baselinePath)), expected);
  return proof;
}
async function portIsFree() {
  const listener = createServer();
  try {
    await new Promise<void>((done, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', done);
    });
  } finally {
    if (listener.listening) await new Promise<void>((done) => listener.close(() => done()));
  }
}
const withoutSessions = (s: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(s).filter(([name]) => name !== 'sessions'));

try {
  assert(
    ['setup', 'restore'].includes(phase),
    'Use setup or restore; partial attempts require explicit manual readback',
  );
  const primary = await privateJson(primaryPath);
  assert(
    primary.stage === 112 &&
      primary.api_acceptance?.status === 'PASS' &&
      primary.ui_verified === true &&
      primary.operator_ui_verified === true &&
      primary.native_operator_ui_verified === true &&
      primary.restart_verified === true,
  );
  const expected = process.env.QA_EXPECTED_REVISION ?? primary.runtime_revision;
  assert(typeof expected === 'string' && /^[a-f0-9]{7,40}$/.test(expected));
  assert.equal(
    primary.runtime_revision,
    expected,
    'Never silently change the accepted primary source',
  );
  const health = await api('/health');
  assert.equal(health.revision, expected);
  assert.equal(health.schema_revision, schema);
  assert(!health.restore_preview && health.wms_stocktakes_available && health.wms_lots_available);
  baselineHash = sha(await readFile(baselinePath));
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Json;
  assert.equal(baseline.stage, 112);
  assert.equal(baseline.baseline_rebased, false);
  assert.equal(baseline.firms.length, 105);
  assert.equal(baseline.users.length, 89);
  assert.equal(baseline.databases.length, 17);
  priorDatabases = await databaseNames();
  assert.deepEqual(priorDatabases, baseline.databases);
  const beforePreservation = await preservation(baselineHash);
  assert.deepEqual(
    await snapshot(primary, primary.own_names),
    primary.own_snapshot,
    'Primary QA112 checkpoint is not modified by this boundary proof',
  );

  if (phase === 'setup') {
    const s: Json = {
      stage: 112,
      purpose: '10000-scoped-line-readonly-restore',
      runtime_revision: expected,
      schema,
      created_at: new Date().toISOString(),
      email: 'qa-wms112-boundary-' + randomUUID().slice(0, 10) + '@demo.local',
      password: 'DynaWms112Boundary!-' + randomUUID(),
      original_baseline_sha256: baselineHash,
      setup_started: true,
      actual_boundary_ui_verified: false,
      physical_corrections_executed: 0,
    };
    await writeFile(statePath, JSON.stringify(s, null, 2), { flag: 'wx', mode: 0o600 });
    s.signup_request = {
      email: s.email,
      password: s.password,
      name: 'QA112 boundary administrator',
      organization: { name: 'QA112 — synthetic 10000-bin boundary' },
    };
    await save(s);
    const signup = await api('/auth/signup', 'POST', s.signup_request, [201]);
    assert.equal(signup.user.role, 'admin');
    s.tenant = signup.user.tenant_id;
    s.user = signup.user.id;
    s.cookie = cookie;
    await save(s);
    assert(!baseline.firms.includes(s.tenant) && !baseline.users.includes(s.user));
    assert.notEqual(s.tenant, primary.tenant);
    assert.notEqual(s.user, primary.user);
    await api('/workspaces/plan', 'PATCH', { plan: 'business' });
    s.warehouse = (await api('/warehouses')).data[0].id;
    s.product_request = {
      sku: 'QA112-BOUNDARY-' + randomUUID().slice(0, 8),
      name: 'Synthetic10000-bin boundary product',
      price: 100,
      warehouse_id: s.warehouse,
      quantity: 10000,
      location: 'A-01',
    };
    await save(s);
    s.product = await api('/products', 'POST', s.product_request, [201]);
    await save(s);
    const version = (
      await pool.query(
        'SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
        [s.tenant, s.warehouse, s.product.id],
      )
    ).rows[0].version;
    s.opening_request = {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Synthetic boundary opening: unknown cost remains unknown',
      lines: [
        {
          warehouse_id: s.warehouse,
          product_id: s.product.id,
          location: 'A-01',
          quantity: 10000,
          stock_version: version,
          lot_code: 'BOUNDARY-LOT',
          unit_cost_minor: null,
        },
      ],
    };
    await save(s);
    const { preview } = await api('/wms-lots/opening-previews', 'POST', s.opening_request, [201]);
    assert.equal(preview.ready, true);
    s.opening_preview_id = preview.id;
    s.activate_request = {
      client_key: randomUUID(),
      scope_hash: preview.scope_hash,
      confirmed: true,
      ack_unknown_costs: true,
    };
    await save(s);
    await api(
      '/wms-lots/opening-previews/' + preview.id + '/activate',
      'POST',
      s.activate_request,
      [201],
    );
    s.layer = (
      await pool.query('SELECT id FROM wms_cost_layers WHERE tenant_id=$1', [s.tenant])
    ).rows[0].id;
    s.layout_operation = randomUUID();
    s.layout_key = randomUUID();
    await save(s);
    // Explicit own synthetic layout, not a claim of an API10000-bin move. One
    // real existing opening layer is redistributed; quantity and journal remain exact.
    await tenantTx(s.tenant, async (c) => {
      enlistWmsActorInTx(
        c,
        { tenantId: s.tenant, userId: s.user, source: 'manual' },
        { adminOnly: true },
      );
      const request = {
        synthetic: 'QA112-boundary10000-layout',
        product_id: s.product.id,
        warehouse_id: s.warehouse,
      };
      await c.query(
        `INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,request,result)
        VALUES($1,$2,$3,$4,$5,'bin_move','manual',1,$6,'{}')`,
        [s.layout_operation, s.tenant, s.user, s.layout_key, wmsLotsHash(request), request],
      );
      await c.query(
        "UPDATE stock_locations SET quantity=1 WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 AND location='A-01'",
        [s.tenant, s.warehouse, s.product.id],
      );
      await c.query(
        "UPDATE wms_layer_positions SET quantity=1,version=version+1 WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 AND location='A-01'",
        [s.tenant, s.warehouse, s.product.id],
      );
      await c.query(
        `INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity)
        SELECT $1,$2,$3,'B'||lpad(n::text,5,'0'),1 FROM generate_series(1,9999)n`,
        [s.tenant, s.warehouse, s.product.id],
      );
      await c.query(
        `INSERT INTO wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id,quantity)
        SELECT $1,$2,$3,'B'||lpad(n::text,5,'0'),$4,1 FROM generate_series(1,9999)n`,
        [s.tenant, s.warehouse, s.product.id, s.layer],
      );
      await c.query(
        `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind)
        VALUES(gen_random_uuid(),$1,$2,$3,$4,'A-01',$5,-9999,NULL,'bin_move')`,
        [s.tenant, s.layout_operation, s.warehouse, s.product.id, s.layer],
      );
      await c.query(
        `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind)
        SELECT gen_random_uuid(),$1,$2,$3,$4,'B'||lpad(n::text,5,'0'),$5,1,NULL,'bin_move' FROM generate_series(1,9999)n`,
        [s.tenant, s.layout_operation, s.warehouse, s.product.id, s.layer],
      );
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    // The collector is deliberately not readable as dyna_app inside tenantTx.
    // A privileged read after commit checks that this own scope was flushed.
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM wms_validation_scopes WHERE tenant_id=$1', [
          s.tenant,
        ])
      ).rows[0].n,
      0,
    );
    const physicalBefore = await snapshot(s, physicalTables);
    s.create_request = {
      client_key: randomUUID(),
      warehouse_id: s.warehouse,
      name: 'QA112 actual10000-scoped-line restore',
      policy_version: '1',
      blind: true,
    };
    await save(s);
    const h = (await api(prefix, 'POST', s.create_request, [201])).stocktake;
    assert.equal(h.line_count, 10000);
    s.stocktake_id = h.id;
    await save(s);
    const first = await api(prefix + '/' + h.id + '/lines?limit=100');
    assert.equal(first.data.length, 100);
    assert(first.meta.cursor);
    assert(first.data.every((l: Json) => l.current_quantity === 1 && l.reserved === 0));
    s.count_request = {
      client_key: randomUUID(),
      note: 'Only100 actual observed counts, not10000 changes',
      lines: first.data.map((l: Json) => ({
        id: l.id,
        version: l.version,
        basis_token: l.basis_token,
        quantity: 1,
      })),
    };
    await save(s);
    const measured = await api(prefix + '/' + h.id + '/counts', 'POST', s.count_request, [201]);
    assert.equal(measured.measurement.updated, 100);
    s.measurement_id = measured.measurement.id;
    const afterCount = await snapshot(s, await ownNames());
    assert.equal(
      (await api(prefix + '/' + h.id + '/counts', 'POST', s.count_request)).reused,
      true,
    );
    assert.deepEqual(await snapshot(s, await ownNames()), afterCount);
    const current = (await api(prefix + '/' + h.id)).stocktake;
    assert.equal(current.counted_count, 100);
    assert.equal(current.state, 'counting');
    s.incomplete_review_request = {
      client_key: randomUUID(),
      version: current.version,
      note: 'Expected incomplete9900-lines review refusal',
      surplus: [],
    };
    await save(s);
    await api(prefix + '/' + h.id + '/reviews', 'POST', s.incomplete_review_request, [409]);
    assert.deepEqual(
      await snapshot(s, await ownNames()),
      afterCount,
      'Rejected incomplete review is inert',
    );
    s.cancel_request = {
      client_key: randomUUID(),
      version: current.version,
      note: 'Cancel boundary with no physical correction',
    };
    await save(s);
    const cancelled = await api(prefix + '/' + h.id + '/cancel', 'POST', s.cancel_request, [201]);
    assert.equal(cancelled.stocktake.state, 'cancelled');
    const afterCancel = await snapshot(s, await ownNames());
    assert.equal(
      (await api(prefix + '/' + h.id + '/cancel', 'POST', s.cancel_request)).reused,
      true,
    );
    assert.deepEqual(await snapshot(s, await ownNames()), afterCancel);
    assert.deepEqual(
      await snapshot(s, physicalTables),
      physicalBefore,
      'Counts/cancellation never mutate physical stock or journal',
    );
    const valuation = (await api('/wms-lots/valuation')).valuation;
    assert.equal(valuation.known_minor, '0');
    assert.equal(valuation.unknown_quantity, '10000');
    s.cookie = cookie;
    s.own_names = await ownNames();
    s.own_snapshot_timezone = 'UTC';
    s.own_snapshot = await snapshot(s, s.own_names);
    s.setup_complete = true;
    await save(s);
    assert.deepEqual(await snapshot(primary, primary.own_names), primary.own_snapshot);
    const afterPreservation = await preservation(baselineHash);
    await writeFile(
      'docs/wms-stocktakes-large-setup-qa.json',
      JSON.stringify(
        {
          stage: 112,
          status: 'PASS_SCOPE10000_COUNT100_CANCELLED',
          revision: expected,
          schema,
          tenant: s.tenant,
          stocktake: s.stocktake_id,
          scope_lines: 10000,
          measured_lines: 100,
          incomplete_review_status: 409,
          terminal: 'cancelled',
          synthetic_bin_layout: true,
          physical_corrections_executed: 0,
          primary_checkpoint_unchanged: true,
          original_baseline_sha256: baselineHash,
          preservation_before: beforePreservation,
          preservation_after: afterPreservation,
          restore: 'PENDING',
          provider_verified: false,
          actual_boundary_ui_verified: false,
          goal_complete: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    console.log({
      phase,
      status: 'SETUP_PASS',
      scope_lines: 10000,
      measured_lines: 100,
      terminal: 'cancelled',
    });
  } else {
    const s = await privateJson(statePath);
    const setupReport = JSON.parse(
      await readFile('docs/wms-stocktakes-large-setup-qa.json', 'utf8'),
    ) as Json;
    assert.equal(setupReport.status, 'PASS_SCOPE10000_COUNT100_CANCELLED');
    assert.equal(setupReport.tenant, s.tenant);
    assert.equal(setupReport.stocktake, s.stocktake_id);
    assert.equal(setupReport.revision, expected);
    assert.equal(setupReport.original_baseline_sha256, baselineHash);
    const extended = await privateJson(extendedPath);
    assert(
      extended.stage === 112 &&
        extended.api_acceptance?.status === 'PASS' &&
        extended.ui_verified === true &&
        extended.restart_verified === true,
      'Extended actual API, UI and restart must precede this restore',
    );
    assert.equal(extended.runtime_revision, expected);
    assert.equal(extended.own_snapshot_timezone, 'UTC');
    assert.deepEqual(Object.keys(extended.own_snapshot).sort(), [...extended.own_names].sort());
    assert.deepEqual(
      await snapshot(extended, extended.own_names),
      extended.own_snapshot,
      'Accepted extended source state remains exact',
    );
    assert(
      s.stage === 112 && s.setup_complete && !s.restore_started,
      'Partial restore requires explicit manual readback',
    );
    assert.equal(s.runtime_revision, expected);
    assert.equal(s.schema, schema);
    assert.equal(s.original_baseline_sha256, baselineHash);
    assert.equal(s.own_snapshot_timezone, 'UTC');
    assert.deepEqual(await snapshot(s, s.own_names), s.own_snapshot);
    assert.deepEqual(Object.keys(s.own_snapshot).sort(), [...s.own_names].sort());
    for (const name of [...wmsTables, ...stocktakeTables, collector, 'stock', 'sessions'])
      assert(s.own_names.includes(name));
    assert.equal(s.own_snapshot.wms_stocktake_lines.count, 10000);
    assert.equal(s.own_snapshot.wms_stocktake_scope_layers.count, 10000);
    assert.equal(s.own_snapshot.wms_stocktake_measurements.count, 2);
    assert.equal(s.own_snapshot.wms_stocktake_measurement_layers.count, 100);
    assert.equal(s.own_snapshot.wms_stocktake_reviews.count, 0);
    assert.equal(s.own_snapshot.wms_stocktake_postings.count, 0);
    assert.equal(s.own_snapshot.wms_validation_scopes.count, 0);
    await portIsFree();
    s.restore_started = true;
    await save(s);
    process.env.APP_REVISION = expected;
    const backup = await createBackup({ directory: 'data/backups' });
    const restored = await restoreBackup(backup.file, {
      directory: 'data/wms-stocktakes-large112-restore',
    });
    const fresh = restoreDatabaseName(restored.database);
    assert(!priorDatabases.includes(fresh));
    ownedDatabase = fresh;
    assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
    assert.equal(restored.worker_enabled, false);
    assert.equal(restored.revision, expected);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8')),
    );
    assert.deepEqual(await snapshot(s, s.own_names, fresh), s.own_snapshot);
    assert.deepEqual(await snapshot(primary, primary.own_names, fresh), primary.own_snapshot);
    assert.deepEqual(await snapshot(extended, extended.own_names, fresh), extended.own_snapshot);
    const c = new pg.Client({ ...localDatabase(), database: fresh });
    await c.connect();
    let frozenLines: Json[] = [],
      frozenMeasurements: Json[] = [],
      originalSessions: Json[] = [],
      head: Json = {},
      primaryReceipts: Json[] = [];
    try {
      await c.query("SET TIME ZONE 'UTC'");
      assert.deepEqual(await tableFingerprints(c), manifest.tables);
      assert.equal(
        await schemaFingerprint(c, manifest.schema_fingerprint_version ?? 1),
        manifest.schema_sha256,
      );
      assert.equal(
        (await c.query('SELECT name FROM migrations ORDER BY name')).rows.at(-1)?.name,
        schema,
      );
      originalSessions = (await c.query('SELECT to_jsonb(t) row FROM sessions t ORDER BY 1')).rows;
      frozenLines = (
        await c.query(
          'SELECT * FROM wms_stocktake_lines WHERE tenant_id=$1 AND stocktake_id=$2 ORDER BY id',
          [s.tenant, s.stocktake_id],
        )
      ).rows;
      frozenMeasurements = (
        await c.query(
          'SELECT * FROM wms_stocktake_measurements WHERE tenant_id=$1 AND stocktake_id=$2 ORDER BY id',
          [s.tenant, s.stocktake_id],
        )
      ).rows;
      head = (
        await c.query('SELECT * FROM wms_stocktakes WHERE tenant_id=$1 AND id=$2', [
          s.tenant,
          s.stocktake_id,
        ])
      ).rows[0];
      assert.equal(head.state, 'cancelled');
      assert.equal(frozenLines.length, 10000);
      assert.equal(frozenLines.filter((l) => l.counted === 1).length, 100);
      assert.equal(frozenMeasurements.length, 2);
      primaryReceipts = (
        await c.query(
          'SELECT p.id,p.stocktake_id,p.review_id,p.operation_id,p.result,o.stocktake_id op_stocktake_id,o.stocktake_posting_id,o.stocktake_review_id FROM wms_stocktake_postings p JOIN wms_operations o ON (o.tenant_id,o.id)=(p.tenant_id,p.operation_id) WHERE p.tenant_id=$1 ORDER BY p.id',
          [primary.tenant],
        )
      ).rows;
      assert(primaryReceipts.length >= 2);
      for (const p of primaryReceipts) {
        assert.equal(p.op_stocktake_id, p.stocktake_id);
        assert.equal(p.stocktake_posting_id, p.id);
        assert.equal(p.stocktake_review_id, p.review_id);
      }
      assert.equal(
        (await c.query('SELECT count(*)::int n FROM wms_validation_scopes')).rows[0].n,
        0,
      );
      for (const table of [...wmsTables, ...stocktakeTables, collector]) {
        const flags = (
          await c.query(
            'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
            [table],
          )
        ).rows[0];
        assert(flags.relrowsecurity && flags.relforcerowsecurity, table);
        if (table === collector) {
          for (const grant of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
            assert.equal(
              (
                await c.query('SELECT has_table_privilege($1,$2,$3) allowed', [
                  'dyna_app',
                  table,
                  grant,
                ])
              ).rows[0].allowed,
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
          for (const fn of [
            'wms_validate_quantity_scope(uuid,uuid,uuid,boolean)',
            'wms_validate_operation_scope(uuid,uuid)',
            'wms_enqueue_validation_scopes()',
            'wms_flush_validation_scope()',
          ]) {
            assert.equal(
              (
                await c.query('SELECT has_function_privilege($1,$2,$3) allowed', [
                  'dyna_app',
                  fn,
                  'EXECUTE',
                ])
              ).rows[0].allowed,
              false,
            );
            assert.equal(
              (
                await c.query(
                  `SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`,
                  [fn],
                )
              ).rows[0].n,
              0,
            );
          }
          await c.query('BEGIN');
          try {
            await c.query('SET LOCAL ROLE dyna_app');
            await assert.rejects(
              c.query('SELECT * FROM wms_validation_scopes'),
              (e: any) => e.code === '42501',
            );
          } finally {
            await c.query('ROLLBACK');
          }
        } else {
          const own = (
            await c.query(`SELECT count(*)::int n FROM ${identifier(table)} WHERE tenant_id=$1`, [
              s.tenant,
            ])
          ).rows[0].n;
          await c.query('BEGIN');
          try {
            await c.query('SET LOCAL ROLE dyna_app');
            await c.query("SELECT set_config('app.tenant_id',$1,true)", [primary.tenant]);
            assert.equal(
              (
                await c.query(
                  `SELECT count(*)::int n FROM ${identifier(table)} WHERE tenant_id=$1`,
                  [s.tenant],
                )
              ).rows[0].n,
              0,
            );
            await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
            assert.equal(
              (
                await c.query(
                  `SELECT count(*)::int n FROM ${identifier(table)} WHERE tenant_id=$1`,
                  [s.tenant],
                )
              ).rows[0].n,
              own,
            );
          } finally {
            await c.query('ROLLBACK');
          }
        }
      }
      for (const table of [
        'wms_stocktakes',
        'wms_stocktake_lines',
        'wms_stocktake_scope_layers',
        'wms_stocktake_measurements',
        'wms_stocktake_measurement_layers',
      ]) {
        for (const sql of [
          `DELETE FROM ${identifier(table)} WHERE tenant_id=$1`,
          `UPDATE ${identifier(table)} SET tenant_id=tenant_id WHERE tenant_id=$1`,
        ]) {
          await c.query('BEGIN');
          try {
            await assert.rejects(c.query(sql, [s.tenant]), (e: any) => e.code === '23514');
          } finally {
            await c.query('ROLLBACK');
          }
        }
      }
      // Use a real foreign stocktake UUID and otherwise own valid principals.
      // This must be the composite FK (23503), not an empty-row/PK probe.
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE dyna_app');
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
        await assert.rejects(
          c.query(
            `INSERT INTO wms_stocktake_measurements(id,tenant_id,stocktake_id,actor_id,client_key,request_hash,kind,request,result)
          VALUES($1,$2,$3,$4,$5,$6,'cancel','{}','{}')`,
            [
              randomUUID(),
              s.tenant,
              primaryReceipts[0].stocktake_id,
              s.user,
              randomUUID(),
              wmsLotsHash({ probe: 'own-restored-foreign-source' }),
            ],
          ),
          (e: any) => e.code === '23503',
        );
      } finally {
        await c.query('ROLLBACK');
      }
      assert.deepEqual(await tableFingerprints(c), manifest.tables);
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
    let childStartError: Error | undefined;
    child.once('error', (e) => {
      childStartError = e;
    });
    const base = `http://127.0.0.1:${port}/api`;
    let ready = false;
    for (let n = 0; n < 80; ++n) {
      if (childStartError) throw childStartError;
      assert(child.exitCode === null && child.signalCode === null, 'Owned preview exited');
      try {
        const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
        if (r.ok) {
          const h: Json = await r.json();
          assert(h.restore_preview && h.wms_stocktakes_available);
          assert.equal(h.revision, expected);
          assert.equal(h.schema_revision, schema);
          ready = true;
          break;
        }
      } catch (e) {
        if (e instanceof assert.AssertionError) throw e;
      }
      await setTimeout(200);
    }
    assert(ready);
    const login = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: s.email, password: s.password }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(login.status, 200);
    assert(login.headers.get('set-cookie'));
    const copyCookie = login.headers.get('set-cookie')!.split(';')[0];
    const read = async (path: string, authCookie = copyCookie) => {
      const r = await fetch(base + path, {
        headers: { cookie: authCookie },
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const text = await r.text();
      assert(Buffer.byteLength(text) <= 5 * 1024 * 1024);
      const out: Json = JSON.parse(text);
      assert(out.available && out.read_only);
      for (const [k, v] of Object.entries(out))
        if (k.startsWith('can_') && !['can_read', 'can_read_value'].includes(k))
          assert.equal(v, false, k);
      return out;
    };
    const restoredHead = (await read(prefix + '/' + s.stocktake_id)).stocktake;
    assert.equal(restoredHead.state, 'cancelled');
    assert.equal(restoredHead.line_count, 10000);
    assert.equal(restoredHead.counted_count, 100);
    assert.equal(restoredHead.version, head.version);
    assert.equal(restoredHead.scope_hash, head.scope_hash);
    const byId = new Map(frozenLines.map((l) => [l.id, l])),
      seen = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | null = null,
      pages = 0;
    do {
      const page = await read(
        prefix +
          '/' +
          s.stocktake_id +
          '/lines?' +
          new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
      );
      assert.equal(page.data.length, 100);
      for (const line of page.data as Json[]) {
        assert(!seen.has(line.id));
        seen.add(line.id);
        const original = byId.get(line.id);
        assert(original);
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
          assert.deepEqual(line[key], json(original[key]), key);
        assert.equal(line.current_quantity, 1);
        assert.equal(line.original_quantity, 1);
        assert.equal(line.reserved, 0);
        assert.equal(line.needs_recount, false);
        assert.match(line.basis_token, /^[a-f0-9]{64}$/);
      }
      ++pages;
      assert(pages <= 100);
      cursor = page.meta.cursor;
      assert(cursor === null || typeof cursor === 'string');
      if (cursor) {
        assert(!cursors.has(cursor));
        cursors.add(cursor);
      }
      if (pages % 25 === 0) console.log({ phase: 'restore-pages', pages, lines: seen.size });
    } while (cursor);
    assert.equal(pages, 100);
    assert.equal(seen.size, 10000);
    assert.deepEqual([...seen].sort(), [...byId.keys()].sort());
    const history = await read(prefix + '/' + s.stocktake_id + '/measurements?limit=100');
    assert.equal(history.meta.cursor, null);
    assert.equal(history.data.length, 2);
    for (const m of frozenMeasurements) {
      const actual = history.data.find((v: Json) => v.id === m.id);
      assert(actual);
      assert.equal(actual.kind, m.kind);
      assert.deepEqual(actual.result, {
        id: m.id,
        stocktake_id: m.stocktake_id,
        version: m.result.version,
        updated: m.result.updated ?? 0,
      });
    }
    assert(history.data.some((m: Json) => m.kind === 'cancel'));
    assert(typeof primary.email === 'string' && typeof primary.password === 'string');
    const primaryLogin = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: primary.email, password: primary.password }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(primaryLogin.status, 200);
    assert(primaryLogin.headers.get('set-cookie'));
    const primaryCopyCookie = primaryLogin.headers.get('set-cookie')!.split(';')[0];
    for (const original of primaryReceipts.slice(0, 2)) {
      const posting = (
        await read(prefix + '/' + original.stocktake_id + '/posting', primaryCopyCookie)
      ).posting;
      assert.equal(posting.id, original.id);
      assert.equal(posting.stocktake_id, original.stocktake_id);
      assert.equal(posting.review_id, original.review_id);
      assert.equal(posting.wms_operation_id, original.operation_id);
      assert.equal(posting.state, 'posted');
      assert.equal(posting.changed, original.result.changed);
      assert.deepEqual(posting.summary, original.result.summary);
    }
    const writes = [
      prefix,
      prefix + '/' + s.stocktake_id + '/counts',
      prefix + '/' + s.stocktake_id + '/reviews',
      prefix + '/' + s.stocktake_id + '/post',
      prefix + '/' + s.stocktake_id + '/reopen',
      prefix + '/' + s.stocktake_id + '/cancel',
    ];
    for (const path of writes) {
      const r = await fetch(base + path, {
        method: 'POST',
        headers: { cookie: copyCookie, 'Content-Type': 'application/json' },
        body: '{',
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(r.status, 423, path);
    }
    assert.deepEqual(
      withoutSessions(await snapshot(s, s.own_names, fresh)),
      withoutSessions(s.own_snapshot),
    );
    assert.deepEqual(
      withoutSessions(await snapshot(primary, primary.own_names, fresh)),
      withoutSessions(primary.own_snapshot),
    );
    assert.deepEqual(await snapshot(extended, extended.own_names, fresh), extended.own_snapshot);
    const check = new pg.Client({ ...localDatabase(), database: fresh });
    await check.connect();
    try {
      await check.query("SET TIME ZONE 'UTC'");
      const sessions = (await check.query('SELECT to_jsonb(t) row FROM sessions t ORDER BY 1'))
        .rows;
      const oldTokens = new Set(originalSessions.map((r) => r.row.token_hash));
      assert.equal(sessions.length, originalSessions.length + 2);
      assert.deepEqual(
        sessions.filter((r) => oldTokens.has(r.row.token_hash)),
        originalSessions,
      );
      const added = sessions
        .filter((r) => !oldTokens.has(r.row.token_hash))
        .map((r) => ({ user: r.row.user_id, tenant: r.row.tenant_id }));
      const sortPrincipals = (v: Json[]) =>
        v.sort((a, b) => String(a.user).localeCompare(String(b.user)));
      assert.deepEqual(
        sortPrincipals(added),
        sortPrincipals([
          { user: s.user, tenant: s.tenant },
          { user: primary.user, tenant: primary.tenant },
        ]),
      );
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
    assert.deepEqual(await snapshot(s, s.own_names), s.own_snapshot);
    assert.deepEqual(await snapshot(primary, primary.own_names), primary.own_snapshot);
    assert.deepEqual(await snapshot(extended, extended.own_names), extended.own_snapshot);
    result = {
      stage: 112,
      status: 'PASS_ACTUAL10000_SCOPE_RESTORE',
      revision: expected,
      schema,
      backup_id: backup.id,
      tables: restored.tables,
      encrypted_records_verified: restored.encrypted_records_verified,
      all_manifest_rows_and_schema_exact: true,
      own_checkpoint_tables_exact: s.own_names.length,
      scope_lines_restored: 10000,
      restored_line_pages: pages,
      line_page_size: 100,
      counted_lines: 100,
      actual_count_batches: 1,
      terminal: 'cancelled',
      terminal_measurements: 2,
      original_primary_posting_receipts_copied: primaryReceipts.length,
      original_primary_posting_receipts_verified_http: 2,
      synthetic_bin_layout: true,
      physical_corrections_executed: 0,
      complete10000_review_or_post_claim: false,
      capacity_claim: false,
      actual_boundary_ui_verified: false,
      force_rls_tables: 19,
      private_collector_empty: true,
      collector_public_and_app_privileges_denied: true,
      immutable_update_delete_probes: 10,
      genuine_foreign_source_fk: true,
      writes423: writes.length,
      copied_prior_sessions_exact: true,
      own_preview_login_sessions_added: 2,
      primary_checkpoint_unchanged: true,
      source_boundary_checkpoint_unchanged: true,
      accepted_extended_source_and_copy_checkpoint_exact: true,
      worker_enabled: false,
      provider_verified: false,
      goal_complete: false,
      original_baseline_sha256: baselineHash,
      preservation_before_backup: beforePreservation,
      original_databases_preserved: 17,
    };
  }
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
          'All earlier databases remain exact even on failure',
        );
      if (baselineHash) {
        const proof = await preservation(baselineHash);
        if (result) result.preservation_after_cleanup = proof;
      }
    } finally {
      await pool.end();
    }
  }
}
if (phase === 'restore') {
  assert(result);
  result.owned_preview_and_restore_database_removed = true;
  await writeFile(
    'docs/wms-stocktakes-large-recovery-qa.json',
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log({
    stage: 112,
    status: result.status,
    restored_lines: result.scope_lines_restored,
    pages: result.restored_line_pages,
    prior_databases: result.original_databases_preserved,
  });
}
