import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';
import {
  calculateReplenishment,
  calculateReplenishmentForecast,
} from '../server/replenishment-plans';
import {
  replenishmentPreviewInput,
  replenishmentPolicyDefinitionInput,
  replenishmentForecastInput,
} from '../server/replenishment-plans-schema';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  warehouse = '',
  supplier = '',
  admin = '',
  viewer = '',
  other = '',
  user = '',
  providers = 0,
  ip = 1;
const cookies = new Map<string, string>(),
  base = '/replenishment';
const request = (
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  cookie = admin,
  headers: Record<string, string> = {},
) => {
  assert(app);
  return app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie, ...headers },
    remoteAddress: '127.119.3.' + ip,
  });
};
async function ok(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: Row,
  status = 200,
  cookie = admin,
) {
  const r = await request(path, method, body, cookie);
  assert.equal(r.statusCode, status, path.startsWith('/auth') ? path : r.body);
  if (path.startsWith(base)) assert.equal(r.headers['cache-control'], 'no-store');
  return r.json() as Row;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      providers++;
      throw Error('Replenishment cannot contact providers');
    },
    logging: process.env.REPLENISHMENT_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'viewer@demo.local', 'other@demo.local']) {
    const r = await request('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  tenant = randomUUID();
  warehouse = randomUUID();
  providers = 0;
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA119 main','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE WHEN email='viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA119 warehouse','QA119')",
    [warehouse, tenant],
  );
  for (const [email, cookie] of cookies) {
    const r = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200, r.body);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  other = cookies.get('other@demo.local')!;
  supplier = (await ok('/suppliers', 'POST', { name: 'QA119 Supplier', code: randomUUID() }, 201))
    .id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const definition = (extra: Row = {}) => ({
  enabled: true,
  minimum_quantity: 8,
  target_quantity: 20,
  supplier_id: supplier,
  supplier_sku: 'SUP-001',
  currency: 'PLN',
  minimum_order_quantity: 4,
  order_multiple: 6,
  unit_cost_minor: 317,
  cost_valid_until: new Date(Date.now() + 86400000).toISOString(),
  confirm_cost: true,
  expected_date: null,
  ...extra,
});
const product = (extra: Row = {}) =>
  ok(
    '/products',
    'POST',
    {
      sku: 'QA119-' + randomUUID(),
      name: 'QA119 product',
      price: 999,
      quantity: 5,
      warehouse_id: warehouse,
      ...extra,
    },
    201,
  );
async function policy(p: Row, extra: Row = {}) {
  return (
    await ok(
      base + '/policies',
      'POST',
      {
        client_key: randomUUID(),
        warehouse_id: warehouse,
        product_id: p.id,
        definition: definition(extra),
      },
      201,
    )
  ).policy as Row;
}
const body = (ps: Row[], pols: Row[]) => ({
  client_key: randomUUID(),
  warehouse_id: warehouse,
  items: ps.map((p, i) => ({
    product_id: p.id,
    product_version: p.version,
    policy_version: pols[i].version,
  })),
});
async function preview(b: Row) {
  return (await ok(base + '/previews', 'POST', b, 201)).preview as Row;
}
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
});
const execute = (p: Row, b: Row = consent(p), status = 201) =>
  ok(base + '/previews/' + p.id + '/execute', 'POST', b, status);
async function rows(path: string, expected: number) {
  const result: Row[] = [];
  let cursor: string | null = null;
  do {
    const r = await ok(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(r.meta.total, expected);
    result.push(...r.data);
    cursor = r.meta.cursor;
  } while (cursor);
  assert.equal(result.length, expected);
  assert.equal(new Set(result.map((r) => r.id)).size, expected);
  return result;
}
async function physical() {
  const result: Row = {};
  for (const table of [
    'products',
    'stock',
    'stock_locations',
    'stock_movements',
    'reservations',
    'reservation_locations',
    'orders',
    'order_items',
    'order_pick_items',
    'outbound_events',
    'email_messages',
    'sms_messages',
  ])
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}
async function evidence() {
  const result: Row = {};
  for (const table of [
    'purchase_orders',
    'purchase_order_lines',
    'replenishment_executions',
    'replenishment_execution_rows',
    'audit_events',
  ])
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}

const forecast = { lookback_days: 7, coverage_days: 14 };
async function firstRow(p: Row) {
  return (await rows(base + '/previews/' + p.id + '/rows', p.total))[0];
}
async function sale(items: Array<{ product_id: string; quantity: number }>) {
  return ok(
    '/orders',
    'POST',
    {
      customer_name: 'QA119 synthetic local DEMO',
      email: 'qa119@example.test',
      phone: '500600700',
      payment_mode: 'cod',
      warehouse_id: warehouse,
      address: {
        street: 'Testowa',
        building_number: '1',
        city: 'Warszawa',
        post_code: '00-001',
        country: 'PL',
      },
      items,
    },
    201,
  );
}
async function dispatch(order: Row) {
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  const picks = (
    await pool.query(
      'SELECT p.sku,i.quantity FROM order_pick_items i JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE i.tenant_id=$1 AND i.order_id=$2 ORDER BY p.id',
      [tenant, order.id],
    )
  ).rows;
  for (const p of picks)
    for (let n = 0; n < p.quantity; n++)
      await ok('/orders/' + order.id + '/scan', 'POST', { code: p.sku, location: 'A-01' });
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
  await ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  return ok('/orders/' + order.id);
}
async function journal(
  p: Row,
  order: Row,
  values: Array<{ delta: number; kind: string; at: string }>,
) {
  await tenantScopedOwnerQuery(
    tenant,
    `INSERT INTO stock_movements(id,tenant_id,warehouse_id,product_id,order_id,delta,kind,created_at)
    SELECT gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,$4::uuid,x.delta,x.kind,x.at::timestamptz
    FROM jsonb_to_recordset($5::jsonb) x(delta integer,kind text,at text)`,
    [tenant, warehouse, p.id, order.id, JSON.stringify(values)],
  );
}

test('forecast BigInt ceil, all five strict windows and client timestamp rejection', () => {
  for (const days of [7, 14, 30, 60, 90]) {
    assert(
      replenishmentForecastInput.safeParse({ lookback_days: days, coverage_days: 365 }).success,
    );
    const value = calculateReplenishmentForecast('9007199254740993', days, 365, 5);
    assert.equal(
      value.coverage_target,
      ((9007199254740993n * 365n + BigInt(days) - 1n) / BigInt(days)).toString(),
    );
  }
  assert.deepEqual(calculateReplenishmentForecast('0', 7, 14, 5), {
    coverage_target: '0',
    effective_target: '5',
  });
  assert.deepEqual(calculateReplenishmentForecast('1', 7, 1, 0), {
    coverage_target: '1',
    effective_target: '1',
  });
  for (const invalid of [
    { lookback_days: 8, coverage_days: 14 },
    { lookback_days: 7, coverage_days: 0 },
    { lookback_days: 7, coverage_days: 366 },
    { lookback_days: 7, coverage_days: 1.5 },
    { ...forecast, to: new Date().toISOString() },
  ])
    assert(!replenishmentForecastInput.safeParse(invalid).success);
  assert(
    !replenishmentPreviewInput.safeParse({
      client_key: randomUUID(),
      warehouse_id: randomUUID(),
      items: [{ product_id: randomUUID(), product_version: 1, policy_version: 1 }],
      forecast,
      forecast_window: { from: '2020-01-01T00:00:00.000Z', to: '2020-01-08T00:00:00.000Z' },
    }).success,
  );
});

test('zero recorded dispatch retains policy minimum for every window and manual proof is unchanged', async () => {
  const p = await product({ quantity: 5 }),
    pol = await policy(p, { minimum_quantity: 5, target_quantity: 999 });
  const options = await ok(base + '/options');
  assert.equal(options.forecast_available, true);
  assert.deepEqual(options.forecast_lookback_days, [7, 14, 30, 60, 90]);
  assert.equal(options.forecast_max_coverage_days, 365);
  const manualBody = body([p], [pol]),
    manual = await preview(manualBody),
    manualRow = await firstRow(manual);
  assert(!Object.hasOwn(manual, 'config'));
  assert(!Object.hasOwn(manualRow, 'demand'));
  assert(!Object.hasOwn(manualRow, 'days_cover'));
  assert.deepEqual(
    (await pool.query('SELECT config FROM replenishment_previews WHERE id=$1', [manual.id])).rows[0]
      .config,
    manualBody,
  );
  const before = await physical();
  for (const lookback_days of [7, 14, 30, 60, 90]) {
    const pr = await preview({
        ...body([p], [pol]),
        forecast: { lookback_days, coverage_days: 14 },
      }),
      r = await firstRow(pr);
    assert.equal(pr.unchanged, 1);
    assert.equal(r.demand.shipped_quantity, '0');
    assert.equal(r.demand.restocked_return_quantity, '0');
    assert.equal(r.effective_target_quantity, '5');
    assert.equal(r.days_cover, null);
    assert.equal(r.recommended_quantity, '0');
    assert.equal(
      Date.parse(pr.config.forecast_window.to) - Date.parse(pr.config.forecast_window.from),
      lookback_days * 86400000,
    );
    assert(r.warnings.some((x: string) => x.includes('Brak lokalnie zapisanych wydań')));
    const e = (await execute(pr)).execution;
    assert.deepEqual(e.config, pr.config);
  }
  assert.deepEqual(await physical(), before);
  assert.equal(providers, 0);
});

test('genuine bundle and variant DEMO dispatch, restock, forecast draft, partial PZ and next NOP preserve frozen demand', async () => {
  const component = await product({ quantity: 8 }),
    group = await product({ kind: 'group', quantity: 0 }),
    variant = await product({ kind: 'variant', parent_id: group.id, quantity: 8 }),
    kit = await product({
      kind: 'bundle',
      quantity: 0,
      components: [
        { product_id: component.id, quantity: 2 },
        { product_id: variant.id, quantity: 1 },
      ],
    }),
    order = await sale([
      { product_id: kit.id, quantity: 2 },
      { product_id: variant.id, quantity: 1 },
    ]),
    shipped = await dispatch(order);
  assert.equal(shipped.status, 'shipped');
  const item = shipped.items.find((i: Row) => i.product_id === kit.id);
  assert(item);
  const requested = await ok(
    '/orders/' + order.id + '/returns',
    'POST',
    {
      client_key: randomUUID(),
      reason: 'QA119 physical component restock',
      items: [{ item_id: item.id, quantity: 1 }],
    },
    201,
  );
  await ok('/returns/' + requested.id + '/receive', 'POST', {
    version: requested.version,
    note: 'QA119 restore one physical kit',
    items: [{ item_id: item.id, accepted: 1, restocked: 1 }],
  });
  const pols = [
      await policy(component, { minimum_quantity: 0, target_quantity: 100 }),
      await policy(variant, { minimum_quantity: 0, target_quantity: 100 }),
    ],
    requestBody = { ...body([component, variant], pols), forecast },
    pr = await preview(requestBody),
    rs = await rows(base + '/previews/' + pr.id + '/rows', 2),
    byID = new Map(rs.map((r) => [r.product_id, r]));
  const a = byID.get(component.id)!,
    b = byID.get(variant.id)!;
  assert.deepEqual(
    [
      a.demand.shipped_quantity,
      a.demand.restocked_return_quantity,
      a.available,
      a.effective_target_quantity,
      a.recommended_quantity,
    ],
    ['4', '2', '6', '8', '6'],
  );
  assert.deepEqual(
    [
      b.demand.shipped_quantity,
      b.demand.restocked_return_quantity,
      b.available,
      b.effective_target_quantity,
      b.recommended_quantity,
    ],
    ['3', '1', '6', '6', '0'],
  );
  assert.deepEqual(a.days_cover, { numerator: '42', denominator: '4' });
  assert.equal(pr.purchase, 1);
  const protectedBefore = await physical(),
    consentBody = consent(pr),
    exec = (await execute(pr, consentBody)).execution;
  assert.deepEqual(exec.config, pr.config);
  assert.deepEqual(await physical(), protectedBefore);
  const er = await rows(base + '/executions/' + exec.id + '/rows', 2);
  for (const r of rs)
    assert.deepEqual(er.find((x) => x.product_id === r.product_id)!.demand, r.demand);
  const history = await ok(base + '/executions');
  assert.deepEqual(history.data.find((e: Row) => e.id === exec.id).config, pr.config);
  const evidenceBefore = await evidence();
  assert.deepEqual((await execute(pr, consentBody, 200)).execution, exec);
  assert.deepEqual(await evidence(), evidenceBefore);
  const po = await ok('/purchase-orders/' + exec.groups[0].purchase_order_id),
    placed = await ok('/purchase-orders/' + po.id + '/place', 'POST', { version: po.version });
  assert.deepEqual([po.lines[0].quantity, po.lines[0].unit_cost], [6, 317]);
  const receiptBody = {
    client_key: randomUUID(),
    version: placed.version,
    lines: [{ product_id: component.id, quantity: 2, location: 'A-01' }],
  };
  const received = await ok('/purchase-orders/' + po.id + '/receive', 'POST', receiptBody);
  assert.equal(received.order.state, 'partial');
  assert.equal(
    (await ok('/purchase-orders/' + po.id + '/receive', 'POST', receiptBody)).replayed,
    true,
  );
  const next = await preview({ ...requestBody, client_key: randomUUID() }),
    nr = await rows(base + '/previews/' + next.id + '/rows', 2),
    na = nr.find((r) => r.product_id === component.id)!;
  assert.deepEqual(
    [na.available, na.incoming_ordered_quantity, na.projected_available, na.recommended_quantity],
    ['8', '4', '12', '0'],
  );
  assert.equal(next.unchanged, 2);
  const postReceipt = await physical();
  assert.equal((await execute(next)).execution.groups.length, 0);
  assert.deepEqual(await physical(), postReceipt);
  assert.deepEqual((await ok(base + '/executions/' + exec.id)).execution.config, pr.config);
  assert.equal(providers, 0);
});

test('half-open grouped journal boundaries exclude manual/unsigned/other-warehouse movements without leaking order IDs', async () => {
  const p = await product({ quantity: 30 }),
    pol = await policy(p, { minimum_quantity: 0, target_quantity: 100 }),
    order = await sale([{ product_id: p.id, quantity: 1 }]),
    to = new Date(Date.now() - 1000).toISOString(),
    from = new Date(Date.parse(to) - 7 * 86400000).toISOString();
  await journal(p, order, [
    { delta: -3, kind: 'shipment', at: from },
    { delta: -4, kind: 'shipment', at: new Date(Date.parse(to) - 1).toISOString() },
    { delta: -99, kind: 'shipment', at: to },
    { delta: -99, kind: 'shipment', at: new Date(Date.parse(from) - 1).toISOString() },
    { delta: 2, kind: 'return', at: from },
    { delta: -8, kind: 'issue', at: from },
    { delta: 9, kind: 'shipment', at: from },
    { delta: -9, kind: 'return', at: from },
  ]);
  const wh2 = randomUUID();
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA119 excluded warehouse',$3)",
    [wh2, tenant, randomUUID()],
  );
  await tenantScopedOwnerQuery(
    tenant,
    'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,reserved) VALUES($1,$2,$3,0,0)',
    [tenant, wh2, p.id],
  );
  await tenantScopedOwnerQuery(
    tenant,
    "INSERT INTO stock_movements(id,tenant_id,warehouse_id,product_id,order_id,delta,kind,created_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,-91,'shipment',$5)",
    [tenant, wh2, p.id, order.id, from],
  );
  await tenantScopedOwnerQuery(
    tenant,
    "INSERT INTO stock_movements(id,tenant_id,warehouse_id,product_id,order_id,delta,kind,created_at) VALUES(gen_random_uuid(),$1,$2,$3,NULL,-92,'shipment',$4)",
    [tenant, warehouse, p.id, from],
  );
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const agg = (
      await c.query('SELECT * FROM replenishment_forecast_totals($1,$2::uuid[],$3,$4)', [
        warehouse,
        [p.id],
        from,
        to,
      ])
    ).rows;
    assert.deepEqual(agg, [
      {
        product_id: p.id,
        shipped_quantity: '7',
        restocked_return_quantity: '2',
        shipment_movement_count: '2',
        return_movement_count: '1',
      },
    ]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  const r = await firstRow(await preview({ ...body([p], [pol]), forecast }));
  assert(!JSON.stringify(r.demand).includes(order.id));
  assert(!JSON.stringify(r.demand).includes('customer'));
  assert.match(r.demand.demand_hash, /^[a-f0-9]{64}$/);
});

test('forecast incoming draft quantity suppresses duplicate orders and uses effective target instead of manual target', async () => {
  const p = await product({ quantity: 10 }),
    pol = await policy(p, { minimum_quantity: 0, target_quantity: 1000 }),
    shipped = await dispatch(await sale([{ product_id: p.id, quantity: 7 }])),
    draft = await ok(
      '/purchase-orders',
      'POST',
      {
        supplier_id: supplier,
        warehouse_id: warehouse,
        currency: 'PLN',
        lines: [{ product_id: p.id, quantity: 4, unit_cost: 317 }],
      },
      201,
    );
  const pr = await preview({ ...body([p], [pol]), forecast }),
    r = await firstRow(pr);
  assert.deepEqual(
    [
      r.available,
      r.incoming_draft_quantity,
      r.projected_available,
      r.effective_target_quantity,
      r.deficit,
      r.recommended_quantity,
    ],
    ['3', '4', '7', '14', '7', '12'],
  );
  assert.equal(r.demand.shipped_quantity, '7');
  assert.equal(r.demand.restocked_return_quantity, '0');
  const before = await physical(),
    e = (await execute(pr)).execution;
  assert.deepEqual(await physical(), before);
  assert.equal(
    (await ok('/purchase-orders/' + e.groups[0].purchase_order_id)).lines[0].quantity,
    12,
  );
  const next = await preview({ ...body([p], [pol]), forecast }),
    n = await firstRow(next);
  assert.equal(n.incoming_draft_quantity, '16');
  assert.equal(n.recommended_quantity, '0');
  assert.equal((await ok('/purchase-orders/' + draft.id)).state, 'draft');
  assert.equal(shipped.status, 'shipped');
});

test('int32-min shipment delta aggregates safely and excessive recommendation is invalid rather than rounded or truncated', async () => {
  const p = await product({ quantity: 5 }),
    pol = await policy(p, { minimum_quantity: 0, target_quantity: 0 }),
    order = await sale([{ product_id: p.id, quantity: 1 }]);
  await journal(p, order, [
    { delta: -2147483648, kind: 'shipment', at: new Date(Date.now() - 1000).toISOString() },
    { delta: -2147483648, kind: 'shipment', at: new Date(Date.now() - 500).toISOString() },
  ]);
  const pr = await preview({
      ...body([p], [pol]),
      forecast: { lookback_days: 7, coverage_days: 365 },
    }),
    r = await firstRow(pr);
  assert.equal(r.demand.shipped_quantity, '4294967296');
  assert.equal(r.demand.coverage_target, ((4294967296n * 365n + 6n) / 7n).toString());
  assert.equal(pr.ready, false);
  assert.equal(pr.invalid, 1);
  assert(r.errors.some((s: string) => s.includes('1000000')));
  assert.equal(
    (await request(base + '/previews/' + pr.id + '/execute', 'POST', consent(pr))).statusCode,
    409,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM purchase_orders WHERE tenant_id=$1', [tenant]))
      .rows[0].n,
    0,
  );
});

test('500 forecast rows share one frozen window, complete paginated receipts, and 501 reject before evidence', async () => {
  const ps = (
    await pool.query(
      `INSERT INTO products(id,tenant_id,sku,name,price) SELECT gen_random_uuid(),$1::uuid,'QA119-500-'||i,'QA119 physical '||i,100 FROM generate_series(1,500) i RETURNING id,version`,
      [tenant],
    )
  ).rows;
  const pols: Row[] = [];
  for (const p of ps)
    pols.push(
      await policy(p, {
        minimum_quantity: 0,
        target_quantity: 999,
        minimum_order_quantity: 1,
        order_multiple: 1,
      }),
    );
  const pr = await preview({ ...body(ps, pols), forecast }),
    rs = await rows(base + '/previews/' + pr.id + '/rows', 500);
  assert.equal(pr.unchanged, 500);
  assert.equal(pr.ready, true);
  for (const r of rs) {
    assert.equal(r.demand.shipped_quantity, '0');
    assert.deepEqual({ from: r.demand.from, to: r.demand.to }, pr.config.forecast_window);
    assert.equal(r.effective_target_quantity, '0');
  }
  const before = await physical(),
    e = (await execute(pr)).execution;
  assert.equal(e.total, 500);
  assert.equal(e.groups.length, 0);
  assert.deepEqual(await physical(), before);
  const ers = await rows(base + '/executions/' + e.id + '/rows', 500);
  assert.deepEqual(new Set(ers.map((r) => r.product_id)), new Set(ps.map((p) => p.id)));
  const invalid = {
    ...body(ps, pols),
    forecast,
    items: [
      ...body(ps, pols).items,
      { product_id: randomUUID(), product_version: 1, policy_version: 1 },
    ],
  };
  const count = (
    await pool.query('SELECT count(*)::int n FROM replenishment_previews WHERE tenant_id=$1', [
      tenant,
    ])
  ).rows[0].n;
  assert.equal((await request(base + '/previews', 'POST', invalid)).statusCode, 422);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM replenishment_previews WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    count,
  );
});

test('server windows distinguish a ten-day-old dispatch and retain frozen original window on exact retry', async () => {
  const p = await product({ quantity: 20 }),
    pol = await policy(p, { minimum_quantity: 0, target_quantity: 999 }),
    order = await sale([{ product_id: p.id, quantity: 1 }]);
  await journal(p, order, [
    { delta: -7, kind: 'shipment', at: new Date(Date.now() - 10 * 86400000).toISOString() },
  ]);
  for (const lookback_days of [7, 14, 30, 60, 90]) {
    const requestBody = { ...body([p], [pol]), forecast: { lookback_days, coverage_days: 14 } },
      pr = await preview(requestBody),
      r = await firstRow(pr);
    assert.equal(r.demand.shipped_quantity, lookback_days === 7 ? '0' : '7');
    assert.equal(
      r.demand.coverage_target,
      lookback_days === 7
        ? '0'
        : ((7n * 14n + BigInt(lookback_days) - 1n) / BigInt(lookback_days)).toString(),
    );
    const evidenceBefore = await evidence(),
      reused = await ok(base + '/previews', 'POST', requestBody);
    assert.equal(reused.reused, true);
    assert.deepEqual(reused.preview, pr);
    assert.deepEqual(await evidence(), evidenceBefore);
    assert.deepEqual((await firstRow(pr)).demand, r.demand);
  }
});
