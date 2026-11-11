/** Root-run, read-only QA155 receipt/queue verification. Never starts a session or retries a write. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

const root = '<workspace>/app';
const phase = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '140_return_assistant_queues';
const setupPath = resolve(root, 'data/return-assistant-queue-stage155.json');
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const one = (rows: any[]) => { assert.equal(rows.length, 1); return rows[0]; };
const fp = (rows: any[]) => ({ count: rows.length, sha256: sha(JSON.stringify(rows.map(row => ({ row })))) });
// Only witness created_at is compared as an instant: JSONB captured in the
// receive transaction retains its timezone. Native rows/fingerprints stay UTC.
// Keep the fractional microseconds separate from Date's whole-second calendar.
function timestampMicros(value: unknown): string {
  assert.equal(typeof value, 'string');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value as string);
  assert(m, 'Witness timestamp must be a finite explicit-offset timestamp');
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  assert(year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  assert.deepEqual([calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), calendar.getUTCHours(), calendar.getUTCMinutes(), calendar.getUTCSeconds()], [year, month, day, hour, minute, second]);
  const offsetHours = Number(m[10] ?? 0), offsetMinutes = Number(m[11] ?? 0);
  assert(offsetHours <= 23 && offsetMinutes <= 59);
  const offset = (m[9] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  return (BigInt(calendar.getTime()) * 1000n + BigInt((m[7] ?? '').padEnd(6, '0')) - BigInt(offset) * 60_000_000n).toString();
}
function witnessComparable(row: Record<string, unknown>): Record<string, unknown> {
  assert(Object.hasOwn(row, 'created_at'));
  return { ...row, created_at: timestampMicros(row.created_at) };
}
let pool: Pool | undefined;
let step = 'preflight';
async function privateRead(path: string) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600);
  return readFile(path);
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Output already exists');
}
async function wx(path: string, value: unknown, mode: number) {
  const f = await open(path, 'wx', mode);
  try { await f.writeFile(JSON.stringify(value, null, 2) + '\n'); await f.sync(); } finally { await f.close(); }
}
async function get(a: any, path: string) {
  assert(path.startsWith('/') && !path.includes('://'));
  const r = await fetch('http://127.0.0.1:4100/api' + path, { headers: a.cookie ? { cookie: a.cookie, 'X-Workspace-ID': a.tenant_id } : {}, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200);
  const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length <= 8 * 1024 * 1024);
  return JSON.parse(bytes.toString('utf8'));
}
async function capture(a: any) {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    assert.deepEqual((await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0], { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY table_name")).rows;
    assert.equal(names.length, 403);
    const rows: Record<string, any[]> = {}, snapshot: Record<string, { count: number; sha256: string }> = {};
    for (const { table_name: name } of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      rows[name] = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=$1 ORDER BY 1`, [name === 'users' ? a.user_id : a.tenant_id])).rows.map(r => r.row);
      snapshot[name] = fp(rows[name]);
    }
    await c.query('COMMIT'); return { rows, snapshot };
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
function setupExact(a: any, snapshot: Record<string, unknown>) {
  assert.equal(Object.keys(a.setup_checkpoint).length, 403);
  assert.deepEqual(snapshot, a.setup_checkpoint);
}
function graph(a: any, rows: Record<string, any[]>, photo: any) {
  const order = one(rows.orders); assert.equal(order.id, a.order_id); assert.equal(a.source_born.order.status, 'shipped'); assert.equal(order.status, a.source_born.order.status); assert.equal(order.total, 4401);
  const first = one(rows.return_cases.filter(r => r.id === a.return_id)), second = one(rows.return_cases.filter(r => r.id === a.next_return_id));
  assert.equal(rows.return_cases.length, 2); assert.equal(first.order_id, order.id); assert.equal(second.order_id, order.id);
  assert.equal(first.state, 'refund_pending'); assert.equal(first.refund_amount, 1000); assert.equal(first.refunded_shipping, 0); assert.equal(first.remedy, 'refund'); assert(first.received_at); assert.equal(first.receipt_sequence, 1); assert.equal(first.refunded_at, null); assert.equal(first.settlement, null);
  assert.equal(second.state, 'requested'); assert.equal(second.version, 1); assert.equal(second.receipt, null); assert.equal(second.received_at, null); assert.equal(second.refund_amount, 0); assert.equal(second.refunded_shipping, 0); assert.equal(second.refunded_at, null);
  assert.deepEqual(fp(rows.return_cases.filter(x => x.id === a.next_return_id)), a.setup_checkpoint_core.next_return_case);
  assert.deepEqual(fp(rows.return_items.filter(x => x.return_id === a.next_return_id)), a.setup_checkpoint_core.next_return_items);
  const ri = one(rows.return_items.filter(r => r.return_id === first.id)), nextItem = one(rows.return_items.filter(r => r.return_id === second.id));
  assert.equal(rows.return_items.length, 2); assert.equal(ri.requested, 1); assert.equal(ri.accepted, 1); assert.equal(ri.restocked, 1); assert.equal(ri.refund_amount, 1000);
  assert.equal(nextItem.requested, 2); assert.equal(nextItem.accepted, 0); assert.equal(nextItem.restocked, 0); assert.equal(nextItem.refund_amount, 0);
  const cheap = one(a.commercial_items.filter((x: any) => x.line_total === 1000)), expensive = one(a.commercial_items.filter((x: any) => x.line_total === 3401));
  assert.equal(ri.item_id, cheap.id); assert.equal(nextItem.item_id, expensive.id);
  const s = one(rows.return_assistant_sessions), p = one(rows.return_assistant_previews), e = one(rows.return_assistant_receipts), ad = one(rows.return_assistant_admissions);
  for (const x of [s, p, e, ad]) { assert.equal(x.tenant_id, a.tenant_id); assert.equal(x.return_id, first.id); assert.equal(x.session_id ?? x.id, s.id); }
  assert.equal(s.order_id, order.id); assert.equal(s.actor_id, a.user_id); assert.equal(s.station_id, a.station_id ?? a.station.id); assert.equal(s.state, 'completed');
  assert.deepEqual(s.scanned, [{ item_id: cheap.id, quantity: 1 }]);
  assert.equal(p.id, e.preview_id); assert.equal(e.id, ad.receipt_id); assert.equal(p.id, ad.preview_id); assert.equal(e.order_id, order.id); assert.equal(e.actor_id, a.user_id); assert.equal(e.api_key_id, null); assert.equal(e.scope_hash, p.scope_hash); assert.equal(e.payload.action, 'receive');
  assert.deepEqual([e.payload.summary.requested, e.payload.summary.scanned, e.payload.summary.accepted, e.payload.summary.restocked, e.payload.summary.held, e.payload.summary.rejected, e.payload.summary.refund_minor, e.payload.summary.shipping_refund], [1, 1, 1, 1, 0, 0, 1000, 0]);
  assert.deepEqual(e.result.receipt, first.receipt); assert.equal(e.payload.snapshot.lines.length, 1); assert.equal(e.payload.snapshot.lines[0].item_id, cheap.id);
  assert(rows.return_assistant_operations.every(x => x.session_id === s.id));
  assert.equal(rows.return_assistant_photos.length, photo ? 1 : 0); assert.equal(e.payload.summary.photo_count, photo ? 1 : 0); assert.equal(e.payload.snapshot.photos.length, photo ? 1 : 0);
  if (photo) { const ph = one(rows.return_assistant_photos); assert.equal(ph.session_id, s.id); assert.equal(ph.return_id, first.id); assert.equal(ph.item_id, cheap.id); assert.equal(ph.sha256, photo.sha256); assert.equal(ph.mime, photo.mime); assert.equal(ph.byte_count, photo.byte_count); assert(ph.content_encrypted); assert.equal(e.payload.snapshot.photos[0].sha256, photo.sha256); }
  const q = one(rows.return_assistant_queues), settings = one(rows.return_assistant_settings);
  assert.equal(q.owner_id, a.user_id); assert.equal(q.tenant_id, a.tenant_id); assert.equal(q.item_count, 2); assert.equal(q.position, 1); assert.equal(q.version, 2); assert.deepEqual(q.navigation, { auto_next: true, hide_accepted: true }); assert.deepEqual(q.skipped_return_ids, []);
  assert.equal(rows.return_assistant_queue_items.length, 2);
  const qi = [...rows.return_assistant_queue_items].sort((x, y) => x.index - y.index);
  assert.deepEqual(qi.map(x => [x.index, x.return_id, x.queue_id, x.owner_id]), [[0, first.id, q.id, a.user_id], [1, second.id, q.id, a.user_id]]);
  assert.equal(settings.owner_id, a.user_id); assert.equal(settings.version, 1);
  const v = settings.settings_values; assert.equal(v.auto_next, true); assert.equal(v.hide_accepted, true); assert.equal(v.name_source, 'current'); assert.equal(v.product_sort, 'sku'); assert.equal(v.thumbnail_size, 'small');
  assert.deepEqual([...v.case_fields].sort(), ['created_at', 'kind', 'number', 'order_number']);
  assert.deepEqual([...v.product_fields].sort(), ['ean', 'line_total', 'locations', 'name', 'quantity', 'sku', 'stock']);
  assert.equal(rows.return_assistant_queue_operations.length, 3); assert.equal(rows.return_assistant_queue_admissions.length, 3);
  assert.deepEqual(rows.return_assistant_queue_operations.map(x => x.kind).sort(), ['create', 'settings', 'update']);
  const create = one(rows.return_assistant_queue_operations.filter(x => x.kind === 'create')), update = one(rows.return_assistant_queue_operations.filter(x => x.kind === 'update'));
  assert.deepEqual(create.request.return_ids, a.return_ids); assert.deepEqual(a.return_ids, [first.id, second.id]); assert.equal(update.request.version, '1'); assert.equal(update.request.position, 1);
  for (const x of rows.return_assistant_queue_operations) { assert.equal(x.owner_id, a.user_id); assert.equal(x.api_key_id, null); assert.equal(x.client_key, x.request.client_key); assert.equal(rows.return_assistant_queue_admissions.filter(admission => admission.operation_id === x.id).length, 1); }
  assert.equal(rows.payment_entries.length, 1); const payment = one(rows.payment_entries); assert.equal(payment.order_id, order.id); assert.equal(payment.kind, 'receipt'); assert.equal(payment.amount, 4401); assert.equal(rows.documents.length, 0);
  const stock = a.components.map((component: any) => {
    const st = one(rows.stock.filter(x => x.product_id === component.id && x.warehouse_id === a.warehouse_id));
    assert.equal(st.on_hand, component.initial_quantity - 2 * component.recipe_quantity); assert.equal(st.reserved, 0);
    const movement = one(rows.stock_movements.filter(x => x.return_id === first.id && x.product_id === component.id)); assert.equal(movement.delta, component.recipe_quantity); assert.equal(movement.kind, 'return'); assert.equal(movement.order_id, order.id); assert.equal(movement.warehouse_id, a.warehouse_id);
    assert.equal(rows.stock_movements.filter(x => x.return_id === second.id).length, 0);
    const bins = rows.stock_locations.filter(x => x.product_id === component.id && x.warehouse_id === a.warehouse_id);
    assert.equal(bins.reduce((n, x) => n + x.quantity, 0), st.on_hand);
    assert.equal(one(bins.filter(x => x.location === 'QA155-01')).quantity, component.initial_quantity - (a.on ? 2 : 3) * component.recipe_quantity);
    if (!a.on) assert.equal(one(bins.filter(x => x.location === 'ZWROT')).quantity, component.recipe_quantity);
    return { product_id: component.id, on_hand: st.on_hand, reserved: st.reserved };
  });
  assert.equal(rows.stock_movements.filter(x => x.return_id === first.id).length, a.components.length);
  assert.deepEqual(fp(rows.stock_movements.filter(x => x.return_id !== first.id)), a.setup_checkpoint.stock_movements);
  const witnesses = ad.witnesses as { table: string; row: any }[]; assert(Array.isArray(witnesses));
  for (const witness of witnesses) { assert(['stock_movements', 'stock_location_movements', 'wms_operations', 'wms_layer_movements', 'wms_return_fragments'].includes(witness.table)); assert.deepEqual(witnessComparable(one(rows[witness.table].filter(x => x.id === witness.row.id))), witnessComparable(witness.row)); }
  const binWitnesses = witnesses.filter(x => x.table === 'stock_location_movements'); assert.equal(binWitnesses.length, a.components.length);
  for (const component of a.components) { const movement = one(binWitnesses.filter(x => x.row.product_id === component.id)).row; assert.equal(movement.kind, 'stock_in'); assert.equal(movement.delta, component.recipe_quantity); assert.equal(movement.location, a.on ? 'QA155-01' : 'ZWROT'); assert.equal(movement.warehouse_id, a.warehouse_id); }
  assert.deepEqual(fp(rows.stock_location_movements.filter(x => !binWitnesses.some(w => w.row.id === x.id))), a.setup_checkpoint.stock_location_movements);
  const fragments = rows.wms_return_fragments; assert.equal(fragments.length, a.on ? 2 : 0); let knownValue = 0;
  if (a.on) for (const f of fragments) {
    const original = one(rows.wms_issue_fragments.filter(x => x.id === f.issue_fragment_id)), component = one(a.components.filter((x: any) => x.id === f.product_id));
    assert.equal(f.return_id, first.id); assert.equal(f.product_id, original.product_id); assert.equal(f.layer_id, original.layer_id); assert.equal(f.quantity, component.recipe_quantity); assert.equal(String(original.unit_cost_minor), String(component.unit_cost_minor)); assert.equal(BigInt(f.value_minor), BigInt(component.unit_cost_minor) * BigInt(f.quantity)); knownValue += Number(f.value_minor);
  }
  if (a.on) assert.equal(knownValue, 2000);
  const returnOps = rows.wms_operations.filter(x => x.return_id === first.id); assert.equal(returnOps.length, a.on ? 1 : 0); assert.equal(rows.wms_operations.filter(x => x.return_id === second.id).length, 0);
  assert.deepEqual(fp(rows.wms_operations.filter(x => x.return_id !== first.id)), a.setup_checkpoint.wms_operations);
  if (a.on) { assert.equal(returnOps[0].kind, 'return'); assert.equal(returnOps[0].order_id, order.id); assert.equal(rows.wms_layer_movements.filter(x => x.operation_id === returnOps[0].id).length, 2); }
  assert.deepEqual(fp(rows.wms_layer_movements.filter(x => !returnOps.some(op => op.id === x.operation_id))), a.setup_checkpoint.wms_layer_movements);
  // Preserve core sale/payment/issue/purchase evidence exactly against the actual setup, not against a rebased baseline.
  for (const name of ['users', 'tenants', 'products', 'order_items', 'payment_entries', 'documents', 'shipments', 'order_picks', 'reservations', 'reservation_locations', 'wms_issue_fragments', 'wms_cost_layers']) if (a.setup_checkpoint[name]) assert.deepEqual(fp(rows[name]), a.setup_checkpoint[name], 'Original evidence changed');
  return { state: first.state, queue_id: q.id, queue_version: '2', position: 1, first_return_id: first.id, next_return_id: second.id, next_state: 'requested', next_assistant_rows: 0, receipt_id: e.id, preview_id: p.id, session_id: s.id, accepted: 1, restocked: 1, held: 0, rejected: 0, refund_minor: 1000, payment_minor: 4401, cash_paid_out: 0, photo_sha256: photo?.sha256 ?? null, stock, ...(a.on ? { known_value_minor: knownValue, restored_known_value_minor: knownValue } : {}) };
}
async function main() {
  assert(['after-off', 'after-on', 'after-restart'].includes(phase)); assert.equal(resolve(process.cwd()), root); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json')); assert.notEqual(process.env.DYNA_TEST, 'true'); assert.match(revision, /^[a-f0-9]{40}$/);
  const configBytes = await privateRead(resolve(root, '.local.json')), setupBytes = await privateRead(setupPath), setup = JSON.parse(setupBytes.toString());
  assert.equal(setup.stage, 155); assert.equal(setup.complete, true); assert.equal(setup.pending, null);
  const actors = [setup.off, setup.on]; assert(actors.every(a => a?.tenant_id && a.user_id && a.cookie)); assert.equal(actors[0].on, false); assert.equal(actors[1].on, true); assert.equal(actors[0].label, 'OFF'); assert.equal(actors[1].label, 'ON'); assert.notEqual(actors[0].tenant_id, actors[1].tenant_id);
  assert.equal(setup.schema_revision, schema); for (const a of actors) { assert.equal(a.complete, true); assert.deepEqual(a.return_ids, [a.return_id, a.next_return_id]); assert.equal(a.source_born.return_case.id, a.return_id); assert.equal(a.source_born.next_return_case.id, a.next_return_id); assert.equal(a.source_born.next_return_case.state, 'requested'); }
  assert.equal(setup.photo.path, resolve(root, 'data/return-assistant-queue-stage155-photo.png')); const photoBytes = await privateRead(setup.photo.path); assert.equal(sha(photoBytes), setup.photo.sha256); assert.equal(photoBytes.length, setup.photo.byte_count);
  const h = await get({}, '/health'); assert.equal(h.status, 'ok'); assert.equal(h.revision, revision); assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local'); assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false); assert.equal(h.return_assistant_available, true); assert.equal(h.return_assistant_queues_available, true);
  assert.equal(process.env.QA155_CHROME_VERIFIED, 'true'); if (phase === 'after-restart') assert.equal(process.env.QA155_RESTART_VERIFIED, 'true');
  const checkpointPath = resolve(root, `data/return-assistant-queue-checkpoint155-${phase}.json`), reportPath = resolve(root, `docs/return-assistant-queue-native155-${phase}.json`); await absent(checkpointPath); await absent(reportPath);
  const priorPhase = phase === 'after-restart' ? 'after-on' : phase === 'after-on' ? 'after-off' : null;
  const prior = priorPhase ? JSON.parse((await privateRead(resolve(root, `data/return-assistant-queue-checkpoint155-${priorPhase}.json`))).toString()) : null;
  if (prior) { assert.equal(prior.stage, 155); assert.equal(prior.status, 'PASS'); assert.equal(prior.phase, priorPhase); assert.equal(prior.setup_file_sha256, sha(setupBytes)); }
  pool = (await import('../server/db')).pool;
  const db = new URL(pool.options.connectionString!); assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '55432'); assert.equal(db.pathname, '/dynaminds');
  const firms = [];
  for (const a of actors) {
    step = a.label + ':native'; const captured = await capture(a); let evidence: any = null;
    if (phase === 'after-off' && a.on) setupExact(a, captured.snapshot);
    else {
      evidence = graph(a, captured.rows, setup.photo);
      step = a.label + ':get'; const me = await get(a, '/auth/me'); assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin');
      const settings = await get(a, '/return-assistant/settings'); assert.equal(settings.available, true); assert.equal(settings.current_role, 'admin'); assert.equal(settings.read_only, false); assert.equal(settings.can_write, true); assert.equal(settings.settings.version, '1'); assert.deepEqual(settings.settings.values, one(captured.rows.return_assistant_settings).settings_values);
      const queue = await get(a, '/return-assistant/queues/' + evidence.queue_id); assert.equal(queue.queue.version, '2'); assert.equal(queue.queue.position, 1); assert.equal(queue.queue.count, 2); assert.deepEqual(queue.queue.navigation, { auto_next: true, hide_accepted: true });
      const items = await get(a, '/return-assistant/queues/' + evidence.queue_id + '/items?limit=50'); assert.equal(items.next_cursor, null); assert.deepEqual(items.data.map((r: any) => [r.index, r.return_id, r.accepted, r.receipt_id]), [[0, a.return_id, true, evidence.receipt_id], [1, a.next_return_id, false, null]]); assert.equal(items.data[1].current_session, null);
      const first = await get(a, '/returns/' + a.return_id), second = await get(a, '/returns/' + a.next_return_id); assert.equal(first.state, 'refund_pending'); assert.equal(first.refund_amount, 1000); assert.equal(second.state, 'requested'); assert.equal(second.version, '1'); assert.equal(second.receipt, null); assert(second.items.every((r: any) => r.accepted === 0 && r.restocked === 0 && r.refund_amount === 0));
      const receipt = await get(a, '/return-assistant/receipts/' + evidence.receipt_id); assert.equal(receipt.receipt.id, evidence.receipt_id); assert.equal(receipt.session.state, 'completed'); assert.equal(receipt.receipt.can_read_value, false); assert.equal(receipt.return_case.id, a.return_id);
      const presented = one(receipt.session.presentation.lines); assert.equal(presented.item_id, a.cheap_item_id); assert.equal(presented.historical_name, one(a.commercial_items.filter((x: any) => x.id === a.cheap_item_id)).name); assert.equal(presented.line_total, 1000); assert.equal(presented.current_catalog.name, a.current_catalog.name); assert.equal(presented.current_catalog.ean, a.current_catalog.ean); assert.equal(presented.current_catalog.image_url, a.catalog_image.url); assert(presented.locations.length > 0); assert(presented.stock.length > 0);
      if (setup.photo) { const ph = one(captured.rows.return_assistant_photos), photo = await get(a, '/return-assistant/photos/' + ph.id + '/content'); assert.equal(photo.sha256, setup.photo.sha256); assert.equal(sha(Buffer.from(photo.content_base64, 'base64')), setup.photo.sha256); }
      if (a.on) { const valuation = await get(a, '/wms-lots/valuation?warehouse_id=' + a.warehouse_id); assert.equal(valuation.valuation.unknown_quantity, '0'); assert.equal(valuation.valuation.known_minor, '6000'); }
    }
    if (prior && (phase === 'after-restart' || !a.on)) { const old = one(prior.firms.filter((f: any) => f.tenant_id === a.tenant_id)); assert.deepEqual(captured.rows, old.rows); assert.deepEqual(captured.snapshot, old.snapshot); assert.deepEqual(evidence, old.evidence); }
    // Repeat the full read-only native snapshot after API hydration: GET must have no business effects.
    const afterGet = await capture(a); assert.deepEqual(afterGet, captured);
    firms.push({ tenant_id: a.tenant_id, user_id: a.user_id, order_id: a.order_id, rma_id: a.return_id, return_id: a.return_id, next_return_id: a.next_return_id, on: a.on, ...captured, evidence });
  }
  assert.equal(sha(await privateRead(setupPath)), sha(setupBytes)); assert.equal(sha(await privateRead(resolve(root, '.local.json'))), sha(configBytes));
  assert.equal(sha(await privateRead(setup.photo.path)), sha(photoBytes));
  const checkpoint = { stage: 155, status: 'PASS', phase, revision, schema_revision: schema, setup_file_sha256: sha(setupBytes), firms };
  await wx(checkpointPath, checkpoint, 0o600);
  const report = { stage: 155, status: 'NATIVE_QUEUE_READBACK_PASS', phase, revision, schema_revision: schema, checkpoint_sha256: sha(JSON.stringify(checkpoint, null, 2) + '\n'), setup_file_sha256: sha(setupBytes), own_tables: firms.map(f => Object.keys(f.snapshot).length), firms: firms.map(f => ({ tenant_id: f.tenant_id, on: f.on, snapshot_sha256: sha(JSON.stringify(f.snapshot)), evidence: f.evidence })), api_get_business_effects: 0, sessions_excluded: true, baseline_rebased: false, restart_exact: phase === 'after-restart', chrome_attested: true, provider_verified: false, lost_ack_proven: false, full_goal_complete: false };
  await wx(reportPath, report, 0o644); process.stdout.write(JSON.stringify({ status: report.status, stage: 155, phase, own_tables: report.own_tables, full_goal_complete: false }) + '\n');
}
main().catch(() => { process.stderr.write(JSON.stringify({ status: 'FAIL', stage: 155, phase, step }) + '\n'); process.exitCode = 1; }).finally(() => pool?.end());
