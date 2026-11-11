import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL!);
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  ip = 1;
const req = (path: string, method: any = 'GET', body?: any) =>
  app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie },
    remoteAddress: '127.0.186.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.statusCode} ${r.body}`);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.SALES_REPORT_TEST_LOG === 'true',
    integrationTransport: async () => {
      throw Error('No provider in local report test');
    },
  });
  const l = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(l.statusCode, 200);
  cookie = String(l.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Own sales report engine','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Report source','REP')",
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
const day = () => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
};
const query = (x: any = {}) => new URLSearchParams({ from: day(), to: day(), ...x }).toString();
const report = (suffix: string, x: any = {}) => ok('/reports/sales' + suffix + '?' + query(x));
const product = (x: any = {}) =>
  ok('/products', 'POST', {
    sku: 'REPORT-' + randomUUID(),
    name: 'Report historical product',
    price: 12000,
    vat: 23,
    quantity: 0,
    warehouse_id: warehouse,
    location: 'A-01',
    ...x,
  });
const order = (items: any[], x: any = {}) =>
  ok('/orders', 'POST', {
    customer_name: 'Report own buyer',
    email: 'report@example.test',
    warehouse_id: warehouse,
    payment_mode: 'cod',
    items,
    ...x,
  });
async function versions(ids: string[]) {
  return Promise.all(
    ids.map(async (product_id) => ({
      warehouse_id: warehouse,
      product_id,
      version: String(
        (
          await pool.query(
            'SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
            [tenant, warehouse, product_id],
          )
        ).rows[0]?.version ?? '0',
      ),
    })),
  );
}
async function opening(lines: any[] = []) {
  const p = (
    await ok('/wms-lots/opening-previews', 'POST', {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Genuine report FIFO opening',
      lines,
    })
  ).preview;
  assert.equal(p.ready, true);
  await ok('/wms-lots/opening-previews/' + p.id + '/activate', 'POST', {
    client_key: randomUUID(),
    scope_hash: p.scope_hash,
    confirmed: true,
    ack_unknown_costs: lines.some((l) => l.unit_cost_minor === null),
  });
}
async function receive(lines: any[]) {
  const supplier = await ok('/suppliers', 'POST', {
    name: 'Report supplier',
    code: 'SUP-' + randomUUID(),
  });
  const draft = await ok('/purchase-orders', 'POST', {
    supplier_id: supplier.id,
    warehouse_id: warehouse,
    currency: 'PLN',
    lines,
  });
  const placed = await ok('/purchase-orders/' + draft.id + '/place', 'POST', {
    version: draft.version,
  });
  await ok('/purchase-orders/' + draft.id + '/receive', 'POST', {
    client_key: randomUUID(),
    version: placed.version,
    lines: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, location: 'A-01' })),
    wms_lots: {
      policy_version: '1',
      stock_versions: await versions(lines.map((l) => l.product_id)),
      lines: lines.map((l) => ({
        product_id: l.product_id,
        quantity: l.quantity,
        location: 'A-01',
        lot_code: 'RECEIPT-' + randomUUID(),
      })),
    },
  });
}
async function ship(o: any, wms = true) {
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  const picks = (
    await pool.query(
      'SELECT p.product_id,p.quantity,x.sku FROM order_pick_items p JOIN products x ON (x.tenant_id,x.id)=(p.tenant_id,p.product_id) WHERE p.tenant_id=$1 AND p.order_id=$2 ORDER BY p.product_id',
      [tenant, o.id],
    )
  ).rows;
  for (const p of picks) {
    if (wms) {
      const allocations = (
        await pool.query(
          'SELECT * FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 ORDER BY layer_id,location',
          [tenant, o.id, p.product_id],
        )
      ).rows;
      for (const a of allocations)
        for (let n = 0; n < a.quantity; n++)
          await ok('/orders/' + o.id + '/scan', 'POST', {
            client_key: randomUUID(),
            code: p.sku,
            location: a.location,
            layer_id: a.layer_id,
          });
    } else
      for (let n = 0; n < p.quantity; n++)
        await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  }
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
  await ok('/orders/' + o.id + '/ship-demo', 'POST', {});
  return ok('/orders/' + o.id);
}
async function returned(o: any, item: any, restocked: number, picks: any[] = [], wms = true) {
  const r = await ok('/orders/' + o.id + '/returns', 'POST', {
    client_key: randomUUID(),
    reason: 'Actual accepted report return',
    items: [{ item_id: item.id, quantity: 1 }],
  });
  const ids = [...new Set(picks.map((p) => p.product_id))] as string[];
  await ok('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version),
    shipping_refund: 0,
    note: 'Report damaged or physical restock',
    items: [{ item_id: item.id, accepted: 1, restocked }],
    ...(wms && restocked > 0
      ? {
          wms_lots: {
            client_key: randomUUID(),
            policy_version: '1',
            stock_versions: await versions(ids),
            picks: picks.map((p) => ({
              issue_fragment_id: p.id,
              quantity: p.return_quantity ?? 1,
              location: 'A-01',
            })),
          },
        }
      : {}),
  });
  return r;
}
async function stable() {
  const out: any = {};
  for (const table of [
    'orders',
    'order_items',
    'order_pick_items',
    'stock',
    'stock_locations',
    'reservations',
    'reservation_locations',
    'payment_entries',
    'return_cases',
    'return_items',
    'wms_issue_fragments',
    'wms_return_fragments',
    'wms_layer_movements',
    'audit_events',
  ])
    out[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return out;
}

test('Warsaw inclusive calendar boundaries include both DST transitions and reject invalid or oversized dates', async () => {
  const march = await ok('/reports/sales/summary?from=2026-03-29&to=2026-03-29');
  assert.equal(march.filters.from_at, '2026-03-28T23:00:00.000Z');
  assert.equal(march.filters.to_exclusive_at, '2026-03-29T22:00:00.000Z');
  const october = await ok('/reports/sales/summary?from=2026-10-25&to=2026-10-25');
  assert.equal(october.filters.from_at, '2026-10-24T22:00:00.000Z');
  assert.equal(october.filters.to_exclusive_at, '2026-10-25T23:00:00.000Z');
  for (const q of [
    'from=2026-02-30&to=2026-03-01',
    'from=2026-10-06&to=2026-10-05',
    'from=2025-01-01&to=2026-01-02',
  ])
    assert.equal((await req('/reports/sales/summary?' + q)).statusCode, 422);
  assert.deepEqual(march.sales, []);
});

test('genuine kit FIFO issue and partial restock produce exact current net margin without current recipe or payment joins', async () => {
  const a = await product({ price: 101 }),
    b = await product({ price: 203 }),
    kit = await product({
      kind: 'bundle',
      components: [
        { product_id: a.id, quantity: 2 },
        { product_id: b.id, quantity: 3 },
      ],
    });
  await opening();
  await receive([
    { product_id: a.id, quantity: 4, unit_cost: 101 },
    { product_id: b.id, quantity: 6, unit_cost: 203 },
  ]);
  const o = await ship(await order([{ product_id: kit.id, quantity: 2 }]));
  const issued = (
    await pool.query('SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2', [
      tenant,
      o.id,
    ])
  ).rows;
  assert.equal(
    issued.reduce((sum, p) => sum + BigInt(p.value_minor), 0n),
    1622n,
  );
  await returned(
    o,
    o.items[0],
    1,
    issued.map((p) => ({ ...p, return_quantity: p.product_id === a.id ? 2 : 3 })),
  );
  const current = await ok('/products/' + kit.id);
  await ok('/products/' + kit.id, 'PATCH', {
    ...current,
    components: [{ product_id: a.id, quantity: 1 }],
  });
  const before = await stable(),
    d = await report('/orders/' + o.id),
    r = d.order;
  assert.equal(r.goods_gross_minor, '24000');
  assert.equal(r.goods_net_minor, '19512');
  assert.equal(r.returned_goods_gross_minor, '12000');
  assert.equal(r.returned_goods_net_minor, '9756');
  assert.equal(r.current_goods_net_minor, '9756');
  assert.equal(r.issued_known_cost_minor, '1622');
  assert.equal(r.restocked_known_cost_minor, '811');
  assert.equal(r.net_known_cost_minor, '811');
  assert.equal(r.margin_minor, '8945');
  assert.equal(r.physical_quantity, '10');
  assert.equal(r.cost_complete, true);
  assert.equal(d.commercial_lines[0].margin_minor, null);
  assert.equal(d.physical_costs.length, 2);
  const s = await report('/summary');
  assert.equal(s.sales[0].total_gross_minor, '24000');
  assert.equal(s.returns[0].total_gross_minor, '12000');
  assert.equal(s.costs[0].issued_known_minor, '1622');
  assert.equal(s.costs[0].restocked_known_minor, '811');
  assert.equal(s.cohort_current[0].margin_minor, '8945');
  assert.deepEqual(await stable(), before);
});

test('same SKU historical prices, two FIFO layers and two accepted RMAs remain separate without many-to-many inflation', async () => {
  const p = await product({ price: 1230 });
  await opening();
  await receive([{ product_id: p.id, quantity: 1, unit_cost: 100 }]);
  await receive([{ product_id: p.id, quantity: 1, unit_cost: 200 }]);
  const a = await order([{ product_id: p.id, quantity: 1 }], { shipping_cost: 100 });
  await tenantTx(tenant, (c) => c.query('UPDATE products SET price=2460 WHERE id=$1', [p.id]));
  const b = await order([{ product_id: p.id, quantity: 1 }], { shipping_cost: 200 });
  const preview = (
    await ok('/order-merges/previews', 'POST', {
      client_key: randomUUID(),
      main_order_id: a.id,
      order_ids_to_merge: [b.id],
      merge_mode: 'technical_merge',
      sum_delivery_costs: true,
    })
  ).preview;
  const execution = (
    await ok('/order-merges/execute', 'POST', {
      client_key: randomUUID(),
      preview_id: preview.id,
      scope_hash: preview.scope_hash,
      confirmed: true,
    })
  ).execution;
  const target = await ship(await ok('/orders/' + execution.target_order_id));
  const items = [...target.items].sort((x, y) => x.price - y.price),
    issued = (
      await pool.query(
        'SELECT * FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 ORDER BY unit_cost_minor',
        [tenant, target.id],
      )
    ).rows;
  await returned(target, items[0], 0, []);
  await returned(target, items[1], 1, [issued[1]]);
  const d = await report('/orders/' + target.id);
  assert.equal(d.order.goods_gross_minor, '3690');
  assert.equal(d.order.goods_net_minor, '3000');
  assert.equal(d.order.delivery_gross_minor, '300');
  assert.equal(d.order.returned_goods_gross_minor, '3690');
  assert.equal(d.order.issued_known_cost_minor, '300');
  assert.equal(d.order.restocked_known_cost_minor, '200');
  assert.equal(d.order.margin_minor, '-100');
  assert.equal(d.commercial_lines.length, 2);
  assert(d.commercial_lines.every((x: any) => x.margin_minor === null));
  const r = await report('/returns');
  assert.equal(r.meta.total, 2);
  assert.equal(
    r.data.reduce((v: bigint, x: any) => v + BigInt(x.goods_gross_minor), 0n),
    3690n,
  );
  const s = await report('/summary');
  assert.equal(s.sales[0].orders, 1);
  assert.equal(s.returns[0].cases, 2);
  assert.equal(s.returns[0].restocked_quantity, '1');
});

test('unknown opening cost differs from explicit zero cost and never invents SKU margin', async () => {
  const unknown = await product({ quantity: 1, price: 123 }),
    zero = await product({ quantity: 1, price: 123 });
  const versions0 = await versions([unknown.id, zero.id]);
  await opening(
    [unknown, zero].map((p) => ({
      warehouse_id: warehouse,
      product_id: p.id,
      location: 'A-01',
      quantity: 1,
      stock_version: versions0.find((v) => v.product_id === p.id)!.version,
      lot_code: 'OPEN-' + p.id,
      unit_cost_minor: p.id === unknown.id ? null : '0',
    })),
  );
  const a = await ship(await order([{ product_id: unknown.id, quantity: 1 }])),
    b = await ship(await order([{ product_id: zero.id, quantity: 1 }]));
  const u = (await report('/orders/' + a.id)).order,
    z = (await report('/orders/' + b.id)).order;
  assert.equal(u.margin_minor, null);
  assert.equal(u.unknown_cost_quantity, '1');
  assert(u.cost_reasons.includes('unknown_layer_cost'));
  assert.equal(z.margin_minor, '100');
  assert.equal(z.issued_known_cost_minor, '0');
  assert.equal(z.cost_complete, true);
});

test('legacy empty components and missing cost module remain explicitly incomplete; no current bundle recipe inferred', async () => {
  const p = await product({ quantity: 3, price: 123 }),
    o = await order([{ product_id: p.id, quantity: 2 }]);
  await tenantTx(tenant, (c) =>
    c.query("UPDATE order_items SET components='[]'::jsonb WHERE order_id=$1", [o.id]),
  );
  const r = (await report('/orders/' + o.id)).order;
  assert.equal(r.physical_quantity, '2');
  assert.equal(r.missing_issue_quantity, '2');
  assert.equal(r.margin_minor, null);
  assert(r.cost_reasons.includes('physical_snapshot_unavailable'));
  await pool.query(
    'ALTER TABLE wms_return_fragments RENAME TO report_unavailable_return_fragments',
  );
  try {
    const d = (await report('/orders/' + o.id)).order;
    assert.equal(d.margin_minor, null);
    assert(d.cost_reasons.includes('wms_cost_module_unavailable'));
    const s = await report('/summary');
    assert.equal(s.cohort_current[0].incomplete_order_count, 1);
  } finally {
    await pool.query(
      'ALTER TABLE report_unavailable_return_fragments RENAME TO wms_return_fragments',
    );
  }
});

test('keyset pages and complete CSV include each tied order once, preserve amounts, and perform no business writes', async () => {
  const p = await product({ quantity: 20, price: 101 });
  for (let n = 0; n < 7; n++) await order([{ product_id: p.id, quantity: 1 }]);
  const before = await stable();
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await report('/orders', { limit: '2', ...(cursor ? { cursor } : {}) });
    assert.equal(page.meta.total, 7);
    ids.push(...page.data.map((x: any) => x.id));
    cursor = page.meta.cursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(ids).size, 7);
  const expected = (
    await pool.query('SELECT id FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC', [
      tenant,
    ])
  ).rows.map((x) => x.id);
  assert.deepEqual(ids, expected);
  const file = await req(
    '/reports/sales/file?' + query({ kind: 'orders', spreadsheet_safe: 'false' }),
  );
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers['x-sales-report-count'], '7');
  assert.equal(Number(file.headers['content-length']), Buffer.byteLength(file.body));
  const lines = file.body
    .replace(/^\ufeff/, '')
    .trim()
    .split('\r\n');
  assert.equal(lines.length, 8);
  assert.deepEqual(
    lines.slice(1).map((x) => x.split(',')[0].replaceAll('"', '')),
    expected,
  );
  assert(file.body.includes('"101"'));
  assert.deepEqual(await stable(), before);
});
