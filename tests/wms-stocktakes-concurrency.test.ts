import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { backendPid, waitForLockEdge } from './lock-edge-helper';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
const prefix = '/wms-lots/stocktakes';
type Json = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '',
  tenant = '',
  warehouse = '',
  admin = '',
  ip = 1,
  providerCalls = 0;
const req = (path: string, method: 'GET' | 'POST' = 'GET', body?: Json) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie },
    remoteAddress: '127.0.125.' + ip,
  });
async function ok(path: string, method: 'GET' | 'POST' = 'GET', body?: Json): Promise<Json> {
  const r = await req(path, method, body);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.statusCode}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.WMS_TEST_LOG === 'true',
    integrationTransport: async () => {
      ++providerCalls;
      throw Error('Concurrent stocktake posting must never call providers');
    },
  });
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  admin = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Concurrent lot stocktake','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    admin,
  ]);
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Counted warehouse','CONCURRENT')",
    [warehouse, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

async function fixture() {
  const product = await ok('/products', 'POST', {
    sku: 'CONCURRENT-' + randomUUID(),
    name: 'Physical counted product',
    price: 2500,
    warehouse_id: warehouse,
    quantity: 10,
    location: 'A-01',
  });
  const stock = (
    await pool.query(
      'SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, product.id],
    )
  ).rows[0];
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'Known opening for overlapping approvals',
    lines: [
      {
        warehouse_id: warehouse,
        product_id: product.id,
        location: 'A-01',
        quantity: 10,
        stock_version: String(stock.version),
        lot_code: 'CONCURRENT-LOT',
        unit_cost_minor: '100',
      },
    ],
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: false,
  });
  const { stocktake } = await ok(prefix, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    name: 'Concurrent physical count',
    policy_version: '1',
    blind: true,
  });
  const page = await ok(prefix + '/' + stocktake.id + '/lines');
  assert.equal(page.data.length, 1);
  assert.equal(page.meta.cursor, null);
  const line = page.data[0];
  await ok(prefix + '/' + stocktake.id + '/counts', 'POST', {
    client_key: randomUUID(),
    note: 'Physical shortage measured once',
    lines: [{ id: line.id, version: line.version, basis_token: line.basis_token, quantity: 8 }],
  });
  const counted = (await ok(prefix + '/' + stocktake.id)).stocktake;
  const { review } = await ok(prefix + '/' + stocktake.id + '/reviews', 'POST', {
    client_key: randomUUID(),
    version: counted.version,
    note: 'Approve the whole physical shortage',
    surplus: [],
  });
  assert.equal(review.ready, true);
  assert.equal(review.summary.changed, 1);
  assert.equal(review.summary.known_loss_minor, '200');
  const current = (await ok(prefix + '/' + stocktake.id)).stocktake;
  assert.equal(current.state, 'review');
  assert.equal(current.latest_review_id, review.id);
  return {
    product,
    stocktake,
    body: {
      client_key: randomUUID(),
      version: current.version,
      review_id: review.id,
      scope_hash: review.scope_hash,
      confirmed: true,
    },
  };
}

// Inspect concrete blocker edges, not elapsed time or just simultaneous Promise creation.
// Each POST first spends its schema preflight (10-18 s on a loaded PG04 without the startup
// gate) and may then wait at most 8 s on any lock (pool lock_timeout, tenantTx statement_timeout).
// Started one after the other, the first POST timed out on the stock row long before the second
// reached SQL. So both start together and queue on the firm's operations admission, held here;
// on release the queue head takes it and waits for stock while the other waits behind it.
async function overlap(f: Awaited<ReturnType<typeof fixture>>, bodies: [Json, Json]) {
  const holder = await pool.connect(),
    admission = await pool.connect();
  const operations = 'wms.operations:' + tenant;
  const requests: Array<ReturnType<typeof req>> = [];
  const settled = [false, false];
  try {
    await holder.query('BEGIN');
    await holder.query(
      'SELECT * FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 FOR UPDATE',
      [tenant, warehouse, f.product.id],
    );
    const holderPid = await backendPid(holder);
    await admission.query('BEGIN');
    await admission.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [operations]);
    const admissionPid = await backendPid(admission);
    bodies.forEach((body, index) =>
      requests.push(
        req(prefix + '/' + f.stocktake.id + '/post', 'POST', body).then((result) => {
          settled[index] = true;
          return result;
        }),
      ),
    );
    const admissionLock = /pg_advisory_xact_lock\(hashtextextended/i;
    const queued = await waitForLockEdge(
      pool,
      { blocker: admissionPid, query: admissionLock, advisoryKey: operations },
      requests,
      2,
    );
    await admission.query('COMMIT');
    // The first transaction holds the firm's operations admission while waiting for stock.
    // The second must really wait behind it in SQL before we release the stock row.
    const [firstPid] = await waitForLockEdge(
      pool,
      { blocker: holderPid, query: /\bFROM stock\b[\s\S]*\bFOR UPDATE\b/i, among: queued },
      requests,
    );
    const [secondPid] = await waitForLockEdge(
      pool,
      { blocker: firstPid, query: admissionLock, advisoryKey: operations, among: queued },
      requests,
    );
    assert.notEqual(firstPid, secondPid);
    assert.deepEqual(settled, [false, false], 'Both POSTs must be in flight before lock release');
    await holder.query('COMMIT');
    return await Promise.all(requests);
  } finally {
    await admission.query('ROLLBACK');
    admission.release();
    await holder.query('ROLLBACK');
    holder.release();
    await Promise.allSettled(requests);
  }
}
async function rows(table: string) {
  assert.match(table, /^[a-z_][a-z0-9_]*$/);
  return (
    await pool.query(`SELECT to_jsonb(t) row FROM "${table}" t WHERE tenant_id=$1 ORDER BY 1`, [
      tenant,
    ])
  ).rows;
}
async function snapshot() {
  const names = (
    await pool.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema='public'
     AND column_name='tenant_id' ORDER BY table_name`,
    )
  ).rows.map((r) => r.table_name as string);
  const result: Record<string, unknown> = {};
  for (const name of names) result[name] = await rows(name);
  return result;
}
async function assertOnePosting(
  f: Awaited<ReturnType<typeof fixture>>,
  postingId: string,
  body: Json = f.body,
) {
  const postings = (await rows('wms_stocktake_postings')).map((r) => r.row);
  assert.equal(postings.length, 1);
  assert.equal(postings[0].id, postingId);
  assert.equal(postings[0].stocktake_id, f.stocktake.id);
  assert.equal(postings[0].review_id, body.review_id);
  const operations = (await rows('wms_operations'))
    .map((r) => r.row)
    .filter((r) => r.kind === 'stocktake_post');
  assert.equal(operations.length, 1);
  assert.equal(operations[0].id, postings[0].operation_id);
  assert.equal(operations[0].stocktake_posting_id, postingId);
  assert.equal(operations[0].client_key, body.client_key);
  const journal = (
    await pool.query(
      'SELECT operation_id,delta,value_delta FROM wms_layer_movements WHERE tenant_id=$1 AND operation_id=$2',
      [tenant, postings[0].operation_id],
    )
  ).rows;
  assert.deepEqual(journal, [
    { operation_id: postings[0].operation_id, delta: -2, value_delta: '-200' },
  ]);
  for (const table of ['stock_movements', 'stock_location_movements']) {
    const changes = (await rows(table)).map((r) => r.row).filter((r) => r.kind === 'wms_stocktake');
    assert.equal(changes.length, 1, table + ': exactly one physical correction');
    assert.equal(changes[0].delta, -2);
  }
  const stock = (
    await pool.query(
      'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, f.product.id],
    )
  ).rows;
  assert.deepEqual(stock, [{ on_hand: 8, reserved: 0 }]);
  const positions = (await rows('wms_layer_positions')).map((r) => r.row);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].quantity, 8);
  assert.equal(positions[0].reserved, 0);
  const value = (await ok('/wms-lots/valuation')).valuation;
  assert.equal(value.known_minor, '800');
  assert.equal(value.unknown_quantity, '0');
  const terminal = (await ok(prefix + '/' + f.stocktake.id)).stocktake;
  assert.equal(terminal.state, 'posted');
  assert.equal(terminal.posting_id, postingId);
  const audits = (await rows('audit_events'))
    .map((r) => r.row)
    .filter((r) => r.action === 'wms.stocktake.post');
  assert.equal(audits.length, 1);
  assert.equal(providerCalls, 0);
}

test(
  'overlapping different post keys commit exactly once and reject the other whole approval',
  { timeout: 600000 },
  async () => {
    const f = await fixture();
    const bodies: [Json, Json] = [f.body, { ...f.body, client_key: randomUUID() }];
    const results = await overlap(f, bodies);
    // The admission queue, not Promise order, decides which POST is first.
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    const winner = results.findIndex((r) => r.statusCode === 201);
    const posted = results[winner].json();
    assert.equal(posted.reused, false);
    assert.equal(posted.posting.changed, true);
    await assertOnePosting(f, posted.posting.id, bodies[winner]);
    const committed = await snapshot();
    const replay = await req(prefix + '/' + f.stocktake.id + '/post', 'POST', bodies[winner]);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().reused, true);
    assert.equal(replay.json().posting.id, posted.posting.id);
    assert.deepEqual(
      await snapshot(),
      committed,
      'Winner replay must add no physical or evidence effects',
    );
  },
);

test(
  'overlapping identical post key returns created plus reused with no additional physical or evidence effects',
  { timeout: 600000 },
  async () => {
    const f = await fixture();
    const results = await overlap(f, [f.body, { ...f.body }]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 201]);
    const winner = results.findIndex((r) => r.statusCode === 201);
    const first = results[winner].json(),
      replay = results[1 - winner].json();
    assert.equal(first.reused, false);
    assert.equal(replay.reused, true);
    assert.deepEqual(replay.posting, first.posting);
    await assertOnePosting(f, first.posting.id);
    const committed = await snapshot();
    const again = await req(prefix + '/' + f.stocktake.id + '/post', 'POST', f.body);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().reused, true);
    assert.deepEqual(again.json().posting, first.posting);
    assert.deepEqual(
      await snapshot(),
      committed,
      'Exact replay must be inert across all tenant tables',
    );
  },
);
