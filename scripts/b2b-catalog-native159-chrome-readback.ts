/** ROOT ONLY, source-authored without execution. GET + owner RR READ ONLY.
 * CLI: handoff | before-bind | after-bind | before-quote | after-quote |
 *      before-checkout | after-checkout.
 * Immutable WX sidecars record intent BEFORE each actual Chrome click and
 * inspect durable DB proof AFTER it. Never rewrites the flow journal, sends a
 * mutation/login/replay, resolves browser RAM or claims Chrome interaction.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';

const ROOT = '<workspace>/app';
const WT = '<workspace>/worktrees/stock-file-import';
const CONFIG = resolve(ROOT, '.local.json');
const JOURNAL = resolve(ROOT, 'data/b2b-catalog-native159-flow.json');
const BASE = 'http://127.0.0.1:4100/api';
const PHASES = ['handoff', 'before-bind', 'after-bind', 'before-quote', 'after-quote', 'before-checkout', 'after-checkout'] as const;
type Phase = typeof PHASES[number];
type Row = Record<string, any>;
type Capture = { rows: Record<string, { row: Row }[]>; snapshot: Record<string, { count: number; sha256: string }> };
const phase = process.argv[2] as Phase;
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '145_order_merge_counters';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
const pins = new Map<string, { digest: string; mode: number }>();
let pool: Pool | undefined, flow: Row, baseline: Row, prior: Row;
let step = 'preflight';
function uuid(v: unknown): string {
  assert(typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)); return v;
}
function identifier(v: string) { assert.match(v, /^[a-z][a-z0-9_]*$/); return '"' + v + '"'; }
async function bytes(file: string, mode: number) {
  const s = await lstat(file); assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, mode); assert(s.size > 0 && s.size <= 256 * 1024 * 1024);
  return readFile(file);
}
async function pin(file: string, digest: unknown, mode = 0o600) {
  assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
  const b = await bytes(file, mode); assert.equal(sha(b), digest); pins.set(file, { digest, mode });
  return JSON.parse(b.toString('utf8')) as Row;
}
async function absent(file: string) {
  try { await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive evidence exists');
}
async function wx(file: string, value: unknown, mode: number) {
  const b = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(b) <= 256 * 1024 * 1024);
  const f = await open(file, 'wx', mode);
  try { await f.writeFile(b); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); }
}
const privatePath = (p: Phase) => resolve(ROOT, 'data/b2b-catalog-native159-chrome-' + p + '.json');
async function custody() {
  for (const [file, p] of pins) assert.equal(sha(await bytes(file, p.mode)), p.digest);
  for (const [name, v] of Object.entries(prior.private_files) as [string, Row][]) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/);
    assert.equal(sha(await bytes(resolve(ROOT, 'data', name), v.mode)), v.sha256);
  }
}
async function get(actor: Row | undefined, route: string) {
  assert(/^\/(?:health|auth\/me|b2b\/network\/(?:links\/[a-f0-9-]+\/catalog|orders\/[a-f0-9-]+))$/.test(route));
  const h: Record<string, string> = {};
  if (actor) {
    assert(/^dyna_session=[A-Za-z0-9_.-]+$/.test(actor.cookie));
    h.cookie = actor.cookie; h['X-Workspace-ID'] = uuid(actor.tenant_id);
  }
  const r = await fetch(BASE + route, { method: 'GET', headers: h, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200, 'Read response: ' + route.replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, ':id')); const b = Buffer.from(await r.arrayBuffer()); assert(b.length <= 16 * 1024 * 1024);
  return JSON.parse(b.toString('utf8')) as Row;
}
async function healthAndActors() {
  const h = await get(undefined, '/health');
  assert.equal(h.status, 'ok'); assert.equal(h.revision, revision); assert.equal(h.schema_revision, schema);
  assert.equal(h.mode, 'local'); assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.product_catalogs_available, true); assert.equal(h.b2b_catalog_scope_available, true);
  for (const a of [flow.actors.supplier, flow.actors.buyer]) {
    const m = await get(a, '/auth/me'); assert.equal(m.user.id, a.user_id);
    assert.equal(m.user.tenant_id, a.tenant_id); assert.equal(m.user.role, 'admin');
  }
}
async function capture(): Promise<Capture> {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const tables: string[] = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' ORDER BY 1")).rows.map(r => r.table_name);
    assert.deepEqual(tables, Object.keys(baseline.capture.tables).sort());
    const tenants = [uuid(flow.actors.supplier.tenant_id), uuid(flow.actors.buyer.tenant_id)];
    const users = [uuid(flow.actors.supplier.user_id), uuid(flow.actors.buyer.user_id)];
    assert.equal(new Set(tenants).size, 2); assert.equal(new Set(users).size, 2);
    const own: Capture = { rows: {}, snapshot: {} };
    for (const name of tables) {
      const cols: string[] = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [name])).rows.map(r => r.column_name);
      assert.deepEqual(cols, baseline.capture.tables[name].columns);
      const key = name === 'users' || name === 'tenants' ? 'id' : cols.includes('tenant_id') ? 'tenant_id' : cols.includes('user_id') ? 'user_id' : null;
      const ids = name === 'users' || key === 'user_id' ? users : tenants;
      const old = (await c.query(`SELECT to_jsonb(x) row FROM ${identifier(name)} x${key ? ` WHERE ${identifier(key)} IS NULL OR NOT (${identifier(key)}=ANY($1::uuid[]))` : ''} ORDER BY 1`, key ? [ids] : [])).rows;
      assert.deepEqual({ count: old.length, sha256: fp(old) }, baseline.capture.tables[name].fingerprint, 'Original global rows: ' + name);
      if (key) {
        own.rows[name] = (await c.query(`SELECT to_jsonb(x) row FROM ${identifier(name)} x WHERE ${identifier(key)}=ANY($1::uuid[]) ORDER BY 1`, [ids])).rows;
        own.snapshot[name] = { count: own.rows[name].length, sha256: fp(own.rows[name]) };
      }
    }
    assert.deepEqual((await c.query('SELECT public.b2b_catalog_scope_installed() installed,public.b2b_catalog_scope_guards() guards')).rows[0], { installed: true, guards: true });
    await c.query('COMMIT'); return own;
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
const rows = (c: Capture, table: string) => (c.rows[table] ?? []).map(v => v.row);
function one(list: Row[]) { assert.equal(list.length, 1); return list[0]; }
function own(c: Capture, table: string, tenant: string) { return rows(c, table).filter(r => r.tenant_id === tenant); }
function graph(c: Capture) {
  const s = flow.actors.supplier, b = flow.actors.buyer;
  const item = one(own(c, 'b2b_catalog_items', b.tenant_id));
  assert.equal(item.id, b.item.id); assert.equal(item.link_id, b.link.id); assert.equal(item.source_product_id, s.selected.id);
  assert.equal(item.published, true);
  const bindings = own(c, 'b2b_catalog_bindings', b.tenant_id), quotes = own(c, 'b2b_network_quotes', b.tenant_id), orders = own(c, 'b2b_network_orders', b.tenant_id);
  assert(bindings.length <= 1 && quotes.length <= 1 && orders.length <= 1);
  const binding = bindings[0], quote = quotes[0], purchase = orders[0];
  if (binding) {
    uuid(binding.id); uuid(binding.client_key); assert.equal(binding.actor_id, b.user_id); assert.equal(binding.api_key_id, null);
    assert.equal(binding.link_id, b.link.id); assert.equal(binding.item_id, b.item.id); assert.equal(binding.product_id, b.selected.id);
    assert.deepEqual(binding.request, { client_key: binding.client_key, version: b.item.version, product_id: b.selected.id, confirmed: true });
    const published = one(own(flow.last_capture, 'b2b_catalog_items', b.tenant_id));
    assert.deepEqual(binding.source_snapshot, published.snapshot);
    assert.equal(binding.catalog_scope.buyer.tenant_id, b.tenant_id); assert.equal(binding.catalog_scope.buyer.target_catalog_id, b.catalog.id);
    assert.equal(binding.catalog_scope.supplier.tenant_id, s.tenant_id); assert.equal(binding.catalog_scope.supplier.catalog_id, s.catalog.id);
    assert.equal(binding.response.id, binding.id); assert.equal(binding.response.link_id, b.link.id);
    assert.equal(binding.response.item_id, b.item.id); assert.equal(binding.response.product_id, b.selected.id);
    assert.equal(binding.response.item_version_before, b.item.version); assert.equal(binding.response.item_version_after, b.item.version + 1);
    assert.equal(binding.response.quantity, 0); assert.equal(binding.response.supplier_available, 2);
    assert.equal(item.product_id, b.selected.id); assert.equal(item.version, b.item.version + 1);
  } else assert.equal(item.product_id, null);
  if (quote) {
    assert(binding); uuid(quote.id); uuid(quote.client_key); uuid(quote.source_quote_id);
    assert.equal(quote.link_id, b.link.id); assert.equal(quote.supplier_tenant_id, s.tenant_id); assert.equal(quote.warehouse_id, b.warehouse_id);
    assert.deepEqual(quote.input, { warehouse_id: b.warehouse_id, items: [{ item_id: b.item.id, quantity: 1 }] });
    assert.equal(quote.summary.currency, 'PLN'); assert.equal(quote.summary.total_gross, 777); assert.equal(quote.summary.shipping_gross, 0);
    assert.equal(quote.summary.payment_mode, 'prepaid');
    assert.deepEqual(quote.summary.catalog_scope, binding.catalog_scope);
    const line = one(quote.summary.items); assert.equal(line.item_id, b.item.id); assert.equal(line.product_id, b.selected.id);
    assert.equal(line.source_product_id, s.selected.id); assert.equal(line.quantity, 1); assert.equal(line.unit_gross, 777);
    const sq = one(own(c, 'b2b_quotes', s.tenant_id)); assert.equal(sq.id, quote.source_quote_id); assert.equal(sq.account_id, s.account.id);
    assert.deepEqual(sq.input, { items: [{ product_id: s.selected.id, quantity: 1 }] }); assert.equal(sq.total, 777);
    assert.equal(sq.order_id, purchase?.source_order_id ?? null);
  } else assert.equal(own(c, 'b2b_quotes', s.tenant_id).length, 0);
  if (purchase) {
    assert(quote); uuid(purchase.id); uuid(purchase.source_order_id); assert.equal(purchase.quote_id, quote.id);
    assert.equal(purchase.link_id, b.link.id); assert.equal(purchase.supplier_tenant_id, s.tenant_id); assert.equal(purchase.account_id, s.account.id);
    assert.equal(purchase.warehouse_id, b.warehouse_id); assert.equal(purchase.currency, 'PLN'); assert.equal(purchase.total_gross, 777); assert.equal(purchase.shipping_gross, 0);
    assert.equal(purchase.state, 'ordered'); assert.equal(purchase.version, 1);
    const line = one(own(c, 'b2b_network_order_lines', b.tenant_id)); assert.equal(line.order_id, purchase.id);
    assert.equal(line.product_id, b.selected.id); assert.equal(line.source_product_id, s.selected.id); assert.equal(line.quantity, 1); assert.equal(line.unit_gross, 777);
    const order = one(own(c, 'orders', s.tenant_id)); assert.equal(order.id, purchase.source_order_id); assert.equal(order.number, purchase.source_number);
    assert.equal(order.source, 'b2b'); assert.equal(order.status, 'new'); assert.equal(order.total, 777); assert.equal(order.shipping_cost, 0);
    assert.equal(order.currency, 'PLN'); assert.equal(order.payment_mode, 'prepaid'); assert.equal(order.b2b_account_id, s.account.id); assert.equal(order.warehouse_id, s.warehouse_id);
    const itemRow = one(own(c, 'order_items', s.tenant_id)); assert.equal(itemRow.order_id, order.id); assert.equal(itemRow.product_id, s.selected.id);
    assert.equal(itemRow.quantity, 1); assert.equal(itemRow.line_total, 777); assert.equal(itemRow.price, 777);
    const reservation = one(own(c, 'reservations', s.tenant_id)); assert.equal(reservation.order_id, order.id);
    assert.equal(reservation.product_id, s.selected.id); assert.equal(reservation.warehouse_id, s.warehouse_id); assert.equal(reservation.quantity, 1); assert.equal(reservation.state, 'active');
  } else assert.equal(own(c, 'orders', s.tenant_id).length, 0);
  assert.equal(own(c, 'orders', b.tenant_id).length, 0);
  for (const a of [s, b]) {
    assert.equal(own(c, 'products', a.tenant_id).length, 2);
    assert.equal(own(c, 'wms_policies', a.tenant_id).length, 0);
    for (const table of ['shipments', 'documents', 'return_cases', 'payment_entries', 'b2b_network_receipts', 'automation_rules', 'channels']) assert.equal(own(c, table, a.tenant_id).length, 0);
  }
  const stock = one(own(c, 'stock', s.tenant_id).filter(r => r.product_id === s.selected.id && r.warehouse_id === s.warehouse_id));
  assert.equal(stock.on_hand, 2); assert.equal(stock.reserved, purchase ? 1 : 0); assert.equal(stock.available, purchase ? 1 : 2);
  const control = one(own(c, 'stock', s.tenant_id).filter(r => r.product_id === s.other.id)); assert.equal(control.on_hand, 3); assert.equal(control.reserved, 0);
  assert(own(c, 'stock', b.tenant_id).every(r => r.on_hand === 0 && r.reserved === 0));
  return { binding, quote, purchase };
}
function delta(before: Capture, after: Capture, action: 'bind' | 'quote' | 'checkout') {
  const s = flow.actors.supplier, b = flow.actors.buyer, g = graph(after);
  const expected: Record<string, Row[]> = Object.fromEntries(Object.entries(before.rows).map(([k, v]) => [k, v.map(x => x.row)]));
  const append = (table: string, count: number, check: (r: Row) => void) => {
    const previous = new Set((expected[table] ?? []).map(fp));
    const added = rows(after, table).filter(r => !previous.has(fp(r))); assert.equal(added.length, count, 'Exact additions: ' + table);
    added.forEach(check); expected[table] = [...(expected[table] ?? []), ...added];
  };
  const replace = (table: string, match: (r: Row) => boolean, update: (r: Row) => Row) => {
    assert.equal(expected[table].filter(match).length, 1); expected[table] = expected[table].map(r => match(r) ? update(r) : r);
  };
  const audits: { tenant: string; user: string | null; action: string; entity: string; detail: Row }[] = [];
  if (action === 'bind') {
    assert(g.binding && !g.quote && !g.purchase);
    replace('b2b_catalog_items', r => r.id === b.item.id, r => ({ ...r, product_id: b.selected.id, version: r.version + 1 }));
    append('b2b_catalog_bindings', 1, r => assert.equal(r.id, g.binding.id));
    audits.push({ tenant: b.tenant_id, user: b.user_id, action: 'b2b.network.bound', entity: b.item.id, detail: { link_id: b.link.id, product_id: b.selected.id, source_product_id: s.selected.id } });
  } else if (action === 'quote') {
    assert(g.binding && g.quote && !g.purchase);
    append('b2b_network_quotes', 1, r => assert.equal(r.id, g.quote.id));
    append('b2b_quotes', 1, r => assert.equal(r.id, g.quote.source_quote_id));
    audits.push({ tenant: s.tenant_id, user: null, action: 'b2b.quote', entity: g.quote.source_quote_id, detail: { account_id: s.account.id } },
      { tenant: b.tenant_id, user: b.user_id, action: 'b2b.network.quote', entity: g.quote.id, detail: { link_id: b.link.id } });
  } else {
    assert(g.binding && g.quote && g.purchase); const orderId = g.purchase.source_order_id;
    append('b2b_network_orders', 1, r => assert.equal(r.id, g.purchase.id));
    append('b2b_network_order_lines', 1, r => assert.equal(r.order_id, g.purchase.id));
    append('orders', 1, r => assert.equal(r.id, orderId));
    append('order_items', 1, r => { assert.equal(r.order_id, orderId); assert.equal(r.product_id, s.selected.id); });
    append('order_pick_items', 1, r => { assert.equal(r.order_id, orderId); assert.equal(r.product_id, s.selected.id); assert.equal(r.quantity, 1); assert.equal(r.scanned, 0); });
    append('reservations', 1, r => assert.equal(r.order_id, orderId));
    append('reservation_locations', 1, r => { assert.equal(r.tenant_id, s.tenant_id); assert.equal(r.order_id, orderId); assert.equal(r.product_id, s.selected.id); assert.equal(r.warehouse_id, s.warehouse_id); assert.equal(r.location, 'QA159-01'); assert.equal(r.quantity, 1); assert.equal(r.scanned, 0); });
    replace('b2b_quotes', r => r.id === g.quote.source_quote_id, r => ({ ...r, order_id: orderId }));
    replace('stock', r => r.tenant_id === s.tenant_id && r.product_id === s.selected.id && r.warehouse_id === s.warehouse_id, r => {
      assert(Number.isSafeInteger(r.version)); return { ...r, reserved: r.reserved + 1, available: r.available - 1, version: r.version + 1 };
    });
    // Migration099 advances the buyer epoch once per network header/line
    // INSERT statement, and appends one supplier stock marker on reservation.
    // The fixture has no earlier buyer purchase source epoch.
    assert.equal((expected.purchasing_source_versions ?? []).filter(r => r.tenant_id === b.tenant_id).length, 0);
    append('purchasing_source_versions', 1, r => assert.deepEqual(r, {
      tenant_id: b.tenant_id, version: 2, created_transaction: null, created_order_ids: [],
    }));
    const lastStockMarker = Math.max(0, ...rows(before, 'purchasing_stock_changes').map(r => Number(r.id)));
    append('purchasing_stock_changes', 1, r => {
      assert.deepEqual(Object.keys(r).sort(), ['id', 'tenant_id']); assert.equal(r.tenant_id, s.tenant_id);
      assert(Number.isSafeInteger(Number(r.id)) && Number(r.id) > lastStockMarker);
    });
    const order = one(own(after, 'orders', s.tenant_id)), period = order.created_at.slice(0, 7) + '-01';
    const usage = (expected.workspace_usage ?? []).filter(r => r.tenant_id === s.tenant_id && r.resource === 'orders' && r.period === period);
    assert(usage.length <= 1);
    if (usage.length) replace('workspace_usage', r => r === usage[0], r => ({ ...r, used: Number(r.used) + 1 }));
    else expected.workspace_usage.push({ tenant_id: s.tenant_id, resource: 'orders', period, used: 1 });
    let eventId = '';
    append('order_events', 1, r => { uuid(r.id); eventId = r.id; assert.equal(r.tenant_id, s.tenant_id); assert.equal(r.order_id, orderId); assert.equal(r.kind, 'order.created'); assert.deepEqual(r.detail, {}); });
    append('jobs', 1, r => {
      uuid(r.id); assert.equal(r.tenant_id, s.tenant_id); assert.equal(r.kind, 'automation'); assert.equal(r.state, 'pending'); assert.equal(r.attempts, 0); assert.equal(r.lease_token, null);
      assert.equal(r.dedup_key, 'event:' + eventId); assert.equal(r.payload.eventId, eventId); assert.equal(r.payload.orderId, orderId); assert.equal(r.payload.trigger, 'order.created');
      assert.deepEqual(r.payload.rules, []); assert.equal(r.payload.snapshot.id, orderId); assert.equal(r.payload.snapshot.total, 777); assert.equal(r.payload.snapshot.item_count, 1);
      assert.equal(r.payload.context.depth, 0); assert.deepEqual(r.payload.context.trace, []); uuid(r.payload.context.chain_id);
    });
    audits.push({ tenant: s.tenant_id, user: null, action: 'order.create', entity: orderId, detail: {} },
      { tenant: s.tenant_id, user: null, action: 'b2b.checkout', entity: orderId, detail: { account_id: s.account.id, quote_id: g.quote.source_quote_id } },
      { tenant: b.tenant_id, user: b.user_id, action: 'b2b.network.checkout', entity: g.purchase.id, detail: { link_id: b.link.id, source_order_id: orderId } });
  }
  append('audit_events', audits.length, r => {
    const a = one(audits.filter(v => v.tenant === r.tenant_id && v.action === r.action && v.entity === r.entity_id));
    assert.equal(r.user_id, a.user); assert.deepEqual(r.detail, a.detail); uuid(r.id);
  });
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(after.rows).sort());
  // PostgreSQL jsonb and constructed expected objects have different key
  // insertion orders. Sort by canonical keys; compare every original value.
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  const sorted = (r: Row[]) => [...r].sort((a, b) => fp(canonical(a)).localeCompare(fp(canonical(b))));
  for (const table of Object.keys(expected)) assert.deepEqual(sorted(rows(after, table)), sorted(expected[table]), 'Exact own-row delta: ' + table);
  return g;
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(await realpath(ROOT), ROOT); assert.equal(process.argv.length, 3); assert(PHASES.includes(phase));
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, CONFIG); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert(!process.env.DYNA_TEST); assert(!process.env.DYNA_PREVIEW_PORT);
  assert.equal(process.env.QA159_CHROME_READBACK_CONFIRM, 'READ_ONLY_UI_HANDOFF_EXACT_TWO_OWN_QA159_FIRMS');
  for (const name of ['data', 'docs']) { const p = resolve(ROOT, name), s = await lstat(p); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(p), p); }
  const output = privatePath(phase), report = resolve(ROOT, 'docs/b2b-catalog-native159-chrome-' + phase + '.json'); await absent(output); await absent(report);
  flow = await pin(JOURNAL, process.env.QA159_FLOW_JOURNAL_SHA256);
  assert.equal(flow.stage, 159); assert.equal(flow.schema_revision, schema); assert.equal(flow.runtime_revision, revision);
  assert.equal(flow.status, 'CONFIRMED'); assert.equal(flow.pending, null); assert.equal(flow.complete, false);
  assert.deepEqual(flow.completed_phases, ['prepare', 'configure', 'refresh']);
  assert.deepEqual(Object.keys(flow.actors).sort(), ['buyer', 'supplier']);
  assert(flow.last_capture && flow.actors.buyer.run && flow.actors.buyer.item);
  assert(!flow.completed.some((r: Row) => /^(bind|quote|checkout)-/.test(r.label)));
  baseline = await pin(resolve(ROOT, 'data/b2b-catalog-native159-after-migration.json'), process.env.QA159_AFTER_MIGRATION_SHA256);
  assert.equal(baseline.status, 'READ_ONLY_B2B_CATALOG_CHECKPOINT_PASS'); assert.equal(baseline.phase, 'after-migration'); assert.equal(baseline.schema_revision, schema);
  assert.equal(flow.after_migration_sha256, pins.get(resolve(ROOT, 'data/b2b-catalog-native159-after-migration.json'))!.digest);
  prior = await pin(resolve(WT, 'docs/product-catalogs-preservation157-before.json'), baseline.inputs.preservation162, 0o644);
  assert.equal(prior.stage, 157); assert.equal(prior.status, 'PRESERVATION_PASS'); assert.equal(prior.tenants.length, 162);
  assert.equal(Object.keys(prior.private_files).length, 366); assert.equal(baseline.inputs.config, prior.config.sha256);
  await pin(CONFIG, baseline.inputs.config);
  for (const [file, digest] of [
    ['product-catalogs-stage157.json', baseline.inputs.setup157], ['product-catalogs-checkpoint157-after-commerce.json', baseline.inputs.accepted157],
    ['catalog-export-catalogs-checkpoint158-before-native.json', baseline.inputs.checkpoint158], ['b2b-catalog-native159-before-migration.json', baseline.inputs.before159],
  ]) await pin(resolve(ROOT, 'data', file), digest);
  let previous: Row | undefined, predecessorSHA: string | null = null, handoffSHA: string | null = null;
  const index = PHASES.indexOf(phase);
  if (index > 0) {
    assert.match(process.env.QA159_CHROME_PREVIOUS_SHA256 ?? '', /^[a-f0-9]{64}$/);
    predecessorSHA = process.env.QA159_CHROME_PREVIOUS_SHA256!;
    let expectedSHA = predecessorSHA;
    for (let i = index - 1; i >= 0; i--) {
      const p = await pin(privatePath(PHASES[i]), expectedSHA); if (i === index - 1) previous = p;
      assert.equal(p.stage, 159); assert.equal(p.phase, PHASES[i]); assert.equal(p.revision, revision); assert.equal(p.schema_revision, schema);
      assert.equal(p.flow_journal_sha256, pins.get(JOURNAL)!.digest); assert.equal(p.after_migration_sha256, flow.after_migration_sha256);
      assert.equal(p.status, i === 0 ? 'HANDOFF_VERIFIED' : PHASES[i].startsWith('before-') ? 'UI_INTENT_PENDING' : 'DURABLE_DB_ACTION_VERIFIED');
      if (i > 0) { assert.match(p.predecessor_sha256, /^[a-f0-9]{64}$/); expectedSHA = p.predecessor_sha256; }
      else { assert.equal(p.predecessor_sha256, null); handoffSHA = expectedSHA; assert.equal(p.status, 'HANDOFF_VERIFIED'); assert.deepEqual(p.capture, flow.last_capture); }
    }
    assert.equal(process.env.QA159_CHROME_HANDOFF_SHA256, handoffSHA);
  }
  await custody(); await healthAndActors(); pool = (await import('../server/db')).pool;
  const u = new URL(pool.options.connectionString!); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/dynaminds'); assert.equal(u.username, 'postgres');
  assert.deepEqual((await pool.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0], { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
  step = phase; const captured = await capture(), g = graph(captured);
  let intent: Row | null = null, proof: Row | null = null;
  if (phase === 'handoff') {
    assert.deepEqual(captured, flow.last_capture); assert(!g.binding && !g.quote && !g.purchase);
  } else if (phase.startsWith('before-')) {
    assert.deepEqual(captured, previous!.capture);
    const action = phase.slice(7); assert(['bind', 'quote', 'checkout'].includes(action));
    if (action === 'bind') assert(!g.binding && !g.quote && !g.purchase);
    if (action === 'quote') assert(g.binding && !g.quote && !g.purchase);
    if (action === 'checkout') { assert(g.binding && g.quote && !g.purchase); assert(Date.parse(g.quote.expires_at) > Date.now(), 'Fresh checkout intent requires an unexpired quote'); }
    const b = flow.actors.buyer;
    const path = '/api/b2b/network/links/' + b.link.id + (action === 'bind' ? '/catalog/' + b.item.id + '/bind' : action === 'quote' ? '/quotes' : '/quotes/' + uuid(g.quote!.id) + '/checkout');
    intent = { action, method: 'POST', path, actor_id: b.user_id, tenant_id: b.tenant_id, api_key_id: null,
      expected: action === 'bind' ? { item_id: b.item.id, version: b.item.version, product_id: b.selected.id, confirmed: true }
        : action === 'quote' ? { warehouse_id: b.warehouse_id, items: [{ item_id: b.item.id, quantity: 1 }] } : { confirmed: true },
      request_bytes_captured: false, client_key_unknown_before_ui_generation: action !== 'checkout',
      mutation_sent_by_helper: false, request_confirmed: false };
  } else {
    const action = phase.slice(6) as 'bind' | 'quote' | 'checkout';
    assert.equal(previous!.status, 'UI_INTENT_PENDING'); assert.equal(previous!.intent.action, action);
    const actual = delta(previous!.capture, captured, action);
    proof = action === 'bind' ? { binding: actual.binding } : action === 'quote' ? { quote: actual.quote } : { purchase: actual.purchase };
  }
  // GETs hydrate only the graph established above. They do not prove a click or
  // resolve an unknown browser attempt; that requires its own exact response.
  const b = flow.actors.buyer, catalog = await get(b, '/b2b/network/links/' + b.link.id + '/catalog');
  assert.equal(catalog.data.length, 1); assert.equal(catalog.next, null); assert.equal(catalog.data[0].id, b.item.id);
  assert.equal(catalog.target_catalog.id, b.catalog.id); assert.equal(catalog.data[0].product_id, g.binding ? b.selected.id : null);
  let purchaseRead: Row | null = null;
  if (g.purchase) { purchaseRead = await get(b, '/b2b/network/orders/' + g.purchase.id); assert.equal(purchaseRead.id, g.purchase.id); assert.equal(purchaseRead.source_order_id, g.purchase.source_order_id); assert.equal(purchaseRead.total_gross, 777); }
  await healthAndActors(); await custody(); assert.deepEqual(await capture(), captured, 'Pure reads unchanged');
  const status = phase === 'handoff' ? 'HANDOFF_VERIFIED' : intent ? 'UI_INTENT_PENDING' : 'DURABLE_DB_ACTION_VERIFIED';
  await wx(output, { stage: 159, phase, status, revision, schema_revision: schema,
    flow_journal_sha256: pins.get(JOURNAL)!.digest, after_migration_sha256: flow.after_migration_sha256,
    predecessor_sha256: predecessorSHA, handoff_sha256: handoffSHA, intent, proof, capture: captured,
    purchase_read: purchaseRead, sessions_excluded: true, baseline_rebased: false,
    original_flow_journal_unchanged: true, native_ui_verified: false, browser_unknown_resolved: false,
    mutation_sent_by_helper: false, provider_verified: false, full_goal_complete: false }, 0o600);
  await custody();
  await wx(report, { stage: 159, phase, status, revision, schema_revision: schema,
    flow_journal_sha256: pins.get(JOURNAL)!.digest, after_migration_sha256: flow.after_migration_sha256,
    predecessor_sha256: predecessorSHA, handoff_sha256: handoffSHA, sidecar_sha256: sha(await bytes(output, 0o600)),
    own_tables: Object.keys(captured.rows).length, own_snapshot_sha256: fp(captured.snapshot),
    own_counts: Object.fromEntries(Object.entries(captured.snapshot).map(([name, v]) => [name, v.count])),
    bindings: g.binding ? 1 : 0, network_quotes: g.quote ? 1 : 0, network_purchases: g.purchase ? 1 : 0,
    supplier_reserved: g.purchase ? 1 : 0, buyer_on_hand: 0,
    all_original_global_rows_retained: true, config_and_original_private_files_exact: true,
    original_flow_journal_unchanged: true, baseline_rebased: false, sessions_excluded: true,
    mutation_sent_by_helper: false, request_bytes_captured: false, browser_unknown_resolved: false,
    native_ui_verified: false, provider_verified: false, full_goal_complete: false }, 0o644);
  process.stdout.write('QA159_CHROME_READBACK_' + phase + '_RECORDED\n');
}
main().catch((error: unknown) => {
  const m = (error instanceof Error ? error.stack ?? '' : '').match(/b2b-catalog-native159-chrome-readback\.ts:(\d+):(\d+)/);
  // Reveal only schema identifiers for an exact-row mismatch, never values.
  const mismatch = error instanceof Error ? error.message.match(/^Exact own-row delta: ([a-z][a-z0-9_]*)\b/) : null;
  const difference = error as { actual?: Row[]; expected?: Row[] };
  const fields = mismatch && Array.isArray(difference.actual) && Array.isArray(difference.expected)
    ? [...new Set(difference.actual.flatMap((r, i) => Object.keys(r).filter(k =>
      /^[a-z][a-z0-9_]*$/.test(k) && JSON.stringify(r[k]) !== JSON.stringify(difference.expected![i]?.[k]))))].sort() : [];
  process.stderr.write(JSON.stringify({ status: 'QA159_CHROME_READBACK_FAILED', step,
    ...(error instanceof Error && /^Read response: \/[a-z0-9/:_-]+\b/.test(error.message)
      ? { read_route: error.message.split('\n')[0].slice('Read response: '.length), read_status: (error as { actual?: number }).actual } : {}),
    ...(mismatch ? { mismatch_table: mismatch[1], mismatch_fields: fields } : {}),
    ...(m ? { source_line: Number(m[1]), source_column: Number(m[2]) } : {}), private_details_withheld: true }) + '\n'); process.exitCode = 1;
}).finally(async () => { try { await pool?.end(); } catch { process.stderr.write('QA159_CHROME_READBACK_CLOSE_FAILED_PRIVATE_DETAILS_WITHHELD\n'); process.exitCode = 1; } });
