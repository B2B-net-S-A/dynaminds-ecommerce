/** Local synthetic QA127B. Author only; setup never imports or creates an intent. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { demoShopifyOrder } from '../server/shopify-example';

type Row = Record<string, any>;
type Checkpoint = Record<string, { count: number; sha256: string }>;
const file = 'data/source-order-intent-stage127b.json';
const originals = [
  'data/wms-lots-stage111.json',
  'data/source-fulfillment-stage124.json',
  'data/b2b-network-dropshipping-stage126.json',
  'data/b2b-external-order-intent-stage127.json',
];
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
const phase = process.argv[2];
assert(['baseline', 'setup', 'adopt-setup', 'verify'].includes(phase));
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let state: Row;
const save = () => writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
async function privateBytes(path: string) {
  const st = await lstat(path);
  assert(
    st.isFile() && !st.isSymbolicLink() && !(st.mode & 0o077),
    'Private regular file required',
  );
  return readFile(path);
}
async function api(side: Row | null, route: string, method = 'GET', body?: Row, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + route, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(side?.cookie ? { cookie: side.cookie, 'X-Workspace-ID': side.tenant ?? '' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(r.status, expected, `${method} ${route}: HTTP${r.status}; do not repeat mutations`);
  const data = (await r.json()) as Row;
  if (side && r.headers.get('set-cookie')) side.cookie = r.headers.get('set-cookie')!.split(';')[0];
  return data;
}
async function health(schema: string, pinSetup = false) {
  const h = await api(null, '/health');
  const revision = process.env.QA_EXPECTED_REVISION ?? state?.runtime_revision;
  assert(
    revision && /^[a-f0-9]{7,40}$/.test(revision),
    'Explicit expected source revision required',
  );
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.restore_preview, false);
  if (schema.startsWith('110_')) assert.equal(h.b2b_external_order_imports_available, true);
  if (pinSetup) {
    assert(
      !state.runtime_revision || state.runtime_revision === revision,
      'Do not replace setup provenance',
    );
    state.runtime_revision = revision;
    state.schema_revision = schema;
    await save();
  } else if (phase === 'verify' && h.revision !== state.runtime_revision) {
    assert(
      process.env.QA_EXPECTED_REVISION && state.accepted_checkpoint,
      'A later revision requires an explicit expected revision and an existing accepted checkpoint',
    );
    assert(
      process.env.QA_REPORT_FILE,
      'Preserve the historical report when checking a later revision',
    );
  }
  return h;
}
async function checkpoint(tenant: string, user: string): Promise<Checkpoint> {
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
    const out: Checkpoint = {};
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
          name === 'users' ? user : tenant,
        ])
      ).rows;
      out[name] = { count: rows.length, sha256: digest(rows) };
    }
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function previousExact() {
  for (const old of state.previous) {
    assert.equal(bytesHash(await privateBytes(old.path)), old.fixture_sha256);
    const current = await checkpoint(old.tenant, old.user);
    for (const [name, value] of Object.entries(old.checkpoint))
      assert.deepEqual(current[name], value, `Previous firm changed: ${name}`);
    for (const [name, value] of Object.entries(current))
      if (!Object.hasOwn(old.checkpoint, name))
        assert.equal(value.count, 0, `New evidence in previous firm: ${name}`);
  }
}
function physicalOnly(all: Checkpoint) {
  return Object.fromEntries(
    physical.map((name) => {
      assert(all[name], 'Missing table: ' + name);
      return [name, all[name]];
    }),
  );
}
async function mutate(
  key: string,
  side: Row | null,
  route: string,
  method: string,
  body: Row,
  expected = 200,
): Promise<Row> {
  assert.equal(phase, 'setup');
  assert(
    !state.pending && !Object.hasOwn(state.completed, key),
    'Never repeat a completed/uncertain setup mutation',
  );
  state.pending = { key, route, method, body, expected };
  await save();
  const result = await api(side, route, method, body, expected);
  state.completed[key] = result;
  state.pending = null;
  await save();
  return result;
}
async function signup(side: 'buyer' | 'supplier') {
  assert(!state[side], 'Each new QA identity is created once');
  const who: Row = {
    email: `qa127b-${side}-${randomUUID()}@example.test`,
    password: 'Dyna-QA127B-' + randomUUID(),
  };
  state[side] = who;
  await save();
  await mutate(
    side + '_signup',
    who,
    '/auth/signup',
    'POST',
    {
      email: who.email,
      password: who.password,
      name: 'QA127B ' + side,
      organization: { name: 'QA127B Source external intent ' + side },
    },
    201,
  );
  const me = (await api(who, '/auth/me')).user;
  who.user = me.id;
  who.tenant = me.tenant_id;
  await save();
  assert.equal(me.role, 'admin');
  await mutate(side + '_plan', who, '/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  const choices = (await api(who, '/warehouses')).data;
  assert.equal(choices.length, 1);
  who.warehouse = choices[0].id;
  await save();
}
function sourceRaw(sku: string): Row {
  const raw: Row = structuredClone(demoShopifyOrder);
  const money = (amount: string) => ({ presentmentMoney: { amount, currencyCode: 'PLN' } });
  const first = structuredClone(raw.lineItems.nodes[0]);
  raw.id = 'gid://shopify/Order/12700021';
  raw.name = '#QA127B-SOURCE-42';
  raw.updatedAt = new Date().toISOString();
  raw.email = state.buyer.email;
  raw.shippingAddress.firstName = 'QA127B';
  raw.shippingAddress.lastName = 'Local Synthetic Customer';
  raw.shippingAddress.address1 = 'Źródłowa 127B';
  raw.lineItems.nodes = [
    {
      ...structuredClone(first),
      id: 'gid://shopify/LineItem/127000211',
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
      id: 'gid://shopify/LineItem/127000212',
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
async function setup() {
  assert(
    !state.setup_started && !state.setup_complete,
    'Never repeat partial setup; inspect its private pending receipt',
  );
  await health('110_b2b_external_order_imports', true);
  await previousExact();
  state.setup_started = true;
  state.completed = {};
  state.pending = null;
  await save();
  await signup('supplier');
  await signup('buyer');
  const supplier = state.supplier,
    buyer = state.buyer;
  const product = await mutate(
    'supplier_product',
    supplier,
    '/products',
    'POST',
    {
      sku: 'QA127B-SUPPLIER-A',
      name: 'QA127B supplier physical product',
      price: 700,
      vat: 23,
      quantity: 20,
      warehouse_id: supplier.warehouse,
    },
    201,
  );
  state.product = product.id;
  await save();
  const list = await mutate(
    'supplier_list',
    supplier,
    '/price-lists',
    'POST',
    { name: 'QA127B wholesale', currency: 'PLN' },
    201,
  );
  await mutate('supplier_prices', supplier, '/price-lists/' + list.id + '/items', 'PUT', {
    version: list.version,
    items: [{ product_id: product.id, price: 700 }],
  });
  const accountBody = {
    name: 'QA127B Buyer wholesale counterparty',
    email: buyer.email,
    warehouse_id: supplier.warehouse,
    price_list_id: list.id,
    address: { street: 'Sprzedawcy 127B', city: 'Warszawa', postal_code: '00-127', country: 'PL' },
    shipping_cost: 0,
    payment_mode: 'prepaid',
    min_total: 0,
    min_quantity: 1,
    quantity_step: 1,
  };
  let account = await mutate('account', supplier, '/b2b/accounts', 'POST', accountBody, 201);
  account = await mutate('account_enabled', supplier, '/b2b/accounts/' + account.id, 'PATCH', {
    ...accountBody,
    version: account.version,
    active: true,
    confirmed: true,
  });
  state.account = account.id;
  await save();
  const invitation = await mutate(
    'invitation',
    supplier,
    '/b2b/accounts/' + account.id + '/network-invite',
    'POST',
    { version: account.version, recipient_email: buyer.email, confirmed: true },
  );
  const link = await mutate('link', buyer, '/b2b/network/accept', 'POST', {
    token: invitation.token,
    confirmed: true,
  });
  state.link = link.id;
  await save();
  const base = '/b2b/network/links/' + link.id;
  const run = await mutate('catalog_refresh', buyer, base + '/refresh', 'POST', {
    client_key: randomUUID(),
    confirmed: true,
  });
  state.run = run.id;
  await save();
  let done = false;
  for (let n = 0; n < 60; n++) {
    const current = (await api(buyer, base + '/runs')).data.find((r: Row) => r.id === run.id);
    assert(current, 'Own catalog run missing');
    assert(!['failed', 'cancelled'].includes(current.state), 'Own catalog refresh failed');
    if (current.state === 'done') {
      done = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(done, 'Catalog worker did not complete; do not repeat refresh');
  const catalog = (await api(buyer, base + '/catalog')).data;
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].source_product_id, product.id);
  state.item = catalog[0].id;
  await save();
  const mapped = await mutate(
    'local_product',
    buyer,
    base + '/catalog/' + state.item + '/product',
    'POST',
    {
      version: catalog[0].version,
      sku: 'QA127B-RETAIL-A',
      sale_price: 29999,
      warehouse_id: buyer.warehouse,
      confirmed: true,
    },
  );
  state.local = mapped.product_id;
  await save();
  const example = await mutate(
    'shopify_simulation',
    buyer,
    '/integrations/shopify-example',
    'POST',
    {},
  );
  state.channel = example.channel_id;
  await save();
  await mutate('source_mapping', buyer, '/integrations/' + state.channel + '/mappings', 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku: 'QA127B-RETAIL-A',
  });
  state.raw = sourceRaw('QA127B-RETAIL-A');
  await save();
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
  state.source_hash = staged.data[0].source_hash;
  state.remote_line_ids = state.raw.lineItems.nodes.map((i: Row) => i.id);
  await save();
  return finalizeSetupReadback();
}
/** Recovery is only a pre-import readback of all16 already completed mutations. */
async function finalizeSetupReadback() {
  const keys = [
    'supplier_signup',
    'supplier_plan',
    'buyer_signup',
    'buyer_plan',
    'supplier_product',
    'supplier_list',
    'supplier_prices',
    'account',
    'account_enabled',
    'invitation',
    'link',
    'catalog_refresh',
    'local_product',
    'shopify_simulation',
    'source_mapping',
    'source_stage',
  ];
  assert(state.setup_started && !state.setup_complete && !state.pending);
  assert(
    !state.buyer_physical_baseline && !state.setup_checkpoint && !state.accepted_checkpoint,
    'Never rebase any original setup/acceptance checkpoint',
  );
  assert.deepEqual(Object.keys(state.completed).sort(), keys.sort());
  const buyer = state.buyer,
    supplier = state.supplier;
  for (const side of [buyer, supplier])
    assert(side.tenant && side.user && side.cookie && side.warehouse);
  for (const key of [
    'product',
    'local',
    'item',
    'link',
    'account',
    'channel',
    'inbound',
    'source_hash',
  ])
    assert(state[key]);
  assert.equal(state.completed.supplier_product.id, state.product);
  assert.equal(state.completed.local_product.product_id, state.local);
  assert.equal(state.completed.link.id, state.link);
  assert.equal(state.completed.account_enabled.id, state.account);
  assert.equal(state.completed.shopify_simulation.channel_id, state.channel);
  assert.equal(state.completed.source_stage.data.length, 1);
  assert.equal(state.completed.source_stage.data[0].id, state.inbound);
  await health('110_b2b_external_order_imports');
  await previousExact();
  const before = {
    buyer: await checkpoint(buyer.tenant, buyer.user),
    supplier: await checkpoint(supplier.tenant, supplier.user),
  };
  const me = (await api(buyer, '/auth/me')).user;
  assert.equal(me.id, buyer.user);
  assert.equal(me.tenant_id, buyer.tenant);
  assert.equal(me.role, 'admin');
  const source = (await api(buyer, '/imports/' + state.inbound + '/external-intent-source')).source;
  assert.equal(source.total, 4200);
  assert.equal(source.shipping_cost, 500);
  assert.equal(source.payment.paid_amount, 1000);
  assert.equal(source.lines.length, 2);
  assert.equal(source.source_hash, state.source_hash);
  assert.deepEqual(
    source.lines.map((i: Row) => [i.remote_line_id, i.quantity, i.price, i.line_total]),
    [
      [state.remote_line_ids[0], 2, 1000, 2000],
      [state.remote_line_ids[1], 1, 1700, 1700],
    ],
  );
  const own = await checkpoint(buyer.tenant, buyer.user);
  assert.equal(own.orders.count, 0);
  assert.equal(own.b2b_external_order_intents.count, 0);
  assert.equal(own.b2b_external_import_previews.count, 0);
  assert.equal(own.b2b_external_import_executions.count, 0);
  for (const name of physical)
    if (!['stock', 'stock_locations', 'stock_movements'].includes(name))
      assert.equal(own[name].count, 0, 'No buyer physical setup: ' + name);
  const initialMovements = (
    await pool.query(
      'SELECT product_id,warehouse_id,order_id,kind,delta FROM stock_movements WHERE tenant_id=$1',
      [buyer.tenant],
    )
  ).rows;
  assert.deepEqual(
    initialMovements,
    [
      {
        product_id: state.local,
        warehouse_id: buyer.warehouse,
        order_id: null,
        kind: 'initial',
        delta: 0,
      },
    ],
    'Product creation records exactly one zero initial movement',
  );
  const stocks = (
    await pool.query(
      'SELECT product_id,warehouse_id,on_hand,reserved FROM stock WHERE tenant_id=$1',
      [buyer.tenant],
    )
  ).rows;
  assert.equal(stocks.length, 1);
  assert(
    stocks.every(
      (r) =>
        r.product_id === state.local &&
        r.warehouse_id === buyer.warehouse &&
        Number(r.on_hand) === 0 &&
        Number(r.reserved) === 0,
    ),
  );
  const locations = (
    await pool.query(
      'SELECT product_id,warehouse_id,quantity FROM stock_locations WHERE tenant_id=$1',
      [buyer.tenant],
    )
  ).rows;
  assert(
    locations.every(
      (r) =>
        r.product_id === state.local &&
        r.warehouse_id === buyer.warehouse &&
        Number(r.quantity) === 0,
    ),
    'Natural zero-quantity own locations are allowed; no positive buyer bin',
  );
  const supplierStocks = (
    await pool.query(
      'SELECT product_id,warehouse_id,on_hand,reserved FROM stock WHERE tenant_id=$1',
      [supplier.tenant],
    )
  ).rows;
  assert.equal(supplierStocks.length, 1);
  assert(
    supplierStocks.every(
      (r) =>
        r.product_id === state.product &&
        r.warehouse_id === supplier.warehouse &&
        Number(r.on_hand) === 20 &&
        Number(r.reserved) === 0,
    ),
  );
  const [channel] = (
    await pool.query('SELECT provider,settings FROM channels WHERE tenant_id=$1 AND id=$2', [
      buyer.tenant,
      state.channel,
    ])
  ).rows;
  assert.equal(channel.provider, 'shopify');
  assert.equal(channel.settings.simulation, true);
  const [listing] = (
    await pool.query(
      'SELECT product_id,external_id FROM listings WHERE tenant_id=$1 AND channel_id=$2',
      [buyer.tenant, state.channel],
    )
  ).rows;
  assert.equal(listing.product_id, state.local);
  assert.equal(listing.external_id, 'gid://shopify/ProductVariant/701');
  const [inbound] = (
    await pool.query(
      'SELECT raw,source_hash,order_id,state FROM inbound_orders WHERE tenant_id=$1 AND id=$2',
      [buyer.tenant, state.inbound],
    )
  ).rows;
  assert.deepEqual(inbound.raw, state.raw);
  assert.equal(inbound.source_hash, state.source_hash);
  assert.equal(inbound.order_id, null);
  assert.equal(inbound.state, 'staged');
  const catalog = (await api(buyer, '/b2b/network/links/' + state.link + '/catalog')).data;
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, state.item);
  assert.equal(catalog[0].product_id, state.local);
  assert.equal(catalog[0].source_product_id, state.product);
  const local = await api(buyer, '/products/' + state.local);
  assert.equal(local.price, 29999);
  assert.equal(local.active, true);
  const current = {
    buyer: await checkpoint(buyer.tenant, buyer.user),
    supplier: await checkpoint(supplier.tenant, supplier.user),
  };
  assert.deepEqual(current, before, 'Adopting setup is read-only');
  state.buyer_physical_baseline = physicalOnly(own);
  state.setup_checkpoint = current;
  await previousExact();
  state.setup_complete = true;
  state.setup_completed_at = new Date().toISOString();
  await save();
  return {
    staged: true,
    import_executed: false,
    buyer_stock: 0,
    supplier_stock: 20,
    source_total_minor: 4200,
    source_paid_minor: 1000,
    buyer_pim_price_minor: 29999,
  };
}
async function verify() {
  assert(state.setup_complete && !state.pending, 'A complete setup is required');
  const acceptedBytes = state.accepted_checkpoint ? await privateBytes(file) : null;
  const currentHealth = await health('110_b2b_external_order_imports');
  await previousExact();
  const before = {
    buyer: await checkpoint(state.buyer.tenant, state.buyer.user),
    supplier: await checkpoint(state.supplier.tenant, state.supplier.user),
  };
  const me = (await api(state.buyer, '/auth/me')).user;
  assert.equal(me.id, state.buyer.user);
  assert.equal(me.tenant_id, state.buyer.tenant);
  assert.equal(me.role, 'admin');
  const c = await pool.connect();
  let facts: Row;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const rows = async (table: string, condition: string, args: unknown[]) => {
      assert.match(table, /^[a-z_][a-z0-9_]*$/);
      return (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${table}" t WHERE ${condition} ORDER BY 1`,
          args,
        )
      ).rows.map((r) => r.row);
    };
    const executions = await rows(
      'b2b_external_import_executions',
      'tenant_id=$1 AND inbound_id=$2',
      [state.buyer.tenant, state.inbound],
    );
    assert.equal(executions.length, 1);
    const e = executions[0];
    const [preview] = await rows('b2b_external_import_previews', 'tenant_id=$1 AND id=$2', [
      state.buyer.tenant,
      e.preview_id,
    ]);
    const [cert] = await rows('b2b_external_import_certificates', 'tenant_id=$1 AND id=$2', [
      state.buyer.tenant,
      e.certificate_id,
    ]);
    const [inbound] = await rows('inbound_orders', 'tenant_id=$1 AND id=$2', [
      state.buyer.tenant,
      state.inbound,
    ]);
    const [order] = await rows('orders', 'tenant_id=$1 AND id=$2', [
      state.buyer.tenant,
      e.order_id,
    ]);
    const [intent] = await rows('b2b_external_order_intents', 'tenant_id=$1 AND id=$2', [
      state.buyer.tenant,
      e.intent_id,
    ]);
    assert.equal(inbound.state, 'imported');
    assert.equal(inbound.order_id, order.id);
    assert.equal(inbound.imported_hash, state.source_hash);
    assert.equal(inbound.source_hash, state.source_hash);
    assert.deepEqual(inbound.raw, state.raw);
    assert.equal(order.source, 'shopify');
    assert.equal(order.channel_id, state.channel);
    assert.equal(order.total, 4200);
    assert.equal(order.currency, 'PLN');
    assert.equal(order.shipping_cost, 500);
    assert.equal(order.status, 'new');
    assert.deepEqual(order.address, preview.snapshot.canonical.address);
    assert.deepEqual(order.source_snapshot.items, preview.snapshot.canonical.items);
    assert.equal(preview.snapshot.canonical.paid_amount, 1000);
    assert.equal(preview.snapshot.canonical.total, 4200);
    assert.equal(cert.state, 'complete');
    assert.equal(cert.actual_order_id, order.id);
    assert.equal(cert.intent_id, intent.id);
    assert.equal(cert.preview_id, preview.id);
    assert.equal(cert.client_key, e.client_key);
    assert.equal(cert.actor_id, state.buyer.user);
    assert.equal(e.actor_id, state.buyer.user);
    assert.equal(intent.order_id, order.id);
    assert.equal(intent.version, 1);
    assert.equal(intent.state, 'open');
    const items = await rows('order_items', 'tenant_id=$1 AND order_id=$2', [
      state.buyer.tenant,
      order.id,
    ]);
    const bindings = await rows('order_source_lines', 'tenant_id=$1 AND source_order_id=$2', [
      state.buyer.tenant,
      order.id,
    ]);
    assert.equal(items.length, 2);
    assert.equal(bindings.length, 2);
    assert.equal(new Set(items.map((i) => i.id)).size, 2);
    for (const [index, quantity, price, total] of [
      [0, 2, 1000, 2000],
      [1, 1, 1700, 1700],
    ]) {
      const b = bindings.find((x) => x.remote_line_id === state.remote_line_ids[index]);
      assert(b);
      const item = items.find((x) => x.id === b.source_item_id);
      assert(item);
      assert.equal(b.inbound_id, state.inbound);
      assert.equal(b.channel_id, state.channel);
      assert.equal(b.source_hash, state.source_hash);
      assert.equal(b.product_id, state.local);
      assert.equal(b.quantity, quantity);
      assert.equal(b.line_total, total);
      assert.equal(item.product_id, state.local);
      assert.equal(item.quantity, quantity);
      assert.equal(item.price, price);
      assert.equal(item.line_total, total);
      assert.equal(item.vat, 23);
      assert.deepEqual(item.components, [{ product_id: state.local, quantity: 1 }]);
      const allocation = intent.allocations.find((a: Row) => a.customer_item_id === item.id);
      assert(allocation);
      assert.equal(allocation.local_quantity, 0);
      assert.equal(allocation.external_quantity, quantity);
      assert.equal(allocation.unassigned_quantity, 0);
      assert.equal(allocation.link_id, state.link);
      const frozen = preview.rows.find((r: Row) => r.customer_item_id === item.id);
      assert(frozen);
      assert.equal(frozen.remote_line_id, b.remote_line_id);
      assert.equal(frozen.line_total, total);
    }
    assert.deepEqual(cert.source_items, intent.original_items);
    const payments = await rows('payment_entries', 'tenant_id=$1 AND order_id=$2', [
      state.buyer.tenant,
      order.id,
    ]);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].kind, 'receipt');
    assert.equal(payments[0].method, 'source_import');
    assert.equal(payments[0].amount, 1000);
    const revisions = await rows(
      'b2b_external_order_intent_revisions',
      'tenant_id=$1 AND intent_id=$2',
      [state.buyer.tenant, intent.id],
    );
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].kind, 'create');
    const proofs = await rows(
      'b2b_external_order_allocation_proofs',
      'tenant_id=$1 AND order_id=$2',
      [state.buyer.tenant, order.id],
    );
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].applied, true);
    const supplierStocks = await rows('stock', 'tenant_id=$1 AND product_id=$2', [
      state.supplier.tenant,
      state.product,
    ]);
    assert.equal(supplierStocks.length, 1);
    assert.equal(supplierStocks[0].on_hand, 20);
    assert.equal(supplierStocks[0].reserved, 0);
    facts = {
      execution: e,
      preview,
      certificate: cert,
      intent,
      order,
      items,
      bindings,
      payments,
      revisions,
      proofs,
    };
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const p = (await api(state.buyer, '/import-external-intent-previews/' + facts.preview.id))
    .preview;
  assert.equal(p.executed_order_id, facts.order.id);
  assert.equal(p.intent_id, facts.intent.id);
  assert.equal(p.can_execute, false);
  const detail = await api(state.buyer, '/b2b/external-order-intents/orders/' + facts.order.id);
  assert.equal(detail.order.total, 4200);
  assert.equal(detail.order.payment.received, 1000);
  assert.equal(detail.order.payment.amount_due, 3200);
  assert.equal(detail.order.items.length, 2);
  assert.equal(detail.order.picking_items.length, 0);
  assert.equal(detail.intent.items.length, 2);
  const history = await api(
    state.buyer,
    '/import-external-intent-previews?inbound_id=' + state.inbound,
  );
  assert.equal(history.meta.total, 1);
  assert.equal(history.data[0].executed_order_id, facts.order.id);
  const after = {
    buyer: await checkpoint(state.buyer.tenant, state.buyer.user),
    supplier: await checkpoint(state.supplier.tenant, state.supplier.user),
  };
  assert.deepEqual(after, before, 'Report GET/SQL must have no business effects');
  assert.deepEqual(
    physicalOnly(after.buyer),
    state.buyer_physical_baseline,
    'Buyer physical19 remain exact',
  );
  assert.deepEqual(
    after.supplier,
    state.setup_checkpoint.supplier,
    'Import must not buy/issue/reserve supplier stock',
  );
  await previousExact();
  if (state.accepted_checkpoint)
    assert.deepEqual(after, state.accepted_checkpoint, 'Never rebase an accepted checkpoint');
  else {
    state.preview_id = facts.preview.id;
    state.execution_id = facts.execution.id;
    state.certificate_id = facts.certificate.id;
    state.order_id = facts.order.id;
    state.intent_id = facts.intent.id;
    state.accepted_checkpoint = after;
    state.accepted_facts_sha256 = digest(facts);
    state.accepted_at = new Date().toISOString();
    await save();
  }
  const report = {
    phase,
    status: 'PASS',
    revision: currentHealth.revision,
    baseline_revision: state.runtime_revision,
    schema_revision: state.schema_revision,
    source: 'local_simulated_Shopify_actual_source_import',
    source_total_minor: 4200,
    historical_prices_minor: [1000, 1700],
    source_paid_minor: 1000,
    retail_due_minor: 3200,
    supplier_stock: 20,
    buyer_physical_tables: physical.length,
    bindings: 2,
    commercial_items: 2,
    complete_certificates: 1,
    prior_firms: state.previous.length,
    accepted_tables: {
      buyer: Object.keys(after.buyer).length,
      supplier: Object.keys(after.supplier).length,
    },
    accepted_checkpoint_sha256: digest(after),
    private_credentials_published: false,
    full_goal_complete: false,
  };
  if (acceptedBytes)
    assert.deepEqual(
      await privateBytes(file),
      acceptedBytes,
      'Never rewrite the accepted private fixture',
    );
  const reportFile = process.env.QA_REPORT_FILE ?? 'docs/source-order-intent-native-qa.json';
  assert.match(reportFile, /^docs\/source-order-intent-[a-z0-9-]+\.json$/);
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  return report;
}
try {
  if (phase === 'baseline') {
    const h = await health('109_b2b_external_order_intents');
    const previous: Row[] = [];
    for (const original of originals) {
      const bytes = await privateBytes(original),
        accepted = JSON.parse(bytes.toString());
      const firms =
        accepted.buyer && accepted.supplier ? [accepted.buyer, accepted.supplier] : [accepted];
      for (const firm of firms) {
        assert(firm.tenant && firm.user);
        previous.push({
          path: original,
          fixture_sha256: bytesHash(bytes),
          tenant: firm.tenant,
          user: firm.user,
          checkpoint: await checkpoint(firm.tenant, firm.user),
        });
      }
    }
    assert.equal(previous.length, 6);
    assert.equal(new Set(previous.map((f) => f.tenant)).size, 6);
    state = {
      phase: 'baseline',
      previous,
      original_runtime_revision: h.revision,
      baseline_at: new Date().toISOString(),
    };
    await writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(
      JSON.stringify({
        phase,
        status: 'PASS',
        prior_firms: previous.length,
        original_fixtures: originals.length,
        mutations: 0,
      }),
    );
  } else {
    state = JSON.parse((await privateBytes(file)).toString());
    const result =
      phase === 'setup'
        ? await setup()
        : phase === 'adopt-setup'
          ? await finalizeSetupReadback()
          : await verify();
    console.log(JSON.stringify({ phase, status: 'PASS', ...result }));
  }
} catch (e) {
  const diagnostic = `data/source-order-intent-native-failure-${phase}-${randomUUID()}.txt`;
  await writeFile(diagnostic, e instanceof Error ? (e.stack ?? e.message) : String(e), {
    mode: 0o600,
    flag: 'wx',
  });
  console.error('QA127B FAIL; private diagnostic: ' + diagnostic);
  process.exitCode = 1;
} finally {
  await pool.end();
}
