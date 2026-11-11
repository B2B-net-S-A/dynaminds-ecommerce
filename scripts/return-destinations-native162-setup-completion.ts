/** ROOT ONLY, SOURCE AUTHORED. Bounded completion of ONE exact known49-ACK setup.
 * Never rerun original setup; its FAILED_NO_RESUME journal remains immutable.
 * NEW companion copies the approved private basis once; only ON scans onward
 * execute, with fsynced pending before every mutation. No resume after failure.
 * cwd=primary; current APP_REVISION=QA_EXPECTED_REVISION, workersOFF/schema148;
 * QA162_CONFIG_SHA256 and QA162_AFTER_CHECKPOINT_SHA256 pin original inputs;
 * QA162_FAILED_SETUP_SHA256 must equal the literal known failed basis below;
 * QA162_COMPLETION_CONFIRM=COMPLETE_ONLY_KNOWN_QA162_ON_PICKING_AFTER_49_ACK.
 * No SQL/provider/worker/139 session/148 intake; DEMO issuance explicitly local.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Row = Record<string, any>;
const ROOT = '<workspace>/app', BASE = 'http://127.0.0.1:4100/api';
const CONFIG = resolve(ROOT, '.local.json'), ORIGINAL = resolve(ROOT, 'data/return-destinations-native162-setup.json');
const AFTER = resolve(ROOT, 'data/return-destinations-native162-after.json');
const JOURNAL = resolve(ROOT, 'data/return-destinations-native162-setup-completion.json');
const REPORT = resolve(ROOT, 'docs/return-destinations-native162-setup-completion.json');
const ORIGINAL_SHA = '189961869a10b03c5642221b810243bbe11c75734fb69a31474519be72c502dd';
const SCHEMA = '148_return_destinations', revision = process.env.QA_EXPECTED_REVISION ?? '';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex'), fp = (v: unknown) => sha(JSON.stringify(v));
let state: Row | undefined, lastSha = '', step = 'preflight';
function uuid(v: unknown): string { assert(typeof v === 'string'); assert.match(v, /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); return v; }
async function directory(path: string) { const s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(path), path); }
async function read(path: string, max = 32 * 1024 * 1024) { const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600); assert(s.size > 0 && s.size <= max); return readFile(path); }
async function absent(path: string) { try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } throw Error('Exclusive companion exists; no retry'); }
async function wx(path: string, value: unknown) { await directory(dirname(path)); const b = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(b) <= 32 * 1024 * 1024); const f = await open(path, 'wx', 0o600); try { await f.writeFile(b); await f.sync(); } finally { await f.close(); } const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); } return sha(b); }
async function save() { assert(state); assert.equal(sha(await read(JOURNAL)), lastSha); const temp = JOURNAL + '.' + randomUUID() + '.tmp'; try { const next = await wx(temp, state); await rename(temp, JOURNAL); const d = await open(dirname(JOURNAL), 'r'); try { await d.sync(); } finally { await d.close(); } lastSha = next; } finally { await unlink(temp).catch(() => undefined); } }
async function inputs() { assert.equal(sha(await read(ORIGINAL)), ORIGINAL_SHA); assert.equal(sha(await read(CONFIG, 65536)), process.env.QA162_CONFIG_SHA256); }
function headers(a?: Row) { return { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4100', ...(a ? { cookie: a.cookie, 'X-Workspace-ID': uuid(a.tenant_id) } : {}) }; }
async function json(r: Response): Promise<Row> { const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length <= 8 * 1024 * 1024); return JSON.parse(bytes.toString('utf8')); }
async function get(a: Row | undefined, route: string) {
  assert(a ? ['/auth/me', '/wms-lots', '/wms-lots/positions', '/wms-lots/valuation', '/return-assistant/statuses?limit=50', '/return-assistant/options'].includes(route)
    || a.components.some((p: Row) => route === '/products/' + p.id) || route === '/products/' + a.sale_product_id
    || route === '/orders/' + a.order_id || route === '/returns/' + a.return_id
    || route === '/wms-lots/orders/' + a.order_id + '/allocations' || route === '/wms-lots/orders/' + a.order_id + '/return-fragments'
    || route === '/return-assistant/history?return_id=' + a.return_id + '&limit=50' : route === '/health');
  const r = await fetch(BASE + route, { headers: headers(a), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) }); assert.equal(r.status, 200); return json(r);
}
async function health() { await inputs(); const h = await get(undefined, '/health'); assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local'); assert.equal(h.revision, revision); assert.equal(h.schema_revision, SCHEMA); assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false); for (const k of ['return_assistant_available', 'warehouse_inventory_policies_available', 'return_destination_statuses_available', 'return_destinations_available']) assert.equal(h[k], true); }
async function identity(a: Row) { const m = await get(a, '/auth/me'); assert.equal(m.user.id, a.user_id); assert.equal(m.user.tenant_id, a.tenant_id); assert.equal(m.user.role, 'admin'); assert.equal(m.user.email, a.email); }
const common = ['signup', 'enterprise-preview', 'enterprise-commit', 'custody-warehouse', 'catalog-preview', 'catalog-commit', 'custody-policy-preview', 'custody-policy-commit', 'sale-status-preview', 'sale-status-commit', 'custody-status-preview', 'custody-status-commit', 'reject-status-preview', 'reject-status-commit'];
const offLabels = [...common, 'product-A', 'order', 'local-prepaid-declaration', 'picking', 'scan-simple-0', 'scan-simple-1', 'scan-simple-2', 'packed', 'local-demo-physical-issue', 'local-demo-invoice', 'original-full-rma', 'own-return-station'];
const onLabels = [...common, 'product-A', 'product-B', 'product-C', 'bundle', 'opening-preview', 'opening-activate', 'order', 'local-prepaid-declaration', 'picking'];
function basisValid(b: Row) {
  assert.equal(b.stage, 162); assert.equal(b.schema_revision, SCHEMA); assert.equal(b.runtime_revision, revision); assert.equal(b.config_sha256, process.env.QA162_CONFIG_SHA256);
  assert.equal(b.after_migration_checkpoint_sha256, process.env.QA162_AFTER_CHECKPOINT_SHA256); assert.equal(b.status, 'FAILED_NO_RESUME'); assert.equal(b.pending, null); assert.equal(b.complete, false);
  assert.equal(b.off.complete, true); assert.equal(b.on.complete, false); assert.equal(b.off.on, false); assert.equal(b.on.on, true); assert.equal(b.off.label, 'OFF'); assert.equal(b.on.label, 'ON'); assert.notEqual(uuid(b.off.tenant_id), uuid(b.on.tenant_id)); assert.notEqual(uuid(b.off.user_id), uuid(b.on.user_id));
  assert.deepEqual(b.completed.map((c: Row) => [c.actor, c.label]), [...offLabels.map(label => ['OFF', label]), ...onLabels.map(label => ['ON', label])]); assert.equal(b.completed.length, 49);
  for (const receipt of b.completed) { assert.equal(receipt.response.status, receipt.expected_status); assert.equal(receipt.response_sha256, fp(receipt.response.data)); assert(['POST', 'PATCH'].includes(receipt.method)); assert(receipt.raw_body); JSON.parse(receipt.raw_body); }
  assert.equal(b.on.order_id, b.completed.at(-1).route.split('/')[2]); assert.equal(b.completed.at(-1).method, 'PATCH'); assert.deepEqual(JSON.parse(b.completed.at(-1).raw_body), { status: 'picking' });
  for (const field of ['return_id', 'rma_id', 'station', 'source_born', 'allocations', 'invoice', 'intended']) assert.equal(b.on[field], undefined);
}
async function graph(a: Row) {
  const products: Row[] = []; for (const p of a.components) products.push(await get(a, '/products/' + p.id));
  const fs = a.on ? await get(a, '/wms-lots/orders/' + a.order_id + '/return-fragments') : null;
  const ps = a.on ? await get(a, '/wms-lots/positions') : null;
  for (const page of [fs, ps]) if (page) { assert.equal(page.meta.cursor, null); assert.equal(page.data.length, 3); }
  return { order: await get(a, '/orders/' + a.order_id), return_case: await get(a, '/returns/' + a.return_id), products,
    sale_product: await get(a, '/products/' + a.sale_product_id), policy: (await get(a, '/wms-lots')).policy,
    positions: ps?.data ?? [], return_fragments: fs?.data ?? [], valuation: a.on ? await get(a, '/wms-lots/valuation') : null,
    statuses: await get(a, '/return-assistant/statuses?limit=50') };
}
async function validateOriginal(b: Row) {
  step = 'validate-known-off'; await identity(b.off); assert.deepEqual(await graph(b.off), b.off.source_born);
  const history = await get(b.off, '/return-assistant/history?return_id=' + b.off.return_id + '&limit=50'); assert.equal(history.next_cursor, null); assert.deepEqual(history.data, []);
  step = 'validate-known-on-picking'; await identity(b.on); const order = await get(b.on, '/orders/' + b.on.order_id);
  assert.deepEqual(order, b.completed.at(-1).response.data); assert.equal(order.status, 'picking'); assert.equal(order.payment.received, 4401); assert.equal(order.payment.amount_due, 0); assert.equal(order.items.length, 2);
  assert.deepEqual(order.items.map((i: Row) => [i.id, i.product_id, i.quantity, i.line_total, i.components]), b.on.commercial_items.map((i: Row) => [i.id, i.product_id, i.quantity, i.line_total, i.components]));
  assert(order.items.every((i: Row) => i.scanned === 0)); assert.deepEqual(order.shipments, []); assert.deepEqual(order.documents, []); assert.equal(order.returns.case_count, 0);
  assert.deepEqual((await get(b.on, '/wms-lots')).policy, b.on.policy); assert.equal(b.on.policy.enabled, true); assert.equal(b.on.components.length, 3);
  assert.deepEqual(b.on.components.map((p: Row) => [p.recipe_quantity, p.initial_quantity, p.unit_cost_minor]), [[1, 10, '0'], [2, 20, '1000'], [1, 10, null]]);
  const statuses = await get(b.on, '/return-assistant/statuses?limit=50'); assert.equal(statuses.next_cursor, null); assert.equal(statuses.data.length, 3);
  for (const entry of Object.values(b.on.statuses) as Row[]) assert.deepEqual(statuses.data.find((s: Row) => s.id === entry.status.id), entry.status);
  const page = await get(b.on, '/wms-lots/orders/' + b.on.order_id + '/allocations'); assert.equal(page.meta.cursor, null); assert.equal(page.data.length, 3); assert.deepEqual(page.blockers, []); assert.equal(page.can_scan, true);
  for (const allocation of page.data) { const p = b.on.components.find((v: Row) => v.id === allocation.product_id); assert(p); assert.equal(allocation.warehouse_id, b.on.sale_warehouse_id); assert.equal(allocation.location, 'RD-original'); assert.equal(allocation.quantity, 3 * p.recipe_quantity); assert.equal(allocation.scanned, 0); assert.equal(allocation.state, 'active'); uuid(allocation.layer_id);
    const product = await get(b.on, '/products/' + p.id); assert.equal(product.catalog_id, b.on.catalog.id); const stock = product.stock.find((s: Row) => s.warehouse_id === b.on.sale_warehouse_id); assert(stock); assert.equal(stock.on_hand, p.initial_quantity); assert.equal(stock.reserved, allocation.quantity);
  }
  return page.data as Row[];
}
async function mutate(label: string, method: 'POST' | 'PATCH', suffix: string, body: Row, expected: number, assign: (d: Row) => void = () => undefined) {
  assert(state && state.pending === null); const a = state.on; step = 'ON:' + label; assert(!state.completed.some((c: Row) => c.actor === 'ON' && c.label === label));
  assert(method === 'PATCH' ? suffix === '/status' && label === 'packed' : ['/scan', '/ship-demo', '/documents', '/returns', 'station'].includes(suffix));
  const route = suffix === 'station' ? '/packing/stations' : '/orders/' + a.order_id + suffix;
  await health(); await identity(a); const raw = JSON.stringify(body); state.pending = { actor: 'ON', label, method, route, raw_body: raw, extra_headers: {}, expected_status: expected, response: null }; state.status = 'PENDING_WRITE'; await save();
  let r: Response, d: Row; try { r = await fetch(BASE + route, { method, headers: headers(a), body: raw, redirect: 'error', signal: AbortSignal.timeout(90000) }); d = await json(r); }
  catch { state.status = 'UNKNOWN_RESULT_DO_NOT_RETRY'; await save(); throw Error('Unconfirmed completion'); }
  state.pending.response = { status: r.status, data: d }; await save(); assert.equal(r.status, expected); assign(d); await save();
  state.completed.push({ ...state.pending, response_sha256: fp(d) }); state.pending = null; state.status = 'CONFIRMED'; await save();
}
async function completion() {
  const a = state!.on;
  for (const allocation of a.allocations) { const p = a.components.find((v: Row) => v.id === allocation.product_id); assert(p);
    for (let n = 0; n < allocation.quantity; n++) await mutate('scan-' + p.id + '-' + n, 'POST', '/scan', { client_key: randomUUID(), code: p.sku, location: allocation.location, layer_id: allocation.layer_id }, 200);
  }
  await mutate('packed', 'PATCH', '/status', { status: 'packed' }, 200);
  let order = await get(a, '/orders/' + a.order_id); assert.equal(order.status, 'packed'); assert(order.items.every((i: Row) => i.scanned === i.quantity));
  await mutate('local-demo-physical-issue', 'POST', '/ship-demo', {}, 200);
  order = await get(a, '/orders/' + a.order_id); assert.equal(order.status, 'shipped'); assert.equal(order.shipments.length, 1); assert.equal(order.shipments[0].mode, 'demo'); assert(order.shipments[0].dispatched_at);
  await mutate('local-demo-invoice', 'POST', '/documents', { kind: 'invoice' }, 200, d => { uuid(d.id); assert.equal(d.mode, 'demo'); assert.equal(d.kind, 'invoice'); a.invoice = d; });
  await mutate('original-full-rma', 'POST', '/returns', { client_key: randomUUID(), reason: 'QA162 inspect genuine issued local goods into sale/custody/reject', shipping_refund: 0, items: order.items.map((i: Row) => ({ item_id: i.id, quantity: i.quantity })) }, 201, d => { a.return_id = uuid(d.id); a.rma_id = a.return_id; assert(typeof d.number === 'string' && d.number.length); a.rma_number = d.number; });
  await mutate('own-return-station', 'POST', 'station', { client_key: randomUUID(), code: 'RD-ON-' + state!.suffix, label: 'QA162 Own ON Return Desk', enabled: true }, 201, d => { a.station = d.station; uuid(a.station.id); assert.equal(a.station.enabled, true); });
  const cheap = order.items.find((i: Row) => i.line_total === 1000), expensive = order.items.find((i: Row) => i.line_total === 3401); assert(cheap && expensive);
  a.intended = { accepted: 2, sale: 1, custody: 1, rejected: 1, refund_minor: 2700, original_cash_minor: 4401, shipping_refund_minor: 0,
    parts: [{ item_id: cheap.id, quantity: 1, effect: 'sale', refund_minor: 1000 }, { item_id: expensive.id, quantity: 1, effect: 'custody', refund_minor: 1700 }, { item_id: expensive.id, quantity: 1, effect: 'none', refund_minor: 0 }].map(p => { const status = a.statuses[p.effect === 'none' ? 'reject' : p.effect].status; return { ...p, part_id: randomUUID(), status_id: status.id, status_version: status.version }; }) };
  a.source_born = await graph(a); const rma = a.source_born.return_case; assert.equal(rma.state, 'requested'); assert.equal(rma.refund_amount, 0); assert.equal(rma.receipt, null); assert.equal(rma.items.length, 2);
  for (const p of a.components) { const stock = a.source_born.products.find((v: Row) => v.id === p.id).stock.find((v: Row) => v.warehouse_id === a.sale_warehouse_id); assert(stock); assert.equal(stock.on_hand, p.initial_quantity - 3 * p.recipe_quantity); assert.equal(stock.reserved, 0);
    const fragment = a.source_born.return_fragments.find((v: Row) => v.product_id === p.id); assert(fragment); assert.equal(fragment.quantity, 3 * p.recipe_quantity); assert.equal(fragment.returned_quantity, 0); assert.equal(fragment.unit_cost_minor === null ? null : String(fragment.unit_cost_minor), p.unit_cost_minor); uuid(fragment.layer_id);
  }
  const history = await get(a, '/return-assistant/history?return_id=' + a.return_id + '&limit=50'); assert.equal(history.next_cursor, null); assert.deepEqual(history.data, []);
  assert.equal(a.source_born.statuses.next_cursor, null); assert.equal(a.source_born.statuses.data.length, 3); a.complete = true; await save();
}
async function main() {
  assert.equal(process.argv.length, 2); assert.equal(await realpath(process.cwd()), ROOT); assert.equal(await realpath(ROOT), ROOT);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, CONFIG); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); for (const name of ['DYNA_TEST', 'DATABASE_URL', 'DYNA_PREVIEW_PORT']) assert.equal(process.env[name], undefined);
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision); assert.match(process.env.QA162_CONFIG_SHA256 ?? '', /^[a-f0-9]{64}$/); assert.match(process.env.QA162_AFTER_CHECKPOINT_SHA256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(process.env.QA162_FAILED_SETUP_SHA256, ORIGINAL_SHA); assert.equal(process.env.QA162_COMPLETION_CONFIRM, 'COMPLETE_ONLY_KNOWN_QA162_ON_PICKING_AFTER_49_ACK');
  for (const name of ['data', 'docs']) await directory(resolve(ROOT, name)); for (const path of [JOURNAL, JOURNAL + '.intent.json', REPORT]) await absent(path);
  await inputs(); const bytes = await read(ORIGINAL); assert.equal(sha(bytes), ORIGINAL_SHA); const basis = JSON.parse(bytes.toString('utf8')); basisValid(basis);
  const afterBytes = await read(AFTER, 512 * 1024 * 1024); assert.equal(sha(afterBytes), process.env.QA162_AFTER_CHECKPOINT_SHA256); const after = JSON.parse(afterBytes.toString('utf8')); assert.equal(after.status, 'EXACT_ADDITIVE_MIGRATION_VERIFIED'); assert.equal(after.schema, SCHEMA); assert.equal(after.revision, revision); assert.equal(after.capture.files['.local.json'].sha256, process.env.QA162_CONFIG_SHA256);
  await health(); const allocations = await validateOriginal(basis);
  state = { ...basis, status: 'COMPLETION_PRIVATE_PREPARED', basis: { path: 'data/return-destinations-native162-setup.json', sha256: ORIGINAL_SHA, status: 'FAILED_NO_RESUME', acknowledged_operations: 49, completed_labels: basis.completed.map((c: Row) => [c.actor, c.label]), failure: 'READ_ONLY_UNSUPPORTED_WMS_LIMIT_QUERY', original_preserved: true } };
  assert(state);
  state.on.allocations = allocations; lastSha = await wx(JOURNAL, state); await wx(JOURNAL + '.intent.json', { stage: 162, revision, schema_revision: SCHEMA, original_sha256: ORIGINAL_SHA, initial_companion_sha256: lastSha, created_at: new Date().toISOString() });
  await completion(); await health(); await identity(state.off); await identity(state.on); assert.deepEqual(await graph(state.off), basis.off.source_born); assert.equal(state.completed.length, 66); assert.equal(state.pending, null);
  assert.equal(sha(await read(AFTER, 512 * 1024 * 1024)), process.env.QA162_AFTER_CHECKPOINT_SHA256); await inputs();
  state.complete = true; state.status = 'OWN_OFF_ON_SOURCES_READY_FOR_CHROME'; await save();
  const report = { stage: 162, status: state.status, revision, schema_revision: SCHEMA, original_failed_setup_sha256: ORIGINAL_SHA, original_failed_setup_preserved: true,
    original_acknowledged_operations: 49, additional_on_operations: 17, total_confirmed_operations: 66, off_writes_during_completion: 0, journal_sha256: lastSha,
    firms: [state.off, state.on].map(a => ({ on: a.on, tenant_id: a.tenant_id, user_id: a.user_id, order_id: a.order_id, return_id: a.return_id, station_id: a.station.id, intended_refund_minor: 2700, source_api_sha256: fp(a.source_born) })),
    assistant_sessions_created: 0, intake_previews_created: 0, intake_receipts_created: 0, provider_requests: 0, shipment: 'LOCAL_DEMO_ACTUAL_STOCK_ISSUE', invoice: 'LOCAL_DEMO_DOCUMENT',
    config_preserved: true, old_row_preservation_verified_here: false, native_chrome_verified: false, full_goal_complete: false };
  await wx(REPORT, report); console.log(JSON.stringify({ stage: 162, status: report.status, journal_sha256: lastSha, additional_on_operations: 17 }));
}
main().catch(async (error: unknown) => { if (state && lastSha) { state.status = state.pending ? 'UNKNOWN_OR_UNCONFIRMED_DO_NOT_RETRY' : 'FAILED_NO_RESUME'; await save().catch(() => undefined); }
  const frame = error instanceof Error ? error.stack?.match(/return-destinations-native162-setup-completion\.ts:(\d+):(\d+)/) : undefined;
  console.log(JSON.stringify({ stage: 162, status: 'FAIL', step, source_line: frame ? Number(frame[1]) : null, source_column: frame ? Number(frame[2]) : null, private_details_withheld: true })); process.exitCode = 1;
});
