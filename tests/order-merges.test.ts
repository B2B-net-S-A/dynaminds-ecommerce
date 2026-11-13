import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { orderMergePreviewInput } from '../server/order-merges-schema';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let cookie = '',
  viewer = '',
  operator = '',
  tenant = '',
  warehouse = '',
  adminId = '',
  ip = 1,
  providerCalls = 0;
const request = (
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  auth = cookie,
) => {
  assert(app);
  return app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie: auth },
    remoteAddress: '127.122.2.' + ip,
  });
};
async function ok(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  status = 200,
  auth = cookie,
): Promise<Row> {
  const r = await request(path, method, body, auth);
  assert.equal(r.statusCode, status, path.startsWith('/auth') ? path : r.body);
  if (path.startsWith('/order-merges')) assert.equal(r.headers['cache-control'], 'no-store');
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      providerCalls++;
      throw Error('Order merge tests cannot contact providers');
    },
    logging: process.env.ORDER_MERGE_TEST_LOG === 'true',
  });
  const a = await request(
    '/auth/login',
    'POST',
    { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    '',
  );
  assert.equal(a.statusCode, 200);
  cookie = String(a.headers['set-cookie']).split(';')[0];
  const v = await request(
    '/auth/login',
    'POST',
    { email: 'viewer@demo.local', password: 'DynaDemo!2026' },
    '',
  );
  assert.equal(v.statusCode, 200);
  viewer = String(v.headers['set-cookie']).split(';')[0];
  const op = await request(
    '/auth/login',
    'POST',
    { email: 'operator@demo.local', password: 'DynaDemo!2026' },
    '',
  );
  assert.equal(op.statusCode, 200);
  operator = String(op.headers['set-cookie']).split(';')[0];
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  providerCalls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'QA122 order merge','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE WHEN email='viewer@demo.local' THEN 'viewer' WHEN email='operator@demo.local' THEN 'operator' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'viewer@demo.local', 'operator@demo.local']],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA122 warehouse','QA122')",
    [warehouse, tenant],
  );
  for (const [auth, set] of [
    [cookie, (x: string) => (cookie = x)],
    [viewer, (x: string) => (viewer = x)],
    [operator, (x: string) => (operator = x)],
  ] as const) {
    const r = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, auth);
    assert.equal(r.statusCode, 200);
    set(String(r.headers['set-cookie']).split(';')[0]);
  }
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const product = (extra: Row = {}) =>
  ok(
    '/products',
    'POST',
    {
      sku: 'QA122-' + randomUUID(),
      name: 'QA122 product',
      price: 1000,
      quantity: 20,
      warehouse_id: warehouse,
      location: 'A-01',
      ...extra,
    },
    201,
  );
const order = (items: Row[], extra: Row = {}) =>
  ok(
    '/orders',
    'POST',
    {
      customer_name: 'QA122 Customer',
      email: 'qa122@example.test',
      warehouse_id: warehouse,
      currency: 'PLN',
      shipping_cost: 100,
      items,
      ...extra,
    },
    201,
  );
const item = (p: Row, quantity = 1) => ({ product_id: p.id, quantity });
const change = async (id: string, status: string) => ok('/orders/' + id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + id + '/status', { status }));
async function edit(p: Row, extra: Row) {
  const current = await ok('/products/' + p.id);
  return ok('/products/' + p.id, 'PATCH', { ...current, ...extra });
}
const previewBody = (main: Row, others: Row[], mode = 'into_main_order', extra: Row = {}) => ({
  client_key: randomUUID(),
  main_order_id: main.id,
  order_ids_to_merge: others.map((o) => o.id),
  merge_mode: mode,
  sum_delivery_costs: true,
  ...extra,
});
async function preview(body: Row) {
  return (await ok('/order-merges/previews', 'POST', body, 201)).preview as Row;
}
const consent = (p: Row, extra: Row = {}) => ({
  client_key: randomUUID(),
  preview_id: p.id,
  scope_hash: p.scope_hash,
  confirmed: true,
  ...extra,
});
async function execute(body: Row, status = 201) {
  return (await ok('/order-merges/execute', 'POST', body, status)).execution as Row;
}
async function all(path: string) {
  const data: Row[] = [];
  let cursor: string | null = null,
    total: number | undefined;
  do {
    const r = await ok(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    total ??= r.meta.total;
    assert.equal(r.meta.total, total);
    data.push(...r.data);
    cursor = r.meta.cursor;
  } while (cursor);
  assert.equal(data.length, total);
  return data;
}
async function digest(names: string[]) {
  const answer: Row = {};
  for (const name of names)
    answer[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${name} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return answer;
}
const physicalNames = [
  'stock',
  'stock_locations',
  'wms_layer_positions',
  'stock_movements',
  'stock_location_movements',
  'wms_layer_movements',
  'wms_issue_fragments',
  'products',
  'payment_entries',
];
async function scanOne(id: string, p: Row, location = 'A-01', layer_id?: string) {
  return ok('/orders/' + id + '/scan', 'POST', {
    code: p.sku,
    location,
    ...(layer_id ? { layer_id, client_key: randomUUID() } : {}),
  });
}
async function payment(id: string, amount: number) {
  const current = await ok('/orders/' + id);
  return ok('/orders/' + id + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(current.version),
    kind: 'receipt',
    amount,
    currency: current.currency,
    method: 'bank_transfer',
    reference: 'QA122 actual local declaration',
    note: 'QA122 merge payment',
    confirmed: true,
  });
}

test('into-main preserves independent commercial price and VAT, partial picking, real ledger and a complete dispatch and partial return', async () => {
  const p = await product(),
    a = await order([item(p, 2)]);
  await change(a.id, 'paid');
  await change(a.id, 'picking');
  await scanOne(a.id, p);
  await edit(p, { price: 1500, vat: 8 });
  const b = await order([item(p)]);
  await payment(b.id, 200);
  const sourceBefore = await digest(['payment_entries']),
    physicalBefore = await digest(physicalNames),
    pb = previewBody(a, [b]),
    pv = await preview(pb);
  assert.equal(pv.ready, true);
  assert.equal(pv.target_status, 'picking');
  assert.equal(pv.total_minor, 3700);
  assert.equal(pv.payment_balance.received, 2300);
  assert.equal(pv.payment_balance.amount_due, 1400);
  const rows = await all('/order-merges/previews/' + pv.id + '/rows');
  assert.deepEqual(
    rows.map((r) => [r.price, r.vat, r.line_total]).sort((x, y) => x[0] - y[0]),
    [
      [1000, 23, 2000],
      [1500, 8, 1500],
    ],
  );
  assert.equal(
    (await all('/order-merges/previews/' + pv.id + '/physical')).reduce((n, r) => n + r.scanned, 0),
    1,
  );
  const body = consent(pv),
    e = await execute(body);
  assert.equal(e.target_order_id, a.id);
  assert.deepEqual(await digest(physicalNames), physicalBefore);
  assert.deepEqual(await digest(['payment_entries']), sourceBefore);
  const effects = await digest([
    'orders',
    'order_items',
    'reservations',
    'reservation_locations',
    'order_merge_claims',
    'order_merge_executions',
    'order_merge_execution_rows',
    'audit_events',
    'order_events',
  ]);
  assert.equal((await ok('/order-merges/execute', 'POST', body)).reused, true);
  assert.deepEqual(await digest(Object.keys(effects)), effects);
  assert.equal(
    (await request('/orders/' + b.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => request(orderPath, 'GET', undefined), '/orders/' + b.id + '/status', { status: 'cancelled' }))).statusCode,
    409,
  );
  await payment(a.id, 1400);
  await scanOne(a.id, p);
  await scanOne(a.id, p);
  await change(a.id, 'packed');
  await ok('/orders/' + a.id + '/ship-demo', 'POST', {});
  const shipped = await ok('/orders/' + a.id);
  assert.equal(shipped.status, 'shipped');
  assert.equal(shipped.items.length, 2);
  const expensive = shipped.items.find((i: Row) => i.price === 1500);
  assert(expensive);
  const r = await ok(
    '/orders/' + a.id + '/returns',
    'POST',
    {
      client_key: randomUUID(),
      reason: 'QA122 original expensive fragment returned',
      items: [{ item_id: expensive.id, quantity: 1 }],
    },
    201,
  );
  await ok('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version),
    shipping_refund: 0,
    note: 'QA122 exact source fragment restocked',
    items: [{ item_id: expensive.id, accepted: 1, restocked: 1 }],
  });
  const stock = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      p.id,
    ])
  ).rows[0];
  assert.deepEqual(stock, { on_hand: 18, reserved: 0 });
  const returned = await ok('/returns/' + r.id);
  assert.equal(returned.refund_amount, 1500);
  assert.equal(providerCalls, 0);
});

test('technical merge keeps original headers and both sold bundle recipes through physical fulfilment and return', async () => {
  const a = await product(),
    b = await product(),
    kit = await product({ kind: 'bundle', quantity: 0, components: [item(a, 2)], price: 2000 });
  const one = await order([item(kit)], { payment_mode: 'cod' });
  await edit(kit, { components: [item(b, 3)], price: 2500 });
  const two = await order([item(kit)], { payment_mode: 'cod' });
  const headers = (
    await pool.query('SELECT to_jsonb(o) row FROM orders o WHERE tenant_id=$1 ORDER BY id', [
      tenant,
    ])
  ).rows;
  const pv = await preview(
    previewBody(one, [two], 'technical_merge', { sum_delivery_costs: false }),
  );
  assert.equal(pv.total_minor, 4600);
  const e = await execute(consent(pv));
  assert.notEqual(e.target_order_id, one.id);
  assert.notEqual(e.target_order_id, two.id);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT to_jsonb(o) row FROM orders o WHERE id=ANY($1::uuid[]) ORDER BY id',
        [[one.id, two.id]],
      )
    ).rows,
    headers,
  );
  const sourceLines = await all('/order-merges/executions/' + e.id + '/rows');
  assert.equal(sourceLines.length, 2);
  assert.deepEqual(
    sourceLines.map((i) => JSON.stringify(i.components)).sort(),
    [
      (await ok('/orders/' + one.id)).items[0].components,
      (await ok('/orders/' + two.id)).items[0].components,
    ]
      .map((x) => JSON.stringify(x))
      .sort(),
  );
  await change(e.target_order_id, 'picking');
  for (let i = 0; i < 2; i++) await scanOne(e.target_order_id, a);
  for (let i = 0; i < 3; i++) await scanOne(e.target_order_id, b);
  await change(e.target_order_id, 'packed');
  await ok('/orders/' + e.target_order_id + '/ship-demo', 'POST', {});
  const target = await ok('/orders/' + e.target_order_id);
  const fragment = target.items.find((i: Row) =>
    i.components.some((x: Row) => x.product_id === a.id),
  );
  assert(fragment);
  const r = await ok(
    '/orders/' + target.id + '/returns',
    'POST',
    {
      client_key: randomUUID(),
      reason: 'QA122 first frozen kit recipe only',
      items: [{ item_id: fragment.id, quantity: 1 }],
    },
    201,
  );
  await ok('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version),
    note: 'QA122 original component A restored',
    items: [{ item_id: fragment.id, accepted: 1, restocked: 1 }],
  });
  assert.equal(
    (
      await pool.query('SELECT on_hand FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        a.id,
      ])
    ).rows[0].on_hand,
    20,
  );
  assert.equal(
    (
      await pool.query('SELECT on_hand FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        b.id,
      ])
    ).rows[0].on_hand,
    17,
  );
  assert.equal(providerCalls, 0);
});

test('receiver review is mandatory and currency, warehouse, mode and foreign identities are explicit conflicts', async () => {
  const p = await product({ quantity: 100 }),
    a = await order([item(p)]),
    b = await order([item(p)], {
      email: 'other.receiver@example.test',
      customer_name: 'QA122 Other receiver',
    });
  const pv = await preview(previewBody(a, [b]));
  assert.equal(pv.receiver_conflict, true);
  const before = await digest(['orders', 'reservations', 'order_merge_executions']);
  assert.equal((await request('/order-merges/execute', 'POST', consent(pv))).statusCode, 422);
  assert.deepEqual(await digest(Object.keys(before)), before);
  await execute(consent(pv, { confirmed_receiver_selection: true }));
  const eur = await ok(
    '/price-lists',
    'POST',
    { name: 'QA122 actual EUR list', currency: 'EUR', fallback: false },
    201,
  );
  await ok('/price-lists/' + eur.id + '/items', 'PUT', {
    version: eur.version,
    items: [{ product_id: p.id, price: 1000 }],
  });
  for (const extra of [{ currency: 'EUR', price_list_id: eur.id }, { payment_mode: 'cod' }]) {
    const x = await order([item(p)]),
      y = await order([item(p)], extra);
    const blocked = await preview(previewBody(x, [y]));
    assert.equal(blocked.ready, false);
    assert(
      blocked.conflicts.includes(extra.currency ? 'different_currency' : 'different_payment_mode'),
    );
  }
  const wh = randomUUID();
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA122 second','QA122-B')",
    [wh, tenant],
  );
  const otherProduct = await product({ warehouse_id: wh }),
    x = await order([item(p)]),
    y = await order([item(otherProduct)], { warehouse_id: wh });
  assert((await preview(previewBody(x, [y]))).conflicts.includes('different_warehouse'));
  assert.equal(
    (await request('/order-merges/previews', 'POST', previewBody(x, [{ id: randomUUID() }])))
      .statusCode,
    404,
  );
  assert.equal(
    orderMergePreviewInput.safeParse({ ...previewBody(x, [y]), order_ids_to_merge: [x.id] })
      .success,
    false,
  );
  const waveA = await order([item(p)], { payment_mode: 'cod' }),
    waveB = await order([item(p)], { payment_mode: 'cod' });
  const selected = { warehouse_id: warehouse, order_ids: [waveA.id, waveB.id] };
  const wavePreview = await ok('/picking-waves/preview', 'POST', selected);
  await ok(
    '/picking-waves',
    'POST',
    {
      ...selected,
      name: 'QA122 active wave blocker',
      client_key: randomUUID(),
      preview_hash: wavePreview.preview_hash,
    },
    201,
  );
  const activeWave = await preview(previewBody(waveA, [waveB]));
  assert.equal(activeWave.ready, false);
  assert(activeWave.conflicts.includes('active_picking_wave'));
});

test('full payment and physical CAS rejects drift and rolls back all tentative destination evidence', async () => {
  const p = await product(),
    a = await order([item(p)]),
    b = await order([item(p)]),
    pv = await preview(previewBody(a, [b], 'technical_merge'));
  await payment(b.id, 1);
  const before = await digest([
    'orders',
    'order_items',
    'stock',
    'reservations',
    'order_merge_origins',
    'order_merge_executions',
    'order_merge_claims',
  ]);
  assert.equal((await request('/order-merges/execute', 'POST', consent(pv))).statusCode, 409);
  assert.deepEqual(await digest(Object.keys(before)), before);
  const fresh = await preview(previewBody(a, [b]));
  await change(a.id, 'paid');
  await change(a.id, 'picking');
  await scanOne(a.id, p);
  const scanned = await digest(Object.keys(before));
  assert.equal((await request('/order-merges/execute', 'POST', consent(fresh))).statusCode, 409);
  assert.deepEqual(await digest(Object.keys(before)), scanned);
});

test('canonical actor-bound exact retry survives later target edits and frozen pages retain original source history', async () => {
  const p = await product(),
    a = await order([item(p)]),
    b = await order([item(p)]),
    body = previewBody(a, [b]);
  await pool.query(
    "UPDATE orders SET source_snapshot=jsonb_build_object('provider_private',jsonb_build_object('total_paid_real',999,'token','QA122-only-private-marker')) WHERE tenant_id=$1 AND id=$2",
    [tenant, a.id],
  );
  const pv = await preview(body);
  const uppercase = {
    ...body,
    main_order_id: body.main_order_id.toUpperCase(),
    order_ids_to_merge: body.order_ids_to_merge.map((id: string) => id.toUpperCase()),
  };
  assert.equal((await ok('/order-merges/previews', 'POST', uppercase)).reused, true);
  const executeBody = consent(pv),
    e = await execute(executeBody);
  await payment(e.target_order_id, 10);
  const before = await digest([
    'orders',
    'order_items',
    'payment_entries',
    'reservations',
    'order_merge_executions',
    'order_events',
    'audit_events',
  ]);
  assert.equal(
    (await ok('/order-merges/execute', 'POST', { ...executeBody, preview_id: pv.id.toUpperCase() }))
      .reused,
    true,
  );
  assert.deepEqual(await digest(Object.keys(before)), before);
  const sources = await all('/order-merges/executions/' + e.id + '/sources');
  assert.equal(sources.length, 2);
  assert.equal(sources.find((s) => s.id === a.id)?.total, a.total);
  assert.equal((await all('/order-merges/executions/' + e.id + '/rows')).length, 2);
  const v = await ok('/order-merges/executions/' + e.id, 'GET', undefined, 200, viewer);
  assert.equal(v.execution.total, 2);
  assert.equal(v.execution.total_minor, null);
  assert.equal(v.execution.payment_balance, null);
  assert.equal(v.can_execute, false);
  const lineage = await ok(
    '/order-merges/orders/' + a.id + '/lineage',
    'GET',
    undefined,
    200,
    operator,
  );
  assert.equal(lineage.current_role, 'operator');
  assert.equal(lineage.origin.header.source_snapshot, undefined);
  assert.equal(lineage.origin.header.portal_token, undefined);
  assert.equal(lineage.origin.header.total, null);
  assert.equal(lineage.origin.items[0].price, null);
  assert(!JSON.stringify(lineage).includes('QA122-only-private-marker'));
  assert(!JSON.stringify(lineage).includes('total_paid_real'));
  assert.equal(
    (await request('/order-merges/execute', 'POST', { ...executeBody, confirmed: false }))
      .statusCode,
    422,
  );
  assert.equal(
    (await request('/order-merges/execute', 'POST', executeBody, viewer)).statusCode,
    403,
  );
});

test('an active merged owner can merge again with financial entries counted once and immutable root item provenance', async () => {
  const p = await product(),
    a = await order([item(p)]),
    b = await order([item(p)]),
    c = await order([item(p)]);
  await payment(a.id, 300);
  await payment(b.id, 400);
  await payment(c.id, 500);
  const first = await execute(consent(await preview(previewBody(a, [b], 'technical_merge'))));
  const owner = await ok('/orders/' + first.target_order_id);
  const secondPreview = await preview(previewBody(owner, [c], 'into_main_order'));
  assert.equal(secondPreview.payment_balance.received, 1200);
  const second = await execute(consent(secondPreview));
  const lines = await all('/order-merges/executions/' + second.id + '/rows');
  assert.equal(new Set(lines.map((i) => i.root_source_item_id)).size, 3);
  assert.deepEqual(new Set(lines.map((i) => i.root_source_order_id)), new Set([a.id, b.id, c.id]));
  const lineage = await ok('/order-merges/orders/' + a.id + '/lineage');
  assert.equal(lineage.owner_order_id, owner.id);
  assert.equal(lineage.closed_source, true);
  assert.equal(
    (await request('/order-merges/previews', 'POST', previewBody(a, [c]))).statusCode,
    409,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM payment_entries WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    3,
  );
});

test(
  'one hundred actual selected orders have complete pages and one hundred one is rejected without a partial merge',
  // Hang guard only: 100 orders created one by one over HTTP took 232 s locally on 13.11.2026
  // (120 s cut it off on CI with two files at once).
  { timeout: 600000 },
  async () => {
    const p = await product({ quantity: 200 }),
      orders: Row[] = [];
    for (let i = 0; i < 100; i++) orders.push(await order([item(p)], { payment_mode: 'cod' }));
    const pb = previewBody(orders[0], orders.slice(1), 'technical_merge'),
      pv = await preview(pb);
    assert.equal(pv.source_count, 100);
    assert.equal(pv.total, 100);
    assert.equal((await all('/order-merges/previews/' + pv.id + '/sources')).length, 100);
    assert.equal((await all('/order-merges/previews/' + pv.id + '/rows')).length, 100);
    assert.equal((await all('/order-merges/previews/' + pv.id + '/physical')).length, 100);
    const unchanged = await digest(physicalNames),
      e = await execute(consent(pv));
    assert.deepEqual(await digest(physicalNames), unchanged);
    assert.equal((await all('/order-merges/executions/' + e.id + '/rows')).length, 100);
    const before = await digest(['orders', 'order_merge_executions', 'order_merge_claims']);
    assert.equal(
      (
        await request('/order-merges/previews', 'POST', {
          ...pb,
          client_key: randomUUID(),
          order_ids_to_merge: [...pb.order_ids_to_merge, randomUUID()],
        })
      ).statusCode,
      422,
    );
    assert.deepEqual(await digest(Object.keys(before)), before);
  },
);

test('WMS merge transfers two exact lot and bin reservations without reFIFO and dispatch/partial return retains their costs', async () => {
  const p = await product();
  const layout = await pool.connect();
  try {
    await layout.query('BEGIN');
    await layout.query(
      'UPDATE stock_locations SET quantity=10 WHERE tenant_id=$1 AND product_id=$2',
      [tenant, p.id],
    );
    await layout.query(
      "INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) VALUES($1,$2,$3,'B-01',10)",
      [tenant, warehouse, p.id],
    );
    await layout.query('COMMIT');
  } catch (e) {
    await layout.query('ROLLBACK');
    throw e;
  } finally {
    layout.release();
  }
  const stock = (
    await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      p.id,
    ])
  ).rows[0];
  const { preview: opening } = await ok(
    '/wms-lots/opening-previews',
    'POST',
    {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'QA122 genuine opening two cost layers',
      lines: [
        {
          warehouse_id: warehouse,
          product_id: p.id,
          location: 'A-01',
          quantity: 10,
          stock_version: stock.version,
          lot_code: 'QA122-A',
          unit_cost_minor: '317',
        },
        {
          warehouse_id: warehouse,
          product_id: p.id,
          location: 'B-01',
          quantity: 10,
          stock_version: stock.version,
          lot_code: 'QA122-B',
          unit_cost_minor: '500',
        },
      ],
    },
    201,
  );
  assert.equal(opening.ready, true);
  await ok(
    '/wms-lots/opening-previews/' + opening.id + '/activate',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: opening.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    201,
  );
  const a = await order([item(p, 8)], { payment_mode: 'cod' }),
    b = await order([item(p, 4)], { payment_mode: 'cod' });
  await change(a.id, 'picking');
  const alloc = (
    await pool.query(
      'SELECT * FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 ORDER BY location,layer_id',
      [tenant, a.id],
    )
  ).rows;
  await scanOne(a.id, p, alloc[0].location, alloc[0].layer_id);
  const before = await digest(physicalNames),
    pv = await preview(previewBody(a, [b], 'technical_merge')),
    e = await execute(consent(pv));
  assert.deepEqual(await digest(physicalNames), before);
  const actual = (
    await pool.query(
      "SELECT * FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND state='active' ORDER BY location,layer_id",
      [tenant, e.target_order_id],
    )
  ).rows;
  assert.equal(actual.length, 2);
  assert.equal(
    actual.reduce((n, r) => n + r.quantity, 0),
    12,
  );
  assert.equal(
    actual.reduce((n, r) => n + r.scanned, 0),
    1,
  );
  for (const r of actual)
    for (let i = r.scanned; i < r.quantity; i++)
      await scanOne(e.target_order_id, p, r.location, r.layer_id);
  await change(e.target_order_id, 'packed');
  await ok('/orders/' + e.target_order_id + '/ship-demo', 'POST', {});
  const issued = (
    await pool.query(
      'SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 ORDER BY unit_cost_minor',
      [tenant, e.target_order_id],
    )
  ).rows;
  assert.deepEqual(
    issued.map((i) => [i.quantity, i.unit_cost_minor, i.value_minor]),
    [
      [10, '317', '3170'],
      [2, '500', '1000'],
    ],
  );
  const target = await ok('/orders/' + e.target_order_id),
    firstLine = target.items.find((i: Row) => i.quantity === 8);
  assert(firstLine);
  const returned = await ok(
    '/orders/' + target.id + '/returns',
    'POST',
    {
      client_key: randomUUID(),
      reason: 'QA122 one merged source unit returned',
      items: [{ item_id: firstLine.id, quantity: 1 }],
    },
    201,
  );
  const version = (
    await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
      tenant,
      p.id,
    ])
  ).rows[0].version;
  await ok('/returns/' + returned.id + '/receive', 'POST', {
    version: Number(returned.version),
    note: 'QA122 preserve original issue fragment cost',
    items: [{ item_id: firstLine.id, accepted: 1, restocked: 1 }],
    wms_lots: {
      client_key: randomUUID(),
      policy_version: '1',
      stock_versions: [{ warehouse_id: warehouse, product_id: p.id, version }],
      picks: [{ issue_fragment_id: issued[0].id, quantity: 1, location: 'ZWROT' }],
    },
  });
  const restored = (
    await pool.query(
      'SELECT value_minor FROM wms_return_fragments WHERE tenant_id=$1 AND return_id=$2',
      [tenant, returned.id],
    )
  ).rows;
  assert.deepEqual(restored, [{ value_minor: '317' }]);
  assert.equal(providerCalls, 0);
});
