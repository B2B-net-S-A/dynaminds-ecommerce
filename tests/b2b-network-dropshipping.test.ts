import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { createOrder, orderSchema } from '../server/domain';
import { seed } from './fixtures';
import { processB2bCatalog } from '../server/b2b-network';
import { dispatchAutomation } from '../server/automations';
import { encrypt } from '../server/security';
import { processShipping } from '../server/shipping';
import { assertB2bWholeParcelAckInTx } from '../server/b2b-dropship-ack-guard';

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
async function fixture(options: { on?: boolean; bundle?: boolean } = {}) {
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
    email: randomUUID() + '@example.test',
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
  if (options.on) {
    await activate(buyer, buyerCookie);
    await activate(supplier, supplierCookie);
  }
  const bundle = options.bundle
    ? await ok('/products', 'POST', {
        name: 'Frozen kit',
        sku: 'DS-KIT-' + randomUUID(),
        kind: 'bundle',
        price: 5000,
        quantity: 0,
        warehouse_id: buyerWarehouse,
        components: [{ product_id: local.id, quantity: 2 }],
      })
    : null;
  const order = await sale(bundle?.id ?? local.id);
  return {
    bundle,
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
    shipping_cost: 900,
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
    payment_mode: 'prepaid',
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
  const r = await request(f.path + '/quotes', 'POST', body);
  assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body.slice(0, 500)}`);
  return r.json().quote as Row;
}
const consent = (q: Row, client_key = randomUUID()) => ({
  client_key,
  scope_hash: q.scope_hash,
  confirmed: true,
  confirmed_receiver: true,
});
async function activate(tenant: string, auth: string) {
  const jobs = (
    await pool.query("SELECT * FROM jobs WHERE tenant_id=$1 AND state='pending' ORDER BY id", [
      tenant,
    ])
  ).rows;
  for (const job of jobs) {
    assert.equal(job.kind, 'automation');
    assert.deepEqual(job.payload.rules, []);
    const claimed = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
        [job.id, randomUUID()],
      )
    ).rows[0];
    await dispatchAutomation(claimed);
  }
  const bins = (
    await pool.query(
      'SELECT b.warehouse_id,b.product_id,b.location,b.quantity,s.version::text stock_version FROM stock_locations b JOIN stock s USING(tenant_id,warehouse_id,product_id) WHERE b.tenant_id=$1 AND b.quantity>0 ORDER BY b.product_id,b.location',
      [tenant],
    )
  ).rows;
  const { preview } = await ok(
    '/wms-lots/opening-previews',
    'POST',
    {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Own genuine initial cost layers',
      lines: bins.map((b) => ({ ...b, lot_code: 'OWN-' + b.location, unit_cost_minor: '1379' })),
    },
    auth,
  );
  assert.equal(preview.ready, true, JSON.stringify(preview));
  await ok(
    '/wms-lots/opening-previews/' + preview.id + '/activate',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: preview.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    auth,
  );
}
async function stock(product: string) {
  return (
    await pool.query('SELECT on_hand,reserved,available FROM stock WHERE product_id=$1', [product])
  ).rows[0];
}
async function rows(table: string, tenant = buyer) {
  return (
    await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
      tenant,
    ])
  ).rows.map((r) => r.row);
}
async function protectedRows() {
  const out: Row = {};
  for (const tenant of [buyer, supplier]) {
    out[tenant] = {};
    for (const table of [
      'orders',
      'order_items',
      'order_pick_items',
      'reservations',
      'reservation_locations',
      'stock',
      'stock_locations',
      'stock_movements',
      'payment_entries',
      'wms_layer_positions',
      'wms_reservation_layers',
      'wms_layer_movements',
      'wms_issue_fragments',
      'wms_return_fragments',
      'b2b_dropship_quotes',
      'b2b_dropship_orders',
      'b2b_dropship_lines',
      'b2b_dropship_actions',
      'b2b_dropship_supplier_orders',
      'b2b_dropship_custody_transfers',
      'audit_events',
      'jobs',
    ])
      out[tenant][table] = await rows(table, tenant);
  }
  return out;
}
async function checkout(f: Row, q: Row, body = consent(q)) {
  const r = await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', body);
  assert.equal(r.statusCode, 201, `${r.statusCode}:${r.body}`);
  return r.json().order as Row;
}
async function receipt(id: string, auth = buyerCookie) {
  const o = await ok('/orders/' + id, 'GET', undefined, auth);
  return ok(
    '/orders/' + id + '/payments',
    'POST',
    {
      client_key: randomUUID(),
      version: Number(o.version),
      kind: 'receipt',
      amount: o.total,
      currency: o.currency,
      reference: 'Own real local receipt',
      confirmed: true,
    },
    auth,
  );
}
async function packed(id: string, sku: string, quantity: number, auth: string, location?: string) {
  await receipt(id, auth);
  await ok('/orders/' + id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, auth), '/orders/' + id + '/status', { status: 'picking' }), auth);
  for (let n = 0; n < quantity; n++)
    await ok(
      '/orders/' + id + '/scan',
      'POST',
      { code: sku, ...(location ? { location } : {}) },
      auth,
    );
  await ok('/orders/' + id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, auth), '/orders/' + id + '/status', { status: 'packed' }), auth);
}
async function ship(id: string, sku: string, quantity: number, auth: string, location?: string) {
  await packed(id, sku, quantity, auth, location);
  return ok('/orders/' + id + '/ship-demo', 'POST', {}, auth);
}

test('frozen retail lines, consumer receiver and wholesale billing remain separate; partial checkout transfers only reserved custody with exact replay', async () => {
  const f = await fixture();
  const retailBefore = {
    orders: await rows('orders'),
    items: await rows('order_items'),
    payments: await rows('payment_entries'),
  };
  const body = quoteBody(f),
    q = await quote(f, body);
  assert.equal(q.items[0].quantity, 2);
  assert.equal(q.items[0].original_quantity, 3);
  assert.equal(q.items[0].line_total_minor, '7500');
  assert.equal(q.wholesale.total_minor, '1400');
  assert.notDeepEqual(q.receiver.address, q.wholesale.bill_to.address);
  assert.equal(q.wholesale.payment_mode, 'prepaid');
  assert.equal(q.items[0].mappings[0].source_product_id, f.source.id);
  assert.deepEqual(await stock(f.local.id), { on_hand: 20, reserved: 3, available: 17 });
  assert.equal((await stock(f.source.id)).reserved, 0);
  const consentBody = consent(q),
    d = await checkout(f, q, consentBody);
  assert.deepEqual(await stock(f.local.id), { on_hand: 20, reserved: 1, available: 19 });
  assert.deepEqual(await stock(f.source.id), { on_hand: 30, reserved: 2, available: 28 });
  assert.deepEqual(
    {
      orders: await rows('orders'),
      items: await rows('order_items'),
      payments: await rows('payment_entries'),
    },
    retailBefore,
  );
  const supplierOrder = (await rows('orders', supplier)).find((o) => o.id === d.supplier_order_id)!;
  assert.deepEqual(supplierOrder.address, q.receiver.address);
  assert.equal(supplierOrder.customer_name, q.receiver.customer_name);
  assert.equal(supplierOrder.status, 'new');
  assert.equal((await rows('payment_entries', supplier)).length, 0);
  const snapshot = await protectedRows();
  assert.equal((await ok(f.path + '/quotes', 'POST', body)).reused, true);
  assert.equal(
    (await ok(f.path + '/quotes/' + q.id + '/checkout', 'POST', consentBody)).reused,
    true,
  );
  assert.deepEqual(await protectedRows(), snapshot);
  assert.equal(
    (
      await request('/b2b/network/orders/' + d.id + '/receipts', 'POST', {
        client_key: randomUUID(),
        version: 1,
        confirmed: true,
        lines: [{ product_id: f.local.id, quantity: 1, location: 'DS-01' }],
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM b2b_dropship_created_orders')).rows[0].n,
    0,
  );
  assert.equal(
    (await ok('/orders/' + f.order.id)).dropshipping.items[0].local_required_quantity,
    1,
  );
  assert.equal(providerCalls, 0);
});

test('supplier dispatch then genuine local remainder produces local parcel quantity one and explicit composite reconcile without phantom payments or PZ', async () => {
  const f = await fixture(),
    q = await quote(f),
    d = await checkout(f, q);
  await packed(f.order.id, f.local.sku, 1, buyerCookie, 'DS-01');
  assert.equal((await request('/orders/' + f.order.id + '/ship-demo', 'POST', {})).statusCode, 409);
  assert.equal((await stock(f.local.id)).on_hand, 20);
  await receipt(d.supplier_order_id, supplierCookie);
  const document = await ok(
    '/orders/' + d.supplier_order_id + '/documents',
    'POST',
    { kind: 'invoice' },
    supplierCookie,
  );
  assert.equal(document.data.customer, q.wholesale.bill_to.name);
  assert.equal(document.data.email, q.wholesale.bill_to.email);
  assert.deepEqual(document.data.address, q.wholesale.bill_to.address);
  // Exercise the real invoice planner without a provider call: wrong consumer input is replaced with frozen purchasing company.
  const ch = randomUUID();
  await tenantTx(supplier, (c) =>
    c.query(
      'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        ch,
        supplier,
        'fakturownia',
        'Own invoice preview',
        'sandbox',
        encrypt({ api_token: 'never-contacted-fixture' }),
        JSON.stringify({ account_url: 'https://own-fixture.fakturownia.pl', simulation: false }),
      ],
    ),
  );
  const actual = await ok('/orders/' + d.supplier_order_id, 'GET', undefined, supplierCookie);
  const invoice = await ok(
    '/orders/' + actual.id + '/invoicing/preview',
    'POST',
    {
      channel_id: ch,
      kind: 'invoice',
      seller: {
        name: 'Own supplier',
        tax_no: '5252445767',
        street: 'Supplier 1',
        city: 'Warszawa',
        postal_code: '00-001',
      },
      buyer: {
        name: q.receiver.customer_name,
        email: q.receiver.email,
        tax_no: '',
        street: q.receiver.address.street,
        city: q.receiver.address.city,
        postal_code: q.receiver.address.postal_code,
      },
      issue_date: '2026-10-06',
      sell_date: '2026-10-06',
      payment_to: '2026-10-07',
      item_vat: actual.items.map((i: Row) => ({ item_id: i.id, vat: i.vat })),
      shipping_vat: 23,
    },
    supplierCookie,
  );
  const planInput = (await pool.query('SELECT input FROM invoice_plans WHERE id=$1', [invoice.id]))
    .rows[0].input;
  assert.equal(planInput.buyer.name, q.wholesale.bill_to.name);
  assert.equal(planInput.buyer.email, q.wholesale.bill_to.email);
  assert.equal(invoice.payload.buyer_name, q.wholesale.bill_to.name);
  await ok(
    '/orders/' + d.supplier_order_id + '/status',
    'PATCH',
    await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, supplierCookie), '/orders/' + d.supplier_order_id + '/status', { status: 'picking' }),
    supplierCookie,
  );
  for (let n = 0; n < 2; n++)
    await ok(
      '/orders/' + d.supplier_order_id + '/scan',
      'POST',
      { code: f.source.sku },
      supplierCookie,
    );
  await ok(
    '/orders/' + d.supplier_order_id + '/status',
    'PATCH',
    await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, supplierCookie), '/orders/' + d.supplier_order_id + '/status', { status: 'packed' }),
    supplierCookie,
  );
  await ok('/orders/' + d.supplier_order_id + '/ship-demo', 'POST', {}, supplierCookie);
  assert.equal(
    (
      await request(f.path + '/orders/' + d.id + '/cancel', 'POST', {
        client_key: randomUUID(),
        version: 1,
        confirmed: true,
        reason: 'Must reject dispatch',
      })
    ).statusCode,
    409,
  );
  await ok('/orders/' + f.order.id + '/ship-demo', 'POST', {});
  assert.deepEqual(await stock(f.local.id), { on_hand: 19, reserved: 0, available: 19 });
  assert.deepEqual(await stock(f.source.id), { on_hand: 28, reserved: 0, available: 28 });
  const manifest = (
    await pool.query(
      'SELECT items FROM shopify_dispatch_evidence WHERE tenant_id=$1 AND order_id=$2',
      [buyer, f.order.id],
    )
  ).rows[0].items;
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].quantity, 1);
  assert.equal(manifest[0].original_quantity, 3);
  assert.equal(manifest[0].external_quantity, 2);
  const firstWitness = (
    await pool.query(
      'SELECT to_jsonb(e) row FROM shopify_dispatch_evidence e WHERE tenant_id=$1 AND order_id=$2',
      [buyer, f.order.id],
    )
  ).rows[0].row;
  await pool.query('UPDATE shipments SET dispatched_at=NULL WHERE tenant_id=$1 AND order_id=$2', [
    buyer,
    f.order.id,
  ]);
  await pool.query(
    'UPDATE shipments s SET dispatched_at=e.dispatched_at FROM shopify_dispatch_evidence e WHERE (e.tenant_id,e.shipment_id)=(s.tenant_id,s.id) AND s.tenant_id=$1 AND s.order_id=$2',
    [buyer, f.order.id],
  );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT to_jsonb(e) row FROM shopify_dispatch_evidence e WHERE tenant_id=$1 AND order_id=$2',
        [buyer, f.order.id],
      )
    ).rows[0].row,
    firstWitness,
  );

  const projected = await ok('/orders/' + f.order.id);
  assert.equal(projected.items[0].quantity, 3);
  assert.equal(projected.items[0].scanned, 1);
  assert.equal(projected.dropshipping.external_dispatched_quantity, 2);
  const reconcileBody = { client_key: randomUUID(), version: 1, confirmed: true };
  assert.equal(
    (await ok(f.path + '/orders/' + d.id + '/reconcile', 'POST', reconcileBody)).order.reconciled,
    true,
  );
  const checkpoint = await protectedRows();
  assert.equal(
    (await ok(f.path + '/orders/' + d.id + '/reconcile', 'POST', reconcileBody)).reused,
    true,
  );
  assert.deepEqual(await protectedRows(), checkpoint);
  assert.equal((await rows('warehouse_documents')).length, 1);
  assert.equal(providerCalls, 0);
});

test('full external fulfillment requires real retail receipt and explicit reconciliation, never an empty local parcel or fictitious scan', async () => {
  const f = await fixture(),
    q = await quote(f, quoteBody(f, 3)),
    d = await checkout(f, q);
  assert.equal((await rows('order_pick_items')).length, 0);
  assert.equal((await rows('reservations')).length, 0);
  await ship(d.supplier_order_id, f.source.sku, 3, supplierCookie);
  const body = { client_key: randomUUID(), version: 1, confirmed: true };
  assert.equal((await ok(f.path + '/orders/' + d.id)).order.can_reconcile, false);
  assert.equal(
    (await request(f.path + '/orders/' + d.id + '/reconcile', 'POST', body)).statusCode,
    409,
  );
  await receipt(f.order.id);
  assert.equal((await ok(f.path + '/orders/' + d.id)).order.can_reconcile, true);
  const reconciled = await ok(f.path + '/orders/' + d.id + '/reconcile', 'POST', body);
  assert.equal(reconciled.order.reconciled, true);
  const o = await ok('/orders/' + f.order.id);
  assert.equal(o.status, 'shipped');
  assert.equal(o.items[0].scanned, 0);
  assert.equal(o.shipments.length, 0);
  assert.equal((await rows('stock_movements')).filter((m) => m.kind === 'shipment').length, 0);
  assert.deepEqual(await stock(f.local.id), { on_hand: 20, reserved: 0, available: 20 });
  assert.equal(providerCalls, 0);
});

test('cancellation by a current different admin restores original buyer bins; insufficient original availability conflicts atomically', async () => {
  const f = await fixture(),
    q = await quote(f),
    d = await checkout(f, q);
  const second = await enter('admin@demo.local', buyer);
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    buyer,
    buyerUser,
  ]);
  const body = {
    client_key: randomUUID(),
    version: 1,
    reason: 'Own cancellation by current admin',
    confirmed: true,
  };
  const result = await ok(f.path + '/orders/' + d.id + '/cancel', 'POST', body, second);
  assert.equal(result.order.state, 'cancelled');
  assert.equal(result.order.version, 2);
  assert.deepEqual(await stock(f.local.id), { on_hand: 20, reserved: 3, available: 17 });
  assert.equal((await stock(f.source.id)).reserved, 0);
  assert.equal((await rows('reservation_locations'))[0].location, 'DS-01');
  const checkpoint = await protectedRows();
  assert.equal(
    (await ok(f.path + '/orders/' + d.id + '/cancel', 'POST', body, second)).reused,
    true,
  );
  assert.deepEqual(await protectedRows(), checkpoint);
  // Independent stock still belongs to the buyer. Restore must reserve the original bin, never refIFO elsewhere.
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    buyer,
    buyerUser,
  ]);
  const g = await fixture(),
    gq = await quote(g),
    gd = await checkout(g, gq);
  await sale(g.local.id, 19);
  const before = await protectedRows();
  assert.equal(
    (
      await request(g.path + '/orders/' + gd.id + '/cancel', 'POST', {
        client_key: randomUUID(),
        version: 1,
        reason: 'No capacity in original bin',
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await protectedRows(), before);
  assert.equal(providerCalls, 0);
});

test('WMS ON frozen bundle releases and restores exact original cost layers without journal/on_hand changes or changing the recipe', async () => {
  const f = await fixture({ on: true, bundle: true });
  const originalLayers = await rows('wms_reservation_layers'),
    originalPositions = await rows('wms_layer_positions'),
    journals = await rows('wms_layer_movements');
  assert.equal(originalLayers[0].quantity, 6);
  const q = await quote(f);
  assert.equal(q.wholesale.items[0].quantity, 4);
  const d = await checkout(f, q);
  assert.equal((await rows('wms_reservation_layers'))[0].quantity, 2);
  assert.equal((await stock(f.local.id)).reserved, 2);
  assert.equal((await stock(f.source.id)).reserved, 4);
  assert.deepEqual(await rows('wms_layer_movements'), journals);
  await ok(f.path + '/orders/' + d.id + '/cancel', 'POST', {
    client_key: randomUUID(),
    version: 1,
    reason: 'Restore actual original FIFO fragments',
    confirmed: true,
  });
  assert.deepEqual(await rows('wms_reservation_layers'), originalLayers);
  const positions = await rows('wms_layer_positions');
  assert.equal(positions[0].layer_id, originalPositions[0].layer_id);
  assert.equal(positions[0].quantity, originalPositions[0].quantity);
  assert.equal(positions[0].reserved, 6);
  assert.equal(BigInt(positions[0].version), BigInt(originalPositions[0].version) + 2n);
  assert.deepEqual(await rows('wms_layer_movements'), journals);
  assert.equal((await stock(f.local.id)).on_hand, 20);
  assert.deepEqual(
    (await ok('/orders/' + f.order.id)).items[0].components,
    f.order.items[0].components,
  );
  assert.equal(providerCalls, 0);
});

test('strict bounded definitions and downstream receiver/merge admission reject incorrect or ambiguous scope without extra writes', async () => {
  const f = await fixture(),
    body = quoteBody(f),
    before = await protectedRows();
  for (const invalid of [
    { ...body, items: Array.from({ length: 101 }, () => body.items[0]) },
    { ...body, items: [{ ...body.items[0], quantity: 100001 }] },
    { ...body, items: [{ ...body.items[0], mappings: [] }] },
    { ...body, receiver: {} },
    { ...body, items: [body.items[0], body.items[0]] },
  ])
    assert.equal((await request(f.path + '/quotes', 'POST', invalid)).statusCode, 422);
  assert.deepEqual(await protectedRows(), before);
  const q = await quote(f),
    d = await checkout(f, q);
  const actual = await ok('/orders/' + d.supplier_order_id, 'GET', undefined, supplierCookie);
  await assert.rejects(
    tenantTx(supplier, (c) =>
      c.query('UPDATE orders SET address=$2::jsonb WHERE id=$1', [
        actual.id,
        JSON.stringify({ ...actual.address, street: 'Forged recipient' }),
      ]),
    ),
    (e: any) => e.code === '23514',
  );
  await assert.rejects(
    tenantTx(buyer, (c) =>
      c.query('UPDATE orders SET address=$2::jsonb WHERE id=$1', [
        f.order.id,
        JSON.stringify({ ...f.order.address, street: 'Changed local consumer' }),
      ]),
    ),
    (e: any) => e.code === '23514',
  );
  const another = await sale(f.local.id, 1);
  const merge = await request('/order-merges/previews', 'POST', {
    client_key: randomUUID(),
    main_order_id: f.order.id,
    order_ids_to_merge: [another.id],
    merge_mode: 'technical_merge',
    sum_delivery_costs: true,
  });
  assert.equal(merge.statusCode, 409);
  assert.equal(
    (await request('/orders/' + f.order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => request(orderPath, 'GET', undefined), '/orders/' + f.order.id + '/status', { status: 'cancelled' })))
      .statusCode,
    409,
  );
  assert.equal(providerCalls, 0);
});

test('supplier courier payload is fenced; actual immutable receiver proof is required for composite dispatch, including missing and locker proof', async () => {
  const f = await fixture(),
    q = await quote(f, quoteBody(f, 3)),
    d = await checkout(f, q);
  await receipt(f.order.id);
  await packed(d.supplier_order_id, f.source.sku, 3, supplierCookie);
  const channel = await ok('/shipping/example', 'POST', {}, supplierCookie);
  const input = {
    channel_id: channel.id,
    service: 'inpost_courier_standard',
    receiver: {
      first_name: 'Own retail',
      last_name: 'customer',
      email: q.receiver.email,
      phone: q.receiver.address.phone,
      address: {
        street: 'Customer street',
        building_number: '9',
        city: q.receiver.address.city,
        post_code: q.receiver.address.postal_code,
        country_code: 'PL',
      },
    },
    dimensions: { length: 200, width: 150, height: 100 },
    weight: 1,
  };
  const checkpoint = await protectedRows();
  for (const invalid of [
    { ...input, receiver: { ...input.receiver, email: 'different-recipient@example.test' } },
    { ...input, service: 'inpost_locker_standard', target_point: 'WAW01M' },
  ])
    assert.equal(
      (
        await request(
          '/orders/' + d.supplier_order_id + '/shipping/preview',
          'POST',
          invalid,
          supplierCookie,
        )
      ).statusCode,
      409,
    );
  assert.deepEqual(await protectedRows(), checkpoint);
  const plan = await ok(
    '/orders/' + d.supplier_order_id + '/shipping/preview',
    'POST',
    input,
    supplierCookie,
  );
  async function runShipping(jobId: string) {
    const job = await tenantTx(
      supplier,
      async (c) =>
        (
          await c.query(
            "UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *",
            [jobId, randomUUID()],
          )
        ).rows[0],
    );
    await processShipping(job, { transport });
    assert.equal(
      (await pool.query('SELECT state FROM jobs WHERE id=$1', [jobId])).rows[0].state,
      'done',
    );
  }
  await runShipping(
    (await ok('/shipping-plans/' + plan.id + '/queue', 'POST', {}, supplierCookie)).job_id,
  );
  const quoted = (await pool.query('SELECT offers FROM shipping_plans WHERE id=$1', [plan.id]))
    .rows[0];
  await runShipping(
    (
      await ok(
        '/shipping-plans/' + plan.id + '/buy',
        'POST',
        {
          offer_id: quoted.offers[0].id,
          confirm_cost: true,
          ack_unknown_rate: true,
        },
        supplierCookie,
      )
    ).job_id,
  );
  const prepared = (await pool.query('SELECT * FROM shipping_plans WHERE id=$1', [plan.id]))
    .rows[0];
  assert.equal(prepared.state, 'ready');
  const physicalBefore = await protectedRows();
  // A rollback-only owner fixture exercises the real first-witness factory for a
  // historic/unsupported prepared payload. It creates no provider or physical effect.
  const c = await pool.connect();
  try {
    for (const mode of ['missing', 'mismatch', 'locker']) {
      await c.query('BEGIN');
      try {
        if (mode !== 'missing') {
          if (mode === 'mismatch')
            await c.query(
              "UPDATE shipping_plans SET payload=jsonb_set(payload,'{receiver,email}','\"wrong@example.test\"'::jsonb) WHERE id=$1",
              [plan.id],
            );
          else
            await c.query(
              "UPDATE shipping_plans SET input=jsonb_set(input,'{service}','\"inpost_locker_standard\"'::jsonb) WHERE id=$1",
              [plan.id],
            );
          await c.query('UPDATE shipments SET dispatched_at=now() WHERE id=$1', [
            prepared.shipment_id,
          ]);
          const witness = (
            await c.query(
              'SELECT receiver FROM shopify_dispatch_evidence WHERE tenant_id=$1 AND shipment_id=$2',
              [supplier, prepared.shipment_id],
            )
          ).rows[0];
          assert(witness);
          if (mode === 'locker') assert.equal(witness.receiver, null);
          else assert.equal(witness.receiver.email, 'wrong@example.test');
        }
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [buyer]);
        const projected = (await c.query('SELECT b2b_dropship_fulfillment($1) rows', [f.order.id]))
          .rows[0].rows;
        assert.equal(projected[0].dispatched, false);
      } finally {
        await c.query('ROLLBACK');
      }
    }
  } finally {
    c.release();
  }
  assert.deepEqual(await protectedRows(), physicalBefore);
  assert.equal((await ok(f.path + '/orders/' + d.id)).order.can_reconcile, false);
  const reconcileBody = { client_key: randomUUID(), version: 1, confirmed: true };
  assert.equal(
    (await request(f.path + '/orders/' + d.id + '/reconcile', 'POST', reconcileBody)).statusCode,
    409,
  );
  await ok('/shipping-plans/' + plan.id + '/dispatch', 'POST', {}, supplierCookie);
  const evidence = (
    await pool.query(
      'SELECT receiver FROM shopify_dispatch_evidence WHERE tenant_id=$1 AND shipment_id=$2',
      [supplier, prepared.shipment_id],
    )
  ).rows[0];
  assert.deepEqual(evidence.receiver, q.receiver);
  assert.equal((await ok('/orders/' + f.order.id)).dropshipping.external_dispatched_quantity, 3);
  await ok(f.path + '/orders/' + d.id + '/reconcile', 'POST', reconcileBody);
  assert.deepEqual(await stock(f.local.id), { on_hand: 20, reserved: 0, available: 20 });
  assert.deepEqual(await stock(f.source.id), { on_hand: 27, reserved: 0, available: 27 });
  assert.equal(providerCalls, 0);
});
