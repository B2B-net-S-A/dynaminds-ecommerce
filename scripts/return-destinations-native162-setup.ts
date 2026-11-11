/** ROOT ONLY, SOURCE AUTHORED. One-shot HTTP setup of two NEW own QA162 firms.
 * No SQL, app/db import, provider, worker, login retry,139 session or148 intake.
 * Primary cwd; APP_REVISION=QA_EXPECTED_REVISION=<current40hex>, workers OFF,
 * DYNA_LOCAL_CONFIG_PATH=<primary>/.local.json; QA162_CONFIG_SHA256=<bytes SHA>,
 * QA162_AFTER_CHECKPOINT_SHA256=<exact private additive148 checkpoint SHA>,
 * QA162_SETUP_CONFIRM=CREATE_TWO_NEW_OWN_QA162_OFF_ON_RETURN_SOURCES.
 * Private data/return-destinations-native162-setup.json + permanent .intent.json
 * are wx0600. Every mutation has fsynced pending custody BEFORE HTTP. Any failed
 * or unknown call stops; there is no resume, generic retry or skip-known-write.
 * OFF=simple; ON=A1/B2/C1 bundle, original costs0/1000/NULL via real opening.
 * Shipment and invoice use actual local DEMO stock-issue/document APIs: these
 * are simulator/ledger facts, not carrier delivery, tax issuance or payment.
 * Chrome must start/control139, scan3 and optionally upload its own evidence,
 * then separately preview/consent148. This script never owns a lease token.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Row = Record<string, any>;
const ROOT = '<workspace>/app';
const BASE = 'http://127.0.0.1:4100/api';
const CONFIG = resolve(ROOT, '.local.json');
const JOURNAL = resolve(ROOT, 'data/return-destinations-native162-setup.json');
const REPORT = resolve(ROOT, 'docs/return-destinations-native162-setup.json');
const AFTER = resolve(ROOT, 'data/return-destinations-native162-after.json');
const SCHEMA = '148_return_destinations';
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
let state: Row | undefined, lastJournalSha = '', step = 'preflight';
function uuid(v: unknown): string { assert(typeof v === 'string'); assert.match(v, /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); return v; }
async function privateRead(path: string, max = 32 * 1024 * 1024) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600);
  assert(s.size > 0 && s.size <= max); return readFile(path);
}
async function directory(path: string) { const s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(path), path); }
async function absent(path: string) { try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } throw Error('Custody already exists; no automatic resume'); }
async function wx(path: string, value: unknown) {
  await directory(dirname(path)); const bytes = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 32 * 1024 * 1024);
  const f = await open(path, 'wx', 0o600); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); } return sha(bytes);
}
async function save() {
  assert(state); assert.equal(sha(await privateRead(JOURNAL)), lastJournalSha);
  const temp = JOURNAL + '.' + randomUUID() + '.tmp';
  try { const nextSha = await wx(temp, state); await rename(temp, JOURNAL); const d = await open(dirname(JOURNAL), 'r'); try { await d.sync(); } finally { await d.close(); } lastJournalSha = nextSha; }
  finally { await unlink(temp).catch(() => undefined); }
}
function headers(a?: Row, extra: Record<string, string> = {}) {
  return { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4100', ...(a?.cookie ? { cookie: a.cookie, 'X-Workspace-ID': uuid(a.tenant_id) } : {}), ...extra };
}
async function json(r: Response): Promise<Row> { const b = Buffer.from(await r.arrayBuffer()); assert(b.length <= 8 * 1024 * 1024); return JSON.parse(b.toString('utf8')); }
function allowedGet(a: Row | undefined, route: string) {
  if (!a) return route === '/health';
  return ['/auth/me', '/warehouses', '/workspaces/billing', '/product-catalogs/options', '/wms-lots', '/wms-lots/opening-scope',
    '/wms-lots/positions', '/wms-lots/valuation', '/return-assistant/statuses?limit=50', '/return-assistant/options'].includes(route)
    || a.components.some((p: Row) => route === '/products/' + p.id) || route === '/products/' + a.sale_product_id
    || route === '/orders/' + a.order_id || route === '/returns/' + a.return_id
    || route === '/return-assistant/history?return_id=' + a.return_id + '&limit=50'
    || route === '/wms-lots/orders/' + a.order_id + '/allocations'
    || route === '/wms-lots/orders/' + a.order_id + '/return-fragments';
}
async function get(a: Row | undefined, route: string) {
  assert(allowedGet(a, route)); const r = await fetch(BASE + route, { headers: headers(a), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200); return json(r);
}
async function health() {
  assert.equal(sha(await privateRead(CONFIG, 65536)), process.env.QA162_CONFIG_SHA256);
  const h = await get(undefined, '/health'); assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, SCHEMA); assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  for (const k of ['return_assistant_available', 'warehouse_inventory_policies_available', 'return_destination_statuses_available', 'return_destinations_available']) assert.equal(h[k], true);
}
async function identity(a: Row) { const me = await get(a, '/auth/me'); assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.email, a.email); assert.equal(me.user.role, 'admin'); }
function allowedWrite(a: Row, method: string, route: string) {
  if (method === 'PATCH') return route === '/orders/' + a.order_id + '/status';
  assert.equal(method, 'POST');
  return ['/auth/signup', '/workspaces/billing/preview', '/warehouses', '/product-catalogs/previews', '/products', '/orders', '/packing/stations', '/return-assistant/statuses/previews'].includes(route)
    || route === '/workspaces/billing/previews/' + a.billing_preview?.id + '/commit'
    || route === '/product-catalogs/previews/' + a.catalog_preview?.id + '/commit'
    || route === '/warehouse-inventory-policies/warehouses/' + a.custody_warehouse_id + '/previews'
    || route === '/warehouse-inventory-policies/previews/' + a.policies.custody?.preview.id + '/commit'
    || Object.values(a.statuses).some((s: any) => route === '/return-assistant/statuses/previews/' + s.preview.id + '/commit')
    || (a.on && (route === '/wms-lots/opening-previews' || route === '/wms-lots/opening-previews/' + a.opening?.id + '/activate'))
    || ['/payments', '/scan', '/ship-demo', '/documents', '/returns'].some(s => route === '/orders/' + a.order_id + s);
}
async function mutate(a: Row, label: string, method: 'POST' | 'PATCH', route: string, body: Row, expected: number,
  assign: (d: Row, r: Response) => void = () => undefined, extra: Record<string, string> = {}) {
  step = a.label + ':' + label; assert(state && state.pending === null); assert(!state.completed.some((c: Row) => c.actor === a.label && c.label === label));
  assert(allowedWrite(a, method, route)); await health(); if (route !== '/auth/signup') await identity(a);
  const raw = JSON.stringify(body); state.pending = { actor: a.label, label, method, route, raw_body: raw, extra_headers: extra, expected_status: expected, response: null };
  state.status = 'PENDING_WRITE'; await save();
  let r: Response, d: Row;
  try { r = await fetch(BASE + route, { method, headers: headers(a, extra), body: raw, redirect: 'error', signal: AbortSignal.timeout(90000) }); d = await json(r); }
  catch { state.status = 'UNKNOWN_RESULT_DO_NOT_RETRY'; await save(); throw Error('Unconfirmed write'); }
  state.pending.response = { status: r.status, data: d }; await save(); assert.equal(r.status, expected);
  assign(d, r); await save(); state.completed.push({ ...state.pending, response_sha256: fp(d) }); state.pending = null; state.status = 'CONFIRMED'; await save();
}
async function status(a: Row, effect: 'sale' | 'custody' | 'reject') {
  const rejected = effect === 'reject', settings = { name: 'QA162 ' + a.label + ' ' + effect + ' ' + state!.suffix, color: effect === 'sale' ? '#16a34a' : effect === 'custody' ? '#d97706' : '#dc2626', active: true,
    decision: rejected ? 'reject' : 'accept', inventory_effect: rejected ? 'none' : effect, warehouse_id: rejected ? null : effect === 'sale' ? a.sale_warehouse_id : a.custody_warehouse_id,
    warehouse_policy_version: rejected ? null : effect === 'sale' ? '0' : '1', default_location: rejected ? null : effect === 'sale' ? 'RD-sale' : 'RD-custody' };
  const request = { client_key: randomUUID(), kind: 'create', settings };
  await mutate(a, effect + '-status-preview', 'POST', '/return-assistant/statuses/previews', request, 201, d => {
    assert.equal(d.available, true); assert.equal(d.can_manage, true); assert.equal(d.reused, false); assert.equal(d.preview.ready, true); assert.equal(d.preview.can_commit, true);
    assert.deepEqual(d.preview.request, request); assert.deepEqual(d.preview.after.settings, settings); uuid(d.preview.id); a.statuses[effect] = { preview: d.preview };
  });
  const p = a.statuses[effect].preview;
  await mutate(a, effect + '-status-commit', 'POST', '/return-assistant/statuses/previews/' + p.id + '/commit', { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true }, 201, d => {
    assert.equal(d.reused, false); assert.equal(d.operation.preview_id, p.id); assert.deepEqual(d.status, d.operation.after); assert.deepEqual(d.status.settings, settings); assert.equal(d.status.version, '1');
    a.statuses[effect].operation = d.operation; a.statuses[effect].status = d.status;
  });
}
async function setup(a: Row) {
  await mutate(a, 'signup', 'POST', '/auth/signup', { name: 'QA162 ' + a.label + ' Operator', email: a.email, password: a.password,
    organization: { name: 'QA162 Destinations ' + a.label + ' ' + state!.suffix, currency: 'PLN', locale: 'pl-PL' } }, 201, (d, r) => {
    a.user_id = uuid(d.user.id); a.tenant_id = uuid(d.user.tenant_id); assert.equal(d.user.role, 'admin'); a.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; assert.match(a.cookie, /^dyna_session=[A-Za-z0-9_.-]+$/);
  });
  const wh = await get(a, '/warehouses'); assert.equal(wh.data.length, 1); a.sale_warehouse_id = uuid(wh.data[0].id); await save();
  const billing = await get(a, '/workspaces/billing'); assert.equal(billing.mode, 'local_estimate'); assert.equal(billing.current_plan, 'starter'); assert.equal(billing.account, null);
  await mutate(a, 'enterprise-preview', 'POST', '/workspaces/billing/preview', { kind: 'activate', plan: 'enterprise' }, 200, d => { assert.equal(d.mode, 'local_estimate'); assert.equal(d.can_commit, true); assert.deepEqual(d.blockers, []); a.billing_preview = d; uuid(d.id); });
  await mutate(a, 'enterprise-commit', 'POST', '/workspaces/billing/previews/' + a.billing_preview.id + '/commit', {}, 200, d => { assert.equal(d.mode, 'local_estimate'); assert.equal(d.plan, 'enterprise'); });
  await mutate(a, 'custody-warehouse', 'POST', '/warehouses', { name: 'QA162 ' + a.label + ' Custody', code: 'RD-' + a.label + '-' + state!.suffix }, 200, d => { assert.equal(d.tenant_id, a.tenant_id); a.custody_warehouse_id = uuid(d.id); });
  const options = await get(a, '/product-catalogs/options'); assert.equal(options.available, true); assert.equal(options.can_manage, true);
  const settings = { name: 'QA162 Physical Pool ' + a.label, active: true, languages: ['pl'], default_language: 'pl', warehouse_ids: [a.sale_warehouse_id, a.custody_warehouse_id].sort(), price_list_ids: [] };
  await mutate(a, 'catalog-preview', 'POST', '/product-catalogs/previews', { client_key: randomUUID(), kind: 'create', settings }, 201, d => { assert.equal(d.preview.ready, true); assert.deepEqual(d.preview.after, settings); a.catalog_preview = d.preview; });
  await mutate(a, 'catalog-commit', 'POST', '/product-catalogs/previews/' + a.catalog_preview.id + '/commit', { client_key: randomUUID(), scope_hash: a.catalog_preview.scope_hash, confirmed: true }, 201, d => { assert.deepEqual(d.catalog.settings, settings); a.catalog = d.catalog; uuid(a.catalog.id); });
  await mutate(a, 'custody-policy-preview', 'POST', '/warehouse-inventory-policies/warehouses/' + a.custody_warehouse_id + '/previews', { client_key: randomUUID(), version: '0', usage: 'custody', enabled: true }, 201, d => { assert.equal(d.preview.ready, true); assert.deepEqual(d.preview.snapshot.blockers, []); a.policies.custody = { preview: d.preview }; });
  const pp = a.policies.custody.preview;
  await mutate(a, 'custody-policy-commit', 'POST', '/warehouse-inventory-policies/previews/' + pp.id + '/commit', { client_key: randomUUID(), scope_hash: pp.scope_hash, confirmed: true }, 201, d => { assert.deepEqual(d.operation.after, { usage: 'custody', enabled: true, version: '1' }); a.policies.custody.operation = d.operation; });
  for (const effect of ['sale', 'custody', 'reject'] as const) await status(a, effect);
  const specs = a.on ? [{ letter: 'A', recipe: 1, quantity: 10, cost: '0' }, { letter: 'B', recipe: 2, quantity: 20, cost: '1000' }, { letter: 'C', recipe: 1, quantity: 10, cost: null }] : [{ letter: 'A', recipe: 1, quantity: 10, cost: null }];
  // Identical per-letter SKU across the two NEW tenants is intentional; each
  // commercial order also has two separately priced lines of the SAME SKU.
  for (const s of specs) {
    const sku = 'QA162-' + s.letter + '-' + state!.suffix;
    await mutate(a, 'product-' + s.letter, 'POST', '/products', { catalog_id: a.catalog.id, sku, name: 'QA162 Original ' + s.letter, kind: 'simple', price: 1000, vat: 23, warehouse_id: a.sale_warehouse_id, quantity: s.quantity, location: 'RD-original' }, 201, d => {
      assert.equal(d.catalog_id, a.catalog.id); a.components.push({ id: uuid(d.id), sku, recipe_quantity: s.recipe, initial_quantity: s.quantity, unit_cost_minor: s.cost });
    });
  }
  if (a.on) {
    await mutate(a, 'bundle', 'POST', '/products', { catalog_id: a.catalog.id, sku: 'QA162-BUNDLE-' + state!.suffix, name: 'QA162 A1 B2 C1 Original Bundle', kind: 'bundle', price: 1000, vat: 23, warehouse_id: a.sale_warehouse_id, quantity: 0, components: a.components.map((p: Row) => ({ product_id: p.id, quantity: p.recipe_quantity })) }, 201, d => { assert.equal(d.catalog_id, a.catalog.id); a.sale_product_id = uuid(d.id); });
    const scope = await get(a, '/wms-lots/opening-scope'); assert.equal(scope.meta.cursor, null); assert.deepEqual(scope.active_blockers, []); assert.equal(scope.data.length, 3);
    const lines = scope.data.map((bin: Row) => { const p = a.components.find((v: Row) => v.id === bin.product_id); assert(p); assert.equal(bin.warehouse_id, a.sale_warehouse_id); assert.equal(bin.location, 'RD-original'); assert.equal(bin.quantity, p.initial_quantity);
      return { warehouse_id: bin.warehouse_id, product_id: bin.product_id, location: bin.location, quantity: bin.quantity, stock_version: String(bin.stock_version), lot_code: 'QA162-' + p.id, unit_cost_minor: p.unit_cost_minor }; });
    await mutate(a, 'opening-preview', 'POST', '/wms-lots/opening-previews', { client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Own actual known0/1000/unknown opening before any commerce', lines }, 201, d => { assert.equal(d.preview.ready, true); a.opening = d.preview; });
    await mutate(a, 'opening-activate', 'POST', '/wms-lots/opening-previews/' + a.opening.id + '/activate', { client_key: randomUUID(), scope_hash: a.opening.scope_hash, confirmed: true, ack_unknown_costs: true }, 201);
  } else { a.sale_product_id = a.components[0].id; await save(); }
  a.policy = (await get(a, '/wms-lots')).policy; assert.equal(a.policy.enabled, a.on); await save();
  await mutate(a, 'order', 'POST', '/orders', { source: 'manual', customer_name: 'QA162 Own Local Buyer', email: 'qa162-customer@example.test', address: { street: 'Testowa 162', city: 'Warszawa', postal_code: '00-162', country: 'PL', phone: '500000162' }, warehouse_id: a.sale_warehouse_id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: a.sale_product_id, quantity: 3 }], manual_lines: [{ product_id: a.sale_product_id, quantity: 1, line_total: 1000 }, { product_id: a.sale_product_id, quantity: 2, line_total: 3401 }] }, 201, d => { a.order_id = uuid(d.id); }, { 'Idempotency-Key': randomUUID() });
  let order = await get(a, '/orders/' + a.order_id); assert.equal(order.items.length, 2); assert.equal(order.total, 4401); assert.deepEqual(order.items.map((i: Row) => i.line_total).sort((x: number, y: number) => x - y), [1000, 3401]);
  a.commercial_items = order.items; await save();
  await mutate(a, 'local-prepaid-declaration', 'POST', '/orders/' + a.order_id + '/payments', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt', amount: 4401, currency: 'PLN', method: 'other', reference: 'QA162 synthetic local ledger declaration', note: 'No bank, provider or money movement', confirmed: true }, 200);
  await mutate(a, 'picking', 'PATCH', '/orders/' + a.order_id + '/status', { status: 'picking' }, 200);
  if (a.on) {
    const allocations = await get(a, '/wms-lots/orders/' + a.order_id + '/allocations'); assert.equal(allocations.meta.cursor, null); assert.equal(allocations.data.length, 3); a.allocations = allocations.data; await save();
    for (const allocation of allocations.data) { const p = a.components.find((v: Row) => v.id === allocation.product_id); assert(p); assert.equal(allocation.warehouse_id, a.sale_warehouse_id); assert.equal(allocation.location, 'RD-original'); assert.equal(allocation.quantity, 3 * p.recipe_quantity); uuid(allocation.layer_id);
      for (let n = 0; n < allocation.quantity; n++) await mutate(a, 'scan-' + p.id + '-' + n, 'POST', '/orders/' + a.order_id + '/scan', { client_key: randomUUID(), code: p.sku, location: allocation.location, layer_id: allocation.layer_id }, 200);
    }
  } else for (let n = 0; n < 3; n++) await mutate(a, 'scan-simple-' + n, 'POST', '/orders/' + a.order_id + '/scan', { client_key: randomUUID(), code: a.components[0].sku, location: 'RD-original' }, 200);
  await mutate(a, 'packed', 'PATCH', '/orders/' + a.order_id + '/status', { status: 'packed' }, 200);
  order = await get(a, '/orders/' + a.order_id); assert.equal(order.status, 'packed'); assert.equal(order.payment.received, 4401); assert.equal(order.payment.amount_due, 0); assert(order.items.every((i: Row) => i.scanned === i.quantity));
  await mutate(a, 'local-demo-physical-issue', 'POST', '/orders/' + a.order_id + '/ship-demo', {}, 200);
  order = await get(a, '/orders/' + a.order_id); assert.equal(order.status, 'shipped'); assert.equal(order.shipments.length, 1); assert.equal(order.shipments[0].mode, 'demo'); assert(order.shipments[0].dispatched_at);
  await mutate(a, 'local-demo-invoice', 'POST', '/orders/' + a.order_id + '/documents', { kind: 'invoice' }, 200, d => { uuid(d.id); assert.equal(d.mode, 'demo'); assert.equal(d.kind, 'invoice'); a.invoice = d; });
  await mutate(a, 'original-full-rma', 'POST', '/orders/' + a.order_id + '/returns', { client_key: randomUUID(), reason: 'QA162 inspect genuine issued local goods into sale/custody/reject', shipping_refund: 0, items: order.items.map((i: Row) => ({ item_id: i.id, quantity: i.quantity })) }, 201, d => { a.return_id = uuid(d.id); a.rma_id = a.return_id; assert(typeof d.number === 'string' && d.number.length); a.rma_number = d.number; });
  await mutate(a, 'own-return-station', 'POST', '/packing/stations', { client_key: randomUUID(), code: 'RD-' + a.label + '-' + state!.suffix, label: 'QA162 Own ' + a.label + ' Return Desk', enabled: true }, 201, d => { a.station = d.station; uuid(a.station.id); assert.equal(a.station.enabled, true); });
  const rma = await get(a, '/returns/' + a.return_id); assert.equal(rma.state, 'requested'); assert.equal(rma.refund_amount, 0); assert.equal(rma.receipt, null); assert.equal(rma.items.length, 2);
  const cheap = order.items.find((i: Row) => i.line_total === 1000), expensive = order.items.find((i: Row) => i.line_total === 3401); assert(cheap && expensive);
  a.intended = { accepted: 2, sale: 1, custody: 1, rejected: 1, refund_minor: 2700, original_cash_minor: 4401, shipping_refund_minor: 0,
    parts: [{ item_id: cheap.id, quantity: 1, effect: 'sale', refund_minor: 1000 }, { item_id: expensive.id, quantity: 1, effect: 'custody', refund_minor: 1700 }, { item_id: expensive.id, quantity: 1, effect: 'none', refund_minor: 0 }].map(p => { const effect = p.effect === 'none' ? 'reject' : p.effect, status = a.statuses[effect].status; return { ...p, part_id: randomUUID(), status_id: status.id, status_version: status.version }; }) };
  const products = []; for (const p of a.components) { const dto = await get(a, '/products/' + p.id); const stock = dto.stock.find((s: Row) => s.warehouse_id === a.sale_warehouse_id); assert(stock); assert.equal(stock.on_hand, p.initial_quantity - 3 * p.recipe_quantity); assert.equal(stock.reserved, 0); products.push(dto); }
  const fragments = a.on ? await get(a, '/wms-lots/orders/' + a.order_id + '/return-fragments') : null;
  if (fragments) { assert.equal(fragments.meta.cursor, null); assert.equal(fragments.data.length, 3); }
  const positions = a.on ? await get(a, '/wms-lots/positions') : null; if (positions) { assert.equal(positions.meta.cursor, null); assert.equal(positions.data.length, 3); }
  const statuses = await get(a, '/return-assistant/statuses?limit=50'); assert.equal(statuses.next_cursor, null); assert.equal(statuses.data.length, 3);
  const sessions = await get(a, '/return-assistant/history?return_id=' + a.return_id + '&limit=50'); assert.equal(sessions.next_cursor, null); assert.deepEqual(sessions.data, []);
  a.source_born = { order: await get(a, '/orders/' + a.order_id), return_case: rma, products, sale_product: await get(a, '/products/' + a.sale_product_id), policy: a.policy,
    positions: positions?.data ?? [], return_fragments: fragments?.data ?? [], valuation: a.on ? await get(a, '/wms-lots/valuation') : null, statuses };
  a.complete = true; await save();
}
async function main() {
  assert.equal(process.argv.length, 2); assert.equal(await realpath(process.cwd()), ROOT); assert.equal(await realpath(ROOT), ROOT);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, CONFIG); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.equal(process.env.DYNA_TEST, undefined); assert.equal(process.env.DATABASE_URL, undefined); assert.equal(process.env.DYNA_PREVIEW_PORT, undefined);
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision); assert.match(process.env.QA162_CONFIG_SHA256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(process.env.QA162_SETUP_CONFIRM, 'CREATE_TWO_NEW_OWN_QA162_OFF_ON_RETURN_SOURCES');
  for (const name of ['data', 'docs']) await directory(resolve(ROOT, name)); await absent(JOURNAL); await absent(JOURNAL + '.intent.json'); await absent(REPORT);
  assert.match(process.env.QA162_AFTER_CHECKPOINT_SHA256 ?? '', /^[a-f0-9]{64}$/); const afterBytes = await privateRead(AFTER, 512 * 1024 * 1024); assert.equal(sha(afterBytes), process.env.QA162_AFTER_CHECKPOINT_SHA256);
  const after = JSON.parse(afterBytes.toString('utf8')); assert.equal(after.stage, 162); assert.equal(after.phase, 'after'); assert.equal(after.status, 'EXACT_ADDITIVE_MIGRATION_VERIFIED'); assert.equal(after.schema, SCHEMA); assert.equal(after.revision, revision); assert.equal(after.capture.files['.local.json'].sha256, process.env.QA162_CONFIG_SHA256);
  await health(); const suffix = randomUUID().slice(0, 8);
  const actor = (on: boolean): Row => ({ label: on ? 'ON' : 'OFF', on, email: 'qa162-' + (on ? 'on' : 'off') + '-' + suffix + '@demo.local', password: 'QA162-' + randomBytes(24).toString('hex'), cookie: '', components: [], policies: {}, statuses: {}, complete: false });
  state = { stage: 162, schema_revision: SCHEMA, runtime_revision: revision, config_sha256: process.env.QA162_CONFIG_SHA256, after_migration_checkpoint_sha256: process.env.QA162_AFTER_CHECKPOINT_SHA256,
    suffix, status: 'PRIVATE_PREPARED', pending: null, completed: [], off: actor(false), on: actor(true), complete: false };
  lastJournalSha = await wx(JOURNAL, state); await wx(JOURNAL + '.intent.json', { stage: 162, revision, schema_revision: SCHEMA, journal_sha256: lastJournalSha, created_at: new Date().toISOString() });
  await setup(state.off); await setup(state.on); await health(); await identity(state.off); await identity(state.on); assert.equal(state.pending, null);
  state.complete = true; state.status = 'OWN_OFF_ON_SOURCES_READY_FOR_CHROME'; await save();
  const report = { stage: 162, status: state.status, revision, schema_revision: SCHEMA, journal_sha256: lastJournalSha, config_preserved: true,
    after_migration_checkpoint_sha256: state.after_migration_checkpoint_sha256, confirmed_http_calls: state.completed.length,
    firms: [state.off, state.on].map(a => ({ on: a.on, tenant_id: a.tenant_id, user_id: a.user_id, order_id: a.order_id, return_id: a.return_id, station_id: a.station.id,
      catalog_id: a.catalog.id, sale_warehouse_id: a.sale_warehouse_id, custody_warehouse_id: a.custody_warehouse_id, components: a.components.length,
      status_ids: Object.fromEntries(Object.entries(a.statuses).map(([k, v]: [string, any]) => [k, v.status.id])), original_sale_minor: 4401, intended_refund_minor: 2700,
      original_wms_costs: a.on ? ['known_zero', 'known_1000', 'unknown'] : [], source_api_sha256: fp(a.source_born) })),
    assistant_sessions_created: 0, intake_previews_created: 0, intake_receipts_created: 0, provider_requests: 0,
    shipment: 'LOCAL_DEMO_ACTUAL_STOCK_ISSUE', invoice: 'LOCAL_DEMO_DOCUMENT', payment: 'SYNTHETIC_LOCAL_LEDGER_DECLARATION',
    old_row_preservation_verified_here: false, native_chrome_verified: false, full_goal_complete: false };
  await wx(REPORT, report); console.log(JSON.stringify({ stage: 162, status: report.status, journal_sha256: lastJournalSha, confirmed_http_calls: state.completed.length }));
}
main().catch(async (error: unknown) => {
  if (state && lastJournalSha) { state.status = state.pending ? 'UNKNOWN_OR_UNCONFIRMED_DO_NOT_RETRY' : 'FAILED_NO_RESUME'; await save().catch(() => undefined); }
  const frame = error instanceof Error ? error.stack?.match(/return-destinations-native162-setup\.ts:(\d+):(\d+)/) : undefined;
  console.log(JSON.stringify({ stage: 162, status: 'FAIL', step, source_line: frame ? Number(frame[1]) : null, source_column: frame ? Number(frame[2]) : null, private_details_withheld: true })); process.exitCode = 1;
});
