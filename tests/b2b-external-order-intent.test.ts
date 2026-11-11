import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { processB2bCatalog } from '../server/b2b-network';
import { checkoutB2bDropship } from '../server/b2b-network-dropshipping';

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
  throw Error('Own external order intent safety must never contact an external provider');
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
    logging: process.env.B2B_EXTERNAL_INTENT_ENGINE_LOG === 'true',
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
async function fixture(options: { on?: boolean; retailPrice?: number } = {}): Promise<Row> {
  const source = await ok(
    '/products',
    'POST',
    {
      sku: 'DS-SUP-' + randomUUID(),
      name: 'Own wholesale product',
      price: 1900,
      vat: 23,
      quantity: 20,
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
    sale_price: options.retailPrice ?? 2500,
    warehouse_id: buyerWarehouse,
    confirmed: true,
  });
  assert.match(imported.product_id, /^[0-9a-f-]{36}$/);
  const local = await ok('/products/' + imported.product_id);
  assert.equal(local.id, imported.product_id);
  if (options.on) {
    await enableWms(buyer, buyerCookie);
    await enableWms(supplier, supplierCookie);
  }
  return {
    source,
    list,
    account: enabled,
    link,
    item,
    local,
    base,
    path: base + '/dropshipping',
  };
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
async function quote(f: Row, body: Row = quoteBody(f), token?: string) {
  const detail = await ok(intentPath + '/orders/' + f.order.id);
  body = { ...body, fulfillment_basis: 'external_intent', intent_version: detail.intent.version };
  const r = token
    ? await publicRequest(token, f.path + '/quotes', 'POST', body)
    : await request(f.path + '/quotes', 'POST', body);
  assert.equal(r.statusCode, 201, `${r.statusCode}: ${r.body.slice(0, 500)}`);
  return r.json().quote as Row;
}
const consent = (q: Row, client_key = randomUUID()) => ({
  client_key,
  scope_hash: q.scope_hash,
  confirmed: true as const,
  confirmed_receiver: true as const,
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
async function enableWms(tenant: string, auth: string) {
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
      note: 'Own external-intent safety opening',
      lines: bins.map((b) => ({ ...b, lot_code: 'INTENT-' + b.location, unit_cost_minor: '1379' })),
    },
    auth,
  );
  assert.equal(preview.ready, true);
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

const intentPath = '/b2b/external-order-intents';
function intentBody(f: Row, quantity = 3, allocation: Row = {}) {
  const itemId = randomUUID();
  return {
    client_key: randomUUID(),
    order: {
      customer_name: 'Own external-only customer',
      email: 'external-intent@example.test',
      address: {
        street: 'External customer 127',
        city: 'Gdańsk',
        postal_code: '80-001',
        country: 'PL',
        phone: '555000127',
      },
      warehouse_id: buyerWarehouse,
      currency: 'PLN',
      payment_mode: 'cod',
      items: [{ customer_item_id: itemId, product_id: f.local.id, quantity }],
    },
    allocations: [
      {
        customer_item_id: itemId,
        local_quantity: 0,
        external_quantity: quantity,
        unassigned_quantity: 0,
        link_id: f.link.id,
        ...allocation,
      },
    ],
  };
}
async function createIntent(f: Row, body: Row = intentBody(f), token?: string) {
  const response = token
    ? await publicRequest(token, intentPath + '/orders', 'POST', body)
    : await request(intentPath + '/orders', 'POST', body);
  assert.equal(response.statusCode, 201, response.body.slice(0, 500));
  const result = response.json() as Row;
  assert(result.intent?.id && result.order?.id);
  assert.equal(result.order.items.length, body.order.items.length);
  assert.deepEqual(
    new Set(result.order.items.map((i: Row) => i.id)),
    new Set(body.order.items.map((i: Row) => i.customer_item_id)),
  );
  f.order = result.order;
  f.intent = result.intent;
  return result;
}
async function physicalSnapshot(tenant = buyer) {
  const result: Row = {};
  for (const name of [
    'stock',
    'stock_locations',
    'reservations',
    'reservation_locations',
    'order_pick_items',
    'wms_lots',
    'wms_cost_layers',
    'wms_layer_positions',
    'wms_reservation_layers',
    'wms_layer_movements',
    'wms_issue_fragments',
    'wms_return_fragments',
    'stock_movements',
    'warehouse_documents',
    'warehouse_document_lines',
    'payment_entries',
    'shipments',
  ]) {
    result[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  }
  return result;
}

async function stock(tenant: string, product: string) {
  return (
    await pool.query(
      'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND product_id=$2',
      [tenant, product],
    )
  ).rows[0];
}
async function detail(f: Row) {
  return ok(intentPath + '/orders/' + f.order.id);
}
async function action(f: Row, kind: 'cancel' | 'reopen') {
  const current = await detail(f);
  return ok(intentPath + '/orders/' + f.order.id + '/' + kind, 'POST', {
    client_key: randomUUID(),
    version: current.intent.version,
    confirmed: true,
  });
}
async function receipt(orderId: string, auth = buyerCookie) {
  const order = await ok('/orders/' + orderId, 'GET', undefined, auth);
  const unpaid = await ok('/orders/' + orderId + '/payments', 'GET', undefined, auth);
  assert.equal(unpaid.balance.amount_due, order.total);
  assert(unpaid.balance.amount_due > 0, 'This fixture must record only a genuinely unpaid amount');
  await ok(
    '/orders/' + orderId + '/payments',
    'POST',
    {
      client_key: randomUUID(),
      version: Number(order.version),
      kind: 'receipt',
      amount: order.total,
      currency: order.currency,
      method: 'bank_transfer',
      reference: 'Own explicit engine127 receipt',
      confirmed: true,
    },
    auth,
  );
  return ok('/orders/' + orderId, 'GET', undefined, auth);
}
async function dispatch(orderId: string, tenant: string, auth: string) {
  const paid = await receipt(orderId, auth);
  assert.equal(paid.status, 'paid', 'The genuine payment API advances the paid state');
  await ok('/orders/' + orderId + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, auth), '/orders/' + orderId + '/status', { status: 'picking' }), auth);
  const picks = (
    await pool.query(
      'SELECT * FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
      [tenant, orderId],
    )
  ).rows;
  assert(picks.length > 0, 'A genuine dispatch requires real physical picks');
  for (const pick of picks) {
    const layers = (
      await pool.query(
        "SELECT layer_id,location,quantity,scanned FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3 AND state='active' ORDER BY layer_id,location",
        [tenant, orderId, pick.product_id],
      )
    ).rows;
    if (layers.length)
      for (const layer of layers)
        for (let n = layer.scanned; n < layer.quantity; n++)
          await ok(
            '/orders/' + orderId + '/scan',
            'POST',
            {
              code: pick.sku,
              location: layer.location,
              layer_id: layer.layer_id,
              client_key: randomUUID(),
            },
            auth,
          );
    else
      for (let n = pick.scanned; n < pick.quantity; n++)
        await ok(
          '/orders/' + orderId + '/scan',
          'POST',
          { code: pick.sku, client_key: randomUUID() },
          auth,
        );
  }
  await ok('/orders/' + orderId + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined, auth), '/orders/' + orderId + '/status', { status: 'packed' }), auth);
  await ok('/orders/' + orderId + '/ship-demo', 'POST', {}, auth);
  assert.equal((await ok('/orders/' + orderId, 'GET', undefined, auth)).status, 'shipped');
}
async function reconcile(f: Row, forwarded: Row) {
  const current = (await ok(f.path + '/orders/' + forwarded.id)).order;
  return ok(f.path + '/orders/' + forwarded.id + '/reconcile', 'POST', {
    client_key: randomUUID(),
    version: current.version,
    confirmed: true,
  });
}
async function addLocalStock(f: Row, quantity: number) {
  const document = await ok('/warehouse-documents', 'POST', {
    kind: 'receipt',
    warehouse_id: buyerWarehouse,
    reference: 'Own genuine stock for intent allocation',
    note: '',
    lines: [{ product_id: f.local.id, quantity, location: 'INTENT-LOCAL' }],
  });
  return ok('/warehouse-documents/' + document.id + '/post', 'POST', { version: document.version });
}
async function allocate(f: Row, allocations: Row[], version?: number) {
  const current = await detail(f);
  return ok(intentPath + '/orders/' + f.order.id + '/allocate', 'POST', {
    client_key: randomUUID(),
    version: version ?? current.intent.version,
    allocations,
    confirmed: true,
  });
}
function preserveWithoutPayment(rows: Row) {
  const { payment_entries, ...physical } = rows;
  return physical;
}

for (const on of [false, true]) {
  test(`external-only customer survives concurrent exact checkout, supplier cancel, customer close/reopen and genuine composite fulfillment (${on ? 'WMS ON' : 'WMS OFF'})`, async () => {
    const f = await fixture({ on, retailPrice: 25000 }),
      beforeBuyer = await physicalSnapshot(),
      initial = intentBody(f),
      body = { ...initial, order: { ...initial.order, shipping_cost: 900 } };
    const created = await createIntent(f, body);
    assert.equal(created.order.total, 75900);
    assert.deepEqual(await physicalSnapshot(), beforeBuyer);
    const beforeCreateReplay = await snapshot();
    const createReplay = await request(intentPath + '/orders', 'POST', body);
    assert.equal(createReplay.statusCode, 200, createReplay.body);
    assert.equal(createReplay.json().reused, true);
    assert.deepEqual(await snapshot(), beforeCreateReplay);
    const q = await quote(f, quoteBody(f, 3)),
      consentBody = consent(q);
    assert.deepEqual(q.receiver.address, created.order.address);
    const attempts = await Promise.all([
      request(f.path + '/quotes/' + q.id + '/checkout', 'POST', consentBody),
      request(f.path + '/quotes/' + q.id + '/checkout', 'POST', consentBody),
    ]);
    assert.deepEqual(
      attempts.map((a) => a.statusCode).sort(),
      [200, 201],
      attempts.map((a) => a.body).join('\n'),
    );
    const forwarded = attempts.find((a) => a.statusCode === 201)!.json().order;
    assert(attempts.every((a) => a.json().order.id === forwarded.id));
    assert.deepEqual(await stock(supplier, f.source.id), {
      on_hand: 20,
      reserved: 3,
      available: 17,
    });
    assert.deepEqual(await physicalSnapshot(), beforeBuyer);
    const supplierOriginal = await ok(
      '/orders/' + forwarded.supplier_order_id,
      'GET',
      undefined,
      supplierCookie,
    );
    assert.equal(supplierOriginal.total, 2100);
    assert.deepEqual(supplierOriginal.address, created.order.address);
    const beforeCheckoutReplay = await snapshot();
    const replay = await request(
      f.path + '/quotes/' + q.id + '/checkout',
      'POST',
      Object.fromEntries(Object.entries(consentBody).reverse()),
    );
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().reused, true);
    assert.deepEqual(await snapshot(), beforeCheckoutReplay);
    await ok(f.path + '/orders/' + forwarded.id + '/cancel', 'POST', {
      client_key: randomUUID(),
      version: forwarded.version,
      reason: 'Own external-only cancel at buyer0',
      confirmed: true,
    });
    assert.deepEqual(await stock(supplier, f.source.id), {
      on_hand: 20,
      reserved: 0,
      available: 20,
    });
    const uncommitted = await detail(f);
    assert.equal(uncommitted.intent.items[0].external_quantity, 3);
    assert.equal(uncommitted.intent.items[0].committed_quantity, 0);
    assert.deepEqual(await physicalSnapshot(), beforeBuyer);
    const closed = await action(f, 'cancel');
    assert.equal(closed.intent.state, 'closed');
    assert.equal(closed.order.status, 'cancelled');
    const reopened = await action(f, 'reopen');
    assert.equal(reopened.intent.state, 'open');
    assert.equal(reopened.order.total, 75900);
    assert.deepEqual(await physicalSnapshot(), beforeBuyer);
    const next = await quote(f, quoteBody(f, 3)),
      nextForwarded = await checkout(f, next);
    const frozenQuote = (
      await pool.query('SELECT snapshot FROM b2b_dropship_quotes WHERE tenant_id=$1 AND id=$2', [
        buyer,
        next.id,
      ])
    ).rows[0].snapshot;
    assert.equal(frozenQuote.retail.payment_balance.received, '0');
    assert.equal(frozenQuote.retail.payment_balance.amount_due, '75900');
    assert.notEqual(nextForwarded.supplier_order_id, forwarded.supplier_order_id);
    await dispatch(nextForwarded.supplier_order_id, supplier, supplierCookie);
    await receipt(f.order.id);
    const currentForward = (await ok(f.path + '/orders/' + nextForwarded.id)).order;
    assert.equal(currentForward.retail.payment_balance.received, '75900');
    assert.equal(currentForward.retail.payment_balance.amount_due, '0');
    const stillFrozen = (await ok(f.path + '/quotes/' + next.id)).quote;
    assert.equal(stillFrozen.retail.payment_balance.received, '0');
    assert.equal(stillFrozen.retail.payment_balance.amount_due, '75900');
    const frozenHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    assert.equal(
      frozenHash(
        (
          await pool.query(
            'SELECT snapshot FROM b2b_dropship_quotes WHERE tenant_id=$1 AND id=$2',
            [buyer, next.id],
          )
        ).rows[0].snapshot,
      ),
      frozenHash(frozenQuote),
    );
    const viewerForward = (
      await ok(f.path + '/orders/' + nextForwarded.id, 'GET', undefined, viewerCookie)
    ).order;
    assert(!Object.hasOwn(viewerForward.retail, 'payment_balance'));
    const beforeReconcile = await physicalSnapshot(),
      retailLedger = (
        await pool.query('SELECT * FROM payment_entries WHERE tenant_id=$1 ORDER BY id', [buyer])
      ).rows;
    await reconcile(f, nextForwarded);
    const customer = await ok('/orders/' + f.order.id);
    assert.equal(customer.status, 'shipped');
    assert.equal(customer.total, 75900);
    assert.deepEqual(customer.address, created.order.address);
    assert(customer.items.every((i: Row) => i.scanned === 0));
    assert.deepEqual(await stock(supplier, f.source.id), {
      on_hand: 17,
      reserved: 0,
      available: 17,
    });
    assert.deepEqual(await physicalSnapshot(), beforeReconcile);
    assert.deepEqual(
      preserveWithoutPayment(await physicalSnapshot()),
      preserveWithoutPayment(beforeBuyer),
    );
    assert.deepEqual(
      (await pool.query('SELECT * FROM payment_entries WHERE tenant_id=$1 ORDER BY id', [buyer]))
        .rows,
      retailLedger,
    );
    assert.equal((await detail(f)).intent.items[0].dispatched_quantity, 3);
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM shipments WHERE tenant_id=$1', [buyer]))
        .rows[0].n,
      0,
    );
    assert.equal(providerCalls, 0);
  });
}

test('mixed local1/external2 issues only the real buyer parcel and reconciles exact commercial capacity without duplicate payments or stock', async () => {
  const f = await fixture();
  await addLocalStock(f, 5);
  const created = await createIntent(
    f,
    intentBody(f, 3, { local_quantity: 1, external_quantity: 2 }),
  );
  assert.deepEqual(await stock(buyer, f.local.id), { on_hand: 5, reserved: 1, available: 4 });
  const q = await quote(f, quoteBody(f, 2)),
    forwarded = await checkout(f, q);
  assert.deepEqual(await stock(buyer, f.local.id), { on_hand: 5, reserved: 1, available: 4 });
  await dispatch(forwarded.supplier_order_id, supplier, supplierCookie);
  await dispatch(f.order.id, buyer, buyerCookie);
  const witness = (
    await pool.query(
      'SELECT items FROM shopify_dispatch_evidence WHERE tenant_id=$1 AND order_id=$2',
      [buyer, f.order.id],
    )
  ).rows;
  assert.equal(witness.length, 1);
  assert.equal(witness[0].items.length, 1);
  assert.equal(witness[0].items[0].id, created.order.items[0].id);
  assert.equal(witness[0].items[0].quantity, 1);
  assert.equal(witness[0].items[0].original_quantity, 3);
  const before = await physicalSnapshot(),
    ledger = (
      await pool.query('SELECT * FROM payment_entries WHERE tenant_id=$1 ORDER BY id', [buyer])
    ).rows;
  await reconcile(f, forwarded);
  assert.deepEqual(await physicalSnapshot(), before);
  assert.deepEqual(
    (await pool.query('SELECT * FROM payment_entries WHERE tenant_id=$1 ORDER BY id', [buyer]))
      .rows,
    ledger,
  );
  const customer = await ok('/orders/' + f.order.id);
  assert.equal(customer.total, 7500);
  assert.equal(customer.items[0].quantity, 3);
  assert.equal(customer.items[0].scanned, 1);
  assert.deepEqual(await stock(buyer, f.local.id), { on_hand: 4, reserved: 0, available: 4 });
  assert.deepEqual(await stock(supplier, f.source.id), { on_hand: 18, reserved: 0, available: 18 });
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM shipments WHERE tenant_id=$1', [buyer])).rows[0]
      .n,
    1,
  );
  assert.equal(providerCalls, 0);
});

test('allocation requires real stock and current CAS, and same-SKU scans preserve the correct commercial UUID and per-line floor', async () => {
  const f = await fixture(),
    ids = [randomUUID(), randomUUID()].sort(),
    body: Row = intentBody(f);
  body.order.items = [
    { customer_item_id: ids[0], product_id: f.local.id, quantity: 1 },
    { customer_item_id: ids[1], product_id: f.local.id, quantity: 2 },
  ];
  body.allocations = body.order.items.map((i: Row) => ({
    customer_item_id: i.customer_item_id,
    local_quantity: 0,
    external_quantity: i.quantity,
    unassigned_quantity: 0,
    link_id: f.link.id,
  }));
  const created = await createIntent(f, body);
  const assignments = body.allocations.map((a: Row) =>
    a.customer_item_id === ids[1] ? { ...a, local_quantity: 1, external_quantity: 1 } : a,
  );
  const beforeShortage = await snapshot();
  const missing = await request(intentPath + '/orders/' + f.order.id + '/allocate', 'POST', {
    client_key: randomUUID(),
    version: created.intent.version,
    allocations: assignments,
    confirmed: true,
  });
  assert.equal(missing.statusCode, 409, missing.body);
  assert.deepEqual(await snapshot(), beforeShortage);
  await addLocalStock(f, 5);
  const allocated = await allocate(f, assignments);
  assert.deepEqual(await stock(buyer, f.local.id), { on_hand: 5, reserved: 1, available: 4 });
  const beforeStale = await snapshot();
  const stale = await request(intentPath + '/orders/' + f.order.id + '/allocate', 'POST', {
    client_key: randomUUID(),
    version: created.intent.version,
    allocations: assignments,
    confirmed: true,
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.deepEqual(await snapshot(), beforeStale);
  await ok('/orders/' + f.order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.order.id + '/status', { status: 'picking' }));
  await ok('/orders/' + f.order.id + '/scan', 'POST', {
    code: f.local.sku,
    client_key: randomUUID(),
  });
  const scanned = await ok('/orders/' + f.order.id);
  assert.equal(
    scanned.items.find((i: Row) => i.id === ids[0]).scanned,
    0,
    'External-only lower UUID must never consume a local physical scan',
  );
  assert.equal(scanned.items.find((i: Row) => i.id === ids[1]).scanned, 1);
  const illegal = assignments.map((a: Row) =>
    a.customer_item_id === ids[0]
      ? { ...a, local_quantity: 1, external_quantity: 0, link_id: null }
      : { ...a, local_quantity: 0, external_quantity: 2 },
  );
  const beforeIdentity = await snapshot();
  const refused = await request(intentPath + '/orders/' + f.order.id + '/allocate', 'POST', {
    client_key: randomUUID(),
    version: allocated.intent.version,
    allocations: illegal,
    confirmed: true,
  });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual(await snapshot(), beforeIdentity);
  const enlarged = assignments.map((a: Row) =>
    a.customer_item_id === ids[1]
      ? { ...a, local_quantity: 2, external_quantity: 0, link_id: null }
      : a,
  );
  await allocate(f, enlarged);
  assert.deepEqual(await stock(buyer, f.local.id), { on_hand: 5, reserved: 2, available: 3 });
  await allocate(f, assignments);
  assert.deepEqual(await stock(buyer, f.local.id), { on_hand: 5, reserved: 1, available: 4 });
  assert.equal(
    (await ok('/orders/' + f.order.id)).items.find((i: Row) => i.id === ids[1]).scanned,
    1,
  );
  assert.equal(providerCalls, 0);
});

test('a complete two-component bundle keeps distinct same-SKU commercial UUIDs and exact physical mapping without reserving buyer stock', async () => {
  const f = await fixture();
  const second = await ok(
    '/products',
    'POST',
    {
      sku: 'OWN-SECOND-' + randomUUID(),
      name: 'Own second supplier component',
      price: 1300,
      vat: 23,
      quantity: 20,
      warehouse_id: supplierWarehouse,
    },
    supplierCookie,
  );
  const list = (await ok('/price-lists?limit=100', 'GET', undefined, supplierCookie)).data.find(
    (p: Row) => p.id === f.list.id,
  );
  assert(list);
  await ok(
    '/price-lists/' + list.id + '/items',
    'PUT',
    {
      version: list.version,
      items: [
        { product_id: f.source.id, price: 700 },
        { product_id: second.id, price: 600 },
      ],
    },
    supplierCookie,
  );
  const refresh = await ok(f.base + '/refresh', 'POST', {
    client_key: randomUUID(),
    confirmed: true,
  });
  for (let n = 0; n < 5; n++) {
    const run = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [refresh.id]))
      .rows[0];
    if (run.state === 'done') break;
    assert.equal(run.state, 'queued');
    const job = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
        [run.job_id, randomUUID()],
      )
    ).rows[0];
    await processB2bCatalog(job);
    await pool.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",
      [job.id, job.lease_token],
    );
  }
  assert.equal(
    (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [refresh.id])).rows[0]
      .state,
    'done',
  );
  const catalog = (await ok(f.base + '/catalog')).data,
    secondItem = catalog.find((i: Row) => i.source_product_id === second.id);
  assert(secondItem);
  const imported = await ok(f.base + '/catalog/' + secondItem.id + '/product', 'POST', {
    version: secondItem.version,
    sku: 'OWN-SECOND-LOCAL-' + randomUUID(),
    sale_price: 1600,
    warehouse_id: buyerWarehouse,
    confirmed: true,
  });
  const components = [
    { product_id: f.local.id, quantity: 2 },
    { product_id: imported.product_id, quantity: 1 },
  ];
  const bundle = await ok('/products', 'POST', {
    sku: 'OWN-INTENT-BUNDLE-' + randomUUID(),
    name: 'Own complete external kit',
    price: 9900,
    vat: 23,
    kind: 'bundle',
    quantity: 0,
    warehouse_id: buyerWarehouse,
    components,
  });
  const body: Row = intentBody({ ...f, local: bundle }),
    ids = [randomUUID(), randomUUID()];
  body.order.items = [
    { customer_item_id: ids[0], product_id: bundle.id, quantity: 1 },
    { customer_item_id: ids[1], product_id: bundle.id, quantity: 2 },
  ];
  body.allocations = body.order.items.map((i: Row) => ({
    customer_item_id: i.customer_item_id,
    local_quantity: 0,
    external_quantity: i.quantity,
    unassigned_quantity: 0,
    link_id: f.link.id,
  }));
  const beforeBuyer = await physicalSnapshot(),
    created = await createIntent(f, body);
  assert.equal(created.order.total, 29700);
  for (const item of created.order.items)
    assert.deepEqual(
      item.components
        .map(({ product_id, quantity }: Row) => ({ product_id, quantity }))
        .sort((a: Row, b: Row) => a.product_id.localeCompare(b.product_id)),
      components.slice().sort((a, b) => a.product_id.localeCompare(b.product_id)),
    );
  const q = await quote(f, {
    client_key: randomUUID(),
    customer_order_id: f.order.id,
    items: body.order.items.map((i: Row) => ({
      customer_item_id: i.customer_item_id,
      quantity: i.quantity,
      mappings: [
        {
          product_id: f.local.id,
          catalog_item_id: catalog.find((c: Row) => c.source_product_id === f.source.id).id,
        },
        { product_id: imported.product_id, catalog_item_id: secondItem.id },
      ],
    })),
  });
  const forwarded = await checkout(f, q);
  const sourceOrder = await ok(
    '/orders/' + forwarded.supplier_order_id,
    'GET',
    undefined,
    supplierCookie,
  );
  assert.equal(sourceOrder.total, 6000);
  assert.deepEqual(
    new Map(sourceOrder.items.map((i: Row) => [i.product_id, i.quantity])),
    new Map([
      [f.source.id, 6],
      [second.id, 3],
    ]),
  );
  assert.deepEqual(await stock(supplier, f.source.id), { on_hand: 20, reserved: 6, available: 14 });
  assert.deepEqual(await stock(supplier, second.id), { on_hand: 20, reserved: 3, available: 17 });
  assert.deepEqual(await physicalSnapshot(), beforeBuyer);
  const lines = (
    await pool.query(
      'SELECT customer_item_id,quantity,mappings FROM b2b_dropship_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY customer_item_id',
      [buyer, forwarded.id],
    )
  ).rows;
  assert.equal(lines.length, 2);
  assert.deepEqual(new Set(lines.map((l) => l.customer_item_id)), new Set(ids));
  assert(lines.every((l) => l.mappings.length === 2));
  assert.equal(providerCalls, 0);
});

test('missing actual component mapping and supplier stock consumed after quote cause atomic refusal without local fallback', async () => {
  const f = await fixture();
  await createIntent(f);
  const unmapped = await ok('/products', 'POST', {
    sku: 'OWN-UNMAPPED-' + randomUUID(),
    name: 'Own unlinked physical identity',
    price: 2500,
    vat: 23,
    quantity: 0,
    warehouse_id: buyerWarehouse,
  });
  const current = await detail(f),
    beforeMapping = await snapshot();
  const bad = await request(f.path + '/quotes', 'POST', {
    ...quoteBody(f, 3),
    fulfillment_basis: 'external_intent',
    intent_version: current.intent.version,
    items: [
      {
        customer_item_id: f.order.items[0].id,
        quantity: 3,
        mappings: [{ product_id: unmapped.id, catalog_item_id: f.item.id }],
      },
    ],
  });
  assert.equal(bad.statusCode, 422, bad.body);
  assert.deepEqual(await snapshot(), beforeMapping);
  const q = await quote(f, quoteBody(f, 3));
  await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Own competing wholesale demand',
      email: 'competing127@example.test',
      warehouse_id: supplierWarehouse,
      payment_mode: 'cod',
      items: [{ product_id: f.source.id, quantity: 18 }],
    },
    supplierCookie,
  );
  assert.deepEqual(await stock(supplier, f.source.id), { on_hand: 20, reserved: 18, available: 2 });
  const before = await snapshot();
  const refused = await request(f.path + '/quotes/' + q.id + '/checkout', 'POST', consent(q));
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await stock(buyer, f.local.id), { on_hand: 0, reserved: 0, available: 0 });
  assert.equal(providerCalls, 0);
});

test('a genuine deferred failure after supplier creation rolls back both firms, custody, intent revision, evidence and jobs', async () => {
  const f = await fixture();
  await createIntent(f);
  const q = await quote(f, quoteBody(f, 3)),
    before = await snapshot(),
    physical = await physicalSnapshot();
  // Own isolated fixture adds an actual terminal database constraint. Its
  // diagnostic proves a real linked supplier order/item already exists in the
  // pending transaction; no fake disconnected success ledger is constructed.
  await pool.query(`CREATE FUNCTION own127_terminal_failure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
    IF NEW.tenant_id=TG_ARGV[0]::uuid AND NEW.kind='commit' THEN
      IF NOT EXISTS(SELECT 1 FROM b2b_dropship_orders d JOIN orders o ON(o.tenant_id,o.id)=(d.supplier_tenant_id,d.supplier_order_id) JOIN order_items i ON(i.tenant_id,i.order_id)=(o.tenant_id,o.id) WHERE d.tenant_id=NEW.tenant_id AND d.customer_order_id=TG_ARGV[1]::uuid AND o.source='b2b' AND i.quantity=3) THEN
        RAISE EXCEPTION 'OWN127_SUPPLIER_PROOF_NOT_REACHED' USING ERRCODE='23514';
      END IF;
      RAISE EXCEPTION 'OWN127_AFTER_GENUINE_SUPPLIER_ORDER' USING ERRCODE='23514';
    END IF; RETURN NULL; END $$`);
  try {
    await pool.query(
      `CREATE CONSTRAINT TRIGGER own127_terminal_failure AFTER INSERT ON b2b_external_order_intent_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION own127_terminal_failure('${buyer}','${f.order.id}')`,
    );
    await assert.rejects(
      checkoutB2bDropship(
        { tenantId: buyer, userId: buyerUser, role: 'admin' },
        f.link.id,
        q.id,
        consent(q),
      ),
      { code: '23514', message: 'OWN127_AFTER_GENUINE_SUPPLIER_ORDER' },
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await physicalSnapshot(), physical);
    assert.deepEqual(await stock(supplier, f.source.id), {
      on_hand: 20,
      reserved: 0,
      available: 20,
    });
  } finally {
    await pool.query(
      'DROP TRIGGER IF EXISTS own127_terminal_failure ON b2b_external_order_intent_revisions',
    );
    await pool.query('DROP FUNCTION own127_terminal_failure()');
  }
  const forwarded = await checkout(f, q);
  assert(forwarded.supplier_order_id);
  assert.deepEqual(await stock(supplier, f.source.id), { on_hand: 20, reserved: 3, available: 17 });
  assert.equal(providerCalls, 0);
});
