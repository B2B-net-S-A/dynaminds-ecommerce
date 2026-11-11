/** Root-run own QA140 fixture only. API writes only; never approves an exchange; source bundle A/B and different target bundle C/D.
 * Existing state, unresolved outcome or unexpected response prohibit replay/resume.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const privatePath = resolve(root, 'data/return-exchange-substitutions-stage140.json');
const reportPath = resolve(root, 'docs/return-exchange-substitutions-native-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = process.env.QA_EXPECTED_SCHEMA ?? '123_return_exchange_substitutions';
assert.match(revision, /^[a-f0-9]{40}$/);
assert.equal(process.env.DYNA_TEST === 'true', false);
assert.equal(
  schema,
  '123_return_exchange_substitutions',
  'QA140 requires the reviewed substitution schema',
);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const encode = (v) => JSON.stringify(v, null, 2) + '\n';
const uuid = (v) => (assert.match(v ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i), v);
async function absent(path) {
  try {
    await lstat(path);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw new Error('Cannot inspect owned output');
  }
  throw new Error('QA140 output exists; do not resume or overwrite');
}
async function atomic(path, value) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(encode(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
await absent(privatePath);
await absent(reportPath);
async function received(response) {
  const text = await response.text();
  assert(Buffer.byteLength(text, 'utf8') <= 5 * 1024 * 1024, 'Response exceeds bound');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Unexpected JSON response; contents withheld');
  }
}
const healthResponse = await fetch(base + '/health', {
  signal: AbortSignal.timeout(10000),
  redirect: 'error',
});
assert.equal(healthResponse.status, 200);
const health = await received(healthResponse);
assert.equal(health.status, 'ok');
assert.equal(health.mode, 'local');
assert.equal(health.database, 'postgresql');
assert.equal(health.revision, revision);
assert.equal(health.schema_revision, schema);
assert.equal(health.return_exchanges_available, true);
assert.equal(health.wms_lots_available, true);
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const suffix = randomUUID().slice(0, 8);
const state = {
  stage: 140,
  stage140: true,
  runtime_revision: revision,
  schema_revision: schema,
  setup_complete: false,
  phase: 'READY_TO_SIGNUP',
  organization: `QA140 WMS Warranty DEMO ${suffix}`,
  email: `qa-warranty-wms-140-${suffix}@demo.local`,
  password: `DynaWarranty!140-${randomUUID()}`,
  cookie: '',
  tenant_id: '',
  user_id: '',
  main_warehouse_id: '',
  replacement_warehouse_id: '',
  components: [],
  target_components: [],
  bundle_id: '',
  replacement_bundle_id: '',
  empty_product_id: '',
  order_id: '',
  customer_item_id: '',
  return_id: '',
  supplier_id: '',
  billing_preview: null,
  billing_result: null,
  opening: null,
  purchases: [],
  pending: null,
  completed: [],
  source_born: null,
  exchange_draft: null,
};
await writeFile(privatePath, encode(state), { flag: 'wx', mode: 0o600 });
await writeFile(reportPath, encode({ stage: 140, status: 'PREPARING_OWN_WMS_FIXTURE' }), {
  flag: 'wx',
  mode: 0o600,
});
const save = () => atomic(privatePath, state);
async function report() {
  await atomic(reportPath, {
    stage: 140,
    status: state.setup_complete ? 'OWN_WMS_SETUP_READY_FOR_CHROME' : state.phase,
    runtime_revision: revision,
    schema_revision: schema,
    tenant_id: state.tenant_id || null,
    user_id: state.user_id || null,
    main_warehouse_id: state.main_warehouse_id || null,
    replacement_warehouse_id: state.replacement_warehouse_id || null,
    bundle_id: state.bundle_id || null,
    order_id: state.order_id || null,
    return_id: state.return_id || null,
    replacement_bundle_id: state.replacement_bundle_id || null,
    empty_product_id: state.empty_product_id || null,
    target_components: state.target_components.map(
      ({ id, sku, recipe_quantity, unit_cost_minor }) => ({
        id,
        sku,
        recipe_quantity,
        unit_cost_minor,
      }),
    ),
    components: state.components.map(({ id, sku, recipe_quantity, unit_cost_minor }) => ({
      id,
      sku,
      recipe_quantity,
      unit_cost_minor,
    })),
    successful_mutations: state.completed.length,
    mutations: state.completed,
    unresolved_write: state.pending !== null,
    private_setup_sha256: hash(await readFile(privatePath)),
    original_bundle_quantity: 2,
    requested_bundle_quantity: 1,
    bundle_price_gross_minor: 10000,
    original_total_gross_minor: 20000,
    original_issue_known_net_minor: 4000,
    setup_remaining_known_net_minor: state.setup_complete ? 25000 : null,
    replacement_issue_expected_net_minor: 12500,
    replacement_catalog_price_gross_minor: 25000,
    replacement_vat: 8,
    local_entitlement: 'local_estimate enterprise activation only; no external billing call',
    monetary_provenance: 'Synthetic prepaid local ledger declaration; no bank call',
    warehouse_provenance: 'Genuine PO/PZ and WMS FIFO issue; DEMO shipment',
    exchange_created: false,
    chrome_verified: false,
    provider_verified: false,
    full_goal_complete: false,
  });
}
const headers = (extra = {}) => ({
  'content-type': 'application/json',
  ...(state.cookie ? { cookie: state.cookie } : {}),
  ...(state.tenant_id ? { 'X-Workspace-ID': state.tenant_id } : {}),
  ...extra,
});
async function get(route) {
  assert(route.startsWith('/') && !route.includes('..'));
  const response = await fetch(base + route, {
    headers: headers(),
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  assert.equal(response.status, 200, 'Own read-only HTTP status');
  return received(response);
}
function allowed(method, route) {
  if (!['POST', 'PATCH'].includes(method)) return false;
  if (
    [
      '/auth/signup',
      '/workspaces/billing/preview',
      '/warehouses',
      '/products',
      '/suppliers',
      '/purchase-orders',
      '/wms-lots/opening-previews',
      '/orders',
    ].includes(route)
  )
    return true;
  if (
    state.billing_preview &&
    route === `/workspaces/billing/previews/${state.billing_preview.id}/commit`
  )
    return true;
  if (state.opening && route === `/wms-lots/opening-previews/${state.opening.id}/activate`)
    return true;
  if (
    state.purchases.some((p) =>
      ['/place', '/receive'].some((end) => route === `/purchase-orders/${p.id}${end}`),
    )
  )
    return true;
  return Boolean(
    state.order_id &&
    ['/payments', '/status', '/scan', '/ship-demo', '/documents', '/returns'].some(
      (end) => route === `/orders/${state.order_id}${end}`,
    ),
  );
}
async function mutate(step, method, route, body, status, assign = () => {}, extra = {}) {
  assert.equal(state.pending, null, 'Unresolved mutation blocks all further writes');
  assert(allowed(method, route), 'Unsupported own fixture operation');
  if (route !== '/auth/signup') {
    const me = await get('/auth/me');
    assert.equal(me.user.id, state.user_id);
    assert.equal(me.user.tenant_id, state.tenant_id);
    assert.equal(me.user.role, 'admin');
  }
  state.pending = { step, method, route, body, extra_headers: extra, expected_status: status };
  state.phase = 'PENDING_WRITE';
  await save();
  let response, data;
  try {
    response = await fetch(base + route, {
      method,
      headers: headers(extra),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
    data = await received(response);
  } catch {
    state.phase = 'UNKNOWN_RESULT_DO_NOT_RETRY';
    await save();
    await report();
    throw new Error('Unknown fixture write outcome; never retry automatically');
  }
  state.pending.response = { status: response.status, data };
  await save();
  assert.equal(response.status, status, 'Unexpected write response; retain custody and stop');
  // Assign and persist IDs while the fully received request is still pending.
  // Validation failure keeps that pending receipt for explicit owner inspection.
  const receipt = { step, method, route, status: response.status, id: data.id ?? null };
  assign(data, response, receipt);
  await save();
  state.completed.push(receipt);
  state.pending = null;
  state.phase = 'CONFIRMED';
  await save();
  await report();
  return data;
}
async function pages(route, maximum) {
  const data = [];
  let cursor = null;
  const seen = new Set();
  do {
    const q = cursor
      ? (route.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor)
      : '';
    const reply = await get(route + q);
    assert(Array.isArray(reply.data));
    data.push(...reply.data);
    assert(data.length <= maximum, 'Unexpected fixture page scope');
    cursor = reply.meta?.cursor ?? null;
    if (cursor) {
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
  } while (cursor);
  return data;
}
async function versions(warehouse_id, components = state.components) {
  const result = [];
  for (const component of components) {
    const product = await get('/products/' + component.id);
    const stock = product.stock.find((s) => s.warehouse_id === warehouse_id);
    result.push({ warehouse_id, product_id: component.id, version: String(stock?.version ?? '0') });
  }
  return result.sort((a, b) => a.product_id.localeCompare(b.product_id));
}
try {
  await mutate(
    'signup',
    'POST',
    '/auth/signup',
    {
      name: 'QA140 WMS Warranty DEMO',
      email: state.email,
      password: state.password,
      organization: { name: state.organization, currency: 'PLN', locale: 'pl-PL' },
    },
    201,
    (data, response, receipt) => {
      state.cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
      assert(state.cookie.startsWith('dyna_session='));
      state.tenant_id = uuid(data.user?.tenant_id);
      state.user_id = uuid(data.user?.id);
      receipt.id = state.tenant_id;
    },
  );
  const warehouses = await get('/warehouses');
  assert.equal(warehouses.data.length, 1);
  state.main_warehouse_id = uuid(warehouses.data[0].id);
  await save();
  const billing = await get('/workspaces/billing');
  assert.equal(billing.mode, 'local_estimate');
  assert.equal(billing.admin, true);
  assert.equal(billing.account, null);
  assert.equal(billing.current_plan, 'starter');
  assert.equal(billing.entries.length, 0);
  assert(billing.plans.some((p) => p.plan === 'enterprise' && p.limits.warehouses >= 2));
  await mutate(
    'local-enterprise-preview',
    'POST',
    '/workspaces/billing/preview',
    { kind: 'activate', plan: 'enterprise' },
    200,
    (p) => {
      assert.equal(p.mode, 'local_estimate');
      assert.equal(p.actor_id, state.user_id);
      assert.equal(p.tenant_id, state.tenant_id);
      assert.equal(p.terms.plan, 'enterprise');
      assert.equal(p.can_commit, true);
      assert.deepEqual(p.blockers, []);
      uuid(p.id);
      state.billing_preview = p;
    },
  );
  await mutate(
    'local-enterprise-commit',
    'POST',
    `/workspaces/billing/previews/${state.billing_preview.id}/commit`,
    {},
    200,
    (r) => {
      assert.equal(r.mode, 'local_estimate');
      assert.equal(r.plan, 'enterprise');
      state.billing_result = r;
    },
  );
  assert.equal((await get('/workspaces/billing')).current_plan, 'enterprise');
  await mutate(
    'replacement-warehouse',
    'POST',
    '/warehouses',
    { name: 'QA140 Replacement SECOND', code: 'QA140-SECOND' },
    200,
    (w) => {
      state.replacement_warehouse_id = uuid(w.id);
    },
  );
  for (const [letter, recipe_quantity, unit_cost_minor] of [
    ['A', 1, 0],
    ['B', 2, 1000],
  ]) {
    const sku = `QA140-${letter}-${suffix}`;
    await mutate(
      'component-' + letter,
      'POST',
      '/products',
      {
        name: `QA140 Component ${letter}`,
        sku,
        kind: 'simple',
        price: 1000,
        vat: 23,
        warehouse_id: state.main_warehouse_id,
        quantity: 0,
        location: 'MAIN-01',
      },
      201,
      (p) => {
        state.components.push({ id: uuid(p.id), sku, recipe_quantity, unit_cost_minor });
      },
    );
  }
  await mutate(
    'bundle',
    'POST',
    '/products',
    {
      name: 'QA140 WMS Warranty Bundle',
      sku: `QA140-BUNDLE-${suffix}`,
      kind: 'bundle',
      price: 10000,
      vat: 23,
      warehouse_id: state.main_warehouse_id,
      quantity: 0,
      location: 'MAIN-01',
      components: state.components.map((c) => ({ product_id: c.id, quantity: c.recipe_quantity })),
    },
    201,
    (p) => {
      state.bundle_id = uuid(p.id);
    },
  );
  for (const [letter, recipe_quantity, unit_cost_minor] of [
    ['C', 1, 2500],
    ['D', 2, 5000],
  ]) {
    const sku = `QA140-${letter}-${suffix}`;
    await mutate(
      'target-component-' + letter,
      'POST',
      '/products',
      {
        name: `QA140 Target Component ${letter}`,
        sku,
        kind: 'simple',
        price: 3000,
        vat: 8,
        warehouse_id: state.replacement_warehouse_id,
        quantity: 0,
        location: 'SECOND-01',
      },
      201,
      (p) => {
        state.target_components.push({ id: uuid(p.id), sku, recipe_quantity, unit_cost_minor });
      },
    );
  }
  await mutate(
    'target-bundle',
    'POST',
    '/products',
    {
      name: 'QA140 DIFFERENT Replacement Bundle',
      sku: `QA140-TARGET-BUNDLE-${suffix}`,
      kind: 'bundle',
      price: 25000,
      vat: 8,
      warehouse_id: state.replacement_warehouse_id,
      quantity: 0,
      location: 'SECOND-01',
      components: state.target_components.map((c) => ({
        product_id: c.id,
        quantity: c.recipe_quantity,
      })),
    },
    201,
    (p) => {
      state.replacement_bundle_id = uuid(p.id);
    },
  );
  await mutate(
    'empty-target',
    'POST',
    '/products',
    {
      name: 'QA140 EMPTY Replacement',
      sku: `QA140-EMPTY-${suffix}`,
      kind: 'simple',
      price: 1000,
      vat: 23,
      warehouse_id: state.replacement_warehouse_id,
      quantity: 0,
      location: 'SECOND-01',
    },
    201,
    (p) => {
      state.empty_product_id = uuid(p.id);
    },
  );
  await mutate(
    'empty-wms-opening',
    'POST',
    '/wms-lots/opening-previews',
    {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'QA140 genuine empty FIFO opening before PO/PZ',
      lines: [],
    },
    201,
    (r) => {
      assert.equal(r.preview.ready, true);
      uuid(r.preview.id);
      state.opening = r.preview;
    },
  );
  await mutate(
    'activate-wms',
    'POST',
    `/wms-lots/opening-previews/${state.opening.id}/activate`,
    {
      client_key: randomUUID(),
      scope_hash: state.opening.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    201,
  );
  const meta = await get('/wms-lots');
  assert.equal(meta.policy.enabled, true);
  assert.equal(meta.policy.currency, 'PLN');
  await mutate(
    'synthetic-supplier',
    'POST',
    '/suppliers',
    { name: 'QA140 Synthetic PO Supplier', code: 'QA140-' + suffix },
    201,
    (s) => {
      state.supplier_id = uuid(s.id);
    },
  );
  for (const [warehouse_id, location, label, components] of [
    [state.main_warehouse_id, 'MAIN-01', 'MAIN', state.components],
    [state.replacement_warehouse_id, 'SECOND-01', 'SECOND', state.target_components],
  ]) {
    const lines = components.map((c) => ({
      product_id: c.id,
      quantity: c.recipe_quantity * 2,
      unit_cost: c.unit_cost_minor,
    }));
    await mutate(
      label + '-po',
      'POST',
      '/purchase-orders',
      {
        supplier_id: state.supplier_id,
        warehouse_id,
        currency: 'PLN',
        reference: `QA140 ${label} known NET costs`,
        lines,
      },
      201,
      (p) => {
        state.purchases.push({ id: uuid(p.id), warehouse_id, location, version: p.version });
      },
    );
    const purchase = state.purchases.at(-1);
    await mutate(
      label + '-place',
      'POST',
      `/purchase-orders/${purchase.id}/place`,
      { version: purchase.version },
      200,
      (p) => {
        assert.equal(p.state, 'ordered');
        purchase.version = p.version;
      },
    );
    await mutate(
      label + '-genuine-pz',
      'POST',
      `/purchase-orders/${purchase.id}/receive`,
      {
        client_key: randomUUID(),
        version: purchase.version,
        reference: `QA140 ${label} PZ`,
        note: 'Known net costs from approved own purchase order',
        lines: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, location })),
        wms_lots: {
          policy_version: String(meta.policy.version),
          stock_versions: await versions(warehouse_id, components),
          lines: lines.map((l, i) => ({
            product_id: l.product_id,
            quantity: l.quantity,
            location,
            lot_code: `QA140-${label}-${i}-${suffix}`,
          })),
        },
      },
      200,
      (r) => {
        assert.equal(r.order.state, 'received');
        purchase.receipt_id = uuid(r.receipt_id);
        purchase.receipt = r;
        purchase.version = r.order.version;
      },
    );
  }
  const purchasedValue = await get('/wms-lots/valuation');
  assert.equal(purchasedValue.valuation.known_minor, '29000');
  assert.equal(purchasedValue.valuation.unknown_quantity, '0');
  const purchasedPositions = await pages('/wms-lots/positions', 4);
  assert.equal(purchasedPositions.length, 4);
  for (const [components, wh] of [
    [state.components, state.main_warehouse_id],
    [state.target_components, state.replacement_warehouse_id],
  ])
    for (const c of components) {
      const ps = purchasedPositions.filter((p) => p.product_id === c.id && p.warehouse_id === wh);
      assert.equal(ps.length, 1);
      assert.equal(ps[0].quantity, c.recipe_quantity * 2);
      assert.equal(ps[0].unit_cost_minor, String(c.unit_cost_minor));
      assert.equal(ps[0].currency, 'PLN');
    }
  await mutate(
    'original-bundle-sale',
    'POST',
    '/orders',
    {
      source: 'manual',
      customer_name: 'QA140 DEMO Warranty Customer',
      email: `qa140-customer-${suffix}@demo.local`,
      currency: 'PLN',
      payment_mode: 'prepaid',
      warehouse_id: state.main_warehouse_id,
      address: {
        street: 'Testowa 140',
        city: 'Warszawa',
        postal_code: '00-140',
        country: 'PL',
        phone: '500000140',
      },
      shipping_cost: 0,
      items: [{ product_id: state.bundle_id, quantity: 2 }],
      note: 'QA140 own bundle WMS warranty fixture; no provider calls',
    },
    201,
    (o) => {
      state.order_id = uuid(o.id);
    },
    { 'Idempotency-Key': randomUUID() },
  );
  let order = await get('/orders/' + state.order_id);
  assert.equal(order.items.length, 1);
  state.customer_item_id = uuid(order.items[0].id);
  await save();
  assert.equal(order.items[0].price, 10000);
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.items[0].vat, 23);
  assert.equal(order.total, 20000);
  const paymentKey = randomUUID();
  await mutate(
    'synthetic-paid-declaration',
    'POST',
    `/orders/${state.order_id}/payments`,
    {
      client_key: paymentKey,
      version: Number(order.version),
      kind: 'receipt',
      amount: 20000,
      currency: 'PLN',
      method: 'other',
      reference: 'QA140 synthetic local declaration',
      note: 'Synthetic ledger entry only, no bank transfer',
      confirmed: true,
    },
    200,
    (r, _response, receipt) => {
      assert.equal(r.data.length, 1);
      assert.equal(r.data[0].client_key, paymentKey);
      assert.equal(r.data[0].amount, 20000);
      receipt.id = uuid(r.data[0].id);
    },
  );
  await mutate(
    'start-picking',
    'PATCH',
    `/orders/${state.order_id}/status`,
    { status: 'picking' },
    200,
  );
  const allocations = await pages(`/wms-lots/orders/${state.order_id}/allocations`, 2);
  assert.equal(allocations.length, 2);
  for (const allocation of allocations) {
    const c = state.components.find((c) => c.id === allocation.product_id);
    assert(c);
    assert.equal(allocation.quantity, c.recipe_quantity * 2);
    assert.equal(allocation.warehouse_id, state.main_warehouse_id);
    assert.equal(allocation.location, 'MAIN-01');
    uuid(allocation.layer_id);
    for (let n = 1; n <= allocation.quantity; n++)
      await mutate(
        `scan-${c.sku}-${n}`,
        'POST',
        `/orders/${state.order_id}/scan`,
        {
          client_key: randomUUID(),
          code: c.sku,
          location: allocation.location,
          layer_id: allocation.layer_id,
        },
        200,
      );
  }
  await mutate('pack', 'PATCH', `/orders/${state.order_id}/status`, { status: 'packed' }, 200);
  await mutate('genuine-demo-issue', 'POST', `/orders/${state.order_id}/ship-demo`, {}, 200);
  let invoice;
  await mutate(
    'demo-invoice',
    'POST',
    `/orders/${state.order_id}/documents`,
    { kind: 'invoice' },
    200,
    (v) => {
      uuid(v.id);
      assert.equal(v.mode, 'demo');
      invoice = v;
    },
  );
  await mutate(
    'complaint-request',
    'POST',
    `/orders/${state.order_id}/returns`,
    {
      client_key: randomUUID(),
      kind: 'complaint',
      reason: 'QA140 one frozen source bundle returned for DIFFERENT-product replacement',
      warehouse_id: state.main_warehouse_id,
      shipping_refund: 0,
      items: [{ item_id: state.customer_item_id, quantity: 1 }],
    },
    201,
    (r) => {
      state.return_id = uuid(r.id);
    },
  );
  order = await get('/orders/' + state.order_id);
  const rma = await get('/returns/' + state.return_id);
  assert.equal(order.status, 'shipped');
  assert.equal(order.shipments.length, 1);
  assert.equal(order.shipments[0].mode, 'demo');
  assert(order.shipments[0].dispatched_at);
  assert.equal(order.payment.received, 20000);
  assert.equal(order.documents.length, 1);
  assert.equal(rma.state, 'requested');
  assert.equal(rma.kind, 'complaint');
  assert.equal(rma.items.length, 1);
  assert.equal(rma.items[0].requested, 1);
  assert.equal(rma.items[0].accepted, 0);
  assert.equal(rma.exchange, null);
  assert.equal(rma.substitution_available, true);
  const fragments = await pages(`/wms-lots/orders/${state.order_id}/return-fragments`, 2);
  assert.equal(fragments.length, 2);
  assert.equal(
    fragments.reduce((v, f) => v + BigInt(f.value_minor), 0n),
    4000n,
  );
  for (const c of state.components) {
    const f = fragments.filter((f) => f.product_id === c.id);
    assert.equal(f.length, 1);
    assert.equal(f[0].quantity, c.recipe_quantity * 2);
    assert.equal(f[0].remaining, c.recipe_quantity * 2);
    assert.equal(f[0].warehouse_id, state.main_warehouse_id);
  }
  const products = [];
  for (const c of [...state.components, ...state.target_components]) {
    const p = await get('/products/' + c.id);
    products.push(p);
    assert.equal(p.stock.find((s) => s.warehouse_id === state.main_warehouse_id)?.on_hand ?? 0, 0);
    assert.equal(
      p.stock.find((s) => s.warehouse_id === state.replacement_warehouse_id)?.on_hand ?? 0,
      state.target_components.includes(c) ? c.recipe_quantity * 2 : 0,
    );
    assert(p.stock.every((s) => s.reserved === 0));
  }
  const positions = await pages('/wms-lots/positions', 4);
  const valuation = await get('/wms-lots/valuation');
  assert.equal(valuation.valuation.known_minor, '25000');
  assert.equal(valuation.valuation.unknown_quantity, '0');
  state.source_born = {
    products,
    bundle: await get('/products/' + state.bundle_id),
    replacement_bundle: await get('/products/' + state.replacement_bundle_id),
    order,
    return: rma,
    invoice,
    positions,
    valuation,
    return_fragments: fragments,
    allocations,
    policy: (await get('/wms-lots')).policy,
    purchased_positions: purchasedPositions,
    purchased_valuation: purchasedValue,
  };
  state.exchange_draft = {
    version: Number(rma.version),
    warehouse_id: state.replacement_warehouse_id,
    note: 'QA140 restore original MAIN A/B fragments and replace with DIFFERENT C/D bundle from SECOND',
    items: [
      {
        item_id: state.customer_item_id,
        accepted: 1,
        restocked: 1,
        replacement_product_id: state.replacement_bundle_id,
      },
    ],
    wms_lots: {
      client_key: randomUUID(),
      policy_version: String(meta.policy.version),
      stock_versions: await versions(state.main_warehouse_id),
      picks: fragments.map((f) => ({
        issue_fragment_id: f.id,
        quantity: state.components.find((c) => c.id === f.product_id).recipe_quantity,
        location: 'MAIN-RETURN',
      })),
    },
  };
  state.setup_complete = true;
  state.phase = 'READY_FOR_CHROME_WMS_EXCHANGE';
  await save();
  await report();
  console.log(
    'QA140 own WMS bundle setup ready; different original A/B and target C/D recipes, NET costs0/1000 and2500/5000, two warehouses, genuine original issue; exchange not created.',
  );
} catch {
  if (state.phase !== 'UNKNOWN_RESULT_DO_NOT_RETRY')
    state.phase = 'STOPPED_RETAIN_PENDING_DO_NOT_RETRY';
  await save();
  await report();
  process.exitCode = 1;
  console.error(
    'QA140 setup stopped; preserve private custody, no automatic retry/resume. Details withheld.',
  );
}
