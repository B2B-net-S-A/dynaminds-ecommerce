/** Own QA138 fixture preparation only. Run deliberately after native schema120 startup.
 * No replacement, exchange approval, retry, database connection or provider write.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.env.QA_STATE_ROOT ?? '<workspace>/app');
assert.equal(root, '<workspace>/app');
const base = 'http://127.0.0.1:4100/api';
const privatePath = resolve(root, 'data/return-exchanges-stage138.json');
const reportPath = resolve(root, 'docs/return-exchanges-native-setup.json');
const expectedRevision = process.env.QA_EXPECTED_REVISION ?? '';
assert.match(expectedRevision, /^[a-f0-9]{40}$/);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const id = (value) => (assert.match(value ?? '', uuid), value);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function ensureAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Cannot inspect QA138 output path');
  }
  throw new Error('QA138 output already exists; no rerun or overwrite permitted');
}
await ensureAbsent(privatePath);
await ensureAbsent(reportPath);
async function jsonResponse(response) {
  const text = await response.text();
  assert(Buffer.byteLength(text, 'utf8') <= 4 * 1024 * 1024, 'Response exceeds setup bound');
  return JSON.parse(text);
}
const healthResponse = await fetch(base + '/health', { signal: AbortSignal.timeout(10000) });
assert.equal(healthResponse.status, 200);
const health = await jsonResponse(healthResponse);
assert.equal(health.status, 'ok');
assert.equal(health.mode, 'local');
assert.equal(health.database, 'postgresql');
assert.equal(health.revision, expectedRevision);
assert.equal(health.schema_revision, '120_return_exchanges');
assert.equal(health.return_exchanges_available, true);
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);

const suffix = randomUUID().slice(0, 8);
const state = {
  stage: 138,
  stage138: true,
  runtime_revision: health.revision,
  schema_revision: health.schema_revision,
  setup_complete: false,
  phase: 'READY_TO_SIGNUP',
  organization: `QA138 Warranty DEMO ${suffix}`,
  email: `qa-warranty-138-${suffix}@demo.local`,
  password: `DynaWarranty!138-${randomUUID()}`,
  cookie: '',
  tenant_id: '',
  user_id: '',
  warehouse_id: '',
  product_id: '',
  order_id: '',
  customer_item_id: '',
  return_id: '',
  pending: null,
  completed: [],
  rejected: [],
  born: null,
};
const encode = (value) => JSON.stringify(value, null, 2) + '\n';
await writeFile(privatePath, encode(state), { flag: 'wx', mode: 0o600 });
assert.equal((await lstat(privatePath)).mode & 0o777, 0o600);
await writeFile(reportPath, encode({ stage: 138, status: 'PREPARING_OWN_DEMO_FIXTURE' }), {
  flag: 'wx', mode: 0o600,
});
const save = () => writeFile(privatePath, encode(state), { mode: 0o600 });
async function report() {
  await writeFile(reportPath, encode({
    stage: 138,
    status: state.setup_complete ? 'OWN_SETUP_ONLY_READY_FOR_CHROME' : state.phase,
    runtime_revision: state.runtime_revision,
    schema_revision: state.schema_revision,
    organization: state.organization,
    tenant_id: state.tenant_id || null,
    user_id: state.user_id || null,
    warehouse_id: state.warehouse_id || null,
    product_id: state.product_id || null,
    order_id: state.order_id || null,
    customer_item_id: state.customer_item_id || null,
    return_id: state.return_id || null,
    successful_mutations: state.completed.length,
    mutations: state.completed,
    rejected_responses: state.rejected,
    unresolved_write: state.pending !== null,
    setup_complete: state.setup_complete,
    born: state.born ? {
      product_quantity: 3,
      product_reserved: 0,
      original_quantity: 3,
      original_price_minor: 10000,
      original_total_minor: 30000,
      payment_received_minor: state.born.order.payment.received,
      payment_due_minor: state.born.order.payment.amount_due,
      requested_return_quantity: 1,
      return_state: state.born.return.state,
      order_status: state.born.order.status,
      shipment_ids: state.born.order.shipments.map((s) => s.id),
      invoice_id: state.born.invoice.id,
      invoice_mode: state.born.invoice.mode,
    } : null,
    private_ledger_mode: '0600',
    private_ledger_sha256: hash(await readFile(privatePath)),
    payment_provenance: 'Synthetic local receipt declaration, method other; no bank or charge',
    shipment_provenance: 'Genuine local inventory issue via ship-demo; no carrier verification',
    invoice_provenance: 'DEMO invoice; no tax-provider submission',
    exchange_created: false,
    chrome_verified: false,
    provider_verified: false,
    full_goal_complete: false,
  }), { mode: 0o600 });
}
function headers(extra = {}) {
  return {
    'content-type': 'application/json',
    ...(state.cookie ? { cookie: state.cookie } : {}),
    ...(state.tenant_id ? { 'X-Workspace-ID': state.tenant_id } : {}),
    ...extra,
  };
}
async function get(route) {
  assert(route.startsWith('/') && !route.includes('..'));
  const response = await fetch(base + route, { headers: headers(), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, 'QA138 read status ' + response.status);
  return jsonResponse(response);
}
async function mutate(step, method, route, body, expectedStatus, assign = () => {}, extra = {}) {
  assert.equal(state.pending, null, 'Unresolved write prohibits any further mutation');
  const allowed = route === '/auth/signup' || route === '/products' || route === '/orders' ||
    (state.order_id && [
      '/payments', '/status', '/scan', '/ship-demo', '/documents', '/returns',
    ].some((ending) => route === '/orders/' + state.order_id + ending));
  assert(allowed && ['POST', 'PATCH'].includes(method), 'Unsupported QA138 mutation');
  state.pending = { step, method, route, body, extra_headers: extra, expected_status: expectedStatus };
  state.phase = 'PENDING_WRITE';
  await save();
  let response, data;
  try {
    response = await fetch(base + route, {
      method, headers: headers(extra), body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    data = await jsonResponse(response);
  } catch {
    state.phase = 'UNKNOWN_RESULT_DO_NOT_RETRY';
    await save();
    await report();
    throw new Error('QA138 write outcome unknown; inspect private ledger, never automatically retry');
  }
  // Persist a fully received outcome before assertions. A wrong success DTO is not retried.
  state.pending.response = { status: response.status, data };
  await save();
  if (response.status !== expectedStatus) {
    state.rejected.push({ step, method, route, status: response.status });
    state.pending = null;
    state.phase = 'UNEXPECTED_RESPONSE_STOP';
    await save();
    await report();
    throw new Error('QA138 unexpected response status ' + response.status + '; stopped without retry');
  }
  const receipt = { step, method, route, status: response.status, id: data.id ?? null };
  state.completed.push(receipt);
  state.pending = null;
  state.phase = 'CONFIRMED';
  await save();
  assign(data, response, receipt);
  await save();
  await report();
  return data;
}

try {
  await mutate('signup', 'POST', '/auth/signup', {
    name: 'QA138 Warranty DEMO', email: state.email, password: state.password,
    organization: { name: state.organization, currency: 'PLN', locale: 'pl-PL' },
  }, 201, (data, response, receipt) => {
    state.cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    assert(state.cookie.startsWith('dyna_session='));
    state.tenant_id = id(data.user?.tenant_id);
    state.user_id = id(data.user?.id);
    receipt.id = state.tenant_id;
  });
  const me = await get('/auth/me');
  assert.equal(me.user.id, state.user_id);
  assert.equal(me.user.tenant_id, state.tenant_id);
  assert.equal(me.user.role, 'admin');
  const warehouses = await get('/warehouses');
  assert.equal(warehouses.data.length, 1, 'Fresh firm must have exactly one default warehouse');
  state.warehouse_id = id(warehouses.data[0].id);
  await save();
  await mutate('product', 'POST', '/products', {
    sku: 'QA138-WARRANTY', name: 'QA138 Warranty DEMO product', price: 10000,
    vat: 23, warehouse_id: state.warehouse_id, quantity: 6, location: 'A-01', kind: 'simple',
    description: 'Own synthetic fixture for manual warranty exchange acceptance',
  }, 201, (data) => { state.product_id = id(data.id); });
  const product = await get('/products/' + state.product_id);
  assert.equal(product.price, 10000);
  assert.equal(product.vat, 23);
  assert.equal(product.kind, 'simple');
  assert.equal(product.stock.length, 1);
  assert.equal(product.stock[0].warehouse_id, state.warehouse_id);
  assert.equal(product.stock[0].on_hand, 6);
  assert.equal(product.stock[0].reserved, 0);
  await mutate('customer-order', 'POST', '/orders', {
    customer_name: 'QA138 DEMO Customer', email: `qa138-customer-${suffix}@demo.local`,
    warehouse_id: state.warehouse_id, source: 'manual', currency: 'PLN', payment_mode: 'prepaid',
    address: { street: 'Testowa 138', city: 'Warszawa', postal_code: '00-138', country: 'PL', phone: '500000138' },
    shipping_cost: 0, items: [{ product_id: state.product_id, quantity: 3 }],
    note: 'QA138 own DEMO; no carrier, bank or external tax-provider action',
  }, 201, (data) => { state.order_id = id(data.id); }, { 'Idempotency-Key': randomUUID() });
  let order = await get('/orders/' + state.order_id);
  assert.equal(order.items.length, 1);
  state.customer_item_id = id(order.items[0].id);
  assert.equal(order.items[0].product_id, state.product_id);
  assert.equal(order.items[0].quantity, 3);
  assert.equal(order.items[0].price, 10000);
  assert.equal(order.items[0].vat, 23);
  assert.equal(order.items[0].line_total, 30000);
  assert.equal(order.total, 30000);
  await save();
  const paymentKey = randomUUID();
  const payment = await mutate('synthetic-paid-declaration', 'POST', '/orders/' + state.order_id + '/payments', {
    client_key: paymentKey, version: Number(order.version), kind: 'receipt', amount: 30000,
    currency: 'PLN', method: 'other', reference: 'QA138 synthetic DEMO declaration ' + suffix,
    note: 'Synthetic own local ledger declaration only; no bank transfer or external charge', confirmed: true,
  }, 200, (data, _response, receipt) => {
    assert.equal(data.data.length, 1);
    const entry = data.data[0];
    assert.equal(entry.client_key, paymentKey);
    assert.equal(entry.kind, 'receipt');
    assert.equal(entry.method, 'other');
    assert.equal(entry.amount, 30000);
    receipt.id = id(entry.id);
  });
  assert.equal(payment.balance.received, 30000);
  assert.equal(payment.balance.amount_due, 0);
  order = await get('/orders/' + state.order_id);
  assert.equal(order.status, 'paid');
  await mutate('start-picking', 'PATCH', '/orders/' + state.order_id + '/status', { status: 'picking' }, 200);
  order = await get('/orders/' + state.order_id);
  assert.equal(order.picking_items.length, 1);
  assert.equal(order.picking_items[0].quantity, 3);
  assert.equal(order.picking_items[0].scanned, 0);
  for (let n = 1; n <= 3; n++) {
    const scanned = await mutate('scan-' + n, 'POST', '/orders/' + state.order_id + '/scan', {
      code: 'QA138-WARRANTY', location: 'A-01', client_key: randomUUID(),
    }, 200);
    assert.equal(scanned.picking_items[0].scanned, n);
  }
  await mutate('pack', 'PATCH', '/orders/' + state.order_id + '/status', { status: 'packed' }, 200);
  await mutate('genuine-local-demo-issue', 'POST', '/orders/' + state.order_id + '/ship-demo', {}, 200);
  const invoice = await mutate('demo-invoice', 'POST', '/orders/' + state.order_id + '/documents', { kind: 'invoice' }, 200);
  id(invoice.id);
  assert.equal(invoice.order_id, state.order_id);
  assert.equal(invoice.kind, 'invoice');
  assert.equal(invoice.mode, 'demo');
  await mutate('requested-complaint', 'POST', '/orders/' + state.order_id + '/returns', {
    client_key: randomUUID(), kind: 'complaint', reason: 'QA138 DEMO warranty exchange of one unit',
    warehouse_id: state.warehouse_id, shipping_refund: 0,
    items: [{ item_id: state.customer_item_id, quantity: 1 }],
  }, 201, (data) => { state.return_id = id(data.id); });
  const rma = await get('/returns/' + state.return_id);
  order = await get('/orders/' + state.order_id);
  const afterProduct = await get('/products/' + state.product_id);
  assert.equal(rma.order_id, state.order_id);
  assert.equal(rma.kind, 'complaint');
  assert.equal(rma.state, 'requested');
  assert.equal(rma.requested_shipping, 0);
  assert.equal(rma.items.length, 1);
  assert.equal(rma.items[0].item_id, state.customer_item_id);
  assert.equal(rma.items[0].requested, 1);
  assert.equal(rma.items[0].accepted, 0);
  assert.equal(rma.items[0].restocked, 0);
  assert.equal(rma.exchange, null);
  assert.equal(rma.can_exchange, true);
  assert.equal(order.items[0].id, state.customer_item_id);
  assert.equal(order.items.length, 1);
  assert.equal(order.source, 'manual');
  assert.equal(order.currency, 'PLN');
  assert.equal(order.payment_mode, 'prepaid');
  assert.equal(order.items[0].quantity, 3);
  assert.equal(order.items[0].line_total, 30000);
  assert.equal(order.picking_items[0].scanned, 3);
  assert.equal(order.shipments.length, 1);
  assert.equal(order.shipments[0].mode, 'demo');
  assert(order.shipments[0].dispatched_at);
  assert.equal(order.documents.length, 1);
  assert.equal(order.documents[0].id, invoice.id);
  assert.equal(order.payment.received, 30000);
  assert.equal(order.payment.amount_due, 0);
  assert.equal(afterProduct.stock.length, 1);
  assert.equal(afterProduct.stock[0].warehouse_id, state.warehouse_id);
  assert.equal(afterProduct.stock[0].on_hand, 3);
  assert.equal(afterProduct.stock[0].reserved, 0);
  assert.equal(state.completed.length, 12);
  assert.equal(state.pending, null);
  state.born = { product: afterProduct, order, return: rma, invoice };
  state.setup_complete = true;
  state.phase = 'READY_FOR_CHROME_EXCHANGE';
  await save();
  await report();
  console.log('QA138 own DEMO setup ready: 12 confirmed mutations; complaint requested; exchange not created.');
} catch {
  if (state.phase !== 'UNKNOWN_RESULT_DO_NOT_RETRY' && state.phase !== 'UNEXPECTED_RESPONSE_STOP') {
    state.phase = 'VALIDATION_FAILED_STOP_DO_NOT_RERUN';
    await save();
    await report();
  }
  // Never print response bodies, credentials, request bodies or exception details.
  throw new Error('QA138 setup stopped; retain private ledger and public metadata; do not rerun or retry');
}
