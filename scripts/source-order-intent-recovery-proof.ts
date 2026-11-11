/** Root-operated QA127B recovery. No automatic UI attestation or checkpoint writes.
 * Source queries are read-only. SQL integrity probes run only in the owned copy and roll back.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, open } from 'node:fs/promises';
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

type Row = Record<string, any>;
type Checkpoint = Record<string, { count: number; sha256: string }>;
const statePath = 'data/source-order-intent-stage127b.json';
const reportPath = 'docs/source-order-intent-recovery-qa.json';
const schema = '110_b2b_external_order_imports';
const port = 4102;
const base = `http://127.0.0.1:${port}/api`;
const publicTables = [
  'b2b_external_import_previews',
  'b2b_external_import_executions',
  'b2b_external_order_intents',
  'b2b_external_order_intent_revisions',
  'order_source_lines',
];
const privateTables = [
  'b2b_external_import_certificates',
  'b2b_external_order_allocation_proofs',
  'b2b_external_order_created_orders',
];
const oldFiles = [
  'data/wms-lots-stage111.json',
  'data/source-fulfillment-stage124.json',
  'data/b2b-network-dropshipping-stage126.json',
  'data/b2b-external-order-intent-stage127.json',
];
const physicalTables = [
  'stock',
  'stock_locations',
  'stock_location_movements',
  'stock_location_operations',
  'stock_movements',
  'reservations',
  'reservation_locations',
  'order_pick_items',
  'warehouse_documents',
  'warehouse_document_lines',
  'wms_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'shipments',
];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const byteHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
let child: ChildProcess | undefined,
  database: string | undefined,
  logHandle: Awaited<ReturnType<typeof open>> | undefined;
let source: pg.Client | undefined,
  copy: pg.Client | undefined,
  phase = 'preflight',
  report: Row | undefined,
  spawnError = false;
let beforeManifest: Awaited<ReturnType<typeof tableFingerprints>> | undefined,
  beforeSchema: string | undefined;
let beforeDatabases: string[] | undefined;
const fixtureBytes = new Map<string, string>();
async function request(path: string, cookie = '', method = 'GET', raw?: string) {
  return fetch(base + path, {
    method,
    headers: { cookie, ...(raw !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(raw !== undefined ? { body: raw } : {}),
    signal: AbortSignal.timeout(20000),
    cache: 'no-store',
  });
}
async function get(path: string, cookie: string) {
  const response = await request(path, cookie);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store', path);
  return response.json() as Promise<Row>;
}
async function rr<T>(c: pg.Client, fn: () => Promise<T>) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const value = await fn();
    await c.query('COMMIT');
    return value;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function own(c: pg.Client, tenant: string, user: string): Promise<Checkpoint> {
  const names = (
    await c.query(
      "SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions' UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1",
    )
  ).rows;
  const result: Checkpoint = {};
  for (const { table_name: name } of names) {
    assert.match(name, /^[a-z_][a-z0-9_]*$/);
    const identity = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
    const rows = (
      await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${identity}=$1 ORDER BY 1`, [
        name === 'users' ? user : tenant,
      ])
    ).rows;
    result[name] = { count: rows.length, sha256: hash(rows) };
  }
  return result;
}
async function sessions(c: pg.Client): Promise<Row[]> {
  return (await c.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY token_hash')).rows.map(
    (r) => r.row,
  );
}
async function previous(c: pg.Client, s: Row) {
  assert.equal(s.previous.length, 6, 'Six prior accepted firm checkpoints required');
  assert.equal(new Set(s.previous.map((f: Row) => f.tenant)).size, 6);
  assert.deepEqual([...new Set(s.previous.map((f: Row) => f.path))].sort(), [...oldFiles].sort());
  for (const f of s.previous) {
    assert(uuid(f.tenant) && uuid(f.user));
    assert.equal(byteHash(await readFile(f.path)), f.fixture_sha256, 'Prior fixture bytes');
    const current = await own(c, f.tenant, f.user);
    for (const [name, checkpoint] of Object.entries(f.checkpoint))
      assert.deepEqual(current[name], checkpoint, 'Prior accepted firm ' + name);
    for (const [name, value] of Object.entries(current))
      if (!f.checkpoint[name])
        assert.equal(value.count, 0, 'New table populated prior firm ' + name);
  }
}
function previewView(p: Row): Row {
  return {
    executed_order_id: p.executed_order_id ?? null,
    intent_id: p.intent_id ?? null,
    can_execute:
      !p.executed_order_id && !p.current_order_id && new Date(p.expires_at).getTime() > Date.now(),
    id: p.id,
    inbound_id: p.inbound_id,
    version: p.version,
    scope_hash: p.scope_hash,
    config: p.config,
    source: p.snapshot.source,
    rows: p.rows,
    created_at: p.created_at,
    expires_at: p.expires_at,
  };
}
async function oracle(c: pg.Client, s: Row) {
  const p = (
    await c.query('SELECT * FROM b2b_external_import_previews WHERE tenant_id=$1 AND id=$2', [
      s.buyer.tenant,
      s.preview_id,
    ])
  ).rows[0];
  const e = (
    await c.query('SELECT * FROM b2b_external_import_executions WHERE tenant_id=$1 AND id=$2', [
      s.buyer.tenant,
      s.execution_id,
    ])
  ).rows[0];
  const cert = (
    await c.query('SELECT * FROM b2b_external_import_certificates WHERE tenant_id=$1 AND id=$2', [
      s.buyer.tenant,
      s.certificate_id,
    ])
  ).rows[0];
  const inbound = (
    await c.query('SELECT * FROM inbound_orders WHERE tenant_id=$1 AND id=$2', [
      s.buyer.tenant,
      s.inbound,
    ])
  ).rows[0];
  const order = (
    await c.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2', [s.buyer.tenant, s.order_id])
  ).rows[0];
  const intent = (
    await c.query('SELECT * FROM b2b_external_order_intents WHERE tenant_id=$1 AND id=$2', [
      s.buyer.tenant,
      s.intent_id,
    ])
  ).rows[0];
  assert(p && e && cert && inbound && order && intent, 'Complete accepted source/import chain');
  assert.equal(e.preview_id, p.id);
  assert.equal(e.inbound_id, inbound.id);
  assert.equal(e.certificate_id, cert.id);
  assert.equal(e.order_id, order.id);
  assert.equal(e.intent_id, intent.id);
  assert.equal(cert.preview_id, p.id);
  assert.equal(cert.actual_order_id, order.id);
  assert.equal(cert.intent_id, intent.id);
  assert.equal(cert.state, 'complete');
  assert.equal(e.actor_id, s.buyer.user);
  assert.equal(p.actor_id, s.buyer.user);
  assert.equal(cert.actor_id, s.buyer.user);
  assert.equal(e.client_key, cert.client_key);
  assert.equal(e.request_hash, cert.request_hash);
  assert.deepEqual(e.request, cert.request);
  assert.equal(inbound.order_id, order.id);
  assert.equal(inbound.state, 'imported');
  assert.equal(inbound.imported_hash, p.snapshot.source.source_hash);
  assert.equal(inbound.source_hash, inbound.imported_hash);
  assert.equal(order.channel_id, s.channel);
  assert.equal(p.channel_id, s.channel);
  assert.equal(order.source, 'shopify');
  assert.equal(order.total, 4200);
  assert.equal(order.shipping_cost, 500);
  assert.equal(order.currency, 'PLN');
  assert.equal(order.customer_name, p.snapshot.canonical.customer_name);
  assert.equal(order.email, p.snapshot.canonical.email);
  assert.deepEqual(order.address, p.snapshot.canonical.address);
  assert.deepEqual(order.source_snapshot.items, p.snapshot.canonical.items);
  const items = (
    await c.query('SELECT * FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY id', [
      s.buyer.tenant,
      order.id,
    ])
  ).rows;
  const bindings = (
    await c.query(
      'SELECT * FROM order_source_lines WHERE tenant_id=$1 AND source_order_id=$2 ORDER BY remote_line_id',
      [s.buyer.tenant, order.id],
    )
  ).rows;
  assert.equal(items.length, 2);
  assert.equal(bindings.length, 2);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(
    cert.source_items,
    json(items),
    'Certified complete original commercial fragments',
  );
  assert.deepEqual(
    bindings.map((r: Row) => r.remote_line_id).sort(),
    [...s.remote_line_ids].sort(),
  );
  assert.deepEqual(
    items.map((i: Row) => i.line_total).sort((a: number, b: number) => a - b),
    [1700, 2000],
  );
  assert.equal(new Set(items.map((i: Row) => i.id)).size, 2);
  for (const row of p.rows) {
    const i = items.find((i: Row) => i.id === row.customer_item_id),
      b = bindings.find((b: Row) => b.remote_line_id === row.remote_line_id);
    assert(i && b);
    assert.equal(i.product_id, s.local);
    assert.equal(i.product_id, row.product_id);
    for (const key of ['quantity', 'price', 'line_total', 'vat', 'sku', 'name'])
      assert.deepEqual(i[key], row[key], 'Historical source ' + key);
    assert.equal(b.source_item_id, i.id);
    assert.equal(b.inbound_id, inbound.id);
    assert.equal(b.channel_id, s.channel);
    assert.equal(b.source_hash, inbound.source_hash);
    assert.equal(b.quantity, i.quantity);
    assert.equal(b.line_total, i.line_total);
    const frozen = intent.original_items.find((r: Row) => r.id === i.id);
    assert(frozen);
    const allocation = intent.allocations.find((r: Row) => r.customer_item_id === i.id);
    assert(allocation);
    assert.equal(allocation.local_quantity, 0);
    assert.equal(allocation.external_quantity, i.quantity);
    assert.equal(allocation.unassigned_quantity, 0);
    assert.equal(allocation.link_id, s.link);
  }
  assert.equal(intent.order_id, order.id);
  assert.equal(intent.original_items.length, 2);
  const sourceEntries = (
    await c.query(
      "SELECT kind,amount,currency,method FROM payment_entries WHERE tenant_id=$1 AND order_id=$2 AND method='source_import' ORDER BY id",
      [s.buyer.tenant, order.id],
    )
  ).rows;
  assert.deepEqual(sourceEntries, [
    {
      kind: 'receipt',
      amount: p.snapshot.canonical.paid_amount,
      currency: 'PLN',
      method: 'source_import',
    },
  ]);
  assert(p.snapshot.canonical.paid_amount > 0 && p.snapshot.canonical.paid_amount <= 4200);
  assert.equal(
    (
      await c.query(
        "SELECT count(*)::int n FROM payment_entries WHERE tenant_id=$1 AND order_id=$2 AND method='status_confirmation'",
        [s.buyer.tenant, order.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await c.query(
        'SELECT count(*)::int n FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2',
        [s.buyer.tenant, order.id],
      )
    ).rows[0].n,
    0,
  );
  const history = (
    await c.query(
      'SELECT p.*,e.order_id executed_order_id,e.intent_id,i.order_id current_order_id FROM b2b_external_import_previews p LEFT JOIN b2b_external_import_executions e ON(e.tenant_id,e.preview_id)=(p.tenant_id,p.id) JOIN inbound_orders i ON(i.tenant_id,i.id)=(p.tenant_id,p.inbound_id) WHERE p.tenant_id=$1 ORDER BY p.id',
      [s.buyer.tenant],
    )
  ).rows.map(previewView);
  return { p, e, cert, inbound, order, intent, items, bindings, sourceEntries, history };
}
async function permissions(c: pg.Client, s: Row, o: Awaited<ReturnType<typeof oracle>>) {
  for (const table of [...publicTables, ...privateTables]) {
    const metadata = (
      await c.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [table],
      )
    ).rows[0];
    assert(metadata.relrowsecurity && metadata.relforcerowsecurity, table);
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.supplier.tenant]);
      if (publicTables.includes(table))
        assert.equal(
          (
            await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
              s.buyer.tenant,
            ])
          ).rows[0].n,
          0,
        );
      else await assert.rejects(c.query(`SELECT * FROM ${table}`), (e: any) => e.code === '42501');
    } finally {
      await c.query('ROLLBACK');
    }
    if (privateTables.includes(table))
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        assert.equal(
          (await c.query("SELECT has_table_privilege('dyna_app',$1,$2) p", [table, privilege]))
            .rows[0].p,
          false,
        );
  }
  for (const [table, id] of [
    ['b2b_external_import_previews', o.p.id],
    ['b2b_external_import_executions', o.e.id],
    ['order_source_lines', o.bindings[0].id],
  ]) {
    await c.query('BEGIN');
    try {
      await assert.rejects(
        c.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND id=$2`, [s.buyer.tenant, id]),
        (e: any) => e.code === '23514',
      );
    } finally {
      await c.query('ROLLBACK');
    }
  }
  // A real complete certificate is copied with genuine globally existing source IDs, but a foreign tenant.
  // The composite parent FK must refuse this, independently of the definer-only certificate API.
  await c.query('BEGIN');
  try {
    const forged = {
      ...o.cert,
      id: randomUUID(),
      tenant_id: s.supplier.tenant,
      client_key: randomUUID(),
    };
    await assert.rejects(
      c.query(
        'INSERT INTO b2b_external_import_certificates SELECT * FROM jsonb_populate_record(NULL::b2b_external_import_certificates,$1::jsonb)',
        [JSON.stringify(forged)],
      ),
      (e: any) => e.code === '23503',
    );
  } finally {
    await c.query('ROLLBACK');
  }
}
async function freePort() {
  const probe = createServer();
  await new Promise<void>((ok, bad) => {
    probe.once('error', bad);
    probe.listen(port, '127.0.0.1', ok);
  });
  await new Promise<void>((ok, bad) => probe.close((e) => (e ? bad(e) : ok())));
}
async function stopOwnChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((ok) => child!.once('exit', () => ok()));
  child.kill('SIGTERM');
  if (!(await Promise.race([stopped.then(() => true), delay(10000).then(() => false)]))) {
    child.kill('SIGKILL');
    await stopped;
  }
}
try {
  assert.equal(process.argv.length, 2);
  const metadata = await lstat(statePath);
  assert(metadata.isFile());
  assert.equal(metadata.mode & 0o077, 0);
  const bytes = await readFile(statePath);
  fixtureBytes.set(statePath, byteHash(bytes));
  const s = JSON.parse(bytes.toString()) as Row;
  assert.equal(s.setup_complete, true, 'Completed isolated setup required');
  assert(!s.pending, 'No unresolved setup action may be adopted');
  assert(
    s.accepted_checkpoint?.buyer && s.accepted_checkpoint?.supplier,
    'Actual accepted UI/API checkpoint required',
  );
  assert(s.accepted_at, 'Actual accepted checkpoint timestamp required');
  for (const id of [
    s.buyer?.tenant,
    s.buyer?.user,
    s.supplier?.tenant,
    s.supplier?.user,
    s.channel,
    s.inbound,
    s.local,
    s.link,
    s.order_id,
    s.intent_id,
    s.preview_id,
    s.execution_id,
    s.certificate_id,
  ])
    assert(uuid(id), 'Missing accepted fixture identity');
  assert.equal(s.remote_line_ids.length, 2);
  assert.equal(new Set(s.remote_line_ids).size, 2);
  for (const path of oldFiles) fixtureBytes.set(path, byteHash(await readFile(path)));
  const expected = process.env.QA_EXPECTED_REVISION;
  assert(
    expected && /^[a-f0-9]{7,40}$/.test(expected),
    'Expected current source revision required',
  );
  const healthResponse = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });
  assert.equal(healthResponse.status, 200);
  const live = (await healthResponse.json()) as Row;
  assert.equal(live.revision, expected);
  assert.equal(live.schema_revision, schema);
  assert(live.b2b_external_order_imports_available && !live.restore_preview);
  assert.equal(s.schema_revision, schema);
  assert.equal(s.runtime_revision, expected, 'Immutable accepted setup/runtime revision');
  process.env.APP_REVISION = expected;
  beforeDatabases = (
    await pool.query('SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname')
  ).rows.map((r: Row) => r.datname);
  source = new pg.Client(localDatabase());
  await source.connect();
  const before = await rr(source, async () => {
    await previous(source!, s);
    return {
      buyer: await own(source!, s.buyer.tenant, s.buyer.user),
      supplier: await own(source!, s.supplier.tenant, s.supplier.user),
      manifest: await tableFingerprints(source!),
      schema: await schemaFingerprint(source!),
      sessions: await sessions(source!),
      oracle: await oracle(source!, s),
    };
  });
  beforeManifest = before.manifest;
  beforeSchema = before.schema;
  assert.deepEqual(before.buyer, s.accepted_checkpoint.buyer, 'Accepted buyer checkpoint');
  assert.deepEqual(before.supplier, s.accepted_checkpoint.supplier, 'Accepted supplier checkpoint');
  assert.deepEqual(Object.keys(s.buyer_physical_baseline).sort(), [...physicalTables].sort());
  for (const table of physicalTables)
    assert.deepEqual(
      before.buyer[table],
      s.buyer_physical_baseline[table],
      'Original buyer physical ' + table,
    );
  phase = 'encrypted-backup-and-own-restore';
  const runId = randomUUID();
  const backup = await createBackup({ directory: resolve('data', 'qa127b-backups', runId) });
  const restored = await restoreBackup(backup.file, {
    directory: resolve('data', 'qa127b-restores', runId),
  });
  database = restoreDatabaseName(restored.database);
  assert(!beforeDatabases.includes(database), 'Cleanup target must be newly created own copy');
  assert(
    restored.row_fingerprints_match && restored.schema_fingerprint_match && restored.preview_only,
  );
  assert.equal(restored.worker_enabled, false);
  assert.equal(restored.revision, expected);
  copy = new pg.Client({ ...localDatabase(), database });
  await copy.connect();
  const recovered = await rr(copy, async () => {
    await previous(copy!, s);
    return {
      buyer: await own(copy!, s.buyer.tenant, s.buyer.user),
      supplier: await own(copy!, s.supplier.tenant, s.supplier.user),
      manifest: await tableFingerprints(copy!),
      schema: await schemaFingerprint(copy!),
      sessions: await sessions(copy!),
      oracle: await oracle(copy!, s),
    };
  });
  assert.deepEqual(recovered.manifest, before.manifest);
  assert.equal(recovered.schema, before.schema);
  assert.deepEqual(recovered.buyer, before.buyer);
  assert.deepEqual(recovered.supplier, before.supplier);
  assert.deepEqual(recovered.sessions, before.sessions);
  assert.deepEqual(
    json(recovered.oracle),
    json(before.oracle),
    'All immutable/source/finance rows exact',
  );
  assert.equal(
    (await copy.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
    schema,
  );
  phase = 'copy-RLS-private-immutable-and-FK';
  await permissions(copy, s, recovered.oracle);
  phase = 'owned-readonly-server';
  await freePort();
  logHandle = await open(resolve(restored.directory, 'qa127b-preview.log'), 'wx', 0o600);
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
      env: { ...process.env, DYNA_PREVIEW_PORT: String(port), APP_REVISION: expected },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    },
  );
  child.once('error', () => {
    spawnError = true;
  });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    assert(!spawnError && child.exitCode === null, 'Own preview process exited');
    try {
      const r = await request('/health');
      if (r.ok) {
        const h = (await r.json()) as Row;
        assert.equal(h.revision, expected);
        assert.equal(h.schema_revision, schema);
        assert(h.restore_preview && h.b2b_external_order_imports_available);
        ready = true;
        break;
      }
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
    await delay(200);
  }
  assert(ready, 'Bounded own preview readiness');
  const cookies: Record<string, string> = {};
  for (const side of ['buyer', 'supplier']) {
    const f = s[side];
    assert(typeof f.cookie === 'string' && f.cookie.startsWith('dyna_session='));
    assert.equal((await request('/auth/me', f.cookie)).status, 401, 'Main cookie refused by copy');
    const login = await request(
      '/auth/login',
      '',
      'POST',
      JSON.stringify({ email: f.email, password: f.password }),
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(cookie && cookie.startsWith(`dyna_session_preview_${port}=`));
    cookies[side] = cookie;
    const me = await get('/auth/me', cookie);
    assert.equal(me.user.id, f.user);
    assert.equal(me.user.tenant_id, f.tenant);
    assert.equal(me.user.role, 'admin');
    const main = await fetch('http://127.0.0.1:4100/api/auth/me', {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    assert.equal(main.status, 401, 'Copy cookie refused by main');
  }
  const history: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 21; page++) {
    const r = await get(
      '/import-external-intent-previews?limit=100' + (cursor ? '&cursor=' + cursor : ''),
      cookies.buyer,
    );
    assert(r.read_only && !r.can_manage && r.available);
    assert(r.data.length <= 100);
    history.push(...r.data);
    cursor = r.meta.cursor ?? undefined;
    if (!cursor) break;
    assert(page < 20, 'Bounded preview history');
  }
  assert.equal(new Set(history.map((r) => r.id)).size, history.length);
  assert.deepEqual(
    history,
    json(before.oracle.history),
    'Exact accepted history heads/rows/source projections',
  );
  const detail = await get('/import-external-intent-previews/' + s.preview_id, cookies.buyer);
  assert(detail.read_only && !detail.can_manage && detail.available);
  assert.deepEqual(
    detail.preview,
    json(
      previewView({ ...before.oracle.p, executed_order_id: s.order_id, intent_id: s.intent_id }),
    ),
  );
  const sourceClosed = await request(
    '/imports/' + s.inbound + '/external-intent-source',
    cookies.buyer,
  );
  assert.equal(sourceClosed.status, 409, 'Imported source cannot silently create a new preview');
  assert.equal(sourceClosed.headers.get('cache-control'), 'no-store');
  const order = await get('/orders/' + s.order_id, cookies.buyer);
  assert.equal(order.total, 4200);
  assert.equal(order.currency, 'PLN');
  assert.equal(order.status, before.oracle.order.status);
  assert.equal(order.payment.received, before.oracle.p.snapshot.canonical.paid_amount);
  assert.equal(order.payment.amount_due, 4200 - before.oracle.p.snapshot.canonical.paid_amount);
  assert.equal(order.items.length, 2);
  assert.equal(order.picking_items.length, 0);
  for (const i of before.oracle.items) {
    const row = order.items.find((r: Row) => r.id === i.id);
    assert(row);
    for (const key of [
      'product_id',
      'quantity',
      'price',
      'line_total',
      'vat',
      'scanned',
      'components',
    ])
      assert.deepEqual(row[key], i[key]);
  }
  const intent = await get('/b2b/external-order-intents/orders/' + s.order_id, cookies.buyer);
  assert(intent.read_only && !intent.can_manage);
  assert.equal(intent.intent.id, s.intent_id);
  assert.equal(intent.intent.version, before.oracle.intent.version);
  for (const allocation of before.oracle.intent.allocations) {
    const row = intent.intent.items.find(
      (r: Row) => r.customer_item_id === allocation.customer_item_id,
    );
    assert(row);
    for (const key of ['local_quantity', 'external_quantity', 'unassigned_quantity', 'link_id'])
      assert.deepEqual(row[key], allocation[key]);
  }
  const writes = [
    '/imports/' + s.inbound + '/external-intent-previews',
    '/import-external-intent-previews/' + s.preview_id + '/execute',
  ];
  for (const path of writes) {
    const denied = await request(path, cookies.buyer, 'POST', '{"malformed":');
    assert.equal(denied.status, 423, path + ' before JSON parse');
    assert.equal(denied.headers.get('cache-control'), 'no-store');
  }
  const foreign = await request(
    '/import-external-intent-previews/' + s.preview_id,
    cookies.supplier,
  );
  assert.equal(foreign.status, 404);
  assert.equal(foreign.headers.get('cache-control'), 'no-store');
  const after = await rr(copy, async () => {
    await previous(copy!, s);
    return {
      buyer: await own(copy!, s.buyer.tenant, s.buyer.user),
      supplier: await own(copy!, s.supplier.tenant, s.supplier.user),
      manifest: await tableFingerprints(copy!),
      schema: await schemaFingerprint(copy!),
      sessions: await sessions(copy!),
    };
  });
  assert.deepEqual(after.buyer, before.buyer);
  assert.deepEqual(after.supplier, before.supplier);
  assert.equal(after.schema, before.schema);
  for (const [name, fp] of Object.entries(before.manifest))
    if (name !== 'sessions')
      assert.deepEqual(after.manifest[name], fp, 'Copy changed non-session table ' + name);
  const oldSessions = new Map(before.sessions.map((s) => [s.token_hash, hash(s)]));
  for (const old of before.sessions)
    assert.equal(
      hash(after.sessions.find((s) => s.token_hash === old.token_hash)),
      oldSessions.get(old.token_hash),
      'All prior sessions exact',
    );
  const added = after.sessions.filter((s) => !oldSessions.has(s.token_hash));
  assert.equal(added.length, 2);
  for (const side of ['buyer', 'supplier'])
    assert.equal(
      added.filter((r) => r.user_id === s[side].user && r.tenant_id === s[side].tenant).length,
      1,
    );
  report = {
    stage: '127B',
    status: 'PASS',
    verified_at: new Date().toISOString(),
    revision: expected,
    schema,
    restore_tables: restored.tables,
    encrypted_records_verified: restored.encrypted_records_verified,
    whole_row_manifest_exact: true,
    schema_fingerprint_exact: true,
    buyer_own_tables: Object.keys(before.buyer).length,
    supplier_own_tables: Object.keys(before.supplier).length,
    prior_firms_exact: 6,
    prior_private_files_exact: 4,
    preview_id: s.preview_id,
    execution_id: s.execution_id,
    certificate_id: s.certificate_id,
    order_id: s.order_id,
    intent_id: s.intent_id,
    immutable_chain_source_SQL_HTTP_exact: true,
    history_count: history.length,
    source_lines: 2,
    source_line_totals_minor: [2000, 1700],
    source_total_minor: 4200,
    source_received_minor: before.oracle.p.snapshot.canonical.paid_amount,
    buyer_physical_tables_exact: 19,
    force_RLS_tables: publicTables.length + privateTables.length,
    private_SELECT_SQLSTATE: '42501',
    immutable_SQLSTATE: '23514',
    foreign_certificate_FK_SQLSTATE: '23503',
    copied_sessions_added: 2,
    main_cookie_on_copy: 401,
    copy_cookie_on_main: 401,
    foreign_preview: 404,
    imported_source: 409,
    read_only_writes: writes.map(() => 423),
    worker_enabled: false,
    provider_calls_during_restore: 0,
    provider_evidence:
      'Local GET source history/order/intent only; no preview/execute/provider worker launched',
    goal_complete: false,
  };
} catch (e) {
  await writeFile(
    resolve('data', 'source-order-intent-recovery-failure-' + randomUUID() + '.txt'),
    'Phase: ' + phase + '\n' + (e instanceof Error ? (e.stack ?? e.message) : String(e)),
    { mode: 0o600, flag: 'wx' },
  );
  const error = e as { code?: string; name?: string };
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        stage: '127B',
        status: 'FAIL',
        phase,
        error_name: error.name,
        error_code: error.code,
        goal_complete: false,
      },
      null,
      2,
    ) + '\n',
  );
  // Assertion operands may contain private source snapshots; never echo them into a public run log.
  throw new Error(
    'QA127B recovery proof failed during ' + phase + '; see sanitized recovery report',
  );
} finally {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(e);
    }
  };
  await attempt(stopOwnChild);
  await attempt(async () => {
    await logHandle?.close();
  });
  await attempt(async () => {
    await copy?.end();
  });
  if (database)
    await attempt(() => pool.query(`DROP DATABASE ${restoreDatabaseName(database!)} WITH (FORCE)`));
  if (beforeDatabases)
    await attempt(async () => {
      const after = (
        await pool.query(
          'SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname',
        )
      ).rows.map((r: Row) => r.datname);
      assert.deepEqual(
        after,
        beforeDatabases,
        'All original database names preserved after only own copy cleanup',
      );
      if (report) {
        report.original_databases_preserved = true;
        report.original_database_count = beforeDatabases!.length;
        report.original_database_names_sha256 = hash(beforeDatabases);
      }
    });
  if (source && beforeManifest)
    await attempt(async () => {
      const after = await rr(source!, async () => ({
        manifest: await tableFingerprints(source!),
        schema: await schemaFingerprint(source!),
      }));
      assert.deepEqual(
        after.manifest,
        beforeManifest,
        'All original source rows exact after cleanup',
      );
      assert.equal(after.schema, beforeSchema, 'All original source schema exact');
    });
  await attempt(async () => {
    for (const [path, digest] of fixtureBytes)
      assert.equal(byteHash(await readFile(path)), digest, 'Private fixture bytes unchanged');
  });
  await attempt(async () => {
    await source?.end();
  });
  await attempt(() => pool.end());
  if (errors.length) {
    await writeFile(
      resolve('data', 'source-order-intent-recovery-cleanup-' + randomUUID() + '.txt'),
      errors.map((e) => (e instanceof Error ? (e.stack ?? e.message) : String(e))).join('\n\n'),
      { mode: 0o600, flag: 'wx' },
    );
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          stage: '127B',
          status: 'FAIL',
          phase: 'cleanup-and-source-preservation',
          cleanup_failures: errors.length,
          goal_complete: false,
        },
        null,
        2,
      ) + '\n',
    );
    throw new Error(
      'QA127B owned cleanup/source preservation failed; see sanitized recovery report',
    );
  }
  if (report) {
    report.own_copy_removed = true;
    report.source_all_rows_and_schema_exact = true;
    report.all_private_fixture_bytes_unchanged = true;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
}
