/** Root-operated genuine localhost API commerce. Two exclusive phases; no
 * automatic resume/retry. Payments, shipment and invoice are local demo only. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const revision = 'f4dee74de9940d3b6fda92f7f6324c6a33dad484';
const schema = '142_product_catalogs';
const run = process.argv[2];
const phase = run === 'on-reviewed' ? 'on' : run;
const journal = resolve(root, 'data/product-catalogs-commerce157-' + run + '.json');
const report = resolve(root, 'docs/product-catalogs-commerce157-' + run + '.json');
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
let state: any, setup: any, chrome: any, pool: pg.Pool | undefined;
let step = 'preflight';
async function privateRead(path: string) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o600); assert(s.size > 0 && s.size < 64 * 1024 * 1024);
  return readFile(path);
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e;
  }
  throw Error('Exclusive phase already exists; inspect custody, do not resume');
}
async function wx(path: string, v: unknown, mode = 0o600) {
  const f = await open(path, 'wx', mode);
  try { await f.writeFile(JSON.stringify(v, null, 2) + '\n'); await f.sync(); }
  finally { await f.close(); }
}
async function save() {
  await privateRead(journal);
  const temp = journal + '.' + randomUUID() + '.tmp';
  try {
    await wx(temp, state); await rename(temp, journal);
    const d = await open(dirname(journal), 'r'); try { await d.sync(); } finally { await d.close(); }
  } finally { await unlink(temp).catch(() => undefined); }
}
function headers(extra: Record<string, string> = {}) {
  return { 'Content-Type': 'application/json', cookie: setup.actor.cookie,
    'X-Workspace-ID': setup.actor.tenant_id, ...extra };
}
async function body(r: Response) {
  const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length < 16 * 1024 * 1024);
  return JSON.parse(bytes.toString('utf8'));
}
async function get(route: string): Promise<any> {
  assert(route.startsWith('/') && !route.includes('://'));
  const r = await fetch(base + route, { headers: headers(), redirect: 'error',
    cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200, 'Own scoped GET'); return body(r);
}
async function preflight() {
  const h = await get('/health');
  assert.equal(h.status, 'ok'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.product_catalogs_available, true);
  const m = await get('/auth/me');
  assert.equal(m.user.id, setup.actor.user_id); assert.equal(m.user.tenant_id, setup.actor.tenant_id);
  assert.equal(m.user.role, 'admin');
  assert.equal((await get('/product-catalogs/' + chrome.catalog.id)).catalog.version, chrome.catalog.version);
}
async function write(label: string, route: string, b: any, expected = 200,
  method = 'POST', extra: Record<string, string> = {}): Promise<any> {
  step = label; assert.equal(state.pending, null); await preflight();
  const allowed = route === '/products' || route === '/warehouse-documents' || route === '/orders' ||
    route === '/price-lists/' + state.price_list_id + '/items' || route === '/wms-lots/receipts' ||
    route === '/wms-lots/opening-previews' ||
    (state.receipt_id && route === '/warehouse-documents/' + state.receipt_id + '/post') ||
    (state.opening_id && route === '/wms-lots/opening-previews/' + state.opening_id + '/activate') ||
    (state.order_id && ['/payments', '/status', '/scan', '/ship-demo', '/documents', '/returns']
      .some(s => route === '/orders/' + state.order_id + s)) ||
    (state.return_id && route === '/returns/' + state.return_id + '/receive');
  assert(allowed); assert(['POST', 'PUT', 'PATCH'].includes(method));
  state.pending = { label, route, method, body: b, extra_headers: extra, expected_status: expected, response: null };
  state.status = 'PENDING_WRITE'; await save();
  let r: Response, d: any;
  try {
    r = await fetch(base + route, { method, headers: headers(extra), body: JSON.stringify(b),
      redirect: 'error', signal: AbortSignal.timeout(90000) });
    d = await body(r);
  } catch {
    state.status = 'UNKNOWN_RESULT_DO_NOT_RETRY'; await save(); throw Error('Unconfirmed local write');
  }
  state.pending.response = { status: r.status, data: d }; await save();
  assert.equal(r.status, expected, 'Exact local write status');
  state.completed.push(state.pending); state.pending = null; state.status = 'CONFIRMED'; await save();
  process.stdout.write('QA157_' + phase + '_' + label + '_CONFIRMED\n'); return d;
}
async function capture() {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1")).rows;
    const rows: Record<string, any[]> = {};
    for (const { table_name: name } of names) {
      assert.match(name, /^[a-z][a-z0-9_]*$/);
      const field = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      rows[name] = (await c.query(`SELECT to_jsonb(x) row FROM "${name}" x WHERE ${field}=$1 ORDER BY 1`,
        [name === 'users' ? setup.actor.user_id : setup.actor.tenant_id])).rows;
    }
    await c.query('COMMIT'); return rows;
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
async function stock() {
  const p = await get('/products/' + state.product_id);
  assert.equal(p.catalog_id, chrome.catalog.id);
  assert.equal(p.price, 1501); assert.equal(p.stock.length, 1);
  const s = p.stock[0]; assert.equal(s.warehouse_id, state.warehouse_id); return s;
}
async function flow() {
  const on = phase === 'on';
  if (on) {
    const off = JSON.parse(await privateRead(resolve(root, 'data/product-catalogs-commerce157-off.json')) as any);
    assert.equal(off.status, 'LOCAL_COMMERCE_PASS'); assert.equal(off.complete, true); assert.equal(off.pending, null);
    assert.equal(off.tenant_id, setup.actor.tenant_id); state.off_checkpoint_sha256 = hash(JSON.stringify(off.after));
    if (run !== 'on-reviewed') assert.deepEqual(await capture(), off.after, 'No drift before WMS opening');
    else {
      // Root inspected the known rejected preview and processed only empty-rule
      // jobs through dispatchAutomation. This is a new reviewed phase, never a
      // retry or replacement of the failed journal.
      assert.equal(process.env.QA157_REVIEWED_BLOCKERS, 'OWN_EMPTY_RULE_JOBS_AND_ALL_POSITIVE_BINS');
      const failed = JSON.parse((await privateRead(resolve(root, 'data/product-catalogs-commerce157-on.json'))).toString());
      assert.equal(failed.status, 'FAILED_DO_NOT_RETRY'); assert.equal(failed.pending, null);
      assert.equal(failed.completed.length, 1); assert.equal(failed.completed[0].label, 'opening-preview');
      assert.equal(failed.completed[0].response.status, 201); assert.equal(failed.completed[0].response.data.preview.ready, false);
      const drain = JSON.parse((await privateRead(resolve(root, 'data/product-catalogs-empty-jobs157.json'))).toString());
      assert.equal(drain.status, 'OWN_EMPTY_RULE_JOBS_DONE'); assert.equal(drain.pending, null);
      assert.equal(drain.tenant_id, setup.actor.tenant_id);
      state.reviewed_failed_preview_id = failed.completed[0].response.data.preview.id;
    }
    const old = await get('/products/' + off.product_id), s = old.stock[0];
    assert.equal(s.on_hand, 3); assert.equal(s.reserved, 0);
    const scope = await get('/wms-lots/opening-scope');
    assert.equal(scope.meta.cursor, null); assert.deepEqual(scope.active_blockers, []);
    assert.equal(scope.data.reduce((n: number, b: any) => n + b.quantity, 0), 3);
    for (const b of scope.data) {
      assert.equal(b.product_id, off.product_id); assert.equal(b.warehouse_id, state.warehouse_id);
      assert.equal(String(b.stock_version), String(s.version));
    }
    const opening = (await write('opening-preview', '/wms-lots/opening-previews', {
      client_key: randomUUID(), policy_version: '0', currency: 'PLN',
      note: 'Own QA157 opening with explicitly unknown historical cost',
      lines: scope.data.map((b: any) => ({ warehouse_id: b.warehouse_id, product_id: b.product_id, location: b.location,
        quantity: b.quantity, stock_version: String(b.stock_version), lot_code: 'QA157-OPEN-' + setup.suffix + '-' + b.location,
        unit_cost_minor: null })),
    }, 201)).preview;
    assert.equal(opening.ready, true); assert.equal(opening.unknown_quantity, '3');
    state.opening_id = opening.id; state.opening = opening; await save();
    state.activation = await write('opening-activate', '/wms-lots/opening-previews/' + opening.id + '/activate', {
      client_key: randomUUID(), scope_hash: opening.scope_hash, confirmed: true, ack_unknown_costs: true,
    }, 201);
    assert.equal((await get('/wms-lots')).policy.enabled, true);
    const p = await write('new-on-product', '/products', { catalog_id: chrome.catalog.id,
      warehouse_id: state.warehouse_id, sku: 'QA157-' + setup.suffix + '-ON', name: 'QA157 Drugi produkt ON',
      kind: 'simple', price: 1501, vat: 23, quantity: 0, location: state.location }, 201);
    state.product_id = p.id; state.sku = p.sku; await save();
  }
  assert.equal((await stock()).on_hand, 0); assert.equal((await stock()).reserved, 0);
  if (on) {
    const policy = (await get('/wms-lots')).policy;
    state.receipt = await write('receive-four', '/wms-lots/receipts', {
      client_key: randomUUID(), policy_version: String(policy.version), warehouse_id: state.warehouse_id,
      stock_versions: [{ product_id: state.product_id, warehouse_id: state.warehouse_id, version: String((await stock()).version) }],
      note: 'Own QA157 incoming known unit cost 101', confirmed: true,
      lines: [{ product_id: state.product_id, location: state.location, quantity: 4,
        lot_code: 'QA157-ON-' + setup.suffix, unit_cost_minor: '101', currency: 'PLN' }],
    }, 201); await save();
  } else {
    const receipt = await write('receipt-draft', '/warehouse-documents', { kind: 'receipt',
      warehouse_id: state.warehouse_id, lines: [{ product_id: state.product_id, quantity: 4, location: state.location }] }, 201);
    state.receipt_id = receipt.id; await save();
    state.receipt = await write('receive-four', '/warehouse-documents/' + receipt.id + '/post', { version: receipt.version }); await save();
  }
  assert.equal((await stock()).on_hand, 4);
  const pricing = await get('/price-lists/' + state.price_list_id + '/items'); assert.equal(pricing.meta.cursor, null);
  await write('assigned-price', '/price-lists/' + state.price_list_id + '/items', {
    version: pricing.list.version,
    items: [...pricing.data.map((p: any) => ({ product_id: p.product_id, price: p.price })), { product_id: state.product_id, price: 1501 }],
  }, 200, 'PUT');
  let order = await write('order-two', '/orders', { customer_name: 'QA157 Local ' + phase + ' Buyer',
    email: 'catalog157@example.test', warehouse_id: state.warehouse_id, price_list_id: state.price_list_id,
    payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    address: { street: 'Testowa 157', city: 'Warszawa', postal_code: '00-157', country: 'PL', phone: '500000157' },
    items: [{ product_id: state.product_id, quantity: 2 }],
  }, 201, 'POST', { 'Idempotency-Key': randomUUID() });
  state.order_id = order.id; await save(); order = await get('/orders/' + order.id);
  assert.equal(order.total, 3002); assert.equal((await stock()).reserved, 2);
  await write('local-payment-declaration', '/orders/' + order.id + '/payments', { client_key: randomUUID(),
    version: Number(order.version), kind: 'receipt', amount: 3002, currency: 'PLN', method: 'other',
    reference: 'Synthetic local QA157 declaration; no funds transferred', confirmed: true });
  await write('picking', '/orders/' + order.id + '/status', { status: 'picking' }, 200, 'PATCH');
  if (on) {
    const allocations = await get('/wms-lots/orders/' + order.id + '/allocations');
    assert.equal(allocations.data.reduce((n: number, a: any) => n + a.quantity, 0), 2);
    for (const a of allocations.data) for (let i = 0; i < a.quantity; ++i)
      await write('scan', '/orders/' + order.id + '/scan', { client_key: randomUUID(), code: state.sku,
        location: a.location, layer_id: a.layer_id });
  } else for (let i = 0; i < 2; ++i)
    await write('scan', '/orders/' + order.id + '/scan', { client_key: randomUUID(), code: state.sku, location: state.location });
  await write('packed', '/orders/' + order.id + '/status', { status: 'packed' }, 200, 'PATCH');
  await write('local-demo-shipment', '/orders/' + order.id + '/ship-demo', {});
  order = await get('/orders/' + order.id); assert.equal(order.status, 'shipped'); assert.equal((await stock()).on_hand, 2);
  state.document = await write('local-demo-invoice', '/orders/' + order.id + '/documents', { kind: 'invoice' });
  assert(state.document.id); await save();
  let rma = await write('return-one', '/orders/' + order.id + '/returns', { client_key: randomUUID(),
    reason: 'Own QA157 local partial inspection', shipping_refund: 0,
    items: [{ item_id: order.items[0].id, quantity: 1 }] }, 201);
  state.return_id = rma.id; await save(); rma = await get('/returns/' + rma.id);
  const receive: any = { version: Number(rma.version), note: 'Own QA157 accepted one and restocked one', shipping_refund: 0,
    items: [{ item_id: rma.items[0].item_id, accepted: 1, restocked: 1 }] };
  if (on) {
    const issued = (await pool!.query('SELECT id,product_id,value_minor FROM wms_issue_fragments WHERE tenant_id=$1 AND order_id=$2 ORDER BY id',
      [setup.actor.tenant_id, order.id])).rows;
    assert.equal(issued.length, 1); assert.equal(issued[0].value_minor, '202'); state.issue = issued[0];
    receive.wms_lots = { client_key: randomUUID(), policy_version: String((await get('/wms-lots')).policy.version),
      stock_versions: [{ product_id: state.product_id, warehouse_id: state.warehouse_id, version: String((await stock()).version) }],
      picks: [{ issue_fragment_id: issued[0].id, quantity: 1, location: state.location }] };
  }
  state.return_receipt = await write('receive-return', '/returns/' + rma.id + '/receive', receive);
  assert.equal(state.return_receipt.refund_amount, 1501);
  assert.equal((await stock()).on_hand, 3); assert.equal((await stock()).reserved, 0); await save();
  const accepted = await capture();
  await write('exact-return-replay', '/returns/' + rma.id + '/receive', receive);
  assert.deepEqual(await capture(), accepted, 'Replay must not change any own business row');
  state.order = await get('/orders/' + order.id); state.return_case = await get('/returns/' + rma.id);
  state.final_stock = await stock(); state.after = await capture();
  for (const old of setup.setup_checkpoint.rows.products)
    assert.deepEqual(state.after.products.find((x: any) => x.row.id === old.row.id), old, 'Original default product unchanged');
}
async function main() {
  assert.equal(process.cwd(), root); assert.equal(process.argv.length, 3); assert(['off', 'on', 'on-reviewed'].includes(run));
  assert.equal(process.env.QA157_COMMERCE_CONFIRM, 'LOCAL_OWN_CATALOG_COMMERCE_ONLY');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.equal(process.env.APP_REVISION, revision);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json')); assert(!process.env.DYNA_TEST);
  const setupBytes = await privateRead(resolve(root, 'data/product-catalogs-stage157.json'));
  assert.equal(hash(setupBytes), process.env.QA157_SETUP_SHA256);
  setup = JSON.parse(setupBytes.toString()); assert.equal(setup.complete, true); assert.equal(setup.pending, null);
  chrome = JSON.parse((await privateRead(resolve(root, 'data/product-catalogs-chrome157.json'))).toString());
  assert.equal(chrome.status, 'CHROME_CONFIG_COMMIT_READBACK_PASS'); assert.equal(chrome.tenant_id, setup.actor.tenant_id);
  const configBytes = await privateRead(resolve(root, '.local.json'));
  assert.equal(hash(configBytes), setup.config_sha256);
  const config = JSON.parse(configBytes.toString());
  pool = new pg.Pool({ host: '127.0.0.1', port: 55432, database: 'dynaminds', user: 'postgres', password: config.dbPassword });
  assert.deepEqual((await pool.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0],
    { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
  await absent(journal); await absent(report); await preflight();
  assert.equal((await get('/wms-lots')).policy.enabled, false);
  const products = await get('/products'); assert.equal(products.data.length, 3);
  const off = products.data.filter((p: any) => p.sku === 'QA157-' + setup.suffix + '-OFF'); assert.equal(off.length, 1);
  state = { stage: 157, phase, revision, schema_revision: schema, tenant_id: setup.actor.tenant_id,
    status: 'PREPARED', complete: false, pending: null, completed: [],
    product_id: phase === 'off' ? off[0].id : null, sku: phase === 'off' ? off[0].sku : null,
    warehouse_id: chrome.expected_settings.warehouse_ids[0], price_list_id: chrome.expected_settings.price_list_ids[0],
    catalog_id: chrome.catalog.id, location: 'QA157-' + phase.toUpperCase(), before: await capture(),
    provider_verified: false, actual_funds_transferred: false, actual_carrier_shipment: false, full_goal_complete: false };
  await wx(journal, state); await flow(); await preflight();
  assert((await privateRead(resolve(root, '.local.json'))).equals(configBytes));
  state.complete = true; state.status = 'LOCAL_COMMERCE_PASS'; await save();
  await wx(report, { stage: 157, phase, status: state.status, revision, schema_revision: schema,
    tenant_id: state.tenant_id, catalog_id: state.catalog_id, product_id: state.product_id,
    order_id: state.order_id, return_id: state.return_id, document_id: state.document.id,
    successful_requests: state.completed.length, on_hand: 3, reserved: 0, order_total_minor: 3002,
    return_credit_due_minor: 1501, return_replay_unchanged: true, original_default_products_unchanged: true,
    unknown_opening_cost_quantity: phase === 'on' ? 3 : 0, issue_cost_minor: phase === 'on' ? '202' : null,
    own_snapshot_sha256: hash(JSON.stringify(state.after)), journal_sha256: hash(await privateRead(journal)),
    provider_verified: false, actual_funds_transferred: false, actual_carrier_shipment: false,
    refund_payment_settled: false, full_goal_complete: false }, 0o644);
  process.stdout.write('QA157_' + phase + '_LOCAL_COMMERCE_PASS\n');
}
main().catch(async (e) => {
  if (state) { state.status = state.pending ? 'UNKNOWN_OR_UNCONFIRMED_DO_NOT_RETRY' : 'FAILED_DO_NOT_RETRY';
    state.failure = { step, message: e instanceof Error ? e.message : 'Unknown error' }; await save().catch(() => undefined); }
  process.stderr.write('QA157_COMMERCE_FAILED_' + phase + '_' + step + '_PRIVATE_DETAILS_WITHHELD\n'); process.exitCode = 1;
}).finally(async () => { await pool?.end(); });
