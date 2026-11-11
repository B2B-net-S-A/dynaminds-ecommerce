import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { normalizeOrder } from '../server/imports';
import { shopifyFulfillmentFixture } from './shopify-fulfillment-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const url = new URL(process.env.DATABASE_URL!);
assert.match(url.pathname, /^\/dynaminds_test_\d+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  warehouse = '',
  fixture = shopifyFulfillmentFixture();
const ctx = {
  transport: async (...args: Parameters<typeof fixture.transport>) => fixture.transport(...args),
};
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie } });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await req(path, method, payload);
  assert(r.statusCode < 300, `${path} ${r.statusCode}: ${r.body}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200, r.body);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(() => {
  fixture = shopifyFulfillmentFixture();
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });
function twoLines() {
  const raw = structuredClone(fixture.state.raw);
  const original = raw.lineItems.nodes[0];
  raw.lineItems.nodes = [
    {
      ...structuredClone(original),
      quantity: 2,
      currentQuantity: 2,
      unfulfilledQuantity: 2,
      originalTotalSet: money('10.01'),
      discountAllocations: [],
      taxLines: [],
    },
    {
      ...structuredClone(original),
      id: 'gid://shopify/LineItem/980013',
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 1,
      originalTotalSet: money('17.00'),
      discountAllocations: [],
      taxLines: [],
    },
  ];
  raw.shippingLines.nodes[0].taxLines = [];
  raw.totalPriceSet = money('32.01');
  raw.currentTotalPriceSet = money('32.01');
  raw.totalReceivedSet = money('32.01');
  raw.totalTaxSet = money('0.00');
  return raw;
}
async function setup(raw = twoLines()) {
  fixture.state.raw = raw;
  const ch = await ok('/integrations', 'POST', {
    provider: 'shopify',
    name: 'Source lines ' + randomUUID(),
    mode: 'sandbox',
    settings: { store_url: 'https://qa-' + randomUUID() + '.myshopify.com' },
    credentials: { access_token: 'qa-not-a-real-token-2026' },
  });
  const p = await ok('/products', 'POST', {
    sku: 'SOURCE-' + randomUUID(),
    name: 'Local PIM snapshot',
    price: 29999,
    vat: 23,
    quantity: 40,
    warehouse_id: warehouse,
  });
  await ok('/integrations/' + ch.id + '/mappings', 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku: p.sku,
  });
  const staged = (await ok('/integrations/' + ch.id + '/stage-orders', 'POST', { data: [raw] }))
    .data[0];
  return { ch, p, staged, raw };
}
const commit = (x: Awaited<ReturnType<typeof setup>>) =>
  req('/imports/' + x.staged.id + '/commit', 'POST', {
    warehouse_id: warehouse,
    expected_hash: x.staged.source_hash,
  });
async function imported() {
  const x = await setup();
  const r = await commit(x);
  assert.equal(r.statusCode, 200, r.body);
  return { ...x, order: r.json() };
}
async function bindings(id: string) {
  return (
    await pool.query(
      'SELECT * FROM order_source_lines WHERE source_order_id=$1 ORDER BY remote_line_id',
      [id],
    )
  ).rows;
}
async function effects() {
  const names = [
    'orders',
    'order_items',
    'order_pick_items',
    'reservations',
    'reservation_locations',
    'stock',
    'stock_locations',
    'stock_movements',
    'payment_entries',
    'order_events',
    'audit_events',
    'jobs',
    'inbound_orders',
    'order_source_lines',
  ];
  const out: Row = {};
  for (const n of names) {
    const rows = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${n}" t WHERE tenant_id=$1 ORDER BY 1`, [
        DEMO_TENANT,
      ])
    ).rows;
    out[n] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return out;
}

test('normalizer preserves full distinct LineItem GIDs independently from identical variant IDs and rejects missing/duplicate IDs', () => {
  const raw = twoLines(),
    o = normalizeOrder('shopify', raw);
  assert.deepEqual(
    o.items.map((i) => i.remote_line_id),
    ['gid://shopify/LineItem/980011', 'gid://shopify/LineItem/980013'],
  );
  assert.equal(o.items[0].external_id, o.items[1].external_id);
  assert.deepEqual(
    o.items.map((i) => i.line_total),
    [1001, 1700],
  );
  for (const id of ['', null, '701', raw.lineItems.nodes[0].id]) {
    const invalid = structuredClone(raw);
    invalid.lineItems.nodes[1].id = id;
    assert.throws(() => normalizeOrder('shopify', invalid));
  }
});
test('real import keeps two historical commercial amounts and one aggregated physical reservation/pick', async () => {
  const x = await imported();
  assert.equal(x.order.items.length, 2);
  assert.deepEqual(
    x.order.items.map((i: Row) => i.line_total).sort((a: number, b: number) => a - b),
    [1001, 1700],
  );
  assert.equal(x.order.total, 3201);
  assert(x.order.items.every((i: Row) => i.name === x.p.name && i.sku === x.p.sku && i.vat === 23));
  const b = await bindings(x.order.id);
  assert.equal(b.length, 2);
  assert.equal(new Set(b.map((l) => l.source_item_id)).size, 2);
  assert(
    b.every(
      (l) =>
        l.product_id === x.p.id &&
        l.external_product_id === 'gid://shopify/ProductVariant/701' &&
        l.inbound_id === x.staged.id &&
        l.source_hash === x.staged.source_hash,
    ),
  );
  const picks = (
    await pool.query('SELECT quantity,scanned FROM order_pick_items WHERE order_id=$1', [
      x.order.id,
    ])
  ).rows;
  assert.deepEqual(picks, [{ quantity: 3, scanned: 0 }]);
  assert.equal(
    (await pool.query('SELECT quantity FROM reservations WHERE order_id=$1', [x.order.id])).rows[0]
      .quantity,
    3,
  );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2',
        [x.p.id, warehouse],
      )
    ).rows[0],
    { on_hand: 40, reserved: 3 },
  );
});
test('non-divisible quantity preserves exact line_total and existing floor unit price without rounding the source', async () => {
  const x = await imported();
  const item = x.order.items.find((i: Row) => i.quantity === 2);
  assert.equal(item.price, 500);
  assert.equal(item.line_total, 1001);
  assert.equal((await bindings(x.order.id)).find((b) => b.quantity === 2).line_total, 1001);
});
test('exact import retry retains original source mapping and produces no new business/job/audit effects', async () => {
  const x = await imported();
  // Isolated legacy importer projection: before 106 it did not retain LineItem IDs.
  // Only the mutable inbound normalization is made legacy-shaped, never frozen orders/bindings.
  await pool.query(
    `UPDATE inbound_orders SET normalized=jsonb_set(normalized,'{items}',
    (SELECT jsonb_agg(line-'remote_line_id' ORDER BY ordinal) FROM jsonb_array_elements(normalized->'items') WITH ORDINALITY AS s(line,ordinal))) WHERE id=$1`,
    [x.staged.id],
  );
  const legacy = (
    await pool.query('SELECT normalized,imported_hash FROM inbound_orders WHERE id=$1', [
      x.staged.id,
    ])
  ).rows[0];
  assert(legacy.normalized.items.every((line: Row) => !Object.hasOwn(line, 'remote_line_id')));
  const frozen = (await pool.query('SELECT source_snapshot FROM orders WHERE id=$1', [x.order.id]))
    .rows[0];
  const duplicate = (
    await ok('/integrations/' + x.ch.id + '/stage-orders', 'POST', { data: [x.raw] })
  ).data[0];
  assert.equal(duplicate.source_hash, x.staged.source_hash);
  assert.deepEqual(
    (
      await pool.query('SELECT normalized,imported_hash FROM inbound_orders WHERE id=$1', [
        x.staged.id,
      ])
    ).rows[0],
    legacy,
    'Exact duplicate observation must not backfill an imported normalization',
  );
  assert.deepEqual(
    (await pool.query('SELECT source_snapshot FROM orders WHERE id=$1', [x.order.id])).rows[0],
    frozen,
  );
  const before = await effects();
  const r = await commit(x);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().id, x.order.id);
  assert.deepEqual(await effects(), before);
  const changed = structuredClone(x.raw);
  changed.updatedAt = '2026-10-04T10:00:01.000Z';
  changed.note = 'Genuine later observation';
  await ok('/integrations/' + x.ch.id + '/stage-orders', 'POST', { data: [changed] });
  const newer = (
    await pool.query(
      'SELECT normalized,source_hash,imported_hash FROM inbound_orders WHERE id=$1',
      [x.staged.id],
    )
  ).rows[0];
  assert.notEqual(newer.source_hash, x.staged.source_hash);
  assert.equal(newer.normalized.note, changed.note);
  assert(newer.normalized.items.every((line: Row) => typeof line.remote_line_id === 'string'));
  assert.equal(newer.imported_hash, legacy.imported_hash);
  assert.deepEqual(
    (await pool.query('SELECT source_snapshot FROM orders WHERE id=$1', [x.order.id])).rows[0],
    frozen,
  );
});
test('source guards reject forged own item/listing/quantity evidence and immutable changes with full rollback', async () => {
  const x = await imported(),
    other = await setup(),
    b = (await bindings(x.order.id))[0],
    wrongListing = (await pool.query('SELECT id FROM listings WHERE channel_id=$1', [other.ch.id]))
      .rows[0].id,
    before = await effects();
  for (const patch of [
    { quantity: b.quantity + 1 },
    { remote_line_id: 'gid://shopify/LineItem/999999' },
    { listing_id: wrongListing },
    { source_item_id: x.order.items.find((i: Row) => i.id !== b.source_item_id).id },
  ]) {
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) =>
        c.query(
          'INSERT INTO order_source_lines SELECT (jsonb_populate_record(NULL::order_source_lines,$1::jsonb)).*',
          [JSON.stringify({ ...b, id: randomUUID(), ...patch })],
        ),
      ),
      (e) => (e as any).code === '23514',
    );
  }
  await assert.rejects(
    pool.query('UPDATE order_source_lines SET line_total=line_total+1 WHERE id=$1', [b.id]),
    (e) => (e as any).code === '23514',
  );
  assert.deepEqual(await effects(), before);
});
test('FORCE RLS and genuine composite item FK prevent foreign source line identity leakage', async () => {
  const x = await imported();
  assert.equal(
    (
      await pool.query(
        "SELECT relrowsecurity AND relforcerowsecurity enabled FROM pg_class WHERE oid='order_source_lines'::regclass",
      )
    ).rows[0].enabled,
    true,
  );
  assert.deepEqual(
    await tenantTx(
      SECOND_TENANT,
      async (c) =>
        (await c.query('SELECT id FROM order_source_lines WHERE source_order_id=$1', [x.order.id]))
          .rows,
    ),
    [],
  );
  const b = (await bindings(x.order.id))[0];
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query(
        'INSERT INTO order_source_lines SELECT (jsonb_populate_record(NULL::order_source_lines,$1::jsonb)).*',
        [
          JSON.stringify({
            ...b,
            id: randomUUID(),
            source_item_id: randomUUID(),
            remote_line_id: 'gid://shopify/LineItem/998899',
          }),
        ],
      ),
    ),
    (e) => (e as any).code === '23503',
  );
});
test('old copy refuses a new binding import but existing imported replay remains byte-exact and does not backfill', async () => {
  const existing = await imported(),
    fresh = await setup();
  await pool.query('ALTER TABLE order_source_lines RENAME TO qa_source_lines_missing');
  try {
    const before = (
      await pool.query('SELECT to_jsonb(o) row FROM orders o WHERE id=$1', [existing.order.id])
    ).rows;
    const replay = await commit(existing);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(
      (await pool.query('SELECT to_jsonb(o) row FROM orders o WHERE id=$1', [existing.order.id]))
        .rows,
      before,
    );
    const newImport = await commit(fresh);
    assert.equal(newImport.statusCode, 503, newImport.body);
    assert.equal(
      (await pool.query('SELECT order_id FROM inbound_orders WHERE id=$1', [fresh.staged.id]))
        .rows[0].order_id,
      null,
    );
  } finally {
    await pool.query('ALTER TABLE qa_source_lines_missing RENAME TO order_source_lines');
  }
});
test('technical merge preserves immutable original source bindings and copies each commercial fragment independently', async () => {
  const x = await imported();
  const other = await ok('/orders', 'POST', {
    customer_name: 'Second receiver',
    email: 'second@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: x.p.id, quantity: 1 }],
  });
  const before = await bindings(x.order.id);
  const p = (
    await ok('/order-merges/previews', 'POST', {
      client_key: randomUUID(),
      main_order_id: x.order.id,
      order_ids_to_merge: [other.id],
      merge_mode: 'technical_merge',
      sum_delivery_costs: false,
    })
  ).preview;
  assert.equal(p.ready, true);
  const e = (
    await ok('/order-merges/execute', 'POST', {
      client_key: randomUUID(),
      preview_id: p.id,
      scope_hash: p.scope_hash,
      confirmed: true,
      confirmed_receiver_selection: true,
    })
  ).execution;
  const target = await ok('/orders/' + e.target_order_id);
  assert.equal(target.items.length, 3);
  assert.deepEqual(await bindings(x.order.id), before);
  assert.equal(
    (await bindings(target.id)).length,
    0,
    'No invented source line bindings on copied technical target',
  );
  assert.equal(target.picking_items[0].quantity, 4);
});
