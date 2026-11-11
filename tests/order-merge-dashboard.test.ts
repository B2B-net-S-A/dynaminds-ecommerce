import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { createOrder, orderSchema } from '../server/domain';

type Row = Record<string, any>;
assert.equal(process.env.DYNA_TEST, 'true');
const testUrl = new URL(process.env.DATABASE_URL!);
assert.match(testUrl.pathname, /^\/dynaminds_test_\d+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(testUrl.hostname));
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '';
let userId = '';
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie, target = app) =>
  target.inject({ url: '/api' + path, method, payload, headers: { cookie: auth } });
async function ok(path: string, method: any = 'GET', payload?: any, auth = cookie) {
  const response = await req(path, method, payload, auth);
  assert(response.statusCode < 300, `${path}: ${response.body}`);
  return response.json();
}
async function signup() {
  const result = await req(
    '/auth/signup',
    'POST',
    {
      email: randomUUID() + '@example.test',
      name: 'QA Dashboard',
      password: 'DynaDashboard!2026',
      organization: { name: 'QA merge dashboard ' + randomUUID().slice(0, 8) },
    },
    '',
  );
  assert.equal(result.statusCode, 201, result.body);
  return {
    cookie: String(result.headers['set-cookie']).split(';')[0],
    tenant: result.json().user.tenant_id,
    user: result.json().user.id,
  };
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
});
beforeEach(async () => {
  // Isolate the HTTP limiter just like workspace tests; do not weaken the
  // production signup quota while creating an independent tenant per case.
  await app?.close();
  app = await buildApp();
  const user = await signup();
  cookie = user.cookie;
  tenant = user.tenant;
  userId = user.user;
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function product(price = 1000) {
  return ok('/products', 'POST', {
    sku: 'DASH-' + randomUUID().slice(0, 8),
    name: 'QA dashboard physical',
    price,
    quantity: 30,
    warehouse_id: warehouse,
  });
}
async function order(p: Row, quantity: number, extra: Row = {}) {
  if (extra.currency && extra.currency !== 'PLN' && !extra.price_list_id) {
    const list = await ok('/price-lists', 'POST', {
      name: 'QA dashboard ' + extra.currency + ' ' + randomUUID().slice(0, 8),
      currency: extra.currency,
      fallback: false,
    });
    await ok('/price-lists/' + list.id + '/items', 'PUT', {
      version: list.version,
      items: [{ product_id: p.id, price: p.price }],
    });
    extra = { ...extra, price_list_id: list.id };
  }
  return ok('/orders', 'POST', {
    customer_name: 'QA dashboard buyer',
    email: 'dash@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: p.id, quantity }],
    ...extra,
  });
}
async function receipt(id: string, amount: number, currency = 'PLN') {
  const current = await ok('/orders/' + id);
  return ok('/orders/' + id + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(current.version),
    kind: 'receipt',
    amount,
    currency,
    reference: 'QA actual money',
    confirmed: true,
  });
}
async function merge(main: Row, other: Row, mode: string) {
  const p = (
    await ok('/order-merges/previews', 'POST', {
      client_key: randomUUID(),
      main_order_id: main.id,
      order_ids_to_merge: [other.id],
      merge_mode: mode,
      sum_delivery_costs: true,
    })
  ).preview;
  assert.equal(p.ready, true);
  const execution = (
    await ok('/order-merges/execute', 'POST', {
      client_key: randomUUID(),
      preview_id: p.id,
      scope_hash: p.scope_hash,
      confirmed: true,
      confirmed_receiver_selection: true,
    })
  ).execution;
  return ok('/orders/' + execution.target_order_id);
}
async function unchangedRead(target = app, auth = cookie) {
  const protectedNames = [
    'orders',
    'order_items',
    'order_picks',
    'order_events',
    'payment_entries',
    'stock',
    'stock_locations',
    'stock_movements',
    'reservations',
    'reservation_locations',
    'shipments',
    'documents',
    'return_cases',
    'return_items',
    'jobs',
    'audit_events',
    'wms_layer_positions',
    'wms_reservation_layers',
    'wms_layer_movements',
    'wms_issue_fragments',
    'wms_return_fragments',
    'order_merge_previews',
    'order_merge_preview_rows',
    'order_merge_executions',
    'order_merge_execution_rows',
    'order_merge_claims',
    'order_merge_origins',
    'order_merge_custody_transfers',
  ];
  async function snapshot() {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const result: Row = {};
      for (const name of protectedNames) {
        if (!(await c.query('SELECT to_regclass($1) present', ['public.' + name])).rows[0].present)
          continue;
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
            tenant,
          ])
        ).rows;
        result[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      }
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  const before = await snapshot();
  const response = await req('/dashboard', 'GET', undefined, auth, target);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  const list = await req('/orders?limit=200', 'GET', undefined, auth, target);
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(
    await snapshot(),
    before,
    'Dashboard and operational order reads do not write business data',
  );
  return { dashboard: response.json(), orders: list.json().data };
}
function sections(
  result: Row,
  active: Row[],
  refunds: Record<string, number> = {},
  recentActive: Row[] = active,
) {
  const byStatus = new Map<string, Row>(),
    bySource = new Map<string, Row>();
  for (const o of active) {
    const statusKey = o.status + ':' + o.currency,
      sourceKey = o.source + ':' + o.currency;
    const status = byStatus.get(statusKey) ?? {
      status: o.status,
      currency: o.currency,
      count: 0,
      total: 0,
      refund_total: 0,
    };
    status.count++;
    status.total += o.total;
    status.refund_total += refunds[o.id] ?? 0;
    byStatus.set(statusKey, status);
    const source = bySource.get(sourceKey) ?? {
      source: o.source,
      currency: o.currency,
      count: 0,
      total: 0,
    };
    source.count++;
    source.total += o.total;
    bySource.set(sourceKey, source);
  }
  const normalize = (rows: Row[], keys: string[]) =>
    rows
      .map((r) =>
        Object.fromEntries(
          keys.map((k) => [
            k,
            ['count', 'total', 'refund_total'].includes(k) ? Number(r[k]) : r[k],
          ]),
        ),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(
    normalize(result.dashboard.orders, ['status', 'currency', 'count', 'total', 'refund_total']),
    normalize([...byStatus.values()], ['status', 'currency', 'count', 'total', 'refund_total']),
  );
  assert.deepEqual(
    normalize(result.dashboard.sources, ['source', 'currency', 'count', 'total']),
    normalize([...bySource.values()], ['source', 'currency', 'count', 'total']),
  );
  assert.deepEqual(result.orders.map((o: Row) => o.id).sort(), active.map((o) => o.id).sort());
  assert.deepEqual(
    result.dashboard.recent.map((o: Row) => o.id).sort(),
    recentActive.map((o) => o.id).sort(),
  );
  for (const recent of result.dashboard.recent) {
    const expected = active.find((o) => o.id === recent.id)!;
    for (const key of ['id', 'number', 'customer_name', 'total', 'currency', 'status', 'source'])
      assert.equal(recent[key], expected[key]);
    assert.equal(
      new Date(recent.created_at).toISOString(),
      new Date(expected.created_at).toISOString(),
    );
  }
  assert.equal(result.dashboard.currency, 'PLN');
}
test('ordinary dashboard keeps legacy status/source/currency grouping and tenant isolation without read effects', async () => {
  const p = await product(),
    first = await order(p, 2, { source: 'manual', shipping_cost: 100 }),
    second = await order(p, 1, { currency: 'EUR', source: 'shopify', shipping_cost: 50 });
  await ok('/orders/' + first.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + first.id + '/status', { status: 'cancelled' }));
  const current = await ok('/orders/' + first.id);
  const foreign = await signup();
  const foreignWarehouse = (await ok('/warehouses', 'GET', undefined, foreign.cookie)).data[0].id;
  const foreignProduct = await ok(
    '/products',
    'POST',
    {
      sku: 'FOREIGN-' + randomUUID(),
      name: 'No dashboard leak',
      price: 999999,
      quantity: 4,
      warehouse_id: foreignWarehouse,
    },
    foreign.cookie,
  );
  const foreignOrder = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'PRIVATE other firm',
      email: 'foreign@example.test',
      warehouse_id: foreignWarehouse,
      items: [{ product_id: foreignProduct.id, quantity: 1 }],
    },
    foreign.cookie,
  );
  const result = await unchangedRead();
  sections(result, [current, second]);
  assert.equal(JSON.stringify(result).includes(foreignOrder.id), false);
  const ownStock = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1', [tenant])
  ).rows;
  assert.equal(Number(result.dashboard.stock.products), ownStock.length);
  assert.equal(
    Number(result.dashboard.stock.on_hand),
    ownStock.reduce((n, r) => n + r.on_hand, 0),
  );
  assert.equal(
    Number(result.dashboard.stock.reserved),
    ownStock.reduce((n, r) => n + r.reserved, 0),
  );
  const ownJobs = (
    await pool.query(
      'SELECT state,count(*)::int count FROM jobs WHERE tenant_id=$1 GROUP BY state',
      [tenant],
    )
  ).rows;
  assert.deepEqual(
    [...result.dashboard.jobs].sort((a, b) => a.state.localeCompare(b.state)),
    ownJobs.sort((a, b) => a.state.localeCompare(b.state)),
  );
});
for (const mode of ['into_main_order', 'technical_merge'])
  test(
    mode +
      ': dashboard counts one active owner through partial money, dispatch and accepted partial return',
    async () => {
      const p = await product(),
        first = await order(p, 2, { shipping_cost: 100, source: 'manual' });
      await tenantTx(tenant, (c) => c.query('UPDATE products SET price=1700 WHERE id=$1', [p.id]));
      const second = await order(p, 1, { shipping_cost: 200, source: 'allegro' });
      const euroProduct = await product(700),
        euro = await order(euroProduct, 1, {
          currency: 'EUR',
          shipping_cost: 50,
          source: 'shopify',
        });
      await receipt(first.id, 1000);
      await receipt(second.id, 500);
      let owner = await merge(first, second, mode);
      assert.equal(owner.total, 4000);
      assert.equal(owner.payment.received, 1500);
      assert.equal(owner.payment.amount_due, 2500);
      sections(await unchangedRead(), [owner, euro]);
      await receipt(owner.id, 2500);
      await ok('/orders/' + owner.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + owner.id + '/status', { status: 'picking' }));
      for (let i = 0; i < 3; i++)
        await ok('/orders/' + owner.id + '/scan', 'POST', { code: p.sku });
      await ok('/orders/' + owner.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + owner.id + '/status', { status: 'packed' }));
      await ok('/orders/' + owner.id + '/ship-demo', 'POST');
      owner = await ok('/orders/' + owner.id);
      assert.equal(owner.status, 'shipped');
      sections(await unchangedRead(), [owner, euro]);
      const expensive = owner.items.find((i: Row) => i.price === 1700);
      assert(expensive);
      const r = await ok('/orders/' + owner.id + '/returns', 'POST', {
        client_key: randomUUID(),
        reason: 'QA partial accepted',
        items: [{ item_id: expensive.id, quantity: 1 }],
      });
      const accepted = await ok('/returns/' + r.id + '/receive', 'POST', {
        version: Number(r.version),
        shipping_refund: 0,
        note: 'Physical partial return',
        items: [{ item_id: expensive.id, accepted: 1, restocked: 1 }],
      });
      assert.equal(accepted.refund_amount, 1700);
      owner = await ok('/orders/' + owner.id);
      sections(await unchangedRead(), [owner, euro], { [owner.id]: 1700 });
      assert.equal(
        (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [p.id])).rows[0].on_hand,
        28,
      );
    },
  );
test('nested merge suppresses original sources and previous technical owner in every dashboard order section', async () => {
  const p = await product(),
    first = await order(p, 2, { shipping_cost: 100 }),
    second = await order(p, 1, { shipping_cost: 200 });
  const technical = await merge(first, second, 'technical_merge');
  const third = await order(p, 1, { shipping_cost: 300, source: 'shopify' });
  const final = await merge(third, technical, 'into_main_order');
  assert.equal(final.total, 4600);
  const result = await unchangedRead();
  sections(result, [final]);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [tenant])).rows[0].n,
    4,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM order_merge_claims WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    3,
  );
  for (const historical of [first, second, technical])
    assert(!JSON.stringify(result.dashboard).includes(historical.id));
});
test('pre-merge-schema dashboard fallback keeps ordinary reads and old grouping without mutation', async () => {
  const p = await product(),
    first = await order(p, 2, { shipping_cost: 100 }),
    second = await order(p, 1, { currency: 'EUR' });
  const before = await unchangedRead();
  sections(before, [first, second]);
  // Explicit isolated old-copy capability fixture. No source rows or migration
  // receipt are changed; restore the original name even if a read assertion fails.
  await pool.query('ALTER TABLE order_merge_claims RENAME TO qa_dashboard_old_claims');
  let legacy: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    legacy = await buildApp();
    const result = await unchangedRead(legacy);
    sections(result, [first, second]);
    assert.deepEqual(result.dashboard, before.dashboard);
  } finally {
    try {
      await legacy?.close();
    } finally {
      await pool.query('ALTER TABLE qa_dashboard_old_claims RENAME TO order_merge_claims');
    }
  }
});

test('incomplete merge module still suppresses real closed sources while full capability is unavailable', async () => {
  const p = await product(),
    first = await order(p, 2),
    second = await order(p, 1);
  const owner = await merge(first, second, 'technical_merge');
  await pool.query(
    'ALTER FUNCTION order_merge_custody_snapshot(uuid[]) RENAME TO qa_dashboard_missing_custody',
  );
  let incomplete: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    incomplete = await buildApp();
    const health = await req('/health', 'GET', undefined, cookie, incomplete);
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().order_merges_available, false);
    sections(await unchangedRead(incomplete), [owner]);
  } finally {
    try {
      await incomplete?.close();
    } finally {
      await pool.query(
        'ALTER FUNCTION qa_dashboard_missing_custody(uuid[]) RENAME TO order_merge_custody_snapshot',
      );
    }
  }
});
test('recent limits six active owners and uses deterministic UUID ordering for equal creation times', async () => {
  const p = await product(),
    first = await order(p, 1),
    second = await order(p, 1);
  const merged = await merge(first, second, 'technical_merge');
  // Genuine creation in one transaction gives DEFAULT now() identical times
  // at INSERT. Do not edit immutable creation times or bypass quota triggers.
  const ties = await tenantTx(tenant, async (c) => {
    const created: Row[] = [];
    for (let i = 0; i < 8; i++)
      created.push(
        await createOrder(
          c,
          { tenantId: tenant, userId, role: 'admin' },
          orderSchema.parse({
            customer_name: 'QA dashboard buyer',
            email: 'dash@example.test',
            warehouse_id: warehouse,
            items: [{ product_id: p.id, quantity: 1 }],
          }),
        ),
      );
    return JSON.parse(JSON.stringify(created)) as Row[];
  });
  assert.equal(
    (
      await pool.query(
        'SELECT count(DISTINCT created_at)::int n FROM orders WHERE id=ANY($1::uuid[])',
        [ties.map((o) => o.id)],
      )
    ).rows[0].n,
    1,
  );
  const active = [merged, ...ties];
  const expectedRecent = [...ties].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 6);
  const result = await unchangedRead();
  sections(result, active, {}, expectedRecent);
  assert.deepEqual(
    result.dashboard.recent.map((o: Row) => o.id),
    expectedRecent.map((o) => o.id),
  );
  assert.equal(result.dashboard.recent.length, 6);
  assert(!result.dashboard.recent.some((o: Row) => [first.id, second.id].includes(o.id)));
});
