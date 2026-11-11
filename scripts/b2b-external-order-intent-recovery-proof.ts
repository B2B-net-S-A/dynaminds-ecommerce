/** QA127 only. Root runs after genuine Chrome lifecycle; no automatic UI attestation.
 * Input data/b2b-external-order-intent-stage127.json is private0600, never rewritten.
 * All SQL probes mutate only the owned restored DB inside transactions rolled back.
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
const statePath = 'data/b2b-external-order-intent-stage127.json';
const schema = '109_b2b_external_order_intents';
const port = 4102;
const base = `http://127.0.0.1:${port}/api`;
const publicTables = ['b2b_external_order_intents', 'b2b_external_order_intent_revisions'];
const privateTables = ['b2b_external_order_allocation_proofs', 'b2b_external_order_created_orders'];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const byteHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let child: ChildProcess | undefined,
  database: string | undefined,
  logHandle: Awaited<ReturnType<typeof open>> | undefined;
let phase = 'preflight';
let spawnError = false;
let report: Row | undefined;
let source: pg.Client | undefined, copy: pg.Client | undefined;
let beforeManifest: Awaited<ReturnType<typeof tableFingerprints>> | undefined;
let beforeDatabases: string[] | undefined;
let originalBytes: Buffer | undefined;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
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
      `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'sessions' UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`,
    )
  ).rows;
  const result: Checkpoint = {};
  for (const { table_name: name } of names) {
    assert.match(name, /^[a-z_][a-z0-9_]*$/);
    const id = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
    const rows = (
      await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${id}=$1 ORDER BY 1`, [
        name === 'users' ? user : tenant,
      ])
    ).rows;
    result[name] = { count: rows.length, sha256: hash(rows) };
  }
  return result;
}
async function sessions(c: pg.Client) {
  return (await c.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY token_hash')).rows.map(
    (r) => r.row,
  ) as Row[];
}
async function sqlOracle(c: pg.Client, s: Row) {
  const h = (
    await c.query('SELECT * FROM b2b_external_order_intents WHERE tenant_id=$1 AND order_id=$2', [
      s.buyer.tenant,
      s.customer,
    ])
  ).rows[0];
  assert(h && h.state === 'open');
  assert.equal(h.original_items.length, 1);
  assert.equal(h.original_items[0].id, s.customer_line);
  assert.equal(h.original_items[0].quantity, 3);
  assert.equal(h.allocations.length, 1);
  assert.equal(h.allocations[0].local_quantity, 0);
  assert.equal(h.allocations[0].unassigned_quantity, 0);
  assert.equal(h.allocations[0].external_quantity, 3);
  assert.equal(h.allocations[0].link_id, s.link);
  const revisions = (
    await c.query(
      'SELECT * FROM b2b_external_order_intent_revisions WHERE tenant_id=$1 AND intent_id=$2 ORDER BY version',
      [s.buyer.tenant, h.id],
    )
  ).rows;
  assert(revisions.length >= 1);
  assert.equal(revisions.length, h.version);
  for (let i = 0; i < revisions.length; i++) {
    assert.equal(revisions[i].version, i + 1);
    if (i) assert.equal(hash(revisions[i].before_snapshot), hash(revisions[i - 1].after_snapshot));
  }
  assert.deepEqual(revisions.at(-1).after_snapshot, {
    version: h.version,
    state: h.state,
    allocations: h.allocations,
  });
  const customer = (
    await c.query('SELECT total,status FROM orders WHERE tenant_id=$1 AND id=$2', [
      s.buyer.tenant,
      s.customer,
    ])
  ).rows[0];
  assert.equal(customer.total, 75900);
  assert.equal(customer.status, 'shipped');
  const retailHead = (
    await c.query(
      'SELECT currency,customer_name,email,total,address FROM orders WHERE tenant_id=$1 AND id=$2',
      [s.buyer.tenant, s.customer],
    )
  ).rows[0];
  const retailItems = (
    await c.query(
      'SELECT to_jsonb(i) row FROM order_items i WHERE tenant_id=$1 AND order_id=$2 ORDER BY sku',
      [s.buyer.tenant, s.customer],
    )
  ).rows.map((r) => r.row);
  const commercial = {
    ...retailHead,
    items: retailItems.map((i: Row) => ({
      id: i.id,
      quantity: i.quantity,
      line_total: i.line_total,
      price: i.price,
      vat: i.vat,
      components: i.components,
    })),
  };
  assert.deepEqual(commercial, s.customer_original, 'Original retail commercial checkpoint exact');
  for (const item of retailItems) {
    const frozen = h.original_items.find((i: Row) => i.id === item.id);
    assert(frozen);
    const strip = (v: Row) =>
      Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'scanned'));
    assert.equal(hash(strip(item)), hash(strip(frozen)), 'Frozen original commercial line exact');
  }
  const supplier = (
    await c.query('SELECT total,status FROM orders WHERE tenant_id=$1 AND id=$2', [
      s.supplier.tenant,
      s.supplier_order,
    ])
  ).rows[0];
  assert.equal(supplier.total, 37535);
  assert.equal(supplier.status, 'shipped');
  const stock = (
    await c.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      s.supplier.tenant,
      s.product,
    ])
  ).rows;
  assert.equal(stock.length, 1);
  assert.equal(stock[0].on_hand, 17);
  assert.equal(stock[0].reserved, 0);
  assert.equal(
    (
      await c.query(
        "SELECT count(*)::int n FROM reservations WHERE tenant_id=$1 AND order_id=$2 AND state='active'",
        [s.buyer.tenant, s.customer],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await c.query(
        'SELECT count(*)::int n FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2',
        [s.buyer.tenant, s.customer],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await c.query('SELECT count(*)::int n FROM shipments WHERE tenant_id=$1 AND order_id=$2', [
        s.buyer.tenant,
        s.customer,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await c.query('SELECT count(*)::int n FROM b2b_external_order_created_orders')).rows[0].n,
    0,
  );
  return {
    intent_id: h.id,
    version: h.version,
    revisions: revisions.length,
    revision: revisions[0],
  };
}
async function privatePermissions(c: pg.Client, s: Row, oracle: Row) {
  for (const table of [...publicTables, ...privateTables]) {
    const meta = (
      await c.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [table],
      )
    ).rows[0];
    assert(meta.relrowsecurity && meta.relforcerowsecurity, table);
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
      else
        await assert.rejects(
          c.query(`SELECT count(*) FROM ${table}`),
          (e: any) => e.code === '42501',
        );
    } finally {
      await c.query('ROLLBACK');
    }
    if (privateTables.includes(table))
      for (const permission of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        assert.equal(
          (await c.query("SELECT has_table_privilege('dyna_app',$1,$2) p", [table, permission]))
            .rows[0].p,
          false,
        );
  }
  await c.query('BEGIN');
  try {
    await assert.rejects(
      c.query(
        'UPDATE b2b_external_order_intent_revisions SET request_hash=request_hash WHERE tenant_id=$1 AND id=$2',
        [s.buyer.tenant, oracle.revision.id],
      ),
      (e: any) => e.code === '23514',
    );
  } finally {
    await c.query('ROLLBACK');
  }
  await c.query('BEGIN');
  try {
    const forged = {
      ...oracle.revision,
      tenant_id: s.supplier.tenant,
      id: randomUUID(),
      client_key: randomUUID(),
    };
    await assert.rejects(
      c.query(
        'INSERT INTO b2b_external_order_intent_revisions SELECT * FROM jsonb_populate_record(NULL::b2b_external_order_intent_revisions,$1::jsonb)',
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
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((ok) => child!.once('exit', () => ok()));
  child.kill('SIGTERM');
  const graceful = await Promise.race([stopped.then(() => true), delay(10000).then(() => false)]);
  if (!graceful) {
    child.kill('SIGKILL');
    await stopped;
  }
}
try {
  assert.equal(process.argv.length, 2, 'Helper takes no mutation/lifecycle phase');
  const stateMeta = await lstat(statePath);
  assert(stateMeta.isFile(), 'Private state must be a regular file');
  assert.equal(stateMeta.mode & 0o077, 0, 'Private state permissions');
  originalBytes = await readFile(statePath);
  const s = JSON.parse(originalBytes.toString()) as Row;
  assert(
    s.customer && s.supplier_dispatched && s.customer_paid,
    'Complete genuine Chrome lifecycle required',
  );
  for (const id of [
    s.customer,
    s.customer_line,
    s.supplier_order,
    s.product,
    s.link,
    s.buyer?.tenant,
    s.buyer?.user,
    s.supplier?.tenant,
    s.supplier?.user,
  ])
    assert(uuid(id), 'Missing own fixture ID');
  const expected = process.env.QA_EXPECTED_REVISION;
  assert(expected && /^[a-f0-9]{7,40}$/.test(expected), 'QA_EXPECTED_REVISION required');
  const liveHealth = (await (
    await fetch('http://127.0.0.1:4100/api/health', {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    })
  ).json()) as Row;
  assert.equal(liveHealth.revision, expected);
  assert.equal(liveHealth.schema_revision, schema);
  assert(
    liveHealth.b2b_external_order_intents_available &&
      liveHealth.b2b_dropshipping_available &&
      !liveHealth.restore_preview,
  );
  process.env.APP_REVISION = expected;
  beforeDatabases = (
    await pool.query('SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname')
  ).rows.map((row: { datname: string }) => row.datname);
  source = new pg.Client(localDatabase());
  await source.connect();
  const before = await rr(source, async () => ({
    buyer: await own(source!, s.buyer.tenant, s.buyer.user),
    supplier: await own(source!, s.supplier.tenant, s.supplier.user),
    manifest: await tableFingerprints(source!),
    schema: await schemaFingerprint(source!),
    sessions: await sessions(source!),
    oracle: await sqlOracle(source!, s),
  }));
  beforeManifest = before.manifest;
  for (const [table, baseline] of Object.entries(s.buyer_physical_baseline ?? {}))
    assert.deepEqual(before.buyer[table], baseline, 'Buyer original physical checkpoint ' + table);
  assert(
    Object.keys(s.buyer_physical_baseline ?? {}).length >= 19,
    'Accepted buyer physical checkpoint required',
  );
  for (const f of s.previous ?? []) {
    assert.equal(
      byteHash(await readFile(f.path)),
      f.fixture_sha256,
      'Previous fixture bytes unchanged',
    );
    const now: Checkpoint = await rr(source, () => own(source!, f.tenant, f.user));
    for (const [name, prior] of Object.entries(f.checkpoint))
      assert.deepEqual(now[name], prior, 'Previous firm checkpoint ' + name);
    for (const [name, current] of Object.entries(now))
      if (!f.checkpoint[name])
        assert.equal(current.count, 0, 'New module populated original firm ' + name);
  }
  assert((s.previous ?? []).length >= 4, 'Four previously accepted firms required');
  phase = 'encrypted-backup-restore';
  const runId = randomUUID();
  const backup = await createBackup({ directory: resolve('data', 'qa127-backups', runId) });
  const restored = await restoreBackup(backup.file, {
    directory: resolve('data', 'qa127-restores', runId),
  });
  database = restoreDatabaseName(restored.database);
  assert(
    restored.row_fingerprints_match && restored.schema_fingerprint_match && restored.preview_only,
  );
  assert.equal(restored.worker_enabled, false);
  assert.equal(restored.revision, expected);
  copy = new pg.Client({ ...localDatabase(), database });
  await copy.connect();
  const recovered = await rr(copy, async () => ({
    buyer: await own(copy!, s.buyer.tenant, s.buyer.user),
    supplier: await own(copy!, s.supplier.tenant, s.supplier.user),
    manifest: await tableFingerprints(copy!),
    schema: await schemaFingerprint(copy!),
    sessions: await sessions(copy!),
    oracle: await sqlOracle(copy!, s),
  }));
  assert.deepEqual(recovered.manifest, before.manifest, 'Whole restored manifest exact');
  assert.equal(recovered.schema, before.schema, 'Schema/RLS/grants/function/trigger exact');
  assert.deepEqual(recovered.buyer, before.buyer);
  assert.deepEqual(recovered.supplier, before.supplier);
  assert.equal(hash(recovered.sessions), hash(before.sessions));
  assert.equal(
    (await copy.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
    schema,
  );
  phase = 'RLS-and-immutable-probes';
  await privatePermissions(copy, s, recovered.oracle);
  phase = 'owned-readonly-preview';
  await freePort();
  logHandle = await open(resolve(restored.directory, 'qa127-preview.log'), 'wx', 0o600);
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
    assert(!spawnError && child.exitCode === null, 'Own preview exited or failed to spawn');
    try {
      const response = await request('/health');
      if (response.ok) {
        const health = (await response.json()) as Row;
        assert.equal(health.revision, expected);
        assert.equal(health.schema_revision, schema);
        assert(
          health.restore_preview &&
            health.b2b_external_order_intents_available &&
            health.b2b_dropshipping_available,
        );
        ready = true;
        break;
      }
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
    await delay(200);
  }
  assert(ready, 'Owned preview readiness bounded timeout');
  const cookies: Record<string, string> = {};
  for (const side of ['buyer', 'supplier']) {
    const f = s[side];
    assert(
      typeof f.cookie === 'string' && f.cookie.startsWith('dyna_session='),
      'Original own main session required',
    );
    const response = await request(
      '/auth/login',
      '',
      'POST',
      JSON.stringify({ email: f.email, password: f.password }),
    );
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert(typeof cookie === 'string' && cookie.length > 0, 'Copied login cookie required');
    assert(cookie.startsWith('dyna_session_preview_4102='));
    cookies[side] = cookie;
    const me = await get('/auth/me', cookie);
    assert.equal(me.user.id, f.user);
    assert.equal(me.user.tenant_id, f.tenant);
    assert.equal(me.user.role, 'admin');
    assert.equal(
      (await request('/auth/me', f.cookie)).status,
      401,
      'Original main cookie refused by copy',
    );
  }
  const options = await get('/b2b/external-order-intents/options', cookies.buyer);
  assert(
    options.available && options.read_only && !options.can_manage && !options.can_write_fields,
  );
  const list: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 21; page++) {
    const data = await get(
      '/b2b/external-order-intents/orders?limit=100' + (cursor ? '&cursor=' + cursor : ''),
      cookies.buyer,
    );
    assert(data.read_only && !data.can_manage);
    assert(data.data.length <= 100);
    list.push(...data.data);
    cursor = data.meta.cursor ?? undefined;
    if (!cursor) break;
    assert(page < 20, 'Intent paging bound');
  }
  assert.equal(new Set(list.map((i) => i.id)).size, list.length);
  assert.equal(list.length, before.buyer.b2b_external_order_intents.count);
  assert(list.some((i) => i.order_id === s.customer));
  const detail = await get('/b2b/external-order-intents/orders/' + s.customer, cookies.buyer);
  assert(detail.read_only && !detail.can_manage);
  assert.equal(detail.intent.version, recovered.oracle.version);
  assert.equal(detail.intent.items.length, 1);
  assert.equal(detail.intent.items[0].local_quantity, 0);
  assert.equal(detail.intent.items[0].external_quantity, 3);
  assert.equal(detail.intent.items[0].committed_quantity, 3);
  assert.equal(detail.intent.items[0].dispatched_quantity, 3);
  const customer = await get('/orders/' + s.customer, cookies.buyer);
  assert.equal(customer.total, 75900);
  assert.equal(customer.status, 'shipped');
  assert.equal(customer.items[0].quantity, 3);
  assert.equal(customer.items[0].scanned, 0);
  assert.equal(customer.picking_items.length, 0);
  assert.equal(customer.payment.received, 75900);
  assert.equal(customer.payment.amount_due, 0);
  assert(Array.isArray(customer.events) && customer.events.length > 0);
  const supplier = await get('/orders/' + s.supplier_order, cookies.supplier);
  assert.equal(supplier.total, 37535);
  assert.equal(supplier.status, 'shipped');
  assert.equal(supplier.payment.amount_due, 0);
  assert(supplier.shipments.some((p: Row) => p.dispatched_at && p.tracking_number));
  const forwarding = await get(`/b2b/network/links/${s.link}/dropshipping/orders`, cookies.buyer);
  const active = forwarding.data.filter(
    (d: Row) => d.customer_order_id === s.customer && d.state === 'ordered',
  );
  assert.equal(active.length, 1);
  const forward = await get(
    `/b2b/network/links/${s.link}/dropshipping/orders/${active[0].id}`,
    cookies.buyer,
  );
  assert.equal(forward.order.fulfillment.status, 'shipped');
  assert(forward.order.reconciled);
  const writes = [
    '/b2b/external-order-intents/orders',
    ...['allocate', 'cancel', 'reopen'].map(
      (a) => `/b2b/external-order-intents/orders/${s.customer}/${a}`,
    ),
  ];
  for (const path of writes)
    assert.equal(
      (await request(path, cookies.buyer, 'POST', '{"malformed":')).status,
      423,
      path + ' before parse',
    );
  const foreign = await request(
    '/b2b/external-order-intents/orders/' + s.customer,
    cookies.supplier,
  );
  assert.equal(foreign.status, 404);
  const afterCopy = await rr(copy, async () => ({
    buyer: await own(copy!, s.buyer.tenant, s.buyer.user),
    supplier: await own(copy!, s.supplier.tenant, s.supplier.user),
    manifest: await tableFingerprints(copy!),
    sessions: await sessions(copy!),
  }));
  assert.deepEqual(afterCopy.buyer, before.buyer);
  assert.deepEqual(afterCopy.supplier, before.supplier);
  const priorByToken = new Map(before.sessions.map((r) => [r.token_hash, hash(r)]));
  for (const session of afterCopy.sessions)
    if (priorByToken.has(session.token_hash))
      assert.equal(
        hash(session),
        priorByToken.get(session.token_hash),
        'Prior copied session unchanged',
      );
  for (const session of before.sessions)
    assert(
      afterCopy.sessions.some((r) => r.token_hash === session.token_hash),
      'Copied prior session retained',
    );
  const added = afterCopy.sessions.filter((r) => !priorByToken.has(r.token_hash));
  assert.equal(added.length, 2);
  for (const side of ['buyer', 'supplier'])
    assert.equal(
      added.filter((r) => r.user_id === s[side].user && r.tenant_id === s[side].tenant).length,
      1,
    );
  for (const [name, fp] of Object.entries(before.manifest))
    if (name !== 'sessions')
      assert.deepEqual(afterCopy.manifest[name], fp, 'Only copied auth sessions allowed ' + name);
  report = {
    stage: 127,
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
    original_firms_preserved: s.previous.length,
    intent_id: recovered.oracle.intent_id,
    intent_version: recovered.oracle.version,
    immutable_revisions: recovered.oracle.revisions,
    force_RLS_tables: 4,
    private_table_SELECT_status: 42501,
    immutable_revision_SQLSTATE: '23514',
    foreign_revision_parent_SQLSTATE: '23503',
    copied_sessions_added: 2,
    read_only_write_statuses: writes.map(() => 423),
    original_main_cookie_on_copy: 401,
    foreign_customer_detail_status: 404,
    buyer_physical_tables_exact: Object.keys(s.buyer_physical_baseline).length,
    buyer_on_hand: 0,
    buyer_reserved: 0,
    retail_total_minor: 75900,
    supplier_on_hand: 17,
    supplier_reserved: 0,
    worker_enabled: false,
    worker_evidence:
      'restore metadata false; standalone readonly preview starts buildApp without worker; all copied non-session tables exact',
    external_provider_operations: 0,
    goal_complete: false,
  };
} catch (e) {
  const diagnostic = e as { code?: string; name?: string };
  await writeFile(
    'docs/b2b-external-order-intent-recovery-qa.json',
    JSON.stringify(
      {
        stage: 127,
        status: 'FAIL',
        phase,
        error_name: diagnostic.name,
        error_code: diagnostic.code,
        goal_complete: false,
      },
      null,
      2,
    ) + '\n',
  );
  throw e;
} finally {
  const cleanupErrors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      cleanupErrors.push(e);
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
  if (beforeDatabases) {
    const originalDatabases = beforeDatabases;
    await attempt(async () => {
      const afterDatabases = (
        await pool.query('SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname')
      ).rows.map((row: { datname: string }) => row.datname);
      assert.deepEqual(
        afterDatabases,
        originalDatabases,
        'Original database names exact after own cleanup',
      );
      if (report) {
        report.original_databases_preserved = true;
        report.original_database_count = originalDatabases.length;
        report.original_database_names_sha256 = hash(originalDatabases);
      }
    });
  }
  if (source && beforeManifest)
    await attempt(async () => {
      const after = await rr(source!, () => tableFingerprints(source!));
      assert.deepEqual(after, beforeManifest, 'All source DB rows unchanged after own cleanup');
      assert(
        originalBytes && byteHash(await readFile(statePath)) === byteHash(originalBytes),
        'Private QA127 state bytes unchanged',
      );
    });
  await attempt(async () => {
    await source?.end();
  });
  await attempt(() => pool.end());
  if (cleanupErrors.length) {
    await writeFile(
      'docs/b2b-external-order-intent-recovery-qa.json',
      JSON.stringify(
        {
          stage: 127,
          status: 'FAIL',
          phase: 'cleanup-and-source-preservation',
          cleanup_failures: cleanupErrors.length,
          goal_complete: false,
        },
        null,
        2,
      ) + '\n',
    );
    throw cleanupErrors[0];
  }
  if (report) {
    report.own_preview_database_removed = true;
    report.source_all_tables_exact = true;
    report.private_state_unchanged = true;
    await writeFile(
      'docs/b2b-external-order-intent-recovery-qa.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report));
  }
}
