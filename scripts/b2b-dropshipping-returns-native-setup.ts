/**
 * Root-only, one-shot local QA128 preparation. Authoring this file does not run it.
 * Invoke: QA_EXPECTED_REVISION=<reviewed SHA> QA128_DATABASE_NAME=dynaminds
 *   DYNA_WORKER_DISABLED=true
 *   QA128_SETUP_CONFIRM=CREATE_NEW_SYNTHETIC_FIRMS DATABASE_URL=<local connection>
 *   tsx scripts/b2b-dropshipping-returns-native-setup.ts setup
 * Requires the reviewed native launch guard and an actual /health response with
 * background_workers_enabled=false. Older servers fail before any fixture write.
 * Uses genuine HTTP routes, a simulation-only Shopify source, and only the own
 * catalog job handler. No testfactory, migrate, seed, provider call or RMA write.
 * Any partial/uncertain setup is retained privately and MUST NOT be rerun.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { demoShopifyOrder } from '../server/shopify-example';

type Row = Record<string, any>;
type Actor = {
  email: string;
  password: string;
  cookie?: string;
  tenant?: string;
  user?: string;
  warehouse?: string;
};
type Fingerprint = { count: number; sha256: string };
type Snapshot = Record<string, Fingerprint>;
const statePath = 'data/b2b-dropshipping-returns-stage128.json';
const reportPath = 'docs/b2b-dropshipping-returns-native-setup-qa.json';
const apiOrigin = 'http://127.0.0.1:4100';
const physical = [
  'stock',
  'stock_locations',
  'stock_location_movements',
  'stock_location_operations',
  'stock_movements',
  'reservations',
  'reservation_locations',
  'order_pick_items',
  'warehouse_documents',
  'warehouse_document_lines',
  'wms_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'shipments',
];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let pool: Pool | undefined;
let state: Row | undefined;
let failedStep = 'preflight';
let privateCreated = false;

async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw new Error('Existing setup/report refuses rerun; inspect its own private pending receipt');
}
async function save() {
  assert(state && privateCreated);
  const st = await lstat(statePath);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
async function api(
  actor: Actor | null,
  route: string,
  method = 'GET',
  body?: Row,
  expected = 200,
): Promise<Row> {
  assert(route.startsWith('/') && !route.startsWith('//'));
  const response = await fetch(apiOrigin + '/api' + route, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(actor?.cookie ? { cookie: actor.cookie } : {}),
      ...(actor?.tenant ? { 'X-Workspace-ID': actor.tenant } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const cookie = response.headers.get('set-cookie');
  if (actor && cookie) actor.cookie = cookie.split(';')[0];
  // Persist cookie rotation while the exact mutation remains pending.
  if (privateCreated && method !== 'GET') await save();
  assert.equal(
    response.status,
    expected,
    'Unexpected HTTP status; never automatically repeat setup',
  );
  const text = await response.text();
  assert(Buffer.byteLength(text) <= 8 * 1024 * 1024, 'API response bound');
  return JSON.parse(text) as Row;
}
async function mutate(
  key: string,
  actor: Actor | null,
  route: string,
  method: string,
  body: Row,
  expected = 200,
): Promise<Row> {
  assert(state && !state.pending && !Object.hasOwn(state.completed, key));
  failedStep = key;
  await health();
  state.pending = { key, route, method, body, expected, started_at: new Date().toISOString() };
  state.requests[key] = { route, method, body, expected };
  await save();
  const result = await api(actor, route, method, body, expected);
  state.completed[key] = result;
  state.pending = null;
  await save();
  return result;
}
async function health() {
  const h = await api(null, '/health');
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(h.schema_revision, '111_b2b_dropshipping_returns');
  assert.equal(h.restore_preview, false);
  assert.equal(
    h.background_workers_enabled,
    false,
    'Actual native launch must disable all background workers',
  );
  for (const field of [
    'b2b_dropshipping_returns_available',
    'b2b_external_order_imports_available',
    'b2b_external_order_intents_available',
    'b2b_dropshipping_available',
  ])
    assert.equal(h[field], true);
  return h;
}
async function signup(side: 'buyer' | 'supplier') {
  assert(state && !state[side]);
  const actor: Actor = {
    email: `qa128-${side}-${randomUUID()}@example.test`,
    password: 'Dyna-QA128-' + randomUUID(),
  };
  state[side] = actor;
  await save();
  await mutate(
    side + '_signup',
    actor,
    '/auth/signup',
    'POST',
    {
      email: actor.email,
      password: actor.password,
      name: 'QA128 ' + side,
      organization: { name: 'QA128 direct customer returns ' + side },
    },
    201,
  );
  const me = (await api(actor, '/auth/me')).user;
  assert.equal(me.role, 'admin');
  actor.user = me.id;
  actor.tenant = me.tenant_id;
  assert(pool);
  const rows = (
    await pool.query(
      'SELECT u.id,t.id tenant_id,t.name,m.role FROM users u JOIN memberships m ON m.user_id=u.id JOIN tenants t ON t.id=m.tenant_id WHERE u.id=$1 AND t.id=$2',
      [actor.user, actor.tenant],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'admin');
  assert.equal(rows[0].name, 'QA128 direct customer returns ' + side);
  await save();
  await mutate(side + '_plan', actor, '/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  const warehouses = (await api(actor, '/warehouses')).data;
  assert.equal(warehouses.length, 1);
  actor.warehouse = warehouses[0].id;
  await save();
}
function sourceRaw(sku: string): Row {
  const raw: Row = structuredClone(demoShopifyOrder);
  const first = raw.lineItems.nodes[0];
  const money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });
  raw.id = 'gid://shopify/Order/12800001';
  raw.name = '#QA128-SOURCE-42';
  raw.updatedAt = new Date().toISOString();
  raw.email = 'qa128-customer@example.test';
  raw.note = 'QA128 synthetic local source; no live Shopify or banking proof';
  raw.shippingAddress = {
    ...raw.shippingAddress,
    firstName: 'QA128',
    lastName: 'Synthetic Customer',
    address1: 'Klienta 128',
    zip: '00-128',
  };
  raw.lineItems.nodes = [
    {
      ...structuredClone(first),
      id: 'gid://shopify/LineItem/128000011',
      sku,
      quantity: 2,
      currentQuantity: 2,
      unfulfilledQuantity: 2,
      originalTotalSet: money('20.00'),
      discountAllocations: [],
      taxLines: [],
    },
    {
      ...structuredClone(first),
      id: 'gid://shopify/LineItem/128000012',
      sku,
      quantity: 1,
      currentQuantity: 1,
      unfulfilledQuantity: 1,
      originalTotalSet: money('17.00'),
      discountAllocations: [],
      taxLines: [],
    },
  ];
  raw.shippingLines.nodes[0].taxLines = [];
  raw.totalPriceSet = raw.currentTotalPriceSet = money('42.00');
  raw.totalReceivedSet = money('10.00');
  raw.totalTaxSet = money('0.00');
  raw.displayFinancialStatus = 'PARTIALLY_PAID';
  return raw;
}
async function ownCatalog(run: Row) {
  assert(state && pool);
  failedStep = 'own_catalog_job';
  await health();
  const row = (
    await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1 AND tenant_id=$2 AND link_id=$3', [
      run.id,
      state.buyer.tenant,
      state.link,
    ])
  ).rows[0];
  assert(row && row.state === 'queued' && row.actor_id === state.buyer.user);
  const job = (
    await pool.query('SELECT * FROM jobs WHERE id=$1 AND tenant_id=$2', [
      row.job_id,
      state.buyer.tenant,
    ])
  ).rows[0];
  assert(job && job.kind === 'b2b.catalog' && job.state === 'pending');
  assert.deepEqual(job.payload, {
    run_id: row.id,
    link_id: state.link,
    actor_id: state.buyer.user,
  });
  const lease = randomUUID();
  state.pending = {
    key: failedStep,
    run_id: row.id,
    job_id: job.id,
    lease,
    started_at: new Date().toISOString(),
  };
  await save();
  const claimed = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$3,locked_at=now() WHERE id=$1 AND tenant_id=$2 AND kind='b2b.catalog' AND state='pending' AND lease_token IS NULL RETURNING *",
      [job.id, state.buyer.tenant, lease],
    )
  ).rows[0];
  assert(claimed);
  const { processB2bCatalog } = await import('../server/b2b-network');
  await processB2bCatalog(claimed);
  assert.equal(
    (
      await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1 AND tenant_id=$2', [
        row.id,
        state.buyer.tenant,
      ])
    ).rows[0].state,
    'done',
    'One own product must complete in one catalog page',
  );
  // The real handler completes/releases this job atomically with its catalog
  // page. Never synthesize a second completion or change another queued job.
  const completed = (
    await pool.query('SELECT state,lease_token,locked_at FROM jobs WHERE id=$1 AND tenant_id=$2', [
      job.id,
      state.buyer.tenant,
    ])
  ).rows[0];
  assert.deepEqual(completed, { state: 'done', lease_token: null, locked_at: null });
  state.completed.own_catalog_job = { run_id: row.id, job_id: job.id };
  state.pending = null;
  await save();
}
async function pay(actor: Actor, orderId: string, expectedDue: number, key: string) {
  const order = await api(actor, '/orders/' + orderId);
  const ledger = await api(actor, '/orders/' + orderId + '/payments');
  assert.equal(ledger.balance.amount_due, expectedDue);
  await mutate(key, actor, '/orders/' + orderId + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(order.version),
    kind: 'receipt',
    amount: expectedDue,
    currency: 'PLN',
    method: 'other',
    reference: 'QA128 synthetic local declaration; no bank transfer',
    confirmed: true,
  });
  assert.equal((await api(actor, '/orders/' + orderId + '/payments')).balance.amount_due, 0);
}
async function snapshots(): Promise<{ buyer: Snapshot; supplier: Snapshot }> {
  assert(pool && state);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const names: string[] = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`)
    ).rows.map((r) => r.table_name);
    const out = { buyer: {} as Snapshot, supplier: {} as Snapshot };
    for (const side of ['buyer', 'supplier'] as const)
      for (const name of names) {
        assert.match(name, /^[a-z_][a-z0-9_]*$/);
        const key = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
            name === 'users' ? state[side].user : state[side].tenant,
          ])
        ).rows;
        out[side][name] = { count: rows.length, sha256: hash(rows) };
      }
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
function physicalSnapshot(all: Snapshot) {
  return Object.fromEntries(
    physical.map((name) => {
      assert(all[name]);
      return [name, all[name]];
    }),
  );
}
async function setup() {
  assert(state && pool);
  await signup('supplier');
  await signup('buyer');
  const supplier = state.supplier as Actor,
    buyer = state.buyer as Actor;
  assert.notEqual(buyer.tenant, supplier.tenant);
  for (const actor of [supplier, buyer])
    assert.equal(
      (await api(actor, '/wms-lots')).policy.enabled,
      false,
      'This Chrome fixture uses genuinely quantity-only stock; no FIFO opening is inferred',
    );
  const product = await mutate(
    'supplier_product',
    supplier,
    '/products',
    'POST',
    {
      sku: 'QA128-SUPPLIER-A',
      name: 'QA128 supplier physical product',
      price: 700,
      vat: 23,
      quantity: 20,
      warehouse_id: supplier.warehouse,
    },
    201,
  );
  state.supplier_product = product.id;
  const list = await mutate(
    'supplier_list',
    supplier,
    '/price-lists',
    'POST',
    { name: 'QA128 wholesale PLN', currency: 'PLN' },
    201,
  );
  await mutate('supplier_prices', supplier, '/price-lists/' + list.id + '/items', 'PUT', {
    version: list.version,
    items: [{ product_id: product.id, price: 700 }],
  });
  const body = {
    name: 'QA128 Buyer counterparty',
    email: buyer.email,
    warehouse_id: supplier.warehouse,
    price_list_id: list.id,
    address: { street: 'Sprzedawcy 128', city: 'Warszawa', postal_code: '00-128', country: 'PL' },
    shipping_cost: 0,
    payment_mode: 'prepaid',
    min_total: 0,
    min_quantity: 1,
    quantity_step: 1,
  };
  let account = await mutate('account', supplier, '/b2b/accounts', 'POST', body, 201);
  account = await mutate('account_enabled', supplier, '/b2b/accounts/' + account.id, 'PATCH', {
    ...body,
    version: account.version,
    active: true,
    confirmed: true,
  });
  state.account = account.id;
  const settings = (await api(supplier, '/b2b/dropshipping-returns/settings/' + account.id))
    .settings;
  assert.equal(settings.version, 0);
  assert.equal(settings.enabled, false);
  const optin = await mutate(
    'supplier_return_optin',
    supplier,
    '/b2b/dropshipping-returns/settings/' + account.id,
    'PATCH',
    {
      client_key: randomUUID(),
      version: 0,
      enabled: true,
      warehouse_id: supplier.warehouse,
      return_address: {
        name: 'QA128 supplier returns',
        street: 'Zwrotów 128',
        city: 'Poznań',
        postal_code: '60-128',
        country: 'PL',
      },
      confirmed: true,
    },
  );
  assert.equal(optin.settings.enabled, true);
  state.return_settings = optin.settings;
  const invite = await mutate(
    'invitation',
    supplier,
    '/b2b/accounts/' + account.id + '/network-invite',
    'POST',
    { version: account.version, recipient_email: buyer.email, confirmed: true },
  );
  const link = await mutate('link', buyer, '/b2b/network/accept', 'POST', {
    token: invite.token,
    confirmed: true,
  });
  state.link = link.id;
  await save();
  const base = '/b2b/network/links/' + link.id;
  const run = await mutate('catalog_refresh', buyer, base + '/refresh', 'POST', {
    client_key: randomUUID(),
    confirmed: true,
  });
  await ownCatalog(run);
  const catalog = (await api(buyer, base + '/catalog')).data;
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].source_product_id, product.id);
  state.catalog_item = catalog[0].id;
  const mapped = await mutate(
    'local_product',
    buyer,
    base + '/catalog/' + catalog[0].id + '/product',
    'POST',
    {
      version: catalog[0].version,
      sku: 'QA128-RETAIL-A',
      sale_price: 29999,
      warehouse_id: buyer.warehouse,
      confirmed: true,
    },
  );
  state.buyer_product = mapped.product_id;
  const example = await mutate(
    'shopify_simulation',
    buyer,
    '/integrations/shopify-example',
    'POST',
    {},
  );
  state.channel = example.channel_id;
  const channel = (
    await pool.query('SELECT provider,settings FROM channels WHERE tenant_id=$1 AND id=$2', [
      buyer.tenant,
      state.channel,
    ])
  ).rows[0];
  assert.equal(channel.provider, 'shopify');
  assert.equal(channel.settings.simulation, true, 'No real Shopify transport is permitted');
  await mutate('source_mapping', buyer, '/integrations/' + state.channel + '/mappings', 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku: 'QA128-RETAIL-A',
  });
  state.raw = sourceRaw('QA128-RETAIL-A');
  const staged = await mutate(
    'source_stage',
    buyer,
    '/integrations/' + state.channel + '/stage-orders',
    'POST',
    { data: [state.raw] },
  );
  assert.equal(staged.data.length, 1);
  assert.equal(staged.data[0].state, 'staged');
  state.inbound = staged.data[0].id;
  const source = (await api(buyer, '/imports/' + state.inbound + '/external-intent-source')).source;
  assert.equal(source.total, 4200);
  assert.equal(source.shipping_cost, 500);
  assert.equal(source.payment.paid_amount, 1000);
  assert.equal(source.lines.length, 2);
  assert.deepEqual(
    source.lines.map((i: Row) => [i.remote_line_id, i.quantity, i.price, i.line_total]),
    [
      ['gid://shopify/LineItem/128000011', 2, 1000, 2000],
      ['gid://shopify/LineItem/128000012', 1, 1700, 1700],
    ],
  );
  state.source_before_import = source;
  state.buyer_physical_born = physicalSnapshot((await snapshots()).buyer);
  const { preview } = await mutate(
    'source_preview',
    buyer,
    '/imports/' + state.inbound + '/external-intent-previews',
    'POST',
    {
      client_key: randomUUID(),
      warehouse_id: buyer.warehouse,
      expected_source_hash: source.source_hash,
      allocations: source.lines.map((i: Row) => ({
        remote_line_id: i.remote_line_id,
        local_quantity: 0,
        external_quantity: i.quantity,
        unassigned_quantity: 0,
        link_id: link.id,
      })),
    },
    201,
  );
  const imported = await mutate(
    'source_import_execute',
    buyer,
    '/import-external-intent-previews/' + preview.id + '/execute',
    'POST',
    {
      client_key: randomUUID(),
      version: preview.version,
      scope_hash: preview.scope_hash,
      confirmed: true,
    },
    201,
  );
  const order = imported.order,
    intent = imported.intent;
  state.customer_order = order.id;
  state.intent = intent.id;
  state.source_preview = preview.id;
  assert.deepEqual(
    order.items.map((i: Row) => i.line_total).sort((a: number, b: number) => a - b),
    [1700, 2000],
  );
  assert.equal(new Set(order.items.map((i: Row) => i.id)).size, 2);
  state.cheap_customer_item = order.items.find((i: Row) => i.quantity === 2)?.id;
  state.expensive_customer_item = order.items.find((i: Row) => i.quantity === 1)?.id;
  assert(state.cheap_customer_item && state.expensive_customer_item);
  const drop = base + '/dropshipping';
  const { quote } = await mutate(
    'supplier_quote',
    buyer,
    drop + '/quotes',
    'POST',
    {
      client_key: randomUUID(),
      customer_order_id: order.id,
      fulfillment_basis: 'external_intent',
      intent_version: intent.version,
      items: order.items.map((i: Row) => ({
        customer_item_id: i.id,
        quantity: i.quantity,
        mappings: [{ product_id: mapped.product_id, catalog_item_id: catalog[0].id }],
      })),
    },
    201,
  );
  assert.equal(quote.ready, true);
  const { order: forwarded } = await mutate(
    'supplier_checkout',
    buyer,
    drop + '/quotes/' + quote.id + '/checkout',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: quote.scope_hash,
      confirmed: true,
      confirmed_receiver: true,
    },
    201,
  );
  state.forwarding = forwarded.id;
  state.supplier_order = forwarded.supplier_order_id;
  await save();
  await pay(supplier, forwarded.supplier_order_id, 2100, 'supplier_synthetic_receipt');
  await pay(buyer, order.id, 3200, 'buyer_synthetic_receipt');
  await mutate(
    'supplier_picking',
    supplier,
    '/orders/' + forwarded.supplier_order_id + '/status',
    'PATCH',
    { status: 'picking' },
  );
  const picking = await api(supplier, '/orders/' + forwarded.supplier_order_id);
  assert.equal(picking.picking_items.length, 1);
  assert.equal(picking.picking_items[0].quantity, 3);
  assert.equal(picking.picking_items[0].scanned, 0);
  for (let n = 0; n < 3; n++)
    await mutate(
      'supplier_scan_' + (n + 1),
      supplier,
      '/orders/' + forwarded.supplier_order_id + '/scan',
      'POST',
      { code: 'QA128-SUPPLIER-A', client_key: randomUUID() },
    );
  await mutate(
    'supplier_packed',
    supplier,
    '/orders/' + forwarded.supplier_order_id + '/status',
    'PATCH',
    { status: 'packed' },
  );
  await mutate(
    'supplier_ship_demo',
    supplier,
    '/orders/' + forwarded.supplier_order_id + '/ship-demo',
    'POST',
    {},
  );
  const dispatched = (await api(buyer, drop + '/orders/' + forwarded.id)).order;
  assert.equal(dispatched.fulfillment.status, 'shipped');
  assert(
    dispatched.fulfillment.shipments.some(
      (s: Row) => s.dispatched_at && s.mode === 'demo' && s.tracking_number,
    ),
  );
  assert.equal(dispatched.can_reconcile, true);
  // This is the existing126 dispatch reconciliation, never an RMA128 reconcile.
  await mutate(
    'customer_dispatch_reconcile',
    buyer,
    drop + '/orders/' + forwarded.id + '/reconcile',
    'POST',
    { client_key: randomUUID(), version: dispatched.version, confirmed: true },
  );
  await finalize();
}
async function finalize() {
  assert(state && pool && !state.pending && !state.setup_complete && !state.setup_checkpoint);
  failedStep = 'final_readback';
  await health();
  const buyer = state.buyer as Actor,
    supplier = state.supplier as Actor;
  const buyerOrder = await api(buyer, '/orders/' + state.customer_order);
  const supplierOrder = await api(supplier, '/orders/' + state.supplier_order);
  assert.equal(buyerOrder.status, 'shipped');
  assert.equal(supplierOrder.status, 'shipped');
  assert.deepEqual(
    buyerOrder.items.map((i: Row) => [i.id, i.quantity, i.price, i.line_total]).sort(),
    [
      [state.cheap_customer_item, 2, 1000, 2000],
      [state.expensive_customer_item, 1, 1700, 1700],
    ].sort(),
  );
  assert.equal(buyerOrder.total, 4200);
  assert.equal(buyerOrder.dropshipping.local_required_quantity, 0);
  assert.equal(buyerOrder.dropshipping.external_dispatched_quantity, 3);
  assert.equal(
    (await api(buyer, '/orders/' + state.customer_order + '/payments')).balance.amount_due,
    0,
  );
  assert.equal(
    (await api(supplier, '/orders/' + state.supplier_order + '/payments')).balance.amount_due,
    0,
  );
  const supplierStock = (
    await pool.query(
      'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [supplier.tenant, supplier.warehouse, state.supplier_product],
    )
  ).rows;
  assert.deepEqual(supplierStock, [{ on_hand: 17, reserved: 0, available: 17 }]);
  const buyerStock = (
    await pool.query(
      'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [buyer.tenant, buyer.warehouse, state.buyer_product],
    )
  ).rows;
  assert.deepEqual(buyerStock, [{ on_hand: 0, reserved: 0, available: 0 }]);
  const shipments = (
    await pool.query(
      'SELECT id,carrier,tracking_number,mode,dispatched_at FROM shipments WHERE tenant_id=$1 AND order_id=$2 ORDER BY id',
      [supplier.tenant, state.supplier_order],
    )
  ).rows;
  assert.equal(shipments.length, 1);
  assert.equal(shipments[0].mode, 'demo');
  assert(shipments[0].dispatched_at && shipments[0].tracking_number);
  state.supplier_shipment = shipments[0].id;
  const picks = (
    await pool.query(
      'SELECT product_id,quantity,scanned FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id',
      [supplier.tenant, state.supplier_order],
    )
  ).rows;
  assert.deepEqual(picks, [{ product_id: state.supplier_product, quantity: 3, scanned: 3 }]);
  const checkpoint = await snapshots();
  assert.deepEqual(
    physicalSnapshot(checkpoint.buyer),
    state.buyer_physical_born,
    'Buyer physical records must stay exact through external import/dispatch',
  );
  for (const side of ['buyer', 'supplier'] as const) {
    assert.equal(checkpoint[side].return_cases.count, 0, 'Setup must not create an RMA');
    for (const name of Object.keys(checkpoint[side]).filter(
      (n) =>
        n.startsWith('b2b_dropship_return_') &&
        !['b2b_dropship_return_settings', 'b2b_dropship_return_actions'].includes(n),
    ))
      assert.equal(
        checkpoint[side][name].count,
        0,
        'No paired return, receipt or acceptance during setup',
      );
    assert.equal(checkpoint[side].b2b_dropship_return_actions.count, side === 'supplier' ? 1 : 0);
  }
  assert.equal(checkpoint.supplier.b2b_dropship_return_settings.count, 1);
  const settingsActions = (
    await pool.query(
      'SELECT kind,actor_id,case_id,return_id,preview_id,request,result FROM b2b_dropship_return_actions WHERE tenant_id=$1 ORDER BY id',
      [supplier.tenant],
    )
  ).rows;
  assert.equal(settingsActions.length, 1);
  assert.equal(settingsActions[0].kind, 'settings');
  assert.equal(settingsActions[0].actor_id, supplier.user);
  for (const key of ['case_id', 'return_id', 'preview_id'])
    assert.equal(settingsActions[0][key], null);
  assert.deepEqual(settingsActions[0].request, state.requests.supplier_return_optin.body);
  assert.deepEqual(settingsActions[0].result, { settings: state.return_settings });
  state.born_source_state = {
    buyer_order: buyerOrder,
    supplier_order: supplierOrder,
    supplier_stock: supplierStock,
    buyer_stock: buyerStock,
    supplier_shipments: shipments,
    supplier_picks: picks,
  };
  state.setup_checkpoint = checkpoint;
  state.setup_complete = true;
  state.chrome_verified = false;
  state.setup_finished_at = new Date().toISOString();
  await save();
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        stage: 128,
        phase: 'setup',
        status: 'PASS',
        revision: state.runtime_revision,
        schema_revision: state.schema_revision,
        firms: 2,
        own_tables: {
          buyer: Object.keys(checkpoint.buyer).length,
          supplier: Object.keys(checkpoint.supplier).length,
        },
        source: {
          commercial_lines: 2,
          quantities: [2, 1],
          unit_prices_minor: [1000, 1700],
          line_totals_minor: [2000, 1700],
          total_minor: 4200,
          shipping_minor: 500,
          source_payment_declaration_minor: 1000,
        },
        supplier: {
          initial_quantity: 20,
          dispatched_quantity: 3,
          on_hand: 17,
          reserved: 0,
          scanned: 3,
          demo_shipments: 1,
          synthetic_receipt_minor: 2100,
          return_optin: true,
        },
        buyer: {
          on_hand: 0,
          reserved: 0,
          external_dispatched_quantity: 3,
          local_required_quantity: 0,
          synthetic_additional_receipt_minor: 3200,
          physical_checkpoint_exact: true,
          physical_tables: physical.length,
        },
        setup_checkpoint_sha256: hash(checkpoint),
        background_workers_enabled: false,
        worker_off_evidence:
          'Reviewed native launch guard plus exact-revision health read before setup and after dispatch',
        own_catalog_job_only: true,
        rma_created: false,
        supplier_rma_received: false,
        retail_rma_reconciled: false,
        chrome_verified: false,
        live_provider_verified: false,
        bank_payment_verified: false,
        acceptance: 'PENDING actual Chrome RMA process',
        private_credentials_published: false,
        full_goal_complete: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}
try {
  assert.equal(process.argv[2], 'setup', 'Only one-shot setup is supported');
  assert.equal(process.env.QA128_SETUP_CONFIRM, 'CREATE_NEW_SYNTHETIC_FIRMS');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.notEqual(process.env.DYNA_TEST, 'true', 'Do not run a testfactory or change test guards');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{7,40}$/);
  const db = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
  assert(['postgres:', 'postgresql:'].includes(db.protocol));
  assert.equal(db.search, '');
  assert.equal(process.env.QA128_DATABASE_NAME, 'dynaminds');
  assert.equal(db.pathname, '/dynaminds');
  const config = await lstat(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json');
  assert(
    config.isFile() && !config.isSymbolicLink() && !(config.mode & 0o077),
    'Existing private local config required',
  );
  await absent(statePath);
  await absent(reportPath);
  await health();
  pool = (await import('../server/db')).pool;
  const dbInfo = (
    await pool.query(
      'SELECT current_database() name,host(inet_server_addr()) host,inet_server_port() port,(SELECT name FROM migrations ORDER BY name DESC LIMIT 1) schema_revision',
    )
  ).rows[0];
  assert.equal(dbInfo.name, 'dynaminds');
  assert(['127.0.0.1', '::1'].includes(dbInfo.host));
  assert.equal(dbInfo.port, Number(db.port || 5432));
  assert.equal(dbInfo.schema_revision, '111_b2b_dropshipping_returns');
  state = {
    stage128: true,
    runtime_revision: process.env.QA_EXPECTED_REVISION,
    schema_revision: dbInfo.schema_revision,
    setup_started_at: new Date().toISOString(),
    setup_complete: false,
    pending: null,
    requests: {},
    completed: {},
    background_workers_enabled: false,
  };
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  privateCreated = true;
  await setup();
  process.stdout.write(
    JSON.stringify({
      stage: 128,
      phase: 'setup',
      status: 'PASS',
      chrome_verified: false,
      rma_process: 'PENDING',
    }) + '\n',
  );
} catch {
  // Do not publish HTTP bodies, request payloads, credentials or PostgreSQL errors.
  if (privateCreated && state) {
    state.setup_failed = {
      step: failedStep,
      at: new Date().toISOString(),
      requires_manual_readback: true,
    };
    await save();
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          stage: 128,
          phase: 'setup',
          status: 'FAIL',
          step: failedStep,
          partial_state_retained: true,
          rerun_allowed: false,
          chrome_verified: false,
          private_credentials_published: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    ).catch(() => {});
  }
  process.stderr.write(
    JSON.stringify({
      stage: 128,
      phase: 'setup',
      status: 'FAIL',
      step: failedStep,
      rerun_allowed: false,
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
