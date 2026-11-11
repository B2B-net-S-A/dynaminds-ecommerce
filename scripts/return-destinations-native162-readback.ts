/** ROOT ONLY, read-only native162 receipt evidence. No login, POST, worker,
 * provider, migration or fixture repair. Run from primary after frozen setup.
 * Phases: before | after-off | after-on | after-restart.
 * Required: QA162_READBACK_CONFIRM=READ_ONLY_OWN_DESTINATIONS_162,
 * QA_EXPECTED_REVISION=APP_REVISION=<actual40hex>, DYNA_WORKER_DISABLED=true,
 * QA162_SETUP_REVISION=<fixture40hex> defaults to QA_EXPECTED_REVISION;
 * a different fixture revision requires this explicit pin and after-restart.
 * DYNA_LOCAL_CONFIG_PATH=<primary>/.local.json, QA162_CONFIG_SHA256,
 * QA162_SETUP_SHA256 (completed companion), QA162_ORIGINAL_SETUP_SHA256
 * (immutable failed49-ACK basis). Later phases also QA162_READBACK_BEFORE_SHA256 and
 * explicit QA162_OFF_RECEIPT_ID; after-on/restart QA162_ON_RECEIPT_ID.
 * after-on/restart additionally QA162_READBACK_PRIOR_SHA256 pins preceding
 * accepted checkpoint. Sessions are INCLUDED. Optional exact own auth delta:
 * QA162_SESSION_DELTA_JSON={"off":{"added":["tokenSHA"],"removed":[]},
 * "on":{"added":[],"removed":[]}}; absent means NO session delta allowed.
 * Each added/removed hash must belong to the exact own actor/tenant, <=4 per
 * actor/action. Existing session rows cannot be modified or foreign rows lost.
 * after-on/restart ALSO require exact prior→current auth delta through
 * QA162_PRIOR_SESSION_DELTA_JSON (same shape; absent means no prior delta).
 * Cumulative before→current and incremental prior→current both must pass.
 * Outputs exclusive0600 data/return-destinations-native162-readback-PHASE.json
 * and sanitized0644 docs/return-destinations-native162-readback-PHASE.json.
 * This native/GET proof cannot establish Chrome clicks, HTTP201, exact replay
 * or paid refunds. Original147→148 migration custody is never rebased.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { captureReturnDestinationRestoreMetadata } from './return-destinations-native162-restore-readback';

type Row = Record<string, any>;
type Wrapped = { row: Row };
type Capture = { rows: Record<string, Wrapped[]>; fingerprints: Record<string, { count: number; sha256: string }>; portable_metadata: Awaited<ReturnType<typeof captureReturnDestinationRestoreMetadata>> };
const ROOT = '<workspace>/app';
const schema = '148_return_destinations', phase = process.argv[2], revision = process.env.QA_EXPECTED_REVISION ?? '';
const setupRevision = process.env.QA162_SETUP_REVISION ?? revision;
const configPath = resolve(ROOT, '.local.json'), setupPath = resolve(ROOT, 'data/return-destinations-native162-setup-completion.json');
const originalSetupPath = resolve(ROOT, 'data/return-destinations-native162-setup.json');
const originalSetupSha = '189961869a10b03c5642221b810243bbe11c75734fb69a31474519be72c502dd';
const beforePath = resolve(ROOT, 'data/return-destinations-native162-readback-before.json');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const identifier = (v: string) => { assert.match(v, /^[a-z][a-z0-9_]*$/); return '"' + v + '"'; };
const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };
const sorted = (v: unknown[]) => [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const fp = (rows: Wrapped[]) => ({ count: rows.length, sha256: sha(JSON.stringify(rows)) });
let c: pg.Client | undefined, step = 'preflight', gets = 0;
async function privateRead(path: string, max = 512 * 1024 * 1024) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600); assert(s.size > 0 && s.size <= max);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stable = (stat: typeof s) => { for (const key of ['ino', 'dev', 'size', 'mode', 'mtimeMs'] as const) assert.equal(stat[key], s[key]); };
    stable(await file.stat()); const bytes = await file.readFile(); stable(await file.stat()); stable(await lstat(path)); assert.equal(bytes.length, s.size); return bytes;
  } finally { await file.close(); }
}
async function absent(path: string) { try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } throw Error('Exclusive output exists'); }
async function fixedDir(path: string) { const s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(path), path); }
async function wx(path: string, value: unknown, mode: number) {
  await fixedDir(dirname(path)); const bytes = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 512 * 1024 * 1024);
  const file = await open(path, 'wx', mode); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } return sha(bytes);
}
async function get(a: Row | null, path: string) {
  assert(path.startsWith('/') && !path.includes('://') && !path.includes('lease_token'));
  const allowed = path === '/health' || path === '/auth/me' || /^\/return-destinations\/(options|operations\/[a-f0-9-]{36}|previews\/[a-f0-9-]{36}|returns\/[a-f0-9-]{36}\/history\?session_id=[a-f0-9-]{36}&limit=50)$/.test(path)
    || /^\/return-assistant\/sessions\/[a-f0-9-]{36}$/.test(path) || /^\/return-assistant\/photos\/[a-f0-9-]{36}\/content$/.test(path) || /^\/returns\/[a-f0-9-]{36}$/.test(path)
    || /^\/inventory\?warehouse_id=[a-f0-9-]{36}&limit=50$/.test(path);
  assert(allowed); gets++;
  const response = await fetch('http://127.0.0.1:4100/api' + path, { method: 'GET', headers: a ? { cookie: a.cookie, 'X-Workspace-ID': a.tenant_id } : {}, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length <= 16 * 1024 * 1024); return JSON.parse(bytes.toString('utf8')) as Row;
}
async function health() {
  const h = await get(null, '/health'); assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local'); assert.equal(h.revision, revision); assert.equal(h.schema_revision, schema);
  assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false); assert.equal(h.return_destinations_available, true); return h;
}
async function capture(): Promise<Capture> {
  await c!.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c!.query("SET LOCAL TimeZone='UTC'");
  try {
    assert.deepEqual((await c!.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0], { db: 'dynaminds', role: 'postgres', owner: 'postgres', host: '127.0.0.1', port: 55432, readonly: 'on' });
    const tables = (await c!.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows; assert.equal(tables.length, 455);
    const rows: Capture['rows'] = {}, fingerprints: Capture['fingerprints'] = {};
    for (const { tablename } of tables) { rows[tablename] = (await c!.query(`SELECT to_jsonb(x) row FROM public.${identifier(tablename)} x ORDER BY 1`)).rows; fingerprints[tablename] = fp(rows[tablename]); }
    assert(rows.sessions); assert.equal(one(rows.migrations.filter(x => x.row.name === schema).map(x => x.row)).name, schema);
    const portable_metadata = await captureReturnDestinationRestoreMetadata(c!); await c!.query('COMMIT'); return { rows, fingerprints, portable_metadata };
  } catch (e) { await c!.query('ROLLBACK').catch(() => undefined); throw e; }
}
function own(cap: Capture, a: Row, name: string) { return cap.rows[name].map(x => x.row).filter(x => x.tenant_id === a.tenant_id || (name === 'tenants' && x.id === a.tenant_id) || (name === 'users' && x.id === a.user_id)); }
function nonQa(cap: Capture, actors: Row[], name: string) { return cap.rows[name].filter(({ row }) => !actors.some(a => row.tenant_id === a.tenant_id || (name === 'users' && row.id === a.user_id) || (name === 'tenants' && row.id === a.tenant_id))); }
function sessionDelta(before: Capture, now: Capture, a: Row, expected: Row) {
  assert.deepEqual(Object.keys(expected).sort(), ['added', 'removed']);
  const old = own(before, a, 'sessions'), current = own(now, a, 'sessions'); assert(old.length > 0);
  const added = current.filter(x => !old.some(b => b.token_hash === x.token_hash)), removed = old.filter(x => !current.some(b => b.token_hash === x.token_hash));
  for (const x of current) { assert.equal(x.user_id, a.user_id); assert.equal(x.tenant_id, a.tenant_id); assert.match(x.token_hash, /^[a-f0-9]{64}$/); assert(Number.isFinite(Date.parse(x.expires_at))); const prior = old.find(b => b.token_hash === x.token_hash); if (prior) assert.deepEqual(x, prior); }
  for (const key of ['added', 'removed']) { assert(Array.isArray(expected[key]) && expected[key].length <= 4 && new Set(expected[key]).size === expected[key].length); expected[key].forEach((h: string) => assert.match(h, /^[a-f0-9]{64}$/)); }
  assert.deepEqual(added.map(x => x.token_hash).sort(), [...expected.added].sort()); assert.deepEqual(removed.map(x => x.token_hash).sort(), [...expected.removed].sort());
  assert(current.length > 0 && current.length <= old.length + 4); return { added: added.length, removed: removed.length, retained: current.length - added.length };
}
function compareProtected(before: Capture, now: Capture, actors: Row[]) {
  assert.deepEqual(Object.keys(now.rows), Object.keys(before.rows)); assert.deepEqual(now.portable_metadata, before.portable_metadata);
  for (const name of Object.keys(before.rows)) assert.deepEqual(nonQa(now, actors, name), nonQa(before, actors, name), 'Exact non-QA162 rows including sessions: ' + name);
}
// Bounded fixture: one order/RMA per actor, the original component products and
// two configured warehouses. Reconstruct the certificate's actual SQL scope
// from captured rows; do not execute a private SQL factory for readback.
function certificateSnapshot(cap: Capture, a: Row, admission: Row) {
  const products = new Set(a.components.map((x: Row) => x.id));
  const warehouses = new Set([admission.payload.snapshot.return_case.warehouse_id,
    ...admission.payload.plan.stock_effects.map((x: Row) => x.warehouse_id)]);
  const physical = new Set(['stock', 'stock_locations', 'stock_location_movements', 'wms_layer_positions', 'wms_layer_movements']);
  const originals = new Set(['wms_cost_layers', 'wms_lots']);
  const result: Row = {};
  for (const name of Object.keys(admission.before_snapshot)) {
    result[name] = own(cap, a, name).filter(x => name === 'orders' ? x.id === a.order_id
      : physical.has(name) ? (products.has(x.product_id) && warehouses.has(x.warehouse_id)) || (name === 'wms_layer_movements' && x.operation_id === admission.receipt_id)
      : originals.has(name) ? products.has(x.product_id) || x.operation_id === admission.receipt_id
      : x.order_id === a.order_id || (['wms_return_fragments', 'wms_issue_fragments'].includes(name) && x.operation_id === admission.receipt_id)
        || (name === 'wms_operations' && x.id === admission.receipt_id));
  }
  return result;
}
function compareOwnIntake(before: Capture, now: Capture, a: Row, graph: ReturnType<typeof receiptGraph>) {
  const append = new Set(['return_assistant_sessions', 'return_assistant_operations', 'return_assistant_photos',
    'return_assistant_previews', 'return_assistant_receipts', 'return_assistant_admissions',
    'return_destination_parts', 'return_destination_arrivals', 'return_destination_fragments', 'return_destination_admissions',
    'stock_movements', 'stock_location_movements', 'wms_operations', 'wms_return_fragments', 'wms_layer_movements',
    'order_events', 'audit_events', 'jobs']);
  const mutable = new Set(['orders', 'return_cases', 'return_items', 'stock', 'stock_locations', 'wms_layer_positions']);
  const births = graph.receipt.payload.plan.stock_effects.filter((x: Row) => !x.before.exists);
  for (const name of Object.keys(before.rows)) {
    if (name === 'sessions') continue; // separately bound to explicit token SHA sets
    const old = own(before, a, name), current = own(now, a, name);
    if (name === 'purchasing_stock_changes') {
      // 099 marks each stock birth/update statement; 100 marks each actual
      // arrival's stock movement INSERT. Every old immutable marker survives.
      for (const row of old) assert(current.some(x => JSON.stringify(x) === JSON.stringify(row)));
      const added = current.filter(x => !old.some(row => String(row.id) === String(x.id))), oldMax = old.reduce((max, x) => BigInt(x.id) > max ? BigInt(x.id) : max, 0n);
      assert.equal(added.length, births.length + graph.sidecar_counts.arrivals * 2); assert.equal(current.length, old.length + added.length);
      assert.equal(new Set(added.map(x => String(x.id))).size, added.length);
      for (const row of added) { assert.deepEqual(Object.keys(row).sort(), ['id', 'tenant_id']); assert.equal(row.tenant_id, a.tenant_id); assert(BigInt(row.id) > oldMax); }
      continue;
    }
    if (name === 'stock_file_import_epochs') {
      // 115 tracks INSERT/DELETE identity, not ordinary quantity UPDATE.
      // Only newly born stock cells receive a new epoch at version one.
      for (const row of old) assert(current.some(x => JSON.stringify(x) === JSON.stringify(row)));
      const added = current.filter(x => !old.some(row => row.warehouse_id === x.warehouse_id && row.product_id === x.product_id));
      assert.equal(current.length, old.length + births.length); assert.equal(added.length, births.length);
      assert.deepEqual(sorted(added.map(x => [x.warehouse_id, x.product_id])), sorted(births.map((x: Row) => [x.warehouse_id, x.product_id])));
      for (const row of added) { assert.deepEqual(Object.keys(row).sort(), ['product_id', 'tenant_id', 'version', 'warehouse_id']); assert.equal(row.tenant_id, a.tenant_id); assert.equal(String(row.version), '1'); }
      continue;
    }
    if (append.has(name)) {
      for (const row of old) assert(current.some(x => JSON.stringify(x) === JSON.stringify(row)), 'Every previous own journal row retained: ' + name);
    } else if (!mutable.has(name)) assert.deepEqual(current, old, 'No unrelated own fixture mutation: ' + name);
  }
  const admission = one(own(now, a, 'return_destination_admissions'));
  assert.deepEqual(Object.keys(admission.after_snapshot).sort(), Object.keys(admission.before_snapshot).sort());
  const original = certificateSnapshot(before, a, admission), actual = certificateSnapshot(now, a, admission);
  for (const name of Object.keys(original)) {
    assert.deepEqual(sorted(admission.before_snapshot[name]), sorted(original[name]), 'Certificate before equals actual before-Chrome scope: ' + name);
    assert.deepEqual(sorted(admission.after_snapshot[name]), sorted(actual[name]), 'Certificate after equals actual native scope: ' + name);
    if (mutable.has(name)) {
      const outside = (cap: Capture, scoped: Row[]) => own(cap, a, name).filter(x => !scoped.some(y => JSON.stringify(x) === JSON.stringify(y)));
      assert.deepEqual(outside(now, actual[name]), outside(before, original[name]), 'Other own mutable rows outside consent untouched: ' + name);
    }
  }
  const events = own(now, a, 'order_events').filter(x => !own(before, a, 'order_events').some(b => b.id === x.id));
  const received = one(events); assert.equal(received.order_id, a.order_id); assert.equal(received.kind, 'return.received');
  assert.equal(received.detail.return_id, a.return_id); assert.equal(received.detail.accepted, 2); assert.equal(received.detail.restocked, 1); assert.equal(received.detail.refund_amount, 2700);
  const jobs = own(now, a, 'jobs').filter(x => !own(before, a, 'jobs').some(b => b.id === x.id));
  const job = one(jobs); assert.equal(job.kind, 'automation'); assert.equal(job.state, 'pending'); assert.equal(job.attempts, 0);
  assert.equal(job.payload.eventId, received.id); assert.equal(job.payload.orderId, a.order_id); assert.equal(job.payload.trigger, 'return.received'); assert.deepEqual(job.payload.rules, []);
  const operations = own(now, a, 'return_assistant_operations'); assert(operations.length >= 2 && operations.length <= 30);
  for (const op of operations) { assert.equal(op.session_id, graph.session.id); assert.equal(op.actor_id, a.user_id); assert.equal(op.api_key_id, null); assert(['start', 'scan', 'draft', 'renew', 'photo'].includes(op.kind)); }
  for (const preview of own(now, a, 'return_assistant_previews')) { assert.equal(preview.session_id, graph.session.id); assert.equal(preview.return_id, a.return_id); assert.equal(preview.order_id, a.order_id); assert.equal(preview.actor_id, a.user_id); assert.equal(preview.api_key_id, null); assert.equal(preview.payload.snapshot.protocol, 'destinations_v1'); }
  const audits = own(now, a, 'audit_events').filter(x => !own(before, a, 'audit_events').some(b => b.id === x.id));
  assert(audits.length >= 6 && audits.length <= 35);
  for (const row of audits) {
    assert.equal(row.user_id, a.user_id);
    assert(['return.assistant.start', 'return.assistant.scan', 'return.assistant.draft', 'return.assistant.renew', 'return.assistant.photo', 'return.destinations.previewed', 'return.destinations.received', 'return.received'].includes(row.action));
    assert([a.return_id, graph.session.id, graph.preview.id, graph.receipt.id].includes(row.entity_id));
  }
}
function noPrivate(value: unknown) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(noPrivate); return; }
  for (const [key, v] of Object.entries(value)) { assert(!['lease_token', 'lease_token_hash', 'private_scope_nonce', 'nonce', 'api_key_id', 'request_hash', 'private_fragment_effects', 'unit_cost_minor', 'value_minor', 'value_delta', 'financial_hash', 'layers_hash', 'content_encrypted'].includes(key), 'Private field in public148 DTO'); noPrivate(v); }
}
function freshBefore(cap: Capture, a: Row) {
  for (const name of ['return_assistant_sessions', 'return_assistant_previews', 'return_assistant_receipts', 'return_assistant_admissions', 'return_assistant_photos', 'return_assistant_operations', 'return_destination_parts', 'return_destination_arrivals', 'return_destination_fragments', 'return_destination_admissions']) assert.equal(own(cap, a, name).length, 0);
  const rma = one(own(cap, a, 'return_cases')); assert.equal(rma.id, a.return_id); assert.equal(rma.state, 'requested'); assert.equal(rma.receipt, null); assert.equal(rma.refund_amount, 0); assert.equal(rma.received_at, null);
  const order = one(own(cap, a, 'orders')); assert.equal(order.id, a.order_id); assert.equal(order.status, 'shipped'); assert.equal(order.total, 4401);
  assert.deepEqual(sorted(own(cap, a, 'order_items').map(x => [x.id, x.product_id, x.quantity, x.line_total, x.components])), sorted(a.commercial_items.map((x: Row) => [x.id, x.product_id, x.quantity, x.line_total, x.components])));
  assert.equal(new Set(a.commercial_items.map((x: Row) => x.id)).size, 2); assert.deepEqual(a.commercial_items.map((x: Row) => [x.quantity, x.line_total]).sort((a: number[], b: number[]) => a[1] - b[1]), [[1, 1000], [2, 3401]]);
  for (const part of a.intended.parts) { assert(uuid(part.item_id)); assert.equal(part.quantity, 1); assert(a.commercial_items.some((x: Row) => x.id === part.item_id)); }
  assert.equal(a.intended.refund_minor, 2700); assert.equal(a.intended.parts.length, 3);
  for (const name of ['wms_cost_layers', 'wms_lots', 'wms_issue_fragments']) if (!a.on) assert.equal(own(cap, a, name).length, 0);
  if (a.on) {
    assert.deepEqual(a.components.map((x: Row) => x.unit_cost_minor).map((n: unknown) => n === null ? null : Number(n)).sort((x: number | null, y: number | null) => (x ?? 999999) - (y ?? 999999)), [0, 1000, null]);
    for (const component of a.components) { const issues = own(cap, a, 'wms_issue_fragments').filter(x => x.order_id === a.order_id && x.product_id === component.id); assert(issues.length > 0); for (const issue of issues) { assert.equal(issue.unit_cost_minor === null ? null : Number(issue.unit_cost_minor), component.unit_cost_minor === null ? null : Number(component.unit_cost_minor)); assert.equal(one(own(cap, a, 'wms_cost_layers').filter(x => x.id === issue.layer_id)).product_id, component.id); } }
  }
}
function receiptGraph(before: Capture, now: Capture, a: Row, receiptId: string) {
  assert(uuid(receiptId)); const receipt = one(own(now, a, 'return_assistant_receipts').filter(x => x.id === receiptId)); assert.equal(own(now, a, 'return_assistant_receipts').length, 1);
  const session = one(own(now, a, 'return_assistant_sessions')), preview = one(own(now, a, 'return_assistant_previews').filter(x => x.id === receipt.preview_id));
  const admission = one(own(now, a, 'return_destination_admissions')), legacyAdmission = one(own(now, a, 'return_assistant_admissions'));
  for (const row of [receipt, preview, admission, legacyAdmission]) { assert.equal(row.session_id, session.id); assert.equal(row.return_id, a.return_id); assert.equal(row.actor_id, a.user_id); assert.equal(row.api_key_id, null); }
  assert.equal(session.actor_id, a.user_id); assert.equal(session.station_id, a.station.id); assert.equal(session.state, 'completed'); assert.equal(session.order_id, a.order_id);
  assert.equal(receipt.scope_hash, preview.scope_hash); assert.equal(receipt.order_id, a.order_id); assert.equal(admission.receipt_id, receipt.id); assert.equal(legacyAdmission.receipt_id, receipt.id); assert.equal(admission.preview_id, preview.id); assert.equal(admission.transaction_id, legacyAdmission.transaction_id); assert(admission.before_snapshot && admission.after_snapshot);
  assert.deepEqual(receipt.payload, preview.payload); assert.deepEqual(receipt.payload, admission.payload); assert.deepEqual(receipt.payload, legacyAdmission.payload);
  const p = receipt.payload.plan; assert.equal(receipt.payload.snapshot.protocol, 'destinations_v1'); assert.equal(p.protocol, 'destinations_v1'); assert.equal(p.return_id, a.return_id); assert.equal(p.order_id, a.order_id);
  assert.deepEqual(p.summary, { accepted: 2, restocked_to_sale: 1, received_into_custody: 1, rejected: 1, commercial_credit_minor: 2700, shipping_refund_minor: 0 });
  const parts = own(now, a, 'return_destination_parts'); assert.equal(parts.length, 3); assert.equal(new Set(parts.map(x => x.id)).size, 3);
  const intended = (x: Row) => [x.item_id, x.quantity, x.effect, x.status_id, String(x.status_version), Number(x.refund_minor)];
  assert.deepEqual(sorted(parts.map(intended)), sorted(a.intended.parts.map(intended)));
  for (const part of parts) { assert.equal(part.receipt_id, receipt.id); assert.equal(part.preview_id, preview.id); assert.equal(part.session_id, session.id); assert.equal(part.order_id, a.order_id); assert.equal(part.return_id, a.return_id); const planned = one(p.parts.filter((x: Row) => x.part_id === part.id)); assert.deepEqual(part.snapshot, planned); assert.equal(part.status_revision_id, planned.status.revision_id); assert.equal(part.warehouse_id, part.effect === 'none' ? null : part.effect === 'sale' ? a.sale_warehouse_id : a.custody_warehouse_id); }
  // Original UUID, not SKU, controls both accepted and rejected quantities.
  for (const item of own(now, a, 'return_items')) { const rows = parts.filter(x => x.item_id === item.item_id); assert.equal(item.requested, rows.reduce((n, x) => n + x.quantity, 0)); assert.equal(item.accepted, rows.filter(x => x.decision === 'accept').reduce((n, x) => n + x.quantity, 0)); assert.equal(item.restocked, rows.filter(x => x.effect === 'sale').reduce((n, x) => n + x.quantity, 0)); assert.equal(Number(item.refund_amount), rows.reduce((n, x) => n + Number(x.refund_minor), 0)); }
  const rma = one(own(now, a, 'return_cases')); assert.equal(rma.id, a.return_id); assert.equal(rma.state, 'refund_pending'); assert.equal(rma.refund_amount, 2700); assert.equal(rma.refunded_shipping, 0); assert(rma.received_at); assert.equal(rma.receipt_sequence, 1); assert.equal(rma.refunded_at, null); assert.equal(rma.settlement, null); assert.deepEqual(rma.receipt, receipt.payload.receive_input);
  for (const name of ['order_items', 'payment_entries', 'documents', 'reservations', 'reservation_locations', 'wms_reservation_layers', 'wms_cost_layers', 'wms_lots', 'wms_issue_fragments', 'products', 'warehouses', 'product_catalogs', 'product_catalog_warehouses', 'warehouse_inventory_policies', 'return_destination_statuses', 'return_destination_status_revisions']) assert.deepEqual(own(now, a, name), own(before, a, name), 'Original/cash/config facts retained: ' + name);
  const payment = one(own(now, a, 'payment_entries')); assert.equal(payment.kind, 'receipt'); assert.equal(payment.amount, 4401); assert.equal(payment.order_id, a.order_id);
  assert.deepEqual(receipt.payload.snapshot.scanned, session.scanned); assert.equal(new Set(session.scanned.map((x: Row) => x.item_id)).size, session.scanned.length);
  for (const l of receipt.payload.snapshot.lines) { const scanned = session.scanned.find((x: Row) => x.item_id === l.item_id)?.quantity ?? 0; const accepted = parts.filter(x => x.item_id === l.item_id && x.decision === 'accept').reduce((n, x) => n + x.quantity, 0); assert(Number.isInteger(scanned) && scanned >= accepted && scanned <= l.requested); }
  for (const scan of session.scanned) assert(receipt.payload.snapshot.lines.some((x: Row) => x.item_id === scan.item_id));
  const photos = own(now, a, 'return_assistant_photos'); assert(photos.length <= 10);
  assert.equal(receipt.payload.snapshot.photos.length, photos.length);
  for (const photo of photos) { assert.equal(photo.session_id, session.id); assert.equal(photo.return_id, a.return_id); assert(parts.some(x => x.item_id === photo.item_id)); assert(photo.part_id === null || session.draft.parts.some((x: Row) => x.part_id === photo.part_id && x.item_id === photo.item_id)); const frozen = one(receipt.payload.snapshot.photos.filter((x: Row) => x.id === photo.id)); for (const key of ['id', 'item_id', 'part_id', 'mime', 'byte_count', 'sha256', 'width', 'height']) assert.equal(frozen[key], photo[key]); assert.equal(Date.parse(frozen.created_at), Date.parse(photo.created_at)); }
  const arrivals = own(now, a, 'return_destination_arrivals'); assert.equal(arrivals.length, a.components.length * 2);
  for (const part of parts) { const original = one(own(before, a, 'return_items').filter(x => x.item_id === part.item_id)); assert.deepEqual(part.snapshot.components, original.components); const expected = part.effect === 'none' ? [] : original.components; const actual = arrivals.filter(x => x.part_id === part.id); assert.deepEqual(sorted(actual.map(x => [x.product_id, x.quantity])), sorted(expected.map((x: Row) => [x.product_id, x.quantity * part.quantity]))); }
  const inventory = [];
  for (const arrival of arrivals) {
    assert.equal(arrival.receipt_id, receipt.id); assert.equal(arrival.order_id, a.order_id); assert.equal(arrival.return_id, a.return_id); assert(arrival.location.length > 0);
    const old = own(before, a, 'stock').find(x => x.warehouse_id === arrival.warehouse_id && x.product_id === arrival.product_id), stock = one(own(now, a, 'stock').filter(x => x.warehouse_id === arrival.warehouse_id && x.product_id === arrival.product_id)), cell = arrivals.filter(x => x.warehouse_id === arrival.warehouse_id && x.product_id === arrival.product_id);
    assert.equal(stock.on_hand, (old?.on_hand ?? 0) + cell.reduce((n, x) => n + x.quantity, 0)); assert.equal(stock.reserved, old?.reserved ?? 0);
    const bins = own(now, a, 'stock_locations').filter(x => x.warehouse_id === arrival.warehouse_id && x.product_id === arrival.product_id);
    assert.equal(bins.reduce((n, x) => n + x.quantity, 0), stock.on_hand);
    // stock_locations stores physical quantity only. Active reservation rows
    // own the held allocation; consumed/released counters remove issued units.
    const active = own(now, a, 'reservations').filter(x => x.warehouse_id === arrival.warehouse_id && x.product_id === arrival.product_id && x.state === 'active'), holds = own(now, a, 'reservation_locations').filter(x => x.warehouse_id === arrival.warehouse_id && x.product_id === arrival.product_id && active.some(r => r.order_id === x.order_id));
    let heldTotal = 0, binAvailable = 0;
    for (const bin of bins) {
      const held = holds.filter(x => x.location === bin.location).reduce((n, x) => { const remaining = x.quantity - (x.consumed_quantity ?? 0) - (x.released_quantity ?? 0); assert(Number.isSafeInteger(remaining) && remaining >= 0); return n + remaining; }, 0);
      assert(held <= bin.quantity); heldTotal += held; binAvailable += bin.quantity - held;
    }
    assert(holds.every(x => bins.some(bin => bin.location === x.location))); assert.equal(heldTotal, stock.reserved); assert.equal(binAvailable, stock.on_hand - stock.reserved);
    const oldBin = own(before, a, 'stock_locations').find(x => x.warehouse_id === arrival.warehouse_id && x.product_id === arrival.product_id && x.location === arrival.location), bin = one(bins.filter(x => x.location === arrival.location));
    assert.equal(bin.quantity, (oldBin?.quantity ?? 0) + cell.filter(x => x.location === arrival.location).reduce((n, x) => n + x.quantity, 0));
    inventory.push({ product_id: arrival.product_id, warehouse_id: arrival.warehouse_id, effect: arrival.effect, on_hand: stock.on_hand, reserved: stock.reserved, physical_available: stock.on_hand - stock.reserved, sellable_available: arrival.effect === 'sale' ? stock.on_hand - stock.reserved : 0 });
  }
  const moves = own(now, a, 'stock_movements').filter(x => x.return_id === a.return_id); assert.equal(moves.length, arrivals.length); assert.deepEqual(sorted(moves.map(x => [x.product_id, x.warehouse_id, x.delta, x.kind, x.order_id])), sorted(arrivals.map(x => [x.product_id, x.warehouse_id, x.quantity, 'return', a.order_id])));
  const witnessedTables = ['stock_movements', 'stock_location_movements', 'wms_return_fragments', 'wms_layer_movements', 'wms_operations'];
  for (const table of witnessedTables) { const added = own(now, a, table).filter(x => !own(before, a, table).some(old => old.id === x.id)); const actual = admission.witnesses.filter((x: Row) => x.table === table).map((x: Row) => x.row); assert.deepEqual(sorted(actual), sorted(added), 'Actual admission journal covers every new physical effect: ' + table); }
  const physicalFragments = own(now, a, 'return_destination_fragments');
  if (!a.on) { assert.equal(physicalFragments.length, 0); for (const name of ['wms_return_fragments', 'wms_layer_positions', 'wms_layer_movements', 'wms_operations']) assert.deepEqual(own(now, a, name), own(before, a, name)); }
  else {
    assert.equal(physicalFragments.length, arrivals.length); const op = one(own(now, a, 'wms_operations').filter(x => x.return_id === a.return_id)); assert.equal(op.id, receipt.id); assert.equal(op.kind, 'return'); assert.equal(op.request.protocol, 'destinations_v1');
    const returns = own(now, a, 'wms_return_fragments').filter(x => x.return_id === a.return_id); assert.equal(returns.length, physicalFragments.length);
    for (const fragment of physicalFragments) { assert.equal(fragment.receipt_id, receipt.id); const returned = one(returns.filter(x => x.id === fragment.fragment_id)), issue = one(own(before, a, 'wms_issue_fragments').filter(x => x.id === fragment.issue_fragment_id)); assert.equal(returned.operation_id, receipt.id); assert.equal(returned.issue_fragment_id, issue.id); assert.equal(returned.layer_id, issue.layer_id); assert.equal(returned.product_id, issue.product_id); assert.equal(returned.order_id, a.order_id); assert.equal(returned.warehouse_id, fragment.warehouse_id); assert.equal(returned.location, fragment.location); assert.equal(returned.quantity, fragment.quantity); assert.equal(returned.value_minor === null ? null : Number(returned.value_minor), issue.unit_cost_minor === null ? null : Number(issue.unit_cost_minor) * returned.quantity); const layer = one(own(before, a, 'wms_cost_layers').filter(x => x.id === issue.layer_id)); assert.equal(layer.product_id, issue.product_id); assert.equal(layer.unit_cost_minor, issue.unit_cost_minor); const priorReturned = own(before, a, 'wms_return_fragments').filter(x => x.issue_fragment_id === issue.id).reduce((n, x) => n + x.quantity, 0); const nowReturned = own(now, a, 'wms_return_fragments').filter(x => x.issue_fragment_id === issue.id).reduce((n, x) => n + x.quantity, 0); assert(nowReturned >= priorReturned && nowReturned <= issue.quantity); const oldPosition = own(before, a, 'wms_layer_positions').find(x => x.layer_id === fragment.layer_id && x.warehouse_id === fragment.warehouse_id && x.product_id === fragment.product_id && x.location === fragment.location); const position = one(own(now, a, 'wms_layer_positions').filter(x => x.layer_id === fragment.layer_id && x.warehouse_id === fragment.warehouse_id && x.product_id === fragment.product_id && x.location === fragment.location)); const delta = physicalFragments.filter(x => x.layer_id === fragment.layer_id && x.warehouse_id === fragment.warehouse_id && x.product_id === fragment.product_id && x.location === fragment.location).reduce((n, x) => n + x.quantity, 0); assert.equal(position.quantity, (oldPosition?.quantity ?? 0) + delta); assert.equal(position.reserved, oldPosition?.reserved ?? 0); }
    for (const component of a.components) { const returned = returns.filter(x => x.product_id === component.id); assert.equal(returned.reduce((n, x) => n + x.quantity, 0), component.recipe_quantity * 2); if (component.unit_cost_minor === null) assert(returned.every(x => x.value_minor === null)); if (Number(component.unit_cost_minor) === 0 && component.unit_cost_minor !== null) assert(returned.every(x => Number(x.value_minor) === 0)); }
  }
  return { receipt, session, preview, photos, scanned_quantity: session.scanned.reduce((n: number, x: Row) => n + x.quantity, 0), summary: p.summary, inventory, sidecar_counts: { parts: parts.length, arrivals: arrivals.length, fragments: physicalFragments.length, admissions: 1 } };
}
async function apiProof(a: Row, graph: ReturnType<typeof receiptGraph>) {
  const me = await get(a, '/auth/me'); assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin');
  const access = await get(a, '/return-destinations/options'); assert.equal(access.available, true); assert.equal(access.intake_available, true); assert.equal(access.can_read, true); assert.equal(access.can_write, true); assert.equal(access.read_only, false); assert.equal(access.can_read_value, false);
  const operation = await get(a, '/return-destinations/operations/' + graph.receipt.id), preview = await get(a, '/return-destinations/previews/' + graph.preview.id), session = await get(a, '/return-assistant/sessions/' + graph.session.id), rma = await get(a, '/returns/' + a.return_id);
  noPrivate(operation.operation); noPrivate(preview.preview); assert.equal(operation.can_read_value, false); assert.equal(preview.can_read_value, false); assert.equal(operation.operation.id, graph.receipt.id); assert.equal(operation.operation.preview_id, graph.preview.id); assert.equal(operation.operation.session_id, graph.session.id); assert.equal(operation.operation.return_id, a.return_id); assert.equal(operation.operation.order_id, a.order_id); assert.equal(operation.operation.scope_hash, graph.receipt.scope_hash); assert.equal(operation.operation.protocol, 'destinations_v1'); assert.deepEqual(operation.operation.summary, graph.summary); assert.deepEqual(operation.operation.snapshot, preview.preview.snapshot); assert.equal(preview.preview.operation_id, graph.receipt.id); assert.equal(preview.preview.can_receive, false);
  assert.equal(session.session.state, 'completed'); assert.equal(session.session.receipt_id, graph.receipt.id); assert.deepEqual(session.session.scanned, graph.session.scanned); assert.equal(rma.state, 'refund_pending'); assert.equal(rma.refund_amount, 2700); assert.equal(rma.refunded_shipping, 0); assert.equal(rma.refunded_at, null);
  const history = await get(a, `/return-destinations/returns/${a.return_id}/history?session_id=${graph.session.id}&limit=50`); assert.equal(history.next_cursor, null); assert.equal(history.data.length, 1); assert.equal(history.data[0].id, graph.receipt.id); assert.equal(history.data[0].session_id, graph.session.id); assert.deepEqual(history.data[0].summary, graph.summary); noPrivate(history);
  for (const photo of graph.photos) { const content = await get(a, '/return-assistant/photos/' + photo.id + '/content'); assert.equal(content.photo_id, photo.id); assert.equal(content.mime, photo.mime); assert.equal(content.byte_count, photo.byte_count); assert.equal(content.sha256, photo.sha256); const bytes = Buffer.from(content.content_base64, 'base64'); assert.equal(bytes.length, photo.byte_count); assert.equal(sha(bytes), photo.sha256); }
  for (const warehouseId of [a.sale_warehouse_id, a.custody_warehouse_id]) { const inventory = await get(a, `/inventory?warehouse_id=${warehouseId}&limit=50`); assert.equal(inventory.meta.has_more, false); assert.equal(inventory.meta.cursor, null); for (const wanted of graph.inventory.filter(x => x.warehouse_id === warehouseId)) { const row = one(inventory.data.filter((x: Row) => x.product_id === wanted.product_id)); for (const key of ['on_hand', 'reserved', 'physical_available', 'sellable_available']) assert.equal(row[key], wanted[key as keyof typeof wanted]); assert.equal(row.available, wanted.physical_available); assert.equal(row.inventory_usage, wanted.effect); assert.equal(row.inventory_enabled, true); } }
  return { tenant_id: a.tenant_id, user_id: a.user_id, return_id: a.return_id, order_id: a.order_id, receipt_id: graph.receipt.id, session_id: graph.session.id, preview_id: graph.preview.id, operation: operation.operation, session: session.session };
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(await realpath(process.cwd()), ROOT); assert(['before', 'after-off', 'after-on', 'after-restart'].includes(phase ?? '')); assert.equal(process.env.QA162_READBACK_CONFIRM, 'READ_ONLY_OWN_DESTINATIONS_162'); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, configPath); assert.equal(process.env.DYNA_TEST, undefined); assert.equal(process.env.DATABASE_URL, undefined); assert.equal(process.env.DYNA_PREVIEW_PORT, undefined); assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision);
  assert.match(setupRevision, /^[a-f0-9]{40}$/);
  if (setupRevision !== revision) { assert.equal(phase, 'after-restart'); assert.equal(process.env.QA162_SETUP_REVISION, setupRevision); }
  for (const key of ['QA162_CONFIG_SHA256', 'QA162_SETUP_SHA256', 'QA162_ORIGINAL_SETUP_SHA256']) assert.match(process.env[key] ?? '', /^[a-f0-9]{64}$/);
  assert.equal(process.env.QA162_ORIGINAL_SETUP_SHA256, originalSetupSha);
  const privateOutput = resolve(ROOT, `data/return-destinations-native162-readback-${phase}.json`), publicOutput = resolve(ROOT, `docs/return-destinations-native162-readback-${phase}.json`); await fixedDir(resolve(ROOT, 'data')); await fixedDir(resolve(ROOT, 'docs')); await absent(privateOutput); await absent(publicOutput);
  const configBytes = await privateRead(configPath, 65536), setupBytes = await privateRead(setupPath, 16 * 1024 * 1024), originalSetupBytes = await privateRead(originalSetupPath, 16 * 1024 * 1024); assert.equal(sha(configBytes), process.env.QA162_CONFIG_SHA256); assert.equal(sha(setupBytes), process.env.QA162_SETUP_SHA256); assert.equal(sha(originalSetupBytes), originalSetupSha);
  const config = JSON.parse(configBytes.toString('utf8')) as Row, setup = JSON.parse(setupBytes.toString('utf8')) as Row, originalSetup = JSON.parse(originalSetupBytes.toString('utf8')) as Row;
  assert.equal(typeof config.dbPassword, 'string'); assert(config.dbPassword.length > 0);
  assert.equal(originalSetup.stage, 162); assert.equal(originalSetup.schema_revision, schema); assert.equal(originalSetup.runtime_revision, setupRevision); assert.equal(originalSetup.config_sha256, sha(configBytes)); assert.equal(originalSetup.status, 'FAILED_NO_RESUME'); assert.equal(originalSetup.pending, null); assert.equal(originalSetup.complete, false); assert.equal(originalSetup.completed.length, 49); assert.equal(originalSetup.off.complete, true); assert.equal(originalSetup.on.complete, false);
  assert.equal(setup.stage, 162); assert.equal(setup.schema_revision, schema); assert.equal(setup.runtime_revision, setupRevision); assert.equal(setup.config_sha256, sha(configBytes)); assert.equal(setup.status, 'OWN_OFF_ON_SOURCES_READY_FOR_CHROME'); assert.equal(setup.pending, null); assert.equal(setup.complete, true); assert(setup.off.complete && setup.on.complete);
  assert.equal(setup.basis.path, 'data/return-destinations-native162-setup.json'); assert.equal(setup.basis.sha256, originalSetupSha); assert.equal(setup.basis.status, originalSetup.status); assert.equal(setup.basis.acknowledged_operations, 49); assert.equal(setup.basis.original_preserved, true); assert.equal(setup.basis.failure, 'READ_ONLY_UNSUPPORTED_WMS_LIMIT_QUERY');
  assert.deepEqual(setup.completed.slice(0, 49), originalSetup.completed); assert.equal(setup.completed.length, 66); assert.deepEqual(setup.off, originalSetup.off);
  assert.deepEqual(setup.basis.completed_labels, originalSetup.completed.map((x: Row) => [x.actor, x.label]));
  for (const key of ['tenant_id', 'user_id', 'order_id', 'sale_product_id', 'sale_warehouse_id', 'custody_warehouse_id', 'email', 'cookie']) assert.equal(setup.on[key], originalSetup.on[key]);
  const actors: Row[] = [setup.off, setup.on]; assert.equal(setup.off.on, false); assert.equal(setup.on.on, true); assert.equal(new Set(actors.map(a => a.tenant_id)).size, 2);
  for (const a of actors) { for (const key of ['tenant_id', 'user_id', 'return_id', 'order_id', 'sale_warehouse_id', 'custody_warehouse_id']) assert(uuid(a[key])); assert.equal(typeof a.cookie, 'string'); assert(a.cookie && !/[\r\n]/.test(a.cookie)); assert.equal(a.return_id, a.rma_id); assert.equal(a.intended.refund_minor, 2700); }
  let before: Row | null = null, prior: Row | null = null, beforeBytes: Buffer | null = null, priorBytes: Buffer | null = null, priorPath: string | null = null;
  if (phase !== 'before') { assert.match(process.env.QA162_READBACK_BEFORE_SHA256 ?? '', /^[a-f0-9]{64}$/); beforeBytes = await privateRead(beforePath); assert.equal(sha(beforeBytes), process.env.QA162_READBACK_BEFORE_SHA256); before = JSON.parse(beforeBytes.toString('utf8')); assert.equal(before!.status, 'READ_ONLY_BASELINE_CAPTURED'); assert.equal(before!.stage, 162); assert.equal(before!.phase, 'before'); assert.equal(before!.setup_sha256, sha(setupBytes)); assert.equal(before!.original_setup_sha256, originalSetupSha); assert.equal(before!.config_sha256, sha(configBytes)); assert.equal(before!.schema_revision, schema); assert(uuid(process.env.QA162_OFF_RECEIPT_ID)); }
  if (phase === 'after-on' || phase === 'after-restart') { assert(uuid(process.env.QA162_ON_RECEIPT_ID)); assert.match(process.env.QA162_READBACK_PRIOR_SHA256 ?? '', /^[a-f0-9]{64}$/); priorPath = resolve(ROOT, `data/return-destinations-native162-readback-${phase === 'after-on' ? 'after-off' : 'after-on'}.json`); priorBytes = await privateRead(priorPath); assert.equal(sha(priorBytes), process.env.QA162_READBACK_PRIOR_SHA256); prior = JSON.parse(priorBytes.toString('utf8')); assert.equal(prior!.status, 'RETURN_DESTINATIONS_NATIVE_READBACK_PASS'); assert.equal(prior!.stage, 162); assert.equal(prior!.phase, phase === 'after-on' ? 'after-off' : 'after-on'); assert.equal(prior!.schema_revision, schema); assert.equal(prior!.config_sha256, sha(configBytes)); assert.equal(prior!.setup_sha256, sha(setupBytes)); assert.equal(prior!.original_setup_sha256, originalSetupSha); assert.equal(prior!.before_sha256, sha(beforeBytes!)); assert.equal(prior!.actors.off.receipt_id, process.env.QA162_OFF_RECEIPT_ID); if (phase === 'after-restart') assert.equal(prior!.actors.on.receipt_id, process.env.QA162_ON_RECEIPT_ID); }
  await health(); c = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: config.dbPassword, database: 'dynaminds', connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=on -c TimeZone=UTC' }); c.on('error', () => {}); await c.connect(); step = 'native-capture'; const captured = await capture();
  const proof: Record<string, Row | null> = { off: null, on: null }, summary: Row[] = [], sessionProof: Row = {}, priorSessionProof: Row = {};
  if (phase === 'before') { for (const a of actors) { freshBefore(captured, a); const me = await get(a, '/auth/me'); assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin'); } }
  else {
    compareProtected(before!.capture, captured, actors);
    const deltas = process.env.QA162_SESSION_DELTA_JSON ? JSON.parse(process.env.QA162_SESSION_DELTA_JSON) : { off: { added: [], removed: [] }, on: { added: [], removed: [] } }; assert.deepEqual(Object.keys(deltas).sort(), ['off', 'on']);
    for (const a of actors) { const label = a.on ? 'on' : 'off'; step = label + ':receipt'; sessionProof[label] = sessionDelta(before!.capture, captured, a, deltas[label]); if (phase === 'after-off' && a.on) { for (const name of Object.keys(captured.rows)) if (name !== 'sessions') assert.deepEqual(own(captured, a, name), own(before!.capture, a, name), 'Counterpart untouched except exact own auth session lifecycle'); continue; } const graph = receiptGraph(before!.capture, captured, a, process.env[a.on ? 'QA162_ON_RECEIPT_ID' : 'QA162_OFF_RECEIPT_ID']!); compareOwnIntake(before!.capture, captured, a, graph); proof[label] = await apiProof(a, graph); summary.push({ label, tenant_id: a.tenant_id, return_id: a.return_id, receipt_id: graph.receipt.id, wms_enabled: a.on, summary: graph.summary, sidecar_counts: graph.sidecar_counts, scanned_quantity: graph.scanned_quantity, photo_count: graph.photos.length, inventory: graph.inventory, public_cost_redaction: true, cash_ledger_unchanged: true }); }
    if (prior) {
      const incremental = process.env.QA162_PRIOR_SESSION_DELTA_JSON ? JSON.parse(process.env.QA162_PRIOR_SESSION_DELTA_JSON) : { off: { added: [], removed: [] }, on: { added: [], removed: [] } };
      assert.deepEqual(Object.keys(incremental).sort(), ['off', 'on']);
      for (const a of actors) { const label = a.on ? 'on' : 'off'; priorSessionProof[label] = sessionDelta(prior.capture, captured, a, incremental[label]); }
      if (phase === 'after-on') { for (const name of Object.keys(captured.rows)) if (name !== 'sessions') assert.deepEqual(own(captured, setup.off, name), own(prior.capture, setup.off, name), 'Accepted OFF is immutable while ON completes'); }
      else if (phase === 'after-restart') { for (const name of Object.keys(captured.rows)) if (name !== 'sessions') assert.deepEqual(captured.rows[name], prior.capture.rows[name], 'Restart retained all non-session rows exactly'); }
    }
  }
  step = 'final-read-purity'; assert.deepEqual(await capture(), captured, 'Own GET calls must not mutate any native row/session/metadata'); await health(); assert.equal(sha(await privateRead(configPath, 65536)), sha(configBytes)); assert.equal(sha(await privateRead(setupPath, 16 * 1024 * 1024)), sha(setupBytes)); assert.equal(sha(await privateRead(originalSetupPath, 16 * 1024 * 1024)), originalSetupSha); if (beforeBytes) assert.equal(sha(await privateRead(beforePath)), sha(beforeBytes)); if (priorBytes && priorPath) assert.equal(sha(await privateRead(priorPath)), sha(priorBytes));
  const status = phase === 'before' ? 'READ_ONLY_BASELINE_CAPTURED' : 'RETURN_DESTINATIONS_NATIVE_READBACK_PASS';
  const checkpoint = { stage: 162, phase, status, runtime_revision: revision, setup_runtime_revision: setupRevision, schema_revision: schema, setup_sha256: sha(setupBytes), original_setup_sha256: originalSetupSha, config_sha256: sha(configBytes), before_sha256: beforeBytes ? sha(beforeBytes) : null, prior_sha256: priorBytes ? sha(priorBytes) : null, capture: captured, actors: proof, sessions_included: true, own_auth_session_deltas: sessionProof, prior_auth_session_deltas: priorSessionProof, created_at: new Date().toISOString() };
  const checkpointSha = await wx(privateOutput, checkpoint, 0o600);
  const report = { stage: 162, phase, status, runtime_revision: revision, setup_runtime_revision: setupRevision, schema_revision: schema, setup_sha256: sha(setupBytes), original_setup_sha256: originalSetupSha, before_sha256: checkpoint.before_sha256, prior_sha256: checkpoint.prior_sha256, private_checkpoint_sha256: checkpointSha, table_count: Object.keys(captured.rows).length, fingerprints: captured.fingerprints, portable_metadata_sha256: sha(JSON.stringify(captured.portable_metadata)), actors: summary, own_auth_session_deltas: sessionProof, prior_auth_session_deltas: priorSessionProof, sessions_included: true, non_qa162_rows_exact: phase !== 'before', original_migration_baseline_rebased: false, gets, mutations: 0, login_calls: 0, worker_calls: 0, cash_refund_verified: false, chrome_verified_here: false, provider_verified: false, full_goal_complete: false };
  await wx(publicOutput, report, 0o644); console.log(JSON.stringify({ stage: 162, phase, status, gets, mutations: 0 }));
}
main().catch((e: unknown) => { const at = (e instanceof Error ? e.stack ?? '' : '').match(/return-destinations-native162-readback\.ts:(\d+):(\d+)/); console.error(JSON.stringify({ status: 'READBACK_FAILED_NO_REPAIR', step, source_line: at ? Number(at[1]) : null, private_details_withheld: true })); process.exitCode = 1; }).finally(async () => { await c?.end().catch(() => undefined); });
