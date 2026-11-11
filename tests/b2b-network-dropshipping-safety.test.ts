import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { processB2bCatalog } from '../server/b2b-network';
import { assertB2bWholeParcelAckInTx } from '../server/b2b-dropship-ack-guard';
import { demoShopifyOrder } from '../server/shopify-example';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let buyer = '',
  supplier = '',
  buyerWarehouse = '',
  supplierWarehouse = '';
let buyerUser = '',
  supplierUser = '',
  buyerCookie = '',
  supplierCookie = '',
  viewerCookie = '';
let ip = 1,
  providerCalls = 0;
const transport = async () => {
  ++providerCalls;
  throw Error('Own network dropshipping safety must never contact an external provider');
};
const request = (
  path: string,
  method: any = 'GET',
  body?: any,
  auth = buyerCookie,
  target = app,
  headers: Record<string, string> = {},
) =>
  target.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie: auth, ...headers },
    remoteAddress: '127.0.186.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any, auth = buyerCookie, target = app) {
  const r = await request(path, method, body, auth, target);
  assert(
    r.statusCode >= 200 && r.statusCode < 300,
    `${method} ${path}: ${r.statusCode} ${r.body.slice(0, 500)}`,
  );
  return r.json() as Row;
}
async function login(email: string, target = app) {
  const r = await request('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
async function enter(email: string, tenant: string, target = app) {
  const r = await request(
    '/workspaces/switch',
    'POST',
    { tenant_id: tenant },
    await login(email, target),
    target,
  );
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.B2B_DROPSHIPPING_TEST_LOG === 'true',
  });
  buyerUser = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0].id;
  supplierUser = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0]
    .id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  buyer = randomUUID();
  supplier = randomUUID();
  buyerWarehouse = randomUUID();
  supplierWarehouse = randomUUID();
  for (const [tenant, user, wh, label] of [
    [buyer, buyerUser, buyerWarehouse, 'Buyer'],
    [supplier, supplierUser, supplierWarehouse, 'Supplier'],
  ]) {
    await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'enterprise')", [
      tenant,
      'Own dropshipping ' + label,
    ]);
    await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
      tenant,
      user,
    ]);
    await pool.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [
      wh,
      tenant,
      label,
      label,
    ]);
  }
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'viewer' FROM users WHERE email='viewer@demo.local'",
    [buyer],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    buyer,
    supplierUser,
  ]);
  buyerCookie = await enter('other@demo.local', buyer);
  supplierCookie = await enter('admin@demo.local', supplier);
  viewerCookie = await enter('viewer@demo.local', buyer);
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function fixture() {
  const source = await ok(
    '/products',
    'POST',
    {
      sku: 'DS-SUP-' + randomUUID(),
      name: 'Own wholesale product',
      price: 1900,
      vat: 23,
      quantity: 30,
      warehouse_id: supplierWarehouse,
    },
    supplierCookie,
  );
  const list = await ok(
    '/price-lists',
    'POST',
    { name: 'Own wholesale list ' + randomUUID(), currency: 'PLN' },
    supplierCookie,
  );
  await ok(
    '/price-lists/' + list.id + '/items',
    'PUT',
    { version: list.version, items: [{ product_id: source.id, price: 700 }] },
    supplierCookie,
  );
  const accountBody = {
    name: 'Own purchasing firm',
    email: 'wholesale-' + randomUUID() + '@example.test',
    warehouse_id: supplierWarehouse,
    price_list_id: list.id,
    address: {
      street: 'Company warehouse 1',
      city: 'Poznań',
      postal_code: '60-001',
      country: 'PL',
    },
    min_total: 0,
    min_quantity: 1,
    quantity_step: 1,
    shipping_cost: 0,
    payment_mode: 'prepaid',
  };
  const account = await ok('/b2b/accounts', 'POST', accountBody, supplierCookie);
  const enabled = await ok(
    '/b2b/accounts/' + account.id,
    'PATCH',
    { ...accountBody, version: account.version, active: true, confirmed: true },
    supplierCookie,
  );
  const invite = await ok(
    '/b2b/accounts/' + account.id + '/network-invite',
    'POST',
    {
      version: enabled.version,
      recipient_email: 'other@demo.local',
      confirmed: true,
    },
    supplierCookie,
  );
  const link = await ok('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true });
  const base = '/b2b/network/links/' + link.id;
  const run = await ok(base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true });
  for (let i = 0; i < 5; ++i) {
    const current = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [run.id]))
      .rows[0];
    if (current.state === 'done') break;
    assert.equal(current.state, 'queued');
    const job = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
        [current.job_id, randomUUID()],
      )
    ).rows[0];
    await processB2bCatalog(job);
    // Complete the genuinely processed job just as the worker does; no fabricated run success.
    await pool.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",
      [job.id, job.lease_token],
    );
  }
  assert.equal(
    (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0].state,
    'done',
  );
  const item = (await ok(base + '/catalog')).data.find(
    (i: Row) => i.source_product_id === source.id,
  );
  assert(item, 'The genuine catalog run must publish the exact supplier product');
  const imported = await ok(base + '/catalog/' + item.id + '/product', 'POST', {
    version: item.version,
    sku: 'DS-LOCAL-' + randomUUID(),
    sale_price: 2500,
    warehouse_id: buyerWarehouse,
    confirmed: true,
  });
  assert.match(imported.product_id, /^[0-9a-f-]{36}$/);
  const local = await ok('/products/' + imported.product_id);
  assert.equal(local.id, imported.product_id);
  const document = await ok('/warehouse-documents', 'POST', {
    kind: 'receipt',
    warehouse_id: buyerWarehouse,
    reference: 'Own synthetic source stock',
    note: '',
    lines: [{ product_id: local.id, quantity: 20, location: 'DS-01' }],
  });
  await ok('/warehouse-documents/' + document.id + '/post', 'POST', { version: document.version });
  const order = await sale(local.id);
  return {
    source,
    list,
    account: enabled,
    link,
    item,
    local,
    order,
    base,
    path: base + '/dropshipping',
  };
}
async function sale(product: string, quantity = 3, extra: Row = {}) {
  return ok('/orders', 'POST', {
    customer_name: 'Own retail customer',
    email: 'retail@example.test',
    address: {
      street: 'Customer street 9',
      city: 'Gdańsk',
      postal_code: '80-001',
      country: 'PL',
      phone: '555000126',
    },
    warehouse_id: buyerWarehouse,
    currency: 'PLN',
    payment_mode: 'cod',
    items: [{ product_id: product, quantity }],
    ...extra,
  });
}
function quoteBody(f: Row, quantity = 2, extra: Row = {}) {
  assert(f.order.items.length);
  return {
    client_key: randomUUID(),
    customer_order_id: f.order.id,
    items: [
      {
        customer_item_id: f.order.items[0].id,
        quantity,
        mappings: [{ product_id: f.local.id, catalog_item_id: f.item.id }],
      },
    ],
    ...extra,
  };
}
async function quote(f: Row, body = quoteBody(f), token?: string) {
  const r = token
    ? await publicRequest(token, f.path + '/quotes', 'POST', body)
    : await request(f.path + '/quotes', 'POST', body);
  assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body.slice(0, 500)}`);
  return r.json().quote as Row;
}
const consent = (q: Row, client_key = randomUUID()) => ({
  client_key,
  scope_hash: q.scope_hash,
  confirmed: true,
  confirmed_receiver: true,
});
const readScopes = ['products:read', 'inventory:read', 'orders:read', 'purchasing:read'];
const writeScopes = [...readScopes, 'inventory:write', 'orders:write', 'purchasing:write'];
const publicRequest = (token: string, path: string, method: any = 'GET', body?: any) =>
  request('/v1' + path, method, body, '', app, {
    authorization: 'Bearer ' + token,
    'X-Workspace-ID': buyer,
  });
async function key(scopes = writeScopes) {
  return ok('/developer/keys', 'POST', { name: 'Own dropshipping safety', scopes });
}
async function checkout(f: Row, q: Row, body = consent(q), token?: string) {
  const r = token
    ? await publicRequest(token, f.path + '/quotes/' + q.id + '/checkout', 'POST', body)
    : await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', body);
  assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body.slice(0, 500)}`);
  return r.json().order as Row;
}
async function row(table: string, tenant: string, id: string) {
  assert.match(table, /^[a-z_]+$/);
  return (await pool.query(`SELECT * FROM "${table}" WHERE tenant_id=$1 AND id=$2`, [tenant, id]))
    .rows[0];
}
async function snapshot(tenants = [buyer, supplier]) {
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','outbound_subscriptions','sessions') ORDER BY 1`)
  ).rows;
  const result: Row = {};
  for (const { table_name: name } of names) {
    assert.match(name, /^[a-z][a-z0-9_]*$/);
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [tenants],
      )
    ).rows;
    result[name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return result;
}
async function waitOn(holder: PoolClient, pattern: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const waits = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (waits.some((r) => pattern.test(r.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The actual dropshipping request did not reach the held database lock');
}
async function grantChange(sql: string, parameters: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query(sql, parameters);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
function assertNoFinancialProjection(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(assertNoFinancialProjection);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert(
      ![
        'unit_price_minor',
        'line_total_minor',
        'total_minor',
        'total_gross',
        'unit_gross',
        'shipping_gross',
        'unit_cost_minor',
        'received',
        'refunded',
        'credit',
        'amount_due',
        'overpayment',
      ].includes(key),
      'Quantity projection must omit financial field ' + key,
    );
    assertNoFinancialProjection(nested);
  }
}

test('exact customer and line identities cannot be forged across firms, and receiver overrides are rejected without effects', async () => {
  const f = await fixture();
  const foreign = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Private foreign customer',
      email: 'foreign@example.test',
      address: { street: 'FOREIGN-PII-126', city: 'Poznań', postal_code: '60-001', country: 'PL' },
      warehouse_id: supplierWarehouse,
      payment_mode: 'cod',
      items: [{ product_id: f.source.id, quantity: 1 }],
    },
    supplierCookie,
  );
  const body = quoteBody(f);
  const before = await snapshot();
  const invalid: Array<{ body: Row; status: number }> = [
    {
      body: {
        ...body,
        receiver: {
          customer_name: 'Forged',
          email: 'forged@example.test',
          address: foreign.address,
        },
      },
      status: 422,
    },
    { body: { ...body, address: foreign.address }, status: 422 },
    {
      body: {
        ...body,
        items: [
          {
            ...body.items[0],
            mappings: [{ product_id: f.local.id, catalog_item_id: randomUUID() }],
          },
        ],
      },
      status: 409,
    },
  ];
  for (const input of invalid) {
    const r = await request(f.path + '/quotes', 'POST', input.body);
    assert.equal(r.statusCode, input.status);
    assert.match(String(r.headers['cache-control']), /no-store/);
    assert(!r.body.includes('FOREIGN-PII-126'));
    assert.deepEqual(await snapshot(), before);
  }
  const r = await request(f.path + '/quotes', 'POST', {
    ...body,
    customer_order_id: foreign.id,
    items: [{ ...body.items[0], customer_item_id: foreign.items[0].id }],
  });
  assert.equal(r.statusCode, 404);
  assert(!r.body.includes('FOREIGN-PII-126'));
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('same-SKU price fragments retain exact capacity under concurrent quotes, and canonical retry does not duplicate either firm effects', async () => {
  const f = await fixture();
  // The actual staged Shopify importer creates immutable source-line bindings and
  // two commercial fragments sharing one physical custody. The explicit own
  // simulation setting prevents any provider request, as in the stage107 fixtures.
  const channel = await ok('/integrations', 'POST', {
    provider: 'shopify',
    name: 'Own priced fragments ' + randomUUID(),
    mode: 'sandbox',
    settings: { store_url: 'https://own-dropship-' + randomUUID() + '.myshopify.com' },
    credentials: { access_token: 'qa-not-a-real-token-2026' },
  });
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE tenant_id=$1 AND id=$2',
    [buyer, channel.id],
  );
  await ok('/integrations/' + channel.id + '/mappings', 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku: f.local.sku,
  });
  const raw = structuredClone(demoShopifyOrder);
  const money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });
  const original = raw.lineItems.nodes[0];
  raw.lineItems.nodes = [
    {
      ...structuredClone(original),
      quantity: 2,
      currentQuantity: 2,
      unfulfilledQuantity: 2,
      originalTotalSet: money('50.00'),
      discountAllocations: [],
      taxLines: [],
    },
    {
      ...structuredClone(original),
      id: 'gid://shopify/LineItem/980013',
      quantity: 3,
      currentQuantity: 3,
      unfulfilledQuantity: 3,
      originalTotalSet: money('90.00'),
      discountAllocations: [],
      taxLines: [],
    },
  ];
  raw.shippingLines.nodes = [];
  raw.totalPriceSet = money('140.00');
  raw.currentTotalPriceSet = money('140.00');
  raw.totalReceivedSet = money('140.00');
  raw.totalTaxSet = money('0.00');
  const inbound = (
    await ok('/integrations/' + channel.id + '/stage-orders', 'POST', { data: [raw] })
  ).data[0];
  f.order = await ok('/imports/' + inbound.id + '/commit', 'POST', {
    warehouse_id: buyerWarehouse,
    expected_hash: inbound.source_hash,
  });
  const sourceLines = (
    await pool.query(
      'SELECT source_item_id,product_id,quantity,line_total,source_hash FROM order_source_lines WHERE tenant_id=$1 AND source_order_id=$2 ORDER BY quantity',
      [buyer, f.order.id],
    )
  ).rows;
  assert.equal(sourceLines.length, 2);
  assert.equal(new Set(sourceLines.map((l) => l.source_item_id)).size, 2);
  assert(
    sourceLines.every((l) => l.product_id === f.local.id && l.source_hash === inbound.source_hash),
  );
  assert.deepEqual(
    sourceLines.map((l) => [l.quantity, l.line_total]),
    [
      [2, 5000],
      [3, 9000],
    ],
  );
  const cheap = f.order.items.find((i: Row) => i.price === 2500),
    expensive = f.order.items.find((i: Row) => i.price === 3000);
  assert(cheap && expensive && cheap.id !== expensive.id);
  assert.equal(cheap.sku, expensive.sku);
  f.order.items = [cheap, expensive];
  const beforeInvalid = await snapshot();
  assert.equal((await request(f.path + '/quotes', 'POST', quoteBody(f, 3))).statusCode, 409);
  assert.deepEqual(await snapshot(), beforeInvalid);
  const first = await quote(f),
    second = await quote(f);
  const bodies = [consent(first), consent(second)];
  const before = await snapshot();
  const retailBefore = await row('orders', buyer, f.order.id);
  const itemsBefore = (
    await pool.query('SELECT * FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY id', [
      buyer,
      f.order.id,
    ])
  ).rows;
  const results = await Promise.all(
    [first, second].map((q, i) =>
      request(f.path + '/quotes/' + q.id + '/checkout', 'POST', bodies[i]),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  const winner = results.findIndex((r) => r.statusCode === 201),
    q = [first, second][winner];
  const forwarded = results[winner].json().order;
  assert(forwarded.id);
  const wholesale = await row('orders', supplier, forwarded.supplier_order_id);
  assert.equal(wholesale.total, 1400);
  assert.equal(wholesale.payment_mode, 'prepaid');
  assert.equal(wholesale.currency, 'PLN');
  const retailAfter = await row('orders', buyer, f.order.id);
  for (const field of [
    'total',
    'currency',
    'payment_mode',
    'customer_name',
    'email',
    'address',
    'shipping_cost',
    'portal_token',
  ])
    assert.deepEqual(retailAfter[field], retailBefore[field], field);
  assert.deepEqual(
    (
      await pool.query('SELECT * FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY id', [
        buyer,
        f.order.id,
      ])
    ).rows,
    itemsBefore,
  );
  assert.deepEqual(
    (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        buyer,
        f.local.id,
      ])
    ).rows[0],
    { on_hand: 20, reserved: 6 },
  );
  const after = await snapshot();
  for (const table of [
    'payment_entries',
    'warehouse_documents',
    'warehouse_document_lines',
    'b2b_network_receipts',
    'b2b_network_receipt_lines',
  ])
    assert.equal(after[table], before[table], table);
  const reversed = Object.fromEntries(Object.entries(bodies[winner]).reverse());
  const replay = await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', reversed);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().order.id, forwarded.id);
  assert.equal(replay.json().reused, true);
  assert.deepEqual(await snapshot(), after);
  const changed = await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', {
    ...bodies[winner],
    confirmed_receiver: false,
  });
  assert.equal(changed.statusCode, 422);
  assert.deepEqual(await snapshot(), after);
  const collision = await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', {
    ...bodies[winner],
    scope_hash: bodies[winner].scope_hash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
  });
  assert.equal(collision.statusCode, 409);
  const otherActor = await enter('admin@demo.local', buyer);
  const actorCollision = await request(
    f.path + '/quotes/' + q.id + '/checkout',
    'POST',
    bodies[winner],
    otherActor,
  );
  assert.equal(actorCollision.statusCode, 409);
  assert.deepEqual(await snapshot(), after);
  const exhausted = await request(f.path + '/quotes', 'POST', quoteBody(f, 1));
  assert.equal(exhausted.statusCode, 409);
  assert.deepEqual(await snapshot(), after);
  const otherLine = await quote(
    f,
    quoteBody(f, 1, {
      items: [
        {
          customer_item_id: expensive.id,
          quantity: 1,
          mappings: [{ product_id: f.local.id, catalog_item_id: f.item.id }],
        },
      ],
    }),
  );
  assert(otherLine.id, 'The separate expensive fragment retains its own forwarding capacity');
  assert.equal(providerCalls, 0);
});

test('admin withdrawal during a real order wait rolls back checkout, while another current admin can later restore the original custody', async () => {
  const f = await fixture(),
    q = await quote(f),
    body = consent(q);
  const before = await snapshot(),
    holder = await pool.connect();
  let pending: ReturnType<typeof request> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      buyer,
      f.order.id,
    ]);
    pending = request(f.path + '/quotes/' + q.id + '/checkout', 'POST', body);
    await waitOn(holder, /orders/i);
    await grantChange("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      buyer,
      buyerUser,
    ]);
    await holder.query('ROLLBACK');
    const rejected = await pending;
    assert.equal(rejected.statusCode, 403);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    if (pending) await pending;
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      buyer,
      buyerUser,
    ]);
  }
  const forwarded = await checkout(f, q, body);
  assert.equal(forwarded.customer_order_id, f.order.id);
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    buyer,
    buyerUser,
  ]);
  try {
    const otherAdmin = await enter('admin@demo.local', buyer);
    const cancelled = await ok(
      f.path + '/orders/' + forwarded.id + '/cancel',
      'POST',
      {
        client_key: randomUUID(),
        version: forwarded.version,
        reason: 'Actual current admin restores own stock',
        confirmed: true,
      },
      otherAdmin,
    );
    assert.equal(cancelled.order.state, 'cancelled');
    assert.deepEqual(
      (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [buyer, f.local.id],
        )
      ).rows[0],
      { on_hand: 20, reserved: 3 },
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [supplier, f.source.id],
        )
      ).rows[0],
      { on_hand: 30, reserved: 0 },
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      buyer,
      buyerUser,
    ]);
  }
  assert.equal(providerCalls, 0);
});

test('current API revoke, expiry and compound-scope loss after genuine customer-order waits reject checkout before durable effects', async () => {
  for (const mode of ['revoke', 'expiry', 'scope'] as const) {
    const f = await fixture(),
      credential = await key(),
      q = await quote(f, quoteBody(f), credential.token);
    const before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof publicRequest> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        buyer,
        f.order.id,
      ]);
      pending = publicRequest(
        credential.token,
        f.path + '/quotes/' + q.id + '/checkout',
        'POST',
        consent(q),
      );
      await waitOn(holder, /orders/i);
      await grantChange(
        mode === 'revoke'
          ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
          : mode === 'expiry'
            ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
            : 'UPDATE api_keys SET scopes=$2::text[] WHERE id=$1',
        mode === 'scope'
          ? [credential.id, writeScopes.filter((s) => s !== 'inventory:write')]
          : [credential.id],
      );
      await holder.query('ROLLBACK');
      const rejected = await pending;
      assert.equal(rejected.statusCode, mode === 'scope' ? 403 : 401, mode);
      assert.match(String(rejected.headers['cache-control']), /no-store/);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (pending) await pending;
    }
  }
  assert.equal(providerCalls, 0);
});

test('current mapping, active catalogue and supplier quote drift each invalidate the entire frozen checkout', async () => {
  for (const mode of ['mapping', 'inactive', 'price'] as const) {
    const f = await fixture(),
      q = await quote(f);
    if (mode === 'mapping') {
      const other = await ok('/products', 'POST', {
        sku: 'OTHER-' + randomUUID(),
        name: 'Unrelated own product',
        price: 2500,
        quantity: 0,
        warehouse_id: buyerWarehouse,
      });
      await pool.query(
        'UPDATE b2b_catalog_items SET product_id=$2,version=version+1 WHERE tenant_id=$3 AND id=$1',
        [f.item.id, other.id, buyer],
      );
    } else if (mode === 'inactive') {
      await pool.query(
        'UPDATE products SET active=false,version=version+1 WHERE tenant_id=$1 AND id=$2',
        [buyer, f.local.id],
      );
    } else {
      const current = (
        await ok(
          '/price-lists?limit=100&search=' + encodeURIComponent(f.list.name),
          'GET',
          undefined,
          supplierCookie,
        )
      ).data.find((l: Row) => l.id === f.list.id);
      assert(current, 'The actual supplier price-list page must contain the selected own list');
      await ok(
        '/price-lists/' + f.list.id + '/items',
        'PUT',
        { version: current.version, items: [{ product_id: f.source.id, price: 701 }] },
        supplierCookie,
      );
    }
    const before = await snapshot();
    const rejected = await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', consent(q));
    assert.equal(rejected.statusCode, 409, mode);
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal(providerCalls, 0);
});

test('a quote cannot release custody that has been scanned after approval', async () => {
  const f = await fixture(),
    q = await quote(f);
  await ok('/orders/' + f.order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.order.id + '/status', { status: 'picking' }));
  await ok('/orders/' + f.order.id + '/scan', 'POST', { code: f.local.sku });
  await ok('/orders/' + f.order.id + '/scan', 'POST', { code: f.local.sku });
  const before = await snapshot();
  const stale = await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', consent(q));
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  // Fresh selection cannot forward the already scanned two units either.
  const excessive = await request(f.path + '/quotes', 'POST', quoteBody(f, 2));
  assert.equal(excessive.statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('a genuine merge claim closes the old source to both new forwarding and previously approved checkout', async () => {
  const f = await fixture(),
    q = await quote(f);
  const main = await sale(f.local.id, 1);
  const preview = (
    await ok('/order-merges/previews', 'POST', {
      client_key: randomUUID(),
      main_order_id: main.id,
      order_ids_to_merge: [f.order.id],
      merge_mode: 'into_main_order',
      sum_delivery_costs: true,
    })
  ).preview;
  assert.equal(preview.ready, true);
  await ok('/order-merges/execute', 'POST', {
    client_key: randomUUID(),
    preview_id: preview.id,
    scope_hash: preview.scope_hash,
    confirmed: true,
  });
  assert.equal(
    (
      await pool.query(
        'SELECT target_order_id FROM order_merge_claims WHERE tenant_id=$1 AND source_order_id=$2',
        [buyer, f.order.id],
      )
    ).rows[0].target_order_id,
    main.id,
  );
  const before = await snapshot();
  for (const [path, body] of [
    [f.path + '/quotes', quoteBody(f)],
    [f.path + '/quotes/' + q.id + '/checkout', consent(q)],
  ] as const) {
    const r = await request(path, 'POST', body);
    assert.equal(r.statusCode, 409);
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal(providerCalls, 0);
});

test('all dropshipping evidence forces tenant isolation, private custody is inaccessible, and genuine foreign line FK and immutable writes roll back', async () => {
  const f = await fixture(),
    q = await quote(f),
    forwarded = await checkout(f, q);
  const before = await snapshot();
  const tables = [
    'b2b_dropship_quotes',
    'b2b_dropship_orders',
    'b2b_dropship_lines',
    'b2b_dropship_actions',
    'b2b_dropship_supplier_orders',
    'b2b_dropship_custody_transfers',
    'b2b_dropship_created_orders',
  ];
  for (const table of tables) {
    const flags = (
      await pool.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        ['public.' + table],
      )
    ).rows[0];
    assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true }, table);
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [supplier]);
    for (const table of tables.filter(
      (t) => !['b2b_dropship_custody_transfers', 'b2b_dropship_created_orders'].includes(t),
    ))
      assert.equal(
        (await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [buyer])).rows[0]
          .n,
        0,
        table,
      );
    for (const table of ['b2b_dropship_custody_transfers', 'b2b_dropship_created_orders']) {
      await c.query('SAVEPOINT private_access');
      await assert.rejects(c.query(`SELECT 1 FROM ${table} LIMIT 1`), { code: '42501' });
      await c.query('ROLLBACK TO SAVEPOINT private_access');
      assert.equal(
        (
          await pool.query(
            "SELECT has_table_privilege('dyna_app',$1,'SELECT,INSERT,UPDATE,DELETE') allowed",
            ['public.' + table],
          )
        ).rows[0].allowed,
        false,
      );
    }
    await c.query('ROLLBACK');
    for (const statement of [
      "UPDATE b2b_dropship_quotes SET scope_hash=repeat('0',64) WHERE tenant_id=$1",
      'DELETE FROM b2b_dropship_quotes WHERE tenant_id=$1',
      'UPDATE b2b_dropship_lines SET quantity=quantity+1 WHERE tenant_id=$1',
      'DELETE FROM b2b_dropship_lines WHERE tenant_id=$1',
      "UPDATE b2b_dropship_custody_transfers SET pieces='[]'::jsonb WHERE tenant_id=$1",
      'DELETE FROM b2b_dropship_custody_transfers WHERE tenant_id=$1',
      'UPDATE b2b_dropship_orders SET customer_order_id=$2 WHERE tenant_id=$1',
    ]) {
      await c.query('BEGIN');
      await assert.rejects(
        c.query(statement, statement.includes('$2') ? [buyer, randomUUID()] : [buyer]),
        { code: '23514' },
      );
      await c.query('ROLLBACK');
    }
    assert.deepEqual(await snapshot(), before);
    const foreign = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'Foreign FK source',
        email: 'foreign-fk@example.test',
        warehouse_id: supplierWarehouse,
        payment_mode: 'cod',
        items: [{ product_id: f.source.id, quantity: 1 }],
      },
      supplierCookie,
    );
    const afterForeignFixture = await snapshot();
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [buyer]);
    await assert.rejects(
      c.query(
        `INSERT INTO b2b_dropship_lines(tenant_id,order_id,customer_order_id,customer_item_id,quantity,mappings)
      SELECT tenant_id,order_id,customer_order_id,$3,quantity,mappings FROM b2b_dropship_lines
      WHERE tenant_id=$1 AND order_id=$2`,
        [buyer, forwarded.id, foreign.items[0].id],
      ),
      { code: '23514' },
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [buyer]);
    // A real supplier order is not a buyer-owned dropshipping parent. This reaches
    // the actual composite FK without bypassing or disabling the source guard.
    await assert.rejects(
      c.query(
        `INSERT INTO b2b_dropship_lines(tenant_id,order_id,customer_order_id,customer_item_id,quantity,mappings)
      SELECT tenant_id,$3,customer_order_id,customer_item_id,quantity,mappings FROM b2b_dropship_lines
      WHERE tenant_id=$1 AND order_id=$2`,
        [buyer, forwarded.id, foreign.id],
      ),
      { code: '23503' },
    );
    await c.query('ROLLBACK');
    assert.deepEqual(await snapshot(), afterForeignFixture);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  // Foreign fixture creates a real supplier order; it is deliberately outside the earlier proof snapshot.
  assert.equal((await snapshot()).b2b_dropship_quotes, before.b2b_dropship_quotes);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM b2b_dropship_created_orders WHERE tenant_id=ANY($1::uuid[])',
        [[buyer, supplier]],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(providerCalls, 0);
});

test('viewer and compound read-only keys can read safe projections but cannot forward; missing read scopes never reveal source data', async () => {
  const f = await fixture();
  const readable = await key(readScopes),
    missingOrders = await key(readScopes.filter((s) => s !== 'orders:read'));
  const before = await snapshot();
  const viewerOptions = await ok(f.path + '/options', 'GET', undefined, viewerCookie);
  assert.equal(viewerOptions.can_manage, false);
  for (const path of [
    f.path + '/options',
    f.path + '/sources',
    f.path + '/sources/' + f.order.id,
  ]) {
    const viewerRead = await request(path, 'GET', undefined, viewerCookie);
    assert.equal(viewerRead.statusCode, 200);
    assert(!/portal_token|password_hash|token_hash|api_key_id/.test(viewerRead.body));
    assertNoFinancialProjection(viewerRead.json());
    const read = await publicRequest(readable.token, path);
    assert.equal(read.statusCode, 200);
    const denied = await publicRequest(missingOrders.token, path);
    assert.equal(denied.statusCode, 403);
    assert(!denied.body.includes('Customer street 9'));
  }
  const body = quoteBody(f);
  for (const rejection of [
    await request(f.path + '/quotes', 'POST', body, viewerCookie),
    await publicRequest(readable.token, f.path + '/quotes', 'POST', body),
  ]) {
    assert.equal(rejection.statusCode, 403);
    assert.match(String(rejection.headers['cache-control']), /no-store/);
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('readonly writes fail before malformed parsing, and missing module does not expose mutation capabilities', async () => {
  const f = await fixture(),
    q = await quote(f),
    readonly = await buildApp({
      readOnly: true,
      previewPort: 4168,
      integrationTransport: transport,
    });
  try {
    const auth = await enter('other@demo.local', buyer, readonly);
    const before = await snapshot();
    const options = await ok(f.path + '/options', 'GET', undefined, auth, readonly);
    assert.equal(options.read_only, true);
    assert.equal(options.can_manage, false);
    for (const path of [
      f.path + '/quotes',
      f.path + '/quotes/' + q.id + '/checkout',
      f.path + '/orders/' + randomUUID() + '/cancel',
      f.path + '/orders/' + randomUUID() + '/reconcile',
    ]) {
      const r = await request(path, 'POST', '{', auth, readonly, {
        'content-type': 'application/json',
      });
      assert.equal(r.statusCode, 423);
      assert.match(String(r.headers['cache-control']), /no-store/);
    }
    assert.deepEqual(await snapshot(), before);
  } finally {
    await readonly.close();
  }
  await checkout(f, q);
  const activeBefore = await snapshot();
  const beforeMissingFulfillment = await ok('/orders/' + f.order.id);
  await pool.query(
    'ALTER FUNCTION b2b_dropship_fulfillment(uuid) RENAME TO b2b_dropship_fulfillment_safety_hidden',
  );
  try {
    // A missing projection helper must never reopen an existing custody ledger.
    const cancelled = await request('/orders/' + f.order.id + '/status', 'PATCH', { status: 'cancelled', expected_version: String(beforeMissingFulfillment.version) });
    assert.equal(cancelled.statusCode, 409);
    assert.deepEqual(await snapshot(), activeBefore);
  } finally {
    await pool.query(
      'ALTER FUNCTION b2b_dropship_fulfillment_safety_hidden(uuid) RENAME TO b2b_dropship_fulfillment',
    );
  }
  await pool.query('ALTER TABLE b2b_dropship_quotes RENAME TO b2b_dropship_quotes_safety_hidden');
  let legacy: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    legacy = await buildApp({ integrationTransport: transport });
    const options = await ok(f.path + '/options', 'GET', undefined, buyerCookie, legacy);
    assert.equal(options.available, false);
    assert.equal(options.can_manage, false);
    const noWrite = await request(f.path + '/quotes', 'POST', quoteBody(f), buyerCookie, legacy);
    assert.equal(noWrite.statusCode, 503);
    assert.match(String(noWrite.headers['cache-control']), /no-store/);
    assert.equal(
      (await request(f.base + '/catalog', 'GET', undefined, buyerCookie, legacy)).statusCode,
      200,
    );
  } finally {
    try {
      await legacy?.close();
    } finally {
      await pool.query(
        'ALTER TABLE b2b_dropship_quotes_safety_hidden RENAME TO b2b_dropship_quotes',
      );
    }
  }
  assert.deepEqual(await snapshot(), activeBefore);
  assert.equal(providerCalls, 0);
});

test('whole-parcel marketplace ACK cannot include forwarded supplier goods and becomes eligible only after genuine cancellation restores custody', async () => {
  const f = await fixture();
  const ordinary = await sale(f.local.id, 1);
  const q = await quote(f);
  const forwarded = await checkout(f, q);
  const assertGuard = (orderId: string) =>
    tenantTx(buyer, async (c) => {
      const context = (
        await c.query(
          "SELECT current_user role,current_setting('app.tenant_id') tenant,b2b_dropship_installed() installed",
        )
      ).rows[0];
      assert.deepEqual(context, { role: 'dyna_app', tenant: buyer, installed: true });
      await assertB2bWholeParcelAckInTx(c, orderId);
    });

  const activeBefore = await snapshot();
  await assert.rejects(assertGuard(f.order.id), { status: 409 });
  await assertGuard(ordinary.id);
  assert.deepEqual(await snapshot(), activeBefore);
  assert.deepEqual(
    (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        buyer,
        f.local.id,
      ])
    ).rows[0],
    { on_hand: 20, reserved: 2 },
  );

  const cancelled = await ok(f.path + '/orders/' + forwarded.id + '/cancel', 'POST', {
    client_key: randomUUID(),
    version: forwarded.version,
    reason: 'Restore actual local custody before any whole-parcel acknowledgement',
    confirmed: true,
  });
  assert.equal(cancelled.order.state, 'cancelled');
  assert.deepEqual(
    (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        buyer,
        f.local.id,
      ])
    ).rows[0],
    { on_hand: 20, reserved: 4 },
  );
  assert.deepEqual(
    (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        supplier,
        f.source.id,
      ])
    ).rows[0],
    { on_hand: 30, reserved: 0 },
  );
  const restoredBefore = await snapshot();
  await assertGuard(f.order.id);
  await assertGuard(ordinary.id);
  assert.deepEqual(await snapshot(), restoredBefore);
  assert.equal(providerCalls, 0);
});
