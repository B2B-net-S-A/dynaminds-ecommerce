import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { backendPid, waitForLockEdge } from './lock-edge-helper';

// 250: ordinary WMS writers of one tenant share the tenant operations fence; row locks on the
// stock rows (taken in sorted order), layer positions and reservation layers decide between them.
// These tests hold real row locks and check that independent products no longer queue behind each
// other, and that the WMS invariants hold under real contention.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);

type Reply = { statusCode: number; body: string; json: () => any };
let app: Awaited<ReturnType<typeof buildApp>>,
  tenant = '',
  warehouse = '',
  admin = '',
  ip = 1;
const cookies = new Map<string, string>();
const req = (path: string, method: any = 'GET', body?: any, auth = admin): Promise<Reply> =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie: auth },
    remoteAddress: '127.0.157.' + ip,
  }) as unknown as Promise<Reply>;
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: HTTP ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.json();
}
// Migration 250 (server/250_wms_evidence_settle_unlocked.sql) ships with the shared fence: the real migrate()
// applies it, and without it the settle of two open writers deadlocks (40P01, last test).
before(async () => {
  await migrate();
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM migrations WHERE name='250_wms_evidence_settle_unlocked'")).rows[0].n,
    1,
    'migrate() applied 250',
  );
  const settle = await pool.query(
    "SELECT prosrc FROM pg_proc WHERE oid='public.wms_evidence_usage_settle()'::regprocedure",
  );
  assert.doesNotMatch(settle.rows[0].prosrc, /FOR UPDATE/, 'the 250 settle body is installed');
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw Error('WMS concurrency must never use a provider transport');
    },
    logging: process.env.WMS_TEST_LOG === 'true',
  });
  const r = await req('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' }, '');
  assert.equal(r.statusCode, 200);
  cookies.set('admin', String((r as any).headers['set-cookie']).split(';')[0]);
});
beforeEach(async () => {
  ++ip;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'WMS 250 concurrency','enterprise')", [tenant]);
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'admin' FROM users WHERE email='admin@demo.local'`,
    [tenant],
  );
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookies.get('admin')!);
  assert.equal(r.statusCode, 200);
  admin = String((r as any).headers['set-cookie']).split(';')[0];
  cookies.set('admin', admin); // the switch rotates the session
  await pool.query(`INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'FIFO 250','F250')`, [
    warehouse,
    tenant,
  ]);
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

async function product() {
  return ok('/products', 'POST', {
    sku: 'F250-' + randomUUID(),
    name: 'WMS 250 product',
    price: 2500,
    warehouse_id: warehouse,
    quantity: 0,
    location: 'A-01',
  });
}
async function enable() {
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '0',
    currency: 'PLN',
    note: 'WMS 250 opening',
    lines: [],
  });
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_unknown_costs: true,
  });
}
async function versions(ids: string[]) {
  return Promise.all(
    ids.map(async (product_id) => ({
      product_id,
      warehouse_id: warehouse,
      version: String(
        (
          await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [
            tenant,
            warehouse,
            product_id,
          ])
        ).rows[0]?.version ?? '0',
      ),
    })),
  );
}
/** One receipt line per (product, quantity, cost); lines keep the given product order. */
async function receiptBody(lines: Array<[string, number, string]>, clientKey = randomUUID()) {
  return {
    client_key: clientKey,
    policy_version: '1',
    warehouse_id: warehouse,
    stock_versions: await versions([...new Set(lines.map(([p]) => p))]),
    confirmed: true,
    note: 'WMS 250 receipt',
    lines: lines.map(([product_id, quantity, cost]) => ({
      product_id,
      location: 'A-01',
      quantity,
      lot_code: 'LOT-250-' + randomUUID(),
      unit_cost_minor: cost,
      currency: 'PLN',
    })),
  };
}
const receive = async (lines: Array<[string, number, string]>) =>
  req('/wms-lots/receipts', 'POST', await receiptBody(lines));
const sale = (items: Array<[string, number]>) =>
  req('/orders', 'POST', {
    customer_name: 'WMS 250 customer',
    email: 'wms250@example.test',
    payment_mode: 'cod',
    warehouse_id: warehouse,
    items: items.map(([product_id, quantity]) => ({ product_id, quantity })),
  });
async function layers(productId: string) {
  return (
    await pool.query(
      `SELECT l.id,l.fifo_sequence,p.quantity,p.reserved FROM wms_cost_layers l
       JOIN wms_layer_positions p ON (p.tenant_id,p.layer_id)=(l.tenant_id,l.id)
       WHERE l.tenant_id=$1 AND l.product_id=$2 ORDER BY l.fifo_sequence`,
      [tenant, productId],
    )
  ).rows;
}
async function allocations(orderId: string) {
  return new Map<string, number>(
    (
      await pool.query(
        `SELECT layer_id,sum(quantity)::int q FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2
         AND state='active' GROUP BY layer_id`,
        [tenant, orderId],
      )
    ).rows.map((r) => [r.layer_id, r.q]),
  );
}
/** Stock, layer positions, journal, reservations and the 235 evidence counter agree for the tenant. */
async function assertLedger() {
  const drift = (
    await pool.query(
      `SELECT
        (SELECT count(*) FROM stock s WHERE s.tenant_id=$1 AND ROW(s.on_hand,s.reserved) IS DISTINCT FROM
          (SELECT ROW(coalesce(sum(quantity),0)::int,coalesce(sum(reserved),0)::int) FROM wms_layer_positions p
           WHERE (p.tenant_id,p.warehouse_id,p.product_id)=(s.tenant_id,s.warehouse_id,s.product_id)))::int stock,
        (SELECT count(*) FROM wms_layer_positions p WHERE p.tenant_id=$1 AND (p.reserved>p.quantity OR p.quantity<>
          (SELECT coalesce(sum(delta),0) FROM wms_layer_movements m WHERE (m.tenant_id,m.warehouse_id,m.product_id,m.location,m.layer_id)
           =(p.tenant_id,p.warehouse_id,p.product_id,p.location,p.layer_id)) OR p.reserved<>
          (SELECT coalesce(sum(quantity),0) FROM wms_reservation_layers a WHERE a.state='active' AND
           (a.tenant_id,a.warehouse_id,a.product_id,a.location,a.layer_id)=(p.tenant_id,p.warehouse_id,p.product_id,p.location,p.layer_id))))::int positions,
        (SELECT count(*) FROM wms_operations WHERE tenant_id=$1)::int operations,
        (SELECT coalesce(sum(operations),0)::int FROM wms_evidence_usage WHERE tenant_id=$1) counted,
        (SELECT count(*) FROM wms_cost_layers WHERE tenant_id=$1)::int layers,
        (SELECT coalesce(sum(layers),0)::int FROM wms_evidence_usage WHERE tenant_id=$1) counted_layers,
        (SELECT count(*) FROM wms_operations o WHERE o.tenant_id=$1 AND NOT EXISTS(
          SELECT 1 FROM wms_evidence_settled s WHERE (s.tenant_id,s.operation_id)=(o.tenant_id,o.id)))::int unsettled`,
      [tenant],
    )
  ).rows[0];
  assert.equal(drift.stock, 0, 'stock = sum of layer positions');
  assert.equal(drift.positions, 0, 'positions = journal, reserved = reservation layers, reserved <= quantity');
  assert.equal(drift.counted, drift.operations, 'evidence counter = operations');
  assert.equal(drift.counted_layers, drift.layers, 'evidence counter = layers');
  assert.equal(drift.unsettled, 0, 'every operation settled exactly once');
}
async function holdStock(productIds: string[]) {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query(
    'SELECT 1 FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=ANY($3::uuid[]) ORDER BY product_id FOR UPDATE',
    [tenant, warehouse, productIds],
  );
  return c;
}
async function release(c: PoolClient) {
  try {
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

test(
  'independent products of one tenant do not wait on an open writer holding another product',
  { timeout: 600000 },
  async () => {
    const p1 = await product(),
      p2 = await product();
    await enable();
    assert.equal((await receive([[p1.id, 5, '100'], [p2.id, 5, '200']])).statusCode, 201);
    // A real admitted writer of the tenant (tenantTx: the same policy and operations admission as every write)
    // holds P1's stock row and stays open, without a running statement, while other writes of the tenant run.
    // Before 250 its exclusive wms.operations lock queued every one of them (8 s timeout -> HTTP 500).
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    let opened!: () => void;
    const holding = new Promise<void>((resolve) => (opened = resolve));
    const writer = tenantTx(tenant, async (c) => {
      await c.query('SELECT 1 FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE', [
        warehouse,
        p1.id,
      ]);
      opened();
      await done;
    });
    try {
      await holding;
      const other = await sale([[p2.id, 2]]);
      assert.equal(other.statusCode, 201, other.body.slice(0, 300));
      const receipt = await receive([[p2.id, 3, '250']]);
      assert.equal(receipt.statusCode, 201, receipt.body.slice(0, 300));
      assert.equal((await allocations(other.json().id)).size, 1);
    } finally {
      finish();
      await writer;
    }
    const first = await sale([[p1.id, 1]]);
    assert.equal(first.statusCode, 201, first.body.slice(0, 300));
    await assertLedger();
  },
);

test('two orders racing for the last unit of one layer: exactly one reserves it', { timeout: 600000 }, async () => {
  const p = await product();
  await enable();
  assert.equal((await receive([[p.id, 1, '100']])).statusCode, 201);
  const holder = await holdStock([p.id]);
  let sales: Promise<Reply[]> | undefined;
  try {
    const pending = [sale([[p.id, 1]]), sale([[p.id, 1]])];
    sales = Promise.all(pending);
    await waitForLockEdge(pool, { blocker: await backendPid(holder), query: /\bstock\b/i }, pending);
  } finally {
    await release(holder);
  }
  const results = await sales!;
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409], results.map((r) => r.body.slice(0, 200)).join(' | '));
  const [layer] = await layers(p.id);
  assert.deepEqual([layer.quantity, layer.reserved], [1, 1]);
  const won = results.find((r) => r.statusCode === 201)!.json();
  assert.deepEqual([...(await allocations(won.id))], [[layer.id, 1]]);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [tenant])).rows[0].n,
    1,
  );
  await assertLedger();
});

test('interleaved receipts, issues and orders keep FIFO and the layer ledger', { timeout: 900000 }, async () => {
  const p = await product();
  await enable();
  assert.equal((await receive([[p.id, 2, '100']])).statusCode, 201);
  const { preview } = await ok('/wms-lots/movement-previews', 'POST', {
    client_key: randomUUID(),
    policy_version: '1',
    kind: 'issue',
    product_id: p.id,
    warehouse_id: warehouse,
    location: 'A-01',
    quantity: 1,
    stock_versions: await versions([p.id]),
    note: 'WMS 250 interleaved issue',
  });
  const receiptBodyNext = await receiptBody([[p.id, 3, '300']]);
  for (let round = 0; round < 2; round++) {
    const holder = await holdStock([p.id]);
    let all: Promise<Reply[]> | undefined;
    try {
      const pending = [
        sale([[p.id, 2]]),
        round === 0 ? req('/wms-lots/receipts', 'POST', receiptBodyNext) : receive([[p.id, 2, '400']]),
        round === 0
          ? req('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', {
              client_key: randomUUID(),
              scope_hash: preview.scope_hash,
              confirmed: true,
            })
          : sale([[p.id, 1]]),
      ];
      all = Promise.all(pending);
      await waitForLockEdge(pool, { blocker: await backendPid(holder), query: /\bstock\b/i }, pending);
    } finally {
      await release(holder);
    }
    const results = await all!;
    for (const r of results) assert([200, 201, 409].includes(r.statusCode), `HTTP ${r.statusCode} ${r.body.slice(0, 300)}`);
    // FIFO: an order holds a newer layer only when every older layer was fully taken.
    const ordered = await layers(p.id);
    for (const r of results.filter((r) => r.statusCode === 201 && r.json().items)) {
      const taken = await allocations(r.json().id);
      for (const [i, layer] of ordered.entries())
        if (taken.get(layer.id))
          for (const older of ordered.slice(0, i))
            assert.equal(older.quantity - older.reserved, 0, 'an older layer still had free units');
    }
    await assertLedger();
  }
  const sequences = (await layers(p.id)).map((l) => Number(l.fifo_sequence));
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
});

test('opposite product order across orders and receipts does not deadlock', { timeout: 900000 }, async () => {
  const p1 = await product(),
    p2 = await product();
  await enable();
  assert.equal((await receive([[p1.id, 40, '100'], [p2.id, 40, '100']])).statusCode, 201);
  for (let round = 0; round < 4; round++) {
    const results = await Promise.all([
      sale([[p1.id, 1], [p2.id, 1]]),
      sale([[p2.id, 1], [p1.id, 1]]),
      sale([[p2.id, 2]]),
      sale([[p1.id, 2]]),
    ]);
    for (const r of results) assert.equal(r.statusCode, 201, r.body.slice(0, 300));
  }
  const orders = (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [tenant])).rows[0].n;
  assert.equal(orders, 16);
  const s = (
    await pool.query('SELECT product_id,reserved FROM stock WHERE tenant_id=$1 ORDER BY product_id', [tenant])
  ).rows;
  assert.deepEqual(s.map((r) => r.reserved), [16, 16]); // 4 rounds x (1+1+2) per product
  await assertLedger();
});

test('the same receipt key sent twice at once creates one operation and one exact replay', { timeout: 600000 }, async () => {
  const p = await product();
  await enable();
  assert.equal((await receive([[p.id, 1, '100']])).statusCode, 201);
  const body = await receiptBody([[p.id, 2, '150']]);
  const holder = await holdStock([p.id]);
  let both: Promise<Reply[]> | undefined;
  try {
    const pending = [req('/wms-lots/receipts', 'POST', body), req('/wms-lots/receipts', 'POST', body)];
    both = Promise.all(pending);
    await waitForLockEdge(pool, { blocker: await backendPid(holder), query: /\bstock\b/i }, pending);
  } finally {
    await release(holder);
  }
  const results = await both!;
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 201], results.map((r) => r.body.slice(0, 200)).join(' | '));
  const [created, replay] = [...results].sort((a, b) => b.statusCode - a.statusCode).map((r) => r.json());
  assert.equal(replay.reused, true);
  assert.equal(replay.operation.id, created.operation.id);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM wms_operations WHERE tenant_id=$1 AND client_key=$2', [tenant, body.client_key]))
      .rows[0].n,
    1,
  );
  assert.equal((await layers(p.id)).length, 2);
  await assertLedger();
});

test('settling while other writers commit takes no lock on their settled rows (no 40P01)', { timeout: 600000 }, async () => {
  // The interleaving that deadlocked the 235 settle once writers share the fence: A and B open, C commits a
  // high-id operation, A settles again, D commits a low-id operation, B settles, A settles.
  await enable();
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  const tail = randomUUID().slice(8);
  const clients = await Promise.all([0, 1, 2, 3].map(() => pool.connect()));
  const [a, b, c, d] = clients;
  const begin = async (x: PoolClient) => {
    await x.query('BEGIN');
    await x.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  };
  const op = (x: PoolClient, id: string) =>
    x.query(
      `INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,request,result)
       VALUES($1,$2,$3,gen_random_uuid(),repeat('a',64),'scan','manual',1,'{}','{}')`,
      [id, tenant, user],
    );
  const settle = (x: PoolClient) => x.query('SELECT wms_evidence_usage_settle()');
  try {
    await begin(a);
    await op(a, '5aaaaaaa' + tail);
    await settle(a);
    await begin(b);
    await op(b, '5bbbbbbb' + tail);
    await settle(b);
    await begin(c);
    await op(c, 'ffffffff' + tail);
    await settle(c);
    await c.query('COMMIT');
    await settle(a);
    await begin(d);
    await op(d, '00000000' + tail);
    await settle(d);
    await d.query('COMMIT');
    const second = settle(b);
    await new Promise((r) => setTimeout(r, 500));
    const outcomes = await Promise.allSettled([settle(a), second]);
    assert.deepEqual(
      outcomes.map((o) => o.status),
      ['fulfilled', 'fulfilled'],
      JSON.stringify(outcomes.map((o: any) => o.reason?.code)),
    );
    await a.query('COMMIT');
    await b.query('COMMIT');
  } finally {
    for (const x of clients) {
      await x.query('ROLLBACK').catch(() => undefined);
      x.release();
    }
  }
  await assertLedger();
});
