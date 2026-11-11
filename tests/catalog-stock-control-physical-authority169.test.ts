import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import {
  bootstrap151169, install152169, fixture169, facts169, physical169, physicalExact169,
  own169, raw169, consent169, wait169, type Facts, type Fixture169, type Row,
} from './catalog-stock-control169-fixture';

// Authored only. Root runs this in its numeric disposable PostgreSQL database.
// The internal BO gate is genuine preview + separate consent + commit. Its
// explicit local context is not a claim that public writers_available is true.
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => { throw new Error('No provider in physical authority169'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };
const ids = (rows: Row[]) => rows.map(r => r.id).sort();
function added(before: Facts, after: Facts, table: string): Row[] {
  const old = new Set(raw169(before, table).map(r => String(r.id)));
  assert.deepEqual(after[table].filter(x => old.has(String(x.row.id))), before[table], 'All existing journal rows retained: ' + table);
  return raw169(after, table).filter(r => !old.has(String(r.id)));
}
function otherTenantsExact(before: Facts, after: Facts, f: Fixture169) {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const table of Object.keys(before)) assert.deepEqual(
    after[table].filter(x => x.row.tenant_id !== f.tenant),
    before[table].filter(x => x.row.tenant_id !== f.tenant),
    'Every other/global row including all auth sessions retained: ' + table,
  );
}
function wmsExact(before: Facts, after: Facts) {
  for (const table of physical169.filter(t => t.startsWith('wms_')))
    assert.deepEqual(after[table], before[table], 'OFF creates no WMS operation/layer/cost witness: ' + table);
}
async function activate(f: Fixture169) {
  const publicly = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicly.writers_available, false); assert.equal(publicly.activation_available, false);
  const before = await facts169(), context = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, context);
  assert.equal(source.ready, true); assert.deepEqual(source.blockers, []);
  const { preview } = await previewCatalogStockControl(f.actor, f.primary.id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version,
    policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.series.version })),
  }, context);
  assert.equal(preview.ready, true); assert.equal(preview.can_commit, true);
  const result = await commitCatalogStockControl(f.actor, preview.id, consent169(preview), context);
  assert.equal(result.reused, false); assert.equal(result.operation.after.strict, true);
  physicalExact169(before, await facts169());
}
async function key(f: Fixture169, scopes: string[]) {
  const k = await f.ok('/developer/keys', 'POST', { name: 'Own existing physical authority169', scopes }, 201);
  const saved = one((await pool.query('SELECT scopes FROM public.api_keys WHERE tenant_id=$1 AND id=$2', [f.tenant, k.id])).rows);
  assert.deepEqual([...saved.scopes].sort(), [...scopes].sort(), 'No extra scope silently added to the key');
  return k;
}
async function purchase(f: Fixture169) {
  const supplier = await f.ok('/suppliers', 'POST', { name: 'Own strict PO169', code: 'AUTH169-' + randomUUID() }, 201);
  const draft = await f.ok('/purchase-orders', 'POST', {
    supplier_id: supplier.id, warehouse_id: f.warehouse.id,
    lines: [{ product_id: f.products[0].id, quantity: 3, unit_cost: 1000 }],
  }, 201);
  const order = await f.ok('/purchase-orders/' + draft.id + '/place', 'POST', { version: draft.version });
  assert.equal(order.state, 'ordered');
  return { order, path: '/purchase-orders/' + order.id + '/receive', body: {
    version: order.version, client_key: randomUUID(), reference: 'Genuine PO authority169', note: '',
    lines: [{ product_id: f.products[0].id, quantity: 2, location: 'A-01' }],
  } };
}
async function move(f: Fixture169) {
  const bins = await f.ok('/stock-locations?warehouse_id=' + f.warehouse.id + '&product_id=' + f.products[0].id);
  assert.equal(bins.meta.cursor, null);
  const bin = one(bins.data); assert.equal(bin.location, 'A-01'); assert.equal(bin.quantity, 5);
  return { path: '/stock-location-moves', body: {
    client_key: randomUUID(), expected_version: String(bin.version), warehouse_id: f.warehouse.id,
    product_id: f.products[0].id, location: bin.location, destination: 'AUTH-169', quantity: 2, note: 'Genuine strict local relocation169',
  } };
}
function effectGraph(before: Facts, after: Facts, f: Fixture169, sourceKind: string, sourceId: string, keyId: string) {
  const admission = one(added(before, after, 'catalog_stock_control_effect_admissions'));
  assert.equal(admission.tenant_id, f.tenant); assert.equal(admission.actor_id, f.user);
  assert.equal(admission.api_key_id, keyId); assert.equal(admission.source_kind, sourceKind);
  assert.equal(admission.source_id, sourceId); assert.equal(admission.sealed, true);
  assert.deepEqual(admission.request.product_ids, [f.products[0].id]);
  assert.deepEqual(admission.request.warehouse_ids, [f.warehouse.id]);
  const effect = one(own169(after, 'catalog_stock_control_effects', f.tenant).filter(e => e.admission_id === admission.id));
  const stock = added(before, after, 'stock_movements'), bins = added(before, after, 'stock_location_movements');
  assert.deepEqual([...effect.proof.stock_movement_ids].sort(), ids(stock));
  assert.deepEqual([...effect.proof.location_movement_ids].sort(), ids(bins));
  assert.deepEqual(effect.proof.layer_movement_ids, []); assert.equal(effect.operation_id, null);
  const links = own169(after, 'catalog_stock_control_effect_journals', f.tenant).filter(j => j.admission_id === admission.id);
  assert.equal(links.length, stock.length + bins.length);
  for (const j of links) {
    assert.equal(j.layer_movement_id, null);
    if (j.kind === 'stock') { assert(stock.some(m => m.id === j.journal_id)); assert.equal(j.stock_movement_id, j.journal_id); assert.equal(j.location_movement_id, null); }
    else { assert.equal(j.kind, 'bin'); assert(bins.some(m => m.id === j.journal_id)); assert.equal(j.location_movement_id, j.journal_id); assert.equal(j.stock_movement_id, null); }
  }
  otherTenantsExact(before, after, f); wmsExact(before, after);
  return { admission, effect, stock, bins };
}

test('strict OFF PO receipt accepts purchasing:write-only; one real numbered PZ/journal graph and exact replay without new counters', async () => {
  const f = await fixture169(app); await activate(f);
  const po = await purchase(f), k = await key(f, ['purchasing:write']), before = await facts169();
  const result = await f.ok(po.path, 'POST', po.body, 200, k);
  assert.equal(result.replayed, false); assert.equal(result.order.id, po.order.id); assert.equal(result.order.state, 'partial');
  const after = await facts169(), receipt = one(added(before, after, 'purchase_receipts'));
  assert.equal(receipt.id, result.receipt_id); assert.equal(receipt.order_id, po.order.id); assert.equal(receipt.client_key, po.body.client_key);
  const document = one(added(before, after, 'warehouse_documents'));
  assert.equal(receipt.document_id, document.id); assert.equal(document.status, 'posted'); assert.equal(document.kind, 'receipt');
  assert.equal(document.warehouse_id, f.warehouse.id);
  const lines = own169(after, 'warehouse_document_lines', f.tenant).filter(l => l.document_id === document.id);
  assert.equal(lines.length, 1); assert.equal(lines[0].product_id, f.products[0].id); assert.equal(lines[0].quantity, 2); assert.equal(lines[0].location, 'A-01');
  const g = effectGraph(before, after, f, 'purchase_receipt', receipt.id, k.id);
  assert.equal(g.effect.purchase_receipt_id, receipt.id); assert.equal(g.effect.warehouse_document_id, document.id); assert.equal(g.effect.location_operation_id, null);
  assert.equal(g.stock.length, 1); assert.equal(g.stock[0].delta, 2); assert.equal(g.stock[0].warehouse_document_id, document.id);
  assert.equal(g.bins.length, 1); assert.equal(g.bins[0].delta, 2); assert.equal(g.bins[0].location, 'A-01');
  const beforeStock = one(own169(before, 'stock', f.tenant).filter(s => s.product_id === f.products[0].id));
  const afterStock = one(own169(after, 'stock', f.tenant).filter(s => s.product_id === f.products[0].id));
  assert.equal(afterStock.on_hand, beforeStock.on_hand + 2); assert.equal(afterStock.available, beforeStock.available + 2);
  assert.equal(afterStock.reserved, beforeStock.reserved); assert.equal(BigInt(afterStock.version), BigInt(beforeStock.version) + 1n);
  assert.deepEqual(after.stock.filter(x => x.row.product_id !== f.products[0].id), before.stock.filter(x => x.row.product_id !== f.products[0].id));
  const bin = one(own169(after, 'stock_locations', f.tenant).filter(s => s.product_id === f.products[0].id)); assert.equal(bin.quantity, 7);
  const number = g.admission.number, series = one(own169(after, 'catalog_stock_control_series', f.tenant).filter(s => s.id === number.series_id));
  assert.equal(series.kind, 'PZ'); assert.equal(series.warehouse_id, f.warehouse.id); assert.equal(number.kind, 'PZ'); assert.equal(number.sequence, '1');
  assert.equal(document.number, `${series.prefix}/${number.year}/${number.sequence.padStart(6, '0')}`);
  const counter = one(own169(after, 'catalog_stock_control_counters', f.tenant).filter(c => c.series_id === series.id && c.year === number.year)); assert.equal(String(counter.value), number.sequence);
  const replay = await f.ok(po.path, 'POST', po.body, 200, k);
  assert.equal(replay.replayed, true); assert.equal(replay.receipt_id, receipt.id); assert.deepEqual(replay.order, result.order);
  assert.deepEqual(await facts169(), after, 'Replay adds no PZ, strict admission, movement, marker, counter, audit, session or second writer');
  const changed = await f.request(po.path, 'POST', { ...po.body, lines: [{ ...po.body.lines[0], quantity: 1 }] }, k);
  assert.equal(changed.statusCode, 409, changed.body); assert.deepEqual(await facts169(), after);
});

test('strict OFF bin move accepts inventory:write-only; exact two signed local journals with dedicated source FK and no WMS/aggregate journal', async () => {
  const f = await fixture169(app); await activate(f);
  const m = await move(f), k = await key(f, ['inventory:write']), before = await facts169();
  const result = await f.ok(m.path, 'POST', m.body, 200, k);
  assert.equal(result.kind, 'move');
  const after = await facts169(), operation = one(added(before, after, 'stock_location_operations'));
  assert.equal(operation.id, result.id); assert.equal(operation.idempotency_key, m.body.client_key); assert.equal(operation.result.kind, 'move');
  const g = effectGraph(before, after, f, 'location_operation', operation.id, k.id);
  assert.equal(g.effect.location_operation_id, operation.id); assert.equal(g.effect.proof.location_operation_id, operation.id);
  assert.equal(g.effect.warehouse_document_id, null); assert.equal(g.effect.purchase_receipt_id, null); assert.equal(g.admission.number, null);
  assert.equal(g.stock.length, 0); assert.equal(g.bins.length, 2);
  assert.deepEqual(g.bins.map(b => [b.location, b.delta]).sort(), [['A-01', -2], ['AUTH-169', 2]]);
  assert(g.bins.every(b => b.operation_id === operation.id && b.kind === 'move' && b.product_id === f.products[0].id && b.warehouse_id === f.warehouse.id));
  const oldStock = one(own169(before, 'stock', f.tenant).filter(s => s.product_id === f.products[0].id));
  const stock = one(own169(after, 'stock', f.tenant).filter(s => s.product_id === f.products[0].id));
  assert.equal(stock.on_hand, oldStock.on_hand); assert.equal(stock.reserved, oldStock.reserved); assert.equal(stock.available, oldStock.available);
  assert.equal(BigInt(stock.version), BigInt(oldStock.version) + 1n);
  assert.deepEqual(own169(after, 'stock_locations', f.tenant).filter(s => s.product_id === f.products[0].id).map(s => [s.location, s.quantity]).sort(), [['A-01', 3], ['AUTH-169', 2]]);
  for (const t of ['warehouse_documents', 'warehouse_document_lines', 'catalog_stock_control_counters', 'catalog_stock_control_series']) assert.deepEqual(after[t], before[t], 'Relocation is not a fabricated numbered receipt: ' + t);
  const replay = await f.ok(m.path, 'POST', m.body, 200, k); assert.equal(replay.reused, true); assert.equal(replay.id, operation.id);
  assert.deepEqual(await facts169(), after, 'Exact relocation replay has no second effect/bin movement or stock version bump');
  const changed = await f.request(m.path, 'POST', { ...m.body, quantity: 1 }, k);
  assert.equal(changed.statusCode, 409, changed.body); assert.deepEqual(await facts169(), after);
});

for (const source of ['purchase', 'move'] as const) test(`strict OFF ${source} refuses the other source's write-only key with full global row/session purity`, async () => {
  const f = await fixture169(app); await activate(f);
  const request = source === 'purchase' ? await purchase(f) : await move(f);
  const k = await key(f, [source === 'purchase' ? 'inventory:write' : 'purchasing:write']), before = await facts169();
  const result = await f.request(request.path, 'POST', request.body, k);
  assert.equal(result.statusCode, 403, result.body); assert.deepEqual(await facts169(), before);
});

test('strict OFF PO source wait followed by admin→operator withdrawal rolls back the whole actual receipt/PZ/number graph', async () => {
  const f = await fixture169(app); await activate(f);
  const po = await purchase(f), k = await key(f, ['purchasing:write']), before = await facts169();
  const blocker = await pool.connect(), authority = await pool.connect();
  let pending: ReturnType<Fixture169['request']> | undefined;
  const ownKey = (x: { row: Row }) => x.row.id === k.id;
  const originalKey = one(before.api_keys.filter(ownKey).map(x => x.row));
  assert.equal(originalKey.revoked_at, null);
  assert.deepEqual(raw169(before, 'api_keys').filter(x => x.tenant_id === f.tenant && x.user_id === f.user).map(x => x.id), [k.id]);
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM public.purchase_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, po.order.id]);
    const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = f.request(po.path, 'POST', po.body, k);
    const waiter = await wait169(pid, /SELECT \* FROM purchase_orders WHERE id=\$1 FOR UPDATE/i);
    assert.notEqual(waiter, pid, 'Real HTTP writer is waiting on the actual purchase source row');
    // Commit the independent IAM change while the PO lock is still held.013
    // genuinely revokes this user's key; capture that exact committed baseline
    // before allowing the request to resume rather than ignoring auth rows.
    await authority.query("UPDATE public.memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    const withdrawn = await facts169(), ownMember = (x: { row: Row }) => x.row.tenant_id === f.tenant && x.row.user_id === f.user;
    assert.deepEqual(withdrawn.memberships.filter(x => !ownMember(x)), before.memberships.filter(x => !ownMember(x)));
    assert.deepEqual(one(withdrawn.memberships.filter(ownMember).map(x => x.row)), { ...one(before.memberships.filter(ownMember).map(x => x.row)), role: 'operator' });
    assert.deepEqual(withdrawn.api_keys.filter(x => !ownKey(x)), before.api_keys.filter(x => !ownKey(x)));
    const revoked = one(withdrawn.api_keys.filter(ownKey).map(x => x.row));
    assert.equal(typeof revoked.revoked_at, 'string'); assert(revoked.revoked_at.length > 0);
    assert.deepEqual(revoked, { ...originalKey, revoked_at: revoked.revoked_at });
    assert.deepEqual(withdrawn, { ...before, memberships: withdrawn.memberships, api_keys: withdrawn.api_keys },
      'Only the literal committed role change and013 revocation of the expected own key occurred while the PO was blocked');
    await blocker.query('COMMIT');
    const response = await pending; assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(await facts169(), withdrawn, 'Denied PO creates no receipt/document/counter/stock/journal/certificate/audit/session effect after the exact committed IAM baseline');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
    if (pending) await pending.catch(() => {});
    await authority.query("UPDATE public.memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    await authority.query('UPDATE public.api_keys SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2 AND user_id=$3', [f.tenant, k.id, f.user]);
    authority.release();
  }
  assert.deepEqual(await facts169(), before, 'Exact role repair retains every original business/auth row');
});
