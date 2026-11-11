/** Root-only QA152. Ordinary GETs and owner RR READ ONLY; never requests/receives a return. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const schema = '135_order_parcel_completion_fix';
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const statePath = resolve(root, 'data/order-parcels-stage151.json');
const phase = process.argv[2];
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => sha(JSON.stringify(v));
type Rows = Record<string, any[]>;
let pool: Pool | undefined, step = 'preflight';
const uuid = (v: unknown) => { assert.equal(typeof v, 'string'); assert.match(v as string, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/); return v as string; };
const one = (rows: any[], label: string) => { assert.equal(rows.length, 1, label); return rows[0]; };
const keyed = (rows: any[], key: string, value: unknown) => one(rows.filter(r => r[key] === value), 'Unique own identity: ' + key);
const omit = (row: any, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
async function regular(path: string, mode?: number) { const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); if (mode !== undefined) assert.equal(s.mode & 0o777, mode); }
async function absent(path: string) { try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } throw Error('Exclusive evidence already exists'); }
async function load(path: string, mode?: number) { await regular(path, mode); const bytes = await readFile(path); return { path, bytes, value: JSON.parse(bytes.toString('utf8')) }; }
async function get(a: any, path: string) { assert(path.startsWith('/') && !path.includes('://')); const r = await fetch(base + path, { headers: { cookie: a.cookie, 'X-Workspace-ID': a.tenant_id }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) }); assert.equal(r.status, 200, 'Ordinary GET; no login or retry'); const b = Buffer.from(await r.arrayBuffer()); assert(b.length <= 8 * 1024 * 1024); return JSON.parse(b.toString('utf8')); }
async function health() { const r = await fetch(base + '/health', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) }); assert.equal(r.status, 200); const h = await r.json(); assert.equal(h.status, 'ok'); assert.equal(h.revision, revision); assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local'); assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false); assert.equal(h.order_parcels_available, true); }
function fingerprints(rows: Rows) { return Object.fromEntries(Object.entries(rows).map(([name, r]) => [name, { count: r.length, sha256: hash(r.map(row => ({ row }))) }])); }
async function capture(c: PoolClient, actors: any[]) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.deepEqual((await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0], { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name")).rows.map(r => r.table_name as string);
    assert.equal(names.length, 383);
    const firms: any[] = [];
    for (const a of actors) {
      assert.deepEqual(names, Object.keys(a.setup_checkpoint));
      const rows: Rows = {};
      for (const name of names) { assert.match(name, /^[a-z_][a-z0-9_]*$/); const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id'; rows[name] = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=$1 ORDER BY 1`, [name === 'users' ? a.user_id : a.tenant_id])).rows.map(r => r.row); }
      firms.push({ tenant_id: a.tenant_id, rows, snapshot: fingerprints(rows) });
    }
    await c.query('COMMIT'); return firms;
  } finally { await c.query('ROLLBACK').catch(() => {}); }
}
function additions(before: any[], after: any[], expected: number, name: string) {
  const bag = new Map<string, number>(); for (const r of before) bag.set(hash(r), (bag.get(hash(r)) ?? 0) + 1);
  const fresh: any[] = [];
  for (const r of after) { const k = hash(r), n = bag.get(k) ?? 0; if (n) bag.set(k, n - 1); else fresh.push(r); }
  assert([...bag.values()].every(n => n === 0), 'Every original full row retained: ' + name);
  assert.equal(fresh.length, expected, 'Exact causal additions: ' + name); return fresh;
}
function unchanged(before: Rows, after: Rows, allowed: Set<string>) { assert.deepEqual(Object.keys(after), Object.keys(before)); for (const name of Object.keys(before)) if (!allowed.has(name)) assert.deepEqual(after[name], before[name], 'Whole table unchanged: ' + name); }
function compareMutable(before: any[], after: any[], key: (r: any) => string, fields: string[], name: string) { assert.equal(after.length, before.length, name); for (const old of before) { const r = one(after.filter(r => key(r) === key(old)), name); assert.deepEqual(omit(r, fields), omit(old, fields), 'Original metadata retained: ' + name); } }

function checkCommercial(a: any, rows: Rows, received: boolean) {
  const order = one(rows.orders, 'One original sale'); assert.equal(order.id, a.order_id); assert.equal(order.status, received ? 'return_received' : 'shipped'); assert.equal(order.total, 30000); assert.equal(order.shipping_cost, 0); assert.equal(order.currency, 'PLN');
  const item = one(rows.order_items, 'One original commercial UUID'); assert.equal(item.id, a.customer_item_id); assert.equal(item.quantity, 3); assert.equal(item.scanned, 3);
  assert.equal(rows.order_parcel_plans.length, 1); assert.equal(rows.order_parcel_dispatches.length, 2); assert.equal(rows.order_parcel_admissions.length, 3); assert.equal(rows.shipments.length, 2); assert(rows.shipments.every(s => s.dispatched_at && s.order_id === a.order_id));
  for (const p of a.components) {
    const s = keyed(rows.stock, 'product_id', p.id); assert.equal(s.warehouse_id, a.warehouse_id); assert.equal(s.on_hand, (received ? 5 : 2) * p.recipe_quantity); assert.equal(s.reserved, 0); assert.equal(s.available, s.on_hand);
    const bins = rows.stock_locations.filter(r => r.product_id === p.id); const quantities = Object.fromEntries(bins.map(r => [r.location, r.quantity]));
    assert.deepEqual(quantities, received && !a.on ? { 'QA151-01': 2, ZWROT: 3 } : { 'QA151-01': (received ? 5 : 2) * p.recipe_quantity });
    const reservation = keyed(rows.reservations, 'product_id', p.id); assert.equal(reservation.quantity, 3 * p.recipe_quantity); assert.equal(reservation.consumed_quantity, reservation.quantity); assert.equal(reservation.state, 'consumed');
    const loc = keyed(rows.reservation_locations, 'product_id', p.id); assert.equal(loc.quantity, reservation.quantity); assert.equal(loc.consumed_quantity, reservation.quantity); assert.equal(loc.scanned, reservation.quantity);
    if (a.on) { const pos = keyed(rows.wms_layer_positions, 'product_id', p.id); assert.equal(pos.quantity, s.on_hand); assert.equal(pos.reserved, 0); assert.equal(pos.location, 'QA151-01'); const layer = keyed(rows.wms_cost_layers, 'id', pos.layer_id); assert.equal(String(layer.unit_cost_minor), String(p.unit_cost_minor)); assert.equal(layer.currency, 'PLN'); }
  }
}
function checkReturn(a: any, rows: Rows, received: boolean) {
  const r = one(rows.return_cases, 'Exactly one new full RMA'); uuid(r.id); assert.equal(r.order_id, a.order_id); assert.equal(r.warehouse_id, a.warehouse_id); assert.equal(r.kind, 'return'); assert.equal(r.remedy, 'refund'); assert.equal(r.legacy, false); assert.equal(r.state, received ? 'refund_pending' : 'requested'); assert.equal(r.refund_amount, received ? 30000 : 0); assert.equal(r.requested_shipping, 0); assert.equal(r.refunded_shipping, 0); assert.equal(r.refunded_at, null); assert.equal(r.settlement, null); assert.equal(r.receipt_sequence, received ? 1 : 0); assert.equal(r.version, received ? 2 : 1); assert.equal(Boolean(r.received_at), received); assert.equal(Boolean(r.receipt), received);
  assert.equal(r.request.kind, 'return'); assert.equal(r.request.shipping_refund, 0); assert.deepEqual(r.request.items, [{ item_id: a.customer_item_id, quantity: 3 }]); uuid(r.client_key); assert.equal(r.request.client_key, r.client_key);
  const item = one(rows.return_items, 'Exactly one RMA line'); assert.equal(item.order_id, a.order_id); assert.equal(item.return_id, r.id); assert.equal(item.item_id, a.customer_item_id); assert.equal(item.requested, 3); assert.equal(item.accepted, received ? 3 : 0); assert.equal(item.restocked, received ? 3 : 0); assert.equal(item.refund_amount, received ? 30000 : 0);
  assert.deepEqual([...item.components].sort((x, y) => x.product_id.localeCompare(y.product_id)), a.components.map((p: any) => ({ product_id: p.id, quantity: p.recipe_quantity })).sort((x: any, y: any) => x.product_id.localeCompare(y.product_id)));
  const sale = one(rows.order_items, 'One historical commercial item'); assert.equal(item.sku, sale.sku); assert.equal(item.name, sale.name);
  if (received) { assert.equal(r.receipt.shipping_refund, 0); assert.deepEqual(r.receipt.items, [{ item_id: a.customer_item_id, accepted: 3, restocked: 3 }]); assert.equal(typeof r.receipt.note, 'string'); assert(r.receipt.note.length >= 3); }
  return r;
}
function eventAppend(a: any, before: Rows, after: Rows, r: any, trigger: string) {
  const e = one(additions(before.order_events, after.order_events, 1, 'order_events'), 'One RMA event'); assert.equal(e.order_id, a.order_id); assert.equal(e.kind, trigger); assert.equal(e.detail.return_id, r.id);
  const au = one(additions(before.audit_events, after.audit_events, 1, 'audit_events'), 'One RMA audit'); assert.equal(au.action, trigger); assert.equal(au.entity_id, r.id); assert.equal(au.user_id, a.user_id); assert.equal(au.detail.return_id, r.id);
  const j = one(additions(before.jobs, after.jobs, 1, 'jobs'), 'One pending local automation'); assert.equal(j.kind, 'automation'); assert.equal(j.state, 'pending'); assert.equal(j.attempts, 0); assert.equal(j.payload.trigger, trigger); assert.equal(j.payload.eventId, e.id); assert.equal(j.payload.orderId, a.order_id); assert.deepEqual(j.payload.rules, []); assert.equal(j.payload.snapshot.id, a.order_id); assert.equal(j.dedup_key, 'event:' + e.id);
  if (trigger === 'return.received') { assert.equal(e.detail.accepted, 3); assert.equal(e.detail.restocked, 3); assert.equal(e.detail.refund_amount, 30000); }
}
function requestDelta(a: any, before: Rows, after: Rows, r: any) {
  unchanged(before, after, new Set(['orders', 'return_cases', 'return_items', 'order_events', 'audit_events', 'jobs']));
  assert.equal(before.return_cases.length, 0); assert.equal(before.return_items.length, 0);
  compareMutable(before.orders, after.orders, r => r.id, ['updated_at', 'version'], 'orders'); assert.equal(BigInt(after.orders[0].version), BigInt(before.orders[0].version) + 1n);
  eventAppend(a, before, after, r, 'return.requested');
}
function receiveDelta(a: any, before: Rows, after: Rows, r: any) {
  const allowed = new Set(['orders', 'return_cases', 'return_items', 'order_events', 'audit_events', 'jobs', 'stock', 'stock_locations', 'stock_movements', 'stock_location_movements', 'purchasing_stock_changes']);
  if (a.on) for (const n of ['wms_layer_positions', 'wms_operations', 'wms_layer_movements', 'wms_return_fragments']) allowed.add(n);
  unchanged(before, after, allowed);
  compareMutable(before.orders, after.orders, x => x.id, ['updated_at', 'version', 'status', 'workflow_status_id'], 'orders'); assert.equal(BigInt(after.orders[0].version), BigInt(before.orders[0].version) + 2n); assert.equal(after.orders[0].workflow_status_id, null);
  compareMutable(before.return_cases, after.return_cases, x => x.id, ['state', 'receipt', 'refunded_shipping', 'refund_amount', 'decision_note', 'received_at', 'receipt_sequence', 'version', 'updated_at'], 'return_cases');
  compareMutable(before.return_items, after.return_items, x => x.item_id, ['accepted', 'restocked', 'refund_amount'], 'return_items');
  compareMutable(before.stock, after.stock, x => x.product_id + ':' + x.warehouse_id, ['on_hand', 'available', 'version'], 'stock');
  for (const old of before.stock) { const now = keyed(after.stock, 'product_id', old.product_id); const p = a.components.find((p: any) => p.id === old.product_id); assert.equal(BigInt(now.version), BigInt(old.version) + (p ? 1n : 0n)); assert.equal(now.on_hand - old.on_hand, p ? 3 * p.recipe_quantity : 0); }
  const oldBins = before.stock_locations;
  assert.equal(after.stock_locations.length, oldBins.length + (a.on ? 0 : 1));
  for (const old of oldBins) { const now = one(after.stock_locations.filter(x => x.product_id === old.product_id && x.location === old.location), 'Retained bin'); assert.deepEqual(omit(now, ['quantity']), omit(old, ['quantity'])); const p = a.components.find((p: any) => p.id === old.product_id); assert.equal(now.quantity - old.quantity, a.on && p ? 3 * p.recipe_quantity : 0); }
  const movements = additions(before.stock_movements, after.stock_movements, a.components.length, 'stock_movements');
  const bins = additions(before.stock_location_movements, after.stock_location_movements, a.components.length, 'stock_location_movements');
  for (const p of a.components) { const m = keyed(movements, 'product_id', p.id); assert.equal(m.kind, 'return'); assert.equal(m.return_id, r.id); assert.equal(m.order_id, a.order_id); assert.equal(m.warehouse_id, a.warehouse_id); assert.equal(m.delta, 3 * p.recipe_quantity); assert.equal(m.note, r.number); const b = keyed(bins, 'product_id', p.id); assert.equal(b.kind, 'stock_in'); assert.equal(b.warehouse_id, a.warehouse_id); assert.equal(b.location, a.on ? 'QA151-01' : 'ZWROT'); assert.equal(b.delta, m.delta); }
  // INSERT .. ON CONFLICT DO NOTHING and UPDATE each fire the purchasing statement journal.
  const pc = additions(before.purchasing_stock_changes, after.purchasing_stock_changes, 2 * a.components.length, 'purchasing_stock_changes'); assert(pc.every(x => x.tenant_id === a.tenant_id));
  eventAppend(a, before, after, r, 'return.received');
  if (!a.on) { assert.equal(r.receipt.wms_lots, undefined); return { restored_known_value_minor: null, return_fragments: 0, original_dispatch_groups: 0 }; }
  const issues = before.wms_issue_fragments; assert.equal(issues.length, 4); assert.equal(new Set(issues.map(x => x.operation_id)).size, 2);
  const op = one(additions(before.wms_operations, after.wms_operations, 1, 'wms_operations'), 'One genuine WMS return operation'); assert.equal(op.kind, 'return'); assert.equal(op.order_id, a.order_id); assert.equal(op.return_id, r.id); assert.equal(op.actor_id, a.user_id); assert.equal(op.client_key, r.receipt.wms_lots.client_key); assert.deepEqual(op.request, r.receipt);
  const fs = additions(before.wms_return_fragments, after.wms_return_fragments, 4, 'wms_return_fragments'); assert.equal(new Set(fs.map(f => f.issue_fragment_id)).size, 4); assert.equal(new Set(fs.map(f => keyed(issues, 'id', f.issue_fragment_id).operation_id)).size, 2);
  const journal = additions(before.wms_layer_movements, after.wms_layer_movements, 4, 'wms_layer_movements'); let value = 0n;
  for (const f of fs) { const i = keyed(issues, 'id', f.issue_fragment_id), p = keyed(a.components, 'id', i.product_id); assert.equal(f.operation_id, op.id); assert.equal(f.return_id, r.id); assert.equal(f.order_id, a.order_id); assert.equal(f.product_id, i.product_id); assert.equal(f.layer_id, i.layer_id); assert.equal(f.warehouse_id, a.warehouse_id); assert.equal(f.quantity, i.quantity); assert.equal(f.location, 'QA151-01'); assert.equal(String(i.unit_cost_minor), String(p.unit_cost_minor)); assert.equal(String(f.value_minor), String(f.quantity * p.unit_cost_minor)); value += BigInt(f.value_minor); const j = one(journal.filter(j => j.operation_id === op.id && j.product_id === f.product_id && j.layer_id === f.layer_id && j.delta === f.quantity), 'Exact return fragment journal'); assert.equal(j.kind, 'return'); assert.equal(j.location, f.location); assert.equal(j.warehouse_id, f.warehouse_id); assert.equal(j.value_delta, f.value_minor); const pick = keyed(r.receipt.wms_lots.picks, 'issue_fragment_id', i.id); assert.equal(pick.quantity, i.quantity); assert.equal(pick.location, f.location); }
  assert.equal(value, 6000n); assert.equal(op.result.fragments.length, 4); assert.deepEqual(op.result.fragments.map((f: any) => f.id).sort(), fs.map(f => f.id).sort());
  compareMutable(before.wms_layer_positions, after.wms_layer_positions, x => x.product_id + ':' + x.layer_id + ':' + x.location, ['quantity', 'version'], 'wms_layer_positions');
  for (const old of before.wms_layer_positions) { const now = keyed(after.wms_layer_positions, 'product_id', old.product_id), p = keyed(a.components, 'id', old.product_id); assert.equal(now.quantity - old.quantity, 3 * p.recipe_quantity); assert.equal(BigInt(now.version), BigInt(old.version) + 2n); }
  assert.deepEqual(r.receipt.wms_lots.stock_versions.map((v: any) => v.product_id).sort(), a.components.map((p: any) => p.id).sort()); for (const v of r.receipt.wms_lots.stock_versions) { assert.equal(v.warehouse_id, a.warehouse_id); assert.equal(v.version, String(keyed(before.stock, 'product_id', v.product_id).version)); }
  return { restored_known_value_minor: value.toString(), return_fragments: 4, original_dispatch_groups: 2 };
}

async function main() {
  assert(['before', 'after-request', 'after-receive', 'after-restart'].includes(phase)); assert.equal(resolve(process.cwd()), root); assert.equal(resolve(dirname(fileURLToPath(import.meta.url)), '..'), root); assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json')); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.notEqual(process.env.DYNA_TEST, 'true'); await regular(resolve(root, '.local.json'), 0o600);
  const setup = await load(statePath, 0o600), s = setup.value; assert.equal(s.stage, 151); assert.equal(s.complete, true); assert.equal(s.pending, null); assert.equal(s.phase, 'READY_BEFORE_PARCEL_PREVIEW'); const actors = [s.off, s.on]; assert.notEqual(s.off.tenant_id, s.on.tenant_id); for (const [i, a] of actors.entries()) { assert.equal(a.complete, true); assert.equal(a.on, i === 1); for (const k of ['tenant_id', 'user_id', 'warehouse_id', 'order_id', 'customer_item_id', 'sale_product_id']) uuid(a[k]); assert.equal(a.components.length, a.on ? 2 : 1); assert.equal(typeof a.cookie, 'string'); assert(a.cookie.startsWith('dyna_session=') && !/[\r\n]/.test(a.cookie)); }
  const output = resolve(root, `docs/order-parcels-native152-${phase}.json`), checkpointPath = resolve(root, `data/order-parcels-stage152-${phase}.json`); await absent(output); await absent(checkpointPath);
  const old = await load(resolve(root, 'docs/order-parcels-native151-after-restart.json')); assert.equal(old.value.status, 'NATIVE_QUANTITY_EVIDENCE_PASS'); assert.equal(old.value.schema_revision, schema); assert.equal(old.value.setup_file_sha256, sha(setup.bytes));
  const inputs = [setup, old]; let before: any, requested: any, receivedCheckpoint: any;
  for (const [needed, name] of [[phase !== 'before', 'before'], [['after-receive', 'after-restart'].includes(phase), 'after-request'], [phase === 'after-restart', 'after-receive']] as Array<[boolean, string]>) if (needed) { const cp = await load(resolve(root, `data/order-parcels-stage152-${name}.json`), 0o600); assert.equal(cp.value.status, 'NATIVE_FULL_RETURN_EVIDENCE_PASS'); assert.equal(cp.value.phase, name); assert.equal(cp.value.setup_file_sha256, sha(setup.bytes)); assert.equal(cp.value.schema_revision, schema); inputs.push(cp); if (name === 'before') before = cp.value; if (name === 'after-request') requested = cp.value; if (name === 'after-receive') receivedCheckpoint = cp.value; }
  if (phase === 'after-restart') assert.equal(process.env.QA152_RESTART_VERIFIED, 'true', 'Root must attest an actual orderly process restart');
  step = 'health'; await health();
  pool = (await import('../server/db')).pool; const u = new URL(pool.options.connectionString!); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/dynaminds');
  step = 'native-before-GET'; const c = await pool.connect(); let firms: any[]; try { firms = await capture(c, actors); } finally { c.release(); }
  const evidence: any[] = [];
  for (const [i, a] of actors.entries()) {
    step = 'native-proof-' + a.label; const current = firms[i], rows = current.rows as Rows, isReceived = ['after-receive', 'after-restart'].includes(phase); checkCommercial(a, rows, isReceived);
    const oldFirm = keyed(old.value.firms, 'tenant_id', a.tenant_id); assert.equal(oldFirm.own_tables, 383); assert.equal(oldFirm.retained_admission_count, 3); assert.equal(rows.order_parcel_plans[0].id, oldFirm.plan_id);
    let r: any, physicalProof: any = { restored_known_value_minor: null, return_fragments: 0, original_dispatch_groups: 0 };
    if (phase === 'before') { assert.deepEqual(current.snapshot, oldFirm.snapshot, 'All QA151 rows unchanged before any RMA'); assert.equal(rows.return_cases.length, 0); assert.equal(rows.return_items.length, 0); assert.equal(rows.wms_return_fragments.length, 0); }
    else { r = checkReturn(a, rows, isReceived); const born = keyed(before.firms, 'tenant_id', a.tenant_id).rows as Rows; if (phase === 'after-request') requestDelta(a, born, rows, r); else { const requestRows = keyed(requested.firms, 'tenant_id', a.tenant_id).rows as Rows; requestDelta(a, born, requestRows, one(requestRows.return_cases, 'Prior requested RMA')); physicalProof = receiveDelta(a, requestRows, rows, r); } if (phase === 'after-restart') assert.deepEqual(current.snapshot, keyed(receivedCheckpoint.firms, 'tenant_id', a.tenant_id).snapshot, 'All 383 business tables exact after actual restart'); }
    step = 'ordinary-GET-' + a.label; const me = await get(a, '/auth/me'); assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin'); const order = await get(a, `/orders/${a.order_id}`), planReply = await get(a, `/order-parcels/plans/${oldFirm.plan_id}`); assert.equal(order.status, isReceived ? 'return_received' : 'shipped'); assert.equal(order.total, 30000); assert.equal(order.items.length, 1); assert.equal(order.items[0].id, a.customer_item_id); assert.equal(order.items[0].quantity, 3); assert.equal(order.items[0].scanned, 3); assert.equal(order.payment.received, 30000); assert.equal(order.payment.refunded, 0); assert.equal(order.payment.amount_due, 0); assert.equal(planReply.plan.complete, true); assert.equal(planReply.dispatches.length, 2); assert.equal(planReply.plan.id, oldFirm.plan_id); for (const d of rows.order_parcel_dispatches) assert.deepEqual(keyed(planReply.dispatches, 'id', d.id).receipt, d.receipt);
    if (r) { const api = await get(a, `/returns/${r.id}`); assert.equal(api.id, r.id); assert.equal(api.state, r.state); assert.equal(api.refund_amount, r.refund_amount); assert.equal(api.refunded_at, null); assert.equal(api.items.length, 1); assert.equal(api.items[0].item_id, a.customer_item_id); assert.equal(api.items[0].accepted, isReceived ? 3 : 0); assert.equal(api.items[0].restocked, isReceived ? 3 : 0); assert.equal(api.documents.length, 0); assert.deepEqual(api.receipt, r.receipt); }
    if (a.on) { const fragments: any[] = []; let cursor: string | undefined; const seen = new Set<string>(); for (let page = 0; page < 2; page++) { const reply = await get(a, `/wms-lots/orders/${a.order_id}/return-fragments${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`); assert.equal(reply.current_role, 'admin'); assert.equal(reply.can_read_value, true); fragments.push(...reply.data); cursor = reply.meta.cursor ?? undefined; if (!cursor) break; assert(!seen.has(cursor)); seen.add(cursor); } assert.equal(cursor, undefined); assert.equal(fragments.length, 4); for (const issue of rows.wms_issue_fragments) { const f = keyed(fragments, 'id', issue.id); assert.equal(f.remaining, isReceived ? 0 : issue.quantity); assert.equal(f.returned_quantity, isReceived ? issue.quantity : 0); assert.equal(String(f.unit_cost_minor), String(issue.unit_cost_minor)); assert.equal(String(f.value_minor), String(issue.value_minor)); } }
    evidence.push({ label: a.label, tenant_id: a.tenant_id, order_id: a.order_id, plan_id: oldFirm.plan_id, return_id: r?.id ?? null, order_status: order.status, commercial_requested: r ? 3 : 0, accepted: isReceived ? 3 : 0, restocked: isReceived ? 3 : 0, refund_credit_minor: isReceived ? 30000 : 0, actual_cash_refunded_minor: 0, retained_admissions: 3, retained_dispatches: 2, wms_enabled: a.on, physical: a.components.map((p: any) => { const st = keyed(rows.stock, 'product_id', p.id); return { product_id: p.id, on_hand: st.on_hand, reserved: st.reserved, bins: rows.stock_locations.filter(b => b.product_id === p.id).map(b => ({ location: b.location, quantity: b.quantity })) }; }), ...physicalProof, snapshot: current.snapshot, snapshot_sha256: hash(current.snapshot), own_tables: 383 });
  }
  step = 'GET-effect-free'; const c2 = await pool.connect(); try { const after = await capture(c2, actors); assert.deepEqual(after.map(f => f.snapshot), firms.map(f => f.snapshot), 'All ordinary GETs leave business rows exact'); } finally { c2.release(); }
  step = 'input-custody'; for (const input of inputs) { assert.deepEqual(await readFile(input.path), input.bytes); await regular(input.path, input.path.includes('/data/') ? 0o600 : undefined); } await health();
  const common = { stage: 152, status: 'NATIVE_FULL_RETURN_EVIDENCE_PASS', phase, revision, schema_revision: schema, setup_file_sha256: sha(setup.bytes), qa151_after_restart_sha256: sha(old.bytes), read_only_sql: true, ordinary_GET_only: true, sessions_excluded: true, setup_file_unchanged: true, provider_verified: false, bank_verified: false, full_goal_complete: false, restart_process_attested: phase === 'after-restart' };
  const privateBytes = JSON.stringify({ ...common, firms }, null, 2) + '\n'; const cp = await open(checkpointPath, 'wx', 0o600); try { await cp.writeFile(privateBytes); await cp.sync(); } finally { await cp.close(); }
  const report = await open(output, 'wx', 0o644); try { await report.writeFile(JSON.stringify({ ...common, checkpoint_sha256: sha(privateBytes), firms: evidence }, null, 2) + '\n'); await report.sync(); } finally { await report.close(); }
  console.log(JSON.stringify({ status: common.status, phase, firms: 2, own_tables: 383, mutations: 0 }));
}
main().catch(e => { const frames = String(e?.stack ?? '').split('\n').filter((line: string) => line.includes('order-parcels-native-returns152.ts:')).map((line: string) => line.match(/order-parcels-native-returns152\.ts:(\d+)/)?.[1]).filter(Boolean); console.error(JSON.stringify({ status: 'QA152_READBACK_FAILED', phase, step, code: typeof e?.code === 'string' && /^[A-Z0-9_]+$/.test(e.code) ? e.code : 'ASSERTION', source_lines: [...new Set(frames)], private_details_withheld: true, mutations: 0 })); process.exitCode = 1; }).finally(() => pool?.end());
