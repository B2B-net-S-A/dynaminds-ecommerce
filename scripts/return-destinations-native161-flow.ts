/** ROOT ONLY, SOURCE AUTHORED; do not run while reviewing.
 * CLI: prepare | configure | verify. One NEW own QA161 firm; HTTP only, no SQL.
 * Unknown or incomplete phase is never resumed/retried. Explicit completed
 * phase continuation requires exact private journal SHA. Deliberate receipt
 * replay below is a separate documented call after a CONFIRMED first commit.
 *
 * Run from primary app with its existing host-native TS runner, each time:
 * QA_EXPECTED_REVISION=<40hex> APP_REVISION=<same40hex>
 * DYNA_LOCAL_CONFIG_PATH=<primary>/.local.json DYNA_WORKER_DISABLED=true
 * QA161_CONFIG_SHA256=<actual config bytes SHA256>
 * QA161_FLOW_CONFIRM=CREATE_ONE_NEW_QA161_FIRM_LOCAL_POLICY_STATUS_AND_CUSTODY_PZ
 * For configure/verify also QA161_JOURNAL_SHA256=<last completed private SHA>.
 * Journal: data/return-destinations-native161-flow.json (0600, initial wx).
 * Phase receipts: docs/return-destinations-native161-flow-<phase>.json (wx).
 * Each phase has a permanent wx0600 .<phase>.intent.json lock; never remove it
 * to resume an interrupted run. Later phases require the finished prior phase.
 * Final verify also writes docs/return-destinations-native161-flow.json (wx).
 * No preservation rebase: root's independent old-row checkpoint is required.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ROOT = '<workspace>/app';
const BASE = 'http://127.0.0.1:4100/api';
const CONFIG = resolve(ROOT, '.local.json');
const JOURNAL = resolve(ROOT, 'data/return-destinations-native161-flow.json');
const PHASES = ['prepare', 'configure', 'verify'] as const;
type Phase = typeof PHASES[number];
type Row = Record<string, any>;
const phase = process.argv[2] as Phase;
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '147_return_destination_statuses';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => hash(JSON.stringify(v));
let state: Row | undefined, journalWritable = false, step = 'preflight';
function uuid(v: unknown): string { assert(typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)); return v; }
async function privateRead(file: string, max = 16 * 1024 * 1024) {
  const s = await lstat(file); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600); assert(s.size > 0 && s.size <= max);
  return readFile(file);
}
async function absent(file: string) { try { await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } throw Error('Exclusive custody exists; no retry/resume'); }
async function wx(file: string, value: unknown, mode = 0o600) {
  const bytes = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 16 * 1024 * 1024);
  const f = await open(file, 'wx', mode); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); }
}
async function save() {
  await privateRead(JOURNAL); const temp = JOURNAL + '.' + randomUUID() + '.tmp';
  try { await wx(temp, state); await rename(temp, JOURNAL); const d = await open(dirname(JOURNAL), 'r'); try { await d.sync(); } finally { await d.close(); } }
  finally { await unlink(temp).catch(() => undefined); }
}
async function configExact() { assert.equal(hash(await privateRead(CONFIG, 65536)), process.env.QA161_CONFIG_SHA256); }
function headers(extra: Record<string, string> = {}) { const a = state?.actor; return { 'Content-Type': 'application/json', ...(a?.cookie ? { cookie: a.cookie, 'X-Workspace-ID': uuid(a.tenant_id) } : {}), ...extra }; }
async function json(r: Response): Promise<Row> { const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length <= 8 * 1024 * 1024); return JSON.parse(bytes.toString('utf8')); }
async function get(route: string): Promise<Row> {
  assert(/^\/(health|auth\/me|warehouses|workspaces\/billing|product-catalogs(?:\/options|\/[a-f0-9-]+)?|products(?:\/[a-f0-9-]+)?|orders|inventory|stock-locations|warehouse-documents(?:\/[a-f0-9-]+)?|wms-lots|return-assistant\/statuses(?:\/options|\/[a-f0-9-]+(?:\/history)?|\/(?:previews|operations)\/[a-f0-9-]+)?|warehouse-inventory-policies\/(?:options|history|(?:previews|operations)\/[a-f0-9-]+))(?:\?[^#]*)?$/.test(route));
  const r = await fetch(BASE + route, { method: 'GET', headers: headers(), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) }); assert.equal(r.status, 200, 'Own scoped GET'); return json(r);
}
async function health() {
  await configExact(); const h = await get('/health');
  assert.equal(h.status, 'ok'); assert.equal(h.revision, revision); assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.warehouse_inventory_policies_available, true); assert.equal(h.return_destination_statuses_available, true); assert.equal(h.return_destinations_available, false);
}
async function identity() { const m = await get('/auth/me'); assert.equal(m.user.id, state!.actor.user_id); assert.equal(m.user.tenant_id, state!.actor.tenant_id); assert.equal(m.user.role, 'admin'); assert.equal(m.user.email, state!.actor.email); }
function flags(d: Row) { assert.equal(d.available, true); assert.equal(d.read_only, false); assert.equal(d.current_role, 'admin'); assert.equal(d.can_read, true); assert.equal(d.can_manage, true); }
async function mutate(label: string, route: string, body: Row, expected: number, assign: (d: Row, r: Response) => void, extra: Record<string, string> = {}) {
  step = label; assert.equal(state!.pending, null); assert(!state!.completed.some((v: Row) => v.label === label));
  const a = state!.actor;
  const allowed = route === '/auth/signup' || route === '/workspaces/billing/preview' ||
    route === '/workspaces/billing/previews/' + a.billing_preview?.id + '/commit' || route === '/warehouses' ||
    route === '/product-catalogs/previews' || route === '/product-catalogs/previews/' + a.catalog_preview?.id + '/commit' ||
    [a.sale_warehouse_id, a.custody_warehouse_id].some(id => id && route === '/warehouse-inventory-policies/warehouses/' + id + '/previews') ||
    Object.values(a.policies ?? {}).some((v: any) => route === '/warehouse-inventory-policies/previews/' + v.preview.id + '/commit') ||
    route === '/return-assistant/statuses/previews' ||
    Object.values(a.statuses ?? {}).some((v: any) => route === '/return-assistant/statuses/previews/' + v.preview.id + '/commit') ||
    route === '/products' || route === '/warehouse-documents' || route === '/warehouse-documents/' + a.pz?.id + '/post' || route === '/orders';
  assert(allowed); await health(); if (route !== '/auth/signup') await identity();
  const raw = JSON.stringify(body); state!.pending = { label, method: 'POST', route, raw_body: raw, extra_headers: extra, expected_status: expected, response: null }; state!.status = 'PENDING_WRITE'; await save();
  let r: Response, d: Row;
  try {
    r = await fetch(BASE + route, { method: 'POST', headers: headers(extra), body: raw, redirect: 'error', signal: AbortSignal.timeout(90000) });
    d = await json(r);
  } catch { state!.status = 'UNKNOWN_RESULT_DO_NOT_RETRY'; await save(); throw Error('Unconfirmed local write'); }
  state!.pending.response = { status: r.status, data: d }; await save();
  assert.equal(r.status, expected, 'Exact expected HTTP status'); assign(d, r);
  state!.completed.push({ ...state!.pending, response_sha256: fp(d) }); state!.pending = null; state!.status = 'CONFIRMED'; await save();
}
async function policy(label: 'sale' | 'custody', wh: string) {
  const a = state!.actor, request = { client_key: randomUUID(), version: '0', usage: label, enabled: true };
  await mutate(label + '-policy-preview', '/warehouse-inventory-policies/warehouses/' + wh + '/previews', request, 201, d => {
    flags(d); assert.equal(d.reused, false); const p = d.preview; uuid(p.id); assert.equal(p.warehouse_id, wh); assert.deepEqual(p.request, request); assert.equal(p.ready, true); assert.deepEqual(p.snapshot.blockers, []); assert.deepEqual(p.snapshot.before, { usage: 'sale', enabled: true, version: '0' }); assert.deepEqual(p.snapshot.after, { usage: label, enabled: true }); a.policies[label] = { preview: p };
  });
  const p = a.policies[label].preview, consent = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true };
  await mutate(label + '-policy-commit', '/warehouse-inventory-policies/previews/' + p.id + '/commit', consent, 201, d => {
    flags(d); assert.equal(d.reused, false); uuid(d.operation.id); assert.equal(d.operation.preview_id, p.id); assert.equal(d.operation.scope_hash, p.scope_hash); assert.deepEqual(d.operation.after, { usage: label, enabled: true, version: '1' }); a.policies[label].operation = d.operation;
  });
}
async function status(label: 'sale' | 'custody' | 'reject') {
  const a = state!.actor, reject = label === 'reject', wh = label === 'sale' ? a.sale_warehouse_id : a.custody_warehouse_id;
  const settings = { name: 'QA161 ' + label + ' ' + state!.suffix, color: label === 'sale' ? '#16a34a' : label === 'custody' ? '#d97706' : '#dc2626', active: true,
    decision: reject ? 'reject' : 'accept', inventory_effect: reject ? 'none' : label, warehouse_id: reject ? null : wh, warehouse_policy_version: reject ? null : '1', default_location: reject ? null : label === 'sale' ? 'QA161-SALE' : 'QA161-CUSTODY' };
  const request = { client_key: randomUUID(), kind: 'create', settings };
  await mutate(label + '-status-preview', '/return-assistant/statuses/previews', request, 201, d => {
    flags(d); assert.equal(d.intake_available, false); assert.equal(d.reused, false); const p = d.preview; uuid(p.id); uuid(p.status_id); assert.deepEqual(p.request, request); assert.equal(p.kind, 'create'); assert.equal(p.before, null); assert.equal(p.after.id, p.status_id); assert.equal(p.after.version, '1'); assert.deepEqual(p.after.settings, settings); assert.equal(p.ready, true); assert.equal(p.can_commit, true); a.statuses[label] = { preview: p };
  });
  const p = a.statuses[label].preview, body = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true }, route = '/return-assistant/statuses/previews/' + p.id + '/commit';
  await mutate(label + '-status-commit', route, body, 201, d => { flags(d); assert.equal(d.intake_available, false); assert.equal(d.reused, false); uuid(d.operation.id); assert.equal(d.operation.preview_id, p.id); assert.equal(d.operation.scope_hash, p.scope_hash); assert.deepEqual(d.operation.after.settings, settings); assert.deepEqual(d.status, d.operation.after); a.statuses[label].operation = d.operation; });
  await mutate(label + '-status-known-exact-replay', route, body, 200, d => { flags(d); assert.equal(d.reused, true); assert.deepEqual(d.operation, a.statuses[label].operation); assert.deepEqual(d.status, a.statuses[label].operation.after); });
}
async function prepare() {
  const a = state!.actor;
  await mutate('signup-one-own-firm', '/auth/signup', { name: 'QA161 Local Operator', email: a.email, password: a.password, organization: { name: 'QA161 Local Destinations ' + state!.suffix, currency: 'PLN', locale: 'pl-PL' } }, 201, (d, r) => { a.user_id = uuid(d.user.id); a.tenant_id = uuid(d.user.tenant_id); assert.equal(d.user.role, 'admin'); a.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; assert.match(a.cookie, /^dyna_session=[A-Za-z0-9_.-]+$/); });
  const wh = await get('/warehouses'); assert.equal(wh.data.length, 1); a.sale_warehouse_id = uuid(wh.data[0].id); await save();
  const billing = await get('/workspaces/billing'); assert.equal(billing.mode, 'local_estimate'); assert.equal(billing.current_plan, 'starter'); assert.equal(billing.account, null);
  await mutate('local-enterprise-preview', '/workspaces/billing/preview', { kind: 'activate', plan: 'enterprise' }, 200, d => { assert.equal(d.mode, 'local_estimate'); assert.equal(d.can_commit, true); assert.deepEqual(d.blockers, []); uuid(d.id); a.billing_preview = d; });
  await mutate('local-enterprise-commit', '/workspaces/billing/previews/' + a.billing_preview.id + '/commit', {}, 200, d => { assert.equal(d.mode, 'local_estimate'); assert.equal(d.plan, 'enterprise'); });
  await mutate('new-own-custody-warehouse', '/warehouses', { name: 'QA161 Custody ' + state!.suffix, code: 'QA161-C-' + state!.suffix }, 200, d => { a.custody_warehouse_id = uuid(d.id); assert.equal(d.tenant_id, a.tenant_id); });
  const options = await get('/product-catalogs/options'); flags(options);
  const settings = { name: 'QA161 Own physical targets ' + state!.suffix, active: true, languages: ['pl'], default_language: 'pl', warehouse_ids: [a.sale_warehouse_id, a.custody_warehouse_id].sort(), price_list_ids: [] };
  await mutate('own-catalog-preview', '/product-catalogs/previews', { client_key: randomUUID(), kind: 'create', settings }, 201, d => { flags(d); uuid(d.preview.id); assert.equal(d.preview.ready, true); assert.deepEqual(d.preview.after, settings); a.catalog_preview = d.preview; });
  await mutate('own-catalog-commit', '/product-catalogs/previews/' + a.catalog_preview.id + '/commit', { client_key: randomUUID(), scope_hash: a.catalog_preview.scope_hash, confirmed: true }, 201, d => { flags(d); a.catalog = d.catalog; uuid(a.catalog.id); assert.deepEqual(a.catalog.settings, settings); });
  const ownWh = await get('/warehouses'); assert.equal(ownWh.data.length, 2); assert.deepEqual(ownWh.data.map((w: Row) => w.id).sort(), settings.warehouse_ids);
}
async function configure() {
  const a = state!.actor; await policy('sale', a.sale_warehouse_id); await policy('custody', a.custody_warehouse_id);
  for (const kind of ['sale', 'custody', 'reject'] as const) await status(kind);
  assert.equal((await get('/wms-lots')).policy.enabled, false);
  await mutate('new-own-physical-product', '/products', { catalog_id: a.catalog.id, warehouse_id: a.custody_warehouse_id, sku: 'QA161-' + state!.suffix, name: 'QA161 Custody Physical Product', kind: 'simple', price: 1000, vat: 23, quantity: 0, location: 'QA161-CUSTODY' }, 201, d => { a.product_id = uuid(d.id); assert.equal(d.catalog_id, a.catalog.id); });
  await mutate('own-pz-draft', '/warehouse-documents', { kind: 'receipt', warehouse_id: a.custody_warehouse_id, reference: 'Own QA161 local physical receipt; no supplier/provider', note: 'QA161 custody stock proof', lines: [{ product_id: a.product_id, quantity: 3, location: 'QA161-CUSTODY' }] }, 201, d => { uuid(d.id); assert.equal(d.status, 'draft'); a.pz = d; });
  await mutate('own-pz-post', '/warehouse-documents/' + a.pz.id + '/post', { version: a.pz.version }, 200, d => { assert.equal(d.id, a.pz.id); assert.equal(d.status, 'posted'); assert.equal(d.warehouse_id, a.custody_warehouse_id); a.pz_posted = d; });
  const before = await physical();
  await mutate('custody-order-denied', '/orders', { customer_name: 'QA161 Local Denied Order', email: 'qa161-customer@example.test', source: 'manual', warehouse_id: a.custody_warehouse_id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0, items: [{ product_id: a.product_id, quantity: 1 }], address: { street: 'QA161 Test', city: 'Warszawa', postal_code: '00-161', country: 'PL' } }, 409, d => { assert.equal(d.detail, 'Magazyn nie jest źródłem sprzedaży'); }, { 'Idempotency-Key': randomUUID() });
  assert.deepEqual(await physical(), before, 'Denied order leaves actual stock/bin/product/document/order API graph unchanged');
}
async function physical() {
  const a = state!.actor, product = await get('/products/' + a.product_id), inventory = await get('/inventory?warehouse_id=' + a.custody_warehouse_id + '&limit=50'), bins = await get('/stock-locations?warehouse_id=' + a.custody_warehouse_id + '&limit=50'), orders = await get('/orders?limit=50'), documents = await get('/warehouse-documents?limit=50');
  assert.equal(product.id, a.product_id); assert.equal(product.catalog_id, a.catalog.id); assert.equal(product.stock.length, 1);
  const s = product.stock[0]; assert.equal(s.warehouse_id, a.custody_warehouse_id); assert.equal(s.on_hand, 3); assert.equal(s.reserved, 0);
  assert.equal(inventory.meta.cursor, null); assert.equal(inventory.data.length, 1); const row = inventory.data[0]; assert.equal(row.product_id, a.product_id); assert.equal(row.warehouse_id, a.custody_warehouse_id); assert.equal(row.on_hand, 3); assert.equal(row.reserved, 0); assert.equal(row.available, 3); assert.equal(row.physical_available, 3); assert.equal(row.sellable_available, 0); assert.equal(row.inventory_usage, 'custody'); assert.equal(row.inventory_enabled, true); assert.equal(row.inventory_policy_version, '1');
  assert.equal(orders.meta.cursor, null); assert.equal(orders.data.length, 0); assert.equal(documents.meta.cursor, null); assert.equal(documents.data.length, 1); assert.equal(documents.data[0].id, a.pz.id); assert.equal(documents.data[0].status, 'posted');
  assert.equal(bins.meta.cursor, null); const own = bins.data.filter((b: Row) => b.product_id === a.product_id); assert.equal(own.length, 1); assert.equal(own[0].location, 'QA161-CUSTODY'); assert.equal(own[0].quantity, 3); assert.equal(own[0].reserved, 0);
  return { product, inventory, bins, orders, documents };
}
async function verify() {
  const a = state!.actor, policies = await get('/warehouse-inventory-policies/options?limit=50'); flags(policies); assert.equal(policies.next_cursor, null); assert.equal(policies.warehouses.length, 2);
  for (const kind of ['sale', 'custody'] as const) {
    const wh = kind === 'sale' ? a.sale_warehouse_id : a.custody_warehouse_id; assert.deepEqual(policies.warehouses.find((w: Row) => w.id === wh)?.policy, { usage: kind, enabled: true, version: '1' });
    const d = await get('/warehouse-inventory-policies/operations/' + a.policies[kind].operation.id); flags(d); assert.deepEqual(d.operation, a.policies[kind].operation);
  }
  const statuses = await get('/return-assistant/statuses?limit=50'); flags(statuses); assert.equal(statuses.intake_available, false); assert.equal(statuses.next_cursor, null); assert.equal(statuses.data.length, 3);
  for (const kind of ['sale', 'custody', 'reject'] as const) {
    const op = a.statuses[kind].operation, detail = await get('/return-assistant/statuses/' + op.status_id), history = await get('/return-assistant/statuses/' + op.status_id + '/history?limit=50'), proof = await get('/return-assistant/statuses/operations/' + op.id);
    flags(detail); assert.deepEqual(detail.status, op.after); assert.equal(history.next_cursor, null); assert.equal(history.data.length, 1); assert.equal(history.data[0].id, op.id); assert.deepEqual(proof.operation, op);
  }
  state!.verify_readback = { policies, statuses, physical: await physical() }; assert.equal((await get('/wms-lots')).policy.enabled, false);
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(await realpath(ROOT), ROOT); assert.equal(process.argv.length, 3); assert(PHASES.includes(phase));
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, CONFIG); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert(!process.env.DYNA_TEST); assert(!process.env.DYNA_PREVIEW_PORT);
  assert.match(process.env.QA161_CONFIG_SHA256 ?? '', /^[a-f0-9]{64}$/); assert.equal(process.env.QA161_FLOW_CONFIRM, 'CREATE_ONE_NEW_QA161_FIRM_LOCAL_POLICY_STATUS_AND_CUSTODY_PZ');
  for (const n of ['data', 'docs']) { const p = resolve(ROOT, n), s = await lstat(p); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(p), p); }
  const report = resolve(ROOT, 'docs/return-destinations-native161-flow-' + phase + '.json'); await absent(report); if (phase === 'verify') await absent(resolve(ROOT, 'docs/return-destinations-native161-flow.json'));
  if (phase === 'prepare') {
    await absent(JOURNAL); assert.equal(process.env.QA161_JOURNAL_SHA256, undefined); await health(); const suffix = randomUUID().slice(0, 8);
    state = { stage: 161, schema_revision: schema, runtime_revision: revision, config_sha256: process.env.QA161_CONFIG_SHA256, suffix, status: 'PRIVATE_PREPARED', completed_phases: [], pending: null, completed: [], complete: false,
      actor: { email: 'qa161-' + suffix + '@demo.local', password: 'QA161-' + randomBytes(24).toString('hex'), cookie: '', policies: {}, statuses: {} } };
    await wx(JOURNAL, state); journalWritable = true;
  } else {
    assert.match(process.env.QA161_JOURNAL_SHA256 ?? '', /^[a-f0-9]{64}$/); const bytes = await privateRead(JOURNAL); assert.equal(hash(bytes), process.env.QA161_JOURNAL_SHA256); state = JSON.parse(bytes.toString());
    assert.equal(state!.stage, 161); assert.equal(state!.schema_revision, schema); assert.equal(state!.runtime_revision, revision); assert.equal(state!.config_sha256, process.env.QA161_CONFIG_SHA256); assert.equal(state!.pending, null); assert.equal(state!.status, 'PHASE_CONFIRMED'); assert.equal(state!.complete, false);
  }
  assert.deepEqual(state!.completed_phases, PHASES.slice(0, PHASES.indexOf(phase)));
  assert.equal(state!.completed.length, phase === 'prepare' ? 0 : phase === 'configure' ? 6 : 23);
  await health(); if (phase !== 'prepare') await identity();
  await wx(JOURNAL + '.' + phase + '.intent.json', { stage: 161, phase, revision, schema_revision: schema,
    journal_sha256_before_phase: hash(await privateRead(JOURNAL)), created_at: new Date().toISOString() });
  journalWritable = true;
  // No generic known-write skip or unfinished-phase resume exists.
  await ({ prepare, configure, verify }[phase])(); await health(); await identity(); assert.equal(state!.pending, null);
  state!.completed_phases.push(phase); state!.status = phase === 'verify' ? 'LOCAL_API_POLICY_STATUS_CUSTODY_VERIFIED' : 'PHASE_CONFIRMED'; state!.complete = phase === 'verify'; await save();
  const a = state!.actor, publicReport = { stage: 161, phase, status: phase === 'verify' ? 'LOCAL_API_POLICY_STATUS_CUSTODY_VERIFIED' : 'CONFIRMED_PHASE_ONLY', revision, schema_revision: schema, tenant_id: a.tenant_id,
    sale_warehouse_id: a.sale_warehouse_id, custody_warehouse_id: a.custody_warehouse_id, catalog_id: a.catalog?.id, product_id: a.product_id, warehouse_document_id: a.pz?.id,
    policies: Object.fromEntries(Object.entries(a.policies).map(([k, v]: [string, any]) => [k, { operation_id: v.operation.id, version: v.operation.after.version, usage: v.operation.after.usage }])),
    statuses: Object.fromEntries(Object.entries(a.statuses).map(([k, v]: [string, any]) => [k, { status_id: v.operation.status_id, operation_id: v.operation.id, version: v.operation.after.version }])),
    confirmed_http_calls: state!.completed.length, deliberate_known_status_replays: state!.completed.filter((r: Row) => r.label.endsWith('-known-exact-replay')).length,
    ...(phase === 'verify' ? { physical_on_hand: 3, reserved: 0, physical_available: 3, sellable_available: 0, custody_order_http_status: 409, inventory_readback_sha256: fp(state!.verify_readback), own_orders: 0, posted_warehouse_documents: 1 } : {}),
    journal_sha256: hash(await privateRead(JOURNAL)), config_preserved: true, old_row_preservation_verified_here: false, provider_requests: 0, shipment_created: false, intake_available: false, native_ui_verified: false, full_goal_complete: false };
  await wx(report, publicReport, 0o644); if (phase === 'verify') await wx(resolve(ROOT, 'docs/return-destinations-native161-flow.json'), publicReport, 0o644);
  process.stdout.write(JSON.stringify({ status: publicReport.status, phase, journal_sha256: publicReport.journal_sha256 }) + '\n');
}
main().catch(async (error: unknown) => {
  if (state && journalWritable) { state.status = state.pending ? 'UNKNOWN_OR_UNCONFIRMED_DO_NOT_RETRY' : 'FAILED_NO_RESUME'; await save().catch(() => undefined); }
  const m = (error instanceof Error ? error.stack ?? '' : '').match(/return-destinations-native161-flow\.ts:(\d+):(\d+)/);
  process.stderr.write(JSON.stringify({ status: 'QA161_FLOW_FAILED', phase: PHASES.includes(phase) ? phase : 'invalid', step, ...(m ? { source_line: Number(m[1]), source_column: Number(m[2]) } : {}), private_details_withheld: true }) + '\n'); process.exitCode = 1;
});
