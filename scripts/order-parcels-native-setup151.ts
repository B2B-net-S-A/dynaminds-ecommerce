/** Root-only one-shot QA151 ordinary-API fixture. No parcel preview/apply/issue.
 * Two new firms: OFF simple3 from PZ5; ON bundle3 A1/B2 from PZ A5/B10.
 * Local prepaid declarations are synthetic ledger facts, not bank transfers.
 * Unknown writes stop with durable pending custody; no retry or resume path.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const path = resolve(root, 'data/order-parcels-stage151.json');
const reportPath = resolve(root, 'docs/order-parcels-native151-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '134_order_parcels';
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = (v: unknown): string => {
  assert.equal(typeof v, 'string');
  assert.match(v as string, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return v as string;
};
let pool: Pool | undefined;
let currentStep = 'preflight';
let state: any;
async function absent(file: string) {
  try { await lstat(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('QA151 output already exists; manual inspection required');
}
async function writeExclusive(file: string, value: unknown, mode = 0o600) {
  const f = await open(file, 'wx', mode);
  try { await f.writeFile(encode(value)); await f.sync(); } finally { await f.close(); }
}
async function save() {
  const prior = await lstat(path);
  assert(prior.isFile() && !prior.isSymbolicLink());
  assert.equal(prior.mode & 0o777, 0o600);
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeExclusive(tmp, state);
    await rename(tmp, path);
    const d = await open(dirname(path), 'r');
    try { await d.sync(); } finally { await d.close(); }
  } finally { await unlink(tmp).catch(() => {}); }
}
async function received(r: Response) {
  const bytes = Buffer.from(await r.arrayBuffer());
  assert(bytes.length <= 8 * 1024 * 1024, 'Bounded fixture response');
  return JSON.parse(bytes.toString('utf8'));
}
async function health() {
  const r = await fetch(base + '/health', { redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store' });
  assert.equal(r.status, 200);
  const h = await received(r);
  assert.equal(h.status, 'ok'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.order_parcels_available, true);
  return h;
}
function headers(a: any, extra: Record<string, string> = {}) {
  return { ...(a.cookie ? { cookie: a.cookie, 'X-Workspace-ID': a.tenant_id } : {}), 'Content-Type': 'application/json', ...extra };
}
async function get(a: any, route: string) {
  assert(route.startsWith('/') && !route.includes('://'));
  const r = await fetch(base + route, { headers: headers(a), redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store' });
  assert.equal(r.status, 200, 'Authenticated own GET');
  return received(r);
}
function allowed(a: any, method: string, route: string) {
  if (method === 'POST' && ['/auth/signup', '/products', '/suppliers', '/purchase-orders', '/orders', '/workspaces/billing/preview'].includes(route)) return true;
  if (method === 'POST' && a.billing_preview?.id && route === '/workspaces/billing/previews/' + a.billing_preview.id + '/commit') return true;
  if (a.on && method === 'POST' && route === '/wms-lots/opening-previews') return true;
  if (a.on && method === 'POST' && a.opening?.id && route === '/wms-lots/opening-previews/' + a.opening.id + '/activate') return true;
  if (method === 'POST' && a.purchase?.id && ['/place', '/receive'].some(suffix => route === '/purchase-orders/' + a.purchase.id + suffix)) return true;
  if (a.order_id && method === 'POST' && ['/payments', '/scan'].some(suffix => route === '/orders/' + a.order_id + suffix)) return true;
  return Boolean(a.order_id && method === 'PATCH' && route === '/orders/' + a.order_id + '/status');
}
async function mutate(a: any, label: string, method: string, route: string, body: any, expected: number, assign: (data: any, response: Response) => void = () => {}, extra: Record<string, string> = {}) {
  currentStep = a.label + ':' + label;
  assert.equal(state.pending, null);
  assert(allowed(a, method, route), 'Bounded ordinary fixture route');
  await health();
  if (route !== '/auth/signup') {
    const me = await get(a, '/auth/me');
    assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin');
  }
  state.pending = { actor: a.label, step: label, method, route, body, extra_headers: extra, expected_status: expected, response: null };
  state.phase = 'PENDING_WRITE';
  await save();
  let r: Response, data: any;
  try {
    r = await fetch(base + route, { method, headers: headers(a, extra), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
    data = await received(r);
  } catch {
    state.phase = 'UNKNOWN_RESULT_DO_NOT_RETRY'; await save();
    throw Error('Unconfirmed write; retained custody requires manual inspection');
  }
  state.pending.response = { status: r.status, data };
  await save();
  assert.equal(r.status, expected, 'Expected ordinary API result');
  // Assigned IDs/cookie remain durable while the complete response is pending.
  assign(data, r);
  await save();
  state.completed.push({ actor: a.label, step: label, method, route, status: r.status, response_sha256: hash(data) });
  state.pending = null; state.phase = 'CONFIRMED';
  await save();
  return data;
}
async function pages(a: any, route: string, maximum: number) {
  const all: any[] = []; const seen = new Set<string>(); let cursor: string | null = null;
  do {
    const response = await get(a, route + (cursor ? (route.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor) : ''));
    assert(Array.isArray(response.data)); all.push(...response.data);
    assert(all.length <= maximum, 'Complete bounded fixture scope');
    cursor = response.meta?.cursor ?? null;
    if (cursor) { assert(!seen.has(cursor)); seen.add(cursor); }
  } while (cursor);
  return all;
}
async function snapshot(a: any) {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const native = (await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0];
    assert.deepEqual(native, { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name")).rows.map(r => r.table_name as string);
    const result: Record<string, { count: number; sha256: string }> = {};
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=$1 ORDER BY 1`, [name === 'users' ? a.user_id : a.tenant_id])).rows;
      result[name] = { count: rows.length, sha256: hash(rows) };
    }
    await c.query('COMMIT'); return result;
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

async function setup(a: any) {
  await mutate(a, 'signup', 'POST', '/auth/signup', { name: 'QA151 Parcel ' + a.label + ' Operator', email: a.email, password: a.password, organization: { name: a.organization, currency: 'PLN', locale: 'pl-PL' } }, 201, (r, response) => {
    a.tenant_id = uuid(r.user.tenant_id); a.user_id = uuid(r.user.id);
    a.cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]; assert(a.cookie.startsWith('dyna_session='));
  });
  const wh = await get(a, '/warehouses'); assert.equal(wh.data.length, 1); a.warehouse_id = uuid(wh.data[0].id); await save();
  const billing = await get(a, '/workspaces/billing');
  assert.equal(billing.mode, 'local_estimate'); assert.equal(billing.admin, true);
  assert.equal(billing.account, null); assert.equal(billing.current_plan, 'starter');
  await mutate(a, 'local-enterprise-preview', 'POST', '/workspaces/billing/preview', { kind: 'activate', plan: 'enterprise' }, 200, r => {
    assert.equal(r.mode, 'local_estimate'); assert.equal(r.actor_id, a.user_id); assert.equal(r.tenant_id, a.tenant_id);
    assert.equal(r.can_commit, true); assert.deepEqual(r.blockers, []); uuid(r.id); a.billing_preview = r;
  });
  await mutate(a, 'local-enterprise-commit', 'POST', '/workspaces/billing/previews/' + a.billing_preview.id + '/commit', {}, 200, r => {
    assert.equal(r.mode, 'local_estimate'); assert.equal(r.plan, 'enterprise'); a.billing_result = r;
  });
  assert.equal((await get(a, '/workspaces/billing')).current_plan, 'enterprise');
  const specs = a.on ? [{ letter: 'A', recipe: 1, stock: 5, cost: 0 }, { letter: 'B', recipe: 2, stock: 10, cost: 1000 }] : [{ letter: 'S', recipe: 1, stock: 5, cost: 317 }];
  for (const x of specs) {
    const sku = 'QA151-' + a.label + '-' + x.letter + '-' + state.suffix;
    await mutate(a, 'product-' + x.letter, 'POST', '/products', { sku, name: 'QA151 ' + a.label + ' Component ' + x.letter, kind: 'simple', price: 10000, vat: 23, warehouse_id: a.warehouse_id, quantity: 0, location: 'QA151-01' }, 201, r => {
      a.components.push({ id: uuid(r.id), sku, recipe_quantity: x.recipe, initial_quantity: x.stock, unit_cost_minor: x.cost });
    });
  }
  if (a.on) {
    await mutate(a, 'bundle', 'POST', '/products', { sku: 'QA151-ON-BUNDLE-' + state.suffix, name: 'QA151 Frozen A1 B2 Bundle', kind: 'bundle', price: 10000, vat: 23, warehouse_id: a.warehouse_id, quantity: 0, location: 'QA151-01', components: a.components.map((r: any) => ({ product_id: r.id, quantity: r.recipe_quantity })) }, 201, r => { a.sale_product_id = uuid(r.id); });
    await mutate(a, 'empty-wms-opening', 'POST', '/wms-lots/opening-previews', { client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'QA151 empty opening before genuine purchase receipt', lines: [] }, 201, r => {
      assert.equal(r.preview.ready, true); uuid(r.preview.id); a.opening = r.preview;
    });
    await mutate(a, 'activate-wms', 'POST', '/wms-lots/opening-previews/' + a.opening.id + '/activate', { client_key: randomUUID(), scope_hash: a.opening.scope_hash, confirmed: true, ack_unknown_costs: false }, 201);
  } else { a.sale_product_id = a.components[0].id; await save(); }
  const policy = (await get(a, '/wms-lots')).policy; assert.equal(policy.enabled, a.on); a.policy = policy; await save();
  await mutate(a, 'supplier', 'POST', '/suppliers', { name: 'QA151 Own Synthetic Purchase Supplier ' + a.label, code: 'QA151-' + a.label + '-' + state.suffix }, 201, r => { a.supplier_id = uuid(r.id); });
  const lines = a.components.map((r: any) => ({ product_id: r.id, quantity: r.initial_quantity, unit_cost: r.unit_cost_minor }));
  await mutate(a, 'purchase', 'POST', '/purchase-orders', { supplier_id: a.supplier_id, warehouse_id: a.warehouse_id, currency: 'PLN', reference: 'QA151 ' + a.label + ' genuine own stock', lines }, 201, r => { a.purchase = r; uuid(r.id); });
  await mutate(a, 'place-purchase', 'POST', '/purchase-orders/' + a.purchase.id + '/place', { version: a.purchase.version }, 200, r => { assert.equal(r.state, 'ordered'); a.purchase = r; });
  const versions: any[] = [];
  for (const product of a.components) {
    const p = await get(a, '/products/' + product.id);
    const stock = p.stock.find((r: any) => r.warehouse_id === a.warehouse_id);
    versions.push({ warehouse_id: a.warehouse_id, product_id: product.id, version: String(stock?.version ?? '0') });
  }
  const receive: any = { client_key: randomUUID(), version: a.purchase.version, reference: 'QA151 PZ ' + a.label, note: 'Own QA stock with known net purchase costs', lines: lines.map((r: any) => ({ product_id: r.product_id, quantity: r.quantity, location: 'QA151-01' })) };
  if (a.on) receive.wms_lots = { policy_version: String(policy.version), stock_versions: versions, lines: lines.map((r: any, i: number) => ({ product_id: r.product_id, quantity: r.quantity, location: 'QA151-01', lot_code: 'QA151-' + i + '-' + state.suffix })) };
  await mutate(a, 'genuine-pz', 'POST', '/purchase-orders/' + a.purchase.id + '/receive', receive, 200, r => { assert.equal(r.order.state, 'received'); uuid(r.receipt_id); a.receipt = r; a.purchase = r.order; });
  a.purchased_products = await Promise.all(a.components.map((r: any) => get(a, '/products/' + r.id)));
  for (const product of a.components) {
    const p = a.purchased_products.find((r: any) => r.id === product.id), stock = p.stock.find((r: any) => r.warehouse_id === a.warehouse_id);
    assert.equal(stock.on_hand, product.initial_quantity); assert.equal(stock.reserved, 0);
  }
  if (a.on) {
    a.purchased_positions = await pages(a, '/wms-lots/positions', 2); assert.equal(a.purchased_positions.length, 2);
    a.purchased_valuation = await get(a, '/wms-lots/valuation');
    assert.equal(a.purchased_valuation.valuation.known_minor, '10000'); assert.equal(a.purchased_valuation.valuation.unknown_quantity, '0');
  }
  await mutate(a, 'sale', 'POST', '/orders', { source: 'manual', customer_name: 'QA151 Own Parcel Customer ' + a.label, email: 'qa151-customer@example.test', address: { street: 'Testowa 151', city: 'Warszawa', postal_code: '00-151', country: 'PL', phone: '500000151' }, warehouse_id: a.warehouse_id, currency: 'PLN', payment_mode: 'prepaid', shipping_cost: 0, items: [{ product_id: a.sale_product_id, quantity: 3 }], note: 'QA151 full planned parcel allocation fixture; no provider calls' }, 201, r => { a.order_id = uuid(r.id); }, { 'Idempotency-Key': randomUUID() });
  let order = await get(a, '/orders/' + a.order_id);
  assert.equal(order.items.length, 1); a.customer_item_id = uuid(order.items[0].id);
  assert.equal(order.items[0].quantity, 3); assert.equal(order.total, 30000);
  const paymentKey = randomUUID();
  await mutate(a, 'synthetic-local-prepaid-declaration', 'POST', '/orders/' + a.order_id + '/payments', { client_key: paymentKey, version: Number(order.version), kind: 'receipt', amount: 30000, currency: 'PLN', method: 'other', reference: 'QA151 synthetic own local ledger declaration', note: 'No bank transfer, provider reconciliation or external money movement', confirmed: true }, 200, r => {
    assert.equal(r.data.length, 1); assert.equal(r.data[0].client_key, paymentKey); assert.equal(r.data[0].amount, 30000); a.payment = r;
  });
  await mutate(a, 'picking', 'PATCH', '/orders/' + a.order_id + '/status', { status: 'picking' }, 200);
  if (a.on) {
    const allocations = await pages(a, '/wms-lots/orders/' + a.order_id + '/allocations', 2); assert.equal(allocations.length, 2); a.allocations = allocations;
    for (const r of allocations) {
      const product = a.components.find((v: any) => v.id === r.product_id); assert(product);
      assert.equal(r.warehouse_id, a.warehouse_id); assert.equal(r.location, 'QA151-01'); assert.equal(r.quantity, 3 * product.recipe_quantity); uuid(r.layer_id);
      for (let n = 0; n < r.quantity; n++) await mutate(a, 'scan-' + product.sku + '-' + n, 'POST', '/orders/' + a.order_id + '/scan', { client_key: randomUUID(), code: product.sku, location: r.location, layer_id: r.layer_id }, 200);
    }
  } else {
    for (let n = 0; n < 3; n++) await mutate(a, 'scan-simple-' + n, 'POST', '/orders/' + a.order_id + '/scan', { client_key: randomUUID(), code: a.components[0].sku, location: 'QA151-01' }, 200);
  }
  await mutate(a, 'packed', 'PATCH', '/orders/' + a.order_id + '/status', { status: 'packed' }, 200);
  order = await get(a, '/orders/' + a.order_id);
  assert.equal(order.status, 'packed'); assert.equal(order.payment.received, 30000); assert.equal(order.payment.amount_due, 0);
  assert.equal(order.shipments.length, 0); assert.equal(order.documents.length, 0); assert.equal(order.returns.case_count, 0);
  assert.equal(order.items[0].id, a.customer_item_id); assert.equal(order.items[0].quantity, 3); assert.equal(order.items[0].scanned, 3);
  a.source = await get(a, '/order-parcels/orders/' + a.order_id + '/source');
  assert.equal(a.source.available, true); assert.equal(a.source.read_only, false); assert.equal(a.source.can_write, true);
  assert.equal(a.source.source.order.id, a.order_id); assert.equal(a.source.source.can_preview, true); assert.equal(a.source.source.wms_enabled, a.on);
  a.preview_draft = { client_key: randomUUID(), order_version: String(order.version), parcels: [1, 2].map(quantity => ({ source_kind: 'demo', products: a.components.map((r: any) => ({ product_id: r.id, quantity: quantity * r.recipe_quantity })), cod_minor: 0 })) };
  a.source_born = { order, products: await Promise.all(a.components.map((r: any) => get(a, '/products/' + r.id))), sale_product: await get(a, '/products/' + a.sale_product_id), policy: (await get(a, '/wms-lots')).policy, positions: a.on ? await pages(a, '/wms-lots/positions', 2) : [], allocations: a.on ? await pages(a, '/wms-lots/orders/' + a.order_id + '/allocations', 2) : [], valuation: a.on ? await get(a, '/wms-lots/valuation') : null };
  for (const product of a.components) {
    const p = a.source_born.products.find((r: any) => r.id === product.id), stock = p.stock.find((r: any) => r.warehouse_id === a.warehouse_id);
    assert.equal(stock.on_hand, product.initial_quantity); assert.equal(stock.reserved, 3 * product.recipe_quantity);
  }
  a.setup_checkpoint = await snapshot(a);
  for (const [name, value] of Object.entries(a.setup_checkpoint) as [string, { count: number }][]) {
    if (name.startsWith('order_parcel')) assert.equal(value.count, 0, 'No parcel admission/preview/plan/issue from setup');
  }
  a.complete = true; await save();
}

async function main() {
  assert.equal(resolve(process.cwd()), root);
  assert.equal(resolve(dirname(fileURLToPath(import.meta.url)), '..'), root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.QA151_SETUP_CONFIRM, 'CREATE_TWO_NEW_OWN_PARCEL_FIXTURES'); assert.match(revision, /^[a-f0-9]{40}$/);
  const config = await lstat(resolve(root, '.local.json')); assert(config.isFile() && !config.isSymbolicLink()); assert.equal(config.mode & 0o777, 0o600);
  for (const dir of [resolve(root, 'data'), resolve(root, 'docs')]) { const d = await lstat(dir); assert(d.isDirectory() && !d.isSymbolicLink()); }
  await absent(path); await absent(reportPath); await health();
  pool = (await import('../server/db')).pool;
  const u = new URL(pool.options.connectionString!); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/dynaminds');
  // Verify native database before the first signup; no database writes occur here.
  const c = await pool.connect();
  try { const n = (await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0]; assert.deepEqual(n, { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 }); } finally { c.release(); }
  const suffix = randomUUID().slice(0, 8);
  const actor = (on: boolean) => ({ label: on ? 'ON' : 'OFF', on, email: 'qa151-' + (on ? 'on' : 'off') + '-' + suffix + '@demo.local', password: 'QA151-' + randomBytes(24).toString('hex'), organization: 'QA151 Own Parcels ' + (on ? 'ON' : 'OFF') + ' ' + suffix, cookie: '', tenant_id: '', user_id: '', components: [], complete: false });
  state = { stage: 151, runtime_revision: revision, schema_revision: schema, suffix, off: actor(false), on: actor(true), pending: null, completed: [], phase: 'PREPARED', complete: false, provider_verified: false, parcel_issue_verified: false };
  await writeExclusive(path, state);
  await setup(state.off);
  await setup(state.on);
  // Work on the second firm must preserve the first firm's completed own baseline.
  assert.deepEqual(await snapshot(state.off), state.off.setup_checkpoint);
  await health(); assert.equal(state.pending, null);
  state.complete = true; state.phase = 'READY_BEFORE_PARCEL_PREVIEW'; await save();
  await writeExclusive(reportPath, { stage: 151, status: 'OWN_OFF_ON_SETUP_PASS', revision, schema_revision: schema, firms: ['off', 'on'].map(key => {
    const a = state[key]; return { wms_enabled: a.on, tenant_id: a.tenant_id, order_id: a.order_id, commercial_quantity: 3, local_prepaid_declaration: 30000, physical_quantities: a.components.map((r: any) => ({ product_id: r.id, original_reserved: 3 * r.recipe_quantity, initial_stock: r.initial_quantity, unit_cost_minor: r.unit_cost_minor })), proposed_parcel_units: [1, 2], own_tables: Object.keys(a.setup_checkpoint).length, setup_checkpoint_sha256: hash(a.setup_checkpoint) };
  }), successful_writes: state.completed.length, pending: false, parcel_previews: 0, parcel_plans: 0, parcel_dispatches: 0, provider_requests: 0, bank_verified: false, physical_print_verified: false, full_goal_complete: false }, 0o644);
  console.log(JSON.stringify({ status: 'OWN_OFF_ON_SETUP_PASS', firms: 2, successful_writes: state.completed.length, parcel_dispatches: 0 }));
}
main().catch(() => {
  console.error(JSON.stringify({ status: 'QA151_SETUP_FAILED', step: currentStep, code: 'PRIVATE_DETAILS_WITHHELD', pending_must_be_inspected: true }));
  process.exitCode = 1;
}).finally(() => pool?.end());
